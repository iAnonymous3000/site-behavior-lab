import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { DurableScanJobPayload } from "./durable-scan-job-contract";
import {
  admitDurableScanJob,
  createDurableScanJobAdmission,
  findDurableScanJobSnapshot,
  importDurableScanJobEncryptionKey,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";
import { settleSynchronizeAndPurgeDurableScanJobs } from "./durable-scan-job-retention";
import type { EncryptedWatchPayload } from "./encrypted-watch-contract";
import {
  EncryptedWatchStateError,
  admitEncryptedWatch,
  createEncryptedWatchAdmission,
  createEncryptedWatchCredential,
  findEncryptedWatchByCapability,
  importEncryptedWatchKeyring,
  recordEncryptedWatchRunTerminalOutcome
} from "./encrypted-watch-store";

const DURABLE_KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
  "base64url"
);
const WATCH_KEY = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => 255 - index)).toString(
  "base64url"
);

test("a coordinator outage beyond the purge horizon records terminal watch truth before deletion", async () => {
  await withDatabase(async (database, sql) => {
    const createdAt = 10_000;
    const jobId = idFor(1);
    const reportId = idFor(10_001);
    const [durableKey, watchKeyring, credential] = await Promise.all([
      importDurableScanJobEncryptionKey(DURABLE_KEY),
      importEncryptedWatchKeyring({ current: WATCH_KEY }),
      createEncryptedWatchCredential((length) => deterministicBytes(length, 7))
    ]);
    const [durableAdmission, watchAdmission] = await Promise.all([
      createDurableScanJobAdmission(durableKey, {
        jobId,
        reportId,
        createdAt,
        payload: durablePayload(createdAt)
      }),
      createEncryptedWatchAdmission(
        watchKeyring,
        {
          credential,
          createdAt,
          payload: watchPayload(),
          initialRun: { jobId, reportId, admittedAt: createdAt }
        },
        (length) => deterministicBytes(length, 11)
      )
    ]);
    inTransaction(database, () => {
      admitDurableScanJob(sql, durableAdmission);
      admitEncryptedWatch(sql, watchAdmission);
    });

    // Model a coordinator that performs no lease/deadline maintenance until
    // after the immutable 75-minute retention horizon.
    const recoveredAt = durableAdmission.purgeAt + 1;
    const result = inTransaction(database, () =>
      settleSynchronizeAndPurgeDurableScanJobs(sql, recoveredAt)
    );

    assert.deepEqual(result, { settled: 1, synchronized: 1, purged: 1 });
    assert.equal(findDurableScanJobSnapshot(sql, jobId), null);
    const watch = findEncryptedWatchByCapability(sql, {
      watchId: credential.watchId,
      capabilityHash: credential.tokenHash,
      now: recoveredAt
    });
    assert.equal(watch?.history[0]?.terminalOutcome, "expired");
    assert.equal(watch?.history[0]?.terminalErrorCode, "deadline");
    assert.equal(watch?.history[0]?.terminalAt, recoveredAt);
  });
});

test("a contradictory watch outcome rolls back hard-purge settlement and deletion", async () => {
  await withDatabase(async (database, sql) => {
    const createdAt = 20_000;
    const jobId = idFor(2);
    const reportId = idFor(10_002);
    const [durableKey, watchKeyring, credential] = await Promise.all([
      importDurableScanJobEncryptionKey(DURABLE_KEY),
      importEncryptedWatchKeyring({ current: WATCH_KEY }),
      createEncryptedWatchCredential((length) => deterministicBytes(length, 17))
    ]);
    const durableAdmission = await createDurableScanJobAdmission(durableKey, {
      jobId,
      reportId,
      createdAt,
      payload: durablePayload(createdAt)
    });
    const watchAdmission = await createEncryptedWatchAdmission(
      watchKeyring,
      {
        credential,
        createdAt,
        payload: watchPayload(),
        initialRun: { jobId, reportId, admittedAt: createdAt }
      },
      (length) => deterministicBytes(length, 19)
    );
    inTransaction(database, () => {
      admitDurableScanJob(sql, durableAdmission);
      admitEncryptedWatch(sql, watchAdmission);
      recordEncryptedWatchRunTerminalOutcome(sql, {
        jobId,
        now: createdAt + 1,
        resolution: { outcome: "succeeded" }
      });
    });

    assert.throws(
      () =>
        inTransaction(database, () =>
          settleSynchronizeAndPurgeDurableScanJobs(sql, durableAdmission.purgeAt)
        ),
      EncryptedWatchStateError
    );
    assert.equal(
      findDurableScanJobSnapshot(sql, jobId)?.state,
      "queued",
      "the enclosing transaction must roll back terminalization when history cannot agree"
    );
    assert.equal(
      findEncryptedWatchByCapability(sql, {
        watchId: credential.watchId,
        capabilityHash: credential.tokenHash,
        now: durableAdmission.purgeAt
      })?.history[0]?.terminalOutcome,
      "succeeded"
    );
  });
});

function durablePayload(createdAt: number): DurableScanJobPayload {
  return {
    version: 1,
    url: "https://private.example/sensitive-path",
    device: "desktop",
    gpcEnabled: false,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: 1,
    admittedAt: createdAt,
    reportMode: "r2",
    alreadyCharged: true
  };
}

function watchPayload(): EncryptedWatchPayload {
  return {
    version: 1,
    target: { url: "https://private.example/sensitive-path" },
    options: { device: "desktop", gpcEnabled: false, reportMode: "r2", comparison: "none" }
  };
}

function idFor(index: number): string {
  return `20260721-${index.toString(16).padStart(32, "0")}`;
}

function deterministicBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (seed * 17 + index * 29 + 11) % 256);
}

function inTransaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = callback();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function withDatabase(
  callback: (database: DatabaseSync, sql: DurableScanJobStoreSql) => Promise<void> | void
): Promise<void> {
  const database = new DatabaseSync(":memory:");
  try {
    const sql: DurableScanJobStoreSql = {
      exec<T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: Array<ArrayBuffer | string | number | null>
      ) {
        const statement = database.prepare(query);
        const sqliteBindings = bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding
        );
        const isRead = /^\s*(SELECT|PRAGMA)\b/i.test(query);
        const rows = isRead
          ? statement.all(...sqliteBindings).map((row) => normalizeSqliteRow(row) as T)
          : [];
        if (!isRead) statement.run(...sqliteBindings);
        return { toArray: () => rows };
      }
    };
    await callback(database, sql);
  } finally {
    database.close();
  }
}

function normalizeSqliteRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        : value
    ])
  );
}
