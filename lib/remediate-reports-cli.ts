import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { publicReportDigest } from "./canonical-json";
import { readManagedReport, type ManagedReportReadFailureReason } from "./managed-report-reader";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildProvenanceEntry, committedSidecarFilename } from "./redaction-provenance";
import { REPORT_ID_PATTERN } from "./report-validation";
import { readStoredScanReport } from "./scan-report-reader";
import type { ScanReport } from "./types";

const REPORT_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{32})\.json$/;
const SIDECAR_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{32})\.provenance\.json$/;

export type RemediationMode = "dry-run" | "apply" | "check";

export type RemediationIssue = {
  reportId: string;
  reason: ManagedReportReadFailureReason | "dangling-sidecar";
};

export type RemediationSummary = {
  mode: RemediationMode;
  writtenAt: string;
  reports: number;
  reportChanges: number;
  sidecarsWritten: number;
  issues: RemediationIssue[];
};

export class RemediationCheckError extends Error {
  constructor(readonly summary: RemediationSummary) {
    super(
      `Report remediation check failed for ${summary.issues.length} report(s): ${summary.issues
        .map((issue) => `${issue.reportId} (${issue.reason})`)
        .join(", ")}`
    );
    this.name = "RemediationCheckError";
  }
}

export class RemediationPreflightError extends Error {
  constructor(readonly summary: RemediationSummary) {
    super(
      `Report remediation refused to write with ${summary.issues.length} dangling sidecar(s): ${summary.issues
        .map((issue) => issue.reportId)
        .join(", ")}`
    );
    this.name = "RemediationPreflightError";
  }
}

type PlannedReport = {
  reportId: string;
  reportPath: string;
  sidecarPath: string;
  originalWire: string;
  publicWire: string;
  sidecarWire: string;
  createdAt: string;
  reportChanged: boolean;
  sidecarContents: string | null;
  sidecarCurrent: boolean;
};

/**
 * Remediate the committed v1 report corpus. Dry-run is deliberately the
 * default. Apply preflights the entire corpus, then atomically replaces each
 * changed report before atomically creating/replacing its provenance sidecar.
 */
export async function remediateReports(input: {
  reportsDir: string;
  mode?: RemediationMode;
  /** One operator clock for the whole run; exposed for deterministic tooling/tests. */
  writtenAt?: string;
}): Promise<RemediationSummary> {
  const mode = input.mode ?? "dry-run";
  const writtenAt = input.writtenAt ?? new Date().toISOString();
  assertCanonicalTimestamp(writtenAt, "writtenAt");

  const directoryEntries = await readdir(input.reportsDir);
  const files = directoryEntries.filter((file) => REPORT_FILE_PATTERN.test(file)).sort();
  const reportIds = new Set(files.map((file) => REPORT_FILE_PATTERN.exec(file)![1]));
  const danglingIssues: RemediationIssue[] = directoryEntries
    .map((file) => SIDECAR_FILE_PATTERN.exec(file))
    .filter((match): match is RegExpExecArray => match !== null && !reportIds.has(match[1]))
    .map((match) => ({ reportId: match[1], reason: "dangling-sidecar" as const }))
    .sort((left, right) => left.reportId.localeCompare(right.reportId));
  const plans = await Promise.all(files.map((file) => planReport(input.reportsDir, file, writtenAt)));
  const reportChanges = plans.filter((plan) => plan.reportChanged).length;

  if (mode === "check") {
    const issues = [...(await checkPlans(plans)), ...danglingIssues];
    const summary: RemediationSummary = {
      mode,
      writtenAt,
      reports: plans.length,
      reportChanges,
      sidecarsWritten: 0,
      issues
    };
    if (issues.length > 0) throw new RemediationCheckError(summary);
    return summary;
  }

  if (mode === "dry-run") {
    return {
      mode,
      writtenAt,
      reports: plans.length,
      reportChanges,
      sidecarsWritten: 0,
      issues: [...(await checkPlans(plans)), ...danglingIssues]
    };
  }

  if (danglingIssues.length > 0) {
    throw new RemediationPreflightError({
      mode,
      writtenAt,
      reports: plans.length,
      reportChanges,
      sidecarsWritten: 0,
      issues: danglingIssues
    });
  }

  let sidecarsWritten = 0;
  for (const plan of plans) {
    // Report first, sidecar second. A sidecar failure therefore leaves either
    // no attestation or an old digest, both of which the managed reader rejects.
    if (plan.reportChanged) {
      await atomicReplace(plan.reportPath, plan.publicWire);
    }
    if (!plan.sidecarCurrent || plan.reportChanged) {
      await atomicReplace(plan.sidecarPath, plan.sidecarWire);
      sidecarsWritten += 1;
    }
  }

  return {
    mode,
    writtenAt,
    reports: plans.length,
    reportChanges,
    sidecarsWritten,
    issues: []
  };
}

