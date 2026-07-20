// Front Worker for the Cloudflare Containers deployment of the full Node/Playwright
// scanner, the path that runs *live* Brave Shields (tried-vs-blocked). It runs the
// repo Dockerfile as a Cloudflare Container and forwards requests to it.
//
// This Worker is the edge enforcement point: before a scan reaches the container's
// real Chromium it applies access-token and Turnstile gating plus an atomic
// SQLite quota in the scanner Durable Object. Everything else (health, report
// reads, CORS preflight) forwards straight through.
//
// Deployed separately (wrangler.container.jsonc) from the retired Browser Run
// worker retained in cloudflare/worker.ts for gated self-hosting.
// Full runbook: docs/go-live-public-scanner.md
import { Container, getContainer } from "@cloudflare/containers";
import { scanCorsHeaders } from "../lib/cors";
import { scansAvailableAfterEdgeOverlay } from "../lib/container-health-overlay";
import { PublicFacingError } from "../lib/public-errors";
import {
  ENCRYPTED_WATCH_CAPABILITY_HEADER,
  ENCRYPTED_WATCH_ENCRYPTION_KEY_ENV,
  ENCRYPTED_WATCH_PREVIOUS_ENCRYPTION_KEY_ENV,
  ENCRYPTED_WATCHES_ENV,
  encryptedWatchKeyIsIsolated,
  encryptedWatchesFlagState,
  type EncryptedWatchPayload
} from "../lib/encrypted-watch-contract";
import {
  encryptedWatchIngressIsTokenGated,
  encryptedWatchPayloadFromPreparation,
  isEncryptedWatchCreationBody,
  parseEncryptedWatchPublicPath
} from "../lib/encrypted-watch-edge-wiring";
import {
  EncryptedWatchCapacityError,
  EncryptedWatchStateError,
  admitEncryptedWatch,
  claimDueEncryptedWatches,
  createEncryptedWatchAdmission,
  createEncryptedWatchCredentialFromToken,
  createEncryptedWatchLeaseCredentials,
  decryptEncryptedWatchClaim,
  deleteEncryptedWatch,
  ensureEncryptedWatchStore,
  findEncryptedWatchByCapability,
  hashEncryptedWatchCapabilityToken,
  hashEncryptedWatchLeaseToken,
  importEncryptedWatchKeyring,
  nextEncryptedWatchWakeAt,
  purgeExpiredEncryptedWatches,
  recordEncryptedWatchRunTerminalOutcome,
  recoverExpiredEncryptedWatchLeases,
  resolveEncryptedWatchLease,
  type EncryptedWatchClaim,
  type EncryptedWatchKeyring,
  type EncryptedWatchSnapshot
} from "../lib/encrypted-watch-store";
import {
  DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX,
  DURABLE_SCAN_JOB_COORDINATOR_URL_ENV,
  DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV,
  DURABLE_SCAN_JOB_INTERNAL_HEADER,
  DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV,
  DURABLE_SCAN_JOB_NODE_PATH_PREFIX,
  DURABLE_SCAN_JOB_PREPARED_HEADER,
  DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
  DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS,
  DURABLE_SCAN_JOBS_ENV,
  isDurableScanJobExecutionOwner,
  isDurableScanJobNodePrivatePath,
  parseDurableScanJobCoordinatorPath,
  readDurableScanJobPreparation,
  stripDurableScanJobInternalHeaders,
  type DurableScanJobExecutionOwner,
  type DurableScanJobPreparation
} from "../lib/durable-scan-job-contract";
import {
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY,
  DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE,
  EdgeScanGateError,
  assertTurnstileToken,
  constantTimeEqual,
  formatPublicScanRetryAfter,
  openScanBlockedForMissingTurnstile,
  publicClientHash,
  publicScanGateStatus,
  publicScanRateLimit,
  publicScanRefusalReasons,
  readRequestBodyWithinLimit,
  scanAccessTokenMatches,
  scanTokenCost,
  withPublicScanAccessCheck
} from "../lib/edge-scan-gate";
import {
  findDurableScanJob,
  recordAcceptedScanJob,
  registerDurableScanJob,
  scanJobIdFromPath,
  type DurableScanJobRegistration
} from "../lib/durable-scan-job-registry";
import {
  durableScanJobCancellationResponse,
  recoverDurableScanJobCancellationResponse,
  recoverDurableScanJobResponse,
  recoverDurableScanJobSnapshotResponse
} from "../lib/durable-scan-job-recovery";
import {
  DurableScanJobCapacityError,
  DurableScanJobStateError,
  admitDurableScanJob,
  beginPublishingDurableScanJob,
  cancelDurableScanJob,
  claimDurableScanJobs,
  createDurableScanJobAdmission,
  createDurableScanJobLeaseCredentials,
  decryptDurableScanJobClaim,
  earliestDurableScanJobPurgeAt,
  ensureDurableScanJobStore,
  expireDurableScanJob,
  findDurableScanJobSnapshot,
  hashDurableScanJobLeaseToken,
  heartbeatDurableScanJob,
  importDurableScanJobEncryptionKey,
  listExpiredDurableScanJobLeases,
  listPastDeadlineDurableScanJobs,
  preflightDurableScanJobAdmission,
  purgeDurableScanJobs,
  reconcileExpiredPublishingDurableScanJob,
  requeueOrFailExpiredDurableScanJobLease,
  resolveDurableScanJob,
  type DurableScanJobClaim,
  type DurableScanJobEncryptionKey,
  type DurableScanJobSnapshot
} from "../lib/durable-scan-job-store";
import {
  AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE,
  assertPublicScanRateLimitCharge,
  chargePublicScanRateLimit as chargePublicScanRateLimitInStore,
  commitPublicScanRateLimitedOperation,
  peekPublicScanRateLimit as peekPublicScanRateLimitInStore,
  publicScanRateLimitChargeMatchesCost,
  type PublicScanRateLimitCharge,
  type PublicScanRateLimitResult
} from "../lib/public-scan-rate-limit-store";
import {
  chooseDurableScanJobPumpWakeAt,
  durablePumpReuseNeedsAlarmKick,
  durableReconciliationTimeoutMs,
  durableScanJobAdmissionProofMatches,
  durableScanJobKeyIsIsolated,
  durableScanJobNodeHealthState,
  durableScanJobSecretsAreDistinct,
  durableScanJobsFlagState,
  finalizeDurableScanJobAdmission
} from "../lib/durable-scan-job-edge-wiring";
import {
  DURABLE_CONTAINER_SHARD_COUNT_ENV,
  DURABLE_CONTAINER_SHARDING_ENV,
  durableContainerShardingPlan,
  findDurableContainerShardRoute,
  pruneDurableContainerShardRoutes,
  recordDurableContainerShardRoute,
  selectDurableContainerShard,
  type DurableContainerShardingPlan
} from "../lib/durable-container-sharding";
import {
  DURABLE_REPLAY_FAULT_MODE_HEADER,
  DURABLE_REPLAY_FAULT_MODES,
  DURABLE_REPLAY_FAULT_TOKEN_HEADER,
  DURABLE_REPLAY_MINIMUM_NO_POLL_MS,
  armDurableReplayFault,
  dropLostResolveDurableReplayFault,
  durableReplayFaultConfig,
  durableReplayFaultIngressIntent,
  findDurableReplayFault as readDurableReplayFault,
  purgeDurableReplayFaults,
  triggerLeaseExpiryDurableReplayFault,
  type DurableReplayFault,
  type DurableReplayLostResolveDrop,
  type DurableReplayFaultMode
} from "../lib/durable-replay-fault";

type Env = {
  SCANNER: DurableObjectNamespace<ScannerContainer>;
  // Non-secret browser CORS allow-list, set via `vars` in wrangler.container.jsonc.
  SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN?: string;
  // "1" opens the scanner to unauthenticated public scans (Turnstile + rate limit
  // then apply). Unset/anything else keeps it operator-gated behind the token.
  SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY?: string;
  // Forwarded to the Node scanner. Only "1" enables Playwright's Chromium
  // sandbox; /api/health exposes the effective state for deployment checks.
  SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX?: string;
  SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION?: string;
  SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS?: string;
  SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN?: string;
  SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL?: string;
  SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES?: string;
  SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY?: string;
  SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY?: string;
  SITE_BEHAVIOR_LAB_CONTAINER_SHARDING?: string;
  SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT?: string;
  SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT?: string;
  SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS?: string;
  SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN?: string;
  SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS?: string;
  // "1" waives the Turnstile requirement for open access (atomic rate limit only).
  // Without it, open access with no TURNSTILE_SECRET_KEY fails closed.
  SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK?: string;
  // Set as Worker secrets (`wrangler secret put -c wrangler.container.jsonc <NAME>`)
  // and forwarded into the container via envVars below.
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
  SITE_BEHAVIOR_LAB_R2_BUCKET?: string;
  SITE_BEHAVIOR_LAB_R2_PREFIX?: string;
  SITE_BEHAVIOR_LAB_R2_ENDPOINT?: string;
  SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID?: string;
  SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY?: string;
};

// Mirrors the scan fields the edge gate needs from the request body.
type ScanGatePayload = {
  compareGpc?: unknown;
  compareShields?: unknown;
  compareConsent?: unknown;
  turnstileToken?: unknown;
};

const MAX_BODY_BYTES = 4_096;
const MAX_COORDINATOR_BODY_BYTES = 32_768;
const DURABLE_SCAN_JOB_PUMP_CALLBACK = "pumpDurableScanJobs";
const DURABLE_SCAN_JOB_EXECUTION_CAPACITY = 2;

type DurablePumpSchedulePayload = { epoch: string };
type DurablePumpScheduleContext = { taskId: string };

type DurableScanJobMutationResult =
  | { status: "success" }
  | { status: "conflict" };

type DurableScanJobCancellationResult =
  | {
      status: "success";
      snapshot: DurableScanJobSnapshot;
      abortGeneration: number | null;
    }
  | { status: "conflict" };

type DurableScanJobAdmissionResult =
  | { status: "success"; snapshot: DurableScanJobSnapshot }
  | { status: "rate-limited"; retryAfterSeconds: number }
  | { status: "refused" };

type EncryptedWatchAdmissionResult =
  | {
      status: "success";
      snapshot: EncryptedWatchSnapshot;
      capability: string;
    }
  | { status: "rate-limited"; retryAfterSeconds: number }
  | { status: "refused" };

class DurableScanJobRateLimitError extends EdgeScanGateError {
  constructor(scope: PublicScanRateLimitCharge["scope"], retryAfterSeconds: number) {
    super(
      scope === "public"
        ? `Too many public scans. Try again in about ${formatPublicScanRetryAfter(retryAfterSeconds)}.`
        : "Too many scan requests. Try again shortly.",
      429
    );
    this.name = "DurableScanJobRateLimitError";
  }
}

class DurableScanJobRefusedError extends Error {
  constructor() {
    super("The authoritative durable scan-job admission was refused.");
    this.name = "DurableScanJobRefusedError";
  }
}

export class ScannerContainer extends Container<Env> {
  // The Dockerfile serves Next.js on :3000.
  defaultPort = 3000;
  // Keep the instance (and its warm Chromium) alive between scans; it scales to
  // zero after this idle window. Raise for fewer cold starts, lower to save cost.
  sleepAfter = "15m";

  // Set only while a pump callback is replacing its invoking one-shot row.
  // Precise recomputation excludes this immediate crash-recovery successor so
  // it can move the next wake to the real lease/deadline/purge boundary.
  private durablePumpPrearmTaskId: string | null = null;

  // Non-secret config plus secrets sourced from Worker secrets, passed to the
  // container process. Reports go to R2 because container disk is ephemeral.
  envVars = {
    SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND: "r2",
    SITE_BEHAVIOR_LAB_R2_BUCKET: this.env.SITE_BEHAVIOR_LAB_R2_BUCKET ?? "site-behavior-lab-reports",
    SITE_BEHAVIOR_LAB_R2_PREFIX: this.env.SITE_BEHAVIOR_LAB_R2_PREFIX ?? "reports/",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS: "cloudflare-containers",
    // This Worker is the only ingress and rewrites x-real-ip from the trusted
    // cf-connecting-ip on every forward (see forwardToContainer), so the container
    // can key its per-client rate limits on the real caller instead of collapsing
    // every reader into one shared "local" bucket.
    SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS: "1",
    // Browser CORS allow-list for the scan API. Pin to the Pages origin that calls
    // this scanner (set via `vars` in wrangler.container.jsonc); "*" allows any
    // origin, which is safe here because the scan API uses no cookies.
    SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN: this.env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN ?? "*",
    // Long Shields scans return 202 + jobId instead of holding the connection.
    SITE_BEHAVIOR_LAB_ASYNC_SCANS: "1",
    SITE_BEHAVIOR_LAB_DURABLE_JOBS: this.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS ?? "0",
    // Node owns the private fresh-DNS preparation gate and must observe the
    // exact non-secret feature flag. Encryption keys remain Worker-only.
    SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES: this.env.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES ?? "0",
    // The application-encryption key is intentionally NOT forwarded. Node gets
    // only the separate private-channel token and fixed callback origin.
    SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN:
      this.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN ?? "",
    SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL:
      this.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL ?? "",
    SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS: this.env.SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS ?? "",
    SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: this.env.SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX ?? "",
    // Shadow output is always the operator-only R2 prefix in Containers; the
    // rollout controls are owned at the Worker boundary and forwarded exactly.
    // Bucket-level public access is an operator preflight in the runbook.
    SITE_BEHAVIOR_LAB_V2_SHADOW_BACKEND: "r2",
    SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: this.env.SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION ?? "",
    SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS: this.env.SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS ?? "",
    SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION: this.env.SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION ?? "",
    // The front Worker is the public gate, but the container also enforces the
    // token (defense in depth). Cloudflare's deny-by-default egress switch is
    // intentionally not enabled here: the app proxy opens raw TCP to a validated,
    // pinned public IP, which that switch blocks. See the deployment runbook.
    SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN: this.env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN ?? "",
    // Forwarded so the container's /api/health treats open access as intentional
    // (no "token not configured" degradation) instead of looking misconfigured.
    SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS: this.env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS ?? "",
    SITE_BEHAVIOR_LAB_R2_ENDPOINT: this.env.SITE_BEHAVIOR_LAB_R2_ENDPOINT ?? "",
    SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID: this.env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID ?? "",
    SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY: this.env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY ?? ""
  };

  private durableEncryptionKeyPromise?: Promise<DurableScanJobEncryptionKey>;
  private encryptedWatchKeyringPromise?: Promise<EncryptedWatchKeyring>;
  private encryptedWatchKeysReady = false;

