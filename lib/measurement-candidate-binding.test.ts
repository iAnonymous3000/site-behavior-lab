import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { canonicalJson } from "./canonical-json";
import {
  inspectMeasurementCandidateBinding,
  measurementCandidateAttestationVerifyArgs,
  measurementCandidateAcceptsProducerCommit,
  measurementCandidateAcceptsProducerForEvidencePath,
  measurementCandidateEvidenceTimestampIsCausal,
  measurementCandidateBuildProjection,
  MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH,
  MEASUREMENT_CANDIDATE_BINDING_KIND,
  MEASUREMENT_CANDIDATE_BINDING_PATH,
  MEASUREMENT_CANDIDATE_INPUTS_DIGEST_DOMAIN,
  MEASUREMENT_CANDIDATE_INPUTS_KIND,
  MEASUREMENT_CANDIDATE_INPUTS_PATH,
  MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH,
  MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH,
  MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH,
  MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW,
  MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH,
  VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV,
  MEASUREMENT_CALIBRATION_ARTIFACT_MANIFEST_KIND,
  MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
  MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH,
  MEASUREMENT_IDENTITY_DIGEST_DOMAIN,
  MEASUREMENT_IDENTITY_KIND,
  MEASUREMENT_IDENTITY_PATH,
  MEASUREMENT_STAGING_TEARDOWN_SOURCE_CLOSURE_PATHS,
  measurementCalibrationAnalysisPolicyProblems,
  measurementCalibrationPolicyDispositionSha256,
  verifiedMeasurementCandidateAcquisitionContext,
  verifiedMeasurementCandidateBuildProof,
  verifiedMeasurementCandidateBinding,
  verifyStagingTeardownHostedSourceTrust,
  type MeasurementCandidateAttestationRequest,
  type MeasurementDurableReplayVerificationRequest,
  type MeasurementDurableSoakProvenanceVerificationRequest,
  type MeasurementOperatorEvidenceVerificationRequest,
  type MeasurementStagingTeardownProvenanceVerificationRequest,
  type MeasurementEvidenceCategory,
  type MeasurementFreezeReceiptVerificationRequest
} from "./measurement-candidate-binding";
import {
  analyzeDetectorCalibrationStudy,
  currentDetectorCalibrationReleaseIdentity,
  detectorCalibrationMeasurementCondition,
  detectorCalibrationRuntimeDigest,
  type DetectorCalibrationRuntimeIdentity,
  type DetectorCalibrationStudy,
  type DetectorCalibrationStudyV2,
  type DetectorCalibrationStudyV3
} from "./detector-calibration";
import { committedCalibrationStudyAnalyses } from "./detector-calibration-source";
import { sha256Hex } from "./sha256";

type EvidenceJson = {
  category: MeasurementEvidenceCategory;
  path: string;
  change:
    | "added"
    | "generated-update"
    | "refreshed"
    | "release-finalization";
  sha256: string;
};

type BindingJson = {
  schemaVersion: number;
  artifactKind: string;
  repository: string;
  targetRelease: string;
  candidateCommit: string;
  candidateTree: string;
  measurementInputs: {
    manifestPath: string;
    manifestSha256: string;
    domainSeparatedDigest: string;
  };
  measurementIdentity: {
    manifestPath: string;
    manifestSha256: string;
    domainSeparatedDigest: string;
  };
  calibrationPolicy: {
    id: string;
    policyArtifactPath: string;
    policyArtifactSha256: string;
    dispositionSha256: string;
  };
  durablePrerequisite: {
    config: { path: string; sha256: string };
    replay: {
      deploymentCommit: string;
      receiptSetDigest: string;
      evidenceStartedAt: string;
      evidenceCapturedAt: string;
      receipts: Array<{
        mode: "lease-expiry" | "lost-resolve";
        path: string;
        sha256: string;
      }>;
    };
    stagingTeardown: { evidencePath: string; evidenceSha256: string };
    transition: { receiptPath: string; receiptSha256: string };
    soak: {
      attestationPath: string;
      attestationSha256: string;
      targetDeviationApproval: null | {
        status: "approved";
        approverType: "named-human";
        approvedBy: string;
        approvedAt: string;
        reason: string;
        candidateCommit: string;
        soakDeploymentCommit: string;
        ledgerSha256: string;
        evidenceWindow: {
          startedAt: string;
          restartObservedAt: string;
          endedAt: string;
        };
        minimumEvidenceHours: 24;
        targetEvidenceHours: 168;
      };
    };
  };
  sourceEvidence: {
    manifestPath: string;
    manifestSha256: string;
    bundlePath: string;
    bundleSha256: string;
    packageInventoryPath: string;
    packageInventorySha256: string;
    packageBundlePath: string;
    packageBundleSha256: string;
    packageReviewLedgerPath: string;
    packageReviewLedgerSha256: string;
    packageLegalEvidence: Array<{ path: string; sha256: string }>;
  };
  attestationPolicy: {
    status: string;
    repository: string;
    signerWorkflow: string;
    sourceDigest: string;
    sourceRef: string;
    denySelfHostedRunners: boolean;
  };
  evidence: EvidenceJson[];
  calibrationStudies: Array<{
    studyId: string;
    detector: string;
    preregistrationPath: string;
    preregistrationSha256: string;
    samplingFramePath: string;
    samplingFrameSha256: string;
    studyPath: string;
    studySha256: string;
    analysisPath: string;
    analysisSha256: string;
    runtimeReceiptPath: string;
    runtimeReceiptSha256: string;
    runtimeReceiptBundlePath: string;
    runtimeReceiptBundleSha256: string;
    artifactManifestPath: string;
    artifactManifestSha256: string;
  }>;
};

type Fixture = {
  root: string;
  candidate: string;
  candidateTree: string;
  replayDeploymentCommit: string;
  transitionCommit: string;
  carrier: string;
  studyId: string;
  preregistrationPath: string;
  samplingFramePath: string;
  studyPath: string;
  analysisPath: string;
  receiptPath: string;
  receiptBundlePath: string;
  artifactManifestPath: string;
};

const CALIBRATION_LABEL_PUBLIC_KEY_PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
}).publicKey;
const CALIBRATION_LABEL_KEY_ID = createHash("sha256")
  .update(
    createPublicKey(CALIBRATION_LABEL_PUBLIC_KEY_PEM).export({
      type: "spki",
      format: "der"
    })
  )
  .digest("hex");

const PASS_ATTESTATION = (_request: MeasurementCandidateAttestationRequest): void => undefined;
const PASS_FREEZE = (_request: MeasurementFreezeReceiptVerificationRequest): void => undefined;
const PASS_DURABLE_REPLAY = (
  _request: MeasurementDurableReplayVerificationRequest
): void => undefined;
const PASS_OPERATOR_EVIDENCE = (
  _request: MeasurementOperatorEvidenceVerificationRequest
): void => undefined;
const PASS_STAGING_TEARDOWN_PROVENANCE = (
  _request: MeasurementStagingTeardownProvenanceVerificationRequest
): void => undefined;
const PASS_DURABLE_SOAK_PROVENANCE = (
  _request: MeasurementDurableSoakProvenanceVerificationRequest
): void => undefined;

function inspectFixture(root: string) {
  return inspectMeasurementCandidateBinding(root, {
    freezeReceiptVerifier: PASS_FREEZE,
    durableReplayVerifier: PASS_DURABLE_REPLAY,
    operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
    stagingTeardownProvenanceVerifier:
      PASS_STAGING_TEARDOWN_PROVENANCE,
    durableSoakProvenanceVerifier:
      PASS_DURABLE_SOAK_PROVENANCE
  });
}

test("one verified candidate covers the complete fixed post-freeze evidence carrier", (t) => {
  const fixture = makeFixture(t, { adequateCalibrationStudy: true });
  const inspected = inspectFixture(fixture.root);
  assert.ok(inspected);
  assert.equal(inspected.candidateCommit, fixture.candidate);
  assert.equal(inspected.carrierCommit, fixture.carrier);
  assert.notEqual(inspected.candidateCommit, inspected.carrierCommit);
  assert.equal(
    inspected.attestationVerifications.containerEvidence.status,
    "required-external-verification"
  );
  assert.equal(
    inspected.attestationVerifications.containerPackageInventory.status,
    "required-external-verification"
  );
  assert.deepEqual(
    inspected.postCandidateAttestationVerifications.map(
      (verification) => verification.subject
    ),
    ["aa-producer-receipt", "calibration-runtime-receipt"]
  );
  assert.deepEqual(
    new Set(inspected.evidence.map((entry) => entry.category)),
    new Set([
      "featured-report",
      "featured-provenance",
      "generated-report-index",
      "generated-corpus-stats",
      "runner-receipt",
      "controlled-publication-manifest",
      "controlled-publication-receipt",
      "aa-attempt-ledger",
      "aa-evaluation",
      "aa-producer-receipt",
      "aa-producer-attestation",
      "measurement-freeze-receipt",
      "lifecycle-receipt",
      "operator-evidence",
      "operator-attestation",
      "release-policy-finalization",
      "citation-finalization",
      "changelog-finalization"
    ])
  );

  const verifiedSubjects: string[] = [];
  const verified = verifiedMeasurementCandidateBinding(fixture.root, {
    attestationVerifier: (request) => {
      verifiedSubjects.push(request.subject);
    },
    freezeReceiptVerifier: PASS_FREEZE,
    durableReplayVerifier: PASS_DURABLE_REPLAY,
    operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
    stagingTeardownProvenanceVerifier:
      PASS_STAGING_TEARDOWN_PROVENANCE,
    durableSoakProvenanceVerifier:
      PASS_DURABLE_SOAK_PROVENANCE
  });
  assert.ok(verified);
  assert.equal(
    verified.attestationVerifications.containerEvidence.status,
    "verified-by-gh-attestation"
  );
  assert.equal(
    verified.attestationVerifications.containerPackageInventory.status,
    "verified-by-gh-attestation"
  );
  assert.deepEqual(verifiedSubjects, [
    "container-evidence",
    "container-package-inventory",
    "aa-producer-receipt",
    "calibration-runtime-receipt"
  ]);

  const analyses = committedCalibrationStudyAnalyses(
    fixture.root,
    {
      // Ordinary build provenance remains S and can never replace C.
      SITE_BEHAVIOR_LAB_BUILD_COMMIT: fixture.carrier
    },
    {
      attestationVerifier: PASS_ATTESTATION,
      freezeReceiptVerifier: PASS_FREEZE,
      durableReplayVerifier: PASS_DURABLE_REPLAY,
      operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
      stagingTeardownProvenanceVerifier:
        PASS_STAGING_TEARDOWN_PROVENANCE,
      durableSoakProvenanceVerifier:
        PASS_DURABLE_SOAK_PROVENANCE
    }
  );
  const study = analyses.find((entry) => entry.studyDir === fixture.studyId);
  assert.ok(study);
  assert.equal(study.analysis.status, "sample-estimate", study.analysis.ineligibilityReasons.join(", "));
  assert.deepEqual(study.analysis.ineligibilityReasons, []);
});

test("structural inspection never substitutes for external Sigstore verification", (t) => {
  const fixture = makeFixture(t, { adequateCalibrationStudy: true });
  assert.equal(
    inspectFixture(fixture.root)?.attestationVerifications.containerEvidence.status,
    "required-external-verification"
  );
  assert.throws(
    () =>
      verifiedMeasurementCandidateBinding(fixture.root, {
        attestationVerifier: () => {
          throw new Error("signature rejected");
        },
        freezeReceiptVerifier: PASS_FREEZE,
        durableReplayVerifier: PASS_DURABLE_REPLAY,
        operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
        stagingTeardownProvenanceVerifier:
          PASS_STAGING_TEARDOWN_PROVENANCE,
        durableSoakProvenanceVerifier:
          PASS_DURABLE_SOAK_PROVENANCE
      }),
    /signature rejected/
  );
  assert.throws(
    () =>
      committedCalibrationStudyAnalyses(fixture.root, {}, {
        attestationVerifier: () => {
          throw new Error("external Sigstore verification required");
        },
        freezeReceiptVerifier: PASS_FREEZE,
        durableReplayVerifier: PASS_DURABLE_REPLAY,
        operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
        stagingTeardownProvenanceVerifier:
          PASS_STAGING_TEARDOWN_PROVENANCE,
        durableSoakProvenanceVerifier:
          PASS_DURABLE_SOAK_PROVENANCE
      }),
    /external Sigstore verification required/
  );
});

