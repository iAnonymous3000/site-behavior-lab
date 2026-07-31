import { consentPlatformForDomain } from "./consent-banner";
import { isSafeInlineScreenshotDataUri } from "./inline-screenshot";
import {
  PAGE_SUBJECT_CAPTURE_LOSS_DETAIL,
  PAGE_SUBJECT_UNVERIFIED_WARNING
} from "./bot-wall-classifier";
import { isReviewedSameOrganizationDomain, reviewedOrganizationForDomain } from "./reviewed-ownership";
import {
  hasUnknownServiceRole,
  isOperationalOnlyEntity as hasOperationalOnlyServiceRoles,
  isTrackingRelatedEntity as hasTrackingRelatedServiceRole
} from "./service-role";
import { humanList, plural } from "./text-format";
import type {
  DomainSummary,
  FingerprintDetectionSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  PixelMatchField,
  ScanResult,
  TrackerMatch
} from "./types";

/**
 * Shared tracker/fingerprint classification derived from a {@link ScanResult}.
 *
 * This is the single source of truth for "which third parties are tracking
 * companies", "which are merely operational", and "which fingerprinting
 * heuristics are high-entropy". It is consumed by both the report UI
 * (`app/site-behavior-app.tsx`) and the plain-language headline layer
 * (`lib/report-headline.ts`), which previously kept hand-synced copies.
 *
 * It is intentionally dependency-light (types plus the pure `text-format`
 * helpers) so it can run in the React client, in server-side
 * `generateMetadata`, and inside the `next/og` image route without pulling in
 * browser- or Node-only code.
 */

/** Recognizable platforms that make the strongest plain-language headline. */
export const HEADLINE_PLATFORMS = ["Google", "Meta", "TikTok", "X", "Microsoft", "LinkedIn", "Pinterest"];

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

/**
 * Group exact retained third-party catalog matches by entity, busiest first.
 *
 * A {@link DomainSummary} can preserve only one tracker match for a host. A
 * shared host can therefore carry Sentry on one request row and Meta on
 * another while its summary exposes only Sentry. Identity and category claims
 * must use the request rows or they silently omit the later match and assign
 * every request on the host to whichever match the summary retained.
 */
export function trackerEntitySummaries(result: Pick<ScanResult, "requests">): TrackerEntitySummary[] {
  return summarizeTrackerRequests(result.requests);
}

export type TrackerOwnershipBreakdown = {
  /**
   * Catalogued domains that a reviewed map places in the subject site's own
   * organization. They remain cross-registrable-domain observations in the
   * scan counts; this partition only prevents report prose from describing
   * them as disclosure to an outside company.
   */
  sameOrganization: TrackerEntitySummary[];
  /** All other catalogued domains. Their ownership is not necessarily reviewed. */
  otherOrUnreviewed: TrackerEntitySummary[];
  sameOrganizationName: string | null;
  sameOrganizationDomainCount: number;
};

export function trackerOwnershipBreakdown(
  result: Pick<ScanResult, "requests">,
  subjectDomain: string
): TrackerOwnershipBreakdown {
  const sameOrganizationRequests: NetworkRequestRecord[] = [];
  const otherOrUnreviewedRequests: NetworkRequestRecord[] = [];

  for (const request of result.requests) {
    if (!request.thirdParty || !request.tracker) continue;
    if (isReviewedSameOrganizationDomain(subjectDomain, request.domain)) {
      sameOrganizationRequests.push(request);
    } else {
      otherOrUnreviewedRequests.push(request);
    }
  }

  return {
    sameOrganization: summarizeTrackerRequests(sameOrganizationRequests),
    otherOrUnreviewed: summarizeTrackerRequests(otherOrUnreviewedRequests),
    sameOrganizationName: reviewedOrganizationForDomain(subjectDomain),
    sameOrganizationDomainCount: new Set(
      sameOrganizationRequests.map((request) => request.domain)
    ).size
  };
}

