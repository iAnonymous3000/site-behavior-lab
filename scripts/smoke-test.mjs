import { chromium } from "playwright";
import playwrightPackage from "playwright/package.json" with { type: "json" };
import {
  readResponseJsonWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";
const scanAccessToken = process.env.SMOKE_SCAN_ACCESS_TOKEN || process.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN || "";
const scanReportSchemaVersion = 1;
const scanOperationTimeoutMs = 5 * 60_000;
const controlOperationTimeoutMs = 30_000;
const jsonResponseMaxBytes = 32 * 1024 * 1024;

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function postScan(body) {
  const headers = { "content-type": "application/json" };
  if (scanAccessToken) headers["x-site-behavior-lab-access-token"] = scanAccessToken;

  const { value } = await requestJson(
    `${baseUrl}/api/scan`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    },
    "/api/scan",
    scanOperationTimeoutMs
  );
  return value;
}

async function postRawScan(body) {
  const headers = { "content-type": "application/json" };
  if (scanAccessToken) headers["x-site-behavior-lab-access-token"] = scanAccessToken;

  const { value } = await requestJson(
    `${baseUrl}/api/scan`,
    {
      method: "POST",
      headers,
      body
    },
    "/api/scan",
    scanOperationTimeoutMs
  );
  return value;
}

async function requestJson(url, init, label, timeoutMs = controlOperationTimeoutMs) {
  return withHttpOperationDeadline(
    { timeoutMs, label },
    async (signal) => {
      const response = await fetch(url, { ...init, redirect: "error", signal });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        fail(`${label} returned ${response.status} with non-JSON content`);
      }
      try {
        const value = await readResponseJsonWithinLimit(response, {
          maxBytes: jsonResponseMaxBytes,
          label
        });
        return { response, value };
      } catch (error) {
        if (error instanceof RangeError) fail(error.message);
        if (error instanceof SyntaxError) fail(`${label} returned malformed JSON`);
        throw error;
      }
    }
  );
}

async function apiChecks() {
  const { value: health } = await requestJson(`${baseUrl}/api/health`, {}, "/api/health");
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
    fail(`clean page scan did not produce a successful report: ${smokeResponseSummary(clean)}`);
  }
  if (clean.schemaVersion !== scanReportSchemaVersion) {
    fail("clean page scan did not include the current report schema version");
  }
  if (!clean.conditions.chromiumVersion || clean.conditions.timezone !== "UTC" || clean.conditions.locale !== "en-US") {
    fail("scan report did not include deterministic browser conditions");
  }
  if (!clean.conditions.scannerEgress || !clean.conditions.scannerDisclosure.includes(clean.conditions.scannerEgress)) {
    fail(
      `scan report did not include scanner egress metadata: ${JSON.stringify({
        scannerEgress: clean.conditions.scannerEgress,
        scannerDisclosure: clean.conditions.scannerDisclosure
      })}`
    );
  }
  if (JSON.stringify(clean).includes("smoke-secret")) {
    fail("scan report leaked a query string secret");
  }
  if (!clean.share?.path?.startsWith("/reports/") || !clean.share?.jsonPath?.startsWith("/api/reports/")) {
    fail("scan report did not include share metadata");
  }
  const { value: savedClean } = await requestJson(
    `${baseUrl}${clean.share.jsonPath}`,
    {},
    clean.share.jsonPath
  );
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
  const { value: savedComparison } = await requestJson(
    `${baseUrl}${comparison.share.jsonPath}`,
    {},
    comparison.share.jsonPath
  );
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

  await inspectionApiChecks(health);
  await scrollCheckApiChecks(health);
}

const scrollCheckSingleOnlyRefusal = "A check after scrolling runs on a single scan only.";
const scrollCheckUnknownRefusal = "The only check a scan can ask for is the after-scrolling check.";
const scrollCheckV1Refusal = "This deployment's scanner cannot carry an after-scrolling check.";

/**
 * A check request the gate refuses never visits anything: one beside a
 * comparison or an inspection, and any value but "scroll", are refused before
 * quota or DNS, and a scanner that writes version 1 reports refuses even a
 * well-formed one with its own sentence. Nothing here scans. A scanner whose
 * health says it writes r2 reports would run a real visit, about a minute
 * long, for a well-formed check, so that request is not sent; the in-process
 * fixture test runs one end to end instead (lib/scroll-check-fixture.test.ts).
 */
