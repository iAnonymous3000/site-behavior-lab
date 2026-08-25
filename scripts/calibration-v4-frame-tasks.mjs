#!/usr/bin/env node
/**
 * Produce (or --check) a v4 frame-tasks artifact and its per-case
 * reference-task files from a candidate-set file (the universe builder's
 * pilot or pool output). Build mode is create-only; check mode re-derives
 * nothing and verifies the EXACT bytes on disk against the artifact, which
 * is the same verification the seal and reveal paths run.
 *
 *   node scripts/calibration-v4-frame-tasks.mjs build \
 *     --study-id <id> --detector <id> --candidate-commit <40-hex> \
 *     --protocol-id <id> --cases <candidates.json> --output-root <dir>
 *   node scripts/calibration-v4-frame-tasks.mjs check \
 *     --frame-tasks <frame-tasks.json> --tasks-dir <dir>
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildV4FrameTasksArtifact,
  parseV4FrameTasksBytes,
  requireApprovedCensoringPolicyAssignments,
  verifyV4TaskBytes
} from "./calibration-v4-ceremony-lib.mjs";
import { parseCandidateSet } from "./calibration-candidate-set-lib.mjs";
import { sha256Hex } from "./calibration-study-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USAGE =
  "usage: calibration-v4-frame-tasks.mjs build --study-id <id> --detector <id> --candidate-commit <sha> --protocol-id <id> --protocol-file <path> --cases <candidates.json> --output-root <dir> | check --frame-tasks <frame-tasks.json> --tasks-dir <dir>";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseFlags(args, allowed) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || !value || value.startsWith("--") || values.has(name)) {
      fail(USAGE);
    }
    values.set(name, value);
  }
  for (const name of allowed) {
    if (!values.has(name)) fail(`Missing required argument ${name}\n${USAGE}`);
  }
  return values;
}

function readTasksDir(tasksDir) {
  const taskBytesByCaseId = new Map();
  for (const file of readdirSync(tasksDir)) {
    if (!file.endsWith(".json")) fail(`${file} in the tasks directory is not a task file`);
    taskBytesByCaseId.set(
      file.slice(0, -".json".length),
      readFileSync(path.join(tasksDir, file), "utf8")
    );
  }
  return taskBytesByCaseId;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "build") {
  const values = parseFlags(
    rest,
    new Set([
      "--study-id",
      "--detector",
      "--candidate-commit",
      "--protocol-id",
      "--protocol-file",
      "--cases",
      "--output-root"
    ])
  );
  if (!/^[0-9a-f]{40}$/.test(values.get("--candidate-commit"))) {
    fail("--candidate-commit must be a full 40-character lowercase git sha");
  }
  // GOVERNANCE GATE: no frame exists before the named-human approval of the
  // per-detector policy, and a held detector cannot be framed at all.
  const { artifact } = requireApprovedCensoringPolicyAssignments({
    rootDir: repoRoot,
    detector: values.get("--detector")
  });
  // PROTOCOL BYTES: the operator supplies the exact protocol file; its
  // digest and id must equal the approved artifact's pin, and both are
  // frozen into the frame so every downstream artifact inherits them.
  const protocolBytes = readFileSync(values.get("--protocol-file"), "utf8");
  const protocolSha256 = sha256Hex(protocolBytes);
  if (protocolSha256 !== artifact.referenceProtocol.sha256) {
    fail(
      `--protocol-file digest ${protocolSha256} does not equal the approved artifact's referenceProtocol.sha256 ${artifact.referenceProtocol.sha256}; reviewers must label under exactly the approved protocol bytes`
    );
  }
  if (values.get("--protocol-id") !== artifact.referenceProtocol.id) {
    fail(
      `--protocol-id must equal the approved artifact's referenceProtocol.id ${artifact.referenceProtocol.id}`
    );
  }
  // ONE candidate-set reader, shared with the reliability sweep and the
  // reviewer's reference instrument; the study it must belong to is checked
  // here, by the caller that knows which study it is building.
  let candidateSet;
  try {
    candidateSet = parseCandidateSet(readFileSync(values.get("--cases"), "utf8"));
  } catch (error) {
    fail(error.message);
  }
  if (candidateSet.studyId !== values.get("--study-id")) {
    fail(
      `candidate set studyId ${candidateSet.studyId} does not match --study-id ${values.get("--study-id")}`
    );
  }
  const { frameTasks, frameTasksBytes, frameTasksSha256, taskBytesByCaseId } =
    buildV4FrameTasksArtifact({
      studyId: values.get("--study-id"),
      detector: values.get("--detector"),
      candidateCommit: values.get("--candidate-commit"),
      referenceProtocolId: values.get("--protocol-id"),
      referenceProtocolSha256: protocolSha256,
      // COPIED from the approved artifact, never restated: the shared
      // external classification pins ride the frame into every batch,
      // authorization, and worksheet refusal downstream.
      externalDefinitions:
        artifact.detectors[values.get("--detector")].externalDefinitions,
      cases: candidateSet.candidates
    });
  const root = values.get("--output-root");
  const tasksDir = path.join(root, "tasks");
  mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
  for (const [caseId, bytes] of taskBytesByCaseId) {
    writeFileSync(path.join(tasksDir, `${caseId}.json`), bytes, { flag: "wx", mode: 0o600 });
  }
  writeFileSync(path.join(root, "frame-tasks.json"), frameTasksBytes, {
    flag: "wx",
    mode: 0o600
  });
  console.log(
    `frame tasks written: ${frameTasks.cases.length} cases, frameTasksSha256 ${frameTasksSha256}`
  );
} else if (mode === "check") {
  const values = parseFlags(rest, new Set(["--frame-tasks", "--tasks-dir"]));
  const frameTasks = parseV4FrameTasksBytes(readFileSync(values.get("--frame-tasks"), "utf8"));
  verifyV4TaskBytes({ frameTasks, taskBytesByCaseId: readTasksDir(values.get("--tasks-dir")) });
  console.log(`frame tasks verified: ${frameTasks.cases.length} cases match their task bytes`);
} else {
  fail(USAGE);
}
