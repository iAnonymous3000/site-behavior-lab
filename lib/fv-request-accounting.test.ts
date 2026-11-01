import assert from "node:assert/strict";
import { test } from "node:test";
import { joinObservations, StackTally, type StackObservationCategory } from "./call-stack-publisher";
import * as productionInspection from "./connection-inspection";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import { redactHostnameV2 } from "./redaction-v2";
import { ScrollCheckRecorder } from "./scroll-check";
import { ScrollCheckStackRecorder } from "./scroll-check-stacks";

/**
 * RA1 and RA2, a bounded check of joinObservations and StackTally, the rule that
 * pairs one URL's page requests with the session's observations of it.
 *
 * Domain: up to 5 page requests, up to 5 observations over every category kind
 * (two distinct groups among them), 0 to 5 dropped observations, and every counted
 * mask. Within that bound the properties hold for all inputs at this commit. Beyond
 * it, this says nothing.
 *
 * This holds the join. RA7 below also holds what Inspect's recorder hands it, and RA6
 * what the check's window and its stack recorder do around it. Whether a browser ever
 * produces a given input is a measurement.
 */

type Publisher = {
  joinObservations: typeof joinObservations;
  StackTally: typeof StackTally;
};

const MAX_REQUESTS = 5;
const MAX_OBSERVATIONS = 5;
const MAX_DROPPED = 5;
const CATEGORIES: readonly StackObservationCategory[] = [
  "redirected",
  "withoutStack",
  "withoutNamedScript",
  "notListed",
  { group: "a" },
  { group: "b" }
];
/** 63 request-and-mask pairs, by 6 drop counts, by 9331 observation sequences. */
const EXPECTED_CASES = 3_527_118;

function observationSequences(): StackObservationCategory[][] {
  const sequences: StackObservationCategory[][] = [[]];
  let last: StackObservationCategory[][] = [[]];
  for (let length = 1; length <= MAX_OBSERVATIONS; length += 1) {
    last = last.flatMap((sequence) => CATEGORIES.map((category) => [...sequence, category]));
    sequences.push(...last);
  }
  return sequences;
}

const SEQUENCES = observationSequences();

type Buckets = {
  redirected: number;
  withoutStack: number;
  withoutNamedScript: number;
  notListed: number;
  unobserved: number;
  a: number;
  b: number;
};

function emptyBuckets(): Buckets {
  return { redirected: 0, withoutStack: 0, withoutNamedScript: 0, notListed: 0, unobserved: 0, a: 0, b: 0 };
}

function addCategory(buckets: Buckets, category: StackObservationCategory): void {
  if (typeof category === "string") buckets[category] += 1;
  else buckets[category.group as "a" | "b"] += 1;
}

function sameBuckets(left: Buckets, right: Buckets): boolean {
  return (
    left.redirected === right.redirected &&
    left.withoutStack === right.withoutStack &&
    left.withoutNamedScript === right.withoutNamedScript &&
    left.notListed === right.notListed &&
    left.unobserved === right.unobserved &&
    left.a === right.a &&
    left.b === right.b
  );
}

function checkJoin(publisher: Publisher): number {
  let cases = 0;
  for (let requests = 0; requests <= MAX_REQUESTS; requests += 1) {
    for (let mask = 0; mask < 1 << requests; mask += 1) {
      let countedTotal = 0;
      for (let index = 0; index < requests; index += 1) if ((mask & (1 << index)) !== 0) countedTotal += 1;
      const counted = (index: number) => (mask & (1 << index)) !== 0;
      for (let droppedObservations = 0; droppedObservations <= MAX_DROPPED; droppedObservations += 1) {
        for (const observations of SEQUENCES) {
          cases += 1;
          const tally = new publisher.StackTally();
          publisher.joinObservations(tally, requests, observations, droppedObservations, counted);
          const input = () => ({ requests, mask, droppedObservations, observations });
          const groupA = tally.groupCounts.get("a") ?? 0;
          const groupB = tally.groupCounts.get("b") ?? 0;
          const taken = tally.redirected + tally.withoutStack + tally.withoutNamedScript + groupA + groupB;
          const total = taken + tally.notListed + tally.unobserved;

          // RA1: every counted request lands in exactly one bucket, uncounted ones in none.
          holds("join-conserves-counted", total === countedTotal, input);

          const joined = Math.min(requests, observations.length);
          const dropped = Math.min(requests - joined, droppedObservations);
          const shortfall = requests > joined + dropped;

          // RA2: when the session missed a request and only some are counted,
          // nothing says which observation is whose, so no counted request takes one.
          if (shortfall && countedTotal > 0 && countedTotal < requests) {
            holds("no-stack-theft-under-shortfall", taken === 0 && tally.notListed === 0 && tally.unobserved === countedTotal, input);
            continue;
          }

          // Otherwise the n-th request takes the n-th observation, whether or not the
          // request before it was counted. This restates the rule in the join's own
          // docblock, so it catches the code drifting from that rule, not a wrong rule.
          // The two properties above stand on their own.
          const expected = emptyBuckets();
          for (let index = 0; index < requests; index += 1) {
            if (!counted(index)) continue;
            if (index < joined) addCategory(expected, observations[index]);
            else if (index < joined + dropped) expected.notListed += 1;
            else expected.unobserved += 1;
          }
          const actual: Buckets = {
            redirected: tally.redirected,
            withoutStack: tally.withoutStack,
            withoutNamedScript: tally.withoutNamedScript,
            notListed: tally.notListed,
            unobserved: tally.unobserved,
            a: groupA,
            b: groupB
          };
          holds("join-pairs-by-position", sameBuckets(actual, expected), input);
        }
      }
    }
  }
  return cases;
}

