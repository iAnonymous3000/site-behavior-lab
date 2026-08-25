#!/usr/bin/env node
/**
 * Close pilot labeling: freeze the authorized commitment set and the close
 * instant into ONE repo-committable artifact, the pilot labeling
 * authorization. The reveal takes no free boundary and no free roster;
 * both come from this artifact, whose repository commit is the anchor,
 * exactly as the v3 custody trio is anchored. CI reads it: the pilot carrier
 * gate validates every committed authorization against the frame it names and
 * refuses one that binds a different frame, identity, or carrier.
 *
 * WHAT THIS STEP DOES AND DOES NOT ESTABLISH. It reads record files from a
 * directory the operator supplies, so it cannot know that GitHub really ran
 * the workflow a record describes: that is the authenticated fetcher's job
 * (fetchAuthenticatedCalibrationLabelCommitments over the GitHub Actions
 * API), and the fields this artifact carries under "authenticated" are only
 * as good as the step that produced those files.
 *
 * What it CAN check from the bytes, it now checks, because this is the
 * irreversible step: the same set custody the reveal later runs (2..10
 * distinct labelers, exactly one blind tiebreaker, distinct actors, unique
 * source/envelope/ciphertext commitments, every commitment before the close),
 * each record's envelope digest recomputed rather than believed, and each
 * wrapper's keyId checked against the keyId inside its own sealed envelope.
 * Freezing a set the reveal would refuse used to be possible, and the
 * authorization naming it is committed to a protected branch.
 *
 * Records are read in lexicographic filename order, which becomes the
 * authorized order, so a rename changes the frozen set.
 *
 *   node scripts/calibration-v4-pilot-close.mjs \
 *     --frame-tasks <frame-tasks.json> --commitments-dir <dir> \
 *     --public-key <label-sealing-public-key.pem> --out <authorization.json>
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { calibrationLabelPublicKeyIdentity } from "./calibration-label-source-envelope-lib.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildV4PilotLabelingAuthorization,
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments,
  requireFrameMatchesApprovedArtifact
} from "./calibration-v4-ceremony-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { sha256Hex } from "./calibration-study-lib.mjs";

const USAGE =
  "usage: calibration-v4-pilot-close.mjs --frame-tasks <frame-tasks.json> --commitments-dir <dir> --public-key <pem> [--key-id <64-hex>] --out <authorization.json>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const allowed = new Set(["--frame-tasks", "--commitments-dir", "--public-key", "--key-id", "--out"]);
const values = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) fail(USAGE);
  values.set(name, value);
}
const required = new Set(["--frame-tasks", "--commitments-dir", "--public-key", "--out"]);
for (const name of required) {
  if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
}

const frameTasksBytes = readFileSync(values.get("--frame-tasks"), "utf8");
const frameTasks = parseV4FrameTasksBytes(frameTasksBytes);
// The sealing keyId is DERIVED from the ceremony's own committed public key,
// not typed from memory. It is the sha256 of that key's SPKI DER, no command
// printed it, and a typo produced a refusal that blamed the reviewers'
// commitments for disagreeing with a number the operator had mistyped.
let derivedKeyId;
try {
  derivedKeyId = calibrationLabelPublicKeyIdentity(
    readFileSync(values.get("--public-key"), "utf8")
  ).keyId;
} catch (error) {
  fail(`--public-key is not a usable sealing public key: ${error.message}`);
}
if (values.has("--key-id") && values.get("--key-id") !== derivedKeyId) {
  fail(
    `--key-id ${values.get("--key-id")} is not the keyId of --public-key (${derivedKeyId}); the committed public key is the ceremony's authority`
  );
}
const { artifact: approvedArtifact } = requireApprovedCensoringPolicyAssignments({ rootDir: repoRoot, detector: frameTasks.detector });
requireFrameMatchesApprovedArtifact(frameTasks, approvedArtifact);
const commitments = [];
for (const file of readdirSync(values.get("--commitments-dir")).sort()) {
  if (!file.endsWith(".json")) fail(`${file} in the commitments directory is not a record file`);
  commitments.push(JSON.parse(readFileSync(path.join(values.get("--commitments-dir"), file), "utf8")));
}
let closed;
try {
  closed = buildV4PilotLabelingAuthorization({
    studyId: frameTasks.studyId,
    detector: frameTasks.detector,
    candidateCommit: frameTasks.candidateCommit,
    referenceProtocolId: frameTasks.referenceProtocolId,
    keyId: derivedKeyId,
    frameTasksSha256: sha256Hex(frameTasksBytes),
    labelingClosedAt: new Date().toISOString(),
    commitments
  });
} catch (error) {
  fail(`calibration:v4-pilot-close: ${error.message}`);
}
const { text, sha256 } = closed;
mkdirSync(path.dirname(values.get("--out")), { recursive: true, mode: 0o700 });
writeFileSync(values.get("--out"), text, { flag: "wx", mode: 0o600 });
console.log(
  `pilot labeling closed: ${commitments.length} authorized commitments, authorization sha256 ${sha256}. Commit this artifact at calibration/${frameTasks.studyId}/pilot-labeling-authorization.json before any reveal.`
);
