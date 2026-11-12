import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { REPORT_CLAIM_REQUIREMENTS } from "./report-facts";

type Helpers = {
  CANARY_ORIGIN: string;
  stableCompareJson(value: unknown): string;
  requireCanaryOrigin(value?: string): string;
  requireAccessToken(value: unknown): string;
  requireCommitSha(value: unknown): string;
  assertHealthGate(value: unknown, sha: string): unknown;
  assertPanel(value: unknown): Panel;
  assertPanelCatalogMembership(panel: Panel, catalogs: Record<string, unknown>): void;
  buildReceipt(input: Record<string, unknown>): Receipt;
  extractCapturedRun(report: unknown, input: Record<string, unknown>): Record<string, unknown>;
  compareReceipts(baseline: Receipt, candidate: Receipt, panel: Panel, digest: string): Comparison;
  panelDigest(panel: Panel): string;
  readCommittedPanels(files: unknown): readonly CommittedPanel[];
  assertCurrentPanelCommitted(current: { panel: Panel; digest: string }, committed: readonly CommittedPanel[]): void;
  selectComparisonPanel(input: { replay: boolean; baseline: unknown; candidate: unknown; current: { panel: Panel; digest: string }; committed: readonly CommittedPanel[] }): Selection;
  replayNotice(selection: Selection, current: { panel: Panel; digest: string }): string;
  PANEL_VERSIONS: readonly number[];
  COMMITTED_PANEL_DIRECTORY: string;
  METRICS: readonly string[];
  METRIC_EVIDENCE_FAMILIES: Readonly<Record<string, string>>;
  METRIC_FEEDING_FAMILIES: readonly string[];
  COMPARISON_RULE: string;
};
type Noted = { caseId: string; signature: string; baselineRuns: number; baselineTotal: number; candidateRuns: number; candidateTotal: number };
type Outcome = "pass" | "fail" | "inconclusive";
type Row = {
  pass: boolean;
  outcome: Outcome;
  caseId: string;
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  allowed: number;
  baselineValues: number[];
  candidateValues: number[];
  baselineSpread: number;
  candidateSpread: number;
  separation: number;
  separated: boolean;
};
type Comparison = {
  pass: boolean;
  outcome: Outcome;
  rule: string;
  baselineBuild: string;
  candidateBuild: string;
  results: Row[];
  excluded: Array<{ caseId: string; metric: string; family: string }>;
  noted: Noted[];
};
type Loss = { family: string; kind: string; detail?: string; count: number; phaseId: number };
type Panel = { panelVersion: number; panelId: string; repetitions: number; conditions: object; metricTolerances: Record<string, { absolute: number; relative: number }>; cases: Array<{ id: string; catalog: string; domain: string; url: string }> };
type Receipt = Record<string, any>;
type CommittedPanel = { panel: Panel; digest: string; file: string };
type Selection = { replay: boolean; panel: Panel; digest: string; file?: string; current?: boolean };
type Versions = { playwright: string | null; adblock: string; tldts: string };

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Helpers>;
const helpers = nativeImport(pathToFileURL(path.join(process.cwd(), "scripts", "toolchain-canary-lib.mjs")).href);
const CURRENT_PANEL_FILE = path.join("scripts", "fixtures", "toolchain-canary-panel.json");
const COMMITTED_PANELS = path.join("scripts", "fixtures", "toolchain-canary-panels");
const PANEL_V1_FILE = path.join(COMMITTED_PANELS, "monthly-toolchain-canary-v1.json");
const currentPanel = JSON.parse(readFileSync(path.join(process.cwd(), CURRENT_PANEL_FILE), "utf8")) as Panel;
// The receipts constructed below, and the committed ones, are on panel
// version 1, read from its committed copy, so the rule tests keep their case
// names when the current panel file changes.
const panel = JSON.parse(readFileSync(path.join(process.cwd(), PANEL_V1_FILE), "utf8")) as Panel;

function committedPanelFiles() {
  return readdirSync(path.join(process.cwd(), COMMITTED_PANELS)).map((name) => ({ name, text: readFileSync(path.join(process.cwd(), COMMITTED_PANELS, name), "utf8") }));
}

function health(sha: string) {
  return {
    ok: true, status: "ok", warnings: [], deployment: sha, authenticated: true, openAccess: false, turnstile: false,
    scansAvailable: true, storage: "r2", capabilities: { singleScan: true, savedReports: true },
    checks: {
      scanAccess: "configured", chromiumSandbox: "enabled", adblock: { active: true }, scannerEgressRegion: "configured",
      publicR2Reports: { status: "enabled" }, reportStore: { kind: "r2", configuredPath: true },
      durableJobs: { requested: true, enabled: true, readiness: "ready", coordinatorOrigin: "https://scan-staging.sitebehavior.org", faultInjection: { environment: "staging", enabled: true, wholeOriginAccessGate: true } }
    }
  };
}

function run(
  caseId: string,
  repetition: number,
  sequence: number,
  build: string,
  browser: string,
  count = 10,
  versions: Versions = { playwright: "1.61.0", adblock: "0.13.0", tldts: "7.4.3" }
) {
  const engineVersion = `adblock-rust-${versions.adblock}`;
  const playwrightComponent = versions.playwright ? `-playwright-${versions.playwright}` : "";
  return {
    caseId, repetition, sequence,
    reportId: `20260719-${sequence.toString(16).padStart(32, "0")}`,
    reportJsonPath: `/api/reports/20260719-${sequence.toString(16).padStart(32, "0")}`,
    reportWireSha256: createHash("sha256").update(`the wire of scan ${sequence}`).digest("hex"), runId: `${caseId}-${repetition}`, startedAt: "2026-07-19T00:00:00.000Z",
    subject: { requested: { origin: `https://${caseId}.example`, registrableDomain: `${caseId}.example`, routeShape: "/" }, observed: { origin: `https://${caseId}.example`, registrableDomain: `${caseId}.example`, routeShape: "/" } },
    conditions: { gpc: true, shields: "classification", consent: "observe", device: { kind: "desktop", viewport: { width: 1440, height: 980, isMobile: false } }, probes: { keystroke: true, policyVisit: true }, locale: "en-US", language: "en-US", timezone: "UTC", egress: { label: "cloudflare-containers", region: "us-west" }, browser: { name: "chromium", version: browser }, headless: true, automation: "playwright-chromium" },
    provenance: {
      observer: "node-playwright",
      acquisition: "public-api",
      buildCommit: build,
      methodologyVersion: `shields-request-context-v2-${engineVersion}-request-method-v1${playwrightComponent}+phase-kernel-v2`,
      detectorRegistry: { version: "1", digest: "e".repeat(64) }
    },
    toolchain: {
      trackerCatalog: { source: "site-behavior-lab-curated", version: "2026-07-01", entries: 1, digest: "f".repeat(64) },
      adblock: {
        source: "brave-default-enabled",
        lists: 31,
        fetchedAt: "2026-07-13T00:00:00.000Z",
        manifestDigest: "c".repeat(64),
        engineVersion
      },
      normalizationVersion: `redaction-v2+tldts@${versions.tldts}+node-evidence-policy-v1`
    },
    qualityFacts: { status: 200, botWallTitleMatched: false, navigationSettled: true, budgetsExhausted: [], captureLoss: [] },
    quality: { run: { outcome: "complete", reasons: [] }, byFamily: Object.fromEntries(["requests", "cookies", "storage", "fingerprinting", "detector-output", "consent-verification"].map((key) => [key, { outcome: "complete", reasons: [] }])) },
    counts: Object.fromEntries(["totalRequests", "thirdPartyRequests", "knownTrackerRequests", "thirdPartyDomains", "cookies", "thirdPartyCookies", "storageEntries", "fingerprintEvents", "shieldsBlockedRequests"].map((key) => [key, count]))
  };
}

async function receipt(
  order: "forward" | "reverse",
  build: string,
  browser: string,
  count = 10,
  versions: Versions = { playwright: "1.61.0", adblock: "0.13.0", tldts: "7.4.3" },
  onPanel: Panel = panel
) {
  const h = await helpers;
  const ordered = order === "forward" ? onPanel.cases : [...onPanel.cases].reverse();
  const runs = [];
  let sequence = 0;
  for (const entry of ordered) {
    for (let repetition = 1; repetition <= onPanel.repetitions; repetition += 1) {
      runs.push(run(entry.id, repetition, ++sequence, build, browser, count, versions));
    }
  }
  const digest = createHash("sha256").update(h.stableCompareJson(onPanel)).digest("hex");
  return h.buildReceipt({ createdAt: "2026-07-19T00:00:00.000Z", expectedBuild: build, order, panel: onPanel, panelDigest: digest, runs });
}

function capturedReport(build: string, versions: Versions) {
  const captured = run(panel.cases[0].id, 1, 1, build, "149.0", 10, versions);
  captured.subject.requested.origin = new URL(panel.cases[0].url).origin;
  return {
    reportId: captured.reportId,
    report: {
      schemaVersion: 2,
      schemaRevision: 2,
      reportType: "single",
      share: {
        id: captured.reportId,
        path: `/reports/${captured.reportId}`,
        jsonPath: `/api/reports/${captured.reportId}`
      },
      run: {
        runId: captured.runId,
        startedAt: captured.startedAt,
        subject: captured.subject,
        conditions: captured.conditions,
        provenance: captured.provenance,
        toolchain: captured.toolchain,
        qualityFacts: captured.qualityFacts,
        quality: captured.quality,
        summary: { counts: captured.counts }
      }
    }
  };
}

test("staging origin, token, SHA, and whole-origin health gates fail closed", async () => {
  const h = await helpers;
  const sha = "a".repeat(40);
  assert.equal(h.requireCanaryOrigin(), h.CANARY_ORIGIN);
  assert.throws(() => h.requireCanaryOrigin("https://scan.sitebehavior.org"), /exactly/);
  assert.throws(() => h.requireCanaryOrigin(`${h.CANARY_ORIGIN}/api/health`), /exactly/);
  assert.throws(() => h.requireAccessToken("short"), /at least 32/);
  assert.equal(h.requireAccessToken("x".repeat(32)), "x".repeat(32));
  assert.equal(h.requireCommitSha(sha), sha);
  h.assertHealthGate(health(sha), sha);
  const unsafe = structuredClone(health(sha));
  unsafe.checks.durableJobs.faultInjection.wholeOriginAccessGate = false;
  assert.throws(() => h.assertHealthGate(unsafe, sha), /whole-origin/);
});

test("fixed five-site panel is pinned to the existing catalogs", async () => {
  const h = await helpers;
  h.assertPanel(currentPanel);
  const catalogs = {
    "public/featured-sites.json": JSON.parse(readFileSync(path.join(process.cwd(), "public", "featured-sites.json"), "utf8")),
    "public/corpus-seed-sites.json": JSON.parse(readFileSync(path.join(process.cwd(), "public", "corpus-seed-sites.json"), "utf8"))
  };
  h.assertPanelCatalogMembership(currentPanel, catalogs);
  const changed = structuredClone(currentPanel);
  changed.cases[0].url = "https://not-in-catalog.example/";
  assert.throws(() => h.assertPanelCatalogMembership(changed, catalogs), /not pinned exactly/);
});

test("the panel check accepts versions 1 and 2 and no other, and holds version 2 to every other rule", async () => {
  const h = await helpers;
  assert.deepEqual([...h.PANEL_VERSIONS], [1, 2]);
  const next = { ...structuredClone(panel), panelVersion: 2, panelId: "monthly-toolchain-canary-v2" };
  assert.equal(h.assertPanel(next), next);
  for (const panelVersion of [0, 3, "2", null, undefined]) {
    assert.throws(() => h.assertPanel({ ...structuredClone(panel), panelVersion }), { message: "Invalid toolchain canary panel." }, String(panelVersion));
  }
  // Version 2 answers to the checks version 1 answers to.
  const refusals: Array<[string, (value: any) => void, RegExp]> = [
    ["four cases", (value) => { value.cases.pop(); }, /exactly five sites/],
    ["six cases", (value) => { value.cases.push({ ...value.cases[0], id: "sixth" }); }, /exactly five sites/],
    ["a repeated case id", (value) => { value.cases[1].id = value.cases[0].id; }, /unique slugs/],
    ["a case outside the two catalogs", (value) => { value.cases[0].catalog = "public/other-sites.json"; }, /unapproved catalog/],
    ["a case URL with a query", (value) => { value.cases[0].url = "https://www.wikipedia.org/?x=1"; }, /without private components/],
    ["even repetitions", (value) => { value.repetitions = 4; }, /odd integer from 3 through 9/],
    ["eleven repetitions", (value) => { value.repetitions = 11; }, /odd integer from 3 through 9/],
    ["another condition vector", (value) => { value.conditions.gpcEnabled = false; }, /ordinary desktop single-scan profile/],
    ["a missing tolerance", (value) => { delete value.metricTolerances.cookies; }, /exactly the canary metric tolerances/],
    ["a relative tolerance over 1", (value) => { value.metricTolerances.cookies.relative = 1.5; }, /Invalid tolerance for cookies/]
  ];
  for (const [label, edit, message] of refusals) {
    const value = structuredClone(next);
    edit(value);
    assert.throws(() => h.assertPanel(value), message, label);
  }
});

test("forward baseline capture accepts pre-provenance reports while reverse candidate capture refuses them", async () => {
  const h = await helpers;
  const build = "a".repeat(40);
  const { reportId, report } = capturedReport(
    build,
    { playwright: null, adblock: "0.13.0", tldts: "7.4.3" }
  );
  const input = {
    reportId,
    expectedBuild: build,
    panelCase: panel.cases[0],
    sequence: 1,
    repetition: 1,
    reportWireSha256: "d".repeat(64)
  };

  assert.doesNotThrow(() => h.extractCapturedRun(report, { ...input, order: "forward" }));
  assert.throws(
    () => h.extractCapturedRun(report, { ...input, order: "reverse" }),
    /one exact Playwright version/
  );
});

