import type { DurableScanJobPayload } from "../lib/durable-scan-job-contract";
import { DurableObject } from "cloudflare:workers";
import {
  ScanAdmissionConflictError,
  commitIdempotentScanAdmission,
  findScanAdmission,
  type ScanAdmissionStoreKey
} from "../lib/scan-admission-store";
import {
  releaseDurablePreparation,
  reserveDurablePreparation
} from "../lib/durable-preparation-reservation";
import {
  DurableScanJobStateError,
  DurableScanJobValidationError,
  admitDurableScanJob,
  beginPublishingDurableScanJob,
  cancelDurableScanJob,
  claimDurableScanJobs,
  createDurableScanJobAdmission,
  createDurableScanJobLeaseCredentials,
  findDurableScanJobSnapshot,
  hashDurableScanJobLeaseToken,
  heartbeatDurableScanJob,
  importDurableScanJobEncryptionKey,
  requeueOrFailExpiredDurableScanJobLease,
  resolveDurableScanJob,
  type DurableScanJobSnapshot,
  type DurableScanJobStoreSql
} from "../lib/durable-scan-job-store";
import type { PublicScanRateLimitCharge } from "../lib/public-scan-rate-limit-store";

const OBJECT_NAME = "critical-software-runtime-proof";

type RuntimeStorage = {
  sql: DurableScanJobStoreSql;
  transactionSync<T>(callback: () => T): T;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(time: number | Date): Promise<void>;
};

type RuntimeState = {
  storage: RuntimeStorage;
};

type RuntimeNamespace = {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
};

type RuntimeEnv = {
  DURABLE_RUNTIME: RuntimeNamespace;
  DURABLE_RUNTIME_KEY: string;
};

type AdmissionCommand = {
  jobId: string;
  reportId: string;
  now: number;
};

type IdempotentAdmissionCommand = AdmissionCommand & {
  capabilityHash: string;
  requestCommitment: string;
  simulateResponseLoss: boolean;
};

type AdmissionRecoveryCommand = {
  capabilityHash: string;
  requestCommitment: string;
  now: number;
};

type LeaseCommand = {
  now: number;
};

type OwnerCommand = {
  generation: number;
  leaseToken: string;
  now: number;
};

type ComparisonAdmissionCommand = AdmissionCommand & { compare: boolean };

type HeartbeatCommand = OwnerCommand & { completedRuns: number };

type RecoveryAlarmTarget = {
  jobId: string;
  generation: number;
  recoverAt: number;
};

const TEST_RATE_LIMIT = Object.freeze({
  scope: "public",
  clientHash: "f".repeat(64),
  cost: 1,
  perMinute: 10,
  perDay: 100
} satisfies PublicScanRateLimitCharge);

/**
 * Test-only Worker/DO harness. It deliberately imports the production durable
 * store instead of reimplementing its state machine. Miniflare bundles this
 * file and executes it in workerd with a real SQLite-backed Durable Object.
 */
export class DurableScanJobRuntimeHarness extends DurableObject<RuntimeEnv> {
  private readonly state: RuntimeState;
  private readonly runtimeEnv: RuntimeEnv;

