import { createHash, createPublicKey } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  calibrationAcquisitionAuthorizationSha256,
  validateCalibrationAcquisitionAuthorizationIdentity
} from "./calibration-acquisition-authorization-lib.mjs";

const calibrationStudyRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export const CALIBRATION_DETECTOR_IDS = Object.freeze([
  "fingerprint-heuristics",
  "keystroke-exfiltration",
  "cname-uncloaking",
  "pixel-events",
  "consent-banner",
  "privacy-policy"
]);
export const CALIBRATION_CENSORING_POLICY_ID =
  "per-detector-censoring-assignments-v1";
export const CALIBRATION_CENSORING_POLICY_PATH =
  "research/measurement-candidate/calibration-censoring-policy-assignments.json";
export const CALIBRATION_POLICY_DISPOSITION_DOMAIN =
  "site-behavior-calibration-censoring-policy-disposition-v3";
/**
 * HISTORICAL: the superseded global zero-censoring policy's identity, kept
 * only so its recorded approval and artifact stay verifiable. Nothing may
 * start a study through it.
 */
export const CALIBRATION_SUPERSEDED_POLICY_ID =
  "complete-case-only-zero-censoring";
export const CALIBRATION_SUPERSEDED_POLICY_PATH =
  "research/measurement-candidate/calibration-censoring-policy.json";
export const CALIBRATION_SUPERSEDED_POLICY_SHA256 =
  "b4bef330dde26d9f4f78904c89e3603fa67a70de9446b88094b18928a10e4cfd";
export const CALIBRATION_SUPERSEDED_DISPOSITION_SHA256 =
  "e46eaa0af85b3b581e1df5f50c9e941eff56c453321620d0dd1bd47906b9a1ed";
export const CALIBRATION_CENSOR_REASONS = Object.freeze([
  "capture-failed",
  "reference-label-uncertain",
  "artifact-unreadable",
  "eligibility-criteria-not-met"
]);
export const CALIBRATION_WORKFLOW =
  "iAnonymous3000/site-behavior-lab/.github/workflows/calibration-study.yml@refs/heads/main";
export const CALIBRATION_ACQUISITION_KIND =
  "site-behavior-detector-calibration-acquisition";
export const CALIBRATION_ARTIFACT_MANIFEST_KIND =
  "site-behavior-detector-calibration-artifact-manifest";
export const CALIBRATION_RUNTIME_RECEIPT_KIND =
  "site-behavior-detector-calibration-runtime-receipt";
export const CALIBRATION_LABELS_MANIFEST_KIND =
  "site-behavior-detector-calibration-labels-manifest";
export const CALIBRATION_LABEL_COMMITMENT_KIND =
  "site-behavior-detector-calibration-label-commitment";
export const CALIBRATION_LABEL_BATCH_SOURCE_KIND =
  "site-behavior-detector-calibration-label-batch-source";
export const CALIBRATION_LABEL_SOURCES_KIND =
  "site-behavior-detector-calibration-label-sources";
export const CALIBRATION_LABEL_WORKFLOW_PATH =
  ".github/workflows/calibration-label-batch.yml";

/**
 * The v4 prevalence-pilot commitment workflow, which is a DIFFERENT file from
 * the v3 one above and must stay different. Both constants are acceptance
 * rules, not names: three call sites decide which producer records count as
 * authentic, so widening the v3 constant to admit a second workflow would
 * quietly widen what a v3 study accepts. A caller states which workflow it
 * expects, and the default stays v3 so no existing caller changes.
 */
export const CALIBRATION_V4_PILOT_LABEL_WORKFLOW_PATH =
  ".github/workflows/calibration-v4-pilot-commitment.yml";
export const CALIBRATION_LABEL_SEALING_ALGORITHM =
  "rsa-oaep-sha256+a256gcm";
export const CALIBRATION_BINDING_PATH =
  "research/measurement-candidate-binding.json";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TOKEN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PUBLIC_REFERENCE_LOCATOR =
  /^urn:sbl:reference:sha256:[0-9a-f]{64}$/;
const CANONICAL_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_CASES = 100_000;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 2_000;

const PLAN_KEYS = [
  "schemaVersion",
  "artifactKind",
  "studyId",
  "detector",
  "declaredAt",
  "targetPopulation",
  "labelSealingKey",
  "design",
  "cases"
];
const PLAN_DESIGN_KEYS = [
  "sampling",
  "selectionProtocol",
  "referenceProtocol",
  "adjudicationProtocol",
  "measurementCondition",
  "independentUnits",
  "predictionBlindedToReference",
  "referenceBlindedToPrediction"
];
const PLAN_CASE_KEYS = [
  "caseId",
  "selectionDigest",
  "conditionDigest",
  "referenceEvidenceDigest"
];
const FRAME_KEYS = [
  "schemaVersion",
  "artifactKind",
  "studyId",
  "detector",
  "selectionProtocolDigest",
  "measurementCondition",
  "labelSealingKey",
  "cases"
];
const LABEL_SEALING_KEY_KEYS = [
  "algorithm",
  "keyId",
  "publicKeyPath",
  "publicKeySha256"
];
const FRAME_CASE_KEYS = [
  "caseId",
  "selectionDigest",
  "conditionDigest",
  "referenceEvidenceDigest"
];
const POLICY_KEYS = [
  "schemaVersion",
  "artifactKind",
  "id",
  "allowedReasons",
  "releaseEligibility",
  "ratePublicationEligibility"
];
const POLICY_ELIGIBILITY_KEYS = [
  "anyCensoredCase",
  "plannedDenominator"
];
const POLICY_RATE_KEYS = [
  "sampling",
  "independentUnits",
  "predictionBlindedToReference",
  "referenceBlindedToPrediction",
  "minimumDenominators",
  "uncertainty",
  "performanceThreshold"
];
const POLICY_MINIMUM_DENOMINATOR_KEYS = [
  "referencePresent",
  "referenceAbsent",
  "predictedDetected",
  "predictedNotDetected"
];
const POLICY_UNCERTAINTY_KEYS = [
  "method",
  "confidenceLevel",
  "maximumWorstCaseHalfWidth"
];
const PREREGISTRATION_KEYS = [
  "schemaVersion",
  "artifactKind",
  "studyId",
  "detector",
  "declaredAt",
  "targetPopulation",
  "plannedCases",
  "censoringPolicy",
  "design"
];
const PREREGISTRATION_POLICY_KEYS = ["id", "path", "sha256"];
const DESIGN_KEYS = [
  "sampling",
  "samplingFrame",
  "samplingFrameDigest",
  "selectionProtocol",
  "referenceProtocol",
  "referenceProtocolDigest",
  "adjudicationProtocol",
  "adjudicationProtocolDigest",
  "measurementCondition",
  "independentUnits",
  "predictionBlindedToReference",
  "referenceBlindedToPrediction"
];
const MEASUREMENT_CONDITION_KEYS = [
  "device",
  "gpcEnabled",
  "consentMode",
  "interpretation"
];
const SELECTION_KEYS = [
  "schemaVersion",
  "artifactKind",
  "studyId",
  "detector",
  "caseId",
  "url"
];
const CONDITION_KEYS = [
  "schemaVersion",
  "artifactKind",
  "studyId",
  "detector",
  "caseId",
  "request"
];
const REQUEST_KEYS = ["device", "gpcEnabled", "consentMode"];
const REFERENCE_EVIDENCE_KEYS = [
  "schemaVersion",
  "artifactKind",
  "studyId",
  "detector",
  "caseId",
  "blindingNonce",
  "source",
  "observations"
];
const REFERENCE_SOURCE_KEYS = ["kind", "locator", "observedAt"];
const REFERENCE_OBSERVATION_KEYS = ["fact", "value"];

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

const requireFromCalibrationStudy = createRequire(import.meta.url);
let sharedCanonicalSerializer;
let sharedMeasurementBindingContract;
let sharedDetectorCalibrationContract;
let sharedR2EvaluatorContract;
let sharedDetectorCausalInputsContract;

function measurementBindingContract() {
  if (sharedMeasurementBindingContract === undefined) {
    for (const candidate of [
      "../dist/schema/lib/measurement-candidate-binding.js",
      "../.unit-test-dist/lib/measurement-candidate-binding.js"
    ]) {
      try {
        const loaded = requireFromCalibrationStudy(candidate);
        if (
          loaded.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_ID ===
            CALIBRATION_CENSORING_POLICY_ID &&
          loaded.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_PATH ===
            CALIBRATION_CENSORING_POLICY_PATH &&
          loaded.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_DISPOSITION_DOMAIN ===
            CALIBRATION_POLICY_DISPOSITION_DOMAIN &&
          loaded.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_SCHEMA_VERSION === 3 &&
          loaded.MEASUREMENT_CALIBRATION_CENSORING_POLICY_ID ===
            CALIBRATION_SUPERSEDED_POLICY_ID &&
          typeof loaded.measurementCalibrationRatePublicationEligibility ===
            "function" &&
          typeof loaded.measurementCalibrationPolicyAssignmentsDispositionSha256 ===
            "function" &&
          typeof loaded.measurementCalibrationAssignmentsSemanticProjection ===
            "function"
        ) {
          sharedMeasurementBindingContract = loaded;
          break;
        }
      } catch {
        // The launcher compiles the shared binding contract before invoking
        // this producer. Unit tests use the equivalent .unit-test-dist tree.
      }
    }
  }
  if (sharedMeasurementBindingContract === undefined) {
    throw new Error(
      "The shared measurement calibration policy contract is unavailable; build dist/schema before using the calibration producer."
    );
  }
  return sharedMeasurementBindingContract;
}

function detectorCalibrationContract() {
  if (sharedDetectorCalibrationContract === undefined) {
    for (const candidate of [
      "../dist/schema/lib/detector-calibration.js",
      "../.unit-test-dist/lib/detector-calibration.js"
    ]) {
      try {
        const loaded = requireFromCalibrationStudy(candidate);
        if (
          loaded.DETECTOR_CALIBRATION_STUDY_V2_SCHEMA_VERSION === 2 &&
          typeof loaded.detectorCalibrationMeasurementCondition === "function"
        ) {
          sharedDetectorCalibrationContract = loaded;
          break;
        }
      } catch {
        // The launcher compiles the canonical analyzer before producer use.
      }
    }
  }
  if (sharedDetectorCalibrationContract === undefined) {
    throw new Error(
      "The shared detector calibration condition contract is unavailable; build dist/schema before using the calibration producer."
    );
  }
  return sharedDetectorCalibrationContract;
}

export function calibrationMeasurementCondition(detector) {
  requireDetector(detector, "calibration detector");
  return structuredClone(
    detectorCalibrationContract().detectorCalibrationMeasurementCondition(
      detector
    )
  );
}

function detectorCausalInputsContract() {
  if (sharedDetectorCausalInputsContract === undefined) {
    for (const candidate of [
      "../dist/schema/lib/detector-causal-inputs.js",
      "../.unit-test-dist/lib/detector-causal-inputs.js"
    ]) {
      try {
        const loaded = requireFromCalibrationStudy(candidate);
        if (
          typeof loaded.evaluateDetectorCausalInputs === "function" &&
          isRecord(loaded.DETECTOR_CAUSAL_INPUTS)
        ) {
          sharedDetectorCausalInputsContract = loaded;
          break;
        }
      } catch {
        // The launcher compiles the canonical contract before producer use.
      }
    }
  }
  if (sharedDetectorCausalInputsContract === undefined) {
    throw new Error(
      "The shared detector causal-input contract is unavailable; build dist/schema before using the calibration producer."
    );
  }
  return sharedDetectorCausalInputsContract;
}

function r2EvaluatorContract() {
  if (sharedR2EvaluatorContract === undefined) {
    for (const candidate of [
      "../dist/schema/lib/scan-report-v2-r2-evaluators.js",
      "../.unit-test-dist/lib/scan-report-v2-r2-evaluators.js"
    ]) {
      try {
        const loaded = requireFromCalibrationStudy(candidate);
        if (
          typeof loaded.deriveChoiceStateR2 === "function" &&
          typeof loaded.deriveReverifiedAfterReloadR2 === "function"
        ) {
          sharedR2EvaluatorContract = loaded;
          break;
        }
      } catch {
        // The launcher compiles the canonical r2 evaluator before producer use.
      }
    }
  }
  if (sharedR2EvaluatorContract === undefined) {
    throw new Error(
      "The shared r2 consent evaluator is unavailable; build dist/schema before using the calibration producer."
    );
  }
  return sharedR2EvaluatorContract;
}

export function calibrationRatePublicationEligibility() {
  return structuredClone(
    measurementBindingContract()
      .measurementCalibrationRatePublicationEligibility()
  );
}

export function canonicalizeCalibrationValue(value) {
  if (sharedCanonicalSerializer === undefined) {
    for (const candidate of [
      "../dist/schema/lib/canonical-json.js",
      "../.unit-test-dist/lib/canonical-json.js"
    ]) {
      try {
        const loaded = requireFromCalibrationStudy(candidate);
        if (typeof loaded.canonicalJson === "function") {
          sharedCanonicalSerializer = loaded.canonicalJson;
          break;
        }
      } catch {
        // The workflow builds dist/schema once before invoking this producer;
        // the unit lane has the same shared module in .unit-test-dist.
      }
    }
  }
  if (sharedCanonicalSerializer === undefined) {
    throw new Error(
      "The shared canonical JSON module is unavailable; build dist/schema before using the calibration producer."
    );
  }
  return sharedCanonicalSerializer(value);
}

export function canonicalPrettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function detectorCalibrationRuntimeDigest(runtimeWithoutDigest) {
  return sha256Hex(canonicalizeCalibrationValue(runtimeWithoutDigest));
}

