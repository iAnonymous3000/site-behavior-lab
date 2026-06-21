import type { FingerprintDetectionSummary, ScanResult } from "./types";

/**
 * Shared tracker/fingerprint classification derived from a {@link ScanResult}.
 *
 * This is the single source of truth for "which third parties are tracking
 * companies", "which are merely operational", and "which fingerprinting
 * heuristics are high-entropy". It is consumed by both the report UI
 * (`app/site-behavior-app.tsx`) and the plain-language headline layer
 * (`lib/report-headline.ts`), which previously kept hand-synced copies.
 *
 * It is intentionally dependency-free (types only) so it can run in the React
 * client, in server-side `generateMetadata`, and inside the `next/og` image
 * route without pulling in browser- or Node-only code.
 */

/** Recognizable platforms that make the strongest plain-language headline. */
export const HEADLINE_PLATFORMS = ["Google", "Meta", "TikTok", "X", "Microsoft", "LinkedIn", "Pinterest"];

const OPERATIONAL_CATEGORY_HINTS = ["error monitoring", "performance monitoring", "customer support", "customer messaging"];
const TRACKING_CATEGORY_HINTS = [
  "advertis",
  "analytics",
  "pixel",
  "audience",
  "measurement",
  "retarget",
  "social",
  "data platform",
  "data management",
  "tag manag",
  "marketing",
  "session replay",
  "behavior"
];

const HIGH_ENTROPY_FINGERPRINT_KINDS = new Set<FingerprintDetectionSummary["kind"]>([
  "canvas-fingerprinting",
  "canvas-font-fingerprinting",
  "webgl-fingerprinting",
  "audio-fingerprinting",
  "webrtc-fingerprinting"
]);

export type TrackerEntitySummary = {
  entity: string;
  requests: number;
  domains: number;
  categories: string[];
};

/** Group a scan's third-party tracker domains by entity, busiest first. */
export function trackerEntitySummaries(result: ScanResult): TrackerEntitySummary[] {
  const summaries = new Map<string, TrackerEntitySummary>();

  for (const domain of result.domains) {
    if (!domain.thirdParty || !domain.tracker) continue;
    const current = summaries.get(domain.tracker.entity) ?? {
      entity: domain.tracker.entity,
      requests: 0,
      domains: 0,
      categories: []
    };
    current.requests += domain.requests;
    current.domains += 1;
    if (!current.categories.includes(domain.tracker.category)) {
      current.categories.push(domain.tracker.category);
    }
    summaries.set(domain.tracker.entity, current);
  }

  return Array.from(summaries.values()).sort((a, b) => b.requests - a.requests || a.entity.localeCompare(b.entity));
}

/** An entity whose every category is operational (monitoring/support), not cross-site tracking. */
export function isOperationalEntity(entity: TrackerEntitySummary): boolean {
  return entity.categories.length > 0 && entity.categories.every((category) => !isTrackingCategory(category));
}

/** High-entropy fingerprinting detections (canvas/WebGL/audio/WebRTC), excluding listener-coverage signals. */
export function highEntropyDetections(result: ScanResult): FingerprintDetectionSummary[] {
  return (result.fingerprintDetections ?? []).filter((detection) => HIGH_ENTROPY_FINGERPRINT_KINDS.has(detection.kind));
}

function isTrackingCategory(category: string): boolean {
  const lower = category.toLowerCase();
  if (TRACKING_CATEGORY_HINTS.some((hint) => lower.includes(hint))) return true;
  return !OPERATIONAL_CATEGORY_HINTS.some((hint) => lower.includes(hint));
}
