import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCAN_ADMISSION_TTL_MS } from "./scan-admission-capability";
import {
  SCAN_ADMISSION_MAX_ROWS,
  ScanAdmissionCapacityError,
  ScanAdmissionConflictError,
  commitIdempotentScanAdmission,
  findScanAdmission,
  findScanAdmissionRateLimited,
  recordScanAdmission,
  type ScanAdmissionRegistration,
  type ScanAdmissionStoreKey
} from "./scan-admission-store";
import {
  SCAN_ADMISSION_RECOVERY_RATE_LIMIT_PER_MINUTE,
  peekPublicScanRateLimit,
  type PublicScanRateLimitCharge
} from "./public-scan-rate-limit-store";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

const JOB_ID = `20260721-${"a".repeat(32)}`;
const REPORT_ID = `20260721-${"b".repeat(32)}`;
const CREATED_AT = Date.UTC(2026, 6, 21, 12, 0, 0);
const SECRET_QUERY_VALUE = "private-query-value-should-never-be-stored";
const COMMITMENT = createHmac("sha256", Buffer.alloc(32, 0xaa))
  .update(`https://example.com/account?token=${SECRET_QUERY_VALUE}`)
  .digest("base64url");
const OTHER_COMMITMENT = Buffer.alloc(32, 0xdd).toString("base64url");

test("scan-admission storage is privacy-minimal and exact replays recover the original capabilities", () => {
  withDatabase((database, sql) => {
    const admitted = recordScanAdmission(sql, key(), registration());
    assert.deepEqual(admitted, {
      ...registration(),
      expiresAt: CREATED_AT + SCAN_ADMISSION_TTL_MS
    });
    assert.deepEqual(findScanAdmission(sql, key(), CREATED_AT + 1), admitted);

    const columns = database
      .prepare("PRAGMA table_info(scan_admissions)")
      .all()
      .map((column) => column.name);
    assert.deepEqual(columns, [
      "capability_hash",
      "request_commitment",
      "job_id",
      "report_id",
      "total_runs",
      "created_at",
      "expires_at"
    ]);
    const wire = JSON.stringify(database.prepare("SELECT * FROM scan_admissions").get());
    assert.doesNotMatch(wire, /example\.com|private-query-value|turnstile|access.?key|client|request.?body/i);
  });
});

test("contradictory capability reuse fails closed without remapping opaque IDs", () => {
  withDatabase((_database, sql) => {
    recordScanAdmission(sql, key(), registration());
    assert.throws(
      () => findScanAdmission(sql, key({ requestCommitment: OTHER_COMMITMENT }), CREATED_AT + 1),
      ScanAdmissionConflictError
    );
    assert.throws(
      () =>
        recordScanAdmission(
          sql,
          key(),
          registration({ jobId: idFor(2), reportId: idFor(3) })
        ),
      ScanAdmissionConflictError
    );
    assert.deepEqual(findScanAdmission(sql, key(), CREATED_AT + 1)?.jobId, JOB_ID);
  });
});

