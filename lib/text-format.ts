/**
 * Small, dependency-free text helpers shared by the report headline, the
 * findings engine, and the report UI.
 *
 * Counts are pinned to the "en-US" locale so server-rendered and
 * client-rendered copy match (no hydration drift) and unit tests stay stable
 * regardless of the host's default locale.
 */

import type { ConsentClicks } from "./temporal-report-identity";
import type { ComparisonType } from "./types";
import { isReviewedCookieName, isReviewedStorageKey } from "./public-name-policy";

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Join a list into prose with an overflow tail:
 * `["a", "b", "c", "d"]` → `"a, b and c, plus 1 other"`.
 */
export function humanList(items: string[], limit = 3): string {
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  if (visible.length === 0) return "";
  if (visible.length === 1) return remaining > 0 ? `${visible[0]} and ${plural(remaining, "other")}` : visible[0];
  const joined = `${visible.slice(0, -1).join(", ")} and ${visible.at(-1)}`;
  return remaining > 0 ? `${joined}, plus ${plural(remaining, "other")}` : joined;
}

/**
 * Reader-facing form of a privacy-generalized host or cookie domain: the
 * sanitizer's "{label}" tokens (unreviewed subdomain labels, RFC 9.1) render
 * as the conventional "*" wildcard. Braces are invalid in real hostnames, so
 * the token can never collide with recorded network data. Display-only; the
 * wire keeps the exact recorded shape.
 */
export function displayHost(host: string): string {
  return host.replaceAll("{label}", "*");
}

/** Match either the stored privacy token or the wildcard readers see. */
export function hostMatchesQuery(host: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return host.toLowerCase().includes(needle) || displayHost(host).toLowerCase().includes(needle);
}

/**
 * Reader-facing label for an exact reviewed cookie name/storage key. Managed
 * reports carry canonical privacy markers, while local imports can contain
 * arbitrary strings; the UI hides both and numbers rows so several distinct
 * observations never look like one duplicated identity.
 */
export function displayEvidenceName(
  value: string,
  kind: "cookie" | "storage",
  ordinal: number
): string {
  const reviewed = kind === "cookie" ? isReviewedCookieName(value) : isReviewedStorageKey(value);
  if (reviewed) return value;
  const subject = kind === "cookie" ? "Cookie" : "Storage key";
  return `${subject} ${ordinal} · name hidden for privacy`;
}

export function comparisonDeltaHeading(
  labels: { baseline: string; variant: string },
  hasComparableDelta: boolean
): string {
  return hasComparableDelta
    ? `${labels.baseline} → ${labels.variant} delta`
    : `${labels.baseline} and ${labels.variant}: two visits, no comparable metric delta`;
}

/**
 * One report-kind label for every corpus surface. A consent pair is a true
 * choice comparison only when both controls were activated; otherwise the
 * label names the attempted observation instead of overstating the evidence.
 */
export function reportKindLabel(entry: {
  reportType: "single" | "comparison";
  comparisonType?: ComparisonType | null;
  consentClicks?: ConsentClicks | null;
}): string {
  if (entry.reportType !== "comparison") return "single scan";
  if (entry.comparisonType === "shields") return "Brave-list blocking comparison";
  if (entry.comparisonType === "gpc") return "GPC comparison";
  if (entry.comparisonType === "consent") {
    if (entry.consentClicks === "accept-and-reject") return "consent comparison";
    if (entry.consentClicks === "accept-only") return "consent comparison attempt (Reject not clicked)";
    if (entry.consentClicks === "reject-only") return "consent comparison attempt (Accept not clicked)";
    return "consent comparison attempt (no banner clicked)";
  }
  if (entry.comparisonType === "temporal") return "temporal comparison";
  return "comparison";
}