test("receipt comparison permits only browser, toolchain, and build drift within explicit medians", async () => {
  const h = await helpers;
  const digest = createHash("sha256").update(h.stableCompareJson(panel)).digest("hex");
  const baselineVersions: Versions = { playwright: null, adblock: "0.13.0", tldts: "7.4.3" };
  const candidateVersions: Versions = { playwright: "1.61.1", adblock: "0.13.2", tldts: "7.4.9" };
  const baseline = await receipt("forward", "a".repeat(40), "149.0", 10, baselineVersions);
  const candidate = await receipt("reverse", "b".repeat(40), "150.0", 11, candidateVersions);
  assert.equal(h.compareReceipts(baseline, candidate, panel, digest).pass, true);

  const missingCandidateVersion = await receipt(
    "reverse",
    "b".repeat(40),
    "150.0",
    11,
    { ...candidateVersions, playwright: null }
  );
  assert.throws(
    () => h.compareReceipts(baseline, missingCandidateVersion, panel, digest),
    /one exact Playwright version/
  );

  const duplicateCandidateVersion = structuredClone(candidate);
  for (const entry of duplicateCandidateVersion.runs) {
    entry.provenance.methodologyVersion += "-playwright-1.61.2";
  }
  assert.throws(
    () => h.compareReceipts(baseline, duplicateCandidateVersion, panel, digest),
    /one exact Playwright version/
  );

  const wrongRegion = structuredClone(candidate);
  wrongRegion.runs[0].conditions.egress.region = "eu";
  assert.throws(() => h.compareReceipts(baseline, wrongRegion, panel, digest), /mixes run conditions|Egress region/);

  const mixedSubject = structuredClone(candidate);
  mixedSubject.runs[1].subject.observed.routeShape = "/redirected";
  assert.throws(() => h.compareReceipts(baseline, mixedSubject, panel, digest), /mixes requested or observed subjects/);

  const outsideTolerance = await receipt("reverse", "b".repeat(40), "150.0", 100, candidateVersions);
  const result = h.compareReceipts(baseline, outsideTolerance, panel, digest);
  assert.equal(result.pass, false);
  assert.equal(result.results.some((entry) => !entry.pass), true);

  const catalogDrift = structuredClone(candidate);
  for (const entry of catalogDrift.runs) entry.toolchain.trackerCatalog.digest = "a".repeat(64);
  assert.throws(() => h.compareReceipts(baseline, catalogDrift, panel, digest), /outside Playwright, browser, adblock engine, tldts, and build/);

  const listDrift = structuredClone(candidate);
  for (const entry of listDrift.runs) entry.toolchain.adblock.manifestDigest = "b".repeat(64);
  assert.throws(() => h.compareReceipts(baseline, listDrift, panel, digest), /outside Playwright, browser, adblock engine, tldts, and build/);

  const unrelatedNormalizationDrift = structuredClone(candidate);
  for (const entry of unrelatedNormalizationDrift.runs) entry.toolchain.normalizationVersion += "+redaction-v3";
  assert.throws(() => h.compareReceipts(baseline, unrelatedNormalizationDrift, panel, digest), /outside Playwright, browser, adblock engine, tldts, and build/);
});

function withLoss(target: Receipt, caseId: string, loss: Loss, include: (entry: Record<string, any>) => boolean = () => true) {
  for (const entry of target.runs) {
    if (entry.caseId !== caseId || !include(entry)) continue;
    entry.qualityFacts.captureLoss.push({ ...loss, count: loss.count + entry.repetition });
    const family = entry.quality.byFamily[loss.family];
    family.outcome = "censored";
    family.reasons = [...new Set([...family.reasons, `capture-loss:${loss.kind}`])];
  }
  return target;
}

test("each canary metric is left out for exactly the evidence family the report's own claims count it from", async () => {
  const h = await helpers;
  const claimFor: Record<string, keyof typeof REPORT_CLAIM_REQUIREMENTS> = {
    totalRequests: "third-party-services",
    thirdPartyRequests: "third-party-services",
    knownTrackerRequests: "named-platforms",
    thirdPartyDomains: "third-party-services",
    cookies: "third-party-cookies",
    thirdPartyCookies: "third-party-cookies",
    storageEntries: "storage-keys",
    fingerprintEvents: "fingerprint-apis",
    shieldsBlockedRequests: "shields-blocked"
  };
  assert.deepEqual(Object.keys(h.METRIC_EVIDENCE_FAMILIES).sort(), [...h.METRICS].sort());
  for (const metric of h.METRICS) {
    assert.deepEqual(REPORT_CLAIM_REQUIREMENTS[claimFor[metric]].families, [h.METRIC_EVIDENCE_FAMILIES[metric]], metric);
  }
});

test("a capture loss every run of both builds shares leaves out only the metrics its family feeds", async () => {
  const h = await helpers;
  const digest = createHash("sha256").update(h.stableCompareJson(panel)).digest("hex");
  const baselineVersions: Versions = { playwright: null, adblock: "0.13.0", tldts: "7.4.3" };
  const candidateVersions: Versions = { playwright: "1.61.1", adblock: "0.13.2", tldts: "7.4.9" };
  const fresh = async () => ({
    baseline: await receipt("forward", "a".repeat(40), "149.0", 10, baselineVersions),
    candidate: await receipt("reverse", "b".repeat(40), "150.0", 11, candidateVersions)
  });
  const fingerprintLoss: Loss = { family: "fingerprinting", kind: "dropped", detail: "fingerprint-observer", count: 1, phaseId: 0 };
  const keystrokeLoss: Loss = { family: "detector-output", kind: "truncated", detail: "keystroke-probe-capture", count: 1, phaseId: 1 };
  const heavy = panel.cases[4].id;
  const typed = panel.cases[1].id;

  // Shared by all six runs (counts differ): only that site's fingerprintEvents
  // is left out, so a far-off candidate median there cannot fail the gate.
  {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, heavy, fingerprintLoss);
    withLoss(candidate, heavy, fingerprintLoss);
    for (const entry of candidate.runs) if (entry.caseId === heavy) entry.counts.fingerprintEvents = 500;
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.pass, true);
    assert.deepEqual(result.excluded, [{ caseId: heavy, metric: "fingerprintEvents", family: "fingerprinting" }]);
    assert.deepEqual(result.noted, []);
    assert.equal(result.results.length, panel.cases.length * h.METRICS.length - 1);
    assert.equal(result.results.some((row) => row.caseId === heavy && row.metric === "fingerprintEvents"), false);
  }
  // A shared detector-output loss feeds no canary metric, so nothing is left
  // out; it is noted with both counts, recorded and not compared.
  {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, typed, keystrokeLoss);
    withLoss(candidate, typed, keystrokeLoss);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.pass, true);
    assert.deepEqual(result.excluded, []);
    assert.deepEqual(result.noted, [
      { caseId: typed, signature: "detector-output/truncated/keystroke-probe-capture", baselineRuns: 3, baselineTotal: 3, candidateRuns: 3, candidateTotal: 3 }
    ]);
    assert.equal(result.results.length, panel.cases.length * h.METRICS.length);
  }
  // A loss only one build records is itself a difference between the builds.
  {
    const { baseline, candidate } = await fresh();
    withLoss(candidate, heavy, fingerprintLoss);
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /Capture loss differs between runs of/);
  }
  // So is a loss that only some runs record.
  {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, heavy, fingerprintLoss, (entry) => entry.repetition !== 2);
    withLoss(candidate, heavy, fingerprintLoss);
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /Capture loss differs between runs of/);
  }
  // And a loss whose detail changes between builds.
  {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, heavy, fingerprintLoss);
    withLoss(candidate, heavy, { ...fingerprintLoss, detail: "fingerprint-heuristics" });
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /Capture loss differs between runs of/);
  }
  // A metric left out on every site would never be compared.
  {
    const { baseline, candidate } = await fresh();
    for (const entry of panel.cases) {
      withLoss(baseline, entry.id, fingerprintLoss);
      withLoss(candidate, entry.id, fingerprintLoss);
    }
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /fingerprintEvents is left out on every panel site/);
  }
  // A family censored by anything but its own recorded loss still refuses the run.
  {
    const { baseline, candidate } = await fresh();
    baseline.runs[0].quality.byFamily.fingerprinting = { outcome: "censored", reasons: ["detector-failed"] };
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /censored by something other than its recorded capture loss/);
  }
  // So does a recorded loss whose family the quality block leaves complete.
  {
    const { baseline, candidate } = await fresh();
    baseline.runs[0].qualityFacts.captureLoss.push({ ...fingerprintLoss });
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /censored by something other than its recorded capture loss/);
  }
  // And a malformed loss entry.
  {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, heavy, { ...fingerprintLoss, count: -1 });
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /malformed capture-loss/);
  }
  {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, heavy, { ...fingerprintLoss, detail: "" });
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /malformed capture-loss/);
  }
  // The censored branch must match the evaluator exactly: an extra reason, a
  // reason naming another kind, or a lossy family left complete all refuse.
  const censoringCases: Array<[string, (family: { outcome: string; reasons: string[] }) => void]> = [
    ["extra reason", (family) => { family.reasons.push("detector-failed"); }],
    ["wrong kind", (family) => { family.reasons = ["capture-loss:truncated"]; }],
    ["left complete", (family) => { family.outcome = "complete"; }]
  ];
  for (const [label, edit] of censoringCases) {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, heavy, fingerprintLoss);
    withLoss(candidate, heavy, fingerprintLoss);
    edit(baseline.runs.find((entry: Record<string, any>) => entry.caseId === heavy).quality.byFamily.fingerprinting);
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /censored by something other than its recorded capture loss/, label);
  }
  // A complete family carrying a stray reason refuses too.
  {
    const { baseline, candidate } = await fresh();
    baseline.runs[0].quality.byFamily.storage.reasons = ["capture-loss:dropped"];
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /censored by something other than its recorded capture loss/);
  }
  // So does a loss in a family the quality block does not carry.
  {
    const { baseline, candidate } = await fresh();
    withLoss(baseline, heavy, fingerprintLoss);
    withLoss(candidate, heavy, fingerprintLoss);
    delete baseline.runs.find((entry: Record<string, any>) => entry.caseId === heavy).quality.byFamily.fingerprinting;
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /censored by something other than its recorded capture loss/);
  }
  // The same loss set recorded in a different order is the same loss.
  {
    const { baseline, candidate } = await fresh();
    const storageLoss: Loss = { family: "storage", kind: "dropped", detail: "storage-snapshot", count: 1, phaseId: 0 };
    withLoss(baseline, heavy, fingerprintLoss);
    withLoss(baseline, heavy, storageLoss);
    withLoss(candidate, heavy, storageLoss);
    withLoss(candidate, heavy, fingerprintLoss);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.pass, true);
    assert.deepEqual(
      result.excluded.map((row) => row.metric).sort(),
      ["fingerprintEvents", "storageEntries"]
    );
  }
  // Reasons are a set: two kinds in one family pass in either reason order.
  {
    const { baseline, candidate } = await fresh();
    const truncatedLoss: Loss = { ...fingerprintLoss, kind: "truncated" };
    for (const target of [baseline, candidate]) {
      withLoss(target, heavy, fingerprintLoss);
      withLoss(target, heavy, truncatedLoss);
    }
    const reordered = baseline.runs.find((entry: Record<string, any>) => entry.caseId === heavy).quality.byFamily.fingerprinting;
    reordered.reasons = [...reordered.reasons].reverse();
    assert.equal(h.compareReceipts(baseline, candidate, panel, digest).pass, true);
  }
});

const BASELINE_VERSIONS: Versions = { playwright: null, adblock: "0.13.0", tldts: "7.4.3" };
const CANDIDATE_VERSIONS: Versions = { playwright: "1.61.1", adblock: "0.13.2", tldts: "7.4.9" };

async function freshPair() {
  return {
    baseline: await receipt("forward", "a".repeat(40), "149.0", 10, BASELINE_VERSIONS),
    candidate: await receipt("reverse", "b".repeat(40), "150.0", 11, CANDIDATE_VERSIONS)
  };
}

function committedPanelDigest(h: Helpers) {
  return createHash("sha256").update(h.stableCompareJson(panel)).digest("hex");
}

function onRepetitions(target: Receipt, caseId: string, loss: Loss, repetitions: number[]) {
  return withLoss(target, caseId, loss, (entry) => repetitions.includes(entry.repetition));
}

const signatureOf = (loss: Loss) => `${loss.family}/${loss.kind}/${loss.detail ?? ""}`;

// Losses the scanner records in families no canary metric is counted from:
// the consent-banner probe drop (detector output, as on the 2026-10 Guardian
// runs), the consent-verification coverage drop, and the undetailed
// post-consent reload loss.
const NON_METRIC_LOSSES: Loss[] = [
  { family: "detector-output", kind: "dropped", detail: "consent-banner", count: 1, phaseId: 0 },
  { family: "consent-verification", kind: "dropped", detail: "consent-verification", count: 1, phaseId: 0 },
  { family: "consent-verification", kind: "dropped", count: 1, phaseId: 2 }
];
const METRIC_LOSSES: Loss[] = [
  { family: "requests", kind: "dropped", detail: "request-log", count: 1, phaseId: 0 },
  { family: "cookies", kind: "dropped", detail: "cookie-snapshot", count: 1, phaseId: 0 },
  { family: "storage", kind: "dropped", detail: "storage-snapshot", count: 1, phaseId: 0 },
  { family: "fingerprinting", kind: "dropped", detail: "fingerprint-observer", count: 1, phaseId: 0 }
];

test("capture loss is compared strictly in exactly the families the canary metrics are counted from", async () => {
  const h = await helpers;
  assert.deepEqual([...h.METRIC_FEEDING_FAMILIES], [...new Set(Object.values(h.METRIC_EVIDENCE_FAMILIES))].sort());
  assert.equal(Object.isFrozen(h.METRIC_FEEDING_FAMILIES), true);
  assert.deepEqual(METRIC_LOSSES.map((loss) => loss.family).sort(), [...h.METRIC_FEEDING_FAMILIES]);
  for (const loss of NON_METRIC_LOSSES) assert.equal(h.METRIC_FEEDING_FAMILIES.includes(loss.family), false, loss.family);
});