test("quota, work, and recovery linkage commit once while exact and concurrent-style duplicates converge", () => {
  withDatabase((database, sql) => {
    let workCommits = 0;
    const first = transaction(database, () =>
      commitIdempotentScanAdmission(sql, key(), rateLimit(), CREATED_AT, () => {
        workCommits += 1;
        database.exec("CREATE TABLE IF NOT EXISTS admitted_work (job_id TEXT PRIMARY KEY)");
        database.prepare("INSERT INTO admitted_work (job_id) VALUES (?)").run(JOB_ID);
        return { registration: registration(), value: "new-work" };
      })
    );
    assert.equal(first.status, "committed");

    const retry = transaction(database, () =>
      commitIdempotentScanAdmission(sql, key(), rateLimit(), CREATED_AT + 1, () => {
        workCommits += 1;
        return {
          registration: registration({ jobId: idFor(4), reportId: idFor(5), createdAt: CREATED_AT + 1 }),
          value: "duplicate-work"
        };
      })
    );
    assert.equal(retry.status, "recovered");
    assert.equal(retry.admission.jobId, JOB_ID);
    assert.equal(retry.admission.reportId, REPORT_ID);
    assert.equal(workCommits, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admitted_work").get()?.count, 1);
    assert.equal(database.prepare("SELECT used FROM public_scan_rate_limits").get()?.used, 1);
  });
});

test("a contradictory replay neither consumes quota nor invokes the work mutation", () => {
  withDatabase((database, sql) => {
    transaction(database, () =>
      commitIdempotentScanAdmission(sql, key(), rateLimit(), CREATED_AT, () => ({
        registration: registration(),
        value: null
      }))
    );
    let invoked = false;
    assert.throws(
      () =>
        transaction(database, () =>
          commitIdempotentScanAdmission(
            sql,
            key({ requestCommitment: OTHER_COMMITMENT }),
            rateLimit(),
            CREATED_AT + 1,
            () => {
              invoked = true;
              return { registration: registration(), value: null };
            }
          )
        ),
      ScanAdmissionConflictError
    );
    assert.equal(invoked, false);
    assert.equal(database.prepare("SELECT used FROM public_scan_rate_limits").get()?.used, 1);
  });
});

test("expired admission capabilities cannot recover and no longer reserve capacity", () => {
  withDatabase((database, sql) => {
    recordScanAdmission(sql, key(), registration());
    assert.equal(findScanAdmission(sql, key(), CREATED_AT + SCAN_ADMISSION_TTL_MS), null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM scan_admissions").get()?.count, 0);

    const fresh = recordScanAdmission(
      sql,
      key(),
      registration({ jobId: idFor(6), reportId: idFor(7), createdAt: CREATED_AT + SCAN_ADMISSION_TTL_MS })
    );
    assert.equal(fresh.jobId, idFor(6));
  });
});

test("the bounded store refuses to evict a still-recoverable capability", () => {
  withDatabase((_database, sql) => {
    for (let index = 0; index < SCAN_ADMISSION_MAX_ROWS; index += 1) {
      recordScanAdmission(
        sql,
        key({ capabilityHash: hashFor(index), requestCommitment: commitmentFor(index) }),
        registration({
          jobId: idFor(index + 100),
          reportId: idFor(index + 10_000),
          createdAt: CREATED_AT + index
        })
      );
    }
    assert.throws(
      () =>
        recordScanAdmission(
          sql,
          key({ capabilityHash: hashFor(999), requestCommitment: Buffer.alloc(32, 0xee).toString("base64url") }),
          registration({ jobId: idFor(50_000), reportId: idFor(50_001), createdAt: CREATED_AT + 1_000 })
        ),
      ScanAdmissionCapacityError
    );
  });
});

test("a definitive rate-limit refusal creates no admission record", () => {
  withDatabase((_database, sql) => {
    const limit = rateLimit({ perMinute: 1 });
    const first = commitIdempotentScanAdmission(sql, key({ capabilityHash: hashFor(1) }), limit, CREATED_AT, () => ({
      registration: registration(),
      value: null
    }));
    assert.equal(first.status, "committed");

    const secondKey = key({ capabilityHash: hashFor(2), requestCommitment: OTHER_COMMITMENT });
    const refused = commitIdempotentScanAdmission(sql, secondKey, limit, CREATED_AT + 1, () => ({
      registration: registration({ jobId: idFor(8), reportId: idFor(9), createdAt: CREATED_AT + 1 }),
      value: null
    }));
    assert.equal(refused.status, "rate-limited");
    assert.equal(findScanAdmission(sql, secondKey, CREATED_AT + 1), null);
    assert.deepEqual(peekPublicScanRateLimit(sql, limit, CREATED_AT + 1), { allowed: false, retryAfterSeconds: 60 });
  });
});

test("a scan admission that crosses its final commit fence rolls every mutation back", () => {
  withDatabase((database, sql) => {
    assert.equal(findScanAdmission(sql, key(), CREATED_AT), null);
    assert.deepEqual(peekPublicScanRateLimit(sql, rateLimit(), CREATED_AT), { allowed: true });
    database.exec("CREATE TABLE admitted_work (job_id TEXT PRIMARY KEY)");

    assert.throws(
      () =>
        transaction(database, () =>
          commitIdempotentScanAdmission(
            sql,
            key(),
            rateLimit(),
            CREATED_AT,
            () => {
              database.prepare("INSERT INTO admitted_work (job_id) VALUES (?)").run(JOB_ID);
              return { registration: registration(), value: null };
            },
            () => {
              throw new Error("commit deadline elapsed");
            }
          )
        ),
      /commit deadline elapsed/
    );

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM admitted_work").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM scan_admissions").get()?.count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM public_scan_rate_limits").get()?.count, 0);
  });
});

test("an exact admission recovery does not fail a now-expired fresh-commit fence", () => {
  withDatabase((database, sql) => {
    transaction(database, () =>
      commitIdempotentScanAdmission(sql, key(), rateLimit(), CREATED_AT, () => ({
        registration: registration(),
        value: null
      }))
    );
    let finalFenceInvoked = false;
    const replay = transaction(database, () =>
      commitIdempotentScanAdmission(
        sql,
        key(),
        rateLimit(),
        CREATED_AT + 1,
        () => assert.fail("exact recovery must not mutate"),
        () => {
          finalFenceInvoked = true;
          throw new Error("expired");
        }
      )
    );
    assert.equal(replay.status, "recovered");
    assert.equal(finalFenceInvoked, false);
  });
});

test("public admission recovery bounds arbitrary valid-looking misses before further lookup work", () => {
  withDatabase((database, sql) => {
    const clientHash = "c".repeat(64);
    const now = CREATED_AT + 1;
    for (let attempt = 0; attempt < SCAN_ADMISSION_RECOVERY_RATE_LIMIT_PER_MINUTE; attempt += 1) {
      assert.deepEqual(
        findScanAdmissionRateLimited(
          sql,
          key({ capabilityHash: hashFor(20_000 + attempt), requestCommitment: commitmentFor(20_000 + attempt) }),
          clientHash,
          now
        ),
        { status: "not-found" }
      );
    }

    assert.deepEqual(
      findScanAdmissionRateLimited(
        sql,
        key({ capabilityHash: hashFor(99_999), requestCommitment: commitmentFor(99_999) }),
        clientHash,
        now
      ),
      { status: "rate-limited", retryAfterSeconds: 60 }
    );
    assert.deepEqual(
      database
        .prepare("SELECT bucket, used FROM public_scan_rate_limits ORDER BY bucket")
        .all()
        .map((row) => ({ bucket: String(row.bucket), used: Number(row.used) })),
      [
        {
          bucket: `scan-admission-recovery-global/${Math.floor(now / 60_000)}`,
          used: SCAN_ADMISSION_RECOVERY_RATE_LIMIT_PER_MINUTE
        },
        {
          bucket: `scan-admission-recovery/${Math.floor(now / 60_000)}/${clientHash}`,
          used: SCAN_ADMISSION_RECOVERY_RATE_LIMIT_PER_MINUTE
        }
      ]
    );
  });
});

test("one exact completed recovery consumes one dedicated read token and no scan quota", () => {
  withDatabase((database, sql) => {
    recordScanAdmission(sql, key(), registration());
    const clientHash = "d".repeat(64);
    const recovered = findScanAdmissionRateLimited(sql, key(), clientHash, CREATED_AT + 1);
    assert.equal(recovered.status, "found");
    if (recovered.status === "found") assert.equal(recovered.admission.jobId, JOB_ID);

    const rows = database
      .prepare("SELECT bucket, used FROM public_scan_rate_limits")
      .all()
      .map((row) => ({ bucket: String(row.bucket), used: Number(row.used) }));
    assert.equal(rows.length, 2);
    const clientRow = rows.find((row) => /^scan-admission-recovery\//.test(row.bucket));
    assert.ok(clientRow);
    assert.equal(clientRow.used, 1);
    assert.equal(rows.every((row) => row.used === 1), true);
  });
});

test("a contradictory public recovery remains charged instead of rolling its limiter back", () => {
  withDatabase((database, sql) => {
    recordScanAdmission(sql, key(), registration());
    const clientHash = "e".repeat(64);
    assert.deepEqual(
      findScanAdmissionRateLimited(
        sql,
        key({ requestCommitment: OTHER_COMMITMENT }),
        clientHash,
        CREATED_AT + 1
      ),
      { status: "conflict" }
    );
    assert.equal(
      database.prepare("SELECT used FROM public_scan_rate_limits").get()?.used,
      1
    );
  });
});

function key(overrides: Partial<ScanAdmissionStoreKey> = {}): ScanAdmissionStoreKey {
  return {
    capabilityHash: hashFor(42),
    requestCommitment: COMMITMENT,
    ...overrides
  };
}

function registration(overrides: Partial<ScanAdmissionRegistration> = {}): ScanAdmissionRegistration {
  return {
    jobId: JOB_ID,
    reportId: REPORT_ID,
    totalRuns: 1,
    createdAt: CREATED_AT,
    ...overrides
  };
}

function rateLimit(overrides: Partial<PublicScanRateLimitCharge> = {}): PublicScanRateLimitCharge {
  return {
    scope: "public",
    clientHash: "f".repeat(64),
    cost: 1,
    perMinute: 10,
    perDay: 100,
    ...overrides
  };
}

function hashFor(index: number): ArrayBuffer {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(28, index);
  return bytes.buffer;
}

function commitmentFor(index: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(28, index);
  return Buffer.from(bytes).toString("base64url");
}

function idFor(index: number): string {
  return `20260721-${index.toString(16).padStart(32, "0")}`;
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function withDatabase(callback: (database: DatabaseSync, sql: DurableScanJobStoreSql) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    callback(database, {
      exec<T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: Array<ArrayBuffer | string | number | null>
      ) {
        const statement = database.prepare(query);
        const sqliteBindings = bindings.map((binding) =>
          binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding
        );
        const rows = /^\s*(SELECT|PRAGMA)\b/i.test(query) ? (statement.all(...sqliteBindings) as T[]) : [];
        if (rows.length === 0 && !/^\s*(SELECT|PRAGMA)\b/i.test(query)) statement.run(...sqliteBindings);
        return { toArray: () => rows };
      }
    });
  } finally {
    database.close();
  }
}
