import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { syncDirectory } from "./exact-atomic-file";
import { publicReportDigest } from "./canonical-json";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { readManagedReport, type ManagedReportReadFailureReason } from "./managed-report-reader";
import {
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES
} from "./report-resource-limits";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import {
  buildProvenanceEntry,
  committedSidecarFilename,
  matchProvenanceAtVersion
} from "./redaction-provenance";
import { REPORT_ID_PATTERN } from "./report-validation";
import { readStoredScanReport } from "./scan-report-reader";
import type { PublicScanReportV2R2 } from "./scan-report-v2-r2";
import {
  MIGRATABLE_REDACTION_VERSION,
  R2RedactionRemediationError,
  r2ReportRedactionVersion,
  r2RemediationPreservesIdentity,
  redactPublicScanReportV2R2
} from "./scan-report-v2-r2-remediation";
import { parseStrictJson } from "./strict-json";
import type { ScanReport } from "./types";
import { acquireReportCorpusLock } from "./report-corpus-lock";
import {
  addRedactionTransitionAudit,
  emptyRedactionTransitionAudit,
  redactionTransitionAudit,
  type RedactionTransitionAudit
} from "./redaction-transition-audit";

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
  transitionAudit: RedactionTransitionAudit;
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

export class RemediationConflictError extends Error {
  constructor(detail: string) {
    super(`Report remediation observed a concurrent corpus change: ${detail}`);
    this.name = "RemediationConflictError";
  }
}

type RemediationApplyHookEvent = {
  stage: "after-plan" | "before-report-write" | "after-report-write" | "before-sidecar-write" | "after-sidecar-write" | "before-final-readback";
  reportId?: string;
};

type PlannedReport = {
  reportId: string;
  reportPath: string;
  sidecarPath: string;
  originalWire: string;
  originalBytes: Buffer;
  publicWire: string;
  sidecarWire: string;
  createdAt: string;
  reportChanged: boolean;
  sidecarContents: string | null;
  sidecarBytes: Buffer | null;
  sidecarCurrent: boolean;
  transitionAudit: RedactionTransitionAudit;
};

/**
 * Remediate the mixed committed report corpus. Frozen v1 reports retain their
 * historical sanitizer/rewrite behavior. Schema-r2 v3 reports migrate only
 * when an exact v3 sidecar proves their digest and immutable creation clock;
 * current v4 reports must already be sanitizer fixed points. Dry-run is the
 * default. Apply preflights the entire corpus, then atomically replaces each
 * changed report before atomically creating/replacing its provenance sidecar.
 */
export async function remediateReports(input: {
  reportsDir: string;
  mode?: RemediationMode;
  /** One operator clock for the whole run; exposed for deterministic tooling/tests. */
  writtenAt?: string;
  /** Deterministic race injection for tests; production callers leave absent. */
  _testApplyHook?: (event: RemediationApplyHookEvent) => Promise<void>;
}): Promise<RemediationSummary> {
  const mode = input.mode ?? "dry-run";
  const writtenAt = input.writtenAt ?? new Date().toISOString();
  assertCanonicalTimestamp(writtenAt, "writtenAt");

  // Dry-run and check also need one coherent corpus snapshot. The lease is
  // coordination metadata, not evidence mutation; without it a publication
  // gate could inspect half of another writer's report/sidecar pair.
  const lock = await acquireReportCorpusLock(input.reportsDir, `redaction-v4-remediation-${mode}`);
  try {
    return await remediateReportsUnlocked(input, mode, writtenAt);
  } finally {
    await lock.release();
  }
}

