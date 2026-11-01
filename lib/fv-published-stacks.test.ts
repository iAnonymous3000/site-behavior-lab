import assert from "node:assert/strict";
import { test } from "node:test";
import * as productionPublisher from "./call-stack-publisher";
import {
  heldUrlKey,
  MAX_REQUESTED_CODE_URLS,
  observedRequest,
  publishedHost,
  publishedScript,
  RequestedCodeUrls,
  type PublishedStack,
  type StackObservationCategory
} from "./call-stack-publisher";
import { MAX_INSPECTION_GROUP_HOSTS, MAX_INSPECTION_GROUP_SCRIPTS } from "./connection-inspection-evidence";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";

/**
 * RA3, a bounded check of what one call stack publishes, and of what a recorder
 * does past its bound on requested addresses.
 *
 * Domain, hosts only and with scripts: every stack of up to 6 frames over 9 symbols,
 * namely five hosts, one of them with two scripts, a frame the visit did not request on
 * a requested host, one on another host, and an empty frame URL. Six frames is the
 * shortest stack that can reach a fifth host and go on. publishedHost and publishedScript
 * are taken as given, so a regression in either moves both sides here, and this says
 * nothing of how a real address redacts. Whether Chromium ever sends a given stack is a
 * measurement.
 */

type Publisher = typeof productionPublisher;

const ALPHA_ONE = "https://cdn.alpha.net/one.js";
const ALPHA_TWO = "https://cdn.alpha.net/lib/two.js";
const BRAVO = "https://cdn.bravo.org/b.js";
const CHARLIE = "https://cdn.charlie.com/c.js";
const DELTA = "https://cdn.delta.net/d.js";
const ECHO = "https://cdn.echo.net/e.js";
const UNREQUESTED_ON_A_REQUESTED_HOST = "https://cdn.alpha.net/forged.js";
const UNREQUESTED_ELSEWHERE = "https://forged.foxtrot.net/named.js";

const REQUESTED = [ALPHA_ONE, ALPHA_TWO, BRAVO, CHARLIE, DELTA, ECHO];
const SYMBOLS = [...REQUESTED, UNREQUESTED_ON_A_REQUESTED_HOST, UNREQUESTED_ELSEWHERE, ""];
const REQUESTED_SET: ReadonlySet<string> = new Set(REQUESTED);
const HOST_OF = new Map(REQUESTED.map((url) => [url, publishedHost(url)]));
const SCRIPT_OF = new Map(REQUESTED.map((url) => [url, publishedScript(url)]));

function requestedCodeUrls(publisher: Publisher): RequestedCodeUrls {
  const code = new publisher.RequestedCodeUrls();
  for (const url of REQUESTED) code.note(heldUrlKey(url));
  return code;
}

/** Every sequence of up to `maximum` symbols, reusing one array: a stack is read and never kept. */
function eachStack(symbols: readonly string[], maximum: number, visit: (frames: string[]) => void): number {
  let cases = 0;
  const frames: string[] = [];
  const walk = () => {
    cases += 1;
    visit(frames);
    if (frames.length === maximum) return;
    for (const symbol of symbols) {
      frames.push(symbol);
      walk();
      frames.pop();
    }
  };
  walk();
  return cases;
}

function sequencesOf(alphabet: number, maximum: number): number {
  let total = 0;
  for (let length = 0; length <= maximum; length += 1) total += alphabet ** length;
  return total;
}

/**
 * The requested frames' hosts, consecutive repeats collapsed, for as long as a stack has
 * room. This restates the rule as the publisher's docblock has it, so it catches the code
 * drifting from that rule, not a wrong rule.
 */
function hostsSpec(frames: readonly string[]): string[] {
  const collapsed: string[] = [];
  for (const frame of frames) {
    if (!REQUESTED_SET.has(frame)) continue;
    const host = HOST_OF.get(frame) as string;
    if (collapsed.at(-1) !== host) collapsed.push(host);
  }
  return collapsed.slice(0, MAX_INSPECTION_GROUP_HOSTS);
}

