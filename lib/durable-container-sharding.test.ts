import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { test } from "node:test";
import { sliceBetween } from "./source-markers";
import {
  DURABLE_CONTAINER_MAX_SHARDS,
  DURABLE_SCAN_JOB_CAPACITY_PER_SHARD,
  durableContainerExecutionCapacity,
  durableContainerShardingPlan,
  findDurableContainerShardRoute,
  pruneDurableContainerShardRoutes,
  recordDurableContainerShardRoute,
  selectDurableContainerShard
} from "./durable-container-sharding";
import {
  admitDurableScanJob,
  claimDurableScanJobs,
  createDurableScanJobAdmission,
  createDurableScanJobLeaseCredentials,
  importDurableScanJobEncryptionKey,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";

test("container sharding is subordinate to the durable-jobs readiness gate", () => {
  assert.deepEqual(
    durableContainerShardingPlan({
      durableJobsFlag: "0",
      durableJobsReady: false,
      shardingFlag: "1",
      shardCount: "3"
    }),
    {
      requested: true,
      enabled: false,
      readiness: "disabled",
      shardCount: 1,
      reasons: []
    },
    "a durable rollback must collapse all new work to the historical singleton"
  );
  assert.equal(
    durableContainerShardingPlan({
      durableJobsFlag: "1",
      durableJobsReady: false,
      shardingFlag: "1",
      shardCount: "3"
    }).readiness,
    "blocked"
  );
  assert.deepEqual(
    durableContainerShardingPlan({
      durableJobsFlag: "1",
      durableJobsReady: true,
      shardingFlag: "0",
      shardCount: "3"
    }),
    {
      requested: false,
      enabled: false,
      readiness: "disabled",
      shardCount: 1,
      reasons: []
    }
  );
});

test("enabled sharding accepts only exact bounded configuration", () => {
  for (const shardCount of ["2", "3"]) {
    assert.deepEqual(
      durableContainerShardingPlan({
        durableJobsFlag: "1",
        durableJobsReady: true,
        shardingFlag: "1",
        shardCount
      }),
      {
        requested: true,
        enabled: true,
        readiness: "ready",
        shardCount: Number(shardCount),
        reasons: []
      }
    );
  }
  for (const shardingFlag of ["true", " 1 "]) {
    assert.equal(
      durableContainerShardingPlan({
        durableJobsFlag: "1",
        durableJobsReady: true,
        shardingFlag,
        shardCount: "3"
      }).readiness,
      "misconfigured"
    );
  }
  for (const shardCount of [undefined, "", "1", "4", "03", " 3 "]) {
    assert.equal(
      durableContainerShardingPlan({
        durableJobsFlag: "1",
        durableJobsReady: true,
        shardingFlag: "1",
        shardCount
      }).readiness,
      "misconfigured"
    );
  }
});

test("job routes are deterministic and distribute across every bounded shard", () => {
  const counts = Array.from({ length: DURABLE_CONTAINER_MAX_SHARDS }, () => 0);
  for (let value = 0; value < 96; value += 1) {
    const jobId = idFor(value);
    const first = selectDurableContainerShard(jobId, 3);
    const second = selectDurableContainerShard(jobId, 3);
    assert.deepEqual(second, first);
    counts[first.shardIndex] += 1;
    assert.equal(first.containerName, first.shardIndex === 0 ? null : `durable-scan-shard-${first.shardIndex}`);
  }
  assert.deepEqual(counts, [32, 32, 32]);
  assert.deepEqual(selectDurableContainerShard(idFor(0), 3), {
    shardIndex: 0,
    shardCount: 3,
    containerName: null
  });
  assert.throws(() => selectDurableContainerShard("not-a-job", 3));
  assert.throws(() => selectDurableContainerShard(idFor(0), 4));
});

test("the authoritative DO persists the route for status, cancel, and rollback coherence", () => {
  withDatabase((database, sql) => {
    database.exec("CREATE TABLE durable_scan_jobs (job_id TEXT PRIMARY KEY)");
    const jobId = idFor(2);
    database.prepare("INSERT INTO durable_scan_jobs VALUES (?)").run(jobId);
    const admittedRoute = selectDurableContainerShard(jobId, 3);
    recordDurableContainerShardRoute(sql, jobId, admittedRoute);

    // A later flag rollback changes only new routing. The admitted job keeps
    // the exact execution target needed for best-effort abort/reconciliation.
    assert.equal(
      durableContainerShardingPlan({
        durableJobsFlag: "0",
        durableJobsReady: false,
        shardingFlag: "1",
        shardCount: "2"
      }).shardCount,
      1
    );
    assert.deepEqual(findDurableContainerShardRoute(sql, jobId), admittedRoute);

    // A later count change cannot remap an accepted job from its original
    // three-way assignment into the current two-way topology.
    assert.notDeepEqual(selectDurableContainerShard(jobId, 2), admittedRoute);
    assert.deepEqual(findDurableContainerShardRoute(sql, jobId), admittedRoute);

    const preShardingJob = idFor(10);
    database.prepare("INSERT INTO durable_scan_jobs (job_id) VALUES (?)").run(preShardingJob);
    assert.deepEqual(findDurableContainerShardRoute(sql, preShardingJob), {
      shardIndex: 0,
      shardCount: 1,
      containerName: null
    });

    database.prepare("DELETE FROM durable_scan_jobs WHERE job_id = ?").run(jobId);
    pruneDurableContainerShardRoutes(sql);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS count FROM durable_scan_job_container_routes WHERE job_id = ?")
        .get(jobId)?.count,
      0
    );
  });
});

