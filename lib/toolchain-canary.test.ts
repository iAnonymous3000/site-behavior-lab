import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

type Helpers = {
  CANARY_ORIGIN: string;
  canonicalJson(value: unknown): string;
  requireCanaryOrigin(value?: string): string;
  requireAccessToken(value: unknown): string;
  requireCommitSha(value: unknown): string;
  assertHealthGate(value: unknown, sha: string): unknown;
  assertPanel(value: unknown): Panel;
  assertPanelCatalogMembership(panel: Panel, catalogs: Record<string, unknown>): void;
  buildReceipt(input: Record<string, unknown>): Receipt;
  compareReceipts(baseline: Receipt, candidate: Receipt, panel: Panel, digest: string): { pass: boolean; results: Array<{ pass: boolean }> };
};
type Panel = { panelVersion: number; panelId: string; repetitions: number; conditions: object; metricTolerances: Record<string, { absolute: number; relative: number }>; cases: Array<{ id: string; catalog: string; domain: string; url: string }> };
type Receipt = Record<string, any>;

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
  versions = { adblock: "0.13.0", tldts: "7.4.3" }
) {
  const engineVersion = `adblock-rust-${versions.adblock}`;
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
      methodologyVersion: `shields-request-context-v2-${engineVersion}-request-method-v1+phase-kernel-v2`,
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
  versions = { adblock: "0.13.0", tldts: "7.4.3" }
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
  const digest = createHash("sha256").update(h.canonicalJson(panel)).digest("hex");
  return h.buildReceipt({ createdAt: "2026-07-19T00:00:00.000Z", expectedBuild: build, order, panel, panelDigest: digest, runs });
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

test("receipt comparison permits only browser, toolchain, and build drift within explicit medians", async () => {
  const h = await helpers;
  const digest = createHash("sha256").update(h.canonicalJson(panel)).digest("hex");
  const baseline = await receipt("forward", "a".repeat(40), "149.0", 10);
  const candidate = await receipt(
    "reverse",
    "b".repeat(40),
    "150.0",
    11,
    { adblock: "0.13.2", tldts: "7.4.9" }
  );
  assert.equal(h.compareReceipts(baseline, candidate, panel, digest).pass, true);

  const wrongRegion = structuredClone(candidate);
  wrongRegion.runs[0].conditions.egress.region = "eu";
  assert.throws(() => h.compareReceipts(baseline, wrongRegion, panel, digest), /mixes run conditions|Egress region/);

  const mixedSubject = structuredClone(candidate);
  mixedSubject.runs[1].subject.observed.routeShape = "/redirected";
  assert.throws(() => h.compareReceipts(baseline, mixedSubject, panel, digest), /mixes requested or observed subjects/);

  const outsideTolerance = await receipt("reverse", "b".repeat(40), "150.0", 100);
  const result = h.compareReceipts(baseline, outsideTolerance, panel, digest);
  assert.equal(result.pass, false);
  assert.equal(result.results.some((entry) => !entry.pass), true);

  const catalogDrift = structuredClone(candidate);
  for (const entry of catalogDrift.runs) entry.toolchain.trackerCatalog.digest = "a".repeat(64);
  assert.throws(() => h.compareReceipts(baseline, catalogDrift, panel, digest), /outside browser, adblock engine, tldts, and build/);

  const listDrift = structuredClone(candidate);
  for (const entry of listDrift.runs) entry.toolchain.adblock.manifestDigest = "b".repeat(64);
  assert.throws(() => h.compareReceipts(baseline, listDrift, panel, digest), /outside browser, adblock engine, tldts, and build/);

  const unrelatedNormalizationDrift = structuredClone(candidate);
  for (const entry of unrelatedNormalizationDrift.runs) entry.toolchain.normalizationVersion += "+redaction-v3";
  assert.throws(() => h.compareReceipts(baseline, unrelatedNormalizationDrift, panel, digest), /outside browser, adblock engine, tldts, and build/);
});
