import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import type { NodeScanMeasurementEnvelope } from "./node-scan-measurement";
import { buildReportFacts } from "./report-facts";
import {
  FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING,
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  FINGERPRINT_WORKER_REALM_CAPTURE_LOSS_WARNING
} from "./scan-runtime";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { buildRuntimeScanReportV2R2 } from "./scan-report-v2-runtime-builder";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
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

/**
 * A local page and its worker scripts, with a `/done/<name>` beacon the
 * scripts can call and a `/go` request the page can wait on until the test
 * releases it.
 */
async function startWorkerPage(
  t: { after(fn: () => unknown): void },
  routes: { page: string; scripts?: Record<string, string> }
): Promise<{ port: number; done: string[]; releaseGo: () => void }> {
  const done: string[] = [];
  const heldGo: Array<() => void> = [];
  let goReleased = false;
  const releaseGo = () => {
    goReleased = true;
    for (const release of heldGo.splice(0)) release();
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/done/")) {
      done.push(url.pathname.slice("/done/".length));
      response.writeHead(204);
      response.end();
      return;
    }
    if (url.pathname === "/go") {
      const respond = () => {
        response.writeHead(204);
        response.end();
      };
      if (goReleased) respond();
      else heldGo.push(respond);
      return;
    }
    const script = routes.scripts?.[url.pathname];
    if (script !== undefined) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    if (url.pathname !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(routes.page);
  });
  // A held /go response would otherwise park server.close().
  t.after(releaseGo);
  const port = await listen(t, server);
  return { port, done, releaseGo };
}

/**
 * The observe-mode banner read keeps the consent detector out of the default
 * state the r2 builder rejects, as in the scanner suite's listener scan.
 */
function withConsentVerification(t: { after(fn: () => unknown): void }): void {
  const previous = process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    else process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = previous;
  });
}

/**
 * What a visit says about its fingerprinting evidence on every channel a
 * reader uses: the three v1 loss lines, the r2 loss ledger and detector, the
 * fingerprint claim on the v1 wire and on the public r2 wire, and whether the
 * worker line survives the public r2 boundary.
 */
function fingerprintAccounting(visit: NodeScanMeasurementEnvelope) {
  const { result, measurement } = visit;
  assert.ok(measurement);
  const r2View = viewFromV2(
    toPublicScanReportR2(
      buildRuntimeScanReportV2R2(visit, "public-api", {
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40)
      } as NodeJS.ProcessEnv)
    ),
    2
  );
  const v1Claim = buildReportFacts(viewFromV1Report(result)).display.claims["fingerprint-apis"];
  const r2Claim = buildReportFacts(r2View).display.claims["fingerprint-apis"];
  return {
    lines: {
      frame: result.warnings.includes(FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING),
      listener: result.warnings.includes(FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING),
      workerRealm: result.warnings.includes(FINGERPRINT_WORKER_REALM_CAPTURE_LOSS_WARNING)
    },
    losses: measurement.measurement.qualityFacts.captureLoss
      .filter((loss) => loss.detail === "fingerprint-observer")
      .map((loss) => [loss.phaseId, loss.kind, loss.count]),
    detector: measurement.measurement.detectors["fingerprint-heuristics"],
    heuristics: (result.fingerprintDetections ?? []).map((detection) => detection.heuristic).sort(),
    v1Benchmark: v1Claim.benchmarkAllowed,
    r2Benchmark: r2Claim.benchmarkAllowed,
    r2WorkerLine: r2View.runs[0].warnings.includes(FINGERPRINT_WORKER_REALM_CAPTURE_LOSS_WARNING)
  };
}

/**
 * Design test 6. Chromium does not stop a worker at `terminate()`: it lets
 * the running task go on for about two seconds, then ends it, and the task's
 * closed snapshot is still delivered as it ends (measured on this shell: the
 * snapshot and the detach arrive together about 2,030 ms after the
 * terminate). Until then the terminating worker answers no DevTools command,
 * so the readout barrier goes unanswered. A terminate therefore costs
 * evidence only when a read falls inside that window.
 *
 * Here the page starts a worker just before the final read, the worker
 * fingerprints and stays inside a ten-second task, and the read is taken
 * while that task runs: once with the page terminating the worker on its
 * message, once with the worker left running. Either way its last word at
 * the read is "open" and no closed snapshot arrives within the drain, so the
 * realm is unread: the visit carries the worker line, one loss unit and a
 * partial detector, and neither wire may present the fingerprint claim as a
 * clean measurement.
 *
 * The companions are read: a worker the page terminates long before the read
 * while its 800 ms task still runs (the design's case, which the design
 * expected to be cut off), and one that ends the task that fingerprinted
 * before it tells the page.
 */
