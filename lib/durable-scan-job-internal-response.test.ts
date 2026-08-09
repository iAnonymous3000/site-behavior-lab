import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DurableScanJobInternalResponseInvalidUtf8Error,
  DurableScanJobInternalResponseTooLargeError,
  readDurableScanJobInternalResponseBytes,
  readDurableScanJobInternalResponseJson
} from "./durable-scan-job-internal-response";

test("bounded internal response parsing preserves small JSON payloads", async () => {
  const payload = await readDurableScanJobInternalResponseJson(
    Response.json({ outcome: "succeeded" }),
    undefined,
    128
  );
  assert.deepEqual(payload, { outcome: "succeeded" });
});

test("bounded internal JSON rejects malformed UTF-8 instead of replacement-decoding it", async () => {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('{"value":"'),
    0xc3,
    0x28,
    ...new TextEncoder().encode('"}')
  ]);

  await assert.rejects(
    readDurableScanJobInternalResponseJson(new Response(bytes), undefined, 128),
    (error: unknown) => error instanceof DurableScanJobInternalResponseInvalidUtf8Error
  );
});

test("bounded internal JSON rejects duplicate keys instead of accepting last-key-wins", async () => {
  await assert.rejects(
    readDurableScanJobInternalResponseJson(
      new Response('{"outcome":"succeeded","outcome":"failed"}'),
      undefined,
      128
    ),
    (error: unknown) =>
      error instanceof Error && error.name === "StrictJsonError" && error.message === "duplicate-key"
  );
});

test("declared oversized internal responses fail before body consumption", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      }
    }),
    {
      headers: {
        "content-encoding": "identity",
        "content-length": "1024"
      }
    }
  );

  await assert.rejects(
    settleWithin(readDurableScanJobInternalResponseBytes(response, undefined, 32)),
    (error: unknown) =>
      error instanceof DurableScanJobInternalResponseTooLargeError && error.maxBytes === 32
  );
  assert.equal(cancelled, true);
});

test("encoded internal responses ignore wire Content-Length and cap decoded bytes", async () => {
  const response = new Response(Uint8Array.of(1, 2, 3, 4), {
    headers: {
      "content-encoding": "gzip",
      "content-length": "1024"
    }
  });
  assert.deepEqual(
    await readDurableScanJobInternalResponseBytes(response, undefined, 4),
    Uint8Array.of(1, 2, 3, 4)
  );
});

test("identity internal responses must finish at their exact declared length", async () => {
  assert.deepEqual(
    await readDurableScanJobInternalResponseBytes(
      new Response(Uint8Array.of(1, 2, 3, 4), {
        headers: {
          "content-encoding": "identity",
          "content-length": "4"
        }
      }),
      undefined,
      8
    ),
    Uint8Array.of(1, 2, 3, 4)
  );

  await assert.rejects(
    readDurableScanJobInternalResponseBytes(
      new Response(Uint8Array.of(1, 2, 3, 4), {
        headers: {
          "content-encoding": "identity",
          "content-length": "3"
        }
      }),
      undefined,
      8
    ),
    /length did not match Content-Length/
  );
});

test("streamed internal responses cannot cross the decompressed byte cap", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(20));
        controller.enqueue(new Uint8Array(20));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      }
    })
  );

  await assert.rejects(
    settleWithin(readDurableScanJobInternalResponseBytes(response, undefined, 32)),
    (error: unknown) => error instanceof DurableScanJobInternalResponseTooLargeError
  );
  assert.equal(cancelled, true);
});

test("bounded internal responses retain one fixed buffer across empty and tiny chunks", async () => {
  const emptyChunks = 50_000;
  const expectedBytes = 256;
  let reads = 0;
  const reader = {
    async read() {
      if (reads < emptyChunks) {
        reads += 1;
        return { done: false as const, value: new Uint8Array() };
      }
      if (reads < emptyChunks + expectedBytes) {
        reads += 1;
        return { done: false as const, value: Uint8Array.of(120) };
      }
      return { done: true as const, value: undefined };
    },
    cancel() {
      return Promise.resolve();
    },
    releaseLock() {}
  };
  const responseLike = {
    headers: new Headers(),
    body: { getReader: () => reader }
  } as unknown as Response;

  assert.deepEqual(
    await readDurableScanJobInternalResponseBytes(
      responseLike,
      undefined,
      expectedBytes
    ),
    new Uint8Array(expectedBytes).fill(120)
  );
  assert.equal(reads, emptyChunks + expectedBytes);
  const source = readFileSync(
    path.join(
      process.cwd(),
      "lib",
      "durable-scan-job-internal-response.ts"
    ),
    "utf8"
  );
  assert.match(source, /new Uint8Array\(Math\.min\(maxBytes, 64 \* 1024\)\)/);
  assert.doesNotMatch(source, /new Uint8Array\(maxBytes\)/);
  assert.doesNotMatch(source, /const chunks: Uint8Array\[\]/);
});

test("bounded internal responses do not reserve a report-sized ceiling for a tiny body", async () => {
  const maxBytes = 32 * 1024 * 1024;
  assert.deepEqual(
    await readDurableScanJobInternalResponseBytes(
      new Response(Uint8Array.of(1, 2, 3)),
      undefined,
      maxBytes
    ),
    Uint8Array.of(1, 2, 3)
  );

  const source = readFileSync(
    path.join(process.cwd(), "lib", "durable-scan-job-internal-response.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /new Uint8Array\(maxBytes\)/);
});

test("bounded internal over-cap refusal survives hostile cancellation and lock release", async () => {
  let cancelled = false;
  const reader = {
    async read() {
      return { done: false as const, value: new Uint8Array(11) };
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    },
    releaseLock() {
      throw new Error("hostile releaseLock");
    }
  };
  const responseLike = {
    headers: new Headers(),
    body: { getReader: () => reader }
  } as unknown as Response;

  await assert.rejects(
    settleWithin(
      readDurableScanJobInternalResponseBytes(
        responseLike,
        undefined,
        10
      )
    ),
    (error: unknown) =>
      error instanceof DurableScanJobInternalResponseTooLargeError &&
      error.maxBytes === 10
  );
  assert.equal(cancelled, true);
});

test("caller abort terminates a body that never finishes", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      }
    })
  );
  const controller = new AbortController();
  const reason = new DOMException("pump budget elapsed", "TimeoutError");
  const reading = readDurableScanJobInternalResponseBytes(response, controller.signal, 32);
  controller.abort(reason);

  await assert.rejects(settleWithin(reading), (error: unknown) => error === reason);
  assert.equal(cancelled, true);
});

function settleWithin<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The bounded response helper did not settle promptly.")),
      timeoutMs
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

test("invalid internal response limits fail closed", async () => {
  await assert.rejects(
    readDurableScanJobInternalResponseBytes(new Response("ok"), undefined, 0),
    /must be a positive integer/
  );
});
