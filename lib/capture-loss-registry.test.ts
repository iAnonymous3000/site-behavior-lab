import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PAGE_SUBJECT_CAPTURE_LOSS_DETAIL } from "./bot-wall-classifier";
import { BUDGET_FAMILIES } from "./scan-report-v2-evaluators";

/**
 * The r2 producer resolves every recorded capture-loss detail through
 * BUDGET_FAMILIES and THROWS on an unregistered one
 * (scan-result-v2-r2-builder.ts assertQualityVocabulary), so an unregistered
 * detail is not a cosmetic gap: it is a 500 to the visitor for every scan that
 * records it. That has now happened twice from the same cause --
 * `policy-link-candidates` (every page with more policy-link candidates than
 * the cap, github.com among them) and `page-subject-validity` (every page whose
 * trusted-subject text read is unavailable, which is exactly the hostile or
 * heavy page this scanner most needs to publish about).
 *
 * Both halves were individually correct and individually tested: the scanner
 * recorded a detail the view layer knew how to render, and the registry was a
 * separate hand-maintained list nothing connected to the producers. Read the
 * producers' own source instead of restating the list.
 */
const PRODUCERS = [
  "scanner.ts",
  "scan-runtime.ts",
  "public-scan-proxy.ts",
  "measurement-kernel.ts"
];

/**
 * Every exported `const NAME = "value"` in lib, so a producer that writes
 * `detail: PAGE_SUBJECT_CAPTURE_LOSS_DETAIL` is resolved rather than skipped.
 * The first version of this guard matched string literals only and therefore
 * still passed with the registry entry deleted -- the test shared the bug's
 * blind spot.
 */
function stringConstants(libDir: string): Map<string, string> {
  const constants = new Map<string, string>();
  for (const file of readdirSync(libDir)) {
    if (!file.endsWith(".ts") || file.includes(".test.")) continue;
    const source = readFileSync(path.join(libDir, file), "utf8");
    for (const match of source.matchAll(
      /export const ([A-Z][A-Z0-9_]*)\s*=\s*"([^"\n]+)"/g
    )) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/** `detail:` / `exhaustBudget({ name:` arguments, literal or named constant. */
function recordedDetails(source: string, constants: Map<string, string>): string[] {
  const details = new Set<string>();
  const add = (raw: string) => {
    const resolved = raw.startsWith('"') ? raw.slice(1, -1) : constants.get(raw);
    if (resolved !== undefined) details.add(resolved);
  };
  for (const match of source.matchAll(/detail:\s*("[^"\n]+"|[A-Z][A-Z0-9_]*)/g)) {
    add(match[1]);
  }
  // exhaustBudget({ name: ... }) becomes `detail: name` downstream.
  for (const match of source.matchAll(
    /exhaustBudget\(\{[^}]*?name:\s*("[^"\n]+"|[A-Z][A-Z0-9_]*)/g
  )) {
    add(match[1]);
  }
  return [...details];
}

test("every capture-loss detail a producer can record is registered in BUDGET_FAMILIES", () => {
  const libDir = path.join(process.cwd(), "lib");
  const constants = stringConstants(libDir);
  const unregistered: string[] = [];
  let checked = 0;

  for (const file of PRODUCERS) {
    const source = readFileSync(path.join(libDir, file), "utf8");
    for (const detail of recordedDetails(source, constants)) {
      // Builder-owned public projection markers are added by the builder
      // itself and are rejected when supplied by a caller.
      if (detail.startsWith("public-")) continue;
      checked += 1;
      if (BUDGET_FAMILIES[detail] === undefined) {
        unregistered.push(`${file}: ${detail}`);
      }
    }
  }

  assert.ok(checked > 5, `expected to find recorded details, scanned ${checked}`);
  assert.deepEqual(
    unregistered,
    [],
    "an unregistered capture-loss detail makes the r2 producer throw instead of publishing"
  );
});

test("the page-subject validity detail is registered for the family the scanner records", () => {
  // Pinned by name because this one reached production: the scanner records it
  // under "detector-output", and assertQualityVocabulary requires the registry
  // family to MATCH, not merely to exist.
  assert.equal(BUDGET_FAMILIES[PAGE_SUBJECT_CAPTURE_LOSS_DETAIL], "detector-output");

  const scanner = readFileSync(path.join(process.cwd(), "lib", "scanner.ts"), "utf8");
  const recorded = scanner.match(
    /recordCaptureLoss\(\{[^}]*?family:\s*"([a-z-]+)"[^}]*?detail:\s*PAGE_SUBJECT_CAPTURE_LOSS_DETAIL/
  );
  assert.ok(recorded, "the scanner must still record the page-subject capture loss");
  assert.equal(recorded[1], BUDGET_FAMILIES[PAGE_SUBJECT_CAPTURE_LOSS_DETAIL]);
});
