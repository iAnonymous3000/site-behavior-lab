import type {
  DurableScanJobSnapshot,
  DurableScanJobStoreSql
} from "./durable-scan-job-store";
import { isDurableRestartGithubRunId } from "./durable-restart-control-auth";

type SqlValue = ArrayBuffer | string | number | null;
const SCAN_ID = /^[0-9]{8}-[0-9a-f]{32}$/;

// GitHub permits a workflow run to be rerun for 30 days. Retaining the
// consumed run id for 45 days leaves a conservative margin without allowing
// this tiny ceremony ledger to grow forever.
export const DURABLE_RESTART_CONTROL_RETENTION_MS =
  45 * 24 * 60 * 60 * 1000;
export const DURABLE_RESTART_CONTROL_MAX_ROWS = 64;

export type DurableRestartControlReceipt = Readonly<{
  githubRunId: string;
  jobId: string;
  reportId: string;
  createdAt: number;
  leaseGeneration: 1;
}>;

export type DurableRestartControlDecision =
  | Readonly<{
      status: "execute";
      receipt: DurableRestartControlReceipt;
    }>
  | Readonly<{
      status: "completed";
      receipt: DurableRestartControlReceipt;
    }>
  | Readonly<{ status: "pending" | "conflict" }>;

type DurableRestartControlRow = Record<string, SqlValue> & {
  github_run_id: string;
  job_id: string;
  report_id: string;
  created_at: number;
  lease_generation: number;
  requested_at: number;
  status: string;
};