test("a sporadic capture loss in a family that feeds no canary metric is noted, not compared and not failed", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const site = panel.cases[4].id;
  const total = panel.repetitions;
  // Not systematic: no build carries it on most runs while the other carries
  // it on none.
  const cases: Array<[number[], number[]]> = [
    [[2], []],
    [[], [1]],
    [[1, 3], [2]],
    [[3], [1, 2]],
    [[1, 2, 3], [2]],
    [[3], [1, 2, 3]],
    [[1, 2], [2, 3]],
    [[1], [3]]
  ];
  for (const loss of NON_METRIC_LOSSES) {
    for (const [inBaseline, inCandidate] of cases) {
      const context = `${signatureOf(loss)}: ${inBaseline.length} of ${total} baseline vs ${inCandidate.length} of ${total} candidate`;
      const { baseline, candidate } = await freshPair();
      onRepetitions(baseline, site, loss, inBaseline);
      onRepetitions(candidate, site, loss, inCandidate);
      const result = h.compareReceipts(baseline, candidate, panel, digest);
      assert.equal(result.pass, true, context);
      assert.deepEqual(
        result.noted,
        [{ caseId: site, signature: signatureOf(loss), baselineRuns: inBaseline.length, baselineTotal: total, candidateRuns: inCandidate.length, candidateTotal: total }],
        context
      );
      assert.deepEqual(result.excluded, [], context);
      assert.equal(result.results.length, panel.cases.length * h.METRICS.length, context);
      assert.equal(result.results.every((row) => row.pass), true, context);
    }
  }
  // Noted entries follow the panel order, then the signature order.
  {
    const { baseline, candidate } = await freshPair();
    onRepetitions(baseline, site, NON_METRIC_LOSSES[0], [1]);
    onRepetitions(baseline, site, NON_METRIC_LOSSES[1], [2]);
    onRepetitions(candidate, panel.cases[2].id, NON_METRIC_LOSSES[0], [3]);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.pass, true);
    assert.deepEqual(result.noted.map((row) => [row.caseId, row.signature]), [
      ["python", "detector-output/dropped/consent-banner"],
      ["guardian", "consent-verification/dropped/consent-verification"],
      ["guardian", "detector-output/dropped/consent-banner"]
    ]);
  }
});

test("a capture loss in a family that feeds no metric fails when most runs of one build carry it and no run of the other does", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const site = panel.cases[4].id;
  const total = panel.repetitions;
  const cases: Array<[number[], number[]]> = [
    [[1, 2], []],
    [[1, 2, 3], []],
    [[], [2, 3]],
    [[], [1, 2, 3]],
    [[1, 3], []],
    [[], [1, 3]]
  ];
  for (const loss of NON_METRIC_LOSSES) {
    for (const [inBaseline, inCandidate] of cases) {
      const { baseline, candidate } = await freshPair();
      onRepetitions(baseline, site, loss, inBaseline);
      onRepetitions(candidate, site, loss, inCandidate);
      assert.throws(
        () => h.compareReceipts(baseline, candidate, panel, digest),
        {
          message: `Capture loss ${signatureOf(loss)} differs systematically between the builds on ${site}: ${inBaseline.length} of ${total} baseline runs vs ${inCandidate.length} of ${total} candidate runs.`
        },
        `${signatureOf(loss)}: ${inBaseline.length} vs ${inCandidate.length}`
      );
    }
  }
  // A detail that changes between builds is a systematic difference in both
  // signatures, as it was a difference under the like-with-like rule.
  {
    const { baseline, candidate } = await freshPair();
    withLoss(baseline, site, NON_METRIC_LOSSES[0]);
    withLoss(candidate, site, { ...NON_METRIC_LOSSES[0], detail: "consent-banner-frame" });
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /differs systematically between the builds on guardian: 3 of 3 baseline runs vs 0 of 3 candidate runs/);
  }
  // A shared loss on the same site does not mask a systematic one.
  {
    const { baseline, candidate } = await freshPair();
    const shared: Loss = { family: "detector-output", kind: "truncated", detail: "keystroke-probe-capture", count: 1, phaseId: 1 };
    withLoss(baseline, site, shared);
    withLoss(candidate, site, shared);
    onRepetitions(candidate, site, NON_METRIC_LOSSES[1], [1, 2]);
    assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /differs systematically between the builds on guardian: 0 of 3 baseline runs vs 2 of 3 candidate runs/);
  }
});

test("a capture-loss difference in a metric-feeding family still fails, even beside a sporadic one that feeds no metric", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const site = panel.cases[4].id;
  // One run of one build, in either direction, is already a difference.
  for (const loss of METRIC_LOSSES) {
    for (const [inBaseline, inCandidate] of [[[2], []], [[], [1]]] as Array<[number[], number[]]>) {
      const { baseline, candidate } = await freshPair();
      onRepetitions(baseline, site, loss, inBaseline);
      onRepetitions(candidate, site, loss, inCandidate);
      assert.throws(() => h.compareReceipts(baseline, candidate, panel, digest), /Capture loss differs between runs of guardian: /, loss.family);
    }
  }
  // The strict message lists only the metric-feeding signatures; the sporadic
  // detector-output loss beside it neither masks nor joins the failure.
  {
    const { baseline, candidate } = await freshPair();
    withLoss(candidate, site, METRIC_LOSSES[3]);
    onRepetitions(baseline, site, NON_METRIC_LOSSES[0], [2]);
    assert.throws(
      () => h.compareReceipts(baseline, candidate, panel, digest),
      { message: 'Capture loss differs between runs of guardian: [] vs ["fingerprinting/dropped/fingerprint-observer"].' }
    );
  }
  {
    const { baseline, candidate } = await freshPair();
    withLoss(baseline, site, METRIC_LOSSES[2]);
    withLoss(candidate, site, METRIC_LOSSES[2], (entry) => entry.repetition !== 3);
    onRepetitions(candidate, site, NON_METRIC_LOSSES[1], [3]);
    assert.throws(
      () => h.compareReceipts(baseline, candidate, panel, digest),
      { message: 'Capture loss differs between runs of guardian: ["storage/dropped/storage-snapshot"] vs [].' }
    );
  }
});

test("a capture loss that feeds no metric, recorded on every run of both builds, passes noted on every site and left out of nothing", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const total = panel.repetitions;
  for (const loss of NON_METRIC_LOSSES) {
    const { baseline, candidate } = await freshPair();
    for (const entry of panel.cases) {
      withLoss(baseline, entry.id, loss);
      withLoss(candidate, entry.id, loss);
    }
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.pass, true, loss.family);
    assert.deepEqual(
      result.noted,
      panel.cases.map((entry) => ({ caseId: entry.id, signature: signatureOf(loss), baselineRuns: total, baselineTotal: total, candidateRuns: total, candidateTotal: total })),
      loss.family
    );
    assert.deepEqual(result.excluded, [], loss.family);
    assert.equal(result.results.length, panel.cases.length * h.METRICS.length, loss.family);
  }
});

test("a receipt holds each scan once: a repeated run id or wire digest, a repetition that is not a number and a missing creation time are refused", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const repeated = { message: "Receipt repeats a run id or a report wire digest: each run of a receipt is a scan of its own." };
  const coverage = { message: "Receipt run order or coverage is invalid." };
  const noTime = { message: "Receipt has no creation time." };
  // [what was done to one receipt, the refusal]
  const edits: Array<[string, (receipt: Receipt) => void, { message: string }]> = [
    ["two runs with one run id", (receipt) => { receipt.runs[1].runId = receipt.runs[0].runId; }, repeated],
    ["two runs with one wire digest", (receipt) => { receipt.runs[4].reportWireSha256 = receipt.runs[0].reportWireSha256; }, repeated],
    // One visit pasted over the next one, under that run's own report id and
    // place: the counts of one scan would stand for two.
    ["one run pasted over another under the other's report id", (receipt) => {
      const [first, second] = receipt.runs;
      receipt.runs[1] = { ...structuredClone(first), repetition: second.repetition, sequence: second.sequence, reportId: second.reportId, reportJsonPath: second.reportJsonPath };
    }, repeated],
    ["a run with no run id", (receipt) => { delete receipt.runs[2].runId; }, repeated],
    ["a run with an empty run id", (receipt) => { receipt.runs[2].runId = ""; }, repeated],
    ["a repetition given as a string", (receipt) => { receipt.runs[0].repetition = "1"; }, coverage],
    ["a repetition given as a list", (receipt) => { receipt.runs[0].repetition = [1]; }, coverage],
    ["no creation time", (receipt) => { delete receipt.createdAt; }, noTime],
    ["a creation time that is not a string", (receipt) => { receipt.createdAt = 1784419200000; }, noTime],
    ["a creation time that is no timestamp", (receipt) => { receipt.createdAt = "yesterday"; }, noTime]
  ];
  for (const [label, edit, refusal] of edits) {
    for (const side of ["baseline", "candidate"] as const) {
      const pair = await freshPair();
      edit(pair[side]);
      assert.throws(() => h.compareReceipts(pair.baseline, pair.candidate, panel, digest), refusal, `${label} in the ${side}`);
    }
  }
  // Untouched, the pair compares.
  const pair = await freshPair();
  assert.equal(h.compareReceipts(pair.baseline, pair.candidate, panel, digest).outcome, "pass");
  // The fourteen committed receipts hold fifteen scans of their own each.
  // Their replay, tested below, runs them through the same check.
  assert.equal(EVERY_COMMITTED_RECEIPT.length, 14);
  for (const file of EVERY_COMMITTED_RECEIPT) {
    const receipt = committedReceipt(file);
    assert.equal(receipt.runs.length, 15, file);
    assert.equal(new Set(receipt.runs.map((entry: Receipt) => entry.runId)).size, 15, file);
    assert.equal(new Set(receipt.runs.map((entry: Receipt) => entry.reportWireSha256)).size, 15, file);
    assert.equal(receipt.runs.every((entry: Receipt) => Number.isSafeInteger(entry.repetition)), true, file);
    assert.match(receipt.createdAt, /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/, file);
  }
});

function committedReceipt(file: string): Receipt {
  return JSON.parse(readFileSync(path.join(process.cwd(), "docs", file), "utf8")) as Receipt;
}

async function panelsOnDisk() {
  const h = await helpers;
  return { current: { panel: currentPanel, digest: h.panelDigest(currentPanel) }, committed: h.readCommittedPanels(committedPanelFiles()) };
}

// A committed pair, read the way the replay command reads it: on the
// committed panel both receipts carry, found by their own digest, whatever
// the current panel is.
async function replayCommitted(baselineFile: string, candidateFile: string) {
  const h = await helpers;
  const baseline = committedReceipt(baselineFile);
  const candidate = committedReceipt(candidateFile);
  const selection = h.selectComparisonPanel({ replay: true, baseline, candidate, ...(await panelsOnDisk()) });
  assert.equal(selection.replay, true);
  assert.equal(selection.file, "scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v1.json");
  assert.equal(selection.digest, "86fe39f8e4e75e9a2925c1849006909968b67bc507d2aec6cb688ce9cc22be29");
  return h.compareReceipts(baseline, candidate, selection.panel, selection.digest);
}

// The medians that moved between the builds, as [site, metric, baseline,
// candidate, delta, allowed]; every other compared median is identical.
function movedMedians(result: Comparison) {
  return result.results
    .filter((row) => row.delta !== 0)
    .map((row) => [row.caseId, row.metric, row.baseline, row.candidate, row.delta, Number(row.allowed.toFixed(2))]);
}

// The compared metrics that did not pass, as [site, metric, outcome, baseline
// repetitions, candidate repetitions, baseline spread, candidate spread,
// allowed]. It also holds every result to the one vocabulary: a row passes
// exactly when its outcome is pass, and so does the comparison.
function notPassed(h: Helpers, result: Comparison) {
  assert.equal(result.rule, h.COMPARISON_RULE);
  assert.equal(result.pass, result.outcome === "pass");
  for (const row of result.results) assert.equal(row.pass, row.outcome === "pass", `${row.caseId}.${row.metric}`);
  return result.results
    .filter((row) => row.outcome !== "pass")
    .map((row) => [row.caseId, row.metric, row.outcome, row.baselineValues, row.candidateValues, row.baselineSpread, row.candidateSpread, Number(row.allowed.toFixed(2))]);
}

const GUARDIAN_FINGERPRINT_LEFT_OUT = [{ caseId: "guardian", metric: "fingerprintEvents", family: "fingerprinting" }];
// github's keystroke-probe truncation is on every run of both builds in the
// 2026-09 pair and in both 2026-10 rounds; it is noted, not compared.
const GITHUB_KEYSTROKE_NOTED: Noted = { caseId: "github", signature: "detector-output/truncated/keystroke-probe-capture", baselineRuns: 3, baselineTotal: 3, candidateRuns: 3, candidateTotal: 3 };

// The committed receipts are real inputs to the three tests below, replayed
// on the committed panel they carry. What the comparison rule computes from
// them is a property of the rule. It is not a judgement of the epochs they
// record, which stand as recorded under the rule that ran.
test("the committed 2026-09 receipts compare with the medians their record states, and the within-arm spread rule leaves guardian's known-tracker count inconclusive", async () => {
  const h = await helpers;
  const result = await replayCommitted("toolchain-epoch-2026-09/baseline-receipt.json", "toolchain-epoch-2026-09/candidate-receipt.json");
  assert.equal(result.outcome, "inconclusive");
  assert.equal(result.pass, false);
  assert.equal(result.baselineBuild, "cd43c7bce9a980037a74f7ee2a05b722c2638b17");
  assert.equal(result.candidateBuild, "c8b189ac59f50121e6f1777dabe12ba4854f6090");
  assert.equal(result.results.length, 44);
  // One candidate repetition drew the page's low state: its three runs differ
  // by 10 against a tolerance of 9. No compared median is beyond its tolerance.
  assert.deepEqual(notPassed(h, result), [
    ["guardian", "knownTrackerRequests", "inconclusive", [27, 30, 30], [17, 27, 27], 3, 10, 9]
  ]);
  // The two builds' runs overlap on every metric, so none fails on separation.
  assert.equal(result.results.some((row) => row.separated), false);
  assert.deepEqual(result.excluded, GUARDIAN_FINGERPRINT_LEFT_OUT);
  assert.deepEqual(result.noted, [GITHUB_KEYSTROKE_NOTED]);
  assert.deepEqual(movedMedians(result), [
    ["guardian", "totalRequests", 202, 182, 20, 40.4],
    ["guardian", "thirdPartyRequests", 169, 152, 17, 42.25],
    ["guardian", "knownTrackerRequests", 30, 27, 3, 9],
    ["guardian", "thirdPartyDomains", 30, 29, 1, 7.5],
    ["guardian", "cookies", 22, 23, 1, 6.6],
    ["guardian", "thirdPartyCookies", 6, 5, 1, 3],
    ["guardian", "storageEntries", 24, 26, 2, 7.2],
    ["guardian", "shieldsBlockedRequests", 78, 69, 9, 23.4]
  ]);
});

