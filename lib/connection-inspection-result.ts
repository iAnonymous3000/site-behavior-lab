import type { ConnectionInspectionEvidence } from "./connection-inspection-evidence";
import type { LoadedReport } from "./scan-report-view";

/**
 * The inspection a result shows: the evidence its own shell carries, for the
 * address the scan that produced it asked about, and the result that scan's
 * link came from. Type-only imports, so the homepage's hook can use it
 * without the report reader: the shell was validated by that reader, closed
 * evidence shape included, before it reached the hook.
 */
export type ShownConnectionInspection = {
  evidence: ConnectionInspectionEvidence;
  from: string | null;
};

/**
 * The evidence a live result carries for the inspection its scan asked
 * about, or null. Null for a scan that asked about none, for a result with no
 * evidence (an older scanner's), and for evidence about another address, so
 * a missing block never reads as a visit that made no request.
 */
export function shownConnectionInspection(
  result: LoadedReport,
  asked: { address: string; from: string | null } | null
): ShownConnectionInspection | null {
  if (asked === null || result.source !== "v2-r2-ephemeral" || result.wire.reportType !== "single") return null;
  const evidence = result.wire.ephemeral.inspection;
  if (evidence === undefined || evidence.address !== asked.address) return null;
  return { evidence, from: asked.from };
}
