import {
  canonicalEvidenceDigest,
  exactKeys,
  parseCanonicalEvidence,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const DURABLE_RESTART_EVIDENCE_FILES = Object.freeze([
  "post-health.json",
  "pre-health.json",
  "queued-work-recovery.json",
  "restart-evidence.json"
]);
export const DURABLE_RUNTIME_OBSERVATION_KIND =
  "site-behavior-durable-runtime-provider-observation";
export const DURABLE_RESTART_EVIDENCE_KIND =
  "site-behavior-durable-runtime-restart-evidence";
export const DURABLE_RECOVERY_EVIDENCE_KIND =
  "site-behavior-durable-queued-work-recovery";
export const DURABLE_JOB_SNAPSHOT_KIND =
  "site-behavior-durable-restart-job-snapshot";
export const DURABLE_RESTART_SCHEMA_VERSION = 1;
export const DURABLE_RESTART_MAX_FILE_BYTES = 1024 * 1024;
export const DURABLE_RESTART_MAX_REPORT_BYTES = 32 * 1024 * 1024;
export const DURABLE_RESTART_PROVIDER_APPLICATION =
  "site-behavior-lab-scanner";
export const DURABLE_RESTART_PROVIDER_INSTANCE =
  "cf-singleton-container";
export const DURABLE_RESTART_FIXED_TARGET =
  "https://www.iana.org/domains/reserved";

const PROVIDER_IDENTITY_DOMAIN =
  "site-behavior-lab/cloudflare-container-runtime-identity/v1";
const PROVIDER_OBSERVATION_DOMAIN =
  "site-behavior-lab/cloudflare-container-runtime-observation/v1";
const RUNTIME_KEYS = [
  "schemaVersion",
  "artifactKind",
  "deploymentCommit",
  "observedAt",
  "runtimeIdentityRef",
  "provider",
  "providerObservationSha256"
];
const RESTART_KEYS = [
  "schemaVersion",
  "artifactKind",
  "deploymentCommit",
  "startedAt",
  "restartObservedAt",
  "completedAt",
  "preRuntimeIdentityRef",
  "postRuntimeIdentityRef",
  "queuedWorkRecoverySha256"
];
const RECOVERY_KEYS = [
  "schemaVersion",
  "artifactKind",
  "preRestartObservedAt",
  "preRestartJob",
  "terminalJob",
  "publicationIdentity"
];
const JOB_SNAPSHOT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "jobId",
  "reportId",
  "state",
  "createdAt",
  "finishedAt",
  "attemptCount",
  "leaseGeneration"
];
const PUBLICATION_IDENTITY_KEYS = [
  "reportId",
  "jsonPath",
  "readbackAt",
  "reportSha256"
];
const APPLICATION_KEYS = [
  "id",
  "name",
  "state",
  "instances",
  "image",
  "version",
  "updated_at",
  "created_at"
];
const INSTANCE_KEYS = [
  "id",
  "name",
  "state",
  "location",
  "version",
  "created"
];
const JOB_STATES = new Set([
  "queued",
  "leased",
  "publishing",
  "succeeded",
  "failed",
  "expired",
  "cancelled"
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const LOCATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUNTIME_IDENTITY_REF = /^sha256:[0-9a-f]{64}$/;
const REPORT_ID = /^[0-9]{8}-[0-9a-f]{32}$/;

export class DurableRestartProviderUnavailableError extends Error {}

function exact(value, keys, label) {
  const problems = [];
  if (!exactKeys(value, keys, label, problems)) {
    throw new Error(problems.join("; "));
  }
}

function canonicalInstant(value, label) {
  const problems = [];
  const instant = requireCanonicalInstant(value, label, problems);
  if (problems.length > 0 || instant === null) {
    throw new Error(problems.join("; "));
  }
  return value;
}

function canonicalProviderInstant(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a provider timestamp`);
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`${label} must be a provider timestamp`);
  }
  return new Date(millis).toISOString();
}

function commit(value, label) {
  const problems = [];
  requireCommit(value, label, problems);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return value;
}

function sha256(value, label) {
  const problems = [];
  requireSha256(value, label, problems);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return value;
}

function positiveSafeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedString(value, label, pattern, maximum = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !pattern.test(value)
  ) {
    throw new Error(`${label} has an invalid bounded value`);
  }
  return value;
}

function verifyRuntime(value, label) {
  exact(value, RUNTIME_KEYS, label);
  if (
    value.schemaVersion !== DURABLE_RESTART_SCHEMA_VERSION ||
    value.artifactKind !== DURABLE_RUNTIME_OBSERVATION_KIND
  ) {
    throw new Error(`${label} schema identity is invalid`);
  }
  commit(value.deploymentCommit, `${label}.deploymentCommit`);
  canonicalInstant(value.observedAt, `${label}.observedAt`);
  if (
    typeof value.runtimeIdentityRef !== "string" ||
    !RUNTIME_IDENTITY_REF.test(value.runtimeIdentityRef)
  ) {
    throw new Error(
      `${label}.runtimeIdentityRef must be a domain-separated sha256 identity reference`
    );
  }
  if (value.provider !== "cloudflare-containers-api") {
    throw new Error(`${label}.provider must be exactly cloudflare-containers-api`);
  }
  sha256(
    value.providerObservationSha256,
    `${label}.providerObservationSha256`
  );
  return value;
}

function verifyRecovery(value) {
  exact(value, RECOVERY_KEYS, "queued-work recovery");
  if (
    value.schemaVersion !== DURABLE_RESTART_SCHEMA_VERSION ||
    value.artifactKind !== DURABLE_RECOVERY_EVIDENCE_KIND
  ) {
    throw new Error(
      "queued-work recovery schema identity is invalid"
    );
  }
  canonicalInstant(
    value.preRestartObservedAt,
    "queued-work recovery preRestartObservedAt"
  );
  const preRestartJob = verifyDurableRestartJobSnapshot(
    value.preRestartJob
  );
  const terminalJob = verifyDurableRestartJobSnapshot(
    value.terminalJob
  );
  exact(
    value.publicationIdentity,
    PUBLICATION_IDENTITY_KEYS,
    "queued-work recovery publication identity"
  );
  if (
    preRestartJob.state !== "leased" ||
    preRestartJob.attemptCount !== 1 ||
    preRestartJob.leaseGeneration !== 1 ||
    preRestartJob.finishedAt !== null ||
    terminalJob.state !== "succeeded" ||
    terminalJob.attemptCount !== 2 ||
    terminalJob.leaseGeneration !== 2 ||
    terminalJob.finishedAt === null ||
    preRestartJob.jobId !== terminalJob.jobId ||
    preRestartJob.reportId !== terminalJob.reportId ||
    preRestartJob.createdAt !== terminalJob.createdAt ||
    value.publicationIdentity.reportId !== terminalJob.reportId ||
    value.publicationIdentity.jsonPath !==
      `/api/reports/${terminalJob.reportId}`
  ) {
    throw new Error(
      "queued-work recovery does not derive one second-generation publication identity from the authoritative job snapshots"
    );
  }
  canonicalInstant(
    value.publicationIdentity.readbackAt,
    "queued-work recovery publication readbackAt"
  );
  if (
    Date.parse(value.preRestartObservedAt) <
      Date.parse(preRestartJob.createdAt) ||
    Date.parse(terminalJob.finishedAt) <=
      Date.parse(preRestartJob.createdAt) ||
    Date.parse(value.publicationIdentity.readbackAt) <
      Date.parse(terminalJob.finishedAt)
  ) {
    throw new Error(
      "queued-work recovery observation and settlement chronology is invalid"
    );
  }
  sha256(
    value.publicationIdentity.reportSha256,
    "queued-work recovery publication reportSha256"
  );
  return value;
}

function verifyRestart(value) {
  exact(value, RESTART_KEYS, "durable restart evidence");
  if (
    value.schemaVersion !== DURABLE_RESTART_SCHEMA_VERSION ||
    value.artifactKind !== DURABLE_RESTART_EVIDENCE_KIND
  ) {
    throw new Error("durable restart evidence schema identity is invalid");
  }
  commit(value.deploymentCommit, "durable restart deploymentCommit");
  canonicalInstant(value.startedAt, "durable restart startedAt");
  canonicalInstant(value.restartObservedAt, "durable restart restartObservedAt");
  canonicalInstant(value.completedAt, "durable restart completedAt");
  if (
    Date.parse(value.startedAt) >
      Date.parse(value.restartObservedAt) ||
    Date.parse(value.restartObservedAt) >
      Date.parse(value.completedAt)
  ) {
    throw new Error("durable restart timestamps are not ordered");
  }
  for (const field of ["preRuntimeIdentityRef", "postRuntimeIdentityRef"]) {
    if (
      typeof value[field] !== "string" ||
      !RUNTIME_IDENTITY_REF.test(value[field])
    ) {
      throw new Error(
        `durable restart ${field} must be a domain-separated sha256 identity reference`
      );
    }
  }
  if (value.preRuntimeIdentityRef === value.postRuntimeIdentityRef) {
    throw new Error("durable restart must change the provider runtime identity");
  }
  sha256(
    value.queuedWorkRecoverySha256,
    "durable restart queuedWorkRecoverySha256"
  );
  return value;
}

export function verifyDurableRestartJobSnapshot(
  value,
  expected = undefined
) {
  exact(value, JOB_SNAPSHOT_KEYS, "durable restart job snapshot");
  if (
    value.schemaVersion !== DURABLE_RESTART_SCHEMA_VERSION ||
    value.artifactKind !== DURABLE_JOB_SNAPSHOT_KIND ||
    typeof value.jobId !== "string" ||
    !REPORT_ID.test(value.jobId) ||
    typeof value.reportId !== "string" ||
    !REPORT_ID.test(value.reportId) ||
    value.jobId === value.reportId ||
    !JOB_STATES.has(value.state) ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0 ||
    value.attemptCount > 2 ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    value.leaseGeneration < 0 ||
    value.leaseGeneration > 2 ||
    value.leaseGeneration !== value.attemptCount
  ) {
    throw new Error("durable restart job snapshot is invalid");
  }
  canonicalInstant(value.createdAt, "durable restart job snapshot createdAt");
  if (value.finishedAt !== null) {
    canonicalInstant(
      value.finishedAt,
      "durable restart job snapshot finishedAt"
    );
    if (Date.parse(value.finishedAt) < Date.parse(value.createdAt)) {
      throw new Error(
        "durable restart job snapshot finish must not precede creation"
      );
    }
  }
  if (
    (value.state === "queued" && value.attemptCount > 1) ||
    (value.state === "leased" && value.attemptCount < 1) ||
    (["queued", "leased", "publishing"].includes(value.state) &&
      value.finishedAt !== null) ||
    (["succeeded", "failed", "expired", "cancelled"].includes(value.state) &&
      value.finishedAt === null)
  ) {
    throw new Error(
      "durable restart job snapshot state, attempts, and finish are inconsistent"
    );
  }
  if (
    expected &&
    (value.jobId !== expected.jobId || value.reportId !== expected.reportId)
  ) {
    throw new Error(
      "durable restart job snapshot does not match the admitted job and report"
    );
  }
  return value;
}

export function selectCloudflareContainerApplication(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error(
      "Cloudflare Containers application response must be a bounded array"
    );
  }
  const matches = value.filter(
    (application) =>
      application &&
      typeof application === "object" &&
      !Array.isArray(application) &&
      application.name === DURABLE_RESTART_PROVIDER_APPLICATION
  );
  if (matches.length !== 1) {
    throw new Error(
      `Cloudflare Containers must return exactly one ${DURABLE_RESTART_PROVIDER_APPLICATION} application`
    );
  }
  const application = matches[0];
  const label = `Cloudflare Containers application ${DURABLE_RESTART_PROVIDER_APPLICATION}`;
  exact(application, APPLICATION_KEYS, label);
  boundedString(application.id, `${label}.id`, UUID);
  boundedString(
    application.name,
    `${label}.name`,
    OPAQUE_PROVIDER_ID,
    128
  );
  if (
    !["active", "ready", "provisioning", "degraded"].includes(
      application.state
    )
  ) {
    throw new Error(`${label}.state is invalid`);
  }
  if (
    !Number.isSafeInteger(application.instances) ||
    application.instances < 0 ||
    application.instances > 3
  ) {
    throw new Error(`${label}.instances is invalid`);
  }
  positiveSafeInteger(application.version, `${label}.version`);
  canonicalProviderInstant(
    application.updated_at,
    `${label}.updated_at`
  );
  canonicalProviderInstant(
    application.created_at,
    `${label}.created_at`
  );
  if (
    typeof application.image !== "string" ||
    application.image.length === 0 ||
    application.image.length > 2_048
  ) {
    throw new Error(`${label}.image is invalid`);
  }
  if (application.state !== "active" || application.instances < 1) {
    throw new DurableRestartProviderUnavailableError(
      "the production Cloudflare Containers application is not active"
    );
  }
  return Object.freeze({
    id: application.id,
    name: application.name,
    state: application.state,
    instances: application.instances,
    version: application.version,
    updatedAt: canonicalProviderInstant(
      application.updated_at,
      "Cloudflare Containers application updated_at"
    ),
    createdAt: canonicalProviderInstant(
      application.created_at,
      "Cloudflare Containers application created_at"
    )
  });
}

export function normalizeCloudflareRuntimeObservation({
  application,
  instances,
  sourceSha256,
  capturedAt
}) {
  if (
    !application ||
    application.name !== DURABLE_RESTART_PROVIDER_APPLICATION ||
    application.state !== "active"
  ) {
    throw new Error("Cloudflare Containers application identity is invalid");
  }
  boundedString(
    application.id,
    "Cloudflare Containers application id",
    UUID
  );
  positiveSafeInteger(
    application.version,
    "Cloudflare Containers application version"
  );
  sha256(sourceSha256, "Cloudflare Containers provider source sha256");
  canonicalInstant(capturedAt, "Cloudflare Containers capture time");
  if (!Array.isArray(instances) || instances.length > 100) {
    throw new Error(
      "Cloudflare Containers instance response must be a bounded array"
    );
  }
  for (const [index, instance] of instances.entries()) {
    exact(
      instance,
      INSTANCE_KEYS,
      `Cloudflare Containers instance[${index}]`
    );
    boundedString(
      instance.id,
      `Cloudflare Containers instance[${index}].id`,
      OPAQUE_PROVIDER_ID
    );
    if (
      instance.name !== null &&
      (typeof instance.name !== "string" ||
        instance.name.length === 0 ||
        instance.name.length > 128 ||
        !OPAQUE_PROVIDER_ID.test(instance.name))
    ) {
      throw new Error(
        `Cloudflare Containers instance[${index}].name is invalid`
      );
    }
    if (
      !["running", "provisioning", "failed", "stopping", "stopped", "unhealthy", "inactive"].includes(
        instance.state
      )
    ) {
      throw new Error(
        `Cloudflare Containers instance[${index}].state is invalid`
      );
    }
    if (
      instance.location !== null &&
      (typeof instance.location !== "string" ||
        !LOCATION.test(instance.location))
    ) {
      throw new Error(
        `Cloudflare Containers instance[${index}].location is invalid`
      );
    }
    if (
      instance.version !== null &&
      (!Number.isSafeInteger(instance.version) || instance.version < 1)
    ) {
      throw new Error(
        `Cloudflare Containers instance[${index}].version is invalid`
      );
    }
    if (instance.created !== null) {
      canonicalProviderInstant(
        instance.created,
        `Cloudflare Containers instance[${index}].created`
      );
    }
  }
  const running = instances.filter(
    (instance) =>
      instance.name === DURABLE_RESTART_PROVIDER_INSTANCE &&
      instance.state === "running"
  );
  if (running.length === 0) return null;
  if (running.length !== 1) {
    throw new Error(
      "Cloudflare Containers returned more than one running production singleton"
    );
  }
  const instance = running[0];
  if (
    instance.version !== application.version ||
    instance.created === null ||
    instance.location === null
  ) {
    throw new Error(
      "the running production singleton does not bind the active application version"
    );
  }
  const instanceCreatedAt = canonicalProviderInstant(
    instance.created,
    "Cloudflare Containers singleton created"
  );
  if (Date.parse(instanceCreatedAt) > Date.parse(capturedAt) + 60_000) {
    throw new Error(
      "Cloudflare Containers singleton creation is implausibly after capture"
    );
  }
  const identityDigest = canonicalEvidenceDigest({
    domain: PROVIDER_IDENTITY_DOMAIN,
    application: {
      id: application.id,
      version: application.version
    },
    instance: {
      id: instance.id,
      name: instance.name,
      version: instance.version,
      createdAt: instanceCreatedAt
    }
  });
  return Object.freeze({
    applicationId: application.id,
    applicationVersion: application.version,
    instanceId: instance.id,
    instanceVersion: instance.version,
    instanceCreatedAt,
    observedAt: capturedAt,
    runtimeIdentityRef: `sha256:${identityDigest}`,
    providerObservationSha256: canonicalEvidenceDigest({
      domain: PROVIDER_OBSERVATION_DOMAIN,
      sourceSha256,
      capturedAt,
      runtimeIdentityRef: `sha256:${identityDigest}`
    })
  });
}

export function verifyDurableProductionHealth(value, expectedCommit) {
  commit(expectedCommit, "expected production deployment commit");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.deployment !== expectedCommit ||
    value.status !== "ok" ||
    !Array.isArray(value.warnings) ||
    value.warnings.length !== 0 ||
    value.checks?.durableJobs?.requested !== true ||
    value.checks?.durableJobs?.enabled !== true ||
    value.checks?.durableJobs?.readiness !== "ready"
  ) {
    throw new Error(
      "production health does not prove the exact durable-enabled deployment"
    );
  }
  return value;
}

export function verifyDurableRestartSubmission(value) {
  exact(
    value,
    ["ok", "jobId", "status", "statusPath", "reportId"],
    "durable restart scan submission"
  );
  if (
    value.ok !== true ||
    value.status !== "queued" ||
    typeof value.jobId !== "string" ||
    !REPORT_ID.test(value.jobId) ||
    typeof value.reportId !== "string" ||
    !REPORT_ID.test(value.reportId) ||
    value.jobId === value.reportId ||
    value.statusPath !== `/api/scans/${value.jobId}`
  ) {
    throw new Error("durable restart scan submission is invalid");
  }
  return value;
}

export function verifyDurableRestartReport(value, reportId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 2 ||
    value.schemaRevision !== 2 ||
    value.reportType !== "single" ||
    value.share?.id !== reportId ||
    value.share?.jsonPath !== `/api/reports/${reportId}` ||
    value.run?.subject?.requested?.origin !== "https://www.iana.org" ||
    value.run?.subject?.requested?.registrableDomain !== "iana.org" ||
    value.run?.subject?.requested?.routeShape !== "/{seg}/{seg}" ||
    value.run?.subject?.observed?.origin !== "https://www.iana.org" ||
    value.run?.subject?.observed?.registrableDomain !== "iana.org" ||
    value.run?.subject?.observed?.routeShape !== "/{seg}/{seg}" ||
    value.run?.conditions?.gpc !== true ||
    value.run?.conditions?.consent !== "observe" ||
    value.run?.conditions?.device?.kind !== "desktop" ||
    value.run?.conditions?.device?.viewport?.isMobile !== false ||
    !Number.isSafeInteger(value.run?.summary?.durationMs) ||
    value.run.summary.durationMs < 0
  ) {
    throw new Error(
      "durable restart report readback is not the fixed production synthetic"
    );
  }
  canonicalInstant(value.run.startedAt, "durable restart report startedAt");
  return value;
}

export function verifyDurableRestartEvidenceSet({
  preHealth,
  postHealth,
  recovery,
  restart,
  recoverySha256
}) {
  const pre = verifyRuntime(preHealth, "pre-health");
  const post = verifyRuntime(postHealth, "post-health");
  const recovered = verifyRecovery(recovery);
  const restarted = verifyRestart(restart);
  if (
    pre.deploymentCommit !== restarted.deploymentCommit ||
    post.deploymentCommit !== restarted.deploymentCommit ||
    pre.runtimeIdentityRef !== restarted.preRuntimeIdentityRef ||
    post.runtimeIdentityRef !== restarted.postRuntimeIdentityRef ||
    pre.runtimeIdentityRef === post.runtimeIdentityRef ||
    pre.providerObservationSha256 === post.providerObservationSha256 ||
    Date.parse(pre.observedAt) > Date.parse(restarted.startedAt) ||
    post.observedAt !== restarted.restartObservedAt ||
    Date.parse(recovered.preRestartObservedAt) >
      Date.parse(restarted.startedAt) ||
    Date.parse(recovered.preRestartJob.createdAt) >
      Date.parse(restarted.startedAt) ||
    Date.parse(recovered.terminalJob.finishedAt) <
      Date.parse(restarted.restartObservedAt) ||
    Date.parse(restarted.completedAt) <
      Date.parse(recovered.publicationIdentity.readbackAt) ||
    restarted.queuedWorkRecoverySha256 !== recoverySha256
  ) {
    throw new Error(
      "durable restart evidence set does not cross-bind the provider transition and queued recovery"
    );
  }
  return Object.freeze({
    deploymentCommit: restarted.deploymentCommit,
    restartObservedAt: restarted.restartObservedAt,
    evidenceDigest: canonicalEvidenceDigest({
      preHealth: pre,
      postHealth: post,
      recovery: recovered,
      restart: restarted
    })
  });
}

export async function captureDurableRestartEvidence(
  {
    expectedCommit,
    admission,
    leasePolls = 80,
    restartCommandPolls = 5,
    restartPolls = 120,
    completionPolls = 600,
    pollIntervalMs = 2_000,
    leasePollIntervalMs = 250
  },
  dependencies
) {
  commit(expectedCommit, "expected durable restart deployment commit");
  for (const [label, value, maximum] of [
    ["leasePolls", leasePolls, 1_000],
    ["restartCommandPolls", restartCommandPolls, 10],
    ["restartPolls", restartPolls, 1_000],
    ["completionPolls", completionPolls, 2_000],
    ["pollIntervalMs", pollIntervalMs, 30_000],
    ["leasePollIntervalMs", leasePollIntervalMs, 30_000]
  ]) {
    positiveSafeInteger(value, label, maximum);
  }
  for (const method of [
    "readHealth",
    "readRuntime",
    "submitScan",
    "readJobEvidence",
    "restartRuntime",
    "readReport",
    "wait",
    "now"
  ]) {
    if (typeof dependencies?.[method] !== "function") {
      throw new Error(`durable restart capture requires dependency ${method}`);
    }
  }

  verifyDurableProductionHealth(
    await dependencies.readHealth(),
    expectedCommit
  );
  const pre = await dependencies.readRuntime();
  if (!pre) {
    throw new Error(
      "Cloudflare did not expose one running production singleton before restart"
    );
  }
  const submission = verifyDurableRestartSubmission(
    await dependencies.submitScan(admission)
  );
  const expectedJob = {
    jobId: submission.jobId,
    reportId: submission.reportId
  };

  let leased = null;
  for (let index = 0; index < leasePolls; index += 1) {
    const snapshot = verifyDurableRestartJobSnapshot(
      await dependencies.readJobEvidence(admission, expectedJob),
      expectedJob
    );
    if (
      snapshot.state === "leased" &&
      snapshot.attemptCount === 1 &&
      snapshot.finishedAt === null
    ) {
      leased = snapshot;
      break;
    }
    if (snapshot.state !== "queued") {
      throw new Error(
        `durable restart ceremony reached ${snapshot.state} before the provider restart`
      );
    }
    await dependencies.wait(leasePollIntervalMs);
  }
  if (!leased) {
    throw new Error(
      "durable restart ceremony did not observe the first execution lease"
    );
  }

  const startedAt = canonicalNow(dependencies.now);
  if (Date.parse(leased.createdAt) > Date.parse(startedAt)) {
    throw new Error("durable job creation is after the restart command");
  }
  let preRestartJob = null;
  for (
    let index = 0;
    index < restartCommandPolls;
    index += 1
  ) {
    const candidate = await dependencies.restartRuntime(
      admission,
      expectedJob,
      leased
    );
    if (candidate !== null && candidate !== undefined) {
      preRestartJob = verifyDurableRestartJobSnapshot(
        candidate,
        expectedJob
      );
      break;
    }
    if (index + 1 < restartCommandPolls) {
      await dependencies.wait(pollIntervalMs);
    }
  }
  if (!preRestartJob) {
    throw new Error(
      "the provider-native destroy response remained unavailable after bounded exact-request retries"
    );
  }
  if (
    preRestartJob.state !== "leased" ||
    preRestartJob.attemptCount !== 1 ||
    preRestartJob.leaseGeneration !== 1 ||
    preRestartJob.finishedAt !== null ||
    preRestartJob.createdAt !== leased.createdAt
  ) {
    throw new Error(
      "the provider-native destroy boundary did not authenticate the first fenced lease"
    );
  }

  let post = null;
  for (let index = 0; index < restartPolls; index += 1) {
    const health = await dependencies.readHealth({ transient: true });
    if (health !== null && health !== undefined) {
      verifyDurableProductionHealth(health, expectedCommit);
    }
    const observed = await dependencies.readRuntime({
      transient: true
    });
    if (
      observed &&
      observed.runtimeIdentityRef !== pre.runtimeIdentityRef
    ) {
      if (
        observed.applicationId !== pre.applicationId ||
        observed.applicationVersion !== pre.applicationVersion ||
        observed.instanceVersion !== pre.instanceVersion ||
        Date.parse(observed.instanceCreatedAt) <
          Date.parse(startedAt) - 60_000 ||
        Date.parse(observed.observedAt) < Date.parse(startedAt)
      ) {
        throw new Error(
          "Cloudflare runtime transition changed deployment identity or predates the restart command"
        );
      }
      post = observed;
      break;
    }
    await dependencies.wait(pollIntervalMs);
  }
  if (!post) {
    throw new Error(
      "Cloudflare did not expose a distinct running singleton after restart"
    );
  }

  let completed = null;
  for (let index = 0; index < completionPolls; index += 1) {
    const snapshot = verifyDurableRestartJobSnapshot(
      await dependencies.readJobEvidence(admission, expectedJob),
      expectedJob
    );
    if (snapshot.state === "succeeded") {
      completed = snapshot;
      break;
    }
    if (["failed", "expired", "cancelled"].includes(snapshot.state)) {
      throw new Error(
        `durable restart recovery ended in terminal state ${snapshot.state}`
      );
    }
    await dependencies.wait(pollIntervalMs);
  }
  if (!completed) {
    throw new Error("durable restart recovery did not finish in time");
  }
  if (
    completed.attemptCount !== 2 ||
    completed.finishedAt === null ||
    Date.parse(completed.finishedAt) < Date.parse(post.observedAt)
  ) {
    throw new Error(
      "durable restart recovery did not prove a second fenced attempt after the provider transition"
    );
  }

  const reportReadback = await dependencies.readReport(
    completed.reportId,
    admission
  );
  if (
    !reportReadback ||
    !(reportReadback.bytes instanceof Uint8Array) ||
    reportReadback.bytes.byteLength === 0 ||
    reportReadback.bytes.byteLength > DURABLE_RESTART_MAX_REPORT_BYTES
  ) {
    throw new Error("durable restart report readback bytes are invalid");
  }
  verifyDurableRestartReport(reportReadback.value, completed.reportId);
  const reportSha256 = sha256Bytes(reportReadback.bytes);
  const completedAt = canonicalNow(dependencies.now);
  if (Date.parse(completedAt) < Date.parse(completed.finishedAt)) {
    throw new Error("durable restart ceremony completed before the durable job");
  }

  const preHealth = {
    schemaVersion: DURABLE_RESTART_SCHEMA_VERSION,
    artifactKind: DURABLE_RUNTIME_OBSERVATION_KIND,
    deploymentCommit: expectedCommit,
    observedAt: pre.observedAt,
    runtimeIdentityRef: pre.runtimeIdentityRef,
    provider: "cloudflare-containers-api",
    providerObservationSha256: pre.providerObservationSha256
  };
  const postHealth = {
    schemaVersion: DURABLE_RESTART_SCHEMA_VERSION,
    artifactKind: DURABLE_RUNTIME_OBSERVATION_KIND,
    deploymentCommit: expectedCommit,
    observedAt: post.observedAt,
    runtimeIdentityRef: post.runtimeIdentityRef,
    provider: "cloudflare-containers-api",
    providerObservationSha256: post.providerObservationSha256
  };
  const recovery = {
    schemaVersion: DURABLE_RESTART_SCHEMA_VERSION,
    artifactKind: DURABLE_RECOVERY_EVIDENCE_KIND,
    preRestartObservedAt: startedAt,
    preRestartJob,
    terminalJob: completed,
    publicationIdentity: {
      reportId: completed.reportId,
      jsonPath: `/api/reports/${completed.reportId}`,
      readbackAt: completedAt,
      reportSha256
    }
  };
  const recoveryBytes = serializeDurableRestartEvidence(
    recovery,
    "queued-work-recovery"
  );
  const restart = {
    schemaVersion: DURABLE_RESTART_SCHEMA_VERSION,
    artifactKind: DURABLE_RESTART_EVIDENCE_KIND,
    deploymentCommit: expectedCommit,
    startedAt,
    restartObservedAt: post.observedAt,
    completedAt,
    preRuntimeIdentityRef: pre.runtimeIdentityRef,
    postRuntimeIdentityRef: post.runtimeIdentityRef,
    queuedWorkRecoverySha256: sha256Bytes(recoveryBytes)
  };
  verifyDurableRestartEvidenceSet({
    preHealth,
    postHealth,
    recovery,
    restart,
    recoverySha256: sha256Bytes(recoveryBytes)
  });
  return Object.freeze({
    "pre-health.json": Object.freeze(preHealth),
    "post-health.json": Object.freeze(postHealth),
    "queued-work-recovery.json": Object.freeze(recovery),
    "restart-evidence.json": Object.freeze(restart)
  });
}

function canonicalNow(now) {
  const sampled = now();
  const millis =
    sampled instanceof Date
      ? sampled.getTime()
      : typeof sampled === "number"
        ? sampled
        : Date.parse(sampled);
  if (!Number.isFinite(millis)) {
    throw new Error("durable restart capture clock returned an invalid instant");
  }
  return new Date(millis).toISOString();
}

export function parseDurableRestartEvidence(bytes, kind) {
  let text;
  if (typeof bytes === "string") {
    if (
      Buffer.byteLength(bytes, "utf8") >
      DURABLE_RESTART_MAX_FILE_BYTES
    ) {
      throw new Error(
        `${kind} exceeds the durable restart evidence byte limit`
      );
    }
    text = bytes;
  } else if (
    bytes instanceof Uint8Array &&
    bytes.byteLength <= DURABLE_RESTART_MAX_FILE_BYTES
  ) {
    try {
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true
      }).decode(bytes);
    } catch {
      throw new Error(`${kind} is not valid UTF-8`);
    }
  } else {
    throw new Error(
      `${kind} must be bounded durable restart evidence bytes`
    );
  }
  const value = parseCanonicalEvidence(text, kind);
  if (kind === "pre-health" || kind === "post-health") {
    return verifyRuntime(value, kind);
  }
  if (kind === "queued-work-recovery") return verifyRecovery(value);
  if (kind === "restart-evidence") return verifyRestart(value);
  throw new Error(`unknown durable restart evidence kind ${kind}`);
}

export function serializeDurableRestartEvidence(value, kind) {
  if (kind === "pre-health" || kind === "post-health") {
    verifyRuntime(value, kind);
  } else if (kind === "queued-work-recovery") {
    verifyRecovery(value);
  } else if (kind === "restart-evidence") {
    verifyRestart(value);
  } else {
    throw new Error(`unknown durable restart evidence kind ${kind}`);
  }
  return serializeCanonicalEvidence(value);
}
