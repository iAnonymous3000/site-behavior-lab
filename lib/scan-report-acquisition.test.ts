import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT_ACQUISITION_ENV, runtimeReportAcquisition } from "./scan-report-acquisition";

function controlledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [REPORT_ACQUISITION_ENV]: "ci-workflow",
    CI: "1",
    RUNNER_ENVIRONMENT: "self-hosted",
    FEATURED_R2_EGRESS_ATTESTED: "1",
    SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "1",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS: "controlled-nat",
    SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "iad-egress-1",
    ...overrides
  };
}

test("ordinary server requests retain public-api acquisition provenance", () => {
  assert.equal(runtimeReportAcquisition("v1", {} as NodeJS.ProcessEnv), "public-api");
  assert.equal(runtimeReportAcquisition("r2", {} as NodeJS.ProcessEnv), "public-api");
});

test("ci-workflow acquisition requires every controlled r2 preflight fact", () => {
  assert.equal(runtimeReportAcquisition("r2", controlledEnvironment()), "ci-workflow");
  for (const [name, environment, mode = "r2"] of [
    ["CI", controlledEnvironment({ CI: "true" })],
    ["runner", controlledEnvironment({ RUNNER_ENVIRONMENT: "github-hosted" })],
    ["attestation", controlledEnvironment({ FEATURED_R2_EGRESS_ATTESTED: "0" })],
    ["sandbox", controlledEnvironment({ SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX: "0" })],
    ["label", controlledEnvironment({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS: "github-actions-ubuntu" })],
    ["region", controlledEnvironment({ SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION: "" })],
    ["mode", controlledEnvironment(), "v1"]
  ] as const) {
    assert.throws(
      () => runtimeReportAcquisition(mode, environment),
      /ci-workflow report provenance requires/,
      name
    );
  }
});

test("the server-only acquisition setting rejects every unknown vocabulary value", () => {
  assert.throws(
    () => runtimeReportAcquisition("r2", controlledEnvironment({ [REPORT_ACQUISITION_ENV]: "upload" })),
    /must be exactly ci-workflow/
  );
  assert.throws(
    () => runtimeReportAcquisition("r2", controlledEnvironment({ [REPORT_ACQUISITION_ENV]: "public-api" })),
    /must be exactly ci-workflow/
  );
});