function holdsForHosts(published: PublishedStack | null, frames: readonly string[]): void {
  const input = () => ({ frames: [...frames], published });
  const requestedFrames = frames.filter((frame) => REQUESTED_SET.has(frame));
  holds("a-stack-publishes-nothing-only-without-a-requested-frame", (published === null) === (requestedFrames.length === 0), input);
  if (published === null) return;
  const { hosts } = published;
  holds("a-stack-holds-at-most-four-hosts", hosts.length <= MAX_INSPECTION_GROUP_HOSTS, input);
  holds("a-stack-repeats-no-host-consecutively", hosts.every((host, index) => index === 0 || hosts[index - 1] !== host), input);
  const hostsOfRequested = requestedFrames.map((frame) => HOST_OF.get(frame));
  holds("every-host-comes-from-a-requested-frame", hosts.every((host) => hostsOfRequested.includes(host)), input);
  holds("hosts-run-innermost-first", JSON.stringify(hosts) === JSON.stringify(hostsSpec(frames)), input);
}

/**
 * With hosts only, as a check after scrolling publishes, and with a filled host
 * cache, so the walk is over the rule and not over redaction. The cache's own
 * claim to change nothing is held by checkCacheChangesNothing below.
 */
function checkHostsOnly(publisher: Publisher): number {
  const code = requestedCodeUrls(publisher);
  const hostCache = new Map<string, string>();
  for (const url of REQUESTED) hostCache.set(heldUrlKey(url), HOST_OF.get(url) as string);
  for (const url of [UNREQUESTED_ON_A_REQUESTED_HOST, UNREQUESTED_ELSEWHERE]) hostCache.set(heldUrlKey(url), publishedHost(url));
  return eachStack(SYMBOLS, 6, (frames) => {
    const published = publisher.publishedStack(frames, code, { scripts: false, hostCache });
    holdsForHosts(published, frames);
    holds("a-hosts-only-recorder-names-no-script", published === null || published.namedScripts.length === 0, () => ({ frames: [...frames], published }));
  });
}

/** The scripts a stack names: its requested frames' own, once each, up to the one that would have been a fifth host. */
function scriptsSpec(frames: readonly string[]): string[] {
  const scripts: string[] = [];
  const hosts: string[] = [];
  for (const frame of frames) {
    if (!REQUESTED_SET.has(frame)) continue;
    const host = HOST_OF.get(frame) as string;
    if (hosts.at(-1) !== host) {
      if (hosts.length === MAX_INSPECTION_GROUP_HOSTS) break;
      hosts.push(host);
    }
    const script = SCRIPT_OF.get(frame) as string;
    if (!scripts.includes(script)) scripts.push(script);
  }
  return scripts;
}

function checkWithScripts(publisher: Publisher): number {
  const code = requestedCodeUrls(publisher);
  return eachStack(SYMBOLS, 6, (frames) => {
    const published = publisher.publishedStack(frames, code, { scripts: true });
    holdsForHosts(published, frames);
    const scripts = published?.namedScripts ?? [];
    const input = () => ({ frames: [...frames], published });
    holds("a-stack-names-each-script-once", new Set(scripts).size === scripts.length, input);
    const requestedScripts = frames.filter((frame) => REQUESTED_SET.has(frame)).map((frame) => SCRIPT_OF.get(frame));
    holds("every-script-comes-from-a-requested-frame", scripts.every((script) => requestedScripts.includes(script)), input);
    // This restates the rule as the publisher's docblock has it, so it catches the
    // code drifting from that rule, not a wrong rule. The fifth-host stop is the point.
    holds("scripts-stop-where-hosts-stop", JSON.stringify(scripts) === JSON.stringify(scriptsSpec(frames)), input);
  });
}