  constructor(state: RuntimeState, env: RuntimeEnv) {
    super(state as never, env);
    this.state = state;
    this.runtimeEnv = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof ScanAdmissionConflictError) {
        return json({ error: "scan-admission-conflict" }, 409);
      }
      if (error instanceof DurableScanJobStateError) {
        return json({ error: error.code, state: error.currentState }, 409);
      }
      if (error instanceof DurableScanJobValidationError) {
        return json({ error: "invalid-request" }, 400);
      }
      console.error("The durable runtime harness request failed.", error);
      return json({ error: "internal-error" }, 500);
    }
  }

  async alarm(): Promise<void> {
    const target = await this.state.storage.get<RecoveryAlarmTarget>("recovery-target");
    if (!target) return;
    this.state.storage.transactionSync(() =>
      requeueOrFailExpiredDurableScanJobLease(this.state.storage.sql, {
        jobId: target.jobId,
        generation: target.generation,
        now: target.recoverAt
      })
    );
    await this.state.storage.delete("recovery-target");
    const alarmRuns = (await this.state.storage.get<number>("alarm-runs")) ?? 0;
    await this.state.storage.put("alarm-runs", alarmRuns + 1);
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/admissions") {
      const command = await exactJson<IdempotentAdmissionCommand>(request, [
        "capabilityHash",
        "requestCommitment",
        "jobId",
        "reportId",
        "now",
        "simulateResponseLoss"
      ]);
      const key = admissionKey(command);
      const encryptionKey = await importDurableScanJobEncryptionKey(this.runtimeEnv.DURABLE_RUNTIME_KEY);
      const prepared = await createDurableScanJobAdmission(encryptionKey, {
        jobId: command.jobId,
        reportId: command.reportId,
        createdAt: command.now,
        payload: payload(command.now)
      });
      const result = this.state.storage.transactionSync(() =>
        commitIdempotentScanAdmission(
          this.state.storage.sql,
          key,
          TEST_RATE_LIMIT,
          command.now,
          () => ({
            registration: {
              jobId: command.jobId,
              reportId: command.reportId,
              totalRuns: 1,
              createdAt: command.now
            },
            value: admitDurableScanJob(this.state.storage.sql, prepared)
          })
        )
      );
      if (result.status === "rate-limited") {
        return json({ error: "rate-limited", retryAfterSeconds: result.retryAfterSeconds }, 429);
      }
      if (command.simulateResponseLoss && result.status === "committed") {
        // Deliberately discard the successful admission response after the
        // authoritative transaction commits. The integration test observes a
        // gateway-style failure and must recover only through the capability.
        return json({ error: "committed-response-lost" }, 504);
      }
      return json(
        {
          status: result.status,
          jobId: result.admission.jobId,
          reportId: result.admission.reportId,
          totalRuns: result.admission.totalRuns,
          createdAt: result.admission.createdAt,
          expiresAt: result.admission.expiresAt
        },
        202
      );
    }

    if (request.method === "POST" && url.pathname === "/preparations") {
      const command = await exactJson<PreparationCommand>(request, ["capabilityHash", "now", "expiresAt"]);
      const reservation = this.state.storage.transactionSync(() =>
        reserveDurablePreparation(
          this.state.storage.sql,
          decodeCapabilityHash(command.capabilityHash),
          command.now,
          command.expiresAt
        )
      );
      return json(reservation, reservation.status === "reserved" ? 200 : 429);
    }

    if (request.method === "POST" && url.pathname === "/preparations/release") {
      const command = await exactJson<PreparationReleaseCommand>(request, ["capabilityHash"]);
      this.state.storage.transactionSync(() => {
        releaseDurablePreparation(this.state.storage.sql, decodeCapabilityHash(command.capabilityHash));
      });
      return json({ status: "released" });
    }

    if (request.method === "POST" && url.pathname === "/admissions/recover") {
      const command = await exactJson<AdmissionRecoveryCommand>(request, [
        "capabilityHash",
        "requestCommitment",
        "now"
      ]);
      const recovered = this.state.storage.transactionSync(() =>
        findScanAdmission(this.state.storage.sql, admissionKey(command), command.now)
      );
      return recovered
        ? json({ status: "recovered", ...recovered })
        : json({ error: "scan-admission-not-found" }, 404);
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      const command = await exactJson<ComparisonAdmissionCommand>(request, [
        "jobId",
        "reportId",
        "now",
        "compare"
      ]);
      const key = await importDurableScanJobEncryptionKey(this.runtimeEnv.DURABLE_RUNTIME_KEY);
      const admission = await createDurableScanJobAdmission(key, {
        jobId: command.jobId,
        reportId: command.reportId,
        createdAt: command.now,
        payload: payload(command.now, command.compare)
      });
      const snapshot = this.state.storage.transactionSync(() =>
        admitDurableScanJob(this.state.storage.sql, admission)
      );
      return json(snapshot, 202);
    }

    if (request.method === "GET" && url.pathname === "/runtime") {
      return json({ alarmRuns: (await this.state.storage.get<number>("alarm-runs")) ?? 0 });
    }

    const match = /^\/jobs\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return json({ error: "not-found" }, 404);
    const [, jobId, action] = match;

    if (request.method === "GET" && action === undefined) {
      const snapshot = findDurableScanJobSnapshot(this.state.storage.sql, jobId);
      return snapshot ? json(snapshot) : json({ error: "not-found" }, 404);
    }

    if (request.method === "DELETE" && action === undefined) {
      const snapshot = this.state.storage.transactionSync(() =>
        cancelDurableScanJob(this.state.storage.sql, { jobId, now: Date.now() })
      );
      return json(snapshot);
    }

    if (request.method === "POST" && action === "claim") {
      const command = await exactJson<LeaseCommand>(request, ["now"]);
      const [credential] = await createDurableScanJobLeaseCredentials(1);
      const [claim] = this.state.storage.transactionSync(() =>
        claimDurableScanJobs(this.state.storage.sql, {
          now: command.now,
          capacity: 1,
          credentials: [credential]
        })
      );
      return claim
        ? json({
            jobId: claim.jobId,
            generation: claim.leaseGeneration,
            leaseToken: claim.leaseToken,
            leaseExpiresAt: claim.leaseExpiresAt
          })
        : json({ error: "not-claimable" }, 409);
    }

    if (request.method === "POST" && action === "heartbeat") {
      const command = await exactJson<HeartbeatCommand>(request, [
        "generation",
        "leaseToken",
        "now",
        "completedRuns"
      ]);
      const tokenHash = await hashDurableScanJobLeaseToken(command.leaseToken);
      const snapshot = this.state.storage.transactionSync(() =>
        heartbeatDurableScanJob(this.state.storage.sql, {
          jobId,
          generation: command.generation,
          tokenHash,
          completedRuns: command.completedRuns,
          now: command.now
        })
      );
      return json(snapshot);
    }

    if (request.method === "POST" && action === "begin-publishing") {
      const command = await exactJson<OwnerCommand>(request, ["generation", "leaseToken", "now"]);
      const tokenHash = await hashDurableScanJobLeaseToken(command.leaseToken);
      const snapshot = this.state.storage.transactionSync(() =>
        beginPublishingDurableScanJob(this.state.storage.sql, {
          jobId,
          generation: command.generation,
          tokenHash,
          now: command.now,
          manifest: publicationManifest(findRequiredSnapshot(this.state.storage.sql, jobId).reportId)
        })
      );
      return json(snapshot);
    }

    if (request.method === "POST" && action === "resolve") {
      const command = await exactJson<OwnerCommand>(request, ["generation", "leaseToken", "now"]);
      const tokenHash = await hashDurableScanJobLeaseToken(command.leaseToken);
      const snapshot = this.state.storage.transactionSync(() =>
        resolveDurableScanJob(this.state.storage.sql, {
          jobId,
          generation: command.generation,
          tokenHash,
          now: command.now,
          outcome: "succeeded"
        })
      );
      return json(snapshot);
    }

    if (request.method === "POST" && action === "arm-recovery") {
      const snapshot = findRequiredSnapshot(this.state.storage.sql, jobId);
      if (snapshot.state !== "leased" || snapshot.leaseExpiresAt === null) {
        return json({ error: "not-recoverable" }, 409);
      }
      await this.state.storage.put<RecoveryAlarmTarget>("recovery-target", {
        jobId,
        generation: snapshot.leaseGeneration,
        recoverAt: snapshot.leaseExpiresAt
      });
      await this.state.storage.setAlarm(Date.now() + 10);
      return json({ armed: true }, 202);
    }

    return json({ error: "not-found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    // Encrypted watches intentionally stay unreachable in this durability
    // harness. Their independent production feature gate must remain closed.
    if (new URL(request.url).pathname.startsWith("/watches")) {
      return json({ error: "not-found" }, 404);
    }
    return env.DURABLE_RUNTIME.getByName(OBJECT_NAME).fetch(request);
  }
};

