import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bareLoadOutcome,
  EXPECTED_EVIDENCE_FAMILIES
} from "./calibration-reliability-sweep-lib.mjs";
import {
  SWEEP_BOUND_MINIMUM_ROUNDS,
  validateSweepReceipt,
  SWEEP_PASS_ARTIFACT_KIND,
  assembleReceiptFromRounds,
  assertRoundsConsistent,
  buildPassArtifact,
  computeClusterLossBound,
  parseCandidateSet,
  summarizeSweepOutcomes,
  validatePassArtifact
} from "./calibration-reliability-sweep-run-lib.mjs";
import { buildReliabilitySweepReceipt, serializeReliabilitySweepReceipt } from "./calibration-reliability-sweep-lib.mjs";
import { clusterInterval } from "./cluster-interval-lib.mjs";

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

test("identity or condition drift between rounds refuses assembly as two sweeps", () => {
  const rounds = [
    passArtifact(1, "2026-08-23T01:00:00.000Z"),
    passArtifact(2, "2026-08-25T02:00:00.000Z"),
    passArtifact(3, "2026-08-26T03:00:00.000Z")
  ];
  assertRoundsConsistent(rounds);

  // Drift on ANY later round is refused, not only round 2: the review of the
  // two-pass model demanded exactly this generalization.
  const otherBuild = JSON.parse(JSON.stringify(rounds));
  otherBuild[2].identity.buildCommit = "b".repeat(40);
  assert.throws(() => assertRoundsConsistent(otherBuild), /buildCommit changed/);

  const otherCondition = JSON.parse(JSON.stringify(rounds));
  otherCondition[1].measurementCondition.gpcEnabled = true;
  assert.throws(() => assertRoundsConsistent(otherCondition), /gpcEnabled changed/);

  // Rounds must be contiguous from 1 and disjoint sessions 24h apart.
  assert.throws(
    () => assertRoundsConsistent([rounds[0], passArtifact(3, "2026-08-25T02:00:00.000Z")]),
    /contiguous rounds starting at 1/
  );
  assert.throws(
    () =>
      assertRoundsConsistent([
        passArtifact(1, "2026-08-23T01:00:00.000Z"),
        passArtifact(2, "2026-08-23T05:00:00.000Z")
      ]),
    /disjoint sessions/
  );
});

test("receipt assembly binds sources per round, requires whole rounds, and honors both separations", () => {
  const first = passArtifact(1, "2026-08-23T01:00:00.000Z");
  const second = passArtifact(2, "2026-08-25T02:00:00.000Z");
  const third = passArtifact(3, "2026-08-26T03:00:00.000Z");
  const entry = (artifact) => ({ artifact, bytes: JSON.stringify(artifact) });

  const receipt = assembleReceiptFromRounds({
    rounds: [entry(first), entry(second), entry(third)],
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-26T04:00:00.000Z"
  });
  assert.equal(receipt.observedCandidates, 2);
  assert.equal(receipt.eligibleCandidates, 2);
  assert.deepEqual(Object.keys(receipt.sourceDigests).sort(), [
    "candidate-set",
    "round-1-artifact",
    "round-2-artifact",
    "round-3-artifact"
  ]);

  // Between 24h and 48h: the session-disjoint rule admits the round, and the
  // eligibility pair still refuses the candidate. The two separations are
  // different rules with different owners.
  const thirtyHours = passArtifact(2, "2026-08-24T07:00:00.000Z");
  const windowReceipt = assembleReceiptFromRounds({
    rounds: [entry(first), entry(thirtyHours)],
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-25T03:00:00.000Z"
  });
  assert.equal(windowReceipt.eligibleCandidates, 0);

  // A round missing a candidate is a partial round, re-run rather than assembled.
  const partial = JSON.parse(JSON.stringify(second));
  partial.outcomes = partial.outcomes.slice(0, 1);
  assert.throws(
    () =>
      assembleReceiptFromRounds({
        rounds: [entry(first), entry(validatePassArtifact(partial, 2))],
        candidateSetBytes: CANDIDATE_BYTES,
        sweptAt: "2026-08-25T03:00:00.000Z"
      }),
    /partial round is re-run/
  );
});

