"use client";

import { useEffect, useState } from "react";
import { readLoadedReport } from "@/lib/client-report-reader";
import { committedReportLocation } from "@/lib/report-locator";
import type { LoadedReport } from "@/lib/scan-report-view";
import { clientReportRuntime } from "../../client-runtime";
import { SiteBehaviorApp } from "../../site-behavior-app";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; loaded: LoadedReport }
  | { status: "error"; message: string };

export function SavedReportClient({ id }: { id: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function loadReport() {
      setState({ status: "loading" });

      try {
        const response = await fetch(reportJsonPath(id), {
          cache: "no-store",
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(response.status === 404 ? "Report not found." : "Report could not be loaded.");
        }

        const payload = (await response.json()) as unknown;
        const read = await readLoadedReport(payload, "This report");
        if (!read.ok) {
          throw new Error(read.message);
        }

        setState({ status: "loaded", loaded: read.loaded });
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Report could not be loaded."
        });
      }
    }

    void loadReport();
    return () => controller.abort();
  }, [id]);

  if (state.status === "loaded") {
    return <SiteBehaviorApp key={id} initialLoaded={state.loaded} />;
  }

  if (state.status === "error") {
    return <SiteBehaviorApp key={`${id}:error`} initialError={state.message} />;
  }

  return <SiteBehaviorApp key={`${id}:loading`} initialLoading />;
}

function reportJsonPath(id: string): string {
  return committedReportLocation(id, clientReportRuntime()).dataUrl;
}
