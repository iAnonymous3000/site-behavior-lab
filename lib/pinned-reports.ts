import { readFileSync } from "node:fs";
import path from "node:path";
import { readStoredScanReport, type StoredScanReport } from "./scan-report-reader";
import { toReportView, type ReportView } from "./scan-report-views";

/**
 * Published reports that tests read by id. Every featured refresh prunes old
 * reports from public/reports under the ordinary retention policy, so a test
 * that pins one report's wire shape reads a byte-exact copy frozen under
 * test-fixtures/reports (`git show origin/main:public/reports/<id>.json`),
 * never the live corpus. A report the corrections ledger pins is the one
 * exception: retention exempts it absolutely, so a test may read it where it
 * is published. lib/pinned-reports.test.ts fails any other read of
 * public/reports by a literal id.
 */

/** A frozen report's exact published bytes. */
export function frozenReportWire(id: string): string {
  return readFileSync(path.join(process.cwd(), "test-fixtures", "reports", `${id}.json`), "utf8");
}

/** The provenance sidecar frozen beside a report, for a test that reads it. */
export function frozenReportProvenance(id: string): string {
  return readFileSync(path.join(process.cwd(), "test-fixtures", "reports", `${id}.provenance.json`), "utf8");
}

export function frozenReportView(id: string): ReportView {
  return toReportView(storedReport(frozenReportWire(id), id));
}

/** A report the corrections ledger pins against retention, read where it is published. */
export function ledgerPinnedReportWire(id: string): string {
  return readFileSync(path.join(process.cwd(), "public", "reports", `${id}.json`), "utf8");
}

export function ledgerPinnedReportView(id: string): ReportView {
  return toReportView(storedReport(ledgerPinnedReportWire(id), id));
}

export function storedReport(wire: string, id: string): StoredScanReport {
  const read = readStoredScanReport(JSON.parse(wire));
  if (!read.ok) throw new Error(`reader rejected report ${id}: ${read.error}`);
  return read.stored;
}
