import { createHash } from "node:crypto";

export const CANARY_ORIGIN = "https://scan-staging.sitebehavior.org";
export const CANARY_CONFIRMATION = "I_ACKNOWLEDGE_THIS_SUBMITS_LIVE_STAGING_SCANS";
export const RECEIPT_VERSION = 2;
export const CAPTURE_RECEIPT_KIND = "site-behavior-toolchain-canary-capture";
/**
 * A qualification receipt judges candidate cases on one build. It is a kind
 * of its own so that no command can take it for one arm of a comparison:
 * assertReceipt refuses it by name.
 */
export const QUALIFICATION_RECEIPT_KIND = "site-behavior-toolchain-canary-qualification";
/**
 * The comparison panel versions assertPanel accepts. Version 1 is the panel
 * every receipt committed through 2026-11 carries. Version 2 is the current
 * panel since 2026-11-11. Its cases were decided by one qualifying capture,
 * under a rule that was fixed before that capture ran.
 */
export const PANEL_VERSIONS = Object.freeze([1, 2]);
/**
 * Every comparison panel a receipt may carry is committed here, one file per
 * panel, named for its panelId: the current panel and each panel before it.
 * The replay command reads a receipt against the panel it was captured with
 * from this directory, so a receipt stays readable after the current panel
 * (scripts/fixtures/toolchain-canary-panel.json) moves on.
 */
export const COMMITTED_PANEL_DIRECTORY = "scripts/fixtures/toolchain-canary-panels";
export const METRICS = Object.freeze([
  "totalRequests",
  "thirdPartyRequests",
  "knownTrackerRequests",
  "thirdPartyDomains",
  "cookies",
  "thirdPartyCookies",
  "storageEntries",
  "fingerprintEvents",
  "shieldsBlockedRequests"
]);

/**
 * The evidence family each canary metric is counted from, per the report's
 * claim relation (REPORT_CLAIM_REQUIREMENTS in lib/report-facts.ts), which
 * lib/toolchain-canary.test.ts pins this map to. Recorded capture loss in a
 * family censors it and leaves the metrics it feeds inexact (lower bounds for
 * the request and fingerprint counts, incomplete snapshots for cookies and
 * storage), so the comparison leaves those metrics out for that site, as the
 * report's claim eligibility does for a censored family. The pair
 * comparability evaluator is coarser: a loss in any of requests, cookies or
 * storage makes its whole raw-counts family ineligible.
 */
export const METRIC_EVIDENCE_FAMILIES = Object.freeze({
  totalRequests: "requests",
  thirdPartyRequests: "requests",
  knownTrackerRequests: "requests",
  thirdPartyDomains: "requests",
  cookies: "cookies",
  thirdPartyCookies: "cookies",
  storageEntries: "storage",
  fingerprintEvents: "fingerprinting",
  shieldsBlockedRequests: "requests"
});

/**
 * The families whose capture loss compareReceipts compares strictly: exactly
 * the families METRIC_EVIDENCE_FAMILIES counts a canary metric from. A loss in
 * any other family (detector output, consent verification, or a family added
 * later) feeds no compared median, so it fails the comparison only when it
 * differs systematically between the builds, and is otherwise noted.
 */
export const METRIC_FEEDING_FAMILIES = Object.freeze([...new Set(Object.values(METRIC_EVIDENCE_FAMILIES))].sort());

/**
 * The identity of the rule compareReceipts judges a compared median by. Every
 * result carries it and the compare command prints it ahead of any verdict on
 * a median, so a result recorded under one rule cannot be read as a result of
 * another. The rule before this one compared the two medians alone and had no
 * identifier: a PASS line, or a FAIL line for a metric, with no RULE line
 * ahead of it was judged by that rule. Change this identifier whenever the
 * rule that turns two sets of repetitions into pass, fail or inconclusive
 * changes.
 */
export const COMPARISON_RULE = "median-with-within-arm-spread-v2";

const SLUG = /^[a-z0-9-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;
// The form the capture writes its creation time in (Date.prototype.toISOString).
const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const ADBLOCK_ENGINE_VERSION = /^adblock-rust-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PLAYWRIGHT_VERSION_COMPONENT = /-playwright-[0-9]+\.[0-9]+\.[0-9]+(?=\+|$)/g;
const TLDTS_VERSION_COMPONENT = /tldts@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?/g;
const CATALOGS = new Set(["public/featured-sites.json", "public/corpus-seed-sites.json"]);

const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const same = (left, right) => stableCompareJson(left) === stableCompareJson(right);
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

/**
 * Key-sorted JSON for COMPARING two in-memory canary values and, through
 * panelDigest, for naming a panel inside a canary receipt. Deliberately not
 * the published canonicalizer in lib/canonical-json.ts: no published report
 * is digested with it, so it carries no NFC or non-finite rules. It is named
 * apart so the two can never be mistaken for one contract.
 */
export function stableCompareJson(value) {
  if (value === undefined) throw new TypeError("stableCompareJson: undefined is not comparable.");
  if (Array.isArray(value)) return `[${value.map(stableCompareJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableCompareJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function requireCanaryOrigin(value = CANARY_ORIGIN) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Canary origin must be exactly ${CANARY_ORIGIN}.`);
  }
  requireValue(
    parsed.origin === CANARY_ORIGIN && parsed.pathname === "/" && !parsed.search && !parsed.hash && !parsed.username && !parsed.password,
    `Canary origin must be exactly ${CANARY_ORIGIN}.`
  );
  return CANARY_ORIGIN;
}

export function requireAccessToken(value) {
  requireValue(typeof value === "string" && value === value.trim() && value.length >= 32 && value.length <= 4096, "TOOLCHAIN_CANARY_ACCESS_TOKEN must be a trimmed value of at least 32 characters.");
  requireValue(!/[\r\n]/.test(value), "TOOLCHAIN_CANARY_ACCESS_TOKEN must be a valid header value.");
  return value;
}

export function requireCommitSha(value) {
  requireValue(typeof value === "string" && SHA40.test(value), "--expected-build must be an exact lowercase 40-character commit SHA.");
  return value;
}

export function assertHealthGate(value, expectedBuild) {
  requireCommitSha(expectedBuild);
  requireValue(record(value) && value.ok === true, "Authenticated staging health is not ok.");
  requireValue(value.status === "ok" && Array.isArray(value.warnings) && value.warnings.length === 0, "Staging health must report status=ok and warnings=[].");
  requireValue(value.deployment === expectedBuild, "Staging health does not match the expected build SHA.");
  requireValue(value.authenticated === true && value.openAccess === false && value.turnstile === false, "Canary requires a token-gated, non-public staging origin.");
  requireValue(value.scansAvailable === true, "Canary requires scansAvailable=true.");
  requireValue(value.storage === "r2", "Canary requires storage=r2.");
  requireValue(value.capabilities?.singleScan === true && value.capabilities?.savedReports === true, "Canary requires live single scans with saved reports.");
  requireValue(value.checks?.scanAccess === "configured", "Canary requires configured scan access.");
  requireValue(value.checks?.chromiumSandbox === "enabled", "Canary requires the Chromium sandbox.");
  requireValue(value.checks?.adblock?.active === true, "Canary requires the adblock engine.");
  requireValue(value.checks?.scannerEgressRegion === "configured", "Canary requires a recorded egress region.");
  requireValue(value.checks?.publicR2Reports?.status === "enabled", "Canary requires public r2 reports.");
  requireValue(value.checks?.reportStore?.kind === "r2" && value.checks?.reportStore?.configuredPath === true, "Canary requires a configured R2 report store.");
  const durable = value.checks?.durableJobs;
  requireValue(durable?.requested === true && durable?.enabled === true && durable?.readiness === "ready", "Canary requires the ready isolated staging lane.");
  requireValue(durable?.coordinatorOrigin === CANARY_ORIGIN, "Staging coordinator origin does not match the canary origin.");
  requireValue(durable?.faultInjection?.environment === "staging" && durable.faultInjection.enabled === true && durable.faultInjection.wholeOriginAccessGate === true, "Health does not attest the staging-only whole-origin gate.");
  return value;
}

// What a comparison panel and a qualification panel both fix: how often each
// case is scanned, under which conditions, and the tolerance of each metric.
function assertPanelMeasurement(value) {
  requireValue(Number.isSafeInteger(value.repetitions) && value.repetitions >= 3 && value.repetitions <= 9 && value.repetitions % 2 === 1, "Panel repetitions must be an odd integer from 3 through 9.");
  requireValue(same(value.conditions, { device: "desktop", gpcEnabled: true, consentMode: "observe" }), "Panel conditions must pin the ordinary desktop single-scan profile.");
  requireValue(record(value.metricTolerances) && same(Object.keys(value.metricTolerances).sort(), [...METRICS].sort()), "Panel must define exactly the canary metric tolerances.");
  for (const metric of METRICS) {
    const tolerance = value.metricTolerances[metric];
    requireValue(record(tolerance) && Number.isFinite(tolerance.absolute) && tolerance.absolute >= 0 && Number.isFinite(tolerance.relative) && tolerance.relative >= 0 && tolerance.relative <= 1, `Invalid tolerance for ${metric}.`);
  }
}

function assertPanelCases(cases) {
  const ids = new Set();
  for (const entry of cases) {
    requireValue(record(entry) && SLUG.test(entry.id) && !ids.has(entry.id), "Panel case ids must be unique slugs.");
    ids.add(entry.id);
    requireValue(CATALOGS.has(entry.catalog), `Panel case ${entry.id} uses an unapproved catalog.`);
    const url = new URL(entry.url);
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, `Panel case ${entry.id} must use a public HTTPS URL without private components.`);
    requireValue(typeof entry.domain === "string" && entry.domain.length > 0, `Panel case ${entry.id} is missing its catalog domain.`);
  }
}

function assertCasesPinned(cases, catalogs) {
  for (const entry of cases) {
    const catalog = catalogs[entry.catalog];
    requireValue(record(catalog) && Array.isArray(catalog.sites), `Could not read ${entry.catalog}.`);
    requireValue(catalog.sites.some((site) => site?.domain === entry.domain && site?.url === entry.url), `Panel case ${entry.id} is not pinned exactly in ${entry.catalog}.`);
  }
}

export function assertPanel(value) {
  requireValue(record(value) && PANEL_VERSIONS.includes(value.panelVersion) && typeof value.panelId === "string", "Invalid toolchain canary panel.");
  assertPanelMeasurement(value);
  requireValue(Array.isArray(value.cases) && value.cases.length === 5, "The toolchain canary panel must contain exactly five sites.");
  assertPanelCases(value.cases);
  return value;
}

