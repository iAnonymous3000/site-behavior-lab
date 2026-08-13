#!/usr/bin/env node

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { parse as parseDomain } from "tldts";
import {
  readResponseBytesWithinLimit,
  readResponseJsonWithinLimit,
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";
import { resolveExactStaticDeploymentCommit } from "./static-deployment-provenance.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "out");
const basePath = normalizeBasePath(
  process.env.SITE_BEHAVIOR_LAB_PAGES_BASE_PATH === undefined
    ? inferredGithubPagesBasePath()
    : process.env.SITE_BEHAVIOR_LAB_PAGES_BASE_PATH
);
const liveScanApiBase = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE?.trim() || "";
const openAccessScanner = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS === "1";
const archivePageSize = 24;
const maxHomeHtmlBytes = 160 * 1024;
const maxReportHtmlBytes = 200 * 1024;
// What a supported browser actually downloads on first load.
//
// This deliberately EXCLUDES the `noModule` polyfill bundle. Next emits it for
// browsers without ES-module support, and every browser the framework supports
// skips it, so counting its ~39 KB gzip measured a payload no visitor fetches
// and left the real number invisible behind it.
//
// The value is the previous whole-tag budget (204,800) minus the exact size of
// that bundle (39,520 gzip bytes, byte-identical across the framework versions
// this repo has shipped), so the number of bytes a visitor may really receive
// is unchanged to the byte. This corrects WHAT is measured; it does not relax
// how much is allowed.
//
// Re-baselined for Next 16: 185,856 measured against the 164,516 Next 15
// shipped, +21,340 gzip bytes (+13%) for the same application code. The cost is
// the framework's routing and navigation overhaul plus React 19.2, not this
// app's bundles; its lazy seams still defer and its page chunk shrank. The
// number is stated rather than absorbed so the regression stays visible, and
// the 4 KB of headroom keeps the gate binding.
const maxInitialJsGzipBytes = 190 * 1024;
/**
 * Ceiling on the WHOLE published artifact, not one page.
 *
 * The per-page budgets above cannot see this: they bound one report's HTML and
 * its initial JavaScript, and 574 pages that each pass them can still produce
 * an artifact the platform refuses to publish. Nothing asserted total size
 * before, so the only signal of an overrun would have been a failed deploy.
 *
 * Derived. Measured today: out/ is 318 MB, of which out/reports is 298 MB and
 * the two social cards per report are the bulk of it. The corpus pruner caps
 * committed reports at 1,000, so the same export at the corpus's own maximum
 * is roughly 554 MB. The ceiling clears that (a full corpus must never fail
 * this gate) and sits below GitHub Pages' 1 GB published-site limit, which is
 * the failure this exists to prevent. It still catches the change that
 * motivated it: prerendering the printable route for every committed report
 * renders full evidence eagerly 574 times and would breach this long before it
 * breached the platform.
 */
const maxStaticExportBytes = 700 * 1024 * 1024;
const staticFetchTimeoutMs = 10_000;
const controlResponseMaxBytes = 64 * 1024;
const schemaResponseMaxBytes = 2 * 1024 * 1024;
const htmlResponseMaxBytes = 2 * 1024 * 1024;
const imageResponseMaxBytes = 4 * 1024 * 1024;
const corpusResponseMaxBytes = 32 * 1024 * 1024;
const fullCommitPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const corpusJsonDecisionFields = [
  "consentChoiceState",
  "variantConsentChoiceState",
  "comparisonDecisionMode",
  "compatibilityFingerprintOrigin",
  "compatibilityFingerprintMatched"
];
const corpusJsonCohortIdentityFields = [
  "trackerCatalogDigest",
  "trackerCatalogOrigin",
  "serviceRoleTaxonomyVersion",
  "serviceRoleTaxonomyDigest",
  "metricContractVersion",
  "metricContractDigest"
];
const corpusCsvDecisionColumns = [
  "consent_choice_state",
  "variant_consent_choice_state",
  "comparison_decision_mode",
  "compatibility_fingerprint_origin",
  "compatibility_fingerprint_matched"
];
// Additive export evolution (lib/corpus-export.ts): the provenance/cohort
// columns append after the decision context so positional readers never move.
const corpusCsvProvenanceColumns = [
  "run_outcome",
  "producer",
  "acquisition",
  "build_commit",
  "methodology_version",
  "methodology_origin",
  "browser_name",
  "browser_version",
  "egress_label",
  "egress_region",
  "corpus_cohort_id",
  "corpus_cohort_denominator",
  "corpus_inclusion",
  "corpus_exclusion_reasons",
  "tracker_catalog_digest",
  "tracker_catalog_origin",
  "service_role_taxonomy_version",
  "service_role_taxonomy_digest"
];
const corpusCsvMetricContractColumns = [
  "corpus_export_schema_version",
  "metric_contract_version",
  "metric_contract_digest",
  "catalogued_service_requests",
  "tracking_service_requests",
  "delta_catalogued_service_requests",
  "delta_tracking_service_requests"
];
// Same additive rule: the cookie-family completeness flag appends after the
// metric-contract block, so every column above keeps its position.
const corpusCsvCompletenessColumns = ["cookie_evidence_complete"];
const recordedConsentChoiceStates = ["verified", "contradicted", "weak-signal", "unavailable", "failed"];

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  throw new Error(message);
}

// The same health signal the UI uses to enable the Shields toggle. Fetched
// server-side (no CORS), so it reflects the scanner regardless of the browser's
// allow-list; treat an unreachable scanner as "no Shields".
async function scannerAdvertisesShields(apiBase) {
  try {
    const { response, value: health } = await fetchJsonResource(
      `${apiBase.replace(/\/+$/, "")}/api/health`,
      { cache: "no-store" },
      "scanner health",
      controlResponseMaxBytes
    );
    if (!response.ok) return false;
    return health?.capabilities?.shieldsComparison === true;
  } catch {
    return false;
  }
}

async function scannerAdvertisesScheduledRescans(apiBase) {
  if (!apiBase) return false;
  try {
    const { response, value: health } = await fetchJsonResource(
      `${apiBase.replace(/\/+$/, "")}/api/health`,
      { cache: "no-store" },
      "scanner health",
      controlResponseMaxBytes
    );
    if (!response.ok) return false;
    return health?.capabilities?.scheduledRescans === true;
  } catch {
    return false;
  }
}

async function fetchJsonResource(url, init, label, maxBytes) {
  return fetchResource(url, init, label, (response) =>
    readResponseJsonWithinLimit(response, { maxBytes, label })
  );
}

async function fetchTextResource(url, init, label, maxBytes) {
  return fetchResource(url, init, label, (response) =>
    readResponseTextWithinLimit(response, { maxBytes, label })
  );
}

async function fetchBytesResource(url, init, label, maxBytes) {
  return fetchResource(url, init, label, (response) =>
    readResponseBytesWithinLimit(response, { maxBytes, label })
  );
}

async function fetchResource(url, init, label, read) {
  return withHttpOperationDeadline(
    { timeoutMs: staticFetchTimeoutMs, label },
    async (signal) => {
      const response = await fetch(url, { ...init, signal });
      return { response, value: await read(response) };
    }
  );
}

