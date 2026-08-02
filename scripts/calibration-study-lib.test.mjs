import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  extractCalibrationAcquisitionArchive,
  validateCalibrationGithubArtifactMetadata
} from "./calibration-study-archive-lib.mjs";
import {
  assembleAuthenticatedCalibrationLabels,
  validateCalibrationLabelCommitmentGithubMetadata
} from "./calibration-label-sources-lib.mjs";
import {
  CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
  CALIBRATION_LABEL_SEALING_ALGORITHM,
  calibrationLabelPublicKeyIdentity,
  openCalibrationLabelSourceEnvelope,
  sealCalibrationLabelSourceEnvelope
} from "./calibration-label-source-envelope-lib.mjs";
import {
  validateCalibrationProposalPulls,
  validateCalibrationProposalRuns
} from "./calibration-proposal-readback.mjs";
import {
  buildCalibrationAcquisitionAuthorizationIdentity
} from "./calibration-acquisition-authorization-lib.mjs";
import {
  authenticatedCalibrationCommitmentSummaries,
  calibrationLabelRosterRunName,
  calibrationLabelRosterRunSelectionSnapshot
} from "./calibration-label-roster-lib.mjs";
import {
  CALIBRATION_BINDING_PATH,
  CALIBRATION_CENSORING_POLICY_ID,
  CALIBRATION_CENSORING_POLICY_PATH,
  CALIBRATION_DETECTOR_IDS,
  addAssembledCalibrationToMeasurementBinding,
  assembleCalibrationStudy,
  assertCalibrationCandidateCanSatisfyRatePolicy,
  assertCalibrationDecisionApproved,
  calibrationMeasurementCondition,
  calibrationPolicyDispositionSha256,
  calibrationCandidateScaffold,
  canonicalPrettyJson,
  createCalibrationAcquisition,
  createCalibrationLabelCommitment,
  detectorPredictionFromRun,
  inspectCalibrationAcquisition,
  sha256Hex,
  validateCalibrationCandidateFiles,
  validateCalibrationCaseInputs,
  validateCalibrationLabelSource,
  writeAssembledCalibration,
  writeCalibrationAcquisition,
  writeCalibrationCandidateScaffold
} from "./calibration-study-lib.mjs";

const CANDIDATE = "a".repeat(40);
const CARRIER = "b".repeat(40);
const COMPLETED_AT = "2026-08-20T00:05:00.000Z";
const LABEL_REVEAL_KEYS = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});
const LABEL_SEALING_KEY = calibrationLabelPublicKeyIdentity(
  LABEL_REVEAL_KEYS.publicKey
);

test("candidate scaffolds support every detector and share one exact policy artifact", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-calibration-scaffold-"));
  const policyDigests = new Set();
  for (const [index, detector] of CALIBRATION_DETECTOR_IDS.entries()) {
    const studyId = `study-${index}`;
    const inputs = caseInputValues(studyId, detector, `https://example${index}.com/`);
    const scaffold = calibrationCandidateScaffold(
      plan(
        studyId,
        detector,
        inputs.selectionText,
        inputs.conditionText,
        inputs.referenceEvidenceText
      )
    );
    assert.equal(
      scaffold.preregistration.censoringPolicy.path,
      CALIBRATION_CENSORING_POLICY_PATH
    );
    assert.equal(
      scaffold.preregistration.censoringPolicy.id,
      CALIBRATION_CENSORING_POLICY_ID
    );
    assert.equal(scaffold.policy.schemaVersion, 2);
    assert.deepEqual(
      scaffold.policy.ratePublicationEligibility.minimumDenominators,
      {
        referencePresent: 100,
        referenceAbsent: 100,
        predictedDetected: 100,
        predictedNotDetected: 100
      }
    );
    policyDigests.add(scaffold.preregistration.censoringPolicy.sha256);
    writeCalibrationCandidateScaffold(root, scaffold);
    writeLabelSealingPublicKey(root, studyId);
    const verified = validateCalibrationCandidateFiles(root, studyId);
    assert.equal(verified.detector, detector);
    assert.equal(verified.frame.cases.length, 1);
    assert.deepEqual(
      verified.preregistration.design.measurementCondition,
      calibrationMeasurementCondition(detector)
    );
    assert.deepEqual(
      verified.frame.measurementCondition,
      calibrationMeasurementCondition(detector)
    );
  }
  assert.equal(policyDigests.size, 1);
  assert.equal(
    statSync(path.join(root, ...CALIBRATION_CENSORING_POLICY_PATH.split("/"))).isFile(),
    true
  );
});

test("all six detectors pin one exact condition arm and pixel uses consent-accepted", () => {
  assert.deepEqual(calibrationMeasurementCondition("pixel-events"), {
    device: "desktop",
    gpcEnabled: false,
    consentMode: "accept-all",
    interpretation:
      "Rates are conditional on desktop visits where accept-all registration was verified and reverified after reload, with GPC disabled."
  });
  assert.deepEqual(calibrationMeasurementCondition("consent-banner"), {
    device: "desktop",
    gpcEnabled: false,
    consentMode: "observe",
    interpretation:
      "Rates are conditional on desktop visits with GPC disabled under passive consent-banner observation with no consent action."
  });
  for (const detector of [
    "fingerprint-heuristics",
    "keystroke-exfiltration",
    "cname-uncloaking",
    "privacy-policy"
  ]) {
    assert.deepEqual(calibrationMeasurementCondition(detector), {
      device: "desktop",
      gpcEnabled: false,
      consentMode: "observe",
      interpretation:
        "Rates are conditional on desktop visits with GPC disabled under passive consent observation with no consent action."
    });
  }

  const fixture = candidateFixture("pixel-events");
  const conditionPath = path.join(
    fixture.inputRoot,
    "cases",
    "case-a",
    "condition.json"
  );
  const wrong = JSON.parse(readFileSync(conditionPath, "utf8"));
  wrong.request.consentMode = "observe";
  const wrongText = canonicalPrettyJson(wrong);
  writeFileSync(conditionPath, wrongText);
  fixture.candidate.frameById.get("case-a").conditionDigest =
    sha256Hex(wrongText);
  assert.throws(
    () =>
      validateCalibrationCaseInputs({
        candidate: fixture.candidate,
        caseInputRoot: fixture.inputRoot
      }),
    /preregistered detector-specific measurement arm/
  );
});

test("preflight refuses a candidate that cannot satisfy the approved rate policy", () => {
  const fixture = candidateFixture("pixel-events");
  assert.throws(
    () => assertCalibrationCandidateCanSatisfyRatePolicy(fixture.candidate),
    /simple-random/
  );
  const candidate = structuredClone(fixture.candidate);
  candidate.preregistration.design.sampling = "simple-random";
  candidate.preregistration.plannedCases = 399;
  assert.throws(
    () => assertCalibrationCandidateCanSatisfyRatePolicy(candidate),
    /below the conservative pre-labeling minimum 400/
  );
  candidate.preregistration.plannedCases = 400;
  assert.equal(
    assertCalibrationCandidateCanSatisfyRatePolicy(candidate)
      .conservativeMinimumCases,
    400
  );
});

