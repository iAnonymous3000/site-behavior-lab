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

test("creation resolves any optional endpoint second factor before capability, DO, quota, and key work", async () => {
  const source = await workerSource();
  const handler = source.slice(
    source.indexOf("async function handleEncryptedWatchCreationWithinDeadline("),
    source.indexOf("function encryptedWatchAdmissionProofMatches(")
  );
  assert.match(handler, /optionalEncryptedWatchAccessToken/);
  assert.match(handler, /encryptedWatchAccessTokenMatches/);
  assert.ok(handler.indexOf("optionalEncryptedWatchAccessToken") < handler.indexOf("createEncryptedWatchCredentialFromToken"));
  assert.ok(handler.indexOf("encryptedWatchAccessTokenMatches") < handler.indexOf("getContainer(env.SCANNER)"));
  assert.ok(handler.indexOf("encryptedWatchAccessTokenMatches") < handler.indexOf("chargeEncryptedWatchReadRateLimit"));
  assert.ok(handler.indexOf("constantTimeEqual(capabilityToken, watchCreationAccessToken)") < handler.indexOf("getContainer(env.SCANNER)"));
  assert.match(handler, /authorization and management capabilities must be distinct/);
  assert.ok(handler.indexOf("chargeEncryptedWatchReadRateLimit") < handler.indexOf("findEncryptedWatch"));
  assert.ok(handler.indexOf("findEncryptedWatch") < handler.indexOf("gateScanRequest"));
  assert.ok(handler.indexOf("gateScanRequest") < handler.indexOf("importEncryptedWatchKeyring"));
  assert.ok(handler.indexOf("gateScanRequest") < handler.indexOf("admitEncryptedWatchPreparation"));
  assert.match(handler, /prepareUrl\.pathname = `\$\{DURABLE_SCAN_JOB_NODE_PATH_PREFIX\}\/prepare-watch`/);
  assert.match(handler, /headers: \{ "content-type": "application\/json; charset=utf-8" \}/);
  assert.doesNotMatch(
    handler.slice(handler.indexOf("prepareUrl.pathname"), handler.indexOf("const preparation =")),
    /headers: request\.headers/
  );
  assert.match(handler, /createEncryptedWatchCredentialFromToken/);
  assert.match(handler, /admitEncryptedWatchPreparation\([\s\S]*capabilityToken/);
  assert.match(handler, /readRequestBodyWithinLimit\([\s\S]*signal[\s\S]*REQUEST_BODY_OPERATION_TIMEOUT_MS/);
  assert.match(handler, /gateScanRequest\(request, body, env, "defer", undefined, signal\)/);
  assert.match(handler, /awaitDurableScanJobAdmissionStep/);
  assert.match(handler, /readDurableScanJobInternalResponseBytes\(preparedResponse, signal\)/);
  assert.match(handler, /admitEncryptedWatchPreparation\([\s\S]*commitNotAfter/);
  assert.match(handler, /catch \{[\s\S]*scanner\.findEncryptedWatch\(/);
  assert.match(handler, /encryptedWatchAdmissionProofMatches/);
  assert.match(handler, /result\.status === "refused"[\s\S]*scanner\.findEncryptedWatch/);
});

test("scheduled-rescan creation has one caller-composed deadline through its final commit", async () => {
  const source = await workerSource();
  const wrapper = source.slice(
    source.indexOf("async function handleEncryptedWatchCreation(request:"),
    source.indexOf("async function handleEncryptedWatchCreationWithinDeadline(")
  );
  const method = source.slice(
    source.indexOf("async admitEncryptedWatchPreparation("),
    source.indexOf("findEncryptedWatch(", source.indexOf("async admitEncryptedWatchPreparation("))
  );
  assert.match(wrapper, /withDurableScanJobAdmissionDeadline/);
  assert.match(wrapper, /handleEncryptedWatchCreationWithinDeadline\([\s\S]*signal,[\s\S]*commitNotAfter/);
  assert.match(wrapper, /\{ signal: request\.signal \}/);
  assert.match(method, /assertDurableAdmissionCommitActive\(commitNotAfter, now\)/);
  assert.ok(
    method.lastIndexOf("assertDurableAdmissionCommitActive(commitNotAfter, now)") <
      method.indexOf("commitPublicScanRateLimitedOperation"),
    "the authoritative clock fence must run before quota, job, shard, watch, or history mutation"
  );
  assert.match(
    method,
    /commitPublicScanRateLimitedOperation\([\s\S]*admitEncryptedWatch\([\s\S]*\(\) => assertDurableAdmissionCommitActive\(commitNotAfter\)/
  );
});

test("the public scheduled-rescan UI uses Turnstile and never receives the operator second factor", async () => {
  const source = await readFile(
    path.join(process.cwd(), "app/_components/scheduled-rescans.tsx"),
    "utf8"
  );
  const creation = source.slice(
    source.indexOf("const created = await createEncryptedWatch({"),
    source.indexOf("pendingCreationRef.current = null", source.indexOf("const created = await createEncryptedWatch({"))
  );
  assert.match(creation, /accessToken,/);
  assert.match(creation, /turnstileToken: createTurnstileToken/);
  assert.doesNotMatch(creation, /watchAccessToken\s*:/);
  assert.match(source, /health hides this UI when it is set/);
});

test("scheduled-rescan UI fences every network action behind one latest-operation epoch", async () => {
  const source = await readFile(
    path.join(process.cwd(), "app/_components/scheduled-rescans.tsx"),
    "utf8"
  );
  assert.match(source, /import \{ LatestClientOperation \} from "@\/lib\/client-fetch-policy"/);
  assert.match(source, /requestOperationRef = useRef\(new LatestClientOperation\(\)\)/);
  assert.equal((source.match(/requestOperationRef\.current\.run\(/g) ?? []).length, 4);
  assert.match(source, /requestOperationRef\.current\.cancel\(\)/);
  assert.match(source, /createNetworkAttemptedRef/);
  assert.match(source, /settleActiveCreate/);
  assert.doesNotMatch(source, /requestControllerRef/);
  const fragmentRecovery = source.slice(
    source.indexOf("async function recoverFromFragment()"),
    source.indexOf("if (recovered && !(await scheduledRescanCredentialsMatchDerivedId(recovered)))")
  );
  assert.match(fragmentRecovery, /requestOperationRef\.current\.cancel\(\)/);
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
  assert.doesNotMatch(handler, /ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER|optionalEncryptedWatchAccessToken/);
});

test("due watches share the durable pump and resolve only after fresh private preparation and admission", async () => {
  const source = await workerSource();
  const pump = source.slice(source.indexOf("async pumpDurableScanJobs("), source.indexOf("private async activateDurableClaim("));
  assert.match(pump, /runDurableScanJobPumpTurn/);
  assert.ok(
    pump.indexOf("dispatchCore: (context)") < pump.indexOf("listOptionalItems: (context)"),
    "ordinary durable-job dispatch must precede optional scheduled-rescan work"
  );
  assert.match(pump, /persistImmediateSuccessor: \(\) => this\.ensureDurablePumpFallbackSchedule\(\)/);
  assert.equal((source.match(/const DURABLE_SCAN_JOB_PUMP_CALLBACK/g) ?? []).length, 1);

  const due = source.slice(
    source.indexOf("private async admitEncryptedWatchClaim("),
    source.indexOf("private async failEncryptedWatchClaim(")
  );
  assert.ok(due.indexOf("decryptEncryptedWatchClaim") < due.indexOf("privateEncryptedWatchPreparationRequest"));
  assert.ok(due.indexOf("privateEncryptedWatchPreparationRequest") < due.indexOf("admitDurableScanJob"));
  assert.match(due, /context\.signal/);
  assert.match(due, /throwIfDurablePumpAborted/);
  assert.match(due, /const committedAt = Date\.now\(\)/);
  assert.match(due, /resolveEncryptedWatchLease\([\s\S]*now: committedAt/);
});

test("watch capabilities terminate at the edge and watch drift does not disable ordinary scans", async () => {
  const source = await workerSource();
  const forward = source.slice(source.indexOf("function forwardToContainer("), source.indexOf("function frontDoorOrigin("));
  assert.match(forward, /headers\.delete\(ENCRYPTED_WATCH_CAPABILITY_HEADER\)/);
  assert.match(forward, /headers\.delete\(ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER\)/);

  const health = source.slice(source.indexOf("async function patchHealthResponse("), source.indexOf("export async function durableJobsEdgeHealthCheck("));
  assert.match(health, /encryptedWatches\.check\.readiness === "ready"[\s\S]*encryptedWatches\.check\.creationAuthorization === "public"[\s\S]*refusals\.length === 0/);
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
  assert.match(watchHealth, /optionalEncryptedWatchAccessToken/);
  assert.match(watchHealth, /operator authorization is configured but invalid or not isolated\./);
  assert.doesNotMatch(watchHealth, /publicScanGateStatus|encryptedWatchIngressIsTokenGated/);
  const watchConfig = source.slice(
    source.indexOf("function requireEncryptedWatchConfig("),
    source.indexOf("function requireDurableScanJobInternalToken(")
  );
  assert.match(watchConfig, /SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN/);
  assert.match(watchConfig, /const accessToken = optionalEncryptedWatchAccessToken\(env\)/);
  assert.match(watchConfig, /durable\.internalToken,[\s\S]*accessToken \?\? ""/);
  assert.match(
    source,
    /SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES: this\.env\.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES \?\? "0"/
  );
  assert.doesNotMatch(
    source.slice(source.indexOf("envVars ="), source.indexOf("private durableEncryptionKeyPromise")),
    /SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_(?:KEY|PREVIOUS_KEY|ACCESS_TOKEN)/
  );
});

test("watch auth and health coexist with the open public scanner contract", async () => {
  const source = await workerSource();
  const creation = source.slice(
    source.indexOf("async function handleEncryptedWatchCreationWithinDeadline("),
    source.indexOf("function encryptedWatchAdmissionProofMatches(")
  );
  assert.doesNotMatch(creation, /SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS/);
  assert.match(creation, /Unauthorized scheduled-rescan creation\./);
  assert.match(creation, /else if \(presentedWatchAccessToken !== null\)/);
  assert.match(creation, /creation authorization is not configured\./);
  assert.match(creation, /gateScanRequest\(request, body, env, "defer", undefined, signal\)/);
  assert.match(creation, /rateLimit\.cost !== 1/);

  const healthPatch = source.slice(
    source.indexOf("async function patchHealthResponse("),
    source.indexOf("export async function durableJobsEdgeHealthCheck(")
  );
  assert.match(healthPatch, /encryptedWatches\.check\.creationAuthorization === "public"/);
  const watchMisconfiguration = healthPatch.slice(
    healthPatch.indexOf('if (encryptedWatches.check.readiness === "misconfigured")'),
    healthPatch.indexOf("health.limits =")
  );
  assert.doesNotMatch(watchMisconfiguration, /health\.scansAvailable = false/);
});

test("watch staging proves coexistence while the committed production flag stays disabled", async () => {
  const [production, staging] = await Promise.all([
    readFile(path.join(process.cwd(), "wrangler.container.jsonc"), "utf8"),
    readFile(path.join(process.cwd(), "wrangler.container.watch-staging.jsonc"), "utf8")
  ]);
  assert.match(production, /"SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES"\s*:\s*"0"/);
  assert.match(staging, /"SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES"\s*:\s*"1"/);
  assert.match(staging, /"SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS"\s*:\s*"1"/);
  assert.match(staging, /"TURNSTILE_SECRET_KEY"/);
  assert.match(staging, /"SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_ACCESS_TOKEN"/);
  assert.doesNotMatch(staging, /"SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN"/);
  assert.doesNotMatch(staging, /"SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS"/);
});

test("optional watch-history faults cannot roll back ordinary durable terminal mutations", async () => {
  const source = await workerSource();
  const safe = source.slice(
    source.indexOf("private recordEncryptedWatchTerminalOutcomeSafely("),
    source.indexOf("private purgeDurableScanJobState(")
  );
  assert.match(safe, /try \{[\s\S]*recordEncryptedWatchRunTerminalOutcome/);
  assert.match(safe, /catch \{/);

  const cancellation = source.slice(source.indexOf("async cancelDurableJob("), source.indexOf("async heartbeatDurableJob("));
  const resolution = source.slice(source.indexOf("async resolveDurableJob("), source.indexOf("async pumpDurableScanJobs("));
  assert.match(cancellation, /this\.recordEncryptedWatchTerminalOutcomeSafely/);
  assert.match(resolution, /this\.recordEncryptedWatchTerminalOutcomeSafely/);
  assert.doesNotMatch(cancellation, /recordEncryptedWatchRunTerminalOutcome\(this\.ctx/);
  assert.doesNotMatch(resolution, /recordEncryptedWatchRunTerminalOutcome\(this\.ctx/);

  const purge = source.slice(
    source.indexOf("private purgeDurableScanJobState("),
    source.indexOf("private durableEncryptionKey(")
  );
  assert.match(purge, /settleSynchronizeAndPurgeDurableScanJobs\(this\.ctx\.storage\.sql, now\)/);
  assert.doesNotMatch(purge, /Safely|purgeDurableScanJobs/);
});

test("the pump claims only the watches its remaining wall clock can fund", async () => {
  const source = await workerSource();
  const method = source.slice(
    source.indexOf("private async listEncryptedWatchPumpItems("),
    source.indexOf("private async admitEncryptedWatchClaim(")
  );

  // A claim is a committing state change: it charges the daily budget, and an
  // abandoned lease is recovered as a FAILED run, burning one of the watch's
  // five lifetime rescans with the target never attempted. The load phase used
  // to claim full execution capacity even when core dispatch had consumed the
  // turn, so a slow turn taxed watches it never looked at. The claim count
  // must therefore be derived from the turn's remaining time, and a turn that
  // cannot fund one item must not open the claim transaction at all.
  assert.match(
    method,
    /const fundableClaims = Math\.min\(\s*DURABLE_SCAN_JOB_EXECUTION_CAPACITY,\s*DEFAULT_DURABLE_SCAN_JOB_PUMP_BUDGET\.maxOptionalItems,\s*Math\.floor\(context\.remainingTimeMs \/ ENCRYPTED_WATCH_CLAIM_TIME_RESERVE_MS\)\s*\)/,
    "the claim count must be bounded by execution capacity, the controller's optional-item ceiling, and remaining turn time"
  );
  assert.match(method, /if \(fundableClaims <= 0\) \{/, "an unfundable turn must claim nothing");
  assert.match(
    method,
    /createEncryptedWatchLeaseCredentials\(fundableClaims\)/,
    "credentials must match the funded claim count, not full capacity"
  );
  assert.match(
    method,
    /capacity: fundableClaims/,
    "the store must never be asked for more claims than the turn can fund"
  );
  const zeroReturn = method.indexOf("if (fundableClaims <= 0)");
  const credentialCall = method.indexOf("createEncryptedWatchLeaseCredentials");
  const claimTransaction = method.indexOf("claimDueEncryptedWatches");
  assert.ok(
    zeroReturn !== -1 && zeroReturn < credentialCall && credentialCall < claimTransaction,
    "the zero-fundable exit must run before credentials are minted or the claim transaction opens"
  );

  // The reserve is a claim-admission gate, not a per-item allocation, and it
  // must stay conservative: under-claiming defers a watch to the next turn,
  // over-claiming burns a lifetime run. Pin the floor so a future tuning pass
  // cannot quietly turn the guard into a no-op.
  const reserve = source.match(/const ENCRYPTED_WATCH_CLAIM_TIME_RESERVE_MS = ([\d_]+);/);
  assert.ok(reserve, "the reserve constant must exist");
  assert.ok(
    Number(reserve[1].replaceAll("_", "")) >= 5_000,
    "a reserve below 5s cannot fund a cold-container prepare round trip"
  );
});
