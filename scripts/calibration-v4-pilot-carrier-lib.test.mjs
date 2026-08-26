import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildV4FrameTasksArtifact,
  buildV4PilotLabelingAuthorization,
  buildV4ResolvedLabelsArtifact,
  computeV4PilotSizingArtifact,
  sealV4LabelBatch
} from "./calibration-v4-ceremony-lib.mjs";
import { verifyPilotCarrier } from "./calibration-v4-pilot-carrier-lib.mjs";
import {
  CALIBRATION_CENSORING_POLICY_PATH,
  calibrationLabelCommitmentEnvelopeDigest,
  canonicalPrettyJson
} from "./calibration-study-lib.mjs";
import {
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  calibrationLabelPublicKeyIdentity
} from "./calibration-label-source-envelope-lib.mjs";
import {
  V4_LABEL_BATCH_KIND,
  V4_LABEL_BATCH_SCHEMA_VERSION,
  padV4LabelBatch
} from "./calibration-v4-labels-lib.mjs";

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
  // A REAL sealing public key: the chain binds the authorization's keyId to
  // this file's identity, so a placeholder would only prove the checker
  // tolerates placeholders.
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  write(root, `${STUDY_DIR}/label-sealing-public-key.pem`, publicKeyPem);
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
  return { root, carrier, artifact, candidates, built, publicKeyPem };
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
  // A frame with no chain artifacts says so, rather than reading like a
  // checked chain.
  assert.match(clean.stdout, /no chain artifacts committed yet/);

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

