#!/usr/bin/env node

// Runs one leg of `npm run test:unit`, so hosted CI can run the suite on
// several machines at once instead of on one in a row. Which tests run, and
// everything each one asserts, is unchanged: package.json's test:unit stays
// the one list of steps, and every leg is cut from it here, never restated.
//
// test:unit is a chain of steps joined by ` && `. The steps before the lanes
// step compile the lib tests; every leg runs them first, because each leg is a
// fresh machine and the later steps read what they compile. The lanes step
// runs the lib tests in two phases (scripts/unit-test-lanes.mjs): the
// `parallel` leg runs its parallel phase, beside the alongside command and
// with its dist/ check, and each `serial-<k>` leg runs one shard of its
// serial lane, every file one at a time as before. The `tail` leg runs every
// step after the lanes step, in order, on one machine, because some of those
// steps read what an earlier one wrote (dist/schema, among others).
//
// The split changes one condition: a serial file no longer runs after the
// parallel phase has passed, and the serial files no longer run one after
// another in a single sequence. Each still runs alone on its machine. Every
// leg must pass, so the gate is the same, and a run reports more failures.
//
// Usage: npm run test:unit:leg -- <leg>, with the leg one of LEGS.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Measured on four green main runs on 2026-11-15: with four shards the
// slowest takes about 490 s on a runner, close to the parallel and tail
// legs; three shards leave one near 590 s, and five gain nothing on the
// other legs. The shard count is this one constant.
export const SERIAL_SHARDS = 4;
export const LEGS = Object.freeze([
  "parallel",
  ...Array.from({ length: SERIAL_SHARDS }, (_, index) => `serial-${index + 1}`),
  "tail"
]);
export const LANES_COMMAND = "node scripts/unit-test-lanes.mjs ";
const USAGE = `Usage: unit-test-plan.mjs <leg>, where the leg is one of: ${LEGS.join(", ")}`;

// The steps of test:unit, split as npm's shell would run them.
export function testUnitParts(scripts) {
  const testUnit = scripts?.["test:unit"];
  if (typeof testUnit !== "string" || testUnit.length === 0) throw new Error("package.json has no test:unit script");
  return testUnit.split(" && ");
}

// The exact commands one leg runs, in order.
export function planLeg(leg, scripts) {
  if (!LEGS.includes(leg)) throw new Error(USAGE);
  const parts = testUnitParts(scripts);
  const lanes = parts.flatMap((part, index) => (part.startsWith(LANES_COMMAND) ? [index] : []));
  if (lanes.length !== 1) throw new Error(`test:unit must run ${LANES_COMMAND.trim()} exactly once, not ${lanes.length} times`);
  const [at] = lanes;
  if (at === 0) throw new Error("test:unit must compile the lib tests before its lanes step");
  const compile = parts.slice(0, at);
  const selected = (selector) => `${LANES_COMMAND}${selector} ${parts[at].slice(LANES_COMMAND.length)}`;
  if (leg === "parallel") return [...compile, selected("--only parallel")];
  if (leg === "tail") {
    const tail = parts.slice(at + 1);
    if (tail.length === 0) throw new Error("test:unit has no step after its lanes step, so the tail leg would run nothing");
    return [...compile, ...tail];
  }
  const index = Number(leg.slice("serial-".length));
  return [...compile, selected(`--only serial --shard ${index}/${SERIAL_SHARDS}`)];
}

function runStep(step) {
  // npm runs a script's text with `sh -c`; each step here runs the same way,
  // with the environment npm gave this process (node_modules/.bin on PATH).
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", step], { stdio: "inherit" });
    const forward = (signal) => child.kill(signal);
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    const finish = (code, signal, error) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve({ ok: code === 0 && !signal && !error, code, signal, error });
    };
    child.on("error", (error) => finish(null, null, error));
    child.on("close", (code, signal) => finish(code, signal, null));
  });
}

async function main() {
  const [leg, ...extra] = process.argv.slice(2);
  if (extra.length > 0) throw new Error(USAGE);
  const scripts = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).scripts;
  const steps = planLeg(leg, scripts);
  console.log(`test:unit leg ${leg} of ${LEGS.length} (${LEGS.join(", ")}) runs ${steps.length} steps:`);
  for (const step of steps) console.log(`  ${step}`);
  for (const [index, step] of steps.entries()) {
    const result = await runStep(step);
    if (!result.ok) {
      const how = result.error
        ? `could not start (${result.error.message})`
        : result.signal
          ? `was killed by ${result.signal}`
          : `failed with exit code ${result.code}`;
      console.error(`test:unit leg ${leg}: step ${index + 1} of ${steps.length} ${how}: ${step}`);
      return 1;
    }
  }
  console.log(`test:unit leg ${leg} passed all ${steps.length} steps.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  );
}
