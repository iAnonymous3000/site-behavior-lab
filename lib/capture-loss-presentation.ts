import {
  CAPTURE_LOSS_DETAIL_CONTRACT,
  RESPONSE_BYTE_CAPTURE_LOSS_DETAIL,
  isKnownCaptureLossDetail,
  type KnownCaptureLossDetail
} from "./capture-loss-detail-contract";
import type { CaptureLossEntry } from "./scan-report-v2";

type CountUnit = {
  singular: string;
  plural: string;
};

type CaptureLossPresentation = {
  subject: string;
  countUnit: CountUnit | null;
};

const unit = (singular: string, plural = `${singular}s`): CountUnit => ({ singular, plural });

const PUBLIC_PROJECTION_PRESENTATION = Object.freeze({
  subject: "the bounded public evidence projection",
  countUnit: null
});

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
      return { subject: "request evidence collection", countUnit: unit("request routing or recording event") };
    case RESPONSE_BYTE_CAPTURE_LOSS_DETAIL:
      return {
        subject: "aggregate response-byte loading",
        countUnit: unit("response stream or proxy tunnel", "response streams or proxy tunnels")
      };
    case "request-upload":
      return {
        subject: "aggregate upload forwarding",
        countUnit: unit("upload stream or proxy tunnel", "upload streams or proxy tunnels")
      };
    case "proxy-traffic":
      return { subject: "proxy traffic forwarding", countUnit: unit("proxy transaction") };
    case "cookie-snapshot":
      return { subject: "the end-of-visit cookie snapshot", countUnit: unit("snapshot operation") };
    case "storage-snapshot":
      return { subject: "the end-of-visit storage snapshot", countUnit: unit("snapshot operation") };
    case "fingerprint-observer":
      return { subject: "the in-page fingerprint observer", countUnit: null };
    case "keystroke-probe":
      return { subject: "the synthetic keystroke probe", countUnit: null };
    case "cname-lookups":
      return { subject: "the tracker-CNAME lookups", countUnit: unit("lookup") };
    case "pixel-decode":
      return { subject: "the advertising-pixel request-body decoder", countUnit: unit("request body") };
    case "consent-banner":
      return { subject: "the consent-banner probe", countUnit: null };
    case "policy-visit":
      return { subject: "the privacy-policy visit", countUnit: unit("privacy-policy visit") };
    case "policy-link-candidates":
      return { subject: "the privacy-policy link search", countUnit: null };
    case "keystroke-probe-capture":
      return { subject: "the synthetic keystroke probe's readback", countUnit: null };
    case "page-title":
      return { subject: "the page title capture", countUnit: null };
    case "page-subject-validity":
      return { subject: "the page-subject validity check", countUnit: null };
    case "consent-verification":
      return { subject: "consent-state verification", countUnit: unit("verification operation") };
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
      return { subject: "an evidence family unsupported by the PageGraph producer", countUnit: null };
    case "pagegraph-request-loss":
      return { subject: "PageGraph request collection", countUnit: null };
    case "pagegraph-invalid-request":
      return { subject: "PageGraph request validation", countUnit: unit("request record") };
    case "r2-navigation-status-unrepresentable":
      return { subject: "navigation-status capture", countUnit: unit("status observation") };
    case "r2-request-status-unrepresentable":
      return { subject: "request-status capture", countUnit: unit("status observation") };
    default:
      return assertNever(detail);
  }
}

function countLabel(count: number, countUnit: CountUnit): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? countUnit.singular : countUnit.plural}`;
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

export function captureLossPresentationSubject(detail: string | undefined): string | null {
  if (detail === undefined || !isKnownCaptureLossDetail(detail)) return null;
  return captureLossPresentation(detail).subject;
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
    return `${countLabel(loss.count, presentation.countUnit!)} ${
      loss.count === 1 ? "was" : "were"
    } truncated or refused at or after the ${ceiling}`;
  }
  if (detail === "request-upload" && loss.count > 0) {
    const ceiling = options.uploadByteLimit
      ? `${options.uploadByteLimit} aggregate upload-byte ceiling`
      : "configured aggregate upload-byte ceiling";
    return `${countLabel(loss.count, presentation.countUnit!)} ${
      loss.count === 1 ? "was" : "were"
    } truncated or refused at or after the ${ceiling}`;
  }
  if (detail === "proxy-traffic" && loss.count > 0) {
    return `${countLabel(loss.count, presentation.countUnit!)} ${
      loss.count === 1 ? "was" : "were"
    } refused by the connection and target safety budget`;
  }
  if (detail === "pagegraph-unsupported") {
    return `${presentation.subject} (${recordedLossCount(loss.count)})`;
  }
  if (presentation.countUnit !== null && loss.count > 0) {
    return `${countLabel(loss.count, presentation.countUnit)} ${describedAction(loss.kind, loss.count)}`;
  }
  return `${presentation.subject} did not finish (${recordedLossCount(loss.count)})`;
}

export const KNOWN_CAPTURE_LOSS_DETAILS = Object.freeze(
  Object.keys(CAPTURE_LOSS_DETAIL_CONTRACT) as KnownCaptureLossDetail[]
);