async function scrollCheckApiChecks(health) {
  const base = { url: "https://example.com/", device: "desktop", gpcEnabled: false, consentMode: "observe" };
  for (const [label, body, message] of [
    ["beside a comparison", { ...base, compareGpc: true, check: "scroll" }, scrollCheckSingleOnlyRefusal],
    ["beside an inspection", { ...base, inspect: "https://cdn.example.net/{seg}", check: "scroll" }, scrollCheckSingleOnlyRefusal],
    ["of another kind", { ...base, check: "zoom" }, scrollCheckUnknownRefusal]
  ]) {
    const refused = await postScan(body);
    if (refused.ok || refused.error !== message || refused.cause !== "request-rejected") {
      fail(`a check ${label} was not refused before any visit: ${smokeResponseSummary(refused)}`);
    }
  }
  const producer = health.checks?.publicR2Reports?.status;
  if (producer === "disabled") {
    const refused = await postScan({ ...base, check: "scroll" });
    if (refused.ok || refused.error !== scrollCheckV1Refusal || refused.cause !== undefined) {
      fail(`a version 1 scanner did not refuse a check with its sentence: ${smokeResponseSummary(refused)}`);
    }
    pass("API refuses malformed checks, and a version 1 scanner refuses every check, before any visit");
  } else {
    pass(`API refuses malformed checks before any visit (producer ${producer}: a well-formed check would visit, so none is sent)`);
  }
}

const inspectionRequestMessage =
  "An inspection must name one address exactly as a report publishes it, query dropped, on a single scan.";
const inspectionV1Refusal =
  "Inspecting a connection needs a scanner that writes revision 2 reports, and this one writes version 1 reports, so no visit was made.";

/**
 * An inspection request the gate refuses never visits anything: a value that
 * is not a published address, or one beside a comparison, is refused before
 * quota or DNS, and a scanner that writes version 1 reports refuses even a
 * well-formed one with its own sentence. Nothing here scans. A scanner whose
 * health says it writes r2 reports would run a real visit for a well-formed
 * inspection, so that request is not sent; the in-process fixture test runs
 * one end to end instead (lib/connection-inspection-fixture.test.ts).
 */
async function inspectionApiChecks(health) {
  const base = { url: "https://example.com/", device: "desktop", gpcEnabled: true, consentMode: "observe" };
  const inspect = "https://cdn.example.net/{seg}";
  for (const [label, body] of [
    ["a raw URL", { ...base, inspect: "https://cdn.example.net/loader.js?id=1" }],
    ["a comparison", { ...base, compareGpc: true, inspect }]
  ]) {
    const refused = await postScan(body);
    if (refused.ok || refused.error !== inspectionRequestMessage || refused.cause !== "request-rejected") {
      fail(`an inspection naming ${label} was not refused before any visit: ${smokeResponseSummary(refused)}`);
    }
  }
  const producer = health.checks?.publicR2Reports?.status;
  if (producer === "disabled") {
    const refused = await postScan({ ...base, inspect });
    if (refused.ok || refused.error !== inspectionV1Refusal || refused.cause !== undefined) {
      fail(`a version 1 scanner did not refuse an inspection with its sentence: ${smokeResponseSummary(refused)}`);
    }
    pass("API refuses malformed inspections, and a version 1 scanner refuses every inspection, before any visit");
  } else {
    pass(`API refuses malformed inspections before any visit (producer ${producer}: a well-formed inspection would visit, so none is sent)`);
  }
}

function smokeResponseSummary(value) {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return JSON.stringify({
    ok: value.ok,
    error: value.error,
    schemaVersion: value.schemaVersion,
    status: value.summary?.status,
    totalRequests: value.summary?.totalRequests,
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 3) : undefined
  });
}

/**
 * A scan link that asks for Blocker (`#scan?url=...&mode=shields`, what a
 * fresh result's "Compare with blocking on" mints) against this scanner's own
 * health: the form keeps the URL, selects Blocker once health offers it, or
 * keeps Single beside the run control's note if it does not, and sends no
 * scan request. Nothing here scans: the button is never pressed.
 */
async function modeLinkChecks(browser) {
  const { value: health } = await requestJson(`${baseUrl}/api/health`, {}, "/api/health");
  const offered = health?.capabilities?.shieldsComparison === true;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const scanRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/scan")) scanRequests.push(`${request.method()} ${request.url()}`);
  });
  try {
    const target = "https://example.com/";
    await page.goto(`${baseUrl}/#scan?url=${encodeURIComponent(target)}&mode=shields`, { waitUntil: "networkidle" });
    await page.waitForFunction((value) => document.getElementById("url")?.value === value, target, { timeout: 10_000 });
    await page.locator(".run-mode-checking").waitFor({ state: "detached", timeout: 30_000 });
    const pressed = (name) => page.getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
    if (offered) {
      await page.waitForFunction(
        () => document.querySelector('button[aria-label="Blocker comparison (Brave Shields)"]')?.getAttribute("aria-pressed") === "true",
        null,
        { timeout: 10_000 }
      );
    } else if ((await pressed("Single")) !== "true") {
      fail("a mode link the scanner cannot run did not leave Single selected");
    }
    await page.waitForTimeout(1_500);
    if (scanRequests.length !== 0) fail(`a mode link sent a scan request on its own: ${scanRequests.join(", ")}`);
    if (!(await page.evaluate(() => window.location.href)).endsWith("#scan")) fail("a mode link stayed in the address");
    pass(offered ? "a mode=shields link selects Blocker once health offers it, and sends nothing" : "a mode=shields link keeps Single when health lacks Blocker, and sends nothing");
  } finally {
    await page.close();
  }
}

