// The record a production container deployment leaves: the image the
// provider reported the application runs, the commit the live scanner
// reported for itself, when both were read, and which runs produced and
// deployed the image.
//
// .github/workflows/deploy-container.yml writes it after the rollout
// converges (scripts/verify-deployed-container.mjs) and a separate job signs
// it. Both readings come from outside this repository: the provider's answer
// and the scanner's own statement of its commit. A report whose recorded
// build commit matches a record is consistent with the image the record
// names; the record does not show that any one scan ran in that image.

import { IMAGE_REPOSITORY } from "./published-container-lib.mjs";

export const DEPLOYMENT_RECORD_KIND = "site-behavior-lab-production-deployment-record";
export const DEPLOYMENT_RECORD_FILE = "production-container-readback.json";
export const DEPLOYMENT_RECORD_KEYS = [
  "schemaVersion",
  "kind",
  "sourceCommit",
  "image",
  "applicationId",
  "observedAt",
  "ciRun",
  "deployRun"
];

const SHA = /^[0-9a-f]{40}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
const runId = (value) => Number.isSafeInteger(value) && value > 0;
const imagePattern = new RegExp(`^${IMAGE_REPOSITORY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@sha256:[0-9a-f]{64}$`);

/** A run id or attempt read from the environment: a positive integer, or a refusal naming the variable. */
export function positiveInteger(value, name) {
  const parsed = /^[1-9][0-9]{0,15}$/.test(String(value ?? "")) ? Number(value) : NaN;
  if (!runId(parsed)) throw new Error(`${name} is not a positive integer`);
  return parsed;
}

/** The record of a converged rollout, as waitForDeployment returned it, with the runs that made and deployed the image. */
export function deploymentRecord(readback, { ciRunId, deployRunId, deployRunAttempt }) {
  return {
    schemaVersion: 1,
    kind: DEPLOYMENT_RECORD_KIND,
    sourceCommit: readback.sourceCommit,
    image: readback.image,
    applicationId: readback.applicationId,
    observedAt: readback.observedAt,
    ciRun: { id: ciRunId },
    deployRun: { id: deployRunId, attempt: deployRunAttempt }
  };
}

/** Every way a record fails to be the record of this deployment run of this commit; empty when it is. */
export function deploymentRecordProblems(value, { commit, deployRunId, deployRunAttempt }) {
  if (!exactKeys(value, DEPLOYMENT_RECORD_KEYS)) return ["the record does not hold exactly its fields, in order"];
  const problems = [];
  if (value.schemaVersion !== 1 || value.kind !== DEPLOYMENT_RECORD_KIND) problems.push("the record is of another kind or version");
  if (!SHA.test(value.sourceCommit ?? "") || value.sourceCommit !== commit) problems.push(`the record names commit ${value.sourceCommit}, not ${commit}`);
  if (typeof value.image !== "string" || !imagePattern.test(value.image)) problems.push("the record names no immutable image of the production repository");
  if (typeof value.applicationId !== "string" || value.applicationId.length === 0 || value.applicationId.length > 200) problems.push("the record names no application");
  if (typeof value.observedAt !== "string" || !INSTANT.test(value.observedAt) || new Date(value.observedAt).toISOString() !== value.observedAt) {
    problems.push("the record's observation time is not a canonical instant");
  }
  if (!exactKeys(value.ciRun, ["id"]) || !runId(value.ciRun.id)) problems.push("the record names no CI run");
  if (!exactKeys(value.deployRun, ["id", "attempt"]) || value.deployRun.id !== deployRunId || value.deployRun.attempt !== deployRunAttempt) {
    problems.push(`the record is not of deployment run ${deployRunId} attempt ${deployRunAttempt}`);
  }
  return problems;
}
