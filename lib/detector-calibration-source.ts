import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  gitMetadataAvailable,
  measurementCandidateBuildProjection,
  verifiedMeasurementCandidateBuildProof,
  verifiedMeasurementCandidateBinding,
  VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV,
  type MeasurementCalibrationCeremonyVerificationRequest,
  type MeasurementCandidateAttestationRequest,
  type MeasurementDurableReplayVerificationRequest,
  type MeasurementDurableSoakProvenanceVerificationRequest,
  type MeasurementOperatorEvidenceVerificationRequest,
  type MeasurementFreezeReceiptVerificationRequest,
  type MeasurementStagingTeardownProvenanceVerificationRequest,
  type VerifiedMeasurementCandidateBinding
} from "./measurement-candidate-binding";
import {
  analyzeDetectorCalibrationStudy,
  detectorCalibrationReadiness,
  type DetectorCalibrationAnalysis,
  type DetectorCalibrationReadiness
} from "./detector-calibration";

/**
 * Discover and re-analyze the committed calibration studies.
 *
 * Node-only (filesystem) seam kept out of lib/detector-calibration.ts so the
 * analyzer stays pure. The committed analysis.json a study ships with is a
 * point-in-time record of ITS OWN collection run; the public readiness surface
 * must never trust it. Ordinarily every build re-runs the analyzer against the
 * containing HEAD, so a stale study demotes itself automatically. The one
 * exception is the one strict measurement-candidate binding shared by every
 * post-freeze evidence gate. A frozen candidate may remain the expected source
 * only when the host verifier proves the complete candidate-to-carrier diff
 * and verifies the candidate's Sigstore bundle.
 *
 * The runtime digest comes only from a study's `runtime-receipt.json` sidecar,
 * written by the execution harness independently of study assembly (the
 * analyzer refuses a digest copied from the study under analysis). A study
 * without the sidecar fails closed as expected-runtime-identity-unavailable.
 *
 * Docker/Pages builds do not carry `.git`. Those builds accept only
 * SITE_BEHAVIOR_LAB_VERIFIED_MEASUREMENT_CANDIDATE_PROOF, a dedicated
 * verifier-produced proof binding C, carrier S, the binding digest, and the
 * complete evidence-set digest. SITE_BEHAVIOR_LAB_BUILD_COMMIT remains the
 * actual carrier identity; it can never choose the frozen candidate.
 */

const CALIBRATION_DIR = "calibration";

export type CommittedCalibrationStudy = {
  studyDir: string;
  analysis: DetectorCalibrationAnalysis;
};

export type CommittedCalibrationSourceOptions = {
  /** Test seam; production/release callers omit this and invoke `gh`. */
  attestationVerifier?: (request: MeasurementCandidateAttestationRequest) => void;
  freezeReceiptVerifier?: (request: MeasurementFreezeReceiptVerificationRequest) => void;
  durableReplayVerifier?: (
    request: MeasurementDurableReplayVerificationRequest
  ) => void;
  operatorEvidenceVerifier?: (
    request: MeasurementOperatorEvidenceVerificationRequest
  ) => void;
  stagingTeardownProvenanceVerifier?: (
    request: MeasurementStagingTeardownProvenanceVerificationRequest
  ) => void;
  durableSoakProvenanceVerifier?: (
    request: MeasurementDurableSoakProvenanceVerificationRequest
  ) => void;
  calibrationCeremonyVerifier?: (
    request: MeasurementCalibrationCeremonyVerificationRequest
  ) => void;
  requireCleanWorktree?: boolean;
};

export function committedCalibrationStudyAnalyses(
  rootDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  options: CommittedCalibrationSourceOptions = {}
): CommittedCalibrationStudy[] {
  const base = path.join(rootDir, CALIBRATION_DIR);
  if (!existsSync(base)) return [];
  const hasGit = gitMetadataAvailable(rootDir);
  const sourceBinding = hasGit
    ? verifiedMeasurementCandidateBinding(rootDir, options)
    : measurementCandidateBuildProjection(rootDir, env, options);
  const projectedProof =
    env[VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV]?.trim() ?? "";
  if (hasGit) {
    if (sourceBinding) {
      if (
        projectedProof &&
        projectedProof !==
          verifiedMeasurementCandidateBuildProof(
            sourceBinding as VerifiedMeasurementCandidateBinding
          )
      ) {
        throw new Error(
          `${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} disagrees with the host-verified measurement candidate`
        );
      }
    } else if (projectedProof) {
      throw new Error(
        `${VERIFIED_MEASUREMENT_CANDIDATE_PROOF_ENV} is set but no measurement candidate binding exists`
      );
    }
  }
  const carrierCommit =
    "carrierCommit" in (sourceBinding ?? {})
      ? (sourceBinding as { carrierCommit: string }).carrierCommit
      : gitHead(rootDir) ?? recordedCarrierBuildCommit(env);
  const boundStudies = new Map(
    sourceBinding?.calibrationStudies.map((entry) => [entry.studyPath, entry] as const) ?? []
  );
  const studies: CommittedCalibrationStudy[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const studyPath = path.join(base, entry.name, "study.json");
    if (!existsSync(studyPath)) continue;
    const relativeStudyPath = `${CALIBRATION_DIR}/${entry.name}/study.json`;
    const bound = boundStudies.get(relativeStudyPath);
    const study: unknown = JSON.parse(readFileSync(studyPath, "utf8"));
    const receiptPath = bound
      ? path.join(rootDir, ...bound.runtimeReceiptPath.split("/"))
      : path.join(base, entry.name, "runtime-receipt.json");
    let expectedRuntimeDigest: string | null =
      bound?.runtimeReceiptRuntimeDigest ?? null;
    if (!bound && existsSync(receiptPath)) {
      const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
      expectedRuntimeDigest =
        typeof receipt === "object" &&
        receipt !== null &&
        typeof (receipt as { runtime?: { runtimeDigest?: unknown } }).runtime
          ?.runtimeDigest === "string"
          ? (
              receipt as {
                runtime: { runtimeDigest: string };
              }
            ).runtime.runtimeDigest
          : null;
    }
    studies.push({
      studyDir: entry.name,
      analysis: analyzeDetectorCalibrationStudy(study, {
        expectedBuildCommit: bound ? sourceBinding?.candidateCommit ?? null : carrierCommit,
        expectedRuntimeDigest
      })
    });
  }
  return studies.sort((a, b) => a.studyDir.localeCompare(b.studyDir));
}

/** Readiness over the committed studies, re-analyzed against the current identity. */
export function committedDetectorCalibrationReadiness(
  rootDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  options: CommittedCalibrationSourceOptions = {}
): DetectorCalibrationReadiness {
  return detectorCalibrationReadiness(
    committedCalibrationStudyAnalyses(rootDir, env, options).map((study) => study.analysis)
  );
}

function gitHead(rootDir: string): string | null {
  // Use Git rather than opening .git/HEAD: linked worktrees store .git as a
  // pointer file. Null still fails closed inside the analyzer.
  try {
    const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

function recordedCarrierBuildCommit(env: NodeJS.ProcessEnv): string | null {
  const value = env.SITE_BEHAVIOR_LAB_BUILD_COMMIT?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{40}$/.test(value) ? value : null;
}
