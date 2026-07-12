import assert from "node:assert/strict";
import { test } from "node:test";
import { CORPUS_MIN_SAMPLE, type CorpusStats, corpusBenchmark, corpusIsUsable, isCorpusStats } from "./corpus-stats";

function makeCorpus(sampleSize: number): CorpusStats {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    sampleSize,
    metrics: {
      thirdPartyDomains: { count: sampleSize, min: 0, max: 100, p50: 10, p75: 20, p90: 40, p95: 60 }
    }
  };
}

test("the honesty gate blocks percentile claims below the minimum sample", () => {
  assert.equal(corpusIsUsable(null), false);
  assert.equal(corpusIsUsable(makeCorpus(CORPUS_MIN_SAMPLE - 1)), false);
  assert.equal(corpusIsUsable(makeCorpus(CORPUS_MIN_SAMPLE)), true);
  assert.equal(corpusBenchmark(makeCorpus(4), "thirdPartyDomains", 99), null);
});

test("corpusBenchmark maps values to percentile bands once the corpus is usable", () => {
  const corpus = makeCorpus(200);
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 0)?.level, "ok");
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 5)?.level, "quiet"); // below p50
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 12)?.level, "info"); // >= p50
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 25)?.level, "warn"); // >= p75
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 40)?.level, "loud"); // >= p90

  // Tie-safe wording: anchored to the percentile mark itself, never "more
  // than 90% of sites" (which heavy ties can make false).
  const loud = corpusBenchmark(corpus, "thirdPartyDomains", 50);
  assert.match(loud?.label ?? "", /At or above the 90th-percentile mark for .* across the 200 fully measured sites/);
});

test("corpusBenchmark returns null for metrics without a distribution", () => {
  assert.equal(corpusBenchmark(makeCorpus(200), "thirdPartyCookies", 10), null);
});

test("the catalogued-service metric is never labeled as tracker requests", () => {
  // summary.knownTrackerRequests counts every catalogued match, operational
  // services included, so percentile sentences must not call them all trackers.
  const corpus = makeCorpus(200);
  corpus.metrics.knownTrackerRequests = corpus.metrics.thirdPartyDomains;
  const benchmark = corpusBenchmark(corpus, "knownTrackerRequests", 50);
  assert.match(benchmark?.label ?? "", /catalogued-service requests/);
  assert.doesNotMatch(benchmark?.label ?? "", /tracker/);
});

test("isCorpusStats validates shape", () => {
  assert.equal(isCorpusStats(makeCorpus(100)), true);
  assert.equal(isCorpusStats({ version: 1, generatedAt: "x", sampleSize: 1, metrics: { thirdPartyDomains: { count: 1 } } }), false);
  assert.equal(isCorpusStats({ version: 1, sampleSize: 1 }), false);
  assert.equal(isCorpusStats(null), false);
});
