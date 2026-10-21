import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { HomepageKnownSite } from "./homepage-discovery";
import {
  isScanAgainArrival,
  knownEvidenceDifference,
  knownEvidenceReport,
  knownEvidenceTarget,
  leadsWithExistingReport,
  matchingKnownSite,
  scanSubmitLabel,
  shareRetentionClause
} from "./known-site-evidence";
import { LIVE_RESCAN_HISTORY_CLAUSE } from "./live-rescan-copy";
import { RUN_MODE_LABELS, type RunMode } from "./run-mode-copy";
import { deriveScanRuntimePolicy, fetchRuntimeScannerHealth } from "./scan-client-orchestration";
import { isScanRuntimeHealth, type ScanRuntimeHealth } from "./scan-runtime-health";

const RUN_MODES = Object.keys(RUN_MODE_LABELS) as RunMode[];

function site(overrides: Partial<HomepageKnownSite> = {}): HomepageKnownSite {
  return {
    domain: "webmd.com",
    latestReportId: "20261019-15e17f5580e627c7722f78669ec706a7",
    scannedAt: "2026-10-19T11:01:25.616Z",
    requestedUrl: "https://www.webmd.com/",
    headline: "webmd.com loaded 41 fewer third-party requests with Shields on.",
    runMode: "shields",
    ...overrides
  };
}

function policyFor(health: ScanRuntimeHealth | null, healthError: string | null = null) {
  return deriveScanRuntimePolicy({
    liveScanEnabled: true,
    staticExport: true,
    staticLiveScanEnabled: true,
    openAccessBuild: true,
    reportPage: false,
    turnstileSiteKeyConfigured: true,
    turnstileToken: "",
    health,
    healthError
  });
}

function differenceFor(maxAgeDays: number | null): string {
  return knownEvidenceDifference({ comparison: false, maxAgeDays });
}

test("the share retention is the scanner's own, and with no usable value no number is stated", async () => {
  // Valid: health answered with a finite positive number.
  const valid = policyFor({ ok: true, status: "ok", scansAvailable: true, checks: { reportStore: { maxAgeDays: 7 } } });
  assert.equal(valid.shareReportMaxAgeDays, 7);
  assert.match(differenceFor(valid.shareReportMaxAgeDays), /, kept for up to about 7 days\. /);

  // Pending: health has not answered.
  const pending = policyFor(null);
  assert.equal(pending.awaitingScannerHealth, true);
  assert.equal(pending.shareReportMaxAgeDays, null);

  // Failed: the health request itself failed.
  const fetched = await fetchRuntimeScannerHealth({
    fetcher: async () => new Response("unavailable", { status: 503 }),
    resolveApiUrl: (route) => route
  });
  assert.equal(fetched.health, null);
  const failed = policyFor(fetched.health, fetched.error);
  assert.equal(failed.scannerUnavailable, true);
  assert.equal(failed.shareReportMaxAgeDays, null);

  // Invalid: health answered, but its retention is unusable. The payload is
  // still healthy (scans stay available); only the number is withheld.
  const invalid: [string, string][] = [
    ["0 (the producer's store-unavailable value)", '{"maxAgeDays":0}'],
    ["negative", '{"maxAgeDays":-7}'],
    ["not finite (JSON reads 1e400 as Infinity)", '{"maxAgeDays":1e400}'],
    ["non-number", '{"maxAgeDays":"7"}'],
    ["null", '{"maxAgeDays":null}'],
    ["missing value", "{}"]
  ];
  for (const [name, reportStore] of invalid) {
    const payload: unknown = JSON.parse(`{"ok":true,"status":"ok","scansAvailable":true,"checks":{"reportStore":${reportStore}}}`);
    assert.equal(isScanRuntimeHealth(payload), true, name);
    const policy = policyFor(payload as ScanRuntimeHealth);
    assert.equal(policy.scannerUnavailable, false, name);
    assert.equal(policy.scanBlocked, false, `${name}: scans stay available`);
    assert.equal(policy.shareReportMaxAgeDays, null, name);
  }
  // NaN cannot cross JSON, but a value read some other way must not pass either.
  assert.equal(policyFor({ ok: true, checks: { reportStore: { maxAgeDays: Number.NaN } } }).shareReportMaxAgeDays, null);
  assert.equal(policyFor({ ok: true, checks: {} }).shareReportMaxAgeDays, null, "missing store");
  assert.equal(policyFor({ ok: true }).shareReportMaxAgeDays, null, "missing checks");

  // The no-number line states no number at all: never the build's default.
  const none = differenceFor(null);
  assert.match(none, /, kept for a limited time\. /);
  assert.doesNotMatch(none, /\d/);
});

