import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isRunnableScrollCheckTiming,
  parseScrollState,
  runScrollCheck,
  SCROLL_CHECK_DEADLINE_MARGIN_MS,
  SCROLL_CHECK_REQUEST_ALLOWANCE,
  SCROLL_CHECK_TIMING,
  scrollCheckDeadline,
  ScrollCheckRecorder,
  type ScrollCheckBoundary,
  type ScrollCheckRouteDecision,
  type ScrollCheckRun,
  type ScrollCheckTiming,
  type ScrollState
} from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence } from "./scroll-check-evidence";
import { openInvestigationSeam } from "./investigation-seam";
import { redactHostnameV2 } from "./redaction-v2";

/**
 * The check's phase over a scripted page and a virtual clock: `sleep`
 * advances time at once, emitting the page requests scheduled inside each
 * interval, so every outcome, window and count can be pinned exactly.
 */

type FakeRequest = { url: string; navigation?: boolean; redirected?: boolean };

type Scheduled = { at: number; url: string; decision?: ScrollCheckRouteDecision | null; navigation?: boolean; redirected?: boolean };

const NAV = 1_000_000;
// The production parameters, in milliseconds from the navigation's start.
const SETTLE_END = NAV + SCROLL_CHECK_TIMING.settleAfterNavigationMs;
const CONTROL_END = SETTLE_END + SCROLL_CHECK_TIMING.controlWindowMs;
const SCROLL_END = CONTROL_END + SCROLL_CHECK_TIMING.scrollWindowMs;

type PageScript = {
  /** Document height; grows by `growBy` after each step that moves. */
  height: number;
  viewport?: number;
  growBy?: number;
  /** Locked from this step on (1-based); 1 locks before any step. */
  lockedFromStep?: number;
  /** Steps after this many move nothing. */
  movesFor?: number;
  /** Requests the page makes when the visit scrolls to each step (1-based). */
  onStep?: Record<number, string[]>;
  /** The page leaves its site at this time. */
  leavesAt?: number;
  /** The scroll-state read returns nothing from this step on. */
  unreadableFromStep?: number;
  /** A scrollTo that never answers, at this step. */
  hangsAtStep?: number;
};