  /**
   * Exact public-scan quota accounting in the same singleton Durable Object
   * that owns the scanner container. SQLite and transactionSync make the
   * minute + day check-and-charge one atomic operation, so concurrent requests
   * cannot overshoot the configured token budget as they could with KV
   * read-then-write counters.
   */
  chargePublicScanRateLimit(input: PublicScanRateLimitCharge): PublicScanRateLimitResult {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() =>
      chargePublicScanRateLimitInStore(this.ctx.storage.sql, input, now)
    );
  }

  peekPublicScanRateLimit(input: PublicScanRateLimitCharge): PublicScanRateLimitResult {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() =>
      peekPublicScanRateLimitInStore(this.ctx.storage.sql, input, now)
    );
  }

  chargeDurableJobReadRateLimit(input: { clientHash: string }): PublicScanRateLimitResult {
    if (!/^[a-f0-9]{64}$/.test(input.clientHash)) {
      throw new Error("Invalid durable scan-job read-rate-limit charge.");
    }
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
      );
      sql.exec("DELETE FROM public_scan_rate_limits WHERE expires_at <= ?", now);
      const durationMs = 60_000;
      const windowId = Math.floor(now / durationMs);
      const expiresAt = (windowId + 1) * durationMs;
      const bucket = `durable-status/${windowId}/${input.clientHash}`;
      const row = sql
        .exec<{ used: number }>(
          "SELECT used FROM public_scan_rate_limits WHERE bucket = ? AND expires_at > ?",
          bucket,
          now
        )
        .toArray()[0];
      const used = row?.used ?? 0;
      if (used + 1 > 120) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000)) };
      }
      sql.exec(
        "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET used = excluded.used, expires_at = excluded.expires_at",
        bucket,
        used + 1,
        expiresAt
      );
      return { allowed: true };
    });
  }

  /**
   * Record only the submitter-held job capability and the separately minted
   * report capability. This registry survives a container process restart but
   * deliberately stores neither the scan target nor a client identifier.
   */
  registerScanJob(registration: DurableScanJobRegistration): void {
    this.ctx.storage.transactionSync(() => {
      registerDurableScanJob(this.ctx.storage.sql, registration);
    });
  }

  findRegisteredScanJob(jobId: string): DurableScanJobRegistration | null {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => findDurableScanJob(this.ctx.storage.sql, jobId, now));
  }

  /**
   * Commit the public quota charge, first durable job, immutable shard route,
   * encrypted watch, and first bounded history link as one authoritative unit.
   */
  async admitEncryptedWatchPreparation(
    preparation: DurableScanJobPreparation,
    payload: EncryptedWatchPayload,
    rateLimit: PublicScanRateLimitCharge,
    capabilityToken: string
  ): Promise<EncryptedWatchAdmissionResult> {
    assertPublicScanRateLimitCharge(rateLimit);
    if (rateLimit.cost !== 1 || preparation.payload.rateLimitCost !== 1) {
      throw new Error("Encrypted watches require an exact single-scan quota charge.");
    }
    requireEncryptedWatchConfig(this.env);
    const sharding = requireDurableContainerShardingPlan(this.env);
    const containerRoute = selectDurableContainerShard(preparation.submission.jobId, sharding.shardCount);
    const [watchKeyring, durableKey, credential] = await Promise.all([
      this.encryptedWatchKeyring(),
      this.durableEncryptionKey(),
      createEncryptedWatchCredentialFromToken(capabilityToken)
    ]);
    const [watchAdmission, durableAdmission] = await Promise.all([
      createEncryptedWatchAdmission(watchKeyring, {
        credential,
        createdAt: preparation.payload.admittedAt,
        payload,
        initialRun: {
          jobId: preparation.submission.jobId,
          reportId: preparation.submission.reportId,
          admittedAt: preparation.payload.admittedAt
        }
      }),
      createDurableScanJobAdmission(durableKey, {
        jobId: preparation.submission.jobId,
        reportId: preparation.submission.reportId,
        createdAt: preparation.payload.admittedAt,
        payload: preparation.payload
      })
    ]);

    let preflight: PublicScanRateLimitResult;
    try {
      preflight = this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        ensureDurableScanJobStore(this.ctx.storage.sql);
        ensureEncryptedWatchStore(this.ctx.storage.sql);
        this.purgeDurableScanJobState(now);
        purgeExpiredEncryptedWatches(this.ctx.storage.sql, now);
        preflightDurableScanJobAdmission(this.ctx.storage.sql, durableAdmission);
        return peekPublicScanRateLimitInStore(this.ctx.storage.sql, rateLimit, now);
      });
    } catch (error) {
      if (
        error instanceof DurableScanJobCapacityError ||
        error instanceof DurableScanJobStateError ||
        error instanceof EncryptedWatchCapacityError ||
        error instanceof EncryptedWatchStateError
      ) {
        return { status: "refused" };
      }
      throw error;
    }
    if (!preflight.allowed) {
      return { status: "rate-limited", retryAfterSeconds: preflight.retryAfterSeconds };
    }

    await this.ensureImmediateDurablePumpWake();
    try {
      return this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        const committed = commitPublicScanRateLimitedOperation(
          this.ctx.storage.sql,
          rateLimit,
          now,
          () => {
            const durable = admitDurableScanJob(this.ctx.storage.sql, durableAdmission);
            recordDurableContainerShardRoute(this.ctx.storage.sql, durable.jobId, containerRoute);
            const snapshot = admitEncryptedWatch(this.ctx.storage.sql, watchAdmission);
            pruneDurableContainerShardRoutes(this.ctx.storage.sql);
            return snapshot;
          }
        );
        if (committed.status === "rate-limited") return committed;
        return {
          status: "success" as const,
          snapshot: committed.value,
          capability: credential.token
        };
      });
    } catch (error) {
      if (
        error instanceof DurableScanJobCapacityError ||
        error instanceof DurableScanJobStateError ||
        error instanceof EncryptedWatchCapacityError ||
        error instanceof EncryptedWatchStateError
      ) {
        return { status: "refused" };
      }
      throw error;
    }
  }

  findEncryptedWatch(watchId: string, capabilityHash: ArrayBuffer): EncryptedWatchSnapshot | null {
    return this.ctx.storage.transactionSync(() =>
      findEncryptedWatchByCapability(this.ctx.storage.sql, {
        watchId,
        capabilityHash,
        now: Date.now()
      })
    );
  }

  deleteEncryptedWatch(watchId: string, capabilityHash: ArrayBuffer): boolean {
    const deleted = this.ctx.storage.transactionSync(() =>
      deleteEncryptedWatch(this.ctx.storage.sql, { watchId, capabilityHash })
    );
    if (deleted) this.rearmDurablePumpAfterCommittedMutation("encrypted-watch deletion");
    return deleted;
  }

  chargeEncryptedWatchReadRateLimit(input: { clientHash: string }): PublicScanRateLimitResult {
    if (!/^[a-f0-9]{64}$/.test(input.clientHash)) {
      throw new Error("Invalid encrypted-watch read-rate-limit charge.");
    }
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
      );
      sql.exec("DELETE FROM public_scan_rate_limits WHERE expires_at <= ?", now);
      const durationMs = 60_000;
      const windowId = Math.floor(now / durationMs);
      const expiresAt = (windowId + 1) * durationMs;
      const bucket = `encrypted-watch-read/${windowId}/${input.clientHash}`;
      const used =
        sql
          .exec<{ used: number }>(
            "SELECT used FROM public_scan_rate_limits WHERE bucket = ? AND expires_at > ?",
            bucket,
            now
          )
          .toArray()[0]?.used ?? 0;
      if (used + 1 > 120) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1_000)) };
      }
      sql.exec(
        "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET used = excluded.used, expires_at = excluded.expires_at",
        bucket,
        used + 1,
        expiresAt
      );
      return { allowed: true };
    });
  }

  async ensureEncryptedWatchPumpWake(): Promise<boolean> {
    try {
      requireEncryptedWatchConfig(this.env);
      await this.encryptedWatchKeyring();
      const now = Date.now();
      const watchWakeAt = this.ctx.storage.transactionSync(() => {
        ensureEncryptedWatchStore(this.ctx.storage.sql);
        return nextEncryptedWatchWakeAt(this.ctx.storage.sql, now);
      });
      if (watchWakeAt === null) return true;
      if (watchWakeAt <= now) {
        await this.ensureImmediateDurablePumpWake();
      } else {
        // Recompute the shared driver at the real earliest watch/job boundary.
        // Repeated public health polls reuse that future row instead of forcing
        // a one-second callback and waking the container in a hot loop.
        await this.scheduleNextDurablePump();
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Encrypt, schedule, and atomically admit before the edge may expose 202. */
  async admitDurablePreparation(
    preparation: DurableScanJobPreparation,
    replayFaultMode: DurableReplayFaultMode | null,
    rateLimit: PublicScanRateLimitCharge
  ): Promise<DurableScanJobAdmissionResult> {
    assertPublicScanRateLimitCharge(rateLimit);
    if (!publicScanRateLimitChargeMatchesCost(rateLimit, preparation.payload.rateLimitCost)) {
      throw new Error("The durable scan-job quota cost does not match its prepared payload.");
    }
    requireDurableScanJobConfig(this.env);
    const sharding = requireDurableContainerShardingPlan(this.env);
    const containerRoute = selectDurableContainerShard(
      preparation.submission.jobId,
      sharding.shardCount
    );
    if (replayFaultMode !== null && durableReplayFaultConfig(this.env).status !== "ready") {
      throw new Error("The staging durable replay fault hook is not ready.");
    }
    const key = await this.durableEncryptionKey();
    const admission = await createDurableScanJobAdmission(key, {
      jobId: preparation.submission.jobId,
      reportId: preparation.submission.reportId,
      createdAt: preparation.payload.admittedAt,
      payload: preparation.payload
    });

    // Reject full/colliding or quota-exhausted admissions before calling
    // Container.schedule(), whose singleton alarm write would otherwise be
    // remotely postponable by a stream of refused requests. The final
    // transaction repeats both checks after an imminent, coalesced wake is
    // durably present.
    let rateLimitPreflight: PublicScanRateLimitResult;
    try {
      const now = Date.now();
      rateLimitPreflight = this.ctx.storage.transactionSync(() => {
        ensureDurableScanJobStore(this.ctx.storage.sql);
        this.purgeDurableScanJobState(now);
        preflightDurableScanJobAdmission(this.ctx.storage.sql, admission);
        return peekPublicScanRateLimitInStore(this.ctx.storage.sql, rateLimit, now);
      });
    } catch (error) {
      if (error instanceof DurableScanJobCapacityError || error instanceof DurableScanJobStateError) {
        return { status: "refused" };
      }
      throw error;
    }
    if (!rateLimitPreflight.allowed) {
      return { status: "rate-limited", retryAfterSeconds: rateLimitPreflight.retryAfterSeconds };
    }
    await this.ensureImmediateDurablePumpWake();
    try {
      return this.ctx.storage.transactionSync(() => {
        const now = Date.now();
        const committed = commitPublicScanRateLimitedOperation(
          this.ctx.storage.sql,
          rateLimit,
          now,
          () => {
            const admitted = admitDurableScanJob(this.ctx.storage.sql, admission);
            recordDurableContainerShardRoute(this.ctx.storage.sql, admitted.jobId, containerRoute);
            pruneDurableContainerShardRoutes(this.ctx.storage.sql);
            if (replayFaultMode !== null) {
              armDurableReplayFault(this.ctx.storage.sql, {
                jobId: admitted.jobId,
                mode: replayFaultMode,
                now
              });
            }
            return admitted;
          }
        );
        if (committed.status === "rate-limited") {
          return committed;
        }
        return { status: "success" as const, snapshot: committed.value };
      });
    } catch (error) {
      if (error instanceof DurableScanJobCapacityError || error instanceof DurableScanJobStateError) {
        return { status: "refused" };
      }
      throw error;
    }
  }

  findDurableJob(jobId: string): DurableScanJobSnapshot | null {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      ensureDurableScanJobStore(this.ctx.storage.sql);
      this.purgeDurableScanJobState(now);
      return findDurableScanJobSnapshot(this.ctx.storage.sql, jobId);
    });
  }

  findStagingDurableReplayFault(jobId: string): DurableReplayFault | null {
    if (durableReplayFaultConfig(this.env).status !== "ready") return null;
    const now = Date.now();
    return this.ctx.storage.transactionSync(() =>
      readDurableReplayFault(this.ctx.storage.sql, jobId, now)
    );
  }

  async triggerStagingLeaseExpiryFault(
    owner: DurableScanJobExecutionOwner
  ): Promise<DurableReplayFault | null> {
    if (durableReplayFaultConfig(this.env).status !== "ready") return null;
    const tokenHash = await hashDurableScanJobLeaseToken(owner.leaseToken);
    const now = Date.now();
    return this.ctx.storage.transactionSync(() =>
      triggerLeaseExpiryDurableReplayFault(this.ctx.storage.sql, {
        jobId: owner.jobId,
        generation: owner.generation,
        tokenHash,
        now
      })
    );
  }

  async dropStagingLostResolveFault(
    owner: DurableScanJobExecutionOwner
  ): Promise<DurableReplayLostResolveDrop | null> {
    if (durableReplayFaultConfig(this.env).status !== "ready") return null;
    const tokenHash = await hashDurableScanJobLeaseToken(owner.leaseToken);
    const now = Date.now();
    return this.ctx.storage.transactionSync(() =>
      dropLostResolveDurableReplayFault(this.ctx.storage.sql, {
        jobId: owner.jobId,
        generation: owner.generation,
        tokenHash,
        now
      })
    );
  }

  async cancelDurableJob(jobId: string): Promise<DurableScanJobCancellationResult> {
    let result: Extract<DurableScanJobCancellationResult, { status: "success" }>;
    try {
      const now = Date.now();
      result = this.ctx.storage.transactionSync(() => {
        const before = findDurableScanJobSnapshot(this.ctx.storage.sql, jobId);
        const snapshot = cancelDurableScanJob(this.ctx.storage.sql, { jobId, now });
        this.recordEncryptedWatchTerminalOutcomeSafely({
          jobId,
          now,
          resolution: { outcome: "cancelled", errorCode: "cancelled" }
        });
        return {
          status: "success" as const,
          snapshot,
          abortGeneration:
            before?.state === "leased" || (before?.state === "queued" && before.leaseGeneration > 0)
              ? before.leaseGeneration
              : null
        };
      });
    } catch (error) {
      if (error instanceof DurableScanJobStateError) return { status: "conflict" };
      throw error;
    }
    this.rearmDurablePumpAfterCommittedMutation("cancellation");
    if (result.abortGeneration !== null) {
      this.ctx.waitUntil(
        Promise.resolve()
          .then(() =>
            this.privateContainerRequest(
              jobId,
              `${DURABLE_SCAN_JOB_NODE_PATH_PREFIX}/${jobId}`,
              "DELETE",
              { jobId, generation: result.abortGeneration },
              true
            )
          )
          .then((response) => response.arrayBuffer())
          .then(() => undefined)
          .catch((error) => {
            // Cancellation correctness comes from the DO transition; local
            // abort delivery only shortens cleanup of fenced execution.
            console.error("Could not deliver best-effort durable scan-job abort.", error);
          })
      );
    }
    return {
      status: result.status,
      snapshot: result.snapshot,
      abortGeneration: result.abortGeneration
    };
  }

  async heartbeatDurableJob(owner: DurableScanJobExecutionOwner): Promise<DurableScanJobMutationResult> {
    const tokenHash = await hashDurableScanJobLeaseToken(owner.leaseToken);
    try {
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        heartbeatDurableScanJob(this.ctx.storage.sql, {
          jobId: owner.jobId,
          generation: owner.generation,
          tokenHash,
          now
        });
      });
    } catch (error) {
      if (error instanceof DurableScanJobStateError) return { status: "conflict" };
      throw error;
    }
    this.rearmDurablePumpAfterCommittedMutation("heartbeat");
    return { status: "success" };
  }

  async beginPublishingDurableJob(
    owner: DurableScanJobExecutionOwner,
    manifest: unknown
  ): Promise<DurableScanJobMutationResult> {
    const manifestWire = JSON.stringify(manifest);
    const tokenHash = await hashDurableScanJobLeaseToken(owner.leaseToken);
    try {
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        beginPublishingDurableScanJob(this.ctx.storage.sql, {
          jobId: owner.jobId,
          generation: owner.generation,
          tokenHash,
          now,
          manifest: manifestWire
        });
      });
    } catch (error) {
      if (error instanceof DurableScanJobStateError) return { status: "conflict" };
      throw error;
    }
    this.rearmDurablePumpAfterCommittedMutation("publication fence");
    return { status: "success" };
  }

  async resolveDurableJob(
    owner: DurableScanJobExecutionOwner,
    resolution: { outcome: "succeeded" | "failed" | "cancelled" }
  ): Promise<DurableScanJobMutationResult> {
    const tokenHash = await hashDurableScanJobLeaseToken(owner.leaseToken);
    try {
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        resolveDurableScanJob(this.ctx.storage.sql, {
          jobId: owner.jobId,
          generation: owner.generation,
          tokenHash,
          now,
          outcome: resolution.outcome,
          reason:
            resolution.outcome === "failed"
              ? "execution-failed"
              : resolution.outcome === "cancelled"
                ? "cancelled"
                : undefined
        });
        this.recordEncryptedWatchTerminalOutcomeSafely({
          jobId: owner.jobId,
          now,
          resolution:
            resolution.outcome === "succeeded"
              ? { outcome: "succeeded" }
              : { outcome: resolution.outcome, errorCode: resolution.outcome === "failed" ? "execution-failed" : "cancelled" }
        });
      });
    } catch (error) {
      if (error instanceof DurableScanJobStateError) return { status: "conflict" };
      throw error;
    }
    this.rearmDurablePumpAfterCommittedMutation("resolution");
    return { status: "success" };
  }

  /** Persistent Container schedule callback. Do not override Container.alarm(). */
  async pumpDurableScanJobs(
    payload?: DurablePumpSchedulePayload,
    schedule?: DurablePumpScheduleContext
  ): Promise<void> {
    if (payload && !this.isCurrentDurablePumpSchedule(payload)) return;
    // Containers deletes the invoking one-shot after this callback returns and
    // does not retry a callback exception. Keep that row intact while schedule()
    // persists an immediate epoch-owned successor, then switch the driver and
    // remove the old row in one transaction. Every later await is therefore
    // covered even across a reset/deploy during key import or reconciliation.
    try {
      await this.prearmDurablePumpSuccessor(schedule?.taskId);
    } catch (error) {
      console.error("Could not create the epoch-owned durable pump successor; using raw fallback.", error);
      // Retry through a schema-minimal payload-free row. Its insert and
      // compaction are synchronous; once this returns, an alarm-write failure
      // cannot erase the successor when Containers deletes the invoking row.
      this.persistImmediateDurablePumpFallbackSchedule();
      try {
        await this.scheduleNextAlarm(0);
      } catch (alarmError) {
        console.error("Could not kick the pre-armed durable pump fallback alarm.", alarmError);
      }
    }
    if (!durableScanJobsEnabled(this.env)) {
      await this.maintainAndParkDisabledDurablePump();
      return;
    }
    try {
      requireDurableScanJobConfig(this.env);
      // A malformed key is an operator/configuration failure, not an execution
      // attempt. Validate it before claiming or replaying any accepted work.
      await this.durableEncryptionKey();
    } catch (error) {
      // Configuration changes require a deployment/new instance. Avoid a
      // queued-row one-second alarm loop while the fail-closed health check is
      // telling the operator the feature is unavailable.
      console.error("Durable scan-job pump is not configured.", error);
      await this.maintainAndParkDisabledDurablePump();
      return;
    }

    try {
      // Watches share this persistent driver. A due rescan becomes an ordinary
      // queued durable job before the normal claim pass below, with no polling
      // request and no second alarm system.
      await this.admitDueEncryptedWatchRuns();
      const now = Date.now();
      const expired = this.ctx.storage.transactionSync(() => {
        ensureDurableScanJobStore(this.ctx.storage.sql);
        this.purgeDurableScanJobState(now);
        return listExpiredDurableScanJobLeases(this.ctx.storage.sql, now);
      });

      for (const snapshot of expired) {
        if (snapshot.state === "leased") {
          this.ctx.storage.transactionSync(() => {
            requeueOrFailExpiredDurableScanJobLease(this.ctx.storage.sql, {
              jobId: snapshot.jobId,
              generation: snapshot.leaseGeneration,
              now
            });
          });
          continue;
        }
        if (
          snapshot.state === "publishing" &&
          snapshot.deadlineAt > now &&
          this.reconciliationIsDue(snapshot, now)
        ) {
          const outcome = await this.reconcileExpiredDurablePublication(snapshot, now);
          const completedAt = Date.now();
          if (outcome === "retryable" && completedAt >= snapshot.deadlineAt) {
            this.ctx.storage.transactionSync(() => {
              reconcileExpiredPublishingDurableScanJob(this.ctx.storage.sql, {
                jobId: snapshot.jobId,
                generation: snapshot.leaseGeneration,
                now: completedAt,
                result: "expired"
              });
              this.clearDurableReconciliationBackoff(snapshot.jobId);
            });
          }
        }
      }

      // Deadline processing runs after lease recovery so publishing gets one
      // final exact R2 reconciliation instead of being blindly expired.
      const pastDeadline = this.ctx.storage.transactionSync(() =>
        listPastDeadlineDurableScanJobs(this.ctx.storage.sql, now)
      );
      for (const snapshot of pastDeadline) {
        if (snapshot.state === "publishing") {
          const settlementAt = this.durablePublicationSettlementAt(snapshot);
          if (now < settlementAt) {
            await this.scheduleNextDurablePump(settlementAt);
            continue;
          }
          const outcome = await this.reconcileExpiredDurablePublication(snapshot, now, true);
          if (outcome === "retryable") {
            const expirationAt = Date.now();
            this.ctx.storage.transactionSync(() => {
              reconcileExpiredPublishingDurableScanJob(this.ctx.storage.sql, {
                jobId: snapshot.jobId,
                generation: snapshot.leaseGeneration,
                now: expirationAt,
                result: "expired"
              });
              this.clearDurableReconciliationBackoff(snapshot.jobId);
            });
          }
        } else {
          this.ctx.storage.transactionSync(() => {
            expireDurableScanJob(this.ctx.storage.sql, { jobId: snapshot.jobId, now });
          });
        }
      }

      // Persist a fresh idempotent driver before claim consumes an attempt. A
      // failed pre-arm leaves every row queued; once it succeeds, a later
      // recompute failure cannot prevent this pump from activating raw owners.
      await this.scheduleNextDurablePump();
      const credentials = await createDurableScanJobLeaseCredentials(DURABLE_SCAN_JOB_EXECUTION_CAPACITY);
      const claims = this.ctx.storage.transactionSync(() =>
        claimDurableScanJobs(this.ctx.storage.sql, {
          now: Date.now(),
          capacity: DURABLE_SCAN_JOB_EXECUTION_CAPACITY,
          credentials
        })
      );
      const key = await this.durableEncryptionKey();
      const activations: Array<{ claim: DurableScanJobClaim; preparation: DurableScanJobPreparation["payload"] }> = [];
      for (const claim of claims) {
        try {
          const preparation = await decryptDurableScanJobClaim(key, claim);
          const abandoned = await this.triggerStagingLeaseExpiryFault({
            jobId: claim.jobId,
            generation: claim.leaseGeneration,
            leaseToken: claim.leaseToken
          });
          if (abandoned) {
            console.log(
              JSON.stringify({
                event: "durable-replay-fault-triggered",
                mode: abandoned.mode,
                jobId: abandoned.jobId,
                generation: abandoned.triggeredGeneration
              })
            );
            // Leave generation one leased and untouched. The persistent pump's
            // scheduled expiry is the canary under test; no request/poll drives it.
            continue;
          }
          activations.push({ claim, preparation });
        } catch (error) {
          console.error("Could not decrypt an admitted durable scan job; failing the fenced lease.", error);
          try {
            const tokenHash = await hashDurableScanJobLeaseToken(claim.leaseToken);
            this.ctx.storage.transactionSync(() => {
              resolveDurableScanJob(this.ctx.storage.sql, {
                jobId: claim.jobId,
                generation: claim.leaseGeneration,
                tokenHash,
                now: Date.now(),
                outcome: "failed",
                reason: "payload-invalid"
              });
            });
          } catch (resolveError) {
            console.error("Could not terminalize an invalid durable scan-job payload.", resolveError);
          }
        }
      }

      // The next lease/deadline/purge wake is durable before Node activation.
      try {
        await this.scheduleNextDurablePump();
      } catch (error) {
        // The pre-claim driver is already durable. Keep activating now because
        // this pump is the only holder of the plaintext lease tokens.
        console.error("Could not recompute the post-claim durable pump schedule.", error);
      }
      await Promise.all(activations.map(({ claim, preparation }) => this.activateDurableClaim(claim, preparation)));
    } catch (error) {
      console.error("Durable scan-job pump failed.", error);
    } finally {
      // Containers consumes one-shot callbacks even on exceptions. Recompute a
      // wake unconditionally so liveness never depends on a poll or request.
      await this.rearmDurablePumpAfterCallback();
    }
  }

  private async activateDurableClaim(
    claim: DurableScanJobClaim,
    payload: DurableScanJobPreparation["payload"]
  ): Promise<void> {
    const config = requireDurableScanJobConfig(this.env);
    let response: Response;
    try {
      response = await this.privateContainerRequest(
        claim.jobId,
        `${DURABLE_SCAN_JOB_NODE_PATH_PREFIX}/${claim.jobId}`,
        "POST",
        {
          jobId: claim.jobId,
          reportId: claim.reportId,
          generation: claim.leaseGeneration,
          leaseToken: claim.leaseToken,
          payload,
          coordinatorUrl: config.coordinatorUrl,
          internalToken: config.internalToken
        }
      );
      await response.arrayBuffer();
      if (!response.ok) {
        console.error(`Durable scan-job activation returned HTTP ${response.status}.`);
      }
    } catch (error) {
      // Leave the lease untouched. Its scheduled expiry is the retry fence.
      console.error("Could not activate a durable scan-job lease.", error);
    }
  }

  private maintainEncryptedWatchRetention(now = Date.now()): void {
    try {
      this.ctx.storage.transactionSync(() => {
        ensureEncryptedWatchStore(this.ctx.storage.sql);
        purgeExpiredEncryptedWatches(this.ctx.storage.sql, now);
        recoverExpiredEncryptedWatchLeases(this.ctx.storage.sql, now);
      });
    } catch {
      console.error("Could not maintain encrypted scheduled-rescan retention.");
    }
  }

  /** Claim, decrypt, freshly revalidate, and admit due watches under the same pump. */
  private async admitDueEncryptedWatchRuns(): Promise<void> {
    if (encryptedWatchesFlagState(this.env[ENCRYPTED_WATCHES_ENV]) !== "enabled") {
      this.maintainEncryptedWatchRetention();
      return;
    }
    try {
      requireEncryptedWatchConfig(this.env);
    } catch {
      this.maintainEncryptedWatchRetention();
      return;
    }

    let keyring: EncryptedWatchKeyring;
    try {
      keyring = await this.encryptedWatchKeyring();
    } catch {
      // Key errors are surfaced through health. Do not turn an optional feature
      // misconfiguration into an ordinary durable-scan outage or a hot loop.
      this.maintainEncryptedWatchRetention();
      return;
    }

    let claims: EncryptedWatchClaim[];
    try {
      const credentials = await createEncryptedWatchLeaseCredentials(DURABLE_SCAN_JOB_EXECUTION_CAPACITY);
      claims = this.ctx.storage.transactionSync(() =>
        claimDueEncryptedWatches(this.ctx.storage.sql, {
          now: Date.now(),
          capacity: DURABLE_SCAN_JOB_EXECUTION_CAPACITY,
          credentials
        })
      );
      await Promise.all(claims.map((claim) => this.admitEncryptedWatchClaim(keyring, claim)));
    } catch {
      console.error("Could not process encrypted scheduled-rescan claims.");
    }
  }

  private async admitEncryptedWatchClaim(keyring: EncryptedWatchKeyring, claim: EncryptedWatchClaim): Promise<void> {
    let payload: EncryptedWatchPayload;
    try {
      payload = await decryptEncryptedWatchClaim(keyring, claim);
    } catch {
      await this.failEncryptedWatchClaim(claim, "payload-invalid");
      return;
    }

    let preparedResponse: Response;
    try {
      preparedResponse = await this.privateEncryptedWatchPreparationRequest(payload);
    } catch {
      await this.failEncryptedWatchClaim(claim, "prepare-unavailable");
      return;
    }
    const preparation = readDurableScanJobPreparation(preparedResponse);
    await preparedResponse.arrayBuffer().catch(() => undefined);
    const retained = preparation ? encryptedWatchPayloadFromPreparation(preparation) : null;
    if (
      preparedResponse.status !== 202 ||
      !preparation ||
      !retained ||
      JSON.stringify(retained) !== JSON.stringify(payload)
    ) {
      await this.failEncryptedWatchClaim(claim, "prepare-refused");
      return;
    }

    try {
      const [durableKey, tokenHash] = await Promise.all([
        this.durableEncryptionKey(),
        hashEncryptedWatchLeaseToken(claim.leaseToken)
      ]);
      const admission = await createDurableScanJobAdmission(durableKey, {
        jobId: preparation.submission.jobId,
        reportId: preparation.submission.reportId,
        createdAt: preparation.payload.admittedAt,
        payload: preparation.payload
      });
      const sharding = requireDurableContainerShardingPlan(this.env);
      const containerRoute = selectDurableContainerShard(preparation.submission.jobId, sharding.shardCount);
      this.ctx.storage.transactionSync(() => {
        const committedAt = Date.now();
        preflightDurableScanJobAdmission(this.ctx.storage.sql, admission);
        const durable = admitDurableScanJob(this.ctx.storage.sql, admission);
        recordDurableContainerShardRoute(this.ctx.storage.sql, durable.jobId, containerRoute);
        resolveEncryptedWatchLease(this.ctx.storage.sql, {
          watchId: claim.watchId,
          generation: claim.leaseGeneration,
          tokenHash,
          now: committedAt,
          resolution: {
            outcome: "admitted",
            jobId: preparation.submission.jobId,
            reportId: preparation.submission.reportId,
            admittedAt: preparation.payload.admittedAt
          }
        });
        pruneDurableContainerShardRoutes(this.ctx.storage.sql);
      });
    } catch (error) {
      if (error instanceof EncryptedWatchStateError && error.code === "lease-invalid") return;
      await this.failEncryptedWatchClaim(claim, "admission-refused");
    }
  }

  private async failEncryptedWatchClaim(claim: EncryptedWatchClaim, _errorCode: string): Promise<void> {
    try {
      const tokenHash = await hashEncryptedWatchLeaseToken(claim.leaseToken);
      this.ctx.storage.transactionSync(() => {
        resolveEncryptedWatchLease(this.ctx.storage.sql, {
          watchId: claim.watchId,
          generation: claim.leaseGeneration,
          tokenHash,
          now: Date.now(),
          resolution: { outcome: "failed" }
        });
      });
    } catch (error) {
      // Delete/expiry or a newer generation legitimately fences this resolver.
      if (!(error instanceof EncryptedWatchStateError)) {
        console.error("Could not terminalize an encrypted scheduled-rescan lease.");
      }
    }
  }

  private privateEncryptedWatchPreparationRequest(payload: EncryptedWatchPayload): Promise<Response> {
    const token = requireDurableScanJobConfig(this.env).internalToken;
    return this.containerFetch(
      new Request(`http://container.internal${DURABLE_SCAN_JOB_NODE_PATH_PREFIX}/prepare-watch`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          [DURABLE_SCAN_JOB_INTERNAL_HEADER]: token
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60_000)
      })
    );
  }

  private async reconcileExpiredDurablePublication(
    snapshot: DurableScanJobSnapshot,
    now: number,
    force = false,
    allowDisabled = false
  ): Promise<"transitioned" | "retryable"> {
    if (!force && !this.reconciliationIsDue(snapshot, now)) return "retryable";
    const maintenanceAt = Date.now();
    this.ctx.storage.transactionSync(() => this.purgeDurableScanJobState(maintenanceAt));
    if (maintenanceAt >= snapshot.purgeAt) return "transitioned";
    let manifest: unknown;
    try {
      manifest = JSON.parse(snapshot.publicationManifest ?? "");
    } catch {
      this.ctx.storage.transactionSync(() => {
        reconcileExpiredPublishingDurableScanJob(this.ctx.storage.sql, {
          jobId: snapshot.jobId,
          generation: snapshot.leaseGeneration,
          now,
          result: "integrity-failed",
          reason: "publication-integrity"
        });
        this.clearDurableReconciliationBackoff(snapshot.jobId);
      });
      return "transitioned";
    }

    let response: Response;
    const reconciliationStartedAt = Date.now();
    const storePurgeAt = this.ctx.storage.transactionSync(() => {
      this.purgeDurableScanJobState(reconciliationStartedAt);
      return earliestDurableScanJobPurgeAt(this.ctx.storage.sql);
    });
    if (reconciliationStartedAt >= snapshot.purgeAt) return "transitioned";
    const reconciliationTimeoutMs = durableReconciliationTimeoutMs(
      reconciliationStartedAt,
      Math.min(snapshot.purgeAt, storePurgeAt ?? snapshot.purgeAt),
      DURABLE_SCAN_JOB_RECONCILIATION_TIMEOUT_MS
    );
    if (reconciliationTimeoutMs <= 0) {
      this.ctx.storage.transactionSync(() => this.purgeDurableScanJobState(reconciliationStartedAt));
      return "transitioned";
    }
    try {
      response = await this.privateContainerRequest(
        snapshot.jobId,
        `${DURABLE_SCAN_JOB_NODE_PATH_PREFIX}/${snapshot.jobId}/reconcile`,
        "POST",
        {
          jobId: snapshot.jobId,
          reportId: snapshot.reportId,
          generation: snapshot.leaseGeneration,
          manifest
        },
        allowDisabled,
        reconciliationTimeoutMs
      );
    } catch {
      const completedAt = Date.now();
      const purged = completedAt >= snapshot.purgeAt;
      this.ctx.storage.transactionSync(() => {
        this.recordDurableReconciliationBackoff(snapshot, completedAt);
        this.purgeDurableScanJobState(completedAt);
      });
      return purged ? "transitioned" : "retryable";
    }

    let result: unknown;
    try {
      result = await response.json();
    } catch {
      result = null;
    }
    const outcome = durableReconciliationOutcome(result, snapshot);
    const completedAt = Date.now();
    if (!response.ok || outcome === "retryable") {
      const purged = completedAt >= snapshot.purgeAt;
      this.ctx.storage.transactionSync(() => {
        this.recordDurableReconciliationBackoff(snapshot, completedAt);
        this.purgeDurableScanJobState(completedAt);
      });
      return purged ? "transitioned" : "retryable";
    }

    this.ctx.storage.transactionSync(() => {
      reconcileExpiredPublishingDurableScanJob(this.ctx.storage.sql, {
        jobId: snapshot.jobId,
        generation: snapshot.leaseGeneration,
        now: completedAt,
        result:
          outcome === "succeeded"
            ? "succeeded"
            : outcome === "missing"
              ? "missing"
              : "integrity-failed",
        reason: outcome === "integrity-error" ? "publication-integrity" : undefined
      });
      this.clearDurableReconciliationBackoff(snapshot.jobId);
      // Reconciliation may have started just before the immutable 75-minute
      // boundary. Apply the terminal transition first, then immediately purge
      // at the authoritative completion time so ciphertext/status cannot live
      // past the documented hard horizon.
      this.purgeDurableScanJobState(completedAt);
    });
    return "transitioned";
  }

  private privateContainerRequest(
    jobId: string,
    pathname: string,
    method: "POST" | "DELETE",
    body: unknown,
    allowDisabled = false,
    timeoutMs = 60_000
  ): Promise<Response> {
    // Every job-scoped container call resolves through this server-owned,
    // admission-persisted route. No public/private request body can choose a
    // shard, and a configuration rollback cannot remap accepted work.
    const containerRoute = this.ctx.storage.transactionSync(() =>
      findDurableContainerShardRoute(this.ctx.storage.sql, jobId)
    );
    const token = allowDisabled
      ? requireDurableScanJobInternalToken(this.env)
      : requireDurableScanJobConfig(this.env).internalToken;
    const request = new Request(`http://container.internal${pathname}`, {
      method,
      headers: {
        "content-type": "application/json; charset=utf-8",
        [DURABLE_SCAN_JOB_INTERNAL_HEADER]: token
      },
      body: JSON.stringify(body),
      // A wedged cold start or backend read must yield back to the persistent
      // lease/backoff schedule rather than strand the DO callback indefinitely.
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Index zero is intentionally the historical default singleton, so the
    // configured max_instances ceiling includes the coordinator's warm Node
    // process instead of accidentally allocating N shards plus one.
    return containerRoute.containerName === null
      ? this.containerFetch(request)
      : getContainer(this.env.SCANNER, containerRoute.containerName).fetch(request);
  }

  private ensureDurableReconciliationBackoffStore(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS durable_scan_job_reconciliation_backoff (job_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, attempt INTEGER NOT NULL, next_at INTEGER NOT NULL)"
    );
  }

  private ensureDurablePumpDriverStore(): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS durable_scan_job_pump_driver (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), epoch TEXT NOT NULL, task_id TEXT)"
    );
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(durable_scan_job_pump_driver)")
      .toArray();
    if (!columns.some((column) => column.name === "task_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE durable_scan_job_pump_driver ADD COLUMN task_id TEXT");
    }
  }

  private async ensureImmediateDurablePumpWake(): Promise<void> {
    const latestSecond = Math.floor(Date.now() / 1_000 + 1);
    this.ensureDurablePumpDriverStore();
    const existing = this.ctx.storage.sql
      .exec<{ id: string; time: number }>(
        `SELECT schedules.id AS id, schedules.time AS time
         FROM container_schedules schedules
         LEFT JOIN durable_scan_job_pump_driver driver ON driver.task_id = schedules.id
         WHERE schedules.callback = ? AND schedules.time <= ?
           AND (schedules.payload IS NULL OR driver.task_id = schedules.id)
         ORDER BY schedules.time ASC LIMIT 1`,
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        latestSecond
      )
      .toArray()[0];
    if (existing) {
      if (durablePumpReuseNeedsAlarmKick(existing.time, Date.now())) await this.scheduleNextAlarm(0);
      return;
    }
    await this.schedule(1, DURABLE_SCAN_JOB_PUMP_CALLBACK);
  }

  private async parkDisabledDurablePump(): Promise<void> {
    const { unfinished, nextWakeAt, now } = this.ctx.storage.transactionSync(() => {
      ensureDurableScanJobStore(this.ctx.storage.sql);
      const now = Date.now();
      this.purgeDurableScanJobState(now);
      const row = this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM durable_scan_jobs WHERE state IN ('queued','leased','publishing')"
        )
        .toArray()[0];
      this.ensureDurableReconciliationBackoffStore();
      const wake = this.ctx.storage.sql
        .exec<{ wake_at: number | null }>(
          `SELECT MIN(wake_at) AS wake_at FROM (
             SELECT deadline_at AS wake_at FROM durable_scan_jobs WHERE state IN ('queued','leased')
             UNION ALL
             SELECT MIN(
               CASE
                 WHEN backoff.generation = jobs.lease_generation AND backoff.next_at > ? THEN backoff.next_at
                 ELSE MIN(jobs.lease_expires_at + ?, jobs.deadline_at)
               END,
               jobs.deadline_at
             ) AS wake_at
             FROM durable_scan_jobs jobs
             LEFT JOIN durable_scan_job_reconciliation_backoff backoff ON backoff.job_id = jobs.job_id
             WHERE jobs.state = 'publishing'
             UNION ALL SELECT purge_at AS wake_at FROM durable_scan_jobs
           )`,
          now,
          DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS
        )
        .toArray()[0];
      return {
        unfinished: (row?.count ?? 0) > 0,
        nextWakeAt: wake?.wake_at ?? null,
        now
      };
    });
    const watchWakeAt = this.safeEncryptedWatchWakeAt(now, false);
    const retainedWakeAt = minimumTimestamp(nextWakeAt, watchWakeAt);
    if (unfinished) {
      // Keep a low-frequency request-independent wake so correcting a bad flag
      // or secret resumes work without polling, while never scheduling later
      // than a nearer hard deadline, settlement fence, or purge boundary.
      const wakeAt = Math.min(now + 60_000, retainedWakeAt ?? now + 60_000);
      await this.persistParkedDurablePumpSchedule(Math.max(wakeAt, Date.now() + 1_000));
    } else if (retainedWakeAt !== null) {
      // Disabled mode still honors the bounded 75-minute tombstone retention;
      // otherwise terminal metadata could remain indefinitely after a rollback.
      await this.persistParkedDurablePumpSchedule(Math.max(retainedWakeAt, Date.now() + 1_000));
    } else {
      this.deleteSchedules(DURABLE_SCAN_JOB_PUMP_CALLBACK);
      this.clearDurablePumpDriverState();
    }
  }

  private async maintainDisabledDurableJobs(): Promise<void> {
    const now = Date.now();
    this.maintainEncryptedWatchRetention(now);
    const { pastDeadline, expiredPublishing } = this.ctx.storage.transactionSync(() => {
      ensureDurableScanJobStore(this.ctx.storage.sql);
      this.purgeDurableScanJobState(now);
      const pastDeadline = listPastDeadlineDurableScanJobs(this.ctx.storage.sql, now);
      for (const snapshot of pastDeadline) {
        if (snapshot.state !== "publishing") {
          expireDurableScanJob(this.ctx.storage.sql, { jobId: snapshot.jobId, now });
        }
      }
      return {
        pastDeadline,
        expiredPublishing: listExpiredDurableScanJobLeases(this.ctx.storage.sql, now).filter(
          (snapshot) => snapshot.state === "publishing"
        )
      };
    });

    const candidates = new Map<string, DurableScanJobSnapshot>();
    for (const snapshot of [...expiredPublishing, ...pastDeadline]) {
      if (snapshot.state === "publishing") candidates.set(snapshot.jobId, snapshot);
    }
    for (const snapshot of candidates.values()) {
      if (now < this.durablePublicationSettlementAt(snapshot)) continue;
      const final = snapshot.deadlineAt <= now;
      const outcome = await this.reconcileExpiredDurablePublication(snapshot, now, final, true);
      if (outcome === "retryable" && final) {
        const expirationAt = Date.now();
        this.ctx.storage.transactionSync(() => {
          reconcileExpiredPublishingDurableScanJob(this.ctx.storage.sql, {
            jobId: snapshot.jobId,
            generation: snapshot.leaseGeneration,
            now: expirationAt,
            result: "expired"
          });
          this.clearDurableReconciliationBackoff(snapshot.jobId);
        });
      }
    }
  }

  private async maintainAndParkDisabledDurablePump(): Promise<void> {
    try {
      await this.maintainDisabledDurableJobs();
    } catch (error) {
      console.error("Could not complete disabled durable scan-job maintenance.", error);
    } finally {
      await this.parkDisabledDurablePumpWithRetry();
    }
  }

  private async parkDisabledDurablePumpWithRetry(): Promise<void> {
    try {
      await this.parkDisabledDurablePump();
      return;
    } catch (error) {
      // Containers consumes this one-shot callback even when it throws. Retry
      // one failed schedule write before yielding so a transient cannot make
      // retained ciphertext depend on a future public request.
      console.error("Could not park the durable scan-job pump; retrying once.", error);
    }
    try {
      await this.parkDisabledDurablePump();
    } catch (error) {
      console.error("Could not park the durable scan-job pump after retry.", error);
      try {
        await this.ensureDurablePumpFallbackSchedule();
      } catch (fallbackError) {
        console.error("Could not persist the durable scan-job fallback wake.", fallbackError);
        throw fallbackError;
      }
    }
  }

  private async rearmDurablePumpAfterCallback(): Promise<void> {
    try {
      await this.scheduleNextDurablePump();
      return;
    } catch (error) {
      // The invoking one-shot row was consumed at callback entry. Retry before
      // falling back to a raw persisted row so a transient scheduling failure
      // cannot strand accepted ciphertext before the normal pre-claim arm.
      console.error("Could not re-arm the durable scan-job pump; retrying once.", error);
    }
    try {
      await this.scheduleNextDurablePump();
    } catch (error) {
      console.error("Could not re-arm the durable scan-job pump after retry.", error);
      try {
        await this.ensureDurablePumpFallbackSchedule();
      } catch (fallbackError) {
        // If the alarm write failed after the fallback insert, Containers'
        // post-callback rescan still observes the persisted successor row.
        console.error("Could not persist the enabled durable scan-job fallback wake.", fallbackError);
      }
    }
  }

  private async ensureDurablePumpFallbackSchedule(): Promise<void> {
    this.persistImmediateDurablePumpFallbackSchedule();
    // No new task/alarm postponement: kick the persisted fallback row now.
    // If this alarm write fails, the successor row remains for the base
    // Container alarm's post-callback rescan.
    await this.scheduleNextAlarm(0);
  }

  private persistImmediateDurablePumpFallbackSchedule(): void {
    const taskId = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO container_schedules (id, callback, payload, type, time) VALUES (?, ?, NULL, 'scheduled', ?)",
        taskId,
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        Math.floor(Date.now() / 1_000) + 1
      );
      this.ctx.storage.sql.exec("DELETE FROM durable_scan_job_pump_driver WHERE singleton = 1");
      this.ctx.storage.sql.exec(
        "DELETE FROM container_schedules WHERE callback = ? AND id <> ?",
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        taskId
      );
    });
    // Track the payload-free fallback like the normal temporary epoch row so
    // precise/no-work recomputation removes it instead of preserving a 1 Hz
    // admission-style wake forever.
    this.durablePumpPrearmTaskId = taskId;
  }

  private isCurrentDurablePumpSchedule(payload: DurablePumpSchedulePayload): boolean {
    if (!payload || typeof payload.epoch !== "string" || !/^[0-9a-f-]{36}$/.test(payload.epoch)) return false;
    this.ensureDurablePumpDriverStore();
    const row = this.ctx.storage.sql
      .exec<{ epoch: string }>(
        "SELECT epoch FROM durable_scan_job_pump_driver WHERE singleton = 1 LIMIT 1"
      )
      .toArray()[0];
    return row?.epoch === payload.epoch;
  }

  private async prearmDurablePumpSuccessor(currentTaskId?: string): Promise<void> {
    this.ensureDurablePumpDriverStore();
    const epoch = crypto.randomUUID();
    const wire = JSON.stringify({ epoch } satisfies DurablePumpSchedulePayload);
    const taskId = await this.scheduleDurablePumpEpoch(1, epoch);

    this.ctx.storage.transactionSync(() => {
      const candidate = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM container_schedules WHERE id = ? AND callback = ? AND payload = ? LIMIT 1",
          taskId,
          DURABLE_SCAN_JOB_PUMP_CALLBACK,
          wire
        )
        .toArray()[0];
      if (!candidate) throw new Error("Durable pump successor disappeared before driver publication.");
      this.ctx.storage.sql.exec(
        "INSERT INTO durable_scan_job_pump_driver (singleton, epoch, task_id) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET epoch = excluded.epoch, task_id = excluded.task_id",
        epoch,
        taskId
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM container_schedules WHERE callback = ? AND payload IS NOT NULL AND id <> ?",
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        taskId
      );
      if (currentTaskId && currentTaskId !== taskId) {
        this.ctx.storage.sql.exec(
          "DELETE FROM container_schedules WHERE id = ? AND callback = ?",
          currentTaskId,
          DURABLE_SCAN_JOB_PUMP_CALLBACK
        );
      }
    });
    this.durablePumpPrearmTaskId = taskId;
  }

  private async scheduleDurablePumpEpoch(when: Date | number, epoch: string): Promise<string> {
    const wire = JSON.stringify({ epoch } satisfies DurablePumpSchedulePayload);
    try {
      return (await this.schedule<DurablePumpSchedulePayload>(when, DURABLE_SCAN_JOB_PUMP_CALLBACK, { epoch }))
        .taskId;
    } catch (error) {
      // Container.schedule() inserts before awaiting setAlarm. Adopt that exact
      // candidate when only the alarm write failed so repeated/interleaved
      // rearms cannot accumulate unowned epoch rows.
      const candidate = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM container_schedules WHERE callback = ? AND payload = ? LIMIT 1",
          DURABLE_SCAN_JOB_PUMP_CALLBACK,
          wire
        )
        .toArray()[0];
      if (!candidate) throw error;
      console.error("The durable pump successor alarm write failed; adopting its persisted row.", error);
      return candidate.id;
    }
  }

  private async persistParkedDurablePumpSchedule(wakeAt: number): Promise<void> {
    const taskId = crypto.randomUUID();
    const scheduleTime = Math.floor(wakeAt / 1_000);
    this.ctx.storage.transactionSync(() => {
      // Insert the replacement before removing older callback rows. Even if
      // the alarm write below fails, exactly one payload-free parked successor
      // remains for Containers' post-callback rescan; retries cannot accumulate
      // orphaned rows.
      this.ctx.storage.sql.exec(
        "INSERT INTO container_schedules (id, callback, payload, type, time) VALUES (?, ?, NULL, 'scheduled', ?)",
        taskId,
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        scheduleTime
      );
      this.ctx.storage.sql.exec("DELETE FROM durable_scan_job_pump_driver WHERE singleton = 1");
      this.ctx.storage.sql.exec(
        "DELETE FROM container_schedules WHERE callback = ? AND id <> ?",
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        taskId
      );
    });
    this.durablePumpPrearmTaskId = null;
    await this.scheduleNextAlarm();
  }

  private clearDurablePumpDriverState(): void {
    this.ctx.storage.sql.exec("DELETE FROM durable_scan_job_pump_driver WHERE singleton = 1");
    this.durablePumpPrearmTaskId = null;
  }

  private discardDurablePumpPrearmSchedule(): void {
    const taskId = this.durablePumpPrearmTaskId;
    if (!taskId) return;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM durable_scan_job_pump_driver WHERE singleton = 1 AND task_id = ?",
        taskId,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM container_schedules WHERE id = ? AND callback = ?",
        taskId,
        DURABLE_SCAN_JOB_PUMP_CALLBACK
      );
    });
    this.durablePumpPrearmTaskId = null;
  }

  private reconciliationIsDue(snapshot: DurableScanJobSnapshot, now: number): boolean {
    if (snapshot.state === "publishing" && now < this.durablePublicationSettlementAt(snapshot)) return false;
    this.ensureDurableReconciliationBackoffStore();
    const row = this.ctx.storage.sql
      .exec<{ generation: number; next_at: number }>(
        "SELECT generation, next_at FROM durable_scan_job_reconciliation_backoff WHERE job_id = ? LIMIT 1",
        snapshot.jobId
      )
      .toArray()[0];
    return !row || row.generation !== snapshot.leaseGeneration || row.next_at <= now || snapshot.deadlineAt <= now;
  }

  private durablePublicationSettlementAt(snapshot: DurableScanJobSnapshot): number {
    if (snapshot.state !== "publishing" || snapshot.leaseExpiresAt === null) {
      throw new Error("Invalid durable publication settlement snapshot.");
    }
    const settlementAt = Math.min(
      snapshot.leaseExpiresAt + DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS,
      snapshot.deadlineAt
    );
    if (!Number.isSafeInteger(settlementAt)) throw new Error("Invalid durable publication settlement timestamp.");
    return settlementAt;
  }

  private recordDurableReconciliationBackoff(snapshot: DurableScanJobSnapshot, now: number): void {
    this.ensureDurableReconciliationBackoffStore();
    const prior = this.ctx.storage.sql
      .exec<{ generation: number; attempt: number }>(
        "SELECT generation, attempt FROM durable_scan_job_reconciliation_backoff WHERE job_id = ? LIMIT 1",
        snapshot.jobId
      )
      .toArray()[0];
    const attempt = prior?.generation === snapshot.leaseGeneration ? prior.attempt + 1 : 1;
    const delay = attempt === 1 ? 5_000 : attempt === 2 ? 15_000 : 60_000;
    const nextAt = Math.min(now + delay, snapshot.deadlineAt);
    this.ctx.storage.sql.exec(
      "INSERT INTO durable_scan_job_reconciliation_backoff (job_id, generation, attempt, next_at) VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET generation = excluded.generation, attempt = excluded.attempt, next_at = excluded.next_at",
      snapshot.jobId,
      snapshot.leaseGeneration,
      attempt,
      nextAt
    );
  }

  private clearDurableReconciliationBackoff(jobId: string): void {
    this.ensureDurableReconciliationBackoffStore();
    this.ctx.storage.sql.exec("DELETE FROM durable_scan_job_reconciliation_backoff WHERE job_id = ?", jobId);
  }

  private pruneDurableReconciliationBackoff(): void {
    this.ensureDurableReconciliationBackoffStore();
    this.ctx.storage.sql.exec(
      "DELETE FROM durable_scan_job_reconciliation_backoff WHERE NOT EXISTS (SELECT 1 FROM durable_scan_jobs jobs WHERE jobs.job_id = durable_scan_job_reconciliation_backoff.job_id AND jobs.state = 'publishing' AND jobs.lease_generation = durable_scan_job_reconciliation_backoff.generation)"
    );
  }

  private recordEncryptedWatchTerminalOutcomeSafely(input: Parameters<typeof recordEncryptedWatchRunTerminalOutcome>[1]): void {
    try {
      recordEncryptedWatchRunTerminalOutcome(this.ctx.storage.sql, input);
    } catch {
      // Encrypted watches are optional. A damaged watch schema/history must not
      // roll back ordinary durable cancellation, resolution, or hard purging.
      console.error("Could not persist encrypted scheduled-rescan terminal history.");
    }
  }

  private syncEncryptedWatchTerminalHistorySafely(): void {
    try {
      ensureEncryptedWatchStore(this.ctx.storage.sql);
      const terminalRows = this.ctx.storage.sql
        .exec<{
          job_id: string;
          state: "succeeded" | "failed" | "expired" | "cancelled";
          terminal_reason: string | null;
          finished_at: number;
        }>(
          `SELECT jobs.job_id, jobs.state, jobs.terminal_reason, jobs.finished_at
           FROM durable_scan_jobs jobs
           INNER JOIN encrypted_watch_runs runs ON runs.job_id = jobs.job_id
           WHERE jobs.state IN ('succeeded','failed','expired','cancelled')
             AND runs.terminal_outcome IS NULL`
        )
        .toArray();
      for (const row of terminalRows) {
        this.recordEncryptedWatchTerminalOutcomeSafely({
          jobId: row.job_id,
          now: row.finished_at,
          resolution:
            row.state === "succeeded"
              ? { outcome: "succeeded" }
              : {
                  outcome: row.state,
                  errorCode: sanitizedWatchTerminalErrorCode(row.terminal_reason, row.state)
                }
        });
      }
    } catch {
      console.error("Could not synchronize encrypted scheduled-rescan terminal history.");
    }
  }

  private purgeDurableScanJobState(now: number): number {
    // Watch history must outlive the short durable-job tombstone. Copy terminal
    // truth before any row can cross its immutable purge horizon; the core
    // operation is replay-idempotent and a no-op for ordinary jobs.
    this.syncEncryptedWatchTerminalHistorySafely();
    const purged = purgeDurableScanJobs(this.ctx.storage.sql, now);
    // The backoff table has no foreign key because Durable Object SQLite
    // migrations must tolerate the pre-feature schema. Couple every purge to
    // explicit orphan pruning so disabled/status-only traffic cannot retain it.
    this.pruneDurableReconciliationBackoff();
    // Fault receipts inherit the authoritative job purge horizon. Couple their
    // cleanup to every normal maintenance pass so a completed canary cannot
    // leave staging-only rows behind until another fault-specific request.
    purgeDurableReplayFaults(this.ctx.storage.sql, now);
    pruneDurableContainerShardRoutes(this.ctx.storage.sql);
    return purged;
  }

  private durableEncryptionKey(): Promise<DurableScanJobEncryptionKey> {
    this.durableEncryptionKeyPromise ??= importDurableScanJobEncryptionKey(
      this.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY ?? ""
    );
    return this.durableEncryptionKeyPromise;
  }

  private encryptedWatchKeyring(): Promise<EncryptedWatchKeyring> {
    this.encryptedWatchKeyringPromise ??= importEncryptedWatchKeyring({
      current: this.env[ENCRYPTED_WATCH_ENCRYPTION_KEY_ENV] ?? "",
      ...(this.env[ENCRYPTED_WATCH_PREVIOUS_ENCRYPTION_KEY_ENV]
        ? { previous: this.env[ENCRYPTED_WATCH_PREVIOUS_ENCRYPTION_KEY_ENV] }
        : {})
    }).then((keyring) => {
      this.encryptedWatchKeysReady = true;
      return keyring;
    });
    return this.encryptedWatchKeyringPromise;
  }

  private rearmDurablePumpAfterCommittedMutation(context: string): void {
    this.ctx.waitUntil(
      this.scheduleNextDurablePump().catch((error) => {
        // The state transition is already committed and must keep its truthful
        // 2xx/409 result. Existing drivers remain valid when replacement fails.
        console.error(`Could not re-arm the durable scan-job pump after ${context}.`, error);
      })
    );
  }

  private encryptedWatchRollbackWakeAt(now: number): number | null {
    ensureEncryptedWatchStore(this.ctx.storage.sql);
    const row = this.ctx.storage.sql
      .exec<{ wake_at: number | null }>(
        `SELECT MIN(wake_at) AS wake_at FROM (
           SELECT lease_expires_at AS wake_at FROM encrypted_watches WHERE state = 'leased'
           UNION ALL SELECT expires_at AS wake_at FROM encrypted_watches
         )`
      )
      .toArray()[0];
    return row?.wake_at === null || row?.wake_at === undefined ? null : Math.max(now, row.wake_at);
  }

  private safeEncryptedWatchWakeAt(now: number, includeDue: boolean): number | null {
    try {
      return this.ctx.storage.transactionSync(() =>
        includeDue
          ? nextEncryptedWatchWakeAt(this.ctx.storage.sql, now)
          : this.encryptedWatchRollbackWakeAt(now)
      );
    } catch {
      // Ordinary durable jobs retain their own driver even if optional watch
      // state is malformed. Health reports watch drift for operator repair.
      console.error("Could not compute encrypted scheduled-rescan maintenance.");
      return null;
    }
  }

  private async scheduleNextDurablePump(minimumWakeAt?: number): Promise<void> {
    const now = Date.now();
    const { storeWakeAt, publishingWakeAt } = this.ctx.storage.transactionSync(() => {
      ensureDurableScanJobStore(this.ctx.storage.sql);
      this.ensureDurableReconciliationBackoffStore();
      // Hard/non-publishing work is classified separately so a publishing
      // backoff can never postpone an expired ordinary lease, deadline, queued
      // capacity wake, or immutable purge boundary.
      const store = this.ctx.storage.sql
        .exec<{ wake_at: number | null }>(
          `SELECT MIN(wake_at) AS wake_at FROM (
             SELECT ? AS wake_at FROM durable_scan_jobs
             WHERE state = 'queued' AND deadline_at > ? AND (
               SELECT COUNT(*) FROM durable_scan_jobs WHERE state IN ('leased','publishing')
             ) < ?
             UNION ALL SELECT lease_expires_at FROM durable_scan_jobs WHERE state = 'leased'
             UNION ALL SELECT deadline_at FROM durable_scan_jobs WHERE state IN ('queued','leased')
             UNION ALL SELECT purge_at FROM durable_scan_jobs
           )`,
          now,
          now,
          DURABLE_SCAN_JOB_EXECUTION_CAPACITY
        )
        .toArray()[0];
      // For each publishing row, a matching future backoff replaces its
      // already-due settlement wake. Stale-generation or elapsed backoff rows
      // are ignored, and the hard job deadline always wins.
      const publishing = this.ctx.storage.sql
        .exec<{ next_at: number | null }>(
          `SELECT MIN(
             CASE
               WHEN backoff.generation = jobs.lease_generation AND backoff.next_at > ?
                 THEN MIN(backoff.next_at, jobs.deadline_at)
               ELSE MIN(jobs.lease_expires_at + ?, jobs.deadline_at)
             END
           ) AS next_at
           FROM durable_scan_jobs jobs
           LEFT JOIN durable_scan_job_reconciliation_backoff backoff ON backoff.job_id = jobs.job_id
           WHERE jobs.state = 'publishing'`,
          now,
          DURABLE_SCAN_JOB_PUBLICATION_SETTLEMENT_MS
        )
        .toArray()[0];
      return {
        storeWakeAt: store?.wake_at ?? null,
        publishingWakeAt: publishing?.next_at ?? null
      };
    });
    const watchWakeAt = this.safeEncryptedWatchWakeAt(
      now,
      durableScanJobsEnabled(this.env) &&
        encryptedWatchesFlagState(this.env[ENCRYPTED_WATCHES_ENV]) === "enabled" &&
        this.encryptedWatchKeysReady
    );
    const wakeAt = chooseDurableScanJobPumpWakeAt({
      storeWakeAt: minimumTimestamp(storeWakeAt, watchWakeAt),
      publishingWakeAt,
      minimumWakeAt
    });
    this.ensureDurablePumpDriverStore();
    if (wakeAt === null) {
      const prearmTaskId = this.durablePumpPrearmTaskId;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("DELETE FROM durable_scan_job_pump_driver WHERE singleton = 1");
        // Preserve payload-free admission wakes that may have interleaved with
        // this computation; only epoch-owned driver schedules are superseded.
        this.ctx.storage.sql.exec(
          "DELETE FROM container_schedules WHERE callback = ? AND payload IS NOT NULL",
          DURABLE_SCAN_JOB_PUMP_CALLBACK
        );
        if (prearmTaskId) {
          this.ctx.storage.sql.exec(
            "DELETE FROM container_schedules WHERE id = ? AND callback = ?",
            prearmTaskId,
            DURABLE_SCAN_JOB_PUMP_CALLBACK
          );
        }
      });
      this.durablePumpPrearmTaskId = null;
      return;
    }
    const targetAt = Math.max(wakeAt, now + 1_000);
    const reusable = this.ctx.storage.sql
      .exec<{ id: string; time: number }>(
        `SELECT schedules.id AS id, schedules.time AS time
         FROM container_schedules schedules
         LEFT JOIN durable_scan_job_pump_driver driver ON driver.task_id = schedules.id
         WHERE schedules.callback = ? AND schedules.time * 1000 <= ? AND schedules.id <> ?
           AND (schedules.payload IS NULL OR driver.task_id = schedules.id)
         ORDER BY schedules.time ASC LIMIT 1`,
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        targetAt,
        this.durablePumpPrearmTaskId ?? ""
      )
      .toArray()[0];
    if (reusable) {
      this.discardDurablePumpPrearmSchedule();
      if (durablePumpReuseNeedsAlarmKick(reusable.time, Date.now())) await this.scheduleNextAlarm(0);
      return;
    }
    // Add before compacting: if schedule() fails the prior driver remains. The
    // returned task ID then lets one transaction publish the new epoch and
    // remove only older epoch-owned schedules. Payload-free admission wakes are
    // preserved, so an interleaved accepted job cannot lose its immediate pump.
    const epoch = crypto.randomUUID();
    const scheduledTaskId = await this.scheduleDurablePumpEpoch(new Date(targetAt), epoch);
    const prearmTaskId = this.durablePumpPrearmTaskId;
    const published = this.ctx.storage.transactionSync(() => {
      const task = this.ctx.storage.sql
        .exec<{ id: string }>(
          "SELECT id FROM container_schedules WHERE id = ? AND callback = ? AND payload IS NOT NULL LIMIT 1",
          scheduledTaskId,
          DURABLE_SCAN_JOB_PUMP_CALLBACK
        )
        .toArray()[0];
      // A concurrent swap may have already compacted this candidate. Never
      // publish an epoch that points at a deleted task; the winner remains the
      // valid driver and will safely wake no later than this recomputation.
      if (!task) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO durable_scan_job_pump_driver (singleton, epoch, task_id) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET epoch = excluded.epoch, task_id = excluded.task_id",
        epoch,
        scheduledTaskId
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM container_schedules WHERE callback = ? AND payload IS NOT NULL AND id <> ?",
        DURABLE_SCAN_JOB_PUMP_CALLBACK,
        scheduledTaskId
      );
      if (prearmTaskId && prearmTaskId !== scheduledTaskId) {
        this.ctx.storage.sql.exec(
          "DELETE FROM container_schedules WHERE id = ? AND callback = ?",
          prearmTaskId,
          DURABLE_SCAN_JOB_PUMP_CALLBACK
        );
      }
      return true;
    });
    if (published && this.durablePumpPrearmTaskId !== scheduledTaskId) {
      this.durablePumpPrearmTaskId = null;
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Node-private execution routes are never public, even if a caller tries to
    // smuggle the internal token header. Coordinator callbacks terminate here
    // and authenticate before any Durable Object mutation.
    if (isDurableScanJobNodePrivatePath(url.pathname)) {
      return privateRouteNotFound();
    }
    const coordinatorPath = parseDurableScanJobCoordinatorPath(url.pathname);
    if (coordinatorPath) {
      return handleDurableScanJobCoordinatorRequest(request, env, coordinatorPath);
    }
    if (
      url.pathname === DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX ||
      url.pathname.startsWith(`${DURABLE_SCAN_JOB_COORDINATOR_PATH_PREFIX}/`)
    ) {
      return privateRouteNotFound();
    }

    // A fault-enabled staging origin is gated as one unit, not merely at scan
    // and status routes. Reject untrusted health/report/asset traffic before
    // any getContainer call so outside requests cannot wake a past-due alarm
    // during the canary's deliberate no-request window. Private coordinator
    // callbacks were authenticated above and never use this public token.
    if (durableReplayFaultIngressIntent(env)) {
      if (durableReplayFaultConfig(env).status !== "ready") {
        return durableUnavailableResponse(request, env);
      }
      const expectedToken = env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim() ?? "";
      if (!(await scanAccessTokenMatches(request.headers, expectedToken))) {
        return gateErrorResponse(new EdgeScanGateError("Unauthorized staging request.", 401), request, env);
      }
    }

    const encryptedWatchPath = parseEncryptedWatchPublicPath(url.pathname);
    if (encryptedWatchPath) {
      if (url.search) {
        if (
          encryptedWatchPath.kind === "item" &&
          (request.method === "GET" || request.method === "DELETE")
        ) {
          return handleEncryptedWatchItem(request, env, null);
        }
        return encryptedWatchNotFoundResponse(request, env);
      }
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN)
        });
      }
      if (encryptedWatchPath.kind === "collection" && request.method === "POST") {
        return handleEncryptedWatchCreation(request, env);
      }
      if (
        encryptedWatchPath.kind === "item" &&
        (request.method === "GET" || request.method === "DELETE")
      ) {
        return handleEncryptedWatchItem(request, env, encryptedWatchPath.watchId);
      }
      return encryptedWatchNotFoundResponse(request, env);
    }

    // This origin is the scan API + report-page backend, not a front door. Send
    // anyone landing on its root to the public site so they never hit the
    // container's own scan form (which has no Turnstile site key for this host
    // and so cannot scan). /api/*, /reports/:id, /_next/* and the rest still
    // serve from the container, so shared report links keep working.
    if (request.method === "GET" && url.pathname === "/") {
      const frontDoor = frontDoorOrigin(env);
      if (frontDoor) {
        return Response.redirect(frontDoor, 302);
      }
    }

    // Health: the container's Node app has no Turnstile concept and cannot see
    // the front Worker's open-access/Turnstile config, so overlay the edge gate's
    // own view onto its response, otherwise the UI never shows the Turnstile
    // widget the gate then requires, and every public scan 400s.
    if (request.method === "GET" && url.pathname === "/api/health") {
      return patchHealthResponse(await forwardToContainer(request, env), env);
    }

    const isScan = request.method === "POST" && url.pathname === "/api/scan";
    if (
      isScan &&
      (durableScanJobsFlagMisconfigured(env) || durableReplayFaultConfig(env).status === "misconfigured")
    ) {
      return durableUnavailableResponse(request, env);
    }
    const scanJobId =
      request.method === "GET" || request.method === "DELETE" ? scanJobIdFromPath(url.pathname) : null;

    if (scanJobId) {
      // Existing Phase-2 rows remain authoritative through a flag rollback or
      // temporary misconfiguration. The flag gates new admission, not retained
      // status/cancellation truth; a genuine Phase-1 job still falls through.
      const durableResponse = await handleDurableScanJobRequest(request, env, scanJobId);
      if (durableResponse) return durableResponse;
      const response = await forwardToContainer(request, env);
      if (response.status !== 404) return response;
      return recoverRegisteredScanJob(request, env, scanJobId, response);
    }

    // Report reads and CORS preflight forward straight to the container.
    if (!isScan) {
      return forwardToContainer(request, env);
    }

    // Read the scan body once: the gate inspects it, then it is forwarded
    // verbatim. The size cap is enforced before buffering (declared length
    // short-circuits, chunked bodies stream through the cap), so a tokenless
    // caller cannot force a large allocation just by posting one.
    const body = await readRequestBodyWithinLimit(request, MAX_BODY_BYTES);
    if (body === null) {
      return gateErrorResponse(new EdgeScanGateError("The scan request is too large.", 413), request, env);
    }

    const durableAdmission = durableScanJobsEnabled(env);
    let deferredRateLimit: PublicScanRateLimitCharge | null;
    try {
      deferredRateLimit = await gateScanRequest(
        request,
        body,
        env,
        durableAdmission ? "defer" : "charge"
      );
    } catch (error) {
      return gateErrorResponse(error, request, env);
    }

    let replayFaultMode: DurableReplayFaultMode | null;
    try {
      replayFaultMode = await readStagingDurableReplayFaultRequest(request, env);
    } catch (error) {
      return gateErrorResponse(error, request, env);
    }
    const forwardedHeaders = new Headers(request.headers);
    // These credentials and controls are edge-only even on staging. Never let
    // them reach Node request logs, preparation code, or report material.
    forwardedHeaders.delete(DURABLE_REPLAY_FAULT_MODE_HEADER);
    forwardedHeaders.delete(DURABLE_REPLAY_FAULT_TOKEN_HEADER);
    const forwarded = new Request(request.url, { method: "POST", headers: forwardedHeaders, body });
    if (durableAdmission) {
      if (!deferredRateLimit) return durableUnavailableResponse(request, env);
      return submitDurableScanJob(forwarded, env, replayFaultMode, deferredRateLimit);
    }
    const response = await forwardToContainer(forwarded, env);
    ctx.waitUntil(
      recordAcceptedScanJob(
        response,
        body,
        (registration) => getContainer(env.SCANNER).registerScanJob(registration),
        (error) => console.error("Could not register an accepted scan job in Durable Object storage.", error)
      )
    );
    return response;
  }
} satisfies ExportedHandler<Env>;