test("policy decision is an explicit human gate and never inferred from candidate bytes", () => {
  const policyArtifactSha256 = "1".repeat(64);
  const dispositionSha256 =
    calibrationPolicyDispositionSha256(policyArtifactSha256);
  const base = {
    decisions: {
      calibrationCensoringPolicy: {
        recommended: "settle-before-labeling",
        status: "pending",
        decidedBy: null,
        decidedAt: null
      }
    }
  };
  assert.throws(
    () => assertCalibrationDecisionApproved(base, policyArtifactSha256),
    /must explicitly approve the exact candidate policy/
  );
  base.decisions.calibrationCensoringPolicy = {
    recommended: "settle-before-labeling",
    selected: CALIBRATION_CENSORING_POLICY_ID,
    policyArtifactPath: CALIBRATION_CENSORING_POLICY_PATH,
    policyArtifactSha256,
    dispositionSha256,
    status: "approved",
    decidedBy: "reviewer-one",
    decidedAt: "2026-08-19T00:00:00.000Z"
  };
  assert.deepEqual(
    assertCalibrationDecisionApproved(
      base,
      policyArtifactSha256,
      new Date("2026-08-20T00:00:00.000Z")
    ),
    {
      selected: CALIBRATION_CENSORING_POLICY_ID,
      policyArtifactPath: CALIBRATION_CENSORING_POLICY_PATH,
      policyArtifactSha256,
      dispositionSha256,
      decidedBy: "reviewer-one",
      decidedAt: "2026-08-19T00:00:00.000Z"
    }
  );
  base.decisions.calibrationCensoringPolicy.policyArtifactSha256 =
    "2".repeat(64);
  assert.throws(
    () => assertCalibrationDecisionApproved(base, policyArtifactSha256),
    /must explicitly approve the exact candidate policy/
  );
});

test("acquisition inputs are set-equal to selection and condition and cannot expose reference evidence", () => {
  const fixture = candidateFixture("pixel-events");
  const inputs = validateCalibrationCaseInputs({
    candidate: fixture.candidate,
    caseInputRoot: fixture.inputRoot
  });
  assert.equal(inputs.length, 1);
  const evidencePath = path.join(
    fixture.inputRoot,
    "cases",
    "case-a",
    "reference-evidence.json"
  );
  writeFileSync(evidencePath, fixture.referenceEvidenceText);
  assert.throws(
    () =>
      validateCalibrationCaseInputs({
        candidate: fixture.candidate,
        caseInputRoot: fixture.inputRoot
      }),
    /must contain exactly selection and condition JSON/
  );
});

test("persisted detector predictions derive from report facts, never labels or substitute signals", () => {
  const base = {
    conditions: { consent: "accept-all" },
    phases: [
      { phaseId: 0, kind: "passive-load" },
      { phaseId: 1, kind: "consent-interaction" },
      { phaseId: 2, kind: "post-choice-reload" }
    ],
    quality: { run: { outcome: "complete" } },
    detectors: Object.fromEntries(
      CALIBRATION_DETECTOR_IDS.map((detector) => [
        detector,
        { status: "complete" }
      ])
    ),
    evidence: {
      requests: [],
      fingerprintDetections: [],
      cnameCloaks: [],
      pixelEvents: [],
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
            result: { outcome: "read", sequence: 0 }
          },
          {
            phaseId: 2,
            method: "tcf-api@4",
            observed: "accepted-all",
            consistentWithChoice: true,
            result: { outcome: "read", sequence: 1 }
          }
        ],
        choiceState: "verified",
        reverifiedAfterReload: true
      }
    }
  };
  const positives = {
    "fingerprint-heuristics": {
      fingerprintDetections: [{ kind: "canvas-readback" }]
    },
    "keystroke-exfiltration": {
      fingerprintDetections: [{ kind: "keystroke-exfiltration" }]
    },
    "cname-uncloaking": { cnameCloaks: [{}] },
    "pixel-events": { pixelEvents: [{}] },
    "consent-banner": { requests: [{ domain: "cdn.cookielaw.org" }] },
    "privacy-policy": { privacyPolicy: { url: "https://example.com/privacy" } }
  };
  for (const detector of CALIBRATION_DETECTOR_IDS.filter(
    (entry) => entry !== "consent-banner"
  )) {
    const absent = detectorPredictionFromRun(
      structuredClone(base),
      detector
    );
    assert.deepEqual(absent, { outcome: "complete", value: "not-detected" }, detector);
    const presentRun = structuredClone(base);
    Object.assign(presentRun.evidence, positives[detector]);
    const present = detectorPredictionFromRun(
      presentRun,
      detector
    );
    assert.deepEqual(present, { outcome: "complete", value: "detected" }, detector);
  }
  const cmpOnly = structuredClone(base);
  cmpOnly.evidence.requests = [{ domain: "cdn.cookielaw.org" }];
  assert.throws(
    () =>
      detectorPredictionFromRun(cmpOnly, "consent-banner"),
    /process-local calibration result; public CMP\/request evidence cannot substitute/
  );
  const unverifiedPixel = structuredClone(base);
  unverifiedPixel.evidence.consent.choiceState = "weak-signal";
  assert.deepEqual(
    detectorPredictionFromRun(unverifiedPixel, "pixel-events"),
    {
      outcome: "censored",
      reason: "eligibility-criteria-not-met"
    },
    "a requested or clicked accept-all arm cannot substitute for verified registered consent"
  );
  const forgedPixel = structuredClone(base);
  forgedPixel.evidence.consent.verificationObservations = [];
  assert.deepEqual(
    detectorPredictionFromRun(forgedPixel, "pixel-events"),
    {
      outcome: "censored",
      reason: "eligibility-criteria-not-met"
    },
    "producer-supplied verified/reload summaries cannot substitute for the canonical r2 derivation"
  );
});

