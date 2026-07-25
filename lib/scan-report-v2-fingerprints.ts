/**
 * Canonical fingerprint builders for ScanReport v2 (docs/scan-report-v2-rfc.md
 * 3.2). These are THE definitions: producers call them to mint the stored
 * digests, and the semantic validator recomputes them on read and rejects any
 * report whose stored fingerprints disagree, so a fingerprint can never be an
 * arbitrary producer-chosen string.
 *
 * Canonicalization rules (shipped with the published schema): recursively
 * sorted object keys, no insignificant whitespace, strings NFC-normalized,
 * undefined-valued properties omitted. Digests are sha256 hex over the
 * canonical JSON of the inputs listed per fingerprint. The canonicalizer
 * itself lives in lib/canonical-json.ts and is shared with the provenance
 * sidecars, so one definition governs every published digest.
 */
import { canonicalJson } from "./canonical-json";
import { sha256Hex } from "./sha256";
import type { ConditionVector, DetectorLedger, Fingerprints, Provenance, Toolchain } from "./scan-report-v2";
import { DETECTOR_IDS } from "./scan-report-v2";

/**
 * Re-exported so the fingerprint importers keep their existing specifier.
 * There is exactly ONE canonicalizer, in lib/canonical-json.ts, and it serves
 * both the RFC 15.8 provenance sidecars and these RFC 3.2 fingerprints. A
 * second copy here previously coerced non-finite numbers and undefined array
 * elements to null, which silently digests two different states identically;
 * the shared implementation rejects both. Never re-add a local copy.
 */
export { canonicalJson };

export type FingerprintInputs = {
  conditions: ConditionVector;
  provenance: Pick<Provenance, "buildCommit" | "methodologyVersion" | "detectorRegistry">;
  toolchain: Toolchain;
  detectors: DetectorLedger;
};

function detectorVersions(detectors: DetectorLedger): Record<string, string> {
  return Object.fromEntries(DETECTOR_IDS.map((id) => [id, detectors[id].version]));
}

/** The condition vector with the intervention axes' values removed (RFC 3.2). */
function environmentConditions(conditions: ConditionVector): Omit<ConditionVector, "gpc" | "shields" | "consent"> {
  const { gpc: _gpc, shields: _shields, consent: _consent, ...environment } = conditions;
  return environment;
}

export function buildFingerprints(inputs: FingerprintInputs): Fingerprints {
  const versions = detectorVersions(inputs.detectors);
  return {
    execution: sha256Hex(
      canonicalJson({
        buildCommit: inputs.provenance.buildCommit,
        conditions: inputs.conditions,
        detectorRegistry: inputs.provenance.detectorRegistry,
        detectorVersions: versions,
        methodologyVersion: inputs.provenance.methodologyVersion,
        toolchain: inputs.toolchain
      })
    ),
    measurementEnvironment: sha256Hex(
      canonicalJson({
        conditions: environmentConditions(inputs.conditions),
        detectorRegistry: inputs.provenance.detectorRegistry,
        detectorVersions: versions,
        methodologyVersion: inputs.provenance.methodologyVersion,
        toolchain: inputs.toolchain
      })
    ),
    condition: sha256Hex(canonicalJson({ conditions: inputs.conditions }))
  };
}