test("the retention clause says up to about N days, in days, and nothing more precise than that", () => {
  assert.equal(shareRetentionClause(7), "kept for up to about 7 days");
  assert.equal(shareRetentionClause(1), "kept for up to about 1 day");
  assert.equal(shareRetentionClause(0.5), "kept for up to about 0.5 days");
  assert.equal(shareRetentionClause(2.34), "kept for up to about 2.3 days");
  assert.equal(shareRetentionClause(null), "kept for a limited time");
});

test("the difference line names the visits, the separate share, its retention and the history, in the site page's words", () => {
  assert.equal(
    knownEvidenceDifference({ comparison: false, maxAgeDays: 7 }),
    "A new check runs one visit in the selected mode and makes a separate share report, kept for up to about 7 days. " +
      "It is not added to this site's history: a live rescan remains a standalone share report until a later corpus " +
      "publication includes it."
  );
  assert.equal(
    knownEvidenceDifference({ comparison: true, maxAgeDays: null }),
    "A new check runs two visits in the selected mode and makes a separate share report, kept for a limited time. " +
      "It is not added to this site's history: a live rescan remains a standalone share report until a later corpus " +
      "publication includes it."
  );
  for (const comparison of [false, true]) {
    const line = knownEvidenceDifference({ comparison, maxAgeDays: 7 });
    assert.ok(line.endsWith(`: ${LIVE_RESCAN_HISTORY_CLAUSE}.`), "the history clause is the shared one");
    // No duration figure: how long a check takes is not measured.
    assert.doesNotMatch(line, /second|minute|hour|takes|wait/i);
    assert.equal(line.split(/(?<=\.) /).length, 2, "two sentences");
  }
});

test("the one submit button reads Check now or Compare now only while the report leads", () => {
  for (const mode of RUN_MODES) {
    const comparison = mode !== "single";
    assert.equal(scanSubmitLabel({ comparison, leadsWithReport: true }), comparison ? "Compare now" : "Check now", mode);
    assert.equal(scanSubmitLabel({ comparison, leadsWithReport: false }), comparison ? "Compare" : "Scan", mode);
  }
});

test("an arrival from the site's own Scan again link keeps the usual button until the field changes", () => {
  const prefilled = "https://www.webmd.com/";
  assert.equal(isScanAgainArrival(prefilled, prefilled), true);
  assert.equal(isScanAgainArrival(prefilled, "https://www.webmd.com/x"), false, "the first edit ends the arrival");
  assert.equal(isScanAgainArrival(null, prefilled), false, "typing is never an arrival");

  const leads = (siteMatched: boolean, scanAgainArrival: boolean, scanBusy: boolean) =>
    leadsWithExistingReport({ siteMatched, scanAgainArrival, scanBusy });
  assert.equal(leads(true, false, false), true);
  assert.equal(leads(true, true, false), false, "the visitor asked to scan again");
  assert.equal(leads(true, false, true), false, "a running or retained scan keeps the usual button");
  assert.equal(leads(false, false, false), false, "no site, no change");
  assert.equal(leads(false, true, true), false);
});

test("the note says which page the evidence is for, never the typed one", () => {
  const webmd = "https://www.webmd.com/";
  const forWebmd = "This evidence is for https://www.webmd.com/.";
  // A deep path, a subdomain and the bare domain all match webmd.com by host suffix.
  assert.equal(knownEvidenceTarget("https://www.webmd.com/diet/obesity/default.htm", webmd), forWebmd);
  assert.equal(knownEvidenceTarget("blog.webmd.com", webmd), forWebmd);
  assert.equal(knownEvidenceTarget("webmd.com", webmd), forWebmd);
  assert.doesNotMatch(knownEvidenceTarget("https://www.webmd.com/diet/obesity/default.htm", webmd) ?? "", /diet/);
  // A report that requested a subdomain, or a path, names it.
  assert.equal(knownEvidenceTarget("ycombinator.com", "https://news.ycombinator.com/"), "This evidence is for https://news.ycombinator.com/.");
  assert.equal(knownEvidenceTarget("https://www.amnesty.org/en/latest", "https://www.amnesty.org/en"), "This evidence is for https://www.amnesty.org/en.");
  // The same host and path need no line: case, a root dot, the scheme, a query and a fragment do not count.
  for (const typed of ["https://www.webmd.com", "www.webmd.com/", "WWW.WebMD.com.", "http://www.webmd.com/", "https://www.webmd.com/?q=1#top"]) {
    assert.equal(knownEvidenceTarget(typed, webmd), null, typed);
  }
  assert.equal(knownEvidenceTarget("news.ycombinator.com", "https://news.ycombinator.com/"), null);
  // A privacy-reduced path can never be shown to match, so it names itself in reader form.
  assert.equal(knownEvidenceTarget("www.canada.ca", "https://www.canada.ca/{seg}"), "This evidence is for https://www.canada.ca/….");
  assert.equal(knownEvidenceTarget("https://www.canada.ca/{seg}", "https://www.canada.ca/{seg}"), "This evidence is for https://www.canada.ca/….");
});