test("the committed 2026-10 receipts compare with github's every-run loss and the sporadic losses their record describes noted, and the within-arm spread rule leaves guardian's bimodal counts inconclusive", async () => {
  const h = await helpers;
  const consentBanner = { caseId: "guardian", signature: "detector-output/dropped/consent-banner", baselineRuns: 1, baselineTotal: 3, candidateRuns: 0, candidateTotal: 3 };
  const rounds: Array<[string, Noted[], Array<Array<string | number>>, Array<Array<string | number | number[]>>]> = [
    ["round-1", [GITHUB_KEYSTROKE_NOTED, consentBanner], [
      ["guardian", "totalRequests", 188, 184, 4, 37.6],
      ["guardian", "thirdPartyRequests", 158, 154, 4, 39.5],
      ["guardian", "shieldsBlockedRequests", 70, 71, 1, 21]
    ], [
      // Two of these medians are identical across the builds: an agreement
      // under that much spread is not a pass either.
      ["guardian", "knownTrackerRequests", "inconclusive", [27, 17, 30], [27, 28, 27], 13, 1, 8.1],
      ["guardian", "thirdPartyDomains", "inconclusive", [29, 25, 33], [29, 29, 29], 8, 0, 7.25],
      ["guardian", "shieldsBlockedRequests", "inconclusive", [70, 47, 77], [71, 71, 72], 30, 1, 21]
    ]],
    ["round-2", [
      GITHUB_KEYSTROKE_NOTED,
      { caseId: "python", signature: "detector-output/truncated/policy-link-candidates", baselineRuns: 0, baselineTotal: 3, candidateRuns: 1, candidateTotal: 3 },
      consentBanner
    ], [
      ["guardian", "totalRequests", 189, 195, 6, 37.8],
      ["guardian", "thirdPartyRequests", 159, 165, 6, 39.75],
      ["guardian", "knownTrackerRequests", 27, 29, 2, 8.1],
      ["guardian", "thirdPartyDomains", 29, 30, 1, 7.25],
      ["guardian", "shieldsBlockedRequests", 71, 76, 5, 21.3]
    ], [
      ["guardian", "knownTrackerRequests", "inconclusive", [27, 27, 17], [34, 29, 27], 10, 7, 8.1],
      ["guardian", "shieldsBlockedRequests", "inconclusive", [72, 71, 47], [88, 76, 72], 25, 16, 21.3]
    ]]
  ];
  for (const [round, noted, moved, unresolved] of rounds) {
    const result = await replayCommitted(`toolchain-epoch-2026-10/${round}-baseline-receipt.json`, `toolchain-epoch-2026-10/${round}-candidate-receipt.json`);
    assert.equal(result.outcome, "inconclusive", round);
    assert.equal(result.pass, false, round);
    assert.equal(result.baselineBuild, "f9d6c46e744c60a3485eba3951f0b168b9170941", round);
    assert.equal(result.candidateBuild, "34d6847b54d804c449bed160a53129ca2e1f16ef", round);
    assert.equal(result.results.length, 44, round);
    assert.deepEqual(notPassed(h, result), unresolved, round);
    assert.equal(result.results.some((row) => row.separated), false, round);
    assert.deepEqual(result.excluded, GUARDIAN_FINGERPRINT_LEFT_OUT, round);
    assert.deepEqual(result.noted, noted, round);
    assert.deepEqual(movedMedians(result), moved, round);
  }
});

test("the committed 2026-11 receipts replay as inconclusive on guardian's known-tracker and Shields-blocked counts in both rounds, with nothing left out", async () => {
  const h = await helpers;
  const policyVisit: Noted = { caseId: "guardian", signature: "detector-output/dropped/policy-visit", baselineRuns: 3, baselineTotal: 3, candidateRuns: 3, candidateTotal: 3 };
  const rounds: Array<[string, Noted[], Array<Array<string | number | number[]>>]> = [
    ["round-1", [
      GITHUB_KEYSTROKE_NOTED,
      { caseId: "python", signature: "detector-output/truncated/policy-link-candidates", baselineRuns: 3, baselineTotal: 3, candidateRuns: 3, candidateTotal: 3 },
      policyVisit
    ], [
      ["guardian", "knownTrackerRequests", "inconclusive", [16, 17, 16], [16, 29, 26], 1, 13, 4.8],
      ["guardian", "shieldsBlockedRequests", "inconclusive", [48, 49, 48], [48, 68, 71], 1, 23, 14.4]
    ]],
    ["round-2", [GITHUB_KEYSTROKE_NOTED, policyVisit], [
      ["guardian", "knownTrackerRequests", "inconclusive", [27, 16, 28], [16, 19, 26], 12, 10, 8.1],
      ["guardian", "shieldsBlockedRequests", "inconclusive", [76, 48, 79], [48, 50, 71], 31, 23, 22.8]
    ]]
  ];
  for (const [round, noted, unresolved] of rounds) {
    const result = await replayCommitted(`toolchain-epoch-2026-11/${round}-baseline-receipt.json`, `toolchain-epoch-2026-11/${round}-candidate-receipt.json`);
    assert.equal(result.outcome, "inconclusive", round);
    assert.equal(result.pass, false, round);
    assert.equal(result.baselineBuild, "59402b6d47c05b767a81eb38ab6c30b0d88c696a", round);
    assert.equal(result.candidateBuild, "8c6a8fc5fdb056d84a2693fb38e08689cfbc179d", round);
    assert.equal(result.results.length, 45, round);
    assert.deepEqual(notPassed(h, result), unresolved, round);
    assert.equal(result.results.some((row) => row.separated), false, round);
    assert.deepEqual(result.excluded, [], round);
    assert.deepEqual(result.noted, noted, round);
  }
});

function setCounts(target: Receipt, caseId: string, metric: string, values: number[]) {
  assert.equal(values.length, panel.repetitions);
  for (const entry of target.runs) if (entry.caseId === caseId) entry.counts[metric] = values[entry.repetition - 1];
  return target;
}

function rowFor(result: Comparison, caseId: string, metric: string): Row {
  const row = result.results.find((entry) => entry.caseId === caseId && entry.metric === metric);
  assert.ok(row, `${caseId}.${metric} was not compared`);
  return row;
}

test("a metric whose repetitions within one build differ by more than the tolerance is inconclusive, and a spread equal to the tolerance is not", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const site = panel.cases[0].id;
  // totalRequests allows max(10, 0.2 x baseline median). Each row is [baseline
  // repetitions, candidate repetitions, allowed, outcome], in pairs that sit
  // exactly on the tolerance and one count above it, for each arm and for the
  // absolute and the relative term.
  const cases: Array<[number[], number[], number, Outcome]> = [
    [[10, 10, 20], [11, 11, 11], 10, "pass"],
    [[10, 10, 21], [11, 11, 11], 10, "inconclusive"],
    [[10, 10, 10], [11, 21, 11], 10, "pass"],
    [[10, 10, 10], [11, 22, 11], 10, "inconclusive"],
    [[100, 120, 100], [100, 100, 100], 20, "pass"],
    [[100, 121, 100], [100, 100, 100], 20, "inconclusive"],
    [[100, 100, 100], [120, 100, 100], 20, "pass"],
    [[100, 100, 100], [121, 100, 100], 20, "inconclusive"],
    // Both builds are held to the one tolerance the medians are compared by,
    // taken from the baseline median: the candidate's own median would allow
    // 22 here.
    [[100, 100, 100], [110, 110, 130], 20, "pass"],
    [[100, 100, 100], [110, 110, 131], 20, "inconclusive"],
    // Medians that agree exactly are no pass under that much spread.
    [[10, 10, 40], [10, 10, 10], 10, "inconclusive"],
    [[10, 10, 10], [10, 40, 10], 10, "inconclusive"],
    // A spread on the tolerance in both arms leaves the median difference to
    // decide, as before; one count more in either arm is inconclusive, ahead
    // of the failure.
    [[10, 10, 20], [30, 30, 40], 10, "fail"],
    [[10, 10, 21], [30, 30, 40], 10, "inconclusive"],
    [[10, 10, 20], [30, 30, 41], 10, "inconclusive"]
  ];
  for (const [baselineValues, candidateValues, allowed, outcome] of cases) {
    const context = `${JSON.stringify(baselineValues)} vs ${JSON.stringify(candidateValues)}`;
    const { baseline, candidate } = await freshPair();
    setCounts(baseline, site, "totalRequests", baselineValues);
    setCounts(candidate, site, "totalRequests", candidateValues);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    const row = rowFor(result, site, "totalRequests");
    assert.equal(row.allowed, allowed, context);
    assert.deepEqual([row.baselineValues, row.candidateValues], [baselineValues, candidateValues], context);
    assert.deepEqual(
      [row.baselineSpread, row.candidateSpread],
      [Math.max(...baselineValues) - Math.min(...baselineValues), Math.max(...candidateValues) - Math.min(...candidateValues)],
      context
    );
    assert.equal(row.outcome, outcome, context);
    assert.equal(row.separated, false, context);
    assert.equal(result.outcome, outcome, context);
    // Nothing else in the panel moved, so this one metric decides the result.
    assert.deepEqual(notPassed(h, result).map((entry) => entry.slice(0, 3)), outcome === "pass" ? [] : [[site, "totalRequests", outcome]], context);
  }
});

test("a metric fails, whatever the spreads, when every run of one build differs from every run of the other by more than the tolerance, and a gap equal to the tolerance is not that case", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const site = panel.cases[0].id;
  // totalRequests allows max(10, 0.2 x baseline median). Each row is [baseline
  // repetitions, candidate repetitions, allowed, the gap between the two
  // builds' ranges, outcome, whether it failed on that gap].
  const cases: Array<[number[], number[], number, number, Outcome, boolean]> = [
    // A doubled count whose runs are also unsteady is a failure, not "no
    // evidence": the candidate's spread of 21 is over the tolerance of 20.
    [[100, 100, 100], [200, 200, 221], 20, 100, "fail", true],
    // A gap exactly on the tolerance is not separated, so the spread decides;
    // one count more is, with the candidate above the baseline and below it,
    // and with the spread in either build.
    [[100, 100, 100], [120, 120, 141], 20, 20, "inconclusive", false],
    [[100, 100, 100], [121, 121, 142], 20, 21, "fail", true],
    [[100, 100, 100], [80, 59, 80], 20, 20, "inconclusive", false],
    [[100, 100, 100], [79, 58, 79], 20, 21, "fail", true],
    [[100, 100, 121], [141, 141, 141], 20, 20, "inconclusive", false],
    [[100, 100, 121], [142, 142, 142], 20, 21, "fail", true],
    [[100, 121, 100], [80, 80, 80], 20, 20, "inconclusive", false],
    [[100, 121, 100], [79, 79, 79], 20, 21, "fail", true],
    [[100, 100, 130], [160, 160, 190], 20, 30, "fail", true],
    // Ranges that touch or overlap have no gap, however far the medians are.
    [[100, 100, 100], [100, 100, 121], 20, 0, "inconclusive", false],
    [[100, 100, 150], [100, 150, 150], 20, -50, "inconclusive", false],
    // Steady builds that are separated fail on the gap and on their medians
    // alike. Steady builds a tolerance apart fail on their medians alone.
    [[10, 10, 10], [30, 30, 30], 10, 20, "fail", true],
    [[10, 10, 20], [30, 30, 40], 10, 10, "fail", false]
  ];
  for (const [baselineValues, candidateValues, allowed, separation, outcome, separated] of cases) {
    const context = `${JSON.stringify(baselineValues)} vs ${JSON.stringify(candidateValues)}`;
    const { baseline, candidate } = await freshPair();
    setCounts(baseline, site, "totalRequests", baselineValues);
    setCounts(candidate, site, "totalRequests", candidateValues);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    const row = rowFor(result, site, "totalRequests");
    assert.equal(row.allowed, allowed, context);
    assert.equal(row.separation, separation, context);
    assert.equal(row.separated, separated, context);
    assert.equal(row.outcome, outcome, context);
    assert.equal(result.outcome, outcome, context);
    assert.deepEqual(notPassed(h, result).map((entry) => entry.slice(0, 3)), [[site, "totalRequests", outcome]], context);
  }
});

// The guardian page's knownTrackerRequests, shieldsBlockedRequests and
// totalRequests per repetition in the two 2026-11 rounds: run-2 is the
// committed round 1 and run-4 the committed round 2, whose receipts were
// committed after these tests were written and are replayed above. The
// median-only rule failed both rounds, in opposite directions, because the
// two arms drew different numbers of the page's low state (about 16 to 19,
// 47 to 50, 160 to 166).
const GUARDIAN_2026_11_METRICS = ["knownTrackerRequests", "shieldsBlockedRequests", "totalRequests"];
const GUARDIAN_2026_11: Record<string, { baseline: number[][]; candidate: number[][] }> = {
  "run-2": { baseline: [[16, 48, 161], [17, 49, 166], [16, 48, 165]], candidate: [[16, 48, 161], [29, 68, 182], [26, 71, 186]] },
  "run-4": { baseline: [[27, 76, 196], [16, 48, 165], [28, 79, 200]], candidate: [[16, 48, 161], [19, 50, 164], [26, 71, 186]] }
};

// A constructed pair in which every other count is stable and within
// tolerance, so the guardian values above decide the result.
async function round2026_11(round: string) {
  const { baseline, candidate } = await freshPair();
  GUARDIAN_2026_11_METRICS.forEach((metric, index) => {
    setCounts(baseline, "guardian", metric, GUARDIAN_2026_11[round].baseline.map((repetition) => repetition[index]));
    setCounts(candidate, "guardian", metric, GUARDIAN_2026_11[round].candidate.map((repetition) => repetition[index]));
  });
  return { baseline, candidate };
}

test("a stable metric whose medians differ by more than the tolerance still fails, and one failure fails the comparison beside an inconclusive metric", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const stable = panel.cases[0].id;
  {
    const { baseline, candidate } = await freshPair();
    setCounts(candidate, stable, "cookies", [20, 20, 20]);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.outcome, "fail");
    assert.equal(result.pass, false);
    assert.deepEqual(notPassed(h, result), [[stable, "cookies", "fail", [10, 10, 10], [20, 20, 20], 0, 0, 4]]);
  }
  {
    const { baseline, candidate } = await round2026_11("run-2");
    setCounts(candidate, stable, "cookies", [20, 20, 20]);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.outcome, "fail");
    assert.equal(result.pass, false);
    assert.deepEqual(notPassed(h, result).map((entry) => entry.slice(0, 3)), [
      [stable, "cookies", "fail"],
      ["guardian", "knownTrackerRequests", "inconclusive"],
      ["guardian", "shieldsBlockedRequests", "inconclusive"]
    ]);
  }
});