function payload(admittedAt: number, compare = false): DurableScanJobPayload {
  return {
    version: 1,
    url: "https://example.com/",
    device: "desktop",
    gpcEnabled: false,
    compareGpc: compare,
    compareShields: false,
    compareConsent: false,
    rateLimitCost: compare ? 2 : 1,
    admittedAt,
    reportMode: "r2",
    alreadyCharged: true
  };
}

function findRequiredSnapshot(sql: DurableScanJobStoreSql, jobId: string): DurableScanJobSnapshot {
  const snapshot = findDurableScanJobSnapshot(sql, jobId);
  if (!snapshot) throw new DurableScanJobStateError("not-found", "The durable scan job does not exist.");
  return snapshot;
}

function publicationManifest(reportId: string): string {
  const createdAt = "2026-07-21T12:00:00.000Z";
  const expiresAt = "2026-07-28T12:00:00.000Z";
  const publicDigest = "a".repeat(64);
  const canonicalizationVersion = "canon-v1";
  const redactionVersion = 3;
  const sidecar = {
    reportId,
    publicDigest,
    canonicalizationVersion,
    redactionVersion,
    writtenAt: createdAt,
    createdAt,
    expiresAt
  };
  return JSON.stringify({
    manifestVersion: 1,
    reportId,
    reportWireSha256: "b".repeat(64),
    publicDigest,
    canonicalizationVersion,
    redactionVersion,
    reportBytes: 1_024,
    retention: { createdAt, expiresAt },
    sidecarWire: `${JSON.stringify(sidecar, null, 2)}\n`
  });
}

type PreparationCommand = {
  capabilityHash: string;
  now: number;
  expiresAt: number;
};

type PreparationReleaseCommand = {
  capabilityHash: string;
};

function decodeCapabilityHash(value: string): ArrayBuffer {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new DurableScanJobValidationError("The admission capability hash is invalid.");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function admissionKey(
  command: Pick<AdmissionRecoveryCommand, "capabilityHash" | "requestCommitment">
): ScanAdmissionStoreKey {
  if (!/^[a-f0-9]{64}$/.test(command.capabilityHash)) {
    throw new DurableScanJobValidationError("The admission capability hash is invalid.");
  }
  const capabilityHash = new Uint8Array(32);
  for (let index = 0; index < capabilityHash.length; index += 1) {
    capabilityHash[index] = Number.parseInt(command.capabilityHash.slice(index * 2, index * 2 + 2), 16);
  }
  return {
    capabilityHash: capabilityHash.buffer,
    requestCommitment: command.requestCommitment
  };
}

async function exactJson<T extends Record<string, unknown>>(request: Request, keys: readonly string[]): Promise<T> {
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableScanJobValidationError("The command body must be an object.");
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new DurableScanJobValidationError("The command body has unexpected fields.");
  }
  return value as T;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