test("a typed host matches its corpus site by suffix, as before", () => {
  const sites = [site(), site({ domain: "ycombinator.com", requestedUrl: "https://news.ycombinator.com/" })];
  assert.equal(matchingKnownSite("webmd.com", sites)?.domain, "webmd.com");
  assert.equal(matchingKnownSite("blog.webmd.com/path?q=1", sites)?.domain, "webmd.com");
  assert.equal(matchingKnownSite("https://WWW.WEBMD.COM./x", sites)?.domain, "webmd.com");
  assert.equal(matchingKnownSite("news.ycombinator.com", sites)?.domain, "ycombinator.com");
  for (const value of ["", "   ", "notwebmd.com", "webmd.com.evil.example", "ftp://webmd.com", "webmd"]) {
    assert.equal(matchingKnownSite(value, sites), null, value);
  }
});

test("the note names the report's kind by the Run control's label, then its headline verbatim", () => {
  assert.equal(
    knownEvidenceReport(site()),
    "Run: Blocker. Lead finding: webmd.com loaded 41 fewer third-party requests with Shields on."
  );
  for (const mode of RUN_MODES) {
    assert.equal(knownEvidenceReport(site({ runMode: mode, headline: "A headline." })), `Run: ${RUN_MODE_LABELS[mode]}. Lead finding: A headline.`);
  }
  assert.equal(knownEvidenceReport(site({ runMode: null, headline: "A headline." })), "Lead finding: A headline.");
});

test("the site states what becomes of a live rescan one way", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  assert.ok(source("app/sites/[domain]/page.tsx").includes("{LIVE_RESCAN_HISTORY_CLAUSE}."), "expected the site page to render the shared clause");
  // No other source restates it.
  const restated = ["app/sites/[domain]/page.tsx", "app/_components/scan-controls.tsx", "lib/known-site-evidence.ts"].filter((file) =>
    source(file).includes("standalone share report")
  );
  assert.deepEqual(restated, []);
});

test("the form wires the note, the one submit button and the arrival as the copy module decides", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  // Fail with a sentence, never the file: a failing match carrying a whole
  // source file has stalled the test runner's parent.
  const holds = (text: string, pattern: RegExp, expectation: string) => assert.ok(pattern.test(text), `expected ${expectation}`);
  const controls = source("app/_components/scan-controls.tsx");
  assert.equal(controls.match(/type="submit"/g)?.length, 1, "expected exactly one submit control: it carries every scan gate");
  holds(controls, /scanAgainArrival: isScanAgainArrival\(prefilledUrl, form\.url\),\s*scanBusy: loading \|\| activeScanJob/, "the arrival and a busy scan both decide whether the report leads");
  holds(controls, /className=\{`\$\{leadsWithReport \? "secondary-button" : "primary-button"\}\$\{loading \? " is-loading" : ""\}`\}/, "the submit button steps down only while the report leads");
  holds(controls, /disabled=\{loading \|\| scanBlocked \|\| activeScanJob\}\s*aria-describedby=\{knownSite \? "known-evidence-difference" : undefined\}/, "the one submit button keeps its gates and is described by the difference line");
  holds(controls, /\{scanSubmitLabel\(\{ comparison, leadsWithReport \}\)\}/, "the button's label comes from the copy module");
  holds(controls, /<div className="known-evidence" role="status">/, "the note stays a status region");
  holds(controls, /className=\{leadsWithReport \? "primary-button" : "secondary-button"\}/, "the report link is primary exactly when the button is not");
  holds(controls, /Read the report from \{formatKnownEvidenceDate\(knownSite\.scannedAt\)\}/, "the report link names its date");
  const note = controls.slice(controls.indexOf('<div className="known-evidence" role="status">'), controls.indexOf('<div className="scan-examples"'));
  const order = ["Read the report from", "knownEvidenceReport(knownSite)", 'id="known-evidence-difference"'].map((marker) => note.indexOf(marker));
  assert.ok(order.every((index, position) => index !== -1 && (position === 0 || index > order[position - 1])), "expected the report link before the longer lines");
  assert.ok(!/form\.url/.test(note), "expected no typed text rendered in the live region");
  const hook = source("app/_hooks/use-scan-runtime.ts");
  holds(hook, /if \(navigation\.targetUrl\) \{\s*setForm\(\(current\) => \(\{ \.\.\.current, url: navigation\.targetUrl \?\? current\.url \}\)\);\s*setPrefilledUrl\(navigation\.targetUrl\);/, "the hook records the address a prefill put in the field");
  holds(source("app/site-behavior-app.tsx"), /prefilledUrl=\{prefilledUrl\}\s*shareReportMaxAgeDays=\{shareReportMaxAgeDays\}/, "the app hands the form the arrival and the scanner's retention");
});
