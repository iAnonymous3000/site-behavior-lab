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

/**
 * The first admission limit a payload breaks, and where. Operators read it in
 * logs: a refusal that names neither left a stopped collection run with no
 * cause to act on. The path is built from the report's own keys, truncated,
 * and never carries a string value.
 */
export type ReportResourceViolation = {
  limit: string;
  path: string;
};

const MAX_VIOLATION_PATH_KEY_CHARS = 64;
const MAX_VIOLATION_PATH_CHARS = 512;

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
  /**
   * The producer caps this field in code points (redact-scan-report-v1
   * capCharacters), so the cap is read in code points too. Read in UTF-16
   * units, a quote at the producer's cap that holds supplementary-plane
   * characters (CJK Extension B, emoji) overran it, and persistence refused
   * the whole finished scan.
   */
  codePoints: boolean;
  screenshot: boolean;
  parent: GraphEntry | null;
  key: string | number | null;
};

const SCREENSHOT_KEYS = new Set(["screenshot", "baselineScreenshot", "variantScreenshot"]);
const HOSTNAME_KEYS = /(?:^|_)(?:domain|host|hostname|cname)$/i;
const LABEL_KEYS = /(?:title|label|entity|category|name|key|method|product)$/i;

function childStringPolicy(
  key: string,
  value: unknown
): Pick<GraphEntry, "maxStringChars" | "codePoints" | "screenshot"> {
  if (SCREENSHOT_KEYS.has(key) && typeof value === "string") {
    return isSafeInlineScreenshotDataUri(value)
      ? { maxStringChars: REPORT_RESOURCE_LIMITS.maxScreenshotChars, codePoints: false, screenshot: true }
      : { maxStringChars: -1, codePoints: false, screenshot: false };
  }
  if (key === "warnings") {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.warningChars, codePoints: true, screenshot: false };
  }
  if (key === "quote") {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.policyQuoteChars, codePoints: true, screenshot: false };
  }
  if (HOSTNAME_KEYS.test(key)) {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.hostnameChars, codePoints: false, screenshot: false };
  }
  if (LABEL_KEYS.test(key)) {
    return { maxStringChars: REPORT_RESOURCE_LIMITS.labelChars, codePoints: false, screenshot: false };
  }
  return { maxStringChars: REPORT_RESOURCE_LIMITS.maxAnyStringChars, codePoints: false, screenshot: false };
}

/** Whether a string fits a cap read in code points. Never walks past twice the cap. */
function codePointsAtMost(value: string, maximum: number): boolean {
  // A code point is at most two UTF-16 units, so anything longer than twice
  // the cap is over it without counting.
  if (value.length > maximum * 2) return false;
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function graphPath(entry: GraphEntry): string {
  const parts: string[] = [];
  for (let current: GraphEntry | null = entry; current !== null && current.key !== null; current = current.parent) {
    parts.push(
      typeof current.key === "number"
        ? `[${current.key}]`
        : `.${current.key.length > MAX_VIOLATION_PATH_KEY_CHARS ? `${current.key.slice(0, MAX_VIOLATION_PATH_KEY_CHARS)}...` : current.key}`
    );
  }
  const path = `$${parts.reverse().join("")}`;
  return path.length > MAX_VIOLATION_PATH_CHARS ? `${path.slice(0, MAX_VIOLATION_PATH_CHARS)}...` : path;
}

function violation(limit: string, entry: GraphEntry): ReportResourceViolation {
  return { limit, path: graphPath(entry) };
}

/** Total graph guard that makes compact JSON cardinality amplification finite. */
function collectionGraphViolation(root: unknown): ReportResourceViolation | null {
  const stack: GraphEntry[] = [{
    value: root,
    depth: 0,
    maxStringChars: REPORT_RESOURCE_LIMITS.maxAnyStringChars,
    codePoints: false,
    screenshot: false,
    parent: null,
    key: null
  }];
  const seen = new WeakSet<object>();
  let totalArrayEntries = 0;
  let totalObjectProperties = 0;
  let totalStringChars = 0;
  let totalNonScreenshotStringChars = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > REPORT_RESOURCE_LIMITS.maxNestingDepth) return violation("maxNestingDepth", current);
    if (typeof current.value === "string") {
      if (
        current.value.length > current.maxStringChars &&
        !(current.codePoints && codePointsAtMost(current.value, current.maxStringChars))
      ) {
        return violation(
          current.maxStringChars < 0 ? "inline-screenshot" : `string-chars:${current.maxStringChars}`,
          current
        );
      }
      totalStringChars += current.value.length;
      if (!current.screenshot) totalNonScreenshotStringChars += current.value.length;
      if (totalStringChars > REPORT_RESOURCE_LIMITS.maxTotalStringChars) {
        return violation("maxTotalStringChars", current);
      }
      if (totalNonScreenshotStringChars > REPORT_RESOURCE_LIMITS.maxTotalNonScreenshotStringChars) {
        return violation("maxTotalNonScreenshotStringChars", current);
      }
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    try {
      if (Array.isArray(current.value)) {
        if (Object.getPrototypeOf(current.value) !== Array.prototype) return violation("plain-array", current);
        if (current.value.length > REPORT_RESOURCE_LIMITS.maxAnyArray) return violation("maxAnyArray", current);
        totalArrayEntries += current.value.length;
        if (totalArrayEntries > REPORT_RESOURCE_LIMITS.maxTotalArrayEntries) {
          return violation("maxTotalArrayEntries", current);
        }
        for (let index = 0; index < current.value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            return violation("own-data-property", current);
          }
          stack.push({
            value: descriptor.value,
            depth: current.depth + 1,
            maxStringChars: current.maxStringChars,
            codePoints: current.codePoints,
            screenshot: current.screenshot,
            parent: current,
            key: index
          });
        }
        continue;
      }

      const prototype = Object.getPrototypeOf(current.value);
      if (prototype !== Object.prototype && prototype !== null) return violation("plain-object", current);
      let objectProperties = 0;
      // Parsed JSON is a plain own-data-property graph. Avoid Object.values(),
      // which allocates a second attacker-sized values array before a cap can
      // be enforced; stop the own-property walk at the first excess key.
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        objectProperties += 1;
        totalObjectProperties += 1;
        if (objectProperties > REPORT_RESOURCE_LIMITS.maxObjectProperties) {
          return violation("maxObjectProperties", current);
        }
        if (totalObjectProperties > REPORT_RESOURCE_LIMITS.maxTotalObjectProperties) {
          return violation("maxTotalObjectProperties", current);
        }
        if (key.length > REPORT_RESOURCE_LIMITS.maxObjectKeyChars) return violation("maxObjectKeyChars", current);
        totalStringChars += key.length;
        totalNonScreenshotStringChars += key.length;
        if (totalStringChars > REPORT_RESOURCE_LIMITS.maxTotalStringChars) {
          return violation("maxTotalStringChars", current);
        }
        if (totalNonScreenshotStringChars > REPORT_RESOURCE_LIMITS.maxTotalNonScreenshotStringChars) {
          return violation("maxTotalNonScreenshotStringChars", current);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          return violation("own-data-property", current);
        }
        const policy = childStringPolicy(key, descriptor.value);
        stack.push({ value: descriptor.value, depth: current.depth + 1, ...policy, parent: current, key });
      }
    } catch {
      // JSON.parse cannot create accessors or proxies. Refuse exotic in-memory
      // objects without allowing their traps to escape into the UI lifecycle.
      return violation("exotic-object", current);
    }
  }
  return null;
}