test("gh verification argv pins exact SAN, repository, signer/source commits, ref, issuer, and hosted runner", () => {
  const candidate = "a".repeat(40);
  const request: MeasurementCandidateAttestationRequest = {
    subject: "container-evidence",
    artifactPath: "/repo/research/measurement-candidate/evidence.json",
    bundlePath: "/repo/research/measurement-candidate/bundle.json",
    repository: "iAnonymous3000/site-behavior-lab",
    signerWorkflow: MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW,
    certIdentity:
      "https://github.com/iAnonymous3000/site-behavior-lab/.github/workflows/ci.yml@refs/heads/main",
    signerDigest: candidate,
    sourceDigest: candidate,
    sourceRef: "refs/heads/main",
    denySelfHostedRunners: true,
    predicateType: "https://slsa.dev/provenance/v1",
    oidcIssuer: "https://token.actions.githubusercontent.com"
  };
  assert.deepEqual(measurementCandidateAttestationVerifyArgs(request), [
    "attestation",
    "verify",
    request.artifactPath,
    "--bundle",
    request.bundlePath,
    "--repo",
    request.repository,
    "--cert-identity",
    request.certIdentity,
    "--signer-digest",
    candidate,
    "--source-digest",
    candidate,
    "--source-ref",
    "refs/heads/main",
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
    "--cert-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ]);
  assert.equal(request.signerWorkflow, "iAnonymous3000/site-behavior-lab/.github/workflows/ci.yml");
});

test("the attestation verifier bootstraps only checksum-pinned GitHub CLI assets", () => {
  const bootstrap = readFileSync(
    path.join(
      process.cwd(),
      "scripts",
      "ensure-gh-attestation-verifier.mjs"
    ),
    "utf8"
  );
  const bindingSource = readFileSync(
    path.join(process.cwd(), "lib", "measurement-candidate-binding.ts"),
    "utf8"
  );
  const buildToolManifest = JSON.parse(
    readFileSync(
      path.join(
        process.cwd(),
        "scripts",
        "github-cli-build-tool-manifest.json"
      ),
      "utf8"
    )
  ) as {
    version: string;
    usage: string;
    runtime: boolean;
    assets: Array<{
      platform: string;
      archiveSha256: string;
      binarySha256: string;
    }>;
  };
  assert.equal(buildToolManifest.version, "2.96.0");
  assert.equal(buildToolManifest.usage, "build-only");
  assert.equal(buildToolManifest.runtime, false);
  assert.deepEqual(
    buildToolManifest.assets.map((entry) => entry.platform),
    ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]
  );
  for (const asset of buildToolManifest.assets) {
    assert.match(asset.archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(asset.binarySha256, /^[0-9a-f]{64}$/);
  }
  assert.match(bootstrap, /github-cli-build-tool-manifest\.json/);
  assert.match(bootstrap, /parseGithubCliBuildToolManifest/);
  assert.match(bootstrap, /archiveDigest !== asset\.archiveSha256/);
  assert.match(bootstrap, /digest !== expectedSha256/);
  assert.match(bootstrap, /readRegularFileNoFollow/);
  assert.match(bootstrap, /refuseExistingCacheDestination/);
  assert.match(bootstrap, /MAX_ARCHIVE_BYTES/);
  assert.match(bindingSource, /ensure-gh-attestation-verifier\.mjs/);
  assert.match(bindingSource, /measurementCandidateAttestationVerifyArgs/);
  assert.match(
    bindingSource,
    /SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT/
  );
  assert.match(
    bindingSource,
    /SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE_ARTIFACT_CONTEXT_SHA256/
  );
  assert.match(bindingSource, /\["--verify-live-artifact"\]/);
  assert.match(bindingSource, /"--live-artifact-context"/);
  assert.match(bindingSource, /"--live-artifact-context-sha256"/);
  assert.match(
    bindingSource,
    /verifyMeasurementFreezeReceiptWithCanonicalCli\(\s*request,\s*options\.freezeArtifactContext\s*\)/
  );
});

test("a fake PATH or ignored-cache gh cannot satisfy attestation verification", (t) => {
  if (!["linux", "darwin"].includes(process.platform)) {
    t.skip("checksum-pinned bootstrap supports Linux and macOS");
    return;
  }
  const fixture = mkdtempSync(path.join(tmpdir(), "sbl-fake-gh-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const fakeBin = path.join(fixture, "bin");
  const fakeSystemGh = path.join(fakeBin, "gh");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    fakeSystemGh,
    '#!/bin/sh\nprintf "gh version 2.96.0 (fake)\\n"\n'
  );
  chmodSync(fakeSystemGh, 0o700);
  const fakeCacheGh = path.join(
    fixture,
    ".site-behavior-lab",
    "tools",
    `gh-2.96.0-${process.platform}-${process.arch}`,
    "gh"
  );
  mkdirSync(path.dirname(fakeCacheGh), { recursive: true });
  writeFileSync(
    fakeCacheGh,
    '#!/bin/sh\nprintf "gh version 2.96.0 (fake)\\n"\n'
  );
  chmodSync(fakeCacheGh, 0o700);

  const result = spawnSync(
    process.execPath,
    [
      path.join(
        process.cwd(),
        "scripts",
        "ensure-gh-attestation-verifier.mjs"
      )
    ],
    {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: fakeBin,
        SITE_BEHAVIOR_LAB_GH_BOOTSTRAP_OFFLINE: "1"
      }
    }
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(
    result.stderr,
    /cache destination already exists as an untrusted regular file; refusing replacement/
  );
});

test("the hostless build projection requires the dedicated exact candidate and never uses build provenance", (t) => {
  const fixture = makeFixture(t, { adequateCalibrationStudy: true });
  const verified = verifiedMeasurementCandidateBinding(fixture.root, {
    attestationVerifier: PASS_ATTESTATION,
    freezeReceiptVerifier: PASS_FREEZE,
    durableReplayVerifier: PASS_DURABLE_REPLAY,
    operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
    stagingTeardownProvenanceVerifier:
      PASS_STAGING_TEARDOWN_PROVENANCE,
    durableSoakProvenanceVerifier:
      PASS_DURABLE_SOAK_PROVENANCE
  });
  assert.ok(verified);
  const proof = verifiedMeasurementCandidateBuildProof(verified);
  renameSync(path.join(fixture.root, ".git"), path.join(fixture.root, ".git-hidden"));

  assert.throws(
    () =>
      measurementCandidateBuildProjection(fixture.root, {
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: fixture.candidate
      }, { freezeReceiptVerifier: PASS_FREEZE }),
    new RegExp(VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV)
  );
  assert.throws(
    () =>
      measurementCandidateBuildProjection(fixture.root, {
        SITE_BEHAVIOR_LAB_BUILD_COMMIT: fixture.carrier,
        [VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV]:
          Buffer.from('{"proofVersion":1}', "utf8").toString("base64url")
      }, { freezeReceiptVerifier: PASS_FREEZE }),
    /canonical ordered fields/
  );
  const projection = measurementCandidateBuildProjection(fixture.root, {
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: fixture.carrier,
    [VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV]: proof
  }, { freezeReceiptVerifier: PASS_FREEZE });
  assert.ok(projection);
  assert.equal(projection.candidateCommit, fixture.candidate);

  const analyses = committedCalibrationStudyAnalyses(fixture.root, {
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: fixture.carrier,
    [VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV]: proof
  }, { freezeReceiptVerifier: PASS_FREEZE });
  const study = analyses.find((entry) => entry.studyDir === fixture.studyId);
  assert.ok(study);
  assert.equal(study.analysis.status, "sample-estimate");
});

test("an environment-only candidate cannot make an unbound descendant study eligible", (t) => {
  const fixture = makeFixture(t, { includeBinding: false });
  const analyses = committedCalibrationStudyAnalyses(fixture.root, {
    SITE_BEHAVIOR_LAB_BUILD_COMMIT: fixture.candidate
  });
  const study = analyses.find((entry) => entry.studyDir === fixture.studyId);
  assert.ok(study);
  assert.equal(study.analysis.status, "ineligible");
  assert.equal(study.analysis.ineligibilityReasons.includes("build-commit-mismatch"), true);
});

test("the acquisition preflight alone permits the first study to bootstrap from an empty binding", (t) => {
  const fixture = makeFixture(t, { includeCalibrationStudy: false });
  const verificationOptions = {
    attestationVerifier: PASS_ATTESTATION,
    freezeReceiptVerifier: PASS_FREEZE,
    durableReplayVerifier: PASS_DURABLE_REPLAY,
    operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
    stagingTeardownProvenanceVerifier:
      PASS_STAGING_TEARDOWN_PROVENANCE,
    durableSoakProvenanceVerifier:
      PASS_DURABLE_SOAK_PROVENANCE
  };
  assert.throws(
    () => verifiedMeasurementCandidateBinding(fixture.root, verificationOptions),
    /calibrationStudies must be a non-empty array/
  );
  const acquisition = verifiedMeasurementCandidateAcquisitionContext(
    fixture.root,
    verificationOptions
  );
  assert.ok(acquisition);
  assert.deepEqual(acquisition.calibrationStudies, []);
});

test("calibration acquisition stays blocked until the exact censoring policy decision is human-approved", async (t) => {
  const cases: Array<{
    name: string;
    options: Parameters<typeof makeFixture>[1];
    expected: RegExp;
  }> = [
    {
      name: "pending decision",
      options: { calibrationPolicyDecisionStatus: "pending" },
      expected: /decidedBy|explicitly approved/
    },
    {
      name: "different selected policy",
      options: { calibrationPolicyDecisionSelected: "different-policy" },
      expected: /explicitly approved/
    },
    {
      name: "unbound policy artifact digest",
      options: { calibrationPolicyDecisionArtifactSha256: "0".repeat(64) },
      expected: /dispositionSha256 does not bind|explicitly approved/
    }
  ];
  for (const row of cases) {
    await t.test(row.name, (child) => {
      const fixture = makeFixture(child, row.options);
      assert.throws(() => inspectFixture(fixture.root), row.expected);
    });
  }
});

test("the candidate policy rejects descriptive and underpowered calibration analyses", (t) => {
  const fixture = makeFixture(t);
  const inspected = inspectFixture(fixture.root);
  assert.ok(inspected);
  const studyValue = JSON.parse(
    readFileSync(
      path.join(fixture.root, ...fixture.studyPath.split("/")),
      "utf8"
    )
  ) as DetectorCalibrationStudy;
  const descriptive = analyzeDetectorCalibrationStudy(studyValue, {
    expectedBuildCommit: fixture.candidate,
    expectedRuntimeDigest: studyValue.release.runtime.runtimeDigest
  });
  assert.match(
    measurementCalibrationAnalysisPolicyProblems(
      descriptive,
      inspected.calibrationPolicy
    ).join("; "),
    /simple-random/
  );

  studyValue.design.sampling = "simple-random";
  const underpowered = analyzeDetectorCalibrationStudy(studyValue, {
    expectedBuildCommit: fixture.candidate,
    expectedRuntimeDigest: studyValue.release.runtime.runtimeDigest
  });
  assert.equal(underpowered.status, "sample-estimate");
  const problems = measurementCalibrationAnalysisPolicyProblems(
    underpowered,
    inspected.calibrationPolicy
  );
  assert.equal(
    problems.some((problem) =>
      problem.includes("referencePresent denominator 1 is below")
    ),
    true
  );
  assert.equal(
    problems.some((problem) =>
      problem.includes("predictedNotDetected denominator 1 is below")
    ),
    true
  );
});

test("the pre-candidate durable prerequisite rejects widened transitions and short soaks", async (t) => {
  await t.test(
    "a local staging teardown receipt cannot substitute for hosted provider capture",
    (child) => {
      const fixture = makeFixture(child);
      assert.throws(
        () =>
          inspectMeasurementCandidateBinding(fixture.root, {
            freezeReceiptVerifier: PASS_FREEZE,
            durableReplayVerifier: PASS_DURABLE_REPLAY,
            operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE
          }),
        /staging teardown requires dedicated GitHub-hosted provider-capture provenance; candidate is missing trusted workflow/
      );
    }
  );
  await t.test(
    "hosted teardown provenance binds the unique receipt carrier separately from the replay source",
    (child) => {
      const fixture = makeFixture(child);
      let request:
        | MeasurementStagingTeardownProvenanceVerificationRequest
        | undefined;
      const inspected = inspectMeasurementCandidateBinding(fixture.root, {
        freezeReceiptVerifier: PASS_FREEZE,
        durableReplayVerifier: PASS_DURABLE_REPLAY,
        operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
        stagingTeardownProvenanceVerifier: (value) => {
          request = value;
        },
        durableSoakProvenanceVerifier:
          PASS_DURABLE_SOAK_PROVENANCE
      });
      assert.ok(inspected);
      assert.ok(request);
      assert.equal(request.candidateCommit, fixture.candidate);
      assert.equal(request.carrierCommit, fixture.carrier);
      assert.notEqual(
        request.subjectCommit,
        request.replayDeploymentCommit
      );
      assert.equal(
        git(
          fixture.root,
          [
            "show",
            `${request.subjectCommit}:${request.evidencePath}`
          ]
        ),
        readFileSync(
          path.join(
            fixture.root,
            ...request.evidencePath.split("/")
          ),
          "utf8"
        )
      );
    }
  );
  await t.test(
    "hand-authored durable run references cannot replace the authenticated hosted archive",
    (child) => {
      const fixture = makeFixture(child);
      assert.throws(
        () =>
          inspectMeasurementCandidateBinding(fixture.root, {
            freezeReceiptVerifier: PASS_FREEZE,
            durableReplayVerifier: PASS_DURABLE_REPLAY,
            operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
            stagingTeardownProvenanceVerifier:
              PASS_STAGING_TEARDOWN_PROVENANCE
          }),
        /durable soak requires its exact authenticated GitHub-hosted archive; missing digest-enumerated carrier archive/
      );
    }
  );
  await t.test(
    "durable hosted provenance binds the candidate, deployment, subject, and digest-addressed archive",
    (child) => {
      const fixture = makeFixture(child);
      let request:
        | MeasurementDurableSoakProvenanceVerificationRequest
        | undefined;
      const inspected = inspectMeasurementCandidateBinding(
        fixture.root,
        {
          freezeReceiptVerifier: PASS_FREEZE,
          durableReplayVerifier: PASS_DURABLE_REPLAY,
          operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
          stagingTeardownProvenanceVerifier:
            PASS_STAGING_TEARDOWN_PROVENANCE,
          durableSoakProvenanceVerifier: (value) => {
            request = value;
          }
        }
      );
      assert.ok(inspected);
      assert.ok(request);
      assert.equal(request.candidateCommit, fixture.candidate);
      assert.equal(request.carrierCommit, fixture.carrier);
      assert.equal(
        request.deploymentCommit,
        fixture.transitionCommit
      );
      assert.equal(
        request.evidencePath,
        "research/ops-receipts/durable-soak-attestation.json"
      );
      assert.equal(
        request.archiveDirectory,
        `research/hosted-evidence/durable-soak/${request.evidenceSha256}`
      );
      assert.equal(
        git(fixture.root, [
          "merge-base",
          "--is-ancestor",
          request.subjectCommit,
          request.candidateCommit
        ]),
        ""
      );
    }
  );
  await t.test(
    "an older weaker same-path capture workflow cannot supply hosted teardown evidence",
    (child) => {
      const root = mkdtempSync(
        path.join(tmpdir(), "sbl-staging-source-trust-")
      );
      child.after(() => rmSync(root, { recursive: true, force: true }));
      git(root, ["init", "-q"]);
      git(root, ["config", "user.name", "Staging Source Test"]);
      git(root, [
        "config",
        "user.email",
        "staging-source@example.invalid"
      ]);
      const workflowPath = path.join(
        root,
        ".github",
        "workflows",
        "staging-teardown-evidence.yml"
      );
      mkdirSync(path.dirname(workflowPath), { recursive: true });
      writeFileSync(
        workflowPath,
        "name: Staging Teardown Evidence\n# weak caller-authored source\n"
      );
      commitAll(root, "old weak provider capture workflow");
      const sourceHead = git(root, ["rev-parse", "HEAD"]).trim();
      writeFileSync(path.join(root, "receipt.json"), "{}\n");
      commitAll(root, "introduce teardown receipt");
      const subjectCommit = git(root, ["rev-parse", "HEAD"]).trim();
      writeFileSync(
        workflowPath,
        "name: Staging Teardown Evidence\n# trusted hosted provider capture\n"
      );
      commitAll(root, "approve hardened provider capture workflow");
      const candidateCommit = git(root, ["rev-parse", "HEAD"]).trim();
      assert.throws(
        () =>
          verifyStagingTeardownHostedSourceTrust(
            root,
            candidateCommit,
            subjectCommit,
            {
              profile: "staging-teardown",
              sources: [
                {
                  role: "provider-capture",
                  workflowPath:
                    ".github/workflows/staging-teardown-evidence.yml",
                  headBranch: "main",
                  headSha: sourceHead,
                  conclusion: "success"
                }
              ]
            }
          ),
        /staging-teardown-evidence\.yml.*candidate-approved producer closure/
      );
    }
  );

  await t.test(
    "a replayed provider capture cannot hide stale helper bytes behind unchanged workflow YAML",
    (child) => {
      const root = mkdtempSync(
        path.join(tmpdir(), "sbl-staging-helper-trust-")
      );
      child.after(() =>
        rmSync(root, { recursive: true, force: true })
      );
      for (const relativePath of
        MEASUREMENT_STAGING_TEARDOWN_SOURCE_CLOSURE_PATHS) {
        const absolutePath = path.join(
          root,
          ...relativePath.split("/")
        );
        mkdirSync(path.dirname(absolutePath), {
          recursive: true
        });
        writeFileSync(
          absolutePath,
          `${relativePath}: authenticated source\n`
        );
      }
      git(root, ["init", "-q"]);
      git(root, ["config", "user.name", "Staging Source Test"]);
      git(root, [
        "config",
        "user.email",
        "staging-source@example.invalid"
      ]);
      commitAll(root, "authenticated provider capture source");
      const sourceHead = git(root, ["rev-parse", "HEAD"]).trim();
      writeFileSync(path.join(root, "receipt.json"), "{}\n");
      commitAll(root, "introduce teardown receipt");
      const subjectCommit = git(root, ["rev-parse", "HEAD"]).trim();
      const changedPath =
        "scripts/staging-teardown-evidence-lib.mjs";
      writeFileSync(
        path.join(root, ...changedPath.split("/")),
        `${changedPath}: hardened candidate semantics\n`
      );
      commitAll(root, "harden staging semantic verifier");
      const candidateCommit = git(root, ["rev-parse", "HEAD"]).trim();
      assert.throws(
        () =>
          verifyStagingTeardownHostedSourceTrust(
            root,
            candidateCommit,
            subjectCommit,
            {
              profile: "staging-teardown",
              sources: [
                {
                  role: "provider-capture",
                  workflowPath:
                    ".github/workflows/staging-teardown-evidence.yml",
                  headBranch: "main",
                  headSha: sourceHead,
                  conclusion: "success"
                }
              ]
            }
          ),
        /staging-teardown-evidence-lib\.mjs.*candidate-approved producer closure/
      );
    }
  );

  await t.test("transition changes only the durable flag", (child) => {
    const fixture = makeFixture(child, {
      extraDurableTransitionChange: true
    });
    assert.throws(
      () => inspectFixture(fixture.root),
      /transition commit may modify only wrangler\.container\.jsonc/
    );
  });
  await t.test("soak includes a restart and lasts at least 24 hours", (child) => {
    const fixture = makeFixture(child, { shortDurableSoak: true });
    assert.throws(
      () => inspectFixture(fixture.root),
      /restart inside a complete minimum 24-hour window|include a real restart, last at least 24 hours/
    );
  });
  const inspectMutatedApproval = (
    root: string,
    mutate: (
      approval: NonNullable<
        BindingJson["durablePrerequisite"]["soak"]["targetDeviationApproval"]
      >,
      binding: BindingJson
    ) => void
  ) => {
    const binding = readBinding(root);
    const approval =
      binding.durablePrerequisite.soak.targetDeviationApproval;
    assert.ok(approval);
    mutate(approval, binding);
    writeBinding(root, binding);
    return () =>
      inspectMeasurementCandidateBinding(root, {
        freezeReceiptVerifier: PASS_FREEZE,
        durableReplayVerifier: PASS_DURABLE_REPLAY,
        operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
        stagingTeardownProvenanceVerifier:
          PASS_STAGING_TEARDOWN_PROVENANCE,
        durableSoakProvenanceVerifier:
          PASS_DURABLE_SOAK_PROVENANCE,
        requireCleanWorktree: false
      });
  };
  await t.test(
    "a sub-target soak refuses a missing deviation approval",
    (child) => {
      const fixture = makeFixture(child);
      const binding = readBinding(fixture.root);
      binding.durablePrerequisite.soak.targetDeviationApproval = null;
      writeBinding(fixture.root, binding);
      assert.throws(
        () =>
          inspectMeasurementCandidateBinding(fixture.root, {
            freezeReceiptVerifier: PASS_FREEZE,
            durableReplayVerifier: PASS_DURABLE_REPLAY,
            operatorEvidenceVerifier: PASS_OPERATOR_EVIDENCE,
            stagingTeardownProvenanceVerifier:
              PASS_STAGING_TEARDOWN_PROVENANCE,
            durableSoakProvenanceVerifier:
              PASS_DURABLE_SOAK_PROVENANCE,
            requireCleanWorktree: false
          }),
        /requires an object|targetDeviationApproval/
      );
    }
  );
  await t.test(
    "a deviation approval must name its human approver",
    (child) => {
      const fixture = makeFixture(child);
      assert.throws(
        inspectMutatedApproval(
          fixture.root,
          (approval) => {
            approval.approvedBy = "automation";
          }
        ),
        /must identify the named human approver/
      );
    }
  );
  await t.test(
    "a stale deviation approval cannot predate its candidate",
    (child) => {
      const fixture = makeFixture(child);
      assert.throws(
        inspectMutatedApproval(
          fixture.root,
          (approval) => {
            approval.approvedAt = "2026-07-29T12:00:00.000Z";
          }
        ),
        /approval is stale/
      );
    }
  );
  await t.test(
    "a deviation approval cannot drift from its ledger or deployment",
    (child) => {
      const fixture = makeFixture(child);
      assert.throws(
        inspectMutatedApproval(
          fixture.root,
          (approval) => {
            approval.ledgerSha256 = "8".repeat(64);
            approval.soakDeploymentCommit = "7".repeat(40);
          }
        ),
        /does not bind the exact candidate, deployment, ledger, window/
      );
    }
  );
  await t.test(
    "a deviation approval cannot drift from its candidate or window",
    (child) => {
      const fixture = makeFixture(child);
      assert.throws(
        inspectMutatedApproval(
          fixture.root,
          (approval) => {
            approval.candidateCommit = "6".repeat(40);
            approval.evidenceWindow.endedAt =
              "2026-07-29T10:59:59.000Z";
          }
        ),
        /does not bind the exact candidate, deployment, ledger, window/
      );
    }
  );
});

test("container repo: legal evidence is complete and candidate-resident", async (t) => {
  await t.test("a referenced but non-enumerated repository file fails", (child) => {
    const fixture = makeFixture(child);
    const ledgerPath = path.join(
      fixture.root,
      MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      reviews: Array<{ licenseEvidenceRefs: string[] }>;
    };
    ledger.reviews[0].licenseEvidenceRefs.push(
      `repo:LEGAL-NOTICE#sha256=${sha256File(
        path.join(fixture.root, "LEGAL-NOTICE")
      )}`
    );
    writeJson(ledgerPath, ledger);
    const binding = readBinding(fixture.root);
    binding.sourceEvidence.packageReviewLedgerSha256 =
      sha256File(ledgerPath);
    writeBinding(fixture.root, binding);
    commitAll(fixture.root, "reference non-enumerated legal evidence");
    assert.throws(
      () => inspectFixture(fixture.root),
      /packageLegalEvidence must be set-equal to every repo: legal evidence reference/
    );
  });

  await t.test("an untracked repository file cannot satisfy a binding", (child) => {
    const fixture = makeFixture(child);
    const untrackedPath = path.join(
      fixture.root,
      "UNTRACKED-LICENSE"
    );
    writeFileSync(untrackedPath, "Untracked legal evidence.\n");
    const ledgerPath = path.join(
      fixture.root,
      MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      reviews: Array<{ licenseEvidenceRefs: string[] }>;
    };
    ledger.reviews[0].licenseEvidenceRefs = [
      `repo:UNTRACKED-LICENSE#sha256=${sha256File(untrackedPath)}`
    ];
    writeJson(ledgerPath, ledger);
    const binding = readBinding(fixture.root);
    binding.sourceEvidence.packageReviewLedgerSha256 =
      sha256File(ledgerPath);
    binding.sourceEvidence.packageLegalEvidence = [
      {
        path: "UNTRACKED-LICENSE",
        sha256: sha256File(untrackedPath)
      }
    ];
    writeBinding(fixture.root, binding);
    git(fixture.root, [
      "add",
      MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH,
      MEASUREMENT_CANDIDATE_BINDING_PATH
    ]);
    git(fixture.root, [
      "commit",
      "-q",
      "-m",
      "attempt untracked legal evidence substitution"
    ]);
    assert.throws(
      () => inspectFixture(fixture.root),
      /measurement candidate is missing UNTRACKED-LICENSE/
    );
  });
});

test("accepted producer commits are causal to each append-only evidence introduction", (t) => {
  const fixture = makeFixture(t);
  const laterPath =
    "public/reports/20260801-fedcba9876543210fedcba9876543210.json";
  const laterProvenancePath =
    "public/reports/20260801-fedcba9876543210fedcba9876543210.provenance.json";
  writeJson(path.join(fixture.root, ...laterPath.split("/")), {
    schemaVersion: 2,
    reportId: "20260801-fedcba9876543210fedcba9876543210"
  });
  writeJson(path.join(fixture.root, ...laterProvenancePath.split("/")), {
    sourceCommit: fixture.candidate
  });
  const binding = readBinding(fixture.root);
  binding.evidence.push(
    {
      category: "featured-report",
      path: laterPath,
      change: "added",
      sha256: sha256File(path.join(fixture.root, ...laterPath.split("/")))
    },
    {
      category: "featured-provenance",
      path: laterProvenancePath,
      change: "added",
      sha256: sha256File(
        path.join(fixture.root, ...laterProvenancePath.split("/"))
      )
    }
  );
  writeBinding(fixture.root, binding);
  commitAll(fixture.root, "later evidence acquisition");
  const finalCarrier = git(fixture.root, ["rev-parse", "HEAD"]).trim();

  const inspected = inspectFixture(fixture.root);
  assert.ok(inspected);
  assert.deepEqual(inspected.acceptedProducerCommits, [
    fixture.candidate,
    fixture.carrier,
    finalCarrier
  ]);
  assert.equal(
    inspected.evidenceIntroducedAt[laterPath],
    finalCarrier
  );
  assert.match(
    inspected.evidenceIntroducedAtTime[laterPath],
    /^\d{4}-\d{2}-\d{2}T/
  );
  assert.equal(
    measurementCandidateAcceptsProducerCommit(inspected, fixture.candidate),
    true
  );
  assert.equal(
    measurementCandidateAcceptsProducerCommit(inspected, fixture.carrier),
    true
  );
  assert.equal(
    measurementCandidateAcceptsProducerCommit(inspected, finalCarrier),
    true
  );
  assert.equal(
    measurementCandidateAcceptsProducerForEvidencePath(
      inspected,
      fixture.candidate,
      laterPath
    ),
    true
  );
  assert.equal(
    measurementCandidateAcceptsProducerForEvidencePath(
      inspected,
      fixture.carrier,
      laterPath
    ),
    true
  );
  assert.equal(
    measurementCandidateAcceptsProducerForEvidencePath(
      inspected,
      finalCarrier,
      laterPath
    ),
    false
  );
  assert.equal(
    measurementCandidateEvidenceTimestampIsCausal(
      inspected,
      laterPath,
      "2000-01-01T00:00:00.000Z"
    ),
    true
  );
  assert.equal(
    measurementCandidateEvidenceTimestampIsCausal(
      inspected,
      laterPath,
      "2099-01-01T00:00:00.000Z"
    ),
    false
  );
  assert.equal(
    measurementCandidateAcceptsProducerForEvidencePath(
      inspected,
      "f".repeat(40),
      laterPath
    ),
    false
  );
});

test("code, workflow, catalog, package, policy, unlisted, delete, and rename changes fail closed", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (fixture: Fixture) => void;
    expected: RegExp;
  }> = [
    {
      name: "code",
      mutate: (fixture) => writeFileSync(path.join(fixture.root, "lib", "detector.ts"), "changed\n"),
      expected: /not enumerated evidence/
    },
    {
      name: "workflow",
      mutate: (fixture) => writeFileSync(path.join(fixture.root, ".github", "workflows", "ci.yml"), "changed\n"),
      expected: /not enumerated evidence/
    },
    {
      name: "catalog",
      mutate: (fixture) =>
        writeFileSync(path.join(fixture.root, "public", "featured-sites.json"), '[{"domain":"changed.example"}]\n'),
      expected: /post-re-adjudication featured-sites catalog must be byte-identical|not enumerated evidence/
    },
    {
      name: "package",
      mutate: (fixture) => writeFileSync(path.join(fixture.root, "package.json"), "{}\n"),
      expected: /not enumerated evidence/
    },
    {
      name: "policy",
      mutate: (fixture) => writeFileSync(path.join(fixture.root, "RELEASE.md"), "changed\n"),
      expected: /not enumerated evidence/
    },
    {
      name: "unlisted evidence",
      mutate: (fixture) => writeFileSync(path.join(fixture.root, "research", "unlisted.json"), "{}\n"),
      expected: /not enumerated evidence/
    },
    {
      name: "deletion",
      mutate: (fixture) => unlinkSync(path.join(fixture.root, "README.md")),
      expected: /forbidden/
    },
    {
      name: "rename",
      mutate: (fixture) =>
        renameSync(path.join(fixture.root, "README.md"), path.join(fixture.root, "RENAMED.md")),
      expected: /forbidden/
    }
  ];

  for (const row of cases) {
    await t.test(row.name, (child) => {
      const fixture = makeFixture(child);
      row.mutate(fixture);
      commitAll(fixture.root, row.name);
      assert.throws(() => inspectFixture(fixture.root), row.expected);
    });
  }
});

test("a forbidden transient code change cannot be hidden by a later revert", (t) => {
  const fixture = makeFixture(t);
  const detectorPath = path.join(fixture.root, "lib", "detector.ts");
  writeFileSync(detectorPath, "temporary detector change\n");
  commitAll(fixture.root, "transient forbidden code");
  writeFileSync(detectorPath, "frozen detector code\n");
  commitAll(fixture.root, "hide forbidden code at endpoint");
  assert.throws(
    () => inspectFixture(fixture.root),
    /transient candidate-history change lib\/detector\.ts is not enumerated evidence/
  );
});

test("release finalization cannot be rewritten transiently and restored", (t) => {
  const fixture = makeFixture(t);
  const policyPath = path.join(fixture.root, "release-policy.json");
  const releasedPolicy = readFileSync(policyPath, "utf8");
  writeJson(policyPath, {
    schemaVersion: 2,
    status: "development",
    version: "1.0.0",
    releaseTag: null,
    releaseDate: null,
    stablePublicApi: false,
    npmPublication: "disabled"
  });
  commitAll(fixture.root, "transiently reopen release policy");
  writeFileSync(policyPath, releasedPolicy);
  commitAll(fixture.root, "restore released policy");
  assert.throws(
    () => inspectFixture(fixture.root),
    /release finalization release-policy\.json may be modified exactly once/
  );
});

test("only the two exact generated aggregates may be modified", async (t) => {
  await t.test("generated index category cannot name arbitrary JSON", (child) => {
    const fixture = makeFixture(child);
    const binding = readBinding(fixture.root);
    const index = binding.evidence.find((entry) => entry.category === "generated-report-index");
    assert.ok(index);
    index.path = "public/reports/not-index.json";
    writeBinding(fixture.root, binding);
    commitAll(fixture.root, "wrong generated path");
    assert.throws(() => inspectFixture(fixture.root), /fixed generated-report-index evidence root/);
  });

  await t.test("an added file cannot claim generated-update", (child) => {
    const fixture = makeFixture(child);
    const binding = readBinding(fixture.root);
    const report = binding.evidence.find((entry) => entry.category === "featured-report");
    assert.ok(report);
    report.change = "generated-update";
    writeBinding(fixture.root, binding);
    commitAll(fixture.root, "wrong report change");
    assert.throws(() => inspectFixture(fixture.root), /must be added for featured-report/);
  });
});

test("wrong digests, traversal, symlinks, and freeze cross-binding fail before source selection", async (t) => {
  const cases: Array<{
    name: string;
    mutate: (fixture: Fixture, binding: BindingJson) => void;
    expected: RegExp;
  }> = [
    {
      name: "study digest",
      mutate: (_fixture, binding) => {
        binding.calibrationStudies[0].studySha256 = "0".repeat(64);
      },
      expected: /study digest does not match/
    },
    {
      name: "runtime digest",
      mutate: (_fixture, binding) => {
        binding.calibrationStudies[0].runtimeReceiptSha256 = "0".repeat(64);
      },
      expected: /runtime receipt digest does not match/
    },
    {
      name: "evidence digest",
      mutate: (_fixture, binding) => {
        binding.evidence[0].sha256 = "0".repeat(64);
      },
      expected: /digest does not match/
    },
    {
      name: "path traversal",
      mutate: (_fixture, binding) => {
        binding.calibrationStudies[0].studyPath =
          `calibration/${binding.calibrationStudies[0].studyId}/../escape/study.json`;
      },
      expected: /traversal|fixed calibration evidence roots/
    },
    {
      name: "symlink study",
      mutate: (fixture, binding) => {
        unlinkSync(path.join(fixture.root, ...fixture.studyPath.split("/")));
        symlinkSync("runtime-receipt.json", path.join(fixture.root, ...fixture.studyPath.split("/")));
        binding.calibrationStudies[0].studySha256 = sha256File(
          path.join(fixture.root, ...fixture.receiptPath.split("/"))
        );
      },
      expected: /regular file, never a symlink/
    },
    {
      name: "freeze candidate",
      mutate: (fixture, binding) => {
        const entry = binding.evidence.find((item) => item.category === "measurement-freeze-receipt");
        assert.ok(entry);
        const absolute = path.join(fixture.root, ...entry.path.split("/"));
        const receipt = JSON.parse(readFileSync(absolute, "utf8")) as {
          candidate: { commit: string };
        };
        receipt.candidate.commit = "f".repeat(40);
        writeJson(absolute, receipt);
        entry.sha256 = sha256File(absolute);
      },
      expected: /candidate.commit must match/
    }
  ];

  for (const row of cases) {
    await t.test(row.name, (child) => {
      const fixture = makeFixture(child);
      const binding = readBinding(fixture.root);
      row.mutate(fixture, binding);
      writeBinding(fixture.root, binding);
      commitAll(fixture.root, row.name);
      assert.throws(() => inspectFixture(fixture.root), row.expected);
    });
  }
});

test("calibration preregistration and retained raw artifacts are byte-verified", async (t) => {
  await t.test(
    "pixel complete cases require verified registered consent after reload",
    (child) => {
      const fixture = makeFixture(child, {
        unverifiedPixelConsent: true
      });
      assert.throws(
        () => inspectFixture(fixture.root),
        /must independently derive verified registered consent after reload/
      );
    }
  );

  await t.test("censored attempts are retained and digest-bound", (child) => {
    const fixture = makeFixture(child, { includeCensoredCase: true });
    const inspected = inspectFixture(fixture.root);
    assert.ok(inspected);
    assert.equal(
      inspected.calibrationStudies[0].artifacts.some(
        (artifact) =>
          artifact.caseId === "absent" && artifact.role === "attempt"
      ),
      true
    );
  });

  await t.test("raw artifact bytes cannot change behind study digest strings", (child) => {
    const fixture = makeFixture(child);
    const rawPath =
      `calibration/${fixture.studyId}/artifacts/present/prediction.json`;
    writeJson(path.join(fixture.root, ...rawPath.split("/")), {
      changed: "after-labeling"
    });
    commitAll(fixture.root, "tamper raw calibration artifact");
    assert.throws(
      () => inspectFixture(fixture.root),
      /digest does not match the retained artifact bytes/
    );
  });

  await t.test("artifact manifest cannot omit a case-required artifact", (child) => {
    const fixture = makeFixture(child);
    const manifestAbsolute = path.join(
      fixture.root,
      ...fixture.artifactManifestPath.split("/")
    );
    const manifest = JSON.parse(readFileSync(manifestAbsolute, "utf8")) as {
      artifacts: Array<{ role: string; caseId: string }>;
    };
    manifest.artifacts = manifest.artifacts.filter(
      (artifact) =>
        !(artifact.caseId === "present" && artifact.role === "label")
    );
    writeJson(manifestAbsolute, manifest);
    const receiptAbsolute = path.join(
      fixture.root,
      ...fixture.receiptPath.split("/")
    );
    const receipt = JSON.parse(readFileSync(receiptAbsolute, "utf8")) as {
      outputs: { artifactManifestSha256: string };
    };
    receipt.outputs.artifactManifestSha256 = sha256File(manifestAbsolute);
    writeJson(receiptAbsolute, receipt);
    const binding = readBinding(fixture.root);
    binding.calibrationStudies[0].artifactManifestSha256 =
      sha256File(manifestAbsolute);
    binding.calibrationStudies[0].runtimeReceiptSha256 =
      sha256File(receiptAbsolute);
    writeBinding(fixture.root, binding);
    commitAll(fixture.root, "omit retained label artifact");
    assert.throws(
      () => inspectFixture(fixture.root),
      /must enumerate every frame input, retained detector input, prediction, evidence, label, adjudication, and attempt artifact/
    );
  });

  await t.test("preregistration must predate freeze activation", (child) => {
    const fixture = makeFixture(child, {
      preregistrationDeclaredAt: "2026-08-01T00:00:00.000Z"
    });
    assert.throws(
      () => inspectFixture(fixture.root),
      /must predate measurement-freeze activation/
    );
  });

  await t.test("censoring policy semantics must match the analyzer", (child) => {
    const fixture = makeFixture(child, {
      invalidCensoringPolicy: true
    });
    assert.throws(
      () => inspectFixture(fixture.root),
      /reasons must equal the detector analyzer reasons/
    );
  });

  await t.test("candidate frame cannot substitute a planned study case", (child) => {
    const fixture = makeFixture(child, { substituteFrameCase: true });
    assert.throws(
      () => inspectFixture(fixture.root),
      /not set-equal to the study case identity and condition/
    );
  });

  await t.test("runtime receipt cannot copy a digest over forged fields", (child) => {
    const fixture = makeFixture(child);
    const receiptAbsolute = path.join(
      fixture.root,
      ...fixture.receiptPath.split("/")
    );
    const receipt = JSON.parse(readFileSync(receiptAbsolute, "utf8")) as {
      runtime: { nodeVersion: string };
    };
    receipt.runtime.nodeVersion = "99.99.99";
    writeJson(receiptAbsolute, receipt);
    const binding = readBinding(fixture.root);
    binding.calibrationStudies[0].runtimeReceiptSha256 =
      sha256File(receiptAbsolute);
    writeBinding(fixture.root, binding);
    commitAll(fixture.root, "forge runtime receipt fields");
    assert.throws(
      () => inspectFixture(fixture.root),
      /runtimeDigest must be derived from its independently recorded runtime fields/
    );
  });

  for (const row of [
    {
      name: "runtime receipt cannot substitute a different controlled runner",
      mutate: (receipt: {
        acquisition: {
          runner: { labelSha256: string };
          egress: { identity: string };
        };
      }) => {
        receipt.acquisition.runner.labelSha256 = digest("different-runner");
      },
      expected: /runner must bind the freeze-selected/
    },
    {
      name: "runtime receipt cannot substitute a different egress",
      mutate: (receipt: {
        acquisition: {
          runner: { labelSha256: string };
          egress: { identity: string };
        };
      }) => {
        receipt.acquisition.egress.identity = "different-egress";
      },
      expected: /egress must bind the freeze-selected/
    }
  ]) {
    await t.test(row.name, (child) => {
      const fixture = makeFixture(child);
      const receiptAbsolute = path.join(
        fixture.root,
        ...fixture.receiptPath.split("/")
      );
      const receipt = JSON.parse(
        readFileSync(receiptAbsolute, "utf8")
      ) as {
        acquisition: {
          runner: { labelSha256: string };
          egress: { identity: string };
        };
      };
      row.mutate(receipt);
      writeJson(receiptAbsolute, receipt);
      const binding = readBinding(fixture.root);
      binding.calibrationStudies[0].runtimeReceiptSha256 =
        sha256File(receiptAbsolute);
      writeBinding(fixture.root, binding);
      commitAll(fixture.root, row.name);
      assert.throws(() => inspectFixture(fixture.root), row.expected);
    });
  }

  await t.test("runtime receipt cannot claim a future acquisition time", (child) => {
    const fixture = makeFixture(child, {
      runtimeRecordedAt: "2099-01-01T00:00:00.000Z"
    });
    assert.throws(
      () => inspectFixture(fixture.root),
      /recordedAt must not postdate its introducing commit/
    );
  });
});

test("non-ancestor, wrong tree, wrong repository, and attestation self-claims fail closed", async (t) => {
  await t.test("non-ancestor", (child) => {
    const fixture = makeFixture(child);
    const sibling = git(fixture.root, ["commit-tree", fixture.candidateTree, "-m", "unrelated"]).trim();
    const binding = readBinding(fixture.root);
    rewriteCandidate(fixture.root, binding, sibling, fixture.candidateTree);
    commitAll(fixture.root, "non-ancestor");
    assert.throws(
      () => inspectFixture(fixture.root),
      /ordered pre-candidate history|must be an ancestor/
    );
  });

  const mutations: Array<{
    name: string;
    mutate: (binding: BindingJson) => void;
    expected: RegExp;
  }> = [
    {
      name: "wrong tree",
      mutate: (binding) => {
        binding.candidateTree = "a".repeat(40);
      },
      expected: /tree does not match/
    },
    {
      name: "wrong repository",
      mutate: (binding) => {
        binding.repository = "attacker/example";
      },
      expected: /repository must be/
    },
    {
      name: "wrong target",
      mutate: (binding) => {
        binding.targetRelease = "9.9.9";
      },
      expected: /targetRelease must be/
    },
    {
      name: "self-claimed verified",
      mutate: (binding) => {
        binding.attestationPolicy.status = "verified";
      },
      expected: /required-external-verification/
    },
    {
      name: "wrong signer",
      mutate: (binding) => {
        binding.attestationPolicy.signerWorkflow = "attacker/repo/.github/workflows/ci.yml";
      },
      expected: /signerWorkflow must be/
    }
  ];
  for (const row of mutations) {
    await t.test(row.name, (child) => {
      const fixture = makeFixture(child);
      const binding = readBinding(fixture.root);
      row.mutate(binding);
      writeBinding(fixture.root, binding);
      commitAll(fixture.root, row.name);
      assert.throws(() => inspectFixture(fixture.root), row.expected);
    });
  }
});

test("a present binding refuses a dirty host worktree", (t) => {
  const fixture = makeFixture(t);
  writeFileSync(path.join(fixture.root, "untracked.txt"), "not committed\n");
  assert.throws(() => inspectFixture(fixture.root), /clean worktree/);
});

function makeFixture(
  t: TestContext,
  options: {
    includeBinding?: boolean;
    includeCensoredCase?: boolean;
    preregistrationDeclaredAt?: string;
    invalidCensoringPolicy?: boolean;
    substituteFrameCase?: boolean;
    runtimeRecordedAt?: string;
    includeCalibrationStudy?: boolean;
    calibrationPolicyDecisionStatus?: "approved" | "pending";
    calibrationPolicyDecisionSelected?: string;
    calibrationPolicyDecisionArtifactSha256?: string;
    extraDurableTransitionChange?: boolean;
    shortDurableSoak?: boolean;
    adequateCalibrationStudy?: boolean;
    unverifiedPixelConsent?: boolean;
  } = {}
): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-measurement-binding-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Measurement Binding Test"]);
  git(root, ["config", "user.email", "measurement-binding@example.invalid"]);
  mkdirSync(path.join(root, "lib"), { recursive: true });
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(path.join(root, "public", "reports"), { recursive: true });
  writeFileSync(path.join(root, "lib", "detector.ts"), "frozen detector code\n");
  writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeJson(path.join(root, "public", "featured-sites.json"), []);
  writeJson(
    path.join(
      root,
      "research",
      "ops-receipts",
      "featured-readjudication.json"
    ),
    { kind: "site-behavior-featured-readjudication", cycles: [] }
  );
  writeJson(path.join(root, "public", "reports", "index.json"), { reports: [] });
  writeJson(path.join(root, "public", "corpus-stats.json"), { total: 0 });
  writeJson(path.join(root, "research", "ops-receipts", "r2-lifecycle-readback.json"), {
    recordedAt: "2026-07-31T00:00:00.000Z"
  });
  writeJson(path.join(root, "package.json"), { name: "fixture", version: "1.0.0" });
  writeJson(path.join(root, "package-lock.json"), {
    name: "fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.0.0" } }
  });
  writeFileSync(
    path.join(root, "LICENSE"),
    "Fixture license evidence.\n"
  );
  writeFileSync(
    path.join(root, "LEGAL-NOTICE"),
    "Additional fixture legal evidence.\n"
  );
  writeJson(
    path.join(root, MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH),
    {
      schemaVersion: 1,
      artifactKind:
        "site-behavior-container-image-package-review-ledger",
      inventoryPackageSetDigest: "3".repeat(64),
      notice: "Fixture package review ledger.",
      reviews: [
        {
          key: "os:deb:fixture@1.0#amd64",
          inventoryEvidenceDigest: "4".repeat(64),
          status: "unreviewed",
          determinedLicense: null,
          licenseEvidenceRefs: [],
          obligations: [],
          reviewer: null,
          reviewedAt: null,
          notes: null
        }
      ]
    }
  );
  writeJson(path.join(root, "release-policy.json"), {
    schemaVersion: 2,
    status: "development",
    version: "1.0.0",
    releaseTag: null,
    releaseDate: null,
    stablePublicApi: false,
    npmPublication: "disabled"
  });
  writeFileSync(
    path.join(root, "CITATION.cff"),
    'cff-version: 1.2.0\ntitle: "Site Behavior Lab"\nversion: "1.0.0"\n'
  );
  writeFileSync(
    path.join(root, "CHANGELOG.md"),
    "# Changelog\n\n## Unreleased\n\n## [1.0.0] - UNRELEASED\n\nFinal release notes.\n"
  );
  writeFileSync(path.join(root, "RELEASE.md"), "candidate policy\n");
  writeFileSync(path.join(root, "README.md"), "candidate source\n");
  writeFileSync(
    path.join(root, "Dockerfile"),
    `FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07 AS playwright-base
RUN test "$(node --version)" = "v24.18.0"
`
  );
  writeFileSync(
    path.join(root, "wrangler.container.jsonc"),
    '{\n  "vars": {\n    "SITE_BEHAVIOR_LAB_DURABLE_JOBS": "0"\n  }\n}\n'
  );

  const studyId = "pixel-events-final-candidate";
  const preregistrationPath = `calibration/${studyId}/preregistration.json`;
  const samplingFramePath = `calibration/${studyId}/frame.json`;
  const censoringPolicyPath = MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH;
  const studyPath = `calibration/${studyId}/study.json`;
  const analysisPath = `calibration/${studyId}/analysis.json`;
  const receiptPath = `calibration/${studyId}/runtime-receipt.json`;
  const receiptBundlePath =
    `calibration/${studyId}/runtime-receipt.sigstore.json`;
  const artifactManifestPath = `calibration/${studyId}/artifact-manifest.json`;
  const labelsManifestPath = `calibration/${studyId}/labels-manifest.json`;
  const labelSealingPublicKeyPath =
    `calibration/${studyId}/label-sealing-public-key.pem`;
  const labelSealingKey = {
    algorithm: "rsa-oaep-sha256+a256gcm",
    keyId: CALIBRATION_LABEL_KEY_ID,
    publicKeyPath: labelSealingPublicKeyPath,
    publicKeySha256: sha256Hex(CALIBRATION_LABEL_PUBLIC_KEY_PEM)
  };
  mkdirSync(
    path.dirname(path.join(root, ...labelSealingPublicKeyPath.split("/"))),
    { recursive: true }
  );
  writeFileSync(
    path.join(root, ...labelSealingPublicKeyPath.split("/")),
    CALIBRATION_LABEL_PUBLIC_KEY_PEM
  );
  const calibrationFrameCases =
    options.adequateCalibrationStudy === true
      ? [
          ...Array.from({ length: 100 }, (_, index) => {
            const caseId = `absent-${String(index).padStart(3, "0")}`;
            return {
              caseId,
              selectionDigest: calibrationSelectionDigest(studyId, caseId),
              conditionDigest: calibrationConditionDigest(studyId, caseId),
              referenceEvidenceDigest:
                calibrationReferenceEvidenceDigest(studyId, caseId)
            };
          }),
          ...Array.from({ length: 100 }, (_, index) => {
            const caseId = `present-${String(index).padStart(3, "0")}`;
            return {
              caseId,
              selectionDigest: calibrationSelectionDigest(studyId, caseId),
              conditionDigest: calibrationConditionDigest(studyId, caseId),
              referenceEvidenceDigest:
                calibrationReferenceEvidenceDigest(studyId, caseId)
            };
          })
        ]
      : [
          {
            caseId: options.substituteFrameCase ? "substituted" : "absent",
            selectionDigest: calibrationSelectionDigest(studyId, "absent"),
            conditionDigest: calibrationConditionDigest(studyId, "absent"),
            referenceEvidenceDigest:
              calibrationReferenceEvidenceDigest(studyId, "absent")
          },
          {
            caseId: "present",
            selectionDigest: calibrationSelectionDigest(studyId, "present"),
            conditionDigest: calibrationConditionDigest(studyId, "present"),
            referenceEvidenceDigest:
              calibrationReferenceEvidenceDigest(studyId, "present")
          }
        ];
  writeJson(path.join(root, ...samplingFramePath.split("/")), {
    schemaVersion: 2,
    artifactKind: "site-behavior-detector-calibration-sampling-frame",
    studyId,
    detector: "pixel-events",
    selectionProtocolDigest: digest(
      "Select cases before detector output."
    ),
    measurementCondition:
      detectorCalibrationMeasurementCondition("pixel-events"),
    labelSealingKey,
    cases: calibrationFrameCases
  });
  const design = calibrationDesign(
    samplingFramePath,
    sha256File(path.join(root, ...samplingFramePath.split("/"))),
    options.adequateCalibrationStudy === true
  );
  writeJson(path.join(root, ...censoringPolicyPath.split("/")), {
    schemaVersion: 2,
    artifactKind: "site-behavior-detector-calibration-censoring-policy",
    id: MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
    allowedReasons: [
      "capture-failed",
      "reference-label-uncertain",
      "artifact-unreadable",
      options.invalidCensoringPolicy
        ? "not-an-analyzer-reason"
        : "eligibility-criteria-not-met"
    ],
    releaseEligibility: {
      anyCensoredCase: "study-ineligible",
      plannedDenominator: "must-remain-complete"
    },
    ratePublicationEligibility: {
      sampling: "simple-random",
      independentUnits: true,
      predictionBlindedToReference: true,
      referenceBlindedToPrediction: true,
      minimumDenominators: {
        referencePresent: 100,
        referenceAbsent: 100,
        predictedDetected: 100,
        predictedNotDetected: 100
      },
      uncertainty: {
        method: "wilson-score",
        confidenceLevel: 0.95,
        maximumWorstCaseHalfWidth: 0.1
      },
      performanceThreshold: null
    }
  });
  const censoringPolicySha256 = sha256File(
    path.join(root, ...censoringPolicyPath.split("/"))
  );
  const censoringDispositionSha256 =
    measurementCalibrationPolicyDispositionSha256({
      id: MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
      policyArtifactPath: censoringPolicyPath,
      policyArtifactSha256:
        options.calibrationPolicyDecisionArtifactSha256 ??
        censoringPolicySha256,
      anyCensoredCase: "study-ineligible",
      plannedDenominator: "must-remain-complete"
    });
  writeJson(path.join(root, "RELEASE_READINESS.json"), {
    artifactKind: "site-behavior-release-readiness-manifest",
    targetRelease: "1.0.0",
    decisions: {
      calibrationCensoringPolicy: {
        currentlySupportedSelections: [
          MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID
        ],
        recommendedDisposition: "human-decision-required-before-labeling",
        methodologicalAssessment:
          "The currently supported zero-censor analyzer policy is near-unsatisfiable and is not a methodological recommendation.",
        selected:
          options.calibrationPolicyDecisionSelected ??
          MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
        policyArtifactPath: censoringPolicyPath,
        policyArtifactSha256:
          options.calibrationPolicyDecisionArtifactSha256 ??
          censoringPolicySha256,
        dispositionSha256: censoringDispositionSha256,
        note:
          "The currently supported zero-censor analyzer policy is explicitly accepted for this fixture.",
        status: options.calibrationPolicyDecisionStatus ?? "approved",
        decidedBy:
          options.calibrationPolicyDecisionStatus === "pending"
            ? null
            : "Measurement Binding Test",
        decidedAt:
          options.calibrationPolicyDecisionStatus === "pending"
            ? null
            : "2026-07-31T22:00:00.000Z"
      }
    },
    gates: {}
  });
  writeJson(path.join(root, ...preregistrationPath.split("/")), {
    schemaVersion: 2,
    artifactKind: "site-behavior-detector-calibration-preregistration",
    studyId,
    detector: "pixel-events",
    declaredAt:
      options.preregistrationDeclaredAt ?? "2026-07-31T23:00:00.000Z",
    targetPopulation:
      "Consent-accepted, GPC-disabled visits in the frozen final-candidate calibration frame.",
    plannedCases: calibrationFrameCases.length,
    censoringPolicy: {
      id: MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
      path: censoringPolicyPath,
      sha256: sha256File(path.join(root, ...censoringPolicyPath.split("/")))
    },
    design
  });
  const aaPreregistrationPath =
    "research/aa-studies/final-repeatability/preregistration.json";
  const aaTargetFramePath =
    "research/aa-studies/final-repeatability/target-frame.json";
  const releaseIdentity = currentDetectorCalibrationReleaseIdentity(
    "pixel-events",
    "a".repeat(40),
    runtimeIdentity()
  );
  writeJson(path.join(root, ...MEASUREMENT_IDENTITY_PATH.split("/")), {
    schemaVersion: 1,
    artifactKind: MEASUREMENT_IDENTITY_KIND,
    implementation: {
      detectorRegistryVersion: releaseIdentity.registryVersion,
      detectorRegistryDigest: releaseIdentity.registryDigest,
      methodologyVersion: releaseIdentity.methodologyVersion,
      normalizationVersion: releaseIdentity.normalizationVersion
    },
    catalogs: {
      trackerCatalogVersion: releaseIdentity.trackerCatalog.version,
      trackerCatalogDigest: releaseIdentity.trackerCatalog.digest,
      trackerCatalogProvenanceVersion:
        releaseIdentity.trackerCatalog.provenanceVersion,
      trackerCatalogProvenanceDigest:
        releaseIdentity.trackerCatalog.provenanceDigest,
      braveCatalogCommit: releaseIdentity.braveLists.catalogCommit,
      braveCatalogDigest: releaseIdentity.braveLists.catalogDigest,
      braveManifestDigest: releaseIdentity.braveLists.manifestDigest,
      braveRulesDigest: releaseIdentity.braveLists.rulesDigest,
      braveEngineVersion: releaseIdentity.braveLists.engineVersion
    },
    toolchain: {
      nodeVersion: releaseIdentity.runtime.nodeVersion,
      playwrightVersion: releaseIdentity.runtime.playwrightVersion,
      containerBaseImageDigest:
        "sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07",
      containerNodeVersion: "24.18.0"
    }
  });
  const measurementIdentityDigest = sha256File(
    path.join(root, ...MEASUREMENT_IDENTITY_PATH.split("/"))
  );
  writeJson(path.join(root, ...aaTargetFramePath.split("/")), [
    { targetId: "example-com", url: "https://example.com/" }
  ]);
  writeJson(path.join(root, ...aaPreregistrationPath.split("/")), {
    schemaVersion: 2,
    studyId: "final-repeatability",
    declaredAt: "2026-07-31T23:15:00.000Z",
    measurementIdentityManifestPath: MEASUREMENT_IDENTITY_PATH,
    measurementIdentityDigest,
    sitesFile: aaTargetFramePath,
    sitesFileDigest: sha256File(
      path.join(root, ...aaTargetFramePath.split("/"))
    )
  });
  const candidateInputPaths = [
    preregistrationPath,
    samplingFramePath,
    labelSealingPublicKeyPath,
    censoringPolicyPath,
    MEASUREMENT_IDENTITY_PATH,
    aaPreregistrationPath,
    aaTargetFramePath
  ].sort();
  writeJson(path.join(root, ...MEASUREMENT_CANDIDATE_INPUTS_PATH.split("/")), {
    schemaVersion: 1,
    artifactKind: MEASUREMENT_CANDIDATE_INPUTS_KIND,
    inputs: candidateInputPaths.map((inputPath) => ({
      path: inputPath,
      sha256: sha256File(path.join(root, ...inputPath.split("/")))
    }))
  });
  commitAll(root, "pre-enable durable replay deployment");
  const replayDeploymentCommit = git(root, ["rev-parse", "HEAD"]).trim();
  writeFileSync(
    path.join(root, "wrangler.container.jsonc"),
    '{\n  "vars": {\n    "SITE_BEHAVIOR_LAB_DURABLE_JOBS": "1"\n  }\n}\n'
  );
  if (options.extraDurableTransitionChange === true) {
    writeFileSync(
      path.join(root, "README.md"),
      "candidate source\nunrelated transition change\n"
    );
  }
  commitAll(root, "governed durable enable transition");
  const transitionCommit = git(root, ["rev-parse", "HEAD"]).trim();
  createDurablePrerequisiteEvidence(
    root,
    replayDeploymentCommit,
    transitionCommit,
    options.shortDurableSoak === true
  );
  commitAll(root, "archive pre-candidate durable operations evidence");
  writeFileSync(
    path.join(root, "README.md"),
    "candidate source\nmeasurement candidate selected after durable soak\n"
  );
  commitAll(root, "frozen measurement candidate");
  const candidate = git(root, ["rev-parse", "HEAD"]).trim();
  const candidateTree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const evidence =
    options.includeBinding !== false ? createEvidence(root, candidate) : [];

  const runtime = runtimeIdentity();
  const studyValue = study(
    candidate,
    runtime,
    studyId,
    design,
    options.includeCensoredCase === true,
    options.adequateCalibrationStudy === true
  );
  if (options.includeCalibrationStudy !== false) {
    createCalibrationArtifacts(
      root,
      studyValue,
      artifactManifestPath,
      options.unverifiedPixelConsent === true
    );
    createCalibrationLabelsManifest(
      root,
      studyValue,
      artifactManifestPath,
      labelsManifestPath,
      candidate,
      candidateTree
    );
    writeJson(path.join(root, ...studyPath.split("/")), studyValue);
    writeJson(
      path.join(root, ...analysisPath.split("/")),
      analyzeDetectorCalibrationStudy(studyValue, {
        expectedBuildCommit: candidate,
        expectedRuntimeDigest: runtime.runtimeDigest
      })
    );
    const calibrationDecision = (
      JSON.parse(
        readFileSync(path.join(root, "RELEASE_READINESS.json"), "utf8")
      ) as {
        decisions: {
          calibrationCensoringPolicy: {
            selected: string;
            policyArtifactPath: string;
            policyArtifactSha256: string;
            dispositionSha256: string;
            decidedBy: string;
            decidedAt: string;
          };
        };
      }
    ).decisions.calibrationCensoringPolicy;
    const freezePath =
      "research/ops-receipts/measurement-freeze-activation.json";
    const labelsManifest = JSON.parse(
      readFileSync(
        path.join(root, ...labelsManifestPath.split("/")),
        "utf8"
      )
    ) as {
      source: { sha256: string };
      labelSealingKey: {
        algorithm: string;
        keyId: string;
        publicKeyPath: string;
        publicKeySha256: string;
      };
      commitmentSetSha256: string;
      recordedFrom: string;
      recordedThrough: string;
    };
    writeJson(path.join(root, ...receiptPath.split("/")), {
      schemaVersion: 3,
      artifactKind: "site-behavior-detector-calibration-runtime-receipt",
      studyId,
      detector: "pixel-events",
      candidateCommit: candidate,
      producerCommit: candidate,
      policy: {
        id: calibrationDecision.selected,
        path: calibrationDecision.policyArtifactPath,
        sha256: calibrationDecision.policyArtifactSha256,
        dispositionSha256: calibrationDecision.dispositionSha256,
        decidedBy: calibrationDecision.decidedBy,
        decidedAt: calibrationDecision.decidedAt
      },
      freeze: {
        receiptPath: freezePath,
        receiptSha256:
          options.includeBinding === false
            ? digest("fixture-freeze-receipt")
            : sha256File(path.join(root, ...freezePath.split("/"))),
        activatedAt: "2026-08-01T00:00:00.000Z"
      },
      acquisition: {
        repository: "iAnonymous3000/site-behavior-lab",
        workflowPath: ".github/workflows/calibration-study.yml",
        workflowRef: "refs/heads/main",
        runId: 30600000002,
        runAttempt: 1,
        event: "workflow_dispatch",
        headBranch: "main",
        headSha: candidate,
        runStartedAt: "2026-08-01T00:04:00.000Z",
        runCompletedAt: "2026-08-01T00:10:00.000Z",
        job: {
          id: 30600000022,
          startedAt: "2026-08-01T00:05:00.000Z",
          completedAt: "2026-08-01T00:09:00.000Z",
          runnerNameSha256: digest("controlled-runner-name")
        },
        startedAt: "2026-08-01T00:05:00.000Z",
        completedAt: "2026-08-01T00:07:00.000Z",
        runner: {
          labelSha256: digest("controlled-calibration-runner"),
          identitySha256: digest("ephemeral-calibration-runner-1"),
          environment: "ephemeral-self-hosted"
        },
        egress: {
          identity: "controlled-self-hosted",
          regionSha256: digest("us-west")
        }
      },
      artifact: {
        id: 30600000102,
        name: `site-behavior-calibration-${studyId}-30600000002-1`,
        archiveSha256: digest("calibration-artifact-archive"),
        bytes: 123456,
        createdAt: "2026-08-01T00:08:00.000Z",
        expiresAt: "2026-08-31T00:08:00.000Z"
      },
      labels: {
        commit: candidate,
        tree: candidateTree,
        path: `calibration-labels/${studyId}`,
        sourceSha256: labelsManifest.source.sha256,
        manifestPath: labelsManifestPath,
        manifestSha256: sha256File(
          path.join(root, ...labelsManifestPath.split("/"))
        ),
        labelSealingKey: labelsManifest.labelSealingKey,
        commitmentSetSha256: labelsManifest.commitmentSetSha256,
        recordedFrom: labelsManifest.recordedFrom,
        recordedThrough: labelsManifest.recordedThrough
      },
      inputs: {
        preregistrationSha256: sha256File(
          path.join(root, ...preregistrationPath.split("/"))
        ),
        samplingFrameSha256: sha256File(
          path.join(root, ...samplingFramePath.split("/"))
        ),
        labelSealingPublicKeySha256:
          labelsManifest.labelSealingKey.publicKeySha256,
        measurementConditionSha256: canonicalJsonDigest(
          detectorCalibrationMeasurementCondition("pixel-events")
        ),
        acquisitionManifestSha256: digest("fixture-acquisition-manifest")
      },
      outputs: {
        studySha256: sha256File(path.join(root, ...studyPath.split("/"))),
        artifactManifestSha256: sha256File(
          path.join(root, ...artifactManifestPath.split("/"))
        ),
        analysisSha256: sha256File(
          path.join(root, ...analysisPath.split("/"))
        ),
        labelsManifestSha256: sha256File(
          path.join(root, ...labelsManifestPath.split("/"))
        )
      },
      runtime,
      assembledAt:
        options.runtimeRecordedAt ?? "2026-08-01T00:12:00.000Z"
    });
    writeJson(
      path.join(root, ...receiptBundlePath.split("/")),
      { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" }
    );
  }

  if (options.includeBinding !== false) {
    const fixtureLicenseSha256 = sha256File(path.join(root, "LICENSE"));
    writeJson(
      path.join(root, MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH),
      {
        schemaVersion: 1,
        artifactKind:
          "site-behavior-container-image-package-review-ledger",
        inventoryPackageSetDigest: "3".repeat(64),
        notice: "Fixture package review ledger.",
        reviews: [
          {
            key: "os:deb:fixture@1.0#amd64",
            inventoryEvidenceDigest: "4".repeat(64),
            status: "reviewed",
            determinedLicense: "MIT",
            licenseEvidenceRefs: [
              `repo:LICENSE#sha256=${fixtureLicenseSha256}`
            ],
            obligations: [],
            reviewer: "Fixture Reviewer",
            reviewedAt: "2026-07-31",
            notes: "Fixture-only legal determination."
          }
        ]
      }
    );
    const sourceManifest = {
      schemaVersion: 1,
      evidenceKind: "exact-source-and-tested-artifact-manifest",
      release: { repository: "https://github.com/iAnonymous3000/site-behavior-lab" },
      source: { commit: candidate, tree: candidateTree },
      artifacts: [
        {
          name: "container-image",
          kind: "docker-image-inspection",
          sourceCommit: candidate,
          imageId: `sha256:${"1".repeat(64)}`,
          os: "linux",
          architecture: "amd64",
          rootfsLayers: [`sha256:${"2".repeat(64)}`],
          runtime: {
            node: "24.18.0",
            npm: "absent",
            probeIsolation: {
              pull: "never",
              network: "none",
              rootFilesystem: "read-only",
              capabilities: "all-dropped",
              noNewPrivileges: true
            }
          }
        }
      ]
    };
    writeJson(path.join(root, ...MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH.split("/")), sourceManifest);
    writeJson(path.join(root, ...MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH.split("/")), {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3"
    });
    writeJson(path.join(root, ...MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH.split("/")), {
      schemaVersion: 1,
      artifactKind: "site-behavior-container-image-package-inventory",
      source: { commit: candidate },
      image: {
        id: `sha256:${"1".repeat(64)}`,
        digest: "1".repeat(64),
        os: "linux",
        architecture: "amd64",
        rootfsLayers: [`sha256:${"2".repeat(64)}`]
      },
      scanner: {
        name: "trivy",
        version: "0.70.0",
        reportSchemaVersion: 2,
        scope: "os-packages",
        licenseMode: "standard"
      },
      summary: {
        packageCount: 1,
        packagesWithDetectedLicenses: 1,
        packagesWithoutDetectedLicenses: 0,
        classifiedLicenseFindingCount: 1
      },
      packageSetDigest: "3".repeat(64),
      packages: [
        {
          key: "os:deb:fixture@1.0#amd64",
          packageType: "deb",
          name: "fixture",
          version: "1.0",
          architecture: "amd64",
          sourceName: null,
          sourceVersion: null,
          detectedLicenses: ["MIT"],
          evidenceDigest: "4".repeat(64)
        }
      ]
    });
    writeJson(
      path.join(root, ...MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH.split("/")),
      { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3" }
    );
    writeBinding(
      root,
      bindingJson(
        root,
        candidate,
        candidateTree,
        studyId,
        preregistrationPath,
        samplingFramePath,
        studyPath,
        analysisPath,
        receiptPath,
        receiptBundlePath,
        artifactManifestPath,
        evidence,
        options.includeCalibrationStudy !== false
      )
    );
  }

  commitAll(root, options.includeBinding === false ? "unbound study evidence" : "bound release evidence");
  return {
    root,
    candidate,
    candidateTree,
    replayDeploymentCommit,
    transitionCommit,
    carrier: git(root, ["rev-parse", "HEAD"]).trim(),
    studyId,
    preregistrationPath,
    samplingFramePath,
    studyPath,
    analysisPath,
    receiptPath,
    receiptBundlePath,
    artifactManifestPath
  };
}

function createDurablePrerequisiteEvidence(
  root: string,
  replayDeploymentCommit: string,
  transitionCommit: string,
  shortSoak: boolean = false
): void {
  const replayRoot = "research/ops-receipts/durable-replay";
  const origin = {
    label: "durable-replay-staging",
    sha256: digest("durable-replay-staging-origin")
  };
  const replayReceipts = [
    {
      kind: "site-behavior-durable-replay-receipt",
      receiptVersion: 1,
      recordedAt: "2026-07-28T01:00:00.000Z",
      mode: "lease-expiry",
      expectedDeploymentSha: replayDeploymentCommit,
      origin,
      timing: { startedAt: "2026-07-28T00:00:00.000Z" },
      receiptDigest: digest("lease-expiry-receipt")
    },
    {
      kind: "site-behavior-durable-replay-receipt",
      receiptVersion: 1,
      recordedAt: "2026-07-28T03:00:00.000Z",
      mode: "lost-resolve",
      expectedDeploymentSha: replayDeploymentCommit,
      origin,
      timing: { startedAt: "2026-07-28T02:00:00.000Z" },
      receiptDigest: digest("lost-resolve-receipt")
    }
  ] as const;
  for (const receipt of replayReceipts) {
    writeJson(
      path.join(
        root,
        replayRoot,
        `${replayDeploymentCommit}-${receipt.mode}.json`
      ),
      receipt
    );
  }
  const replayReceiptSetDigest = createHash("sha256")
    .update(
      canonicalTestJson({
        kind: "site-behavior-durable-replay-receipt-set",
        receiptSetVersion: 1,
        expectedDeploymentSha: replayDeploymentCommit,
        origin,
        receipts: replayReceipts.map((receipt) => ({
          mode: receipt.mode,
          receiptDigest: receipt.receiptDigest
        }))
      })
    )
    .digest("hex");
  writeJson(
    path.join(
      root,
      "research",
      "ops-evidence",
      "staging-teardown.json"
    ),
    {
      schemaVersion: 1,
      artifactKind: "site-behavior-staging-teardown-session-receipt",
      stagingSourceCommit: replayDeploymentCommit,
      recordedAt: "2026-07-28T04:00:00.000Z",
      session: {},
      inventory: {},
      teardownInventoryDigest: digest("staging-teardown-inventory")
    }
  );
  const deploymentDigest = digest("production-durable-deployment");
  const transitionPath = path.join(
    root,
    "research",
    "ops-receipts",
    "durable-enable-transition.json"
  );
  writeJson(transitionPath, {
    schemaVersion: 1,
    artifactKind: "site-behavior-durable-enable-transition",
    transition: {
      configPath: "wrangler.container.jsonc",
      fromCommit: replayDeploymentCommit,
      toCommit: transitionCommit
    },
    replay: {
      deploymentCommit: replayDeploymentCommit,
      receiptSetDigest: replayReceiptSetDigest,
      evidenceStartedAt: "2026-07-28T00:00:00.000Z",
      evidenceCapturedAt: "2026-07-28T03:00:00.000Z"
    },
    secrets: {
      checkedAt: "2026-07-28T05:00:00.000Z",
      durableJobsKeyPresent: true,
      durableJobsInternalTokenPresent: true,
      valuesRecorded: false
    },
    changeControl: {
      pullRequestUrl:
        "https://github.com/iAnonymous3000/site-behavior-lab/pull/100",
      mergeCommit: transitionCommit,
      mergedAt: "2026-07-28T06:00:00.000Z"
    },
    ci: {
      workflow:
        "iAnonymous3000/site-behavior-lab/.github/workflows/ci.yml@refs/heads/main",
      runId: "30600000004",
      runAttempt: 1,
      headCommit: transitionCommit,
      conclusion: "success",
      completedAt: "2026-07-28T07:00:00.000Z"
    },
    promotion: {
      workflow:
        "iAnonymous3000/site-behavior-lab/.github/workflows/promote-production.yml@refs/heads/main",
      runId: "30600000005",
      runAttempt: 1,
      productionCommit: transitionCommit,
      deploymentDigest,
      convergedAt: "2026-07-28T08:00:00.000Z"
    },
    productionHealth: {
      workflow:
        "iAnonymous3000/site-behavior-lab/.github/workflows/production-health.yml@refs/heads/main",
      runId: "30600000006",
      runAttempt: 1,
      headCommit: transitionCommit,
      status: "ok",
      warningCount: 0,
      durableJobs: {
        requested: true,
        enabled: true,
        readiness: "ready"
      },
      observedAt: "2026-07-28T09:00:00.000Z"
    },
    recordedAt: "2026-07-28T10:00:00.000Z"
  });
  const transitionReceiptSha256 = sha256File(transitionPath);
  writeJson(
    path.join(
      root,
      "research",
      "ops-receipts",
      "durable-soak-attestation.json"
    ),
    {
      kind: "site-behavior-operator-attestation",
      gateId: "durable-soak",
      targetRelease: "1.0.0",
      attestedBy: "Measurement Binding Test",
      attestedAt: "2026-07-29T12:00:00.000Z",
      evidenceCapturedAt: "2026-07-29T11:00:00.000Z",
      bindings: {
        replayDeploymentCommit,
        soakDeploymentCommit: transitionCommit,
        durableConfigDigest: sha256File(
          path.join(root, "wrangler.container.jsonc")
        ),
        durableEnableReceiptDigest: transitionReceiptSha256,
        replayReceiptsDigest: replayReceiptSetDigest,
        deploymentDigest,
        ledgerSha256: "9".repeat(64)
      },
      statements: [
        {
          claimId: "lease-expiry-replay-passed",
          claim:
            "The lease-expiry replay canary passed against the bound pre-enable deployment.",
          true: true
        },
        {
          claimId: "lost-resolve-replay-passed",
          claim:
            "The lost-resolve replay canary passed against the bound pre-enable deployment.",
          true: true
        },
        {
          claimId: "durable-hourly-health-observed",
          claim:
            "Every authenticated hourly deep-health sample in the bound soak window observed durable jobs enabled and ready on the exact production deployment; no sample gap exceeded 90 minutes.",
          true: true
        },
        {
          claimId: "real-restart-observed",
          claim:
            "A real runtime restart occurred inside the soak window, and the queued job recovered on a second fenced attempt to one authenticated report identity and readback.",
          true: true
        },
        {
          claimId: "durable-behavior-exercises-observed",
          claim:
            "An authenticated production exercise run inside the soak window proved normal completion, cancellation, completed-report recovery, and duplicate prevention on the bound durable deployment.",
          true: true
        }
      ],
      evidenceRefs: [
        `github-actions-run:101:artifact-sha256:${"1".repeat(64)}`,
        `github-actions-run:102:artifact-sha256:${"2".repeat(64)}`,
        `github-actions-run:103:artifact-sha256:${"3".repeat(64)}`
      ],
      evidenceWindow: {
        startedAt: "2026-07-28T11:00:00.000Z",
        restartObservedAt: "2026-07-28T12:00:00.000Z",
        endedAt: shortSoak
          ? "2026-07-28T22:00:00.000Z"
          : "2026-07-29T11:00:00.000Z"
      }
    }
  );
}

function durablePrerequisiteBinding(
  root: string,
  candidateCommit: string
): BindingJson["durablePrerequisite"] {
  const transitionPath =
    "research/ops-receipts/durable-enable-transition.json";
  const transition = JSON.parse(
    readFileSync(path.join(root, ...transitionPath.split("/")), "utf8")
  ) as {
    transition: { fromCommit: string; toCommit: string };
    replay: {
      deploymentCommit: string;
      receiptSetDigest: string;
      evidenceStartedAt: string;
      evidenceCapturedAt: string;
    };
  };
  const modes = ["lease-expiry", "lost-resolve"] as const;
  return {
    config: {
      path: "wrangler.container.jsonc",
      sha256: sha256File(path.join(root, "wrangler.container.jsonc"))
    },
    replay: {
      ...transition.replay,
      receipts: modes.map((mode) => {
        const receiptPath =
          `research/ops-receipts/durable-replay/${transition.replay.deploymentCommit}-${mode}.json`;
        return {
          mode,
          path: receiptPath,
          sha256: sha256File(path.join(root, ...receiptPath.split("/")))
        };
      })
    },
    stagingTeardown: {
      evidencePath: "research/ops-evidence/staging-teardown.json",
      evidenceSha256: sha256File(
        path.join(
          root,
          "research",
          "ops-evidence",
          "staging-teardown.json"
        )
      )
    },
    transition: {
      receiptPath: transitionPath,
      receiptSha256: sha256File(
        path.join(root, ...transitionPath.split("/"))
      )
    },
    soak: {
      attestationPath:
        "research/ops-receipts/durable-soak-attestation.json",
      attestationSha256: sha256File(
        path.join(
          root,
          "research",
          "ops-receipts",
          "durable-soak-attestation.json"
        )
      ),
      targetDeviationApproval: {
        status: "approved",
        approverType: "named-human",
        approvedBy: "Measurement Binding Test Reviewer",
        approvedAt: new Date(
          git(root, [
            "show",
            "-s",
            "--format=%cI",
            candidateCommit
          ]).trim()
        ).toISOString(),
        reason:
          "Fixture approval for the exact 24-hour minimum soak below the reviewed 168-hour target.",
        candidateCommit,
        soakDeploymentCommit: transition.transition.toCommit,
        ledgerSha256: "9".repeat(64),
        evidenceWindow: {
          startedAt: "2026-07-28T11:00:00.000Z",
          restartObservedAt: "2026-07-28T12:00:00.000Z",
          endedAt: "2026-07-29T11:00:00.000Z"
        },
        minimumEvidenceHours: 24,
        targetEvidenceHours: 168
      }
    }
  };
}

function canonicalTestJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalTestJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalTestJson(record[key])}`
    )
    .join(",")}}`;
}