export function assertPanelCatalogMembership(panel, catalogs) {
  assertPanel(panel);
  assertCasesPinned(panel.cases, catalogs);
}

/**
 * The digest a receipt names its panel by: SHA-256 over the key-sorted JSON
 * of the panel, so the layout of a panel file does not move it.
 */
export function panelDigest(panel) {
  return createHash("sha256").update(stableCompareJson(panel)).digest("hex");
}

/**
 * The committed panels, from the entries of COMMITTED_PANEL_DIRECTORY as
 * { name, text } pairs. Each file must hold one valid comparison panel and be
 * named for its panelId, and no two may share a version. The digest covers
 * the version, so a receipt's panel digest names at most one of them. Any
 * other entry, a stray system file included, is refused by name: a directory
 * that is read whole must hold nothing that was not put there on purpose.
 */
export function readCommittedPanels(files) {
  requireValue(Array.isArray(files) && files.length > 0, `${COMMITTED_PANEL_DIRECTORY} holds no committed panel.`);
  const panels = [];
  for (const file of [...files].sort((left, right) => (left?.name < right?.name ? -1 : left?.name > right?.name ? 1 : 0))) {
    requireValue(record(file) && typeof file.name === "string" && typeof file.text === "string", `${COMMITTED_PANEL_DIRECTORY} has an unreadable entry.`);
    const where = `${COMMITTED_PANEL_DIRECTORY}/${file.name}`;
    let parsed;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      throw new Error(`${where} is not JSON. Remove it: ${COMMITTED_PANEL_DIRECTORY} holds committed panel files and nothing else, and no canary command runs while it holds anything it cannot read.`);
    }
    let panel;
    try {
      panel = assertPanel(parsed);
    } catch (error) {
      throw new Error(`${where} is not a committed panel: ${error instanceof Error ? error.message : "It could not be read."} ${COMMITTED_PANEL_DIRECTORY} holds committed panel files and nothing else, and no canary command runs while it holds anything it cannot read. Remove the file if it was never a committed panel, and restore it from git if it was.`);
    }
    requireValue(SLUG.test(panel.panelId) && file.name === `${panel.panelId}.json`, `${where} must be named for its panelId.`);
    requireValue(!panels.some((entry) => entry.panel.panelVersion === panel.panelVersion), `${where} repeats the version of another committed panel.`);
    panels.push(Object.freeze({ panel, digest: panelDigest(panel), file: where }));
  }
  return Object.freeze(panels);
}

/**
 * The current panel must be one of the committed panels. A receipt captured
 * on a panel that is kept nowhere else could not be replayed once the current
 * panel file changes, so no command runs on such a panel.
 */
export function assertCurrentPanelCommitted(current, committed) {
  requireValue(
    committed.some((entry) => entry.digest === current.digest),
    `The current panel ${current.panel.panelId} is not committed under ${COMMITTED_PANEL_DIRECTORY}. Commit it there as ${current.panel.panelId}.json, so receipts captured on it stay readable after the panel changes.`
  );
}

/**
 * The panel a comparison of two receipts runs on.
 *
 * A release comparison (replay false) runs on the current panel and nothing
 * else. A receipt that names another committed panel is refused here with the
 * command that does read it, so a comparison on a retired panel cannot come
 * out of the command a release decision reads. A receipt whose panel is no
 * committed panel at all gets the current panel back, and compareReceipts
 * then refuses it as it always has.
 *
 * A replay (replay true) runs on the committed panel both receipts carry,
 * whichever that is, and refuses receipts that carry none or that carry two
 * different ones. `current` in the result says whether that panel is also
 * the current one, which it is until the current panel file changes.
 */
export function selectComparisonPanel({ replay, baseline, candidate, current, committed }) {
  const receipts = [["baseline", baseline], ["candidate", candidate]];
  for (const [, receipt] of receipts) refuseQualificationReceipt(receipt);
  const named = (receipt) => committed.find((entry) => record(receipt) && entry.digest === receipt.panelDigest);
  if (!replay) {
    for (const [label, receipt] of receipts) {
      const entry = named(receipt);
      requireValue(
        !entry || entry.digest === current.digest,
        `The ${label} receipt names committed panel ${entry?.panel.panelId} (version ${entry?.panel.panelVersion}), which is not the current panel ${current.panel.panelId} (version ${current.panel.panelVersion}). The compare command judges a release on the current panel only, and a release needs a fresh capture of both builds on that panel. To read these receipts against the panel they were captured with, run the replay command on the same two files: a replay is not a release comparison.`
      );
    }
    return { replay: false, panel: current.panel, digest: current.digest };
  }
  const entry = named(baseline);
  requireValue(
    entry && record(candidate) && candidate.panelDigest === entry.digest && record(baseline.panel) && record(candidate.panel) && same(baseline.panel, entry.panel) && same(candidate.panel, entry.panel),
    `The replay command reads two receipts that both carry the same committed panel from ${COMMITTED_PANEL_DIRECTORY}. One of these carries another panel, or the two carry different ones.`
  );
  return { replay: true, panel: entry.panel, digest: entry.digest, file: entry.file, current: entry.digest === current.digest };
}

/**
 * The first line a replay prints. It names the panel the replay ran on and
 * says whether that is the current panel, so its result cannot be read as a
 * release comparison, which only the compare command produces.
 */
export function replayNotice(selection, current) {
  requireValue(selection?.replay === true, "Only a replay prints a replay notice.");
  const used = `${selection.panel.panelId} (version ${selection.panel.panelVersion}, sha256 ${selection.digest}, ${selection.file})`;
  return selection.current
    ? `REPLAY on committed panel ${used}, the panel both receipts carry. It is also the current panel. A replay is not a release comparison: that is the compare command.`
    : `REPLAY on committed panel ${used}, the panel both receipts carry. It is not the current panel, which is ${current.panel.panelId} (version ${current.panel.panelVersion}). A replay is not a release comparison: that is the compare command, on the current panel.`;
}

function refuseQualificationReceipt(receipt) {
  requireValue(
    !(record(receipt) && receipt.kind === QUALIFICATION_RECEIPT_KIND),
    "A qualification receipt is not a comparison receipt: it judges candidate cases on one build. Read it with the verdict command."
  );
}

// A saved run answers to the checks below. assertCompleteRun applies them in
// the order it has always reported them in, and any one of them refuses the
// run. A qualifying capture applies the same checks in two groups (see
// extractQualificationRun): a run that is not what the canary asked for
// (wrong build, toolchain, conditions or shape) still refuses the capture,
// and a run whose visit did not produce a complete observation, which is what
// runNotComplete lists, is recorded against its case.

function assertRunProvenance(run, expectedBuild, { allowUnrecordedPlaywright = false } = {}) {
  requireValue(record(run) && run.provenance?.observer === "node-playwright" && run.provenance?.acquisition === "public-api" && run.provenance?.buildCommit === expectedBuild, "Saved report has invalid run provenance.");
  const toolchain = run.toolchain;
  requireValue(
    typeof run.provenance.methodologyVersion === "string" && record(run.provenance.detectorRegistry) &&
      typeof run.provenance.detectorRegistry.version === "string" && SHA256.test(run.provenance.detectorRegistry.digest) &&
      record(toolchain) && record(toolchain.trackerCatalog) && typeof toolchain.trackerCatalog.source === "string" &&
      typeof toolchain.trackerCatalog.version === "string" && Number.isSafeInteger(toolchain.trackerCatalog.entries) &&
      toolchain.trackerCatalog.entries >= 0 && SHA256.test(toolchain.trackerCatalog.digest) && record(toolchain.adblock) &&
      typeof toolchain.adblock.source === "string" && Number.isSafeInteger(toolchain.adblock.lists) && toolchain.adblock.lists > 0 &&
      typeof toolchain.adblock.fetchedAt === "string" && SHA256.test(toolchain.adblock.manifestDigest) &&
      ADBLOCK_ENGINE_VERSION.test(toolchain.adblock.engineVersion) && typeof toolchain.normalizationVersion === "string",
    "Saved report has incomplete measurement-toolchain provenance."
  );
  methodologyTemplate(run.provenance.methodologyVersion, toolchain.adblock.engineVersion, { allowUnrecordedPlaywright });
  normalizationTemplate(toolchain.normalizationVersion);
  const conditions = run.conditions;
  requireValue(
    conditions?.gpc === true && conditions.shields === "classification" && conditions.consent === "observe" &&
      same(conditions.device, { kind: "desktop", viewport: { width: 1440, height: 980, isMobile: false } }) &&
      same(conditions.probes, { keystroke: true, policyVisit: true }) && conditions.locale === "en-US" &&
      conditions.language === "en-US" && conditions.timezone === "UTC" && conditions.egress?.label === "cloudflare-containers" &&
      typeof conditions.egress.region === "string" && conditions.egress.region.length > 0 && conditions.browser?.name === "chromium" &&
      typeof conditions.browser.version === "string" && conditions.headless === true && conditions.automation === "playwright-chromium",
    "Saved report does not match the full fixed ordinary single-scan condition vector."
  );
}

// Capture loss is admitted here and judged across builds in compareReceipts:
// in a family that feeds a canary metric, a site keeps a loss only if every
// run of it in both receipts records the same one, and the metrics that
// family feeds are then left out; in any other family a loss fails only when
// it differs systematically between the builds.
function assertCaptureLossShape(run) {
  requireValue(
    Array.isArray(run.qualityFacts?.captureLoss) &&
      run.qualityFacts.captureLoss.every((loss) =>
        record(loss) && typeof loss.family === "string" && loss.family.length > 0 &&
        typeof loss.kind === "string" && loss.kind.length > 0 &&
        (loss.detail === undefined || (typeof loss.detail === "string" && loss.detail.length > 0)) &&
        Number.isSafeInteger(loss.count) && loss.count > 0
      ),
    "Saved report has malformed capture-loss quality facts."
  );
}

function assertRunCounts(run) {
  requireValue(record(run.summary?.counts) && METRICS.every((metric) => Number.isSafeInteger(run.summary.counts[metric]) && run.summary.counts[metric] >= 0), "Saved report is missing a canary count metric.");
}

