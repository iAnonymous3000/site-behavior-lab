import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { redactHostnameV2 } from "./redaction-v2";
import {
  routeListFacts,
  runScrollCheck,
  SCROLL_CHECK_TIMING,
  ScrollCheckRecorder,
  type ScrollCheckListFacts,
  type ScrollCheckRouteDecision,
  type ScrollCheckRun,
  type ScrollState
} from "./scroll-check";
import { scrollCheckWindowEvents } from "./scroll-check-events";
import { isScrollCheckEvidence, scrollCheckListState, strongerScrollCheckListState, type ScrollCheckListState } from "./scroll-check-evidence";

/**
 * Same-visit list labels (build brief 2026-10-25, part B): the fact the
 * scanner's page route already holds for each request, the three states a
 * listed host or an analytics destination takes from it, and the closed
 * shape that carries them, over the real check (runScrollCheck and its
 * recorder) on a scripted page and a virtual clock.
 */

type FakeRequest = { url: string; navigation?: boolean; redirected?: boolean; body?: string };

/** What the route recorded for a request: matched, compared with no match, or nothing (the engine never ran for it). */
type Route = "matched" | "no-match" | "ineligible" | "unclassified";

type Item = {
  url: string;
  route?: Route;
  decision?: ScrollCheckRouteDecision | null;
  answered?: boolean;
  navigation?: boolean;
  redirected?: boolean;
  body?: string;
};

const FIRST_PARTY = "www.example.com";
const GA = "v=2&tid=G-FIXTURE1&gtm=45je5a&_p=1&cid=111.222";
const published = (host: string) => redactHostnameV2(host).value;

/** The page route's own records, as the scanner keeps them: a classified set and the stored decisions. */
function routeRecords() {
  const classified = new WeakSet<FakeRequest>();
  const matches = new WeakMap<FakeRequest, boolean>();
  const record = (request: FakeRequest, route: Route | undefined) => {
    if (route === "matched" || route === "no-match") {
      classified.add(request);
      matches.set(request, route === "matched");
    }
    // An ineligible request short-circuits to a stored `false` without the engine running.
    if (route === "ineligible") matches.set(request, false);
  };
  return { classified, matches, record };
}

test("the route's list fact reads only what the route recorded, and an ineligible request's stored false reads as not compared", () => {
  const { classified, matches, record } = routeRecords();
  const requests = Object.fromEntries(
    (["matched", "no-match", "ineligible", "unclassified"] as const).map((route) => {
      const request = { url: `http://${route}.example.net/` };
      record(request, route);
      return [route, request];
    })
  ) as Record<Route, FakeRequest>;
  const loaded = routeListFacts(true, classified, matches);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.listMatch(requests.matched), true);
  assert.equal(loaded.listMatch(requests["no-match"]), false);
  // Stored false, never classified: the engine never ran for it.
  assert.equal(matches.get(requests.ineligible), false);
  assert.equal(loaded.listMatch(requests.ineligible), null);
  // A redirect hop, which the route never sees.
  assert.equal(loaded.listMatch(requests.unclassified), null);
  // With no engine, nothing was compared, whatever the records say.
  const unavailable = routeListFacts(false, classified, matches);
  assert.equal(unavailable.loaded, false);
  for (const request of Object.values(requests)) assert.equal(unavailable.listMatch(request), null);
  // The three states, and the strongest of two.
  assert.deepEqual([true, false, null].map(scrollCheckListState), ["matched", "no-match", "not-compared"]);
  const order: ScrollCheckListState[] = ["matched", "no-match", "not-compared"];
  for (const left of order) {
    for (const right of order) {
      assert.equal(strongerScrollCheckListState(left, right), order[Math.min(order.indexOf(left), order.indexOf(right))], `${left} ${right}`);
    }
  }
});

