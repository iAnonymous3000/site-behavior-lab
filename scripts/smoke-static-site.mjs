#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
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
const maxReportHtmlBytes = 4 * 1024 * 1024;
const fullCommitPattern = /^[0-9a-f]{40}$/;
const corpusJsonDecisionFields = [
  "consentChoiceState",
  "variantConsentChoiceState",
  "comparisonDecisionMode",
  "compatibilityFingerprintOrigin",
  "compatibilityFingerprintMatched"
];
const corpusCsvDecisionColumns = [
  "consent_choice_state",
  "variant_consent_choice_state",
  "comparison_decision_mode",
  "compatibility_fingerprint_origin",
  "compatibility_fingerprint_matched"
];
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
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/health`, { cache: "no-store" });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.capabilities?.shieldsComparison === true;
  } catch {
    return false;
  }
}

async function scannerAdvertisesScheduledRescans(apiBase) {
  if (!apiBase) return false;
  try {
    const response = await fetch(`${apiBase.replace(/\/+$/, "")}/api/health`, { cache: "no-store" });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.capabilities?.scheduledRescans === true;
  } catch {
    return false;
  }
}

async function main() {
  const manifest = await readManifest();
  const phaseReport = await findR2PhaseSmokeReport(manifest);
  const server = createStaticServer();
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") fail("static smoke server did not bind to a port");

  const baseUrl = `http://127.0.0.1:${address.port}${basePath || ""}`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await expectText(page.locator("h1"), "See what a site does, not just what it says.");
    await expectText(page.locator(".static-gallery"), "Saved reports");
    pass("static home renders archive shell");

    // Both immutable ScanReport v2 revisions publish independently; the
    // stable alias serves the current r2 revision (RFC 10.3/14.11).
    const revisionedResponse = await fetch(`${baseUrl}/schemas/scan-report.v2.r1.schema.json`);
    if (!revisionedResponse.ok) fail(`revisioned schema not served (${revisionedResponse.status})`);
    const revisionedSchema = await revisionedResponse.json();
    if (revisionedSchema.$id !== "https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json") {
      fail("revisioned schema has the wrong $id");
    }
    const aliasResponse = await fetch(`${baseUrl}/scan-report.schema.json`);
    if (!aliasResponse.ok) fail(`stable schema alias not served (${aliasResponse.status})`);
    const aliasSchema = await aliasResponse.json();
    const r2Response = await fetch(`${baseUrl}/schemas/scan-report.v2.r2.schema.json`);
    if (!r2Response.ok) fail(`r2 revisioned schema not served (${r2Response.status})`);
    const r2Schema = await r2Response.json();
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

    const deploymentResponse = await fetch(`${baseUrl}/deployment.json`);
    if (!deploymentResponse.ok) fail(`static deployment provenance not served (${deploymentResponse.status})`);
    const deployment = await deploymentResponse.json();
    if (deployment?.schemaVersion !== 1 || !fullCommitPattern.test(deployment?.deployment)) {
      fail("static deployment provenance does not contain a full source commit");
    }
    const expectedDeployment = expectedBuildCommit();
    if (expectedDeployment && deployment.deployment !== expectedDeployment) {
      fail(`static deployment provenance is ${deployment.deployment}, expected ${expectedDeployment}`);
    }
    pass(`static deployment provenance identifies ${deployment.deployment}`);

    const corpusJsonResponse = await fetch(`${baseUrl}/corpus.json`);
    if (!corpusJsonResponse.ok) fail(`researcher JSON export not served (${corpusJsonResponse.status})`);
    const corpus = await corpusJsonResponse.json();
    if (!Array.isArray(corpus?.reports) || corpus.reportCount !== corpus.reports.length) {
      fail("researcher JSON export does not contain its declared report rows");
    }
    const phaseReportExportRow = corpus.reports.find((report) => report?.id === phaseReport.id);
    if (!phaseReportExportRow) fail("researcher JSON export omits the committed r2 phase smoke report");
    for (const field of corpusJsonDecisionFields) {
      if (!Object.prototype.hasOwnProperty.call(phaseReportExportRow, field)) {
        fail(`researcher JSON export omits ${field}`);
      }
    }
    if (
      !recordedConsentChoiceStates.includes(phaseReportExportRow.consentChoiceState) ||
      !recordedConsentChoiceStates.includes(phaseReportExportRow.variantConsentChoiceState) ||
      !["comparable", "raw-only"].includes(phaseReportExportRow.comparisonDecisionMode) ||
      phaseReportExportRow.compatibilityFingerprintOrigin !== "recorded" ||
      typeof phaseReportExportRow.compatibilityFingerprintMatched !== "boolean"
    ) {
      fail("researcher JSON export flattened the committed r2 comparison metadata incorrectly");
    }

    const corpusCsvResponse = await fetch(`${baseUrl}/corpus.csv`);
    if (!corpusCsvResponse.ok) fail(`researcher CSV export not served (${corpusCsvResponse.status})`);
    const corpusCsvHeader = (await corpusCsvResponse.text()).split(/\r?\n/, 1)[0].split(",");
    const legacyTailIndex = corpusCsvHeader.indexOf("limited");
    if (
      legacyTailIndex < 0 ||
      corpusCsvHeader.slice(legacyTailIndex + 1).join(",") !== corpusCsvDecisionColumns.join(",")
    ) {
      fail("researcher CSV export did not append the five decision-context columns after the legacy contract");
    }
    pass("researcher exports publish the appended r2 decision context in JSON and CSV");

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
      await expectText(page.locator(".scheduled-rescan-panel"), "maximum of 5 scheduled attempts");
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

    const cardCount = await page.locator(".static-report-card").count();
    if (cardCount !== Math.min(archivePageSize, manifest.reports.length)) {
      fail(`static archive rendered ${cardCount} initial report cards for ${manifest.reports.length} manifest entries`);
    }
    pass("static archive bounds its initial DOM");

    const firstReport = manifest.reports[0];
    if (typeof firstReport.headline !== "string" || !firstReport.headline) fail("manifest report lacks its canonical headline");
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
    await page.getByRole("button", { name: "Compare files" }).click();
    await expectText(page.locator(".static-compare-panel"), "cannot order a before/after pair");
    pass("static archive refuses an unorderable upload pair");

    await page.locator(".static-compare-upload input").nth(0).setInputFiles(rescanReportFixture);
    await page.locator(".static-compare-upload input").nth(1).setInputFiles(singleReportFixture);
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
    await expectText(cookieDelta, "3 → 5");
    const storageDelta = page.locator(".delta-tile", { hasText: "Storage keys" });
    await expectText(storageDelta, "+1");
    await expectText(storageDelta, "3 → 4");
    if ((await comparisonCard.innerHTML()).includes("[redacted")) {
      fail("comparison card exposes a privacy marker as an exact name");
    }
    pass("static archive compares uploaded reports");

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.locator(".static-report-card").first().click();
    await page.waitForSelector(".report-header", { timeout: 10_000 });
    await expectText(page.locator(".report-header"), "https://");
    if ((await page.locator(".scan-workbench").count()) !== 0) fail("saved report permalink must not put the scanner before evidence");
    await expectText(page.locator("h1"), firstReport.headline);

    const reportHtmlPath = path.join(outDir, "reports", firstReport.id, "index.html");
    const reportHtml = await readFile(reportHtmlPath, "utf8");
    if (!reportHtml.includes("report-page-shell") || !reportHtml.includes(firstReport.headline)) {
      fail("saved report evidence is absent from the generated initial HTML");
    }
    if (reportHtml.includes("scan-workbench")) fail("generated report HTML contains the scanner workbench");
    if (Buffer.byteLength(reportHtml, "utf8") > maxReportHtmlBytes) {
      fail(`saved report HTML exceeds the ${maxReportHtmlBytes}-byte evidence-page budget`);
    }
    const noScriptContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } });
    const noScriptPage = await noScriptContext.newPage();
    await noScriptPage.goto(`${baseUrl}/reports/${firstReport.id}/`, { waitUntil: "domcontentloaded" });
    await expectText(noScriptPage.locator(".report-header"), "https://");
    await expectText(noScriptPage.locator("h1"), firstReport.headline);

    const phaseReportHtmlPath = path.join(outDir, "reports", phaseReport.id, "index.html");
    const phaseReportHtml = await readFile(phaseReportHtmlPath, "utf8");
    if (!phaseReportHtml.includes("visit-phase-evidence")) {
      fail("generated r2 report HTML omits the recorded phase evidence section");
    }
    await noScriptPage.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "domcontentloaded" });
    await expectText(noScriptPage.locator(".visit-phase-evidence"), "Visit phases & state changes");
    await noScriptContext.close();
    pass("static report permalink ships bounded evidence in initial HTML without JavaScript");

    await page.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "networkidle" });
    const phaseEvidence = page.locator(".visit-phase-evidence");
    await expectText(phaseEvidence, "Visit phases & state changes");
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

    const profileKey = firstReport.domain.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
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
    const reportUploadLabel = page.locator("label.file-button", { hasText: "Open report file" }).first();
    const reportUploadInput = reportUploadLabel.locator('input[type="file"]');
    await reportUploadInput.evaluate((input) => input.focus());
    const uploadFocusShadow = await reportUploadLabel.evaluate((label) => getComputedStyle(label).boxShadow);
    if (uploadFocusShadow === "none") fail("file upload button has no visible keyboard focus treatment");
    pass("file upload button exposes visible keyboard focus");
    await reportUploadInput.setInputFiles(singleReportFixture);
    await page.waitForSelector(".report-header", { timeout: 10_000 });
    await expectText(page.locator(".party-legend"), "Other third-party");
    const domainTableRegion = page.getByRole("region", { name: "Domain evidence table" });
    if ((await domainTableRegion.getAttribute("tabindex")) !== "0") {
      fail("domain evidence horizontal scroller is not keyboard-focusable");
    }
    await domainTableRegion.focus();
    const tableFocusShadow = await domainTableRegion.evaluate((region) => getComputedStyle(region).boxShadow);
    if (tableFocusShadow === "none") fail("evidence table scroller has no visible keyboard focus treatment");
    pass("report labels traffic remainder accurately and exposes a focusable evidence scroller");
    if ((await page.locator(".visit-phase-evidence").count()) !== 0) {
      fail("legacy v1 upload rendered v2-only phase evidence");
    }
    if (
      (await page.getByRole("link", { name: "Share", exact: true }).count()) !== 0 ||
      (await page.getByRole("button", { name: "Copy share link", exact: true }).count()) !== 0
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
    await expectText(cookieCard, "_octo");
    await expectText(cookieCard, "Cookie 2 · name hidden for privacy");
    await expectText(cookieCard, "Cookie 3 · name hidden for privacy");
    await expectText(cookieCard, "2 cookie names hidden");
    await expectText(storageCard, "soft-nav:marker");
    await expectText(storageCard, "Storage key 2 · name hidden for privacy");
    await expectText(storageCard, "Storage key 3 · name hidden for privacy");
    await expectText(storageCard, "2 storage keys hidden");
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
    await page.getByRole("button", { name: "Known services" }).click();
    await expectRequestRowCount(page, 1);
    await page.getByLabel("Resource type").selectOption("script");
    await expectRequestRowCount(page, 0);
    pass("static report request filters narrow rows");

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".static-report-card", { timeout: 10_000 });
    await assertNoHorizontalOverflow(page, "static mobile archive");
    pass("static mobile archive fits viewport");
    await page.goto(`${baseUrl}/sites/${encodeURIComponent(profileKey)}/`, { waitUntil: "networkidle" });
    await assertNoHorizontalOverflow(page, "static mobile site profile");
    pass("static mobile site profile fits viewport");
    await page.goto(`${baseUrl}/reports/${phaseReport.id}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".visit-phase-evidence", { timeout: 10_000 });
    await assertNoHorizontalOverflow(page, "static mobile r2 report");
    pass("static mobile r2 phase report fits viewport");

    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.waitForSelector(".static-report-card", { timeout: 10_000 });
    await assertNoHorizontalOverflow(page, "static narrow-mobile archive");
    pass("static archive fits a 320px viewport");
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
    fail(`expected text "${expected}" was not found`);
  }
}

async function expectCardCount(page, expected) {
  const actual = await page.locator(".static-report-card").count();
  if (actual !== expected) fail(`expected ${expected} visible report cards, got ${actual}`);
}

async function expectRequestRowCount(page, expected) {
  const actual = await page.locator(".request-table tbody tr").count();
  if (actual !== expected) fail(`expected ${expected} request rows, got ${actual}`);
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
    const offenders = [...document.querySelectorAll("body *")]
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        const className = typeof element.className === "string" ? element.className.trim() : "";
        return {
          element: `${element.tagName.toLowerCase()}${className ? `.${className.split(/\s+/).join(".")}` : ""}`,
          left: Math.round(bounds.left * 10) / 10,
          right: Math.round(bounds.right * 10) / 10,
          width: Math.round(bounds.width * 10) / 10
        };
      })
      .filter(({ right }) => right > viewportWidth + 1)
      .sort((left, right) => right.right - left.right)
      .slice(0, 5);
    return { viewportWidth, scrollWidth, offenders };
  });

  if (measurement.scrollWidth <= measurement.viewportWidth + 1) return;
  const details = measurement.offenders
    .map(({ element, left, right, width }) => `${element} left=${left} right=${right} width=${width}`)
    .join("; ");
  fail(
    `${label} has page-level horizontal overflow ` +
      `(viewport=${measurement.viewportWidth}, scroll=${measurement.scrollWidth}${details ? `; ${details}` : ""})`
  );
}

function searchableReportText(report) {
  return `${report.title} ${report.domain} ${report.requestedUrl}`.toLowerCase();
}

function contentType(filePath) {
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
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
