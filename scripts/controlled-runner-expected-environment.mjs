#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import {
  runnerHostImageIdentityRef,
  runnerLabelRef,
  runnerNatIdentityRef
} from "./controlled-runner-identity-lib.mjs";
import {
  runnerDestructionExpectedEnvironmentDigest,
  runnerDestructionExpectedEnvironmentIssues
} from "./runner-receipt-lib.mjs";

const INPUT_PREFIX = "SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_";

export const CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS = Object.freeze({
  runnerLabel: `${INPUT_PREFIX}LABEL`,
  hostImageIdentity: `${INPUT_PREFIX}HOST_IMAGE_IDENTITY`,
  registrationLabelsJson: `${INPUT_PREFIX}REGISTRATION_LABELS_JSON`,
  declaredRegion: `${INPUT_PREFIX}DECLARED_REGION`,
  natIdentity: `${INPUT_PREFIX}NAT_IDENTITY`,
  blockedClassesJson: `${INPUT_PREFIX}BLOCKED_CLASSES_JSON`
});

const ALLOWED_INPUT_NAMES = new Set(
  Object.values(CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS)
);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredInput(env, name) {
  const value = env[name];
  requireValue(
    typeof value === "string" && value.length > 0,
    `${name} is required`
  );
  return value;
}

function strictStringArray(value, label, { minimum = 0, maximum = 32 } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be a JSON string array`);
  }
  requireValue(
    Array.isArray(parsed) &&
      parsed.length >= minimum &&
      parsed.length <= maximum &&
      parsed.every(
        (entry) =>
          typeof entry === "string" &&
          entry.length > 0 &&
          entry === entry.trim() &&
          Buffer.byteLength(entry, "utf8") <= 512 &&
          !/[\u0000-\u001f\u007f-\u009f]/.test(entry)
      ),
    `${label} must contain ${minimum} through ${maximum} bounded canonical strings`
  );
  return parsed;
}

/**
 * Derive the candidate-owned privacy-safe tuple without returning or logging
 * any raw runner, host-image, registration-label, or NAT identity.
 */
export function buildControlledRunnerExpectedEnvironment(env) {
  requireValue(
    env !== null && typeof env === "object",
    "controlled runner expected-environment inputs are required"
  );
  const unknown = Object.keys(env).filter(
    (name) => name.startsWith(INPUT_PREFIX) && !ALLOWED_INPUT_NAMES.has(name)
  );
  requireValue(
    unknown.length === 0,
    "an unsupported controlled runner expected-environment input name is set"
  );

  const names = CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS;
  const rawRunnerLabel = requiredInput(env, names.runnerLabel);
  const rawHostImageIdentity = requiredInput(env, names.hostImageIdentity);
  const rawNatIdentity = requiredInput(env, names.natIdentity);
  const rawRegistrationLabels = strictStringArray(
    requiredInput(env, names.registrationLabelsJson),
    names.registrationLabelsJson,
    { minimum: 1 }
  );
  const blockedClasses = strictStringArray(
    requiredInput(env, names.blockedClassesJson),
    names.blockedClassesJson
  ).sort();

  const exactRunnerLabelRef = runnerLabelRef(rawRunnerLabel);
  const registrationLabelRefs = rawRegistrationLabels
    .map((label) => runnerLabelRef(label))
    .sort();
  requireValue(
    new Set(registrationLabelRefs).size === registrationLabelRefs.length,
    "registration labels must be unique after role-specific identity derivation"
  );
  requireValue(
    registrationLabelRefs.includes(exactRunnerLabelRef),
    "registration labels must include the declared runner label"
  );
  requireValue(
    new Set(blockedClasses).size === blockedClasses.length,
    "blocked network classes must be unique"
  );

  const expectedEnvironment = {
    runnerLabelRef: exactRunnerLabelRef,
    hostImageIdentityRef: runnerHostImageIdentityRef(rawHostImageIdentity),
    registrationLabelRefs,
    declaredRegion: requiredInput(env, names.declaredRegion),
    natIdentityRef: runnerNatIdentityRef(rawNatIdentity),
    blockedClasses
  };
  const issues = runnerDestructionExpectedEnvironmentIssues(expectedEnvironment);
  requireValue(
    issues.length === 0,
    `controlled runner expected environment is invalid: ${issues.join("; ")}`
  );
  return {
    expectedEnvironment,
    expectedEnvironmentDigest:
      runnerDestructionExpectedEnvironmentDigest(expectedEnvironment)
  };
}

function main() {
  requireValue(
    process.argv.length === 2,
    "controlled runner expected-environment command accepts no arguments"
  );
  const result = buildControlledRunnerExpectedEnvironment(process.env);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "controlled runner expected-environment command failed");
    process.exitCode = 1;
  }
}
