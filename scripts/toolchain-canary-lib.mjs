export const CANARY_ORIGIN = "https://scan-staging.sitebehavior.org";
export const CANARY_CONFIRMATION = "I_ACKNOWLEDGE_THIS_SUBMITS_LIVE_STAGING_SCANS";
export const RECEIPT_VERSION = 2;
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

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;
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
 * Key-sorted JSON for COMPARING two in-memory canary panels. Deliberately not
 * the published canonicalizer in lib/canonical-json.ts: nothing here is
 * digested or stored, so it carries no NFC or non-finite rules. It is named
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

export function assertPanel(value) {
  requireValue(record(value) && value.panelVersion === 1 && typeof value.panelId === "string", "Invalid toolchain canary panel.");
  requireValue(Number.isSafeInteger(value.repetitions) && value.repetitions >= 3 && value.repetitions <= 9 && value.repetitions % 2 === 1, "Panel repetitions must be an odd integer from 3 through 9.");
  requireValue(same(value.conditions, { device: "desktop", gpcEnabled: true, consentMode: "observe" }), "Panel conditions must pin the ordinary desktop single-scan profile.");
  requireValue(record(value.metricTolerances) && same(Object.keys(value.metricTolerances).sort(), [...METRICS].sort()), "Panel must define exactly the canary metric tolerances.");
  for (const metric of METRICS) {
    const tolerance = value.metricTolerances[metric];
    requireValue(record(tolerance) && Number.isFinite(tolerance.absolute) && tolerance.absolute >= 0 && Number.isFinite(tolerance.relative) && tolerance.relative >= 0 && tolerance.relative <= 1, `Invalid tolerance for ${metric}.`);
  }
  requireValue(Array.isArray(value.cases) && value.cases.length === 5, "The toolchain canary panel must contain exactly five sites.");
  const ids = new Set();
  for (const entry of value.cases) {
    requireValue(record(entry) && /^[a-z0-9-]+$/.test(entry.id) && !ids.has(entry.id), "Panel case ids must be unique slugs.");
    ids.add(entry.id);
    requireValue(CATALOGS.has(entry.catalog), `Panel case ${entry.id} uses an unapproved catalog.`);
    const url = new URL(entry.url);
    requireValue(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, `Panel case ${entry.id} must use a public HTTPS URL without private components.`);
    requireValue(typeof entry.domain === "string" && entry.domain.length > 0, `Panel case ${entry.id} is missing its catalog domain.`);
  }
  return value;
}

export function assertPanelCatalogMembership(panel, catalogs) {
  assertPanel(panel);
  for (const entry of panel.cases) {
    const catalog = catalogs[entry.catalog];
    requireValue(record(catalog) && Array.isArray(catalog.sites), `Could not read ${entry.catalog}.`);
    requireValue(catalog.sites.some((site) => site?.domain === entry.domain && site?.url === entry.url), `Panel case ${entry.id} is not pinned exactly in ${entry.catalog}.`);
  }
}

function assertCompleteRun(run, expectedBuild, { allowUnrecordedPlaywright = false } = {}) {
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
  requireValue(run.qualityFacts?.status >= 200 && run.qualityFacts.status <= 399 && run.qualityFacts.botWallTitleMatched === false && run.qualityFacts.navigationSettled === true && Array.isArray(run.qualityFacts.budgetsExhausted) && run.qualityFacts.budgetsExhausted.length === 0, "Saved report has failed, bot-wall, timeout, or budget quality facts.");
  // Capture loss is admitted here and judged across builds in compareReceipts:
  // a site keeps a loss only if every run of it in both receipts records the
  // same one, and the metrics its family feeds are then left out.
  requireValue(
    Array.isArray(run.qualityFacts.captureLoss) &&
      run.qualityFacts.captureLoss.every((loss) =>
        record(loss) && typeof loss.family === "string" && loss.family.length > 0 &&
        typeof loss.kind === "string" && loss.kind.length > 0 &&
        (loss.detail === undefined || (typeof loss.detail === "string" && loss.detail.length > 0)) &&
        Number.isSafeInteger(loss.count) && loss.count > 0
      ),
    "Saved report has malformed capture-loss quality facts."
  );
  requireValue(run.quality?.run?.outcome === "complete" && Array.isArray(run.quality.run.reasons) && run.quality.run.reasons.length === 0, "Saved report is not run-level complete.");
  // The evaluator censors a family exactly when it records capture loss, with
  // one capture-loss:<kind> reason per kind. Anything else, or a loss in a
  // family the quality block does not carry, still refuses the run.
  const lossKinds = new Map();
  for (const loss of run.qualityFacts.captureLoss) lossKinds.set(loss.family, [...new Set([...(lossKinds.get(loss.family) ?? []), loss.kind])]);
  requireValue(
    record(run.quality.byFamily) &&
      [...lossKinds.keys()].every((family) => Object.hasOwn(run.quality.byFamily, family)) &&
      Object.entries(run.quality.byFamily).every(([name, family]) => {
        if (!record(family) || !Array.isArray(family.reasons)) return false;
        const kinds = lossKinds.get(name);
        if (!kinds) return family.outcome === "complete" && family.reasons.length === 0;
        return family.outcome === "censored" && same([...family.reasons].sort(), kinds.map((kind) => `capture-loss:${kind}`).sort());
      }),
    "Saved report has evidence families censored by something other than its recorded capture loss."
  );
  requireValue(record(run.summary?.counts) && METRICS.every((metric) => Number.isSafeInteger(run.summary.counts[metric]) && run.summary.counts[metric] >= 0), "Saved report is missing a canary count metric.");
}