test("acquisition contains no labels; assembly accepts exact separate labels and emits all governed roles", () => {
  const fixture = candidateFixture("pixel-events");
  const caseInputs = validateCalibrationCaseInputs({
    candidate: fixture.candidate,
    caseInputRoot: fixture.inputRoot
  });
  const acquisitionDir = path.join(fixture.root, "acquisition");
  const sourceReportText = calibrationSourceReportText(
    "pixel-events",
    true
  );
  const created = createCalibrationAcquisition({
    candidate: fixture.candidate,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    acquisitionAuthorization: acquisitionAuthorization(fixture),
    rosterSelectionSnapshot: rosterSelectionSnapshot(fixture),
    rosterSelectionSnapshotSha256: sha256Hex(
      canonicalPrettyJson(rosterSelectionSnapshot(fixture))
    ),
    workflowRun: {
      workflow:
        "iAnonymous3000/site-behavior-lab/.github/workflows/calibration-study.yml@refs/heads/main",
      id: 123,
      attempt: 1,
      headCommit: CARRIER
    },
    runner: {
      labelSha256: "c".repeat(64),
      identitySha256: "d".repeat(64),
      environment: "ephemeral-self-hosted"
    },
    egress: {
      identity: "controlled-self-hosted",
      regionSha256: "e".repeat(64)
    },
    runtime: runtime(),
    caseResults: [
      {
        caseId: "case-a",
        outcome: "complete",
        selectionText: caseInputs[0].selectionText,
        conditionText: caseInputs[0].conditionText,
        selectionDigest: caseInputs[0].selectionDigest,
        conditionDigest: fixture.conditionDigest,
        prediction: "detected",
        sourceReportSha256: sha256Hex(sourceReportText),
        sourceReportText,
        detectorObservationText: null,
        recordedAt: "2026-08-20T00:04:00.000Z"
      }
    ],
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: COMPLETED_AT
  });
  assert.equal(created.acquisitionText.includes('"label"'), false);
  assert.equal(created.acquisitionText.includes('"adjudication"'), false);
  assert.equal(
    created.files.some((file) => file.path.includes("evidence")),
    false
  );
  writeCalibrationAcquisition(acquisitionDir, created);
  const inspected = inspectCalibrationAcquisition(acquisitionDir, {
    studyId: fixture.studyId,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    runId: 123,
    runAttempt: 1
  });

  const labelCommitments = [
    authenticatedLabelCommitment(
      fixture,
      "reviewer-a",
      301,
      "2026-08-19T23:40:00.000Z",
      "present"
    ),
    authenticatedLabelCommitment(
      fixture,
      "reviewer-b",
      302,
      "2026-08-19T23:41:00.000Z",
      "present"
    ),
    authenticatedLabelCommitment(
      fixture,
      "reviewer-tiebreaker",
      303,
      "2026-08-19T23:42:00.000Z",
      "present",
      "tiebreaker"
    )
  ];
  const custody = calibrationCustodyFixture(fixture, labelCommitments);
  const labels = assembleAuthenticatedCalibrationLabels({
    candidate: fixture.candidate,
    candidateCommit: CANDIDATE,
    commitments: labelCommitments,
    privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
    acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
    acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
    retainedCaseIds: ["case-a"],
    source: {
      commit: "1".repeat(40),
      tree: "2".repeat(40),
      path: `calibration-labels/${fixture.studyId}`,
      sha256: "3".repeat(64)
    },
    roster: custody.roster
  });
  const releaseIdentity = {
    buildCommit: CANDIDATE,
    runtime: inspected.acquisition.runtime
  };
  const assembled = assembleCalibrationStudy({
    candidate: fixture.candidate,
    acquisitionInspection: inspected,
    labels,
    releaseIdentity,
    analyze: (study) => ({
      analysisVersion: "fixture",
      status: "descriptive-only",
      studyId: study.studyId,
      denominators: {
        completeCases: 1,
        censoredCases: 0
      }
    }),
    runtimeReceiptArtifact: {
      id: 456,
      name: `site-behavior-calibration-${fixture.studyId}-123-1`,
      archiveSha256: "9".repeat(64),
      bytes: 1234,
      createdAt: "2026-08-20T00:05:30.000Z",
      expiresAt: "2026-11-18T00:05:30.000Z"
    },
    acquisitionJob: {
      id: 789,
      runStartedAt: "2026-08-19T23:59:00.000Z",
      runCompletedAt: "2026-08-20T00:07:00.000Z",
      startedAt: "2026-08-20T00:00:00.000Z",
      completedAt: "2026-08-20T00:06:00.000Z",
      runnerNameSha256: "7".repeat(64)
    },
    producerCommit: CARRIER,
    policyDecision: {
      dispositionSha256: calibrationPolicyDispositionSha256(
        fixture.candidate.policySha256
      ),
      decidedBy: "policy-owner",
      decidedAt: "2026-08-19T23:00:00.000Z"
    },
    freezeReceipt: {
      path: "research/ops-receipts/measurement-freeze-activation.json",
      sha256: "8".repeat(64),
      activatedAt: "2026-08-19T23:30:00.000Z"
    },
    custody: custody.files,
    assembledAt: "2026-08-20T01:00:00.000Z"
  });
  assert.deepEqual(
    assembled.artifactManifest.artifacts.map((entry) => entry.role),
    [
      "condition",
      "evidence",
      "label",
      "prediction",
      "selection",
      "source-report"
    ]
  );
  assert.equal(assembled.study.cases[0].reference.adjudication.status, "labelers-agreed");
  assert.equal(assembled.runtimeReceipt.acquisition.headSha, CARRIER);
  assert.equal(assembled.runtimeReceipt.candidateCommit, CANDIDATE);
  assert.equal(assembled.runtimeReceipt.producerCommit, CARRIER);
  assert.equal(assembled.runtimeReceipt.artifact.id, 456);
  assert.equal(assembled.runtimeReceipt.labels.commit, "1".repeat(40));
  assert.equal(
    assembled.runtimeReceipt.labels.commitmentSetSha256,
    labels.commitmentSetSha256
  );
  assert.equal(assembled.analysis.status, "descriptive-only");
  writeJson(path.join(fixture.root, CALIBRATION_BINDING_PATH), {
    candidateCommit: CANDIDATE,
    calibrationPolicy: {
      id: CALIBRATION_CENSORING_POLICY_ID,
      policyArtifactPath: CALIBRATION_CENSORING_POLICY_PATH,
      policyArtifactSha256: fixture.candidate.policySha256
    },
    calibrationStudies: [
      {
        studyId: "zz-existing",
        studyPath: "calibration/zz-existing/study.json"
      }
    ]
  });
  writeAssembledCalibration(fixture.root, assembled);
  const bundlePath =
    `calibration/${fixture.studyId}/runtime-receipt.sigstore.json`;
  writeJson(path.join(fixture.root, ...bundlePath.split("/")), {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json"
  });
  const entry = addAssembledCalibrationToMeasurementBinding(
    fixture.root,
    fixture.candidate,
    assembled,
    {
      path: bundlePath,
      sha256: sha256Hex(
        readFileSync(path.join(fixture.root, ...bundlePath.split("/")))
      )
    }
  );
  assert.equal(entry.studySha256, sha256Hex(assembled.studyText));
  assert.deepEqual(
    JSON.parse(
      readFileSync(
        path.join(fixture.root, CALIBRATION_BINDING_PATH),
        "utf8"
      )
    ).calibrationStudies.map((study) => study.studyId),
    [fixture.studyId, "zz-existing"]
  );
  assert.equal(
    statSync(
      path.join(
        fixture.root,
        "calibration",
        fixture.studyId,
        "analysis.json"
      )
    ).isFile(),
    true
  );
});