function summarizeTrackerRequests(
  requests: readonly NetworkRequestRecord[]
): TrackerEntitySummary[] {
  const summaries = new Map<
    string,
    { summary: TrackerEntitySummary; domains: Set<string> }
  >();

  for (const request of requests) {
    if (!request.thirdParty || !request.tracker) continue;
    const current = summaries.get(request.tracker.entity) ?? {
      summary: {
        entity: request.tracker.entity,
        requests: 0,
        domains: 0,
        categories: []
      },
      domains: new Set<string>()
    };
    current.summary.requests += 1;
    current.domains.add(request.domain);
    current.summary.domains = current.domains.size;
    if (!current.summary.categories.includes(request.tracker.category)) {
      current.summary.categories.push(request.tracker.category);
    }
    summaries.set(request.tracker.entity, current);
  }

  return Array.from(summaries.values())
    .map(({ summary }) => summary)
    .sort(
      (a, b) =>
        b.requests - a.requests || a.entity.localeCompare(b.entity)
    );
}

/**
 * Catalogued entities for which at least one HTTP response was observed.
 * Receipt attribution stays on the exact retained request row: a lossy host
 * summary can retain one entity while its response status came from another
 * entity's request on the same host. Receipt-oriented report wording must
 * consult this set before saying an entity "saw", "received", or "loaded" the
 * visit.
 */
export function respondedTrackerEntityNames(result: Pick<ScanResult, "requests">): Set<string> {
  const names = new Set<string>();
  for (const request of result.requests) {
    if (request.thirdParty && request.tracker && request.status !== null) {
      names.add(request.tracker.entity);
    }
  }
  return names;
}

/** Response-safe predicate phrase shared by consent headlines and finding cards. */
export function trackerResponseQualification(
  entities: ReadonlyArray<{ entity: string }>,
  responded: ReadonlySet<string>
): string {
  const answered = entities.filter((entity) => responded.has(entity.entity)).length;
  if (answered === entities.length) return "answered requests";
  if (answered > 0) return `were sent requests (${answered.toLocaleString("en-US")} answered; the rest recorded no response)`;
  return "were sent requests that recorded no response, so receipt is unproven";
}

/** An entity whose catalog roles are explicitly tracking-related. */
export function isTrackingEntity(entity: TrackerEntitySummary): boolean {
  return hasTrackingRelatedServiceRole(entity.categories);
}

/** True only when the catalog match recorded on this request row carries a reviewed tracking role. */
export function isTrackingTrackerMatch(match: Pick<TrackerMatch, "category">): boolean {
  return hasTrackingRelatedServiceRole([match.category]);
}

/** An entity whose catalog roles are all explicitly operational/non-tracking. */
export function isOperationalEntity(entity: TrackerEntitySummary): boolean {
  return hasOperationalOnlyServiceRoles(entity.categories);
}

/** An identified catalog entity whose functional role remains unclassified. */
export function isUnclassifiedEntity(entity: TrackerEntitySummary): boolean {
  return (
    hasUnknownServiceRole(entity.categories) &&
    !hasTrackingRelatedServiceRole(entity.categories) &&
    !hasOperationalOnlyServiceRoles(entity.categories)
  );
}

/**
 * Retained third-party request rows whose recorded catalog-suffix match
 * carries a tracking role. Classification stays at match scope: an entity's
 * tracking category must never cause its operational, security, or CDN
 * matches to inherit that role.
 * `summary.knownTrackerRequests` counts every catalog match, so aggregate
 * surfaces that say "tracker" must use this instead.
 */
export function trackingServiceRequests(result: Pick<ScanResult, "requests">): number {
  return result.requests.reduce(
    (total, request) =>
      total +
      (request.thirdParty && request.tracker && isTrackingTrackerMatch(request.tracker)
        ? 1
        : 0),
    0
  );
}

