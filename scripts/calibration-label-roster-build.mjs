#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalPrettyJson,
  readJsonFile,
  sha256Hex,
  validateCalibrationCandidateFiles
} from "./calibration-study-lib.mjs";
import {
  fetchAuthenticatedCalibrationLabelCommitments,
  validateCalibrationLabelSources
} from "./calibration-label-sources-lib.mjs";
import {
  CALIBRATION_ACQUISITION_WORKFLOW_PATH,
  CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
  calibrationCaseInputRootSha256,
  createCalibrationLabelRosterAuthorization
} from "./calibration-label-roster-lib.mjs";

const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const ROSTER_PRODUCER_CLOSURE_PATHS = [
  ".github/workflows/calibration-label-batch.yml",
  ".github/workflows/calibration-label-roster.yml",
  ".github/workflows/calibration-study.yml",
  "lib/calibration-scan-runtime.ts",
  "lib/canonical-json.ts",
  "lib/measurement-candidate-binding.ts",
  "lib/node-scan-measurement.ts",
  "lib/scanner.ts",
  "package-lock.json",
  "package.json",
  "scripts/calibration-acquisition-authorization-lib.mjs",
  "scripts/calibration-acquisition-authorization.mjs",
  "scripts/calibration-label-batch-build.mjs",
  "scripts/calibration-label-roster-build.mjs",
  "scripts/calibration-label-roster-lib.mjs",
  "scripts/calibration-label-source-envelope-lib.mjs",
  "scripts/calibration-label-sources-lib.mjs",
  "scripts/calibration-study-acquire.mjs",
  "scripts/calibration-study-archive-lib.mjs",
  "scripts/calibration-study-assemble.mjs",
  "scripts/calibration-study-finalize.mjs",
  "scripts/calibration-study-lib.mjs",
  "scripts/calibration-study-preflight.mjs",
  "tsconfig.calibration.json",
  "tsconfig.schema.json"
];
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const eventCommit = requiredEnv("GITHUB_SHA").toLowerCase();
const checkoutCommit = git(rootDir, ["rev-parse", "HEAD"]).toLowerCase();
const actor = requiredEnv("GITHUB_ACTOR").toLowerCase();
const triggeringActor = requiredEnv("GITHUB_TRIGGERING_ACTOR").toLowerCase();
const runId = positiveInteger(requiredEnv("GITHUB_RUN_ID"), "GITHUB_RUN_ID");
const runAttempt = positiveInteger(
  requiredEnv("GITHUB_RUN_ATTEMPT"),
  "GITHUB_RUN_ATTEMPT"
);
if (
  requiredEnv("GITHUB_REPOSITORY") !== REPOSITORY ||
  requiredEnv("GITHUB_EVENT_NAME") !== "workflow_dispatch" ||
  requiredEnv("GITHUB_REF") !== "refs/heads/main" ||
  requiredEnv("GITHUB_WORKFLOW_REF") !==
    `${REPOSITORY}/${CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH}@refs/heads/main` ||
  checkoutCommit !== eventCommit ||
  actor !== triggeringActor ||
  runAttempt !== 1 ||
  git(rootDir, ["status", "--porcelain", "--untracked-files=all"]) !== ""
) {
  throw new Error(
    "roster build requires the clean non-delegated attempt-1 governed workflow checkout on main"
  );
}
assertCandidateCarrierBlobClosure(
  options.candidateCommit,
  checkoutCommit
);

const requireFromRoot = createRequire(import.meta.url);
const bindingModule = requireFromRoot(
  path.join(
    rootDir,
    "dist",
    "schema",
    "lib",
    "measurement-candidate-binding.js"
  )
);
const binding =
  bindingModule.verifiedMeasurementCandidateAcquisitionContext(rootDir, {
    requireCleanWorktree: true
  });
if (
  !binding ||
  binding.candidateCommit !== options.candidateCommit ||
  binding.carrierCommit !== checkoutCommit ||
  !binding.acceptedProducerCommits.includes(checkoutCommit) ||
  binding.evidenceIntroducedAt?.[options.sourcesPath] !== checkoutCommit ||
  !isAncestor(options.candidateCommit, checkoutCommit)
) {
  throw new Error(
    "roster build candidate and carrier must equal the verified measurement binding"
  );
}

const candidate = validateCalibrationCandidateFiles(
  options.candidateRoot,
  options.studyId
);
const candidateCheckout = git(options.candidateRoot, [
  "rev-parse",
  "HEAD"
]).toLowerCase();
const sourcesCommit = git(options.sourcesRoot, [
  "rev-parse",
  "HEAD"
]).toLowerCase();
if (
  candidate.detector !== options.detector ||
  candidateCheckout !== options.candidateCommit ||
  git(options.candidateRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all"
  ]) !== "" ||
  git(options.sourcesRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all"
  ]) !== "" ||
  sourcesCommit !== checkoutCommit
) {
  throw new Error(
    "roster candidate must be the verified ancestor and the coordinate source must be the exact clean evidence-only carrier"
  );
}

const sourcesRead = readJsonFile(
  path.join(options.sourcesRoot, ...options.sourcesPath.split("/")),
  "calibration label roster coordinate source",
  32 * 1024 * 1024
);
if (sourcesRead.text !== canonicalPrettyJson(sourcesRead.value)) {
  throw new Error(
    "calibration label roster coordinate source must be canonical JSON"
  );
}
const sources = validateCalibrationLabelSources(
  sourcesRead.value,
  candidate
);
if (
  sources.studyId !== options.studyId ||
  sources.detector !== options.detector ||
  sources.candidateCommit !== options.candidateCommit ||
  options.sourcesPath !==
    `calibration-labels/${options.studyId}/sources.json`
) {
  throw new Error(
    "calibration label roster coordinate source does not match the frozen candidate"
  );
}

