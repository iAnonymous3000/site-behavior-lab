import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PAGE_SUBJECT_CAPTURE_LOSS_DETAIL } from "./bot-wall-classifier";
import {
  CAPTURE_LOSS_DETAIL_FAMILIES,
  PAGEGRAPH_UNSUPPORTED_CAPTURE_LOSS_FAMILIES,
  captureLossDetailAllowsFamily,
  isKnownCaptureLossDetail
} from "./capture-loss-detail-contract";
import { captureLossDetailNote } from "./capture-loss-presentation";
import { recordedDetails, recordedFamilyDetails, stringConstants } from "./producer-loss-source";
import { BUDGET_FAMILIES } from "./scan-report-v2-evaluators";

/**
 * The r2 producer resolves every recorded capture-loss detail through the
 * shared semantic contract and THROWS on an unregistered one
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
 * producers' own source instead of restating the list, and require the same
 * contract to supply both the builder family and the public presentation.
 */
const PRODUCERS = [
  "scanner.ts",
  "scan-runtime.ts",
  "public-scan-proxy.ts",
  "measurement-kernel.ts",
  "pagegraph-v2-r2-builder.ts"
];

test("every capture-loss detail a producer can record has a family and reader presentation", () => {
  const libDir = path.join(process.cwd(), "lib");
  const constants = stringConstants(libDir);
  const unregistered: string[] = [];
  const misfiled: string[] = [];
  let checked = 0;
  let checkedFamilyPairs = 0;

  for (const file of PRODUCERS) {
    const source = readFileSync(path.join(libDir, file), "utf8");
    for (const detail of recordedDetails(source, constants)) {
      // Builder-owned public projection markers are added by the builder
      // itself and are rejected when supplied by a caller.
      if (detail.startsWith("public-")) continue;
      checked += 1;
      if (!isKnownCaptureLossDetail(detail)) {
        unregistered.push(`${file}: ${detail}`);
      }
    }
    for (const { detail, family } of recordedFamilyDetails(source, constants)) {
      checkedFamilyPairs += 1;
      if (!captureLossDetailAllowsFamily(detail, family)) misfiled.push(`${file}: ${detail}/${family}`);
    }
  }

  assert.ok(checked > 5, `expected to find recorded details, scanned ${checked}`);
  assert.ok(checkedFamilyPairs > 5, `expected to find recorded detail/family pairs, scanned ${checkedFamilyPairs}`);
  assert.deepEqual(
    unregistered,
    [],
    "an unregistered capture-loss detail either makes the producer throw or leaks its token to readers"
  );
  assert.deepEqual(misfiled, [], "a first-party producer records a capture-loss detail under the wrong family");
});

test("the page-subject validity detail is registered for the family the scanner records", () => {
  // Pinned by name because this one reached production: the scanner records it
  // under "detector-output", and assertQualityVocabulary requires the registry
  // family to MATCH, not merely to exist.
  assert.equal(captureLossDetailAllowsFamily(PAGE_SUBJECT_CAPTURE_LOSS_DETAIL, "detector-output"), true);

  const scanner = readFileSync(path.join(process.cwd(), "lib", "scanner.ts"), "utf8");
  const recorded = scanner.match(
    /recordCaptureLoss\(\{[^}]*?family:\s*"([a-z-]+)"[^}]*?detail:\s*PAGE_SUBJECT_CAPTURE_LOSS_DETAIL/
  );
  assert.ok(recorded, "the scanner must still record the page-subject capture loss");
  assert.equal(captureLossDetailAllowsFamily(PAGE_SUBJECT_CAPTURE_LOSS_DETAIL, recorded[1] as "detector-output"), true);
});

test("the PageGraph unsupported sentinel is registered for its complete five-family set", () => {
  assert.deepEqual(PAGEGRAPH_UNSUPPORTED_CAPTURE_LOSS_FAMILIES, [
    "cookies",
    "storage",
    "fingerprinting",
    "detector-output",
    "consent-verification"
  ]);
  for (const family of PAGEGRAPH_UNSUPPORTED_CAPTURE_LOSS_FAMILIES) {
    assert.equal(captureLossDetailAllowsFamily("pagegraph-unsupported", family), true, family);
  }
  assert.equal(captureLossDetailAllowsFamily("pagegraph-unsupported", "requests"), false);
});

test("the compiler-backed presentation switch covers every semantic detail and family", () => {
  for (const [budget, family] of Object.entries(BUDGET_FAMILIES)) {
    assert.equal(captureLossDetailAllowsFamily(budget, family), true, budget);
  }
  for (const [detail, families] of Object.entries(CAPTURE_LOSS_DETAIL_FAMILIES)) {
    for (const family of families) {
      assert.match(
        captureLossDetailNote({ family, phaseId: null, kind: "dropped", count: 17, detail }),
        /17/,
        `${detail}/${family} must carry its recorded count into reader copy`
      );
    }
  }
});
