/**
 * Acceptance tests for the foundation-hardening patch (v2 RFC review,
 * 2026-07-09): closed diff boundary, deep default-deny validation, semantic
 * reject-on-read, hardened v1 boundary, and the consumer seam.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeEphemeralSingleReport,
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeScanReportV1,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import { isPublicComparisonReportV2, isPublicScanReportV2, isPublicSingleReportV2 } from "./scan-report-v2-validation";
import { readStoredScanReport } from "./scan-report-reader";
import { readScanTransportPayload, toReportView } from "./scan-report-view";
import { evaluateComparability, evaluateQuality } from "./scan-report-v2-evaluators";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { makeScanRunV2 } from "./scan-report-v2-fixtures";
import { sha256Hex } from "./sha256";

function mutate<T>(fixture: T, apply: (draft: T) => void): T {
  const draft = structuredClone(fixture);
  apply(draft);
  return draft;
}

type AnyRecord = Record<string, any>;

test("a secret smuggled under diff is rejected by validation", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    (draft.diff as AnyRecord).screenshot = "SECRET";
  });
  assert.equal(isPublicComparisonReportV2(report), false);

  const nested = mutate(makeInterventionComparisonReportV2(), (draft) => {
    (draft.diff.families["raw-counts"] as AnyRecord).screenshot = "SECRET";
  });
  assert.equal(isPublicComparisonReportV2(nested), false);
});

test("a forged diff that does not derive from the runs reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    draft.diff.families["raw-counts"].metrics.totalRequests.delta = 999;
  });
  assert.equal(isPublicComparisonReportV2(report), true); // structurally fine
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("unknown fields in every nested evidence record are rejected", () => {
  const injections: Array<(draft: ReturnType<typeof makePublicSingleReportV2>) => void> = [
    (draft) => ((draft.run.evidence.requests[0] as AnyRecord).rawHeaders = { cookie: "SECRET" }),
    (draft) => ((draft.run.evidence.requests[0].tracker as AnyRecord) = { domain: "t.example", entity: "T", category: "ads", confidence: "curated", extra: 1 }),
    (draft) => draft.run.evidence.cookiesFinal.push({ extra: true } as AnyRecord as never),
    (draft) => draft.run.evidence.storageFinal.push({ area: "localStorage", key: "k", valueBytes: 1, extra: 1 } as AnyRecord as never),
    (draft) => draft.run.evidence.fingerprintEvents.push({ api: "canvas", count: 1, phaseId: 0, extra: 1 } as AnyRecord as never),
    (draft) =>
      draft.run.evidence.cnameCloaks.push({ host: "a.example.com", cname: "t.tracker.example", tracker: { domain: "t", entity: "T", category: "c", confidence: "curated" }, extra: 1 } as AnyRecord as never),
    (draft) =>
      draft.run.evidence.pixelEvents.push({ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: ["not-a-field"], requests: 1, phaseId: 0 } as AnyRecord as never),
    (draft) =>
      ((draft.run.evidence as AnyRecord).privacyPolicy = { url: "https://example.com/privacy", claims: [{ kind: "made-up-claim", quote: "q" }], mentionedEntities: [], unmentionedEntities: [], policyTextLength: 10 }),
    (draft) =>
      draft.run.evidence.cookieMutations.push({ phaseId: 0, op: "added", cookie: { name: "a", domain: "example.com", path: "/", sameSite: "Lax", secure: true, httpOnly: false, session: true, thirdParty: false }, extra: 1 } as AnyRecord as never),
    (draft) => ((draft.run.qualityFacts.captureLoss as AnyRecord[]).push({ family: "requests", phaseId: 0, kind: "cap", count: 1, detail: "NOT A CODE!" }))
  ];
  for (const [index, inject] of injections.entries()) {
    const report = mutate(makePublicSingleReportV2(), inject);
    assert.equal(isPublicSingleReportV2(report), false, `injection ${index} was accepted`);
  }

  // A request that is nothing but a phaseId and a smuggled field.
  const skeletonRequest = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.evidence.requests as AnyRecord[])[0] = { phaseId: 0, screenshot: "SECRET" };
  });
  assert.equal(isPublicSingleReportV2(skeletonRequest), false);
});

test("raw CMP payloads cannot ship in consent observations", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.evidence as AnyRecord).consent = {
      mode: "reject-all",
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [
        { phaseId: 0, method: "onetrust-cookie@1", observed: "groups=C0001:1,C0002:0", consistentWithChoice: true }
      ],
      choiceState: "verified",
      reverifiedAfterReload: false
    };
  });
  assert.equal(isPublicSingleReportV2(report), false);
});

test("a malformed v1 upload returns a typed error without crashing", () => {
  const nullRequest = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).requests = [null];
  });
  assert.deepEqual(readStoredScanReport(nullRequest), { ok: false, error: "invalid" });

  const namelessCookie = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).cookies = [{ domain: 3 }];
  });
  assert.deepEqual(readStoredScanReport(namelessCookie), { ok: false, error: "invalid" });

  const stringSummary = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).summary.totalRequests = "12";
  });
  assert.deepEqual(readStoredScanReport(stringSummary), { ok: false, error: "invalid" });
});

test("non-canonical timestamps and inverted phase spans read as inconsistent", () => {
  const sloppyTimestamp = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.startedAt = "2026-07-09T10:00:00Z"; // parseable but not canonical ISO
  });
  const read1 = readStoredScanReport(sloppyTimestamp);
  assert.equal(read1.ok, false);
  if (!read1.ok) assert.equal(read1.error, "inconsistent");

  const invertedPhase = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.phases[0] = { phaseId: 0, kind: "passive-load", startedAtMs: 5000, endedAtMs: 0 };
  });
  const read2 = readStoredScanReport(invertedPhase);
  assert.equal(read2.ok, false);
  if (!read2.ok) assert.equal(read2.error, "inconsistent");
});

test("a Shields experiment with no Shields condition delta reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    draft.variant.conditions.shields = "classification"; // same as baseline
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("an arm whose axis differs from the experiment reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.verification.baseline.axis = "gpc";
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("a forged interventionVerified reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") {
      draft.experiment.verification.variant.observed = null;
      draft.experiment.verification.variant.outcome = "inconclusive";
    }
    // comparability.interventionVerified stays true: the forgery.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("comparability")), true);
  }
});

test("quality that disagrees with qualityFacts reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.status = 403; // facts say failed load
    draft.run.summary.status = 403;
    // quality.run.outcome stays "complete": the forgery.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("toReportView marks v1 as legacy-derived and v2 as v2", () => {
  const v1 = readStoredScanReport(makeScanReportV1());
  assert.equal(v1.ok, true);
  if (v1.ok) {
    const view = toReportView(v1.stored);
    assert.equal(view.origin, "legacy-derived");
    assert.equal(view.domain, "example.com");
    assert.equal(view.runs.length, 1);
  }

  const v2 = readStoredScanReport(makeTemporalComparisonReportV2());
  assert.equal(v2.ok, true);
  if (v2.ok) {
    const view = toReportView(v2.stored);
    assert.equal(view.origin, "v2");
    assert.equal(view.comparison?.kind, "temporal");
    assert.equal(view.comparison?.interventionVerified, null);
    assert.equal(view.comparison?.familiesEligible?.["raw-counts"], true);
  }
});

test("transport: errors, job submissions, and reports are distinguished without payload.ok sniffing", () => {
  assert.deepEqual(readScanTransportPayload({ ok: false, error: "Turnstile verification is required." }), {
    kind: "api-error",
    message: "Turnstile verification is required."
  });

  const job = readScanTransportPayload({ jobId: "job-1", status: "queued", statusPath: "/api/scans/job-1", reportId: "r-1" });
  assert.deepEqual(job, {
    kind: "job-pending",
    status: "queued",
    jobId: "job-1",
    statusPath: "/api/scans/job-1",
    reportId: "r-1",
    progress: null
  });

  const v1 = readScanTransportPayload(makeScanReportV1());
  assert.equal(v1.kind, "report");
  if (v1.kind === "report") assert.equal(v1.loaded.source, "v1");

  const v2 = readScanTransportPayload(makePublicSingleReportV2());
  assert.equal(v2.kind, "report");
  if (v2.kind === "report") assert.equal(v2.loaded.source, "v2-public");
});

test("ephemeral screenshots survive only the immediate result, never the public wire report", () => {
  const result = readScanTransportPayload(makeEphemeralSingleReport());
  assert.equal(result.kind, "report");
  if (result.kind !== "report" || result.loaded.source !== "v2-ephemeral") {
    assert.fail("expected an ephemeral report");
  }
  // The immediate-response wire still carries the screenshot for the UI...
  assert.equal(JSON.stringify(result.loaded.wire).includes("AAAA"), true);
  // ...but the persistable/downloadable form never does.
  assert.equal(JSON.stringify(result.loaded.public).includes("AAAA"), false);
  assert.equal(JSON.stringify(result.loaded.public).includes("ephemeral"), false);
  assert.equal(isPublicScanReportV2(result.loaded.public), true);
  assert.equal(isPublicScanReportV2(result.loaded.wire), false);
});

// ---------------------------------------------------------------------------
// Integrity foundation (2026-07-09 follow-up review)
// ---------------------------------------------------------------------------

test("sha256 matches known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a forged fingerprint reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.fingerprints.measurementEnvironment = "f".repeat(64);
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("fingerprints")), true);
  }
});

test("tampered summary counts no longer reconcile with the evidence", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.counts.totalRequests = 12; // evidence records one request
    draft.run.summary.countsByPhase[0].totalRequests = 12;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("reconcile")), true);
  }
});

test("budget exhaustion must surface in quality", () => {
  const facts = { ...makeScanRunV2().qualityFacts, budgetsExhausted: ["keystroke-probe"] };
  const derived = evaluateQuality(facts, { observedRequests: 1 });
  assert.equal(derived.run.reasons.includes("budget-exhausted:keystroke-probe"), true);

  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.budgetsExhausted = ["keystroke-probe"];
    // quality left untouched: the silent absorption the review flagged.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("overlapping phase spans read as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.phases = [
      { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 5000 },
      { phaseId: 1, kind: "active-probe", startedAtMs: 4000, endedAtMs: 6000 } // overlaps phase 0
    ];
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("a detector reporting activity for a disabled probe reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.detectors["keystroke-exfiltration"] = { version: "1", status: "complete" };
    // probes.keystroke stays false.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("consent evidence on an observe-mode run reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.evidence as AnyRecord).consent = {
      mode: "reject-all",
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [],
      choiceState: "weak-signal",
      reverifiedAfterReload: false
    };
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("temporal eligibility requires equal condition fingerprints", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b", shields: "block-simulation" }); // a different condition vector
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.pairValidity.eligible, false);
  assert.equal(comparability.pairValidity.reasons.includes("dependency-digest-mismatch:conditionFingerprint"), true);
});

test("intervention eligibility requires equal measurement-environment fingerprints", () => {
  const baseline = makeScanRunV2({ runId: "a" });
  const variant = makeScanRunV2({ runId: "b", startedAt: "2026-07-09T10:01:00.000Z", shields: "block-simulation" });
  variant.conditions.locale = "de-DE"; // environment drift beyond the declared axis
  // Re-mint the fingerprints as a correct producer would; the drift must
  // surface through the fingerprint invariant, not a stale-digest violation.
  variant.fingerprints = buildFingerprints({
    conditions: variant.conditions,
    provenance: variant.provenance,
    toolchain: variant.toolchain,
    detectors: variant.detectors
  });
  const comparability = evaluateComparability(
    {
      kind: "intervention",
      axis: "shields",
      pairId: "p",
      order: "AB",
      verification: {
        baseline: { axis: "shields", expected: "shields:classification", observed: "shields:classification", method: "shields-engine-status@1", outcome: "passed", phaseId: 0 },
        variant: { axis: "shields", expected: "shields:block-simulation", observed: "shields:block-simulation", method: "shields-engine-status@1", outcome: "passed", phaseId: 0 }
      },
      evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
    },
    baseline,
    variant
  );
  assert.equal(comparability.pairValidity.eligible, false);
  assert.equal(comparability.pairValidity.reasons.includes("dependency-digest-mismatch:measurementEnvironment"), true);
});

test("a malformed ephemeral payload returns unreadable instead of throwing", () => {
  const result = readScanTransportPayload({
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "single",
    run: { runId: "not-a-real-run" },
    ephemeral: { screenshot: null }
  });
  assert.deepEqual(result, { kind: "unreadable", error: "invalid" });
});

test("async polling envelopes unwrap without payload.ok sniffing", () => {
  const succeeded = readScanTransportPayload({ status: "succeeded", report: makeScanReportV1() });
  assert.equal(succeeded.kind, "report");
  if (succeeded.kind === "report") assert.equal(succeeded.loaded.source, "v1");

  assert.deepEqual(readScanTransportPayload({ status: "failed", error: "target unreachable" }), {
    kind: "job-ended",
    status: "failed",
    message: "target unreachable"
  });

  const running = readScanTransportPayload({ status: "running", jobId: "job-9", progress: { step: "navigating" } });
  assert.equal(running.kind, "job-pending");
  if (running.kind === "job-pending") assert.deepEqual(running.progress, { step: "navigating" });
});

test("expired and cancelled jobs are meaningful states, not unreadable", () => {
  assert.deepEqual(readScanTransportPayload({ status: "expired", jobId: "job-2" }), {
    kind: "job-ended",
    status: "expired",
    message: "Scan job expired."
  });
  assert.deepEqual(readScanTransportPayload({ status: "cancelled", jobId: "job-3" }), {
    kind: "job-ended",
    status: "cancelled",
    message: "Scan job cancelled."
  });
});

// ---------------------------------------------------------------------------
// Final integrity patch (2026-07-09 pre-emission audit)
// ---------------------------------------------------------------------------

function remintFingerprints(run: ReturnType<typeof makeScanRunV2>): void {
  run.fingerprints = buildFingerprints({
    conditions: run.conditions,
    provenance: run.provenance,
    toolchain: run.toolchain,
    detectors: run.detectors
  });
}

/** A consistent consent-mode run: phased, verified, evaluator-minted blocks. */
function makeConsentRun(mode: "accept-all" | "reject-all") {
  const run = makeScanRunV2();
  run.conditions = { ...run.conditions, consent: mode };
  run.phases = [
    { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 2000 },
    { phaseId: 1, kind: "consent-interaction", startedAtMs: 2000, endedAtMs: 3000 },
    { phaseId: 2, kind: "post-choice-reload", startedAtMs: 3000, endedAtMs: 5000 }
  ];
  const observed = mode === "accept-all" ? ("accepted-all" as const) : ("rejected-all" as const);
  run.evidence = {
    ...run.evidence,
    consent: {
      mode,
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [
        { phaseId: 1, method: "onetrust-cookie@1", observed, consistentWithChoice: true },
        { phaseId: 2, method: "onetrust-cookie@1", observed, consistentWithChoice: true }
      ],
      choiceState: "verified",
      reverifiedAfterReload: true
    }
  };
  remintFingerprints(run);
  return run;
}

