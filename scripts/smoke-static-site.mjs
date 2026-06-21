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

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  throw new Error(message);
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

    if (liveScanApiBase) {
      await expectText(page.locator(".status-pill"), "Live");
      await expectText(page.locator(".scan-panel"), "Public scanner");
      const optionsOpen = await page.locator(".options-disclosure").evaluate((element) => element.hasAttribute("open"));
      if (!optionsOpen) await page.getByText("Options").click();
      if (!(await page.locator(".segmented-control button", { hasText: "GPC diff" }).isEnabled())) {
        fail("production Cloudflare scanner should enable GPC comparison");
      }
      if (await page.locator(".segmented-control button", { hasText: "Shields" }).isEnabled()) {
        fail("Cloudflare scanner should leave Shields comparison disabled until block simulation is available");
      }
      const accessFields = await page.getByLabel("Scanner access key").count();
      if (openAccessScanner && accessFields !== 0) {
        fail("open Cloudflare scanner should not show a scanner access key field");
      }
      pass(openAccessScanner ? "static home renders open live scanner" : "static home renders gated live scanner");
    }

    const cardCount = await page.locator(".static-report-card").count();
    if (cardCount !== manifest.reports.length) {
      fail(`static archive rendered ${cardCount} report cards for ${manifest.reports.length} manifest entries`);
    }
    pass("static archive renders every manifest report");

    const firstReport = manifest.reports[0];
    await page.getByLabel("Search reports").fill(firstReport.domain);
    const matchingDomainCount = manifest.reports.filter((report) => searchableReportText(report).includes(firstReport.domain.toLowerCase())).length;
    await expectCardCount(page, matchingDomainCount);
    pass("static archive search filters reports");

    await page.getByLabel("Report type").selectOption("comparison");
    const matchingComparisonCount = manifest.reports.filter(
      (report) => report.reportType === "comparison" && searchableReportText(report).includes(firstReport.domain.toLowerCase())
    ).length;
    await expectCardCount(page, matchingComparisonCount);
    pass("static archive type filter combines with search");

    await page.getByLabel("Search reports").fill("");
    await page.getByLabel("Report type").selectOption("all");
    await page.getByLabel("Sort reports").selectOption("thirdParty");
    await expectCardCount(page, manifest.reports.length);
    pass("static archive sort keeps report list stable");

    const singleReport = manifest.reports.find((report) => report.reportType === "single");
    if (!singleReport) fail("static archive needs at least one single report for UI smoke coverage");

    const singleReportFile = path.join(outDir, "reports", `${singleReport.id}.json`);
    await page.locator(".static-compare-upload input").nth(0).setInputFiles(singleReportFile);
    await page.locator(".static-compare-upload input").nth(1).setInputFiles(singleReportFile);
    await page.getByRole("button", { name: "Compare files" }).click();
    await page.waitForSelector(".comparison-card", { timeout: 10_000 });
    await expectText(page.locator(".comparison-card"), "Temporal Comparison");
    pass("static archive compares uploaded reports");

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.locator(".static-report-card").first().click();
    await page.waitForSelector(".report-header", { timeout: 10_000 });
    await expectText(page.locator(".report-header"), "https://");
    pass("static report permalink renders saved report");

    await page.goto(`${baseUrl}/reports/${singleReport.id}/`, { waitUntil: "networkidle" });
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
