import assert from "node:assert/strict";
import { test } from "node:test";
import { SCROLL_DEPTH_EVENT } from "./analytics-event-vocabulary";
import { redactHostnameV2 } from "./redaction-v2";
import {
  runScrollCheck,
  SCROLL_CHECK_TIMING,
  ScrollCheckRecorder,
  type ScrollCheckRouteDecision,
  type ScrollCheckRun,
  type ScrollState
} from "./scroll-check";
import * as eventsModule from "./scroll-check-events";
import { scrollCheckEventsCopy } from "./scroll-check-events-copy";
import {
  isScrollCheckEvidence,
  MAX_SCROLL_CHECK_EVENT_BEACONS,
  MAX_SCROLL_CHECK_EVENT_DESTINATIONS,
  MAX_SCROLL_CHECK_EVENT_LINES,
  type ScrollCheckEventDestination,
  type ScrollCheckEvidence,
  type ScrollCheckWindowEvents
} from "./scroll-check-evidence";

/**
 * A check's analytics events over the real check (runScrollCheck and its
 * recorder) on a scripted page and a virtual clock, as
 * lib/scroll-check-stacks.test.ts drives it: `sleep` advances time at once,
 * delivering the page's own request events scheduled inside each interval,
 * so which request lands in which window, what the scanner decided for it,
 * and which bodies are read can be pinned exactly.
 */

type FakeRequest = {
  url: string;
  navigation?: boolean;
  redirected?: boolean;
  body?: string | null;
  truncated?: boolean;
  unreadable?: boolean;
  throws?: boolean;
};

type Scheduled = FakeRequest & { at: number; decision?: ScrollCheckRouteDecision | null };

const NAV = 1_000_000;
const CONTROL_START = NAV + SCROLL_CHECK_TIMING.settleAfterNavigationMs;
const SCROLL_START = CONTROL_START + SCROLL_CHECK_TIMING.controlWindowMs;
const SCROLL_END = SCROLL_START + SCROLL_CHECK_TIMING.scrollWindowMs;

const GA = "v=2&tid=G-FIXTURE1&gtm=45je5a&_p=1&cid=SECRETCID.222&dl=https%3A%2F%2Fwww.example.com%2FSECRETPATH&dt=SECRETTITLE";
const TALLY = "http://collect.tally.net";
const OWN = "http://gtm.example.com";
const ADOBE = "http://metrics.adobeprobe.net/b/ss/fixturersid/1/JS-2.22.0";

async function check(options: { scheduled: Scheduled[]; height?: number; postData?: boolean }) {
  let now = NAV + 5_000;
  const startedAt = now;
  const reads: string[] = [];
  const recorder = new ScrollCheckRecorder<FakeRequest>(
    {
      url: (request) => request.url,
      redirected: (request) => request.redirected === true,
      mainFrameNavigation: (request) => request.navigation === true,
      ...(options.postData === false
        ? {}
        : {
            postData: (request: FakeRequest) => {
              reads.push(request.url);
              if (request.throws) throw new Error("postData failed");
              return { value: request.body ?? null, truncated: request.truncated === true, unreadable: request.unreadable === true };
            }
          })
    },
    () => now
  );
  const queue = [...options.scheduled].map((item, order) => ({ item, order })).sort((left, right) => left.item.at - right.item.at || left.order - right.order);
  const advance = (until: number) => {
    while (queue.length > 0 && queue[0].item.at <= until) {
      const { item } = queue.shift() as { item: Scheduled };
      now = Math.max(now, item.at);
      const { at: _at, decision, ...request } = item;
      recorder.noteRequest(request);
      if (decision !== null && !request.redirected) recorder.noteRouted(request, decision ?? "sent");
      // The host answers every request the scanner let through: a redirect
      // hop, or a route decided as sent.
      if (request.redirected === true || (decision !== null && (decision ?? "sent") === "sent")) recorder.noteAnswered(request);
    }
    now = Math.max(now, until);
  };
  advance(startedAt);
  const height = options.height ?? 980 * 3;
  let top = 0;
  const run: ScrollCheckRun<FakeRequest> = {
    recorder,
    timing: SCROLL_CHECK_TIMING,
    navigationStartedAt: NAV,
    startedAt,
    subjectAvailable: true,
    firstPartyHostname: "www.example.com",
    sameSubject: () => true,
    leftSiteAt: () => null,
    visitBudgetUsedUp: false,
    proxyLossCount: () => 0,
    settleRoutes: async () => advance(now + 200),
    now: () => now,
    sleep: async (ms, stop) => {
      if (stop) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (stop.aborted) return;
      }
      advance(now + ms);
    },
    page: {
      url: () => "http://www.example.com/",
      scrollState: async (): Promise<ScrollState> => ({ top, height, viewport: 980, locked: false }),
      scrollTo: async (target) => {
        top = Math.min(target, height - 980);
        return true;
      }
    }
  };
  const evidence = await runScrollCheck(run);
  assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
  return { evidence, reads };
}

