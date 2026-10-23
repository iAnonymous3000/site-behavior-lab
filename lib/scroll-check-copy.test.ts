import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_RECORDED_REQUESTS } from "./scan-runtime";
import type { LoadedReport } from "./scan-report-view";
import { SCROLL_CHECK_TIMING } from "./scroll-check";
import {
  SCROLL_CHECK_ADDRESS_CHANGED,
  SCROLL_CHECK_CONSENT_CAVEAT,
  SCROLL_CHECK_EMPTY_FURTHER,
  SCROLL_CHECK_ENTRY,
  SCROLL_CHECK_HEADING,
  SCROLL_CHECK_INCOMPLETE,
  SCROLL_CHECK_MECHANISM_CAVEAT,
  SCROLL_CHECK_NOT_SAVED,
  SCROLL_CHECK_NOT_SAVED_UNSCROLLED,
  SCROLL_CHECK_REPORT_NOTE,
  SCROLL_CHECK_REPORT_NOTE_NOT_RUN,
  SCROLL_CHECK_SEPARATION,
  SCROLL_CHECK_STARTING_POINT,
  SCROLL_CHECK_TIMING_CAVEAT,
  SCROLL_CHECK_VISIT_BUDGET,
  SCROLL_CHECK_VISIT_BUDGET_REQUESTS,
  scrollCheckNotListedLine,
  scrollCheckOutcomeSentence,
  scrollCheckPanelCopy,
  scrollCheckReportNote,
  scrollCheckSiteLine,
  type ScrollCheckPanelCopy
} from "./scroll-check-copy";
import {
  MAX_SCROLL_CHECK_LISTED_HOSTS,
  MAX_SCROLL_CHECK_SCREENS,
  SCROLL_CHECK_OUTCOMES,
  isScrollCheckEvidence,
  type ScrollCheckEvidence,
  type ScrollCheckScrollWindow,
  type ScrollCheckWindow
} from "./scroll-check-evidence";
import { carriesScrollCheck, shownScrollCheck } from "./scroll-check-result";

const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const VERDICT_WORDS = /\b(?:caused|causes|proves?|safe|honou?rs?|ignores?|complies|comply)\b/i;
const FROM = "20261022-0123456789abcdef0123456789abcdef";

const EMPTY_WINDOW: ScrollCheckWindow = { hosts: [], hostCount: 0, siteCount: 0, requests: 0 };

function scrollWindow(overrides: Partial<ScrollCheckScrollWindow> = {}): ScrollCheckScrollWindow {
  return { ...EMPTY_WINDOW, knownHostRequests: 0, ...overrides };
}

/** Evidence the closed validator accepts, or the test stops. */
function evidence(overrides: Partial<ScrollCheckEvidence>): ScrollCheckEvidence {
  const value: ScrollCheckEvidence = {
    outcome: "reached-end",
    screens: 3,
    control: EMPTY_WINDOW,
    scroll: scrollWindow(),
    incomplete: [],
    addressChanged: false,
    ...overrides
  };
  assert.ok(isScrollCheckEvidence(value), `the fixture evidence does not validate: ${JSON.stringify(value)}`);
  return value;
}

/** A check that found hosts in both windows, as the fixture's lazy page does. */
function richEvidence(): ScrollCheckEvidence {
  return evidence({
    outcome: "reached-end",
    screens: 3,
    control: { hosts: [{ site: "timer.org", hosts: ["pixel.timer.org"] }], hostCount: 1, siteCount: 1, requests: 2 },
    scroll: {
      hosts: [
        { site: "lazy.net", hosts: ["cdn.lazy.net", "player.lazy.net"] },
        { site: "beacon.org", hosts: ["beacon.org"] },
        { site: "tracker.net", hosts: ["{label}.tracker.net"] }
      ],
      hostCount: 4,
      siteCount: 3,
      requests: 9,
      knownHostRequests: 5
    },
    addressChanged: true
  });
}

