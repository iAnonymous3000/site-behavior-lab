import { readRenderableReport } from "./client-report-reader";
import type { ScanReport } from "./types";

/**
 * Recovery read of a saved report from an `/api/reports/{id}` response.
 *
 * The distinction this module exists to pin: `null` means the report is
 * genuinely not available (a 404: missing or expired), so the caller may keep
 * waiting or fall back to its own message. Every other failure THROWS with the
 * named reason, because the report exists but cannot be served or read: the
 * server's intentional 500 for an unreadable or newer-schema stored report,
 * and a 2xx payload that fails the canonical reader, must reach the user
 * instead of dissolving into "still running".
 *
 * Takes the minimal Response surface so it unit-tests without a browser.
 */

export type RecoveryResponse = {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
};

export async function recoverSavedReport(response: RecoveryResponse): Promise<ScanReport | null> {
  if (response.status === 404) return null;
  if (!response.ok) {
    const message = await apiErrorMessage(response);
    throw new Error(message ?? `The saved report could not be read (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as unknown;
  const read = await readRenderableReport(payload, "The saved report");
  if (!read.ok) throw new Error(read.message);
  return read.report;
}

/** The `{ ok: false, error }` message from an API error body, if it has one. */
export async function apiErrorMessage(response: Pick<RecoveryResponse, "json">): Promise<string | null> {
  try {
    const payload = (await response.json()) as unknown;
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    /* non-JSON error body */
  }
  return null;
}
