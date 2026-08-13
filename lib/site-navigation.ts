/**
 * The one list of public trust surfaces, because there used to be two.
 *
 * `/about/` shipped linked from the shared TrustLinks component, which every
 * secondary page renders and the homepage does not: the home shell carries its
 * own hand-written footer list. Both lists were internally consistent and
 * disagreed with each other, so the page that answers "what is this?" was
 * reachable from everywhere except the front door, while still sitting in the
 * sitemap for crawlers to find.
 *
 * Order is canonical and About leads, since a first-time reader needs it most.
 * Each surface applies its own href resolution (next/link on policy pages, the
 * static-export asset path in the home shell) and its own styling; only the
 * set and its order live here.
 */
export type SiteNavLink = {
  readonly href: string;
  readonly label: string;
};

/**
 * The primary navigation: the routes a reader uses to move through the product
 * rather than to check the project's claims about itself.
 *
 * This used to be three hand-written links in the homepage top bar, on the only
 * two routes that had a top bar at all. Thirteen routes rendered no brand, no
 * navigation and no way back except a "Back to Site Behavior Lab" text link, so
 * a reader who arrived on an indexed directory, category, site-history or policy
 * page could not reach the other half of the product without editing the URL.
 * One shell renders this set on every route now, so the set lives here for the
 * same reason SITE_TRUST_LINKS does.
 *
 * "/" is the scan workbench and leads: it is what the product does. The rest
 * order from the evidence a reader browses to the definitions behind it.
 */
export const SITE_PRIMARY_NAV: readonly SiteNavLink[] = [
  { href: "/", label: "Scan" },
  { href: "/directory/", label: "Directory" },
  { href: "/catalog/", label: "Catalog" },
  { href: "/methodology/", label: "Methodology" },
  { href: "/glossary/", label: "Glossary" }
];

export const SITE_TRUST_LINKS: readonly SiteNavLink[] = [
  { href: "/about/", label: "About" },
  { href: "/glossary/", label: "Glossary" },
  { href: "/status/", label: "Status" },
  { href: "/catalog/", label: "Catalog" },
  { href: "/methodology/", label: "Methodology" },
  { href: "/privacy/", label: "Privacy" },
  { href: "/security/", label: "Security" },
  { href: "/corrections/", label: "Corrections" }
];

export const SOURCE_REPOSITORY_URL = "https://github.com/iAnonymous3000/site-behavior-lab";