test("the loss bound is cluster-aware and fail-closed: too few rounds is a refusal, never an iid interval", () => {
  const entry = (artifact) => ({ artifact, bytes: JSON.stringify(artifact) });
  const at = [
    "2026-08-23T01:00:00.000Z",
    "2026-08-25T02:00:00.000Z",
    "2026-08-26T03:00:00.000Z",
    "2026-08-27T04:00:00.000Z",
    "2026-08-28T05:00:00.000Z"
  ];
  const rounds = at.map((when, index) => passArtifact(index + 1, when));
  const roundEntriesOf = (list) => list.map((artifact) => ({ bytes: JSON.stringify(artifact) }));
  const receipt = assembleReceiptFromRounds({
    rounds: rounds.map(entry),
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-28T06:00:00.000Z"
  });
  const receiptBytes = serializeReliabilitySweepReceipt(receipt);
  const bound = computeClusterLossBound({
    candidateSetBytes: CANDIDATE_BYTES,
    roundEntries: roundEntriesOf(rounds),
    receiptBytes
  });

  assert.equal(bound.rounds, 5);
  assert.equal(bound.method.algorithm, "cluster-bootstrap");
  assert.equal(bound.method.clusterUnit, "collection-round");
  assert.equal(bound.method.minimumClusters, SWEEP_BOUND_MINIMUM_ROUNDS);
  // Every fixture outcome is fully complete, so the bound is exactly [1, 1],
  // and it must EQUAL the shared implementation applied to the same items:
  // one algorithm, one home, provably.
  const outcomes = receipt.cases.flatMap((c) => c.passes);
  const reference = clusterInterval(outcomes, () => true, (o) => o.pass);
  assert.equal(bound.bounds.allFamiliesComplete.lo, reference.lo);
  assert.equal(bound.bounds.allFamiliesComplete.hi, reference.hi);
  assert.deepEqual(Object.keys(bound.bounds.censoredByFamily).length, 6);

  // NO iid vocabulary anywhere in the artifact: a Wilson interval here is the
  // substitution the censoring analysis's record refuses.
  const serialized = JSON.stringify(bound);
  assert.equal(/wilson|interval95/i.test(serialized), false);

  // Below the preregistered minimum: a refusal that names the remedy.
  const three = assembleReceiptFromRounds({
    rounds: rounds.slice(0, 3).map(entry),
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-26T04:00:00.000Z"
  });
  assert.throws(
    () =>
      computeClusterLossBound({
        candidateSetBytes: CANDIDATE_BYTES,
        roundEntries: roundEntriesOf(rounds.slice(0, 3)),
        receiptBytes: serializeReliabilitySweepReceipt(three)
      }),
    /preregistered minimum is 4.*never substitute an iid interval/
  );
  assert.equal(SWEEP_BOUND_MINIMUM_ROUNDS, 4);
});

