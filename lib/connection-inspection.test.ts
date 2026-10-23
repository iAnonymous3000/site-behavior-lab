import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConnectionInspectionRecorder,
  isInspectableAddress,
  MAX_INSPECTION_CODE_URLS,
  MAX_INSPECTION_OBSERVATIONS,
  MAX_INSPECTION_STACK_FRAMES,
  MAX_INSPECTION_TRACKED_URLS
} from "./connection-inspection";
import {
  isConnectionInspectionEvidence,
  MAX_INSPECTION_GROUPS,
  type ConnectionInspectionEvidence
} from "./connection-inspection-evidence";

/**
 * The inspection builder over Chromium-shaped `Network.requestWillBeSent`
 * payloads that carry every page-controlled or browser-assigned string a
 * stack can hold. lib/connection-inspection-fixture.test.ts feeds it
 * Chromium's own payloads through the scanner.
 */

const ADDRESS = "https://pixel.example.net/{seg}";
const PAGE = "https://www.example.com/";
const PIXEL = "https://pixel.example.net/p.gif";

type Frame = { url: string; functionName?: string };

let nextRequestId = 1000;

/** One payload, with ids, positions and names a builder must never publish. */
function sent(
  url: string,
  options: {
    type?: string;
    initiatorType?: string;
    frames?: Frame[];
    redirect?: boolean;
  } = {}
): Record<string, unknown> {
  nextRequestId += 1;
  const initiator: Record<string, unknown> = { type: options.initiatorType ?? (options.frames ? "script" : "parser") };
  if (options.frames) {
    initiator.stack = {
      callFrames: options.frames.map((frame, index) => ({
        functionName: frame.functionName ?? `pageChosenFunction${index}`,
        scriptId: `SCRIPT-ID-${9000 + index}`,
        url: frame.url,
        lineNumber: 4242 + index,
        columnNumber: 1717 + index
      }))
    };
  } else if (initiator.type === "parser") {
    initiator.url = PAGE;
    initiator.lineNumber = 31337;
  }
  return {
    requestId: `REQUEST-ID-${nextRequestId}`,
    loaderId: "LOADER-ID-ABC",
    frameId: "FRAME-ID-XYZ",
    documentURL: PAGE,
    request: { url, method: "GET", headers: { "X-Frame-Name": "frame-name-from-page" } },
    timestamp: 12.5,
    wallTime: 1700000000,
    initiator,
    type: options.type ?? "Image",
    ...(options.redirect ? { redirectResponse: { url: `${PIXEL}?hop=1`, status: 302, headers: {} } } : {})
  };
}

/** A recorder that has seen the page's document and the given scripts requested. */
function recorderWithCode(scripts: string[] = []): ConnectionInspectionRecorder {
  const recorder = new ConnectionInspectionRecorder(ADDRESS);
  recorder.observe(sent(PAGE, { type: "Document", initiatorType: "other" }));
  recorder.notePageRequest(PAGE);
  for (const script of scripts) {
    recorder.observe(sent(script, { type: "Script" }));
    recorder.notePageRequest(script);
  }
  return recorder;
}

/** A matched request seen by both streams. */
function both(recorder: ConnectionInspectionRecorder, payload: Record<string, unknown>): void {
  recorder.observe(payload);
  recorder.notePageRequest((payload.request as { url: string }).url);
}

function evidenceOf(recorder: ConnectionInspectionRecorder): ConnectionInspectionEvidence {
  const evidence = recorder.evidence();
  assert.ok(evidence, "the recorder produced no evidence");
  // Every output the builder produces is one the readers' validator accepts.
  assert.equal(isConnectionInspectionEvidence(evidence), true, JSON.stringify(evidence));
  return evidence;
}

