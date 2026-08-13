import {
  addRedactionCounters,
  emptyRedactionCounters,
  redactCookieName,
  redactStorageKey,
  redactUrlV2,
  tokenShapeMarker,
  type RedactionCounters
} from "./redaction-v2";
import type { ScanReport, ScanResult } from "./types";

/**
 * The DRY-RUN remediation inventory (RFC scan-report-v2 9.6: audit first).
 * Given already-published v1 reports, this computes the URL and name/key
 * changes made by the default-deny sanitizer, without writing anything:
 * per-report redaction counters, URL-field changes, class-marker histograms,
 * and the risk signals the 9.6 step-2 human decision needs. It is deliberately
 * not an exact preview of the full v1 public-report transform, which also
 * normalizes closed producer vocabularies such as resourceType.
 *
 * Pure analysis over parsed reports; the CLI owns file/store IO. Nothing here
 * mutates a report.
 */

export type UrlFieldChange = {
  field: string;
  before: string;
  after: string;
};

export type ReportRemediationInventory = {
  id: string;
  reportType: "single" | "comparison";
  /** What the sanitizer would remove, in PrivacyStats.redaction vocabulary. */
  counters: RedactionCounters;
  totalUrlFields: number;
  changedUrlFields: number;
  cookieNames: { total: number; wouldRedact: number };
  storageKeys: { total: number; wouldRedact: number };
  /**
   * Identifier-shaped material already public in this report's stored
   * strings: the audit basis for the RFC 9.6 step-2 history decision.
   * Email-like matches are the strongest signal; token-shaped path segments
   * are stable-identifier candidates. The subdomain count is broader: v3
   * generalizes every label absent from the reviewed literal allowlist.
   */
  riskSignals: {
    emailLikeStrings: number;
    tokenLikePathSegments: number;
    unallowlistedSubdomainLabels: number;
    /**
     * Identifier-shaped material inside a quoted privacy-policy sentence.
     *
     * Counted separately because the surface is different: every other signal
     * here comes from a URL or a name that the sanitizer already rewrites,
     * while a policy quote is admitted page-derived text that passes through
     * with only whitespace normalization and a length cap. That made the
     * corpus-clean statement vacuous for the one field structurally able to
     * carry an address, so the sweep now reaches it. Counting it is not a
     * redaction decision: scrubbing quotes would narrow the admitted public
     * string set, which is a remediation-class move, not a ledger entry.
     */
    policyQuoteIdentifiers: number;
  };
  /** Up to `maxExamples` before/after URL diffs, for operator review only. */
  examples: UrlFieldChange[];
};