type JoinInput = { requests: number; mask: number; droppedObservations: number; observations: readonly StackObservationCategory[] };

/**
 * A tally spans a recorder's URLs, so a join must add to what is already there. The
 * domain is smaller here because it is every pair of joins: up to 2 requests, 2
 * observations and 1 dropped observation each.
 */
function smallJoins(): JoinInput[] {
  const inputs: JoinInput[] = [];
  for (let requests = 0; requests <= 2; requests += 1) {
    for (let mask = 0; mask < 1 << requests; mask += 1) {
      for (let droppedObservations = 0; droppedObservations <= 1; droppedObservations += 1) {
        for (const observations of SEQUENCES.filter((sequence) => sequence.length <= 2)) {
          inputs.push({ requests, mask, droppedObservations, observations });
        }
      }
    }
  }
  return inputs;
}

function readTally(tally: StackTally): string {
  return JSON.stringify([
    tally.redirected,
    tally.withoutStack,
    tally.withoutNamedScript,
    tally.notListed,
    tally.unobserved,
    tally.groupCounts.get("a") ?? 0,
    tally.groupCounts.get("b") ?? 0
  ]);
}

function checkTallyAccumulates(publisher: Publisher): number {
  let cases = 0;
  const inputs = smallJoins();
  const join = (tally: StackTally, input: JoinInput) =>
    publisher.joinObservations(tally, input.requests, input.observations, input.droppedObservations, (index) => (input.mask & (1 << index)) !== 0);
  const alone = inputs.map((input) => {
    const tally = new publisher.StackTally();
    join(tally, input);
    return JSON.parse(readTally(tally)) as number[];
  });
  inputs.forEach((first, firstIndex) => {
    inputs.forEach((second, secondIndex) => {
      cases += 1;
      const tally = new publisher.StackTally();
      join(tally, first);
      join(tally, second);
      const expected = alone[firstIndex].map((count, bucket) => count + alone[secondIndex][bucket]);
      holds("a-join-adds-to-the-tally-it-is-given", readTally(tally) === JSON.stringify(expected), () => ({ first, second }));
    });
  });
  return cases;
}

/**
 * RA7: Inspect counts every request, so which observation pairs with which cannot move
 * a count. With every request counted, the join's refusal never fires, and the tally is
 * a function of the request and drop counts and the multiset of the observations it
 * takes. Beyond the first min(requests, observations), arrival order does decide what
 * is taken, so Inspect is stable under pairing, not under any reordering of a surplus.
 *
 * Over this domain the join's part follows from RA1 with every mask bit set, except for
 * the default argument, which is the form Inspect calls. The recorder's part is below.
 */
function checkAllCountedPairing(publisher: Publisher): number {
  let cases = 0;
  const seen = new Map<string, string>();
  for (let requests = 0; requests <= MAX_REQUESTS; requests += 1) {
    for (let droppedObservations = 0; droppedObservations <= MAX_DROPPED; droppedObservations += 1) {
      for (const observations of SEQUENCES) {
        cases += 1;
        const tally = new publisher.StackTally();
        publisher.joinObservations(tally, requests, observations, droppedObservations);
        const input = () => ({ requests, droppedObservations, observations });
        const joined = Math.min(requests, observations.length);
        const dropped = Math.min(requests - joined, droppedObservations);
        holds("with-every-request-counted-nothing-is-refused", tally.unobserved === requests - joined - dropped, input);

        const taken = observations.slice(0, joined).map((category) => (typeof category === "string" ? category : `group:${category.group}`)).sort();
        const key = JSON.stringify([requests, droppedObservations, taken]);
        const read = readTally(tally);
        const earlier = seen.get(key);
        if (earlier === undefined) seen.set(key, read);
        else holds("with-every-request-counted-pairing-moves-no-count", earlier === read, input);
      }
    }
  }
  return cases;
}

type Inspection = typeof productionInspection;

const INSPECTED_URL = "https://pixel.example.net/p.gif?via=stream";
const INSPECTED_ADDRESS = "https://pixel.example.net/{seg}";
const LOADER = "https://cdn.example.net/loader.js";
const TAG = "https://static.example.org/tag.js";

/** What one observation can be, as a recorder's real CDP payload. */
const OBSERVATION_SHAPES: ReadonlyArray<readonly [string, (id: number) => Record<string, unknown>]> = [
  ["redirect hop", (id) => ({ requestId: `R${id}`, request: { url: INSPECTED_URL }, type: "Fetch", redirectResponse: { status: 302 }, initiator: { type: "script" } })],
  ["no stack", (id) => ({ requestId: `R${id}`, request: { url: INSPECTED_URL }, type: "Fetch", initiator: { type: "parser" } })],
  ["no named script", (id) => ({ requestId: `R${id}`, request: { url: INSPECTED_URL }, type: "Fetch", initiator: { type: "script", stack: { callFrames: [{ url: "https://forged.example.com/named.js" }] } } })],
  ["the loader", (id) => ({ requestId: `R${id}`, request: { url: INSPECTED_URL }, type: "Fetch", initiator: { type: "script", stack: { callFrames: [{ url: LOADER }] } } })],
  ["the tag", (id) => ({ requestId: `R${id}`, request: { url: INSPECTED_URL }, type: "Fetch", initiator: { type: "script", stack: { callFrames: [{ url: TAG }] } } })]
];

