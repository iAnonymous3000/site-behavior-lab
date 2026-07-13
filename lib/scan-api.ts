import { randomBytes } from "node:crypto";
import {
  acquireScanSlot,
  assertRateLimit,
  QUEUE_TIMEOUT_MS
} from "./scan-limits";
import {
  createConsentComparisonReport,
  createGpcComparisonReport,
  createShieldsComparisonReport,
  type ComparisonExecutedFirst
} from "./compare-reports";
import { saveScanReport } from "./report-store";
import { emitShadowScanReportV2R2, v2ShadowEmissionEnabled } from "./scan-report-v2-emission";
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
  /** Deterministic counterbalancing draw for tests; production draws randomly. */
  drawComparisonFirstArm?: () => ComparisonExecutedFirst;
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

    // Kernel step 4 (flag-gated): each completed visit additionally emits a
    // shadow v2/r2 report operator-side; v1 remains the only public wire and
    // an emission failure is a logged diagnostic, never a failed scan.
    const runVisit: ScanRunner = !v2ShadowEmissionEnabled()
      ? scan
      : async (visitPayload, visitOptions) => {
          const result = await scan(visitPayload, visitOptions);
          await emitShadowScanReportV2R2(result, "public-api");
          return result;
        };

    if (prepared.compareGpc) {
      const executedFirst = (control.drawComparisonFirstArm ?? drawComparisonFirstArm)();
      const { baseline, variant } = await runComparisonArms(
        executedFirst,
        {
          baseline: () =>
            runVisit(createScanPayload(prepared.url, prepared.device, false), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            }),
          variant: () =>
            runVisit(createScanPayload(prepared.url, prepared.device, true), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            })
        },
        control.signal
      );
      return await saveScanReportBestEffort(createGpcComparisonReport(baseline, variant, { executedFirst }), saveReport, control);
    }

    if (prepared.compareShields) {
      const executedFirst = (control.drawComparisonFirstArm ?? drawComparisonFirstArm)();
      const { baseline, variant } = await runComparisonArms(
        executedFirst,
        {
          baseline: () =>
            runVisit(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            }),
          variant: () =>
            runVisit(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
              publicUrlAlreadyVerified: true,
              shieldsBlockingEnabled: true,
              signal: control.signal
            })
        },
        control.signal
      );
      return await saveScanReportBestEffort(createShieldsComparisonReport(baseline, variant, { executedFirst }), saveReport, control);
    }

    if (prepared.compareConsent) {
      const executedFirst = (control.drawComparisonFirstArm ?? drawComparisonFirstArm)();
      const { baseline: acceptRun, variant: rejectRun } = await runComparisonArms(
        executedFirst,
        {
          baseline: () =>
            runVisit(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled, "accept-all"), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            }),
          variant: () =>
            runVisit(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled, "reject-all"), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            })
        },
        control.signal
      );
      return await saveScanReportBestEffort(
        createConsentComparisonReport(acceptRun, rejectRun, { executedFirst }),
        saveReport,
        control
      );
    }

    const result = await runVisit(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
      publicUrlAlreadyVerified: true,
      signal: control.signal
    });
    return await saveScanReportBestEffort(result, saveReport, control);
  } finally {
    releaseScanSlot();
  }
}

/**
 * Fair counterbalancing draw (RFC 4.3): which arm of a comparison visits the
 * site first. A fixed baseline-then-variant order would let time-ordered
 * site behavior (cache warming, ad rotation, bot-score escalation) load
 * systematically onto one arm; randomizing the order turns that bias into
 * noise across the corpus. The executed order is disclosed on the report.
 */
function drawComparisonFirstArm(): ComparisonExecutedFirst {
  return randomBytes(1)[0] < 128 ? "baseline" : "variant";
}

/**
 * Run the two comparison arms sequentially in the drawn order. The
 * baseline/variant SEMANTICS (off/on, accept/reject) never change; only
 * which visit happens first does.
 */
async function runComparisonArms(
  executedFirst: ComparisonExecutedFirst,
  arms: { baseline: () => Promise<ScanResult>; variant: () => Promise<ScanResult> },
  signal?: AbortSignal
): Promise<{ baseline: ScanResult; variant: ScanResult }> {
  if (executedFirst === "baseline") {
    const baseline = await arms.baseline();
    throwIfCancelled(signal);
    return { baseline, variant: await arms.variant() };
  }
  const variant = await arms.variant();
  throwIfCancelled(signal);
  return { baseline: await arms.baseline(), variant };
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