function createEvidence(
  root: string,
  candidate: string
): EvidenceJson[] {
  const reportId = "20260801-0123456789abcdef0123456789abcdef";
  const aaStudyRoot = "research/aa-studies/final-repeatability";
  const aaLedger = {
    collection: {
      startedAt: "2026-08-01T00:01:00.000Z",
      completedAt: "2026-08-01T00:02:00.000Z"
    },
    attempts: [
      {
        url: "https://example.com/",
        repetition: 1,
        observation: { reportType: "single" }
      }
    ],
    receiptDigest: digest("fixture-aa-ledger-receipt")
  };
  const aaEvaluation = {
    status: "pass",
    evaluationDigest: digest("fixture-aa-evaluation")
  };
  const aaPreregistrationPath = `${aaStudyRoot}/preregistration.json`;
  const aaTargetFramePath = `${aaStudyRoot}/target-frame.json`;
  const aaLedgerPath = `${aaStudyRoot}/attempt-ledger.json`;
  const aaEvaluationPath = `${aaStudyRoot}/evaluation.json`;
  const paths: Array<{
    category: MeasurementEvidenceCategory;
    path: string;
    value: unknown;
    change:
      | "added"
      | "generated-update"
      | "refreshed"
      | "release-finalization";
  }> = [
    {
      category: "featured-report",
      path: `public/reports/${reportId}.json`,
      value: { schemaVersion: 2, reportId },
      change: "added"
    },
    {
      category: "featured-provenance",
      path: `public/reports/${reportId}.provenance.json`,
      value: { sourceCommit: candidate },
      change: "added"
    },
    {
      category: "generated-report-index",
      path: "public/reports/index.json",
      value: { reports: [reportId] },
      change: "generated-update"
    },
    {
      category: "generated-corpus-stats",
      path: "public/corpus-stats.json",
      value: { total: 1 },
      change: "generated-update"
    },
    {
      category: "runner-receipt",
      path: "research/runner-receipts/30600000001.json",
      value: { kind: "site-behavior-controlled-runner-destruction-receipt" },
      change: "added"
    },
    {
      category: "controlled-publication-manifest",
      path:
        "research/controlled-publications/30600000001-1/publication.json",
      value: { runId: 30600000001, runAttempt: 1, producerCommit: candidate },
      change: "added"
    },
    {
      category: "controlled-publication-receipt",
      path: "research/controlled-publications/30600000001-1/receipt.json",
      value: { runId: 30600000001, runAttempt: 1, producerCommit: candidate },
      change: "added"
    },
    {
      category: "aa-attempt-ledger",
      path: aaLedgerPath,
      value: aaLedger,
      change: "added"
    },
    {
      category: "aa-evaluation",
      path: aaEvaluationPath,
      value: aaEvaluation,
      change: "added"
    },
    {
      category: "aa-producer-receipt",
      path: `${aaStudyRoot}/producer-receipt.json`,
      value: {
        schemaVersion: 1,
        artifactKind: "site-behavior-aa-producer-receipt",
        studyId: "final-repeatability",
        producer: {
          workflow:
            "iAnonymous3000/site-behavior-lab/.github/workflows/aa-study.yml@refs/heads/main",
          runId: 30600000003,
          runAttempt: 1,
          runHeadCommit: candidate,
          checkoutCommit: candidate,
          conclusion: "success"
        },
        attester: {
          workflow:
            "iAnonymous3000/site-behavior-lab/.github/workflows/archive-aa-study.yml@refs/heads/main",
          sourceCommit: candidate
        },
        artifact: {
          id: 30600000103,
          name:
            "site-behavior-aa-study-final-repeatability-30600000003-1",
          archiveSha256: digest("fixture-aa-artifact-archive"),
          manifestPath: "aa-artifact.json",
          manifestSha256: digest("fixture-aa-artifact-manifest")
        },
        collection: aaLedger.collection,
        execution: {
          shardIndex: 0,
          shardCount: 1,
          exactAttemptSet: true,
          orderPolicy: "not-applicable",
          runner: {
            labelSha256: digest("controlled-calibration-runner"),
            identitySha256: digest("fixture-aa-runner"),
            environment: "ephemeral-self-hosted"
          },
          egress: {
            identity: "controlled-self-hosted",
            regionSha256: digest("us-west")
          }
        },
        evidence: {
          preregistration: {
            path: "preregistration.json",
            sha256: sha256File(
              path.join(root, ...aaPreregistrationPath.split("/"))
            )
          },
          targetFrame: {
            path: "target-frame.json",
            sha256: sha256File(
              path.join(root, ...aaTargetFramePath.split("/"))
            )
          },
          attemptLedger: {
            path: "attempt-ledger.json",
            sha256: canonicalJsonDigest(aaLedger),
            receiptDigest: aaLedger.receiptDigest
          },
          evaluation: {
            path: "evaluation.json",
            sha256: canonicalJsonDigest(aaEvaluation),
            evaluationDigest: aaEvaluation.evaluationDigest
          }
        },
        recordedAt: "2026-08-01T00:04:00.000Z"
      },
      change: "added"
    },
    {
      category: "aa-producer-attestation",
      path: `${aaStudyRoot}/producer-receipt.sigstore.json`,
      value: {
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json"
      },
      change: "added"
    },
    {
      category: "measurement-freeze-receipt",
      path: "research/ops-receipts/measurement-freeze-activation.json",
      value: {
        kind: "site-behavior-lab-measurement-freeze-activation",
        receiptVersion: 2,
        candidate: {
          commit: candidate,
          checkoutCommit: candidate,
          mainRefCommit: candidate
        },
        activation: {
          headSha: candidate,
          activatedAt: "2026-08-01T00:00:00.000Z"
        },
        reAdjudication: {
          receiptPath:
            "research/ops-receipts/featured-readjudication.json",
          receiptSha256: sha256File(
            path.join(
              root,
              "research",
              "ops-receipts",
              "featured-readjudication.json"
            )
          ),
          finalFeaturedSitesSha256: sha256File(
            path.join(root, "public", "featured-sites.json")
          )
        },
        safeConfiguration: {
          runnerLabelSha256: digest("controlled-calibration-runner"),
          scannerEgress: "controlled-self-hosted",
          scannerEgressRegionSha256: digest("us-west")
        },
        handoff: { archivePath: "research/ops-receipts/measurement-freeze-activation.json" }
      },
      change: "added"
    },
    {
      category: "lifecycle-receipt",
      path: "research/ops-receipts/r2-lifecycle-readback.json",
      value: { candidateCommit: candidate },
      change: "refreshed"
    },
    {
      category: "release-policy-finalization",
      path: "release-policy.json",
      value: {
        schemaVersion: 2,
        status: "released",
        version: "1.0.0",
        releaseTag: "v1.0.0",
        releaseDate: "2026-08-01",
        stablePublicApi: false,
        npmPublication: "disabled"
      },
      change: "release-finalization"
    },
    {
      category: "citation-finalization",
      path: "CITATION.cff",
      value:
        'cff-version: 1.2.0\ntitle: "Site Behavior Lab"\nversion: "1.0.0"\ndate-released: "2026-08-01"\n',
      change: "release-finalization"
    },
    {
      category: "changelog-finalization",
      path: "CHANGELOG.md",
      value:
        "# Changelog\n\n## Unreleased\n\n## [1.0.0] - 2026-08-01\n\nFinal release notes.\n",
      change: "release-finalization"
    }
  ];
  for (const gateId of [
    "egress-backstop",
    "waf-ceilings",
    "log-retention",
    "container-image-licensing"
  ]) {
    paths.push(
      {
        category: "operator-evidence",
        path: `research/ops-evidence/${gateId}.json`,
        value: {
          schemaVersion: 1,
          artifactKind: `site-behavior-${gateId}-evidence`,
          recordedAt: "2026-08-01T00:05:00.000Z"
        },
        change: "added"
      },
      {
        category: "operator-attestation",
        path: `research/ops-receipts/${gateId}-attestation.json`,
        value: { bindings: { candidateCommit: candidate } },
        change: "added"
      }
    );
  }
  for (const entry of paths) {
    const absolute = path.join(root, ...entry.path.split("/"));
    if (typeof entry.value === "string") {
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, entry.value);
    } else {
      writeJson(absolute, entry.value);
    }
  }
  return paths.map((entry) => ({
    category: entry.category,
    path: entry.path,
    change: entry.change,
    sha256: sha256File(path.join(root, ...entry.path.split("/")))
  }));
}

