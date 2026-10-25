import assert from "node:assert/strict";
import { test } from "node:test";
import { redactHostnameV2 } from "./redaction-v2";
import {
  runScrollCheck,
  SCROLL_CHECK_REQUEST_ALLOWANCE,
  SCROLL_CHECK_ROUTE_SETTLE_MS,
  SCROLL_CHECK_TIMING,
  ScrollCheckRecorder,
  type ScrollCheckRouteDecision,
  type ScrollCheckRun,
  type ScrollState
} from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence } from "./scroll-check-evidence";
import { ScrollCheckStackRecorder } from "./scroll-check-stacks";

/**
 * Answers (build brief 2026-10-25, part A): a check counts a request only
 * once its host answered it. The recorder's rule as a truth table, then the
 * settle that waits for answers, over the real check (runScrollCheck, its
 * recorder and its stack recorder) on a scripted page and a virtual clock:
 * `sleep` advances time at once, delivering, in time order, the page's
 * request events, the route's decisions, the answers and failures, and the
 * session's observations scheduled inside each interval. A wait that can end
 * early (the settle's) stops at the very event that ends it.
 */

type FakeRequest = { url: string; navigation?: boolean; redirected?: boolean; body?: string };

/** What the request received: a response, a failure, both in that order, or nothing yet. */
type Answer = "answered" | "failed" | "answered-then-failed" | "none";

type PageRequest = {
  url: string;
  decision?: ScrollCheckRouteDecision | null;
  answer?: Answer;
  navigation?: boolean;
  redirected?: boolean;
  body?: string;
};

const FIRST_PARTY = "www.example.com";
const GA = "v=2&tid=G-FIXTURE1&gtm=45je5a&_p=1&cid=111.222";

function facts(withBodies: boolean, reads: string[] = []) {
  return {
    url: (request: FakeRequest) => request.url,
    redirected: (request: FakeRequest) => request.redirected === true,
    mainFrameNavigation: (request: FakeRequest) => request.navigation === true,
    ...(withBodies
      ? {
          postData: (request: FakeRequest) => {
            reads.push(request.url);
            return { value: request.body ?? null, truncated: false, unreadable: false };
          }
        }
      : {})
  };
}

/** Deliver one request the way the scanner's listeners and route do: the request, its decision, then what it received. */
function deliver(recorder: ScrollCheckRecorder<FakeRequest>, item: PageRequest): FakeRequest {
  const request: FakeRequest = { url: item.url, navigation: item.navigation, redirected: item.redirected, body: item.body };
  recorder.noteRequest(request);
  if (item.decision !== null && item.redirected !== true) recorder.noteRouted(request, item.decision ?? "sent");
  const answer = item.answer ?? "answered";
  if (answer === "answered" || answer === "answered-then-failed") recorder.noteAnswered(request);
  if (answer === "failed" || answer === "answered-then-failed") recorder.noteFailed(request);
  return request;
}

/** One scroll window over these requests, after `before` ones the page made earlier. */
function scrollWindowOf(requests: PageRequest[], options: { before?: PageRequest[]; bodies?: boolean } = {}) {
  let now = 0;
  const recorder = new ScrollCheckRecorder<FakeRequest>(facts(options.bodies === true), () => now);
  for (const item of options.before ?? []) {
    now += 1;
    deliver(recorder, item);
  }
  now += 1;
  const start = now;
  recorder.openWindow("control");
  for (const item of requests) {
    now += 1;
    deliver(recorder, item);
  }
  recorder.freeze();
  return recorder.windows({ firstPartyHostname: FIRST_PARTY, control: null, scroll: { start, end: now + 1 } });
}

const listedOf = (window: { hosts: Array<{ hosts: string[] }> } | null) => window?.hosts.flatMap((group) => group.hosts) ?? [];
/** A host as the report publishes it. */
const published = (host: string) => redactHostnameV2(host).value;

