import { sha256Hex } from "./sha256";
import type { LoadedReport } from "./scan-report-view";
import { publicWireForExportOrPersistence } from "./scan-report-view";
import { shareForLoadedReport, readLoadedReport } from "./client-report-reader";
import { committedReportLocation, locateReport, type ReportRuntime } from "./report-locator";
import { fetchBytesResponseWithPolicy } from "./client-fetch-policy";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "./report-resource-limits";

/** Managed evidence keeps its exact bytes. Imports still cross the public projection boundary. */
export async function reportWireForDownload(loaded: LoadedReport, runtime: ReportRuntime): Promise<string> {
  const projection = publicWireForExportOrPersistence(loaded);
  const share = shareForLoadedReport(loaded);
  if (share && loaded.canonicalEvidence) {
    if (sha256Hex(loaded.canonicalEvidence.wire) !== loaded.canonicalEvidence.sha256) {
      throw new Error("The retained source bytes failed their integrity check. Reopen the saved report.");
    }
    return loaded.canonicalEvidence.wire;
  }
  if (!share) return JSON.stringify(projection, null, 2) + "\n";
  const source = share.jsonPath.startsWith("/api/")
    ? locateReport(share.id, runtime)
    : committedReportLocation(share.id, runtime);
  const { bytes } = await fetchBytesResponseWithPolicy(source.dataUrl, { cache: "no-store" }, {
    label: "Export source evidence", maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES
  });
  const wire = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const read = await readLoadedReport(JSON.parse(wire), "Export source evidence");
  if (!read.ok || JSON.stringify(publicWireForExportOrPersistence(read.loaded)) !== JSON.stringify(projection)) {
    throw new Error("The saved evidence does not match this open report. Reopen the saved report before exporting.");
  }
  // Only bytes fetched from a managed report location reach this return. An
  // imported object cannot supply a URL or smuggle unknown fields into it.
  return wire;
}
