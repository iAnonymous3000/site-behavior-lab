#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync
} from "node:fs";
import {
  featuredControlledR2WorkflowIssues,
  MEASUREMENT_FREEZE_REPOSITORY,
  parseAndVerifyMeasurementFreezeActivationReceipt
} from "./measurement-freeze-activation-lib.mjs";
import {
  verifyMeasurementFreezeActivationArtifactContext,
  verifyMeasurementFreezeActivationArtifactLive
} from "./measurement-freeze-artifact-lib.mjs";
import {
  FEATURED_READJUDICATION_CATALOG,
  FEATURED_READJUDICATION_RECEIPT_PATH,
  featuredReadjudicationCatalogBinding,
  featuredReadjudicationDispositionsSha256,
  featuredReadjudicationOutcomesSha256,
  parseFeaturedReadjudicationReceipt
} from "./featured-readjudication-lib.mjs";

const args = process.argv.slice(2);
const values = new Map();
const valueFlags = new Set([
  "--receipt",
  "--repository",
  "--candidate",
  "--run-id",
  "--run-attempt",
  "--activation-workflow",
  "--featured-workflow",
  "--readjudication-receipt",
  "--featured-sites",
  "--live-artifact-context",
  "--live-artifact-context-sha256",
  "--now"
]);
const booleanFlags = new Set(["--verify-live-artifact"]);
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (booleanFlags.has(flag)) {
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    values.set(flag, "1");
    continue;
  }
  if (!valueFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`);
  if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
  const value = args[++index] ?? "";
  if (!value) throw new Error(`${flag} requires a value`);
  values.set(flag, value);
}
const receiptPath = values.get("--receipt");
if (!receiptPath) throw new Error("--receipt is required");
if (
  values.has("--verify-live-artifact") &&
  values.has("--live-artifact-context")
) {
  throw new Error(
    "--verify-live-artifact and --live-artifact-context are mutually exclusive"
  );
}
if (
  values.has("--live-artifact-context") !==
  values.has("--live-artifact-context-sha256")
) {
  throw new Error(
    "--live-artifact-context and --live-artifact-context-sha256 must be supplied together"
  );
}
function readBoundedRegular(file, label) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size <= 0 || info.size > 1024 * 1024) {
      throw new Error(
        `${label} must be one non-empty regular file no larger than 1 MiB`
      );
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== info.size) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
let receiptBytes;
let receiptText;
try {
  receiptBytes = readBoundedRegular(receiptPath, "--receipt");
  receiptText = new TextDecoder("utf-8", { fatal: true }).decode(
    receiptBytes
  );
} catch {
  throw new Error("--receipt must contain valid UTF-8");
}
const readjudicationPath = values.get("--readjudication-receipt");
if (!readjudicationPath) {
  throw new Error("--readjudication-receipt is required");
}
if (readjudicationPath !== FEATURED_READJUDICATION_RECEIPT_PATH) {
  throw new Error(
    `--readjudication-receipt must be exactly ${FEATURED_READJUDICATION_RECEIPT_PATH}`
  );
}
const featuredSitesPath = values.get("--featured-sites");
if (!featuredSitesPath) throw new Error("--featured-sites is required");
if (featuredSitesPath !== FEATURED_READJUDICATION_CATALOG) {
  throw new Error(
    `--featured-sites must be exactly ${FEATURED_READJUDICATION_CATALOG}`
  );
}
const readjudicationBytes = readBoundedRegular(
  readjudicationPath,
  "--readjudication-receipt"
);
const featuredSitesBytes = readBoundedRegular(
  featuredSitesPath,
  "--featured-sites"
);
let readjudicationText;
try {
  readjudicationText = new TextDecoder("utf-8", { fatal: true }).decode(
    readjudicationBytes
  );
} catch {
  throw new Error("--readjudication-receipt must contain valid UTF-8");
}
const readjudication = parseFeaturedReadjudicationReceipt(
  readjudicationText,
  featuredSitesBytes
);
const featuredCatalogBinding =
  featuredReadjudicationCatalogBinding(featuredSitesBytes);

const options = {
  expectedRepository:
    values.get("--repository") ?? MEASUREMENT_FREEZE_REPOSITORY,
  expectedCandidateSha: values.get("--candidate"),
  expectedRunId: values.has("--run-id")
    ? Number(values.get("--run-id"))
    : undefined,
  expectedRunAttempt: values.has("--run-attempt")
    ? Number(values.get("--run-attempt"))
    : undefined,
  now: values.get("--now"),
  expectedMeasurementFreeze:
    process.env.SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE,
  expectedRunnerLabel: process.env.FEATURED_RUNNER_LABEL,
  expectedScannerEgress: process.env.SCANNER_EGRESS,
  expectedScannerEgressRegion: process.env.SCANNER_EGRESS_REGION,
  expectedFeaturedR2EgressAttested:
    process.env.FEATURED_R2_EGRESS_ATTESTED,
  expectedReAdjudicationReceiptSha256: createHash("sha256")
    .update(readjudicationBytes)
    .digest("hex"),
  expectedFeaturedSitesSha256: createHash("sha256")
    .update(featuredSitesBytes)
    .digest("hex"),
  expectedFeaturedTargetsSha256: featuredCatalogBinding.targetsSha256,
  expectedReAdjudicationDispositionsSha256:
    featuredReadjudicationDispositionsSha256(readjudication),
  expectedReAdjudicationReceipt: readjudication,
  expectedReAdjudicationCycles: readjudication.cycles.map((cycle) => ({
    date: cycle.date,
    runId: cycle.actionsRun.id,
    runAttempt: cycle.actionsRun.attempt,
    headSha: cycle.actionsRun.headSha,
    catalogSha256: cycle.catalog.sha256,
    catalogTargetsSha256: cycle.catalog.targetsSha256,
    catalogVersion: cycle.catalog.version,
    artifactId: cycle.artifact.id,
    artifactName: cycle.artifact.name,
    artifactSha256: cycle.artifact.sha256,
    outcomesSha256: featuredReadjudicationOutcomesSha256(cycle)
  }))
};

const activationWorkflow = values.get("--activation-workflow");
if (activationWorkflow) {
  options.expectedActivationWorkflowSha256 = createHash("sha256")
    .update(readFileSync(activationWorkflow))
    .digest("hex");
}
const featuredWorkflow = values.get("--featured-workflow");
if (featuredWorkflow) {
  const source = readFileSync(featuredWorkflow, "utf8");
  const issues = featuredControlledR2WorkflowIssues(source);
  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }
  options.expectedFeaturedWorkflowSha256 = createHash("sha256")
    .update(source)
    .digest("hex");
}

const result = parseAndVerifyMeasurementFreezeActivationReceipt(
  receiptText,
  options
);
if (!result.ok) {
  for (const issue of result.issues) console.error(`FAIL ${issue}`);
  process.exitCode = 1;
} else {
  let artifactVerification;
  const liveArtifactContext = values.get("--live-artifact-context");
  if (liveArtifactContext) {
    artifactVerification =
      verifyMeasurementFreezeActivationArtifactContext({
        receipt: result.receipt,
        receiptBytes,
        contextDirectory: liveArtifactContext,
        expectedContextSha256: values.get(
          "--live-artifact-context-sha256"
        )
      });
  } else if (values.has("--verify-live-artifact")) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    artifactVerification =
      await verifyMeasurementFreezeActivationArtifactLive({
        receipt: result.receipt,
        receiptBytes,
        token
      });
  }
  console.log(
    `PASS measurement-freeze activation receipt sha256:${result.receiptSha256}`
  );
  if (artifactVerification) {
    console.log(
      `PASS immutable activation artifact id:${artifactVerification.artifactId} sha256:${artifactVerification.artifactSha256}`
    );
  }
}