test("the bound computes only over what the sources actually say: the reviewed forgeries are refused", () => {
  const entry = (artifact) => ({ artifact, bytes: JSON.stringify(artifact) });
  const roundEntriesOf = (list) => list.map((artifact) => ({ bytes: JSON.stringify(artifact) }));
  const honest = [
    passArtifact(1, "2026-08-23T01:00:00.000Z"),
    passArtifact(2, "2026-08-25T02:00:00.000Z"),
    passArtifact(3, "2026-08-26T03:00:00.000Z"),
    passArtifact(4, "2026-08-27T04:00:00.000Z")
  ];

  // FORGERY 1: round 3 one hour after round 2. Assembly refuses those
  // artifacts outright, and a receipt CLAIMING them (built by bypassing
  // assembly) cannot survive the bound's reassembly, because the same
  // artifacts refuse to reassemble.
  const oneHour = [
    honest[0],
    honest[1],
    passArtifact(3, "2026-08-25T03:00:00.000Z"),
    passArtifact(4, "2026-08-27T04:00:00.000Z")
  ];
  const forgedChronology = buildReliabilitySweepReceipt({
    studyId: honest[0].studyId,
    sweptAt: "2026-08-27T05:00:00.000Z",
    measurementCondition: honest[0].measurementCondition,
    candidateSetDigest: honest[0].candidateSetDigest,
    sourceDigests: Object.fromEntries([
      ["candidate-set", honest[0].candidateSetDigest],
      ...oneHour.map((artifact) => [`round-${artifact.pass}-artifact`, "a".repeat(64)])
    ]),
    identity: honest[0].identity,
    outcomes: oneHour.flatMap((artifact) => artifact.outcomes)
  });
  assert.throws(
    () =>
      computeClusterLossBound({
        candidateSetBytes: CANDIDATE_BYTES,
        roundEntries: roundEntriesOf(oneHour),
        receiptBytes: serializeReliabilitySweepReceipt(forgedChronology)
      }),
    /disjoint sessions/
  );

  // FORGERY 2: a canonical receipt whose candidate-set source digest
  // disagrees with its candidateSetDigest. Reassembly from the real
  // candidate bytes produces the true digest pair, so byte equality fails.
  const genuine = assembleReceiptFromRounds({
    rounds: honest.map(entry),
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-27T05:00:00.000Z"
  });
  const tampered = JSON.parse(serializeReliabilitySweepReceipt(genuine));
  tampered.sourceDigests["candidate-set"] = "b".repeat(64);
  assert.throws(
    () =>
      computeClusterLossBound({
        candidateSetBytes: CANDIDATE_BYTES,
        roundEntries: roundEntriesOf(honest),
        receiptBytes: serializeReliabilitySweepReceipt(tampered)
      }),
    /not the assembly of the supplied candidate set and round artifacts/
  );

  // And the honest set still computes.
  const artifact = computeClusterLossBound({
    candidateSetBytes: CANDIDATE_BYTES,
    roundEntries: roundEntriesOf(honest),
    receiptBytes: serializeReliabilitySweepReceipt(genuine)
  });
  assert.equal(artifact.rounds, 4);
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

test("the receipt validator reconstructs, so a tampered receipt cannot reach the bound", () => {
  const entry = (artifact) => ({ artifact, bytes: JSON.stringify(artifact) });
  const at = [
    "2026-08-23T01:00:00.000Z",
    "2026-08-25T02:00:00.000Z",
    "2026-08-26T03:00:00.000Z",
    "2026-08-27T04:00:00.000Z"
  ];
  const receipt = assembleReceiptFromRounds({
    rounds: at.map((when, index) => entry(passArtifact(index + 1, when))),
    candidateSetBytes: CANDIDATE_BYTES,
    sweptAt: "2026-08-27T05:00:00.000Z"
  });
  const bytes = serializeReliabilitySweepReceipt(receipt);
  assert.equal(validateSweepReceipt(receipt, bytes), receipt);

  // Non-canonical bytes are refused even when they parse to the same object.
  assert.throws(
    () => validateSweepReceipt(receipt, bytes + "\n"),
    /not the canonical serialization/
  );
  const canonical = (tampered) =>
    validateSweepReceipt(tampered, serializeReliabilitySweepReceipt(tampered));
  // Kind, identity, condition, candidate digest: each binding refuses.
  assert.throws(() => canonical({ ...receipt, kind: "something-else" }), /kind mismatch/);
  assert.throws(
    () => canonical({ ...receipt, identity: { ...receipt.identity, buildCommit: "short" } }),
    /full lowercase git sha/
  );
  assert.throws(
    () =>
      canonical({
        ...receipt,
        measurementCondition: { ...receipt.measurementCondition, gpcEnabled: "yes" }
      }),
    /condition requires/
  );
  assert.throws(
    () => canonical({ ...receipt, candidateSetDigest: "nope" }),
    /candidate-set digest/
  );
  // Source digests must match the rounds actually present, both directions.
  const missingDigest = { ...receipt, sourceDigests: { ...receipt.sourceDigests } };
  delete missingDigest.sourceDigests["round-4-artifact"];
  assert.throws(() => canonical(missingDigest), /do not match the rounds present/);
  const extraDigest = {
    ...receipt,
    sourceDigests: { ...receipt.sourceDigests, "round-9-artifact": "a".repeat(64) }
  };
  assert.throws(() => canonical(extraDigest), /do not match the rounds present/);
  // Derived facts are RECOMPUTED: an upgraded eligibility flag, an inflated
  // count, and a gutted diagnostic each fail reconstruction.
  const upgraded = JSON.parse(JSON.stringify(receipt));
  upgraded.cases[0].eligible = !upgraded.cases[0].eligible;
  assert.throws(() => canonical(upgraded), /its passes derive/);
  assert.throws(
    () => canonical({ ...receipt, eligibleCandidates: receipt.eligibleCandidates + 1 }),
    /eligibleCandidates mismatch/
  );
  const gutted = JSON.parse(JSON.stringify(receipt));
  gutted.diagnostics.allFamiliesCompleteBothPasses = 0;
  assert.throws(() => canonical(gutted), /do not reconstruct/);
  // A smuggled top-level field is refused.
  assert.throws(() => canonical({ ...receipt, note: "trust me" }), /unexpected field "note"/);
});
