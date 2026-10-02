import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
};
type Noted = { caseId: string; signature: string; baselineRuns: number; baselineTotal: number; candidateRuns: number; candidateTotal: number };
type Comparison = {
  pass: boolean;
  baselineBuild: string;
  candidateBuild: string;
  results: Array<{ pass: boolean; caseId: string; metric: string; baseline: number; candidate: number; delta: number; allowed: number }>;
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

const GUARDIAN_FINGERPRINT_LEFT_OUT = [{ caseId: "guardian", metric: "fingerprintEvents", family: "fingerprinting" }];
// github's keystroke-probe truncation is on every run of both builds in the
// 2026-09 pair and in both 2026-10 rounds; it is noted, not compared.
const GITHUB_KEYSTROKE_NOTED: Noted = { caseId: "github", signature: "detector-output/truncated/keystroke-probe-capture", baselineRuns: 3, baselineTotal: 3, candidateRuns: 3, candidateTotal: 3 };

test("the committed 2026-09 receipts pass the refined gate with the medians their record states", async () => {
  const h = await helpers;
  const result = h.compareReceipts(
    committedReceipt("toolchain-epoch-2026-09/baseline-receipt.json"),
    committedReceipt("toolchain-epoch-2026-09/candidate-receipt.json"),
    panel,
    committedPanelDigest(h)
  );
  assert.equal(result.pass, true);
  assert.equal(result.baselineBuild, "cd43c7bce9a980037a74f7ee2a05b722c2638b17");
  assert.equal(result.candidateBuild, "c8b189ac59f50121e6f1777dabe12ba4854f6090");
  assert.equal(result.results.length, 44);
  assert.equal(result.results.every((row) => row.pass), true);
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

test("the committed 2026-10 receipts pass the refined gate with github's every-run loss and the sporadic losses their record describes noted", async () => {
  const h = await helpers;
  const digest = committedPanelDigest(h);
  const consentBanner = { caseId: "guardian", signature: "detector-output/dropped/consent-banner", baselineRuns: 1, baselineTotal: 3, candidateRuns: 0, candidateTotal: 3 };
  const rounds: Array<[string, Noted[], Array<Array<string | number>>]> = [
    ["round-1", [GITHUB_KEYSTROKE_NOTED, consentBanner], [
      ["guardian", "totalRequests", 188, 184, 4, 37.6],
      ["guardian", "thirdPartyRequests", 158, 154, 4, 39.5],
      ["guardian", "shieldsBlockedRequests", 70, 71, 1, 21]
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
    ]]
  ];
  for (const [round, noted, moved] of rounds) {
    const result = h.compareReceipts(
      committedReceipt(`toolchain-epoch-2026-10/${round}-baseline-receipt.json`),
      committedReceipt(`toolchain-epoch-2026-10/${round}-candidate-receipt.json`),
      panel,
      digest
    );
    assert.equal(result.pass, true, round);
    assert.equal(result.baselineBuild, "f9d6c46e744c60a3485eba3951f0b168b9170941", round);
    assert.equal(result.candidateBuild, "34d6847b54d804c449bed160a53129ca2e1f16ef", round);
    assert.equal(result.results.length, 44, round);
    assert.equal(result.results.every((row) => row.pass), true, round);
    assert.deepEqual(result.excluded, GUARDIAN_FINGERPRINT_LEFT_OUT, round);
    assert.deepEqual(result.noted, noted, round);
    assert.deepEqual(movedMedians(result), moved, round);
  }
});

test("the compare CLI prints each noted loss as recorded and not compared, before its PASS line", () => {
  const compare = (baselineFile: string, candidateFile: string) =>
    spawnSync(process.execPath, ["--no-warnings", path.join("scripts", "toolchain-canary.mjs"), "compare", "--baseline", path.join("docs", baselineFile), "--candidate", path.join("docs", candidateFile)], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
  const leftOut = "LEFT OUT guardian.fingerprintEvents: every run of both builds records fingerprinting capture loss";
  const githubNoted = "NOTED github: detector-output/truncated/keystroke-probe-capture capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric";
  const cases: Array<[string, string, string[]]> = [
    ["toolchain-epoch-2026-10/round-2-baseline-receipt.json", "toolchain-epoch-2026-10/round-2-candidate-receipt.json", [
      leftOut,
      githubNoted,
      "NOTED python: detector-output/truncated/policy-link-candidates capture loss on 0 of 3 baseline and 1 of 3 candidate runs; recorded, not compared: its family feeds no canary metric",
      "NOTED guardian: detector-output/dropped/consent-banner capture loss on 1 of 3 baseline and 0 of 3 candidate runs; recorded, not compared: its family feeds no canary metric",
      "PASS f9d6c46e744c60a3485eba3951f0b168b9170941 -> 34d6847b54d804c449bed160a53129ca2e1f16ef: all 44 compared fixed-panel medians are within tolerance; 1 left out for shared capture loss; 3 capture-loss signatures noted and not compared."
    ]],
    ["toolchain-epoch-2026-09/baseline-receipt.json", "toolchain-epoch-2026-09/candidate-receipt.json", [
      leftOut,
      githubNoted,
      "PASS cd43c7bce9a980037a74f7ee2a05b722c2638b17 -> c8b189ac59f50121e6f1777dabe12ba4854f6090: all 44 compared fixed-panel medians are within tolerance; 1 left out for shared capture loss; 1 capture-loss signature noted and not compared."
    ]]
  ];
  for (const [baselineFile, candidateFile, expected] of cases) {
    const result = compare(baselineFile, candidateFile);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "", baselineFile);
    assert.deepEqual(result.stdout.trimEnd().split("\n"), expected, baselineFile);
  }
});
