import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function workerSource(): Promise<string> {
  return readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
}

test("watch creation commits quota, first job, shard, watch, and history under one DO transaction", async () => {
  const source = await workerSource();
  const method = source.slice(
    source.indexOf("async admitEncryptedWatchPreparation("),
    source.indexOf("findEncryptedWatch(", source.indexOf("async admitEncryptedWatchPreparation("))
  );
  assert.match(method, /createEncryptedWatchCredentialFromToken\(capabilityToken\)/);
  assert.match(method, /createEncryptedWatchAdmission/);
  assert.match(method, /createDurableScanJobAdmission/);
  assert.match(
    method,
    /transactionSync\([\s\S]*commitPublicScanRateLimitedOperation\([\s\S]*admitDurableScanJob\([\s\S]*recordDurableContainerShardRoute\([\s\S]*admitEncryptedWatch\(/
  );
  assert.ok(method.indexOf("await this.ensureImmediateDurablePumpWake()") < method.lastIndexOf("transactionSync"));
});

test("creation prelooks a browser-held capability, gates expensive key work, and recovers duplicate commits", async () => {
  const source = await workerSource();
  const handler = source.slice(
    source.indexOf("async function handleEncryptedWatchCreation("),
    source.indexOf("function encryptedWatchAdmissionProofMatches(")
  );
  assert.match(handler, /encryptedWatchIngressIsTokenGated/);
  assert.ok(handler.indexOf("encryptedWatchIngressIsTokenGated") < handler.indexOf("findEncryptedWatch"));
  assert.ok(handler.indexOf("chargeEncryptedWatchReadRateLimit") < handler.indexOf("findEncryptedWatch"));
  assert.ok(handler.indexOf("findEncryptedWatch") < handler.indexOf("gateScanRequest"));
  assert.ok(handler.indexOf("gateScanRequest") < handler.indexOf("importEncryptedWatchKeyring"));
  assert.match(handler, /prepareUrl\.pathname = `\$\{DURABLE_SCAN_JOB_NODE_PATH_PREFIX\}\/prepare-watch`/);
  assert.match(handler, /headers: \{ "content-type": "application\/json; charset=utf-8" \}/);
  assert.doesNotMatch(
    handler.slice(handler.indexOf("prepareUrl.pathname"), handler.indexOf("const preparation =")),
    /headers: request\.headers/
  );
  assert.match(handler, /createEncryptedWatchCredentialFromToken/);
  assert.match(handler, /admitEncryptedWatchPreparation\([\s\S]*capabilityToken/);
  assert.match(handler, /catch \{[\s\S]*scanner\.findEncryptedWatch\(/);
  assert.match(handler, /encryptedWatchAdmissionProofMatches/);
  assert.match(handler, /result\.status === "refused"[\s\S]*scanner\.findEncryptedWatch/);
});

test("watch reads and idempotent deletes rate-limit before capability work and never decrypt", async () => {
  const source = await workerSource();
  const handler = source.slice(
    source.indexOf("async function handleEncryptedWatchItem("),
    source.indexOf("function publicEncryptedWatchSnapshot(")
  );
  assert.ok(
    handler.indexOf("chargeEncryptedWatchReadRateLimit") <
      handler.indexOf("hashEncryptedWatchCapabilityToken")
  );
  assert.ok(handler.indexOf("hashEncryptedWatchCapabilityToken") < handler.indexOf("findEncryptedWatch"));
  assert.match(handler, /encryptedWatchNotFoundResponse/);
  assert.match(handler, /await getContainer\(env\.SCANNER\)\.deleteEncryptedWatch\(watchId, capabilityHash\)/);
  assert.doesNotMatch(handler, /if \(!deleted\)/);
  assert.doesNotMatch(handler, /decryptEncryptedWatchClaim/);
});

test("due watches share the durable pump and resolve only after fresh private preparation and admission", async () => {
  const source = await workerSource();
  const pump = source.slice(source.indexOf("async pumpDurableScanJobs("), source.indexOf("private async activateDurableClaim("));
  assert.ok(pump.indexOf("await this.admitDueEncryptedWatchRuns()") < pump.indexOf("claimDurableScanJobs"));
  assert.equal((source.match(/const DURABLE_SCAN_JOB_PUMP_CALLBACK/g) ?? []).length, 1);

  const due = source.slice(
    source.indexOf("private async admitEncryptedWatchClaim("),
    source.indexOf("private async failEncryptedWatchClaim(")
  );
  assert.ok(due.indexOf("decryptEncryptedWatchClaim") < due.indexOf("privateEncryptedWatchPreparationRequest"));
  assert.ok(due.indexOf("privateEncryptedWatchPreparationRequest") < due.indexOf("admitDurableScanJob"));
  assert.match(due, /const committedAt = Date\.now\(\)/);
  assert.match(due, /resolveEncryptedWatchLease\([\s\S]*now: committedAt/);
});

test("watch capabilities terminate at the edge and watch drift does not disable ordinary scans", async () => {
  const source = await workerSource();
  const forward = source.slice(source.indexOf("function forwardToContainer("), source.indexOf("function frontDoorOrigin("));
  assert.match(forward, /headers\.delete\(ENCRYPTED_WATCH_CAPABILITY_HEADER\)/);

  const health = source.slice(source.indexOf("async function patchHealthResponse("), source.indexOf("export async function durableJobsEdgeHealthCheck("));
  assert.match(health, /scheduledRescans: encryptedWatches\.check\.readiness === "ready"/);
  assert.match(
    health,
    /encryptedWatches\.check\.readiness === "ready"[\s\S]*ensureEncryptedWatchPumpWake\(\)/
  );
  const activation = source.slice(
    source.indexOf("async ensureEncryptedWatchPumpWake("),
    source.indexOf("/** Encrypt, schedule", source.indexOf("async ensureEncryptedWatchPumpWake("))
  );
  assert.match(activation, /nextEncryptedWatchWakeAt/);
  assert.match(activation, /watchWakeAt <= now[\s\S]*ensureImmediateDurablePumpWake/);
  assert.match(activation, /else \{[\s\S]*scheduleNextDurablePump/);
  const watchMisconfiguration = health.slice(
    health.indexOf('if (encryptedWatches.check.readiness === "misconfigured")'),
    health.indexOf("health.limits =")
  );
  assert.doesNotMatch(watchMisconfiguration, /health\.scansAvailable = false/);
  const watchHealth = source.slice(
    source.indexOf("export async function encryptedWatchesEdgeHealthCheck("),
    source.indexOf("function encryptedWatchNodeHealth(")
  );
  assert.match(watchHealth, /encryptedWatchIngressIsTokenGated/);
  assert.match(watchHealth, /Encrypted watches require access-token-gated scanner ingress\./);
  assert.match(
    source,
    /SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES: this\.env\.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES \?\? "0"/
  );
  assert.doesNotMatch(
    source.slice(source.indexOf("envVars ="), source.indexOf("private durableEncryptionKeyPromise")),
    /SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_(?:KEY|PREVIOUS_KEY)/
  );
});

test("optional watch-history faults cannot roll back ordinary durable terminal mutations", async () => {
  const source = await workerSource();
  const safe = source.slice(
    source.indexOf("private recordEncryptedWatchTerminalOutcomeSafely("),
    source.indexOf("private purgeDurableScanJobState(")
  );
  assert.match(safe, /try \{[\s\S]*recordEncryptedWatchRunTerminalOutcome/);
  assert.match(safe, /catch \{/);
  assert.match(safe, /INNER JOIN encrypted_watch_runs runs ON runs\.job_id = jobs\.job_id/);

  const cancellation = source.slice(source.indexOf("async cancelDurableJob("), source.indexOf("async heartbeatDurableJob("));
  const resolution = source.slice(source.indexOf("async resolveDurableJob("), source.indexOf("async pumpDurableScanJobs("));
  assert.match(cancellation, /this\.recordEncryptedWatchTerminalOutcomeSafely/);
  assert.match(resolution, /this\.recordEncryptedWatchTerminalOutcomeSafely/);
  assert.doesNotMatch(cancellation, /recordEncryptedWatchRunTerminalOutcome\(this\.ctx/);
  assert.doesNotMatch(resolution, /recordEncryptedWatchRunTerminalOutcome\(this\.ctx/);
});
