import assert from "node:assert/strict";
import { test } from "node:test";
import { frozenReportView, ledgerPinnedReportView } from "./pinned-reports";
import { buildReportFacts, type RunFacts } from "./report-facts";
import { buildReportHeadline } from "./report-headline";
import {
  CROSS_SITE_REQUESTS,
  firstSentence,
  pairActionCaveat,
  phaseNote,
  runPhaseNotes,
  unknownPhaseLead,
  withNoteAfterFirstSentence
} from "./report-phase-note";
import { crossSitePhaseSplit, recordedScannerActions, type CrossSitePhaseSplit, type RecordedScannerActions } from "./report-phase-split";
import type { PhaseKind } from "./scan-report-v2";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { viewFromV2, type ReportView } from "./scan-report-views";
import type { TrackerMatch } from "./types";

/** The run the report's headline and board describe. */
function shownFacts(view: ReportView): RunFacts {
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  return headline.focusArm && facts.arms ? facts.arms[headline.focusArm] : facts.display;
}

// The approved owner packet (2026-11-18), word for word, on reports a test may read,
// except that the note for a visit with no phases no longer calls the report older.
test("the notes of the packet's examples are the approved sentences", () => {
  const coolmath = runPhaseNotes(shownFacts(ledgerPinnedReportView("20260814-209d4cf900b7d1a05d779187d7270297")));
  assert.equal(
    coolmath.note,
    "Recorded during the scanner's typing probe: 96 of the 120 cross-site requests, including every request to 6 of the visit's 9 catalogued tracking-service entities. A phase records timing, not cause or content."
  );
  assert.equal(coolmath.platformsNote, "Recorded during the scanner's typing probe: 6 of the 14 requests to these platforms. A phase records timing, not cause or content.");

  const walgreens = runPhaseNotes(shownFacts(ledgerPinnedReportView("20260814-aaecce370c0ee01e2144a9995db78b8c")));
  assert.equal(
    walgreens.note,
    "Recorded during the scanner's typing probe: 42 of the 114 cross-site requests, including every request to 1 of the visit's 4 catalogued tracking-service entities. A phase records timing, not cause or content."
  );
  assert.equal(
    walgreens.platformsNote,
    "Recorded during the scanner's typing probe: 12 of the 15 requests to these platforms, including every request to 1 of the visit's 2 catalogued platforms. A phase records timing, not cause or content."
  );

  assert.equal(
    runPhaseNotes(shownFacts(frozenReportView("20260714-ad6a59f306b5ef20da4a0adcfa4eac63"))).note,
    "Recorded after the scanner clicked Reject all: 1 of the 127 cross-site requests. A phase records timing, not cause or content."
  );
  assert.equal(
    runPhaseNotes(shownFacts(frozenReportView("20260814-2943c6775c7589eba879c77245c2abdb"))).note,
    "Recorded during the scanner's typing probe: 1 of the 121 cross-site requests. A phase records timing, not cause or content."
  );
  assert.equal(
    runPhaseNotes(shownFacts(frozenReportView("20261019-68fc891fdaf08f25d4e0478d54513a06"))).note,
    "This report does not record which requests came during the scanner's typing probe."
  );
  // This visit was asked to accept, but its record shows no control was activated, so only the typing probe is named.
  assert.equal(
    runPhaseNotes(shownFacts(ledgerPinnedReportView("20260702-72d984851fe81e61aa12211b8347cbab"))).note,
    "This report does not record which requests came during the scanner's typing probe."
  );
});

type Row = { domain: string; thirdParty: boolean; entity?: string; phase: PhaseKind };

