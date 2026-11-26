/**
 * Bounded client submission helper for Site Behavior Lab v3 live scans.
 *
 * Uses the shared bounded JSON fetch policy (`lib/client-fetch-policy.ts`) so
 * the homepage keeps strict byte caps, timeout guards, duplicate-key rejection,
 * and structured server error causes while dynamically loading the v3 schema
 * validator only after a scan succeeds (keeping the initial homepage JS small).
 */

import {
  CLIENT_FETCH_OPERATION_TIMEOUT_MS,
  ClientInvalidJsonError,
  fetchJsonResponseWithPolicy
} from "../client-fetch-policy";
import { isRecord } from "../guards";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "../report-resource-limits";
import { ScanRequestError } from "../scan-client-orchestration";
import { NO_USABLE_SCANNER_ANSWER, reachScanner, unreadableScannerAnswer } from "../scan-job-polling";
import { buildV3ScanBody, buildV3ScanHeaders } from "./client-urls";
import type { ComparisonAxisV3, ConsentModeV3, ScanDeviceV3, ScanRegionIdV3, ScanReportV3 } from "./schema";

export type V3LiveScanResult = {
  report: ScanReportV3;
  reportId: string;
  sharePath: string;
  apiPath: string;
  pdfPath: string;
};

export type V3RuntimeScanForm = {
  device: ScanDeviceV3;
  region: ScanRegionIdV3;
  gpcEnabled: boolean;
  compareGpc: boolean;
  compareShields: boolean;
  shieldsStrength: "standard" | "aggressive";
  compareConsent: boolean;
  accessKey: string;
};

export type V3RuntimeScanFetcher = (input: string, init: RequestInit) => Promise<Response>;

const SINGLE_V3_SCAN_DEADLINE_MS = 180_000;
const COMPARISON_V3_SCAN_DEADLINE_MS = 300_000;
const REQUEST_MAY_HAVE_ARRIVED = `${NO_USABLE_SCANNER_ANSWER} The request may or may not have been received.`;

export function buildV3ScanRequestPayload(input: {
  targetUrl: string;
  form: V3RuntimeScanForm;
  gpcComparisonEnabled: boolean;
  shieldsComparisonEnabled: boolean;
  consentComparisonEnabled: boolean;
  turnstileRequired: boolean;
  turnstileToken: string;
}): Record<string, unknown> {
  const compareGpc = input.gpcComparisonEnabled && input.form.compareGpc;
  const compareShields = !compareGpc && input.shieldsComparisonEnabled && input.form.compareShields;
  const compareConsent = !compareGpc && !compareShields && input.consentComparisonEnabled && input.form.compareConsent;

  const comparisons: ComparisonAxisV3[] = [];
  let gpcEnabled = input.form.gpcEnabled;
  let consentMode: ConsentModeV3 = "observe";

  if (compareGpc) {
    // Baseline runs without GPC so the comparison arm isolates Sec-GPC: 1.
    gpcEnabled = false;
    comparisons.push("gpc");
  } else if (compareShields) {
    comparisons.push(input.form.shieldsStrength === "aggressive" ? "shields-aggressive" : "shields-standard");
  } else if (compareConsent) {
    // Two-arm Accept All vs Reject All comparison.
    consentMode = "accept-all";
    comparisons.push("consent-reject");
  }

  return buildV3ScanBody({
    url: input.targetUrl,
    device: input.form.device,
    region: input.form.region,
    gpcEnabled,
    consentMode,
    comparisons,
    turnstileToken: input.turnstileRequired ? input.turnstileToken : undefined
  });
}

export async function submitV3RuntimeScan(options: {
  targetUrl: string;
  form: V3RuntimeScanForm;
  gpcComparisonEnabled: boolean;
  shieldsComparisonEnabled: boolean;
  consentComparisonEnabled: boolean;
  scannerRequiresAccessKey: boolean;
  turnstileRequired: boolean;
  turnstileToken: string;
  signal?: AbortSignal;
  resolveApiUrl: (path: string) => string;
  fetcher?: V3RuntimeScanFetcher;
  responseConnectTimeoutMs?: number;
  responseOperationTimeoutMs?: number;
}): Promise<V3LiveScanResult> {
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const body = buildV3ScanRequestPayload(options);
  const comparisons = Array.isArray(body.comparisons) ? body.comparisons : [];
  const connectTimeoutMs =
    options.responseConnectTimeoutMs ??
    (comparisons.length > 0 ? COMPARISON_V3_SCAN_DEADLINE_MS : SINGLE_V3_SCAN_DEADLINE_MS);
  const operationTimeoutMs =
    options.responseOperationTimeoutMs ?? connectTimeoutMs + CLIENT_FETCH_OPERATION_TIMEOUT_MS;

  const headers = buildV3ScanHeaders({
    turnstileToken: options.turnstileRequired ? options.turnstileToken : undefined,
    accessToken: options.scannerRequiresAccessKey ? options.form.accessKey : undefined
  });

  let status = 0;
  let payload: unknown = null;
  try {
    const result = await fetchJsonResponseWithPolicy(
      options.resolveApiUrl("/api/v3/scan"),
      {
        method: "POST",
        headers,
        signal: options.signal,
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer"
      },
      {
        label: "Scan response",
        maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,
        connectTimeoutMs,
        operationTimeoutMs,
        fetchImpl: reachScanner(fetcher, REQUEST_MAY_HAVE_ARRIVED) as typeof fetch,
        acceptResponse: (response) => {
          status = response.status;
          return true;
        }
      }
    );
    payload = result.payload;
  } catch (error) {
    if (error instanceof ClientInvalidJsonError && (status < 200 || status >= 300)) {
      throw new Error(unreadableScannerAnswer(status));
    }
    throw error;
  }

  if (isRecord(payload) && payload.ok === false && typeof payload.error === "string") {
    throw new ScanRequestError(payload.error, payload.cause, payload.retryAfterSeconds);
  }
  if (status < 200 || status >= 300) {
    throw new Error(unreadableScannerAnswer(status));
  }
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.report)) {
    throw new Error("The scanner returned an unexpected v3 scan response.");
  }

  const { validateScanReportV3 } = await import("./schema");
  const report = payload.report as ScanReportV3;
  const issues = validateScanReportV3(report);
  if (issues.length > 0) {
    throw new Error(`The scan report did not pass structural validation: ${issues[0]}`);
  }

  const reportId = typeof payload.reportId === "string" && payload.reportId ? payload.reportId : report.reportId;
  const sharePath =
    typeof payload.sharePath === "string" && payload.sharePath.startsWith("/")
      ? payload.sharePath
      : `/v3/reports/${reportId}`;
  const apiPath =
    typeof payload.apiPath === "string" && payload.apiPath.startsWith("/")
      ? payload.apiPath
      : `/api/v3/reports/${reportId}`;
  const pdfPath =
    typeof payload.pdfPath === "string" && payload.pdfPath.startsWith("/")
      ? payload.pdfPath
      : `/api/v3/reports/${reportId}/pdf`;

  return { report, reportId, sharePath, apiPath, pdfPath };
}
