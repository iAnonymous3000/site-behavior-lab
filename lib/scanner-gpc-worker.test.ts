import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import { GPC_WORKER_CAPTURE_LOSS_WARNING } from "./gpc-injection";
import { closeSharedBrowserForTests, scanSiteWithMeasurement } from "./scanner";

/**
 * Arm-level pins for GPC worker signal delivery, against the real scanner
 * pipeline (proxy, routing, phases, wire accounting) and real Chromium.
 *
 * The upstream records every worker's OWN testimony: each worker's first
 * statement sends a beacon carrying `String(self.navigator.globalPrivacyControl)`
 * from inside its realm. That makes the assertions immune to the defect class
 * this fix retires: a scanner-side record standing in for an in-realm fact.
 */

type BeaconHit = {
  name: string;
  gpc: string;
  dep: string | null;
  secGpc: string | undefined;
};

function workerMatrixUpstream(options: { sharedWorkerOnly?: boolean } = {}) {
  const beacons: BeaconHit[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    if (url.pathname.startsWith("/beacon/")) {
      beacons.push({
        name: url.pathname.slice("/beacon/".length),
        gpc: url.searchParams.get("gpc") ?? "missing",
        dep: url.searchParams.get("dep"),
        secGpc: Array.isArray(request.headers["sec-gpc"])
          ? request.headers["sec-gpc"][0]
          : request.headers["sec-gpc"]
      });
      response.writeHead(204);
      response.end();
      return;
    }
    const scripts: Record<string, string> = {
      "/w.js": "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));",
      "/m.js":
        "import { depGpc } from './dep.js';\n" +
        "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl) + '&dep=' + String(depGpc));",
      "/dep.js": "export const depGpc = self.navigator.globalPrivacyControl;",
      "/nested.js":
        "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl)); new Worker('/nestedchild.js', { name: 'nestedchild' });",
      "/nestedchild.js": "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));",
      "/shared.js": "onconnect = () => {}; fetch('/beacon/shared?gpc=' + String(self.navigator.globalPrivacyControl));"
    };
    const script = scripts[url.pathname];
    if (script) {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(script);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (options.sharedWorkerOnly) {
      response.end(`<!doctype html><title>Shared worker page</title>
        <main><p>Ordinary public page with one shared worker.</p></main>
        <script>new SharedWorker('/shared.js', 'shared');</script>`);
      return;
    }
    response.end(`<!doctype html><title>Worker matrix</title>
      <main><p>Ordinary public page exercising every dedicated worker shape.</p></main>
      <script>
        const workerSource = "fetch(self.location.origin + '/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));";
        // A data: worker runs in an opaque origin where location.origin is
        // "null", so its beacon target is baked in absolutely.
        const dataSource = "fetch('" + location.origin + "/beacon/' + self.name + '?gpc=' + String(self.navigator.globalPrivacyControl));";
        new Worker('/w.js', { name: 'classic' });
        new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })), { name: 'blob' });
        new Worker('data:text/javascript,' + encodeURIComponent(dataSource), { name: 'data' });
        new Worker('/m.js', { name: 'module', type: 'module' });
        new Worker('/nested.js', { name: 'nestedparent' });
      </script>`);
  });
  return { server, beacons };
}

const MATRIX_WORKER_NAMES = ["blob", "classic", "data", "module", "nestedchild", "nestedparent"];

function scanOptions(port: number) {
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 as const }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => []
  };
}

function nullDetailDroppedRequestLoss(
  captureLoss: ReadonlyArray<{
    readonly family: string;
    readonly phaseId: number | null;
    readonly kind: string;
    readonly count: number;
    readonly detail?: string;
  }>
) {
  return captureLoss.filter(
    (loss) =>
      loss.family === "requests" && loss.phaseId === null && loss.kind === "dropped" && loss.detail === undefined
  );
}