function inspect(inspection: Inspection, requests: number, order: readonly number[]) {
  const recorder = new inspection.ConnectionInspectionRecorder(INSPECTED_ADDRESS);
  recorder.observe({ requestId: "L", request: { url: LOADER }, type: "Script", initiator: { type: "parser" } });
  recorder.observe({ requestId: "T", request: { url: TAG }, type: "Script", initiator: { type: "parser" } });
  for (let index = 0; index < requests; index += 1) recorder.notePageRequest(INSPECTED_URL);
  order.forEach((shape, index) => recorder.observe(OBSERVATION_SHAPES[shape][1](index)));
  return recorder.evidence();
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) => permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

/** What each shape adds to the evidence, spelled out here and not read from the recorder. */
const SHAPE_ADDS = ["redirected", "withoutStack", "withoutNamedScript", "cdn.example.net", "static.example.org"] as const;

/** What Inspect publishes: the first min(requests, observations) in arrival order, no refusal, the rest unobserved. */
function expectedEvidence(requests: number, sequence: readonly number[]): string {
  const taken = sequence.slice(0, requests).map((shape) => SHAPE_ADDS[shape]);
  const count = (add: (typeof SHAPE_ADDS)[number]) => taken.filter((candidate) => candidate === add).length;
  return JSON.stringify({
    matched: requests,
    redirected: count("redirected"),
    withoutStack: count("withoutStack"),
    withoutNamedScript: count("withoutNamedScript"),
    notListed: 0,
    unobserved: requests - taken.length,
    groups: (["cdn.example.net", "static.example.org"] as const).flatMap((host) => (count(host) > 0 ? [[host, count(host)]] : []))
  });
}

/** The same through the real recorder: up to 3 requests and up to 3 observations in all. */
function checkInspectRecorder(inspection: Inspection): number {
  let cases = 0;
  const shapes = OBSERVATION_SHAPES.map((_, index) => index);
  const sequences: number[][] = [[]];
  let last: number[][] = [[]];
  for (let length = 1; length <= 3; length += 1) {
    last = last.flatMap((sequence) => shapes.map((shape) => [...sequence, shape]));
    sequences.push(...last);
  }
  for (let requests = 0; requests <= 3; requests += 1) {
    for (const sequence of sequences) {
      const joined = Math.min(requests, sequence.length);
      const tail = sequence.slice(joined);
      const reference = JSON.stringify(inspect(inspection, requests, sequence));
      for (const reordered of permutations(sequence.slice(0, joined))) {
        cases += 1;
        const evidence = inspect(inspection, requests, [...reordered, ...tail]);
        const input = () => ({ requests, sequence, reordered, evidence });
        holds("inspect-gives-evidence", evidence !== null, input);
        const given = evidence as NonNullable<typeof evidence>;
        const accounted =
          given.groups.reduce((sum, group) => sum + group.count, 0) +
          given.redirected +
          given.withoutStack +
          given.withoutNamedScript +
          given.notListed +
          given.unobserved;
        holds("inspect-accounts-for-every-matched-request", given.matched === requests && accounted === requests, input);
        const read = JSON.stringify({
          matched: given.matched,
          redirected: given.redirected,
          withoutStack: given.withoutStack,
          withoutNamedScript: given.withoutNamedScript,
          notListed: given.notListed,
          unobserved: given.unobserved,
          groups: given.groups.map((group) => [group.hosts.join(), group.count]).sort()
        });
        holds("inspect-takes-the-first-observations", read === expectedEvidence(requests, sequence), input);
        holds("inspect-evidence-ignores-pairing-order", JSON.stringify(evidence) === reference, input);
      }
    }
  }
  return cases;
}

const publisherPath = require.resolve("./call-stack-publisher");
const variant = (...edits: SourceEdit[]) => loadVariant<Publisher>(publisherPath, edits);

test("RA1 and RA2: the join conserves counted requests and never pairs across a shortfall", () => {
  assert.equal(SEQUENCES.length, 9331);
  assert.equal(checkJoin({ joinObservations, StackTally }), EXPECTED_CASES);
});

test("RA1: joins add up across a recorder's URLs, over every pair of small joins", () => {
  // 7 request-and-mask pairs, by 2 drop counts, by 43 observation sequences.
  assert.equal(smallJoins().length, 602);
  assert.equal(checkTallyAccumulates({ joinObservations, StackTally }), 602 * 602);
});

test("RA1 catches a variant: each join starts its tally over", async () => {
  const broken = variant({
    find: "const joined = Math.min(pageRequests, observations.length);",
    replace: "tally.groupCounts.clear();\n    const joined = Math.min(pageRequests, observations.length);"
  });
  await assertCaughtBy("each join starts over", "a-join-adds-to-the-tally-it-is-given", () => checkTallyAccumulates(broken));
});

