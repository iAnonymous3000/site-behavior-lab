import assert from "node:assert/strict";
import { test } from "node:test";
import { corpusCohortIdForIdentity } from "./corpus-cohort";
import {
  CORPUS_MIN_SAMPLE,
  type CorpusStats,
  type CorpusStatsCohort,
  type LegacyCorpusStatsCohort,
  corpusBenchmark,
  corpusIsUsable,
  isCorpusStats,
  selectCorpusStatsCohort
} from "./corpus-stats";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";

const LEGACY_CATALOG_DIGEST = "a".repeat(64);
const RECORDED_CATALOG_DIGEST = "b".repeat(64);

const METRIC_CONTRACT_IDENTITY = {
  metricContractVersion: METRIC_CONTRACT_VERSION,
  metricContractDigest: METRIC_CONTRACT_DIGEST
} as const;

function canonicalCohort(
  cohort: Omit<CorpusStatsCohort, "id" | "metricContractVersion" | "metricContractDigest">
): CorpusStatsCohort {
  const current = { ...cohort, ...METRIC_CONTRACT_IDENTITY };
  return { id: corpusCohortIdForIdentity(current), ...current };
}

function recanonicalizeCohort(
  cohort: CorpusStatsCohort,
  changes: Partial<
    Omit<CorpusStatsCohort, "id" | "metricContractVersion" | "metricContractDigest">
  >
): CorpusStatsCohort {
  const {
    id: _id,
    metricContractVersion: _metricContractVersion,
    metricContractDigest: _metricContractDigest,
    ...identity
  } = cohort;
  return canonicalCohort({ ...identity, ...changes });
}

function canonicalLegacyV3Cohort(
  cohort: Omit<LegacyCorpusStatsCohort, "id">
): LegacyCorpusStatsCohort {
  const schema =
    cohort.schemaVersion === 1 ? "v1" : `v2-r${cohort.schemaRevision}`;
  const producer = cohort.producer ?? "producer-unrecorded";
  const id =
    `${schema}:${encodeURIComponent(cohort.methodologyVersion)}:${encodeURIComponent(producer)}` +
    `:gpc-${cohort.gpc ? "on" : "off"}` +
    `:catalog-${cohort.trackerCatalogOrigin}-${cohort.trackerCatalogDigest}` +
    `:roles-${encodeURIComponent(cohort.serviceRoleTaxonomyVersion)}-${cohort.serviceRoleTaxonomyDigest}`;
  return { ...cohort, id };
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
    version: 4,
    generatedAt: "2026-07-25T00:00:00.000Z",
    ...METRIC_CONTRACT_IDENTITY,
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
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 5)?.level, "info"); // below p50, still observed
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 12)?.level, "info"); // >= p50
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 25)?.level, "warn"); // >= p75
  assert.equal(corpusBenchmark(corpus, "thirdPartyDomains", 40)?.level, "loud"); // >= p90

  // Tie-safe wording: anchored to the percentile mark itself, never "more
  // than 90% of sites" (which heavy ties can make false).
  const loud = corpusBenchmark(corpus, "thirdPartyDomains", 50);
  assert.match(loud?.label ?? "", /At or above the 90th-percentile mark for .* across the 200 sites measured for this metric/);
});

