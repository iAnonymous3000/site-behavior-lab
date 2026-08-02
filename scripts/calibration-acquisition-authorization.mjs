#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  verifyCalibrationCeremonyFilesLive
} from "./calibration-acquisition-authorization-lib.mjs";
import {
  calibrationLabelRosterRunSelectionSnapshot,
  fetchCalibrationLabelRosterRuns,
  validateCalibrationLabelRosterAuthorization,
  validateCalibrationLabelRosterGithubMetadata
} from "./calibration-label-roster-lib.mjs";

const VALUE_FLAGS = new Set([
  "--repository",
  "--study-id",
  "--candidate-commit",
  "--label-roster-authorization",
  "--label-roster-authorization-sha256",
  "--roster-selection-ledger",
  "--roster-selection-ledger-sha256",
  "--acquisition-attempt-ledger",
  "--acquisition-attempt-ledger-sha256"
]);

const options = parseArgs(process.argv.slice(2));
if (!options.verifyLive) {
  throw new Error("calibration acquisition authorization requires --verify-live");
}

const result = await verifyCalibrationCeremonyFilesLive({
  rootDir: process.cwd(),
  repository: options.values.get("--repository"),
  studyId: options.values.get("--study-id"),
  candidateCommit: options.values.get("--candidate-commit"),
  labelRosterAuthorizationPath:
    options.values.get("--label-roster-authorization"),
  labelRosterAuthorizationSha256:
    options.values.get("--label-roster-authorization-sha256"),
  rosterSelectionLedgerPath:
    options.values.get("--roster-selection-ledger"),
  rosterSelectionLedgerSha256:
    options.values.get("--roster-selection-ledger-sha256"),
  acquisitionAttemptLedgerPath:
    options.values.get("--acquisition-attempt-ledger"),
  acquisitionAttemptLedgerSha256:
    options.values.get("--acquisition-attempt-ledger-sha256"),
  validateRosterAuthorization:
    validateCalibrationLabelRosterAuthorization,
  fetchRosterRuns: fetchCalibrationLabelRosterRuns,
  buildRosterSelectionSnapshot:
    calibrationLabelRosterRunSelectionSnapshot,
  fetchRosterRun: ({ repository, runId }) =>
    githubJson(
      `/repos/${repository}/actions/runs/${runId}`,
      `calibration roster run ${runId}`
    ),
  fetchRosterArtifacts: ({ repository, runId, artifactName }) =>
    githubJson(
      `/repos/${repository}/actions/runs/${runId}/artifacts?` +
        `name=${encodeURIComponent(artifactName)}&per_page=100`,
      `calibration roster run ${runId} artifacts`
    ),
  validateRosterGithubMetadata:
    validateCalibrationLabelRosterGithubMetadata,
  requestJson: ({ endpoint }) =>
    githubJson(endpoint, "calibration acquisition Actions metadata")
});

process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);

function parseArgs(args) {
  const values = new Map();
  let verifyLive = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--verify-live") {
      if (verifyLive) throw new Error("--verify-live may be supplied only once");
      verifyLive = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new Error(`unknown calibration authorization argument ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`${flag} may be supplied only once`);
    }
    const value = args[index + 1];
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 4096 ||
      value.startsWith("--") ||
      value.includes("\u0000") ||
      value.includes("\n") ||
      value.includes("\r")
    ) {
      throw new Error(`${flag} requires one bounded value`);
    }
    values.set(flag, value);
    index += 1;
  }
  const missing = [...VALUE_FLAGS].filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    throw new Error(
      `missing calibration authorization arguments: ${missing.join(", ")}`
    );
  }
  return { verifyLive, values };
}

function githubJson(endpoint, label) {
  const output = execFileSync(
    "gh",
    [
      "api",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2022-11-28",
      endpoint
    ],
    {
      encoding: "utf8",
      env: { ...process.env },
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      timeout: 30_000
    }
  );
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}