/** A single r2 visit through the real view, with the given phases and rows. */
function phasedRun(phases: readonly PhaseKind[], rows: readonly Row[]) {
  const report = makePublicSingleReportV2R2();
  const template = report.run.evidence.requests[0];
  report.run.phases = phases.map((kind, phaseId) => ({ phaseId, kind, startedAtMs: phaseId * 1000, endedAtMs: phaseId * 1000 + 1000 }));
  report.run.evidence.requests = rows.map((row, index) => ({
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
const TYPED: RecordedScannerActions = { typingCounted: true, consentClick: false, kinds: ["typing probe"] };

test("every state prints its template, and a censored log never states an absence", () => {
  const all = phasedRun(PROBE, [
    { domain: "collector.example.net", thirdParty: true, phase: "active-probe" },
    { domain: "collector.example.net", thirdParty: true, phase: "active-probe" }
  ]);
  const note = (run: ReturnType<typeof phasedRun>, censored: boolean) =>
    phaseNote(crossSitePhaseSplit(run, { requestsCensored: censored, unphased: TYPED }), { noun: CROSS_SITE_REQUESTS, consentMode: "observe", recorded: TYPED });
  assert.equal(
    note(all, false),
    "All 2 cross-site requests were recorded during the scanner's typing probe, none during the initial page load. A phase records timing, not cause or content. Pages also send requests on timers."
  );
  assert.equal(note(all, true), "Recorded during the scanner's typing probe: 2 of the 2 retained cross-site requests. A phase records timing, not cause or content.");
  const mixed = phasedRun(PROBE, [
    { domain: "a.example.net", thirdParty: true, phase: "passive-load" },
    { domain: "b.example.net", thirdParty: true, phase: "active-probe" }
  ]);
  assert.equal(note(mixed, false), "Recorded during the scanner's typing probe: 1 of the 2 cross-site requests. A phase records timing, not cause or content.");
  assert.doesNotMatch(note(mixed, true)!, /none during|initial page load/);
  const pageOnly = phasedRun(PROBE, [{ domain: "a.example.net", thirdParty: true, phase: "passive-load" }]);
  assert.equal(note(pageOnly, false), null);
});

test("no note or caveat says the scanner caused a request or that a request carried what was typed", () => {
  const sentences = [
    "This report does not record which requests came during the scanner's typing probe.",
    pairActionCaveat({ baseline: TYPED, variant: { typingCounted: false, consentClick: false, kinds: [] } }, { baseline: "No blocking", variant: "Brave-list blocking" }, "shields")!,
    phaseNote(
      crossSitePhaseSplit(phasedRun(PROBE, [{ domain: "b.example.net", thirdParty: true, phase: "active-probe" }]), { requestsCensored: false, unphased: TYPED }),
      { noun: CROSS_SITE_REQUESTS, consentMode: "observe", recorded: TYPED }
    )!
  ];
  for (const sentence of sentences) {
    assert.doesNotMatch(sentence.replace("not cause or content", ""), /\b(caus|trigger|sent|transmit|typed value|input)\w*/i, sentence);
  }
});

test("a comparison caveat names the one visit that recorded an action, and none where both match", () => {
  const none: RecordedScannerActions = { typingCounted: false, consentClick: false, kinds: [] };
  const labels = { baseline: "No blocking", variant: "Brave-list blocking" };
  assert.equal(
    pairActionCaveat({ baseline: TYPED, variant: none }, labels, "shields"),
    "Only the visit labeled No blocking recorded the scanner's typing probe; part of this difference may come from it, not blocking."
  );
  assert.equal(
    pairActionCaveat({ baseline: none, variant: TYPED }, labels, "shields"),
    "Only the visit labeled Brave-list blocking recorded the scanner's typing probe; part of this difference may come from it, not blocking."
  );
  assert.equal(pairActionCaveat({ baseline: TYPED, variant: TYPED }, labels, "shields"), null);
  assert.equal(
    pairActionCaveat({ baseline: TYPED, variant: none }, { baseline: "GPC off", variant: "GPC on" }, "gpc"),
    "Only the visit labeled GPC off recorded the scanner's typing probe; part of this difference may come from it, not the privacy signal."
  );
  const clicked: RecordedScannerActions = { typingCounted: false, consentClick: true, kinds: ["consent click"] };
  // On a comparison of the consent choice, the click is what is compared.
  assert.equal(pairActionCaveat({ baseline: clicked, variant: clicked }, labels, "consent"), null);
  assert.equal(pairActionCaveat({ baseline: clicked, variant: none }, labels, "consent"), null);
  assert.equal(
    pairActionCaveat({ baseline: clicked, variant: TYPED }, labels, "temporal"),
    "The two visits recorded different scanner actions; part of this difference may come from them, not the compared setting."
  );
  const both: RecordedScannerActions = { typingCounted: true, consentClick: true, kinds: ["consent click", "typing probe"] };
  assert.equal(
    pairActionCaveat({ baseline: both, variant: none }, labels, "shields"),
    "Only the visit labeled No blocking recorded the scanner's consent click and typing probe; part of this difference may come from them, not blocking."
  );
});

test("a visit with no phases leads with its log, naming what the visit included", () => {
  assert.equal(
    unknownPhaseLead("stanford.edu", "No blocking", ["typing probe"], "2 cross-site hosts that the service catalog did not classify as tracking"),
    "The log of the stanford.edu visit labeled No blocking, which included a typing probe, lists 2 cross-site hosts that the service catalog did not classify as tracking."
  );
  assert.equal(
    unknownPhaseLead("coolmathgames.com", "Accept-all attempt", ["consent click", "typing probe"], "catalogued Google domains"),
    "The log of the coolmathgames.com visit labeled Accept-all attempt, which included a consent click and a typing probe, lists catalogued Google domains."
  );
  assert.equal(unknownPhaseLead("example.com", null, ["consent click"], "x"), "The log of this example.com visit, which included a consent click, lists x.");
  assert.equal(unknownPhaseLead("example.com", null, [], "x"), null);
});

test("the note goes after the first sentence, which ends at a full stop before a space", () => {
  assert.equal(firstSentence("3 cross-site requests appeared in the log. The identity map named 2 of 2 hosts."), "3 cross-site requests appeared in the log.");
  assert.equal(firstSentence("stanford.edu has no stop"), "stanford.edu has no stop");
  assert.equal(withNoteAfterFirstSentence("One. Two.", "Note."), "One. Note. Two.");
  assert.equal(withNoteAfterFirstSentence("Only one.", "Note."), "Only one. Note.");
});

test("the recorded actions of a visit come from its own record", () => {
  const run = phasedRun(PROBE, [{ domain: "a.example.net", thirdParty: true, phase: "active-probe" }]);
  assert.deepEqual(recordedScannerActions(run).kinds, ["typing probe"]);
  const pageOnly = phasedRun(["passive-load"], [{ domain: "a.example.net", thirdParty: true, phase: "passive-load" }]);
  assert.deepEqual(recordedScannerActions(pageOnly).kinds, []);
});

test("a consent click is named only where the record shows the control was activated", () => {
  const clicked = { typingCounted: false, consentClick: true, kinds: ["consent click"] } as const;
  const notClicked = { typingCounted: false, consentClick: false, kinds: [] } as const;
  const run = phasedRun(["passive-load", "consent-interaction"], [
    { domain: "a.example.net", thirdParty: true, phase: "passive-load" },
    { domain: "b.example.net", thirdParty: true, phase: "consent-interaction" }
  ]);
  const note = (recorded: RecordedScannerActions) =>
    phaseNote(crossSitePhaseSplit(run, { requestsCensored: false, unphased: recorded }), { noun: CROSS_SITE_REQUESTS, consentMode: "reject-all", recorded });
  assert.equal(note({ ...clicked, kinds: [...clicked.kinds] }), "Recorded after the scanner clicked Reject all: 1 of the 2 cross-site requests. A phase records timing, not cause or content.");
  // The consent phase opens before the scanner tries the banner: without a click, its rows get no wording.
  assert.equal(note({ ...notClicked, kinds: [] }), null);
});

/** A split from a visit that records no phases, so the note can say only what the visit included. */
const UNPHASED: CrossSitePhaseSplit = {
  state: "unknown-after-action",
  requestsCensored: false,
  actions: [],
  requests: { total: 2, afterAction: 0 },
  hosts: { total: 1, onlyAfterAction: [] },
  entities: { total: 0, onlyAfterAction: [] }
};

test("the note for a visit with no phases names what the visit included and never calls the report older", () => {
  const note = (kinds: RecordedScannerActions["kinds"]) =>
    phaseNote(UNPHASED, {
      noun: CROSS_SITE_REQUESTS,
      consentMode: "accept-all",
      recorded: { typingCounted: kinds.includes("typing probe"), consentClick: kinds.includes("consent click"), kinds: [...kinds] }
    });
  assert.equal(note(["typing probe"]), "This report does not record which requests came during the scanner's typing probe.");
  assert.equal(note(["consent click"]), "This report does not record which requests came during the scanner's consent click.");
  assert.equal(
    note(["consent click", "typing probe"]),
    "This report does not record which requests came during the scanner's consent click or typing probe."
  );
  assert.equal(note([]), null);
});
