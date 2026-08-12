import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE,
  DURABLE_SCAN_JOB_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE,
  PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS,
  SCAN_ADMISSION_RECOVERY_GLOBAL_RATE_LIMIT_PER_MINUTE,
  assertPublicScanRateLimitCharge,
  chargePublicScanRateLimit,
  chargeDurableScanJobReadRateLimit,
  chargeEncryptedWatchReadRateLimit,
  chargeReportReadRateLimit,
  chargeScanAdmissionRecoveryRateLimit,
  commitPublicScanRateLimitedOperation,
  peekPublicScanRateLimit,
  publicScanRateLimitChargeMatchesCost,
  type PublicScanRateLimitCharge
} from "./public-scan-rate-limit-store";
import {
  REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE,
  REPORT_READ_RATE_LIMIT_PER_MINUTE
} from "./report-read-edge";
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

test("a final commit fence failure rolls quota and callback mutations back together", () => {
  withDatabase((database, sql) => {
    const input: PublicScanRateLimitCharge = {
      scope: "public",
      clientHash: CLIENT_HASH,
      cost: 1,
      perMinute: 6,
      perDay: 120
    };
    database.exec("CREATE TABLE admitted_work (job_id TEXT PRIMARY KEY)");
    assert.deepEqual(peekPublicScanRateLimit(sql, input, 60_001), { allowed: true });

    database.exec("BEGIN IMMEDIATE");
    let mutationFinished = false;
    assert.throws(
      () =>
        commitPublicScanRateLimitedOperation(
          sql,
          input,
          60_001,
          () => {
            database.prepare("INSERT INTO admitted_work (job_id) VALUES (?)").run("late-job");
            mutationFinished = true;
            return "late-job";
          },
          () => {
            assert.equal(mutationFinished, true);
            throw new Error("commit deadline elapsed");
          }
        ),
      /commit deadline elapsed/
    );
    database.exec("ROLLBACK");

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admitted_work").get()?.count, 0);
    assert.deepEqual(rateLimitRows(database), []);
  });
});

test("admission recovery has an atomic global ceiling across rotating client hashes", () => {
  withDatabase((database, sql) => {
    const now = 60_001;
    for (let attempt = 0; attempt < SCAN_ADMISSION_RECOVERY_GLOBAL_RATE_LIMIT_PER_MINUTE; attempt += 1) {
      assert.deepEqual(
        chargeScanAdmissionRecoveryRateLimit(sql, clientHashFor(attempt), now),
        { allowed: true }
      );
    }

    assert.deepEqual(
      chargeScanAdmissionRecoveryRateLimit(
        sql,
        clientHashFor(SCAN_ADMISSION_RECOVERY_GLOBAL_RATE_LIMIT_PER_MINUTE),
        now
      ),
      { allowed: false, retryAfterSeconds: 60 }
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM public_scan_rate_limits").get()?.count,
      SCAN_ADMISSION_RECOVERY_GLOBAL_RATE_LIMIT_PER_MINUTE + 1
    );
    assert.equal(
      database
        .prepare("SELECT used FROM public_scan_rate_limits WHERE bucket = ?")
        .get("scan-admission-recovery-global/1")?.used,
      SCAN_ADMISSION_RECOVERY_GLOBAL_RATE_LIMIT_PER_MINUTE
    );
  });
});

