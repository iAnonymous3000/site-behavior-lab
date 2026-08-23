import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANDIDATE_UNIVERSE_KIND,
  buildCandidateUniverse,
  parseExternalSourceList
} from "./calibration-candidate-universe-lib.mjs";

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
    sourceDescription: "synthetic fixture list",
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
        sourceDescription: "fixture",
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
        sourceDescription: "fixture",
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
        sourceDescription: "fixture",
        exclusions: [],
        poolSize: 600,
        preferredSites: ["site-1.example"]
      }),
    /unexpected|preferredSites/,
    "an unknown argument must not silently become a ranking channel"
  );
});