type DurableScanJobConfig = {
  encryptionKey: string;
  internalToken: string;
  coordinatorUrl: string;
};

function durableScanJobsEnabled(env: Env): boolean {
  return durableScanJobsFlagState(env[DURABLE_SCAN_JOBS_ENV]) === "enabled";
}

function durableScanJobsFlagMisconfigured(env: Env): boolean {
  return durableScanJobsFlagState(env[DURABLE_SCAN_JOBS_ENV]) === "misconfigured";
}

function requireDurableScanJobConfig(env: Env): DurableScanJobConfig {
  if (!durableScanJobsEnabled(env)) throw new Error("Durable scan jobs are disabled.");
  const encryptionKey = env[DURABLE_SCAN_JOB_ENCRYPTION_KEY_ENV]?.trim() ?? "";
  const internalToken = requireDurableScanJobInternalToken(env);
  const coordinatorValue = env[DURABLE_SCAN_JOB_COORDINATOR_URL_ENV]?.trim() ?? "";
  if (
    !encryptionKey ||
    !durableScanJobSecretsAreDistinct(encryptionKey, internalToken) ||
    !durableScanJobKeyIsIsolated(encryptionKey, [
      internalToken,
      env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN ?? "",
      env.TURNSTILE_SECRET_KEY ?? "",
      env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID ?? "",
      env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY ?? ""
    ]) ||
    !durableScanJobKeyIsIsolated(internalToken, [
      env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN ?? "",
      env.TURNSTILE_SECRET_KEY ?? "",
      env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID ?? "",
      env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY ?? ""
    ])
  ) {
    throw new Error("Durable scan-job secrets are not configured.");
  }
  let coordinator: URL;
  try {
    coordinator = new URL(coordinatorValue);
  } catch {
    throw new Error("Durable scan-job coordinator URL is not configured.");
  }
  const localHttp =
    coordinator.protocol === "http:" &&
    (coordinator.hostname === "127.0.0.1" ||
      coordinator.hostname === "localhost" ||
      coordinator.hostname === "[::1]");
  if (
    (coordinator.protocol !== "https:" && !localHttp) ||
    coordinator.username ||
    coordinator.password ||
    coordinator.pathname !== "/" ||
    coordinator.search ||
    coordinator.hash
  ) {
    throw new Error("Durable scan-job coordinator URL must be an HTTPS origin.");
  }
  return { encryptionKey, internalToken, coordinatorUrl: coordinator.origin };
}

