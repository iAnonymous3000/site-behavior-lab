import type { ComparisonScanResult, ScanResult } from "./types";
import { legacyV1MethodologyIdentity } from "./legacy-methodology";

/**
 * The single comparison-eligibility gate.
 *
 * Every consumer that turns a paired comparison into a claim (the headline
 * layer, the findings board, the directory metrics, the temporal compare
 * tools) must ask this module first, so a failed, blocked, request-capped, or
 * mismatched run can never produce definitive comparison wording in one place
 * while another still shows it.
 *
 * Intentionally dependency-light (types plus the tiny v1 methodology-token
 * parser) so it runs in the React client, in server-side `generateMetadata`,
 * and in the `next/og` route.
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
const RESPONSE_BYTE_CAP_WARNING_FRAGMENT = "stopped loading additional response bytes";

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
    if (runHitResponseByteCap(run)) {
      reasons.push(`The "${label}" visit exhausted its aggregate response-byte budget, so its request evidence is incomplete.`);
    }
  }

  if (!comparableSubjectHosts(report.baseline.summary.firstPartyDomain, report.variant.summary.firstPartyDomain)) {
    reasons.push(
      `The two visits landed on different sites (${report.baseline.summary.firstPartyDomain} vs ${report.variant.summary.firstPartyDomain}), so their difference is not a comparison of one site.`
    );
  }
  // The unknown rule applies to the subject itself: a visit whose recorded
  // URLs are empty or the literal "unknown" cannot be proven to be OF any
  // page, so no pair containing it compares one page.
  for (const { label, run } of arms) {
    if (unknownSubjectUrl(run.conditions.requestedUrl) || unknownSubjectUrl(run.conditions.finalUrl)) {
      reasons.push(`The "${label}" visit did not record a real subject URL, so what it visited cannot be proven.`);
    }
  }
  if (report.baseline.conditions.viewport.isMobile !== report.variant.conditions.viewport.isMobile) {
    reasons.push("The two visits used different devices (desktop vs mobile), so their difference is not attributable to the compared condition.");
  }
  if (report.baseline.conditions.automation !== report.variant.conditions.automation) {
    reasons.push(
      `The two visits came from different scanner pipelines (${report.baseline.conditions.automation} vs ${report.variant.conditions.automation}), which measure differently.`
    );
  }
  const baselineMethodology = legacyV1MethodologyIdentity(report.baseline.conditions.scannerDisclosure);
  const variantMethodology = legacyV1MethodologyIdentity(report.variant.conditions.scannerDisclosure);
  if (baselineMethodology !== variantMethodology) {
    reasons.push(
      `The two visits used different scanner methodology generations (${baselineMethodology} vs ${variantMethodology}), so their difference can come from how requests were measured, not the site.`
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
  const baselineAdblock = report.baseline.conditions.adblock;
  const variantAdblock = report.variant.conditions.adblock;
  if ((baselineAdblock?.active === true) !== (variantAdblock?.active === true)) {
    reasons.push("Only one visit recorded an active Brave-list engine, so tracker and blocking measurements are not like for like.");
  } else if (baselineAdblock?.active === true && variantAdblock?.active === true) {
    reasons.push(...environmentMismatch("Brave filter-list source", baselineAdblock.source, variantAdblock.source));
    if (baselineAdblock.lists !== variantAdblock.lists) {
      reasons.push(
        `The two visits loaded different numbers of Brave filter lists (${baselineAdblock.lists} vs ${variantAdblock.lists}), so their classification instruments differ.`
      );
    }
    reasons.push(...environmentMismatch("Brave filter-list snapshot", baselineAdblock.fetchedAt, variantAdblock.fetchedAt));
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

  // Held-constant rule (RFC 4.4): every experiment dimension OTHER than the
  // declared axis must match across the arms, or the declared condition was
  // not the only thing that varied. A dimension missing from BOTH arms
  // compares as the same absence (v1 wrote these fields on every run once
  // the feature existed); a recorded mismatch always disqualifies.
  if (report.comparisonType !== "gpc" && report.baseline.conditions.gpcEnabled !== report.variant.conditions.gpcEnabled) {
    reasons.push(
      "The two visits ran with different Global Privacy Control states, but this comparison does not declare a GPC experiment, so the compared condition was not the only difference."
    );
  }
  if (report.comparisonType !== "consent" && report.baseline.conditions.consentMode !== report.variant.conditions.consentMode) {
    reasons.push(
      `The two visits used different consent-banner modes (${report.baseline.conditions.consentMode} vs ${report.variant.conditions.consentMode}), but this comparison does not declare a consent experiment, so the compared condition was not the only difference.`
    );
  }
  if (
    report.comparisonType !== "shields" &&
    ((report.baseline.conditions.adblock?.active === true) !== (report.variant.conditions.adblock?.active === true) ||
      (report.baseline.conditions.shieldsMode ?? null) !== (report.variant.conditions.shieldsMode ?? null))
  ) {
    reasons.push(
      "The two visits ran different blocking configurations, but this comparison does not declare a blocking experiment, so the compared condition was not the only difference."
    );
  }

  // A before/after pair must really record a before and an after: visits
  // that cannot be ordered in time (missing or reversed timestamps) support
  // no claim about what changed since the earlier visit.
  if (report.comparisonType === "temporal") {
    const beforeMs = Date.parse(report.baseline.conditions.scannedAt ?? "");
    const afterMs = Date.parse(report.variant.conditions.scannedAt ?? "");
    if (!Number.isFinite(beforeMs) || !Number.isFinite(afterMs)) {
      reasons.push("A before/after comparison requires both visits to record when they ran; a visit without a parseable timestamp cannot be ordered.");
    } else if (beforeMs >= afterMs) {
      reasons.push(
        `The "${arms[0].label}" visit is not older than the "${arms[1].label}" visit, so the pair does not record a change over time.`
      );
    }
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
    } else {
      // The declared experiment is the pair of CLICKS, not the pair of
      // intentions: a visit whose control was never found records the
      // pre-consent state, so the pair compares nothing about the two choices
      // no matter how well the environments match.
      reasons.push(...consentDispatchProblem(arms[0].label, "accept-all", report.baseline));
      reasons.push(...consentDispatchProblem(arms[1].label, "reject-all", report.variant));
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

/**
 * Structural eligibility for a descriptive before/after comparison.
 *
 * The strict gate above continues to require an identical Brave-list snapshot
 * for every comparison. A passive temporal visit is narrower: when BOTH arms
 * explicitly ran classification (never block simulation), and the active
 * engine, source, and list count are all known and equal, raw request and
 * tracker-catalog observations may be compared across snapshot dates. Only
 * the snapshot timestamp is omitted; every other strict reason survives.
 * Unknown provenance and every non-temporal pair stay on the strict gate.
 */