for (const [name, property, edit] of [
  [
    "the refusal under a shortfall is gone",
    "no-stack-theft-under-shortfall",
    { find: "if (countedRequests > 0 && countedRequests < pageRequests) {", replace: "if (false) {" }
  ],
  [
    "the refusal counts every request instead of the counted ones",
    "join-conserves-counted",
    { find: "tally.unobserved += countedRequests;", replace: "tally.unobserved += pageRequests;" }
  ],
  [
    "the join is off by one",
    "join-pairs-by-position",
    {
      find: "const joined = Math.min(pageRequests, observations.length);",
      replace: "const joined = Math.max(0, Math.min(pageRequests, observations.length) - 1);"
    }
  ],
  [
    "an uncounted request lands in a bucket",
    "join-conserves-counted",
    { find: "if (!counted(index))\n            continue;\n", replace: "" }
  ],
  [
    "a request the recorder dropped reads as never observed",
    "join-pairs-by-position",
    { find: "else if (index < joined + dropped)\n            tally.notListed += 1;\n", replace: "" }
  ],
  [
    "two categories share a bucket",
    "join-pairs-by-position",
    { find: "this.withoutNamedScript += 1;", replace: "this.withoutStack += 1;" }
  ],
  [
    "a group forgets its earlier requests",
    "join-conserves-counted",
    {
      find: "((_a = this.groupCounts.get(category.group)) !== null && _a !== void 0 ? _a : 0) + 1",
      replace: "1"
    }
  ]
] as const) {
  test(`RA1 and RA2 catch a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkJoin(variant(edit)));
  });
}

test("RA7: with every request counted, nothing is refused and pairing moves no count", () => {
  assert.equal(checkAllCountedPairing({ joinObservations, StackTally }), 6 * 6 * SEQUENCES.length);
});

test("RA7: Inspect's real recorder takes the first observations, whichever pairs with which", () => {
  // 4 request counts by 156 sequences, each with every order of what it takes.
  assert.equal(checkInspectRecorder(productionInspection), 1_424);
});

for (const [name, property, edit] of [
  [
    "every request pairs with the first observation",
    "with-every-request-counted-pairing-moves-no-count",
    { find: "if (index < joined)\n            tally.add(observations[index]);", replace: "if (index < joined)\n            tally.add(observations[0]);" }
  ],
  [
    "by default a join counts no request",
    "with-every-request-counted-nothing-is-refused",
    { find: "observationsDropped, counted = () => true) {", replace: "observationsDropped, counted = () => false) {" }
  ],
  [
    "the refusal fires with every request counted",
    "with-every-request-counted-nothing-is-refused",
    { find: "if (countedRequests > 0 && countedRequests < pageRequests) {", replace: "if (countedRequests > 0) {" }
  ]
] as const) {
  test(`RA7 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkAllCountedPairing(variant(edit)));
  });
}

const JOIN_CALL = "entry.observations, entry.observationsDropped);";
const LEAVES_ONE_UNCOUNTED: SourceEdit = { find: JOIN_CALL, replace: "entry.observations, entry.observationsDropped, (index) => index !== 0);" };

for (const [name, property, edits] of [
  ["Inspect joins observations in reverse", "inspect-takes-the-first-observations", [{ find: JOIN_CALL, replace: "[...entry.observations].reverse(), entry.observationsDropped);" }]],
  ["Inspect sorts observations before the join", "inspect-takes-the-first-observations", [{ find: JOIN_CALL, replace: "[...entry.observations].sort(), entry.observationsDropped);" }]],
  ["Inspect holds no requested address, so it names nothing", "inspect-takes-the-first-observations", [{ find: "this.codeUrls.note(observed.key);", replace: "" }]],
  [
    "Inspect's groups follow arrival order and are not ranked",
    "inspect-evidence-ignores-pairing-order",
    [{ find: "tally.rankedGroups(this.stacks).map(", replace: "[...tally.groupCounts.entries()].map(([key, count]) => ({ count, stack: this.stacks.get(key) })).map(" }]
  ],
  ["Inspect leaves a request uncounted, and its own guard withholds the evidence", "inspect-gives-evidence", [LEAVES_ONE_UNCOUNTED]],
  ["Inspect writes an address its own guard refuses", "inspect-gives-evidence", [{ find: "address: this.address,", replace: 'address: "not an address",' }]],
  [
    "Inspect leaves a request uncounted, with its guard gone",
    "inspect-accounts-for-every-matched-request",
    [LEAVES_ONE_UNCOUNTED, { find: "return (0, connection_inspection_evidence_1.isConnectionInspectionEvidence)(evidence) ? evidence : null;", replace: "return evidence;" }]
  ]
] as const) {
  test(`RA7 catches a variant: ${name}`, async () => {
    const broken = loadVariant<Inspection>(require.resolve("./connection-inspection"), edits);
    await assertCaughtBy(name, property, () => checkInspectRecorder(broken));
  });
}

/**
 * RA6: a request in the check's scroll window shows nothing it did not have because of
 * what the page reported after the window, through the real ScrollCheckRecorder and
 * ScrollCheckStackRecorder.
 *
 * Domain: one URL (short, past the held URL's length, or on a host that publishes as
 * another name), with up to 2 requests in the window, at least one counted, each made by
 * the page under one of two scripts or with no stack, or by a worker the session never
 * observes. Then one report after the window from any of those or a redirect hop, a
 * main-frame navigation or a refused request, or two from the worker or the two scripts,
 * each in the window's last millisecond or after the freeze, to the URL, to the URL with a
 * fragment, or to another URL on the host. An uncounted request here was sent and never
 * answered. Neither bound is walked in this domain: what a bound costs is below and in
 * lib/scroll-check-stacks.test.ts.
 *
 * Axioms: the session observes every request of the page and none of a worker, each
 * observation arrives before the page's event in request order, and every report arrives
 * before the evidence is built. The two open cases in lib/scroll-check-stacks.test.ts are
 * where these fail: an observation the page never reported, and a report that comes after
 * the evidence. Whether a browser holds to them is a measurement, and this says nothing
 * about how often any of it happens on a real site.
 */

