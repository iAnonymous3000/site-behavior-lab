import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  BARE_LOAD_OUTCOME_FIELDS,
  EXPECTED_EVIDENCE_FAMILIES,
  SWEEP_MINIMUM_PASS_SEPARATION_MS,
  assertBareLoadOnly,
  bareLoadOutcome,
  bareLoadPassSound,
  buildReliabilitySweepReceipt,
  candidateEligible,
  serializeReliabilitySweepReceipt
} from "./calibration-reliability-sweep-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const PASS_1 = "2026-08-16T00:00:00.000Z";
const PASS_2 = "2026-08-18T01:00:00.000Z"; // > 48h after PASS_1

/**
 * A report shaped like the real thing: a sound visit AND populated detector
 * evidence. If any of that evidence can reach a projection or a receipt, the
 * sweep can select on the detector's own answers and the preregistration is
 * void.
 */
function soundReport(runOverrides = {}) {
  return {
    run: {
      summary: { status: 200, pageTitle: "Example" },
      qualityFacts: {
        status: 200,
        navigationSettled: true,
        botWallTitleMatched: false,
        budgetsExhausted: [],
        captureLoss: []
      },
      warnings: [],
      quality: {
        run: { outcome: "complete" },
        byFamily: {
          requests: { outcome: "complete", reasons: [] },
          cookies: { outcome: "complete", reasons: [] },
          storage: { outcome: "complete", reasons: [] },
          fingerprinting: { outcome: "complete", reasons: [] },
          "detector-output": { outcome: "complete", reasons: [] },
          "consent-verification": { outcome: "complete", reasons: [] }
        }
      },
      evidence: {
        cnameCloaks: [
          { host: "metrics.example.com", target: "collect.tracker.example", service: "Tracker Co" }
        ],
        pixelEvents: [{ platform: "meta", event: "PageView" }],
        requests: [{ url: "https://collect.tracker.example/p", domain: "collect.tracker.example" }]
      },
      ...runOverrides
    }
  };
}

const project = (caseId, report, pass, observedAt) =>
  bareLoadOutcome(caseId, report, { pass, observedAt });

function receiptArgs(overrides = {}) {
  return {
    studyId: "cname-uncloaking-2026-08",
    sweptAt: PASS_2,
    measurementCondition: { device: "desktop", consentMode: "observe", gpcEnabled: false },
    candidateSetDigest: "a".repeat(64),
    sourceDigests: { candidates: "b".repeat(64) },
    identity: {
      buildCommit: "c".repeat(40),
      runtime: "node-24.14.1",
      runnerLabel: "controlled-self-hosted",
      egress: "controlled-self-hosted"
    },
    ...overrides
  };
}

test("a projection strips detector evidence from a report that has plenty", () => {
  const outcome = project("case-a", soundReport(), 1, PASS_1);
  assert.deepEqual(Object.keys(outcome).sort(), [...BARE_LOAD_OUTCOME_FIELDS].sort());
  assert.equal(outcome.loaded, true);
  assert.equal(outcome.navigationSettled, true);

  // Serializing is the honest check: a nested leak would survive a key compare.
  const serialized = JSON.stringify(outcome);
  for (const forbidden of [
    "cnameCloaks",
    "pixelEvents",
    "metrics.example.com",
    "collect.tracker.example",
    "Tracker Co",
    "PageView"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `projected outcome leaked "${forbidden}"`);
  }
});

test("the projection refuses a widened field set instead of admitting it", () => {
  assert.throws(
    () => assertBareLoadOnly({ caseId: "case-a", loaded: true, cnameCloaks: [] }),
    /carries "cnameCloaks", which is not a bare-load field/
  );
  assert.throws(() => assertBareLoadOnly({ caseId: "case-a", detected: true }), /carries "detected"/);
});