async function remediateReportsUnlocked(
  input: {
    reportsDir: string;
    _testApplyHook?: (event: RemediationApplyHookEvent) => Promise<void>;
  },
  mode: RemediationMode,
  writtenAt: string
): Promise<RemediationSummary> {

  const initialInventory = await reportDirectoryInventory(input.reportsDir);
  const directoryEntries = await readdir(input.reportsDir);
  const files = directoryEntries.filter((file) => REPORT_FILE_PATTERN.test(file)).sort();
  const reportIds = new Set(files.map((file) => REPORT_FILE_PATTERN.exec(file)![1]));
  const danglingIssues: RemediationIssue[] = directoryEntries
    .map((file) => SIDECAR_FILE_PATTERN.exec(file))
    .filter((match): match is RegExpExecArray => match !== null && !reportIds.has(match[1]))
    .map((match) => ({ reportId: match[1], reason: "dangling-sidecar" as const }))
    .sort((left, right) => left.reportId.localeCompare(right.reportId));
  const plans = await Promise.all(files.map((file) => planReport(input.reportsDir, file, writtenAt, mode)));
  const reportChanges = plans.filter((plan) => plan.reportChanged).length;
  const transitionAudit = plans.reduce((total, plan) => {
    addRedactionTransitionAudit(total, plan.transitionAudit);
    return total;
  }, emptyRedactionTransitionAudit());

  if (mode === "check") {
    const issues = [...(await checkPlans(plans)), ...danglingIssues];
    const summary: RemediationSummary = {
      mode,
      writtenAt,
      reports: plans.length,
      reportChanges,
      sidecarsWritten: 0,
      issues,
      transitionAudit
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
      issues: [...(await checkPlans(plans)), ...danglingIssues],
      transitionAudit
    };
  }

  if (danglingIssues.length > 0) {
    throw new RemediationPreflightError({
      mode,
      writtenAt,
      reports: plans.length,
      reportChanges,
      sidecarsWritten: 0,
      issues: danglingIssues,
      transitionAudit
    });
  }

  await input._testApplyHook?.({ stage: "after-plan" });
  let expectedInventory = initialInventory;
  await assertInventory(input.reportsDir, expectedInventory, "after planning");

  let sidecarsWritten = 0;
  for (const plan of plans) {
    // Report first, sidecar second. A sidecar failure therefore leaves either
    // no attestation or an old digest, both of which the managed reader rejects.
    if (plan.reportChanged) {
      await input._testApplyHook?.({ stage: "before-report-write", reportId: plan.reportId });
      await assertInventory(input.reportsDir, expectedInventory, `before report ${plan.reportId}`);
      await assertExactObjectState(
        plan.reportPath,
        plan.originalBytes,
        SERVER_STORED_REPORT_JSON_MAX_BYTES,
        `${plan.reportId}.json`
      );
      await assertExactObjectState(
        plan.sidecarPath,
        plan.sidecarBytes,
        SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
        `${plan.reportId}.provenance.json`
      );
      await atomicReplace(plan.reportPath, plan.publicWire);
      await input._testApplyHook?.({ stage: "after-report-write", reportId: plan.reportId });
      await assertExactObjectState(
        plan.reportPath,
        Buffer.from(plan.publicWire, "utf8"),
        SERVER_STORED_REPORT_JSON_MAX_BYTES,
        `${plan.reportId}.json`
      );
      await assertInventory(input.reportsDir, expectedInventory, `after report ${plan.reportId}`);
    }
    if (!plan.sidecarCurrent || plan.reportChanged) {
      await input._testApplyHook?.({ stage: "before-sidecar-write", reportId: plan.reportId });
      await assertInventory(input.reportsDir, expectedInventory, `before sidecar ${plan.reportId}`);
      await assertExactObjectState(
        plan.reportPath,
        Buffer.from(plan.reportChanged ? plan.publicWire : plan.originalWire, "utf8"),
        SERVER_STORED_REPORT_JSON_MAX_BYTES,
        `${plan.reportId}.json`
      );
      await assertExactObjectState(
        plan.sidecarPath,
        plan.sidecarBytes,
        SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
        `${plan.reportId}.provenance.json`
      );
      await atomicReplace(plan.sidecarPath, plan.sidecarWire);
      sidecarsWritten += 1;
      expectedInventory = withExpectedRegularFile(expectedInventory, path.basename(plan.sidecarPath));
      await input._testApplyHook?.({ stage: "after-sidecar-write", reportId: plan.reportId });
      await assertExactObjectState(
        plan.sidecarPath,
        Buffer.from(plan.sidecarWire, "utf8"),
        SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
        `${plan.reportId}.provenance.json`
      );
      await assertInventory(input.reportsDir, expectedInventory, `after sidecar ${plan.reportId}`);
    }
  }

  await input._testApplyHook?.({ stage: "before-final-readback" });
  await assertInventory(input.reportsDir, expectedInventory, "at final readback");
  for (const plan of plans) await verifyFinalPlan(plan);

  return {
    mode,
    writtenAt,
    reports: plans.length,
    reportChanges,
    sidecarsWritten,
    issues: [],
    transitionAudit
  };
}

