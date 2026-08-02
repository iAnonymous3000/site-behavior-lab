import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AA_ARCHIVE_WORKFLOW,
  AA_ORDER_POLICY,
  AA_PRODUCER_RECEIPT_FILE,
  aaComparisonFirstArm,
  aaExecutionPlan,
  aaProducerReceiptIssues,
  addAaStudyEvidenceToMeasurementBinding,
  canonicalAaJson,
  createAaArtifact,
  createAaProducerReceipt,
  inspectAaArtifact,
  validateAaGithubMetadata,
  verifyAaProducerReceiptAgainstArtifact,
  writeAaArtifact
} from "./aa-study-producer-lib.mjs";
import { evaluateAaStudy } from "./aa-study-lib.mjs";
import {
  buildAttemptLedger,
  sha256Hex
} from "./scanner-fidelity-study-lib.mjs";

const STUDY = "aa-governed-test";
const CANDIDATE = "a".repeat(40);
const CARRIER = "b".repeat(40);
const ATTESTER = "c".repeat(40);
const IDENTITY = "1".repeat(64);
const TARGET_FRAME = [
  { targetId: "one", url: "https://one.example/" }
];
const TARGET_FRAME_TEXT = `${JSON.stringify(TARGET_FRAME, null, 2)}\n`;
const FRAME_DIGEST = sha256Hex(TARGET_FRAME_TEXT);
const RUNTIME = {
  buildCommit: CANDIDATE,
  observer: "node-playwright",
  methodologyVersion: "m",
  detectorRegistry: { version: "v", digest: "2".repeat(64) },
  fingerprints: {
    execution: "3".repeat(64),
    measurementEnvironment: "4".repeat(64),
    condition: "5".repeat(64)
  },
  runtime: {
    automation: "playwright-chromium",
    browser: { name: "chromium", version: "140" },
    device: { viewport: "1280x800" },
    locale: "en-US",
    language: "en",
    timezone: "UTC",
    egress: { label: "controlled-self-hosted" },
    headless: true
  }
};

function preregistration(overrides = {}) {
  return {
    kind: "site-behavior-aa-preregistration",
    studyVersion: 2,
    studyId: STUDY,
    declaredAt: "2026-08-01T00:00:00.000Z",
    measurementIdentityManifestPath:
      "research/measurement-candidate/measurement-identity.json",
    measurementIdentityDigest: IDENTITY,
    sitesFile: `research/aa-studies/${STUDY}/target-frame.json`,
    sitesFileDigest: FRAME_DIGEST,
    targetCount: 1,
    repetitionsPerTarget: 2,
    conditions: {
      mode: "single",
      device: "desktop",
      gpcEnabled: false,
      consentMode: "observe"
    },
    thresholds: {
      minimumEligibleTargets: 1,
      maximumFailingTargetFraction: 0,
      maximumMetricRelativeRange: {
        totalRequests: 0,
        thirdPartyRequests: 0,
        knownTrackerRequests: 0,
        thirdPartyDomains: 0
      },
      minimumThirdPartyDomainJaccard: 1,
      requireCounterbalancedOrders: false
    },
    ...overrides
  };
}

function observation() {
  return {
    schemaVersion: 2,
    reportType: "single",
    order: null,
    arms: {
      run: {
        runOutcome: "complete",
        requestOutcome: "complete",
        counts: {
          totalRequests: 10,
          thirdPartyRequests: 5,
          knownTrackerRequests: 1,
          thirdPartyDomains: 2
        },
        thirdPartyDomains: ["a.example", "b.example"],
        producerRuntime: structuredClone(RUNTIME)
      }
    }
  };
}

