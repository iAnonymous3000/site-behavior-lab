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
  SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS?: string;
  // "1" waives the Turnstile requirement for open access (atomic rate limit only).
  // Without it, open access with no TURNSTILE_SECRET_KEY fails closed.
  SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK?: string;
  // Set as Worker secrets (`wrangler secret put -c wrangler.container.jsonc <NAME>`)
  // and forwarded into the container via envVars below.
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?: string;
  TURNSTILE_SECRET_KEY?: string;
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

type AtomicRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

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
  | { status: "refused" };

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
    SITE_BEHAVIOR_LAB_R2_BUCKET: "site-behavior-lab-reports",
    SITE_BEHAVIOR_LAB_R2_PREFIX: "reports/",
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

  /**
   * Exact public-scan quota accounting in the same singleton Durable Object
   * that owns the scanner container. SQLite and transactionSync make the
   * minute + day check-and-charge one atomic operation, so concurrent requests
   * cannot overshoot the configured token budget as they could with KV
   * read-then-write counters.
   */
  chargePublicScanRateLimit(input: {
    clientHash: string;
    cost: 1 | 2;
    perMinute: number;
    perDay: number;
  }): AtomicRateLimitResult {
    if (!/^[a-f0-9]{64}$/.test(input.clientHash)) {
      throw new Error("Invalid public-scan client hash.");
    }
    if (input.cost !== 1 && input.cost !== 2) {
      throw new Error("Invalid public-scan rate-limit charge.");
    }
    if (
      !Number.isSafeInteger(input.perMinute) ||
      input.perMinute <= 0 ||
      !Number.isSafeInteger(input.perDay) ||
      input.perDay <= 0
    ) {
      throw new Error("Invalid public-scan rate-limit configuration.");
    }

    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS public_scan_rate_limits (bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL)"
      );
      sql.exec("DELETE FROM public_scan_rate_limits WHERE expires_at <= ?", now);

      const windows = [
        atomicRateLimitWindow("minute", 60_000, input.perMinute, { ...input, now }),
        atomicRateLimitWindow("day", 86_400_000, input.perDay, { ...input, now })
      ];
      const exceeded: number[] = [];
      const charges: Array<{ bucket: string; used: number; expiresAt: number }> = [];

      for (const window of windows) {
        const row = sql
          .exec<{ used: number }>(
            "SELECT used FROM public_scan_rate_limits WHERE bucket = ? AND expires_at > ?",
            window.bucket,
            now
          )
          .toArray()[0];
        const used = row?.used ?? 0;
        if (used + input.cost > window.limit) {
          exceeded.push(window.retryAfterSeconds);
        } else {
          charges.push({ bucket: window.bucket, used: used + input.cost, expiresAt: window.expiresAt });
        }
      }

      if (exceeded.length > 0) {
        return { allowed: false, retryAfterSeconds: Math.max(...exceeded) };
      }

      for (const charge of charges) {
        sql.exec(
          "INSERT INTO public_scan_rate_limits (bucket, used, expires_at) VALUES (?, ?, ?) ON CONFLICT(bucket) DO UPDATE SET used = excluded.used, expires_at = excluded.expires_at",
          charge.bucket,
          charge.used,
          charge.expiresAt
        );
      }
      return { allowed: true };
    });
  }

  chargeDurableJobReadRateLimit(input: { clientHash: string }): AtomicRateLimitResult {
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

  /** Encrypt, schedule, and atomically admit before the edge may expose 202. */
  async admitDurablePreparation(preparation: DurableScanJobPreparation): Promise<DurableScanJobAdmissionResult> {
    requireDurableScanJobConfig(this.env);
    const key = await this.durableEncryptionKey();
    const admission = await createDurableScanJobAdmission(key, {
      jobId: preparation.submission.jobId,
      reportId: preparation.submission.reportId,
      createdAt: preparation.payload.admittedAt,
      payload: preparation.payload
    });

    // Reject full/colliding admissions before calling Container.schedule(),
    // whose singleton alarm write would otherwise be remotely postponable by
    // a stream of refused requests. The insert repeats this check after an
    // imminent, coalesced wake is durably present.
    try {
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        ensureDurableScanJobStore(this.ctx.storage.sql);
        this.purgeDurableScanJobState(now);
        preflightDurableScanJobAdmission(this.ctx.storage.sql, admission);
      });
    } catch (error) {
      if (error instanceof DurableScanJobCapacityError || error instanceof DurableScanJobStateError) {
        return { status: "refused" };
      }
      throw error;
    }
    await this.ensureImmediateDurablePumpWake();
    try {
      const snapshot = this.ctx.storage.transactionSync(() =>
        admitDurableScanJob(this.ctx.storage.sql, admission)
      );
      return { status: "success", snapshot };
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

  async cancelDurableJob(jobId: string): Promise<DurableScanJobCancellationResult> {
    let result: Extract<DurableScanJobCancellationResult, { status: "success" }>;
    try {
      const now = Date.now();
      result = this.ctx.storage.transactionSync(() => {
        const before = findDurableScanJobSnapshot(this.ctx.storage.sql, jobId);
        const snapshot = cancelDurableScanJob(this.ctx.storage.sql, { jobId, now });
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
    return result;
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
          activations.push({ claim, preparation: await decryptDurableScanJobClaim(key, claim) });
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
    pathname: string,
    method: "POST" | "DELETE",
    body: unknown,
    allowDisabled = false,
    timeoutMs = 60_000
  ): Promise<Response> {
    const token = allowDisabled
      ? requireDurableScanJobInternalToken(this.env)
      : requireDurableScanJobConfig(this.env).internalToken;
    return this.containerFetch(`http://container.internal${pathname}`, {
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
    if (unfinished) {
      // Keep a low-frequency request-independent wake so correcting a bad flag
      // or secret resumes work without polling, while never scheduling later
      // than a nearer hard deadline, settlement fence, or purge boundary.
      const wakeAt = Math.min(now + 60_000, nextWakeAt ?? now + 60_000);
      await this.persistParkedDurablePumpSchedule(Math.max(wakeAt, Date.now() + 1_000));
    } else if (nextWakeAt !== null) {
      // Disabled mode still honors the bounded 75-minute tombstone retention;
      // otherwise terminal metadata could remain indefinitely after a rollback.
      await this.persistParkedDurablePumpSchedule(Math.max(nextWakeAt, Date.now() + 1_000));
    } else {
      this.deleteSchedules(DURABLE_SCAN_JOB_PUMP_CALLBACK);
      this.clearDurablePumpDriverState();
    }
  }

  private async maintainDisabledDurableJobs(): Promise<void> {
    const now = Date.now();
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

  private purgeDurableScanJobState(now: number): number {
    const purged = purgeDurableScanJobs(this.ctx.storage.sql, now);
    // The backoff table has no foreign key because Durable Object SQLite
    // migrations must tolerate the pre-feature schema. Couple every purge to
    // explicit orphan pruning so disabled/status-only traffic cannot retain it.
    this.pruneDurableReconciliationBackoff();
    return purged;
  }

  private durableEncryptionKey(): Promise<DurableScanJobEncryptionKey> {
    this.durableEncryptionKeyPromise ??= importDurableScanJobEncryptionKey(
      this.env.SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY ?? ""
    );
    return this.durableEncryptionKeyPromise;
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
    const wakeAt = chooseDurableScanJobPumpWakeAt({
      storeWakeAt,
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

function atomicRateLimitWindow(
  name: "minute" | "day",
  durationMs: number,
  limit: number,
  input: { clientHash: string; now: number }
): { bucket: string; expiresAt: number; limit: number; retryAfterSeconds: number } {
  const windowId = Math.floor(input.now / durationMs);
  const expiresAt = (windowId + 1) * durationMs;
  return {
    bucket: `${name}/${windowId}/${input.clientHash}`,
    expiresAt,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - input.now) / 1_000))
  };
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
    if (isScan && durableScanJobsFlagMisconfigured(env)) {
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

    try {
      await gateScanRequest(request, body, env);
    } catch (error) {
      return gateErrorResponse(error, request, env);
    }

    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body });
    if (durableScanJobsEnabled(env)) {
      return submitDurableScanJob(forwarded, env);
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

function requireDurableScanJobInternalToken(env: Env): string {
  const internalToken = env[DURABLE_SCAN_JOB_INTERNAL_TOKEN_ENV]?.trim() ?? "";
  if (internalToken.length < 32 || internalToken.length > 4_096 || /[\r\n]/.test(internalToken)) {
    throw new Error("Durable scan-job internal authentication is not configured.");
  }
  return internalToken;
}

async function submitDurableScanJob(request: Request, env: Env): Promise<Response> {
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

  const admission = await finalizeDurableScanJobAdmission(
    preparation,
    async (value) => {
      const result = await getContainer(env.SCANNER).admitDurablePreparation(value);
      // Expected full/collision control flow crossed RPC as a plain envelope;
      // throw only here, in the edge isolate, so exact readback can still
      // recover a response-lost idempotent commit without resetting the DO.
      if (
        result.status !== "success" ||
        !durableScanJobAdmissionProofMatches(result.snapshot, value)
      ) {
        throw new DurableScanJobCapacityError();
      }
      return result.snapshot;
    },
    (error) => {
      if (!(error instanceof DurableScanJobCapacityError)) {
        console.error("Could not commit durable scan-job admission.", error);
      }
    },
    async (value) => {
      const snapshot = await getContainer(env.SCANNER).findDurableJob(value.submission.jobId);
      return durableScanJobAdmissionProofMatches(snapshot, value);
    }
  );
  if (!admission.accepted) {
    // No store/schedule failure detail and no private header reaches the caller.
    return durableUnavailableResponse(request, env);
  }

  publicHeaders.set("content-type", "application/json; charset=utf-8");
  publicHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(admission.submission), { status: admission.status, headers: publicHeaders });
}

async function handleDurableScanJobRequest(
  request: Request,
  env: Env,
  jobId: string
): Promise<Response | null> {
  // Authenticate and bound capability probes before even a read-only DO RPC;
  // otherwise guessed IDs become an existence oracle and unbounded work source.
  const accessFailure = await gateDurableScanJobControlRequest(request, env);
  if (accessFailure) return accessFailure;
  let snapshot: DurableScanJobSnapshot | null;
  try {
    snapshot = await getContainer(env.SCANNER).findDurableJob(jobId);
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
      const cancelled = await getContainer(env.SCANNER).cancelDurableJob(jobId);
      if (cancelled.status === "conflict") return publicJobConflictResponse(request, env);
      return durableScanJobCancellationResponse(cancelled.snapshot, source);
    } catch (error) {
      console.error("Could not cancel an authoritative durable scan job.", error);
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
    onReportError: (error) => console.error("Could not read a durable scan-job report.", error)
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
      health.checks = {
        ...(typeof health.checks === "object" && health.checks ? health.checks : {}),
        durableJobs: durableJobs.check
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
  const flag = durableScanJobsFlagState(env.SITE_BEHAVIOR_LAB_DURABLE_JOBS);
  const node = durableScanJobNodeHealthState(checks);
  if (flag === "disabled") {
    if (node.requested) {
      const reasons = [
        "Durable scan jobs are enabled in the Node scanner but disabled at the edge."
      ];
      return {
        check: { requested: false, enabled: false, readiness: "misconfigured", reasons },
        reasons
      };
    }
    return { check: { requested: false, enabled: false, readiness: "disabled" }, reasons: [] };
  }

  if (flag === "misconfigured") {
    const reasons = ["Durable scan jobs have an invalid edge feature-flag value."];
    return {
      check: { requested: true, enabled: false, readiness: "misconfigured", reasons },
      reasons
    };
  }

  const reasons: string[] = [];
  if (!node.ready) reasons.push("Durable scan jobs are not ready in the Node scanner.");

  try {
    const config = requireDurableScanJobConfig(env as Env);
    await importDurableScanJobEncryptionKey(config.encryptionKey);
  } catch {
    reasons.push("Durable scan jobs are not ready at the edge.");
  }

  if (reasons.length > 0) {
    return {
      check: { requested: true, enabled: false, readiness: "misconfigured", reasons },
      reasons
    };
  }
  return { check: { requested: true, enabled: true, readiness: "ready" }, reasons: [] };
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
async function gateScanRequest(request: Request, body: string, env: Env): Promise<void> {
  const expectedToken = env.SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN?.trim();
  if (expectedToken) {
    if (!(await scanAccessTokenMatches(request.headers, expectedToken))) {
      throw new EdgeScanGateError("Unauthorized scan request.", 401);
    }
    return;
  }

  if (env.SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS !== "1") {
    throw new EdgeScanGateError(
      "This scanner is not configured for public scans. Set an access token, or set SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1 to open it.",
      503
    );
  }

  const payload = parseScanGatePayload(body);

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

  const charge = await getContainer(env.SCANNER).chargePublicScanRateLimit({
    clientHash: await publicClientHash(request.headers),
    cost: scanTokenCost({
      compareGpc: payload.compareGpc === true,
      compareShields: payload.compareShields === true,
      compareConsent: payload.compareConsent === true
    }),
    perMinute: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE),
    perDay: publicScanRateLimit(env.SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY, DEFAULT_PUBLIC_SCAN_RATE_LIMIT_PER_DAY)
  });
  if (!charge.allowed) {
    throw new EdgeScanGateError(
      `Too many public scans. Try again in about ${formatPublicScanRetryAfter(charge.retryAfterSeconds)}.`,
      429
    );
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
