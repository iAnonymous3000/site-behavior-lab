#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aaComparisonFirstArm,
  aaExecutionPlan,
  createAaArtifact,
  writeAaArtifact
} from "./aa-study-producer-lib.mjs";
import { evaluateAaStudy } from "./aa-study-lib.mjs";
import {
  buildAttemptLedger,
  sanitizeAttemptReason,
  scannerFidelitySitesOf,
  sha256Hex
} from "./scanner-fidelity-study-lib.mjs";
import {
  ensureRenderBridge,
  evaluateScanBody
} from "./scanner-fidelity-invariants.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const candidateCommit = requiredEnv("AA_CANDIDATE_COMMIT");
const carrierCommit = requiredEnv("AA_CARRIER_COMMIT");
const checkoutCommit = git(["rev-parse", "HEAD"]).toLowerCase();
if (checkoutCommit !== candidateCommit) {
  throw new Error("A/A acquisition checkout does not equal frozen candidate C");
}
if (git(["status", "--porcelain", "--untracked-files=all"]) !== "") {
  throw new Error("Frozen candidate checkout is dirty before A/A acquisition");
}

const studyRoot = path.join(rootDir, "research", "aa-studies", options.studyId);
const preregistrationText = readFileSync(
  path.join(studyRoot, "preregistration.json"),
  "utf8"
);
const targetFrameText = readFileSync(
  path.join(studyRoot, "target-frame.json"),
  "utf8"
);
const preregistration = JSON.parse(preregistrationText);
const targetFrame = JSON.parse(targetFrameText);
const plan = aaExecutionPlan(preregistration);
const sites = scannerFidelitySitesOf(targetFrame);
if (
  preregistration.studyId !== options.studyId ||
  preregistration.targetCount !== sites.length
) {
  throw new Error("A/A preregistration does not match the complete target frame");
}

const requireFromRoot = createRequire(import.meta.url);
const scanApi = requireFromRoot(
  path.join(rootDir, "dist", "aa-study", "lib", "scan-api.js")
);
const urlSafety = requireFromRoot(
  path.join(rootDir, "dist", "aa-study", "lib", "url-safety.js")
);
if (
  typeof scanApi.executePreparedScan !== "function" ||
  typeof urlSafety.assertPublicHttpUrl !== "function"
) {
  throw new Error("The process-local A/A scanner artifact is unavailable");
}

// Build the exact renderer before the first visit. A broken report renderer is
// a producer failure, never a reason to silently collect a weaker study.
const renderBridge = ensureRenderBridge();
const attempts = [];
const collectionStartedAt = new Date().toISOString();
for (const site of sites) {
  await urlSafety.assertPublicHttpUrl(new URL(site.url), {
    timeoutMs: 5_000
  });
  for (
    let repetition = 1;
    repetition <= preregistration.repetitionsPerTarget;
    repetition += 1
  ) {
    process.stdout.write(
      `A/A ${site.url} repetition ${repetition}/${preregistration.repetitionsPerTarget} ... `
    );
    try {
      const report = await scanApi.executePreparedScan(
        {
          clientKey: "aa-controlled-process",
          url: site.url,
          device: plan.device,
          gpcEnabled: plan.gpcEnabled,
          compareGpc: plan.compareGpc,
          compareShields: plan.compareShields,
          compareConsent: plan.compareConsent,
          rateLimitCost: plan.rateLimitCost
        },
        undefined,
        async (value) => value,
        undefined,
        false,
        {
          drawComparisonFirstArm: () =>
            aaComparisonFirstArm(repetition)
        }
      );
      const evaluated = evaluateScanBody(site.url, report, renderBridge);
      if (evaluated.failures.length > 0) {
        attempts.push({
          url: site.url,
          shape: "aa",
          repetition,
          outcome: "invariant-failure",
          reason: evaluated.failures.join(" | "),
          censoredFamilies: evaluated.censored,
          observation: evaluated.observation ?? null
        });
        console.log("invariant failure");
      } else {
        attempts.push({
          url: site.url,
          shape: "aa",
          repetition,
          outcome: "pass",
          reason: null,
          censoredFamilies: evaluated.censored,
          observation: evaluated.observation ?? null
        });
        console.log("pass");
      }
    } catch (error) {
      const reason = sanitizeAttemptReason(
        error instanceof Error ? error.message : String(error)
      );
      attempts.push({
        url: site.url,
        shape: "aa",
        repetition,
        outcome: "scan-failure",
        reason,
        censoredFamilies: [],
        observation: null
      });
      console.log(`scan failure (${reason})`);
    }
  }
}
const collectionCompletedAt = new Date().toISOString();
const ledger = buildAttemptLedger({
  createdAt: new Date().toISOString(),
  collection: {
    startedAt: collectionStartedAt,
    completedAt: collectionCompletedAt
  },
  baseOrigin: "process-local://aa-study",
  sitesFile: preregistration.sitesFile,
  shardIndex: 0,
  shardCount: 1,
  conditions: preregistration.conditions,
  repetitions: preregistration.repetitionsPerTarget,
  selectedTargets: sites.length,
  attempts,
  acceptanceThresholds: {
    minimumAnsweringTargets:
      preregistration.thresholds.minimumEligibleTargets,
    minimumRepeatableTargets:
      preregistration.thresholds.minimumEligibleTargets
  },
  provenance: {
    expectedBuildCommit: candidateCommit,
    measurementIdentityDigest:
      preregistration.measurementIdentityDigest,
    sitesFileDigest: sha256Hex(targetFrameText),
    driverRuntime: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      architecture: process.arch
    }
  }
});
const evaluation = evaluateAaStudy({
  preregistration,
  targetFrame,
  targetFrameText,
  ledger
});
if (evaluation.status !== "pass") {
  throw new Error(
    `A/A study did not pass its preregistered contract: ${evaluation.status}`
  );
}
const created = createAaArtifact({
  studyId: options.studyId,
  candidateCommit,
  carrierCommit,
  runId: positiveIntegerEnv("GITHUB_RUN_ID"),
  runAttempt: positiveIntegerEnv("GITHUB_RUN_ATTEMPT"),
  runner: {
    labelSha256: requiredEnv("AA_RUNNER_LABEL_SHA256"),
    identitySha256: requiredEnv("AA_RUNNER_IDENTITY_SHA256"),
    environment: "ephemeral-self-hosted"
  },
  egress: {
    identity: requiredEnv("AA_EGRESS_IDENTITY"),
    regionSha256: requiredEnv("AA_EGRESS_REGION_SHA256")
  },
  preregistrationText,
  targetFrameText,
  ledger,
  evaluation
});
writeAaArtifact(options.outputDirectory, created);
console.log(
  `A/A study ${options.studyId} passed with ${ledger.attemptedRuns} exact unsharded attempts.`
);

function parseOptions(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--study-id" ||
    args[2] !== "--output" ||
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(args[1] ?? "") ||
    !path.isAbsolute(args[3] ?? "")
  ) {
    throw new Error(
      "Usage: aa-study-acquire.mjs --study-id <id> --output <absolute-directory>"
    );
  }
  return { studyId: args[1], outputDirectory: args[3] };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnv(name) {
  const value = requiredEnv(name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