function artifactFixture() {
  const pre = preregistration();
  const preText = canonicalAaJson(pre);
  const attempts = [1, 2].map((repetition) => ({
    url: "https://one.example/",
    shape: "aa",
    repetition,
    outcome: "pass",
    reason: null,
    censoredFamilies: [],
    observation: observation()
  }));
  const ledger = buildAttemptLedger({
    createdAt: "2026-08-01T01:10:00.000Z",
    collection: {
      startedAt: "2026-08-01T01:00:00.000Z",
      completedAt: "2026-08-01T01:09:00.000Z"
    },
    baseOrigin: "process-local://aa-study",
    sitesFile: pre.sitesFile,
    shardIndex: 0,
    shardCount: 1,
    conditions: pre.conditions,
    repetitions: 2,
    selectedTargets: 1,
    attempts,
    acceptanceThresholds: {
      minimumAnsweringTargets: 1,
      minimumRepeatableTargets: 1
    },
    provenance: {
      expectedBuildCommit: CANDIDATE,
      measurementIdentityDigest: IDENTITY,
      sitesFileDigest: FRAME_DIGEST,
      driverRuntime: {
        nodeVersion: "24.14.1",
        platform: "linux",
        architecture: "x64"
      }
    }
  });
  const evaluation = evaluateAaStudy({
    preregistration: pre,
    targetFrame: TARGET_FRAME,
    targetFrameText: TARGET_FRAME_TEXT,
    ledger
  });
  assert.equal(evaluation.status, "pass");
  return createAaArtifact({
    studyId: STUDY,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    runId: 123,
    runAttempt: 2,
    runner: {
      labelSha256: "6".repeat(64),
      identitySha256: "7".repeat(64),
      environment: "ephemeral-self-hosted"
    },
    egress: {
      identity: "controlled-self-hosted",
      regionSha256: "8".repeat(64)
    },
    preregistrationText: preText,
    targetFrameText: TARGET_FRAME_TEXT,
    ledger,
    evaluation
  });
}

