import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LEGACY_V1_METHODOLOGY_UNSPECIFIED,
  legacyV1MethodologyIdentity,
  NODE_ADBLOCK_ENGINE_VERSION,
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION,
  NODE_SHIELDS_REQUEST_CONTEXT_VERSION,
  recordedAdblockEngineVersion,
  recordedPlaywrightVersion
} from "./legacy-methodology";

test("the redaction sentinel never becomes a fake methodology cohort", () => {
  assert.equal(
    legacyV1MethodologyIdentity("Methodology metadata was invalid and was removed at the public boundary."),
    LEGACY_V1_METHODOLOGY_UNSPECIFIED
  );
});

test("scanner methodology records and parses the exact Playwright version", () => {
  const disclosure =
    `Automated Chromium scan using Playwright ${NODE_PLAYWRIGHT_VERSION} under methodology ` +
    `${NODE_SCANNER_METHODOLOGY_VERSION}.`;

  assert.equal(legacyV1MethodologyIdentity(disclosure), NODE_SCANNER_METHODOLOGY_VERSION);
  assert.equal(recordedPlaywrightVersion(disclosure), NODE_PLAYWRIGHT_VERSION);
  assert.equal(recordedPlaywrightVersion(NODE_SCANNER_METHODOLOGY_VERSION), NODE_PLAYWRIGHT_VERSION);
});

test("Playwright provenance stays unknown when a report did not record an exact version", () => {
  assert.equal(recordedPlaywrightVersion("Automated Chromium scan using Playwright."), null);
  assert.equal(recordedPlaywrightVersion("Automated Chromium scan using Playwright 1.61."), null);
  assert.equal(recordedPlaywrightVersion("Automated Chromium scan using Playwright 1.61.1."), null);
  assert.equal(
    recordedPlaywrightVersion("Under methodology scanner-playwright-1.61.1.7."),
    null
  );
  assert.equal(
    recordedPlaywrightVersion("Under methodology scanner-playwright-1.61.1-beta.1."),
    null
  );
  assert.equal(
    recordedPlaywrightVersion("scanner-playwright-1.61.1+duplicate-playwright-1.61.2"),
    null
  );
  assert.equal(recordedPlaywrightVersion(undefined), null);
});

/**
 * The parser restates the shape NODE_SHIELDS_REQUEST_CONTEXT_VERSION writes, so
 * it is checked against what the producer writes today: a template change that
 * the parser no longer reads fails here, not as a silent zero downstream.
 */
test("scanner methodology records and parses the exact adblock engine version", () => {
  const disclosure =
    `Automated Chromium scan using Playwright ${NODE_PLAYWRIGHT_VERSION} under methodology ` +
    `${NODE_SCANNER_METHODOLOGY_VERSION}; main-frame navigations are not blocked.`;

  assert.equal(recordedAdblockEngineVersion(disclosure), NODE_ADBLOCK_ENGINE_VERSION);
  assert.equal(recordedAdblockEngineVersion(NODE_SCANNER_METHODOLOGY_VERSION), NODE_ADBLOCK_ENGINE_VERSION);
  assert.equal(recordedAdblockEngineVersion(NODE_SHIELDS_REQUEST_CONTEXT_VERSION), NODE_ADBLOCK_ENGINE_VERSION);
  assert.equal(
    recordedAdblockEngineVersion(
      "under methodology shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.61.1; main-frame"
    ),
    "adblock-rust-0.13.2"
  );
});

test("adblock engine provenance stays unknown when a report did not record one exactly", () => {
  assert.equal(recordedAdblockEngineVersion(undefined), null);
  assert.equal(recordedAdblockEngineVersion("Automated Chromium scan using Playwright 1.61.1."), null);
  assert.equal(
    recordedAdblockEngineVersion("Methodology metadata was invalid and was removed at the public boundary."),
    null
  );
  // A later request-method revision is a different component, not this one.
  assert.equal(
    recordedAdblockEngineVersion("shields-request-context-v2-adblock-rust-0.13.3-request-method-v10"),
    null
  );
  // The producer only writes the component first.
  assert.equal(
    recordedAdblockEngineVersion("scanner-v1+shields-request-context-v2-adblock-rust-0.13.3-request-method-v1"),
    null
  );
  assert.equal(
    recordedAdblockEngineVersion("shields-request-context-v2-adblock-rust-0.13-request-method-v1"),
    null
  );
  // Two methodology tokens name no single methodology.
  assert.equal(
    recordedAdblockEngineVersion(
      "methodology shields-request-context-v2-adblock-rust-0.13.2-request-method-v1 and methodology " +
        "shields-request-context-v2-adblock-rust-0.13.3-request-method-v1"
    ),
    null
  );
});
