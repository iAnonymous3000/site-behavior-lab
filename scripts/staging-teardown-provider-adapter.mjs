// Provider-independent orchestration for the destructive staging teardown.
// Network authority lives only in the two exact provider clients imported
// below; the orchestrator first inventories the complete fixed contract, then
// removes in dependency order, and finally inventories the complete contract
// again. No mutation can begin if even one before-observation is malformed.

import {
  createCompositeStagingTeardownProviderAdapter,
  STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND
} from "./staging-teardown-provider-adapters.mjs";
import { STAGING_RESOURCE_CONTRACT } from "./staging-teardown-evidence-lib.mjs";

export const STAGING_TEARDOWN_ADAPTER_CAPABILITIES = Object.freeze([
  "observe",
  "remove"
]);

const FULL_SHA = /^[0-9a-f]{40}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalInstant(now, label) {
  const raw = now();
  const value = raw instanceof Date ? raw : new Date(raw);
  requireValue(Number.isFinite(value.getTime()), `${label} clock value is invalid`);
  const instant = value.toISOString();
  requireValue(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant),
    `${label} must be a millisecond-precision UTC instant`
  );
  return instant;
}

function requireMonotonic(previous, next, label) {
  requireValue(Date.parse(next) >= Date.parse(previous), `${label} clock moved backwards`);
}

/** Validate an adapter's shape before any resource is touched. */
export function validateStagingTeardownProviderAdapter(adapter) {
  requireValue(
    adapter !== null && typeof adapter === "object",
    "staging teardown provider adapter must be an object"
  );
  requireValue(
    typeof adapter.kind === "string" && adapter.kind.length > 0 && adapter.kind.length <= 64,
    "staging teardown provider adapter must declare a bounded kind"
  );
  for (const capability of STAGING_TEARDOWN_ADAPTER_CAPABILITIES) {
    requireValue(
      typeof adapter[capability] === "function",
      `staging teardown provider adapter must implement ${capability}()`
    );
  }
  if (adapter.removalOrder !== undefined) {
    requireValue(
      Array.isArray(adapter.removalOrder) &&
        adapter.removalOrder.length === STAGING_RESOURCE_CONTRACT.length &&
        new Set(adapter.removalOrder).size === STAGING_RESOURCE_CONTRACT.length &&
        STAGING_RESOURCE_CONTRACT.every((resource) => adapter.removalOrder.includes(resource.logicalName)),
      "staging teardown adapter removalOrder must be an exact permutation of the fixed resource contract"
    );
  }
  return adapter;
}

function validateResources(resources) {
  requireValue(
    Array.isArray(resources) && resources.length === STAGING_RESOURCE_CONTRACT.length,
    `the teardown ceremony must declare exactly ${STAGING_RESOURCE_CONTRACT.length} canonical resources`
  );
  for (const [index, expected] of STAGING_RESOURCE_CONTRACT.entries()) {
    const resource = resources[index];
    requireValue(
      resource !== null && typeof resource === "object" &&
        resource.kind === expected.kind &&
        resource.logicalName === expected.logicalName &&
        resource.removalDisposition === expected.removalDisposition,
      `teardown resource ${index} must be exactly ${expected.kind}:${expected.logicalName}:${expected.removalDisposition}`
    );
  }
  return resources;
}

function requireEvidence(value, logicalName, expectedKind, sessionId) {
  requireValue(
    value !== null && typeof value === "object" &&
      Object.keys(value).sort().join(",") === "bytes,kind,sessionId" &&
      value.kind === expectedKind && value.sessionId === sessionId &&
      (typeof value.bytes === "string" || value.bytes instanceof Uint8Array),
    `${logicalName} must carry exact ${expectedKind} evidence for this session`
  );
  const byteLength = typeof value.bytes === "string"
    ? Buffer.byteLength(value.bytes, "utf8")
    : value.bytes.byteLength;
  requireValue(
    byteLength >= 1 && byteLength <= 1024 * 1024,
    `${logicalName} provider evidence must contain 1 through 1048576 bytes`
  );
  return value;
}

function requireObservation(value, logicalName, phase, sessionId) {
  requireValue(
    value !== null && typeof value === "object",
    `adapter ${phase} observation for ${logicalName} must be an object`
  );
  requireValue(
    value.state === "present" || value.state === "absent",
    `adapter ${phase} observation for ${logicalName} must report present or absent`
  );
  requireValue(
    Array.isArray(value.externalIds),
    `adapter ${phase} observation for ${logicalName} must report external ids`
  );
  const sorted = [...value.externalIds].sort();
  requireValue(
    value.externalIds.every(
      (id, index) => typeof id === "string" && OPAQUE.test(id) && id === sorted[index]
    ) && new Set(value.externalIds).size === value.externalIds.length,
    `adapter ${phase} observation for ${logicalName} external ids must be unique, sorted, bounded opaque strings`
  );
  requireValue(
    value.state === "present" ? value.externalIds.length >= 1 : value.externalIds.length === 0,
    `adapter ${phase} observation for ${logicalName} external ids do not match its state`
  );
  requireEvidence(value.evidence, logicalName, "provider-inventory-response", sessionId);
  return value;
}

/**
 * Inventory all twelve exact resources, remove present resources in the
 * adapter's dependency order, and prove all twelve absent. The returned action
 * array remains in the fixed evidence-contract order.
 */
