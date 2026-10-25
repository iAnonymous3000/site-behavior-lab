import assert from "node:assert/strict";
import { test } from "node:test";
import { runScrollCheck, SCROLL_CHECK_TIMING, ScrollCheckRecorder } from "./scroll-check";
import { isScrollCheckEvidence, type ScrollCheckEvidence } from "./scroll-check-evidence";

/**
 * The closed shape, held against what the real check produces: the builder's
 * own output is accepted, and each one-thing change to it is refused.
 */

type FakeRequest = { url: string };

async function producedEvidence(scheduled: Array<{ at: number; url: string }>, height = 980 * 4): Promise<ScrollCheckEvidence> {
  const navigationStartedAt = 1_000_000;
  let now = navigationStartedAt + 5_000;
  const startedAt = now;
  const recorder = new ScrollCheckRecorder<FakeRequest>(
    { url: (request) => request.url, redirected: () => false, mainFrameNavigation: () => false },
    () => now
  );
  const queue = [...scheduled].sort((left, right) => left.at - right.at);
  const advance = (until: number) => {
    while (queue.length > 0 && queue[0].at <= until) {
      const next = queue.shift() as { at: number; url: string };
      now = Math.max(now, next.at);
      const request = { url: next.url };
      recorder.noteRequest(request);
      recorder.noteRouted(request, "sent");
      recorder.noteAnswered(request);
    }
    now = Math.max(now, until);
  };
  let top = 0;
  return runScrollCheck({
    recorder,
    timing: SCROLL_CHECK_TIMING,
    navigationStartedAt,
    startedAt,
    subjectAvailable: true,
    firstPartyHostname: "www.example.com",
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
      url: () => "https://www.example.com/",
      scrollState: async () => ({ top, height, viewport: 980, locked: false }),
      scrollTo: async (target) => {
        top = Math.min(target, height - 980);
        return true;
      }
    }
  });
}

const CONTROL_START = 1_000_000 + 25_000;
const SCROLL_START = CONTROL_START + 10_500;

async function sample(): Promise<ScrollCheckEvidence> {
  const evidence = await producedEvidence([
    { at: CONTROL_START + 1_000, url: "https://pixel.timer.org/p" },
    { at: SCROLL_START + 1_500, url: "https://cdn.video.net/v.js" },
    { at: SCROLL_START + 1_600, url: "https://img.video.net/poster.jpg" },
    { at: SCROLL_START + 1_700, url: "https://pixel.timer.org/again" },
    { at: SCROLL_START + 1_800, url: "https://api.other.org/x" }
  ]);
  assert.deepEqual(evidence, {
    outcome: "reached-end",
    screens: 3,
    control: { hosts: [{ site: "timer.org", hosts: ["pixel.timer.org"] }], hostCount: 1, siteCount: 1, requests: 1 },
    scroll: {
      hosts: [
        { site: "video.net", hosts: ["cdn.video.net", "img.video.net"] },
        { site: "other.org", hosts: ["api.other.org"] }
      ],
      hostCount: 3,
      siteCount: 2,
      requests: 4,
      knownHostRequests: 1
    },
    incomplete: [],
    addressChanged: false
  });
  return evidence;
}

type Mutation = [string, (evidence: Record<string, any>) => unknown];

