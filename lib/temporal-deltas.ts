import { safeParseUrl } from "./report-url";
import type { ComparisonType } from "./types";

/**
 * "Changed since last scan" pairing for the corpus directory.
 *
 * Given the committed reports (one entry per report), pairs each site's NEWEST
 * report with its most recent predecessor OF THE SAME KIND, SUBJECT, AND
 * VERSIONED MEASUREMENT/CONDITION COHORT and returns the metric deltas. Kind
 * matters because baselines mean different things across
 * report types: a Shields/GPC comparison leads with a pre-consent observe run,
 * while a consent comparison leads with the accept-all run (a visit whose
 * recording spans the dispatched accept click), so mixing kinds would report a
 * mode change as a site change. Consent reports additionally split by
 * dispatched click state (`consentClicks`): a visit where a banner click was
 * dispatched is a different kind of observation than an unclicked visit
 * (which only saw the pre-consent state), so pairing the two would report the
 * interaction difference as a site change. Only the newest report per
 * (site, kind) gets a delta; a site with a single report of that kind gets
 * none. Unknown cohort facts never match another unknown.
 *
 * Deltas are observed differences between two automated visits: they can
 * reflect ad rotation, experiments, caching, or bot detection as well as a
 * real site change, and the UI copy must keep saying so.
 *
 * Pure (types only) so it unit-tests directly; the server-side corpus loader
 * feeds it manifest-level fields.
 */

export type TemporalDeltaInput = {
  id: string;
  /** Normalized site key (the headline domain, www stripped). */
  domain: string;
  scannedAt: string;
  reportType: "single" | "comparison";
  comparisonType?: ComparisonType;
  /** Dispatched consent-click state (see corpus-overview); keeps clicked and unclicked consent runs from pairing. */
  consentClicks?: string | null;
  /**
   * Lead run's requested and final URLs. A "since last scan" delta compares
   * one subject over time, so both must match: a scan of my.gov.au/ and a
   * scan that REDIRECTED to my.gov.au/en/services observed different pages,
   * even though their final domains agree.
   */
  requestedUrl: string;
  finalUrl: string;
  thirdPartyRequests: number;
  trackerRequests: number;
  /**
   * Complete, versioned measurement + condition cohort. Null means the
   * recorded setup is unprovable; unknown never matches unknown.
   */
  temporalCohort: string | null;
};

export type SinceLastScan = {
  previousId: string;
  previousScannedAt: string;
  /** Current minus previous. */
  thirdPartyRequests: number;
  trackerRequests: number;
};

export type ComparisonHistoryDeltaInput = Pick<
  TemporalDeltaInput,
  "id" | "scannedAt" | "thirdPartyRequests" | "trackerRequests"
> & {
  /** Precomputed, versioned passive-history identity; null never pairs. */
  comparisonHistoryKey: string | null;
};

type TemporalPairingIdentity = Pick<
  TemporalDeltaInput,
  | "domain"
  | "reportType"
  | "comparisonType"
  | "consentClicks"
  | "requestedUrl"
  | "finalUrl"
  | "temporalCohort"
>;

/**
 * Exact identity shared by automatic history and retention protection. A
 * null cohort is unmatchable, so unknown never equals unknown.
 */
export function temporalPairingKey(entry: TemporalPairingIdentity): string | null {
  if (!entry.domain || !entry.temporalCohort) return null;
  const kind = entry.reportType === "comparison" ? entry.comparisonType ?? "comparison" : "single";
  return `${entry.temporalCohort}|${entry.domain.toLowerCase()}|${kind}${entry.consentClicks ? `|${entry.consentClicks}` : ""}|${normalizedRouteKey(
    entry.requestedUrl
  )}|${normalizedRouteKey(entry.finalUrl)}`;
}

type ComparisonHistoryPairingIdentity = Omit<TemporalPairingIdentity, "temporalCohort"> & {
  comparisonHistoryCohort: string | null;
};

/**
 * Separate identity for descriptive passive-history comparisons. This must
 * never replace `temporalPairingKey`: retention continues to use the strict
 * identity above, including the exact filter snapshot. The relaxed cohort is
 * produced only after success/cap/provenance checks and omits that one field.
 */
export function comparisonHistoryPairingKey(entry: ComparisonHistoryPairingIdentity): string | null {
  if (!entry.domain || !entry.comparisonHistoryCohort) return null;
  const kind = entry.reportType === "comparison" ? entry.comparisonType ?? "comparison" : "single";
  return `comparison-history-key-v1|${entry.comparisonHistoryCohort}|${entry.domain.toLowerCase()}|${kind}${
    entry.consentClicks ? `|${entry.consentClicks}` : ""
  }|${normalizedRouteKey(entry.requestedUrl)}|${normalizedRouteKey(entry.finalUrl)}`;
}

/** Map of report id (the newest per site and kind) to its since-last-scan delta. */
export function computeSinceLastScan(entries: TemporalDeltaInput[]): Map<string, SinceLastScan> {
  return computeDeltas(entries, temporalPairingKey);
}

/**
 * "Since last comparable visit" deltas for site profiles. Inputs carry the
 * exact same versioned key published in the manifest, so archive grouping and
 * profile calculations cannot silently use different cohort rules.
 */
export function computeComparableSinceLastScan(
  entries: ComparisonHistoryDeltaInput[]
): Map<string, SinceLastScan> {
  return computeDeltas(entries, (entry) => entry.comparisonHistoryKey);
}

function computeDeltas<T extends Pick<TemporalDeltaInput, "id" | "scannedAt" | "thirdPartyRequests" | "trackerRequests">>(
  entries: T[],
  keyFor: (entry: T) => string | null
): Map<string, SinceLastScan> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    if (!Number.isFinite(Date.parse(entry.scannedAt))) continue;
    const key = keyFor(entry);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const deltas = new Map<string, SinceLastScan>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => Date.parse(b.scannedAt) - Date.parse(a.scannedAt) || a.id.localeCompare(b.id));
    const [current, previous] = group;
    deltas.set(current.id, {
      previousId: previous.id,
      previousScannedAt: previous.scannedAt,
      thirdPartyRequests: current.thirdPartyRequests - previous.thirdPartyRequests,
      trackerRequests: current.trackerRequests - previous.trackerRequests
    });
  }

  return deltas;
}

/**
 * Trailing-slash-insensitive route key for subject pairing. Only the scheme
 * and host are case-folded: URL paths are case-sensitive, so lowercasing the
 * whole URL would pair /About with /about, two routes a site may serve
 * differently.
 */
function normalizedRouteKey(url: string): string {
  const trimmed = url.trim();
  const parsed = safeParseUrl(trimmed);
  if (!parsed) return trimmed;
  // URL lowercases scheme and hostname itself; path/query keep their case.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
}

/** Signed display string for a delta ("+12", "-3", "no change"). */
export function formatDelta(value: number): string {
  if (value === 0) return "no change";
  return value > 0 ? `+${value.toLocaleString("en-US")}` : value.toLocaleString("en-US");
}