test("Actions metadata and raw ZIP are authenticated before trusted per-member extraction", () => {
  const fixture = candidateFixture("pixel-events");
  const caseInputs = validateCalibrationCaseInputs({
    candidate: fixture.candidate,
    caseInputRoot: fixture.inputRoot
  });
  const acquisitionDir = path.join(fixture.root, "artifact-source");
  const created = createCalibrationAcquisition({
    candidate: fixture.candidate,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    acquisitionAuthorization: acquisitionAuthorization(fixture),
    rosterSelectionSnapshot: rosterSelectionSnapshot(fixture),
    rosterSelectionSnapshotSha256: sha256Hex(
      canonicalPrettyJson(rosterSelectionSnapshot(fixture))
    ),
    workflowRun: {
      workflow:
        "iAnonymous3000/site-behavior-lab/.github/workflows/calibration-study.yml@refs/heads/main",
      id: 123,
      attempt: 1,
      headCommit: CARRIER
    },
    runner: {
      labelSha256: "c".repeat(64),
      identitySha256: "d".repeat(64),
      environment: "ephemeral-self-hosted"
    },
    egress: {
      identity: "controlled-self-hosted",
      regionSha256: "e".repeat(64)
    },
    runtime: runtime(),
    caseResults: [
      {
        caseId: "case-a",
        outcome: "censored",
        reason: "capture-failed",
        selectionText: caseInputs[0].selectionText,
        conditionText: caseInputs[0].conditionText,
        selectionDigest: caseInputs[0].selectionDigest,
        conditionDigest: fixture.conditionDigest,
        sourceReportSha256: null,
        sourceReportText: null,
        detectorObservationText: null,
        recordedAt: "2026-08-20T00:04:00.000Z"
      }
    ],
    startedAt: "2026-08-20T00:00:00.000Z",
    completedAt: COMPLETED_AT
  });
  writeCalibrationAcquisition(acquisitionDir, created);
  const archive = path.join(fixture.root, "artifact.zip");
  const members = listFiles(acquisitionDir);
  writeFileSync(
    archive,
    createZip(
      members.map((member) => ({
        name: member,
        contents: readFileSync(
          path.join(acquisitionDir, ...member.split("/"))
        )
      }))
    )
  );
  const archiveBytes = readFileSync(archive);
  const archiveSha256 = sha256Hex(archiveBytes);
  const runMetadataPath = path.join(fixture.root, "run.json");
  const jobMetadataPath = path.join(fixture.root, "jobs.json");
  const artifactMetadataPath = path.join(fixture.root, "artifacts.json");
  const artifactName = `site-behavior-calibration-${fixture.studyId}-123-1`;
  writeJson(runMetadataPath, {
    id: 123,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: ".github/workflows/calibration-study.yml",
    head_branch: "main",
    head_sha: CARRIER,
    conclusion: "success",
    run_started_at: "2026-08-19T23:59:00Z",
    updated_at: "2026-08-20T00:08:00Z",
    repository: { full_name: "iAnonymous3000/site-behavior-lab" }
  });
  writeJson(jobMetadataPath, {
    total_count: 1,
    jobs: [
      {
        id: 789,
        name: "Acquire blinded detector predictions",
        run_id: 123,
        run_attempt: 1,
        head_sha: CARRIER,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        started_at: "2026-08-20T00:00:00Z",
        completed_at: "2026-08-20T00:07:00Z",
        runner_name: "controlled-runner-1",
        labels: ["self-hosted", "controlled-calibration"]
      }
    ]
  });
  writeJson(artifactMetadataPath, {
    total_count: 1,
    artifacts: [
      {
        id: 456,
        name: artifactName,
        expired: false,
        size_in_bytes: archiveBytes.byteLength,
        digest: `sha256:${archiveSha256}`,
        created_at: "2026-08-20T00:06:00Z",
        expires_at: "2026-11-18T00:06:00Z",
        workflow_run: { id: 123, head_sha: CARRIER }
      }
    ]
  });
  const metadata = validateCalibrationGithubArtifactMetadata({
    runMetadataPath,
    jobMetadataPath,
    artifactMetadataPath,
    studyId: fixture.studyId,
    runId: 123,
    runAttempt: 1,
    artifactId: 456,
    artifactName,
    archiveSha256,
    runnerLabel: "controlled-calibration"
  });
  const extracted = path.join(fixture.root, "extracted");
  const result = extractCalibrationAcquisitionArchive({
    archivePath: archive,
    destinationDir: extracted,
    archiveSha256,
    archiveBytes: metadata.archiveBytes,
    studyId: fixture.studyId
  });
  assert.equal(result.entries, 4);
  assert.equal(
    inspectCalibrationAcquisition(extracted).acquisition.cases[0].outcome,
    "censored"
  );
  assert.throws(
    () =>
      extractCalibrationAcquisitionArchive({
        archivePath: archive,
        destinationDir: path.join(fixture.root, "bad-extract"),
        archiveSha256: "0".repeat(64),
        archiveBytes: metadata.archiveBytes,
        studyId: fixture.studyId
      }),
    /digest does not match/
  );
  assert.throws(
    () =>
      validateCalibrationGithubArtifactMetadata({
        runMetadataPath,
        jobMetadataPath,
        artifactMetadataPath,
        studyId: fixture.studyId,
        runId: 123,
        runAttempt: 101,
        artifactId: 456,
        artifactName,
        archiveSha256,
        runnerLabel: "controlled-calibration"
      }),
    /no greater than 100/
  );
});

test("calibration ZIP extraction is PATH-independent and rejects hostile archive shapes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-calibration-zip-"));
  const validManifest = canonicalPrettyJson({
    schemaVersion: 3,
    artifactKind: "site-behavior-detector-calibration-acquisition",
    studyId: "zip-study",
    files: [
      {
        path: "cases/case-a/attempt.json",
        bytes: 3,
        sha256: sha256Hex("{}\n")
      }
    ]
  });
  const validEntries = [
    { name: "acquisition.json", contents: validManifest },
    { name: "cases/case-a/attempt.json", contents: "{}\n" }
  ];
  const hostileBin = path.join(root, "hostile-bin");
  const sentinel = path.join(root, "unzip-executed");
  mkdirSync(hostileBin);
  writeFileSync(
    path.join(hostileBin, "unzip"),
    `#!/bin/sh\nprintf executed > '${sentinel}'\nexit 99\n`
  );
  chmodSync(path.join(hostileBin, "unzip"), 0o700);
  const archive = path.join(root, "valid.zip");
  writeFileSync(archive, createZip(validEntries));
  const bytes = readFileSync(archive);
  const priorPath = process.env.PATH;
  process.env.PATH = hostileBin;
  try {
    const result = extractCalibrationAcquisitionArchive({
      archivePath: archive,
      destinationDir: path.join(root, "extracted"),
      archiveSha256: sha256Hex(bytes),
      archiveBytes: bytes.byteLength,
      studyId: "zip-study"
    });
    assert.equal(result.entries, 2);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
  }
  assert.equal(existsSync(sentinel), false);

  const maliciousArchives = [
    {
      name: "duplicate",
      entries: [...validEntries, validEntries[1]],
      pattern: /duplicated/
    },
    {
      name: "traversal",
      entries: [
        { name: "acquisition.json", contents: validManifest },
        { name: "../escape.json", contents: "{}\n" }
      ],
      pattern: /unsafe/
    },
    {
      name: "dash-prefix",
      entries: [
        { name: "acquisition.json", contents: validManifest },
        { name: "-option", contents: "{}\n" }
      ],
      pattern: /unsafe/
    },
    {
      name: "symlink",
      entries: [
        { name: "acquisition.json", contents: validManifest },
        {
          name: "cases/case-a/attempt.json",
          contents: "{}\n",
          unixMode: 0o120777
        }
      ],
      pattern: /not a regular file/
    },
    {
      name: "declared-zip-bomb",
      entries: [
        {
          name: "acquisition.json",
          contents: validManifest,
          declaredUncompressedSize: 33 * 1024 * 1024
        },
        validEntries[1]
      ],
      pattern: /strict bounds/
    },
    {
      name: "bad-crc",
      entries: [
        {
          name: "acquisition.json",
          contents: validManifest,
          declaredCrc32: 0
        },
        validEntries[1]
      ],
      pattern: /CRC mismatch/
    }
  ];
  for (const malicious of maliciousArchives) {
    const maliciousPath = path.join(root, `${malicious.name}.zip`);
    writeFileSync(maliciousPath, createZip(malicious.entries));
    const maliciousBytes = readFileSync(maliciousPath);
    assert.throws(
      () =>
        extractCalibrationAcquisitionArchive({
          archivePath: maliciousPath,
          destinationDir: path.join(root, `extract-${malicious.name}`),
          archiveSha256: sha256Hex(maliciousBytes),
          archiveBytes: maliciousBytes.byteLength,
          studyId: "zip-study"
        }),
      malicious.pattern,
      malicious.name
    );
  }
});

