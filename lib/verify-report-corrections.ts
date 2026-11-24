import { reportCorrections, type CorrectionsLedgerEvent, type ParsedCorrectionsLedger } from "./corrections-ledger-model";

/**
 * The verifier's words for a report's published corrections, apart from the
 * CLI so they can be tested: the CLI runs as soon as it is loaded.
 *
 * Node-only: imported by lib/verify-published-report-cli.ts and its tests.
 */

/** The "This command does not prove:" item for the ledger copy the verifier read. */
export const LEDGER_CURRENCY_BOUNDARY =
  "that the corrections ledger in this working directory (public/corrections.json) is current.";

/**
 * The event the report page's notice names (currentSubjectEvent), so the
 * verifier and the page never answer differently. A report removed for
 * privacy has none here: it keeps the verifier's own removal line.
 */
export function publishedCorrection(ledger: ParsedCorrectionsLedger, reportId: string): CorrectionsLedgerEvent | null {
  const corrections = reportCorrections(ledger, reportId);
  if (corrections.subjectEvents.some((event) => event.state === "privacy-superseded")) return null;
  return corrections.currentSubjectEvent;
}

/** The line the verifier prints for that event, with its summary as published. */
export function publishedCorrectionLine(ledger: ParsedCorrectionsLedger, reportId: string): string | null {
  const event = publishedCorrection(ledger, reportId);
  if (event === null) return null;
  return event.state === "active"
    ? `This report has a reviewed clarification: ${event.eventId}. ${event.summary} Read the public review record: ${event.detailsUrl}.`
    : `This report was ${event.state}: ${event.eventId}. ${event.summary} Read the public review record: ${event.detailsUrl}. Matching bytes do not lift a published correction.`;
}
