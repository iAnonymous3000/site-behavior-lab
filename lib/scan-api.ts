import { randomBytes } from "node:crypto";
import {
  acquireScanSlot,
  assertRateLimit,
  QUEUE_TIMEOUT_MS
} from "./scan-limits";
import { PublicScanError } from "./public-errors";
import { redactScanReportV1 } from "./redact-scan-report-v1";
import {
  createConsentComparisonReport,
  createGpcComparisonReport,
  createShieldsComparisonReport,
  type ComparisonExecutedFirst
} from "./compare-reports";
import { assertReportStoreAvailable, saveScanReport } from "./report-store";
import {
  emitShadowComparisonScanReportV2R2,
  emitShadowScanReportV2R2,
  v2ShadowEmissionEnabled
} from "./scan-report-v2-emission";
import {
  buildRuntimeComparisonScanReportV2R2,
  buildRuntimeScanReportV2R2
} from "./scan-report-v2-runtime-builder";
import {
  requireRuntimeScanReportMode,
  type RuntimeReportSaver,
  type RuntimeScanReport
} from "./runtime-scan-report";
import { scanSite, type ScanSiteOptions } from "./scanner";
import type { ConsentMode, ScanDevice, ScanReport, ScanRequestPayload, ScanResult } from "./types";
import { prepareScanRequest, type PreparedScanRequest } from "./scan-gate";

export { prepareScanRequest, ScanGate, scanRateLimitCost, type PreparedScanRequest } from "./scan-gate";

export type ScanRunner = (payload: ScanRequestPayload, options?: ScanSiteOptions) => Promise<ScanResult>;
export type ReportSaver = RuntimeReportSaver;

export type ScanExecutionControl = {
  signal?: AbortSignal;
  /**
   * Publication boundary. The callback is invoked synchronously, then awaited,
   * before the report saver starts. Local job controllers therefore set their
   * in-process publication fence before returning a promise, while a durable
   * controller can additionally negotiate its fenced publishing transition.
   */
  beforeSave?: (report: RuntimeScanReport) => void | Promise<void>;
  /** Deterministic counterbalancing draw for tests; production draws randomly. */
  drawComparisonFirstArm?: () => ComparisonExecutedFirst;
  /**
   * Schedule diagnostic work after the public report publication attempt. The primary
   * result and scan slot never await this work. Tests may inject a collector.
   */
  schedulePostPublication?: (task: () => Promise<unknown>) => void | Promise<unknown>;
};

const SHARE_SAVE_WARNING = "Shareable report could not be saved on this host; JSON export is still available.";

export async function runScanRequest(
  request: Request,
  scan: ScanRunner = scanSite,
  saveReport: ReportSaver = saveScanReport
): Promise<RuntimeScanReport> {
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
): Promise<RuntimeScanReport> {
  // Resolve before consuming a Chromium slot or scan quota. An explicitly
  // requested but unready r2 producer must refuse the scan, never emit v1.
  const reportMode = requireRuntimeScanReportModeForSaver(saveReport);
  const releaseScanSlot = await acquireScanSlot(queueTimeoutMs, control.signal);
  try {
    throwIfCancelled(control.signal);
    // Async jobs charge the rate limit at enqueue time, so they opt out here to
    // avoid double counting; the synchronous path charges after taking a slot.
    if (chargeRateLimit) {
      assertRateLimit(prepared.clientKey, Date.now(), prepared.rateLimitCost);
    }

    if (prepared.compareGpc) {
      const executedFirst = (control.drawComparisonFirstArm ?? drawComparisonFirstArm)();
      const { baseline, variant } = await runComparisonArms(
        executedFirst,
        {
          baseline: () =>
            scan(createScanPayload(prepared.url, prepared.device, false), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            }),
          variant: () =>
            scan(createScanPayload(prepared.url, prepared.device, true), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            })
        },
        control.signal
      );
      if (reportMode === "r2") {
        return saveRuntimeR2Report(
          buildRuntimeComparisonScanReportV2R2(baseline, variant, executedFirst, "public-api"),
          saveReport,
          control,
          () => emitShadowComparisonScanReportV2R2(baseline, variant, executedFirst, "public-api")
        );
      }
      const report = createGpcComparisonReport(baseline, variant, { executedFirst });
      const saved = await saveScanReportBestEffort(report, saveReport, control);
      scheduleShadowEmission(control, () =>
        emitShadowComparisonScanReportV2R2(baseline, variant, executedFirst, "public-api")
      );
      return saved;
    }

    if (prepared.compareShields) {
      const executedFirst = (control.drawComparisonFirstArm ?? drawComparisonFirstArm)();
      const { baseline, variant } = await runComparisonArms(
        executedFirst,
        {
          baseline: () =>
            scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            }),
          variant: () =>
            scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
              publicUrlAlreadyVerified: true,
              shieldsBlockingEnabled: true,
              signal: control.signal
            })
        },
        control.signal
      );
      if (reportMode === "r2") {
        return saveRuntimeR2Report(
          buildRuntimeComparisonScanReportV2R2(baseline, variant, executedFirst, "public-api"),
          saveReport,
          control,
          () => emitShadowComparisonScanReportV2R2(baseline, variant, executedFirst, "public-api")
        );
      }
      const report = createShieldsComparisonReport(baseline, variant, { executedFirst });
      const saved = await saveScanReportBestEffort(report, saveReport, control);
      scheduleShadowEmission(control, () =>
        emitShadowComparisonScanReportV2R2(baseline, variant, executedFirst, "public-api")
      );
      return saved;
    }

    if (prepared.compareConsent) {
      const executedFirst = (control.drawComparisonFirstArm ?? drawComparisonFirstArm)();
      const { baseline: acceptRun, variant: rejectRun } = await runComparisonArms(
        executedFirst,
        {
          baseline: () =>
            scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled, "accept-all"), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            }),
          variant: () =>
            scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled, "reject-all"), {
              publicUrlAlreadyVerified: true,
              signal: control.signal
            })
        },
        control.signal
      );
      if (reportMode === "r2") {
        return saveRuntimeR2Report(
          buildRuntimeComparisonScanReportV2R2(acceptRun, rejectRun, executedFirst, "public-api"),
          saveReport,
          control,
          () => emitShadowComparisonScanReportV2R2(acceptRun, rejectRun, executedFirst, "public-api")
        );
      }
      const report = createConsentComparisonReport(acceptRun, rejectRun, { executedFirst });
      const saved = await saveScanReportBestEffort(report, saveReport, control);
      scheduleShadowEmission(control, () =>
        emitShadowComparisonScanReportV2R2(acceptRun, rejectRun, executedFirst, "public-api")
      );
      return saved;
    }

    const result = await scan(createScanPayload(prepared.url, prepared.device, prepared.gpcEnabled), {
      publicUrlAlreadyVerified: true,
      signal: control.signal
    });
    if (reportMode === "r2") {
      return saveRuntimeR2Report(
        buildRuntimeScanReportV2R2(result, "public-api"),
        saveReport,
        control,
        () => emitShadowScanReportV2R2(result, "public-api")
      );
    }
    const saved = await saveScanReportBestEffort(result, saveReport, control);
    scheduleShadowEmission(control, () => emitShadowScanReportV2R2(result, "public-api"));
    return saved;
  } finally {
    releaseScanSlot();
  }
}

