// Canonical provider-readback evidence for one controlled-runner cycle.
//
// This module is deliberately provider-neutral only at the serialization
// boundary. A reviewed provider adapter must authenticate and normalize its
// own API response before calling buildRunnerDestructionEvidence. The public
// CLI does not accept an operator-authored JSON transcript as a substitute for
// that adapter.

import {
  canonicalEvidenceDigest,
  exactKeys,
  isRecord,
  parseCanonicalEvidence,
  requireCanonicalInstant,
  requireCommit,
  requireSha256,
  serializeCanonicalEvidence
} from "./operator-evidence-common.mjs";

export const RUNNER_DESTRUCTION_EVIDENCE_KIND =
  "site-behavior-runner-destruction-provider-readback";
export const RUNNER_DESTRUCTION_EVIDENCE_SCHEMA_VERSION = 1;
export const RUNNER_DESTRUCTION_EVIDENCE_FILENAME =
  "destruction-evidence.json";
export const RUNNER_DESTRUCTION_PROVIDER_RESPONSE_MAX_BYTES =
  1024 * 1024;
export const CONTROLLED_RUNNER_REPOSITORY =
  "iAnonymous3000/site-behavior-lab";
export const CONTROLLED_RUNNER_WORKFLOW =
  ".github/workflows/scan-featured.yml";
export const RUN_EVIDENCE_REF_KIND = "github-actions-run-evidence";

const ROOT_KEYS = [
  "schemaVersion",
  "artifactKind",
  "collection",
  "destroyedAt",
  "verifiedAbsentAt",
  "computeAbsent",
  "registrationAbsent",
  "runnerAbsent",
  "evidenceRefs"
];
const COLLECTION_KEYS = [
  "repository",
  "workflow",
  "runId",
  "runAttempt",
  "headSha"
];
const EXPECTED_COLLECTION_KEYS = [
  ...COLLECTION_KEYS,
  "jobCompletedAt"
];
const PROVIDER_OBSERVATION_KEYS = [
  "collection",
  "destroyedAt",
  "verifiedAbsentAt",
  "computeAbsent",
  "registrationAbsent"
];
const EVIDENCE_REF_KEYS = [
  "kind",
  "actionsRunId",
  "runUrl",
  "artifactName",
  "artifactRef",
  "artifactSha256"
];
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,19}$/;
const ARTIFACT_URL =
  /^https:\/\/github\.com\/iAnonymous3000\/site-behavior-lab\/actions\/runs\/([1-9][0-9]{0,19})\/artifacts\/([1-9][0-9]{0,19})$/;

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactRunUrl(runId) {
  return `https://github.com/${CONTROLLED_RUNNER_REPOSITORY}/actions/runs/${runId}`;
}

function exactArtifactName(runId, runAttempt) {
  return `site-behavior-featured-publication-${runId}-${runAttempt}`;
}

function collectionProblems(collection, label) {
  const problems = [];
  if (!exactKeys(collection, COLLECTION_KEYS, label, problems)) {
    return problems;
  }
  if (collection.repository !== CONTROLLED_RUNNER_REPOSITORY) {
    problems.push(
      `${label}.repository must be exactly ${CONTROLLED_RUNNER_REPOSITORY}`
    );
  }
  if (collection.workflow !== CONTROLLED_RUNNER_WORKFLOW) {
    problems.push(
      `${label}.workflow must be exactly ${CONTROLLED_RUNNER_WORKFLOW}`
    );
  }
  if (!positiveSafeInteger(collection.runId)) {
    problems.push(`${label}.runId must be a positive safe integer`);
  }
  if (
    !Number.isSafeInteger(collection.runAttempt) ||
    collection.runAttempt < 1 ||
    collection.runAttempt > 100
  ) {
    problems.push(`${label}.runAttempt must be an integer from 1 through 100`);
  }
  requireCommit(collection.headSha, `${label}.headSha`, problems);
  return problems;
}

