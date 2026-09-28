import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseCorrectionsLedger,
  parsedCorrectionsLedgerPrivacyRemovedReportIds,
  parsedCorrectionsLedgerReportIds,
  type ParsedCorrectionsLedger
} from "./corrections-ledger-model";
import { readStoredScanReport, type StoredScanReport } from "./scan-report-reader";
import { toReportView, type ReportView } from "./scan-report-views";

/**
 * Published reports that tests read by id. Every featured refresh prunes old
 * reports from public/reports under the ordinary retention policy, so a test
 * that pins one report's wire shape reads a byte-exact copy frozen under
 * test-fixtures/reports (`git show origin/main:public/reports/<id>.json`),
 * never the live corpus. A report the corrections ledger pins is the one
 * exception: retention exempts it absolutely, so a test may read it where it
 * is published. A report the ledger removed for privacy is never frozen, since
 * the copy would put the removed bytes back in the repository; a test reads
 * the redacted replacement the ledger pairs with it. lib/pinned-reports.test.ts
 * fails any other read of public/reports by a literal id, and the
 * ledgerPinnedReport helpers refuse one when it runs.
 */

const FROZEN_READ_REMEDY = "freeze it under test-fixtures/reports and read it through lib/pinned-reports.ts";

/**
 * Why a test may not read report `id` where public/reports publishes it, as
 * the clause that follows "reads <id> from public/reports, ", or null when the
 * corrections ledger pins it there. Freezing is the remedy for retention
 * pruning only, so a privacy removal is named before the missing file it
 * leaves behind.
 */
export function publishedReadProblem(id: string, ledger: ParsedCorrectionsLedger, published: boolean): string | null {
  if (parsedCorrectionsLedgerPrivacyRemovedReportIds(ledger).has(id)) {
    // The parser pairs each removed original with one replacement by position,
    // pins the replacement, and refuses it as any later event's original.
    const event = ledger.entries.find((entry) => entry.state === "privacy-superseded" && entry.reportIds.includes(id));
    const replacement = event?.replacementReportIds?.[event.reportIds.indexOf(id)];
    return (
      `which ${event?.eventId} removed for privacy; read its replacement ${replacement} instead, ` +
      `which the ledger pins, and never freeze ${id} under test-fixtures/reports`
    );
  }
  if (!published) return `which no longer publishes it; ${FROZEN_READ_REMEDY}`;
  if (!parsedCorrectionsLedgerReportIds(ledger).has(id)) {
    return `where no corrections-ledger pin keeps it from retention; ${FROZEN_READ_REMEDY}`;
  }
  return null;
}

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

let publishedLedger: ParsedCorrectionsLedger | undefined;

/**
 * Where public/reports publishes a report the corrections ledger pins. Any
 * other id throws the remedy publishedReadProblem names, so every read through
 * these helpers is checked when it runs, whatever shape the guard resolves.
 */
function ledgerPinnedReportPath(id: string): string {
  const reportPath = path.join(process.cwd(), "public", "reports", `${id}.json`);
  publishedLedger ??= parseCorrectionsLedger(
    JSON.parse(readFileSync(path.join(process.cwd(), "public", "corrections.json"), "utf8"))
  );
  const problem = publishedReadProblem(id, publishedLedger, existsSync(reportPath));
  if (problem !== null) throw new Error(`a test reads ${id} from public/reports, ${problem}`);
  return reportPath;
}

/** A report the corrections ledger pins against retention, read where it is published. */
export function ledgerPinnedReportWire(id: string): string {
  return readFileSync(ledgerPinnedReportPath(id), "utf8");
}

export function ledgerPinnedReportView(id: string): ReportView {
  return toReportView(storedReport(ledgerPinnedReportWire(id), id));
}

export function storedReport(wire: string, id: string): StoredScanReport {
  const read = readStoredScanReport(JSON.parse(wire));
  if (!read.ok) throw new Error(`reader rejected report ${id}: ${read.error}`);
  return read.stored;
}
