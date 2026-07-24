/**
 * Deep structural guard for FROZEN v1 reports, applied by the version-aware
 * reader on top of the frozen lib/report-validation.ts checks. This is the
 * security backport the freeze allows (docs/scan-report-v2-rfc.md, 11.1).
 *
 * EXHAUSTIVE over the complete frozen shape: the deep v1 projector
 * (lib/scan-report-v1-projection.ts) dereferences every field of the type,
 * so this guard must guarantee every field it dereferences; anything less
 * turns a malformed upload into a projector throw or a persisted JSON with
 * missing required fields. Invalid input is rejected BEFORE projection;
 * projector failures are never caught to emit partial output.
 *
 * v1 was never key-strict, so unknown EXTRA fields stay tolerated here (the
 * projector drops them); only the presence and types of the frozen fields
 * are enforced.
 */
import { isRecord } from "./guards";
import { isFingerprintDetectionSummary } from "./fingerprint-detection-guard";
import type { ComparisonScanResult, ScanReport, ScanResult } from "./types";

const COMPARISON_TYPES = new Set(["gpc", "shields", "consent", "temporal", "custom"]);
const DEVICES = new Set(["desktop", "mobile"]);
const CONSENT_MODES = new Set(["observe", "accept-all", "reject-all"]);
const AUTOMATIONS = new Set(["playwright-chromium", "brave-pagegraph", "external"]);
const DETECTION_KINDS = new Set([
  "canvas-fingerprinting",
  "canvas-font-fingerprinting",
  "webgl-fingerprinting",
  "audio-fingerprinting",
  "webrtc-fingerprinting",
  "session-recording",
  "input-monitoring",
  "keystroke-exfiltration"
]);
const STORAGE_AREAS = new Set(["localStorage", "sessionStorage"]);
const TRACKER_CONFIDENCES = new Set(["curated", "shields-list"]);
const CONSENT_CLICK_MODES = new Set(["accept-all", "reject-all"]);
const SHIELDS_MODES = new Set(["classification", "block-simulation"]);
const PIXEL_MATCH_FIELDS = new Set(["email", "phone", "name", "address", "date_of_birth", "gender", "external_id"]);
const POLICY_CLAIM_KINDS = new Set(["no-cookies", "no-third-party-cookies", "no-selling-or-sharing", "honors-gpc"]);

/**
 * Browser-safe ceilings for the frozen v1 reader. They mirror the active r2
 * producer where the evidence families overlap; requests also match the
 * original v1 producer cap. Managed historical reports remain below these
 * limits, while an untrusted upload cannot turn an 8 MiB wire into unbounded
 * validation or DOM work.
 */
export const BROWSER_V1_EVIDENCE_LIMITS = Object.freeze({
  requests: 1_000,
  domains: 1_000,
  cookies: 1_000,
  storage: 1_000,
  fingerprintEvents: 1_000,
  fingerprintDetections: 256,
  fingerprintEvidenceEntries: 1_000,
  cnameCloaks: 256,
  pixelEvents: 512,
  warnings: 64,
  policyClaims: 32,
  policyEntities: 100,
  diffDomains: 1_000,
  diffEntities: 1_000,
  diffCookies: 1_000,
  diffStorage: 1_000,
  diffFingerprinting: 256,
  diffPixels: 512,
  diffProvenance: 1_000,
  pixelEventNames: 100,
  domainResourceTypes: 100,
  warningChars: 600,
  comparisonTitleChars: 160,
  runLabelChars: 80
});

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

// RFC 9110 status-code grammar is 3DIGIT, not 1xx-5xx: LinkedIn answers 999
// and several WAFs answer other 9xx codes. Recording one is honest evidence,
// so the range is the grammar's, and only shapes no server can send (negative,
// fractional, four-digit) fail here.
function isHttpStatus(value: unknown): value is number {
  return isSafeInteger(value) && value >= 100 && value <= 999;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isBoundedArray(
  value: unknown,
  maxEntries: number,
  guard: (entry: unknown) => boolean
): value is unknown[] {
  return Array.isArray(value) && value.length <= maxEntries && value.every(guard);
}

function isBoundedStringArray(value: unknown, maxEntries: number): value is string[] {
  return Array.isArray(value) && value.length <= maxEntries && value.every((entry) => typeof entry === "string");
}

function isBoundedText(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length <= maxChars;
}

function isBoundedTextArray(value: unknown, maxEntries: number, maxChars: number): value is string[] {
  return isBoundedStringArray(value, maxEntries) && value.every((entry) => entry.length <= maxChars);
}

function isHttpStatusArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isHttpStatus);
}

