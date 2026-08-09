import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
  runnerHostImageIdentityRef,
  runnerLabelRef,
  runnerNatIdentityRef
} from "./controlled-runner-identity-lib.mjs";
import {
  buildControlledRunnerExpectedEnvironment,
  CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS
} from "./controlled-runner-expected-environment.mjs";
import {
  runnerDestructionEnvironmentDigest,
  runnerDestructionExpectedEnvironmentDigest
} from "./runner-receipt-lib.mjs";

const SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "controlled-runner-expected-environment.mjs"
);
const RAW = Object.freeze({
  runnerLabel: "controlled-r2-us-west-2026-08",
  hostImageIdentity: "ami-private-image-generation-42",
  registrationLabels: [
    "self-hosted",
    "controlled-r2-us-west-2026-08",
    "linux-x64"
  ],
  declaredRegion: "us-west",
  natIdentity: "private-nat-gateway-generation-17",
  blockedClasses: ["metadata", "private", "link-local"]
});

function exactEnvironment(overrides = {}) {
  const names = CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS;
  return {
    [names.runnerLabel]: RAW.runnerLabel,
    [names.hostImageIdentity]: RAW.hostImageIdentity,
    [names.registrationLabelsJson]: JSON.stringify(RAW.registrationLabels),
    [names.declaredRegion]: RAW.declaredRegion,
    [names.natIdentity]: RAW.natIdentity,
    [names.blockedClassesJson]: JSON.stringify(RAW.blockedClasses),
    ...overrides
  };
}

test("the helper emits only the exact six-field privacy-safe tuple and digest", () => {
  const result = buildControlledRunnerExpectedEnvironment(exactEnvironment());
  assert.deepEqual(Object.keys(result).sort(), [
    "expectedEnvironment",
    "expectedEnvironmentDigest"
  ]);
  assert.deepEqual(Object.keys(result.expectedEnvironment).sort(), [
    "blockedClasses",
    "declaredRegion",
    "hostImageIdentityRef",
    "natIdentityRef",
    "registrationLabelRefs",
    "runnerLabelRef"
  ]);
  assert.equal(
    result.expectedEnvironment.runnerLabelRef,
    runnerLabelRef(RAW.runnerLabel)
  );
  assert.equal(
    result.expectedEnvironment.hostImageIdentityRef,
    runnerHostImageIdentityRef(RAW.hostImageIdentity)
  );
  assert.equal(
    result.expectedEnvironment.natIdentityRef,
    runnerNatIdentityRef(RAW.natIdentity)
  );
  assert.deepEqual(
    result.expectedEnvironment.registrationLabelRefs,
    RAW.registrationLabels.map(runnerLabelRef).sort()
  );
  assert.deepEqual(result.expectedEnvironment.blockedClasses, [
    "link-local",
    "metadata",
    "private"
  ]);
  assert.equal(
    result.expectedEnvironmentDigest,
    runnerDestructionExpectedEnvironmentDigest(result.expectedEnvironment)
  );
  const wire = JSON.stringify(result);
  for (const secret of [
    RAW.runnerLabel,
    RAW.hostImageIdentity,
    ...RAW.registrationLabels,
    RAW.natIdentity
  ]) {
    assert.equal(wire.includes(secret), false, "raw identities must never reach output");
  }
});

test("the CLI refuses arguments and unsupported prefixed inputs without echoing raw values", () => {
  const rawArgument = "raw-private-identity-on-argv";
  const withArgument = spawnSync(process.execPath, [SCRIPT, rawArgument], {
    encoding: "utf8",
    env: { ...process.env, ...exactEnvironment() }
  });
  assert.notEqual(withArgument.status, 0);
  assert.equal(withArgument.stdout, "");
  assert.equal(withArgument.stderr.includes(rawArgument), false);

  const unknownValue = "raw-private-unknown-input";
  const unknownName = `${CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS.runnerLabel}_TYPO`;
  const withUnknownEnvironment = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...exactEnvironment(),
      [unknownName]: unknownValue
    }
  });
  assert.notEqual(withUnknownEnvironment.status, 0);
  assert.equal(withUnknownEnvironment.stdout, "");
  assert.equal(withUnknownEnvironment.stderr.includes(unknownValue), false);
});

test("malformed and duplicate private inputs fail without disclosure", () => {
  const names = CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS;
  const malformedRaw = "raw-private-malformed-registration";
  assert.throws(
    () =>
      buildControlledRunnerExpectedEnvironment(
        exactEnvironment({
          [names.registrationLabelsJson]: `[\"${malformedRaw}\"`
        })
      ),
    (error) =>
      error instanceof Error &&
      /must be a JSON string array/.test(error.message) &&
      !error.message.includes(malformedRaw)
  );

  const duplicateRaw = "raw-private-duplicate-label";
  assert.throws(
    () =>
      buildControlledRunnerExpectedEnvironment(
        exactEnvironment({
          [names.registrationLabelsJson]: JSON.stringify([
            RAW.runnerLabel,
            duplicateRaw,
            duplicateRaw
          ])
        })
      ),
    (error) =>
      error instanceof Error &&
      /must be unique after role-specific/.test(error.message) &&
      !error.message.includes(duplicateRaw)
  );
});

test("the helper uses the receipt tuple's locale-independent blocked-class ordering", () => {
  const names = CONTROLLED_RUNNER_EXPECTED_ENVIRONMENT_INPUTS;
  const rawBlockedClasses = ["metadata", "private", "link-local", "ä-class", "z-class"];
  const result = buildControlledRunnerExpectedEnvironment(
    exactEnvironment({
      [names.blockedClassesJson]: JSON.stringify(rawBlockedClasses)
    })
  );
  assert.deepEqual(
    result.expectedEnvironment.blockedClasses,
    [...rawBlockedClasses].sort()
  );
  assert.equal(
    result.expectedEnvironmentDigest,
    runnerDestructionEnvironmentDigest({
      receiptVersion: 3,
      runnerLabelRef: result.expectedEnvironment.runnerLabelRef,
      provisioning: {
        hostImageIdentityRef:
          result.expectedEnvironment.hostImageIdentityRef,
        registration: {
          labelRefs: result.expectedEnvironment.registrationLabelRefs
        }
      },
      egress: {
        declaredRegion: result.expectedEnvironment.declaredRegion,
        natIdentityRef: result.expectedEnvironment.natIdentityRef,
        blockedClasses: rawBlockedClasses
      }
    })
  );
});
