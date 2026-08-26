#!/usr/bin/env node
/**
 * Fetch the pilot's authenticated ciphertext commitments through the GitHub
 * API and write the canonical records directory `calibration:v4-pilot-close`
 * consumes.
 *
 * This is the step that turns three hosted workflow runs into evidence. The
 * verification is the SHARED fetcher's: it re-reads each run, checks the
 * workflow path, branch, actor and triggering actor, matches exactly one
 * artifact by its derived name, checks the archive digest, downloads and
 * re-validates the record, and re-derives its envelope digest. Nothing here
 * restates any of that.
 *
 * TWO THINGS THIS CLI DECIDES, because the fetcher takes them as inputs:
 *
 * 1. WHICH PRODUCER COMMITS ARE ACCEPTABLE. The fetcher requires each run's
 *    head sha to be in an accepted list AND an ancestor of the branch. A
 *    prevalence pilot has no measurement-candidate binding to read that list
 *    from, and the three reviewers dispatch at whatever main was at the time,
 *    which cannot be enumerated in advance. So the list is derived from
 *    committed history: every commit from the frame freeze up to the current
 *    upstream tip. A commitment minted from a producer older than the freeze,
 *    or from a commit that never landed upstream, is refused.
 * 2. WHAT THE RECORD FILES ARE CALLED. The close reads the directory in
 *    sorted filename order and that order becomes the frozen commitmentSetSha256
 *    the reveal later re-derives. Names are therefore zero-padded indexes in
 *    the fetcher's own order, so a re-fetch produces the same set identity.
 *
 *   node scripts/calibration-v4-fetch-commitments.mjs \
 *     --study-dir calibration/<studyId> --coordinates <coordinates.json> \
 *     --out-dir <records-dir> [--upstream-ref origin/main]
 *
 * coordinates.json is [{ "role": "labeler", "runId": 1, "runAttempt": 1,
 * "artifactId": 2, "archiveSha256": "<64 hex>" }, ...], one per reviewer, as
 * each reviewer reports after their run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CALIBRATION_V4_PILOT_LABEL_WORKFLOW_PATH,
  canonicalPrettyJson
} from "./calibration-study-lib.mjs";
import {
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  calibrationLabelPublicKeyIdentity
} from "./calibration-label-source-envelope-lib.mjs";
import { fetchAuthenticatedCalibrationLabelCommitments } from "./calibration-label-sources-lib.mjs";
import { parseV4FrameTasksBytes } from "./calibration-v4-ceremony-lib.mjs";
import { PILOT_CARRIER_FILE } from "./calibration-v4-pilot-carrier-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "usage: calibration-v4-fetch-commitments.mjs --study-dir <dir> --coordinates <file> --out-dir <dir> [--upstream-ref <ref>]";

function fail(message) {
  console.error(`calibration:v4-fetch-commitments: ${message}`);
  process.exit(1);
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFailure) return null;
    fail(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

const required = new Set(["--study-dir", "--coordinates", "--out-dir"]);
const allowed = new Set([...required, "--upstream-ref"]);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) fail(USAGE);
  values.set(name, value);
}
for (const name of required) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}
const upstreamRef = values.get("--upstream-ref") ?? "origin/main";
const studyDir = values.get("--study-dir");
const outDir = values.get("--out-dir");
if (existsSync(outDir)) fail(`--out-dir ${outDir} already exists; point it at a fresh directory`);

const frameTasks = parseV4FrameTasksBytes(
  readFileSync(path.join(repoRoot, studyDir, "frame-tasks.json"), "utf8")
);
const carrierBytes = readFileSync(path.join(repoRoot, studyDir, PILOT_CARRIER_FILE), "utf8");
if (!/^[0-9a-f]{40}\n$/.test(carrierBytes)) fail(`${PILOT_CARRIER_FILE} must be one 40-hex sha and a newline`);
const carrier = carrierBytes.trim();
if (frameTasks.candidateCommit !== carrier) {
  fail(`the committed frame binds ${frameTasks.candidateCommit}, and ${PILOT_CARRIER_FILE} names ${carrier}`);
}
const sealingKeyId = calibrationLabelPublicKeyIdentity(
  readFileSync(path.join(repoRoot, studyDir, "label-sealing-public-key.pem"), "utf8")
).keyId;

// The frame freeze is the commit that landed the frame; producers older than
// it cannot have read this frame.
const frameFreeze = git(["log", "-1", "--format=%H", "--", `${studyDir}/frame-tasks.json`]).trim();
if (!/^[0-9a-f]{40}$/.test(frameFreeze)) fail("could not find the commit that landed this frame");
if (git(["rev-parse", "--verify", `${upstreamRef}^{commit}`], { allowFailure: true }) === null) {
  fail(`${upstreamRef} is not available; fetch it before fetching commitments`);
}
const upstreamTip = git(["rev-parse", `${upstreamRef}^{commit}`]).trim();
const acceptedProducerCommits = [
  frameFreeze,
  ...git(["rev-list", upstreamTip, `^${frameFreeze}`]).split("\n").map((line) => line.trim()).filter(Boolean)
];

let coordinates;
try {
  coordinates = JSON.parse(readFileSync(values.get("--coordinates"), "utf8"));
} catch (error) {
  fail(`coordinates: ${error.message}`);
}
if (!Array.isArray(coordinates) || coordinates.length === 0) fail("coordinates must be a non-empty array");

const scratchDir = mkdtempSync(path.join(tmpdir(), "v4-commitments-"));
let records;
try {
  records = fetchAuthenticatedCalibrationLabelCommitments({
    repository: process.env.GITHUB_REPOSITORY ?? "iAnonymous3000/site-behavior-lab",
    scratchDir: path.join(scratchDir, "fetch"),
    expectedWorkflowPath: CALIBRATION_V4_PILOT_LABEL_WORKFLOW_PATH,
    acceptedProducerCommits,
    isAncestor: (sha) =>
      git(["merge-base", "--is-ancestor", sha, upstreamTip], { allowFailure: true }) !== null,
    candidate: {
      studyId: frameTasks.studyId,
      detector: frameTasks.detector,
      labelSealingKey: { algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM, keyId: sealingKeyId }
    },
    sources: {
      studyId: frameTasks.studyId,
      detector: frameTasks.detector,
      candidateCommit: carrier,
      commitments: coordinates
    }
  });
} catch (error) {
  fail(error.message);
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

mkdirSync(outDir, { recursive: true, mode: 0o700 });
records.forEach((record, index) => {
  // Zero-padded index in the FETCHER's order: the close reads this directory
  // sorted, and that order becomes the frozen commitment-set identity.
  const name = `${String(index + 1).padStart(3, "0")}-${record.commitment.role}-${record.metadata.actor}.json`;
  writeFileSync(path.join(outDir, name), canonicalPrettyJson(record), { flag: "wx", mode: 0o600 });
});
console.log(
  `fetched ${records.length} authenticated commitment(s) for ${frameTasks.studyId} into ${outDir}: ` +
    records.map((record) => `${record.commitment.role}@${record.metadata.actor}`).join(", ") +
    `. Producers accepted from ${frameFreeze.slice(0, 12)} up to ${upstreamTip.slice(0, 12)}.`
);
