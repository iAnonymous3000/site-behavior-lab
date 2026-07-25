/**
 * Fixed, non-user-controlled contract for the production scan synthetic.
 *
 * Ordered candidate targets: the monitor proves the scanner with the primary
 * target and falls through to a later, independently operated target only
 * when the earlier target's scan itself fails (outage, block, timeout). That
 * keeps the hourly alert about the SCANNER instead of any one third party,
 * while every candidate stays a fixed harmless page: the credential still
 * authorizes nothing caller-controlled.
 */
export const PRODUCTION_SYNTHETIC_TARGETS: readonly string[] = Object.freeze([
  "https://www.iana.org/domains/reserved",
  "https://www.w3.org/TR/"
]);

export const PRODUCTION_SYNTHETIC_TARGET = PRODUCTION_SYNTHETIC_TARGETS[0];

/**
 * The exact key set of the canonical scan-admission body, which is what the
 * monitor actually posts. `scripts/scan-admission.mjs` normalizes every client
 * request into this shape, always writing the three comparison flags, so a
 * shorter allowlist here would reject the monitor's own submission. The
 * comparison flags stay in the allowlist and are pinned false below: the
 * credential must authorize one single-mode scan, never a two-arm comparison.
 */
const PRODUCTION_SYNTHETIC_KEYS = new Set([
  "url",
  "device",
  "gpcEnabled",
  "compareGpc",
  "compareShields",
  "compareConsent",
  "consentMode"
]);

/**
 * The monitor credential authorizes exactly one harmless scan shape against
 * one of the fixed candidate targets, never an arbitrary caller-provided
 * target or comparison. `turnstileToken` is deliberately absent from the
 * allowlist: this credential bypasses Turnstile, so a request carrying one is
 * not the monitor's fixed contract.
 */
export function isProductionSyntheticScanPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === PRODUCTION_SYNTHETIC_KEYS.size &&
    keys.every((key) => PRODUCTION_SYNTHETIC_KEYS.has(key)) &&
    typeof record.url === "string" &&
    PRODUCTION_SYNTHETIC_TARGETS.includes(record.url) &&
    record.device === "desktop" &&
    record.gpcEnabled === true &&
    record.compareGpc === false &&
    record.compareShields === false &&
    record.compareConsent === false &&
    record.consentMode === "observe"
  );
}

/** Strong printable secret suitable for a request header; malformed values disable the bypass. */
export function isProductionSyntheticMonitorToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{32,256}$/.test(value);
}
