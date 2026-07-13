import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { makeGpcInterventionReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import type { EphemeralComparisonReportR2, EphemeralSingleReportR2 } from "./scan-report-v2-r2";
import {
  V2_SHADOW_BACKEND_ENV,
  V2_SHADOW_DIR_ENV,
  shadowR2Config,
  v2ShadowStoreStatus,
  writeV2ShadowArtifact
} from "./scan-report-v2-shadow-store";

const BUILD = "f".repeat(40);
const R2_ENV: NodeJS.ProcessEnv = {
  SITE_BEHAVIOR_LAB_R2_BUCKET: "reports-bucket",
  SITE_BEHAVIOR_LAB_R2_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID: "ak",
  SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: "sk"
};

function single(): EphemeralSingleReportR2 {
  return { ...makePublicSingleReportV2R2(), ephemeral: { screenshot: "PRIVATE" } };
}

function comparison(): EphemeralComparisonReportR2 {
  return {
    ...makeGpcInterventionReportV2R2(),
    ephemeral: { baselineScreenshot: "BASELINE_PRIVATE", variantScreenshot: "VARIANT_PRIVATE" }
  };
}

test("filesystem shadow writes are create-only and return no public URL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sbl-shadow-store-"));
  const env = { [V2_SHADOW_DIR_ENV]: directory, SITE_BEHAVIOR_LAB_BUILD_COMMIT: BUILD };
  const report = single();
  try {
    const receipt = await writeV2ShadowArtifact(report, env);
    assert.deepEqual(receipt, {
      sink: "filesystem",
      key: `${report.run.runId}.json`,
      filePath: path.join(directory, `${report.run.runId}.json`)
    });
    const stored = await readFile(receipt.filePath, "utf8");
    assert.equal(stored.includes("PRIVATE"), false);
    assert.equal(stored.includes("ephemeral"), false);
    await assert.rejects(
      () => writeV2ShadowArtifact(report, env),
      /EEXIST/
    );
    assert.equal(await readFile(receipt.filePath, "utf8"), stored);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("R2 shadow writes use the private build-pinned prefix and the shared create-only backend", async () => {
  const writes: Array<{ id: string; contents: string }> = [];
  let receivedConfig: ReturnType<typeof shadowR2Config> | undefined;
  const report = comparison();
  if (report.experiment.kind !== "intervention") throw new Error("fixture invariant");
  const receipt = await writeV2ShadowArtifact(
    report,
    { ...R2_ENV, [V2_SHADOW_BACKEND_ENV]: "r2", SITE_BEHAVIOR_LAB_BUILD_COMMIT: BUILD },
    {
      createR2Backend: (config) => {
        receivedConfig = config;
        return {
          async write(id, contents) {
            writes.push({ id, contents });
          }
        };
      }
    }
  );

  assert.equal(receivedConfig?.prefix, `v2-shadow/${BUILD}/comparison/`);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].id, report.experiment.pairId);
  assert.equal(writes[0].contents.includes("BASELINE_PRIVATE"), false);
  assert.equal(writes[0].contents.includes("ephemeral"), false);
  assert.deepEqual(receipt, {
    sink: "r2",
    key: `v2-shadow/${BUILD}/comparison/${report.experiment.pairId}.json`
  });
});

test("shadow R2 config ignores the public report prefix", () => {
  const config = shadowR2Config({ ...R2_ENV, SITE_BEHAVIOR_LAB_R2_PREFIX: "reports/" }, BUILD, "single");
  assert.equal(config.prefix, `v2-shadow/${BUILD}/single/`);
});

test("shadow status fails closed on invalid backends and missing R2 configuration", () => {
  assert.deepEqual(v2ShadowStoreStatus({}), { sink: "filesystem", error: null });
  assert.equal(v2ShadowStoreStatus({ [V2_SHADOW_BACKEND_ENV]: "memory" }).sink, "unavailable");
  assert.equal(
    v2ShadowStoreStatus({ [V2_SHADOW_BACKEND_ENV]: "r2", SITE_BEHAVIOR_LAB_BUILD_COMMIT: BUILD }).sink,
    "unavailable"
  );
  assert.equal(
    v2ShadowStoreStatus({ SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION: "1" }).sink,
    "unavailable"
  );
  assert.deepEqual(
    v2ShadowStoreStatus({
      ...R2_ENV,
      [V2_SHADOW_BACKEND_ENV]: "r2",
      SITE_BEHAVIOR_LAB_BUILD_COMMIT: BUILD
    }),
    { sink: "r2", error: null }
  );
});

test("shadow artifact identifiers and build provenance are runtime validated", async () => {
  const invalidId = single();
  invalidId.run.runId = "../escape";
  await assert.rejects(
    () => writeV2ShadowArtifact(invalidId, { SITE_BEHAVIOR_LAB_BUILD_COMMIT: BUILD }),
    /opaque token/
  );
  await assert.rejects(
    () => writeV2ShadowArtifact(single(), { SITE_BEHAVIOR_LAB_BUILD_COMMIT: "main" }),
    /full lowercase Git SHA/
  );
  await assert.rejects(
    () => writeV2ShadowArtifact(single(), { SITE_BEHAVIOR_LAB_BUILD_COMMIT: "a".repeat(40) }),
    /build provenance disagrees/
  );
});
