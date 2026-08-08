import { randomBytes } from "node:crypto";
import { readManagedReport } from "./managed-report-reader";
import {
  buildProvenanceEntry,
  isProvenanceEntry,
  type RedactionProvenanceEntry
} from "./redaction-provenance";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import { buildReportShare } from "./report-locator";
import type { RuntimeScanReport } from "./runtime-scan-report";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import {
  isReportRetentionMetadata,
  resolveReportStoreBackend,
  type ReportRetentionMetadata,
  type ReportRetentionDebtEntry,
  type ReportStoreOperationOptions,
  type ReportStoreBackend,
  type ReportStoreBackendStatus,
  type StoredReportEntry
} from "./report-store-backend";
import { R2_LIST_MAX_HEAD_CANDIDATES, ReportStoreRequestTimeoutError } from "./report-store-r2";
import { REPORT_ID_PATTERN } from "./report-validation";
import type { ReadStoredScanReportError, StoredScanReport } from "./scan-report-reader";
import { sha256Hex } from "./sha256";
import type { ReportShare, ScanReport } from "./types";

const DEFAULT_REPORT_MAX_AGE_DAYS = 7;
/**
 * The R2 bucket's own `reports-retention-backstop-8d` lifecycle rule, in days.
 *
 * The bucket, not this process, has the last word on how long a share's bytes
 * exist: the rule deletes the whole `reports/` prefix at this age with no
 * exemption path. Kept here so the application TTL can be clamped below it;
 * lib/report-store.test.ts holds it to the value actually read back from the
 * live bucket in research/ops-receipts/r2-lifecycle-readback.json, so changing
 * the bucket rule without changing this constant fails a test rather than
 * silently outliving or under-living the published expiry.
 */
const REPORT_BUCKET_BACKSTOP_DAYS = 8;
const DEFAULT_REPORT_MAX_COUNT = 500;
/**
 * Listing slots reserved for objects prune must tolerate but cannot yet delete:
 * report-only crash orphans awaiting their immutable expiry, plus bundles
 * written by a concurrent save. Subtracted from the R2 listing ceiling so a
 * store at its configured maximum still lists successfully.
 */
const REPORT_UNCOMMITTED_HEAD_HEADROOM = 64;
const DEFAULT_REPORT_MIN_SURVIVAL_MS = 60_000;
export const DURABLE_SCAN_JOB_REPORT_MIN_SURVIVAL_MS = 75 * 60 * 1_000;
// Durable jobs retain their capability for 75 minutes. Deployments may pin a
// just-published report for at least that whole recovery window before
// count-based pruning can remove it; keep a bounded margin for configuration.
const MAX_REPORT_MIN_SURVIVAL_MS = 2 * 60 * 60_000;
const DEFAULT_REPORT_STORE_OPERATION_TIMEOUT_MS = 30_000;
const MAX_REPORT_STORE_OPERATION_TIMEOUT_MS = 120_000;
export const REPORT_PRUNE_MAX_DELETES_PER_PASS = 32;
export const REPORT_PRUNE_DELETE_CONCURRENCY = 4;
export const REPORT_MAX_AGE_DAYS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS";
const REPORT_MAX_COUNT_ENV = "SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT";
export const REPORT_MIN_SURVIVAL_MS_ENV = "SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS";
export const REPORT_STORE_OPERATION_TIMEOUT_MS_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_OPERATION_TIMEOUT_MS";

// Report creation is a three-object bundle on the filesystem and a two-object
// bundle in R2. Keep local mutations in one FIFO. Across processes, backends
// expose the provenance sidecar as the bundle's commit marker, so count-based
// pruning ignores a report still between its report and sidecar writes.
let reportStoreMutationTail: Promise<void> = Promise.resolve();

export type ReportStoreStatus = ReportStoreBackendStatus & {
  maxAgeDays: number;
  maxCount: number;
  minSurvivalMs: number;
};

export type ReportStoreRetentionStatus = {
  debtCount: number;
  maintenanceRequired: boolean;
  healthy: boolean;
};

/**
 * Content-free durable publication receipt. It contains only exact byte
 * digests, bounded clocks, and the provenance sidecar (which itself contains
 * only digests/version metadata), never a target URL or report evidence.
 */
export type ScanReportPublicationManifest = {
  manifestVersion: 1;
  reportId: string;
  reportWireSha256: string;
  publicDigest: string;
  canonicalizationVersion: string;
  redactionVersion: number;
  reportBytes: number;
  retention: ReportRetentionMetadata;
  sidecarWire: string;
};

export type PreparedScanReportBundle<T extends RuntimeScanReport = RuntimeScanReport> = {
  /** Immediate response report; may retain ephemeral screenshots. */
  report: T;
  /** Exact screenshot-free public bytes passed to the backend. */
  reportWire: string;
  /** Exact provenance commit-marker bytes passed to the backend. */
  sidecarWire: string;
  retention: ReportRetentionMetadata;
  manifest: ScanReportPublicationManifest;
};

