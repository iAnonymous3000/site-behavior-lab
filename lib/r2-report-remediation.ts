import { publicReportDigest } from "./canonical-json";
import { readManagedReport, type ManagedReportClock } from "./managed-report-reader";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildProvenanceEntry } from "./redaction-provenance";
import { REPORT_ID_PATTERN } from "./report-validation";
import { readStoredScanReport } from "./scan-report-reader";
import type { ScanReport } from "./types";

const REPORT_KEY = /^reports\/([0-9]{8}-[0-9a-f]{32})\.json$/;
const SIDECAR_KEY = /^reports\/([0-9]{8}-[0-9a-f]{32})\.json\.provenance\.json$/;

export type R2ReportRemediationIssueCode =
  | "invalid-report-id"
  | "missing-retention-metadata"
  | "malformed-retention-metadata"
  | "ambiguous-legacy-retention"
  | "invalid-report-json"
  | "invalid-report"
  | "unsupported-report-schema"
  | "report-identity-changed"
  | "redaction-not-idempotent"
  | "generated-managed-report-invalid";

export type R2ReportRetentionSource =
  | { kind: "metadata"; retention: ManagedReportClock }
  | { kind: "legacy-uploaded"; uploadedAt: string; maxAgeDays: number }
  | {
      kind: "invalid";
      issue: "missing-retention-metadata" | "malformed-retention-metadata";
      detail?: string;
    };

/**
 * Replays the legacy writer's seven-day default only when the setting was
 * absent. An explicitly supplied typo must stop remediation, never silently
 * substitute a different historical lifetime.
 */
export function historicalR2MaxAgeDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 7;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS must be a positive number when explicitly set.");
  }
  return parsed;
}

export type R2ReportRemediationInput = {
  reportId: string;
  reportContents: string;
  sidecarContents: string | null;
  retentionSource: R2ReportRetentionSource;
  /** One immutable operator clock for the whole preflight/apply operation. */
  writtenAt: string;
  /** The same clock used only to classify already-expired objects. */
  now: string;
};

export type R2ReportRemediationPlan =
  | {
      ok: true;
      reportId: string;
      action: "current" | "rewrite";
      retentionOrigin: "metadata" | "legacy-uploaded";
      retention: { createdAt: string; expiresAt: string };
      reportWire: string;
      sidecarWire: string;
      reportChanged: boolean;
      /** Legacy metadata attachment requires a PUT even when bytes are already sanitized. */
      reportWriteRequired: boolean;
    }
  | {
      ok: true;
      reportId: string;
      action: "expired";
      retentionOrigin: "metadata" | "legacy-uploaded";
      retention: { createdAt: string; expiresAt: string };
    }
  | {
      ok: false;
      reportId: string;
      issue: R2ReportRemediationIssueCode;
      detail?: string;
    };

export type R2RemediationInventory = {
  reports: Array<{ reportId: string; reportKey: string; sidecarKey: string; sidecarExists: boolean }>;
  issues: Array<{ key: string; issue: "dangling-sidecar" | "unrecognized-object" }>;
};

/**
 * Classifies a complete `reports/` R2 listing. Unknown objects and dangling
 * attestations block apply instead of being silently ignored.
 */
export function planR2RemediationInventory(keys: readonly string[]): R2RemediationInventory {
  const reports = new Map<string, string>();
  const sidecars = new Map<string, string>();
  const issues: R2RemediationInventory["issues"] = [];

  for (const key of [...keys].sort()) {
    const report = REPORT_KEY.exec(key);
    if (report) {
      reports.set(report[1], key);
      continue;
    }
    const sidecar = SIDECAR_KEY.exec(key);
    if (sidecar) {
      sidecars.set(sidecar[1], key);
      continue;
    }
    issues.push({ key, issue: "unrecognized-object" });
  }

  for (const [reportId, key] of sidecars) {
    if (!reports.has(reportId)) issues.push({ key, issue: "dangling-sidecar" });
  }

  return {
    reports: [...reports.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reportId, reportKey]) => ({
        reportId,
        reportKey,
        sidecarKey: `${reportKey}.provenance.json`,
        sidecarExists: sidecars.has(reportId)
      })),
    issues: issues.sort((left, right) => left.key.localeCompare(right.key))
  };
}

/**
 * Pure redaction-v3 planner for one live share. It never trusts a sidecar as
 * authority: v1 bytes are parsed, sanitized, proved to be a fixed point, then
 * checked with the managed reader against the exact original retention clock.
 */
