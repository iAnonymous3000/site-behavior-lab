import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CORPUS_MIN_SAMPLE,
  type CorpusStats,
  corpusBenchmark,
  corpusIsUsable,
  isCorpusStats,
  selectCorpusStatsCohort
} from "./corpus-stats";

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

  const sparseMetric = makeCorpus(CORPUS_MIN_SAMPLE);
  sparseMetric.metrics.thirdPartyDomains = {
    count: CORPUS_MIN_SAMPLE - 1,
    min: 0,
    max: 100,
    p50: 10,
    p75: 20,
    p90: 40,
    p95: 60
  };
  assert.equal(
    corpusBenchmark(sparseMetric, "thirdPartyDomains", 99),
    null,
    "the cohort size cannot substitute for a metric-specific denominator"
  );
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
  assert.match(loud?.label ?? "", /At or above the 90th-percentile mark for .* across the 200 sites measured for this metric/);
});

test("corpusBenchmark names the metric denominator rather than the broader cohort size", () => {
  const corpus = makeCorpus(200);
  corpus.metrics.thirdPartyDomains = {
    ...(corpus.metrics.thirdPartyDomains as NonNullable<typeof corpus.metrics.thirdPartyDomains>),
    count: 75
  };
  assert.match(
    corpusBenchmark(corpus, "thirdPartyDomains", 50)?.label ?? "",
    /across the 75 sites measured for this metric/
  );
  assert.doesNotMatch(corpusBenchmark(corpus, "thirdPartyDomains", 50)?.label ?? "", /200/);
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
  assert.equal(isCorpusStats({ ...makeCorpus(100), coverageSiteCount: 120, cappedSiteCount: 3 }), true);
  assert.equal(isCorpusStats({ ...makeCorpus(100), cappedSiteCount: "3" }), false);
  assert.equal(isCorpusStats({ version: 1, generatedAt: "x", sampleSize: 1, metrics: { thirdPartyDomains: { count: 1 } } }), false);
  assert.equal(isCorpusStats({ version: 1, sampleSize: 1 }), false);
  assert.equal(isCorpusStats(null), false);
});

test("methodology cohorts validate and can be selected without pooling", () => {
  const corpus = makeCorpus(60);
  corpus.version = 2;
  corpus.primaryCohortId = "v1:method-a:producer-unrecorded";
  corpus.cohorts = [
    {
      id: "v1:method-a:producer-unrecorded",
      schemaVersion: 1,
      schemaRevision: null,
      methodologyVersion: "method-a",
      methodologyOrigin: "legacy-derived",
      producer: null,
      sampleSize: 60,
      metrics: corpus.metrics
    },
    {
      id: "v2-r2:method-b:node-playwright",
      schemaVersion: 2,
      schemaRevision: 2,
      methodologyVersion: "method-b",
      methodologyOrigin: "recorded",
      producer: "node-playwright",
      sampleSize: 12,
      metrics: {
        thirdPartyDomains: { count: 12, min: 1, max: 20, p50: 4, p75: 8, p90: 12, p95: 18 }
      }
    }
  ];

  assert.equal(isCorpusStats(corpus), true);
  const selected = selectCorpusStatsCohort(corpus, "v2-r2:method-b:node-playwright");
  assert.equal(selected?.sampleSize, 12);
  assert.equal(selected?.metrics.thirdPartyDomains?.p50, 4);
  assert.equal(selectCorpusStatsCohort(corpus, "missing"), null);
  assert.equal(isCorpusStats({ ...corpus, cohorts: [{ ...corpus.cohorts[0], methodologyOrigin: "guessed" }] }), false);
});
