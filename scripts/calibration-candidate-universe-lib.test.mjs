import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  CANDIDATE_UNIVERSE_KIND,
  buildCandidateUniverse,
  parseExternalSourceList,
  validateSourceManifest
} from "./calibration-candidate-universe-lib.mjs";

function manifestFor(sourceBytes, overrides = {}) {
  return {
    provider: "tranco-list.eu",
    permanentId: "Z417G",
    url: "https://tranco-list.eu/list/Z417G/1000000",
    retrievedAt: "2026-08-23T00:00:00.000Z",
    scope: "finance and news publishers, externally categorized",
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

test("repository data may only exclude: the removed domains are the emitted proof", () => {
  const source = sourceOf(700);
  const excluded = ["site-3.example", "site-500.example", "never-in-source.example"];
  const { candidateSet, provenance } = buildCandidateUniverse({
    studyId: "cname-observe-sweep-1",
    sourceBytes: source,
    sourceManifest: manifestFor(source),
    exclusions: excluded,
    poolSize: 600
  });
  assert.equal(candidateSet.candidates.length, 600);
  // Source order is the only ordering: the first survivors, in order.
  assert.equal(candidateSet.candidates[0].caseId, "site-0.example");
  assert.equal(candidateSet.candidates[3].caseId, "site-4.example", "site-3 was excluded, order otherwise untouched");
  // The proof half: exactly the source-present exclusions, in source order.
  assert.deepEqual(provenance.excludedDomains, ["site-3.example", "site-500.example"]);
  assert.equal(provenance.kind, CANDIDATE_UNIVERSE_KIND);
  assert.equal(provenance.sourceDomains, 700);
  assert.match(provenance.candidateSetSha256, /^[0-9a-f]{64}$/);
  // No candidate is ever admitted from the exclusion machinery.
  assert.equal(
    candidateSet.candidates.some((entry) => entry.caseId === "never-in-source.example"),
    false
  );
});

test("a short source fails closed: supply a longer list, never relax an exclusion", () => {
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        sourceBytes: sourceOf(650),
        sourceManifest: manifestFor(sourceOf(650)),
        exclusions: Array.from({ length: 60 }, (_, index) => `site-${index}.example`),
        poolSize: 600
      }),
    /supply a longer external list, never relax an exclusion/
  );
  // And the 600 floor itself is the frame-construction pool rule.
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        sourceBytes: sourceOf(700),
        sourceManifest: manifestFor(sourceOf(700)),
        exclusions: [],
        poolSize: 350
      }),
    /at least 600/
  );
});

test("the builder has no ranking or admission argument: only exclusion enters from outside the source", () => {
  // The signature is the independence guarantee, as with the v4 merge: there
  // is no parameter through which scanner results could rank or admit.
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        sourceBytes: sourceOf(700),
        sourceManifest: manifestFor(sourceOf(700)),
        exclusions: [],
        poolSize: 600,
        preferredSites: ["site-1.example"]
      }),
    /unexpected|preferredSites/,
    "an unknown argument must not silently become a ranking channel"
  );
});

test("the manifest binds the bytes to a permanent external snapshot, or refuses", () => {
  const source = sourceOf(700);
  // A digest that does not match the supplied bytes is not that snapshot.
  assert.throws(
    () =>
      buildCandidateUniverse({
        studyId: "s",
        sourceBytes: source,
        sourceManifest: manifestFor(source, { sha256: "a".repeat(64) }),
        exclusions: [],
        poolSize: 600
      }),
    /does not match the supplied source bytes/
  );
  // Free text cannot stand in for the structured fields.
  assert.throws(
    () => validateSourceManifest({ description: "downloaded from somewhere" }, source),
    /unexpected field "description"/
  );
  for (const missing of ["provider", "permanentId", "url", "retrievedAt", "scope", "sha256"]) {
    const manifest = manifestFor(source);
    delete manifest[missing];
    assert.throws(() => validateSourceManifest(manifest, source), new RegExp(`needs ${missing}`));
  }
  // The provenance embeds the manifest verbatim, so an auditor can re-fetch
  // the permanent id and compare digests.
  const { provenance } = buildCandidateUniverse({
    studyId: "s",
    sourceBytes: source,
    sourceManifest: manifestFor(source),
    exclusions: [],
    poolSize: 600
  });
  assert.equal(provenance.sourceManifest.permanentId, "Z417G");
  assert.equal(provenance.sourceManifest.sha256, provenance.sourceSha256);
});