function requireDurableContainerShardingPlan(env: Env): DurableContainerShardingPlan {
  const plan = durableContainerShardingPlan({
    durableJobsFlag: env[DURABLE_SCAN_JOBS_ENV],
    durableJobsReady: true,
    shardingFlag: env[DURABLE_CONTAINER_SHARDING_ENV],
    shardCount: env[DURABLE_CONTAINER_SHARD_COUNT_ENV]
  });
  if (plan.readiness === "misconfigured" || plan.readiness === "blocked") {
    throw new Error(plan.reasons[0] ?? "Container sharding is not ready.");
  }
  return plan;
}

type EncryptedWatchConfig = Readonly<{ current: string; previous?: string }>;

function requireEncryptedWatchConfig(env: Env): EncryptedWatchConfig {
  if (encryptedWatchesFlagState(env[ENCRYPTED_WATCHES_ENV]) !== "enabled") {
    throw new Error("Encrypted watches are disabled.");
  }
  if (
    !encryptedWatchIngressIsTokenGated({
      accessToken: env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
      allowUnauthenticated: env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS,
      turnstileSecret: env.TURNSTILE_SECRET_KEY
    })
  ) {
    throw new Error("Encrypted watches require access-token-gated scanner ingress.");
  }
  const durable = requireDurableScanJobConfig(env);
  const current = env[ENCRYPTED_WATCH_ENCRYPTION_KEY_ENV] ?? "";
  const previous = env[ENCRYPTED_WATCH_PREVIOUS_ENCRYPTION_KEY_ENV];
  const sharedSecrets = [
    durable.encryptionKey,
    durable.internalToken,
    env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN ?? "",
    env.TURNSTILE_SECRET_KEY ?? "",
    env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID ?? "",
    env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY ?? ""
  ];
  if (
    !encryptedWatchKeyIsIsolated(current, [...sharedSecrets, previous ?? ""]) ||
    (previous !== undefined && !encryptedWatchKeyIsIsolated(previous, [...sharedSecrets, current]))
  ) {
    throw new Error("Encrypted-watch keys are not isolated.");
  }
  return { current, ...(previous !== undefined ? { previous } : {}) };
}