function isUniqueHttpStatusArray(value: unknown): value is number[] {
  return isHttpStatusArray(value) && new Set(value).size === value.length;
}

function isV1Tracker(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    typeof value.entity === "string" &&
    typeof value.category === "string" &&
    typeof value.confidence === "string" &&
    TRACKER_CONFIDENCES.has(value.confidence) &&
    (value.prevalence === undefined || isFiniteNumber(value.prevalence)) &&
    (value.fingerprinting === undefined || isFiniteNumber(value.fingerprinting)) &&
    (value.cookiePrevalence === undefined || isFiniteNumber(value.cookiePrevalence))
  );
}

function isV1Provenance(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const optionalStringKeys = [
    "graphRecordId",
    "initiatorId",
    "initiatorType",
    "initiatorUrl",
    "initiatorDomain",
    "scriptId",
    "scriptUrl",
    "scriptDomain",
    "injectedById",
    "injectedByUrl",
    "injectedByDomain"
  ];
  return optionalStringKeys.every((key) => isOptionalString(value[key]));
}

function isV1Request(value: unknown): boolean {
  return (
    isRecord(value) &&
    isPositiveSafeInteger(value.id) &&
    typeof value.url === "string" &&
    typeof value.domain === "string" &&
    typeof value.method === "string" &&
    typeof value.resourceType === "string" &&
    (value.status === null || isHttpStatus(value.status)) &&
    typeof value.thirdParty === "boolean" &&
    (value.tracker === null || isV1Tracker(value.tracker)) &&
    (value.blockedByShields === undefined || typeof value.blockedByShields === "boolean") &&
    (value.provenance === undefined || isV1Provenance(value.provenance)) &&
    isNonNegativeSafeInteger(value.startedAtMs)
  );
}

function isV1Domain(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    isNonNegativeSafeInteger(value.requests) &&
    typeof value.thirdParty === "boolean" &&
    (value.tracker === null || isV1Tracker(value.tracker)) &&
    (value.blockedByShields === undefined || typeof value.blockedByShields === "boolean") &&
    isUniqueHttpStatusArray(value.statuses) &&
    isBoundedStringArray(value.resourceTypes, BROWSER_V1_EVIDENCE_LIMITS.domainResourceTypes) &&
    new Set(value.resourceTypes).size === value.resourceTypes.length
  );
}

function isV1Cookie(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.domain === "string" &&
    typeof value.path === "string" &&
    typeof value.sameSite === "string" &&
    typeof value.secure === "boolean" &&
    typeof value.httpOnly === "boolean" &&
    typeof value.session === "boolean" &&
    typeof value.thirdParty === "boolean"
  );
}

function isV1Storage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.area === "string" &&
    STORAGE_AREAS.has(value.area) &&
    typeof value.key === "string" &&
    isNonNegativeSafeInteger(value.valueBytes)
  );
}

function isV1FingerprintEvent(value: unknown): boolean {
  return isRecord(value) && typeof value.api === "string" && isNonNegativeSafeInteger(value.count);
}

function isV1FingerprintDetection(value: unknown): boolean {
  if (!isFingerprintDetectionSummary(value) || !isRecord(value) || !isRecord(value.evidence)) return false;
  return (
    isPositiveSafeInteger(value.count) &&
    Object.values(value.evidence).every(
      (entry) =>
        (typeof entry !== "number" || isNonNegativeSafeInteger(entry)) &&
        (!Array.isArray(entry) || entry.length <= BROWSER_V1_EVIDENCE_LIMITS.fingerprintEvidenceEntries)
    )
  );
}

function isV1CnameCloak(value: unknown): boolean {
  return isRecord(value) && typeof value.host === "string" && typeof value.cname === "string" && isV1Tracker(value.tracker);
}

function isV1PixelEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.platform === "string" &&
    typeof value.product === "string" &&
    isBoundedStringArray(value.events, BROWSER_V1_EVIDENCE_LIMITS.pixelEventNames) &&
    new Set(value.events).size === value.events.length &&
    Array.isArray(value.advancedMatching) &&
    value.advancedMatching.every((field) => typeof field === "string" && PIXEL_MATCH_FIELDS.has(field)) &&
    new Set(value.advancedMatching).size === value.advancedMatching.length &&
    isNonNegativeSafeInteger(value.requests)
  );
}

