export const SCANNER_EGRESS_REGION_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION";

const MAX_R2_EGRESS_REGION_CHARS = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type ScannerEgressRegionResolution =
  | { status: "configured"; value: string; source: "explicit" | "cloudflare-placement" }
  | { status: "unrecorded" }
  | { status: "misconfigured" };

/**
 * Return the most specific truthful egress-region identity available to the
 * scanner. Cloudflare Containers injects the placement fields at runtime;
 * self-hosts can provide an explicit stable declaration instead.
 */
export function scannerEgressRegion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const resolution = resolveScannerEgressRegion(env);
  return resolution.status === "configured" ? resolution.value : undefined;
}

/**
 * Resolve egress metadata without ever emitting a value that the Node r2
 * builder would reject. A Cloudflare placement is useful as a comparison axis
 * only when all three injected fields are present; country alone is too broad
 * to identify a stable scanner egress environment.
 */
export function resolveScannerEgressRegion(env: NodeJS.ProcessEnv = process.env): ScannerEgressRegionResolution {
  const declaredRaw = env[SCANNER_EGRESS_REGION_ENV];
  if (declaredRaw !== undefined) {
    const declared = r2SafeEgressText(declaredRaw);
    return declared === null
      ? { status: "misconfigured" }
      : { status: "configured", value: declared, source: "explicit" };
  }

  const rawParts = [
    env.CLOUDFLARE_REGION,
    env.CLOUDFLARE_LOCATION,
    env.CLOUDFLARE_COUNTRY_A2
  ];
  if (rawParts.every((part) => part === undefined)) return { status: "unrecorded" };

  const parts = rawParts.map((part) => (part === undefined ? null : r2SafeEgressText(part)));
  if (parts.some((part) => part === null)) return { status: "misconfigured" };

  const [region, location, country] = parts as [string, string, string];
  if (!/^[A-Za-z]{2}$/.test(country)) return { status: "misconfigured" };
  const placement = r2SafeEgressText(`${region}/${location}/${country.toUpperCase()}`);
  return placement === null
    ? { status: "misconfigured" }
    : { status: "configured", value: placement, source: "cloudflare-placement" };
}

// Mirrors the producer-owned r2 `egress.region` envelope: known, at most 64
// Unicode code points, and free of C0/C1 control characters. Normalizing outer
// whitespace preserves the scanner's historical environment-variable behavior
// while ensuring the stored value itself is bounded.
function r2SafeEgressText(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.toLowerCase() === "unknown") return null;
  if (Array.from(normalized).length > MAX_R2_EGRESS_REGION_CHARS || CONTROL_CHARACTERS.test(normalized)) return null;
  return normalized;
}
