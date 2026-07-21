import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DURABLE_SCAN_JOB_DEADLINE_MS,
  DURABLE_SCAN_JOB_LEASE_MS,
  DURABLE_SCAN_JOB_PURGE_MS,
  ensureDurableScanJobStore,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";
import {
  DURABLE_REPLAY_FAULT_MODE_HEADER,
  DURABLE_REPLAY_FAULT_MODES,
  DURABLE_REPLAY_FAULT_TOKEN_HEADER,
  DURABLE_REPLAY_MINIMUM_NO_POLL_MS,
  armDurableReplayFault,
  dropLostResolveDurableReplayFault,
  durableReplayFaultConfig,
  durableReplayFaultIngressIntent,
  findDurableReplayFault,
  purgeDurableReplayFaults,
  triggerLeaseExpiryDurableReplayFault,
  type DurableReplayFaultEnvironment
} from "./durable-replay-fault";

const TOKEN_HASH = Uint8Array.from({ length: 32 }, () => 7).buffer;
const OTHER_TOKEN_HASH = Uint8Array.from({ length: 32 }, () => 9).buffer;

const READY_ENV = {
  SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT: "staging",
  SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS: "1",
  SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN: "fault-token-".padEnd(43, "f"),
  SITE_BEHAVIOR_LAB_DURABLE_JOBS: "1",
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY: "encryption-key-".padEnd(43, "e"),
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN: "internal-token-".padEnd(43, "i"),
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL: "https://scan-staging.sitebehavior.org",
  SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: "0",
  SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN: "synthetic-monitor-".padEnd(43, "m"),
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN: "access-token-".padEnd(43, "a"),
  TURNSTILE_SECRET_KEY: "turnstile-".padEnd(43, "t"),
  SITE_BEHAVIOR_LAB_R2_BUCKET: "site-behavior-lab-reports-staging",
  SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID: "r2-access-".padEnd(43, "r"),
  SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: "r2-secret-".padEnd(43, "s")
} as const satisfies DurableReplayFaultEnvironment;

test("durable replay wire constants are exact and cover both canary modes", () => {
  assert.deepEqual(DURABLE_REPLAY_FAULT_MODES, ["lease-expiry", "lost-resolve"]);
  assert.equal(DURABLE_REPLAY_FAULT_MODE_HEADER, "x-staging-fault-mode");
  assert.equal(DURABLE_REPLAY_FAULT_TOKEN_HEADER, "x-staging-fault-token");
  assert.equal(DURABLE_REPLAY_MINIMUM_NO_POLL_MS, 240_000);
  assert.equal(
    DURABLE_REPLAY_MINIMUM_NO_POLL_MS,
    DURABLE_SCAN_JOB_LEASE_MS + 60_000
  );
});

test("fault configuration is ready only for an isolated, gated staging deployment", () => {
  assert.deepEqual(durableReplayFaultConfig(READY_ENV), {
    status: "ready",
    coordinatorOrigin: "https://scan-staging.sitebehavior.org",
    reasons: []
  });

  assert.deepEqual(
    durableReplayFaultConfig({
      SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS: "0",
      SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL: "https://scan.sitebehavior.org"
    }),
    {
      status: "disabled",
      coordinatorOrigin: "https://scan.sitebehavior.org",
      reasons: []
    }
  );
});

test("staging ingress isolation remains active for incomplete or malformed fault configuration", () => {
  assert.equal(durableReplayFaultIngressIntent({}), false);
  assert.equal(
    durableReplayFaultIngressIntent({ SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS: "0" }),
    false
  );
  assert.equal(
    durableReplayFaultIngressIntent({ SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT: "staging" }),
    true
  );
  assert.equal(
    durableReplayFaultIngressIntent({ SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS: "1" }),
    true
  );
  assert.equal(
    durableReplayFaultIngressIntent({ SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS: "malformed" }),
    true
  );
});

test("fault configuration reports every staging isolation failure without a production escape hatch", () => {
  const cases: ReadonlyArray<
    readonly [Partial<DurableReplayFaultEnvironment>, RegExp]
  > = [
    [
      { SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS: "yes" },
      /DURABLE_REPLAY_FAULTS must be exactly 0 or 1/
    ],
    [{ SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT: "production" }, /must be exactly staging/],
    [{ SITE_BEHAVIOR_LAB_DURABLE_JOBS: "0" }, /DURABLE_JOBS must be exactly 1/],
    [
      { SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: "1" },
      /ALLOW_UNAUTHENTICATED_SCANS must be exactly 0/
    ],
    [{ SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN: "short" }, /SCAN_ACCESS_TOKEN/],
    [
      { SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL: "http://scan-staging.sitebehavior.org" },
      /must be an HTTPS origin/
    ],
    [
      { SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL: "https://scan.sitebehavior.org./" },
      /must not use the production scanner origin/
    ],
    [{ SITE_BEHAVIOR_LAB_R2_BUCKET: "site-behavior-lab-reports" }, /non-production R2 bucket/],
    [
      {
        SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN:
          READY_ENV.SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN
      },
      /must not reuse/
    ],
    [
      {
        SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN:
          ` ${READY_ENV.SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN} `
      },
      /must not reuse/
    ],
    [
      {
        SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN:
          ` ${READY_ENV.SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN} `
      },
      /must not reuse/
    ],
    [{ SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN: " short-token" }, /FAULT_TOKEN/]
  ];

  for (const [overrides, expectedReason] of cases) {
    const config = durableReplayFaultConfig({ ...READY_ENV, ...overrides });
    assert.equal(config.status, "misconfigured");
    assert.match(config.reasons.join("\n"), expectedReason);
  }
});

