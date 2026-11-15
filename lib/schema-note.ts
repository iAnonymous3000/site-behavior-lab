import { reportFormatChip, type ReportView } from "./scan-report-views";

/**
 * Where a report's format note is stated.
 *
 * A report reconstructed from the older format says so as a limit on the
 * whole report, beside the finding sentence, under the record's own "Schema"
 * label. Any other format note is a property of the record and stays a row
 * of it. One place per note, so a page states it once.
 */
export function schemaNotePlacement(view: ReportView): { limit: string | null; record: string | null } {
  const note = reportFormatChip(view);
  return view.origin === "legacy-derived" ? { limit: note, record: null } : { limit: null, record: note };
}

/** The record's label for the format note, which the note keeps wherever it is stated. */
export const SCHEMA_LABEL = "Schema";
