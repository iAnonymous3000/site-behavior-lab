import assert from "node:assert/strict";
import { test } from "node:test";
import {
  R2_DELETE_CANARY_PREFIX,
  runR2DeleteCanary,
  type R2DeleteCanaryBucket
} from "./r2-delete-canary";

const FIXED_NOW = new Date("2026-07-21T19:15:30.000Z");
const FIXED_UUID = "9e4d2f9e-ccaa-4cc7-a6bf-8cf2fdf56311";

test("the R2 delete canary creates, reads, deletes, and proves absence under its fixed prefix", async () => {
  const bucket = memoryBucket();

  const result = await runR2DeleteCanary(bucket.api, {
    now: () => FIXED_NOW,
    randomUUID: () => FIXED_UUID
  });

  assert.deepEqual(result, {
    keyPrefix: R2_DELETE_CANARY_PREFIX,
    created: true,
    readBack: true,
    deleted: true
  });
  assert.equal(bucket.objects.size, 0);
  assert.deepEqual(bucket.operations.map((entry) => entry.action), ["put", "get", "delete", "head"]);
  assert.ok(bucket.operations.every((entry) => entry.key.startsWith(R2_DELETE_CANARY_PREFIX)));
  assert.equal(bucket.operations.some((entry) => entry.key.startsWith("reports/")), false);
});

test("the R2 delete canary cleans up a marker whose readback is inconsistent", async () => {
  const bucket = memoryBucket({ corruptReadback: true });

  await assert.rejects(
    runR2DeleteCanary(bucket.api, { now: () => FIXED_NOW, randomUUID: () => FIXED_UUID }),
    /readback did not match/
  );

  assert.equal(bucket.objects.size, 0);
  assert.deepEqual(bucket.operations.map((entry) => entry.action), ["put", "get", "delete", "head"]);
});

test("the R2 delete canary fails closed when deletion cannot be proven", async () => {
  const bucket = memoryBucket({ failDelete: true });

  await assert.rejects(
    runR2DeleteCanary(bucket.api, { now: () => FIXED_NOW, randomUUID: () => FIXED_UUID }),
    /delete failed/
  );

  assert.equal(bucket.objects.size, 1);
  assert.deepEqual(bucket.operations.map((entry) => entry.action), ["put", "get", "delete"]);
});

test("callers cannot redirect the R2 delete canary into a report prefix", async () => {
  const bucket = memoryBucket();

  await assert.rejects(
    runR2DeleteCanary(bucket.api, {
      now: () => FIXED_NOW,
      randomUUID: () => FIXED_UUID,
      prefix: "reports/"
    }),
    /prefix must remain/
  );

  assert.deepEqual(bucket.operations, []);
});

test("an invalid random identifier is rejected before R2 is touched", async () => {
  const bucket = memoryBucket();

  await assert.rejects(
    runR2DeleteCanary(bucket.api, { now: () => FIXED_NOW, randomUUID: () => "../report" }),
    /invalid random UUID/
  );

  assert.deepEqual(bucket.operations, []);
});

function memoryBucket(options: { corruptReadback?: boolean; failDelete?: boolean } = {}) {
  const objects = new Map<string, string>();
  const operations: Array<{ action: "put" | "get" | "delete" | "head"; key: string }> = [];
  const api: R2DeleteCanaryBucket = {
    async put(key, value, putOptions) {
      operations.push({ action: "put", key });
      assert.deepEqual(putOptions.onlyIf, { etagDoesNotMatch: "*" });
      if (objects.has(key)) return null;
      objects.set(key, value);
      return { key };
    },
    async get(key) {
      operations.push({ action: "get", key });
      const value = objects.get(key);
      if (value === undefined) return null;
      return { text: async () => options.corruptReadback ? `${value}corrupt` : value };
    },
    async delete(key) {
      operations.push({ action: "delete", key });
      if (options.failDelete) throw new Error("delete failed");
      objects.delete(key);
    },
    async head(key) {
      operations.push({ action: "head", key });
      return objects.has(key) ? { key } : null;
    }
  };
  return { api, objects, operations };
}
