import {
  CAPTURE_LOSS_DETAIL_CONTRACT,
  RESPONSE_BYTE_CAPTURE_LOSS_DETAIL,
  isKnownCaptureLossDetail,
  type KnownCaptureLossDetail
} from "./capture-loss-detail-contract";
import type { CaptureLossEntry } from "./scan-report-v2";

type CaptureLossPresentation = readonly [
  /** Human subject for losses whose recorded count has no stable unit. */
  subject: string | null,
  /** Stable unit for a positive recorded count. */
  singular?: string,
  plural?: string
];

const PUBLIC_PROJECTION_PRESENTATION = ["the bounded public evidence projection"] as const;

function assertNever(value: never): never {
  throw new Error(`unpresented first-party capture-loss detail: ${String(value)}`);
}

/**
 * Human presentation for every first-party detail token.
 *
 * This exhaustive switch is the compiler gate: adding a producer token to the
 * semantic contract without reader handling makes the default call fail
 * TypeScript's `never` check. Grouped public-projection markers deliberately
 * share one honest presentation because their counts have different units;
 * naming a made-up common unit would be worse than retaining the wire count.
 * Unknown conforming producers still receive generic safe copy.
 */
function captureLossPresentation(detail: KnownCaptureLossDetail): CaptureLossPresentation {
  switch (detail) {
    case "request-capture":
      return [null, "request routing or recording event"];
    case RESPONSE_BYTE_CAPTURE_LOSS_DETAIL:
      return [null, "response stream or proxy tunnel", "response streams or proxy tunnels"];
    case "request-upload":
      return [null, "upload stream or proxy tunnel", "upload streams or proxy tunnels"];
    case "proxy-traffic":
      return [null, "proxy transaction"];
    case "cookie-snapshot":
    case "storage-snapshot":
      return [null, "snapshot operation"];
    case "fingerprint-observer":
      return ["the in-page fingerprint observer"];
    case "keystroke-probe":
      return ["the synthetic keystroke probe"];
    case "cname-lookups":
      return [null, "CNAME lookup"];
    case "pixel-decode":
      return [null, "pixel request body"];
    case "consent-banner":
      return ["the consent-banner probe"];
    case "policy-visit":
      return [null, "privacy-policy visit"];
    case "policy-link-candidates":
      return ["the privacy-policy link search"];
    case "keystroke-probe-capture":
      return ["the synthetic keystroke probe's readback"];
    case "page-title":
      return ["the page title capture"];
    case "page-subject-validity":
      return ["the page-subject validity check"];
    case "consent-verification":
      return [null, "consent verification"];
    case "public-request-unregistrable-hosts":
    case "public-request-records":
    case "public-cookie-mutations":
    case "public-cookie-final":
    case "public-storage-mutations":
    case "public-storage-final":
    case "public-fingerprint-events":
    case "public-fingerprint-detections":
    case "public-cname-cloaks":
    case "public-pixel-events":
    case "public-policy-claims":
    case "public-policy-entities":
    case "public-warnings":
    case "public-consent-observations":
      return PUBLIC_PROJECTION_PRESENTATION;
    case "pagegraph-unsupported":
      return ["an evidence family unsupported by the PageGraph producer"];
    case "pagegraph-request-loss":
      return ["PageGraph request collection"];
    case "pagegraph-invalid-request":
      return [null, "request record"];
    case "r2-navigation-status-unrepresentable":
    case "r2-request-status-unrepresentable":
      return [null, "status observation"];
    default:
      return assertNever(detail);
  }
}

function countLabel(count: number, presentation: CaptureLossPresentation): string {
  const singular = presentation[1]!;
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : (presentation[2] ?? `${singular}s`)}`;
}

function recordedLossCount(count: number): string {
  return `recorded loss count: ${count.toLocaleString("en-US")}`;
}

function describedAction(kind: CaptureLossEntry["kind"], count: number): string {
  const singular = count === 1;
  switch (kind) {
    case "cap":
      return singular ? "was cut off at the configured ceiling" : "were cut off at the configured ceiling";
    case "clipped":
      return singular ? "was omitted at the public evidence ceiling" : "were omitted at the public evidence ceiling";
    case "truncated":
      return "did not finish before collection stopped";
    case "timeout":
      return "did not finish before the deadline";
    case "dropped":
      return "did not produce usable evidence";
  }
}

export function captureLossDetailNote(
  loss: CaptureLossEntry,
  options: {
    responseByteLimit?: string;
    uploadByteLimit?: string;
    historicalMergedRequestAndByteLoss?: boolean;
  } = {}
): string {
  const detail = loss.detail;
  if (detail === undefined || !isKnownCaptureLossDetail(detail)) {
    return `the producer recorded an additional collection loss (${recordedLossCount(loss.count)})`;
  }

  const presentation = captureLossPresentation(detail);
  if (detail === "request-capture" && options.historicalMergedRequestAndByteLoss) {
    return `request recording and response-byte loading did not finish; the historical wire carries a combined ${recordedLossCount(
      loss.count
    )} that cannot be partitioned between the two ceilings`;
  }
  if (detail === RESPONSE_BYTE_CAPTURE_LOSS_DETAIL && loss.count > 0) {
    const ceiling = options.responseByteLimit
      ? `${options.responseByteLimit} aggregate response-byte ceiling`
      : "configured aggregate response-byte ceiling";
    return `${countLabel(loss.count, presentation)} ${
      loss.count === 1 ? "was" : "were"
    } truncated or refused at or after the ${ceiling}`;
  }
  if (detail === "request-upload" && loss.count > 0) {
    const ceiling = options.uploadByteLimit
      ? `${options.uploadByteLimit} aggregate upload-byte ceiling`
      : "configured aggregate upload-byte ceiling";
    return `${countLabel(loss.count, presentation)} ${
      loss.count === 1 ? "was" : "were"
    } truncated or refused at or after the ${ceiling}`;
  }
  if (detail === "proxy-traffic" && loss.count > 0) {
    return `${countLabel(loss.count, presentation)} ${
      loss.count === 1 ? "was" : "were"
    } refused by the connection and target safety budget`;
  }
  if (detail === "pagegraph-unsupported") {
    return `${presentation[0]} (${recordedLossCount(loss.count)})`;
  }
  if (presentation[1] !== undefined && loss.count > 0) {
    return `${countLabel(loss.count, presentation)} ${describedAction(loss.kind, loss.count)}`;
  }
  return `${presentation[0] ?? "evidence collection"} did not finish (${recordedLossCount(loss.count)})`;
}

export const KNOWN_CAPTURE_LOSS_DETAILS = Object.freeze(
  Object.keys(CAPTURE_LOSS_DETAIL_CONTRACT) as KnownCaptureLossDetail[]
);
