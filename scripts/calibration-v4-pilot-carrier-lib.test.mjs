import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildV4FrameTasksArtifact } from "./calibration-v4-ceremony-lib.mjs";
import { verifyPilotCarrier } from "./calibration-v4-pilot-carrier-lib.mjs";
import { CALIBRATION_CENSORING_POLICY_PATH, canonicalPrettyJson } from "./calibration-study-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUDY_DIR = "calibration/fixture-prevalence-pilot";
const STUDY_ID = "fixture-prevalence-pilot";
const DETECTOR = "cname-uncloaking";
const sha = (value) => createHash("sha256").update(value).digest("hex");

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function write(root, repoPath, bytes) {
  const full = path.join(root, repoPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, bytes);
}

/**
 * A throwaway repository carrying the real approved policy artifact and the
 * real protocol bytes, laid out as the ceremony lays them out: an INPUT
 * carrier commit K, then a frame-freeze commit built from K's own bytes.
 */
function carrierWorld({ cases = 3, provenanceDigest = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "pilot-carrier-"));
  git(root, ["init", "--initial-branch", "main"]);
  git(root, ["config", "user.email", "fixture@example.com"]);
  git(root, ["config", "user.name", "fixture"]);
  const artifactBytes = readFileSync(path.join(repoRoot, CALIBRATION_CENSORING_POLICY_PATH), "utf8");
  const artifact = JSON.parse(artifactBytes);
  const protocolBytes = readFileSync(path.join(repoRoot, artifact.referenceProtocol.path), "utf8");
  write(root, CALIBRATION_CENSORING_POLICY_PATH, artifactBytes);
  write(root, artifact.referenceProtocol.path, protocolBytes);
  // The carrier carries the producer that built the frame, the approval the
  // producer requires, and the inputs: exactly what a real carrier commit
  // holds, because the check re-derives by running the carrier's OWN CLI.
  write(root, "RELEASE_READINESS.json", readFileSync(path.join(repoRoot, "RELEASE_READINESS.json"), "utf8"));
  cpSync(path.join(repoRoot, "scripts"), path.join(root, "scripts"), { recursive: true });
  const candidates = Array.from({ length: cases }, (_, index) => ({
    caseId: `case-${index}.example`,
    url: `https://case-${index}.example/`
  }));
  const pilotSet = canonicalPrettyJson({ studyId: STUDY_ID, candidates });
  write(root, `${STUDY_DIR}/pilot-set.json`, pilotSet);
  write(
    root,
    `${STUDY_DIR}/universe-provenance.json`,
    canonicalPrettyJson({
      studyId: STUDY_ID,
      pilotSetSha256: provenanceDigest ?? sha(pilotSet),
      source: "fixture"
    })
  );
  write(root, `${STUDY_DIR}/label-sealing-public-key.pem`, "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "input carrier"]);
  const carrier = git(root, ["rev-parse", "HEAD"]);
  const built = buildV4FrameTasksArtifact({
    studyId: STUDY_ID,
    detector: DETECTOR,
    candidateCommit: carrier,
    referenceProtocolId: artifact.referenceProtocol.id,
    referenceProtocolSha256: artifact.referenceProtocol.sha256,
    externalDefinitions: artifact.detectors[DETECTOR].externalDefinitions,
    cases: candidates
  });
  write(root, `${STUDY_DIR}/frame-tasks.json`, built.frameTasksBytes);
  for (const [caseId, bytes] of built.taskBytesByCaseId) {
    write(root, `${STUDY_DIR}/tasks/${caseId}.json`, bytes);
  }
  write(root, `${STUDY_DIR}/pilot-carrier.txt`, `${carrier}\n`);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "frame freeze"]);
  git(root, ["branch", "upstream"]);
  return { root, carrier, artifact, candidates, built };
}

const verify = (world, overrides = {}) =>
  verifyPilotCarrier({
    rootDir: world.root,
    studyDir: STUDY_DIR,
    upstreamRef: "upstream",
    ...overrides
  });

test("the carrier check re-derives the frame from the carrier's own bytes", () => {
  const world = carrierWorld();
  const result = verify(world);
  assert.equal(result.carrier, world.carrier);
  assert.equal(result.cases, 3);
  assert.equal(result.studyId, STUDY_ID);
});