test("the validator takes the builder's output and refuses every one-thing change to it", async () => {
  const evidence = await sample();
  assert.equal(isScrollCheckEvidence(evidence), true);
  const mutations: Mutation[] = [
    ["an extra key", (value) => ({ ...value, urls: [] })],
    ["a missing key", ({ addressChanged: _dropped, ...rest }) => rest],
    ["an unknown outcome", (value) => ({ ...value, outcome: "scrolled" })],
    ["nine screens", (value) => ({ ...value, screens: 9 })],
    ["a fractional screen count", (value) => ({ ...value, screens: 2.5 })],
    ["a string address change", (value) => ({ ...value, addressChanged: "no" })],
    ["an unknown reason", (value) => ({ ...value, incomplete: ["slow"] })],
    ["a repeated reason", (value) => ({ ...value, incomplete: ["refused", "refused"] })],
    ["reasons out of order", (value) => ({ ...value, incomplete: ["refused", "visit-budget"] })],
    ["a window with an extra key", (value) => ({ ...value, control: { ...value.control, timings: [1] } })],
    ["a window without its count", (value) => ({ ...value, control: { ...value.control, hostCount: undefined } })],
    ["a scroll window without its known-host count", (value) => {
      const { knownHostRequests: _dropped, ...scroll } = value.scroll;
      return { ...value, scroll };
    }],
    ["a control window carrying a known-host count", (value) => ({ ...value, control: { ...value.control, knownHostRequests: 0 } })],
    ["a host count the list does not match", (value) => ({ ...value, scroll: { ...value.scroll, hostCount: 4 } })],
    ["a site count the list does not match", (value) => ({ ...value, scroll: { ...value.scroll, siteCount: 3 } })],
    ["fewer requests than first contacts", (value) => ({ ...value, scroll: { ...value.scroll, requests: 2, knownHostRequests: 0 } })],
    ["more known-host requests than requests leave room for", (value) => ({ ...value, scroll: { ...value.scroll, knownHostRequests: 2 } })],
    ["a raw URL for a host", (value) => ({ ...value, control: { ...value.control, hosts: [{ site: "timer.org", hosts: ["https://pixel.timer.org/p"] }] } })],
    ["an IP literal", (value) => ({ ...value, control: { ...value.control, hosts: [{ site: "203.0.113.9", hosts: ["203.0.113.9"] }] } })],
    ["a host outside its site", (value) => ({ ...value, control: { ...value.control, hosts: [{ site: "timer.org", hosts: ["pixel.other.org"] }] } })],
    ["hosts out of name order", (value) => ({
      ...value,
      scroll: { ...value.scroll, hosts: [{ site: "video.net", hosts: ["img.video.net", "cdn.video.net"] }, value.scroll.hosts[1]] }
    })],
    ["a smaller site first", (value) => ({ ...value, scroll: { ...value.scroll, hosts: [value.scroll.hosts[1], value.scroll.hosts[0]] } })],
    ["a site listed twice", (value) => ({
      ...value,
      scroll: { ...value.scroll, hosts: [value.scroll.hosts[0], { site: "video.net", hosts: ["{label}.video.net"] }] }
    })],
    ["an empty site", (value) => ({ ...value, scroll: { ...value.scroll, hosts: [value.scroll.hosts[0], { site: "other.org", hosts: [] }] } })],
    ["a scroll window with no screens", (value) => ({ ...value, screens: 0 })],
    ["a scroll window after no window without input", (value) => ({ ...value, control: null })],
    ["a not-run check with windows", (value) => ({ ...value, outcome: "not-run" })],
    ["a depth limit short of eight screens", (value) => ({ ...value, outcome: "depth-limit" })],
    ["nothing to scroll with a scroll window", (value) => ({ ...value, outcome: "nothing-to-scroll" })],
    ["an end reached with no scroll window", (value) => ({ ...value, scroll: null })],
    ["an address changed with no screen", (value) => ({ ...value, screens: 0, scroll: null, outcome: "locked", addressChanged: true })],
    ["a null", () => null],
    ["an array", () => []]
  ];
  for (const [name, mutate] of mutations) {
    const mutated = mutate(structuredClone(evidence) as Record<string, any>);
    assert.equal(isScrollCheckEvidence(mutated), false, `the validator accepted ${name}`);
  }
});

test("every outcome the check can end on has a shape the validator takes", () => {
  const empty = { hosts: [], hostCount: 0, siteCount: 0, requests: 0 };
  const accepted: ScrollCheckEvidence[] = [
    { outcome: "not-run", screens: 0, control: null, scroll: null, incomplete: [], addressChanged: false },
    { outcome: "nothing-to-scroll", screens: 0, control: empty, scroll: null, incomplete: [], addressChanged: false },
    { outcome: "locked", screens: 0, control: empty, scroll: null, incomplete: [], addressChanged: false },
    { outcome: "locked", screens: 2, control: empty, scroll: { ...empty, knownHostRequests: 0 }, incomplete: [], addressChanged: true },
    { outcome: "did-not-move", screens: 0, control: empty, scroll: null, incomplete: ["visit-budget"], addressChanged: false },
    { outcome: "depth-limit", screens: 8, control: empty, scroll: { ...empty, knownHostRequests: 0 }, incomplete: [], addressChanged: false },
    { outcome: "left-site", screens: 3, control: empty, scroll: null, incomplete: [], addressChanged: false },
    { outcome: "cut-short", screens: 0, control: null, scroll: null, incomplete: [], addressChanged: false }
  ];
  for (const evidence of accepted) assert.equal(isScrollCheckEvidence(evidence), true, JSON.stringify(evidence));
  // A locked page reported with screens has its scroll window; one without has none.
  assert.equal(isScrollCheckEvidence({ ...accepted[3], scroll: null }), false);
  assert.equal(isScrollCheckEvidence({ ...accepted[2], screens: 1 }), false);
});

test("a cut list of more than twenty hosts names twenty and keeps the full counts", async () => {
  const scheduled = Array.from({ length: 25 }, (_value, index) => ({
    at: SCROLL_START + 1_500 + index,
    url: `https://cdn.site${String(index).padStart(2, "0")}.net/x`
  }));
  const evidence = await producedEvidence(scheduled, 980 * 2);
  assert.equal(evidence.scroll?.hostCount, 25);
  assert.equal(evidence.scroll?.siteCount, 25);
  assert.equal(evidence.scroll?.hosts.length, 20);
  assert.equal(isScrollCheckEvidence(evidence), true);
  // Naming twenty-one is refused, and so is naming nineteen.
  const scroll = evidence.scroll as NonNullable<ScrollCheckEvidence["scroll"]>;
  assert.equal(isScrollCheckEvidence({ ...evidence, scroll: { ...scroll, hosts: [...scroll.hosts, { site: "zz.net", hosts: ["cdn.zz.net"] }] } }), false);
  assert.equal(isScrollCheckEvidence({ ...evidence, scroll: { ...scroll, hosts: scroll.hosts.slice(1) } }), false);
});
