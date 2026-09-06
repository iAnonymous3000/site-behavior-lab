import { FlaskConical } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { SITE_PRIMARY_NAV, SITE_TRUST_LINKS, SOURCE_REPOSITORY_URL } from "@/lib/site-navigation";
import { staticAssetPath } from "../client-runtime";
import { ThemeToggle } from "./theme-toggle";

/**
 * The one page shell, because there used to be three and twelve routes with none.
 *
 * The homepage and the report permalink each hand-wrote a top bar and a footer;
 * every other route rendered a bare `<main>` with a title block inside it and a
 * `<TrustLinks />` row at the bottom. That produced three separate defects at
 * once. Thirteen of fifteen routes exposed no banner and no contentinfo landmark
 * (the trust row is a `<nav>` nested inside `main`, not a footer). Thirteen had
 * no skip link. And a reader who arrived from search on `/directory/`,
 * `/sites/*`, or any policy page had no navigation at all: the scanner and the
 * evidence library, the two halves of the product, could not reach each other.
 *
 * The brand is deliberately NOT the `<h1>`. Both old shells put the page heading
 * inside the brand anchor and relied on the anchor's aria-label to override its
 * own subtree, which left every other route free to render a second `<h1>` in
 * its content. One `<h1>` per route now lives where the reader looks for it, in
 * the content, and the brand is a wordmark link.
 *
 * Server-safe on purpose: it holds no state, so it renders inside server routes
 * without pulling them into the client bundle. `ThemeToggle` stays the single
 * client island, and every href goes through `staticAssetPath` so one mechanism
 * resolves the Pages base path. Mixing `next/link` (which prefixes basePath
 * itself) with an explicitly prefixed href double-prefixes, and that only ever
 * reproduces on a base-path deployment.
 */
export function SiteChrome({
  activePath,
  actions = null,
  children,
  mainId = "main",
  mainProps,
  shellClassName,
  skipToId
}: {
  /** The route this render is serving, for `aria-current`. Pass the same literal as the nav href. */
  activePath?: string;
  /** Route-specific header controls (the scanner's status pill, a report's scan action). */
  actions?: ReactNode;
  children: ReactNode;
  mainId?: string;
  /** Extra attributes for `<main>`, for routes that focus or name it. */
  mainProps?: { "aria-label"?: string; tabIndex?: number };
  shellClassName?: string;
  /**
   * Where "Skip to content" lands. Defaults to `<main>`; routes whose useful
   * content starts at a known region (the homepage's results) point at it.
   */
  skipToId?: string;
}) {
  const skipTarget = skipToId ?? mainId;
  return (
    <>
      <a className="skip-link" href={`#${skipTarget}`}>
        Skip to content
      </a>
      <div className={`app-shell${shellClassName ? ` ${shellClassName}` : ""}`}>
        <header className="topbar">
          <a className="brand" href={staticAssetPath("/")}>
            <span className="brand-mark">
              <FlaskConical size={20} aria-hidden="true" />
            </span>
            {/* The wordmark alone. The thesis sentence that used to sit under it
                on every route is the homepage's <h1>, and everywhere else it
                competed with the page's own heading for the same line. */}
            <span className="brand-text">
              <span className="brand-name">Site Behavior Lab</span>
            </span>
          </a>
          {/* A direct child of the header, not nested inside the actions: on a
              narrow screen the bar becomes a two-row grid and the nav takes the
              second row on its own, which it can only do as a grid item. */}
          <nav className="topbar-nav" aria-label="Primary">
            {SITE_PRIMARY_NAV.map((link) => (
              <a
                aria-current={link.href === activePath ? "page" : undefined}
                className="topbar-link"
                href={staticAssetPath(link.href)}
                key={link.href}
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="topbar-actions">
            {actions}
            <ThemeToggle />
          </div>
        </header>

        <main id={mainId} {...mainProps}>
          {children}
        </main>

        <footer className="app-footer">
          {/* Rendered from the shared list, not a hand-written copy. The copy
              this replaced had drifted twice: both former footers listed the
              same seven routes and both omitted /about/, so the page explaining
              what this project is was reachable from every secondary page and
              from neither of the two surfaces readers actually arrive on. */}
          <span className="app-footer-links">
            Site Behavior Lab: open-source web transparency tooling.{" "}
            {SITE_TRUST_LINKS.map((link, index) => (
              <Fragment key={link.href}>
                {index > 0 ? " · " : null}
                <a className="footer-link" href={staticAssetPath(link.href)}>
                  {link.label}
                </a>
              </Fragment>
            ))}
            {" · "}
            <a className="footer-link" href={SOURCE_REPOSITORY_URL}>
              Source
            </a>
          </span>
          <span className="app-footer-caveat">
            Reports record one automated visit per condition; visits may be incomplete. On restart-safe deployments,
            an interrupted visit may be retried; attempts are never merged. Results describe these visits, not everything a site can do.
          </span>
        </footer>
      </div>
    </>
  );
}