function requireDurableScanJobInternalToken(env: Env): string {
  const internalToken = env[DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV]?.trim() ?? "";
  if (internalToken.length < 32 || internalToken.length > 4_096 || /[\r\n]/.test(internalToken)) {
    throw new Error("Durable scan-job internal authentication is not configured.");
  }
  return internalToken;
}

async function readStagingDurableReplayFaultRequest(
  request: Request,
  env: Env
): Promise<DurableReplayFaultMode | null> {
  const mode = request.headers.get(DURABLE_REPLAY_FAULT_MODE_HEADER);
  const presentedToken = request.headers.get(DURABLE_REPLAY_FAULT_TOKEN_HEADER);
  if (mode === null && presentedToken === null) return null;

  const config = durableReplayFaultConfig(env);
  const expectedToken = env.SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN ?? "";
  if (
    config.status !== "ready" ||
    !DURABLE_REPLAY_FAULT_MODES.some((candidate) => candidate === mode) ||
    !presentedToken ||
    !(await constantTimeEqual(presentedToken, expectedToken))
  ) {
    throw new EdgeScanGateError("Invalid staging replay-fault authorization.", 401);
  }
  return mode as DurableReplayFaultMode;
}

async function submitDurableScanJob(
  request: Request,
  env: Env,
  replayFaultMode: DurableReplayFaultMode | null,
  rateLimit: PublicScanRateLimitCharge
): Promise<Response> {
  let config: DurableScanJobConfig;
  try {
    config = requireDurableScanJobConfig(env);
    // Validate the Worker-only key before asking Node to charge/prepare. The DO
    // repeats this import before encryption, but an invalid deployment must not
    // consume an admission charge it can never commit.
    await importDurableScanJobEncryptionKey(config.encryptionKey);
  } catch (error) {
    console.error("Durable scan-job admission is unavailable.", error);
    return durableUnavailableResponse(request, env);
  }

  let preparedResponse: Response;
  try {
    const prepareUrl = new URL(request.url);
    prepareUrl.pathname = `${DURABLE_SCAN_JOB_NODE_PATH_PREFIX}/prepare`;
    prepareUrl.search = "";
    preparedResponse = await forwardToContainer(
      new Request(prepareUrl, { method: "POST", headers: request.headers, body: request.body }),
      env,
      config.internalToken
    );
  } catch (error) {
    console.error("Could not prepare a durable scan job in Node.", error);
    return durableUnavailableResponse(request, env);
  }
  const publicHeaders = stripDurableScanJobInternalHeaders(preparedResponse.headers);
  publicHeaders.delete("content-length");
  for (const [name, value] of Object.entries(
    scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN)
  )) {
    publicHeaders.set(name, value);
  }
  if (preparedResponse.status === 404) {
    await preparedResponse.arrayBuffer().catch(() => undefined);
    return durableUnavailableResponse(request, env);
  }
  if (preparedResponse.status !== 202) {
    return new Response(preparedResponse.body, {
      status: preparedResponse.status,
      statusText: preparedResponse.statusText,
      headers: publicHeaders
    });
  }

  const preparation = readDurableScanJobPreparation(preparedResponse);
  // Consume the private response before the DO RPC; the public response below
  // is reconstructed exclusively from the strict DTO.
  await preparedResponse.arrayBuffer().catch(() => undefined);
  if (!preparation) {
    console.error("Node returned an invalid durable scan-job preparation header.");
    return durableUnavailableResponse(request, env);
  }

  let admissionError: unknown;
  const admission = await finalizeDurableScanJobAdmission(
    preparation,
    async (value) => {
      const result = await getContainer(env.SCANNER).admitDurablePreparation(
        value,
        replayFaultMode,
        rateLimit
      );
      // Expected full/collision control flow crossed RPC as a plain envelope;
      // throw only here, in the edge isolate, so exact readback can still
      // recover a response-lost idempotent commit without resetting the DO.
      if (result.status === "rate-limited") {
        throw new DurableScanJobRateLimitError(rateLimit.scope, result.retryAfterSeconds);
      }
      if (result.status === "refused") {
        throw new DurableScanJobRefusedError();
      }
      if (!durableScanJobAdmissionProofMatches(result.snapshot, value)) {
        throw new DurableScanJobCapacityError();
      }
      return result.snapshot;
    },
    (error) => {
      admissionError = error;
      if (
        !(error instanceof DurableScanJobCapacityError) &&
        !(error instanceof DurableScanJobRefusedError) &&
        !(error instanceof DurableScanJobRateLimitError)
      ) {
        console.error("Could not commit durable scan-job admission.", error);
      }
    },
    async (value) => {
      const snapshot = await getContainer(env.SCANNER).findDurableJob(value.submission.jobId);
      return durableScanJobAdmissionProofMatches(snapshot, value);
    },
    (error, attempt) =>
      error instanceof DurableScanJobRateLimitError ||
      (attempt === 1 && error instanceof DurableScanJobRefusedError)
  );
  if (!admission.accepted) {
    if (admissionError instanceof DurableScanJobRateLimitError) {
      return gateErrorResponse(admissionError, request, env);
    }
    // No store/schedule failure detail and no private header reaches the caller.
    return durableUnavailableResponse(request, env);
  }

  publicHeaders.set("content-type", "application/json; charset=utf-8");
  publicHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(admission.submission), { status: admission.status, headers: publicHeaders });
}