function bindingJson(
  root: string,
  candidateCommit: string,
  candidateTree: string,
  studyId: string,
  preregistrationPath: string,
  samplingFramePath: string,
  studyPath: string,
  analysisPath: string,
  receiptPath: string,
  receiptBundlePath: string,
  artifactManifestPath: string,
  evidence: EvidenceJson[],
  includeCalibrationStudy: boolean = true
): BindingJson {
  return {
    schemaVersion: 1,
    artifactKind: MEASUREMENT_CANDIDATE_BINDING_KIND,
    repository: "iAnonymous3000/site-behavior-lab",
    targetRelease: "1.0.0",
    candidateCommit,
    candidateTree,
    measurementInputs: {
      manifestPath: MEASUREMENT_CANDIDATE_INPUTS_PATH,
      manifestSha256: sha256File(
        path.join(root, ...MEASUREMENT_CANDIDATE_INPUTS_PATH.split("/"))
      ),
      domainSeparatedDigest: createHash("sha256")
        .update(MEASUREMENT_CANDIDATE_INPUTS_DIGEST_DOMAIN)
        .update("\0")
        .update(
          readFileSync(
            path.join(root, ...MEASUREMENT_CANDIDATE_INPUTS_PATH.split("/"))
          )
        )
        .digest("hex")
    },
    measurementIdentity: {
      manifestPath: MEASUREMENT_IDENTITY_PATH,
      manifestSha256: sha256File(
        path.join(root, ...MEASUREMENT_IDENTITY_PATH.split("/"))
      ),
      domainSeparatedDigest: createHash("sha256")
        .update(MEASUREMENT_IDENTITY_DIGEST_DOMAIN)
        .update("\0")
        .update(
          readFileSync(path.join(root, ...MEASUREMENT_IDENTITY_PATH.split("/")))
        )
        .digest("hex")
    },
    calibrationPolicy: {
      id: MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID,
      policyArtifactPath: MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH,
      policyArtifactSha256: sha256File(
        path.join(
          root,
          ...MEASUREMENT_CALIBRATION_CENSORING_POLICY_PATH.split("/")
        )
      ),
      dispositionSha256: (
        JSON.parse(
          readFileSync(path.join(root, "RELEASE_READINESS.json"), "utf8")
        ) as {
          decisions: {
            calibrationCensoringPolicy: { dispositionSha256: string };
          };
        }
      ).decisions.calibrationCensoringPolicy.dispositionSha256
    },
    durablePrerequisite: durablePrerequisiteBinding(
      root,
      candidateCommit
    ),
    sourceEvidence: {
      manifestPath: MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH,
      manifestSha256: sha256File(
        path.join(root, ...MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH.split("/"))
      ),
      bundlePath: MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH,
      bundleSha256: sha256File(
        path.join(root, ...MEASUREMENT_CANDIDATE_ATTESTATION_BUNDLE_PATH.split("/"))
      ),
      packageInventoryPath: MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH,
      packageInventorySha256: sha256File(
        path.join(root, ...MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH.split("/"))
      ),
      packageBundlePath: MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH,
      packageBundleSha256: sha256File(
        path.join(root, ...MEASUREMENT_CANDIDATE_PACKAGE_ATTESTATION_BUNDLE_PATH.split("/"))
      ),
      packageReviewLedgerPath:
        MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH,
      packageReviewLedgerSha256: sha256File(
        path.join(
          root,
          MEASUREMENT_CANDIDATE_PACKAGE_REVIEW_LEDGER_PATH
        )
      ),
      packageLegalEvidence: [
        {
          path: "LICENSE",
          sha256: sha256File(path.join(root, "LICENSE"))
        }
      ]
    },
    attestationPolicy: {
      status: "required-external-verification",
      repository: "iAnonymous3000/site-behavior-lab",
      signerWorkflow: MEASUREMENT_CANDIDATE_SIGNER_WORKFLOW,
      sourceDigest: candidateCommit,
      sourceRef: "refs/heads/main",
      denySelfHostedRunners: true
    },
    evidence,
    calibrationStudies: includeCalibrationStudy
      ? [
        {
        studyId,
        detector: "pixel-events",
        preregistrationPath,
        preregistrationSha256: sha256File(
          path.join(root, ...preregistrationPath.split("/"))
        ),
        samplingFramePath,
        samplingFrameSha256: sha256File(
          path.join(root, ...samplingFramePath.split("/"))
        ),
        studyPath,
        studySha256: sha256File(path.join(root, ...studyPath.split("/"))),
        analysisPath,
        analysisSha256: sha256File(path.join(root, ...analysisPath.split("/"))),
        runtimeReceiptPath: receiptPath,
        runtimeReceiptSha256: sha256File(path.join(root, ...receiptPath.split("/"))),
        runtimeReceiptBundlePath: receiptBundlePath,
        runtimeReceiptBundleSha256: sha256File(
          path.join(root, ...receiptBundlePath.split("/"))
        ),
        artifactManifestPath,
        artifactManifestSha256: sha256File(
          path.join(root, ...artifactManifestPath.split("/"))
        )
        }
      ]
      : []
  };
}

