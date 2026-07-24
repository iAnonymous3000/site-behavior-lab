import { randomBytes } from "node:crypto";
import { BUILD_COMMIT_ENV, recordedBuildCommit } from "./build-provenance";
import type { AcquisitionKind } from "./scan-report-v2";
import type { EphemeralComparisonReportR2, EphemeralSingleReportR2 } from "./scan-report-v2-r2";
import {
  buildNodeComparisonScanReportV2R2,
  buildNodeScanReportV2R2,
  type NodeScanReportV2R2Input
} from "./scan-result-v2-r2-builder";
import type {
  NodeScanMeasurement,
  NodeScanMeasurementEnvelope
} from "./node-scan-measurement";
import type { ScanResult } from "./types";

export type RuntimeR2BuildFailureCode =
  | "measurement-envelope-missing"
  | "measurement-envelope-inconsistent"
  | "build-provenance-missing";

export class RuntimeR2BuildPrerequisiteError extends Error {
  constructor(
    public readonly code: RuntimeR2BuildFailureCode,
    message: string
  ) {
    super(message);
    this.name = "RuntimeR2BuildPrerequisiteError";
  }
}

/** Build one screenshot-bearing immediate r2 result from a completed Node visit. */
export function buildRuntimeScanReportV2R2(
  envelope: NodeScanMeasurementEnvelope,
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): EphemeralSingleReportR2 {
  const measurement = requireMeasurementEnvelope(envelope);
  assertMeasurementEnvelopeConsistent(envelope.result, measurement);
  assertBuildProvenance(env);
  return buildNodeScanReportV2R2(
    nodeBuilderInput(measurement, acquisition, mintRunId(measurement.emissionInputs.startedAt)),
    env
  );
}

/** Build one complete screenshot-bearing r2 intervention pair from two visits. */
export function buildRuntimeComparisonScanReportV2R2(
  baselineEnvelope: NodeScanMeasurementEnvelope,
  variantEnvelope: NodeScanMeasurementEnvelope,
  executedFirst: "baseline" | "variant",
  acquisition: AcquisitionKind,
  env: NodeJS.ProcessEnv = process.env
): EphemeralComparisonReportR2 {
  const baseline = requireMeasurementEnvelope(baselineEnvelope);
  const variant = requireMeasurementEnvelope(variantEnvelope);
  assertMeasurementEnvelopeConsistent(baselineEnvelope.result, baseline);
  assertMeasurementEnvelopeConsistent(variantEnvelope.result, variant);
  assertBuildProvenance(env);
  return buildNodeComparisonScanReportV2R2(
    {
      pairId: `pair-${randomBytes(16).toString("hex")}`,
      executedFirst,
      baseline: nodeBuilderInput(baseline, acquisition, mintRunId(baseline.emissionInputs.startedAt)),
      variant: nodeBuilderInput(variant, acquisition, mintRunId(variant.emissionInputs.startedAt))
    },
    env
  );
}

function assertBuildProvenance(env: NodeJS.ProcessEnv): void {
  if (recordedBuildCommit(env) === null) {
    throw new RuntimeR2BuildPrerequisiteError(
      "build-provenance-missing",
      `${BUILD_COMMIT_ENV} must identify a full 40-character Git commit; unknown provenance is rejected.`
    );
  }
}

function requireMeasurementEnvelope(envelope: NodeScanMeasurementEnvelope): NodeScanMeasurement {
  const candidate = envelope as unknown;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("result" in candidate) ||
    typeof candidate.result !== "object" ||
    candidate.result === null ||
    !("measurement" in candidate) ||
    typeof candidate.measurement !== "object" ||
    candidate.measurement === null
  ) {
    throw new RuntimeR2BuildPrerequisiteError(
      "measurement-envelope-missing",
      "The completed Node scan is missing its explicit r2 measurement envelope."
    );
  }
  return structuredClone(candidate.measurement as NodeScanMeasurement);
}

function assertMeasurementEnvelopeConsistent(result: ScanResult, measurement: NodeScanMeasurement): void {
  const inputs = measurement.emissionInputs;
  const expectedShields = result.conditions.shieldsMode ?? "classification";
  const mismatches: string[] = [];
  const compare = (name: string, left: unknown, right: unknown) => {
    if (!Object.is(left, right)) mismatches.push(name);
  };

  compare("startedAt", result.conditions.scannedAt, inputs.startedAt);
  compare("gpc", result.conditions.gpcEnabled, inputs.conditions.gpc);
  compare("consent", result.conditions.consentMode, inputs.conditions.consent);
  compare("shields", expectedShields, inputs.conditions.shields);
  compare("viewport.width", result.conditions.viewport.width, inputs.conditions.device.viewport.width);
  compare("viewport.height", result.conditions.viewport.height, inputs.conditions.device.viewport.height);
  compare("viewport.isMobile", result.conditions.viewport.isMobile, inputs.conditions.device.viewport.isMobile);
  compare("device.kind", result.conditions.viewport.isMobile ? "mobile" : "desktop", inputs.conditions.device.kind);
  compare("browser.version", result.conditions.chromiumVersion, inputs.conditions.browser.version);
  compare("locale", result.conditions.locale, inputs.conditions.locale);
  compare("language", result.conditions.language, inputs.conditions.language);
  compare("timezone", result.conditions.timezone, inputs.conditions.timezone);
  compare("automation", result.conditions.automation, inputs.conditions.automation);
  compare("headless", result.conditions.headless, inputs.conditions.headless);
  compare("egress.label", result.conditions.scannerEgress, inputs.conditions.egress.label);
  compare("navigation.status", result.summary.status, measurement.measurement.qualityFacts.status);
  compare("screenshot", result.screenshot, inputs.screenshot);

  if (mismatches.length > 0) {
    throw new RuntimeR2BuildPrerequisiteError(
      "measurement-envelope-inconsistent",
      `The Node scan result and r2 measurement envelope disagree on: ${mismatches.join(", ")}.`
    );
  }
}

function mintRunId(startedAt: string): string {
  return `${startedAt.slice(0, 10).replaceAll("-", "")}-${randomBytes(16).toString("hex")}`;
}

function nodeBuilderInput(
  measurement: NodeScanMeasurement,
  acquisition: AcquisitionKind,
  runId: string
): NodeScanReportV2R2Input {
  const inputs = measurement.emissionInputs;
  return {
    runId,
    startedAt: inputs.startedAt,
    requestedUrl: inputs.requestedUrl,
    observedUrl: inputs.observedUrl,
    conditions: inputs.conditions,
    acquisition,
    adblockEngineLoaded: inputs.adblockEngineLoaded,
    measurement: measurement.measurement,
    evidence: measurement.evidence,
    summary: { pageTitle: inputs.pageTitle, durationMs: inputs.durationMs },
    ...(measurement.consent !== undefined ? { consent: measurement.consent } : {}),
    verificationFacts: measurement.verificationFacts,
    warnings: inputs.warnings,
    screenshot: inputs.screenshot
  };
}