test("every soundness clause demands positive evidence and fails closed", () => {
  // THE REGRESSION THIS SUITE EXISTS FOR. The first version defaulted
  // navigationSettled, runOutcome and requestEvidenceComplete to the PASSING
  // value, so a report carrying nothing but a 200 came out sound. Absence of
  // evidence is not evidence of soundness.
  const bare = project("case-x", { run: { summary: { status: 200 } } }, 1, PASS_1);
  assert.equal(bare.loaded, false, "no quality ledger means the visit was not verified");
  assert.equal(bare.navigationSettled, false);
  assert.equal(bare.subjectVerified, false);
  assert.equal(bare.botWalled, true);
  assert.equal(bare.runOutcome, "unavailable");
  assert.equal(bare.requestEvidenceComplete, false);
  assert.equal(bareLoadPassSound(bare), false);

  assert.equal(bareLoadPassSound(project("case-a", soundReport(), 1, PASS_1)), true);

  // Each clause independently sinks an otherwise-sound visit.
  const cases = [
    ["a 3xx-only status", { summary: { status: 500 } }],
    [
      "unsettled navigation",
      { qualityFacts: { navigationSettled: false, botWallTitleMatched: false, captureLoss: [] } }
    ],
    [
      "an unverified page subject",
      {
        qualityFacts: {
          navigationSettled: true,
          botWallTitleMatched: false,
          captureLoss: [{ family: "requests", kind: "dropped", count: 1, detail: "page-subject-validity" }]
        }
      }
    ],
    [
      "a bot wall recorded in qualityFacts",
      { qualityFacts: { navigationSettled: true, botWallTitleMatched: true, captureLoss: [] } }
    ],
    [
      "a report with no qualityFacts at all",
      { qualityFacts: undefined }
    ],
    [
      "an incomplete run",
      { quality: { run: { outcome: "failed" }, byFamily: { requests: { outcome: "complete" } } } }
    ],
    [
      "censored request evidence",
      { quality: { run: { outcome: "complete" }, byFamily: { requests: { outcome: "censored" } } } }
    ],
    [
      "any censored family at all",
      {
        quality: {
          run: { outcome: "complete" },
          byFamily: {
            requests: { outcome: "complete" },
            fingerprinting: { outcome: "censored" }
          }
        }
      }
    ]
  ];
  for (const [label, override] of cases) {
    assert.equal(
      bareLoadPassSound(project("case-a", soundReport(override), 1, PASS_1)),
      false,
      `${label} must not be sound`
    );
  }
});

test("a candidate needs two sound passes at least 48 hours apart", () => {
  const sound = (pass, at) => project("case-a", soundReport(), pass, at);
  assert.equal(candidateEligible([sound(1, PASS_1), sound(2, PASS_2)]), true);

  // One pass says nothing about reliability.
  assert.equal(candidateEligible([sound(1, PASS_1)]), false, "a single pass is not screening");

  // Two passes an hour apart mostly re-measure one cache state.
  assert.equal(
    candidateEligible([sound(1, PASS_1), sound(2, "2026-08-16T01:00:00.000Z")]),
    false,
    "passes closer than 48h do not establish reliability"
  );
  assert.equal(SWEEP_MINIMUM_PASS_SEPARATION_MS, 48 * 60 * 60 * 1000);

  // A failed second pass disqualifies even when the first was clean.
  const failed = project("case-a", soundReport({ summary: { status: 403 } }), 2, PASS_2);
  assert.equal(candidateEligible([sound(1, PASS_1), failed]), false);

  assert.throws(
    () => candidateEligible([sound(1, PASS_1), sound(1, PASS_2)]),
    /duplicate pass 1/
  );
  assert.throws(() => candidateEligible([soundReport()]), /not a bare-load field/);
});