const line = (name: string, percent: number | null = null, count = 1) => ({ name, percent, count });
const depth = (percent: number) => line(SCROLL_DEPTH_EVENT, percent);

/** The page of the fixture: a timer's beacon without input, then GA4 batches to the site's own tagging host and Adobe links to a third party while scrolling. */
function richPage(): Scheduled[] {
  return [
    // During the ordinary visit, before either window: never counted.
    { at: NAV + 400, url: `${TALLY}/g/collect?${GA}&en=page_view`, body: "" },
    // A timer's beacon in the window without input.
    { at: CONTROL_START + 3_000, url: `${TALLY}/g/collect?${GA}&en=user_engagement&_et=4000`, body: "" },
    // While scrolling: GA4 batches sent with sendBeacon to the site's own tagging host.
    { at: SCROLL_START + 1_100, url: `${OWN}/g/collect?${GA}&en=scroll_depth_20%25`, body: "en=scroll&epn.percent_scrolled=90&_et=12\r\nen=video_player_load&ep.player=SECRETPLAYER\r\nen=page_view" },
    { at: SCROLL_START + 2_100, url: `${OWN}/g/collect?${GA}`, body: "en=scroll_depth_40%25\r\nen=scroll_depth_60%25&ep.section=SECRETSECTION" },
    // Adobe links to a third party: one by image, one long enough to go by POST.
    { at: SCROLL_START + 1_200, url: `${ADOBE}/s1?AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025&events=event41&mid=SECRETMID&AQE=1` },
    { at: SCROLL_START + 2_200, url: `${ADOBE}/s2`, body: `AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2050&events=event42&c1=${"x".repeat(3_000)}&AQE=1` },
    // Neither format: Universal Analytics.
    { at: SCROLL_START + 2_300, url: `${TALLY}/collect?v=1&tid=UA-1-1&t=event&ec=scroll` },
    // In a decoded format, but not counted: refused by the scanner, refused
    // by the check's allowance, undecided, a redirect hop, the page's own
    // navigation.
    { at: SCROLL_START + 2_400, url: `${TALLY}/g/collect?${GA}&en=refused`, decision: "refused", body: "en=refused_body" },
    { at: SCROLL_START + 2_500, url: `${TALLY}/g/collect?${GA}&en=allowance`, decision: "allowance", body: "en=allowance_body" },
    { at: SCROLL_START + 2_550, url: `${TALLY}/g/collect?${GA}&en=undecided`, decision: null, body: "en=undecided_body" },
    { at: SCROLL_START + 2_600, url: `${TALLY}/g/collect?${GA}&en=hop`, redirected: true, body: "en=hop_body" },
    { at: SCROLL_START + 2_700, url: `${OWN}/g/collect?${GA}&en=navigation`, navigation: true, body: "en=navigation_body" },
    // After the scroll window: never counted.
    { at: SCROLL_END + 100, url: `${TALLY}/g/collect?${GA}&en=late`, body: "en=late_body" }
  ];
}

const TALLY_HOST = redactHostnameV2("collect.tally.net").value;
const OWN_HOST = redactHostnameV2("gtm.example.com").value;
const ADOBE_HOST = redactHostnameV2("metrics.adobeprobe.net").value;

