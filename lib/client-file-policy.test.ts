import assert from "node:assert/strict";
import test from "node:test";
import {
  ClientFileEmptyError,
  ClientFileInvalidUtf8Error,
  ClientFileTooLargeError,
  assertClientFileReadable,
  readClientFileArrayBuffer,
  readClientFileText
} from "./client-file-policy";

test("oversized and empty files are rejected before text or byte allocation", async () => {
  let textReads = 0;
  const oversizedText = {
    size: 9,
    arrayBuffer: async () => {
      textReads += 1;
      return new TextEncoder().encode("too large").buffer;
    }
  } as Pick<File, "size" | "arrayBuffer">;
  await assert.rejects(
    readClientFileText(oversizedText, { label: "That report file", maxBytes: 8 }),
    (error) =>
      error instanceof ClientFileTooLargeError &&
      error.actualBytes === 9 &&
      error.maxBytes === 8 &&
      /uploads are limited to 8 bytes/.test(error.message)
  );
  assert.equal(textReads, 0);

  let bufferReads = 0;
  const emptyBuffer = {
    size: 0,
    arrayBuffer: async () => {
      bufferReads += 1;
      return new ArrayBuffer(0);
    }
  } as Pick<File, "size" | "arrayBuffer">;
  await assert.rejects(
    readClientFileArrayBuffer(emptyBuffer, { label: "The PageGraph capture", maxBytes: 8 }),
    ClientFileEmptyError
  );
  assert.equal(bufferReads, 0);
});

test("the read boundary admits exact-limit files and distrusts non-native returned lengths", async () => {
  const text = await readClientFileText(
    byteFile(new TextEncoder().encode("test")),
    { label: "Report JSON", maxBytes: 4 }
  );
  assert.equal(text, "test");

  await assert.rejects(
    readClientFileText(
      byteFile(new TextEncoder().encode("€"), 1),
      { label: "Report JSON", maxBytes: 2 }
    ),
    (error) => error instanceof ClientFileTooLargeError && error.actualBytes === 3
  );

  await assert.rejects(
    readClientFileArrayBuffer(
      {
        size: 1,
        arrayBuffer: async () => new Uint8Array([1, 2]).buffer
      } as Pick<File, "size" | "arrayBuffer">,
      { label: "Capture", maxBytes: 1 }
    ),
    (error) => error instanceof ClientFileTooLargeError && error.actualBytes === 2
  );
});

test("caller cancellation is checked before and after a non-abortable File read", async () => {
  const before = new AbortController();
  const beforeReason = new Error("cancelled before read");
  before.abort(beforeReason);
  let reads = 0;
  await assert.rejects(
    readClientFileText(
      {
        size: 2,
        arrayBuffer: async () => {
          reads += 1;
          return new TextEncoder().encode("{}").buffer;
        }
      } as Pick<File, "size" | "arrayBuffer">,
      { label: "Report", maxBytes: 8, signal: before.signal }
    ),
    (error) => error === beforeReason
  );
  assert.equal(reads, 0);

  const during = new AbortController();
  let finishRead: ((value: ArrayBuffer) => void) | undefined;
  const pending = readClientFileText(
    {
      size: 2,
      arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => {
        finishRead = resolve;
      })
    } as Pick<File, "size" | "arrayBuffer">,
    { label: "Report", maxBytes: 8, signal: during.signal }
  );
  const duringReason = new Error("superseded while reading");
  during.abort(duringReason);
  finishRead?.(new TextEncoder().encode("{}").buffer);
  await assert.rejects(pending, (error) => error === duringReason);
});

test("text reads reject invalid UTF-8 instead of accepting replacement characters", async () => {
  await assert.rejects(
    readClientFileText(byteFile(new Uint8Array([0xff])), {
      label: "Report JSON",
      maxBytes: 8
    }),
    (error) =>
      error instanceof ClientFileInvalidUtf8Error &&
      /not valid UTF-8/.test(error.message)
  );
});

test("file policies reject invalid limits and forged byte lengths", () => {
  assert.throws(
    () => assertClientFileReadable({ size: Number.NaN }, { label: "Upload", maxBytes: 1 }),
    /invalid byte length/
  );
  assert.throws(
    () => assertClientFileReadable({ size: 1 }, { label: "Upload", maxBytes: 0 }),
    /positive integer/
  );
});

function byteFile(bytes: Uint8Array, declaredSize = bytes.byteLength): Pick<File, "size" | "arrayBuffer"> {
  return {
    size: declaredSize,
    arrayBuffer: async () => bytes.slice().buffer
  };
}