async function handleEncryptedWatchCreation(request: Request, env: Env): Promise<Response> {
  const capabilityToken = request.headers.get(ENCRYPTED_WATCH_CAPABILITY_HEADER) ?? "";
  let edgeCredential: Awaited<ReturnType<typeof createEncryptedWatchCredentialFromToken>>;
  try {
    edgeCredential = await createEncryptedWatchCredentialFromToken(capabilityToken);
  } catch {
    return gateErrorResponse(
      new EdgeScanGateError("A canonical scheduled-rescan creation capability is required.", 400),
      request,
      env
    );
  }
  // A valid capability may still recover an existing record during rollback,
  // but an enabled watch deployment must never expose its coordinator-wide
  // capacity through the ordinary open/Turnstile scan path.
  if (
    encryptedWatchesFlagState(env[ENCRYPTED_WATCHES_ENV]) === "enabled" &&
    !encryptedWatchIngressIsTokenGated({
      accessToken: env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
      allowUnauthenticated: env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS,
      turnstileSecret: env.TURNSTILE_SECRET_KEY
    })
  ) {
    return encryptedWatchUnavailableResponse(request, env);
  }
  const scanner = getContainer(env.SCANNER);
  try {
    const clientHash = await publicClientHash(request.headers);
    const charge = await scanner.chargeEncryptedWatchReadRateLimit({ clientHash });
    if (!charge.allowed) {
      return gateErrorResponse(
        new EdgeScanGateError("Too many scheduled-rescan status requests. Try again shortly.", 429),
        request,
        env
      );
    }
    const existing = await scanner.findEncryptedWatch(edgeCredential.watchId, edgeCredential.tokenHash);
    if (existing) {
      return encryptedWatchJsonResponse(
        publicEncryptedWatchSnapshot(existing, capabilityToken),
        201,
        request,
        env
      );
    }
  } catch {
    return encryptedWatchUnavailableResponse(request, env);
  }

  const body = await readRequestBodyWithinLimit(request, MAX_BODY_BYTES);
  if (body === null) {
    return gateErrorResponse(new EdgeScanGateError("The scheduled-rescan request is too large.", 413), request, env);
  }
  let creation: unknown;
  try {
    creation = JSON.parse(body);
  } catch {
    creation = null;
  }
  if (!isEncryptedWatchCreationBody(creation)) {
    return gateErrorResponse(
      new EdgeScanGateError("Scheduled rescans require one URL, device, and GPC setting with no comparisons.", 400),
      request,
      env
    );
  }
  const requestedPayload: EncryptedWatchPayload = {
    version: 1,
    target: { url: creation.url },
    options: {
      device: creation.device,
      gpcEnabled: creation.gpcEnabled,
      reportMode: "r2",
      comparison: "none"
    }
  };

  let rateLimit: PublicScanRateLimitCharge | null;
  try {
    rateLimit = await gateScanRequest(request, body, env, "defer");
  } catch (error) {
    return gateErrorResponse(error, request, env);
  }
  if (!rateLimit || rateLimit.cost !== 1) return encryptedWatchUnavailableResponse(request, env);

  // Import long-lived Worker-only keys only after access, human challenge, and
  // quota preflight. Tokenless traffic must not reach WebCrypto/config work.
  let config: DurableScanJobConfig;
  try {
    config = requireDurableScanJobConfig(env);
    const watchConfig = requireEncryptedWatchConfig(env);
    await Promise.all([
      importDurableScanJobEncryptionKey(config.encryptionKey),
      importEncryptedWatchKeyring(watchConfig)
    ]);
  } catch {
    return encryptedWatchUnavailableResponse(request, env);
  }

  let preparedResponse: Response;
  try {
    const prepareUrl = new URL(request.url);
    prepareUrl.pathname = `${DURABLE_SCAN_JOB_NODE_PATH_PREFIX}/prepare-watch`;
    prepareUrl.search = "";
    preparedResponse = await forwardToContainer(
      new Request(prepareUrl, {
        method: "POST",
        // Access, Turnstile, capability, forwarding, and declared-length
        // headers terminate at the edge. The private Node boundary receives
        // only this content type plus the server-injected internal token.
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(requestedPayload)
      }),
      env,
      config.internalToken
    );
  } catch {
    return encryptedWatchUnavailableResponse(request, env);
  }
  const preparation = readDurableScanJobPreparation(preparedResponse);
  const payload = preparation ? encryptedWatchPayloadFromPreparation(preparation) : null;
  const nodeStatus = preparedResponse.status;
  const nodeBody = await preparedResponse.arrayBuffer().catch(() => new ArrayBuffer(0));
  if (
    nodeStatus !== 202 ||
    !preparation ||
    !payload ||
    JSON.stringify(payload) !== JSON.stringify(requestedPayload)
  ) {
    // Public validation errors from the same Node gate remain useful, but the
    // private preparation header and internal credential never cross back.
    if (nodeStatus >= 400 && nodeStatus < 500) {
      const headers = new Headers({
        ...scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN),
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      return new Response(nodeBody, { status: nodeStatus, headers });
    }
    return encryptedWatchUnavailableResponse(request, env);
  }

  let result: EncryptedWatchAdmissionResult;
  try {
    result = await scanner.admitEncryptedWatchPreparation(
      preparation,
      payload,
      rateLimit,
      capabilityToken
    );
  } catch {
    // The caller already holds the exact capability material. Recover a lost
    // RPC response only from an exact authoritative watch/job linkage; unlike
    // minting solely inside the DO, a committed watch can never become an
    // inaccessible 30-day orphan merely because the response was lost.
    try {
      const recovered = await scanner.findEncryptedWatch(edgeCredential.watchId, edgeCredential.tokenHash);
      if (!recovered) {
        return encryptedWatchUnavailableResponse(request, env);
      }
      return encryptedWatchJsonResponse(
        publicEncryptedWatchSnapshot(recovered, edgeCredential.token),
        201,
        request,
        env
      );
    } catch {
      return encryptedWatchUnavailableResponse(request, env);
    }
  }
  if (result.status === "rate-limited") {
    try {
      const existing = await scanner.findEncryptedWatch(edgeCredential.watchId, edgeCredential.tokenHash);
      if (existing) {
        return encryptedWatchJsonResponse(
          publicEncryptedWatchSnapshot(existing, capabilityToken),
          201,
          request,
          env
        );
      }
    } catch {
      // Preserve the authoritative quota result when no exact recovery exists.
    }
    return gateErrorResponse(new DurableScanJobRateLimitError(rateLimit.scope, result.retryAfterSeconds), request, env);
  }
  if (result.status === "refused") {
    try {
      const existing = await scanner.findEncryptedWatch(edgeCredential.watchId, edgeCredential.tokenHash);
      if (existing) {
        return encryptedWatchJsonResponse(
          publicEncryptedWatchSnapshot(existing, capabilityToken),
          201,
          request,
          env
        );
      }
    } catch {
      // Fall through to the same generic refusal below.
    }
    return encryptedWatchUnavailableResponse(request, env);
  }
  if (
    result.capability !== edgeCredential.token ||
    !encryptedWatchAdmissionProofMatches(result.snapshot, preparation, edgeCredential.watchId)
  ) {
    return encryptedWatchUnavailableResponse(request, env);
  }
  return encryptedWatchJsonResponse(
    publicEncryptedWatchSnapshot(result.snapshot, edgeCredential.token),
    201,
    request,
    env
  );
}

function encryptedWatchAdmissionProofMatches(
  snapshot: EncryptedWatchSnapshot | null,
  preparation: DurableScanJobPreparation,
  watchId: string
): snapshot is EncryptedWatchSnapshot {
  if (
    !snapshot ||
    snapshot.watchId !== watchId ||
    snapshot.createdAt !== preparation.payload.admittedAt ||
    snapshot.runCount < 1
  ) {
    return false;
  }
  const initial = snapshot.history[0];
  return Boolean(
    initial &&
      initial.runNumber === 1 &&
      initial.outcome === "admitted" &&
      initial.jobId === preparation.submission.jobId &&
      initial.reportId === preparation.submission.reportId &&
      initial.admittedAt === preparation.payload.admittedAt
  );
}

async function handleEncryptedWatchItem(
  request: Request,
  env: Env,
  watchId: string | null
): Promise<Response> {
  let charge: PublicScanRateLimitResult;
  try {
    const clientHash = await publicClientHash(request.headers);
    charge = await getContainer(env.SCANNER).chargeEncryptedWatchReadRateLimit({ clientHash });
  } catch {
    return encryptedWatchUnavailableResponse(request, env);
  }
  if (!charge.allowed) {
    return gateErrorResponse(
      new EdgeScanGateError("Too many scheduled-rescan status requests. Try again shortly.", 429),
      request,
      env
    );
  }

  const token = request.headers.get(ENCRYPTED_WATCH_CAPABILITY_HEADER) ?? "";
  let capabilityHash: ArrayBuffer;
  try {
    capabilityHash = await hashEncryptedWatchCapabilityToken(token);
  } catch {
    return encryptedWatchNotFoundResponse(request, env);
  }
  if (!watchId) return encryptedWatchNotFoundResponse(request, env);

  try {
    if (request.method === "DELETE") {
      // A well-formed request is an idempotent capability-shaped delete. Ignore
      // whether an exact row/hash matched so missing rows and wrong canonical
      // tokens cannot become an existence oracle; the store deletes only on an
      // exact constant-time capability match.
      await getContainer(env.SCANNER).deleteEncryptedWatch(watchId, capabilityHash);
      return encryptedWatchJsonResponse({ ok: true, watchId, state: "deleted" }, 200, request, env);
    }
    const snapshot = await getContainer(env.SCANNER).findEncryptedWatch(watchId, capabilityHash);
    if (!snapshot) return encryptedWatchNotFoundResponse(request, env);
    return encryptedWatchJsonResponse(publicEncryptedWatchSnapshot(snapshot), 200, request, env);
  } catch {
    return encryptedWatchUnavailableResponse(request, env);
  }
}

function publicEncryptedWatchSnapshot(snapshot: EncryptedWatchSnapshot, capability?: string): Record<string, unknown> {
  return {
    ok: true,
    watchId: snapshot.watchId,
    ...(capability ? { capability } : {}),
    statusPath: `/api/watches/${snapshot.watchId}`,
    state: snapshot.state,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    nextRunAt: snapshot.nextRunAt,
    attemptCount: snapshot.runCount,
    maxAttempts: snapshot.maxRuns,
    runs: snapshot.history.map((run) => ({
      sequence: run.runNumber,
      admittedAt: run.admittedAt,
      jobId: run.jobId,
      statusPath: run.jobId ? `/api/scans/${run.jobId}` : null,
      reportId: run.reportId,
      status: run.terminalOutcome ?? (run.outcome === "admitted" ? "queued" : "failed"),
      errorCode: run.terminalErrorCode ?? (run.outcome === "failed" ? "admission-failed" : null)
    }))
  };
}

function encryptedWatchJsonResponse(
  value: unknown,
  status: number,
  request: Request,
  env: Env
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function encryptedWatchNotFoundResponse(request: Request, env: Env): Response {
  return encryptedWatchJsonResponse({ ok: false, error: "Scheduled rescan not found." }, 404, request, env);
}

function encryptedWatchUnavailableResponse(request: Request, env: Env): Response {
  return encryptedWatchJsonResponse(
    { ok: false, error: "Scheduled rescans are temporarily unavailable." },
    503,
    request,
    env
  );
}

async function handleDurableScanJobRequest(
  request: Request,
  env: Env,
  jobId: string
): Promise<Response | null> {
  // Sample before authentication/rate-limit RPCs can wake the singleton. The
  // staging canary uses only a derived boolean to prove terminalization
  // preceded the very first status request; no internal timestamp is exposed.
  const statusRequestStartedAt = Date.now();
  // Authenticate and bound capability probes before even a read-only DO RPC;
  // otherwise guessed IDs become an existence oracle and unbounded work source.
  const accessFailure = await gateDurableScanJobControlRequest(request, env);
  if (accessFailure) return accessFailure;
  const scanner = getContainer(env.SCANNER);
  let snapshot: DurableScanJobSnapshot | null;
  try {
    snapshot = await scanner.findDurableJob(jobId);
  } catch (error) {
    console.error("Could not read authoritative durable scan-job status.", error);
    return durableUnavailableResponse(request, env);
  }
  // Compatibility for jobs admitted immediately before the Phase-2 flag was
  // enabled: fall through to the unchanged process/Phase-1 recovery path.
  if (!snapshot) return null;
  const source = new Response(null, {
    headers: {
      ...scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN),
      "cache-control": "no-store"
    }
  });

  if (request.method === "DELETE") {
    try {
      const cancelled = await scanner.cancelDurableJob(jobId);
      if (cancelled.status === "conflict") return publicJobConflictResponse(request, env);
      return durableScanJobCancellationResponse(cancelled.snapshot, source);
    } catch (error) {
      console.error("Could not cancel an authoritative durable scan job.", error);
      return durableUnavailableResponse(request, env);
    }
  }

  let stagingFault: DurableReplayFault | null = null;
  if (durableReplayFaultConfig(env).status === "ready") {
    try {
      stagingFault = await scanner.findStagingDurableReplayFault(jobId);
    } catch (error) {
      console.error("Could not read staging durable replay evidence.", error);
      return durableUnavailableResponse(request, env);
    }
  }

  return recoverDurableScanJobSnapshotResponse(snapshot, source, {
    fetchReport: (reportId) => {
      const reportUrl = new URL(request.url);
      reportUrl.pathname = `/api/reports/${reportId}`;
      reportUrl.search = "";
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      return forwardToContainer(new Request(reportUrl, { method: "GET", headers }), env);
    },
    onReportError: (error) => console.error("Could not read a durable scan-job report.", error),
    ...(stagingFault
      ? {
          stagingFaultEvidence: {
            faultMode: stagingFault.mode,
            attempts: snapshot.attemptCount,
            triggered: stagingFault.triggeredAt !== null,
            triggeredGeneration: stagingFault.triggeredGeneration,
            finishedBeforeStatusRequest:
              snapshot.finishedAt !== null && snapshot.finishedAt < statusRequestStartedAt
          }
        }
      : {})
  });
}

async function gateDurableScanJobControlRequest(request: Request, env: Env): Promise<Response | null> {
  const expectedToken = env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim();
  if (expectedToken && !(await scanAccessTokenMatches(request.headers, expectedToken))) {
    return gateErrorResponse(new EdgeScanGateError("Unauthorized scan request.", 401), request, env);
  }
  try {
    const charge = await getContainer(env.SCANNER).chargeDurableJobReadRateLimit({
      clientHash: await publicClientHash(request.headers)
    });
    if (!charge.allowed) {
      return gateErrorResponse(
        new EdgeScanGateError(
          `Too many report requests. Try again in about ${formatPublicScanRetryAfter(charge.retryAfterSeconds)}.`,
          429
        ),
        request,
        env
      );
    }
    return null;
  } catch (error) {
    console.error("Could not charge the durable scan-job status read limit.", error);
    return durableUnavailableResponse(request, env);
  }
}

async function handleDurableScanJobCoordinatorRequest(
  request: Request,
  env: Env,
  path: { jobId: string; action: "heartbeat" | "begin-publishing" | "resolve" }
): Promise<Response> {
  if (request.method !== "POST" || new URL(request.url).search) return privateRouteNotFound();
  let config: DurableScanJobConfig;
  try {
    config = requireDurableScanJobConfig(env);
  } catch {
    return privateRouteNotFound();
  }
  const presented = request.headers.get(DURABLE_SCAN_JOB_INTERNAL_HEADER)?.trim() ?? "";
  if (!presented || !(await constantTimeEqual(presented, config.internalToken))) return privateRouteNotFound();

  const wire = await readRequestBodyWithinLimit(request, MAX_COORDINATOR_BODY_BYTES);
  if (wire === null) return privateControlResponse(400);
  let body: unknown;
  try {
    body = JSON.parse(wire);
  } catch {
    return privateControlResponse(400);
  }
  const owner = durableCoordinatorOwner(body);
  if (!owner || owner.jobId !== path.jobId) return privateControlResponse(400);

  try {
    const scanner = getContainer(env.SCANNER);
    if (path.action === "heartbeat") {
      if (!recordHasExactKeys(body, ["jobId", "generation", "leaseToken"])) return privateControlResponse(400);
      const result = await scanner.heartbeatDurableJob(owner);
      if (result.status === "conflict") return privateControlResponse(409);
    } else if (path.action === "begin-publishing") {
      if (!recordHasExactKeys(body, ["jobId", "generation", "leaseToken", "manifest"])) {
        return privateControlResponse(400);
      }
      const result = await scanner.beginPublishingDurableJob(owner, (body as Record<string, unknown>).manifest);
      if (result.status === "conflict") return privateControlResponse(409);
    } else {
      if (!isDurableResolutionBody(body)) return privateControlResponse(400);
      if (body.outcome === "succeeded") {
        const dropped = await scanner.dropStagingLostResolveFault(owner);
        if (dropped) {
          if (dropped.firstTrigger) {
            console.log(
              JSON.stringify({
                event: "durable-replay-fault-triggered",
                mode: dropped.fault.mode,
                jobId: dropped.fault.jobId,
                generation: dropped.fault.triggeredGeneration
              })
            );
          }
          // Acknowledge Node's already-committed report while deliberately not
          // resolving the DO row. Drop retries from the same fenced owner too;
          // scheduled exact-bundle reconciliation must be the only path that
          // recovers this publishing generation without another site visit.
          return privateControlResponse(204);
        }
      }
      const result = await scanner.resolveDurableJob(owner, { outcome: body.outcome });
      if (result.status === "conflict") return privateControlResponse(409);
    }
    return privateControlResponse(204);
  } catch (error) {
    console.error("Durable scan-job coordinator mutation failed.", error);
    return privateControlResponse(503);
  }
}

function durableCoordinatorOwner(value: unknown): DurableScanJobExecutionOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const owner = { jobId: record.jobId, generation: record.generation, leaseToken: record.leaseToken };
  return isDurableScanJobExecutionOwner(owner) ? owner : null;
}