/** A URL too long to hold as itself, so the cache's key is not the URL. */
const LONG = `https://cdn.india.net/long.js?x=${"a".repeat(3_000)}`;

function checkCacheChangesNothing(publisher: Publisher): number {
  const code = requestedCodeUrls(publisher);
  code.note(heldUrlKey(LONG));
  const hostCache = new Map<string, string>();
  return eachStack([ALPHA_ONE, ALPHA_TWO, BRAVO, LONG, UNREQUESTED_ELSEWHERE, ""], 4, (frames) => {
    const plain = publisher.publishedStack(frames, code, { scripts: false });
    // Twice, so the second reads what the first left behind.
    publisher.publishedStack(frames, code, { scripts: false, hostCache });
    const cached = publisher.publishedStack(frames, code, { scripts: false, hostCache });
    holds("a-host-cache-changes-nothing", JSON.stringify(cached) === JSON.stringify(plain), () => ({ frames: [...frames], plain, cached }));
  });
}

/** More distinct scripts than a stack keeps, across the four hosts it keeps: the first ones stay. */
function checkScriptBound(publisher: Publisher): number {
  let cases = 0;
  // A script's address publishes by its path's shape, so these differ by depth and by host.
  const scripts = ["cdn.alpha.net", "cdn.bravo.org", "cdn.charlie.com", "cdn.delta.net"].flatMap((host) =>
    ["a.js", "p/a.js", "p/q/a.js"].map((path) => `https://${host}/${path}`)
  );
  const distinct = new Set(scripts.map(publishedScript));
  assert.equal(distinct.size, scripts.length, "the bound needs that many scripts that publish differently");
  const code = new publisher.RequestedCodeUrls();
  for (const url of scripts) code.note(heldUrlKey(url));
  for (let count = 0; count <= scripts.length; count += 1) {
    cases += 1;
    const frames = [...scripts.slice(0, count), ...scripts.slice(0, count)];
    const named = publisher.publishedStack(frames, code, { scripts: true })?.namedScripts ?? [];
    holds(
      "a-stack-keeps-its-first-eight-scripts",
      JSON.stringify(named) === JSON.stringify(scripts.slice(0, Math.min(count, MAX_INSPECTION_GROUP_SCRIPTS)).map(publishedScript)),
      () => ({ count, named })
    );
  }
  return cases;
}

/** A requested frame whose address cannot be published still lists its host, and names no script. */
function checkUnpublishableScript(publisher: Publisher): number {
  const blob = "blob:https://cdn.alpha.net/worker";
  assert.equal(publishedScript(blob), null);
  const code = requestedCodeUrls(publisher);
  code.note(heldUrlKey(blob));
  const published = publisher.publishedStack([blob, ALPHA_ONE], code, { scripts: true });
  holds(
    "a-frame-with-no-published-address-names-no-script",
    JSON.stringify(published) === JSON.stringify({ hosts: [publishedHost(blob), HOST_OF.get(ALPHA_ONE)], namedScripts: [SCRIPT_OF.get(ALPHA_ONE)] }),
    () => ({ published })
  );
  return 1;
}

type StackShape = "absent" | "empty" | "named" | "unnamed";

function stackFor(shape: StackShape): unknown {
  if (shape === "absent") return undefined;
  if (shape === "empty") return { callFrames: [] };
  return { callFrames: [{ url: shape === "named" ? ALPHA_ONE : UNREQUESTED_ELSEWHERE, functionName: "f" }] };
}

/**
 * A redirect hop is counted apart first, then a request with no stack, and only
 * then the bound: past it a frame's script may be one the recorder no longer holds,
 * so nothing is named from there on, and a request is not listed rather than unnamed.
 * This restates the publisher's order, so it catches the code drifting from that order,
 * not a wrong order.
 */
