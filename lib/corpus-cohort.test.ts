import assert from "node:assert/strict";
import test from "node:test";
import {
  corpusCohortDifferences,
  corpusCohortLabel,
  selectPrimaryCorpusCohort,
  type CorpusCohortCandidate,
  type CorpusCohortIdentity
} from "./corpus-cohort";

const MIN = 50;

function identity(overrides: Partial<CorpusCohortIdentity> & { id: string }): CorpusCohortIdentity {
  return {
    schemaVersion: 1,
    schemaRevision: null,
    methodologyVersion: "method",
    methodologyOrigin: "legacy-derived",
    producer: null,
    gpc: true,
    ...overrides
  };
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
// Naming a cohort. The gate keys on four components; a label that renders one
// of them can print byte-identical text for two cohorts the gate holds apart.
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
    identity({ id: "d", gpc: false })
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
  assert.deepEqual(corpusCohortDifferences([identity({ id: "base" }), identity({ id: "base" })]), []);
});
