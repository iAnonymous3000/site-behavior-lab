import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";

// The tests of a panel change: the qualification panel, the qualifying
// capture and its receipt, and the rule that decides the next panel from one
// qualification receipt. No test here contacts staging: a capture runs
// through a scan function the test supplies, and every spawned command has
// fetch replaced, by a function that throws or by a stand-in for staging that
// answers from a plan the test wrote.

type Tolerance = { absolute: number; relative: number };
type Case = { id: string; catalog: string; domain: string; url: string };
type Panel = { panelVersion: number; panelId: string; repetitions: number; conditions: object; metricTolerances: Record<string, Tolerance>; cases: Case[] };
type QualificationPanel = { qualificationPanelVersion: number; qualificationPanelId: string; repetitions: number; conditions: object; metricTolerances: Record<string, Tolerance>; cases: Case[] };
type Loss = { family: string; kind: string; detail?: string; count: number; phaseId: number | null };
type Receipt = Record<string, any>;
type MetricRow = { metric: string; values: number[]; median: number; spread: number; tolerance: number; within: boolean; zeroingFails: boolean };
type JudgedCase = {
  caseId: string;
  domain: string;
  url: string;
  repetitions: number;
  recordedRuns: number;
  completeRuns: number;
  judged: boolean;
  metrics: MetricRow[] | null;
  signal: Array<{ metric: string; median: number; floor: number; met: boolean }> | null;
  refusals: string[];
  qualifies: boolean;
  signalCase: boolean;
};
type Verdict = {
  rule: string;
  ruleDigest: string;
  ruleFixedOn: string;
  build: string;
  scans: number;
  panelScans: number;
  finished: boolean;
  endedEarly: string | null;
  healthAfter: { ok: boolean; reason?: string } | null;
  fromPanelId: string;
  fromPanelVersion: number;
  fromPanelDigest: string;
  cases: JudgedCase[];
  notJudged: string[];
  slots: Array<{ outgoing: string; taker: string | null; considered: Array<{ domain: string; takes: boolean; reasons: string[] }> }>;
  coverage: Array<{ metric: string; through: Array<{ caseId: string; retained: boolean; median?: number; tolerance?: number }> }>;
  signalSites: string[];
  panel: Panel | null;
  panelDigest: string | null;
  panelText: string | null;
};
type Scanned = { noReport: string } | { reportId: string; report: unknown; reportWireSha256: string };
type CommittedPanel = { panel: Panel; digest: string; file: string };
type PanelFile = { name: string; text: string };
type Recorded = { runs: Receipt[]; incompleteRuns: Receipt[] };
type ScanInput = { panelCase: Case; sequence: number; repetition: number };
type Helpers = {
  CANARY_CONFIRMATION: string;
  METRICS: readonly string[];
  METRIC_FEEDING_FAMILIES: readonly string[];
  QUALIFICATION_RECEIPT_KIND: string;
  QUALIFICATION_MAX_SCANS: number;
  GUARDIAN_ONLY_ZEROING_METRICS: readonly string[];
  JOB_FACTS: Readonly<Record<string, string>>;
  QUALIFICATION_RULE: {
    id: string;
    fixedOn: string;
    fromPanelVersion: number;
    qualifies: readonly string[];
    signalMetrics: readonly string[];
    signalMedianFloor: number;
    slots: ReadonlyArray<{ outgoing: string; candidates: readonly string[]; mustCarry: readonly string[] }>;
  };
  panelDigest(panel: unknown): string;
  qualificationRuleDigest(): string;
  qualificationReceiptPath(panel: unknown): string;
  readCommittedPanels(files: unknown): readonly CommittedPanel[];
  assertCommittedPanelLineage(input: { files: PanelFile[]; receipt: unknown; qualificationPanel: unknown }): { state: string; verdict: Verdict | null };
  formatPanel(panel: Panel): string;
  assertPanel(value: unknown): Panel;
  assertPanelCatalogMembership(panel: Panel, catalogs: Record<string, unknown>): void;
  assertQualificationPanel(value: unknown): QualificationPanel;
  assertQualificationPanelCatalogMembership(panel: QualificationPanel, catalogs: Record<string, unknown>): void;
  assertQualificationApplies(qualificationPanel: unknown, currentPanel: unknown): void;
  extractCapturedRun(report: unknown, input: Record<string, unknown>): Record<string, unknown>;
  extractQualificationRun(report: unknown, input: Record<string, unknown>): { complete: boolean; run: Record<string, any> };
  captureQualification(input: {
    panel: QualificationPanel;
    expectedBuild: string;
    scanOne(input: ScanInput): Promise<unknown>;
    log?(line: string): void;
    onProgress?(recorded: Recorded): Promise<void>;
  }): Promise<Recorded & { endedEarly: string | null }>;
  buildQualificationReceipt(input: Record<string, unknown>): Receipt;
  judgeQualification(receipt: unknown, panels: { qualificationPanel: unknown; committedPanels: readonly CommittedPanel[] }): Verdict;
  formatQualificationVerdict(verdict: Verdict): string[];
  compareReceipts(baseline: unknown, candidate: unknown, panel: Panel, digest: string): { outcome: string; results: Array<{ caseId: string; metric: string; outcome: string }> };
  selectComparisonPanel(input: Record<string, unknown>): unknown;
};

const root = process.cwd();
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Helpers>;
const helpers = nativeImport(pathToFileURL(path.join(root, "scripts", "toolchain-canary-lib.mjs")).href);

const CURRENT_PANEL_FILE = path.join("scripts", "fixtures", "toolchain-canary-panel.json");
const PANEL_V1_FILE = path.join("scripts", "fixtures", "toolchain-canary-panels", "monthly-toolchain-canary-v1.json");
const QUALIFICATION_PANEL_FILE = path.join("scripts", "fixtures", "toolchain-canary-qualification-panel.json");
const readJson = <T>(relative: string) => JSON.parse(readFileSync(path.join(root, relative), "utf8")) as T;
// The rule changes panel version 1, so it is judged against the committed
// copy of that panel and these tests hold after the current panel moves on.
const panelV1Text = readFileSync(path.join(root, PANEL_V1_FILE), "utf8");
const panelV1 = JSON.parse(panelV1Text) as Panel;
const qualificationPanel = readJson<QualificationPanel>(QUALIFICATION_PANEL_FILE);
const catalogs = {
  "public/featured-sites.json": readJson<unknown>(path.join("public", "featured-sites.json")),
  "public/corpus-seed-sites.json": readJson<unknown>(path.join("public", "corpus-seed-sites.json"))
};

const BUILD = "c".repeat(40);
// Counts in the range the 2026-11-10 analysis found for each candidate. They
// are test inputs, not measurements.
const PROFILE: Record<string, Record<string, number>> = {
  bumble: { totalRequests: 112, thirdPartyRequests: 80, knownTrackerRequests: 30, thirdPartyDomains: 15, cookies: 28, thirdPartyCookies: 10, storageEntries: 9, fingerprintEvents: 0, shieldsBlockedRequests: 36 },
  "ssa-gov": { totalRequests: 73, thirdPartyRequests: 40, knownTrackerRequests: 11, thirdPartyDomains: 9, cookies: 4, thirdPartyCookies: 0, storageEntries: 1, fingerprintEvents: 0, shieldsBlockedRequests: 16 },
  "who-int": { totalRequests: 122, thirdPartyRequests: 70, knownTrackerRequests: 12, thirdPartyDomains: 16, cookies: 15, thirdPartyCookies: 3, storageEntries: 2, fingerprintEvents: 0, shieldsBlockedRequests: 18 }
};

type RunSpec = {
  counts: Record<string, number>;
  status?: number | null;
  botWall?: boolean;
  settled?: boolean;
  budgets?: string[];
  runOutcome?: { outcome: string; reasons: string[] };
  losses?: Loss[];
  observedRoute?: string;
  // The scan leaves no report: a key of JOB_FACTS.
  noReport?: string;
  build?: string;
  edit?: (report: any) => void;
};
type CaseScript = (repetition: number) => RunSpec;
type Scenario = Record<string, CaseScript>;

// Every repetition of a case with its profile counts, with some metrics
// replaced by one value or by a value per repetition.
function counted(caseId: string, replace: Record<string, number | number[]> = {}): CaseScript {
  return (repetition) => ({
    counts: {
      ...PROFILE[caseId],
      ...Object.fromEntries(Object.entries(replace).map(([metric, value]) => [metric, Array.isArray(value) ? value[repetition - 1] : value]))
    }
  });
}

// The same, with something more on the listed repetitions.
function withOn(script: CaseScript, repetitions: number[], more: Partial<RunSpec>): CaseScript {
  return (repetition) => (repetitions.includes(repetition) ? { ...script(repetition), ...more } : script(repetition));
}

const ALL = [1, 2, 3, 4, 5];
const BLOCKED: Partial<RunSpec> = { status: 403, runOutcome: { outcome: "failed", reasons: ["http-status:403"] } };
const BLOCKED_FACTS = "the document status was 403; the run-level outcome was failed (http-status:403)";
const FINGERPRINT_LOSS: Loss = { family: "fingerprinting", kind: "dropped", detail: "fingerprint-observer", count: 2, phaseId: 0 };
const STORAGE_LOSS: Loss = { family: "storage", kind: "truncated", detail: "storage-snapshot", count: 1, phaseId: 0 };
const KEYSTROKE_LOSS: Loss = { family: "detector-output", kind: "truncated", detail: "keystroke-probe-capture", count: 1, phaseId: 1 };

// One saved report as the staging API returns it: the repository's own
// schema-valid r2 single fixture, made the report of one canary scan.
function savedReport(panelCase: Case, sequence: number, spec: RunSpec) {
  const reportId = `20261110-${sequence.toString(16).padStart(32, "0")}`;
  const origin = new URL(panelCase.url).origin;
  const report = makePublicSingleReportV2R2() as any;
  report.share = { id: reportId, path: `/reports/${reportId}`, jsonPath: `/api/reports/${reportId}` };
  report.run.runId = `${panelCase.id}-${sequence}`;
  report.run.subject = {
    requested: { origin, registrableDomain: panelCase.domain, routeShape: "/" },
    observed: { origin, registrableDomain: panelCase.domain, routeShape: spec.observedRoute ?? "/" }
  };
  report.run.conditions.probes = { keystroke: true, policyVisit: true };
  report.run.conditions.egress = { label: "cloudflare-containers", region: "sjc11" };
  report.run.provenance.acquisition = "public-api";
  report.run.provenance.buildCommit = spec.build ?? BUILD;
  report.run.qualityFacts = {
    status: spec.status === undefined ? 200 : spec.status,
    botWallTitleMatched: spec.botWall ?? false,
    navigationSettled: spec.settled ?? true,
    budgetsExhausted: spec.budgets ?? [],
    captureLoss: structuredClone(spec.losses ?? [])
  };
  if (spec.runOutcome) report.run.quality.run = structuredClone(spec.runOutcome);
  for (const loss of spec.losses ?? []) {
    const family = report.run.quality.byFamily[loss.family];
    report.run.quality.byFamily[loss.family] = { outcome: "censored", reasons: [...new Set([...family.reasons, `capture-loss:${loss.kind}`])] };
  }
  report.run.summary.counts = { ...spec.counts };
  spec.edit?.(report);
  return { reportId, report, reportWireSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") };
}

function scanWith(scenario: Scenario) {
  return async ({ panelCase, sequence, repetition }: ScanInput): Promise<Scanned> => {
    const spec = (scenario[panelCase.id] ?? counted(panelCase.id))(repetition);
    return spec.noReport ? { noReport: spec.noReport } : savedReport(panelCase, sequence, spec);
  };
}

const CREATED_AT = "2026-11-10T12:00:00.000Z";
const V1_FILE: PanelFile = { name: "monthly-toolchain-canary-v1.json", text: panelV1Text };

// A qualification receipt as the qualify command builds one, from a capture
// whose scans the scenario scripts. A case the scenario leaves out is steady
// at its profile counts. A capture that ran to its last scan is finished with
// a passing health read, and one that a scan ended is not.
async function qualificationReceipt(scenario: Scenario = {}, onPanel: QualificationPanel = qualificationPanel, fromPanel: Panel = panelV1): Promise<Receipt> {
  const h = await helpers;
  const { runs, incompleteRuns, endedEarly } = await h.captureQualification({ panel: onPanel, expectedBuild: BUILD, scanOne: scanWith(scenario) });
  return h.buildQualificationReceipt({ createdAt: CREATED_AT, expectedBuild: BUILD, panel: onPanel, fromPanel, runs, incompleteRuns, finished: endedEarly === null, endedEarly, healthAfter: endedEarly === null ? { ok: true } : null });
}

// The verdict on a receipt, read against the committed copy of panel version 1.
async function verdictOn(receipt: unknown, onPanel: QualificationPanel = qualificationPanel, files: PanelFile[] = [V1_FILE]): Promise<Verdict> {
  const h = await helpers;
  return h.judgeQualification(receipt, { qualificationPanel: onPanel, committedPanels: h.readCommittedPanels(files) });
}

async function judge(scenario: Scenario = {}, onPanel: QualificationPanel = qualificationPanel): Promise<Verdict> {
  return verdictOn(await qualificationReceipt(scenario, onPanel), onPanel);
}

const judged = (verdict: Verdict, caseId: string) => {
  const entry = verdict.cases.find((candidate) => candidate.caseId === caseId);
  assert.ok(entry, `${caseId} was not judged`);
  return entry;
};
const row = (entry: JudgedCase, metric: string) => {
  const found = entry.metrics?.find((candidate) => candidate.metric === metric);
  assert.ok(found, `${entry.caseId}.${metric} has no row`);
  return found;
};
const caseIds = (panel: Panel | null) => (panel === null ? null : panel.cases.map((entry) => entry.id));
const takers = (verdict: Verdict) => Object.fromEntries(verdict.slots.map((slot) => [slot.outgoing, slot.taker]));

const V1_CASES = ["wikipedia", "github", "python", "gov-uk", "guardian"];

test("the committed qualification panel is three closed-list candidates at five repetitions, pinned in the catalogs, with the conditions and tolerances of panel version 1", async () => {
  const h = await helpers;
  assert.equal(h.assertQualificationPanel(qualificationPanel), qualificationPanel);
  h.assertQualificationPanelCatalogMembership(qualificationPanel, catalogs);
  assert.deepEqual(qualificationPanel.cases.map((entry) => [entry.id, entry.domain, entry.url]), [
    ["bumble", "bumble.com", "https://bumble.com/"],
    ["ssa-gov", "ssa.gov", "https://www.ssa.gov/"],
    ["who-int", "who.int", "https://www.who.int/"]
  ]);
  assert.equal(qualificationPanel.repetitions, 5);
  assert.equal(qualificationPanel.cases.length * qualificationPanel.repetitions, 15);
  assert.equal(h.QUALIFICATION_MAX_SCANS, 15);
  // The tolerance table is written in two panel files. The rule refuses a
  // capture when they differ, and this holds the committed pair to it.
  assert.deepEqual(qualificationPanel.conditions, panelV1.conditions);
  assert.deepEqual(qualificationPanel.metricTolerances, panelV1.metricTolerances);
  h.assertQualificationApplies(qualificationPanel, panelV1);
  // Every candidate of the closed list is in the capture, and nothing else.
  assert.deepEqual(qualificationPanel.cases.map((entry) => entry.domain), h.QUALIFICATION_RULE.slots.flatMap((slot) => slot.candidates));
  const unpinned = structuredClone(qualificationPanel);
  unpinned.cases[2].url = "https://who.int/";
  assert.throws(() => h.assertQualificationPanelCatalogMembership(unpinned, catalogs), /Panel case who-int is not pinned exactly in public\/corpus-seed-sites\.json/);
});

test("a qualification panel is a kind of its own: one to five cases, odd repetitions, at most 15 scans, and neither panel check accepts the other kind", async () => {
  const h = await helpers;
  const extra = (id: string): Case => ({ id, catalog: "public/featured-sites.json", domain: `${id}.example`, url: `https://${id}.example/` });
  const shaped = (cases: number, repetitions: number) => ({
    ...structuredClone(qualificationPanel),
    repetitions,
    cases: [...qualificationPanel.cases, extra("fourth"), extra("fifth"), extra("sixth")].slice(0, cases)
  });
  // Fifteen scans is the ceiling, in either shape that reaches it.
  for (const [cases, repetitions] of [[1, 3], [1, 9], [3, 5], [5, 3], [2, 7]]) assert.doesNotThrow(() => h.assertQualificationPanel(shaped(cases, repetitions)), `${cases} x ${repetitions}`);
  // No odd repetition count gives 16; 18 is the smallest total over the
  // ceiling that the other rules allow.
  for (const [cases, repetitions] of [[2, 9], [4, 5], [3, 7], [5, 5]]) {
    assert.throws(
      () => h.assertQualificationPanel(shaped(cases, repetitions)),
      { message: `A qualification panel may submit at most 15 scans (cases times repetitions); this one would submit ${cases * repetitions}.` },
      `${cases} x ${repetitions}`
    );
  }
  const refusals: Array<[string, (value: any) => void, RegExp]> = [
    ["no case", (value) => { value.cases = []; }, /one to five candidate sites/],
    ["six cases", (value) => { value.repetitions = 3; value.cases = shaped(6, 3).cases; }, /one to five candidate sites/],
    ["even repetitions", (value) => { value.repetitions = 4; }, /odd integer from 3 through 9/],
    ["one repetition", (value) => { value.repetitions = 1; }, /odd integer from 3 through 9/],
    ["another condition vector", (value) => { value.conditions.device = "mobile"; }, /ordinary desktop single-scan profile/],
    ["a missing tolerance", (value) => { delete value.metricTolerances.cookies; }, /exactly the canary metric tolerances/],
    ["a case outside the two catalogs", (value) => { value.cases[0].catalog = "public/other.json"; }, /unapproved catalog/],
    ["a repeated case id", (value) => { value.cases[1].id = "bumble"; }, /unique slugs/],
    ["a repeated domain", (value) => { value.cases[1].domain = "bumble.com"; }, /distinct domains/],
    ["another version", (value) => { value.qualificationPanelVersion = 2; }, /Invalid toolchain canary qualification panel/],
    ["an id that is no slug", (value) => { value.qualificationPanelId = "Qualification 1"; }, /Invalid toolchain canary qualification panel/],
    ["a comparison panel's identity beside its own", (value) => { value.panelVersion = 2; value.panelId = "monthly-toolchain-canary-v2"; }, /Invalid toolchain canary qualification panel/]
  ];
  for (const [label, edit, message] of refusals) {
    const value = structuredClone(qualificationPanel);
    edit(value);
    assert.throws(() => h.assertQualificationPanel(value), message, label);
  }
  assert.throws(() => h.assertQualificationPanel(panelV1), { message: "Invalid toolchain canary qualification panel." });
  assert.throws(() => h.assertPanel(qualificationPanel), { message: "Invalid toolchain canary panel." });
  // Five cases at three repetitions under qualification identity is still no comparison panel.
  assert.throws(() => h.assertPanel(shaped(5, 3)), { message: "Invalid toolchain canary panel." });
});

test("the rule's constants are the ones fixed on 2026-11-10, and the signal floor of 8 is where a halved count first leaves the tolerance whichever way it rounds", async () => {
  const h = await helpers;
  const rule = h.QUALIFICATION_RULE;
  assert.deepEqual(JSON.parse(JSON.stringify(rule)), {
    id: "panel-qualification-2026-11-10",
    fixedOn: "2026-11-10",
    fromPanelVersion: 1,
    qualifies: ["every-run-complete", "2xx-document", "no-capture-loss-in-a-metric-family", "observed-origin-and-site-are-the-candidate", "one-subject", "one-set-of-conditions", "spread-within-tolerance"],
    signalMetrics: ["knownTrackerRequests", "shieldsBlockedRequests"],
    signalMedianFloor: 8,
    slots: [
      { outgoing: "theguardian.com", candidates: ["bumble.com"], mustCarry: ["knownTrackerRequests", "thirdPartyDomains", "thirdPartyCookies", "storageEntries", "shieldsBlockedRequests"] },
      { outgoing: "gov.uk", candidates: ["ssa.gov", "who.int"], mustCarry: [] }
    ]
  });
  assert.equal(Object.isFrozen(rule) && Object.isFrozen(rule.qualifies) && Object.isFrozen(rule.slots) && rule.slots.every((slot) => Object.isFrozen(slot) && Object.isFrozen(slot.candidates) && Object.isFrozen(slot.mustCarry)), true);
  assert.equal(rule.slots[0].mustCarry, h.GUARDIAN_ONLY_ZEROING_METRICS);
  assert.equal(panelV1.panelVersion, rule.fromPanelVersion);
  // The floor against the committed tolerances, stated here on its own: a
  // halved count is caught when the median moves by more than the tolerance.
  const halvedIsCaught = (metric: string, median: number, halved: number) => {
    const tolerance = panelV1.metricTolerances[metric];
    return median - halved > Math.max(tolerance.absolute, median * tolerance.relative);
  };
  for (const metric of rule.signalMetrics) {
    for (let median = rule.signalMedianFloor; median <= 400; median += 1) {
      assert.equal(halvedIsCaught(metric, median, Math.floor(median / 2)) && halvedIsCaught(metric, median, Math.ceil(median / 2)), true, `${metric} at ${median}`);
    }
    const below = rule.signalMedianFloor - 1;
    assert.equal(halvedIsCaught(metric, below, Math.ceil(below / 2)), false, `${metric} at ${below}`);
  }
});

const committedReceiptText = new Map<string, string>();
function committedReceipt(file: string): Receipt {
  if (!committedReceiptText.has(file)) committedReceiptText.set(file, readFileSync(path.join(root, "docs", file), "utf8"));
  return JSON.parse(committedReceiptText.get(file) ?? "") as Receipt;
}

const COMMITTED_PAIRS: Array<[string, string]> = [
  ["toolchain-epoch-2026-09/baseline-receipt.json", "toolchain-epoch-2026-09/candidate-receipt.json"],
  ["toolchain-epoch-2026-10/round-1-baseline-receipt.json", "toolchain-epoch-2026-10/round-1-candidate-receipt.json"],
  ["toolchain-epoch-2026-10/round-2-baseline-receipt.json", "toolchain-epoch-2026-10/round-2-candidate-receipt.json"],
  ["toolchain-epoch-2026-11/round-1-baseline-receipt.json", "toolchain-epoch-2026-11/round-1-candidate-receipt.json"],
  ["toolchain-epoch-2026-11/round-2-baseline-receipt.json", "toolchain-epoch-2026-11/round-2-candidate-receipt.json"]
];

test("the five metrics only the Guardian carries are the ones the ten committed receipts show: zeroing them fails on the Guardian in every pair and on no other case in any", async () => {
  const h = await helpers;
  const digest = h.panelDigest(panelV1);
  // For each metric, the cases whose zeroed count fails the comparison, as
  // [in every committed pair, in at least one].
  const failsWhenZeroed = (metric: string, caseId: string, [baselineFile, candidateFile]: [string, string]) => {
    const candidate = committedReceipt(candidateFile);
    for (const entry of candidate.runs) if (entry.caseId === caseId) entry.counts[metric] = 0;
    const result = h.compareReceipts(committedReceipt(baselineFile), candidate, panelV1, digest);
    return result.results.some((entry) => entry.caseId === caseId && entry.metric === metric && entry.outcome === "fail");
  };
  const carriers = (metric: string) => ({
    always: V1_CASES.filter((caseId) => COMMITTED_PAIRS.every((pair) => failsWhenZeroed(metric, caseId, pair))),
    ever: V1_CASES.filter((caseId) => COMMITTED_PAIRS.some((pair) => failsWhenZeroed(metric, caseId, pair)))
  });
  const derived = h.METRICS.filter((metric) => {
    const { always, ever } = carriers(metric);
    return always.length === 1 && always[0] === "guardian" && ever.length === 1;
  });
  assert.deepEqual(derived, [...h.GUARDIAN_ONLY_ZEROING_METRICS]);
  assert.deepEqual(derived, ["knownTrackerRequests", "thirdPartyDomains", "thirdPartyCookies", "storageEntries", "shieldsBlockedRequests"]);
  // The other four are carried by another case as well, or by none.
  assert.deepEqual(carriers("totalRequests").always, ["github", "python", "gov-uk", "guardian"]);
  assert.deepEqual(carriers("thirdPartyRequests").always, ["github", "guardian"]);
  assert.deepEqual(carriers("cookies").always, ["wikipedia", "github", "guardian"]);
  assert.deepEqual(carriers("fingerprintEvents").ever, []);
});

test("a saved report that is not a complete observation is kept with its facts and reasons, where a comparison capture refuses it, and a report that is not what was asked for is refused by both", async () => {
  const h = await helpers;
  const panelCase = qualificationPanel.cases[0];
  const input = (saved: { reportId: string; reportWireSha256: string }) => ({ reportId: saved.reportId, expectedBuild: BUILD, panelCase, sequence: 1, repetition: 1, reportWireSha256: saved.reportWireSha256 });
  const steady = counted("bumble")(1);
  {
    const saved = savedReport(panelCase, 1, steady);
    const extracted = h.extractQualificationRun(saved.report, input(saved));
    assert.equal(extracted.complete, true);
    assert.deepEqual(extracted.run, h.extractCapturedRun(saved.report, { ...input(saved), order: "reverse" }));
    assert.equal(Object.hasOwn(extracted.run, "notComplete") || Object.hasOwn(extracted.run, "stage"), false);
  }
  // Each of these is a visit that did not produce a complete observation.
  // [what happened, the facts recorded as the reason, what a comparison capture says]
  const incomplete: Array<[string, Partial<RunSpec>, string[], RegExp]> = [
    ["blocked with 403", BLOCKED, ["the document status was 403", "the run-level outcome was failed (http-status:403)"], /failed, bot-wall, timeout, or budget quality facts/],
    ["no document status", { status: null }, ["the document returned no status"], /failed, bot-wall, timeout, or budget quality facts/],
    ["a server error", { status: 503 }, ["the document status was 503"], /failed, bot-wall, timeout, or budget quality facts/],
    ["a bot wall title", { botWall: true }, ["the page title matched a bot wall"], /failed, bot-wall, timeout, or budget quality facts/],
    ["navigation that did not settle", { settled: false }, ["navigation did not settle"], /failed, bot-wall, timeout, or budget quality facts/],
    ["an exhausted budget", { budgets: ["scan-window", "requests"] }, ["budgets exhausted: scan-window, requests"], /failed, bot-wall, timeout, or budget quality facts/],
    ["a failed run outcome", { runOutcome: { outcome: "failed", reasons: ["navigation-error"] } }, ["the run-level outcome was failed (navigation-error)"], /not run-level complete/],
    ["a family censored by something other than its loss", { edit: (report) => { report.run.quality.byFamily.cookies = { outcome: "censored", reasons: ["detector-failed"] }; } },
      ["evidence family cookies is censored (detector-failed), which its recorded capture loss does not account for"], /censored by something other than its recorded capture loss/]
  ];
  for (const [label, more, notComplete, captureMessage] of incomplete) {
    const saved = savedReport(panelCase, 1, { ...steady, ...more });
    const extracted = h.extractQualificationRun(saved.report, input(saved));
    assert.equal(extracted.complete, false, label);
    assert.equal(extracted.run.stage, "report", label);
    assert.deepEqual(extracted.run.notComplete, notComplete, label);
    assert.deepEqual(extracted.run.qualityFacts, (saved.report as any).run.qualityFacts, label);
    assert.deepEqual(extracted.run.counts, steady.counts, label);
    assert.throws(() => h.extractCapturedRun(saved.report, { ...input(saved), order: "reverse" }), captureMessage, label);
  }
  // A capture loss the family records as its own leaves the run complete:
  // the rule, not the capture, holds a loss against a case.
  {
    const saved = savedReport(panelCase, 1, { ...steady, losses: [FINGERPRINT_LOSS] });
    assert.equal(h.extractQualificationRun(saved.report, input(saved)).complete, true);
  }
  // Each of these is not the report the canary asked for, and refuses the capture.
  const refused: Array<[string, (report: any) => void, RegExp]> = [
    ["another build", (report) => { report.run.provenance.buildCommit = "d".repeat(40); }, /invalid run provenance/],
    ["no Playwright version", (report) => { report.run.provenance.methodologyVersion = report.run.provenance.methodologyVersion.replace(/-playwright-[0-9.]+/, ""); }, /one exact Playwright version/],
    ["an incomplete toolchain record", (report) => { delete report.run.toolchain.adblock.manifestDigest; }, /incomplete measurement-toolchain provenance/],
    ["another condition vector", (report) => { report.run.conditions.gpc = false; }, /full fixed ordinary single-scan condition vector/],
    ["a malformed capture loss", (report) => { report.run.qualityFacts.captureLoss = [{ family: "requests", kind: "dropped", count: 0 }]; }, /malformed capture-loss/],
    ["a missing count", (report) => { delete report.run.summary.counts.cookies; }, /missing a canary count metric/],
    ["malformed quality facts", (report) => { report.run.qualityFacts.status = "403"; }, /malformed quality facts/],
    ["no quality block", (report) => { delete report.run.quality; }, /malformed quality facts/],
    ["another requested subject", (report) => { report.run.subject.requested.origin = "https://example.org"; }, /requested subject does not match bumble/],
    ["a comparison report", (report) => { report.reportType = "comparison"; }, /must be a public v2\/r2 single/],
    ["another report id", (report) => { report.share.id = `20261110-${"f".repeat(32)}`; }, /does not match the admission-minted report id/]
  ];
  for (const [label, edit, message] of refused) {
    // Refused whether or not the visit also failed: a blocked page is no excuse for the wrong build.
    for (const more of [{}, BLOCKED]) {
      const saved = savedReport(panelCase, 1, { ...steady, ...more, edit });
      assert.throws(() => h.extractQualificationRun(saved.report, input(saved)), message, label);
    }
  }
});

test("a qualifying capture records a blocked case, a scan that left no report and a lossy run against their own cases, keeps every other run, and hands over what is recorded before each scan", async () => {
  const h = await helpers;
  const logged: string[] = [];
  // What the capture hands over before each scan: how many runs are recorded so far.
  const progress: Array<[number, number]> = [];
  const scenario: Scenario = {
    bumble: withOn(counted("bumble"), ALL, BLOCKED),
    "ssa-gov": withOn(withOn(counted("ssa-gov"), [3], { noReport: "failed" }), [5], { losses: [FINGERPRINT_LOSS] })
  };
  const submitted: number[] = [];
  const scan = scanWith(scenario);
  const { runs, incompleteRuns, endedEarly } = await h.captureQualification({
    panel: qualificationPanel,
    expectedBuild: BUILD,
    log: (line) => logged.push(line),
    onProgress: async (recorded) => {
      progress.push([recorded.runs.length, recorded.incompleteRuns.length]);
    },
    scanOne: async (input) => {
      // By the time a scan is submitted, everything before it has been handed over.
      assert.equal(progress.length, input.sequence);
      submitted.push(input.sequence);
      return scan(input);
    }
  });
  assert.equal(endedEarly, null);
  assert.equal(logged.length, 15);
  assert.equal(logged[0], "[1/15] bumble repetition 1");
  assert.equal(logged[14], "[15/15] who-int repetition 5");
  assert.deepEqual(submitted, Array.from({ length: 15 }, (_, index) => index + 1));
  assert.deepEqual(progress, [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 5], [2, 5], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6], [8, 6]]);
  // Every repetition of every case is attempted and recorded once, in order.
  assert.deepEqual(incompleteRuns.map((entry) => [entry.caseId, entry.repetition, entry.sequence, entry.stage]), [
    ["bumble", 1, 1, "report"], ["bumble", 2, 2, "report"], ["bumble", 3, 3, "report"], ["bumble", 4, 4, "report"], ["bumble", 5, 5, "report"],
    ["ssa-gov", 3, 8, "job"]
  ]);
  assert.deepEqual(runs.map((entry) => [entry.caseId, entry.repetition, entry.sequence]), [
    ["ssa-gov", 1, 6], ["ssa-gov", 2, 7], ["ssa-gov", 4, 9], ["ssa-gov", 5, 10],
    ["who-int", 1, 11], ["who-int", 2, 12], ["who-int", 3, 13], ["who-int", 4, 14], ["who-int", 5, 15]
  ]);
  assert.deepEqual(incompleteRuns[5], { caseId: "ssa-gov", repetition: 3, sequence: 8, stage: "job", notComplete: [h.JOB_FACTS.failed] });
  assert.deepEqual(incompleteRuns[0].notComplete, ["the document status was 403", "the run-level outcome was failed (http-status:403)"]);
  assert.deepEqual(runs[3].qualityFacts.captureLoss, [FINGERPRINT_LOSS]);
  for (const entry of runs) assert.equal(Object.hasOwn(entry, "notComplete"), false);

  // The receipt keeps the fields of a capture receipt, names the rule and the
  // panel the rule would change, and says how the capture ended.
  const receipt = h.buildQualificationReceipt({ createdAt: CREATED_AT, expectedBuild: BUILD, panel: qualificationPanel, fromPanel: panelV1, runs, incompleteRuns, finished: true, healthAfter: { ok: true } });
  assert.deepEqual(Object.keys(receipt), ["receiptVersion", "kind", "createdAt", "origin", "expectedBuild", "rule", "fromPanelVersion", "fromPanelDigest", "panelDigest", "panel", "finished", "endedEarly", "healthAfter", "runs", "incompleteRuns"]);
  assert.equal(receipt.kind, "site-behavior-toolchain-canary-qualification");
  assert.equal(receipt.kind, h.QUALIFICATION_RECEIPT_KIND);
  assert.equal(receipt.receiptVersion, 2);
  assert.equal(receipt.origin, "https://scan-staging.sitebehavior.org");
  assert.deepEqual(receipt.rule, { id: "panel-qualification-2026-11-10", digest: h.qualificationRuleDigest() });
  assert.deepEqual([receipt.fromPanelVersion, receipt.fromPanelDigest], [1, h.panelDigest(panelV1)]);
  assert.deepEqual(receipt.panel, qualificationPanel);
  assert.equal(receipt.panelDigest, h.panelDigest(qualificationPanel));
  assert.deepEqual([receipt.finished, receipt.endedEarly, receipt.healthAfter], [true, null, { ok: true }]);

  // The cases that failed do not cost who.int its verdict.
  const verdict = await verdictOn(receipt);
  assert.deepEqual(verdict.cases.map((entry) => [entry.caseId, entry.judged, entry.qualifies, entry.completeRuns]), [["bumble", true, false, 0], ["ssa-gov", true, false, 4], ["who-int", true, true, 5]]);
  assert.deepEqual(takers(verdict), { "theguardian.com": null, "gov.uk": "who.int" });
});