export type ScanReportBundleReconciliation =
  | { outcome: "found"; report: StoredScanReport["report"]; stored: StoredScanReport; wire: string }
  | { outcome: "missing" }
  | {
      outcome: "integrity-error";
      reason:
        | "invalid-manifest"
        | "report-size-mismatch"
        | "report-digest-mismatch"
        | "retention-mismatch"
        | "sidecar-without-report"
        | "sidecar-mismatch"
        | "stored-bundle-invalid";
    };

export async function saveScanReport<T extends RuntimeScanReport>(
  report: T,
  options: { shareId?: string; signal?: AbortSignal } = {}
): Promise<T> {
  return commitPreparedScanReportBundle(prepareScanReportBundle(report, options), {
    signal: options.signal
  });
}

/**
 * Freeze every byte and clock needed for a publication attempt before a
 * durable coordinator marks the job as saving. The returned manifest is safe
 * to persist with job metadata; reportWire and report stay process-local.
 */
export function prepareScanReportBundle<T extends RuntimeScanReport>(
  report: T,
  options: { shareId?: string; now?: Date | number } = {}
): PreparedScanReportBundle<T> {
  const share = createReportShare(options.shareId);
  const runtimeReport: RuntimeScanReport = report;
  let saved: RuntimeScanReport;
  let publicReport: ScanReport | ReturnType<typeof toPublicScanReportR2>;
  if (runtimeReport.schemaVersion === 1) {
    // Idempotently enforce the frozen v1 public sanitizer at the persistence
    // boundary even when the producer already applied it.
    const sanitized = redactScanReportV1(attachShare(runtimeReport, share)).report;
    saved = sanitized;
    publicReport = stripScreenshotsForStorage(sanitized);
  } else {
    // r2 was already sanitized and semantically gated by its builder. Attach
    // the share to the immediate shell, then use the named-field projector as
    // the only persistence path; it strips the entire ephemeral screenshot
    // block by construction.
    saved = attachShare(runtimeReport, share);
    publicReport = toPublicScanReportR2(saved);
  }
  const now = preparationDate(options.now);
  const retention: ReportRetentionMetadata = {
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + reportMaxAgeMs()).toISOString()
  };
  const reportWire = `${JSON.stringify(publicReport, null, 2)}\n`;
  if (
    runtimeReport.schemaVersion === 2 &&
    Buffer.byteLength(reportWire, "utf8") > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES
  ) {
    throw new Error(
      `Refusing to persist a ScanReport v2/r2 larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES} public bytes after attaching its share.`
    );
  }
  const sidecar = buildProvenanceEntry({
    reportId: share.id,
    publicReport,
    writtenAt: retention.createdAt,
    createdAt: retention.createdAt,
    expiresAt: retention.expiresAt
  });
  const sidecarWire = `${JSON.stringify(sidecar, null, 2)}\n`;
  // Validate the exact bundle before the first externally visible write. This
  // also pins every embedded r2 run to the sidecar's current redactionVersion.
  const managed = readManagedReport({
    reportId: share.id,
    reportContents: reportWire,
    sidecarContents: sidecarWire,
    retention
  });
  if (!managed.ok) {
    throw new Error(`Refusing to persist an unreadable managed report (${managed.reason}).`);
  }

  const reportBytes = Buffer.byteLength(reportWire, "utf8");
  const manifest: ScanReportPublicationManifest = {
    manifestVersion: 1,
    reportId: share.id,
    reportWireSha256: sha256Hex(reportWire),
    publicDigest: sidecar.publicDigest,
    canonicalizationVersion: sidecar.canonicalizationVersion,
    redactionVersion: sidecar.redactionVersion,
    reportBytes,
    retention: { ...retention },
    sidecarWire
  };
  if (!isScanReportPublicationManifest(manifest)) {
    throw new Error("Refusing to prepare an invalid scan-report publication manifest.");
  }

  return {
    report: saved as T,
    reportWire,
    sidecarWire,
    retention,
    manifest
  };
}

