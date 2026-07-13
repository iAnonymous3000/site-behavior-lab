import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { emitShadowScanReportV2R2, v2ShadowEmissionEnabled } from "./scan-report-v2-emission";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import { closeSharedBrowserForTests, scanSite } from "./scanner";

test("v2ShadowEmissionEnabled reads only the exact opt-in value", () => {
  assert.equal(v2ShadowEmissionEnabled({}), false);
  assert.equal(v2ShadowEmissionEnabled({ SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION: "1" }), true);
  assert.equal(v2ShadowEmissionEnabled({ SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION: "0" }), false);
});

test("a real visit shadow-emits a validator-clean public r2 wire", { timeout: 30_000 }, async () => {
  const upstream = createServer((request, response) => {
    if (request.url === "/asset.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end("void 0;");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><title>Shadow emission fixture</title><script src="/asset.js"></script><p>private-fixture-Alice</p>'
    );
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const shadowDir = await mkdtemp(path.join(tmpdir(), "sbl-v2-shadow-"));
  // The observe-mode banner-visibility read keeps the always-on consent
  // detector out of its default state, which the r2 builder rejects.
  process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION = "1";
  try {
    const result = await scanSite(
      {
        url: "http://shadow.example.com/private-path-Alice/",
        device: "desktop",
        gpcEnabled: true,
        consentMode: "observe"
      },
      {
        publicUrlAlreadyVerified: true,
        verifyPublicUrl: async () => undefined,
        resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
        connectProxyUpstreamForTests: () => connect(address.port, "127.0.0.1"),
        resolveCnameChain: async () => []
      }
    );

    // Flag off: nothing happens.
    delete process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION;
    assert.deepEqual(await emitShadowScanReportV2R2(result, "public-api"), { status: "disabled" });

    process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION = "1";
    process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_DIR = shadowDir;

    // Controlled means provenance-complete: no build commit, no emission.
    delete process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT;
    assert.deepEqual(await emitShadowScanReportV2R2(result, "public-api"), {
      status: "skipped",
      reason: "build-provenance-missing"
    });
    process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT = "b".repeat(40);

    // A result without its process-local staged facts cannot emit.
    assert.deepEqual(await emitShadowScanReportV2R2({ ...result }, "public-api"), {
      status: "skipped",
      reason: "no-staged-measurement"
    });

    const outcome = await emitShadowScanReportV2R2(result, "public-api");
    assert.equal(outcome.status, "written");
    if (outcome.status !== "written") throw new Error("expected a written shadow report");
    assert.deepEqual(await readdir(shadowDir), [`${outcome.runId}.json`]);

    const wire = JSON.parse(await readFile(outcome.filePath, "utf8")) as Record<string, unknown>;
    assert.equal(isPublicScanReportV2R2(wire), true);
    assert.deepEqual(scanReportV2R2SemanticViolations(wire as never), []);
    const serialized = JSON.stringify(wire);
    // The builder's own redaction applied: the raw path never reaches disk,
    // and the ephemeral screenshot never survives projection.
    assert.equal(serialized.includes("private-path-Alice"), false);
    assert.equal(serialized.includes("screenshot"), false);
    const run = wire.run as { subject: { requested: { registrableDomain: string } }; provenance: { acquisition: string } };
    assert.equal(run.subject.requested.registrableDomain, "example.com");
    assert.equal(run.provenance.acquisition, "public-api");

    // The v1 result the caller returns is untouched by emission.
    assert.equal(result.schemaVersion, 1);
  } finally {
    delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    delete process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION;
    delete process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_DIR;
    delete process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT;
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(shadowDir, { recursive: true, force: true });
  }
});