/** One scroll window over these requests, with the route's records as the scanner keeps them. */
function labelledWindow(items: Item[], options: { before?: Item[]; loaded?: boolean } = {}) {
  let now = 0;
  const { classified, matches, record } = routeRecords();
  const recorder = new ScrollCheckRecorder<FakeRequest>(
    {
      url: (request) => request.url,
      redirected: (request) => request.redirected === true,
      mainFrameNavigation: (request) => request.navigation === true,
      filterLists: routeListFacts(options.loaded ?? true, classified, matches)
    },
    () => now
  );
  const deliver = (item: Item) => {
    const request: FakeRequest = { url: item.url, navigation: item.navigation, redirected: item.redirected };
    recorder.noteRequest(request);
    if (item.decision !== null && item.redirected !== true) {
      record(request, item.route);
      recorder.noteRouted(request, item.decision ?? "sent");
    }
    if (item.answered !== false) recorder.noteAnswered(request);
  };
  for (const item of options.before ?? []) {
    now += 1;
    deliver(item);
  }
  now += 1;
  const start = now;
  recorder.openWindow("scroll");
  for (const item of items) {
    now += 1;
    deliver(item);
  }
  recorder.freeze();
  return recorder.windows({ firstPartyHostname: FIRST_PARTY, control: null, scroll: { start, end: now + 1 } });
}

test("each listed host takes the strongest state across its counted requests and every raw host it stands for", () => {
  type Row = { name: string; items: Item[]; before?: Item[]; host: string; state: ScrollCheckListState };
  const rows: Row[] = [
    { name: "a request that matched", items: [{ url: "http://cdn.alpha.net/a", route: "matched" }], host: "cdn.alpha.net", state: "matched" },
    { name: "a request compared with no match", items: [{ url: "http://cdn.alpha.net/a", route: "no-match" }], host: "cdn.alpha.net", state: "no-match" },
    {
      name: "a host reached only by a redirect hop",
      items: [
        { url: "http://api.bravo.net/r", route: "no-match" },
        { url: "http://cdn.charlie.net/landing", redirected: true }
      ],
      host: "cdn.charlie.net",
      state: "not-compared"
    },
    {
      name: "an ineligible request whose stored decision is false",
      items: [{ url: "http://cdn.alpha.net/frame", route: "ineligible" }],
      host: "cdn.alpha.net",
      state: "not-compared"
    },
    {
      name: "a matched request that got no answer beside an answered one that matched nothing",
      items: [
        { url: "http://cdn.alpha.net/a", route: "matched", answered: false },
        { url: "http://cdn.alpha.net/b", route: "no-match" }
      ],
      host: "cdn.alpha.net",
      state: "no-match"
    },
    {
      name: "one matched request among several",
      items: [
        { url: "http://cdn.alpha.net/a", route: "no-match" },
        { url: "http://cdn.alpha.net/b", route: "matched" },
        { url: "http://cdn.alpha.net/c", route: "no-match" }
      ],
      host: "cdn.alpha.net",
      state: "matched"
    },
    {
      name: "a published host over two raw hosts, one matched and one not",
      items: [
        { url: "http://north.lima.net/a", route: "no-match" },
        { url: "http://south.lima.net/b", route: "matched" }
      ],
      host: "{label}.lima.net",
      state: "matched"
    },
    {
      name: "a published host over two raw hosts, one with no match and one only a redirect's hop",
      items: [
        { url: "http://east.mike.net/a", route: "no-match" },
        { url: "http://go.echo.net/r", route: "no-match" },
        { url: "http://west.mike.net/landing", redirected: true }
      ],
      host: "{label}.mike.net",
      state: "no-match"
    },
    {
      name: "a published host over two raw hosts reached only by hops",
      items: [
        { url: "http://go.echo.net/r", route: "no-match" },
        { url: "http://east.mike.net/landing", redirected: true },
        { url: "http://go.echo.net/r2", route: "no-match" },
        { url: "http://west.mike.net/landing", redirected: true }
      ],
      host: "{label}.mike.net",
      state: "not-compared"
    },
    {
      name: "a known raw host that publishes as a listed one never lends it its state",
      before: [{ url: "http://north.lima.net/early", route: "matched" }],
      items: [
        { url: "http://north.lima.net/again", route: "matched" },
        { url: "http://south.lima.net/b", route: "no-match" }
      ],
      host: "{label}.lima.net",
      state: "no-match"
    }
  ];
  for (const row of rows) {
    const { scroll, lists } = labelledWindow(row.items, { before: row.before });
    assert.ok(scroll && lists, row.name);
    assert.equal(lists.filterLists, "compared", row.name);
    const listed = scroll.hosts.flatMap((group) => group.hosts);
    const host = row.host.includes("{label}") ? row.host : published(row.host);
    assert.ok(listed.includes(host), `${row.name}: ${host} is not listed in ${JSON.stringify(listed)}`);
    const labels = lists.scroll;
    assert.ok(labels, row.name);
    const state = labels.matchedHosts.includes(host) ? "matched" : labels.uncomparedHosts.includes(host) ? "not-compared" : "no-match";
    assert.equal(state, row.state, row.name);
    // Each listed host once, in the listed order, in at most one array.
    for (const array of [labels.matchedHosts, labels.uncomparedHosts]) {
      assert.deepEqual(array, listed.filter((candidate) => array.includes(candidate)), row.name);
    }
    assert.equal(labels.matchedHosts.some((candidate) => labels.uncomparedHosts.includes(candidate)), false, row.name);
  }
});

