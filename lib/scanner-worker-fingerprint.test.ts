import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { closeSharedBrowserForTests, scanSiteWithMeasurement, type EstablishedWorkerRealmChannelForTests } from "./scanner";

/**
 * Worker-realm fingerprinting through the real scanner pipeline (proxy,
 * routing, phases, both freezes) and real Chromium, on local pages. The
 * fixture pages do no fingerprinting of their own: everything a report shows
 * here was done inside a dedicated worker and read back over the worker realm
 * channel.
 */

const CANVAS_READ_SOURCE =
  "const canvas = new OffscreenCanvas(200, 60); const context = canvas.getContext('2d'); " +
  "context.fillText('abcdefghijklmnopqrstuvwxyz0123', 2, 20); context.getImageData(0, 0, 200, 60);";
const WEBGL_READ_SOURCE =
  "const gl = new OffscreenCanvas(16, 16).getContext('webgl'); gl.getParameter(37446); " +
  "gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));";

function scanOptions(port: number) {
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 as const }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => []
  };
}

async function listen(t: { after(fn: () => unknown): void }, server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  t.after(() => closeSharedBrowserForTests());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** A page whose only fingerprinting is one dedicated worker's OffscreenCanvas text readback. */
function canvasWorkerUpstream() {
  return createServer((request, response) => {
    if (request.url === "/canvas-worker.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(CANVAS_READ_SOURCE);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Worker canvas</title>
      <main><p>Ordinary public page whose worker draws text and reads it back.</p></main>
      <script>new Worker('/canvas-worker.js');</script>`);
  });
}

for (const arm of [
  { name: "baseline", gpcEnabled: false, shieldsBlockingEnabled: false },
  { name: "Shields", gpcEnabled: false, shieldsBlockingEnabled: true },
  { name: "GPC", gpcEnabled: true, shieldsBlockingEnabled: false }
]) {
  test(`the ${arm.name} arm reads a dedicated worker's canvas fingerprinting into the report`, { timeout: 60_000 }, async (t) => {
    const port = await listen(t, canvasWorkerUpstream());
    let established: EstablishedWorkerRealmChannelForTests | null = null;
    const { result } = await scanSiteWithMeasurement(
      { url: "http://worker-canvas.test/", device: "desktop", gpcEnabled: arm.gpcEnabled, consentMode: "observe" },
      {
        ...scanOptions(port),
        shieldsBlockingEnabled: arm.shieldsBlockingEnabled,
        onWorkerRealmChannelEstablishedForTests: (channel) => {
          established = channel;
        }
      }
    );

    assert.equal(
      result.conditions.shieldsMode,
      arm.shieldsBlockingEnabled ? "block-simulation" : "classification",
      "the arm must be the one this test names"
    );
    assert.ok(established, "the worker realm channel must be established");
    assert.deepEqual((established as EstablishedWorkerRealmChannelForTests).fingerprintInstallDiagnostics(), {
      installedWorkerCount: 1,
      installFailedWorkerCount: 0
    });
    assert.deepEqual(
      (result.fingerprintDetections ?? []).map((detection) => [detection.kind, detection.heuristic]),
      [["canvas-fingerprinting", "openwpm-canvas-v1"]],
      "the worker's canvas readback must reach the report"
    );
    assert.equal(
      result.fingerprintEvents.find((event) => event.api === "canvas.getImageData")?.count,
      1,
      "the worker's call is counted once"
    );
  });
}

/**
 * Both freezes, across a consent reload. The pre-consent document's worker
 * reads a canvas; the accept click reloads the page, which ends that worker
 * with its document, and the new document's worker reads WebGL. The passive
 * boundary reads the first worker; the final read no longer credits it, since
 * its document is gone, and reads the second. Attribution then behaves as it
 * does for frames: the passive detection is kept at the passive phase, the
 * WebGL one is credited to the consent phase, and the passive detection
 * missing from the final record is disclosed as incomplete attribution.
 */
test("worker detections at the passive boundary and the final read are attributed by phase like a frame's", { timeout: 60_000 }, async (t) => {
  const port = await listen(
    t,
    createServer((request, response) => {
      if (request.url === "/canvas-worker.js" || request.url === "/webgl-worker.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(request.url === "/canvas-worker.js" ? CANVAS_READ_SOURCE : WEBGL_READ_SOURCE);
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const consented = (request.headers.cookie ?? "").includes("cmp-choice=granted");
      response.end(
        consented
          ? `<!doctype html><title>after consent</title><main><p>Post-consent page.</p></main>
            <script>new Worker('/webgl-worker.js');</script>`
          : `<!doctype html><title>before consent</title><main><p>Pre-consent page.</p></main>
            <div id="onetrust-banner-sdk">
              <button id="onetrust-accept-btn-handler"
                onclick="document.cookie='cmp-choice=granted; path=/'; location.reload();">
                Accept all
              </button>
            </div>
            <script>new Worker('/canvas-worker.js');</script>`
      );
    })
  );

  const { measurement: staged } = await scanSiteWithMeasurement(
    { url: "http://worker-consent.test/", device: "desktop", gpcEnabled: false, consentMode: "accept-all" },
    scanOptions(port)
  );

  const consentPhase = staged.measurement.phases.find((phase) => phase.kind === "consent-interaction");
  assert.ok(consentPhase, "the consent phase must begin");
  const detections = staged.evidence.fingerprintDetections
    .map((detection) => [detection.heuristic, detection.phaseId])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  assert.deepEqual(detections, [
    ["openwpm-canvas-v1", 0],
    ["webgl-entropy-read-v1", consentPhase.phaseId]
  ]);
  assert.equal(
    staged.measurement.qualityFacts.captureLoss.some(
      (loss) =>
        loss.family === "fingerprinting" &&
        loss.phaseId !== 0 &&
        loss.kind === "dropped" &&
        loss.detail === "fingerprint-observer"
    ),
    true,
    "the passive detection absent from the final record is disclosed, as for a frame"
  );
});
