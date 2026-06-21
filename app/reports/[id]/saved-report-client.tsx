"use client";

import { useEffect, useState } from "react";
import { committedReportLocation } from "@/lib/report-locator";
import { isScanReport } from "@/lib/report-validation";
import type { ScanReport } from "@/lib/types";
import { SiteBehaviorApp, clientReportRuntime } from "../../site-behavior-app";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; report: ScanReport }
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
        if (!isScanReport(payload)) {
          throw new Error("Report JSON is not a Site Behavior Lab report.");
        }

        setState({ status: "loaded", report: payload });
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
    return <SiteBehaviorApp key={id} initialResult={state.report} />;
  }

  if (state.status === "error") {
    return <SiteBehaviorApp key={`${id}:error`} initialError={state.message} />;
  }

  return <SiteBehaviorApp key={`${id}:loading`} initialLoading />;
}

function reportJsonPath(id: string): string {
  return committedReportLocation(id, clientReportRuntime()).dataUrl;
}
