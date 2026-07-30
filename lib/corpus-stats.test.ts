import assert from "node:assert/strict";
import { test } from "node:test";
import { corpusCohortIdForIdentity } from "./corpus-cohort";
import {
  CORPUS_MIN_SAMPLE,
  type CorpusStats,
  type CorpusStatsCohort,
  corpusBenchmark,
  corpusIsUsable,
  isCorpusStats,
  selectCorpusStatsCohort
} from "./corpus-stats";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";

const LEGACY_CATALOG_DIGEST = "a".repeat(64);
const RECORDED_CATALOG_DIGEST = "b".repeat(64);

function canonicalCohort(cohort: Omit<CorpusStatsCohort, "id">): CorpusStatsCohort {
  return { id: corpusCohortIdForIdentity(cohort), ...cohort };
}

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

test("a cohort without the requested-GPC condition is refused, never read as split", () => {
  const cohort = canonicalCohort({
    schemaVersion: 1 as const,
    schemaRevision: null,
    methodologyVersion: "legacy",
    methodologyOrigin: "legacy-derived" as const,
    producer: null,
    gpc: true,
    trackerCatalogDigest: LEGACY_CATALOG_DIGEST,
    trackerCatalogOrigin: "legacy-metadata-hash" as const,
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    sampleSize: 60,
    latestRunAt: "2026-07-06T09:35:00.000Z",
    metrics: {}
  });
  const stats = {
    version: 3,
    generatedAt: "2026-07-25T00:00:00.000Z",
    sampleSize: 60,
    primaryCohortId: cohort.id,
    metrics: {},
    cohorts: [cohort]
  };
  assert.ok(isCorpusStats(stats));
  const { gpc, ...withoutGpc } = cohort;
  assert.equal(isCorpusStats({ ...stats, cohorts: [withoutGpc] }), false);
});

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
  corpus.version = 3;
  corpus.cohorts = [
    canonicalCohort({
      schemaVersion: 1,
      schemaRevision: null,
      methodologyVersion: "method-a",
      methodologyOrigin: "legacy-derived",
      producer: null,
      gpc: true,
      trackerCatalogDigest: LEGACY_CATALOG_DIGEST,
      trackerCatalogOrigin: "legacy-metadata-hash",
      serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
      serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
      sampleSize: 60,
      latestRunAt: "2026-07-06T09:35:00.000Z",
      metrics: corpus.metrics
    }),
    canonicalCohort({
      schemaVersion: 2,
      schemaRevision: 2,
      methodologyVersion: "method-b",
      methodologyOrigin: "recorded",
      producer: "node-playwright",
      gpc: true,
      trackerCatalogDigest: RECORDED_CATALOG_DIGEST,
      trackerCatalogOrigin: "recorded",
      serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
      serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
      sampleSize: 12,
      latestRunAt: "2026-07-14T00:00:00.000Z",
      metrics: {
        thirdPartyDomains: { count: 12, min: 1, max: 20, p50: 4, p75: 8, p90: 12, p95: 18 }
      }
    })
  ];
  corpus.primaryCohortId = corpus.cohorts[0].id;

  assert.equal(isCorpusStats(corpus), true);
  const selected = selectCorpusStatsCohort(corpus, corpus.cohorts[1].id);
  assert.equal(selected?.sampleSize, 12);
  assert.equal(selected?.metrics.thirdPartyDomains?.p50, 4);
  assert.equal(selectCorpusStatsCohort(corpus, "missing"), null);
  assert.equal(isCorpusStats({ ...corpus, cohorts: [{ ...corpus.cohorts![0], methodologyOrigin: "guessed" }] }), false);
  // Primary selection ranks on recency, so a cohort that cannot date itself
  // cannot be read as if it could.
  const { latestRunAt: _undated, ...undated } = corpus.cohorts![0];
  assert.equal(isCorpusStats({ ...corpus, cohorts: [undated] }), false);
});

test("incomplete pre-v3 cohort identities are refused rather than silently pooled", () => {
  const corpus = makeCorpus(60);
  corpus.version = 3;
  corpus.cohorts = [
    canonicalCohort({
      schemaVersion: 1,
      schemaRevision: null,
      methodologyVersion: "method",
      methodologyOrigin: "legacy-derived",
      producer: null,
      gpc: true,
      trackerCatalogDigest: LEGACY_CATALOG_DIGEST,
      trackerCatalogOrigin: "legacy-metadata-hash",
      serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
      serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
      sampleSize: 60,
      latestRunAt: "2026-07-06T09:35:00.000Z",
      metrics: corpus.metrics
    })
  ];
  corpus.primaryCohortId = corpus.cohorts[0].id;
  assert.equal(isCorpusStats(corpus), true);

  const { trackerCatalogDigest: _catalog, ...withoutCatalog } = corpus.cohorts[0];
  assert.equal(isCorpusStats({ ...corpus, cohorts: [withoutCatalog] }), false);
  const { serviceRoleTaxonomyDigest: _roles, ...withoutRoles } = corpus.cohorts[0];
  assert.equal(isCorpusStats({ ...corpus, cohorts: [withoutRoles] }), false);
  assert.equal(
    isCorpusStats({ ...corpus, cohorts: [{ ...corpus.cohorts[0], trackerCatalogDigest: "not-a-digest" }] }),
    false
  );

  // Artifact v2 cohort arrays never carried these fields. They remain
  // readable only as top-level compatibility artifacts, not as safe cohorts.
  assert.equal(isCorpusStats({ ...corpus, version: 2 }), false);
});

