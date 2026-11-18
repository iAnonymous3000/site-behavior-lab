import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import {
  GPC_WORKER_WATCH_PAGE_URL,
  GPC_WORKER_WATCH_PING_RECORDED_URL,
  GPC_WORKER_WATCH_PING_URL
} from "./gpc-worker-watch-page";
import { redactUrlV2 } from "./redaction-v2";
import { buildReportFacts } from "./report-facts";
import { buildRequestAttributionMap, requestAttributionActor } from "./request-attribution-map";
import { viewFromV2 } from "./scan-report-views";
import { scanSiteWithMeasurement } from "./scanner";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";

// The production synthetic's GPC worker watch counts one request row: the
// watch page's dedicated worker fetching one fixed file. Page CDP never sees a
// dedicated worker's requests, so whether that fetch reaches the published
// request log at all is the question this answers, through the real scanner
// with GPC on, on the exact files under public/monitor/gpc-worker/ served from
// the loopback. The fixture host stands in for this site's origin: redaction
// keeps the path's depth, not its host.
// A registrable fixture host with no subdomain: the r2 builder refuses a
// subject with no registrable domain (a .test name has none), and redaction
// generalizes a subdomain label, which would hide the origin swap below. The
// proxy connects it to the loopback, so nothing leaves the machine.
const FIXTURE_ORIGIN = "http://example.com";
const PUBLIC_DIR = path.join(process.cwd(), "public", "monitor", "gpc-worker");
const WATCH_PATH = new URL(GPC_WORKER_WATCH_PAGE_URL).pathname;
const PING_PATH = new URL(GPC_WORKER_WATCH_PING_URL).pathname;
const FILES: Record<string, { file: string; type: string }> = {
  [WATCH_PATH]: { file: "index.html", type: "text/html; charset=utf-8" },
  "/monitor/gpc-worker/worker.js": { file: "worker.js", type: "application/javascript" },
  [PING_PATH]: { file: path.join("ping", "ok.txt"), type: "text/plain; charset=utf-8" }
};