export function parseStrictJsonBuffer(buffer, label, maximum = MAX_JSON_BYTES) {
  if (!Buffer.isBuffer(buffer) || buffer.byteLength <= 0 || buffer.byteLength > maximum) {
    throw new Error(`${label} must be non-empty JSON no larger than ${maximum} bytes`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
  const duplicate = duplicateJsonKey(text);
  if (duplicate !== null) throw new Error(`${label} repeats JSON object key ${duplicate}`);
  try {
    return { value: JSON.parse(text), text };
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

export function readJsonFile(file, label, maximum = MAX_JSON_BYTES) {
  return parseStrictJsonBuffer(readRegularNoFollow(file, maximum, label), label, maximum);
}

export function calibrationCandidateScaffold(planInput) {
  const plan = validatePlan(planInput);
  const studyRoot = `calibration/${plan.studyId}`;
  const framePath = `${studyRoot}/frame.json`;
  const policyPath = CALIBRATION_CENSORING_POLICY_PATH;
  const preregistrationPath = `${studyRoot}/preregistration.json`;
  const frame = {
    schemaVersion: 2,
    artifactKind: "site-behavior-detector-calibration-sampling-frame",
    studyId: plan.studyId,
    detector: plan.detector,
    selectionProtocolDigest: sha256Hex(plan.design.selectionProtocol),
    measurementCondition: plan.design.measurementCondition,
    labelSealingKey: plan.labelSealingKey,
    cases: plan.cases.map((entry) => ({
      caseId: entry.caseId,
      selectionDigest: entry.selectionDigest,
      conditionDigest: entry.conditionDigest,
      referenceEvidenceDigest: entry.referenceEvidenceDigest
    }))
  };
  const frameText = canonicalPrettyJson(frame);
  // The policy artifact has ONE producer (calibration-policy-artifact-lib);
  // the scaffold copies the repository-committed approved bytes into the
  // candidate tree rather than restating any field of them.
  const policyText = readFileSync(
    path.join(calibrationStudyRootDir, CALIBRATION_CENSORING_POLICY_PATH),
    "utf8"
  );
  const design = {
    sampling: plan.design.sampling,
    samplingFrame: framePath,
    samplingFrameDigest: sha256Hex(frameText),
    selectionProtocol: plan.design.selectionProtocol,
    referenceProtocol: plan.design.referenceProtocol,
    referenceProtocolDigest: sha256Hex(plan.design.referenceProtocol),
    adjudicationProtocol: plan.design.adjudicationProtocol,
    adjudicationProtocolDigest: sha256Hex(plan.design.adjudicationProtocol),
    measurementCondition: plan.design.measurementCondition,
    independentUnits: plan.design.independentUnits,
    predictionBlindedToReference: plan.design.predictionBlindedToReference,
    referenceBlindedToPrediction: plan.design.referenceBlindedToPrediction
  };
  const preregistration = {
    schemaVersion: 2,
    artifactKind: "site-behavior-detector-calibration-preregistration",
    studyId: plan.studyId,
    detector: plan.detector,
    declaredAt: plan.declaredAt,
    targetPopulation: plan.targetPopulation,
    plannedCases: plan.cases.length,
    censoringPolicy: {
      id: CALIBRATION_CENSORING_POLICY_ID,
      path: policyPath,
      sha256: sha256Hex(policyText)
    },
    design
  };
  return {
    studyId: plan.studyId,
    detector: plan.detector,
    files: [
      { path: policyPath, text: policyText, sha256: sha256Hex(policyText) },
      { path: framePath, text: frameText, sha256: sha256Hex(frameText) },
      {
        path: preregistrationPath,
        text: canonicalPrettyJson(preregistration),
        sha256: sha256Hex(canonicalPrettyJson(preregistration))
      }
    ].sort((left, right) => left.path.localeCompare(right.path)),
    frame,
    policy: JSON.parse(policyText),
    preregistration
  };
}

export function writeCalibrationCandidateScaffold(rootDir, scaffold) {
  const root = realpathSync(rootDir);
  for (const file of scaffold.files) {
    const destination = repoPath(root, file.path);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    if (
      file.path === CALIBRATION_CENSORING_POLICY_PATH &&
      existsSync(destination)
    ) {
      const existing = readJsonFile(destination, file.path);
      require(
        existing.text === file.text,
        "the shared calibration censoring policy already exists with different bytes"
      );
    } else {
      writeFileSync(destination, file.text, { flag: "wx", mode: 0o644 });
    }
  }
}

export function validateCalibrationCandidateFiles(rootDir, studyId) {
  requireToken(studyId, "studyId");
  const base = path.join(rootDir, "calibration", studyId);
  const preregistrationRead = readJsonFile(
    path.join(base, "preregistration.json"),
    "calibration preregistration"
  );
  const frameRead = readJsonFile(path.join(base, "frame.json"), "calibration frame");
  const policyRead = readJsonFile(
    path.join(rootDir, ...CALIBRATION_CENSORING_POLICY_PATH.split("/")),
    "calibration censoring policy"
  );
  requireCanonical(preRegistrationObject(preregistrationRead.value, studyId), preregistrationRead.text, "calibration preregistration");
  requireCanonical(frameObject(frameRead.value, studyId), frameRead.text, "calibration frame");
  requireCanonical(policyAssignmentsObject(policyRead.value), policyRead.text, "calibration censoring policy");
  // ONE derivation home: the candidate-resident artifact must be byte-equal
  // to the repository-committed artifact the producer emitted; every deeper
  // shape/value check lives in the TS binding verifier and the producer's
  // --check, never restated here.
  require(
    policyRead.text ===
      readFileSync(path.join(calibrationStudyRootDir, CALIBRATION_CENSORING_POLICY_PATH), "utf8"),
    "candidate censoring-policy assignments do not equal the repository-committed artifact"
  );
  const preregistration = preregistrationRead.value;
  const frame = frameRead.value;
  const policy = policyRead.value;
  const labelSealingKey = labelSealingKeyObject(
    frame.labelSealingKey,
    studyId
  );
  const publicKeyRead = readRegularNoFollow(
    repoPath(rootDir, labelSealingKey.publicKeyPath),
    64 * 1024,
    "calibration label-sealing public key"
  );
  require(
    sha256Hex(publicKeyRead) === labelSealingKey.publicKeySha256,
    "calibration label-sealing public-key bytes do not match the frozen frame digest"
  );
  let parsedPublicKey;
  try {
    parsedPublicKey = createPublicKey(publicKeyRead);
  } catch {
    throw new Error("calibration label-sealing public key must be a valid PEM public key");
  }
  require(
    parsedPublicKey.asymmetricKeyType === "rsa" &&
      (parsedPublicKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048,
    "calibration label-sealing public key must be RSA with at least 2048 bits"
  );
  const canonicalPublicKeyPem = parsedPublicKey
    .export({ format: "pem", type: "spki" })
    .toString("utf8");
  require(
    publicKeyRead.toString("utf8") === canonicalPublicKeyPem,
    "calibration label-sealing public key must use canonical SPKI PEM bytes"
  );
  require(
    sha256Hex(
      parsedPublicKey.export({ format: "der", type: "spki" })
    ) === labelSealingKey.keyId,
    "calibration label-sealing public-key identity does not match the frozen frame"
  );
  require(preregistration.detector === frame.detector, "candidate detector disagrees between preregistration and frame");
  // The per-detector disposition binds the CLASSIC ceremony path too: a
  // held detector cannot be scaffolded, preflighted, acquired, or
  // assembled, not only refused by the v4 pilot CLIs.
  {
    const detectorRow = policyRead.value.detectors?.[preregistration.detector];
    require(isRecord(detectorRow), `the policy assignments carry no row for detector ${preregistration.detector}`);
    require(
      detectorRow.disposition === "proceed",
      `detector ${preregistration.detector} is dispositioned "${detectorRow.disposition}" and cannot enter a ceremony${detectorRow.holdReason ? `: ${detectorRow.holdReason}` : ""}`
    );
  }
  require(
    preregistration.plannedCases === frame.cases.length,
    "candidate frame must preserve the preregistered planned denominator"
  );
  require(
    preregistration.design.samplingFrame === `calibration/${studyId}/frame.json`,
    "preregistration must use its fixed frame path"
  );
  require(
    preregistration.design.samplingFrameDigest === sha256Hex(frameRead.text),
    "preregistration frame digest does not match candidate frame bytes"
  );
  require(
    frame.selectionProtocolDigest === sha256Hex(preregistration.design.selectionProtocol),
    "frame selectionProtocolDigest does not match preregistration"
  );
  require(
    canonicalizeCalibrationValue(frame.measurementCondition) ===
      canonicalizeCalibrationValue(
        preregistration.design.measurementCondition
      ),
    "frame measurementCondition does not match preregistration"
  );
  require(
    preregistration.censoringPolicy.path ===
      CALIBRATION_CENSORING_POLICY_PATH &&
      preregistration.censoringPolicy.id === CALIBRATION_CENSORING_POLICY_ID &&
      preregistration.censoringPolicy.sha256 === sha256Hex(policyRead.text),
    "preregistration censoring-policy binding is invalid"
  );
  const frameById = new Map();
  let priorCaseId = "";
  for (const [index, entry] of frame.cases.entries()) {
    exactKeys(entry, FRAME_CASE_KEYS, `frame.cases[${index}]`);
    const caseId = requireToken(entry.caseId, `frame.cases[${index}].caseId`);
    require(caseId.localeCompare(priorCaseId) > 0, "frame case ids must be unique and sorted");
    priorCaseId = caseId;
    requireDigest(entry.selectionDigest, `frame.cases[${index}].selectionDigest`);
    requireDigest(entry.conditionDigest, `frame.cases[${index}].conditionDigest`);
    requireDigest(
      entry.referenceEvidenceDigest,
      `frame.cases[${index}].referenceEvidenceDigest`
    );
    const pair =
      `${entry.selectionDigest}:${entry.conditionDigest}:` +
      entry.referenceEvidenceDigest;
    require(
      ![...frameById.values()].some((value) => value.pair === pair),
      "frame selection and condition digest pairs must be unique"
    );
    frameById.set(caseId, { ...entry, pair });
  }
  return {
    studyId,
    detector: preregistration.detector,
    preregistration,
    preregistrationText: preregistrationRead.text,
    preregistrationSha256: sha256Hex(preregistrationRead.text),
    frame,
    frameText: frameRead.text,
    frameSha256: sha256Hex(frameRead.text),
    policy,
    policyText: policyRead.text,
    policySha256: sha256Hex(policyRead.text),
    labelSealingKey,
    labelSealingPublicKeyPem: canonicalPublicKeyPem,
    frameById
  };
}

/**
 * The smallest case count that could satisfy all four class denominators.
 *
 * The four minimums are NOT four separate populations. They are two partitions
 * of the SAME N cases:
 *
 *   referencePresent  + referenceAbsent       = N   (how the reference split it)
 *   predictedDetected + predictedNotDetected  = N   (how the detector split it)
 *
 * So summing all four counts every case twice and yields 2N. The old preflight
 * did exactly that and then compared the result against N, demanding 400 cases
 * where the structure requires 200 -- a floor twice as high as anything the
 * final gate enforces, blocking designs the project's own power analysis
 * justifies (the CNAME design sizes N ~ 350 from the pool's base rate, which
 * the 400 floor rejected while being no more valid).
 *
 * This is a FLOOR, not a sample size. It says only that fewer cases cannot
 * possibly fill the four classes; it never says a design this size is adequate.
 * Real sizing comes from the detector's prevalence and the recall it must
 * tolerate, and is argued per study in its preregistration. The final gate is
 * unchanged and stricter: every one of the four denominators must independently
 * reach its minimum on the labeled data, and every Wilson 95% interval must
 * meet the policy's maximum half-width.
 */
export function structuralMinimumCasesFor(minimumDenominators) {
  const partitions = [
    ["referencePresent", "referenceAbsent"],
    ["predictedDetected", "predictedNotDetected"]
  ];
  return Math.max(
    ...partitions.map(([a, b]) => {
      require(
        Number.isInteger(minimumDenominators?.[a]) &&
          Number.isInteger(minimumDenominators?.[b]),
        `rate-publication policy must declare integer minimums for ${a} and ${b}`
      );
      return minimumDenominators[a] + minimumDenominators[b];
    })
  );
}

export function assertCalibrationCandidateCanSatisfyRatePolicy(candidate) {
  require(
    isRecord(candidate?.preregistration) &&
      isRecord(candidate.preregistration.design),
    "validated calibration candidate is required"
  );
  const eligibility = calibrationRatePublicationEligibility();
  const design = candidate.preregistration.design;
  const structuralMinimumCases = structuralMinimumCasesFor(
    eligibility.minimumDenominators
  );
  require(
    design.sampling === eligibility.sampling &&
      design.independentUnits === eligibility.independentUnits &&
      design.predictionBlindedToReference ===
        eligibility.predictionBlindedToReference &&
      design.referenceBlindedToPrediction ===
        eligibility.referenceBlindedToPrediction,
    "calibration candidate design cannot satisfy the approved simple-random, independent, mutually blinded rate-publication policy"
  );
  require(
    candidate.preregistration.plannedCases >= structuralMinimumCases,
    `calibration candidate plans ${candidate.preregistration.plannedCases} cases, below the structural pre-labeling minimum ${structuralMinimumCases}`
  );
  return {
    plannedCases: candidate.preregistration.plannedCases,
    structuralMinimumCases,
    ratePublicationEligibility: eligibility
  };
}

export function calibrationPolicyDispositionSha256(policyArtifactSha256, policyValue) {
  requireDigest(
    policyArtifactSha256,
    "calibration censoring policy artifact digest"
  );
  const contract = measurementBindingContract();
  return contract.measurementCalibrationPolicyAssignmentsDispositionSha256({
    policyArtifactSha256,
    analyzerVersion: policyValue.analyzerVersion,
    detectors: contract.measurementCalibrationAssignmentsSemanticProjection(policyValue)
  });
}

export function assertCalibrationDecisionApproved(
  readiness,
  policyArtifactSha256,
  policyValue,
  now = new Date()
) {
  require(isRecord(readiness), "release readiness manifest must be an object");
  require(isRecord(readiness.decisions), "release readiness decisions are missing");
  const decision = readiness.decisions.calibrationCensoringPolicy;
  require(isRecord(decision), "calibrationCensoringPolicy decision is missing");
  const expectedPolicySha256 = requireDigest(
    policyArtifactSha256,
    "candidate calibration censoring policy digest"
  );
  require(isRecord(policyValue), "the parsed censoring-policy assignments artifact is required");
  const expectedDispositionSha256 =
    calibrationPolicyDispositionSha256(expectedPolicySha256, policyValue);
  require(
    decision.status === "approved" &&
      decision.selected === CALIBRATION_CENSORING_POLICY_ID &&
      decision.policyArtifactPath === CALIBRATION_CENSORING_POLICY_PATH &&
      decision.policyArtifactSha256 === expectedPolicySha256 &&
      decision.dispositionSha256 === expectedDispositionSha256,
    "calibrationCensoringPolicy must explicitly approve the exact candidate policy and analyzer disposition before acquisition or labeling"
  );
  requireText(decision.decidedBy, "calibrationCensoringPolicy.decidedBy", 200);
  const decidedAt = requireInstant(
    decision.decidedAt,
    "calibrationCensoringPolicy.decidedAt"
  );
  require(
    Date.parse(decidedAt) <= now.getTime(),
    "calibrationCensoringPolicy.decidedAt cannot be in the future"
  );
  return {
    selected: decision.selected,
    policyArtifactPath: decision.policyArtifactPath,
    policyArtifactSha256: expectedPolicySha256,
    dispositionSha256: expectedDispositionSha256,
    decidedBy: decision.decidedBy,
    decidedAt
  };
}

export function assertCalibrationWorkflowPreflight(input) {
  const candidate = requireFullSha(input.candidateCommit, "candidate commit");
  const carrier = requireFullSha(input.carrierCommit, "carrier commit");
  const eventCommit = requireFullSha(input.eventCommit, "Actions head commit");
  require(candidate === input.binding?.candidateCommit, "requested candidate does not match the verified measurement binding");
  require(carrier === input.binding?.carrierCommit, "requested carrier does not match the verified measurement binding");
  require(eventCommit === carrier, "Actions head must equal the verified evidence carrier");
  require(
    Array.isArray(input.binding?.acceptedProducerCommits) &&
      input.binding.acceptedProducerCommits.includes(carrier),
    "Actions head is not an accepted evidence producer commit"
  );
  require(
    input.measurementFreeze === "1",
    "SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE must be exactly 1"
  );
  if (input.phase === "acquisition") {
    require(
      input.runnerEnvironment === "self-hosted",
      "calibration acquisition requires a controlled self-hosted runner"
    );
  } else {
    require(
      input.phase === "dispatch",
      "calibration preflight phase must be dispatch or acquisition"
    );
  }
  const runnerLabel = requireText(input.runnerLabel, "controlled runner label", 200);
  require(
    runnerLabel !== "ubuntu-latest" && runnerLabel !== "self-hosted",
    "controlled runner label must be a dedicated custom label"
  );
  require(
    input.egressIdentity === "controlled-self-hosted",
    "calibration acquisition requires SCANNER_EGRESS=controlled-self-hosted"
  );
  const egressRegion = requireText(input.egressRegion, "controlled egress region", 200);
  require(egressRegion.toLowerCase() !== "unknown", "controlled egress region cannot be unknown");
  require(
    input.egressAttested === "1",
    "FEATURED_R2_EGRESS_ATTESTED must be exactly 1"
  );
  return { candidateCommit: candidate, carrierCommit: carrier, runnerLabel, egressRegion };
}

export function validateCalibrationCaseInputs(input) {
  const { candidate, caseInputRoot } = input;
  const root = realpathSync(caseInputRoot);
  const observed = exactRelativeFiles(root);
  const expected = [];
  const cases = [];
  for (const [caseId, frameCase] of candidate.frameById.entries()) {
    const prefix = `cases/${caseId}`;
    const selectionPath = `${prefix}/selection.json`;
    const conditionPath = `${prefix}/condition.json`;
    expected.push(selectionPath, conditionPath);
    const selectionRead = readJsonFile(repoPath(root, selectionPath), `${caseId} selection`);
    const conditionRead = readJsonFile(repoPath(root, conditionPath), `${caseId} condition`);
    require(
      sha256Hex(selectionRead.text) === frameCase.selectionDigest,
      `${caseId} selection bytes do not match the frozen frame`
    );
    require(
      sha256Hex(conditionRead.text) === frameCase.conditionDigest,
      `${caseId} condition bytes do not match the frozen frame`
    );
    const selection = selectionObject(
      selectionRead.value,
      candidate.studyId,
      candidate.detector,
      caseId
    );
    const condition = conditionObject(
      conditionRead.value,
      candidate.studyId,
      candidate.detector,
      caseId,
      candidate.preregistration.design.measurementCondition
    );
    requireCanonical(selection, selectionRead.text, `${caseId} selection`);
    requireCanonical(condition, conditionRead.text, `${caseId} condition`);
    cases.push({
      caseId,
      selection,
      selectionText: selectionRead.text,
      condition,
      conditionText: conditionRead.text,
      selectionDigest: frameCase.selectionDigest,
      conditionDigest: frameCase.conditionDigest,
      referenceEvidenceDigest: frameCase.referenceEvidenceDigest
    });
  }
  expected.sort();
  require(
    JSON.stringify(observed) === JSON.stringify(expected),
    "acquisition input root must contain exactly selection and condition JSON for every frozen case"
  );
  return cases;
}

/**
 * Build one hosted, identity-bearing ciphertext commitment. The envelope has
 * already been sealed locally with the candidate-pinned public key; this
 * function never receives label plaintext or a reveal key.
 */
export function createCalibrationLabelCommitment(input) {
  const candidate = input.candidate;
  const candidateCommit = requireFullSha(
    input.candidateCommit,
    "label commitment candidateCommit"
  );
  const producer = calibrationLabelProducer(
    input.producer,
    "label commitment producer",
    input.expectedWorkflowPath ?? CALIBRATION_LABEL_WORKFLOW_PATH
  );
  const envelope = calibrationLabelEnvelopeIdentity(
    input.envelope,
    candidate,
    input.role,
    candidateCommit,
    producer.actor
  );
  const source = calibrationLabelSourceProvenance(
    input.sourceProvenance,
    "label commitment source"
  );
  const envelopeSha256 = calibrationLabelCommitmentEnvelopeDigest(envelope);
  const commitment = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_COMMITMENT_KIND,
    role: envelope.role,
    studyId: envelope.studyId,
    detector: envelope.detector,
    candidateCommit: envelope.candidateCommit,
    keyId: envelope.keyId,
    producer,
    source,
    envelopeSha256,
    envelope
  };
  return {
    commitment,
    text: canonicalPrettyJson(commitment)
  };
}

/**
 * The commitment record's envelope digest, in ONE place.
 *
 * It is minted here, re-verified by the v3 record validator, and checked
 * again by the v4 pilot close, which reads records an operator hands it
 * rather than records an authenticated fetcher produced. Three statements of
 * `sha256Hex(canonicalPrettyJson(envelope))` would be three chances for a
 * record's self-reported digest to be believed by one of them.
 */
export function calibrationLabelCommitmentEnvelopeDigest(envelope) {
  return sha256Hex(canonicalPrettyJson(envelope));
}

export function validateCalibrationLabelCommitment(
  value,
  candidate,
  expectedCandidateCommit,
  expectedWorkflowPath = CALIBRATION_LABEL_WORKFLOW_PATH
) {
  require(isRecord(value), "calibration label commitment must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "role",
      "studyId",
      "detector",
      "candidateCommit",
      "keyId",
      "producer",
      "source",
      "envelopeSha256",
      "envelope"
    ],
    "calibration label commitment"
  );
  require(
    value.schemaVersion === 1 &&
      value.artifactKind === CALIBRATION_LABEL_COMMITMENT_KIND,
    "calibration label commitment identity is invalid"
  );
  const candidateCommit = requireFullSha(
    expectedCandidateCommit,
    "calibration label commitment expected candidateCommit"
  );
  const producer = calibrationLabelProducer(
    value.producer,
    "calibration label commitment producer",
    expectedWorkflowPath
  );
  const envelope = calibrationLabelEnvelopeIdentity(
    value.envelope,
    candidate,
    value.role,
    candidateCommit,
    producer.actor
  );
  require(
    value.studyId === envelope.studyId &&
      value.detector === envelope.detector &&
      value.candidateCommit === envelope.candidateCommit &&
      value.keyId === envelope.keyId,
    "calibration label commitment wrapper disagrees with its sealed identity"
  );
  const source = calibrationLabelSourceProvenance(
    value.source,
    "calibration label commitment source"
  );
  const envelopeSha256 = requireDigest(
    value.envelopeSha256,
    "calibration label commitment envelopeSha256"
  );
  require(
    envelopeSha256 === calibrationLabelCommitmentEnvelopeDigest(envelope),
    "calibration label commitment envelope digest is invalid"
  );
  return {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_COMMITMENT_KIND,
    role: envelope.role,
    studyId: envelope.studyId,
    detector: envelope.detector,
    candidateCommit,
    keyId: envelope.keyId,
    producer,
    source,
    envelopeSha256,
    envelope
  };
}

export function validateCalibrationLabelSource(
  value,
  candidate,
  expectedRole,
  expectedCandidateCommit
) {
  require(isRecord(value), "calibration label batch source must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "role",
      "studyId",
      "detector",
      "candidateCommit",
      "cases"
    ],
    "calibration label source"
  );
  require(
    value.schemaVersion === 1 &&
      value.artifactKind === CALIBRATION_LABEL_BATCH_SOURCE_KIND &&
      (value.role === "labeler" || value.role === "tiebreaker") &&
      value.role === expectedRole &&
      value.studyId === candidate.studyId &&
      value.detector === candidate.detector,
    "calibration label source identity is invalid"
  );
  const candidateCommit = requireFullSha(
    value.candidateCommit,
    "calibration label source candidateCommit"
  );
  require(
    candidateCommit ===
      requireFullSha(
        expectedCandidateCommit,
        "calibration label source expected candidateCommit"
      ),
    "calibration label source candidateCommit does not match the sealed candidate"
  );
  require(
    Array.isArray(value.cases) &&
      value.cases.length >= 1 &&
      value.cases.length <= candidate.frame.cases.length,
    "calibration label source cases are outside the frozen frame"
  );
  const cases = [];
  const blindingNonces = new Set();
  let prior = "";
  for (const [index, rawCase] of value.cases.entries()) {
    const label = `calibration label source cases[${index}]`;
    require(isRecord(rawCase), `${label} must be an object`);
    const caseId = requireToken(rawCase.caseId, `${label}.caseId`);
    require(
      caseId.localeCompare(prior) > 0,
      "calibration label batch case ids must be unique and sorted"
    );
    prior = caseId;
    const frameCase = candidate.frameById.get(caseId);
    require(frameCase !== undefined, `${label} is outside the frozen frame`);
    exactKeys(rawCase, ["caseId", "referenceEvidence", "value"], label);
    const referenceEvidence = referenceEvidenceObject(
      rawCase.referenceEvidence,
      candidate.studyId,
      candidate.detector,
      caseId
    );
    require(
      !blindingNonces.has(referenceEvidence.blindingNonce),
      "reference evidence blinding nonces must be unique across the frozen frame"
    );
    blindingNonces.add(referenceEvidence.blindingNonce);
    const evidenceText = canonicalPrettyJson(referenceEvidence);
    require(
      sha256Hex(evidenceText) === frameCase.referenceEvidenceDigest,
      `${caseId} reference evidence does not match the frozen frame digest`
    );
    require(
      rawCase.value === "present" || rawCase.value === "absent",
      `${caseId} label value is invalid`
    );
    const presenceFact = referenceEvidence.observations.find(
      (entry) => entry.fact === `${candidate.detector}-presence`
    );
    if (value.role === "tiebreaker") {
      require(
        presenceFact?.value === (rawCase.value === "present"),
        `${caseId} blind-tiebreaker value must match the detector-presence reference fact`
      );
    }
    cases.push({
      caseId,
      referenceEvidence,
      value: rawCase.value
    });
  }
  require(
    cases.length === candidate.frame.cases.length &&
      cases.every(
        (entry, index) =>
          entry.caseId === candidate.frame.cases[index].caseId
      ),
    "each pre-acquisition label or blind-tiebreaker source must cover the complete frozen frame"
  );
  return {
    schemaVersion: 1,
    artifactKind: CALIBRATION_LABEL_BATCH_SOURCE_KIND,
    role: value.role,
    studyId: candidate.studyId,
    detector: candidate.detector,
    candidateCommit,
    cases
  };
}

function calibrationLabelProducer(
  value,
  label,
  expectedWorkflowPath = CALIBRATION_LABEL_WORKFLOW_PATH
) {
  require(isRecord(value), `${label} must be an object`);
  exactKeys(
    value,
    [
      "repository",
      "workflowPath",
      "workflowRef",
      "runId",
      "runAttempt",
      "headSha",
      "actor",
      "triggeringActor"
    ],
    label
  );
  const producer = {
    repository: requireText(value.repository, `${label} repository`, 200),
    workflowPath: requireText(value.workflowPath, `${label} workflowPath`, 300),
    workflowRef: requireText(value.workflowRef, `${label} workflowRef`, 300),
    runId: requirePositiveInteger(value.runId, `${label} runId`),
    runAttempt: requirePositiveInteger(value.runAttempt, `${label} runAttempt`),
    headSha: requireFullSha(value.headSha, `${label} headSha`),
    actor: requireGithubLogin(value.actor, `${label} actor`),
    triggeringActor: requireGithubLogin(
      value.triggeringActor,
      `${label} triggeringActor`
    )
  };
  require(
    producer.repository === "iAnonymous3000/site-behavior-lab" &&
      producer.workflowPath === expectedWorkflowPath &&
      producer.workflowRef === "refs/heads/main" &&
      producer.runAttempt <= 100 &&
      producer.actor === producer.triggeringActor,
    `${label} must be one non-delegated main-branch hosted workflow actor`
  );
  return producer;
}

function calibrationLabelSourceProvenance(value, label) {
  require(isRecord(value), `${label} must be an object`);
  exactKeys(value, ["commit", "tree", "path", "sha256"], label);
  return {
    commit: requireFullSha(value.commit, `${label} commit`),
    tree: requireFullSha(value.tree, `${label} tree`),
    path: requireArtifactPath(value.path, `${label} path`),
    sha256: requireDigest(value.sha256, `${label} sha256`)
  };
}

function calibrationLabelEnvelopeIdentity(
  value,
  candidate,
  expectedRole,
  expectedCandidateCommit,
  expectedActor
) {
  require(isRecord(value), "calibration label source envelope must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "role",
      "candidateCommit",
      "reviewerLogin",
      "algorithm",
      "keyId",
      "encryptedKey",
      "iv",
      "ciphertext",
      "authTag"
    ],
    "calibration label source envelope"
  );
  require(
    value.schemaVersion === 1 &&
      value.artifactKind ===
        "site-behavior-detector-calibration-label-source-envelope" &&
      (value.role === "labeler" || value.role === "tiebreaker") &&
      value.role === expectedRole &&
      value.studyId === candidate.studyId &&
      value.detector === candidate.detector &&
      value.candidateCommit === expectedCandidateCommit &&
      value.reviewerLogin === expectedActor &&
      value.algorithm === CALIBRATION_LABEL_SEALING_ALGORITHM &&
      value.keyId === candidate.labelSealingKey.keyId,
    "calibration label source envelope identity does not match the authenticated actor and frozen candidate"
  );
  for (const field of ["encryptedKey", "iv", "ciphertext", "authTag"]) {
    require(
      typeof value[field] === "string" &&
        value[field].length >= 1 &&
        value[field].length <= 48 * 1024 * 1024,
      `calibration label source envelope ${field} is outside bounds`
    );
  }
  return value;
}

export function detectorPredictionFromRun(run, detector) {
  requireDetector(detector, "calibration detector");
  require(
    detector !== "consent-banner",
    "consent-banner prediction requires the process-local calibration result; public CMP/request evidence cannot substitute"
  );
  require(isRecord(run), "scan run must be an object");
  const ledger = run.detectors?.[detector];
  require(isRecord(ledger), `scan run is missing detector ledger entry ${detector}`);
  if (run.quality?.run?.outcome !== "complete") {
    return { outcome: "censored", reason: "capture-failed" };
  }
  if (ledger.status !== "complete") {
    return { outcome: "censored", reason: "eligibility-criteria-not-met" };
  }
  // A finished stage is not a whole prediction: a censored requests family cuts
  // the candidate hosts cname-uncloaking never saw, while its ledger still
  // reads complete. Fails closed, including on a run with no family ledger.
  //
  // The reason is `capture-failed` because the four allowed reasons are pinned
  // byte-for-byte in the candidate-resident policy artifact, and this scope
  // does not move that digest. The cost is real and is recorded here rather
  // than discovered later: the attempt artifact cannot distinguish "the page
  // never loaded" from "the recording cap ate the candidate set". That second
  // signal lives in the retained source report's captureLoss ledger, which is
  // what the binding verifier recomputes from.
  const causalInputs = detectorCausalInputsContract().evaluateDetectorCausalInputs(
    run,
    detector
  );
  if (!causalInputs.complete) {
    return { outcome: "censored", reason: "capture-failed" };
  }
  const evidence = run.evidence;
  require(isRecord(evidence), "scan run evidence must be an object");
  let detected;
  if (detector === "fingerprint-heuristics") {
    require(Array.isArray(evidence.fingerprintDetections), "fingerprint detections are missing");
    detected = evidence.fingerprintDetections.some(
      (entry) => isRecord(entry) && entry.kind !== "keystroke-exfiltration"
    );
  } else if (detector === "keystroke-exfiltration") {
    require(Array.isArray(evidence.fingerprintDetections), "fingerprint detections are missing");
    detected = evidence.fingerprintDetections.some(
      (entry) => isRecord(entry) && entry.kind === "keystroke-exfiltration"
    );
  } else if (detector === "cname-uncloaking") {
    require(Array.isArray(evidence.cnameCloaks), "CNAME evidence is missing");
    detected = evidence.cnameCloaks.length > 0;
  } else if (detector === "pixel-events") {
    const consent = evidence.consent;
    let derivedChoiceState = null;
    let derivedReverifiedAfterReload = false;
    if (isRecord(consent)) {
      try {
        const evaluator = r2EvaluatorContract();
        derivedChoiceState = evaluator.deriveChoiceStateR2(run, consent);
        derivedReverifiedAfterReload =
          evaluator.deriveReverifiedAfterReloadR2(run, consent);
      } catch {
        // A malformed or incomplete retained consent ledger is ineligible,
        // never a reason to trust its producer-supplied summary fields.
      }
    }
    if (
      run.conditions?.consent !== "accept-all" ||
      !isRecord(consent) ||
      consent.mode !== "accept-all" ||
      consent.interactionAttempted !== true ||
      consent.controlActivated !== true ||
      consent.choiceState !== derivedChoiceState ||
      derivedChoiceState !== "verified" ||
      consent.reverifiedAfterReload !==
        derivedReverifiedAfterReload ||
      derivedReverifiedAfterReload !== true
    ) {
      return {
        outcome: "censored",
        reason: "eligibility-criteria-not-met"
      };
    }
    require(Array.isArray(evidence.pixelEvents), "pixel evidence is missing");
    detected = evidence.pixelEvents.length > 0;
  } else if (detector === "privacy-policy") {
    detected = evidence.privacyPolicy !== undefined;
  } else {
    throw new Error(`unsupported detector ${detector}`);
  }
  return { outcome: "complete", value: detected ? "detected" : "not-detected" };
}

export function createCalibrationAcquisition(input) {
  const {
    candidate,
    candidateCommit,
    carrierCommit,
    acquisitionAuthorization,
    rosterSelectionSnapshot,
    rosterSelectionSnapshotSha256,
    workflowRun,
    runner,
    egress,
    runtime,
    caseResults,
    startedAt,
    completedAt
  } = input;
  requireFullSha(candidateCommit, "acquisition candidateCommit");
  requireFullSha(carrierCommit, "acquisition carrierCommit");
  const authorization =
    validateCalibrationAcquisitionAuthorizationIdentity(
      acquisitionAuthorization
    );
  require(
    authorization.studyId === candidate.studyId &&
      authorization.detector === candidate.detector &&
      authorization.candidateCommit === candidateCommit,
    "acquisition authorization does not bind the candidate study and detector"
  );
  require(
    isRecord(rosterSelectionSnapshot) &&
      isRecord(rosterSelectionSnapshot.identity) &&
      isRecord(rosterSelectionSnapshot.selectedRun) &&
      Array.isArray(rosterSelectionSnapshot.runs) &&
      rosterSelectionSnapshot.runs.length === 1 &&
      rosterSelectionSnapshot.identity.studyId === candidate.studyId &&
      rosterSelectionSnapshot.identity.candidateCommit === candidateCommit &&
      rosterSelectionSnapshot.identity.caseInputRootSha256 ===
        authorization.caseInputRootSha256 &&
      rosterSelectionSnapshot.selectedRun.runId ===
        authorization.roster.runId &&
      rosterSelectionSnapshot.selectedRun.runAttempt === 1 &&
      rosterSelectionSnapshot.selectedRun.headSha ===
        authorization.roster.headSha &&
      rosterSelectionSnapshot.selectedRun.status === "completed" &&
      rosterSelectionSnapshot.selectedRun.conclusion === "success",
    "roster selection snapshot does not bind the unique terminal candidate authorization"
  );
  requireDigest(
    rosterSelectionSnapshotSha256,
    "roster selection snapshot sha256"
  );
  require(
    sha256Hex(canonicalPrettyJson(rosterSelectionSnapshot)) ===
      rosterSelectionSnapshotSha256,
    "roster selection snapshot digest does not match its canonical bytes"
  );
  requireInstant(startedAt, "acquisition startedAt");
  requireInstant(completedAt, "acquisition completedAt");
  require(Date.parse(completedAt) >= Date.parse(startedAt), "acquisition completedAt precedes startedAt");
  require(
    Date.parse(authorization.roster.artifactCreatedAt) <
      Date.parse(startedAt),
    "roster authorization artifact must predate acquisition"
  );
  const runId = requirePositiveInteger(workflowRun.id, "workflow run id");
  const runAttempt = requirePositiveInteger(workflowRun.attempt, "workflow run attempt");
  require(runAttempt <= 100, "workflow run attempt must be no greater than 100");
  require(
    runAttempt === authorization.authorizedRunAttempt,
    "acquisition workflow attempt is not the preauthorized attempt"
  );
  require(workflowRun.workflow === CALIBRATION_WORKFLOW, "acquisition workflow identity is invalid");
  require(workflowRun.headCommit === carrierCommit, "acquisition head commit must equal carrier commit");
  exactKeys(
    runner,
    ["labelSha256", "identitySha256", "environment"],
    "acquisition runner"
  );
  requireDigest(runner.labelSha256, "acquisition runner labelSha256");
  requireDigest(runner.identitySha256, "acquisition runner identitySha256");
  require(
    runner.environment === "ephemeral-self-hosted",
    "acquisition runner environment must be ephemeral-self-hosted"
  );
  exactKeys(egress, ["identity", "regionSha256"], "acquisition egress");
  require(egress.identity === "controlled-self-hosted", "acquisition egress identity is invalid");
  requireDigest(egress.regionSha256, "acquisition egress regionSha256");
  const runtimeCore = validateRuntime(runtime);
  const runtimeWithDigest = {
    ...runtimeCore,
    runtimeDigest: detectorCalibrationRuntimeDigest(runtimeCore)
  };
  require(
    Array.isArray(caseResults) &&
      caseResults.length === candidate.preregistration.plannedCases,
    "acquisition must retain every planned case"
  );
  const files = [];
  const cases = [];
  let priorCaseId = "";
  for (const result of [...caseResults].sort((left, right) => left.caseId.localeCompare(right.caseId))) {
    const caseId = requireToken(result.caseId, "acquisition case id");
    require(caseId.localeCompare(priorCaseId) > 0, "acquisition case ids must be unique and sorted");
    priorCaseId = caseId;
    const frozen = candidate.frameById.get(caseId);
    require(frozen !== undefined, `acquisition case ${caseId} is outside the frozen frame`);
    require(
      result.selectionDigest === frozen.selectionDigest &&
      typeof result.selectionText === "string" &&
        sha256Hex(result.selectionText) === frozen.selectionDigest,
      `${caseId} selection bytes changed after frame validation`
    );
    require(result.conditionDigest === frozen.conditionDigest, `${caseId} condition digest changed`);
    require(
      typeof result.conditionText === "string" &&
        sha256Hex(result.conditionText) === frozen.conditionDigest,
      `${caseId} condition bytes changed after frame validation`
    );
    parseStrictJsonBuffer(
      Buffer.from(result.selectionText),
      `${caseId} retained selection`
    );
    parseStrictJsonBuffer(
      Buffer.from(result.conditionText),
      `${caseId} retained condition`
    );
    const selectionPath = `cases/${caseId}/selection.json`;
    const conditionPath = `cases/${caseId}/condition.json`;
    const sourceReportPath = `cases/${caseId}/source-report.json`;
    const detectorObservationPath =
      `cases/${caseId}/detector-observation.json`;
    const selectionFile = fileRecord(selectionPath, result.selectionText);
    const conditionFile = fileRecord(conditionPath, result.conditionText);
    files.push(selectionFile, conditionFile);
    let sourceReport = null;
    if (result.sourceReportText !== null) {
      require(
        typeof result.sourceReportText === "string",
        `${caseId} source report bytes must be text or null`
      );
      parseStrictJsonBuffer(
        Buffer.from(result.sourceReportText),
        `${caseId} retained source report`
      );
      const sourceReportFile = fileRecord(
        sourceReportPath,
        result.sourceReportText
      );
      require(
        result.sourceReportSha256 === sourceReportFile.sha256,
        `${caseId} source report digest does not match retained bytes`
      );
      files.push(sourceReportFile);
      sourceReport = {
        path: sourceReportPath,
        sha256: sourceReportFile.sha256
      };
    } else {
      require(
        result.sourceReportSha256 === null,
        `${caseId} missing source report bytes cannot carry a digest`
      );
    }
    let detectorObservation = null;
    if (result.detectorObservationText !== null) {
      require(
        candidate.detector === "consent-banner" &&
          typeof result.detectorObservationText === "string",
        `${caseId} private detector observation is only valid for consent-banner`
      );
      const parsedObservation = parseStrictJsonBuffer(
        Buffer.from(result.detectorObservationText),
        `${caseId} retained private detector observation`
      ).value;
      validateConsentDetectorObservation(
        parsedObservation,
        candidate,
        caseId,
        sourceReport?.sha256
      );
      requireCanonical(
        parsedObservation,
        result.detectorObservationText,
        `${caseId} retained private detector observation`
      );
      const observationFile = fileRecord(
        detectorObservationPath,
        result.detectorObservationText
      );
      files.push(observationFile);
      detectorObservation = {
        path: detectorObservationPath,
        sha256: observationFile.sha256
      };
    }
    const retainedInputs = {
      selectionDigest: frozen.selectionDigest,
      conditionDigest: frozen.conditionDigest,
      selection: {
        path: selectionPath,
        sha256: selectionFile.sha256
      },
      condition: {
        path: conditionPath,
        sha256: conditionFile.sha256
      },
      sourceReport,
      detectorObservation
    };
    const recordedAt = requireInstant(
      result.recordedAt,
      `${caseId} acquisition recordedAt`
    );
    require(
      Date.parse(recordedAt) >= Date.parse(startedAt) &&
        Date.parse(recordedAt) <= Date.parse(completedAt),
      `${caseId} acquisition recordedAt is outside the acquisition window`
    );
    if (result.outcome === "complete") {
      require(
        candidate.detector !== "consent-banner" ||
          detectorObservation !== null,
        `${caseId} complete consent-banner case must retain its private detector observation`
      );
      require(
        result.prediction === "detected" || result.prediction === "not-detected",
        `${caseId} prediction is invalid`
      );
      const predictionPath = `cases/${caseId}/prediction.json`;
      const prediction = {
        schemaVersion: 1,
        artifactKind: "site-behavior-detector-calibration-prediction",
        studyId: candidate.studyId,
        detector: candidate.detector,
        caseId,
        conditionDigest: result.conditionDigest,
        sourceReportSha256: requireDigest(
          result.sourceReportSha256,
          `${caseId} source report digest`
        ),
        value: result.prediction,
        recordedAt
      };
      const predictionText = canonicalPrettyJson(prediction);
      files.push(fileRecord(predictionPath, predictionText));
      cases.push({
        caseId,
        outcome: "complete",
        ...retainedInputs,
        prediction: {
          path: predictionPath,
          sha256: sha256Hex(predictionText),
          value: result.prediction
        }
      });
    } else if (result.outcome === "censored") {
      require(
        detectorObservation === null,
        `${caseId} censored case cannot carry a completed private detector observation`
      );
      require(
        CALIBRATION_CENSOR_REASONS.includes(result.reason),
        `${caseId} censor reason is invalid`
      );
      const attemptPath = `cases/${caseId}/attempt.json`;
      const attempt = {
        schemaVersion: 1,
        artifactKind: "site-behavior-detector-calibration-attempt",
        studyId: candidate.studyId,
        detector: candidate.detector,
        caseId,
        conditionDigest: result.conditionDigest,
        outcome: "censored",
        reason: result.reason,
        sourceReportSha256:
          result.sourceReportSha256 === null
            ? null
            : requireDigest(result.sourceReportSha256, `${caseId} attempt source report digest`),
        recordedAt
      };
      const attemptText = canonicalPrettyJson(attempt);
      files.push(fileRecord(attemptPath, attemptText));
      cases.push({
        caseId,
        outcome: "censored",
        reason: result.reason,
        ...retainedInputs,
        attempt: { path: attemptPath, sha256: sha256Hex(attemptText) }
      });
    } else {
      throw new Error(`${caseId} outcome must be complete or censored`);
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const acquisition = {
    schemaVersion: 3,
    artifactKind: CALIBRATION_ACQUISITION_KIND,
    studyId: candidate.studyId,
    detector: candidate.detector,
    measurementCondition:
      candidate.preregistration.design.measurementCondition,
    candidateCommit,
    carrierCommit,
    authorization,
    authorizationSha256:
      calibrationAcquisitionAuthorizationSha256(authorization),
    rosterSelectionSnapshot,
    rosterSelectionSnapshotSha256,
    workflowRun: {
      workflow: CALIBRATION_WORKFLOW,
      id: runId,
      attempt: runAttempt,
      headCommit: carrierCommit
    },
    runner: {
      labelSha256: runner.labelSha256,
      identitySha256: runner.identitySha256,
      environment: runner.environment
    },
    egress: {
      identity: egress.identity,
      regionSha256: egress.regionSha256
    },
    runtime: runtimeWithDigest,
    startedAt,
    completedAt,
    cases,
    files: files.map(({ path: filePath, bytes, sha256 }) => ({
      path: filePath,
      bytes,
      sha256
    }))
  };
  return { acquisition, acquisitionText: canonicalPrettyJson(acquisition), files };
}

export function writeCalibrationAcquisition(outputDir, created) {
  mkdirSync(outputDir, { recursive: false, mode: 0o700 });
  for (const file of created.files) {
    const destination = repoPath(outputDir, file.path);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, file.text, { flag: "wx", mode: 0o600 });
  }
  writeFileSync(path.join(outputDir, "acquisition.json"), created.acquisitionText, {
    flag: "wx",
    mode: 0o600
  });
}

export function inspectCalibrationAcquisition(artifactDir, expected = {}) {
  const root = realpathSync(artifactDir);
  const read = readJsonFile(path.join(root, "acquisition.json"), "calibration acquisition");
  const acquisition = acquisitionObject(read.value);
  requireCanonical(acquisition, read.text, "calibration acquisition");
  if (expected.studyId !== undefined) {
    require(acquisition.studyId === expected.studyId, "acquisition studyId does not match");
  }
  if (expected.candidateCommit !== undefined) {
    require(acquisition.candidateCommit === expected.candidateCommit, "acquisition candidate does not match");
  }
  if (expected.carrierCommit !== undefined) {
    require(acquisition.carrierCommit === expected.carrierCommit, "acquisition carrier does not match");
  }
  if (expected.runId !== undefined) {
    require(acquisition.workflowRun.id === expected.runId, "acquisition run id does not match");
  }
  if (expected.runAttempt !== undefined) {
    require(acquisition.workflowRun.attempt === expected.runAttempt, "acquisition run attempt does not match");
  }
  const expectedPaths = ["acquisition.json"];
  const artifacts = new Map();
  for (const file of acquisition.files) {
    const contents = readRegularNoFollow(repoPath(root, file.path), MAX_JSON_BYTES, file.path);
    require(contents.byteLength === file.bytes, `${file.path} byte length does not match acquisition manifest`);
    require(sha256Hex(contents) === file.sha256, `${file.path} digest does not match acquisition manifest`);
    const parsedArtifact = parseStrictJsonBuffer(contents, file.path);
    requireCanonical(parsedArtifact.value, parsedArtifact.text, file.path);
    artifacts.set(file.path, parsedArtifact.value);
    expectedPaths.push(file.path);
  }
  expectedPaths.sort();
  require(
    JSON.stringify(exactRelativeFiles(root)) === JSON.stringify(expectedPaths),
    "calibration acquisition contains an undeclared, missing, or non-regular file"
  );
  for (const calibrationCase of acquisition.cases) {
    verifyRetainedAcquisitionCase(acquisition, calibrationCase, artifacts);
  }
  return { acquisition, acquisitionSha256: sha256Hex(read.text), root };
}

function verifyRetainedAcquisitionCase(
  acquisition,
  calibrationCase,
  artifacts
) {
  const caseId = calibrationCase.caseId;
  const selection = artifacts.get(calibrationCase.selection.path);
  const condition = artifacts.get(calibrationCase.condition.path);
  selectionObject(selection, acquisition.studyId, acquisition.detector, caseId);
  conditionObject(
    condition,
    acquisition.studyId,
    acquisition.detector,
    caseId,
    acquisition.measurementCondition
  );
  require(
    sha256Hex(canonicalPrettyJson(selection)) ===
      calibrationCase.selectionDigest,
    `${caseId} retained selection bytes do not match the frozen digest`
  );
  require(
    sha256Hex(canonicalPrettyJson(condition)) ===
      calibrationCase.conditionDigest,
    `${caseId} retained condition bytes do not match the frozen digest`
  );

  const sourceReport =
    calibrationCase.sourceReport === null
      ? null
      : artifacts.get(calibrationCase.sourceReport.path);
  if (sourceReport !== null) {
    require(
      isRecord(sourceReport) &&
        sourceReport.schemaVersion === 2 &&
        sourceReport.schemaRevision === 2 &&
        sourceReport.reportType === "single" &&
        isRecord(sourceReport.run),
      `${caseId} retained source report is not one public v2/r2 single report`
    );
    require(
      sourceReport.run?.conditions?.device?.kind ===
        acquisition.measurementCondition.device &&
        sourceReport.run?.conditions?.gpc ===
          acquisition.measurementCondition.gpcEnabled &&
        sourceReport.run?.conditions?.consent ===
          acquisition.measurementCondition.consentMode,
      `${caseId} retained source report does not equal the preregistered measurement condition`
    );
  }
  const detectorObservation =
    calibrationCase.detectorObservation === null
      ? null
      : artifacts.get(calibrationCase.detectorObservation.path);
  if (detectorObservation !== null) {
    validateConsentDetectorObservation(
      detectorObservation,
      {
        studyId: acquisition.studyId,
        detector: acquisition.detector
      },
      caseId,
      calibrationCase.sourceReport?.sha256
    );
  }

  if (calibrationCase.outcome === "complete") {
    const prediction = artifacts.get(calibrationCase.prediction.path);
    require(isRecord(prediction), `${caseId} prediction artifact is missing`);
    exactKeys(
      prediction,
      [
        "schemaVersion",
        "artifactKind",
        "studyId",
        "detector",
        "caseId",
        "conditionDigest",
        "sourceReportSha256",
        "value",
        "recordedAt"
      ],
      `${caseId} prediction artifact`
    );
    require(
      prediction.schemaVersion === 1 &&
        prediction.artifactKind ===
          "site-behavior-detector-calibration-prediction" &&
        prediction.studyId === acquisition.studyId &&
        prediction.detector === acquisition.detector &&
        prediction.caseId === caseId &&
        prediction.conditionDigest === calibrationCase.conditionDigest &&
        prediction.sourceReportSha256 ===
          calibrationCase.sourceReport.sha256 &&
        prediction.value === calibrationCase.prediction.value,
      `${caseId} prediction identity or retained-input binding is invalid`
    );
    assertWithinAcquisitionWindow(
      prediction.recordedAt,
      acquisition,
      `${caseId} prediction recordedAt`
    );
    let recomputed;
    if (acquisition.detector === "consent-banner") {
      require(
        detectorObservation !== null,
        `${caseId} consent-banner prediction lacks its private observation`
      );
      const observation = detectorObservation.observation;
      const ledger = sourceReport.run.detectors?.["consent-banner"];
      const matchingPhases = sourceReport.run.phases?.filter(
        (phase) => phase?.phaseId === observation.phaseId
      );
      require(
        isRecord(ledger) &&
          ledger.status === "complete" &&
          ledger.phaseId === observation.phaseId &&
          Array.isArray(matchingPhases) &&
          matchingPhases.length === 1 &&
          matchingPhases[0]?.kind === "passive-load",
        `${caseId} consent-banner observation is not linked to one complete passive detector phase`
      );
      recomputed = observation.visible ? "detected" : "not-detected";
    } else {
      const derived = detectorPredictionFromRun(
        sourceReport.run,
        acquisition.detector
      );
      require(
        derived.outcome === "complete",
        `${caseId} retained source report does not reproduce a complete prediction`
      );
      recomputed = derived.value;
    }
    require(
      recomputed === prediction.value,
      `${caseId} retained detector input does not reproduce the prediction`
    );
  } else {
    const attempt = artifacts.get(calibrationCase.attempt.path);
    require(isRecord(attempt), `${caseId} attempt artifact is missing`);
    exactKeys(
      attempt,
      [
        "schemaVersion",
        "artifactKind",
        "studyId",
        "detector",
        "caseId",
        "conditionDigest",
        "outcome",
        "reason",
        "sourceReportSha256",
        "recordedAt"
      ],
      `${caseId} attempt artifact`
    );
    require(
      attempt.schemaVersion === 1 &&
        attempt.artifactKind ===
          "site-behavior-detector-calibration-attempt" &&
        attempt.studyId === acquisition.studyId &&
        attempt.detector === acquisition.detector &&
        attempt.caseId === caseId &&
        attempt.conditionDigest === calibrationCase.conditionDigest &&
        attempt.outcome === "censored" &&
        attempt.reason === calibrationCase.reason &&
        attempt.sourceReportSha256 ===
          (calibrationCase.sourceReport?.sha256 ?? null),
      `${caseId} attempt identity or retained-input binding is invalid`
    );
    assertWithinAcquisitionWindow(
      attempt.recordedAt,
      acquisition,
      `${caseId} attempt recordedAt`
    );
  }
}

function assertWithinAcquisitionWindow(value, acquisition, label) {
  requireInstant(value, label);
  require(
    Date.parse(value) >= Date.parse(acquisition.startedAt) &&
      Date.parse(value) <= Date.parse(acquisition.completedAt),
    `${label} is outside the acquisition window`
  );
}

export function assembleCalibrationStudy(input) {
  const {
    candidate,
    acquisitionInspection,
    labels,
    releaseIdentity,
    analyze,
    runtimeReceiptArtifact,
    acquisitionJob,
    producerCommit,
    policyDecision,
    freezeReceipt,
    custody,
    assembledAt
  } = input;
  const acquisition = acquisitionInspection.acquisition;
  require(acquisition.studyId === candidate.studyId, "acquisition study does not match candidate");
  require(acquisition.detector === candidate.detector, "acquisition detector does not match candidate");
  require(
    canonicalizeCalibrationValue(acquisition.measurementCondition) ===
      canonicalizeCalibrationValue(
        candidate.preregistration.design.measurementCondition
      ),
    "acquisition measurement condition does not match preregistration"
  );
  require(acquisition.candidateCommit === releaseIdentity.buildCommit, "release identity must use frozen candidate");
  require(
    isRecord(labels) &&
      labels.cases instanceof Map &&
      isRecord(labels.manifest) &&
      labels.manifest.schemaVersion === 3 &&
      labels.manifest.artifactKind === CALIBRATION_LABELS_MANIFEST_KIND &&
      labels.manifest.studyId === candidate.studyId &&
      labels.manifest.detector === candidate.detector,
    "assembled labels must carry exact source provenance"
  );
  require(isRecord(labels.source), "assembled label source provenance is required");
  requireFullSha(labels.source.commit, "assembled label source commit");
  requireFullSha(labels.source.tree, "assembled label source tree");
  require(
    labels.source.path === `calibration-labels/${candidate.studyId}`,
    "assembled label source path must equal calibration-labels/<studyId>"
  );
  requireDigest(labels.source.sha256, "assembled label source digest");
  const studyRoot = `calibration/${candidate.studyId}`;
  const custodyFiles = {
    labelRosterAuthorization: calibrationCustodyFile(
      custody?.labelRosterAuthorization,
      `${studyRoot}/label-roster-authorization.json`,
      "label roster authorization"
    ),
    rosterSelectionLedger: calibrationCustodyFile(
      custody?.rosterSelectionLedger,
      `${studyRoot}/roster-selection-ledger.json`,
      "roster selection ledger"
    ),
    acquisitionAttemptLedger: calibrationCustodyFile(
      custody?.acquisitionAttemptLedger,
      `${studyRoot}/acquisition-attempt-ledger.json`,
      "acquisition attempt ledger"
    )
  };
  require(
    labels.manifest.roster?.authorizationPath ===
        custodyFiles.labelRosterAuthorization.path &&
      labels.manifest.roster?.authorizationSha256 ===
        custodyFiles.labelRosterAuthorization.sha256 &&
      labels.manifest.roster?.selectionLedgerPath ===
        custodyFiles.rosterSelectionLedger.path &&
      labels.manifest.roster?.selectionLedgerSha256 ===
        custodyFiles.rosterSelectionLedger.sha256 &&
      labels.manifest.roster?.candidateCommit ===
        acquisition.candidateCommit &&
      labels.manifest.roster?.carrierCommit === acquisition.carrierCommit,
    "labels manifest roster descriptor must exactly bind the archived candidate/carrier custody files"
  );
  const labelsManifestPath =
    `${studyRoot}/labels-manifest.json`;
  const labelsManifestText = labels.manifestText;
  require(
    labelsManifestText === canonicalPrettyJson(labels.manifest),
    "labels manifest serialization changed after validation"
  );
  const outputFiles = [];
  const studyCases = [];
  const manifestArtifacts = [];
  for (const calibrationCase of acquisition.cases) {
    const caseId = calibrationCase.caseId;
    const retainedRoles = [
      ["selection", calibrationCase.selection],
      ["condition", calibrationCase.condition],
      ...(calibrationCase.sourceReport === null
        ? []
        : [["source-report", calibrationCase.sourceReport]]),
      ...(calibrationCase.detectorObservation === null
        ? []
        : [["detector-observation", calibrationCase.detectorObservation]])
    ];
    for (const [role, descriptor] of retainedRoles) {
      const source = readFileText(
        repoPath(acquisitionInspection.root, descriptor.path),
        `${caseId} ${role}`
      );
      const destination =
        `calibration/${candidate.studyId}/artifacts/${caseId}/${role}.json`;
      const digest = sha256Hex(source);
      require(
        digest === descriptor.sha256,
        `${caseId} ${role} changed after acquisition inspection`
      );
      outputFiles.push({ path: destination, text: source });
      manifestArtifacts.push({
        role,
        caseId,
        path: destination,
        sha256: digest
      });
    }
    if (calibrationCase.outcome === "censored") {
      const source = readFileText(
        repoPath(acquisitionInspection.root, calibrationCase.attempt.path),
        `${caseId} attempt`
      );
      const destination = `calibration/${candidate.studyId}/artifacts/${caseId}/attempt.json`;
      outputFiles.push({ path: destination, text: source });
      manifestArtifacts.push({
        role: "attempt",
        caseId,
        path: destination,
        sha256: sha256Hex(source)
      });
      studyCases.push({
        caseId,
        outcome: "censored",
        reason: calibrationCase.reason,
        conditionDigest: calibrationCase.conditionDigest,
        attemptArtifactDigest: sha256Hex(source)
      });
      continue;
    }
    const supplied = labels.cases.get(caseId);
    require(supplied !== undefined, `complete case ${caseId} has no supplied human label`);
    const predictionText = readFileText(
      repoPath(acquisitionInspection.root, calibrationCase.prediction.path),
      `${caseId} prediction`
    );
    const evidenceText = supplied.evidence.text;
    require(
      evidenceText === canonicalPrettyJson(supplied.evidence.value) &&
        sha256Hex(evidenceText) ===
          candidate.frameById.get(caseId)?.referenceEvidenceDigest,
      `${caseId} authenticated reference evidence changed before assembly`
    );
    const roles = [
      ["prediction", predictionText],
      ["evidence", evidenceText],
      ["label", supplied.label.text]
    ];
    if (supplied.adjudication) roles.push(["adjudication", supplied.adjudication.text]);
    const digests = {};
    for (const [role, text] of roles) {
      const destination = `calibration/${candidate.studyId}/artifacts/${caseId}/${role}.json`;
      const digest = sha256Hex(text);
      outputFiles.push({ path: destination, text });
      manifestArtifacts.push({ role, caseId, path: destination, sha256: digest });
      digests[role] = digest;
    }
    const labelerIds = supplied.label.value.labels.map((entry) => entry.labelerId);
    studyCases.push({
      caseId,
      outcome: "complete",
      conditionDigest: calibrationCase.conditionDigest,
      prediction: {
        value: calibrationCase.prediction.value,
        artifactDigest: digests.prediction
      },
      reference: {
        value: supplied.value,
        evidenceArtifactDigest: digests.evidence,
        labelArtifactDigest: digests.label,
        labelerIds,
        adjudication: supplied.adjudication
          ? {
              status: "disagreement-resolved-by-blind-tiebreaker",
              tiebreakerId: supplied.adjudication.value.tiebreakerId,
              artifactDigest: digests.adjudication
            }
          : {
              status: "labelers-agreed",
              tiebreakerId: null,
              artifactDigest: null
            }
      }
    });
  }
  manifestArtifacts.sort((left, right) => left.path.localeCompare(right.path));
  studyCases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  const study = {
    schemaVersion: 3,
    studyId: candidate.studyId,
    detector: candidate.detector,
    release: releaseIdentity,
    targetPopulation: candidate.preregistration.targetPopulation,
    plannedCases: candidate.preregistration.plannedCases,
    labelRosterAuthorizationSha256:
      custodyFiles.labelRosterAuthorization.sha256,
    rosterSelectionLedgerSha256:
      custodyFiles.rosterSelectionLedger.sha256,
    acquisitionAttemptLedgerSha256:
      custodyFiles.acquisitionAttemptLedger.sha256,
    design: candidate.preregistration.design,
    cases: studyCases
  };
  const studyText = canonicalPrettyJson(study);
  const artifactManifestPath = `calibration/${candidate.studyId}/artifact-manifest.json`;
  const artifactManifest = {
    schemaVersion: 1,
    artifactKind: CALIBRATION_ARTIFACT_MANIFEST_KIND,
    studyId: candidate.studyId,
    artifacts: manifestArtifacts
  };
  const artifactManifestText = canonicalPrettyJson(artifactManifest);
  const analysis = analyze(study, {
    expectedBuildCommit: acquisition.candidateCommit,
    expectedRuntimeDigest: acquisition.runtime.runtimeDigest
  });
  const analysisText = canonicalPrettyJson(analysis);
  const assemblyInstant = requireInstant(
    assembledAt,
    "runtime receipt assembledAt"
  );
  const policyDecidedAt = requireInstant(
    policyDecision?.decidedAt,
    "runtime receipt policy.decidedAt"
  );
  const freezeActivatedAt = requireInstant(
    freezeReceipt?.activatedAt,
    "runtime receipt freeze.activatedAt"
  );
  const artifactCreatedAt = requireInstant(
    runtimeReceiptArtifact.createdAt,
    "runtime receipt artifact.createdAt"
  );
  const artifactExpiresAt = requireInstant(
    runtimeReceiptArtifact.expiresAt,
    "runtime receipt artifact.expiresAt"
  );
  require(isRecord(acquisitionJob), "authenticated acquisition job is required");
  const acquisitionJobId = requirePositiveInteger(
    acquisitionJob.id,
    "authenticated acquisition job id"
  );
  const acquisitionJobStartedAt = requireInstant(
    acquisitionJob.startedAt,
    "authenticated acquisition job startedAt"
  );
  const acquisitionJobCompletedAt = requireInstant(
    acquisitionJob.completedAt,
    "authenticated acquisition job completedAt"
  );
  const acquisitionRunnerNameSha256 = requireDigest(
    acquisitionJob.runnerNameSha256,
    "authenticated acquisition job runnerNameSha256"
  );
  const acquisitionRunStartedAt = requireInstant(
    acquisitionJob.runStartedAt,
    "authenticated acquisition run startedAt"
  );
  const acquisitionRunCompletedAt = requireInstant(
    acquisitionJob.runCompletedAt,
    "authenticated acquisition run completedAt"
  );
  require(
    Date.parse(policyDecidedAt) <= Date.parse(labels.recordedFrom),
    "calibration policy approval must not postdate authenticated labeling"
  );
  require(
    Date.parse(freezeActivatedAt) <= Date.parse(labels.recordedFrom),
    "measurement-freeze activation must not postdate authenticated labeling"
  );
  require(
    Date.parse(labels.recordedFrom) <= Date.parse(labels.recordedThrough) &&
      Date.parse(labels.recordedThrough) <
        Date.parse(acquisitionRunStartedAt) &&
      Date.parse(acquisitionRunStartedAt) <=
        Date.parse(acquisitionJobStartedAt) &&
      Date.parse(acquisitionJobStartedAt) <=
        Date.parse(acquisition.startedAt) &&
      Date.parse(acquisition.startedAt) <=
        Date.parse(acquisition.completedAt) &&
      Date.parse(acquisition.completedAt) <=
        Date.parse(acquisitionJobCompletedAt) &&
      Date.parse(artifactCreatedAt) >=
        Date.parse(acquisitionJobStartedAt) &&
      Date.parse(artifactCreatedAt) <=
        Date.parse(acquisitionJobCompletedAt) &&
      Date.parse(acquisitionJobCompletedAt) <=
        Date.parse(acquisitionRunCompletedAt) &&
      Date.parse(acquisitionRunCompletedAt) <= Date.parse(assemblyInstant) &&
      Date.parse(artifactCreatedAt) <= Date.parse(assemblyInstant) &&
      Date.parse(artifactExpiresAt) > Date.parse(artifactCreatedAt),
    "calibration chronology must run policy/freeze through authenticated pre-acquisition ciphertext commitments, the server-bound acquisition job, protected reveal, artifact archival, and assembly"
  );
  const runtimeReceipt = {
    schemaVersion: 3,
    artifactKind: CALIBRATION_RUNTIME_RECEIPT_KIND,
    studyId: candidate.studyId,
    detector: candidate.detector,
    candidateCommit: acquisition.candidateCommit,
    producerCommit: requireFullSha(
      producerCommit,
      "runtime receipt producerCommit"
    ),
    policy: {
      id: CALIBRATION_CENSORING_POLICY_ID,
      path: CALIBRATION_CENSORING_POLICY_PATH,
      sha256: candidate.policySha256,
      dispositionSha256: requireDigest(
        policyDecision?.dispositionSha256,
        "runtime receipt policy.dispositionSha256"
      ),
      decidedBy: requireText(
        policyDecision?.decidedBy,
        "runtime receipt policy.decidedBy",
        200
      ),
      decidedAt: policyDecidedAt
    },
    freeze: {
      receiptPath: requireArtifactPath(
        freezeReceipt?.path,
        "runtime receipt freeze.receiptPath"
      ),
      receiptSha256: requireDigest(
        freezeReceipt?.sha256,
        "runtime receipt freeze.receiptSha256"
      ),
      activatedAt: freezeActivatedAt
    },
    acquisition: {
      repository: "iAnonymous3000/site-behavior-lab",
      workflowPath: ".github/workflows/calibration-study.yml",
      workflowRef: "refs/heads/main",
      runId: acquisition.workflowRun.id,
      runAttempt: acquisition.workflowRun.attempt,
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: acquisition.carrierCommit,
      runStartedAt: acquisitionRunStartedAt,
      runCompletedAt: acquisitionRunCompletedAt,
      job: {
        id: acquisitionJobId,
        startedAt: acquisitionJobStartedAt,
        completedAt: acquisitionJobCompletedAt,
        runnerNameSha256: acquisitionRunnerNameSha256
      },
      startedAt: acquisition.startedAt,
      completedAt: acquisition.completedAt,
      runner: acquisition.runner,
      egress: acquisition.egress
    },
    artifact: {
      id: requirePositiveInteger(
        runtimeReceiptArtifact.id,
        "runtime receipt artifact id"
      ),
      name: requireText(
        runtimeReceiptArtifact.name,
        "runtime receipt artifact name",
        200
      ),
      archiveSha256: requireDigest(
        runtimeReceiptArtifact.archiveSha256,
        "runtime receipt archiveSha256"
      ),
      bytes: requirePositiveInteger(
        runtimeReceiptArtifact.bytes,
        "runtime receipt artifact bytes"
      ),
      createdAt: artifactCreatedAt,
      expiresAt: artifactExpiresAt
    },
    labels: {
      commit: labels.source.commit,
      tree: labels.source.tree,
      path: labels.source.path,
      sourceSha256: requireDigest(
        labels.source.sha256,
        "runtime receipt labels.sourceSha256"
      ),
      manifestPath: labelsManifestPath,
      manifestSha256: sha256Hex(labelsManifestText),
      labelSealingKey: labels.labelSealingKey,
      commitmentSetSha256: requireDigest(
        labels.commitmentSetSha256,
        "runtime receipt labels.commitmentSetSha256"
      ),
      recordedFrom: labels.recordedFrom,
      recordedThrough: labels.recordedThrough
    },
    custody: {
      labelRosterAuthorization: {
        path: custodyFiles.labelRosterAuthorization.path,
        sha256: custodyFiles.labelRosterAuthorization.sha256
      },
      rosterSelectionLedger: {
        path: custodyFiles.rosterSelectionLedger.path,
        sha256: custodyFiles.rosterSelectionLedger.sha256
      },
      acquisitionAttemptLedger: {
        path: custodyFiles.acquisitionAttemptLedger.path,
        sha256: custodyFiles.acquisitionAttemptLedger.sha256
      }
    },
    inputs: {
      preregistrationSha256: candidate.preregistrationSha256,
      samplingFrameSha256: candidate.frameSha256,
      labelSealingPublicKeySha256:
        candidate.labelSealingKey.publicKeySha256,
      measurementConditionSha256: sha256Hex(
        canonicalPrettyJson(
          candidate.preregistration.design.measurementCondition
        )
      ),
      acquisitionManifestSha256:
        acquisitionInspection.acquisitionSha256
    },
    outputs: {
      studySha256: sha256Hex(studyText),
      artifactManifestSha256: sha256Hex(artifactManifestText),
      analysisSha256: sha256Hex(analysisText),
      labelsManifestSha256: sha256Hex(labelsManifestText)
    },
    runtime: acquisition.runtime,
    assembledAt: assemblyInstant
  };
  const runtimeReceiptText = canonicalPrettyJson(runtimeReceipt);
  require(
    runtimeReceipt.artifact.name ===
      `site-behavior-calibration-${candidate.studyId}-${acquisition.workflowRun.id}-${acquisition.workflowRun.attempt}`,
    "runtime receipt artifact name does not match the governed calibration artifact"
  );
  outputFiles.push(
    ...Object.values(custodyFiles).map(({ path: filePath, text }) => ({
      path: filePath,
      text
    })),
    {
      path: `calibration/${candidate.studyId}/study.json`,
      text: studyText
    },
    { path: artifactManifestPath, text: artifactManifestText },
    { path: labelsManifestPath, text: labelsManifestText },
    {
      path: `calibration/${candidate.studyId}/runtime-receipt.json`,
      text: runtimeReceiptText
    },
    {
      path: `calibration/${candidate.studyId}/analysis.json`,
      text: analysisText
    }
  );
  outputFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    study,
    studyText,
    artifactManifest,
    artifactManifestText,
    labelsManifest: labels.manifest,
    labelsManifestText,
    runtimeReceipt,
    runtimeReceiptText,
    analysis,
    analysisText,
    files: outputFiles
  };
}

function calibrationCustodyFile(value, expectedPath, label) {
  require(isRecord(value), `${label} custody file is required`);
  exactKeys(value, ["path", "text", "sha256"], `${label} custody file`);
  require(
    value.path === expectedPath,
    `${label} must use its fixed study-local archive path`
  );
  require(
    typeof value.text === "string",
    `${label} custody bytes must be JSON text`
  );
  const parsed = parseStrictJsonBuffer(
    Buffer.from(value.text),
    label,
    MAX_JSON_BYTES
  ).value;
  require(
    value.text === canonicalPrettyJson(parsed),
    `${label} custody bytes must be canonical serialized JSON`
  );
  const calculatedSha256 = sha256Hex(value.text);
  requireDigest(value.sha256, `${label} custody sha256`);
  require(
    value.sha256 === calculatedSha256,
    `${label} custody digest does not match its canonical bytes`
  );
  return {
    path: expectedPath,
    text: value.text,
    sha256: calculatedSha256
  };
}

export function writeAssembledCalibration(rootDir, assembled) {
  const root = realpathSync(rootDir);
  for (const file of assembled.files) {
    const destination = repoPath(root, file.path);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    writeFileSync(destination, file.text, { flag: "wx", mode: 0o644 });
  }
}

export function addAssembledCalibrationToMeasurementBinding(
  rootDir,
  candidate,
  assembled,
  attestation
) {
  const root = realpathSync(rootDir);
  const bindingAbsolute = repoPath(root, CALIBRATION_BINDING_PATH);
  const bindingRead = readJsonFile(
    bindingAbsolute,
    "measurement candidate binding"
  );
  const binding = bindingRead.value;
  require(
    isRecord(binding) &&
      Array.isArray(binding.calibrationStudies) &&
      isRecord(binding.calibrationPolicy),
    "measurement candidate binding is missing calibration policy/studies"
  );
  require(
    binding.candidateCommit === assembled.study.release.buildCommit,
    "assembled study release does not match the binding candidate"
  );
  require(
    binding.calibrationPolicy.id === CALIBRATION_CENSORING_POLICY_ID &&
      binding.calibrationPolicy.policyArtifactPath ===
        CALIBRATION_CENSORING_POLICY_PATH &&
      binding.calibrationPolicy.policyArtifactSha256 === candidate.policySha256,
    "measurement binding policy does not match the candidate preregistration"
  );
  require(
    bindingRead.text === canonicalPrettyJson(binding),
    "measurement candidate binding must be canonical serialized JSON"
  );

  const studyRoot = `calibration/${candidate.studyId}`;
  const paths = {
    preregistrationPath: `${studyRoot}/preregistration.json`,
    samplingFramePath: `${studyRoot}/frame.json`,
    studyPath: `${studyRoot}/study.json`,
    analysisPath: `${studyRoot}/analysis.json`,
    labelsManifestPath: `${studyRoot}/labels-manifest.json`,
    runtimeReceiptPath: `${studyRoot}/runtime-receipt.json`,
    runtimeReceiptBundlePath:
      `${studyRoot}/runtime-receipt.sigstore.json`,
    artifactManifestPath: `${studyRoot}/artifact-manifest.json`,
    labelRosterAuthorizationPath:
      `${studyRoot}/label-roster-authorization.json`,
    rosterSelectionLedgerPath:
      `${studyRoot}/roster-selection-ledger.json`,
    acquisitionAttemptLedgerPath:
      `${studyRoot}/acquisition-attempt-ledger.json`
  };
  require(
    isRecord(attestation) &&
      attestation.path === paths.runtimeReceiptBundlePath,
    "calibration runtime-receipt attestation path is invalid"
  );
  const bundleBytes = readRegularNoFollow(
    repoPath(root, paths.runtimeReceiptBundlePath),
    MAX_JSON_BYTES,
    paths.runtimeReceiptBundlePath
  );
  parseStrictJsonBuffer(
    bundleBytes,
    paths.runtimeReceiptBundlePath,
    MAX_JSON_BYTES
  );
  const bundleSha256 = sha256Hex(bundleBytes);
  require(
    attestation.sha256 === bundleSha256,
    "calibration runtime-receipt attestation digest changed"
  );
  const textByPath = new Map(
    assembled.files.map((file) => [file.path, file.text])
  );
  for (const outputPath of [
    paths.studyPath,
    paths.analysisPath,
    paths.labelsManifestPath,
    paths.runtimeReceiptPath,
    paths.artifactManifestPath,
    paths.labelRosterAuthorizationPath,
    paths.rosterSelectionLedgerPath,
    paths.acquisitionAttemptLedgerPath
  ]) {
    const expected = textByPath.get(outputPath);
    require(expected !== undefined, `assembled output is missing ${outputPath}`);
    const actual = readJsonFile(repoPath(root, outputPath), outputPath);
    require(
      actual.text === expected,
      `${outputPath} changed between assembly and binding`
    );
  }
  const entry = {
    studyId: candidate.studyId,
    detector: candidate.detector,
    preregistrationPath: paths.preregistrationPath,
    preregistrationSha256: candidate.preregistrationSha256,
    samplingFramePath: paths.samplingFramePath,
    samplingFrameSha256: candidate.frameSha256,
    studyPath: paths.studyPath,
    studySha256: sha256Hex(textByPath.get(paths.studyPath)),
    analysisPath: paths.analysisPath,
    analysisSha256: sha256Hex(textByPath.get(paths.analysisPath)),
    runtimeReceiptPath: paths.runtimeReceiptPath,
    runtimeReceiptSha256: sha256Hex(
      textByPath.get(paths.runtimeReceiptPath)
    ),
    runtimeReceiptBundlePath: paths.runtimeReceiptBundlePath,
    runtimeReceiptBundleSha256: bundleSha256,
    artifactManifestPath: paths.artifactManifestPath,
    artifactManifestSha256: sha256Hex(
      textByPath.get(paths.artifactManifestPath)
    ),
    labelRosterAuthorizationPath:
      paths.labelRosterAuthorizationPath,
    labelRosterAuthorizationSha256: sha256Hex(
      textByPath.get(paths.labelRosterAuthorizationPath)
    ),
    rosterSelectionLedgerPath: paths.rosterSelectionLedgerPath,
    rosterSelectionLedgerSha256: sha256Hex(
      textByPath.get(paths.rosterSelectionLedgerPath)
    ),
    acquisitionAttemptLedgerPath: paths.acquisitionAttemptLedgerPath,
    acquisitionAttemptLedgerSha256: sha256Hex(
      textByPath.get(paths.acquisitionAttemptLedgerPath)
    )
  };
  require(
    !binding.calibrationStudies.some(
      (study) =>
        isRecord(study) &&
        (study.studyId === candidate.studyId ||
          study.studyPath === paths.studyPath)
    ),
    `measurement binding already contains calibration study ${candidate.studyId}`
  );
  binding.calibrationStudies.push(entry);
  binding.calibrationStudies.sort((left, right) =>
    String(left.studyId).localeCompare(String(right.studyId))
  );
  writeExistingRegularNoFollow(
    bindingAbsolute,
    canonicalPrettyJson(binding),
    "measurement candidate binding"
  );
  return entry;
}

function validatePlan(value) {
  require(isRecord(value), "calibration plan must be an object");
  exactKeys(value, PLAN_KEYS, "calibration plan");
  require(value.schemaVersion === 2, "calibration plan schemaVersion must be 2");
  require(
    value.artifactKind === "site-behavior-detector-calibration-plan",
    "calibration plan artifactKind is invalid"
  );
  const studyId = requireToken(value.studyId, "calibration plan studyId");
  const detector = requireDetector(value.detector, "calibration plan detector");
  const declaredAt = requireInstant(value.declaredAt, "calibration plan declaredAt");
  const targetPopulation = requireText(
    value.targetPopulation,
    "calibration plan targetPopulation",
    1_000
  );
  const labelSealingKey = labelSealingKeyObject(
    value.labelSealingKey,
    studyId
  );
  require(isRecord(value.design), "calibration plan design must be an object");
  exactKeys(value.design, PLAN_DESIGN_KEYS, "calibration plan design");
  require(
    ["simple-random", "census", "convenience"].includes(value.design.sampling),
    "calibration plan sampling is invalid"
  );
  for (const field of [
    "selectionProtocol",
    "referenceProtocol",
    "adjudicationProtocol"
  ]) {
    requireText(value.design[field], `calibration plan design.${field}`, 1_000);
  }
  const measurementCondition = measurementConditionObject(
    value.design.measurementCondition,
    detector,
    "calibration plan design.measurementCondition"
  );
  for (const field of [
    "independentUnits",
    "predictionBlindedToReference",
    "referenceBlindedToPrediction"
  ]) {
    require(typeof value.design[field] === "boolean", `calibration plan design.${field} must be boolean`);
  }
  require(
    Array.isArray(value.cases) &&
      value.cases.length >= 1 &&
      value.cases.length <= MAX_CASES,
    `calibration plan cases must contain 1 through ${MAX_CASES} cases`
  );
  const cases = [];
  let prior = "";
  const pairs = new Set();
  for (const [index, entry] of value.cases.entries()) {
    require(isRecord(entry), `calibration plan cases[${index}] must be an object`);
    exactKeys(entry, PLAN_CASE_KEYS, `calibration plan cases[${index}]`);
    const caseId = requireToken(entry.caseId, `calibration plan cases[${index}].caseId`);
    require(caseId.localeCompare(prior) > 0, "calibration plan cases must be unique and sorted");
    prior = caseId;
    const selectionDigest = requireDigest(
      entry.selectionDigest,
      `calibration plan cases[${index}].selectionDigest`
    );
    const conditionDigest = requireDigest(
      entry.conditionDigest,
      `calibration plan cases[${index}].conditionDigest`
    );
    const referenceEvidenceDigest = requireDigest(
      entry.referenceEvidenceDigest,
      `calibration plan cases[${index}].referenceEvidenceDigest`
    );
    const pair =
      `${selectionDigest}:${conditionDigest}:${referenceEvidenceDigest}`;
    require(!pairs.has(pair), "calibration plan selection and condition pairs must be unique");
    pairs.add(pair);
    cases.push({
      caseId,
      selectionDigest,
      conditionDigest,
      referenceEvidenceDigest
    });
  }
  return {
    schemaVersion: 2,
    artifactKind: value.artifactKind,
    studyId,
    detector,
    declaredAt,
    targetPopulation,
    labelSealingKey,
    design: { ...value.design, measurementCondition },
    cases
  };
}

function preRegistrationObject(value, studyId) {
  require(isRecord(value), "calibration preregistration must be an object");
  exactKeys(value, PREREGISTRATION_KEYS, "calibration preregistration");
  require(
    value.schemaVersion === 2 &&
      value.artifactKind === "site-behavior-detector-calibration-preregistration" &&
      value.studyId === studyId,
    "calibration preregistration identity is invalid"
  );
  const detector = requireDetector(
    value.detector,
    "calibration preregistration detector"
  );
  requireInstant(value.declaredAt, "calibration preregistration declaredAt");
  requireText(value.targetPopulation, "calibration preregistration targetPopulation", 1_000);
  require(
    Number.isSafeInteger(value.plannedCases) &&
      value.plannedCases >= 1 &&
      value.plannedCases <= MAX_CASES,
    "calibration preregistration plannedCases is invalid"
  );
  require(isRecord(value.censoringPolicy), "calibration preregistration censoringPolicy is missing");
  exactKeys(value.censoringPolicy, PREREGISTRATION_POLICY_KEYS, "calibration preregistration censoringPolicy");
  require(value.censoringPolicy.id === CALIBRATION_CENSORING_POLICY_ID, "calibration censoring policy id is invalid");
  requireDigest(value.censoringPolicy.sha256, "calibration censoring policy digest");
  designObject(value.design, detector);
  return value;
}

function frameObject(value, studyId) {
  require(isRecord(value), "calibration frame must be an object");
  exactKeys(value, FRAME_KEYS, "calibration frame");
  require(
    value.schemaVersion === 2 &&
      value.artifactKind === "site-behavior-detector-calibration-sampling-frame" &&
      value.studyId === studyId,
    "calibration frame identity is invalid"
  );
  requireDetector(value.detector, "calibration frame detector");
  requireDigest(value.selectionProtocolDigest, "calibration frame selectionProtocolDigest");
  measurementConditionObject(
    value.measurementCondition,
    value.detector,
    "calibration frame measurementCondition"
  );
  labelSealingKeyObject(value.labelSealingKey, studyId);
  require(Array.isArray(value.cases), "calibration frame cases must be an array");
  return value;
}

function labelSealingKeyObject(value, studyId) {
  require(isRecord(value), "calibration labelSealingKey must be an object");
  exactKeys(value, LABEL_SEALING_KEY_KEYS, "calibration labelSealingKey");
  require(
    value.algorithm === CALIBRATION_LABEL_SEALING_ALGORITHM,
    "calibration labelSealingKey algorithm is invalid"
  );
  const keyId = requireDigest(
    value.keyId,
    "calibration labelSealingKey keyId"
  );
  const publicKeyPath = requireArtifactPath(
    value.publicKeyPath,
    "calibration labelSealingKey publicKeyPath"
  );
  require(
    publicKeyPath ===
      `calibration/${studyId}/label-sealing-public-key.pem`,
    "calibration labelSealingKey must use its fixed candidate-resident public-key path"
  );
  const publicKeySha256 = requireDigest(
    value.publicKeySha256,
    "calibration labelSealingKey publicKeySha256"
  );
  return {
    algorithm: CALIBRATION_LABEL_SEALING_ALGORITHM,
    keyId,
    publicKeyPath,
    publicKeySha256
  };
}

function policyAssignmentsObject(value) {
  require(isRecord(value), "calibration censoring policy must be an object");
  require(
    value.schemaVersion === 3 &&
      value.artifactKind ===
        "site-behavior-detector-calibration-censoring-policy-assignments" &&
      value.id === CALIBRATION_CENSORING_POLICY_ID,
    "calibration censoring policy identity is invalid"
  );
  require(
    typeof value.analyzerVersion === "string" && value.analyzerVersion.length > 0,
    "calibration censoring policy needs the analyzer version"
  );
  require(
    JSON.stringify(value.censorReasons) === JSON.stringify(CALIBRATION_CENSOR_REASONS),
    "calibration censoring policy reasons must equal the analyzer vocabulary"
  );
  return value;
}

/** HISTORICAL validator for the superseded global zero-censoring artifact. */
export function supersededZeroCensoringPolicyObject(value) {
  require(isRecord(value), "calibration censoring policy must be an object");
  exactKeys(value, POLICY_KEYS, "calibration censoring policy");
  require(
    value.schemaVersion === 2 &&
      value.artifactKind === "site-behavior-detector-calibration-censoring-policy" &&
      value.id === CALIBRATION_SUPERSEDED_POLICY_ID,
    "calibration censoring policy identity is invalid"
  );
  require(
    JSON.stringify(value.allowedReasons) === JSON.stringify(CALIBRATION_CENSOR_REASONS),
    "calibration censoring policy reasons must equal the analyzer vocabulary"
  );
  require(isRecord(value.releaseEligibility), "calibration censoring release eligibility is missing");
  exactKeys(value.releaseEligibility, POLICY_ELIGIBILITY_KEYS, "calibration censoring releaseEligibility");
  require(
    value.releaseEligibility.anyCensoredCase === "study-ineligible" &&
      value.releaseEligibility.plannedDenominator === "must-remain-complete",
    "calibration censoring release eligibility is invalid"
  );
  require(
    isRecord(value.ratePublicationEligibility),
    "calibration rate-publication eligibility is missing"
  );
  exactKeys(
    value.ratePublicationEligibility,
    POLICY_RATE_KEYS,
    "calibration ratePublicationEligibility"
  );
  require(
    isRecord(value.ratePublicationEligibility.minimumDenominators),
    "calibration minimum denominators are missing"
  );
  exactKeys(
    value.ratePublicationEligibility.minimumDenominators,
    POLICY_MINIMUM_DENOMINATOR_KEYS,
    "calibration minimum denominators"
  );
  require(
    isRecord(value.ratePublicationEligibility.uncertainty),
    "calibration uncertainty contract is missing"
  );
  exactKeys(
    value.ratePublicationEligibility.uncertainty,
    POLICY_UNCERTAINTY_KEYS,
    "calibration uncertainty contract"
  );
  require(
    canonicalizeCalibrationValue(value.ratePublicationEligibility) ===
      canonicalizeCalibrationValue(
        calibrationRatePublicationEligibility()
      ),
    "calibration rate-publication eligibility disagrees with the canonical binding policy"
  );
  return value;
}

function designObject(value, detector) {
  require(isRecord(value), "calibration design must be an object");
  exactKeys(value, DESIGN_KEYS, "calibration design");
  require(["simple-random", "census", "convenience"].includes(value.sampling), "calibration sampling is invalid");
  requireText(value.samplingFrame, "calibration samplingFrame", 1_000);
  requireDigest(value.samplingFrameDigest, "calibration samplingFrameDigest");
  for (const field of ["selectionProtocol", "referenceProtocol", "adjudicationProtocol"]) {
    requireText(value[field], `calibration ${field}`, 1_000);
  }
  requireDigest(value.referenceProtocolDigest, "calibration referenceProtocolDigest");
  requireDigest(value.adjudicationProtocolDigest, "calibration adjudicationProtocolDigest");
  measurementConditionObject(
    value.measurementCondition,
    detector,
    "calibration measurementCondition"
  );
  for (const field of ["independentUnits", "predictionBlindedToReference", "referenceBlindedToPrediction"]) {
    require(typeof value[field] === "boolean", `calibration ${field} must be boolean`);
  }
  return value;
}

function measurementConditionObject(value, detector, label) {
  require(isRecord(value), `${label} must be an object`);
  exactKeys(value, MEASUREMENT_CONDITION_KEYS, label);
  require(
    value.device === "desktop" &&
      value.gpcEnabled === false &&
      (value.consentMode === "observe" ||
        value.consentMode === "accept-all"),
    `${label} must pin one supported desktop, GPC-disabled measurement arm`
  );
  requireText(value.interpretation, `${label} interpretation`, 1_000);
  if (detector !== null) {
    const expected = calibrationMeasurementCondition(detector);
    require(
      canonicalizeCalibrationValue(value) ===
        canonicalizeCalibrationValue(expected),
      `${label} must equal the canonical ${detector} measurement arm`
    );
  }
  return value;
}

function selectionObject(value, studyId, detector, caseId) {
  require(isRecord(value), `${caseId} selection must be an object`);
  exactKeys(value, SELECTION_KEYS, `${caseId} selection`);
  require(
    value.schemaVersion === 1 &&
      value.artifactKind === "site-behavior-detector-calibration-selection" &&
      value.studyId === studyId &&
      value.detector === detector &&
      value.caseId === caseId,
    `${caseId} selection identity is invalid`
  );
  requireCalibrationSubjectUrl(value.url, `${caseId} selection`);
  return value;
}

/**
 * The one subject-URL rule: https, no embedded credentials, no fragment.
 * Extracted from selectionObject so the v4 reference-task verifier states
 * the SAME rule by calling it, never by restating it.
 */
export function requireCalibrationSubjectUrl(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  require(parsed.protocol === "https:", `${label} URL must use HTTPS`);
  require(parsed.username === "" && parsed.password === "", `${label} URL cannot carry credentials`);
  require(parsed.hash === "", `${label} URL cannot carry a fragment`);
  return parsed;
}

function conditionObject(
  value,
  studyId,
  detector,
  caseId,
  expectedMeasurementCondition
) {
  require(isRecord(value), `${caseId} condition must be an object`);
  exactKeys(value, CONDITION_KEYS, `${caseId} condition`);
  require(
    value.schemaVersion === 1 &&
      value.artifactKind === "site-behavior-detector-calibration-condition" &&
      value.studyId === studyId &&
      value.detector === detector &&
      value.caseId === caseId,
    `${caseId} condition identity is invalid`
  );
  require(isRecord(value.request), `${caseId} condition request must be an object`);
  exactKeys(value.request, REQUEST_KEYS, `${caseId} condition request`);
  const expected = measurementConditionObject(
    expectedMeasurementCondition,
    detector,
    `${caseId} expected measurement condition`
  );
  require(
    value.request.device === expected.device &&
      value.request.gpcEnabled === expected.gpcEnabled &&
      value.request.consentMode === expected.consentMode,
    `${caseId} calibration condition must equal the preregistered detector-specific measurement arm`
  );
  return value;
}

function referenceEvidenceObject(value, studyId, detector, caseId) {
  require(isRecord(value), `${caseId} reference evidence must be an object`);
  exactKeys(value, REFERENCE_EVIDENCE_KEYS, `${caseId} reference evidence`);
  require(
    value.schemaVersion === 1 &&
      value.artifactKind === "site-behavior-detector-calibration-reference-evidence" &&
      value.studyId === studyId &&
      value.detector === detector &&
      value.caseId === caseId,
    `${caseId} reference evidence identity is invalid`
  );
  requireDigest(
    value.blindingNonce,
    `${caseId} reference evidence blindingNonce`
  );
  require(isRecord(value.source), `${caseId} reference evidence source must be an object`);
  exactKeys(
    value.source,
    REFERENCE_SOURCE_KEYS,
    `${caseId} reference evidence source`
  );
  require(
    [
      "authoritative-record",
      "independent-capture",
      "human-observation"
    ].includes(value.source.kind),
    `${caseId} reference evidence source kind is invalid`
  );
  require(
    typeof value.source.locator === "string" &&
      PUBLIC_REFERENCE_LOCATOR.test(value.source.locator),
    `${caseId} reference evidence source locator must be an opaque urn:sbl:reference:sha256:<digest> identifier`
  );
  requireInstant(
    value.source.observedAt,
    `${caseId} reference evidence source observedAt`
  );
  require(
    Array.isArray(value.observations) &&
      value.observations.length >= 1 &&
      value.observations.length <= 1_000,
    `${caseId} reference evidence observations must contain 1 through 1000 facts`
  );
  let priorFact = "";
  const expectedPresenceFact = `${detector}-presence`;
  let presenceValue;
  for (const [index, observation] of value.observations.entries()) {
    const label = `${caseId} reference evidence observations[${index}]`;
    require(isRecord(observation), `${label} must be an object`);
    exactKeys(observation, REFERENCE_OBSERVATION_KEYS, label);
    const fact = requireToken(observation.fact, `${label}.fact`);
    require(
      fact.localeCompare(priorFact) > 0,
      `${caseId} reference evidence facts must be unique and sorted`
    );
    priorFact = fact;
    if (fact === expectedPresenceFact) {
      require(
        typeof observation.value === "boolean",
        `${label}.value must be boolean for ${expectedPresenceFact}`
      );
      presenceValue = observation.value;
    } else if (fact === "observation-count") {
      require(
        Number.isSafeInteger(observation.value) &&
          observation.value >= 0 &&
          observation.value <= 1_000_000,
        `${label}.value must be an integer from 0 through 1000000 for observation-count`
      );
    } else {
      throw new Error(
        `${label}.fact is outside the public-safe detector evidence vocabulary`
      );
    }
  }
  require(
    typeof presenceValue === "boolean",
    `${caseId} reference evidence must include ${expectedPresenceFact}`
  );
  return value;
}

function validateConsentDetectorObservation(
  value,
  candidate,
  caseId,
  sourceReportSha256
) {
  require(isRecord(value), `${caseId} private detector observation must be an object`);
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "caseId",
      "sourceReportSha256",
      "observation"
    ],
    `${caseId} private detector observation`
  );
  require(
    value.schemaVersion === 1 &&
      value.artifactKind ===
        "site-behavior-detector-calibration-private-observation" &&
      value.studyId === candidate.studyId &&
      value.detector === "consent-banner" &&
      value.detector === candidate.detector &&
      value.caseId === caseId &&
      value.sourceReportSha256 === sourceReportSha256,
    `${caseId} private detector observation identity is invalid`
  );
  require(
    isRecord(value.observation),
    `${caseId} consent-banner observation is missing`
  );
  exactKeys(
    value.observation,
    ["detector", "method", "phaseId", "outcome", "visible"],
    `${caseId} consent-banner observation`
  );
  require(
    value.observation.detector === "consent-banner" &&
      value.observation.method === "banner-visibility@1" &&
      Number.isSafeInteger(value.observation.phaseId) &&
      value.observation.phaseId >= 0 &&
      value.observation.outcome === "complete" &&
      typeof value.observation.visible === "boolean",
    `${caseId} consent-banner observation shape is invalid`
  );
}