test("a worker terminated or still running mid-task at the read is one unread realm on every channel", { timeout: 90_000 }, async (t) => {
  withConsentVerification(t);
  const { port } = await startWorkerPage(t, {
    page: `<!doctype html><title>Worker mid-task</title><main><p>Ordinary public page.</p></main>
      <script>
        window.startWorker = (script, terminate) =>
          new Promise((resolve) => {
            const worker = new Worker(script);
            worker.onmessage = () => {
              if (terminate) worker.terminate();
              resolve();
            };
          });
        const onLoad = location.hostname.split(".")[1];
        if (onLoad === "busy-task" || onLoad === "after-task") startWorker("/" + onLoad + ".js", true);
      </script>`,
    scripts: {
      "/long-task.js": `${CANVAS_READ_SOURCE} postMessage("read"); const until = Date.now() + 10000; while (Date.now() < until) {}`,
      "/busy-task.js": `${CANVAS_READ_SOURCE} postMessage("read"); const until = Date.now() + 800; while (Date.now() < until) {}`,
      "/after-task.js": `${CANVAS_READ_SOURCE} setTimeout(() => postMessage("read"), 0);`
    }
  });

  for (const terminate of [true, false]) {
    const label = terminate ? "terminated at the read" : "running at the read";
    const midTask = fingerprintAccounting(
      await scanSiteWithMeasurement(
        { url: `http://www.long-task-${String(terminate)}.com/`, device: "desktop", gpcEnabled: false, consentMode: "observe" },
        {
          ...scanOptions(port),
          duringSubjectStateReadsForTests: async (page) => {
            await page.evaluate(
              (terminateWorker) =>
                (
                  window as unknown as { startWorker(script: string, terminate: boolean): Promise<void> }
                ).startWorker("/long-task.js", terminateWorker),
              terminate
            );
          }
        }
      )
    );
    assert.deepEqual(midTask.lines, { frame: false, listener: false, workerRealm: true }, label);
    assert.deepEqual(midTask.losses, [[0, "dropped", 1]], `${label}: exactly the one unread realm is the loss`);
    assert.deepEqual(
      midTask.detector,
      { version: midTask.detector.version, status: "partial", reason: "scan-failed", phaseId: 0 },
      label
    );
    assert.deepEqual(midTask.heuristics, [], `${label}: the worker's open task was never read`);
    assert.equal(midTask.v1Benchmark, false, `${label}: the v1 wire must not present a clean fingerprint claim`);
    assert.equal(midTask.r2Benchmark, false, `${label}: the r2 wire must not present a clean fingerprint claim`);
    assert.equal(midTask.r2WorkerLine, true, `${label}: the admitted worker line survives the public r2 boundary verbatim`);
  }

  for (const host of ["busy-task", "after-task"]) {
    const read = fingerprintAccounting(
      await scanSiteWithMeasurement(
        { url: `http://www.${host}.com/`, device: "desktop", gpcEnabled: false, consentMode: "observe" },
        scanOptions(port)
      )
    );
    assert.deepEqual(read.lines, { frame: false, listener: false, workerRealm: false }, host);
    assert.deepEqual(read.losses, [], host);
    assert.equal(read.detector.status, "complete", host);
    assert.deepEqual(read.heuristics, ["openwpm-canvas-v1"], host);
    assert.equal(read.v1Benchmark, true, host);
    assert.equal(read.r2Benchmark, true, host);
  }
});

/**
 * Design test 14, and the owner's rule that a page which ran code in a realm
 * the observer cannot see never reads clean. The shared worker fingerprints;
 * nothing of it is observed, and the channel's discovery turns it into one
 * unread realm on every channel a reader uses.
 */
