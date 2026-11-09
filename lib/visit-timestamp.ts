import { isCanonicalTimestamp } from "./canonical-timestamp";

/**
 * The report's display timestamp in words, in UTC: "Oct 19, 2026, 3:02 PM UTC".
 * The receipt states each visit's start with the same formatter.
 *
 * In a module of its own, importing only the dependency-free canonical
 * timestamp rule, because two kinds of caller need
 * the one formatter: the server-rendered report page, and the client result
 * surface that shows an opened file, a live result or an archive comparison
 * with no report page around it. The visit summary the report pages build
 * is server only (lib/report-visit-summary.ts), so a client component cannot
 * reach a formatter kept there, and a second formatter is how two surfaces
 * come to print one visit's time two ways.
 */
export function formatReportTimestamp(value: string | null): string {
  if (!value) return "not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "not recorded"
    : date.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
        timeZoneName: "short"
      });
}

/**
 * A visit's start for the client result surface, or null when there is none
 * it may print.
 *
 * That surface shows files a reader opened, and a version 1 file may hold any
 * string where its scan time goes. Date reads far more than instants: "1" is
 * a moment in 2001, and "12/25/2026" is midnight in the reader's own time
 * zone, so the same file would print a different time for each reader. Only
 * a canonical ISO instant, the one form the scanner writes, names one moment
 * for everyone, so only that is formatted. The report pages format a value
 * their server has already validated and keep calling formatReportTimestamp.
 */
export function readableVisitStart(value: string | null): string | null {
  return isCanonicalTimestamp(value) ? formatReportTimestamp(value) : null;
}

/** What that surface says in place of a start it cannot print: none was recorded, or what was is not an instant. */
export function unshownVisitStart(value: string | null): string {
  return value ? "not recorded in a readable form" : "not recorded";
}