test("each window carries the events its page sent, counted by the recorder's own rules, the site's own hosts included", async () => {
  const { evidence, reads } = await check({ scheduled: richPage() });
  assert.equal(evidence.outcome, "reached-end");
  assert.deepEqual(evidence.events, {
    control: {
      beacons: 1,
      destinations: [{ format: "GA4", host: TALLY_HOST, ownSite: false, beacons: 1, events: [line("user_engagement")], customEvents: 0 }],
      notDecoded: 0
    },
    scroll: {
      beacons: 4,
      destinations: [
        {
          format: "GA4",
          host: OWN_HOST,
          ownSite: true,
          beacons: 2,
          events: [line("page_view"), line("scroll", 90), depth(20), depth(40), depth(60)],
          customEvents: 1
        },
        { format: "Adobe Analytics", host: ADOBE_HOST, ownSite: false, beacons: 2, events: [depth(25), depth(50)], customEvents: 0 }
      ],
      notDecoded: 0
    }
  });
  // A body is read only for the requests counted: never one refused, undecided,
  // a hop, a navigation, outside both windows, or in no decoded format.
  assert.deepEqual(
    [...reads].sort(),
    [
      `${TALLY}/g/collect?${GA}&en=user_engagement&_et=4000`,
      `${OWN}/g/collect?${GA}&en=scroll_depth_20%25`,
      `${OWN}/g/collect?${GA}`,
      `${ADOBE}/s1?AQB=1&ndh=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025&events=event41&mid=SECRETMID&AQE=1`,
      `${ADOBE}/s2`
    ].sort()
  );
  // The host lists are unchanged by it: the site's own host is never listed,
  // the Adobe host is first contacted while scrolling, and the timer's host,
  // contacted during the visit, is new in neither window while its event
  // still counts.
  assert.deepEqual(evidence.scroll?.hosts, [{ site: "adobeprobe.net", hosts: [ADOBE_HOST] }]);
  assert.deepEqual(evidence.control?.hosts, []);
});

test("the section's words, for the check's own evidence of the fixture page", async () => {
  const { evidence } = await check({ scheduled: richPage() });
  assert.deepEqual(scrollCheckEventsCopy(evidence), {
    heading: "Analytics events the page sent",
    control: "In 10 seconds without scrolling, the page sent 1 analytics event.",
    scroll: "While scrolling, it sent 8:",
    destinations: [
      "GA4 events to *.example.com, an address on this site: page_view, scroll (90%), scroll depth 20%, 40%, 60%, and 1 custom event whose name this check does not show.",
      "Adobe Analytics events to metrics.adobeprobe.net: scroll depth 25%, 50%."
    ],
    ownSite: ["An address on this site receives these in GA4's format; the visit cannot see where it passes them on."],
    notDecoded: null,
    caveats: [
      "Only events in GA4's standard collection format and Adobe Analytics' classic beacons are read; other analytics tools and formats are not.",
      "Being sent while scrolling does not show that scrolling was the reason, though scroll-depth events are usually sent for it."
    ]
  });
});

test("without a body reader, the check decodes nothing and its evidence is as it was", async () => {
  const withReader = await check({ scheduled: richPage() });
  const withoutReader = await check({ scheduled: richPage(), postData: false });
  assert.equal(Object.prototype.hasOwnProperty.call(withoutReader.evidence, "events"), false);
  const { events: _events, ...rest } = withReader.evidence;
  assert.deepEqual(rest, withoutReader.evidence);
  assert.deepEqual(withoutReader.reads, []);
});

test("events are carried only when a window received an event or could not read one in full", async () => {
  // No beacon at all, and beacons that carry no event, show nothing.
  const quiet = await check({ scheduled: [{ at: SCROLL_START + 1_100, url: "http://cdn.alpha.net/x.js" }] });
  assert.equal(Object.prototype.hasOwnProperty.call(quiet.evidence, "events"), false);
  const nameless = await check({
    scheduled: [
      { at: CONTROL_START + 1_000, url: `${TALLY}/g/collect?${GA}`, body: "" },
      { at: SCROLL_START + 1_100, url: `${ADOBE}/s1` }
    ]
  });
  assert.equal(Object.prototype.hasOwnProperty.call(nameless.evidence, "events"), false, JSON.stringify(nameless.evidence.events));
  assert.equal(nameless.reads.length, 2);
  // One that could not be read in full is said.
  const unread = await check({ scheduled: [{ at: SCROLL_START + 1_100, url: `${TALLY}/g/collect?${GA}`, body: "en=scroll", truncated: true }] });
  assert.deepEqual(unread.evidence.events, {
    control: { beacons: 0, destinations: [], notDecoded: 0 },
    scroll: { beacons: 1, destinations: [], notDecoded: 1 }
  });
  // Events in the scroll window alone still carry the window without input's empty part.
  const scrollOnly = await check({ scheduled: [{ at: SCROLL_START + 1_100, url: `${TALLY}/g/collect?${GA}&en=scroll&epn.percent_scrolled=90` }] });
  assert.deepEqual(scrollOnly.evidence.events?.control, { beacons: 0, destinations: [], notDecoded: 0 });
  assert.equal(scrollOnly.evidence.events?.scroll?.destinations.length, 1);
});

