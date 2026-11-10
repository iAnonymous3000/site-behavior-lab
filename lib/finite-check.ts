// Exhaustive and bounded checks for the unit suite, with no dependency.
//
// A finite check walks every member of a closed domain, or every input within a
// stated bound, and holds production code to one property over each. What it
// establishes is exactly that: for all inputs in that domain, at this commit.
// lib/seeded-property.ts is the other kind of check, sampled draws, and proves
// nothing beyond the draws it made. Neither says anything about what a browser
// hands the code.
//
// A check that cannot fail shows nothing, so each one also names broken variants
// of the production code it must catch. loadVariant compiles the module from its
// own emitted bytes with one exact edit, leaving production untouched, and refuses
// an edit that no longer lands. A check is held to the property it should report,
// so a variant caught for the wrong reason fails too.
//
// A passing run leaves no trace of which variants it caught, so a reader of a
// green log cannot tell a variant that was caught from one that never ran. When
// the environment names a catch log, each catch assertCaughtBy accepts is
// appended to it, so a run that needs that record can name a log and read it
// back. Nothing is written otherwise.
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { compileFunction } from "node:vm";

/** One input that breaks a named property. */
export class Counterexample extends Error {
  constructor(
    readonly property: string,
    readonly input: unknown
  ) {
    super(`${property}: ${JSON.stringify(input)}`);
    this.name = "Counterexample";
  }
}

/** Hold one input to one property. The input is built only on failure. */
export function holds(property: string, condition: boolean, input: () => unknown): void {
  if (!condition) throw new Counterexample(property, input());
}

/** The environment variable that names the catch log, a file of JSON lines. */
export const CATCH_LOG_ENV = "SITE_BEHAVIOR_LAB_FV_CATCH_LOG";

/**
 * One accepted catch, appended whole in a single write so that lines from
 * worker threads do not interleave. `property` is what the suite named and
 * `caughtBy` is what the counterexample carried. They are written from those
 * two sources, never one copied to the other, so a harness changed to accept
 * the wrong property would show in the log. A log that cannot be written
 * throws, which fails the test: a run asked for a record must not pass
 * without it.
 */
function recordCatch(variant: string, property: string, caughtBy: string): void {
  const log = process.env[CATCH_LOG_ENV];
  if (log === undefined || log === "") return;
  appendFileSync(log, `${JSON.stringify({ variant, property, caughtBy })}\n`);
}

/**
 * The check must refuse this variant, and for this reason. Anything else fails:
 * a check that passes it, one that reports another property, or a variant that
 * throws something other than a counterexample. Only a catch that is accepted
 * is recorded: a refusal throws, and its test says so.
 */
export async function assertCaughtBy(
  variant: string,
  property: string,
  check: () => unknown | Promise<unknown>
): Promise<Counterexample> {
  try {
    await check();
  } catch (error) {
    if (!(error instanceof Counterexample)) {
      throw new Error(`Variant "${variant}" broke the check itself instead of a property: ${String(error)}`);
    }
    if (error.property !== property) {
      throw new Error(`Variant "${variant}" was caught by "${error.property}", not "${property}": ${error.message}`);
    }
    recordCatch(variant, property, error.property);
    return error;
  }
  throw new Error(`Variant "${variant}" passed the check, so the check cannot detect it.`);
}

export type SourceEdit = Readonly<{ find: string; replace: string }>;

/**
 * Compile an emitted module with its edits applied, as a separate instance.
 * Production stays as it is, and the variant's own imports are the real modules.
 * Pass the path from `require.resolve`. Each `find` must occur exactly once, so
 * an edit that drifts from the source fails rather than testing nothing.
 */
export function loadVariant<T>(modulePath: string, edits: readonly SourceEdit[]): T {
  let source = readFileSync(modulePath, "utf8");
  for (const { find, replace } of edits) {
    const occurrences = source.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`A variant edit must land exactly once in ${modulePath}, but "${find}" occurs ${occurrences} times.`);
    }
    source = source.replace(find, () => replace);
  }
  const variantModule: { exports: unknown } = { exports: {} };
  const compiled = compileFunction(source, ["exports", "require", "module", "__filename", "__dirname"], {
    filename: modulePath
  });
  compiled(variantModule.exports, createRequire(modulePath), variantModule, modulePath, path.dirname(modulePath));
  return variantModule.exports as T;
}