/** Commit one already-frozen report bundle with the existing create protocol. */
export async function commitPreparedScanReportBundle<T extends RuntimeScanReport>(
  bundle: PreparedScanReportBundle<T>,
  options: ReportStoreOperationOptions = {}
): Promise<T> {
  assertPreparedScanReportBundle(bundle);
  const backend = resolveReportStoreBackend();
  await withReportStoreOperationDeadline(options, async (boundedOptions) =>
    withReportStoreMutationLock(async () => {
      boundedOptions.signal?.throwIfAborted();
      // Prune before exposing new bytes, reserving one count slot for this
      // bundle. Refuse publication only when a delete actually FAILED, which
      // leaves physical state unknown and is the condition this guard exists
      // for. A pass that merely hit its bounded per-pass delete cap deleted
      // everything it attempted and simply has more to do, which is the normal
      // shape of a burst of reports expiring on the same day. Refusing that too
      // rejected the next scan after Chromium had already run and the caller's
      // rate-limit token was spent. Retention still reports unhealthy and keeps
      // draining on later passes either way.
      const pruning = await pruneStoredReportsUnlocked(backend, Date.now(), boundedOptions, 1);
      if (pruning.physicalStateUnknown) {
        throw new Error(
          "Report publication refused while physical retention maintenance is pending."
        );
      }
      // Deliberately non-atomic and ordered: a crash/failure after the report PUT
      // leaves no matching sidecar, so reads fail closed rather than trusting an
      // unattested object. The local mutation lock prevents another in-process
      // save/prune from mistaking this deliberately partial interval for an old
      // bundle. The share operation itself does not succeed until both writes do.
      try {
        await backend.write(
          bundle.manifest.reportId,
          bundle.reportWire,
          bundle.retention,
          boundedOptions
        );
        await backend.writeSidecar(
          bundle.manifest.reportId,
          bundle.sidecarWire,
          boundedOptions
        );
      } catch (error) {
        // A create-only conflict or outcome-unknown sidecar PUT may mean another
        // process completed these exact bytes. Adopt only a fully re-read and
        // validated bundle. Never clean up here: a delayed successful sidecar PUT
        // or concurrent reconciler can otherwise be turned into a false success
        // followed by an unreadable report.
        if (!(await readExactStoredBundle(backend, bundle.manifest, boundedOptions))) throw error;
      }
      await assertSavedBundleSurvived(
        backend,
        bundle.manifest.reportId,
        bundle.reportWire,
        bundle.sidecarWire,
        bundle.retention,
        boundedOptions
      );
    }, boundedOptions.signal)
  );
  return bundle.report;
}

/**
 * Reconcile every create-only crash window without ever replacing or deleting
 * contradictory bytes. Backend transport errors intentionally propagate so a
 * durable worker can retry them without fabricating a terminal result.
 */
export async function reconcilePreparedScanReportBundle(
  manifest: unknown,
  options: ReportStoreOperationOptions = {}
): Promise<ScanReportBundleReconciliation> {
  options.signal?.throwIfAborted();
  if (!isScanReportPublicationManifest(manifest)) {
    return { outcome: "integrity-error", reason: "invalid-manifest" };
  }

  const backend = resolveReportStoreBackend();
  return withReportStoreMutationLock(async () => {
    const report = await backend.read(manifest.reportId, options);
    const sidecarWire = await backend.readSidecar(manifest.reportId, options);

    if (!report) {
      if (sidecarWire === null) return { outcome: "missing" };
      if (sidecarWire !== manifest.sidecarWire) {
        return { outcome: "integrity-error", reason: "sidecar-mismatch" };
      }
      // The two GETs are not an atomic snapshot. A writer may have completed
      // the exact primary between them, so re-read and adopt only a complete,
      // exact bundle. A stable sidecar-only state is terminal: deleting its
      // marker can race a late writer and invalidate a successful publication.
      const concurrentlyCommitted = await readExactStoredBundle(backend, manifest, options);
      return concurrentlyCommitted ?? {
        outcome: "integrity-error",
        reason: "sidecar-without-report"
      };
    }

    const reportBytes = Buffer.byteLength(report.contents, "utf8");
    if (reportBytes !== manifest.reportBytes) {
      return { outcome: "integrity-error", reason: "report-size-mismatch" };
    }
    if (sha256Hex(report.contents) !== manifest.reportWireSha256) {
      return { outcome: "integrity-error", reason: "report-digest-mismatch" };
    }
    if (!retentionEqual(report.retention, manifest.retention)) {
      return { outcome: "integrity-error", reason: "retention-mismatch" };
    }

    if (sidecarWire !== null && sidecarWire !== manifest.sidecarWire) {
      return { outcome: "integrity-error", reason: "sidecar-mismatch" };
    }

    // Validate the exact primary against the expected sidecar before repairing
    // a report-only crash. No write occurs for malformed or contradictory bytes.
    const managed = readManagedReport({
      reportId: manifest.reportId,
      reportContents: report.contents,
      sidecarContents: manifest.sidecarWire,
      retention: report.retention
    });
    if (!managed.ok) {
      return { outcome: "integrity-error", reason: "stored-bundle-invalid" };
    }

    if (sidecarWire === null) {
      try {
        await backend.writeSidecar(manifest.reportId, manifest.sidecarWire, options);
      } catch (error) {
        // Two fenced workers can still overlap at R2 while an old request winds
        // down. Treat an exact concurrent repair as success, but preserve every
        // contradictory or partial state for fail-closed handling.
        const concurrentlyRepaired = await readExactStoredBundle(backend, manifest, options);
        if (concurrentlyRepaired) return concurrentlyRepaired;
        throw error;
      }
    }

    return {
      outcome: "found",
      report: managed.stored.report,
      stored: managed.stored,
      wire: managed.wire
    };
  }, options.signal);
}

