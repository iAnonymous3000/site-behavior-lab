import assert from "node:assert/strict";
import { test } from "node:test";
import { SCROLL_DEPTH_EVENT, type AnalyticsFormat } from "./analytics-event-vocabulary";
import {
  isScrollCheckEvidence,
  MAX_SCROLL_CHECK_EVENT_BEACONS,
  MAX_SCROLL_CHECK_EVENT_DESTINATIONS,
  MAX_SCROLL_CHECK_EVENT_LINES,
  scrollCheckDestinationEventTotal,
  type ScrollCheckEventCount,
  type ScrollCheckEventDestination,
  type ScrollCheckEvidence,
  type ScrollCheckWindowEvents
} from "./scroll-check-evidence";
import {
  SCROLL_CHECK_EVENTS_HEADING,
  SCROLL_CHECK_EVENTS_SCOPE,
  SCROLL_CHECK_EVENTS_TIMING,
  scrollCheckEventDestinationLine,
  scrollCheckEventNames,
  scrollCheckEventsControlLine,
  scrollCheckEventsCopy,
  scrollCheckEventsNotDecodedLine,
  scrollCheckEventsOwnSiteNote,
  scrollCheckEventsScrollLine,
  type ScrollCheckEventsCopy
} from "./scroll-check-events-copy";

/**
 * The analytics events section's copy over the evidence shapes the closed
 * validator admits: which lines appear, in which words, and that each
 * sentence keeps the rules every check sentence keeps.
 * lib/scroll-check-events.test.ts holds the section's words to what the real
 * recorder writes for the fixture page.
 */

const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const VERDICT_WORDS = /\b(?:caused|causes|proves?|safe|honou?rs?|ignores?|complies|comply)\b/i;

const line = (name: string, percent: number | null = null, count = 1): ScrollCheckEventCount => ({ name, percent, count });
const depth = (percent: number, count = 1) => line(SCROLL_DEPTH_EVENT, percent, count);

function destination(format: AnalyticsFormat, host: string, ownSite: boolean, events: ScrollCheckEventCount[], customEvents: number, beacons?: number): ScrollCheckEventDestination {
  const total = events.reduce((sum, event) => sum + event.count, 0) + customEvents;
  return { format, host, ownSite, beacons: beacons ?? Math.max(1, total), events, customEvents };
}

/**
 * A whole check whose windows carry exactly these parts, or null when the
 * validator refuses it. A scroll window follows a window without input, so
 * evidence that carries events always has a part for the latter.
 */
function evidenceWith(control: ScrollCheckWindowEvents, scroll: ScrollCheckWindowEvents | null): ScrollCheckEvidence | null {
  const empty = { hosts: [], hostCount: 0, siteCount: 0, requests: 0 };
  const value: ScrollCheckEvidence = {
    outcome: scroll === null ? "nothing-to-scroll" : "reached-end",
    screens: scroll === null ? 0 : 3,
    control: empty,
    scroll: scroll === null ? null : { ...empty, knownHostRequests: 0 },
    incomplete: [],
    addressChanged: false,
    events: { control, scroll }
  };
  return isScrollCheckEvidence(value) ? value : null;
}

function windowOf(destinations: ScrollCheckEventDestination[], notDecoded = 0, beacons?: number): ScrollCheckWindowEvents {
  const received = destinations.reduce((sum, entry) => sum + entry.beacons, 0);
  return { beacons: beacons ?? Math.max(received, notDecoded), destinations, notDecoded };
}

function linesOf(copy: ScrollCheckEventsCopy): string[] {
  return [copy.heading, ...(copy.control ? [copy.control] : []), ...(copy.scroll ? [copy.scroll] : []), ...copy.destinations, ...copy.ownSite, ...(copy.notDecoded ? [copy.notDecoded] : []), ...copy.caveats];
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.;:])\s+(?=[A-Z0-9])/);
}

/** A destination line's own words: the list of events stands aside, as a host list does. */
function proseOf(text: string, destination: ScrollCheckEventDestination | null): string {
  if (destination === null) return text;
  const names = scrollCheckEventNames(destination.events);
  return names === "" ? text : text.replace(names, "LIST");
}

test("a check whose evidence carries no events has no section", () => {
  assert.equal(scrollCheckEventsCopy({}), null);
  assert.equal(scrollCheckEventsCopy({ events: undefined }), null);
});