test("canonical producer facts outrank warning prose", () => {
  // REGRESSION. The first version inferred bot walls and subject verification
  // from warning STRINGS while the report carried qualityFacts.botWallTitleMatched
  // and a page-subject-validity capture-loss entry. This module runs no semantic
  // r2 validation, so prose was all it consulted -- and a report whose own
  // evaluator recorded a bot wall passed as sound.
  const botWalled = soundReport({
    warnings: [],
    qualityFacts: {
      status: 200,
      navigationSettled: true,
      botWallTitleMatched: true,
      budgetsExhausted: [],
      captureLoss: []
    }
  });
  const outcome = project("case-w", botWalled, 1, PASS_1);
  assert.equal(outcome.botWalled, true, "the producer's own bot-wall verdict is the answer");
  assert.equal(bareLoadPassSound(outcome), false);

  // And the inverse: reassuring prose cannot rescue a recorded bot wall.
  const withCalmWarnings = soundReport({
    warnings: ["everything was completely fine"],
    qualityFacts: {
      status: 200,
      navigationSettled: true,
      botWallTitleMatched: true,
      budgetsExhausted: [],
      captureLoss: []
    }
  });
  assert.equal(bareLoadPassSound(project("case-w2", withCalmWarnings, 1, PASS_1)), false);

  // An absent botWallTitleMatched is not a clean bill of health.
  const noVerdict = soundReport({
    qualityFacts: { navigationSettled: true, captureLoss: [] }
  });
  assert.equal(project("case-w3", noVerdict, 1, PASS_1).botWalled, true);
});

test("the subject-validity token matches the producer that writes it", () => {
  // One token restated in two files that drift is this repository's most common
  // defect, so bind the sweep's copy to lib/bot-wall-classifier.ts.
  const classifier = readFileSync(
    path.join(moduleDir, "..", "lib", "bot-wall-classifier.ts"),
    "utf8"
  );
  const declared = classifier.match(
    /PAGE_SUBJECT_CAPTURE_LOSS_DETAIL\s*=\s*"([^"]+)"/
  )?.[1];
  assert.equal(declared, "page-subject-validity");
  const sweep = readFileSync(
    path.join(moduleDir, "calibration-reliability-sweep-lib.mjs"),
    "utf8"
  );
  assert.ok(
    sweep.includes(`PAGE_SUBJECT_CAPTURE_LOSS_DETAIL = "${declared}"`),
    "the sweep must read the same page-subject token the producer writes"
  );
});

test("the 48-hour rule is directed: pass 2 must follow pass 1", () => {
  // REGRESSION. Math.abs accepted pass 2 occurring 48 hours BEFORE pass 1,
  // which is not a screening interval -- it is two visits labelled out of
  // order, qualifying a candidate on a chronology that never happened.
  const p1Late = project("case-r", soundReport(), 1, "2026-08-18T00:00:00.000Z");
  const p2Early = project("case-r", soundReport(), 2, "2026-08-16T00:00:00.000Z");
  assert.equal(
    candidateEligible([p1Late, p2Early]),
    false,
    "a reversed chronology must never qualify"
  );
  // Same instants in the correct order do qualify.
  assert.equal(
    candidateEligible([
      project("case-r", soundReport(), 1, "2026-08-16T00:00:00.000Z"),
      project("case-r", soundReport(), 2, "2026-08-18T00:00:00.000Z")
    ]),
    true
  );
});

