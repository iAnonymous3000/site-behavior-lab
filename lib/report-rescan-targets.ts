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
};

export function reportRescanTargets(view: ReportView): ReportRescanTargets {
  const run = displayRunView(view);
  const exactTarget = run.conditions.urlsAreRouteShapes ? null : safeNavigableHttpUrl(run.conditions.requestedUrl);
  // The domain is already public in this report, so the site root is always a
  // safe replay target even when the exact route is a privacy-marked shape.
  const siteTarget = exactTarget ?? safeNavigableHttpUrl(`https://${view.domain}/`);
  return { exactTarget, siteTarget };
}

/**
 * The page a findings card's new visit would visit again, or null when the
 * report offers none. Only a fresh result has one: the homepage's own live
 * scan, or that scan's runtime share permalink. A committed report, a file
 * opened from disk and a comparison built in the archive pass false.
 *
 * The page is a rescan target above, never a second derivation. When the
 * exact route cannot be replayed (every v2 report), the report must have
 * requested the site root, gate G4 of the Look closer draft and the owner's
 * ruling: otherwise the new pair would describe a different page. The site
 * root is `https://<domain>/`, so a requested `https://<domain>/` or
 * `https://www.<domain>/` is it; a subpage, another subdomain's root, a
 * hidden label and a landing on another site are not.
 */
export function reportNewVisitTarget(view: ReportView, fresh: boolean): string | null {
  if (!fresh) return null;
  const { exactTarget, siteTarget } = reportRescanTargets(view);
  if (exactTarget) return exactTarget;
  return siteTarget !== null && requestedSiteRoot(view, siteTarget) ? siteTarget : null;
}

function requestedSiteRoot(view: ReportView, siteRoot: string): boolean {
  // A requested URL carrying a privacy marker never names a page it can be
  // shown to be, the site root included.
  const requested = safeNavigableHttpUrl(displayRunView(view).conditions.requestedUrl);
  if (!requested) return false;
  const page = new URL(requested);
  const rootHost = new URL(siteRoot).hostname;
  return (
    page.pathname === "/" &&
    page.search === "" &&
    (page.hostname === rootHost || page.hostname === `www.${rootHost}`)
  );
}