test("encrypted label-source envelopes keep plaintext truth out of the repository-facing input", () => {
  const plaintext = canonicalPrettyJson({
    schemaVersion: 1,
    secretReference: "present",
    cases: [{ caseId: "case-a", value: "present" }]
  });
  const identity = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
    studyId: "fixture-pixel-events",
    detector: "pixel-events",
    role: "labeler",
    candidateCommit: CANDIDATE,
    reviewerLogin: "reviewer-a",
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId: LABEL_SEALING_KEY.keyId
  };
  const sealed = sealCalibrationLabelSourceEnvelope({
    ...identity,
    publicKeyPem: LABEL_REVEAL_KEYS.publicKey,
    plaintext,
    dataKey: Buffer.alloc(32, 7),
    iv: Buffer.alloc(12, 9)
  });
  assert.equal(sealed.text.includes("secretReference"), false);
  assert.equal(sealed.text.includes('"present"'), false);
  assert.equal(
    openCalibrationLabelSourceEnvelope(
      sealed.envelope,
      LABEL_REVEAL_KEYS.privateKey,
      identity
    ).text,
    plaintext
  );
  const tampered = structuredClone(sealed.envelope);
  tampered.ciphertext =
    `${tampered.ciphertext.slice(0, -4)}AAAA`;
  assert.throws(
    () =>
      openCalibrationLabelSourceEnvelope(
        tampered,
        LABEL_REVEAL_KEYS.privateKey,
        identity
      ),
    /authentication failed/
  );
  assert.throws(
    () =>
      openCalibrationLabelSourceEnvelope(
        sealed.envelope,
        LABEL_REVEAL_KEYS.privateKey,
        {
        ...identity,
          role: "tiebreaker"
        }
      ),
    /identity does not match/
  );
  const wrongKeys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  assert.throws(
    () =>
      openCalibrationLabelSourceEnvelope(
        sealed.envelope,
        wrongKeys.privateKey,
        identity
      ),
    /does not match the candidate-pinned public key/
  );
});

test("hosted ciphertext commitments require distinct actors, reject replay, and predate acquisition", () => {
  const fixture = candidateFixture("pixel-events");
  const first = authenticatedLabelCommitment(
    fixture,
    "reviewer-a",
    301,
    "2026-08-19T23:40:00.000Z",
    "present"
  );
  const second = authenticatedLabelCommitment(
    fixture,
    "reviewer-b",
    302,
    "2026-08-19T23:41:00.000Z",
    "present"
  );
  const tiebreaker = authenticatedLabelCommitment(
    fixture,
    "reviewer-tiebreaker",
    303,
    "2026-08-19T23:42:00.000Z",
    "present",
    "tiebreaker"
  );
  const labels = assembleAuthenticatedCalibrationLabels({
    candidate: fixture.candidate,
    candidateCommit: CANDIDATE,
    commitments: [first, second, tiebreaker],
    privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
    acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
    acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
    retainedCaseIds: ["case-a"],
    source: {
      commit: "1".repeat(40),
      tree: "2".repeat(40),
      path: `calibration-labels/${fixture.studyId}`,
      sha256: "3".repeat(64)
    }
  });
  assert.deepEqual(
    labels.cases.get("case-a").label.value.labels.map((entry) => entry.labelerId),
    ["github-reviewer-a", "github-reviewer-b"]
  );
  assert.equal(labels.cases.get("case-a").value, "present");
  assert.equal(labels.cases.get("case-a").adjudication, null);
  const thirdPrimary = authenticatedLabelCommitment(
    fixture,
    "reviewer-c",
    307,
    "2026-08-19T23:42:30.000Z",
    "present"
  );
  const threePrimaryLabels = assembleAuthenticatedCalibrationLabels({
    candidate: fixture.candidate,
    candidateCommit: CANDIDATE,
    commitments: [first, second, thirdPrimary, tiebreaker],
    privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
    acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
    acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
    retainedCaseIds: ["case-a"],
    source: labels.source
  });
  assert.deepEqual(
    threePrimaryLabels.cases
      .get("case-a")
      .label.value.labels.map((entry) => entry.labelerId),
    [
      "github-reviewer-a",
      "github-reviewer-b",
      "github-reviewer-c"
    ]
  );
  assert.equal(
    threePrimaryLabels.cases.get("case-a").adjudication,
    null
  );
  assert.throws(
    () =>
      assembleAuthenticatedCalibrationLabels({
        candidate: fixture.candidate,
        candidateCommit: CANDIDATE,
        commitments: [first, second],
        privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
        acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
        acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
        retainedCaseIds: ["case-a"],
        source: labels.source
      }),
    /exactly one distinct blind tiebreaker/
  );
  const disagreeingSecond = authenticatedLabelCommitment(
    fixture,
    "reviewer-b",
    304,
    "2026-08-19T23:41:30.000Z",
    "absent"
  );
  const resolved = assembleAuthenticatedCalibrationLabels({
    candidate: fixture.candidate,
    candidateCommit: CANDIDATE,
    commitments: [first, disagreeingSecond, tiebreaker],
    privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
    acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
    acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
    retainedCaseIds: ["case-a"],
    source: labels.source
  });
  assert.equal(resolved.cases.get("case-a").value, "present");
  assert.equal(
    resolved.cases.get("case-a").adjudication.value.resolutionMethod,
    "blind-precommitted-tiebreaker"
  );
  assert.equal(
    resolved.cases.get("case-a").adjudication.value.tiebreakerId,
    "github-reviewer-tiebreaker"
  );
  const unanimousWrongFirst = authenticatedLabelCommitment(
    fixture,
    "reviewer-wrong-a",
    305,
    "2026-08-19T23:43:00.000Z",
    "absent"
  );
  const unanimousWrongSecond = authenticatedLabelCommitment(
    fixture,
    "reviewer-wrong-b",
    306,
    "2026-08-19T23:44:00.000Z",
    "absent"
  );
  assert.throws(
    () =>
      assembleAuthenticatedCalibrationLabels({
        candidate: fixture.candidate,
        candidateCommit: CANDIDATE,
        commitments: [
          unanimousWrongFirst,
          unanimousWrongSecond,
          tiebreaker
        ],
        privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
        acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
        acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
        retainedCaseIds: ["case-a"],
        source: labels.source
      }),
    /candidate-bound detector-presence fact/
  );
  const duplicateActor = structuredClone(second);
  duplicateActor.metadata.actor = "reviewer-a";
  duplicateActor.metadata.triggeringActor = "reviewer-a";
  duplicateActor.commitment.producer.actor = "reviewer-a";
  duplicateActor.commitment.producer.triggeringActor = "reviewer-a";
  assert.throws(
    () =>
      assembleAuthenticatedCalibrationLabels({
        candidate: fixture.candidate,
        candidateCommit: CANDIDATE,
        commitments: [first, duplicateActor, tiebreaker],
        privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
        acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
        acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
        retainedCaseIds: ["case-a"],
        source: labels.source
      }),
    /distinct authenticated labelers/
  );
  const late = structuredClone(second);
  late.metadata.artifactCreatedAt = "2026-08-20T00:00:00.000Z";
  assert.throws(
    () =>
      assembleAuthenticatedCalibrationLabels({
        candidate: fixture.candidate,
        candidateCommit: CANDIDATE,
        commitments: [first, late, tiebreaker],
        privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
        acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
        acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
        retainedCaseIds: ["case-a"],
        source: labels.source
      }),
    /must exist before/
  );
  const replay = structuredClone(second);
  replay.metadata.actor = "reviewer-c";
  replay.metadata.triggeringActor = "reviewer-c";
  replay.commitment.producer.actor = "reviewer-c";
  replay.commitment.producer.triggeringActor = "reviewer-c";
  assert.throws(
    () =>
      assembleAuthenticatedCalibrationLabels({
        candidate: fixture.candidate,
        candidateCommit: CANDIDATE,
        commitments: [first, second, replay, tiebreaker],
        privateKeyPem: LABEL_REVEAL_KEYS.privateKey,
        acquisitionRunStartedAt: "2026-08-19T23:59:00.000Z",
        acquisitionJobStartedAt: "2026-08-20T00:00:00.000Z",
        retainedCaseIds: ["case-a"],
        source: labels.source
      }),
    /cross-actor replay/
  );
});

