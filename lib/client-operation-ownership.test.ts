import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  assertClientOperationOwner,
  ClientOperationOwner,
  type ClientOperationLease
} from "./client-operation-ownership";

type Kind = "submit" | "resume" | "cancel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test("two synchronous submissions mint one credential and can create only one job", async () => {
  const owner = new ClientOperationOwner<Kind>();
  const accepted = deferred<string>();
  let credentialsMinted = 0;
  let jobsRetained = 0;

  async function submit(): Promise<boolean> {
    const operation = owner.claim("submit");
    if (operation === null) return false;
    credentialsMinted += 1;
    const jobId = await accepted.promise;
    assertClientOperationOwner(owner, operation);
    assert.equal(jobId, "job-1");
    jobsRetained += 1;
    owner.release(operation);
    return true;
  }

  const first = submit();
  const second = submit();
  assert.equal(credentialsMinted, 1, "a same-turn duplicate never mints another capability");
  assert.equal(await second, false, "a same-turn duplicate never reaches submission");
  accepted.resolve("job-1");
  assert.equal(await first, true);
  assert.equal(jobsRetained, 1, "the one accepted server job remains owned and retained");
});

test("an old completion and finally block cannot overwrite or clear a newer operation", async () => {
  const owner = new ClientOperationOwner<Kind>();
  const oldCompletion = deferred<string>();
  const state = { loaded: "initial", loading: true, currentJob: "job-new" };
  const old = owner.claim("resume");
  assert.ok(old);

  const oldTask = oldCompletion.promise
    .then((result) => {
      if (owner.owns(old)) state.loaded = result;
    })
    .finally(() => {
      if (owner.release(old)) state.loading = false;
    });

  const newer = owner.supersede("cancel");
  state.loaded = "new-result";
  state.loading = true;
  state.currentJob = "job-new";
  assert.equal(old.controller.signal.aborted, true);
  assert.ok(newer.token > old.token);

  oldCompletion.resolve("stale-result");
  await oldTask;
  assert.deepEqual(state, { loaded: "new-result", loading: true, currentJob: "job-new" });
  assert.equal(owner.current(), newer);
});

test("a superseded callback cannot mutate recovery persistence", () => {
  const owner = new ClientOperationOwner<Kind>();
  const stale = owner.claim("submit") as ClientOperationLease<Kind>;
  const storedCapabilities: string[] = [];
  owner.supersede("cancel");

  assert.throws(
    () => {
      assertClientOperationOwner(owner, stale);
      storedCapabilities.push("stale-capability");
    },
    (error: unknown) => error instanceof Error && error.name === "AbortError"
  );
  assert.deepEqual(storedCapabilities, []);
});

test("exact-lease cancellation cannot abort a newer owner", () => {
  const owner = new ClientOperationOwner<Kind>();
  const first = owner.claim("resume") as ClientOperationLease<Kind>;
  const second = owner.supersede("cancel");

  assert.equal(owner.cancel(first), false);
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(owner.current(), second);
  assert.equal(owner.cancel(second), true);
  assert.equal(second.controller.signal.aborted, true);
});

test("synchronous abort listeners cannot claim an ownership handoff gap", () => {
  const owner = new ClientOperationOwner<Kind>();
  const first = owner.claim("resume") as ClientOperationLease<Kind>;
  let reentrantClaim: ClientOperationLease<Kind> | null | undefined;
  first.controller.signal.addEventListener("abort", () => {
    reentrantClaim = owner.claim("submit");
  });

  const second = owner.supersede("cancel");
  assert.equal(reentrantClaim, null);
  assert.equal(owner.current(), second);

  second.controller.signal.addEventListener("abort", () => {
    reentrantClaim = owner.claim("submit");
  });
  assert.equal(owner.cancel(second), true);
  assert.equal(reentrantClaim, null);
  assert.equal(owner.current(), null);
  assert.ok(owner.claim("submit"));
});

test("the hook claims ownership before submission and fences every lifecycle callback", () => {
  const source = readFileSync(path.join(process.cwd(), "app/_hooks/use-scan-runtime.ts"), "utf8");
  const runScan = source.slice(source.indexOf("async function runScan"), source.indexOf("async function resumeActiveScan"));

  assert.ok(runScan.indexOf('claim("submit")') >= 0);
  assert.ok(runScan.indexOf('claim("submit")') < runScan.indexOf("submitRuntimeScan({"));
  assert.match(runScan, /onAdmissionReady:[\s\S]*retainPendingAdmission\(operation,/);
  assert.match(runScan, /onAdmissionCleared:[\s\S]*releasePendingAdmission\(operation\)/);
  assert.match(runScan, /onAccepted:[\s\S]*retainActiveScanSession\(operation,/);
  assert.match(runScan, /onProgress:[\s\S]*operationOwnerRef\.current\.owns\(operation\)/);
  assert.match(runScan, /finally[\s\S]*operationOwnerRef\.current\.owns\(operation\)/);
  assert.match(source, /function handleSubmit[\s\S]*operationOwnerRef\.current\.current\(\) !== null[\s\S]*void runScan/);
});

test("restore, admission recovery, resume, cancel, persistence, and cleanup share the same lease fence", () => {
  const source = readFileSync(path.join(process.cwd(), "app/_hooks/use-scan-runtime.ts"), "utf8");
  const recovery = source.slice(
    source.indexOf("async function recoverPendingAdmission"),
    source.indexOf("async function runScan")
  );
  const resume = source.slice(source.indexOf("async function resumeActiveScan"), source.indexOf("async function cancelActiveScan"));
  const cancel = source.slice(source.indexOf("async function cancelActiveScan"), source.indexOf("function dismissActiveScan"));

  assert.match(source, /function retainActiveScanSession[\s\S]*assertClientOperationOwner\(operationOwnerRef\.current, operation\)/);
  assert.match(source, /function releaseActiveScanSession[\s\S]*assertClientOperationOwner\(operationOwnerRef\.current, operation\)/);
  assert.match(source, /function retainPendingAdmission[\s\S]*assertClientOperationOwner\(operationOwnerRef\.current, operation\)/);
  assert.match(source, /function releasePendingAdmission[\s\S]*assertClientOperationOwner\(operationOwnerRef\.current, operation\)/);
  assert.match(source, /claim\("restore"\)[\s\S]*onProgress:[\s\S]*owns\(operation\)[\s\S]*\.finally[\s\S]*owns\(operation\)/);

  assert.match(recovery, /claim\("admission-recovery"\)/);
  assert.match(recovery, /await recoverRuntimeScanAdmissionThroughCommitWindow[\s\S]*assertClientOperationOwner/);
  assert.match(recovery, /onProgress:[\s\S]*owns\(operation\)/);
  assert.match(recovery, /catch[\s\S]*owns\(operation\)[\s\S]*finally[\s\S]*owns\(operation\)/);

  assert.match(resume, /claim\("resume"\)/);
  assert.match(resume, /await resumeRuntimeScan[\s\S]*assertClientOperationOwner/);
  assert.match(resume, /onProgress:[\s\S]*owns\(operation\)[\s\S]*finally[\s\S]*owns\(operation\)/);

  assert.match(cancel, /supersede\("cancel"\)/);
  assert.match(cancel, /await cancelRuntimeScan[\s\S]*assertClientOperationOwner/);
  assert.match(cancel, /catch[\s\S]*owns\(operation\)[\s\S]*finally[\s\S]*owns\(operation\)/);
  assert.match(source, /function dismissActiveScan[\s\S]*cancelCurrentLifecycleOperation\(\)[\s\S]*forceReleaseActiveScanSession\(\)/);
});
