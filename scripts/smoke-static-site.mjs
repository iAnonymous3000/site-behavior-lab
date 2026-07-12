#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

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

async function main() {
  const manifest = await readManifest();
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

    // The published ScanReport v2 schema: the immutable revisioned file and
    // its stable alias must both serve and agree (scan-report-v2-rfc.md 10.3).
    const revisionedResponse = await fetch(`${baseUrl}/schemas/scan-report.v2.r1.schema.json`);
    if (!revisionedResponse.ok) fail(`revisioned schema not served (${revisionedResponse.status})`);
    const revisionedSchema = await revisionedResponse.json();
    if (revisionedSchema.$id !== "https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json") {
      fail("revisioned schema has the wrong $id");
    }
    const aliasResponse = await fetch(`${baseUrl}/scan-report.schema.json`);
    if (!aliasResponse.ok) fail(`stable schema alias not served (${aliasResponse.status})`);
    const aliasSchema = await aliasResponse.json();
    if (JSON.stringify(aliasSchema) !== JSON.stringify(revisionedSchema)) {
      fail("stable schema alias does not match the current revision");
    }
    const r2Response = await fetch(`${baseUrl}/schemas/scan-report.v2.r2.schema.json`);
    if (!r2Response.ok) fail(`r2 revisioned schema not served (${r2Response.status})`);
    const r2Schema = await r2Response.json();
    if (r2Schema.$id !== "https://sitebehavior.org/schemas/scan-report.v2.r2.schema.json") {
      fail("r2 revisioned schema has the wrong $id");
    }
    // The stable alias must STILL serve r1 (RFC 14.9: it moves only after
    // complete dual-read consumer migration).
    if (JSON.stringify(aliasSchema) === JSON.stringify(r2Schema)) {
      fail("the stable alias must not serve r2 before consumer migration completes");
    }
    pass("scan-report v2 schemas published (r1 + r2 revisioned files, stable alias on r1)");

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
    await expectText(page.locator(".comparison-card"), "Temporal Comparison");
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
    await noScriptContext.close();
    pass("static report permalink ships bounded evidence in initial HTML without JavaScript");

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
    await page
      .locator("label.file-button", { hasText: "Open report file" })
      .first()
      .locator('input[type="file"]')
      .setInputFiles(singleReportFixture);
    await page.waitForSelector(".report-header", { timeout: 10_000 });
    await page.locator("details.data-section", { hasText: "Request log" }).locator("summary").click();
    await page.getByRole("button", { name: "Third-party" }).click();
    await expectRequestRowCount(page, 2);
    await page.getByRole("button", { name: "Known services" }).click();
    await expectRequestRowCount(page, 1);
    await page.getByLabel("Resource type").selectOption("script");
    await expectRequestRowCount(page, 0);
    pass("static report request filters narrow rows");

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    if (await hasHorizontalOverflow(page)) fail("static mobile archive has page-level horizontal overflow");
    pass("static mobile archive fits viewport");
    await page.goto(`${baseUrl}/sites/${encodeURIComponent(profileKey)}/`, { waitUntil: "networkidle" });
    if (await hasHorizontalOverflow(page)) fail("static mobile site profile has page-level horizontal overflow");
    pass("static mobile site profile fits viewport");
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

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
