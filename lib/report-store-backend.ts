import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createR2ReportStoreBackend } from "./report-store-r2";

export type ReportStoreKind = "filesystem" | "r2";

export type StoredReportBlob = {
  contents: string;
  lastModifiedMs: number;
};

export type StoredReportEntry = {
  id: string;
  lastModifiedMs: number;
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
  write(id: string, contents: string): Promise<void>;
  read(id: string): Promise<StoredReportBlob | null>;
  /** Idempotent: a missing `id` is not an error. */
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

  return {
    kind: "filesystem",
    async write(id, contents) {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath(id), contents, { flag: "wx" });
    },
    async read(id) {
      try {
        const stats = await stat(filePath(id));
        const contents = await readFile(filePath(id), "utf8");
        return { contents, lastModifiedMs: stats.mtimeMs };
      } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        throw error;
      }
    },
    async remove(id) {
      try {
        await unlink(filePath(id));
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
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
          files.push({ id: entry.name.replace(/\.json$/, ""), lastModifiedMs: stats.mtimeMs });
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

function reportStoreDir(): string {
  const configured = process.env[REPORT_STORE_DIR_ENV]?.trim();
  return configured ? path.resolve(configured) : DEFAULT_REPORT_STORE_DIR;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code
  );
}