export function ensureDurableRestartControlStore(
  sql: DurableScanJobStoreSql
): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS durable_restart_evidence_controls (
      github_run_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL UNIQUE,
      report_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      lease_generation INTEGER NOT NULL CHECK(lease_generation = 1),
      requested_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('requested','completed'))
    )`
  );
}

export function pruneDurableRestartControls(
  sql: DurableScanJobStoreSql,
  now: number
): void {
  ensureDurableRestartControlStore(sql);
  assertTimestamp(now, "prune time");
  sql.exec(
    "DELETE FROM durable_restart_evidence_controls WHERE requested_at <= ?",
    Math.max(0, now - DURABLE_RESTART_CONTROL_RETENTION_MS)
  );
}

/**
 * Atomically consume the destructive action for one stable GitHub run id.
 *
 * GitHub keeps run_id stable across run attempts. A repeated request from the
 * same run therefore observes pending or completed and cannot authorize a
 * second destroy, even if a rerun admitted a new job. A new workflow dispatch
 * receives a new run id and is the only way to arm another ceremony.
 */
export function beginDurableRestartControl(
  sql: DurableScanJobStoreSql,
  input: Readonly<{
    githubRunId: string;
    snapshot: DurableScanJobSnapshot;
    requestedAt: number;
  }>
): DurableRestartControlDecision {
  ensureDurableRestartControlStore(sql);
  assertTimestamp(input.requestedAt, "request time");
  if (!isDurableRestartGithubRunId(input.githubRunId)) {
    throw new Error(
      "The durable runtime destroy GitHub run id is invalid."
    );
  }
  const snapshot = input.snapshot;
  if (input.requestedAt < snapshot.createdAt) {
    throw new Error(
      "The durable runtime destroy request precedes job creation."
    );
  }
  pruneDurableRestartControls(sql, input.requestedAt);
  const prior = readRowByRunId(sql, input.githubRunId);
  if (prior) {
    if (
      prior.job_id !== snapshot.jobId ||
      prior.report_id !== snapshot.reportId ||
      prior.created_at !== snapshot.createdAt ||
      prior.lease_generation !== 1
    ) {
      return Object.freeze({ status: "conflict" as const });
    }
    return prior.status === "completed"
      ? Object.freeze({
          status: "completed" as const,
          receipt: receiptFromRow(prior)
        })
      : Object.freeze({ status: "pending" as const });
  }
  if (readRowByJobId(sql, snapshot.jobId)) {
    return Object.freeze({ status: "conflict" as const });
  }
  if (
    snapshot.state !== "leased" ||
    snapshot.attemptCount !== 1 ||
    snapshot.leaseGeneration !== 1 ||
    snapshot.finishedAt !== null
  ) {
    return Object.freeze({ status: "conflict" as const });
  }
  const count = sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM durable_restart_evidence_controls"
    )
    .toArray()[0]?.count;
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count >= DURABLE_RESTART_CONTROL_MAX_ROWS
  ) {
    throw new Error(
      "The durable runtime destroy ledger is at capacity."
    );
  }
  sql.exec(
    "INSERT INTO durable_restart_evidence_controls (github_run_id, job_id, report_id, created_at, lease_generation, requested_at, status) VALUES (?, ?, ?, ?, 1, ?, 'requested')",
    input.githubRunId,
    snapshot.jobId,
    snapshot.reportId,
    snapshot.createdAt,
    input.requestedAt
  );
  return Object.freeze({
    status: "execute" as const,
    receipt: Object.freeze({
      githubRunId: input.githubRunId,
      jobId: snapshot.jobId,
      reportId: snapshot.reportId,
      createdAt: snapshot.createdAt,
      leaseGeneration: 1 as const
    })
  });
}

export function completeDurableRestartControl(
  sql: DurableScanJobStoreSql,
  receipt: DurableRestartControlReceipt
): void {
  ensureDurableRestartControlStore(sql);
  sql.exec(
    "UPDATE durable_restart_evidence_controls SET status = 'completed' WHERE github_run_id = ? AND job_id = ? AND report_id = ? AND created_at = ? AND lease_generation = 1 AND status = 'requested'",
    receipt.githubRunId,
    receipt.jobId,
    receipt.reportId,
    receipt.createdAt
  );
  const completed = readRowByRunId(sql, receipt.githubRunId);
  if (
    !completed ||
    completed.job_id !== receipt.jobId ||
    completed.report_id !== receipt.reportId ||
    completed.created_at !== receipt.createdAt ||
    completed.lease_generation !== 1 ||
    completed.status !== "completed"
  ) {
    throw new Error(
      "The durable runtime destroy marker did not settle."
    );
  }
}

function readRowByRunId(
  sql: DurableScanJobStoreSql,
  githubRunId: string
): DurableRestartControlRow | null {
  return readRow(
    sql,
    "SELECT github_run_id, job_id, report_id, created_at, lease_generation, requested_at, status FROM durable_restart_evidence_controls WHERE github_run_id = ? LIMIT 1",
    githubRunId
  );
}

function readRowByJobId(
  sql: DurableScanJobStoreSql,
  jobId: string
): DurableRestartControlRow | null {
  return readRow(
    sql,
    "SELECT github_run_id, job_id, report_id, created_at, lease_generation, requested_at, status FROM durable_restart_evidence_controls WHERE job_id = ? LIMIT 1",
    jobId
  );
}

function readRow(
  sql: DurableScanJobStoreSql,
  query: string,
  value: string
): DurableRestartControlRow | null {
  const row = sql
    .exec<DurableRestartControlRow>(query, value)
    .toArray()[0];
  if (!row) return null;
  if (
    !isDurableRestartGithubRunId(row.github_run_id) ||
    typeof row.job_id !== "string" ||
    !SCAN_ID.test(row.job_id) ||
    typeof row.report_id !== "string" ||
    !SCAN_ID.test(row.report_id) ||
    row.job_id === row.report_id ||
    !Number.isSafeInteger(row.created_at) ||
    row.created_at < 0 ||
    row.lease_generation !== 1 ||
    !Number.isSafeInteger(row.requested_at) ||
    row.requested_at < row.created_at ||
    (row.status !== "requested" && row.status !== "completed")
  ) {
    throw new Error("The durable runtime destroy marker is invalid.");
  }
  return row;
}

function receiptFromRow(
  row: DurableRestartControlRow
): DurableRestartControlReceipt {
  return Object.freeze({
    githubRunId: row.github_run_id,
    jobId: row.job_id,
    reportId: row.report_id,
    createdAt: row.created_at,
    leaseGeneration: 1
  });
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `The durable runtime destroy ${label} is invalid.`
    );
  }
}
