import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";
import { canonicalPrettyJson, sha256Hex } from "./calibration-study-lib.mjs";
import { calibrationLabelPublicKeyIdentity } from "./calibration-label-source-envelope-lib.mjs";
import { V4_LABEL_BATCH_KIND, V4_LABEL_BATCH_SCHEMA_VERSION, padV4LabelBatch } from "./calibration-v4-labels-lib.mjs";
import { buildCalibrationPolicyAssignmentsArtifact } from "./calibration-policy-artifact-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");
const STUDY = "cname-uncloaking-ceremony-test-prevalence-pilot";
const DETECTOR = "cname-uncloaking";
const CARRIER = "a1".repeat(20);
const REPOSITORY = "iAnonymous3000/site-behavior-lab";
const V4_WORKFLOW = ".github/workflows/calibration-v4-pilot-commitment.yml";
const CASES = 100;
const sha = (value) => createHash("sha256").update(value).digest("hex");

/**
 * A real stored-entry ZIP, built here rather than shelled out to `zip`, so the
 * ceremony test has no tool dependency and the repository's own archive parser
 * is what decides whether the bytes are a valid artifact.
 */
function makeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBytes, eocd]);
}

/**
 * A governed world: the scripts, a dist symlink, the approved policy artifact
 * and an approved readiness manifest. The ceremony runs entirely inside it.
 */
