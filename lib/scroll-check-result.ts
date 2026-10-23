import type { LoadedReport } from "./scan-report-view";
import type { ScrollCheckEvidence } from "./scroll-check-evidence";

/**
 * The check a result shows: the evidence its own shell carries, and the
 * result the check's link came from. Type-only imports, so the homepage's
 * hook can use it without the report reader: the shell was validated by that
 * reader, closed evidence shape included, before it reached the hook.
 */
export type ShownScrollCheck = {
  evidence: ScrollCheckEvidence;
  from: string | null;
};

/** Whether a result carries a check's evidence, which only a check visit's own result does. */
export function carriesScrollCheck(result: LoadedReport): boolean {
  return result.source === "v2-r2-ephemeral" && result.wire.reportType === "single" && result.wire.ephemeral.scrollCheck !== undefined;
}

/**
 * The evidence a live result carries for the check its scan asked for, or
 * null: for a scan that asked for none, and for a result with no evidence
 * (an older scanner's, which ran an ordinary scan), so a missing block never
 * reads as a check that found nothing.
 */
export function shownScrollCheck(result: LoadedReport, asked: { from: string | null } | null): ShownScrollCheck | null {
  if (asked === null || result.source !== "v2-r2-ephemeral" || result.wire.reportType !== "single") return null;
  const evidence = result.wire.ephemeral.scrollCheck;
  if (evidence === undefined) return null;
  return { evidence, from: asked.from };
}
