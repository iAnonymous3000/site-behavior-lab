import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import {
  runScrollCheck,
  ScrollCheckRecorder,
  SCROLL_CHECK_TIMING,
  type ScrollCheckRouteDecision,
  type ScrollCheckRun,
  type ScrollState
} from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence, type ScrollCheckHostStacks, type ScrollCheckOutcome } from "./scroll-check-evidence";
import { ScrollCheckStackRecorder } from "./scroll-check-stacks";

/**
 * RA4, a bounded check that the scroll producer satisfies its validator, through the
 * real recorders and the real runScrollCheck on a scripted page and clock.
 *
 * This matters because the failure is silent: withCallStacks drops every stack of a
 * check when isScrollCheckEvidence refuses them, the labels and the events go the same
 * way, and a refusal of the windows themselves turns the whole check into a bare
 * cut-short. So beside "what it returns validates", which no guard can fail while the
 * guards stand, each property asks whether the part the world earned is still there.
 *
 * Domain, each run through the whole check at the production timing:
 * - buckets: one listed host with up to one request in each of a stack, another stack,
 *   a redirect hop, no stack, a stack naming no requested script, a worker's request the
 *   session never observes, an observation past the recorder's bound and an unanswered
 *   request, over distinct short URLs, all one URL, URLs past the held length, and URLs
 *   the page reports with a fragment;
 * - what a window does not count: every subset of an unanswered request, the page's
 *   navigation, a refused request, one over the allowance, one undecided and one to the
 *   site itself, before or after one counted request in each bucket;
 * - what the counting rule turns on, world by world: a host whose first request was not
 *   sent beside one that lists as the same name, labels on requests not counted, a request
 *   in the instant before a window opens, a first-party beacon with no answer, a redirect
 *   hop to a beacon's address, a URL observed more often than requested, and a stack
 *   observed in the settle naming a script requested after the window;
 * - the recorders' bounds: past the distinct hosts and the window requests they keep, at
 *   bounds of 1 to 3 (5,000 in production), past the 4,000 script addresses and the 2,000
 *   URLs whose drops they count, a URL dropped twice, and a bound reached with one window
 *   or none;
 * - the group bound: up to two requests under each of 7 stack shapes, which publish as 1
 *   to 4 hosts with repeats, cuts and merges, and so 0 to 6 groups;
 * - host forms: the table below, each as a listed host in each bucket and in the window
 *   without input, every ordered pair as two listed hosts with the lists compared, and
 *   every ordered pair, with seven more schemes, as the two frames of a stack;
 * - the list bound: 0, 1, 19, 20, 21 and 25 hosts across several sizes of site, with
 *   known-host requests, unanswered and refused requests, and no list facts, lists
 *   unavailable or lists compared;
 * - endings: every number of screens to each outcome that has a scroll window, and these
 *   ways to have none or lose one: no subject, nothing to scroll, locked or stuck at once,
 *   leaving before, during or after the windows, an unreadable state, a refused scroll or
 *   scroll back, a page that grows at its end, a page call that throws, leaving or not,
 *   and a cancellation, each with list facts, a beacon, used-up budgets and a changed
 *   address;
 * - facts that throw: an address, a list fact, a body, the proxy's count, and the routes'
 *   settle, one at a time.
 *
 * Left out, and why: analytics events beyond one GA4 and one Adobe beacon a window,
 * which lib/scroll-check-events.test.ts walks; requests after the window, which RA6
 * holds; a recording that failed or a session that never opened, which get no stacks by
 * design and which lib/scroll-check-stacks.test.ts pins; timings other than production's;
 * host forms beyond the table. Axioms: every observation arrives before its page event,
 * but for the settle's one world, which says otherwise, the session reports a URL without
 * its fragment, and Node's URL and the page's agree on a host. Whether Chromium ever
 * hands the check a form in the table is a measurement. The three forms the validator
 * refuses are out of the domain, and pinned below as open.
 *
 * This holds the window relations (requests at least hostCount plus knownHostRequests,
 * the stacks' requests at most requests less knownHostRequests) and the counting rule only
 * within this domain, with the real redaction. RA9, the same over a counting core with
 * hosts as tokens, is not this check.
 */

type Modules = {
  ScrollCheckRecorder: typeof ScrollCheckRecorder;
  ScrollCheckStackRecorder: typeof ScrollCheckStackRecorder;
  runScrollCheck: typeof runScrollCheck;
};
const PRODUCTION: Modules = { ScrollCheckRecorder, ScrollCheckStackRecorder, runScrollCheck };

type FakeRequest = { url: string; redirected?: boolean; navigation?: boolean };

const BOTH = [false, true] as const;

type Bucket = "stack" | "other-stack" | "redirected" | "without-stack" | "without-named-script" | "worker" | "past-the-bound" | "unanswered";
const BUCKETS: readonly Bucket[] = ["stack", "other-stack", "redirected", "without-stack", "without-named-script", "worker", "past-the-bound", "unanswered"];

/** A request the world makes in a window, and what the session and the scanner make of it. */
type WorldRequest = {
  url: string;
  /** The frames of its call stack, innermost first, or how the session sees it. */
  seen: readonly string[] | "no-stack" | "redirected" | "worker";
  decision?: ScrollCheckRouteDecision | "undecided";
  answered?: boolean;
  listMatch?: boolean | null;
  body?: string;
  navigation?: boolean;
  /** The session reports it and the page never does. */
  sessionOnly?: boolean;
};

const NAV = 1_000_000;
const STARTED = NAV + 5_000;
const CONTROL_START = NAV + SCROLL_CHECK_TIMING.settleAfterNavigationMs;
const SCROLL_START = CONTROL_START + SCROLL_CHECK_TIMING.controlWindowMs;
const FIRST_PARTY = "www.example.com";
const PAGE_URL = `http://${FIRST_PARTY}/`;
const VIEWPORT = 980;
const UNREADABLE = "unreadable";

type World = {
  /** Scripts the page requested at load, whose addresses name frames. */
  scripts?: readonly string[];
  /** Requests before the windows: their hosts are already contacted. */
  before?: readonly WorldRequest[];
  control?: readonly WorldRequest[];
  scroll?: readonly WorldRequest[];
  /** Screens before the page ends, 1 to 8; past 8, the check stops at its depth limit. */
  screens?: number;
  /** How the scrolling ends, when it does not reach the page's end. */
  ending?:
    | "reached-end"
    | "locked"
    | "did-not-move"
    | "nothing-to-scroll"
    | "locked-at-once"
    | "stuck-at-once"
    | "left-site"
    | "left-before-the-windows"
    | "left-in-the-window-without-input"
    | "left-at-the-scroll-window-s-end"
    | "unreadable"
    | "refused-scroll"
    | "refused-scroll-back"
    | "grows-by-a-pixel"
    | "state-throws"
    | "state-throws-leaving"
    | "cancelled";
  /** Requests in the instant the window without input opens, before it does. */
  atTheOpening?: readonly WorldRequest[];
  /** What the session reports while the check settles its routes, after the scroll window. */
  inTheSettle?: readonly Record<string, unknown>[];
  allowance?: number;
  maxHosts?: number;
  maxWindowRequests?: number;
  lists?: "none" | "unavailable" | "compared";
  subjectAvailable?: boolean;
  /** The page changes its own address, on its site, after the first screen. */
  addressChanges?: boolean;
  visitBudgetUsedUp?: boolean;
  proxyLoss?: "before-the-check" | "in-the-check";
  throws?: "list-fact" | "body" | "proxy-count" | "routes-settle";
};

function observation(request: WorldRequest): Record<string, unknown> | null {
  if (request.seen === "worker") return null;
  // Chromium keeps a fragment apart, in `urlFragment`.
  const base = { requestId: request.url, request: { url: request.url.split("#")[0] }, type: "Fetch" };
  if (request.seen === "no-stack") return { ...base, initiator: { type: "parser" } };
  if (request.seen === "redirected") return { ...base, initiator: { type: "script", stack: { callFrames: [{ url: "http://cdn.alpha.net/a.js" }] } }, redirectResponse: { status: 302 } };
  return { ...base, initiator: { type: "script", stack: { callFrames: request.seen.map((url) => ({ url })) } } };
}

