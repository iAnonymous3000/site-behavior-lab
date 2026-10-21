import type { HomepageKnownSite } from "./homepage-discovery";
import { LIVE_RESCAN_HISTORY_CLAUSE } from "./live-rescan-copy";
import { RUN_MODE_LABELS } from "./run-mode-copy";
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

/** The one submit button's label. Without a lead report it is the usual "Scan" or "Compare". */
export function scanSubmitLabel(input: { comparison: boolean; leadsWithReport: boolean }): string {
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

/** What a new check does that reading the existing report does not. */
export function knownEvidenceDifference(input: { comparison: boolean; maxAgeDays: number | null }): string {
  return (
    `A new check runs ${input.comparison ? "two visits" : "one visit"} in the selected mode and makes a separate ` +
    `share report, ${shareRetentionClause(input.maxAgeDays)}. It is not added to this site's history: ` +
    `${LIVE_RESCAN_HISTORY_CLAUSE}.`
  );
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