// Image-density suffixes (logo@2x.png, icon%403x.webp, Close%20@16.svg) are
// the dominant "@" pattern in real request logs and are not addresses; the
// lookahead excludes an all-digit (optionally x/dpi-suffixed) domain start so
// the risk count reflects address-shaped strings only.
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+(?:@|%40)(?![0-9]{1,3}(?:x|dpi)?\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Deliberately loose, and only ever used to COUNT a review signal in prose: a
// policy sentence quoting a contact number is the shape at issue, and a false
// positive costs an operator one read while a false negative hides the field
// the sweep exists to cover. Requires a separator so ordinary figures in a
// policy ("30 days", "2026") do not register.
const PHONE_LIKE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{2,4}[\s.-]\d{2,4}/;
const TOKEN_MARKERS = new Set(["[redacted:uuid-like]", "[redacted:hex-like]", "[redacted:long-token]"]);

export function inventoryV1Report(id: string, report: ScanReport, maxExamples = 5): ReportRemediationInventory {
  const counters = emptyRedactionCounters();
  const inventory: ReportRemediationInventory = {
    id,
    reportType: report.reportType === "comparison" ? "comparison" : "single",
    counters,
    totalUrlFields: 0,
    changedUrlFields: 0,
    cookieNames: { total: 0, wouldRedact: 0 },
    storageKeys: { total: 0, wouldRedact: 0 },
    riskSignals: {
      emailLikeStrings: 0,
      tokenLikePathSegments: 0,
      unallowlistedSubdomainLabels: 0,
      policyQuoteIdentifiers: 0
    },
    examples: []
  };

  const runs: ScanResult[] = report.reportType === "comparison" ? [report.baseline, report.variant] : [report];
  for (const [index, run] of runs.entries()) {
    const label = report.reportType === "comparison" ? (index === 0 ? "baseline" : "variant") : "run";
    inventoryRun(run, label, inventory, maxExamples);
  }
  return inventory;
}

function inventoryRun(run: ScanResult, label: string, inventory: ReportRemediationInventory, maxExamples: number): void {
  const url = (field: string, value: string | undefined, preserveQueryKeys: boolean) => {
    if (!value) return;
    inventory.totalUrlFields += 1;
    const redacted = redactUrlV2(value, { preserveQueryKeys });
    addRedactionCounters(inventory.counters, redacted.counters);
    inventory.riskSignals.unallowlistedSubdomainLabels += redacted.counters.subdomainLabelsGeneralized;
    if (EMAIL_LIKE.test(value)) inventory.riskSignals.emailLikeStrings += 1;
    inventory.riskSignals.tokenLikePathSegments += tokenLikePathSegments(value);
    if (redacted.value !== value) {
      inventory.changedUrlFields += 1;
      if (inventory.examples.length < maxExamples) {
        inventory.examples.push({ field: `${label}.${field}`, before: value, after: redacted.value });
      }
    }
  };

  url("conditions.requestedUrl", run.conditions.requestedUrl, false);
  url("conditions.finalUrl", run.conditions.finalUrl, false);
  url("consentInteraction.frameUrl", run.consentInteraction?.frameUrl, false);
  url("privacyPolicy.url", run.privacyPolicy?.url, false);
  // The quote itself, not just its URL. Sanitization here is whitespace
  // normalization and a length cap, so an address published in the site's own
  // policy sentence reaches the stored report intact.
  for (const claim of run.privacyPolicy?.claims ?? []) {
    if (EMAIL_LIKE.test(claim.quote) || PHONE_LIKE.test(claim.quote)) {
      inventory.riskSignals.policyQuoteIdentifiers += 1;
    }
  }
  for (const request of run.requests) {
    url("requests[].url", request.url, request.thirdParty);
    url("requests[].provenance.initiatorUrl", request.provenance?.initiatorUrl, false);
    url("requests[].provenance.scriptUrl", request.provenance?.scriptUrl, false);
    url("requests[].provenance.injectedByUrl", request.provenance?.injectedByUrl, false);
  }

  // Names and keys: counted through the same counters the sanitizer reports.
  const nameCounters = emptyRedactionCounters();
  for (const cookie of run.cookies) {
    inventory.cookieNames.total += 1;
    if (!redactCookieName(cookie.name, nameCounters).preserved) inventory.cookieNames.wouldRedact += 1;
  }
  for (const entry of run.storage) {
    inventory.storageKeys.total += 1;
    if (!redactStorageKey(entry.key, nameCounters).preserved) inventory.storageKeys.wouldRedact += 1;
  }
  addRedactionCounters(inventory.counters, nameCounters);
}

/** Count identifier-shaped path segments in a stored URL (audit signal only). */
function tokenLikePathSegments(value: string): number {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 0;
  }
  return parsed.pathname
    .split("/")
    .filter(Boolean)
    .filter((segment) => TOKEN_MARKERS.has(tokenShapeMarker(segment))).length;
}

export type InventoryTotals = {
  reports: number;
  reportsWithUrlOrNameChanges: number;
  totalUrlFields: number;
  changedUrlFields: number;
  counters: RedactionCounters;
  cookieNames: { total: number; wouldRedact: number };
  storageKeys: { total: number; wouldRedact: number };
  riskSignals: ReportRemediationInventory["riskSignals"];
};

export function summarizeInventories(entries: ReportRemediationInventory[]): InventoryTotals {
  const totals: InventoryTotals = {
    reports: entries.length,
    reportsWithUrlOrNameChanges: 0,
    totalUrlFields: 0,
    changedUrlFields: 0,
    counters: emptyRedactionCounters(),
    cookieNames: { total: 0, wouldRedact: 0 },
    storageKeys: { total: 0, wouldRedact: 0 },
    riskSignals: {
      emailLikeStrings: 0,
      tokenLikePathSegments: 0,
      unallowlistedSubdomainLabels: 0,
      policyQuoteIdentifiers: 0
    }
  };
  for (const entry of entries) {
    if (entry.changedUrlFields > 0 || entry.cookieNames.wouldRedact > 0 || entry.storageKeys.wouldRedact > 0) {
      totals.reportsWithUrlOrNameChanges += 1;
    }
    totals.totalUrlFields += entry.totalUrlFields;
    totals.changedUrlFields += entry.changedUrlFields;
    addRedactionCounters(totals.counters, entry.counters);
    totals.cookieNames.total += entry.cookieNames.total;
    totals.cookieNames.wouldRedact += entry.cookieNames.wouldRedact;
    totals.storageKeys.total += entry.storageKeys.total;
    totals.storageKeys.wouldRedact += entry.storageKeys.wouldRedact;
    totals.riskSignals.emailLikeStrings += entry.riskSignals.emailLikeStrings;
    totals.riskSignals.tokenLikePathSegments += entry.riskSignals.tokenLikePathSegments;
    totals.riskSignals.unallowlistedSubdomainLabels += entry.riskSignals.unallowlistedSubdomainLabels;
    totals.riskSignals.policyQuoteIdentifiers += entry.riskSignals.policyQuoteIdentifiers;
  }
  return totals;
}