type CheckModules = { ScrollCheckRecorder: typeof ScrollCheckRecorder; ScrollCheckStackRecorder: typeof ScrollCheckStackRecorder };
type FakeRequest = { url: string; redirected?: boolean; navigation?: boolean };
type WindowSource = "worker" | "page-a" | "page-b" | "page-no-stack";
type LaterSource = WindowSource | "page-hop" | "page-navigation" | "page-refused";
type WindowRequest = { source: WindowSource; counted: boolean };
type LaterReport = { source: LaterSource; when: "last-millisecond" | "after-freeze"; form: "same" | "fragment" | "other" };

const WINDOW_SOURCES: readonly WindowSource[] = ["worker", "page-a", "page-b", "page-no-stack"];
const LATER_SOURCES: readonly LaterSource[] = [...WINDOW_SOURCES, "page-hop", "page-navigation", "page-refused"];
const TWO_REPORT_SOURCES: readonly LaterSource[] = ["worker", "page-a", "page-b"];
const WINDOW_REQUESTS: readonly WindowRequest[] = WINDOW_SOURCES.flatMap((source) => [true, false].map((counted) => ({ source, counted })));
const laterReportsFrom = (sources: readonly LaterSource[]): LaterReport[] =>
  sources.flatMap((source) => (["last-millisecond", "after-freeze"] as const).flatMap((when) => (["same", "fragment", "other"] as const).map((form) => ({ source, when, form }))));
const WINDOW_START = 10_000;
const WINDOW_END = 13_000;
const FIRST_PARTY = "www.example.com";
const SCRIPT_A = { url: "http://cdn.alpha.net/a.js", host: "cdn.alpha.net" };
const SCRIPT_B = { url: "http://static.bravo.org/b.js", host: "static.bravo.org" };
const SHORT_URL = "http://cdn.golf.net/beacon";
/** Its host publishes as another name, which a rule keyed on the listed host would miss. */
const REDACTED_URL = "http://north.lima.net/a";
const CHECKED_URLS = [SHORT_URL, `${SHORT_URL}?pad=${"x".repeat(2_100)}`, REDACTED_URL];

function laterUrl(url: string, form: LaterReport["form"]): string {
  if (form === "same") return url;
  return form === "fragment" ? `${url}#later` : `http://${new URL(url).hostname}/other`;
}

function sessionSees(url: string, source: LaterSource): Record<string, unknown> | null {
  if (source === "worker") return null;
  const base = { requestId: `R${url.length}`, request: { url }, type: source === "page-navigation" ? "Document" : "Fetch" };
  if (source === "page-no-stack") return { ...base, initiator: { type: "parser" } };
  const initiator = { type: "script", stack: { callFrames: [{ url: source === "page-b" ? SCRIPT_B.url : SCRIPT_A.url }] } };
  return { ...base, initiator, ...(source === "page-hop" ? { redirectResponse: { status: 302 } } : {}) };
}

function runRecorders(modules: CheckModules, url: string, inWindow: readonly WindowRequest[], later: readonly LaterReport[]) {
  let now = WINDOW_START - 1_000;
  const recorder = new modules.ScrollCheckRecorder<FakeRequest>(
    { url: (request) => request.url, redirected: (request) => request.redirected === true, mainFrameNavigation: (request) => request.navigation === true },
    () => now
  );
  const stacks = new modules.ScrollCheckStackRecorder(500);
  for (const script of [SCRIPT_A, SCRIPT_B]) stacks.observe({ requestId: script.host, request: { url: script.url }, type: "Script", initiator: { type: "parser" } });
  stacks.keep(FIRST_PARTY);
  recorder.openWindow("scroll");
  const report = (source: LaterSource, address: string): FakeRequest => {
    const observation = sessionSees(address, source);
    if (observation) stacks.observe(observation);
    const request: FakeRequest = { url: address, redirected: source === "page-hop", navigation: source === "page-navigation" };
    recorder.noteRequest(request);
    if (source !== "page-hop") recorder.noteRouted(request, source === "page-refused" ? "refused" : "sent");
    return request;
  };
  now = WINDOW_START;
  for (const request of inWindow) {
    now += 10;
    const made = report(request.source, url);
    if (request.counted) recorder.noteAnswered(made);
  }
  now = WINDOW_END;
  for (const item of later) if (item.when === "last-millisecond") report(item.source, laterUrl(url, item.form));
  recorder.freeze();
  stacks.windowEnded();
  for (const item of later) {
    if (item.when !== "after-freeze") continue;
    now += 10;
    report(item.source, laterUrl(url, item.form));
  }
  const windows = recorder.windows({ firstPartyHostname: FIRST_PARTY, control: null, scroll: { start: WINDOW_START, end: WINDOW_END }, scrollRequests: true });
  return { windows, entries: windows.scrollRequests ? stacks.entries(windows.scrollRequests) : null };
}

/** What the world's counted requests truly were. */
function truth(inWindow: readonly WindowRequest[]) {
  const counted = inWindow.filter((request) => request.counted);
  const of = (source: WindowSource) => counted.filter((request) => request.source === source).length;
  return { counted: counted.length, withoutStack: of("page-no-stack"), byHost: new Map([[SCRIPT_A.host, of("page-a")], [SCRIPT_B.host, of("page-b")]]) };
}

