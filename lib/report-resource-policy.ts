import { isRecord } from "./guards";
import { INLINE_SCREENSHOT_LIMITS, isSafeInlineScreenshotDataUri } from "./inline-screenshot";

/**
 * Shared admission limits for already-decoded public report payloads. The
 * wire-byte cap bounds memory, but compact JSON can still encode tens of
 * thousands of rows which structural validators, semantic evaluators, and
 * renderers would otherwise walk. Keep this module dependency-light so both
 * server storage reads and browser readers can run it before deep validation.
 */
export const REPORT_RESOURCE_LIMITS = Object.freeze({
  maxNestingDepth: 128,
  maxAnyArray: 2_000,
  maxTotalArrayEntries: 100_000,
  maxObjectProperties: 64,
  maxTotalObjectProperties: 300_000,
  maxObjectKeyChars: 128,
  maxAnyStringChars: 16_384,
  maxTotalStringChars: 8 * 1024 * 1024,
  maxTotalNonScreenshotStringChars: 2 * 1024 * 1024,
  maxScreenshotChars: INLINE_SCREENSHOT_LIMITS.maxUriChars,
  phases: 16,
  warnings: 64,
  warningChars: 600,
  qualityEntries: 64,
  requests: 1_000,
  cookieMutations: 2_000,
  cookies: 1_000,
  storageMutations: 2_000,
  storage: 1_000,
  fingerprintEvents: 1_000,
  fingerprintDetections: 256,
  fingerprintEvidenceEntries: 1_000,
  cnameCloaks: 256,
  pixelEvents: 512,
  pixelEventNames: 100,
  pixelMatchFields: 7,
  consentObservations: 32,
  bannerObservations: 3,
  policyClaims: 32,
  policyEntities: 100,
  policyQuoteChars: 200,
  hostnameChars: 253,
  labelChars: 1_024,
  supportingPairs: 1,
  comparisonReasons: 64,
  diffTrackerDomains: 1_000,
  diffDetectionKinds: 256
});

function arrayAtMost(value: unknown, maximum: number): boolean {
  return !Array.isArray(value) || value.length <= maximum;
}

function reportPayload(payload: unknown): unknown {
  if (isRecord(payload) && payload.status === "succeeded" && "report" in payload) return payload.report;
  return payload;
}

type GraphEntry = {
  value: unknown;
  depth: number;
  maxStringChars: number;
  screenshot: boolean;
};

const SCREENSHOT_KEYS = new Set(["screenshot", "baselineScreenshot", "variantScreenshot"]);
const HOSTNAME_KEYS = /(?:^|_)(?:domain|host|hostname|cname)$/i;
const LABEL_KEYS = /(?:title|label|entity|category|name|key|method|product)$/i;

function childStringPolicy(key: string, value: unknown): Pick<GraphEntry, "maxStringChars" | "screenshot"> {
  if (SCREENSHOT_KEYS.has(key) && typeof value === "string") {
    return isSafeInlineScreenshotDataUri(value)
      ? { maxStringChars: REPORT_RESOURCE_LIMITS.maxScreenshotChars, screenshot: true }
      : { maxStringChars: -1, screenshot: false };
  }
  if (key === "warnings") {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.warningChars, screenshot: false };
  }
  if (key === "quote") {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.policyQuoteChars, screenshot: false };
  }
  if (HOSTNAME_KEYS.test(key)) {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.hostnameChars, screenshot: false };
  }
  if (LABEL_KEYS.test(key)) {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.labelChars, screenshot: false };
  }
  return { maxStringChars: REPORT_RESOURCE_LIMITS.maxAnyStringChars, screenshot: false };
}

