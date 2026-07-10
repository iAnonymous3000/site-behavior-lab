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
const STORAGE_AREAS = new Set(["localStorage", "sessionStorage"]);
const TRACKER_CONFIDENCES = new Set(["curated", "shields-list"]);
const CONSENT_CLICK_MODES = new Set(["accept-all", "reject-all"]);
const SHIELDS_MODES = new Set(["classification", "block-simulation"]);
const PIXEL_MATCH_FIELDS = new Set(["email", "phone", "name", "address", "date_of_birth", "gender", "external_id"]);
const POLICY_CLAIM_KINDS = new Set(["no-cookies", "no-third-party-cookies", "no-selling-or-sharing", "honors-gpc"]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
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
    isFiniteNumber(value.id) &&
    typeof value.url === "string" &&
    typeof value.domain === "string" &&
    typeof value.method === "string" &&
    typeof value.resourceType === "string" &&
    (value.status === null || isFiniteNumber(value.status)) &&
    typeof value.thirdParty === "boolean" &&
    (value.tracker === null || isV1Tracker(value.tracker)) &&
    (value.blockedByShields === undefined || typeof value.blockedByShields === "boolean") &&
    (value.provenance === undefined || isV1Provenance(value.provenance)) &&
    isFiniteNumber(value.startedAtMs)
  );
}

function isV1Domain(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    isFiniteNumber(value.requests) &&
    typeof value.thirdParty === "boolean" &&
    (value.tracker === null || isV1Tracker(value.tracker)) &&
    (value.blockedByShields === undefined || typeof value.blockedByShields === "boolean") &&
    isNumberArray(value.statuses) &&
    isStringArray(value.resourceTypes)
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
    isFiniteNumber(value.valueBytes)
  );
}

function isV1FingerprintEvent(value: unknown): boolean {
  return isRecord(value) && typeof value.api === "string" && isFiniteNumber(value.count);
}

function isV1CnameCloak(value: unknown): boolean {
  return isRecord(value) && typeof value.host === "string" && typeof value.cname === "string" && isV1Tracker(value.tracker);
}

function isV1PixelEvent(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.platform === "string" &&
    typeof value.product === "string" &&
    isStringArray(value.events) &&
    Array.isArray(value.advancedMatching) &&
    value.advancedMatching.every((field) => typeof field === "string" && PIXEL_MATCH_FIELDS.has(field)) &&
    isFiniteNumber(value.requests)
  );
}

function isV1PrivacyPolicy(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    Array.isArray(value.claims) &&
    value.claims.every(
      (claim) =>
        isRecord(claim) && typeof claim.kind === "string" && POLICY_CLAIM_KINDS.has(claim.kind) && typeof claim.quote === "string"
    ) &&
    isStringArray(value.mentionedEntities) &&
    isStringArray(value.unmentionedEntities) &&
    isFiniteNumber(value.policyTextLength)
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
  const numericFields = [
    "durationMs",
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
    (value.status === null || isFiniteNumber(value.status)) &&
    typeof value.firstPartyDomain === "string" &&
    numericFields.every((field) => isFiniteNumber(value[field])) &&
    (value.shieldsBlockedRequests === undefined || isFiniteNumber(value.shieldsBlockedRequests))
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
    "consentMode",
    "automation",
    "scannerEgress",
    "scannerDisclosure"
  ];
  const viewport = value.viewport;
  const adblock = value.adblock;
  const catalog = value.trackerCatalog;
  return (
    stringFields.every((field) => typeof value[field] === "string") &&
    isRecord(viewport) &&
    isFiniteNumber(viewport.width) &&
    isFiniteNumber(viewport.height) &&
    typeof viewport.isMobile === "boolean" &&
    typeof value.gpcEnabled === "boolean" &&
    typeof value.headless === "boolean" &&
    (value.shieldsMode === undefined || (typeof value.shieldsMode === "string" && SHIELDS_MODES.has(value.shieldsMode))) &&
    (adblock === undefined ||
      (isRecord(adblock) &&
        typeof adblock.active === "boolean" &&
        typeof adblock.source === "string" &&
        isFiniteNumber(adblock.lists) &&
        typeof adblock.fetchedAt === "string")) &&
    isRecord(catalog) &&
    typeof catalog.source === "string" &&
    typeof catalog.version === "string" &&
    typeof catalog.region === "string" &&
    isFiniteNumber(catalog.entries) &&
    isFiniteNumber(catalog.curatedOverrides) &&
    typeof catalog.license === "string"
  );
}