test("the recorded facts ledger is consulted, not just the derived family view", () => {
  // REGRESSION. `quality.byFamily` is DERIVED; `qualityFacts` is what the
  // producer RECORDED. This module runs no semantic r2 validation, so it cannot
  // assume they agree -- and it previously trusted the derived view alone while
  // defaulting an absent captureLoss array to [], i.e. "nothing was lost".
  const completeLedger = Object.fromEntries(
    EXPECTED_EVIDENCE_FAMILIES.map((family) => [family, { outcome: "complete", reasons: [] }])
  );
  const withFacts = (qualityFacts) => ({
    run: {
      summary: { status: 200 },
      warnings: [],
      qualityFacts,
      quality: { run: { outcome: "complete" }, byFamily: completeLedger }
    }
  });
  const sound = (report) => bareLoadPassSound(project("case-f", report, 1, PASS_1));

  // 1. An absent captureLoss array is a MISSING ledger, not an empty one.
  const absentLedger = withFacts({
    status: 200,
    navigationSettled: true,
    botWallTitleMatched: false
  });
  assert.equal(
    sound(absentLedger),
    false,
    "an absent captureLoss array must not read as 'nothing was lost'"
  );
  // The PUBLISHED field must also be false, not merely the eligibility verdict.
  // A receipt saying subjectVerified: true for a visit whose producer recorded
  // no ledger is a false statement in an artifact, even where the candidate was
  // rejected for another reason.
  const projected = project("case-f", absentLedger, 1, PASS_1);
  assert.equal(projected.factsLedgerRecorded, false);
  assert.equal(
    projected.subjectVerified,
    false,
    "subject verification cannot be asserted from a ledger that was never recorded"
  );

  // 2. A canonical capture loss beside a stale "complete" family ledger.
  assert.equal(
    sound(
      withFacts({
        status: 200,
        navigationSettled: true,
        botWallTitleMatched: false,
        budgetsExhausted: [],
        captureLoss: [{ family: "requests", kind: "cap", count: 74, detail: "request-capture" }]
      })
    ),
    false,
    "a recorded capture loss outranks a derived ledger claiming completeness"
  );

  // 3. An exhausted budget beside a stale "complete" family ledger.
  assert.equal(
    sound(
      withFacts({
        status: 200,
        navigationSettled: true,
        botWallTitleMatched: false,
        budgetsExhausted: ["request-capture"],
        captureLoss: []
      })
    ),
    false,
    "a recorded exhausted budget outranks a derived ledger claiming completeness"
  );

  // Control: both ledgers present and both clean.
  assert.equal(
    sound(
      withFacts({
        status: 200,
        navigationSettled: true,
        botWallTitleMatched: false,
        budgetsExhausted: [],
        captureLoss: []
      })
    ),
    true
  );

  // The counts are exposed so a receipt shows WHY a candidate was rejected,
  // without naming which families or budgets (that would leak toward detectors).
  const rejected = project(
    "case-f",
    withFacts({
      status: 200,
      navigationSettled: true,
      botWallTitleMatched: false,
      budgetsExhausted: ["request-capture"],
      captureLoss: [{ family: "requests", kind: "cap", count: 74, detail: "request-capture" }]
    }),
    1,
    PASS_1
  );
  assert.equal(rejected.factsLedgerRecorded, true);
  assert.equal(rejected.recordedCaptureLosses, 1);
  assert.equal(rejected.budgetsExhausted, 1);
  assert.equal(JSON.stringify(rejected).includes("request-capture"), false, "counts only, no tokens");
});

test("the summary and the recorded facts must agree about one visit", () => {
  // REGRESSION. Two statements about the same visit. This module runs no
  // semantic validation, so it cannot adjudicate a disagreement -- and it must
  // not silently pick the reassuring one. A summary reading 200 beside a
  // recorded 403 previously passed as sound.
  const disagreeing = soundReport({
    summary: { status: 200 },
    qualityFacts: {
      status: 403,
      navigationSettled: true,
      botWallTitleMatched: false,
      budgetsExhausted: [],
      captureLoss: []
    }
  });
  const outcome = project("case-s", disagreeing, 1, PASS_1);
  assert.equal(outcome.statusAgrees, false);
  assert.equal(bareLoadPassSound(outcome), false, "a disagreement is unverified, not a 200");

  // A recorded status that is simply absent is also a disagreement.
  const absent = soundReport({
    qualityFacts: {
      navigationSettled: true,
      botWallTitleMatched: false,
      budgetsExhausted: [],
      captureLoss: []
    }
  });
  assert.equal(project("case-s2", absent, 1, PASS_1).statusAgrees, false);

  assert.equal(project("case-s3", soundReport(), 1, PASS_1).statusAgrees, true);
});

