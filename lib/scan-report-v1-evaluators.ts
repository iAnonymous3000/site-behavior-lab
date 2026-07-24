/**
 * Semantic consistency checks for the frozen v1 wire.
 *
 * The v1 shape remains frozen, but uploads still have to agree with their own
 * evidence. These checks deliberately derive the public summary, domain table,
 * and comparison diff from the retained rows instead of trusting producer-
 * supplied conclusions.
 *
 * Scope: SEMANTICS ONLY. Callers reach this after deepValidateScanReportV1
 * (lib/scan-report-v1-guard.ts) has already enforced every field's type and
 * numeric range, so re-checking those here could only ever restate a decision
 * the reader has made; it would also mislabel a parse problem ("invalid") as a
 * forged conclusion ("inconsistent").
 */
import { compareScanResults } from "./compare-reports";
import { COMPARISON_REQUEST_CAP } from "./comparison-eligibility";
import { partyKey, summarizeDomains } from "./domain-utils";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import type { ComparisonDiff, DomainSummary, ScanReport, ScanResult } from "./types";

/**
 * Redaction sentinels from lib/redaction-v2.ts (INVALID_URL_MARKER and
 * INVALID_HOST_MARKER). Spelled out locally so this read-path module does not
 * pull the sanitizer's allowlist tables in behind it; the drift is pinned in
 * lib/scan-report-v1-evaluators.test.ts.
 */
const INVALID_URL_MARKER = "{invalid-url}";
const INVALID_HOST_MARKER = "{invalid-host}";
const REDACTION_SENTINELS = new Set([INVALID_URL_MARKER, INVALID_HOST_MARKER]);

function canonicalSort<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

/**
 * Domain rows and their status/resource vocabularies are mathematical sets.
 * `blockedByShields` is OPTIONAL in the frozen v1 type and absent from
 * older-generation exports, while lib/domain-summaries.ts always materializes
 * it; canonicalJson is key-exact, so the flag is defaulted rather than
 * compared as present-vs-missing. A row that claims `true` against evidence
 * that says otherwise still fails.
 */
function normalizedDomains(domains: readonly DomainSummary[]): DomainSummary[] {
  return canonicalSort(
    domains.map((domain) => ({
      ...domain,
      blockedByShields: domain.blockedByShields ?? false,
      statuses: [...domain.statuses].sort((left, right) => left - right),
      resourceTypes: [...domain.resourceTypes].sort()
    }))
  );
}

/**
 * Every change list in the v1 diff is set-like. Preserve duplicates so they
 * still fail equality, but sort the members (and nested pixel vocabularies)
 * so harmless producer order cannot make an otherwise derived diff invalid.
 */
function normalizedDiff(diff: ComparisonDiff): ComparisonDiff {
  return {
    ...diff,
    addedDomains: canonicalSort(diff.addedDomains),
    removedDomains: canonicalSort(diff.removedDomains),
    addedEntities: canonicalSort(diff.addedEntities),
    removedEntities: canonicalSort(diff.removedEntities),
    addedCookies: canonicalSort(diff.addedCookies),
    removedCookies: canonicalSort(diff.removedCookies),
    addedStorageKeys: canonicalSort(diff.addedStorageKeys),
    removedStorageKeys: canonicalSort(diff.removedStorageKeys),
    addedFingerprinting: canonicalSort(diff.addedFingerprinting),
    removedFingerprinting: canonicalSort(diff.removedFingerprinting),
    ...(diff.addedPixelEvents === undefined
      ? {}
      : {
          addedPixelEvents: canonicalSort(
            diff.addedPixelEvents.map((pixel) => ({
              ...pixel,
              events: [...pixel.events].sort(),
              advancedMatching: [...pixel.advancedMatching].sort()
            }))
          )
        }),
    ...(diff.removedPixelEvents === undefined
      ? {}
      : {
          removedPixelEvents: canonicalSort(
            diff.removedPixelEvents.map((pixel) => ({
              ...pixel,
              events: [...pixel.events].sort(),
              advancedMatching: [...pixel.advancedMatching].sort()
            }))
          )
        }),
    addedProvenance: canonicalSort(diff.addedProvenance),
    removedProvenance: canonicalSort(diff.removedProvenance)
  };
}

function normalizedHostname(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  } catch {
    return null;
  }
}

