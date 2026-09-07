import { readResponseJsonWithinLimit } from "./http-response.mjs";

/** Target HTTP outcomes belong inside reports; endpoint 5xx is an instrument failure. */
export async function readScannerFidelityResponse(response, label) {
  if (response.status >= 500) {
    await response.body?.cancel();
    throw new Error(`${label}: scanner endpoint failed (HTTP ${response.status}); this is not a skipped target.`);
  }
  const body = await readResponseJsonWithinLimit(response, {
    maxBytes: 32 * 1024 * 1024,
    label
  });
  if (!response.ok || body?.ok === false) {
    return { ok: false, reason: body?.error ?? `HTTP ${response.status}` };
  }
  return { ok: true, report: body?.report ?? body };
}