export function planR2ReportRemediation(input: R2ReportRemediationInput): R2ReportRemediationPlan {
  if (!REPORT_ID_PATTERN.test(input.reportId)) return issue(input.reportId, "invalid-report-id");
  if (!isCanonicalTimestamp(input.writtenAt) || !isCanonicalTimestamp(input.now)) {
    return issue(input.reportId, "malformed-retention-metadata", "invalid operator clock");
  }

  const resolved = resolveRetention(input.retentionSource, input.sidecarContents, input.now);
  if (!resolved.ok) return issue(input.reportId, resolved.issue, resolved.detail);
  const { retention, retentionOrigin } = resolved;
  if (Date.parse(input.now) >= Date.parse(retention.expiresAt)) {
    // Runtime pruning owns deletion. This migration only reports expired
    // objects, so it can never rewrite one and restart or extend its clock.
    return { ok: true, reportId: input.reportId, action: "expired", retentionOrigin, retention };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.reportContents) as unknown;
  } catch {
    return issue(input.reportId, "invalid-report-json");
  }
  const read = readStoredScanReport(parsed);
  if (!read.ok) return issue(input.reportId, "invalid-report", read.error);

  let publicReport: unknown;
  let reportWire: string;
  let reportChanged = false;
  if (read.stored.schemaVersion === 1) {
    const redacted = redactScanReportV1(read.stored.report).report;
    if (!preservesIdentity(input.reportId, read.stored.report, redacted)) {
      return issue(input.reportId, "report-identity-changed");
    }
    const twice = redactScanReportV1(redacted).report;
    if (publicReportDigest(redacted) !== publicReportDigest(twice)) {
      return issue(input.reportId, "redaction-not-idempotent");
    }
    publicReport = redacted;
    reportChanged = publicReportDigest(parsed) !== publicReportDigest(redacted);
    reportWire = reportChanged ? `${JSON.stringify(redacted, null, 2)}\n` : input.reportContents;
  } else {
    // There is no legacy-v2 sanitizer. Only reports whose embedded privacy
    // revision is already current can safely receive a current attestation;
    // the managed-reader proof below enforces that invariant.
    publicReport = read.stored.report;
    reportWire = input.reportContents;
  }

  let sidecarWire: string;
  try {
    const sidecar = buildProvenanceEntry({
      reportId: input.reportId,
      publicReport,
      writtenAt: input.writtenAt,
      createdAt: retention.createdAt,
      expiresAt: retention.expiresAt
    });
    sidecarWire = `${JSON.stringify(sidecar, null, 2)}\n`;
  } catch {
    return issue(input.reportId, "malformed-retention-metadata", "clock cannot produce provenance");
  }

  const generated = readManagedReport({
    reportId: input.reportId,
    reportContents: reportWire,
    sidecarContents: sidecarWire,
    retention
  });
  if (!generated.ok) {
    return issue(
      input.reportId,
      read.stored.schemaVersion === 2 && generated.reason === "redaction-version-mismatch"
        ? "unsupported-report-schema"
        : "generated-managed-report-invalid",
      generated.reason
    );
  }

  const existing = readManagedReport({
    reportId: input.reportId,
    reportContents: input.reportContents,
    sidecarContents: input.sidecarContents,
    retention
  });
  return {
    ok: true,
    reportId: input.reportId,
    action: existing.ok ? "current" : "rewrite",
    retentionOrigin,
    retention,
    reportWire,
    sidecarWire,
    reportChanged,
    reportWriteRequired: reportChanged || retentionOrigin === "legacy-uploaded"
  };
}

/**
 * Distinguishes truly absent legacy metadata from partial, conflicting, or
 * malformed clocks. Only the former may use the R2 object's immutable
 * pre-rewrite upload timestamp as its historical creation clock.
 */
export function r2ReportRetentionSource(
  metadata: Record<string, string> | undefined,
  uploadedAt: string | null,
  maxAgeDays: number
): R2ReportRetentionSource {
  const createdKebab = metadata?.["created-at"];
  const createdCamel = metadata?.createdAt;
  const expiresKebab = metadata?.["expires-at"];
  const expiresCamel = metadata?.expiresAt;
  const hasRetentionMetadata =
    createdKebab !== undefined ||
    createdCamel !== undefined ||
    expiresKebab !== undefined ||
    expiresCamel !== undefined;

  if (!hasRetentionMetadata) {
    if (uploadedAt === null) {
      return { kind: "invalid", issue: "missing-retention-metadata", detail: "missing R2 upload clock" };
    }
    return { kind: "legacy-uploaded", uploadedAt, maxAgeDays };
  }

  const createdAt = uniqueMetadataValue(createdKebab, createdCamel);
  const expiresAt = uniqueMetadataValue(expiresKebab, expiresCamel);
  const retention = createdAt !== null && expiresAt !== null ? { createdAt, expiresAt } : null;
  if (!retention || !isRuntimeRetention(retention)) {
    return { kind: "invalid", issue: "malformed-retention-metadata" };
  }
  return { kind: "metadata", retention };
}