test("post-sharding route loss, mutation, and duplicate assignment fail closed", () => {
  withDatabase((database, sql) => {
    database.exec("CREATE TABLE durable_scan_jobs (job_id TEXT PRIMARY KEY)");
    const jobId = idFor(2);
    database.prepare("INSERT INTO durable_scan_jobs VALUES (?)").run(jobId);
    const route = selectDurableContainerShard(jobId, 3);
    recordDurableContainerShardRoute(sql, jobId, route);
    assert.throws(() => recordDurableContainerShardRoute(sql, jobId, route), /UNIQUE|constraint/i);

    assert.throws(
      () =>
        database
          .prepare("UPDATE durable_scan_job_container_routes SET shard_index = ? WHERE job_id = ?")
          .run(1, jobId),
      /immutable/
    );
    assert.deepEqual(findDurableContainerShardRoute(sql, jobId), route);
    assert.throws(
      () =>
        database
          .prepare("UPDATE durable_scan_jobs SET container_route_version = NULL WHERE job_id = ?")
          .run(jobId),
      /markers are immutable/
    );

    // Even a restored/corrupt snapshot that bypassed the immutable trigger is
    // checked against the server-owned deterministic selector on every use.
    database.exec("DROP TRIGGER durable_scan_job_container_routes_immutable");
    database
      .prepare("UPDATE durable_scan_job_container_routes SET shard_index = ? WHERE job_id = ?")
      .run(1, jobId);
    assert.throws(() => findDurableContainerShardRoute(sql, jobId), /integrity validation/);
    database.prepare("DELETE FROM durable_scan_job_container_routes WHERE job_id = ?").run(jobId);
    assert.throws(() => findDurableContainerShardRoute(sql, jobId), /required.*missing/i);
  });
});