test("a page that starts a shared worker never reads clean: one unread realm on every channel", { timeout: 60_000 }, async (t) => {
  withConsentVerification(t);
  const { port, done } = await startWorkerPage(t, {
    page: `<!doctype html><title>Shared worker</title><main><p>Ordinary public page.</p></main>
      <script>new SharedWorker("/shared.js").port.start();</script>`,
    scripts: {
      "/shared.js": `${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/shared");`
    }
  });
  let established: EstablishedWorkerRealmChannelForTests | null = null;
  const accounting = fingerprintAccounting(
    await scanSiteWithMeasurement(
      { url: "http://www.shared-worker-page.com/", device: "desktop", gpcEnabled: false, consentMode: "observe" },
      {
        ...scanOptions(port),
        onWorkerRealmChannelEstablishedForTests: (channel) => {
          established = channel;
        }
      }
    )
  );
  assert.deepEqual(done, ["shared"], "the shared worker ran");
  assert.ok(established);
  assert.equal((established as EstablishedWorkerRealmChannelForTests).session.discoveredSharedWorkerCount(), 1);
  assert.deepEqual(accounting.lines, { frame: false, listener: false, workerRealm: true });
  assert.deepEqual(accounting.losses, [[0, "dropped", 1]]);
  assert.deepEqual(
    accounting.detector,
    { version: accounting.detector.version, status: "partial", reason: "scan-failed", phaseId: 0 }
  );
  assert.deepEqual(accounting.heuristics, [], "nothing inside a shared worker is observed");
  assert.equal(accounting.v1Benchmark, false);
  assert.equal(accounting.r2Benchmark, false);
  assert.equal(accounting.r2WorkerLine, true);
});

/** Design test 4, end to end: a nested worker is observed in its own realm and costs nothing. */
test("a worker started by another worker is read into the report with no loss", { timeout: 60_000 }, async (t) => {
  withConsentVerification(t);
  const { port } = await startWorkerPage(t, {
    page: `<!doctype html><title>Nested worker</title><main><p>Ordinary public page.</p></main>
      <script>new Worker("/parent.js");</script>`,
    scripts: {
      "/parent.js": `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(CANVAS_READ_SOURCE)}], { type: "text/javascript" })));`
    }
  });
  let established: EstablishedWorkerRealmChannelForTests | null = null;
  const accounting = fingerprintAccounting(
    await scanSiteWithMeasurement(
      { url: "http://www.nested-worker.com/", device: "desktop", gpcEnabled: false, consentMode: "observe" },
      {
        ...scanOptions(port),
        onWorkerRealmChannelEstablishedForTests: (channel) => {
          established = channel;
        }
      }
    )
  );
  assert.ok(established);
  const channel = established as EstablishedWorkerRealmChannelForTests;
  assert.equal(channel.session.attachCounts().attachedNestedDedicatedWorkerCount, 1);
  assert.deepEqual(channel.fingerprintInstallDiagnostics(), { installedWorkerCount: 2, installFailedWorkerCount: 0 });
  assert.deepEqual(accounting.heuristics, ["openwpm-canvas-v1"]);
  assert.deepEqual(accounting.lines, { frame: false, listener: false, workerRealm: false });
  assert.deepEqual(accounting.losses, []);
  assert.equal(accounting.detector.status, "complete");
});

/**
 * Design test 12, end to end. The first worker fingerprints and stays alive;
 * the test drops the channel once it is installed and has done its work, then
 * lets the page start a second worker. The first can no longer be read (its
 * later emissions have nowhere to go), and the second was never attached; the
 * browser-side witness still saw it. Two unread realms, never a clean run.
 */
test("a channel dropped mid-scan leaves its live worker and the next one unread in the report", { timeout: 60_000 }, async (t) => {
  withConsentVerification(t);
  const { port, done, releaseGo } = await startWorkerPage(t, {
    page: `<!doctype html><title>Dropped channel</title><main><p>Ordinary public page.</p></main>
      <script>
        (async () => {
          new Worker("/first.js");
          await fetch("/go");
          new Worker("/late.js");
        })();
      </script>`,
    scripts: {
      "/first.js": `${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/first");`,
      "/late.js": `${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/late");`
    }
  });
  let poll: ReturnType<typeof setInterval> | null = null;
  // A hook that never fires must fail the assertions below, not hang the
  // page on its held request.
  const fallback = setTimeout(releaseGo, 15_000);
  t.after(() => {
    clearTimeout(fallback);
    if (poll) clearInterval(poll);
  });
  let dropped = false;
  const accounting = fingerprintAccounting(
    await scanSiteWithMeasurement(
      { url: "http://www.dropped-channel.com/", device: "desktop", gpcEnabled: false, consentMode: "observe" },
      {
        ...scanOptions(port),
        onWorkerRealmChannelEstablishedForTests: ({ session, fingerprintInstallDiagnostics }) => {
          poll = setInterval(() => {
            if (fingerprintInstallDiagnostics().installedWorkerCount < 1 || !done.includes("first")) return;
            if (poll) clearInterval(poll);
            poll = null;
            session.close();
            dropped = true;
            releaseGo();
          }, 20);
        }
      }
    )
  );
  assert.equal(dropped, true, "the channel must have been dropped after the first worker was installed");
  assert.deepEqual(done.sort(), ["first", "late"], "both workers ran");
  assert.deepEqual(accounting.lines, { frame: false, listener: false, workerRealm: true });
  assert.deepEqual(accounting.losses, [[0, "dropped", 2]]);
  assert.equal(accounting.detector.status, "partial");
  assert.equal(accounting.v1Benchmark, false);
  assert.equal(accounting.r2Benchmark, false);
});