test("each way a scan can leave no report has its own words in the receipt, and a scan that ends in no known way ends the capture", async () => {
  const h = await helpers;
  assert.deepEqual({ ...h.JOB_FACTS }, {
    failed: "the scan job failed and saved no report; the staging job status gives no cause",
    expired: "the scan job expired and saved no report",
    cancelled: "the scan job was cancelled and saved no report",
    timedOut: "the scan job did not end within the polling window",
    statusUnreadable: "the status of the scan job could not be read",
    reportUnreadable: "the scan job succeeded and its saved report could not be read"
  });
  assert.equal(Object.isFrozen(h.JOB_FACTS), true);
  const kinds = Object.keys(h.JOB_FACTS);
  // One of each on who.int's five runs, and a sixth on ssa.gov.
  const receipt = await qualificationReceipt({
    "who-int": (repetition) => ({ ...counted("who-int")(repetition), noReport: kinds[repetition - 1] }),
    "ssa-gov": withOn(counted("ssa-gov"), [4], { noReport: kinds[5] })
  });
  assert.equal(receipt.finished, true);
  assert.deepEqual(receipt.incompleteRuns.map((entry: Receipt) => [entry.caseId, entry.repetition, entry.stage, entry.notComplete]), [
    ["ssa-gov", 4, "job", [h.JOB_FACTS.reportUnreadable]],
    ...kinds.slice(0, 5).map((kind, index) => ["who-int", index + 1, "job", [h.JOB_FACTS[kind]]])
  ]);
  const verdict = await verdictOn(receipt);
  assert.deepEqual(judged(verdict, "who-int").refusals, kinds.slice(0, 5).map((kind, index) => `repetition ${index + 1} did not complete: ${h.JOB_FACTS[kind]}`));
  assert.deepEqual(judged(verdict, "ssa-gov").refusals, ["repetition 4 did not complete: the scan job succeeded and its saved report could not be read"]);
  assert.deepEqual(takers(verdict), { "theguardian.com": "bumble.com", "gov.uk": null });
  const unknown = await h.captureQualification({ panel: qualificationPanel, expectedBuild: BUILD, scanOne: async () => ({ noReport: "lost" }) });
  assert.equal(unknown.endedEarly, "scan 1 of 15 (bumble repetition 1) ended the capture: A qualification scan ended in a way the receipt has no word for.");
});

test("a capture that a scan ends keeps the runs before it with the reason, and a capture that has not started refuses its inputs", async () => {
  const h = await helpers;
  // [what ended the capture, at which scan, the reason recorded]
  const ended: Array<[string, Scenario | ((input: ScanInput) => Promise<unknown>), number, string]> = [
    ["a report of another build", { "ssa-gov": withOn(counted("ssa-gov"), [2], { build: "d".repeat(40) }) }, 7, "scan 7 of 15 (ssa-gov repetition 2) ended the capture: Saved report has invalid run provenance."],
    ["a report under another condition vector", { bumble: withOn(counted("bumble"), [4], { edit: (report) => { report.run.conditions.gpc = false; } }) }, 4, "scan 4 of 15 (bumble repetition 4) ended the capture: Saved report does not match the full fixed ordinary single-scan condition vector."],
    ["a scan that throws", async ({ sequence, panelCase }: ScanInput) => { if (sequence === 12) throw new Error("/api/scan did not return the required 202 queued single scan (429)."); return savedReport(panelCase, sequence, counted(panelCase.id)(1)); }, 12, "scan 12 of 15 (who-int repetition 2) ended the capture: /api/scan did not return the required 202 queued single scan (429)."],
    ["a scan that returns nothing", async () => undefined, 1, "scan 1 of 15 (bumble repetition 1) ended the capture: A qualification scan returned nothing to record."]
  ];
  for (const [label, script, at, reason] of ended) {
    const attempted: number[] = [];
    const scan = typeof script === "function" ? script : scanWith(script);
    const result = await h.captureQualification({ panel: qualificationPanel, expectedBuild: BUILD, scanOne: async (input) => { attempted.push(input.sequence); return scan(input); } });
    assert.equal(result.endedEarly, reason, label);
    // No scan after the one that ended it, and every run before it kept.
    assert.deepEqual(attempted, Array.from({ length: at }, (_, index) => index + 1), label);
    assert.equal(result.runs.length + result.incompleteRuns.length, at - 1, label);
    assert.deepEqual(result.runs.map((entry) => entry.sequence), Array.from({ length: at - 1 }, (_, index) => index + 1), label);
    // The receipt of such a capture is not finished and is still read.
    const receipt = h.buildQualificationReceipt({ createdAt: CREATED_AT, expectedBuild: BUILD, panel: qualificationPanel, fromPanel: panelV1, ...result, finished: false });
    assert.deepEqual([receipt.finished, receipt.endedEarly, receipt.healthAfter], [false, reason, null], label);
    assert.equal((await verdictOn(receipt)).endedEarly, reason, label);
  }
  // What the capture cannot keep on disk it must not go on with.
  await assert.rejects(
    h.captureQualification({ panel: qualificationPanel, expectedBuild: BUILD, scanOne: scanWith({}), onProgress: async (recorded) => { if (recorded.runs.length === 2) throw new Error("the receipt could not be written"); } }),
    /the receipt could not be written/
  );
  await assert.rejects(h.captureQualification({ panel: panelV1 as unknown as QualificationPanel, expectedBuild: BUILD, scanOne: scanWith({}) }), /Invalid toolchain canary qualification panel/);
  await assert.rejects(h.captureQualification({ panel: qualificationPanel, expectedBuild: "main", scanOne: scanWith({}) }), /exact lowercase 40-character commit SHA/);
});

test("when all three candidates qualify, bumble.com takes the Guardian's slot, ssa.gov takes gov.uk's, and the verdict carries every run, median, spread and tolerance", async () => {
  const h = await helpers;
  const verdict = await judge();
  assert.equal(verdict.rule, "panel-qualification-2026-11-10");
  assert.equal(verdict.build, BUILD);
  assert.equal(verdict.scans, 15);
  assert.deepEqual(verdict.cases.map((entry) => [entry.caseId, entry.qualifies, entry.signalCase, entry.refusals]), [
    ["bumble", true, true, []],
    ["ssa-gov", true, true, []],
    ["who-int", true, true, []]
  ]);
  const bumble = judged(verdict, "bumble");
  assert.deepEqual(row(bumble, "knownTrackerRequests"), { metric: "knownTrackerRequests", values: [30, 30, 30, 30, 30], median: 30, spread: 0, tolerance: 9, within: true, zeroingFails: true });
  assert.deepEqual(row(bumble, "storageEntries"), { metric: "storageEntries", values: [9, 9, 9, 9, 9], median: 9, spread: 0, tolerance: 4, within: true, zeroingFails: true });
  assert.deepEqual(row(bumble, "fingerprintEvents"), { metric: "fingerprintEvents", values: [0, 0, 0, 0, 0], median: 0, spread: 0, tolerance: 3, within: true, zeroingFails: false });
  assert.deepEqual(bumble.metrics?.map((entry) => entry.metric), [...h.METRICS]);
  assert.deepEqual(bumble.signal, [
    { metric: "knownTrackerRequests", median: 30, floor: 8, met: true },
    { metric: "shieldsBlockedRequests", median: 36, floor: 8, met: true }
  ]);
  // What each candidate would fail on if the count went to zero.
  const zeroing = (caseId: string) => judged(verdict, caseId).metrics?.filter((entry) => entry.zeroingFails).map((entry) => entry.metric);
  assert.deepEqual(zeroing("bumble"), ["totalRequests", "thirdPartyRequests", "knownTrackerRequests", "thirdPartyDomains", "cookies", "thirdPartyCookies", "storageEntries", "shieldsBlockedRequests"]);
  assert.deepEqual(zeroing("ssa-gov"), ["totalRequests", "thirdPartyRequests", "knownTrackerRequests", "thirdPartyDomains", "shieldsBlockedRequests"]);
  assert.deepEqual(zeroing("who-int"), ["totalRequests", "thirdPartyRequests", "knownTrackerRequests", "thirdPartyDomains", "cookies", "shieldsBlockedRequests"]);

  assert.deepEqual(verdict.slots, [
    { outgoing: "theguardian.com", taker: "bumble.com", considered: [{ domain: "bumble.com", takes: true, reasons: [] }] },
    { outgoing: "gov.uk", taker: "ssa.gov", considered: [
      { domain: "ssa.gov", takes: true, reasons: [] },
      { domain: "who.int", takes: false, reasons: ["was not needed: ssa.gov had taken the slot"] }
    ] }
  ]);
  assert.deepEqual(verdict.signalSites, ["bumble.com", "ssa.gov"]);
  // Each of the Guardian's five metrics, and the cases of the new panel a zeroed count would fail on.
  assert.deepEqual(verdict.coverage, [
    { metric: "knownTrackerRequests", through: [{ caseId: "bumble", retained: false, median: 30, tolerance: 9 }, { caseId: "ssa-gov", retained: false, median: 11, tolerance: 3.3 }] },
    { metric: "thirdPartyDomains", through: [{ caseId: "bumble", retained: false, median: 15, tolerance: 3.75 }, { caseId: "ssa-gov", retained: false, median: 9, tolerance: 3 }] },
    { metric: "thirdPartyCookies", through: [{ caseId: "bumble", retained: false, median: 10, tolerance: 3 }] },
    { metric: "storageEntries", through: [{ caseId: "bumble", retained: false, median: 9, tolerance: 4 }] },
    { metric: "shieldsBlockedRequests", through: [{ caseId: "bumble", retained: false, median: 36, tolerance: 36 * 0.3 }, { caseId: "ssa-gov", retained: false, median: 16, tolerance: 16 * 0.3 }] }
  ]);

  // The next panel: version 2, three repetitions, the tolerances of version
  // 1, and each new case in the slot of the case it replaces.
  assert.ok(verdict.panel);
  assert.deepEqual(caseIds(verdict.panel), ["wikipedia", "github", "python", "ssa-gov", "bumble"]);
  assert.equal(verdict.panel.panelVersion, 2);
  assert.equal(verdict.panel.panelId, "monthly-toolchain-canary-v2");
  assert.equal(verdict.panel.repetitions, 3);
  assert.deepEqual(verdict.panel.conditions, panelV1.conditions);
  assert.deepEqual(verdict.panel.metricTolerances, panelV1.metricTolerances);
  assert.deepEqual(verdict.panel.cases.slice(0, 3), panelV1.cases.slice(0, 3));
  assert.deepEqual(verdict.panel.cases.slice(3), [qualificationPanel.cases[1], qualificationPanel.cases[0]]);
  h.assertPanel(verdict.panel);
  h.assertPanelCatalogMembership(verdict.panel, catalogs);
  assert.equal(verdict.panelDigest, h.panelDigest(verdict.panel));
  // The bytes to commit are panel version 1's file with four lines changed.
  assert.equal(
    verdict.panelText,
    panelV1Text
      .replace('"panelVersion": 1,', '"panelVersion": 2,')
      .replace('"panelId": "monthly-toolchain-canary-v1",', '"panelId": "monthly-toolchain-canary-v2",')
      .replace('{ "id": "gov-uk", "catalog": "public/corpus-seed-sites.json", "domain": "gov.uk", "url": "https://www.gov.uk/" }', '{ "id": "ssa-gov", "catalog": "public/featured-sites.json", "domain": "ssa.gov", "url": "https://www.ssa.gov/" }')
      .replace('{ "id": "guardian", "catalog": "public/featured-sites.json", "domain": "theguardian.com", "url": "https://www.theguardian.com/" }', '{ "id": "bumble", "catalog": "public/featured-sites.json", "domain": "bumble.com", "url": "https://bumble.com/" }')
  );
  assert.deepEqual(JSON.parse(verdict.panelText ?? ""), verdict.panel);
});

