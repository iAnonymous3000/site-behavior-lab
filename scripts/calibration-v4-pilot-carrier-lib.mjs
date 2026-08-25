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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const pathJoin = path.join;
import {
  V4_PILOT_SIZING_KIND,
  V4_PILOT_SIZING_SCHEMA_VERSION,
  computeV4PilotSizingArtifact,
  parseV4FrameTasksBytes,
  validateV4PilotLabelingAuthorization,
  validateV4ResolvedLabelsArtifact
} from "./calibration-v4-ceremony-lib.mjs";
import { CALIBRATION_CENSORING_POLICY_PATH, sha256Hex } from "./calibration-study-lib.mjs";
import { calibrationLabelPublicKeyIdentity } from "./calibration-label-source-envelope-lib.mjs";

const SHA1 = /^[0-9a-f]{40}$/;

export const PILOT_CARRIER_FILE = "pilot-carrier.txt";
export const PILOT_SET_FILE = "pilot-set.json";
export const PILOT_UNIVERSE_FILE = "universe-provenance.json";
export const PILOT_PUBLIC_KEY_FILE = "label-sealing-public-key.pem";
export const PILOT_FRAME_FILE = "frame-tasks.json";
export const PILOT_TASKS_DIR = "tasks";
export const PILOT_AUTHORIZATION_FILE = "pilot-labeling-authorization.json";
export const PILOT_RESOLVED_LABELS_FILE = "resolved-labels.json";
export const PILOT_SIZING_FILE = "pilot-sizing.json";

