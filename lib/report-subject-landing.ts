/**
 * A visit that landed on a different site than the one it was asked for.
 *
 * A visit is attributed to where it landed (lib/corpus-site-domain.ts): a
 * request for brand.example that redirects to parent.example is a report about
 * parent.example, headed and filed under it. That is deliberate, but nothing
 * else on the page tells a reader who asked about brand.example why the report
 * names another site. It also has a consequence the totals cannot show on
 * their own: request records are classified against the landing site, so the
 * requested site's own requests, its redirect response included, sit in this
 * report's cross-site request and host totals.
 *
 * Derived only from recorded fields. v2 compares the registrable domains its
 * subject block recorded. v1 recorded URLs only, so its requested and final
 * hosts go through the public-suffix rule the v2 subject key was built with;
 * a host without a public registrable domain yields no statement, never a
 * guess. Server-rendered surfaces only: the rule carries the public-suffix
 * table, which no client bundle should load.
 */
import { publicRegistrableDomain } from "./redaction-v2";
import { runVisitLabel, type ReportView, type RunView } from "./scan-report-views";
import { displayHost, plural } from "./text-format";

export type CrossSiteLanding = {
  /** Wire spelling; may carry redaction markers. Render through displayHost. */
  requestedHost: string;
  landedHost: string;
  requestedSite: string;
  landedSite: string;
  /** Recorded requests to the requested site that this report counts as cross-site. */
  countedRequests: number;
  /** How many of those carried a redirect status. */
  countedRedirects: number;
  /** Distinct hosts among them, the unit of the cross-site host total. */
  countedHosts: number;
};

// 304 is a cache revalidation, not a redirect.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function crossSiteLanding(run: RunView): CrossSiteLanding | null {
  const requestedHost = urlHost(run.conditions.requestedUrl);
  const landedHost = urlHost(run.conditions.finalUrl);
  if (requestedHost === null || landedHost === null) return null;
  const recordedRequestedSite = run.conditions.requestedRegistrableDomain;
  const requestedSite =
    recordedRequestedSite !== null ? recordedRequestedSite.toLowerCase() : publicRegistrableDomain(requestedHost);
  const landedSite = recordedRequestedSite !== null ? run.domain.toLowerCase() : publicRegistrableDomain(landedHost);
  if (requestedSite === null || landedSite === null || requestedSite === landedSite) return null;

  const counted = run.evidence.requests.filter(
    (request) => request.thirdParty && publicRegistrableDomain(request.domain) === requestedSite
  );
  return {
    requestedHost,
    landedHost,
    requestedSite,
    landedSite,
    countedRequests: counted.length,
    countedRedirects: counted.filter((request) => request.status !== null && REDIRECT_STATUSES.has(request.status)).length,
    countedHosts: new Set(counted.map((request) => request.domain)).size
  };
}

/**
 * The reader-facing disclosure, or null when the visit stayed on the requested
 * site. A comparison arm's sentence speaks for that visit: a pair has two sets
 * of totals, and "this report's" would claim the arm's count for both.
 */
export function crossSiteLandingNote(run: RunView): string | null {
  const landing = crossSiteLanding(run);
  return landing ? landingSentence(landing, run.label === null ? "report" : "visit") : null;
}

/**
 * The identity block's lines: one per visit that landed elsewhere, labeled on
 * comparisons because the block's own URL and heading describe one arm only.
 * A pair whose two visits landed identically reads once.
 */
export function crossSiteLandingLines(view: ReportView): string[] {
  const landed = view.runs.flatMap((run) => {
    const landing = crossSiteLanding(run);
    return landing === null ? [] : [{ run, landing }];
  });
  if (view.runs.length < 2) return landed.map((entry) => landingSentence(entry.landing, "report"));
  if (
    view.runs.length === 2 &&
    landed.length === 2 &&
    landingSentence(landed[0].landing, "visit") === landingSentence(landed[1].landing, "visit")
  ) {
    return [landingSentence(landed[0].landing, "both")];
  }
  return landed.map((entry) => `${runVisitLabel(entry.run)}: ${landingSentence(entry.landing, "visit")}`);
}

/** `report` for a single report, `visit` for one comparison arm, `both` for a pair that landed alike. */
function landingSentence(landing: CrossSiteLanding, scope: "report" | "visit" | "both"): string {
  const lead =
    `Requested ${displayHost(landing.requestedHost)}; ${scope === "both" ? "both visits" : "the visit"} landed on ` +
    `${displayHost(landing.landedHost)}, a different site, which this report describes.`;
  if (landing.countedRequests === 0) return lead;
  const site = landing.requestedSite;
  const redirects =
    landing.countedRedirects === 0
      ? ""
      : landing.countedRedirects === landing.countedRequests
        ? landing.countedRequests === 1
          ? " (a redirect response)"
          : " (all redirect responses)"
        : ` (${plural(landing.countedRedirects, "redirect response")} among them)`;
  const totals = scope === "both" ? "each visit's" : scope === "visit" ? "this visit's" : "this report's";
  return (
    `${lead} Requests are classified against the landing site, so ${totals} cross-site totals count ` +
    `${plural(landing.countedRequests, "request")} to ${site}${redirects} and ${plural(landing.countedHosts, `${site} host`)}.`
  );
}

function urlHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}