function fakeCheck(options: {
  script?: PageScript;
  scheduled?: Scheduled[];
  timing?: ScrollCheckTiming;
  /** When the check began, from the navigation's start. */
  startsAfterNavigationMs?: number;
  subjectAvailable?: boolean;
  visitBudgetUsedUp?: boolean;
  proxyLossDuringCheck?: number;
  /** Hosts the recorder keeps. */
  maxHosts?: number;
  /** Routes still undecided when the check ends. */
  pendingDecisions?: string[];
  faultForTests?: "throw" | "hang";
  abortAt?: number;
  firstPartyHostname?: string;
}) {
  const script: PageScript = { height: 980 * 6, ...options.script };
  const viewport = script.viewport ?? 980;
  let now = NAV + (options.startsAfterNavigationMs ?? 5_000);
  const startedAt = now;
  const facts = {
    url: (request: FakeRequest) => request.url,
    redirected: (request: FakeRequest) => request.redirected === true,
    mainFrameNavigation: (request: FakeRequest) => request.navigation === true
  };
  const recorder = new ScrollCheckRecorder<FakeRequest>(facts, () => now, options.maxHosts);
  const queue: Scheduled[] = [...(options.scheduled ?? [])].sort((left, right) => left.at - right.at);
  let pageUrl = "https://www.example.com/";
  let left = false;
  let top = 0;
  let height = script.height;
  let step = 0;
  const scrollCalls: number[] = [];
  const emit = (url: string, decision: ScrollCheckRouteDecision | null | undefined, extra: Partial<FakeRequest> = {}) => {
    const request: FakeRequest = { url, ...extra };
    recorder.noteRequest(request);
    const pending = (options.pendingDecisions ?? []).includes(url);
    if (decision !== null && !pending) recorder.noteRouted(request, decision ?? "sent");
    // The host answers every request the scanner let through, as a local
    // page's server does: a redirect hop, or a route decided as sent.
    if (decision === null ? extra.redirected === true : !pending && (decision ?? "sent") === "sent") recorder.noteAnswered(request);
  };
  const advance = (until: number) => {
    while (queue.length > 0 && queue[0].at <= until) {
      const next = queue.shift() as Scheduled;
      now = Math.max(now, next.at);
      emit(next.url, next.decision, { navigation: next.navigation, redirected: next.redirected });
    }
    if (script.leavesAt !== undefined && !left && until >= script.leavesAt) {
      left = true;
      pageUrl = "https://elsewhere.example.org/";
    }
    now = Math.max(now, until);
  };
  let aborted = false;
  const run: ScrollCheckRun<FakeRequest> = {
    recorder,
    timing: options.timing ?? SCROLL_CHECK_TIMING,
    navigationStartedAt: NAV,
    startedAt,
    subjectAvailable: options.subjectAvailable ?? true,
    firstPartyHostname: options.firstPartyHostname ?? "www.example.com",
    sameSubject: (url) => new URL(url).origin === "https://www.example.com",
    leftSiteAt: () => (left ? (script.leavesAt as number) : null),
    visitBudgetUsedUp: options.visitBudgetUsedUp ?? false,
    proxyLossCount: () => (now > startedAt ? options.proxyLossDuringCheck ?? 0 : 0),
    settleRoutes: async () => undefined,
    now: () => now,
    sleep: async (ms, stop) => {
      if (stop) {
        // The deadline's wait beside a page call: it passes only when the
        // call never answers, which a later turn of the event loop shows.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (stop.aborted) return;
      }
      if (options.abortAt !== undefined && now + ms >= options.abortAt) {
        advance(options.abortAt);
        aborted = true;
        throw new DOMException("The scan was cancelled.", "AbortError");
      }
      advance(now + ms);
    },
    page: {
      url: () => pageUrl,
      scrollState: async (): Promise<ScrollState | null> => {
        if (script.unreadableFromStep !== undefined && step >= script.unreadableFromStep) return null;
        const locked = script.lockedFromStep !== undefined && step + 1 >= script.lockedFromStep;
        return { top, height, viewport, locked };
      },
      scrollTo: async (target) => {
        scrollCalls.push(target);
        if (target === 0) {
          top = 0;
          return true;
        }
        step += 1;
        if (script.hangsAtStep === step) return new Promise<boolean>(() => undefined);
        if (script.movesFor === undefined || step <= script.movesFor) {
          top = Math.min(target, Math.max(0, height - viewport));
          height += script.growBy ?? 0;
        }
        for (const url of script.onStep?.[step] ?? []) emit(url, "sent");
        return true;
      }
    },
    ...(options.faultForTests ? { faultForTests: options.faultForTests } : {})
  };
  return { run, scrollCalls, startedAt, now: () => now, aborted: () => aborted, setPageUrl: (url: string) => (pageUrl = url) };
}

async function check(options: Parameters<typeof fakeCheck>[0] = {}) {
  const fake = fakeCheck(options);
  const evidence = await runScrollCheck(fake.run);
  assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
  return { evidence, ...fake };
}

const hostsOf = (window: ScrollCheckEvidence["control"]) => window?.hosts.flatMap((group) => group.hosts) ?? [];

test("the check's own parameters are the measured ones and fit its windows", () => {
  assert.deepEqual(SCROLL_CHECK_TIMING, {
    settleAfterNavigationMs: 25_000,
    controlWindowMs: 10_500,
    scrollWindowMs: 10_500,
    stepDwellMs: 1_000,
    deepestDwellMs: 2_000,
    phaseDeadlineMs: 45_000
  });
  assert.equal(SCROLL_CHECK_REQUEST_ALLOWANCE, 500);
  assert.equal(isRunnableScrollCheckTiming(SCROLL_CHECK_TIMING), true);
  // A scroll window too short for eight steps and the deepest dwell is refused.
  assert.equal(isRunnableScrollCheckTiming({ ...SCROLL_CHECK_TIMING, scrollWindowMs: 9_999 }), false);
  assert.equal(isRunnableScrollCheckTiming({ ...SCROLL_CHECK_TIMING, stepDwellMs: 0 }), false);
});

