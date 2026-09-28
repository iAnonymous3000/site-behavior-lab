// A seeded property runner for the unit suite, with no dependency.
//
// A property test draws many inputs from a generator and checks one invariant
// over each. Two things make that useful in CI rather than flaky: the draws are
// a pure function of a fixed seed, so a failure reproduces exactly, and a
// failing input is shrunk to a small one before it is reported, so the report
// names the cause instead of a hundred incidental parts.
//
// The generator is mulberry32: a 32-bit state, a full period, and enough
// spread for choosing among a few hundred alternatives. It is not a
// cryptographic source and must never be used as one.

export type SeededRandom = {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, bound). */
  int(bound: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  pick<T>(values: readonly T[]): T;
  /** Each value kept independently with probability `p`, in input order. */
  subset<T>(values: readonly T[], p: number): T[];
};

export function seededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (bound: number): number => {
    if (!Number.isSafeInteger(bound) || bound <= 0) throw new Error(`int() needs a positive bound, got ${bound}`);
    return Math.floor(next() * bound);
  };
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (values) => {
      if (values.length === 0) throw new Error("pick() needs at least one value");
      return values[int(values.length)];
    },
    subset: (values, p) => values.filter(() => next() < p)
  };
}

/** Every copy of `values` with exactly one element removed, first element first. */
export function* withoutOne<T>(values: readonly T[]): Generator<T[]> {
  for (let index = 0; index < values.length; index += 1) {
    yield [...values.slice(0, index), ...values.slice(index + 1)];
  }
}

export type PropertyCheck<T> = {
  name: string;
  seed: number;
  iterations: number;
  generate(random: SeededRandom, iteration: number): T;
  /**
   * Smaller candidates for a failing value, most aggressive first. The runner
   * keeps the first candidate that still fails and asks again, so each
   * candidate needs to be strictly smaller or the search could cycle; the step
   * bound below stops it regardless.
   */
  shrink?(value: T): Iterable<T>;
  /** Null when the property holds, otherwise what went wrong. */
  property(value: T): string | null;
  /**
   * Whether a shrink candidate's failure is the one being shrunk. Without it
   * any failure is accepted, so a candidate that fails for an unrelated
   * reason can replace the counterexample being reported.
   */
  sameFailure?(current: string, candidate: string): boolean;
  /** How the counterexample is printed; JSON by default. */
  describe?(value: T): string;
};

export type PropertyFailure<T> = {
  iteration: number;
  original: T;
  shrunk: T;
  message: string;
  shrinkSteps: number;
};

const MAX_SHRINK_STEPS = 2_000;

/** Run a property and return its shrunk first failure, or null when every draw holds. */
export function findPropertyFailure<T>(check: PropertyCheck<T>): PropertyFailure<T> | null {
  const random = seededRandom(check.seed);
  for (let iteration = 0; iteration < check.iterations; iteration += 1) {
    const original = check.generate(random, iteration);
    const message = failureOf(check, original);
    if (message === null) continue;
    let shrunk = original;
    let shrunkMessage = message;
    let shrinkSteps = 0;
    let progressed = true;
    while (progressed && shrinkSteps < MAX_SHRINK_STEPS && check.shrink) {
      progressed = false;
      for (const candidate of check.shrink(shrunk)) {
        shrinkSteps += 1;
        const candidateMessage = failureOf(check, candidate);
        if (candidateMessage !== null && (check.sameFailure?.(shrunkMessage, candidateMessage) ?? true)) {
          shrunk = candidate;
          shrunkMessage = candidateMessage;
          progressed = true;
          break;
        }
        if (shrinkSteps >= MAX_SHRINK_STEPS) break;
      }
    }
    return { iteration, original, shrunk, message: shrunkMessage, shrinkSteps };
  }
  return null;
}

/**
 * Run a property and throw with the seed, the iteration and the shrunk
 * counterexample when it fails, so the failure can be replayed by hand.
 */
export function assertProperty<T>(check: PropertyCheck<T>): void {
  const failure = findPropertyFailure(check);
  if (failure === null) return;
  const describe = check.describe ?? ((value: T) => JSON.stringify(value, null, 2));
  throw new Error(
    [
      `Property "${check.name}" failed at iteration ${failure.iteration} of ${check.iterations} (seed ${check.seed}).`,
      `Shrunk counterexample (${failure.shrinkSteps} shrink steps):`,
      describe(failure.shrunk),
      `Failure: ${failure.message}`
    ].join("\n")
  );
}

// A property that throws is a failing property, not a crashed runner: the
// throw is often the finding (a builder refusing a visit the scanner can
// produce), and it must shrink like any other failure.
function failureOf<T>(check: PropertyCheck<T>, value: T): string | null {
  try {
    return check.property(value);
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}
