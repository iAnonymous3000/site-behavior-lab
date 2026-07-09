import type { ComparisonType } from "./types";

/**
 * "Changed since last scan" pairing for the corpus directory.
 *
 * Given the committed reports (one entry per report), pairs each site's NEWEST
 * report with its most recent predecessor OF THE SAME KIND and returns the
 * metric deltas. Kind matters because baselines mean different things across
 * report types: a Shields/GPC comparison leads with a pre-consent observe run,
 * while a consent comparison leads with the post-accept run, so mixing kinds
 * would report a mode change as a site change. Consent reports additionally
 * split by verified click state (`consentClicks`): a run where the banner was
 * actually clicked measures post-choice behavior, while an unclicked run only
 * observed the pre-consent state, so pairing the two would report the
 * interaction difference as a site change. Only the newest report per
 * (site, kind) gets a delta; a site with a single report of that kind gets
 * none.
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
  /** Verified consent-click state (see corpus-overview); keeps clicked and unclicked consent runs from pairing. */
  consentClicks?: string | null;
  thirdPartyRequests: number;
  trackerRequests: number;
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
    if (!entry.domain || !Number.isFinite(Date.parse(entry.scannedAt))) continue;
    const kind = entry.reportType === "comparison" ? entry.comparisonType ?? "comparison" : "single";
    const key = `${entry.domain.toLowerCase()}|${kind}${entry.consentClicks ? `|${entry.consentClicks}` : ""}`;
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

/** Signed display string for a delta ("+12", "-3", "no change"). */
export function formatDelta(value: number): string {
  if (value === 0) return "no change";
  return value > 0 ? `+${value.toLocaleString("en-US")}` : value.toLocaleString("en-US");
}