test("all job-scoped execution calls share one server-owned resolver and quotas stay singleton", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
  const privateCalls = [...source.matchAll(/this\.privateContainerRequest\(\s*([^,\n]+)/g)].map(
    (match) => match[1].trim()
  );
  assert.deepEqual(privateCalls, ["jobId", "claim.jobId", "snapshot.jobId"]);

  const resolver = sliceBetween(
    source,
    "private privateContainerRequest",
    "private ensureDurableReconciliationBackoffStore",
    "cloudflare/container-worker.ts"
  );
  assert.match(resolver, /findDurableContainerShardRoute\(this\.ctx\.storage\.sql, jobId\)/);
  assert.match(resolver, /containerRoute\.containerName === null[\s\S]*this\.containerFetch\(request\)[\s\S]*getContainer\(this\.env\.SCANNER, containerRoute\.containerName\)\.fetch\(request\)/);

  const forwarder = sliceBetween(
    source,
    "function forwardToContainer",
    "function frontDoorOrigin",
    "cloudflare/container-worker.ts"
  );
  assert.match(
    forwarder,
    /return await forwardContainerResponseWithinDeadline\([\s\S]*getContainer\(env\.SCANNER\)\.fetch\([\s\S]*new Request\(request, \{ headers, signal \}\)/
  );
  assert.doesNotMatch(forwarder, /containerName|selectDurableContainerShard/);

  const production = await readFile(path.join(process.cwd(), "wrangler.container.jsonc"), "utf8");
  assert.match(production, /"SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT": "3"/);
  assert.match(production, /"max_instances": 3/);
  const staging = await readFile(path.join(process.cwd(), "wrangler.container.staging.jsonc"), "utf8");
  assert.match(staging, /"SITE_BEHAVIOR_LAB_CONTAINER_SHARDING": "0"/);
  assert.match(staging, /"SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT": "1"/);
  assert.match(staging, /"max_instances": 1/);
});

test("execution capacity scales with enabled shards while claimDurableScanJobs caps each shard at 2", async () => {
  assert.equal(
    durableContainerExecutionCapacity(
      durableContainerShardingPlan({
        durableJobsFlag: "1",
        durableJobsReady: true,
        shardingFlag: "0",
        shardCount: "3"
      })
    ),
    DURABLE_SCAN_JOB_CAPACITY_PER_SHARD
  );
  assert.equal(
    durableContainerExecutionCapacity(
      durableContainerShardingPlan({
        durableJobsFlag: "1",
        durableJobsReady: true,
        shardingFlag: "1",
        shardCount: "3"
      })
    ),
    DURABLE_SCAN_JOB_CAPACITY_PER_SHARD * 3
  );

  const key = await importDurableScanJobEncryptionKey(Buffer.alloc(32, 7).toString("base64url"));
  const database = new DatabaseSync(":memory:");
  try {
    const sql: DurableScanJobStoreSql = {
      exec<T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: Array<ArrayBuffer | string | number | null>
      ) {
        const statement = database.prepare(query);
        const values = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
        const rawRows = /^\s*SELECT|^\s*PRAGMA/i.test(query) ? (statement.all(...values) as Record<string, unknown>[]) : [];
        if (!/^\s*SELECT|^\s*PRAGMA/i.test(query)) statement.run(...values);
        const rows = rawRows.map((row) => {
          const converted: Record<string, unknown> = {};
          for (const [key, val] of Object.entries(row)) {
            converted[key] =
              val instanceof Uint8Array
                ? val.buffer.slice(val.byteOffset, val.byteOffset + val.byteLength)
                : val;
          }
          return converted as T;
        });
        return { toArray: () => rows };
      }
    };
    const now = 1_750_000_000_000;
    // Enqueue 4 jobs targeting shard 0, 2 targeting shard 1, and 2 targeting shard 2.
    const shardIds = [0, 3, 6, 9, 1, 4, 2, 5];
    for (let i = 0; i < shardIds.length; i += 1) {
      const jobId = idFor(shardIds[i]);
      const reportId = idFor(100 + shardIds[i]);
      const admission = await createDurableScanJobAdmission(key, {
        jobId,
        reportId,
        createdAt: now + i,
        payload: {
          version: 1,
          url: "https://example.org/",
          device: "desktop",
          gpcEnabled: false,
          compareGpc: false,
          compareShields: false,
          compareConsent: false,
          rateLimitCost: 1,
          admittedAt: now + i,
          reportMode: "r2",
          alreadyCharged: true
        }
      });
      admitDurableScanJob(sql, admission);
      recordDurableContainerShardRoute(sql, jobId, selectDurableContainerShard(jobId, 3));
    }
    const credentials = await createDurableScanJobLeaseCredentials(6);
    const claims = claimDurableScanJobs(sql, { now: now + 100, capacity: 6, maxPerShard: 2, credentials });
    // Claims 6 total: 2 from shard 0 (skipping the 3rd & 4th), 2 from shard 1, 2 from shard 2.
    assert.equal(claims.length, 6);
    const claimedShards = claims.map((c) => selectDurableContainerShard(c.jobId, 3).shardIndex);
    assert.deepEqual(
      [0, 1, 2].map((s) => claimedShards.filter((x) => x === s).length),
      [2, 2, 2]
    );
  } finally {
    database.close();
  }
});

function idFor(value: number): string {
  return `20260719-${value.toString(16).padStart(32, "0")}`;
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
        if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
          return { toArray: () => statement.all(...sqliteBindings) as T[] };
        }
        statement.run(...sqliteBindings);
        return { toArray: () => [] };
      }
    };
    callback(database, sql);
  } finally {
    database.close();
  }
}
