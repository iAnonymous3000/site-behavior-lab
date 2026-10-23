import type { HomepageKnownSite } from "./homepage-discovery";
import { LIVE_RESCAN_HISTORY_CLAUSE } from "./live-rescan-copy";
import { RUN_MODE_LABELS, type ComparisonRunMode } from "./run-mode-copy";
import { displayPublicUrl } from "./text-format";

/**
 * The scan form's choice for an address whose site already has evidence
 * (journey audit gap 8): read the newest report first, or check now. Pure and
 * React-free so unit tests reach every branch; app/_components/scan-controls.tsx
 * renders it. It reads no retention default: a number reaches the note only
 * from the scanner's own health.
 */

/** The typed field value as an http(s) URL, the way the form has always read it, or null. */
export function typedHttpUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function comparableHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

/** The corpus site the typed host equals or sits under (host suffix only; the path is ignored). */
export function matchingKnownSite(value: string, knownSites: HomepageKnownSite[]): HomepageKnownSite | null {
  const typed = typedHttpUrl(value);
  if (!typed) return null;
  const hostname = comparableHost(typed);
  return knownSites.find((site) => hostname === site.domain || hostname.endsWith(`.${site.domain}`)) ?? null;
}

/**
 * Whether the field still holds exactly the address one of the site's own
 * "Scan this site again" or "Scan this exact route again" links put there.
 * The visitor asked to scan again, so the form keeps its usual button; the
 * first edit to the field ends the arrival.
 */
export function isScanAgainArrival(prefilledUrl: string | null, fieldValue: string): boolean {
  return prefilledUrl !== null && fieldValue === prefilledUrl;
}

/**
 * The earlier result a follow-up's scan link named (`from`), for as long as
 * that arrival lasts by the rule above: the field still holds exactly the
 * address the link put there, and the one comparison the scan would ask for
 * is the mode the link asked for. Editing the address or changing the mode
 * ends it, and putting both back as the link set them restores it, since
 * the scan would again be the very comparison the link opened. A scan that
 * starts while it holds carries the id to its result; otherwise null, as it
 * is for a link that named no earlier result.
 */
export function connectedEarlierResult(input: {
  prefilledUrl: string | null;
  prefilledMode: ComparisonRunMode | null;
  prefilledFrom: string | null;
  fieldValue: string;
  /** Each comparison the scan request would ask for: offered and selected. */
  requested: Readonly<Record<ComparisonRunMode, boolean>>;
}): string | null {
  if (!isScanAgainArrival(input.prefilledUrl, input.fieldValue)) return null;
  const requested = (Object.keys(input.requested) as ComparisonRunMode[]).filter((mode) => input.requested[mode]);
  return requested.length === 1 && requested[0] === input.prefilledMode ? input.prefilledFrom : null;
}

/**
 * The inspection a scan link asked for (`inspect`), for as long as that
 * arrival lasts by the same rule: the field still holds exactly the address
 * the link put there and no comparison is selected, since an inspection is
 * always a single visit. Editing the address or picking a comparison ends it,
 * and putting both back restores it. A scan that starts while it holds is an
 * inspection of that address, connected to the result the link named, if
 * any; otherwise null, and the scan is an ordinary one.
 */
export function connectedInspection(input: {
  prefilledUrl: string | null;
  prefilledInspect: string | null;
  prefilledFrom: string | null;
  fieldValue: string;
  /** Whether the scan request would ask for any comparison: offered and selected. */
  comparison: boolean;
}): { address: string; from: string | null } | null {
  if (input.prefilledInspect === null || input.comparison) return null;
  if (!isScanAgainArrival(input.prefilledUrl, input.fieldValue)) return null;
  return { address: input.prefilledInspect, from: input.prefilledFrom };
}

/**
 * What the scan form says while an inspection arrival holds (owner's
 * approval, 2026-10-22): which address, which page, and that the details are
 * not saved. The address and the page are shown as a report shows them.
 */
export function inspectionFormSentences(input: { address: string; page: string }): {
  inspecting: string;
  visit: string;
} {
  return {
    inspecting: `Inspecting ${displayPublicUrl(input.address)}.`,
    visit: `A new visit to ${displayPublicUrl(input.page)} will record which scripts were running when each request to this address was made. The details show here only and are not saved.`
  };
}