function rewriteCandidate(
  root: string,
  binding: BindingJson,
  candidateCommit: string,
  candidateTree: string
): void {
  binding.candidateCommit = candidateCommit;
  binding.candidateTree = candidateTree;
  binding.attestationPolicy.sourceDigest = candidateCommit;
  const manifestPath = path.join(root, ...MEASUREMENT_CANDIDATE_SOURCE_EVIDENCE_PATH.split("/"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    source: { commit: string; tree: string };
    artifacts: Array<{ sourceCommit: string }>;
  };
  manifest.source.commit = candidateCommit;
  manifest.source.tree = candidateTree;
  manifest.artifacts[0].sourceCommit = candidateCommit;
  writeJson(manifestPath, manifest);
  binding.sourceEvidence.manifestSha256 = sha256File(manifestPath);
  const inventoryPath = path.join(
    root,
    ...MEASUREMENT_CANDIDATE_PACKAGE_INVENTORY_PATH.split("/")
  );
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
    source: { commit: string };
  };
  inventory.source.commit = candidateCommit;
  writeJson(inventoryPath, inventory);
  binding.sourceEvidence.packageInventorySha256 = sha256File(inventoryPath);
  const freezeEntry = binding.evidence.find(
    (entry) => entry.category === "measurement-freeze-receipt"
  );
  assert.ok(freezeEntry);
  const freezePath = path.join(root, ...freezeEntry.path.split("/"));
  const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as {
    candidate: { commit: string; checkoutCommit: string; mainRefCommit: string };
    activation: { headSha: string };
  };
  freeze.candidate.commit = candidateCommit;
  freeze.candidate.checkoutCommit = candidateCommit;
  freeze.candidate.mainRefCommit = candidateCommit;
  freeze.activation.headSha = candidateCommit;
  writeJson(freezePath, freeze);
  freezeEntry.sha256 = sha256File(freezePath);
  const studyPath = path.join(root, ...binding.calibrationStudies[0].studyPath.split("/"));
  const studyJson = JSON.parse(
    readFileSync(studyPath, "utf8")
  ) as DetectorCalibrationStudyV3;
  studyJson.release = currentDetectorCalibrationReleaseIdentity(
    "pixel-events",
    candidateCommit,
    runtimeIdentity()
  );
  writeJson(studyPath, studyJson);
  binding.calibrationStudies[0].studySha256 = sha256File(studyPath);
  const labelsManifestPath = path.join(
    root,
    "calibration",
    binding.calibrationStudies[0].studyId,
    "labels-manifest.json"
  );
  const labelsManifest = JSON.parse(
    readFileSync(labelsManifestPath, "utf8")
  ) as {
    source: { commit: string; tree: string };
    authenticatedCommitments: Array<{ headSha: string }>;
    commitmentSetSha256: string;
  };
  labelsManifest.source.commit = candidateCommit;
  labelsManifest.source.tree = candidateTree;
  for (const commitment of labelsManifest.authenticatedCommitments) {
    commitment.headSha = candidateCommit;
  }
  labelsManifest.commitmentSetSha256 = sha256Hex(
    canonicalJson(labelsManifest.authenticatedCommitments)
  );
  writeJson(labelsManifestPath, labelsManifest);
  const runtimeReceiptPath = path.join(
    root,
    ...binding.calibrationStudies[0].runtimeReceiptPath.split("/")
  );
  const runtimeReceipt = JSON.parse(
    readFileSync(runtimeReceiptPath, "utf8")
  ) as {
    candidateCommit: string;
    producerCommit: string;
    freeze: { receiptSha256: string };
    acquisition: { headSha: string };
    labels: {
      commit: string;
      tree: string;
      manifestSha256: string;
      commitmentSetSha256: string;
    };
    outputs: {
      studySha256: string;
      analysisSha256: string;
      labelsManifestSha256: string;
    };
    runtime: DetectorCalibrationRuntimeIdentity;
  };
  runtimeReceipt.candidateCommit = candidateCommit;
  runtimeReceipt.producerCommit = candidateCommit;
  runtimeReceipt.freeze.receiptSha256 = freezeEntry.sha256;
  runtimeReceipt.acquisition.headSha = candidateCommit;
  runtimeReceipt.labels.commit = candidateCommit;
  runtimeReceipt.labels.tree = candidateTree;
  runtimeReceipt.labels.commitmentSetSha256 =
    labelsManifest.commitmentSetSha256;
  runtimeReceipt.labels.manifestSha256 = sha256File(labelsManifestPath);
  runtimeReceipt.outputs.labelsManifestSha256 =
    runtimeReceipt.labels.manifestSha256;
  runtimeReceipt.outputs.studySha256 =
    binding.calibrationStudies[0].studySha256;
  const analysisPath = path.join(
    root,
    ...binding.calibrationStudies[0].analysisPath.split("/")
  );
  writeJson(
    analysisPath,
    analyzeDetectorCalibrationStudy(studyJson, {
      expectedBuildCommit: candidateCommit,
      expectedRuntimeDigest: runtimeReceipt.runtime.runtimeDigest
    })
  );
  binding.calibrationStudies[0].analysisSha256 = sha256File(analysisPath);
  runtimeReceipt.outputs.analysisSha256 =
    binding.calibrationStudies[0].analysisSha256;
  writeJson(runtimeReceiptPath, runtimeReceipt);
  binding.calibrationStudies[0].runtimeReceiptSha256 =
    sha256File(runtimeReceiptPath);
  writeBinding(root, binding);
}