async function runWorld(modules: Modules, world: World): Promise<ScrollCheckEvidence> {
  let now = STARTED;
  const matches = new Map<FakeRequest, boolean | null>();
  const bodies = new Map<FakeRequest, string>();
  const recorder = new modules.ScrollCheckRecorder<FakeRequest>(
    {
      url: (request) => {
        if (request.url === UNREADABLE) throw new Error("This address cannot be read.");
        return request.url;
      },
      redirected: (request) => request.redirected === true,
      mainFrameNavigation: (request) => request.navigation === true,
      postData: (request) => {
        if (world.throws === "body") throw new Error("This body cannot be read.");
        return { value: bodies.get(request) ?? null, truncated: false, unreadable: false };
      },
      ...(world.lists === "compared" || world.lists === "unavailable"
        ? {
            filterLists: {
              loaded: world.lists === "compared",
              listMatch: (request: FakeRequest) => {
                if (world.throws === "list-fact") throw new Error("This list fact cannot be read.");
                return world.lists === "compared" ? (matches.get(request) ?? null) : null;
              }
            }
          }
        : {})
    },
    () => now,
    world.maxHosts,
    world.maxWindowRequests
  );
  const stacks = new modules.ScrollCheckStackRecorder(world.allowance ?? 500);
  const make = (request: WorldRequest) => {
    const seen = observation(request);
    if (seen !== null) stacks.observe(seen);
    if (request.sessionOnly === true) return;
    const made: FakeRequest = { url: request.url, redirected: request.seen === "redirected", navigation: request.navigation === true };
    matches.set(made, request.listMatch ?? null);
    if (request.body !== undefined) bodies.set(made, request.body);
    recorder.noteRequest(made);
    if (request.seen !== "redirected" && request.decision !== "undecided") recorder.noteRouted(made, request.decision ?? "sent");
    const sent = request.seen === "redirected" || (request.decision ?? "sent") === "sent";
    if (sent && request.answered !== false) recorder.noteAnswered(made);
    // The settle ends on an answer or a failure, so no request here holds it open.
    else if (sent) recorder.noteFailed(made);
  };
  // What the visit did before the check began.
  stacks.observe({ requestId: "document", request: { url: PAGE_URL }, type: "Document", initiator: { type: "other" } });
  for (const script of world.scripts ?? []) stacks.observe({ requestId: script, request: { url: script }, type: "Script", initiator: { type: "parser" } });
  for (const request of world.before ?? []) make(request);
  const inControl = [...(world.control ?? [])];
  const inScroll = [...(world.scroll ?? [])];
  const screens = world.screens ?? 1;
  const ending = world.ending ?? "reached-end";
  const endsOnItsOwn = ending === "reached-end" || ending === "refused-scroll-back" || ending === "left-at-the-scroll-window-s-end" || ending === "grows-by-a-pixel";
  let height = ending === "nothing-to-scroll" ? VIEWPORT : VIEWPORT * (screens + 1) + VIEWPORT * 20 * Number(!endsOnItsOwn);
  let top = 0;
  let step = 0;
  let scrollRequestsMade = false;
  let left = false;
  const advance = (until: number) => {
    if (now < CONTROL_START && until >= CONTROL_START) {
      now = CONTROL_START;
      for (const request of world.atTheOpening ?? []) make(request);
      if (ending === "left-before-the-windows") left = true;
    }
    if (now < SCROLL_START - 1_500 && until >= SCROLL_START - 1_500) {
      now = CONTROL_START + 1;
      for (const request of inControl) make(request);
    }
    if (ending === "left-in-the-window-without-input" && until >= SCROLL_START) left = true;
    if (ending === "left-at-the-scroll-window-s-end" && until >= SCROLL_START + SCROLL_CHECK_TIMING.scrollWindowMs) left = true;
    now = Math.max(now, until);
  };
  const run: ScrollCheckRun<FakeRequest> = {
    recorder,
    stacks,
    timing: SCROLL_CHECK_TIMING,
    navigationStartedAt: NAV,
    startedAt: STARTED,
    subjectAvailable: world.subjectAvailable ?? true,
    firstPartyHostname: FIRST_PARTY,
    sameSubject: () => !left,
    leftSiteAt: () => (left ? now : null),
    visitBudgetUsedUp: world.visitBudgetUsedUp ?? false,
    proxyLossCount: () => {
      if (world.throws === "proxy-count") throw new Error("This count cannot be read.");
      return world.proxyLoss === "before-the-check" || (world.proxyLoss === "in-the-check" && now > STARTED) ? 1 : 0;
    },
    settleRoutes: async () => {
      for (const seen of world.inTheSettle ?? []) stacks.observe(seen);
      if (world.throws === "routes-settle") throw new Error("The routes did not settle.");
    },
    now: () => now,
    // A wait beside a page call or the settle ends when its signal aborts, which every
    // scripted call does at once. Only the plain waits move the clock.
    sleep: (ms, stop) =>
      new Promise<void>((resolve, reject) => {
        if (stop === undefined) {
          if (ending === "cancelled" && now >= SCROLL_START) reject(new Error("The scan was cancelled."));
          advance(now + ms);
          resolve();
        } else if (stop.aborted) resolve();
        else stop.addEventListener("abort", () => resolve(), { once: true });
      }),
    page: {
      url: () => (world.addressChanges === true && step >= 1 ? `${PAGE_URL}next` : PAGE_URL),
      scrollState: async (): Promise<ScrollState | null> => {
        if (ending === "unreadable" && step >= screens) return null;
        if ((ending === "state-throws" || ending === "state-throws-leaving") && step >= screens) {
          left = ending === "state-throws-leaving";
          throw new Error("The page's document is gone.");
        }
        return { top, height, viewport: VIEWPORT, locked: ending === "locked-at-once" || (ending === "locked" && step >= screens) };
      },
      scrollTo: async (target) => {
        if (target === 0) return ending !== "refused-scroll-back";
        step += 1;
        if (ending === "refused-scroll" && step >= screens) return false;
        if (ending === "grows-by-a-pixel" && step === 1) height += 1;
        if (!scrollRequestsMade) {
          scrollRequestsMade = true;
          for (const request of inScroll) make(request);
        }
        if (ending === "left-site" && step >= screens) left = true;
        if (ending === "stuck-at-once" || (ending === "did-not-move" && step > screens)) return true;
        top = Math.min(target, height - VIEWPORT);
        return true;
      }
    }
  };
  return modules.runScrollCheck(run);
}

// One host's requests, as the world knows them.
const SCRIPT_A = "http://cdn.alpha.net/a.js";
const SCRIPT_B = "http://static.bravo.org/b.js";
const SCRIPT_C = "http://cdn.charlie.com/c.js";
const SCRIPT_D = "http://cdn.delta.net/d.js";
const SCRIPT_E = "http://cdn.echo.net/e.js";
const HOST_A = "cdn.alpha.net";
const HOST_B = "static.bravo.org";
const HOST_C = "cdn.charlie.com";
const HOST_D = "cdn.delta.net";
const HOST_E = "cdn.echo.net";
const ALL_SCRIPTS = [SCRIPT_A, SCRIPT_B, SCRIPT_C, SCRIPT_D, SCRIPT_E];

const requestIn = (bucket: Bucket, url: string): WorldRequest => {
  switch (bucket) {
    case "stack":
      return { url, seen: [SCRIPT_A] };
    case "other-stack":
      return { url, seen: [SCRIPT_B] };
    case "redirected":
      return { url, seen: "redirected" };
    case "without-stack":
      return { url, seen: "no-stack" };
    case "without-named-script":
      return { url, seen: ["http://never.requested.net/x.js"] };
    case "worker":
      return { url, seen: "worker" };
    case "past-the-bound":
      return { url, seen: [SCRIPT_A] };
    case "unanswered":
      return { url, seen: [SCRIPT_A], answered: false };
  }
};

/**
 * Every part the world earned must still be there. The stacks are earned by a scroll
 * window with a recorder that lost nothing, the labels by list facts and something to
 * label, and the outcome by how the page behaved.
 */
function holdCarried(evidence: ScrollCheckEvidence, expected: { outcome: ScrollCheckOutcome; scrollRan: boolean; reportLost?: boolean; lists?: World["lists"]; labels?: boolean; events?: boolean }, input: () => unknown): void {
  holds("ra4-what-the-check-returns-validates", isScrollCheckEvidence(evidence), input);
  holds("ra4-the-check-keeps-its-outcome-and-windows", evidence.outcome === expected.outcome && (evidence.scroll !== null) === expected.scrollRan, input);
  if (expected.scrollRan) holds("ra4-the-check-keeps-its-stacks", (evidence.scroll?.stacks !== undefined) === (expected.reportLost !== true), input);
  if (expected.events === true) holds("ra4-the-check-keeps-its-events", evidence.events !== undefined, input);
  if (expected.labels === true) holds("ra4-the-check-keeps-its-labels", evidence.filterLists === (expected.lists === "compared" ? "compared" : "unavailable"), input);
}

const stacksOf = (evidence: ScrollCheckEvidence): readonly ScrollCheckHostStacks[] => evidence.scroll?.stacks ?? [];

type BucketCounts = Record<"redirected" | "withoutStack" | "withoutNamedScript" | "notListed" | "unobserved" | "grouped", number>;

/** How a world's requests spell their URLs: each its own and short, each its own and past the held length, each its own with a fragment, or all one. */
const URL_FORMS = {
  short: (target: string, index: number) => `${target}/${index}`,
  long: (target: string, index: number) => `${target}/${index}?pad=${"x".repeat(2_100)}`,
  fragment: (target: string, index: number) => `${target}/${index}#from-the-page`,
  one: (target: string) => target
} as const;

/** Every subset of the buckets, one request in each, in each URL form. */
async function checkBuckets(modules: Modules): Promise<number> {
  let cases = 0;
  const target = "http://pixel.golf.net/hit";
  for (let mask = 0; mask < 1 << BUCKETS.length; mask += 1) {
    const chosen = BUCKETS.filter((_bucket, index) => (mask & (1 << index)) !== 0);
    // The host is listed only for a counted request, and the bound's own bucket needs an observation kept before it.
    if (chosen.every((bucket) => bucket === "unanswered")) continue;
    for (const form of ["short", "long", "fragment", "one"] as const) {
      cases += 1;
      const oneUrl = form === "one";
      const ordered = [...chosen.filter((bucket) => bucket !== "past-the-bound"), ...chosen.filter((bucket) => bucket === "past-the-bound")];
      const scroll = ordered.map((bucket, index) => requestIn(bucket, URL_FORMS[form](target, index)));
      const kept = scroll.filter((request, index) => request.seen !== "worker" && ordered[index] !== "past-the-bound").length;
      const world: World = { scripts: ALL_SCRIPTS, scroll, allowance: chosen.includes("past-the-bound") ? kept : 500 };
      const evidence = await runWorld(modules, world);
      const input = () => ({ chosen, form, evidence });
      holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
      const counted = chosen.filter((bucket) => bucket !== "unanswered").length;
      holds("ra4-the-window-counts-what-the-world-counted", evidence.scroll?.requests === counted && evidence.scroll.hostCount === 1 && evidence.scroll.unanswered === (chosen.includes("unanswered") ? 1 : undefined), input);
      const entry = stacksOf(evidence)[0];
      const has = (bucket: Bucket) => (chosen.includes(bucket) ? 1 : 0);
      const given: BucketCounts = {
        redirected: entry.redirected,
        withoutStack: entry.withoutStack,
        withoutNamedScript: entry.withoutNamedScript,
        notListed: entry.notListed,
        unobserved: entry.unobserved,
        grouped: entry.groups.reduce((sum, group) => sum + group.count, 0)
      };
      if (!oneUrl) {
        // On distinct URLs each request keeps what it truly was. One URL pairs by position, which RA1 and RA2 hold,
        // and the validator holds the sum either way.
        const truth: BucketCounts = {
          redirected: has("redirected"),
          withoutStack: has("without-stack"),
          withoutNamedScript: has("without-named-script"),
          notListed: has("past-the-bound"),
          unobserved: has("worker"),
          grouped: has("stack") + has("other-stack")
        };
        holds("ra4-each-bucket-holds-what-the-world-put-there", JSON.stringify(given) === JSON.stringify(truth), input);
      }
    }
  }
  return cases;
}

type Uncounted = "unanswered" | "navigation" | "refused" | "allowance" | "undecided" | "first-party";
const UNCOUNTED: readonly Uncounted[] = ["unanswered", "navigation", "refused", "allowance", "undecided", "first-party"];

function uncountedRequest(kind: Uncounted, url: string): WorldRequest {
  switch (kind) {
    case "unanswered":
      return { url, seen: [SCRIPT_A], answered: false };
    case "navigation":
      return { url, seen: "no-stack", navigation: true };
    case "refused":
      return { url, seen: [SCRIPT_A], decision: "refused" };
    case "allowance":
      return { url, seen: [SCRIPT_A], decision: "allowance" };
    case "undecided":
      return { url, seen: [SCRIPT_A], decision: "undecided" };
    case "first-party":
      return { url: "http://static.example.com/own", seen: [SCRIPT_A] };
  }
}

/**
 * Every subset of what a window does not count, before or after the one request it does,
 * in each bucket, on one URL or distinct ones. The expectations restate the rule in
 * lib/scroll-check.ts: a request counts when the scanner sent it, its host answered, it
 * is third party and it is not the page's navigation; a host is listed when its first
 * request was one the window could count and one of its requests was counted.
 */