test("a request counts only once its host answered, at any status, and a failure after the answer does not undo it", () => {
  type Row = {
    name: string;
    requests: PageRequest[];
    before?: PageRequest[];
    bodies?: boolean;
    listed: string[];
    requestCount: number;
    knownHostRequests?: number;
    unanswered: number | undefined;
    reasons?: string[];
  };
  const a = "http://cdn.alpha.net/a";
  const rows: Row[] = [
    { name: "answered", requests: [{ url: a }], listed: ["cdn.alpha.net"], requestCount: 1, unanswered: undefined },
    { name: "failed", requests: [{ url: a, answer: "failed" }], listed: [], requestCount: 0, unanswered: 1 },
    { name: "still pending", requests: [{ url: a, answer: "none" }], listed: [], requestCount: 0, unanswered: 1 },
    { name: "a failure after the answer", requests: [{ url: a, answer: "answered-then-failed" }], listed: ["cdn.alpha.net"], requestCount: 1, unanswered: undefined },
    {
      name: "a failed first try, then a good retry",
      requests: [{ url: a, answer: "failed" }, { url: `${a}?retry` }],
      listed: ["cdn.alpha.net"],
      requestCount: 1,
      unanswered: 1
    },
    {
      name: "an answered first request, then one with no answer",
      requests: [{ url: a }, { url: `${a}?again`, answer: "none" }],
      listed: ["cdn.alpha.net"],
      requestCount: 1,
      unanswered: 1
    },
    {
      name: "a first request the scanner refused, then one it sent",
      requests: [{ url: a, decision: "refused", answer: "failed" }, { url: `${a}?again` }],
      listed: [],
      requestCount: 1,
      unanswered: undefined,
      reasons: ["refused"]
    },
    {
      name: "a first request still undecided",
      requests: [{ url: a, decision: null, answer: "none" }],
      listed: [],
      requestCount: 0,
      unanswered: undefined,
      reasons: ["refused"]
    },
    {
      name: "a first request the check's allowance refused",
      requests: [{ url: a, decision: "allowance", answer: "failed" }],
      listed: [],
      requestCount: 0,
      unanswered: undefined,
      reasons: ["check-allowance"]
    },
    {
      name: "a redirect: the request answered by its 3xx, the hop by its own response",
      requests: [{ url: "http://api.echo.net/r" }, { url: "http://cdn.foxtrot.net/landing", redirected: true }],
      listed: ["api.echo.net", "cdn.foxtrot.net"],
      requestCount: 2,
      unanswered: undefined
    },
    {
      name: "a redirect hop that got no answer",
      requests: [{ url: "http://api.echo.net/r" }, { url: "http://cdn.foxtrot.net/landing", redirected: true, answer: "failed" }],
      listed: ["api.echo.net"],
      requestCount: 1,
      unanswered: 1
    },
    {
      name: "a host contacted before the window, answered",
      before: [{ url: a, answer: "none" }],
      requests: [{ url: `${a}?again` }],
      listed: [],
      requestCount: 1,
      knownHostRequests: 1,
      unanswered: undefined
    },
    {
      name: "a host contacted before the window, with no answer in it",
      before: [{ url: a }],
      requests: [{ url: `${a}?again`, answer: "failed" }],
      listed: [],
      requestCount: 0,
      knownHostRequests: 0,
      unanswered: 1
    },
    {
      name: "the site's own request with no answer: never counted, so not an unanswered one",
      requests: [{ url: "http://www.example.com/lazy.png", answer: "failed" }],
      listed: [],
      requestCount: 0,
      unanswered: undefined
    },
    {
      name: "the site's own analytics beacon with no answer, read with bodies",
      bodies: true,
      requests: [{ url: `http://gtm.example.com/g/collect?${GA}&en=scroll`, answer: "failed" }],
      listed: [],
      requestCount: 0,
      unanswered: 1
    },
    {
      name: "the same beacon when the check reads no bodies: it would not have counted",
      requests: [{ url: `http://gtm.example.com/g/collect?${GA}&en=scroll`, answer: "failed" }],
      listed: [],
      requestCount: 0,
      unanswered: undefined
    },
    {
      name: "a third party's analytics beacon with no answer, counted once",
      bodies: true,
      requests: [{ url: `http://collect.tally.net/g/collect?${GA}&en=scroll`, answer: "none" }],
      listed: [],
      requestCount: 0,
      unanswered: 1
    },
    {
      name: "the page's own navigation with no answer",
      requests: [{ url: "http://www.other-site.net/", navigation: true, answer: "failed" }],
      listed: [],
      requestCount: 0,
      unanswered: undefined
    }
  ];
  for (const row of rows) {
    const { scroll, reasons } = scrollWindowOf(row.requests, { before: row.before, bodies: row.bodies });
    assert.ok(scroll, row.name);
    assert.deepEqual(listedOf(scroll), row.listed.map((host) => redactHostnameV2(host).value), row.name);
    assert.equal(scroll.hostCount, row.listed.length, row.name);
    assert.equal(scroll.requests, row.requestCount, row.name);
    assert.equal(scroll.knownHostRequests, row.knownHostRequests ?? 0, row.name);
    assert.equal(scroll.unanswered, row.unanswered, row.name);
    // Carried only when above 0.
    assert.equal("unanswered" in scroll, row.unanswered !== undefined, row.name);
    assert.deepEqual([...reasons], row.reasons ?? [], row.name);
  }
});

