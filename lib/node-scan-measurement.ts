import type {
  ConsentFactsR2,
  MeasurementKernelResultR2
} from "./scan-result-v2-r2-builder";
import type {
  GpcVerificationFactsR2,
  RunEvidenceR2,
  ShieldsVerificationFactsR2
} from "./scan-report-v2-r2";
import type { ConditionVector } from "./scan-report-v2";
import type { ScanResult } from "./types";

/**
 * Process-local facts collected by one live Node visit for controlled r2
 * production. Raw subject URLs remain private builder inputs and never become
 * fields on the frozen v1 or public r2 wires.
 */
export type NodeScanMeasurement = {
  measurement: MeasurementKernelResultR2;
  evidence: Omit<RunEvidenceR2, "consent">;
  /** Recorded consent facts (RFC 15.4/15.5); present on every consent-mode run. */
  consent?: ConsentFactsR2;
  verificationFacts: {
    gpc: GpcVerificationFactsR2;
    shields: ShieldsVerificationFactsR2;
  };
  /**
   * Raw builder inputs for public and shadow r2 emission (kernel step 4).
   * Process-local only: the r2 builder applies its own redaction when a report
   * is built from them.
   */
  emissionInputs: {
    startedAt: string;
    requestedUrl: string;
    observedUrl: string;
    conditions: ConditionVector;
    adblockEngineLoaded: boolean;
    pageTitle: string;
    durationMs: number;
    warnings: string[];
    screenshot: string | null;
  };
};

export type DeepReadonly<T> =
  T extends string | number | boolean | bigint | symbol | null | undefined | Function
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

/**
 * Explicit Node producer boundary. Keeping the frozen result and r2 facts in
 * one typed value means ordinary object transport, cloning, and scheduling
 * cannot silently sever the evidence needed by the r2 builder.
 */
export type NodeScanMeasurementEnvelope = Readonly<{
  result: ScanResult;
  measurement: DeepReadonly<NodeScanMeasurement>;
}>;

/**
 * Capture an owned snapshot of the measurement while preserving the exact v1
 * object returned by the scanner. Builders also clone before sanitizing, so
 * neither public nor shadow emission mutates this envelope.
 */
export function createNodeScanMeasurementEnvelope(
  result: ScanResult,
  measurement: NodeScanMeasurement
): NodeScanMeasurementEnvelope {
  const envelope = { result, measurement: deepFreeze(structuredClone(measurement)) };
  Object.defineProperty(envelope, "toJSON", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: () => {
      throw new Error("Node scan measurement envelopes are process-local and cannot be serialized.");
    }
  });
  return Object.freeze(envelope);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) return value as DeepReadonly<T>;
  if (seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}