async function checkUncounted(modules: Modules): Promise<number> {
  let cases = 0;
  const target = "http://pixel.golf.net/hit";
  for (let mask = 0; mask < 1 << UNCOUNTED.length; mask += 1) {
    const kinds = UNCOUNTED.filter((_kind, index) => (mask & (1 << index)) !== 0);
    for (const bucket of BUCKETS.filter((candidate) => candidate !== "unanswered" && candidate !== "past-the-bound")) {
      for (const countedFirst of BOTH) {
        for (const oneUrl of BOTH) {
          cases += 1;
          const uncounted = kinds.map((kind, index) => uncountedRequest(kind, oneUrl ? target : `${target}/${index}`));
          const counted = requestIn(bucket, oneUrl ? target : `${target}/counted`);
          const scroll = countedFirst ? [counted, ...uncounted] : [...uncounted, counted];
          const evidence = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll });
          const input = () => ({ kinds, bucket, countedFirst, oneUrl, evidence });
          holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
          const firstOnHost = countedFirst ? null : kinds.find((kind) => kind !== "first-party");
          const listed = firstOnHost === null || firstOnHost === undefined || firstOnHost === "unanswered";
          const reasons = [...(kinds.includes("allowance") ? ["check-allowance"] : []), ...(kinds.includes("refused") || kinds.includes("undecided") ? ["refused"] : [])];
          holds("ra4-the-window-counts-what-the-world-counted", evidence.scroll?.requests === 1 && evidence.scroll.knownHostRequests === 0 && evidence.scroll.unanswered === (kinds.includes("unanswered") ? 1 : undefined), input);
          holds("ra4-a-host-is-listed-only-if-its-first-request-could-count", evidence.scroll?.hostCount === (listed ? 1 : 0) && stacksOf(evidence).length === (listed ? 1 : 0) && stacksOf(evidence).every((entry) => entry.requests === 1), input);
          holds("ra4-the-check-says-what-cut-it", JSON.stringify(evidence.incomplete) === JSON.stringify(reasons), input);
        }
      }
    }
  }
  return cases;
}

/**
 * Worlds a walk of subsets does not reach, each with what its window must say. These restate
 * the rule in lib/scroll-check.ts, so they catch the code drifting from it, not a wrong rule.
 */
async function checkCountingWorlds(modules: Modules): Promise<number> {
  const counted = (url: string, listMatch: boolean | null = null): WorldRequest => ({ url, seen: [SCRIPT_A], listMatch });
  const worlds: ReadonlyArray<{ name: string; world: World; requests: number; hostCount: number; entryRequests?: number; matched?: readonly string[]; unanswered?: number; incomplete?: readonly string[]; events?: boolean; groups?: readonly { count: number; hosts: readonly string[] }[] }> = [
    {
      name: "a host whose first request was refused is not listed, though a later one was answered",
      world: { scroll: [{ ...counted("http://zz.alpha.net/a"), decision: "refused" }, counted("http://zz.alpha.net/b")], lists: "compared" },
      requests: 1,
      hostCount: 0,
      incomplete: ["refused"]
    },
    {
      name: "beside a host that lists as the same name, it lends that name neither its requests nor its label",
      world: { scroll: [{ ...counted("http://zz.alpha.net/a"), decision: "refused" }, counted("http://zz.alpha.net/b", true), counted("http://yy.alpha.net/c", false)], lists: "compared" },
      requests: 2,
      hostCount: 1,
      entryRequests: 1,
      matched: [],
      incomplete: ["refused"]
    },
    {
      name: "a label reads only what the window counted",
      world: { scroll: [counted("http://cdn.golf.net/a", false), { ...counted("http://cdn.golf.net/b", true), answered: false }, { ...counted("http://cdn.golf.net/c", true), decision: "refused" }], lists: "compared" },
      requests: 1,
      hostCount: 1,
      entryRequests: 1,
      matched: [],
      unanswered: 1,
      incomplete: ["refused"]
    },
    {
      name: "an uncounted request keeps its own observation, so a later one on its URL keeps its own stack",
      world: { scroll: [{ url: "http://cdn.golf.net/a", seen: [SCRIPT_A], answered: false }, { url: "http://cdn.golf.net/a", seen: [SCRIPT_B] }] },
      requests: 1,
      hostCount: 1,
      entryRequests: 1,
      unanswered: 1,
      groups: [{ count: 1, hosts: [HOST_B] }]
    },
    {
      name: "a host's label is the strongest across its counted requests, wherever the match falls",
      world: { scroll: [counted("http://cdn.golf.net/a", true), counted("http://cdn.golf.net/b", false)], lists: "compared" },
      requests: 2,
      hostCount: 1,
      entryRequests: 2,
      matched: ["cdn.golf.net"]
    },
    {
      name: "a host first seen in the instant before a window opens is not first contacted in it",
      world: { atTheOpening: [counted("http://cdn.golf.net/a")], control: [counted("http://cdn.golf.net/b")], scroll: [] },
      requests: 0,
      hostCount: 0
    },
    {
      name: "an unanswered beacon on the site's own host is said, though it is no third party",
      world: { scroll: [counted("http://cdn.golf.net/a"), { url: GA4(FIRST_PARTY, "page_view"), seen: [SCRIPT_A], answered: false, body: "" }] },
      requests: 1,
      hostCount: 1,
      entryRequests: 1,
      unanswered: 1
    },
    {
      name: "a redirect hop to a beacon's address is no beacon",
      world: { scroll: [{ url: GA4("tally.lima.net", "page_view"), seen: "redirected", body: "" }] },
      requests: 1,
      hostCount: 1,
      entryRequests: 1,
      events: false
    },
    {
      name: "a URL observed more often than requested, with what the observations add differing, is unobserved for what the window counted",
      world: {
        scripts: ALL_SCRIPTS,
        scroll: [counted("http://cdn.golf.net/a"), { ...counted("http://cdn.golf.net/a"), answered: false }, { url: "http://cdn.golf.net/a", seen: [SCRIPT_B], sessionOnly: true }]
      },
      requests: 1,
      hostCount: 1,
      entryRequests: 1,
      unanswered: 1
    }
  ];
  for (const { name, world, requests, hostCount, entryRequests, matched, unanswered, incomplete, events, groups } of worlds) {
    const evidence = await runWorld(modules, { scripts: ALL_SCRIPTS, ...world });
    const input = () => ({ name, evidence });
    holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
    const window = name.includes("before a window opens") ? evidence.control : evidence.scroll;
    if (world.control === undefined) holds("ra4-the-window-counts-what-the-world-counted", evidence.scroll?.requests === requests && evidence.scroll.unanswered === unanswered, input);
    holds("ra4-a-host-is-listed-only-if-its-first-request-could-count", window?.hostCount === hostCount, input);
    if (entryRequests !== undefined) holds("ra4-a-listed-host-stands-only-for-what-listed-it", stacksOf(evidence)[0]?.requests === entryRequests, input);
    if (matched !== undefined) holds("ra4-each-label-is-what-the-world-matched", JSON.stringify(evidence.scroll?.matchedHosts) === JSON.stringify(matched), input);
    if (incomplete !== undefined) holds("ra4-the-check-says-what-cut-it", JSON.stringify(evidence.incomplete) === JSON.stringify(incomplete), input);
    if (events !== undefined) holds("ra4-a-redirect-hop-is-no-beacon", (evidence.events !== undefined) === events, input);
    if (groups !== undefined) holds("ra4-an-uncounted-request-keeps-its-own-observation", JSON.stringify(stacksOf(evidence)[0]?.groups) === JSON.stringify(groups), input);
  }
  // Observed in the settle, past the window: a script first requested then names no frame, so its stack names nothing.
  const late = "http://late.script.net/s.js";
  const settled = await runWorld(modules, {
    scripts: ALL_SCRIPTS,
    scroll: [{ url: "http://cdn.golf.net/a", seen: "worker" }],
    inTheSettle: [
      { requestId: late, request: { url: late }, type: "Script", initiator: { type: "parser" } },
      { requestId: "a", request: { url: "http://cdn.golf.net/a" }, type: "Fetch", initiator: { type: "script", stack: { callFrames: [{ url: late }] } } }
    ]
  });
  holdCarried(settled, { outcome: "reached-end", scrollRan: true }, () => settled);
  holds("ra4-a-script-requested-after-the-window-names-no-frame", stacksOf(settled)[0].withoutNamedScript === 1 && stacksOf(settled)[0].groups.length === 0, () => settled);
  return worlds.length + 1;
}

/** A fact that throws costs the check that fact's part and no other. */
async function checkThrowingFacts(modules: Modules): Promise<number> {
  const scroll: WorldRequest[] = [{ url: "http://pixel.golf.net/hit", seen: [SCRIPT_A], listMatch: true }, { url: GA4("tally.lima.net", "page_view"), seen: [SCRIPT_A], body: "" }];
  const whole = { scripts: ALL_SCRIPTS, scroll, lists: "compared" } as const;
  const worlds: ReadonlyArray<{ throws: World["throws"]; labels: boolean; events: boolean }> = [
    { throws: undefined, labels: true, events: true },
    { throws: "list-fact", labels: false, events: true },
    { throws: "body", labels: true, events: true },
    { throws: "proxy-count", labels: true, events: true },
    { throws: "routes-settle", labels: true, events: true }
  ];
  for (const { throws, labels, events } of worlds) {
    const evidence = await runWorld(modules, { ...whole, throws });
    const input = () => ({ throws, evidence });
    holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
    holds("ra4-a-fact-that-throws-costs-only-its-own-part", (evidence.filterLists !== undefined) === labels && (evidence.events !== undefined) === events && evidence.incomplete.length === 0, input);
    // A body it cannot read still names what its address says, and is counted as not read in full.
    holds("ra4-a-fact-that-throws-costs-only-its-own-part", evidence.events?.scroll?.notDecoded === (throws === "body" ? 1 : 0), input);
  }
  // An address it cannot read is a request it lost: the check says so and carries no stacks.
  const lost = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll: [{ url: "http://pixel.golf.net/hit", seen: [SCRIPT_A] }, { url: UNREADABLE, seen: "worker" }] });
  holdCarried(lost, { outcome: "reached-end", scrollRan: true, reportLost: true }, () => lost);
  holds("ra4-a-fact-that-throws-costs-only-its-own-part", JSON.stringify(lost.incomplete) === '["host-bound"]' && lost.scroll?.hostCount === 1, () => lost);
  // A proxy loss from before the check is not the check's.
  const before = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll, proxyLoss: "before-the-check" });
  holds("ra4-the-check-says-what-cut-it", before.incomplete.length === 0, () => before);
  return worlds.length + 2;
}