test("every expected evidence family must have reported complete", () => {
  // REGRESSION. A ledger carrying only `requests` is a producer that never
  // reported on the other five, not a clean run. Counting censored entries
  // cannot see it: there is nothing there to count.
  const partial = (families) =>
    soundReport({
      quality: {
        run: { outcome: "complete" },
        byFamily: Object.fromEntries(
          families.map((family) => [family, { outcome: "complete", reasons: [] }])
        )
      }
    });

  const requestsOnly = project("case-p", partial(["requests"]), 1, PASS_1);
  assert.equal(requestsOnly.familyLedgerComplete, false);
  assert.equal(requestsOnly.censoredFamilyCount, 0, "the old rule saw nothing wrong here");
  assert.equal(requestsOnly.requestEvidenceComplete, true, "and the old rule called it complete");
  assert.equal(bareLoadPassSound(requestsOnly), false);

  // Every single omission is caught, not just a wholesale one.
  for (const omitted of EXPECTED_EVIDENCE_FAMILIES) {
    const rest = EXPECTED_EVIDENCE_FAMILIES.filter((family) => family !== omitted);
    assert.equal(
      bareLoadPassSound(project("case-p", partial(rest), 1, PASS_1)),
      false,
      `a ledger missing ${omitted} must not be sound`
    );
  }

  assert.equal(bareLoadPassSound(project("case-p", partial([...EXPECTED_EVIDENCE_FAMILIES]), 1, PASS_1)), true);
});

test("the expected family list matches the schema that defines it", () => {
  const schema = readFileSync(path.join(moduleDir, "..", "lib", "scan-report-v2.ts"), "utf8");
  const declared = schema
    .match(/export const EVIDENCE_FAMILIES[^=]*=\s*\[([^\]]+)\]/)?.[1]
    ?.match(/"([^"]+)"/g)
    ?.map((entry) => entry.replaceAll('"', ""));
  assert.deepEqual(
    [...EXPECTED_EVIDENCE_FAMILIES].sort(),
    [...(declared ?? [])].sort(),
    "the sweep's family list must track EVIDENCE_FAMILIES, not drift from it"
  );
});

test("a missing or unusable report is recorded as a failed pass, never skipped", () => {
  // Silently dropping unloadable cases biases the frame toward sites that
  // happen to cooperate, which is the same selection hazard by another route.
  const missing = project("case-c", null, 1, PASS_1);
  assert.equal(missing.runOutcome, "unavailable");
  assert.equal(bareLoadPassSound(missing), false);
});

test("the projection refuses an unlabelled pass or timestamp", () => {
  // Without these the receipt cannot prove the 48-hour separation it claims.
  assert.throws(() => bareLoadOutcome("case-a", soundReport(), {}), /explicit sweep pass number/);
  assert.throws(
    () => bareLoadOutcome("case-a", soundReport(), { pass: 3, observedAt: PASS_1 }),
    /explicit sweep pass number/
  );
  assert.throws(
    () => bareLoadOutcome("case-a", soundReport(), { pass: 1, observedAt: "yesterday" }),
    /ISO-8601 UTC observedAt/
  );
});