test("answers and failures are taken after the freeze, and the recorder's listeners are stable functions", () => {
  let now = 0;
  const recorder = new ScrollCheckRecorder<FakeRequest>(facts(false), () => now);
  assert.equal(recorder.noteAnswered, recorder.noteAnswered);
  assert.equal(recorder.noteFailed, recorder.noteFailed);
  recorder.openWindow("control");
  now = 10;
  const late = { url: "http://late.alpha.net/a" };
  const failed = { url: "http://gone.bravo.net/b" };
  recorder.noteRequest(late);
  recorder.noteRequest(failed);
  recorder.noteRouted(late, "sent");
  recorder.noteRouted(failed, "sent");
  recorder.freeze();
  // While the check settles: one answered, one failed.
  recorder.noteAnswered(late);
  recorder.noteFailed(failed);
  const { control } = recorder.windows({ firstPartyHostname: FIRST_PARTY, control: { start: 0, end: 20 }, scroll: null });
  assert.deepEqual(listedOf(control), [published("late.alpha.net")]);
  assert.equal(control?.requests, 1);
  assert.equal(control?.unanswered, 1);
});

// The production timing, on the navigation's own clock.
const NAV = 1_000_000;
const CONTROL_START = NAV + SCROLL_CHECK_TIMING.settleAfterNavigationMs;
const SCROLL_START = CONTROL_START + SCROLL_CHECK_TIMING.controlWindowMs;
const SCROLL_END = SCROLL_START + SCROLL_CHECK_TIMING.scrollWindowMs;

type Event = { at: number; order: number; run: () => void };

type Scheduled = PageRequest & {
  at: number;
  /** When a route decided after its request is decided. */
  decideAt?: number;
  /** When its response arrives, if later than its request. */
  answerAt?: number;
  /** When its failure arrives, if later than its request. */
  failAt?: number;
};