function readBinding(root: string): BindingJson {
  return JSON.parse(
    readFileSync(path.join(root, ...MEASUREMENT_CANDIDATE_BINDING_PATH.split("/")), "utf8")
  ) as BindingJson;
}

function writeBinding(root: string, binding: BindingJson): void {
  writeJson(path.join(root, ...MEASUREMENT_CANDIDATE_BINDING_PATH.split("/")), binding);
}

function study(
  buildCommit: string,
  runtime: DetectorCalibrationRuntimeIdentity,
  studyId: string,
  design: DetectorCalibrationStudyV2["design"],
  includeCensoredCase: boolean,
  adequate: boolean
): DetectorCalibrationStudyV3 {
  if (adequate) {
    const cases = [
      ...Array.from({ length: 100 }, (_, index) =>
        completeCase(
          `absent-${String(index).padStart(3, "0")}`,
          "absent",
          "not-detected"
        )
      ),
      ...Array.from({ length: 100 }, (_, index) =>
        completeCase(
          `present-${String(index).padStart(3, "0")}`,
          "present",
          "detected"
        )
      )
    ];
    return {
      schemaVersion: 3,
      studyId,
      detector: "pixel-events",
      release: currentDetectorCalibrationReleaseIdentity(
        "pixel-events",
        buildCommit,
        runtime
      ),
      targetPopulation:
        "Consent-accepted, GPC-disabled visits in the frozen final-candidate calibration frame.",
      plannedCases: cases.length,
      labelRosterAuthorizationSha256: digest(
        `${studyId}-label-roster-authorization`
      ),
      rosterSelectionLedgerSha256: digest(
        `${studyId}-roster-selection-ledger`
      ),
      acquisitionAttemptLedgerSha256: digest(
        `${studyId}-acquisition-attempt-ledger`
      ),
      design,
      cases
    };
  }
  return {
    schemaVersion: 3,
    studyId,
    detector: "pixel-events",
    release: currentDetectorCalibrationReleaseIdentity("pixel-events", buildCommit, runtime),
    targetPopulation:
      "Consent-accepted, GPC-disabled visits in the frozen final-candidate calibration frame.",
    plannedCases: 2,
    labelRosterAuthorizationSha256: digest(
      `${studyId}-label-roster-authorization`
    ),
    rosterSelectionLedgerSha256: digest(
      `${studyId}-roster-selection-ledger`
    ),
    acquisitionAttemptLedgerSha256: digest(
      `${studyId}-acquisition-attempt-ledger`
    ),
    design,
    cases: [
      completeCase("present", "present", "detected"),
      includeCensoredCase
        ? {
            caseId: "absent",
            outcome: "censored",
            reason: "capture-failed",
            conditionDigest: calibrationConditionDigest(
              "pixel-events-final-candidate",
              "absent"
            ),
            attemptArtifactDigest: digest("absent-attempt")
          }
        : completeCase("absent", "absent", "not-detected", true)
    ]
  };
}