/**
 * An "Inspect this connection" link (`#scan?url=...&inspect=...`, what a
 * fresh result's request log mints) against this scanner's own build: the
 * form keeps the page, selects Single, labels the button Inspect, states the
 * inspection, scrubs the link from the address and sends no scan request.
 * Nothing here scans: the button is never pressed.
 */
async function inspectLinkChecks(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const scanRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/scan")) scanRequests.push(`${request.method()} ${request.url()}`);
  });
  try {
    const target = "https://example.com/";
    const inspect = "https://cdn.example.net/{seg}";
    await page.goto(`${baseUrl}/#scan?url=${encodeURIComponent(target)}&inspect=${encodeURIComponent(inspect)}`, { waitUntil: "networkidle" });
    await page.waitForFunction((value) => document.getElementById("url")?.value === value, target, { timeout: 10_000 });
    await page.locator(".inspection-arrival").waitFor({ timeout: 10_000 });
    await expectText(page.locator("#inspection-arrival"), "Inspecting https://cdn.example.net/….");
    await expectText(page.locator("#inspection-arrival"), "The details show here only and are not saved.");
    if ((await page.locator('.scan-panel button[type="submit"]').textContent())?.trim() !== "Inspect") {
      fail("an inspection link did not label the button Inspect");
    }
    if ((await page.getByRole("button", { name: "Single", exact: true }).getAttribute("aria-pressed")) !== "true") {
      fail("an inspection link did not keep Single selected");
    }
    await page.waitForTimeout(1_500);
    if (scanRequests.length !== 0) fail(`an inspection link sent a scan request on its own: ${scanRequests.join(", ")}`);
    if (!(await page.evaluate(() => window.location.href)).endsWith("#scan")) fail("an inspection link stayed in the address");
    pass("an inspect link fills the form with Single, Inspect and its line, and sends nothing");
  } finally {
    await page.close();
  }
}

/**
 * A "Check after scrolling" link (`#scan?url=...&check=scroll`, what a fresh
 * result's visit summary mints) against this scanner's own build: the form
 * keeps the page, selects Single, labels the button Check, states the check,
 * swaps the disclosure's first sentence for the check's, scrubs the link from
 * the address and sends no scan request. Nothing here scans: the button is
 * never pressed.
 */
async function scrollCheckLinkChecks(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const scanRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/scan")) scanRequests.push(`${request.method()} ${request.url()}`);
  });
  try {
    const target = "https://example.com/";
    await page.goto(`${baseUrl}/#scan?url=${encodeURIComponent(target)}&check=scroll`, { waitUntil: "networkidle" });
    await page.waitForFunction((value) => document.getElementById("url")?.value === value, target, { timeout: 10_000 });
    await page.locator(".scroll-check-arrival").waitFor({ timeout: 10_000 });
    await expectText(page.locator("#scroll-check-arrival"), "Checking after scrolling. A new visit to https://example.com/ runs as a single scan");
    await expectText(page.locator("#scroll-check-arrival"), "What it finds shows here only and is not saved. It takes about a minute.");
    if ((await page.locator('.scan-panel button[type="submit"]').textContent())?.trim() !== "Check") {
      fail("a check link did not label the button Check");
    }
    if ((await page.getByRole("button", { name: "Single", exact: true }).getAttribute("aria-pressed")) !== "true") {
      fail("a check link did not keep Single selected");
    }
    if (!(await page.locator(".scan-disclosure-check-visit").isVisible()) || (await page.locator(".scan-disclosure-visit").isVisible())) {
      fail("a check link did not swap the disclosure's first sentence for the check's");
    }
    await page.waitForTimeout(1_500);
    if (scanRequests.length !== 0) fail(`a check link sent a scan request on its own: ${scanRequests.join(", ")}`);
    if (!(await page.evaluate(() => window.location.href)).endsWith("#scan")) fail("a check link stayed in the address");
    pass("a check link fills the form with Single, Check, its line and the check's disclosure, and sends nothing");
  } finally {
    await page.close();
  }
}

