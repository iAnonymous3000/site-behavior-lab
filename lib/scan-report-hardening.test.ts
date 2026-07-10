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
    assert.equal(read.violations?.some((entry) => entry.includes("interventionVerified")), true);
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
  assert.deepEqual(job, { kind: "job-accepted", jobId: "job-1", statusPath: "/api/scans/job-1", reportId: "r-1" });

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