/** The recorders' own bounds: distinct hosts, window requests, script addresses and URLs whose drops are counted. */
async function checkRecorderBounds(modules: Modules): Promise<number> {
  let cases = 0;
  const hosts = (count: number) => Array.from({ length: count }, (_value, index): WorldRequest => requestIn("stack", `http://cdn.site${index}.net/x`));
  for (const bound of [1, 2, 3]) {
    for (let count = 0; count <= 4; count += 1) {
      cases += 2;
      const pastHosts = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll: hosts(count), maxHosts: bound });
      const hostsInput = () => ({ bound, count, pastHosts });
      holdCarried(pastHosts, { outcome: "reached-end", scrollRan: true }, hostsInput);
      holds("ra4-the-window-counts-what-the-world-counted", pastHosts.scroll?.requests === count, hostsInput);
      holds("ra4-a-host-past-the-bound-is-not-listed-and-is-said", pastHosts.scroll?.hostCount === Math.min(count, bound) && stacksOf(pastHosts).length === Math.min(count, bound) && pastHosts.incomplete.includes("host-bound") === count > bound, hostsInput);
      const pastRequests = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll: hosts(count), maxWindowRequests: bound });
      const requestsInput = () => ({ bound, count, pastRequests });
      holdCarried(pastRequests, { outcome: "reached-end", scrollRan: true, reportLost: count > bound }, requestsInput);
      holds("ra4-the-window-counts-what-the-world-counted", pastRequests.scroll?.requests === Math.min(count, bound), requestsInput);
      holds("ra4-a-host-past-the-bound-is-not-listed-and-is-said", pastRequests.incomplete.includes("host-bound") === count > bound, requestsInput);
    }
  }
  // Past the script addresses a recorder keeps, nothing is named. Past the URLs it counts drops for, nothing it dropped is joined.
  cases += 2;
  const scripts = [...ALL_SCRIPTS, ...Array.from({ length: 4_001 }, (_value, index) => `http://cdn.scripts.net/${index}.js`)];
  const pastScripts = await runWorld(modules, { scripts, scroll: [requestIn("stack", "http://pixel.golf.net/hit")] });
  holdCarried(pastScripts, { outcome: "reached-end", scrollRan: true }, () => pastScripts);
  holds("ra4-each-bucket-holds-what-the-world-put-there", stacksOf(pastScripts)[0].notListed === 1, () => pastScripts);
  const pastDrops = await runWorld(modules, { scripts: ALL_SCRIPTS, allowance: 0, scroll: Array.from({ length: 2_002 }, (_value, index): WorldRequest => requestIn("stack", `http://pixel.golf.net/${index}`)) });
  holdCarried(pastDrops, { outcome: "reached-end", scrollRan: true }, () => pastDrops.scroll?.hostCount);
  holds("ra4-each-bucket-holds-what-the-world-put-there", stacksOf(pastDrops)[0].notListed === 2_002, () => stacksOf(pastDrops)[0]);
  // A URL dropped twice is not listed twice, not once and then never observed.
  cases += 1;
  const droppedTwice = await runWorld(modules, { scripts: ALL_SCRIPTS, allowance: 0, scroll: [requestIn("stack", "http://pixel.golf.net/a"), requestIn("stack", "http://pixel.golf.net/a")] });
  holds("ra4-each-bucket-holds-what-the-world-put-there", stacksOf(droppedTwice)[0].notListed === 2 && stacksOf(droppedTwice)[0].unobserved === 0, () => droppedTwice);
  // The URLs whose drops are counted, to the one: at the bound a worker's request is still never observed, and past it nothing says.
  for (const [droppedUrls, unobserved] of [[2_000, 1], [2_001, 0]] as const) {
    cases += 1;
    const scroll = [...Array.from({ length: droppedUrls }, (_value, index): WorldRequest => requestIn("stack", `http://pixel.golf.net/${index}`)), requestIn("worker", "http://pixel.golf.net/worker")];
    const atTheBound = await runWorld(modules, { scripts: ALL_SCRIPTS, allowance: 0, scroll });
    holds("ra4-each-bucket-holds-what-the-world-put-there", stacksOf(atTheBound)[0].unobserved === unobserved && stacksOf(atTheBound)[0].notListed === droppedUrls + 1 - unobserved, () => stacksOf(atTheBound)[0]);
  }
  // The site's own observations spend nothing of the allowance.
  cases += 1;
  const ownFirst = await runWorld(modules, { scripts: ALL_SCRIPTS, allowance: 1, scroll: [{ url: "http://static.example.com/own", seen: [SCRIPT_A] }, requestIn("stack", "http://pixel.golf.net/a")] });
  holds("ra4-each-bucket-holds-what-the-world-put-there", stacksOf(ownFirst)[0].notListed === 0 && stacksOf(ownFirst)[0].groups.length === 1, () => ownFirst);
  // A bound reached before the windows is said when a window ran, one or both, and not when none did.
  for (const [ending, said] of [["nothing-to-scroll", true], ["reached-end", true], ["left-before-the-windows", false]] as const) {
    cases += 1;
    const bounded = await runWorld(modules, { scripts: ALL_SCRIPTS, ending, before: hosts(2), maxHosts: 1 });
    holds("ra4-a-host-past-the-bound-is-not-listed-and-is-said", bounded.incomplete.includes("host-bound") === said && isScrollCheckEvidence(bounded), () => ({ ending, bounded }));
  }
  return cases;
}

/** Stack shapes, with what each must publish. The repeat and the fifth host are the publisher's rules, restated: RA3 holds them on their own. */
const STACK_SHAPES: ReadonlyArray<{ frames: readonly string[]; publishes: readonly string[] }> = [
  { frames: [SCRIPT_A], publishes: [HOST_A] },
  { frames: [SCRIPT_B], publishes: [HOST_B] },
  { frames: [SCRIPT_A, SCRIPT_B], publishes: [HOST_A, HOST_B] },
  { frames: [SCRIPT_A, SCRIPT_A, SCRIPT_B], publishes: [HOST_A, HOST_B] },
  { frames: [SCRIPT_A, SCRIPT_B, SCRIPT_C, SCRIPT_D, SCRIPT_E], publishes: [HOST_A, HOST_B, HOST_C, HOST_D] },
  { frames: [SCRIPT_A, SCRIPT_B, SCRIPT_A, SCRIPT_B, SCRIPT_A], publishes: [HOST_A, HOST_B, HOST_A, HOST_B] },
  { frames: [SCRIPT_E, "http://never.requested.net/x.js", SCRIPT_D], publishes: [HOST_E, HOST_D] }
];

/** Up to two requests under each stack shape: every group count, ties included, against the bound of three. */
async function checkGroupBound(modules: Modules): Promise<number> {
  let cases = 0;
  const world = 3 ** STACK_SHAPES.length;
  for (let code = 1; code < world; code += 1) {
    cases += 1;
    const counts = STACK_SHAPES.map((_shape, index) => Math.floor(code / 3 ** index) % 3);
    let serial = 0;
    const scroll = STACK_SHAPES.flatMap((shape, index) => Array.from({ length: counts[index] }, (): WorldRequest => ({ url: `http://pixel.golf.net/hit/${(serial += 1)}`, seen: shape.frames })));
    const evidence = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll });
    const input = () => ({ counts, evidence });
    holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
    const truth = new Map<string, number>();
    STACK_SHAPES.forEach((shape, index) => {
      if (counts[index] > 0) truth.set(JSON.stringify(shape.publishes), (truth.get(JSON.stringify(shape.publishes)) ?? 0) + counts[index]);
    });
    const entry = stacksOf(evidence)[0];
    const total = [...truth.values()].reduce((sum, count) => sum + count, 0);
    const ranked = [...truth.values()].sort((left, right) => right - left);
    holds("ra4-the-group-bound-keeps-the-most-frequent", entry.groups.length === Math.min(3, truth.size) && entry.groups.every((group, index) => group.count === ranked[index]), input);
    holds("ra4-a-listed-group-is-what-the-stack-published", entry.groups.every((group) => truth.get(JSON.stringify(group.hosts)) === group.count), input);
    holds("ra4-the-groups-past-the-bound-are-not-listed", entry.notListed === ranked.slice(3).reduce((sum, count) => sum + count, 0) && entry.requests === total, input);
  }
  return cases;
}

/**
 * Host forms as Node's URL reads them. `published` and `site` are the report's hostname
 * redaction as it stands, spelled out: a reviewed label stays, any other is a marker, a
 * tenant under a private suffix is its own site, and a host with no public boundary is
 * the invalid-host marker. They catch a form that moved, and a move here is an identity
 * question anyway (lib/r2-normalization-identity-ledger.test.ts).
 */
const HOST_FORMS: ReadonlyArray<{ url: string; published: string; site: string }> = [
  { url: "http://cdn.alpha.net/x", published: "cdn.alpha.net", site: "alpha.net" },
  { url: "http://zz.alpha.net/x", published: "{label}.alpha.net", site: "alpha.net" },
  { url: "http://yy.alpha.net/x", published: "{label}.alpha.net", site: "alpha.net" },
  { url: "http://ALPHA.net/x", published: "alpha.net", site: "alpha.net" },
  { url: "http://cdn.alpha.net./x", published: "cdn.alpha.net", site: "alpha.net" },
  { url: "http://cdn.alpha.net../x", published: "cdn.alpha.net", site: "alpha.net" },
  { url: "http://user:pw@cdn.alpha.net:8443/x", published: "cdn.alpha.net", site: "alpha.net" },
  { url: "https://cdn.alpha.net:443/x", published: "cdn.alpha.net", site: "alpha.net" },
  { url: `http://cdn.alpha.net/x?pad=${"x".repeat(2_100)}`, published: "cdn.alpha.net", site: "alpha.net" },
  { url: "http://www.www.alpha.net/x", published: "www.www.alpha.net", site: "alpha.net" },
  { url: "http://_dmarc.alpha.net/x", published: "{label}.alpha.net", site: "alpha.net" },
  { url: `http://${"a.".repeat(100)}alpha.net/x`, published: `${"{label}.".repeat(30)}alpha.net`, site: "alpha.net" },
  { url: `http://${"b".repeat(63)}.alpha.net/x`, published: "{label}.alpha.net", site: "alpha.net" },
  { url: "http://a_b.net/x", published: "a_b.net", site: "a_b.net" },
  { url: "http://12345.net/x", published: "12345.net", site: "12345.net" },
  { url: "http://foo.co.uk/x", published: "foo.co.uk", site: "foo.co.uk" },
  { url: "http://a.foo.co.uk/x", published: "{label}.foo.co.uk", site: "foo.co.uk" },
  { url: "http://bücher.de/x", published: "xn--bcher-kva.de", site: "xn--bcher-kva.de" },
  { url: "http://münchen.bücher.de/x", published: "{label}.xn--bcher-kva.de", site: "xn--bcher-kva.de" },
  { url: "http://foo.рф/x", published: "foo.xn--p1ai", site: "foo.xn--p1ai" },
  { url: "http://foo.onion/x", published: "foo.onion", site: "foo.onion" },
  { url: "http://alice.github.io/x", published: "alice.github.io", site: "alice.github.io" },
  { url: "http://x.alice.github.io/x", published: "{label}.alice.github.io", site: "alice.github.io" },
  { url: "http://www.github.io/x", published: "www.github.io", site: "www.github.io" },
  { url: "http://b.s3.amazonaws.com/x", published: "b.s3.amazonaws.com", site: "b.s3.amazonaws.com" },
  { url: "http://compute.amazonaws.com/x", published: "{label}.amazonaws.com", site: "amazonaws.com" },
  { url: "http://d111.cloudfront.net/x", published: "d111.cloudfront.net", site: "d111.cloudfront.net" },
  { url: "http://0123456789abcdef0123456789abcdef.herokuapp.com/x", published: "{label}.herokuapp.com", site: "{label}.herokuapp.com" },
  { url: "http://fedcba9876543210fedcba9876543210.herokuapp.com/x", published: "{label}.herokuapp.com", site: "{label}.herokuapp.com" },
  { url: "http://93.184.216.34/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://0x7f.1/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://[2001:db8::1]/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://localhost/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://foo.internal/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://github.io/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://co.uk/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://a..alpha.net/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://a~b.alpha.net/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://-a.alpha.net/x", published: "{invalid-host}", site: "{invalid-host}" },
  { url: `http://${"c".repeat(64)}.alpha.net/x`, published: "{invalid-host}", site: "{invalid-host}" },
  { url: "http://{invalid-host}/x", published: "{invalid-host}", site: "{invalid-host}" }
];

