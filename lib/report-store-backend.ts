import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { isCanonicalTimestamp } from "./canonical-timestamp";
import path from "node:path";
import { BoundedUtf8FileReadError, readBoundedUtf8File } from "./bounded-utf8-file";
import { committedSidecarFilename } from "./redaction-provenance";
import {
  SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
  SERVER_STORED_REPORT_JSON_MAX_BYTES,
  SERVER_STORED_RETENTION_METADATA_MAX_BYTES
} from "./report-resource-limits";
import { createR2ReportStoreBackend } from "./report-store-r2";
import { parseStrictJson, StrictJsonError } from "./strict-json";

export type ReportStoreKind = "filesystem" | "r2";

export type StoredReportBlob = {
  contents: string;
  lastModifiedMs: number;
  /** Immutable creation/expiry clocks; null on legacy or malformed storage. */
  retention: ReportRetentionMetadata | null;
};

export type StoredReportEntry = {
  id: string;
  lastModifiedMs: number;
  /** Used for every retention decision; LastModified is diagnostic only. */
  retention: ReportRetentionMetadata | null;
  /** Whether the primary report object was visible in the listing snapshot. */
  reportPresent: boolean;
  /** Whether the provenance commit marker was visible in the listing snapshot. */
  sidecarPresent: boolean;
  /**
   * True only when the provenance sidecar is visible too. The sidecar is the
   * bundle's commit marker: count-based pruning must never delete a report
   * another process is still completing between its report and sidecar writes.
   */
  committed: boolean;
};

export type ReportRetentionMetadata = {
  createdAt: string;
  expiresAt: string;
};

export type ReportWriteResult = {
  /**
   * `ambiguous` means an earlier outcome-unknown create may have landed, but an
   * indistinguishable concurrent writer may instead own the matching object.
   * Callers must never destructively clean up an ambiguous write.
   */
  ownership: "certain" | "ambiguous";
};

export type ReportStoreOperationOptions = {
  /** Cancels queued work and any backend request that is still in flight. */
  signal?: AbortSignal;
};

export type ReportRetentionDebtScope = "bundle" | "sidecar";

export type ReportRetentionDebtEntry = {
  id: string;
  scope: ReportRetentionDebtScope;
};

export type ReportRetentionState = {
  debts: ReportRetentionDebtEntry[];
  /** Durable signal that another bounded maintenance pass is required. */
  maintenanceRequired: boolean;
};

export type ReportStoreBackendStatus =
  | { kind: "filesystem"; path: string; configuredPath: boolean }
  | { kind: "r2"; bucket: string; prefix: string; configuredPath: boolean };

/**
 * A keyed blob store for persisted report JSON. The facade in report-store.ts
 * owns all policy (share IDs, screenshot stripping, validation, expiry, prune
 * counts); a backend only persists raw contents under a report ID and reports
 * its own configuration. This is the seam that lets the Node container move
 * from a single-node filesystem to durable object storage (R2).
 */
export interface ReportStoreBackend {
  readonly kind: ReportStoreKind;
  /** Create-only: must reject if `id` already exists (preserves the `wx` guarantee). */
  write(
    id: string,
    contents: string,
    retention?: ReportRetentionMetadata,
    options?: ReportStoreOperationOptions
  ): Promise<ReportWriteResult>;
  /** Create-only sidecar write, deliberately after the report write. */
  writeSidecar(id: string, contents: string, options?: ReportStoreOperationOptions): Promise<void>;
  read(id: string, options?: ReportStoreOperationOptions): Promise<StoredReportBlob | null>;
  readSidecar(id: string, options?: ReportStoreOperationOptions): Promise<string | null>;
  /** Idempotently removes report, retention metadata, and provenance sidecar. */
  remove(id: string, options?: ReportStoreOperationOptions): Promise<void>;
  /** Idempotently removes only an orphaned provenance sidecar, never the report. */
  removeSidecar(id: string, options?: ReportStoreOperationOptions): Promise<void>;
  /** Persist before a retention delete; clear only after physical deletion succeeds. */
  markRetentionDebt(
    debt: ReportRetentionDebtEntry,
    options?: ReportStoreOperationOptions
  ): Promise<void>;
  clearRetentionDebt(
    debt: ReportRetentionDebtEntry,
    options?: ReportStoreOperationOptions
  ): Promise<void>;
  retentionState(options?: ReportStoreOperationOptions): Promise<ReportRetentionState>;
  setRetentionMaintenanceRequired(
    required: boolean,
    options?: ReportStoreOperationOptions
  ): Promise<void>;
  list(options?: ReportStoreOperationOptions): Promise<StoredReportEntry[]>;
  status(): ReportStoreBackendStatus;
}