/** Every line the panel shows, in order. */
function panelLines(copy: ScrollCheckPanelCopy): string[] {
  const windowLines = (window: ScrollCheckPanelCopy["control"]) =>
    window ? [window.line, ...window.sites, ...(window.notListed ? [window.notListed] : []), ...(window.further ? [window.further] : [])] : [];
  return [
    copy.heading,
    ...windowLines(copy.control),
    ...windowLines(copy.scroll),
    ...(copy.traffic ? [copy.traffic] : []),
    copy.outcome,
    ...(copy.addressChanged ? [copy.addressChanged] : []),
    ...copy.incomplete,
    ...copy.caveats,
    copy.notSaved,
    copy.separation
  ];
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.;:])\s+(?=[A-Z0-9])/);
}

test("a check that found hosts says what arrived without input, then while scrolling, in the approved words", () => {
  const copy = scrollCheckPanelCopy(richEvidence());
  assert.equal(copy.heading, "What this page first contacted after scrolling began");
  assert.deepEqual(copy.control, {
    line: "In 10 seconds without scrolling, the page first contacted 1 new third-party host.",
    sites: ["timer.org: pixel.timer.org"],
    notListed: null,
    further: null
  });
  assert.deepEqual(copy.scroll, {
    line: "In the next 10 seconds, while the visit scrolled 3 screens, it first contacted 4 more:",
    sites: ["lazy.net: cdn.lazy.net, player.lazy.net", "beacon.org", "tracker.net: *.tracker.net"],
    notListed: null,
    further: null
  });
  assert.equal(copy.traffic, "While scrolling, the page also sent 5 requests to third parties it had already contacted.");
  assert.equal(copy.outcome, "The visit scrolled to the end of the page, then went back to the top.");
  assert.equal(
    copy.addressChanged,
    "The page changed its own address while scrolling, as pages that load the next article do; the visit stayed on this site."
  );
  assert.deepEqual(copy.incomplete, []);
  assert.deepEqual(copy.caveats, [
    "Being first contacted while scrolling does not show that scrolling was the reason: pages also load things on timers, which the 10 seconds without scrolling measure.",
    "The visit scrolled by script, one screen a second, with no mouse, touch or clicks, so content that waits for those was not reached.",
    "Some sites treat scrolling as agreeing to cookies; this check does not tell whether this page did.",
    "The check began where the single scan ended, on the page as the scan left it, including any made-up test value the scan typed into its fields."
  ]);
  assert.equal(
    copy.notSaved,
    "This visit scrolled the page after the report below was collected, so nothing from it is saved, shared, exported or printed."
  );
  assert.equal(
    copy.separation,
    "This new visit is a different observation from the report you came from, so it can neither confirm nor refute anything in it."
  );
  assert.equal(scrollCheckReportNote(richEvidence()), "The report below covers the visit before the check began.");
});

test("an empty scroll says the page contacted nothing new, and that more could still load", () => {
  const copy = scrollCheckPanelCopy(evidence({ screens: 1, scroll: scrollWindow({ requests: 1, knownHostRequests: 1 }) }));
  assert.equal(copy.control?.line, "In 10 seconds without scrolling, the page first contacted no new third-party host.");
  assert.deepEqual(copy.control?.sites, []);
  assert.deepEqual(copy.scroll, {
    line: "While the visit scrolled 1 screen, the page contacted no third-party host it had not already contacted.",
    sites: [],
    notListed: null,
    further: "Scrolling further, or the way a person does, could still load more."
  });
  assert.equal(copy.traffic, "While scrolling, the page also sent 1 request to a third party it had already contacted.");
  // Nothing was first contacted while scrolling, so the timing caveat has nothing to qualify.
  assert.equal(copy.caveats.includes(SCROLL_CHECK_TIMING_CAVEAT), false);
  assert.deepEqual(copy.caveats, [SCROLL_CHECK_MECHANISM_CAVEAT, SCROLL_CHECK_CONSENT_CAVEAT, SCROLL_CHECK_STARTING_POINT]);
  // No traffic to name, no line.
  assert.equal(scrollCheckPanelCopy(evidence({})).traffic, null);
});