test("the receipt binds the sweep to a candidate set, condition, and producer", () => {
  // A receipt recording only outcomes cannot be checked against the frame later
  // frozen from it: it cannot say WHICH pool was swept, under WHAT condition,
  // by WHICH build.
  const receipt = buildReliabilitySweepReceipt(
    receiptArgs({
      outcomes: [
        project("case-b", soundReport(), 2, PASS_2),
        project("case-a", soundReport(), 1, PASS_1),
        project("case-a", soundReport(), 2, PASS_2),
        project("case-b", soundReport(), 1, PASS_1),
        project("case-c", null, 1, PASS_1)
      ]
    })
  );

  assert.equal(receipt.observedCandidates, 3);
  assert.equal(receipt.eligibleCandidates, 2);
  assert.equal(receipt.candidateSetDigest, "a".repeat(64));
  assert.deepEqual(receipt.measurementCondition, {
    device: "desktop",
    consentMode: "observe",
    gpcEnabled: false
  });
  assert.equal(receipt.identity.runnerLabel, "controlled-self-hosted");
  assert.equal(receipt.minimumPassSeparationMs, SWEEP_MINIMUM_PASS_SEPARATION_MS);
  assert.deepEqual(receipt.cases.map((entry) => entry.caseId), ["case-a", "case-b", "case-c"]);

  // No pass/fail: clearing the pool is a preregistered human threshold.
  assert.equal("cleared" in receipt, false);
  assert.equal("passed" in receipt, false);

  const serialized = JSON.stringify(receipt);
  for (const forbidden of ["cnameCloaks", "pixelEvents", "collect.tracker.example", "PageView"]) {
    assert.equal(serialized.includes(forbidden), false, `receipt leaked "${forbidden}"`);
  }
});

test("the receipt refuses inputs that would make it unfalsifiable", () => {
  const ok = project("case-a", soundReport(), 1, PASS_1);
  const missing = (field) => {
    const args = receiptArgs({ outcomes: [ok] });
    delete args[field];
    return args;
  };
  assert.throws(() => buildReliabilitySweepReceipt(missing("candidateSetDigest")), /candidate set/);
  assert.throws(
    () => buildReliabilitySweepReceipt(missing("measurementCondition")),
    /exact measurement condition/
  );
  assert.throws(() => buildReliabilitySweepReceipt(missing("sourceDigests")), /digests of the sources/);
  assert.throws(() => buildReliabilitySweepReceipt(missing("identity")), /producer identity/);
  assert.throws(
    () =>
      buildReliabilitySweepReceipt(
        receiptArgs({ outcomes: [ok], identity: { buildCommit: "c".repeat(40) } })
      ),
    /identity requires runtime/
  );
  assert.throws(
    () => buildReliabilitySweepReceipt(receiptArgs({ outcomes: [] })),
    /observed no cases/
  );
  assert.throws(
    () => buildReliabilitySweepReceipt(receiptArgs({ outcomes: [ok, ok] })),
    /duplicate pass 1/
  );
  assert.throws(
    () => buildReliabilitySweepReceipt(receiptArgs({ outcomes: [soundReport()] })),
    /not a bare-load field/
  );
});

test("receipt bytes are canonical, so two identical sweeps are byte-identical", () => {
  const build = () =>
    buildReliabilitySweepReceipt(
      receiptArgs({
        outcomes: [project("case-a", soundReport(), 1, PASS_1), project("case-a", soundReport(), 2, PASS_2)]
      })
    );
  const first = serializeReliabilitySweepReceipt(build());
  assert.equal(first, serializeReliabilitySweepReceipt(build()));
  const keys = Object.keys(JSON.parse(first));
  assert.deepEqual(keys, [...keys].sort(), "receipt keys are sorted at the top level");
  assert.equal(first.endsWith("\n"), true);
});

test("the sweep module never names a detector evidence field in its source", () => {
  // Layer three. The projection could be correct today and a later edit could
  // reach into evidence directly; this reads the module the way the repo's
  // other source-binding guards do, so that edit fails here.
  const source = readFileSync(path.join(moduleDir, "calibration-reliability-sweep-lib.mjs"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
    .join("\n");
  for (const forbidden of [
    "cnameCloaks",
    "pixelEvents",
    "keystroke",
    "fingerprintEvents",
    "policyClaims",
    "consentObservations",
    "trackerMatches"
  ]) {
    assert.equal(
      code.includes(forbidden),
      false,
      `sweep source reads "${forbidden}"; the sweep must never observe detector output`
    );
  }
  assert.equal(code.includes(".evidence"), false, "sweep source must not reach into run.evidence");
});