function hasUniquePixelPlatforms(values: unknown[]): boolean {
  const platforms = values.map((entry) => (isRecord(entry) && typeof entry.platform === "string" ? entry.platform : null));
  return platforms.every((platform) => platform !== null) && new Set(platforms).size === platforms.length;
}

function isV1PrivacyPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    isBoundedArray(value.claims, BROWSER_V1_EVIDENCE_LIMITS.policyClaims, (claim) =>
      isRecord(claim) && typeof claim.kind === "string" && POLICY_CLAIM_KINDS.has(claim.kind) && typeof claim.quote === "string"
    ) &&
    isBoundedStringArray(value.mentionedEntities, BROWSER_V1_EVIDENCE_LIMITS.policyEntities) &&
    isBoundedStringArray(value.unmentionedEntities, BROWSER_V1_EVIDENCE_LIMITS.policyEntities) &&
    isNonNegativeSafeInteger(value.policyTextLength)
  );
}

function isV1ConsentInteraction(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.mode === "string" &&
    CONSENT_CLICK_MODES.has(value.mode) &&
    typeof value.clicked === "boolean" &&
    isOptionalString(value.cmp) &&
    isOptionalString(value.selector) &&
    isOptionalString(value.matchedText) &&
    isOptionalString(value.frameUrl)
  );
}

function isV1Share(value: unknown): boolean {
  return isRecord(value) && typeof value.id === "string" && typeof value.path === "string" && typeof value.jsonPath === "string";
}

function isV1Summary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const countFields = [
    "totalRequests",
    "thirdPartyRequests",
    "knownTrackerRequests",
    "thirdPartyDomains",
    "cookies",
    "thirdPartyCookies",
    "storageEntries",
    "fingerprintEvents"
  ];
  return (
    typeof value.pageTitle === "string" &&
    (value.status === null || isHttpStatus(value.status)) &&
    isNonNegativeSafeInteger(value.durationMs) &&
    typeof value.firstPartyDomain === "string" &&
    countFields.every((field) => isNonNegativeSafeInteger(value[field])) &&
    (value.shieldsBlockedRequests === undefined || isNonNegativeSafeInteger(value.shieldsBlockedRequests))
  );
}

function isV1Conditions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const stringFields = [
    "requestedUrl",
    "finalUrl",
    "scannedAt",
    "chromiumVersion",
    "userAgent",
    "timezone",
    "locale",
    "language",
    "scannerEgress",
    "scannerDisclosure"
  ];
  const viewport = value.viewport;
  const adblock = value.adblock;
  const catalog = value.trackerCatalog;
  return (
    stringFields.every((field) => typeof value[field] === "string") &&
    isRecord(viewport) &&
    isPositiveSafeInteger(viewport.width) &&
    isPositiveSafeInteger(viewport.height) &&
    typeof viewport.isMobile === "boolean" &&
    typeof value.gpcEnabled === "boolean" &&
    typeof value.headless === "boolean" &&
    // Methodology/provenance dimensions are frozen closed sets, not free text.
    typeof value.consentMode === "string" &&
    CONSENT_MODES.has(value.consentMode) &&
    typeof value.automation === "string" &&
    AUTOMATIONS.has(value.automation) &&
    (value.shieldsMode === undefined || (typeof value.shieldsMode === "string" && SHIELDS_MODES.has(value.shieldsMode))) &&
    (adblock === undefined ||
      (isRecord(adblock) &&
        typeof adblock.active === "boolean" &&
        typeof adblock.source === "string" &&
        isNonNegativeSafeInteger(adblock.lists) &&
        typeof adblock.fetchedAt === "string")) &&
    isRecord(catalog) &&
    typeof catalog.source === "string" &&
    typeof catalog.version === "string" &&
    typeof catalog.region === "string" &&
    isNonNegativeSafeInteger(catalog.entries) &&
    isNonNegativeSafeInteger(catalog.curatedOverrides) &&
    typeof catalog.license === "string"
  );
}

