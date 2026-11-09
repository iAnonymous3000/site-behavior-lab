import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_SCAN_DURATION_MS,
  QUEUE_TIMEOUT_MS,
  SCAN_RESPONSE_MARGIN_MS,
  SCROLL_CHECK_PHASE_DEADLINE_MS,
  scanResponseDeadlineMs
} from "./scan-deadlines";
import { QUEUE_TIMEOUT_MS as SERVER_QUEUE_TIMEOUT_MS } from "./scan-limits";
import { SCROLL_CHECK_TIMING } from "./scroll-check";

test("a synchronous answer's bound is the queue wait, a budget for each visit, a check's own phase, and the margin", () => {
  assert.equal(scanResponseDeadlineMs({ comparison: false, scrollCheck: false }), 80_000);
  // A comparison makes two visits, one after the other.
  assert.equal(scanResponseDeadlineMs({ comparison: true, scrollCheck: false }), 125_000);
  // A check follows a single visit with a phase of its own.
  assert.equal(scanResponseDeadlineMs({ comparison: false, scrollCheck: true }), 125_000);
  assert.equal(
    scanResponseDeadlineMs({ comparison: false, scrollCheck: false }),
    QUEUE_TIMEOUT_MS + MAX_SCAN_DURATION_MS + SCAN_RESPONSE_MARGIN_MS
  );
});

test("the server enforces the same numbers the browser sizes its wait from", () => {
  assert.equal(SERVER_QUEUE_TIMEOUT_MS, QUEUE_TIMEOUT_MS);
  assert.equal(SCROLL_CHECK_TIMING.phaseDeadlineMs, SCROLL_CHECK_PHASE_DEADLINE_MS);
  // The scanner does not export its visit budget, so what can be held is that
  // it reads the shared one and keeps no second definition to drift from it.
  const scanner = readFileSync(path.join(process.cwd(), "lib/scanner.ts"), "utf8");
  assert.match(scanner, /import \{ MAX_SCAN_DURATION_MS \} from "\.\/scan-deadlines";/);
  assert.doesNotMatch(scanner, /\bMAX_SCAN_DURATION_MS\s*=/);
});