test("arming is bound to a queued durable row and inherits its immutable purge horizon", async () => {
  await withDatabase((database, sql) => {
    const createdAt = 10_000;
    const jobId = idFor(1);
    ensureDurableScanJobStore(sql);

    assert.throws(
      () => armDurableReplayFault(sql, { jobId, mode: "lease-expiry", now: createdAt }),
      /could not be armed/
    );

    insertQueued(database, 1, createdAt);
    const armed = armDurableReplayFault(sql, {
      jobId,
      mode: "lease-expiry",
      now: createdAt + 5
    });
    assert.deepEqual(armed, {
      jobId,
      mode: "lease-expiry",
      armedAt: createdAt + 5,
      expiresAt: createdAt + DURABLE_SCAN_JOB_PURGE_MS,
      triggeredAt: null,
      triggeredGeneration: null
    });
    assert.deepEqual(
      armDurableReplayFault(sql, {
        jobId,
        mode: "lease-expiry",
        now: createdAt + 6
      }),
      armed,
      "an identical retry is idempotent and never moves the TTL"
    );
    assert.throws(
      () =>
        armDurableReplayFault(sql, {
          jobId,
          mode: "lost-resolve",
          now: createdAt + 6
        }),
      /could not be armed/
    );
  });
});

test("lease-expiry consumes once only for generation one in the leased state", async () => {
  await withDatabase((database, sql) => {
    const createdAt = 20_000;
    const now = createdAt + 100;
    const jobId = idFor(2);
    ensureDurableScanJobStore(sql);
    insertQueued(database, 2, createdAt);
    armDurableReplayFault(sql, { jobId, mode: "lease-expiry", now });

    assert.equal(
      triggerLeaseExpiryDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: TOKEN_HASH,
        now: now + 1
      }),
      null,
      "queued work cannot consume the hook"
    );
    lease(database, jobId, 1, now + DURABLE_SCAN_JOB_LEASE_MS, TOKEN_HASH);
    assert.equal(
      triggerLeaseExpiryDurableReplayFault(sql, {
        jobId,
        generation: 2,
        tokenHash: TOKEN_HASH,
        now: now + 2
      }),
      null,
      "a forged generation cannot consume the hook"
    );

    const triggered = triggerLeaseExpiryDurableReplayFault(sql, {
      jobId,
      generation: 1,
      tokenHash: TOKEN_HASH,
      now: now + 3
    });
    assert.deepEqual(triggered, {
      jobId,
      mode: "lease-expiry",
      armedAt: now,
      expiresAt: createdAt + DURABLE_SCAN_JOB_PURGE_MS,
      triggeredAt: now + 3,
      triggeredGeneration: 1
    });
    assert.equal(
      triggerLeaseExpiryDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: TOKEN_HASH,
        now: now + 3
      }),
      null,
      "the same timestamp cannot make the one-shot appear to fire twice"
    );
  });
});

test("lost-resolve consumes once only for generation one in publishing", async () => {
  await withDatabase((database, sql) => {
    const createdAt = 30_000;
    const now = createdAt + 100;
    const jobId = idFor(3);
    ensureDurableScanJobStore(sql);
    insertQueued(database, 3, createdAt);
    armDurableReplayFault(sql, { jobId, mode: "lost-resolve", now });
    lease(database, jobId, 1, now + DURABLE_SCAN_JOB_LEASE_MS, TOKEN_HASH);

    assert.equal(
      dropLostResolveDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: TOKEN_HASH,
        now: now + 1
      }),
      null,
      "a leased job has not crossed the publication boundary"
    );
    publish(database, jobId);
    assert.equal(
      triggerLeaseExpiryDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: TOKEN_HASH,
        now: now + 2
      }),
      null,
      "the other mode cannot consume the one-shot"
    );

    assert.deepEqual(
      dropLostResolveDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: TOKEN_HASH,
        now: now + 3
      }),
      {
        fault: {
          jobId,
          mode: "lost-resolve",
          armedAt: now,
          expiresAt: createdAt + DURABLE_SCAN_JOB_PURGE_MS,
          triggeredAt: now + 3,
          triggeredGeneration: 1
        },
        firstTrigger: true
      }
    );
    assert.deepEqual(
      dropLostResolveDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: TOKEN_HASH,
        now: now + DURABLE_SCAN_JOB_LEASE_MS + 1
      }),
      {
        fault: {
          jobId,
          mode: "lost-resolve",
          armedAt: now,
          expiresAt: createdAt + DURABLE_SCAN_JOB_PURGE_MS,
          triggeredAt: now + 3,
          triggeredGeneration: 1
        },
        firstTrigger: false
      },
      "a duplicate owner callback stays dropped after the lease so only reconciliation can succeed"
    );
    assert.equal(
      dropLostResolveDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: OTHER_TOKEN_HASH,
        now: now + 4
      }),
      null,
      "a different lease token can never consume or reuse the hook"
    );
  });
});

