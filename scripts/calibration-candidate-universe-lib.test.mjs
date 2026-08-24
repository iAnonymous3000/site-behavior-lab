import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  CANDIDATE_UNIVERSE_KIND,
  CANDIDATE_UNIVERSE_VERSION,
  buildCandidateUniverse,
  parseExternalSourceList,
  validateSourceManifest
} from "./calibration-candidate-universe-lib.mjs";

// Fixtures are HONEST about being fixtures: synthetic providers and ids,
// never a real provider's name attached to bytes that are not that
// provider's. The earlier suite labeled synthetic bytes as a real Tranco
// snapshot with a finance/news scope string, which was exactly the
// self-attestation hole the review flagged.
function manifestFor(sourceBytes, overrides = {}) {
  return {
    provider: "fixture-rank-provider",
    permanentId: "FIXTURE-SNAPSHOT-1",
    url: "https://ranks.fixture.example/list/FIXTURE-SNAPSHOT-1",
    retrievedAt: "2026-08-23T00:00:00.000Z",
    sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    ...overrides
  };
}

function sourceOf(count, prefix = "site") {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}.example`).join("\n") + "\n";
}

test("the source list parses in order, digested over exact bytes, refusing non-domains", () => {
  const bytes = "# comment\n1,alpha.example\nbeta.example\n\nALPHA.example\n";
  const parsed = parseExternalSourceList(bytes);
  assert.deepEqual(parsed.domains, ["alpha.example", "beta.example"]);
  assert.notEqual(
    parseExternalSourceList(bytes + "\n").sourceSha256,
    parsed.sourceSha256,
    "the digest names the exact bytes, not a normalization"
  );
  assert.throws(() => parseExternalSourceList("not a domain line!\n"), /not a domain/);
});

test("the manifest carries no scope string and refuses bytes that are not the named snapshot", () => {
  const source = sourceOf(10);
  const manifest = manifestFor(source);
  assert.equal(validateSourceManifest(manifest, source), manifest);
  // A typed scope was the self-attestation hole: refused as an unknown field.
  assert.throws(
    () => validateSourceManifest(manifestFor(source, { scope: "finance and news" }), source),
    /unexpected field "scope"/
  );
  assert.throws(
    () => validateSourceManifest(manifestFor(source, { sha256: "a".repeat(64) }), source),
    /does not match the supplied source bytes/
  );
  for (const missing of ["provider", "permanentId", "url", "retrievedAt", "sha256"]) {
    const broken = manifestFor(source);
    delete broken[missing];
    assert.throws(() => validateSourceManifest(broken, source), new RegExp(`needs ${missing}`));
  }
});

test("a population scope exists only through a category source and its deterministic intersection", () => {
  const base = sourceOf(1200, "base");
  // The category source holds every even-numbered base domain plus a stranger.
  const category =
    [...Array.from({ length: 600 }, (_, index) => `base-${index * 2}.example`), "not-in-base.example"].join(
      "\n"
    ) + "\n";
  const { candidateSet, pilotSet, provenance } = buildCandidateUniverse({
    studyId: "scoped-study",
    pilotSize: 100,
    base: { bytes: base, manifest: manifestFor(base) },
    category: {
      bytes: category,
      manifest: manifestFor(category, { permanentId: "FIXTURE-CATEGORY-1" })
    },
    exclusions: ["base-2.example"],
    poolSize: 400
  });
  const all = [...pilotSet.candidates, ...candidateSet.candidates].map((entry) => entry.caseId);
  // Category membership is required, the exclusion applied, base order is the
  // frame order, and the frame is the first 500 scoped survivors.
  assert.equal(all.length, 500);
  assert.equal(all.every((domain) => /^base-\d*[02468]\.example$/.test(domain)), true);
  assert.equal(all.includes("base-2.example"), false);
  assert.equal(all.includes("not-in-base.example"), false);
  assert.equal(provenance.category.intersection, 600);
  assert.equal(provenance.category.manifest.permanentId, "FIXTURE-CATEGORY-1");
  // The population statement is GENERATED from the transformation, not typed.
  assert.match(
    provenance.population,
    /intersected with category source fixture-rank-provider FIXTURE-CATEGORY-1/
  );
  assert.equal(provenance.version, CANDIDATE_UNIVERSE_VERSION);
  assert.equal(CANDIDATE_UNIVERSE_VERSION, 3);
  // Without a category source, the generated population claims only the
  // provider's own ordering: no scope is available to assert.
  const unscoped = buildCandidateUniverse({
    studyId: "unscoped",
    pilotSize: 100,
    base: { bytes: base, manifest: manifestFor(base) },
    exclusions: [],
    poolSize: 400
  });
  assert.doesNotMatch(unscoped.provenance.population, /intersected/);
  assert.equal(unscoped.provenance.category, null);
});

test("the pilot is a deterministic seeded RANDOM partition of the fixed frame, never a prefix", () => {
  const base = sourceOf(700);
  const build = () =>
    buildCandidateUniverse({
      studyId: "piloted-study",
      base: { bytes: base, manifest: manifestFor(base) },
      exclusions: ["site-1.example"],
      poolSize: 400,
      pilotSize: 100
    });
  const { candidateSet, pilotSet, pilotSetBytes, provenance } = build();
  assert.equal(pilotSet.candidates.length, 100);
  assert.equal(candidateSet.candidates.length, 400);
  assert.equal(pilotSet.studyId, "piloted-study-prevalence-pilot");
  // Disjoint membership over one fixed frame.
  const pilotIds = new Set(pilotSet.candidates.map((entry) => entry.caseId));
  assert.equal(candidateSet.candidates.some((entry) => pilotIds.has(entry.caseId)), false);
  assert.equal(provenance.pilotDisjointFromPool, true);
  assert.equal(provenance.partition.method, "seeded-fisher-yates-sha256-v1");
  assert.match(provenance.partition.seedSha256, /^[0-9a-f]{64}$/);
  assert.equal(provenance.partition.frameSize, 500);
  // NOT a prefix: popularity rank correlates with deployment, so the pilot
  // must sample the whole frame. The first 100 frame survivors landing
  // entirely in the pilot has probability C(400,0)/C(500,100), effectively
  // zero; sampling both halves of the frame is the observable claim.
  const frameFirstHalfInPilot = pilotSet.candidates.filter((entry) => {
    const rank = Number(entry.caseId.match(/site-(\d+)\.example/)[1]);
    return rank <= 260;
  }).length;
  assert.ok(
    frameFirstHalfInPilot > 0 && frameFirstHalfInPilot < 100,
    `the pilot must draw from across the frame, not a prefix (${frameFirstHalfInPilot} of 100 from the first half)`
  );
  // Deterministic: the same committed inputs derive the identical split.
  const again = build();
  assert.deepEqual(again.pilotSet, pilotSet);
  assert.deepEqual(again.candidateSet, candidateSet);
  // And the seed has NO free parameter: a different studyId is a different
  // partition, so the seed cannot be shopped without changing the artifacts.
  const other = buildCandidateUniverse({
    studyId: "other-study",
    base: { bytes: base, manifest: manifestFor(base) },
    exclusions: ["site-1.example"],
    poolSize: 400,
    pilotSize: 100
  });
  assert.notDeepEqual(
    other.pilotSet.candidates.map((entry) => entry.caseId),
    pilotSet.candidates.map((entry) => entry.caseId)
  );
  assert.equal(
    provenance.pilotSetSha256,
    createHash("sha256").update(pilotSetBytes).digest("hex")
  );
});

test("a pilot below the preregistered minimum is refused: no prevalence estimate, no universe", () => {
  const base = sourceOf(700);
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        base: { bytes: base, manifest: manifestFor(base) },
        exclusions: [],
        poolSize: 400,
        pilotSize: 0
      }),
    /preregistered minimum of 100/
  );
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        base: { bytes: base, manifest: manifestFor(base) },
        exclusions: [],
        poolSize: 400
      }),
    /preregistered minimum of 100/
  );
});

test("repository data may only exclude, with the removed domains as emitted proof", () => {
  const source = sourceOf(700);
  const excluded = ["site-3.example", "site-500.example", "never-in-source.example"];
  const { candidateSet, provenance } = buildCandidateUniverse({
    studyId: "cname-observe-sweep-1",
    pilotSize: 100,
    base: { bytes: source, manifest: manifestFor(source) },
    exclusions: excluded,
    poolSize: 500
  });
  assert.equal(candidateSet.candidates.length, 500);
  assert.deepEqual(provenance.excludedDomains, ["site-3.example", "site-500.example"]);
  assert.equal(provenance.kind, CANDIDATE_UNIVERSE_KIND);
  assert.equal(provenance.attestation, "operator-attested-permanent-id");
});

test("sizing carries no withdrawn-claim floor, and shortfalls fail closed", () => {
  // The 600 floor was justified from the withdrawn N=350 at 0.50 prevalence;
  // pool size is structural here and its justification lives in
  // preregistration, while the PILOT keeps its preregistered floor.
  const small = buildCandidateUniverse({
    studyId: "s",
    pilotSize: 100,
    base: { bytes: sourceOf(150), manifest: manifestFor(sourceOf(150)) },
    exclusions: [],
    poolSize: 5
  });
  assert.equal(small.candidateSet.candidates.length, 5);
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        pilotSize: 100,
        base: { bytes: sourceOf(120), manifest: manifestFor(sourceOf(120)) },
        exclusions: Array.from({ length: 30 }, (_, index) => `site-${index}.example`),
        poolSize: 40
      }),
    /supply a longer external list, never relax an exclusion/
  );
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        pilotSize: 100,
        base: { bytes: sourceOf(150), manifest: manifestFor(sourceOf(150)) },
        exclusions: [],
        poolSize: 5,
        preferredSites: ["site-1.example"]
      }),
    /unexpected field "preferredSites"/
  );
});