test("the panel layout writes panel version 1 back as the bytes of its committed file, and refuses a panel it could not write whole", async () => {
  const h = await helpers;
  assert.equal(h.formatPanel(panelV1), panelV1Text);
  assert.equal(h.formatPanel(readJson<Panel>(CURRENT_PANEL_FILE)), readFileSync(path.join(root, CURRENT_PANEL_FILE), "utf8"));
  assert.throws(() => h.formatPanel({ ...structuredClone(panelV1), note: "kept" } as unknown as Panel), /carries a key the committed panel layout does not write/);
  assert.throws(() => h.formatPanel(qualificationPanel as unknown as Panel), /Invalid toolchain canary panel/);
});

test("a case qualifies with a spread exactly on the tolerance at its median and not with one count more, on the relative term and on the absolute term", async () => {
  // [metric, the five runs, median, tolerance, qualifies]
  const cases: Array<[string, number[], number, number, boolean]> = [
    // knownTrackerRequests allows max(3, 0.3 x median): 9 at a median of 30.
    ["knownTrackerRequests", [30, 30, 39, 30, 30], 30, 9, true],
    ["knownTrackerRequests", [30, 30, 40, 30, 30], 30, 9, false],
    ["knownTrackerRequests", [21, 30, 30, 30, 30], 30, 9, true],
    ["knownTrackerRequests", [20, 30, 30, 30, 30], 30, 9, false],
    // The tolerance is taken at the median of the five runs, not at their
    // smallest or their largest: 40 allows 12, where 30 would allow 9.
    ["knownTrackerRequests", [30, 40, 40, 40, 42], 40, 12, true],
    ["knownTrackerRequests", [30, 40, 40, 40, 43], 40, 12, false],
    // totalRequests allows max(10, 0.2 x median): 20 at 100.
    ["totalRequests", [100, 100, 100, 110, 120], 100, 20, true],
    ["totalRequests", [100, 100, 100, 110, 121], 100, 20, false],
    // The absolute term: fingerprintEvents allows 3 at a median of 0, and storageEntries 4 at 9.
    ["fingerprintEvents", [0, 0, 0, 0, 3], 0, 3, true],
    ["fingerprintEvents", [0, 0, 0, 0, 4], 0, 3, false],
    ["storageEntries", [9, 9, 9, 13, 9], 9, 4, true],
    ["storageEntries", [9, 9, 9, 14, 9], 9, 4, false]
  ];
  for (const [metric, values, median, tolerance, qualifies] of cases) {
    const context = `${metric} ${JSON.stringify(values)}`;
    const verdict = await judge({ bumble: counted("bumble", { [metric]: values }) });
    const bumble = judged(verdict, "bumble");
    const spread = Math.max(...values) - Math.min(...values);
    assert.deepEqual(row(bumble, metric), { metric, values, median, spread, tolerance, within: qualifies, zeroingFails: median > tolerance }, context);
    assert.equal(bumble.qualifies, qualifies, context);
    assert.deepEqual(bumble.refusals, qualifies ? [] : [`${metric} spread ${spread} is over the tolerance ${tolerance} at its median ${median} (runs ${values.join(", ")})`], context);
    assert.equal(takers(verdict)["theguardian.com"], qualifies ? "bumble.com" : null, context);
    // The other cases are judged alone and are not touched.
    assert.equal(judged(verdict, "ssa-gov").qualifies, true, context);
    assert.equal(takers(verdict)["gov.uk"], "ssa.gov", context);
  }
});

test("a blocked case, a failed run, a document that is not 2xx, a metric-family loss on one run and runs on two subjects each leave the case not qualified with its reason, and a loss that feeds no metric does not", async () => {
  // [what happened to bumble, its refusals, runs complete, whether its statistics exist]
  const cases: Array<[string, CaseScript, string[], number, boolean]> = [
    ["blocked on every run", withOn(counted("bumble"), ALL, BLOCKED), ALL.map((repetition) => `repetition ${repetition} did not complete: ${BLOCKED_FACTS}`), 0, false],
    ["blocked on one run", withOn(counted("bumble"), [4], BLOCKED), [`repetition 4 did not complete: ${BLOCKED_FACTS}`], 4, false],
    ["a bot wall on one run", withOn(counted("bumble"), [2], { botWall: true }), ["repetition 2 did not complete: the page title matched a bot wall"], 4, false],
    ["one failed scan job", withOn(counted("bumble"), [3], { noReport: "failed" }), ["repetition 3 did not complete: the scan job failed and saved no report; the staging job status gives no cause"], 4, false],
    // A 3xx document completes a comparison capture; the rule asks for 2xx.
    ["a 300 document on one run", withOn(counted("bumble"), [2], { status: 300 }), ["repetition 2 returned document status 300, not a 2xx document"], 5, true],
    ["a 399 document on one run", withOn(counted("bumble"), [5], { status: 399 }), ["repetition 5 returned document status 399, not a 2xx document"], 5, true],
    ["a fingerprinting loss on one run", withOn(counted("bumble"), [1], { losses: [FINGERPRINT_LOSS] }), ["repetition 1 records capture loss in a family a canary metric is counted from: fingerprinting/dropped/fingerprint-observer"], 5, true],
    ["a storage loss on every run", withOn(counted("bumble"), ALL, { losses: [STORAGE_LOSS] }), ALL.map((repetition) => `repetition ${repetition} records capture loss in a family a canary metric is counted from: storage/truncated/storage-snapshot`), 5, true],
    ["two losses on one run", withOn(counted("bumble"), [2], { losses: [STORAGE_LOSS, KEYSTROKE_LOSS, FINGERPRINT_LOSS] }), ["repetition 2 records capture loss in a family a canary metric is counted from: fingerprinting/dropped/fingerprint-observer, storage/truncated/storage-snapshot"], 5, true],
    ["one run on another route", withOn(counted("bumble"), [5], { observedRoute: "/get-started" }), ["its runs landed on different subjects"], 5, true]
  ];
  for (const [label, script, refusals, completeRuns, hasStatistics] of cases) {
    const verdict = await judge({ bumble: script });
    const bumble = judged(verdict, "bumble");
    assert.equal(bumble.qualifies, false, label);
    assert.equal(bumble.signalCase, false, label);
    assert.deepEqual(bumble.refusals, refusals, label);
    assert.equal(bumble.completeRuns, completeRuns, label);
    assert.equal(bumble.metrics !== null, hasStatistics, label);
    assert.equal(bumble.signal !== null, hasStatistics, label);
    // The Guardian stays, and gov.uk's slot is decided as if bumble were not there.
    assert.deepEqual(takers(verdict), { "theguardian.com": null, "gov.uk": "ssa.gov" }, label);
    assert.deepEqual(caseIds(verdict.panel), ["wikipedia", "github", "python", "ssa-gov", "guardian"], label);
    assert.deepEqual(verdict.cases.slice(1).map((entry) => entry.qualifies), [true, true], label);
  }
  // 200 and 299 are 2xx documents.
  for (const status of [200, 204, 299]) assert.equal(judged(await judge({ bumble: withOn(counted("bumble"), ALL, { status }) }), "bumble").qualifies, true, String(status));
  // A loss in a family no canary metric is counted from is not held against the case.
  const noted = await judge({ bumble: withOn(counted("bumble"), [1, 3], { losses: [KEYSTROKE_LOSS] }) });
  assert.equal(judged(noted, "bumble").qualifies, true);
  assert.deepEqual(judged(noted, "bumble").refusals, []);
  assert.equal(takers(noted)["theguardian.com"], "bumble.com");
});

test("a case qualifies only if every run ended on the candidate's own site, by the recorded origin and by the recorded site: another site is refused by name, on five runs or on one, and a subdomain of the candidate is its site", async () => {
  // Where a run ended, as the scanner records the observed subject.
  const endedOn = (origin: unknown, registrableDomain: unknown) => (report: any) => {
    report.run.subject.observed = { origin, registrableDomain, routeShape: "/" };
  };
  const elsewhere = endedOn("https://www.example.org", "example.org");
  const refusal = (repetition: number, origin: string, site: string, caseDomain: string) => `repetition ${repetition} ended on ${origin} (recorded site: ${site}), not on the candidate's own site ${caseDomain}`;
  const refused = (repetition: number, caseDomain: string) => refusal(repetition, "https://www.example.org", "example.org", caseDomain);
  // [the candidate, the runs that ended elsewhere, the reasons against it]
  const cases: Array<[string, string, number[], string[]]> = [
    // All five on another site: the runs agree with each other, so only this condition speaks.
    ["bumble", "bumble.com", ALL, ALL.map((repetition) => refused(repetition, "bumble.com"))],
    // Four on the candidate and one elsewhere: that run is named, and the runs no longer share a subject.
    ["bumble", "bumble.com", [3], [refused(3, "bumble.com"), "its runs landed on different subjects"]],
    ["ssa-gov", "ssa.gov", ALL, ALL.map((repetition) => refused(repetition, "ssa.gov"))],
    ["who-int", "who.int", [1], [refused(1, "who.int"), "its runs landed on different subjects"]]
  ];
  for (const [caseId, domain, repetitions, refusals] of cases) {
    const context = `${caseId} ${JSON.stringify(repetitions)}`;
    const verdict = await judge({ [caseId]: withOn(counted(caseId), repetitions, { edit: elsewhere }) });
    const entry = judged(verdict, caseId);
    assert.equal(entry.domain, domain, context);
    assert.equal(entry.qualifies, false, context);
    assert.deepEqual(entry.refusals, refusals, context);
    // Its counts are as steady as ever: the statistics are shown and are not what refuses it.
    assert.equal(entry.metrics?.every((metric) => metric.within), true, context);
    assert.deepEqual(verdict.cases.filter((other) => other.caseId !== caseId).map((other) => other.qualifies), [true, true], context);
  }
  // With every run of bumble.com on another site the Guardian stays, and the slot says why.
  const away = await judge({ bumble: withOn(counted("bumble"), ALL, { edit: elsewhere }) });
  assert.deepEqual(takers(away), { "theguardian.com": null, "gov.uk": "ssa.gov" });
  assert.deepEqual(away.slots[0].considered, [{ domain: "bumble.com", takes: false, reasons: [`does not qualify (${ALL.map((repetition) => refused(repetition, "bumble.com")).join("; ")})`] }]);

  // A subdomain of the candidate has the candidate's registrable domain and a
  // host under it, so it is the candidate's site: five runs there qualify,
  // and so do five on the bare domain, on another port or in other letter case.
  const subdomain = await judge({
    bumble: withOn(counted("bumble"), ALL, { edit: endedOn("https://us.bumble.com", "bumble.com") }),
    "who-int": withOn(counted("who-int"), ALL, { edit: endedOn("https://apps.who.int", "who.int") })
  });
  assert.deepEqual(subdomain.cases.map((entry) => [entry.caseId, entry.qualifies, entry.refusals]), [["bumble", true, []], ["ssa-gov", true, []], ["who-int", true, []]]);
  assert.equal(takers(subdomain)["theguardian.com"], "bumble.com");
  for (const origin of ["https://bumble.com", "https://bumble.com:8443", "https://WWW.Bumble.com", "https://a.b.bumble.com"]) {
    assert.deepEqual(judged(await judge({ bumble: withOn(counted("bumble"), ALL, { edit: endedOn(origin, "bumble.com") }) }), "bumble").refusals, [], origin);
  }
  // One run on the subdomain and four on the bare domain is the same site on
  // two subjects, which the one-subject condition refuses, and this one does not.
  const split = await judge({ bumble: withOn(counted("bumble"), [2], { edit: endedOn("https://us.bumble.com", "bumble.com") }) });
  assert.deepEqual(judged(split, "bumble").refusals, ["its runs landed on different subjects"]);

  // The origin and the recorded site are each held, so neither stands in for
  // the other, and a name that only contains the candidate's is another site.
  // [what, the recorded origin, the recorded site, how the reason shows them]
  const others: Array<[string, unknown, unknown, string, string]> = [
    ["the recorded site is the candidate's and the origin is another site's", "https://www.example.org", "bumble.com", "https://www.example.org", "bumble.com"],
    ["the origin is the candidate's and the recorded site is another's", "https://bumble.com", "example.org", "https://bumble.com", "example.org"],
    ["an origin whose host only ends in the candidate's letters", "https://notbumble.com", "bumble.com", "https://notbumble.com", "bumble.com"],
    ["an origin whose host only starts with the candidate's name", "https://bumble.com.example.org", "bumble.com", "https://bumble.com.example.org", "bumble.com"],
    ["a site whose name only contains the candidate's", "https://notbumble.com", "notbumble.com", "https://notbumble.com", "notbumble.com"],
    ["an origin with a dot after the candidate's name", "https://bumble.com.", "bumble.com", "https://bumble.com.", "bumble.com"],
    ["an origin that is no origin", "bumble.com", "bumble.com", "bumble.com", "bumble.com"],
    ["no recorded origin", undefined, "bumble.com", "no recorded origin", "bumble.com"],
    ["an origin that is not text", 7, "bumble.com", "no recorded origin", "bumble.com"],
    ["no recorded site", "https://bumble.com", undefined, "https://bumble.com", "none"]
  ];
  for (const [label, origin, site, shownOrigin, shownSite] of others) {
    const entry = judged(await judge({ bumble: withOn(counted("bumble"), ALL, { edit: endedOn(origin, site) }) }), "bumble");
    assert.deepEqual(entry.refusals, ALL.map((repetition) => refusal(repetition, shownOrigin, shownSite, "bumble.com")), label);
  }
  // A run that records no observed subject at all did not end on the candidate's site.
  const unobserved = judged(await judge({ bumble: withOn(counted("bumble"), ALL, { edit: (report) => { delete report.run.subject.observed; } }) }), "bumble");
  assert.deepEqual(unobserved.refusals, ALL.map((repetition) => refusal(repetition, "no recorded origin", "none", "bumble.com")));
});

test("a qualifying case is a signal case when its known-tracker and Shields-blocked medians are each at least 8, and who.int at a median of 7 qualifies without being one", async () => {
  // [who.int's replaced counts, signal case, the reason it is passed over]
  const cases: Array<[Record<string, number | number[]>, boolean, string[]]> = [
    [{ knownTrackerRequests: 8, shieldsBlockedRequests: 8 }, true, []],
    [{ knownTrackerRequests: 7 }, false, ["is not a signal case: its median knownTrackerRequests is 7, under 8"]],
    [{ shieldsBlockedRequests: 7 }, false, ["is not a signal case: its median shieldsBlockedRequests is 7, under 8"]],
    [{ knownTrackerRequests: 7, shieldsBlockedRequests: 6 }, false, ["is not a signal case: its median knownTrackerRequests is 7, under 8", "is not a signal case: its median shieldsBlockedRequests is 6, under 8"]],
    // The median decides, not the smallest or the largest run.
    [{ knownTrackerRequests: [7, 7, 8, 8, 8] }, true, []],
    [{ knownTrackerRequests: [7, 7, 7, 8, 8] }, false, ["is not a signal case: its median knownTrackerRequests is 7, under 8"]]
  ];
  // ssa.gov is refused for a loss every one of its five runs shares, so who.int is considered.
  const ssaRefused = ALL.map((repetition) => `repetition ${repetition} records capture loss in a family a canary metric is counted from: fingerprinting/dropped/fingerprint-observer`);
  for (const [replace, signalCase, reasons] of cases) {
    const context = JSON.stringify(replace);
    const verdict = await judge({ "ssa-gov": withOn(counted("ssa-gov"), ALL, { losses: [FINGERPRINT_LOSS] }), "who-int": counted("who-int", replace) });
    const who = judged(verdict, "who-int");
    assert.equal(who.qualifies, true, context);
    assert.deepEqual(who.refusals, [], context);
    assert.equal(who.signalCase, signalCase, context);
    assert.deepEqual(judged(verdict, "ssa-gov").refusals, ssaRefused, context);
    assert.deepEqual(verdict.slots[1], {
      outgoing: "gov.uk",
      taker: signalCase ? "who.int" : null,
      considered: [
        { domain: "ssa.gov", takes: false, reasons: [`does not qualify (${ssaRefused.join("; ")})`] },
        { domain: "who.int", takes: signalCase, reasons }
      ]
    }, context);
    assert.deepEqual(caseIds(verdict.panel), ["wikipedia", "github", "python", signalCase ? "who-int" : "gov-uk", "bumble"], context);
    // When gov.uk stays, the tracker and Shields signal rests on one site.
    assert.deepEqual(verdict.signalSites, signalCase ? ["bumble.com", "who.int"] : ["bumble.com"], context);
  }
});

test("bumble.com takes the Guardian's slot only if a zeroed count would still fail on each of the Guardian's five metrics, and the verdict names the metric that would not", async () => {
  // Of the five, the two signal metrics are above their tolerance at any
  // median of 8 or more. The other three sit on the absolute term.
  // [metric, a median on its tolerance, the tolerance]
  const cases: Array<[string, number, number]> = [
    ["thirdPartyDomains", 3, 3],
    ["thirdPartyCookies", 3, 3],
    ["storageEntries", 4, 4]
  ];
  for (const [metric, median, tolerance] of cases) {
    const verdict = await judge({ bumble: counted("bumble", { [metric]: median }) });
    const bumble = judged(verdict, "bumble");
    assert.equal(bumble.qualifies, true, metric);
    assert.equal(bumble.signalCase, true, metric);
    assert.equal(row(bumble, metric).zeroingFails, false, metric);
    assert.deepEqual(verdict.slots[0], {
      outgoing: "theguardian.com",
      taker: null,
      considered: [{ domain: "bumble.com", takes: false, reasons: [`would not fail a zeroed ${metric}: its median ${median} is not above the tolerance ${tolerance} at that median`] }]
    }, metric);
    // The Guardian stays and still carries all five. ssa.gov takes gov.uk's slot as before.
    assert.deepEqual(caseIds(verdict.panel), ["wikipedia", "github", "python", "ssa-gov", "guardian"], metric);
    assert.deepEqual(verdict.coverage.map((entry) => entry.through[0]), Array.from({ length: 5 }, () => ({ caseId: "guardian", retained: true })), metric);
    assert.deepEqual(verdict.signalSites, ["theguardian.com", "ssa.gov"], metric);
    // One count more and a zeroed count fails, so bumble takes the slot.
    const above = await judge({ bumble: counted("bumble", { [metric]: median + 1 }) });
    assert.equal(row(judged(above, "bumble"), metric).zeroingFails, true, metric);
    assert.equal(takers(above)["theguardian.com"], "bumble.com", metric);
  }
  // Two of the five at once are both named, with the signal reason ahead of them.
  const several = await judge({ bumble: counted("bumble", { knownTrackerRequests: 7, thirdPartyCookies: 0, storageEntries: 2 }) });
  assert.deepEqual(several.slots[0].considered[0].reasons, [
    "is not a signal case: its median knownTrackerRequests is 7, under 8",
    "would not fail a zeroed thirdPartyCookies: its median 0 is not above the tolerance 3 at that median",
    "would not fail a zeroed storageEntries: its median 2 is not above the tolerance 4 at that median"
  ]);
  // gov.uk's slot asks for no such metric: ssa.gov carries neither third-party cookies nor storage and still takes it.
  assert.equal(takers(several)["gov.uk"], "ssa.gov");
});

