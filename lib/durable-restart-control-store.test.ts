import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  ensureDurableScanJobStore,
  type DurableScanJobSnapshot,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";
import {
  createDurableRestartControlAuthorization,
  verifyDurableRestartControlAuthorization
} from "./durable-restart-control-auth";
import {
  DURABLE_RESTART_CONTROL_RETENTION_MS,
  beginDurableRestartControl,
  completeDurableRestartControl,
  pruneDurableRestartControls
} from "./durable-restart-control-store";

const JOB_ID = "20260801-00000000000000000000000000000001";
const REPORT_ID = "20260801-00000000000000000000000000010001";
const CREATED_AT = Date.parse("2026-08-01T12:00:00.000Z");
const GITHUB_RUN_ID = "30653749957";
const CONTROL_SECRET = "restart-control-secret-that-is-distinct-and-long";

test("the restart control authorizes one destroy and safely replays only after completion", () => {
  withDatabase((database, sql) => {
    const snapshot = leasedSnapshot();
    const first = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot,
      requestedAt: CREATED_AT + 1
    });
    assert.equal(first.status, "execute");
    if (first.status !== "execute") {
      assert.fail("The first request did not receive the one destroy authorization.");
    }

    assert.deepEqual(
      beginDurableRestartControl(sql, {
        githubRunId: GITHUB_RUN_ID,
        snapshot,
        requestedAt: CREATED_AT + 2
      }),
      { status: "pending" }
    );
    assert.equal(controlRowCount(database), 1);

    completeDurableRestartControl(sql, first.receipt);
    const replay = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot,
      requestedAt: CREATED_AT + 3
    });
    assert.equal(replay.status, "completed");
    if (replay.status !== "completed") {
      assert.fail("The completed request did not return the bounded safe replay.");
    }
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(controlRowCount(database), 1);
  });
});

test("pending, mismatched, and non-first-lease requests cannot authorize another destroy", () => {
  withDatabase((_database, sql) => {
    const snapshot = leasedSnapshot();
    const first = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot,
      requestedAt: CREATED_AT + 1
    });
    assert.equal(first.status, "execute");

    assert.deepEqual(
      beginDurableRestartControl(sql, {
        githubRunId: GITHUB_RUN_ID,
        snapshot: { ...snapshot, reportId: `${REPORT_ID.slice(0, -1)}2` },
        requestedAt: CREATED_AT + 2
      }),
      { status: "conflict" }
    );
    assert.deepEqual(
      beginDurableRestartControl(sql, {
        githubRunId: GITHUB_RUN_ID,
        snapshot: { ...snapshot, createdAt: CREATED_AT + 1 },
        requestedAt: CREATED_AT + 2
      }),
      { status: "conflict" }
    );
  });

  for (const snapshot of [
    { ...leasedSnapshot(), state: "queued" as const },
    { ...leasedSnapshot(), attemptCount: 2, leaseGeneration: 2 },
    { ...leasedSnapshot(), finishedAt: CREATED_AT + 1 }
  ]) {
    withDatabase((_database, sql) => {
      assert.deepEqual(
        beginDurableRestartControl(sql, {
          githubRunId: GITHUB_RUN_ID,
          snapshot,
          requestedAt: CREATED_AT + 2
        }),
        { status: "conflict" }
      );
    });
  }
});

test("a workflow rerun cannot re-arm the destroy with a different job", () => {
  withDatabase((_database, sql) => {
    const first = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot: leasedSnapshot(),
      requestedAt: CREATED_AT + 1
    });
    assert.equal(first.status, "execute");
    const replacement = leasedSnapshot({
      jobId: `${JOB_ID.slice(0, -1)}2`,
      reportId: `${REPORT_ID.slice(0, -1)}2`,
      createdAt: CREATED_AT + 10
    });
    assert.deepEqual(
      beginDurableRestartControl(sql, {
        githubRunId: GITHUB_RUN_ID,
        snapshot: replacement,
        requestedAt: CREATED_AT + 11
      }),
      { status: "conflict" }
    );
  });
});

test("a lost response reconciles pending to completed without a second destroy", () => {
  withDatabase((_database, sql) => {
    const snapshot = leasedSnapshot();
    let destroyCalls = 0;
    const first = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot,
      requestedAt: CREATED_AT + 1
    });
    assert.equal(first.status, "execute");
    if (first.status !== "execute") {
      assert.fail("The first request did not authorize the destroy.");
    }
    destroyCalls += 1;

    // The first HTTP response is lost while the one authorized destroy is
    // still settling. The exact retry must be retryable, not destructive.
    const pending = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot,
      requestedAt: CREATED_AT + 2
    });
    assert.deepEqual(pending, { status: "pending" });

    completeDurableRestartControl(sql, first.receipt);
    const completed = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot,
      requestedAt: CREATED_AT + 3
    });
    assert.equal(completed.status, "completed");
    assert.deepEqual(
      [
        null,
        pending.status === "pending" ? 503 : null,
        completed.status === "completed" ? 200 : null
      ],
      [null, 503, 200]
    );
    assert.equal(destroyCalls, 1);
  });
});