test("the section speaks in the approved words", () => {
  assert.equal(SCROLL_CHECK_EVENTS_HEADING, "Analytics events the page sent");
  assert.equal(scrollCheckEventsControlLine(2), "In 10 seconds without scrolling, the page sent 2 analytics events.");
  assert.equal(scrollCheckEventsControlLine(1), "In 10 seconds without scrolling, the page sent 1 analytics event.");
  assert.equal(scrollCheckEventsControlLine(0), "In 10 seconds without scrolling, the page sent no analytics event.");
  assert.equal(scrollCheckEventsControlLine(1200), "In 10 seconds without scrolling, the page sent 1,200 analytics events.");
  assert.equal(scrollCheckEventsScrollLine(5), "While scrolling, it sent 5:");
  assert.equal(
    scrollCheckEventDestinationLine(destination("GA4", "analytics.google.com", false, [line("scroll", 90)], 0)),
    "GA4 events to analytics.google.com: scroll (90%)."
  );
  assert.equal(
    scrollCheckEventDestinationLine(destination("Adobe Analytics", "smetrics.capitalone.com", true, [depth(25), depth(50), depth(75), depth(100)], 0)),
    "Adobe Analytics events to smetrics.capitalone.com, an address on this site: scroll depth 25%, 50%, 75%, 100%."
  );
  assert.equal(
    scrollCheckEventDestinationLine(destination("GA4", "analytics.google.com", false, [line("page_view")], 2)),
    "GA4 events to analytics.google.com: page_view, and 2 custom events whose names this check does not show."
  );
  assert.equal(
    scrollCheckEventDestinationLine(destination("GA4", "analytics.google.com", false, [line("page_view")], 1)),
    "GA4 events to analytics.google.com: page_view, and 1 custom event whose name this check does not show."
  );
  assert.equal(scrollCheckEventsOwnSiteNote("GA4"), "An address on this site receives these in GA4's format; the visit cannot see where it passes them on.");
  assert.equal(
    scrollCheckEventsOwnSiteNote("Adobe Analytics"),
    "An address on this site receives these in Adobe Analytics' format; the visit cannot see where it passes them on."
  );
  assert.equal(scrollCheckEventsNotDecodedLine(3, false), "3 requests could not be read in full, so some events may be missing.");
  assert.equal(scrollCheckEventsNotDecodedLine(1, false), "1 request could not be read in full, so some events may be missing.");
  assert.equal(
    SCROLL_CHECK_EVENTS_SCOPE,
    "Only events in GA4's standard collection format and Adobe Analytics' classic beacons are read; other analytics tools and formats are not."
  );
  assert.equal(
    SCROLL_CHECK_EVENTS_TIMING,
    "Being sent while scrolling does not show that scrolling was the reason, though scroll-depth events are usually sent for it."
  );
  // The published host is shown as the report shows hosts.
  assert.equal(
    scrollCheckEventDestinationLine(destination("GA4", "{label}.example.com", true, [line("page_view")], 0)),
    "GA4 events to *.example.com, an address on this site: page_view."
  );
});

test("the drafted lines: a scroll window that sent none, repeated events, only custom events, and the bounds", () => {
  assert.equal(scrollCheckEventsScrollLine(0), "While scrolling, it sent no analytics event.");
  assert.equal(
    scrollCheckEventNames([line("page_view", null, 2), line("scroll", 90), line("scroll", null, 3), depth(20, 2), depth(40), line("user_engagement", null, 12)]),
    "page_view twice, scroll (90%), scroll 3 times, scroll depth 20% twice, 40%, user_engagement 12 times"
  );
  assert.equal(
    scrollCheckEventDestinationLine(destination("GA4", "analytics.google.com", false, [], 3)),
    "GA4 events to analytics.google.com: 3 custom events whose names this check does not show."
  );
  assert.equal(
    scrollCheckEventDestinationLine(destination("Adobe Analytics", "metrics.adobeprobe.net", false, [], 1)),
    "Adobe Analytics events to metrics.adobeprobe.net: 1 custom event whose name this check does not show."
  );
  // Corrected draft: where a bound could have applied, the count also holds
  // requests read in full and not listed.
  assert.equal(scrollCheckEventsNotDecodedLine(4, true), "4 requests could not be read in full or were past this check's limits, so some events may be missing.");
  assert.equal(scrollCheckEventsNotDecodedLine(1, true), "1 request could not be read in full or was past this check's limits, so some events may be missing.");
});

