#!/usr/bin/env node

// Runs the suites a test:unit stage names, one by one, through the lanes' own
// lane, with its bounds and its guard.
//
// The producer suites under scripts/ and research/ are plain ESM that no glob
// compiles, so each stage names its files. node --test alone passes such a run
// with a named file missing, as long as some other named file exists, and
// passes a file whose process exits 0 on whatever results reached it: an early
// process.exit(0), or --test-force-exit ending the process while results are
// still queued for the pipe, which dropped the last 45 results of a lib test on
// 2026-10-21. The lib lanes and the investigation stage were guarded against
// both; these stages ran bare. The lane fails on both, by name, since neither
// leaves that file's summary behind. scripts/unit-test-lanes.mjs explains the
// summary and the blocking stdout that keeps it.
//
// Unlike the investigation stage this one allows a skip: a suite here may skip
// a case on a stated environment condition (a missing git history in the image
// build, say).

import { describeLane, PARALLEL_FILES, runLane, stopLanesOnSignal } from "./unit-test-lanes.mjs";

const [label, ...files] = process.argv.slice(2);
if (label === undefined || files.length === 0 || /\.m?js$/.test(label)) {
  // With no files node --test would discover every test under the working
  // directory, and a label that looks like a suite is a forgotten label.
  console.error("Usage: guarded-test-stage.mjs <stage label> <test suites...>");
  process.exitCode = 1;
} else {
  stopLanesOnSignal();
  const result = await runLane(files, PARALLEL_FILES);
  console.log(describeLane(`${label} (${files.length} ${files.length === 1 ? "file" : "files"})`, result));
  process.exitCode = result.ok ? 0 : 1;
}
