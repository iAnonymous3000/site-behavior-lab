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
import {
  buildV4FrameTasksArtifact,
  parseV4FrameTasksBytes,
  verifyV4TaskBytes
} from "./calibration-v4-ceremony-lib.mjs";

const USAGE =
  "usage: calibration-v4-frame-tasks.mjs build --study-id <id> --detector <id> --candidate-commit <sha> --protocol-id <id> --cases <candidates.json> --output-root <dir> | check --frame-tasks <frame-tasks.json> --tasks-dir <dir>";

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
      "--cases",
      "--output-root"
    ])
  );
  if (!/^[0-9a-f]{40}$/.test(values.get("--candidate-commit"))) {
    fail("--candidate-commit must be a full 40-character lowercase git sha");
  }
  const casesFile = JSON.parse(readFileSync(values.get("--cases"), "utf8"));
  if (casesFile.studyId !== values.get("--study-id")) {
    fail(
      `candidate set studyId ${casesFile.studyId} does not match --study-id ${values.get("--study-id")}`
    );
  }
  const { frameTasks, frameTasksBytes, frameTasksSha256, taskBytesByCaseId } =
    buildV4FrameTasksArtifact({
      studyId: values.get("--study-id"),
      detector: values.get("--detector"),
      candidateCommit: values.get("--candidate-commit"),
      referenceProtocolId: values.get("--protocol-id"),
      cases: casesFile.candidates.map((entry) => ({ caseId: entry.caseId, url: entry.url }))
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
