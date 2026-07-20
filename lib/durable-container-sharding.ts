import { durableScanJobsFlagState, type DurableScanJobsFlagState } from "./durable-scan-job-edge-wiring";
import { isScanJobId } from "./durable-scan-job-contract";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";

export const DURABLE_CONTAINER_SHARDING_ENV = "SITE_BEHAVIOR_LAB_CONTAINER_SHARDING";
export const DURABLE_CONTAINER_SHARD_COUNT_ENV = "SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT";
export const DURABLE_CONTAINER_MAX_SHARDS = 3;

const CONTAINER_NAME_PREFIX = "durable-scan-shard-";
const ROUTE_VERSION = 1;

export type DurableContainerShardRoute = Readonly<{
  /** Index zero deliberately reuses the existing default singleton. */
  shardIndex: number;
  shardCount: number;
  containerName: string | null;
}>;

export type DurableContainerShardingPlan = Readonly<{
  requested: boolean;
  enabled: boolean;
  readiness: "disabled" | "blocked" | "ready" | "misconfigured";
  shardCount: number;
  reasons: readonly string[];
}>;

type DurableContainerShardingInput = Readonly<{
  durableJobsFlag: string | undefined;
  durableJobsReady: boolean;
  shardingFlag: string | undefined;
  shardCount: string | undefined;
}>;

/**
 * Resolve the rollout gate without ever widening the singleton path by
 * accident. A durable-jobs rollback always collapses new routing to the
 * singleton, even if the separate sharding flag was not rolled back yet.
 */
export function durableContainerShardingPlan(
  input: DurableContainerShardingInput
): DurableContainerShardingPlan {
  const durableState = durableScanJobsFlagState(input.durableJobsFlag);
  const shardingState = exactFlagState(input.shardingFlag);

  if (durableState !== "enabled") {
    return {
      requested: shardingState === "enabled",
      enabled: false,
      readiness: "disabled",
      shardCount: 1,
      reasons: []
    };
  }

  if (shardingState === "disabled") {
    return {
      requested: false,
      enabled: false,
      readiness: "disabled",
      shardCount: 1,
      reasons: []
    };
  }
  if (shardingState === "misconfigured") {
    return misconfigured("Container sharding has an invalid feature-flag value.");
  }

  const shardCount = parseShardCount(input.shardCount);
  if (shardCount === null) {
    return misconfigured(
      `Container sharding requires an exact shard count from 2 to ${DURABLE_CONTAINER_MAX_SHARDS}.`
    );
  }
  if (!input.durableJobsReady) {
    return {
      requested: true,
      enabled: false,
      readiness: "blocked",
      shardCount: 1,
      reasons: ["Container sharding is blocked until durable scan jobs are ready."]
    };
  }
  return {
    requested: true,
    enabled: true,
    readiness: "ready",
    shardCount,
    reasons: []
  };
}

/** Stable, bounded routing over the random 128-bit suffix of a scan-job ID. */
export function selectDurableContainerShard(
  jobId: string,
  shardCount: number
): DurableContainerShardRoute {
  if (!isScanJobId(jobId)) throw new Error("Invalid durable scan-job ID for container routing.");
  assertShardCount(shardCount);
  const randomSuffix = jobId.slice(-8);
  const shardIndex = Number.parseInt(randomSuffix, 16) % shardCount;
  return route(shardIndex, shardCount);
}

/** Persist the route in the same DO transaction as authoritative admission. */
export function recordDurableContainerShardRoute(
  sql: DurableScanJobStoreSql,
  jobId: string,
  value: DurableContainerShardRoute
): void {
  if (!isScanJobId(jobId)) throw new Error("Invalid durable scan-job ID for container routing.");
  assertRoute(value);
  const expected = selectDurableContainerShard(jobId, value.shardCount);
  if (value.shardIndex !== expected.shardIndex || value.containerName !== expected.containerName) {
    throw new Error("The durable container shard route is not the deterministic server-owned route.");
  }
  ensureRouteStore(sql);
  sql.exec(
    "INSERT INTO durable_scan_job_container_routes (job_id, route_version, shard_index, shard_count) VALUES (?, ?, ?, ?)",
    jobId,
    ROUTE_VERSION,
    value.shardIndex,
    value.shardCount
  );
  sql.exec(
    "UPDATE durable_scan_jobs SET container_route_version = ? WHERE job_id = ? AND container_route_version IS NULL",
    ROUTE_VERSION,
    jobId
  );
  const marker = readRouteMarker(sql, jobId);
  if (marker !== ROUTE_VERSION) {
    throw new Error("The durable container shard route requirement was not recorded.");
  }
}