/** Frames of scripts no listed host could be: a script can be requested at these, and each names a frame with no host of its own. */
const FRAME_ONLY_FORMS: ReadonlyArray<{ url: string; published: string }> = [
  { url: "blob:http://site.test/1", published: "{invalid-host}" },
  { url: "data:text/javascript,1", published: "{invalid-host}" },
  { url: "about:srcdoc", published: "{invalid-host}" },
  { url: "chrome-extension://abcdef/x.js", published: "{invalid-host}" },
  { url: "webpack://app/x.js", published: "{invalid-host}" },
  { url: "file:///x.js", published: "{invalid-host}" },
  { url: "not an address", published: "{invalid-host}" }
];

/** Each form as the one listed host of the scroll window, in each bucket, and of the window without input. */
async function checkHostFormBuckets(modules: Modules): Promise<number> {
  let cases = 0;
  for (const form of HOST_FORMS) {
    const listed = JSON.stringify([{ site: form.site, hosts: [form.published] }]);
    for (const bucket of BUCKETS.filter((candidate) => candidate !== "unanswered" && candidate !== "past-the-bound")) {
      cases += 1;
      const evidence = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll: [requestIn(bucket, form.url)] });
      const input = () => ({ form: form.url.slice(0, 60), bucket, evidence });
      holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
      holds("ra4-a-listed-host-publishes-as-the-table-says", JSON.stringify(evidence.scroll?.hosts) === listed, input);
      const entry = stacksOf(evidence)[0];
      const has = (candidate: Bucket) => (bucket === candidate ? 1 : 0);
      const groups = bucket === "stack" ? [{ count: 1, hosts: [HOST_A] }] : bucket === "other-stack" ? [{ count: 1, hosts: [HOST_B] }] : [];
      holds(
        "ra4-each-bucket-holds-what-the-world-put-there",
        JSON.stringify(entry.groups) === JSON.stringify(groups) && entry.redirected === has("redirected") && entry.withoutStack === has("without-stack") && entry.withoutNamedScript === has("without-named-script") && entry.unobserved === has("worker"),
        input
      );
    }
    cases += 1;
    const evidence = await runWorld(modules, { scripts: ALL_SCRIPTS, control: [requestIn("stack", form.url)] });
    const input = () => ({ form: form.url.slice(0, 60), evidence });
    holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
    holds("ra4-a-listed-host-publishes-as-the-table-says", JSON.stringify(evidence.control?.hosts) === listed && evidence.scroll?.hostCount === 0, input);
  }
  return cases;
}

/** Every ordered pair of forms as two listed hosts, the first matched by the lists: collisions across sites, merges within one, their order and their labels. */
async function checkHostFormPairs(modules: Modules): Promise<number> {
  let cases = 0;
  for (const first of HOST_FORMS) {
    for (const second of HOST_FORMS) {
      cases += 1;
      const same = first.url === second.url;
      const scroll: WorldRequest[] = same ? [{ ...requestIn("stack", first.url), listMatch: true }] : [{ ...requestIn("stack", first.url), listMatch: true }, { ...requestIn("other-stack", second.url), listMatch: false }];
      const evidence = await runWorld(modules, { scripts: ALL_SCRIPTS, scroll, lists: "compared" });
      const input = () => ({ first: first.url.slice(0, 60), second: second.url.slice(0, 60), evidence });
      holdCarried(evidence, { outcome: "reached-end", scrollRan: true, lists: "compared", labels: true }, input);
      const published = new Set([first.published, second.published]);
      holds("ra4-two-hosts-list-as-their-published-names", evidence.scroll?.hostCount === published.size && stacksOf(evidence).length === published.size, input);
      const requests = stacksOf(evidence).reduce((sum, entry) => sum + entry.requests, 0);
      holds("ra4-the-stacks-count-every-request-of-a-listed-host", requests === scroll.length && evidence.scroll?.requests === scroll.length, input);
      // Two raw hosts that publish as one take the stronger state of the two.
      if (!same) holds("ra4-each-label-is-what-the-world-matched", JSON.stringify(evidence.scroll?.matchedHosts) === JSON.stringify([first.published]) && evidence.scroll?.uncomparedHosts?.length === 0, input);
    }
  }
  return cases;
}

/** Every ordered pair of forms as the two frames of one stack, each requested as a script. */
async function checkFrameForms(modules: Modules): Promise<number> {
  let cases = 0;
  const forms = [...HOST_FORMS, ...FRAME_ONLY_FORMS];
  for (const first of forms) {
    for (const second of forms) {
      cases += 1;
      const evidence = await runWorld(modules, { scripts: [first.url, second.url], scroll: [{ url: "http://pixel.golf.net/hit", seen: [first.url, second.url] }] });
      const input = () => ({ first: first.url.slice(0, 60), second: second.url.slice(0, 60), evidence });
      holdCarried(evidence, { outcome: "reached-end", scrollRan: true }, input);
      const publishes = first.published === second.published ? [first.published] : [first.published, second.published];
      holds("ra4-a-frame-publishes-as-the-table-says", JSON.stringify(stacksOf(evidence)[0].groups) === JSON.stringify([{ count: 1, hosts: publishes }]), input);
    }
  }
  return cases;
}

/** Sizes of the sites a window's hosts belong to: the list bound, each side of it and in the middle of a site. */
const SITE_SIZES: readonly (readonly number[])[] = [
  [],
  [1],
  Array(19).fill(1),
  Array(20).fill(1),
  Array(21).fill(1),
  Array(25).fill(1),
  [19],
  [20],
  [21],
  [25],
  [10, 10],
  [10, 10, 1],
  [11, 11],
  [7, 7, 7],
  [15, 6],
  [20, 1],
  [19, 2],
  [1, 2, 3, 4, 5, 6]
];
// Reviewed labels, so each publishes as itself and none merge.
const LABELS = ["www", "cdn", "api", "img", "static", "assets", "media", "pixel", "video", "images", "ads", "app", "m", "shop", "blog", "news", "metrics", "analytics", "collect", "secure", "files", "auth", "login", "accounts", "mobile"];

/** The list bound, with the window's other counts and each way to have list facts. */
async function checkListBound(modules: Modules): Promise<number> {
  let cases = 0;
  for (const sizes of SITE_SIZES) {
    const hosts = sizes.flatMap((size, site) => Array.from({ length: size }, (_value, index) => `http://${LABELS[index]}.site${String(site).padStart(2, "0")}.net/x`));
    for (const known of [0, 1, 2]) {
      for (const unanswered of [0, 1]) {
        for (const refused of [false, true]) {
          for (const lists of ["none", "unavailable", "compared"] as const) {
            cases += 1;
            const before = hosts.length === 0 && known === 0 ? [] : [{ url: "http://known.tracker.net/before", seen: "no-stack" as const }];
            const scroll: WorldRequest[] = [
              ...hosts.map((url, index): WorldRequest => ({ ...requestIn(index % 2 === 0 ? "stack" : "other-stack", url), listMatch: index % 3 === 0 ? true : index % 3 === 1 ? false : null })),
              ...Array.from({ length: known }, (_value, index): WorldRequest => ({ url: `http://known.tracker.net/again/${index}`, seen: [SCRIPT_A] })),
              ...Array.from({ length: unanswered }, (_value, index): WorldRequest => ({ url: `http://known.tracker.net/silent/${index}`, seen: [SCRIPT_A], answered: false })),
              ...(refused ? [{ url: "http://refused.tracker.net/x", seen: [SCRIPT_A], decision: "refused" as const }] : [])
            ];
            const evidence = await runWorld(modules, { scripts: ALL_SCRIPTS, before, scroll, lists });
            const input = () => ({ sizes, known, unanswered, refused, lists, evidence });
            holdCarried(evidence, { outcome: "reached-end", scrollRan: true, lists, labels: lists !== "none" && hosts.length > 0 }, input);
            const window = evidence.scroll;
            const listed = Math.min(hosts.length, 20);
            holds("ra4-the-list-bound-lists-twenty-and-counts-all", window?.hostCount === hosts.length && window.siteCount === sizes.length && stacksOf(evidence).length === listed, input);
            holds("ra4-the-window-counts-what-the-world-counted", window?.requests === hosts.length + known && window.knownHostRequests === known && window.unanswered === (unanswered > 0 ? unanswered : undefined), input);
            holds("ra4-the-check-says-what-cut-it", (evidence.incomplete.includes("refused")) === refused, input);
            if (lists === "compared" && hosts.length > 0) {
              const truth = (state: number) => hosts.flatMap((url, index) => (index % 3 === state ? [new URL(url).hostname] : []));
              const order = (window?.hosts ?? []).flatMap((group) => group.hosts);
              const inOrder = (names: readonly string[]) => order.filter((host) => names.includes(host));
              holds("ra4-each-label-is-what-the-world-matched", JSON.stringify(window?.matchedHosts) === JSON.stringify(inOrder(truth(0))) && JSON.stringify(window?.uncomparedHosts) === JSON.stringify(inOrder(truth(2))), input);
            }
          }
        }
      }
    }
  }
  return cases;
}

const GA4 = (host: string, name: string) => `http://${host}/g/collect?v=2&tid=G-ABC&en=${name}`;
const ADOBE = (host: string) => `http://${host}/b/ss/suite/1/JS-2.22.0?pe=lnk_o&pev2=${"name"}`;

type Ending = { world: World; outcome: ScrollCheckOutcome; screens: number; scrollRan: boolean; controlRan: boolean };