test("the sealing PUBLIC key can be committed and the private half cannot", () => {
  // Found by rehearsing the ceremony: `*.pem` is ignored, so the operator's
  // step-1 `git add -A` skipped the sealing public key without a word and the
  // carrier landed without the file every reviewer seals to.
  //
  // The committed .gitignore BYTES are exercised in a throwaway repository
  // rather than against this checkout, because this suite also runs where the
  // checkout is not a git work tree at all: the container build stage copies
  // the tree without .git (.dockerignore excludes it) and runs `npm run
  // check` there. Asking git about a non-repository fails for a reason that
  // has nothing to do with ignore rules, and reading that as "not ignored"
  // would have made this test answer a question it was not asked.
  const root = mkdtempSync(path.join(tmpdir(), "pilot-gitignore-"));
  try {
    git(root, ["init", "--initial-branch", "main"]);
    writeFileSync(
      path.join(root, ".gitignore"),
      readFileSync(path.join(repoRoot, ".gitignore"), "utf8")
    );
    const ignored = (repoPath) =>
      spawnSync("git", ["-C", root, "check-ignore", "-q", repoPath], { encoding: "utf8" }).status === 0;
    const study = "calibration/cname-uncloaking-2026-08-prevalence-pilot";
    assert.equal(
      ignored(`${study}/label-sealing-public-key.pem`),
      false,
      "the sealing public key must be committable"
    );
    assert.equal(
      ignored(`${study}/pilot-label-reveal-private.pem`),
      true,
      "a private key in the study directory must stay ignored"
    );
    assert.equal(
      ignored(`${study}/anything-else.pem`),
      true,
      "the exception must name one file, not admit pem files generally"
    );
    // The exception is scoped to calibration/: a public key elsewhere is not
    // admitted by it.
    assert.equal(ignored("label-sealing-public-key.pem"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the committed evidence chain is verified, and each link must name the one before it", () => {
  // The close, reveal, and sizing artifacts each say the repository commit is
  // their anchor. Until this, no CI step read any of them. Each binds the
  // bytes of the step before it, so the chain is decidable from the committed
  // tree: frame -> authorization -> resolved labels -> sizing.
  // 100 cases: the sizing producer enforces the preregistered pilot minimum,
  // so a smaller fixture could never reach the chain's last link.
  const world = carrierWorld({ cases: 100 });
  const frameBytes = readFileSync(path.join(world.root, STUDY_DIR, "frame-tasks.json"), "utf8");
  const frameDigest = sha(frameBytes);
  // The authorization is built by the REAL producer from REAL sealed
  // commitments. Hand-shaping one here would restate a contract this suite
  // exists to check, and would agree with whatever the checker happens to
  // require rather than with what the ceremony produces.
  // The ceremony's committed key IS the sealing key; the chain now checks that.
  const publicKeyPem = world.publicKeyPem;
  const sealingKeyId = calibrationLabelPublicKeyIdentity(publicKeyPem).keyId;
  const frameTasks = JSON.parse(frameBytes);
  const taskBytesByCaseId = new Map(
    world.candidates.map((entry) => [
      entry.caseId,
      readFileSync(path.join(world.root, STUDY_DIR, "tasks", `${entry.caseId}.json`), "utf8")
    ])
  );
  const madeFor = (role, actor, keyPem = publicKeyPem, keyIdFor = sealingKeyId) => {
    const batch = padV4LabelBatch(
      {
        schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
        artifactKind: V4_LABEL_BATCH_KIND,
        role,
        studyId: frameTasks.studyId,
        detector: frameTasks.detector,
        candidateCommit: frameTasks.candidateCommit,
        referenceProtocolId: frameTasks.referenceProtocolId,
        frameTasksSha256: sha(frameBytes),
        // A realistic mix rather than one value everywhere: 25 present, so
        // the sizing link reaches a real derivation instead of the
        // all-absent boundary.
        cases: world.candidates.map((entry, index) => ({
          caseId: entry.caseId,
          value: index < 25 ? "present" : "absent",
          evidence: { sha256: sha(`capture:${actor}:${entry.caseId}`), provenance: `fixture@${actor}` }
        }))
      },
      frameTasks
    );
    const sealed = sealV4LabelBatch({
      batchBytes: canonicalPrettyJson(batch),
      frameTasks,
      taskBytesByCaseId,
      role,
      reviewerLogin: actor,
      publicKeyPem: keyPem,
      keyId: keyIdFor
    });
    return {
      batch,
      record: {
      metadata: {
        actor,
        artifactCreatedAt: "2026-08-24T00:00:00.000Z",
        runId: 7000 + actor.length,
        runAttempt: 1,
        headSha: "e".repeat(40),
        artifactId: 8000 + actor.length,
        artifactName: `site-behavior-calibration-label-commitment-${role}-${frameTasks.studyId}-1-1`,
        archiveSha256: sha(`archive:${actor}`)
      },
      commitment: {
        role,
        source: { commit: "f".repeat(40), path: `calibration-labels/${frameTasks.studyId}/sources.json`, actor },
        keyId: keyIdFor,
        envelopeSha256: calibrationLabelCommitmentEnvelopeDigest(sealed.envelope),
        envelope: sealed.envelope
      }
      }
    };
  };
  const made = {
    alice: madeFor("labeler", "alice"),
    bob: madeFor("labeler", "bob"),
    carol: madeFor("tiebreaker", "carol")
  };
  const commitmentFor = (role, actor) => made[actor].record;
  const built = buildV4PilotLabelingAuthorization({
    studyId: frameTasks.studyId,
    detector: frameTasks.detector,
    candidateCommit: world.carrier,
    referenceProtocolId: frameTasks.referenceProtocolId,
    keyId: sealingKeyId,
    frameTasksSha256: sha(frameBytes),
    labelingClosedAt: "2026-08-25T00:00:00.000Z",
    commitments: [commitmentFor("labeler", "alice"), commitmentFor("labeler", "bob"), commitmentFor("tiebreaker", "carol")]
  });
  const authorization = built.authorization;
  const commitmentSetSha256 = authorization.commitmentSetSha256;
  const writeChain = (over = {}) => {
    const auth = { ...authorization, ...(over.authorization ?? {}) };
    write(world.root, `${STUDY_DIR}/pilot-labeling-authorization.json`, canonicalPrettyJson(auth));
    return auth;
  };
  // An authorization that names a different frame cannot pass.
  writeChain({ authorization: { frameTasksSha256: sha("another frame") } });
  assert.throws(() => verify(world), /binds frame/);
  // ...nor one that names a different carrier.
  writeChain({ authorization: { candidateCommit: "c".repeat(40) } });
  assert.throws(() => verify(world), /identity does not match the committed frame/);
  // A well-formed authorization for this frame passes and is reported.
  writeChain();
  const withAuth = verify(world);
  assert.equal(withAuth.chain.authorization.commitmentSetSha256, commitmentSetSha256);
  assert.equal(withAuth.chain.resolvedLabels, null);
  // An authorization closed under a key that is not the committed one: the
  // carrier certifies the pem as unchanged, and nothing compared the two, so
  // a key handed out after the freeze satisfied every other link.
  // Everything internally consistent, and sealed under a key the ceremony
  // never committed: the authorization validator cannot see it, because the
  // artifact agrees with itself.
  const strangerKey = generateKeyPairSync("rsa", { modulusLength: 3072 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const strangerKeyId = calibrationLabelPublicKeyIdentity(strangerKey).keyId;
  const strangerAuth = buildV4PilotLabelingAuthorization({
    studyId: frameTasks.studyId,
    detector: frameTasks.detector,
    candidateCommit: world.carrier,
    referenceProtocolId: frameTasks.referenceProtocolId,
    keyId: strangerKeyId,
    frameTasksSha256: sha(frameBytes),
    labelingClosedAt: "2026-08-25T00:00:00.000Z",
    commitments: [
      madeFor("labeler", "alice", strangerKey, strangerKeyId).record,
      madeFor("labeler", "bob", strangerKey, strangerKeyId).record,
      madeFor("tiebreaker", "carol", strangerKey, strangerKeyId).record
    ]
  });
  write(world.root, `${STUDY_DIR}/pilot-labeling-authorization.json`, strangerAuth.text);
  assert.throws(() => verify(world), /closed under a key that is not the committed/);
  writeChain();

  // Resolved labels and sizing are built by their REAL producers, from the
  // real bridge and the real counting path. The first draft of this test
  // hand-shaped both, and four of the chain's guards survived deletion
  // because a hand-shaped fixture agrees with whatever the checker happens
  // to require.
  const labelerBatches = ["alice", "bob"].map((actor) => ({
    labelerId: `github-${actor}`,
    batch: made[actor].batch
  }));
  const tiebreakerBatch = { labelerId: "github-carol", batch: made.carol.batch };
  const resolvedBuilt = buildV4ResolvedLabelsArtifact({
    frameTasks,
    labelerBatches,
    tiebreakerBatch,
    commitmentSetSha256
  });
  const resolved = resolvedBuilt.artifact;
  write(world.root, `${STUDY_DIR}/resolved-labels.json`, resolvedBuilt.text);
  const withLabels = verify(world);
  assert.equal(withLabels.chain.resolvedLabels.sha256, sha(resolvedBuilt.text));

  // Labels for cases the frame never named: the same COUNT, a different set.
  const renamed = {
    ...resolved,
    cases: resolved.cases.map((entry, index) =>
      index === 0 ? { ...entry, caseId: "not-in-frame.example" } : entry
    )
  };
  write(world.root, `${STUDY_DIR}/resolved-labels.json`, canonicalPrettyJson(renamed));
  assert.throws(() => verify(world), /does not resolve exactly the frame's cases/);
  // Labels whose identity belongs to another study or carrier.
  write(
    world.root,
    `${STUDY_DIR}/resolved-labels.json`,
    canonicalPrettyJson({ ...resolved, candidateCommit: "c".repeat(40) })
  );
  assert.throws(() => verify(world), new RegExp("resolved-labels.json identity does not match"));
  // ...and revealed from a commitment set the authorization never froze.
  write(
    world.root,
    `${STUDY_DIR}/resolved-labels.json`,
    canonicalPrettyJson({ ...resolved, commitmentSetSha256: sha("other set") })
  );
  assert.throws(() => verify(world), /revealed from a different commitment set/);
  write(world.root, `${STUDY_DIR}/resolved-labels.json`, resolvedBuilt.text);

  // Sizing comes from the REAL producer over those exact labels.
  const sizingBuilt = computeV4PilotSizingArtifact({
    resolvedLabelsBytes: resolvedBuilt.text,
    frameTasksBytes: frameBytes,
    minimumPerClass: 100,
    sweptEligiblePool: 1126
  });
  write(world.root, `${STUDY_DIR}/pilot-sizing.json`, sizingBuilt.text);
  const sized = verify(world);
  assert.deepEqual(sized.chain.sizing.counts, sizingBuilt.artifact.counts);

  // The arithmetic is NOT re-derived here, by design: pinning a frozen
  // artifact to HEAD's producer, schema constant, and approved floor would
  // red a required check against evidence nobody may rewrite. Re-running the
  // sizing step is how its arithmetic is checked. What this gate checks is
  // binding, which does not move.
  const restatedFloor = computeV4PilotSizingArtifact({
    resolvedLabelsBytes: resolvedBuilt.text,
    frameTasksBytes: frameBytes,
    minimumPerClass: 5,
    sweptEligiblePool: 1126
  });
  write(world.root, `${STUDY_DIR}/pilot-sizing.json`, restatedFloor.text);
  assert.equal(verify(world).chain.sizing.arithmeticVerifiedHere, false);
  write(world.root, `${STUDY_DIR}/pilot-sizing.json`, sizingBuilt.text);

  // Sizing that counted some other file, and sizing of another study.
  write(
    world.root,
    `${STUDY_DIR}/pilot-sizing.json`,
    canonicalPrettyJson({ ...sizingBuilt.artifact, resolvedLabelsSha256: sha("some other labels") })
  );
  assert.throws(() => verify(world), /counted resolved labels other than the committed ones/);
  write(
    world.root,
    `${STUDY_DIR}/pilot-sizing.json`,
    canonicalPrettyJson({ ...sizingBuilt.artifact, candidateCommit: "c".repeat(40) })
  );
  assert.throws(() => verify(world), new RegExp("pilot-sizing.json identity does not match"));
  // A schema version is a fact about the producer, not about this frozen
  // artifact, so it is deliberately NOT pinned: pinning it would red a
  // required check against evidence nobody may rewrite.
  write(
    world.root,
    `${STUDY_DIR}/pilot-sizing.json`,
    canonicalPrettyJson({ ...sizingBuilt.artifact, schemaVersion: 1 })
  );
  assert.equal(verify(world).chain.sizing.arithmeticVerifiedHere, false);
  // The KIND is still checked: a different artifact in that filename refuses.
  write(
    world.root,
    `${STUDY_DIR}/pilot-sizing.json`,
    canonicalPrettyJson({ ...sizingBuilt.artifact, artifactKind: "something-else" })
  );
  assert.throws(() => verify(world), /is not a site-behavior-detector-calibration-pilot-sizing/);
  write(world.root, `${STUDY_DIR}/pilot-sizing.json`, sizingBuilt.text);
  assert.equal(verify(world).chain.sizing.feasible, sizingBuilt.artifact.feasibility.feasible);

  // A link cannot appear without the one it must have come from.
  rmSync(path.join(world.root, STUDY_DIR, "resolved-labels.json"));
  assert.throws(() => verify(world), /without the resolved-labels.json it must have counted/);
  rmSync(world.root, { recursive: true, force: true });
});

test("an environment failure says so, instead of arriving as a carrier finding", () => {
  // The runbook's remedy for a red gate is to RETIRE the carrier and discard
  // the reviewers' sealed envelopes. A failure to READ the repository must
  // not arrive wearing that accusation with no evidence attached.
  const world = carrierWorld({ cases: 2 });
  // Corrupt one object the archive must read. Everything before the
  // re-derivation still passes: the commit resolves, the small inputs read,
  // and ls-tree on absent paths never touches a blob.
  const objects = path.join(world.root, ".git", "objects");
  const removed = [];
  for (const dir of readdirSync(objects)) {
    if (dir.length !== 2) continue;
    for (const file of readdirSync(path.join(objects, dir))) {
      removed.push(path.join(objects, dir, file));
    }
  }
  assert.ok(removed.length > 0);
  rmSync(removed[removed.length - 1]);
  let threw = null;
  try {
    verify(world);
  } catch (error) {
    threw = error.message;
  }
  assert.notEqual(threw, null);
  assert.match(threw, /failure to READ the repository, not a finding about the carrier|environment failure, not a finding about the carrier/);
  // The diagnostics git actually produced are forwarded, not swallowed.
  assert.match(threw, /invalid object|cannot read|not a valid object|unable to read/i);
  rmSync(world.root, { recursive: true, force: true });
});