// The recorded facts that say the visit failed, was walled, did not settle or
// ran out of budget, each as a sentence fragment. Empty when none holds.
function qualityFactsNotComplete(run) {
  const facts = run.qualityFacts;
  const found = [];
  if (!(facts?.status >= 200 && facts.status <= 399)) found.push(facts?.status === null || facts?.status === undefined ? "the document returned no status" : `the document status was ${facts.status}`);
  if (facts?.botWallTitleMatched !== false) found.push("the page title matched a bot wall");
  if (facts?.navigationSettled !== true) found.push("navigation did not settle");
  if (!Array.isArray(facts?.budgetsExhausted)) found.push("no budget record");
  else if (facts.budgetsExhausted.length !== 0) found.push(`budgets exhausted: ${facts.budgetsExhausted.join(", ")}`);
  return found;
}

function runOutcomeNotComplete(run) {
  const outcome = run.quality?.run;
  if (outcome?.outcome === "complete" && Array.isArray(outcome.reasons) && outcome.reasons.length === 0) return [];
  return [`the run-level outcome was ${outcome?.outcome}${Array.isArray(outcome?.reasons) && outcome.reasons.length ? ` (${outcome.reasons.join(", ")})` : ""}`];
}

// The evaluator censors a family exactly when it records capture loss, with
// one capture-loss:<kind> reason per kind. Anything else, or a loss in a
// family the quality block does not carry, is listed here.
function familyCensoringNotComplete(run) {
  const lossKinds = new Map();
  for (const loss of run.qualityFacts.captureLoss) lossKinds.set(loss.family, [...new Set([...(lossKinds.get(loss.family) ?? []), loss.kind])]);
  const byFamily = run.quality?.byFamily;
  if (!record(byFamily)) return ["the per-family quality block is missing"];
  const found = [];
  for (const family of lossKinds.keys()) {
    if (!Object.hasOwn(byFamily, family)) found.push(`capture loss is recorded in ${family}, a family the quality block does not carry`);
  }
  for (const [name, family] of Object.entries(byFamily)) {
    const kinds = lossKinds.get(name);
    const accounted = record(family) && Array.isArray(family.reasons) && (
      kinds
        ? family.outcome === "censored" && same([...family.reasons].sort(), kinds.map((kind) => `capture-loss:${kind}`).sort())
        : family.outcome === "complete" && family.reasons.length === 0
    );
    if (!accounted) found.push(`evidence family ${name} is ${record(family) ? family.outcome : "malformed"}${record(family) && Array.isArray(family.reasons) && family.reasons.length ? ` (${family.reasons.join(", ")})` : ""}, which its recorded capture loss does not account for`);
  }
  return found;
}

function assertCompleteRun(run, expectedBuild, { allowUnrecordedPlaywright = false } = {}) {
  assertRunProvenance(run, expectedBuild, { allowUnrecordedPlaywright });
  requireValue(qualityFactsNotComplete(run).length === 0, "Saved report has failed, bot-wall, timeout, or budget quality facts.");
  assertCaptureLossShape(run);
  requireValue(runOutcomeNotComplete(run).length === 0, "Saved report is not run-level complete.");
  requireValue(familyCensoringNotComplete(run).length === 0, "Saved report has evidence families censored by something other than its recorded capture loss.");
  assertRunCounts(run);
}

/**
 * Why a run that is what the canary asked for is still not a complete
 * observation, as the facts its own report records. Empty exactly when the
 * three completeness checks of assertCompleteRun pass, because those checks
 * are these lists being empty.
 */
function runNotComplete(run) {
  return [...qualityFactsNotComplete(run), ...runOutcomeNotComplete(run), ...familyCensoringNotComplete(run)];
}

// A qualifying capture keeps a run that is not complete, so it reads the
// quality facts of such a run and cannot leave their shape to the checks that
// would have refused it. The committed report schema already holds a saved
// report to this shape; a receipt read back from disk is held to it here.
function assertQualityShape(run) {
  const facts = run.qualityFacts;
  const quality = run.quality;
  const strings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
  requireValue(
    record(facts) && (facts.status === null || (Number.isSafeInteger(facts.status) && facts.status >= 100 && facts.status <= 599)) &&
      typeof facts.botWallTitleMatched === "boolean" && typeof facts.navigationSettled === "boolean" && strings(facts.budgetsExhausted) &&
      record(quality) && record(quality.run) && typeof quality.run.outcome === "string" && strings(quality.run.reasons) &&
      record(quality.byFamily) && Object.values(quality.byFamily).every((family) => record(family) && typeof family.outcome === "string" && strings(family.reasons)),
    "Saved report has malformed quality facts."
  );
}

// Everything about a run that a qualifying capture still refuses outright:
// the build, toolchain and condition vector it must come from, and the shape
// of what it records. What is left for runNotComplete is the visit itself.
function assertRunIdentity(run, expectedBuild) {
  assertRunProvenance(run, expectedBuild);
  assertQualityShape(run);
  assertCaptureLossShape(run);
  assertRunCounts(run);
}

function assertSavedSingle(report, reportId, reportWireSha256) {
  requireValue(record(report) && report.schemaVersion === 2 && report.schemaRevision === 2 && report.reportType === "single" && !Object.hasOwn(report, "ephemeral"), "Saved report must be a public v2/r2 single.");
  requireValue(REPORT_ID.test(reportId) && report.share?.id === reportId && report.share?.path === `/reports/${reportId}` && report.share?.jsonPath === `/api/reports/${reportId}`, "Saved report does not match the admission-minted report id.");
  requireValue(SHA256.test(reportWireSha256), "Saved report wire digest is invalid.");
}

function capturedRunRecord(report, { reportId, panelCase, sequence, repetition, reportWireSha256 }) {
  return {
    caseId: panelCase.id,
    repetition,
    sequence,
    reportId,
    reportJsonPath: `/api/reports/${reportId}`,
    reportWireSha256,
    runId: report.run.runId,
    startedAt: report.run.startedAt,
    subject: structuredClone(report.run.subject),
    conditions: structuredClone(report.run.conditions),
    provenance: structuredClone(report.run.provenance),
    toolchain: structuredClone(report.run.toolchain),
    qualityFacts: structuredClone(report.run.qualityFacts),
    quality: structuredClone(report.run.quality),
    counts: structuredClone(report.run.summary.counts)
  };
}

export function extractCapturedRun(report, { reportId, expectedBuild, order, panelCase, sequence, repetition, reportWireSha256 }) {
  assertSavedSingle(report, reportId, reportWireSha256);
  requireValue(order === "forward" || order === "reverse", "Capture order is invalid.");
  assertCompleteRun(report.run, expectedBuild, { allowUnrecordedPlaywright: order === "forward" });
  requireValue(report.run.subject?.requested?.origin === new URL(panelCase.url).origin, `Saved report requested subject does not match ${panelCase.id}.`);
  return capturedRunRecord(report, { reportId, panelCase, sequence, repetition, reportWireSha256 });
}

export function buildReceipt({ createdAt, expectedBuild, order, panel, panelDigest, runs }) {
  assertPanel(panel);
  requireCommitSha(expectedBuild);
  requireValue(order === "forward" || order === "reverse", "Capture order must be forward or reverse.");
  requireValue(SHA256.test(panelDigest), "Panel digest is invalid.");
  return {
    receiptVersion: RECEIPT_VERSION,
    kind: CAPTURE_RECEIPT_KIND,
    createdAt,
    origin: CANARY_ORIGIN,
    expectedBuild,
    order,
    panelDigest,
    panel: structuredClone(panel),
    runs
  };
}

// One scan gives one saved report, one run id and one wire digest. A receipt
// that repeats any of the three holds one visit twice, whatever report id the
// copy is filed under, and its medians and spreads would count that visit as
// two.
function assertOwnScan(run, seen) {
  requireValue(REPORT_ID.test(run.reportId) && !seen.reportIds.has(run.reportId) && run.reportJsonPath === `/api/reports/${run.reportId}` && SHA256.test(run.reportWireSha256), "Receipt report identity is invalid.");
  requireValue(
    typeof run.runId === "string" && run.runId.length > 0 && !seen.runIds.has(run.runId) && !seen.wireDigests.has(run.reportWireSha256),
    "Receipt repeats a run id or a report wire digest: each run of a receipt is a scan of its own."
  );
  seen.reportIds.add(run.reportId);
  seen.runIds.add(run.runId);
  seen.wireDigests.add(run.reportWireSha256);
}

function assertReceipt(receipt, expectedPanel, panelDigest, { allowUnrecordedPlaywright = false } = {}) {
  refuseQualificationReceipt(receipt);
  requireValue(record(receipt) && receipt.receiptVersion === RECEIPT_VERSION && receipt.kind === CAPTURE_RECEIPT_KIND, "Invalid canary receipt.");
  requireValue(typeof receipt.createdAt === "string" && TIMESTAMP.test(receipt.createdAt), "Receipt has no creation time.");
  requireValue(receipt.origin === CANARY_ORIGIN && SHA40.test(receipt.expectedBuild) && SHA256.test(receipt.panelDigest), "Receipt origin/build/panel identity is invalid.");
  requireValue(receipt.panelDigest === panelDigest && same(receipt.panel, expectedPanel), "Receipt does not use the committed fixed panel.");
  requireValue(receipt.order === "forward" || receipt.order === "reverse", "Receipt order is invalid.");
  const expectedCases = receipt.order === "forward" ? expectedPanel.cases : [...expectedPanel.cases].reverse();
  const expectedCoverage = [];
  for (const panelCase of expectedCases) for (let repetition = 1; repetition <= expectedPanel.repetitions; repetition += 1) expectedCoverage.push(`${panelCase.id}:${repetition}`);
  requireValue(Array.isArray(receipt.runs) && receipt.runs.length === expectedCoverage.length, "Receipt has incomplete panel coverage.");
  const seen = { reportIds: new Set(), runIds: new Set(), wireDigests: new Set() };
  for (const [index, run] of receipt.runs.entries()) {
    // The repetition is a number: a string or a list that prints as one would
    // pass the comparison of keys below.
    requireValue(record(run) && Number.isSafeInteger(run.repetition) && `${run.caseId}:${run.repetition}` === expectedCoverage[index] && run.sequence === index + 1, "Receipt run order or coverage is invalid.");
    assertOwnScan(run, seen);
    assertCompleteRun(
      { ...run, summary: { counts: run.counts } },
      receipt.expectedBuild,
      { allowUnrecordedPlaywright }
    );
  }
  const first = receipt.runs[0];
  requireValue(receipt.runs.every((run) => same(run.conditions, first.conditions) && same(run.provenance, first.provenance) && same(run.toolchain, first.toolchain)), "Receipt mixes run conditions or toolchain provenance within one deployment.");
  for (const panelCase of expectedPanel.cases) {
    const caseRuns = receipt.runs.filter((run) => run.caseId === panelCase.id);
    requireValue(caseRuns.every((run) => same(run.subject, caseRuns[0].subject)), `Receipt mixes requested or observed subjects within ${panelCase.id}.`);
  }
  return receipt;
}