test("an inspected address must be a published address with no query, as redaction writes it", () => {
  for (const accepted of [
    ADDRESS,
    "https://www.googletagmanager.com/{seg}",
    "https://{label}.example.com/{n}/api",
    "http://cdn.example.net/",
    "https://{label}.netlify.app/{seg}"
  ]) {
    assert.equal(isInspectableAddress(accepted), true, accepted);
  }
  for (const refused of [
    `${ADDRESS}?id=`,
    `${ADDRESS}#frag`,
    "https://pixel.example.net:8443/{seg}",
    "https://user@pixel.example.net/{seg}",
    "https://Pixel.example.net/{seg}",
    "https://pixel.example.net/{seg}/",
    "https://pixel.example.net/p.gif",
    "https://x9.example.net/{seg}",
    "https://203.0.113.9/{seg}",
    "{invalid-url}",
    "ftp://pixel.example.net/{seg}",
    "https://localhost/{seg}",
    "https://pixel.example.net/{seg}/{seg}/{seg}/{seg}/{seg}/{seg}/{seg}",
    `https://${"a".repeat(600)}.example.net/{seg}`,
    "",
    42
  ]) {
    assert.equal(isInspectableAddress(refused), false, String(refused));
  }
  assert.throws(() => new ConnectionInspectionRecorder(`${ADDRESS}?id=`), /published address with no query/);
});

test("a stack publishes at most four hosts, innermost first, with consecutive repeats collapsed", () => {
  const tag = "https://static.example.org/tag.js";
  const loader = "https://cdn.example.net/loader.js";
  const vendor = "https://cdn.example.com/vendor.js";
  const wrapper = "https://cdn2.example.org/wrap.js";
  const recorder = recorderWithCode([tag, loader, vendor, wrapper]);
  both(
    recorder,
    sent(`${PIXEL}?via=chain`, {
      frames: [
        { url: tag },
        { url: tag },
        { url: loader },
        { url: vendor },
        { url: wrapper },
        // A fifth host: the page's own inline code, past the bound.
        { url: PAGE }
      ]
    })
  );
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 1);
  assert.deepEqual(evidence.groups, [
    {
      count: 1,
      hosts: ["static.example.org", "cdn.example.net", "cdn.example.com", "cdn2.example.org"],
      namedScripts: [
        "https://static.example.org/{seg}",
        "https://cdn.example.net/{seg}",
        "https://cdn.example.com/{seg}",
        "https://cdn2.example.org/{seg}"
      ]
    }
  ]);
});

test("a host repeats when another host's frames sit between its own", () => {
  const tag = "https://static.example.org/tag.js";
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([tag, loader]);
  both(recorder, sent(PIXEL, { frames: [{ url: tag }, { url: loader }, { url: tag }] }));
  assert.deepEqual(evidenceOf(recorder).groups[0].hosts, ["static.example.org", "cdn.example.net", "static.example.org"]);
});

test("a script is named only when its frame's address is one the visit requested as a script or document", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  // A stylesheet the visit requested does not name a frame.
  recorder.observe(sent("https://fonts.example.org/style.css", { type: "Stylesheet" }));
  both(
    recorder,
    sent(PIXEL, {
      frames: [
        // A sourceURL name nothing requested, an unnamed eval, a stylesheet's
        // address and a relative name: none is named.
        { url: "https://forged.example.com/named.js", functionName: "forgedName" },
        { url: "" },
        { url: "https://fonts.example.org/style.css" },
        { url: "/_/mss/boq-content-ads-contrib" },
        { url: loader }
      ]
    })
  );
  // A sourceURL name that IS a requested script's address is named.
  both(recorder, sent(`${PIXEL}?via=pragma`, { frames: [{ url: loader, functionName: "evalFromPragma" }] }));
  // A stack with no requested address names nothing.
  both(recorder, sent(`${PIXEL}?via=unnamed`, { frames: [{ url: "" }, { url: "https://forged.example.com/named.js" }] }));
  const evidence = evidenceOf(recorder);
  assert.deepEqual(evidence.groups, [
    { count: 2, hosts: ["cdn.example.net"], namedScripts: ["https://cdn.example.net/{seg}"] }
  ]);
  assert.equal(evidence.withoutNamedScript, 1);
  assert.equal(JSON.stringify(evidence).includes("forged"), false);
  assert.equal(JSON.stringify(evidence).includes("fonts"), false);
});

