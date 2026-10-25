import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SCROLL_CHECK_BLOCKING_CAVEAT,
  SCROLL_CHECK_LISTS_NAME,
  SCROLL_CHECK_LISTS_UNAVAILABLE,
  SCROLL_CHECK_MATCHING_CAVEAT,
  SCROLL_CHECK_UNCOMPARED_HEADING_APPROVED,
  scrollCheckLabelsShown,
  scrollCheckListHeading,
  scrollCheckPanelCopy,
  type ScrollCheckPanelCopy,
  type ScrollCheckWindowCopy
} from "./scroll-check-copy";
import {
  SCROLL_CHECK_EVENTS_LIST_LABELS,
  SCROLL_CHECK_EVENTS_STANDARD_SETTING,
  scrollCheckEventDestinationLine,
  scrollCheckEventNames,
  scrollCheckEventsCopy,
  type ScrollCheckEventsCopy
} from "./scroll-check-events-copy";
import {
  isScrollCheckEvidence,
  SCROLL_CHECK_LIST_STATES,
  type ScrollCheckEventDestination,
  type ScrollCheckEvidence,
  type ScrollCheckFilterLists,
  type ScrollCheckListState,
  type ScrollCheckScrollWindow,
  type ScrollCheckSiteHosts,
  type ScrollCheckWindow
} from "./scroll-check-evidence";
import { displayHost } from "./text-format";

/**
 * The same-visit labels' words (build brief 2026-10-25, section 4, owner
 * calls 3, 4 and 6): the headings a labelled window's list splits under, the
 * destinations' brackets, the note for the site's own addresses, the
 * caveats, and the line for an engine that was not loaded. A truth table over
 * the evidence shapes the validator admits holds which line shows, in which
 * words, and that a result without labels reads exactly as before.
 */

const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const VERDICT_WORDS = /\b(?:caused|causes|proves?|safe|honou?rs?|ignores?|complies|comply)\b/i;

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.;:])\s+(?=[A-Z0-9])/);
}

test("the labels speak in the approved words, the not-compared heading as a corrected draft beside its approved text", () => {
  assert.equal(scrollCheckListHeading("matched", 3), "3 had a request that matched the default filter lists of Brave Shields:");
  assert.equal(scrollCheckListHeading("matched", 1), "1 had a request that matched the default filter lists of Brave Shields:");
  assert.equal(scrollCheckListHeading("no-match", 2), "2 had none that matched:");
  assert.equal(scrollCheckListHeading("no-match", 1), "1 had none that matched:");
  // Corrected draft: the approved heading names a reason the evidence does not carry.
  assert.equal(
    scrollCheckListHeading("not-compared", 1),
    "1 had no request this check compared with the lists; it does not compare requests that followed a redirect:"
  );
  assert.equal(SCROLL_CHECK_UNCOMPARED_HEADING_APPROVED, "`<i>` were reached only through redirects, which this check does not compare with the lists:");
  assert.equal(scrollCheckListHeading("matched", 1_204), "1,204 had a request that matched the default filter lists of Brave Shields:");
  assert.deepEqual(SCROLL_CHECK_EVENTS_LIST_LABELS, {
    matched: "(matched the default filter lists of Brave Shields)",
    "no-match": "(no match in those lists)",
    "not-compared": "(not compared with those lists)"
  });
  assert.equal(
    SCROLL_CHECK_EVENTS_STANDARD_SETTING,
    "Brave says its default Standard setting does not apply these lists to requests to a site's own addresses; its Aggressive setting does."
  );
  assert.equal(SCROLL_CHECK_MATCHING_CAVEAT, "Matching is computed while the page loads normally; it is not a measured block.");
  assert.equal(
    SCROLL_CHECK_BLOCKING_CAVEAT,
    "With blocking on, what a matched request would load never runs, so a visit with Shields might also skip hosts that had no match."
  );
  assert.equal(SCROLL_CHECK_LISTS_UNAVAILABLE, "This check could not compare its requests with the default filter lists of Brave Shields.");
  assert.equal(
    scrollCheckEventDestinationLine({ format: "GA4", host: "analytics.google.com", ownSite: false, beacons: 1, events: [{ name: "scroll", percent: 90, count: 1 }], customEvents: 0, lists: "matched" }),
    "GA4 events to analytics.google.com (matched the default filter lists of Brave Shields): scroll (90%)."
  );
  assert.equal(
    scrollCheckEventDestinationLine({ format: "GA4", host: "{label}.example.com", ownSite: true, beacons: 1, events: [{ name: "page_view", percent: null, count: 1 }], customEvents: 0, lists: "no-match" }),
    "GA4 events to *.example.com, an address on this site (no match in those lists): page_view."
  );
});