test("admission-recovery cleanup performs bounded work per request", () => {
  withDatabase((database, sql) => {
    database.exec(
      "CREATE TABLE public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
    );
    const insert = database.prepare(
      "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, 1, 60000)"
    );
    const expiredRows = PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS + 17;
    for (let index = 0; index < expiredRows; index += 1) insert.run(`expired/${index}`);

    assert.deepEqual(chargeScanAdmissionRecoveryRateLimit(sql, CLIENT_HASH, 60_001), {
      allowed: true
    });
    const cleanupPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT bucket FROM public_scan_rate_limits
         WHERE expires_at <= ?
         ORDER BY expires_at ASC, bucket ASC
         LIMIT ${PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS}`
      )
      .all(60_001)
      .map((row) => String(row.detail));
    assert.ok(
      cleanupPlan.some((detail) => detail.includes("COVERING INDEX public_scan_rate_limits_expiry")),
      `expected expiry-index cleanup plan, got ${cleanupPlan.join(" | ")}`
    );
    assert.equal(cleanupPlan.some((detail) => detail.includes("USE TEMP B-TREE")), false);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM public_scan_rate_limits WHERE expires_at <= ?")
        .get(60_001)?.count,
      expiredRows - PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS
    );
  });
});

test("rotating durable-status identities hit a global ceiling without unbounded row creation", () => {
  withDatabase((database, sql) => {
    const now = 60_001;
    for (let attempt = 0; attempt < DURABLE_SCAN_JOB_READ_GLOBAL_RATE_LIMIT_PER_MINUTE; attempt += 1) {
      assert.deepEqual(chargeDurableScanJobReadRateLimit(sql, clientHashFor(attempt), now), {
        allowed: true
      });
    }
    for (
      let attempt = DURABLE_SCAN_JOB_READ_GLOBAL_RATE_LIMIT_PER_MINUTE;
      attempt < DURABLE_SCAN_JOB_READ_GLOBAL_RATE_LIMIT_PER_MINUTE + 1_000;
      attempt += 1
    ) {
      assert.deepEqual(chargeDurableScanJobReadRateLimit(sql, clientHashFor(attempt), now), {
        allowed: false,
        retryAfterSeconds: 60
      });
    }
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM public_scan_rate_limits").get()?.count,
      DURABLE_SCAN_JOB_READ_GLOBAL_RATE_LIMIT_PER_MINUTE + 1
    );
  });
});

test("report reads atomically enforce the combined per-client ceiling without a partial global charge", () => {
  withDatabase((database, sql) => {
    const now = 60_001;
    for (let attempt = 0; attempt < REPORT_READ_RATE_LIMIT_PER_MINUTE; attempt += 1) {
      assert.deepEqual(chargeReportReadRateLimit(sql, CLIENT_HASH, now), { allowed: true });
    }
    assert.deepEqual(chargeReportReadRateLimit(sql, CLIENT_HASH, now), {
      allowed: false,
      retryAfterSeconds: 60
    });
    assert.equal(
      database.prepare("SELECT used FROM public_scan_rate_limits WHERE bucket = ?").get("report-read-global/1")?.used,
      REPORT_READ_RATE_LIMIT_PER_MINUTE,
      "a per-client refusal must not consume the otherwise-available global token"
    );
    assert.equal(
      database
        .prepare("SELECT used FROM public_scan_rate_limits WHERE bucket = ?")
        .get(`report-read/1/${CLIENT_HASH}`)?.used,
      REPORT_READ_RATE_LIMIT_PER_MINUTE
    );
  });
});

test("report reads cap rotating identities globally without creating refused client rows", () => {
  withDatabase((database, sql) => {
    const now = 60_001;
    for (let attempt = 0; attempt < REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE; attempt += 1) {
      assert.deepEqual(chargeReportReadRateLimit(sql, clientHashFor(attempt), now), { allowed: true });
    }
    const refusedHash = clientHashFor(REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE);
    assert.deepEqual(chargeReportReadRateLimit(sql, refusedHash, now), {
      allowed: false,
      retryAfterSeconds: 60
    });
    assert.equal(
      database.prepare("SELECT used FROM public_scan_rate_limits WHERE bucket = ?").get("report-read-global/1")?.used,
      REPORT_READ_GLOBAL_RATE_LIMIT_PER_MINUTE
    );
    assert.equal(
      database
        .prepare("SELECT used FROM public_scan_rate_limits WHERE bucket = ?")
        .get(`report-read/1/${refusedHash}`),
      undefined,
      "a global refusal must not create or charge the client bucket"
    );
  });
});

test("ordinary public, status, watch, and report paths all install the shared expiry index", () => {
  for (const charge of [
    (sql: DurableScanJobStoreSql) =>
      chargePublicScanRateLimit(
        sql,
        { scope: "public", clientHash: CLIENT_HASH, cost: 1, perMinute: 6, perDay: 120 },
        60_001
      ),
    (sql: DurableScanJobStoreSql) => chargeDurableScanJobReadRateLimit(sql, CLIENT_HASH, 60_001),
    (sql: DurableScanJobStoreSql) => chargeEncryptedWatchReadRateLimit(sql, CLIENT_HASH, 60_001),
    (sql: DurableScanJobStoreSql) => chargeReportReadRateLimit(sql, CLIENT_HASH, 60_001)
  ]) {
    withDatabase((database, sql) => {
      assert.deepEqual(charge(sql), { allowed: true });
      const indexes = database
        .prepare("PRAGMA index_list(public_scan_rate_limits)")
        .all()
        .map((row) => String(row.name));
      assert.ok(indexes.includes("public_scan_rate_limits_expiry"));
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT bucket FROM public_scan_rate_limits
           WHERE expires_at <= ? ORDER BY expires_at ASC, bucket ASC
           LIMIT ${PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS}`
        )
        .all(60_001)
        .map((row) => String(row.detail));
      assert.ok(plan.some((detail) => detail.includes("COVERING INDEX public_scan_rate_limits_expiry")));
      assert.equal(plan.some((detail) => detail.includes("USE TEMP B-TREE")), false);
    });
  }
});

