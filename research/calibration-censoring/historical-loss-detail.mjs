/**
 * The historical `request-capture` detail names TWO independent ceilings.
 *
 * Under `resource-budget-v1` the aggregate response-byte budget and the
 * 1,000-request recording cap both recorded `request-capture`, and those wires
 * are immutable. The run's warnings are the only surviving discriminator, and
 * the product already resolves it: `presentationLoss` in
 * `lib/scan-report-censorship.ts` rewrites the detail to `response-bytes` when
 * the byte warning is present and the recording-cap warning is not. The corpus
 * censoring driver read `detail` raw, so its reasons table attributed a
 * byte-budget loss to the recording cap.
 *
 * This changes NO scoreability number: both details sit in the `requests`
 * family, which is censored either way. It changes the causal breakdown, which
 * is what an instrument-hardening plan gets scoped from, and that is the whole
 * reason to fix it.
 *
 * Its own module so the driver stays a script with no importable side effects
 * and this rule can be tested directly. Restated here rather than imported
 * because the driver is deliberately builtins-only; `assertDiscriminatorMatchesProduct`
 * pins the restatement to the product source so the two cannot drift silently,
 * which is the failure mode that produced the mis-attributed table.
 */
import fs from "node:fs";
import path from "node:path";

export const RESPONSE_BYTE_LIMIT_WARNING =
  /reaching the ([1-9][0-9,]* MiB) aggregate response-byte budget/;
export const REQUEST_RECORDING_LIMIT_WARNING =
  /stopped recording or loading additional requests after ([1-9][0-9,]*) requests/;
export const RESPONSE_BYTE_CAPTURE_LOSS_DETAIL = "response-bytes";
export const HISTORICAL_MERGED_DETAIL = "request-capture";

/**
 * Resolve only when exactly one cause is proven, exactly as the product does.
 * A run carrying both warnings keeps `request-capture`, because nothing in the
 * record says which ceiling cut which request.
 */
export function normalizeHistoricalLossDetail(loss, warnings) {
  if (!loss || typeof loss !== "object") return loss;
  if (loss.detail !== HISTORICAL_MERGED_DETAIL) return loss;
  const list = Array.isArray(warnings) ? warnings : [];
  const byteLimited = list.some((w) => RESPONSE_BYTE_LIMIT_WARNING.test(String(w)));
  const recordingCapped = list.some((w) =>
    REQUEST_RECORDING_LIMIT_WARNING.test(String(w))
  );
  if (byteLimited && !recordingCapped) {
    return { ...loss, detail: RESPONSE_BYTE_CAPTURE_LOSS_DETAIL };
  }
  return loss;
}

/** Throws when the product's discriminator no longer matches this restatement. */
export function assertDiscriminatorMatchesProduct(repoRoot) {
  const source = fs.readFileSync(
    path.join(repoRoot, "lib", "scan-report-censorship.ts"),
    "utf8"
  );
  for (const pattern of [
    RESPONSE_BYTE_LIMIT_WARNING,
    REQUEST_RECORDING_LIMIT_WARNING
  ]) {
    if (!source.includes(pattern.source)) {
      throw new Error(
        `historical capture-loss discriminator drifted: lib/scan-report-censorship.ts no longer declares /${pattern.source}/`
      );
    }
  }
  if (!source.includes("RESPONSE_BYTE_CAPTURE_LOSS_DETAIL")) {
    throw new Error(
      "lib/scan-report-censorship.ts no longer resolves the historical response-byte detail"
    );
  }
}
