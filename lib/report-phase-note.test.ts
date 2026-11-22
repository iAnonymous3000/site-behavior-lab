import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { frozenReportView, ledgerPinnedReportView } from "./pinned-reports";
import { buildReportFacts, type RunFacts } from "./report-facts";
import { buildFindings } from "./report-findings";
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
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2, type ReportView } from "./scan-report-views";
import type { ScanResult, TrackerMatch } from "./types";

/** The owner's sentence (ledger 2026-11-20T17:01:43Z), for a report that records no phases. */
const OWNER_TYPING_NOTE = "This report does not record which requests came during the typing test.";

/** The disclosure a visit carries when the scanner typed and counted what followed. */
const TYPED_DISCLOSURE =
  "This scan typed a synthetic test value into 1 form field with native form submission blocked. Focus, input and blur handlers may run and send requests. The value is synthetic and is not stored. Observed requests during typing and the following wait are included in the request log. Teardown-only transmissions are not measured.";

/** The run the report's headline and board describe. */
function shownFacts(view: ReportView): RunFacts {
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  return headline.focusArm && facts.arms ? facts.arms[headline.focusArm] : facts.display;
}

// The approved owner packet (2026-11-18), word for word, on reports a test may read,
// with the owner's final list (2026-11-22): the scanner's typing is "the typing test",
// and the note for a visit with no phases is the owner's own sentence. A sentence
// prints only where the visit's record shows what it says.
test("the notes of the packet's examples are the approved sentences", () => {
  const coolmath = runPhaseNotes(shownFacts(ledgerPinnedReportView("20260814-209d4cf900b7d1a05d779187d7270297")));
  assert.equal(
    coolmath.note,
    "Recorded during the scanner's typing test: 96 of the 120 cross-site requests, including every request to 6 of the visit's 9 catalogued tracking-service entities. A phase records timing, not cause or content."
  );
  assert.equal(coolmath.platformsNote, "Recorded during the scanner's typing test: 6 of the 14 requests to these platforms. A phase records timing, not cause or content.");

  const walgreens = runPhaseNotes(shownFacts(ledgerPinnedReportView("20260814-aaecce370c0ee01e2144a9995db78b8c")));
  assert.equal(
    walgreens.note,
    "Recorded during the scanner's typing test: 42 of the 114 cross-site requests, including every request to 1 of the visit's 4 catalogued tracking-service entities. A phase records timing, not cause or content."
  );
  assert.equal(
    walgreens.platformsNote,
    "Recorded during the scanner's typing test: 12 of the 15 requests to these platforms, including every request to 1 of the visit's 2 catalogued platforms. A phase records timing, not cause or content."
  );

  // Two packet examples print no note, since their records do not show what it would say:
  // khanacademy's click has no recorded time, and creditkarma's visits typed nothing.
  for (const id of ["20260714-ad6a59f306b5ef20da4a0adcfa4eac63", "20260814-2943c6775c7589eba879c77245c2abdb"]) {
    const view = frozenReportView(id);
    assert.equal(runPhaseNotes(shownFacts(view)).note, null, id);
    const rendered = JSON.stringify({ headline: buildReportHeadline(view), board: buildFindings(view, null) });
    assert.doesNotMatch(rendered, /typing test:|during (the scanner's|its|the) typing test|ecorded after the scanner clicked|recorded the scanner's typing test/, id);
  }
  assert.equal(
    runPhaseNotes(shownFacts(frozenReportView("20261019-68fc891fdaf08f25d4e0478d54513a06"))).note,
    OWNER_TYPING_NOTE
  );
  // This visit was asked to accept, but its record shows no control was activated, so only the typing test is named.
  assert.equal(
    runPhaseNotes(shownFacts(ledgerPinnedReportView("20260702-72d984851fe81e61aa12211b8347cbab"))).note,
    OWNER_TYPING_NOTE
  );
});

type Row = { domain: string; thirdParty: boolean; entity?: string; phase: PhaseKind };

/** A single r2 visit through the real view, with the given phases and rows. */
function phasedRun(phases: readonly PhaseKind[], rows: readonly Row[], typed = true) {
  return phasedReport(phases, rows, typed).runs[0];
}

/** A single r2 report through the real view, with the given phases and rows. */
function phasedReport(phases: readonly PhaseKind[], rows: readonly Row[], typed = true): ReportView {
  const report = makePublicSingleReportV2R2();
  if (typed && phases.includes("active-probe")) report.run.warnings = [...report.run.warnings, TYPED_DISCLOSURE];
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
  return viewFromV2(report, 2);
}

const PROBE: readonly PhaseKind[] = ["passive-load", "active-probe"];
const TYPED: RecordedScannerActions = { typingCounted: true, consentClick: false, kinds: ["typing test"], policyRead: false };

test("every state prints its template, and a censored log never states an absence", () => {
  const all = phasedRun(PROBE, [
    { domain: "collector.example.net", thirdParty: true, phase: "active-probe" },
    { domain: "collector.example.net", thirdParty: true, phase: "active-probe" }
  ]);
  const note = (run: ReturnType<typeof phasedRun>, censored: boolean) =>
    phaseNote(crossSitePhaseSplit(run, { requestsCensored: censored, unphased: TYPED }), { noun: CROSS_SITE_REQUESTS, recorded: TYPED });
  assert.equal(
    note(all, false),
    "All 2 cross-site requests were recorded during the scanner's typing test, none during the initial page load. A phase records timing, not cause or content. Pages also send requests on timers."
  );
  assert.equal(note(all, true), "Recorded during the scanner's typing test: 2 of the 2 retained cross-site requests. A phase records timing, not cause or content.");
  const mixed = phasedRun(PROBE, [
    { domain: "a.example.net", thirdParty: true, phase: "passive-load" },
    { domain: "b.example.net", thirdParty: true, phase: "active-probe" }
  ]);
  assert.equal(note(mixed, false), "Recorded during the scanner's typing test: 1 of the 2 cross-site requests. A phase records timing, not cause or content.");
  assert.doesNotMatch(note(mixed, true)!, /none during|initial page load/);
  const pageOnly = phasedRun(PROBE, [{ domain: "a.example.net", thirdParty: true, phase: "passive-load" }]);
  assert.equal(note(pageOnly, false), null);
});

test("no note or caveat says the scanner caused a request or that a request carried what was typed", () => {
  const sentences = [
    OWNER_TYPING_NOTE,
    pairActionCaveat({ baseline: TYPED, variant: { typingCounted: false, consentClick: false, kinds: [], policyRead: false } }, { baseline: "No blocking", variant: "Brave-list blocking" }, "shields")!,
    phaseNote(
      crossSitePhaseSplit(phasedRun(PROBE, [{ domain: "b.example.net", thirdParty: true, phase: "active-probe" }]), { requestsCensored: false, unphased: TYPED }),
      { noun: CROSS_SITE_REQUESTS, recorded: TYPED }
    )!
  ];
  for (const sentence of sentences) {
    assert.doesNotMatch(sentence.replace("not cause or content", ""), /\b(caus|trigger|sent|transmit|typed value|input)\w*/i, sentence);
  }
});

test("a comparison caveat names the one visit that recorded an action, and none where both match", () => {
  const none: RecordedScannerActions = { typingCounted: false, consentClick: false, kinds: [], policyRead: false };
  const labels = { baseline: "No blocking", variant: "Brave-list blocking" };
  assert.equal(
    pairActionCaveat({ baseline: TYPED, variant: none }, labels, "shields"),
    "Only the visit labeled No blocking recorded the scanner's typing test; part of this difference may come from it, not blocking."
  );
  assert.equal(
    pairActionCaveat({ baseline: none, variant: TYPED }, labels, "shields"),
    "Only the visit labeled Brave-list blocking recorded the scanner's typing test; part of this difference may come from it, not blocking."
  );
  assert.equal(pairActionCaveat({ baseline: TYPED, variant: TYPED }, labels, "shields"), null);
  assert.equal(
    pairActionCaveat({ baseline: TYPED, variant: none }, { baseline: "GPC off", variant: "GPC on" }, "gpc"),
    "Only the visit labeled GPC off recorded the scanner's typing test; part of this difference may come from it, not the privacy signal."
  );
  const clicked: RecordedScannerActions = { typingCounted: false, consentClick: true, kinds: ["consent click"], policyRead: false };
  // On a comparison of the consent choice, the click is what is compared.
  assert.equal(pairActionCaveat({ baseline: clicked, variant: clicked }, labels, "consent"), null);
  assert.equal(pairActionCaveat({ baseline: clicked, variant: none }, labels, "consent"), null);
  assert.equal(
    pairActionCaveat({ baseline: clicked, variant: TYPED }, labels, "temporal"),
    "The two visits recorded different scanner actions; part of this difference may come from them, not the compared setting."
  );
  const both: RecordedScannerActions = { typingCounted: true, consentClick: true, kinds: ["consent click", "typing test"], policyRead: false };
  assert.equal(
    pairActionCaveat({ baseline: both, variant: none }, labels, "shields"),
    "Only the visit labeled No blocking recorded the scanner's consent click and typing test; part of this difference may come from them, not blocking."
  );
});

test("a visit with no phases leads with its log, naming what the visit included", () => {
  assert.equal(
    unknownPhaseLead("stanford.edu", "No blocking", ["typing test"], "2 cross-site hosts that the service catalog did not classify as tracking"),
    "The log of the stanford.edu visit labeled No blocking, which included a typing test, lists 2 cross-site hosts that the service catalog did not classify as tracking."
  );
  assert.equal(
    unknownPhaseLead("coolmathgames.com", "Accept-all attempt", ["consent click", "typing test"], "catalogued Google domains"),
    "The log of the coolmathgames.com visit labeled Accept-all attempt, which included a consent click and a typing test, lists catalogued Google domains."
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
  assert.deepEqual(recordedScannerActions(run).kinds, ["typing test"]);
  const pageOnly = phasedRun(["passive-load"], [{ domain: "a.example.net", thirdParty: true, phase: "passive-load" }]);
  assert.deepEqual(recordedScannerActions(pageOnly).kinds, []);
});

test("no note places a consent-phase row after a click, nor counts it under another action", () => {
  // The consent phase opens before the banner search and records no click time.
  const both: RecordedScannerActions = { typingCounted: true, consentClick: true, kinds: ["consent click", "typing test"], policyRead: true };
  const unclicked: RecordedScannerActions = { typingCounted: true, consentClick: false, kinds: ["typing test"], policyRead: true };
  for (const later of [[], ["active-probe"], ["policy-analysis"]] as const) {
    for (const step of ["consent-interaction", "post-choice-reload"] as const) {
      const run = phasedRun(["passive-load", step, ...later], [
        { domain: "a.example.net", thirdParty: true, phase: "passive-load" },
        { domain: "b.example.net", thirdParty: true, phase: step },
        ...later.map((phase) => ({ domain: "c.example.net", thirdParty: true, phase }))
      ]);
      for (const recorded of [both, unclicked]) {
        const split = crossSitePhaseSplit(run, { requestsCensored: false, unphased: recorded });
        assert.equal(phaseNote(split, { noun: CROSS_SITE_REQUESTS, recorded }), null, `${step} ${later.join()} click=${recorded.consentClick}`);
      }
    }
  }
});

test("a typing phase in which nothing was typed is never called a typing test", () => {
  for (const pageRows of [0, 1]) {
    const rows: Row[] = [
      ...Array.from({ length: pageRows }, () => ({ domain: "a.example.net", thirdParty: true, phase: "passive-load" as const })),
      { domain: "b.example.net", thirdParty: true, phase: "active-probe" }
    ];
    const view = phasedReport(PROBE, rows, false);
    assert.deepEqual(recordedScannerActions(view.runs[0]).kinds, [], "the phase alone is no typing test");
    const facts = buildReportFacts(view);
    assert.equal(runPhaseNotes(facts.display).note, null);
    const headline = buildReportHeadline(view, facts);
    for (const text of [headline.headline, headline.subhead, headline.shareText, JSON.stringify(buildFindings(view, null, facts, undefined))]) {
      assert.doesNotMatch(text, /during (the scanner's|its|the) typing test|only during the scanner's typing test/, text);
    }
  }
  // The lead too, once the visit's counts let the cross-site story lead: typed, it names the test; untyped, it does not.
  const lead = (typed: boolean) => {
    const view = phasedReport(PROBE, [{ domain: "b.example.net", thirdParty: true, phase: "active-probe" }], typed);
    const shown = view.runs[0];
    shown.counts.thirdPartyRequests = 1;
    shown.counts.thirdPartyDomains = 1;
    shown.counts.knownTrackerRequests = 0;
    shown.evidence.domains = [{ domain: "b.example.net", requests: 1, thirdParty: true, tracker: null, statuses: [200], resourceTypes: ["script"] }];
    return buildReportHeadline(view).headline;
  };
  assert.equal(lead(true), "example.com's cross-site traffic was all recorded during the scanner's typing test: 1 host, not classified as tracking.");
  assert.equal(lead(false), "example.com contacted 1 cross-site host that the service catalog did not classify as tracking.");
  const omitted = phasedRun(PROBE, [{ domain: "b.example.net", thirdParty: true, phase: "active-probe" }], false);
  omitted.warnings = [TYPED_DISCLOSURE.replace(/Observed requests.*$/, "Requests from this incomplete probe were omitted from the recorded request log and counts.")];
  assert.deepEqual(recordedScannerActions(omitted).kinds, [], "typing whose requests were left out is not counted");
});

test("the policy phrase prints only for a visit that stored a policy read", () => {
  const run = phasedRun(["passive-load", "active-probe", "policy-analysis"], [
    { domain: "a.example.net", thirdParty: true, phase: "passive-load" },
    { domain: "b.example.net", thirdParty: true, phase: "active-probe" },
    { domain: "c.example.net", thirdParty: true, phase: "policy-analysis" }
  ]);
  const note = (recorded: RecordedScannerActions) =>
    phaseNote(crossSitePhaseSplit(run, { requestsCensored: false, unphased: recorded }), { noun: CROSS_SITE_REQUESTS, recorded });
  run.evidence.privacyPolicy = null;
  assert.equal(note(recordedScannerActions(run)), null, "the phase alone is no policy read");
  run.evidence.privacyPolicy = { url: "https://site.example/privacy", claims: [], mentionedEntities: [], unmentionedEntities: [], policyTextLength: 1000 };
  const read = recordedScannerActions(run);
  assert.equal(
    note(read),
    "Recorded during the scanner's typing test or while it read the privacy policy: 2 of the 3 cross-site requests. A phase records timing, not cause or content."
  );
  assert.equal(note({ ...read, typingCounted: false }), null, "a typing row is not counted under the policy read");
  const alone = phasedRun(["passive-load", "policy-analysis"], [
    { domain: "a.example.net", thirdParty: true, phase: "passive-load" },
    { domain: "c.example.net", thirdParty: true, phase: "policy-analysis" }
  ]);
  alone.evidence.privacyPolicy = run.evidence.privacyPolicy;
  const recorded = recordedScannerActions(alone);
  assert.equal(
    phaseNote(crossSitePhaseSplit(alone, { requestsCensored: false, unphased: recorded }), { noun: CROSS_SITE_REQUESTS, recorded }),
    "Recorded while the scanner read the privacy policy: 1 of the 2 cross-site requests. A phase records timing, not cause or content."
  );
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
      recorded: { typingCounted: kinds.includes("typing test"), consentClick: kinds.includes("consent click"), kinds: [...kinds], policyRead: false }
    });
  // The typing form is the owner's sentence, byte for byte.
  assert.equal(note(["typing test"]), OWNER_TYPING_NOTE);
  assert.equal(note(["consent click"]), "This report does not record which requests came after the consent click.");
  assert.equal(
    note(["consent click", "typing test"]),
    "This report does not record which requests came after the consent click or during the typing test."
  );
  assert.equal(note([]), null);
});

// The owner's gate (2026-11-20): the note for a report without phases is for
// reports without phases only. A report with phases whose cross-site rows are
// not all tagged states no split, from any claim's rows, and prints no note.
test("a visit with phases and an untagged cross-site row states no phase and prints no note", () => {
  const view = phasedReport(PROBE, [
    { domain: "a.example.net", thirdParty: true, phase: "passive-load" },
    { domain: "b.example.net", thirdParty: true, phase: "active-probe" },
    { domain: "c.example.net", thirdParty: true, phase: "active-probe" }
  ]);
  const run = view.runs[0];
  delete (run.evidence.requests[2] as { phaseId?: number }).phaseId;
  assert.deepEqual(recordedScannerActions(run).kinds, ["typing test"], "the visit records the typing test, so a note could be written");
  assert.equal(crossSitePhaseSplit(run, { requestsCensored: false, unphased: TYPED }).state, "untagged-rows");
  // A claim whose own rows all carry a phase states nothing either: the gate is the visit's.
  const tagged = crossSitePhaseSplit(run, { claimRows: (request) => request.domain === "b.example.net", requestsCensored: false, unphased: TYPED });
  assert.equal(tagged.state, "untagged-rows");
  assert.equal(phaseNote(tagged, { noun: CROSS_SITE_REQUESTS, recorded: TYPED }), null);

  const facts = buildReportFacts(view);
  const notes = runPhaseNotes(facts.display);
  assert.equal(notes.note, null);
  assert.equal(notes.platformsNote, null);
  const headline = buildReportHeadline(view, facts);
  assert.equal(headline.semantic.phase, "untagged-rows");
  const board = buildFindings(view, null, facts, undefined);
  const rendered = JSON.stringify({ headline, board });
  assert.doesNotMatch(rendered, /does not record which requests|ecorded (during|after) the scanner|requests came during|The log of /, rendered);
});

test("a report without phases whose record shows a consent click carries the click form of the note", () => {
  // The v1 wire records the click as consentInteraction.clicked, read as the run's controlActivated.
  const report = makeScanReportV1() as ScanResult;
  const { phaseId: _phaseId, ...row } = makePublicSingleReportV2R2().run.evidence.requests[0];
  report.requests = [{ ...row, url: "https://a.example.net/{seg}", domain: "a.example.net", thirdParty: true }];
  report.conditions.consentMode = "accept-all";
  report.consentInteraction = { mode: "accept-all", clicked: true };
  const view = viewFromV1Report(report);
  assert.equal(view.runs[0].phases, null, "a v1 visit records no phases");
  assert.deepEqual(recordedScannerActions(view.runs[0]).kinds, ["consent click"]);
  assert.equal(runPhaseNotes(buildReportFacts(view).display).note, "This report does not record which requests came after the consent click.");
});

/** Source text with its comments removed, so a comment that explains older reports is not public text. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Non-test source files under the given roots: the code that writes what a reader sees. */
function publicSources(...roots: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry) && !entry.endsWith(".d.ts")) found.push(full);
    }
  };
  for (const root of roots) walk(path.join(process.cwd(), root));
  return found;
}