/** Total graph guard that makes compact JSON cardinality amplification finite. */
function hasBoundedCollectionGraph(root: unknown): boolean {
  const stack: GraphEntry[] = [{
    value: root,
    depth: 0,
    maxStringChars: REPORT_RESOURCE_LIMITS.maxAnyStringChars,
    screenshot: false
  }];
  const seen = new WeakSet<object>();
  let totalArrayEntries = 0;
  let totalObjectProperties = 0;
  let totalStringChars = 0;
  let totalNonScreenshotStringChars = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > REPORT_RESOURCE_LIMITS.maxNestingDepth) return false;
    if (typeof current.value === "string") {
      if (current.value.length > current.maxStringChars) return false;
      totalStringChars += current.value.length;
      if (!current.screenshot) totalNonScreenshotStringChars += current.value.length;
      if (
        totalStringChars > REPORT_RESOURCE_LIMITS.maxTotalStringChars ||
        totalNonScreenshotStringChars > REPORT_RESOURCE_LIMITS.maxTotalNonScreenshotStringChars
      ) {
        return false;
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    try {
      if (Array.isArray(current.value)) {
        if (Object.getPrototypeOf(current.value) !== Array.prototype) return false;
        if (current.value.length > REPORT_RESOURCE_LIMITS.maxAnyArray) return false;
        totalArrayEntries += current.value.length;
        if (totalArrayEntries > REPORT_RESOURCE_LIMITS.maxTotalArrayEntries) return false;
        for (let index = 0; index < current.value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
          stack.push({
            value: descriptor.value,
            depth: current.depth + 1,
            maxStringChars: current.maxStringChars,
            screenshot: current.screenshot
          });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      let objectProperties = 0;
      // Parsed JSON is a plain own-data-property graph. Avoid Object.values(),
      // which allocates a second attacker-sized values array before a cap can
      // be enforced; stop the own-property walk at the first excess key.
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        objectProperties += 1;
        totalObjectProperties += 1;
        if (
          objectProperties > REPORT_RESOURCE_LIMITS.maxObjectProperties ||
          totalObjectProperties > REPORT_RESOURCE_LIMITS.maxTotalObjectProperties ||
          key.length > REPORT_RESOURCE_LIMITS.maxObjectKeyChars
        ) {
          return false;
        }
        totalStringChars += key.length;
        totalNonScreenshotStringChars += key.length;
        if (
          totalStringChars > REPORT_RESOURCE_LIMITS.maxTotalStringChars ||
          totalNonScreenshotStringChars > REPORT_RESOURCE_LIMITS.maxTotalNonScreenshotStringChars
        ) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
        const policy = childStringPolicy(key, descriptor.value);
        stack.push({ value: descriptor.value, depth: current.depth + 1, ...policy });
      }
    } catch {
      // JSON.parse cannot create accessors or proxies. Refuse exotic in-memory
      // objects without allowing their traps to escape into the UI lifecycle.
      return false;
    }
  }
  return true;
}

function hasBoundedDetectionEvidence(detections: unknown): boolean {
  if (!Array.isArray(detections)) return true;
  return detections.every((detection) => {
    if (!isRecord(detection) || !isRecord(detection.evidence)) return true;
    return Object.values(detection.evidence).every(
      (value) => !Array.isArray(value) || value.length <= REPORT_RESOURCE_LIMITS.fingerprintEvidenceEntries
    );
  });
}

function hasBoundedPixelDetails(events: unknown): boolean {
  if (!Array.isArray(events)) return true;
  return events.every(
    (event) =>
      !isRecord(event) ||
      (arrayAtMost(event.events, REPORT_RESOURCE_LIMITS.pixelEventNames) &&
        arrayAtMost(event.advancedMatching, REPORT_RESOURCE_LIMITS.pixelMatchFields))
  );
}

function hasBoundedRun(run: unknown): boolean {
  if (!isRecord(run)) return true;
  const facts = isRecord(run.qualityFacts) ? run.qualityFacts : null;
  const quality = isRecord(run.quality) ? run.quality : null;
  const summary = isRecord(run.summary) ? run.summary : null;
  const evidence = isRecord(run.evidence) ? run.evidence : null;
  if (
    !arrayAtMost(run.phases, REPORT_RESOURCE_LIMITS.phases) ||
    !arrayAtMost(run.warnings, REPORT_RESOURCE_LIMITS.warnings) ||
    (facts !== null &&
      (!arrayAtMost(facts.budgetsExhausted, REPORT_RESOURCE_LIMITS.qualityEntries) ||
        !arrayAtMost(facts.captureLoss, REPORT_RESOURCE_LIMITS.qualityEntries))) ||
    (summary !== null && !arrayAtMost(summary.countsByPhase, REPORT_RESOURCE_LIMITS.phases))
  ) {
    return false;
  }

  if (quality !== null) {
    const runOutcome = isRecord(quality.run) ? quality.run : null;
    if (runOutcome !== null && !arrayAtMost(runOutcome.reasons, REPORT_RESOURCE_LIMITS.qualityEntries)) return false;
    if (isRecord(quality.byFamily)) {
      for (const outcome of Object.values(quality.byFamily)) {
        if (isRecord(outcome) && !arrayAtMost(outcome.reasons, REPORT_RESOURCE_LIMITS.qualityEntries)) return false;
      }
    }
  }

  if (evidence === null) return true;
  if (
    !arrayAtMost(evidence.requests, REPORT_RESOURCE_LIMITS.requests) ||
    !arrayAtMost(evidence.cookieMutations, REPORT_RESOURCE_LIMITS.cookieMutations) ||
    !arrayAtMost(evidence.cookiesFinal, REPORT_RESOURCE_LIMITS.cookies) ||
    !arrayAtMost(evidence.storageMutations, REPORT_RESOURCE_LIMITS.storageMutations) ||
    !arrayAtMost(evidence.storageFinal, REPORT_RESOURCE_LIMITS.storage) ||
    !arrayAtMost(evidence.fingerprintEvents, REPORT_RESOURCE_LIMITS.fingerprintEvents) ||
    !arrayAtMost(evidence.fingerprintDetections, REPORT_RESOURCE_LIMITS.fingerprintDetections) ||
    !arrayAtMost(evidence.cnameCloaks, REPORT_RESOURCE_LIMITS.cnameCloaks) ||
    !arrayAtMost(evidence.pixelEvents, REPORT_RESOURCE_LIMITS.pixelEvents) ||
    !hasBoundedDetectionEvidence(evidence.fingerprintDetections) ||
    !hasBoundedPixelDetails(evidence.pixelEvents)
  ) {
    return false;
  }

  if (isRecord(evidence.privacyPolicy)) {
    if (
      !arrayAtMost(evidence.privacyPolicy.claims, REPORT_RESOURCE_LIMITS.policyClaims) ||
      !arrayAtMost(evidence.privacyPolicy.mentionedEntities, REPORT_RESOURCE_LIMITS.policyEntities) ||
      !arrayAtMost(evidence.privacyPolicy.unmentionedEntities, REPORT_RESOURCE_LIMITS.policyEntities)
    ) {
      return false;
    }
  }
  if (isRecord(evidence.consent)) {
    if (!arrayAtMost(evidence.consent.verificationObservations, REPORT_RESOURCE_LIMITS.consentObservations)) {
      return false;
    }
    if (
      isRecord(evidence.consent.bannerTransition) &&
      !arrayAtMost(evidence.consent.bannerTransition.observations, REPORT_RESOURCE_LIMITS.bannerObservations)
    ) {
      return false;
    }
  }
  return true;
}

function hasBoundedComparison(report: Record<string, unknown>): boolean {
  if (isRecord(report.comparability)) {
    if (isRecord(report.comparability.pairValidity) &&
      !arrayAtMost(report.comparability.pairValidity.reasons, REPORT_RESOURCE_LIMITS.comparisonReasons)) {
      return false;
    }
    if (isRecord(report.comparability.perMetric)) {
      for (const eligibility of Object.values(report.comparability.perMetric)) {
        if (isRecord(eligibility) && !arrayAtMost(eligibility.reasons, REPORT_RESOURCE_LIMITS.comparisonReasons)) {
          return false;
        }
      }
    }
  }

  if (isRecord(report.diff) && isRecord(report.diff.families)) {
    const tracker = report.diff.families["tracker-classification"];
    if (
      isRecord(tracker) &&
      (!arrayAtMost(tracker.addedTrackerDomains, REPORT_RESOURCE_LIMITS.diffTrackerDomains) ||
        !arrayAtMost(tracker.removedTrackerDomains, REPORT_RESOURCE_LIMITS.diffTrackerDomains))
    ) {
      return false;
    }
    const detectors = report.diff.families["detector-findings"];
    if (
      isRecord(detectors) &&
      (!arrayAtMost(detectors.addedDetectionKinds, REPORT_RESOURCE_LIMITS.diffDetectionKinds) ||
        !arrayAtMost(detectors.removedDetectionKinds, REPORT_RESOURCE_LIMITS.diffDetectionKinds))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Version-aware shared preflight. Structural validators remain authoritative
 * for shape; this rejects cardinality amplification before they walk it.
 */
export function hasSafeReportCollections(payload: unknown): boolean {
  if (!hasBoundedCollectionGraph(payload)) return false;
  const report = reportPayload(payload);
  if (!isRecord(report) || report.schemaVersion !== 2) return true;

  const runs: unknown[] = [];
  if (report.reportType === "single") runs.push(report.run);
  if (report.reportType === "comparison") runs.push(report.baseline, report.variant);

  if (report.reportType === "comparison" && isRecord(report.experiment)) {
    const pairs = report.experiment.supportingPairs;
    if (!arrayAtMost(pairs, REPORT_RESOURCE_LIMITS.supportingPairs)) return false;
    if (Array.isArray(pairs)) {
      for (const pair of pairs) {
        if (isRecord(pair)) runs.push(pair.baseline, pair.variant);
      }
    }
    if (!hasBoundedComparison(report)) return false;
  }
  return runs.every(hasBoundedRun);
}
