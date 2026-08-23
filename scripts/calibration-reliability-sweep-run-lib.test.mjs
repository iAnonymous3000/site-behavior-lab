import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bareLoadOutcome,
  EXPECTED_EVIDENCE_FAMILIES
} from "./calibration-reliability-sweep-lib.mjs";
import {
  assembleReceiptFromPasses,
  assertPassesConsistent,
  buildPassArtifact,
  parseCandidateSet,
  summarizeSweepOutcomes,
  validatePassArtifact,
  SWEEP_PASS_ARTIFACT_KIND
} from "./calibration-reliability-sweep-run-lib.mjs";

const CANDIDATE_BYTES = `${JSON.stringify(
  {
    studyId: "sweep-test-study",
    candidates: [
      { caseId: "alpha.example", url: "https://alpha.example/" },
      { caseId: "beta.example", url: "https://beta.example/" }
    ]
  },
  null,
  2
)}\n`;

function soundReport(status = 200) {
  return {
    run: {
      summary: { status },
      quality: {
        run: { outcome: "complete" },
        byFamily: Object.fromEntries(
          EXPECTED_EVIDENCE_FAMILIES.map((family) => [family, { outcome: "complete" }])
        )
      },
      qualityFacts: {
        status,
        navigationSettled: true,
        botWallTitleMatched: false,
        captureLoss: [],
        budgetsExhausted: []
      }
    }
  };
}

function soundOutcome(caseId, pass, observedAt) {
  return bareLoadOutcome(caseId, soundReport(), { pass, observedAt });
}

const IDENTITY = {
  buildCommit: "a".repeat(40),
  runtime: "node-test",
  runnerLabel: "unit-test",
  egress: "test-egress"
};
const CONDITION = { device: "desktop", consentMode: "observe", gpcEnabled: false };

function passArtifact(pass, observedAt, overrides = {}) {
  const { candidateSetDigest } = parseCandidateSet(CANDIDATE_BYTES);
  return buildPassArtifact({
    studyId: "sweep-test-study",
    pass,
    candidateSetDigest,
    measurementCondition: CONDITION,
    identity: IDENTITY,
    outcomes: [
      soundOutcome("alpha.example", pass, observedAt),
      soundOutcome("beta.example", pass, observedAt)
    ],
    ...overrides
  });
}

test("the candidate set digest binds to the exact bytes, not a re-serialization", () => {
  const parsed = parseCandidateSet(CANDIDATE_BYTES);
  assert.equal(parsed.studyId, "sweep-test-study");
  assert.equal(parsed.candidates.length, 2);
  const reformatted = JSON.stringify(JSON.parse(CANDIDATE_BYTES));
  assert.notEqual(parseCandidateSet(reformatted).candidateSetDigest, parsed.candidateSetDigest);
});

test("candidate sets reject duplicates, non-https urls, and unknown fields", () => {
  assert.throws(
    () =>
      parseCandidateSet(
        JSON.stringify({
          studyId: "s",
          candidates: [
            { caseId: "dup.example", url: "https://a.example/" },
            { caseId: "dup.example", url: "https://b.example/" }
          ]
        })
      ),
    /duplicate caseId/
  );
  assert.throws(
    () =>
      parseCandidateSet(
        JSON.stringify({ studyId: "s", candidates: [{ caseId: "a", url: "http://a.example/" }] })
      ),
    /must be https/
  );
  assert.throws(
    () =>
      parseCandidateSet(
        JSON.stringify({
          studyId: "s",
          candidates: [{ caseId: "a", url: "https://a.example/", prediction: true }]
        })
      ),
    /unexpected field "prediction"/
  );
});

test("a pass artifact refuses any outcome carrying a non-bare-load field", () => {
  const observedAt = "2026-08-23T01:00:00.000Z";
  const smuggled = { ...soundOutcome("alpha.example", 1, observedAt), cnameCloaks: [] };
  const { candidateSetDigest } = parseCandidateSet(CANDIDATE_BYTES);
  assert.throws(
    () =>
      buildPassArtifact({
        studyId: "sweep-test-study",
        pass: 1,
        candidateSetDigest,
        measurementCondition: CONDITION,
        identity: IDENTITY,
        outcomes: [smuggled]
      }),
    /not a bare-load field/
  );
});

