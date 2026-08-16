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

/**
 * Human presentation for every first-party detail token.
 *
 * `satisfies Record<KnownCaptureLossDetail, ...>` is the compiler gate: adding
 * a producer token without reader copy fails TypeScript. The public schema is
 * still forward-compatible; an unknown conforming producer receives generic
 * safe copy rather than leaking its internal token or crashing the report.
 */
export const CAPTURE_LOSS_PRESENTATIONS = Object.freeze({
  "request-capture": {
    subject: "request evidence collection",
    countUnit: unit("request routing or recording event")
  },
  [RESPONSE_BYTE_CAPTURE_LOSS_DETAIL]: {
    subject: "aggregate response-byte loading",
    countUnit: unit("response stream or proxy tunnel", "response streams or proxy tunnels")
  },
  "request-upload": {
    subject: "aggregate upload forwarding",
    countUnit: unit("upload stream or proxy tunnel", "upload streams or proxy tunnels")
  },
  "proxy-traffic": { subject: "proxy traffic forwarding", countUnit: unit("proxy transaction") },
  "cookie-snapshot": { subject: "the end-of-visit cookie snapshot", countUnit: unit("snapshot operation") },
  "storage-snapshot": { subject: "the end-of-visit storage snapshot", countUnit: unit("snapshot operation") },
  "fingerprint-observer": { subject: "the in-page fingerprint observer", countUnit: null },
  "keystroke-probe": { subject: "the synthetic keystroke probe", countUnit: null },
  "cname-lookups": { subject: "the tracker-CNAME lookups", countUnit: unit("lookup") },
  "pixel-decode": { subject: "the advertising-pixel request-body decoder", countUnit: unit("request body") },
  "consent-banner": { subject: "the consent-banner probe", countUnit: null },
  "policy-visit": { subject: "the privacy-policy visit", countUnit: unit("privacy-policy visit") },
  "policy-link-candidates": { subject: "the privacy-policy link search", countUnit: null },
  "keystroke-probe-capture": { subject: "the synthetic keystroke probe's readback", countUnit: null },
  "page-title": { subject: "the page title capture", countUnit: null },
  "page-subject-validity": { subject: "the page-subject validity check", countUnit: null },
  "consent-verification": { subject: "consent-state verification", countUnit: unit("verification operation") },
  "public-request-unregistrable-hosts": {
    subject: "public request-host registration",
    countUnit: unit("request record")
  },
  "public-request-records": { subject: "the public request-record list", countUnit: unit("request record") },
  "public-cookie-mutations": { subject: "the public cookie-mutation list", countUnit: unit("cookie mutation") },
  "public-cookie-final": { subject: "the public final-cookie list", countUnit: unit("cookie record") },
  "public-storage-mutations": { subject: "the public storage-mutation list", countUnit: unit("storage mutation") },
  "public-storage-final": { subject: "the public final-storage list", countUnit: unit("storage record") },
  "public-fingerprint-events": { subject: "the public fingerprint-event list", countUnit: unit("fingerprint event") },
  "public-fingerprint-detections": {
    subject: "the public fingerprint-detection list",
    countUnit: unit("fingerprint detection")
  },
  "public-cname-cloaks": { subject: "the public CNAME-cloak list", countUnit: unit("CNAME-cloak record") },
  "public-pixel-events": { subject: "the public pixel-event list", countUnit: unit("pixel event") },
  "public-policy-claims": { subject: "the public policy-claim list", countUnit: unit("policy claim") },
  "public-policy-entities": { subject: "the public policy-entity list", countUnit: unit("policy entity") },
  "public-warnings": { subject: "the public warning list", countUnit: unit("warning") },
  "public-consent-observations": {
    subject: "the public consent-observation list",
    countUnit: unit("consent observation")
  },
  "pagegraph-unsupported": { subject: "an evidence family unsupported by the PageGraph producer", countUnit: null },
  "pagegraph-request-loss": { subject: "PageGraph request collection", countUnit: null },
  "pagegraph-invalid-request": { subject: "PageGraph request validation", countUnit: unit("request record") },
  "r2-navigation-status-unrepresentable": { subject: "navigation-status capture", countUnit: unit("status observation") },
  "r2-request-status-unrepresentable": { subject: "request-status capture", countUnit: unit("status observation") }
} as const satisfies Record<KnownCaptureLossDetail, CaptureLossPresentation>);

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
  return CAPTURE_LOSS_PRESENTATIONS[detail].subject;
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

  const presentation = CAPTURE_LOSS_PRESENTATIONS[detail];
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