function acquisitionObject(value) {
  require(isRecord(value), "calibration acquisition must be an object");
  exactKeys(
    value,
    [
      "schemaVersion",
      "artifactKind",
      "studyId",
      "detector",
      "measurementCondition",
      "candidateCommit",
      "carrierCommit",
      "authorization",
      "authorizationSha256",
      "rosterSelectionSnapshot",
      "rosterSelectionSnapshotSha256",
      "workflowRun",
      "runner",
      "egress",
      "runtime",
      "startedAt",
      "completedAt",
      "cases",
      "files"
    ],
    "calibration acquisition"
  );
  require(value.schemaVersion === 3 && value.artifactKind === CALIBRATION_ACQUISITION_KIND, "calibration acquisition identity is invalid");
  requireToken(value.studyId, "calibration acquisition studyId");
  const detector = requireDetector(
    value.detector,
    "calibration acquisition detector"
  );
  measurementConditionObject(
    value.measurementCondition,
    detector,
    "calibration acquisition measurementCondition"
  );
  requireFullSha(value.candidateCommit, "calibration acquisition candidateCommit");
  requireFullSha(value.carrierCommit, "calibration acquisition carrierCommit");
  const authorization =
    validateCalibrationAcquisitionAuthorizationIdentity(
      value.authorization
    );
  require(
    authorization.studyId === value.studyId &&
      authorization.detector === value.detector &&
      authorization.candidateCommit === value.candidateCommit &&
      calibrationAcquisitionAuthorizationSha256(authorization) ===
        value.authorizationSha256,
    "calibration acquisition authorization identity or digest is invalid"
  );
  require(
    isRecord(value.rosterSelectionSnapshot) &&
      isRecord(value.rosterSelectionSnapshot.identity) &&
      isRecord(value.rosterSelectionSnapshot.selectedRun) &&
      Array.isArray(value.rosterSelectionSnapshot.runs) &&
      value.rosterSelectionSnapshot.runs.length === 1 &&
      value.rosterSelectionSnapshot.identity.studyId === value.studyId &&
      value.rosterSelectionSnapshot.identity.candidateCommit ===
        value.candidateCommit &&
      value.rosterSelectionSnapshot.identity.caseInputRootSha256 ===
        authorization.caseInputRootSha256 &&
      value.rosterSelectionSnapshot.selectedRun.runId ===
        authorization.roster.runId &&
      value.rosterSelectionSnapshot.selectedRun.runAttempt === 1 &&
      value.rosterSelectionSnapshot.selectedRun.headSha ===
        authorization.roster.headSha &&
      value.rosterSelectionSnapshot.selectedRun.status === "completed" &&
      value.rosterSelectionSnapshot.selectedRun.conclusion === "success",
    "calibration acquisition roster selection snapshot is invalid"
  );
  requireDigest(
    value.rosterSelectionSnapshotSha256,
    "calibration acquisition roster selection snapshot sha256"
  );
  require(
    sha256Hex(canonicalPrettyJson(value.rosterSelectionSnapshot)) ===
      value.rosterSelectionSnapshotSha256,
    "calibration acquisition roster selection snapshot digest is invalid"
  );
  require(isRecord(value.workflowRun), "calibration acquisition workflowRun is missing");
  exactKeys(value.workflowRun, ["workflow", "id", "attempt", "headCommit"], "calibration acquisition workflowRun");
  require(value.workflowRun.workflow === CALIBRATION_WORKFLOW, "calibration acquisition workflow is invalid");
  requirePositiveInteger(value.workflowRun.id, "calibration acquisition run id");
  require(
    requirePositiveInteger(
      value.workflowRun.attempt,
      "calibration acquisition run attempt"
    ) <= 100,
    "calibration acquisition run attempt must be no greater than 100"
  );
  require(
    value.workflowRun.attempt === authorization.authorizedRunAttempt,
    "calibration acquisition run attempt is not preauthorized"
  );
  require(value.workflowRun.headCommit === value.carrierCommit, "calibration acquisition head and carrier disagree");
  require(isRecord(value.runner), "calibration acquisition runner is missing");
  exactKeys(
    value.runner,
    ["labelSha256", "identitySha256", "environment"],
    "calibration acquisition runner"
  );
  requireDigest(value.runner.labelSha256, "calibration acquisition runner labelSha256");
  requireDigest(
    value.runner.identitySha256,
    "calibration acquisition runner identitySha256"
  );
  require(
    value.runner.environment === "ephemeral-self-hosted",
    "calibration acquisition runner must be ephemeral-self-hosted"
  );
  require(isRecord(value.egress), "calibration acquisition egress is missing");
  exactKeys(
    value.egress,
    ["identity", "regionSha256"],
    "calibration acquisition egress"
  );
  require(value.egress.identity === "controlled-self-hosted", "calibration acquisition egress identity is invalid");
  requireDigest(
    value.egress.regionSha256,
    "calibration acquisition egress regionSha256"
  );
  validateRuntime(value.runtime, true);
  requireInstant(value.startedAt, "calibration acquisition startedAt");
  requireInstant(value.completedAt, "calibration acquisition completedAt");
  require(
    Date.parse(authorization.roster.artifactCreatedAt) <
      Date.parse(value.startedAt),
    "calibration roster authorization artifact must predate acquisition"
  );
  require(Date.parse(value.completedAt) >= Date.parse(value.startedAt), "calibration acquisition chronology is invalid");
  require(Array.isArray(value.cases) && value.cases.length >= 1 && value.cases.length <= MAX_CASES, "calibration acquisition cases are invalid");
  require(Array.isArray(value.files), "calibration acquisition files are invalid");
  let priorPath = "";
  const files = new Map();
  for (const [index, file] of value.files.entries()) {
    require(isRecord(file), `calibration acquisition files[${index}] must be an object`);
    exactKeys(file, ["path", "bytes", "sha256"], `calibration acquisition files[${index}]`);
    const relative = requireArtifactPath(file.path, `calibration acquisition files[${index}].path`);
    require(relative.localeCompare(priorPath) > 0, "calibration acquisition files must be unique and sorted");
    priorPath = relative;
    require(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_JSON_BYTES, `${relative} byte bound is invalid`);
    requireDigest(file.sha256, `${relative} digest`);
    files.set(relative, file);
  }
  let priorCaseId = "";
  for (const [index, calibrationCase] of value.cases.entries()) {
    require(isRecord(calibrationCase), `calibration acquisition cases[${index}] must be an object`);
    const caseId = requireToken(calibrationCase.caseId, `calibration acquisition cases[${index}].caseId`);
    require(caseId.localeCompare(priorCaseId) > 0, "calibration acquisition cases must be unique and sorted");
    priorCaseId = caseId;
    requireDigest(calibrationCase.selectionDigest, `${caseId} selection digest`);
    requireDigest(calibrationCase.conditionDigest, `${caseId} condition digest`);
    verifyAcquisitionRole(calibrationCase.selection, files, caseId, "selection", false);
    verifyAcquisitionRole(calibrationCase.condition, files, caseId, "condition", false);
    require(
      calibrationCase.selection.sha256 === calibrationCase.selectionDigest,
      `${caseId} retained selection does not match the frozen digest`
    );
    require(
      calibrationCase.condition.sha256 === calibrationCase.conditionDigest,
      `${caseId} retained condition does not match the frozen digest`
    );
    if (calibrationCase.sourceReport !== null) {
      verifyAcquisitionRole(
        calibrationCase.sourceReport,
        files,
        caseId,
        "source-report",
        false
      );
    }
    if (calibrationCase.detectorObservation !== null) {
      verifyAcquisitionRole(
        calibrationCase.detectorObservation,
        files,
        caseId,
        "detector-observation",
        false
      );
    }
    if (calibrationCase.outcome === "complete") {
      exactKeys(
        calibrationCase,
        [
          "caseId",
          "outcome",
          "selectionDigest",
          "conditionDigest",
          "selection",
          "condition",
          "sourceReport",
          "detectorObservation",
          "prediction"
        ],
        `${caseId} acquisition case`
      );
      require(
        calibrationCase.sourceReport !== null,
        `${caseId} complete case must retain one source report`
      );
      require(
        value.detector !== "consent-banner" ||
          calibrationCase.detectorObservation !== null,
        `${caseId} complete consent-banner case must retain a private detector observation`
      );
      verifyAcquisitionRole(calibrationCase.prediction, files, caseId, "prediction", true);
    } else if (calibrationCase.outcome === "censored") {
      exactKeys(
        calibrationCase,
        [
          "caseId",
          "outcome",
          "reason",
          "selectionDigest",
          "conditionDigest",
          "selection",
          "condition",
          "sourceReport",
          "detectorObservation",
          "attempt"
        ],
        `${caseId} acquisition case`
      );
      require(
        calibrationCase.detectorObservation === null,
        `${caseId} censored case cannot retain a completed private detector observation`
      );
      require(CALIBRATION_CENSOR_REASONS.includes(calibrationCase.reason), `${caseId} censor reason is invalid`);
      verifyAcquisitionRole(calibrationCase.attempt, files, caseId, "attempt", false);
    } else {
      throw new Error(`${caseId} acquisition outcome is invalid`);
    }
  }
  const referenced = new Set();
  for (const calibrationCase of value.cases) {
    referenced.add(calibrationCase.selection.path);
    referenced.add(calibrationCase.condition.path);
    if (calibrationCase.sourceReport !== null) {
      referenced.add(calibrationCase.sourceReport.path);
    }
    if (calibrationCase.detectorObservation !== null) {
      referenced.add(calibrationCase.detectorObservation.path);
    }
    if (calibrationCase.outcome === "complete") {
      referenced.add(calibrationCase.prediction.path);
    } else {
      referenced.add(calibrationCase.attempt.path);
    }
  }
  require(referenced.size === files.size && [...files.keys()].every((key) => referenced.has(key)), "acquisition file manifest must be set-equal to case artifacts");
  return value;
}