async function main() {
  await assertStaticExportSize();
  const manifest = await readManifest();
  const phaseReport = await findR2PhaseSmokeReport(manifest);
  const longestOgReport = await findLongestOgReport(manifest);
  const server = createStaticServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") fail("static smoke server did not bind to a port");

  const baseUrl = `http://127.0.0.1:${address.port}${basePath || ""}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const failedStaticPrefetches = new Set();
  page.on("response", (response) => {
    try {
      const pathname = new URL(response.url()).pathname;
      if (response.status() >= 400 && pathname.endsWith(".txt")) {
        failedStaticPrefetches.add(`${response.status()} ${pathname}`);
      }
    } catch {
      // Ignore malformed browser diagnostics; route assertions still fail independently.
    }
  });

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await expectText(page.locator("h1"), "See what a site does, not just what it says.");
    await assertPrimaryLandmarks(page, "static home");
    await assertNoSeriousAxeViolations(page, "static home in light theme");
    if ((await page.locator(".static-gallery, .static-report-card").count()) !== 0) {
      fail("static home eagerly rendered the saved-report archive before the visitor requested it");
    }
    await assertStaticRouteBudgets(path.join(outDir, "index.html"), {
      label: "homepage",
      maxHtmlBytes: maxHomeHtmlBytes,
      maxInitialJsGzipBytes
    });
    pass("static home defers saved-report tools on first load");

    // Before the hook resolves the OS preference the button is named neutrally, so the
    // locator must not depend on the effect having already run.
    const themeToggle = page.getByRole("button", { name: /Switch (?:to (?:light|dark) )?colour theme/ });
    const themeRestingShadow = await themeToggle.evaluate((button) => getComputedStyle(button).boxShadow);
    let themeToggleHasKeyboardFocus = false;
    for (let step = 0; step < 20; step += 1) {
      await page.keyboard.press("Tab");
      themeToggleHasKeyboardFocus = await themeToggle.evaluate((button) => button.matches(":focus-visible"));
      if (themeToggleHasKeyboardFocus) break;
    }
    if (!themeToggleHasKeyboardFocus) {
      fail("theme toggle is not keyboard reachable with a visible focus state");
    }
    const themeFocusShadow = await themeToggle.evaluate((button) => getComputedStyle(button).boxShadow);
    if (themeFocusShadow === "none" || themeFocusShadow === themeRestingShadow) {
      fail("theme toggle focus does not add a visible ring beyond its resting shadow");
    }
    pass("theme toggle exposes visible keyboard focus");
    await themeToggle.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await assertNoSeriousAxeViolations(page, "static home in dark theme");
    await themeToggle.press("Enter");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

    // Both immutable ScanReport v2 revisions publish independently; the
    // stable alias serves the current r2 revision (RFC 10.3/14.11).
    const { response: revisionedResponse, value: revisionedSchema } = await fetchJsonResource(
      `${baseUrl}/schemas/scan-report.v2.r1.schema.json`,
      {},
      "revisioned r1 schema",
      schemaResponseMaxBytes
    );
    if (!revisionedResponse.ok) fail(`revisioned schema not served (${revisionedResponse.status})`);
    if (revisionedSchema.$id !== "https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json") {
      fail("revisioned schema has the wrong $id");
    }
    const { response: aliasResponse, value: aliasSchema } = await fetchJsonResource(
      `${baseUrl}/scan-report.schema.json`,
      {},
      "stable schema alias",
      schemaResponseMaxBytes
    );
    if (!aliasResponse.ok) fail(`stable schema alias not served (${aliasResponse.status})`);
    const { response: r2Response, value: r2Schema } = await fetchJsonResource(
      `${baseUrl}/schemas/scan-report.v2.r2.schema.json`,
      {},
      "revisioned r2 schema",
      schemaResponseMaxBytes
    );
    if (!r2Response.ok) fail(`r2 revisioned schema not served (${r2Response.status})`);
    if (r2Schema.$id !== "https://sitebehavior.org/schemas/scan-report.v2.r2.schema.json") {
      fail("r2 revisioned schema has the wrong $id");
    }
    if (JSON.stringify(aliasSchema) !== JSON.stringify(r2Schema)) {
      fail("stable schema alias does not match the current r2 revision");
    }
    if (JSON.stringify(aliasSchema) === JSON.stringify(revisionedSchema)) {
      fail("stable schema alias still serves historical r1");
    }
    pass("scan-report v2 schemas published (r1 + r2 revisioned files, stable alias on r2)");

    const { response: methodologyResponse, value: methodologyHtml } = await fetchTextResource(
      `${baseUrl}/methodology/`,
      {},
      "methodology page",
      htmlResponseMaxBytes
    );
    if (!methodologyResponse.ok) fail(`methodology page not served (${methodologyResponse.status})`);
    if (!methodologyHtml.includes('id="schema-errata"') || !methodologyHtml.includes("Published schema errata")) {
      fail("methodology page omits the published schema errata pointer");
    }
    const pagesHeaders = await readFile(path.join(outDir, "_headers"), "utf8");
    for (const schemaPath of [
      "/scan-report.schema.json",
      "/schemas/scan-report.v2.r1.schema.json",
      "/schemas/scan-report.v2.r2.schema.json"
    ]) {
      const rule = `${schemaPath}\n  Link: </methodology/#schema-errata>; rel="describedby"`;
      if (!pagesHeaders.includes(rule)) fail(`${schemaPath} omits its schema-errata companion link`);
    }
    pass("frozen schema responses point to the published errata without changing schema bytes");

    for (const cardPath of [
      "/opengraph-image",
      "/twitter-image",
      "/reports/*/opengraph-image",
      "/reports/*/twitter-image"
    ]) {
      const rule = `${cardPath}\n  Content-Type: image/png`;
      if (!pagesHeaders.includes(rule)) fail(`${cardPath} omits its extensionless PNG content type`);
    }
    for (const cardPath of [
      "/opengraph-image",
      `/reports/${phaseReport.id}/opengraph-image`,
      `/reports/${longestOgReport.id}/opengraph-image`
    ]) {
      const { response, value: bytes } = await fetchBytesResource(
        `${baseUrl}${cardPath}`,
        {},
        cardPath,
        imageResponseMaxBytes
      );
      if (!response.ok || response.headers.get("content-type") !== "image/png") {
        fail(`${cardPath} was not served as image/png`);
      }
      const imageBytes = Buffer.from(bytes);
      if (
        imageBytes.length < 24 ||
        !imageBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
        imageBytes.readUInt32BE(16) !== 1200 ||
        imageBytes.readUInt32BE(20) !== 630
      ) {
        fail(`${cardPath} is not a complete 1200x630 PNG`);
      }
    }
    pass(
      `extensionless social cards, including the current longest report (${longestOgReport.descriptionLength} description characters), are complete 1200x630 PNGs`
    );

    const { response: deploymentResponse, value: deployment } = await fetchJsonResource(
      `${baseUrl}/deployment.json`,
      {},
      "static deployment provenance",
      controlResponseMaxBytes
    );
    if (!deploymentResponse.ok) fail(`static deployment provenance not served (${deploymentResponse.status})`);
    if (deployment?.schemaVersion !== 1 || !fullCommitPattern.test(deployment?.deployment)) {
      fail("static deployment provenance does not contain a full source commit");
    }
    const expectedDeployment = expectedBuildCommit();
    if (expectedDeployment && deployment.deployment !== expectedDeployment) {
      fail(`static deployment provenance is ${deployment.deployment}, expected ${expectedDeployment}`);
    }
    pass(`static deployment provenance identifies ${deployment.deployment}`);

    const { response: metricContractResponse, value: metricContract } = await fetchJsonResource(
      `${baseUrl}/metric-contract.v1.json`,
      {},
      "published metric contract",
      controlResponseMaxBytes
    );
    if (!metricContractResponse.ok) fail(`published metric contract not served (${metricContractResponse.status})`);
    const publishedMetricContractVersion = metricContract?.metadata?.version;
    const publishedMetricContractDigest = metricContract?.metadata?.digest;
    if (
      typeof publishedMetricContractVersion !== "string" ||
      typeof publishedMetricContractDigest !== "string" ||
      !sha256Pattern.test(publishedMetricContractDigest) ||
      metricContract?.contract?.version !== publishedMetricContractVersion
    ) {
      fail("published metric contract does not expose a valid, self-consistent identity");
    }

    const { response: corpusJsonResponse, value: corpus } = await fetchJsonResource(
      `${baseUrl}/corpus.json`,
      {},
      "researcher JSON export",
      corpusResponseMaxBytes
    );
    if (!corpusJsonResponse.ok) fail(`researcher JSON export not served (${corpusJsonResponse.status})`);
    if (!Array.isArray(corpus?.reports) || corpus.reportCount !== corpus.reports.length) {
      fail("researcher JSON export does not contain its declared report rows");
    }
    if (
      corpus.exportSchemaVersion !== 1 ||
      corpus.metricContractVersion !== publishedMetricContractVersion ||
      corpus.metricContractDigest !== publishedMetricContractDigest ||
      !Array.isArray(corpus.cohorts) ||
      corpus.reports.some(
        (report) =>
          report?.metricContractVersion !== publishedMetricContractVersion ||
          report?.metricContractDigest !== publishedMetricContractDigest
      ) ||
      corpus.cohorts.some(
        (cohort) =>
          cohort?.metricContractVersion !== publishedMetricContractVersion ||
          cohort?.metricContractDigest !== publishedMetricContractDigest
      )
    ) {
      fail("researcher JSON export is not bound to the published metric contract identity");
    }
    const phaseReportExportRow = corpus.reports.find((report) => report?.id === phaseReport.id);
    if (!phaseReportExportRow) fail("researcher JSON export omits the committed r2 phase smoke report");
    for (const field of [...corpusJsonDecisionFields, ...corpusJsonCohortIdentityFields]) {
      if (!Object.prototype.hasOwnProperty.call(phaseReportExportRow, field)) {
        fail(`researcher JSON export omits ${field}`);
      }
    }
    if (
      !recordedConsentChoiceStates.includes(phaseReportExportRow.consentChoiceState) ||
      !recordedConsentChoiceStates.includes(phaseReportExportRow.variantConsentChoiceState) ||
      !["comparable", "raw-only"].includes(phaseReportExportRow.comparisonDecisionMode) ||
      phaseReportExportRow.compatibilityFingerprintOrigin !== "recorded" ||
      typeof phaseReportExportRow.compatibilityFingerprintMatched !== "boolean" ||
      !sha256Pattern.test(phaseReportExportRow.trackerCatalogDigest) ||
      phaseReportExportRow.trackerCatalogOrigin !== "recorded" ||
      typeof phaseReportExportRow.serviceRoleTaxonomyVersion !== "string" ||
      !sha256Pattern.test(phaseReportExportRow.serviceRoleTaxonomyDigest) ||
      phaseReportExportRow.metricContractVersion !== publishedMetricContractVersion ||
      phaseReportExportRow.metricContractDigest !== publishedMetricContractDigest ||
      !phaseReportExportRow.corpusCohortId.includes(phaseReportExportRow.trackerCatalogDigest) ||
      !phaseReportExportRow.corpusCohortId.includes(phaseReportExportRow.serviceRoleTaxonomyDigest) ||
      !phaseReportExportRow.corpusCohortId.includes(phaseReportExportRow.metricContractVersion) ||
      !phaseReportExportRow.corpusCohortId.includes(phaseReportExportRow.metricContractDigest)
    ) {
      fail("researcher JSON export flattened the committed r2 comparison or cohort identity incorrectly");
    }

    const { response: corpusCsvResponse, value: corpusCsv } = await fetchTextResource(
      `${baseUrl}/corpus.csv`,
      {},
      "researcher CSV export",
      corpusResponseMaxBytes
    );
    if (!corpusCsvResponse.ok) fail(`researcher CSV export not served (${corpusCsvResponse.status})`);
    const corpusCsvHeader = corpusCsv.split(/\r?\n/, 1)[0].split(",");
    const legacyTailIndex = corpusCsvHeader.indexOf("limited");
    const expectedAppendedTail = [
      ...corpusCsvDecisionColumns,
      ...corpusCsvProvenanceColumns,
      ...corpusCsvMetricContractColumns,
      ...corpusCsvCompletenessColumns
    ];
    if (
      legacyTailIndex < 0 ||
      corpusCsvHeader.slice(legacyTailIndex + 1).join(",") !== expectedAppendedTail.join(",")
    ) {
      fail(
        "researcher CSV export did not append the complete decision, provenance/cohort, and metric-contract tail after the legacy contract"
      );
    }
    pass("researcher exports publish the complete appended contract and bind JSON to the published metric identity");

    if (liveScanApiBase) {
      await expectText(page.locator(".status-pill"), "Live");
      await expectText(page.locator(".scan-panel"), "Public scanner");
      const optionsOpen = await page.locator(".options-disclosure").evaluate((element) => element.hasAttribute("open"));
      if (!optionsOpen) await page.getByText("Options").click();
      if (!(await page.locator(".segmented-control button", { hasText: "GPC diff" }).isEnabled())) {
        fail("production Cloudflare scanner should enable GPC comparison");
      }
      // Shields comparison is enabled only when the scanner advertises it: the full
      // Node/Containers scanner does, the legacy Browser Run Worker does not. Track
      // the live capability instead of assuming a topology. (This branch already
      // requires the scanner's CORS to allow this origin, otherwise the browser's
      // health fetch fails and the "Live" assertion above never passes.)
      const shieldsExpected = await scannerAdvertisesShields(liveScanApiBase);
      const shieldsEnabled = await page.locator(".segmented-control button", { hasText: "Shields" }).isEnabled();
      if (shieldsExpected && !shieldsEnabled) {
        fail("scanner advertises shieldsComparison but the Shields button is disabled");
      }
      if (!shieldsExpected && shieldsEnabled) {
        fail("scanner does not advertise shieldsComparison but the Shields button is enabled");
      }
      const accessFields = await page.getByLabel("Scanner access key").count();
      if (openAccessScanner && accessFields !== 0) {
        fail("open Cloudflare scanner should not show a scanner access key field");
      }
      pass(openAccessScanner ? "static home renders open live scanner" : "static home renders gated live scanner");
    }

    const scheduledRescansExpected = await scannerAdvertisesScheduledRescans(liveScanApiBase);
    const scheduledRescanPanels = await page.locator(".scheduled-rescan-panel").count();
    if (!scheduledRescansExpected && scheduledRescanPanels !== 0) {
      fail("scheduled-rescan UI rendered without an exact health capability");
    }
    if (scheduledRescansExpected) {
      if (scheduledRescanPanels !== 1) fail("scheduled-rescan capability did not render exactly one management panel");
      await expectText(page.locator("#scheduled-rescan-title"), "Schedule weekly rescans");
      await expectText(page.locator(".scheduled-rescan-panel"), "every 7 days");
      await expectText(page.locator(".scheduled-rescan-panel"), "30 days");
      await expectText(page.locator(".scheduled-rescan-panel"), "at most 4 scheduled rescans follow it");
      await expectText(page.locator(".scheduled-rescan-panel"), "Scheduled rescans, not change alerts.");
      if ((await page.getByRole("button", { name: "Schedule weekly rescans", exact: true }).count()) !== 1) {
        fail("scheduled-rescan panel is missing its deliberate create action");
      }
    }
    pass(
      scheduledRescansExpected
        ? "scheduled-rescan capability renders exact bounded-retention UI"
        : "scheduled-rescan UI stays absent while capability is disabled"
    );

    await loadStaticArchive(page);
    await expectText(page.locator(".static-gallery"), "Saved reports");
    await assertNoSeriousAxeViolations(page, "saved-report archive");
    pass("static home loads saved-report tools on demand");

    const cardCount = await page.locator(".static-report-card").count();
    if (cardCount !== Math.min(archivePageSize, manifest.reports.length)) {
      fail(`static archive rendered ${cardCount} initial report cards for ${manifest.reports.length} manifest entries`);
    }
    pass("static archive bounds its initial DOM");

    const firstReport = manifest.reports[0];
    if (typeof firstReport.headline !== "string" || !firstReport.headline) fail("manifest report lacks its canonical headline");
    await assertStaticSeoContract(manifest, firstReport);
    pass("static canonicals, social URLs, indexability, and sitemap dates satisfy the SEO contract");
    await page.getByLabel("Search reports").fill(firstReport.domain);
    const matchingDomainCount = manifest.reports.filter((report) => searchableReportText(report).includes(firstReport.domain.toLowerCase())).length;
    await expectCardCount(page, Math.min(archivePageSize, matchingDomainCount));
    pass("static archive search filters reports");

    await page.getByLabel("Report type").selectOption("comparison");
    const matchingComparisonCount = manifest.reports.filter(
      (report) => report.reportType === "comparison" && searchableReportText(report).includes(firstReport.domain.toLowerCase())
    ).length;
    await expectCardCount(page, Math.min(archivePageSize, matchingComparisonCount));
    pass("static archive type filter combines with search");

    await page.getByLabel("Search reports").fill("");
    await page.getByLabel("Report type").selectOption("all");
    await page.getByLabel("Sort reports").selectOption("thirdParty");
    await expectCardCount(page, Math.min(archivePageSize, manifest.reports.length));
    while ((await page.getByRole("button", { name: /Show \d+ more reports/ }).count()) > 0) {
      await page.getByRole("button", { name: /Show \d+ more reports/ }).click();
    }
    await expectCardCount(page, manifest.reports.length);
    pass("static archive progressively reveals every manifest report");

    // A deterministic single-scan fixture (example.com) plus its later-visit
    // twin drive the single-report UI paths the committed comparison-only
    // corpus cannot. They live under scripts/, not public/reports/, so they
    // never surface in the gallery, directory, or sitemap.
    const singleReportFixture = path.join(rootDir, "scripts", "fixtures", "smoke-single-report.json");
    const rescanReportFixture = path.join(rootDir, "scripts", "fixtures", "smoke-single-report-rescan.json");

    // The same file in both slots has identical timestamps, which cannot
    // order a before/after pair: the tool must refuse with the ordering
    // error, never build a doomed comparison.
    await page.locator(".static-compare-upload input").nth(0).setInputFiles(singleReportFixture);
    await page.locator(".static-compare-upload input").nth(1).setInputFiles(singleReportFixture);
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll(".compare-upload-label")].filter((label) => label.textContent?.trim() === name).length === 2,
      path.basename(singleReportFixture)
    );
    await page.getByRole("button", { name: "Compare files" }).click();
    await expectText(page.locator('.static-compare-error[role="alert"]'), "cannot order a before/after pair");
    await assertNoSeriousAxeViolations(page, "saved-report comparison error");
    pass("static archive refuses an unorderable upload pair");

    await page.locator(".static-compare-upload input").nth(0).setInputFiles(rescanReportFixture);
    await page.locator(".static-compare-upload input").nth(1).setInputFiles(singleReportFixture);
    await page.waitForFunction(
      ([beforeName, afterName]) => {
        const labels = [...document.querySelectorAll(".compare-upload-label")].map((label) => label.textContent?.trim());
        return labels[0] === beforeName && labels[1] === afterName;
      },
      [path.basename(rescanReportFixture), path.basename(singleReportFixture)]
    );
    await page.getByRole("button", { name: "Compare files" }).click();
    await page.waitForSelector(".comparison-card", { timeout: 10_000 });
    const comparisonCard = page.locator(".comparison-card");
    const comparisonLists = page.locator(".comparison-lists");
    await expectText(comparisonCard, "Temporal Comparison");
    await expectText(comparisonCard, "Cookie and storage count deltas include every observation");
    await expectText(comparisonCard, "Name-level lists show only reviewed names");
    await expectText(comparisonLists, "logged_in");
    await expectText(comparisonLists, "No visible storage-key changes to show; privacy-filtered keys are not itemized.");
    const cookieDelta = page.locator(".delta-tile").filter({ has: page.getByText("Cookies", { exact: true }) });
    await expectText(cookieDelta, "+2");
    await expectText(cookieDelta, "Before: 3 · After: 5");
    const storageDelta = page.locator(".delta-tile", { hasText: "Storage keys" });
    await expectText(storageDelta, "+1");
    await expectText(storageDelta, "Before: 3 · After: 4");
    if ((await comparisonCard.innerHTML()).includes("[redacted")) {
      fail("comparison card exposes a privacy marker as an exact name");
    }
    await assertNoSeriousAxeViolations(page, "rendered temporal comparison");
    pass("static archive compares uploaded reports");

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await loadStaticArchive(page);
    await page.locator(".static-report-card").first().click();
    // .report-identity, not .report-header: the permalink's own header used to
    // restate the site, URL and run facts that the evidence explorer's header
    // also carries, so opening the explorer swapped one copy for another. It
    // renders once now, in both states.
    await page.waitForSelector(".report-identity", { timeout: 10_000 });
    await expectText(page.locator(".report-identity"), "https://");
    if ((await page.locator(".scan-workbench").count()) !== 0) fail("saved report permalink must not put the scanner before evidence");
    // The <h1> is the SITE. The headline is the lead finding and leads the
    // banner below; making it the heading too printed the same sentence three
    // times on one page. Both must still be in the pre-hydration document.
    await expectText(page.locator("h1"), firstReport.domain);
    await expectText(page.locator(".headline-title"), firstReport.headline);
    await assertPrimaryLandmarks(page, "saved report permalink");
    await assertNoSeriousAxeViolations(page, "compact saved report permalink");

    const reportHtmlPath = path.join(outDir, "reports", firstReport.id, "index.html");
    const reportHtml = await readFile(reportHtmlPath, "utf8");
    if (!reportHtml.includes("report-page-shell") || !reportHtml.includes(firstReport.headline)) {
      fail("saved report evidence is absent from the generated initial HTML");
    }
    if (reportHtml.includes("scan-workbench")) fail("generated report HTML contains the scanner workbench");
    // The printable rendering is container-only (serverOnlyAppDirs), so a link
    // to it here would be dead on every committed report Pages serves.
    if (/href="[^"]*\/print\/?"/.test(reportHtml)) {
      fail("generated report HTML links the container-only printable route");
    }
    if (reportHtml.includes('"evidence":{"requests"')) fail("generated report HTML inlines raw request evidence");
    await assertStaticRouteBudgets(reportHtmlPath, {
      label: "saved report",
      maxHtmlBytes: maxReportHtmlBytes,
      maxInitialJsGzipBytes
    });
    const noScriptContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } });
    const noScriptPage = await noScriptContext.newPage();
    await noScriptPage.goto(`${baseUrl}/reports/${firstReport.id}/`, { waitUntil: "domcontentloaded" });
    await expectText(noScriptPage.locator(".report-identity"), "https://");
    await expectText(noScriptPage.locator("h1"), firstReport.domain);
    await expectText(noScriptPage.locator(".headline-title"), firstReport.headline);

    const phaseReportHtmlPath = path.join(outDir, "reports", phaseReport.id, "index.html");
    const phaseReportHtml = await readFile(phaseReportHtmlPath, "utf8");
    if (phaseReportHtml.includes("visit-phase-evidence")) fail("generated r2 report HTML eagerly inlines raw phase evidence");
    await noScriptPage.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "domcontentloaded" });
    await expectText(noScriptPage.locator(".headline-banner"), "Observed in");
    await expectText(noScriptPage.getByRole("link", { name: "Open report JSON" }), "Open report JSON");
    await noScriptContext.close();
    pass("static report permalink ships a compact summary and direct download without JavaScript");

    await page.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "networkidle" });
    const exploreEvidence = page.getByRole("button", { name: "Explore full evidence" });
    await exploreEvidence.focus();
    await page.keyboard.press("Enter");
    const phaseEvidence = page.locator(".visit-phase-evidence");
    await expectText(phaseEvidence, "Visit phases & state changes");
    const explorerHasFocus = await page.locator(".report-focus-target").evaluate(
      (region) => region === document.activeElement
    );
    if (!explorerHasFocus) fail("saved report explorer did not receive focus after its trigger disappeared");
    pass("saved report explorer preserves keyboard focus across lazy loading");
    await assertNoSeriousAxeViolations(page, "interactive r2 evidence explorer");
    await expectText(phaseEvidence, "P0 · passive-load");
    await expectText(phaseEvidence, "No retained rows");
    const stateChangeDisclosure = phaseEvidence.locator("details.state-change-disclosure");
    await stateChangeDisclosure.locator("summary").click();
    await stateChangeDisclosure.locator(".state-change-row").first().waitFor({ state: "visible" });
    await expectText(stateChangeDisclosure, "P0 · Initial page load");

    const r2RequestLog = page.locator("details.data-section", { hasText: "Request log" });
    await r2RequestLog.locator("summary").click();
    await r2RequestLog.locator('td[data-label="Phase"]').first().waitFor({ state: "visible" });
    await expectText(r2RequestLog, "P0 · Initial page load");
    pass("committed r2 report renders phase spans, snapshot changes, and request phase labels");

    const profileKey = staticProfileKey(firstReport.domain);
    if (!profileKey) fail(`cannot derive a canonical site profile from ${firstReport.domain}`);
    await page.goto(`${baseUrl}/sites/${encodeURIComponent(profileKey)}/`, { waitUntil: "networkidle" });
    await expectText(page.locator("h1"), profileKey);
    await expectText(page.locator(".site-profile-page"), "Curated public corpus");
    const latestEvidenceHref = await page.getByRole("link", { name: "Open latest evidence" }).getAttribute("href");
    if (!latestEvidenceHref?.includes(`/reports/${firstReport.id}/`)) fail("site profile latest-evidence link is stale");
    const rescanHref = await page.getByRole("link", { name: "Scan this exact route again" }).getAttribute("href");
    if (!rescanHref || !decodeURIComponent(rescanHref).includes(firstReport.requestedUrl)) {
      fail("site profile rescan link does not preserve the latest requested route");
    }
    pass("static site profile links exact evidence and rescan subject");

    // Render the single-scan fixture through the "Open report file" upload path and
    // exercise the request-log filters: the fixture has 2 third-party requests, one a
    // known service (an xhr, not a script), so third-party=2, known-service=1, and
    // known-service+script=0.
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await openHomepageTools(page);
    const reportUploadLabel = page.locator("label.file-button", { hasText: "Open report file" }).first();
    const reportUploadInput = reportUploadLabel.locator('input[type="file"]');
    await reportUploadInput.evaluate((input) => input.focus());
    const uploadFocusShadow = await reportUploadLabel.evaluate((label) => getComputedStyle(label).boxShadow);
    if (uploadFocusShadow === "none") fail("file upload button has no visible keyboard focus treatment");
    pass("file upload button exposes visible keyboard focus");
    await reportUploadInput.setInputFiles(singleReportFixture);
    await page.waitForSelector(".report-header", { timeout: 10_000 });
    const resultRegionHasFocus = await page.locator("#report").evaluate((region) => region === document.activeElement);
    if (!resultRegionHasFocus) fail("uploaded report did not move focus to the shared results region");
    await expectText(page.locator(".party-legend"), "Other third-party");
    const domainTableRegion = page.getByRole("region", { name: "Domain evidence table" });
    if ((await domainTableRegion.getAttribute("tabindex")) !== "0") {
      fail("domain evidence horizontal scroller is not keyboard-focusable");
    }
    let tableHasKeyboardFocus = false;
    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press("Tab");
      tableHasKeyboardFocus = await domainTableRegion.evaluate(
        (region) => region === document.activeElement && region.matches(":focus-visible")
      );
      if (tableHasKeyboardFocus) break;
    }
    if (!tableHasKeyboardFocus) fail("evidence table scroller is not reachable with keyboard navigation");
    const tableFocusShadow = await domainTableRegion.evaluate((region) => getComputedStyle(region).boxShadow);
    if (tableFocusShadow === "none") fail("evidence table scroller has no visible keyboard focus treatment");
    pass("report labels traffic remainder accurately and exposes a focusable evidence scroller");
    if ((await page.locator(".visit-phase-evidence").count()) !== 0) {
      fail("legacy v1 upload rendered v2-only phase evidence");
    }
    if (
      (await page.getByRole("link", { name: "Share", exact: true }).count()) !== 0 ||
      // Loose on purpose. This asserts an ABSENCE, so an exact name that drifts
      // would start passing vacuously instead of catching a retained capability.
      (await page.getByRole("button", { name: /share link/i }).count()) !== 0
    ) {
      fail("locally opened report retained an imported share capability");
    }
    pass("legacy v1 upload stays phase-absent and drops imported share controls");
    const cookieCard = page.locator(".report-sidebar .side-card", {
      has: page.getByRole("heading", { name: "Cookies", exact: true })
    });
    const storageCard = page.locator(".report-sidebar .side-card", {
      has: page.getByRole("heading", { name: "Storage", exact: true })
    });
    // Both lists group by the field redaction LEAVES INTACT -- the setting
    // domain, the storage area -- because the field they used to lead with is
    // the one it blanks. A real report spent the whole rail on twelve rows of
    // "Cookie N · name hidden for privacy" and then disclosed underneath that
    // hundreds more records were not shown at all.
    //
    // What must not change is the redaction boundary, so that is what is
    // asserted: reviewed names still published, withheld ones still counted and
    // never invented, and the grouped facts a reader can act on.
    await expectText(cookieCard, "_octo");
    await expectText(cookieCard, ".analytics.brave.test");
    await expectText(cookieCard, "third-party · 1 persistent");
    await expectText(cookieCard, "third-party · 1 session");
    await expectText(cookieCard, "2 cookie names hidden");
    if ((await cookieCard.innerText()).includes("name hidden for privacy")) {
      fail("the cookie rail still leads rows with the one field redaction blanks");
    }
    await expectText(storageCard, "soft-nav:marker");
    await expectText(storageCard, "localStorage");
    await expectText(storageCard, "2 storage keys hidden");
    if ((await storageCard.innerText()).includes("name hidden for privacy")) {
      fail("the storage rail still leads rows with the one field redaction blanks");
    }
    const privacyCardsHtml = `${await cookieCard.innerHTML()}${await storageCard.innerHTML()}`;
    if (privacyCardsHtml.includes("[redacted")) fail("report cards expose raw redaction markers");
    pass("static report explains privacy-filtered cookie and storage names without changing reviewed names");
    await page.locator("details.data-section", { hasText: "Request log" }).locator("summary").click();
    const requestTableRegion = page.getByRole("region", { name: "Request log table" });
    if ((await requestTableRegion.getAttribute("tabindex")) !== "0") {
      fail("request log horizontal scroller is not keyboard-focusable");
    }
    await page.getByRole("button", { name: "Third-party" }).click();
    await expectRequestRowCount(page, 2);
    await page.getByRole("button", { name: "Catalog matches" }).click();
    await expectRequestRowCount(page, 1);
    await page.getByLabel("Resource type").selectOption("script");
    await expectRequestRowCount(page, 0);
    pass("static report request filters narrow rows");

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await loadStaticArchive(page);
    await assertNoHorizontalOverflow(page, "static mobile archive");
    pass("static mobile archive fits viewport");
    await page.goto(`${baseUrl}/sites/${encodeURIComponent(profileKey)}/`, { waitUntil: "networkidle" });
    await assertNoHorizontalOverflow(page, "static mobile site profile");
    pass("static mobile site profile fits viewport");
    await page.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Explore full evidence" }).click();
    await page.waitForSelector(".visit-phase-evidence", { timeout: 10_000 });
    await assertNoHorizontalOverflow(page, "static mobile r2 report");
    await assertMinimumTargetSize(page.locator(".arm-option"), 44, "static mobile evidence switcher");
    await assertMinimumTargetSize(
      page.locator(".report-actions .secondary-button"),
      44,
      "static mobile report actions"
    );
    pass("static mobile r2 phase report fits viewport");
    pass("static mobile evidence switcher exposes 44px targets");
    pass("static mobile report actions expose 44px targets");

    // Model a wide hybrid laptop explicitly: the primary pointer is fine, but
    // the available-pointer bitmask also contains a coarse touchscreen. A
    // `(pointer: coarse)` rule cannot see this state; `(any-pointer: coarse)`
    // can. These are Blink's own pointer bit values (fine 4, coarse 2).
    const hybridPointerBrowser = await chromium.launch({
      headless: true,
      args: ["--blink-settings=primaryPointerType=4,availablePointerTypes=6"]
    });
    try {
      const hybridPointerPage = await hybridPointerBrowser.newPage({ viewport: { width: 1024, height: 900 } });
      await hybridPointerPage.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "networkidle" });
      const pointerMedia = await hybridPointerPage.evaluate(() => ({
        primaryFine: matchMedia("(pointer: fine)").matches,
        primaryCoarse: matchMedia("(pointer: coarse)").matches,
        anyFine: matchMedia("(any-pointer: fine)").matches,
        anyCoarse: matchMedia("(any-pointer: coarse)").matches,
        narrow: matchMedia("(max-width: 720px)").matches
      }));
      if (
        !pointerMedia.primaryFine ||
        pointerMedia.primaryCoarse ||
        !pointerMedia.anyFine ||
        !pointerMedia.anyCoarse ||
        pointerMedia.narrow
      ) {
        fail(`wide hybrid-pointer smoke has the wrong media state: ${JSON.stringify(pointerMedia)}`);
      }
      await hybridPointerPage.getByRole("button", { name: "Explore full evidence" }).click();
      await hybridPointerPage.waitForSelector(".visit-phase-evidence", { timeout: 10_000 });
      await assertMinimumTargetSize(
        hybridPointerPage.locator(".arm-option"),
        44,
        "wide hybrid-pointer evidence switcher"
      );
      await assertMinimumTargetSize(
        hybridPointerPage.locator(".report-actions .secondary-button"),
        44,
        "wide hybrid-pointer report actions"
      );
      pass("wide hybrid-pointer evidence switcher exposes 44px targets");
      pass("wide hybrid-pointer report actions expose 44px targets");
    } finally {
      await hybridPointerBrowser.close();
    }

    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await loadStaticArchive(page);
    await assertNoHorizontalOverflow(page, "static narrow-mobile archive");
    pass("static archive fits a 320px viewport");
    await page.goto(`${baseUrl}/directory/`, { waitUntil: "networkidle" });
    await assertNoHorizontalOverflow(page, "static narrow-mobile directory");
    const categorySelect = page.getByLabel("Browse a category");
    const firstCategoryPath = await categorySelect.locator('option:not([value=""])').first().getAttribute("value");
    if (!firstCategoryPath) fail("directory exposes no browsable category option");
    const directoryUrlBeforeSelection = page.url();
    await categorySelect.selectOption(firstCategoryPath);
    if (page.url() !== directoryUrlBeforeSelection) fail("directory category selection navigated without submit");
    await page.getByRole("button", { name: "Browse category" }).click();
    await page.waitForURL((url) => url.pathname.endsWith(firstCategoryPath));
    await assertNoSeriousAxeViolations(page, "narrow category directory route");
    pass("directory category navigation waits for explicit submit");
    pass("static directory fits a 320px viewport");
    await page.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "networkidle" });
    const narrowReceiptDetails = page.locator("details.evidence-receipt-details");
    await narrowReceiptDetails.locator("summary").click();
    await narrowReceiptDetails.locator(".evidence-receipt-run").first().waitFor({ state: "visible" });
    await assertNoHorizontalOverflow(page, "open evidence receipt at 320px");
    pass("open evidence receipt fits a 320px viewport");
    if (failedStaticPrefetches.size > 0) {
      fail(`static navigation emitted failed RSC prefetches: ${[...failedStaticPrefetches].join(", ")}`);
    }
    pass("static navigation emits no failed RSC prefetches");
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function readManifest() {
  const payload = JSON.parse(await readFile(path.join(outDir, "reports", "index.json"), "utf8"));
  if (!payload || !Array.isArray(payload.reports) || payload.reports.length === 0) {
    fail("static report manifest is missing reports");
  }
  return payload;
}

