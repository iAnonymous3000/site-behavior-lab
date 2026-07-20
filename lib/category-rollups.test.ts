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
    shieldsThirdPartyChange: null,
    ...partial
  };
}

test("buildCategoryRollups groups, medians, and orders heaviest category first", () => {
  const rollups = buildCategoryRollups([
    site({ category: "dating", categoryLabel: "Dating", trackerRequests: 40, thirdPartyRequests: 100, shieldsThirdPartyChange: -30 }),
    site({ category: "dating", categoryLabel: "Dating", trackerRequests: 60, thirdPartyRequests: 140, shieldsThirdPartyChange: -50 }),
    site({ category: "news", categoryLabel: "News & media", trackerRequests: 10, thirdPartyRequests: 30, shieldsThirdPartyChange: -5 })
  ]);

  assert.equal(rollups.length, 2);
  // Dating has the higher median trackers, so it ranks first.
  assert.equal(rollups[0].id, "dating");
  assert.equal(rollups[0].siteCount, 2);
  assert.equal(rollups[0].medianTrackers, 50); // median(40,60)
  assert.equal(rollups[0].medianShieldsChange, -40); // median(-30,-50)
  assert.equal(rollups[0].shieldsPairedSites, 2);
  assert.equal(rollups[0].shieldsDecreased, 2);
  assert.equal(rollups[1].id, "news");
  assert.equal(rollups[1].medianTrackers, 10);
});

test("buildCategoryRollups excludes uncategorized sites and reports null Shields median when absent", () => {
  const rollups = buildCategoryRollups([
    site({ category: "", categoryLabel: "Other", trackerRequests: 999 }),
    site({ category: "gov", categoryLabel: "Government", trackerRequests: 2, shieldsThirdPartyChange: null })
  ]);

  assert.equal(rollups.length, 1);
  assert.equal(rollups[0].id, "gov");
  assert.equal(rollups[0].medianShieldsChange, null);
  assert.equal(rollups[0].shieldsPairedSites, 0);
  assert.equal(rollups[0].shieldsDecreased, 0);
  assert.equal(rollups[0].shieldsFlat, 0);
  assert.equal(rollups[0].shieldsIncreased, 0);
});

test("cookie medians exclude unsupported or censored cookie families", () => {
  const rollups = buildCategoryRollups([
    site({ thirdPartyCookies: 8 }),
    site({ thirdPartyCookies: 2 }),
    site({ thirdPartyCookies: null })
  ]);

  assert.equal(rollups[0].siteCount, 3);
  assert.equal(rollups[0].cookieMeasuredSites, 2);
  assert.equal(rollups[0].medianCookies, 5);

  const unavailable = buildCategoryRollups([site({ thirdPartyCookies: null })]);
  assert.equal(unavailable[0].cookieMeasuredSites, 0);
  assert.equal(unavailable[0].medianCookies, null);
});

test("buildCategoryRollups keeps increased pairs signed and publishes the direction mix", () => {
  // Counterexample pin: an x.com-style pair that loads MORE third-party
  // requests with blocking on must pull the median as a positive value and be
  // counted as increased, never clamped to zero as "no reduction".
  const rollups = buildCategoryRollups([
    site({ category: "social", categoryLabel: "Search & social", trackerRequests: 5, shieldsThirdPartyChange: 264 }),
    site({ category: "social", categoryLabel: "Search & social", trackerRequests: 4, shieldsThirdPartyChange: -12 }),
    site({ category: "social", categoryLabel: "Search & social", trackerRequests: 3, shieldsThirdPartyChange: 0 }),
    site({ category: "social", categoryLabel: "Search & social", trackerRequests: 2, shieldsThirdPartyChange: null })
  ]);

  assert.equal(rollups.length, 1);
  const rollup = rollups[0];
  assert.equal(rollup.siteCount, 4);
  assert.equal(rollup.medianShieldsChange, 0); // median(-12, 0, 264)
  assert.equal(rollup.shieldsPairedSites, 3);
  assert.equal(rollup.shieldsDecreased, 1);
  assert.equal(rollup.shieldsFlat, 1);
  assert.equal(rollup.shieldsIncreased, 1);
});

test("buildCategoryRollups reports a positive median when increases dominate", () => {
  const rollups = buildCategoryRollups([
    site({ category: "social", categoryLabel: "Search & social", shieldsThirdPartyChange: 20 }),
    site({ category: "social", categoryLabel: "Search & social", shieldsThirdPartyChange: 8 }),
    site({ category: "social", categoryLabel: "Search & social", shieldsThirdPartyChange: -3 })
  ]);

  assert.equal(rollups[0].medianShieldsChange, 8);
  assert.equal(rollups[0].shieldsIncreased, 2);
  assert.equal(rollups[0].shieldsDecreased, 1);
});