function isDurableResolutionBody(
  value: unknown
): value is DurableScanJobExecutionOwner & { outcome: "succeeded" | "failed" | "cancelled"; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "cancelled") return false;
  const expected = outcome === "succeeded" ? ["jobId", "generation", "leaseToken", "outcome"] : ["jobId", "generation", "leaseToken", "outcome", "error"];
  return (
    recordHasExactKeys(record, expected) &&
    (outcome === "succeeded" || (typeof record.error === "string" && record.error.length <= 2_048))
  );
}

function recordHasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function durableReconciliationOutcome(
  value: unknown,
  snapshot: DurableScanJobSnapshot
): "succeeded" | "missing" | "integrity-error" | "retryable" {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "retryable";
  const record = value as Record<string, unknown>;
  if (
    record.jobId !== snapshot.jobId ||
    record.reportId !== snapshot.reportId ||
    record.generation !== snapshot.leaseGeneration
  ) {
    return "retryable";
  }
  if (
    record.ok === true &&
    (record.outcome === "succeeded" || record.outcome === "missing") &&
    recordHasExactKeys(record, ["ok", "jobId", "reportId", "generation", "outcome"])
  ) {
    return record.outcome;
  }
  if (
    record.ok === false &&
    (record.outcome === "integrity-error" || record.outcome === "retryable") &&
    typeof record.error === "string" &&
    recordHasExactKeys(record, ["ok", "jobId", "reportId", "generation", "outcome", "error"])
  ) {
    return record.outcome;
  }
  return "retryable";
}

function privateRouteNotFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

