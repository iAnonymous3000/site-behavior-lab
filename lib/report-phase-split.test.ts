import assert from "node:assert/strict";
import { test } from "node:test";
import { crossSitePhaseSplit, recordedScannerActions, type CrossSitePhaseSplit, type UnphasedActions } from "./report-phase-split";
import type { PhaseKind } from "./scan-report-v2";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2, type RunView } from "./scan-report-views";
import type { ScanResult, TrackerMatch } from "./types";

const NO_ACTION: UnphasedActions = { typingCounted: false, consentClick: false };

type Row = { domain: string; thirdParty: boolean; entity?: string; phase: PhaseKind };

/**
 * A single r2 visit read through the real view, with the given phases and
 * rows. Only the fields the split reads differ from the producer fixture's
 * own document row.
 */
function phasedRun(phases: readonly PhaseKind[], rows: readonly Row[]): RunView {
  const report = makePublicSingleReportV2R2();
  const run = report.run;
  const template = run.evidence.requests[0];
  run.phases = phases.map((kind, phaseId) => ({ phaseId, kind, startedAtMs: phaseId * 1000, endedAtMs: phaseId * 1000 + 1000 }));
  run.evidence.requests = rows.map((row, index) => ({
    ...template,
    id: index + 1,
    url: `https://${row.domain}/{seg}`,
    domain: row.domain,
    thirdParty: row.thirdParty,
    tracker: row.entity ? ({ entity: row.entity, category: "advertising", domain: row.domain } as TrackerMatch) : null,
    startedAtMs: phases.indexOf(row.phase) * 1000 + 10,
    phaseId: phases.indexOf(row.phase)
  }));
  return viewFromV2(report, 2).runs[0];
}

const PROBE: readonly PhaseKind[] = ["passive-load", "active-probe"];

test("cross-site rows recorded only during the typing probe are all after a scanner action", () => {
  const split = crossSitePhaseSplit(
    phasedRun(PROBE, [
      { domain: "site.example", thirdParty: false, phase: "passive-load" },
      { domain: "collector.example.net", thirdParty: true, phase: "active-probe" },
      { domain: "collector.example.net", thirdParty: true, phase: "active-probe" }
    ]),
    { requestsCensored: false, unphased: NO_ACTION }
  );
  assert.deepEqual(split, {
    state: "all-after-action",
    requestsCensored: false,
    actions: ["active-probe"],
    requests: { total: 2, afterAction: 2 },
    hosts: { total: 1, onlyAfterAction: ["collector.example.net"] },
    entities: { total: 0, onlyAfterAction: [] }
  } satisfies CrossSitePhaseSplit);
});

test("cross-site rows recorded only in page load stay page-load-only", () => {
  const split = crossSitePhaseSplit(
    phasedRun(PROBE, [
      { domain: "cdn.example.org", thirdParty: true, entity: "Example Ads", phase: "passive-load" },
      { domain: "site.example", thirdParty: false, phase: "active-probe" }
    ]),
    { requestsCensored: false, unphased: NO_ACTION }
  );
  assert.equal(split.state, "page-load-only");
  assert.deepEqual(split.actions, []);
  assert.deepEqual(split.requests, { total: 1, afterAction: 0 });
});

test("a mixed visit names only the hosts and entities seen after the action", () => {
  const split = crossSitePhaseSplit(
    phasedRun(PROBE, [
      { domain: "ads.example.org", thirdParty: true, entity: "Shared Ads", phase: "passive-load" },
      { domain: "ads.example.org", thirdParty: true, entity: "Shared Ads", phase: "active-probe" },
      { domain: "bid.example.net", thirdParty: true, entity: "Late Bidder", phase: "active-probe" },
      { domain: "bid.example.net", thirdParty: true, entity: "Late Bidder", phase: "active-probe" }
    ]),
    { requestsCensored: true, unphased: NO_ACTION }
  );
  assert.equal(split.state, "mixed");
  assert.equal(split.requestsCensored, true);
  assert.deepEqual(split.requests, { total: 4, afterAction: 3 });
  assert.deepEqual(split.hosts, { total: 2, onlyAfterAction: ["bid.example.net"] });
  assert.deepEqual(split.entities, { total: 2, onlyAfterAction: ["Late Bidder"] });
});

