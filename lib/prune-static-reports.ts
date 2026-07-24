import path from "node:path";
import { readCorrectionsLedgerReportIds } from "./corrections-ledger";
import { acquireReportCorpusLock } from "./report-corpus-lock";
import { displayRunView, toReportView, type ReportView } from "./scan-report-view";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  removeStaticReportBundleUnderLock
} from "./static-report-files";
import { temporalPairingKey } from "./temporal-deltas";
import { consentClicksForView, temporalCohortForStoredReport } from "./temporal-report-identity";
import type { ComparisonType } from "./types";

/**
 * Retention pruning for the committed report corpus (public/reports/). Ported
 * from the former MJS script so recognition goes through the canonical
 * version-aware deep reader (RFC 14.8) and the version-agnostic ReportView
 * instead of hand-parsed JSON.
 *
 * Retention policy: reports older than the max age are removed
 * unless they are one of the newest `keepPerSite` reports with the same site,
 * kind, subject, and versioned measurement/condition cohort. This strict
 * retention identity is intentionally narrower than the compatible-history
 * identity used by "changed since last scan"; protected generations preserve
 * useful predecessors without declaring them comparable. Unknown identities
 * do not match one another; only the newest report of each broad site/kind is
 * protected as a disappearance guard. The normal count cap trims oldest-first
 * while preferring unprotected reports; immutable correction-linked evidence
 * overrides that cap rather than being silently deleted.
 *
 * A file the reader cannot read is NEVER deleted: retention must not destroy
 * evidence it cannot understand. It is skipped with a warning and counts
 * toward nothing.
 *
 * Node-only module (filesystem); used by the CLI wrapper. Never imported by
 * app, worker, or browser code.
 */

export type PruneOptions = {
  maxAgeMs: number;
  maxCount: number;
  keepPerSite: number;
  /** Public correction evidence is immutable and exempt from every retention limit. */
  pinnedReportIds: ReadonlySet<string>;
  now?: number;
};

export type PruneResult = {
  removed: string[];
  /** One line per skipped file, already formatted for the log. */
  warnings: string[];
};

/**
 * Production retention entry point. The complete corrections ledger is read
 * before report discovery or deletion, so invalid correction state aborts the
 * operation without a partial prune.
 */
export async function pruneStaticReportsWithCorrections(
  reportsDir: string,
  correctionsLedgerPath: string,
  options: Omit<PruneOptions, "pinnedReportIds">
): Promise<PruneResult> {
  const pinnedReportIds = await readCorrectionsLedgerReportIds(correctionsLedgerPath);
  const lock = await acquireReportCorpusLock(reportsDir, "prune-static-reports");
  try {
    // A ledger reference is a promise that the immutable static bundle exists.
    // Verify every promise while holding the same lock used for discovery and
    // deletion, so a broken pin cannot race an unrelated partial prune.
    for (const reportId of pinnedReportIds) {
      const read = await readStaticReportBundle(reportsDir, reportId);
      if (read.outcome !== "found") {
        const reason = read.outcome === "not-found" ? "missing-report" : read.reason;
        throw new Error(
          `Correction-linked report ${reportId} is not a valid committed static report bundle (${reason}); pruning aborted.`
        );
      }
    }
    return pruneStaticReportsUnderLock(reportsDir, { ...options, pinnedReportIds });
  } finally {
    await lock.release();
  }
}

type ReportRecord = {
  id: string;
  path: string;
  scannedAtMs: number;
  domain: string | null;
  kind: ComparisonType | "single";
  /** Null means the subject or complete cohort is unprovable and unmatchable. */
  temporalPairingKey: string | null;
};

export async function pruneStaticReports(reportsDir: string, options: PruneOptions): Promise<PruneResult> {
  const lock = await acquireReportCorpusLock(reportsDir, "prune-static-reports");
  try {
    return await pruneStaticReportsUnderLock(reportsDir, options);
  } finally {
    await lock.release();
  }
}

async function pruneStaticReportsUnderLock(reportsDir: string, options: PruneOptions): Promise<PruneResult> {
  const { records, warnings } = await readReportRecords(reportsDir);
  const now = options.now ?? Date.now();

  const ageExempt = protectedGenerations(records, options.keepPerSite);
  const kept: ReportRecord[] = [];
  const removePaths = new Set<string>();

  for (const record of records) {
    if (
      now - record.scannedAtMs > options.maxAgeMs &&
      !ageExempt.has(record) &&
      !options.pinnedReportIds.has(record.id)
    ) {
      removePaths.add(record.path);
    } else {
      kept.push(record);
    }
  }

  // Enforce the normal count ceiling by trimming oldest first while preferring
  // to keep protected generations. Correction pins are absolute exemptions.
  const pinnedCount = kept.filter((record) => options.pinnedReportIds.has(record.id)).length;
  kept
    .filter((record) => !options.pinnedReportIds.has(record.id))
    .sort((a, b) => Number(ageExempt.has(b)) - Number(ageExempt.has(a)) || b.scannedAtMs - a.scannedAtMs)
    .slice(Math.max(0, options.maxCount - pinnedCount))
    .forEach((record) => removePaths.add(record.path));

  if (pinnedCount > options.maxCount) {
    warnings.push(
      `Keeping ${pinnedCount} correction-linked static reports even though the configured count cap is ${options.maxCount}.`
    );
  }

  // Deletions are intentionally serial while one corpus-wide lease is held.
  // Parallel per-pair leases race each other and can leave a partially pruned
  // corpus; serial deletion also gives deterministic failure ordering.
  for (const filePath of [...removePaths].sort()) {
    const record = records.find((candidate) => candidate.path === filePath);
    if (!record) throw new Error(`Missing static report record for ${filePath}`);
    await removeStaticReportBundleUnderLock(reportsDir, record.id);
  }
  return { removed: [...removePaths].sort(), warnings };
}

