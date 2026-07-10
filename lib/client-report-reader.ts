import { readStoredScanReport } from "./scan-report-reader";
import type { ScanReport } from "./types";

/**
 * The client surfaces' seam onto the canonical version-aware reader (RFC
 * 14.8): uploads, saved-report pages, gallery loads, and poll results all
 * validate here, so a malformed payload (a `requests:[null]` entry, a
 * truncated download) is a typed refusal with a plain-language reason instead
 * of a crash in a renderer, and a newer-schema report is named as a
 * capability gap rather than "not a report".
 *
 * The result narrows to the legacy v1 wire type because that is the only
 * shape the current report renderer understands; when v2 rendering lands
 * (view-based, RFC 14.8 renderer slice), this helper is the one place that
 * changes.
 */
export type RenderableReportRead =
  | { ok: true; report: ScanReport }
  | { ok: false; message: string };

export function readRenderableReport(payload: unknown, subject = "This file"): RenderableReportRead {
  const read = readStoredScanReport(payload);

  if (!read.ok) {
    if (read.error === "unsupported-version" || read.error === "unsupported-revision") {
      return { ok: false, message: `${subject} was written by a newer scanner than this app understands; update to open it.` };
    }
    if (read.error === "inconsistent") {
      return { ok: false, message: `${subject} contains derived conclusions that do not match its recorded evidence.` };
    }
    return { ok: false, message: `${subject} is not a Site Behavior Lab report (or its data is damaged).` };
  }

  if (read.stored.schemaVersion !== 1) {
    return { ok: false, message: `${subject} uses the v2 report schema; this interface cannot render it yet.` };
  }

  return { ok: true, report: read.stored.report };
}
