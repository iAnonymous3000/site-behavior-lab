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