function endings(): Ending[] {
  const all: Ending[] = [
    { world: { subjectAvailable: false }, outcome: "not-run", screens: 0, scrollRan: false, controlRan: false },
    { world: { ending: "nothing-to-scroll" }, outcome: "nothing-to-scroll", screens: 0, scrollRan: false, controlRan: true },
    { world: { ending: "locked-at-once" }, outcome: "locked", screens: 0, scrollRan: false, controlRan: true },
    { world: { ending: "stuck-at-once" }, outcome: "did-not-move", screens: 0, scrollRan: false, controlRan: true },
    { world: { screens: 9, ending: "did-not-move" }, outcome: "depth-limit", screens: 8, scrollRan: true, controlRan: true },
    { world: { ending: "left-before-the-windows" }, outcome: "left-site", screens: 0, scrollRan: false, controlRan: false },
    { world: { ending: "left-in-the-window-without-input" }, outcome: "left-site", screens: 0, scrollRan: false, controlRan: false },
    { world: { ending: "cancelled" }, outcome: "cut-short", screens: 0, scrollRan: false, controlRan: true },
    { world: { screens: 1, ending: "grows-by-a-pixel" }, outcome: "reached-end", screens: 2, scrollRan: true, controlRan: true }
  ];
  for (const screens of [1, 2]) {
    all.push({ world: { screens, ending: "left-at-the-scroll-window-s-end" }, outcome: "left-site", screens, scrollRan: false, controlRan: true });
    all.push({ world: { screens, ending: "refused-scroll" }, outcome: "cut-short", screens: screens - 1, scrollRan: false, controlRan: true });
    all.push({ world: { screens, ending: "refused-scroll-back" }, outcome: "cut-short", screens, scrollRan: false, controlRan: true });
    all.push({ world: { screens, ending: "state-throws" }, outcome: "cut-short", screens: screens - 1, scrollRan: false, controlRan: true });
    all.push({ world: { screens, ending: "state-throws-leaving" }, outcome: "left-site", screens: screens - 1, scrollRan: false, controlRan: true });
  }
  for (let screens = 1; screens <= 8; screens += 1) {
    all.push({ world: { screens }, outcome: "reached-end", screens, scrollRan: true, controlRan: true });
    all.push({ world: { screens, ending: "left-site" }, outcome: "left-site", screens: screens - 1, scrollRan: false, controlRan: true });
    all.push({ world: { screens, ending: "unreadable" }, outcome: "cut-short", screens: screens - 1, scrollRan: false, controlRan: true });
    if (screens === 8) continue;
    all.push({ world: { screens, ending: "locked" }, outcome: "locked", screens, scrollRan: true, controlRan: true });
    all.push({ world: { screens, ending: "did-not-move" }, outcome: "did-not-move", screens, scrollRan: true, controlRan: true });
  }
  return all;
}

/** Each of these endings, with a request in each window, and with list facts, a beacon, a used-up budget and a changed address in each. */
async function checkOutcomes(modules: Modules): Promise<number> {
  let cases = 0;
  for (const ending of endings()) {
    for (const lists of ["none", "unavailable", "compared"] as const) {
      for (const beacons of BOTH) {
        for (const budgets of BOTH) {
          for (const addressChanges of BOTH) {
            cases += 1;
            const control: WorldRequest[] = [
              { url: "http://api.kilo.net/timer", seen: [SCRIPT_A], listMatch: false },
              ...(beacons ? [{ url: GA4("tally.lima.net", "page_view"), seen: [SCRIPT_A], listMatch: true, body: "" }] : [])
            ];
            const scroll: WorldRequest[] = [
              { url: "http://pixel.golf.net/hit", seen: [SCRIPT_B], listMatch: true },
              ...(beacons ? [{ url: ADOBE("metrics.mike.net"), seen: [SCRIPT_B], listMatch: null, body: "" }] : [])
            ];
            const world: World = { ...ending.world, scripts: ALL_SCRIPTS, control, scroll, lists, visitBudgetUsedUp: budgets, proxyLoss: budgets ? "in-the-check" : undefined, addressChanges };
            const evidence = await runWorld(modules, world);
            const input = () => ({ ending: ending.world, lists, beacons, budgets, addressChanges, evidence });
            holdCarried(evidence, { outcome: ending.outcome, scrollRan: ending.scrollRan, lists, labels: lists !== "none" && ending.controlRan, events: beacons && ending.controlRan }, input);
            holds("ra4-the-check-says-how-far-it-scrolled", evidence.screens === ending.screens, input);
            holds("ra4-the-check-keeps-its-window-without-input", (evidence.control !== null) === ending.controlRan, input);
            // One request in the window without input and one while scrolling, and a beacon in each if it was sent.
            const perWindow = 1 + (beacons ? 1 : 0);
            if (ending.controlRan) holds("ra4-each-window-counts-its-own-requests", evidence.control?.requests === perWindow && (!ending.scrollRan || evidence.scroll?.requests === perWindow), input);
            holds("ra4-the-check-says-the-address-changed", evidence.addressChanged === (ending.scrollRan && addressChanges), input);
            if (ending.controlRan) holds("ra4-the-check-says-what-cut-it", evidence.incomplete.includes("visit-budget") === budgets && evidence.incomplete.includes("proxy-budget") === budgets, input);
          }
        }
      }
    }
  }
  return cases;
}

const stacksPath = require.resolve("./scroll-check-stacks");
const checkPath = require.resolve("./scroll-check");
const withStacks = (...edits: SourceEdit[]): Modules => ({ ...PRODUCTION, ScrollCheckStackRecorder: loadVariant<Pick<Modules, "ScrollCheckStackRecorder">>(stacksPath, edits).ScrollCheckStackRecorder });
const withCheck = (...edits: SourceEdit[]): Modules => {
  const check = loadVariant<Pick<Modules, "ScrollCheckRecorder" | "runScrollCheck">>(checkPath, edits);
  return { ...PRODUCTION, ScrollCheckRecorder: check.ScrollCheckRecorder, runScrollCheck: check.runScrollCheck };
};

test("RA4: every bucket and every subset of them leaves the check its stacks", async () => {
  // 256 subsets, less the empty one and the one with only an unanswered request, in 4 URL forms.
  assert.equal(await checkBuckets(PRODUCTION), (256 - 2) * 4);
});

test("RA4: the worlds the counting rule turns on say what their windows should", async () => {
  assert.equal(await checkCountingWorlds(PRODUCTION), 10);
});

test("RA4: a fact that throws costs the check that fact's part and no other", async () => {
  assert.equal(await checkThrowingFacts(PRODUCTION), 7);
});

test("RA4: what a window does not count, around what it does, leaves the check whole and counted", async () => {
  assert.equal(await checkUncounted(PRODUCTION), 64 * 6 * 2 * 2);
});

test("RA4: past each of the recorders' bounds the check stays whole, and loses its stacks only for a report it lost", async () => {
  // Bounds of 1 to 3 by 0 to 4 hosts on two bounds, then past the scripts, past the tracked drops, a URL dropped twice, 2 at the tracked bound, the site's own and 3 endings.
  assert.equal(await checkRecorderBounds(PRODUCTION), 3 * 5 * 2 + 2 + 1 + 2 + 1 + 3);
});

test("RA4: every count of every stack shape leaves the check its stacks, whatever the group bound keeps", async () => {
  assert.equal(await checkGroupBound(PRODUCTION), 3 ** STACK_SHAPES.length - 1);
});

test("RA4: every host form in the table leaves the check its stacks, as a listed host, a pair of them, and a pair of frames", async () => {
  assert.equal(HOST_FORMS.length, 41);
  assert.equal(FRAME_ONLY_FORMS.length, 7);
  assert.equal(await checkHostFormBuckets(PRODUCTION), 41 * (6 + 1));
  assert.equal(await checkHostFormPairs(PRODUCTION), 41 * 41);
  assert.equal(await checkFrameForms(PRODUCTION), 48 * 48);
});

test("RA4: the list bound, with the window's other counts and each way to have list facts, leaves the check whole", async () => {
  assert.equal(await checkListBound(PRODUCTION), SITE_SIZES.length * 3 * 2 * 2 * 3);
});

test("RA4: each ending validates and keeps what it earned", async () => {
  assert.equal(endings().length, 9 + 2 * 5 + 8 * 3 + 7 * 2);
  assert.equal(await checkOutcomes(PRODUCTION), endings().length * 3 * 2 * 2 * 2);
});

/**
 * Open (RA4), pinned as what happens and not as what should. A frame's URL names a host
 * the validator refuses, so isStackGroup refuses the group and withCallStacks drops
 * every stack of every host of the check, with no reason given. It needs no answer: a
 * page requests a script at the address, the scanner refuses it, and a script it evals
 * takes that address as its sourceURL, which names a frame. Real Chromium 153 keeps the
 * host and sends that frame (a probe on 2026-11-01 at 153.0.8010.12, not a fixture). The stacks are
 * ephemeral and nothing else moves: a page can hide its stacks this way, and no count is
 * wrong. Whether and where to change that is the owner's call.
 */
test("open (RA4): one frame on a host with a leading dot costs the whole check its stacks", async () => {
  const dotted = "http://.alpha.net/s.js";
  const scroll: WorldRequest[] = [{ url: "http://pixel.golf.net/hit", seen: [dotted] }, requestIn("stack", "http://pixel.hotel.net/hit")];
  const evidence = await runWorld(PRODUCTION, { scripts: [...ALL_SCRIPTS, dotted], scroll });
  assert.equal(isScrollCheckEvidence(evidence), true);
  assert.deepEqual([evidence.outcome, evidence.scroll?.hostCount, evidence.scroll?.requests, evidence.scroll?.stacks], ["reached-end", 2, 2, undefined]);
  const without = await runWorld(PRODUCTION, { scripts: ALL_SCRIPTS, scroll: [{ url: "http://pixel.golf.net/hit", seen: [SCRIPT_A] }, requestIn("stack", "http://pixel.hotel.net/hit")] });
  assert.equal(without.scroll?.stacks?.length, 2);
});

/**
 * Open (RA4), pinned the same way. These reach the window itself, so isWindow refuses it
 * and the whole check becomes a bare cut-short: no windows, no lists. A host with a
 * leading dot publishes with it. Spelling the marker gets a site of its own, so
 * `{label}.alpha.net` is listed under two sites beside a host that publishes as it.
 * Chromium keeps both hosts, but a listed host must be sent and answered, and whether
 * the scanner's public-address check ever lets one through (a wildcard DNS name could) is
 * not measured. Whether and where to change that is the owner's call.
 */
test("open (RA4): a listed host the validator refuses turns the whole check into a bare cut-short", async () => {
  const bare = { outcome: "cut-short", screens: 0, control: null, scroll: null, incomplete: [], addressChanged: false };
  for (const scroll of [
    [requestIn("stack", "http://.alpha.net/x")],
    [requestIn("stack", "http://..alpha.net/x")],
    [requestIn("stack", "http://{label}.alpha.net/x"), requestIn("stack", "http://zz.alpha.net/x")]
  ]) {
    assert.deepEqual(await runWorld(PRODUCTION, { scripts: ALL_SCRIPTS, scroll }), bare, JSON.stringify(scroll));
  }
});