test("each 2026-11 guardian round is inconclusive on the metrics the median-only rule failed, whichever arm drew more low runs", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  // [round, the medians beyond tolerance with the candidate's direction, the
  // metrics that did not pass, totalRequests spreads and allowed]
  const rounds: Array<[string, string[], Array<Array<string | number | number[]>>, number[]]> = [
    ["run-2", ["guardian.knownTrackerRequests higher", "guardian.shieldsBlockedRequests higher"], [
      ["guardian", "knownTrackerRequests", "inconclusive", [16, 17, 16], [16, 29, 26], 1, 13, 4.8],
      ["guardian", "shieldsBlockedRequests", "inconclusive", [48, 49, 48], [48, 68, 71], 1, 23, 14.4]
    ], [5, 25, 33]],
    // The known-tracker medians (27 against 19) sit inside the tolerance of
    // 8.1 by a tenth of a count, which the median-only rule passed.
    ["run-4", ["guardian.shieldsBlockedRequests lower"], [
      ["guardian", "knownTrackerRequests", "inconclusive", [27, 16, 28], [16, 19, 26], 12, 10, 8.1],
      ["guardian", "shieldsBlockedRequests", "inconclusive", [76, 48, 79], [48, 50, 71], 31, 23, 22.8]
    ], [35, 25, 39.2]]
  ];
  for (const [round, beyondTolerance, unresolved, total] of rounds) {
    const { baseline, candidate } = await round2026_11(round);
    const result = h.compareReceipts(baseline, candidate, panel, digest);
    assert.equal(result.outcome, "inconclusive", round);
    assert.equal(result.pass, false, round);
    assert.equal(result.results.length, panel.cases.length * h.METRICS.length, round);
    assert.deepEqual(
      result.results.filter((row) => row.delta > row.allowed).map((row) => `${row.caseId}.${row.metric} ${row.candidate > row.baseline ? "higher" : "lower"}`),
      beyondTolerance,
      round
    );
    assert.deepEqual(notPassed(h, result), unresolved, round);
    // Low and high runs sit in both builds, so their ranges overlap and no
    // metric fails on separation.
    assert.equal(result.results.some((row) => row.separated), false, round);
    // The request total spreads too, but inside its wider tolerance, so it is
    // still compared and still passes.
    const totalRequests = rowFor(result, "guardian", "totalRequests");
    assert.deepEqual([totalRequests.baselineSpread, totalRequests.candidateSpread, Number(totalRequests.allowed.toFixed(2)), totalRequests.outcome], [...total, "pass"], round);
  }
});

type Verb = "compare" | "replay";

