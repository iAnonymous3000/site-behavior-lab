import assert from "node:assert/strict";
import { test } from "node:test";
import { joinObservations, StackTally, type StackObservationCategory } from "./call-stack-publisher";
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
 * This holds the join, not what its callers hand it. lib/scroll-check-stacks.ts
 * applies its own surplus rule before calling here, and whether a browser ever
 * produces a given input is a measurement: the trailing RA6 case stays open.
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