function protectedGenerations(records: ReportRecord[], keepPerSite: number): Set<ReportRecord> {
  const exempt = new Set<ReportRecord>();
  if (keepPerSite === 0) return exempt;

  // Comparable history is protected only inside its exact subject + complete
  // versioned cohort. A method/list/catalog/device/condition/schema change is
  // therefore a new group and cannot displace an older compatible predecessor.
  const byComparableIdentity = new Map<string, ReportRecord[]>();
  const bySiteAndKind = new Map<string, ReportRecord[]>();
  for (const record of records) {
    if (!record.domain) continue;
    const siteKey = `${record.domain}|${record.kind}`;
    const siteList = bySiteAndKind.get(siteKey);
    if (siteList) siteList.push(record);
    else bySiteAndKind.set(siteKey, [record]);

    if (record.temporalPairingKey) {
      const identityList = byComparableIdentity.get(record.temporalPairingKey);
      if (identityList) identityList.push(record);
      else byComparableIdentity.set(record.temporalPairingKey, [record]);
    }
  }

  for (const list of byComparableIdentity.values()) {
    sortNewestFirst(list);
    for (const record of list.slice(0, keepPerSite)) {
      exempt.add(record);
    }
  }

  // Null identities never group (unknown must not equal unknown), but retain
  // the newest broad record so a legacy/generalized site does not vanish.
  for (const list of bySiteAndKind.values()) {
    sortNewestFirst(list);
    if (list[0]) exempt.add(list[0]);
  }

  return exempt;
}

function sortNewestFirst(records: ReportRecord[]): void {
  records.sort((a, b) => b.scannedAtMs - a.scannedAtMs || a.id.localeCompare(b.id));
}

async function readReportRecords(reportsDir: string): Promise<{ records: ReportRecord[]; warnings: string[] }> {
  const warnings: string[] = [];
  for (const id of await listDanglingStaticSidecarIds(reportsDir)) {
    warnings.push(`Keeping dangling static report sidecar ${id}.provenance.json (never pruned).`);
  }

  const records: ReportRecord[] = [];
  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const file = `${id}.json`;
    const filePath = path.join(reportsDir, file);
    const read = await readStaticReportBundle(reportsDir, id);
    if (read.outcome !== "found") {
      const reason = read.outcome === "not-found" ? "missing-report" : read.reason;
      warnings.push(`Keeping unreadable or unmanaged static report ${file} (never pruned): ${reason}`);
      continue;
    }

    const view = toReportView(read.stored);
    // Retention ages a report by its NEWEST run, not its lead run: a
    // long-span temporal comparison's baseline can be arbitrarily old, and
    // keying age on it would make a just-published report look stale.
    const retainAt = view.latestRunAt ?? view.scannedAt;
    const scannedAtMs = retainAt === null ? Number.NaN : Date.parse(retainAt);
    if (!Number.isFinite(scannedAtMs)) {
      warnings.push(`Keeping static report without a readable scan time ${file} (never pruned).`);
      continue;
    }

    const domain = view.domain ? view.domain.toLowerCase().replace(/^www\./, "") : null;
    const kind = retentionKind(view);
    const run = displayRunView(view);
    records.push({
      id,
      path: filePath,
      scannedAtMs,
      domain,
      kind,
      temporalPairingKey: temporalPairingKey({
        domain: domain ?? "",
        reportType: view.reportType,
        ...(view.reportType === "comparison" ? { comparisonType: kind as ComparisonType } : {}),
        consentClicks: consentClicksForView(view),
        requestedUrl: run.conditions.requestedUrl,
        finalUrl: run.conditions.finalUrl,
        temporalCohort: temporalCohortForStoredReport(read.stored, view)
      })
    });
  }

  return { records, warnings };
}

/**
 * The history kind represented by the display run. The descriptive/causal
 * design vocabulary is irrelevant here; only the produced axis (or temporal /
 * custom shape) can identify compatible historical observations.
 */
function retentionKind(view: ReportView): ComparisonType | "single" {
  if (view.reportType !== "comparison") return "single";
  return view.comparison?.axis ?? (view.comparison?.temporalPair ? "temporal" : "custom");
}
