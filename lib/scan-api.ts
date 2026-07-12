import {
  acquireScanSlot,
  assertRateLimit,
  QUEUE_TIMEOUT_MS
} from "./scan-limits";
import { createConsentComparisonReport, createGpcComparisonReport, createShieldsComparisonReport } from "./compare-reports";
import { saveScanReport } from "./report-store";
import { scanSite, type ScanSiteOptions } from "./scanner";
import type { ConsentMode, ScanDevice, ScanReport, ScanRequestPayload, ScanResult } from "./types";
import { prepareScanRequest, type PreparedScanRequest } from "./scan-gate";

export { prepareScanRequest, ScanGate, scanRateLimitCost, type PreparedScanRequest } from "./scan-gate";

export type ScanRunner = (payload: ScanRequestPayload, options?: ScanSiteOptions) => Promise<ScanResult>;
export type ReportSaver = <T extends ScanReport>(report: T) => Promise<T>;

export type ScanExecutionControl = {
  signal?: AbortSignal;
  /**
   * Synchronous publication boundary. Once this callback returns, the report
   * saver is invoked without another await, so a job controller can stop
   * accepting cancellation before any public write starts.
   */
  beforeSave?: () => void;
};

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
  chargeRateLimit = true,
  control: ScanExecutionControl = {}
): Promise<ScanReport> {
  const releaseScanSlot = await acquireScanSlot(queueTimeoutMs, control.signal);
  try {
    throwIfCancelled(control.signal);
    // Async jobs charge the rate limit at enqueue time, so they opt out here to
    // avoid double counting; the synchronous path charges after taking a slot.
    if (chargeRateLimit) {
      assertRateLimit(prepared.clientKey, Date.now(), prepared.rateLimitCost);
    }

    if (prepared.compareGpc) {
      const baseline = await scan(createScanPayload(prepared.url, prepared.device, false), {
        publicUrlAlreadyVerified: true,
        signal: control.signal
      });
      throwIfCancelled(control.signal);
      const variant = await scan(createScanPayload(prepared.url, prepared.device, true), {
        publicUrlAlreadyVerified: true,
        signal: control.signal
      });
      return await saveScanReportBestEffort(createGpcComparisonReport(baseline, variant), saveReport, control);
    }

    if (prepared.compareShields) {
      const baseline = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
        publicUrlAlreadyVerified: true,
        signal: control.signal
      });
      throwIfCancelled(control.signal);
      const variant = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
        publicUrlAlreadyVerified: true,
        shieldsBlockingEnabled: true,
        signal: control.signal
      });
      return await saveScanReportBestEffort(createShieldsComparisonReport(baseline, variant), saveReport, control);
    }

    if (prepared.compareConsent) {
      const acceptRun = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled, "accept-all"), {
        publicUrlAlreadyVerified: true,
        signal: control.signal
      });
      throwIfCancelled(control.signal);
      const rejectRun = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled, "reject-all"), {
        publicUrlAlreadyVerified: true,
        signal: control.signal
      });
      return await saveScanReportBestEffort(createConsentComparisonReport(acceptRun, rejectRun), saveReport, control);
    }

    const result = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
      publicUrlAlreadyVerified: true,
      signal: control.signal
    });
    return await saveScanReportBestEffort(result, saveReport, control);
  } finally {
    releaseScanSlot();
  }
}

function createScanPayload(url: string, device: ScanDevice, gpcEnabled: boolean, consentMode: ConsentMode = "observe"): ScanRequestPayload {
  return {
    url,
    device,
    gpcEnabled,
    consentMode
  };
}

async function saveScanReportBestEffort<T extends ScanReport>(
  report: T,
  saveReport: ReportSaver,
  control: ScanExecutionControl
): Promise<T> {
  throwIfCancelled(control.signal);
  control.beforeSave?.();
  // beforeSave is synchronous and the saver starts in this same turn. A
  // cancellation endpoint therefore cannot interleave after accepting a
  // cancellation but before publication begins.
  throwIfCancelled(control.signal);
  try {
    const saved = await saveReport(report);
    throwIfCancelled(control.signal);
    return saved;
  } catch (error) {
    throwIfCancelled(control.signal);
    console.warn("Failed to save shareable scan report.", error);
    return appendWarning(report, SHARE_SAVE_WARNING);
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The scan was cancelled.", "AbortError");
}

function appendWarning<T extends ScanReport>(report: T, warning: string): T {
  return {
    ...report,
    warnings: [...report.warnings, warning]
  };
}