test("the slots are decided for every combination of qualifying candidates, only bumble.com may replace the Guardian, and the order ssa.gov then who.int does not follow the panel file", async () => {
  const out = (caseId: string): CaseScript => withOn(counted(caseId), [2], BLOCKED);
  const quiet = (caseId: string): CaseScript => counted(caseId, { knownTrackerRequests: 2, shieldsBlockedRequests: 5 });
  // [bumble, ssa.gov, who.int: "in" qualifies as a signal case, "out" does
  // not qualify, "quiet" qualifies without signal], the resulting cases or
  // null when the panel does not change, and the signal sites.
  const combinations: Array<[[string, string, string], string[] | null, string[]]> = [
    [["out", "out", "out"], null, ["theguardian.com"]],
    [["quiet", "quiet", "quiet"], null, ["theguardian.com"]],
    [["in", "out", "out"], ["wikipedia", "github", "python", "gov-uk", "bumble"], ["bumble.com"]],
    [["in", "quiet", "quiet"], ["wikipedia", "github", "python", "gov-uk", "bumble"], ["bumble.com"]],
    [["in", "in", "out"], ["wikipedia", "github", "python", "ssa-gov", "bumble"], ["bumble.com", "ssa.gov"]],
    [["in", "out", "in"], ["wikipedia", "github", "python", "who-int", "bumble"], ["bumble.com", "who.int"]],
    [["in", "quiet", "in"], ["wikipedia", "github", "python", "who-int", "bumble"], ["bumble.com", "who.int"]],
    [["in", "in", "in"], ["wikipedia", "github", "python", "ssa-gov", "bumble"], ["bumble.com", "ssa.gov"]],
    // Without bumble the Guardian stays whatever else qualifies: no other
    // candidate may take its slot.
    [["out", "in", "out"], ["wikipedia", "github", "python", "ssa-gov", "guardian"], ["theguardian.com", "ssa.gov"]],
    [["out", "out", "in"], ["wikipedia", "github", "python", "who-int", "guardian"], ["theguardian.com", "who.int"]],
    [["out", "in", "in"], ["wikipedia", "github", "python", "ssa-gov", "guardian"], ["theguardian.com", "ssa.gov"]],
    [["quiet", "in", "in"], ["wikipedia", "github", "python", "ssa-gov", "guardian"], ["theguardian.com", "ssa.gov"]]
  ];
  const scripts: Record<string, (caseId: string) => CaseScript> = { in: (caseId) => counted(caseId), out, quiet };
  // The same candidates listed in another order in the panel file decide the same slots.
  const reordered = { ...structuredClone(qualificationPanel), cases: [qualificationPanel.cases[2], qualificationPanel.cases[1], qualificationPanel.cases[0]] };
  for (const [[bumble, ssa, who], cases, signalSites] of combinations) {
    const context = `bumble ${bumble}, ssa.gov ${ssa}, who.int ${who}`;
    const scenario: Scenario = { bumble: scripts[bumble]("bumble"), "ssa-gov": scripts[ssa]("ssa-gov"), "who-int": scripts[who]("who-int") };
    for (const onPanel of [qualificationPanel, reordered]) {
      const verdict = await judge(scenario, onPanel);
      assert.deepEqual(caseIds(verdict.panel), cases, context);
      assert.deepEqual(verdict.signalSites, signalSites, context);
      assert.equal(verdict.panelText === null, cases === null, context);
      assert.equal(verdict.panelDigest === null, cases === null, context);
      assert.equal(takers(verdict)["theguardian.com"], bumble === "in" ? "bumble.com" : null, context);
      assert.equal(takers(verdict)["gov.uk"], ssa === "in" ? "ssa.gov" : who === "in" ? "who.int" : null, context);
      if (verdict.panel) {
        assert.equal(verdict.panel.panelVersion, 2, context);
        assert.equal(verdict.panel.repetitions, 3, context);
        (await helpers).assertPanelCatalogMembership((await helpers).assertPanel(verdict.panel), catalogs);
      }
      // Each of the Guardian's five metrics is carried by a case of the
      // resulting panel: the Guardian where it stays, bumble where it does not.
      for (const entry of verdict.coverage) assert.equal(entry.through[0]?.caseId, bumble === "in" ? "bumble" : "guardian", `${context}: ${entry.metric}`);
    }
  }
});

test("the verdict prints the rule, every case with its runs and reasons, each slot, what the new panel carries, and the next panel or that the panel does not change", async () => {
  const h = await helpers;
  const mixed = await judge({
    "ssa-gov": withOn(counted("ssa-gov"), ALL, { losses: [FINGERPRINT_LOSS] }),
    "who-int": counted("who-int", { knownTrackerRequests: 7 })
  });
  const digest = h.panelDigest(qualificationPanel);
  const ssaRefusals = ALL.map((repetition) => `repetition ${repetition} records capture loss in a family a canary metric is counted from: fingerprinting/dropped/fingerprint-observer`);
  assert.deepEqual(h.formatQualificationVerdict(mixed), [
    `RULE panel-qualification-2026-11-10 (sha256 ${h.qualificationRuleDigest()}): fixed on 2026-11-10, before any qualifying capture`,
    `RECEIPT build ${BUILD}, qualification panel toolchain-canary-qualification-2026-11 (sha256 ${digest}), 15 of 15 scans recorded, created 2026-11-10T12:00:00.000Z; it would change monthly-toolchain-canary-v1 (version 1, sha256 ${h.panelDigest(panelV1)})`,
    "CAPTURE finished; staging health after the last scan passed",
    "CASE bumble (bumble.com): QUALIFIES, SIGNAL case; 5 of 5 runs complete",
    "  METRIC bumble.totalRequests: runs 112, 112, 112, 112, 112; median 112; spread 0; tolerance 22.400000000000002; within",
    "  METRIC bumble.thirdPartyRequests: runs 80, 80, 80, 80, 80; median 80; spread 0; tolerance 20; within",
    "  METRIC bumble.knownTrackerRequests: runs 30, 30, 30, 30, 30; median 30; spread 0; tolerance 9; within",
    "  METRIC bumble.thirdPartyDomains: runs 15, 15, 15, 15, 15; median 15; spread 0; tolerance 3.75; within",
    "  METRIC bumble.cookies: runs 28, 28, 28, 28, 28; median 28; spread 0; tolerance 8.4; within",
    "  METRIC bumble.thirdPartyCookies: runs 10, 10, 10, 10, 10; median 10; spread 0; tolerance 3; within",
    "  METRIC bumble.storageEntries: runs 9, 9, 9, 9, 9; median 9; spread 0; tolerance 4; within",
    "  METRIC bumble.fingerprintEvents: runs 0, 0, 0, 0, 0; median 0; spread 0; tolerance 3; within",
    "  METRIC bumble.shieldsBlockedRequests: runs 36, 36, 36, 36, 36; median 36; spread 0; tolerance 10.799999999999999; within",
    "  SIGNAL bumble: median knownTrackerRequests 30 is at least 8; median shieldsBlockedRequests 36 is at least 8",
    "  ZEROING bumble: at these medians a zeroed count would fail on totalRequests, thirdPartyRequests, knownTrackerRequests, thirdPartyDomains, cookies, thirdPartyCookies, storageEntries, shieldsBlockedRequests",
    "CASE ssa-gov (ssa.gov): NOT QUALIFIED; 5 of 5 runs complete",
    ...ssaRefusals.map((refusal) => `  REFUSED ssa-gov: ${refusal}`),
    "  METRIC ssa-gov.totalRequests: runs 73, 73, 73, 73, 73; median 73; spread 0; tolerance 14.600000000000001; within",
    "  METRIC ssa-gov.thirdPartyRequests: runs 40, 40, 40, 40, 40; median 40; spread 0; tolerance 10; within",
    "  METRIC ssa-gov.knownTrackerRequests: runs 11, 11, 11, 11, 11; median 11; spread 0; tolerance 3.3; within",
    "  METRIC ssa-gov.thirdPartyDomains: runs 9, 9, 9, 9, 9; median 9; spread 0; tolerance 3; within",
    "  METRIC ssa-gov.cookies: runs 4, 4, 4, 4, 4; median 4; spread 0; tolerance 4; within",
    "  METRIC ssa-gov.thirdPartyCookies: runs 0, 0, 0, 0, 0; median 0; spread 0; tolerance 3; within",
    "  METRIC ssa-gov.storageEntries: runs 1, 1, 1, 1, 1; median 1; spread 0; tolerance 4; within",
    "  METRIC ssa-gov.fingerprintEvents: runs 0, 0, 0, 0, 0; median 0; spread 0; tolerance 3; within",
    "  METRIC ssa-gov.shieldsBlockedRequests: runs 16, 16, 16, 16, 16; median 16; spread 0; tolerance 4.8; within",
    "  SIGNAL ssa-gov: median knownTrackerRequests 11 is at least 8; median shieldsBlockedRequests 16 is at least 8",
    "  ZEROING ssa-gov: at these medians a zeroed count would fail on totalRequests, thirdPartyRequests, knownTrackerRequests, thirdPartyDomains, shieldsBlockedRequests",
    "CASE who-int (who.int): QUALIFIES, not a signal case; 5 of 5 runs complete",
    "  METRIC who-int.totalRequests: runs 122, 122, 122, 122, 122; median 122; spread 0; tolerance 24.400000000000002; within",
    "  METRIC who-int.thirdPartyRequests: runs 70, 70, 70, 70, 70; median 70; spread 0; tolerance 17.5; within",
    "  METRIC who-int.knownTrackerRequests: runs 7, 7, 7, 7, 7; median 7; spread 0; tolerance 3; within",
    "  METRIC who-int.thirdPartyDomains: runs 16, 16, 16, 16, 16; median 16; spread 0; tolerance 4; within",
    "  METRIC who-int.cookies: runs 15, 15, 15, 15, 15; median 15; spread 0; tolerance 4.5; within",
    "  METRIC who-int.thirdPartyCookies: runs 3, 3, 3, 3, 3; median 3; spread 0; tolerance 3; within",
    "  METRIC who-int.storageEntries: runs 2, 2, 2, 2, 2; median 2; spread 0; tolerance 4; within",
    "  METRIC who-int.fingerprintEvents: runs 0, 0, 0, 0, 0; median 0; spread 0; tolerance 3; within",
    "  METRIC who-int.shieldsBlockedRequests: runs 18, 18, 18, 18, 18; median 18; spread 0; tolerance 5.3999999999999995; within",
    "  SIGNAL who-int: median knownTrackerRequests 7 is under 8; median shieldsBlockedRequests 18 is at least 8",
    "  ZEROING who-int: at these medians a zeroed count would fail on totalRequests, thirdPartyRequests, knownTrackerRequests, thirdPartyDomains, cookies, shieldsBlockedRequests",
    "SLOT theguardian.com: bumble.com takes it",
    `SLOT gov.uk: ssa.gov does not qualify (${ssaRefusals.join("; ")})`,
    "SLOT gov.uk: who.int is not a signal case: its median knownTrackerRequests is 7, under 8",
    "SLOT gov.uk: stays",
    "CARRIES knownTrackerRequests: bumble (median 30, tolerance 9)",
    "CARRIES thirdPartyDomains: bumble (median 15, tolerance 3.75)",
    "CARRIES thirdPartyCookies: bumble (median 10, tolerance 3)",
    "CARRIES storageEntries: bumble (median 9, tolerance 4)",
    "CARRIES shieldsBlockedRequests: bumble (median 36, tolerance 10.799999999999999)",
    "SIGNAL SITES one: the tracker and Shields signal of the resulting panel rests on bumble.com alone",
    `PANEL version 2, monthly-toolchain-canary-v2 (sha256 ${mixed.panelDigest}): the next panel follows. Commit it as scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json and as the current panel file before any comparison capture; --panel-out writes these bytes to a file`,
    ...(mixed.panelText ?? "").trimEnd().split("\n")
  ]);

  // Nothing qualifies: the panel does not change, and the lines say why.
  const none = h.formatQualificationVerdict(await judge({
    bumble: withOn(counted("bumble"), ALL, BLOCKED),
    "ssa-gov": withOn(counted("ssa-gov"), [3], { noReport: "failed" }),
    "who-int": counted("who-int", { shieldsBlockedRequests: [18, 18, 18, 18, 30] })
  }));
  assert.equal(none[3], "CASE bumble (bumble.com): NOT QUALIFIED; 0 of 5 runs complete");
  assert.equal(none[4], `  REFUSED bumble: repetition 1 did not complete: ${BLOCKED_FACTS}`);
  assert.equal(none[9], "  NO STATISTICS bumble: medians, spreads and tolerances are those of a whole arm, and not every run completed");
  assert.equal(none[10], "CASE ssa-gov (ssa.gov): NOT QUALIFIED; 4 of 5 runs complete");
  assert.ok(none.includes("  REFUSED who-int: shieldsBlockedRequests spread 12 is over the tolerance 5.3999999999999995 at its median 18 (runs 18, 18, 18, 18, 30)"));
  assert.ok(none.includes("  METRIC who-int.shieldsBlockedRequests: runs 18, 18, 18, 18, 30; median 18; spread 12; tolerance 5.3999999999999995; over"));
  assert.deepEqual(none.slice(-12), [
    `SLOT theguardian.com: bumble.com does not qualify (${ALL.map((repetition) => `repetition ${repetition} did not complete: ${BLOCKED_FACTS}`).join("; ")}); its signal and zeroing conditions were not evaluated, because not every run completed`,
    "SLOT theguardian.com: stays",
    "SLOT gov.uk: ssa.gov does not qualify (repetition 3 did not complete: the scan job failed and saved no report; the staging job status gives no cause); its signal and zeroing conditions were not evaluated, because not every run completed",
    "SLOT gov.uk: who.int does not qualify (shieldsBlockedRequests spread 12 is over the tolerance 5.3999999999999995 at its median 18 (runs 18, 18, 18, 18, 30))",
    "SLOT gov.uk: stays",
    "CARRIES knownTrackerRequests: guardian (stays; not measured by this capture)",
    "CARRIES thirdPartyDomains: guardian (stays; not measured by this capture)",
    "CARRIES thirdPartyCookies: guardian (stays; not measured by this capture)",
    "CARRIES storageEntries: guardian (stays; not measured by this capture)",
    "CARRIES shieldsBlockedRequests: guardian (stays; not measured by this capture)",
    "SIGNAL SITES one: the tracker and Shields signal of the resulting panel rests on theguardian.com alone",
    "PANEL UNCHANGED: no candidate took a slot, so monthly-toolchain-canary-v1 stays the current panel"
  ]);
});

test("an empty, partial or malformed qualification receipt is refused and never read as cases that did not qualify", async () => {
  const h = await helpers;
  const good = await qualificationReceipt({ bumble: withOn(counted("bumble"), [2], BLOCKED), "ssa-gov": withOn(counted("ssa-gov"), [3], { noReport: "failed" }) });
  const read = (receipt: unknown) => verdictOn(receipt);
  assert.equal((await read(good)).scans, 15);
  const blocked = (receipt: Receipt) => receipt.incompleteRuns.find((entry: Receipt) => entry.stage === "report");
  const noReport = (receipt: Receipt) => receipt.incompleteRuns.find((entry: Receipt) => entry.stage === "job");
  const notReceipts: Array<[string, unknown, RegExp]> = [
    ["nothing", undefined, /Invalid canary qualification receipt/],
    ["null", null, /Invalid canary qualification receipt/],
    ["an empty object", {}, /Invalid canary qualification receipt/],
    ["a list", [structuredClone(good)], /Invalid canary qualification receipt/],
    ["a capture receipt", committedReceipt("toolchain-epoch-2026-11/round-1-candidate-receipt.json"), /A capture receipt is one arm of a comparison, not a qualification receipt/]
  ];
  for (const [label, value, message] of notReceipts) await assert.rejects(read(value), message, label);
  const refusals: Array<[string, (receipt: Receipt) => void, RegExp]> = [
    ["another kind", (receipt) => { receipt.kind = "site-behavior-toolchain-canary"; }, /Invalid canary qualification receipt/],
    ["another receipt version", (receipt) => { receipt.receiptVersion = 1; }, /Invalid canary qualification receipt/],
    ["no creation time", (receipt) => { delete receipt.createdAt; }, /Receipt has no creation time/],
    ["a creation time that is no timestamp", (receipt) => { receipt.createdAt = "2026-11-10"; }, /Receipt has no creation time/],
    ["another origin", (receipt) => { receipt.origin = "https://scan.sitebehavior.org"; }, /origin\/build\/panel identity is invalid/],
    ["a short build", (receipt) => { receipt.expectedBuild = "cccccccc"; }, /origin\/build\/panel identity is invalid/],
    ["another panel digest", (receipt) => { receipt.panelDigest = "0".repeat(64); }, /does not use the committed qualification panel/],
    ["an edited panel under the committed digest", (receipt) => { receipt.panel.repetitions = 3; }, /does not use the committed qualification panel/],
    ["no panel", (receipt) => { delete receipt.panel; }, /does not use the committed qualification panel/],
    // The capture's end must be stated, and stated consistently.
    ["no statement that it finished", (receipt) => { delete receipt.finished; }, /does not say consistently whether its capture finished/],
    ["finished with no health read recorded", (receipt) => { receipt.healthAfter = null; }, /does not say consistently whether its capture finished/],
    ["finished and ended early at once", (receipt) => { receipt.endedEarly = "scan 3 ended the capture"; }, /does not say consistently whether its capture finished/],
    ["a failed health read with no reason", (receipt) => { receipt.healthAfter = { ok: false }; }, /does not say consistently whether its capture finished/],
    ["a health read with something else in it", (receipt) => { receipt.healthAfter = { ok: true, deployment: BUILD }; }, /does not say consistently whether its capture finished/],
    ["a health read that is not a record", (receipt) => { receipt.healthAfter = "ok"; }, /does not say consistently whether its capture finished/],
    ["not finished with a health read after it", (receipt) => { receipt.finished = false; }, /does not say consistently whether its capture finished/],
    ["an empty reason for an early end", (receipt) => { receipt.finished = false; receipt.healthAfter = null; receipt.endedEarly = ""; }, /does not say consistently whether its capture finished/],
    // A finished receipt holds every scan. No runs at all is not "nothing qualified".
    ["no runs", (receipt) => { receipt.runs = []; receipt.incompleteRuns = []; }, /incomplete panel coverage/],
    ["no run lists", (receipt) => { delete receipt.runs; }, /must list its complete and its incomplete runs/],
    ["no incomplete list", (receipt) => { delete receipt.incompleteRuns; }, /must list its complete and its incomplete runs/],
    ["a case with a run missing", (receipt) => { receipt.runs.pop(); }, /incomplete panel coverage/],
    ["a whole case missing", (receipt) => { receipt.runs = receipt.runs.filter((entry: Receipt) => entry.caseId !== "who-int"); }, /incomplete panel coverage/],
    ["a dropped incomplete run", (receipt) => { receipt.incompleteRuns.pop(); }, /incomplete panel coverage/],
    ["a run recorded twice", (receipt) => { receipt.runs.push(structuredClone(receipt.runs[0])); }, /run order or coverage is invalid/],
    ["a run of a case outside the panel", (receipt) => { receipt.runs.push({ ...structuredClone(receipt.runs[0]), caseId: "nick", sequence: 16 }); }, /incomplete panel coverage/],
    ["a run in another run's place", (receipt) => { receipt.runs[0].repetition = 3; }, /incomplete panel coverage/],
    ["a run out of sequence", (receipt) => { receipt.runs[0].sequence = 99; }, /run order or coverage is invalid/],
    ["runs out of order", (receipt) => { receipt.runs.reverse(); }, /run order or coverage is invalid/],
    ["a run that is not an object", (receipt) => { receipt.runs[0] = "bumble:1"; }, /run order or coverage is invalid/],
    ["a repetition given as a string", (receipt) => { receipt.runs[0].repetition = "1"; }, /run order or coverage is invalid/],
    ["a repetition given as a list", (receipt) => { receipt.runs[0].repetition = [1]; }, /run order or coverage is invalid/],
    ["a sequence given as a string", (receipt) => { receipt.runs[0].sequence = "1"; }, /run order or coverage is invalid/],
    // Each run is a scan of its own.
    ["a repeated report id", (receipt) => { receipt.runs[1].reportId = receipt.runs[0].reportId; receipt.runs[1].reportJsonPath = receipt.runs[0].reportJsonPath; }, /report identity is invalid/],
    ["a repeated run id", (receipt) => { receipt.runs[1].runId = receipt.runs[0].runId; }, /repeats a run id or a report wire digest/],
    ["a repeated wire digest", (receipt) => { receipt.runs[3].reportWireSha256 = receipt.runs[0].reportWireSha256; }, /repeats a run id or a report wire digest/],
    ["one run pasted over the next under that run's report id", (receipt) => {
      const [first, second] = receipt.runs;
      receipt.runs[1] = { ...structuredClone(first), repetition: second.repetition, sequence: second.sequence, reportId: second.reportId, reportJsonPath: second.reportJsonPath };
    }, /repeats a run id or a report wire digest/],
    ["a blocked run sharing a complete run's wire digest", (receipt) => { blocked(receipt).reportWireSha256 = receipt.runs[0].reportWireSha256; }, /repeats a run id or a report wire digest/],
    ["a run with no run id", (receipt) => { delete receipt.runs[0].runId; }, /repeats a run id or a report wire digest/],
    // A run listed as complete is held to the facts it records.
    ["a blocked run listed as complete", (receipt) => { receipt.runs[0].qualityFacts.status = 403; }, /failed, bot-wall, timeout, or budget quality facts/],
    ["a run of another build listed as complete", (receipt) => { receipt.runs[0].provenance.buildCommit = "d".repeat(40); }, /invalid run provenance/],
    ["a complete run with a count missing", (receipt) => { delete receipt.runs[0].counts.cookies; }, /missing a canary count metric/],
    ["a complete run with a count that is no integer", (receipt) => { receipt.runs[0].counts.cookies = 28.5; }, /missing a canary count metric/],
    ["a complete run that states a reason", (receipt) => { receipt.runs[0].notComplete = ["the document status was 403"]; }, /listed as complete states a reason against itself/],
    // A run listed as not complete must give its stated reasons from its own facts.
    ["a stated reason the facts do not give", (receipt) => { blocked(receipt).notComplete = ["the page title matched a bot wall"]; }, /states a reason its recorded facts do not give/],
    ["a complete run listed as not complete", (receipt) => { const entry = blocked(receipt); entry.qualityFacts.status = 200; entry.quality.run = { outcome: "complete", reasons: [] }; }, /states a reason its recorded facts do not give/],
    ["a complete run listed as not complete with no reason", (receipt) => { const entry = blocked(receipt); entry.qualityFacts.status = 200; entry.quality.run = { outcome: "complete", reasons: [] }; entry.notComplete = []; }, /states a reason its recorded facts do not give/],
    ["an incomplete run with no reasons", (receipt) => { delete blocked(receipt).notComplete; }, /states a reason its recorded facts do not give/],
    ["an incomplete run of another build", (receipt) => { blocked(receipt).provenance.buildCommit = "d".repeat(40); }, /invalid run provenance/],
    ["an incomplete run with malformed facts", (receipt) => { blocked(receipt).qualityFacts.botWallTitleMatched = "no"; }, /malformed quality facts/],
    ["an incomplete run of an unknown stage", (receipt) => { blocked(receipt).stage = "poll"; }, /incomplete run of an unknown stage/],
    ["a no-report record with a report beside it", (receipt) => { noReport(receipt).reportId = `20261110-${"a".repeat(32)}`; }, /malformed record of a scan that left no report/],
    ["a no-report record in words of its own", (receipt) => { noReport(receipt).notComplete = ["the site was down"]; }, /malformed record of a scan that left no report/],
    ["a no-report record with two reasons", (receipt) => { noReport(receipt).notComplete = [h.JOB_FACTS.failed, h.JOB_FACTS.expired]; }, /malformed record of a scan that left no report/],
    ["a no-report record with no reason", (receipt) => { delete noReport(receipt).notComplete; }, /malformed record of a scan that left no report/],
    ["a run that requested another site", (receipt) => { receipt.runs[0].subject.requested.origin = "https://example.org"; }, /did not request its panel case/]
  ];
  for (const [label, edit, message] of refusals) {
    const receipt = structuredClone(good);
    edit(receipt);
    await assert.rejects(read(receipt), message, label);
  }
  // Every other way a scan can leave no report is a word the receipt may use.
  for (const fact of Object.values(h.JOB_FACTS)) {
    const receipt = structuredClone(good);
    noReport(receipt).notComplete = [fact];
    assert.deepEqual(judged(await read(receipt), "ssa-gov").refusals, [`repetition 3 did not complete: ${fact}`]);
  }
});

