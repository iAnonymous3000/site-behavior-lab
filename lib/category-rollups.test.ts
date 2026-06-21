import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCategoryRollups, median, type RollupSite } from "./category-rollups";

test("median handles empty, odd, and even lengths", () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // (2+3)/2 = 2.5 -> rounds to 3
});

function site(partial: Partial<RollupSite>): RollupSite {
  return {
    category: "news",
    categoryLabel: "News & media",
    trackerRequests: 0,
    thirdPartyRequests: 0,
    thirdPartyCookies: 0,
    shieldsBlocked: null,
    ...partial
  };
}

test("buildCategoryRollups groups, medians, and orders heaviest category first", () => {
  const rollups = buildCategoryRollups([
    site({ category: "dating", categoryLabel: "Dating", trackerRequests: 40, thirdPartyRequests: 100, shieldsBlocked: 30 }),
    site({ category: "dating", categoryLabel: "Dating", trackerRequests: 60, thirdPartyRequests: 140, shieldsBlocked: 50 }),
    site({ category: "news", categoryLabel: "News & media", trackerRequests: 10, thirdPartyRequests: 30, shieldsBlocked: 5 })
  ]);

  assert.equal(rollups.length, 2);
  // Dating has the higher median trackers, so it ranks first.
  assert.equal(rollups[0].id, "dating");
  assert.equal(rollups[0].siteCount, 2);
  assert.equal(rollups[0].medianTrackers, 50); // median(40,60)
  assert.equal(rollups[0].medianShieldsBlocked, 40); // median(30,50)
  assert.equal(rollups[1].id, "news");
  assert.equal(rollups[1].medianTrackers, 10);
});

test("buildCategoryRollups excludes uncategorized sites and reports null Shields median when absent", () => {
  const rollups = buildCategoryRollups([
    site({ category: "", categoryLabel: "Other", trackerRequests: 999 }),
    site({ category: "gov", categoryLabel: "Government", trackerRequests: 2, shieldsBlocked: null })
  ]);

  assert.equal(rollups.length, 1);
  assert.equal(rollups[0].id, "gov");
  assert.equal(rollups[0].medianShieldsBlocked, null);
});