function expectedCategory(redirect: boolean, shape: StackShape, overflowed: boolean, group: string): StackObservationCategory {
  if (redirect) return "redirected";
  if (shape === "absent" || shape === "empty") return "withoutStack";
  if (overflowed) return "notListed";
  return shape === "named" ? { group } : "withoutNamedScript";
}

function overflowedCode(publisher: Publisher): RequestedCodeUrls {
  const code = requestedCodeUrls(publisher);
  // Bounded, so a set that never says it overflowed fails the check and does not hang it.
  for (let index = 0; index <= MAX_REQUESTED_CODE_URLS && !code.overflowed; index += 1) code.note(`https://code.example/${index}`);
  return code;
}

function checkCategories(publisher: Publisher): number {
  let cases = 0;
  const open = requestedCodeUrls(publisher);
  const full = overflowedCode(publisher);
  for (const redirect of [false, true]) {
    for (const shape of ["absent", "empty", "named", "unnamed"] as const) {
      for (const overflowed of [false, true]) {
        cases += 1;
        const params = {
          request: { url: "https://pixel.example.net/p" },
          type: "Fetch",
          initiator: { type: "script", stack: stackFor(shape) },
          ...(redirect ? { redirectResponse: { status: 302 } } : {})
        };
        const observed = observedRequest(params);
        assert.ok(observed);
        const stacks = new Map<string, PublishedStack>();
        const category = publisher.categorizeObservation(observed, overflowed ? full : open, stacks, (stack) => JSON.stringify(stack.hosts));
        const group = JSON.stringify([HOST_OF.get(ALPHA_ONE)]);
        const input = () => ({ redirect, shape, overflowed, category });
        holds("an-observation-falls-in-its-own-category", JSON.stringify(category) === JSON.stringify(expectedCategory(redirect, shape, overflowed, group)), input);
        holds("a-group-keeps-the-stack-that-keyed-it", typeof category === "string" ? stacks.size === 0 : JSON.stringify(stacks.get(group)?.hosts) === group, input);
      }
    }
  }
  return cases;
}

function checkCodeBound(publisher: Publisher): number {
  let cases = 0;
  const code = new publisher.RequestedCodeUrls();
  for (let index = 0; index < MAX_REQUESTED_CODE_URLS; index += 1) {
    cases += 1;
    code.note(`https://code.example/${index}`);
    holds("the-code-set-holds-to-its-bound", !code.overflowed, () => ({ index }));
  }
  // Noting an address it already holds is not past the bound.
  code.note("https://code.example/0");
  holds("the-code-set-holds-to-its-bound", !code.overflowed, () => ({ note: "a known address" }));
  code.note("https://code.example/past-the-bound");
  holds("the-code-set-says-when-it-overflowed", code.overflowed, () => ({ note: "one past the bound" }));
  holds("the-code-set-holds-nothing-past-its-bound", !code.has("https://code.example/past-the-bound") && code.has("https://code.example/0"), () => ({ note: "one past the bound" }));
  return cases;
}

const publisherPath = require.resolve("./call-stack-publisher");
const variant = (...edits: SourceEdit[]) => loadVariant<Publisher>(publisherPath, edits);

test("the symbols span the bound: five hosts, one with two scripts, and frames the visit did not request", () => {
  assert.equal(new Set(HOST_OF.values()).size, 5);
  assert.equal(HOST_OF.get(ALPHA_ONE), HOST_OF.get(ALPHA_TWO));
  assert.notEqual(SCRIPT_OF.get(ALPHA_ONE), SCRIPT_OF.get(ALPHA_TWO));
  assert.equal(publishedHost(UNREQUESTED_ON_A_REQUESTED_HOST), HOST_OF.get(ALPHA_ONE));
  assert.equal(SYMBOLS.length, 9);
  assert.equal(MAX_INSPECTION_GROUP_HOSTS, 4);
  assert.equal(MAX_INSPECTION_GROUP_SCRIPTS, 8);
});