test("a window that counted more hosts than it lists says how many are not listed", () => {
  const sites = Array.from({ length: MAX_SCROLL_CHECK_LISTED_HOSTS }, (_, index) => ({
    site: `site${String(index).padStart(2, "0")}.net`,
    hosts: [`site${String(index).padStart(2, "0")}.net`]
  }));
  const copy = scrollCheckPanelCopy(
    evidence({ scroll: scrollWindow({ hosts: sites, hostCount: 23, siteCount: 23, requests: 23 }) })
  );
  assert.equal(copy.scroll?.line, "In the next 10 seconds, while the visit scrolled 3 screens, it first contacted 23 more:");
  assert.equal(copy.scroll?.sites.length, MAX_SCROLL_CHECK_LISTED_HOSTS);
  assert.equal(copy.scroll?.notListed, "3 more are not listed.");
  assert.equal(scrollCheckNotListedLine(1), "1 more is not listed.");
  assert.equal(scrollCheckNotListedLine(1_204), "1,204 more are not listed.");
  assert.equal(scrollCheckSiteLine({ site: "{label}.example.co.uk", hosts: ["{label}.example.co.uk"] }), "*.example.co.uk");
});

test("what cut collection is said once, and the list caveat only beside a list", () => {
  const budget = scrollCheckPanelCopy(evidence({ incomplete: ["visit-budget"] }));
  assert.deepEqual(budget.incomplete, [
    "The single scan had already reached its limit of 1,000 requests, so the page was missing some of its own requests when the check began."
  ]);
  for (const reason of ["check-allowance", "proxy-budget", "refused", "host-bound"] as const) {
    assert.deepEqual(scrollCheckPanelCopy(evidence({ incomplete: [reason] })).incomplete, [SCROLL_CHECK_INCOMPLETE], reason);
  }
  assert.deepEqual(scrollCheckPanelCopy(evidence({ incomplete: ["visit-budget", "check-allowance", "host-bound"] })).incomplete, [
    SCROLL_CHECK_VISIT_BUDGET,
    SCROLL_CHECK_INCOMPLETE
  ]);
  // A check stopped before any window ended shows no list to qualify.
  const early = scrollCheckPanelCopy(evidence({ outcome: "cut-short", screens: 0, control: null, scroll: null, incomplete: ["visit-budget", "refused"] }));
  assert.deepEqual(early.incomplete, [SCROLL_CHECK_VISIT_BUDGET]);
  // The sentence's number is the scanner's own request budget.
  assert.equal(SCROLL_CHECK_VISIT_BUDGET_REQUESTS, MAX_RECORDED_REQUESTS);
});