test("a destination that received no event is not listed, and its beacons still count", async () => {
  const { evidence } = await check({
    scheduled: [
      // A GA4-format beacon that names no event, as a measurement-only hit does.
      { at: CONTROL_START + 1_000, url: `http://stats.signals.net/g/collect?${GA}`, body: "" },
      { at: SCROLL_START + 1_100, url: `${TALLY}/g/collect?${GA}&en=scroll&epn.percent_scrolled=90` },
      { at: SCROLL_START + 1_200, url: `${ADOBE}/s1` },
      { at: SCROLL_START + 1_300, url: `${ADOBE}/s2?AQB=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025&AQE=1` }
    ]
  });
  assert.deepEqual(evidence.events, {
    control: { beacons: 1, destinations: [], notDecoded: 0 },
    scroll: {
      beacons: 3,
      destinations: [
        { format: "Adobe Analytics", host: ADOBE_HOST, ownSite: false, beacons: 2, events: [depth(25)], customEvents: 0 },
        { format: "GA4", host: TALLY_HOST, ownSite: false, beacons: 1, events: [line("scroll", 90)], customEvents: 0 }
      ],
      notDecoded: 0
    }
  });
});

test("a check with no scroll window carries the window without input's events alone", async () => {
  const { evidence } = await check({
    scheduled: [{ at: CONTROL_START + 2_000, url: `${TALLY}/g/collect?${GA}&en=user_engagement` }],
    height: 980
  });
  assert.equal(evidence.outcome, "nothing-to-scroll");
  assert.equal(evidence.scroll, null);
  assert.deepEqual(evidence.events, {
    control: {
      beacons: 1,
      destinations: [{ format: "GA4", host: TALLY_HOST, ownSite: false, beacons: 1, events: [line("user_engagement")], customEvents: 0 }],
      notDecoded: 0
    },
    scroll: null
  });
});

test("a body not read in full is counted, never guessed at", async () => {
  const { evidence } = await check({
    scheduled: [
      { at: SCROLL_START + 1_100, url: `${OWN}/g/collect?${GA}&en=page_view`, body: "en=scroll&epn.percent_scrolled=90", truncated: true },
      { at: SCROLL_START + 1_200, url: `${OWN}/g/collect?${GA}&en=page_view`, body: null, unreadable: true },
      { at: SCROLL_START + 1_300, url: `${OWN}/g/collect?${GA}&en=page_view`, throws: true },
      { at: SCROLL_START + 1_400, url: `${OWN}/g/collect?${GA}`, body: '{"en":"scroll"}' },
      { at: SCROLL_START + 1_500, url: `${ADOBE}/s1`, body: "AQB=1&pe=lnk_o&pev2=On%20scroll_tracking%20of%2025", truncated: true }
    ]
  });
  // The URLs' events stay; nothing from the unread bodies, and Adobe's link
  // type may sit in the part not read, so its beacon names no event.
  assert.deepEqual(evidence.events?.scroll, {
    beacons: 5,
    destinations: [{ format: "GA4", host: OWN_HOST, ownSite: true, beacons: 4, events: [line("page_view", null, 3)], customEvents: 0 }],
    notDecoded: 5
  });
});

