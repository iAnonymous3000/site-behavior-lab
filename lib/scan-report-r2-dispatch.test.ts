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
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import { makePublicSingleReportV2, makeInterventionComparisonReportV2 } from "./scan-report-v2-fixtures";
import {
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