function runViolations(run: ScanResult, label: string): string[] {
  const violations: string[] = [];
  const domains = summarizeDomains(run.requests);
  const derived = {
    totalRequests: run.requests.length,
    thirdPartyRequests: run.requests.filter((request) => request.thirdParty).length,
    knownTrackerRequests: run.requests.filter((request) => request.tracker !== null).length,
    thirdPartyDomains: domains.filter((domain) => domain.thirdParty).length,
    cookies: run.cookies.length,
    thirdPartyCookies: run.cookies.filter((cookie) => cookie.thirdParty).length,
    storageEntries: run.storage.length,
    fingerprintEvents: run.fingerprintEvents.reduce((total, event) => total + event.count, 0)
  };

  for (const [field, value] of Object.entries(derived) as Array<[keyof typeof derived, number]>) {
    if (run.summary[field] !== value) {
      violations.push(`${label}: summary.${field} does not reconcile with the evidence`);
    }
  }

  if (canonicalJson(normalizedDomains(run.domains)) !== canonicalJson(normalizedDomains(domains))) {
    violations.push(`${label}: domains do not reconcile with the request evidence`);
  }

  // The two sides are sanitized by different passes (lib/redact-scan-report-v1
  // uses pass.url for finalUrl and pass.hostname for firstPartyDomain), and
  // either can come back as a sentinel on an ordinary 200 scan: any host that
  // is itself a public suffix (httpbin.org, github.io, pages.dev) has no
  // registrable domain, and the raw-URL and raw-host caps fire independently.
  // A sentinel means the binding was redacted away, not that it disagrees, so
  // it is left unasserted instead of reported as a forged conclusion.
  const declaredHostname = run.summary.firstPartyDomain.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (!REDACTION_SENTINELS.has(run.conditions.finalUrl) && !REDACTION_SENTINELS.has(declaredHostname)) {
    const finalHostname = normalizedHostname(run.conditions.finalUrl);
    if (finalHostname === null || finalHostname !== declaredHostname) {
      violations.push(`${label}: summary.firstPartyDomain does not match conditions.finalUrl`);
    }
  }

  const blockedRows = run.requests.filter((request) => request.blockedByShields === true).length;
  const blockedSummary = run.summary.shieldsBlockedRequests;
  const adblockActive = run.conditions.adblock?.active === true;
  if (blockedSummary !== undefined && blockedSummary > COMPARISON_REQUEST_CAP) {
    violations.push(
      `${label}: summary.shieldsBlockedRequests exceeds the scanner's ${COMPARISON_REQUEST_CAP}-request routing cap`
    );
  }
  if ((blockedSummary !== undefined || blockedRows > 0) && !adblockActive) {
    violations.push(`${label}: Shields measurements are present without an active adblock engine`);
  }
  if (run.conditions.shieldsMode === "block-simulation") {
    // Directly blocked requests never enter a block-simulation request log;
    // only the producer-owned summary count survives.
    if (blockedRows > 0) {
      violations.push(`${label}: block-simulation requests cannot carry blockedByShields`);
    }
  } else if (blockedSummary !== undefined ? blockedSummary !== blockedRows : blockedRows > 0) {
    // Classification does not abort requests, so its count is exactly
    // reconstructible from the retained request flags.
    violations.push(`${label}: summary.shieldsBlockedRequests does not reconcile with the request evidence`);
  }

  return violations;
}

/** Empty means the structurally valid v1 report is internally consistent. */
export function scanReportV1SemanticViolations(report: ScanReport): string[] {
  if (report.reportType !== "comparison") return runViolations(report, "run");

  const violations = [
    ...runViolations(report.baseline, "baseline"),
    ...runViolations(report.variant, "variant")
  ];
  if (
    report.requestedUrl !== report.baseline.conditions.requestedUrl ||
    report.requestedUrl !== report.variant.conditions.requestedUrl
  ) {
    violations.push("comparison: root requestedUrl does not match both runs");
  }
  if (report.scannedAt !== report.variant.conditions.scannedAt) {
    violations.push("comparison: root scannedAt does not match the variant run");
  }
  const baselineDevice = report.baseline.conditions.viewport.isMobile ? "mobile" : "desktop";
  const variantDevice = report.variant.conditions.viewport.isMobile ? "mobile" : "desktop";
  if (report.device !== baselineDevice || report.device !== variantDevice) {
    violations.push("comparison: root device does not match both runs");
  }
  // Redirect targets may legitimately differ by route or host (apex → www,
  // locale subdomains, and similar), but the two arms must still finish on the
  // same registrable site. Otherwise a self-consistent second site's evidence
  // can be smuggled into a comparison labeled with the root subject.
  if (partyKey(report.baseline.summary.firstPartyDomain) !== partyKey(report.variant.summary.firstPartyDomain)) {
    violations.push("comparison: runs do not share the same final site");
  }
  const derivedDiff = compareScanResults(report.baseline, report.variant);
  if (canonicalJson(normalizedDiff(report.diff)) !== canonicalJson(normalizedDiff(derivedDiff))) {
    violations.push("comparison: diff does not reconcile with the two runs");
  }
  return violations;
}