test("a consistent consent-mode run passes end to end", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run = makeConsentRun("reject-all");
  });
  const read = readStoredScanReport(report);
  assert.deepEqual(read.ok, true, JSON.stringify(!read.ok ? read.violations : []));
});

test("a Reject-all run whose interpreter read accepted-all cannot claim verification", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const run = makeConsentRun("reject-all");
    // The reproduced forgery: both observations actually read accepted-all,
    // yet claim consistency and a verified choice.
    run.evidence.consent!.verificationObservations = [
      { phaseId: 1, method: "onetrust-cookie@1", observed: "accepted-all", consistentWithChoice: true },
      { phaseId: 2, method: "onetrust-cookie@1", observed: "accepted-all", consistentWithChoice: true }
    ];
    draft.run = run;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("does not derive from its observed state")), true);
  }
});

test("a consent-mode run without consent evidence is rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.conditions = { ...draft.run.conditions, consent: "reject-all" };
    remintFingerprints(draft.run);
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("carries no consent evidence")), true);
  }
});

test("invented verification methods are rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const run = makeConsentRun("accept-all");
    run.evidence.consent!.verificationObservations[0].method = "magic@9";
    draft.run = run;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("unknown interpreter method")), true);
});

test("self-asserted evidence strength is rejected", () => {
  const forgedCounterbalance = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.evidence.counterbalanced = true; // pairs stays 1
  });
  const read1 = readStoredScanReport(forgedCounterbalance);
  assert.equal(read1.ok, false);
  if (!read1.ok) assert.equal(read1.error, "inconsistent");

  const forgedStrength = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.evidence.strength = "replicated-difference";
  });
  const read2 = readStoredScanReport(forgedStrength);
  assert.equal(read2.ok, false);
  if (!read2.ok) assert.equal(read2.error, "inconsistent");
});