/** A check over a page whose requests, decisions, answers and failures arrive at their own times. */
async function check(options: {
  scheduled: Scheduled[];
  observations?: Array<{ at: number; cdp: Record<string, unknown> }>;
  /** When the check began, from the navigation's start. */
  startsAfterNavigationMs?: number;
  /** How far the routes' settle moves the clock. */
  routeSettleMs?: number;
  stacks?: boolean;
  bodies?: boolean;
  /** When the page leaves its site. */
  leavesAt?: number;
}) {
  let now = NAV + (options.startsAfterNavigationMs ?? 10_000);
  const startedAt = now;
  const reads: string[] = [];
  const recorder = new ScrollCheckRecorder<FakeRequest>(facts(options.bodies === true, reads), () => now);
  const stacks = options.stacks === true ? new ScrollCheckStackRecorder(SCROLL_CHECK_REQUEST_ALLOWANCE) : undefined;
  const events: Event[] = [];
  let order = 0;
  const schedule = (at: number, run: () => void) => events.push({ at, order: (order += 1), run });
  for (const item of options.observations ?? []) schedule(item.at, () => stacks?.observe(item.cdp));
  for (const item of options.scheduled) {
    const request: FakeRequest = { url: item.url, navigation: item.navigation, redirected: item.redirected, body: item.body };
    schedule(item.at, () => recorder.noteRequest(request));
    if (item.decision !== null && item.redirected !== true) {
      schedule(item.decideAt ?? item.at, () => recorder.noteRouted(request, item.decision ?? "sent"));
    }
    const answer = item.answer ?? "answered";
    if (answer === "answered" || answer === "answered-then-failed") schedule(item.answerAt ?? item.at, () => recorder.noteAnswered(request));
    if (answer === "failed" || answer === "answered-then-failed") schedule(item.failAt ?? item.answerAt ?? item.at, () => recorder.noteFailed(request));
  }
  events.sort((left, right) => left.at - right.at || left.order - right.order);
  /** Deliver everything due by `until`, one event at a time, stopping early once `stop` says so. */
  const advance = (until: number, stop?: AbortSignal) => {
    while (events.length > 0 && events[0].at <= until) {
      const next = events.shift() as Event;
      now = Math.max(now, next.at);
      next.run();
      if (stop?.aborted) return;
    }
    now = Math.max(now, until);
  };
  advance(startedAt);
  const height = 980 * 3;
  let top = 0;
  const run: ScrollCheckRun<FakeRequest> = {
    recorder,
    ...(stacks ? { stacks } : {}),
    timing: SCROLL_CHECK_TIMING,
    navigationStartedAt: NAV,
    startedAt,
    subjectAvailable: true,
    firstPartyHostname: FIRST_PARTY,
    sameSubject: () => true,
    leftSiteAt: () => (options.leavesAt !== undefined && now >= options.leavesAt ? options.leavesAt : null),
    visitBudgetUsedUp: false,
    proxyLossCount: () => 0,
    settleRoutes: async () => advance(now + (options.routeSettleMs ?? 0)),
    now: () => now,
    sleep: async (ms, stop) => {
      if (stop) {
        // A page call answers on a later turn; a wait already over never sleeps.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (stop.aborted) return;
      }
      advance(now + ms, stop);
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
  return { evidence, endedAt: now, reads };
}

const IN_WINDOW = SCROLL_START + 4_000;

test("the settle waits for an answer that lands after the window, and ends the moment the last request is final", async () => {
  // The last to arrive is a failure: it ends the wait as an answer would.
  const failedLast = await check({
    scheduled: [
      { at: IN_WINDOW, url: "http://late.alpha.net/a", answerAt: SCROLL_END + 1_200 },
      { at: IN_WINDOW, url: "http://gone.bravo.net/b", answer: "failed", failAt: SCROLL_END + 2_000 }
    ]
  });
  assert.equal(failedLast.evidence.outcome, "reached-end");
  assert.deepEqual(listedOf(failedLast.evidence.scroll), [published("late.alpha.net")]);
  assert.equal(failedLast.evidence.scroll?.requests, 1);
  assert.equal(failedLast.evidence.scroll?.unanswered, 1);
  assert.equal(failedLast.endedAt, SCROLL_END + 2_000, "the settle did not end when the last failure arrived");
  // The last to arrive is an answer.
  const answeredLast = await check({
    scheduled: [
      { at: IN_WINDOW, url: "http://late.alpha.net/a", answerAt: SCROLL_END + 1_200 },
      { at: IN_WINDOW, url: "http://gone.bravo.net/b", answer: "failed", failAt: SCROLL_END + 300 }
    ]
  });
  assert.equal(answeredLast.endedAt, SCROLL_END + 1_200, "the settle did not end when the last answer arrived");
  assert.deepEqual(listedOf(answeredLast.evidence.scroll), [published("late.alpha.net")]);
});

test("a redirect hop is waited for like any request the scanner sent", async () => {
  const { evidence, endedAt } = await check({
    scheduled: [
      { at: IN_WINDOW, url: "http://api.echo.net/r" },
      { at: IN_WINDOW + 5, url: "http://cdn.foxtrot.net/landing", redirected: true, answerAt: SCROLL_END + 900 }
    ]
  });
  assert.equal(endedAt, SCROLL_END + 900);
  assert.deepEqual(listedOf(evidence.scroll), ["api.echo.net", "cdn.foxtrot.net"]);
  assert.equal(evidence.scroll?.unanswered, undefined);
});

test("a window that did not run to its end is never waited for", async () => {
  // The page leaves its site during the scroll window, so the check reports
  // the window without input alone, and the scroll window's request with no
  // answer holds nothing open.
  const { evidence, endedAt } = await check({
    leavesAt: SCROLL_START + 5_000,
    scheduled: [{ at: IN_WINDOW, url: "http://poll.alpha.net/long", answer: "none" }]
  });
  assert.equal(evidence.outcome, "left-site");
  assert.equal(evidence.scroll, null);
  assert.equal(endedAt, SCROLL_END);
});

test("the settle ends at once when every request is already final, and stops at its bound when one never is", async () => {
  const done = await check({ scheduled: [{ at: IN_WINDOW, url: "http://quick.alpha.net/a" }, { at: IN_WINDOW, url: "http://down.bravo.net/b", answer: "failed" }] });
  assert.equal(done.endedAt, SCROLL_END, "a settle with nothing left to wait for took time");
  assert.equal(done.evidence.scroll?.unanswered, 1);
  // A request that never answers: the settle stops at its 5 s bound, and the
  // request counts as one with no answer.
  const open = await check({ scheduled: [{ at: IN_WINDOW, url: "http://poll.alpha.net/long", answer: "none" }] });
  assert.equal(open.endedAt, SCROLL_END + SCROLL_CHECK_ROUTE_SETTLE_MS);
  assert.deepEqual(listedOf(open.evidence.scroll), []);
  assert.equal(open.evidence.scroll?.unanswered, 1);
  // One bound for both waits: routes that take their time spend it too.
  const slowRoutes = await check({ routeSettleMs: 300, scheduled: [{ at: IN_WINDOW, url: "http://poll.alpha.net/long", answer: "none" }] });
  assert.equal(slowRoutes.endedAt, SCROLL_END + SCROLL_CHECK_ROUTE_SETTLE_MS);
  // And within the check's own deadline: a check that began 5 s after the
  // navigation must end by 50 s after it, 4 s after its windows.
  const near = await check({ startsAfterNavigationMs: 5_000, scheduled: [{ at: IN_WINDOW, url: "http://poll.alpha.net/long", answer: "none" }] });
  assert.equal(near.endedAt, NAV + 5_000 + SCROLL_CHECK_TIMING.phaseDeadlineMs);
});

test("the settle waits for a request whose route was decided while it waited", async () => {
  const { evidence, endedAt } = await check({
    scheduled: [
      { at: IN_WINDOW, url: "http://first.alpha.net/a", answerAt: SCROLL_END + 1_000 },
      { at: IN_WINDOW, url: "http://decided.bravo.net/b", decideAt: SCROLL_END + 100, answerAt: SCROLL_END + 2_000 }
    ]
  });
  assert.deepEqual(listedOf(evidence.scroll).sort(), [published("decided.bravo.net"), published("first.alpha.net")].sort());
  assert.equal(evidence.scroll?.unanswered, undefined);
  assert.deepEqual(evidence.incomplete, []);
  assert.equal(endedAt, SCROLL_END + 2_000);
});

test("a request started after the windows is never waited for", async () => {
  const { evidence, endedAt } = await check({
    scheduled: [
      { at: IN_WINDOW, url: "http://slow.alpha.net/a", answerAt: SCROLL_END + 500 },
      // While the settle waits for the request above: not recorded, so it
      // never holds the wait open.
      { at: SCROLL_END + 10, url: "http://after.bravo.net/b", answer: "none" }
    ]
  });
  assert.equal(endedAt, SCROLL_END + 500);
  assert.deepEqual(listedOf(evidence.scroll), [published("slow.alpha.net")]);
  assert.equal(evidence.scroll?.unanswered, undefined);
});

test("an analytics beacon with no answer is not decoded, its body is never read, and it counts in neither of the events' counts", async () => {
  const { evidence, reads } = await check({
    bodies: true,
    scheduled: [
      { at: IN_WINDOW, url: `http://collect.tally.net/g/collect?${GA}&en=page_view` },
      { at: IN_WINDOW + 10, url: `http://collect.tally.net/g/collect?${GA}&en=scroll`, answer: "failed", body: "en=video_start" },
      { at: IN_WINDOW + 20, url: `http://gtm.example.com/g/collect?${GA}&en=page_view`, answer: "none" }
    ]
  });
  const scroll = evidence.events?.scroll;
  assert.ok(scroll, JSON.stringify(evidence));
  assert.equal(scroll.beacons, 1);
  assert.equal(scroll.notDecoded, 0);
  assert.deepEqual(scroll.destinations.map((destination) => [destination.host, destination.events.map((event) => event.name)]), [
    ["collect.tally.net", ["page_view"]]
  ]);
  assert.deepEqual(reads, [`http://collect.tally.net/g/collect?${GA}&en=page_view`]);
  // The third party's beacon and the site's own, each once.
  assert.equal(evidence.scroll?.unanswered, 2);
});

/** One observation of a request, as Chromium's session delivers it. */
function observed(url: string, frames: string[] | null): Record<string, unknown> {
  return {
    requestId: `REQUEST-${url}-${Math.random()}`,
    loaderId: "LOADER-ID",
    frameId: "FRAME-ID",
    request: { url, method: "GET", headers: {} },
    initiator: frames
      ? { type: "script", stack: { callFrames: frames.map((frameUrl) => ({ functionName: "f", scriptId: "1", url: frameUrl, lineNumber: 1, columnNumber: 1 })) } }
      : { type: "parser", url: "http://www.example.com/" },
    type: "Fetch"
  };
}

test("the call-stack join counts only answered requests, and one with no answer still takes its own observation", async () => {
  const loader = "http://cdn.alpha.net/loader.js";
  const beacon = "http://pixel.charlie.com/p";
  const { evidence } = await check({
    stacks: true,
    observations: [
      { at: NAV + 100, cdp: { ...observed(loader, null), type: "Script" } },
      // The first request to the beacon came with the loader's stack, and
      // got no answer; the second came with none, and was answered.
      { at: IN_WINDOW - 2, cdp: observed(beacon, [loader]) },
      { at: IN_WINDOW + 8, cdp: observed(beacon, null) }
    ],
    scheduled: [
      { at: NAV + 102, url: loader },
      { at: IN_WINDOW, url: beacon, answer: "failed" },
      { at: IN_WINDOW + 10, url: beacon }
    ]
  });
  assert.deepEqual(listedOf(evidence.scroll), ["pixel.charlie.com"]);
  assert.equal(evidence.scroll?.requests, 1);
  assert.equal(evidence.scroll?.unanswered, 1);
  assert.deepEqual(evidence.scroll?.stacks, [
    { host: "pixel.charlie.com", requests: 1, groups: [], redirected: 0, withoutStack: 1, withoutNamedScript: 0, notListed: 0, unobserved: 0 }
  ]);
});

test("the validator takes a window's unanswered count only above 0, on either window, and still takes the shape before it", async () => {
  const { evidence } = await check({
    scheduled: [
      { at: CONTROL_START + 1_000, url: "http://timer.alpha.net/t", answer: "failed" },
      { at: IN_WINDOW, url: "http://lazy.bravo.net/l", answer: "failed" },
      { at: IN_WINDOW + 10, url: "http://lazy.charlie.net/l" }
    ]
  });
  assert.equal(evidence.control?.unanswered, 1);
  assert.equal(evidence.scroll?.unanswered, 1);
  const without = (value: ScrollCheckEvidence): ScrollCheckEvidence => {
    const strip = <T extends { unanswered?: number }>(window: T | null): T | null => {
      if (window === null) return null;
      const { unanswered: _unanswered, ...rest } = window;
      return rest as T;
    };
    return { ...value, control: strip(value.control), scroll: strip(value.scroll) };
  };
  assert.equal(isScrollCheckEvidence(without(evidence)), true, "the shape before answers no longer validates");
  for (const part of ["control", "scroll"] as const) {
    for (const bad of [0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      const window = evidence[part];
      assert.ok(window);
      const changed = { ...evidence, [part]: { ...window, unanswered: bad } };
      assert.equal(isScrollCheckEvidence(changed), false, `${part}.unanswered ${String(bad)} was taken`);
    }
    const window = evidence[part];
    assert.ok(window);
    assert.equal(isScrollCheckEvidence({ ...evidence, [part]: { ...window, unanswered: 7 } }), true, `${part}.unanswered 7 was refused`);
  }
});