const calculatedCaseInputRootSha256 = calibrationCaseInputRootSha256(
  options.caseInputRoot
);
if (
  calculatedCaseInputRootSha256 !== options.caseInputRootSha256
) {
  throw new Error(
    "case input root does not match its domain-separated dispatch digest"
  );
}

const commitments = fetchAuthenticatedCalibrationLabelCommitments({
  repository: REPOSITORY,
  sources,
  candidate,
  acceptedProducerCommits: binding.acceptedProducerCommits,
  isAncestor: (commit) => isAncestor(commit, checkoutCommit),
  scratchDir: options.scratchDir
});
const authorizationNonce = randomBytes(32).toString("hex");
const sourcesTree = git(options.sourcesRoot, [
  "rev-parse",
  "HEAD^{tree}"
]).toLowerCase();
const created = createCalibrationLabelRosterAuthorization({
  candidate,
  candidateCommit: options.candidateCommit,
  carrierCommit: checkoutCommit,
  source: {
    commit: sourcesCommit,
    tree: sourcesTree,
    path: options.sourcesPath,
    sha256: sha256Hex(sourcesRead.text)
  },
  producer: {
    repository: REPOSITORY,
    workflowPath: CALIBRATION_LABEL_ROSTER_WORKFLOW_PATH,
    workflowRef: "refs/heads/main",
    runId,
    runAttempt,
    headSha: checkoutCommit,
    actor,
    triggeringActor
  },
  authorization: {
    nonce: authorizationNonce,
    acquisitionWorkflowPath: CALIBRATION_ACQUISITION_WORKFLOW_PATH,
    authorizedRunAttempt: 1,
    caseInputRootSha256: calculatedCaseInputRootSha256
  },
  commitments
});

mkdirSync(options.outputDir, { recursive: false, mode: 0o700 });
writeFileSync(path.join(options.outputDir, "roster.json"), created.text, {
  flag: "wx",
  mode: 0o600
});
appendFileSync(
  requiredEnv("GITHUB_OUTPUT"),
  [
    `authorization_nonce=${authorizationNonce}`,
    `case_input_root_sha256=${calculatedCaseInputRootSha256}`,
    `roster_sha256=${created.sha256}`,
    `roster_run_name=${created.runName}`,
    ""
  ].join("\n")
);
console.log(
  `Prepared one attempt-1 pre-acquisition roster authorization for ${options.studyId}; no label plaintext or case-input path was published.`
);

function parseOptions(args) {
  const allowed = new Set([
    "--study-id",
    "--detector",
    "--candidate-commit",
    "--candidate-root",
    "--sources-root",
    "--sources-path",
    "--case-input-root",
    "--case-input-root-sha256",
    "--scratch-dir",
    "--output-dir"
  ]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !allowed.has(name) ||
      value === undefined ||
      value === "" ||
      value.startsWith("--") ||
      values.has(name)
    ) {
      throw new Error(
        `Invalid calibration label roster argument ${name ?? "(missing)"}`
      );
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) {
      throw new Error(`Missing required argument ${name}`);
    }
  }
  for (const name of [
    "--candidate-root",
    "--sources-root",
    "--scratch-dir",
    "--output-dir"
  ]) {
    if (!path.isAbsolute(values.get(name))) {
      throw new Error(`${name} must be absolute`);
    }
  }
  const studyId = values.get("--study-id");
  const candidateCommit = values.get("--candidate-commit");
  const sourcesPath = values.get("--sources-path");
  const caseInputRoot = values.get("--case-input-root");
  const caseInputRootSha256 = values.get("--case-input-root-sha256");
  if (
    !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(studyId) ||
    !/^[0-9a-f]{40}$/.test(candidateCommit) ||
    !/^[a-z0-9][a-z0-9._/-]{0,499}\.json$/.test(sourcesPath) ||
    sourcesPath.includes("..") ||
    sourcesPath.includes("//") ||
    !caseInputRoot.startsWith("/") ||
    caseInputRoot.includes("\n") ||
    caseInputRoot.includes("\r") ||
    !/^[0-9a-f]{64}$/.test(caseInputRootSha256)
  ) {
    throw new Error("calibration label roster arguments are malformed");
  }
  return {
    studyId,
    detector: values.get("--detector"),
    candidateCommit,
    candidateRoot: values.get("--candidate-root"),
    sourcesRoot: values.get("--sources-root"),
    sourcesPath,
    caseInputRoot,
    caseInputRootSha256,
    scratchDir: values.get("--scratch-dir"),
    outputDir: values.get("--output-dir")
  };
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 10 ** 15) {
    throw new Error(`${label} must be a bounded positive integer`);
  }
  return parsed;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isAncestor(commit, descendant) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, descendant], {
      cwd: rootDir,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function assertCandidateCarrierBlobClosure(candidateCommit, carrierCommit) {
  for (const closurePath of ROSTER_PRODUCER_CLOSURE_PATHS) {
    try {
      execFileSync(
        "git",
        [
          "diff",
          "--quiet",
          candidateCommit,
          carrierCommit,
          "--",
          closurePath
        ],
        {
          cwd: rootDir,
          stdio: "ignore"
        }
      );
    } catch {
      throw new Error(
        `roster producer closure ${closurePath} changed between candidate and evidence-only carrier`
      );
    }
  }
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  }).trim();
}