test("consent arm failures censor the consent-verification family", () => {
  const baseline = makeConsentRun("accept-all");
  const variant = makeConsentRun("reject-all");
  variant.startedAt = "2026-07-09T10:01:00.000Z";
  const comparability = evaluateComparability(
    {
      kind: "intervention",
      axis: "consent",
      pairId: "p",
      order: "AB",
      verification: {
        baseline: { axis: "consent", expected: "consent:accept-all", observed: "consent:accept-all", method: "onetrust-cookie@1", outcome: "passed", phaseId: 2 },
        variant: { axis: "consent", expected: "consent:reject-all", observed: null, method: "onetrust-cookie@1", outcome: "inconclusive", phaseId: 2 }
      },
      evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
    },
    baseline,
    variant
  );
  assert.equal(comparability.perMetric["consent-verification"].eligible, false);
  assert.equal(
    comparability.perMetric["consent-verification"].reasons.includes("arm-verification-inconclusive:variant"),
    true
  );
  assert.equal(comparability.interventionVerified, false);
});

test("an exhausted budget without a captureLoss mapping is rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.budgetsExhausted = ["keystroke-probe"];
    draft.run.quality = evaluateQuality(draft.run.qualityFacts, { observedRequests: 1 }); // quality consistent
    // but no captureLoss entry maps the budget: the silent absorption.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("no corresponding captureLoss")), true);
});