test("a host first contacted in each window is listed there, and nothing contacted earlier is", async () => {
  const { evidence } = await check({
    scheduled: [
      // Contacted before the visit's evidence boundary.
      { at: NAV + 100, url: "https://early.tracker.net/a.js" },
      // First contacted after the boundary, before the window without input:
      // new in neither window.
      { at: NAV + 20_000, url: "https://between.tracker.net/p" },
      // Refused while the visit's own cap held, then allowed in a window: the
      // page had already asked for it, so it is never new.
      { at: NAV + 2_000, url: "https://capped.ads.example/x", decision: "refused" },
      { at: SETTLE_END + 3_000, url: "https://capped.ads.example/x?again" },
      // Timers in the window without input.
      { at: SETTLE_END + 3_000, url: "https://pixel.timer.org/p.gif" },
      { at: SETTLE_END + 4_000, url: "https://early.tracker.net/again" },
      // First-party hosts are never listed.
      { at: SETTLE_END + 5_000, url: "https://static.example.com/lazy.jpg" },
      { at: CONTROL_END + 500, url: "https://www.example.com/next" }
    ],
    script: {
      height: 980 * 4,
      onStep: { 2: ["https://player.video.net/embed", "https://cdn.video.net/v.js", "https://early.tracker.net/scroll"] }
    }
  });
  assert.equal(evidence.outcome, "reached-end");
  assert.equal(evidence.screens, 3);
  assert.deepEqual(evidence.control, {
    hosts: [{ site: "timer.org", hosts: ["pixel.timer.org"] }],
    hostCount: 1,
    siteCount: 1,
    requests: 3
  });
  assert.deepEqual(evidence.scroll, {
    // Published as the report publishes a host: "player" is not a reviewed label.
    hosts: [{ site: "video.net", hosts: ["cdn.video.net", "{label}.video.net"] }],
    hostCount: 2,
    siteCount: 1,
    requests: 3,
    knownHostRequests: 1
  });
  assert.deepEqual(evidence.incomplete, []);
  for (const host of ["early", "between", "capped", "static", "www"]) {
    assert.equal(JSON.stringify(evidence).includes(host), false, `${host} is listed`);
  }
});

test("a first request the scanner refused is not listed and marks the result incomplete", async () => {
  const { evidence } = await check({
    scheduled: [
      { at: SETTLE_END + 1_000, url: "https://unverified.example.net/p", decision: "refused" },
      { at: SETTLE_END + 1_200, url: "https://unverified.example.net/p2" },
      { at: CONTROL_END + 100, url: "https://over.allowance.net/p", decision: "allowance" }
    ],
    script: { height: 980 * 2 }
  });
  assert.equal(hostsOf(evidence.control).length, 0);
  assert.equal(hostsOf(evidence.scroll).length, 0);
  // The later request to the refused host was sent, and counts as traffic only.
  assert.equal(evidence.control?.requests, 1);
  assert.deepEqual(evidence.incomplete, ["check-allowance", "refused"]);
});

test("a request still undecided when the check ends counts as not followed", async () => {
  const { evidence } = await check({
    scheduled: [{ at: CONTROL_END + 200, url: "https://late.example.net/p" }],
    pendingDecisions: ["https://late.example.net/p"],
    script: { height: 980 * 2 }
  });
  assert.equal(hostsOf(evidence.scroll).length, 0);
  assert.deepEqual(evidence.incomplete, ["refused"]);
});

test("a redirect hop never meets the page route and follows a request that was sent", async () => {
  const { evidence } = await check({
    scheduled: [{ at: CONTROL_END + 300, url: "https://hop.redirect.net/landing", decision: null, redirected: true }],
    script: { height: 980 * 2 }
  });
  assert.deepEqual(hostsOf(evidence.scroll), [redactHostnameV2("hop.redirect.net").value]);
  assert.deepEqual(evidence.incomplete, []);
});

test("the page's own navigation is never a host it contacted", async () => {
  const { evidence } = await check({
    scheduled: [{ at: SETTLE_END + 1_000, url: "https://www.other-site.net/", navigation: true }],
    script: { height: 980 * 2 }
  });
  assert.equal(evidence.control?.hostCount, 0);
  assert.equal(evidence.control?.requests, 0);
});

test("at most twenty hosts are listed, sites with the most first, and the counts stay full", async () => {
  const scheduled: Scheduled[] = [];
  for (let index = 0; index < 15; index += 1) scheduled.push({ at: CONTROL_END + 100 + index, url: `https://cdn.big${String(index).padStart(2, "0")}.net/x` });
  // Reviewed labels, so each publishes as itself and none collapse together.
  for (const sub of ["assets", "img", "static", "api", "www", "media", "cdn", "pixel"]) {
    scheduled.push({ at: CONTROL_END + 300, url: `https://${sub}.many.org/x` });
  }
  const { evidence } = await check({ scheduled, script: { height: 980 * 2 } });
  const scroll = evidence.scroll;
  assert.ok(scroll);
  assert.equal(scroll.hostCount, 23);
  assert.equal(scroll.siteCount, 16);
  assert.equal(hostsOf(scroll).length, 20);
  // The site with the most hosts leads; the rest follow by name.
  assert.equal(scroll.hosts[0].site, "many.org");
  assert.equal(scroll.hosts[0].hosts.length, 8);
  assert.deepEqual(
    scroll.hosts.slice(1).map((group) => group.site),
    Array.from({ length: 12 }, (_value, index) => `big${String(index).padStart(2, "0")}.net`)
  );
});