type LimitName = keyof typeof REPORT_RESOURCE_LIMITS;
/** One family cap: the field's path below its run or report, its value, and the limit it answers to. */
type CapCheck = readonly [field: string, value: unknown, limit: LimitName];

/** Checks run in order and stop at the first field over its cap. */
function firstOverCap(prefix: string, checks: Iterable<CapCheck>): ReportResourceViolation | null {
  for (const [field, value, limit] of checks) {
    if (!arrayAtMost(value, REPORT_RESOURCE_LIMITS[limit])) return { limit, path: `${prefix}.${field}` };
  }
  return null;
}

function* runCaps(run: Record<string, unknown>): Generator<CapCheck> {
  const facts = isRecord(run.qualityFacts) ? run.qualityFacts : null;
  const quality = isRecord(run.quality) ? run.quality : null;
  const summary = isRecord(run.summary) ? run.summary : null;
  const evidence = isRecord(run.evidence) ? run.evidence : null;
  yield ["phases", run.phases, "phases"];
  yield ["warnings", run.warnings, "warnings"];
  if (facts !== null) {
    yield ["qualityFacts.budgetsExhausted", facts.budgetsExhausted, "qualityEntries"];
    yield ["qualityFacts.captureLoss", facts.captureLoss, "qualityEntries"];
  }
  if (summary !== null) yield ["summary.countsByPhase", summary.countsByPhase, "phases"];

  if (quality !== null) {
    if (isRecord(quality.run)) yield ["quality.run.reasons", quality.run.reasons, "qualityEntries"];
    if (isRecord(quality.byFamily)) {
      for (const [family, outcome] of Object.entries(quality.byFamily)) {
        if (isRecord(outcome)) yield [`quality.byFamily.${family}.reasons`, outcome.reasons, "qualityEntries"];
      }
    }
  }

  if (evidence === null) return;
  yield ["evidence.requests", evidence.requests, "requests"];
  yield ["evidence.cookieMutations", evidence.cookieMutations, "cookieMutations"];
  yield ["evidence.cookiesFinal", evidence.cookiesFinal, "cookies"];
  yield ["evidence.storageMutations", evidence.storageMutations, "storageMutations"];
  yield ["evidence.storageFinal", evidence.storageFinal, "storage"];
  yield ["evidence.fingerprintEvents", evidence.fingerprintEvents, "fingerprintEvents"];
  yield ["evidence.fingerprintDetections", evidence.fingerprintDetections, "fingerprintDetections"];
  yield ["evidence.cnameCloaks", evidence.cnameCloaks, "cnameCloaks"];
  yield ["evidence.pixelEvents", evidence.pixelEvents, "pixelEvents"];
  if (Array.isArray(evidence.fingerprintDetections)) {
    for (const [index, detection] of evidence.fingerprintDetections.entries()) {
      if (!isRecord(detection) || !isRecord(detection.evidence)) continue;
      for (const [name, value] of Object.entries(detection.evidence)) {
        yield [`evidence.fingerprintDetections[${index}].evidence.${name}`, value, "fingerprintEvidenceEntries"];
      }
    }
  }
  if (Array.isArray(evidence.pixelEvents)) {
    for (const [index, event] of evidence.pixelEvents.entries()) {
      if (!isRecord(event)) continue;
      yield [`evidence.pixelEvents[${index}].events`, event.events, "pixelEventNames"];
      yield [`evidence.pixelEvents[${index}].advancedMatching`, event.advancedMatching, "pixelMatchFields"];
    }
  }

  if (isRecord(evidence.privacyPolicy)) {
    yield ["evidence.privacyPolicy.claims", evidence.privacyPolicy.claims, "policyClaims"];
    yield ["evidence.privacyPolicy.mentionedEntities", evidence.privacyPolicy.mentionedEntities, "policyEntities"];
    yield ["evidence.privacyPolicy.unmentionedEntities", evidence.privacyPolicy.unmentionedEntities, "policyEntities"];
  }
  if (isRecord(evidence.consent)) {
    yield ["evidence.consent.verificationObservations", evidence.consent.verificationObservations, "consentObservations"];
    if (isRecord(evidence.consent.bannerTransition)) {
      yield ["evidence.consent.bannerTransition.observations", evidence.consent.bannerTransition.observations, "bannerObservations"];
    }
  }
}