test("no public string calls a report an older report", () => {
  // The singular is the claim about the report a reader has open. The plural
  // ("Older reports may not contain ...") is a true statement about earlier
  // reports and stays; comments, tests and docs are not public strings.
  const files = publicSources("lib", "app");
  const holders = files.filter((file) => /\bolder report\b/i.test(withoutComments(readFileSync(file, "utf8"))));
  assert.deepEqual(holders.map((file) => path.relative(process.cwd(), file)), []);
  // The scan reads the note's own template through the comment stripper, so it cannot pass vacuously.
  const template = files.find((file) => file.endsWith(path.join("lib", "report-phase-note.ts")));
  assert.ok(template, "the scan does not reach lib/report-phase-note.ts");
  assert.match(withoutComments(readFileSync(template, "utf8")), /`This report does not record which requests came \$\{when\.join\(" or "\)\}\.`/);
});

test("no public string and no committed headline says typing probe", () => {
  // One term for the scanner's typing in every sentence a reader sees: the
  // typing test. Comments, tests and docs are not public strings.
  const files = publicSources("lib", "app");
  const holders = files.filter((file) => /typing probe/i.test(withoutComments(readFileSync(file, "utf8"))));
  assert.deepEqual(holders.map((file) => path.relative(process.cwd(), file)), []);
  // The scan reads the phase wording through the comment stripper, so it cannot pass vacuously.
  const template = files.find((file) => file.endsWith(path.join("lib", "report-phase-note.ts")));
  assert.ok(template, "the scan does not reach lib/report-phase-note.ts");
  assert.match(withoutComments(readFileSync(template, "utf8")), /"during the scanner's typing test"/);
  // The rendered headlines the report index publishes. Every committed
  // report's full board is read by the corpus loop in lib/report-findings.test.ts.
  const index = readFileSync(path.join(process.cwd(), "public", "reports", "index.json"), "utf8");
  assert.ok(/"headline":/.test(index), "the report index carries no headline; this check would be vacuous");
  assert.doesNotMatch(index, /typing probe/i);
  assert.doesNotMatch(index, /\bolder report\b/i);
});