test("nothing but counts, published hosts and fixed facts reaches the evidence", async () => {
  const { evidence } = await check({
    scheduled: [
      { at: SETTLE_END + 1_000, url: "https://u7f3k9.tracker.net/collect?uid=secret-123&email=a%40b.c#frag" },
      { at: CONTROL_END + 400, url: "http://203.0.113.9:8080/beacon?token=abc" },
      { at: CONTROL_END + 450, url: "https://a1b2c3d4e5f6a7b8c9d0.cloudfront.net/path/to/script.js" }
    ],
    script: { height: 980 * 2 }
  });
  const serialized = JSON.stringify(evidence);
  for (const forbidden of ["secret", "uid", "email", "frag", "collect", "beacon", "token", "203.0.113", "8080", "path", "script.js", "u7f3k9", "http:", "https:"]) {
    assert.equal(serialized.includes(forbidden), false, `the evidence carries ${forbidden}`);
  }
  // Each host is published exactly as the report's hostname redaction
  // publishes it: an IP literal as its marker, a token-shaped tenant label
  // under a private suffix generalized.
  assert.deepEqual(hostsOf(evidence.control), [redactHostnameV2("u7f3k9.tracker.net").value]);
  assert.deepEqual(
    hostsOf(evidence.scroll).sort(),
    [redactHostnameV2("a1b2c3d4e5f6a7b8c9d0.cloudfront.net").value, redactHostnameV2("203.0.113.9").value].sort()
  );
  assert.deepEqual(hostsOf(evidence.scroll).sort(), ["{invalid-host}", "{label}.cloudfront.net"]);
});

test("the settle counts the visit's own time, so a visit past 25 seconds waits no longer", async () => {
  const late = await check({ startsAfterNavigationMs: 40_000, script: { height: 980 * 2 } });
  assert.equal(late.evidence.outcome, "reached-end");
  // The window without input began at once, 40 s after the navigation.
  const expectedEnd = NAV + 40_000 + SCROLL_CHECK_TIMING.controlWindowMs + SCROLL_CHECK_TIMING.scrollWindowMs;
  assert.equal(late.now(), expectedEnd);
  const early = await check({ startsAfterNavigationMs: 5_000, script: { height: 980 * 2 } });
  assert.equal(early.now(), SCROLL_END);
});

test("each outcome ends where the outline says, and the scroll window is padded to its length", async () => {
  const reachedEnd = await check({ script: { height: 980 * 3 } });
  assert.deepEqual([reachedEnd.evidence.outcome, reachedEnd.evidence.screens], ["reached-end", 2]);
  // Two steps, then the jump back to the top.
  assert.deepEqual(reachedEnd.scrollCalls, [980, 1960, 0]);
  assert.equal(reachedEnd.now(), SCROLL_END);

  const depth = await check({ script: { height: 980 * 40 } });
  assert.deepEqual([depth.evidence.outcome, depth.evidence.screens], ["depth-limit", 8]);
  assert.deepEqual(depth.scrollCalls, [980, 1960, 2940, 3920, 4900, 5880, 6860, 7840, 0]);
  assert.equal(depth.now(), SCROLL_END);

  // A page that keeps growing as it scrolls is not at its end.
  const feed = await check({ script: { height: 980 * 2, growBy: 980 } });
  assert.equal(feed.evidence.outcome, "depth-limit");

  const short = await check({ script: { height: 900 } });
  assert.deepEqual([short.evidence.outcome, short.evidence.screens, short.evidence.scroll], ["nothing-to-scroll", 0, null]);
  assert.deepEqual(short.scrollCalls, []);
  assert.ok(short.evidence.control, "the window without input still ran");
});

test("a locked page is never scrolled, and a lock found later stops the scroll there", async () => {
  const locked = await check({ script: { height: 980 * 6, lockedFromStep: 1 } });
  assert.deepEqual([locked.evidence.outcome, locked.evidence.screens, locked.evidence.scroll], ["locked", 0, null]);
  assert.deepEqual(locked.scrollCalls, [], "a locked page was scrolled");
  assert.ok(locked.evidence.control);

  const later = await check({ script: { height: 980 * 6, lockedFromStep: 3 } });
  assert.deepEqual([later.evidence.outcome, later.evidence.screens], ["locked", 2]);
  // Two steps, and no jump back: the page has scrolling turned off.
  assert.deepEqual(later.scrollCalls, [980, 1960]);
  assert.ok(later.evidence.scroll, "the screens before the lock are reported");
  assert.equal(later.now(), SCROLL_END);
});

