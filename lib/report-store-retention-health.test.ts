import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReportStoreRetentionHealthProbe,
  type ReportStoreRetentionHealthProbeResult
} from "./report-store-retention-health";
import type { ReportStoreMaintenanceStatus, ReportStoreRetentionStatus } from "./report-store";

const HEALTHY: ReportStoreMaintenanceStatus = {
  debtCount: 0,
  maintenanceRequired: false,
  continuationPending: false,
  healthy: true,
  capacityExhausted: false
};

test("concurrent health calls share one retention maintenance pass", async () => {
  let calls = 0;
  let release: ((value: ReportStoreMaintenanceStatus) => void) | undefined;
  const probe = createReportStoreRetentionHealthProbe(
    () => {
      calls += 1;
      return new Promise<ReportStoreMaintenanceStatus>((resolve) => {
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
    continuationPending: false,
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
  // The ledger read carries no capacity, and a pass that rejected read none.
  assert.deepEqual(failed.retention, { ...debt, capacityExhausted: false });
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

test("a maintenance pass that rejected is never reported as a continuation", async () => {
  // After a pass rejects, the ledger can read back with the maintenance flag
  // set and no debt, which on its own is the continuation state. The rejection
  // is what the publication rule refuses on, so the probe must not let that
  // reading through as healthy.
  const ledgerAfterFailure: ReportStoreRetentionStatus = {
    debtCount: 0,
    maintenanceRequired: true,
    continuationPending: true,
    healthy: true
  };
  const probe = createReportStoreRetentionHealthProbe(
    async () => {
      throw new Error("list denied");
    },
    async () => ledgerAfterFailure,
    { now: () => 1_000 }
  );

  const failed = await probe();
  assert.equal(failed.error, "list denied");
  assert.deepEqual(failed.retention, {
    debtCount: 0,
    maintenanceRequired: true,
    continuationPending: false,
    healthy: false,
    capacityExhausted: false
  });
});

test("the pass's capacity verdict reaches health beside a healthy retention verdict", async () => {
  // A full store has failed at nothing, so its retention is healthy. Health
  // must still learn that a publication would be refused.
  const full: ReportStoreMaintenanceStatus = { ...HEALTHY, capacityExhausted: true };
  const probe = createReportStoreRetentionHealthProbe(
    async () => full,
    async () => HEALTHY,
    { now: () => 1_000 }
  );

  const result = await probe();
  assert.equal(result.error, null);
  assert.deepEqual(result.retention, full);
});