/**
 * Typed outcome of a store read (RFC 14.8: consumers get explicit
 * unreadable/unsupported handling, never a silent null that conflates
 * "missing" with "the store holds bytes this deployment cannot read").
 * Backend failures (outage, bad credentials) still throw and must propagate.
 */
export type StoredReportReadOutcome =
  | { outcome: "found"; stored: StoredScanReport; wire: string }
  | { outcome: "not-found" }
  | { outcome: "unreadable"; error: ReadStoredScanReportError; violations?: string[] };

/**
 * The canonical store read: parses the blob and dispatches it through the
 * version-aware deep reader, so a malformed stored report (a `requests:[null]`
 * entry, a truncated write) surfaces as a typed "unreadable" instead of
 * crashing a renderer downstream. `wire` is the stored bytes; API responses
 * serve it as-is so the wire form is never re-synthesized.
 */
export async function readStoredScanReportById(
  id: string,
  options: ReportStoreOperationOptions = {}
): Promise<StoredReportReadOutcome> {
  if (!REPORT_ID_PATTERN.test(id)) return { outcome: "not-found" };
  const backend = resolveReportStoreBackend();
  // This is the public permalink read, and it was the only store entry point
  // with no whole-operation deadline and no signal reaching the backend. Every
  // R2 call then ran its own full retry budget, so during a bucket brownout a
  // single unauthenticated GET occupied a Node request for the report, again
  // for the sidecar, and again for each delete on the expired path. Bound the
  // whole thing the way commit, prune, and retention status already are.
  return withReportStoreOperationDeadline(options, async (boundedOptions) => {
    const blob = await backend.read(id, boundedOptions);
    if (!blob) return { outcome: "not-found" };

    if (blob.retention && isExpired(blob.retention)) {
      // The retention-debt ledger is durable and shared, and a marker that is
      // only in flight is indistinguishable from a delete that failed. A prune
      // pass running concurrently reads it as physicalStateUnknown and refuses
      // the publication, and the health probe reports an unhealthy store, so an
      // unauthenticated permalink read could fail a scan that had already run.
      // Take the same mutation FIFO every other ledger mutation takes.
      await withReportStoreMutationLock(
        () => deleteWithRetentionDebt(backend, { id, scope: "bundle" }, boundedOptions),
        boundedOptions.signal
      ).catch(() => undefined);
      return { outcome: "not-found" };
    }
    const managed = readManagedReport({
      reportId: id,
      reportContents: blob.contents,
      sidecarContents: await backend.readSidecar(id, boundedOptions),
      retention: blob.retention
    });
    if (!managed.ok) {
      return {
        outcome: "unreadable",
        error: managed.error,
        ...(managed.violations ? { violations: managed.violations } : {})
      };
    }
    return { outcome: "found", stored: managed.stored, wire: managed.wire };
  });
}

export function pruneStoredReports(now = Date.now()): Promise<void> {
  return withReportStoreOperationDeadline({}, (options) =>
    withReportStoreMutationLock(async () => {
      await pruneStoredReportsUnlocked(resolveReportStoreBackend(), now, options);
    }, options.signal)
  );
}

export async function reportStoreRetentionStatus(): Promise<ReportStoreRetentionStatus> {
  return withReportStoreOperationDeadline({}, async (options) => {
    const state = await resolveReportStoreBackend().retentionState(options);
    return {
      debtCount: state.debts.length,
      maintenanceRequired: state.maintenanceRequired,
      healthy: state.debts.length === 0 && !state.maintenanceRequired
    };
  });
}

/**
 * Bounded autonomous retention maintenance used by health/startup probes. It
 * advances at most one fixed delete batch, then reports the durable remainder.
 * This also actively proves marker creation and deletion permissions instead
 * of treating an empty readable ledger as sufficient evidence.
 */
export async function maintainReportStoreRetention(): Promise<ReportStoreRetentionStatus> {
  await pruneStoredReports();
  return reportStoreRetentionStatus();
}

