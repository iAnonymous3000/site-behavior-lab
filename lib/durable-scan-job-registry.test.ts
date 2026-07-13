import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DURABLE_SCAN_JOB_REGISTRY_MAX_ROWS,
  DURABLE_SCAN_JOB_REGISTRY_TTL_MS,
  durableRegistrationFromAcceptedResponse,
  findDurableScanJob,
  recordAcceptedScanJob,
  registerDurableScanJob,
  scanJobIdFromPath,
  type DurableScanJobRegistration,
  type DurableScanJobSql
} from "./durable-scan-job-registry";

const JOB_ID = `20260713-${"a".repeat(32)}`;
const REPORT_ID = `20260713-${"b".repeat(32)}`;

test("accepted async submissions become ids-only durable registrations", async () => {
  const response = Response.json(
    { ok: true, status: "queued", jobId: JOB_ID, reportId: REPORT_ID, statusPath: `/api/scans/${JOB_ID}` },
    { status: 202 }
  );

  assert.deepEqual(
    await durableRegistrationFromAcceptedResponse(
      response,
      JSON.stringify({ url: "https://private.example/path", compareConsent: true, turnstileToken: "secret" }),
      123_000
    ),
    { jobId: JOB_ID, reportId: REPORT_ID, totalRuns: 2, createdAt: 123_000 }
  );
  assert.equal(await response.json().then((payload) => payload.ok), true, "parsing must not consume the response");
});

test("non-202 and malformed submissions are never registered", async () => {
  assert.equal(
    await durableRegistrationFromAcceptedResponse(Response.json({ ok: false }, { status: 400 }), "{}", 1),
    null
  );
  assert.equal(
    await durableRegistrationFromAcceptedResponse(
      Response.json({ ok: true, status: "queued", jobId: JOB_ID, reportId: JOB_ID }, { status: 202 }),
      "{}",
      1
    ),
    null
  );
  assert.equal(
    await durableRegistrationFromAcceptedResponse(
      Response.json(
        { ok: true, status: "queued", jobId: JOB_ID, reportId: REPORT_ID, statusPath: "/api/scans/wrong" },
        { status: 202 }
      ),
      "{}",
      1
    ),
    null
  );
});

test("durable write failures never replace or consume an accepted 202 response", async () => {
  const response = Response.json(
    { ok: true, status: "queued", jobId: JOB_ID, reportId: REPORT_ID, statusPath: `/api/scans/${JOB_ID}` },
    { status: 202 }
  );
  const errors: unknown[] = [];

  assert.equal(
    await recordAcceptedScanJob(
      response,
      "{}",
      async () => {
        throw new Error("sqlite unavailable");
      },
      (error) => errors.push(error),
      1
    ),
    false
  );
  assert.equal(response.status, 202);
  assert.equal((await response.json()).jobId, JOB_ID);
  assert.equal(errors.length, 1);
});

test("registry stores only ids and bounded scheduling metadata", () => {
  withDatabase((database, sql) => {
    registerDurableScanJob(sql, registration());

    assert.deepEqual(findDurableScanJob(sql, JOB_ID, 1_000), registration());
    assert.deepEqual(
      database.prepare("PRAGMA table_info(scan_job_registry)").all().map((column) => column.name),
      ["job_id", "report_id", "total_runs", "created_at"]
    );
  });
});

test("registry schema coexists with the existing atomic rate-limit ledger", () => {
  withDatabase((database, sql) => {
    database.exec(
      "CREATE TABLE public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
    );
    database.prepare("INSERT INTO public_scan_rate_limits VALUES (?, ?, ?)").run("minute/example", 2, 60_000);

    registerDurableScanJob(sql, registration());

    assert.deepEqual({ ...database.prepare("SELECT * FROM public_scan_rate_limits").get() }, {
      bucket: "minute/example",
      used: 2,
      expires_at: 60_000
    });
  });
});

test("registry entries expire at 75 minutes and are pruned on the next write", () => {
  withDatabase((database, sql) => {
    registerDurableScanJob(sql, registration({ createdAt: 1_000 }));
    assert.ok(findDurableScanJob(sql, JOB_ID, 1_000 + DURABLE_SCAN_JOB_REGISTRY_TTL_MS - 1));
    assert.equal(findDurableScanJob(sql, JOB_ID, 1_000 + DURABLE_SCAN_JOB_REGISTRY_TTL_MS), null);

    registerDurableScanJob(
      sql,
      registration({
        jobId: idFor(DURABLE_SCAN_JOB_REGISTRY_MAX_ROWS + 10),
        reportId: idFor(DURABLE_SCAN_JOB_REGISTRY_MAX_ROWS + 11),
        createdAt: 1_000 + DURABLE_SCAN_JOB_REGISTRY_TTL_MS
      })
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM scan_job_registry WHERE job_id = ?").get(JOB_ID)?.count,
      0
    );
  });
});

test("registry evicts the oldest rows first at its hard cap", () => {
  withDatabase((database, sql) => {
    for (let index = 0; index <= DURABLE_SCAN_JOB_REGISTRY_MAX_ROWS; index += 1) {
      registerDurableScanJob(
        sql,
        registration({ jobId: idFor(index), reportId: idFor(index + 10_000), createdAt: index + 1 })
      );
    }

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM scan_job_registry").get()?.count, 500);
    assert.equal(findDurableScanJob(sql, idFor(0), 501), null);
    assert.ok(findDurableScanJob(sql, idFor(1), 501));
    assert.ok(findDurableScanJob(sql, idFor(500), 501));
  });
});

test("duplicate registration cannot remap a job capability", () => {
  withDatabase((_database, sql) => {
    registerDurableScanJob(sql, registration());
    registerDurableScanJob(sql, registration({ reportId: idFor(99), createdAt: 2_000 }));
    assert.deepEqual(findDurableScanJob(sql, JOB_ID, 2_000), registration());
  });
});

test("scan status paths accept only canonical bearer job ids", () => {
  assert.equal(scanJobIdFromPath(`/api/scans/${JOB_ID}`), JOB_ID);
  assert.equal(scanJobIdFromPath(`/api/scans/${JOB_ID}/extra`), null);
  assert.equal(scanJobIdFromPath("/api/scans/../reports/x"), null);
});

function registration(overrides: Partial<DurableScanJobRegistration> = {}): DurableScanJobRegistration {
  return { jobId: JOB_ID, reportId: REPORT_ID, totalRuns: 1, createdAt: 1_000, ...overrides };
}

function idFor(index: number): string {
  return `20260713-${index.toString(16).padStart(32, "0")}`;
}

function withDatabase(callback: (database: DatabaseSync, sql: DurableScanJobSql) => void): void {
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
