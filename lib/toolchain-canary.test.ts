import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
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
type Versions = { playwright: string | null; adblock: string; tldts: string };

const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Helpers>;
const helpers = nativeImport(pathToFileURL(path.join(process.cwd(), "scripts", "toolchain-canary-lib.mjs")).href);
const panel = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "fixtures", "toolchain-canary-panel.json"), "utf8")) as Panel;

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
    reportWireSha256: "d".repeat(64), runId: `${caseId}-${repetition}`, startedAt: "2026-07-19T00:00:00.000Z",
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
  versions: Versions = { playwright: "1.61.0", adblock: "0.13.0", tldts: "7.4.3" }
) {
  const h = await helpers;
  const ordered = order === "forward" ? panel.cases : [...panel.cases].reverse();
  const runs = [];
  let sequence = 0;
  for (const entry of ordered) {
    for (let repetition = 1; repetition <= panel.repetitions; repetition += 1) {
      runs.push(run(entry.id, repetition, ++sequence, build, browser, count, versions));
    }
  }
  const digest = createHash("sha256").update(h.stableCompareJson(panel)).digest("hex");
  return h.buildReceipt({ createdAt: "2026-07-19T00:00:00.000Z", expectedBuild: build, order, panel, panelDigest: digest, runs });
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
  h.assertPanel(panel);
  const catalogs = {
    "public/featured-sites.json": JSON.parse(readFileSync(path.join(process.cwd(), "public", "featured-sites.json"), "utf8")),
    "public/corpus-seed-sites.json": JSON.parse(readFileSync(path.join(process.cwd(), "public", "corpus-seed-sites.json"), "utf8"))
  };
  h.assertPanelCatalogMembership(panel, catalogs);
  const changed = structuredClone(panel);
  changed.cases[0].url = "https://not-in-catalog.example/";
  assert.throws(() => h.assertPanelCatalogMembership(changed, catalogs), /not pinned exactly/);
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

function committedReceipt(file: string): Receipt {
  return JSON.parse(readFileSync(path.join(process.cwd(), "docs", file), "utf8")) as Receipt;
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

// The committed receipts are real inputs to the two tests below. What the
// comparison rule computes from them is a property of the rule. It is not a
// judgement of the epochs they record, which stand as recorded under the rule
// that ran.
test("the committed 2026-09 receipts compare with the medians their record states, and the within-arm spread rule leaves guardian's known-tracker count inconclusive", async () => {
  const h = await helpers;
  const result = h.compareReceipts(
    committedReceipt("toolchain-epoch-2026-09/baseline-receipt.json"),
    committedReceipt("toolchain-epoch-2026-09/candidate-receipt.json"),
    panel,
    committedPanelDigest(h)
  );
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
  const digest = committedPanelDigest(h);
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
    const result = h.compareReceipts(
      committedReceipt(`toolchain-epoch-2026-10/${round}-baseline-receipt.json`),
      committedReceipt(`toolchain-epoch-2026-10/${round}-candidate-receipt.json`),
      panel,
      digest
    );
    assert.equal(result.outcome, "inconclusive", round);
    assert.equal(result.pass, false, round);
    assert.equal(result.baselineBuild, "f9d6c46e744c60a3485eba3951f0b168b9170941", round);
    assert.equal(result.candidateBuild, "34d6847b54d804c449bed160a53129ca2e1f16ef", round);
    assert.equal(result.results.length, 44, round);
    assert.deepEqual(notPassed(h, result), unresolved, round);
    assert.deepEqual(result.excluded, GUARDIAN_FINGERPRINT_LEFT_OUT, round);
    assert.deepEqual(result.noted, noted, round);
    assert.deepEqual(movedMedians(result), moved, round);
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
    assert.equal(result.outcome, outcome, context);
    // Nothing else in the panel moved, so this one metric decides the result.
    assert.deepEqual(notPassed(h, result).map((entry) => entry.slice(0, 3)), outcome === "pass" ? [] : [[site, "totalRequests", outcome]], context);
  }
});

// The guardian page's knownTrackerRequests, shieldsBlockedRequests and
// totalRequests per repetition in the two 2026-11 rounds, whose receipts are
// not committed. The median-only rule failed both rounds, in opposite
// directions, because the two arms drew different numbers of the page's low
// state (about 16 to 19, 47 to 50, 160 to 166).
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
    // The request total spreads too, but inside its wider tolerance, so it is
    // still compared and still passes.
    const totalRequests = rowFor(result, "guardian", "totalRequests");
    assert.deepEqual([totalRequests.baselineSpread, totalRequests.candidateSpread, Number(totalRequests.allowed.toFixed(2)), totalRequests.outcome], [...total, "pass"], round);
  }
});