function privateControlResponse(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function durableUnavailableResponse(request: Request, env: Env): Response {
  return new Response(JSON.stringify({ ok: false, error: "Durable scan jobs are temporarily unavailable." }), {
    status: 503,
    headers: {
      ...scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function publicJobConflictResponse(request: Request, env: Env): Response {
  return new Response(
    JSON.stringify({ ok: false, error: "This scan job has already finished and cannot be cancelled." }),
    {
      status: 409,
      headers: {
        ...scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN),
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}

async function recoverRegisteredScanJob(
  request: Request,
  env: Env,
  jobId: string,
  missingJobResponse: Response
): Promise<Response> {
  const findRegistration = (id: string) => getContainer(env.SCANNER).findRegisteredScanJob(id);
  const onRegistryError = (error: unknown) => console.error("Could not read the durable scan-job registry.", error);

  if (request.method === "DELETE") {
    return recoverDurableScanJobCancellationResponse(jobId, missingJobResponse, {
      findRegistration,
      onRegistryError
    });
  }

  return recoverDurableScanJobResponse(jobId, missingJobResponse, {
    findRegistration,
    fetchReport: (reportId) => {
      const reportUrl = new URL(request.url);
      reportUrl.pathname = `/api/reports/${reportId}`;
      reportUrl.search = "";
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.delete("content-type");
      return forwardToContainer(new Request(reportUrl, { method: "GET", headers }), env);
    },
    onRegistryError,
    onReportError: (error) => console.error("Could not probe a saved report during scan-job recovery.", error)
  });
}

function forwardToContainer(request: Request, env: Env, trustedInternalToken?: string): Promise<Response> {
  // The container trusts x-real-ip for per-client rate limiting
  // (SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS=1). This Worker is the only ingress, so
  // strip any client-supplied forwarding headers (anti-spoof) and set x-real-ip
  // from Cloudflare's cf-connecting-ip. Without this, report/status reads and the
  // container's own scan limiter collapse to one shared bucket for all clients.
  const headers = stripDurableScanJobInternalHeaders(request.headers);
  // Staging fault controls are edge-only credentials. Strip them centrally on
  // every route so they can never reach Node health, report, asset, or fallback
  // handlers even if a caller supplies them outside POST /api/scan.
  headers.delete(DURABLE_REPLAY_FAULT_MODE_HEADER);
  headers.delete(DURABLE_REPLAY_FAULT_TOKEN_HEADER);
  // Accountless watch credentials terminate at the edge and must never appear
  // in Node request logs, report material, assets, or fallback routes.
  headers.delete(ENCRYPTED_WATCH_CAPABILITY_HEADER);
  headers.delete("x-real-ip");
  headers.delete("x-forwarded-for");
  const clientIp = request.headers.get("cf-connecting-ip")?.trim();
  if (clientIp) headers.set("x-real-ip", clientIp);
  if (trustedInternalToken) headers.set(DURABLE_SCAN_JOB_INTERNAL_HEADER, trustedInternalToken);

  // One warm singleton instance keeps the scanner's in-memory async job queue
  // coherent (a client polls /api/scans/:id on the same instance). Shard on a
  // key here once a single instance is not enough.
  return getContainer(env.SCANNER).fetch(new Request(request, { headers }));
}

/** Public front-door origin to redirect the backend root to, from the configured allow-list origin. */
function frontDoorOrigin(env: Env): string | null {
  const origin = env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN?.trim();
  if (!origin || origin === "*") return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

/** Overlay the front Worker's gate decision (auth / open access / Turnstile) onto the container health. */
async function patchHealthResponse(response: Response, env: Env): Promise<Response> {
  const text = await response.text();
  let body = text;

  try {
    const health = JSON.parse(text) as Record<string, unknown>;
    if (health && typeof health === "object") {
      const gate = publicScanGateStatus({
        accessToken: env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
        allowUnauthenticated: env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS,
        turnstileSecret: env.TURNSTILE_SECRET_KEY
      });
      health.authenticated = gate.authenticated;
      health.openAccess = gate.openAccess;
      health.turnstile = gate.turnstile;
      // A configuration that refuses EVERY scan must never present as a green
      // scanner: surface the exact fail-closed reasons and degrade the status.
      const refusals = publicScanRefusalReasons({
        accessToken: env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
        allowUnauthenticated: env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS,
        turnstileSecret: env.TURNSTILE_SECRET_KEY,
        acceptNoTurnstileRisk: env.SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK,
        // The SCANNER binding is required by this Worker and owns an atomic
        // SQLite quota ledger, so an external KV binding is no longer needed.
        rateLimitStoreBound: true
      });
      health.scansAvailable = scansAvailableAfterEdgeOverlay(health.scansAvailable, refusals);
      health.checks = withPublicScanAccessCheck(health.checks, gate, refusals);
      const durableJobs = await durableJobsEdgeHealthCheck(health.checks, env);
      let encryptedWatches = await encryptedWatchesEdgeHealthCheck(
        health.checks,
        durableJobs.check,
        env
      );
      if (encryptedWatches.check.readiness === "ready") {
        const schedulerReady = await getContainer(env.SCANNER).ensureEncryptedWatchPumpWake();
        if (!schedulerReady) {
          const reasons = ["The encrypted-watch scheduler could not persist its activation wake."];
          encryptedWatches = {
            check: { requested: true, enabled: false, readiness: "misconfigured", reasons },
            reasons
          };
        }
      }
      health.checks = {
        ...(typeof health.checks === "object" && health.checks ? health.checks : {}),
        durableJobs: durableJobs.check,
        encryptedWatches: encryptedWatches.check
      };
      health.capabilities = {
        ...(typeof health.capabilities === "object" && health.capabilities ? health.capabilities : {}),
        scheduledRescans: encryptedWatches.check.readiness === "ready"
      };
      if (refusals.length > 0) {
        health.status = "degraded";
        health.warnings = [...(Array.isArray(health.warnings) ? health.warnings : []), ...refusals];
      }
      if (durableJobs.check.readiness === "misconfigured") {
        health.status = "degraded";
        health.scansAvailable = false;
        health.warnings = [
          ...(Array.isArray(health.warnings) ? health.warnings : []),
          ...durableJobs.reasons
        ];
      }
      if (encryptedWatches.check.readiness === "misconfigured") {
        // Watches are an isolated optional capability. Surface their drift but
        // never make ordinary scans unavailable because a watch key is wrong.
        health.status = "degraded";
        health.warnings = [
          ...(Array.isArray(health.warnings) ? health.warnings : []),
          ...encryptedWatches.reasons
        ];
      }
      health.limits = {
        ...(typeof health.limits === "object" && health.limits ? health.limits : {}),
        publicScanRateLimitPerMinute: publicScanRateLimit(
          env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE,
          DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE
        ),
        publicScanRateLimitPerDay: publicScanRateLimit(
          env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY,
          DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY
        )
      };
      body = JSON.stringify(health);
    }
  } catch {
    // Non-JSON health (e.g. an error page) passes through untouched.
  }

  // Preserve the container's headers (CORS, content-type); drop the now-stale length.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}

export async function durableJobsEdgeHealthCheck(
  checks: unknown,
  env: Pick<
    Env,
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS"
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY"
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN"
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL"
    | "SITE_BEHAVIOR_LAB_CONTAINER_SHARDING"
    | "SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT"
    | "SITE_BEHAVIOR_LAB_DEPLOYMENT_ENVIRONMENT"
    | "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULTS"
    | "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN"
    | "SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS"
    | "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN"
    | "TURNSTILE_SECRET_KEY"
    | "SITE_BEHAVIOR_LAB_R2_BUCKET"
    | "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID"
    | "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY"
  >
): Promise<{
  check: {
    requested: boolean;
    enabled: boolean;
    readiness: "disabled" | "ready" | "misconfigured";
    coordinatorOrigin?: string;
    faultInjection?: {
      environment: "staging";
      enabled: true;
      modes: DurableReplayFaultMode[];
      modeHeaderName: string;
      tokenHeaderName: string;
      minimumNoPollMs: number;
      attemptEvidence: true;
      completionBeforeStatusRequestEvidence: true;
      wholeOriginAccessGate: true;
    };
    reasons?: string[];
    containerSharding: {
      requested: boolean;
      enabled: boolean;
      readiness: "disabled" | "blocked" | "ready" | "misconfigured";
      shardCount: number;
      reasons?: string[];
    };
  };
  reasons: string[];
}> {
  const flag = durableScanJobsFlagState(env.SITE_BEHAVIOR_LAB_DURABLE_JOBS);
  const node = durableScanJobNodeHealthState(checks);
  const replayFault = durableReplayFaultConfig(env as Env);
  if (flag === "disabled") {
    const sharding = durableContainerShardingPlan({
      durableJobsFlag: env.SITE_BEHAVIOR_LAB_DURABLE_JOBS,
      durableJobsReady: false,
      shardingFlag: env.SITE_BEHAVIOR_LAB_CONTAINER_SHARDING,
      shardCount: env.SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT
    });
    const reasons: string[] = [];
    if (node.requested) {
      reasons.push("Durable scan jobs are enabled in the Node scanner but disabled at the edge.");
    }
    if (replayFault.status === "misconfigured") reasons.push(...replayFault.reasons);
    if (reasons.length > 0) {
      return {
        check: {
          requested: false,
          enabled: false,
          readiness: "misconfigured",
          reasons,
          containerSharding: containerShardingHealth(sharding)
        },
        reasons
      };
    }
    return {
      check: {
        requested: false,
        enabled: false,
        readiness: "disabled",
        containerSharding: containerShardingHealth(sharding)
      },
      reasons: []
    };
  }

  if (flag === "misconfigured") {
    const reasons = ["Durable scan jobs have an invalid edge feature-flag value."];
    const sharding = durableContainerShardingPlan({
      durableJobsFlag: env.SITE_BEHAVIOR_LAB_DURABLE_JOBS,
      durableJobsReady: false,
      shardingFlag: env.SITE_BEHAVIOR_LAB_CONTAINER_SHARDING,
      shardCount: env.SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT
    });
    return {
      check: {
        requested: true,
        enabled: false,
        readiness: "misconfigured",
        reasons,
        containerSharding: containerShardingHealth(sharding)
      },
      reasons
    };
  }

  const reasons: string[] = [];
  if (!node.ready) reasons.push("Durable scan jobs are not ready in the Node scanner.");

  let coordinatorOrigin: string | null = null;
  try {
    const config = requireDurableScanJobConfig(env as Env);
    await importDurableScanJobEncryptionKey(config.encryptionKey);
    coordinatorOrigin = config.coordinatorUrl;
  } catch {
    reasons.push("Durable scan jobs are not ready at the edge.");
  }
  if (replayFault.status === "misconfigured") reasons.push(...replayFault.reasons);
  if (
    replayFault.status === "ready" &&
    (!coordinatorOrigin || replayFault.coordinatorOrigin !== coordinatorOrigin)
  ) {
    reasons.push("The staging replay-fault coordinator origin does not match the durable-job coordinator.");
  }
  const sharding = durableContainerShardingPlan({
    durableJobsFlag: env.SITE_BEHAVIOR_LAB_DURABLE_JOBS,
    durableJobsReady: reasons.length === 0,
    shardingFlag: env.SITE_BEHAVIOR_LAB_CONTAINER_SHARDING,
    shardCount: env.SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT
  });
  if (sharding.readiness === "misconfigured") reasons.push(...sharding.reasons);

  if (reasons.length > 0) {
    return {
      check: {
        requested: true,
        enabled: false,
        readiness: "misconfigured",
        reasons,
        containerSharding: containerShardingHealth(sharding)
      },
      reasons
    };
  }
  return {
    check: {
      requested: true,
      enabled: true,
      readiness: "ready",
      coordinatorOrigin: coordinatorOrigin!,
      containerSharding: containerShardingHealth(sharding),
      ...(replayFault.status === "ready"
        ? {
            faultInjection: {
              environment: "staging" as const,
              enabled: true as const,
              modes: [...DURABLE_REPLAY_FAULT_MODES],
              modeHeaderName: DURABLE_REPLAY_FAULT_MODE_HEADER,
              tokenHeaderName: DURABLE_REPLAY_FAULT_TOKEN_HEADER,
              minimumNoPollMs: DURABLE_REPLAY_MINIMUM_NO_POLL_MS,
              attemptEvidence: true as const,
              completionBeforeStatusRequestEvidence: true as const,
              wholeOriginAccessGate: true as const
            }
          }
        : {})
    },
    reasons: []
  };
}

export async function encryptedWatchesEdgeHealthCheck(
  checks: unknown,
  durableJobs: Readonly<{ requested: boolean; enabled: boolean; readiness: string }>,
  env: Pick<
    Env,
    | "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES"
    | "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY"
    | "SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY"
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS"
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY"
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN"
    | "SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL"
    | "SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS"
    | "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN"
    | "TURNSTILE_SECRET_KEY"
    | "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID"
    | "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY"
  >
): Promise<{
  check: {
    requested: boolean;
    enabled: boolean;
    readiness: "disabled" | "ready" | "misconfigured";
    reasons?: string[];
  };
  reasons: string[];
}> {
  const flag = encryptedWatchesFlagState(env.SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES);
  const node = encryptedWatchNodeHealth(checks);
  if (flag === "disabled") {
    if (node.requested) {
      const reasons = ["Encrypted watches are enabled in Node but disabled at the edge."];
      return {
        check: { requested: false, enabled: false, readiness: "misconfigured", reasons },
        reasons
      };
    }
    return { check: { requested: false, enabled: false, readiness: "disabled" }, reasons: [] };
  }

  const reasons: string[] = [];
  if (flag === "misconfigured") reasons.push("Encrypted watches have an invalid edge feature-flag value.");
  if (!node.ready) reasons.push("Encrypted watches are not ready in the Node scanner.");
  if (!durableJobs.enabled || durableJobs.readiness !== "ready") {
    reasons.push("Encrypted watches require durable scan jobs to be ready at the edge.");
  }
  if (
    !encryptedWatchIngressIsTokenGated({
      accessToken: env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN,
      allowUnauthenticated: env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS,
      turnstileSecret: env.TURNSTILE_SECRET_KEY
    })
  ) {
    reasons.push("Encrypted watches require access-token-gated scanner ingress.");
  }
  if (reasons.length === 0) {
    try {
      const config = requireEncryptedWatchConfig(env as Env);
      await importEncryptedWatchKeyring(config);
    } catch {
      reasons.push("Encrypted-watch keys are unavailable or not isolated at the edge.");
    }
  }
  if (reasons.length > 0) {
    return {
      check: { requested: true, enabled: false, readiness: "misconfigured", reasons },
      reasons
    };
  }
  return { check: { requested: true, enabled: true, readiness: "ready" }, reasons: [] };
}

function encryptedWatchNodeHealth(checks: unknown): { requested: boolean; ready: boolean } {
  if (!checks || typeof checks !== "object") return { requested: false, ready: false };
  const value = (checks as Record<string, unknown>).encryptedWatches;
  if (!value || typeof value !== "object") return { requested: false, ready: false };
  const record = value as Record<string, unknown>;
  return {
    requested: record.requested === true,
    ready:
      record.requested === true &&
      record.enabled === true &&
      (record.readiness === "node-ready" || record.readiness === "ready")
  };
}

function containerShardingHealth(plan: DurableContainerShardingPlan): {
  requested: boolean;
  enabled: boolean;
  readiness: "disabled" | "blocked" | "ready" | "misconfigured";
  shardCount: number;
  reasons?: string[];
} {
  return {
    requested: plan.requested,
    enabled: plan.enabled,
    readiness: plan.readiness,
    shardCount: plan.shardCount,
    ...(plan.reasons.length > 0 ? { reasons: [...plan.reasons] } : {})
  };
}

/**
 * Edge abuse-control policy for the Containers scanner.
 *
 * - Token configured  → operator-gated: require the matching access token.
 * - No token + opened  → public: require Turnstile (when configured) and charge
 *   the per-client atomic Durable Object rate limit.
 * - No token + not opened → refuse, so an unconfigured scanner is never silently
 *   world-readable through its workers.dev URL.
 *
 * Unlike the Browser Run worker, the Node container pins DNS at connect time, so
 * opening it does not require the Browser Run DNS-rebinding risk acknowledgement.
 */
async function gateScanRequest(
  request: Request,
  body: string,
  env: Env,
  chargeMode: "charge" | "defer"
): Promise<PublicScanRateLimitCharge | null> {
  const payload = parseScanGatePayload(body);
  const clientHash = await publicClientHash(request.headers);
  const cost = scanTokenCost({
    compareGpc: payload.compareGpc === true,
    compareShields: payload.compareShields === true,
    compareConsent: payload.compareConsent === true
  });
  const expectedToken = env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim();
  if (expectedToken) {
    if (!(await scanAccessTokenMatches(request.headers, expectedToken))) {
      throw new EdgeScanGateError("Unauthorized scan request.", 401);
    }
    if (chargeMode === "charge") return null;
    // The non-durable token path continues to use Node's process-local limiter.
    // Durable admission needs the equivalent policy inside the authoritative DO
    // transaction, with no daily window (matching the prior Node semantics).
    const rateLimit: PublicScanRateLimitCharge = {
      scope: "authenticated",
      clientHash,
      cost,
      perMinute: AUTHENTICATED_SCAN_RATE_LIMIT_PER_MINUTE,
      perDay: null
    };
    await assertDeferredScanRateLimitAvailable(rateLimit, env);
    return rateLimit;
  }

  if (env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS !== "1") {
    throw new EdgeScanGateError(
      "This scanner is not configured for public scans. Set an access token, or set SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1 to open it.",
      503
    );
  }

  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (secret) {
    const token =
      typeof payload.turnstileToken === "string" ? payload.turnstileToken : request.headers.get("cf-turnstile-response") || "";
    await assertTurnstileToken({ secret, token, remoteIp: request.headers.get("cf-connecting-ip") });
  } else if (
    openScanBlockedForMissingTurnstile({
      turnstileSecret: secret,
      acceptNoTurnstileRisk: env.SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK
    })
  ) {
    throw new EdgeScanGateError(
      "Public scans require Turnstile. Set TURNSTILE_SECRET_KEY, or set SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK=1 to open without it.",
      503
    );
  }

  const rateLimit: PublicScanRateLimitCharge = {
    scope: "public",
    clientHash,
    cost,
    perMinute: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE),
    perDay: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY)
  };
  if (chargeMode === "defer") {
    await assertDeferredScanRateLimitAvailable(rateLimit, env);
    return rateLimit;
  }

  const charge = await getContainer(env.SCANNER).chargePublicScanRateLimit(rateLimit);
  if (!charge.allowed) {
    throw new EdgeScanGateError(
      `Too many public scans. Try again in about ${formatPublicScanRetryAfter(charge.retryAfterSeconds)}.`,
      429
    );
  }
  return null;
}

async function assertDeferredScanRateLimitAvailable(
  rateLimit: PublicScanRateLimitCharge,
  env: Env
): Promise<void> {
  let decision: PublicScanRateLimitResult;
  try {
    decision = await getContainer(env.SCANNER).peekPublicScanRateLimit(rateLimit);
  } catch (error) {
    console.error("Could not preflight durable scan-job quota.", error);
    throw new EdgeScanGateError("Durable scan jobs are temporarily unavailable.", 503);
  }
  if (!decision.allowed) {
    throw new DurableScanJobRateLimitError(rateLimit.scope, decision.retryAfterSeconds);
  }
}

function parseScanGatePayload(body: string): ScanGatePayload {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as ScanGatePayload) : {};
  } catch {
    // A malformed body cannot scan; the container returns the proper 400. Treat it
    // as a minimum-cost request with no Turnstile token for gating purposes.
    return {};
  }
}

function gateErrorResponse(error: unknown, request: Request, env: Env): Response {
  const status = error instanceof PublicFacingError ? error.status : 500;
  const message = error instanceof Error ? error.message : "The scan request was rejected.";
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: {
      ...scanCorsHeaders(request.headers.get("origin"), env.SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function minimumTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function sanitizedWatchTerminalErrorCode(reason: string | null, fallback: string): string {
  const candidate = (reason ?? fallback).trim().toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(candidate) ? candidate : fallback;
}
