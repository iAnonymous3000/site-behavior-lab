/**
 * The report's display timestamp in words, in UTC: "Oct 19, 2026, 3:02 PM UTC".
 * The receipt states each visit's start with the same formatter.
 *
 * In a module of its own, with no imports, because two kinds of caller need
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
