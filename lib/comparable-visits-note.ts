import {
  COMPARISON_HISTORY_IDENTITY_SENTENCES,
  type ComparisonHistoryEra
} from "./comparison-history-copy";

/**
 * The site profile's "Comparable visits" method note for one era of pairs.
 *
 * The opening identity sentence is the shared constant the archive gallery
 * also renders, so the two surfaces cannot state different pairing rules for
 * the same era. The middle sentence states what that identity still leaves
 * free to drift, which differs by era: the v1 key binds the Brave-list source
 * and list count and omits only the snapshot date, while the v2/r2 key omits
 * the ad-block source, list count and snapshot entirely because the
 * tracker-classification evaluator never reads them. Kept separate from
 * lib/comparison-history-copy.ts so this server-only copy never joins the
 * gallery's client bundle.
 */
export function siteProfileComparableVisitsNote(era: ComparisonHistoryEra): string {
  const caveat =
    "Differences can still reflect site experiments, ad rotation, caching or bot detection.";
  if (era === "v2") {
    return (
      `${COMPARISON_HISTORY_IDENTITY_SENTENCES.v2} The pairing identity deliberately omits the ` +
      "ad-block source, list count and snapshot, because this timeline reports tracker " +
      "classification and that evaluator never reads them. So these are not Shields or detector " +
      "changes, and a difference here is not evidence that blocking behaviour changed. " +
      caveat
    );
  }
  return (
    `${COMPARISON_HISTORY_IDENTITY_SENTENCES.v1} It does not hold the filter-list snapshot date ` +
    "constant: a changed snapshot can support raw and catalogued-service differences, but never " +
    "a Shields or detector delta, so a difference here is not evidence that blocking behaviour " +
    "changed. " +
    caveat
  );
}