function verifyAcquisitionRole(value, files, caseId, role, hasValue) {
  require(isRecord(value), `${caseId} ${role} descriptor is missing`);
  exactKeys(value, hasValue ? ["path", "sha256", "value"] : ["path", "sha256"], `${caseId} ${role} descriptor`);
  const expectedPath = `cases/${caseId}/${role}.json`;
  require(value.path === expectedPath, `${caseId} ${role} path is invalid`);
  requireDigest(value.sha256, `${caseId} ${role} digest`);
  require(files.get(expectedPath)?.sha256 === value.sha256, `${caseId} ${role} file digest disagrees`);
  if (hasValue) {
    require(value.value === "detected" || value.value === "not-detected", `${caseId} prediction value is invalid`);
  }
}

function validateRuntime(value, includesDigest = false) {
  require(isRecord(value), "calibration runtime must be an object");
  const coreKeys = [
    "observer",
    "automation",
    "nodeVersion",
    "playwrightVersion",
    "browserName",
    "browserVersion",
    "operatingSystem",
    "architecture"
  ];
  exactKeys(value, includesDigest ? [...coreKeys, "runtimeDigest"] : coreKeys, "calibration runtime");
  require(value.observer === "node-playwright", "calibration runtime observer is invalid");
  require(value.automation === "playwright-chromium", "calibration runtime automation is invalid");
  require(value.browserName === "chromium", "calibration runtime browser is invalid");
  for (const field of ["nodeVersion", "playwrightVersion", "browserVersion", "operatingSystem", "architecture"]) {
    requireText(value[field], `calibration runtime ${field}`, 256);
  }
  const core = Object.fromEntries(coreKeys.map((key) => [key, value[key]]));
  if (includesDigest) {
    require(
      value.runtimeDigest === detectorCalibrationRuntimeDigest(core),
      "calibration runtimeDigest is not derived from runtime fields"
    );
  }
  return core;
}

