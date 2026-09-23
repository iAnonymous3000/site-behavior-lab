import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Log, LogLevel, Miniflare, Response as MiniflareResponse, type Request as MiniflareRequest } from "miniflare";
import { assertOrdered, requireIndex, requireLastIndex, sliceBetween, sliceToNext } from "./source-markers";

const WORKER = "cloudflare/container-worker.ts";
const RESCANS_UI = "app/_components/scheduled-rescans.tsx";

async function workerSource(): Promise<string> {
  return readFile(path.join(process.cwd(), "cloudflare/container-worker.ts"), "utf8");
}

test("watch creation commits quota, first job, shard, watch, and history under one DO transaction", async () => {
  const source = await workerSource();
  const method = sliceToNext(source, "async admitEncryptedWatchPreparation(", "findEncryptedWatch(", WORKER);
  assert.match(method, /createEncryptedWatchCredentialFromToken\(capabilityToken\)/);
  assert.match(method, /createEncryptedWatchAdmission/);
  assert.match(method, /createDurableScanJobAdmission/);
  assert.match(
    method,
    /transactionSync\([\s\S]*commitPublicScanRateLimitedOperation\([\s\S]*admitDurableScanJob\([\s\S]*recordDurableContainerShardRoute\([\s\S]*admitEncryptedWatch\(/
  );
  assert.ok(
    requireIndex(method, "await this.ensureImmediateDurablePumpWake()", "admitEncryptedWatchPreparation") <
      requireLastIndex(method, "transactionSync", "admitEncryptedWatchPreparation")
  );
});

test("creation resolves any optional endpoint second factor before capability, DO, quota, and key work", async () => {
  const source = await workerSource();
  const creation = "handleEncryptedWatchCreationWithinDeadline";
  const handler = sliceBetween(
    source,
    "async function handleEncryptedWatchCreationWithinDeadline(",
    "function encryptedWatchAdmissionProofMatches(",
    WORKER
  );
  assert.match(handler, /optionalEncryptedWatchAccessToken/);
  assert.match(handler, /encryptedWatchAccessTokenMatches/);
  assertOrdered(handler, ["optionalEncryptedWatchAccessToken", "createEncryptedWatchCredentialFromToken"], creation);
  assertOrdered(handler, ["encryptedWatchAccessTokenMatches", "getContainer(env.SCANNER)"], creation);
  assertOrdered(handler, ["encryptedWatchAccessTokenMatches", "chargeEncryptedWatchReadRateLimit"], creation);
  assertOrdered(handler, ["constantTimeEqual(capabilityToken, watchCreationAccessToken)", "getContainer(env.SCANNER)"], creation);
  assert.match(handler, /authorization and management capabilities must be distinct/);
  assertOrdered(
    handler,
    ["chargeEncryptedWatchReadRateLimit", "findEncryptedWatch", "gateScanRequest", "importEncryptedWatchKeyring"],
    creation
  );
  assertOrdered(handler, ["gateScanRequest", "admitEncryptedWatchPreparation"], creation);
  assert.match(handler, /prepareUrl\.pathname = `\$\{DURABLE_SCAN_JOB_NODE_PATH_PREFIX\}\/prepare-watch`/);
  assert.match(handler, /headers: \{ "content-type": "application\/json; charset=utf-8" \}/);
  assert.doesNotMatch(
    sliceBetween(handler, "prepareUrl.pathname", "const preparation =", creation),
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

test("creation with the feature off recovers only, and never redeems Turnstile, preflights quota, or reads the body", { timeout: 45_000 }, async () => {
  // Production and staging both commit SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES="0".
  // A direct API caller used to reach Siteverify (spending its one-shot token)
  // and the quota preflight before the flag was read, then got a 503 claiming a
  // temporary outage.
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-watch-flag-runtime-"));
  const outbound: string[] = [];
  let mf: Miniflare | undefined;
  try {
    execFileSync(process.execPath, [
      "node_modules/wrangler/bin/wrangler.js", "deploy", "test-fixtures/encrypted-watch-flag-runtime.test.ts",
      "--dry-run", "--outdir", dir, "--name", "encrypted-watch-flag-runtime", "--compatibility-date", "2026-06-19",
      "--compatibility-flags", "nodejs_compat"
    ], { cwd: process.cwd(), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
    mf = new Miniflare({
      modules: true, scriptPath: path.join(dir, "encrypted-watch-flag-runtime.test.js"), modulesRoot: dir,
      compatibilityDate: "2026-06-19", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SCANNER: { className: "EncryptedWatchFlagHarness", useSQLite: true } },
      durableObjectsPersist: false, log: new Log(LogLevel.ERROR),
      // Siteverify and every other egress lands here, never on the network.
      outboundService: (request: MiniflareRequest) => {
        outbound.push(new URL(request.url).host);
        return new MiniflareResponse(JSON.stringify({ success: true }), {
          headers: { "content-type": "application/json" }
        });
      }
    });
    const capability = Buffer.alloc(32, 7).toString("base64url");
    for (const flag of ["0", "misconfigured"]) {
      const response = await mf.dispatchFetch("https://scan.sitebehavior.org/api/watches", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://sitebehavior.org",
          "cf-connecting-ip": "203.0.113.9",
          "x-site-behavior-lab-watch-capability": capability,
          "x-harness-encrypted-watches": flag
        },
        body: JSON.stringify({
          url: "https://example.com/",
          device: "desktop",
          gpcEnabled: false,
          turnstileToken: "one-shot-token"
        })
      });
      assert.equal(response.status, 404, `flag ${flag}`);
      assert.deepEqual(await response.json(), { ok: false, error: "Scheduled rescan not found." });
      // The rollback lookup still runs, which is what proves this is not an
      // early refusal of a malformed capability; nothing after it does.
      const calls = await (await mf.dispatchFetch("https://scan.sitebehavior.org/__harness/calls")).json();
      assert.deepEqual(calls, ["chargeEncryptedWatchReadRateLimit", "findEncryptedWatch"], `flag ${flag}`);
    }
    assert.deepEqual(outbound, []);
  } finally {
    await mf?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scheduled-rescan creation has one caller-composed deadline through its final commit", async () => {
  const source = await workerSource();
  const wrapper = sliceBetween(
    source,
    "async function handleEncryptedWatchCreation(request:",
    "async function handleEncryptedWatchCreationWithinDeadline(",
    WORKER
  );
  const method = sliceToNext(source, "async admitEncryptedWatchPreparation(", "findEncryptedWatch(", WORKER);
  assert.match(wrapper, /withDurableScanJobAdmissionDeadline/);
  assert.match(wrapper, /handleEncryptedWatchCreationWithinDeadline\([\s\S]*signal,[\s\S]*commitNotAfter/);
  assert.match(wrapper, /\{ signal: request\.signal \}/);
  assert.match(method, /assertDurableAdmissionCommitActive\(commitNotAfter, now\)/);
  assert.ok(
    requireLastIndex(method, "assertDurableAdmissionCommitActive(commitNotAfter, now)", "admitEncryptedWatchPreparation") <
      requireIndex(method, "commitPublicScanRateLimitedOperation", "admitEncryptedWatchPreparation"),
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
  const creation = sliceToNext(
    source,
    "const created = await createEncryptedWatch({",
    "pendingCreationRef.current = null",
    RESCANS_UI
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
  const fragmentRecovery = sliceBetween(
    source,
    "async function recoverFromFragment()",
    "if (recovered && !(await scheduledRescanCredentialsMatchDerivedId(recovered)))",
    RESCANS_UI
  );
  assert.match(fragmentRecovery, /requestOperationRef\.current\.cancel\(\)/);
});

test("watch reads and idempotent deletes rate-limit before capability work and never decrypt", async () => {
  const source = await workerSource();
  const handler = sliceBetween(
    source,
    "async function handleEncryptedWatchItem(",
    "function publicEncryptedWatchSnapshot(",
    WORKER
  );
  assertOrdered(
    handler,
    ["chargeEncryptedWatchReadRateLimit", "hashEncryptedWatchCapabilityToken", "findEncryptedWatch"],
    "handleEncryptedWatchItem"
  );
  assert.match(handler, /encryptedWatchNotFoundResponse/);
  assert.match(handler, /await getContainer\(env\.SCANNER\)\.deleteEncryptedWatch\(watchId, capabilityHash\)/);
  assert.doesNotMatch(handler, /if \(!deleted\)/);
  assert.doesNotMatch(handler, /decryptEncryptedWatchClaim/);
  assert.doesNotMatch(handler, /ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER|optionalEncryptedWatchAccessToken/);
});

test("due watches share the durable pump and resolve only after fresh private preparation and admission", async () => {
  const source = await workerSource();
  const pump = sliceBetween(source, "async pumpDurableScanJobs(", "private async activateDurableClaim(", WORKER);
  assert.match(pump, /runDurableScanJobPumpTurn/);
  assertOrdered(
    pump,
    ["dispatchCore: (context)", "listOptionalItems: (context)"],
    "pumpDurableScanJobs",
    "ordinary durable-job dispatch must precede optional scheduled-rescan work"
  );
  assert.match(pump, /persistImmediateSuccessor: \(\) => this\.ensureDurablePumpFallbackSchedule\(\)/);
  assert.equal((source.match(/const DURABLE_SCAN_JOB_PUMP_CALLBACK/g) ?? []).length, 1);

  const due = sliceBetween(
    source,
    "private async admitEncryptedWatchClaim(",
    "private async failEncryptedWatchClaim(",
    WORKER
  );
  assertOrdered(
    due,
    ["decryptEncryptedWatchClaim", "privateEncryptedWatchPreparationRequest", "admitDurableScanJob"],
    "admitEncryptedWatchClaim"
  );
  assert.match(due, /context\.signal/);
  assert.match(due, /throwIfDurablePumpAborted/);
  assert.match(due, /const committedAt = Date\.now\(\)/);
  assert.match(due, /resolveEncryptedWatchLease\([\s\S]*now: committedAt/);
});

test("watch capabilities terminate at the edge and watch drift does not disable ordinary scans", async () => {
  const source = await workerSource();
  const forward = sliceBetween(source, "function forwardToContainer(", "function frontDoorOrigin(", WORKER);
  assert.match(forward, /headers\.delete\(ENCRYPTED_WATCH_CAPABILITY_HEADER\)/);
  assert.match(forward, /headers\.delete\(ENCRYPTED_WATCH_ACCESS_TOKEN_HEADER\)/);

  const health = sliceBetween(
    source,
    "async function patchHealthResponse(",
    "export async function durableJobsEdgeHealthCheck(",
    WORKER
  );
  assert.match(health, /encryptedWatches\.check\.readiness === "ready"[\s\S]*encryptedWatches\.check\.creationAuthorization === "public"[\s\S]*refusals\.length === 0/);
  assert.match(
    health,
    /encryptedWatches\.check\.readiness === "ready"[\s\S]*ensureEncryptedWatchPumpWake\(\)/
  );
  const activation = sliceToNext(source, "async ensureEncryptedWatchPumpWake(", "/** Encrypt, schedule", WORKER);
  assert.match(activation, /nextEncryptedWatchWakeAt/);
  assert.match(activation, /watchWakeAt <= now[\s\S]*ensureImmediateDurablePumpWake/);
  assert.match(activation, /else \{[\s\S]*scheduleNextDurablePump/);
  const watchMisconfiguration = sliceBetween(
    health,
    'if (encryptedWatches.check.readiness === "misconfigured")',
    "health.limits =",
    "patchHealthResponse"
  );
  assert.doesNotMatch(watchMisconfiguration, /health\.scansAvailable = false/);
  const watchHealth = sliceBetween(
    source,
    "export async function encryptedWatchesEdgeHealthCheck(",
    "function encryptedWatchNodeHealth(",
    WORKER
  );
  assert.match(watchHealth, /optionalEncryptedWatchAccessToken/);
  assert.match(watchHealth, /operator authorization is configured but invalid or not isolated\./);
  assert.doesNotMatch(watchHealth, /publicScanGateStatus|encryptedWatchIngressIsTokenGated/);
  const watchConfig = sliceBetween(
    source,
    "function requireEncryptedWatchConfig(",
    "function requireDurableScanJobInternalToken(",
    WORKER
  );
  assert.match(watchConfig, /SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN/);
  assert.match(watchConfig, /const accessToken = optionalEncryptedWatchAccessToken\(env\)/);
  assert.match(watchConfig, /durable\.internalToken,[\s\S]*accessToken \?\? ""/);
  assert.match(
    source,
    /SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES: this\.env\.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES \?\? "0"/
  );
  assert.doesNotMatch(
    sliceBetween(source, "envVars =", "private durableEncryptionKeyPromise", WORKER),
    /SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_(?:KEY|PREVIOUS_KEY|ACCESS_TOKEN)/
  );
});

test("watch auth and health coexist with the open public scanner contract", async () => {
  const source = await workerSource();
  const creation = sliceBetween(
    source,
    "async function handleEncryptedWatchCreationWithinDeadline(",
    "function encryptedWatchAdmissionProofMatches(",
    WORKER
  );
  assert.doesNotMatch(creation, /SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS/);
  assert.match(creation, /Unauthorized scheduled-rescan creation\./);
  assert.match(creation, /else if \(presentedWatchAccessToken !== null\)/);
  assert.match(creation, /creation authorization is not configured\./);
  assert.match(creation, /gateScanRequest\(request, body, env, "defer", undefined, signal\)/);
  assert.match(creation, /rateLimit\.cost !== 1/);

  const healthPatch = sliceBetween(
    source,
    "async function patchHealthResponse(",
    "export async function durableJobsEdgeHealthCheck(",
    WORKER
  );
  assert.match(healthPatch, /encryptedWatches\.check\.creationAuthorization === "public"/);
  const watchMisconfiguration = sliceBetween(
    healthPatch,
    'if (encryptedWatches.check.readiness === "misconfigured")',
    "health.limits =",
    "patchHealthResponse"
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
  const safe = sliceBetween(
    source,
    "private recordEncryptedWatchTerminalOutcomeSafely(",
    "private purgeDurableScanJobState(",
    WORKER
  );
  assert.match(safe, /try \{[\s\S]*recordEncryptedWatchRunTerminalOutcome/);
  assert.match(safe, /catch \{/);

  const cancellation = sliceBetween(source, "async cancelDurableJob(", "async heartbeatDurableJob(", WORKER);
  const resolution = sliceBetween(source, "async resolveDurableJob(", "async pumpDurableScanJobs(", WORKER);
  assert.match(cancellation, /this\.recordEncryptedWatchTerminalOutcomeSafely/);
  assert.match(resolution, /this\.recordEncryptedWatchTerminalOutcomeSafely/);
  assert.doesNotMatch(cancellation, /recordEncryptedWatchRunTerminalOutcome\(this\.ctx/);
  assert.doesNotMatch(resolution, /recordEncryptedWatchRunTerminalOutcome\(this\.ctx/);

  const purge = sliceBetween(source, "private purgeDurableScanJobState(", "private durableEncryptionKey(", WORKER);
  assert.match(purge, /settleSynchronizeAndPurgeDurableScanJobs\(this\.ctx\.storage\.sql, now\)/);
  assert.doesNotMatch(purge, /Safely|purgeDurableScanJobs/);
});

test("the pump claims only the watches its remaining wall clock can fund", async () => {
  const source = await workerSource();
  const method = sliceBetween(
    source,
    "private async listEncryptedWatchPumpItems(",
    "private async admitEncryptedWatchClaim(",
    WORKER
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
  assertOrdered(
    method,
    ["if (fundableClaims <= 0)", "createEncryptedWatchLeaseCredentials", "claimDueEncryptedWatches"],
    "listEncryptedWatchPumpItems",
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
