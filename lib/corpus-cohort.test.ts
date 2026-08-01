import assert from "node:assert/strict";
import test from "node:test";
import {
  corpusCohortIdentityForView,
  corpusCohortDifferences,
  corpusCohortLabel,
  corpusCohortSummaryLabel,
  selectPrimaryCorpusCohort,
  type CorpusCohortCandidate,
  type CorpusCohortIdentity
} from "./corpus-cohort";
import { canonicalJson } from "./canonical-json";
import {
  METRIC_CONTRACT_DIGEST,
  METRIC_CONTRACT_VERSION
} from "./metric-contract";
import { makePublicSingleReportV2R2, makeScanRunV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";
import { sha256Hex } from "./sha256";

const MIN = 50;

function identity(overrides: Partial<CorpusCohortIdentity> & { id: string }): CorpusCohortIdentity {
  const base: CorpusCohortIdentity = {
    id: overrides.id,
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion: "method",
    methodologyOrigin: "legacy-derived",
    producer: null,
    gpc: true,
    trackerCatalogDigest: "a".repeat(64),
    trackerCatalogOrigin: "legacy-metadata-hash",
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    metricContractVersion: METRIC_CONTRACT_VERSION,
    metricContractDigest: METRIC_CONTRACT_DIGEST
  };
  return { ...base, ...overrides };
}

function candidate(
  id: string,
  siteCount: number,
  latestRunAt: string | null,
  overrides: Partial<CorpusCohortIdentity> = {}
): CorpusCohortCandidate {
  return { identity: identity({ id, ...overrides }), siteCount, latestRunAt };
}

test("a bigger cohort that can never be refreshed loses to a smaller current one", () => {
  // The exact shape that pinned the published aggregates to 2026-07-06: a
  // cohort keyed on an UNRECORDED methodology cannot receive another scan,
  // because every current producer records one. Ranking on size alone left it
  // permanently primary and the freshness badge permanently stale.
  const frozen = candidate("v1:legacy-v1-methodology-unspecified:producer-unrecorded:gpc-on", 85, "2026-07-06T09:35:00.000Z");
  const current = candidate("v1:shields-request-context-v2:producer-unrecorded:gpc-on", 71, "2026-07-25T14:00:00.000Z");

  assert.equal(selectPrimaryCorpusCohort([frozen, current], MIN)?.identity.id, current.identity.id);
  // Order of the input must not decide it.
  assert.equal(selectPrimaryCorpusCohort([current, frozen], MIN)?.identity.id, current.identity.id);
});

test("recency never overrides statistical usability", () => {
  // A brand-new cohort below the floor cannot back percentile language, so the
  // usable cohort keeps the aggregate even though it is older. This is what
  // stops the first partial refresh of a new era from taking the crown with a
  // handful of sites.
  const usable = candidate("v1:older:producer-unrecorded:gpc-on", 85, "2026-07-06T09:35:00.000Z");
  const fresh = candidate("v1:newer:producer-unrecorded:gpc-off", MIN - 1, "2026-07-27T05:30:00.000Z");

  assert.equal(selectPrimaryCorpusCohort([usable, fresh], MIN)?.identity.id, usable.identity.id);

  // One more measured site and the new era is both usable and current.
  const cleared = { ...fresh, siteCount: MIN };
  assert.equal(selectPrimaryCorpusCohort([usable, cleared], MIN)?.identity.id, cleared.identity.id);
});

test("v1 keeps precedence: a newer r2 cohort does not promote itself", () => {
  // Promoting the r2 corpus to the deployed benchmark is a deliberate policy
  // change, never a side effect of r2 happening to be scanned more recently.
  const legacy = candidate("v1:method:producer-unrecorded:gpc-on", 85, "2026-07-06T09:35:00.000Z");
  const r2 = candidate("v2-r2:method:node-playwright:gpc-off", 90, "2026-07-25T14:00:00.000Z", {
    schemaVersion: 2,
    schemaRevision: 2,
    methodologyOrigin: "recorded",
    producer: "node-playwright"
  });

  assert.equal(selectPrimaryCorpusCohort([legacy, r2], MIN)?.identity.id, legacy.identity.id);
  // With no v1 cohort at all, the r2 generation is selected on its own terms.
  assert.equal(selectPrimaryCorpusCohort([r2], MIN)?.identity.id, r2.identity.id);
});

test("with nothing above the floor the same recency rule applies, and an empty corpus names nothing", () => {
  const older = candidate("v1:a:producer-unrecorded:gpc-on", 12, "2026-07-01T00:00:00.000Z");
  const newerSmaller = candidate("v1:b:producer-unrecorded:gpc-on", 4, "2026-07-25T00:00:00.000Z");

  // No percentile language is published in this state, so the floor stops
  // ranking and the newest evidence dates the corpus honestly.
  assert.equal(selectPrimaryCorpusCohort([older, newerSmaller], MIN)?.identity.id, newerSmaller.identity.id);
  assert.equal(selectPrimaryCorpusCohort([], MIN), null);
});

test("undated cohorts rank last and ties stay stable", () => {
  const undated = candidate("v1:undated:producer-unrecorded:gpc-on", 90, null);
  const dated = candidate("v1:dated:producer-unrecorded:gpc-on", 60, "2026-07-20T00:00:00.000Z");
  assert.equal(selectPrimaryCorpusCohort([undated, dated], MIN)?.identity.id, dated.identity.id);

  // Same instant and same size: the id breaks the tie so the choice is
  // reproducible across builds.
  const first = candidate("v1:aaa:producer-unrecorded:gpc-on", 60, "2026-07-20T00:00:00.000Z");
  const second = candidate("v1:bbb:producer-unrecorded:gpc-on", 60, "2026-07-20T00:00:00.000Z");
  assert.equal(selectPrimaryCorpusCohort([second, first], MIN)?.identity.id, first.identity.id);
});

test("an unparseable timestamp is treated as undated rather than ranking first", () => {
  const broken = candidate("v1:broken:producer-unrecorded:gpc-on", 90, "not-a-date");
  const dated = candidate("v1:dated:producer-unrecorded:gpc-on", 60, "2026-07-20T00:00:00.000Z");
  assert.equal(selectPrimaryCorpusCohort([broken, dated], MIN)?.identity.id, dated.identity.id);
});

// ---------------------------------------------------------------------------
// Naming a cohort. A label that omits an identity component can print byte-
// identical text for two cohorts the gate holds apart.
// ---------------------------------------------------------------------------


test("two cohorts that differ only in the requested GPC condition get different labels", () => {
  // The exact production case: the GPC component was added to the cohort key
  // precisely because the two eras must not pool, so a label that cannot
  // distinguish them tells the reader the medians are comparable.
  const on = identity({ id: "v1:m1:producer-unrecorded:gpc-on", gpc: true });
  const off = identity({ id: "v1:m1:producer-unrecorded:gpc-off", gpc: false });
  assert.notEqual(on.id, off.id);
  assert.notEqual(corpusCohortLabel(on), corpusCohortLabel(off));
  assert.match(corpusCohortLabel(on), /GPC requested/);
  assert.match(corpusCohortLabel(off), /GPC not requested/);
});

test("every component of a cohort id is distinguishable in its label", () => {
  const base = identity({ id: "base" });
  const variants = [
    identity({ id: "a", methodologyVersion: "m2" }),
    identity({ id: "b", schemaVersion: 2, schemaRevision: 2 }),
    identity({ id: "c", producer: "controlled-runner" }),
    identity({ id: "d", gpc: false }),
    identity({ id: "e", trackerCatalogDigest: "b".repeat(64) }),
    identity({ id: "f", trackerCatalogOrigin: "recorded" }),
    identity({ id: "g", serviceRoleTaxonomyVersion: "service-role-taxonomy-v2" }),
    identity({ id: "h", serviceRoleTaxonomyDigest: "c".repeat(64) }),
    identity({ id: "i", metricContractVersion: "metric-contract-v2" }),
    identity({ id: "j", metricContractDigest: "d".repeat(64) })
  ];
  for (const variant of variants) {
    assert.notEqual(corpusCohortLabel(variant), corpusCohortLabel(base), JSON.stringify(variant));
  }
});

test("a cohort split is attributed to the components that actually differ", () => {
  assert.deepEqual(corpusCohortDifferences([identity({ id: "base" }), identity({ id: "x", gpc: false })]), [
    "a different requested GPC condition"
  ]);
  assert.deepEqual(corpusCohortDifferences([identity({ id: "base" }), identity({ id: "x", methodologyVersion: "m2" })]), [
    "different methodology generations"
  ]);
  assert.deepEqual(
    corpusCohortDifferences([identity({ id: "base" }), identity({ id: "x", methodologyVersion: "m2", gpc: false })]),
    ["different methodology generations", "a different requested GPC condition"]
  );
  assert.deepEqual(
    corpusCohortDifferences([
      identity({ id: "base" }),
      identity({
        id: "x",
        trackerCatalogDigest: "b".repeat(64),
        serviceRoleTaxonomyDigest: "c".repeat(64),
        metricContractDigest: "d".repeat(64)
      })
    ]),
    [
      "different tracker-catalog identities",
      "different ServiceRole taxonomies",
      "different metric contracts"
    ]
  );
  assert.deepEqual(corpusCohortDifferences([identity({ id: "base" }), identity({ id: "base" })]), []);
});

test("cohort identity uses the recorded r2 catalog digest and current read-time formula identities", () => {
  const report = makePublicSingleReportV2R2();
  const cohort = corpusCohortIdentityForView(viewFromV2(report, 2));

  assert.equal(cohort.trackerCatalogDigest, report.run.toolchain.trackerCatalog.digest);
  assert.equal(cohort.trackerCatalogOrigin, "recorded");
  assert.equal(cohort.serviceRoleTaxonomyVersion, SERVICE_ROLE_TAXONOMY_VERSION);
  assert.equal(cohort.serviceRoleTaxonomyDigest, SERVICE_ROLE_TAXONOMY_DIGEST);
  assert.equal(cohort.metricContractVersion, METRIC_CONTRACT_VERSION);
  assert.equal(cohort.metricContractDigest, METRIC_CONTRACT_DIGEST);
  assert.match(cohort.id, new RegExp(`catalog-recorded-${report.run.toolchain.trackerCatalog.digest}`));
  assert.match(cohort.id, new RegExp(`roles-${SERVICE_ROLE_TAXONOMY_VERSION}-${SERVICE_ROLE_TAXONOMY_DIGEST}`));
  assert.match(cohort.id, new RegExp(`metrics-${METRIC_CONTRACT_VERSION}-${METRIC_CONTRACT_DIGEST}`));
});

test("frozen v1 gets a labeled hash of its available recorded catalog metadata without wire mutation", () => {
  const report = makeScanReportV1();
  const before = structuredClone(report);
  const view = viewFromV1Report(report);
  const cohort = corpusCohortIdentityForView(view);
  const expected = sha256Hex(canonicalJson(view.runs[0].conditions.trackerCatalog));

  assert.equal(cohort.trackerCatalogDigest, expected);
  assert.equal(cohort.trackerCatalogOrigin, "legacy-metadata-hash");
  assert.match(cohort.id, new RegExp(`catalog-legacy-metadata-hash-${expected}`));
  assert.deepEqual(report, before, "deriving the read-time cohort must not rewrite a frozen v1 report");
});

test("a v2 view without its recorded catalog digest fails closed", () => {
  const run = makeScanRunV2R2();
  const report = makePublicSingleReportV2R2();
  report.run = run;
  const view = viewFromV2(report, 2);
  view.runs[0].toolchainIdentity = null;
  assert.throws(() => corpusCohortIdentityForView(view), /requires its recorded tracker-catalog digest/);
});

// ---------------------------------------------------------------------------
// Composition. The corpus is two disjoint catalogs: a deliberately
// tracker-heavy "start here" gallery and a de-bias seed list. On 2026-07-27 the
// weekly cron refreshed only the gallery, the resulting 59-site cohort cleared
// the 50-site floor, and being newest it took the published aggregate. Median
// third-party requests went 11 -> 87 and catalogued trackers 1 -> 17 with no
// site behaving differently. A percentile is a claim about a population, so
// swapping the population republishes a different question's answer.
// ---------------------------------------------------------------------------

const gallerySites = Array.from({ length: 59 }, (_, index) => `gallery${index}.example`);
const seedSites = Array.from({ length: 35 }, (_, index) => `seed${index}.example`);

function era(id: string, methodologyVersion: string, sites: string[], latestRunAt: string): CorpusCohortCandidate {
  return {
    identity: identity({ id, methodologyVersion }),
    siteCount: sites.length,
    latestRunAt,
    sites
  };
}

test("a newer cohort may not take the aggregate to a narrower catalog", () => {
  const broad = era("gpc-on", "shields-v2", [...gallerySites.slice(0, 36), ...seedSites], "2026-07-25T18:23:27.000Z");
  const galleryOnly = era("gpc-off", "shields-v2", gallerySites, "2026-07-27T10:27:57.000Z");

  // Newest, and clears the floor on its own, but describes a different
  // population: it is missing 35 of the 71 sites the incumbent measured.
  assert.equal(selectPrimaryCorpusCohort([broad, galleryOnly], MIN)?.identity.id, "gpc-on");

  // Once the same era covers both catalogs it leads on recency, as intended.
  const complete = era("gpc-off", "shields-v2", [...gallerySites, ...seedSites], "2026-07-27T10:27:57.000Z");
  assert.equal(selectPrimaryCorpusCohort([broad, complete], MIN)?.identity.id, "gpc-off");
});

test("a frozen legacy cohort neither blocks nor reclaims the live line", () => {
  // The legacy cohort is keyed on an unrecorded methodology, so no scan can
  // ever refresh it. Letting composition hand the aggregate back to it would
  // re-freeze every published percentile, which is the failure the recency
  // rule exists to prevent.
  const legacy = era("legacy", "legacy-v1-methodology-unspecified", [...gallerySites, ...seedSites].slice(0, 85), "2026-07-06T09:35:14.000Z");
  const broad = era("gpc-on", "shields-v2", [...gallerySites.slice(0, 36), ...seedSites], "2026-07-25T18:23:27.000Z");
  const galleryOnly = era("gpc-off", "shields-v2", gallerySites, "2026-07-27T10:27:57.000Z");

  assert.equal(selectPrimaryCorpusCohort([legacy, galleryOnly, broad], MIN)?.identity.id, "gpc-on");
});

test("composition only constrains cohorts that are substitutable descriptions", () => {
  // A different methodology is a different question, not a narrower answer to
  // the same one, so it must not gate this line.
  const otherLine = era("other", "some-other-methodology", [...gallerySites, ...seedSites], "2026-07-20T00:00:00.000Z");
  const current = era("current", "shields-v2", gallerySites, "2026-07-27T00:00:00.000Z");
  assert.equal(selectPrimaryCorpusCohort([otherLine, current], MIN)?.identity.id, "current");

  // And a cohort whose composition is unknown cannot be shown to be narrower.
  const unknown = { ...current, sites: undefined };
  assert.equal(selectPrimaryCorpusCohort([otherLine, unknown], MIN)?.identity.id, "current");
});

test("a broader cohort with a different catalog or read-time formula identity cannot veto the current line", () => {
  const current = era("current", "shields-v2", gallerySites, "2026-07-27T00:00:00.000Z");
  const identityChanges: Partial<CorpusCohortIdentity>[] = [
    { trackerCatalogDigest: "b".repeat(64) },
    { trackerCatalogOrigin: "recorded" },
    { serviceRoleTaxonomyVersion: "service-role-taxonomy-v2" },
    { serviceRoleTaxonomyDigest: "c".repeat(64) },
    { metricContractVersion: "metric-contract-v2" },
    { metricContractDigest: "d".repeat(64) }
  ];

  for (const change of identityChanges) {
    const broad = era("broad", "shields-v2", [...gallerySites, ...seedSites], "2026-07-20T00:00:00.000Z");
    broad.identity = identity({ ...broad.identity, ...change, id: broad.identity.id });
    assert.equal(
      selectPrimaryCorpusCohort([broad, current], MIN)?.identity.id,
      "current",
      JSON.stringify(change)
    );
  }
});

test("the summary label is the prefix of the full label, not a second copy of it", () => {
  // These two used to restate the same four fields independently, which is this repo's
  // recurring defect shape: a reader-facing wording change lands in one and not the
  // other. corpusCohortLabel now derives from corpusCohortSummaryLabel; this pins that.
  const cohorts: CorpusCohortIdentity[] = [
    identity({ id: "a" }),
    identity({ id: "b", gpc: false }),
    identity({ id: "c", schemaVersion: 2, schemaRevision: 2 }),
    identity({ id: "d", schemaVersion: 2, schemaRevision: null }),
    identity({ id: "e", producer: "container@1" })
  ];
  for (const cohort of cohorts) {
    const summary = corpusCohortSummaryLabel(cohort);
    assert.ok(
      corpusCohortLabel(cohort).startsWith(`${summary}, `),
      `full label no longer starts with the summary: ${corpusCohortLabel(cohort)}`
    );
    // The summary is the human half only: no 64-character digests.
    assert.doesNotMatch(summary, /[0-9a-f]{32}/);
  }
});
