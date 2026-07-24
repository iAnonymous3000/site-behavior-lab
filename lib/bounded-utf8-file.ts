import { constants } from "node:fs";
import { open } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

export type BoundedUtf8FileReadFailure =
  | "too-large"
  | "invalid-utf8"
  | "not-regular-file"
  | "symlink"
  | "changed-during-read";

export class BoundedUtf8FileReadError extends Error {
  constructor(
    readonly reason: BoundedUtf8FileReadFailure,
    readonly maxBytes: number
  ) {
    super(
      reason === "too-large"
        ? `Stored JSON file exceeded ${maxBytes} bytes.`
        : reason === "invalid-utf8"
          ? "Stored JSON file was not exact valid UTF-8."
          : reason === "not-regular-file"
            ? "Stored JSON path was not a regular file."
            : reason === "symlink"
              ? "Stored JSON path was a symbolic link."
              : "Stored JSON file changed while it was being read."
    );
    this.name = "BoundedUtf8FileReadError";
  }
}

export type BoundedUtf8FileRead = {
  contents: string;
  lastModifiedMs: number;
};

/**
 * Read one regular file without an unbounded allocation, replacement decoding,
 * BOM normalization, or accepting a file that changed during the read.
 */
export async function readBoundedUtf8File(
  file: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BoundedUtf8FileRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("The stored JSON file limit must be a non-negative safe integer.");
  }
  signal?.throwIfAborted();

  let handle;
  try {
    // Managed artifacts are selected by trusted filenames. Never let an
    // attacker replace one with a link to bytes outside the report store.
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ELOOP")) throw new BoundedUtf8FileReadError("symlink", maxBytes);
    throw error;
  }
  try {
    signal?.throwIfAborted();
    const before = await handle.stat();
    if (!before.isFile()) throw new BoundedUtf8FileReadError("not-regular-file", maxBytes);
    if (!Number.isSafeInteger(before.size) || before.size > maxBytes) {
      throw new BoundedUtf8FileReadError("too-large", maxBytes);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for (;;) {
      signal?.throwIfAborted();
      const remainingWithOverflowByte = maxBytes - totalBytes + 1;
      const chunk = new Uint8Array(Math.min(READ_CHUNK_BYTES, remainingWithOverflowByte));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      signal?.throwIfAborted();
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) throw new BoundedUtf8FileReadError("too-large", maxBytes);
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      totalBytes !== after.size
    ) {
      throw new BoundedUtf8FileReadError("changed-during-read", maxBytes);
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    let contents: string;
    try {
      // `ignoreBOM: true` preserves a leading BOM as U+FEFF, so JSON parsing
      // rejects it instead of silently validating bytes different from disk.
      contents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new BoundedUtf8FileReadError("invalid-utf8", maxBytes);
    }
    return { contents, lastModifiedMs: after.mtimeMs };
  } finally {
    await handle.close();
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: string }).code === code
  );
}