function fileRecord(relativePath, text) {
  const bytes = Buffer.byteLength(text);
  require(bytes > 0 && bytes <= MAX_JSON_BYTES, `${relativePath} exceeds the artifact byte bound`);
  return { path: relativePath, bytes, sha256: sha256Hex(text), text };
}

function exactRelativeFiles(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = lstatSync(absolute);
      require(!stat.isSymbolicLink(), `artifact path ${relative} cannot be a symbolic link`);
      if (stat.isDirectory()) walk(absolute, relative);
      else {
        require(stat.isFile(), `artifact path ${relative} must be a regular file`);
        requireArtifactPath(relative, `artifact path ${relative}`);
        files.push(relative);
      }
    }
  };
  walk(root, "");
  return files.sort();
}

function repoPath(root, relative) {
  requireArtifactPath(relative, "relative artifact path");
  const resolved = path.resolve(root, ...relative.split("/"));
  require(resolved.startsWith(`${path.resolve(root)}${path.sep}`), "artifact path escapes its root");
  return resolved;
}

function requireArtifactPath(value, label) {
  require(
    typeof value === "string" &&
      value.length >= 1 &&
      value.length <= 500 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => TOKEN.test(part) || /^[a-z0-9][a-z0-9._-]{0,199}\.json$/.test(part)),
    `${label} must be a bounded canonical relative path`
  );
  return value;
}