// The findings board reads "quiet" as a NULL RESULT: it is the level a flat
// comparison delta or an absent-provenance note carries, and the bottom-line
// summary keeps its green "few review signals" verdict over a board whose
// strongest level is quiet. That is only sound while no benchmark ranks a
// value the visit actually observed as "quiet".
//
// It was not sound. corpusBenchmark returned "quiet" for any count in
// [1, p50), so a report with one below-median third-party cookie published
// "The automated visit did not observe ... third-party cookies" directly above
// a card titled "Third-party cookies were present", and the bottom-line icon
// flipped from green to red once corpus-stats.json finished loading, because
// the fixed-threshold fallback calls the same value "info".
//
// Sweep the whole positive domain rather than sampling bands, so a future
// reordering of the comparisons cannot reopen a gap between them.
test("a count the visit observed is never ranked quiet", () => {
  const corpus = makeCorpus(200);
  const distribution = corpus.metrics.thirdPartyDomains;
  assert.ok(distribution, "the sweep needs a distribution to range over");

  assert.equal(
    corpusBenchmark(corpus, "thirdPartyDomains", 0)?.level,
    "ok",
    "zero is the only absence, and absence is 'ok', not 'quiet'"
  );

  const observedLevels = new Set<string>();
  for (let value = 1; value <= distribution.p90 + 10; value += 1) {
    const level = corpusBenchmark(corpus, "thirdPartyDomains", value)?.level;
    assert.notEqual(
      level,
      "quiet",
      `a visit that observed ${value} third-party domains must not rank as a null result`
    );
    observedLevels.add(String(level));
  }

  // Mutation guard: if this sweep ever stops covering more than one band the
  // assertion above becomes near-vacuous, so prove it exercised the real
  // ladder rather than one repeated value.
  assert.deepEqual(
    [...observedLevels].sort(),
    ["info", "loud", "warn"],
    "the sweep must cross every positive band"
  );
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

test("metric keys are fail-closed and version-specific", () => {
  const legacy = makeCorpus(60);
  assert.equal(
    isCorpusStats({ ...legacy, metrics: { ...legacy.metrics, inventedMetric: legacy.metrics.thirdPartyDomains } }),
    false,
    "v1 refuses undeclared metric names"
  );
  assert.equal(
    isCorpusStats({
      ...legacy,
      metrics: { ...legacy.metrics, trackingServiceRequests: legacy.metrics.thirdPartyDomains }
    }),
    false,
    "v1 cannot be relabeled as if it carried the v4 formula"
  );

  const metrics = {
    thirdPartyRequests: legacy.metrics.thirdPartyDomains,
    thirdPartyDomains: legacy.metrics.thirdPartyDomains,
    cataloguedServiceRequests: legacy.metrics.thirdPartyDomains,
    trackingServiceRequests: legacy.metrics.thirdPartyDomains
  };
  const cohort = canonicalCohort({
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion: "method-v4",
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
  const current: CorpusStats = {
    version: 4,
    generatedAt: "2026-07-30T00:00:00.000Z",
    ...METRIC_CONTRACT_IDENTITY,
    sampleSize: 60,
    primaryCohortId: cohort.id,
    cohorts: [cohort],
    metrics
  };
  assert.equal(isCorpusStats(current), true);
  assert.equal(
    isCorpusStats({
      ...current,
      metrics: { ...current.metrics, knownTrackerRequests: legacy.metrics.thirdPartyDomains }
    }),
    false,
    "v4 refuses the retired ambiguous stats key"
  );
  assert.equal(
    isCorpusStats({
      ...current,
      cohorts: [
        {
          ...cohort,
          metrics: { ...cohort.metrics, inventedMetric: legacy.metrics.thirdPartyDomains }
        }
      ]
    }),
    false,
    "cohort metrics use the same closed v4 key set"
  );
  assert.equal(
    isCorpusStats({ ...current, futureTopLevelField: true }),
    false,
    "v4 rejects undeclared top-level fields"
  );
  assert.equal(
    isCorpusStats({
      ...current,
      cohorts: [{ ...cohort, futureCohortField: true }]
    }),
    false,
    "v4 rejects undeclared cohort fields"
  );
  const distributionWithExtraField = {
    ...metrics.thirdPartyDomains,
    p99: 100
  };
  const metricsWithExtraDistributionField = {
    ...metrics,
    thirdPartyDomains: distributionWithExtraField
  };
  assert.equal(
    isCorpusStats({
      ...current,
      metrics: metricsWithExtraDistributionField,
      cohorts: [{ ...cohort, metrics: metricsWithExtraDistributionField }]
    }),
    false,
    "v4 rejects undeclared distribution fields"
  );
  const {
    trackingServiceRequests: _omittedTrackingMetric,
    ...requestMetricSubset
  } = current.metrics;
  assert.equal(
    isCorpusStats({
      ...current,
      metrics: requestMetricSubset,
      cohorts: [
        {
          ...cohort,
          metrics: requestMetricSubset
        }
      ]
    }),
    false,
    "v4 request distributions are all present or all absent"
  );
  const impossibleTrackingDistribution = {
    ...(metrics.trackingServiceRequests as NonNullable<
      typeof metrics.trackingServiceRequests
    >),
    max: 101
  };
  assert.equal(
    isCorpusStats({
      ...current,
      metrics: {
        ...current.metrics,
        trackingServiceRequests: impossibleTrackingDistribution
      },
      cohorts: [
        {
          ...cohort,
          metrics: {
            ...cohort.metrics,
            trackingServiceRequests: impossibleTrackingDistribution
          }
        }
      ]
    }),
    false,
    "a tracking-service order statistic cannot exceed its containing request metrics"
  );
  const mismatchedTrackingDenominator = {
    ...(metrics.trackingServiceRequests as NonNullable<
      typeof metrics.trackingServiceRequests
    >),
    count: 59
  };
  assert.equal(
    isCorpusStats({
      ...current,
      metrics: {
        ...current.metrics,
        trackingServiceRequests: mismatchedTrackingDenominator
      },
      cohorts: [
        {
          ...cohort,
          metrics: {
            ...cohort.metrics,
            trackingServiceRequests: mismatchedTrackingDenominator
          }
        }
      ]
    }),
    false,
    "current request distributions share one denominator"
  );

  for (const dependencyDrift of [
    recanonicalizeCohort(cohort, {
      serviceRoleTaxonomyVersion: `${SERVICE_ROLE_TAXONOMY_VERSION}-other`
    }),
    recanonicalizeCohort(cohort, {
      serviceRoleTaxonomyDigest: "c".repeat(64)
    })
  ]) {
    assert.equal(
      isCorpusStats({
        ...current,
        primaryCohortId: dependencyDrift.id,
        cohorts: [dependencyDrift],
        metrics: dependencyDrift.metrics
      }),
      false,
      "v4 cohorts must use the ServiceRole dependency pinned by metric-contract-v1"
    );
  }

  const blankMethodology = recanonicalizeCohort(cohort, {
    methodologyVersion: " \t "
  });
  assert.equal(
    isCorpusStats({
      ...current,
      primaryCohortId: blankMethodology.id,
      cohorts: [blankMethodology],
      metrics: blankMethodology.metrics
    }),
    false,
    "a syntactically canonical v4 cohort still requires a nonblank methodology"
  );
});

test("the frozen v3 reader accepts only its legacy metric vocabulary", () => {
  const distribution = makeCorpus(60).metrics.thirdPartyDomains;
  const cohort = canonicalLegacyV3Cohort({
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
    metrics: { knownTrackerRequests: distribution }
  });
  const stats = {
    version: 3,
    generatedAt: "2026-07-25T00:00:00.000Z",
    sampleSize: 60,
    primaryCohortId: cohort.id,
    cohorts: [cohort],
    metrics: cohort.metrics
  };
  assert.equal(isCorpusStats(stats), true);
  assert.equal(
    isCorpusStats({
      ...stats,
      metrics: { trackingServiceRequests: distribution },
      cohorts: [{ ...cohort, metrics: { trackingServiceRequests: distribution } }]
    }),
    false
  );
  assert.equal(isCorpusStats({ ...stats, metricContractVersion: METRIC_CONTRACT_VERSION }), false);
  assert.equal(
    isCorpusStats({ ...stats, futureTopLevelField: true }),
    false,
    "v3 rejects undeclared top-level fields"
  );
  assert.equal(
    isCorpusStats({
      ...stats,
      cohorts: [{ ...cohort, futureCohortField: true }]
    }),
    false,
    "v3 rejects undeclared cohort fields"
  );
  const distributionWithExtraField = {
    ...distribution,
    p99: 100
  };
  const metricsWithExtraDistributionField = {
    knownTrackerRequests: distributionWithExtraField
  };
  assert.equal(
    isCorpusStats({
      ...stats,
      metrics: metricsWithExtraDistributionField,
      cohorts: [{ ...cohort, metrics: metricsWithExtraDistributionField }]
    }),
    false,
    "v3 rejects undeclared distribution fields"
  );

  const blankMethodology = canonicalLegacyV3Cohort({
    ...cohort,
    methodologyVersion: " \n "
  });
  assert.equal(
    isCorpusStats({
      ...stats,
      primaryCohortId: blankMethodology.id,
      cohorts: [blankMethodology],
      metrics: blankMethodology.metrics
    }),
    false,
    "a syntactically canonical v3 cohort still requires a nonblank methodology"
  );

  const blankServiceRole = canonicalLegacyV3Cohort({
    ...cohort,
    serviceRoleTaxonomyVersion: " \t "
  });
  assert.equal(
    isCorpusStats({
      ...stats,
      primaryCohortId: blankServiceRole.id,
      cohorts: [blankServiceRole],
      metrics: blankServiceRole.metrics
    }),
    false,
    "a syntactically canonical v3 cohort still requires a nonblank ServiceRole version"
  );

  const blankProducer = canonicalLegacyV3Cohort({
    ...cohort,
    schemaVersion: 2,
    schemaRevision: 2,
    methodologyVersion: "recorded",
    methodologyOrigin: "recorded",
    producer: " \n ",
    trackerCatalogDigest: RECORDED_CATALOG_DIGEST,
    trackerCatalogOrigin: "recorded"
  });
  assert.equal(
    isCorpusStats({
      ...stats,
      primaryCohortId: blankProducer.id,
      cohorts: [blankProducer],
      metrics: blankProducer.metrics
    }),
    false,
    "a syntactically canonical v3 v2 cohort still requires a nonblank producer"
  );
});

test("the origin/main v3 primary projection remains compatible", () => {
  const metrics = {
    thirdPartyRequests: {
      count: 69,
      min: 0,
      max: 382,
      p50: 14,
      p75: 56,
      p90: 162,
      p95: 185
    },
    thirdPartyDomains: {
      count: 69,
      min: 0,
      max: 59,
      p50: 3,
      p75: 9,
      p90: 24,
      p95: 29
    },
    knownTrackerRequests: {
      count: 69,
      min: 0,
      max: 152,
      p50: 1,
      p75: 10,
      p90: 29,
      p95: 36
    },
    thirdPartyCookies: {
      count: 69,
      min: 0,
      max: 36,
      p50: 0,
      p75: 0,
      p90: 5,
      p95: 19
    },
    fingerprintEvents: {
      count: 69,
      min: 0,
      max: 122,
      p50: 0,
      p75: 0,
      p90: 2,
      p95: 8
    }
  };
  const cohort = canonicalLegacyV3Cohort({
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion:
      "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.61.1",
    methodologyOrigin: "legacy-derived",
    producer: null,
    gpc: true,
    trackerCatalogDigest:
      "c015b2fb2d86a8aa1e015c740cb967f433f4c6301c0f4a010592f41f30945593",
    trackerCatalogOrigin: "legacy-metadata-hash",
    serviceRoleTaxonomyVersion: "service-role-taxonomy-v1",
    serviceRoleTaxonomyDigest:
      "dfccf71d4119c154e71bf7908dd2914557e8fc981951941594b16b00b712ed67",
    sampleSize: 69,
    latestRunAt: "2026-07-25T18:23:27.733Z",
    metrics
  });

  assert.equal(
    isCorpusStats({
      version: 3,
      generatedAt: "2026-07-30T20:07:46.186Z",
      sampleSize: 69,
      coverageSiteCount: 99,
      cappedSiteCount: 3,
      primaryCohortId: cohort.id,
      cohorts: [cohort],
      metrics
    }),
    true
  );
});

test("methodology cohorts validate and can be selected without pooling", () => {
  const corpus = makeCorpus(60);
  corpus.version = 4;
  Object.assign(corpus, METRIC_CONTRACT_IDENTITY);
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

test("incomplete v4 cohort identities are refused rather than silently pooled", () => {
  const corpus = makeCorpus(60);
  corpus.version = 4;
  Object.assign(corpus, METRIC_CONTRACT_IDENTITY);
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

test("v4 refuses identity-key drift, duplicate cohort ids, and inconsistent primary projections", () => {
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
    version: 4,
    ...METRIC_CONTRACT_IDENTITY,
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

test("v4 rejects impossible schema, provenance, producer, and catalog-origin combinations", () => {
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
    version: 4,
    generatedAt: "2026-07-25T00:00:00.000Z",
    ...METRIC_CONTRACT_IDENTITY,
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
    recanonicalize(v2, { producer: " \t " }),
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
    version: 4,
    generatedAt: "2026-07-25T00:00:00.000Z",
    ...METRIC_CONTRACT_IDENTITY,
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
  const validV4: CorpusStats = {
    ...validLegacy,
    version: 4,
    ...METRIC_CONTRACT_IDENTITY,
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
      metrics: { thirdPartyDomains: { ...validMetric, p50: 10.5 } }
    },
    {
      ...validLegacy,
      metrics: { thirdPartyDomains: { ...validMetric, p50: 30, p75: 20 } }
    },
    {
      ...validV4,
      cohorts: [{ ...cohort, sampleSize: -1 }]
    },
    {
      ...validV4,
      cohorts: [{ ...cohort, sampleSize: Number.MAX_SAFE_INTEGER + 1 }]
    },
    {
      ...validV4,
      cohorts: [{ ...cohort, latestRunAt: "not-a-date" }]
    },
    {
      ...validV4,
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