test("JSON property order is non-semantic for derived-block equality", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const { execution, measurementEnvironment, condition } = draft.run.fingerprints;
    (draft.run as AnyRecord).fingerprints = { condition, execution, measurementEnvironment }; // reordered
  });
  assert.equal(readStoredScanReport(report).ok, true);
});

test("summary.status must equal qualityFacts.status", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.status = 204; // facts say 200
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("summary.status")), true);
});

test("countsByPhase cannot omit phases with observed requests", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.countsByPhase = [];
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("omits phase")), true);
});

test("a request timestamp outside its declared phase span is rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.evidence.requests[0].startedAtMs = 999999; // phase 0 ends at 5000
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("outside its declared phase span")), true);
});

test("an empty load cannot claim complete quality", () => {
  const derived = evaluateQuality(
    { status: 200, botWallTitleMatched: false, navigationSettled: true, budgetsExhausted: [], captureLoss: [] },
    { observedRequests: 0 }
  );
  assert.equal(derived.run.outcome, "failed");
  assert.equal(derived.run.reasons.includes("empty-load"), true);

  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.evidence.requests = [];
    draft.run.summary.counts = { ...draft.run.summary.counts, totalRequests: 0 };
    draft.run.summary.countsByPhase = [];
    // quality stays "complete": the forgery.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("unknown environment dimensions never establish compatibility", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  delete baseline.conditions.egress.region;
  delete variant.conditions.egress.region; // unknown on BOTH sides
  remintFingerprints(baseline);
  remintFingerprints(variant);
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.perMetric["raw-counts"].eligible, false);
  assert.equal(comparability.perMetric["raw-counts"].reasons.includes("unknown-dimension:egress.region"), true);
});