function calibrationDesign(
  samplingFrame: string,
  samplingFrameDigest: string,
  adequate: boolean = false
): DetectorCalibrationStudyV2["design"] {
  return {
    sampling: adequate ? "simple-random" : "convenience",
    samplingFrame,
    samplingFrameDigest,
    selectionProtocol: "Select cases before detector output.",
    referenceProtocol: "Two blinded reviewers label independent evidence.",
    referenceProtocolDigest: digest("reference"),
    adjudicationProtocol: "A third reviewer resolves disagreements.",
    adjudicationProtocolDigest: digest("adjudication"),
    measurementCondition:
      detectorCalibrationMeasurementCondition("pixel-events"),
    independentUnits: true,
    predictionBlindedToReference: true,
    referenceBlindedToPrediction: true
  };
}

function calibrationSelectionArtifact(studyId: string, caseId: string) {
  return {
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-selection",
    studyId,
    detector: "pixel-events",
    caseId,
    url: `https://calibration.example/${caseId}`
  };
}

function calibrationConditionArtifact(studyId: string, caseId: string) {
  return {
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-condition",
    studyId,
    detector: "pixel-events",
    caseId,
    request: {
      device: "desktop",
      gpcEnabled: false,
      consentMode: "accept-all"
    }
  };
}

function calibrationSelectionDigest(studyId: string, caseId: string): string {
  return canonicalJsonDigest(calibrationSelectionArtifact(studyId, caseId));
}

