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
  const base = sourceOf(40, "base");
  // The category source holds every even-numbered base domain plus a stranger.
  const category =
    [...Array.from({ length: 20 }, (_, index) => `base-${index * 2}.example`), "not-in-base.example"].join(
      "\n"
    ) + "\n";
  const { candidateSet, provenance } = buildCandidateUniverse({
    studyId: "scoped-study",
    base: { bytes: base, manifest: manifestFor(base) },
    category: {
      bytes: category,
      manifest: manifestFor(category, { permanentId: "FIXTURE-CATEGORY-1" })
    },
    exclusions: ["base-2.example"],
    poolSize: 10
  });
  // Base order preserved, category membership required, exclusion applied:
  // 0, (2 excluded), 4, 6, ...
  assert.deepEqual(
    candidateSet.candidates.slice(0, 3).map((entry) => entry.caseId),
    ["base-0.example", "base-4.example", "base-6.example"]
  );
  assert.equal(provenance.category.intersection, 20);
  assert.equal(provenance.category.manifest.permanentId, "FIXTURE-CATEGORY-1");
  // The population statement is GENERATED from the transformation, not typed.
  assert.match(
    provenance.population,
    /intersected with category source fixture-rank-provider FIXTURE-CATEGORY-1/
  );
  assert.equal(provenance.version, CANDIDATE_UNIVERSE_VERSION);
  assert.equal(CANDIDATE_UNIVERSE_VERSION, 2);
  // A category member absent from the base can never be admitted.
  assert.equal(
    candidateSet.candidates.some((entry) => entry.caseId === "not-in-base.example"),
    false
  );
  // Without a category source, the generated population claims only the
  // provider's own ordering: no scope is available to assert.
  const unscoped = buildCandidateUniverse({
    studyId: "unscoped",
    base: { bytes: base, manifest: manifestFor(base) },
    exclusions: [],
    poolSize: 10
  });
  assert.doesNotMatch(unscoped.provenance.population, /intersected/);
  assert.equal(unscoped.provenance.category, null);
});

test("the prevalence pilot is a disjoint prefix, emitted separately with its own digest", () => {
  const base = sourceOf(100);
  const { candidateSet, pilotSet, pilotSetBytes, provenance } = buildCandidateUniverse({
    studyId: "piloted-study",
    base: { bytes: base, manifest: manifestFor(base) },
    exclusions: ["site-1.example"],
    poolSize: 60,
    pilotSize: 20
  });
  assert.equal(pilotSet.candidates.length, 20);
  assert.equal(candidateSet.candidates.length, 60);
  assert.equal(pilotSet.studyId, "piloted-study-prevalence-pilot");
  // Disjoint by construction: the pilot is the surviving prefix, the pool
  // starts after it, and no domain appears in both.
  assert.equal(pilotSet.candidates[0].caseId, "site-0.example");
  const pilotIds = new Set(pilotSet.candidates.map((entry) => entry.caseId));
  assert.equal(candidateSet.candidates.some((entry) => pilotIds.has(entry.caseId)), false);
  assert.equal(provenance.pilotDisjointFromPool, true);
  assert.equal(
    provenance.pilotSetSha256,
    createHash("sha256").update(pilotSetBytes).digest("hex")
  );
});

test("repository data may only exclude, with the removed domains as emitted proof", () => {
  const source = sourceOf(700);
  const excluded = ["site-3.example", "site-500.example", "never-in-source.example"];
  const { candidateSet, provenance } = buildCandidateUniverse({
    studyId: "cname-observe-sweep-1",
    base: { bytes: source, manifest: manifestFor(source) },
    exclusions: excluded,
    poolSize: 600
  });
  assert.equal(candidateSet.candidates.length, 600);
  assert.equal(candidateSet.candidates[0].caseId, "site-0.example");
  assert.equal(candidateSet.candidates[3].caseId, "site-4.example");
  assert.deepEqual(provenance.excludedDomains, ["site-3.example", "site-500.example"]);
  assert.equal(provenance.kind, CANDIDATE_UNIVERSE_KIND);
  assert.equal(provenance.attestation, "operator-attested-permanent-id");
});

test("sizing carries no withdrawn-claim floor, and shortfalls fail closed", () => {
  // The 600 floor was justified from the withdrawn N=350 at 0.50 prevalence;
  // size is structural here and its justification lives in preregistration.
  const small = buildCandidateUniverse({
    studyId: "s",
    base: { bytes: sourceOf(10), manifest: manifestFor(sourceOf(10)) },
    exclusions: [],
    poolSize: 5
  });
  assert.equal(small.candidateSet.candidates.length, 5);
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        base: { bytes: sourceOf(50), manifest: manifestFor(sourceOf(50)) },
        exclusions: Array.from({ length: 20 }, (_, index) => `site-${index}.example`),
        poolSize: 40
      }),
    /supply a longer external list, never relax an exclusion/
  );
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        base: { bytes: sourceOf(10), manifest: manifestFor(sourceOf(10)) },
        exclusions: [],
        poolSize: 5,
        preferredSites: ["site-1.example"]
      }),
    /unexpected field "preferredSites"/
  );
});
