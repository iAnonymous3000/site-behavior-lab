import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadStatusSnapshot } from "./status-snapshot-server";
import { corpusFreshnessCounts, readStatusSnapshot } from "./status-snapshot";
import { PUBLIC_STATUS_MAX_CORPUS_AGE_MS } from "./public-status";

test("published status derives its counts and installed inputs from committed evidence", async () => {
  const snapshot = await loadStatusSnapshot();
  const lists = JSON.parse(readFileSync("lib/adblock-wasm/brave-default-filters.meta.json", "utf8"));
  const stats = JSON.parse(readFileSync("public/corpus-stats.json", "utf8"));
  assert.equal(snapshot.filterFetchedAt, lists.fetchedAt);
  assert.equal(snapshot.filterManifestDigest, lists.manifestDigest);
  assert.equal(snapshot.filterSourceCount, lists.sourceCount);
  assert.equal(snapshot.aggregateCohortId, stats.primaryCohortId);
  assert.equal(snapshot.siteCount, stats.sampleSize);
  assert.equal(snapshot.aggregateSiteDates.length, snapshot.siteCount);
  assert.ok(snapshot.v1ReportCount + snapshot.v2ReportCount > 0);
  assert.deepEqual(readStatusSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);

  for (const change of [
    { schemaVersion: 2 }, { siteCount: -1 }, { siteCount: snapshot.siteCount + 1 },
    { sourceRevision: "latest" }, { filterManifestDigest: "unverified" },
    { categoryCohortCount: null }, { newerEligibleOutsideAggregate: "yes" },
    { scanRankingSentence: "" }, { aggregateSiteDates: [null] }
  ]) assert.throws(() => readStatusSnapshot({ ...snapshot, ...change }));
  for (const absent of [null, [], {}, "offline"]) assert.throws(() => readStatusSnapshot(absent));
});

test("a fresh site cannot hide older, invalid, or future-dated observations", () => {
  const now = Date.parse("2026-09-07T12:00:00Z");
  const date = (offset: number) => new Date(now + offset).toISOString();
  assert.deepEqual(corpusFreshnessCounts([
    date(0), date(-PUBLIC_STATUS_MAX_CORPUS_AGE_MS),
    date(-PUBLIC_STATUS_MAX_CORPUS_AGE_MS - 1), "invalid", date(120_000)
  ], now), { current: 2, stale: 1, unknown: 2 });
  assert.deepEqual(corpusFreshnessCounts([], now), { current: 0, stale: 0, unknown: 0 });
});
