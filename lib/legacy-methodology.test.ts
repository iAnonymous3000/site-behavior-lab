import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION,
  legacyV1MethodologyIdentity,
  recordedPlaywrightVersion
} from "./legacy-methodology";

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