function windowWorlds(): WindowRequest[][] {
  const one = WINDOW_REQUESTS.map((request) => [request]);
  const two = WINDOW_REQUESTS.flatMap((first) => WINDOW_REQUESTS.map((second) => [first, second]));
  return [...one, ...two].filter((requests) => requests.some((request) => request.counted));
}

function laterWorlds(): LaterReport[][] {
  const two = laterReportsFrom(TWO_REPORT_SOURCES);
  const pairs = two.flatMap((first) => two.map((second) => [first, second]));
  // A report in the window's last millisecond cannot follow one after the freeze.
  const possible = pairs.filter(([first, second]) => !(first.when === "after-freeze" && second.when === "last-millisecond"));
  return [[], ...laterReportsFrom(LATER_SOURCES).map((report) => [report]), ...possible];
}

function checkLaterReports(modules: CheckModules): number {
  let cases = 0;
  const laters = laterWorlds();
  for (const url of CHECKED_URLS) {
    for (const inWindow of windowWorlds()) {
      const alone = runRecorders(modules, url, inWindow, []);
      const baseline = JSON.stringify(alone.windows.scroll);
      const baselineEntries = JSON.stringify(alone.entries);
      const real = truth(inWindow);
      for (const later of laters) {
        cases += 1;
        const { windows, entries } = runRecorders(modules, url, inWindow, later);
        const input = () => ({ url: url.slice(0, 60), inWindow, later, entries });
        holds("ra6-a-report-after-the-window-changes-no-window", JSON.stringify(windows.scroll) === baseline && windows.reasons.size === 0, input);
        const entry = entries?.[0];
        holds("ra6-the-join-gives-the-host-its-entry", entry !== undefined && entries?.length === 1, input);
        const given = entry as NonNullable<typeof entry>;
        const named = given.groups.reduce((sum, group) => sum + group.count, 0);
        const accounted = named + given.redirected + given.withoutStack + given.withoutNamedScript + given.notListed + given.unobserved;
        holds("ra6-every-counted-request-is-accounted-for", given.requests === real.counted && accounted === real.counted, input);

        // Against what each counted request truly was, not against any rule of the join.
        holds(
          "ra6-a-published-stack-belongs-to-a-counted-request",
          given.groups.every((group) => group.count <= (real.byHost.get(group.hosts.join()) ?? 0)),
          input
        );
        holds(
          "ra6-a-published-reason-belongs-to-a-counted-request",
          given.withoutStack <= real.withoutStack && given.redirected === 0 && given.withoutNamedScript === 0 && given.notListed === 0,
          input
        );

        if (later.some((report) => report.form !== "other")) {
          // This restates the rule, so it catches the code drifting from it, not a wrong rule.
          holds("ra6-a-url-reported-after-the-window-takes-no-stack", named === 0 && given.unobserved === real.counted, input);
          continue;
        }
        // A report to another URL leaves this one exactly as it was with no report at all.
        holds("ra6-the-rule-costs-only-its-own-url", JSON.stringify(entries) === baselineEntries, input);
        if (inWindow.every((request) => request.source !== "worker")) {
          const exact = [...real.byHost].every(([host, count]) => (given.groups.find((group) => group.hosts.join() === host)?.count ?? 0) === count);
          holds("ra6-with-no-worker-and-no-later-report-each-request-keeps-what-it-was", exact && given.withoutStack === real.withoutStack && given.unobserved === 0, input);
        }
      }
    }
  }
  return cases;
}

/**
 * The bounds and an unreadable address: a report the recorder lost costs the check its
 * stacks, and only a lost one does. Reads what the join is handed, so that a report
 * dropped on the way to it shows.
 */
function checkLostReports(modules: CheckModules): number {
  let cases = 0;
  for (let bound = 1; bound <= 3; bound += 1) {
    for (const lastMillisecond of [0, 1, 3]) {
      for (let distinct = 0; distinct <= 4; distinct += 1) {
        for (const repeats of [1, 2]) {
          for (const otherScheme of [0, 2]) {
            for (const unreadable of ["no", "before-the-freeze", "after-the-freeze"] as const) {
              cases += 1;
              let now = WINDOW_START;
              const facts = {
                url: (request: FakeRequest) => {
                  if (request.url === "unreadable") throw new Error("This address cannot be read.");
                  return request.url;
                },
                redirected: () => false,
                mainFrameNavigation: () => false
              };
              const recorder = new modules.ScrollCheckRecorder<FakeRequest>(facts, () => now, undefined, bound);
              recorder.openWindow("scroll");
              const made = { url: SHORT_URL };
              recorder.noteRequest(made);
              recorder.noteRouted(made, "sent");
              recorder.noteAnswered(made);
              if (unreadable === "before-the-freeze") recorder.noteRequest({ url: "unreadable" });
              now = WINDOW_END;
              const lastUrls = Array.from({ length: lastMillisecond }, (_, index) => `http://cdn.golf.net/m${index}`);
              for (const url of lastUrls) recorder.noteRequest({ url });
              recorder.freeze();
              const laterUrls = Array.from({ length: distinct }, (_, index) => `http://cdn.golf.net/n${index}`);
              for (const url of laterUrls) for (let repeat = 0; repeat < repeats; repeat += 1) recorder.noteRequest({ url });
              for (let index = 0; index < otherScheme; index += 1) recorder.noteRequest({ url: `data:text/plain,${index}` });
              if (unreadable === "after-the-freeze") recorder.noteRequest({ url: "unreadable" });
              const windows = recorder.windows({ firstPartyHostname: FIRST_PARTY, control: null, scroll: { start: WINDOW_START, end: WINDOW_END }, scrollRequests: true });

              const overTheWindowBound = 1 + lastMillisecond > bound;
              const lost = overTheWindowBound || distinct > bound || unreadable !== "no";
              const input = () => ({ bound, lastMillisecond, distinct, repeats, otherScheme, unreadable, join: windows.scrollRequests });
              holds("ra6-a-lost-report-costs-the-check-its-stacks", lost === (windows.scrollRequests === undefined), input);
              if (!lost) {
                const heard = new Set(windows.scrollRequests?.reportedAfterWindow);
                holds("ra6-the-join-hears-every-report", heard.size === lastMillisecond + distinct && [...lastUrls, ...laterUrls].every((url) => heard.has(url)), input);
              }
              // The window's own bound and its unreadable request have always said so. A report after the freeze says nothing.
              const saysSo = overTheWindowBound || unreadable === "before-the-freeze";
              holds("ra6-a-lost-report-costs-nothing-else", windows.reasons.has("host-bound") === saysSo && windows.reasons.size === (saysSo ? 1 : 0) && windows.scroll?.requests === 1, input);
            }
          }
        }
      }
    }
  }
  return cases;
}