/**
 * Whether the form leads with the existing report: a site matched, the visitor
 * did not ask to scan again, and no scan is loading or retained. While one is,
 * the submit button is exactly the usual one.
 */
export function leadsWithExistingReport(input: {
  siteMatched: boolean;
  scanAgainArrival: boolean;
  scanBusy: boolean;
}): boolean {
  return input.siteMatched && !input.scanAgainArrival && !input.scanBusy;
}

/**
 * The one submit button's label. Without a lead report it is the usual "Scan"
 * or "Compare", and "Inspect" while an inspection arrival holds, which never
 * leads with a report, since that arrival is a scan-again arrival too.
 */
export function scanSubmitLabel(input: { comparison: boolean; leadsWithReport: boolean; inspecting?: boolean }): string {
  if (input.inspecting) return "Inspect";
  if (input.leadsWithReport) return input.comparison ? "Compare now" : "Check now";
  return input.comparison ? "Compare" : "Scan";
}

/**
 * How long a new share report is kept, from the scanner's own retention
 * setting. "Up to": the store's count cap removes the oldest shares once each
 * has lasted its minimum survival time, so a share can go well before the
 * limit. With no number from the scanner, none is stated.
 */
export function shareRetentionClause(maxAgeDays: number | null): string {
  if (maxAgeDays === null) return "kept for a limited time";
  const days = maxAgeDays.toLocaleString("en-US", { maximumSignificantDigits: 2 });
  return `kept for up to about ${days} ${days === "1" ? "day" : "days"}`;
}

/**
 * What a new check runs and what it leaves behind: one visit, or two for a
 * comparison, and a separate share report kept as long as the scanner's own
 * retention says. The form states it before a mode link's comparison runs.
 */
export function newCheckSentence(input: { comparison: boolean; maxAgeDays: number | null }): string {
  return (
    `A new check runs ${input.comparison ? "two visits" : "one visit"} in the selected mode and makes a separate ` +
    `share report, ${shareRetentionClause(input.maxAgeDays)}.`
  );
}

/** What a new check does that reading the existing report does not. */
export function knownEvidenceDifference(input: { comparison: boolean; maxAgeDays: number | null }): string {
  return `${newCheckSentence(input)} It is not added to this site's history: ${LIVE_RESCAN_HISTORY_CLAUSE}.`;
}

/**
 * Whether the form states the share line after a scan link that asked for a
 * comparison: while the field still holds the address that link put there,
 * and only once that comparison, or another, is selected, so the line never
 * counts two visits beside Single. A corpus site shows the known-site note
 * instead, which already carries the line and the history clause.
 */
export function showsModeLinkShareLine(input: {
  prefilledMode: ComparisonRunMode | null;
  scanAgainArrival: boolean;
  comparison: boolean;
  siteMatched: boolean;
}): boolean {
  return input.prefilledMode !== null && input.scanAgainArrival && input.comparison && !input.siteMatched;
}

/**
 * The existing report's kind, in the Run control's own label, then its
 * headline verbatim. No kind is named for a report the form cannot run.
 */
export function knownEvidenceReport(site: Pick<HomepageKnownSite, "runMode" | "headline">): string {
  const kind = site.runMode === null ? "" : `Run: ${RUN_MODE_LABELS[site.runMode]}. `;
  return `${kind}Lead finding: ${site.headline}`;
}

/**
 * Which page the existing evidence is for, whenever the typed host or path is
 * not the report's requested one; null when both match. The site match is by
 * host suffix, so it fires for subdomains and deep paths, and the note must
 * never present the evidence as the typed page's. A requested URL that carries
 * a privacy token can never be shown to match, so it always names itself.
 */
export function knownEvidenceTarget(typed: string, requestedUrl: string): string | null {
  const typedUrl = typedHttpUrl(typed);
  let requested: URL | null = null;
  try {
    requested = new URL(requestedUrl);
  } catch {
    requested = null;
  }
  const matches =
    typedUrl !== null &&
    requested !== null &&
    !/[{}]|%7b|%7d/i.test(requestedUrl) &&
    comparableHost(typedUrl) === comparableHost(requested) &&
    typedUrl.pathname === requested.pathname;
  return matches ? null : `This evidence is for ${displayPublicUrl(requestedUrl)}.`;
}