test("without the engine every window says so once, and without the fact the windows are as before", () => {
  const items: Item[] = [{ url: "http://cdn.alpha.net/a", route: "matched" }];
  const unavailable = labelledWindow(items, { loaded: false });
  assert.deepEqual(unavailable.lists, { filterLists: "unavailable", control: null, scroll: null });
  // The fact is the only input that changes: no fact, no labels.
  let now = 0;
  const plain = new ScrollCheckRecorder<FakeRequest>({ url: (request) => request.url, redirected: () => false, mainFrameNavigation: () => false }, () => now);
  plain.openWindow("scroll");
  now = 5;
  const request = { url: "http://cdn.alpha.net/a" };
  plain.noteRequest(request);
  plain.noteRouted(request, "sent");
  plain.noteAnswered(request);
  plain.freeze();
  const windows = plain.windows({ firstPartyHostname: FIRST_PARTY, control: null, scroll: { start: 0, end: 10 } });
  assert.equal("lists" in windows, false);
  assert.deepEqual(windows.scroll, labelledWindow(items).scroll);
});

test("each array keeps the listed order, which puts the sites with the most hosts first, not name order", () => {
  const { scroll, lists } = labelledWindow([
    { url: "http://alpha.net/a", route: "matched" },
    { url: "http://cdn.zulu.net/z", route: "matched" },
    { url: "http://img.zulu.net/z", route: "matched" },
    { url: "http://cdn.yankee.net/y" },
    { url: "http://img.yankee.net/y" }
  ]);
  const listed = scroll?.hosts.flatMap((group) => group.hosts) ?? [];
  // Two sites with two hosts each come first, by name, then the site with one.
  assert.deepEqual(listed, ["cdn.yankee.net", "img.yankee.net", "cdn.zulu.net", "img.zulu.net", "alpha.net"]);
  assert.deepEqual(lists?.scroll?.matchedHosts, ["cdn.zulu.net", "img.zulu.net", "alpha.net"]);
  assert.deepEqual(lists?.scroll?.uncomparedHosts, ["cdn.yankee.net", "img.yankee.net"]);
});

test("the scanner hands the check its own route's records, the classified set first, and nothing else", () => {
  // No fixture can make Chromium report a counted request the route left
  // ineligible (Playwright 1.63 reports no request without a frame, and the
  // main frame's own navigation never counts), so the wiring is held here,
  // and the fact's rule by the tests above.
  const scanner = readFileSync("lib/scanner.ts", "utf8");
  assert.equal(scanner.split("filterLists: routeListFacts(adblockEngine !== null, shieldsClassifiedRequests, shieldsMatches)").length, 2);
  assert.equal(scanner.split("routeListFacts(").length, 2, "the scanner builds its list facts once");
  // The classified set is filled only inside the metered engine wrapper the route uses.
  assert.equal(scanner.split("shieldsClassifiedRequests.add(request);").length, 2);
});