/**
 * Public r2 requires persistence. When production's canonical saver is in use,
 * reject a broken backend before quota, queue, or Chromium work. Injected test
 * savers remain independent of deployment storage configuration.
 */
export function requireRuntimeScanReportModeForSaver(saveReport: ReportSaver): "v1" | "r2" {
  const reportMode = requireRuntimeScanReportMode();
  if (reportMode === "r2" && saveReport === saveScanReport) {
    try {
      assertReportStoreAvailable();
    } catch {
      throw new PublicScanError("Public r2 report persistence is unavailable.", 503);
    }
  }
  return reportMode;
}

/**
 * Shadow evidence is deliberately outside the scan's completion contract. A
 * stalled R2/S3 transport must not withhold the public response, leave an async job
 * running, or consume a scarce Chromium slot. The task owns its own diagnostic
 * logging; this outer guard covers only an unexpected scheduler failure.
 */
function scheduleShadowEmission(
  control: ScanExecutionControl,
  task: () => Promise<unknown>
): void {
  if (!v2ShadowEmissionEnabled()) return;
  try {
    const scheduled = (control.schedulePostPublication ?? scheduleAfterResponseTurn)(task);
    if (scheduled && typeof (scheduled as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(scheduled).catch(() => {
        console.warn("Unexpected v2 shadow scheduler failure.");
      });
    }
  } catch {
    console.warn("Unexpected v2 shadow scheduler failure.");
  }
}

function scheduleAfterResponseTurn(task: () => Promise<unknown>): void {
  setImmediate(() => {
    void task().catch(() => {
      console.warn("Unexpected v2 shadow task failure.");
    });
  });
}

/**
 * Fair order draw (RFC 4.3): which arm of a comparison visits the site first.
 * A fixed baseline-then-variant order would let time-ordered site behavior
 * (cache warming, ad rotation, bot-score escalation) load systematically onto
 * one arm; randomizing the order turns that bias into noise across the corpus.
 * One pair is randomized, not counterbalanced; counterbalancing requires
 * independent AB and BA pairs. The executed order is disclosed on the report.
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
  await control.beforeSave?.(report);
  // The callback is invoked before the await yields. Local controllers set
  // their publication fence synchronously; durable controllers await the
  // coordinator's fenced publishing transition before persistence begins.
  throwIfCancelled(control.signal);
  try {
    const saved = await saveReport(report);
    throwIfCancelled(control.signal);
    return saved;
  } catch (error) {
    throwIfCancelled(control.signal);
    console.warn("Failed to save shareable scan report.", error);
    return appendWarning(redactScanReportV1(report).report, SHARE_SAVE_WARNING);
  }
}

/**
 * r2 has no post-builder free-form warning seam. A persistence failure must
 * therefore propagate instead of mutating a validator-clean report after its
 * redaction and semantic gates have run.
 */
async function saveScanReportRequired<T extends RuntimeScanReport>(
  report: T,
  saveReport: ReportSaver,
  control: ScanExecutionControl
): Promise<T> {
  throwIfCancelled(control.signal);
  await control.beforeSave?.(report);
  throwIfCancelled(control.signal);
  const saved = await saveReport(report);
  throwIfCancelled(control.signal);
  return saved;
}

async function saveRuntimeR2Report<T extends RuntimeScanReport>(
  report: T,
  saveReport: ReportSaver,
  control: ScanExecutionControl,
  shadowTask: () => Promise<unknown>
): Promise<T> {
  const saved = await saveScanReportRequired(report, saveReport, control);
  // Public r2 and private shadow emission are independent rollout controls.
  // When both are enabled, keep the operator artifact best-effort and off the
  // response/Chromium critical path exactly as it is for a v1 response.
  scheduleShadowEmission(control, shadowTask);
  return saved;
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
