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
 * canonical JSON of the inputs listed per fingerprint.
 */
import { sha256Hex } from "./sha256";
import type { ConditionVector, DetectorLedger, Fingerprints, Provenance, Toolchain } from "./scan-report-v2";
import { DETECTOR_IDS } from "./scan-report-v2";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entryValue]) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

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
