import type { LoadedReport } from "./scan-report-view";
import { withoutReportShare } from "./report-locator";

/**
 * The client surfaces' seam onto the canonical version-aware reader (RFC
 * 14.8): uploads, saved-report pages, gallery loads, sync scan results, and
 * poll results all validate here, so a malformed payload (a `requests:[null]`
 * entry, a truncated download) is a typed refusal with a plain-language
 * reason instead of a crash in a renderer, and a newer-schema report is named
 * as a capability gap rather than "not a report".
 *
 * The deep reader (validators and projectors for every schema generation) is
 * LAZY-imported: it is needed only when a report payload actually arrives (a
 * scan finishes, a file is opened, a saved report loads), so it must not sit
 * in the first-load client bundle of every page. The import promise is
 * cached, so the module loads once per session.
 *
 * The result is a {@link LoadedReport}: the original wire form plus the
 * version-independent view every renderer consumes (the atomic RFC 14.8
 * consumer migration; the old v1-only narrowing gate is gone, and the fixture
 * matrix pins that every readable generation loads here).
 */
export type LoadedReportRead =
  | { ok: true; loaded: LoadedReport }
  | { ok: false; message: string };

type ViewModule = typeof import("./scan-report-view");

let viewModule: Promise<ViewModule> | null = null;

function loadViewModule(): Promise<ViewModule> {
  viewModule ??= import("./scan-report-view");
  return viewModule;
}

export async function readLoadedReport(payload: unknown, subject = "This file"): Promise<LoadedReportRead> {
  const { readScanTransportPayload } = await loadViewModule();
  const result = readScanTransportPayload(payload);

  if (result.kind === "report") {
    return { ok: true, loaded: result.loaded };
  }
  if (result.kind === "api-error") {
    return { ok: false, message: result.message };
  }
  if (result.kind === "job-pending") {
    return { ok: false, message: `${subject} is a scan-job status record, not a finished report.` };
  }
  if (result.kind === "job-ended") {
    return { ok: false, message: result.message };
  }
  if (result.error === "unsupported-version" || result.error === "unsupported-revision") {
    return { ok: false, message: `${subject} was written by a newer scanner than this app understands; update to open it.` };
  }
  if (result.error === "inconsistent") {
    return { ok: false, message: `${subject} contains derived conclusions that do not match its recorded evidence.` };
  }
  return { ok: false, message: `${subject} is not a Site Behavior Lab report (or its data is damaged).` };
}

/**
 * Drop an imported report's untrusted/unservable share capability without
 * changing its evidence view. Ephemeral generations carry both a display wire
 * and a persistable public projection, so both copies must lose the share.
 */
export function withoutLoadedReportShare(loaded: LoadedReport): LoadedReport {
  if (loaded.source === "v1" || loaded.source === "v2-public" || loaded.source === "v2-r2-public") {
    return { ...loaded, wire: withoutReportShare(loaded.wire) } as LoadedReport;
  }
  return {
    ...loaded,
    wire: withoutReportShare(loaded.wire),
    public: withoutReportShare(loaded.public)
  } as LoadedReport;
}