function require_(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    // ls-tree, not a failed `git show`: `show` exits non-zero for a missing
    // path AND for a broken object, an unreadable repository, or a bad
    // revision, so treating its failure as absence would let the one check
    // that makes this ceremony decidable pass for reasons that have nothing
    // to do with the tree. ls-tree succeeds either way and answers with
    // bytes: empty output means the path is genuinely absent.
    const listed = git(rootDir, ["ls-tree", "--name-only", carrier, "--", repoPath(name)]);
    require_(
      listed.trim() === "",
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
  let pinnedMinimumPerClass = null;
  const workRoot = mkdtempSync(pathJoin(tmpdir(), "pilot-carrier-"));
  try {
    const treeRoot = pathJoin(workRoot, "tree");
    mkdirSync(treeRoot, { recursive: true });
    const archive = spawnSync("git", ["-C", rootDir, "archive", carrier], {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024
    });
    // Forward the diagnostics. This is structurally the first step that reads
    // the bulk of the tree, so it is where a corrupt object, an absent tar, or
    // an exhausted buffer surfaces; and the runbook's remedy for a red gate is
    // to RETIRE the carrier and discard the reviewers' sealed envelopes. An
    // environment failure must not arrive wearing that accusation with no
    // evidence attached. (The file argues this exact point about `git show`
    // twenty lines above, and then discarded it here.)
    require_(
      archive.status === 0,
      `git archive ${carrier} failed${archive.error?.code ? ` (${archive.error.code})` : ""}${
        (archive.stderr ?? "").toString().trim() ? `: ${(archive.stderr ?? "").toString().trim()}` : ""
      }. This is a failure to READ the repository, not a finding about the carrier; fix the environment and re-run before concluding anything about ${carrier}.`
    );
    const extract = spawnSync("tar", ["-x", "-C", treeRoot], { input: archive.stdout });
    require_(
      extract.status === 0,
      `extracting the carrier tree failed${extract.error?.code ? ` (${extract.error.code})` : ""}${
        (extract.stderr ?? "").toString().trim() ? `: ${(extract.stderr ?? "").toString().trim()}` : ""
      }. This is an environment failure, not a finding about the carrier.`
    );
    const artifactBytes = readFileSync(pathJoin(treeRoot, CALIBRATION_CENSORING_POLICY_PATH), "utf8");
    const artifact = JSON.parse(artifactBytes);
    // The claimed-class floor is PINNED by the carrier's approved artifact.
    // The chain below needs it, and must not take it from the artifact it is
    // checking: a sizing artifact that restated a floor of 5 would re-derive
    // consistently with 5 and pass its own audit.
    pinnedMinimumPerClass =
      artifact.publicationProfiles?.[artifact.detectors?.[frameTasks.detector]?.publicationProfile]
        ?.minimumPerClaimedClass ?? null;
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
  // 7. THE COMMITTED EVIDENCE CHAIN, when it exists. The close, reveal, and
  //    sizing artifacts each say their anchor is the repository commit "via
  //    PR and CI", and until now no CI step read any of them. Each is bound to
  //    the bytes of the step before it, so the chain is checkable from the
  //    committed tree alone: frame -> authorization -> resolved labels ->
  //    sizing. Absent artifacts are simply steps not yet taken.
  const chain = { authorization: null, resolvedLabels: null, sizing: null };
  const frameDigest = sha256Hex(frameBytes);
  const authorizationPath = path.join(rootDir, studyDir, PILOT_AUTHORIZATION_FILE);
  if (existsSync(authorizationPath)) {
    const bytes = readFileSync(authorizationPath, "utf8");
    const authorization = validateV4PilotLabelingAuthorization(JSON.parse(bytes));
    require_(
      authorization.frameTasksSha256 === frameDigest,
      `${PILOT_AUTHORIZATION_FILE} binds frame ${authorization.frameTasksSha256}, not the committed frame ${frameDigest}`
    );
    require_(
      authorization.candidateCommit === carrier &&
        authorization.studyId === frameTasks.studyId &&
        authorization.detector === frameTasks.detector &&
        authorization.referenceProtocolId === frameTasks.referenceProtocolId,
      `${PILOT_AUTHORIZATION_FILE} identity does not match the committed frame`
    );
    // The carrier certifies label-sealing-public-key.pem as unchanged since K,
    // and the authorization declares a keyId, and nothing compared the two. A
    // replacement key handed out after the freeze would have satisfied every
    // other check in this chain.
    require_(
      authorization.labelSealingKey.keyId ===
        calibrationLabelPublicKeyIdentity(inputs[PILOT_PUBLIC_KEY_FILE]).keyId,
      `${PILOT_AUTHORIZATION_FILE} was closed under a key that is not the committed ${PILOT_PUBLIC_KEY_FILE}`
    );
    chain.authorization = { sha256: sha256Hex(bytes), commitmentSetSha256: authorization.commitmentSetSha256 };
  }
  const resolvedPath = path.join(rootDir, studyDir, PILOT_RESOLVED_LABELS_FILE);
  if (existsSync(resolvedPath)) {
    require_(
      chain.authorization !== null,
      `${PILOT_RESOLVED_LABELS_FILE} is committed without the ${PILOT_AUTHORIZATION_FILE} it must have been revealed under`
    );
    const bytes = readFileSync(resolvedPath, "utf8");
    const resolved = validateV4ResolvedLabelsArtifact(JSON.parse(bytes));
    require_(
      resolved.frameTasksSha256 === frameDigest,
      `${PILOT_RESOLVED_LABELS_FILE} binds a different frame than the committed one`
    );
    require_(
      resolved.commitmentSetSha256 === chain.authorization.commitmentSetSha256,
      `${PILOT_RESOLVED_LABELS_FILE} was revealed from a different commitment set than the authorization froze`
    );
    require_(
      resolved.candidateCommit === carrier &&
        resolved.studyId === frameTasks.studyId &&
        resolved.detector === frameTasks.detector &&
        resolved.referenceProtocolId === frameTasks.referenceProtocolId,
      `${PILOT_RESOLVED_LABELS_FILE} identity does not match the committed frame`
    );
    // The CASE SET, in frame order, not its size: counting agrees for any
    // hundred cases, including a hundred the frame never named.
    require_(
      JSON.stringify(resolved.cases.map((entry) => entry.caseId)) ===
        JSON.stringify(frameTasks.cases.map((frameCase) => frameCase.caseId)),
      `${PILOT_RESOLVED_LABELS_FILE} does not resolve exactly the frame's cases, in the frame's order`
    );
    chain.resolvedLabels = { sha256: sha256Hex(bytes), cases: resolved.cases };
  }
  const sizingPath = path.join(rootDir, studyDir, PILOT_SIZING_FILE);
  if (existsSync(sizingPath)) {
    require_(
      chain.resolvedLabels !== null,
      `${PILOT_SIZING_FILE} is committed without the ${PILOT_RESOLVED_LABELS_FILE} it must have counted`
    );
    const sizing = JSON.parse(readFileSync(sizingPath, "utf8"));
    require_(
      isRecord(sizing) &&
        sizing.artifactKind === V4_PILOT_SIZING_KIND &&
        sizing.schemaVersion === V4_PILOT_SIZING_SCHEMA_VERSION,
      `${PILOT_SIZING_FILE} is not a v${V4_PILOT_SIZING_SCHEMA_VERSION} ${V4_PILOT_SIZING_KIND}`
    );
    require_(
      sizing.frameTasksSha256 === frameDigest,
      `${PILOT_SIZING_FILE} binds a different frame than the committed one`
    );
    require_(
      sizing.candidateCommit === carrier &&
        sizing.studyId === frameTasks.studyId &&
        sizing.detector === frameTasks.detector &&
        sizing.referenceProtocolId === frameTasks.referenceProtocolId,
      `${PILOT_SIZING_FILE} identity does not match the committed frame`
    );
    require_(
      sizing.resolvedLabelsSha256 === chain.resolvedLabels.sha256,
      `${PILOT_SIZING_FILE} counted resolved labels other than the committed ones`
    );
    // The artifact is RE-DERIVED, not read. Binding the resolved-labels digest
    // proves WHICH file was counted, never that it was counted correctly, and
    // an artifact that restated its own derivedN, class floor, or feasibility
    // verdict could declare an infeasible pilot feasible with every digest in
    // the chain intact. The producer is deterministic given the labels, the
    // frame, and the pool the artifact itself declares, so equality is byte
    // equality, exactly as the frame is re-derived from its carrier.
    require_(
      Number.isSafeInteger(sizing.feasibility?.sweptEligiblePool),
      `${PILOT_SIZING_FILE} records no swept eligible pool, so its feasibility cannot be re-derived`
    );
    require_(
      Number.isSafeInteger(pinnedMinimumPerClass) && pinnedMinimumPerClass >= 1,
      `the carrier's approved artifact pins no claimed-class minimum for ${frameTasks.detector}`
    );
    require_(
      sizing.minimumPerClass === pinnedMinimumPerClass,
      `${PILOT_SIZING_FILE} was sized to a claimed-class floor of ${sizing.minimumPerClass}, and the approved artifact pins ${pinnedMinimumPerClass}`
    );
    const rederivedSizing = computeV4PilotSizingArtifact({
      resolvedLabelsBytes: readFileSync(resolvedPath, "utf8"),
      frameTasksBytes: frameBytes,
      minimumPerClass: pinnedMinimumPerClass,
      sweptEligiblePool: sizing.feasibility.sweptEligiblePool
    });
    require_(
      rederivedSizing.text === readFileSync(sizingPath, "utf8"),
      `${PILOT_SIZING_FILE} is not what its own resolved labels and frame produce; its counts, derived N, or feasibility verdict were not computed from the evidence it names. Sizing is a pure derivation over committed evidence and nothing is sealed to it: re-run the sizing step and commit what it produces. This is never grounds for retiring a carrier.`
    );
    chain.sizing = { feasible: sizing.feasibility.feasible, counts: sizing.counts };
  }

  return {
    carrier,
    studyId: frameTasks.studyId,
    detector: frameTasks.detector,
    cases: frameTasks.cases.length,
    chain,
    frameTasksSha256: sha256Hex(frameBytes)
  };
}