function evidenceRefProblems(reference, index, collection) {
  const label = `evidenceRefs[${index}]`;
  const problems = [];
  if (!exactKeys(reference, EVIDENCE_REF_KEYS, label, problems)) {
    return problems;
  }
  if (reference.kind !== RUN_EVIDENCE_REF_KIND) {
    problems.push(`${label}.kind must be exactly ${RUN_EVIDENCE_REF_KIND}`);
  }
  if (reference.actionsRunId !== collection?.runId) {
    problems.push(
      `${label}.actionsRunId must match the authenticated collection run`
    );
  }
  if (
    positiveSafeInteger(collection?.runId) &&
    reference.runUrl !== exactRunUrl(collection.runId)
  ) {
    problems.push(
      `${label}.runUrl must bind the exact collection repository and run`
    );
  }
  if (
    positiveSafeInteger(collection?.runId) &&
    Number.isSafeInteger(collection?.runAttempt) &&
    reference.artifactName !==
      exactArtifactName(collection.runId, collection.runAttempt)
  ) {
    problems.push(
      `${label}.artifactName must bind the exact collection run and attempt`
    );
  }
  const artifactMatch =
    typeof reference.artifactRef === "string"
      ? ARTIFACT_URL.exec(reference.artifactRef)
      : null;
  if (
    artifactMatch === null ||
    !POSITIVE_DECIMAL.test(artifactMatch[1]) ||
    Number(artifactMatch[1]) !== collection?.runId ||
    !Number.isSafeInteger(Number(artifactMatch[2]))
  ) {
    problems.push(
      `${label}.artifactRef must be the immutable artifact URL for the exact collection run`
    );
  }
  requireSha256(
    reference.artifactSha256,
    `${label}.artifactSha256`,
    problems
  );
  return problems;
}

export function runnerDestructionEvidenceProblems(value) {
  const problems = [];
  if (!exactKeys(value, ROOT_KEYS, "runner destruction evidence", problems)) {
    return problems;
  }
  if (value.schemaVersion !== RUNNER_DESTRUCTION_EVIDENCE_SCHEMA_VERSION) {
    problems.push(
      `schemaVersion must be exactly ${RUNNER_DESTRUCTION_EVIDENCE_SCHEMA_VERSION}`
    );
  }
  if (value.artifactKind !== RUNNER_DESTRUCTION_EVIDENCE_KIND) {
    problems.push(
      `artifactKind must be exactly ${RUNNER_DESTRUCTION_EVIDENCE_KIND}`
    );
  }
  problems.push(...collectionProblems(value.collection, "collection"));
  const destroyedAt = requireCanonicalInstant(
    value.destroyedAt,
    "destroyedAt",
    problems
  );
  const verifiedAbsentAt = requireCanonicalInstant(
    value.verifiedAbsentAt,
    "verifiedAbsentAt",
    problems
  );
  if (
    destroyedAt !== null &&
    verifiedAbsentAt !== null &&
    verifiedAbsentAt < destroyedAt
  ) {
    problems.push("verifiedAbsentAt must not precede destroyedAt");
  }
  for (const field of [
    "computeAbsent",
    "registrationAbsent",
    "runnerAbsent"
  ]) {
    if (value[field] !== true) {
      problems.push(`${field} must be literally true`);
    }
  }
  if (
    value.runnerAbsent !==
    (value.computeAbsent === true && value.registrationAbsent === true)
  ) {
    problems.push(
      "runnerAbsent must be derived from computeAbsent and registrationAbsent"
    );
  }
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length !== 1
  ) {
    problems.push(
      "evidenceRefs must contain exactly the authenticated collection artifact reference"
    );
  } else {
    problems.push(
      ...evidenceRefProblems(value.evidenceRefs[0], 0, value.collection)
    );
  }
  return problems;
}

export function verifyRunnerDestructionEvidence(value) {
  const problems = runnerDestructionEvidenceProblems(value);
  if (problems.length > 0) {
    throw new Error(
      `runner destruction evidence is invalid: ${problems.join("; ")}`
    );
  }
  return Object.freeze({
    evidence: value,
    evidenceDigest: canonicalEvidenceDigest(value)
  });
}

function expectedCollectionProblems(value) {
  const problems = [];
  if (
    !exactKeys(
      value,
      EXPECTED_COLLECTION_KEYS,
      "expected collection",
      problems
    )
  ) {
    return problems;
  }
  const collection = Object.fromEntries(
    COLLECTION_KEYS.map((key) => [key, value[key]])
  );
  problems.push(...collectionProblems(collection, "expected collection"));
  requireCanonicalInstant(
    value.jobCompletedAt,
    "expected collection.jobCompletedAt",
    problems
  );
  return problems;
}

