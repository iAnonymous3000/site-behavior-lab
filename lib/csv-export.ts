import type { NetworkRequestRecord } from "./types";

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
  "url"
] as const;

export function requestLogToCsv(requests: NetworkRequestRecord[]): string {
  const rows = requests.map((request) => [
    request.id,
    request.domain,
    request.method,
    request.resourceType,
    request.status ?? "",
    request.thirdParty ? "yes" : "no",
    request.tracker?.entity ?? "",
    request.tracker?.category ?? "",
    request.url
  ]);
  return [CSV_HEADER, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n").concat("\r\n");
}

export function csvCell(value: string | number): string {
  let text = String(value);
  // Neutralize spreadsheet formula injection (CWE-1236). The scanned site
  // controls its own request URLs and domains, so a cell like "=cmd|'/c ...'!A1"
  // or "@SUM(...)" would execute as a formula when the exported CSV is opened in
  // Excel/Sheets. Prefix a cell whose first character can start a formula with an
  // apostrophe so spreadsheet apps treat the whole value as text.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  // RFC 4180 quoting for separators, quotes, and newlines.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
