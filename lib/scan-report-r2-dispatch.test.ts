/**
 * Exact revision dispatch and revision-aware projectors/views (RFC 14.4/14.5):
 * v2/r1 and v2/r2 each validate under their own revision, r3+ is a typed
 * capability gap, r1 views are limited/descriptive per 15.7, and the export
 * boundary covers the r2 sources.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readStoredScanReport } from "./scan-report-reader";
import { publicWireForExportOrPersistence, readScanTransportPayload, toReportView } from "./scan-report-view";
import { buildComparisonDiffV2 } from "./scan-report-v2-evaluators";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import { evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import { makePublicSingleReportV2, makeInterventionComparisonReportV2 } from "./scan-report-v2-fixtures";
import {
  makeConsentInterventionReportV2R2,
  makeConsentSingleReportV2R2,
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";

type AnyRecord = Record<string, any>;

function mutate<T>(fixture: T, apply: (draft: T) => void): T {
  const draft = structuredClone(fixture);
  apply(draft);
  return draft;
}

function registry1ShieldsReport() {
  const report = makeShieldsInterventionReportV2R2();
  report.comparability = evaluateComparabilityR2(report.experiment, report.baseline, report.variant, "1");
  report.diff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
  return report;
}

function evaluator1ConsentMissingClickReport() {
  const report = makeConsentInterventionReportV2R2();
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention fixture");
  const consent = report.variant.evidence.consent;
  if (consent === undefined) throw new Error("expected consent evidence");
  consent.controlActivated = false;
  consent.verificationObservations = [];
  consent.choiceState = "unavailable";
  consent.reverifiedAfterReload = false;
  delete consent.bannerTransition;
  report.experiment.verification.variant = {
    axis: "consent",
    expected: "consent:reject-all",
    observed: null,
    method: "consent-verification-unavailable@1",
    outcome: "inconclusive",
    phaseId: 1
  };
  report.comparability = evaluateComparabilityR2(
    report.experiment,
    report.baseline,
    report.variant,
    "2",
    "1"
  );
  report.diff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
  return report;
}

test("the reader dispatches each revision to its own validator and evaluator", () => {
  const r1 = readStoredScanReport(makePublicSingleReportV2());
  assert.equal(r1.ok, true);
  if (r1.ok && r1.stored.schemaVersion === 2) assert.equal(r1.stored.schemaRevision, 1);

  const r2 = readStoredScanReport(makeShieldsInterventionReportV2R2());
  assert.equal(r2.ok, true, JSON.stringify(!r2.ok ? r2.violations : []));
  if (r2.ok && r2.stored.schemaVersion === 2) assert.equal(r2.stored.schemaRevision, 2);

  // An r2 semantic forgery is "inconsistent" through the same dispatch.
  const forged = readStoredScanReport(
    mutate(makeShieldsInterventionReportV2R2(), (draft) => {
      draft.variant.summary.counts.shieldsBlockedRequests = 9;
    })
  );
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.error, "inconsistent");

  const r3 = readStoredScanReport(
    mutate(makePublicSingleReportV2R2(), (draft) => (((draft as AnyRecord).schemaRevision = 3)))
  );
  assert.deepEqual(r3, { ok: false, error: "unsupported-revision" });
});

test("registry-1 Shields reports stay readable but cannot expose a mixed-quantity delta", () => {
  const historical = registry1ShieldsReport();
  assert.equal(historical.comparability.perMetric["shields-simulation"].eligible, true);

  const read = readStoredScanReport(historical);
  assert.equal(read.ok, true, JSON.stringify(!read.ok ? read.violations : []));
  if (!read.ok) return;

  const view = toReportView(read.stored);
  assert.equal(view.claims.familyDeltas?.["shields-simulation"].allowed, false);
  assert.equal(view.claims.decision?.families["shields-simulation"].mode, "raw-only");
  assert.match(
    view.claims.familyDeltas?.["shields-simulation"].reasons.join(" ") ?? "",
    /different Shields quantities/
  );
});

test("evaluator-1 consent reports stay readable but a missing click exposes no deltas", () => {
  const historical = evaluator1ConsentMissingClickReport();
  assert.equal(historical.comparability.evaluatorVersion, "1");
  assert.equal(historical.comparability.pairValidity.eligible, true);
  assert.equal(historical.comparability.perMetric["raw-counts"].eligible, true);

  const read = readStoredScanReport(historical);
  assert.equal(read.ok, true, JSON.stringify(!read.ok ? read.violations : []));
  if (!read.ok) return;

  const view = toReportView(read.stored);
  assert.equal(view.claims.decision?.mode, "raw-only");
  assert.equal(view.claims.familyDeltas?.["raw-counts"].allowed, false);
  assert.equal(
    Object.values(view.claims.decision?.families ?? {}).every((family) => family.mode === "raw-only"),
    true
  );
  assert.match(view.claims.decision?.reasons.join(" ") ?? "", /controls were not activated/);
});

test("registry-2 rejects a forged comparable Shields family", () => {
  const forged = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    draft.comparability.perMetric["shields-simulation"] = { eligible: true, reasons: [] };
    draft.diff.families["shields-simulation"].eligible = true;
  });

  const read = readStoredScanReport(forged);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.deepEqual(read.violations, [
      "comparability: perMetric.shields-simulation disagrees with the r2 evaluator (derived reasons: dependency-version-mismatch:shieldsMode)"
    ]);
  }

  const forgedVersion = mutate(makeShieldsInterventionReportV2R2(), (draft) => {
    draft.comparability.metricRegistryVersion = "1";
  });
  const versionRead = readStoredScanReport(forgedVersion);
  assert.equal(versionRead.ok, false);
  if (!versionRead.ok) {
    assert.deepEqual(versionRead.violations, [
      "comparability: perMetric.shields-simulation disagrees with the r2 evaluator (derived reasons: none)"
    ]);
  }
});

test("views are revision-aware: r1 is limited and its causal surface suppressed", () => {
  const r1 = readStoredScanReport(makeInterventionComparisonReportV2());
  assert.equal(r1.ok, true);
  if (r1.ok) {
    const view = toReportView(r1.stored);
    assert.equal(view.revision, 1);
    assert.equal(view.limited, true, "RFC 15.7: r1 reports are limited/descriptive");
    assert.equal(view.claims.interventionAttribution, false, "causal surface suppressed for r1");
    assert.equal(view.claims.strongCausal, false);
    assert.notEqual(view.claims.familyDeltas, null, "descriptive eligibility still renders");
    assert.equal(view.claims.pairComparison?.allowed, true);
  }

  const r2 = readStoredScanReport(makeGpcInterventionReportV2R2());
  assert.equal(r2.ok, true);
  if (r2.ok) {
    const view = toReportView(r2.stored);
    assert.equal(view.revision, 2);
    assert.equal(view.limited, false);
    assert.equal(view.claims.interventionAttribution, true, "r2 carries the verified attribution gate");
    // One valid pair is observed-difference evidence; strong causal wording
    // stays denied until replicated counterbalanced evidence exists (RFC 4.2).
    assert.equal(view.claims.strongCausal, false);
  }
});

test("transport dispatches r2 public and ephemeral payloads", () => {
  const publicResult = readScanTransportPayload(makeConsentSingleReportV2R2());
  assert.equal(publicResult.kind, "report");
  if (publicResult.kind === "report") {
    assert.equal(publicResult.loaded.source, "v2-r2-public");
    // JSON download preserves the original wire bytes.
    assert.deepEqual(publicWireForExportOrPersistence(publicResult.loaded), makeConsentSingleReportV2R2());
  }

  const ephemeral = { ...makeConsentSingleReportV2R2(), ephemeral: { screenshot: "data:image/png;base64,R2SHOT" } };
  const ephemeralResult = readScanTransportPayload(ephemeral);
  assert.equal(ephemeralResult.kind, "report");
  if (ephemeralResult.kind === "report") {
    assert.equal(ephemeralResult.loaded.source, "v2-r2-ephemeral");
    const wire = publicWireForExportOrPersistence(ephemeralResult.loaded);
    assert.equal(JSON.stringify(wire).includes("R2SHOT"), false, "screenshots never persist");
    assert.equal(isPublicScanReportV2R2(wire), true);
  }

  // Malformed r2 shells and future ephemeral revisions are typed, not thrown.
  const malformed = readScanTransportPayload({
    ...makeConsentSingleReportV2R2(),
    ephemeral: { screenshot: 42 }
  });
  assert.deepEqual(malformed, { kind: "unreadable", error: "invalid" });
  const smuggled = readScanTransportPayload({
    ...makeConsentSingleReportV2R2(),
    ephemeral: { screenshot: null, extra: "SECRET" }
  });
  assert.deepEqual(smuggled, { kind: "unreadable", error: "invalid" });
  const future = readScanTransportPayload({
    ...(structuredClone(makeConsentSingleReportV2R2()) as AnyRecord),
    schemaRevision: 3,
    ephemeral: { screenshot: null }
  });
  assert.deepEqual(future, { kind: "unreadable", error: "unsupported-revision" });
});
