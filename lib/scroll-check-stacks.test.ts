import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REQUESTED_CODE_URLS } from "./call-stack-publisher";
import { redactHostnameV2 } from "./redaction-v2";
import {
  runScrollCheck,
  SCROLL_CHECK_REQUEST_ALLOWANCE,
  SCROLL_CHECK_STACK_LEAD_MS,
  SCROLL_CHECK_TIMING,
  ScrollCheckRecorder,
  type ScrollCheckRouteDecision,
  type ScrollCheckRun,
  type ScrollState
} from "./scroll-check";
import {
  isScrollCheckEvidence,
  MAX_SCROLL_CHECK_STACK_GROUPS,
  type ScrollCheckEvidence,
  type ScrollCheckHostStacks,
  type ScrollCheckScrollWindow
} from "./scroll-check-evidence";
import { ScrollCheckStackRecorder } from "./scroll-check-stacks";
import { scrollCheckStacksCopy } from "./scroll-check-stacks-copy";

/**
 * A check's call-stack hosts over the real check (runScrollCheck, its
 * recorder and its stack recorder) on a scripted page and a virtual clock:
 * `sleep` advances time at once, delivering, in time order, the page's own
 * request events and the session's Chromium-shaped observations scheduled
 * inside each interval, so which request lands in which window, and when its
 * observation arrives, can be pinned exactly.
 */

type FakeRequest = { url: string; navigation?: boolean; redirected?: boolean };

type Scheduled =
  | { at: number; page: string; decision?: ScrollCheckRouteDecision | null; navigation?: boolean; redirected?: boolean }
  | { at: number; cdp: Record<string, unknown> };

const NAV = 1_000_000;
const CONTROL_START = NAV + SCROLL_CHECK_TIMING.settleAfterNavigationMs;
const SCROLL_START = CONTROL_START + SCROLL_CHECK_TIMING.controlWindowMs;
const SCROLL_END = SCROLL_START + SCROLL_CHECK_TIMING.scrollWindowMs;

const LOADER = "http://cdn.alpha.net/loader.js";
const TAG = "http://static.bravo.org/tag.js";

let nextId = 1;

/** One observation, with ids, positions and names the evidence must never carry. */
function sent(
  url: string,
  options: { type?: string; frames?: string[]; redirect?: boolean; initiatorType?: string } = {}
): Record<string, unknown> {
  nextId += 1;
  const initiator: Record<string, unknown> = { type: options.initiatorType ?? (options.frames ? "script" : "parser") };
  if (options.frames) {
    initiator.stack = {
      callFrames: options.frames.map((frameUrl, index) => ({
        functionName: `pageChosenFunction${index}`,
        scriptId: `SCRIPT-ID-${7000 + index}`,
        url: frameUrl,
        lineNumber: 4242 + index,
        columnNumber: 1717 + index
      }))
    };
  } else if (initiator.type === "parser") {
    initiator.url = "http://www.example.com/";
    initiator.lineNumber = 31337;
  }
  return {
    requestId: `REQUEST-ID-${nextId}`,
    loaderId: "LOADER-ID",
    frameId: "FRAME-ID",
    request: { url, method: "GET", headers: {} },
    initiator,
    type: options.type ?? "Fetch",
    ...(options.redirect ? { redirectResponse: { status: 302, headers: {} } } : {})
  };
}

/** A request the page makes and the session observes, the observation first, as Chromium delivers them. */
function both(at: number, url: string, options: Parameters<typeof sent>[1] & { decision?: ScrollCheckRouteDecision | null } = {}): Scheduled[] {
  const { decision, ...observation } = options;
  return [
    { at, cdp: sent(url, observation) },
    { at: at + 2, page: url, decision: options.redirect ? null : (decision ?? "sent"), redirected: options.redirect }
  ];
}

/** The page's own document and its loader, requested before the check began. */
const AT_LOAD: Scheduled[] = [
  ...both(NAV + 10, "http://www.example.com/", { type: "Document", initiatorType: "other" }),
  ...both(NAV + 100, LOADER, { type: "Script" })
];

