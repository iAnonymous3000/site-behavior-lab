import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReportStoreRetentionHealthProbe,
  type ReportStoreRetentionHealthProbeResult
} from "./report-store-retention-health";
import type { ReportStoreRetentionStatus } from "./report-store";

const HEALTHY: ReportStoreRetentionStatus = {
  debtCount: 0,
  maintenanceRequired: false,
  healthy: true
};

test("concurrent health calls share one retention maintenance pass", async () => {
  let calls = 0;
  let release: ((value: ReportStoreRetentionStatus) => void) | undefined;
  const probe = createReportStoreRetentionHealthProbe(
    () => {
      calls += 1;
      return new Promise<ReportStoreRetentionStatus>((resolve) => {
        release = resolve;
      });
    },
    async () => HEALTHY,
    { now: () => 1_000 }
  );

  const first = probe();
  const second = probe();
  assert.equal(calls, 1);
  release?.(HEALTHY);
  assert.strictEqual(await first, await second);
  assert.equal(calls, 1);
});

test("successful health retention state is reused within TTL and rerun at expiry", async () => {
  let now = 10_000;
  let calls = 0;
  const probe = createReportStoreRetentionHealthProbe(
    async () => {
      calls += 1;
      return HEALTHY;
    },
    async () => HEALTHY,
    { now: () => now, successTtlMs: 30_000 }
  );

  const first = await probe();
  now += 29_999;
  assert.strictEqual(await probe(), first);
  assert.equal(calls, 1);
  now += 1;
  const refreshed = await probe();
  assert.equal(calls, 2);
  assert.notStrictEqual(refreshed, first);
  assert.equal(refreshed.checkedAt, new Date(now).toISOString());
});

test("failed maintenance is short-cached only as unhealthy and retries after failure TTL", async () => {
  let now = 50_000;
  let calls = 0;
  const debt: ReportStoreRetentionStatus = {
    debtCount: 2,
    maintenanceRequired: true,
    healthy: false
  };
  const probe = createReportStoreRetentionHealthProbe(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("delete denied");
      return HEALTHY;
    },
    async () => debt,
    { now: () => now, successTtlMs: 30_000, failureTtlMs: 5_000 }
  );

  const failed: ReportStoreRetentionHealthProbeResult = await probe();
  assert.equal(failed.error, "delete denied");
  assert.deepEqual(failed.retention, debt);
  assert.equal(failed.stateObserved, true);
  assert.equal(failed.retention.healthy, false);
  now += 4_999;
  assert.strictEqual(await probe(), failed);
  assert.equal(calls, 1);
  now += 1;
  const recovered = await probe();
  assert.equal(calls, 2);
  assert.equal(recovered.error, null);
  assert.equal(recovered.retention.healthy, true);
});
