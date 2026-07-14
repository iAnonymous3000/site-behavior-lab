"use client";

import { useMemo } from "react";
import type { LoadedReport } from "@/lib/scan-report-view";
import type { StoredScanReport } from "@/lib/scan-report-reader";
import { toReportView } from "@/lib/scan-report-views";
import { SiteBehaviorApp } from "../../site-behavior-app";

export function SavedReportClient({ id, stored }: { id: string; stored: StoredScanReport }) {
  // Send the validated wire across the RSC boundary once; the normalized view
  // is deterministic and rebuilt locally instead of serializing a duplicate
  // copy of every evidence row into the page payload.
  //
  // Deliberate three-line duplicate of loadedReportFromStored
  // (lib/scan-report-view.ts, pinned by its test): importing that module here
  // statically would pull the full validator seam into this page's first-load
  // bundle, which only the lazy client reader may do.
  const initialLoaded = useMemo((): LoadedReport => {
    const view = toReportView(stored);
    if (stored.schemaVersion === 1) return { source: "v1", wire: stored.report, view };
    if (stored.schemaRevision === 1) return { source: "v2-public", wire: stored.report, view };
    return { source: "v2-r2-public", wire: stored.report, view };
  }, [stored]);
  return <SiteBehaviorApp key={id} initialLoaded={initialLoaded} reportPage />;
}