const REPORT_STORE_BACKEND_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const DEFAULT_REPORT_STORE_DIR = path.join(process.cwd(), ".site-behavior-lab", "reports");
const STORED_REPORT_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{8,32})\.json$/;
const STORED_SIDECAR_FILE_PATTERN = /^([0-9]{8}-[0-9a-f]{8,32})\.provenance\.json$/;

/**
 * Selects the backend from env on each call (no memoization) so per-request
 * configuration and the test suite's per-test env overrides keep working.
 */
export function resolveReportStoreBackend(): ReportStoreBackend {
  const backend = process.env[REPORT_STORE_BACKEND_ENV]?.trim().toLowerCase();
  if (backend === "r2") {
    return createR2ReportStoreBackend();
  }
  return createFilesystemReportStoreBackend();
}

export function createFilesystemReportStoreBackend(): ReportStoreBackend {
  const dir = reportStoreDir();
  const configuredPath = Boolean(process.env[REPORT_STORE_DIR_ENV]?.trim());

  const filePath = (id: string): string => path.join(dir, `${id}.json`);
  const sidecarPath = (id: string): string => path.join(dir, committedSidecarFilename(id));
  const retentionPath = (id: string): string => path.join(dir, `${id}.retention.json`);
  const retentionDebtDir = path.join(dir, ".retention-debt");
  const retentionDebtPath = (debt: ReportRetentionDebtEntry): string =>
    path.join(retentionDebtDir, `${debt.id}.${debt.scope}`);
  const retentionMaintenancePath = path.join(retentionDebtDir, "maintenance-required");

  return {
    kind: "filesystem",
    async write(id, contents, retention, options) {
      options?.signal?.throwIfAborted();
      if (retention !== undefined && !isReportRetentionMetadata(retention)) {
        throw new Error("Invalid report retention metadata.");
      }
      await mkdir(dir, { recursive: true });
      options?.signal?.throwIfAborted();
      let reportCreated = false;
      try {
        await writeFile(filePath(id), contents, { flag: "wx" });
        reportCreated = true;
        options?.signal?.throwIfAborted();
        if (retention) {
          // Filesystems have no portable object custom-metadata API. Keep the
          // immutable clock in a companion outside the report-file pattern;
          // the facade treats a missing/malformed companion exactly like
          // missing R2 custom metadata and never falls back to mtime.
          await writeFile(retentionPath(id), `${JSON.stringify(retention)}\n`, { flag: "wx" });
          options?.signal?.throwIfAborted();
        }
      } catch (error) {
        // Roll back only after this call's create-only report write succeeded.
        // A conflict on the report itself belongs to another process and must
        // never trigger deletion of that process's in-flight bundle.
        if (reportCreated) {
          await removeFiles([retentionPath(id), filePath(id)]).catch(() => undefined);
        }
        throw error;
      }
      return { ownership: "certain" };
    },
    async writeSidecar(id, contents, options) {
      options?.signal?.throwIfAborted();
      await mkdir(dir, { recursive: true });
      options?.signal?.throwIfAborted();
      await writeFile(sidecarPath(id), contents, { flag: "wx" });
      options?.signal?.throwIfAborted();
    },
    async read(id, options) {
      options?.signal?.throwIfAborted();
      try {
        const report = await readBoundedUtf8File(
          filePath(id),
          SERVER_STORED_REPORT_JSON_MAX_BYTES,
          options?.signal
        );
        options?.signal?.throwIfAborted();
        const retention = await readRetentionFile(retentionPath(id), options?.signal);
        options?.signal?.throwIfAborted();
        return { contents: report.contents, lastModifiedMs: report.lastModifiedMs, retention };
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    },
    async readSidecar(id, options) {
      options?.signal?.throwIfAborted();
      try {
        const { contents } = await readBoundedUtf8File(
          sidecarPath(id),
          SERVER_STORED_PROVENANCE_SIDECAR_MAX_BYTES,
          options?.signal
        );
        options?.signal?.throwIfAborted();
        return contents;
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    },
    async remove(id, options) {
      options?.signal?.throwIfAborted();
      // Sidecar first: if deletion is interrupted, any surviving report fails
      // provenance closed instead of remaining publicly readable.
      await removeFiles([sidecarPath(id), retentionPath(id), filePath(id)], options);
    },
    async removeSidecar(id, options) {
      options?.signal?.throwIfAborted();
      // Reconciliation deliberately touches only the commit marker. A report
      // may have appeared after the listing snapshot in another process.
      await removeFiles([sidecarPath(id)], options);
    },
    async markRetentionDebt(debt, options) {
      options?.signal?.throwIfAborted();
      await mkdir(retentionDebtDir, { recursive: true });
      options?.signal?.throwIfAborted();
      try {
        await writeFile(retentionDebtPath(debt), "1\n", { flag: "wx" });
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      options?.signal?.throwIfAborted();
    },
    async clearRetentionDebt(debt, options) {
      await removeFiles([retentionDebtPath(debt)], options);
    },
    async retentionState(options) {
      options?.signal?.throwIfAborted();
      let entries;
      try {
        entries = await readdir(retentionDebtDir, { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, "ENOENT")) return { debts: [], maintenanceRequired: false };
        throw error;
      }
      const debts: ReportRetentionDebtEntry[] = [];
      let maintenanceRequired = false;
      for (const entry of entries) {
        options?.signal?.throwIfAborted();
        if (!entry.isFile()) continue;
        if (entry.name === "maintenance-required") {
          maintenanceRequired = true;
          continue;
        }
        const match = /^([0-9]{8}-[0-9a-f]{32})\.(bundle|sidecar)$/.exec(entry.name);
        if (!match) continue;
        if (debts.length >= 2_000) {
          throw new Error("Report retention debt exceeded the bounded 2,000-entry ledger.");
        }
        debts.push({ id: match[1], scope: match[2] as ReportRetentionDebtScope });
      }
      return { debts, maintenanceRequired };
    },
    async setRetentionMaintenanceRequired(required, options) {
      options?.signal?.throwIfAborted();
      if (!required) {
        await removeFiles([retentionMaintenancePath], options);
        return;
      }
      await mkdir(retentionDebtDir, { recursive: true });
      try {
        await writeFile(retentionMaintenancePath, "1\n", { flag: "wx" });
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      options?.signal?.throwIfAborted();
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
        options?.signal?.throwIfAborted();
      } catch (error) {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      }

      const entryNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
      const reportIds = new Set<string>();
      const sidecarIds = new Set<string>();
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const reportMatch = STORED_REPORT_FILE_PATTERN.exec(entry.name);
        if (reportMatch) reportIds.add(reportMatch[1]);
        const sidecarMatch = STORED_SIDECAR_FILE_PATTERN.exec(entry.name);
        if (sidecarMatch) sidecarIds.add(sidecarMatch[1]);
      }
      const files: StoredReportEntry[] = [];
      for (const id of new Set([...reportIds, ...sidecarIds])) {
        options?.signal?.throwIfAborted();
        const reportPresent = reportIds.has(id);
        const sidecarPresent = sidecarIds.has(id);
        const diagnosticPath = reportPresent ? filePath(id) : sidecarPath(id);
        try {
          const stats = await stat(diagnosticPath);
          options?.signal?.throwIfAborted();
          files.push({
            id,
            lastModifiedMs: stats.mtimeMs,
            retention: reportPresent ? await readRetentionFile(retentionPath(id), options?.signal) : null,
            reportPresent,
            sidecarPresent,
            committed: reportPresent && sidecarPresent && entryNames.has(committedSidecarFilename(id))
          });
        } catch (error) {
          if (!isErrno(error, "ENOENT")) throw error;
        }
      }
      return files;
    },
    status() {
      return { kind: "filesystem", path: dir, configuredPath };
    }
  };
}

export function isReportRetentionMetadata(value: unknown): value is ReportRetentionMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<ReportRetentionMetadata>;
  return (
    Object.keys(value).length === 2 &&
    isCanonicalTimestamp(metadata.createdAt) &&
    isCanonicalTimestamp(metadata.expiresAt) &&
    Date.parse(metadata.expiresAt) > Date.parse(metadata.createdAt)
  );
}

async function readRetentionFile(file: string, signal?: AbortSignal): Promise<ReportRetentionMetadata | null> {
  try {
    const { contents } = await readBoundedUtf8File(
      file,
      SERVER_STORED_RETENTION_METADATA_MAX_BYTES,
      signal
    );
    const parsed = parseStrictJson(contents, SERVER_STORED_RETENTION_METADATA_MAX_BYTES);
    return isReportRetentionMetadata(parsed) ? parsed : null;
  } catch (error) {
    if (
      isErrno(error, "ENOENT") ||
      error instanceof BoundedUtf8FileReadError ||
      error instanceof StrictJsonError
    ) {
      return null;
    }
    throw error;
  }
}

async function removeFiles(files: string[], options?: ReportStoreOperationOptions): Promise<void> {
  let firstError: unknown;
  for (const file of files) {
    options?.signal?.throwIfAborted();
    try {
      await unlink(file);
    } catch (error) {
      if (!isErrno(error, "ENOENT") && firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function reportStoreDir(): string {
  const configured = process.env[REPORT_STORE_DIR_ENV]?.trim();
  return configured ? path.resolve(configured) : DEFAULT_REPORT_STORE_DIR;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code
  );
}