test("the lists' name and the matching caveat are the report's own words", () => {
  const tables = readFileSync("app/_components/report-tables.tsx", "utf8");
  const findings = readFileSync("lib/report-findings.ts", "utf8");
  assert.ok(tables.includes(SCROLL_CHECK_MATCHING_CAVEAT), "the report's request-table title no longer says the matching caveat");
  assert.ok(tables.includes(SCROLL_CHECK_LISTS_NAME) && findings.includes(`matched ${SCROLL_CHECK_LISTS_NAME}`));
  // The destination's bracket says the same lists in the same words.
  assert.equal(SCROLL_CHECK_EVENTS_LIST_LABELS.matched, `(matched ${SCROLL_CHECK_LISTS_NAME})`);
  assert.ok(SCROLL_CHECK_LISTS_UNAVAILABLE.includes(SCROLL_CHECK_LISTS_NAME));
});

// The truth table's parts.
const SITES: ScrollCheckSiteHosts[] = [
  { site: "bravo.net", hosts: ["cdn.bravo.net", "img.bravo.net"] },
  { site: "alpha.net", hosts: ["alpha.net"] },
  { site: "charlie.org", hosts: ["{label}.charlie.org"] }
];
const ALL_HOSTS = SITES.flatMap((group) => group.hosts);

/** Every way to give each of these hosts a state. */
function assignments(hosts: string[]): Array<Record<string, ScrollCheckListState>> {
  let out: Array<Record<string, ScrollCheckListState>> = [{}];
  for (const host of hosts) out = out.flatMap((partial) => SCROLL_CHECK_LIST_STATES.map((state) => ({ ...partial, [host]: state })));
  return out;
}

function arraysFor(hosts: string[], states: Record<string, ScrollCheckListState>) {
  return {
    matchedHosts: hosts.filter((host) => states[host] === "matched"),
    uncomparedHosts: hosts.filter((host) => states[host] === "not-compared")
  };
}

function destination(ownSite: boolean, lists: ScrollCheckListState | undefined): ScrollCheckEventDestination {
  return {
    format: ownSite ? "GA4" : "Adobe Analytics",
    host: ownSite ? "{label}.example.com" : "metrics.adobeprobe.net",
    ownSite,
    beacons: 1,
    events: [{ name: "scroll depth", percent: 50, count: 1 }],
    customEvents: 0,
    ...(lists ? { lists } : {})
  };
}

type Shape = { evidence: ScrollCheckEvidence; states: Record<string, ScrollCheckListState> };

