import { loadCorpusOverview, type DirectoryEntry } from "./corpus-overview";
import { reportSiteProfilePath } from "./report-trust";
import type { ReportView } from "./scan-report-views";
import { siteProfilePath } from "./site-profile";
import { sitePagesBasePath } from "./site-url";

type SiteHistoryInput = {
  id: string;
  view: ReportView;
  /** Whether the report is in the committed public corpus, the only reports a history page lists. */
  committed: boolean;
};

/**
 * The cookie card's Look closer target (lib/finding-look-closer.ts): this
 * site's history page at its report table, `/sites/<key>/#history`, which
 * lists the third-party cookie count each retained report recorded.
 *
 * Only for a committed report that page lists beside at least one other
 * report, so the view's "other visits" are visits the page shows. A share or a
 * homepage result has no history, and a site with one retained report has no
 * other visit to show. The listing is the history page's own source
 * (loadCorpusOverview), matched by the profile path the report's "View site
 * history" action already links, never a second derivation of the site.
 */
export function siteHistoryLookCloserHrefFrom(
  entries: readonly Pick<DirectoryEntry, "id" | "siteKey">[],
  input: SiteHistoryInput
): string | null {
  const profilePath = reportSiteProfilePath(input.view, input.committed);
  if (!profilePath) return null;
  const listed = entries.filter(
    (entry) => entry.siteKey !== null && siteProfilePath(entry.siteKey) === profilePath
  );
  if (listed.length < 2 || !listed.some((entry) => entry.id === input.id)) return null;
  return `${sitePagesBasePath()}${profilePath}/#history`;
}

/** Server-only: reads the committed corpus, once per process, and only for a committed report. */
export async function siteHistoryLookCloserHref(input: SiteHistoryInput): Promise<string | null> {
  if (!reportSiteProfilePath(input.view, input.committed)) return null;
  return siteHistoryLookCloserHrefFrom((await loadCorpusOverview()).entries, input);
}
