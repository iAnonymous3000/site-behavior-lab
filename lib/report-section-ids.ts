/**
 * The report's section anchors, in the order the screen shows them.
 *
 * One list for the section nav (which builds its links from it) and for the
 * saved report page (which opens the evidence explorer when a copied or
 * reloaded link names a section only the explorer renders). Kept free of any
 * report-reading import, so the saved report page's client entry can hold it.
 */
export const REPORT_SECTION_IDS = [
  "findings",
  "comparison",
  "numbers",
  "traffic",
  "visit-phases",
  "domain-evidence",
  "request-evidence",
  "third-parties",
  "cookies",
  "storage",
  "signals",
  "pixels",
  "causal-map",
  "measurement-limits",
  "conditions"
] as const;

export type ReportSectionId = (typeof REPORT_SECTION_IDS)[number];

/**
 * Sections the saved report's server summary renders itself, so a link to one
 * already lands before the explorer exists and must not open it.
 */
export const SUMMARY_SECTION_IDS: ReadonlySet<ReportSectionId> = new Set(["findings"]);

/** The explorer-only section a fragment such as `#cookies` names, or null. */
export function explorerSectionForHash(hash: string): ReportSectionId | null {
  const id = hash.startsWith("#") ? hash.slice(1) : hash;
  const section = REPORT_SECTION_IDS.find((candidate) => candidate === id);
  return section && !SUMMARY_SECTION_IDS.has(section) ? section : null;
}