function deepValidateV1Result(result: ScanResult): boolean {
  const value = result as unknown as Record<string, unknown>;
  return (
    isV1Summary(value.summary) &&
    isV1Conditions(value.conditions) &&
    isBoundedArray(value.requests, BROWSER_V1_EVIDENCE_LIMITS.requests, isV1Request) &&
    isBoundedArray(value.domains, BROWSER_V1_EVIDENCE_LIMITS.domains, isV1Domain) &&
    isBoundedArray(value.cookies, BROWSER_V1_EVIDENCE_LIMITS.cookies, isV1Cookie) &&
    isBoundedArray(value.storage, BROWSER_V1_EVIDENCE_LIMITS.storage, isV1Storage) &&
    isBoundedArray(value.fingerprintEvents, BROWSER_V1_EVIDENCE_LIMITS.fingerprintEvents, isV1FingerprintEvent) &&
    (value.fingerprintDetections === undefined ||
      isBoundedArray(value.fingerprintDetections, BROWSER_V1_EVIDENCE_LIMITS.fingerprintDetections, isV1FingerprintDetection)) &&
    (value.cnameCloaks === undefined ||
      isBoundedArray(value.cnameCloaks, BROWSER_V1_EVIDENCE_LIMITS.cnameCloaks, isV1CnameCloak)) &&
    (value.pixelEvents === undefined ||
      (isBoundedArray(value.pixelEvents, BROWSER_V1_EVIDENCE_LIMITS.pixelEvents, isV1PixelEvent) &&
        hasUniquePixelPlatforms(value.pixelEvents))) &&
    (value.privacyPolicy === undefined || isV1PrivacyPolicy(value.privacyPolicy)) &&
    (value.consentInteraction === undefined || isV1ConsentInteraction(value.consentInteraction)) &&
    // `undefined` matches the frozen validator: the UI's JSON export drops the
    // screenshot key entirely, and those legacy files must keep re-opening.
    // The projector canonicalizes it to null on output.
    (value.screenshot === undefined || value.screenshot === null || typeof value.screenshot === "string") &&
    isBoundedTextArray(value.warnings, BROWSER_V1_EVIDENCE_LIMITS.warnings, BROWSER_V1_EVIDENCE_LIMITS.warningChars) &&
    (value.share === undefined || isV1Share(value.share))
  );
}

function isV1MetricDelta(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeSafeInteger(value.before) &&
    isNonNegativeSafeInteger(value.after) &&
    isSafeInteger(value.delta)
  );
}

function isV1DomainChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    isNonNegativeSafeInteger(value.requests) &&
    (value.tracker === null || isV1Tracker(value.tracker))
  );
}

function isV1EntityChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.entity === "string" &&
    isNonNegativeSafeInteger(value.requests) &&
    isNonNegativeSafeInteger(value.domains)
  );
}

function isV1CookieChange(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.name === "string" && typeof value.domain === "string" && typeof value.thirdParty === "boolean"
  );
}

function isV1StorageKeyChange(value: unknown): boolean {
  return isRecord(value) && typeof value.area === "string" && STORAGE_AREAS.has(value.area) && typeof value.key === "string";
}

function isV1FingerprintingChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    DETECTION_KINDS.has(value.kind) &&
    typeof value.heuristic === "string" &&
    isNonNegativeSafeInteger(value.count)
  );
}

function isV1PixelEventChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.platform === "string" &&
    typeof value.product === "string" &&
    isBoundedStringArray(value.events, BROWSER_V1_EVIDENCE_LIMITS.pixelEventNames) &&
    new Set(value.events).size === value.events.length &&
    Array.isArray(value.advancedMatching) &&
    value.advancedMatching.length <= PIXEL_MATCH_FIELDS.size &&
    value.advancedMatching.every((field) => typeof field === "string" && PIXEL_MATCH_FIELDS.has(field)) &&
    new Set(value.advancedMatching).size === value.advancedMatching.length
  );
}

function isV1ProvenanceChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    isNonNegativeSafeInteger(value.requests) &&
    (value.tracker === null || isV1Tracker(value.tracker)) &&
    (value.initiator === null || typeof value.initiator === "string") &&
    (value.script === null || typeof value.script === "string") &&
    (value.injectedBy === null || typeof value.injectedBy === "string")
  );
}

