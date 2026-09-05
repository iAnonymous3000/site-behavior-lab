import type { NetworkRequestRecord } from "./types";
import { requestEvidenceState, type RunView } from "./scan-report-views";
import { displayHost, displayPublicUrl } from "./text-format";
import type { CorrectionsLedgerEvent } from "./corrections-ledger-model";

/**
 * Request-log CSV export, shared by the report UI.
 *
 * Pure and dependency-light so it can be unit-tested directly instead of being
 * trapped in the React component file.
 */

const CSV_HEADER = [
  "id",
  "domain",
  "method",
  "resource_type",
  "status",
  "third_party",
  "tracker_entity",
  "tracker_category",
  "url",
  "recording_state"
] as const;

/**
 * Whether the exported log is a complete recording, in the same precedence the
 * report's structured data uses for its quality property: a failed visit first,
 * then the exact request-recording cap, then any other request-family capture
 * loss. Anything but "complete" means the rows are a truncated lower bound.
 */
export type RequestLogRecordingState = "complete" | "capped" | "incomplete" | "failed";

export function requestLogRecordingState(run: RunView): RequestLogRecordingState {
  if (run.quality.outcome === "failed") return "failed";
  return requestEvidenceState(run);
}

/**
 * The state travels on every row as a constant column rather than as a comment
 * or a filename suffix: the file is what a researcher keeps and cites once it
 * leaves the page, parsers expect header plus rows, and a downloaded capped
 * log of exactly 1,000 rows otherwise reads as a complete recording.
 */
export function requestLogToCsv(requests: NetworkRequestRecord[], recordingState: RequestLogRecordingState, corrections: readonly CorrectionsLedgerEvent[] = []): string {
  const current = corrections.at(-1);
  const correctionCells = current ? [
    corrections.map(event => event.eventId).join(" "), current.state,
    corrections.map(event => `${event.eventId}: ${event.summary}`).join(" "),
    [...new Set(corrections.map(event => event.detailsUrl))].join(" ")
  ] : [];
  const rows = requests.map((request) => [
    request.id,
    displayHost(request.domain),
    request.method,
    request.resourceType,
    request.status ?? "",
    request.thirdParty ? "yes" : "no",
    request.tracker?.entity ?? "",
    request.tracker?.category ?? "",
    displayPublicUrl(request.url),
    recordingState,
    ...correctionCells
  ]);
  const header = current ? [...CSV_HEADER, "correction_event", "correction_state", "correction_summary", "correction_url"] : CSV_HEADER;
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}

export function csvCell(value: string | number): string {
  let text = String(value);
  // Neutralize spreadsheet formula injection (CWE-1236). The scanned site
  // controls its own request URLs and domains, so a cell like "=cmd|'/c ...'!A1"
  // or "@SUM(...)" would execute as a formula when the exported CSV is opened in
  // Excel/Sheets. Prefix a cell whose first character can start a formula with an
  // apostrophe so spreadsheet apps treat the whole value as text. Numbers are
  // exempt: a program-generated number's leading "-" is a sign, not page
  // content, and prefixing it would break numeric parsing of signed columns
  // (delta and Shields-change fields) in R/pandas.
  if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  // RFC 4180 quoting for separators, quotes, and newlines.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
