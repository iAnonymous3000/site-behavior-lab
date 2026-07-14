import { createHash } from "node:crypto";
import { FULL_GIT_SHA } from "./build-provenance";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { aggregateSupportingPairR2 } from "./scan-report-v2-r2-aggregate";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";

const SAFE_SOURCE_KEY = /^[^\u0000-\u001f\u007f]{1,1024}$/;

export type AggregateV2ShadowArgs = {
  primaryFile: string;
  supportingFile: string;
  outputDirectory: string;
  expectedBuild: string;
  primaryKey?: string;
  supportingKey?: string;
  requireCounterbalanced: boolean;
};

export type V2ShadowAggregationReceipt = {
  receiptVersion: 1;
  createdAt: string;
  buildCommit: string;
  axis: "gpc" | "shields" | "consent";
  pairs: 2;
  counterbalanced: boolean;
  strength: "observed-difference";
  artifact: {
    file: string;
    pairId: string;
    sha256: string;
    publicBytes: number;
  };
  inputs: [
    { role: "primary"; key: string; pairId: string; sha256: string },
    { role: "supporting"; key: string; pairId: string; sha256: string }
  ];
};

export type AggregateV2ShadowFilesResult = {
  artifactPath: string;
  receiptPath: string;
  receipt: V2ShadowAggregationReceipt;
};