function ceremonyWorld() {
  const root = mkdtempSync(path.join(tmpdir(), "v4-ceremony-"));
  const scriptsDir = path.join(root, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  for (const file of readdirSync(moduleDir)) {
    if (file.endsWith(".mjs") && !file.endsWith(".test.mjs")) {
      writeFileSync(path.join(scriptsDir, file), readFileSync(path.join(moduleDir, file)));
    }
  }
  symlinkSync(path.join(repoRoot, "dist"), path.join(root, "dist"));
  const protocolBytes = readFileSync(
    path.join(repoRoot, "docs", "calibration-prereg-drafts", "labeling-protocol.md"),
    "utf8"
  );
  const realArtifact = JSON.parse(
    readFileSync(path.join(repoRoot, "research", "measurement-candidate", "calibration-censoring-policy-assignments.json"), "utf8")
  );
  const produced = buildCalibrationPolicyAssignmentsArtifact({
    protocolBytes,
    trackerDefinition: realArtifact.detectors[DETECTOR].externalDefinitions.trackerDefinition,
    publicSuffixDefinition: realArtifact.detectors[DETECTOR].externalDefinitions.publicSuffixDefinition
  });
  mkdirSync(path.join(root, "research", "measurement-candidate"), { recursive: true });
  writeFileSync(
    path.join(root, "research", "measurement-candidate", "calibration-censoring-policy-assignments.json"),
    produced.text
  );
  const readiness = JSON.parse(readFileSync(path.join(repoRoot, "RELEASE_READINESS.json"), "utf8"));
  readiness.decisions.calibrationCensoringPolicy.policyArtifactSha256 = produced.policyArtifactSha256;
  readiness.decisions.calibrationCensoringPolicy.analyzerDispositionSha256 = produced.dispositionSha256;
  writeFileSync(path.join(root, "RELEASE_READINESS.json"), canonicalPrettyJson(readiness));
  const protocolPath = path.join(root, "protocol.md");
  writeFileSync(protocolPath, protocolBytes);
  return { root, scriptsDir, protocolPath };
}

const run = (world, args, env = {}) =>
  spawnSync(process.execPath, [path.join(world.scriptsDir, args[0]), ...args.slice(1)], {
    cwd: world.root,
    encoding: "utf8",
    env: { ...process.env, ...env }
  });

test("the whole pilot ceremony runs by EXECUTION, from sealed batches to a sized frame", async () => {
  const world = ceremonyWorld();
  const studyDir = path.join(world.root, "calibration", STUDY);
  mkdirSync(studyDir, { recursive: true });

  // A real ephemeral sealing keypair. Only the public half is committed.
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyId = calibrationLabelPublicKeyIdentity(publicKeyPem).keyId;
  writeFileSync(path.join(studyDir, "label-sealing-public-key.pem"), publicKeyPem);

  const inWorld = (args) => spawnSync("git", ["-C", world.root, ...args], { encoding: "utf8" });
  const caseIds = Array.from({ length: CASES }, (_, index) => `case-${String(index).padStart(3, "0")}.example`);
  const casesPath = path.join(world.root, "pilot-set.json");
  writeFileSync(
    casesPath,
    canonicalPrettyJson({ studyId: STUDY, candidates: caseIds.map((caseId) => ({ caseId, url: `https://${caseId}/` })) })
  );
  const frameBuild = run(world, [
    "calibration-v4-frame-tasks.mjs", "build",
    "--study-id", STUDY,
    "--detector", DETECTOR,
    "--candidate-commit", CARRIER,
    "--protocol-id", "independent-labeling-protocol@1",
    "--protocol-file", world.protocolPath,
    "--cases", casesPath,
    "--output-root", studyDir
  ]);
  assert.equal(frameBuild.status, 0, frameBuild.stderr);
  writeFileSync(path.join(studyDir, "pilot-carrier.txt"), `${CARRIER}\n`);
  const frameTasks = JSON.parse(readFileSync(path.join(studyDir, "frame-tasks.json"), "utf8"));
  const frameTasksSha256 = sha(`${JSON.stringify(frameTasks, null, 2)}\n`);

  // The frame freeze: a hosted run's head sha is a real commit on main, and
  // the fetch accepts producers only from the freeze forward.
  inWorld(["init", "--initial-branch", "main"]);
  inWorld(["config", "user.email", "operator@example.com"]);
  inWorld(["config", "user.name", "operator"]);
  // A commit BEFORE the frame freeze, so history can distinguish "an ancestor
  // of the branch" from "at or after the freeze". A producer older than the
  // frame cannot have read it.
  writeFileSync(path.join(world.root, "README-ceremony.md"), "before the freeze\n");
  inWorld(["add", "README-ceremony.md"]);
  inWorld(["commit", "-m", "before the freeze"]);
  const beforeFreeze = inWorld(["rev-parse", "HEAD"]).stdout.trim();
  inWorld(["add", "-A"]);
  inWorld(["commit", "-m", "frame freeze"]);
  const producerSha = inWorld(["rev-parse", "HEAD"]).stdout.trim();
  inWorld(["branch", "upstream"]);

  // THREE REAL REVIEWERS. alice and bob disagree on cases 25..29, which carol
  // tiebreaks, so the reveal exercises adjudication rather than unanimity.
  const reviewers = [
    { actor: "alice", role: "labeler", present: 25, runId: 5001, artifactId: 6001 },
    { actor: "bob", role: "labeler", present: 30, runId: 5002, artifactId: 6002 },
    { actor: "carol", role: "tiebreaker", present: 25, runId: 5003, artifactId: 6003 },
    // alice again, a second real run: used only by the duplicated-reviewer leg.
    { actor: "alice", role: "labeler", present: 25, runId: 5004, artifactId: 6004, extra: true }
  ];
  const artifacts = new Map();
  for (const reviewer of reviewers) {
    const batch = padV4LabelBatch(
      {
        schemaVersion: V4_LABEL_BATCH_SCHEMA_VERSION,
        artifactKind: V4_LABEL_BATCH_KIND,
        role: reviewer.role,
        studyId: STUDY,
        detector: DETECTOR,
        candidateCommit: CARRIER,
        referenceProtocolId: frameTasks.referenceProtocolId,
        frameTasksSha256,
        cases: frameTasks.cases.map((entry, index) => ({
          caseId: entry.caseId,
          value: index < reviewer.present ? "present" : "absent",
          evidence: { sha256: sha(`capture:${reviewer.actor}:${entry.caseId}`), provenance: `ceremony@${reviewer.actor}` }
        }))
      },
      frameTasks
    );
    const batchPath = path.join(world.root, `batch-${reviewer.extra ? `${reviewer.actor}-again` : reviewer.actor}.json`);
    writeFileSync(batchPath, canonicalPrettyJson(batch));
    const tag = reviewer.extra ? `${reviewer.actor}-again` : reviewer.actor;
    const sourceRoot = path.join(world.root, `source-${tag}`);
    mkdirSync(sourceRoot, { recursive: true });
    const inSource = (args) => spawnSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" });
    inSource(["init", "--initial-branch", "main"]);
    inSource(["config", "user.email", `${reviewer.actor}@example.com`]);
    inSource(["config", "user.name", reviewer.actor]);
    const seal = run(world, [
      "calibration-v4-seal-label-batch.mjs",
      "--role", reviewer.role,
      "--actor", reviewer.actor,
      "--public-key", path.join(studyDir, "label-sealing-public-key.pem"),
      "--frame-tasks", path.join(studyDir, "frame-tasks.json"),
      "--tasks-dir", path.join(studyDir, "tasks"),
      "--input", batchPath,
      "--output", path.join(sourceRoot, "sealed.json")
    ]);
    assert.equal(seal.status, 0, seal.stderr);
    inSource(["add", "-A"]);
    inSource(["commit", "-m", "sealed"]);
    const sourceCommit = inSource(["rev-parse", "HEAD"]).stdout.trim();

    // THE REAL HOSTED PRODUCER, under the environment the workflow provides.
    const outputDir = path.join(world.root, `commitment-${tag}`);
    const minted = run(
      world,
      [
        "calibration-v4-pilot-commitment-build.mjs",
        "--study-id", STUDY,
        "--role", reviewer.role,
        "--source-root", sourceRoot,
        "--source-path", "sealed.json",
        "--output-dir", outputDir
      ],
      {
        GITHUB_ACTOR: reviewer.actor,
        GITHUB_TRIGGERING_ACTOR: reviewer.actor,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_RUN_ID: String(reviewer.runId),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: producerSha,
        CALIBRATION_SOURCE_COMMIT: sourceCommit
      }
    );
    assert.equal(minted.status, 0, minted.stderr);
    const commitmentBytes = readFileSync(path.join(outputDir, "commitment.json"), "utf8");
    const zip = makeStoredZip([["commitment.json", commitmentBytes]]);
    artifacts.set(reviewer.runId, {
      ...reviewer,
      zip,
      archiveSha256: sha256Hex(zip),
      archiveBytes: zip.length
    });
  }

  // A STUBBED GITHUB API: a real `gh` shim first on PATH, serving realistic
  // run, artifact-metadata and zip responses from a fixture directory the
  // refusal legs below rewrite.
  const apiDir = path.join(world.root, "api");
  mkdirSync(apiDir, { recursive: true });
  const writeApi = (over = {}) => {
    for (const [runId, artifact] of artifacts) {
      const runJson = {
        id: runId,
        run_attempt: 1,
        event: "workflow_dispatch",
        path: V4_WORKFLOW,
        head_branch: "main",
        head_sha: over.headSha ?? producerSha,
        conclusion: "success",
        status: "completed",
        repository: { full_name: REPOSITORY },
        actor: { login: artifact.actor },
        triggering_actor: { login: artifact.actor },
        run_started_at: "2026-08-25T10:00:00Z",
        updated_at: "2026-08-25T10:10:00Z",
        ...(over.run ?? {})
      };
      writeFileSync(path.join(apiDir, `run-${runId}.json`), JSON.stringify(runJson));
      const artifactsJson = {
        total_count: 1,
        artifacts: [
          {
            id: artifact.artifactId,
            name: `site-behavior-calibration-label-commitment-${artifact.role}-${STUDY}-${runId}-1`,
            size_in_bytes: artifact.archiveBytes,
            digest: `sha256:${artifact.archiveSha256}`,
            expired: false,
            created_at: "2026-08-25T10:05:00Z",
            expires_at: "2026-11-25T10:05:00Z",
            workflow_run: { id: runId, head_sha: over.headSha ?? producerSha },
            ...(over.artifact ?? {})
          }
        ],
        ...(over.artifactsPage ?? {})
      };
      writeFileSync(path.join(apiDir, `artifacts-${runId}.json`), JSON.stringify(artifactsJson));
      writeFileSync(path.join(apiDir, `zip-${artifact.artifactId}.zip`), over.zipFor?.(artifact) ?? artifact.zip);
    }
  };
  writeApi();
  const binDir = path.join(world.root, "bin");
  mkdirSync(binDir, { recursive: true });
  const ghShim = path.join(binDir, "gh");
  writeFileSync(
    ghShim,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const apiDir = process.env.CEREMONY_API_DIR;
const endpoint = process.argv[process.argv.length - 1];
let match;
if ((match = /actions\\/runs\\/(\\d+)$/.exec(endpoint))) {
  process.stdout.write(fs.readFileSync(path.join(apiDir, "run-" + match[1] + ".json")));
} else if ((match = /actions\\/runs\\/(\\d+)\\/artifacts$/.exec(endpoint))) {
  process.stdout.write(fs.readFileSync(path.join(apiDir, "artifacts-" + match[1] + ".json")));
} else if ((match = /actions\\/artifacts\\/(\\d+)\\/zip$/.exec(endpoint))) {
  process.stdout.write(fs.readFileSync(path.join(apiDir, "zip-" + match[1] + ".zip")));
} else {
  process.stderr.write("unexpected endpoint " + endpoint);
  process.exit(1);
}
`,
    { mode: 0o755 }
  );
  chmodSync(ghShim, 0o755);

  const coordinatesPath = path.join(world.root, "coordinates.json");
  const coordinates = [...artifacts.values()].filter((artifact) => !artifact.extra).map((artifact) => ({
    role: artifact.role,
    runId: artifact.runId,
    runAttempt: 1,
    artifactId: artifact.artifactId,
    archiveSha256: artifact.archiveSha256
  }));
  writeFileSync(coordinatesPath, canonicalPrettyJson(coordinates));

  const fetchEnv = {
    PATH: `${binDir}:${process.env.PATH}`,
    CEREMONY_API_DIR: apiDir,
    GITHUB_REPOSITORY: REPOSITORY
  };
  const fetchInto = (outDir, env = {}) =>
    run(
      world,
      [
        "calibration-v4-fetch-commitments.mjs",
        "--study-dir", path.posix.join("calibration", STUDY),
        "--coordinates", coordinatesPath,
        "--out-dir", outDir,
        "--upstream-ref", "upstream"
      ],
      { ...fetchEnv, ...env }
    );
  const recordsDir = path.join(world.root, "records");
  const fetched = fetchInto(recordsDir);
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.match(fetched.stdout, /fetched 3 authenticated commitment\(s\)/);
  const recordFiles = readdirSync(recordsDir).sort();
  assert.equal(recordFiles.length, 3);
  // Zero-padded index order, so a re-fetch produces the same frozen set.
  assert.deepEqual(
    recordFiles,
    ["001-labeler-alice.json", "002-labeler-bob.json", "003-tiebreaker-carol.json"]
  );

  // ONLY the fetched records reach the close.
  const authPath = path.join(studyDir, "pilot-labeling-authorization.json");
  const close = run(world, [
    "calibration-v4-pilot-close.mjs",
    "--frame-tasks", path.join(studyDir, "frame-tasks.json"),
    "--commitments-dir", recordsDir,
    "--public-key", path.join(studyDir, "label-sealing-public-key.pem"),
    "--out", authPath
  ]);
  assert.equal(close.status, 0, close.stderr);
  assert.match(close.stdout, /3 authorized commitments/);

  const revealDir = path.join(world.root, "revealed");
  const reveal = run(
    world,
    [
      "calibration-v4-reveal.mjs",
      "--frame-tasks", path.join(studyDir, "frame-tasks.json"),
      "--tasks-dir", path.join(studyDir, "tasks"),
      "--authorization", authPath,
      "--commitments-dir", recordsDir,
      "--out-dir", revealDir
    ],
    { CALIBRATION_LABEL_REVEAL_PRIVATE_KEY: privateKeyPem }
  );
  assert.equal(reveal.status, 0, reveal.stderr);
  assert.match(reveal.stdout, new RegExp(`resolved ${CASES} cases`));
  const resolved = JSON.parse(readFileSync(path.join(revealDir, "resolved-labels.json"), "utf8"));
  assert.equal(resolved.cases.length, CASES);

  const sizing = run(world, [
    "calibration-v4-pilot-sizing.mjs",
    "--resolved-labels", path.join(revealDir, "resolved-labels.json"),
    "--frame-tasks", path.join(studyDir, "frame-tasks.json"),
    "--swept-eligible-pool", "1126",
    "--out", path.join(studyDir, "pilot-sizing.json")
  ]);
  assert.equal(sizing.status, 0, sizing.stderr);
  const sized = JSON.parse(readFileSync(path.join(studyDir, "pilot-sizing.json"), "utf8"));
  assert.equal(sized.counts.total, CASES);
  assert.equal(sized.counts.present, 25);
  assert.equal(sized.minimumPerClass, 100);

  // ============ REFUSALS ============
  // Each leg rewrites what the stubbed API serves, or the coordinates, and
  // requires the fetch to refuse. The fetch is the ONLY step that authenticates,
  // so a lie that survives it is a lie in the committed authorization.
  let leg = 0;
  const refuses = (label, pattern, over, coordinateOver) => {
    leg += 1;
    if (coordinateOver) {
      writeFileSync(coordinatesPath, canonicalPrettyJson(coordinateOver(structuredClone(coordinates))));
    } else {
      writeFileSync(coordinatesPath, canonicalPrettyJson(coordinates));
    }
    writeApi(over ?? {});
    const attempt = fetchInto(path.join(world.root, `refused-${leg}`));
    assert.notEqual(attempt.status, 0, `${label} was ACCEPTED`);
    assert.match(attempt.stderr, pattern, label);
  };

  const notProducer = /not one successful non-delegated main-branch producer/;
  refuses("wrong workflow path", notProducer, { run: { path: ".github/workflows/calibration-label-batch.yml" } });
  refuses("wrong repository", notProducer, { run: { repository: { full_name: "someone/else" } } });
  refuses("wrong event", notProducer, { run: { event: "push" } });
  refuses("unsuccessful conclusion", notProducer, { run: { conclusion: "failure" } });
  refuses("wrong run attempt", notProducer, { run: { run_attempt: 2 } });
  refuses("delegated dispatch", notProducer, { run: { triggering_actor: { login: "mallory" } } });
  refuses("substituted actor", /identity does not match|reviewerLogin|does not match the authenticated/i, {
    run: { actor: { login: "mallory" }, triggering_actor: { login: "mallory" } }
  });
  refuses("off-branch producer", notProducer, { run: { head_branch: "not-main" } });

  // A producer commit that never landed: the run is otherwise perfect, and its
  // head is not in the accepted range derived from repository history. This is
  // the only thing standing between a commitment minted from an unlanded
  // producer and the committed authorization.
  refuses("producer outside the accepted range", /not an accepted pre-assembly evidence producer/, {
    headSha: "c".repeat(40)
  });
  // A producer that IS an ancestor of the branch but predates the frame it
  // claims to have read. This isolates the accepted-range check: ancestry
  // passes here, so only the range can refuse it. (Ancestry itself is
  // redundant by construction in this derivation, since every commit in the
  // range comes from the branch's own history; it stays as a guard against a
  // mis-derived range, and no leg can isolate it.)
  refuses("producer older than the frame freeze", /not an accepted pre-assembly evidence producer/, {
    headSha: beforeFreeze
  });

  const notArtifact = /did not identify exactly one artifact|does not bind the authenticated run window and digest/;
  refuses("substituted artifact name", notArtifact, { artifact: { name: "site-behavior-calibration-label-commitment-labeler-other-1-1" } });
  refuses("substituted artifact id", notArtifact, { artifact: { id: 999999 } });
  refuses("substituted artifact digest", notArtifact, { artifact: { digest: `sha256:${sha("elsewhere")}` } });
  refuses("expired artifact", notArtifact, { artifact: { expired: true } });
  refuses("artifact from another run", notArtifact, { artifact: { workflow_run: { id: 424242, head_sha: producerSha } } });

  // The archive itself substituted: the digest the API attests no longer
  // describes the bytes served.
  refuses("substituted zip", /size or digest does not match GitHub metadata/, {
    zipFor: () => makeStoredZip([["commitment.json", canonicalPrettyJson({ not: "a commitment" })]])
  });

  // A record edited AFTER authentication: same archive digest claimed, altered
  // contents.
  refuses("record changed after authentication", /size or digest does not match GitHub metadata/, {
    zipFor: (artifact) => {
      const record = JSON.parse(
        readFileSync(path.join(world.root, `commitment-${artifact.extra ? `${artifact.actor}-again` : artifact.actor}`, "commitment.json"), "utf8")
      );
      record.source = { ...record.source, path: "elsewhere.json" };
      return makeStoredZip([["commitment.json", canonicalPrettyJson(record)]]);
    }
  });

  // Coordinate-level forgeries.
  refuses("declared archive digest substituted", notArtifact, {}, (list) => {
    list[0].archiveSha256 = sha("some other archive");
    return list;
  });
  refuses("role substituted", notArtifact, {}, (list) => {
    list[0].role = "tiebreaker";
    return list;
  });
  refuses("a replayed coordinate", /two coordinates share runId/, {}, (list) => [
    list[0],
    { ...list[0] },
    list[2]
  ]);
  // A replay dressed as two distinct runs: different coordinates, one reviewer.
  const aliceAgain = [...artifacts.values()].find((artifact) => artifact.extra);
  refuses("a duplicated reviewer", /two authenticated commitments are from alice/, {}, (list) => [
    list[0],
    {
      role: aliceAgain.role,
      runId: aliceAgain.runId,
      runAttempt: 1,
      artifactId: aliceAgain.artifactId,
      archiveSha256: aliceAgain.archiveSha256
    },
    list[2]
  ]);

  // A missing reviewer passes the FETCH (it authenticates what it is given)
  // and must be refused by the close, which is where set custody lives.
  writeFileSync(coordinatesPath, canonicalPrettyJson([coordinates[0], coordinates[2]]));
  writeApi();
  const partialDir = path.join(world.root, "records-partial");
  const partialFetch = fetchInto(partialDir);
  assert.equal(partialFetch.status, 0, partialFetch.stderr);
  const partialClose = run(world, [
    "calibration-v4-pilot-close.mjs",
    "--frame-tasks", path.join(studyDir, "frame-tasks.json"),
    "--commitments-dir", partialDir,
    "--public-key", path.join(studyDir, "label-sealing-public-key.pem"),
    "--out", path.join(world.root, "never-auth.json")
  ]);
  assert.notEqual(partialClose.status, 0);
  assert.match(partialClose.stderr, /2 through 10 distinct|exactly one distinct blind tiebreaker/);

  // A frame or carrier that disagrees with what the commitments bind.
  writeFileSync(coordinatesPath, canonicalPrettyJson(coordinates));
  writeApi();
  writeFileSync(path.join(studyDir, "pilot-carrier.txt"), `${"b2".repeat(20)}\n`);
  const wrongCarrier = fetchInto(path.join(world.root, "records-wrong-carrier"));
  assert.notEqual(wrongCarrier.status, 0);
  assert.match(wrongCarrier.stderr, /the committed frame binds/);
  writeFileSync(path.join(studyDir, "pilot-carrier.txt"), `${CARRIER}\n`);

  // A sealing key that is not the ceremony's committed one.
  const strangerPem = generateKeyPairSync("rsa", { modulusLength: 3072 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  writeFileSync(path.join(studyDir, "label-sealing-public-key.pem"), strangerPem);
  const wrongKey = fetchInto(path.join(world.root, "records-wrong-key"));
  assert.notEqual(wrongKey.status, 0);
  writeFileSync(path.join(studyDir, "label-sealing-public-key.pem"), publicKeyPem);

  rmSync(world.root, { recursive: true, force: true });
});