const GROUPS_TAKEN = "ranked.slice(0, scroll_check_evidence_1.MAX_SCROLL_CHECK_STACK_GROUPS)";
const GROUPS_LEFT = "ranked.slice(scroll_check_evidence_1.MAX_SCROLL_CHECK_STACK_GROUPS)";
const STACK_GUARD = "const carried = Object.assign(Object.assign({}, evidence), { scroll: Object.assign(Object.assign({}, evidence.scroll), { stacks: entries }) });\n        return (0, scroll_check_evidence_1.isScrollCheckEvidence)(carried) ? carried : evidence;";
const NO_STACK_GUARD = "return Object.assign(Object.assign({}, evidence), { scroll: Object.assign(Object.assign({}, evidence.scroll), { stacks: entries }) });";
// Each guard that swallows a refusal, so a variant it hides is also tried with it gone.
const NO_WINDOW_GUARD: SourceEdit = { find: "if (!(0, scroll_check_evidence_1.isScrollCheckEvidence)(evidence)) {", replace: "if (false) {" };
const NO_EVENTS_GUARD: SourceEdit = { find: "if (!(0, scroll_check_evidence_1.isScrollCheckEvidence)(carried))\n            return { evidence };\n", replace: "" };
const NO_LABELS_GUARD: SourceEdit = {
  find: '{ filterLists: "unavailable" });\n        return (0, scroll_check_evidence_1.isScrollCheckEvidence)(carried) ? carried : evidence;',
  replace: '{ filterLists: "unavailable" });\n        return carried;'
};
const TWENTY_ONE: SourceEdit = { find: "let remaining = scroll_check_evidence_1.MAX_SCROLL_CHECK_LISTED_HOSTS;", replace: "let remaining = 21;" };
const SMALLEST_FIRST: SourceEdit = { find: "right.hosts.length - left.hosts.length", replace: "left.hosts.length - right.hosts.length" };
const LABELS_OUT_OF_ORDER: SourceEdit = { find: 'uncomparedHosts: order.filter((host) => stateOf(host) === "not-compared")', replace: 'uncomparedHosts: order.filter((host) => stateOf(host) === "not-compared").reverse()' };
const EVENTS_OF_THE_OTHER: SourceEdit = { find: "const scroll = part(evidence.scroll, requests.scroll);", replace: "const scroll = part(evidence.scroll, requests.scroll) || control;" };
const FOUR_GROUPS: SourceEdit[] = [
  { find: GROUPS_TAKEN, replace: "ranked.slice(0, 4)" },
  { find: GROUPS_LEFT, replace: "ranked.slice(4)" }
];

