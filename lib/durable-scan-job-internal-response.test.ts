import assert from "node:assert/strict";
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
    { headers: { "content-length": "1024" } }
  );

  await assert.rejects(
    settleWithin(readDurableScanJobInternalResponseBytes(response, undefined, 32)),
    (error: unknown) =>
      error instanceof DurableScanJobInternalResponseTooLargeError && error.maxBytes === 32
  );
  assert.equal(cancelled, true);
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