async function planReport(reportsDir: string, file: string, writtenAt: string): Promise<PlannedReport> {
  const match = REPORT_FILE_PATTERN.exec(file);
  if (!match || !REPORT_ID_PATTERN.test(match[1])) throw new Error(`Invalid report filename "${file}".`);
  const reportId = match[1];
  const reportPath = path.join(reportsDir, file);
  const originalWire = await readFile(reportPath, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(originalWire) as unknown;
  } catch {
    throw new Error(`Cannot remediate ${file}: invalid JSON.`);
  }
  const read = readStoredScanReport(parsed);
  if (!read.ok) {
    throw new Error(`Cannot remediate ${file}: unreadable report (${read.error}).`);
  }
  if (read.stored.schemaVersion !== 1) {
    throw new Error(`Cannot remediate ${file}: committed remediation only supports schemaVersion 1.`);
  }

  const original = read.stored.report;
  const redacted = redactScanReportV1(original).report;
  assertPreservedIdentity(reportId, original, redacted);
  const createdAt = reportCreatedAt(original);
  const reportChanged = publicReportDigest(original) !== publicReportDigest(redacted);
  const publicWire = reportChanged ? `${JSON.stringify(redacted, null, 2)}\n` : originalWire;
  const sidecar = buildProvenanceEntry({
    reportId,
    publicReport: redacted,
    writtenAt,
    createdAt,
    expiresAt: null
  });
  const sidecarWire = `${JSON.stringify(sidecar, null, 2)}\n`;
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(reportId));
  const sidecarContents = await readOptionalSidecar(sidecarPath);
  const existingManaged = readManagedReport({
    reportId,
    reportContents: originalWire,
    sidecarContents,
    retention: { createdAt, expiresAt: null }
  });

  // Preflight the exact pair before any report in the run is mutated. This
  // independently proves fixed-point redaction, share binding, current
  // versions, digest, and the committed no-expiry retention clock.
  const managed = readManagedReport({
    reportId,
    reportContents: publicWire,
    sidecarContents: sidecarWire,
    retention: { createdAt, expiresAt: null }
  });
  if (!managed.ok) {
    throw new Error(`Cannot remediate ${file}: generated managed report failed validation (${managed.reason}).`);
  }

  return {
    reportId,
    reportPath,
    sidecarPath,
    originalWire,
    publicWire,
    sidecarWire,
    createdAt,
    reportChanged,
    sidecarContents,
    sidecarCurrent: existingManaged.ok
  };
}

async function checkPlans(plans: PlannedReport[]): Promise<RemediationIssue[]> {
  const issues: RemediationIssue[] = [];
  for (const plan of plans) {
    const managed = readManagedReport({
      reportId: plan.reportId,
      reportContents: plan.originalWire,
      sidecarContents: plan.sidecarContents,
      retention: { createdAt: plan.createdAt, expiresAt: null }
    });
    if (!managed.ok) issues.push({ reportId: plan.reportId, reason: managed.reason });
  }
  return issues;
}

function reportCreatedAt(report: ScanReport): string {
  const createdAt = report.reportType === "comparison" ? report.scannedAt : report.conditions.scannedAt;
  assertCanonicalTimestamp(createdAt, "recorded report creation time");
  return createdAt;
}

function assertPreservedIdentity(reportId: string, before: ScanReport, after: ScanReport): void {
  if (before.schemaVersion !== after.schemaVersion || before.reportType !== after.reportType) {
    throw new Error(`Cannot remediate ${reportId}: report kind changed during redaction.`);
  }
  if (before.reportType === "comparison") {
    if (
      after.reportType !== "comparison" ||
      before.comparisonType !== after.comparisonType ||
      before.scannedAt !== after.scannedAt ||
      before.baseline.conditions.scannedAt !== after.baseline.conditions.scannedAt ||
      before.variant.conditions.scannedAt !== after.variant.conditions.scannedAt
    ) {
      throw new Error(`Cannot remediate ${reportId}: comparison kind or timestamps changed during redaction.`);
    }
  } else {
    if (after.reportType === "comparison" || before.conditions.scannedAt !== after.conditions.scannedAt) {
      throw new Error(`Cannot remediate ${reportId}: report timestamp changed during redaction.`);
    }
  }
  if (JSON.stringify(before.share) !== JSON.stringify(after.share)) {
    throw new Error(`Cannot remediate ${reportId}: embedded share changed during redaction.`);
  }
  if (after.share?.id !== undefined && after.share.id !== reportId) {
    throw new Error(`Cannot remediate ${reportId}: embedded share id does not match its filename.`);
  }
}

async function readOptionalSidecar(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    // A non-file at the sidecar path is an invalid/missing attestation. Apply
    // still attempts its atomic replacement after the report, so a directory
    // or other collision cannot be mistaken for a successful remediation.
    if (isErrno(error, "ENOENT") || isErrno(error, "EISDIR")) return null;
    throw error;
  }
}

async function atomicReplace(file: string, contents: string): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const mode = await existingFileMode(file);
    handle = await open(temp, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

async function existingFileMode(file: string): Promise<number> {
  try {
    const metadata = await stat(file);
    return metadata.isFile() ? metadata.mode & 0o777 : 0o644;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return 0o644;
    throw error;
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Invalid ${label}: expected a canonical ISO timestamp.`);
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export function parseRemediationMode(args: string[]): RemediationMode {
  const apply = args.includes("--apply");
  const check = args.includes("--check");
  const unknown = args.filter((arg) => arg !== "--apply" && arg !== "--check");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (apply && check) throw new Error("--apply and --check are mutually exclusive.");
  return apply ? "apply" : check ? "check" : "dry-run";
}

async function main(): Promise<void> {
  const mode = parseRemediationMode(process.argv.slice(2));
  const summary = await remediateReports({
    reportsDir: path.join(process.cwd(), "public", "reports"),
    mode
  });
  if (mode === "dry-run") {
    console.log(
      `Dry run: ${summary.reports} report(s), ${summary.reportChanges} report change(s), ` +
        `${summary.issues.length} provenance issue(s). Re-run with --apply to write.`
    );
  } else if (mode === "apply") {
    console.log(
      `Applied remediation to ${summary.reports} report(s): ${summary.reportChanges} report change(s), ` +
        `${summary.sidecarsWritten} sidecar(s), writtenAt ${summary.writtenAt}.`
    );
  } else {
    console.log(`Checked ${summary.reports} report(s): all reports and sidecars are current.`);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