test("public retained reference evidence rejects URL, token, and arbitrary-string leak channels", () => {
  const fixture = candidateFixture("pixel-events");
  const source = {
    schemaVersion: 1,
    artifactKind:
      "site-behavior-detector-calibration-label-batch-source",
    role: "labeler",
    studyId: fixture.studyId,
    detector: fixture.candidate.detector,
    candidateCommit: CANDIDATE,
    cases: [
      {
        caseId: "case-a",
        referenceEvidence: fixture.referenceEvidence,
        value: "present"
      }
    ]
  };
  assert.doesNotThrow(() =>
    validateCalibrationLabelSource(
      source,
      fixture.candidate,
      "labeler",
      CANDIDATE
    )
  );
  const wrongCandidate = structuredClone(source);
  wrongCandidate.candidateCommit = "f".repeat(40);
  assert.throws(
    () =>
      validateCalibrationLabelSource(
        wrongCandidate,
        fixture.candidate,
        "labeler",
        CANDIDATE
      ),
    /does not match the sealed candidate/
  );
  const urlLeak = structuredClone(source);
  urlLeak.cases[0].referenceEvidence.source.locator =
    "https://private.example/?token=secret";
  assert.throws(
    () =>
      validateCalibrationLabelSource(
        urlLeak,
        fixture.candidate,
        "labeler",
        CANDIDATE
      ),
    /opaque urn:sbl:reference/
  );
  const arbitraryFact = structuredClone(source);
  arbitraryFact.cases[0].referenceEvidence.observations = [
    { fact: "api-token", value: "secret" }
  ];
  assert.throws(
    () =>
      validateCalibrationLabelSource(
        arbitraryFact,
        fixture.candidate,
        "labeler",
        CANDIDATE
      ),
    /public-safe detector evidence vocabulary/
  );
});

test("server metadata authenticates label actors and exact proposal OIDs", () => {
  const coordinate = {
    role: "labeler",
    runId: 301,
    runAttempt: 1,
    artifactId: 1301,
    archiveSha256: "1".repeat(64)
  };
  const run = {
    id: 301,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: ".github/workflows/calibration-label-batch.yml",
    head_branch: "main",
    head_sha: CARRIER,
    conclusion: "success",
    run_started_at: "2026-08-19T23:39:00Z",
    updated_at: "2026-08-19T23:42:00Z",
    actor: { login: "Reviewer-A" },
    triggering_actor: { login: "Reviewer-A" },
    repository: { full_name: "iAnonymous3000/site-behavior-lab" }
  };
  const artifacts = {
    total_count: 1,
    artifacts: [
      {
        id: 1301,
        name:
          "site-behavior-calibration-label-commitment-labeler-fixture-pixel-events-301-1",
        expired: false,
        size_in_bytes: 1_024,
        digest: `sha256:${"1".repeat(64)}`,
        created_at: "2026-08-19T23:41:00Z",
        expires_at: "2026-11-18T23:41:00Z",
        workflow_run: { id: 301, head_sha: CARRIER }
      }
    ]
  };
  assert.equal(
    validateCalibrationLabelCommitmentGithubMetadata({
      studyId: "fixture-pixel-events",
      coordinate,
      run,
      artifacts
    }).actor,
    "reviewer-a"
  );
  assert.throws(
    () =>
      validateCalibrationLabelCommitmentGithubMetadata({
        studyId: "fixture-pixel-events",
        coordinate,
        run: {
          ...run,
          triggering_actor: { login: "different-reviewer" }
        },
        artifacts
      }),
    /non-delegated/
  );

  const branch = "automation/calibration-fixture-pixel-events-123-1";
  const pull = {
    number: 77,
    state: "open",
    html_url: "https://github.com/iAnonymous3000/site-behavior-lab/pull/77",
    user: { login: "github-actions[bot]" },
    base: {
      ref: "main",
      repo: { full_name: "iAnonymous3000/site-behavior-lab" }
    },
    head: {
      ref: branch,
      sha: CARRIER,
      repo: { full_name: "iAnonymous3000/site-behavior-lab" }
    }
  };
  assert.equal(
    validateCalibrationProposalPulls([pull], branch, CARRIER).number,
    77
  );
  assert.throws(
    () =>
      validateCalibrationProposalPulls(
        [{ ...pull, head: { ...pull.head, sha: CANDIDATE } }],
        branch,
        CARRIER
      ),
    /exact in-repository branch OID/
  );
  assert.equal(
    validateCalibrationProposalRuns(
      {
        total_count: 1,
        workflow_runs: [
          {
            id: 88,
            event: "workflow_dispatch",
            path: ".github/workflows/ci.yml",
            head_branch: branch,
            head_sha: CARRIER,
            repository: {
              full_name: "iAnonymous3000/site-behavior-lab"
            }
          }
        ]
      },
      branch,
      CARRIER
    ).length,
    1
  );
});

