#!/usr/bin/env node

// Runs the private investigation workspace's suites, named one by one in
// test:investigation, through the lanes' own lane, with its bounds and its guard.
//
// node --test alone passes a run with a named file missing, as long as some other
// named file exists, so a suite a compile stopped emitting would drop out unseen.
// It also passes a file whose process exits 0 on whatever results reached it. The
// lane fails on both, by name, since neither leaves that file's summary behind.
// This stage also fails a suite that ran no real test, and any skip or todo, since a
// security suite that quietly stopped running reads exactly like one that passed.
// scripts/unit-test-lanes.mjs explains the summary, and its test holds this too.

import { describeLane, PARALLEL_FILES, runLane, stopLanesOnSignal } from "./unit-test-lanes.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  // With no files node --test would discover every test under the working directory.
  console.error("Usage: investigation-test-stage.mjs <compiled investigation suites...>");
  process.exitCode = 1;
} else {
  stopLanesOnSignal();
  const result = await runLane(files, PARALLEL_FILES, { requireRealTests: true });
  console.log(describeLane(`Investigation lane (${files.length} files)`, result));
  process.exitCode = result.ok ? 0 : 1;
}