/** The destinations a part can hold in the truth table, each a shape the validator takes alone. */
function destinationShapes(): ScrollCheckEventDestination[] {
  const shapes: ScrollCheckEventDestination[] = [];
  const ga4Lists: ScrollCheckEventCount[][] = [[], [line("page_view")], [line("scroll", 90)], [line("scroll")], [line("page_view", null, 2), depth(25, 3)], [depth(20), depth(40), depth(60)]];
  const adobeLists: ScrollCheckEventCount[][] = [[], [line("page view")], [depth(25), depth(50)], [line("download link"), line("exit link")]];
  for (const ownSite of [false, true]) {
    for (const customEvents of [0, 1, 2]) {
      for (const events of ga4Lists) shapes.push(destination("GA4", ownSite ? "{label}.example.com" : "analytics.google.com", ownSite, events, customEvents));
      for (const events of adobeLists) shapes.push(destination("Adobe Analytics", ownSite ? "{label}.example.com" : "metrics.adobeprobe.net", ownSite, events, customEvents));
    }
  }
  return shapes.filter((shape) => scrollCheckDestinationEventTotal(shape) > 0);
}

/** The lines a copy must carry for this evidence, rule by rule. */
function expectedCopy(evidence: ScrollCheckEvidence): ScrollCheckEventsCopy {
  const events = evidence.events as NonNullable<ScrollCheckEvidence["events"]>;
  const total = (part: ScrollCheckWindowEvents) => part.destinations.reduce((sum, entry) => sum + scrollCheckDestinationEventTotal(entry), 0);
  const scroll = events.scroll;
  const sent = scroll ? total(scroll) : 0;
  const formats: string[] = [];
  for (const entry of scroll?.destinations ?? []) if (entry.ownSite && !formats.includes(entry.format)) formats.push(entry.format);
  const notDecoded = (events.control?.notDecoded ?? 0) + (scroll?.notDecoded ?? 0);
  const bounded = [events.control, scroll].some(
    (part) =>
      part !== null &&
      (part.beacons === MAX_SCROLL_CHECK_EVENT_BEACONS ||
        part.destinations.length === MAX_SCROLL_CHECK_EVENT_DESTINATIONS ||
        part.destinations.some((entry) => entry.events.length === MAX_SCROLL_CHECK_EVENT_LINES))
  );
  return {
    heading: SCROLL_CHECK_EVENTS_HEADING,
    control: events.control ? scrollCheckEventsControlLine(total(events.control)) : null,
    scroll: scroll ? scrollCheckEventsScrollLine(sent) : null,
    destinations: (scroll?.destinations ?? []).map(scrollCheckEventDestinationLine),
    ownSite: formats.map((format) => scrollCheckEventsOwnSiteNote(format as AnalyticsFormat)),
    notDecoded: notDecoded > 0 ? scrollCheckEventsNotDecodedLine(notDecoded, bounded) : null,
    caveats: sent > 0 ? [SCROLL_CHECK_EVENTS_SCOPE, SCROLL_CHECK_EVENTS_TIMING] : [SCROLL_CHECK_EVENTS_SCOPE]
  };
}

function checkRules(evidence: ScrollCheckEvidence, label: string): void {
  const copy = scrollCheckEventsCopy(evidence);
  assert.ok(copy, label);
  assert.deepEqual(copy, expectedCopy(evidence), label);
  const destinations = evidence.events?.scroll?.destinations ?? [];
  const lines = linesOf(copy);
  lines.forEach((text) => {
    const owner = destinations.find((entry) => scrollCheckEventDestinationLine(entry) === text) ?? null;
    for (const sentence of sentencesOf(proseOf(text, owner))) assert.ok(sentence.split(/\s+/).length <= 30, `over 30 words: ${sentence}`);
    assert.equal(DASHES.test(text), false, text);
    assert.equal(VERDICT_WORDS.test(text), false, text);
    assert.equal(/\b1 (?:analytics events|requests|custom events)\b/.test(text), false, `a count of one in the plural: ${text}`);
    assert.equal(/\{label\}|\{invalid-host\}/.test(text), false, `an unpublished host marker: ${text}`);
  });
  // The timing caveat follows events sent while scrolling, and only those;
  // the scope caveat is always said.
  const sentWhileScrolling = destinations.some((entry) => scrollCheckDestinationEventTotal(entry) > 0);
  assert.equal(copy.caveats.includes(SCROLL_CHECK_EVENTS_TIMING), sentWhileScrolling, label);
  assert.equal(copy.caveats[0], SCROLL_CHECK_EVENTS_SCOPE, label);
  // An address on the site is labelled in its own line, and noted once per format.
  assert.equal(copy.ownSite.length, new Set(destinations.filter((entry) => entry.ownSite).map((entry) => entry.format)).size, label);
}