export type CatalogCoverage = {
  /** Distinct third-party HOSTS the visit contacted, not registrable domains. */
  thirdPartyDomains: number;
  /** Those a catalog entry, filter list, or consent-platform signature named. */
  identified: number;
  /** Those nothing named. */
  unidentified: number;
};

/**
 * Partition the visit's third-party domains by whether the instrument could
 * name them.
 *
 * `unidentified` is a property of the catalog's coverage, never a finding
 * about the site: an unmatched domain is one this scan could not identify, not
 * one shown to be harmless. Reports quantify it so a reader can see how much
 * of a visit the catalog actually accounts for, instead of reading an absence
 * of matches as an absence of third parties.
 *
 * Identification spans BOTH namers the report has: the service catalog (which
 * drives tracker counts) and the consent-platform signatures (which do not,
 * because a CMP loader is not a tracking service). Counting only the catalog
 * let a report name OneTrust on its consent card while telling the reader, on
 * the very same page, that it could not say who operated that domain.
 */
export function catalogCoverage(result: Pick<ScanResult, "domains">): CatalogCoverage {
  let thirdPartyDomains = 0;
  let identified = 0;
  for (const domain of result.domains) {
    if (!domain.thirdParty) continue;
    thirdPartyDomains += 1;
    if (domain.tracker !== null || consentPlatformForDomain(domain.domain) !== null) identified += 1;
  }
  return { thirdPartyDomains, identified, unidentified: thirdPartyDomains - identified };
}

/** High-entropy fingerprinting detections (canvas/WebGL/audio/WebRTC), excluding listener-coverage signals. */
export function highEntropyDetections(result: Pick<ScanResult, "fingerprintDetections">): FingerprintDetectionSummary[] {
  return (result.fingerprintDetections ?? []).filter((detection) => HIGH_ENTROPY_FINGERPRINT_KINDS.has(detection.kind));
}

/**
 * The HTTP status when the page's top-level navigation returned an error (>= 400),
 * otherwise null. A network-level failure (DNS, refused, timeout) already aborts
 * the scan with an error, but an HTTP error or bot-block page (403/404/500/503)
 * resolves normally, so the scan completes with few or no third-party requests.
 * Those low counts are an artifact of the failed load, not a privacy result, so
 * the headline and findings must not read them as "relatively private".
 *
 * `null` status (e.g. PageGraph/external imports that never carry one) is treated
 * as "unknown", not a failure, to avoid mislabeling reports that legitimately
 * lack a status.
 *
 * Takes the run's top-level status value (v1 `summary.status`, view `status`).
 */
export function scanLoadFailureStatus(status: number | null | undefined): number | null {
  return typeof status === "number" && status >= 400 ? status : null;
}

/**
 * Both wire generations' normalized run-quality marker for an interstitial
 * that answered like a page. R2 retains its frozen `bot-wall-title` reason;
 * v1 derives the more descriptive reason from the scanner-owned warning.
 */
export function scanSuspectedChallengeOrSoftBlock(run: { quality: { reasons: readonly string[] } }): boolean {
  return (
    run.quality.reasons.includes("bot-wall-title") ||
    run.quality.reasons.includes("suspected-challenge-or-soft-block")
  );
}

/** The scanner could not establish that the rendered document was the subject. */
export function scanPageSubjectUnverified(run: {
  warnings: readonly string[];
  quality: { reasons: readonly string[] };
}): boolean {
  return (
    run.warnings.includes(PAGE_SUBJECT_UNVERIFIED_WARNING) ||
    run.quality.reasons.includes("page-subject-unverified") ||
    run.quality.reasons.includes(`capture-loss:${PAGE_SUBJECT_CAPTURE_LOSS_DETAIL}`)
  );
}

/** All fingerprint/behavioral detections on a scan (safe on legacy reports without the field). */
export function fingerprintDetections(result: Pick<ScanResult, "fingerprintDetections">): FingerprintDetectionSummary[] {
  return result.fingerprintDetections ?? [];
}