function deepValidateV1Result(result: ScanResult): boolean {
  const value = result as unknown as Record<string, unknown>;
  return (
    isV1Summary(value.summary) &&
    isV1Conditions(value.conditions) &&
    Array.isArray(value.requests) &&
    value.requests.every(isV1Request) &&
    Array.isArray(value.domains) &&
    value.domains.every(isV1Domain) &&
    Array.isArray(value.cookies) &&
    value.cookies.every(isV1Cookie) &&
    Array.isArray(value.storage) &&
    value.storage.every(isV1Storage) &&
    Array.isArray(value.fingerprintEvents) &&
    value.fingerprintEvents.every(isV1FingerprintEvent) &&
    (value.fingerprintDetections === undefined ||
      (Array.isArray(value.fingerprintDetections) && value.fingerprintDetections.every(isFingerprintDetectionSummary))) &&
    (value.cnameCloaks === undefined || (Array.isArray(value.cnameCloaks) && value.cnameCloaks.every(isV1CnameCloak))) &&
    (value.pixelEvents === undefined || (Array.isArray(value.pixelEvents) && value.pixelEvents.every(isV1PixelEvent))) &&
    (value.privacyPolicy === undefined || isV1PrivacyPolicy(value.privacyPolicy)) &&
    (value.consentInteraction === undefined || isV1ConsentInteraction(value.consentInteraction)) &&
    (value.screenshot === null || typeof value.screenshot === "string") &&
    isStringArray(value.warnings) &&
    (value.share === undefined || isV1Share(value.share))
  );
}

function isV1MetricDelta(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.before) && isFiniteNumber(value.after) && isFiniteNumber(value.delta);
}

function isV1DomainChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    isFiniteNumber(value.requests) &&
    (value.tracker === null || isV1Tracker(value.tracker))
  );
}

function isV1EntityChange(value: unknown): boolean {
  return isRecord(value) && typeof value.entity === "string" && isFiniteNumber(value.requests) && isFiniteNumber(value.domains);
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
  return isRecord(value) && typeof value.kind === "string" && typeof value.heuristic === "string" && isFiniteNumber(value.count);
}

function isV1PixelEventChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.platform === "string" &&
    typeof value.product === "string" &&
    isStringArray(value.events) &&
    Array.isArray(value.advancedMatching) &&
    value.advancedMatching.every((field) => typeof field === "string" && PIXEL_MATCH_FIELDS.has(field))
  );
}

function isV1ProvenanceChange(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.domain === "string" &&
    isFiniteNumber(value.requests) &&
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
  const changeArrays: Array<[string, (entry: unknown) => boolean]> = [
    ["addedDomains", isV1DomainChange],
    ["removedDomains", isV1DomainChange],
    ["addedEntities", isV1EntityChange],
    ["removedEntities", isV1EntityChange],
    ["addedCookies", isV1CookieChange],
    ["removedCookies", isV1CookieChange],
    ["addedStorageKeys", isV1StorageKeyChange],
    ["removedStorageKeys", isV1StorageKeyChange],
    ["addedFingerprinting", isV1FingerprintingChange],
    ["removedFingerprinting", isV1FingerprintingChange],
    ["addedProvenance", isV1ProvenanceChange],
    ["removedProvenance", isV1ProvenanceChange]
  ];
  return (
    requiredDeltas.every((field) => isV1MetricDelta(value[field])) &&
    (value.shieldsBlockedRequests === undefined || isV1MetricDelta(value.shieldsBlockedRequests)) &&
    changeArrays.every(([field, check]) => Array.isArray(value[field]) && (value[field] as unknown[]).every(check)) &&
    (value.addedPixelEvents === undefined ||
      (Array.isArray(value.addedPixelEvents) && value.addedPixelEvents.every(isV1PixelEventChange))) &&
    (value.removedPixelEvents === undefined ||
      (Array.isArray(value.removedPixelEvents) && value.removedPixelEvents.every(isV1PixelEventChange)))
  );
}

function deepValidateV1Comparison(report: ComparisonScanResult): boolean {
  const value = report as unknown as Record<string, unknown>;
  return (
    typeof value.comparisonType === "string" &&
    COMPARISON_TYPES.has(value.comparisonType) &&
    typeof value.title === "string" &&
    (value.runLabels === undefined ||
      (isRecord(value.runLabels) &&
        typeof value.runLabels.baseline === "string" &&
        typeof value.runLabels.variant === "string")) &&
    typeof value.requestedUrl === "string" &&
    typeof value.scannedAt === "string" &&
    typeof value.device === "string" &&
    DEVICES.has(value.device) &&
    deepValidateV1Result(report.baseline) &&
    deepValidateV1Result(report.variant) &&
    isV1Diff(value.diff) &&
    isStringArray(value.warnings) &&
    (value.share === undefined || isV1Share(value.share))
  );
}

export function deepValidateScanReportV1(report: ScanReport): boolean {
  if (report.reportType === "comparison") return deepValidateV1Comparison(report);
  return deepValidateV1Result(report);
}
