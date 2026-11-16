#!/usr/bin/env node

// Runs `npm run check` without its `npm run test:unit` part, for the one build
// that hosted CI makes after running test:unit in separate jobs on the same
// source image (the Dockerfile's compiled stage). Every other part of check
// runs, in check's own order, read from package.json, never restated. In
// test:unit's place it compiles the lib tests as test:unit does and runs
// lib/scan-browser-hsts-preload.test.ts alone, so even this build fails once
// the pinned Chromium stops applying its HSTS preload list.
//
// Usage: npm run check:without-unit

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLane } from "./unit-test-lanes.mjs";
import { LANES_COMMAND, testUnitParts } from "./unit-test-plan.mjs";

export const HSTS_TEST = ".unit-test-dist/lib/scan-browser-hsts-preload.test.js";

export function checkWithoutUnit(scripts) {
  const parts = scripts.check.split(" && ");
  const unit = parts.filter((part) => part === "npm run test:unit");
  if (unit.length !== 1) throw new Error(`check must run npm run test:unit exactly once, not ${unit.length} times`);
  const testUnit = testUnitParts(scripts);
  const lanesAt = testUnit.findIndex((part) => part.startsWith(LANES_COMMAND));
  if (lanesAt <= 0) throw new Error("test:unit must compile before its lanes step");
  return { parts, compile: testUnit.slice(0, lanesAt) };
}

function sh(step) {
  console.log(`> ${step}`);
  const result = spawnSync("sh", ["-c", step], { stdio: "inherit" });
  if (result.status !== 0 || result.signal || result.error) {
    console.error(`check:without-unit stopped: ${step} ${result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`}`);
    process.exit(1);
  }
}

async function main() {
  const scripts = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")).scripts;
  const { parts, compile } = checkWithoutUnit(scripts);
  for (const part of parts) {
    if (part !== "npm run test:unit") {
      sh(part);
      continue;
    }
    for (const step of compile) sh(step);
    const hsts = await runLane([HSTS_TEST], 1, { requireRealTests: true });
    if (!hsts.ok) {
      console.error(`check:without-unit stopped: ${HSTS_TEST} did not pass`);
      process.exit(1);
    }
    console.log(`check:without-unit: ${HSTS_TEST} passed; the rest of test:unit runs in hosted CI's legs.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