async function planReport(
  reportsDir: string,
  file: string,
  writtenAt: string,
  mode: RemediationMode
): Promise<PlannedReport> {
  const match = REPORT_FILE_PATTERN.exec(file);
  if (!match || !REPORT_ID_PATTERN.test(match[1])) throw new Error(`Invalid report filename "${file}".`);
  const reportId = match[1];
  const reportPath = path.join(reportsDir, file);
  const originalSnapshot = await readBoundedUtf8FileSnapshot(
    reportPath,
    SERVER_STORED_REPORT_JSON_MAX_BYTES,
    file,
    false
  );
  const originalWire = originalSnapshot.text;

  let parsed: unknown;
  try {
    parsed = parseStrictJson(originalWire, SERVER_STORED_REPORT_JSON_MAX_BYTES);
  } catch {
    throw new Error(`Cannot remediate ${file}: invalid JSON.`);
  }
  const read = readStoredScanReport(parsed);
  if (!read.ok) {
    throw new Error(`Cannot remediate ${file}: unreadable report (${read.error}).`);
  }
  const createdAt = committedReportCreatedAt(read.stored);
  const sidecarPath = path.join(reportsDir, committedSidecarFilename(reportId));
  const sidecarSnapshot = await readOptionalSidecarSnapshot(sidecarPath);
  const sidecarContents = sidecarSnapshot?.text ?? null;
  // Check/dry-run classify invalid sidecars through readManagedReport so their
  // structured issue summaries remain useful. Apply refuses such bytes before
  // any rewrite; it never silently overwrites a duplicate-key wire.
  if (sidecarContents !== null && mode === "apply") {
    try {
      parseStrictJson(sidecarContents, SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES);
    } catch {
      throw new Error(`Cannot remediate ${file}: provenance sidecar is invalid JSON.`);
    }
  }
  let publicReport = read.stored.report;
  let publicWire = originalWire;
  let reportChanged = false;
  if (read.stored.schemaVersion === 1) {
    const original = read.stored.report;
    const redacted = redactScanReportV1(original).report;
    assertPreservedIdentity(reportId, original, redacted);
    reportChanged = publicReportDigest(original) !== publicReportDigest(redacted);
    publicReport = redacted;
    publicWire = reportChanged ? `${JSON.stringify(redacted, null, 2)}\n` : originalWire;
  } else {
    if (read.stored.schemaRevision !== 2) {
      throw new Error(`Cannot remediate ${file}: only schema-r2 has a reviewed v2 migration.`);
    }
    const original = read.stored.report as PublicScanReportV2R2;
    let sourceVersion: number;
    try {
      sourceVersion = r2ReportRedactionVersion(original);
    } catch (error) {
      throw new Error(
        `Cannot remediate ${file}: ambiguous r2 redaction provenance (${r2RemediationDetail(error)}).`
      );
    }
    if (sourceVersion === MIGRATABLE_REDACTION_VERSION) {
      assertPriorV3CommittedProvenance(file, reportId, original, sidecarContents, createdAt);
    }

    let redacted: PublicScanReportV2R2;
    try {
      redacted = redactPublicScanReportV2R2(original);
    } catch (error) {
      throw new Error(`Cannot remediate ${file}: r2 sanitizer rejected the report (${r2RemediationDetail(error)}).`);
    }
    if (!r2RemediationPreservesIdentity(reportId, original, redacted)) {
      throw new Error(`Cannot remediate ${reportId}: schema-r2 identity changed during redaction.`);
    }
    let twice: PublicScanReportV2R2;
    try {
      twice = redactPublicScanReportV2R2(redacted);
    } catch (error) {
      throw new Error(`Cannot remediate ${file}: generated r2 report is not a fixed point (${r2RemediationDetail(error)}).`);
    }
    if (publicReportDigest(redacted) !== publicReportDigest(twice)) {
      throw new Error(`Cannot remediate ${file}: generated r2 report is not a fixed point.`);
    }
    reportChanged = publicReportDigest(original) !== publicReportDigest(redacted);
    if (sourceVersion !== MIGRATABLE_REDACTION_VERSION && reportChanged) {
      throw new Error(`Cannot remediate ${file}: report declares current redaction but is not a fixed point.`);
    }
    publicReport = redacted;
    publicWire = reportChanged ? `${JSON.stringify(redacted, null, 2)}\n` : originalWire;
  }

  if (Buffer.byteLength(publicWire, "utf8") > SERVER_STORED_REPORT_JSON_MAX_BYTES) {
    throw new Error(
      `Cannot remediate ${file}: generated report exceeds the ${SERVER_STORED_REPORT_JSON_MAX_BYTES}-byte stored-report limit.`
    );
  }
  const sidecar = buildProvenanceEntry({
    reportId,
    publicReport,
    writtenAt,
    createdAt,
    expiresAt: null
  });
  const sidecarWire = `${JSON.stringify(sidecar, null, 2)}\n`;
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
    originalBytes: originalSnapshot.bytes,
    publicWire,
    sidecarWire,
    createdAt,
    reportChanged,
    sidecarContents,
    sidecarBytes: sidecarSnapshot?.bytes ?? null,
    sidecarCurrent: existingManaged.ok,
    transitionAudit: redactionTransitionAudit(read.stored.report, publicReport)
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

type ReportDirectoryInventoryEntry = {
  name: string;
  kind: "file" | "directory" | "symlink" | "other";
};

async function reportDirectoryInventory(reportsDir: string): Promise<ReportDirectoryInventoryEntry[]> {
  const entries = await readdir(reportsDir, { withFileTypes: true });
  return entries
    .map((entry): ReportDirectoryInventoryEntry => ({
      name: entry.name,
      kind: entry.isFile()
        ? "file"
        : entry.isDirectory()
          ? "directory"
          : entry.isSymbolicLink()
            ? "symlink"
            : "other"
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}

async function assertInventory(
  reportsDir: string,
  expected: ReportDirectoryInventoryEntry[],
  stage: string
): Promise<void> {
  const actual = await reportDirectoryInventory(reportsDir);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RemediationConflictError(`directory inventory changed ${stage}`);
  }
}

function withExpectedRegularFile(
  inventory: ReportDirectoryInventoryEntry[],
  name: string
): ReportDirectoryInventoryEntry[] {
  if (inventory.some((entry) => entry.name === name)) return inventory;
  return [...inventory, { name, kind: "file" as const }].sort(
    (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind)
  );
}

async function assertExactObjectState(
  file: string,
  expected: Buffer | null,
  maxBytes: number,
  label: string
): Promise<void> {
  let actual: ExactUtf8FileSnapshot | null;
  try {
    actual = await readBoundedUtf8FileSnapshot(file, maxBytes, label, true);
  } catch {
    throw new RemediationConflictError(`${label} became unreadable or non-regular`);
  }
  if (expected === null ? actual !== null : actual === null || !actual.bytes.equals(expected)) {
    throw new RemediationConflictError(`${label} bytes changed after planning`);
  }
}

async function verifyFinalPlan(plan: PlannedReport): Promise<void> {
  const report = await readBoundedUtf8FileSnapshot(
    plan.reportPath,
    SERVER_STORED_REPORT_JSON_MAX_BYTES,
    `${plan.reportId}.json`,
    false
  );
  const sidecar = await readBoundedUtf8FileSnapshot(
    plan.sidecarPath,
    SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
    `${plan.reportId}.provenance.json`,
    false
  );
  const expectedSidecarBytes =
    !plan.sidecarCurrent || plan.reportChanged
      ? Buffer.from(plan.sidecarWire, "utf8")
      : plan.sidecarBytes;
  if (
    expectedSidecarBytes === null ||
    !report.bytes.equals(Buffer.from(plan.publicWire, "utf8")) ||
    !sidecar.bytes.equals(expectedSidecarBytes)
  ) {
    throw new RemediationConflictError(`${plan.reportId} final bytes do not match the plan`);
  }
  const managed = readManagedReport({
    reportId: plan.reportId,
    reportContents: report.text,
    sidecarContents: sidecar.text,
    retention: { createdAt: plan.createdAt, expiresAt: null }
  });
  if (!managed.ok || managed.wire !== report.text) {
    throw new RemediationConflictError(`${plan.reportId} failed final managed readback`);
  }
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

function assertPriorV3CommittedProvenance(
  file: string,
  reportId: string,
  report: PublicScanReportV2R2,
  sidecarContents: string | null,
  createdAt: string
): void {
  if (sidecarContents === null) {
    throw new Error(`Cannot remediate ${file}: v3 report has no provenance sidecar.`);
  }
  let sidecar: unknown;
  try {
    sidecar = parseStrictJson(sidecarContents, SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES);
  } catch {
    throw new Error(`Cannot remediate ${file}: v3 provenance sidecar is invalid JSON.`);
  }
  const match = matchProvenanceAtVersion(report, sidecar, reportId, MIGRATABLE_REDACTION_VERSION);
  if (match.status !== "matched") {
    const detail = match.status === "digest-mismatch" ? "digest mismatch" : match.reason;
    throw new Error(`Cannot remediate ${file}: ambiguous v3 provenance (${detail}).`);
  }
  if (match.entry.createdAt !== createdAt || match.entry.expiresAt !== null) {
    throw new Error(`Cannot remediate ${file}: v3 provenance retention clock mismatch.`);
  }
}

function r2RemediationDetail(error: unknown): string {
  return error instanceof R2RedactionRemediationError ? error.reason : "unknown migration failure";
}

async function readOptionalSidecarSnapshot(file: string): Promise<ExactUtf8FileSnapshot | null> {
  return readBoundedUtf8FileSnapshot(
    file,
    SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
    path.basename(file),
    true
  );
}

type ExactUtf8FileSnapshot = { text: string; bytes: Buffer };

function readBoundedUtf8FileSnapshot(
  file: string,
  maxBytes: number,
  label: string,
  optional: false
): Promise<ExactUtf8FileSnapshot>;
function readBoundedUtf8FileSnapshot(
  file: string,
  maxBytes: number,
  label: string,
  optional: true
): Promise<ExactUtf8FileSnapshot | null>;
async function readBoundedUtf8FileSnapshot(
  file: string,
  maxBytes: number,
  label: string,
  optional: boolean
): Promise<ExactUtf8FileSnapshot | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (optional && isErrno(error, "ENOENT")) return null;
    if (isErrno(error, "ELOOP")) {
      throw new Error(`Cannot remediate ${label}: object path is not a regular file.`);
    }
    throw error;
  }

  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new Error(`Cannot remediate ${label}: object path is not a regular file.`);
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw new Error(`Cannot remediate ${label}: object exceeds the ${maxBytes}-byte remediation limit.`);
    }

    // Allocate from the already-bounded fstat size and read that exact file
    // handle. A path replacement cannot redirect this read to another inode.
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`Cannot remediate ${label}: object changed during byte read.`);
      }
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`Cannot remediate ${label}: object changed during byte read.`);
    }
    try {
      // `ignoreBOM: true` means "do not consume the BOM" in WHATWG
      // TextDecoder terminology. Preserve every decoded code point so a BOM
      // cannot make a distinct stored byte sequence look like canonical JSON.
      return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), bytes };
    } catch {
      throw new Error(`Cannot remediate ${label}: object is not exact valid UTF-8.`);
    }
  } finally {
    await handle.close();
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
    await syncDirectory(path.dirname(file));
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
  console.log(
    `Transition audit ${summary.transitionAudit.version}: ` +
      `${summary.transitionAudit.pageTitlesWithheld} page title(s) withheld, ` +
      `${summary.transitionAudit.explicitPortFieldsRemoved} explicit-port field(s) removed, ` +
      `${summary.transitionAudit.ipLiteralFieldsRejected} IP-literal field(s) rejected.`
  );
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