export function parseAggregateV2ShadowArgs(args: string[]): AggregateV2ShadowArgs {
  const values = new Map<string, string>();
  let requireCounterbalanced = false;
  const valueFlags = new Set([
    "--primary",
    "--supporting",
    "--out-dir",
    "--expected-build",
    "--primary-key",
    "--supporting-key"
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--require-counterbalanced") {
      if (requireCounterbalanced) throw new Error("--require-counterbalanced may be specified only once.");
      requireCounterbalanced = true;
      continue;
    }
    if (!valueFlags.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (values.has(argument)) throw new Error(`${argument} may be specified only once.`);
    const value = args[++index]?.trim() ?? "";
    if (!value) throw new Error(`${argument} requires a non-empty value.`);
    values.set(argument, value);
  }

  const primaryFile = requiredValue(values, "--primary");
  const supportingFile = requiredValue(values, "--supporting");
  const outputDirectory = requiredValue(values, "--out-dir");
  const expectedBuild = requiredValue(values, "--expected-build").toLowerCase();
  if (!FULL_GIT_SHA.test(expectedBuild)) {
    throw new Error("--expected-build must be a full 40-character Git SHA.");
  }
  if (path.resolve(primaryFile) === path.resolve(supportingFile)) {
    throw new Error("--primary and --supporting must identify different files.");
  }

  const primaryKey = values.get("--primary-key");
  const supportingKey = values.get("--supporting-key");
  if (primaryKey !== undefined) assertSafeSourceKey(primaryKey, "--primary-key");
  if (supportingKey !== undefined) assertSafeSourceKey(supportingKey, "--supporting-key");

  return {
    primaryFile: path.resolve(primaryFile),
    supportingFile: path.resolve(supportingFile),
    outputDirectory: path.resolve(outputDirectory),
    expectedBuild,
    ...(primaryKey !== undefined ? { primaryKey } : {}),
    ...(supportingKey !== undefined ? { supportingKey } : {}),
    requireCounterbalanced
  };
}

/**
 * Read two exact local shadow files and create one derived public r2 artifact
 * plus a local-only receipt. The receipt binds the source object keys (or safe
 * filename defaults) to hashes of the exact downloaded bytes; it is not part
 * of the frozen report schema and must not be published as report evidence.
 */
export async function aggregateV2ShadowFiles(
  input: AggregateV2ShadowArgs,
  now: () => Date = () => new Date()
): Promise<AggregateV2ShadowFilesResult> {
  if (!FULL_GIT_SHA.test(input.expectedBuild)) {
    throw new Error("Expected build must be a full lowercase 40-character Git SHA.");
  }
  if (path.resolve(input.primaryFile) === path.resolve(input.supportingFile)) {
    throw new Error("Primary and supporting inputs must be different files.");
  }

  const [primaryBytes, supportingBytes] = await Promise.all([
    readFile(input.primaryFile, "utf8"),
    readFile(input.supportingFile, "utf8")
  ]);
  assertBoundedInput(primaryBytes, "Primary input");
  assertBoundedInput(supportingBytes, "Supporting input");
  const primary = parseJson(primaryBytes, "Primary input");
  const supporting = parseJson(supportingBytes, "Supporting input");
  const aggregated = aggregateSupportingPairR2(primary, supporting);
  if (aggregated.buildCommit !== input.expectedBuild) {
    throw new Error(
      `Aggregated report build ${aggregated.buildCommit} does not match --expected-build ${input.expectedBuild}.`
    );
  }
  if (input.requireCounterbalanced && !aggregated.counterbalanced) {
    throw new Error("The two recorded pairs have the same order; counterbalanced AB/BA evidence was required.");
  }

  const primaryKey = input.primaryKey ?? path.basename(input.primaryFile);
  const supportingKey = input.supportingKey ?? path.basename(input.supportingFile);
  assertSafeSourceKey(primaryKey, "primary source key");
  assertSafeSourceKey(supportingKey, "supporting source key");
  if (primaryKey === supportingKey) {
    throw new Error("Primary and supporting source keys must be distinct.");
  }

  const artifactFile = `${aggregated.primaryPairId}.json`;
  const receiptFile = `${aggregated.primaryPairId}.receipt.json`;
  const artifactWire = `${JSON.stringify(aggregated.report, null, 2)}\n`;
  const receipt: V2ShadowAggregationReceipt = {
    receiptVersion: 1,
    createdAt: validIsoTimestamp(now()),
    buildCommit: aggregated.buildCommit,
    axis: aggregated.axis,
    pairs: 2,
    counterbalanced: aggregated.counterbalanced,
    strength: "observed-difference",
    artifact: {
      file: artifactFile,
      pairId: aggregated.primaryPairId,
      sha256: sha256(artifactWire),
      publicBytes: aggregated.publicBytes
    },
    inputs: [
      {
        role: "primary",
        key: primaryKey,
        pairId: aggregated.primaryPairId,
        sha256: sha256(primaryBytes)
      },
      {
        role: "supporting",
        key: supportingKey,
        pairId: aggregated.supportingPairId,
        sha256: sha256(supportingBytes)
      }
    ]
  };
  const receiptWire = `${JSON.stringify(receipt, null, 2)}\n`;

  await mkdir(input.outputDirectory, { recursive: true });
  const artifactPath = path.join(input.outputDirectory, artifactFile);
  const receiptPath = path.join(input.outputDirectory, receiptFile);
  await writeFile(artifactPath, artifactWire, { flag: "wx" });
  try {
    await writeFile(receiptPath, receiptWire, { flag: "wx" });
  } catch (error) {
    // Roll back only the artifact created by this invocation. Both outputs are
    // create-only, so an existing operator receipt is never replaced.
    await rm(artifactPath, { force: true });
    throw error;
  }

  return { artifactPath, receiptPath, receipt };
}

export function formatV2ShadowAggregationResult(result: AggregateV2ShadowFilesResult): string {
  const receipt = result.receipt;
  return [
    `Aggregated 2 complete ${receipt.axis} pairs for build ${receipt.buildCommit}.`,
    `Order coverage: ${receipt.counterbalanced ? "AB and BA (counterbalanced)" : "one order only (not counterbalanced)"}.`,
    "Evidence strength: observed-difference (r2 does not represent a replicated-effect claim).",
    `Artifact: ${path.basename(result.artifactPath)}`,
    `Local receipt: ${path.basename(result.receiptPath)}`
  ].join("\n");
}

function requiredValue(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseJson(contents: string, label: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
}

function assertBoundedInput(contents: string, label: string): void {
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES) {
    throw new Error(`${label} is ${bytes} bytes; the per-artifact limit is ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES}.`);
  }
}

function assertSafeSourceKey(value: string, label: string): void {
  if (!SAFE_SOURCE_KEY.test(value)) {
    throw new Error(`${label} must be 1-1024 characters with no control characters.`);
  }
}

function validIsoTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("Receipt time must be a valid Date.");
  return value.toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function main(): Promise<void> {
  const args = parseAggregateV2ShadowArgs(process.argv.slice(2));
  console.log(formatV2ShadowAggregationResult(await aggregateV2ShadowFiles(args)));
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
