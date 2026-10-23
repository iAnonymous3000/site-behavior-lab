import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { HomepageKnownSite } from "./homepage-discovery";
import {
  connectedEarlierResult,
  connectedInspection,
  inspectionFormSentences,
  isScanAgainArrival,
  knownEvidenceDifference,
  knownEvidenceReport,
  knownEvidenceTarget,
  leadsWithExistingReport,
  matchingKnownSite,
  newCheckSentence,
  scanSubmitLabel,
  shareRetentionClause,
  showsModeLinkShareLine
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

test("a mode link's share line is the difference line's first sentence, with the scanner's retention", () => {
  assert.equal(
    newCheckSentence({ comparison: true, maxAgeDays: 7 }),
    "A new check runs two visits in the selected mode and makes a separate share report, kept for up to about 7 days."
  );
  assert.equal(
    newCheckSentence({ comparison: true, maxAgeDays: null }),
    "A new check runs two visits in the selected mode and makes a separate share report, kept for a limited time."
  );
  // One sentence, the known-site line's own first sentence: the note keeps
  // its history clause, and the two can never word the share differently.
  for (const comparison of [false, true]) {
    for (const maxAgeDays of [7, 1, null]) {
      const sentence = newCheckSentence({ comparison, maxAgeDays });
      assert.ok(knownEvidenceDifference({ comparison, maxAgeDays }).startsWith(`${sentence} It is not added to this site's history: `));
      assert.equal(sentence.split(/(?<=\.) /).length, 1);
      assert.doesNotMatch(sentence, /history|standalone/);
    }
  }
});

test("the share line shows after a mode link only while a comparison is selected, and never beside the note", () => {
  const shows = (input: Partial<Parameters<typeof showsModeLinkShareLine>[0]>) =>
    showsModeLinkShareLine({ prefilledMode: "shields", scanAgainArrival: true, comparison: true, siteMatched: false, ...input });
  assert.equal(shows({}), true);
  assert.equal(shows({ prefilledMode: null }), false, "a link with only a target asked for no comparison");
  assert.equal(shows({ scanAgainArrival: false }), false, "the first edit ends the arrival");
  assert.equal(shows({ comparison: false }), false, "pending health, or the Single fallback, would count two visits beside Single");
  assert.equal(shows({ siteMatched: true }), false, "a corpus site's note already states the share and the history");
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

test("a follow-up's earlier result stays connected only while the field and the comparison are the link's", () => {
  const prefilledUrl = "https://www.webmd.com/";
  const earlier = "20261022-0123456789abcdef0123456789abcdef";
  const none = { gpc: false, shields: false, consent: false };
  const connected = (overrides: Partial<Parameters<typeof connectedEarlierResult>[0]> = {}) =>
    connectedEarlierResult({
      prefilledUrl,
      prefilledMode: "shields",
      prefilledFrom: earlier,
      fieldValue: prefilledUrl,
      requested: { ...none, shields: true },
      ...overrides
    });
  // The arrival as the link set it: the address, and its comparison alone.
  assert.equal(connected(), earlier);
  for (const mode of ["gpc", "shields", "consent"] as const) {
    assert.equal(connected({ prefilledMode: mode, requested: { ...none, [mode]: true } }), earlier, mode);
  }
  // Any edit to the address ends it, however small.
  for (const fieldValue of ["https://www.webmd.com/x", "https://www.webmd.com", "https://webmd.com/", ` ${prefilledUrl}`, `${prefilledUrl} `, ""]) {
    assert.equal(connected({ fieldValue }), null, JSON.stringify(fieldValue));
  }
  // So does any change of mode: Single (also what shows while health is
  // pending, or after the Single fallback), another comparison, or two,
  // whichever of them is listed first.
  for (const requested of [
    none,
    { ...none, gpc: true },
    { ...none, consent: true },
    { ...none, shields: true, gpc: true },
    { ...none, shields: true, consent: true }
  ]) {
    assert.equal(connected({ requested }), null, JSON.stringify(requested));
  }
  // The rule is derived, as the arrival's is: putting the address and the
  // comparison back as the link set them restores it, since the scan would
  // again be the very comparison the link opened.
  assert.equal(connected({ fieldValue: prefilledUrl, requested: { ...none, shields: true } }), earlier);
  // A link that named no earlier result, and typing, connect nothing.
  assert.equal(connected({ prefilledFrom: null }), null);
  assert.equal(connected({ prefilledUrl: null, prefilledMode: null, prefilledFrom: null }), null);
  assert.equal(connected({ prefilledUrl: null }), null);
});

test("an inspection link's arrival holds only while the field is the link's page and Single is selected", () => {
  const prefilledUrl = "https://www.webmd.com/";
  const address = "https://pixel.example.net/{seg}";
  const earlier = "20261022-0123456789abcdef0123456789abcdef";
  const connected = (overrides: Partial<Parameters<typeof connectedInspection>[0]> = {}) =>
    connectedInspection({
      prefilledUrl,
      prefilledInspect: address,
      prefilledFrom: earlier,
      fieldValue: prefilledUrl,
      comparison: false,
      ...overrides
    });
  assert.deepEqual(connected(), { address, from: earlier });
  assert.deepEqual(connected({ prefilledFrom: null }), { address, from: null }, "a link without a share still inspects");
  // Any edit to the address ends it, and so does any comparison.
  for (const fieldValue of ["https://www.webmd.com/x", "https://webmd.com/", ` ${prefilledUrl}`, ""]) {
    assert.equal(connected({ fieldValue }), null, JSON.stringify(fieldValue));
  }
  assert.equal(connected({ comparison: true }), null);
  // Putting both back restores it; a link that asked for none, and typing, inspect nothing.
  assert.deepEqual(connected({ fieldValue: prefilledUrl, comparison: false }), { address, from: earlier });
  assert.equal(connected({ prefilledInspect: null }), null);
  assert.equal(connected({ prefilledUrl: null }), null);
});

test("the form names the inspection in the approved words, and its button reads Inspect", () => {
  const sentences = inspectionFormSentences({ address: "https://pixel.example.net/{seg}", page: "https://www.webmd.com/" });
  assert.equal(sentences.inspecting, "Inspecting https://pixel.example.net/….");
  assert.equal(
    sentences.visit,
    "A new visit to https://www.webmd.com/ will record which scripts were running when each request to this address was made. The details show here only and are not saved."
  );
  const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
  for (const sentence of `${sentences.inspecting} ${sentences.visit}`.split(/(?<=\.)\s+/)) {
    assert.ok(sentence.split(/\s+/).length <= 30, sentence);
    assert.equal(dashes.test(sentence), false, sentence);
  }
  // A generalized host label reads as the report shows it.
  assert.equal(
    inspectionFormSentences({ address: "https://{label}.example.net/api", page: "https://www.webmd.com/" }).inspecting,
    "Inspecting https://*.example.net/api."
  );
  for (const leadsWithReport of [false, true]) {
    assert.equal(scanSubmitLabel({ comparison: false, leadsWithReport, inspecting: true }), "Inspect");
  }
  assert.equal(scanSubmitLabel({ comparison: false, leadsWithReport: false, inspecting: false }), "Scan");
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
  holds(
    controls,
    /disabled=\{loading \|\| scanBlocked \|\| activeScanJob\}\s*aria-describedby=\{\s*\[inspection \? "inspection-arrival" : null, knownSite \? "known-evidence-difference" : modeLinkShareLine \? "mode-link-share-line" : null\]\s*\.filter\(Boolean\)\s*\.join\(" "\) \|\| undefined\s*\}/,
    "the one submit button keeps its gates and is described by an inspection's arrival line, then the difference line or a mode link's share line"
  );
  holds(
    controls,
    /const modeLinkShareLine = showsModeLinkShareLine\(\{\s*prefilledMode,\s*scanAgainArrival: isScanAgainArrival\(prefilledUrl, form\.url\),\s*comparison,\s*siteMatched: knownSite !== null\s*\}\);/,
    "the share line follows the arrival, the selected comparison and the known site"
  );
  holds(
    controls,
    /\{modeLinkShareLine && \(\s*<p className="mode-link-share-line" id="mode-link-share-line">\s*\{newCheckSentence\(\{ comparison, maxAgeDays: shareReportMaxAgeDays \}\)\}\s*<\/p>\s*\)\}\s*<div className="scan-examples"/,
    "the share line renders the shared sentence with the scanner's retention, before the example sites"
  );
  holds(controls, /\{scanSubmitLabel\(\{ comparison, leadsWithReport, inspecting: inspection !== null \}\)\}/, "the button's label comes from the copy module");
  // An inspection arrival's line comes from the copy module, for the address
  // the hook's arrival rule hands over and the page in the field.
  holds(
    controls,
    /const inspection = inspectedAddress \? inspectionFormSentences\(\{ address: inspectedAddress, page: form\.url \}\) : null;/,
    "the arrival line to be built by the copy module from the handed-over address"
  );
  holds(
    controls,
    /\{inspection && \(\s*<div className="inspection-arrival" role="status">\s*<p id="inspection-arrival">\{`\$\{inspection\.inspecting\} \$\{inspection\.visit\}`\}<\/p>\s*<\/div>\s*\)\}/,
    "the arrival line to render in a status region the button names"
  );
  holds(controls, /<div className="known-evidence" role="status">/, "the note stays a status region");
  holds(controls, /className=\{leadsWithReport \? "primary-button" : "secondary-button"\}/, "the report link is primary exactly when the button is not");
  holds(controls, /Read the report from \{formatKnownEvidenceDate\(knownSite\.scannedAt\)\}/, "the report link names its date");
  const note = controls.slice(controls.indexOf('<div className="known-evidence" role="status">'), controls.indexOf('<div className="scan-examples"'));
  const order = ["Read the report from", "knownEvidenceReport(knownSite)", 'id="known-evidence-difference"'].map((marker) => note.indexOf(marker));
  assert.ok(order.every((index, position) => index !== -1 && (position === 0 || index > order[position - 1])), "expected the report link before the longer lines");
  assert.ok(!/form\.url/.test(note), "expected no typed text rendered in the live region");
  const hook = source("app/_hooks/use-scan-runtime.ts");
  holds(
    hook,
    /if \(navigation\.targetUrl\) \{(?:\s*\/\/[^\n]*)*\s*const inspect = navigation\.inspect;\s*setForm\(\(current\) => \(\{\s*\.\.\.current,\s*url: navigation\.targetUrl \?\? current\.url,\s*\.\.\.\(inspect === null \? \{\} : \{ compareGpc: false, compareShields: false, compareConsent: false \}\)\s*\}\)\);\s*setPrefilledUrl\(navigation\.targetUrl\);/,
    "the hook records the address a prefill put in the field, and an inspection link selects Single"
  );
  // The mode or inspection a link asked for is kept for the arrival, the
  // mode held, beside the target the form accepted, and so is the earlier
  // result it named; a target-only link clears all four.
  holds(
    hook,
    /setPrefilledUrl\(navigation\.targetUrl\);(?:\s*\/\/[^\n]*)*\s*setPrefilledMode\(navigation\.mode\);\s*setHeldMode\(navigation\.mode\);\s*setPrefilledInspect\(inspect\);\s*setPrefilledFrom\(navigation\.from\);\s*\}/,
    "the hook keeps and holds the mode a prefill asked for, and keeps the inspection and the earlier result it named, inside the accepted-target branch"
  );
  // The inspection holds through the tested rule, from the field and the
  // comparisons the request would ask for; the request names it only then,
  // and a durable admission refuses it before a claim spends the challenge.
  holds(
    hook,
    /const inspectionArrival = connectedInspection\(\{\s*prefilledUrl,\s*prefilledInspect,\s*prefilledFrom,\s*fieldValue: form\.url,\s*comparison:\s*\(policy\.gpcComparisonEnabled && form\.compareGpc\) \|\|\s*\(policy\.shieldsComparisonEnabled && form\.compareShields\) \|\|\s*\(policy\.consentComparisonEnabled && form\.compareConsent\)\s*\}\);/,
    "the hook to decide the inspection arrival through the tested rule"
  );
  holds(
    hook,
    /if \(inspectionArrival && policy\.durableAdmissionEnabled\) \{\s*setError\(INSPECTION_DURABLE_REFUSAL\);\s*return;\s*\}\s*const operation = operationOwnerRef\.current\.claim\("submit"\);/,
    "a durable admission to refuse an inspection before the submit is claimed"
  );
  holds(hook, /\.\.\.\(inspectionArrival \? \{ inspect: inspectionArrival\.address \} : \{\}\)\s*\}\);/, "the request to name the inspection only while its arrival holds");
  assert.equal(hook.match(/inspect: inspectionArrival\.address/g)?.length, 1, "expected one request to carry an inspection");
  holds(source("app/site-behavior-app.tsx"), /prefilledMode=\{prefilledMode\}\s*inspectedAddress=\{inspectionArrival\?\.address \?\? null\}/, "the app hands the form the inspection the arrival holds");
  // A scan records its connection once it is claimed, through the tested
  // rule, from the field and the comparisons its request asks for; the
  // request reads the same flags, and the form's state never holds the id.
  holds(
    hook,
    /const operation = operationOwnerRef\.current\.claim\("submit"\);\s*if \(operation === null\) return;(?:\s*\/\/[^\n]*)*\s*startedScanEarlierResultRef\.current = connectedEarlierResult\(\{\s*prefilledUrl,\s*prefilledMode,\s*prefilledFrom,\s*fieldValue: form\.url,\s*requested: \{\s*gpc: policy\.gpcComparisonEnabled && form\.compareGpc,\s*shields: policy\.shieldsComparisonEnabled && form\.compareShields,\s*consent: policy\.consentComparisonEnabled && form\.compareConsent\s*\}\s*\}\);/,
    "the hook records a claimed scan's connection from the field and the comparisons it requests"
  );
  assert.equal(hook.match(/startedScanEarlierResultRef\.current = /g)?.length, 1, "expected only a claimed scan to record a connection");
  holds(
    source("lib/scan-client-orchestration.ts"),
    /compareGpc: options\.gpcComparisonEnabled && options\.form\.compareGpc,\s*compareShields: options\.shieldsComparisonEnabled && options\.form\.compareShields,\s*compareConsent: options\.consentComparisonEnabled && options\.form\.compareConsent,/,
    "the scan request to ask for exactly the comparisons the connection reads"
  );
  holds(
    controls,
    /export type ScanFormState = \{\s*url: string;\s*device: ScanDevice;\s*gpcEnabled: boolean;\s*compareGpc: boolean;\s*compareShields: boolean;\s*compareConsent: boolean;\s*accessKey: string;\s*\};/,
    "the form's state to carry no earlier result"
  );
  // The result a connected scan shows carries the id, and only while it is shown.
  holds(hook, /setLiveScan\(\{ result: next, earlierResultId: startedScanEarlierResultRef\.current \}\);/, "a live result to carry its scan's connection");
  holds(
    hook,
    /earlierResultId: liveScan !== null && loaded === liveScan\.result \? liveScan\.earlierResultId : null,/,
    "the earlier result to reach the page only while the connected scan's own result is shown"
  );
  holds(source("app/site-behavior-app.tsx"), /<LazyReportRenderer [^>]*earlierResultId=\{earlierResultId\}/, "the app hands its result's connection to the renderer");
  // Held until health answers, through the one decision the unit tests pin,
  // then the form's comparison flags, and nothing else.
  const held = hook.slice(hook.indexOf("if (heldMode === null) return;"), hook.indexOf("function resetTurnstileAfterLifecycleOperation"));
  holds(held, /heldRunModeOutcome\(\{\s*requested: heldMode,\s*awaitingScannerHealth: policy\.awaitingScannerHealth,/, "the held mode waits for the scanner's health");
  holds(held, /if \(outcome === "hold"\) return;\s*setHeldMode\(null\);/, "the held mode is applied once");
  assert.ok(!/runScan|handleSubmit|requestSubmit|submitRuntimeScan|\.click\(/.test(held), "expected applying a held mode never to submit");
  holds(source("app/site-behavior-app.tsx"), /prefilledUrl=\{prefilledUrl\}\s*shareReportMaxAgeDays=\{shareReportMaxAgeDays\}/, "the app hands the form the arrival and the scanner's retention");
  holds(source("app/site-behavior-app.tsx"), /shareReportMaxAgeDays=\{shareReportMaxAgeDays\}\s*prefilledMode=\{prefilledMode\}/, "the app hands the form the mode the arrival asked for");
});
