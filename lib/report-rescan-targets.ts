import { safeNavigableHttpUrl } from "./report-url";
import { displayRunView, type ReportView } from "./scan-report-views";

/**
 * The pages a report's rescan may visit again, the one derivation behind the
 * report header's "Scan this exact route again" and "Scan this site again"
 * links (reportActivation in lib/report-trust.ts) and a findings card's new
 * visit (lib/finding-look-closer.ts). Exact routes replay only for legacy
 * reports whose already-redacted URL still names a real HTTP(S) page; v2
 * route shapes carry privacy markers and never become navigation targets.
 *
 * Kept apart from report-trust so the lazy evidence explorer can import it
 * without the site identity and public-suffix code that module reads.
 */
export type ReportRescanTargets = {
  /** The exact requested route, or null when it cannot be replayed. */
  exactTarget: string | null;
  /** The exact route when it can be replayed, otherwise the site root, `https://<domain>/`. */
  siteTarget: string | null;
  /**
   * The requested page itself when it is a front page on this report's site:
   * path "/", no query and no privacy marker, so it names the very page the
   * report visited even where the route is otherwise a shape. Null for a
   * subpage, a hidden label and a request for another site.
   */
  frontPageTarget: string | null;
};

export function reportRescanTargets(view: ReportView): ReportRescanTargets {
  const run = displayRunView(view);
  const exactTarget = run.conditions.urlsAreRouteShapes ? null : safeNavigableHttpUrl(run.conditions.requestedUrl);
  // The domain is already public in this report, so the site root is always a
  // safe replay target even when the exact route is a privacy-marked shape.
  const siteTarget = exactTarget ?? safeNavigableHttpUrl(`https://${view.domain}/`);
  return { exactTarget, siteTarget, frontPageTarget: requestedFrontPage(view, run.conditions.requestedUrl) };
}

/**
 * The page a findings card's new visit would visit again, or null when the
 * report offers none. Only a fresh result has one: the homepage's own live
 * scan, or that scan's runtime share permalink. A committed report, a file
 * opened from disk and a comparison built in the archive pass false.
 *
 * The page is a rescan target above, never a derivation of its own, and it is
 * the page the report visited, so the card's "visit this page twice" stays
 * true (owner's choice, 2026-10-22). When the exact route cannot be replayed
 * (every v2 report), the report must have requested a front page, gate G4 of
 * the Look closer draft and the owner's ruling: otherwise the new pair would
 * describe a different page. A requested `https://www.<domain>/` is visited
 * as itself, not as `https://<domain>/`.
 */
export function reportNewVisitTarget(view: ReportView, fresh: boolean): string | null {
  if (!fresh) return null;
  const { exactTarget, frontPageTarget } = reportRescanTargets(view);
  return exactTarget ?? frontPageTarget;
}

function requestedFrontPage(view: ReportView, requestedUrl: string): string | null {
  // A requested URL carrying a privacy marker never names a page it can be
  // shown to be, a front page included.
  const requested = safeNavigableHttpUrl(requestedUrl);
  if (!requested) return null;
  const page = new URL(requested);
  const onThisSite = page.hostname === view.domain || page.hostname.endsWith(`.${view.domain}`);
  return page.pathname === "/" && page.search === "" && onThisSite ? requested : null;
}