/** Only an explicitly legacy row may resolve to the historical singleton. */
export function findDurableContainerShardRoute(
  sql: DurableScanJobStoreSql,
  jobId: string
): DurableContainerShardRoute {
  if (!isScanJobId(jobId)) throw new Error("Invalid durable scan-job ID for container routing.");
  ensureRouteStore(sql);
  const marker = readRouteMarker(sql, jobId);
  const row = sql
    .exec<{ route_version: number; shard_index: number; shard_count: number }>(
      "SELECT route_version, shard_index, shard_count FROM durable_scan_job_container_routes WHERE job_id = ? LIMIT 1",
      jobId
    )
    .toArray()[0];
  if (marker === null && !row) return route(0, 1);
  if (marker !== ROUTE_VERSION || !row) {
    throw new Error("The required durable container shard route is missing or unsupported.");
  }
  if (row.route_version !== ROUTE_VERSION) {
    throw new Error("Unsupported durable container shard route version.");
  }
  const expected = selectDurableContainerShard(jobId, row.shard_count);
  if (row.shard_index !== expected.shardIndex) {
    throw new Error("The durable container shard route failed deterministic integrity validation.");
  }
  return expected;
}

/** Route rows inherit the authoritative durable-job purge boundary. */
export function pruneDurableContainerShardRoutes(sql: DurableScanJobStoreSql): void {
  ensureRouteStore(sql);
  sql.exec(
    "DELETE FROM durable_scan_job_container_routes WHERE NOT EXISTS (SELECT 1 FROM durable_scan_jobs jobs WHERE jobs.job_id = durable_scan_job_container_routes.job_id)"
  );
}

function exactFlagState(value: string | undefined): DurableScanJobsFlagState {
  if (value === undefined || value === "" || value === "0") return "disabled";
  return value === "1" ? "enabled" : "misconfigured";
}

function parseShardCount(value: string | undefined): number | null {
  if (!value || !/^[0-9]+$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && String(count) === value && count >= 2 && count <= DURABLE_CONTAINER_MAX_SHARDS
    ? count
    : null;
}

function misconfigured(reason: string): DurableContainerShardingPlan {
  return {
    requested: true,
    enabled: false,
    readiness: "misconfigured",
    shardCount: 1,
    reasons: [reason]
  };
}

function route(shardIndex: number, shardCount: number): DurableContainerShardRoute {
  return {
    shardIndex,
    shardCount,
    containerName: shardIndex === 0 ? null : `${CONTAINER_NAME_PREFIX}${shardIndex}`
  };
}

function assertShardCount(shardCount: number): void {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > DURABLE_CONTAINER_MAX_SHARDS) {
    throw new Error("Invalid durable container shard count.");
  }
}

function assertRoute(value: DurableContainerShardRoute): void {
  assertShardCount(value.shardCount);
  if (
    !Number.isSafeInteger(value.shardIndex) ||
    value.shardIndex < 0 ||
    value.shardIndex >= value.shardCount ||
    value.containerName !==
      (value.shardIndex === 0 ? null : `${CONTAINER_NAME_PREFIX}${value.shardIndex}`)
  ) {
    throw new Error("Invalid durable container shard route.");
  }
}

function ensureRouteStore(sql: DurableScanJobStoreSql): void {
  const jobColumns = sql
    .exec<{ name: string }>("PRAGMA table_info(durable_scan_jobs)")
    .toArray();
  if (!jobColumns.some((column) => column.name === "container_route_version")) {
    sql.exec(
      "ALTER TABLE durable_scan_jobs ADD COLUMN container_route_version INTEGER CHECK(container_route_version IS NULL OR container_route_version = 1)"
    );
  }
  sql.exec(
    `CREATE TABLE IF NOT EXISTS durable_scan_job_container_routes (
      job_id TEXT PRIMARY KEY,
      route_version INTEGER NOT NULL CHECK(route_version = 1),
      shard_index INTEGER NOT NULL CHECK(shard_index >= 0 AND shard_index < 3),
      shard_count INTEGER NOT NULL CHECK(shard_count >= 1 AND shard_count <= 3),
      CHECK(shard_index < shard_count)
    )`
  );
  sql.exec(
    `CREATE TRIGGER IF NOT EXISTS durable_scan_job_container_routes_immutable
     BEFORE UPDATE ON durable_scan_job_container_routes
     BEGIN
       SELECT RAISE(ABORT, 'durable container shard routes are immutable');
     END`
  );
  sql.exec(
    `CREATE TRIGGER IF NOT EXISTS durable_scan_job_container_route_marker_immutable
     BEFORE UPDATE OF container_route_version ON durable_scan_jobs
     WHEN OLD.container_route_version = 1 AND NEW.container_route_version IS NOT 1
     BEGIN
       SELECT RAISE(ABORT, 'durable container shard route markers are immutable');
     END`
  );
}

function readRouteMarker(sql: DurableScanJobStoreSql, jobId: string): number | null {
  const row = sql
    .exec<{ container_route_version: number | null }>(
      "SELECT container_route_version FROM durable_scan_jobs WHERE job_id = ? LIMIT 1",
      jobId
    )
    .toArray()[0];
  if (!row) throw new Error("The durable container route has no authoritative job row.");
  return row.container_route_version;
}
