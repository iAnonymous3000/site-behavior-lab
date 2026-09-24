import { publishedReportCorrectionWire } from "./published-report-corrections";
import { sha256Hex } from "./sha256";

/**
 * The query that binds a saved page's PDF export to the evidence and correction
 * context that page shows. The renderer answers 409 on a mismatch
 * (app/api/reports/[id]/pdf/route.ts), so a staggered Pages/container deploy
 * refuses rather than exporting a measurement the reader is not looking at.
 *
 * One producer for the receipt and the evidence explorer's header. Server
 * consumers only: the header receives the finished string as a prop, so no
 * client bundle restates the digest contract or gains the ledger hash.
 */
export function reportPdfExportQuery(id: string, evidenceSha256?: string): string {
  const query = new URLSearchParams({ correctionsSha256: sha256Hex(publishedReportCorrectionWire(id)) });
  if (evidenceSha256) query.set("sha256", evidenceSha256);
  return query.toString();
}