test("a page that does not move ends as did-not-move, before or after its first screens", async () => {
  const stuck = await check({ script: { height: 980 * 6, movesFor: 0 } });
  assert.deepEqual([stuck.evidence.outcome, stuck.evidence.screens, stuck.evidence.scroll], ["did-not-move", 0, null]);
  const later = await check({ script: { height: 980 * 6, movesFor: 2 } });
  assert.deepEqual([later.evidence.outcome, later.evidence.screens], ["did-not-move", 2]);
  assert.ok(later.evidence.scroll);
});

test("a page that leaves its site ends the check there, and an unfinished window is not reported", async () => {
  const duringControl = await check({ script: { height: 980 * 6, leavesAt: SETTLE_END + 2_000 } });
  assert.deepEqual([duringControl.evidence.outcome, duringControl.evidence.control, duringControl.evidence.scroll], ["left-site", null, null]);
  const duringScroll = await check({ script: { height: 980 * 6, leavesAt: CONTROL_END + 2_500 } });
  assert.equal(duringScroll.evidence.outcome, "left-site");
  assert.ok(duringScroll.evidence.control);
  assert.equal(duringScroll.evidence.scroll, null);
  // Left before the check began: still the gate's concern, not this one's.
  const notRun = await check({ subjectAvailable: false });
  assert.deepEqual(notRun.evidence, { outcome: "not-run", screens: 0, control: null, scroll: null, incomplete: [], addressChanged: false });
  assert.equal(notRun.now(), notRun.startedAt, "a check that does not run waits for nothing");
});

test("the check's own deadline, an error and a cancellation each end it as cut short", async () => {
  // A page whose scroll call never answers runs into the deadline: 45 s
  // from the moment the check began.
  const hung = await check({ script: { height: 980 * 6, hangsAtStep: 2 } });
  assert.equal(hung.evidence.outcome, "cut-short");
  assert.equal(hung.evidence.scroll, null);
  assert.ok(hung.evidence.control);
  assert.equal(hung.now(), hung.startedAt + SCROLL_CHECK_TIMING.phaseDeadlineMs);
  assert.equal(
    scrollCheckDeadline(SCROLL_CHECK_TIMING, NAV, hung.startedAt),
    hung.startedAt + SCROLL_CHECK_TIMING.phaseDeadlineMs
  );
  // A single scan that ended within a second of its navigation leaves the
  // sequence 46 s to run: the budget never cuts it, and still bounds a hang.
  const fast = await check({ startsAfterNavigationMs: 500 });
  assert.equal(fast.evidence.outcome, "reached-end");
  assert.ok(fast.evidence.scroll);
  assert.equal(scrollCheckDeadline(SCROLL_CHECK_TIMING, NAV, NAV + 500), SCROLL_END + SCROLL_CHECK_DEADLINE_MARGIN_MS);
  const fastHung = await check({ startsAfterNavigationMs: 500, faultForTests: "hang" });
  assert.equal(fastHung.evidence.outcome, "cut-short");
  assert.equal(fastHung.now(), SCROLL_END + SCROLL_CHECK_DEADLINE_MARGIN_MS);
  // A check that began late, after a single scan that ran to its cap, keeps
  // its 45 s budget from then.
  assert.equal(scrollCheckDeadline(SCROLL_CHECK_TIMING, NAV, NAV + 45_000), NAV + 45_000 + 45_000);
  const thrown = await check({ faultForTests: "throw" });
  assert.equal(thrown.evidence.outcome, "cut-short");
  assert.ok(thrown.evidence.control, "the window that ran is still reported");
  const unreadable = await check({ script: { height: 980 * 6, unreadableFromStep: 0 } });
  assert.equal(unreadable.evidence.outcome, "cut-short");
  // A cancellation stops at once, within the step it lands in.
  const cancelled = await check({ abortAt: SETTLE_END + 1_000 });
  assert.equal(cancelled.evidence.outcome, "cut-short");
  assert.equal(cancelled.aborted(), true);
  assert.equal(cancelled.now(), SETTLE_END + 1_000);
  // An impossible timing never starts.
  const impossible = await check({ timing: { ...SCROLL_CHECK_TIMING, scrollWindowMs: 1_000 } });
  assert.deepEqual([impossible.evidence.outcome, impossible.evidence.control], ["cut-short", null]);
});

