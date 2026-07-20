/**
 * Dependency-free v1 methodology identity.
 *
 * Frozen v1 has no dedicated methodologyVersion field. New Node reports put a
 * stable token in scannerDisclosure, while older reports are one explicit
 * unspecified cohort. This is a compatibility label, not authentication: v1
 * remains legacy-derived and self-reported.
 */

export const NODE_ADBLOCK_ENGINE_VERSION = "adblock-rust-0.13.2";
export const NODE_PLAYWRIGHT_VERSION = "1.61.1";
export const NODE_SHIELDS_REQUEST_CONTEXT_VERSION = `shields-request-context-v2-${NODE_ADBLOCK_ENGINE_VERSION}-request-method-v1`;
export const NODE_SCANNER_METHODOLOGY_VERSION =
  `${NODE_SHIELDS_REQUEST_CONTEXT_VERSION}-playwright-${NODE_PLAYWRIGHT_VERSION}`;
export const LEGACY_V1_METHODOLOGY_UNSPECIFIED = "legacy-v1-methodology-unspecified";

const METHODOLOGY_TOKEN = /\bmethodology\s+([a-z0-9]+(?:[._+-][a-z0-9]+)*)\b/gi;
const RAW_METHODOLOGY_TOKEN = /^[a-z0-9]+(?:[._+-][a-z0-9]+)*$/i;
const PLAYWRIGHT_VERSION_COMPONENT = /(?:^|-)playwright-(\d+\.\d+\.\d+)(?=$|\+)/g;

export function legacyV1MethodologyIdentity(scannerDisclosure: string | undefined): string {
  const match = [...(scannerDisclosure ?? "").matchAll(METHODOLOGY_TOKEN)];
  return match.length === 1
    ? match[0]?.[1]?.toLowerCase() ?? LEGACY_V1_METHODOLOGY_UNSPECIFIED
    : LEGACY_V1_METHODOLOGY_UNSPECIFIED;
}

/** Exact Playwright identity only when the report's own provenance records it. */
export function recordedPlaywrightVersion(provenance: string | undefined): string | null {
  if (!provenance) return null;
  const methodologyTokens = [...provenance.matchAll(METHODOLOGY_TOKEN)];
  const methodology = RAW_METHODOLOGY_TOKEN.test(provenance)
    ? provenance
    : methodologyTokens.length === 1
      ? methodologyTokens[0]?.[1]
      : null;
  if (!methodology) return null;
  const versions = [...methodology.matchAll(PLAYWRIGHT_VERSION_COMPONENT)];
  return versions.length === 1 ? versions[0]?.[1] ?? null : null;
}