async function assertStaticRouteBudgets(htmlPath, { label, maxHtmlBytes, maxInitialJsGzipBytes }) {
  const html = await readFile(htmlPath, "utf8");
  const htmlBytes = Buffer.byteLength(html, "utf8");
  if (htmlBytes > maxHtmlBytes) {
    fail(`${label} HTML is ${htmlBytes} bytes; budget is ${maxHtmlBytes} bytes`);
  }

  // Match the whole tag so the `noModule` attribute is visible wherever it
  // sits relative to `src`; a src-anchored match silently dropped it.
  const tags = Array.from(html.matchAll(/<script\b[^>]*?\bsrc="([^"]+\.js(?:\?[^\"]*)?)"[^>]*>/g));
  const seen = new Set();
  const scripts = [];
  for (const tag of tags) {
    if (seen.has(tag[1])) continue;
    seen.add(tag[1]);
    if (/\bnomodule\b/i.test(tag[0])) continue;
    scripts.push(tag[1]);
  }
  let compressedBytes = 0;
  for (const source of scripts) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(source, "https://sitebehavior.org").pathname);
    } catch {
      fail(`${label} emitted an invalid initial script URL: ${source}`);
    }
    const relative = pathname.replace(/^\/+/, "").replace(new RegExp(`^${escapeRegex(basePath.replace(/^\/+/, ""))}/`), "");
    const assetPath = path.join(outDir, relative);
    const asset = await readFile(assetPath);
    compressedBytes += gzipSync(asset, { level: 9 }).byteLength;
  }
  if (compressedBytes > maxInitialJsGzipBytes) {
    fail(`${label} initial JavaScript is ${compressedBytes} gzip bytes; budget is ${maxInitialJsGzipBytes} bytes`);
  }
  pass(`${label} stays within HTML and initial-JavaScript budgets`);
}

