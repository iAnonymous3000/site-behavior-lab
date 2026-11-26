/**
 * Clean HTTP scan-worker dispatch seam & regional egress profile selector for
 * Site Behavior Lab v3.
 *
 * Default deployment is 100% pure Cloudflare (Containers + Workers + D1 + R2).
 * When operators optionally add regional scan workers (e.g. Fly.io / Cloud Run
 * in EU/US/APAC with kernel-level L3/L4 `nftables` SSRF firewalls), they simply
 * register regional HTTPS endpoints + shared HMAC secret via environment config —
 * zero code changes required!
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redactScanReportV3 } from "../redaction";
import { validateScanReportV3, type ScanRegionIdV3, type ScanReportV3 } from "../schema";
import type { ScanRequestV3 } from "../scanner";

export type { ScanRegionIdV3 };

export type RegionalEgressProfileV3 = {
  region: Exclude<ScanRegionIdV3, "auto">;
  label: string;
  locale: string;
  timezone: string;
  regulatoryContext: string;
};

export const REGIONAL_EGRESS_PROFILES_V3: Readonly<Record<Exclude<ScanRegionIdV3, "auto">, RegionalEgressProfileV3>> = {
  "us-east": {
    region: "us-east",
    label: "United States (East)",
    locale: "en-US",
    timezone: "America/New_York",
    regulatoryContext: "US / CCPA / GPC"
  },
  "eu-central": {
    region: "eu-central",
    label: "European Union (Frankfurt)",
    locale: "de-DE",
    timezone: "Europe/Berlin",
    regulatoryContext: "EU / GDPR / ePrivacy"
  },
  "ap-northeast": {
    region: "ap-northeast",
    label: "Asia-Pacific (Tokyo)",
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    regulatoryContext: "APAC / APPI"
  }
};

export type RegionalWorkerUpstreamConfigV3 = {
  region: Exclude<ScanRegionIdV3, "auto">;
  endpointUrl: string;
  hmacSecret: string;
  timeoutMs?: number;
};

export type DispatchScanOptionsV3 = {
  region?: ScanRegionIdV3;
  upstreams?: readonly RegionalWorkerUpstreamConfigV3[];
  /** Default pure-Cloudflare / local Container executor. */
  defaultExecutor: (request: ScanRequestV3) => Promise<ScanReportV3>;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
  signal?: AbortSignal;
};

/**
 * Resolve matching locale & timezone for a regional profile request.
 *
 * Security / provenance invariant: `egressRegion` is ONLY set when
 * `verifiedEgress: true` (i.e. dispatched to an authenticated regional worker
 * physically located in that region) — client locale/timezone emulation MUST
 * NEVER fabricate physical egress geography in SHA-256-digested reports.
 */
export function applyRegionalProfileV3(
  request: ScanRequestV3,
  region: ScanRegionIdV3 = "auto",
  options?: { verifiedEgress?: boolean }
): ScanRequestV3 {
  if (region === "auto") return request;
  const profile = REGIONAL_EGRESS_PROFILES_V3[region];
  return {
    ...request,
    ...(options?.verifiedEgress ? { egressRegion: profile.region } : { egressRegion: undefined }),
    locale: request.locale ?? profile.locale,
    timezone: request.timezone ?? profile.timezone
  };
}

/** Compute deterministic HMAC-SHA256 dispatch signature (`timestamp.body`). */
export function signWorkerDispatchPayloadV3(secret: string, timestampSec: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
}

/** Constant-time verification for regional worker endpoints receiving dispatched scan requests. */
export function verifyWorkerDispatchSignatureV3(input: {
  secret: string;
  timestampSec: string;
  signatureHex: string;
  body: string;
  nowMs?: number;
  maxSkewSec?: number;
}): boolean {
  if (typeof input.secret !== "string" || input.secret.length < 16) return false;
  if (!/^\d{10}$/.test(input.timestampSec)) return false;
  const ts = Number(input.timestampSec);
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const maxSkew = input.maxSkewSec ?? 60;
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > maxSkew) return false;
  if (!/^[a-f0-9]{64}$/i.test(input.signatureHex)) return false;

  const expected = signWorkerDispatchPayloadV3(input.secret, input.timestampSec, input.body);
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(input.signatureHex, "hex"));
}

/**
 * Dispatch a v3 scan to a configured regional HTTP worker when the requested
 * region matches one, falling back cleanly to the pure-Cloudflare default
 * container executor otherwise.
 */
export async function dispatchScanV3(
  request: ScanRequestV3,
  options: DispatchScanOptionsV3
): Promise<{ report: ScanReportV3; backend: "cloudflare-default" | "regional-http-worker" }> {
  const region = options.region ?? "auto";
  const upstream =
    region !== "auto"
      ? options.upstreams?.find((u) => u.region === region)
      : undefined;

  const enriched = applyRegionalProfileV3(request, region, { verifiedEgress: Boolean(upstream) });

  if (!upstream) {
    const report = await options.defaultExecutor(enriched);
    return { report, backend: "cloudflare-default" };
  }

  if (!upstream.endpointUrl.toLowerCase().startsWith("https://")) {
    throw new Error(`Refusing non-HTTPS regional worker endpoint for ${upstream.region}`);
  }
  if (upstream.hmacSecret.length < 16) {
    throw new Error(`Regional worker HMAC secret for ${upstream.region} is too short`);
  }

  const body = JSON.stringify(enriched);
  const timestampSec = String(Math.floor((options.nowMs ?? Date.now)() / 1000));
  const signature = signWorkerDispatchPayloadV3(upstream.hmacSecret, timestampSec, body);
  const nonce = randomBytes(12).toString("hex");
  const fetchFn = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), upstream.timeoutMs ?? 60_000);
  try {
    const resp = await fetchFn(`${upstream.endpointUrl.replace(/\/+$/, "")}/internal/v3/scan`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sbl-dispatch-ts": timestampSec,
        "x-sbl-dispatch-sig": signature,
        "x-sbl-dispatch-nonce": nonce,
        "x-sbl-region": upstream.region
      },
      body,
      signal: controller.signal
    });
    if (!resp.ok) {
      void resp.body?.cancel().catch(() => {});
      throw new Error(`Regional worker (${upstream.region}) failed with HTTP ${resp.status}`);
    }
    const rawReport = (await resp.json()) as ScanReportV3;
    const redacted = redactScanReportV3(rawReport);
    const issues = validateScanReportV3(redacted);
    if (issues.length > 0) {
      throw new Error(`Regional worker (${upstream.region}) returned invalid ScanReportV3: ${issues.join("; ")}`);
    }
    return { report: redacted, backend: "regional-http-worker" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