test("authenticated quota has an atomic global ceiling and indexed bounded expiry cleanup", () => {
  withDatabase((database, sql) => {
    const now = 60_001;
    const input = (index: number): PublicScanRateLimitCharge => ({
      scope: "authenticated",
      clientHash: clientHashFor(index),
      cost: 1,
      perMinute: 20,
      perDay: null
    });
    for (let index = 0; index < AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE; index += 1) {
      assert.deepEqual(chargePublicScanRateLimit(sql, input(index), now), { allowed: true });
    }
    assert.deepEqual(
      chargePublicScanRateLimit(sql, input(AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE), now),
      { allowed: false, retryAfterSeconds: 60 }
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authenticated_scan_rate_limits").get()?.count,
      AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE
    );
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM authenticated_scan_rate_limits
         WHERE charged_at <= ? ORDER BY charged_at ASC, id ASC
         LIMIT ${PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS}`
      )
      .all(0)
      .map((row) => String(row.detail));
    assert.ok(plan.some((detail) => detail.includes("COVERING INDEX authenticated_scan_rate_limits_time")));
    assert.equal(plan.some((detail) => detail.includes("USE TEMP B-TREE")), false);
    const rollingGlobalPlan = database
      .prepare(
        `EXPLAIN QUERY PLAN SELECT charged_at, cost FROM authenticated_scan_rate_limits
         WHERE charged_at > ? ORDER BY charged_at ASC, id ASC
         LIMIT ${AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE + 1}`
      )
      .all(0)
      .map((row) => String(row.detail));
    assert.ok(
      rollingGlobalPlan.some((detail) => detail.includes("INDEX authenticated_scan_rate_limits_time")),
      `expected global rolling-window index plan, got ${rollingGlobalPlan.join(" | ")}`
    );
    assert.equal(rollingGlobalPlan.some((detail) => detail.includes("USE TEMP B-TREE")), false);
  });
});

test("authenticated global ceiling is a true rolling window across minute boundaries", () => {
  withDatabase((_database, sql) => {
    const input = (index: number): PublicScanRateLimitCharge => ({
      scope: "authenticated",
      clientHash: clientHashFor(index),
      cost: 1,
      perMinute: 20,
      perDay: null
    });
    for (let index = 0; index < AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE; index += 1) {
      assert.deepEqual(chargePublicScanRateLimit(sql, input(index), 59_999), { allowed: true });
    }
    assert.deepEqual(
      chargePublicScanRateLimit(sql, input(AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE), 60_001),
      { allowed: false, retryAfterSeconds: 60 }
    );
    assert.deepEqual(
      chargePublicScanRateLimit(sql, input(AUTHENTICATED_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE), 120_000),
      { allowed: true }
    );
  });
});

test("authenticated expiry cleanup removes at most the configured batch per charge", () => {
  withDatabase((database, sql) => {
    const authenticated: PublicScanRateLimitCharge = {
      scope: "authenticated",
      clientHash: clientHashFor(10_000),
      cost: 1,
      perMinute: 20,
      perDay: null
    };
    assert.deepEqual(chargePublicScanRateLimit(sql, authenticated, 1), { allowed: true });
    const insert = database.prepare(
      "INSERT INTO authenticated_scan_rate_limits (client_hash, charged_at, cost) VALUES (?, ?, 1)"
    );
    for (let index = 0; index < PUBLIC_SCAN_RATE_LIMIT_CLEANUP_MAX_ROWS + 36; index += 1) {
      insert.run(clientHashFor(20_000 + index), 2 + index);
    }

    assert.deepEqual(chargePublicScanRateLimit(sql, authenticated, 120_001), { allowed: true });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM authenticated_scan_rate_limits WHERE charged_at <= ?").get(60_001)?.count,
      37,
      "one prior event plus 100 expired fixtures should leave exactly 37 after a 64-row cleanup"
    );
  });
});

test("public admission's global minute ceiling is atomic across rotating identities", () => {
  withDatabase((database, sql) => {
    const now = 60_001;
    const input = (index: number): PublicScanRateLimitCharge => ({
      scope: "public",
      clientHash: clientHashFor(index),
      cost: 1,
      perMinute: 6,
      perDay: 120
    });
    for (let index = 0; index < PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE; index += 1) {
      assert.deepEqual(chargePublicScanRateLimit(sql, input(index), now), { allowed: true });
    }
    assert.deepEqual(chargePublicScanRateLimit(sql, input(PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE), now), {
      allowed: false,
      retryAfterSeconds: 60
    });
    assert.equal(
      database.prepare("SELECT used FROM public_scan_rate_limits WHERE bucket = ?").get("public-scan-global/minute/1")?.used,
      PUBLIC_SCAN_GLOBAL_RATE_LIMIT_PER_MINUTE
    );
  });
});

function rateLimitRows(database: DatabaseSync): Array<{ bucket: string; used: number }> {
  return database
    .prepare("SELECT bucket, used FROM public_scan_rate_limits WHERE bucket NOT LIKE '%-global/%' ORDER BY bucket")
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

function clientHashFor(index: number): string {
  return index.toString(16).padStart(64, "0");
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
