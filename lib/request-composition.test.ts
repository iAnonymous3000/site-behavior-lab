import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestComposition } from "./request-composition";
import type { TrackerMatch } from "./types";

const catalogMatch: TrackerMatch = {
  domain: "catalogued.example",
  entity: "Catalogued Example",
  category: "analytics",
  confidence: "curated"
};

test("request composition intersects third-party and catalog-match rows exactly", () => {
  const composition = buildRequestComposition({
    totalRequests: 4,
    thirdPartyRequests: 2,
    requests: [
      { thirdParty: false, tracker: catalogMatch },
      { thirdParty: false, tracker: null },
      { thirdParty: true, tracker: null },
      { thirdParty: true, tracker: catalogMatch }
    ]
  });

  assert.deepEqual(composition, {
    firstPartyRequests: 2,
    otherThirdPartyRequests: 1,
    catalogMatchedThirdPartyRequests: 1
  });
});

test("a first-party catalog match never consumes an unrelated third-party row", () => {
  const composition = buildRequestComposition({
    totalRequests: 2,
    thirdPartyRequests: 1,
    requests: [
      { thirdParty: false, tracker: catalogMatch },
      { thirdParty: true, tracker: null }
    ]
  });

  assert.deepEqual(composition, {
    firstPartyRequests: 1,
    otherThirdPartyRequests: 1,
    catalogMatchedThirdPartyRequests: 0
  });
});
