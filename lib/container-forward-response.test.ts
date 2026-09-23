import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  ContainerForwardResponseTooLargeError,
  ContainerForwardTimeoutError,
  forwardContainerResponseWithinDeadline
} from "./container-forward-response";

test("container forwarding preserves a bounded streaming response", async () => {
  const response = await forwardContainerResponseWithinDeadline(
    async () => new Response("12345", { status: 201, headers: { "x-test": "yes" } }),
    { timeoutMs: 1_000, maxBytes: 5 }
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("x-test"), "yes");
  assert.equal(await response.text(), "12345");
});

test("container dispatch loses an explicit deadline race even when it ignores abort", async () => {
  let observedSignal: AbortSignal | null = null;
  const started = Date.now();
  await assert.rejects(
    forwardContainerResponseWithinDeadline(
      async (signal) => {
        observedSignal = signal;
        return new Promise<Response>(() => undefined);
      },
      { timeoutMs: 5, maxBytes: 64 }
    ),
    (error: unknown) => error instanceof ContainerForwardTimeoutError
  );
  assert.equal((observedSignal as AbortSignal | null)?.aborted, true);
  assert.ok(Date.now() - started < 1_000, "the 5ms deadline must win, not the 180s default");
});

test("container body deadline returns without awaiting a non-cooperative read or cancel", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => undefined);
    }
  });
  const response = await forwardContainerResponseWithinDeadline(
    async () => new Response(source),
    { timeoutMs: 5, maxBytes: 64 }
  );

  const started = Date.now();
  await assert.rejects(
    response.arrayBuffer(),
    (error: unknown) => error instanceof ContainerForwardTimeoutError
  );
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 1_000, "the 5ms body deadline must not wait on the read or cancel");
});

test("container forwarding rejects declared and streamed oversize bodies without waiting for cancel", async () => {
  const declared = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      return new Promise<void>(() => undefined);
    }
  });
  const declaredStarted = Date.now();
  await assert.rejects(
    forwardContainerResponseWithinDeadline(
      async () => new Response(declared, { headers: { "content-length": "65" } }),
      { timeoutMs: 10_000, maxBytes: 64 }
    ),
    (error: unknown) => error instanceof ContainerForwardResponseTooLargeError
  );
  assert.ok(
    Date.now() - declaredStarted < 1_000,
    "a declared oversize body is refused at once, not at the 10s deadline or after cancel"
  );

  const streamed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(40));
      controller.enqueue(new Uint8Array(25));
    },
    cancel() {
      return new Promise<void>(() => undefined);
    }
  });
  const response = await forwardContainerResponseWithinDeadline(
    async () => new Response(streamed),
    { timeoutMs: 1_000, maxBytes: 64 }
  );
  await assert.rejects(
    response.arrayBuffer(),
    (error: unknown) => error instanceof ContainerForwardResponseTooLargeError
  );
});

test("bodyless responses do not mistake representation Content-Length for body bytes", async () => {
  const response = await forwardContainerResponseWithinDeadline(
    async () => new Response(null, { headers: { "content-length": "999999" } }),
    { timeoutMs: 1_000, maxBytes: 64 }
  );
  assert.equal(response.body, null);
});

test("caller cancellation rejects dispatch even when the callback ignores it", async () => {
  const caller = new AbortController();
  const reason = new DOMException("request ended", "AbortError");
  const pending = forwardContainerResponseWithinDeadline(
    async () => new Promise<Response>(() => undefined),
    { signal: caller.signal, timeoutMs: 1_000, maxBytes: 64 }
  );
  caller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("the public container ingress applies the whole-operation forwarding boundary", async () => {
  const source = await readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");

  assert.match(source, /import \{ forwardContainerResponseWithinDeadline \}/);
  assert.match(source, /return await forwardContainerResponseWithinDeadline\(/);
  assert.match(source, /\{ signal: request\.signal \}/);
  assert.match(source, /return containerUnavailableResponse\(request, env\)/);
});