async function pruneStoredReportsUnlocked(
  backend: ReportStoreBackend,
  now: number,
  options: ReportStoreOperationOptions = {},
  incomingCount = 0
): Promise<{
  maintenanceRequired: boolean;
  /** The per-pass delete cap was hit; everything attempted succeeded. */
  continuationPending: boolean;
  /** A delete failed, so an object may outlive what retention reports. */
  physicalStateUnknown: boolean;
}> {
  const priorState = await backend.retentionState(options);
  const deletions: ReportRetentionDebtEntry[] = [...priorState.debts];
  const deletionKeys = new Set(deletions.map(retentionDebtKey));
  const scheduleDeletion = (debt: ReportRetentionDebtEntry) => {
    const key = retentionDebtKey(debt);
    if (deletionKeys.has(key)) return;
    deletionKeys.add(key);
    deletions.push(debt);
  };
  const entries = await backend.list(options);
  const kept: StoredReportEntry[] = [];

  for (const entry of entries) {
    if (!entry.reportPresent) {
      // A sidecar-only LIST snapshot can race a writer that is about to publish
      // the matching primary. Preserve it throughout its immutable retention
      // window; only an exact, expired marker is safe to remove. Malformed
      // markers have no trustworthy clock and stay fail-closed for operators.
      if (entry.sidecarPresent) {
        const sidecarWire = await backend.readSidecar(entry.id, options).catch(() => {
          options.signal?.throwIfAborted();
          return null;
        });
        const sidecar = sidecarWire === null ? null : parseExactProvenanceWire(sidecarWire);
        if (
          sidecar?.expiresAt !== null &&
          sidecar?.expiresAt !== undefined &&
          now >= Date.parse(sidecar.expiresAt)
        ) {
          scheduleDeletion({ id: entry.id, scope: "sidecar" });
        }
      }
      continue;
    }
    if (!entry.committed) {
      // Another process may be between the create-only report and sidecar
      // writes. LastModified cannot distinguish a crashed save from a delayed
      // cross-process write, so it is never an age-based cleanup clock. Once a
      // valid immutable expiresAt is reached, however, even a writer that later
      // commits would be publishing an already-expired share and removal is safe.
      if (entry.retention && now >= Date.parse(entry.retention.expiresAt)) {
        scheduleDeletion({ id: entry.id, scope: "bundle" });
      }
      continue;
    }
    // Legacy/malformed objects have no trustworthy immutable clock. Never
    // fall back to LastModified: a remediation rewrite would restart it and
    // silently extend retention. Delete such runtime shares fail-closed.
    if (!entry.retention || now >= Date.parse(entry.retention.expiresAt)) {
      scheduleDeletion({ id: entry.id, scope: "bundle" });
    } else {
      kept.push(entry);
    }
  }

  const maxCount = reportMaxCount();
  // Every concurrent pruner must choose the same winners. Per-save
  // "preserveId" sets let two maxCount=1 saves preserve themselves and delete
  // each other; immutable creation time plus ID gives all processes one total
  // order instead.
  const ordered = kept.sort(
    (a, b) =>
      Date.parse(b.retention!.createdAt) - Date.parse(a.retention!.createdAt) ||
      b.id.localeCompare(a.id)
  );
  const minimumSurvivalMs = reportMinimumSurvivalMs();
  const removable = ordered
    .slice(Math.max(0, maxCount - incomingCount))
    .filter((entry) => now - Date.parse(entry.retention!.createdAt) >= minimumSurvivalMs);
  for (const entry of removable) scheduleDeletion({ id: entry.id, scope: "bundle" });

  if (deletions.length === 0) {
    if (priorState.maintenanceRequired) {
      await backend.setRetentionMaintenanceRequired(false, options);
    }
    return { maintenanceRequired: false, continuationPending: false, physicalStateUnknown: false };
  }

  // One save/prune invocation can never fan out into an unbounded delete storm.
  // Persist the continuation signal before touching any target so a crash,
  // deadline, or delete-only permission failure remains operator-visible.
  await backend.setRetentionMaintenanceRequired(true, options);
  const selected = deletions.slice(0, REPORT_PRUNE_MAX_DELETES_PER_PASS);
  await mapWithConcurrency(selected, REPORT_PRUNE_DELETE_CONCURRENCY, async (debt) => {
    await deleteWithRetentionDebt(backend, debt, options);
  });

  const after = await backend.retentionState(options);
  // Two different facts, deliberately reported separately.
  //
  // `continuationPending` means this pass hit its own per-pass cap: every
  // delete it attempted SUCCEEDED and more work remains. That is the normal
  // shape of a burst expiring together (a scheduled refresh or a busy
  // afternoon all age out on the same 7-day boundary), and it says nothing
  // about whether the store is in a known state.
  //
  // `physicalStateUnknown` means a delete actually failed, so an object may
  // still be there when retention says it is gone. That is the only condition
  // that may refuse to publish new bytes.
  //
  // Conflating them refused publication on an ordinary backlog, and it did so
  // AFTER Chromium had already run and the caller's rate-limit token was
  // spent, turning routine retention lag into user-facing scan failures.
  const continuationPending = deletions.length > selected.length;
  const physicalStateUnknown = after.debts.length > 0;
  const maintenanceRequired = continuationPending || physicalStateUnknown;
  await backend.setRetentionMaintenanceRequired(maintenanceRequired, options);
  return { maintenanceRequired, continuationPending, physicalStateUnknown };
}

