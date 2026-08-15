import type { ReportHeadline } from "./report-headline";
import { siteUrl } from "./site-url";
import { displayHost } from "./text-format";

export const SITE_TITLE_SUFFIX = " · Site Behavior Lab";
export const REPORT_RENDERED_TITLE_MAX_LENGTH = 64;
const REPORT_TITLE_MAX_LENGTH = REPORT_RENDERED_TITLE_MAX_LENGTH - SITE_TITLE_SUFFIX.length;
const REPORT_DESCRIPTION_MAX_LENGTH = 160;

/** Complete, absolute metadata for an indexable public page. */
export function publicPageMetadata(input: {
  title: string;
  description: string;
  path: string;
}) {
  const url = siteUrl(input.path);
  return {
    title: input.title,
    description: input.description,
    alternates: { canonical: url },
    openGraph: {
      title: input.title,
      description: input.description,
      siteName: "Site Behavior Lab",
      type: "website",
      url,
      images: [{ url: siteUrl("/opengraph-image"), width: 1200, height: 630, alt: "Site Behavior Lab" }]
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [siteUrl("/twitter-image")]
    }
  };
}

/** Collapse untrusted/page-derived whitespace and stop metadata at a word boundary. */
export function conciseMetadataText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  if (maxLength <= 1) return "…".slice(0, maxLength);

  const candidate = compact.slice(0, maxLength - 1).trimEnd();
  const lastSpace = candidate.lastIndexOf(" ");
  const boundary = lastSpace >= Math.floor(maxLength * 0.55) ? candidate.slice(0, lastSpace) : candidate;
  return `${boundary.replace(/[\s,;:.!?-]+$/u, "")}…`;
}

export function reportMetadataTitle(input: {
  domain: string;
  reportId: string;
  scannedAt: string | null;
  reportType: "single" | "comparison";
  comparisonAxis?: string | null;
}): string {
  const kind =
    input.reportType === "single"
      ? "scan"
      : input.comparisonAxis === "gpc"
        ? "GPC"
        : input.comparisonAxis === "shields"
          ? "Shields"
          : input.comparisonAxis === "consent"
            ? "consent"
            : "comparison";
  const date = isoDate(input.scannedAt);
  const reportRef = input.reportId.replace(/[^a-z0-9]/giu, "").toLowerCase().slice(-8) || "report";
  const suffix = ` ${kind}${date ? ` · ${date}` : ""} · ${reportRef}`;
  const domainBudget = Math.max(1, REPORT_TITLE_MAX_LENGTH - suffix.length);
  return `${conciseMetadataText(displayHost(input.domain), domainBudget)}${suffix}`;
}

export function reportMetadataDescription(headline: ReportHeadline): string {
  const primaryClaim = headline.subheadPrimaryClaim || headline.subhead || "";
  const candidates = [
    `${headline.headline} ${primaryClaim} ${headline.caveat}`,
    `${primaryClaim} ${headline.caveat}`
  ].map((value) => value.replace(/\s+/g, " ").trim());
  const complete = candidates.find(
    (candidate) => candidate.length > 0 && candidate.length <= REPORT_DESCRIPTION_MAX_LENGTH
  );
  if (complete) return complete;

  // Never sever a claim from the sentence that scopes or qualifies it. If the
  // complete lead does not fit social metadata, withhold the claim and direct
  // readers to the report instead of publishing a categorical fragment.
  return conciseMetadataText(
    `Automated visit to ${headline.domain || "this site"}. Open the report for the complete finding, evidence scope, and limitations. Evidence to check, not a verdict.`,
    REPORT_DESCRIPTION_MAX_LENGTH
  );
}

/** A sitemap date is emitted only when it is parseable and not in the future. */
export function sitemapLastModified(value: string | null | undefined, nowMs = Date.now()): Date | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > nowMs) return undefined;
  return new Date(timestamp);
}

export function newestSitemapDate(
  values: Iterable<string | null | undefined>,
  nowMs = Date.now()
): Date | undefined {
  let newest: Date | undefined;
  for (const value of values) {
    const candidate = sitemapLastModified(value, nowMs);
    if (candidate && (!newest || candidate.getTime() > newest.getTime())) newest = candidate;
  }
  return newest;
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;
}
