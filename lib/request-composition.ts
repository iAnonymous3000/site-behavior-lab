import type { NetworkRequestRecord } from "./types";

export type RequestComposition = {
  firstPartyRequests: number;
  otherThirdPartyRequests: number;
  catalogMatchedThirdPartyRequests: number;
};

/**
 * Partition the run's retained request rows for the report visualization.
 *
 * `knownTrackerRequests` is not a third-party count: it includes every direct
 * catalog match, including a first-party match when the scanned site itself is
 * in the catalog. Derive the overlapping third-party/catalog segment from the
 * request rows themselves so an unrelated third-party row can never inherit a
 * first-party catalog label.
 */
export function buildRequestComposition(input: {
  totalRequests: number;
  thirdPartyRequests: number;
  requests: Pick<NetworkRequestRecord, "thirdParty" | "tracker">[];
}): RequestComposition {
  const totalRequests = Math.max(0, input.totalRequests);
  const thirdPartyRequests = Math.min(Math.max(0, input.thirdPartyRequests), totalRequests);
  const rowCatalogMatchedThirdPartyRequests = input.requests.filter(
    (request) => request.thirdParty && request.tracker !== null
  ).length;
  // Valid report views make the row-derived intersection no larger than the
  // recorded third-party total. Keep the visual a partition even if a locally
  // constructed view violates that invariant.
  const catalogMatchedThirdPartyRequests = Math.min(
    rowCatalogMatchedThirdPartyRequests,
    thirdPartyRequests
  );

  return {
    firstPartyRequests: totalRequests - thirdPartyRequests,
    otherThirdPartyRequests: thirdPartyRequests - catalogMatchedThirdPartyRequests,
    catalogMatchedThirdPartyRequests
  };
}