test("RA3: a stack publishes only requested frames' hosts, at most four, innermost first, no consecutive repeat", () => {
  assert.equal(checkHostsOnly(productionPublisher), sequencesOf(9, 6));
});

test("RA3: a stack names each script once, and stops naming where it stops listing hosts", () => {
  assert.equal(checkWithScripts(productionPublisher), sequencesOf(9, 6));
});

test("RA3: a recorder's host cache changes nothing it publishes", () => {
  assert.equal(checkCacheChangesNothing(productionPublisher), sequencesOf(6, 4));
});

test("RA3: a stack keeps its first eight scripts, however many it holds", () => {
  assert.equal(checkScriptBound(productionPublisher), 13);
});

test("RA3: a frame with no published address lists its host and names no script", () => {
  assert.equal(checkUnpublishableScript(productionPublisher), 1);
});

test("RA3: every observation falls in its one category, and past the code bound nothing is named", () => {
  assert.equal(checkCategories(productionPublisher), 2 * 4 * 2);
});

test("RA3: the code set holds to its bound and says when it has gone past it", () => {
  assert.equal(checkCodeBound(productionPublisher), MAX_REQUESTED_CODE_URLS);
});

test("RA3: a URL too long to hold as itself is still named, by its digest", () => {
  const long = `https://cdn.alpha.net/long.js?x=${"a".repeat(3_000)}`;
  assert.match(heldUrlKey(long), /^sha256:/);
  const code = new RequestedCodeUrls();
  code.note(heldUrlKey(long));
  assert.deepEqual(productionPublisher.publishedStack([long], code, { scripts: false })?.hosts, [HOST_OF.get(ALPHA_ONE)]);
  assert.equal(productionPublisher.publishedStack([`${long}b`], code, { scripts: false }), null);
});

for (const [name, property, edit] of [
  [
    "a frame the visit did not request is named",
    "every-host-comes-from-a-requested-frame",
    { find: "if (!code.has(key))\n            continue;\n", replace: "" }
  ],
  [
    "a stack with nothing to name still publishes",
    "a-stack-publishes-nothing-only-without-a-requested-frame",
    { find: "return hosts.length === 0 ? null : { hosts, namedScripts };", replace: "return { hosts, namedScripts };" }
  ],
  [
    "a consecutive repeat is kept",
    "a-stack-repeats-no-host-consecutively",
    { find: "if (hosts.at(-1) !== host) {", replace: "if (true) {" }
  ],
  [
    "a fifth host is kept",
    "a-stack-holds-at-most-four-hosts",
    { find: "hosts.length === connection_inspection_evidence_1.MAX_INSPECTION_GROUP_HOSTS", replace: "hosts.length === 5" }
  ],
  [
    "a stack stops at its third host",
    "hosts-run-innermost-first",
    { find: "hosts.length === connection_inspection_evidence_1.MAX_INSPECTION_GROUP_HOSTS", replace: "hosts.length === 3" }
  ],
  [
    "outer frames replace inner ones",
    "hosts-run-innermost-first",
    { find: "for (const frameUrl of frames) {", replace: "for (const frameUrl of [...frames].reverse()) {" }
  ],
  [
    "a hosts-only recorder names scripts",
    "a-hosts-only-recorder-names-no-script",
    { find: "if (!publishing.scripts)\n            continue;\n", replace: "" }
  ]
] as const) {
  test(`RA3 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkHostsOnly(variant(edit)));
  });
}

for (const [name, property, edit] of [
  [
    "a script is named twice",
    "a-stack-names-each-script-once",
    { find: "script !== null && !namedScripts.includes(script) && ", replace: "script !== null && " }
  ],
  [
    "a frame the visit did not request names its script",
    "every-script-comes-from-a-requested-frame",
    {
      find: "if (!code.has(key))\n            continue;\n",
      replace: "if (!code.has(key)) {\n            if (publishing.scripts) {\n                const unrequested = publishedScript(frameUrl);\n                if (unrequested !== null && !namedScripts.includes(unrequested))\n                    namedScripts.push(unrequested);\n            }\n            continue;\n        }\n"
    }
  ],
  [
    "a frame past the fifth host still names its script",
    "scripts-stop-where-hosts-stop",
    { find: "if (hosts.length === connection_inspection_evidence_1.MAX_INSPECTION_GROUP_HOSTS)\n                break;", replace: "if (hosts.length === connection_inspection_evidence_1.MAX_INSPECTION_GROUP_HOSTS)\n                continue;" }
  ]
] as const) {
  test(`RA3 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkWithScripts(variant(edit)));
  });
}