test("a frame is named only by an address requested before the request was made", () => {
  const late = "https://cdn.example.net/late.js";
  const recorder = recorderWithCode([]);
  both(recorder, sent(PIXEL, { frames: [{ url: late }] }));
  recorder.observe(sent(late, { type: "Script" }));
  const evidence = evidenceOf(recorder);
  assert.deepEqual(evidence.groups, []);
  assert.equal(evidence.withoutNamedScript, 1);
});

test("no function name, position, id, frame name, query, depth or IP literal reaches the evidence", () => {
  const scriptWithQuery = "https://cdn.example.net/loader.js?session=FRAME-QUERY-SECRET";
  const ipScript = "http://203.0.113.9/lib.js";
  const recorder = recorderWithCode([scriptWithQuery, ipScript]);
  const secretQuery = `?token=LONG-QUERY-SECRET-${"x".repeat(4000)}&email=alice%40example.com`;
  both(
    recorder,
    sent(`${PIXEL}${secretQuery}`, {
      frames: [
        { url: ipScript, functionName: "ipHostedFunction" },
        { url: `${scriptWithQuery}#fragment-secret`, functionName: "loaderFunction" },
        ...Array.from({ length: 40 }, () => ({ url: scriptWithQuery, functionName: "deepRecursion" }))
      ]
    })
  );
  const evidence = evidenceOf(recorder);
  assert.deepEqual(evidence.groups, [
    { count: 1, hosts: ["{invalid-host}", "cdn.example.net"], namedScripts: ["https://cdn.example.net/{seg}"] }
  ]);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of [
    "pageChosenFunction",
    "ipHostedFunction",
    "loaderFunction",
    "deepRecursion",
    "SCRIPT-ID",
    "REQUEST-ID",
    "LOADER-ID",
    "FRAME-ID",
    "frame-name-from-page",
    "4242",
    "1717",
    "31337",
    "LONG-QUERY-SECRET",
    "alice",
    "FRAME-QUERY-SECRET",
    "fragment-secret",
    "203.0.113.9",
    "lib.js",
    "?",
    "#",
    "42"
  ]) {
    assert.equal(serialized.includes(forbidden), false, `the evidence carries ${forbidden}`);
  }
  // The shape is closed: these keys and nothing else.
  assert.deepEqual(Object.keys(evidence).sort(), [
    "address",
    "groups",
    "matched",
    "notListed",
    "redirected",
    "unobserved",
    "withoutNamedScript",
    "withoutStack"
  ]);
  assert.deepEqual(Object.keys(evidence.groups[0]).sort(), ["count", "hosts", "namedScripts"]);
});

test("a visit that made no request to the address reports zero matched", () => {
  const recorder = recorderWithCode(["https://cdn.example.net/loader.js"]);
  both(recorder, sent("https://other.example.org/p.gif", { frames: [{ url: "https://cdn.example.net/loader.js" }] }));
  both(recorder, sent("https://pixel.example.net/a/b", { frames: [{ url: "https://cdn.example.net/loader.js" }] }));
  assert.deepEqual(evidenceOf(recorder), {
    address: ADDRESS,
    matched: 0,
    groups: [],
    redirected: 0,
    withoutStack: 0,
    withoutNamedScript: 0,
    notListed: 0,
    unobserved: 0
  });
});

test("parser, preload and browser-started requests are counted without a stack", () => {
  const recorder = recorderWithCode([]);
  both(recorder, sent(`${PIXEL}?via=html`));
  both(recorder, sent(`${PIXEL}?via=preload`, { initiatorType: "preload" }));
  both(recorder, sent(`${PIXEL}?via=other`, { initiatorType: "other" }));
  // A script initiator with an empty stack has no call stack either.
  const emptyStack = sent(`${PIXEL}?via=empty`, { frames: [] });
  both(recorder, emptyStack);
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 4);
  assert.equal(evidence.withoutStack, 4);
  assert.deepEqual(evidence.groups, []);
});