function* comparisonCaps(report: Record<string, unknown>): Generator<CapCheck> {
  if (isRecord(report.comparability)) {
    if (isRecord(report.comparability.pairValidity)) {
      yield ["comparability.pairValidity.reasons", report.comparability.pairValidity.reasons, "comparisonReasons"];
    }
    if (isRecord(report.comparability.perMetric)) {
      for (const [metric, eligibility] of Object.entries(report.comparability.perMetric)) {
        if (isRecord(eligibility)) yield [`comparability.perMetric.${metric}.reasons`, eligibility.reasons, "comparisonReasons"];
      }
    }
  }

  if (isRecord(report.diff) && isRecord(report.diff.families)) {
    const tracker = report.diff.families["tracker-classification"];
    if (isRecord(tracker)) {
      yield ["diff.families.tracker-classification.addedTrackerDomains", tracker.addedTrackerDomains, "diffTrackerDomains"];
      yield ["diff.families.tracker-classification.removedTrackerDomains", tracker.removedTrackerDomains, "diffTrackerDomains"];
    }
    const detectors = report.diff.families["detector-findings"];
    if (isRecord(detectors)) {
      yield ["diff.families.detector-findings.addedDetectionKinds", detectors.addedDetectionKinds, "diffDetectionKinds"];
      yield ["diff.families.detector-findings.removedDetectionKinds", detectors.removedDetectionKinds, "diffDetectionKinds"];
    }
  }
}

/**
 * Version-aware shared preflight. Structural validators remain authoritative
 * for shape; this rejects cardinality amplification before they walk it, and
 * names the first limit a refused payload breaks.
 */
export function reportResourceViolation(payload: unknown): ReportResourceViolation | null {
  const graph = collectionGraphViolation(payload);
  if (graph !== null) return graph;
  const report = reportPayload(payload);
  if (!isRecord(report) || report.schemaVersion !== 2) return null;
  const root = report === payload ? "$" : "$.report";

  const runs: Array<readonly [string, unknown]> = [];
  if (report.reportType === "single") runs.push([`${root}.run`, report.run]);
  if (report.reportType === "comparison") runs.push([`${root}.baseline`, report.baseline], [`${root}.variant`, report.variant]);

  if (report.reportType === "comparison" && isRecord(report.experiment)) {
    const pairs = report.experiment.supportingPairs;
    const pairCap = firstOverCap(`${root}.experiment`, [["supportingPairs", pairs, "supportingPairs"]]);
    if (pairCap !== null) return pairCap;
    if (Array.isArray(pairs)) {
      for (const [index, pair] of pairs.entries()) {
        if (!isRecord(pair)) continue;
        runs.push(
          [`${root}.experiment.supportingPairs[${index}].baseline`, pair.baseline],
          [`${root}.experiment.supportingPairs[${index}].variant`, pair.variant]
        );
      }
    }
    const comparison = firstOverCap(root, comparisonCaps(report));
    if (comparison !== null) return comparison;
  }
  for (const [path, run] of runs) {
    if (!isRecord(run)) continue;
    const capped = firstOverCap(path, runCaps(run));
    if (capped !== null) return capped;
  }
  return null;
}

export function hasSafeReportCollections(payload: unknown): boolean {
  return reportResourceViolation(payload) === null;
}
