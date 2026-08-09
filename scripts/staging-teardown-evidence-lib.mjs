import {
  boundedString,
  canonicalEvidenceDigest,
  exactKeys,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence,
  sha256Bytes
} from "./operator-evidence-common.mjs";

export const STAGING_TEARDOWN_EVIDENCE_KIND =
  "site-behavior-staging-teardown-session-receipt";
export const STAGING_TEARDOWN_EVIDENCE_SCHEMA_VERSION = 2;
export const STAGING_TEARDOWN_EVIDENCE_PATH =
  "research/ops-evidence/staging-teardown.json";
export const STAGING_TEARDOWN_TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024;

export const STAGING_RESOURCE_CONTRACT = Object.freeze([
  Object.freeze({
    kind: "worker",
    logicalName: "site-behavior-lab-scanner-staging",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "worker",
    logicalName: "site-behavior-lab-watch-staging",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "dns",
    logicalName: "scan-staging.sitebehavior.org",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "dns",
    logicalName: "scan-watch-staging.sitebehavior.org",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "container",
    logicalName: "site-behavior-lab-scanner-staging-container",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "container",
    logicalName: "site-behavior-lab-watch-staging-container",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "r2-bucket",
    logicalName: "site-behavior-lab-reports-staging",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "r2-bucket",
    logicalName: "site-behavior-lab-reports-watch-staging",
    removalDisposition: "deleted"
  }),
  Object.freeze({
    kind: "credential-set",
    logicalName: "durable-replay-staging-only-authority",
    removalDisposition: "revoked"
  }),
  Object.freeze({
    kind: "credential-set",
    logicalName: "encrypted-watch-staging-only-authority",
    removalDisposition: "revoked"
  }),
  Object.freeze({
    kind: "fault-hook",
    logicalName: "durable-replay-staging-fault-hook",
    removalDisposition: "disabled"
  }),
  Object.freeze({
    kind: "runner-registration",
    logicalName: "durable-replay-staging-runner-registration",
    removalDisposition: "unregistered"
  })
]);