export function reportStoreStatus(): ReportStoreStatus {
  return {
    ...resolveReportStoreBackend().status(),
    maxAgeDays: reportMaxAgeDays(),
    maxCount: reportMaxCount(),
    minSurvivalMs: reportMinimumSurvivalMs()
  };
}

/** Construct the configured backend without performing IO; throws on bad config. */
export function assertReportStoreAvailable(): void {
  resolveReportStoreBackend();
}

const PUBLICATION_MANIFEST_KEYS = new Set<keyof ScanReportPublicationManifest>([
  "manifestVersion",
  "reportId",
  "reportWireSha256",
  "publicDigest",
  "canonicalizationVersion",
  "redactionVersion",
  "reportBytes",
  "retention",
  "sidecarWire"
]);

/** Strict parser for the content-free receipt persisted by a durable job. */
export function isScanReportPublicationManifest(
  value: unknown
): value is ScanReportPublicationManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<ScanReportPublicationManifest>;
  const keys = Object.keys(value);
  if (
    keys.length !== PUBLICATION_MANIFEST_KEYS.size ||
    !keys.every((key) => PUBLICATION_MANIFEST_KEYS.has(key as keyof ScanReportPublicationManifest)) ||
    manifest.manifestVersion !== 1 ||
    typeof manifest.reportId !== "string" ||
    !REPORT_ID_PATTERN.test(manifest.reportId) ||
    typeof manifest.reportWireSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.reportWireSha256) ||
    typeof manifest.publicDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(manifest.publicDigest) ||
    typeof manifest.canonicalizationVersion !== "string" ||
    manifest.canonicalizationVersion.length === 0 ||
    typeof manifest.redactionVersion !== "number" ||
    !Number.isInteger(manifest.redactionVersion) ||
    manifest.redactionVersion <= 0 ||
    typeof manifest.reportBytes !== "number" ||
    !Number.isSafeInteger(manifest.reportBytes) ||
    manifest.reportBytes <= 0 ||
    !isReportRetentionMetadata(manifest.retention) ||
    typeof manifest.sidecarWire !== "string"
  ) {
    return false;
  }

  const sidecar = parseExactProvenanceWire(manifest.sidecarWire);
  return Boolean(
    sidecar &&
      sidecar.reportId === manifest.reportId &&
      sidecar.publicDigest === manifest.publicDigest &&
      sidecar.canonicalizationVersion === manifest.canonicalizationVersion &&
      sidecar.redactionVersion === manifest.redactionVersion &&
      sidecar.writtenAt === manifest.retention.createdAt &&
      sidecar.createdAt === manifest.retention.createdAt &&
      sidecar.expiresAt === manifest.retention.expiresAt
  );
}

function parseExactProvenanceWire(wire: string): RedactionProvenanceEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wire) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!isProvenanceEntry(parsed)) return null;
  return wire === `${JSON.stringify(parsed, null, 2)}\n` ? parsed : null;
}

function assertPreparedScanReportBundle<T extends RuntimeScanReport>(
  bundle: PreparedScanReportBundle<T>
): void {
  if (!isScanReportPublicationManifest(bundle.manifest)) {
    throw new Error("Refusing to commit an invalid scan-report publication manifest.");
  }
  if (
    bundle.sidecarWire !== bundle.manifest.sidecarWire ||
    !retentionEqual(bundle.retention, bundle.manifest.retention) ||
    Buffer.byteLength(bundle.reportWire, "utf8") !== bundle.manifest.reportBytes ||
    sha256Hex(bundle.reportWire) !== bundle.manifest.reportWireSha256
  ) {
    throw new Error("Refusing to commit a scan-report bundle that does not match its manifest.");
  }

  const managed = readManagedReport({
    reportId: bundle.manifest.reportId,
    reportContents: bundle.reportWire,
    sidecarContents: bundle.sidecarWire,
    retention: bundle.retention
  });
  const expectedShare = buildReportShare(bundle.manifest.reportId);
  const immediateShare = bundle.report.share;
  if (
    !managed.ok ||
    !immediateShare ||
    immediateShare.id !== expectedShare.id ||
    immediateShare.path !== expectedShare.path ||
    immediateShare.jsonPath !== expectedShare.jsonPath
  ) {
    throw new Error("Refusing to commit an invalid prepared scan-report bundle.");
  }
}

