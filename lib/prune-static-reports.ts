import { readFile } from "node:fs/promises";
import path from "node:path";
import { readCorrectionsLedgerReportIds } from "./corrections-ledger";
import { preferCorpusRepresentative } from "./corpus-representative";
import { corpusRollupMembership, createCorpusStatsAccumulator } from "./corpus-stats-builder";
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
 * protected as a disappearance guard. Each corpus cohort's representative
 * report per site (the one the published aggregate measures that site by) is
 * protected too, so a prune never shrinks a cohort's set of eligible sites.
 * The normal count cap trims oldest-first
 * while preferring unprotected reports; immutable correction-linked evidence
 * overrides that cap rather than being silently deleted, and so do the inputs
 * a decided research package cites (DECIDED_PACKAGE_INPUT_FILES).
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
  /**
   * Reports a decided research package was built from, exempt from every
   * retention limit like correction evidence: the package's numbers are true
   * only while each of its inputs is committed.
   */
  decidedPackageReportIds?: ReadonlySet<string>;
  now?: number;
};

export type PruneResult = {
  removed: string[];
  /** One line per skipped file, already formatted for the log. */
  warnings: string[];
};

/**
 * Pin files of the decided research packages, relative to the repository
 * root. Each lists the committed reports its package was built from, and the
 * package's own check holds the list to the reports it reads
 * (research/calibration-censoring/census-inputs.mjs). The calibration-censoring
 * findings state "126 r2 runs", and docs restate that count in the present
 * tense; without the pin, age pruning removes those reports and the committed
 * package stops reproducing.
 */
export const DECIDED_PACKAGE_INPUT_FILES: readonly string[] = Object.freeze([
  "research/calibration-censoring/corpus-censoring-inputs.json"
]);

const REPORT_ID_PATTERN = /^\d{8}-[0-9a-f]{32}$/;

/**
 * The report ids one decided package cites. A missing or malformed pin file
 * throws: a prune that cannot tell which reports a package needs must not run.
 */
export async function readDecidedPackageReportIds(filePath: string): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`Decided-package pin file ${filePath} could not be read (${code}); pruning aborted.`);
  }
  const invalid = (why: string) => new Error(`Decided-package pin file ${filePath} is invalid: ${why}; pruning aborted.`);
  let wire: unknown;
  try {
    wire = JSON.parse(text);
  } catch {
    throw invalid("not JSON");
  }
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) throw invalid("not an object");
  const reportIds = (wire as { reportIds?: unknown }).reportIds;
  if (!Array.isArray(reportIds)) throw invalid("reportIds is not a list");
  const ids = new Set<string>();
  for (const id of reportIds) {
    if (typeof id !== "string" || !REPORT_ID_PATTERN.test(id)) throw invalid(`${JSON.stringify(id)} is not a report id`);
    if (ids.has(id)) throw invalid(`${id} is listed twice`);
    ids.add(id);
  }
  return ids;
}

/**
 * Production retention entry point. The complete corrections ledger and every
 * decided-package pin file are read before report discovery or deletion, so
 * invalid pin state aborts the operation without a partial prune.
 */
export async function pruneStaticReportsWithCorrections(
  reportsDir: string,
  correctionsLedgerPath: string,
  options: Omit<PruneOptions, "pinnedReportIds" | "decidedPackageReportIds">,
  decidedPackageInputPaths: readonly string[] = []
): Promise<PruneResult> {
  const pinnedReportIds = await readCorrectionsLedgerReportIds(correctionsLedgerPath);
  const decidedPackagePins = new Map<string, string>();
  for (const filePath of decidedPackageInputPaths) {
    for (const id of await readDecidedPackageReportIds(filePath)) {
      if (!decidedPackagePins.has(id)) decidedPackagePins.set(id, filePath);
    }
  }
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
    // A package citation is the same promise, and is checked the same way.
    for (const [reportId, filePath] of decidedPackagePins) {
      const read = await readStaticReportBundle(reportsDir, reportId);
      if (read.outcome !== "found") {
        const reason = read.outcome === "not-found" ? "missing-report" : read.reason;
        throw new Error(
          `Decided-package report ${reportId} cited by ${filePath} is not a valid committed static report bundle (${reason}); pruning aborted.`
        );
      }
    }
    return pruneStaticReportsUnderLock(reportsDir, {
      ...options,
      pinnedReportIds,
      decidedPackageReportIds: new Set(decidedPackagePins.keys())
    });
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
  /**
   * The corpus cohort and site this report counts for in the published
   * aggregate, and the time the aggregate ranks it by; null when it counts
   * for none (lib/corpus-stats-builder.ts, corpusRollupMembership).
   */
  corpusRollup: { key: string; cohortId: string; siteKey: string; scannedAt: string } | null;
};