test("v3 refuses identity-key drift, duplicate cohort ids, and inconsistent primary projections", () => {
  const corpus = makeCorpus(60);
  const cohort = canonicalCohort({
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion: "method",
    methodologyOrigin: "legacy-derived",
    producer: null,
    gpc: true,
    trackerCatalogDigest: LEGACY_CATALOG_DIGEST,
    trackerCatalogOrigin: "legacy-metadata-hash",
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    sampleSize: 60,
    latestRunAt: "2026-07-06T09:35:00.000Z",
    metrics: corpus.metrics
  });
  const valid: CorpusStats = {
    ...corpus,
    version: 3,
    primaryCohortId: cohort.id,
    cohorts: [cohort]
  };
  assert.equal(isCorpusStats(valid), true);
  assert.equal(isCorpusStats({ ...valid, cohorts: [{ ...cohort, id: `${cohort.id}-wrong` }] }), false);
  assert.equal(isCorpusStats({ ...valid, cohorts: [cohort, { ...cohort }] }), false);
  assert.equal(isCorpusStats({ ...valid, primaryCohortId: `${cohort.id}-missing` }), false);
  assert.equal(isCorpusStats({ ...valid, sampleSize: 59 }), false);
  assert.equal(
    isCorpusStats({
      ...valid,
      metrics: {
        thirdPartyDomains: {
          ...(valid.metrics.thirdPartyDomains as NonNullable<typeof valid.metrics.thirdPartyDomains>),
          p50: 11
        }
      }
    }),
    false
  );
});

test("v3 rejects impossible schema, provenance, producer, and catalog-origin combinations", () => {
  const metrics = makeCorpus(60).metrics;
  const v1 = canonicalCohort({
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion: "legacy",
    methodologyOrigin: "legacy-derived",
    producer: null,
    gpc: true,
    trackerCatalogDigest: LEGACY_CATALOG_DIGEST,
    trackerCatalogOrigin: "legacy-metadata-hash",
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    sampleSize: 60,
    latestRunAt: "2026-07-06T09:35:00.000Z",
    metrics
  });
  const v2 = canonicalCohort({
    schemaVersion: 2,
    schemaRevision: 2,
    methodologyVersion: "current",
    methodologyOrigin: "recorded",
    producer: "node-playwright",
    gpc: true,
    trackerCatalogDigest: RECORDED_CATALOG_DIGEST,
    trackerCatalogOrigin: "recorded",
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    sampleSize: 60,
    latestRunAt: "2026-07-25T00:00:00.000Z",
    metrics
  });
  const artifactFor = (cohort: CorpusStatsCohort): CorpusStats => ({
    version: 3,
    generatedAt: "2026-07-25T00:00:00.000Z",
    sampleSize: cohort.sampleSize,
    primaryCohortId: cohort.id,
    cohorts: [cohort],
    metrics: cohort.metrics
  });
  const recanonicalize = (
    cohort: CorpusStatsCohort,
    changes: Partial<Omit<CorpusStatsCohort, "id">>
  ): CorpusStatsCohort => {
    const { id: _id, ...identity } = { ...cohort, ...changes };
    return canonicalCohort(identity);
  };

  assert.equal(isCorpusStats(artifactFor(v1)), true);
  assert.equal(isCorpusStats(artifactFor(v2)), true);

  for (const invalid of [
    recanonicalize(v1, { methodologyOrigin: "recorded" }),
    recanonicalize(v1, { producer: "node-playwright" }),
    recanonicalize(v1, { trackerCatalogOrigin: "recorded" }),
    recanonicalize(v2, { methodologyOrigin: "legacy-derived" }),
    recanonicalize(v2, { producer: null }),
    recanonicalize(v2, { producer: "" }),
    recanonicalize(v2, { trackerCatalogOrigin: "legacy-metadata-hash" })
  ]) {
    assert.equal(
      isCorpusStats(artifactFor(invalid)),
      false,
      `${invalid.schemaVersion}:${invalid.methodologyOrigin}:${String(invalid.producer)}:${invalid.trackerCatalogOrigin}`
    );
  }
});

