import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
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
 * This records a fact, not a chosen semantics (docs/limitations.md). Playwright
 * 1.63.0's Chromium 153.0.8010.12 passed its 70 days at 2026-11-03 20:20:53
 * UTC and stopped applying the list. A Chromium that applies it again fails
 * here by name, and the measurement semantics are decided before this
 * expectation moves.
 */
const PRELOAD_APPLIED = false;

/**
 * Two preloaded names: the policy tests' pixel host (the list carries
 * google-analytics.com with its subdomains) and an invented name under .dev,
 * a top-level domain the list carries whole, so the probe still reads the list
 * if a later one drops either entry.
 */
const PRELOADED_NAMES = ["www.google-analytics.com", "pixel.hsts-probe.dev"] as const;
const PROBE_PAGE = "http://hsts-probe.test/";
const pixelOf = (name: string): string => `http://${name}/collect?v=1`;

test("the scan browser does not apply Chromium's HSTS preload list (recorded 2026-11-03)", { timeout: 60_000 }, async (t) => {
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
      upgraded
        ? `Chromium ${browser.version()} now applies its HSTS preload list to ${name} (its build is under 70 days old), so scans record http:// requests to preloaded names differently. Decide the measurement semantics (docs/limitations.md) before changing PRELOAD_APPLIED.`
        : `Chromium ${browser.version()} does not apply its HSTS preload list to ${name}.`
    );
  }
});
