import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { readBoundedUtf8File } from "./bounded-utf8-file";

/**
 * Atomically replace a generated UTF-8 control file and prove its exact bytes
 * from the destination path before returning. Callers are responsible for any
 * higher-level corpus lease that must cover the read/build/write transaction.
 */
export async function replaceUtf8FileAtomically(
  file: string,
  contents: string,
  maxBytes: number,
  mode = 0o644
): Promise<void> {
  const expected = Buffer.from(contents, "utf8");
  if (expected.byteLength > maxBytes) {
    throw new Error(`Generated file ${path.basename(file)} exceeds its ${maxBytes}-byte limit.`);
  }

  const directory = path.dirname(file);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, "wx", mode);
    await handle.writeFile(expected);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, file);

    // Persist the rename itself, not only the temporary file's contents.
    await syncDirectory(directory);

    const readback = await readBoundedUtf8File(file, maxBytes);
    if (readback.contents !== contents || !Buffer.from(readback.contents, "utf8").equals(expected)) {
      throw new Error(`Generated file ${path.basename(file)} changed during exact readback.`);
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch((error: unknown) => {
      if (!isErrno(error, "ENOENT")) throw error;
    });
  }
}

/**
 * Create a new evidence object with exclusive semantics, persist its contents,
 * then persist the directory entry before the caller may create a dependent
 * sidecar. A failed write is deliberately left fail-closed for inspection.
 */
export async function writeNewFileDurably(
  file: string,
  contents: string | Uint8Array,
  mode = 0o644
): Promise<void> {
  const handle = await open(file, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

export async function syncDirectory(directory: string): Promise<void> {
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await directoryHandle.stat();
    if (!metadata.isDirectory()) throw new Error(`${directory} is not a directory.`);
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code
  );
}