test("generation two cannot consume a first-generation hook and TTL cleanup is exact", async () => {
  await withDatabase((database, sql) => {
    const createdAt = 40_000;
    const jobId = idFor(4);
    const expiresAt = createdAt + DURABLE_SCAN_JOB_PURGE_MS;
    ensureDurableScanJobStore(sql);
    insertQueued(database, 4, createdAt);
    armDurableReplayFault(sql, { jobId, mode: "lease-expiry", now: createdAt });
    lease(database, jobId, 2, createdAt + DURABLE_SCAN_JOB_LEASE_MS, TOKEN_HASH);

    assert.equal(
      triggerLeaseExpiryDurableReplayFault(sql, {
        jobId,
        generation: 1,
        tokenHash: TOKEN_HASH,
        now: createdAt + 1
      }),
      null
    );
    assert.ok(findDurableReplayFault(sql, jobId, expiresAt - 1));
    assert.equal(purgeDurableReplayFaults(sql, expiresAt - 1), 0);
    assert.equal(purgeDurableReplayFaults(sql, expiresAt), 1);
    assert.equal(findDurableReplayFault(sql, jobId, expiresAt), null);
  });
});

test("fault cleanup removes a row immediately when authoritative job cleanup evicts its owner", async () => {
  await withDatabase((database, sql) => {
    const createdAt = 50_000;
    const jobId = idFor(5);
    ensureDurableScanJobStore(sql);
    insertQueued(database, 5, createdAt);
    armDurableReplayFault(sql, { jobId, mode: "lost-resolve", now: createdAt });

    database.prepare("DELETE FROM durable_scan_jobs WHERE job_id = ?").run(jobId);
    assert.equal(purgeDurableReplayFaults(sql, createdAt + 1), 1);
    assert.equal(findDurableReplayFault(sql, jobId, createdAt + 1), null);
  });
});

function insertQueued(database: DatabaseSync, index: number, createdAt: number): void {
  database
    .prepare(
      `INSERT INTO durable_scan_jobs (
        job_id, report_id, state, created_at, deadline_at, purge_at, total_runs,
        attempt_count, lease_generation, lease_token_hash, lease_expires_at,
        payload_version, payload_key_id, payload_nonce, payload_ciphertext,
        publication_manifest, terminal_reason, finished_at, updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, 1, 0, 0, NULL, NULL, 1, 'v1', ?, ?, NULL, NULL, NULL, ?)`
    )
    .run(
      idFor(index),
      idFor(index + 10_000),
      createdAt,
      createdAt + DURABLE_SCAN_JOB_DEADLINE_MS,
      createdAt + DURABLE_SCAN_JOB_PURGE_MS,
      new Uint8Array(12),
      new Uint8Array(16),
      createdAt
    );
}

function lease(
  database: DatabaseSync,
  jobId: string,
  generation: 1 | 2,
  leaseExpiresAt: number,
  tokenHash: ArrayBuffer
): void {
  database
    .prepare(
      `UPDATE durable_scan_jobs
       SET state = 'leased', attempt_count = ?, lease_generation = ?, lease_token_hash = ?,
           lease_expires_at = ?, updated_at = updated_at + 1
       WHERE job_id = ?`
    )
    .run(generation, generation, new Uint8Array(tokenHash), leaseExpiresAt, jobId);
}

function publish(database: DatabaseSync, jobId: string): void {
  database
    .prepare(
      "UPDATE durable_scan_jobs SET state = 'publishing', publication_manifest = '{}', updated_at = updated_at + 1 WHERE job_id = ?"
    )
    .run(jobId);
}

function idFor(index: number): string {
  return `20260719-${index.toString(16).padStart(32, "0")}`;
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

function normalizeSqliteRow(
  row: Record<string, unknown>
): Record<string, ArrayBuffer | string | number | null> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array
        ? Uint8Array.from(value).buffer
        : (value as string | number | null)
    ])
  );
}
