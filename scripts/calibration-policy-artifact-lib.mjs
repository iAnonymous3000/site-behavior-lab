/**
 * The ONE producer of the per-detector censoring-policy ASSIGNMENTS
 * artifact, derived from the step-3 table (calibration-policy-assignments)
 * plus the exact reference-protocol bytes and the shared external
 * definition pins. Nothing else may emit or restate this artifact:
 * validators compare against this producer's output (the --check CLI runs
 * in CI), so the table and the artifact cannot drift while both stay green.
 *
 * The artifact is the byte object a NAMED HUMAN approves in
 * RELEASE_READINESS.json (status pending until that approval commit
 * exists); its digest plus the v3 disposition digest are what every
 * ceremony and pilot entrypoint requires. See
 * docs/calibration-censoring-policy-decision.md.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  B_SCOPE,
  C_PRIMARY_SCOPES,
  DETECTOR_POLICY_ASSIGNMENTS,
  POLICY_B_ID,
  POLICY_C_ID,
  PUBLICATION_PROFILES,
  validateDetectorPolicyAssignments
} from "./calibration-policy-assignments.mjs";
import {
  CALIBRATION_CENSOR_REASONS,
  canonicalPrettyJson,
  sha256Hex
} from "./calibration-study-lib.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

export const POLICY_ASSIGNMENTS_REFERENCE_PROTOCOL_ID =
  "independent-labeling-protocol@1";
export const POLICY_ASSIGNMENTS_REFERENCE_PROTOCOL_PATH =
  "docs/calibration-prereg-drafts/labeling-protocol.md";

const SHA256 = /^[0-9a-f]{64}$/;

function require_(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function externalDefinition(manifest, label) {
  require_(isRecord(manifest), `${label} must be a record`);
  const keys = ["provider", "permanentId", "url", "sha256"];
  require_(
    JSON.stringify(Object.keys(manifest)) === JSON.stringify(keys),
    `${label} must carry exactly ${keys.join(", ")}`
  );
  for (const field of ["provider", "permanentId"]) {
    require_(
      typeof manifest[field] === "string" && manifest[field].length > 0,
      `${label} needs ${field}`
    );
  }
  require_(
    typeof manifest.url === "string" && manifest.url.startsWith("https://"),
    `${label} url must be https`
  );
  require_(SHA256.test(manifest.sha256 ?? ""), `${label} needs a sha256`);
  return {
    provider: manifest.provider,
    permanentId: manifest.permanentId,
    url: manifest.url,
    sha256: manifest.sha256
  };
}

/**
 * Load the compiled binding contract for the v3 disposition digest. The
 * digest function has ONE home (lib/measurement-candidate-binding.ts);
 * this loader mirrors the study lib's dist discipline.
 */
function assignmentsBindingContract() {
  for (const candidate of [
    "../dist/schema/lib/measurement-candidate-binding.js",
    "../.unit-test-dist/lib/measurement-candidate-binding.js"
  ]) {
    try {
      const loaded = requireFromHere(candidate);
      if (
        typeof loaded.measurementCalibrationPolicyAssignmentsDispositionSha256 === "function" &&
        typeof loaded.measurementCalibrationAssignmentsSemanticProjection === "function" &&
        typeof loaded.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_ID === "string"
      ) {
        return loaded;
      }
    } catch {
      // try the next dist
    }
  }
  throw new Error(
    "The compiled policy-assignments contract is unavailable; build dist/schema before producing the policy artifact."
  );
}

/**
 * Derive the artifact. Inputs are the ONLY operator-supplied parts: the
 * exact reference-protocol bytes and the two shared external-definition
 * manifests; every policy value comes from the step-3 table.
 */
export function buildCalibrationPolicyAssignmentsArtifact({
  protocolBytes,
  trackerDefinition,
  publicSuffixDefinition
}) {
  validateDetectorPolicyAssignments();
  require_(
    typeof protocolBytes === "string" && protocolBytes.length > 0,
    "the producer needs the exact reference-protocol bytes"
  );
  const binding = assignmentsBindingContract();
  const detectors = {};
  for (const detector of Object.keys(DETECTOR_POLICY_ASSIGNMENTS).sort()) {
    const row = DETECTOR_POLICY_ASSIGNMENTS[detector];
    if (row.disposition === "hold") {
      detectors[detector] = {
        disposition: "hold",
        holdReason: row.holdReason,
        proposition: null,
        resultType: null,
        primary: null,
        secondary: null,
        publicationProfile: null,
        externalDefinitions: null
      };
      continue;
    }
    const externalDefinitions =
      detector === "cname-uncloaking"
        ? {
            trackerDefinition: externalDefinition(
              trackerDefinition,
              "cname tracker definition"
            ),
            publicSuffixDefinition: externalDefinition(
              publicSuffixDefinition,
              "cname public-suffix definition"
            )
          }
        : null;
    detectors[detector] = {
      disposition: "proceed",
      holdReason: null,
      proposition: {
        id: row.propositionId,
        sha256: sha256Hex(row.proposition),
        text: row.proposition
      },
      resultType: row.resultType,
      primary: { policy: row.primary.policy, inferenceScope: row.primary.inferenceScope },
      secondary:
        row.secondary === null
          ? null
          : { policy: row.secondary.policy, inferenceScope: row.secondary.inferenceScope },
      publicationProfile: row.publicationProfile,
      externalDefinitions
    };
  }
  const artifact = {
    schemaVersion: binding.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_SCHEMA_VERSION,
    artifactKind: binding.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_KIND,
    id: binding.MEASUREMENT_CALIBRATION_POLICY_ASSIGNMENTS_ID,
    analyzerVersion: "calibration-censoring-analysis-v1",
    censorReasons: [...CALIBRATION_CENSOR_REASONS],
    policies: { primary: POLICY_C_ID, secondary: POLICY_B_ID, superseded: "zero-censoring" },
    inferenceScopes: [...C_PRIMARY_SCOPES, B_SCOPE],
    publicationProfiles: JSON.parse(JSON.stringify(PUBLICATION_PROFILES)),
    referenceProtocol: {
      id: POLICY_ASSIGNMENTS_REFERENCE_PROTOCOL_ID,
      path: POLICY_ASSIGNMENTS_REFERENCE_PROTOCOL_PATH,
      sha256: sha256Hex(protocolBytes)
    },
    detectors
  };
  const text = canonicalPrettyJson(artifact);
  const policyArtifactSha256 = sha256Hex(text);
  const dispositionSha256 =
    binding.measurementCalibrationPolicyAssignmentsDispositionSha256({
      policyArtifactSha256,
      analyzerVersion: artifact.analyzerVersion,
      detectors: binding.measurementCalibrationAssignmentsSemanticProjection(artifact)
    });
  return { artifact, text, policyArtifactSha256, dispositionSha256 };
}

export function policyAssignmentsRepoRoot() {
  return path.resolve(moduleDir, "..");
}
