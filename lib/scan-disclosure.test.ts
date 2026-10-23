import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { clientImportTrails } from "./client-import-graph";
import { consentChoiceLabel } from "./consent-interaction";
import { publicStringPolicyInputs, redactScanResultV1 } from "./redact-scan-report-v1";
import { RUN_MODE_TITLES } from "./run-mode-copy";
import { SCAN_DISCLOSURE, SCAN_DISCLOSURE_VISIT, SCAN_DISCLOSURE_VISIT_REST, SCROLL_CHECK_DISCLOSURE_VISIT } from "./scan-disclosure";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { MAX_SCROLL_CHECK_SCREENS } from "./scroll-check-evidence";
import type { ScanResult } from "./types";

/**
 * The homepage's statement of what a scan does to the page. Each clause must
 * be one the scanner itself admits, so the entry can never promise less
 * interaction than a report then discloses.
 */

const text = SCAN_DISCLOSURE.join(" ");
const FIXED_WARNINGS: readonly string[] = publicStringPolicyInputs().fixedWarnings;
const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("the disclosure restates the scanner's own description of the visit", () => {
  // "one automated, headless Chromium visit from a fixed en-US / UTC profile,
  // with no scrolling, clicking, or consent interaction"
  const visit = "one automated, headless Chromium visit from a fixed en-US / UTC profile";
  assert.ok(text.includes(visit), text);
  assert.ok(FIXED_WARNINGS.some((warning) => warning.includes(`${visit}, with no scrolling, clicking, or consent interaction.`)));
  assert.match(text, /with no scrolling, clicking or consent interaction\./);
  // One visit is the single mode; the comparison modes run two, so the
  // one-visit sentence names its mode rather than every scan.
  assert.match(text, /^A single scan is one automated/);
  assert.doesNotMatch(text, /\b(?:each|every) scan is one\b/i);
});

test("the disclosure says the visit types a made-up value and never submits the form, in the scanner's words", () => {
  assert.match(text, /types a made-up test value into form fields, never submitting the form/);
  // The phrase the reader restates, as the sanitizer admits it on a report.
  const disclosure =
    "This scan typed a synthetic test value into 2 form fields (never submitting the form) to test whether typed input is captured and sent to third parties. The value is synthetic and is not stored.";
  const result = makeScanReportV1() as ScanResult;
  result.warnings = [disclosure];
  assert.deepEqual(redactScanResultV1(result).report.warnings, [disclosure]);
  assert.ok(disclosure.includes("never submitting the form"));
  // Typing can make the page send requests; "submits nothing" would imply it cannot.
  assert.doesNotMatch(text, /submits nothing|sends nothing|nothing is sent/i);
});

test("the disclosure names the privacy-policy read, the two-visit modes, and the consent clicks", () => {
  assert.match(text, /reads the site's privacy policy when it finds one/);
  assert.match(
    "Read the site's privacy policy (https://example.com/privacy) and compared its text against this visit's observed behavior. Policy checks are an automated text match with the matched sentences quoted, not a legal reading.",
    /^Read the site's privacy policy \(.+\) and compared its text/
  );
  assert.match(text, /Comparison modes run two visits/);
  for (const mode of ["gpc", "shields", "consent"] as const) {
    assert.match(RUN_MODE_TITLES[mode], /^(?:Experimental\. )?Two visits/, `${mode} is a two-visit mode`);
  }
  assert.ok(text.includes(`${consentChoiceLabel("accept-all")} in one and ${consentChoiceLabel("reject-all")} in the other`));
  // The scanner attempts the click; most committed consent pairs record no
  // activated control, so the entry must not promise one.
  assert.match(text, /consent mode tries to click/);
  assert.ok(FIXED_WARNINGS.some((warning) => warning.includes("scripted attempts to activate one choice on the cookie/consent banner")));
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

test("a check arrival's disclosure says what a check is, and only its first sentence differs", () => {
  // The single scan's paragraph is the same text it was, split in two.
  assert.equal(SCAN_DISCLOSURE[0], `${SCAN_DISCLOSURE_VISIT} ${SCAN_DISCLOSURE_VISIT_REST}`);
  assert.equal(
    SCAN_DISCLOSURE[0],
    "A single scan is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling, clicking or consent interaction. Each visit types a made-up test value into form fields, never submitting the form, and reads the site's privacy policy when it finds one."
  );
  // The approved sentence (owner, 2026-10-23), restating the scanner's own
  // visit description and the check's screen limit.
  assert.equal(
    SCROLL_CHECK_DISCLOSURE_VISIT,
    "A check is one automated, headless Chromium visit from a fixed en-US / UTC profile: a single scan, then up to 8 screens of scrolling, with no clicking."
  );
  assert.ok(SCROLL_CHECK_DISCLOSURE_VISIT.includes("one automated, headless Chromium visit from a fixed en-US / UTC profile"));
  assert.ok(SCROLL_CHECK_DISCLOSURE_VISIT.includes(`up to ${MAX_SCROLL_CHECK_SCREENS} screens of scrolling`));
  assert.ok((SCROLL_CHECK_DISCLOSURE_VISIT.match(/\S+/g) ?? []).length <= 30);
  assert.doesNotMatch(SCROLL_CHECK_DISCLOSURE_VISIT, new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`));
  // The page shows the single scan's sentence unless the form marks a check
  // arrival, so a page without JavaScript never says it scrolls.
  const css = source("app/globals.css");
  assert.match(css, /\n\.scan-disclosure-check-visit \{\s*display: none;\s*\}/);
  assert.match(css, /\n\.scan-panel\[data-scroll-check\] \.scan-disclosure-visit \{\s*display: none;\s*\}/);
  assert.match(css, /\n\.scan-panel\[data-scroll-check\] \.scan-disclosure-check-visit \{\s*display: inline;\s*\}/);
  assert.equal(css.match(/scan-disclosure-(?:check-)?visit/g)?.length, 3, "nothing else styles either sentence");
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
  // The first paragraph renders both first sentences, then the rest of it;
  // every other paragraph renders as it is.
  assert.match(
    source("app/_components/scan-disclosure.tsx"),
    /const \[, \.\.\.others\] = SCAN_DISCLOSURE;[\s\S]*?<p>\s*<span className="scan-disclosure-visit">\{SCAN_DISCLOSURE_VISIT\}<\/span>\s*<span className="scan-disclosure-check-visit">\{SCROLL_CHECK_DISCLOSURE_VISIT\}<\/span>\{" "\}\s*\{SCAN_DISCLOSURE_VISIT_REST\}\s*<\/p>\s*\{others\.map\(/
  );
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
