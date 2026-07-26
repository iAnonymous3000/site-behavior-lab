import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const worker = readFileSync(path.join(process.cwd(), "cloudflare", "container-worker.ts"), "utf8");
const model = readFileSync(path.join(process.cwd(), "docs", "scan-job-model.md"), "utf8");

test("the durable admission path reserves a preparation slot before it buys any preparation", () => {
  // The whole value of the bound is its position. Reserving after the crossing
  // to Node would bound nothing: the DNS resolution and preparation the replay
  // was buying would already have happened.
  const reserve = worker.indexOf("reserveDurablePreparationSlot({");
  const recovery = worker.indexOf("findCommittedScanAdmission(scanAdmissionKey)");
  const deferGate = worker.indexOf('"defer",');
  const submit = worker.indexOf("submitDurableScanJob(");

  assert.ok(recovery > 0 && reserve > 0 && deferGate > 0 && submit > 0);
  assert.ok(
    recovery < reserve,
    "an honest retry must recover its committed admission before any reservation is attempted"
  );
  assert.ok(reserve < deferGate, "the slot must be held before the deferred quota peek");
  assert.ok(reserve < submit, "the slot must be held before the crossing to Node preparation");
});

test("the slot is released on every exit path, and a cleanup failure never becomes the caller's error", () => {
  const reserve = worker.indexOf("reserveDurablePreparationSlot({");
  const tail = worker.slice(reserve);
  const release = tail.indexOf("releaseDurablePreparationSlot({");
  assert.ok(release > 0, "the reservation must be released");

  // The release must sit in a finally, so an aborted deadline or a refused
  // commit frees the capability instead of stranding it for the full window.
  const between = tail.slice(0, release);
  assert.match(between, /\}\s*finally\s*\{/);
  // And the release itself is wrapped, because the row expires on its own.
  assert.match(tail.slice(release, release + 600), /catch \(error\) \{/);
});

test("a concurrent replay is refused as concurrency, and exhaustion as unavailability", () => {
  assert.match(worker, /class DurablePreparationInFlightError extends EdgeScanGateError/);
  assert.match(worker, /class DurablePreparationCapacityError extends EdgeScanGateError/);
  // In-flight is the caller's own duplicate: retryable, nothing was charged.
  assert.match(worker, /This scan request is already being prepared\./);
  assert.match(worker, /throw new DurablePreparationInFlightError\(reservation\.retryAfterSeconds\)/);
  assert.match(worker, /throw new DurablePreparationCapacityError\(reservation\.retryAfterSeconds\)/);
});

test("the reservation is bound to the admission deadline, never a free-running timer", () => {
  const reserve = worker.indexOf("reserveDurablePreparationSlot({");
  const call = worker.slice(reserve, reserve + 300);
  assert.match(call, /capabilityHash: scanAdmissionKey\.capabilityHash/);
  assert.match(call, /expiresAt: commitNotAfter/);
});

test("the Durable Object takes the slot inside one transaction", () => {
  // A read-then-write across the RPC boundary would reintroduce exactly the
  // race the reservation exists to close.
  const method = worker.slice(worker.indexOf("reserveDurablePreparationSlot(input:"));
  const body = method.slice(0, method.indexOf("releaseDurablePreparationSlot(input:"));
  assert.match(body, /this\.ctx\.storage\.transactionSync\(/);
  assert.match(body, /reserveDurablePreparationInStore\(/);
});

test("the activation gate is recorded as closed rather than still pending", () => {
  // The source comment and the model doc both used to say the unbounded peek
  // "is acceptable only while SITE_BEHAVIOR_LAB_DURABLE_JOBS=0". Leaving that
  // in place would tell the next reader the flag is still blocked.
  assert.doesNotMatch(worker, /acceptable only while `?SITE_BEHAVIOR_LAB_DURABLE_JOBS=0/);
  assert.doesNotMatch(worker, /is an ACTIVATION GATE for that flag/);
  assert.doesNotMatch(model, /Before `SITE_BEHAVIOR_LAB_DURABLE_JOBS=1`, either reserve the quota slot/);
  assert.match(model, /bound in-flight uncommitted preparations/i);
});