test("a destination takes the strongest state across the beacons grouped into it, and carries one only when asked", () => {
  const beacon = (host: string, listMatch: boolean | null, event = "page_view") => ({
    host,
    url: `http://${host}/g/collect?${GA}&en=${event}`,
    body: () => ({ value: null, truncated: false, unreadable: false }),
    listMatch
  });
  const window = scrollCheckWindowEvents(
    [
      beacon("gtm.example.com", false),
      beacon("gtm.example.com", true, "scroll"),
      beacon("collect.tally.net", false),
      beacon("collect.tally.net", null),
      beacon("data.quiet.net", null)
    ],
    FIRST_PARTY,
    { lists: true }
  );
  const states = Object.fromEntries(window.destinations.map((destination) => [destination.host, destination.lists]));
  assert.deepEqual(states, { [published("gtm.example.com")]: "matched", "collect.tally.net": "no-match", [published("data.quiet.net")]: "not-compared" });
  const plain = scrollCheckWindowEvents([beacon("gtm.example.com", true)], FIRST_PARTY);
  assert.equal(plain.destinations.every((destination) => !("lists" in destination)), true);
});

// The production timing, on the navigation's own clock.
const NAV = 1_000_000;
const CONTROL_START = NAV + SCROLL_CHECK_TIMING.settleAfterNavigationMs;
const SCROLL_START = CONTROL_START + SCROLL_CHECK_TIMING.controlWindowMs;

type Scheduled = Item & { at: number };