test("the carrier check refuses every way a frame can fail to derive from its carrier", () => {
  // 1. The carrier file is one sha and nothing else.
  {
    const world = carrierWorld();
    write(world.root, `${STUDY_DIR}/pilot-carrier.txt`, `${world.carrier}\nnote: rebuilt by hand\n`);
    assert.throws(() => verify(world), /exactly one 40-hex commit sha/);
  }
  // 2. A carrier that is not an ancestor of what is being checked.
  {
    const world = carrierWorld();
    write(world.root, `${STUDY_DIR}/pilot-carrier.txt`, `${"a".repeat(40)}\n`);
    assert.throws(() => verify(world), /does not exist in this repository/);
  }
  // 3. A carrier that never landed upstream: under rebase-merge the sha a
  //    branch shows is not the sha that lands, and reviewers can only fetch
  //    what landed.
  {
    const world = carrierWorld();
    // An upstream that does not contain the carrier at all: the local branch
    // built a frame on a commit nobody else can fetch.
    const emptyTree = git(world.root, ["hash-object", "-t", "tree", "/dev/null"]);
    const orphan = git(world.root, ["commit-tree", emptyTree, "-m", "unrelated upstream"]);
    git(world.root, ["update-ref", "refs/heads/upstream", orphan]);
    assert.throws(() => verify(world), /has not landed on upstream/);
  }
  // 4. A frame bound to a different commit than the carrier file names.
  {
    const world = carrierWorld();
    const rebuilt = buildV4FrameTasksArtifact({
      studyId: STUDY_ID,
      detector: DETECTOR,
      candidateCommit: "b".repeat(40),
      referenceProtocolId: world.artifact.referenceProtocol.id,
      referenceProtocolSha256: world.artifact.referenceProtocol.sha256,
      externalDefinitions: world.artifact.detectors[DETECTOR].externalDefinitions,
      cases: world.candidates
    });
    write(world.root, `${STUDY_DIR}/frame-tasks.json`, rebuilt.frameTasksBytes);
    assert.throws(() => verify(world), /is not the carrier/);
  }
  // 5. An input edited after the carrier: the frame would bind bytes that no
  //    longer exist.
  {
    const world = carrierWorld();
    const edited = canonicalPrettyJson({
      studyId: STUDY_ID,
      candidates: [...world.candidates, { caseId: "late.example", url: "https://late.example/" }]
    });
    write(world.root, `${STUDY_DIR}/pilot-set.json`, edited);
    assert.throws(() => verify(world), /changed after the carrier commit/);
  }
  // 6. ANTI-CIRCULARITY: naming a commit that already carries a frame as the
  //    INPUT carrier. This is the realistic version of the circular
  //    definition: a second pilot round pointed at the previous round's
  //    freeze commit, which every other check would happily accept because
  //    the new frame does bind it and its inputs are unchanged.
  {
    const world = carrierWorld();
    const freeze = git(world.root, ["rev-parse", "HEAD"]);
    const rebuilt = buildV4FrameTasksArtifact({
      studyId: STUDY_ID,
      detector: DETECTOR,
      candidateCommit: freeze,
      referenceProtocolId: world.artifact.referenceProtocol.id,
      referenceProtocolSha256: world.artifact.referenceProtocol.sha256,
      externalDefinitions: world.artifact.detectors[DETECTOR].externalDefinitions,
      cases: world.candidates
    });
    write(world.root, `${STUDY_DIR}/frame-tasks.json`, rebuilt.frameTasksBytes);
    for (const [caseId, bytes] of rebuilt.taskBytesByCaseId) {
      write(world.root, `${STUDY_DIR}/tasks/${caseId}.json`, bytes);
    }
    write(world.root, `${STUDY_DIR}/pilot-carrier.txt`, `${freeze}\n`);
    git(world.root, ["add", "-A"]);
    git(world.root, ["commit", "-q", "-m", "second round pointed at the first round's freeze"]);
    git(world.root, ["branch", "-f", "upstream", "HEAD"]);
    assert.throws(() => verify(world), /cannot contain it/);
  }
  // 7. RE-DERIVATION: a frame or task edited after the build, however
  //    plausibly, is not what the carrier's inputs produce.
  {
    const world = carrierWorld();
    const framePath = path.join(world.root, STUDY_DIR, "frame-tasks.json");
    const frame = JSON.parse(readFileSync(framePath, "utf8"));
    frame.cases.reverse();
    writeFileSync(framePath, canonicalPrettyJson(frame));
    assert.throws(() => verify(world), /built from a different tree/);
  }
  {
    const world = carrierWorld();
    const taskPath = path.join(world.root, STUDY_DIR, "tasks", "case-1.example.json");
    const task = JSON.parse(readFileSync(taskPath, "utf8"));
    task.subjectUrl = "https://case-1.example/other";
    writeFileSync(taskPath, canonicalPrettyJson(task));
    assert.throws(() => verify(world), /case-1.example task is not what the carrier/);
  }
  // 8. A task file beside the frame that the frame does not name.
  {
    const world = carrierWorld();
    write(world.root, `${STUDY_DIR}/tasks/case-9.example.json`, "{}\n");
    assert.throws(() => verify(world), /does not match the frame's cases/);
  }
  // 9. The provenance must BIND the carrier's pilot set. The wrong digest is
  //    committed AT the carrier here, so the unchanged-since check passes and
  //    only the binding check can catch it.
  {
    const world = carrierWorld({ provenanceDigest: sha("some other candidate set") });
    assert.throws(() => verify(world), /does not bind the carrier's pilot set/);
  }
  // ...and an input edited after the carrier is still caught separately.
  {
    const world = carrierWorld();
    write(
      world.root,
      `${STUDY_DIR}/universe-provenance.json`,
      canonicalPrettyJson({ studyId: STUDY_ID, pilotSetSha256: sha("elsewhere"), source: "fixture" })
    );
    assert.throws(() => verify(world), /changed after the carrier commit/);
  }
});

test("the carrier check runs by EXECUTION and prints what it proved", () => {
  const world = carrierWorld({ cases: 2 });
  // The CLI resolves paths from the REPOSITORY it lives in, so drive the lib
  // through a spawned node that points it at the fixture repo.
  const script = path.join(world.root, "run-check.mjs");
  writeFileSync(
    script,
    `import { verifyPilotCarrier } from ${JSON.stringify(path.join(repoRoot, "scripts", "calibration-v4-pilot-carrier-lib.mjs"))};\n` +
      `const result = verifyPilotCarrier({ rootDir: ${JSON.stringify(world.root)}, studyDir: ${JSON.stringify(STUDY_DIR)}, upstreamRef: "upstream" });\n` +
      "console.log(`carrier ${result.carrier} ${result.cases} cases`);\n"
  );
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`carrier ${world.carrier} 2 cases`));
  rmSync(world.root, { recursive: true, force: true });
});