for (const [name, property, check, modules] of [
  ["the recorder lists a fourth group", "ra4-the-check-keeps-its-stacks", checkGroupBound, () => withStacks(...FOUR_GROUPS)],
  [
    "the recorder lists a fourth group, and no guard stands in the way",
    "ra4-what-the-check-returns-validates",
    checkGroupBound,
    () => ({ ...withStacks(...FOUR_GROUPS), runScrollCheck: withCheck({ find: STACK_GUARD, replace: NO_STACK_GUARD }).runScrollCheck, ScrollCheckRecorder: withCheck({ find: STACK_GUARD, replace: NO_STACK_GUARD }).ScrollCheckRecorder })
  ],
  ["the groups past the third vanish from the count", "ra4-the-check-keeps-its-stacks", checkGroupBound, () => withStacks({ find: "notListed += group.count;", replace: "notListed += 0;" })],
  ["a stack repeats its hosts", "ra4-the-check-keeps-its-stacks", checkGroupBound, () => withStacks({ find: "hosts: [...stack.hosts]", replace: "hosts: [...stack.hosts, ...stack.hosts]" })],
  ["the groups listed are the least frequent", "ra4-the-group-bound-keeps-the-most-frequent", checkGroupBound, () => withStacks({ find: GROUPS_TAKEN, replace: "ranked.slice(-scroll_check_evidence_1.MAX_SCROLL_CHECK_STACK_GROUPS)" }, { find: GROUPS_LEFT, replace: "ranked.slice(0, -scroll_check_evidence_1.MAX_SCROLL_CHECK_STACK_GROUPS)" })],
  ["a group publishes its stack the wrong way round", "ra4-a-listed-group-is-what-the-stack-published", checkGroupBound, () => withStacks({ find: "hosts: [...stack.hosts]", replace: "hosts: [...stack.hosts].reverse()" })],
  [
    "the groups past the third read as never observed",
    "ra4-the-groups-past-the-bound-are-not-listed",
    checkGroupBound,
    () => withStacks({ find: "notListed,\n", replace: "notListed: tally.notListed,\n" }, { find: "unobserved: tally.unobserved\n", replace: "unobserved: tally.unobserved + notListed - tally.notListed\n" })
  ],
  ["an entry counts requests the window did not", "ra4-the-check-keeps-its-stacks", checkBuckets, () => withStacks({ find: "requests: entry.requests.filter((request) => request.counted).length", replace: "requests: entry.requests.length" })],
  ["a redirect reads as no stack, and no stack as a redirect", "ra4-each-bucket-holds-what-the-world-put-there", checkBuckets, () => withStacks({ find: "redirected: tally.redirected,\n            withoutStack: tally.withoutStack,", replace: "redirected: tally.withoutStack,\n            withoutStack: tally.redirected," })],
  ["an observation past the bound reads as never observed", "ra4-each-bucket-holds-what-the-world-put-there", checkBuckets, () => withStacks({ find: "this.noteDropped(observed.key);", replace: "" })],
  ["the window counts what was not answered", "ra4-the-window-counts-what-the-world-counted", checkBuckets, () => withCheck({ find: "if (counted)\n                    requests += 1;", replace: "if (countable)\n                    requests += 1;" })],
  ["the window forgets what was not answered", "ra4-the-window-counts-what-the-world-counted", checkBuckets, () => withCheck({ find: "unanswered += 1;", replace: "unanswered += 0;" })],
  ["a navigation counts as a request", "ra4-the-window-counts-what-the-world-counted", checkUncounted, () => withCheck({ find: "const countable = sent && !entry.navigation && (0, domain_utils_1.isThirdParty)(input.firstPartyHostname, entry.host);", replace: "const countable = sent && (0, domain_utils_1.isThirdParty)(input.firstPartyHostname, entry.host);" })],
  ["the site's own requests count", "ra4-the-window-counts-what-the-world-counted", checkUncounted, () => withCheck({ find: "const countable = sent && !entry.navigation && (0, domain_utils_1.isThirdParty)(input.firstPartyHostname, entry.host);", replace: "const countable = sent && !entry.navigation;" })],
  ["a first request the scanner refused still lists its host", "ra4-a-host-is-listed-only-if-its-first-request-could-count", checkUncounted, () => withCheck({ find: 'raw = { firstSent: countable, counted: false, lists: "not-compared" };', replace: 'raw = { firstSent: true, counted: false, lists: "not-compared" };' })],
  ["a request held by the allowance is not said", "ra4-the-check-says-what-cut-it", checkUncounted, () => withCheck({ find: 'reasons.add("check-allowance");', replace: "void 0;" })],
  ["a host past the bound is forgotten in silence", "ra4-a-host-past-the-bound-is-not-listed-and-is-said", checkRecorderBounds, () => withCheck({ find: "if (this.firstSeen.size >= this.maxHosts) {\n                        this.boundReached = true;\n", replace: "if (this.firstSeen.size >= this.maxHosts) {\n" })],
  ["a report past the window's bound keeps the stacks", "ra4-the-check-keeps-its-stacks", checkRecorderBounds, () => withCheck({ find: "!this.reportLost", replace: "true" })],
  ["a request past the window's bound is kept anyway", "ra4-the-check-keeps-its-stacks", checkRecorderBounds, () => withCheck({ find: "if (this.entries.length >= this.maxWindowRequests) {", replace: "if (false) {" })],
  ["a host past the bound is listed anyway", "ra4-a-host-past-the-bound-is-not-listed-and-is-said", checkRecorderBounds, () => withCheck({ find: "if (this.firstSeen.size >= this.maxHosts) {", replace: "if (false) {" })],
  ["a window counts the other's requests", "ra4-each-window-counts-its-own-requests", checkOutcomes, () => withCheck({ find: "if (entry.at < interval.start || entry.at >= interval.end)\n                    continue;\n", replace: "" })],
  ["a listed host is published raw", "ra4-a-listed-host-publishes-as-the-table-says", checkHostFormBuckets, () => withCheck({ find: "const published = (0, redaction_v2_1.redactHostnameV2)(host).value;", replace: "const published = host;" })],
  ["a site is published raw", "ra4-the-check-keeps-its-outcome-and-windows", checkHostFormBuckets, () => withCheck({ find: "const site = (0, redaction_v2_1.redactHostnameV2)((0, domain_utils_1.partyKey)(host)).value;", replace: "const site = (0, domain_utils_1.partyKey)(host);" })],
  ["two hosts that publish apart list as one", "ra4-two-hosts-list-as-their-published-names", checkHostFormPairs, () => withCheck({ find: "const published = (0, redaction_v2_1.redactHostnameV2)(host).value;", replace: 'const published = (0, redaction_v2_1.redactHostnameV2)(host).value.replace(/^cdn\\./, "{label}.");' })],
  ["a raw host that publishes as another lists as itself", "ra4-the-check-keeps-its-outcome-and-windows", checkHostFormPairs, () => withCheck({ find: "const published = (0, redaction_v2_1.redactHostnameV2)(host).value;", replace: "const published = host;" })],
  ["a merged host's label reads only its last raw host", "ra4-each-label-is-what-the-world-matched", checkHostFormPairs, () => withCheck({ find: "(0, scroll_check_evidence_1.strongerScrollCheckListState)(state, (_b = (_a = firstContactedRaw.get(raw))", replace: "(0, scroll_check_evidence_1.strongerScrollCheckListState)(\"not-compared\", (_b = (_a = firstContactedRaw.get(raw))" })],
  ["a listed host stands for only its last raw host", "ra4-the-stacks-count-every-request-of-a-listed-host", checkHostFormPairs, () => withCheck({ find: "const raws = (_d = rawHostsOf.get(published)) !== null && _d !== void 0 ? _d : new Set();", replace: "const raws = new Set();" })],
  ["the entries are not in the listed order", "ra4-the-check-keeps-its-stacks", checkHostFormPairs, () => withCheck({ find: "listed: listed.hosts\n                        .flatMap((group) => group.hosts)\n", replace: "listed: listed.hosts\n                        .flatMap((group) => group.hosts)\n                        .reverse()\n" })],
  ["a stack keeps only its innermost frame's host", "ra4-a-frame-publishes-as-the-table-says", checkFrameForms, () => withStacks({ find: "hosts: [...stack.hosts]", replace: "hosts: [stack.hosts[0]]" })],
  ["sites are listed the smallest first", "ra4-the-check-keeps-its-outcome-and-windows", checkListBound, () => withCheck(SMALLEST_FIRST)],
  ["sites are listed the smallest first, and no guard stands in the way", "ra4-what-the-check-returns-validates", checkListBound, () => withCheck(SMALLEST_FIRST, NO_WINDOW_GUARD)],
  ["twenty-one hosts are listed", "ra4-the-check-keeps-its-outcome-and-windows", checkListBound, () => withCheck(TWENTY_ONE)],
  ["twenty-one hosts are listed, and no guard stands in the way", "ra4-what-the-check-returns-validates", checkListBound, () => withCheck(TWENTY_ONE, NO_WINDOW_GUARD)],
  ["the host count stops at the list, and so the validator refuses the sites", "ra4-the-check-keeps-its-outcome-and-windows", checkListBound, () => withCheck({ find: "hostCount: sites.reduce((sum, entry) => sum + entry.hosts.length, 0),", replace: "hostCount: hosts.reduce((sum, entry) => sum + entry.hosts.length, 0)," })],
  [
    "the host count and the site count both stop at the list",
    "ra4-the-list-bound-lists-twenty-and-counts-all",
    checkListBound,
    () => withCheck({ find: "hostCount: sites.reduce((sum, entry) => sum + entry.hosts.length, 0),", replace: "hostCount: hosts.reduce((sum, entry) => sum + entry.hosts.length, 0)," }, { find: "siteCount: sites.length", replace: "siteCount: hosts.length" })
  ],
  ["the site count stops at the list", "ra4-the-list-bound-lists-twenty-and-counts-all", checkListBound, () => withCheck({ find: "siteCount: sites.length", replace: "siteCount: hosts.length" })],
  ["a site's hosts stay in arrival order", "ra4-the-check-keeps-its-outcome-and-windows", checkListBound, () => withCheck({ find: "hosts: [...hosts].sort(compareText)", replace: "hosts: [...hosts]" })],
  ["known-host requests are counted twice", "ra4-the-check-keeps-its-outcome-and-windows", checkListBound, () => withCheck({ find: "knownHostRequests += 1;", replace: "knownHostRequests += 2;" })],
  ["known-host requests are left out of the count", "ra4-the-window-counts-what-the-world-counted", checkListBound, () => withCheck({ find: "knownHostRequests += 1;", replace: "knownHostRequests += 0;" })],
  ["a refused request is not said", "ra4-the-check-says-what-cut-it", checkListBound, () => withCheck({ find: 'reasons.add("refused");', replace: "void 0;" })],
  ["the matched hosts are those with no match", "ra4-each-label-is-what-the-world-matched", checkListBound, () => withCheck({ find: 'stateOf(host) === "matched"', replace: 'stateOf(host) === "no-match"' })],
  ["a window's labels are out of the listed order", "ra4-the-check-keeps-its-labels", checkListBound, () => withCheck(LABELS_OUT_OF_ORDER)],
  ["a window's labels are out of the listed order, and no guard stands in the way", "ra4-what-the-check-returns-validates", checkListBound, () => withCheck(LABELS_OUT_OF_ORDER, NO_LABELS_GUARD)],
  ["a window that did not run is handed the other's events", "ra4-the-check-keeps-its-events", checkOutcomes, () => withCheck(EVENTS_OF_THE_OTHER)],
  ["a window that did not run is handed the other's events, and no guard stands in the way", "ra4-what-the-check-returns-validates", checkOutcomes, () => withCheck(EVENTS_OF_THE_OTHER, NO_EVENTS_GUARD)],
  ["the evidence counts one screen too many", "ra4-the-check-says-how-far-it-scrolled", checkOutcomes, () => withCheck({ find: "screens: progress.screens,", replace: "screens: progress.screens > 0 && progress.screens < 8 ? progress.screens + 1 : progress.screens," })],
  ["the window without input is dropped", "ra4-the-check-keeps-its-window-without-input", checkOutcomes, () => withCheck({ find: "control: windows.control,", replace: "control: null," })],
  ["a changed address is not said", "ra4-the-check-says-the-address-changed", checkOutcomes, () => withCheck({ find: "addressChanged: progress.screens > 0 && progress.addressChanged", replace: "addressChanged: false" })],
  ["a used-up visit budget is not said", "ra4-the-check-says-what-cut-it", checkOutcomes, () => withCheck({ find: 'reasons.add("visit-budget");', replace: "" })],
  ["the scroll window is never carried", "ra4-the-check-keeps-its-outcome-and-windows", checkOutcomes, () => withCheck({ find: "scroll: progress.screens > 0 ? windows.scroll : null,", replace: "scroll: null," })],
  ["a request keyed by its raw address misses its observation", "ra4-each-bucket-holds-what-the-world-put-there", checkBuckets, () => withStacks({ find: "const key = (0, call_stack_publisher_1.heldUrlKey)(request.url);", replace: "const key = request.url;" })],
  ["a listed host also stands for a raw host whose first request did not list it", "ra4-a-listed-host-stands-only-for-what-listed-it", checkCountingWorlds, () => withCheck({ find: "if (!raw.firstSent || !raw.counted)\n                    continue;\n", replace: "{ const p = (0, redaction_v2_1.redactHostnameV2)(host).value; const rs = rawHostsOf.get(p) ?? new Set(); rs.add(host); rawHostsOf.set(p, rs); }\n                if (!raw.firstSent || !raw.counted)\n                    continue;\n" })],
  ["labels read requests the window did not count", "ra4-each-label-is-what-the-world-matched", checkCountingWorlds, () => withCheck({ find: "if (!counted)\n                    continue;\n                raw.counted = true;", replace: "if (compared)\n                    raw.lists = (0, scroll_check_evidence_1.strongerScrollCheckListState)(raw.lists, (0, scroll_check_evidence_1.scrollCheckListState)(listMatchOf(entry.request)));\n                if (!counted)\n                    continue;\n                raw.counted = true;" })],
  ["a host's label is its last counted request's", "ra4-each-label-is-what-the-world-matched", checkCountingWorlds, () => withCheck({ find: "raw.lists = (0, scroll_check_evidence_1.strongerScrollCheckListState)(raw.lists, (0, scroll_check_evidence_1.scrollCheckListState)(listMatchOf(entry.request)));", replace: "raw.lists = (0, scroll_check_evidence_1.scrollCheckListState)(listMatchOf(entry.request));" })],
  ["a host first seen with no window open lists from a later request", "ra4-a-host-is-listed-only-if-its-first-request-could-count", checkCountingWorlds, () => withCheck({ find: "if (this.firstEntries.get(entry.host) !== entry)\n                        continue;\n", replace: "" })],
  ["an unanswered first-party beacon is not said", "ra4-the-window-counts-what-the-world-counted", checkCountingWorlds, () => withCheck({ find: "if (!answered && (countable || beacon))", replace: "if (!answered && countable)" })],
  ["a redirect hop is a beacon", "ra4-a-redirect-hop-is-no-beacon", checkCountingWorlds, () => withCheck({ find: "const beacon = facts.postData !== undefined && sent && !entry.navigation && !entry.redirected && ", replace: "const beacon = facts.postData !== undefined && sent && !entry.navigation && " })],
  ["a URL observed too often counts what the window did not, as unobserved", "ra4-the-check-keeps-its-stacks", checkCountingWorlds, () => withStacks({ find: "tally.unobserved += counted.filter(Boolean).length;", replace: "tally.unobserved += counted.length;" })],
  ["the check never tells the stacks the window ended", "ra4-a-script-requested-after-the-window-names-no-frame", checkCountingWorlds, () => withCheck({ find: "(_b = run.stacks) === null || _b === void 0 ? void 0 : _b.windowEnded();", replace: "void 0;" })],
  ["a script requested after the window names frames", "ra4-a-script-requested-after-the-window-names-no-frame", checkCountingWorlds, () => withStacks({ find: "if (observed.code && this.notingCode)", replace: "if (observed.code)" })],
  ["a URL dropped twice counts once", "ra4-each-bucket-holds-what-the-world-put-there", checkRecorderBounds, () => withStacks({ find: "this.dropped.set(key, count + 1);", replace: "this.dropped.set(key, 1);" })],
  ["the URLs whose drops are counted run one past their bound", "ra4-each-bucket-holds-what-the-world-put-there", checkRecorderBounds, () => withStacks({ find: "else if (this.dropped.size < MAX_DROPPED_URLS) {", replace: "else if (this.dropped.size <= MAX_DROPPED_URLS) {" })],
  ["the site's own observations spend the allowance", "ra4-each-bucket-holds-what-the-world-put-there", checkRecorderBounds, () => withStacks({ find: "if (host === null || !(0, domain_utils_1.isThirdParty)(this.keepingFor, host))", replace: "if (host === null)" })],
  ["an uncounted request takes no observation", "ra4-an-uncounted-request-keeps-its-own-observation", checkCountingWorlds, () => withCheck({ find: "if (collect) {\n                    const own", replace: "if (collect && counted) {\n                    const own" })],
  ["the bound is said only when both windows ran", "ra4-a-host-past-the-bound-is-not-listed-and-is-said", checkRecorderBounds, () => withCheck({ find: "if (this.boundReached && (input.control || input.scroll))", replace: "if (this.boundReached && input.control && input.scroll)" })],
  ["the bound is said with no window", "ra4-a-host-past-the-bound-is-not-listed-and-is-said", checkRecorderBounds, () => withCheck({ find: "if (this.boundReached && (input.control || input.scroll))", replace: "if (this.boundReached)" })],
  ["a list fact that threw still labels the check", "ra4-a-fact-that-throws-costs-only-its-own-part", checkThrowingFacts, () => withCheck({ find: "listFacts !== undefined && !listsBroken", replace: "listFacts !== undefined" })],
  ["an address it could not read keeps the stacks", "ra4-the-check-keeps-its-stacks", checkThrowingFacts, () => withCheck({ find: "// A request this recorder could not read is a request it lost.\n                this.boundReached = true;\n                this.reportLost = true;", replace: "this.boundReached = true;" })],
  ["a proxy loss from before the check is charged to it", "ra4-the-check-says-what-cut-it", checkThrowingFacts, () => withCheck({ find: "if (safeCount(run.proxyLossCount) > proxyLossBefore)", replace: "if (safeCount(run.proxyLossCount) > 0)" })],
  ["reached-end on a page that just grew", "ra4-the-check-says-how-far-it-scrolled", checkOutcomes, () => withCheck({ find: " && state.height <= before.height) {", replace: ") {" })],
  ["a refused scroll goes on", "ra4-the-check-keeps-its-outcome-and-windows", checkOutcomes, () => withCheck({ find: "if (!(await withinDeadline(page.scrollTo(before.top + before.viewport))))\n            throw new ScrollCheckStop(\"cut-short\");", replace: "await withinDeadline(page.scrollTo(before.top + before.viewport));" })],
  ["a refused scroll back goes on", "ra4-the-check-keeps-its-outcome-and-windows", checkOutcomes, () => withCheck({ find: "if (!(await withinDeadline(page.scrollTo(0))))\n            throw new ScrollCheckStop(\"cut-short\");", replace: "await withinDeadline(page.scrollTo(0));" })],
  ["a page gone in the window without input keeps that window", "ra4-the-check-keeps-its-window-without-input", checkOutcomes, () => withCheck({ find: "await waitUntil(controlStart + timing.controlWindowMs);\n    onSite();", replace: "await waitUntil(controlStart + timing.controlWindowMs);" })],
  ["a page gone after its last screen keeps the scroll window", "ra4-the-check-keeps-its-outcome-and-windows", checkOutcomes, () => withCheck({ find: "await waitUntil(scrollStart + timing.scrollWindowMs);\n    onSite();", replace: "await waitUntil(scrollStart + timing.scrollWindowMs);" })]
] as ReadonlyArray<readonly [string, string, (modules: Modules) => Promise<number>, () => Modules]>) {
  test(`RA4 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => check(modules()));
  });
}
