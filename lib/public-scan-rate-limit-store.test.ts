import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  assertPublicScanRateLimitCharge,
  chargePublicScanRateLimit,
  commitPublicScanRateLimitedOperation,
  peekPublicScanRateLimit,
  publicScanRateLimitChargeMatchesCost,
  type PublicScanRateLimitCharge
} from "./public-scan-rate-limit-store";
import {
  DurableScanJobCapacityError,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";

const CLIENT_HASH = "a".repeat(64);

test("edge quota cost must match the strict Node preparation cost", () => {
  const input: PublicScanRateLimitCharge = {
    scope: "public",
    clientHash: CLIENT_HASH,
    cost: 2,
    perMinute: 6,
    perDay: 120
  };
  assert.equal(publicScanRateLimitChargeMatchesCost(input, 2), true);
  assert.equal(publicScanRateLimitChargeMatchesCost(input, 1), false);
  assert.throws(
    () => assertPublicScanRateLimitCharge({ ...input, clientHash: "raw-client-ip" }),
    /client hash/i
  );
});

test("public quota peek is non-consuming and a refusal never partially charges a window", () => {
  withDatabase((database, sql) => {
    const input: PublicScanRateLimitCharge = {
      scope: "public",
      clientHash: CLIENT_HASH,
      cost: 2,
      perMinute: 2,
      perDay: 2
    };
    const now = 60_001;

    assert.deepEqual(peekPublicScanRateLimit(sql, input, now), { allowed: true });
    assert.equal(rateLimitRows(database).length, 0);
    assert.deepEqual(chargePublicScanRateLimit(sql, input, now), { allowed: true });
    assert.deepEqual(rateLimitRows(database), [
      { bucket: `day/0/${CLIENT_HASH}`, used: 2 },
      { bucket: `minute/1/${CLIENT_HASH}`, used: 2 }
    ]);

    const refused = chargePublicScanRateLimit(sql, { ...input, cost: 1 }, now);
    assert.equal(refused.allowed, false);
    assert.deepEqual(rateLimitRows(database), [
      { bucket: `day/0/${CLIENT_HASH}`, used: 2 },
      { bucket: `minute/1/${CLIENT_HASH}`, used: 2 }
    ]);
  });
});

test("authenticated durable quota keeps comparison cost two and explicitly disables the day window", () => {
  withDatabase((database, sql) => {
    const input: PublicScanRateLimitCharge = {
      scope: "authenticated",
      clientHash: CLIENT_HASH,
      cost: 2,
      perMinute: 20,
      perDay: null
    };

    assert.deepEqual(chargePublicScanRateLimit(sql, input, 60_001), { allowed: true });
    assert.deepEqual(authenticatedRateLimitRows(database), [
      { clientHash: CLIENT_HASH, chargedAt: 60_001, cost: 2 }
    ]);
  });
});

test("authenticated durable quota preserves the Node rolling sixty-second window across minute boundaries", () => {
  withDatabase((_database, sql) => {
    const input: PublicScanRateLimitCharge = {
      scope: "authenticated",
      clientHash: CLIENT_HASH,
      cost: 1,
      perMinute: 20,
      perDay: null
    };
    for (let token = 0; token < 20; token += 1) {
      assert.deepEqual(chargePublicScanRateLimit(sql, input, 59_999), { allowed: true });
    }

    assert.deepEqual(chargePublicScanRateLimit(sql, input, 60_001), {
      allowed: false,
      retryAfterSeconds: 60
    });
    assert.deepEqual(chargePublicScanRateLimit(sql, input, 119_999), { allowed: true });
  });
});

test("a rate-limited admission operation commits once and never runs on refusal", () => {
  withDatabase((database, sql) => {
    const input: PublicScanRateLimitCharge = {
      scope: "public",
      clientHash: CLIENT_HASH,
      cost: 2,
      perMinute: 2,
      perDay: 2
    };
    let admissions = 0;

    const accepted = commitPublicScanRateLimitedOperation(sql, input, 60_001, () => {
      admissions += 1;
      return "job-row";
    });
    assert.deepEqual(accepted, { status: "committed", value: "job-row" });
    assert.equal(admissions, 1);

    const refused = commitPublicScanRateLimitedOperation(sql, input, 60_001, () => {
      admissions += 1;
      return "ghost-row";
    });
    assert.equal(refused.status, "rate-limited");
    assert.equal(admissions, 1);
    assert.deepEqual(rateLimitRows(database), [
      { bucket: `day/0/${CLIENT_HASH}`, used: 2 },
      { bucket: `minute/1/${CLIENT_HASH}`, used: 2 }
    ]);
  });
});

test("a late durable-capacity failure rolls a tentative quota charge back", () => {
  withDatabase((database, sql) => {
    const input: PublicScanRateLimitCharge = {
      scope: "public",
      clientHash: CLIENT_HASH,
      cost: 1,
      perMinute: 6,
      perDay: 120
    };
    // Establish the shared table without consuming quota, as the DO preflight
    // does before the final admission transaction.
    assert.deepEqual(peekPublicScanRateLimit(sql, input, 60_001), { allowed: true });

    database.exec("BEGIN IMMEDIATE");
    assert.throws(() => {
      commitPublicScanRateLimitedOperation(sql, input, 60_001, () => {
        throw new DurableScanJobCapacityError();
      });
    }, DurableScanJobCapacityError);
    database.exec("ROLLBACK");

    assert.deepEqual(rateLimitRows(database), []);
  });
});

function rateLimitRows(database: DatabaseSync): Array<{ bucket: string; used: number }> {
  return database
    .prepare("SELECT bucket, used FROM public_scan_rate_limits ORDER BY bucket")
    .all()
    .map((row) => ({ bucket: String(row.bucket), used: Number(row.used) }));
}

function authenticatedRateLimitRows(
  database: DatabaseSync
): Array<{ clientHash: string; chargedAt: number; cost: number }> {
  return database
    .prepare("SELECT client_hash, charged_at, cost FROM authenticated_scan_rate_limits ORDER BY id")
    .all()
    .map((row) => ({
      clientHash: String(row.client_hash),
      chargedAt: Number(row.charged_at),
      cost: Number(row.cost)
    }));
}

function withDatabase(callback: (database: DatabaseSync, sql: DurableScanJobStoreSql) => void): void {
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
    callback(database, sql);
  } finally {
    database.close();
  }
}

function normalizeSqliteRow(row: Record<string, unknown>): Record<string, ArrayBuffer | string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? Uint8Array.from(value).buffer
        : (value as string | number | null)
    ])
  );
}
