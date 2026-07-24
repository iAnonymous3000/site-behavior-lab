import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DurableScanJobInternalResponseInvalidUtf8Error,
  DurableScanJobInternalResponseTooLargeError
} from "./durable-scan-job-internal-response";
import {
  EdgeHealthOperationTimeoutError,
  parseEdgeHealthResponseText,
  readEdgeHealthResponseText,
  withEdgeHealthDeadline
} from "./edge-health-response";

test("edge health deadline bounds a stalled upstream before headers", async () => {
  await assert.rejects(
    withEdgeHealthDeadline(() => new Promise<Response>(() => undefined), { timeoutMs: 5 }),
    EdgeHealthOperationTimeoutError
  );
});

test("edge health deadline aborts a stalled response body", async () => {
  let cancelled = false;
  await assert.rejects(
    withEdgeHealthDeadline(async (signal) =>
      readEdgeHealthResponseText(
        new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          cancel() {
            cancelled = true;
          }
        })),
        signal,
        64
      ),
      { timeoutMs: 5 }
    ),
    EdgeHealthOperationTimeoutError
  );
  assert.equal(cancelled, true);
});

test("edge health body is decompressed-byte bounded", async () => {
  await assert.rejects(
    readEdgeHealthResponseText(
      new Response("{}", { headers: { "content-length": "1024" } }),
      undefined,
      64
    ),
    DurableScanJobInternalResponseTooLargeError
  );
  assert.equal(await readEdgeHealthResponseText(Response.json({ ok: true }), undefined, 64), '{"ok":true}');
});

test("edge health rejects raw invalid UTF-8 instead of repairing trusted upstream bytes", async () => {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('{"ok":true,"error":"'),
    0xff,
    ...new TextEncoder().encode('"}')
  ]);
  await assert.rejects(
    readEdgeHealthResponseText(new Response(bytes)),
    DurableScanJobInternalResponseInvalidUtf8Error
  );
});

test("edge health accepts only an unambiguous shared health contract", () => {
  const healthy = JSON.stringify({
    ok: true,
    status: "ok",
    scansAvailable: true,
    checks: {},
    capabilities: {},
    warnings: []
  });
  assert.equal(parseEdgeHealthResponseText(healthy).ok, true);
  assert.throws(() => parseEdgeHealthResponseText("not-json"));
  assert.throws(() => parseEdgeHealthResponseText("[]"));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":true}'));
  assert.throws(() => parseEdgeHealthResponseText('{"status":"ok"}'));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":true,"status":"ok","scansAvailable":true,"capabilities":{},"warnings":[]}'));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":true,"status":"ok","scansAvailable":true,"checks":{},"warnings":[]}'));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":true,"status":"ok","checks":{},"capabilities":{},"warnings":[]}'));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":false,"status":"ok","scansAvailable":true,"checks":{},"capabilities":{},"warnings":[]}'));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":true,"status":"error","scansAvailable":false,"checks":{},"capabilities":{},"warnings":[]}'));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":true,"status":"ok","scansAvailable":false,"checks":{},"capabilities":{},"warnings":[]}'));
  assert.throws(() => parseEdgeHealthResponseText('{"ok":true,"ok":false}'));
});