test("at most 200 beacons are decoded a window, and the bodies of the rest are never read", async () => {
  const scheduled: Scheduled[] = Array.from({ length: MAX_SCROLL_CHECK_EVENT_BEACONS + 7 }, (_value, index) => ({
    at: SCROLL_START + 1_000 + index,
    url: `${TALLY}/g/collect?${GA}&_s=${index}&en=page_view`,
    body: "en=user_engagement"
  }));
  scheduled.push({ at: CONTROL_START + 1_000, url: `${TALLY}/g/collect?${GA}&en=page_view`, body: "" });
  const { evidence, reads } = await check({ scheduled });
  const scroll = evidence.events?.scroll as ScrollCheckWindowEvents;
  assert.equal(scroll.beacons, MAX_SCROLL_CHECK_EVENT_BEACONS);
  assert.equal(scroll.notDecoded, 7);
  assert.deepEqual(scroll.destinations[0].events, [line("page_view", null, 200), line("user_engagement", null, 200)]);
  // 200 in the scroll window, in arrival order, and the window without input's own one.
  assert.equal(reads.length, MAX_SCROLL_CHECK_EVENT_BEACONS + 1);
  for (let index = 0; index < 7; index += 1) {
    assert.equal(reads.includes(`${TALLY}/g/collect?${GA}&_s=${MAX_SCROLL_CHECK_EVENT_BEACONS + index}&en=page_view`), false);
  }
  assert.equal(evidence.events?.control?.beacons, 1, "the bound is per window");
});

test("at most ten destinations and twenty event lines are listed, and each request past them is counted once", async () => {
  const scheduled: Scheduled[] = [];
  // Twelve destinations, the first with the most events; ties fall to the
  // host's name. Each is its own site, since numbered labels publish alike.
  for (let index = 0; index < 12; index += 1) {
    const host = `http://collect.tally${String(index).padStart(2, "0")}.net`;
    scheduled.push({ at: SCROLL_START + 1_000 + index, url: `${host}/g/collect?${GA}&en=page_view`, body: index === 0 ? "en=scroll" : "" });
  }
  // One destination with twenty-two lines: scroll depths 1% to 22%. The
  // beacon that carries 21% and 22% also lost its body's tail.
  const lines = Array.from({ length: 20 }, (_value, index) => `en=scroll_depth_${index + 1}%25`).join("\r\n");
  scheduled.push({ at: SCROLL_START + 2_000, url: `${OWN}/g/collect?${GA}`, body: lines });
  scheduled.push({ at: SCROLL_START + 2_001, url: `${OWN}/g/collect?${GA}&en=scroll_depth_21%25`, body: "en=scroll_depth_22%25", truncated: true });
  scheduled.push({ at: SCROLL_START + 2_002, url: `${OWN}/g/collect?${GA}&en=scroll_depth_22%25` });
  const { evidence } = await check({ scheduled });
  const scroll = evidence.events?.scroll as ScrollCheckWindowEvents;
  assert.equal(scroll.beacons, 15);
  assert.equal(scroll.destinations.length, MAX_SCROLL_CHECK_EVENT_DESTINATIONS);
  const own = scroll.destinations[0];
  assert.equal(own.host, OWN_HOST);
  assert.equal(own.events.length, MAX_SCROLL_CHECK_EVENT_LINES);
  assert.deepEqual(own.events, Array.from({ length: 20 }, (_value, index) => depth(index + 1)));
  assert.equal(own.beacons, 3, "a destination's beacons stay full");
  assert.deepEqual(
    scroll.destinations.slice(1).map((destination) => destination.host),
    Array.from({ length: 9 }, (_value, index) => `collect.tally${String(index).padStart(2, "0")}.net`)
  );
  // Past the bounds: tally09 to tally11 (three requests), and the two
  // beacons that carried 21% and 22%, the truncated one counted once.
  assert.equal(scroll.notDecoded, 5);
});

test("events the closed shape would refuse are dropped, never the check", async () => {
  const plain = await check({ scheduled: richPage(), postData: false });
  const original = eventsModule.scrollCheckWindowEvents;
  const mutable = eventsModule as unknown as { scrollCheckWindowEvents: typeof original };
  try {
    // As a bug would: a destination naming a site's own event.
    mutable.scrollCheckWindowEvents = (requests, firstPartyHostname) => {
      const events = original(requests, firstPartyHostname);
      return {
        ...events,
        destinations: events.destinations.map((destination) => ({ ...destination, events: [{ name: "Newsletter_Signup", percent: null, count: 1 }] }))
      };
    };
    const corrupted = await check({ scheduled: richPage() });
    assert.deepEqual(corrupted.evidence, plain.evidence);
    // And a builder that throws.
    mutable.scrollCheckWindowEvents = () => {
      throw new Error("the builder failed");
    };
    const thrown = await check({ scheduled: richPage() });
    assert.deepEqual(thrown.evidence, plain.evidence);
  } finally {
    mutable.scrollCheckWindowEvents = original;
  }
});