/**
 * Filters listener-coverage origins down to the ones that are genuinely
 * cross-site, using the report's own request log as the oracle: an origin
 * whose host appears in the domain table as first-party (the table is built
 * with real public-suffix logic at scan time) is a same-site sibling that the
 * in-page probe's hostname heuristic misclassified. Origins absent from the
 * request log are kept, since the report holds no evidence either way.
 */
export function crossSiteListenerOrigins(result: Pick<ScanResult, "domains">, origins: string[]): string[] {
  const firstPartyHosts = new Set(
    result.domains.filter((domain) => !domain.thirdParty).map((domain) => normalizeOriginHost(domain.domain))
  );
  return origins.filter((origin) => !firstPartyHosts.has(normalizeOriginHost(origin)));
}

export type CrossSiteListenerDetection = {
  detection: Extract<FingerprintDetectionSummary, { kind: "session-recording" | "input-monitoring" }>;
  /**
   * True when same-site origins were removed from the attributed set. The
   * in-page probe reports ONE listener-call total across every origin it
   * attributed and no per-origin breakdown, so the retained count cannot be
   * recomputed for the narrowed set: it still covers the dropped origins.
   * A reader that prints the count beside the narrowed origin names without
   * this flag attributes calls to third parties that did not make them.
   */
  originsNarrowed: boolean;
};

/**
 * A session-recording / input-monitoring detection restricted to cross-site
 * origins, or undefined when every attributed origin turned out to be
 * same-site (the detection then supports no third-party claim).
 */
export function crossSiteListenerDetection(
  result: Pick<ScanResult, "domains" | "fingerprintDetections">,
  kind: "session-recording" | "input-monitoring"
): CrossSiteListenerDetection | undefined {
  const detection = fingerprintDetection(result, kind);
  if (!detection) return undefined;
  const origins = crossSiteListenerOrigins(result, detection.evidence.thirdPartyOrigins);
  if (origins.length === 0) return undefined;
  if (origins.length === detection.evidence.thirdPartyOrigins.length) {
    return { detection, originsNarrowed: false };
  }
  return {
    detection: { ...detection, evidence: { ...detection.evidence, thirdPartyOrigins: origins } },
    originsNarrowed: true
  };
}

function normalizeOriginHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

export type ShieldsRunMeasurement = {
  /**
   * What `summary.shieldsBlockedRequests` measured on this run:
   * "filter-matches" = requests that MATCHED Brave's filter lists while
   * loading normally (classification; nothing was blocked); "engine-blocked" =
   * requests the engine actually aborted in this visit (block simulation).
   * The two are different measurements and must never share a label.
   */
  kind: "filter-matches" | "engine-blocked";
  count: number;
  /**
   * Whether the scanner recorded engine verification facts for this run, or
   * the measurement was derived from a v1 wire that carries none. Readers must
   * not describe a derived count as verified: on a legacy report the
   * verification facts are precisely what is missing.
   */
  origin: "recorded" | "legacy-derived";
};

/**
 * The Shields engine measurement a run carries, or null when the engine was
 * off. Takes the view's run shape; a v1 wire caller adapts via
 * `{ counts: { shieldsBlockedRequests: summary.shieldsBlockedRequests ?? null },
 *    conditions: { adblockActive: conditions.adblock?.active ?? null, shieldsMode: conditions.shieldsMode ?? null } }`.
 */