function retentionEqual(
  left: ReportRetentionMetadata | null,
  right: ReportRetentionMetadata
): left is ReportRetentionMetadata {
  return Boolean(
    left && left.createdAt === right.createdAt && left.expiresAt === right.expiresAt
  );
}

function preparationDate(value: Date | number | undefined): Date {
  const date = value === undefined ? new Date() : new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid report preparation timestamp.");
  }
  return date;
}

function attachShare<T extends RuntimeScanReport>(report: T, share: ReportShare): T {
  return {
    ...report,
    share
  };
}

function stripScreenshotsForStorage(report: ScanReport): ScanReport {
  if (report.reportType === "comparison") {
    return {
      ...report,
      baseline: { ...report.baseline, screenshot: null },
      variant: { ...report.variant, screenshot: null }
    };
  }

  return {
    ...report,
    screenshot: null
  };
}

function createReportShare(id = `${dateSlug(new Date())}-${randomBytes(16).toString("hex")}`): ReportShare {
  return buildReportShare(id);
}

function dateSlug(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

async function deleteWithRetentionDebt(
  backend: ReportStoreBackend,
  debt: ReportRetentionDebtEntry,
  options: ReportStoreOperationOptions = {}
): Promise<void> {
  options.signal?.throwIfAborted();
  await backend.markRetentionDebt(debt, options);
  if (debt.scope === "sidecar") {
    await backend.removeSidecar(debt.id, options);
  } else {
    await backend.remove(debt.id, options);
  }
  await backend.clearRetentionDebt(debt, options);
}

function retentionDebtKey(debt: ReportRetentionDebtEntry): string {
  return `${debt.scope}:${debt.id}`;
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  // This pool drives retention deletes, so no worker may outlive the pass.
  // Promise.all settled on the first failed delete while its siblings kept
  // marking debt, removing objects, and clearing debt. By then the pass had
  // already released the store mutation lock and its whole-operation deadline
  // timer was cleared, so those deletes ran unsupervised and whatever ran next
  // read a retention ledger holding markers for bundles whose delete never
  // failed, which is the exact input to the publication refusal. Keep the
  // first failure and rethrow it only once every worker has returned.
  const failures: unknown[] = [];
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        await operation(values[index]);
      } catch (error) {
        failures.push(error);
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  if (failures.length > 0) throw failures[0];
}

async function withReportStoreOperationDeadline<T>(
  options: ReportStoreOperationOptions,
  operation: (options: ReportStoreOperationOptions) => Promise<T>
): Promise<T> {
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timeoutMs = reportStoreOperationTimeoutMs();
  const timeout = setTimeout(() => {
    // A timeout class, not a bare Error: this reason is what reaches
    // classifyReportStoreFailure through the health probe, and a bare Error
    // carries no status, no errno, and no DOMException name, so a stalled
    // backend published the reason token "unknown" instead of "timed-out".
    // The message is unchanged.
    controller.abort(
      new ReportStoreRequestTimeoutError(
        `Report-store operation exceeded its ${timeoutMs} ms whole-operation deadline.`
      )
    );
  }, timeoutMs);
  try {
    const execution = operation({ signal });
    const deadline = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      const onSettled = () => signal.removeEventListener("abort", onAbort);
      void execution.then(onSettled, onSettled);
    });
    return await Promise.race([execution, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readExactStoredBundle(
  backend: ReturnType<typeof resolveReportStoreBackend>,
  manifest: ScanReportPublicationManifest,
  options: ReportStoreOperationOptions = {}
): Promise<Extract<ScanReportBundleReconciliation, { outcome: "found" }> | null> {
  const report = await backend.read(manifest.reportId, options);
  if (
    !report ||
    Buffer.byteLength(report.contents, "utf8") !== manifest.reportBytes ||
    sha256Hex(report.contents) !== manifest.reportWireSha256 ||
    !retentionEqual(report.retention, manifest.retention)
  ) {
    return null;
  }
  const sidecarWire = await backend.readSidecar(manifest.reportId, options);
  if (sidecarWire !== manifest.sidecarWire) return null;

  const managed = readManagedReport({
    reportId: manifest.reportId,
    reportContents: report.contents,
    sidecarContents: sidecarWire,
    retention: report.retention
  });
  if (!managed.ok) return null;
  return {
    outcome: "found",
    report: managed.stored.report,
    stored: managed.stored,
    wire: managed.wire
  };
}

async function assertSavedBundleSurvived(
  backend: ReturnType<typeof resolveReportStoreBackend>,
  id: string,
  reportContents: string,
  sidecarContents: string,
  retention: ReportRetentionMetadata,
  options: ReportStoreOperationOptions = {}
): Promise<void> {
  const stored = await backend.read(id, options);
  const storedSidecar = await backend.readSidecar(id, options);
  if (
    !stored ||
    stored.contents !== reportContents ||
    storedSidecar !== sidecarContents ||
    stored.retention?.createdAt !== retention.createdAt ||
    stored.retention.expiresAt !== retention.expiresAt
  ) {
    throw new Error("Saved report bundle did not survive retention pruning as a readable committed share.");
  }
  const managed = readManagedReport({
    reportId: id,
    reportContents: stored.contents,
    sidecarContents: storedSidecar,
    retention: stored.retention
  });
  if (!managed.ok) {
    throw new Error("Saved report bundle did not survive retention pruning as a readable committed share.");
  }
}

function withReportStoreMutationLock<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const guardedOperation = () => {
    signal?.throwIfAborted();
    return operation();
  };
  const result = reportStoreMutationTail.then(guardedOperation, guardedOperation);
  reportStoreMutationTail = result.then(
    () => undefined,
    () => undefined
  );
  if (!signal) return result;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void result.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

function isExpired(retention: ReportRetentionMetadata): boolean {
  return Date.now() >= Date.parse(retention.expiresAt);
}

function reportMaxAgeMs(): number {
  return reportMaxAgeDays() * 24 * 60 * 60 * 1_000;
}

/**
 * Clamped strictly below the R2 bucket's own deletion rule, for the same class
 * of reason as reportMaxCount() below but with a worse failure mode.
 *
 * Two independent retention contracts govern these bytes. This process writes
 * `retention.expiresAt` into the provenance sidecar, publishes it, and refuses
 * to delete a report before it. The bucket separately deletes everything under
 * `reports/` at REPORT_BUCKET_BACKSTOP_DAYS, unconditionally, with no exemption
 * path. Nothing tied the two together, so an operator setting this env to 30
 * produced a store that promised a 30-day permalink and a bucket that destroyed
 * it on day 8.
 *
 * That is not merely a broken link. docs/compatibility-promise.md is approved
 * and digest-pinned in RELEASE_READINESS.json, and it promises a permalink
 * "either serves the same measurement or honestly ceases to exist" on the
 * documented application TTL. A share that 404s two thirds of the way through
 * its own published expiry breaks that promise without anyone editing the
 * promised document.
 *
 * Clamping rather than throwing keeps a misconfigured deployment serving
 * reports with an honest, shorter expiry instead of refusing every scan.
 */
function reportMaxAgeDays(): number {
  const requested = positiveNumberFromEnv(REPORT_MAX_AGE_DAYS_ENV, DEFAULT_REPORT_MAX_AGE_DAYS);
  return Math.min(requested, REPORT_BUCKET_BACKSTOP_DAYS - 1);
}

/**
 * Clamped to the R2 backend's own retention listing ceiling. Prune walks HEAD
 * candidates and refuses past R2_LIST_MAX_HEAD_CANDIDATES, so an operator
 * count above that ceiling produces a store that can never be pruned back
 * under its own limit: every maintenance pass refuses, retention debt only
 * grows, and the health check reports an unhealthy store with no operator
 * action that fixes it. Refusing the impossible value up front is the honest
 * failure mode.
 *
 * The clamp must land STRICTLY BELOW the ceiling. HEAD candidates count aged
 * report-only objects as well as committed bundles, and prune is required to
 * tolerate those for a full retention window: a crash between write() and
 * writeSidecar() leaves one, and report-store refuses to delete it before its
 * immutable expiry. Clamping to exactly the ceiling meant a store at its
 * steady-state maximum plus ONE ordinary crash orphan exceeded the listing
 * bound, so every prune threw, retention debt grew without bound, and no
 * further report could be published -- and the orphan that caused it could
 * only be removed by the prune that was now refusing to run.
 */
function reportMaxCount(): number {
  const requested = Math.max(1, Math.floor(positiveNumberFromEnv(REPORT_MAX_COUNT_ENV, DEFAULT_REPORT_MAX_COUNT)));
  return Math.min(requested, R2_LIST_MAX_HEAD_CANDIDATES - REPORT_UNCOMMITTED_HEAD_HEADROOM);
}

function reportMinimumSurvivalMs(): number {
  const raw = process.env[REPORT_MIN_SURVIVAL_MS_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_REPORT_MIN_SURVIVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_REPORT_MIN_SURVIVAL_MS;
  return Math.min(Math.floor(value), MAX_REPORT_MIN_SURVIVAL_MS);
}

function reportStoreOperationTimeoutMs(): number {
  const raw = process.env[REPORT_STORE_OPERATION_TIMEOUT_MS_ENV]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_REPORT_STORE_OPERATION_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 10) return DEFAULT_REPORT_STORE_OPERATION_TIMEOUT_MS;
  return Math.min(value, MAX_REPORT_STORE_OPERATION_TIMEOUT_MS);
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
