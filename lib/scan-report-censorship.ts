import { RESPONSE_BYTE_CAPTURE_LOSS_DETAIL } from "./capture-loss-detail-contract";
import { captureLossDetailNote } from "./capture-loss-presentation";
import type { CaptureLossEntry } from "./scan-report-v2";
import {
  runHitRequestRecordingCap,
  runUnsupportedEvidenceNotes,
  type ReportView,
  type RunView
} from "./scan-report-views";

/** Human phrasing for the recorded quality-reason vocabulary (RFC 5.3). */
const QUALITY_REASON_NOTES: Record<string, string> = {
  "budget-exhausted:request-cap": "the visit hit the scanner's request-recording cap, so its counts are truncated",
  "budget-exhausted:response-byte-cap":
    "the visit hit the scanner's total response-byte budget, so it stopped loading further content",
  "budget-exhausted:upload-byte-cap":
    "the visit hit the scanner's total request-byte budget, so it stopped forwarding further uploads",
  "budget-exhausted:proxy-traffic":
    "the visit hit the scan proxy's traffic budget, so it stopped forwarding further traffic",
  "capture-loss:fingerprint-observer":
    "the in-page fingerprint observer could not read every frame, so the fingerprinting evidence is incomplete",
  "capture-loss:pixel-decode":
    "one or more recognized advertising-pixel request bodies could not be read in full, so pixel event and advanced-matching detection are incomplete",
  "capture-loss:keystroke-probe":
    "the synthetic form-input probe did not finish, so late request evidence, counts, and input-capture detection may be incomplete",
  "capture-loss:gpc-worker":
    "the Worker instrumentation could not record every request, so the request evidence is incomplete",
  "capture-loss:invalid-upstream-response":
    "the scan proxy rejected one or more invalid upstream responses, so the request evidence is incomplete",
  "capture-loss:unsettled-routed-requests":
    "the scan deadline arrived while one or more requests were still being handled, so the request evidence is incomplete",
  "capture-loss:page-subject-validity":
    "the bounded page-content collector was unavailable or unreadable, so the scanner could not verify the rendered document"
};

const RESPONSE_BYTE_LIMIT_WARNING = /reaching the ([1-9][0-9,]* MiB) aggregate response-byte budget/;
const UPLOAD_BYTE_LIMIT_WARNING = /reaching the ([1-9][0-9,]* MiB) aggregate upload-byte budget/;
const REQUEST_RECORDING_LIMIT_WARNING = /stopped recording or loading additional requests after ([1-9][0-9,]*) requests/;

function warningLimit(warnings: readonly string[], pattern: RegExp): string | null {
  for (const warning of warnings) {
    const match = pattern.exec(warning);
    if (match) return match[1];
  }
  return null;
}

function responseByteLimitFromWarnings(warnings: readonly string[]): string | null {
  return warningLimit(warnings, RESPONSE_BYTE_LIMIT_WARNING);
}

function uploadByteLimitFromWarnings(warnings: readonly string[]): string | null {
  return warningLimit(warnings, UPLOAD_BYTE_LIMIT_WARNING);
}

function requestRecordingLimitFromWarnings(warnings: readonly string[]): number | null {
  const recorded = warningLimit(warnings, REQUEST_RECORDING_LIMIT_WARNING);
  if (recorded === null) return null;
  const parsed = Number(recorded.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Open producer vocabularies never reach the page as raw slugs. Precise first-
 * party capture-loss details are rendered below from their semantic registry.
 */
function qualityReasonNote(run: RunView, reason: string): string {
  const mapped = QUALITY_REASON_NOTES[reason];
  if (mapped) return mapped;
  const budget = reason.startsWith("budget-exhausted:") ? reason.slice("budget-exhausted:".length) : null;
  if (budget === RESPONSE_BYTE_CAPTURE_LOSS_DETAIL) {
    const limit = responseByteLimitFromWarnings(run.warnings);
    return `the visit exhausted its ${limit ? `${limit} ` : ""}aggregate response-byte budget`;
  }
  if (budget === "request-upload") {
    const limit = uploadByteLimitFromWarnings(run.warnings);
    return `the visit exhausted its ${limit ? `${limit} ` : ""}aggregate upload-byte budget`;
  }
  if (budget === "request-capture" && run.quality.origin === "recorded") {
    const requestCountCap = runHitRequestRecordingCap(run);
    const responseByteCap = responseByteLimitFromWarnings(run.warnings) !== null;
    const distinctResponseByteBudget =
      run.quality.facts?.budgetsExhausted.includes(RESPONSE_BYTE_CAPTURE_LOSS_DETAIL) ?? false;
    if (requestCountCap && responseByteCap && !distinctResponseByteBudget) {
      return "the visit exhausted both its request-count and aggregate response-byte budgets";
    }
    if (responseByteCap && !distinctResponseByteBudget && !requestCountCap) {
      return `the visit exhausted its ${responseByteLimitFromWarnings(run.warnings)} aggregate response-byte budget`;
    }
    if (requestCountCap) {
      const requestLimit = requestRecordingLimitFromWarnings(run.warnings);
      return requestLimit === null
        ? "the visit exhausted its configured request routing and recording budget"
        : `the visit exhausted its ${requestLimit.toLocaleString("en-US")}-request routing and recording budget`;
    }
  }
  if (budget) return "the visit exhausted a producer-defined collection budget";
  if (reason.startsWith("capture-loss:")) {
    return "the run recorded a collection loss that prevents a complete visit";
  }
  return run.quality.origin === "legacy-derived"
    ? "the visit shows a quality limitation derived from its status and warnings"
    : "the run recorded a quality limitation";
}

function presentationLoss(run: RunView, loss: CaptureLossEntry): CaptureLossEntry {
  // Historical Node reports used `request-capture` for both independent
  // ceilings. The warning remains the only recorded discriminator on those
  // immutable wires. Resolve only when exactly one cause is proven.
  if (
    loss.detail === "request-capture" &&
    responseByteLimitFromWarnings(run.warnings) !== null &&
    !runHitRequestRecordingCap(run)
  ) {
    return { ...loss, detail: RESPONSE_BYTE_CAPTURE_LOSS_DETAIL };
  }
  return loss;
}

function censoredFamilyDetailNote(run: RunView, family: string): string {
  const responseByteLimit = responseByteLimitFromWarnings(run.warnings);
  const uploadByteLimit = uploadByteLimitFromWarnings(run.warnings);
  const historicalMergedRequestAndByteLoss =
    responseByteLimit !== null &&
    runHitRequestRecordingCap(run) &&
    !(run.quality.facts?.captureLoss ?? []).some(
      (loss) => loss.family === family && loss.detail === RESPONSE_BYTE_CAPTURE_LOSS_DETAIL
    );
  const details = Array.from(
    new Set(
      (run.quality.facts?.captureLoss ?? [])
        .filter((loss) => loss.family === family)
        .map((loss) =>
          captureLossDetailNote(presentationLoss(run, loss), {
            ...(responseByteLimit === null ? {} : { responseByteLimit }),
            ...(uploadByteLimit === null ? {} : { uploadByteLimit }),
            ...(historicalMergedRequestAndByteLoss ? { historicalMergedRequestAndByteLoss: true } : {})
          })
        )
    )
  );
  return details.length === 0 ? "" : ` — ${details.join("; ")}`;
}

const EVIDENCE_FAMILY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  requests: "request",
  cookies: "cookie",
  storage: "storage",
  fingerprinting: "fingerprinting",
  "detector-output": "detector output",
  "consent-verification": "consent verification"
});

