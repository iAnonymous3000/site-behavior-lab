import { siteProfileKey } from "./site-profile";

/** The corpus and public history pages share one PSL-aware site identity. */
export function corpusSiteDomainKey(value: string): string {
  return siteProfileKey(value) ?? "";
}

const GENERALIZED_LABEL = "{label}";

/** The run fields the site identity is derived from; a RunView satisfies it. */
export type SiteKeySubject = {
  /** Observed (final) host, or on v2 the observed registrable domain. */
  domain: string;
  conditions: {
    /** The URL the visit was asked for; on v2 the requested origin plus route shape. */
    requestedUrl: string;
  };
};

/**
 * The site a run's visit belongs to, or "" when it belongs to none. This is
 * the ONE derivation behind the stats builder, the directory, the categories,
 * the site history page and feed, the homepage, the export and the corpus site
 * counts; none of them re-derives identity from a display string.
 *
 * The visit is attributed by where it landed: the observed host's registrable
 * domain (`www.example.com` and `shop.example.com` are one site, and so is a
 * `{label}.example.com` redirect target, which is still that site answering
 * its own front door). What it was asked for decides whether it can be
 * attributed at all. A requested host carrying a `{label}` marker is an
 * unreviewed sub-property the publication generalized: the seed catalog
 * curates `ocw.mit.edu` beside `mit.edu` and `plato.stanford.edu` beside
 * `stanford.edu`, each pair publishes as `{label}.<apex>` beside `www.<apex>`,
 * and keying both to the apex let whichever scan landed later represent the
 * site on every surface. The reader cannot recover which property was
 * visited, so neither can this function: such a visit keys to no site,
 * neither the apex's nor one of its own.
 *
 * The observed host is used the same way on both wire generations, but a v2
 * run's `domain` is already the observed registrable domain, so the marker
 * can only be seen on the requested URL; that is why the rule reads it there.
 */
export function corpusSiteKeyForRun(run: SiteKeySubject): string {
  return requestedHostIsGeneralized(run.conditions.requestedUrl) ? "" : corpusSiteDomainKey(run.domain);
}

function requestedHostIsGeneralized(requestedUrl: string): boolean {
  // Read the authority textually: a marker host is not a hostname the URL
  // parser is guaranteed to keep verbatim, and a parse failure must not turn
  // into an attributed site.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(requestedUrl.trim())?.[1] ?? requestedUrl.trim();
  const host = authority.replace(/^[^@]*@/, "").replace(/:\d*$/, "").toLowerCase();
  return host.split(".").includes(GENERALIZED_LABEL);
}
