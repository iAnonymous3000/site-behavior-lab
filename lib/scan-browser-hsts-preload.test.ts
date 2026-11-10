import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import { browserProcessEnvironment, SCAN_CHROMIUM_LAUNCH_ARGS } from "./scanner";

/**
 * Whether the scan browser applies Chromium's built-in HSTS preload list, read
 * where the scanner's own proxy would see it.
 *
 * Chromium stops applying the list 70 days after its build:
 * `IsBuildTimely()` in net/http/transport_security_state.cc compares the build
 * time compiled into the browser with the clock, and nothing in that file lets
 * a switch, feature or policy change it. So the answer changes with the
 * calendar, not with any code here. Without the list, a page's http:// request
 * to a preloaded name reaches the proxy as a plain GET; with it, Chromium
 * upgrades the request first and the proxy sees a CONNECT to port 443.
 *
 * This records a fact. On 2026-11-03 the owner delegated the choice of
 * semantics, and the recommendation taken was to keep the scan browser within
 * its 70 days. Recorded 2026-11-10: Playwright 1.65.0's Chromium 158.0.8127.18
 * applies the list. Its version tag was committed 2026-11-04 01:08:26 UTC, so
 * its estimated cutoff is 2027-01-13 01:08 UTC, on the assumption that the
 * build time IsBuildTimely() compares is the tag's commit time, an assumption
 * one lapse has confirmed so far. That lapse: Playwright 1.63.0's Chromium
 * 153.0.8010.12 (tag committed 2026-08-25 20:20:53 UTC) stopped applying the
 * list on 2026-11-03 between two gate runs, a window that holds the predicted
 * 20:20:53 UTC, and this test expected that until the 2026-11 toolchain epoch
 * moved the browser. That epoch's Chromium 156.0.8078.4 (Playwright 1.64.1,
 * tag committed 2026-09-29 23:57:21 UTC) applied the list when it was
 * recorded on 2026-11-03; its estimated cutoff is 2026-12-08 23:57 UTC, and
 * the 2026-12 toolchain epoch moved the browser here before that time, so
 * this test has not seen that build lapse. By the same rule, Playwright
 * 1.62's Chromium 151.0.7922.34 stopped applying it at about 2026-09-23
 * 03:34 UTC, about 21 hours before the 2026-09 epoch's deployment replaced
 * it. When the browser stops applying the list, this fails by name: under
 * that choice the next toolchain epoch is due.
 * scripts/chromium-hsts-preload-cutoff.mjs warns in CI three weeks before the
 * estimated cutoff. The title names the Chromium the installed playwright-core
 * bundles, read from its browsers.json.
 */
const PRELOAD_APPLIED = true;

/**
 * Two preloaded names: the policy tests' pixel host (the list carries
 * google-analytics.com with its subdomains) and an invented name under .dev,
 * a top-level domain the list carries whole, so the probe still reads the list
 * if a later one drops either entry.
 */
const PRELOADED_NAMES = ["www.google-analytics.com", "pixel.hsts-probe.dev"] as const;
const PROBE_PAGE = "http://hsts-probe.test/";
const pixelOf = (name: string): string => `http://${name}/collect?v=1`;
const BUNDLED_CHROMIUM = (JSON.parse(
  readFileSync(path.join(process.cwd(), "node_modules", "playwright-core", "browsers.json"), "utf8")
) as { browsers: Array<{ name: string; browserVersion?: string }> }).browsers.find(
  (browser) => browser.name === "chromium-headless-shell"
)?.browserVersion ?? "unnamed";

/** What the probe saw for one name, when it differs from PRELOAD_APPLIED. */
function mismatch(version: string, name: string, plain: boolean, upgraded: boolean): string {
  if (plain && upgraded) {
    return `Chromium ${version} sent http://${name} both as a plain GET and through a CONNECT to port 443, so this probe cannot say whether the browser applies its HSTS preload list.`;
  }
  if (upgraded) {
    return `Chromium ${version} applies its HSTS preload list to ${name}, which PRELOAD_APPLIED says it does not. Decide the measurement semantics before changing PRELOAD_APPLIED.`;
  }
  return `Chromium ${version} does not apply its HSTS preload list to ${name}: its build is likely more than 70 days old (scripts/chromium-hsts-preload-cutoff.mjs estimates each cutoff), so scans send http:// requests to preloaded names as http. Keeping the scan browser within its 70 days needs the next toolchain epoch; do not change PRELOAD_APPLIED to make this pass.`;
}

test(`the scan browser, Chromium ${BUNDLED_CHROMIUM}, applies its HSTS preload list (expectation recorded 2026-11-10)`, { timeout: 60_000 }, async (t) => {
  const seen: string[] = [];
  const proxy = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (request.url === PROBE_PAGE) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>probe</title>${PRELOADED_NAMES.map((name) => `<img src="${pixelOf(name)}" alt="">`).join("")}`);
      return;
    }
    response.writeHead(204);
    response.end();
  });
  proxy.on("connect", (request: IncomingMessage, socket: Socket) => {
    seen.push(`CONNECT ${request.url}`);
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const { port } = proxy.address() as AddressInfo;

  // getSharedBrowser's launch flags, sandbox and environment, behind the probe's proxy.
  const browser = await chromium.launch({
    headless: true,
    args: [...SCAN_CHROMIUM_LAUNCH_ARGS],
    chromiumSandbox: chromiumSandboxEnabled(),
    env: browserProcessEnvironment(),
    proxy: { server: `http://127.0.0.1:${port}` }
  });
  t.after(() => browser.close());
  t.diagnostic(`Chromium ${browser.version()}`);

  // goto waits for load, which waits for each image's request to settle, and
  // the proxy logs a request before it answers it, so the log is whole here.
  const page = await browser.newPage();
  await page.goto(PROBE_PAGE);

  for (const name of PRELOADED_NAMES) {
    const plain = seen.includes(`GET ${pixelOf(name)}`);
    const upgraded = seen.includes(`CONNECT ${name}:443`);
    // Neither would mean the probe saw nothing, which proves nothing either way.
    assert.ok(plain || upgraded, `the proxy saw neither a GET nor a CONNECT for ${name}: ${JSON.stringify(seen)}`);
    assert.deepEqual(
      { name, plain, upgraded },
      { name, plain: !PRELOAD_APPLIED, upgraded: PRELOAD_APPLIED },
      mismatch(browser.version(), name, plain, upgraded)
    );
  }
});