export function shieldsRunMeasurement(run: {
  counts: { shieldsBlockedRequests: number | null };
  conditions: { adblockActive: boolean | null; shieldsMode: string | null };
  verificationFacts?: {
    shields: {
      engineLoaded: boolean;
      applied: boolean;
      requestsEvaluated: number;
      requestsMatched: number;
      requestsActuallyBlocked: number;
    } | null;
  } | null;
}): ShieldsRunMeasurement | null {
  const facts = run.verificationFacts?.shields;
  if (facts) {
    if (!facts.engineLoaded || facts.requestsEvaluated === 0) return null;
    return facts.applied
      ? { kind: "engine-blocked", count: facts.requestsActuallyBlocked, origin: "recorded" }
      : { kind: "filter-matches", count: facts.requestsMatched, origin: "recorded" };
  }
  const count = run.counts.shieldsBlockedRequests;
  if (typeof count !== "number" || run.conditions.adblockActive !== true) return null;
  return {
    kind: run.conditions.shieldsMode === "block-simulation" ? "engine-blocked" : "filter-matches",
    count,
    origin: "legacy-derived"
  };
}

export type GpcRunMeasurement = {
  configured: boolean;
  observed: boolean | null;
  outcome: "verified" | "contradicted" | "unverified" | "configured-only";
};

/** Keep configured GPC state distinct from the r2 header/JS readback. */
export function gpcRunMeasurement(run: {
  conditions: { gpcEnabled: boolean };
  verificationFacts?: {
    gpc: {
      header: "confirmed-present" | "confirmed-absent" | "unobservable";
      jsSignal: "confirmed-true" | "confirmed-false" | "confirmed-absent" | "read-failed" | "unobservable";
    } | null;
  } | null;
}): GpcRunMeasurement {
  const configured = run.conditions.gpcEnabled;
  const facts = run.verificationFacts?.gpc;
  if (!facts) return { configured, observed: null, outcome: "configured-only" };

  const observed =
    facts.header === "confirmed-present" && facts.jsSignal === "confirmed-true"
      ? true
      : facts.header === "confirmed-absent" &&
          (facts.jsSignal === "confirmed-absent" || facts.jsSignal === "confirmed-false")
        ? false
        : null;
  return {
    configured,
    observed,
    outcome: observed === null ? "unverified" : observed === configured ? "verified" : "contradicted"
  };
}

/** The single detection of a given kind, narrowed to its evidence shape, if present. */
export function fingerprintDetection<K extends FingerprintDetectionSummary["kind"]>(
  result: Pick<ScanResult, "fingerprintDetections">,
  kind: K
): Extract<FingerprintDetectionSummary, { kind: K }> | undefined {
  return fingerprintDetections(result).find((detection) => detection.kind === kind) as
    | Extract<FingerprintDetectionSummary, { kind: K }>
    | undefined;
}

/** Short human label for a behavioral fingerprinting detection. */
export function detectionLabel(detection: FingerprintDetectionSummary): string {
  if (detection.kind === "canvas-fingerprinting") return "Canvas fingerprinting heuristic";
  if (detection.kind === "canvas-font-fingerprinting") return "Canvas font probing heuristic";
  if (detection.kind === "webgl-fingerprinting") return "WebGL entropy-read heuristic";
  if (detection.kind === "audio-fingerprinting") return "Offline audio rendering heuristic";
  if (detection.kind === "webrtc-fingerprinting") return "WebRTC peer-connection probing";
  if (detection.kind === "session-recording") return "Session-recording listener coverage";
  if (detection.kind === "input-monitoring") return "Input-monitoring listener coverage";
  return "Keystroke / input exfiltration";
}

