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
import { MAX_INSPECTION_CODE_URLS, MAX_INSPECTION_STACK_FRAMES } from "./connection-inspection";
import { MAX_INSPECTION_GROUP_HOSTS } from "./connection-inspection-evidence";
import { redactHostnameV2 } from "./redaction-v2";

/**
 * The one stack publisher (lib/call-stack-publisher.ts), on its own: the
 * rules every recorder that publishes call stacks shares, and the pin that
 * holds each recorder to it rather than to a restatement of its own.
 * lib/connection-inspection.test.ts and its fixture hold Inspect's evidence
 * to what it has always been.
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

test("every recorder publishes through this module and restates none of its rules", () => {
  for (const file of ["lib/connection-inspection.ts"]) {
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