export function extractCapturedRun(report, { reportId, expectedBuild, order, panelCase, sequence, repetition, reportWireSha256 }) {
  requireValue(record(report) && report.schemaVersion === 2 && report.schemaRevision === 2 && report.reportType === "single" && !Object.hasOwn(report, "ephemeral"), "Saved report must be a public v2/r2 single.");
  requireValue(REPORT_ID.test(reportId) && report.share?.id === reportId && report.share?.path === `/reports/${reportId}` && report.share?.jsonPath === `/api/reports/${reportId}`, "Saved report does not match the admission-minted report id.");
  requireValue(SHA256.test(reportWireSha256), "Saved report wire digest is invalid.");
  requireValue(order === "forward" || order === "reverse", "Capture order is invalid.");
  assertCompleteRun(report.run, expectedBuild, { allowUnrecordedPlaywright: order === "forward" });
  requireValue(report.run.subject?.requested?.origin === new URL(panelCase.url).origin, `Saved report requested subject does not match ${panelCase.id}.`);
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

export function buildReceipt({ createdAt, expectedBuild, order, panel, panelDigest, runs }) {
  assertPanel(panel);
  requireCommitSha(expectedBuild);
  requireValue(order === "forward" || order === "reverse", "Capture order must be forward or reverse.");
  requireValue(SHA256.test(panelDigest), "Panel digest is invalid.");
  return {
    receiptVersion: RECEIPT_VERSION,
    kind: "site-behavior-toolchain-canary-capture",
    createdAt,
    origin: CANARY_ORIGIN,
    expectedBuild,
    order,
    panelDigest,
    panel: structuredClone(panel),
    runs
  };
}

function assertReceipt(receipt, expectedPanel, panelDigest, { allowUnrecordedPlaywright = false } = {}) {
  requireValue(record(receipt) && receipt.receiptVersion === RECEIPT_VERSION && receipt.kind === "site-behavior-toolchain-canary-capture", "Invalid canary receipt.");
  requireValue(receipt.origin === CANARY_ORIGIN && SHA40.test(receipt.expectedBuild) && SHA256.test(receipt.panelDigest), "Receipt origin/build/panel identity is invalid.");
  requireValue(receipt.panelDigest === panelDigest && same(receipt.panel, expectedPanel), "Receipt does not use the committed fixed panel.");
  requireValue(receipt.order === "forward" || receipt.order === "reverse", "Receipt order is invalid.");
  const expectedCases = receipt.order === "forward" ? expectedPanel.cases : [...expectedPanel.cases].reverse();
  const expectedCoverage = [];
  for (const panelCase of expectedCases) for (let repetition = 1; repetition <= expectedPanel.repetitions; repetition += 1) expectedCoverage.push(`${panelCase.id}:${repetition}`);
  requireValue(Array.isArray(receipt.runs) && receipt.runs.length === expectedCoverage.length, "Receipt has incomplete panel coverage.");
  const reportIds = new Set();
  for (const [index, run] of receipt.runs.entries()) {
    requireValue(record(run) && `${run.caseId}:${run.repetition}` === expectedCoverage[index] && run.sequence === index + 1, "Receipt run order or coverage is invalid.");
    requireValue(REPORT_ID.test(run.reportId) && !reportIds.has(run.reportId) && run.reportJsonPath === `/api/reports/${run.reportId}` && SHA256.test(run.reportWireSha256), "Receipt report identity is invalid.");
    reportIds.add(run.reportId);
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

/**
 * A run's capture losses as sorted family/kind/detail signatures; loss counts
 * vary run to run and are not compared. A loss recorded without a detail is
 * identified by family and kind alone, so two undetailed causes of the same
 * family and kind read as one; either way only metrics already left out for
 * that site are affected.
 */
function captureLossSignatures(run) {
  return [...new Set(run.qualityFacts.captureLoss.map((loss) => `${loss.family}/${loss.kind}/${loss.detail ?? ""}`))].sort();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
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
  // Capture loss is compared like with like: every run of a site in both
  // receipts must record the same family/kind/detail loss signatures, or the
  // loss is itself a difference between the builds. A shared loss leaves out
  // only the metrics its family feeds, for that site.
  const lossyFamiliesBySite = new Map();
  for (const panelCase of expectedPanel.cases) {
    const signatures = [...baseline.runs, ...candidate.runs]
      .filter((run) => run.caseId === panelCase.id)
      .map((run) => JSON.stringify(captureLossSignatures(run)));
    requireValue(
      signatures.every((signature) => signature === signatures[0]),
      `Capture loss differs between runs of ${panelCase.id}: ${[...new Set(signatures)].join(" vs ")}.`
    );
    lossyFamiliesBySite.set(panelCase.id, new Set(JSON.parse(signatures[0]).map((signature) => signature.split("/")[0])));
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
      const left = median(baseline.runs.filter((run) => run.caseId === panelCase.id).map((run) => run.counts[metric]));
      const right = median(candidate.runs.filter((run) => run.caseId === panelCase.id).map((run) => run.counts[metric]));
      const tolerance = expectedPanel.metricTolerances[metric];
      const allowed = Math.max(tolerance.absolute, Math.abs(left) * tolerance.relative);
      const delta = Math.abs(right - left);
      results.push({ caseId: panelCase.id, metric, baseline: left, candidate: right, delta, allowed, pass: delta <= allowed });
    }
  }
  return { pass: results.every((result) => result.pass), baselineBuild: baseline.expectedBuild, candidateBuild: candidate.expectedBuild, results, excluded };
}