async function uiChecks() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  try {
    await modeLinkChecks(browser);
    await inspectLinkChecks(browser);
    await scrollCheckLinkChecks(browser);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await expectText(page.locator("h1"), "See what a site does, not just what it says.");
    pass("home page renders tagline");

    if (scanAccessToken) {
      await openOptions(page);
      await page.getByLabel("Scanner access key").fill(scanAccessToken);
    }

    await page.fill("#url", "https://example.com");
    await page.getByRole("button", { name: "Scan", exact: true }).click();
    const loadingState = page.locator(".loading-state");
    await loadingState.waitFor({ state: "visible", timeout: 5_000 });
    const loadingSemantics = await loadingState.evaluate((element) => ({
      rootRole: element.getAttribute("role"),
      announcements: Array.from(element.querySelectorAll('[role="status"]')).map((node) => node.textContent)
    }));
    if (loadingSemantics.rootRole === "status") {
      fail("the one-second loading timer is inside the status live region");
    }
    if (loadingSemantics.announcements.length !== 1) fail("scan loading state lacks its bounded status announcement");
    await page.waitForTimeout(1_100);
    // A fast local scan may finish during this interval. If the loading state
    // is still mounted, confirm that only the visual timer changed.
    if (await loadingState.isVisible()) {
      const announcementAfterTick = await loadingState.evaluate(
        (element) => element.querySelector('[role="status"]')?.textContent ?? null
      );
      if (announcementAfterTick !== loadingSemantics.announcements[0]) {
        fail("scan loading status announcement changes with the one-second timer");
      }
    }
    pass("scan timer stays outside the bounded live status announcement");
    await waitForReportOrError(page, 30_000);
    // Redaction policy v4 withholds page-authored titles, so the header
    // identifies the subject by its domain, never by document.title.
    await expectText(page.locator(".report-header"), "example.com");
    await expectText(page.locator(".warnings"), "one automated, headless Chromium visit");
    await expectText(page.locator(".methodology"), `Playwright${playwrightPackage.version}`);
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

    // The anchor navigates with a relative path, but the copy button must write a
    // complete, pasteable URL, guard against regressing to the relative path.
    await page.evaluate(() => {
      window.__copiedShareLink = null;
      navigator.clipboard.writeText = (text) => {
        window.__copiedShareLink = text;
        return Promise.resolve();
      };
    });
    // Matched on the "share link" part only: the control's accessible name has to
    // contain its visible label ("Copy link" / "Copied"), so it changes as the
    // button changes state and must not be pinned as one exact sentence here.
    await page.getByRole("button", { name: /share link/i }).click();
    const copiedShareLink = await page.evaluate(() => window.__copiedShareLink);
    if (!copiedShareLink || !/^https?:\/\/.+\/reports\//.test(copiedShareLink)) {
      fail(`copy share link wrote a non-absolute URL: ${copiedShareLink}`);
    }
    if (!copiedShareLink.endsWith(shareHref)) {
      fail("copied share link does not resolve to the share permalink");
    }
    pass("copy share link writes an absolute report URL");

    await page.goto(`${baseUrl}${shareHref}`, { waitUntil: "networkidle" });
    // .report-identity, not .report-header: the permalink's own header used to
    // restate the site and URL that the evidence explorer's header also carries,
    // so opening the explorer swapped one copy of those facts for another. The
    // identity block renders in both states; .report-header now belongs to the
    // explorer alone, which is what lines 314-315 below still assert.
    await page.waitForSelector(".report-identity", { timeout: 30_000 });
    await expectText(page.locator(".report-identity"), "https://example.com/");
    if ((await page.locator(".report-grid").count()) !== 0) {
      fail("share permalink eagerly rendered the full evidence explorer");
    }
    await page.getByRole("button", { name: "Explore full evidence" }).click();
    await waitForReportOrError(page, 30_000);
    await expectText(page.locator(".report-header"), "GPC off/on comparison");
    await expectText(page.locator(".report-header"), "https://example.com/");
    pass("share permalink renders its compact summary and lazy evidence explorer");

    // Report permalinks intentionally lead with evidence and do not embed the
    // scanner form. Return to the scanner before exercising its validation UI.
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    if (scanAccessToken) {
      await openOptions(page);
      await page.getByLabel("Scanner access key").fill(scanAccessToken);
    }
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

    // The printable version is linked from every saved report. Its guide
    // printed a 64-character SHA-256 as unbreakable code, which made the page
    // 513 px wide on a 375 px phone.
    await page.goto(`${baseUrl}${shareHref.replace(/\/+$/, "")}/print/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.reportPrintReady === "true", null, { timeout: 30_000 });
    if (await hasHorizontalOverflow(page)) fail("mobile printable report has page-level horizontal overflow");
    pass("mobile printable report fits viewport");
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