function withoutExpectedDifferences(run, { allowUnrecordedPlaywright = false } = {}) {
  const conditions = structuredClone(run.conditions);
  conditions.browser.version = "<browser-version>";
  const provenance = structuredClone(run.provenance);
  provenance.buildCommit = "<build>";
  provenance.methodologyVersion = methodologyTemplate(
    provenance.methodologyVersion,
    run.toolchain.adblock.engineVersion,
    { allowUnrecordedPlaywright }
  );
  const toolchain = structuredClone(run.toolchain);
  toolchain.adblock.engineVersion = "<adblock-engine-version>";
  toolchain.normalizationVersion = normalizationTemplate(toolchain.normalizationVersion);
  return { conditions, provenance, toolchain };
}

function methodologyTemplate(value, engineVersion, { allowUnrecordedPlaywright = false } = {}) {
  requireValue(typeof value === "string" && ADBLOCK_ENGINE_VERSION.test(engineVersion), "Canary methodology/adblock provenance is malformed.");
  const pieces = value.split(engineVersion);
  requireValue(pieces.length === 2, "Canary methodology must contain its exact adblock engine version once.");
  const withoutEngine = pieces.join("<adblock-engine-version>");
  const playwrightMatches = withoutEngine.match(PLAYWRIGHT_VERSION_COMPONENT) ?? [];
  requireValue(
    playwrightMatches.length === 1 || (allowUnrecordedPlaywright && playwrightMatches.length === 0),
    "Canary methodology must contain one exact Playwright version."
  );
  return playwrightMatches.length === 0 ? withoutEngine : withoutEngine.replace(playwrightMatches[0], "");
}

function normalizationTemplate(value) {
  requireValue(typeof value === "string", "Canary normalization provenance is malformed.");
  const matches = value.match(TLDTS_VERSION_COMPONENT) ?? [];
  requireValue(matches.length === 1, "Canary normalization provenance must contain exactly one tldts version.");
  return value.replace(matches[0], "tldts@<version>");
}

const feedsMetric = (family) => METRIC_FEEDING_FAMILIES.includes(family);
const feedsNoMetric = (family) => !feedsMetric(family);

/**
 * A run's capture losses in the families `keep` accepts, as sorted
 * family/kind/detail signatures; loss counts vary run to run and are not
 * compared. A loss recorded without a detail is identified by family and kind
 * alone, so two undetailed causes of the same family and kind read as one. In
 * a metric-feeding family that touches only metrics already left out for that
 * site; in any other family a run carrying either cause counts once toward
 * that one signature.
 */
