import { PAGE_SUBJECT_CAPTURE_LOSS_DETAIL } from "./bot-wall-classifier";
import type { EvidenceFamily } from "./scan-report-v2";
import {
  R2_NAVIGATION_STATUS_UNREPRESENTABLE,
  R2_REQUEST_STATUS_UNREPRESENTABLE
} from "./scan-report-v2-http-status";

export const RESPONSE_BYTE_CAPTURE_LOSS_DETAIL = "response-bytes" as const;

export const PAGEGRAPH_UNSUPPORTED_CAPTURE_LOSS_FAMILIES = Object.freeze([
  "cookies",
  "storage",
  "fingerprinting",
  "detector-output",
  "consent-verification"
] as const satisfies readonly EvidenceFamily[]);

export type CaptureLossDetailContract = {
  /** Every evidence family under which this detail may truthfully appear. */
  families: readonly EvidenceFamily[];
  /** True when this token may also appear in qualityFacts.budgetsExhausted. */
  budget: boolean;
};

/**
 * Details emitted by the first-party Node and PageGraph producers.
 *
 * ScanReport v2 deliberately leaves `detail` open so another conforming
 * producer can retain a target-free diagnostic without a schema revision.
 * First-party producers are stricter: every token they emit belongs here, so
 * the evaluator and presentation layer share one semantic registry rather
 * than maintaining independent string maps.
 */
export const CAPTURE_LOSS_DETAIL_CONTRACT = Object.freeze({
  "request-capture": { families: ["requests"], budget: true },
  [RESPONSE_BYTE_CAPTURE_LOSS_DETAIL]: { families: ["requests"], budget: true },
  "request-upload": { families: ["requests"], budget: true },
  "proxy-traffic": { families: ["requests"], budget: true },
  "cookie-snapshot": { families: ["cookies"], budget: true },
  "storage-snapshot": { families: ["storage"], budget: true },
  "fingerprint-observer": { families: ["fingerprinting"], budget: true },
  "keystroke-probe": { families: ["detector-output"], budget: true },
  "cname-lookups": { families: ["detector-output"], budget: true },
  "pixel-decode": { families: ["detector-output"], budget: true },
  "consent-banner": { families: ["detector-output"], budget: true },
  "policy-visit": { families: ["detector-output"], budget: true },
  "policy-link-candidates": { families: ["detector-output"], budget: false },
  "keystroke-probe-capture": { families: ["detector-output"], budget: false },
  "page-title": { families: ["detector-output"], budget: false },
  [PAGE_SUBJECT_CAPTURE_LOSS_DETAIL]: { families: ["detector-output"], budget: false },
  "consent-verification": { families: ["consent-verification"], budget: true },
  "public-request-unregistrable-hosts": { families: ["requests"], budget: true },
  "public-request-records": { families: ["requests"], budget: true },
  "public-cookie-mutations": { families: ["cookies"], budget: true },
  "public-cookie-final": { families: ["cookies"], budget: true },
  "public-storage-mutations": { families: ["storage"], budget: true },
  "public-storage-final": { families: ["storage"], budget: true },
  "public-fingerprint-events": { families: ["fingerprinting"], budget: true },
  "public-fingerprint-detections": { families: ["detector-output"], budget: true },
  "public-cname-cloaks": { families: ["detector-output"], budget: true },
  "public-pixel-events": { families: ["detector-output"], budget: true },
  "public-policy-claims": { families: ["detector-output"], budget: true },
  "public-policy-entities": { families: ["detector-output"], budget: true },
  "public-warnings": { families: ["detector-output"], budget: true },
  "public-consent-observations": { families: ["consent-verification"], budget: true },
  "pagegraph-unsupported": { families: PAGEGRAPH_UNSUPPORTED_CAPTURE_LOSS_FAMILIES, budget: false },
  "pagegraph-request-loss": { families: ["requests"], budget: false },
  "pagegraph-invalid-request": { families: ["requests"], budget: false },
  [R2_NAVIGATION_STATUS_UNREPRESENTABLE]: { families: ["requests"], budget: false },
  [R2_REQUEST_STATUS_UNREPRESENTABLE]: { families: ["requests"], budget: false }
} as const satisfies Record<string, CaptureLossDetailContract>);

export type KnownCaptureLossDetail = keyof typeof CAPTURE_LOSS_DETAIL_CONTRACT;

export function isKnownCaptureLossDetail(value: string): value is KnownCaptureLossDetail {
  return Object.prototype.hasOwnProperty.call(CAPTURE_LOSS_DETAIL_CONTRACT, value);
}

export function captureLossDetailAllowsFamily(value: string, family: EvidenceFamily): boolean {
  return (
    isKnownCaptureLossDetail(value) &&
    (CAPTURE_LOSS_DETAIL_CONTRACT[value].families as readonly EvidenceFamily[]).includes(family)
  );
}

function captureLossDetailFamilies(): Record<KnownCaptureLossDetail, readonly EvidenceFamily[]> {
  const families = {} as Record<KnownCaptureLossDetail, readonly EvidenceFamily[]>;
  for (const detail of Object.keys(CAPTURE_LOSS_DETAIL_CONTRACT) as KnownCaptureLossDetail[]) {
    families[detail] = CAPTURE_LOSS_DETAIL_CONTRACT[detail].families;
  }
  return families;
}

export const CAPTURE_LOSS_DETAIL_FAMILIES = Object.freeze(captureLossDetailFamilies());
