/**
 * The pilot carrier check: proves, from committed bytes alone, that a pilot's
 * frame was derived from the input-carrier commit it names.
 *
 * WHY A TWO-COMMIT CEREMONY. The frame's every task file embeds
 * `candidateCommit`, so a carrier defined as "the commit containing the frame"
 * would have to contain files that embed its own sha: unsatisfiable. The
 * ceremony therefore has an INPUT carrier K (pilot set, universe provenance,
 * sealing public key: everything the build reads, and no frame files) and a
 * later freeze commit that lands the frame plus `pilot-carrier.txt` naming K.
 * K is the identity every batch, envelope, authorization, and resolved
 * artifact binds.
 *
 * WHY THIS IS DECIDABLE RATHER THAN ASSERTED. The frame producer takes no
 * wall-clock input, so the check does not merely compare fields: it re-derives
 * the frame from K's own bytes and requires BYTE equality with the committed
 * frame and every committed task file. A frame built from a different tree,
 * from edited inputs, or from a different commit cannot survive that.
 *
 * Refusal-only, and read-only with respect to git: every historical byte is
 * read through `git show`, never by checking anything out.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const pathJoin = path.join;
import { parseV4FrameTasksBytes } from "./calibration-v4-ceremony-lib.mjs";
import { CALIBRATION_CENSORING_POLICY_PATH, sha256Hex } from "./calibration-study-lib.mjs";

const SHA1 = /^[0-9a-f]{40}$/;

export const PILOT_CARRIER_FILE = "pilot-carrier.txt";
export const PILOT_SET_FILE = "pilot-set.json";
export const PILOT_UNIVERSE_FILE = "universe-provenance.json";
export const PILOT_PUBLIC_KEY_FILE = "label-sealing-public-key.pem";
export const PILOT_FRAME_FILE = "frame-tasks.json";
export const PILOT_TASKS_DIR = "tasks";

function require_(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run one git plumbing command; refuse rather than interpret a failure. */
function git(rootDir, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", rootDir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

function showAtCommit(rootDir, commit, repoPath, { allowMissing = false } = {}) {
  const out = git(rootDir, ["show", `${commit}:${repoPath}`], { allowFailure: true });
  if (out === null) {
    if (allowMissing) return null;
    throw new Error(`${repoPath} does not exist at ${commit}`);
  }
  return out;
}

/**
 * Verify a pilot study directory against the carrier it names.
 *
 * `studyDir` is repo-relative (the check reads HEAD's working-tree bytes for
 * the frame it is validating and K's bytes for every input).
 */
export function verifyPilotCarrier({ rootDir, studyDir, upstreamRef = "origin/main" }) {
  const dir = (name) => path.join(rootDir, studyDir, name);
  const repoPath = (name) => `${studyDir}/${name}`;

  // 1. The carrier file names exactly one commit, and nothing else.
  const carrierBytes = readFileSync(dir(PILOT_CARRIER_FILE), "utf8");
  require_(
    /^[0-9a-f]{40}\n$/.test(carrierBytes),
    `${PILOT_CARRIER_FILE} must be exactly one 40-hex commit sha and a newline`
  );
  const carrier = carrierBytes.trim();

  // 2. That commit is real, is an ancestor of what we are checking, and has
  //    LANDED upstream. Branch shas are not landed shas under rebase-merge, so
  //    a carrier that exists only locally would bind the study to a commit no
  //    reviewer can ever fetch.
  require_(
    git(rootDir, ["cat-file", "-e", `${carrier}^{commit}`], { allowFailure: true }) !== null,
    `carrier commit ${carrier} does not exist in this repository`
  );
  require_(
    git(rootDir, ["merge-base", "--is-ancestor", carrier, "HEAD"], { allowFailure: true }) !== null,
    `carrier commit ${carrier} is not an ancestor of HEAD`
  );
  require_(
    git(rootDir, ["rev-parse", "--verify", `${upstreamRef}^{commit}`], { allowFailure: true }) !== null,
    `${upstreamRef} is not available; fetch it before checking the carrier`
  );
  require_(
    git(rootDir, ["merge-base", "--is-ancestor", carrier, upstreamRef], { allowFailure: true }) !== null,
    `carrier commit ${carrier} has not landed on ${upstreamRef}; a branch sha is not the sha that lands`
  );

  // 3. The frame and every task file bind that commit and no other.
  const frameBytes = readFileSync(dir(PILOT_FRAME_FILE), "utf8");
  const frameTasks = parseV4FrameTasksBytes(frameBytes);
  require_(
    frameTasks.candidateCommit === carrier,
    `frame candidateCommit ${frameTasks.candidateCommit} is not the carrier ${carrier}`
  );
  const taskBytesByCaseId = new Map();
  for (const frameCase of frameTasks.cases) {
    const bytes = readFileSync(path.join(rootDir, studyDir, PILOT_TASKS_DIR, `${frameCase.caseId}.json`), "utf8");
    require_(
      JSON.parse(bytes).candidateCommit === carrier,
      `${frameCase.caseId} task does not bind the carrier ${carrier}`
    );
    taskBytesByCaseId.set(frameCase.caseId, bytes);
  }

  // 4. Every input the build read exists AT the carrier, unchanged since.
  const inputs = {};
  for (const name of [PILOT_SET_FILE, PILOT_UNIVERSE_FILE, PILOT_PUBLIC_KEY_FILE]) {
    const atCarrier = showAtCommit(rootDir, carrier, repoPath(name));
    const atHead = readFileSync(dir(name), "utf8");
    require_(
      atCarrier === atHead,
      `${name} changed after the carrier commit; the frame binds inputs that no longer exist`
    );
    inputs[name] = atCarrier;
  }
  // The universe provenance binds the pilot set by digest at the carrier too.
  const provenance = JSON.parse(inputs[PILOT_UNIVERSE_FILE]);
  require_(
    provenance.pilotSetSha256 === sha256Hex(inputs[PILOT_SET_FILE]),
    "universe provenance does not bind the carrier's pilot set"
  );

  // 5. ANTI-CIRCULARITY, decidable: the carrier must NOT already contain the
  //    frame it is the input to. This is what makes the two-commit split a
  //    checked fact rather than a claim in a document.
  for (const name of [PILOT_FRAME_FILE, PILOT_TASKS_DIR]) {
    require_(
      showAtCommit(rootDir, carrier, repoPath(name), { allowMissing: true }) === null,
      `${name} already exists at the carrier commit; the carrier is the frame's INPUT and cannot contain it`
    );
  }

  // 6. RE-DERIVATION, through the carrier's OWN frame producer.
  //
  //    The check extracts K's whole tree and runs the frame CLI that lives in
  //    it. It deliberately does NOT call the builder library with arguments
  //    assembled here: the recipe (which protocol digest must match, where the
  //    external definitions come from, how cases map) lives in that CLI, and
  //    restating it here would be the same contract duplication that lets two
  //    halves pass their own tests while disagreeing. Running K's own CLI also
  //    settles WHICH code the derivation claims: the code as it stood at the
  //    carrier, which is the code the operator actually ran, reviewed and
  //    CI-gated on the protected branch like every other commit.
  const workRoot = mkdtempSync(pathJoin(tmpdir(), "pilot-carrier-"));
  try {
    const treeRoot = pathJoin(workRoot, "tree");
    mkdirSync(treeRoot, { recursive: true });
    const archive = spawnSync("git", ["-C", rootDir, "archive", carrier], {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024
    });
    require_(archive.status === 0, `git archive ${carrier} failed`);
    const extract = spawnSync("tar", ["-x", "-C", treeRoot], { input: archive.stdout });
    require_(extract.status === 0, `extracting the carrier tree failed`);
    const artifactBytes = readFileSync(pathJoin(treeRoot, CALIBRATION_CENSORING_POLICY_PATH), "utf8");
    const artifact = JSON.parse(artifactBytes);
    require_(
      frameTasks.referenceProtocolId === artifact.referenceProtocol.id,
      `the frame's protocol id ${frameTasks.referenceProtocolId} is not the carrier's approved ${artifact.referenceProtocol.id}`
    );
    const outputRoot = pathJoin(workRoot, "rederived");
    const rebuild = spawnSync(
      process.execPath,
      [
        pathJoin(treeRoot, "scripts", "calibration-v4-frame-tasks.mjs"), "build",
        "--study-id", frameTasks.studyId,
        "--detector", frameTasks.detector,
        "--candidate-commit", carrier,
        "--protocol-id", frameTasks.referenceProtocolId,
        "--protocol-file", pathJoin(treeRoot, artifact.referenceProtocol.path),
        "--cases", pathJoin(treeRoot, studyDir, PILOT_SET_FILE),
        "--output-root", outputRoot
      ],
      { encoding: "utf8" }
    );
    require_(
      rebuild.status === 0,
      `the carrier's own frame producer refuses to rebuild this frame: ${(rebuild.stderr || rebuild.stdout || "").trim()}`
    );
    require_(
      readFileSync(pathJoin(outputRoot, PILOT_FRAME_FILE), "utf8") === frameBytes,
      "the committed frame is not what the carrier's own producer derives from the carrier's own inputs; it was built from a different tree"
    );
    for (const frameCase of frameTasks.cases) {
      require_(
        readFileSync(pathJoin(outputRoot, PILOT_TASKS_DIR, `${frameCase.caseId}.json`), "utf8") ===
          taskBytesByCaseId.get(frameCase.caseId),
        `${frameCase.caseId} task is not what the carrier's own producer derives`
      );
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }

  // The tasks DIRECTORY is compared, not the frame's own case list: comparing
  // two projections of the frame would compare a thing to itself and could
  // never fail. An unnamed file beside the tasks is a task nothing verifies.
  const onDisk = readdirSync(pathJoin(rootDir, studyDir, PILOT_TASKS_DIR)).sort();
  const expected = frameTasks.cases.map((frameCase) => `${frameCase.caseId}.json`).sort();
  require_(
    JSON.stringify(onDisk) === JSON.stringify(expected),
    `the tasks directory does not match the frame's cases: ${JSON.stringify(onDisk.filter((name) => !expected.includes(name)))} unnamed`
  );
  return {
    carrier,
    studyId: frameTasks.studyId,
    detector: frameTasks.detector,
    cases: frameTasks.cases.length,
    frameTasksSha256: sha256Hex(frameBytes)
  };
}