const RECEIPT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "stagingSourceCommit",
  "targetManifestSha256",
  "recordedAt",
  "session",
  "inventory",
  "sourceArtifact",
  "teardownInventoryDigest"
];
const TRANSCRIPT_KEYS = [
  "stagingSourceCommit",
  "targetManifestSha256",
  "recordedAt",
  "session",
  "inventory"
];
const SESSION_KEYS = [
  "id",
  "startedAt",
  "inventoryBeforeAt",
  "inventoryAfterAt",
  "completedAt"
];
const INVENTORY_KEYS = ["before", "actions", "after"];
const OBSERVATION_KEYS = [
  "kind",
  "logicalName",
  "externalIds",
  "state",
  "evidenceRef"
];
const ACTION_KEYS = [
  "kind",
  "logicalName",
  "externalIds",
  "disposition",
  "completedAt",
  "evidenceRef"
];
const EVIDENCE_REF_KEYS = ["kind", "sessionId", "digest"];
const EVIDENCE_ARTIFACT_KEYS = ["kind", "sessionId", "bytes"];
const TRANSCRIPT_OBSERVATION_KEYS = [
  "kind",
  "logicalName",
  "externalIds",
  "state",
  "evidenceArtifact"
];
const TRANSCRIPT_ACTION_KEYS = [
  "kind",
  "logicalName",
  "externalIds",
  "disposition",
  "completedAt",
  "evidenceArtifact"
];
const SOURCE_ARTIFACT_KEYS = ["kind", "digest", "byteLength"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const INVENTORY_EVIDENCE_KIND = "provider-inventory-response";
const REMOVAL_EVIDENCE_KIND = "provider-removal-response";
const EXTERNAL_ID_DOMAIN =
  "site-behavior-lab-staging-teardown-external-id-v1\u0000";

export function stagingTeardownInventoryDigest(session, inventory) {
  return canonicalEvidenceDigest({ session, inventory });
}

function evidenceRefProblems(
  evidenceRef,
  label,
  sessionId,
  expectedKinds
) {
  const problems = [];
  if (!exactKeys(evidenceRef, EVIDENCE_REF_KEYS, label, problems)) {
    return problems;
  }
  if (!expectedKinds.includes(evidenceRef.kind)) {
    problems.push(
      `${label}.kind must be exactly ${expectedKinds.join(" or ")}`
    );
  }
  if (evidenceRef.sessionId !== sessionId) {
    problems.push(`${label}.sessionId must match the teardown session`);
  }
  if (
    typeof evidenceRef.digest !== "string" ||
    !SHA256_REF.test(evidenceRef.digest)
  ) {
    problems.push(`${label}.digest must be an exact sha256:<64 lowercase hex> reference`);
  }
  return problems;
}

function resourceMap(resources, label, problems, sessionId) {
  if (!Array.isArray(resources) || resources.length !== STAGING_RESOURCE_CONTRACT.length) {
    problems.push(
      `${label} must contain exactly ${STAGING_RESOURCE_CONTRACT.length} canonical resources`
    );
    return null;
  }
  const result = new Map();
  for (const [index, expected] of STAGING_RESOURCE_CONTRACT.entries()) {
    const resource = resources[index];
    const entryLabel = `${label}[${index}]`;
    if (!exactKeys(resource, OBSERVATION_KEYS, entryLabel, problems)) continue;
    if (resource.kind !== expected.kind) {
      problems.push(`${entryLabel}.kind must be exactly ${expected.kind}`);
    }
    if (resource.logicalName !== expected.logicalName) {
      problems.push(`${entryLabel}.logicalName must be exactly ${expected.logicalName}`);
    }
    if (!["present", "absent"].includes(resource.state)) {
      problems.push(`${entryLabel}.state must be present or absent`);
    }
    if (!Array.isArray(resource.externalIds)) {
      problems.push(`${entryLabel}.externalIds must be an array`);
    } else {
      const sorted = [...resource.externalIds].sort();
      if (
        resource.externalIds.some(
          (entry, entryIndex) =>
            !boundedString(entry, { maximum: 512, pattern: OPAQUE }) ||
            entry !== sorted[entryIndex]
        ) ||
        new Set(resource.externalIds).size !== resource.externalIds.length
      ) {
        problems.push(
          `${entryLabel}.externalIds must be unique, sorted, non-secret opaque identifiers`
        );
      }
      if (resource.state === "present" && resource.externalIds.length === 0) {
        problems.push(`${entryLabel}.externalIds must identify every present resource`);
      }
      if (resource.state === "absent" && resource.externalIds.length !== 0) {
        problems.push(`${entryLabel}.externalIds must be empty when state is absent`);
      }
    }
    problems.push(
      ...evidenceRefProblems(
        resource.evidenceRef,
        `${entryLabel}.evidenceRef`,
        sessionId,
        [INVENTORY_EVIDENCE_KIND]
      )
    );
    result.set(expected.logicalName, resource);
  }
  return result;
}

function actionProblems(actions, beforeByName, session) {
  const problems = [];
  if (!Array.isArray(actions) || actions.length !== STAGING_RESOURCE_CONTRACT.length) {
    problems.push(
      `inventory.actions must contain exactly ${STAGING_RESOURCE_CONTRACT.length} canonical actions`
    );
    return problems;
  }
  const startedAt = Date.parse(session.startedAt);
  const inventoryBeforeAt = Date.parse(session.inventoryBeforeAt);
  const inventoryAfterAt = Date.parse(session.inventoryAfterAt);
  const completedAt = Date.parse(session.completedAt);
  for (const [index, expected] of STAGING_RESOURCE_CONTRACT.entries()) {
    const action = actions[index];
    const label = `inventory.actions[${index}]`;
    if (!exactKeys(action, ACTION_KEYS, label, problems)) continue;
    if (action.kind !== expected.kind) {
      problems.push(`${label}.kind must be exactly ${expected.kind}`);
    }
    if (action.logicalName !== expected.logicalName) {
      problems.push(`${label}.logicalName must be exactly ${expected.logicalName}`);
    }
    const before = beforeByName?.get(expected.logicalName);
    const expectedDisposition =
      before?.state === "present" ? expected.removalDisposition : "already-absent";
    if (action.disposition !== expectedDisposition) {
      problems.push(`${label}.disposition must be exactly ${expectedDisposition}`);
    }
    if (
      !Array.isArray(action.externalIds) ||
      action.externalIds.length !== (before?.externalIds?.length ?? -1) ||
      action.externalIds.some((entry, entryIndex) => entry !== before.externalIds[entryIndex])
    ) {
      problems.push(`${label}.externalIds must exactly match the before inventory`);
    }
    const actionAt = requireCanonicalInstant(
      action.completedAt,
      `${label}.completedAt`,
      problems
    );
    if (
      actionAt !== null &&
      Number.isFinite(startedAt) &&
      Number.isFinite(completedAt) &&
      (actionAt < startedAt || actionAt > completedAt)
    ) {
      problems.push(`${label}.completedAt must fall inside the teardown session`);
    }
    if (
      actionAt !== null &&
      Number.isFinite(inventoryBeforeAt) &&
      Number.isFinite(inventoryAfterAt) &&
      (actionAt < inventoryBeforeAt || actionAt > inventoryAfterAt)
    ) {
      problems.push(
        `${label}.completedAt must follow before-inventory and precede after-inventory`
      );
    }
    const expectedEvidenceKind =
      action.disposition === "already-absent"
        ? INVENTORY_EVIDENCE_KIND
        : REMOVAL_EVIDENCE_KIND;
    problems.push(
      ...evidenceRefProblems(
        action.evidenceRef,
        `${label}.evidenceRef`,
        session.id,
        [expectedEvidenceKind]
      )
    );
  }

  // A receipt in which every resource was already absent is not evidence of a
  // teardown. It proves only that nothing was there, which is exactly what a
  // rerun of a completed ceremony produces, and what an unprovisioned
  // environment produces: both would otherwise validate and be archived as
  // proof that staging was destroyed.
  //
  // Deliberately NOT "all twelve contract resources must have been present".
  // A ceremony may legitimately scope out a half that was never deployed, so
  // the requirement is participation, not completeness: at least one resource
  // observed present and then removed under its contract disposition.
  const participating = STAGING_RESOURCE_CONTRACT.filter((expected, index) => {
    const before = beforeByName?.get(expected.logicalName);
    return (
      before?.state === "present" &&
      actions[index]?.disposition === expected.removalDisposition
    );
  });
  if (participating.length === 0) {
    problems.push(
      "inventory must show at least one resource observed present and removed; " +
        "an all-already-absent receipt proves only that nothing was there"
    );
  }

  return problems;
}

export function validateStagingTeardownEvidence(value) {
  const problems = [];
  if (!exactKeys(value, RECEIPT_KEYS, "staging teardown receipt", problems)) {
    return {
      ok: false,
      problems,
      bindings: null,
      stagingSourceCommit: null,
      targetManifestSha256: null,
      recordedAt: null,
      teardownInventoryDigest: null,
      receiptDigest: null
    };
  }
  if (value.schemaVersion !== STAGING_TEARDOWN_EVIDENCE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be exactly ${STAGING_TEARDOWN_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (value.artifactKind !== STAGING_TEARDOWN_EVIDENCE_KIND) {
    problems.push(`artifactKind must be exactly ${STAGING_TEARDOWN_EVIDENCE_KIND}`);
  }
  requireCommit(value.stagingSourceCommit, "stagingSourceCommit", problems);
  requireSha256(
    value.targetManifestSha256,
    "targetManifestSha256",
    problems
  );
  const recordedAt = requireCanonicalInstant(value.recordedAt, "recordedAt", problems);
  if (exactKeys(value.session, SESSION_KEYS, "session", problems)) {
    if (
      !boundedString(value.session.id, { maximum: 36, pattern: UUID })
    ) {
      problems.push("session.id must be a canonical lowercase UUIDv4");
    }
    const times = SESSION_KEYS.slice(1).map((field) =>
      requireCanonicalInstant(value.session[field], `session.${field}`, problems)
    );
    if (
      times.every((instant) => instant !== null) &&
      times.some((instant, index) => index > 0 && instant < times[index - 1])
    ) {
      problems.push("session timestamps must be monotonic");
    }
    if (recordedAt !== null && times.at(-1) !== recordedAt) {
      problems.push("recordedAt must exactly equal session.completedAt");
    }
  }
  if (
    exactKeys(
      value.sourceArtifact,
      SOURCE_ARTIFACT_KEYS,
      "sourceArtifact",
      problems
    )
  ) {
    if (value.sourceArtifact.kind !== "staging-teardown-provider-transcript") {
      problems.push(
        "sourceArtifact.kind must be exactly staging-teardown-provider-transcript"
      );
    }
    if (
      typeof value.sourceArtifact.digest !== "string" ||
      !SHA256_REF.test(value.sourceArtifact.digest)
    ) {
      problems.push(
        "sourceArtifact.digest must be an exact sha256:<64 lowercase hex> reference"
      );
    }
    if (
      !Number.isSafeInteger(value.sourceArtifact.byteLength) ||
      value.sourceArtifact.byteLength < 1 ||
      value.sourceArtifact.byteLength > STAGING_TEARDOWN_TRANSCRIPT_MAX_BYTES
    ) {
      problems.push(
        `sourceArtifact.byteLength must be between 1 and ${STAGING_TEARDOWN_TRANSCRIPT_MAX_BYTES}`
      );
    }
  }
  let beforeByName = null;
  let afterByName = null;
  if (exactKeys(value.inventory, INVENTORY_KEYS, "inventory", problems)) {
    beforeByName = resourceMap(
      value.inventory.before,
      "inventory.before",
      problems,
      value.session?.id
    );
    afterByName = resourceMap(
      value.inventory.after,
      "inventory.after",
      problems,
      value.session?.id
    );
    problems.push(...actionProblems(value.inventory.actions, beforeByName, value.session ?? {}));
    if (afterByName) {
      for (const expected of STAGING_RESOURCE_CONTRACT) {
        if (afterByName.get(expected.logicalName)?.state !== "absent") {
          problems.push(
            `inventory.after must prove ${expected.logicalName} absent in the same session`
          );
        }
      }
    }
  }
  let expectedInventoryDigest = null;
  try {
    expectedInventoryDigest = stagingTeardownInventoryDigest(
      value.session,
      value.inventory
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  requireSha256(value.teardownInventoryDigest, "teardownInventoryDigest", problems);
  if (
    expectedInventoryDigest !== null &&
    value.teardownInventoryDigest !== expectedInventoryDigest
  ) {
    problems.push(
      "teardownInventoryDigest does not match the exact canonical session inventory bytes"
    );
  }
  const ok = problems.length === 0;
  return {
    ok,
    problems,
    bindings: ok
      ? {
          stagingSourceCommit: value.stagingSourceCommit,
          targetManifestSha256: value.targetManifestSha256,
          teardownInventoryDigest: expectedInventoryDigest,
          sourceArtifactDigest: value.sourceArtifact.digest.slice(
            "sha256:".length
          ),
          sourceArtifactByteLength: value.sourceArtifact.byteLength
        }
      : null,
    stagingSourceCommit: ok ? value.stagingSourceCommit : null,
    targetManifestSha256: ok ? value.targetManifestSha256 : null,
    recordedAt: ok ? value.recordedAt : null,
    teardownInventoryDigest: ok ? expectedInventoryDigest : null,
    receiptDigest: ok ? canonicalEvidenceDigest(value) : null
  };
}

function providerEvidenceRef(artifact, expectedKind, sessionId, label) {
  const problems = [];
  if (!exactKeys(artifact, EVIDENCE_ARTIFACT_KEYS, label, problems)) {
    throw new Error(problems.join("; "));
  }
  if (artifact.kind !== expectedKind) {
    throw new Error(`${label}.kind must be exactly ${expectedKind}`);
  }
  if (artifact.sessionId !== sessionId) {
    throw new Error(`${label}.sessionId must match the teardown session`);
  }
  let bytes;
  if (typeof artifact.bytes === "string") {
    bytes = Buffer.from(artifact.bytes, "utf8");
  } else if (artifact.bytes instanceof Uint8Array) {
    bytes = Buffer.from(
      artifact.bytes.buffer,
      artifact.bytes.byteOffset,
      artifact.bytes.byteLength
    );
  } else {
    throw new Error(`${label}.bytes must be a string or byte array`);
  }
  if (bytes.length < 1 || bytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error(
      `${label}.bytes must contain 1 through ${MAX_PROVIDER_RESPONSE_BYTES} bytes`
    );
  }
  return {
    kind: artifact.kind,
    sessionId,
    digest: `sha256:${sha256Bytes(bytes)}`
  };
}

function normalizedExternalIdRefs(externalIds, expected, label) {
  if (!Array.isArray(externalIds)) {
    throw new Error(`${label} must be an array`);
  }
  const sorted = [...externalIds].sort();
  if (
    externalIds.some(
      (entry, index) =>
        !boundedString(entry, { maximum: 512, pattern: OPAQUE }) ||
        entry !== sorted[index]
    ) ||
    new Set(externalIds).size !== externalIds.length
  ) {
    throw new Error(
      `${label} must contain unique, sorted, non-secret opaque identifiers`
    );
  }
  return externalIds.map(
    (externalId) =>
      `sha256:${sha256Bytes(
        `${EXTERNAL_ID_DOMAIN}${expected.kind}\u0000${expected.logicalName}\u0000${externalId}`
      )}`
  ).sort();
}

function normalizeInventory(resources, label, sessionId) {
  if (!Array.isArray(resources)) throw new Error(`${label} inventory must be an array`);
  if (resources.length !== STAGING_RESOURCE_CONTRACT.length) {
    throw new Error(
      `${label} inventory must contain exactly ${STAGING_RESOURCE_CONTRACT.length} resources`
    );
  }
  const names = resources.map((resource) => resource?.logicalName);
  if (new Set(names).size !== names.length) {
    throw new Error(`${label} inventory contains duplicate logical names`);
  }
  const byName = new Map(resources.map((resource) => [resource?.logicalName, resource]));
  const normalized = STAGING_RESOURCE_CONTRACT.map((expected) => {
    const resource = byName.get(expected.logicalName);
    if (resource === undefined) {
      throw new Error(`${label} inventory omitted ${expected.logicalName}`);
    }
    const sourceProblems = [];
    if (
      !exactKeys(
        resource,
        TRANSCRIPT_OBSERVATION_KEYS,
        `${label} inventory ${expected.logicalName}`,
        sourceProblems
      )
    ) {
      throw new Error(sourceProblems.join("; "));
    }
    return {
      kind: resource.kind,
      logicalName: resource.logicalName,
      externalIds: normalizedExternalIdRefs(
        resource.externalIds,
        expected,
        `${label} inventory ${expected.logicalName}.externalIds`
      ),
      state: resource.state,
      evidenceRef: providerEvidenceRef(
        resource.evidenceArtifact,
        INVENTORY_EVIDENCE_KIND,
        sessionId,
        `${label} inventory ${expected.logicalName} evidenceArtifact`
      )
    };
  });
  const problems = [];
  resourceMap(normalized, label, problems, sessionId);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return normalized;
}

export function stagingTeardownDryRunPlan() {
  return STAGING_RESOURCE_CONTRACT.map(
    ({ kind, logicalName, removalDisposition }) => ({
      kind,
      logicalName,
      ifPresent: removalDisposition,
      finalRequiredState: "absent"
    })
  );
}

function normalizeActions(resources, before, session) {
  if (!Array.isArray(resources)) {
    throw new Error("actions inventory must be an array");
  }
  if (resources.length !== STAGING_RESOURCE_CONTRACT.length) {
    throw new Error(
      `actions inventory must contain exactly ${STAGING_RESOURCE_CONTRACT.length} resources`
    );
  }
  const names = resources.map((resource) => resource?.logicalName);
  if (new Set(names).size !== names.length) {
    throw new Error("actions inventory contains duplicate logical names");
  }
  const byName = new Map(resources.map((resource) => [resource?.logicalName, resource]));
  return STAGING_RESOURCE_CONTRACT.map((expected, index) => {
    const resource = byName.get(expected.logicalName);
    if (resource === undefined) {
      throw new Error(`actions inventory omitted ${expected.logicalName}`);
    }
    const sourceProblems = [];
    if (
      !exactKeys(
        resource,
        TRANSCRIPT_ACTION_KEYS,
        `actions inventory ${expected.logicalName}`,
        sourceProblems
      )
    ) {
      throw new Error(sourceProblems.join("; "));
    }
    const expectedDisposition =
      before[index].state === "present"
        ? expected.removalDisposition
        : "already-absent";
    const expectedEvidenceKind =
      expectedDisposition === "already-absent"
        ? INVENTORY_EVIDENCE_KIND
        : REMOVAL_EVIDENCE_KIND;
    return {
      kind: resource.kind,
      logicalName: resource.logicalName,
      externalIds: normalizedExternalIdRefs(
        resource.externalIds,
        expected,
        `actions inventory ${expected.logicalName}.externalIds`
      ),
      disposition: resource.disposition,
      completedAt: resource.completedAt,
      evidenceRef: providerEvidenceRef(
        resource.evidenceArtifact,
        expectedEvidenceKind,
        session.id,
        `actions inventory ${expected.logicalName} evidenceArtifact`
      )
    };
  });
}

/**
 * Build a receipt from a bounded, already-sanitized operator transcript.
 * This function is deliberately data-only: it never imports provider code,
 * reads credentials, performs network I/O, or deletes resources.
 */
export function buildStagingTeardownEvidence({ sourceBytes }) {
  let exactBytes;
  if (typeof sourceBytes === "string") {
    exactBytes = Buffer.from(sourceBytes, "utf8");
  } else if (sourceBytes instanceof Uint8Array) {
    exactBytes = Buffer.from(
      sourceBytes.buffer,
      sourceBytes.byteOffset,
      sourceBytes.byteLength
    );
  } else {
    throw new Error("staging teardown transcript must be supplied as exact bytes");
  }
  if (
    exactBytes.length < 1 ||
    exactBytes.length > STAGING_TEARDOWN_TRANSCRIPT_MAX_BYTES
  ) {
    throw new Error(
      `staging teardown transcript must contain 1 through ${STAGING_TEARDOWN_TRANSCRIPT_MAX_BYTES} bytes`
    );
  }
  let transcript;
  try {
    transcript = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(exactBytes)
    );
  } catch {
    throw new Error("staging teardown transcript must contain valid UTF-8 JSON");
  }
  const sourceProblems = [];
  if (
    !exactKeys(
      transcript,
      TRANSCRIPT_KEYS,
      "staging teardown transcript",
      sourceProblems
    )
  ) {
    throw new Error(sourceProblems.join("; "));
  }
  if (
    !exactKeys(
      transcript.session,
      SESSION_KEYS,
      "staging teardown transcript session",
      sourceProblems
    ) ||
    !exactKeys(
      transcript.inventory,
      INVENTORY_KEYS,
      "staging teardown transcript inventory",
      sourceProblems
    )
  ) {
    throw new Error(sourceProblems.join("; "));
  }
  const before = normalizeInventory(
    transcript.inventory.before,
    "before",
    transcript.session.id
  );
  const actions = normalizeActions(
    transcript.inventory.actions,
    before,
    transcript.session
  );
  const after = normalizeInventory(
    transcript.inventory.after,
    "after",
    transcript.session.id
  );
  const session = { ...transcript.session };
  const inventory = { before, actions, after };
  const receipt = {
    schemaVersion: STAGING_TEARDOWN_EVIDENCE_SCHEMA_VERSION,
    artifactKind: STAGING_TEARDOWN_EVIDENCE_KIND,
    stagingSourceCommit: transcript.stagingSourceCommit,
    targetManifestSha256: transcript.targetManifestSha256,
    recordedAt: transcript.recordedAt,
    session,
    inventory,
    sourceArtifact: {
      kind: "staging-teardown-provider-transcript",
      digest: `sha256:${sha256Bytes(exactBytes)}`,
      byteLength: exactBytes.length
    },
    teardownInventoryDigest: stagingTeardownInventoryDigest(session, inventory)
  };
  const verdict = validateStagingTeardownEvidence(receipt);
  if (!verdict.ok) {
    throw new Error(`Invalid staging teardown evidence: ${verdict.problems.join("; ")}`);
  }
  return receipt;
}

export function serializeStagingTeardownEvidence(value) {
  const verdict = validateStagingTeardownEvidence(value);
  if (!verdict.ok) throw new Error(verdict.problems.join("; "));
  return serializeCanonicalEvidence(value);
}