function compareFiles(baselineFile: string, candidateFile: string) {
  return spawnSync(process.execPath, ["--no-warnings", path.join("scripts", "toolchain-canary.mjs"), "compare", "--baseline", baselineFile, "--candidate", candidateFile], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

function compareConstructed(baseline: Receipt, candidate: Receipt) {
  const directory = mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-"));
  try {
    const baselineFile = path.join(directory, "baseline-receipt.json");
    const candidateFile = path.join(directory, "candidate-receipt.json");
    writeFileSync(baselineFile, JSON.stringify(baseline));
    writeFileSync(candidateFile, JSON.stringify(candidate));
    return compareFiles(baselineFile, candidateFile);
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
  // The committed receipts as real inputs: the left-out metric and the noted
  // losses still print, on stdout, ahead of the result line.
  const committed: Array<[string, string, string[], string[]]> = [
    ["toolchain-epoch-2026-09/baseline-receipt.json", "toolchain-epoch-2026-09/candidate-receipt.json", [
      RULE_LINE,
      LEFT_OUT_LINE,
      GITHUB_NOTED_LINE
    ], [
      inconclusiveLine("guardian.knownTrackerRequests", "baseline runs 27, 30, 30 (spread 3), candidate runs 17, 27, 27 (spread 10), tolerance 9", "30 -> 27"),
      inconclusiveResult("cd43c7bce9a980037a74f7ee2a05b722c2638b17 -> c8b189ac59f50121e6f1777dabe12ba4854f6090", "1 of 44", "guardian.knownTrackerRequests")
    ]],
    ["toolchain-epoch-2026-10/round-2-baseline-receipt.json", "toolchain-epoch-2026-10/round-2-candidate-receipt.json", [
      RULE_LINE,
      LEFT_OUT_LINE,
      GITHUB_NOTED_LINE,
      "NOTED python: detector-output/truncated/policy-link-candidates capture loss on 0 of 3 baseline and 1 of 3 candidate runs; recorded, not compared: its family feeds no canary metric",
      "NOTED guardian: detector-output/dropped/consent-banner capture loss on 1 of 3 baseline and 0 of 3 candidate runs; recorded, not compared: its family feeds no canary metric"
    ], [
      inconclusiveLine("guardian.knownTrackerRequests", "baseline runs 27, 27, 17 (spread 10), candidate runs 34, 29, 27 (spread 7), tolerance 8.1", "27 -> 29"),
      inconclusiveLine("guardian.shieldsBlockedRequests", "baseline runs 72, 71, 47 (spread 25), candidate runs 88, 76, 72 (spread 16), tolerance 21.3", "71 -> 76"),
      inconclusiveResult("f9d6c46e744c60a3485eba3951f0b168b9170941 -> 34d6847b54d804c449bed160a53129ca2e1f16ef", "2 of 44", "guardian.knownTrackerRequests, guardian.shieldsBlockedRequests")
    ]]
  ];
  for (const [baselineFile, candidateFile, stdout, stderr] of committed) {
    const result = compareFiles(path.join("docs", baselineFile), path.join("docs", candidateFile));
    assert.equal(result.status, 2, `${baselineFile}: ${result.stderr}`);
    assert.deepEqual(printed(result.stdout), stdout, baselineFile);
    assert.deepEqual(printed(result.stderr), stderr, baselineFile);
  }
});

test("the compare CLI exits 1 on a failed median, with its FAIL lines unchanged, whether or not another metric is inconclusive", async () => {
  const failLine = "FAIL wikipedia.cookies: median 10 -> 20; delta 10 > 4";
  const failResult = "FAIL Toolchain canary metric tolerances failed.";
  {
    const { baseline, candidate } = await freshPair();
    setCounts(candidate, "wikipedia", "cookies", [20, 20, 20]);
    const result = compareConstructed(baseline, candidate);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(printed(result.stdout), [RULE_LINE]);
    assert.deepEqual(printed(result.stderr), [failLine, failResult]);
  }
  {
    const { baseline, candidate } = await round2026_11("run-2");
    setCounts(candidate, "wikipedia", "cookies", [20, 20, 20]);
    const result = compareConstructed(baseline, candidate);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(printed(result.stdout), [RULE_LINE]);
    assert.deepEqual(printed(result.stderr), [
      failLine,
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