test("a redirect hop is counted apart, never under the stack of the request that started it", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  both(recorder, sent("https://pixel.example.net/redirect?to=p", { frames: [{ url: loader }] }));
  both(recorder, sent(`${PIXEL}?hop=1`, { frames: [{ url: loader }], redirect: true }));
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 2);
  assert.equal(evidence.redirected, 1);
  assert.deepEqual(evidence.groups, [{ count: 1, hosts: ["cdn.example.net"], namedScripts: ["https://cdn.example.net/{seg}"] }]);
});

test("a CORS preflight is the browser's own request and joins nothing", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  // The preflight arrives first, for the same URL, and the page reports only
  // the request itself.
  recorder.observe(sent(`${PIXEL}?cors=1`, { initiatorType: "preflight", type: "Preflight" }));
  both(recorder, sent(`${PIXEL}?cors=1`, { frames: [{ url: loader }], type: "Fetch" }));
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 1);
  assert.equal(evidence.withoutStack, 0);
  assert.deepEqual(evidence.groups.map((group) => group.count), [1]);
});

test("requests the session never observed are counted as unobserved, so a worker's connection still counts", () => {
  const recorder = recorderWithCode([]);
  // A dedicated worker's request reaches the page's request events only.
  recorder.notePageRequest(`${PIXEL}?via=worker`);
  recorder.notePageRequest(`${PIXEL}?via=worker`);
  both(recorder, sent(`${PIXEL}?via=html`));
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 3);
  assert.equal(evidence.unobserved, 2);
  assert.equal(evidence.withoutStack, 1);
});

test("observations of a URL beyond the page's own count for it are not joined", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  recorder.observe(sent(PIXEL));
  recorder.observe(sent(PIXEL, { frames: [{ url: loader }] }));
  recorder.observe(sent(PIXEL, { frames: [{ url: loader }] }));
  recorder.notePageRequest(PIXEL);
  recorder.notePageRequest(PIXEL);
  const evidence = evidenceOf(recorder);
  // The first two observations, in arrival order, for the two requests.
  assert.equal(evidence.matched, 2);
  assert.equal(evidence.withoutStack, 1);
  assert.deepEqual(evidence.groups.map((group) => group.count), [1]);
  assert.equal(evidence.unobserved, 0);
});

test("the two streams join on the URL with its fragment dropped", () => {
  const recorder = recorderWithCode([]);
  recorder.observe(sent(PIXEL));
  recorder.notePageRequest(`${PIXEL}#from-the-page`);
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.withoutStack, 1);
  assert.equal(evidence.unobserved, 0);
});

test("a long request URL and a long script URL are still joined and still name their frames", () => {
  const longScript = `https://cdn.example.net/loader.js?config=${"c".repeat(8_000)}`;
  const longPixel = `${PIXEL}?payload=${"p".repeat(8_000)}`;
  const otherLongPixel = `${PIXEL}?payload=${"q".repeat(8_000)}`;
  const recorder = recorderWithCode([longScript]);
  both(recorder, sent(longPixel, { frames: [{ url: `${longScript}#frag` }] }));
  // Same length, other bytes: a URL of its own, observed by neither stream twice.
  recorder.notePageRequest(otherLongPixel);
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 2);
  assert.deepEqual(evidence.groups, [{ count: 1, hosts: ["cdn.example.net"], namedScripts: ["https://cdn.example.net/{seg}"] }]);
  assert.equal(evidence.unobserved, 1);
});

test("groups are listed largest first, at most twenty, and the rest are counted as not listed", () => {
  // Each script on its own host, so each publishes a stack of its own.
  const scripts = Array.from({ length: MAX_INSPECTION_GROUPS + 5 }, (_, index) => `https://cdn.example${index}.net/s.js`);
  const recorder = recorderWithCode(scripts);
  scripts.forEach((script, index) => {
    // Script n makes n + 1 requests, so the five smallest groups are cut.
    for (let request = 0; request <= index; request += 1) {
      both(recorder, sent(`${PIXEL}?g=${index}&r=${request}`, { frames: [{ url: script }] }));
    }
  });
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.groups.length, MAX_INSPECTION_GROUPS);
  assert.equal(evidence.groups[0].hosts[0], `cdn.example${MAX_INSPECTION_GROUPS + 4}.net`);
  assert.deepEqual(
    evidence.groups.map((group) => group.count),
    Array.from({ length: MAX_INSPECTION_GROUPS }, (_, index) => MAX_INSPECTION_GROUPS + 5 - index)
  );
  assert.equal(evidence.notListed, 1 + 2 + 3 + 4 + 5);
});