test("the GPC arm delivers a realm-attested signal to every dedicated worker shape with zero disclosed loss", { timeout: 40_000 }, async (t) => {
  const { server, beacons } = workerMatrixUpstream();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  t.after(() => closeSharedBrowserForTests());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const { result, measurement } = await scanSiteWithMeasurement(
    { url: "http://worker-matrix.test/", device: "desktop", gpcEnabled: true, consentMode: "observe" },
    scanOptions(address.port)
  );

  assert.deepEqual(
    beacons.map((beacon) => beacon.name).sort(),
    MATRIX_WORKER_NAMES,
    "every worker of the matrix must RUN in the GPC arm; nothing is blocked"
  );
  for (const beacon of beacons) {
    assert.equal(
      beacon.gpc,
      "true",
      `the ${beacon.name} worker's first statement must observe the GPC signal in its own realm`
    );
    assert.equal(
      beacon.secGpc,
      "1",
      `the ${beacon.name} worker's own network traffic must carry the Sec-GPC header`
    );
  }
  assert.equal(
    beacons.find((beacon) => beacon.name === "module")?.dep,
    "true",
    "a module worker's static dependency evaluates after the pre-start install and must see the signal"
  );

  // Every worker verified: the disclosure must be absent, or a clean GPC
  // visit reads as degraded and the hedge stops meaning anything.
  assert.equal(result.warnings.includes(GPC_WORKER_CAPTURE_LOSS_WARNING), false);
  assert.deepEqual(nullDetailDroppedRequestLoss(measurement!.measurement.qualityFacts.captureLoss), []);

  // Worker-originated traffic stays in the request evidence. Matched on the
  // staged (pre-redaction) evidence rows because the v1 public wire scrubs
  // path segments; the staged rows are what the r2 builder consumes.
  for (const name of MATRIX_WORKER_NAMES) {
    assert.equal(
      measurement!.evidence.requests.some((request) => request.url.includes(`/beacon/${name}?`)),
      true,
      `the ${name} worker's request must appear in the GPC arm's request evidence`
    );
  }
  assert.equal(result.requests.length, measurement!.evidence.requests.length);
});

test("the baseline arm's workers run exactly as an unobserved browser would", { timeout: 40_000 }, async (t) => {
  const { server, beacons } = workerMatrixUpstream();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  t.after(() => closeSharedBrowserForTests());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const { result, measurement } = await scanSiteWithMeasurement(
    { url: "http://worker-matrix.test/", device: "desktop", gpcEnabled: false, consentMode: "observe" },
    scanOptions(address.port)
  );

  assert.deepEqual(beacons.map((beacon) => beacon.name).sort(), MATRIX_WORKER_NAMES);
  for (const beacon of beacons) {
    assert.equal(
      beacon.gpc,
      "undefined",
      `baseline ${beacon.name} worker must observe no signal: the intervention is GPC-arm-only`
    );
    assert.equal(
      beacon.secGpc,
      undefined,
      `baseline ${beacon.name} worker traffic must not carry a Sec-GPC header`
    );
  }
  assert.equal(result.warnings.includes(GPC_WORKER_CAPTURE_LOSS_WARNING), false);
  assert.deepEqual(nullDetailDroppedRequestLoss(measurement!.measurement.qualityFacts.captureLoss), []);
  for (const name of MATRIX_WORKER_NAMES) {
    assert.equal(
      measurement!.evidence.requests.some((request) => request.url.includes(`/beacon/${name}?`)),
      true,
      `the ${name} worker's request must appear in the baseline arm's request evidence`
    );
  }
  assert.equal(result.requests.length, measurement!.evidence.requests.length);
});

test("a worker the GPC arm cannot attest runs untouched and is disclosed as exactly one loss unit", { timeout: 40_000 }, async (t) => {
  const { server, beacons } = workerMatrixUpstream({ sharedWorkerOnly: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  t.after(() => closeSharedBrowserForTests());
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const { result, measurement } = await scanSiteWithMeasurement(
    { url: "http://shared-worker.test/", device: "desktop", gpcEnabled: true, consentMode: "observe" },
    scanOptions(address.port)
  );

  // The shared worker RAN: unverifiable no longer means blocked, and the site
  // keeps the worker it asked for. Its realm was never attested, so it
  // reports no signal, and the run says so instead of silently passing it.
  const shared = beacons.find((beacon) => beacon.name === "shared");
  assert.notEqual(shared, undefined, "the shared worker must run; unverifiable is not blocked");
  assert.equal(shared?.gpc, "undefined");
  assert.equal(result.warnings.includes(GPC_WORKER_CAPTURE_LOSS_WARNING), true);
  const losses = nullDetailDroppedRequestLoss(measurement!.measurement.qualityFacts.captureLoss);
  assert.deepEqual(
    losses.map((loss) => loss.count),
    [1],
    "exactly the one unattested worker is disclosed, not a family-wide smear"
  );
});