test("a receipt names the rule it was captured under and the panel that rule would change, and a verdict is refused under any other rule or panel", async () => {
  const h = await helpers;
  const good = await qualificationReceipt();
  // The digest covers every name and number of the rule, the conditions of
  // QUALIFIES among them. It is pinned here, so a change to the rule shows as
  // a change to this value: it moved when the observed-site condition was added.
  assert.equal(h.qualificationRuleDigest(), "6b4d7bc85806da0feb5a097e264a6fad5defae2a6b44557080782f19d0535285");
  assert.equal(h.qualificationRuleDigest(), createHash("sha256").update(JSON.stringify({
    fixedOn: "2026-11-10",
    fromPanelVersion: 1,
    id: "panel-qualification-2026-11-10",
    qualifies: ["every-run-complete", "2xx-document", "no-capture-loss-in-a-metric-family", "observed-origin-and-site-are-the-candidate", "one-subject", "one-set-of-conditions", "spread-within-tolerance"],
    signalMedianFloor: 8,
    signalMetrics: ["knownTrackerRequests", "shieldsBlockedRequests"],
    slots: [
      { candidates: ["bumble.com"], mustCarry: ["knownTrackerRequests", "thirdPartyDomains", "thirdPartyCookies", "storageEntries", "shieldsBlockedRequests"], outgoing: "theguardian.com" },
      { candidates: ["ssa.gov", "who.int"], mustCarry: [], outgoing: "gov.uk" }
    ]
  })).digest("hex"));
  const verdict = await verdictOn(good);
  assert.deepEqual([verdict.rule, verdict.ruleDigest, verdict.fromPanelId, verdict.fromPanelVersion, verdict.fromPanelDigest], ["panel-qualification-2026-11-10", h.qualificationRuleDigest(), "monthly-toolchain-canary-v1", 1, h.panelDigest(panelV1)]);
  const otherDigest = "1".repeat(64);
  const refusals: Array<[string, (receipt: Receipt) => void, { message: string }]> = [
    ["a rule with other numbers under the same id", (receipt) => { receipt.rule.digest = otherDigest; }, {
      message: `The receipt was captured under qualification rule panel-qualification-2026-11-10 (sha256 ${otherDigest}), and the rule in this code is panel-qualification-2026-11-10 (sha256 ${h.qualificationRuleDigest()}). A verdict is given only under the rule the capture ran under: read the receipt from a checkout that holds that rule.`
    }],
    ["another rule", (receipt) => { receipt.rule.id = "panel-qualification-2027-01-05"; }, {
      message: `The receipt was captured under qualification rule panel-qualification-2027-01-05 (sha256 ${h.qualificationRuleDigest()}), and the rule in this code is panel-qualification-2026-11-10 (sha256 ${h.qualificationRuleDigest()}). A verdict is given only under the rule the capture ran under: read the receipt from a checkout that holds that rule.`
    }],
    ["no rule", (receipt) => { delete receipt.rule; }, { message: "The receipt does not record the qualification rule it was captured under." }],
    ["a rule with no digest", (receipt) => { delete receipt.rule.digest; }, { message: "The receipt does not record the qualification rule it was captured under." }],
    ["no panel to change", (receipt) => { delete receipt.fromPanelVersion; }, { message: "The receipt does not record the panel it would change." }],
    ["no digest of the panel to change", (receipt) => { delete receipt.fromPanelDigest; }, { message: "The receipt does not record the panel it would change." }],
    ["a panel to change that is not the committed one", (receipt) => { receipt.fromPanelDigest = otherDigest; }, { message: `The receipt would change panel version 1 (sha256 ${otherDigest}), and no committed panel is that panel.` }],
    ["a version to change that is not committed", (receipt) => { receipt.fromPanelVersion = 2; }, { message: `The receipt would change panel version 2 (sha256 ${h.panelDigest(panelV1)}), and no committed panel is that panel.` }]
  ];
  for (const [label, edit, refusal] of refusals) {
    const receipt = structuredClone(good);
    edit(receipt);
    await assert.rejects(verdictOn(receipt), refusal, label);
  }
});

test("a receipt that is not finished is still read: a case with all its runs recorded is judged, and a case without them is not judged and takes no slot", async () => {
  const h = await helpers;
  const whole = await qualificationReceipt();
  // The first k scans of a capture, as the receipt on disk holds them before scan k + 1.
  const upTo = (count: number, endedEarly: string | null = null): Receipt => ({
    ...structuredClone(whole),
    runs: structuredClone(whole.runs.slice(0, count)),
    finished: false,
    endedEarly,
    healthAfter: null
  });
  // [scans recorded, judged cases, the slots]
  const cases: Array<[number, Array<[string, boolean, number]>, Record<string, string | null>, string[] | null]> = [
    [0, [["bumble", false, 0], ["ssa-gov", false, 0], ["who-int", false, 0]], { "theguardian.com": null, "gov.uk": null }, null],
    [4, [["bumble", false, 4], ["ssa-gov", false, 0], ["who-int", false, 0]], { "theguardian.com": null, "gov.uk": null }, null],
    [5, [["bumble", true, 5], ["ssa-gov", false, 0], ["who-int", false, 0]], { "theguardian.com": "bumble.com", "gov.uk": null }, ["wikipedia", "github", "python", "gov-uk", "bumble"]],
    [9, [["bumble", true, 5], ["ssa-gov", false, 4], ["who-int", false, 0]], { "theguardian.com": "bumble.com", "gov.uk": null }, ["wikipedia", "github", "python", "gov-uk", "bumble"]],
    [10, [["bumble", true, 5], ["ssa-gov", true, 5], ["who-int", false, 0]], { "theguardian.com": "bumble.com", "gov.uk": "ssa.gov" }, ["wikipedia", "github", "python", "ssa-gov", "bumble"]],
    [15, [["bumble", true, 5], ["ssa-gov", true, 5], ["who-int", true, 5]], { "theguardian.com": "bumble.com", "gov.uk": "ssa.gov" }, ["wikipedia", "github", "python", "ssa-gov", "bumble"]]
  ];
  for (const [count, expected, slots, panel] of cases) {
    const verdict = await verdictOn(upTo(count));
    assert.deepEqual([verdict.finished, verdict.scans, verdict.panelScans], [false, count, 15], String(count));
    assert.deepEqual(verdict.cases.map((entry) => [entry.caseId, entry.judged, entry.recordedRuns]), expected, String(count));
    assert.deepEqual(verdict.notJudged, expected.filter(([, wasJudged]) => !wasJudged).map(([caseId]) => caseId), String(count));
    assert.deepEqual(takers(verdict), slots, String(count));
    assert.deepEqual(caseIds(verdict.panel), panel, String(count));
    for (const entry of verdict.cases.filter((candidate) => !candidate.judged)) {
      assert.deepEqual([entry.qualifies, entry.signalCase, entry.metrics, entry.signal, entry.refusals], [false, false, null, null, []], `${count}: ${entry.caseId}`);
    }
  }
  // The scans a receipt records are the first scans of its panel. One with a
  // scan missing from the middle, or with a later scan and not the ones
  // before it, is no capture that stopped, and is refused.
  const gap = upTo(7);
  gap.runs.splice(3, 1);
  await assert.rejects(verdictOn(gap), /Qualification receipt has incomplete panel coverage/);
  const ahead = upTo(3);
  ahead.runs.push(structuredClone(whole.runs[9]));
  await assert.rejects(verdictOn(ahead), /Qualification receipt has incomplete panel coverage/);
  // What the verdict prints for a capture that a scan ended, with one case judged.
  const reason = "scan 8 of 15 (ssa-gov repetition 3) ended the capture: Saved report has invalid run provenance.";
  const lines = h.formatQualificationVerdict(await verdictOn(upTo(7, reason)));
  assert.equal(lines[1], `RECEIPT build ${BUILD}, qualification panel toolchain-canary-qualification-2026-11 (sha256 ${h.panelDigest(qualificationPanel)}), 7 of 15 scans recorded, created ${CREATED_AT}; it would change monthly-toolchain-canary-v1 (version 1, sha256 ${h.panelDigest(panelV1)})`);
  assert.equal(lines[2], `CAPTURE NOT FINISHED: ${reason}`);
  assert.equal(lines[3], "CASE bumble (bumble.com): QUALIFIES, SIGNAL case; 5 of 5 runs complete");
  for (const line of [
    "CASE ssa-gov (ssa.gov): NOT JUDGED; 2 of 5 runs recorded",
    "  NOT JUDGED ssa-gov: a case is judged on all of its runs, and the capture ended before they were recorded; it is treated as not qualified, so it takes no slot",
    "CASE who-int (who.int): NOT JUDGED; 0 of 5 runs recorded",
    "SLOT theguardian.com: bumble.com takes it",
    "SLOT gov.uk: ssa.gov was not judged (2 of 5 runs recorded), which counts as not qualified",
    "SLOT gov.uk: who.int was not judged (0 of 5 runs recorded), which counts as not qualified",
    "SLOT gov.uk: stays",
    "SIGNAL SITES one: the tracker and Shields signal of the resulting panel rests on bumble.com alone"
  ]) assert.ok(lines.includes(line), line);
  // A receipt whose command stopped without writing an end says so, and with no case judged the panel does not change.
  const stopped = h.formatQualificationVerdict(await verdictOn(upTo(3)));
  assert.equal(stopped[2], "CAPTURE NOT FINISHED: the receipt records no end, so the command stopped before it could write one");
  assert.equal(stopped.at(-1), "PANEL UNCHANGED: no candidate took a slot, so monthly-toolchain-canary-v1 stays the current panel; bumble, ssa-gov, who-int were not judged, which is not the same as judged and refused");
  // A candidate that is not judged counts as not qualified, so the next one in
  // the order is considered. In the committed panel order that cannot give a
  // slot to who.int over an unjudged ssa.gov, because ssa.gov is scanned first.
  const reordered = { ...structuredClone(qualificationPanel), cases: [qualificationPanel.cases[0], qualificationPanel.cases[2], qualificationPanel.cases[1]] };
  const reorderedWhole = await qualificationReceipt({}, reordered);
  const partial = { ...structuredClone(reorderedWhole), runs: structuredClone(reorderedWhole.runs.slice(0, 12)), finished: false, healthAfter: null };
  const judgedPartial = await verdictOn(partial, reordered);
  assert.deepEqual(judgedPartial.cases.map((entry) => [entry.caseId, entry.judged]), [["bumble", true], ["who-int", true], ["ssa-gov", false]]);
  assert.deepEqual(judgedPartial.slots[1].considered, [
    { domain: "ssa.gov", takes: false, reasons: ["was not judged (2 of 5 runs recorded), which counts as not qualified"] },
    { domain: "who.int", takes: true, reasons: [] }
  ]);
  // A finished receipt with a failed health read after it is judged in full, and the verdict says what was recorded.
  const unhealthy = { ...structuredClone(whole), healthAfter: { ok: false, reason: "Staging health must report status=ok and warnings=[]." } };
  const unhealthyVerdict = await verdictOn(unhealthy);
  assert.deepEqual(takers(unhealthyVerdict), { "theguardian.com": "bumble.com", "gov.uk": "ssa.gov" });
  assert.equal(h.formatQualificationVerdict(unhealthyVerdict)[2], "CAPTURE finished; staging health after the last scan did not pass and is recorded, not held against the runs, which each record their build: Staging health must report status=ok and warnings=[].");
  assert.equal(h.formatQualificationVerdict(await verdictOn(whole))[2], "CAPTURE finished; staging health after the last scan passed");
});

test("a region, browser or toolchain change during the capture costs the case it falls in, not the receipt", async () => {
  // [what changed on one run of ssa.gov, the parts its runs then differ in]
  const changes: Array<[string, (report: any) => void, string]> = [
    ["another egress region", (report) => { report.run.conditions.egress.region = "pdx03"; }, "conditions"],
    ["another browser version", (report) => { report.run.conditions.browser.version = "157.0.0.0"; }, "conditions"],
    ["another list snapshot", (report) => { report.run.toolchain.adblock.fetchedAt = "2026-11-10T06:00:00.000Z"; }, "toolchain"],
    ["another detector registry", (report) => { report.run.provenance.detectorRegistry.digest = "9".repeat(64); }, "provenance"],
    ["a region and a list snapshot", (report) => { report.run.conditions.egress.region = "pdx03"; report.run.toolchain.adblock.fetchedAt = "2026-11-10T06:00:00.000Z"; }, "conditions and toolchain"]
  ];
  for (const [label, edit, parts] of changes) {
    const verdict = await judge({ "ssa-gov": withOn(counted("ssa-gov"), [4], { edit }) });
    const ssa = judged(verdict, "ssa-gov");
    assert.equal(ssa.qualifies, false, label);
    assert.deepEqual(ssa.refusals, [`its runs were not all captured under one set of conditions and toolchain provenance (they differ in ${parts})`], label);
    // Its statistics are still shown, and the other cases are judged as they were.
    assert.equal(ssa.metrics?.length, 9, label);
    assert.deepEqual([judged(verdict, "bumble").qualifies, judged(verdict, "who-int").qualifies], [true, true], label);
    assert.deepEqual(takers(verdict), { "theguardian.com": "bumble.com", "gov.uk": "who.int" }, label);
  }
  // A change between two cases, each steady in itself, is held against neither.
  const elsewhere = (report: any) => { report.run.conditions.egress.region = "pdx03"; };
  const between = await judge({ "who-int": withOn(counted("who-int"), ALL, { edit: elsewhere }) });
  assert.deepEqual(between.cases.map((entry) => entry.qualifies), [true, true, true]);
});

test("the rule decides panel version 1 only, from the closed candidate list, under the tolerances of the panel it changes", async () => {
  const h = await helpers;
  const next = (await judge()).panel;
  assert.ok(next);
  const asFile = (panel: Panel): PanelFile => ({ name: `${panel.panelId}.json`, text: JSON.stringify(panel) });
  // A capture whose receipt names version 2 as the panel to change has nothing to decide.
  const fromNext = await qualificationReceipt({}, qualificationPanel, next);
  await assert.rejects(
    verdictOn(fromNext, qualificationPanel, [V1_FILE, asFile(next)]),
    { message: "Qualification rule panel-qualification-2026-11-10 changes panel version 1 only, and the current panel is version 2. A later panel change needs its own rule, fixed before its capture." }
  );
  assert.throws(() => h.assertQualificationApplies(qualificationPanel, next), /changes panel version 1 only, and the current panel is version 2/);
  // A version 1 panel that is not the one the rule was written for.
  const withoutGuardian = structuredClone(panelV1);
  withoutGuardian.cases[4] = { id: "nick", catalog: "public/featured-sites.json", domain: "nick.com", url: "https://www.nick.com/" };
  await assert.rejects(verdictOn(await qualificationReceipt({}, qualificationPanel, withoutGuardian), qualificationPanel, [asFile(withoutGuardian)]), /The current panel has no single theguardian\.com case/);
  const otherTolerances = structuredClone(panelV1);
  otherTolerances.metricTolerances.knownTrackerRequests.relative = 0.5;
  await assert.rejects(verdictOn(await qualificationReceipt({}, qualificationPanel, otherTolerances), qualificationPanel, [asFile(otherTolerances)]), /must carry the tolerance table of the current panel/);
  assert.throws(() => h.assertQualificationApplies(qualificationPanel, qualificationPanel), /Invalid toolchain canary panel/);

  // A candidate outside the closed list is refused, whatever its runs show.
  const open = structuredClone(qualificationPanel);
  open.cases[2] = { id: "nick", catalog: "public/featured-sites.json", domain: "nick.com", url: "https://www.nick.com/" };
  PROFILE.nick = PROFILE.bumble;
  try {
    h.assertQualificationPanel(open);
    h.assertQualificationPanelCatalogMembership(open, catalogs);
    const message = "Qualification case nick (nick.com) is not on the closed candidate list of rule panel-qualification-2026-11-10: bumble.com, ssa.gov, who.int.";
    await assert.rejects(verdictOn(await qualificationReceipt({}, open), open), { message });
    assert.throws(() => h.assertQualificationApplies(open, panelV1), { message });
  } finally {
    delete PROFILE.nick;
  }
  // So is a case the panel already holds.
  const already = structuredClone(qualificationPanel);
  already.cases[1] = { ...panelV1.cases[4] };
  assert.throws(() => h.assertQualificationApplies(already, panelV1), /is not on the closed candidate list/);
  // So is a candidate that a panel of version 1 already holds.
  const holdsCandidate = structuredClone(panelV1);
  holdsCandidate.cases[2] = { ...qualificationPanel.cases[1] };
  assert.throws(() => h.assertQualificationApplies(qualificationPanel, holdsCandidate), { message: "Qualification case ssa-gov is already a case of the current panel." });
  // A candidate missing from the capture cannot take its slot, and the verdict says so.
  const bumbleOnly = { ...structuredClone(qualificationPanel), cases: [qualificationPanel.cases[0]] };
  const partial = await judge({}, bumbleOnly);
  assert.deepEqual(partial.slots[1], {
    outgoing: "gov.uk",
    taker: null,
    considered: [
      { domain: "ssa.gov", takes: false, reasons: ["was not in the qualifying capture"] },
      { domain: "who.int", takes: false, reasons: ["was not in the qualifying capture"] }
    ]
  });
  assert.deepEqual(caseIds(partial.panel), ["wikipedia", "github", "python", "gov-uk", "bumble"]);
  // A receipt of one qualification panel is not read under another.
  await assert.rejects(verdictOn(await qualificationReceipt(), bumbleOnly), /does not use the committed qualification panel/);
});

test("the verdict on a receipt is the same once the panel it gives is committed and current, so it can be given again later", async () => {
  const h = await helpers;
  const receipt = await qualificationReceipt({ "ssa-gov": withOn(counted("ssa-gov"), [1], { losses: [STORAGE_LOSS] }), "who-int": counted("who-int", { knownTrackerRequests: 7 }) });
  const before = await verdictOn(receipt);
  assert.deepEqual(caseIds(before.panel), ["wikipedia", "github", "python", "gov-uk", "bumble"]);
  // With panel version 2 committed beside version 1, the verdict still reads version 1.
  const after = await verdictOn(receipt, qualificationPanel, [V1_FILE, { name: "monthly-toolchain-canary-v2.json", text: before.panelText ?? "" }]);
  assert.deepEqual(after, before);
  assert.deepEqual(h.formatQualificationVerdict(after), h.formatQualificationVerdict(before));
});

// The check the repository is held to: a panel past version 1 is committed
// only as the verdict on the committed qualification receipt.
test("a committed panel past version 1 must be the verdict on the committed qualification receipt, byte for byte", async () => {
  const h = await helpers;
  const lineage = (files: PanelFile[], receipt: unknown) => h.assertCommittedPanelLineage({ files, receipt, qualificationPanel });
  const changing = await qualificationReceipt();
  const verdict = await verdictOn(changing);
  assert.ok(verdict.panel && verdict.panelText);
  const v2File: PanelFile = { name: "monthly-toolchain-canary-v2.json", text: verdict.panelText };
  const unchanging = await qualificationReceipt({ bumble: withOn(counted("bumble"), ALL, BLOCKED), "ssa-gov": withOn(counted("ssa-gov"), [1], { losses: [STORAGE_LOSS] }), "who-int": counted("who-int", { knownTrackerRequests: 7 }) });

  // The four states the repository can be in.
  assert.deepEqual(lineage([V1_FILE], null), { state: "no-capture", verdict: null });
  assert.equal(lineage([V1_FILE], changing).state, "verdict-not-committed");
  assert.equal(lineage([V1_FILE], unchanging).state, "unchanged");
  assert.equal(lineage([V1_FILE, v2File], changing).state, "committed");
  assert.deepEqual(lineage([V1_FILE, v2File], changing).verdict, verdict);

  // A panel of version 2 that did not come from the verdict.
  const loosened = structuredClone(verdict.panel);
  loosened.metricTolerances.knownTrackerRequests.relative = 1;
  loosened.metricTolerances.shieldsBlockedRequests.relative = 1;
  const otherCase = structuredClone(verdict.panel);
  otherCase.cases[3] = { id: "nick", catalog: "public/featured-sites.json", domain: "nick.com", url: "https://www.nick.com/" };
  const notTheBytes = "is not, byte for byte, the panel the verdict on the committed qualification receipt gives";
  const refusals: Array<[string, PanelFile[], unknown, RegExp]> = [
    ["with no receipt committed", [V1_FILE, v2File], null, /monthly-toolchain-canary-v2\.json is a panel past version 1, and no qualification receipt is committed at docs\/toolchain-canary-qualification-2026-11\/qualification-receipt\.json/],
    ["hand-made, with a tolerance loosened", [V1_FILE, { name: v2File.name, text: h.formatPanel(loosened) }], changing, new RegExp(notTheBytes)],
    ["hand-made, with another case", [V1_FILE, { name: v2File.name, text: h.formatPanel(otherCase) }], changing, new RegExp(notTheBytes)],
    ["the verdict's panel in another layout", [V1_FILE, { name: v2File.name, text: JSON.stringify(verdict.panel) }], changing, new RegExp(notTheBytes)],
    ["the verdict's panel with a line added", [V1_FILE, { name: v2File.name, text: `${verdict.panelText}\n` }], changing, new RegExp(notTheBytes)],
    ["where the verdict leaves the panel unchanged", [V1_FILE, v2File], unchanging, /monthly-toolchain-canary-v2\.json is committed, and the verdict on the committed qualification receipt leaves the panel unchanged/],
    ["beside a receipt the verdict refuses", [V1_FILE, v2File], { ...structuredClone(changing), rule: { id: "panel-qualification-2026-11-10", digest: "1".repeat(64) } }, /A verdict is given only under the rule the capture ran under/],
    ["beside a receipt that is no receipt", [V1_FILE, v2File], {}, /Invalid canary qualification receipt/]
  ];
  for (const [label, files, receipt, message] of refusals) assert.throws(() => lineage(files, receipt), message, label);
  // A receipt the verdict refuses is refused with no later panel as well: a
  // committed receipt must be one the rule can read.
  assert.throws(() => lineage([V1_FILE], {}), /Invalid canary qualification receipt/);
});

