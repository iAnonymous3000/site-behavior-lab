import type { ReportView } from "./scan-report-views";

/**
 * Why a report cannot be exported as a complete document, or null when it can.
 *
 * The printable page and the PDF rendered from it both print a comparison's
 * two primary visits (`view.runs`) and tell the reader they carry the evidence
 * for every recorded visit. An r2 intervention report may also embed
 * supporting pairs (RFC 15.6): complete replication visits that neither
 * rendering prints. Rather than produce that document without them, both
 * refuse the shape, and the receipt and the evidence explorer hide the
 * controls that would request it. No committed report has supporting pairs and
 * the public scanner never records them, but the committed publisher accepts
 * them.
 *
 * Type-only imports: the explorer's header is client code and calls this too.
 */
export function completeDocumentExportRefusal(view: Pick<ReportView, "comparison">): string | null {
  const supportingPairs = view.comparison?.supportingPairs ?? 0;
  if (supportingPairs === 0) return null;
  return (
    `This report records ${supportingPairs} supporting visit pair${supportingPairs === 1 ? "" : "s"} ` +
    "that the printable version and PDF do not include, so neither is produced. " +
    "Its JSON contains every recorded visit."
  );
}
