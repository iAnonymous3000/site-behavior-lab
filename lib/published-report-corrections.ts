import ledgerWire from "../public/corrections.json";
import { parseCorrectionsLedger, reportCorrections } from "./corrections-ledger-model";

const ledger = parseCorrectionsLedger(ledgerWire);
const ids = new Set(ledger.entries.flatMap(event => [...event.reportIds, ...(event.replacementReportIds ?? [])]));
const contexts = new Map([...ids].map(id => [id, reportCorrections(ledger, id)]));
const noCorrections = reportCorrections(ledger, "");

/** One correction lookup for browser, server, index and export consumers. */
export function publishedReportCorrections(reportId?: string | null) {
  return contexts.get(reportId ?? "") ?? noCorrections;
}