export function temporalPairEligibility(report: ComparisonScanResult): ComparisonEligibility {
  const strict = comparisonEligibility(report);
  if (!passiveTemporalSnapshotsMayDiffer(report)) return strict;

  const reasons = strict.reasons.filter(
    (reason) => !reason.startsWith("The two visits ran with different Brave filter-list snapshots (")
  );
  return { eligible: reasons.length === 0, reasons };
}

function passiveTemporalSnapshotsMayDiffer(report: ComparisonScanResult): boolean {
  if (report.comparisonType !== "temporal") return false;
  const baseline = report.baseline.conditions;
  const variant = report.variant.conditions;
  if (baseline.shieldsMode !== "classification" || variant.shieldsMode !== "classification") return false;

  const a = baseline.adblock;
  const b = variant.adblock;
  if (a?.active !== true || b?.active !== true) return false;
  const sourceA = knownEnvironmentValue(a.source);
  const sourceB = knownEnvironmentValue(b.source);
  const snapshotA = knownEnvironmentValue(a.fetchedAt);
  const snapshotB = knownEnvironmentValue(b.fetchedAt);
  if (!sourceA || !sourceB || sourceA !== sourceB || !snapshotA || !snapshotB) return false;
  if (!Number.isFinite(Date.parse(snapshotA)) || !Number.isFinite(Date.parse(snapshotB))) return false;
  return Number.isInteger(a.lists) && a.lists > 0 && a.lists === b.lists;
}

function knownEnvironmentValue(value: string | undefined): string | null {
  const normalized = (value ?? "").trim();
  return normalized !== "" && normalized.toLowerCase() !== "unknown" ? normalized : null;
}

/**
 * Whether one consent arm's declared banner click provably happened. A run
 * that never recorded a consent interaction cannot prove the click was
 * dispatched (the unknown rule), and a recorded `clicked: false` means the
 * control was never found, so the recording reflects the pre-consent state.
 */
function consentDispatchProblem(label: string, choice: "accept-all" | "reject-all", run: ScanResult): string[] {
  const interaction = run.consentInteraction;
  if (!interaction || interaction.mode !== choice) {
    return [
      `The "${label}" visit did not record whether the ${choice} click was dispatched, so the compared choice cannot be proven to have happened.`
    ];
  }
  if (interaction.clicked !== true) {
    return [
      `The "${label}" visit found no recognizable ${choice} control to click, so it records the pre-consent state, not that choice.`
    ];
  }
  return [];
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

export function runHitResponseByteCap(run: ScanResult): boolean {
  return run.warnings.some((warning) => warning.includes(RESPONSE_BYTE_CAP_WARNING_FRAGMENT));
}

export function runRequestEvidenceCapped(run: ScanResult): boolean {
  return runHitRequestCap(run) || runHitResponseByteCap(run);
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
  const normalized = host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  // The literal "unknown" is a recorded non-answer, not a hostname: per the
  // RFC unknown rule it can never be proven to match anything, including
  // itself.
  return normalized === "unknown" ? "" : normalized;
}

/** A recorded subject URL that is empty or the literal "unknown" proves nothing. */
function unknownSubjectUrl(url: string): boolean {
  const normalized = (url ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "unknown";
}