/** A check over a scripted page, its route records kept as the scanner keeps them. */
async function check(options: { scheduled: Scheduled[]; loaded?: boolean; facts?: "none" | "throws"; bodies?: boolean }) {
  let now = NAV + 10_000;
  const startedAt = now;
  const { classified, matches, record } = routeRecords();
  const listFacts: ScrollCheckListFacts<FakeRequest> | undefined =
    options.facts === "none"
      ? undefined
      : options.facts === "throws"
        ? {
            loaded: true,
            listMatch: () => {
              throw new Error("the route's records could not be read");
            }
          }
        : routeListFacts(options.loaded ?? true, classified, matches);
  const recorder = new ScrollCheckRecorder<FakeRequest>(
    {
      url: (request) => request.url,
      redirected: (request) => request.redirected === true,
      mainFrameNavigation: (request) => request.navigation === true,
      ...(options.bodies === false ? {} : { postData: (request: FakeRequest) => ({ value: request.body ?? null, truncated: false, unreadable: false }) }),
      ...(listFacts ? { filterLists: listFacts } : {})
    },
    () => now
  );
  const queue = [...options.scheduled].sort((left, right) => left.at - right.at);
  const advance = (until: number) => {
    while (queue.length > 0 && queue[0].at <= until) {
      const item = queue.shift() as Scheduled;
      now = Math.max(now, item.at);
      const request: FakeRequest = { url: item.url, navigation: item.navigation, redirected: item.redirected, body: item.body };
      recorder.noteRequest(request);
      if (item.decision !== null && item.redirected !== true) {
        record(request, item.route);
        recorder.noteRouted(request, item.decision ?? "sent");
      }
      if (item.answered !== false) recorder.noteAnswered(request);
    }
    now = Math.max(now, until);
  };
  advance(startedAt);
  const height = 980 * 3;
  let top = 0;
  const run: ScrollCheckRun<FakeRequest> = {
    recorder,
    timing: SCROLL_CHECK_TIMING,
    navigationStartedAt: NAV,
    startedAt,
    subjectAvailable: true,
    firstPartyHostname: FIRST_PARTY,
    sameSubject: () => true,
    leftSiteAt: () => null,
    visitBudgetUsedUp: false,
    proxyLossCount: () => 0,
    settleRoutes: async () => undefined,
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
  return evidence;
}

const IN_SCROLL = SCROLL_START + 4_000;
const IN_CONTROL = CONTROL_START + 2_000;

/** A page whose listed hosts and destinations are in every state the fixture's are. */
function labelledPage(): Scheduled[] {
  return [
    { at: IN_CONTROL, url: "http://pixel.timer.org/t.png", route: "no-match" },
    { at: IN_SCROLL, url: "http://metrics.adobeprobe.net/b/ss/rsid/1/JS-2.22.0/s1?AQB=1&ndh=1&pe=lnk_o&pev2=x&AQE=1", route: "matched" },
    { at: IN_SCROLL + 10, url: "http://cdn.quiet.net/data.json", route: "no-match" },
    { at: IN_SCROLL + 20, url: "http://api.echo.net/r", route: "no-match" },
    { at: IN_SCROLL + 30, url: "http://cdn.foxtrot.net/landing", redirected: true },
    { at: IN_SCROLL + 40, url: `http://gtm.example.com/g/collect?${GA}&en=scroll&epn.percent_scrolled=90`, route: "matched" }
  ];
}

test("labels ride the evidence beside what they label: both windows' hosts and every destination, with filterLists saying the lists were compared", async () => {
  const evidence = await check({ scheduled: labelledPage() });
  assert.equal(evidence.filterLists, "compared");
  // The window without input lists one host, which matched nothing.
  assert.deepEqual(evidence.control?.matchedHosts, []);
  assert.deepEqual(evidence.control?.uncomparedHosts, []);
  assert.deepEqual(evidence.scroll?.matchedHosts, ["metrics.adobeprobe.net"]);
  assert.deepEqual(evidence.scroll?.uncomparedHosts, ["cdn.foxtrot.net"]);
  assert.deepEqual(
    evidence.events?.scroll?.destinations.map((destination) => [destination.host, destination.ownSite, destination.lists]),
    [
      [published("gtm.example.com"), true, "matched"],
      ["metrics.adobeprobe.net", false, "matched"]
    ]
  );
});

test("filterLists is carried only beside a listed host or destination, and says when the lists could not be compared", async () => {
  // Nothing listed, no destination: no labels at all.
  const quiet = await check({ scheduled: [{ at: IN_SCROLL, url: "http://www.example.com/lazy.png", route: "no-match" }] });
  assert.equal("filterLists" in quiet, false);
  assert.equal(quiet.scroll !== null && "matchedHosts" in quiet.scroll, false);
  // A destination alone, on the site's own host: compared, with empty host arrays.
  const own = await check({ scheduled: [{ at: IN_SCROLL, url: `http://gtm.example.com/g/collect?${GA}&en=scroll`, route: "matched" }] });
  assert.equal(own.filterLists, "compared");
  assert.deepEqual([own.control?.matchedHosts, own.control?.uncomparedHosts, own.scroll?.matchedHosts, own.scroll?.uncomparedHosts], [[], [], [], []]);
  assert.equal(own.events?.scroll?.destinations[0]?.lists, "matched");
  // No engine: the lists are named unavailable, and nothing else is added.
  const unavailable = await check({ scheduled: labelledPage(), loaded: false });
  assert.equal(unavailable.filterLists, "unavailable");
  const withoutFact = await check({ scheduled: labelledPage(), facts: "none" });
  assert.equal("filterLists" in withoutFact, false);
  const { filterLists: _filterLists, ...rest } = unavailable;
  assert.deepEqual(rest, withoutFact, "without the engine, the evidence gained more than the one field");
});

test("a fact that cannot be read costs the check its labels, never anything else", async () => {
  const broken = await check({ scheduled: labelledPage(), facts: "throws" });
  const withoutFact = await check({ scheduled: labelledPage(), facts: "none" });
  assert.deepEqual(broken, withoutFact);
});

test("the validator takes the check's own labels and refuses every one-thing change to them", async () => {
  const evidence = await check({ scheduled: labelledPage() });
  assert.equal(isScrollCheckEvidence(evidence), true);
  const scroll = evidence.scroll;
  const control = evidence.control;
  const events = evidence.events;
  assert.ok(scroll && control && events?.scroll);
  const listed = scroll.hosts.flatMap((group) => group.hosts);
  // The page lists, in order, metrics.adobeprobe.net (matched), api.echo.net, cdn.foxtrot.net (not compared) and cdn.quiet.net.
  assert.deepEqual(listed, ["metrics.adobeprobe.net", "api.echo.net", "cdn.foxtrot.net", "cdn.quiet.net"]);
  const destinations = events.scroll.destinations;
  const withScroll = (change: Record<string, unknown>) => ({ ...evidence, scroll: { ...scroll, ...change } });
  const withoutKey = <T extends object>(value: T, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
  const changes: Array<[string, unknown]> = [
    ["an unknown filterLists", { ...evidence, filterLists: "partial" }],
    ["arrays beside unavailable", { ...evidence, filterLists: "unavailable" }],
    ["arrays with no filterLists", withoutKey(evidence, "filterLists")],
    ["a matched host the window does not list", withScroll({ matchedHosts: ["cdn.elsewhere.net"] })],
    ["matched hosts out of listed order", withScroll({ matchedHosts: ["cdn.quiet.net", "metrics.adobeprobe.net"] })],
    ["a host in both arrays", withScroll({ uncomparedHosts: ["metrics.adobeprobe.net", "cdn.foxtrot.net"] })],
    ["a host twice in one array", withScroll({ matchedHosts: ["metrics.adobeprobe.net", "metrics.adobeprobe.net"] })],
    ["a host that is not a string", withScroll({ uncomparedHosts: [7] })],
    ["the scroll window without its uncompared hosts", { ...evidence, scroll: withoutKey(scroll, "uncomparedHosts") }],
    ["the window without input without its arrays", { ...evidence, control: withoutKey(withoutKey(control, "matchedHosts"), "uncomparedHosts") }],
    [
      "a destination without its state",
      { ...evidence, events: { ...events, scroll: { ...events.scroll, destinations: [withoutKey(destinations[0], "lists"), ...destinations.slice(1)] } } }
    ],
    [
      "a destination in an unknown state",
      { ...evidence, events: { ...events, scroll: { ...events.scroll, destinations: [{ ...destinations[0], lists: "blocked" }, ...destinations.slice(1)] } } }
    ]
  ];
  // The same arrays in their right order are taken: each change above is one thing.
  assert.equal(isScrollCheckEvidence(withScroll({ matchedHosts: ["metrics.adobeprobe.net", "cdn.quiet.net"] })), true);
  for (const [name, changed] of changes) assert.equal(isScrollCheckEvidence(changed), false, `${name} was taken`);
  // Labels without the engine: no arrays and no destination states.
  const unavailable = await check({ scheduled: labelledPage(), loaded: false });
  assert.equal(isScrollCheckEvidence(unavailable), true);
  assert.equal(isScrollCheckEvidence({ ...unavailable, scroll: { ...unavailable.scroll, matchedHosts: [], uncomparedHosts: [] } }), false);
  const unavailableDestinations = unavailable.events?.scroll?.destinations ?? [];
  assert.equal(
    isScrollCheckEvidence({
      ...unavailable,
      events: { ...unavailable.events, scroll: { ...unavailable.events?.scroll, destinations: unavailableDestinations.map((destination) => ({ ...destination, lists: "matched" })) } }
    }),
    false
  );
  // filterLists with nothing to label.
  const quiet = await check({ scheduled: [{ at: IN_SCROLL, url: "http://www.example.com/lazy.png", route: "no-match" }] });
  assert.equal(isScrollCheckEvidence({ ...quiet, filterLists: "unavailable" }), false);
  // The shape before labels, which an older container still writes, still validates beside listed hosts.
  const before = await check({ scheduled: labelledPage(), facts: "none" });
  assert.ok(before.scroll && before.scroll.hostCount > 0);
  assert.equal(isScrollCheckEvidence(before), true);
});