/** Human-readable notes on evidence the run did not finish collecting. */
export function runCensorshipNotes(run: RunView): string[] {
  const notes: string[] = [];
  for (const reason of run.quality.reasons) {
    if (reason !== "http-error-status") notes.push(qualityReasonNote(run, reason));
  }
  if (run.quality.byFamily) {
    for (const [family, entry] of Object.entries(run.quality.byFamily)) {
      if (entry.outcome !== "censored") continue;
      const familyLosses = run.quality.facts?.captureLoss.filter((loss) => loss.family === family) ?? [];
      if (familyLosses.length > 0 && familyLosses.every((loss) => loss.detail === "pagegraph-unsupported")) {
        continue;
      }
      notes.push(
        `${EVIDENCE_FAMILY_LABELS[family] ?? "recorded"} evidence was censored before completion${
          censoredFamilyDetailNote(run, family) || " — the producer recorded incomplete collection"
        }`
      );
    }
  }
  return notes;
}

/** A prominent reader-facing notice when this report's evidence is incomplete. */
export function degradedRunNotice(view: ReportView): string | null {
  const failed = view.runs.filter((run) => run.quality.outcome === "failed");
  const cutShort = view.runs.filter(
    (run) => run.quality.outcome !== "failed" && runCensorshipNotes(run).length > 0
  );
  if (failed.length === 0 && cutShort.length === 0) return null;

  const parts: string[] = [];
  if (failed.length > 0) {
    parts.push(
      `${failed.length === view.runs.length ? "The visit" : `${failed.length} of ${view.runs.length} visits`} did not complete`
    );
  }
  if (cutShort.length > 0) {
    const reasons = [...new Set(cutShort.flatMap((run) => runCensorshipNotes(run)))];
    parts.push(
      `evidence was cut short before completion (${reasons.slice(0, 2).join("; ")}${reasons.length > 2 ? `; and ${reasons.length - 2} more` : ""})`
    );
  }
  const lowerBoundClause =
    failed.length > 0
      ? "Counts below are lower bounds for a visit that did not finish, so an absence here is especially weak evidence."
      : "Counts for the affected evidence are lower bounds; families that completed carry only their ordinary limits.";
  return `Incomplete evidence: ${parts.join(", and ")}. ${lowerBoundClause} The evidence receipt states the exact per-visit quality.`;
}

/** One-line run-quality summary for the methodology and evidence receipt. */
export function runQualitySummary(run: RunView): string {
  const basis =
    run.conditions.automation === "brave-pagegraph"
      ? "declared by the supplied PageGraph sidecar"
      : run.quality.origin === "recorded"
        ? "recorded by the scanner"
        : "derived from status and warnings";
  if (run.quality.outcome === "failed") {
    const status = typeof run.status === "number" && run.status >= 400 ? ` (HTTP ${run.status})` : "";
    return `failed${status}; ${basis}`;
  }
  const notes = runCensorshipNotes(run);
  const unsupported = runUnsupportedEvidenceNotes(run);
  if (notes.length > 0) {
    return `cut short: ${notes.join("; ")}${unsupported.length > 0 ? `; unsupported: ${unsupported.join("; ")}` : ""}; ${basis}`;
  }
  if (unsupported.length > 0) {
    return `complete for supported evidence; unsupported: ${unsupported.join("; ")}; ${basis}`;
  }
  return `complete; ${basis}`;
}