/** One-line evidence summary for a behavioral fingerprinting detection. */
export function detectionEvidence(detection: FingerprintDetectionSummary): string {
  if (detection.kind === "canvas-fingerprinting") {
    return `${plural(detection.count, "canvas", "canvases")} matched; reads: ${humanList(detection.evidence.readApis)}`;
  }

  if (detection.kind === "canvas-font-fingerprinting") {
    return `${plural(detection.evidence.measureTextCalls, "measureText call")} across up to ${plural(
      detection.evidence.maxDistinctFonts,
      "font"
    )}; measured text contents are not stored`;
  }

  if (detection.kind === "webgl-fingerprinting") {
    const parameters = detection.evidence.parameters.length > 0 ? `; parameters: ${humanList(detection.evidence.parameters)}` : "";
    return `${plural(detection.evidence.getParameterCalls, "parameter read")} and ${plural(
      detection.evidence.readPixelsCalls,
      "pixel readback"
    )}${parameters}`;
  }

  if (detection.kind === "audio-fingerprinting") {
    return `${plural(detection.evidence.offlineRenderCalls, "offline render")} with ${humanList(detection.evidence.apis)}`;
  }

  if (detection.kind === "webrtc-fingerprinting") {
    return `${plural(detection.evidence.constructorCalls, "peer connection")} with ${plural(
      detection.evidence.createDataChannelCalls,
      "data channel"
    )}, ${plural(detection.evidence.createOfferCalls, "offer")}, and ${plural(
      detection.evidence.setLocalDescriptionCalls,
      "local description"
    )}`;
  }

  if (detection.kind === "keystroke-exfiltration") {
    return `typed value was sent to ${humanList(detection.evidence.recipients)} as ${humanList(
      detection.evidence.encodings
    )}, from ${plural(detection.evidence.fieldsTyped, "field")}`;
  }

  return `${plural(detection.evidence.totalListenerCalls, "third-party listener")} from ${humanList(
    detection.evidence.thirdPartyOrigins
  )} across ${humanList(detection.evidence.eventTypes)} on ${humanList(detection.evidence.listenerTargets)}`;
}

/**
 * The only screenshot format the scanner produces (and the only one the UI may
 * render): an inline base64 image data URI. An UPLOADED report could carry an
 * arbitrary URL in this field, and rendering it would make every viewer's
 * browser issue a request to a host of the uploader's choosing.
 */
export function displayableScreenshot(value: string | null | undefined): string | null {
  return isSafeInlineScreenshotDataUri(value) ? value : null;
}

const HASHED_KEYSTROKE_ENCODINGS = new Set(["md5", "sha1", "sha256"]);

/**
 * Whether a keystroke-exfiltration leak appeared as a one-way HASH
 * (md5/sha1/sha256) rather than only plain text or a reversible transport
 * encoding (base64/hex/base64url). A hash cannot drive a functional type-ahead
 * (the recipient cannot recover the typed value), so it is the distinctive
 * signal of deliberate identity capture and earns the loud alarm. Plain text
 * and reversible encodings stay a calmer severity: they are consistent with a
 * third-party search/autocomplete, even though the keystrokes still leave the
 * site. Reversible base64/hex are common in legitimate APIs, so treating them
 * as covert capture would over-claim. Drives the finding level and headline tone.
 */
export function keystrokeLeakHashed(encodings: string[]): boolean {
  return encodings.some((encoding) => HASHED_KEYSTROKE_ENCODINGS.has(encoding));
}

const PIXEL_FIELD_LABELS: Record<PixelMatchField, string> = {
  email: "email",
  phone: "phone",
  name: "name",
  address: "postal address",
  date_of_birth: "date of birth",
  gender: "gender",
  external_id: "external ID"
};

/** Human label for an advanced-matching identifier category. */
export function pixelFieldLabel(field: PixelMatchField): string {
  return PIXEL_FIELD_LABELS[field] ?? field;
}

/** Pixel-level events observed (safe on legacy reports without the field). */
export function pixelEventSummaries(result: Pick<ScanResult, "pixelEvents">): PixelEventSummary[] {
  return result.pixelEvents ?? [];
}

/** One-line evidence summary for a platform's decoded pixel activity. */
export function pixelEventEvidence(pixel: PixelEventSummary): string {
  const events = pixel.events.length > 0 ? humanList(pixel.events, 5) : "no named event";
  const identifiers =
    pixel.advancedMatching.length > 0 ? `; identifiers ${humanList(pixel.advancedMatching.map(pixelFieldLabel))}` : "";
  return `${pixel.product}: ${events}${identifiers} (${plural(pixel.requests, "request")})`;
}