test("RA3 catches a variant: the script bound is gone", async () => {
  const broken = variant({ find: " && namedScripts.length < connection_inspection_evidence_1.MAX_INSPECTION_GROUP_SCRIPTS", replace: "" });
  await assertCaughtBy("the script bound is gone", "a-stack-keeps-its-first-eight-scripts", () => checkScriptBound(broken));
});

test("RA3 catches a variant: a frame with no published address names a script", async () => {
  const broken = variant({ find: "if (script !== null && !namedScripts.includes(script)", replace: "if (!namedScripts.includes(script)" });
  await assertCaughtBy("an unpublishable script is named", "a-frame-with-no-published-address-names-no-script", () => checkUnpublishableScript(broken));
});

test("RA3 catches a variant: the host cache reads the held key and not the URL", async () => {
  const broken = variant({ find: "const host = publishedHost(frameUrl);\n    // Only requested", replace: "const host = publishedHost(key);\n    // Only requested" });
  await assertCaughtBy("the cache reads the key", "a-host-cache-changes-nothing", () => checkCacheChangesNothing(broken));
});

test("RA3 catches a variant: the host cache keeps a different host", async () => {
  const broken = variant({ find: "cache.set(key, host);", replace: 'cache.set(key, `${host}-cached`);' });
  await assertCaughtBy("the cache keeps a different host", "a-host-cache-changes-nothing", () => checkCacheChangesNothing(broken));
});

for (const [name, find, replace] of [
  ["past the code bound, a stack still names", 'if (code.overflowed)\n        return "notListed";\n', ""],
  ["a redirect hop reads its chain's stack", 'if ((0, guards_1.isRecord)(observed.params.redirectResponse))\n        return "redirected";\n', ""],
  ["a request with no stack reads as unnamed", 'if (frames === null)\n        return "withoutStack";', 'if (frames === null)\n        return "withoutNamedScript";']
] as const) {
  test(`RA3 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, "an-observation-falls-in-its-own-category", () => checkCategories(variant({ find, replace })));
  });
}

test("RA3 catches a variant: a group forgets the stack that keyed it", async () => {
  const broken = variant({ find: "if (!stacks.has(key))\n        stacks.set(key, published);\n", replace: "" });
  await assertCaughtBy("a group forgets its stack", "a-group-keeps-the-stack-that-keyed-it", () => checkCategories(broken));
});

for (const [name, property, find, replace] of [
  ["the code set overflows early", "the-code-set-holds-to-its-bound", "if (this.keys.size >= exports.MAX_REQUESTED_CODE_URLS) {", "if (this.keys.size >= exports.MAX_REQUESTED_CODE_URLS - 1) {"],
  ["a known address counts against the bound", "the-code-set-holds-to-its-bound", "if (this.keys.has(key))\n            return;\n", ""],
  ["the code set never says it overflowed", "the-code-set-says-when-it-overflowed", "this.full = true;", "this.full = false;"],
  ["the code set keeps what it says it lost", "the-code-set-holds-nothing-past-its-bound", "this.full = true;\n            return;", "this.full = true;"]
] as const) {
  test(`RA3 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkCodeBound(variant({ find, replace })));
  });
}
