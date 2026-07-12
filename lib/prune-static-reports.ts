import path from "node:path";
import { toReportView } from "./scan-report-view";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  removeStaticReportBundle
} from "./static-report-files";

/**
 * Retention pruning for the committed report corpus (public/reports/). Ported
 * from the former MJS script so recognition goes through the canonical
 * version-aware deep reader (RFC 14.8) and the version-agnostic ReportView
 * instead of hand-parsed JSON.
 *
 * Retention policy (unchanged): reports older than the max age are removed
 * unless they are one of a site's newest `keepPerSite` reports of their kind
 * (shields / consent / gpc / temporal / single), so the directory's
 * "changed since last scan" pairing keeps a current and previous generation
 * and a site that stops being re-scanned never silently vanishes. The count
 * cap is the hard ceiling, trimming oldest-first but preferring unprotected
 * reports.
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
  kind: string;
};

export async function pruneStaticReports(reportsDir: string, options: PruneOptions): Promise<PruneResult> {
  const { records, warnings } = await readReportRecords(reportsDir);
  const now = options.now ?? Date.now();

  const ageExempt = newestPerSite(records, options.keepPerSite);
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

function newestPerSite(records: ReportRecord[], keepPerSite: number): Set<ReportRecord> {
  const exempt = new Set<ReportRecord>();
  if (keepPerSite === 0) return exempt;

  const bySiteAndKind = new Map<string, ReportRecord[]>();
  for (const record of records) {
    if (!record.domain) continue;
    const key = `${record.domain}|${record.kind}`;
    const list = bySiteAndKind.get(key);
    if (list) list.push(record);
    else bySiteAndKind.set(key, [record]);
  }

  for (const list of bySiteAndKind.values()) {
    list.sort((a, b) => b.scannedAtMs - a.scannedAtMs);
    for (const record of list.slice(0, keepPerSite)) {
      exempt.add(record);
    }
  }

  return exempt;
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

    records.push({
      id,
      path: filePath,
      scannedAtMs,
      domain: view.domain ? view.domain.toLowerCase().replace(/^www\./, "") : null,
      kind: retentionKind(read.stored)
    });
  }

  return { records, warnings };
}

/**
 * Retention grouping key. Deliberately NOT the view's design vocabulary: the
 * seam classifies every v1 comparison as descriptive (RFC 10.1), but the
 * "keep a current and previous generation" pairing groups by what kind of
 * report was PRODUCED (shields / consent / gpc / temporal / single), which is
 * wire-level metadata, not an experiment-validity claim.
 */
function retentionKind(stored: Parameters<typeof toReportView>[0]): string {
  if (stored.schemaVersion === 1) {
    const report = stored.report;
    if (report.reportType !== "comparison") return "single";
    return report.comparisonType || "comparison";
  }
  const report = stored.report;
  if (report.reportType !== "comparison") return "single";
  return report.experiment.kind === "intervention" ? report.experiment.axis : report.experiment.kind;
}