test("workflow keeps acquisition, labels, assembly, and publication in separate governed lanes", () => {
  const workflow = readFileSync(
    path.join(process.cwd(), ".github", "workflows", "calibration-study.yml"),
    "utf8"
  );
  for (const detector of CALIBRATION_DETECTOR_IDS) {
    assert.match(workflow, new RegExp(`          - ${detector}\\n`));
  }
  assert.match(
    workflow,
    /runs-on: \$\{\{ needs\.preflight\.outputs\.runner_label \}\}/
  );
  assert.match(workflow, /npm run calibration:preflight -- --acquisition/);
  assert.match(workflow, /Checkout frozen candidate C/);
  assert.match(
    workflow,
    /site-behavior-calibration-\$\{\{ inputs\.study_id \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/
  );
  assert.match(
    workflow,
    /repos\/\$\{GITHUB_REPOSITORY\}\/actions\/artifacts\/\$\{ACQUISITION_ARTIFACT_ID\}\/zip/
  );
  assert.match(workflow, /git worktree add --detach .*"\$LABELS_REF"/);
  assert.match(workflow, /verifiedMeasurementCandidateBinding/);
  assert.match(
    workflow,
    /actions\/attest@f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6 # v4\.2\.0/
  );
  assert.match(
    workflow,
    /name: Attest the calibration runtime receipt[\s\S]*id-token: write[\s\S]*artifact-metadata: write/
  );
  const attestationJob = workflow.slice(
    workflow.indexOf("  attest-receipt:"),
    workflow.indexOf("  propose:")
  );
  assert.doesNotMatch(
    attestationJob,
    /actions\/checkout@|npm ci|npm run/
  );
  assert.match(
    workflow,
    /git bundle create[\s\S]*calibration-prepared\.bundle/
  );
  assert.match(
    workflow,
    /runtime-receipt\.sigstore\.json[\s\S]*calibration:finalize/
  );
  assert.match(workflow, /gh pr create/);
  assert.match(
    workflow,
    /Before merge, manually approve this automation proposal's parked push-event CI run/
  );
  assert.match(workflow, /does not satisfy the pull request ruleset required checks/);
  assert.match(workflow, /calibration-proposal-readback\.mjs/);
  assert.match(workflow, /--proposal-oid "\$proposal_oid"/);
  assert.doesNotMatch(
    workflow,
    /git push origin (?:main|HEAD:refs\/heads\/main)/
  );
  const labelWorkflow = readFileSync(
    path.join(
      process.cwd(),
      ".github",
      "workflows",
      "calibration-label-batch.yml"
    ),
    "utf8"
  );
  assert.match(labelWorkflow, /runs-on: ubuntu-latest/);
  assert.match(
    workflow,
    /environment: calibration-label-reveal[\s\S]*CALIBRATION_LABEL_REVEAL_PRIVATE_KEY: \$\{\{ secrets\.CALIBRATION_LABEL_REVEAL_PRIVATE_KEY \}\}/
  );
  assert.doesNotMatch(labelWorkflow, /CALIBRATION_LABEL_REVEAL_PRIVATE_KEY/);
  assert.doesNotMatch(labelWorkflow, /CALIBRATION_LABEL_SOURCE_KEY/);
  assert.doesNotMatch(labelWorkflow, /environment: calibration-labeling/);
  assert.match(labelWorkflow, /commitment\.json/);
  assert.match(labelWorkflow, /site-behavior-calibration-label-commitment-/);
  assert.doesNotMatch(labelWorkflow, /runs-on: \$\{\{.*runner_label/);
  const assemblyScript = readFileSync(
    path.join(process.cwd(), "scripts", "calibration-study-assemble.mjs"),
    "utf8"
  );
  assert.match(
    assemblyScript,
    /const revealPrivateKeyPem = requiredSecret\([\s\S]*delete process\.env\.CALIBRATION_LABEL_REVEAL_PRIVATE_KEY;[\s\S]*const checkoutCommit = git/
  );
  assert.equal(
    assemblyScript.match(
      /requiredSecret\(\s*"CALIBRATION_LABEL_REVEAL_PRIVATE_KEY"\s*\)/g
    )
      ?.length,
    1
  );
});

function candidateFixture(detector) {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-calibration-fixture-"));
  const studyId = `fixture-${detector}`;
  const inputRoot = path.join(root, "inputs");
  const values = caseInputValues(studyId, detector, "https://example.com/");
  writeJson(
    path.join(inputRoot, "cases", "case-a", "selection.json"),
    values.selection
  );
  writeJson(
    path.join(inputRoot, "cases", "case-a", "condition.json"),
    values.condition
  );
  const scaffold = calibrationCandidateScaffold(
    plan(
      studyId,
      detector,
      values.selectionText,
      values.conditionText,
      values.referenceEvidenceText
    )
  );
  writeCalibrationCandidateScaffold(root, scaffold);
  writeLabelSealingPublicKey(root, studyId);
  const candidate = validateCalibrationCandidateFiles(root, studyId);
  return {
    root,
    inputRoot,
    studyId,
    candidate,
    conditionDigest: sha256Hex(values.conditionText),
    referenceEvidence: values.referenceEvidence,
    referenceEvidenceText: values.referenceEvidenceText
  };
}

function acquisitionAuthorization(fixture) {
  return buildCalibrationAcquisitionAuthorizationIdentity({
    studyId: fixture.studyId,
    detector: fixture.candidate.detector,
    candidateCommit: CANDIDATE,
    roster: {
      runId: 122,
      runAttempt: 1,
      headSha: CARRIER,
      artifactId: 456,
      archiveSha256: sha256Hex("fixture-roster-archive"),
      authorizationSha256: sha256Hex(
        "fixture-roster-authorization"
      ),
      artifactCreatedAt: "2026-08-19T23:55:00.000Z"
    },
    commitmentSetSha256: sha256Hex(
      "fixture-roster-commitment-set"
    ),
    nonce: sha256Hex("fixture-acquisition-authorization"),
    caseInputRootSha256: sha256Hex(
      `site-behavior-calibration-case-input-root-v1\u0000${fixture.inputRoot}`
    )
  });
}

function rosterSelectionSnapshot(fixture) {
  const caseInputRootSha256 = sha256Hex(
    `site-behavior-calibration-case-input-root-v1\u0000${fixture.inputRoot}`
  );
  const displayTitle = calibrationLabelRosterRunName({
    studyId: fixture.studyId,
    candidateCommit: CANDIDATE,
    caseInputRootSha256
  });
  return calibrationLabelRosterRunSelectionSnapshot({
    studyId: fixture.studyId,
    candidateCommit: CANDIDATE,
    carrierCommit: CARRIER,
    caseInputRootSha256,
    selectedRunId: 122,
    runs: [
      {
        id: 122,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        path: ".github/workflows/calibration-label-roster.yml",
        head_branch: "main",
        head_sha: CARRIER,
        actor: { login: "reviewer-a" },
        triggering_actor: { login: "reviewer-a" },
        created_at: "2026-08-19T23:50:00.000Z",
        run_started_at: "2026-08-19T23:50:01.000Z",
        updated_at: "2026-08-19T23:56:00.000Z",
        display_title: displayTitle
      }
    ]
  });
}

function calibrationCustodyFixture(fixture, commitments) {
  const { authenticatedCommitments, commitmentSetSha256 } =
    authenticatedCalibrationCommitmentSummaries({
      candidate: fixture.candidate,
      candidateCommit: CANDIDATE,
      commitments
    });
  const studyRoot = `calibration/${fixture.studyId}`;
  const custodyFile = (name, value) => {
    const text = canonicalPrettyJson(value);
    return {
      path: `${studyRoot}/${name}`,
      text,
      sha256: sha256Hex(text)
    };
  };
  const files = {
    labelRosterAuthorization: custodyFile(
      "label-roster-authorization.json",
      {
        studyId: fixture.studyId,
        detector: fixture.candidate.detector,
        candidateCommit: CANDIDATE,
        carrierCommit: CARRIER,
        authenticatedCommitments,
        commitmentSetSha256
      }
    ),
    rosterSelectionLedger: custodyFile("roster-selection-ledger.json", {
      studyId: fixture.studyId,
      selectedRunId: 122,
      runs: [122]
    }),
    acquisitionAttemptLedger: custodyFile(
      "acquisition-attempt-ledger.json",
      {
        studyId: fixture.studyId,
        attempts: [{ runId: 123, runAttempt: 1 }]
      }
    )
  };
  return {
    roster: {
      authorizationPath: files.labelRosterAuthorization.path,
      authorizationSha256: files.labelRosterAuthorization.sha256,
      selectionLedgerPath: files.rosterSelectionLedger.path,
      selectionLedgerSha256: files.rosterSelectionLedger.sha256,
      candidateCommit: CANDIDATE,
      carrierCommit: CARRIER,
      authenticatedCommitments,
      commitmentSetSha256
    },
    files
  };
}

function caseInputValues(studyId, detector, url) {
  const measurementCondition = calibrationMeasurementCondition(detector);
  const selection = {
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-selection",
    studyId,
    detector,
    caseId: "case-a",
    url
  };
  const condition = {
    schemaVersion: 1,
    artifactKind: "site-behavior-detector-calibration-condition",
    studyId,
    detector,
    caseId: "case-a",
    request: {
      device: measurementCondition.device,
      gpcEnabled: measurementCondition.gpcEnabled,
      consentMode: measurementCondition.consentMode
    }
  };
  const referenceEvidence = {
    schemaVersion: 1,
    artifactKind:
      "site-behavior-detector-calibration-reference-evidence",
    studyId,
    detector,
    caseId: "case-a",
    blindingNonce: sha256Hex("fixture-reference-nonce"),
    source: {
      kind: "independent-capture",
      locator: `urn:sbl:reference:sha256:${sha256Hex(`${studyId}:case-a`)}`,
      observedAt: "2026-08-19T22:00:00.000Z"
    },
    observations: [
      {
        fact: `${detector}-presence`,
        value: true
      }
    ]
  };
  return {
    selection,
    condition,
    referenceEvidence,
    selectionText: canonicalPrettyJson(selection),
    conditionText: canonicalPrettyJson(condition),
    referenceEvidenceText: canonicalPrettyJson(referenceEvidence)
  };
}

function plan(
  studyId,
  detector,
  selectionText,
  conditionText,
  referenceEvidenceText
) {
  return {
    schemaVersion: 2,
    artifactKind: "site-behavior-detector-calibration-plan",
    studyId,
    detector,
    declaredAt: "2026-08-19T00:00:00.000Z",
    targetPopulation: "The frozen fixture population.",
    labelSealingKey: {
      algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
      keyId: LABEL_SEALING_KEY.keyId,
      publicKeyPath:
        `calibration/${studyId}/label-sealing-public-key.pem`,
      publicKeySha256: sha256Hex(LABEL_REVEAL_KEYS.publicKey)
    },
    design: {
      sampling: "convenience",
      selectionProtocol: "Select every frozen fixture case before acquisition.",
      referenceProtocol: "Two independent blinded reviewers label retained evidence.",
      adjudicationProtocol:
        "A distinct blind tiebreaker precommits a full-frame decision before acquisition.",
      measurementCondition: calibrationMeasurementCondition(detector),
      independentUnits: true,
      predictionBlindedToReference: true,
      referenceBlindedToPrediction: true
    },
    cases: [
      {
        caseId: "case-a",
        selectionDigest: sha256Hex(selectionText),
        conditionDigest: sha256Hex(conditionText),
        referenceEvidenceDigest: sha256Hex(referenceEvidenceText)
      }
    ]
  };
}

function calibrationSourceReportText(detector, detected) {
  const measurementCondition = calibrationMeasurementCondition(detector);
  return canonicalPrettyJson({
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: {
      conditions: {
        device: { kind: measurementCondition.device },
        gpc: measurementCondition.gpcEnabled,
        consent: measurementCondition.consentMode
      },
      phases: [
        { phaseId: 0, kind: "passive-load" },
        { phaseId: 1, kind: "consent-interaction" },
        { phaseId: 2, kind: "post-choice-reload" }
      ],
      quality: { run: { outcome: "complete" } },
      detectors: {
        [detector]: {
          version: "fixture@1",
          status: "complete",
          phaseId: 0
        }
      },
      evidence: {
        fingerprintDetections: [],
        cnameCloaks: [],
        pixelEvents: detected ? [{ domain: "pixel.example" }] : [],
        ...(detector === "pixel-events"
          ? {
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
                    result: { outcome: "read", sequence: 0 }
                  },
                  {
                    phaseId: 2,
                    method: "tcf-api@4",
                    observed: "accepted-all",
                    consistentWithChoice: true,
                    result: { outcome: "read", sequence: 1 }
                  }
                ],
                choiceState: "verified",
                reverifiedAfterReload: true
              }
            }
          : {})
      }
    }
  });
}

function runtime() {
  return {
    observer: "node-playwright",
    automation: "playwright-chromium",
    nodeVersion: "24.14.1",
    playwrightVersion: "1.62.0",
    browserName: "chromium",
    browserVersion: "145.0.0.0",
    operatingSystem: "linux",
    architecture: "x64"
  };
}

function authenticatedLabelCommitment(
  fixture,
  actor,
  runId,
  artifactCreatedAt,
  value,
  role = "labeler"
) {
  const archiveSha256 = String(runId % 10).repeat(64);
  const artifactId = runId + 1_000;
  const source = {
    schemaVersion: 1,
    artifactKind:
      "site-behavior-detector-calibration-label-batch-source",
    role,
    studyId: fixture.studyId,
    detector: fixture.candidate.detector,
    candidateCommit: CANDIDATE,
    cases: [
      {
        caseId: "case-a",
        referenceEvidence: fixture.referenceEvidence,
        value
      }
    ]
  };
  const identity = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_SOURCE_ENVELOPE_KIND,
    studyId: fixture.studyId,
    detector: fixture.candidate.detector,
    role,
    candidateCommit: CANDIDATE,
    reviewerLogin: actor,
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId: LABEL_SEALING_KEY.keyId
  };
  const sealed = sealCalibrationLabelSourceEnvelope({
    ...identity,
    publicKeyPem: LABEL_REVEAL_KEYS.publicKey,
    plaintext: canonicalPrettyJson(source)
  });
  const commitment = createCalibrationLabelCommitment({
    candidate: fixture.candidate,
    candidateCommit: CANDIDATE,
    role,
    envelope: sealed.envelope,
    producer: {
      repository: "iAnonymous3000/site-behavior-lab",
      workflowPath: ".github/workflows/calibration-label-batch.yml",
      workflowRef: "refs/heads/main",
      runId,
      runAttempt: 1,
      headSha: CARRIER,
      actor,
      triggeringActor: actor
    },
    sourceProvenance: {
      commit: sha256Hex(`source-commit:${actor}:${runId}`).slice(0, 40),
      tree: sha256Hex(`source-tree:${actor}:${runId}`).slice(0, 40),
      path:
        `private-calibration/${fixture.studyId}-${actor}-${runId}.sealed.json`,
      sha256: sha256Hex(sealed.text)
    }
  }).commitment;
  return {
    coordinate: {
      role,
      runId,
      runAttempt: 1,
      artifactId,
      archiveSha256
    },
    metadata: {
      role,
      runId,
      runAttempt: 1,
      headSha: CARRIER,
      actor,
      triggeringActor: actor,
      runStartedAt: artifactCreatedAt,
      runCompletedAt: artifactCreatedAt,
      artifactId,
      artifactName:
        `site-behavior-calibration-label-commitment-${role}-${fixture.studyId}-${runId}-1`,
      archiveSha256,
      archiveBytes: 1_024,
      artifactCreatedAt,
      artifactExpiresAt: "2026-11-18T00:00:00.000Z"
    },
    commitment,
    text: canonicalPrettyJson(commitment)
  };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, canonicalPrettyJson(value));
}

