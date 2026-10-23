import type { ReportFacts } from "./report-facts";
import { scanScrollCheckHref } from "./scan-prefill";
import type { ReportView } from "./scan-report-views";
import { SCROLL_CHECK_ENTRY } from "./scroll-check-copy";

/** A fresh result's "Check after scrolling" link and the sentence beside it. */
export type ScrollCheckEntry = {
  href: string;
  label: string;
  sentence: string;
};

/**
 * The one minter of the entry. Only a fresh result offers it, by the
 * freshness and page rule the Blocker follow-up and Inspect this connection
 * use: the caller hands over the page and share its board's other follow-ups
 * name (reportNewVisitTarget and reportNewVisitFrom of the same view and
 * freshness: a runtime share, the page gate G4 admits), and the minter adds
 * a visit that established that page (gate G3) and a scanner whose results
 * carry revision 2, since only those can carry a check. Never a committed
 * report, a file opened from disk, an archive comparison or paper. The link
 * names the result's own share, so the check's result can link back.
 */
export function scrollCheckEntry(input: {
  view: ReportView;
  facts: ReportFacts;
  /** reportNewVisitTarget(view, fresh): null unless the result is fresh. */
  newVisitTarget: string | null;
  /** reportNewVisitFrom(view, fresh): the share the link names, if any. */
  newVisitFrom: string | null;
  basePath: string;
}): ScrollCheckEntry | null {
  if (input.newVisitTarget === null) return null;
  if (input.view.origin !== "v2" || input.view.revision !== 2) return null;
  if (!input.facts.display.subject.describesSubject) return null;
  const href = scanScrollCheckHref(input.newVisitTarget, input.newVisitFrom);
  if (href === null) return null;
  return { href: `${input.basePath}${href}`, label: SCROLL_CHECK_ENTRY.label, sentence: SCROLL_CHECK_ENTRY.sentence };
}
