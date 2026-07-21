import {
  PRIVACY_SAFE_OBSERVABILITY_PATH,
  parsePrivacySafeObservabilityEvent
} from "./privacy-safe-observability";

export const PUBLIC_AGGREGATE_METRICS_FLAG = "NEXT_PUBLIC_SITE_BEHAVIOR_LAB_AGGREGATE_METRICS" as const;

export type PrivacySafeMetricsClientConfig = {
  enabled: boolean;
  endpoint: string | null;
};

export type BrowserPrivacySignals = {
  globalPrivacyControl?: boolean;
  doNotTrack?: string | null;
};

export type PrivacySafeEventDelivery = "disabled" | "opted-out" | "rejected" | "sent" | "failed";

type PrivacySafeFetch = (input: string, init: RequestInit) => Promise<{ ok: boolean }>;

/**
 * Derive the only permitted endpoint from the already-approved scan API origin.
 * There is no arbitrary analytics host setting that could redirect events to a
 * third party. Production requires HTTPS; loopback HTTP remains usable in dev.
 */
export function resolvePrivacySafeMetricsClientConfig(
  enabledFlag: string | undefined,
  scanApiBase: string | undefined
): PrivacySafeMetricsClientConfig {
  if (enabledFlag !== "1") return { enabled: false, endpoint: null };
  const origin = exactApiOrigin(scanApiBase);
  return origin
    ? { enabled: true, endpoint: `${origin}${PRIVACY_SAFE_OBSERVABILITY_PATH}` }
    : { enabled: false, endpoint: null };
}

export function browserPrivacySignalOptOut(signals: BrowserPrivacySignals | undefined): boolean {
  if (!signals) return false;
  const dnt = signals.doNotTrack?.trim().toLowerCase();
  return signals.globalPrivacyControl === true || dnt === "1" || dnt === "yes";
}

/**
 * Send one already-reduced event. This function never throws or logs, never
 * retries, sends no credentials/referrer, and does not block product behavior.
 */
export async function deliverPrivacySafeObservabilityEvent(
  value: unknown,
  config: PrivacySafeMetricsClientConfig,
  privacySignals: BrowserPrivacySignals | undefined,
  fetcher: PrivacySafeFetch
): Promise<PrivacySafeEventDelivery> {
  if (!config.enabled || !config.endpoint) return "disabled";
  if (browserPrivacySignalOptOut(privacySignals)) return "opted-out";
  const event = parsePrivacySafeObservabilityEvent(value);
  if (!event) return "rejected";

  try {
    const result = await fetcher(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      cache: "no-store",
      credentials: "omit",
      keepalive: true,
      mode: "cors",
      redirect: "error",
      referrerPolicy: "no-referrer"
    });
    return result.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

function exactApiOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