export async function runStagingTeardown({
  adapter,
  resources,
  session,
  stagingSourceCommit,
  now
}) {
  validateStagingTeardownProviderAdapter(adapter);
  const exactResources = validateResources(resources);
  requireValue(typeof now === "function", "runStagingTeardown requires an injected clock");
  requireValue(
    typeof stagingSourceCommit === "string" && FULL_SHA.test(stagingSourceCommit),
    "runStagingTeardown requires the exact lowercase staging source commit"
  );
  requireValue(
    session !== null && typeof session === "object" &&
      typeof session.id === "string" && UUID_V4.test(session.id),
    "runStagingTeardown requires a canonical lowercase UUIDv4 session id"
  );

  const startedAt = canonicalInstant(now, "session.startedAt");
  const before = [];
  for (const resource of exactResources) {
    const observation = requireObservation(
      await adapter.observe(resource.logicalName, {
        phase: "before",
        sessionId: session.id
      }),
      resource.logicalName,
      "before",
      session.id
    );
    before.push({
      kind: resource.kind,
      logicalName: resource.logicalName,
      externalIds: observation.externalIds,
      state: observation.state,
      evidenceArtifact: observation.evidence
    });
  }
  requireValue(
    before.some((resource) => resource.state === "present"),
    "the complete before-inventory is already absent; refusing to claim or perform a teardown"
  );
  const inventoryBeforeAt = canonicalInstant(now, "session.inventoryBeforeAt");
  requireMonotonic(startedAt, inventoryBeforeAt, "before inventory");

  const resourceByName = new Map(exactResources.map((resource) => [resource.logicalName, resource]));
  const beforeByName = new Map(before.map((resource) => [resource.logicalName, resource]));
  const removalOrder = adapter.removalOrder ?? exactResources.map((resource) => resource.logicalName);
  const actionsByName = new Map();
  let previousActionAt = inventoryBeforeAt;
  for (const logicalName of removalOrder) {
    const resource = resourceByName.get(logicalName);
    const observed = beforeByName.get(logicalName);
    if (observed.state !== "present") {
      const completedAt = canonicalInstant(now, `${logicalName} already-absent action`);
      requireMonotonic(previousActionAt, completedAt, `${logicalName} action`);
      previousActionAt = completedAt;
      actionsByName.set(logicalName, {
        kind: resource.kind,
        logicalName,
        externalIds: [],
        disposition: "already-absent",
        completedAt,
        evidenceArtifact: observed.evidenceArtifact
      });
      continue;
    }
    const removal = await adapter.remove(logicalName, observed.externalIds, {
      sessionId: session.id
    });
    requireValue(
      removal !== null && typeof removal === "object",
      `adapter remove() for ${logicalName} must return an object`
    );
    requireEvidence(
      removal.evidence,
      logicalName,
      "provider-removal-response",
      session.id
    );
    const completedAt = canonicalInstant(now, `${logicalName} removal action`);
    requireMonotonic(previousActionAt, completedAt, `${logicalName} action`);
    previousActionAt = completedAt;
    actionsByName.set(logicalName, {
      kind: resource.kind,
      logicalName,
      externalIds: observed.externalIds,
      disposition: resource.removalDisposition,
      completedAt,
      evidenceArtifact: removal.evidence
    });
  }
  const actions = exactResources.map((resource) => actionsByName.get(resource.logicalName));

  const after = [];
  for (const resource of exactResources) {
    const observation = requireObservation(
      await adapter.observe(resource.logicalName, {
        phase: "after",
        sessionId: session.id
      }),
      resource.logicalName,
      "after",
      session.id
    );
    requireValue(
      observation.state === "absent",
      `${resource.logicalName} is still present after teardown; the ceremony did not complete`
    );
    after.push({
      kind: resource.kind,
      logicalName: resource.logicalName,
      externalIds: observation.externalIds,
      state: observation.state,
      evidenceArtifact: observation.evidence
    });
  }
  const inventoryAfterAt = canonicalInstant(now, "session.inventoryAfterAt");
  const latestActionAt = actions.reduce(
    (latest, action) => Date.parse(action.completedAt) > Date.parse(latest) ? action.completedAt : latest,
    inventoryBeforeAt
  );
  requireMonotonic(latestActionAt, inventoryAfterAt, "after inventory");
  const completedAt = canonicalInstant(now, "session.completedAt");
  requireMonotonic(inventoryAfterAt, completedAt, "session completion");

  const exactSession = {
    id: session.id,
    startedAt,
    inventoryBeforeAt,
    inventoryAfterAt,
    completedAt
  };
  return {
    stagingSourceCommit,
    recordedAt: completedAt,
    session: exactSession,
    inventory: { before, actions, after }
  };
}

/** Resolve only the reviewed exact Cloudflare/GitHub composite. */
export function resolveStagingTeardownProviderAdapter(kind, options) {
  requireValue(
    kind === STAGING_TEARDOWN_COMPOSITE_ADAPTER_KIND,
    `unsupported staging teardown provider adapter kind ${String(kind)}`
  );
  requireValue(
    options !== null && typeof options === "object",
    "exact staging teardown adapter options are required"
  );
  return createCompositeStagingTeardownProviderAdapter(options);
}