function readRegularNoFollow(file, maximum, label) {
  let descriptor;
  try {
    descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    require(stat.isFile() && stat.size > 0 && stat.size <= maximum, `${label} must be a bounded regular file`);
    const contents = readFileSync(descriptor);
    require(contents.byteLength === stat.size, `${label} changed while being read`);
    return contents;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeExistingRegularNoFollow(file, contents, label) {
  let descriptor;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW
    );
    const stat = fstatSync(descriptor);
    require(stat.isFile(), `${label} must be a regular file`);
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, contents);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readFileText(file, label) {
  return parseStrictJsonBuffer(readRegularNoFollow(file, MAX_JSON_BYTES, label), label).text;
}

function requireCanonical(value, text, label) {
  require(text === canonicalPrettyJson(value), `${label} must use canonical pretty JSON serialization`);
}

function exactKeys(value, expected, label) {
  require(isRecord(value), `${label} must be an object`);
  require(
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected),
    `${label} must contain exactly, in order: ${expected.join(", ")}`
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function requireToken(value, label) {
  require(typeof value === "string" && TOKEN.test(value), `${label} must be a bounded opaque token`);
  return value;
}

function requireGithubLogin(value, label) {
  require(
    typeof value === "string" &&
      /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/.test(value),
    `${label} must be one canonical GitHub login`
  );
  return value.toLowerCase();
}

function requireDetector(value, label) {
  require(CALIBRATION_DETECTOR_IDS.includes(value), `${label} must name one of the six governed detectors`);
  return value;
}

function requireDigest(value, label) {
  require(typeof value === "string" && SHA256.test(value), `${label} must be a lowercase sha256 digest`);
  return value;
}

function requireFullSha(value, label) {
  require(typeof value === "string" && FULL_SHA.test(value), `${label} must be a full lowercase Git SHA`);
  return value;
}

function requireText(value, label, maximum = MAX_TEXT) {
  require(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      value.trim() === value &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(value),
    `${label} must be bounded canonical text`
  );
  return value;
}

function requireInstant(value, label) {
  require(
    typeof value === "string" &&
      CANONICAL_INSTANT.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    `${label} must be a canonical ISO timestamp`
  );
  return value;
}

function requirePositiveInteger(value, label) {
  require(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

/**
 * Minimal duplicate-key scanner for JSON. It tracks object member names while
 * respecting strings/escapes, which closes the JSON.parse last-key-wins gap at
 * every externally supplied calibration boundary.
 */
function duplicateJsonKey(text) {
  const stack = [];
  let index = 0;
  let expectingKey = false;
  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          return null;
        }
      }
      index += 1;
    }
    return null;
  };
  while (index < text.length) {
    skipSpace();
    const char = text[index];
    if (char === "{") {
      stack.push({ kind: "object", keys: new Set() });
      expectingKey = true;
      index += 1;
    } else if (char === "[") {
      stack.push({ kind: "array" });
      expectingKey = false;
      index += 1;
    } else if (char === "}") {
      stack.pop();
      expectingKey = false;
      index += 1;
    } else if (char === "]") {
      stack.pop();
      expectingKey = false;
      index += 1;
    } else if (char === ",") {
      expectingKey = stack.at(-1)?.kind === "object";
      index += 1;
    } else if (char === '"') {
      const value = readString();
      if (value === null) return null;
      skipSpace();
      if (expectingKey && text[index] === ":" && stack.at(-1)?.kind === "object") {
        if (stack.at(-1).keys.has(value)) return JSON.stringify(value);
        stack.at(-1).keys.add(value);
        expectingKey = false;
      }
    } else {
      index += 1;
    }
  }
  return null;
}