async function check(options: {
  scheduled: Scheduled[];
  height?: number;
  locked?: boolean;
  stacks?: ScrollCheckStackRecorder | null;
  allowance?: number;
  /** How far the routes' settle moves the clock, delivering what arrives meanwhile. */
  settleMs?: number;
}) {
  let now = NAV + 5_000;
  const startedAt = now;
  const recorder = new ScrollCheckRecorder<FakeRequest>(
    {
      url: (request) => request.url,
      redirected: (request) => request.redirected === true,
      mainFrameNavigation: (request) => request.navigation === true
    },
    () => now
  );
  const stacks = options.stacks === undefined ? new ScrollCheckStackRecorder(options.allowance ?? SCROLL_CHECK_REQUEST_ALLOWANCE) : options.stacks;
  const queue = [...options.scheduled].map((item, order) => ({ item, order })).sort((left, right) => left.item.at - right.item.at || left.order - right.order);
  const advance = (until: number) => {
    while (queue.length > 0 && queue[0].item.at <= until) {
      const { item } = queue.shift() as { item: Scheduled };
      now = Math.max(now, item.at);
      if ("cdp" in item) {
        stacks?.observe(item.cdp);
      } else {
        const request: FakeRequest = { url: item.page, navigation: item.navigation, redirected: item.redirected };
        recorder.noteRequest(request);
        if (item.decision !== null) recorder.noteRouted(request, item.decision ?? "sent");
        // The host answers every request the scanner let through: a redirect
        // hop, or a route decided as sent.
        if (item.decision === null ? item.redirected === true : (item.decision ?? "sent") === "sent") recorder.noteAnswered(request);
      }
    }
    now = Math.max(now, until);
  };
  // What the visit delivered before the check began, at its own times.
  advance(startedAt);
  const height = options.height ?? 980 * 3;
  let top = 0;
  const run: ScrollCheckRun<FakeRequest> = {
    recorder,
    ...(stacks ? { stacks } : {}),
    timing: SCROLL_CHECK_TIMING,
    navigationStartedAt: NAV,
    startedAt,
    subjectAvailable: true,
    firstPartyHostname: "www.example.com",
    sameSubject: () => true,
    leftSiteAt: () => null,
    visitBudgetUsedUp: false,
    proxyLossCount: () => 0,
    settleRoutes: async () => advance(now + (options.settleMs ?? 200)),
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
      scrollState: async (): Promise<ScrollState> => ({ top, height, viewport: 980, locked: options.locked === true }),
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

function stacksOf(evidence: ScrollCheckEvidence): ScrollCheckHostStacks[] {
  const stacks = evidence.scroll?.stacks;
  assert.ok(stacks, `the check carries no stacks: ${JSON.stringify(evidence.scroll)}`);
  return stacks;
}

const entryFor = (evidence: ScrollCheckEvidence, host: string) => {
  const entry = stacksOf(evidence).find((candidate) => candidate.host === host);
  assert.ok(entry, `no entry for ${host}: ${JSON.stringify(evidence.scroll?.stacks)}`);
  return entry;
};

/** The page of the fixture, as Chromium reports it: a loader on host A, a tag on host B it inserts on scroll, and the tag's fetch to host C. */
function richPage(): Scheduled[] {
  return [
    ...AT_LOAD,
    // A timer in the window without input: listed there, never given stacks.
    ...both(CONTROL_START + 3_000, "http://api.kilo.net/timer", { frames: ["http://www.example.com/"] }),
    // On the first screen, the loader inserts the tag and draws an image.
    ...both(SCROLL_START + 1_100, TAG, { type: "Script", frames: [LOADER] }),
    ...both(SCROLL_START + 1_110, "http://img.delta.net/i.png", { type: "Image" }),
    // The loader's own host is not new: its request stays out.
    ...both(SCROLL_START + 1_120, "http://cdn.alpha.net/beacon", { frames: [LOADER] }),
    // The tag's function, called by the loader, fetches from host C.
    ...both(SCROLL_START + 1_300, "http://pixel.charlie.com/collect?uid=SECRET-QUERY", { frames: [TAG, TAG, LOADER] }),
    // A fetch that redirects to another new host.
    ...both(SCROLL_START + 1_400, "http://api.echo.net/redirect", { frames: [LOADER] }),
    ...both(SCROLL_START + 1_450, "http://cdn.foxtrot.net/landing", { redirect: true, frames: [LOADER] }),
    // A dedicated worker's request: the page reports it, the session never sees it.
    { at: SCROLL_START + 1_500, page: "http://cdn.golf.net/beacon" },
    // Two self-named scripts: one whose name nothing requested, one whose name is the loader's.
    ...both(SCROLL_START + 1_600, "http://cdn.hotel.net/forged", { frames: ["http://forged.india.com/named.js"] }),
    ...both(SCROLL_START + 1_610, "http://cdn.juliet.net/borrowed", { frames: [LOADER] }),
    // Two raw hosts that publish as one listed host.
    ...both(SCROLL_START + 2_100, "http://north.lima.net/a", { frames: [LOADER] }),
    ...both(SCROLL_START + 2_110, "http://south.lima.net/b.png", { type: "Image" })
  ];
}

test("each host the scroll window lists gets the call stacks of the requests the check counted for it, under Inspect's rules", async () => {
  const evidence = await check({ scheduled: richPage() });
  const scroll = evidence.scroll as ScrollCheckScrollWindow;
  const listed = scroll.hosts.flatMap((group) => group.hosts);
  // One entry per listed host, in the listed order.
  assert.deepEqual(stacksOf(evidence).map((entry) => entry.host), listed);
  const lima = redactHostnameV2("north.lima.net").value;
  assert.equal(lima, redactHostnameV2("south.lima.net").value, "the two lima hosts should publish as one");
  assert.ok(listed.includes(lima));
  assert.ok(!listed.some((host) => host.includes("alpha") || host.includes("kilo")), JSON.stringify(listed));
  const zero = { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 0, unobserved: 0 };
  // C's request names B, then A, innermost first.
  assert.deepEqual(entryFor(evidence, "pixel.charlie.com"), {
    host: "pixel.charlie.com",
    requests: 1,
    groups: [{ count: 1, hosts: ["static.bravo.org", "cdn.alpha.net"] }],
    ...zero
  });
  assert.deepEqual(entryFor(evidence, "static.bravo.org"), {
    host: "static.bravo.org",
    requests: 1,
    groups: [{ count: 1, hosts: ["cdn.alpha.net"] }],
    ...zero
  });
  // An image a script draws comes with no call stack.
  assert.deepEqual(entryFor(evidence, "img.delta.net"), { host: "img.delta.net", requests: 1, groups: [], ...zero, withoutStack: 1 });
  // The redirect hop is counted apart, under the host it landed on.
  assert.deepEqual(entryFor(evidence, "api.echo.net").groups, [{ count: 1, hosts: ["cdn.alpha.net"] }]);
  assert.deepEqual(entryFor(evidence, "cdn.foxtrot.net"), { host: "cdn.foxtrot.net", requests: 1, groups: [], ...zero, redirected: 1 });
  // The worker's request is counted, as one the session never observed.
  assert.deepEqual(entryFor(evidence, "cdn.golf.net"), { host: "cdn.golf.net", requests: 1, groups: [], ...zero, unobserved: 1 });
  // A self-named script is named only when its name is a requested address.
  assert.deepEqual(entryFor(evidence, "cdn.hotel.net"), { host: "cdn.hotel.net", requests: 1, groups: [], ...zero, withoutNamedScript: 1 });
  assert.deepEqual(entryFor(evidence, "cdn.juliet.net").groups, [{ count: 1, hosts: ["cdn.alpha.net"] }]);
  // Two raw hosts, one entry.
  assert.deepEqual(entryFor(evidence, lima), {
    host: lima,
    requests: 2,
    groups: [{ count: 1, hosts: ["cdn.alpha.net"] }],
    ...zero,
    withoutStack: 1
  });
  // The window without input lists its host and carries no stacks.
  assert.deepEqual(evidence.control?.hosts.flatMap((group) => group.hosts), ["api.kilo.net"]);
  assert.equal(JSON.stringify(evidence.control).includes("stacks"), false);
});

test("the folded section reads the recorder's own stacks for the fixture page in the approved words", async () => {
  const evidence = await check({ scheduled: richPage() });
  assert.deepEqual(scrollCheckStacksCopy(evidence.scroll), {
    heading: "Which scripts asked for them",
    lines: [
      "static.bravo.org: 1 request. Scripts on the call stack, innermost first: cdn.alpha.net.",
      "pixel.charlie.com: 1 request. Scripts on the call stack, innermost first: static.bravo.org then cdn.alpha.net.",
      "api.echo.net: 1 request. Scripts on the call stack, innermost first: cdn.alpha.net.",
      "cdn.juliet.net: 1 request. Scripts on the call stack, innermost first: cdn.alpha.net.",
      "*.lima.net: 1 request. Scripts on the call stack, innermost first: cdn.alpha.net.",
      "1 of these hosts came with no call stack, so no script is named; the browser gives none for requests the page's HTML starts, nor for images a script creates.",
      "1 more request to these hosts came with no call stack, so no script is named for it.",
      "1 of these hosts' requests followed a redirect, so it carries the call stack of the request that started it, and no script is shown for it.",
      "1 of these hosts' requests had no script on the call stack with an address this visit requested, so no script is named."
    ],
    caveat: "A call stack shows which scripts were running when a request was made, not which one decided to make it. Requests made by workers are not observed.",
    unobserved: "1 of these hosts' requests was not observed, so nothing is shown for it."
  });
  // A check whose scroll window lists nothing has no section.
  assert.equal(scrollCheckStacksCopy((await check({ scheduled: AT_LOAD })).scroll), null);
});

test("the one count: each entry breaks down exactly the requests the check counted, whenever their observations arrived", async () => {
  const evidence = await check({
    scheduled: [
      ...AT_LOAD,
      // Observed just before the scroll window opened; the page's own event
      // for it comes after, inside the window.
      { at: SCROLL_START - 5, cdp: sent("http://cdn.early.net/e", { frames: [LOADER] }) },
      { at: SCROLL_START + 5, page: "http://cdn.early.net/e" },
      // Observed after the window ended, for a request made inside it.
      { at: SCROLL_END - 10, page: "http://cdn.late.net/l" },
      { at: SCROLL_END + 50, cdp: sent("http://cdn.late.net/l", { frames: [LOADER] }) },
      // Observed in step.
      ...both(SCROLL_START + 3_000, "http://cdn.steady.net/s", { frames: [LOADER] }),
      ...both(SCROLL_START + 3_500, "http://cdn.steady.net/s"),
      // A known host's traffic in the window: counted by the window, never broken down.
      ...both(CONTROL_START + 500, "http://api.known.net/k"),
      ...both(SCROLL_START + 4_000, "http://api.known.net/k", { frames: [LOADER] }),
      // A raw host already contacted that publishes as a host first
      // contacted here: the listed host stands for the new raw host alone.
      ...both(CONTROL_START + 600, "http://east.lima.net/e"),
      ...both(SCROLL_START + 4_100, "http://east.lima.net/e", { frames: [TAG] }),
      ...both(SCROLL_START + 4_200, "http://north.lima.net/n", { frames: [LOADER] })
    ]
  });
  const scroll = evidence.scroll as ScrollCheckScrollWindow;
  const group = [{ count: 1, hosts: ["cdn.alpha.net"] }];
  const zero = { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 0, unobserved: 0 };
  const lima = redactHostnameV2("north.lima.net").value;
  assert.equal(redactHostnameV2("east.lima.net").value, lima);
  assert.deepEqual(stacksOf(evidence), [
    { host: "cdn.early.net", requests: 1, groups: group, ...zero },
    { host: "cdn.late.net", requests: 1, groups: group, ...zero },
    { host: lima, requests: 1, groups: group, ...zero },
    { host: "cdn.steady.net", requests: 2, groups: group, ...zero, withoutStack: 1 }
  ]);
  // The window's own counts: seven requests, two of them to hosts already contacted.
  assert.deepEqual([scroll.requests, scroll.knownHostRequests], [7, 2]);
  const total = stacksOf(evidence).reduce((sum, entry) => sum + entry.requests, 0);
  assert.equal(total, scroll.requests - scroll.knownHostRequests);
  // The lead is the brief's "just before": well inside the window without input.
  assert.ok(SCROLL_CHECK_STACK_LEAD_MS > 0 && SCROLL_CHECK_STACK_LEAD_MS < SCROLL_CHECK_TIMING.controlWindowMs);
});

test("a request the check did not count still takes its observation, so it never hands its stack to a later one", async () => {
  const url = "http://cdn.paired.net/p";
  const evidence = await check({
    scheduled: [
      ...AT_LOAD,
      ...both(SCROLL_START + 1_000, url, { frames: [LOADER] }),
      // Refused by the scanner: observed all the same, with a stack of its own.
      ...both(SCROLL_START + 1_100, TAG, { type: "Script", frames: [LOADER] }),
      ...both(SCROLL_START + 1_200, url, { frames: [TAG], decision: "refused" }),
      ...both(SCROLL_START + 1_300, url)
    ]
  });
  assert.deepEqual(entryFor(evidence, "cdn.paired.net"), {
    host: "cdn.paired.net",
    requests: 2,
    groups: [{ count: 1, hosts: ["cdn.alpha.net"] }],
    redirected: 0,
    withoutStack: 1,
    withoutNamedScript: 0,
    notListed: 0,
    unobserved: 0
  });
});

test("at most three call stacks are listed for a host, the most frequent first, and the counts stay full", async () => {
  const scripts = ["one", "two", "three", "four", "five"].map((name) => `http://static.${name}.org/s.js`);
  const scheduled: Scheduled[] = [...AT_LOAD];
  scripts.forEach((script, index) => scheduled.push(...both(NAV + 200 + index, script, { type: "Script" })));
  // Script n makes 5 - n requests to the same host.
  scripts.forEach((script, index) => {
    for (let request = 0; request < 5 - index; request += 1) {
      scheduled.push(...both(SCROLL_START + 1_000 + index * 100 + request, `http://cdn.capped.net/c?n=${index}&r=${request}`, { frames: [script] }));
    }
  });
  const evidence = await check({ scheduled });
  const entry = entryFor(evidence, "cdn.capped.net");
  assert.equal(entry.groups.length, MAX_SCROLL_CHECK_STACK_GROUPS);
  assert.deepEqual(entry.groups, [
    { count: 5, hosts: ["static.one.org"] },
    { count: 4, hosts: ["static.two.org"] },
    { count: 3, hosts: ["static.three.org"] }
  ]);
  assert.deepEqual([entry.requests, entry.notListed], [15, 3]);
});

test("an observation a bound drops is counted as not listed, never as unobserved", async () => {
  // Room for two observations once the recorder keeps them.
  const evidence = await check({
    allowance: 2,
    scheduled: [
      ...AT_LOAD,
      ...both(SCROLL_START + 1_000, "http://cdn.bounded.net/a", { frames: [LOADER] }),
      ...both(SCROLL_START + 1_100, "http://cdn.bounded.net/a"),
      ...both(SCROLL_START + 1_200, "http://cdn.bounded.net/a"),
      ...both(SCROLL_START + 1_300, "http://cdn.bounded.net/b"),
      // Never observed at all.
      { at: SCROLL_START + 1_400, page: "http://cdn.bounded.net/w" }
    ]
  });
  assert.deepEqual(entryFor(evidence, "cdn.bounded.net"), {
    host: "cdn.bounded.net",
    requests: 5,
    groups: [{ count: 1, hosts: ["cdn.alpha.net"] }],
    redirected: 0,
    withoutStack: 1,
    withoutNamedScript: 0,
    // The third request to /a and the one to /b lost their observations to the bound.
    notListed: 2,
    unobserved: 1
  });
});

test("past the bound on URLs it counts drops for, every request it cannot join is not listed", async () => {
  const scheduled: Scheduled[] = [...AT_LOAD];
  // One observation fills the bound; then more distinct URLs are dropped than it counts one by one.
  scheduled.push(...both(SCROLL_START + 100, "http://cdn.first.net/f"));
  for (let index = 0; index <= 2_000; index += 1) scheduled.push({ at: SCROLL_START + 200, cdp: sent(`http://cdn.flood.net/u${index}`) });
  scheduled.push({ at: SCROLL_START + 300, page: "http://cdn.flood.net/u0" });
  // A request no session would observe reads as not listed once the recorder cannot tell.
  scheduled.push({ at: SCROLL_START + 400, page: "http://cdn.unseen.net/w" });
  const evidence = await check({ allowance: 1, scheduled });
  assert.deepEqual([entryFor(evidence, "cdn.flood.net").notListed, entryFor(evidence, "cdn.flood.net").unobserved], [1, 0]);
  assert.deepEqual([entryFor(evidence, "cdn.unseen.net").notListed, entryFor(evidence, "cdn.unseen.net").unobserved], [1, 0]);
  assert.equal(entryFor(evidence, "cdn.first.net").withoutStack, 1);
});

test("once more script addresses arrive than the recorder keeps, stacks name nothing and are not listed", async () => {
  const scheduled: Scheduled[] = [...AT_LOAD];
  for (let index = 0; index < MAX_REQUESTED_CODE_URLS; index += 1) {
    scheduled.push({ at: NAV + 1_000, cdp: sent(`http://cdn.many.net/m.js?i=${index}`, { type: "Script" }) });
  }
  scheduled.push(...both(SCROLL_START + 1_000, "http://cdn.overflow.net/o", { frames: [LOADER] }));
  scheduled.push(...both(SCROLL_START + 1_100, "http://cdn.overflow.net/p"));
  const evidence = await check({ scheduled });
  const entry = entryFor(evidence, "cdn.overflow.net");
  assert.deepEqual([entry.groups, entry.notListed, entry.withoutStack], [[], 1, 1]);
});

test("first-party observations never spend the bound", async () => {
  const scheduled: Scheduled[] = [...AT_LOAD];
  for (let index = 0; index < 5; index += 1) scheduled.push(...both(SCROLL_START + 500 + index, `http://www.example.com/own?i=${index}`));
  scheduled.push(...both(SCROLL_START + 1_000, "http://cdn.third.net/t", { frames: [LOADER] }));
  scheduled.push(...both(SCROLL_START + 1_100, "http://cdn.third.net/u"));
  const evidence = await check({ allowance: 2, scheduled });
  assert.deepEqual(entryFor(evidence, "cdn.third.net"), {
    host: "cdn.third.net",
    requests: 2,
    groups: [{ count: 1, hosts: ["cdn.alpha.net"] }],
    redirected: 0,
    withoutStack: 1,
    withoutNamedScript: 0,
    notListed: 0,
    unobserved: 0
  });
});

test("nothing but counts and published hosts reaches the stacks: no script address, name, position, id, query or depth", async () => {
  const deep = Array.from({ length: 40 }, () => TAG);
  const evidence = await check({
    scheduled: [
      ...AT_LOAD,
      ...both(SCROLL_START + 900, TAG, { type: "Script", frames: [LOADER] }),
      ...both(SCROLL_START + 1_000, "http://u7f3k9.tracker.net/collect?token=LONG-QUERY-SECRET&email=a%40b.c#frag", { frames: [...deep, LOADER] }),
      ...both(SCROLL_START + 1_100, "http://203.0.113.9/beacon?x=1", { frames: [LOADER] })
    ]
  });
  const serialized = JSON.stringify(evidence.scroll?.stacks);
  for (const forbidden of [
    "pageChosenFunction",
    "SCRIPT-ID",
    "REQUEST-ID",
    "LOADER-ID",
    "FRAME-ID",
    "4242",
    "1717",
    "31337",
    "LONG-QUERY-SECRET",
    "token",
    "email",
    "frag",
    "collect",
    "beacon",
    "loader.js",
    "tag.js",
    "/{seg}",
    "http:",
    "?",
    "#",
    "203.0.113",
    "u7f3k9",
    "40"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `the stacks carry ${forbidden}: ${serialized}`);
  }
  for (const entry of stacksOf(evidence)) {
    assert.deepEqual(Object.keys(entry).sort(), ["groups", "host", "notListed", "redirected", "requests", "unobserved", "withoutNamedScript", "withoutStack"]);
    for (const group of entry.groups) assert.deepEqual(Object.keys(group).sort(), ["count", "hosts"]);
  }
});

test("no scroll window, no stacks; and a check without a stack recorder is the check as it was", async () => {
  const locked = await check({ scheduled: richPage(), locked: true });
  assert.equal(locked.outcome, "locked");
  assert.equal(locked.scroll, null);
  const without = await check({ scheduled: richPage(), stacks: null });
  const withStacks = await check({ scheduled: richPage() });
  assert.equal(Object.prototype.hasOwnProperty.call(without.scroll, "stacks"), false);
  const { stacks: _stacks, ...rest } = withStacks.scroll as ScrollCheckScrollWindow;
  assert.deepEqual({ ...withStacks, scroll: rest }, without, "call stacks moved something besides themselves");
});

test("a recording that failed, or a session that never opened, costs the check its stacks and nothing else", async () => {
  const unavailable = new ScrollCheckStackRecorder(SCROLL_CHECK_REQUEST_ALLOWANCE);
  unavailable.sessionUnavailable();
  const noSession = await check({ scheduled: richPage(), stacks: unavailable });
  const failed = new ScrollCheckStackRecorder(SCROLL_CHECK_REQUEST_ALLOWANCE);
  const broken = await check({
    scheduled: [
      ...richPage(),
      { at: SCROLL_START + 2_500, cdp: { get request(): never { throw new Error("a payload that throws when read"); } } }
    ],
    stacks: failed
  });
  const plain = await check({ scheduled: richPage(), stacks: null });
  for (const evidence of [noSession, broken]) {
    assert.equal(Object.prototype.hasOwnProperty.call(evidence.scroll, "stacks"), false);
    assert.deepEqual(evidence, plain);
  }
});

test("stacks the closed shape would refuse are dropped, never the check", async () => {
  const recorder = new ScrollCheckStackRecorder(SCROLL_CHECK_REQUEST_ALLOWANCE);
  // Corrupt the stacks the groups publish, as a bug would.
  const stacks = (recorder as unknown as { stacks: Map<string, { hosts: string[] }> }).stacks;
  const original = stacks.set.bind(stacks);
  stacks.set = (key, value) => original(key, { ...value, hosts: ["203.0.113.9"] });
  const evidence = await check({ scheduled: richPage(), stacks: recorder });
  const plain = await check({ scheduled: richPage(), stacks: null });
  assert.equal(evidence.outcome, "reached-end");
  assert.deepEqual(evidence, plain);
});

test("the validator takes the recorder's own stacks and refuses every one-thing change to them", async () => {
  const evidence = await check({ scheduled: richPage() });
  assert.equal(isScrollCheckEvidence(evidence), true);
  type Mutation = [string, (scroll: Record<string, any>) => unknown];
  const at = (scroll: Record<string, any>, index: number, change: (entry: Record<string, any>) => unknown) => ({
    ...scroll,
    stacks: scroll.stacks.map((entry: Record<string, any>, position: number) => (position === index ? change(entry) : entry))
  });
  const charlie = (evidence.scroll?.stacks ?? []).findIndex((entry) => entry.host === "pixel.charlie.com");
  const lima = (evidence.scroll?.stacks ?? []).findIndex((entry) => entry.requests === 2);
  const mutations: Mutation[] = [
    ["stacks that are not a list", (scroll) => ({ ...scroll, stacks: {} })],
    ["stacks present but undefined", (scroll) => ({ ...scroll, stacks: undefined })],
    ["one entry too few", (scroll) => ({ ...scroll, stacks: scroll.stacks.slice(1) })],
    ["one entry too many", (scroll) => ({ ...scroll, stacks: [...scroll.stacks, scroll.stacks[0]] })],
    ["entries out of the listed order", (scroll) => ({ ...scroll, stacks: [...scroll.stacks].reverse() })],
    ["an entry for a host the window does not list", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, host: "pixel.other.com" }))],
    ["an entry with an extra key", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, scripts: [] }))],
    ["an entry without a count", (scroll) => at(scroll, charlie, ({ unobserved: _dropped, ...entry }) => entry)],
    ["an entry with no requests", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, requests: 0, groups: [] }))],
    ["counts that do not add up", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, unobserved: 1 }))],
    ["a fractional count", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, requests: 1.5 }))],
    ["a group with a script address", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, groups: [{ count: 1, hosts: ["http://static.bravo.org/{seg}"] }] }))],
    ["a group with an IP literal", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, groups: [{ count: 1, hosts: ["203.0.113.9"] }] }))],
    ["a group with an extra key", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, groups: [{ ...entry.groups[0], namedScripts: [] }] }))],
    ["a group with no hosts", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, groups: [{ count: 1, hosts: [] }] }))],
    ["a group with five hosts", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, groups: [{ count: 1, hosts: ["a.example.net", "b.example.net", "c.example.net", "d.example.net", "e.example.net"] }] }))],
    ["a host repeated in a row", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, groups: [{ count: 1, hosts: ["cdn.alpha.net", "cdn.alpha.net"] }] }))],
    ["a group of no requests", (scroll) => at(scroll, charlie, (entry) => ({ ...entry, requests: 0, groups: [{ count: 0, hosts: ["cdn.alpha.net"] }] }))],
    // Each of these leaves the window room for its requests, so only the rule it names refuses it.
    ["four groups", (scroll) => at({ ...scroll, requests: scroll.requests + 2 }, lima, (entry) => ({
      ...entry,
      requests: 4,
      withoutStack: 0,
      groups: ["a", "b", "c", "d"].map((name) => ({ count: 1, hosts: [`cdn.${name}.net`] }))
    }))],
    ["two groups that publish the same hosts", (scroll) => at(scroll, lima, (entry) => ({ ...entry, withoutStack: 0, groups: [entry.groups[0], entry.groups[0]] }))],
    ["groups out of order", (scroll) => at({ ...scroll, requests: scroll.requests + 1 }, lima, (entry) => ({
      ...entry,
      requests: 3,
      withoutStack: 0,
      groups: [{ count: 1, hosts: ["cdn.a.net"] }, { count: 2, hosts: ["cdn.b.net"] }]
    }))],
    ["more requests than the window counted to new hosts", (scroll) => at(scroll, lima, (entry) => ({ ...entry, requests: entry.requests + scroll.requests, withoutStack: entry.withoutStack + scroll.requests }))]
  ];
  for (const [name, mutate] of mutations) {
    const scroll = mutate(structuredClone(evidence.scroll) as Record<string, any>);
    assert.equal(isScrollCheckEvidence({ ...evidence, scroll }), false, `the validator accepted ${name}`);
  }
  // Stacks belong to the scroll window alone.
  assert.equal(isScrollCheckEvidence({ ...evidence, control: { ...evidence.control, stacks: [] } }), false);
  // And an empty list is the right shape for a scroll window that lists no host.
  const empty = await check({ scheduled: AT_LOAD });
  assert.deepEqual(empty.scroll?.stacks, []);
});
