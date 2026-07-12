/**
 * Dependency-free v1 methodology identity.
 *
 * Frozen v1 has no dedicated methodologyVersion field. New Node reports put a
 * stable token in scannerDisclosure, while older reports are one explicit
 * unspecified cohort. This is a compatibility label, not authentication: v1
 * remains legacy-derived and self-reported.
 */

export const NODE_ADBLOCK_ENGINE_VERSION = "adblock-rust-0.13.0";
export const NODE_SHIELDS_REQUEST_CONTEXT_VERSION = `shields-request-context-v2-${NODE_ADBLOCK_ENGINE_VERSION}`;
export const LEGACY_V1_METHODOLOGY_UNSPECIFIED = "legacy-v1-methodology-unspecified";

const METHODOLOGY_TOKEN = /\bmethodology\s+([a-z0-9]+(?:[._-][a-z0-9]+)*)\b/i;

export function legacyV1MethodologyIdentity(scannerDisclosure: string | undefined): string {
  const match = METHODOLOGY_TOKEN.exec(scannerDisclosure ?? "");
  return match?.[1]?.toLowerCase() ?? LEGACY_V1_METHODOLOGY_UNSPECIFIED;
}
