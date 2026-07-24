import assert from "node:assert/strict";
import test from "node:test";
import {
  DURABLE_SCAN_JOB_COORDINATOR_RESPONSE_MAX_BYTES,
  DurableScanJobCoordinatorError,
  createDurableScanJobCoordinatorClient
} from "./durable-scan-job-node";

const JOB_ID = `20260721-${"a".repeat(32)}`;
const LEASE_TOKEN = "A".repeat(43);
const INTERNAL_TOKEN = "internal-".padEnd(32, "x");

test("coordinator control responses cannot exceed the decompressed byte cap", async () => {
  let cancelled = false;
  const client = createDurableScanJobCoordinatorClient({
    coordinatorUrl: "https://scanner.example",
    internalToken: INTERNAL_TOKEN,
    fetchImpl: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(DURABLE_SCAN_JOB_COORDINATOR_RESPONSE_MAX_BYTES + 1));
          },
          cancel() {
            cancelled = true;
          }
        }),
        { status: 200 }
      )) as typeof fetch
  });

  await assert.rejects(
    () => client.heartbeat({ jobId: JOB_ID, generation: 1, leaseToken: LEASE_TOKEN }),
    (error: unknown) => error instanceof DurableScanJobCoordinatorError && error.status === null
  );
  assert.equal(cancelled, true);
});
