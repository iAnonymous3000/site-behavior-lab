import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executePreparedScan, type PreparedScanRequest } from "./scan-api";
import {
  emitShadowComparisonScanReportV2R2,
  emitShadowScanReportV2R2,
  v2ShadowEmissionEnabled
} from "./scan-report-v2-emission";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import {
  attachStagedSingleVisitMeasurement,
  closeSharedBrowserForTests,
  scanSite,
  stagedSingleVisitMeasurement
} from "./scanner";
import type { ScanReport } from "./types";

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
  const info = console.info;
  const infoEntries: unknown[][] = [];
  console.info = (...args: unknown[]) => {
    infoEntries.push(args);
  };
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
    assert.equal(outcome.sink, "filesystem");
    if (outcome.sink !== "filesystem") throw new Error("expected a filesystem shadow report");
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

    // A comparison emits one complete pair artifact, not one single artifact
    // per visit. Clone the real staged visit into canonical GPC off/on arms so
    // the pair path exercises the same scanner-to-builder seam without a
    // second browser launch.
    const realStaged = stagedSingleVisitMeasurement(result);
    assert.notEqual(realStaged, null);
    if (realStaged === null) throw new Error("expected staged measurement");
    const baselineStaged = structuredClone(realStaged);
    const variantStaged = structuredClone(realStaged);
    baselineStaged.emissionInputs.startedAt = "2026-07-13T20:00:00.000Z";
    variantStaged.emissionInputs.startedAt = "2026-07-13T20:01:00.000Z";
    baselineStaged.emissionInputs.conditions.gpc = false;
    variantStaged.emissionInputs.conditions.gpc = true;
    baselineStaged.verificationFacts.gpc = {
      method: "gpc-header-readback@1",
      header: "confirmed-absent",
      jsSignal: "confirmed-absent",
      observedOn: "first-party-navigation",
      phaseId: 0
    };
    variantStaged.verificationFacts.gpc = {
      method: "gpc-header-readback@1",
      header: "confirmed-present",
      jsSignal: "confirmed-true",
      observedOn: "first-party-navigation",
      phaseId: 0
    };
    const baselineResult = attachStagedSingleVisitMeasurement({ ...result }, baselineStaged);
    const variantResult = attachStagedSingleVisitMeasurement({ ...result }, variantStaged);
    const pairDir = path.join(shadowDir, "pairs");
    process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_DIR = pairDir;
    const pairOutcome = await emitShadowComparisonScanReportV2R2(
      baselineResult,
      variantResult,
      "baseline",
      "public-api"
    );
    assert.equal(pairOutcome.status, "written");
    if (pairOutcome.status !== "written") throw new Error("expected a written shadow comparison");
    assert.equal(pairOutcome.sink, "filesystem");
    if (pairOutcome.sink !== "filesystem") throw new Error("expected a filesystem shadow comparison");
    assert.deepEqual(await readdir(pairDir), [`${pairOutcome.pairId}.json`]);
    const pairWire = JSON.parse(await readFile(pairOutcome.filePath, "utf8")) as Record<string, unknown>;
    assert.equal(pairWire.reportType, "comparison");
    assert.equal(isPublicScanReportV2R2(pairWire), true);
    assert.deepEqual(scanReportV2R2SemanticViolations(pairWire as never), []);
    assert.equal(JSON.stringify(pairWire).includes("screenshot"), false);
    const pairLog = infoEntries.find(
      (entry) => entry[0] === "Shadow v2/r2 emission written." &&
        (entry[1] as { reportType?: string } | undefined)?.reportType === "comparison"
    );
    assert.deepEqual(pairLog?.[1], {
      sink: "filesystem",
      key: `${pairOutcome.pairId}.json`,
      reportType: "comparison",
      pairId: pairOutcome.pairId,
      baselineRunId: pairOutcome.baselineRunId,
      variantRunId: pairOutcome.variantRunId,
      axis: "gpc",
      order: "AB",
      buildCommit: "b".repeat(40)
    });
    assert.equal(JSON.stringify(pairLog).includes("private-path-Alice"), false);
    assert.deepEqual(
      await emitShadowComparisonScanReportV2R2({ ...baselineResult }, variantResult, "baseline", "public-api"),
      { status: "skipped", reason: "no-staged-measurement" }
    );
    assert.deepEqual(await readdir(pairDir), [`${pairOutcome.pairId}.json`]);

    // Prove the real API orchestration emits exactly one pair artifact in both
    // scheduler orders. This would fail if executePreparedScan regressed to
    // per-visit single emission or omitted the pair emission call.
    const prepared: PreparedScanRequest = {
      clientKey: "shadow-pair-test",
      url: "http://shadow.example.com/private-path-Alice/",
      device: "desktop",
      gpcEnabled: true,
      compareGpc: true,
      compareShields: false,
      compareConsent: false,
      rateLimitCost: 2
    };
    const keepReport = async <T extends ScanReport>(report: T): Promise<T> => report;
    for (const executedFirst of ["baseline", "variant"] as const) {
      const apiPairDir = path.join(shadowDir, `api-${executedFirst}`);
      process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_DIR = apiPairDir;
      let visitIndex = 0;
      const shadowTasks: Promise<unknown>[] = [];
      const apiResult = await executePreparedScan(
        prepared,
        async (payload) => {
          const staged = structuredClone(realStaged);
          staged.emissionInputs.startedAt =
            visitIndex++ === 0 ? "2026-07-13T21:00:00.000Z" : "2026-07-13T21:01:00.000Z";
          staged.emissionInputs.conditions.gpc = payload.gpcEnabled;
          staged.verificationFacts.gpc = payload.gpcEnabled
            ? {
                method: "gpc-header-readback@1",
                header: "confirmed-present",
                jsSignal: "confirmed-true",
                observedOn: "first-party-navigation",
                phaseId: 0
              }
            : {
                method: "gpc-header-readback@1",
                header: "confirmed-absent",
                jsSignal: "confirmed-absent",
                observedOn: "first-party-navigation",
                phaseId: 0
              };
          return attachStagedSingleVisitMeasurement(
            { ...result, conditions: { ...result.conditions, gpcEnabled: payload.gpcEnabled } },
            staged
          );
        },
        keepReport,
        undefined,
        false,
        {
          drawComparisonFirstArm: () => executedFirst,
          schedulePostPublication: (task) => {
            shadowTasks.push(task());
          }
        }
      );
      await Promise.all(shadowTasks);
      assert.equal(apiResult.reportType, "comparison");
      const apiFiles = await readdir(apiPairDir);
      assert.equal(apiFiles.length, 1);
      const apiWire = JSON.parse(await readFile(path.join(apiPairDir, apiFiles[0]), "utf8")) as {
        reportType: string;
        experiment: { order: string };
      };
      assert.equal(apiWire.reportType, "comparison");
      assert.equal(apiWire.experiment.order, executedFirst === "baseline" ? "AB" : "BA");
    }

    // The v1 result the caller returns is untouched by emission.
    assert.equal(result.schemaVersion, 1);
  } finally {
    console.info = info;
    delete process.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION;
    delete process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION;
    delete process.env.SITE_BEHAVIOR_LAB_V2_SHADOW_DIR;
    delete process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT;
    await closeSharedBrowserForTests();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(shadowDir, { recursive: true, force: true });
  }
});