test("the repository's own panels and qualification receipt are in one of the four states, and with no receipt committed there is no panel past version 1", async () => {
  const h = await helpers;
  const directory = path.join(root, "scripts", "fixtures", "toolchain-canary-panels");
  const files = readdirSync(directory).map((name) => ({ name, text: readFileSync(path.join(directory, name), "utf8") }));
  const place = h.qualificationReceiptPath(qualificationPanel);
  assert.equal(place, "docs/toolchain-canary-qualification-2026-11/qualification-receipt.json");
  const receiptFile = path.join(root, ...place.split("/"));
  const receipt = existsSync(receiptFile) ? (JSON.parse(readFileSync(receiptFile, "utf8")) as unknown) : null;
  const { state, verdict } = h.assertCommittedPanelLineage({ files, receipt, qualificationPanel });
  const versions = h.readCommittedPanels(files).map((entry) => entry.panel.panelVersion);
  const current = readJson<Panel>(CURRENT_PANEL_FILE);
  if (receipt === null) {
    // Before the capture: version 1 is the only panel there is, and it is current.
    assert.equal(state, "no-capture");
    assert.deepEqual(versions, [1]);
    assert.equal(current.panelVersion, 1);
    return;
  }
  assert.ok(verdict);
  if (state === "committed") {
    // After the change: version 2 is the verdict's bytes, and the current panel is one of the two.
    assert.deepEqual(versions, [1, 2]);
    assert.ok(verdict.panelText);
    if (current.panelVersion === 2) assert.equal(readFileSync(path.join(root, CURRENT_PANEL_FILE), "utf8"), verdict.panelText);
    return;
  }
  // The receipt is committed and no later panel is: either the verdict leaves
  // the panel as it is, or the next panel is not committed yet.
  assert.ok(state === "unchanged" || state === "verdict-not-committed", state);
  assert.deepEqual(versions, [1]);
  assert.equal(current.panelVersion, 1);
});

test("a comparison and a replay refuse a qualification receipt by name", async () => {
  const h = await helpers;
  const receipt = await qualificationReceipt();
  const capture = committedReceipt("toolchain-epoch-2026-11/round-1-candidate-receipt.json");
  const digest = h.panelDigest(panelV1);
  const message = "A qualification receipt is not a comparison receipt: it judges candidate cases on one build. Read it with the verdict command.";
  assert.throws(() => h.compareReceipts(receipt, capture, panelV1, digest), { message });
  assert.throws(() => h.compareReceipts(committedReceipt("toolchain-epoch-2026-11/round-1-baseline-receipt.json"), receipt, panelV1, digest), { message });
  const panels = { current: { panel: panelV1, digest }, committed: [{ panel: panelV1, digest, file: PANEL_V1_FILE }] };
  for (const replay of [false, true]) {
    assert.throws(() => h.selectComparisonPanel({ replay, baseline: receipt, candidate: capture, ...panels }), { message }, String(replay));
    assert.throws(() => h.selectComparisonPanel({ replay, baseline: capture, candidate: receipt, ...panels }), { message }, String(replay));
  }
});

// A copy of the canary command in a tree of its own, with the panels the
// test gives it. The command finds its panels, and the place of its
// qualification receipt, beside itself, so these tests hold whichever panel
// the repository's own current panel file names and write nothing into it.
function canaryTree(currentPanelText: string, committedPanels: Record<string, string>, qualificationPanelText?: string) {
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
    "public/corpus-seed-sites.json",
    "public/schemas/scan-report.v2.r2.schema.json"
  ]) {
    mkdirSync(path.dirname(path.join(tree, relative)), { recursive: true });
    copyFileSync(path.join(root, relative), path.join(tree, relative));
  }
  symlinkSync(path.join(root, "node_modules"), path.join(tree, "node_modules"), "dir");
  place(CURRENT_PANEL_FILE, currentPanelText);
  place(QUALIFICATION_PANEL_FILE, qualificationPanelText ?? readFileSync(path.join(root, QUALIFICATION_PANEL_FILE), "utf8"));
  for (const [name, text] of Object.entries(committedPanels)) place(path.join("scripts", "fixtures", "toolchain-canary-panels", name), text);
  return tree;
}
const treeOnV1 = (qualificationPanelText?: string) => canaryTree(panelV1Text, { [V1_FILE.name]: panelV1Text }, qualificationPanelText);
const RECEIPT_PLACE = "docs/toolchain-canary-qualification-2026-11/qualification-receipt.json";
const receiptIn = (tree: string) => path.join(tree, ...RECEIPT_PLACE.split("/"));
function placeReceipt(tree: string, receipt: unknown) {
  mkdirSync(path.dirname(receiptIn(tree)), { recursive: true });
  writeFileSync(receiptIn(tree), JSON.stringify(receipt));
}

// Every command these tests spawn has fetch replaced. Here it throws, so the
// command can reach nothing whatever it does.
const NO_NETWORK = "data:text/javascript,globalThis.fetch=()=>{throw new Error('no network in tests')}";
const STAGING_TOKEN = "s".repeat(40);
function canary(tree: string, args: string[], env: Record<string, string> = {}) {
  const scrubbed = { ...process.env, ...env };
  if (!Object.hasOwn(env, "TOOLCHAIN_CANARY_ACCESS_TOKEN")) delete scrubbed.TOOLCHAIN_CANARY_ACCESS_TOKEN;
  return spawnSync(process.execPath, ["--no-warnings", "--import", NO_NETWORK, path.join(tree, "scripts", "toolchain-canary.mjs"), ...args], { cwd: root, encoding: "utf8", env: scrubbed });
}
const printed = (text: string) => (text === "" ? [] : text.trimEnd().split("\n"));

