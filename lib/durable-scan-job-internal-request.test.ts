import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DURABLE_SCAN_JOB_INTERNAL_REQUEST_MAX_BYTES,
  DurableScanJobCoordinatorError,
  readDurableScanJobInternalRequestJson
} from "./durable-scan-job-node";

test("private durable control JSON is parsed only inside the request cap", async () => {
  const request = new Request("https://scanner.example/internal", {
    method: "POST",
    body: JSON.stringify({ jobId: "job", generation: 1 })
  });
  assert.deepEqual(await readDurableScanJobInternalRequestJson(request), { jobId: "job", generation: 1 });

  await assert.rejects(
    () => readDurableScanJobInternalRequestJson(
      new Request("https://scanner.example/internal", { method: "POST", body: "not-json" })
    ),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === 400
  );

  await assert.rejects(
    () => readDurableScanJobInternalRequestJson(
      new Request("https://scanner.example/internal", {
        method: "POST",
        body: '{"jobId":"first","jobId":"second","generation":1}'
      })
    ),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === 400
  );
});

test("private durable control JSON rejects declared and streamed oversized bodies", async () => {
  const declared = {
    headers: new Headers({
      "content-length": String(DURABLE_SCAN_JOB_INTERNAL_REQUEST_MAX_BYTES + 1)
    }),
    body: new ReadableStream<Uint8Array>()
  } as unknown as Request;
  await assert.rejects(
    () => readDurableScanJobInternalRequestJson(declared),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === 413
  );

  let cancelled = false;
  const streamed = {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DURABLE_SCAN_JOB_INTERNAL_REQUEST_MAX_BYTES + 1));
      },
      cancel() {
        cancelled = true;
      }
    })
  } as unknown as Request;
  await assert.rejects(
    () => readDurableScanJobInternalRequestJson(streamed),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === 413
  );
  assert.equal(cancelled, true);
});

test("every private durable JSON route uses the bounded reader", () => {
  for (const file of [
    "app/api/internal/durable-scans/[id]/route.ts",
    "app/api/internal/durable-scans/[id]/reconcile/route.ts"
  ]) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    assert.match(source, /readDurableScanJobInternalRequestJson\(request\)/);
    assert.doesNotMatch(source, /request\.json\(\)/);
  }
});