test("no URL, path, query, body, identifier or site's own name reaches the events", async () => {
  const { evidence } = await check({ scheduled: richPage() });
  const serialized = JSON.stringify(evidence.events);
  for (const forbidden of [
    "SECRET",
    "G-FIXTURE1",
    "fixturersid",
    "event41",
    "video_player_load",
    "scroll_depth",
    "On scroll_tracking",
    "/g/collect",
    "/b/ss/",
    "http",
    "?",
    "collect.tally.net".replace(TALLY_HOST, "unpublished")
  ]) {
    assert.equal(serialized.includes(forbidden), false, `the events carry ${forbidden}`);
  }
});

test("the validator takes the check's own events and refuses every one-thing change to them", async () => {
  const { evidence } = await check({ scheduled: richPage() });
  assert.equal(isScrollCheckEvidence(evidence), true);
  type Mutation = [string, (events: Record<string, any>) => unknown];
  const scrollDestination = (events: Record<string, any>, index: number, change: (destination: Record<string, any>) => unknown) => ({
    ...events,
    scroll: {
      ...events.scroll,
      destinations: events.scroll.destinations.map((destination: Record<string, any>, position: number) => (position === index ? change(destination) : destination))
    }
  });
  const ownEvents = (events: Record<string, any>, change: (lines: Array<Record<string, any>>) => unknown) =>
    scrollDestination(events, 0, (destination) => ({ ...destination, events: change(destination.events) }));
  const mutations: Mutation[] = [
    ["events that are not an object", () => []],
    ["events present but undefined", () => undefined],
    ["an extra key", (events) => ({ ...events, before: null })],
    ["a missing window", ({ control: _dropped, ...rest }) => rest],
    ["a part for a window that did not run", (events) => events],
    ["no part for a window that ran", (events) => ({ ...events, control: null })],
    ["a window with an extra key", (events) => ({ ...events, scroll: { ...events.scroll, urls: [] } })],
    ["a window without its count", (events) => ({ ...events, scroll: { ...events.scroll, notDecoded: undefined } })],
    ["more than 200 beacons", (events) => ({ ...events, scroll: { ...events.scroll, beacons: MAX_SCROLL_CHECK_EVENT_BEACONS + 1 } })],
    ["fewer beacons than its destinations received", (events) => ({ ...events, scroll: { ...events.scroll, beacons: 3 } })],
    ["more requests not read than beacons, short of the bound", (events) => ({ ...events, scroll: { ...events.scroll, notDecoded: 5 } })],
    ["a fractional count", (events) => ({ ...events, scroll: { ...events.scroll, notDecoded: 0.5 } })],
    ["destinations out of order", (events) => ({ ...events, scroll: { ...events.scroll, destinations: [...events.scroll.destinations].reverse() } })],
    ["a destination listed twice", (events) => ({ ...events, scroll: { ...events.scroll, beacons: 6, destinations: [events.scroll.destinations[0], events.scroll.destinations[0]] } })],
    ["eleven destinations", (events) => ({
      ...events,
      scroll: {
        ...events.scroll,
        beacons: 200,
        destinations: Array.from({ length: 11 }, (_value, index) => ({ format: "GA4", host: `c${String(index).padStart(2, "0")}.tally.net`, ownSite: false, beacons: 1, events: [{ name: "page_view", percent: null, count: 1 }], customEvents: 0 }))
      }
    })],
    ["an unknown format", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, format: "Segment" }))],
    ["a raw URL for a host", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, host: "http://metrics.adobeprobe.net/b/ss/x" }))],
    ["an IP literal for a host", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, host: "203.0.113.9" }))],
    ["a string own-site flag", (events) => scrollDestination(events, 0, (destination) => ({ ...destination, ownSite: "yes" }))],
    ["a destination with an extra key", (events) => scrollDestination(events, 0, (destination) => ({ ...destination, path: "/g/collect" }))],
    ["a destination of no beacons", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, beacons: 0 }))],
    ["a destination of no events", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, events: [] }))],
    ["more Adobe events than beacons", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, customEvents: 1 }))],
    ["a site's own event name", (events) => ownEvents(events, (lines) => [...lines.slice(0, 4), { name: "video_player_load", percent: null, count: 1 }])],
    ["a GA4 name on an Adobe destination", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, events: [{ name: "page_view", percent: null, count: 1 }, destination.events[1]] }))],
    ["an Adobe link type on a GA4 destination", (events) => ownEvents(events, (lines) => [{ name: "download link", percent: null, count: 1 }, ...lines.slice(1)])],
    ["the custom label as a name", (events) => ownEvents(events, (lines) => [{ name: "custom event", percent: null, count: 1 }, ...lines.slice(1)])],
    ["a scroll depth with no percent", (events) => ownEvents(events, (lines) => [...lines.slice(0, 2), { name: SCROLL_DEPTH_EVENT, percent: null, count: 1 }, ...lines.slice(3)])],
    ["a scroll depth past 100%", (events) => ownEvents(events, (lines) => [...lines.slice(0, 4), { name: SCROLL_DEPTH_EVENT, percent: 101, count: 1 }])],
    ["a fractional percent", (events) => ownEvents(events, (lines) => [lines[0], { name: "scroll", percent: 90.5, count: 1 }, ...lines.slice(2)])],
    ["a percent on another standard event", (events) => ownEvents(events, (lines) => [{ name: "page_view", percent: 50, count: 1 }, ...lines.slice(1)])],
    ["a percent on an Adobe link type", (events) => scrollDestination(events, 1, (destination) => ({ ...destination, beacons: 3, events: [{ name: "page view", percent: 10, count: 1 }, ...destination.events] }))],
    ["an event line of no count", (events) => ownEvents(events, (lines) => [{ ...lines[0], count: 0 }, ...lines.slice(1)])],
    ["an event line with an extra key", (events) => ownEvents(events, (lines) => [{ ...lines[0], value: "x" }, ...lines.slice(1)])],
    ["event lines out of order", (events) => ownEvents(events, (lines) => [...lines].reverse())],
    ["an event line listed twice", (events) => ownEvents(events, (lines) => [lines[0], ...lines])],
    ["twenty-one event lines", (events) => ownEvents(events, () => Array.from({ length: 21 }, (_value, index) => ({ name: SCROLL_DEPTH_EVENT, percent: index, count: 1 })))],
    ["a negative custom count", (events) => scrollDestination(events, 0, (destination) => ({ ...destination, customEvents: -1 }))],
    ["nothing to show", () => ({ control: { beacons: 0, destinations: [], notDecoded: 0 }, scroll: { beacons: 0, destinations: [], notDecoded: 0 } })]
  ];
  for (const [name, mutate] of mutations) {
    const events = structuredClone(evidence.events) as Record<string, any>;
    const changed = name === "a part for a window that did not run" ? { ...evidence, scroll: null, screens: 0, outcome: "locked", addressChanged: false } : { ...evidence, events: mutate(events) };
    assert.equal(isScrollCheckEvidence(changed), false, `the validator accepted ${name}`);
  }
  // The destination's own order rule: most events first, then most beacons,
  // GA4 before Adobe, by host, the site's own first.
  const destinations = (evidence.events?.scroll?.destinations ?? []) as ScrollCheckEventDestination[];
  assert.deepEqual(destinations.map((destination) => destination.format), ["GA4", "Adobe Analytics"]);
  const swapped = structuredClone(evidence) as ScrollCheckEvidence;
  const adobe = swapped.events?.scroll?.destinations[1] as ScrollCheckEventDestination;
  adobe.events = [depth(5), depth(10), depth(15), depth(20), depth(25), depth(30), depth(35), depth(40)];
  adobe.beacons = 8;
  (swapped.events?.scroll as ScrollCheckWindowEvents).beacons = 10;
  assert.equal(isScrollCheckEvidence(swapped), false, "a destination with more events listed after one with fewer");
});
