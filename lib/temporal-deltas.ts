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

/** Map of report id (the newest per site and kind) to its since-last-scan delta. */
export function computeSinceLastScan(entries: TemporalDeltaInput[]): Map<string, SinceLastScan> {
  const groups = new Map<string, TemporalDeltaInput[]>();
  for (const entry of entries) {
    if (!entry.domain || !entry.temporalCohort || !Number.isFinite(Date.parse(entry.scannedAt))) continue;
    const kind = entry.reportType === "comparison" ? entry.comparisonType ?? "comparison" : "single";
    // The pairing key is the SUBJECT, not just the site: requested and final
    // routes must both match, so a direct scan never pairs with a scan that
    // redirected to a different landing page.
    const key = `${entry.temporalCohort}|${entry.domain.toLowerCase()}|${kind}${entry.consentClicks ? `|${entry.consentClicks}` : ""}|${normalizedRouteKey(
      entry.requestedUrl
    )}|${normalizedRouteKey(entry.finalUrl)}`;
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
  const trimmed = url.trim().replace(/\/+$/, "");
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