test("what cut collection is said once each, in order", async () => {
  const budget = await check({ visitBudgetUsedUp: true, proxyLossDuringCheck: 3, script: { height: 980 * 2 } });
  assert.deepEqual(budget.evidence.incomplete, ["visit-budget", "proxy-budget"]);
  const bound = await check({
    maxHosts: 2,
    scheduled: [
      { at: NAV + 10, url: "https://one.example.net/" },
      { at: NAV + 20, url: "https://two.example.net/" },
      { at: SETTLE_END + 100, url: "https://three.example.net/" }
    ],
    script: { height: 980 * 2 }
  });
  assert.deepEqual(bound.evidence.incomplete, ["host-bound"]);
  assert.equal(hostsOf(bound.evidence.control).length, 0, "a host past the bound cannot be known as new");
});

test("an address the page changes while the visit scrolls is reported, and only then", async () => {
  const fake = fakeCheck({ script: { height: 980 * 4, onStep: {} } });
  const scrollTo = fake.run.page.scrollTo;
  fake.run.page.scrollTo = async (top) => {
    if (top === 1960) fake.setPageUrl("https://www.example.com/next-article");
    return scrollTo(top);
  };
  const evidence = await runScrollCheck(fake.run);
  assert.equal(evidence.addressChanged, true);
  const still = await check({ script: { height: 980 * 4 } });
  assert.equal(still.evidence.addressChanged, false);
});

test("a request after the freeze reaches no list or count, and the recorder's listener is one stable function", () => {
  let now = 0;
  // Two hosts fill this recorder's bound exactly.
  const recorder = new ScrollCheckRecorder<FakeRequest>(
    { url: (request) => request.url, redirected: () => false, mainFrameNavigation: () => false },
    () => now,
    2
  );
  assert.equal(recorder.noteRequest, recorder.noteRequest);
  recorder.openWindow("control");
  now = 10;
  const decidedLate = { url: "https://kept.example.net/" };
  recorder.noteRequest(decidedLate);
  recorder.noteRequest({ url: "https://undecided.example.org/" });
  recorder.freeze();
  // A route decided after the freeze, while the check settles its routes,
  // still counts, and so does its answer: its request started inside the
  // window.
  recorder.noteRouted(decidedLate, "sent");
  recorder.noteAnswered(decidedLate);
  now = 20;
  // Requests after the freeze reach neither the lists nor the bound.
  for (const name of ["late", "later", "latest"]) recorder.noteRequest({ url: `https://${name}.example.com.au/` });
  const windows = recorder.windows({ firstPartyHostname: "www.example.com", control: { start: 0, end: 30 }, scroll: null });
  assert.equal(windows.control?.requests, 1, "only the request decided as sent is counted, the late decision included");
  assert.deepEqual(windows.control?.hosts, [
    { site: redactHostnameV2("example.net").value, hosts: [redactHostnameV2("kept.example.net").value] }
  ]);
  assert.deepEqual([...windows.reasons], ["refused"], "the undecided request reads as not followed, and nothing after the freeze reached the bound");
  assert.equal(JSON.stringify(windows).includes("late"), false);
});

test("the collector's scroll state is read strictly", () => {
  assert.deepEqual(parseScrollState(JSON.stringify({ top: 0, height: 5000, viewport: 980, locked: false })), {
    top: 0,
    height: 5000,
    viewport: 980,
    locked: false
  });
  for (const wire of [
    "",
    null,
    42,
    "{",
    JSON.stringify({ top: -1, height: 5000, viewport: 980, locked: false }),
    JSON.stringify({ top: 0, height: 5000, viewport: 0, locked: false }),
    JSON.stringify({ top: 0, height: "5000", viewport: 980, locked: false }),
    JSON.stringify({ top: 0, height: 5000, viewport: 980 }),
    "x".repeat(600)
  ]) {
    assert.equal(parseScrollState(wire), null, String(wire));
  }
});

/**
 * The two things only the scanner's investigation seam hands a check: a
 * callback at its four boundaries, and a deadline margin of its own. A run
 * with neither is every run above.
 */
