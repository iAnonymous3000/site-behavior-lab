/** Fixed, non-user-controlled contract for the production scan synthetic. */
export const PRODUCTION_SYNTHETIC_TARGET = "https://www.iana.org/domains/reserved";

const PRODUCTION_SYNTHETIC_KEYS = new Set(["url", "device", "gpcEnabled", "consentMode"]);

/**
 * The monitor credential authorizes exactly one harmless scan shape, never an
 * arbitrary caller-provided target or comparison.
 */
export function isProductionSyntheticScanPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === PRODUCTION_SYNTHETIC_KEYS.size &&
    keys.every((key) => PRODUCTION_SYNTHETIC_KEYS.has(key)) &&
    record.url === PRODUCTION_SYNTHETIC_TARGET &&
    record.device === "desktop" &&
    record.gpcEnabled === true &&
    record.consentMode === "observe"
  );
}

/** Strong printable secret suitable for a request header; malformed values disable the bypass. */
export function isProductionSyntheticMonitorToken(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{32,256}$/.test(value);
}
