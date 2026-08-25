#!/usr/bin/env node
/**
 * Verify that a pilot study's committed frame derives from the input-carrier
 * commit it names. Read-only; refuses rather than repairs.
 *
 *   node scripts/calibration-v4-pilot-carrier-check.mjs \
 *     --study-dir calibration/cname-uncloaking-2026-08-prevalence-pilot \
 *     [--upstream-ref origin/main]
 *
 * Run it in the frame-freeze PR (CI runs it too) and again before dispatching
 * reviewers: it is the only thing that can catch a frame bound to a commit
 * that never landed, inputs edited after the carrier, or a frame built from a
 * tree other than the carrier's.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPilotCarrier } from "./calibration-v4-pilot-carrier-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: calibration-v4-pilot-carrier-check.mjs --study-dir <dir> [--upstream-ref <ref>]";

const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const key = args[index];
  if (!key?.startsWith("--")) {
    console.error(`unexpected argument ${key}\n${USAGE}`);
    process.exit(1);
  }
  values.set(key, args[index + 1]);
}
if (!values.get("--study-dir")) {
  console.error(`Missing required argument --study-dir\n${USAGE}`);
  process.exit(1);
}
for (const key of values.keys()) {
  if (key !== "--study-dir" && key !== "--upstream-ref") {
    console.error(`unexpected argument ${key}\n${USAGE}`);
    process.exit(1);
  }
}

try {
  const result = verifyPilotCarrier({
    rootDir: repoRoot,
    studyDir: values.get("--study-dir"),
    ...(values.get("--upstream-ref") ? { upstreamRef: values.get("--upstream-ref") } : {})
  });
  console.log(
    `pilot carrier verified: ${result.studyId} (${result.detector}), ${result.cases} cases re-derived ` +
      `byte-for-byte from carrier ${result.carrier}`
  );
} catch (error) {
  console.error(`calibration:v4-pilot-carrier-check: ${error.message}`);
  process.exit(1);
}
