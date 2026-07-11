import type { ScanReport } from "./types";

/**
 * The client surfaces' seam onto the canonical version-aware reader (RFC
 * 14.8): uploads, saved-report pages, gallery loads, and poll results all
 * validate here, so a malformed payload (a `requests:[null]` entry, a
 * truncated download) is a typed refusal with a plain-language reason instead
 * of a crash in a renderer, and a newer-schema report is named as a
 * capability gap rather than "not a report".
 *
 * The deep reader (validators for every schema generation) is LAZY-imported:
 * it is needed only when a report payload actually arrives (a scan finishes,
 * a file is opened, a saved report loads), so it must not sit in the
 * first-load client bundle of every page. The import promise is cached, so
 * the module loads once per session.
 *
 * The result narrows to the legacy v1 wire type because that is the only
 * shape the current report renderer understands; when v2 rendering lands
 * (view-based, RFC 14.8 renderer slice), this helper is the one place that
 * changes.
 */
export type RenderableReportRead =
  | { ok: true; report: ScanReport }
  | { ok: false; message: string };

type ReaderModule = typeof import("./scan-report-reader");

let readerModule: Promise<ReaderModule> | null = null;

function loadReader(): Promise<ReaderModule> {
  readerModule ??= import("./scan-report-reader");
  return readerModule;
}

export async function readRenderableReport(payload: unknown, subject = "This file"): Promise<RenderableReportRead> {
  const { readStoredScanReport } = await loadReader();
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
