import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONSENT_VERIFICATION_ENV } from "./consent-verification";
import { isConnectionInspectionEvidence } from "./connection-inspection-evidence";
import { connectionInspectionEvidence } from "./node-scan-measurement";
import { readStoredScanReportById, saveScanReport } from "./report-store";
import { BUILD_COMMIT_ENV, PUBLIC_R2_REPORTS_ENV } from "./runtime-scan-report";
import { executePreparedScan, type PreparedScanRequest, type ScanRunner } from "./scan-api";
import { readScanTransportPayload } from "./scan-report-view";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type ScanSiteOptions } from "./scanner";

/**
 * "Inspect this connection" through the real scanner, against a local page.
 *
 * Every host below is a registrable name the report could publish, routed by
 * the scanner's own proxy hook to one local server that answers by Host
 * header, so nothing leaves this machine. The page:
 *
 * - draws an image from the pixel host in its HTML (no call stack);
 * - loads a loader from cdn.example.net that inserts a tag script from
 *   static.example.org and, once it loads, calls the tag's function, which
 *   fetches the pixel: the stack is the tag's frame, then the loader's. The
 *   same function also draws the pixel as a script-created image, which
 *   Chromium 153 reports as the parser's, with the document's URL and no
 *   stack, however a script created it, so it counts with the HTML's image;
 * - runs two self-named scripts from a timer: one whose sourceURL comment
 *   names an address nothing requested, one whose name is the loader's;
 * - fetches an address on the pixel host that redirects to the pixel;
 * - starts a dedicated worker that fetches the pixel, which the page reports
 *   and the page's own session never observes.
 */

const PAGE = "http://www.example.com/";
const ADDRESS = "http://pixel.example.net/{seg}";