/**
 * Design test 12's companion. With no channel at all, every worker the
 * browser witnessed is unread, and the GPC arm's own witness term, which
 * reads the same browser-side counter, still discloses both workers as
 * unverified.
 */
test("with no worker realm channel, every witnessed worker is unread, and the GPC arm still discloses them", { timeout: 60_000 }, async (t) => {
  withConsentVerification(t);
  const { port, done } = await startWorkerPage(t, {
    page: `<!doctype html><title>No channel</title><main><p>Ordinary public page.</p></main>
      <script>new Worker("/a.js"); new Worker("/b.js");</script>`,
    scripts: {
      "/a.js": `${CANVAS_READ_SOURCE} fetch(self.location.origin + "/done/a");`,
      "/b.js": `fetch(self.location.origin + "/done/b");`
    }
  });
  let established = false;
  const visit = await scanSiteWithMeasurement(
    { url: "http://www.no-channel.com/", device: "desktop", gpcEnabled: true, consentMode: "observe" },
    {
      ...scanOptions(port),
      forceWorkerRealmChannelUnavailableForTests: true,
      onWorkerRealmChannelEstablishedForTests: () => {
        established = true;
      }
    }
  );
  const accounting = fingerprintAccounting(visit);
  assert.equal(established, false, "the channel must never have been established");
  assert.deepEqual(done.sort(), ["a", "b"], "both workers ran");
  assert.deepEqual(accounting.lines, { frame: false, listener: false, workerRealm: true });
  assert.deepEqual(accounting.losses, [[0, "dropped", 2]]);
  assert.equal(accounting.detector.status, "partial");
  assert.equal(visit.result.warnings.includes(GPC_WORKER_CAPTURE_LOSS_WARNING), true);
  assert.deepEqual(
    visit.measurement!.measurement.qualityFacts.captureLoss
      .filter((loss) => loss.family === "requests" && loss.phaseId === null && loss.detail === undefined)
      .map((loss) => loss.count),
    [2],
    "the GPC arm's witness term still counts both workers"
  );
});

/**
 * A worker still inside a task at the passive boundary, and finished by the
 * final read. r2 records the passive boundary's unread realm as that
 * boundary's loss, which censors the family, so the v1 line must be there
 * too, although the final read reads every worker: v1 withholds what r2
 * withholds.
 */
test("a worker unread only at the passive boundary still carries the worker line, so v1 withholds what r2 withholds", { timeout: 90_000 }, async (t) => {
  const { port } = await startWorkerPage(t, {
    page: `<!doctype html><title>Busy at the boundary</title><main><p>Ordinary public page.</p></main>`,
    scripts: {
      "/busy.js":
        `${CANVAS_READ_SOURCE} postMessage("read"); const until = Date.now() + 3000; while (Date.now() < until) {} ` +
        `setTimeout(() => postMessage("done"), 0);`
    }
  });
  const accounting = fingerprintAccounting(
    await scanSiteWithMeasurement(
      { url: "http://www.busy-boundary.com/", device: "desktop", gpcEnabled: false, consentMode: "accept-all" },
      {
        ...scanOptions(port),
        // Start the worker just before the passive boundary and return once
        // it has fingerprinted, so it is inside its long task at that read.
        beforePassiveShieldsBoundaryForTests: async (page) => {
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                const worker = new Worker("/busy.js");
                const finished = new Promise<void>((done) => {
                  worker.onmessage = (event) => {
                    if (event.data === "read") resolve();
                    else done();
                  };
                });
                (window as unknown as { __busyWorkerFinished: Promise<void> }).__busyWorkerFinished = finished;
              })
          );
        },
        // The final read waits for the task to have ended.
        duringSubjectStateReadsForTests: async (page) => {
          await page.evaluate(() => (window as unknown as { __busyWorkerFinished: Promise<void> }).__busyWorkerFinished);
        }
      }
    )
  );
  assert.deepEqual(
    accounting.losses,
    [[0, "dropped", 1]],
    "the passive boundary's unread realm is its loss, and the final read reads the worker"
  );
  assert.equal(accounting.detector.status, "partial");
  assert.equal(accounting.r2Benchmark, false);
  assert.deepEqual(accounting.lines, { frame: false, listener: false, workerRealm: true });
  assert.equal(accounting.v1Benchmark, false, "v1 must withhold the claim r2 withholds");
});