test("a run that names a deadline margin gets it, and one that names none keeps the constant", async () => {
  assert.equal(SCROLL_CHECK_DEADLINE_MARGIN_MS, 2_000);
  // Naming the constant is naming nothing.
  for (const startedAt of [NAV + 500, NAV + 5_000, NAV + 45_000]) {
    assert.equal(
      scrollCheckDeadline(SCROLL_CHECK_TIMING, NAV, startedAt, SCROLL_CHECK_DEADLINE_MARGIN_MS),
      scrollCheckDeadline(SCROLL_CHECK_TIMING, NAV, startedAt)
    );
  }
  assert.equal(scrollCheckDeadline(SCROLL_CHECK_TIMING, NAV, NAV + 500, 60_000), SCROLL_END + 60_000);
  // A check that began late: its sequence ends 21 s after it began, and the
  // margin is counted from there.
  assert.equal(scrollCheckDeadline(SCROLL_CHECK_TIMING, NAV, NAV + 45_000, 60_000), NAV + 45_000 + 21_000 + 60_000);

  // The run's own field is what reaches the deadline: a page call that never
  // answers ends at the constant's margin without it, and at its own with it.
  const constant = await check({ startsAfterNavigationMs: 500, faultForTests: "hang" });
  assert.equal(constant.now(), SCROLL_END + SCROLL_CHECK_DEADLINE_MARGIN_MS);
  const named = fakeCheck({ startsAfterNavigationMs: 500, faultForTests: "hang" });
  named.run.deadlineMarginMs = 60_000;
  assert.equal((await runScrollCheck(named.run)).outcome, "cut-short");
  assert.equal(named.now(), SCROLL_END + 60_000);
});

test("a boundary callback is called at each of the four boundaries, and its time falls where the check says", async () => {
  // Three requests, each made while one callback runs.
  const scheduled = [
    // While control-start's callback runs: after the settle, before the window opens.
    { at: NAV + 26_000, url: "https://pixel.alpha.org/p" },
    // While control-end's callback runs: no input has happened yet.
    { at: NAV + 38_000, url: "https://pixel.beta.org/p" },
    // While scroll-end's callback runs: both windows have closed.
    { at: NAV + 51_200, url: "https://pixel.gamma.org/p" }
  ];
  const took: Record<ScrollCheckBoundary, number> = { "check-start": 1_000, "control-start": 2_000, "control-end": 3_000, "scroll-end": 500 };
  const withCallbacks = (marginMs?: number) => {
    const fake = fakeCheck({ scheduled: scheduled.map((request) => ({ ...request })) });
    const calls: [ScrollCheckBoundary, number][] = [];
    fake.run.boundary = async (name) => {
      calls.push([name, fake.now() - NAV]);
      await fake.run.sleep(took[name]);
    };
    if (marginMs !== undefined) fake.run.deadlineMarginMs = marginMs;
    return { fake, calls };
  };

  const { fake, calls } = withCallbacks(60_000);
  const evidence = await runScrollCheck(fake.run);
  assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
  assert.equal(evidence.outcome, "reached-end");
  assert.deepEqual(calls, [
    // The moment the check began.
    ["check-start", 5_000],
    // The settle's end: the first callback's second fell inside the settle.
    ["control-start", 25_000],
    // The window opened once its callback had run, and ran its full length.
    ["control-end", 27_000 + 10_500],
    // The scroll window began where the control window ended, callback included.
    ["scroll-end", 27_000 + 10_500 + 3_000 + 10_500]
  ]);
  // Before the window opened: new in neither window, as any host first
  // contacted between the visit's result and the window is.
  assert.equal(JSON.stringify(evidence).includes("alpha"), false);
  // In the control window's tail, not in the scroll window.
  assert.deepEqual(hostsOf(evidence.control), ["pixel.beta.org"]);
  assert.deepEqual(hostsOf(evidence.scroll), []);
  // After the scroll window closed: in no window.
  assert.equal(JSON.stringify(evidence).includes("gamma"), false);

  // The same callbacks under the scanner's own margin: they outrun the
  // check's deadline, which is why a run that carries them names its own.
  const short = withCallbacks();
  const cut = await runScrollCheck(short.fake.run);
  assert.equal(cut.outcome, "cut-short");
  assert.deepEqual(short.calls.map(([name]) => name), ["check-start", "control-start", "control-end"]);

  // A page with nothing to scroll has no scroll window, so no scroll-end.
  const flat = fakeCheck({ script: { height: 900 } });
  const flatCalls: ScrollCheckBoundary[] = [];
  flat.run.boundary = async (name) => void flatCalls.push(name);
  assert.equal((await runScrollCheck(flat.run)).outcome, "nothing-to-scroll");
  assert.deepEqual(flatCalls, ["check-start", "control-start", "control-end"]);
  // A check that does not run calls nothing.
  const notRun = fakeCheck({ subjectAvailable: false });
  notRun.run.boundary = async () => assert.fail("a check that did not run reached a boundary");
  assert.equal((await runScrollCheck(notRun.run)).outcome, "not-run");
});