test("more matched URLs than the recorder tracks are counted as not listed", () => {
  const recorder = recorderWithCode([]);
  for (let index = 0; index <= MAX_INSPECTION_TRACKED_URLS; index += 1) {
    both(recorder, sent(`${PIXEL}?u=${index}`));
  }
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, MAX_INSPECTION_TRACKED_URLS + 1);
  assert.equal(evidence.withoutStack, MAX_INSPECTION_TRACKED_URLS);
  assert.equal(evidence.notListed, 1);
  assert.equal(evidence.unobserved, 0);
});

test("observations beyond the recorder's bound are counted as not listed, not as unobserved", () => {
  const recorder = recorderWithCode([]);
  for (let index = 0; index <= MAX_INSPECTION_OBSERVATIONS; index += 1) both(recorder, sent(PIXEL));
  // One more page request than observations: that one was never observed.
  recorder.notePageRequest(PIXEL);
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, MAX_INSPECTION_OBSERVATIONS + 2);
  assert.equal(evidence.withoutStack, MAX_INSPECTION_OBSERVATIONS);
  assert.equal(evidence.notListed, 1);
  assert.equal(evidence.unobserved, 1);
});

test("once more script addresses arrive than the recorder keeps, stacks are counted as not listed", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  both(recorder, sent(`${PIXEL}?before`, { frames: [{ url: loader }] }));
  for (let index = 0; index < MAX_INSPECTION_CODE_URLS; index += 1) {
    recorder.observe(sent(`https://cdn.example.net/many.js?i=${index}`, { type: "Script" }));
  }
  both(recorder, sent(`${PIXEL}?after`, { frames: [{ url: loader }] }));
  // A request with no stack is still broken down.
  both(recorder, sent(`${PIXEL}?html`));
  const evidence = evidenceOf(recorder);
  assert.deepEqual(evidence.groups.map((group) => group.count), [1]);
  assert.equal(evidence.notListed, 1);
  assert.equal(evidence.withoutStack, 1);
});

test("frames deeper than the recorder reads are not named", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  const frames = [...Array.from({ length: MAX_INSPECTION_STACK_FRAMES }, () => ({ url: "" })), { url: loader }];
  both(recorder, sent(PIXEL, { frames }));
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.withoutNamedScript, 1);
  assert.deepEqual(evidence.groups, []);
});

test("an async parent stack is never followed", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  const payload = sent(PIXEL, { frames: [{ url: "" }] });
  (payload.initiator as { stack: Record<string, unknown> }).stack.parent = {
    description: "setTimeout",
    callFrames: [{ functionName: "scheduler", scriptId: "1", url: loader, lineNumber: 1, columnNumber: 1 }]
  };
  both(recorder, payload);
  assert.equal(evidenceOf(recorder).withoutNamedScript, 1);
});

test("nothing is recorded after the evidence boundary", () => {
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([loader]);
  both(recorder, sent(PIXEL, { frames: [{ url: loader }] }));
  // The page reported this request before the boundary, and the session had
  // not observed it yet.
  recorder.notePageRequest(`${PIXEL}?late`);
  recorder.freeze();
  // Its observation arrives after the boundary, with traffic the visit's
  // evidence excludes: none of it is joined or counted.
  recorder.observe(sent(`${PIXEL}?late`, { frames: [{ url: loader }] }));
  both(recorder, sent(`${PIXEL}?after`, { frames: [{ url: loader }] }));
  recorder.notePageRequest(`${PIXEL}?after-page-only`);
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 2);
  assert.equal(evidence.unobserved, 1);
  assert.deepEqual(evidence.groups.map((group) => group.count), [1]);
});

