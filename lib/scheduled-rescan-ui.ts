import type { EncryptedWatchCredentials, EncryptedWatchRun } from "./encrypted-watch-client";
import {
  deriveEncryptedWatchIdFromCapabilityToken,
  type EncryptedWatchPayload
} from "./encrypted-watch-contract";

export const SCHEDULED_RESCAN_POLICY_COPY =
  "Runs once now, then every 7 days. It expires after 30 days or a maximum of 5 scheduled attempts, whichever comes first.";

export const SCHEDULED_RESCAN_BOUNDARY_COPY = "Scheduled rescans, not change alerts.";

export const SCHEDULED_RESCAN_CAPABILITY_COPY =
  "Keep this tab's URL private. Its fragment is the only recovery capability. It is not kept in local or session storage, and fragments are not sent in HTTP requests; browser history may retain it.";

export const SCHEDULED_RESCAN_INVALID_LINK_COPY =
  "This only removes the invalid management link from this page; no server schedule is deleted.";

export const SCHEDULED_RESCAN_RETRY_COPY =
  "Retry scheduling reuses the original target, device, and GPC choice retained before the first request. Edits in the scan form do not change it.";

export type ScheduledRescanActionState =
  | { visibility: "hidden" }
  | { visibility: "disabled"; reason: string }
  | { visibility: "ready" };

export type ScheduledRescanTarget = Readonly<{
  url: string;
  removedPrivateParts: boolean;
}>;

export type PendingScheduledRescanCreation = Readonly<{
  credentials: EncryptedWatchCredentials;
  payload: EncryptedWatchPayload;
}>;

export type ScheduledRescanRunPresentation = Readonly<{
  label: "Queued" | "Running" | "Succeeded" | "Failed" | "Admission failed" | "Expired" | "Cancelled";
  reportId: string | null;
}>;

/** Build the strict no-credentials/query/fragment target accepted by watches. */
export function normalizeScheduledRescanTarget(value: string): ScheduledRescanTarget | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const removedPrivateParts = Boolean(parsed.search || parsed.hash);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href.length <= 4_096 ? Object.freeze({ url: parsed.href, removedPrivateParts }) : null;
  } catch {
    return null;
  }
}

/** Pure UI gate: absence is capability-driven, never inferred from build flags. */
export function scheduledRescanActionState(input: {
  featureEnabled: boolean;
  comparisonMode: boolean;
  targetReady: boolean;
  scanBlocked: boolean;
  busy: boolean;
  acceptedScanJob: boolean;
}): ScheduledRescanActionState {
  if (!input.featureEnabled) return { visibility: "hidden" };
  if (input.comparisonMode) {
    return { visibility: "disabled", reason: "Scheduled rescans support single scans only." };
  }
  if (input.busy || input.acceptedScanJob) {
    return { visibility: "disabled", reason: "Wait for the current scan to finish before scheduling." };
  }
  if (input.scanBlocked) {
    return { visibility: "disabled", reason: "Complete the scanner checks above before scheduling." };
  }
  if (!input.targetReady) {
    return { visibility: "disabled", reason: "Enter a valid public URL before scheduling." };
  }
  return { visibility: "ready" };
}

/** Existing fragment capabilities stay manageable through feature rollback. */
export function scheduledRescanPanelVisible(
  action: ScheduledRescanActionState,
  hasCredentials: boolean,
  hasInvalidManagementFragment = false
): boolean {
  return action.visibility !== "hidden" || hasCredentials || hasInvalidManagementFragment;
}

/**
 * Freeze capability and payload together before creation, and synchronously
 * retain them before the caller crosses the POST boundary. An uncertain retry
 * reuses the exact pair instead of rebuilding meaning from mutable form state.
 */
export async function retainScheduledRescanCreationBeforePost(options: {
  pendingCreation: PendingScheduledRescanCreation | null;
  candidatePayload: EncryptedWatchPayload;
  mintCredentials: () => Promise<EncryptedWatchCredentials>;
  retainCreation: (creation: PendingScheduledRescanCreation) => void;
}): Promise<PendingScheduledRescanCreation> {
  const creation =
    options.pendingCreation ??
    Object.freeze({
      credentials: await options.mintCredentials(),
      payload: freezeScheduledRescanPayload(options.candidatePayload)
    });
  options.retainCreation(creation);
  return creation;
}

/** A fragment alone cannot prove which immutable POST payload it belongs to. */
export function scheduledRescanCanRetryCreation(
  pendingCreation: PendingScheduledRescanCreation | null,
  credentials: EncryptedWatchCredentials | null
): boolean {
  return Boolean(
    pendingCreation &&
      credentials &&
      pendingCreation.credentials.watchId === credentials.watchId &&
      pendingCreation.credentials.capabilityToken === credentials.capabilityToken
  );
}

/** Reject hand-edited canonical-looking pairs before exposing management UI. */
export async function scheduledRescanCredentialsMatchDerivedId(
  credentials: EncryptedWatchCredentials
): Promise<boolean> {
  try {
    return (
      (await deriveEncryptedWatchIdFromCapabilityToken(credentials.capabilityToken)) ===
      credentials.watchId
    );
  } catch {
    return false;
  }
}

/** Present the closed run-state contract without inventing a report link. */
export function scheduledRescanRunPresentation(
  run: EncryptedWatchRun
): ScheduledRescanRunPresentation {
  if (run.status === "succeeded") return Object.freeze({ label: "Succeeded", reportId: run.reportId });
  if (run.status === "failed") {
    return Object.freeze({
      label: run.admittedAt === null ? "Admission failed" : "Failed",
      reportId: null
    });
  }
  const labels = {
    queued: "Queued",
    running: "Running",
    expired: "Expired",
    cancelled: "Cancelled"
  } as const;
  return Object.freeze({ label: labels[run.status], reportId: null });
}

function freezeScheduledRescanPayload(payload: EncryptedWatchPayload): EncryptedWatchPayload {
  return Object.freeze({
    version: 1,
    target: Object.freeze({ url: payload.target.url }),
    options: Object.freeze({
      device: payload.options.device,
      gpcEnabled: payload.options.gpcEnabled,
      reportMode: "r2",
      comparison: "none"
    })
  });
}
