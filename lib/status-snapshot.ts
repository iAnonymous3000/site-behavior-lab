import { freshnessState, PUBLIC_STATUS_MAX_CORPUS_AGE_MS } from "./public-status";

/** Public build evidence only; scan records and private operations never enter this response. */
export type StatusSnapshot = {
  schemaVersion: 1;
  sourceRevision: string | null;
  aggregateCohortId: string | null;
  latestAggregateEvidence: string | null;
  latestEligibleEvidence: string | null;
  newerEligibleOutsideAggregate: boolean;
  mostPagesRankElsewhere: boolean;
  categoryCohortCount: number;
  categoriesUseAggregateCohort: boolean;
  scanRankingSentence: string;
  siteCount: number;
  coverageSiteCount: number;
  v1ReportCount: number;
  v2ReportCount: number;
  aggregateSiteDates: string[];
  filterFetchedAt: string;
  filterSourceCount: number;
  filterManifestDigest: string;
  playwrightVersion: string;
  adblockEngineVersion: string;
  catalogVersion: string;
  catalogEntries: number;
};

export function readStatusSnapshot(value: unknown): StatusSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid status snapshot");
  const v = value as Record<string, unknown>;
  const countKeys = ["categoryCohortCount", "siteCount", "coverageSiteCount", "v1ReportCount", "v2ReportCount", "filterSourceCount", "catalogEntries"];
  const textKeys = ["scanRankingSentence", "filterFetchedAt", "playwrightVersion", "adblockEngineVersion", "catalogVersion"];
  const nullableTextKeys = ["aggregateCohortId", "latestAggregateEvidence", "latestEligibleEvidence"];
  if (v.schemaVersion !== 1 ||
      !(v.sourceRevision === null || typeof v.sourceRevision === "string" && /^[a-f0-9]{40}$/.test(v.sourceRevision)) ||
      !countKeys.every((key) => Number.isSafeInteger(v[key]) && (v[key] as number) >= 0) ||
      !textKeys.every((key) => typeof v[key] === "string" && (v[key] as string).length > 0 && (v[key] as string).length <= 4096) ||
      !nullableTextKeys.every((key) => v[key] === null || typeof v[key] === "string" && (v[key] as string).length <= 4096) ||
      !["newerEligibleOutsideAggregate", "mostPagesRankElsewhere", "categoriesUseAggregateCohort"].every((key) => typeof v[key] === "boolean") ||
      typeof v.filterManifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(v.filterManifestDigest) ||
      !Array.isArray(v.aggregateSiteDates) || v.aggregateSiteDates.length !== v.siteCount ||
      !v.aggregateSiteDates.every((date) => typeof date === "string" && date.length <= 64)) {
    throw new Error("Invalid status snapshot");
  }
  return value as StatusSnapshot;
}

/** One newest eligible observation per distinct site in the named aggregate cohort. */
export function corpusFreshnessCounts(dates: readonly string[], nowMs = Date.now()) {
  const counts = { current: 0, stale: 0, unknown: 0 };
  for (const date of dates) counts[freshnessState(date, PUBLIC_STATUS_MAX_CORPUS_AGE_MS, nowMs)]++;
  return counts;
}