test("two long URLs that share their first 2,048 characters are held apart", () => {
  const scriptPrefix = `https://cdn.example.net/loader.js?config=${"c".repeat(3_000)}`;
  const requested = `${scriptPrefix}&v=1`;
  const recorder = recorderWithCode([requested]);
  // A frame from a script the visit never requested is not named, however
  // much of its address it shares with one that was.
  both(recorder, sent(`${PIXEL}?a`, { frames: [{ url: `${scriptPrefix}&v=2` }] }));
  // And each long request URL joins only its own page count: one observed
  // twice and requested once, one requested and never observed.
  const pixelPrefix = `${PIXEL}?payload=${"p".repeat(3_000)}`;
  recorder.observe(sent(`${pixelPrefix}&n=1`));
  recorder.observe(sent(`${pixelPrefix}&n=1`, { frames: [{ url: requested }] }));
  recorder.notePageRequest(`${pixelPrefix}&n=1`);
  recorder.notePageRequest(`${pixelPrefix}&n=2`);
  const evidence = evidenceOf(recorder);
  assert.equal(evidence.matched, 3);
  assert.equal(evidence.withoutNamedScript, 1);
  assert.equal(evidence.withoutStack, 1);
  assert.equal(evidence.unobserved, 1);
  assert.deepEqual(evidence.groups, []);
});

test("the builder hands out no evidence its own readers would refuse", () => {
  // A recorder that reached a group it cannot publish (here, by a stack the
  // validator refuses) returns null rather than throwing into the visit.
  const recorder = recorderWithCode(["https://cdn.example.net/loader.js"]);
  both(recorder, sent(PIXEL, { frames: [{ url: "https://cdn.example.net/loader.js" }] }));
  const evidence = recorder.evidence();
  assert.ok(evidence && isConnectionInspectionEvidence(evidence));
  // Corrupt the recorded stack the group publishes, as a bug would.
  const stacks = (recorder as unknown as { stacks: Map<string, { hosts: string[] }> }).stacks;
  for (const stack of stacks.values()) stack.hosts = ["203.0.113.9"];
  assert.equal(recorder.evidence(), null);
  stacks.clear();
  assert.equal(recorder.evidence(), null);
});

test("a recorder that failed while recording publishes no evidence rather than wrong counts", () => {
  const recorder = recorderWithCode([]);
  both(recorder, sent(PIXEL));
  recorder.observe({
    get request(): never {
      throw new Error("a payload that throws when read");
    }
  });
  assert.equal(recorder.evidence(), null);
});

test("every count adds up to matched in a mixed visit", () => {
  const tag = "https://static.example.org/tag.js";
  const loader = "https://cdn.example.net/loader.js";
  const recorder = recorderWithCode([tag, loader]);
  both(recorder, sent(`${PIXEL}?html`));
  both(recorder, sent(`${PIXEL}?tag`, { frames: [{ url: tag }, { url: loader }] }));
  both(recorder, sent(`${PIXEL}?tag2`, { frames: [{ url: tag }, { url: loader }] }));
  both(recorder, sent(`${PIXEL}?inline`, { frames: [{ url: PAGE }] }));
  both(recorder, sent(`${PIXEL}?eval`, { frames: [{ url: "" }] }));
  both(recorder, sent(`${PIXEL}?hop`, { frames: [{ url: tag }], redirect: true }));
  recorder.notePageRequest(`${PIXEL}?worker`);
  const evidence = evidenceOf(recorder);
  assert.deepEqual(evidence, {
    address: ADDRESS,
    matched: 7,
    groups: [
      {
        count: 2,
        hosts: ["static.example.org", "cdn.example.net"],
        namedScripts: ["https://static.example.org/{seg}", "https://cdn.example.net/{seg}"]
      },
      { count: 1, hosts: ["www.example.com"], namedScripts: ["https://www.example.com/"] }
    ],
    redirected: 1,
    withoutStack: 1,
    withoutNamedScript: 1,
    notListed: 0,
    unobserved: 1
  });
});