function shapes(): Shape[] {
  const out: Shape[] = [];
  const add = (value: unknown, states: Record<string, ScrollCheckListState>) => {
    if (isScrollCheckEvidence(value)) out.push({ evidence: value, states });
  };
  const controlHosts = [{ site: "timer.org", hosts: ["pixel.timer.org"] }];
  for (const filterLists of [undefined, "unavailable", "compared"] as Array<ScrollCheckFilterLists | undefined>) {
    const compared = filterLists === "compared";
    for (const scrollHosts of [[], SITES]) {
      const listed = scrollHosts.flatMap((group) => group.hosts);
      for (const cut of [false, true]) {
        if (cut && listed.length === 0) continue;
        const scrollStates = compared ? assignments(listed) : [{}];
        // The window without input lists one host, or none, so a compared
        // result can label nothing shown (its only destinations in that window).
        for (const controlState of compared ? (["matched", "no-match", "not-compared", "unlisted"] as const) : (["no-match", "unlisted"] as const)) {
          const controlListed = controlState === "unlisted" ? [] : ["pixel.timer.org"];
          for (const states of scrollStates) {
            for (const events of ["none", "own", "third", "both", "control-only"] as const) {
              const destinationStates = compared && events !== "none" ? SCROLL_CHECK_LIST_STATES : [undefined];
              for (const destinationState of destinationStates) {
                const control: ScrollCheckWindow = {
                  hosts: controlListed.length > 0 ? controlHosts : [],
                  hostCount: controlListed.length,
                  siteCount: controlListed.length,
                  requests: controlListed.length,
                  ...(compared ? arraysFor(controlListed, controlState === "unlisted" ? {} : { "pixel.timer.org": controlState }) : {})
                };
                const hostCount = listed.length + (cut ? 3 : 0);
                const scroll: ScrollCheckScrollWindow = {
                  hosts: scrollHosts,
                  hostCount,
                  siteCount: scrollHosts.length + (cut ? 2 : 0),
                  requests: hostCount + 2,
                  knownHostRequests: 2,
                  ...(compared ? arraysFor(listed, states) : {})
                };
                const scrollDestinations =
                  events === "own"
                    ? [destination(true, destinationState)]
                    : events === "third"
                      ? [destination(false, destinationState)]
                      : events === "both"
                        ? [destination(true, destinationState), destination(false, destinationState === "matched" ? "no-match" : destinationState)]
                        : [];
                const controlDestinations = events === "control-only" ? [destination(false, destinationState)] : [];
                const value = {
                  outcome: "reached-end",
                  screens: 3,
                  control,
                  scroll,
                  incomplete: [],
                  addressChanged: false,
                  ...(events === "none"
                    ? {}
                    : {
                        events: {
                          control: { beacons: controlDestinations.length, destinations: controlDestinations, notDecoded: 0 },
                          scroll: { beacons: scrollDestinations.length, destinations: scrollDestinations, notDecoded: 0 }
                        }
                      }),
                  ...(filterLists ? { filterLists } : {})
                };
                add(value, controlState === "unlisted" ? states : { ...states, "pixel.timer.org": controlState });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** The headings a labelled window must show, spelled out here rather than by the copy module. */
function expectedHeadings(listed: string[], states: Record<string, ScrollCheckListState>): string[] {
  const words: Record<ScrollCheckListState, (n: string) => string> = {
    matched: (n) => `${n} had a request that matched the default filter lists of Brave Shields:`,
    "no-match": (n) => `${n} had none that matched:`,
    "not-compared": (n) => `${n} had no request this check compared with the lists; it does not compare requests that followed a redirect:`
  };
  return SCROLL_CHECK_LIST_STATES.flatMap((state) => {
    const n = listed.filter((host) => states[host] === state).length;
    return n > 0 ? [words[state](n.toLocaleString("en-US"))] : [];
  });
}

function windowLines(window: ScrollCheckWindowCopy | null): string[] {
  if (!window) return [];
  return [
    window.line,
    ...window.sites,
    ...(window.groups ?? []).flatMap((group) => [group.heading, ...group.sites]),
    ...(window.notListed ? [window.notListed] : []),
    ...(window.further ? [window.further] : [])
  ];
}

function panelLines(copy: ScrollCheckPanelCopy): string[] {
  return [
    copy.heading,
    ...windowLines(copy.control),
    ...windowLines(copy.scroll),
    ...(copy.traffic ? [copy.traffic] : []),
    ...(copy.noAnswer ? [copy.noAnswer] : []),
    copy.outcome,
    ...(copy.addressChanged ? [copy.addressChanged] : []),
    ...copy.incomplete,
    ...copy.caveats,
    copy.notSaved,
    copy.separation
  ];
}

function eventLines(copy: ScrollCheckEventsCopy | null): string[] {
  if (!copy) return [];
  return [
    copy.heading,
    ...(copy.control ? [copy.control] : []),
    ...(copy.scroll ? [copy.scroll] : []),
    ...copy.destinations,
    ...copy.ownSite,
    ...(copy.standardSetting ? [copy.standardSetting] : []),
    ...(copy.notDecoded ? [copy.notDecoded] : []),
    ...copy.caveats
  ];
}

test("every shape the validator admits shows each label line once, in the order and words the approved copy gives, and a result without labels reads as before", () => {
  const all = shapes();
  assert.ok(all.length > 500, `only ${all.length} shapes`);
  const seen = { absent: 0, unavailable: 0, compared: 0, controlOnly: 0, nothingShown: 0 };
  for (const { evidence, states } of all) {
    const label = JSON.stringify({ filterLists: evidence.filterLists, scroll: evidence.scroll, events: evidence.events });
    const copy = scrollCheckPanelCopy(evidence);
    const events = scrollCheckEventsCopy(evidence);
    const compared = evidence.filterLists === "compared";
    seen[evidence.filterLists ?? "absent"] += 1;
    for (const [window, windowCopy] of [
      [evidence.control, copy.control],
      [evidence.scroll, copy.scroll]
    ] as const) {
      if (window === null || windowCopy === null) continue;
      const listed = window.hosts.flatMap((group) => group.hosts);
      if (compared && listed.length > 0) {
        // Split under its headings: every listed host once, under its own state.
        assert.deepEqual(windowCopy.sites, [], label);
        assert.deepEqual(windowCopy.groups?.map((group) => group.heading), expectedHeadings(listed, states), label);
        for (const group of windowCopy.groups ?? []) {
          const sitesInState: ScrollCheckSiteHosts[] = window.hosts
            .map((entry) => ({ site: entry.site, hosts: entry.hosts.filter((host) => states[host] === group.state) }))
            .filter((entry) => entry.hosts.length > 0);
          const expectedSites: string[] = sitesInState.map((entry) =>
            entry.hosts.length === 1 && entry.hosts[0] === entry.site
              ? displayHost(entry.site)
              : `${displayHost(entry.site)}: ${entry.hosts.map(displayHost).join(", ")}`
          );
          assert.deepEqual(group.sites, expectedSites, label);
        }
      } else {
        // As before: one list, no heading.
        assert.equal("groups" in windowCopy, false, label);
        assert.equal(windowCopy.sites.length, window.hosts.length, label);
      }
      // The more-hosts line follows, saying nothing about lists.
      if (window.hostCount > listed.length) assert.match(windowCopy.notListed ?? "", /^\d[\d,]* more (?:is|are) not listed\.$/, label);
    }
    // The caveats: the unavailable line alone for an engine that was not
    // loaded; the two matching caveats once each when a label shows; and
    // neither for a result without labels.
    const shown = compared && ((evidence.control?.hosts.length ?? 0) > 0 || (evidence.scroll?.hosts.length ?? 0) > 0 || (evidence.events?.scroll?.destinations.length ?? 0) > 0);
    assert.equal(scrollCheckLabelsShown(evidence), shown, label);
    // Compared, with only the window without input's destinations to label,
    // which that window's one count line never shows: no label shows.
    if (compared && !shown) seen.nothingShown += 1;
    assert.equal(copy.caveats.filter((line) => line === SCROLL_CHECK_LISTS_UNAVAILABLE).length, evidence.filterLists === "unavailable" ? 1 : 0, label);
    assert.equal(copy.caveats.filter((line) => line === SCROLL_CHECK_MATCHING_CAVEAT).length, shown ? 1 : 0, label);
    assert.equal(copy.caveats.filter((line) => line === SCROLL_CHECK_BLOCKING_CAVEAT).length, shown ? 1 : 0, label);
    if (evidence.filterLists === undefined) {
      assert.equal(panelLines(copy).some((line) => line.includes("filter lists") || line.includes("Matching is computed")), false, label);
    }
    // The destinations: a bracket exactly when the destination carries a
    // state; the Standard-setting note once, beside a labelled destination on
    // the site itself.
    const destinations = evidence.events?.scroll?.destinations ?? [];
    if (events) {
      destinations.forEach((entry, index) => {
        const line = events.destinations[index];
        assert.equal(line.includes(" ("), entry.lists !== undefined, `${label}: ${line}`);
        if (entry.lists !== undefined) assert.ok(line.includes(`${SCROLL_CHECK_EVENTS_LIST_LABELS[entry.lists]}:`), line);
      });
      const ownLabelled = destinations.some((entry) => entry.ownSite && entry.lists !== undefined);
      assert.equal(events.standardSetting, ownLabelled ? SCROLL_CHECK_EVENTS_STANDARD_SETTING : undefined, label);
      if (!ownLabelled) assert.equal("standardSetting" in events, false, label);
      if (compared && destinations.length === 0 && (evidence.events?.control?.destinations.length ?? 0) > 0) seen.controlOnly += 1;
    }
    // Every line: 30 words a sentence, a destination's event names aside;
    // no dash or verdict word; counts of one in the singular; no unpublished host marker.
    for (const text of [...panelLines(copy), ...eventLines(events)]) {
      const prose = text.replace(/: scroll depth 50%\.$/, ": LIST.");
      for (const sentence of sentencesOf(prose)) assert.ok(sentence.split(/\s+/).length <= 30, `over 30 words: ${sentence}`);
      assert.equal(DASHES.test(text), false, text);
      assert.equal(VERDICT_WORDS.test(text), false, text);
      assert.equal(/\b1 (?:were|requests|hosts)\b/.test(text), false, `a count of one in the plural: ${text}`);
      assert.equal(/\{label\}|\{invalid-host\}/.test(text), false, `an unpublished host marker: ${text}`);
    }
  }
  assert.ok(seen.absent > 0 && seen.unavailable > 0 && seen.compared > 0 && seen.controlOnly > 0 && seen.nothingShown > 0, JSON.stringify(seen));
});

test("the longest destination line a label can make keeps its own words within 30, its list of events aside", () => {
  for (const lists of SCROLL_CHECK_LIST_STATES) {
    for (const ownSite of [false, true]) {
      // Adobe's two-word name, the site's own address, named events and custom ones.
      const entry: ScrollCheckEventDestination = {
        format: "Adobe Analytics",
        host: ownSite ? "{label}.example.com" : "metrics.adobeprobe.net",
        ownSite,
        beacons: 4,
        events: [
          { name: "scroll depth", percent: 25, count: 1 },
          { name: "scroll depth", percent: 50, count: 1 }
        ],
        customEvents: 2,
        lists
      };
      const line = scrollCheckEventDestinationLine(entry);
      assert.ok(line.includes(SCROLL_CHECK_EVENTS_LIST_LABELS[lists]), line);
      const prose = line.replace(scrollCheckEventNames(entry.events), "LIST");
      for (const sentence of sentencesOf(prose)) assert.ok(sentence.split(/\s+/).length <= 30, `over 30 words: ${sentence}`);
      // As one run, the line's own words are 30 at most too.
      assert.ok(prose.split(/\s+/).length <= 30, `the line's own words run past 30: ${prose}`);
    }
  }
});

test("a result without labels, an older container's included, has exactly the panel and section it had", () => {
  const plain: ScrollCheckEvidence = {
    outcome: "reached-end",
    screens: 3,
    control: { hosts: [{ site: "timer.org", hosts: ["pixel.timer.org"] }], hostCount: 1, siteCount: 1, requests: 2 },
    scroll: { hosts: SITES, hostCount: ALL_HOSTS.length, siteCount: SITES.length, requests: 9, knownHostRequests: 5 },
    incomplete: [],
    addressChanged: false,
    events: {
      control: { beacons: 0, destinations: [], notDecoded: 0 },
      scroll: { beacons: 1, destinations: [destination(true, undefined)], notDecoded: 0 }
    }
  };
  assert.equal(isScrollCheckEvidence(plain), true);
  const copy = scrollCheckPanelCopy(plain);
  assert.deepEqual(copy.scroll, {
    line: "In the next 10 seconds, while the visit scrolled 3 screens, it first contacted 4 more:",
    sites: ["bravo.net: cdn.bravo.net, img.bravo.net", "alpha.net", "charlie.org: *.charlie.org"],
    notListed: null,
    further: null
  });
  const events = scrollCheckEventsCopy(plain);
  assert.equal(events?.destinations[0], "GA4 events to *.example.com, an address on this site: scroll depth 50%.");
  assert.equal(events !== null && "standardSetting" in events, false);
});
