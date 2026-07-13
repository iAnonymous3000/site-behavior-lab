import type { DurableScanJobRegistration } from "./durable-scan-job-registry";

type RecoveryDependencies = {
  findRegistration: (jobId: string) => Promise<DurableScanJobRegistration | null>;
  fetchReport: (reportId: string) => Promise<Response>;
  onRegistryError?: (error: unknown) => void;
  onReportError?: (error: unknown) => void;
};

/**
 * Turn an in-memory 404 into an evidence-backed terminal answer when the edge
 * registry still knows the job. Only a genuine saved-report 404 can produce
 * `expired`; every probe/storage fault stays retryable and never fabricates a
 * terminal outcome.
 */
export async function recoverDurableScanJobResponse(
  jobId: string,
  missingJobResponse: Response,
  dependencies: RecoveryDependencies
): Promise<Response> {
  let registration: DurableScanJobRegistration | null;
  try {
    registration = await dependencies.findRegistration(jobId);
  } catch (error) {
    dependencies.onRegistryError?.(error);
    return missingJobResponse;
  }
  if (!registration) return missingJobResponse;

  let reportResponse: Response;
  try {
    reportResponse = await dependencies.fetchReport(registration.reportId);
  } catch (error) {
    dependencies.onReportError?.(error);
    return missingJobResponse;
  }

  if (reportResponse.status === 404) {
    return recoveryJson(
      {
        ok: true,
        jobId,
        status: "expired",
        error:
          "The scanner lost this job's in-memory status, and no saved report is available, so the job can no longer be recovered."
      },
      missingJobResponse
    );
  }
  if (!reportResponse.ok) {
    return reportResponse;
  }

  let report: unknown;
  try {
    report = await reportResponse.json();
  } catch {
    return recoveryJson(
      { ok: false, error: "The saved scan report could not be read during restart recovery." },
      missingJobResponse,
      502
    );
  }
  if (!report || typeof report !== "object" || (report as { ok?: unknown }).ok !== true) {
    return recoveryJson(
      { ok: false, error: "The saved scan report was invalid during restart recovery." },
      missingJobResponse,
      502
    );
  }

  return recoveryJson(
    {
      ok: true,
      jobId,
      status: "succeeded",
      progress: { phase: "saving", completedRuns: registration.totalRuns, totalRuns: registration.totalRuns },
      report
    },
    missingJobResponse
  );
}

function recoveryJson(payload: unknown, source: Response, status = 200): Response {
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(payload), { status, headers });
}
