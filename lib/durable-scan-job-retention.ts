import {
  ensureDurableScanJobStore,
  purgeDurableScanJobs,
  settlePastPurgeDurableScanJobs,
  type DurableScanJobStoreSql
} from "./durable-scan-job-store";
import {
  ensureEncryptedWatchStore,
  recordEncryptedWatchRunTerminalOutcome
} from "./encrypted-watch-store";

type SqlValue = ArrayBuffer | string | number | null;

type TerminalWatchRow = Record<string, SqlValue> & {
  job_id: string;
  state: "succeeded" | "failed" | "expired" | "cancelled";
  terminal_reason: string | null;
  finished_at: number;
};

export type DurableScanJobRetentionResult = Readonly<{
  settled: number;
  synchronized: number;
  purged: number;
}>;

/**
 * Settle hard-expired work, preserve linked watch truth, then remove durable
 * tombstones. The caller must execute this synchronous sequence inside one
 * transaction; any watch-history conflict must roll back settlement and purge.
 */
export function settleSynchronizeAndPurgeDurableScanJobs(
  sql: DurableScanJobStoreSql,
  now: number
): DurableScanJobRetentionResult {
  ensureDurableScanJobStore(sql);
  ensureEncryptedWatchStore(sql);

  const settled = settlePastPurgeDurableScanJobs(sql, now).length;
  const terminalRows = sql
    .exec<TerminalWatchRow>(
      `SELECT jobs.job_id, jobs.state, jobs.terminal_reason, jobs.finished_at
       FROM durable_scan_jobs jobs
       INNER JOIN encrypted_watch_runs runs ON runs.job_id = jobs.job_id
       WHERE jobs.state IN ('succeeded','failed','expired','cancelled')
       ORDER BY jobs.finished_at ASC, jobs.job_id ASC`
    )
    .toArray();

  for (const row of terminalRows) {
    recordEncryptedWatchRunTerminalOutcome(sql, {
      jobId: row.job_id,
      now: row.finished_at,
      resolution:
        row.state === "succeeded"
          ? { outcome: "succeeded" }
          : {
              outcome: row.state,
              errorCode: sanitizedTerminalErrorCode(row.terminal_reason, row.state)
            }
    });
  }

  const purged = purgeDurableScanJobs(sql, now);
  return Object.freeze({ settled, synchronized: terminalRows.length, purged });
}

function sanitizedTerminalErrorCode(reason: string | null, fallback: string): string {
  const candidate = (reason ?? fallback).trim().toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(candidate) ? candidate : fallback;
}