test("completion is receipt-bound and consumed runs outlive job retention", () => {
  withDatabase((database, sql) => {
    ensureDurableScanJobStore(sql);
    const snapshot = leasedSnapshot();
    const first = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot,
      requestedAt: CREATED_AT + 1
    });
    assert.equal(first.status, "execute");
    if (first.status !== "execute") {
      assert.fail("The first request did not receive the one destroy authorization.");
    }
    assert.throws(
      () =>
        completeDurableRestartControl(sql, {
          ...first.receipt,
          reportId: `${REPORT_ID.slice(0, -1)}2`
        }),
      /did not settle/
    );
    assert.equal(controlRowCount(database), 1);

    pruneDurableRestartControls(
      sql,
      CREATED_AT + DURABLE_RESTART_CONTROL_RETENTION_MS
    );
    assert.equal(controlRowCount(database), 1);
    pruneDurableRestartControls(
      sql,
      CREATED_AT + DURABLE_RESTART_CONTROL_RETENTION_MS + 2
    );
    assert.equal(controlRowCount(database), 0);
    assert.throws(
      () => completeDurableRestartControl(sql, first.receipt),
      /did not settle/
    );
  });
});

test("restart controls reject malformed request time and stored rows", () => {
  withDatabase((database, sql) => {
    assert.throws(
      () =>
        beginDurableRestartControl(sql, {
          githubRunId: GITHUB_RUN_ID,
          snapshot: leasedSnapshot(),
          requestedAt: CREATED_AT - 1
        }),
      /precedes job creation/
    );
    assert.throws(
      () =>
        beginDurableRestartControl(sql, {
          githubRunId: GITHUB_RUN_ID,
          snapshot: leasedSnapshot(),
          requestedAt: Number.NaN
        }),
      /request time is invalid/
    );

    const first = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot: leasedSnapshot(),
      requestedAt: CREATED_AT + 1
    });
    assert.equal(first.status, "execute");
    database.exec(
      "UPDATE durable_restart_evidence_controls SET requested_at = created_at - 1"
    );
    assert.throws(
      () =>
        beginDurableRestartControl(sql, {
          githubRunId: GITHUB_RUN_ID,
          snapshot: leasedSnapshot(),
          requestedAt: CREATED_AT + 2
        }),
      /marker is invalid/
    );
  });

  withDatabase((database, sql) => {
    const first = beginDurableRestartControl(sql, {
      githubRunId: GITHUB_RUN_ID,
      snapshot: leasedSnapshot(),
      requestedAt: CREATED_AT + 1
    });
    assert.equal(first.status, "execute");
    database.exec(
      "UPDATE durable_restart_evidence_controls SET report_id = job_id"
    );
    assert.throws(
      () =>
        beginDurableRestartControl(sql, {
          githubRunId: GITHUB_RUN_ID,
          snapshot: leasedSnapshot(),
          requestedAt: CREATED_AT + 2
        }),
      /marker is invalid/
    );
  });
});

test("restart authorization is an exact run and admission HMAC", async () => {
  const binding = {
    githubRunId: GITHUB_RUN_ID,
    jobId: JOB_ID,
    reportId: REPORT_ID
  };
  const authorization =
    await createDurableRestartControlAuthorization(
      CONTROL_SECRET,
      binding
    );
  assert.match(authorization, /^hmac-sha256:[A-Za-z0-9_-]{43}$/);
  assert.equal(
    await verifyDurableRestartControlAuthorization(
      CONTROL_SECRET,
      binding,
      authorization
    ),
    true
  );
  assert.equal(
    await verifyDurableRestartControlAuthorization(
      CONTROL_SECRET,
      { ...binding, githubRunId: "30653749958" },
      authorization
    ),
    false
  );
  assert.equal(
    await verifyDurableRestartControlAuthorization(
      CONTROL_SECRET,
      binding,
      `${authorization.slice(0, -1)}_`
    ),
    false
  );
  assert.equal(
    await verifyDurableRestartControlAuthorization(
      CONTROL_SECRET,
      binding,
      "not-an-authorization"
    ),
    false
  );
});

function leasedSnapshot(
  overrides: Partial<DurableScanJobSnapshot> = {}
): DurableScanJobSnapshot {
  return Object.freeze({
    jobId: JOB_ID,
    reportId: REPORT_ID,
    state: "leased",
    createdAt: CREATED_AT,
    deadlineAt: CREATED_AT + 20 * 60_000,
    purgeAt: CREATED_AT + 24 * 60 * 60_000,
    totalRuns: 1,
    attemptCount: 1,
    leaseGeneration: 1,
    completedRuns: 0,
    leaseExpiresAt: CREATED_AT + 60_000,
    publicationManifest: null,
    terminalReason: null,
    finishedAt: null,
    updatedAt: CREATED_AT,
    ...overrides
  });
}

function controlRowCount(database: DatabaseSync): number {
  return Number(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM durable_restart_evidence_controls"
      )
      .get()?.count
  );
}

function withDatabase(
  callback: (database: DatabaseSync, sql: DurableScanJobStoreSql) => void
): void {
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
          ? statement
              .all(...sqliteBindings)
              .map((row) => normalizeSqliteRow(row) as T)
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

function normalizeSqliteRow(
  row: Record<string, unknown>
): Record<string, ArrayBuffer | string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? copyArrayBuffer(value)
        : (value as string | number | null)
    ])
  );
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
