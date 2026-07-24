import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const REPORT_CORPUS_LOCK_FILENAME = ".report-corpus-write.lock";

export class ReportCorpusLockedError extends Error {
  constructor(readonly lockPath: string) {
    super(`Report corpus is locked by another writer: ${lockPath}`);
    this.name = "ReportCorpusLockedError";
  }
}

export type ReportCorpusLock = {
  path: string;
  release(): Promise<void>;
};

/**
 * Cooperative exclusive lease shared by remediation and every in-repo corpus
 * mutator. `wx` makes acquisition atomic; a crash leaves a fail-closed lock
 * that an operator must inspect and remove deliberately.
 */
export async function acquireReportCorpusLock(
  reportsDir: string,
  operation: string
): Promise<ReportCorpusLock> {
  const lockPath = path.join(reportsDir, REPORT_CORPUS_LOCK_FILENAME);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) throw new ReportCorpusLockedError(lockPath);
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ operation, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      "utf8"
    );
    await handle.sync();
  } catch (error) {
    await retireOwnedLock(handle, lockPath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      await retireOwnedLock(handle, lockPath);
    }
  };
}

/**
 * Atomically move the public lock name to an unguessable retirement path,
 * verify that the moved inode is the handle we acquired, then delete only
 * that private name. If another process replaced the public path, restore a
 * hard link without overwriting any newer lock and leave the retirement copy
 * for operator inspection. We never unlink a pathname after a separate
 * identity check.
 */
async function retireOwnedLock(
  handle: Awaited<ReturnType<typeof open>>,
  lockPath: string
): Promise<void> {
  const held = await handle.stat();
  const retiredPath = `${lockPath}.${process.pid}.${randomUUID()}.retired`;
  try {
    await rename(lockPath, retiredPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }

  const moved = await lstat(retiredPath).catch(() => null);
  if (moved === null || moved.dev !== held.dev || moved.ino !== held.ino) {
    await handle.close().catch(() => undefined);
    if (moved !== null) {
      // `link` is create-only: it restores the displaced replacement when the
      // fixed name is free and never overwrites a lock acquired meanwhile.
      await link(retiredPath, lockPath).catch((error: unknown) => {
        if (!isErrno(error, "EEXIST")) throw error;
      });
    }
    throw new Error(`Report corpus lock identity changed before release: ${lockPath}`);
  }

  await handle.close();
  await unlink(retiredPath);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