function withTemp(run) {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-aa-producer-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("comparison scheduling is deterministic and requires exact even AB/BA balance", () => {
  assert.equal(aaComparisonFirstArm(1), "baseline");
  assert.equal(aaComparisonFirstArm(2), "variant");
  assert.equal(aaComparisonFirstArm(4), "variant");
  const comparison = preregistration({
    repetitionsPerTarget: 4,
    conditions: {
      mode: "gpc",
      device: "desktop",
      gpcEnabled: false,
      consentMode: "observe"
    },
    thresholds: {
      ...preregistration().thresholds,
      requireCounterbalancedOrders: true
    }
  });
  assert.equal(aaExecutionPlan(comparison).orderPolicy, AA_ORDER_POLICY);
  assert.throws(
    () => aaExecutionPlan({ ...comparison, repetitionsPerTarget: 3 }),
    /even number/
  );
});

test("artifact inspection requires an exact unsharded passing file set", () =>
  withTemp((root) => {
    const output = path.join(root, "artifact");
    writeAaArtifact(output, artifactFixture());
    const inspected = inspectAaArtifact(output, {
      studyId: STUDY,
      candidateCommit: CANDIDATE
    });
    assert.equal(inspected.ledger.shard.count, 1);
    writeFileSync(path.join(output, "extra.json"), "{}\n");
    assert.throws(
      () => inspectAaArtifact(output),
      /exactly five regular files/
    );
  }));

test("artifact inspection rejects symlink substitution and digest tampering", () =>
  withTemp((root) => {
    const output = path.join(root, "artifact");
    writeAaArtifact(output, artifactFixture());
    const ledger = path.join(output, "attempt-ledger.json");
    rmSync(ledger);
    symlinkSync(path.join(output, "evaluation.json"), ledger);
    assert.throws(
      () => inspectAaArtifact(output),
      /exactly five regular files|regular file/
    );
  }));

test("receipt binds completed run, artifact digest, attester, and exact evidence", () =>
  withTemp((root) => {
    const output = path.join(root, "artifact");
    writeAaArtifact(output, artifactFixture());
    const inspected = inspectAaArtifact(output);
    const receipt = createAaProducerReceipt({
      artifactInspection: inspected,
      metadata: {
        artifactId: 99,
        artifactName: `site-behavior-aa-study-${STUDY}-123-2`,
        archiveSha256: "9".repeat(64)
      },
      attesterCommit: ATTESTER,
      recordedAt: "2026-08-01T02:00:00.000Z"
    });
    assert.deepEqual(aaProducerReceiptIssues(receipt), []);
    verifyAaProducerReceiptAgainstArtifact(receipt, inspected);
    const drift = structuredClone(receipt);
    drift.evidence.attemptLedger.sha256 = "0".repeat(64);
    assert.throws(
      () => verifyAaProducerReceiptAgainstArtifact(drift, inspected),
      /does not exactly describe/
    );
    assert.equal(receipt.attester.workflow, AA_ARCHIVE_WORKFLOW);
  }));

test("live Actions metadata refuses a pending, failed, wrong-workflow, or drifted artifact", () =>
  withTemp((root) => {
    const runPath = path.join(root, "run.json");
    const artifactPath = path.join(root, "artifact.json");
    const run = {
      id: 123,
      run_attempt: 2,
      event: "workflow_dispatch",
      path: ".github/workflows/aa-study.yml",
      head_branch: "main",
      head_sha: CARRIER,
      status: "completed",
      conclusion: "success",
      repository: { full_name: "iAnonymous3000/site-behavior-lab" }
    };
    const artifact = {
      id: 99,
      name: `site-behavior-aa-study-${STUDY}-123-2`,
      expired: false,
      size_in_bytes: 100,
      digest: `sha256:${"9".repeat(64)}`,
      workflow_run: { id: 123, head_sha: CARRIER }
    };
    writeFileSync(runPath, JSON.stringify(run));
    writeFileSync(artifactPath, JSON.stringify(artifact));
    assert.equal(
      validateAaGithubMetadata({
        runMetadataPath: runPath,
        artifactMetadataPath: artifactPath,
        studyId: STUDY,
        runId: 123,
        runAttempt: 2,
        artifactId: 99,
        artifactName: artifact.name,
        archiveSha256: "9".repeat(64),
        runHeadCommit: CARRIER
      }).artifactId,
      99
    );
    writeFileSync(runPath, JSON.stringify({ ...run, conclusion: "failure" }));
    assert.throws(
      () =>
        validateAaGithubMetadata({
          runMetadataPath: runPath,
          artifactMetadataPath: artifactPath,
          studyId: STUDY,
          runId: 123,
          runAttempt: 2,
          artifactId: 99,
          artifactName: artifact.name,
          archiveSha256: "9".repeat(64),
          runHeadCommit: CARRIER
        }),
      /successful governed/
    );
    writeFileSync(
      runPath,
      JSON.stringify({ ...run, status: "in_progress", conclusion: null })
    );
    assert.throws(
      () =>
        validateAaGithubMetadata({
          runMetadataPath: runPath,
          artifactMetadataPath: artifactPath,
          studyId: STUDY,
          runId: 123,
          runAttempt: 2,
          artifactId: 99,
          artifactName: artifact.name,
          archiveSha256: "9".repeat(64),
          runHeadCommit: CARRIER
        }),
      /successful governed/
    );
    writeFileSync(
      runPath,
      JSON.stringify({
        ...run,
        path: ".github/workflows/scanner-fidelity-study.yml"
      })
    );
    assert.throws(
      () =>
        validateAaGithubMetadata({
          runMetadataPath: runPath,
          artifactMetadataPath: artifactPath,
          studyId: STUDY,
          runId: 123,
          runAttempt: 2,
          artifactId: 99,
          artifactName: artifact.name,
          archiveSha256: "9".repeat(64),
          runHeadCommit: CARRIER
        }),
      /successful governed/
    );
    writeFileSync(runPath, JSON.stringify(run));
    writeFileSync(
      artifactPath,
      JSON.stringify({
        ...artifact,
        digest: `sha256:${"0".repeat(64)}`
      })
    );
    assert.throws(
      () =>
        validateAaGithubMetadata({
          runMetadataPath: runPath,
          artifactMetadataPath: artifactPath,
          studyId: STUDY,
          runId: 123,
          runAttempt: 2,
          artifactId: 99,
          artifactName: artifact.name,
          archiveSha256: "9".repeat(64),
          runHeadCommit: CARRIER
        }),
      /does not bind/
    );
  }));

test("binding update enumerates ledger, evaluation, receipt, and bundle exactly once", () =>
  withTemp((root) => {
    const output = path.join(root, "artifact");
    writeAaArtifact(output, artifactFixture());
    const inspected = inspectAaArtifact(output);
    const receipt = createAaProducerReceipt({
      artifactInspection: inspected,
      metadata: {
        artifactId: 99,
        artifactName: `site-behavior-aa-study-${STUDY}-123-2`,
        archiveSha256: "9".repeat(64)
      },
      attesterCommit: ATTESTER,
      recordedAt: "2026-08-01T02:00:00.000Z"
    });
    const studyRoot = path.join(root, "research", "aa-studies", STUDY);
    mkdirSync(studyRoot, { recursive: true });
    writeFileSync(
      path.join(studyRoot, "producer-receipt.sigstore.json"),
      "{}\n"
    );
    const bindingPath = path.join(
      root,
      "research",
      "measurement-candidate-binding.json"
    );
    writeFileSync(
      bindingPath,
      canonicalAaJson({
        candidateCommit: CANDIDATE,
        evidence: []
      })
    );
    const entries = addAaStudyEvidenceToMeasurementBinding(
      root,
      STUDY,
      receipt
    );
    assert.deepEqual(
      entries.map((entry) => entry.category).sort(),
      [
        "aa-attempt-ledger",
        "aa-evaluation",
        "aa-producer-attestation",
        "aa-producer-receipt"
      ]
    );
    assert.throws(
      () => addAaStudyEvidenceToMeasurementBinding(root, STUDY, receipt),
      /already enumerates/
    );
  }));

test("workflow contract keeps collection unsharded and isolates hosted attestation from repository writes", () => {
  const producer = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "aa-study.yml"),
    "utf8"
  );
  const archive = readFileSync(
    path.join(
      process.cwd(),
      ".github",
      "workflows",
      "archive-aa-study.yml"
    ),
    "utf8"
  );
  assert.doesNotMatch(producer, /matrix:|SCANNER_FIDELITY_SHARD/);
  assert.match(producer, /tsconfig\.aa-study\.json/);
  assert.match(producer, /aa-study-acquire\.mjs/);
  assert.match(producer, /runs-on: \$\{\{ needs\.preflight\.outputs\.runner_label \}\}/);
  assert.doesNotMatch(
    producer,
    /scanner-fidelity-study\.mjs|localhost|127\.0\.0\.1|api\/scan/
  );
  const acquisition = readFileSync(
    path.join(process.cwd(), "scripts", "aa-study-acquire.mjs"),
    "utf8"
  );
  const archiveScript = readFileSync(
    path.join(process.cwd(), "scripts", "aa-study-archive.mjs"),
    "utf8"
  );
  assert.match(acquisition, /executePreparedScan/);
  assert.match(acquisition, /drawComparisonFirstArm:\s*\(\)\s*=>\s*\n?\s*aaComparisonFirstArm\(repetition\)/);
  assert.doesNotMatch(acquisition, /\bfetch\s*\(|\blisten\s*\(|Math\.random|randomBytes/);
  assert.ok(
    acquisition.indexOf("const collectionStartedAt") <
      acquisition.indexOf("for (const site of sites)"),
    "the real collection window must start before the first target visit"
  );
  const attestationJob = archive.slice(
    archive.indexOf("  attest:"),
    archive.indexOf("  propose:")
  );
  assert.match(attestationJob, /runs-on: ubuntu-latest/);
  assert.match(attestationJob, /id-token: write/);
  assert.match(attestationJob, /attestations: write/);
  assert.doesNotMatch(attestationJob, /contents: write|pull-requests: write/);
  assert.match(archive, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(archive, /github\.event\.workflow_run\.event == 'workflow_dispatch'/);
  assert.match(
    archive,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/
  );
  const proposalJob = archive.slice(archive.indexOf("  propose:"));
  assert.doesNotMatch(proposalJob, /id-token: write|attestations: write/);
  assert.match(archive, /actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6/);
  assert.match(archiveScript, /ensure-gh-attestation-verifier\.mjs/);
  assert.match(archiveScript, /--deny-self-hosted-runners/);
  assert.match(archiveScript, /https:\/\/slsa\.dev\/provenance\/v1/);
  assert.match(archive, /producer-receipt\.sigstore\.json/);
  assert.match(archive, /aa-study-archive\.mjs/);
});