async function pruneStaticReportsUnderLock(reportsDir: string, options: PruneOptions): Promise<PruneResult> {
  const { records, warnings, cohortIdsTheSelectionUses } = await readReportRecords(reportsDir);
  const now = options.now ?? Date.now();

  const ageExempt = protectedGenerations(records, options.keepPerSite);
  // The representatives of the cohorts the aggregate selection consults are
  // the last protected reports the count cap trims (see below).
  const selectionRepresentatives = new Set(
    options.keepPerSite === 0
      ? []
      : [...corpusRepresentatives(records)].filter((record) =>
          cohortIdsTheSelectionUses.has(record.corpusRollup!.cohortId)
        )
  );
  const decidedPackageReportIds = options.decidedPackageReportIds ?? new Set<string>();
  const pinned = (record: ReportRecord) =>
    options.pinnedReportIds.has(record.id) || decidedPackageReportIds.has(record.id);
  const kept: ReportRecord[] = [];
  const removePaths = new Set<string>();

  for (const record of records) {
    if (now - record.scannedAtMs > options.maxAgeMs && !ageExempt.has(record) && !pinned(record)) {
      removePaths.add(record.path);
    } else {
      kept.push(record);
    }
  }

  // Enforce the normal count ceiling by trimming oldest first while preferring
  // to keep protected generations. Correction and package pins are absolute
  // exemptions. The cap is the storage bound, so it may still shrink a
  // cohort's eligible sites, oldest cohort first; within the protected
  // reports it trims the aggregate selection's own representatives last, so
  // storage pressure reaches the published aggregate only after every other
  // protected report is gone.
  const capTier = (record: ReportRecord) => (selectionRepresentatives.has(record) ? 2 : ageExempt.has(record) ? 1 : 0);
  const pinnedCount = kept.filter(pinned).length;
  const capped = kept
    .filter((record) => !pinned(record))
    .sort((a, b) => capTier(b) - capTier(a) || b.scannedAtMs - a.scannedAtMs)
    .slice(Math.max(0, options.maxCount - pinnedCount));
  capped.forEach((record) => removePaths.add(record.path));

  // A trim that leaves a cohort with no eligible report for a site shrinks
  // that cohort's population, so it is said by name.
  const remainingRollups = new Set(
    records.filter((record) => !removePaths.has(record.path) && record.corpusRollup).map((record) => record.corpusRollup!.key)
  );
  for (const record of [...capped].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!record.corpusRollup || remainingRollups.has(record.corpusRollup.key)) continue;
    remainingRollups.add(record.corpusRollup.key);
    warnings.push(
      `The count cap removed the last eligible report (${record.id}) for site ${record.corpusRollup.siteKey} in corpus cohort ${record.corpusRollup.cohortId}.`
    );
  }

  if (pinnedCount > options.maxCount) {
    const correctionCount = kept.filter((record) => options.pinnedReportIds.has(record.id)).length;
    const packageOnly = pinnedCount - correctionCount;
    warnings.push(
      `Keeping ${correctionCount} correction-linked static reports${
        packageOnly > 0 ? ` and ${packageOnly} decided-package inputs` : ""
      } even though the configured count cap is ${options.maxCount}.`
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

  for (const record of corpusRepresentatives(records)) exempt.add(record);

  return exempt;
}

/**
 * Each corpus cohort's representative report per site: the report the
 * aggregate measures that site by, chosen by the aggregate's own rule.
 *
 * The two groups above are retention's own identities, and neither is the
 * aggregate's. A v1 Shields comparison has no pairing key, so only the
 * newest report per site and kind was protected: when a leg rescanned a site
 * on a new measurement line, the previous line's report lost its exemption
 * and aged out, and the previous line's cohort lost the site. On 2026-11-18
 * that would have dropped the Oct 19 cohort below its handoff share and
 * reverted the published aggregate to the Aug 24 cohort (p95 third-party
 * requests 209 to 404) with no site behaving differently. Keyed by the
 * aggregate's own cohort and site, a prune cannot remove a site from any
 * cohort it measures.
 */
function corpusRepresentatives(records: readonly ReportRecord[]): Set<ReportRecord> {
  const bySiteInCohort = new Map<string, ReportRecord>();
  for (const record of records) {
    if (!record.corpusRollup) continue;
    const existing = bySiteInCohort.get(record.corpusRollup.key);
    if (
      !existing ||
      preferCorpusRepresentative(
        { id: record.id, scannedAt: record.corpusRollup.scannedAt },
        { id: existing.id, scannedAt: existing.corpusRollup!.scannedAt }
      )
    ) {
      bySiteInCohort.set(record.corpusRollup.key, record);
    }
  }
  return new Set(bySiteInCohort.values());
}

function sortNewestFirst(records: ReportRecord[]): void {
  records.sort((a, b) => b.scannedAtMs - a.scannedAtMs || a.id.localeCompare(b.id));
}

async function readReportRecords(
  reportsDir: string
): Promise<{ records: ReportRecord[]; warnings: string[]; cohortIdsTheSelectionUses: ReadonlySet<string> }> {
  const warnings: string[] = [];
  // The aggregate's own accumulator, so the cohorts the selection consults are
  // decided by the code that publishes it.
  const aggregate = createCorpusStatsAccumulator();
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
    // A report whose cohort identity cannot be read cannot be shown not to
    // carry a site of some cohort, so like an unreadable file it is kept.
    let membership: ReturnType<typeof corpusRollupMembership>;
    try {
      membership = corpusRollupMembership(id, view);
    } catch (error) {
      warnings.push(
        `Keeping static report ${file} whose corpus cohort cannot be read (never pruned): ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
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
      }),
      corpusRollup: membership
        ? {
            key: `${membership.identity.id}|${membership.siteKey}`,
            cohortId: membership.identity.id,
            siteKey: membership.siteKey,
            scannedAt: membership.scannedAt
          }
        : null
    });
    aggregate.add(id, view);
  }

  return { records, warnings, cohortIdsTheSelectionUses: aggregate.cohortIdsTheSelectionUses() };
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