function captureLossSignatures(run, keep) {
  return [...new Set(run.qualityFacts.captureLoss.filter((loss) => keep(loss.family)).map((loss) => `${loss.family}/${loss.kind}/${loss.detail ?? ""}`))].sort();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// The tolerance of a metric at a median: the larger of its committed absolute
// term and its relative term times that median. compareReceipts takes it at
// the baseline median and the qualification rule at the one arm it has.
function toleranceAt(tolerance, at) {
  return Math.max(tolerance.absolute, Math.abs(at) * tolerance.relative);
}

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

// The gap between the two arms' ranges: the smallest difference between a run
// of one build and a run of the other when the ranges do not meet, and zero or
// less when they touch or overlap.
function separation(left, right) {
  return Math.max(Math.min(...left) - Math.max(...right), Math.min(...right) - Math.max(...left));
}

export function compareReceipts(baselineInput, candidateInput, expectedPanel, panelDigest) {
  const baseline = assertReceipt(
    baselineInput,
    expectedPanel,
    panelDigest,
    { allowUnrecordedPlaywright: true }
  );
  const candidate = assertReceipt(candidateInput, expectedPanel, panelDigest);
  requireValue(baseline.order === "forward" && candidate.order === "reverse", "Baseline must be forward and candidate must be reverse.");
  requireValue(baseline.expectedBuild !== candidate.expectedBuild, "Canary receipts must identify distinct exact builds.");
  const byKey = (receipt) => new Map(receipt.runs.map((run) => [`${run.caseId}:${run.repetition}`, run]));
  const baselineRuns = byKey(baseline);
  const candidateRuns = byKey(candidate);
  for (const key of baselineRuns.keys()) {
    const left = baselineRuns.get(key);
    const right = candidateRuns.get(key);
    requireValue(right && same(left.subject, right.subject), `Observed subject mismatch for ${key}.`);
    requireValue(left.conditions.egress.region === right.conditions.egress.region, `Egress region mismatch for ${key}.`);
    requireValue(
      same(
        withoutExpectedDifferences(left, { allowUnrecordedPlaywright: true }),
        withoutExpectedDifferences(right)
      ),
      `Conditions or provenance changed outside Playwright, browser, adblock engine, tldts, and build for ${key}.`
    );
  }
  // Capture loss in a family that feeds a canary metric is compared like with
  // like: every run of a site in both receipts must record the same
  // family/kind/detail signatures in those families, or the loss is itself a
  // difference between the builds. A shared loss leaves out only the metrics
  // its family feeds, for that site.
  //
  // A loss in any other family feeds no compared median. It fails the
  // comparison only when it differs systematically between the builds: more
  // than half of one build's runs of a site carry it and none of the other
  // build's runs do. Otherwise it is returned in `noted`, even when every run
  // of both builds carries it: recorded, not compared. The 2026-10 epoch failed
  // the stricter rule twice on detector-output losses that 1 of 3 runs of one
  // build carried and no run of the other (docs/toolchain-epoch-2026-10.md).
  const lossyFamiliesBySite = new Map();
  const noted = [];
  for (const panelCase of expectedPanel.cases) {
    const baselineCaseRuns = baseline.runs.filter((run) => run.caseId === panelCase.id);
    const candidateCaseRuns = candidate.runs.filter((run) => run.caseId === panelCase.id);
    const signatures = [...baselineCaseRuns, ...candidateCaseRuns].map((run) => JSON.stringify(captureLossSignatures(run, feedsMetric)));
    requireValue(
      signatures.every((signature) => signature === signatures[0]),
      `Capture loss differs between runs of ${panelCase.id}: ${[...new Set(signatures)].join(" vs ")}.`
    );
    lossyFamiliesBySite.set(panelCase.id, new Set(baselineCaseRuns[0].qualityFacts.captureLoss.map((loss) => loss.family).filter(feedsMetric)));
    const baselineOther = baselineCaseRuns.map((run) => captureLossSignatures(run, feedsNoMetric));
    const candidateOther = candidateCaseRuns.map((run) => captureLossSignatures(run, feedsNoMetric));
    for (const signature of [...new Set([...baselineOther, ...candidateOther].flat())].sort()) {
      const baselineRuns = baselineOther.filter((runSignatures) => runSignatures.includes(signature)).length;
      const candidateRuns = candidateOther.filter((runSignatures) => runSignatures.includes(signature)).length;
      const baselineTotal = baselineCaseRuns.length;
      const candidateTotal = candidateCaseRuns.length;
      requireValue(
        !(baselineRuns * 2 > baselineTotal && candidateRuns === 0) && !(candidateRuns * 2 > candidateTotal && baselineRuns === 0),
        `Capture loss ${signature} differs systematically between the builds on ${panelCase.id}: ${baselineRuns} of ${baselineTotal} baseline runs vs ${candidateRuns} of ${candidateTotal} candidate runs.`
      );
      noted.push({ caseId: panelCase.id, signature, baselineRuns, baselineTotal, candidateRuns, candidateTotal });
    }
  }
  for (const metric of METRICS) {
    requireValue(
      expectedPanel.cases.some((panelCase) => !lossyFamiliesBySite.get(panelCase.id).has(METRIC_EVIDENCE_FAMILIES[metric])),
      `${metric} is left out on every panel site, so the canary would not compare it.`
    );
  }
  const excluded = [];
  const results = [];
  for (const panelCase of expectedPanel.cases) {
    for (const metric of METRICS) {
      const family = METRIC_EVIDENCE_FAMILIES[metric];
      if (lossyFamiliesBySite.get(panelCase.id).has(family)) {
        excluded.push({ caseId: panelCase.id, metric, family });
        continue;
      }
      // Each arm's counts in repetition order, which assertReceipt has checked.
      const baselineValues = baseline.runs.filter((run) => run.caseId === panelCase.id).map((run) => run.counts[metric]);
      const candidateValues = candidate.runs.filter((run) => run.caseId === panelCase.id).map((run) => run.counts[metric]);
      const left = median(baselineValues);
      const right = median(candidateValues);
      const tolerance = expectedPanel.metricTolerances[metric];
      const allowed = toleranceAt(tolerance, left);
      const delta = Math.abs(right - left);
      const baselineSpread = spread(baselineValues);
      const candidateSpread = spread(candidateValues);
      const rangeGap = separation(baselineValues, candidateValues);
      // The rule, in order.
      //
      // First, when every run of one build differs from every run of the other
      // by more than the tolerance, the metric fails whatever the spreads. No
      // pairing of runs closes that gap, so what one build shows against
      // itself cannot explain it. Without this, a regression that also makes
      // a count unsteady would be reported as no evidence about the build.
      //
      // Otherwise a difference of medians is evidence about the build only
      // when it is larger than what one build shows against itself. When the
      // repetitions of a single build differ by more than the tolerance, the
      // page varied on its own by more than the comparison allows, so neither
      // a difference nor an agreement of the two medians can be attributed to
      // the build. Such a metric is inconclusive, ahead of both the median
      // pass and the median fail: a pass under that much spread is luck in the
      // same way a fail is. Without this, a page that loads in one of two
      // states of its own fails two identical builds whenever their medians
      // land in different states, and can pass two builds that differ whenever
      // they land in the same one.
      //
      // Otherwise the two medians decide, within the tolerance or beyond it.
      const separated = rangeGap > allowed;
      const outcome = separated ? "fail" : baselineSpread > allowed || candidateSpread > allowed ? "inconclusive" : delta <= allowed ? "pass" : "fail";
      results.push({ caseId: panelCase.id, metric, baseline: left, candidate: right, delta, allowed, pass: outcome === "pass", outcome, baselineValues, candidateValues, baselineSpread, candidateSpread, separation: rangeGap, separated });
    }
  }
  // One failed metric fails the comparison whatever else is inconclusive. An
  // inconclusive metric with no failure is its own result and never a pass.
  const outcome = results.some((result) => result.outcome === "fail") ? "fail" : results.some((result) => result.outcome === "inconclusive") ? "inconclusive" : "pass";
  return { pass: outcome === "pass", outcome, rule: COMPARISON_RULE, baselineBuild: baseline.expectedBuild, candidateBuild: candidate.expectedBuild, results, excluded, noted };
}

// ---------------------------------------------------------------------------
// Changing the panel: the qualification panel, its capture, its receipt, and
// the rule that turns one qualification receipt into the next panel.
// ---------------------------------------------------------------------------

export const QUALIFICATION_PANEL_VERSION = 1;

/**
 * The most scans one qualifying capture may submit: cases times repetitions.
 * The owner's spending ceiling for the qualifying capture covers fifteen
 * staging scans, the size of one comparison arm (five cases at three
 * repetitions), so a qualification panel that would submit more is refused
 * before anything is submitted.
 */
export const QUALIFICATION_MAX_SCANS = 15;

const GUARDIAN_DOMAIN = "theguardian.com";

/**
 * The five metrics on which the Guardian is the only case of panel version 1
 * whose zeroed count fails the comparison: its median is above the tolerance
 * and no other case's is. Source: the per-metric table of the 2026-11-10
 * panel analysis over the ten committed receipts (its q1-summary.md, which is
 * kept outside the repository). lib/toolchain-canary-panel-change.test.ts
 * derives the same list from those receipts.
 */
export const GUARDIAN_ONLY_ZEROING_METRICS = Object.freeze([
  "knownTrackerRequests",
  "thirdPartyDomains",
  "thirdPartyCookies",
  "storageEntries",
  "shieldsBlockedRequests"
]);

/**
 * The rule that turns one qualification receipt into the next panel. Every
 * name and number in it was fixed on 2026-11-10, before any qualifying
 * capture ran, so none was chosen with a candidate's counts in view. A change
 * to any of them once a qualification receipt exists is a new rule: it needs
 * a new id and its own capture.
 *
 * A case QUALIFIES when all of these hold:
 * - every one of its runs completed with a 2xx document;
 * - no run records capture loss in a family a canary metric is counted from
 *   (METRIC_FEEDING_FAMILIES);
 * - every run ended on the candidate's own site, which is held on both
 *   things the scanner recorded for the observed subject: its registrable
 *   domain is the candidate's catalog domain, and the host of its origin is
 *   that domain or ends in a dot and that domain. A subdomain of the
 *   candidate meets both and is the candidate's site; another site is not,
 *   however steady its counts, and nor is a record whose two parts disagree;
 * - its runs all landed on one subject, and were all captured under one set
 *   of conditions and toolchain provenance (compareReceipts refuses a receipt
 *   whose runs of one case, or of one build, were not);
 * - for every metric the spread of its runs (largest minus smallest) is at
 *   most the tolerance at their median, the tolerance compareReceipts uses.
 * These conditions are named in `qualifies`, and the verdict applies exactly
 * the ones named there, so the digest of the rule moves when one is added or
 * dropped. A case is judged only when every one of its runs is recorded. One
 * whose capture ended first is not judged, and takes no slot.
 *
 * The loss condition is stricter than compareReceipts, which leaves a metric
 * out when every run of both builds shares a loss. compareReceipts refuses
 * the whole comparison when the loss signatures of a site differ between any
 * two of its runs, so a loss that later shows on some runs only would void a
 * release comparison, and one arm cannot show that it will not.
 *
 * A qualifying case is a SIGNAL case when its median of each signal metric is
 * at least signalMedianFloor. With the committed tolerance of those two
 * metrics (absolute 3, relative 0.3) the tolerance at a median of 8 is 3 and
 * a halved count moves the median by 4. At 7 a halved count can round to a
 * move of 3, which is inside the tolerance.
 *
 * Each slot names the case of panel version 1 that may leave and, in order,
 * the only cases that may take its place. The first listed candidate that
 * qualifies, is a signal case and, for each metric in mustCarry, has a median
 * above the tolerance at that median (so a zeroed count would still fail)
 * takes the slot. If none does, the outgoing case stays.
 *
 * The candidate lists are closed, and that, not the five runs, is the
 * protection against a page with two states. One arm cannot prove that a
 * page has a single state: a page that shows a second state in one visit of
 * three shows only one of the two in 33 of 243 five-run arms, about 14%, and
 * one that shows it in one visit of six, as the Guardian did in its 2026-09
 * and 2026-10 receipts, in 3126 of 7776, about 40%. The committed history of
 * a candidate is the evidence that it has one state, and the lists hold the
 * candidates whose history was accepted when the rule was fixed.
 *
 * Only bumble.com may take the Guardian's slot, and only if it carries the
 * five metrics the Guardian alone carries today, so the change cannot leave
 * the panel with one of them that no case would fail on.
 */
export const QUALIFICATION_RULE = Object.freeze({
  id: "panel-qualification-2026-11-10",
  fixedOn: "2026-11-10",
  fromPanelVersion: 1,
  qualifies: Object.freeze([
    "every-run-complete",
    "2xx-document",
    "no-capture-loss-in-a-metric-family",
    "observed-origin-and-site-are-the-candidate",
    "one-subject",
    "one-set-of-conditions",
    "spread-within-tolerance"
  ]),
  signalMetrics: Object.freeze(["knownTrackerRequests", "shieldsBlockedRequests"]),
  signalMedianFloor: 8,
  slots: Object.freeze([
    Object.freeze({ outgoing: GUARDIAN_DOMAIN, candidates: Object.freeze(["bumble.com"]), mustCarry: GUARDIAN_ONLY_ZEROING_METRICS }),
    Object.freeze({ outgoing: "gov.uk", candidates: Object.freeze(["ssa.gov", "who.int"]), mustCarry: Object.freeze([]) })
  ])
});

/**
 * What a qualifying capture records for a scan that left no saved report to
 * read. Each says what the command saw and no more: the staging job status
 * gives no cause for a failed job.
 */
export const JOB_FACTS = Object.freeze({
  failed: "the scan job failed and saved no report; the staging job status gives no cause",
  expired: "the scan job expired and saved no report",
  cancelled: "the scan job was cancelled and saved no report",
  timedOut: "the scan job did not end within the polling window",
  statusUnreadable: "the status of the scan job could not be read",
  reportUnreadable: "the scan job succeeded and its saved report could not be read"
});

/**
 * The digest a qualification receipt names its rule by, over every name and
 * number of QUALIFICATION_RULE, the conditions of `qualifies` among them. A
 * verdict is given only under the rule its capture ran under, so a rule
 * changed after the capture cannot judge it.
 */
export function qualificationRuleDigest() {
  return createHash("sha256").update(stableCompareJson(QUALIFICATION_RULE)).digest("hex");
}

/**
 * Where the one qualification receipt of a qualification panel is written and
 * then committed, beside the committed epoch receipts. The path is fixed by
 * the panel's id, so a second capture for the same panel finds the first
 * one's receipt in its place and is refused before it submits a scan.
 */
export function qualificationReceiptPath(qualificationPanel) {
  assertQualificationPanel(qualificationPanel);
  return `docs/${qualificationPanel.qualificationPanelId}/qualification-receipt.json`;
}

/**
 * A qualification panel is a kind of its own, with its own identity fields,
 * so neither validator accepts the other kind: one to five candidate cases,
 * each scanned on one build, under the conditions and with the tolerance
 * table of a comparison panel.
 */
export function assertQualificationPanel(value) {
  requireValue(
    record(value) && value.qualificationPanelVersion === QUALIFICATION_PANEL_VERSION && typeof value.qualificationPanelId === "string" &&
      SLUG.test(value.qualificationPanelId) && !Object.hasOwn(value, "panelVersion") && !Object.hasOwn(value, "panelId"),
    "Invalid toolchain canary qualification panel."
  );
  assertPanelMeasurement(value);
  requireValue(Array.isArray(value.cases) && value.cases.length >= 1 && value.cases.length <= 5, "A qualification panel must contain one to five candidate sites.");
  assertPanelCases(value.cases);
  requireValue(new Set(value.cases.map((entry) => entry.domain)).size === value.cases.length, "Qualification panel cases must name distinct domains.");
  requireValue(
    value.cases.length * value.repetitions <= QUALIFICATION_MAX_SCANS,
    `A qualification panel may submit at most ${QUALIFICATION_MAX_SCANS} scans (cases times repetitions); this one would submit ${value.cases.length * value.repetitions}.`
  );
  return value;
}

export function assertQualificationPanelCatalogMembership(panel, catalogs) {
  assertQualificationPanel(panel);
  assertCasesPinned(panel.cases, catalogs);
}

/**
 * Whether QUALIFICATION_RULE can decide this panel from this qualification
 * panel. The qualify command asks about the current panel before it submits a
 * scan, so a capture is never spent on a panel the rule would then refuse to
 * read, and the verdict asks about the committed panel its receipt names.
 */
export function assertQualificationApplies(qualificationPanel, fromPanel) {
  assertQualificationPanel(qualificationPanel);
  assertPanel(fromPanel);
  const rule = QUALIFICATION_RULE;
  requireValue(
    fromPanel.panelVersion === rule.fromPanelVersion,
    `Qualification rule ${rule.id} changes panel version ${rule.fromPanelVersion} only, and the current panel is version ${fromPanel.panelVersion}. A later panel change needs its own rule, fixed before its capture.`
  );
  for (const slot of rule.slots) {
    requireValue(
      fromPanel.cases.filter((entry) => entry.domain === slot.outgoing).length === 1,
      `The current panel has no single ${slot.outgoing} case for qualification rule ${rule.id} to decide.`
    );
  }
  // Both panel checks pin the one condition vector, so the tolerance table is
  // what the two files could disagree on.
  requireValue(
    same(qualificationPanel.metricTolerances, fromPanel.metricTolerances),
    "The qualification panel must carry the tolerance table of the current panel."
  );
  const candidates = rule.slots.flatMap((slot) => slot.candidates);
  for (const entry of qualificationPanel.cases) {
    requireValue(
      candidates.includes(entry.domain),
      `Qualification case ${entry.id} (${entry.domain}) is not on the closed candidate list of rule ${rule.id}: ${candidates.join(", ")}.`
    );
    requireValue(
      !fromPanel.cases.some((existing) => existing.id === entry.id || existing.domain === entry.domain),
      `Qualification case ${entry.id} is already a case of the current panel.`
    );
  }
}

/**
 * One saved report of a qualifying capture, as a run record. A report that
 * is not what the canary asked for is refused, as extractCapturedRun refuses
 * it. A report whose visit did not produce a complete observation is
 * returned with complete false, its recorded facts kept and the reasons
 * listed in notComplete, so its case can be judged not qualified without the
 * other cases being lost. A run returned as complete has passed every check
 * of assertCompleteRun, with no allowance for a missing Playwright version (a
 * qualifying capture runs on a build that records it): the checks that say
 * what the report is ran in assertRunIdentity, and the three that say the
 * visit was complete are runNotComplete being empty.
 */
export function extractQualificationRun(report, { reportId, expectedBuild, panelCase, sequence, repetition, reportWireSha256 }) {
  assertSavedSingle(report, reportId, reportWireSha256);
  assertRunIdentity(report.run, expectedBuild);
  requireValue(report.run.subject?.requested?.origin === new URL(panelCase.url).origin, `Saved report requested subject does not match ${panelCase.id}.`);
  const captured = capturedRunRecord(report, { reportId, panelCase, sequence, repetition, reportWireSha256 });
  const notComplete = runNotComplete(report.run);
  return notComplete.length > 0 ? { complete: false, run: { ...captured, stage: "report", notComplete } } : { complete: true, run: captured };
}

/**
 * One qualifying capture: every case of the panel in panel order, each
 * repetition in turn. scanOne submits one scan and resolves to
 * { reportId, report, reportWireSha256 } for a saved report, or to
 * { noReport: <a key of JOB_FACTS> } when the scan left no report to read.
 *
 * Nothing a scan does is lost. A scan with no report and a report that is
 * not a complete observation are recorded against their case and the capture
 * goes on, so one candidate that blocks the scanner does not cost the others
 * their evidence, and every repetition is still attempted, so the receipt
 * shows whether a case failed once or every time. Anything scanOne throws,
 * and a report that is not what the canary asked for, ends the capture: the
 * runs recorded so far are returned with the reason in endedEarly.
 *
 * onProgress is awaited with the runs recorded so far before each scan is
 * submitted, so the caller can keep the receipt on disk as the capture goes.
 * What onProgress throws is not caught: a capture that cannot keep its
 * receipt must stop.
 */
export async function captureQualification({ panel, expectedBuild, scanOne, log = () => {}, onProgress = async () => {} }) {
  assertQualificationPanel(panel);
  requireCommitSha(expectedBuild);
  const runs = [];
  const incompleteRuns = [];
  const total = panel.cases.length * panel.repetitions;
  let sequence = 0;
  for (const panelCase of panel.cases) {
    for (let repetition = 1; repetition <= panel.repetitions; repetition += 1) {
      sequence += 1;
      await onProgress({ runs, incompleteRuns });
      log(`[${sequence}/${total}] ${panelCase.id} repetition ${repetition}`);
      try {
        const scanned = await scanOne({ panelCase, sequence, repetition });
        requireValue(record(scanned), "A qualification scan returned nothing to record.");
        if (Object.hasOwn(scanned, "noReport")) {
          requireValue(Object.hasOwn(JOB_FACTS, scanned.noReport), "A qualification scan ended in a way the receipt has no word for.");
          incompleteRuns.push({ caseId: panelCase.id, repetition, sequence, stage: "job", notComplete: [JOB_FACTS[scanned.noReport]] });
          continue;
        }
        const extracted = extractQualificationRun(scanned.report, { reportId: scanned.reportId, expectedBuild, panelCase, sequence, repetition, reportWireSha256: scanned.reportWireSha256 });
        (extracted.complete ? runs : incompleteRuns).push(extracted.run);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "an error without a message";
        return { runs, incompleteRuns, endedEarly: `scan ${sequence} of ${total} (${panelCase.id} repetition ${repetition}) ended the capture: ${reason}` };
      }
    }
  }
  return { runs, incompleteRuns, endedEarly: null };
}

/**
 * A qualification receipt, finished or not. It names the rule it was
 * captured under and the panel that rule would change, so a verdict can be
 * given again later from the receipt and the committed panels alone.
 *
 * finished is true only when every scan of the panel was attempted and
 * recorded. endedEarly is the reason the command itself ended the capture
 * before that, and healthAfter is what the health read after the last scan
 * found: a failure there is recorded, not a reason to discard runs that each
 * record the build they ran on.
 */
export function buildQualificationReceipt({ createdAt, expectedBuild, panel, fromPanel, runs, incompleteRuns, finished, endedEarly = null, healthAfter = null }) {
  assertQualificationPanel(panel);
  assertPanel(fromPanel);
  requireCommitSha(expectedBuild);
  requireValue(Array.isArray(runs) && Array.isArray(incompleteRuns), "A qualification receipt lists its complete and its incomplete runs.");
  return {
    receiptVersion: RECEIPT_VERSION,
    kind: QUALIFICATION_RECEIPT_KIND,
    createdAt,
    origin: CANARY_ORIGIN,
    expectedBuild,
    rule: { id: QUALIFICATION_RULE.id, digest: qualificationRuleDigest() },
    fromPanelVersion: fromPanel.panelVersion,
    fromPanelDigest: panelDigest(fromPanel),
    panelDigest: panelDigest(panel),
    panel: structuredClone(panel),
    finished,
    endedEarly,
    healthAfter,
    runs,
    incompleteRuns
  };
}

// A qualification receipt is read from its recorded facts, never from what
// it says about itself: a run listed as complete must pass assertCompleteRun,
// and a run listed as not complete must give, from its own facts, exactly
// the reasons it states. The recorded scans must be the first scans of the
// panel in order, each once, and a finished receipt must hold them all, so a
// receipt with runs missing from the middle, or one that claims to be
// finished without them, is refused and never read as cases that did not
// qualify.
function assertQualificationReceipt(receipt, expectedPanel) {
  assertQualificationPanel(expectedPanel);
  requireValue(
    !(record(receipt) && receipt.kind === CAPTURE_RECEIPT_KIND),
    "A capture receipt is one arm of a comparison, not a qualification receipt. The compare and replay commands read it."
  );
  requireValue(record(receipt) && receipt.receiptVersion === RECEIPT_VERSION && receipt.kind === QUALIFICATION_RECEIPT_KIND, "Invalid canary qualification receipt.");
  requireValue(typeof receipt.createdAt === "string" && TIMESTAMP.test(receipt.createdAt), "Receipt has no creation time.");
  requireValue(receipt.origin === CANARY_ORIGIN && SHA40.test(receipt.expectedBuild) && SHA256.test(receipt.panelDigest), "Receipt origin/build/panel identity is invalid.");
  requireValue(receipt.panelDigest === panelDigest(expectedPanel) && record(receipt.panel) && same(receipt.panel, expectedPanel), "Receipt does not use the committed qualification panel.");
  requireValue(record(receipt.rule) && typeof receipt.rule.id === "string" && SHA256.test(receipt.rule.digest), "The receipt does not record the qualification rule it was captured under.");
  requireValue(
    receipt.rule.id === QUALIFICATION_RULE.id && receipt.rule.digest === qualificationRuleDigest(),
    `The receipt was captured under qualification rule ${receipt.rule.id} (sha256 ${receipt.rule.digest}), and the rule in this code is ${QUALIFICATION_RULE.id} (sha256 ${qualificationRuleDigest()}). A verdict is given only under the rule the capture ran under: read the receipt from a checkout that holds that rule.`
  );
  requireValue(Number.isSafeInteger(receipt.fromPanelVersion) && SHA256.test(receipt.fromPanelDigest), "The receipt does not record the panel it would change.");
  const health = receipt.healthAfter;
  requireValue(
    typeof receipt.finished === "boolean" && (receipt.endedEarly === null || (typeof receipt.endedEarly === "string" && receipt.endedEarly.length > 0)) &&
      (health === null || (record(health) && (same(health, { ok: true }) || (health.ok === false && typeof health.reason === "string" && health.reason.length > 0 && Object.keys(health).length === 2)))) &&
      (receipt.finished ? receipt.endedEarly === null && health !== null : health === null),
    "The receipt does not say consistently whether its capture finished."
  );
  requireValue(Array.isArray(receipt.runs) && Array.isArray(receipt.incompleteRuns), "Qualification receipt must list its complete and its incomplete runs.");
  const recorded = new Map();
  for (const run of [...receipt.runs, ...receipt.incompleteRuns]) {
    // The repetition and the sequence are numbers: a string or a list that
    // prints as one would otherwise find its place in the panel.
    requireValue(
      record(run) && typeof run.caseId === "string" && Number.isSafeInteger(run.repetition) && Number.isSafeInteger(run.sequence) && !recorded.has(run.sequence),
      "Qualification receipt run order or coverage is invalid."
    );
    recorded.set(run.sequence, run);
  }
  for (const list of [receipt.runs, receipt.incompleteRuns]) {
    requireValue(list.every((run, index) => index === 0 || list[index - 1].sequence < run.sequence), "Qualification receipt run order or coverage is invalid.");
  }
  let sequence = 0;
  for (const panelCase of expectedPanel.cases) {
    for (let repetition = 1; repetition <= expectedPanel.repetitions; repetition += 1) {
      sequence += 1;
      const run = recorded.get(sequence);
      // Scans are recorded in order, so the recorded ones are the first ones.
      requireValue(run ? run.caseId === panelCase.id && run.repetition === repetition : recorded.size < sequence, "Qualification receipt has incomplete panel coverage.");
    }
  }
  requireValue(recorded.size <= sequence && (!receipt.finished || recorded.size === sequence), "Qualification receipt has incomplete panel coverage.");
  const seen = { reportIds: new Set(), runIds: new Set(), wireDigests: new Set() };
  const saved = [];
  for (const run of receipt.runs) {
    requireValue(!Object.hasOwn(run, "stage") && !Object.hasOwn(run, "notComplete"), "A run listed as complete states a reason against itself.");
    assertOwnScan(run, seen);
    assertCompleteRun({ ...run, summary: { counts: run.counts } }, receipt.expectedBuild);
    saved.push(run);
  }
  for (const run of receipt.incompleteRuns) {
    if (run.stage === "job") {
      requireValue(
        Array.isArray(run.notComplete) && run.notComplete.length === 1 && Object.values(JOB_FACTS).includes(run.notComplete[0]) &&
          same(run, { caseId: run.caseId, repetition: run.repetition, sequence: run.sequence, stage: "job", notComplete: run.notComplete }),
        "Qualification receipt has a malformed record of a scan that left no report."
      );
      continue;
    }
    requireValue(run.stage === "report", "Qualification receipt has an incomplete run of an unknown stage.");
    assertOwnScan(run, seen);
    const asRun = { ...run, summary: { counts: run.counts } };
    assertRunIdentity(asRun, receipt.expectedBuild);
    const derived = runNotComplete(asRun);
    requireValue(derived.length > 0 && Array.isArray(run.notComplete) && same(run.notComplete, derived), "Qualification receipt states a reason its recorded facts do not give.");
    saved.push(run);
  }
  for (const run of saved) {
    const panelCase = expectedPanel.cases.find((entry) => entry.id === run.caseId);
    requireValue(run.subject?.requested?.origin === new URL(panelCase.url).origin, `Receipt run ${run.caseId}:${run.repetition} did not request its panel case.`);
  }
  return receipt;
}

// The conditions QUALIFICATION_RULE.qualifies names, each as the reasons it
// gives against a case: none when the case meets it. They read the complete
// and the incomplete runs of the case, its panel entry, and the statistics of
// its arm, which exist only when every run completed.
const stringOr = (value, otherwise) => (typeof value === "string" && value.length > 0 ? value : otherwise);
// The host of a recorded origin, or null when what is recorded is no origin.
function originHost(origin) {
  try {
    return typeof origin === "string" ? new URL(origin).hostname : null;
  } catch {
    return null;
  }
}
const hostIsOrIsUnder = (host, domain) => host === domain || (typeof host === "string" && host.endsWith(`.${domain}`));

const QUALIFYING_CONDITIONS = Object.freeze({
  "every-run-complete": ({ incomplete }) => incomplete.map((run) => `repetition ${run.repetition} did not complete: ${run.notComplete.join("; ")}`),
  // A complete run has a document status from 200 to 399, which the receipt
  // check holds it to (assertCompleteRun). The rule asks for a 2xx one.
  "2xx-document": ({ complete }) =>
    complete
      .filter((run) => run.qualityFacts.status > 299)
      .map((run) => `repetition ${run.repetition} returned document status ${run.qualityFacts.status}, not a 2xx document`),
  "no-capture-loss-in-a-metric-family": ({ complete }) =>
    complete
      .map((run) => ({ run, losses: captureLossSignatures(run, feedsMetric) }))
      .filter(({ losses }) => losses.length > 0)
      .map(({ run, losses }) => `repetition ${run.repetition} records capture loss in a family a canary metric is counted from: ${losses.join(", ")}`),
  // The site a run ended on is the candidate's own when both things the
  // scanner recorded for the observed subject say so: the registrable domain
  // equals the candidate's catalog domain, and the host of the origin is that
  // domain or one under it. The production synthetic holds its fixed targets
  // to the origin and to the registrable domain as well (scripts/smoke-
  // production-synthetic.mjs). The registrable domain is not worked out here,
  // and the origin is held to it only by its ending, so the one cannot stand
  // in for the other.
  "observed-origin-and-site-are-the-candidate": ({ complete, panelCase }) =>
    complete
      .filter((run) => !(run.subject?.observed?.registrableDomain === panelCase.domain && hostIsOrIsUnder(originHost(run.subject?.observed?.origin), panelCase.domain)))
      .map((run) => `repetition ${run.repetition} ended on ${stringOr(run.subject?.observed?.origin, "no recorded origin")} (recorded site: ${stringOr(run.subject?.observed?.registrableDomain, "none")}), not on the candidate's own site ${panelCase.domain}`),
  "one-subject": ({ complete }) => (complete.every((run) => same(run.subject, complete[0].subject)) ? [] : ["its runs landed on different subjects"]),
  // A region, browser or toolchain change during the capture costs the case
  // it falls in, not the receipt: the comparison would refuse a build whose
  // runs were not all under one set of conditions.
  "one-set-of-conditions": ({ complete }) => {
    const mixed = ["conditions", "provenance", "toolchain"].filter((part) => !complete.every((run) => same(run[part], complete[0][part])));
    return mixed.length > 0 ? [`its runs were not all captured under one set of conditions and toolchain provenance (they differ in ${mixed.join(" and ")})`] : [];
  },
  "spread-within-tolerance": ({ metrics }) =>
    (metrics ?? [])
      .filter((row) => !row.within)
      .map((row) => `${row.metric} spread ${row.spread} is over the tolerance ${row.tolerance} at its median ${row.median} (runs ${row.values.join(", ")})`)
});

function judgeQualificationCase(receipt, panel, panelCase) {
  const rule = QUALIFICATION_RULE;
  const complete = receipt.runs.filter((run) => run.caseId === panelCase.id);
  const incomplete = receipt.incompleteRuns.filter((run) => run.caseId === panelCase.id);
  const recordedRuns = complete.length + incomplete.length;
  const about = { caseId: panelCase.id, domain: panelCase.domain, url: panelCase.url, repetitions: panel.repetitions, recordedRuns, completeRuns: complete.length };
  // A case is judged only on all of its runs. One whose capture ended before
  // its last run is not judged, which the slots treat as not qualified.
  if (recordedRuns < panel.repetitions) return { ...about, judged: false, metrics: null, signal: null, refusals: [], qualifies: false, signalCase: false };
  // The statistics are those of the whole arm, so they exist only when every
  // repetition completed. The runs are in repetition order, which
  // assertQualificationReceipt has checked.
  let metrics = null;
  let signal = null;
  if (incomplete.length === 0) {
    metrics = METRICS.map((metric) => {
      const values = complete.map((run) => run.counts[metric]);
      const middle = median(values);
      const tolerance = toleranceAt(panel.metricTolerances[metric], middle);
      const range = spread(values);
      return { metric, values, median: middle, spread: range, tolerance, within: range <= tolerance, zeroingFails: middle > tolerance };
    });
    signal = rule.signalMetrics.map((metric) => {
      const row = metrics.find((entry) => entry.metric === metric);
      return { metric, median: row.median, floor: rule.signalMedianFloor, met: row.median >= rule.signalMedianFloor };
    });
  }
  // Exactly the conditions the rule names, in the order it names them.
  const refusals = rule.qualifies.flatMap((name) => QUALIFYING_CONDITIONS[name]({ complete, incomplete, metrics, panelCase }));
  const qualifies = refusals.length === 0;
  return { ...about, judged: true, metrics, signal, refusals, qualifies, signalCase: qualifies && signal.every((row) => row.met) };
}

function decideSlot(slot, cases) {
  const considered = [];
  let taker = null;
  for (const domain of slot.candidates) {
    const judged = cases.find((entry) => entry.domain === domain);
    if (taker) {
      considered.push({ domain, takes: false, reasons: [`was not needed: ${taker.domain} had taken the slot`] });
      continue;
    }
    if (!judged) {
      considered.push({ domain, takes: false, reasons: ["was not in the qualifying capture"] });
      continue;
    }
    if (!judged.judged) {
      considered.push({ domain, takes: false, reasons: [`was not judged (${judged.recordedRuns} of ${judged.repetitions} runs recorded), which counts as not qualified`] });
      continue;
    }
    const reasons = [];
    if (!judged.qualifies) reasons.push(`does not qualify (${judged.refusals.join("; ")})`);
    if (judged.metrics === null) {
      reasons.push("its signal and zeroing conditions were not evaluated, because not every run completed");
    } else {
      for (const row of judged.signal) {
        if (!row.met) reasons.push(`is not a signal case: its median ${row.metric} is ${row.median}, under ${row.floor}`);
      }
      for (const metric of slot.mustCarry) {
        const row = judged.metrics.find((entry) => entry.metric === metric);
        if (!row.zeroingFails) reasons.push(`would not fail a zeroed ${metric}: its median ${row.median} is not above the tolerance ${row.tolerance} at that median`);
      }
    }
    if (reasons.length === 0) taker = judged;
    considered.push({ domain, takes: reasons.length === 0, reasons });
  }
  return { outgoing: slot.outgoing, taker, considered };
}

/**
 * A comparison panel as the bytes of its committed file, in the layout of
 * scripts/fixtures/toolchain-canary-panel.json: one line per tolerance and
 * per case, so a panel change reads as the lines that changed. It refuses a
 * panel it could not write back whole (a key this layout does not carry).
 */
export function formatPanel(panel) {
  assertPanel(panel);
  const inline = (value) => `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${JSON.stringify(entry)}`).join(", ")} }`;
  const block = (entries) => entries.map((line, index) => `    ${line}${index === entries.length - 1 ? "" : ","}`);
  const text = [
    "{",
    `  "panelVersion": ${JSON.stringify(panel.panelVersion)},`,
    `  "panelId": ${JSON.stringify(panel.panelId)},`,
    `  "repetitions": ${JSON.stringify(panel.repetitions)},`,
    '  "conditions": {',
    ...block(Object.entries(panel.conditions).map(([key, entry]) => `${JSON.stringify(key)}: ${JSON.stringify(entry)}`)),
    "  },",
    '  "metricTolerances": {',
    ...block(METRICS.map((metric) => `${JSON.stringify(metric)}: ${inline(panel.metricTolerances[metric])}`)),
    "  },",
    '  "cases": [',
    ...block(panel.cases.map(inline)),
    "  ]",
    "}",
    ""
  ].join("\n");
  requireValue(same(JSON.parse(text), panel), "The panel carries a key the committed panel layout does not write.");
  return text;
}

/**
 * The verdict of QUALIFICATION_RULE on one qualification receipt: each case
 * judged alone, each slot decided, and the next panel, or null when no slot
 * changes. Pure: it reads the receipt, the committed qualification panel the
 * receipt must carry, and the committed panels, from which it takes the panel
 * the receipt names as the one it would change. It does not read the current
 * panel, so the verdict on a committed receipt is the same before and after
 * the panel it gives becomes current.
 */
export function judgeQualification(receiptInput, { qualificationPanel, committedPanels }) {
  const receipt = assertQualificationReceipt(receiptInput, qualificationPanel);
  const from = committedPanels.find((entry) => entry.panel.panelVersion === receipt.fromPanelVersion && entry.digest === receipt.fromPanelDigest);
  requireValue(from, `The receipt would change panel version ${receipt.fromPanelVersion} (sha256 ${receipt.fromPanelDigest}), and no committed panel is that panel.`);
  const fromPanel = from.panel;
  assertQualificationApplies(qualificationPanel, fromPanel);
  const rule = QUALIFICATION_RULE;
  const cases = qualificationPanel.cases.map((panelCase) => judgeQualificationCase(receipt, qualificationPanel, panelCase));
  const slots = rule.slots.map((slot) => decideSlot(slot, cases));
  const incoming = new Map(slots.filter((slot) => slot.taker).map((slot) => [slot.outgoing, slot.taker]));
  let panel = null;
  if (incoming.size > 0) {
    const version = fromPanel.panelVersion + 1;
    const stem = `-v${fromPanel.panelVersion}`;
    requireValue(fromPanel.panelId.endsWith(stem), "The panelId of the panel to change does not end in its version, so the next panel cannot be named after it.");
    panel = {
      panelVersion: version,
      panelId: `${fromPanel.panelId.slice(0, -stem.length)}-v${version}`,
      repetitions: fromPanel.repetitions,
      conditions: structuredClone(fromPanel.conditions),
      metricTolerances: structuredClone(fromPanel.metricTolerances),
      cases: fromPanel.cases.map((entry) => {
        const taker = incoming.get(entry.domain);
        return structuredClone(taker ? qualificationPanel.cases.find((candidate) => candidate.id === taker.caseId) : entry);
      })
    };
  }
  // The metrics the Guardian alone carries in panel version 1, and the cases
  // of the resulting panel a zeroed count would fail on. The Guardian, when
  // it stays, is listed as retained: this capture did not measure it.
  const guardian = fromPanel.cases.find((entry) => entry.domain === GUARDIAN_DOMAIN);
  const takers = slots.filter((slot) => slot.taker).map((slot) => slot.taker);
  const coverage = GUARDIAN_ONLY_ZEROING_METRICS.map((metric) => ({
    metric,
    through: [
      ...(incoming.has(guardian.domain) ? [] : [{ caseId: guardian.id, retained: true }]),
      ...takers
        .map((taker) => ({ caseId: taker.caseId, row: taker.metrics.find((entry) => entry.metric === metric) }))
        .filter((entry) => entry.row.zeroingFails)
        .map((entry) => ({ caseId: entry.caseId, retained: false, median: entry.row.median, tolerance: entry.row.tolerance }))
    ]
  }));
  // Every taker is a signal case by the rule. The Guardian, when it stays, is
  // the signal site it was.
  const signalSites = [...(incoming.has(guardian.domain) ? [] : [guardian.domain]), ...takers.map((taker) => taker.domain)];
  return {
    rule: rule.id,
    ruleDigest: receipt.rule.digest,
    ruleFixedOn: rule.fixedOn,
    build: receipt.expectedBuild,
    createdAt: receipt.createdAt,
    qualificationPanelId: qualificationPanel.qualificationPanelId,
    qualificationPanelDigest: receipt.panelDigest,
    scans: receipt.runs.length + receipt.incompleteRuns.length,
    panelScans: qualificationPanel.cases.length * qualificationPanel.repetitions,
    finished: receipt.finished,
    endedEarly: receipt.endedEarly,
    healthAfter: receipt.healthAfter,
    fromPanelId: fromPanel.panelId,
    fromPanelVersion: fromPanel.panelVersion,
    fromPanelDigest: from.digest,
    cases,
    notJudged: cases.filter((entry) => !entry.judged).map((entry) => entry.caseId),
    slots: slots.map((slot) => ({ outgoing: slot.outgoing, taker: slot.taker ? slot.taker.domain : null, considered: slot.considered })),
    coverage,
    signalSites,
    panel,
    panelDigest: panel ? panelDigest(panel) : null,
    panelText: panel ? formatPanel(panel) : null
  };
}

/**
 * The verdict as the lines the verdict command prints: the rule, how the
 * capture ended, each case with its runs, medians, spreads and tolerances and
 * every reason against it, each slot, what the resulting panel carries, and
 * the exact bytes of the next panel or the statement that the panel does not
 * change.
 */
export function formatQualificationVerdict(verdict) {
  const lines = [
    `RULE ${verdict.rule} (sha256 ${verdict.ruleDigest}): fixed on ${verdict.ruleFixedOn}, before any qualifying capture`,
    `RECEIPT build ${verdict.build}, qualification panel ${verdict.qualificationPanelId} (sha256 ${verdict.qualificationPanelDigest}), ${verdict.scans} of ${verdict.panelScans} scans recorded, created ${verdict.createdAt}; it would change ${verdict.fromPanelId} (version ${verdict.fromPanelVersion}, sha256 ${verdict.fromPanelDigest})`
  ];
  if (verdict.finished) {
    lines.push(
      verdict.healthAfter.ok
        ? "CAPTURE finished; staging health after the last scan passed"
        : `CAPTURE finished; staging health after the last scan did not pass and is recorded, not held against the runs, which each record their build: ${verdict.healthAfter.reason}`
    );
  } else {
    lines.push(`CAPTURE NOT FINISHED: ${verdict.endedEarly ?? "the receipt records no end, so the command stopped before it could write one"}`);
  }
  for (const entry of verdict.cases) {
    if (!entry.judged) {
      lines.push(`CASE ${entry.caseId} (${entry.domain}): NOT JUDGED; ${entry.recordedRuns} of ${entry.repetitions} runs recorded`);
      lines.push(`  NOT JUDGED ${entry.caseId}: a case is judged on all of its runs, and the capture ended before they were recorded; it is treated as not qualified, so it takes no slot`);
      continue;
    }
    lines.push(`CASE ${entry.caseId} (${entry.domain}): ${entry.qualifies ? `QUALIFIES, ${entry.signalCase ? "SIGNAL case" : "not a signal case"}` : "NOT QUALIFIED"}; ${entry.completeRuns} of ${entry.repetitions} runs complete`);
    for (const refusal of entry.refusals) lines.push(`  REFUSED ${entry.caseId}: ${refusal}`);
    if (entry.metrics === null) {
      lines.push(`  NO STATISTICS ${entry.caseId}: medians, spreads and tolerances are those of a whole arm, and not every run completed`);
      continue;
    }
    for (const row of entry.metrics) {
      lines.push(`  METRIC ${entry.caseId}.${row.metric}: runs ${row.values.join(", ")}; median ${row.median}; spread ${row.spread}; tolerance ${row.tolerance}; ${row.within ? "within" : "over"}`);
    }
    lines.push(`  SIGNAL ${entry.caseId}: ${entry.signal.map((row) => `median ${row.metric} ${row.median} is ${row.met ? "at least" : "under"} ${row.floor}`).join("; ")}`);
    const zeroing = entry.metrics.filter((row) => row.zeroingFails).map((row) => row.metric);
    lines.push(`  ZEROING ${entry.caseId}: at these medians a zeroed count would fail on ${zeroing.length > 0 ? zeroing.join(", ") : "no metric"}`);
  }
  for (const slot of verdict.slots) {
    for (const candidate of slot.considered) {
      lines.push(candidate.takes ? `SLOT ${slot.outgoing}: ${candidate.domain} takes it` : `SLOT ${slot.outgoing}: ${candidate.domain} ${candidate.reasons.join("; ")}`);
    }
    if (slot.taker === null) lines.push(`SLOT ${slot.outgoing}: stays`);
  }
  for (const entry of verdict.coverage) {
    const through = entry.through.map((carrier) => (carrier.retained ? `${carrier.caseId} (stays; not measured by this capture)` : `${carrier.caseId} (median ${carrier.median}, tolerance ${carrier.tolerance})`));
    lines.push(`CARRIES ${entry.metric}: ${through.length > 0 ? through.join(", ") : "no case of the resulting panel"}`);
  }
  lines.push(
    verdict.signalSites.length === 1
      ? `SIGNAL SITES one: the tracker and Shields signal of the resulting panel rests on ${verdict.signalSites[0]} alone`
      : `SIGNAL SITES ${verdict.signalSites.length}: the tracker and Shields signal of the resulting panel rests on ${verdict.signalSites.join(" and ")}`
  );
  if (verdict.panel === null) {
    lines.push(
      `PANEL UNCHANGED: no candidate took a slot, so ${verdict.fromPanelId} stays the current panel${verdict.notJudged.length > 0 ? `; ${verdict.notJudged.join(", ")} ${verdict.notJudged.length === 1 ? "was" : "were"} not judged, which is not the same as judged and refused` : ""}`
    );
    return lines;
  }
  lines.push(
    `PANEL version ${verdict.panel.panelVersion}, ${verdict.panel.panelId} (sha256 ${verdict.panelDigest}): the next panel follows. Commit it as ${COMMITTED_PANEL_DIRECTORY}/${verdict.panel.panelId}.json and as the current panel file before any comparison capture; --panel-out writes these bytes to a file`
  );
  lines.push(...verdict.panelText.trimEnd().split("\n"));
  return lines;
}

/**
 * A committed panel past the version the rule changes exists only as the
 * verdict on the committed qualification receipt, byte for byte. This is the
 * check the tests hold the repository to. Without it a hand-made panel, with
 * a tolerance loosened or a case swapped, could be committed and made
 * current, and the compare command would judge releases on it.
 *
 * files are the entries of COMMITTED_PANEL_DIRECTORY as { name, text } pairs,
 * and receipt is the parsed qualification receipt at its fixed path, or null
 * when there is none. The result says which of the four states the
 * repository is in.
 */
export function assertCommittedPanelLineage({ files, receipt, qualificationPanel }) {
  const committedPanels = readCommittedPanels(files);
  const later = committedPanels.filter((entry) => entry.panel.panelVersion > QUALIFICATION_RULE.fromPanelVersion);
  if (receipt === null) {
    requireValue(
      later.length === 0,
      `${later[0]?.file} is a panel past version ${QUALIFICATION_RULE.fromPanelVersion}, and no qualification receipt is committed at ${qualificationReceiptPath(qualificationPanel)}. Such a panel comes only from the verdict on that receipt.`
    );
    return { state: "no-capture", verdict: null };
  }
  const verdict = judgeQualification(receipt, { qualificationPanel, committedPanels });
  if (later.length === 0) return { state: verdict.panel === null ? "unchanged" : "verdict-not-committed", verdict };
  const [next] = later;
  requireValue(
    later.length === 1 && verdict.panel !== null && next.panel.panelVersion === verdict.panel.panelVersion && next.file === `${COMMITTED_PANEL_DIRECTORY}/${verdict.panel.panelId}.json`,
    verdict.panel === null
      ? `${next.file} is committed, and the verdict on the committed qualification receipt leaves the panel unchanged.`
      : `${later.map((entry) => entry.file).join(" and ")} must be the one panel the verdict on the committed qualification receipt gives, ${verdict.panel.panelId}.`
  );
  requireValue(
    files.find((file) => `${COMMITTED_PANEL_DIRECTORY}/${file.name}` === next.file).text === verdict.panelText,
    `${next.file} is not, byte for byte, the panel the verdict on the committed qualification receipt gives. Write it with the verdict command's --panel-out and do not edit it.`
  );
  return { state: "committed", verdict };
}
