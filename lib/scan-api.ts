import {
  acquireScanSlot,
  assertRateLimit,
  QUEUE_TIMEOUT_MS
} from "./scan-limits";
import { createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { saveScanReport } from "./report-store";
import { scanSite, type ScanSiteOptions } from "./scanner";
import type { ScanDevice, ScanReport, ScanRequestPayload, ScanResult } from "./types";
import { prepareScanRequest, type PreparedScanRequest } from "./scan-gate";

export { prepareScanRequest, ScanGate, scanRateLimitCost, type PreparedScanRequest } from "./scan-gate";

export type ScanRunner = (payload: ScanRequestPayload, options?: ScanSiteOptions) => Promise<ScanResult>;
export type ReportSaver = <T extends ScanReport>(report: T) => Promise<T>;

const SHARE_SAVE_WARNING = "Shareable report could not be saved on this host; JSON export is still available.";

export async function runScanRequest(
  request: Request,
  scan: ScanRunner = scanSite,
  saveReport: ReportSaver = saveScanReport
): Promise<ScanReport> {
  const prepared = await prepareScanRequest(request);
  return executePreparedScan(prepared, scan, saveReport);
}

export async function executePreparedScan(
  prepared: PreparedScanRequest,
  scan: ScanRunner = scanSite,
  saveReport: ReportSaver = saveScanReport,
  queueTimeoutMs = QUEUE_TIMEOUT_MS,
  chargeRateLimit = true
): Promise<ScanReport> {
  const releaseScanSlot = await acquireScanSlot(queueTimeoutMs);
  try {
    // Async jobs charge the rate limit at enqueue time, so they opt out here to
    // avoid double counting; the synchronous path charges after taking a slot.
    if (chargeRateLimit) {
      assertRateLimit(prepared.clientKey, Date.now(), prepared.rateLimitCost);
    }

    if (prepared.compareGpc) {
      const baseline = await scan(createScanPayload(prepared.url, prepared.device, false), {
        publicUrlAlreadyVerified: true
      });
      const variant = await scan(createScanPayload(prepared.url, prepared.device, true), {
        publicUrlAlreadyVerified: true
      });
      return await saveScanReportBestEffort(createGpcComparisonReport(baseline, variant), saveReport);
    }

    if (prepared.compareShields) {
      const baseline = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
        publicUrlAlreadyVerified: true
      });
      const variant = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
        publicUrlAlreadyVerified: true,
        shieldsBlockingEnabled: true
      });
      return await saveScanReportBestEffort(createShieldsComparisonReport(baseline, variant), saveReport);
    }

    const result = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
      publicUrlAlreadyVerified: true
    });
    return await saveScanReportBestEffort(result, saveReport);
  } finally {
    releaseScanSlot();
  }
}

function createScanPayload(url: string, device: ScanDevice, gpcEnabled: boolean): ScanRequestPayload {
  return {
    url,
    device,
    gpcEnabled,
    consentMode: "observe"
  };
}

async function saveScanReportBestEffort<T extends ScanReport>(report: T, saveReport: ReportSaver): Promise<T> {
  try {
    return await saveReport(report);
  } catch (error) {
    console.warn("Failed to save shareable scan report.", error);
    return appendWarning(report, SHARE_SAVE_WARNING);
  }
}

function appendWarning<T extends ScanReport>(report: T, warning: string): T {
  return {
    ...report,
    warnings: [...report.warnings, warning]
  };
}