test("isCorpusStats returns false rather than throwing for hostile values", () => {
  const metrics = makeCorpus(60).metrics;
  const cohort = canonicalCohort({
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion: "legacy",
    methodologyOrigin: "legacy-derived",
    producer: null,
    gpc: true,
    trackerCatalogDigest: LEGACY_CATALOG_DIGEST,
    trackerCatalogOrigin: "legacy-metadata-hash",
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    sampleSize: 60,
    latestRunAt: "2026-07-06T09:35:00.000Z",
    metrics
  });
  const valid: CorpusStats = {
    version: 3,
    generatedAt: "2026-07-25T00:00:00.000Z",
    sampleSize: cohort.sampleSize,
    primaryCohortId: cohort.id,
    cohorts: [cohort],
    metrics: cohort.metrics
  };
  const malformedUnicode = {
    ...valid,
    cohorts: [{ ...cohort, methodologyVersion: "\ud800" }]
  };
  const nonFiniteMetric = {
    ...valid,
    cohorts: [
      {
        ...cohort,
        metrics: {
          thirdPartyDomains: {
            count: 60,
            min: 0,
            max: Number.POSITIVE_INFINITY,
            p50: 10,
            p75: 20,
            p90: 40,
            p95: 60
          }
        }
      }
    ]
  };

  assert.doesNotThrow(() => isCorpusStats(malformedUnicode));
  assert.equal(isCorpusStats(malformedUnicode), false);
  assert.doesNotThrow(() => isCorpusStats(nonFiniteMetric));
  assert.equal(isCorpusStats(nonFiniteMetric), false);
});

test("isCorpusStats rejects invalid counts, dates, and distributions", () => {
  const validLegacy = makeCorpus(60);
  const validMetric = validLegacy.metrics.thirdPartyDomains as NonNullable<
    typeof validLegacy.metrics.thirdPartyDomains
  >;
  const cohort = canonicalCohort({
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion: "legacy",
    methodologyOrigin: "legacy-derived",
    producer: null,
    gpc: true,
    trackerCatalogDigest: LEGACY_CATALOG_DIGEST,
    trackerCatalogOrigin: "legacy-metadata-hash",
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    sampleSize: 60,
    latestRunAt: "2026-07-06T09:35:00.000Z",
    metrics: validLegacy.metrics
  });
  const validV3: CorpusStats = {
    ...validLegacy,
    version: 3,
    primaryCohortId: cohort.id,
    cohorts: [cohort]
  };

  for (const invalid of [
    { ...validLegacy, sampleSize: -1 },
    { ...validLegacy, sampleSize: Number.MAX_SAFE_INTEGER + 1 },
    { ...validLegacy, coverageSiteCount: -1 },
    { ...validLegacy, coverageSiteCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...validLegacy, cappedSiteCount: -1 },
    { ...validLegacy, cappedSiteCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...validLegacy, coverageSiteCount: validLegacy.sampleSize - 1 },
    {
      ...validLegacy,
      coverageSiteCount: validLegacy.sampleSize,
      cappedSiteCount: validLegacy.sampleSize + 1
    },
    { ...validLegacy, generatedAt: "not-a-date" },
    {
      ...validLegacy,
      metrics: { thirdPartyDomains: { ...validMetric, count: 0 } }
    },
    {
      ...validLegacy,
      metrics: { thirdPartyDomains: { ...validMetric, count: -1 } }
    },
    {
      ...validLegacy,
      metrics: {
        thirdPartyDomains: { ...validMetric, count: Number.MAX_SAFE_INTEGER + 1 }
      }
    },
    {
      ...validLegacy,
      metrics: { thirdPartyDomains: { ...validMetric, count: 61 } }
    },
    {
      ...validLegacy,
      metrics: { thirdPartyDomains: { ...validMetric, min: -1 } }
    },
    {
      ...validLegacy,
      metrics: { thirdPartyDomains: { ...validMetric, p50: 30, p75: 20 } }
    },
    {
      ...validV3,
      cohorts: [{ ...cohort, sampleSize: -1 }]
    },
    {
      ...validV3,
      cohorts: [{ ...cohort, sampleSize: Number.MAX_SAFE_INTEGER + 1 }]
    },
    {
      ...validV3,
      cohorts: [{ ...cohort, latestRunAt: "not-a-date" }]
    },
    {
      ...validV3,
      cohorts: [
        {
          ...cohort,
          metrics: { thirdPartyDomains: { ...validMetric, count: cohort.sampleSize + 1 } }
        }
      ]
    }
  ]) {
    assert.equal(isCorpusStats(invalid), false);
  }
});
