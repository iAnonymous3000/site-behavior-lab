export const SCANNER_EGRESS_REGION_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION";
export const SCANNER_EGRESS_LABEL_ENV = "SITE_BEHAVIOR_LAB_SCANNER_EGRESS";
export const DEFAULT_SCANNER_EGRESS_LABEL = "this scanner instance";
export const CONTROLLED_SCANNER_EGRESS_ALIAS = "controlled-self-hosted";

/**
 * Public egress labels are a closed, reviewed vocabulary. Arbitrary operator
 * labels are intentionally not persisted: the frozen v1 sanitizer would
 * generalize them while the r2 measurement envelope retained the raw value,
 * making every otherwise-successful r2 scan fail its envelope-consistency
 * check.
 */
export const PUBLIC_SCANNER_EGRESS_LABELS = Object.freeze([
  DEFAULT_SCANNER_EGRESS_LABEL,
  "cloudflare-containers",
  "cloudflare-browser-run",
  "github-actions-ubuntu",
  "docker-smoke",
  "test"
] as const);

const PUBLIC_SCANNER_EGRESS_LABEL_SET = new Set<string>(PUBLIC_SCANNER_EGRESS_LABELS);

const MAX_R2_EGRESS_REGION_CHARS = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export type ScannerEgressRegionResolution =
  | { status: "configured"; value: string; source: "explicit" | "cloudflare-placement" }
  | { status: "unrecorded" }
  | { status: "misconfigured" };

export type ScannerEgressLabelResolution =
  | { status: "configured"; value: string }
  | { status: "default"; value: typeof DEFAULT_SCANNER_EGRESS_LABEL }
  | { status: "aliased"; value: typeof DEFAULT_SCANNER_EGRESS_LABEL }
  | { status: "canonicalized"; value: typeof DEFAULT_SCANNER_EGRESS_LABEL };

/**
 * Resolve the operator label before collection so the frozen v1 wire and the
 * r2 envelope start from the same public value. A non-empty unreviewed label
 * is observable as `canonicalized` in health, but scans remain usable.
 */
export function resolveScannerEgressLabel(
  env: NodeJS.ProcessEnv = process.env
): ScannerEgressLabelResolution {
  const raw = env[SCANNER_EGRESS_LABEL_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { status: "default", value: DEFAULT_SCANNER_EGRESS_LABEL };
  }
  const value = raw.trim();
  if (value === CONTROLLED_SCANNER_EGRESS_ALIAS) {
    // Acquisition configuration may name the controlled lane, but the frozen
    // public report policy intentionally emits its generic label. The stable,
    // operator-attested location remains in the separate r2 region field.
    return { status: "aliased", value: DEFAULT_SCANNER_EGRESS_LABEL };
  }
  return PUBLIC_SCANNER_EGRESS_LABEL_SET.has(value)
    ? { status: "configured", value }
    : { status: "canonicalized", value: DEFAULT_SCANNER_EGRESS_LABEL };
}

export function scannerEgressLabel(env: NodeJS.ProcessEnv = process.env): string {
  return resolveScannerEgressLabel(env).value;
}

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