test("the split is taken over the claim's own rows", () => {
  const run = phasedRun(PROBE, [
    { domain: "plain.example.org", thirdParty: true, phase: "passive-load" },
    { domain: "bid.example.net", thirdParty: true, entity: "Late Bidder", phase: "active-probe" }
  ]);
  const allCrossSite = crossSitePhaseSplit(run, { requestsCensored: false, unphased: NO_ACTION });
  const catalogued = crossSitePhaseSplit(run, {
    claimRows: (request) => request.thirdParty && request.tracker !== null,
    requestsCensored: false,
    unphased: NO_ACTION
  });
  assert.equal(allCrossSite.state, "mixed");
  assert.equal(catalogued.state, "all-after-action");
});

test("actions are listed in phase order, consent before the probe", () => {
  const split = crossSitePhaseSplit(
    phasedRun(["passive-load", "consent-interaction", "active-probe"], [
      { domain: "a.example.net", thirdParty: true, phase: "active-probe" },
      { domain: "b.example.net", thirdParty: true, phase: "consent-interaction" }
    ]),
    { requestsCensored: false, unphased: NO_ACTION }
  );
  assert.equal(split.state, "all-after-action");
  assert.deepEqual(split.actions, ["consent-interaction", "active-probe"]);
});

test("a phased visit with a counted row that carries no phase is never called page-load-only", () => {
  const run = phasedRun(PROBE, [{ domain: "a.example.net", thirdParty: true, phase: "passive-load" }]);
  delete (run.evidence.requests[0] as { phaseId?: number }).phaseId;
  assert.equal(crossSitePhaseSplit(run, { requestsCensored: false, unphased: NO_ACTION }).state, "unknown-after-action");
});

test("a visit with no counted row has no split to state", () => {
  const split = crossSitePhaseSplit(
    phasedRun(PROBE, [{ domain: "site.example", thirdParty: false, phase: "active-probe" }]),
    { requestsCensored: false, unphased: NO_ACTION }
  );
  assert.equal(split.state, "no-rows");
});

test("a visit without phases is unknown only when its records show a scanner action in the counts", () => {
  const report = makeScanReportV1() as ScanResult;
  // The v1 fixture has no rows; one cross-site row in the v1 row shape (the r2 row without its phase).
  const { phaseId: _phaseId, ...row } = makePublicSingleReportV2R2().run.evidence.requests[0];
  report.requests = [{ ...row, url: "https://a.example.net/{seg}", domain: "a.example.net", thirdParty: true }];
  const run = viewFromV1Report(report).runs[0];
  assert.equal(run.phases, null, "a v1 visit records no phases");
  assert.ok(run.evidence.requests.some((request) => request.thirdParty), "the v1 fixture counts cross-site rows");
  const stateFor = (unphased: UnphasedActions) =>
    crossSitePhaseSplit(run, { requestsCensored: false, unphased }).state;
  assert.equal(stateFor({ typingCounted: true, consentClick: false }), "unknown-after-action");
  assert.equal(stateFor({ typingCounted: false, consentClick: true }), "unknown-after-action");
  // No typing, or an incomplete probe whose requests were left out of the counts.
  assert.equal(stateFor(NO_ACTION), "no-action-recorded");
});

test("a v1 consent visit asked to accept whose control was not clicked records no consent action", () => {
  const visit = (clicked: boolean) => {
    const result = makeScanReportV1() as ScanResult;
    result.conditions.consentMode = "accept-all";
    result.consentInteraction = { mode: "accept-all", clicked };
    return viewFromV1Report(result).runs[0];
  };
  const notClicked = recordedScannerActions(visit(false));
  // The requested choice is not a click: the record's control state decides.
  assert.equal(notClicked.consentClick, false, "a requested choice with no activated control is no click");
  assert.deepEqual(notClicked.kinds, [], "a requested choice with no activated control records no consent action");
  const clicked = recordedScannerActions(visit(true));
  assert.equal(clicked.consentClick, true);
  assert.deepEqual(clicked.kinds, ["consent click"]);
});