function resolveRetention(
  source: R2ReportRetentionSource,
  sidecarContents: string | null,
  now: string
):
  | {
      ok: true;
      retentionOrigin: "metadata" | "legacy-uploaded";
      retention: { createdAt: string; expiresAt: string };
    }
  | {
      ok: false;
      issue: "missing-retention-metadata" | "malformed-retention-metadata" | "ambiguous-legacy-retention";
      detail?: string;
    } {
  if (source.kind === "invalid") {
    return { ok: false, issue: source.issue, ...(source.detail ? { detail: source.detail } : {}) };
  }
  if (source.kind === "metadata") {
    if (!isRuntimeRetention(source.retention)) return { ok: false, issue: "malformed-retention-metadata" };
    return { ok: true, retentionOrigin: "metadata", retention: source.retention };
  }

  if (sidecarContents !== null) {
    return {
      ok: false,
      issue: "ambiguous-legacy-retention",
      detail: "metadata-free object already has a sidecar"
    };
  }
  if (!isCanonicalTimestamp(source.uploadedAt)) {
    return { ok: false, issue: "malformed-retention-metadata", detail: "invalid R2 upload clock" };
  }
  if (!Number.isFinite(source.maxAgeDays) || source.maxAgeDays <= 0) {
    return { ok: false, issue: "malformed-retention-metadata", detail: "invalid historical max age" };
  }
  if (Date.parse(source.uploadedAt) > Date.parse(now)) {
    return {
      ok: false,
      issue: "ambiguous-legacy-retention",
      detail: "R2 upload clock is after the operator clock"
    };
  }
  const expiresAtMs = Date.parse(source.uploadedAt) + source.maxAgeDays * 24 * 60 * 60 * 1_000;
  const expiresAtDate = new Date(expiresAtMs);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(expiresAtDate.getTime())) {
    return { ok: false, issue: "malformed-retention-metadata", detail: "historical max age overflows" };
  }
  const retention = { createdAt: source.uploadedAt, expiresAt: expiresAtDate.toISOString() };
  if (!isRuntimeRetention(retention)) {
    return { ok: false, issue: "malformed-retention-metadata", detail: "invalid derived retention clock" };
  }
  return { ok: true, retentionOrigin: "legacy-uploaded", retention };
}

function preservesIdentity(reportId: string, before: ScanReport, after: ScanReport): boolean {
  if (before.schemaVersion !== after.schemaVersion || before.reportType !== after.reportType) return false;
  if (before.reportType === "comparison") {
    if (
      after.reportType !== "comparison" ||
      before.comparisonType !== after.comparisonType ||
      before.scannedAt !== after.scannedAt ||
      before.baseline.conditions.scannedAt !== after.baseline.conditions.scannedAt ||
      before.variant.conditions.scannedAt !== after.variant.conditions.scannedAt
    ) {
      return false;
    }
  } else if (after.reportType === "comparison" || before.conditions.scannedAt !== after.conditions.scannedAt) {
    return false;
  }
  if (JSON.stringify(before.share) !== JSON.stringify(after.share)) return false;
  return after.share?.id === undefined || after.share.id === reportId;
}

function isRuntimeRetention(value: unknown): value is { createdAt: string; expiresAt: string } {
  if (!value || typeof value !== "object") return false;
  const retention = value as Partial<ManagedReportClock>;
  return (
    Object.keys(value).length === 2 &&
    isCanonicalTimestamp(retention.createdAt) &&
    isCanonicalTimestamp(retention.expiresAt) &&
    Date.parse(retention.expiresAt) > Date.parse(retention.createdAt)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function uniqueMetadataValue(left: string | undefined, right: string | undefined): string | null {
  if (left !== undefined && right !== undefined && left !== right) return null;
  return left ?? right ?? null;
}

function issue(reportId: string, code: R2ReportRemediationIssueCode, detail?: string): R2ReportRemediationPlan {
  return { ok: false, reportId, issue: code, ...(detail ? { detail } : {}) };
}
