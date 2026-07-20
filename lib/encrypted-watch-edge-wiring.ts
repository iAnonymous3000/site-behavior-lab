import {
  isEncryptedWatchId,
  isEncryptedWatchPayload,
  type EncryptedWatchPayload
} from "./encrypted-watch-contract";
import type { DurableScanJobPreparation } from "./durable-scan-job-contract";
import { publicScanGateStatus } from "./edge-scan-gate";

const WATCH_COLLECTION_PATH = "/api/watches";

export type EncryptedWatchPublicPath =
  | Readonly<{ kind: "collection" }>
  | Readonly<{ kind: "item"; watchId: string | null }>;

/**
 * The coordinator-wide watch capacity is intentionally unavailable through
 * open public ingress. Ordinary scans may still use the public Turnstile path;
 * watches require the separate, configured scan access token.
 */
export function encryptedWatchIngressIsTokenGated(config: {
  accessToken?: string;
  allowUnauthenticated?: string;
  turnstileSecret?: string;
}): boolean {
  const gate = publicScanGateStatus(config);
  return gate.authenticated && !gate.openAccess;
}

/**
 * Recognize only the public watch namespace. An item with a malformed opaque ID
 * is still classified as an item so the edge can charge its read limiter before
 * returning the same 404 used for a missing credential or record.
 */
export function parseEncryptedWatchPublicPath(pathname: string): EncryptedWatchPublicPath | null {
  if (pathname === WATCH_COLLECTION_PATH) return Object.freeze({ kind: "collection" });
  if (!pathname.startsWith(`${WATCH_COLLECTION_PATH}/`)) return null;
  const suffix = pathname.slice(WATCH_COLLECTION_PATH.length + 1);
  if (!suffix || suffix.includes("/")) return Object.freeze({ kind: "item", watchId: null });
  return Object.freeze({ kind: "item", watchId: isEncryptedWatchId(suffix) ? suffix : null });
}

/** Strict public creation body: comparisons and future scanner fields fail closed. */
export function isEncryptedWatchCreationBody(value: unknown): value is Readonly<{
  url: string;
  device: "desktop" | "mobile";
  gpcEnabled: boolean;
  turnstileToken?: string;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["url", "device", "gpcEnabled", "turnstileToken"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  if (typeof record.url !== "string" || record.url.length === 0 || record.url.length > 4_096) return false;
  if (record.device !== "desktop" && record.device !== "mobile") return false;
  if (typeof record.gpcEnabled !== "boolean") return false;
  if (record.turnstileToken !== undefined && typeof record.turnstileToken !== "string") return false;
  return isEncryptedWatchPayload({
    version: 1,
    target: { url: record.url },
    options: {
      device: record.device,
      gpcEnabled: record.gpcEnabled,
      reportMode: "r2",
      comparison: "none"
    }
  });
}

/**
 * Freeze the immutable long-lived watch payload only from Node's strict,
 * freshly DNS-validated durable preparation. No public request field is copied
 * directly into encrypted retention.
 */
export function encryptedWatchPayloadFromPreparation(
  preparation: DurableScanJobPreparation
): EncryptedWatchPayload | null {
  const payload = preparation.payload;
  if (
    payload.compareGpc ||
    payload.compareShields ||
    payload.compareConsent ||
    payload.rateLimitCost !== 1 ||
    payload.reportMode !== "r2"
  ) {
    return null;
  }
  const watchPayload: EncryptedWatchPayload = {
    version: 1,
    target: { url: payload.url },
    options: {
      device: payload.device,
      gpcEnabled: payload.gpcEnabled,
      reportMode: "r2",
      comparison: "none"
    }
  };
  return isEncryptedWatchPayload(watchPayload) ? watchPayload : null;
}
