import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  categorizeObservation,
  heldUrlKey,
  joinObservations,
  MAX_HELD_URL_CHARS,
  MAX_REQUESTED_CODE_URLS,
  MAX_STACK_FRAMES,
  observedRequest,
  publishedStack,
  RequestedCodeUrls,
  stackFrameUrls,
  StackTally,
  type PublishedStack
} from "./call-stack-publisher";
import { ConnectionInspectionRecorder, MAX_INSPECTION_CODE_URLS, MAX_INSPECTION_STACK_FRAMES } from "./connection-inspection";
import { MAX_INSPECTION_GROUP_HOSTS } from "./connection-inspection-evidence";
import { redactHostnameV2 } from "./redaction-v2";
import { SCROLL_CHECK_REQUEST_ALLOWANCE } from "./scroll-check";
import { ScrollCheckStackRecorder } from "./scroll-check-stacks";

/**
 * The one stack publisher (lib/call-stack-publisher.ts), on its own: the
 * rules every recorder that publishes call stacks shares, and what holds both
 * callers, Inspect's recorder and a check's, to it rather than to a
 * restatement of their own: the same stream publishes the same in both, and
 * neither states a rule itself. lib/connection-inspection.test.ts and its
 * fixture hold Inspect's evidence to what it has always been.
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

function code(...urls: string[]): RequestedCodeUrls {
  const set = new RequestedCodeUrls();
  for (const url of urls) set.note(heldUrlKey(url));
  return set;
}

function frames(...urls: string[]): Record<string, unknown> {
  return {
    callFrames: urls.map((url, index) => ({ functionName: `page${index}`, scriptId: `${index}`, url, lineNumber: index, columnNumber: index }))
  };
}

function observed(url: string, extra: Record<string, unknown> = {}) {
  const value = observedRequest({ request: { url }, type: "Fetch", ...extra });
  assert.ok(value, `no observation for ${url}`);
  return value;
}

const keyOfHosts = (stack: PublishedStack) => JSON.stringify(stack.hosts);

test("a recorder's bounds are the publisher's, under the names Inspect has always exported", () => {
  assert.equal(MAX_INSPECTION_CODE_URLS, MAX_REQUESTED_CODE_URLS);
  assert.equal(MAX_INSPECTION_STACK_FRAMES, MAX_STACK_FRAMES);
  assert.equal(MAX_REQUESTED_CODE_URLS, 4_000);
  assert.equal(MAX_STACK_FRAMES, 200);
  assert.equal(MAX_HELD_URL_CHARS, 2_048);
});

test("a URL is held by itself without its fragment, or by its digest when it is long", () => {
  assert.equal(heldUrlKey("https://cdn.example.net/a.js#frag"), "https://cdn.example.net/a.js");
  const long = `https://cdn.example.net/a.js?c=${"c".repeat(MAX_HELD_URL_CHARS)}`;
  assert.match(heldUrlKey(long), /^sha256:[0-9a-f]{64}$/);
  assert.equal(heldUrlKey(`${long}#frag`), heldUrlKey(long));
  assert.notEqual(heldUrlKey(long), heldUrlKey(`${long}x`));
});

test("a stack's frames are read innermost first, bounded, and never from an async parent", () => {
  assert.equal(stackFrameUrls(undefined), null);
  assert.equal(stackFrameUrls({ callFrames: [] }), null);
  assert.deepEqual(stackFrameUrls(frames("https://a.example.net/a.js#x", "")), ["https://a.example.net/a.js", ""]);
  const deep = stackFrameUrls(frames(...Array.from({ length: MAX_STACK_FRAMES + 5 }, (_value, index) => `https://a.example.net/${index}.js`)));
  assert.equal(deep?.length, MAX_STACK_FRAMES);
  const withParent = { ...frames(""), parent: frames("https://a.example.net/a.js") };
  assert.deepEqual(stackFrameUrls(withParent), [""]);
});

test("each recorder's requested addresses are its own, and past the bound it names nothing", () => {
  const first = code("https://a.example.net/a.js");
  const second = new RequestedCodeUrls();
  assert.equal(first.has(heldUrlKey("https://a.example.net/a.js")), true);
  assert.equal(second.has(heldUrlKey("https://a.example.net/a.js")), false, "two recorders shared one set");
  const full = new RequestedCodeUrls();
  for (let index = 0; index < MAX_REQUESTED_CODE_URLS; index += 1) full.note(`https://a.example.net/${index}.js`);
  assert.equal(full.overflowed, false);
  full.note("https://a.example.net/0.js");
  assert.equal(full.overflowed, false, "an address already held is no overflow");
  full.note("https://a.example.net/one-more.js");
  assert.equal(full.overflowed, true);
  const stacks = new Map<string, PublishedStack>();
  const category = categorizeObservation(
    observed("https://p.example.net/p", { initiator: { type: "script", stack: frames("https://a.example.net/0.js") } }),
    full,
    stacks,
    keyOfHosts
  );
  assert.equal(category, "notListed");
});

test("a preflight and a payload that names no request are not observations", () => {
  assert.equal(observedRequest({ request: { url: "https://p.example.net/p" }, initiator: { type: "preflight" } }), null);
  for (const payload of [null, 42, {}, { request: null }, { request: { url: "" } }, { request: { url: 7 } }]) {
    assert.equal(observedRequest(payload), null, JSON.stringify(payload));
  }
  assert.equal(observed("https://a.example.net/a.js", { type: "Script" }).code, true);
  assert.equal(observed("https://www.example.com/", { type: "Document" }).code, true);
  assert.equal(observed("https://a.example.net/a.css", { type: "Stylesheet" }).code, false);
});

test("an observation is a redirect hop, has no stack, names no script, or joins the group its hosts publish", () => {
  const requested = code("https://cdn.example.net/loader.js", "https://static.example.org/tag.js");
  const stacks = new Map<string, PublishedStack>();
  const categorize = (extra: Record<string, unknown>) =>
    categorizeObservation(observed("https://p.example.net/p", extra), requested, stacks, keyOfHosts, { scripts: false });
  assert.equal(categorize({ redirectResponse: { status: 302 }, initiator: { type: "script", stack: frames("https://cdn.example.net/loader.js") } }), "redirected");
  assert.equal(categorize({ initiator: { type: "parser", url: "https://www.example.com/" } }), "withoutStack");
  assert.equal(categorize({ initiator: { type: "script", stack: frames("https://forged.example.com/named.js", "") } }), "withoutNamedScript");
  const group = categorize({ initiator: { type: "script", stack: frames("https://static.example.org/tag.js", "https://cdn.example.net/loader.js") } });
  assert.deepEqual(group, { group: JSON.stringify(["static.example.org", "cdn.example.net"]) });
  assert.deepEqual([...stacks.values()], [{ hosts: ["static.example.org", "cdn.example.net"], namedScripts: [] }]);
});

test("a stack publishes at most four hosts, innermost first, repeats collapsed, the same with or without its scripts or a host cache", () => {
  const scripts = [
    "https://static.example.org/tag.js",
    "https://cdn.example.net/loader.js",
    "https://cdn.example.com/vendor.js",
    "https://cdn2.example.org/wrap.js",
    "https://u7f3k9.tracker.net/t.js",
    "http://203.0.113.9/lib.js"
  ];
  const requested = code(...scripts);
  const stack = [scripts[0], scripts[0], scripts[1], scripts[4], scripts[5], scripts[2], scripts[3]];
  const named = publishedStack(stack, requested);
  assert.deepEqual(named?.hosts, ["static.example.org", "cdn.example.net", redactHostnameV2("u7f3k9.tracker.net").value, "{invalid-host}"]);
  assert.equal(named?.hosts.length, MAX_INSPECTION_GROUP_HOSTS);
  assert.ok((named?.namedScripts.length ?? 0) > 0);
  const cache = new Map<string, string>();
  const hostsOnly = publishedStack(stack, requested, { scripts: false, hostCache: cache });
  assert.deepEqual(hostsOnly, { hosts: named?.hosts, namedScripts: [] });
  assert.ok(cache.size > 0, "the cache held nothing");
  // A second pass through a warm cache publishes the same hosts.
  assert.deepEqual(publishedStack(stack, requested, { scripts: false, hostCache: cache }), hostsOnly);
  // A frame nothing requested names nothing, whatever it calls itself.
  assert.equal(publishedStack(["https://forged.example.com/named.js", ""], requested), null);
});

test("one URL's requests take its observations in arrival order, and only counted requests are broken down", () => {
  const all = new StackTally();
  joinObservations(all, 3, ["withoutStack", { group: "g" }], 0);
  assert.deepEqual([all.withoutStack, all.groupCounts.get("g"), all.unobserved, all.notListed], [1, 1, 1, 0]);
  // A request that is not counted still takes its observation: the third
  // request gets the third observation, never the second's.
  const some = new StackTally();
  joinObservations(some, 3, ["withoutStack", "redirected", { group: "g" }], 0, (index) => index !== 1);
  assert.deepEqual([some.withoutStack, some.redirected, some.groupCounts.get("g"), some.unobserved], [1, 0, 1, 0]);
  // Requests whose observations a bound dropped are not listed, never unobserved.
  const bounded = new StackTally();
  joinObservations(bounded, 4, ["withoutStack"], 2);
  assert.deepEqual([bounded.withoutStack, bounded.notListed, bounded.unobserved], [1, 2, 1]);
  // Observations beyond the page's own count join nothing.
  const extra = new StackTally();
  joinObservations(extra, 1, ["withoutStack", "redirected"], 0);
  assert.deepEqual([extra.withoutStack, extra.redirected], [1, 0]);
});

test("a URL with an unobserved request and only some counted joins no stack to the counted ones", () => {
  // A worker's request (counted, answered) arrives before the page's own
  // request to the same URL (not counted, failed); only the page's was
  // observed. By position the worker's would take the page's stack.
  const workerFirst = new StackTally();
  joinObservations(workerFirst, 2, [{ group: "g" }], 0, (index) => index === 0);
  assert.equal(workerFirst.groupCounts.size, 0);
  assert.equal(workerFirst.unobserved, 1);
  // Dropped observations count as observed for this rule.
  const bounded = new StackTally();
  joinObservations(bounded, 3, [{ group: "g" }], 1, (index) => index !== 1);
  assert.deepEqual([bounded.groupCounts.size, bounded.notListed, bounded.unobserved], [0, 0, 2]);
  // Every request counted: any pairing gives the same counts, so they stand.
  const allCounted = new StackTally();
  joinObservations(allCounted, 2, [{ group: "g" }], 0);
  assert.deepEqual([allCounted.groupCounts.get("g"), allCounted.unobserved], [1, 1]);
  // As many requests as observations: arrival order still pairs them.
  const matched = new StackTally();
  joinObservations(matched, 2, ["withoutStack", { group: "g" }], 0, (index) => index === 1);
  assert.deepEqual([matched.withoutStack, matched.groupCounts.get("g"), matched.unobserved], [0, 1, 0]);
});

test("groups rank largest first, then by key, and a group that lost its stack throws", () => {
  const tally = new StackTally();
  const stacks = new Map<string, PublishedStack>([
    ["b", { hosts: ["b.example.net"], namedScripts: [] }],
    ["a", { hosts: ["a.example.net"], namedScripts: [] }],
    ["c", { hosts: ["c.example.net"], namedScripts: [] }]
  ]);
  for (const key of ["b", "c", "a", "c"]) tally.add({ group: key });
  assert.deepEqual(
    tally.rankedGroups(stacks).map(({ count, stack }) => [count, stack.hosts[0]]),
    [[2, "c.example.net"], [1, "a.example.net"], [1, "b.example.net"]]
  );
  stacks.delete("a");
  assert.throws(() => tally.rankedGroups(stacks), /lost its published stack/);
});

test("Inspect and the check publish the same stream as the same hosts and counts", () => {
  const tag = "https://static.example.org/tag.js";
  const loader = "https://cdn.example.net/loader.js";
  const pixel = (via: string) => `https://pixel.example.net/p.gif?via=${via}`;
  let id = 0;
  const payload = (url: string, extra: Record<string, unknown> = {}) => {
    id += 1;
    return { requestId: `R${id}`, request: { url }, type: "Fetch", initiator: { type: "parser" }, ...extra };
  };
  const script = (urls: string[]) => ({ initiator: { type: "script", stack: frames(...urls) } });
  // What the page reports (page) and what its session observes (cdp), in order.
  const stream: Array<{ page?: string; cdp?: Record<string, unknown> }> = [
    { page: "https://www.example.com/", cdp: payload("https://www.example.com/", { type: "Document", initiator: { type: "other" } }) },
    { page: loader, cdp: payload(loader, { type: "Script" }) },
    { page: tag, cdp: payload(tag, { type: "Script", ...script([loader]) }) },
    { page: pixel("a"), cdp: payload(pixel("a"), script([tag, tag, loader])) },
    { page: pixel("b"), cdp: payload(pixel("b"), script([tag, loader])) },
    { page: pixel("c"), cdp: payload(pixel("c"), script([loader])) },
    { page: pixel("html"), cdp: payload(pixel("html")) },
    { page: pixel("hop"), cdp: payload(pixel("hop"), { ...script([loader]), redirectResponse: { status: 302 } }) },
    { page: pixel("forged"), cdp: payload(pixel("forged"), script(["https://forged.example.com/named.js"])) },
    { page: pixel("inline"), cdp: payload(pixel("inline"), script(["https://www.example.com/"])) },
    // A worker's request, and a preflight no page request joins.
    { page: pixel("worker") },
    { cdp: payload(pixel("b"), { initiator: { type: "preflight" } }) }
  ];
  const inspection = new ConnectionInspectionRecorder("https://pixel.example.net/{seg}");
  const check = new ScrollCheckStackRecorder(SCROLL_CHECK_REQUEST_ALLOWANCE);
  check.keep("www.example.com");
  for (const step of stream) {
    if (step.cdp) {
      inspection.observe(step.cdp);
      check.observe(step.cdp);
    }
    if (step.page) inspection.notePageRequest(step.page);
  }
  const inspected = inspection.evidence();
  assert.ok(inspected);
  const pixelRequests = stream.flatMap((step) => (step.page?.startsWith("https://pixel.") ? [{ url: step.page, counted: true }] : []));
  const [checked] = check.entries([{ host: "pixel.example.net", requests: pixelRequests }]) ?? [];
  assert.ok(checked);
  // Inspect keys a group by its hosts and its scripts, the check by its hosts alone.
  const byHosts = new Map<string, number>();
  for (const group of inspected.groups) byHosts.set(JSON.stringify(group.hosts), (byHosts.get(JSON.stringify(group.hosts)) ?? 0) + group.count);
  assert.deepEqual(
    new Map(checked.groups.map((group) => [JSON.stringify(group.hosts), group.count])),
    byHosts
  );
  assert.ok(byHosts.has(JSON.stringify(["static.example.org", "cdn.example.net"])), JSON.stringify([...byHosts]));
  for (const count of ["redirected", "withoutStack", "withoutNamedScript", "notListed", "unobserved"] as const) {
    assert.equal(checked[count], inspected[count], count);
  }
  assert.equal(checked.requests, inspected.matched);
});

test("Inspect keeps stacks that name the same hosts through different scripts apart, and the check, which names no script, merges them", () => {
  const first = "https://cdn.example.net/loader.js";
  const second = "https://cdn.example.net/v2/lib/loader.js";
  const pixel = (via: string) => `https://pixel.example.net/p.gif?via=${via}`;
  const stream = [
    { request: { url: first }, type: "Script", initiator: { type: "parser" } },
    { request: { url: second }, type: "Script", initiator: { type: "parser" } },
    { request: { url: pixel("a") }, type: "Fetch", initiator: { type: "script", stack: frames(first) } },
    { request: { url: pixel("b") }, type: "Fetch", initiator: { type: "script", stack: frames(second) } }
  ];
  const inspection = new ConnectionInspectionRecorder("https://pixel.example.net/{seg}");
  const check = new ScrollCheckStackRecorder(SCROLL_CHECK_REQUEST_ALLOWANCE);
  check.keep("www.example.com");
  for (const payload of stream) {
    inspection.observe(payload);
    check.observe(payload);
    inspection.notePageRequest(payload.request.url);
  }
  // Two groups, each one request, the same hosts, two different scripts.
  const groups = inspection.evidence()?.groups ?? [];
  assert.deepEqual(groups.map((group) => [group.count, group.hosts, group.namedScripts.length]), [[1, ["cdn.example.net"], 1], [1, ["cdn.example.net"], 1]]);
  assert.notDeepEqual(groups[0].namedScripts, groups[1].namedScripts);
  const [entry] = check.entries([{ host: "pixel.example.net", requests: [pixel("a"), pixel("b")].map((url) => ({ url, counted: true })) }]) ?? [];
  assert.deepEqual(entry?.groups, [{ count: 2, hosts: ["cdn.example.net"] }]);
});

test("every recorder publishes through this module and restates none of its rules", () => {
  for (const file of ["lib/connection-inspection.ts", "lib/scroll-check-stacks.ts"]) {
    const source = read(file);
    assert.match(source, /from "\.\/call-stack-publisher";/, `${file} does not publish through the shared module`);
    for (const [rule, pattern] of [
      ["reads a stack's frames", /callFrames/],
      ["reads a redirect hop", /redirectResponse/],
      ["reads a preflight", /"preflight"/],
      ["hashes a long URL", /sha256/],
      ["publishes a host", /redactHostnameV2/],
      ["defines its own publisher", /function (?:heldUrlKey|stackFrameUrls|publishedStack|publishedHost|publishedScript|withoutFragment)\b/]
    ] as const) {
      assert.ok(!pattern.test(source), `${file} ${rule} itself instead of through lib/call-stack-publisher.ts`);
    }
  }
});