// The canary command on two receipt files, from the repository by default or
// from another tree that holds a copy of the command.
function compareFiles(baselineFile: string, candidateFile: string, verb: Verb = "compare", tree = process.cwd()) {
  return spawnSync(process.execPath, ["--no-warnings", path.join(tree, "scripts", "toolchain-canary.mjs"), verb, "--baseline", baselineFile, "--candidate", candidateFile], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

// The receipts constructed in this file are on panel version 1. The compare
// command reads them in a tree whose current panel is version 1, so the
// tests of what it prints keep their case names when the repository's own
// current panel changes.
let treeOnPanelV1: string | undefined;
after(() => {
  if (treeOnPanelV1) rmSync(treeOnPanelV1, { recursive: true, force: true });
});
function panelV1Tree() {
  const text = readFileSync(path.join(process.cwd(), PANEL_V1_FILE), "utf8");
  treeOnPanelV1 ??= canaryTree(text, [{ name: "monthly-toolchain-canary-v1.json", text }]);
  return treeOnPanelV1;
}

function compareConstructed(baseline: Receipt, candidate: Receipt, verb: Verb = "compare", tree = panelV1Tree()) {
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-"));
  try {
    const baselineFile = path.join(directory, "baseline-receipt.json");
    const candidateFile = path.join(directory, "candidate-receipt.json");
    writeFileSync(baselineFile, JSON.stringify(baseline));
    writeFileSync(candidateFile, JSON.stringify(candidate));
    return compareFiles(baselineFile, candidateFile, verb, tree);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const printed = (text: string) => (text === "" ? [] : text.trimEnd().split("\n"));

const RULE_LINE = "RULE median-with-within-arm-spread-v2";
const LEFT_OUT_LINE = "LEFT OUT guardian.fingerprintEvents: every run of both builds records fingerprinting capture loss";
const GITHUB_NOTED_LINE = "NOTED github: detector-output/truncated/keystroke-probe-capture capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric";
const VARIED = "the page varied within one build by more than the tolerance";
const inconclusiveLine = (metric: string, values: string, medians: string) =>
  `INCONCLUSIVE ${metric}: ${values}; ${VARIED}, so medians ${medians} say nothing about the toolchain for this metric`;
const inconclusiveResult = (builds: string, share: string, metrics: string) =>
  `INCONCLUSIVE ${builds}: not a pass. No compared fixed-panel median failed, but for ${share} ${VARIED}, so the comparison says nothing about the toolchain for ${metrics}. The release decision has to record each inconclusive metric by name with its values above.`;
const CONSTRUCTED_BUILDS = `${"a".repeat(40)} -> ${"b".repeat(40)}`;

test("the compare CLI names its rule, then prints each left-out metric and noted loss before its PASS line, and exits 0", async () => {
  const keystrokeLoss: Loss = { family: "detector-output", kind: "truncated", detail: "keystroke-probe-capture", count: 1, phaseId: 1 };
  {
    const { baseline, candidate } = await freshPair();
    for (const target of [baseline, candidate]) {
      withLoss(target, "guardian", METRIC_LOSSES[3]);
      withLoss(target, "github", keystrokeLoss);
    }
    const result = compareConstructed(baseline, candidate);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(printed(result.stdout), [
      RULE_LINE,
      LEFT_OUT_LINE,
      GITHUB_NOTED_LINE,
      `PASS ${CONSTRUCTED_BUILDS}: all 44 compared fixed-panel medians are within tolerance; 1 left out for shared capture loss; 1 capture-loss signature noted and not compared.`
    ]);
  }
  {
    const { baseline, candidate } = await freshPair();
    onRepetitions(candidate, "python", { family: "detector-output", kind: "truncated", detail: "policy-link-candidates", count: 1, phaseId: 2 }, [1]);
    onRepetitions(baseline, "guardian", NON_METRIC_LOSSES[0], [2]);
    const result = compareConstructed(baseline, candidate);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(printed(result.stdout), [
      RULE_LINE,
      "NOTED python: detector-output/truncated/policy-link-candidates capture loss on 0 of 3 baseline and 1 of 3 candidate runs; recorded, not compared: its family feeds no canary metric",
      "NOTED guardian: detector-output/dropped/consent-banner capture loss on 1 of 3 baseline and 0 of 3 candidate runs; recorded, not compared: its family feeds no canary metric",
      `PASS ${CONSTRUCTED_BUILDS}: all 45 compared fixed-panel medians are within tolerance; 2 capture-loss signatures noted and not compared.`
    ]);
  }
});

test("the compare CLI exits 2, not 0 and not 1, when nothing fails and a metric is inconclusive, and names each one with both builds' repetitions, spreads and tolerance", async () => {
  const constructed: Array<[string, string[]]> = [
    ["run-2", [
      inconclusiveLine("guardian.knownTrackerRequests", "baseline runs 16, 17, 16 (spread 1), candidate runs 16, 29, 26 (spread 13), tolerance 4.8", "16 -> 26"),
      inconclusiveLine("guardian.shieldsBlockedRequests", "baseline runs 48, 49, 48 (spread 1), candidate runs 48, 68, 71 (spread 23), tolerance 14.399999999999999", "48 -> 68"),
      inconclusiveResult(CONSTRUCTED_BUILDS, "2 of 45", "guardian.knownTrackerRequests, guardian.shieldsBlockedRequests")
    ]],
    ["run-4", [
      inconclusiveLine("guardian.knownTrackerRequests", "baseline runs 27, 16, 28 (spread 12), candidate runs 16, 19, 26 (spread 10), tolerance 8.1", "27 -> 19"),
      inconclusiveLine("guardian.shieldsBlockedRequests", "baseline runs 76, 48, 79 (spread 31), candidate runs 48, 50, 71 (spread 23), tolerance 22.8", "76 -> 50"),
      inconclusiveResult(CONSTRUCTED_BUILDS, "2 of 45", "guardian.knownTrackerRequests, guardian.shieldsBlockedRequests")
    ]]
  ];
  for (const [round, expected] of constructed) {
    const { baseline, candidate } = await round2026_11(round);
    const result = compareConstructed(baseline, candidate);
    assert.equal(result.status, 2, `${round}: ${result.stderr}`);
    assert.deepEqual(printed(result.stdout), [RULE_LINE], round);
    assert.deepEqual(printed(result.stderr), expected, round);
  }
});

const REPLAY_TAIL = "This is a replay on the panel named in the REPLAY line, not a release comparison.";
// A line as the replay command prints it: the compare command's line, marked.
const replayed = (line: string) => `REPLAY ${line}`;
const OTHER_PANEL_REFUSAL = (which: string) =>
  `The ${which} receipt names committed panel monthly-toolchain-canary-v1 (version 1), which is not the current panel monthly-toolchain-canary-v2 (version 2). The compare command judges a release on the current panel only, and a release needs a fresh capture of both builds on that panel. To read these receipts against the panel they were captured with, run the replay command on the same two files: a replay is not a release comparison.`;
const PANEL_V1_NAMED = "REPLAY on committed panel monthly-toolchain-canary-v1 (version 1, sha256 86fe39f8e4e75e9a2925c1849006909968b67bc507d2aec6cb688ce9cc22be29, scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v1.json), the panel both receipts carry.";
const replayInconclusiveResult = (builds: string, share: string, metrics: string) =>
  `REPLAY INCONCLUSIVE ${builds}: not a pass. No compared fixed-panel median failed, but for ${share} ${VARIED}, so the comparison says nothing about the toolchain for ${metrics}. ${REPLAY_TAIL}`;
const BUILDS_2026_09 = "cd43c7bce9a980037a74f7ee2a05b722c2638b17 -> c8b189ac59f50121e6f1777dabe12ba4854f6090";
const BUILDS_2026_10 = "f9d6c46e744c60a3485eba3951f0b168b9170941 -> 34d6847b54d804c449bed160a53129ca2e1f16ef";
const BUILDS_2026_11 = "59402b6d47c05b767a81eb38ab6c30b0d88c696a -> 8c6a8fc5fdb056d84a2693fb38e08689cfbc179d";
const GUARDIAN_PAIR = "guardian.knownTrackerRequests, guardian.shieldsBlockedRequests";
// The five committed pairs with the result line each replays to.
const COMMITTED_PAIRS: Array<[string, string, string]> = [
  ["toolchain-epoch-2026-09/baseline-receipt.json", "toolchain-epoch-2026-09/candidate-receipt.json", replayInconclusiveResult(BUILDS_2026_09, "1 of 44", "guardian.knownTrackerRequests")],
  ["toolchain-epoch-2026-10/round-1-baseline-receipt.json", "toolchain-epoch-2026-10/round-1-candidate-receipt.json", replayInconclusiveResult(BUILDS_2026_10, "3 of 44", "guardian.knownTrackerRequests, guardian.thirdPartyDomains, guardian.shieldsBlockedRequests")],
  ["toolchain-epoch-2026-10/round-2-baseline-receipt.json", "toolchain-epoch-2026-10/round-2-candidate-receipt.json", replayInconclusiveResult(BUILDS_2026_10, "2 of 44", GUARDIAN_PAIR)],
  ["toolchain-epoch-2026-11/round-1-baseline-receipt.json", "toolchain-epoch-2026-11/round-1-candidate-receipt.json", replayInconclusiveResult(BUILDS_2026_11, "2 of 45", GUARDIAN_PAIR)],
  ["toolchain-epoch-2026-11/round-2-baseline-receipt.json", "toolchain-epoch-2026-11/round-2-candidate-receipt.json", replayInconclusiveResult(BUILDS_2026_11, "2 of 45", GUARDIAN_PAIR)]
];
// The two rounds of the 2026-12 epoch, captured on panel version 2, with the
// sentence each is refused with. Both are refused on capture loss before any
// median is judged, so neither replays to a result line of the kind above.
const BASELINE_2026_12 = "35b8f6a64395dfcaa0850cb5c201edb7ca0481d4";
const CANDIDATE_2026_12 = "d84033671430f4acbc94f0cd4451b87e9c1d1215";
const REFUSED_PAIRS_2026_12: Array<[string, string, string]> = [
  ["toolchain-epoch-2026-12/round-1-baseline-receipt.json", "toolchain-epoch-2026-12/round-1-candidate-receipt.json",
    "Capture loss detector-output/truncated/policy-link-candidates differs systematically between the builds on python: 3 of 3 baseline runs vs 0 of 3 candidate runs."],
  ["toolchain-epoch-2026-12/round-2-baseline-receipt.json", "toolchain-epoch-2026-12/round-2-candidate-receipt.json",
    'Capture loss differs between runs of guardian: ["fingerprinting/dropped/fingerprint-observer"] vs [].']
];
const RECEIPT_SHA256_2026_12: Record<string, string> = {
  "toolchain-epoch-2026-12/round-1-baseline-receipt.json": "6597cf85b0d01773b27724ec36beb00f3ec54fcd3329fcb0ada6bc476e2a4de4",
  "toolchain-epoch-2026-12/round-1-candidate-receipt.json": "34fc94af3ac711917c12884f97da06a6cea58eeb9365f68a6e5f1e9232db5ca7",
  "toolchain-epoch-2026-12/round-2-baseline-receipt.json": "5eb4348e53e50e91dc84e270074c77ef002e84e4ab153acf1226cd989249e20d",
  "toolchain-epoch-2026-12/round-2-candidate-receipt.json": "1112f1020687da49702eb6e3092e24e03c70cbf949ade85f8d17a56c87c557e5"
};
const RECEIPTS_2026_12 = REFUSED_PAIRS_2026_12.flatMap(([baselineFile, candidateFile]) => [baselineFile, candidateFile]);
const EVERY_COMMITTED_RECEIPT = [...COMMITTED_PAIRS.flatMap(([baselineFile, candidateFile]) => [baselineFile, candidateFile]), ...RECEIPTS_2026_12];

test("the replay CLI reads each committed pair on the committed panel it carries, names that panel on its first line, marks its result line as a replay, and exits 2", async () => {
  const h = await helpers;
  const disk = await panelsOnDisk();
  for (const [baselineFile, candidateFile, resultLine] of COMMITTED_PAIRS) {
    const result = compareFiles(path.join("docs", baselineFile), path.join("docs", candidateFile), "replay");
    assert.equal(result.status, 2, `${baselineFile}: ${result.stderr}`);
    const stdout = printed(result.stdout);
    // The first line is the one the library builds for the panel on disk, and
    // whatever the current panel is it names panel version 1 and its file.
    const selection = h.selectComparisonPanel({ replay: true, baseline: committedReceipt(baselineFile), candidate: committedReceipt(candidateFile), ...disk });
    assert.equal(stdout[0], h.replayNotice(selection, disk.current), baselineFile);
    assert.ok(stdout[0].startsWith(`${PANEL_V1_NAMED} `), baselineFile);
    assert.equal(stdout[1], replayed(RULE_LINE), baselineFile);
    assert.equal(printed(result.stderr).at(-1), resultLine, baselineFile);
    // Every line a replay prints is marked, so none can be quoted as a line
    // of a release comparison: the per-metric lines too, which are otherwise
    // the lines the compare command prints.
    assert.ok(stdout.length >= 2 && printed(result.stderr).length >= 2, baselineFile);
    for (const line of [...stdout, ...printed(result.stderr)]) assert.match(line, /^REPLAY /, `${baselineFile}: ${line}`);
  }
  // Two pairs in full: the left-out metric and the noted losses still print,
  // on stdout, between the rule and the result line.
  const full: Array<[number, string[], string[]]> = [
    [0, [RULE_LINE, LEFT_OUT_LINE, GITHUB_NOTED_LINE], [
      inconclusiveLine("guardian.knownTrackerRequests", "baseline runs 27, 30, 30 (spread 3), candidate runs 17, 27, 27 (spread 10), tolerance 9", "30 -> 27")
    ]],
    [2, [
      RULE_LINE,
      LEFT_OUT_LINE,
      GITHUB_NOTED_LINE,
      "NOTED python: detector-output/truncated/policy-link-candidates capture loss on 0 of 3 baseline and 1 of 3 candidate runs; recorded, not compared: its family feeds no canary metric",
      "NOTED guardian: detector-output/dropped/consent-banner capture loss on 1 of 3 baseline and 0 of 3 candidate runs; recorded, not compared: its family feeds no canary metric"
    ], [
      inconclusiveLine("guardian.knownTrackerRequests", "baseline runs 27, 27, 17 (spread 10), candidate runs 34, 29, 27 (spread 7), tolerance 8.1", "27 -> 29"),
      inconclusiveLine("guardian.shieldsBlockedRequests", "baseline runs 72, 71, 47 (spread 25), candidate runs 88, 76, 72 (spread 16), tolerance 21.3", "71 -> 76")
    ]]
  ];
  for (const [index, stdout, stderr] of full) {
    const [baselineFile, candidateFile, resultLine] = COMMITTED_PAIRS[index];
    const result = compareFiles(path.join("docs", baselineFile), path.join("docs", candidateFile), "replay");
    assert.deepEqual(printed(result.stdout).slice(1), stdout.map(replayed), baselineFile);
    assert.deepEqual(printed(result.stderr), [...stderr.map(replayed), resultLine], baselineFile);
  }
});

test("the compare CLI exits 1 on a failed metric: the median FAIL line is unchanged, a failure on separated ranges adds both builds' runs, and neither yields to an inconclusive metric", async () => {
  const failResult = "FAIL Toolchain canary metric tolerances failed.";
  const separatedClause = (gap: number, runs: string) => `; every run of one build differs from every run of the other by more than the tolerance (the nearest two by ${gap}): ${runs}`;
  const steadyFail = `FAIL wikipedia.cookies: median 10 -> 20; delta 10 > 4${separatedClause(10, "baseline runs 10, 10, 10, candidate runs 20, 20, 20")}`;
  const cases: Array<[string, (pair: { baseline: Receipt; candidate: Receipt }) => void, string[]]> = [
    // Steady builds whose ranges are a tolerance apart, no more: the medians
    // alone fail it, on the line the command has always printed.
    ["medians alone", ({ baseline, candidate }) => {
      setCounts(baseline, "wikipedia", "totalRequests", [10, 10, 20]);
      setCounts(candidate, "wikipedia", "totalRequests", [30, 30, 40]);
    }, ["FAIL wikipedia.totalRequests: median 10 -> 30; delta 20 > 10", failResult]],
    ["steady and separated", ({ candidate }) => { setCounts(candidate, "wikipedia", "cookies", [20, 20, 20]); }, [steadyFail, failResult]],
    // The candidate's own runs spread by 21 against a tolerance of 20, and
    // every one of them is 100 or more above every baseline run.
    ["unsteady and separated", ({ baseline, candidate }) => {
      setCounts(baseline, "wikipedia", "totalRequests", [100, 100, 100]);
      setCounts(candidate, "wikipedia", "totalRequests", [200, 200, 221]);
    }, [`FAIL wikipedia.totalRequests: median 100 -> 200; delta 100 > 20${separatedClause(100, "baseline runs 100, 100, 100, candidate runs 200, 200, 221")}`, failResult]]
  ];
  for (const [label, edit, stderr] of cases) {
    const pair = await freshPair();
    edit(pair);
    const result = compareConstructed(pair.baseline, pair.candidate);
    assert.equal(result.status, 1, `${label}: ${result.stderr}`);
    assert.deepEqual(printed(result.stdout), [RULE_LINE], label);
    assert.deepEqual(printed(result.stderr), stderr, label);
  }
  {
    const { baseline, candidate } = await round2026_11("run-2");
    setCounts(candidate, "wikipedia", "cookies", [20, 20, 20]);
    const result = compareConstructed(baseline, candidate);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(printed(result.stdout), [RULE_LINE]);
    assert.deepEqual(printed(result.stderr), [
      steadyFail,
      inconclusiveLine("guardian.knownTrackerRequests", "baseline runs 16, 17, 16 (spread 1), candidate runs 16, 29, 26 (spread 13), tolerance 4.8", "16 -> 26"),
      inconclusiveLine("guardian.shieldsBlockedRequests", "baseline runs 48, 49, 48 (spread 1), candidate runs 48, 68, 71 (spread 23), tolerance 14.399999999999999", "48 -> 68"),
      failResult
    ]);
  }
});

test("a capture-loss or identity failure still refuses the comparison with its own message and exit 1, where a metric would otherwise be inconclusive", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const refusals: Array<[string, (pair: { baseline: Receipt; candidate: Receipt }) => void, string]> = [
    ["metric-feeding capture loss in one build", ({ candidate }) => { withLoss(candidate, "guardian", METRIC_LOSSES[3]); },
      'Capture loss differs between runs of guardian: [] vs ["fingerprinting/dropped/fingerprint-observer"].'],
    ["systematic capture loss that feeds no metric", ({ candidate }) => { onRepetitions(candidate, "guardian", NON_METRIC_LOSSES[1], [1, 2]); },
      "Capture loss consent-verification/dropped/consent-verification differs systematically between the builds on guardian: 0 of 3 baseline runs vs 2 of 3 candidate runs."],
    ["one build in both receipts", ({ baseline, candidate }) => {
      candidate.expectedBuild = baseline.expectedBuild;
      for (const entry of candidate.runs) entry.provenance.buildCommit = baseline.expectedBuild;
    }, "Canary receipts must identify distinct exact builds."],
    ["a receipt for another panel", ({ candidate }) => { candidate.panelDigest = "0".repeat(64); }, "Receipt does not use the committed fixed panel."],
    ["an observed subject that moved", ({ candidate }) => {
      for (const entry of candidate.runs) if (entry.caseId === "guardian") entry.subject.observed.routeShape = "/redirected";
    }, "Observed subject mismatch for guardian:1."]
  ];
  for (const [label, edit, message] of refusals) {
    const pair = await round2026_11("run-2");
    edit(pair);
    assert.throws(() => h.compareReceipts(pair.baseline, pair.candidate, panel, digest), { message }, label);
    const result = compareConstructed(pair.baseline, pair.candidate);
    assert.equal(result.status, 1, label);
    assert.equal(result.stdout, "", label);
    assert.deepEqual(printed(result.stderr), [`FAIL ${message}`], label);
  }
});

test("the playbook names the comparison rule the compare command prints", async () => {
  const h = await helpers;
  const playbook = readFileSync(path.join(process.cwd(), "docs", "toolchain-epoch.md"), "utf8");
  assert.equal(RULE_LINE, `RULE ${h.COMPARISON_RULE}`);
  assert.ok(playbook.includes(`\`${h.COMPARISON_RULE}\``), "docs/toolchain-epoch.md must name the rule its results are judged by");
});

// ---------------------------------------------------------------------------
// Committed panels and the replay path: a receipt is read against the panel
// it was captured with, and a release comparison only on the current panel.
// ---------------------------------------------------------------------------

const PANEL_V1_DIGEST = "86fe39f8e4e75e9a2925c1849006909968b67bc507d2aec6cb688ce9cc22be29";
const PANEL_V1_FILE_SHA256 = "01e2e919e379b86e3ae3773c74575cc795fd13f35583ae397f4c4d03fdf1f915";
const COMMITTED_RECEIPTS = COMMITTED_PAIRS.flatMap(([baselineFile, candidateFile]) => [baselineFile, candidateFile]);

// A panel that could follow version 1: bumble.com in the Guardian's place.
// It stands in for the next panel in these tests and is committed nowhere.
function panelAfterV1(): Panel {
  const next = structuredClone(panel);
  next.panelVersion = 2;
  next.panelId = "monthly-toolchain-canary-v2";
  next.cases[4] = { id: "bumble", catalog: "public/featured-sites.json", domain: "bumble.com", url: "https://bumble.com/" };
  return next;
}

// The committed panels and the current panel as they are once that panel is
// current: version 1 kept in the committed directory beside it.
async function panelsAfterChange() {
  const h = await helpers;
  const next = panelAfterV1();
  const committed = h.readCommittedPanels([
    { name: "monthly-toolchain-canary-v1.json", text: readFileSync(path.join(process.cwd(), PANEL_V1_FILE), "utf8") },
    { name: "monthly-toolchain-canary-v2.json", text: JSON.stringify(next) }
  ]);
  return { next, current: { panel: next, digest: h.panelDigest(next) }, committed };
}

test("panel version 1 is kept byte for byte in the committed directory, every committed receipt of 2026-09 to 2026-11 carries it, and the current panel is a committed panel", async () => {
  const h = await helpers;
  const { current, committed } = await panelsOnDisk();
  assert.equal(h.COMMITTED_PANEL_DIRECTORY, COMMITTED_PANELS.split(path.sep).join("/"));
  assert.equal(createHash("sha256").update(readFileSync(path.join(process.cwd(), PANEL_V1_FILE))).digest("hex"), PANEL_V1_FILE_SHA256);
  const v1 = committed.find((entry) => entry.panel.panelVersion === 1);
  assert.ok(v1);
  assert.equal(v1.digest, PANEL_V1_DIGEST);
  assert.equal(v1.digest, committedPanelDigest(h));
  assert.equal(v1.file, "scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v1.json");
  assert.equal(COMMITTED_RECEIPTS.length, 10);
  for (const file of COMMITTED_RECEIPTS) {
    const receipt = committedReceipt(file);
    assert.equal(receipt.panelDigest, PANEL_V1_DIGEST, file);
    assert.deepEqual(receipt.panel, v1.panel, file);
  }
  // The current panel file is the same bytes as its committed copy, so a
  // receipt captured today stays readable when the current file changes.
  h.assertCurrentPanelCommitted(current, committed);
  assert.deepEqual(
    readFileSync(path.join(process.cwd(), CURRENT_PANEL_FILE)),
    readFileSync(path.join(process.cwd(), COMMITTED_PANELS, `${currentPanel.panelId}.json`))
  );
  const uncommitted = panelAfterV1();
  assert.throws(
    () => h.assertCurrentPanelCommitted({ panel: uncommitted, digest: h.panelDigest(uncommitted) }, committed.filter((entry) => entry.panel.panelVersion === 1)),
    { message: "The current panel monthly-toolchain-canary-v2 is not committed under scripts/fixtures/toolchain-canary-panels. Commit it there as monthly-toolchain-canary-v2.json, so receipts captured on it stay readable after the panel changes." }
  );
});

const PANEL_V2_FILE = path.join(COMMITTED_PANELS, "monthly-toolchain-canary-v2.json");
const PANEL_V2_DIGEST = "51f0ebcb7997559738a8891256a10d25d5783730b1b6238f8d3ec478682df376";
const PANEL_V2_NAMED = `REPLAY on committed panel monthly-toolchain-canary-v2 (version 2, sha256 ${PANEL_V2_DIGEST}, scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json), the panel both receipts carry.`;

test("the receipts committed under docs/toolchain-epoch-* are exactly the fourteen these tests read: ten on panel version 1 and four on panel version 2", async () => {
  const docs = path.join(process.cwd(), "docs");
  const onDisk = readdirSync(docs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("toolchain-epoch-"))
    .flatMap((entry) => readdirSync(path.join(docs, entry.name)).map((name) => `${entry.name}/${name}`))
    .sort();
  assert.deepEqual(onDisk, [...EVERY_COMMITTED_RECEIPT].sort());
  assert.equal(COMMITTED_RECEIPTS.length, 10);
  assert.equal(RECEIPTS_2026_12.length, 4);
  const byPanel = (file: string) => committedReceipt(file).panel.panelId;
  assert.deepEqual([...new Set(COMMITTED_RECEIPTS.map(byPanel))], ["monthly-toolchain-canary-v1"]);
  assert.deepEqual([...new Set(RECEIPTS_2026_12.map(byPanel))], ["monthly-toolchain-canary-v2"]);
});

// The repetitions of one case that carry a capture-loss signature, as the
// comparison names it: family, kind and detail.
function repetitionsWithLoss(receipt: Receipt, caseId: string, signature: string): number[] {
  return receipt.runs
    .filter((entry: Receipt) => entry.caseId === caseId && entry.qualityFacts.captureLoss.some((loss: Loss) => `${loss.family}/${loss.kind}/${loss.detail}` === signature))
    .map((entry: Receipt) => entry.repetition)
    .sort();
}

test("the committed 2026-12 receipts are the bytes their record names, carry panel version 2, and record the two builds, browsers, engines and Playwright pins of that epoch", async () => {
  const h = await helpers;
  const { committed } = await panelsOnDisk();
  const v2 = committed.find((entry) => entry.panel.panelVersion === 2);
  assert.ok(v2);
  assert.equal(v2.digest, PANEL_V2_DIGEST);
  assert.equal(v2.file, "scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json");
  assert.deepEqual(v2.panel.cases.map((entry) => entry.id), ["wikipedia", "github", "python", "ssa-gov", "guardian"]);
  assert.deepEqual(Object.keys(RECEIPT_SHA256_2026_12).sort(), [...RECEIPTS_2026_12].sort());
  const arms: Array<[string, string, string, string, string]> = [
    ["baseline", "forward", BASELINE_2026_12, "156.0.8078.4", "adblock-rust-0.13.3-request-method-v1-playwright-1.64.1+"],
    ["candidate", "reverse", CANDIDATE_2026_12, "158.0.8127.18", "adblock-rust-0.13.5-request-method-v1-playwright-1.65.0+"]
  ];
  const sharedIdentity = new Set<string>();
  for (const file of RECEIPTS_2026_12) {
    assert.equal(createHash("sha256").update(readFileSync(path.join(process.cwd(), "docs", file))).digest("hex"), RECEIPT_SHA256_2026_12[file], file);
    const receipt = committedReceipt(file);
    const arm = arms.find(([name]) => file.includes(`-${name}-`));
    assert.ok(arm, file);
    const [, order, build, browser, methodology] = arm;
    assert.equal(receipt.panelDigest, PANEL_V2_DIGEST, file);
    assert.deepEqual(receipt.panel, v2.panel, file);
    assert.equal(receipt.order, order, file);
    assert.equal(receipt.expectedBuild, build, file);
    assert.equal(receipt.runs.length, 15, file);
    assert.match(receipt.createdAt, /^2026-11-12T0[03]:/, file);
    for (const entry of receipt.runs as Receipt[]) {
      const label = `${file} ${entry.caseId}:${entry.repetition}`;
      assert.equal(entry.provenance.buildCommit, build, label);
      assert.equal(entry.conditions.browser.version, browser, label);
      assert.ok(entry.provenance.methodologyVersion.includes(methodology), label);
      assert.equal(entry.toolchain.adblock.engineVersion, methodology.slice(0, "adblock-rust-0.13.3".length), label);
      assert.equal(entry.conditions.egress.region, "WNAM/lax08/US", label);
      assert.equal(entry.quality.run.outcome, "complete", label);
      assert.equal(entry.qualityFacts.status, 200, label);
      sharedIdentity.add(h.stableCompareJson([entry.provenance.detectorRegistry, entry.toolchain.normalizationVersion, entry.toolchain.trackerCatalog, entry.toolchain.adblock.manifestDigest]));
    }
  }
  // What the epoch does not move is one value over all 60 runs: the detector
  // registry, the normalization, the tracker catalog and the list manifest.
  assert.equal(sharedIdentity.size, 1);
  assert.match([...sharedIdentity][0], /"version":"node-detectors-v24"/);
  assert.match([...sharedIdentity][0], /tldts@7\.4\.16/);
});

test("both rounds of the committed 2026-12 receipts are refused on capture loss before any median is judged: by the library, by a replay, and by a release comparison in a tree whose current panel is version 2", async () => {
  const h = await helpers;
  const disk = await panelsOnDisk();
  const v2Text = readFileSync(path.join(process.cwd(), PANEL_V2_FILE), "utf8");
  const tree = canaryTree(v2Text, [
    { name: "monthly-toolchain-canary-v1.json", text: readFileSync(path.join(process.cwd(), PANEL_V1_FILE), "utf8") },
    { name: "monthly-toolchain-canary-v2.json", text: v2Text }
  ]);
  try {
    for (const [baselineFile, candidateFile, message] of REFUSED_PAIRS_2026_12) {
      const baseline = committedReceipt(baselineFile);
      const candidate = committedReceipt(candidateFile);
      const selection = h.selectComparisonPanel({ replay: true, baseline, candidate, ...disk });
      assert.equal(selection.file, "scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json", baselineFile);
      assert.equal(selection.digest, PANEL_V2_DIGEST, baselineFile);
      assert.throws(() => h.compareReceipts(baseline, candidate, selection.panel, selection.digest), { message }, baselineFile);
      const files: [string, string] = [path.join("docs", baselineFile), path.join("docs", candidateFile)];
      // The release comparison: one FAIL line, no RULE line, exit 1.
      const release = compareFiles(...files, "compare", tree);
      assert.equal(release.status, 1, baselineFile);
      assert.equal(release.stdout, "", baselineFile);
      assert.deepEqual(printed(release.stderr), [`FAIL ${message}`], baselineFile);
      // The replay, from the repository whatever its current panel is: the
      // same refusal, marked, after the line that names panel version 2.
      const again = compareFiles(...files, "replay");
      assert.equal(again.status, 1, baselineFile);
      const stdout = printed(again.stdout);
      assert.equal(stdout.length, 1, baselineFile);
      assert.ok(stdout[0].startsWith(`${PANEL_V2_NAMED} `), baselineFile);
      assert.deepEqual(printed(again.stderr), [`REPLAY FAIL ${message}`], baselineFile);
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  // The runs behind each sentence, and behind what the record says beside it.
  const [round1Baseline, round1Candidate, round2Baseline, round2Candidate] = RECEIPTS_2026_12.map(committedReceipt);
  const linkSearch = "detector-output/truncated/policy-link-candidates";
  const observer = "fingerprinting/dropped/fingerprint-observer";
  // Round 1: python's link search is truncated on every baseline run and on
  // no candidate run. Round 2: on no python run of either build.
  assert.deepEqual([round1Baseline, round1Candidate, round2Baseline, round2Candidate].map((receipt) => repetitionsWithLoss(receipt, "python", linkSearch)), [[1, 2, 3], [], [], []]);
  // Round 2: the fingerprint observer is dropped on guardian's first
  // repetition in each build and on no other run. Round 1 holds the same
  // loss on one candidate run, which its comparison did not reach.
  assert.deepEqual([round1Baseline, round1Candidate, round2Baseline, round2Candidate].map((receipt) => repetitionsWithLoss(receipt, "guardian", observer)), [[], [3], [1], [1]]);
  for (const receipt of [round1Baseline, round1Candidate, round2Baseline, round2Candidate]) {
    const elsewhere = (receipt.runs as Receipt[]).filter((entry) => entry.caseId !== "guardian" && entry.qualityFacts.captureLoss.some((loss: Loss) => h.METRIC_FEEDING_FAMILIES.includes(loss.family)));
    assert.deepEqual(elsewhere, []);
  }
});

test("the 2026-12 record quotes each round's command and the one FAIL line it prints, names both builds and each receipt's sha256, records both rounds as FAIL under the owner's exception, and quotes no other result line", () => {
  const record = readFileSync(path.join(process.cwd(), "docs", "toolchain-epoch-2026-12.md"), "utf8");
  for (const [index, [baselineFile, candidateFile, message]] of REFUSED_PAIRS_2026_12.entries()) {
    const round = `round ${index + 1}`;
    assert.ok(record.includes(`### Round ${index + 1}: FAIL\n`), round);
    // The command as a reader runs it, and the line it prints.
    assert.ok(record.includes(`npm run toolchain:canary -- compare \\\n  --baseline docs/${baselineFile} \\\n  --candidate docs/${candidateFile}\n`), round);
    assert.ok(record.includes(`\`\`\`text\nFAIL ${message}\n\`\`\`\n`), round);
    for (const file of [baselineFile, candidateFile]) {
      assert.ok(record.includes(`\`${path.basename(file)}\``), file);
      assert.ok(record.includes(`\`${RECEIPT_SHA256_2026_12[file]}\``), file);
    }
  }
  assert.ok(record.includes(`\`${BASELINE_2026_12}\``));
  assert.ok(record.includes(`\`${CANDIDATE_2026_12}\``));
  assert.ok(record.includes(PANEL_V2_DIGEST));
  // The only lines of a comparison the record quotes are the two refusals:
  // no RULE line, because no median was judged, and no result of any other
  // kind, from a comparison or from a replay.
  const quoted = record.split("\n").filter((line) => /^(?:REPLAY )?(?:PASS|FAIL|INCONCLUSIVE|RULE|NOTED|LEFT OUT)\b/.test(line));
  assert.deepEqual(quoted, REFUSED_PAIRS_2026_12.map(([, , message]) => `FAIL ${message}`));
  assert.doesNotMatch(record, /\bPASS\b/);
  // The decision in the owner's words, and what it does not establish.
  for (const sentence of [
    "Both rounds stay FAIL.",
    '"Release the browser update under a recorded exception, as in November?"',
    '"yes to both, go with your recommendations"',
    "The A/B did not pass.",
    "By the playbook the epoch is not complete.",
    "It is not established that the two browsers measure alike.",
    "The exception says nothing about any commit after the staged candidate.",
    "The exception says nothing about the image main CI builds."
  ]) assert.ok(record.includes(sentence), `docs/toolchain-epoch-2026-12.md must state: ${sentence}`);
});

test("the committed panel directory refuses an empty set, a file that is no panel, a misnamed file and a repeated version", async () => {
  const h = await helpers;
  const v1 = { name: "monthly-toolchain-canary-v1.json", text: JSON.stringify(panel) };
  const next = panelAfterV1();
  const v2 = { name: "monthly-toolchain-canary-v2.json", text: JSON.stringify(next) };
  const read = h.readCommittedPanels([v2, v1]);
  assert.deepEqual(read.map((entry) => [entry.panel.panelId, entry.digest, entry.file]), [
    ["monthly-toolchain-canary-v1", PANEL_V1_DIGEST, "scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v1.json"],
    ["monthly-toolchain-canary-v2", h.panelDigest(next), "scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json"]
  ]);
  const refusals: Array<[string, unknown, RegExp]> = [
    ["no file", [], /holds no committed panel/],
    ["not a list", undefined, /holds no committed panel/],
    ["not JSON", [v1, { name: "monthly-toolchain-canary-v2.json", text: "{" }], /monthly-toolchain-canary-v2\.json is not JSON/],
    ["not a panel", [v1, { name: "monthly-toolchain-canary-v2.json", text: "{}" }], /monthly-toolchain-canary-v2\.json is not a committed panel: Invalid toolchain canary panel\. /],
    ["four cases", [{ name: v1.name, text: JSON.stringify({ ...panel, cases: panel.cases.slice(0, 4) }) }], /monthly-toolchain-canary-v1\.json is not a committed panel: The toolchain canary panel must contain exactly five sites\. /],
    ["named for another panel", [{ name: "panel.json", text: v1.text }], /panel\.json must be named for its panelId/],
    ["a version twice", [v1, { name: "monthly-toolchain-canary-v1b.json", text: JSON.stringify({ ...next, panelVersion: 1, panelId: "monthly-toolchain-canary-v1b" }) }], /repeats the version of another committed panel/],
    ["the same file twice", [v1, { name: "monthly-toolchain-canary-v1.json", text: v1.text }], /repeats the version of another committed panel/],
    ["an entry with no text", [{ name: v1.name }], /has an unreadable entry/]
  ];
  for (const [label, files, message] of refusals) assert.throws(() => h.readCommittedPanels(files), message, label);
});

test("a release comparison runs on the current panel only: it refuses a receipt of another committed panel and names the replay command", async () => {
  const h = await helpers;
  const { next, current, committed } = await panelsAfterChange();
  const oldBaseline = committedReceipt("toolchain-epoch-2026-10/round-1-baseline-receipt.json");
  const oldCandidate = committedReceipt("toolchain-epoch-2026-10/round-1-candidate-receipt.json");
  const refusal = OTHER_PANEL_REFUSAL;
  assert.throws(() => h.selectComparisonPanel({ replay: false, baseline: oldBaseline, candidate: oldCandidate, current, committed }), { message: refusal("baseline") });
  // One old receipt beside one on the current panel is refused as well.
  const newBaseline = await receipt("forward", "a".repeat(40), "149.0", 10, BASELINE_VERSIONS, next);
  const newCandidate = await receipt("reverse", "b".repeat(40), "150.0", 11, CANDIDATE_VERSIONS, next);
  assert.throws(() => h.selectComparisonPanel({ replay: false, baseline: newBaseline, candidate: oldCandidate, current, committed }), { message: refusal("candidate") });
  assert.throws(() => h.selectComparisonPanel({ replay: false, baseline: oldBaseline, candidate: newCandidate, current, committed }), { message: refusal("baseline") });
  // Two receipts on the current panel are compared on it.
  const release = h.selectComparisonPanel({ replay: false, baseline: newBaseline, candidate: newCandidate, current, committed });
  assert.deepEqual(release, { replay: false, panel: next, digest: current.digest });
  assert.equal(h.compareReceipts(newBaseline, newCandidate, release.panel, release.digest).outcome, "pass");
  // A receipt whose panel is no committed panel gets the current panel and
  // the refusal the comparison has always given.
  const strayCandidate = structuredClone(newCandidate);
  strayCandidate.panelDigest = "0".repeat(64);
  const stray = h.selectComparisonPanel({ replay: false, baseline: newBaseline, candidate: strayCandidate, current, committed });
  assert.equal(stray.digest, current.digest);
  assert.throws(() => h.compareReceipts(newBaseline, strayCandidate, stray.panel, stray.digest), { message: "Receipt does not use the committed fixed panel." });
  // While version 1 is the current panel, its receipts are a release comparison.
  const today = { panel, digest: PANEL_V1_DIGEST };
  assert.deepEqual(h.selectComparisonPanel({ replay: false, baseline: oldBaseline, candidate: oldCandidate, current: today, committed }), { replay: false, panel, digest: PANEL_V1_DIGEST });
});

test("a replay runs on the committed panel both receipts carry, says whether that is the current panel, and refuses receipts of any other panel", async () => {
  const h = await helpers;
  const { next, current, committed } = await panelsAfterChange();
  const oldBaseline = committedReceipt("toolchain-epoch-2026-10/round-1-baseline-receipt.json");
  const oldCandidate = committedReceipt("toolchain-epoch-2026-10/round-1-candidate-receipt.json");
  const selection = h.selectComparisonPanel({ replay: true, baseline: oldBaseline, candidate: oldCandidate, current, committed });
  assert.deepEqual(selection, { replay: true, panel, digest: PANEL_V1_DIGEST, file: "scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v1.json", current: false });
  assert.equal(h.compareReceipts(oldBaseline, oldCandidate, selection.panel, selection.digest).outcome, "inconclusive");
  assert.equal(
    h.replayNotice(selection, current),
    `${PANEL_V1_NAMED} It is not the current panel, which is monthly-toolchain-canary-v2 (version 2). A replay is not a release comparison: that is the compare command, on the current panel.`
  );
  // While version 1 is still the current panel the replay says that instead.
  const today = { panel, digest: PANEL_V1_DIGEST };
  const sameAsCurrent = h.selectComparisonPanel({ replay: true, baseline: oldBaseline, candidate: oldCandidate, current: today, committed });
  assert.equal(sameAsCurrent.current, true);
  assert.equal(h.replayNotice(sameAsCurrent, today), `${PANEL_V1_NAMED} It is also the current panel. A replay is not a release comparison: that is the compare command.`);
  assert.throws(() => h.replayNotice(h.selectComparisonPanel({ replay: false, baseline: oldBaseline, candidate: oldCandidate, current: today, committed }), today), /Only a replay prints a replay notice/);

  const refused = { message: "The replay command reads two receipts that both carry the same committed panel from scripts/fixtures/toolchain-canary-panels. One of these carries another panel, or the two carry different ones." };
  const newCandidate = await receipt("reverse", "b".repeat(40), "150.0", 11, CANDIDATE_VERSIONS, next);
  const edits: Array<[string, (pair: { baseline: Receipt; candidate: Receipt }) => void]> = [
    ["a baseline digest that names no committed panel", ({ baseline }) => { baseline.panelDigest = "0".repeat(64); }],
    ["a candidate digest that names no committed panel", ({ candidate }) => { candidate.panelDigest = "0".repeat(64); }],
    ["two different committed panels", (pair) => { pair.candidate = newCandidate; }],
    ["a committed digest over another baseline panel", ({ baseline }) => { baseline.panel.repetitions = 5; }],
    ["a committed digest over another candidate panel", ({ candidate }) => { candidate.panel.cases[0].url = "https://example.org/"; }],
    ["a baseline with no panel", ({ baseline }) => { delete baseline.panel; }],
    ["no candidate", (pair) => { pair.candidate = null as unknown as Receipt; }],
    ["no baseline", (pair) => { pair.baseline = undefined as unknown as Receipt; }]
  ];
  for (const [label, edit] of edits) {
    const pair = { baseline: structuredClone(oldBaseline), candidate: structuredClone(oldCandidate) };
    edit(pair);
    assert.throws(() => h.selectComparisonPanel({ replay: true, ...pair, current, committed }), refused, label);
  }
});

// A copy of the canary command in a tree of its own. The command finds its
// panels beside itself, so the tree decides which panel is current.
function canaryTree(currentText: string, committedFiles: Array<{ name: string; text: string }>) {
  // The command resolves its own location through any symbolic link, so the
  // tree is named by its real path.
  const tree = realpathSync(mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-tree-")));
  const place = (relative: string, text: string) => {
    mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
    writeFileSync(path.join(tree, relative), text);
  };
  for (const relative of [
    "scripts/toolchain-canary.mjs",
    "scripts/toolchain-canary-lib.mjs",
    "scripts/scan-admission.mjs",
    "scripts/http-response.mjs",
    "lib/strict-json.ts",
    "public/featured-sites.json",
    "public/corpus-seed-sites.json"
  ]) {
    mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
    copyFileSync(path.join(process.cwd(), relative), path.join(tree, relative));
  }
  symlinkSync(path.join(process.cwd(), "node_modules"), path.join(tree, "node_modules"), "dir");
  place(CURRENT_PANEL_FILE, currentText);
  for (const file of committedFiles) place(path.join(COMMITTED_PANELS, file.name), file.text);
  return tree;
}

test("once the current panel has moved on, the compare CLI refuses the committed receipts with exit 1 and the replay CLI still reads them, on a panel it says is not the current one", async () => {
  const h = await helpers;
  const next = panelAfterV1();
  const v1Text = readFileSync(path.join(process.cwd(), PANEL_V1_FILE), "utf8");
  const tree = canaryTree(JSON.stringify(next), [
    { name: "monthly-toolchain-canary-v1.json", text: v1Text },
    { name: "monthly-toolchain-canary-v2.json", text: JSON.stringify(next) }
  ]);
  try {
    for (const [baselineFile, candidateFile, resultLine] of COMMITTED_PAIRS) {
      const files: [string, string] = [path.join("docs", baselineFile), path.join("docs", candidateFile)];
      const release = compareFiles(...files, "compare", tree);
      assert.equal(release.status, 1, baselineFile);
      assert.equal(release.stdout, "", baselineFile);
      assert.deepEqual(printed(release.stderr), [`FAIL ${OTHER_PANEL_REFUSAL("baseline")}`], baselineFile);
      const again = compareFiles(...files, "replay", tree);
      assert.equal(again.status, 2, `${baselineFile}: ${again.stderr}`);
      assert.equal(
        printed(again.stdout)[0],
        `${PANEL_V1_NAMED} It is not the current panel, which is monthly-toolchain-canary-v2 (version 2). A replay is not a release comparison: that is the compare command, on the current panel.`,
        baselineFile
      );
      assert.equal(printed(again.stdout)[1], replayed(RULE_LINE), baselineFile);
      assert.equal(printed(again.stderr).at(-1), resultLine, baselineFile);
    }
    // The release comparison on the new panel is the compare command, and its
    // result line carries no replay mark.
    const baseline = await receipt("forward", "a".repeat(40), "149.0", 10, BASELINE_VERSIONS, next);
    const candidate = await receipt("reverse", "b".repeat(40), "150.0", 11, CANDIDATE_VERSIONS, next);
    const release = compareConstructed(baseline, candidate, "compare", tree);
    assert.equal(release.status, 0, release.stderr);
    assert.deepEqual(printed(release.stdout), [RULE_LINE, `PASS ${CONSTRUCTED_BUILDS}: all 45 compared fixed-panel medians are within tolerance.`]);
    // A replay of the same pair says it is one, on every result it can give.
    const passed = compareConstructed(baseline, candidate, "replay", tree);
    assert.equal(passed.status, 0, passed.stderr);
    assert.deepEqual(printed(passed.stdout), [
      `REPLAY on committed panel monthly-toolchain-canary-v2 (version 2, sha256 ${h.panelDigest(next)}, scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json), the panel both receipts carry. It is also the current panel. A replay is not a release comparison: that is the compare command.`,
      replayed(RULE_LINE),
      `REPLAY PASS ${CONSTRUCTED_BUILDS}: all 45 compared fixed-panel medians are within tolerance. ${REPLAY_TAIL}`
    ]);
    const failing = structuredClone(candidate);
    for (const entry of failing.runs) if (entry.caseId === "bumble") entry.counts.cookies = 40;
    const failed = compareConstructed(baseline, failing, "replay", tree);
    assert.equal(failed.status, 1, failed.stderr);
    assert.deepEqual(printed(failed.stderr), [
      "REPLAY FAIL bumble.cookies: median 10 -> 40; delta 30 > 4; every run of one build differs from every run of the other by more than the tolerance (the nearest two by 30): baseline runs 10, 10, 10, candidate runs 40, 40, 40",
      `REPLAY FAIL ${CONSTRUCTED_BUILDS}: 1 of 45 compared fixed-panel medians failed. ${REPLAY_TAIL}`
    ]);
    // The same pair under compare fails with the lines a release reads, unmarked.
    const releaseFailed = compareConstructed(baseline, failing, "compare", tree);
    assert.equal(releaseFailed.status, 1, releaseFailed.stderr);
    assert.deepEqual(printed(releaseFailed.stderr), [
      "FAIL bumble.cookies: median 10 -> 40; delta 30 > 4; every run of one build differs from every run of the other by more than the tolerance (the nearest two by 30): baseline runs 10, 10, 10, candidate runs 40, 40, 40",
      "FAIL Toolchain canary metric tolerances failed."
    ]);
    // A replay that is inconclusive, with a loss left out and a loss noted, marks those lines too.
    const unsteady = structuredClone(candidate);
    for (const entry of unsteady.runs) if (entry.caseId === "bumble") entry.counts.cookies = [11, 11, 30][entry.repetition - 1];
    for (const target of [baseline, unsteady]) {
      withLoss(target, "bumble", METRIC_LOSSES[3]);
      withLoss(target, "github", { family: "detector-output", kind: "truncated", detail: "keystroke-probe-capture", count: 1, phaseId: 1 });
    }
    const inconclusive = compareConstructed(baseline, unsteady, "replay", tree);
    assert.equal(inconclusive.status, 2, inconclusive.stderr);
    assert.deepEqual(printed(inconclusive.stdout).slice(1), [
      replayed(RULE_LINE),
      "REPLAY LEFT OUT bumble.fingerprintEvents: every run of both builds records fingerprinting capture loss",
      replayed(GITHUB_NOTED_LINE)
    ]);
    assert.deepEqual(printed(inconclusive.stderr), [
      "REPLAY INCONCLUSIVE bumble.cookies: baseline runs 10, 10, 10 (spread 0), candidate runs 11, 11, 30 (spread 19), tolerance 4; the page varied within one build by more than the tolerance, so medians 10 -> 11 say nothing about the toolchain for this metric",
      `REPLAY INCONCLUSIVE ${CONSTRUCTED_BUILDS}: not a pass. No compared fixed-panel median failed, but for 1 of 44 ${VARIED}, so the comparison says nothing about the toolchain for bumble.cookies. ${REPLAY_TAIL}`
    ]);
    // A pair on no committed panel is refused by the replay as well.
    const stray = structuredClone(candidate);
    stray.panelDigest = "0".repeat(64);
    const refused = compareConstructed(baseline, stray, "replay", tree);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, "");
    assert.deepEqual(printed(refused.stderr), ["REPLAY FAIL The replay command reads two receipts that both carry the same committed panel from scripts/fixtures/toolchain-canary-panels. One of these carries another panel, or the two carry different ones."]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("no canary command runs on a current panel that is not also a committed panel", async () => {
  const next = panelAfterV1();
  const tree = canaryTree(JSON.stringify(next), [{ name: "monthly-toolchain-canary-v1.json", text: readFileSync(path.join(process.cwd(), PANEL_V1_FILE), "utf8") }]);
  try {
    const message = "FAIL The current panel monthly-toolchain-canary-v2 is not committed under scripts/fixtures/toolchain-canary-panels. Commit it there as monthly-toolchain-canary-v2.json, so receipts captured on it stay readable after the panel changes.";
    const [baselineFile, candidateFile] = COMMITTED_PAIRS[0];
    for (const verb of ["compare", "replay"] as const) {
      const result = compareFiles(path.join("docs", baselineFile), path.join("docs", candidateFile), verb, tree);
      assert.equal(result.status, 1, verb);
      assert.equal(result.stdout, "", verb);
      assert.deepEqual(printed(result.stderr), [verb === "replay" ? replayed(message) : message], verb);
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("a file in the committed panel directory that is not a panel stops every command, by name and with what to do", async () => {
  const h = await helpers;
  const v1Text = readFileSync(path.join(process.cwd(), PANEL_V1_FILE), "utf8");
  const directory = "scripts/fixtures/toolchain-canary-panels";
  const nothingElse = `${directory} holds committed panel files and nothing else, and no canary command runs while it holds anything it cannot read.`;
  // [the stray file, the refusal]: a file that is not JSON, and one that is JSON and no panel.
  const strays: Array<[{ name: string; text: string }, string]> = [
    [{ name: ".DS_Store", text: "\u0000\u0000\u0000\u0001Bud1" }, `${directory}/.DS_Store is not JSON. Remove it: ${nothingElse}`],
    [{ name: "notes.json", text: "{}" }, `${directory}/notes.json is not a committed panel: Invalid toolchain canary panel. ${nothingElse} Remove the file if it was never a committed panel, and restore it from git if it was.`]
  ];
  for (const [stray, message] of strays) {
    assert.throws(() => h.readCommittedPanels([{ name: "monthly-toolchain-canary-v1.json", text: v1Text }, stray]), { message });
    const tree = canaryTree(v1Text, [{ name: "monthly-toolchain-canary-v1.json", text: v1Text }, stray]);
    try {
      const [baselineFile, candidateFile] = COMMITTED_PAIRS[0];
      for (const verb of ["compare", "replay"] as const) {
        const result = compareFiles(path.join("docs", baselineFile), path.join("docs", candidateFile), verb, tree);
        assert.equal(result.status, 1, verb);
        assert.equal(result.stdout, "", verb);
        assert.deepEqual(printed(result.stderr), [verb === "replay" ? `REPLAY FAIL ${message}` : `FAIL ${message}`], verb);
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
});

test("a replay that is refused for its options says so on a marked line, and a release comparison on an unmarked one", () => {
  const [baselineFile] = COMMITTED_PAIRS[0];
  const baseline = path.join("docs", baselineFile);
  // [what is wrong, the options, the refusal]
  const refusals: Array<[string, string[], string]> = [
    ["an option the command does not take", ["--bogus", "x"], "Invalid or duplicate option --bogus."],
    ["an option given twice", ["--baseline", baseline, "--baseline", baseline], "Invalid or duplicate option --baseline."],
    ["an option with no value", ["--baseline"], "Invalid or duplicate option --baseline."],
    ["no candidate", ["--baseline", baseline], "Missing --candidate."],
    ["no option at all", [], "Missing --baseline."]
  ];
  for (const [label, options, message] of refusals) {
    for (const verb of ["compare", "replay"] as const) {
      const result = spawnSync(process.execPath, ["--no-warnings", path.join(process.cwd(), "scripts", "toolchain-canary.mjs"), verb, ...options], { cwd: process.cwd(), encoding: "utf8" });
      assert.equal(result.status, 1, `${verb}: ${label}`);
      assert.equal(result.stdout, "", `${verb}: ${label}`);
      assert.deepEqual(printed(result.stderr), [verb === "replay" ? `REPLAY FAIL ${message}` : `FAIL ${message}`], `${verb}: ${label}`);
    }
  }
});
