// The contract a staging-teardown provider adapter must satisfy, and the
// orchestration that turns one into a sanitized transcript.
//
// WHAT THIS IS NOT: a provider adapter. No adapter is registered here, and
// resolveStagingTeardownProviderAdapter refuses every kind. The executable
// capture in scripts/staging-teardown-hosted-capture.mjs continues to refuse
// unconditionally. Nothing in this file performs a network call, holds a
// credential, or deletes a resource, and its presence must not be read as
// operational readiness: the destructive credential scopes and the runner
// authority this ceremony needs are unapproved.
//
// WHAT THIS IS: the seam. Every existing reviewed adapter in this repository is
// read-only (the WAF lane takes Zone WAF Read plus Account Analytics Read; the
// restart lane forbids Edit and Write outright). Staging teardown is the first
// destructive one, so its shape should be settled, reviewed, and exercised
// against fixtures BEFORE anyone provisions a token that can delete a Worker.
// An injected adapter also means the whole pipeline runs in CI with no
// credential at all, which is the only way this code is testable.
//
// The orchestration is deliberately ignorant of any provider. It asks the
// adapter to observe, to remove what it observed present, and to observe again,
// and it records what happened. It never infers absence from a failed removal,
// and it never treats "nothing was there" as a teardown: an all-already-absent
// transcript is refused downstream by staging-teardown-evidence-lib.mjs.

/** Every resource kind the teardown contract can name. */
export const STAGING_TEARDOWN_ADAPTER_CAPABILITIES = Object.freeze([
  "observe",
  "remove"
]);

/**
 * Adapter shape.
 *
 * @typedef {object} StagingTeardownProviderAdapter
 * @property {string} kind Provider identifier, recorded but never trusted.
 * @property {(logicalName: string) => Promise<{state: "present"|"absent", externalIds: string[], evidence: object}>} observe
 * @property {(logicalName: string, externalIds: string[]) => Promise<{evidence: object}>} remove
 */

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
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
  return adapter;
}

function requireObservation(value, logicalName, phase) {
  requireValue(
    value !== null && typeof value === "object",
    `adapter ${phase} observation for ${logicalName} must be an object`
  );
  requireValue(
    value.state === "present" || value.state === "absent",
    `adapter ${phase} observation for ${logicalName} must report present or absent`
  );
  requireValue(
    Array.isArray(value.externalIds) && value.externalIds.every((id) => typeof id === "string"),
    `adapter ${phase} observation for ${logicalName} must report string external ids`
  );
  requireValue(
    value.evidence !== null && typeof value.evidence === "object",
    `adapter ${phase} observation for ${logicalName} must carry provider evidence`
  );
  requireValue(
    value.state === "present" || value.externalIds.length === 0,
    `adapter ${phase} observation for ${logicalName} reported absent with external ids`
  );
  return value;
}

/**
 * Run a teardown against an adapter and return the sanitized transcript shape
 * that staging-teardown-evidence-lib.mjs consumes.
 *
 * `resources` must be the FULL contract, every resource inventoried. That is
 * not in tension with letting a never-provisioned half be scoped out: the
 * inventory is how absence is proven, so a resource that was never deployed is
 * recorded as observed-absent rather than omitted. The downstream validator
 * (staging-teardown-evidence-lib.mjs) requires exactly
 * STAGING_RESOURCE_CONTRACT.length entries and would refuse a subset, and it
 * separately requires at least one resource observed present and removed, so a
 * transcript can neither shrink its scope nor claim a teardown it did not
 * perform.
 */
export async function runStagingTeardown({
  adapter,
  resources,
  session,
  stagingSourceCommit,
  now
}) {
  validateStagingTeardownProviderAdapter(adapter);
  requireValue(
    Array.isArray(resources) && resources.length > 0,
    "the teardown ceremony must declare at least one resource in scope"
  );
  requireValue(
    new Set(resources.map((resource) => resource.logicalName)).size === resources.length,
    "the teardown ceremony must not name a resource twice"
  );
  requireValue(typeof now === "function", "runStagingTeardown requires an injected clock");

  const before = [];
  for (const resource of resources) {
    const observation = requireObservation(
      await adapter.observe(resource.logicalName),
      resource.logicalName,
      "before"
    );
    before.push({
      kind: resource.kind,
      logicalName: resource.logicalName,
      externalIds: observation.externalIds,
      state: observation.state,
      evidenceArtifact: observation.evidence
    });
  }

  const actions = [];
  for (const [index, resource] of resources.entries()) {
    const observed = before[index];
    if (observed.state !== "present") {
      // Never call remove() on something we did not observe. A removal of an
      // absent resource returns success on most providers, which would let a
      // transcript claim a teardown that never happened.
      actions.push({
        kind: resource.kind,
        logicalName: resource.logicalName,
        externalIds: [],
        disposition: "already-absent",
        completedAt: now(),
        evidenceArtifact: observed.evidenceArtifact
      });
      continue;
    }
    const removal = await adapter.remove(resource.logicalName, observed.externalIds);
    requireValue(
      removal !== null && typeof removal === "object" && removal.evidence !== null &&
        typeof removal.evidence === "object",
      `adapter remove() for ${resource.logicalName} must carry provider evidence`
    );
    actions.push({
      kind: resource.kind,
      logicalName: resource.logicalName,
      externalIds: observed.externalIds,
      disposition: resource.removalDisposition,
      completedAt: now(),
      evidenceArtifact: removal.evidence
    });
  }

  const after = [];
  for (const resource of resources) {
    const observation = requireObservation(
      await adapter.observe(resource.logicalName),
      resource.logicalName,
      "after"
    );
    // The whole point of the second inventory: a removal call that returned
    // success proves an API accepted a request, not that the resource is gone.
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

  return {
    stagingSourceCommit,
    recordedAt: now(),
    session,
    inventory: { before, actions, after }
  };
}

/**
 * Resolve a provider adapter by kind.
 *
 * Refuses every kind, by design and not by omission. Registering one is a
 * reviewed change that must arrive together with the approved destructive
 * credential scopes and the runner authority; until then the seam exists and
 * the capability does not.
 */
export function resolveStagingTeardownProviderAdapter(kind) {
  throw new Error(
    `no reviewed staging teardown provider adapter is registered for ${String(kind)}; ` +
      "the destructive credential scopes and runner authority this ceremony needs are unapproved"
  );
}