test("each outcome reads as approved, and a corrected draft stands in only where the approved one is false", () => {
  assert.equal(scrollCheckOutcomeSentence({ outcome: "reached-end", screens: 2 }), "The visit scrolled to the end of the page, then went back to the top.");
  assert.equal(
    scrollCheckOutcomeSentence({ outcome: "depth-limit", screens: 8 }),
    "The visit scrolled 8 screens, its limit; the page continued below that, and nothing further down was reached."
  );
  assert.equal(
    scrollCheckOutcomeSentence({ outcome: "did-not-move", screens: 0 }),
    "The page was taller than the window but did not move when scrolled, so nothing below the first screen was reached."
  );
  assert.equal(
    scrollCheckOutcomeSentence({ outcome: "locked", screens: 0 }),
    "The page was taller than the window but had scrolling turned off, so the visit did not scroll it."
  );
  assert.equal(scrollCheckOutcomeSentence({ outcome: "nothing-to-scroll", screens: 0 }), "The page fit in the window, so there was nothing to scroll.");
  assert.equal(scrollCheckOutcomeSentence({ outcome: "left-site", screens: 1 }), "The page left this site during the check, so the check stopped there.");
  assert.equal(
    scrollCheckOutcomeSentence({ outcome: "not-run", screens: 0 }),
    "The check did not run, because this visit could not load the page normally."
  );
  // Corrected drafts: after a screen, the visit had scrolled the page; and a
  // check can stop early for more than its time.
  assert.equal(
    scrollCheckOutcomeSentence({ outcome: "locked", screens: 2 }),
    "The page turned scrolling off after the visit had scrolled 2 screens, so the visit scrolled it no further."
  );
  assert.equal(
    scrollCheckOutcomeSentence({ outcome: "did-not-move", screens: 1 }),
    "The page stopped moving when scrolled after 1 screen, so nothing further down was reached."
  );
  assert.equal(scrollCheckOutcomeSentence({ outcome: "cut-short", screens: 0 }), "The check stopped early, before it could finish.");
  // The depth limit is the scanner's.
  assert.match(scrollCheckOutcomeSentence({ outcome: "depth-limit", screens: MAX_SCROLL_CHECK_SCREENS }), new RegExp(`scrolled ${MAX_SCROLL_CHECK_SCREENS} screens`));
});

test("every outcome the validator admits leaves out what did not happen", () => {
  const cases: ScrollCheckEvidence[] = [];
  for (const outcome of SCROLL_CHECK_OUTCOMES) {
    for (let screens = 0; screens <= MAX_SCROLL_CHECK_SCREENS; screens += 1) {
      for (const control of [null, EMPTY_WINDOW]) {
        for (const scroll of [null, scrollWindow()]) {
          const value = { outcome, screens, control, scroll, incomplete: [], addressChanged: false };
          if (isScrollCheckEvidence(value)) cases.push(value);
        }
      }
    }
  }
  assert.ok(cases.length > 30, `only ${cases.length} shapes`);
  const outcomesSeen = new Set(cases.map((value) => value.outcome));
  assert.deepEqual([...outcomesSeen].sort(), [...SCROLL_CHECK_OUTCOMES].sort());
  for (const value of cases) {
    const label = JSON.stringify({ outcome: value.outcome, screens: value.screens, control: value.control !== null, scroll: value.scroll !== null });
    const copy = scrollCheckPanelCopy(value);
    const lines = panelLines(copy);
    const scrolled = value.screens > 0;
    // Only a visit that moved the page says it scrolled.
    if (!scrolled) assert.equal(lines.some((line) => /visit scrolled|visit had scrolled/.test(line)), false, label);
    assert.equal(copy.notSaved, scrolled ? SCROLL_CHECK_NOT_SAVED : SCROLL_CHECK_NOT_SAVED_UNSCROLLED, label);
    assert.equal(copy.caveats.includes(SCROLL_CHECK_MECHANISM_CAVEAT), scrolled, label);
    assert.equal(copy.caveats.includes(SCROLL_CHECK_CONSENT_CAVEAT), scrolled, label);
    // A check that did not run began nowhere.
    assert.equal(copy.caveats.includes(SCROLL_CHECK_STARTING_POINT), value.outcome !== "not-run", label);
    assert.equal(scrollCheckReportNote(value), value.outcome === "not-run" ? SCROLL_CHECK_REPORT_NOTE_NOT_RUN : SCROLL_CHECK_REPORT_NOTE, label);
    // A window that did not run to its end has no line.
    assert.equal(copy.control === null, value.control === null, label);
    assert.equal(copy.scroll === null, value.scroll === null, label);
    assert.equal(copy.addressChanged, null, label);
    assert.equal(copy.heading, SCROLL_CHECK_HEADING);
    assert.equal(copy.separation, SCROLL_CHECK_SEPARATION);
  }
  // The address line appears exactly when the evidence says so.
  assert.equal(scrollCheckPanelCopy(evidence({ addressChanged: true })).addressChanged, SCROLL_CHECK_ADDRESS_CHANGED);
  assert.equal(scrollCheckPanelCopy(evidence({ screens: 2, scroll: scrollWindow() })).scroll?.further, SCROLL_CHECK_EMPTY_FURTHER);
});