test("every shape the validator admits says each line once, and nothing that did not happen", () => {
  const shapes = destinationShapes();
  let checked = 0;
  const parts: Array<ScrollCheckWindowEvents | null> = [null, windowOf([]), windowOf([], 1), windowOf([], 2)];
  for (const shape of shapes) {
    parts.push(windowOf([shape]));
    parts.push(windowOf([shape], 1));
  }
  // Two destinations side by side, in the validator's order, every pair from a sample.
  const sample = shapes.filter((_shape, index) => index % 5 === 0);
  for (const left of sample) {
    for (const right of sample) {
      const pair = [left, { ...right, host: right.ownSite ? "{label}.example.org" : "cdn.other.net" }];
      for (const order of [pair, [...pair].reverse()]) parts.push(windowOf(order));
    }
  }
  for (const control of [windowOf([]), windowOf([destination("GA4", "analytics.google.com", false, [line("user_engagement")], 0)]), windowOf([], 1)]) {
    for (const scroll of parts) {
      const evidence = evidenceWith(control, scroll);
      if (evidence === null) continue;
      checkRules(evidence, JSON.stringify(evidence.events));
      checked += 1;
    }
  }
  assert.ok(checked > 400, `only ${checked} shapes`);
});

test("at a bound, the not-decoded line names the limits; short of every bound, it keeps the approved words", () => {
  const many = Array.from({ length: MAX_SCROLL_CHECK_EVENT_DESTINATIONS }, (_value, index) =>
    destination("GA4", `collect.tally${String(index).padStart(2, "0")}.net`, false, [line("page_view")], 0)
  );
  const tenDestinations = evidenceWith(windowOf([]), windowOf(many, 2));
  assert.ok(tenDestinations);
  assert.equal(scrollCheckEventsCopy(tenDestinations)?.notDecoded, scrollCheckEventsNotDecodedLine(2, true));
  const twentyLines = evidenceWith(
    windowOf([]),
    windowOf([destination("GA4", "{label}.example.com", true, Array.from({ length: MAX_SCROLL_CHECK_EVENT_LINES }, (_value, index) => depth(index + 1)), 0)], 1)
  );
  assert.ok(twentyLines);
  assert.equal(scrollCheckEventsCopy(twentyLines)?.notDecoded, scrollCheckEventsNotDecodedLine(1, true));
  const twoHundred = evidenceWith(windowOf([destination("GA4", "analytics.google.com", false, [line("page_view", null, 200)], 0, 200)], 5, 200), windowOf([]));
  assert.ok(twoHundred);
  assert.equal(scrollCheckEventsCopy(twoHundred)?.notDecoded, scrollCheckEventsNotDecodedLine(5, true));
  const short = evidenceWith(windowOf([]), windowOf([destination("GA4", "analytics.google.com", false, [line("page_view")], 0, 3)], 2));
  assert.ok(short);
  assert.equal(scrollCheckEventsCopy(short)?.notDecoded, "2 requests could not be read in full, so some events may be missing.");
  // Both windows' counts are said together, once.
  const both = evidenceWith(windowOf([], 1), windowOf([destination("GA4", "analytics.google.com", false, [line("page_view")], 0, 3)], 2));
  assert.ok(both);
  assert.equal(scrollCheckEventsCopy(both)?.notDecoded, "3 requests could not be read in full, so some events may be missing.");
  for (const evidence of [tenDestinations, twentyLines, twoHundred, short, both]) checkRules(evidence, JSON.stringify(evidence.events));
});

test("a check with no scroll window, or one that sent nothing while scrolling, says only what it saw", () => {
  const controlOnly = evidenceWith(windowOf([destination("GA4", "analytics.google.com", false, [line("user_engagement")], 1)]), null);
  assert.ok(controlOnly);
  assert.deepEqual(scrollCheckEventsCopy(controlOnly), {
    heading: "Analytics events the page sent",
    control: "In 10 seconds without scrolling, the page sent 2 analytics events.",
    scroll: null,
    destinations: [],
    ownSite: [],
    notDecoded: null,
    caveats: [SCROLL_CHECK_EVENTS_SCOPE]
  });
  const quietScroll = evidenceWith(windowOf([destination("Adobe Analytics", "{label}.example.com", true, [line("page view")], 0)]), windowOf([]));
  assert.ok(quietScroll);
  const copy = scrollCheckEventsCopy(quietScroll);
  assert.equal(copy?.scroll, "While scrolling, it sent no analytics event.");
  assert.deepEqual(copy?.ownSite, [], "the window without input's destinations are a count only");
  assert.deepEqual(copy?.caveats, [SCROLL_CHECK_EVENTS_SCOPE]);
});