function sameCollection(left, right) {
  return COLLECTION_KEYS.every((key) => left?.[key] === right?.[key]);
}

/**
 * Build release evidence only from a provider adapter's normalized response
 * and separately authenticated GitHub collection metadata.
 *
 * The provider adapter is responsible for acquiring a bounded response from
 * one reviewed API. This function intentionally accepts neither a provider
 * URL nor a caller-supplied response digest.
 */
export function buildRunnerDestructionEvidence({
  expectedCollection,
  providerObservation,
  collectionEvidenceRef
}) {
  const expectedProblems = expectedCollectionProblems(expectedCollection);
  if (expectedProblems.length > 0) {
    throw new Error(
      `authenticated collection metadata is invalid: ${expectedProblems.join("; ")}`
    );
  }
  const observationProblems = [];
  if (
    !exactKeys(
      providerObservation,
      PROVIDER_OBSERVATION_KEYS,
      "provider observation",
      observationProblems
    )
  ) {
    throw new Error(
      `provider observation is invalid: ${observationProblems.join("; ")}`
    );
  }
  observationProblems.push(
    ...collectionProblems(
      providerObservation.collection,
      "provider observation.collection"
    )
  );
  if (
    isRecord(providerObservation.collection) &&
    !sameCollection(providerObservation.collection, expectedCollection)
  ) {
    observationProblems.push(
      "provider observation collection does not match the authenticated collection run"
    );
  }
  const destroyedAt = requireCanonicalInstant(
    providerObservation.destroyedAt,
    "provider observation.destroyedAt",
    observationProblems
  );
  const verifiedAbsentAt = requireCanonicalInstant(
    providerObservation.verifiedAbsentAt,
    "provider observation.verifiedAbsentAt",
    observationProblems
  );
  const completedAt = Date.parse(expectedCollection.jobCompletedAt);
  if (destroyedAt !== null && destroyedAt <= completedAt) {
    observationProblems.push(
      "provider observation.destroyedAt must follow the authenticated collection job"
    );
  }
  if (
    destroyedAt !== null &&
    verifiedAbsentAt !== null &&
    verifiedAbsentAt < destroyedAt
  ) {
    observationProblems.push(
      "provider observation.verifiedAbsentAt must not precede destroyedAt"
    );
  }
  if (providerObservation.computeAbsent !== true) {
    observationProblems.push(
      "provider observation.computeAbsent must be literally true"
    );
  }
  if (providerObservation.registrationAbsent !== true) {
    observationProblems.push(
      "provider observation.registrationAbsent must be literally true"
    );
  }
  observationProblems.push(
    ...evidenceRefProblems(
      collectionEvidenceRef,
      0,
      expectedCollection
    )
  );
  if (observationProblems.length > 0) {
    throw new Error(
      `provider observation is invalid: ${observationProblems.join("; ")}`
    );
  }

  const evidence = {
    schemaVersion: RUNNER_DESTRUCTION_EVIDENCE_SCHEMA_VERSION,
    artifactKind: RUNNER_DESTRUCTION_EVIDENCE_KIND,
    collection: Object.fromEntries(
      COLLECTION_KEYS.map((key) => [key, expectedCollection[key]])
    ),
    destroyedAt: providerObservation.destroyedAt,
    verifiedAbsentAt: providerObservation.verifiedAbsentAt,
    computeAbsent: true,
    registrationAbsent: true,
    runnerAbsent: true,
    evidenceRefs: [structuredClone(collectionEvidenceRef)]
  };
  verifyRunnerDestructionEvidence(evidence);
  return evidence;
}

export function serializeRunnerDestructionEvidence(value) {
  verifyRunnerDestructionEvidence(value);
  return serializeCanonicalEvidence(value);
}

export function parseRunnerDestructionEvidence(bytes) {
  const value = parseCanonicalEvidence(
    bytes,
    "runner destruction evidence"
  );
  verifyRunnerDestructionEvidence(value);
  return value;
}

export function runnerDestructionEvidenceDigest(value) {
  return verifyRunnerDestructionEvidence(value).evidenceDigest;
}
