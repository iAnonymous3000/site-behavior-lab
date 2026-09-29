import assert from "node:assert/strict";
import { test } from "node:test";
import { assertProperty, findPropertyFailure, seededRandom, withoutOne } from "./seeded-property";

test("a seed fixes the whole sequence and another seed changes it", () => {
  const draw = (seed: number) => {
    const random = seededRandom(seed);
    return Array.from({ length: 64 }, () => random.int(1_000_000));
  };
  assert.deepEqual(draw(7), draw(7));
  assert.notDeepEqual(draw(7), draw(8));
  const random = seededRandom(1);
  for (let index = 0; index < 1_000; index += 1) {
    const value = random.int(3);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 3, `int(3) returned ${value}`);
    const float = random.next();
    assert.ok(float >= 0 && float < 1, `next() returned ${float}`);
  }
  assert.throws(() => random.int(0), /positive bound/);
  assert.throws(() => random.pick([]), /at least one value/);
});

test("a failing draw is shrunk to its smallest failing part and reported with its seed", () => {
  const check = {
    name: "no seven after a three",
    seed: 11,
    iterations: 200,
    generate: (random: ReturnType<typeof seededRandom>) => Array.from({ length: 12 }, () => random.int(10)),
    shrink: (values: number[]) => withoutOne(values),
    property: (values: number[]) => {
      const three = values.indexOf(3);
      return three >= 0 && values.indexOf(7, three) > three ? "a seven follows a three" : null;
    }
  };
  const failure = findPropertyFailure(check);
  assert.ok(failure, "twelve digits hold a three before a seven within 200 draws");
  assert.deepEqual(failure.shrunk, [3, 7]);
  assert.ok(failure.original.length > failure.shrunk.length);
  assert.equal(failure.message, "a seven follows a three");

  assert.throws(
    () => assertProperty(check),
    (error: Error) =>
      error.message.includes(`seed ${check.seed}`) &&
      error.message.includes(`iteration ${failure.iteration}`) &&
      error.message.includes(JSON.stringify([3, 7], null, 2)) &&
      error.message.includes("Failure: a seven follows a three")
  );
  assert.equal(findPropertyFailure({ ...check, property: () => null }), null);
});

test("shrinking keeps to the failure being shrunk when asked, and a throw is a failure", () => {
  // Every strictly smaller array fails for a different reason; with
  // sameFailure the original is kept, without it the shrinker walks away.
  const check = {
    name: "length-named failures",
    seed: 3,
    iterations: 1,
    generate: () => [1, 2, 3],
    shrink: (values: number[]) => withoutOne(values),
    property: (values: number[]) => `length ${values.length}`
  };
  assert.deepEqual(findPropertyFailure(check)?.shrunk, []);
  assert.deepEqual(
    findPropertyFailure({ ...check, sameFailure: (current: string, candidate: string) => current === candidate })?.shrunk,
    [1, 2, 3]
  );

  const threw = findPropertyFailure({
    name: "throws",
    seed: 3,
    iterations: 1,
    generate: () => 1,
    property: (): string | null => {
      throw new Error("builder refused");
    }
  });
  assert.equal(threw?.message, "threw: builder refused");
});