function isV1Diff(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const requiredDeltas = [
    "totalRequests",
    "thirdPartyRequests",
    "knownTrackerRequests",
    "thirdPartyDomains",
    "cookies",
    "thirdPartyCookies",
    "storageEntries",
    "fingerprintEvents"
  ];
  const changeArrays: Array<[string, number, (entry: unknown) => boolean]> = [
    ["addedDomains", BROWSER_V1_EVIDENCE_LIMITS.diffDomains, isV1DomainChange],
    ["removedDomains", BROWSER_V1_EVIDENCE_LIMITS.diffDomains, isV1DomainChange],
    ["addedEntities", BROWSER_V1_EVIDENCE_LIMITS.diffEntities, isV1EntityChange],
    ["removedEntities", BROWSER_V1_EVIDENCE_LIMITS.diffEntities, isV1EntityChange],
    ["addedCookies", BROWSER_V1_EVIDENCE_LIMITS.diffCookies, isV1CookieChange],
    ["removedCookies", BROWSER_V1_EVIDENCE_LIMITS.diffCookies, isV1CookieChange],
    ["addedStorageKeys", BROWSER_V1_EVIDENCE_LIMITS.diffStorage, isV1StorageKeyChange],
    ["removedStorageKeys", BROWSER_V1_EVIDENCE_LIMITS.diffStorage, isV1StorageKeyChange],
    ["addedFingerprinting", BROWSER_V1_EVIDENCE_LIMITS.diffFingerprinting, isV1FingerprintingChange],
    ["removedFingerprinting", BROWSER_V1_EVIDENCE_LIMITS.diffFingerprinting, isV1FingerprintingChange],
    ["addedProvenance", BROWSER_V1_EVIDENCE_LIMITS.diffProvenance, isV1ProvenanceChange],
    ["removedProvenance", BROWSER_V1_EVIDENCE_LIMITS.diffProvenance, isV1ProvenanceChange]
  ];
  return (
    requiredDeltas.every((field) => isV1MetricDelta(value[field])) &&
    (value.shieldsBlockedRequests === undefined || isV1MetricDelta(value.shieldsBlockedRequests)) &&
    changeArrays.every(([field, maxEntries, check]) =>
      Array.isArray(value[field]) &&
      (value[field] as unknown[]).length <= maxEntries &&
      (value[field] as unknown[]).every(check)
    ) &&
    (value.addedPixelEvents === undefined ||
      (Array.isArray(value.addedPixelEvents) &&
        value.addedPixelEvents.length <= BROWSER_V1_EVIDENCE_LIMITS.diffPixels &&
        value.addedPixelEvents.every(isV1PixelEventChange) &&
        hasUniquePixelPlatforms(value.addedPixelEvents))) &&
    (value.removedPixelEvents === undefined ||
      (Array.isArray(value.removedPixelEvents) &&
        value.removedPixelEvents.length <= BROWSER_V1_EVIDENCE_LIMITS.diffPixels &&
        value.removedPixelEvents.every(isV1PixelEventChange) &&
        hasUniquePixelPlatforms(value.removedPixelEvents)))
  );
}

function deepValidateV1Comparison(report: ComparisonScanResult): boolean {
  const value = report as unknown as Record<string, unknown>;
  return (
    typeof value.comparisonType === "string" &&
    COMPARISON_TYPES.has(value.comparisonType) &&
    isBoundedText(value.title, BROWSER_V1_EVIDENCE_LIMITS.comparisonTitleChars) &&
    (value.runLabels === undefined ||
      (isRecord(value.runLabels) &&
        isBoundedText(value.runLabels.baseline, BROWSER_V1_EVIDENCE_LIMITS.runLabelChars) &&
        isBoundedText(value.runLabels.variant, BROWSER_V1_EVIDENCE_LIMITS.runLabelChars))) &&
    typeof value.requestedUrl === "string" &&
    typeof value.scannedAt === "string" &&
    typeof value.device === "string" &&
    DEVICES.has(value.device) &&
    deepValidateV1Result(report.baseline) &&
    deepValidateV1Result(report.variant) &&
    isV1Diff(value.diff) &&
    isBoundedTextArray(value.warnings, BROWSER_V1_EVIDENCE_LIMITS.warnings, BROWSER_V1_EVIDENCE_LIMITS.warningChars) &&
    (value.share === undefined || isV1Share(value.share))
  );
}

export function deepValidateScanReportV1(report: ScanReport): boolean {
  if (report.reportType === "comparison") return deepValidateV1Comparison(report);
  return deepValidateV1Result(report);
}