const PRODUCTION_CHECK: CheckModules = { ScrollCheckRecorder, ScrollCheckStackRecorder };

function withStacksVariant(...edits: SourceEdit[]): CheckModules {
  const stacks = loadVariant<Pick<CheckModules, "ScrollCheckStackRecorder">>(require.resolve("./scroll-check-stacks"), edits);
  return { ScrollCheckRecorder, ScrollCheckStackRecorder: stacks.ScrollCheckStackRecorder };
}

function withRecorderVariant(...edits: SourceEdit[]): CheckModules {
  const check = loadVariant<Pick<CheckModules, "ScrollCheckRecorder">>(require.resolve("./scroll-check"), edits);
  return { ScrollCheckRecorder: check.ScrollCheckRecorder, ScrollCheckStackRecorder };
}

const THE_RULE = "reportedLater.has(key) || (observations.length > counted.length && !sameCategory(observations))";
const THE_SURPLUS_RULE = "observations.length > counted.length && !sameCategory(observations)";
const AT_THE_END = "(entry) => entry.at >= interval.end)";
const AFTER_FREEZE_READ = "const url = this.facts.url(request);\n            if (requestHostname(url) === null || ";
const GUARD = "if (this.reportedAfterFreeze.size >= this.maxWindowRequests)\n                this.reportLost = true;\n            else\n                this.reportedAfterFreeze.add(url);";

test("RA6: a request in the window shows nothing it did not have, whatever the page reports after the window", () => {
  assert.notEqual(redactHostnameV2(new URL(REDACTED_URL).hostname).value, new URL(REDACTED_URL).hostname, "this URL's host must publish as another name");
  // 52 window worlds, by 286 later worlds (none, 42 single reports, 243 pairs), by 3 URLs.
  assert.equal(windowWorlds().length, 52);
  assert.equal(laterWorlds().length, 286);
  assert.equal(checkLaterReports(PRODUCTION_CHECK), 52 * 286 * 3);
});

test("RA6: a report the recorder lost costs the check its stacks, and nothing else does", () => {
  assert.equal(checkLostReports(PRODUCTION_CHECK), 3 * 3 * 5 * 2 * 2 * 3);
});