test("the verdict CLI reads the committed receipt, prints the verdict and exits 0 whether or not the panel changes, and refuses anything that is not a qualification receipt with exit 1", async () => {
  const h = await helpers;
  const tree = treeOnV1();
  const work = mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-verdict-"));
  try {
    const write = (name: string, value: unknown) => {
      const file = path.join(work, name);
      writeFileSync(file, JSON.stringify(value));
      return file;
    };
    // With no receipt committed there is nothing to judge.
    const none = canary(tree, ["verdict"]);
    assert.equal(none.status, 1);
    assert.deepEqual(printed(none.stderr), [`FAIL There is no qualification receipt to read at ${RECEIPT_PLACE}.`]);

    // The receipt at its fixed place is the one read when no file is named.
    const changing = await qualificationReceipt();
    const expected = await verdictOn(changing);
    placeReceipt(tree, changing);
    const committed = canary(tree, ["verdict"]);
    assert.equal(committed.status, 0, committed.stderr);
    assert.equal(committed.stderr, "");
    assert.deepEqual(printed(committed.stdout), h.formatQualificationVerdict(expected));
    assert.ok(printed(committed.stdout).includes("SLOT theguardian.com: bumble.com takes it"));
    // Another file can be named, and is judged the same way.
    const named = canary(tree, ["verdict", "--receipt", write("changing.json", changing)]);
    assert.equal(named.status, 0, named.stderr);
    assert.equal(named.stdout, committed.stdout);

    // A verdict that leaves the panel as it is exits 0 too.
    const unchanging = await qualificationReceipt({ bumble: withOn(counted("bumble"), ALL, BLOCKED), "ssa-gov": withOn(counted("ssa-gov"), [1], { losses: [STORAGE_LOSS] }), "who-int": counted("who-int", { knownTrackerRequests: 7 }) });
    const unchanged = canary(tree, ["verdict", "--receipt", write("unchanging.json", unchanging)]);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(printed(unchanged.stdout).at(-1), "PANEL UNCHANGED: no candidate took a slot, so monthly-toolchain-canary-v1 stays the current panel");
    // So does one on a receipt that is not finished.
    const early = { ...structuredClone(changing), runs: changing.runs.slice(0, 7), finished: false, endedEarly: "scan 8 of 15 (ssa-gov repetition 3) ended the capture: Saved report has invalid run provenance.", healthAfter: null };
    const unfinished = canary(tree, ["verdict", "--receipt", write("unfinished.json", early)]);
    assert.equal(unfinished.status, 0, unfinished.stderr);
    assert.deepEqual(printed(unfinished.stdout), h.formatQualificationVerdict(await verdictOn(early)));
    assert.ok(printed(unfinished.stdout).includes("CASE ssa-gov (ssa.gov): NOT JUDGED; 2 of 5 runs recorded"));

    // A committed receipt that was cut short on disk is not repaired or guessed at.
    const torn = path.join(work, "torn.json");
    writeFileSync(torn, JSON.stringify(changing).slice(0, 2000));
    const unreadable = canary(tree, ["verdict", "--receipt", torn]);
    assert.equal(unreadable.status, 1);
    assert.deepEqual(printed(unreadable.stderr), [`FAIL The qualification receipt at ${torn} is not JSON. If it is the committed receipt, do not repair it by hand: ask the owner.`]);

    const refusals: Array<[string, unknown, string]> = [
      ["an empty object", {}, "FAIL Invalid canary qualification receipt."],
      ["a finished receipt with no runs", { ...changing, runs: [], incompleteRuns: [] }, "FAIL Qualification receipt has incomplete panel coverage."],
      ["a receipt under another rule", { ...changing, rule: { id: "panel-qualification-2026-11-10", digest: "1".repeat(64) } }, `FAIL The receipt was captured under qualification rule panel-qualification-2026-11-10 (sha256 ${"1".repeat(64)}), and the rule in this code is panel-qualification-2026-11-10 (sha256 ${h.qualificationRuleDigest()}). A verdict is given only under the rule the capture ran under: read the receipt from a checkout that holds that rule.`],
      ["a capture receipt", committedReceipt("toolchain-epoch-2026-11/round-1-candidate-receipt.json"), "FAIL A capture receipt is one arm of a comparison, not a qualification receipt. The compare and replay commands read it."]
    ];
    for (const [label, value, message] of refusals) {
      const refused = canary(tree, ["verdict", "--receipt", write(`${label.replaceAll(" ", "-")}.json`, value)]);
      assert.equal(refused.status, 1, label);
      assert.equal(refused.stdout, "", label);
      assert.deepEqual(printed(refused.stderr), [message], label);
    }
    // The compare and replay commands refuse a qualification receipt, each in its own voice.
    const capture = path.join("docs", "toolchain-epoch-2026-11", "round-1-candidate-receipt.json");
    const notComparison = "A qualification receipt is not a comparison receipt: it judges candidate cases on one build. Read it with the verdict command.";
    for (const [verb, line] of [["compare", `FAIL ${notComparison}`], ["replay", `REPLAY FAIL ${notComparison}`]]) {
      const refused = canary(tree, [verb, "--baseline", write(`as-baseline-${verb}.json`, changing), "--candidate", capture]);
      assert.equal(refused.status, 1, verb);
      assert.equal(refused.stdout, "", verb);
      assert.deepEqual(printed(refused.stderr), [line], verb);
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("the verdict CLI writes the next panel once, to a file that did not exist, never under public/, and writes nothing when the panel does not change", async () => {
  const h = await helpers;
  const tree = treeOnV1();
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-panel-out-")));
  try {
    const changing = await qualificationReceipt();
    const expected = await verdictOn(changing);
    placeReceipt(tree, changing);
    const panelOut = path.join(tree, "scripts", "fixtures", "toolchain-canary-panels", "monthly-toolchain-canary-v2.json");
    const written = canary(tree, ["verdict", "--panel-out", panelOut]);
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(printed(written.stdout), [...h.formatQualificationVerdict(expected), `WROTE ${panelOut}`]);
    assert.equal(readFileSync(panelOut, "utf8"), expected.panelText);
    h.assertPanelCatalogMembership(h.assertPanel(JSON.parse(readFileSync(panelOut, "utf8"))), catalogs);
    // The file now beside panel version 1 is the one the lineage check accepts.
    assert.equal(h.assertCommittedPanelLineage({ files: [V1_FILE, { name: "monthly-toolchain-canary-v2.json", text: readFileSync(panelOut, "utf8") }], receipt: changing, qualificationPanel }).state, "committed");

    // A file that is already there is never written over, whatever it holds.
    for (const existing of [panelOut, path.join(work, "existing.json")]) {
      if (existing !== panelOut) writeFileSync(existing, "kept");
      const before = readFileSync(existing, "utf8");
      const again = canary(tree, ["verdict", "--panel-out", existing]);
      assert.equal(again.status, 1, existing);
      assert.equal(again.stdout, "", existing);
      assert.deepEqual(printed(again.stderr), [`FAIL Refusing to overwrite existing panel file ${existing}.`], existing);
      assert.equal(readFileSync(existing, "utf8"), before, existing);
    }
    // Nor is one written under public/, by its own name or through a link to it, or into a directory that is not there.
    symlinkSync(path.join(tree, "public"), path.join(work, "elsewhere"), "dir");
    const refusals: Array<[string, string]> = [
      [path.join(tree, "public", "panel.json"), "FAIL A panel file must never be written under public/."],
      [path.join(work, "elsewhere", "panel.json"), "FAIL A panel file must never be written under public/."],
      [path.join(work, "missing", "panel.json"), `FAIL The directory for the panel file does not exist: ${path.join(work, "missing")}.`]
    ];
    for (const [target, message] of refusals) {
      const refused = canary(tree, ["verdict", "--panel-out", target]);
      assert.equal(refused.status, 1, target);
      assert.equal(refused.stdout, "", target);
      assert.deepEqual(printed(refused.stderr), [message], target);
      assert.equal(existsSync(path.join(tree, "public", "panel.json")), false, target);
    }
    // A verdict that leaves the panel as it is writes no panel.
    const unchanging = await qualificationReceipt({ bumble: withOn(counted("bumble"), ALL, BLOCKED), "ssa-gov": withOn(counted("ssa-gov"), [1], { losses: [STORAGE_LOSS] }), "who-int": counted("who-int", { knownTrackerRequests: 7 }) });
    const unchangingFile = path.join(work, "unchanging.json");
    writeFileSync(unchangingFile, JSON.stringify(unchanging));
    const unwritten = path.join(work, "not-written.json");
    const unchanged = canary(tree, ["verdict", "--receipt", unchangingFile, "--panel-out", unwritten]);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.deepEqual(printed(unchanged.stdout).slice(-2), [
      "PANEL UNCHANGED: no candidate took a slot, so monthly-toolchain-canary-v1 stays the current panel",
      `NOT WRITTEN ${unwritten}: the panel does not change`
    ]);
    assert.equal(existsSync(unwritten), false);
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

test("the qualify CLI keeps the gates of a capture ahead of any request, takes no receipt path, and a capture that submitted nothing leaves nothing behind", async () => {
  const h = await helpers;
  const tree = treeOnV1();
  const token = { TOOLCHAIN_CANARY_ACCESS_TOKEN: STAGING_TOKEN };
  try {
    const base = ["qualify", "--expected-build", BUILD, "--confirm", h.CANARY_CONFIRMATION];
    const without = (flag: string) => base.filter((_, index) => base[index] !== flag && base[index - 1] !== flag);
    // [what is wrong, the arguments, the environment, the refusal]
    const gates: Array<[string, string[], Record<string, string>, string]> = [
      ["no confirmation", without("--confirm"), token, "FAIL Missing --confirm."],
      ["another confirmation", [...without("--confirm"), "--confirm", "yes"], token, `FAIL --confirm must be exactly ${h.CANARY_CONFIRMATION}.`],
      ["the production origin", [...base, "--base-url", "https://scan.sitebehavior.org"], token, "FAIL Canary origin must be exactly https://scan-staging.sitebehavior.org."],
      ["a branch name for the build", [...without("--expected-build"), "--expected-build", "main"], token, "FAIL --expected-build must be an exact lowercase 40-character commit SHA."],
      ["no token", base, {}, "FAIL TOOLCHAIN_CANARY_ACCESS_TOKEN must be a trimmed value of at least 32 characters."],
      // The receipt has one place. A path for it is not an option.
      ["a path for the receipt", [...base, "--out", path.join(tree, "qualification-receipt.json")], token, "FAIL Invalid or duplicate option --out."],
      ["an order, which a qualifying capture does not take", [...base, "--order", "forward"], token, "FAIL Invalid or duplicate option --order."]
    ];
    for (const [label, args, env, message] of gates) {
      const result = canary(tree, args, env);
      assert.equal(result.status, 1, label);
      assert.equal(result.stdout, "", label);
      assert.deepEqual(printed(result.stderr), [message], label);
      assert.equal(existsSync(path.join(tree, "docs")), false, label);
    }
    // With every gate passed the next step is the health request, which this
    // test cannot make. Nothing was submitted, so no receipt is left in the
    // way of the capture.
    const stopped = canary(tree, base, token);
    assert.equal(stopped.status, 1);
    assert.equal(stopped.stdout, "");
    assert.deepEqual(printed(stopped.stderr), ["FAIL Request to /api/health failed. No scan was submitted and no receipt is kept: the qualifying capture has not been used."]);
    assert.equal(existsSync(receiptIn(tree)), false);
    assert.equal(existsSync(path.dirname(receiptIn(tree))), false);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }

  // The qualification panel the command reads is held to the catalogs, as the comparison panel is.
  const unpinned = structuredClone(qualificationPanel);
  unpinned.cases[2].url = "https://who.int/";
  const offCatalog = treeOnV1(JSON.stringify(unpinned));
  try {
    for (const args of [["qualify", "--expected-build", BUILD, "--confirm", h.CANARY_CONFIRMATION], ["verdict"]]) {
      const refused = canary(offCatalog, args, token);
      assert.equal(refused.status, 1, args[0]);
      assert.equal(refused.stdout, "", args[0]);
      assert.deepEqual(printed(refused.stderr), ["FAIL Panel case who-int is not pinned exactly in public/corpus-seed-sites.json."], args[0]);
    }
  } finally {
    rmSync(offCatalog, { recursive: true, force: true });
  }

  // Once panel version 2 is current the rule has decided. A second qualifying
  // capture is refused before its health request. The verdict on the
  // committed receipt is still given, and is the verdict it was.
  const receipt = await qualificationReceipt();
  const verdict = await verdictOn(receipt);
  assert.ok(verdict.panelText);
  const after = canaryTree(verdict.panelText, { [V1_FILE.name]: panelV1Text, "monthly-toolchain-canary-v2.json": verdict.panelText });
  try {
    placeReceipt(after, receipt);
    const second = canary(after, ["qualify", "--expected-build", BUILD, "--confirm", h.CANARY_CONFIRMATION], token);
    assert.equal(second.status, 1);
    assert.equal(second.stdout, "");
    assert.deepEqual(printed(second.stderr), ["FAIL Qualification rule panel-qualification-2026-11-10 changes panel version 1 only, and the current panel is version 2. A later panel change needs its own rule, fixed before its capture."]);
    const again = canary(after, ["verdict"]);
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(printed(again.stdout), h.formatQualificationVerdict(verdict));
  } finally {
    rmSync(after, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The capturing commands end to end, against a stand-in for staging. The
// stand-in replaces fetch inside the spawned command and answers the four
// staging routes from a plan file, so the command's own requests, retries,
// polling, schema check and receipt are the real ones and nothing leaves the
// machine. It logs every request, and with each submission and each health
// read what the receipt on disk held at that moment. Every wait the command
// asks for returns at once and is logged with the time asked for, so a whole
// poll window is run and counted without being waited out. The plan can stop
// the command as a kill from outside would: at its nth health read, or at
// its nth replacement of the receipt, with the new text written beside the
// receipt and not yet put in its place. It can make that replacement fail
// instead. It logs each flush of a file to disk, and each replacement with
// whether the text beside the receipt had been flushed first.
// ---------------------------------------------------------------------------

const STAGING_STAND_IN = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const plan = JSON.parse(readFileSync(process.env.STAGING_STAND_IN_PLAN, "utf8"));
const note = (entry) => appendFileSync(process.env.STAGING_STAND_IN_LOG, JSON.stringify(entry) + "\\n");
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
// The next answer of a list; the last one repeats.
const next = (answers) => (answers.length > 1 ? answers.shift() : answers[0]);
const noAnswer = () => { throw new TypeError("fetch failed"); };
const onDisk = () => {
  if (!plan.receipt || !existsSync(plan.receipt)) return null;
  const text = readFileSync(plan.receipt, "utf8");
  if (text === "") return "empty";
  const receipt = JSON.parse(text);
  return { recorded: receipt.runs.length + receipt.incompleteRuns.length, finished: receipt.finished };
};
const stopHere = () => { process.kill(process.pid, "SIGKILL"); return new Promise(() => {}); };
const timer = globalThis.setTimeout;
globalThis.setTimeout = (callback, wait, ...rest) => { note({ wait }); return timer(callback, 0, ...rest); };
const probe = await fsPromises.open(process.env.STAGING_STAND_IN_PLAN, "r");
const fileHandle = Object.getPrototypeOf(probe);
await probe.close();
const flush = fileHandle.sync;
let flushed = false;
fileHandle.sync = function () { flushed = true; note({ flush: true }); return flush.call(this); };
const putInPlace = fsPromises.rename;
let replacements = 0;
fsPromises.rename = async (from, to) => {
  if (to === plan.receipt) {
    replacements += 1;
    note({ replacement: replacements, from, flushed });
    flushed = false;
    if (plan.stop?.replacement === replacements) return stopHere();
    if (plan.fail?.replacement === replacements) throw Object.assign(new Error("EIO: the disk refused the rename"), { code: "EIO" });
  }
  return putInPlace(from, to);
};
syncBuiltinESMExports();
let submitted = 0;
let healthReads = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const headers = init.headers ?? {};
  const submission = url.pathname === "/api/scan";
  const health = url.pathname === "/api/health";
  note({
    method: init.method ?? "GET",
    origin: url.origin,
    path: url.pathname,
    token: headers["x-site-behavior-lab-access-token"] === plan.token,
    admission: typeof headers["x-site-behavior-lab-scan-admission"] === "string" && typeof headers["x-site-behavior-lab-scan-admission-commitment"] === "string",
    body: init.body ? JSON.parse(init.body) : null,
    receipt: submission || health ? onDisk() : undefined
  });
  if (url.origin !== "https://scan-staging.sitebehavior.org") throw new Error("a request left the staging origin");
  if (health) {
    healthReads += 1;
    if (plan.stop?.health === healthReads) return stopHere();
    const answer = next(plan.health);
    return typeof answer === "number" ? json(answer, { ok: false }) : json(200, answer);
  }
  if (submission) {
    const scan = plan.scans[submitted];
    submitted += 1;
    // No answer at all: the request fails before any response.
    if (scan.submit === 0) noAnswer();
    if (scan.submit !== 202) return json(scan.submit, { ok: false, error: "The scan was not accepted." });
    return json(202, { ok: true, status: "queued", jobId: scan.jobId, reportId: scan.reportId, statusPath: "/api/scans/" + scan.jobId });
  }
  if (url.pathname.startsWith("/api/scans/")) {
    const scan = plan.scans.find((entry) => "/api/scans/" + entry.jobId === url.pathname);
    const answer = next(scan.statuses);
    if (answer === 0) noAnswer();
    if (typeof answer === "number") return json(answer, { ok: false });
    return json(200, answer === "succeeded" ? { ok: true, jobId: scan.jobId, status: answer } : { ok: true, jobId: scan.jobId, status: answer, error: "This scan job could not be completed." });
  }
  if (url.pathname.startsWith("/api/reports/")) {
    const scan = plan.scans.find((entry) => "/api/reports/" + entry.reportId === url.pathname);
    const answer = next(scan.reports);
    if (answer === 0) noAnswer();
    if (answer !== 200) return json(answer, { ok: false });
    return new Response(scan.wire, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  return json(404, { ok: false });
};
`;

function stagingHealth(deployment: string) {
  return {
    ok: true, status: "ok", warnings: [], deployment, authenticated: true, openAccess: false, turnstile: false,
    scansAvailable: true, storage: "r2", capabilities: { singleScan: true, savedReports: true },
    checks: {
      scanAccess: "configured", chromiumSandbox: "enabled", adblock: { active: true }, scannerEgressRegion: "configured",
      publicR2Reports: { status: "enabled" }, reportStore: { kind: "r2", configuredPath: true },
      durableJobs: { requested: true, enabled: true, readiness: "ready", coordinatorOrigin: "https://scan-staging.sitebehavior.org", faultInjection: { environment: "staging", enabled: true, wholeOriginAccessGate: true } }
    }
  };
}
const HEALTHY = stagingHealth(BUILD);

type PlannedScan = { caseId: string; repetition: number; url: string; jobId: string; reportId: string; submit: number; statuses: Array<string | number>; reports: number[]; wire: string };
// How the stand-in answers for one scan, beyond what its report holds: the
// answer to the submission, to each status poll in turn and to each read of
// the saved report. 0 is no answer at all. The last answer of a list repeats.
type Answers = { submit?: number; statuses?: Array<string | number>; reports?: number[] };
// The answers that leave no report, by the word the receipt has for each.
const NO_REPORT_ANSWERS: Record<string, Answers> = {
  failed: { statuses: ["failed"] },
  expired: { statuses: ["expired"] },
  cancelled: { statuses: ["cancelled"] },
  timedOut: { statuses: ["running"] },
  statusUnreadable: { statuses: [503] },
  reportUnreadable: { reports: [503] }
};

// The scans a capture of these cases submits, in order, each answered as the
// scenario scripts it. answers adds to that by "case:repetition".
function plannedScans(cases: Case[], repetitions: number, scenario: Scenario, answers: Record<string, Answers> = {}): PlannedScan[] {
  const scans: PlannedScan[] = [];
  for (const panelCase of cases) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const sequence = scans.length + 1;
      const spec = (scenario[panelCase.id] ?? counted(panelCase.id))(repetition);
      const saved = savedReport(panelCase, sequence, spec);
      const how = { ...(spec.noReport ? NO_REPORT_ANSWERS[spec.noReport] : {}), ...(answers[`${panelCase.id}:${repetition}`] ?? {}) };
      scans.push({
        caseId: panelCase.id,
        repetition,
        url: panelCase.url,
        jobId: `20261110-${(sequence + 4096).toString(16).padStart(32, "0")}`,
        reportId: saved.reportId,
        submit: how.submit ?? 202,
        statuses: how.statuses ?? ["succeeded"],
        reports: how.reports ?? [200],
        wire: JSON.stringify(saved.report)
      });
    }
  }
  return scans;
}

type Logged = { method: string; origin: string; path: string; token: boolean; admission: boolean; body: Record<string, unknown> | null; receipt?: { recorded: number; finished: boolean } | "empty" | null };
// Where the plan stops the command, as a kill from outside would.
type Stop = { health?: number; replacement?: number };
// A replacement of the receipt, as the stand-in saw it.
type Replacement = { replacement: number; from: string; flushed: boolean };

// One canary command in a tree, with staging stood in for by the plan. It
// gives the command's result, its requests in order, and the waits it asked for.
function againstStandIn(tree: string, args: string[], plan: { scans: PlannedScan[]; health?: unknown[]; stop?: Stop; fail?: { replacement: number }; receipt?: string }) {
  const work = mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-stand-in-"));
  try {
    const standIn = path.join(work, "staging-stand-in.mjs");
    const planFile = path.join(work, "plan.json");
    const logFile = path.join(work, "requests.jsonl");
    writeFileSync(standIn, STAGING_STAND_IN);
    writeFileSync(planFile, JSON.stringify({ token: STAGING_TOKEN, health: [HEALTHY], receipt: receiptIn(tree), ...plan }));
    writeFileSync(logFile, "");
    const result = spawnSync(process.execPath, ["--no-warnings", "--import", pathToFileURL(standIn).href, path.join(tree, "scripts", "toolchain-canary.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, TOOLCHAIN_CANARY_ACCESS_TOKEN: STAGING_TOKEN, STAGING_STAND_IN_PLAN: planFile, STAGING_STAND_IN_LOG: logFile }
    });
    const logged = readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Logged & { wait?: number } & Partial<Replacement>);
    const requests: Logged[] = logged.filter((entry) => typeof entry.path === "string");
    const waits = logged.flatMap((entry) => (typeof entry.wait === "number" ? [entry.wait] : []));
    const replacements = logged.filter((entry) => typeof entry.replacement === "number") as unknown as Replacement[];
    // What the command did last: a request, a wait, a flush or a replacement.
    const last = Object.keys(logged.at(-1) ?? {}).find((key) => ["path", "wait", "flush", "replacement"].includes(key)) ?? null;
    return { result, requests, waits, replacements, last };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
const requestsTo = (requests: Logged[], prefix: string) => requests.filter((request) => request.path.startsWith(prefix));

test("the qualify CLI, against a stand-in for staging, keeps its receipt on disk as it goes, reads again and never submits again, records every scan that left no report, and is refused a second time", async () => {
  const h = await helpers;
  const tree = treeOnV1();
  try {
    const QUALIFY = ["qualify", "--expected-build", BUILD, "--confirm", h.CANARY_CONFIRMATION];
    // One of each thing a scan can do short of ending the capture.
    const scenario: Scenario = {
      "ssa-gov": withOn(withOn(withOn(withOn(counted("ssa-gov"), [2], { noReport: "failed" }), [3], { noReport: "expired" }), [4], { noReport: "cancelled" }), [5], { noReport: "statusUnreadable" }),
      "who-int": withOn(withOn(counted("who-int"), [3], { noReport: "reportUnreadable" }), [4], BLOCKED)
    };
    // A status poll that fails once and a health read that fails once are read again.
    const scans = plannedScans(qualificationPanel.cases, qualificationPanel.repetitions, scenario, { "bumble:2": { statuses: [503, "succeeded"] } });
    const { result, requests, waits, replacements } = againstStandIn(tree, QUALIFY, { scans, health: [HEALTHY, 503, HEALTHY] });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(printed(result.stdout), [
      ...scans.map((scan, index) => `[${index + 1}/15] ${scan.caseId} repetition ${scan.repetition}`),
      `WROTE qualification receipt ${RECEIPT_PLACE}: 9 complete and 6 incomplete runs, 15 of 15 scans recorded. Commit and push it now, whatever it holds, before anything else. It is not a verdict: read it with the verdict command.`
    ]);

    // Every request went to staging with the token. Health was read before
    // the first scan and after the last, the failed read once more.
    assert.equal(requests.every((request) => request.origin === "https://scan-staging.sitebehavior.org" && request.token), true);
    assert.equal(requests[0].path, "/api/health");
    assert.deepEqual(requests.slice(-2).map((request) => request.path), ["/api/health", "/api/health"]);
    assert.equal(requestsTo(requests, "/api/health").length, 3);
    // Each scan was submitted once, in panel order, with the admission
    // headers and the panel's conditions: a submission is never repeated.
    const submissions = requestsTo(requests, "/api/scan").filter((request) => request.path === "/api/scan");
    assert.equal(submissions.every((request) => request.method === "POST" && request.admission), true);
    assert.deepEqual(submissions.map((request) => request.body?.url), scans.map((scan) => scan.url));
    for (const submission of submissions) assert.deepEqual([submission.body?.device, submission.body?.gpcEnabled, submission.body?.consentMode], ["desktop", true, "observe"]);
    // When each scan was submitted, the receipt on disk held every scan
    // before it and said it was not finished.
    assert.deepEqual(submissions.map((request) => request.receipt), scans.map((_, index) => ({ recorded: index, finished: false })));
    // The receipt was there and empty at the first health read, when nothing
    // had been submitted. At the health read after the last scan it held all
    // fifteen scans already, the last one included.
    assert.deepEqual(requestsTo(requests, "/api/health").map((request) => request.receipt), ["empty", { recorded: 15, finished: false }, { recorded: 15, finished: false }]);
    // A status or a saved report that cannot be read is read again at the
    // next poll, to the end of its window of 180 reads, and one that can then
    // be read is used.
    const polls = (scan: PlannedScan) => requestsTo(requests, `/api/scans/${scan.jobId}`).length;
    const reads = (scan: PlannedScan) => requestsTo(requests, `/api/reports/${scan.reportId}`).length;
    assert.deepEqual([polls(scans[0]), polls(scans[1]), polls(scans[9]), reads(scans[12]), reads(scans[0]), reads(scans[6])], [1, 2, 180, 180, 1, 0]);
    // The command waited 2 seconds before each further read of a scan, and 1
    // second before its one further health read.
    assert.deepEqual([waits.filter((wait) => wait === 2_000).length, waits.filter((wait) => wait !== 2_000)], [1 + 179 + 179, [1_000]]);

    // The receipt is private to its owner, finished, and exactly what the
    // library builds from the same fifteen answers.
    const receiptFile = receiptIn(tree);
    assert.equal(statSync(receiptFile).mode & 0o777, 0o600);
    // Its directory holds the receipt and nothing else.
    assert.deepEqual(readdirSync(path.dirname(receiptFile)), ["qualification-receipt.json"]);
    // The receipt was replaced seventeen times: before each scan, after the
    // last, and when it was finished. Each time the new text had been written
    // beside it and flushed, and was then renamed over it.
    assert.deepEqual(replacements, Array.from({ length: 17 }, (_, index) => ({ replacement: index + 1, from: `${receiptFile}.partial`, flushed: true })));
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as Receipt;
    const expected = await qualificationReceipt(scenario);
    assert.deepEqual(receipt, { ...expected, createdAt: receipt.createdAt } as Receipt);
    assert.match(receipt.createdAt, /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.deepEqual([receipt.finished, receipt.endedEarly, receipt.healthAfter], [true, null, { ok: true }]);
    assert.deepEqual(receipt.incompleteRuns.map((entry: Receipt) => [entry.caseId, entry.repetition, entry.stage, entry.notComplete]), [
      ["ssa-gov", 2, "job", [h.JOB_FACTS.failed]],
      ["ssa-gov", 3, "job", [h.JOB_FACTS.expired]],
      ["ssa-gov", 4, "job", [h.JOB_FACTS.cancelled]],
      ["ssa-gov", 5, "job", [h.JOB_FACTS.statusUnreadable]],
      ["who-int", 3, "job", [h.JOB_FACTS.reportUnreadable]],
      ["who-int", 4, "report", ["the document status was 403", "the run-level outcome was failed (http-status:403)"]]
    ]);
    assert.equal(receipt.runs.length, 9);
    assert.equal(receipt.runs[0].reportWireSha256, createHash("sha256").update(scans[0].wire).digest("hex"));

    // The verdict command reads that file from its place: bumble.com takes the Guardian's slot and gov.uk stays.
    const verdict = canary(tree, ["verdict"]);
    assert.equal(verdict.status, 0, verdict.stderr);
    assert.deepEqual(printed(verdict.stdout), h.formatQualificationVerdict(await verdictOn(receipt)));
    for (const line of [
      "CAPTURE finished; staging health after the last scan passed",
      "CASE bumble (bumble.com): QUALIFIES, SIGNAL case; 5 of 5 runs complete",
      "CASE ssa-gov (ssa.gov): NOT QUALIFIED; 1 of 5 runs complete",
      "CASE who-int (who.int): NOT QUALIFIED; 3 of 5 runs complete",
      "SLOT theguardian.com: bumble.com takes it",
      "SLOT gov.uk: stays",
      "SIGNAL SITES one: the tracker and Shields signal of the resulting panel rests on bumble.com alone"
    ]) assert.ok(printed(verdict.stdout).includes(line), line);

    // One capture: a second one is refused by the receipt in its place, before any request.
    const second = againstStandIn(tree, QUALIFY, { scans });
    assert.equal(second.result.status, 1);
    assert.equal(second.result.stdout, "");
    assert.deepEqual(printed(second.result.stderr), [`FAIL Refusing to overwrite existing qualification receipt ${RECEIPT_PLACE}.`]);
    assert.deepEqual(second.requests, []);
    assert.deepEqual(JSON.parse(readFileSync(receiptFile, "utf8")), receipt);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("a qualifying capture that a scan ends, or whose health read fails after the last scan, leaves its receipt with the reason, and one that submitted nothing or whose first submission was refused leaves none", async () => {
  const h = await helpers;
  const QUALIFY = ["qualify", "--expected-build", BUILD, "--confirm", h.CANARY_CONFIRMATION];
  const all = (scenario: Scenario = {}, answers: Record<string, Answers> = {}) => plannedScans(qualificationPanel.cases, qualificationPanel.repetitions, scenario, answers);

  const degraded = { ...HEALTHY, status: "degraded", warnings: ["report store"] };
  const otherBuild = stagingHealth("d".repeat(40));

  // A health after the last scan that the gate refuses is recorded as it was
  // first read. Staging is not asked again, whether or not a later answer
  // would pass. The receipt is finished and the runs stand.
  for (const health of [[HEALTHY, degraded], [HEALTHY, degraded, HEALTHY]]) {
    const tree = treeOnV1();
    try {
      const { result, requests, waits } = againstStandIn(tree, QUALIFY, { scans: all(), health });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(printed(result.stdout).slice(-2), [
        "HEALTH after the last scan did not pass and is recorded in the receipt: Staging health must report status=ok and warnings=[].",
        `WROTE qualification receipt ${RECEIPT_PLACE}: 15 complete and 0 incomplete runs, 15 of 15 scans recorded. Commit and push it now, whatever it holds, before anything else. It is not a verdict: read it with the verdict command.`
      ]);
      assert.equal(requestsTo(requests, "/api/health").length, 2);
      assert.deepEqual(waits, []);
      const receipt = JSON.parse(readFileSync(receiptIn(tree), "utf8")) as Receipt;
      assert.deepEqual([receipt.finished, receipt.endedEarly, receipt.healthAfter, receipt.runs.length], [true, null, { ok: false, reason: "Staging health must report status=ok and warnings=[]." }, 15]);
      assert.deepEqual(takers(await verdictOn(receipt)), { "theguardian.com": "bumble.com", "gov.uk": "ssa.gov" });
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // What ends a capture: [what, the scans, the scan it ends at, the reason]
  const schemaRefusal = /^scan 1 of 15 \(bumble repetition 1\) ended the capture: Saved report 20261110-0{31}1 failed the committed deep JSON Schema \(\/run must NOT have additional properties[;)]/;
  const ended: Array<[string, PlannedScan[], number, string | RegExp]> = [
    ["a report of another build", all({ "ssa-gov": withOn(counted("ssa-gov"), [2], { build: "d".repeat(40) }) }), 7, "scan 7 of 15 (ssa-gov repetition 2) ended the capture: Saved report has invalid run provenance."],
    ["a submission that is refused", all({}, { "bumble:4": { submit: 429 } }), 4, "scan 4 of 15 (bumble repetition 4) ended the capture: /api/scan did not return the required 202 queued single scan (429)."],
    // The capture is used once the server has acknowledged a job, whatever became of that job.
    ["a submission that is refused after a scan that left no report", all({ bumble: withOn(counted("bumble"), [1], { noReport: "failed" }) }, { "bumble:2": { submit: 429 } }), 2, "scan 2 of 15 (bumble repetition 2) ended the capture: /api/scan did not return the required 202 queued single scan (429)."],
    // A first submission the server may have accepted: no answer at all, and
    // answers that are neither a job nor a refusal.
    ["a first submission that got no answer", all({}, { "bumble:1": { submit: 0 } }), 1, "scan 1 of 15 (bumble repetition 1) ended the capture: Request to /api/scan failed."],
    ["a first submission answered 503", all({}, { "bumble:1": { submit: 503 } }), 1, "scan 1 of 15 (bumble repetition 1) ended the capture: /api/scan did not return the required 202 queued single scan (503)."],
    ["a first submission answered 499", all({}, { "bumble:1": { submit: 499 } }), 1, "scan 1 of 15 (bumble repetition 1) ended the capture: /api/scan did not return the required 202 queued single scan (499)."],
    ["a report the committed schema refuses", all({ bumble: withOn(counted("bumble"), [1], { edit: (report) => { report.run.unexpected = true; } }) }), 1, schemaRefusal]
  ];
  for (const [label, scans, at, reason] of ended) {
    const tree = treeOnV1();
    try {
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans });
      assert.equal(result.status, 1, label);
      // The scan that ended it was submitted once and nothing after it was.
      assert.equal(requests.filter((request) => request.path === "/api/scan").length, at, label);
      const receipt = JSON.parse(readFileSync(receiptIn(tree), "utf8")) as Receipt;
      assert.deepEqual([receipt.finished, receipt.healthAfter, receipt.runs.length + receipt.incompleteRuns.length], [false, null, at - 1], label);
      if (typeof reason === "string") assert.equal(receipt.endedEarly, reason, label);
      else assert.match(receipt.endedEarly, reason, label);
      assert.deepEqual(printed(result.stderr), [`FAIL The qualifying capture did not finish: ${receipt.endedEarly} The receipt so far is ${RECEIPT_PLACE} (${at - 1} of 15 scans recorded). Commit and push it, and ask the owner. Do not run the capture again.`], label);
      assert.equal(statSync(receiptIn(tree)).mode & 0o777, 0o600, label);
      // The verdict reads what there is, and judges the cases whose runs are all there.
      const verdict = await verdictOn(receipt);
      assert.equal(verdict.finished, false, label);
      assert.deepEqual(verdict.cases.map((entry) => entry.judged), [at > 5, false, false], label);
      assert.equal(canary(tree, ["verdict"]).status, 0, label);
      // The capture has been used: it is not run again over its receipt.
      const second = againstStandIn(tree, QUALIFY, { scans: all() });
      assert.equal(second.result.status, 1, label);
      assert.deepEqual(printed(second.result.stderr), [`FAIL Refusing to overwrite existing qualification receipt ${RECEIPT_PLACE}.`], label);
      assert.deepEqual(second.requests, [], label);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // A capture stopped at its gate has submitted nothing. It leaves no file,
  // and the capture can still be run. The gate is applied once, to the first
  // health that was read: a health that reports another build or a warning
  // is not asked for again, though the next answer would have passed. Only a
  // read that fails is tried again, three times in all.
  // [what staging answers, the refusal, the health reads, the waits]
  const gates: Array<[unknown[], string, number, number[]]> = [
    [[otherBuild, otherBuild, HEALTHY], "Staging health does not match the expected build SHA.", 1, []],
    [[degraded, HEALTHY], "Staging health must report status=ok and warnings=[].", 1, []],
    [[503, otherBuild, HEALTHY], "Staging health does not match the expected build SHA.", 2, [1_000]],
    [[503], "Authenticated staging health returned 503.", 3, [1_000, 2_000]]
  ];
  for (const [health, refusal, healthReads, waited] of gates) {
    const tree = treeOnV1();
    try {
      const { result, requests, waits } = againstStandIn(tree, QUALIFY, { scans: all(), health });
      assert.equal(result.status, 1, refusal);
      assert.equal(result.stdout, "", refusal);
      assert.deepEqual(printed(result.stderr), [`FAIL ${refusal} No scan was submitted and no receipt is kept: the qualifying capture has not been used.`]);
      assert.deepEqual(requests.map((request) => request.path), Array.from({ length: healthReads }, () => "/api/health"), refusal);
      assert.deepEqual(waits, waited, refusal);
      assert.equal(existsSync(path.join(tree, "docs")) && existsSync(path.dirname(receiptIn(tree))), false, refusal);
      // The capture has not been used. With a health read that fails twice and then passes, it runs.
      const run = againstStandIn(tree, QUALIFY, { scans: all(), health: [503, 503, HEALTHY] });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.deepEqual(run.waits, [1_000, 2_000], refusal);
      assert.equal(JSON.parse(readFileSync(receiptIn(tree), "utf8")).finished, true, refusal);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // A first submission that the server refuses has spent nothing either, for
  // each answer that is a refusal. The receipt was on disk when the scan was
  // submitted. It is removed, and the capture can still be run.
  for (const status of [400, 401, 403, 413, 422, 429]) {
    const tree = treeOnV1();
    try {
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all({}, { "bumble:1": { submit: status } }) });
      assert.equal(result.status, 1, `${status}`);
      assert.deepEqual(printed(result.stdout), ["[1/15] bumble repetition 1"], `${status}`);
      assert.deepEqual(printed(result.stderr), [`FAIL /api/scan did not return the required 202 queued single scan (${status}). The server refused the first submission, so no scan was accepted and no receipt is kept: the qualifying capture has not been used.`], `${status}`);
      assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), ["GET /api/health", "POST /api/scan"], `${status}`);
      assert.deepEqual(requests[1].receipt, { recorded: 0, finished: false }, `${status}`);
      assert.equal(existsSync(path.join(tree, "docs")) && existsSync(path.dirname(receiptIn(tree))), false, `${status}`);
      if (status !== 429) continue;
      const run = againstStandIn(tree, QUALIFY, { scans: all() });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(JSON.parse(readFileSync(receiptIn(tree), "utf8")).finished, true);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // A place that cannot hold the receipt is found out before any request:
  // a file where its directory should be, and a link that leads into public/.
  const places: Array<[string, (tree: string) => void, string]> = [
    ["a file in the way of the directory", (tree) => { mkdirSync(path.join(tree, "docs")); writeFileSync(path.dirname(receiptIn(tree)), ""); }, `FAIL Cannot create the directory for the qualification receipt ${RECEIPT_PLACE} (EEXIST).`],
    ["a link into public/", (tree) => { mkdirSync(path.join(tree, "docs")); symlinkSync(path.join(tree, "public"), path.dirname(receiptIn(tree)), "dir"); }, `FAIL The qualification receipt belongs at ${RECEIPT_PLACE} inside this worktree, and that path leads elsewhere.`]
  ];
  for (const [label, prepare, message] of places) {
    const tree = treeOnV1();
    try {
      prepare(tree);
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all() });
      assert.equal(result.status, 1, label);
      assert.deepEqual(printed(result.stderr), [message], label);
      assert.deepEqual(requests, [], label);
      assert.equal(existsSync(path.join(tree, "public", "qualification-receipt.json")), false, label);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }
  // With docs itself a link out of the worktree, or a link to nothing, the
  // command refuses before it makes anything: the far side stays as it was.
  {
    const tree = treeOnV1();
    const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-outside-")));
    try {
      for (const destination of [outside, path.join(outside, "not-there")]) {
        symlinkSync(destination, path.join(tree, "docs"), "dir");
        const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all() });
        assert.equal(result.status, 1, destination);
        assert.deepEqual(printed(result.stderr), [`FAIL The qualification receipt belongs at ${RECEIPT_PLACE} inside this worktree, and that path leads elsewhere.`], destination);
        assert.deepEqual(requests, [], destination);
        assert.deepEqual(readdirSync(outside), [], destination);
        rmSync(path.join(tree, "docs"));
      }
    } finally {
      rmSync(tree, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("a status or a saved report that cannot be read is read again at each poll to the end of its window of 180 reads, and only then is the scan recorded as unreadable or timed out, with no scan submitted twice", async () => {
  const h = await helpers;
  const tree = treeOnV1();
  try {
    const unread = (times: number): number[] => Array.from({ length: times }, () => 503);
    const running = (times: number): string[] => Array.from({ length: times }, () => "running");
    // What the receipt says of each scan that left no report.
    const scenario: Scenario = {
      bumble: withOn(withOn(withOn(counted("bumble"), [3], { noReport: "statusUnreadable" }), [4], { noReport: "timedOut" }), [5], { noReport: "timedOut" }),
      "ssa-gov": withOn(withOn(withOn(counted("ssa-gov"), [1], { noReport: "statusUnreadable" }), [2], { noReport: "reportUnreadable" }), [3], { noReport: "failed" })
    };
    const scans = plannedScans(qualificationPanel.cases, qualificationPanel.repetitions, scenario, {
      // Four polls that cannot be read, by a 503 or by no answer, and then the job has succeeded.
      "bumble:1": { statuses: [...unread(4), "succeeded"] },
      "ssa-gov:4": { statuses: [0, 0, 0, 0, "succeeded"] },
      // Four reads of the saved report that fail, and then it is read.
      "bumble:2": { reports: [...unread(4), 200] },
      "ssa-gov:5": { reports: [0, 0, 0, 0, 200] },
      // The window ends on a poll that could not be read: the status is unreadable.
      "bumble:3": { statuses: [...running(179), 503] },
      // It ends on a poll that was read, with the job still running: the job timed out.
      "bumble:4": { statuses: [...unread(179), "running"] },
      // A job that has failed ends its scan at that poll, here after one that could not be read.
      "ssa-gov:3": { statuses: [503, "failed"] }
      // bumble:5 is running at every poll, ssa-gov:1 cannot be read at any,
      // and the saved report of ssa-gov:2 cannot be read at any.
    });
    const { result, requests, waits } = againstStandIn(tree, ["qualify", "--expected-build", BUILD, "--confirm", h.CANARY_CONFIRMATION], { scans });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(printed(result.stdout).at(-1), `WROTE qualification receipt ${RECEIPT_PLACE}: 9 complete and 6 incomplete runs, 15 of 15 scans recorded. Commit and push it now, whatever it holds, before anything else. It is not a verdict: read it with the verdict command.`);
    // The reads of each scan, in panel order: bumble 1 to 5, ssa-gov 1 to 5, who-int 1 to 5.
    const polls = scans.map((scan) => requestsTo(requests, `/api/scans/${scan.jobId}`).length);
    const reads = scans.map((scan) => requestsTo(requests, `/api/reports/${scan.reportId}`).length);
    assert.deepEqual(polls, [5, 1, 180, 180, 180, 180, 1, 2, 5, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(reads, [1, 5, 0, 0, 0, 0, 180, 0, 1, 5, 1, 1, 1, 1, 1]);
    // Each further read came 2 seconds after the one before it, and the command waited for nothing else.
    const further = [...polls, ...reads].reduce((sum, count) => sum + Math.max(count - 1, 0), 0);
    assert.equal(further, 912);
    assert.deepEqual([waits.length, [...new Set(waits)]], [further, [2_000]]);
    // No read caused a second scan: each of the fifteen was submitted once.
    const submissions = requests.filter((request) => request.path === "/api/scan");
    assert.deepEqual(submissions.map((request) => [request.method, request.body?.url]), scans.map((scan) => ["POST", scan.url]));

    const receipt = JSON.parse(readFileSync(receiptIn(tree), "utf8")) as Receipt;
    assert.deepEqual(receipt, { ...(await qualificationReceipt(scenario)), createdAt: receipt.createdAt } as Receipt);
    assert.deepEqual(receipt.incompleteRuns.map((entry: Receipt) => [entry.caseId, entry.repetition, entry.notComplete]), [
      ["bumble", 3, [h.JOB_FACTS.statusUnreadable]],
      ["bumble", 4, [h.JOB_FACTS.timedOut]],
      ["bumble", 5, [h.JOB_FACTS.timedOut]],
      ["ssa-gov", 1, [h.JOB_FACTS.statusUnreadable]],
      ["ssa-gov", 2, [h.JOB_FACTS.reportUnreadable]],
      ["ssa-gov", 3, [h.JOB_FACTS.failed]]
    ]);
    assert.deepEqual(receipt.runs.map((run: Receipt) => `${run.caseId}:${run.repetition}`), ["bumble:1", "bumble:2", "ssa-gov:4", "ssa-gov:5", "who-int:1", "who-int:2", "who-int:3", "who-int:4", "who-int:5"]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("a qualifying capture that is stopped from outside has lost no scan it finished, its receipt is whole at every moment, and an empty receipt means that nothing was submitted", async () => {
  const h = await helpers;
  const QUALIFY = ["qualify", "--expected-build", BUILD, "--confirm", h.CANARY_CONFIRMATION];
  const all = () => plannedScans(qualificationPanel.cases, qualificationPanel.repetitions, {});
  const sibling = (tree: string) => `${receiptIn(tree)}.partial`;
  const held = (file: string) => {
    const receipt = JSON.parse(readFileSync(file, "utf8")) as Receipt;
    return [receipt.runs.length + receipt.incompleteRuns.length, receipt.finished, receipt.endedEarly, receipt.healthAfter];
  };
  const inPlace = (tree: string) => readdirSync(path.dirname(receiptIn(tree))).sort();
  const refusedAgain = (tree: string) => {
    const second = againstStandIn(tree, QUALIFY, { scans: all() });
    assert.equal(second.result.status, 1);
    assert.deepEqual(printed(second.result.stderr), [`FAIL Refusing to overwrite existing qualification receipt ${RECEIPT_PLACE}.`]);
    assert.deepEqual(second.requests, []);
  };
  const EMPTY = `FAIL The qualification receipt at ${RECEIPT_PLACE} is empty. The capture was stopped before its first scan was submitted, so it has not been used: remove the empty file.`;

  // Stopped during the first health read. The receipt is there and empty,
  // and nothing was submitted. The command does not judge that for itself:
  // it refuses to run while the file exists. The verdict says what an empty
  // receipt means, and with the empty file removed the capture runs.
  {
    const tree = treeOnV1();
    try {
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all(), stop: { health: 1 } });
      assert.equal(result.signal, "SIGKILL");
      assert.deepEqual(requests.map((request) => [request.path, request.receipt]), [["/api/health", "empty"]]);
      assert.equal(readFileSync(receiptIn(tree), "utf8"), "");
      assert.equal(statSync(receiptIn(tree)).mode & 0o777, 0o600);
      assert.deepEqual(inPlace(tree), ["qualification-receipt.json"]);
      const verdict = canary(tree, ["verdict"]);
      assert.equal(verdict.status, 1);
      assert.deepEqual([verdict.stdout, printed(verdict.stderr)], ["", [EMPTY]]);
      refusedAgain(tree);
      rmSync(receiptIn(tree));
      const run = againstStandIn(tree, QUALIFY, { scans: all() });
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.deepEqual(held(receiptIn(tree)), [15, true, null, { ok: true }]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // Stopped during the health read after the last scan. All fifteen scans
  // are in the receipt, which is not finished, and every case is judged.
  {
    const tree = treeOnV1();
    try {
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all(), stop: { health: 2 } });
      assert.equal(result.signal, "SIGKILL");
      assert.equal(requests.filter((request) => request.path === "/api/scan").length, 15);
      assert.deepEqual(held(receiptIn(tree)), [15, false, null, null]);
      assert.deepEqual(inPlace(tree), ["qualification-receipt.json"]);
      const verdict = await verdictOn(JSON.parse(readFileSync(receiptIn(tree), "utf8")) as Receipt);
      assert.deepEqual([verdict.finished, verdict.cases.map((entry) => entry.judged)], [false, [true, true, true]]);
      assert.deepEqual(takers(verdict), { "theguardian.com": "bumble.com", "gov.uk": "ssa.gov" });
      const printedVerdict = canary(tree, ["verdict"]);
      assert.equal(printedVerdict.status, 0, printedVerdict.stderr);
      assert.deepEqual(printed(printedVerdict.stdout), h.formatQualificationVerdict(verdict));
      assert.equal(printed(printedVerdict.stdout).some((line) => line.startsWith("CASE who-int (who.int): QUALIFIES")), true, printedVerdict.stdout);
      refusedAgain(tree);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // Stopped while the receipt was being replaced before scan 8, with the new
  // text written beside it and not yet in its place. The receipt is whole
  // and holds the six scans of the write before. The file beside it is no
  // receipt: the verdict reads the receipt, and the command leaves both.
  {
    const tree = treeOnV1();
    try {
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all(), stop: { replacement: 8 } });
      assert.equal(result.signal, "SIGKILL");
      assert.equal(requests.filter((request) => request.path === "/api/scan").length, 7);
      assert.deepEqual(held(receiptIn(tree)), [6, false, null, null]);
      assert.deepEqual(held(sibling(tree)), [7, false, null, null]);
      assert.deepEqual(inPlace(tree), ["qualification-receipt.json", "qualification-receipt.json.partial"]);
      assert.deepEqual([statSync(receiptIn(tree)).mode & 0o777, statSync(sibling(tree)).mode & 0o777], [0o600, 0o600]);
      const verdict = await verdictOn(JSON.parse(readFileSync(receiptIn(tree), "utf8")) as Receipt);
      assert.deepEqual(verdict.cases.map((entry) => [entry.judged, entry.recordedRuns]), [[true, 5], [false, 1], [false, 0]]);
      assert.equal(canary(tree, ["verdict"]).status, 0);
      refusedAgain(tree);
      assert.deepEqual(inPlace(tree), ["qualification-receipt.json", "qualification-receipt.json.partial"]);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // A replacement that fails ends the command. The receipt is whole and
  // holds the scans of the write before, and nothing is left beside it.
  {
    const tree = treeOnV1();
    try {
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all(), fail: { replacement: 8 } });
      assert.equal(result.status, 1);
      assert.deepEqual(printed(result.stderr), ["FAIL EIO: the disk refused the rename"]);
      assert.equal(requests.filter((request) => request.path === "/api/scan").length, 7);
      assert.deepEqual(held(receiptIn(tree)), [6, false, null, null]);
      assert.deepEqual(inPlace(tree), ["qualification-receipt.json"]);
      refusedAgain(tree);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // Stopped at the first replacement, before any scan was submitted: the
  // receipt is empty still, and the file beside it does not make it one.
  // With the empty receipt removed, a capture that its gate then stops takes
  // the file beside it away too, and its directory with it.
  {
    const tree = treeOnV1();
    try {
      const { result, requests } = againstStandIn(tree, QUALIFY, { scans: all(), stop: { replacement: 1 } });
      assert.equal(result.signal, "SIGKILL");
      assert.deepEqual(requests.map((request) => request.path), ["/api/health"]);
      assert.equal(readFileSync(receiptIn(tree), "utf8"), "");
      assert.deepEqual(held(sibling(tree)), [0, false, null, null]);
      assert.deepEqual(printed(canary(tree, ["verdict"]).stderr), [EMPTY]);
      rmSync(receiptIn(tree));
      assert.deepEqual(printed(canary(tree, ["verdict"]).stderr), [`FAIL There is no qualification receipt to read at ${RECEIPT_PLACE}.`]);
      const gated = againstStandIn(tree, QUALIFY, { scans: all(), health: [stagingHealth("d".repeat(40))] });
      assert.equal(gated.result.status, 1);
      assert.equal(existsSync(path.dirname(receiptIn(tree))), false);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  }

  // A file left beside the receipt's place neither blocks the capture nor
  // becomes its receipt: whatever it is, a file open to others or a link to
  // a file elsewhere, the capture makes its own, and at the end the
  // directory holds the receipt and nothing else.
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-outside-")));
  try {
    const elsewhere = path.join(outside, "kept.json");
    const leftovers: Array<[string, (file: string) => void]> = [
      ["a file open to others", (file) => writeFileSync(file, "not a receipt", { mode: 0o644 })],
      ["a link to a file elsewhere", (file) => symlinkSync(elsewhere, file)],
      ["a link to nothing", (file) => symlinkSync(path.join(outside, "not-there.json"), file)]
    ];
    for (const [label, leave] of leftovers) {
      writeFileSync(elsewhere, "kept");
      const tree = treeOnV1();
      try {
        mkdirSync(path.dirname(receiptIn(tree)), { recursive: true });
        leave(sibling(tree));
        const run = againstStandIn(tree, QUALIFY, { scans: all() });
        assert.equal(run.result.status, 0, `${label}: ${run.result.stderr}`);
        assert.deepEqual(inPlace(tree), ["qualification-receipt.json"], label);
        assert.equal(lstatSync(receiptIn(tree)).isFile(), true, label);
        assert.equal(statSync(receiptIn(tree)).mode & 0o777, 0o600, label);
        assert.deepEqual(held(receiptIn(tree)), [15, true, null, { ok: true }], label);
        assert.deepEqual([readFileSync(elsewhere, "utf8"), readdirSync(outside)], ["kept", ["kept.json"]], label);
      } finally {
        rmSync(tree, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a comparison capture opens its receipt before its first request, never under public/, applies its health gate once, reads a scan again inside its window, and is whole or leaves nothing", async () => {
  const h = await helpers;
  const tree = treeOnV1();
  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "sbl-toolchain-canary-capture-")));
  try {
    const steady = Object.fromEntries(panelV1.cases.map((entry) => [entry.id, (): RunSpec => ({ counts: PROFILE["ssa-gov"] })]));
    const scans = (scenario: Scenario = {}, answers: Record<string, Answers> = {}) => plannedScans(panelV1.cases, panelV1.repetitions, { ...steady, ...scenario }, answers);
    const capture = (out: string) => ["capture", "--expected-build", BUILD, "--order", "forward", "--out", out, "--confirm", h.CANARY_CONFIRMATION];

    // A target that cannot be the receipt is refused before any request.
    symlinkSync(path.join(tree, "public"), path.join(work, "elsewhere"), "dir");
    const existing = path.join(work, "existing-receipt.json");
    writeFileSync(existing, "kept");
    const refusals: Array<[string, string, string]> = [
      ["a directory that is not there", path.join(work, "missing", "receipt.json"), `FAIL The directory for the receipt does not exist: ${path.join(work, "missing")}.`],
      ["a file that is already there", existing, `FAIL Refusing to overwrite existing receipt ${existing}.`],
      ["public/", path.join(tree, "public", "receipt.json"), "FAIL Canary receipts must never be written under public/."],
      ["public/ through a link", path.join(work, "elsewhere", "receipt.json"), "FAIL Canary receipts must never be written under public/."],
      // Where the temporary directory has two names (/tmp and /private/tmp), the
      // other name for the same public/ is refused as well.
      ["public/ under another name for the tree", path.join(tmpdir(), path.basename(tree), "public", "receipt.json"), "FAIL Canary receipts must never be written under public/."]
    ];
    for (const [label, out, message] of refusals) {
      const { result, requests } = againstStandIn(tree, capture(out), { scans: scans() });
      assert.equal(result.status, 1, label);
      assert.equal(result.stdout, "", label);
      assert.deepEqual(printed(result.stderr), [message], label);
      assert.deepEqual(requests, [], label);
      assert.equal(existsSync(path.join(tree, "public", "receipt.json")), false, label);
    }
    assert.equal(readFileSync(existing, "utf8"), "kept");

    // A failed job ends it, as before, and the file it opened is gone.
    const out = path.join(work, "capture-receipt.json");
    const failed = againstStandIn(tree, capture(out), { scans: scans({ github: (repetition) => ({ counts: PROFILE["ssa-gov"], noReport: repetition === 2 ? "failed" : undefined }) }) });
    assert.equal(failed.result.status, 1);
    assert.deepEqual(printed(failed.result.stderr), ["FAIL Canary job failed."]);
    assert.deepEqual(printed(failed.result.stdout), ["[1/15] wikipedia repetition 1", "[2/15] wikipedia repetition 2", "[3/15] wikipedia repetition 3", "[4/15] github repetition 1", "[5/15] github repetition 2"]);
    assert.equal(existsSync(out), false);
    // So does a health read that fails on every try after the last scan: a comparison capture is whole or it is nothing.
    const unhealthy = againstStandIn(tree, capture(out), { scans: scans(), health: [HEALTHY, 503] });
    assert.equal(unhealthy.result.status, 1);
    assert.deepEqual(printed(unhealthy.result.stderr), ["FAIL Authenticated staging health returned 503."]);
    assert.deepEqual([requestsTo(unhealthy.requests, "/api/health").length, unhealthy.waits], [4, [1_000, 2_000]]);
    assert.equal(existsSync(out), false);

    // The health gate is applied once, to the first health that was read. A
    // health that reports another build is not asked for again, though the
    // third answer would have passed: nothing is submitted.
    const degraded = { ...HEALTHY, status: "degraded", warnings: ["report store"] };
    const otherBuild = stagingHealth("d".repeat(40));
    const wrongBuild = againstStandIn(tree, capture(out), { scans: scans(), health: [otherBuild, otherBuild, HEALTHY] });
    assert.equal(wrongBuild.result.status, 1);
    assert.deepEqual([wrongBuild.result.stdout, printed(wrongBuild.result.stderr)], ["", ["FAIL Staging health does not match the expected build SHA."]]);
    assert.deepEqual([wrongBuild.requests.map((request) => request.path), wrongBuild.waits], [["/api/health"], []]);
    assert.equal(existsSync(out), false);
    // A health after the last scan that carries a warning once is a failed
    // capture, though the next answer would have been clean: no receipt.
    const warned = againstStandIn(tree, capture(out), { scans: scans(), health: [HEALTHY, degraded, HEALTHY] });
    assert.equal(warned.result.status, 1);
    assert.deepEqual(printed(warned.result.stderr), ["FAIL Staging health must report status=ok and warnings=[]."]);
    assert.deepEqual([warned.requests.filter((request) => request.path === "/api/scan").length, requestsTo(warned.requests, "/api/health").length, warned.waits], [15, 2, []]);
    assert.equal(existsSync(out), false);

    // A scan whose status, or whose saved report, cannot be read at any poll
    // of its window of 180 ends the capture then, and not before.
    const python1 = scans()[6];
    const unreadable: Array<[Answers, string, string, number]> = [
      [{ statuses: [503] }, "FAIL Canary job status read failed.", `/api/scans/${python1.jobId}`, 179],
      [{ reports: [503] }, `FAIL Saved report read failed: /api/reports/${python1.reportId} returned 503.`, `/api/reports/${python1.reportId}`, 179]
    ];
    for (const [answers, message, read, waited] of unreadable) {
      const ended = againstStandIn(tree, capture(out), { scans: scans({}, { "python:1": answers }) });
      assert.equal(ended.result.status, 1, message);
      assert.deepEqual(printed(ended.result.stderr), [message]);
      assert.deepEqual([requestsTo(ended.requests, read).length, ended.waits.length, [...new Set(ended.waits)]], [180, waited, [2_000]], message);
      assert.equal(ended.requests.filter((request) => request.path === "/api/scan").length, 7, message);
      assert.equal(existsSync(out), false, message);
    }

    // A capture that is stopped from outside leaves the file it opened, empty.
    // It is no receipt: the comparison refuses it and a capture refuses to
    // write over it, until it is removed.
    const stopped = againstStandIn(tree, capture(out), { scans: scans(), stop: { health: 2 }, receipt: out });
    assert.equal(stopped.result.signal, "SIGKILL");
    assert.equal(readFileSync(out, "utf8"), "");
    // The file was empty at every request: it is written once, at the end.
    assert.deepEqual([...new Set(stopped.requests.filter((request) => request.receipt !== undefined).map((request) => request.receipt))], ["empty"]);
    const over = againstStandIn(tree, capture(out), { scans: scans() });
    assert.deepEqual([over.result.status, printed(over.result.stderr), over.requests], [1, [`FAIL Refusing to overwrite existing receipt ${out}.`], []]);
    assert.equal(canary(tree, ["compare", "--baseline", out, "--candidate", out]).status, 1);
    rmSync(out);

    // With four status polls of one scan and four reads of another scan's
    // saved report failing, and one health read failing once, it reads them
    // again and writes its receipt.
    const clean = againstStandIn(tree, capture(out), { scans: scans({}, { "python:1": { statuses: [503, 0, 503, 0, "succeeded"] }, "github:1": { reports: [503, 0, 503, 0, 200] } }), health: [HEALTHY, 503, HEALTHY] });
    assert.equal(clean.result.status, 0, clean.result.stderr);
    assert.equal(printed(clean.result.stdout).at(-1), `PASS wrote create-only local receipt ${out}`);
    assert.equal(clean.requests.filter((request) => request.path === "/api/scan").length, 15);
    assert.equal(requestsTo(clean.requests, "/api/health").length, 3);
    assert.deepEqual(clean.waits, [2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 2_000, 1_000]);
    // The last thing it did was to flush the receipt it had written, after its last health read.
    assert.equal(clean.last, "flush");
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(work).sort(), ["capture-receipt.json", "elsewhere", "existing-receipt.json"]);
    const receipt = JSON.parse(readFileSync(out, "utf8")) as Receipt;
    assert.equal(receipt.kind, "site-behavior-toolchain-canary-capture");
    assert.equal(receipt.panelDigest, h.panelDigest(panelV1));
    assert.equal(receipt.runs.length, 15);
    await assert.rejects(verdictOn(receipt), /A capture receipt is one arm of a comparison/);
  } finally {
    rmSync(tree, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
