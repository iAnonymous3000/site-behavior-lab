import type { ComparisonScanResult, ScanResult } from "./types";

/**
 * The single comparison-eligibility gate.
 *
 * Every consumer that turns a paired comparison into a claim (the headline
 * layer, the findings board, the directory metrics, the temporal compare
 * tools) must ask this module first, so a failed, blocked, request-capped, or
 * mismatched run can never produce definitive comparison wording in one place
 * while another still shows it.
 *
 * Intentionally dependency-free (types only) so it runs in the React client,
 * in server-side `generateMetadata`, and in the `next/og` route.
 */

export type ComparisonEligibility = {
  eligible: boolean;
  /** Human-readable reasons, empty when eligible. Each is a full sentence. */
  reasons: string[];
};

/**
 * Mirror of lib/scan-runtime MAX_RECORDED_REQUESTS (that module pulls in the
 * public-suffix list, which must stay out of the client bundle). A test pins
 * the two constants together.
 */
export const COMPARISON_REQUEST_CAP = 1_000;

/** Stable fragment of the ScanRequestBudget cap warning (see lib/scan-runtime.ts). */
const REQUEST_CAP_WARNING_FRAGMENT = "stopped recording or loading additional requests";

export function comparisonEligibility(report: ComparisonScanResult): ComparisonEligibility {
  const reasons: string[] = [];
  const arms: { label: string; run: ScanResult }[] = [
    { label: report.runLabels?.baseline ?? "baseline", run: report.baseline },
    { label: report.runLabels?.variant ?? "variant", run: report.variant }
  ];

  for (const { label, run } of arms) {
    const status = run.summary.status;
    if (typeof status === "number" && status >= 400) {
      reasons.push(`The "${label}" visit returned HTTP ${status}, an error or block page, not the real site.`);
    }
    // The unknown rule (RFC 3.2) applies to load state too: a visit with no
    // recorded HTTP status cannot be proven to have loaded the real site.
    if (status === null || status === undefined) {
      reasons.push(`The "${label}" visit recorded no HTTP status, so a successful load cannot be proven.`);
    }
    if (runHitRequestCap(run)) {
      reasons.push(
        `The "${label}" visit hit the ${COMPARISON_REQUEST_CAP.toLocaleString("en-US")}-request recording cap, so its counts are truncated.`
      );
    }
  }

  if (!comparableSubjectHosts(report.baseline.summary.firstPartyDomain, report.variant.summary.firstPartyDomain)) {
    reasons.push(
      `The two visits landed on different sites (${report.baseline.summary.firstPartyDomain} vs ${report.variant.summary.firstPartyDomain}), so their difference is not a comparison of one site.`
    );
  }
  if (report.baseline.conditions.viewport.isMobile !== report.variant.conditions.viewport.isMobile) {
    reasons.push("The two visits used different devices (desktop vs mobile), so their difference is not attributable to the compared condition.");
  }
  if (report.baseline.conditions.automation !== report.variant.conditions.automation) {
    reasons.push(
      `The two visits came from different scanner pipelines (${report.baseline.conditions.automation} vs ${report.variant.conditions.automation}), which measure differently.`
    );
  }

  // The RFC compatibility rules (3.1/3.2): a pair is comparable only when the
  // recorded environment matches on every dimension that shapes what a page
  // serves, and an UNRECORDED dimension never matches. v1 recorded the exact
  // subject route, viewport dimensions, browser version, timezone, locale,
  // egress label, and headless state, so the gate compares all of them; a
  // valid upload pairing two visits from different environments must not
  // earn comparative wording just because both loaded.
  if (normalizedRoute(report.baseline.conditions.requestedUrl) !== normalizedRoute(report.variant.conditions.requestedUrl)) {
    reasons.push(
      `The two visits requested different pages (${report.baseline.conditions.requestedUrl} vs ${report.variant.conditions.requestedUrl}), so their difference is not a comparison of one page.`
    );
  }
  if (
    report.baseline.conditions.viewport.width !== report.variant.conditions.viewport.width ||
    report.baseline.conditions.viewport.height !== report.variant.conditions.viewport.height
  ) {
    reasons.push("The two visits used different viewport sizes, which changes what a responsive page loads.");
  }
  reasons.push(...environmentMismatch("browser version", report.baseline.conditions.chromiumVersion, report.variant.conditions.chromiumVersion));
  reasons.push(...environmentMismatch("user agent", report.baseline.conditions.userAgent, report.variant.conditions.userAgent));
  reasons.push(...environmentMismatch("timezone", report.baseline.conditions.timezone, report.variant.conditions.timezone));
  reasons.push(...environmentMismatch("locale", report.baseline.conditions.locale, report.variant.conditions.locale));
  reasons.push(...environmentMismatch("language", report.baseline.conditions.language, report.variant.conditions.language));
  reasons.push(...environmentMismatch("network egress", report.baseline.conditions.scannerEgress, report.variant.conditions.scannerEgress));
  if (report.baseline.conditions.headless !== report.variant.conditions.headless) {
    reasons.push("One visit ran headless and the other did not, which sites can detect and react to differently.");
  }
  // Same OBSERVED subject, not just the same requested one: two visits that
  // landed on different final pages (a consent wall, a regional redirect)
  // measured different documents. Consent pairs are exempt from the final-URL
  // rule below the origin level: the dispatched click itself can navigate.
  if (
    report.comparisonType !== "consent" &&
    normalizedRoute(report.baseline.conditions.finalUrl) !== normalizedRoute(report.variant.conditions.finalUrl)
  ) {
    reasons.push(
      `The two visits ended on different pages (${report.baseline.conditions.finalUrl} vs ${report.variant.conditions.finalUrl}), so their difference is not a comparison of one page.`
    );
  }

  // The DECLARED experiment must actually have happened (RFC 4.4
  // design-invalid): a "gpc" pair whose arms both ran without the signal, or
  // a "shields" pair whose blocking arm never blocked, supports no
  // comparative claim about that axis no matter how well the environments
  // match.
  if (report.comparisonType === "gpc") {
    if (report.baseline.conditions.gpcEnabled !== false || report.variant.conditions.gpcEnabled !== true) {
      reasons.push(
        "A GPC comparison requires the signal off in the baseline visit and on in the variant visit; these visits did not vary the signal that way."
      );
    }
  }
  if (report.comparisonType === "shields") {
    if (report.variant.conditions.shieldsMode !== "block-simulation" || report.variant.conditions.adblock?.active !== true) {
      reasons.push("A blocking comparison requires the variant visit to have run the blocking engine; it did not.");
    } else if (report.baseline.conditions.shieldsMode === "block-simulation") {
      reasons.push("A blocking comparison requires an unblocked baseline visit; both visits ran the blocking engine.");
    }
  }
  if (report.comparisonType === "consent") {
    if (report.baseline.conditions.consentMode !== "accept-all" || report.variant.conditions.consentMode !== "reject-all") {
      reasons.push(
        "A consent comparison requires an accept-all baseline visit and a reject-all variant visit; these visits did not attempt that pairing."
      );
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

/** Trailing-slash-insensitive route equality; everything else must match exactly. */
function normalizedRoute(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Equality for a recorded environment dimension, with the RFC unknown rule:
 * a visit that never recorded the dimension, or recorded the literal
 * "unknown", can never be proven to match anything.
 */
function environmentMismatch(label: string, left: string | undefined, right: string | undefined): string[] {
  const a = (left ?? "").trim();
  const b = (right ?? "").trim();
  if (a === "" || b === "" || a.toLowerCase() === "unknown" || b.toLowerCase() === "unknown") {
    return [`A visit did not record its ${label}, so the two environments cannot be proven to match.`];
  }
  if (a !== b) {
    return [`The two visits ran with different ${label}s (${a} vs ${b}), so their difference can come from the environment, not the site.`];
  }
  return [];
}

/** A run whose recording was cut off by the request cap has truncated counts. */
export function runHitRequestCap(run: ScanResult): boolean {
  if (run.summary.totalRequests >= COMPARISON_REQUEST_CAP) return true;
  return run.warnings.some((warning) => warning.includes(REQUEST_CAP_WARNING_FRAGMENT));
}

/**
 * Whether two first-party hostnames plausibly name the same site: equal after
 * normalization, or one is a subdomain of the other. This is deliberately a
 * hostname rule, not a public-suffix rule, so it stays client-safe; it is
 * strict for genuinely unrelated hosts and tolerant of www/mobile subdomain
 * redirects within one site.
 */
export function comparableSubjectHosts(left: string, right: string): boolean {
  const a = normalizeSubjectHost(left);
  const b = normalizeSubjectHost(right);
  if (a === "" || b === "") return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function normalizeSubjectHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}