test("the repository gate is keyed on the frame, so deleting the carrier file fails rather than skips", () => {
  const world = carrierWorld({ cases: 2 });
  // The gate resolves its repository from its own location, so run the copy
  // that lives in the fixture tree: it then sees the fixture as the repo.
  const runGate = () =>
    spawnSync(process.execPath, [path.join(world.root, "scripts", "calibration-pilot-carrier-gate.mjs")], {
      encoding: "utf8",
      env: { ...process.env, CALIBRATION_PILOT_UPSTREAM_REF: "upstream" }
    });
  const clean = runGate();
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /pilot carrier ok - calibration\/fixture-prevalence-pilot: 2 cases/);

  // Deleting the carrier file must FAIL: a gate keyed on that file would let
  // one deletion disable the only check that can catch a wrong carrier.
  rmSync(path.join(world.root, STUDY_DIR, "pilot-carrier.txt"));
  const orphaned = runGate();
  assert.notEqual(orphaned.status, 0);
  assert.match(orphaned.stderr, /holds a committed frame with no pilot-carrier.txt/);

  // A tampered frame fails the gate through the same re-derivation.
  write(world.root, `${STUDY_DIR}/pilot-carrier.txt`, `${world.carrier}\n`);
  const framePath = path.join(world.root, STUDY_DIR, "frame-tasks.json");
  const frame = JSON.parse(readFileSync(framePath, "utf8"));
  frame.cases.reverse();
  writeFileSync(framePath, canonicalPrettyJson(frame));
  const tampered = runGate();
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /::error::pilot carrier gate/);
  rmSync(world.root, { recursive: true, force: true });
});

test("the gate passes trivially when no pilot frame is committed", () => {
  const world = carrierWorld({ cases: 2 });
  rmSync(path.join(world.root, STUDY_DIR), { recursive: true, force: true });
  const run = spawnSync(
    process.execPath,
    [path.join(world.root, "scripts", "calibration-pilot-carrier-gate.mjs")],
    { encoding: "utf8", env: { ...process.env, CALIBRATION_PILOT_UPSTREAM_REF: "upstream" } }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no committed pilot frames/);
  rmSync(world.root, { recursive: true, force: true });
});