function writeLabelSealingPublicKey(root, studyId) {
  const file = path.join(
    root,
    "calibration",
    studyId,
    "label-sealing-public-key.pem"
  );
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, LABEL_REVEAL_KEYS.publicKey);
}

function listFiles(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(root, "");
  return files.sort();
}

function createZip(entries) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const contents = Buffer.isBuffer(entry.contents)
      ? entry.contents
      : Buffer.from(entry.contents);
    const compressed = deflateRawSync(contents);
    const crc = crc32(contents);
    const declaredCrc32 = entry.declaredCrc32 ?? crc;
    const declaredUncompressedSize =
      entry.declaredUncompressedSize ?? contents.byteLength;
    const local = Buffer.alloc(30 + name.byteLength);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(declaredCrc32 >>> 0, 14);
    local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(declaredUncompressedSize, 22);
    local.writeUInt16LE(name.byteLength, 26);
    name.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + name.byteLength);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(declaredCrc32 >>> 0, 16);
    central.writeUInt32LE(compressed.byteLength, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0o100600) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centrals.push(central);
    localOffset += local.byteLength + compressed.byteLength;
  }
  const centralSize = centrals.reduce(
    (sum, central) => sum + central.byteLength,
    0
  );
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

let fixtureCrc32Table;

function crc32(contents) {
  if (fixtureCrc32Table === undefined) {
    fixtureCrc32Table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value =
          (value & 1) !== 0
            ? 0xedb88320 ^ (value >>> 1)
            : value >>> 1;
      }
      fixtureCrc32Table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc = fixtureCrc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
