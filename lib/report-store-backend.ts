import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { committedSidecarFilename } from "./redaction-provenance";
import { createR2ReportStoreBackend } from "./report-store-r2";

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
};

export type ReportRetentionMetadata = {
  createdAt: string;
  expiresAt: string;
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
  write(id: string, contents: string, retention?: ReportRetentionMetadata): Promise<void>;
  /** Create-only sidecar write, deliberately after the report write. */
  writeSidecar(id: string, contents: string): Promise<void>;
  read(id: string): Promise<StoredReportBlob | null>;
  readSidecar(id: string): Promise<string | null>;
  /** Idempotently removes report, retention metadata, and provenance sidecar. */
  remove(id: string): Promise<void>;
  list(): Promise<StoredReportEntry[]>;
  status(): ReportStoreBackendStatus;
}

const REPORT_STORE_BACKEND_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND";
const REPORT_STORE_DIR_ENV = "SITE_BEHAVIOR_LAB_REPORT_STORE_DIR";
const DEFAULT_REPORT_STORE_DIR = path.join(process.cwd(), ".site-behavior-lab", "reports");
const STORED_REPORT_FILE_PATTERN = /^[0-9]{8}-[0-9a-f]{8,32}\.json$/;

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

  return {
    kind: "filesystem",
    async write(id, contents, retention) {
      if (retention !== undefined && !isReportRetentionMetadata(retention)) {
        throw new Error("Invalid report retention metadata.");
      }
      await mkdir(dir, { recursive: true });
      await writeFile(filePath(id), contents, { flag: "wx" });
      if (retention) {
        // Filesystems have no portable object custom-metadata API. Keep the
        // immutable clock in a companion outside the report-file pattern; the
        // facade treats a missing/malformed companion exactly like missing R2
        // custom metadata and never falls back to mtime.
        await writeFile(retentionPath(id), `${JSON.stringify(retention)}\n`, { flag: "wx" });
      }
    },
    async writeSidecar(id, contents) {
      await mkdir(dir, { recursive: true });
      await writeFile(sidecarPath(id), contents, { flag: "wx" });
    },
    async read(id) {
      try {
        const stats = await stat(filePath(id));
        const contents = await readFile(filePath(id), "utf8");
        const retention = await readRetentionFile(retentionPath(id));
        return { contents, lastModifiedMs: stats.mtimeMs, retention };
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    },
    async readSidecar(id) {
      try {
        return await readFile(sidecarPath(id), "utf8");
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    },
    async remove(id) {
      // Sidecar first: if deletion is interrupted, any surviving report fails
      // provenance closed instead of remaining publicly readable.
      await removeFiles([sidecarPath(id), retentionPath(id), filePath(id)]);
    },
    async list() {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, "ENOENT")) return [];
        throw error;
      }

      const files: StoredReportEntry[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !STORED_REPORT_FILE_PATTERN.test(entry.name)) continue;
        try {
          const stats = await stat(path.join(dir, entry.name));
          const id = entry.name.replace(/\.json$/, "");
          files.push({
            id,
            lastModifiedMs: stats.mtimeMs,
            retention: await readRetentionFile(retentionPath(id))
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

async function readRetentionFile(file: string): Promise<ReportRetentionMetadata | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isReportRetentionMetadata(parsed) ? parsed : null;
  } catch (error) {
    if (isErrno(error, "ENOENT") || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function removeFiles(files: string[]): Promise<void> {
  let firstError: unknown;
  for (const file of files) {
    try {
      await unlink(file);
    } catch (error) {
      if (!isErrno(error, "ENOENT") && firstError === undefined) firstError = error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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
