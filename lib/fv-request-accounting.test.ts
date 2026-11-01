import assert from "node:assert/strict";
import { test } from "node:test";
import { joinObservations, StackTally, type StackObservationCategory } from "./call-stack-publisher";
import * as productionInspection from "./connection-inspection";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";

/**
 * RA1 and RA2, a bounded check of joinObservations and StackTally, the rule that
 * pairs one URL's page requests with the session's observations of it.
 *
 * Domain: up to 5 page requests, up to 5 observations over every category kind
 * (two distinct groups among them), 0 to 5 dropped observations, and every counted
 * mask. Within that bound the properties hold for all inputs at this commit. Beyond
 * it, this says nothing.
 *
 * This holds the join. RA7 below also holds what Inspect's recorder hands it, while
 * lib/scroll-check-stacks.ts applies its own surplus rule before calling here. Whether a
 * browser ever produces a given input is a measurement: the RA6 case stays open.
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
