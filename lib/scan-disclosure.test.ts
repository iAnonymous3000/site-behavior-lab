import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { clientImportTrails } from "./client-import-graph";
import { RUN_MODE_TITLES } from "./run-mode-copy";
import { SCAN_DISCLOSURE, SCAN_DISCLOSURE_VISIT, SCAN_DISCLOSURE_VISIT_REST } from "./scan-disclosure";

/**
 * The homepage's statement of what a v3 scan does to the page. Each clause
 * states the actual browser visit actions plainly before submission.
 */

const text = SCAN_DISCLOSURE.join(" ");
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("the disclosure describes the v3 Chromium visit, scroll check, typing test, and privacy-policy read", () => {
  assert.equal(SCAN_DISCLOSURE[0], `${SCAN_DISCLOSURE_VISIT} ${SCAN_DISCLOSURE_VISIT_REST}`);
  assert.match(text, /^A single scan is one automated, headless Chromium visit/);
  assert.match(text, /scrolls to observe lazy-loaded traffic/);
  assert.match(text, /types a made-up test value into visible form fields, never submitting the form/);
  assert.match(text, /reads the site's privacy policy when it finds one/);
  assert.doesNotMatch(text, /submits nothing|sends nothing|nothing is sent/i);
  assert.doesNotMatch(text, /\b(?:each|every) scan is one\b/i);
});

test("the disclosure names the two-visit comparison modes and consent attempts", () => {
  assert.match(text, /Comparison modes run two isolated visits/);
  for (const mode of ["gpc", "shields", "consent"] as const) {
    assert.match(RUN_MODE_TITLES[mode], /^(?:Experimental\. )?Two visits/, `${mode} is a two-visit mode`);
  }
  assert.match(text, /consent mode tries to click Accept all in one and Reject all in the other/);
});

test("the disclosure reads plainly", () => {
  const words = (sentence: string) => (sentence.match(/\S+/g) ?? []).length;
  for (const paragraph of SCAN_DISCLOSURE) {
    for (const sentence of paragraph.split(/(?<=[.!?])\s+(?=[A-Z"(])/)) {
      assert.ok(words(sentence) <= 30, `${words(sentence)} words: ${sentence}`);
    }
    assert.doesNotMatch(paragraph, /\u2014|\u2013/);
  }
});

test("the homepage renders the disclosure on the server, under the URL field", () => {
  const page = source("app/page.tsx");
  assert.match(page, /import \{ ScanDisclosure \} from "\.\/_components\/scan-disclosure";/);
  assert.match(page, /scanDisclosure=\{<ScanDisclosure \/>\}/);
  assert.match(source("app/site-behavior-app.tsx"), /disclosure=\{scanDisclosure\}/);
  const controls = source("app/_components/scan-controls.tsx");
  const field = controls.indexOf('className="url-row"');
  const disclosure = controls.indexOf("{disclosure}");
  const examples = controls.indexOf("{knownSite ? (");
  assert.ok(field !== -1 && disclosure > field && disclosure < examples, "the disclosure sits under the URL field, before the examples");
  // Server-only: as markup it costs HTML, not homepage JavaScript.
  for (const module of ["lib/scan-disclosure.ts", "app/_components/scan-disclosure.tsx"]) {
    assert.deepEqual(clientImportTrails(module), [], `${module} must not reach a client bundle`);
  }
  assert.doesNotMatch(source("app/_components/scan-disclosure.tsx"), /^\s*["']use client["']/m);
});

test("the operator status line sits under More options, and a failure stays in view with its retry", () => {
  const controls = source("app/_components/scan-controls.tsx");
  const options = controls.slice(controls.indexOf('<details className="options-disclosure">'));
  assert.match(options, /\{!scannerStatusError && <p className="scanner-status-note">\{scannerStatus\}<\/p>\}/);
  const health = controls.slice(controls.indexOf('<div className="scanner-health-row">'), controls.indexOf('<details className="options-disclosure">'));
  // Always mounted, so a failure arriving later is announced.
  assert.match(health, /role="status"\s+aria-live="polite"\s*>\s*\{scannerStatusError \? scannerStatus : ""\}/);
  assert.match(health, /\{scannerStatusError && \(\s*<button className="ghost-button scanner-health-retry"/);
  assert.ok(controls.indexOf('<div className="scanner-health-row">') < controls.indexOf('<details className="options-disclosure">'));
});