// One scan of the watch page with the given GPC setting, its assertions shared
// by both settings: the worker's request reaches the published log either way.
async function scanWatchPage(gpcEnabled: boolean): Promise<void> {
  const served: string[] = [];
  const upstream = createServer((request, response) => {
    const url = request.url ?? "";
    served.push(url);
    const entry = FILES[url];
    if (!entry) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" });
    response.end(readFileSync(path.join(PUBLIC_DIR, entry.file)));
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  // Production runs with consent verification on (wrangler.container.jsonc
  // SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION "1"), and the r2 builder refuses
  // a visit whose always-on consent detector was never requested.
  const previousConsentVerification = process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";

  try {
    const visit = await scanSiteWithMeasurement(
      { url: `${FIXTURE_ORIGIN}${WATCH_PATH}`, device: "desktop", gpcEnabled, consentMode: "observe" },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => {
          throw new Error("no CNAME lookups in this fixture");
        }
      }
    );

    // The worker ran: the loopback served its script and its one fetch.
    assert.equal(served.filter((url) => url === "/monitor/gpc-worker/worker.js").length, 1, JSON.stringify(served));
    assert.equal(served.filter((url) => url === PING_PATH).length, 1, JSON.stringify(served));

    const report = toPublicScanReportR2(
      buildRuntimeScanReportV2R2(visit, "public-api", {
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40)
      } as NodeJS.ProcessEnv)
    );
    assert.equal(report.reportType, "single");
    const run = report.run;

    // Coverage as the synthetic counts it: one row at the ping's recorded
    // form, which on this site's origin is the watch constant.
    const recordedPing = redactUrlV2(`${FIXTURE_ORIGIN}${PING_PATH}`).value;
    assert.equal(
      recordedPing.replace(FIXTURE_ORIGIN, new URL(GPC_WORKER_WATCH_PAGE_URL).origin),
      GPC_WORKER_WATCH_PING_RECORDED_URL
    );
    const pingRows = run.evidence.requests.filter((request) => request.url === recordedPing);
    assert.equal(pingRows.length, 1, JSON.stringify(run.evidence.requests.map((request) => request.url)));

    // What the stored report records about who started the ping, and how the
    // attribution map reads the same report, built as the report page builds
    // it (report-renderer.tsx:621-622, causality-graph.tsx:72-78). Measured on
    // the host with both GPC settings: the stored row carries no provenance at
    // all (no initiator, script or injector), so requestAttributionActor finds
    // no actor. The row is first-party, so the map, which reads third-party
    // rows only, does not consider it.
    assert.equal("provenance" in pingRows[0], false, JSON.stringify(pingRows[0]));
    assert.equal(pingRows[0].thirdParty, false);
    const facts = buildReportFacts(viewFromV2(report, 2));
    const viewRun = facts.display.run;
    const viewPing = viewRun.evidence.requests.filter((request) => request.url === recordedPing);
    assert.equal(viewPing.length, 1);
    assert.equal(viewPing[0].provenance ?? null, null);
    assert.equal(requestAttributionActor(viewPing[0]), null);
    const model = buildRequestAttributionMap({
      requests: viewRun.evidence.requests,
      totalRequests: viewRun.counts.totalRequests,
      thirdPartyRequests: viewRun.counts.thirdPartyRequests,
      automation: viewRun.conditions.automation,
      evidenceState: facts.display.evidence.requests.state
    });
    assert.ok(model && model.kind === "map", JSON.stringify(model));
    assert.equal(model.coverage.thirdPartyRequests, 0);
    assert.equal(model.coverage.attributedRequests, 0);
    assert.deepEqual(model.edges, []);

    // With GPC on, a worker held at its start and attested by its own
    // readback; with GPC off, no signal is installed. No loss line either way.
    assert.equal(run.conditions.gpc, gpcEnabled);
    assert.equal(
      run.warnings.filter((warning) => warning === GPC_WORKER_CAPTURE_LOSS_WARNING).length,
      0,
      JSON.stringify(run.warnings)
    );
  } finally {
    if (previousConsentVerification === undefined) {
      delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    } else {
      process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = previousConsentVerification;
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

test(
  "the GPC worker watch page, scanned with GPC on, publishes its worker's one request and no GPC worker loss line",
  { timeout: 90_000 },
  () => scanWatchPage(true)
);

test(
  "the GPC worker watch page, scanned with GPC off, still publishes its worker's one request",
  { timeout: 90_000 },
  () => scanWatchPage(false)
);

// A TEST-ONLY variant of the watch page, built in memory and never published:
// its worker fetches the page's own ping and also one fixed URL on a second
// site, which the scanner's proxy serves from the loopback. The public page
// keeps its same-origin fetch only. The attribution panel speaks to
// third-party requests, so this is the case its worker sentence describes.
const THIRD_PARTY_ORIGIN = "http://example.net";
const THIRD_PARTY_PATH = "/worker-fixture/beacon/one/ok.txt";
const VARIANT_WORKER_PATH = "/monitor/gpc-worker/worker-variant.js";

async function scanThirdPartyWorkerVariant(gpcEnabled: boolean): Promise<void> {
  const served: string[] = [];
  const page = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8").replace(
    'new Worker("/monitor/gpc-worker/worker.js")',
    `new Worker("${VARIANT_WORKER_PATH}")`
  );
  assert.match(page, new RegExp(VARIANT_WORKER_PATH.replaceAll("/", "\\/")));
  const worker =
    readFileSync(path.join(PUBLIC_DIR, "worker.js"), "utf8") +
    `fetch("${THIRD_PARTY_ORIGIN}${THIRD_PARTY_PATH}", { cache: "no-store", mode: "no-cors" });\n`;
  const upstream = createServer((request, response) => {
    const host = (request.headers.host ?? "").split(":")[0];
    const url = request.url ?? "";
    served.push(`${host}${url}`);
    const send = (type: string, body: string) => {
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    };
    if (host === "example.com" && url === WATCH_PATH) return send("text/html; charset=utf-8", page);
    if (host === "example.com" && url === VARIANT_WORKER_PATH) return send("application/javascript", worker);
    if (host === "example.com" && url === PING_PATH) return send("text/plain; charset=utf-8", "ok\n");
    if (host === "example.net" && url === THIRD_PARTY_PATH) return send("text/plain; charset=utf-8", "ok\n");
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const previousConsentVerification = process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";

  try {
    const visit = await scanSiteWithMeasurement(
      { url: `${FIXTURE_ORIGIN}${WATCH_PATH}`, device: "desktop", gpcEnabled, consentMode: "observe" },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => {
          throw new Error("no CNAME lookups in this fixture");
        }
      }
    );
    // The worker ran and reached the second site once.
    assert.equal(served.filter((entry) => entry === `example.net${THIRD_PARTY_PATH}`).length, 1, JSON.stringify(served));

    const report = toPublicScanReportR2(
      buildRuntimeScanReportV2R2(visit, "public-api", {
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40)
      } as NodeJS.ProcessEnv)
    );
    assert.equal(report.reportType, "single");
    assert.equal(report.run.conditions.gpc, gpcEnabled);
    const recorded = redactUrlV2(`${THIRD_PARTY_ORIGIN}${THIRD_PARTY_PATH}`).value;
    const facts = buildReportFacts(viewFromV2(report, 2));
    assertThirdPartyWorkerRowNotAttributed(facts, recorded);
  } finally {
    if (previousConsentVerification === undefined) {
      delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    } else {
      process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = previousConsentVerification;
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

function assertThirdPartyWorkerRowNotAttributed(facts: ReturnType<typeof buildReportFacts>, recorded: string): void {
  const run = facts.display.run;
  const rows = run.evidence.requests.filter((request) => request.url === recorded);
  // 1. Third-party, and in the cross-site totals.
  assert.equal(rows.length, 1, JSON.stringify(run.evidence.requests.map((request) => request.url)));
  assert.equal(rows[0].thirdParty, true);
  assert.equal(run.counts.thirdPartyRequests, 1);
  // 2. The map, built from the page's own inputs, counts it as third-party
  // and not attributable, and draws no edge for it.
  const model = buildRequestAttributionMap({
    requests: run.evidence.requests,
    totalRequests: run.counts.totalRequests,
    thirdPartyRequests: run.counts.thirdPartyRequests,
    automation: run.conditions.automation,
    evidenceState: facts.display.evidence.requests.state
  });
  assert.ok(model && model.kind === "map", JSON.stringify(model));
  assert.equal(model.coverage.thirdPartyRequests, 1);
  assert.equal(model.coverage.notAttributableRequests, 1);
  assert.equal(model.coverage.attributedRequests, 0);
  assert.deepEqual(model.edges, []);
  // 3. Why: the row records no initiator, so requestAttributionActor finds no
  // actor. Checked after the map, so a row given an initiator fails on what
  // the panel would show.
  assert.equal(rows[0].provenance ?? null, null, JSON.stringify(rows[0]));
  assert.equal(requestAttributionActor(rows[0]), null);
}

test(
  "a dedicated worker's third-party request, GPC on, is recorded with no initiator and counted as not attributable",
  { timeout: 90_000 },
  () => scanThirdPartyWorkerVariant(true)
);

test(
  "a dedicated worker's third-party request, GPC off, is recorded with no initiator and counted as not attributable",
  { timeout: 90_000 },
  () => scanThirdPartyWorkerVariant(false)
);
