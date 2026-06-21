import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
const scanAccessToken = process.env.SMOKE_SCAN_ACCESS_TOKEN || process.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN || "";
const scanReportSchemaVersion = 1;

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function postScan(body) {
  const headers = { "content-type": "application/json" };
  if (scanAccessToken) headers["x-site-behavior-lab-access-token"] = scanAccessToken;

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    fail(`/api/scan returned ${response.status} with non-JSON content`);
  }

  return response.json();
}

async function postRawScan(body) {
  const headers = { "content-type": "application/json" };
  if (scanAccessToken) headers["x-site-behavior-lab-access-token"] = scanAccessToken;

  const response = await fetch(`${baseUrl}/api/scan`, {
    method: "POST",
    headers,
    body
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    fail(`/api/scan returned ${response.status} with non-JSON content`);
  }

  return response.json();
}

async function apiChecks() {
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  if (!health.ok || !health.checks?.reportStore || !Array.isArray(health.warnings)) {
    fail("health endpoint did not return runtime status");
  }
  pass("API exposes runtime health status");

  const clean = await postScan({
    url: "https://example.com/?token=smoke-secret#frag",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  if (!clean.ok || clean.summary.status !== 200 || clean.summary.totalRequests < 1) {
    fail("clean page scan did not produce a successful report");
  }
  if (clean.schemaVersion !== scanReportSchemaVersion) {
    fail("clean page scan did not include the current report schema version");
  }
  if (!clean.conditions.chromiumVersion || clean.conditions.timezone !== "UTC" || clean.conditions.locale !== "en-US") {
    fail("scan report did not include deterministic browser conditions");
  }
  if (!clean.conditions.scannerEgress || !clean.conditions.scannerDisclosure.includes(clean.conditions.scannerEgress)) {
    fail("scan report did not include scanner egress metadata");
  }
  if (JSON.stringify(clean).includes("smoke-secret")) {
    fail("scan report leaked a query string secret");
  }
  if (!clean.share?.path?.startsWith("/reports/") || !clean.share?.jsonPath?.startsWith("/api/reports/")) {
    fail("scan report did not include share metadata");
  }
  const savedClean = await fetch(`${baseUrl}${clean.share.jsonPath}`).then((response) => response.json());
  if (!savedClean.ok || savedClean.share.id !== clean.share.id) {
    fail("saved report JSON endpoint did not return the scan report");
  }
  if (savedClean.schemaVersion !== scanReportSchemaVersion) {
    fail("saved report JSON did not include the current report schema version");
  }
  if (savedClean.screenshot !== null) {
    fail("saved report JSON retained an inline screenshot");
  }
  pass("API scans a clean page");

  const comparison = await postScan({
    url: "https://example.com",
    device: "desktop",
    compareGpc: true,
    consentMode: "observe"
  });
  if (
    !comparison.ok ||
    comparison.reportType !== "comparison" ||
    comparison.baseline.conditions.gpcEnabled !== false ||
    comparison.variant.conditions.gpcEnabled !== true ||
    comparison.schemaVersion !== scanReportSchemaVersion ||
    comparison.baseline.schemaVersion !== scanReportSchemaVersion ||
    comparison.variant.schemaVersion !== scanReportSchemaVersion ||
    !comparison.diff.thirdPartyCookies ||
    !comparison.share?.path?.startsWith("/reports/")
  ) {
    fail("GPC comparison scan did not produce a saved off/on report");
  }
  const savedComparison = await fetch(`${baseUrl}${comparison.share.jsonPath}`).then((response) => response.json());
  if (savedComparison.baseline?.screenshot !== null || savedComparison.variant?.screenshot !== null) {
    fail("saved comparison JSON retained inline screenshots");
  }
  pass("API runs a GPC comparison");

  const privateTarget = await postScan({
    url: "http://127.0.0.1:3000",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  if (privateTarget.ok || !privateTarget.error.includes("Local and private")) {
    fail("private localhost target was not blocked");
  }
  pass("API blocks localhost/private targets");

  const fileUrl = await postScan({
    url: "file:///etc/passwd",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  if (fileUrl.ok || !fileUrl.error.includes("Only HTTP and HTTPS")) {
    fail("unsupported protocol was not rejected correctly");
  }
  pass("API rejects non-HTTP protocols");

  const customPort = await postScan({
    url: "https://example.com:8443",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe"
  });
  if (customPort.ok || !customPort.error.includes("standard HTTP and HTTPS ports")) {
    fail("custom port was not rejected correctly");
  }
  pass("API rejects custom ports");

  const malformedJson = await postRawScan("{");
  if (malformedJson.ok || malformedJson.error !== "Request body must be valid JSON.") {
    fail("malformed JSON did not get a sanitized client error");
  }
  pass("API rejects malformed JSON cleanly");
}

async function uiChecks() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await expectText(page.locator("h1"), "See what a site does, not just what it says.");
    pass("home page renders tagline");

    if (scanAccessToken) {
      await openOptions(page);
      await page.getByLabel("Scanner access key").fill(scanAccessToken);
    }

    await page.fill("#url", "https://example.com");
    await page.getByRole("button", { name: "Scan", exact: true }).click();
    await waitForReportOrError(page, 30_000);
    await expectText(page.locator(".report-header"), "Example Domain");
    await expectText(page.locator(".warnings"), "one automated, headless Chromium visit");
    await expectText(page.locator(".methodology"), "Browser");
    await expectText(page.locator(".methodology"), "UTC");
    pass("desktop UI renders scan report");

    await openOptions(page);
    await page.getByRole("button", { name: "GPC diff" }).click();
    await page.getByRole("button", { name: "Compare" }).click();
    await page.waitForSelector(".comparison-card", { timeout: 30_000 });
    await expectText(page.locator(".comparison-card"), "Third-party cookies");
    pass("desktop UI renders GPC comparison");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 5_000 }),
      page.getByRole("button", { name: "JSON" }).click()
    ]);
    if (download.suggestedFilename() !== "site-behavior-lab-example.com.json") {
      fail("JSON export filename was unexpected");
    }
    pass("JSON export starts download");

    const shareHref = await page.getByRole("link", { name: "Share" }).getAttribute("href");
    if (!shareHref || !shareHref.startsWith("/reports/")) {
      fail("share permalink was not rendered");
    }
    await page.goto(`${baseUrl}${shareHref}`, { waitUntil: "networkidle" });
    await waitForReportOrError(page, 30_000);
    await expectText(page.locator(".report-header"), "GPC off/on comparison");
    await expectText(page.locator(".report-header"), "https://example.com/");
    pass("share permalink renders saved report");

    await page.fill("#url", "http://127.0.0.1:3000");
    await page.getByRole("button", { name: "Scan", exact: true }).click();
    await page.waitForSelector(".error-banner", { timeout: 10_000 });
    await expectText(page.locator(".error-banner"), "The scanner only visits public web pages");
    pass("UI shows private-target error");

    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    if (scanAccessToken) {
      await openOptions(page);
      await page.getByLabel("Scanner access key").fill(scanAccessToken);
    }
    const homeOverflow = await hasHorizontalOverflow(page);
    if (homeOverflow) fail("mobile home layout has page-level horizontal overflow");
    pass("mobile home layout fits viewport");

    await page.fill("#url", "https://example.com");
    await page.getByRole("button", { name: "Scan", exact: true }).click();
    await page.waitForSelector(".report-grid", { timeout: 20_000 });
    const reportOverflow = await hasHorizontalOverflow(page);
    if (reportOverflow) fail("mobile report has page-level horizontal overflow");
    pass("mobile report layout fits viewport");
  } finally {
    await browser.close();
  }
}

async function openOptions(page) {
  const options = page.locator("details.options-disclosure");
  if ((await options.count()) === 0) return;

  const isOpen = await options.evaluate((node) => node.open);
  if (!isOpen) {
    await options.locator("summary").click();
  }
}

async function waitForReportOrError(page, timeout) {
  const state = await Promise.race([
    page.waitForSelector(".report-grid", { timeout }).then(() => "report"),
    page.waitForSelector(".error-banner", { timeout }).then(() => "error")
  ]);

  if (state === "error") {
    const errorText = await page.locator(".error-banner").innerText();
    fail(`report did not render: ${errorText}`);
  }
}

async function expectText(locator, expected) {
  const text = await locator.textContent();
  if (!text || !text.includes(expected)) {
    fail(`expected text "${expected}" was not found`);
  }
}

async function hasHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

await apiChecks();
await uiChecks();
console.log("Site Behavior Lab smoke tests passed.");