test("the copy's fixed numbers are the check's own", () => {
  // "10 seconds" for each window, "one screen a second" for each step.
  assert.equal(Math.floor(SCROLL_CHECK_TIMING.controlWindowMs / 1_000), 10);
  assert.equal(Math.floor(SCROLL_CHECK_TIMING.scrollWindowMs / 1_000), 10);
  assert.equal(SCROLL_CHECK_TIMING.stepDwellMs, 1_000);
  assert.match(SCROLL_CHECK_TIMING_CAVEAT, /the 10 seconds without scrolling/);
  assert.match(SCROLL_CHECK_MECHANISM_CAVEAT, /one screen a second/);
});

test("no line is longer than 30 words, or holds a dash or a verdict word", () => {
  const shapes = [
    richEvidence(),
    evidence({ screens: 1, scroll: scrollWindow({ requests: 1, knownHostRequests: 1 }), incomplete: ["visit-budget", "check-allowance"] }),
    evidence({ outcome: "locked", screens: 4, scroll: scrollWindow() }),
    evidence({ outcome: "did-not-move", screens: 1, scroll: scrollWindow() }),
    evidence({ outcome: "depth-limit", screens: 8 }),
    evidence({ outcome: "not-run", screens: 0, control: null, scroll: null }),
    evidence({ outcome: "cut-short", screens: 0, control: null, scroll: null }),
    evidence({ outcome: "nothing-to-scroll", screens: 0, scroll: null }),
    evidence({ outcome: "left-site", screens: 2, scroll: null })
  ];
  const texts = [
    ...shapes.flatMap((value) => [...panelLines(scrollCheckPanelCopy(value)), scrollCheckReportNote(value)]),
    SCROLL_CHECK_ENTRY.label,
    SCROLL_CHECK_ENTRY.sentence,
    scrollCheckNotListedLine(2)
  ];
  for (const text of texts) {
    for (const sentence of sentencesOf(text)) {
      assert.ok(sentence.split(/\s+/).length <= 30, `over 30 words: ${sentence}`);
    }
    assert.equal(DASHES.test(text), false, text);
    assert.equal(VERDICT_WORDS.test(text), false, text);
  }
});

function shell(scrollCheck?: ScrollCheckEvidence): LoadedReport {
  return {
    source: "v2-r2-ephemeral",
    wire: { reportType: "single", ephemeral: { screenshot: null, ...(scrollCheck ? { scrollCheck } : {}) } },
    public: {},
    view: {}
  } as unknown as LoadedReport;
}

test("a result shows the check its own scan asked for, and a check's result is known by its block", () => {
  const value = richEvidence();
  assert.deepEqual(shownScrollCheck(shell(value), { from: FROM }), { evidence: value, from: FROM });
  assert.deepEqual(shownScrollCheck(shell(value), { from: null }), { evidence: value, from: null });
  // A scan that asked for none shows none, whatever the shell carries.
  assert.equal(shownScrollCheck(shell(value), null), null);
  // A shell without the block is an ordinary result, not a check that found nothing.
  assert.equal(shownScrollCheck(shell(), { from: FROM }), null);
  // Only an r2 single shell carries one.
  assert.equal(shownScrollCheck({ ...shell(value), source: "v2-r2-public" } as unknown as LoadedReport, { from: FROM }), null);
  assert.equal(carriesScrollCheck(shell(value)), true);
  assert.equal(carriesScrollCheck(shell()), false);
  assert.equal(carriesScrollCheck({ ...shell(value), source: "v2-r2-public" } as unknown as LoadedReport), false);
});