async function directorySizeBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySizeBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

async function assertStaticExportSize() {
  const byDirectory = [];
  let total = 0;
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    const child = path.join(outDir, entry.name);
    const bytes = entry.isDirectory() ? await directorySizeBytes(child) : (await stat(child)).size;
    total += bytes;
    byDirectory.push([entry.name, bytes]);
  }

  if (total > maxStaticExportBytes) {
    // Attribute the overrun. A single scary number gets the ceiling raised
    // reflexively; a breakdown says which half grew and whether it should have.
    const breakdown = byDirectory
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, bytes]) => `${name} ${(bytes / 1024 / 1024).toFixed(1)} MB`)
      .join(", ");
    fail(
      `static export is ${(total / 1024 / 1024).toFixed(1)} MB; ceiling is ${(maxStaticExportBytes / 1024 / 1024).toFixed(0)} MB. Largest: ${breakdown}`
    );
  }
  pass(`static export is ${(total / 1024 / 1024).toFixed(1)} MB, within its ${(maxStaticExportBytes / 1024 / 1024).toFixed(0)} MB ceiling`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function assertStaticSeoContract(manifest, firstReport) {
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL?.trim();
  if (!configuredOrigin) fail("static SEO contract requires NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL");
  const origin = new URL(configuredOrigin).origin;
  if (origin.startsWith("http://") || /\/\/(?:localhost|127\.0\.0\.1)(?::|$)/.test(origin)) {
    fail("static SEO contract received a non-public origin");
  }
  const publicBase = `${origin}${basePath}`;
  const homeUrl = `${publicBase}/`;
  const reportUrl = `${publicBase}/reports/${firstReport.id}/`;
  const profileKey = staticProfileKey(firstReport.domain);
  if (!profileKey) fail(`cannot derive a canonical site profile from ${firstReport.domain}`);
  const profileUrl = `${publicBase}/sites/${encodeURIComponent(profileKey)}/`;

  const homeHtml = await readFile(path.join(outDir, "index.html"), "utf8");
  const reportHtml = await readFile(path.join(outDir, "reports", firstReport.id, "index.html"), "utf8");
  const profileHtml = await readFile(path.join(outDir, "sites", profileKey, "index.html"), "utf8");
  assertCanonicalAndSocialUrl(homeHtml, homeUrl, "home");
  assertCanonicalAndSocialUrl(reportHtml, reportUrl, "permanent report");
  assertCanonicalAndSocialUrl(profileHtml, profileUrl, "site profile");
  assertTrailingSlashProfileLinks(reportHtml, "permanent report");
  for (const route of ["directory", "glossary", "methodology", "privacy", "status", "security", "corrections", "catalog"]) {
    const routeUrl = `${publicBase}/${route}/`;
    const routeHtml = await readFile(path.join(outDir, route, "index.html"), "utf8");
    assertCanonicalAndSocialUrl(routeHtml, routeUrl, route);
  }
  const directoryHtml = await readFile(path.join(outDir, "directory", "index.html"), "utf8");
  assertTrailingSlashProfileLinks(directoryHtml, "directory");
  if (/name="robots" content="[^"]*noindex/i.test(reportHtml)) {
    fail("permanent report was emitted with noindex");
  }
  const reportDescription = metaContent(reportHtml, "name", "description");
  if (!reportDescription || reportDescription.length > 160 || !reportDescription.includes("not a verdict")) {
    fail("permanent report description is missing, too long, or omits the evidence caveat");
  }

  const sitemapXml = await readFile(path.join(outDir, "sitemap.xml"), "utf8");
  if (sitemapXml.includes("localhost") || sitemapXml.includes("127.0.0.1")) {
    fail("sitemap contains a development origin");
  }
  const sitemapReportUrls = [...sitemapXml.matchAll(/<loc>([^<]*\/reports\/[^/]+\/)<\/loc>/g)]
    .map((match) => match[1])
    .sort();
  const expectedReportUrls = manifest.reports
    .map((report) => `${publicBase}/reports/${report.id}/`)
    .sort();
  if (JSON.stringify(sitemapReportUrls) !== JSON.stringify(expectedReportUrls)) {
    fail(
      `sitemap report URL set differs from the public manifest (${sitemapReportUrls.length} sitemap, ${expectedReportUrls.length} manifest)`
    );
  }
  const reportEntry = sitemapUrlEntry(sitemapXml, reportUrl);
  const profileEntry = sitemapUrlEntry(sitemapXml, profileUrl);
  const expectedScanDate = firstReport.scannedAt.slice(0, 10);
  const expectedProfileDate = manifest.reports
    .filter((report) => staticProfileKey(report.domain) === profileKey)
    .map((report) => report.scannedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
    ?.slice(0, 10);
  if (!reportEntry.includes(`<lastmod>${expectedScanDate}`)) fail("report sitemap date is not derived from its scan");
  if (!expectedProfileDate || !profileEntry.includes(`<lastmod>${expectedProfileDate}`)) {
    fail("profile sitemap date is not derived from its latest scan");
  }
  for (const route of ["status", "security", "corrections", "catalog"]) {
    sitemapUrlEntry(sitemapXml, `${publicBase}/${route}/`);
  }
  // The paginated directory routes still resolve, so nothing already linked or
  // indexed 404s, but /directory/ now carries every scanned site in one sortable
  // table and each paged route renders the same content. So they must NOT be in
  // the sitemap, and each must canonicalise to /directory/. Asserted rather than
  // skipped: this check used to run only if the sitemap listed the page, so
  // dropping the entry would have made it disappear instead of fail.
  if (/<loc>[^<]*\/directory\/page\//.test(sitemapXml)) {
    fail("sitemap advertises a paginated directory alias of /directory/");
  }
  const paginatedIndex = path.join(outDir, "directory", "page", "2", "index.html");
  if (existsSync(paginatedIndex)) {
    const paginatedHtml = await readFile(paginatedIndex, "utf8");
    if (!paginatedHtml.includes(`<link rel="canonical" href="${publicBase}/directory/"`)) {
      fail("a paginated directory page must canonicalise to /directory/");
    }
  }
  const categoryMatch = sitemapXml.match(/<loc>([^<]*\/categories\/[^<]+\/)<\/loc>/);
  if (!categoryMatch) fail("sitemap omits every quality-gated category page");
  const categoryPath = new URL(categoryMatch[1]).pathname.replace(basePath, "").replace(/^\//, "").replace(/\/$/, "");
  const categoryHtml = await readFile(path.join(outDir, ...categoryPath.split("/"), "index.html"), "utf8");
  assertCanonicalAndSocialUrl(categoryHtml, categoryMatch[1], "category evidence page");
  assertTrailingSlashProfileLinks(categoryHtml, "category evidence page");
  const now = Date.now();
  for (const match of sitemapXml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) {
    const timestamp = Date.parse(match[1]);
    if (!Number.isFinite(timestamp) || timestamp > now) fail(`sitemap contains an invalid or future lastmod: ${match[1]}`);
  }
}

function assertTrailingSlashProfileLinks(html, label) {
  const hrefs = [...html.matchAll(/href="([^"]*\/sites\/[^"?#]+)"/g)].map((match) => match[1]);
  if (hrefs.length === 0) fail(`${label} contains no crawlable site-profile links`);
  const malformed = hrefs.find((href) => !href.endsWith("/"));
  if (malformed) fail(`${label} emitted a site-profile link without a trailing slash: ${malformed}`);
}

/** Mirror lib/site-profile.ts without importing TypeScript into this ESM smoke. */
function staticProfileKey(domain) {
  const normalized = String(domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (
    !normalized ||
    normalized.length > 253 ||
    normalized === "unknown" ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) return null;
  const labels = normalized.split(".");
  if (
    labels.some(
      (label) =>
        label === "" ||
        (label !== "{label}" && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    )
  ) {
    return null;
  }
  const markerSafeHostname = labels.map((label) => (label === "{label}" ? "redacted-label" : label)).join(".");
  const parsed = parseDomain(markerSafeHostname, { allowPrivateDomains: true });
  if (!parsed.isIcann && !parsed.isPrivate) return null;
  if (parsed.domain) {
    const profile = labels.slice(-parsed.domain.split(".").length).join(".");
    return profile.includes("{") ? null : profile;
  }
  return parsed.publicSuffix === markerSafeHostname && !normalized.includes("{")
    ? normalized
    : null;
}

function assertCanonicalAndSocialUrl(html, expectedUrl, label) {
  if (!html.includes(`<link rel="canonical" href="${expectedUrl}"`)) {
    fail(`${label} canonical is missing or does not match ${expectedUrl}`);
  }
  if (metaContent(html, "property", "og:url") !== expectedUrl) {
    fail(`${label} og:url is missing or does not match its canonical`);
  }
  if (html.includes("localhost") || html.includes("127.0.0.1")) {
    fail(`${label} metadata contains a development origin`);
  }
}

function metaContent(html, attribute, value) {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<meta ${attribute}="${escapedValue}" content="([^"]*)"`));
  return match ? decodeHtmlAttribute(match[1]) : null;
}

function sitemapUrlEntry(xml, expectedUrl) {
  const marker = `<loc>${expectedUrl}</loc>`;
  const markerIndex = xml.indexOf(marker);
  if (markerIndex < 0) fail(`sitemap omits ${expectedUrl}`);
  const start = xml.lastIndexOf("<url>", markerIndex);
  const end = xml.indexOf("</url>", markerIndex);
  if (start < 0 || end < 0) fail(`sitemap has a malformed entry for ${expectedUrl}`);
  return xml.slice(start, end + "</url>".length);
}

/** Select the current longest generated description without depending on any retained claim family. */
async function findLongestOgReport(manifest) {
  let longest = { ...manifest.reports[0], descriptionLength: 0 };
  for (const entry of manifest.reports) {
    let html;
    try {
      html = await readFile(path.join(outDir, "reports", entry.id, "index.html"), "utf8");
    } catch {
      continue;
    }
    const match = html.match(/<meta property="og:description" content="([^"]*)"\/>/);
    if (!match) continue;
    const description = decodeHtmlAttribute(match[1]);
    if (description.length > longest.descriptionLength) {
      longest = { ...entry, descriptionLength: description.length };
    }
  }
  return longest;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/**
 * Select a real committed r2 consent report whose lead (accept-all baseline)
 * exercises every new phase surface. Validating the fixture shape here keeps
 * the browser assertions independent of manifest sort order and fails with a
 * useful message if the committed corpus no longer carries the needed proof.
 */
async function findR2PhaseSmokeReport(manifest) {
  for (const entry of manifest.reports) {
    if (entry.reportType !== "comparison" || entry.comparisonType !== "consent") continue;

    let report;
    try {
      report = JSON.parse(await readFile(path.join(outDir, "reports", `${entry.id}.json`), "utf8"));
    } catch {
      continue;
    }
    if (report?.schemaVersion !== 2 || report?.schemaRevision !== 2 || report.reportType !== "comparison") continue;

    const run = report.baseline;
    const phases = Array.isArray(run?.phases) ? run.phases : [];
    const countsByPhase = Array.isArray(run?.summary?.countsByPhase) ? run.summary.countsByPhase : [];
    const requests = Array.isArray(run?.evidence?.requests) ? run.evidence.requests : [];
    const mutations = [
      ...(Array.isArray(run?.evidence?.cookieMutations) ? run.evidence.cookieMutations : []),
      ...(Array.isArray(run?.evidence?.storageMutations) ? run.evidence.storageMutations : [])
    ];
    const hasSparsePhase = phases.some(
      (phase) =>
        (phase?.kind === "post-choice-reload" || phase?.kind === "policy-analysis") &&
        !countsByPhase.some((counts) => counts?.phaseId === phase.phaseId)
    );
    if (
      phases.some((phase) => phase?.phaseId === 0 && phase.kind === "passive-load") &&
      hasSparsePhase &&
      requests.some((request) => request?.phaseId === 0) &&
      mutations.some((mutation) => mutation?.phaseId === 0)
    ) {
      return entry;
    }
  }

  fail("committed corpus has no r2 consent report with phase counts, request labels, and snapshot changes");
}

function createStaticServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405);
        response.end();
        return;
      }

      const filePath = await resolveStaticPath(request.url || "/");
      const bytes = request.method === "HEAD" ? null : await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