// Fixture code for the browser, fixed strings served only to the scanner's
// own Chromium: eval with a sourceURL comment is the subject of two cases,
// as in case 7 of lib/request-initiator-fixture.test.ts, and every script
// address is a local stand-in, so no integrity attribute applies.
const FILES: Record<string, Record<string, string>> = {
  "www.example.com": {
    "/": `<!doctype html><title>Inspection fixture</title>
<img src="http://pixel.example.net/p.gif?via=html" alt="">
<script src="http://cdn.example.net/loader.js"></script>
<script>
  setTimeout(eval('(function () { fetch("http://pixel.example.net/p.gif?via=forged", { mode: "no-cors" }); })\\n//# sourceURL=http://forged.example.com/named.js'), 0);
  setTimeout(eval('(function () { fetch("http://pixel.example.net/p.gif?via=borrowed", { mode: "no-cors" }); })\\n//# sourceURL=http://cdn.example.net/loader.js'), 0);
  fetch("http://pixel.example.net/redirect?to=p", { mode: "no-cors" });
  new Worker("/worker.js");
</script>
<p>Inspection fixture page.</p>`,
    "/worker.js": `fetch("http://pixel.example.net/p.gif?via=worker", { mode: "no-cors" });`
  },
  "cdn.example.net": {
    "/loader.js":
      `var tag = document.createElement("script");` +
      ` tag.src = "http://static.example.org/tag.js";` +
      ` tag.onload = function () { window.exampleTag.send("loader"); };` +
      ` document.head.appendChild(tag);`
  },
  "static.example.org": {
    "/tag.js":
      `window.exampleTag = { send: function (via) {` +
      ` fetch("http://pixel.example.net/p.gif?via=" + via, { mode: "no-cors" });` +
      ` new Image().src = "http://pixel.example.net/p.gif?via=script-image";` +
      ` } };`
  }
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

type Fixture = { server: Server; port: number; hits: string[] };

async function startFixture(): Promise<Fixture> {
  const hits: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const host = request.headers.host?.split(":")[0] ?? "";
    const url = new URL(request.url ?? "/", `http://${host}`);
    hits.push(`${host}${url.pathname}${url.search}`);
    if (host === "pixel.example.net") {
      if (url.pathname === "/redirect") {
        response.writeHead(302, { location: "http://pixel.example.net/p.gif?via=redirect", "access-control-allow-origin": "*" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" });
      response.end(PNG);
      return;
    }
    const body = FILES[host]?.[url.pathname];
    if (body === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    const type = url.pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
    response.writeHead(200, { "content-type": type });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, port: address.port, hits };
}

function visitOptions(port: number, inspect?: string): ScanSiteOptions {
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => [],
    ...(inspect === undefined ? {} : { inspect })
  };
}

test("an inspection visit groups the pixel's requests by the scripts on their call stacks", { timeout: 60_000 }, async () => {
  const fixture = await startFixture();
  try {
    const envelope = await scanSiteWithMeasurement(
      { url: PAGE, device: "desktop", gpcEnabled: false, consentMode: "observe" },
      visitOptions(fixture.port, ADDRESS)
    );
    // The visit took the shape the assertions below assume.
    for (const via of ["html", "loader", "script-image", "forged", "borrowed", "redirect", "worker"]) {
      assert.ok(fixture.hits.includes(`pixel.example.net/p.gif?via=${via}`), `the pixel was never requested via ${via}: ${fixture.hits.join(", ")}`);
    }
    assert.ok(fixture.hits.includes("pixel.example.net/redirect?to=p"));

    const evidence = connectionInspectionEvidence(envelope);
    assert.ok(evidence, "the inspection visit returned no evidence");
    assert.equal(isConnectionInspectionEvidence(evidence), true, JSON.stringify(evidence));
    assert.deepEqual(evidence, {
      address: ADDRESS,
      // The page reported every request, the redirect's hop and the worker's included.
      matched: 8,
      groups: [
        // The self-named script whose name the loader's address is: named.
        { count: 1, hosts: ["cdn.example.net"], namedScripts: ["http://cdn.example.net/{seg}"] },
        // The tag's function, called by the loader: tag host, then loader host.
        {
          count: 1,
          hosts: ["static.example.org", "cdn.example.net"],
          namedScripts: ["http://static.example.org/{seg}", "http://cdn.example.net/{seg}"]
        },
        // The page's inline script that fetched the redirecting address.
        { count: 1, hosts: ["www.example.com"], namedScripts: ["http://www.example.com/"] }
      ],
      redirected: 1,
      // The image in the HTML, and the image the tag's script created, which
      // Chromium reports exactly as it reports the HTML's.
      withoutStack: 2,
      // The script named by a sourceURL comment nothing requested.
      withoutNamedScript: 1,
      notListed: 0,
      // The worker's fetch.
      unobserved: 1
    });
    const serialized = JSON.stringify(evidence);
    for (const forbidden of ["forged", "via=", "?", "send", "onload", "loader.js", "tag.js", "worker"]) {
      assert.equal(serialized.includes(forbidden), false, `the evidence carries ${forbidden}`);
    }
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});

test("one inspection end to end: the immediate result shows it and the saved share holds none of it", { timeout: 90_000 }, async () => {
  const fixture = await startFixture();
  const storeDir = await mkdtemp(path.join(tmpdir(), "sbl-inspection-store-"));
  const env = {
    SITE_BEHAVIOR_LAB_REPORT_STORE_DIR: storeDir,
    [PUBLIC_R2_REPORTS_ENV]: "1",
    [BUILD_COMMIT_ENV]: "c".repeat(40),
    [CONSENT_VERIFICATION_ENV]: "1"
  };
  const previous = Object.fromEntries(Object.keys(env).map((name) => [name, process.env[name]]));
  Object.assign(process.env, env);
  try {
    // The scan API's own execution path, the real scanner behind the proxy
    // hook, and the real report store.
    const scan: ScanRunner = (payload, options) =>
      scanSiteWithMeasurement(payload, { ...options, ...visitOptions(fixture.port) });
    const prepared: PreparedScanRequest = {
      clientKey: "inspection-fixture",
      url: PAGE,
      device: "desktop",
      gpcEnabled: false,
      compareGpc: false,
      compareShields: false,
      compareConsent: false,
      rateLimitCost: 1
    };
    const inspected = await executePreparedScan({ ...prepared, inspect: ADDRESS }, scan, saveScanReport, undefined, false);
    if (inspected.schemaVersion !== 2 || inspected.reportType !== "single") throw new Error("expected an r2 single shell");
    const inspection = inspected.ephemeral.inspection;
    assert.ok(inspection, "the immediate result carries no inspection");
    assert.equal(inspection.address, ADDRESS);
    assert.equal(inspection.matched, 8);
    assert.deepEqual(
      inspection.groups.map((group) => group.hosts),
      [["cdn.example.net"], ["static.example.org", "cdn.example.net"], ["www.example.com"]]
    );
    // The client's own reader accepts the shell as it arrives.
    const read = readScanTransportPayload(JSON.parse(JSON.stringify(inspected)));
    assert.equal(read.kind === "report" && read.loaded.source, "v2-r2-ephemeral");

    const saved = await readStoredScanReportById(inspected.share?.id ?? "");
    if (saved.outcome !== "found") throw new Error("the inspection's share was not saved");
    for (const forbidden of ["inspection", "ephemeral", "namedScripts", "withoutStack", "pixel.example.net/{seg}\""]) {
      assert.equal(saved.wire.includes(forbidden), false, `the saved share carries ${forbidden}`);
    }
    const wire = JSON.parse(saved.wire);
    assert.equal(wire.reportType, "single");
    assert.equal(wire.schemaRevision, 2);
    assert.equal(wire.run.conditions.gpc, false);
    assert.equal(wire.run.conditions.consent, "observe");
    // The share's own request log is an ordinary one: the pixel's rows are there.
    assert.ok(wire.run.evidence.requests.some((request: { url: string }) => request.url.startsWith("http://pixel.example.net/{seg}")));
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(storeDir, { recursive: true, force: true });
  }
});

test("an ordinary visit of the same page keeps no inspection", { timeout: 60_000 }, async () => {
  const fixture = await startFixture();
  try {
    const envelope = await scanSiteWithMeasurement(
      { url: PAGE, device: "desktop", gpcEnabled: false, consentMode: "observe" },
      visitOptions(fixture.port)
    );
    assert.ok(fixture.hits.includes("pixel.example.net/p.gif?via=loader"));
    assert.equal(connectionInspectionEvidence(envelope), undefined);
    // A copy of an inspection envelope carries nothing either: the evidence
    // is keyed by the exact envelope the visit returned.
    const inspected = await scanSiteWithMeasurement(
      { url: PAGE, device: "desktop", gpcEnabled: false, consentMode: "observe" },
      visitOptions(fixture.port, ADDRESS)
    );
    assert.ok(connectionInspectionEvidence(inspected));
    assert.equal(connectionInspectionEvidence({ ...inspected }), undefined);
    assert.equal(JSON.stringify(inspected.measurement).includes("pixel.example.net/{seg}"), false);
  } finally {
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
});