test("a persisted pass artifact is re-validated field by field on read-back", () => {
  const artifact = passArtifact(1, "2026-08-23T01:00:00.000Z");
  const roundTripped = JSON.parse(JSON.stringify(artifact));
  assert.deepEqual(validatePassArtifact(roundTripped, 1), artifact);
  assert.throws(() => validatePassArtifact(roundTripped, 2), /expected pass 2/);
  assert.throws(
    () => validatePassArtifact({ ...roundTripped, kind: "something-else" }),
    /kind mismatch/
  );
  const edited = JSON.parse(JSON.stringify(artifact));
  edited.outcomes[0].fingerprintDetections = [];
  assert.throws(() => validatePassArtifact(edited, 1), /not a bare-load field/);
});

test("identity or condition drift between passes refuses assembly as two sweeps", () => {
  const first = passArtifact(1, "2026-08-23T01:00:00.000Z");
  const second = passArtifact(2, "2026-08-25T02:00:00.000Z");
  assertPassesConsistent(first, second);

  const otherBuild = JSON.parse(JSON.stringify(second));
  otherBuild.identity.buildCommit = "b".repeat(40);
  assert.throws(() => assertPassesConsistent(first, otherBuild), /buildCommit changed/);

  const otherCondition = JSON.parse(JSON.stringify(second));
  otherCondition.measurementCondition.gpcEnabled = true;
  assert.throws(() => assertPassesConsistent(first, otherCondition), /gpcEnabled changed/);
});

test("receipt assembly binds sources, requires whole passes, and honors the 48h separation", () => {
  const first = passArtifact(1, "2026-08-23T01:00:00.000Z");
  const second = passArtifact(2, "2026-08-25T02:00:00.000Z");
  const firstBytes = JSON.stringify(first);
  const secondBytes = JSON.stringify(second);

  const receipt = assembleReceiptFromPasses({
    first,
    second,
    firstArtifactBytes: firstBytes,
    secondArtifactBytes: secondBytes,
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-25T03:00:00.000Z"
  });
  assert.equal(receipt.observedCandidates, 2);
  assert.equal(receipt.eligibleCandidates, 2);
  assert.deepEqual(Object.keys(receipt.sourceDigests).sort(), [
    "candidate-set",
    "pass-1-artifact",
    "pass-2-artifact"
  ]);

  // Under 48 hours the candidates are observed but not eligible.
  const tooSoon = passArtifact(2, "2026-08-23T05:00:00.000Z");
  const tooSoonReceipt = assembleReceiptFromPasses({
    first,
    second: tooSoon,
    firstArtifactBytes: firstBytes,
    secondArtifactBytes: JSON.stringify(tooSoon),
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-25T03:00:00.000Z"
  });
  assert.equal(tooSoonReceipt.eligibleCandidates, 0);

  // A pass missing a candidate is a partial pass, re-run rather than assembled.
  const partial = JSON.parse(JSON.stringify(second));
  partial.outcomes = partial.outcomes.slice(0, 1);
  assert.throws(
    () =>
      assembleReceiptFromPasses({
        first,
        second: validatePassArtifact(partial, 2),
        firstArtifactBytes: firstBytes,
        secondArtifactBytes: JSON.stringify(partial),
        candidateSetBytes: CANDIDATE_BYTES,
        sweptAt: "2026-08-25T03:00:00.000Z"
      }),
    /partial pass is re-run/
  );
});

test("the summary lower-bounds detector-input readiness from load facts only", () => {
  const observedAt = "2026-08-23T01:00:00.000Z";
  const sound = soundOutcome("alpha.example", 1, observedAt);
  const unverified = bareLoadOutcome("beta.example", null, { pass: 1, observedAt });
  const lossy = bareLoadOutcome(
    "gamma.example",
    (() => {
      const report = soundReport();
      report.run.quality.byFamily.fingerprinting = { outcome: "censored" };
      report.run.qualityFacts.captureLoss = [
        { family: "fingerprinting", kind: "dropped", count: 1, detail: "fingerprint-observer" }
      ];
      return report;
    })(),
    { pass: 1, observedAt }
  );
  const summary = summarizeSweepOutcomes([sound, unverified, lossy]);
  assert.equal(summary.observed, 3);
  assert.equal(summary.loaded, 2);
  // The step-3 split: the lossy case is bare-load VALID (it is conserved by
  // policy C, so screening must not drop it) while only the fully complete
  // case enters the conservative all-families bound.
  assert.equal(summary.valid, 2);
  assert.equal(summary.allFamiliesComplete, 1);
  assert.deepEqual(summary.familyCensorCounts, { fingerprinting: 1 });
  assert.throws(
    () => summarizeSweepOutcomes([{ ...sound, pixelEvents: [] }]),
    /not a bare-load field/
  );
});

test("the pass artifact kind is pinned", () => {
  assert.equal(SWEEP_PASS_ARTIFACT_KIND, "site-behavior-calibration-reliability-sweep-pass");
});