async function resolveStaticPath(url) {
  const parsed = new URL(url, "http://127.0.0.1");
  let pathname = decodeURIComponent(parsed.pathname);
  if (basePath && pathname.startsWith(`${basePath}/`)) {
    pathname = pathname.slice(basePath.length);
  } else if (basePath && pathname === basePath) {
    pathname = "/";
  } else if (basePath) {
    throw new Error("request outside base path");
  }

  const normalized = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const candidate = path.join(outDir, normalized);
  if (!isInside(candidate, outDir)) throw new Error("path traversal");

  try {
    const stats = await stat(candidate);
    if (stats.isFile()) return candidate;
    if (stats.isDirectory()) return path.join(candidate, "index.html");
  } catch {
    if (!path.extname(candidate)) return path.join(candidate, "index.html");
  }

  return candidate;
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function expectText(locator, expected) {
  const text = await locator.textContent();
  if (!text || !text.includes(expected)) {
    const excerpt = text && text.length > 1_000 ? `${text.slice(0, 500)} ... ${text.slice(-500)}` : (text ?? "");
    fail(`expected text "${expected}" was not found in ${JSON.stringify(excerpt)}`);
  }
}

async function assertPrimaryLandmarks(page, label) {
  const counts = {
    banner: await page.getByRole("banner").count(),
    main: await page.getByRole("main").count(),
    contentinfo: await page.getByRole("contentinfo").count()
  };
  if (counts.banner !== 1 || counts.main !== 1 || counts.contentinfo !== 1) {
    fail(`${label} landmark count is ${JSON.stringify(counts)}, expected one banner, main, and contentinfo`);
  }
}

async function assertNoSeriousAxeViolations(page, label) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const violations = result.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious"
  );
  if (violations.length > 0) {
    const summary = violations
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.nodes
            .slice(0, 4)
            .map((node) => node.target.join(" "))
            .join(", ")}`
      )
      .join("; ");
    fail(`${label} has serious axe violations: ${summary}`);
  }
  pass(`${label} has no serious axe violations`);
}

async function openHomepageTools(page) {
  const disclosure = page.locator("details.homepage-tools-disclosure");
  if ((await disclosure.count()) !== 1) fail("static home is missing its saved-report tools disclosure");
  if (!(await disclosure.evaluate((element) => element.open))) {
    await disclosure.locator("summary").click();
  }
}

async function loadStaticArchive(page) {
  await openHomepageTools(page);
  const loadButton = page.getByRole("button", { name: "Load saved-report tools", exact: true });
  if ((await loadButton.count()) === 1) await loadButton.click();
  await page.waitForSelector(".static-gallery, .static-gallery-empty", { timeout: 10_000 });
}

async function expectCardCount(page, expected) {
  const actual = await page.locator(".static-report-card").count();
  if (actual !== expected) fail(`expected ${expected} visible report cards, got ${actual}`);
}

async function expectRequestRowCount(page, expected) {
  const actual = await page.locator(".request-table tbody tr").count();
  if (actual !== expected) fail(`expected ${expected} request rows, got ${actual}`);
}

async function assertMinimumTargetSize(locator, minimumCssPixels, label) {
  const targets = await locator.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        text: element.textContent?.replace(/\s+/g, " ").trim() || "(unlabelled)",
        width: bounds.width,
        height: bounds.height
      };
    })
  );
  if (targets.length === 0) fail(`${label} has no rendered targets`);
  const undersized = targets.filter(
    ({ width, height }) => width < minimumCssPixels || height < minimumCssPixels
  );
  if (undersized.length > 0) {
    const details = undersized
      .map(({ text, width, height }) => `${JSON.stringify(text)} ${width.toFixed(1)}x${height.toFixed(1)}`)
      .join(", ");
    fail(`${label} has targets smaller than ${minimumCssPixels}px: ${details}`);
  }
}

async function assertNoHorizontalOverflow(page, label) {
  // Chromium can report a transient min-content width while React commits the
  // archive and the platform's system fonts finish resolving. Measure only
  // after the rendered layout has crossed two animation frames; a persistent
  // overflow still fails with the exact elements that escaped the viewport.
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  const measurement = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    const clientWidth = document.documentElement.clientWidth;
    const overflowing = [...document.querySelectorAll("body *")].filter(
      (element) => element.getBoundingClientRect().right > viewportWidth + 1
    );
    const overflowingSet = new Set(overflowing);
    const describe = (element) => {
      const bounds = element.getBoundingClientRect();
      const className = typeof element.className === "string" ? element.className.trim() : "";
      const text = element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) || "";
      const font = getComputedStyle(element).fontFamily.slice(0, 48);
      // A leaf offender (no overflowing child) is the element actually forcing
      // the width; containers above it merely inherit the damage.
      const leaf = ![...element.children].some((child) => overflowingSet.has(child));
      return {
        element: `${element.tagName.toLowerCase()}${className ? `.${className.split(/\s+/).join(".")}` : ""}`,
        text,
        leaf,
        font,
        left: Math.round(bounds.left * 10) / 10,
        right: Math.round(bounds.right * 10) / 10,
        width: Math.round(bounds.width * 10) / 10
      };
    };
    const leaves = overflowing.filter((element) => ![...element.children].some((child) => overflowingSet.has(child)));
    const offenders = [...new Set([...leaves, ...overflowing])].slice(0, 6).map(describe);
    // Ancestor chain of the first leaf: an offender wider than every ancestor
    // implicates a sizing rule (or transform) between it and the page shell.
    const ancestry = [];
    for (let node = leaves[0]?.parentElement; node && node !== document.documentElement && ancestry.length < 8; node = node.parentElement) {
      const bounds = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const className = typeof node.className === "string" && node.className.trim()
        ? `.${node.className.trim().split(/\s+/).join(".")}`
        : "";
      ancestry.push(
        `${node.tagName.toLowerCase()}${className} w=${Math.round(bounds.width * 10) / 10} ` +
          `pad=${style.paddingLeft}/${style.paddingRight} disp=${style.display} cols=${style.gridTemplateColumns.slice(0, 40)}`
      );
    }
    // Layout-context probes: whether the mobile collapse actually applied,
    // and whether every stylesheet is present and readable when it did not.
    const workbench = document.querySelector(".scan-workbench");
    const workbenchColumns = workbench ? getComputedStyle(workbench).gridTemplateColumns : "absent";
    const narrowMediaMatches = matchMedia("(max-width: 1100px)").matches;
    let ruleCount = 0;
    let unreadableSheets = 0;
    for (const sheet of document.styleSheets) {
      try {
        ruleCount += sheet.cssRules.length;
      } catch {
        unreadableSheets += 1;
      }
    }
    return {
      viewportWidth,
      scrollWidth,
      clientWidth,
      dpr: window.devicePixelRatio,
      offenders,
      ancestry,
      workbenchColumns,
      narrowMediaMatches,
      sheets: document.styleSheets.length,
      ruleCount,
      unreadableSheets
    };
  });

  if (measurement.scrollWidth <= measurement.viewportWidth + 1) return;
  const details = measurement.offenders
    .map(({ element, text, leaf, font, left, right, width }) =>
      `${leaf ? "LEAF " : ""}${element}${text ? ` text=${JSON.stringify(text)}` : ""}` +
      ` font=${JSON.stringify(font)} left=${left} right=${right} width=${width}`
    )
    .join("; ");
  fail(
    `${label} has page-level horizontal overflow ` +
      `(viewport=${measurement.viewportWidth}, client=${measurement.clientWidth}, ` +
      `scroll=${measurement.scrollWidth}, dpr=${measurement.dpr}, ` +
      `workbench=${JSON.stringify(measurement.workbenchColumns)}, mq1100=${measurement.narrowMediaMatches}, ` +
      `sheets=${measurement.sheets}, rules=${measurement.ruleCount}, unreadable=${measurement.unreadableSheets}` +
      `${details ? `; ${details}` : ""}; ancestry: ${measurement.ancestry.join(" | ")})`
  );
}

function searchableReportText(report) {
  return `${report.title} ${report.domain} ${report.requestedUrl}`.toLowerCase();
}

function contentType(filePath) {
  const basename = path.basename(filePath);
  if (basename === "opengraph-image" || basename === "twitter-image") return "image/png";
  const extension = path.extname(filePath);
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".txt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function normalizeBasePath(value) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

function inferredGithubPagesBasePath() {
  const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (!repository || repository.endsWith(".github.io")) return "";
  return `/${repository}`;
}

function expectedBuildCommit() {
  return resolveExactStaticDeploymentCommit({ cwd: rootDir });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  // Surface the failing check as a checks-API annotation so a red required
  // gate is diagnosable from the public run summary, not only from
  // authenticated log access.
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Static export smoke failed::${message}`);
  }
  process.exit(1);
});