for (const [name, property, modules] of [
  ["the join ignores later reports", "ra6-a-published-stack-belongs-to-a-counted-request", () => withStacksVariant({ find: THE_RULE, replace: THE_SURPLUS_RULE })],
  [
    "the rule takes the surplus rule's same-category exemption",
    "ra6-a-published-stack-belongs-to-a-counted-request",
    () => withStacksVariant({ find: THE_RULE, replace: "(reportedLater.has(key) || observations.length > counted.length) && observations.length > 0 && !sameCategory(observations)" })
  ],
  [
    "a later report takes one observation off the end, and the rest pair by position",
    "ra6-a-published-stack-belongs-to-a-counted-request",
    () =>
      withStacksVariant(
        { find: THE_RULE, replace: THE_SURPLUS_RULE },
        {
          find: "joinObservations)(tally, counted.length, observations, dropped,",
          replace: "joinObservations)(tally, counted.length, reportedLater.has(key) ? observations.slice(0, -1) : observations, dropped,"
        }
      )
  ],
  ["later reports are held by their raw address", "ra6-a-published-stack-belongs-to-a-counted-request", () => withStacksVariant({ find: "join.reportedAfterWindow.map(call_stack_publisher_1.heldUrlKey)", replace: "join.reportedAfterWindow" })],
  [
    "later reports are scoped to the listed host, which is the published name",
    "ra6-a-published-stack-belongs-to-a-counted-request",
    () =>
      withStacksVariant({
        find: "const reportedLater = new Set(join.reportedAfterWindow.map(call_stack_publisher_1.heldUrlKey));\n            return join.listed.map((entry) => this.hostStacks(entry, reportedLater));",
        replace: "return join.listed.map((entry) => this.hostStacks(entry, new Set(join.reportedAfterWindow.filter((url) => (0, scroll_check_1.requestHostname)(url) === entry.host).map(call_stack_publisher_1.heldUrlKey))));"
      })
  ],
  [
    "the rule spares a URL whose observations name no script",
    "ra6-a-published-reason-belongs-to-a-counted-request",
    () => withStacksVariant({ find: THE_RULE, replace: `(reportedLater.has(key) && observations.some((category) => typeof category !== "string")) || (${THE_SURPLUS_RULE})` })
  ],
  ["the refusal counts every request instead of the counted ones", "ra6-every-counted-request-is-accounted-for", () => withStacksVariant({ find: "tally.unobserved += counted.filter(Boolean).length;", replace: "tally.unobserved += counted.length;" })],
  ["a later report refuses the whole host", "ra6-the-rule-costs-only-its-own-url", () => withStacksVariant({ find: THE_RULE, replace: `reportedLater.size > 0 || (${THE_SURPLUS_RULE})` })],
  [
    "any later report refuses a URL with fewer observations than requests",
    "ra6-the-rule-costs-only-its-own-url",
    () => withStacksVariant({ find: THE_RULE, replace: `(reportedLater.size > 0 && observations.length < counted.length) || ${THE_RULE}` })
  ],
  ["a report after the freeze is forgotten", "ra6-a-published-stack-belongs-to-a-counted-request", () => withRecorderVariant({ find: "this.noteAfterFreeze(request);", replace: "" })],
  [
    "a main-frame navigation after the freeze is forgotten",
    "ra6-a-published-stack-belongs-to-a-counted-request",
    () => withRecorderVariant({ find: AFTER_FREEZE_READ, replace: `if (this.facts.mainFrameNavigation(request))\n                return;\n            ${AFTER_FREEZE_READ}` })
  ],
  [
    "a redirect hop after the freeze is forgotten",
    "ra6-a-published-reason-belongs-to-a-counted-request",
    () => withRecorderVariant({ find: AFTER_FREEZE_READ, replace: `if (this.facts.redirected(request))\n                return;\n            ${AFTER_FREEZE_READ}` })
  ],
  ["a report in the window's last millisecond is forgotten", "ra6-a-published-stack-belongs-to-a-counted-request", () => withRecorderVariant({ find: AT_THE_END, replace: "() => false)" })],
  ["a refused report in the window's last millisecond is forgotten", "ra6-a-published-stack-belongs-to-a-counted-request", () => withRecorderVariant({ find: AT_THE_END, replace: `(entry) => entry.at >= interval.end && this.decisions.get(entry.request) !== "refused")` })],
  ["a redirect hop in the window's last millisecond is forgotten", "ra6-a-published-reason-belongs-to-a-counted-request", () => withRecorderVariant({ find: AT_THE_END, replace: "(entry) => entry.at >= interval.end && !entry.redirected)" })],
  [
    "a report after the freeze marks the window incomplete",
    "ra6-a-report-after-the-window-changes-no-window",
    () => withRecorderVariant({ find: AFTER_FREEZE_READ, replace: `this.boundReached = true;\n            ${AFTER_FREEZE_READ}` })
  ]
] as const) {
  test(`RA6 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkLaterReports(modules()));
  });
}

for (const [name, property, modules] of [
  ["a report past the freeze's bound is dropped in silence", "ra6-a-lost-report-costs-the-check-its-stacks", () => withRecorderVariant({ find: GUARD, replace: "this.reportedAfterFreeze.add(url);" })],
  [
    "a report past the window's bound is dropped in silence",
    "ra6-a-lost-report-costs-the-check-its-stacks",
    () => withRecorderVariant({ find: "this.reportLost = true;\n                    return;", replace: "return;" })
  ],
  [
    "a report it cannot read before the freeze is dropped in silence",
    "ra6-a-lost-report-costs-the-check-its-stacks",
    () => withRecorderVariant({ find: "this.boundReached = true;\n                this.reportLost = true;\n            }", replace: "this.boundReached = true;\n            }" })
  ],
  [
    "a report it cannot read after the freeze is dropped in silence",
    "ra6-a-lost-report-costs-the-check-its-stacks",
    () => withRecorderVariant({ find: "this.reportedAfterFreeze.add(url);\n        }\n        catch (_a) {\n            this.reportLost = true;\n        }", replace: "this.reportedAfterFreeze.add(url);\n        }\n        catch (_a) {\n        }" })
  ],
  ["a lost report still gives stacks", "ra6-a-lost-report-costs-the-check-its-stacks", () => withRecorderVariant({ find: "!this.reportLost", replace: "true" })],
  ["the bound counts repeats of one address", "ra6-a-lost-report-costs-the-check-its-stacks", () => withRecorderVariant({ find: " || this.reportedAfterFreeze.has(url)", replace: "" })],
  ["other schemes fill the bound", "ra6-a-lost-report-costs-the-check-its-stacks", () => withRecorderVariant({ find: "requestHostname(url) === null || ", replace: "" })],
  ["the join hears only the first reports after the freeze", "ra6-the-join-hears-every-report", () => withRecorderVariant({ find: "...this.reportedAfterFreeze", replace: "...[...this.reportedAfterFreeze].slice(0, 2)" })],
  ["the join hears no report in the window's last millisecond", "ra6-the-join-hears-every-report", () => withRecorderVariant({ find: AT_THE_END, replace: "() => false)" })],
  ["a lost report marks the window incomplete", "ra6-a-lost-report-costs-nothing-else", () => withRecorderVariant({ find: "!this.reportLost", replace: '!(this.reportLost && reasons.add("host-bound"))' })]
] as const) {
  test(`RA6 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkLostReports(modules()));
  });
}
