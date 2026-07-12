import path from "node:path";
import { displayRunView, toReportView, type ReportView } from "./scan-report-view";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  removeStaticReportBundle
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
 * kind, subject, and versioned measurement/condition cohort. That is the same
 * fail-closed identity used by "changed since last scan", so an incompatible
 * intervening scan cannot evict the only compatible predecessor. Unknown
 * identities do not match one another; only the newest report of each broad
 * site/kind is protected as a disappearance guard. The count cap remains the
 * hard ceiling, trimming oldest-first but preferring unprotected reports.
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
  now?: number;
};

export type PruneResult = {
  removed: string[];
  /** One line per skipped file, already formatted for the log. */
  warnings: string[];
};

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
  const { records, warnings } = await readReportRecords(reportsDir);
  const now = options.now ?? Date.now();

  const ageExempt = protectedGenerations(records, options.keepPerSite);
  const kept: ReportRecord[] = [];
  const removePaths = new Set<string>();

  for (const record of records) {
    if (now - record.scannedAtMs > options.maxAgeMs && !ageExempt.has(record)) {
      removePaths.add(record.path);
    } else {
      kept.push(record);
    }
  }

  // The count cap is the hard ceiling: trim oldest first, but prefer removing
  // reports that are not a site's protected newest generations.
  kept
    .sort((a, b) => Number(ageExempt.has(b)) - Number(ageExempt.has(a)) || b.scannedAtMs - a.scannedAtMs)
    .slice(options.maxCount)
    .forEach((record) => removePaths.add(record.path));

  await Promise.all(
    [...removePaths].map(async (filePath) => {
      const record = records.find((candidate) => candidate.path === filePath);
      if (!record) throw new Error(`Missing static report record for ${filePath}`);
      await removeStaticReportBundle(reportsDir, record.id);
    })
  );
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