test("a boundary callback that never settles is ended by the check's deadline, and one that throws ends the check", async () => {
  const never = (): Promise<void> => new Promise<void>(() => undefined);
  const hangAt = async (boundary: ScrollCheckBoundary) => {
    const fake = fakeCheck({});
    fake.run.boundary = (name) => (name === boundary ? never() : Promise.resolve());
    const evidence = await runScrollCheck(fake.run);
    assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
    // The wait ran to the check's own deadline and no further.
    assert.equal(fake.now(), fake.startedAt + SCROLL_CHECK_TIMING.phaseDeadlineMs, boundary);
    return evidence;
  };
  for (const boundary of ["check-start", "control-start", "control-end"] as const) {
    const evidence = await hangAt(boundary);
    assert.equal(evidence.outcome, "cut-short", boundary);
    assert.equal(evidence.control, null, boundary);
    assert.equal(evidence.scroll, null, boundary);
  }
  // At scroll-end both windows have closed: the check keeps what it earned.
  const afterWindows = await hangAt("scroll-end");
  assert.equal(afterWindows.outcome, "reached-end");
  assert.ok(afterWindows.control && afterWindows.scroll);

  // A callback's own error ends the check where it is; the scanner then
  // fails the visit with that error rather than report a check cut short.
  for (const boundary of ["check-start", "control-end", "scroll-end"] as const) {
    const fake = fakeCheck({});
    fake.run.boundary = async (name) => {
      if (name === boundary) throw new Error("the callback threw");
    };
    const evidence = await runScrollCheck(fake.run);
    assert.equal(isScrollCheckEvidence(evidence), true);
    assert.equal(evidence.outcome, "cut-short", boundary);
  }
});

test("the check tells a callback's owner when it has stopped waiting, so one it gave up on can neither change the record nor fail the visit", async () => {
  // The signal: not aborted while the check waits, aborted once it has
  // stopped, for a callback that answered and for one the deadline ended.
  const seen: [ScrollCheckBoundary, boolean, AbortSignal][] = [];
  const hung = fakeCheck({});
  hung.run.boundary = (name, waiting) => {
    seen.push([name, waiting.aborted, waiting]);
    return name === "control-start" ? new Promise<void>(() => undefined) : Promise.resolve();
  };
  assert.equal((await runScrollCheck(hung.run)).outcome, "cut-short");
  assert.deepEqual(seen.map(([name, abortedAtCall]) => [name, abortedAtCall]), [
    ["check-start", false],
    ["control-start", false]
  ]);
  assert.deepEqual(seen.map(([, , waiting]) => waiting.aborted), [true, true]);

  // Through the seam's own record. The scroll-end callback outlives the
  // deadline, and then rejects while the check is still settling, before the
  // scanner asks whether a callback failed.
  const read = async () => ({}) as never;
  let rejectAbandoned = (_error: Error): void => undefined;
  const seam = openInvestigationSeam({
    scrollCheckBoundary: (boundary) =>
      boundary === "scroll-end" ? new Promise<void>((_resolve, reject) => (rejectAbandoned = reject)) : undefined
  });
  const fake = fakeCheck({});
  fake.run.boundary = (name, waiting) => seam.scrollCheckBoundary(name, read, waiting);
  let rejectedDuringSettle = false;
  fake.run.settleRoutes = async () => {
    rejectAbandoned(new Error("the abandoned callback rejected late"));
    rejectedDuringSettle = true;
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const evidence = await runScrollCheck(fake.run);
  assert.equal(rejectedDuringSettle, true);
  // Both windows had closed: the check keeps its outcome, as documented.
  assert.equal(evidence.outcome, "reached-end");
  assert.doesNotThrow(() => seam.rethrowBoundaryFailure());
  const calls = seam.use().hookDurationsMs.scrollCheckBoundary;
  assert.deepEqual(calls.map((call) => call.boundary), ["check-start", "control-start", "control-end", "scroll-end"]);
  assert.deepEqual(calls.map((call) => call.ms === null), [false, false, false, true]);

  // A callback the check is still awaiting when it rejects does fail the visit.
  const thrown = new Error("the awaited callback threw");
  const failing = openInvestigationSeam({
    scrollCheckBoundary: (boundary) => {
      if (boundary === "control-end") throw thrown;
    }
  });
  const awaited = fakeCheck({});
  awaited.run.boundary = (name, waiting) => failing.scrollCheckBoundary(name, read, waiting);
  assert.equal((await runScrollCheck(awaited.run)).outcome, "cut-short");
  assert.throws(() => failing.rethrowBoundaryFailure(), (error) => error === thrown);
});