function calibrationConditionDigest(studyId: string, caseId: string): string {
  return canonicalJsonDigest(calibrationConditionArtifact(studyId, caseId));
}

function calibrationReferenceEvidenceArtifact(
  studyId: string,
  caseId: string
) {
  return {
    schemaVersion: 1,
    artifactKind:
      "site-behavior-detector-calibration-reference-evidence",
    studyId,
    detector: "pixel-events",
    caseId,
    blindingNonce: digest(`reference-nonce:${caseId}`),
    source: {
      kind: "independent-capture",
      locator:
        `urn:sbl:reference:sha256:${digest(`reference-source:${caseId}`)}`,
      observedAt: "2026-07-31T21:00:00.000Z"
    },
    observations: [
      {
        fact: "pixel-events-presence",
        value: caseId.startsWith("present")
      }
    ]
  };
}

function calibrationReferenceEvidenceDigest(
  studyId: string,
  caseId: string
): string {
  return canonicalJsonDigest(
    calibrationReferenceEvidenceArtifact(studyId, caseId)
  );
}

function calibrationSourceReport(
  prediction: "detected" | "not-detected",
  unverifiedPixelConsent: boolean = false
) {
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: {
      conditions: {
        device: { kind: "desktop" },
        gpc: false,
        consent: "accept-all"
      },
      quality: { run: { outcome: "complete" } },
      detectors: {
        "pixel-events": { status: "complete", phaseId: 0 }
      },
      evidence: {
        consent: {
          mode: "accept-all",
          interactionAttempted: true,
          controlActivated: true,
          verificationObservations: [
            {
              phaseId: 1,
              method: "tcf-api@4",
              observed: "accepted-all",
              consistentWithChoice: true,
              result: { outcome: "read", sequence: 1 }
            },
            {
              phaseId: 2,
              method: "tcf-api@4",
              observed: "accepted-all",
              consistentWithChoice: true,
              result: { outcome: "read", sequence: 2 }
            }
          ],
          choiceState: unverifiedPixelConsent ? "unverified" : "verified",
          reverifiedAfterReload: true
        },
        pixelEvents:
          prediction === "detected"
            ? [{ kind: "tracking-pixel", url: "https://pixel.example/p.gif" }]
            : []
      },
      phases: [
        { phaseId: 0, kind: "passive-load" },
        { phaseId: 1, kind: "consent-interaction" },
        { phaseId: 2, kind: "post-choice-reload" }
      ]
    }
  };
}

function canonicalJsonDigest(value: unknown): string {
  return sha256Hex(`${JSON.stringify(value, null, 2)}\n`);
}

function createCalibrationArtifacts(
  root: string,
  studyValue: DetectorCalibrationStudyV3,
  artifactManifestPath: string,
  unverifiedPixelConsent: boolean = false
): void {
  const artifacts: Array<{
    role:
      | "selection"
      | "condition"
      | "source-report"
      | "detector-observation"
      | "prediction"
      | "evidence"
      | "label"
      | "adjudication"
      | "attempt";
    caseId: string;
    path: string;
    sha256: string;
  }> = [];
  const addArtifact = (
    caseId: string,
    role:
      | "selection"
      | "condition"
      | "source-report"
      | "detector-observation"
      | "prediction"
      | "evidence"
      | "label"
      | "adjudication"
      | "attempt",
    value: unknown
  ): string => {
    const artifactPath =
      `calibration/${studyValue.studyId}/artifacts/${caseId}/${role}.json`;
    const absolute = path.join(root, ...artifactPath.split("/"));
    writeJson(absolute, value);
    const sha256 = sha256File(absolute);
    artifacts.push({ role, caseId, path: artifactPath, sha256 });
    return sha256;
  };

  for (const calibrationCase of studyValue.cases) {
    addArtifact(
      calibrationCase.caseId,
      "selection",
      calibrationSelectionArtifact(studyValue.studyId, calibrationCase.caseId)
    );
    addArtifact(
      calibrationCase.caseId,
      "condition",
      calibrationConditionArtifact(studyValue.studyId, calibrationCase.caseId)
    );
    if (calibrationCase.outcome === "censored") {
      calibrationCase.attemptArtifactDigest = addArtifact(
        calibrationCase.caseId,
        "attempt",
        {
          schemaVersion: 1,
          artifactKind: "site-behavior-detector-calibration-attempt",
          studyId: studyValue.studyId,
          detector: studyValue.detector,
          caseId: calibrationCase.caseId,
          conditionDigest: calibrationCase.conditionDigest,
          outcome: "censored",
          reason: calibrationCase.reason,
          sourceReportSha256: null,
          recordedAt: "2026-08-01T00:06:00.000Z"
        }
      );
      continue;
    }
    const sourceReport = calibrationSourceReport(
      calibrationCase.prediction.value,
      unverifiedPixelConsent
    );
    const sourceReportDigest = addArtifact(
      calibrationCase.caseId,
      "source-report",
      sourceReport
    );
    calibrationCase.prediction.artifactDigest = addArtifact(
      calibrationCase.caseId,
      "prediction",
      {
        schemaVersion: 1,
        artifactKind: "site-behavior-detector-calibration-prediction",
        studyId: studyValue.studyId,
        detector: studyValue.detector,
        caseId: calibrationCase.caseId,
        conditionDigest: calibrationCase.conditionDigest,
        sourceReportSha256: sourceReportDigest,
        value: calibrationCase.prediction.value,
        recordedAt: "2026-08-01T00:06:00.000Z"
      }
    );
    calibrationCase.reference.evidenceArtifactDigest = addArtifact(
      calibrationCase.caseId,
      "evidence",
      calibrationReferenceEvidenceArtifact(
        studyValue.studyId,
        calibrationCase.caseId
      )
    );
    const disagreed =
      calibrationCase.reference.adjudication.status ===
      "disagreement-resolved-by-blind-tiebreaker";
    calibrationCase.reference.labelArtifactDigest = addArtifact(
      calibrationCase.caseId,
      "label",
      {
        schemaVersion: 1,
        artifactKind: "site-behavior-detector-calibration-label",
        studyId: studyValue.studyId,
        detector: studyValue.detector,
        caseId: calibrationCase.caseId,
        evidenceSha256:
          calibrationCase.reference.evidenceArtifactDigest,
        labels: [
          {
            labelerId: "github-reviewer-alpha",
            value: calibrationCase.reference.value,
            recordedAt: "2026-08-01T00:01:00.000Z"
          },
          {
            labelerId: "github-reviewer-beta",
            value: disagreed
              ? calibrationCase.reference.value === "present"
                ? "absent"
                : "present"
              : calibrationCase.reference.value,
            recordedAt: "2026-08-01T00:02:00.000Z"
          }
        ]
      }
    );
    if (
      calibrationCase.reference.adjudication.status ===
      "disagreement-resolved-by-blind-tiebreaker"
    ) {
      const labelEntries = [
        {
          actor: "reviewer-alpha",
          value: calibrationCase.reference.value,
          recordedAt: "2026-08-01T00:01:00.000Z"
        },
        {
          actor: "reviewer-beta",
          value:
            calibrationCase.reference.value === "present"
              ? "absent"
              : "present",
          recordedAt: "2026-08-01T00:02:00.000Z"
        }
      ];
      calibrationCase.reference.adjudication.artifactDigest = addArtifact(
        calibrationCase.caseId,
        "adjudication",
        {
          schemaVersion: 1,
          artifactKind:
            "site-behavior-detector-calibration-blind-tiebreaker-resolution",
          studyId: studyValue.studyId,
          detector: studyValue.detector,
          caseId: calibrationCase.caseId,
          evidenceSha256:
            calibrationCase.reference.evidenceArtifactDigest,
          labelSha256: calibrationCase.reference.labelArtifactDigest,
          labelSetSha256: sha256Hex(
            `site-behavior-calibration-label-set-v1\u0000` +
              `${calibrationCase.caseId}\u0000${canonicalJson(labelEntries)}`
          ),
          resolutionMethod: "blind-precommitted-tiebreaker",
          tiebreakerId:
            calibrationCase.reference.adjudication.tiebreakerId,
          tiebreakerCommitmentSha256: digest(
            "reviewer-gamma-envelope"
          ),
          value: calibrationCase.reference.value,
          committedAt: "2026-08-01T00:03:00.000Z"
        }
      );
    }
  }

  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  writeJson(path.join(root, ...artifactManifestPath.split("/")), {
    schemaVersion: 1,
    artifactKind: MEASUREMENT_CALIBRATION_ARTIFACT_MANIFEST_KIND,
    studyId: studyValue.studyId,
    artifacts
  });
}

function createCalibrationLabelsManifest(
  root: string,
  studyValue: DetectorCalibrationStudyV3,
  artifactManifestPath: string,
  labelsManifestPath: string,
  sourceCommit: string,
  sourceTree: string
): void {
  const artifactManifest = JSON.parse(
    readFileSync(
      path.join(root, ...artifactManifestPath.split("/")),
      "utf8"
    )
  ) as {
    artifacts: Array<{
      role: string;
      caseId: string;
      sha256: string;
    }>;
  };
  const files = artifactManifest.artifacts
    .filter(
      (artifact) =>
        artifact.role === "label" || artifact.role === "adjudication"
    )
    .map((artifact) => ({
      path: `cases/${artifact.caseId}/${artifact.role}.json`,
      sha256: artifact.sha256
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const labelSealingKey = {
    algorithm: "rsa-oaep-sha256+a256gcm",
    keyId: CALIBRATION_LABEL_KEY_ID,
    publicKeyPath:
      `calibration/${studyValue.studyId}/label-sealing-public-key.pem`,
    publicKeySha256: sha256Hex(CALIBRATION_LABEL_PUBLIC_KEY_PEM)
  };
  const authenticatedCommitments = [
    {
      role: "labeler",
      actor: "reviewer-alpha",
      runId: 30600000011,
      runAttempt: 1,
      headSha: sourceCommit,
      artifactId: 30600000111,
      artifactName:
        `site-behavior-calibration-label-commitment-labeler-${studyValue.studyId}-30600000011-1`,
      archiveSha256: digest("reviewer-alpha-batch"),
      createdAt: "2026-08-01T00:01:00.000Z",
      source: {
        commit: sourceCommit,
        tree: sourceTree,
        path:
          `calibration-label-sources/${studyValue.studyId}/reviewer-alpha.json`,
        sha256: digest("reviewer-alpha-source")
      },
      algorithm: "rsa-oaep-sha256+a256gcm",
      keyId: CALIBRATION_LABEL_KEY_ID,
      envelopeSha256: digest("reviewer-alpha-envelope"),
      ciphertextSha256: digest("reviewer-alpha-ciphertext")
    },
    {
      role: "labeler",
      actor: "reviewer-beta",
      runId: 30600000012,
      runAttempt: 1,
      headSha: sourceCommit,
      artifactId: 30600000112,
      artifactName:
        `site-behavior-calibration-label-commitment-labeler-${studyValue.studyId}-30600000012-1`,
      archiveSha256: digest("reviewer-beta-batch"),
      createdAt: "2026-08-01T00:02:00.000Z",
      source: {
        commit: sourceCommit,
        tree: sourceTree,
        path:
          `calibration-label-sources/${studyValue.studyId}/reviewer-beta.json`,
        sha256: digest("reviewer-beta-source")
      },
      algorithm: "rsa-oaep-sha256+a256gcm",
      keyId: CALIBRATION_LABEL_KEY_ID,
      envelopeSha256: digest("reviewer-beta-envelope"),
      ciphertextSha256: digest("reviewer-beta-ciphertext")
    },
    {
      role: "tiebreaker",
      actor: "reviewer-gamma",
      runId: 30600000013,
      runAttempt: 1,
      headSha: sourceCommit,
      artifactId: 30600000113,
      artifactName:
        `site-behavior-calibration-label-commitment-tiebreaker-${studyValue.studyId}-30600000013-1`,
      archiveSha256: digest("reviewer-gamma-batch"),
      createdAt: "2026-08-01T00:03:00.000Z",
      source: {
        commit: sourceCommit,
        tree: sourceTree,
        path:
          `calibration-label-sources/${studyValue.studyId}/reviewer-gamma.json`,
        sha256: digest("reviewer-gamma-source")
      },
      algorithm: "rsa-oaep-sha256+a256gcm",
      keyId: CALIBRATION_LABEL_KEY_ID,
      envelopeSha256: digest("reviewer-gamma-envelope"),
      ciphertextSha256: digest("reviewer-gamma-ciphertext")
    }
  ];
  writeJson(path.join(root, ...labelsManifestPath.split("/")), {
    schemaVersion: 3,
    artifactKind: "site-behavior-detector-calibration-labels-manifest",
    studyId: studyValue.studyId,
    detector: studyValue.detector,
    source: {
      commit: sourceCommit,
      tree: sourceTree,
      path: `calibration-labels/${studyValue.studyId}`,
      sha256: digest("label-coordinate-manifest")
    },
    labelSealingKey,
    authenticatedCommitments,
    commitmentSetSha256: sha256Hex(
      canonicalJson(authenticatedCommitments)
    ),
    recordedFrom: "2026-08-01T00:01:00.000Z",
    recordedThrough: "2026-08-01T00:03:00.000Z",
    files
  });
}

function completeCase(
  caseId: string,
  reference: "present" | "absent",
  prediction: "detected" | "not-detected",
  adjudicated = false
): Extract<DetectorCalibrationStudyV3["cases"][number], { outcome: "complete" }> {
  return {
    caseId,
    outcome: "complete",
    conditionDigest: calibrationConditionDigest(
      "pixel-events-final-candidate",
      caseId
    ),
    prediction: { value: prediction, artifactDigest: digest(`${caseId}-prediction`) },
    reference: {
      value: reference,
      evidenceArtifactDigest: digest(`${caseId}-evidence`),
      labelArtifactDigest: digest(`${caseId}-label`),
      labelerIds: ["github-reviewer-alpha", "github-reviewer-beta"],
      adjudication: adjudicated
        ? {
            status: "disagreement-resolved-by-blind-tiebreaker",
            tiebreakerId: "github-reviewer-gamma",
            artifactDigest: digest(`${caseId}-adjudication`)
          }
        : {
            status: "labelers-agreed",
            tiebreakerId: null,
            artifactDigest: null
          }
    }
  };
}

function runtimeIdentity(): DetectorCalibrationRuntimeIdentity {
  const declared = {
    observer: "node-playwright",
    automation: "playwright-chromium",
    nodeVersion: "24.14.1",
    playwrightVersion: "1.62.0",
    browserName: "chromium",
    browserVersion: "145.0.7632.6",
    operatingSystem: "linux",
    architecture: "x64"
  } as const;
  return { ...declared, runtimeDigest: detectorCalibrationRuntimeDigest(declared) };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function digest(value: string): string {
  return sha256Hex(value);
}

function commitAll(root: string, message: string): void {
  git(root, ["add", "--all"]);
  git(root, ["commit", "-q", "-m", message]);
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
