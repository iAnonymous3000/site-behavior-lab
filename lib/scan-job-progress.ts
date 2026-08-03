import type { ScanJobProgress, ScanJobProgressPhase } from "./types";

const PHASES = new Set<ScanJobProgressPhase>([
  "queued",
  "waiting",
  "launching",
  "navigating",
  "collecting",
  "saving"
]);

export type ScanJobProgressCopy = {
  title: string;
  detail: string;
  completedRuns: string | null;
};

/**
 * Represent the admission boundary before the first coordinator status arrives.
 * The queued phase is valid only after the POST returned an accepted job.
 */
export function acceptedScanJobProgress(totalRuns: 1 | 2 = 1): ScanJobProgress {
  return { phase: "queued", completedRuns: 0, totalRuns };
}

/** Validate coordinator progress before it crosses into UI state. */
export function readScanJobProgress(value: unknown): ScanJobProgress | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "completedRuns" ||
    keys[1] !== "phase" ||
    keys[2] !== "totalRuns" ||
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase as ScanJobProgressPhase) ||
    typeof record.completedRuns !== "number" ||
    !Number.isSafeInteger(record.completedRuns) ||
    typeof record.totalRuns !== "number" ||
    !Number.isSafeInteger(record.totalRuns) ||
    (record.totalRuns !== 1 && record.totalRuns !== 2) ||
    record.completedRuns < 0 ||
    record.completedRuns > record.totalRuns
  ) {
    return null;
  }
  return {
    phase: record.phase as ScanJobProgressPhase,
    completedRuns: record.completedRuns,
    totalRuns: record.totalRuns
  };
}

/** Truthful stage copy only: no fabricated percentage or completion estimate. */
export function scanJobProgressCopy(progress: ScanJobProgress | null): ScanJobProgressCopy {
  const phaseCopy: Record<ScanJobProgressPhase, Pick<ScanJobProgressCopy, "title" | "detail">> = {
    queued: {
      title: "Scan accepted and queued",
      detail: "The scanner has retained this job and is waiting to start it."
    },
    // Both producers of this phase mean "running, no finer stage reported yet",
    // not "queued for a slot": scan-jobs markRunning() sets it from inside
    // runScanJob after a worker has already begun, and durable recovery sets it
    // for a lease a runner already holds. The genuine slot wait is the `queued`
    // phase, whose copy says so. Naming a running measurement a wait told the
    // reader a leased job had not started for its entire duration.
    waiting: {
      title: "Scan in progress",
      detail: "The scanner has started this job. It has not reported a more detailed stage yet."
    },
    launching: {
      title: "Launching the controlled browser",
      detail: "The scanner is preparing an isolated browser context for this visit."
    },
    navigating: {
      title: "Loading the requested page",
      detail: "The controlled browser is navigating to the public page."
    },
    collecting: {
      title: "Collecting observed evidence",
      detail: "The scanner is recording requests, cookies, storage, and supported browser signals."
    },
    saving: {
      title: "Saving the completed report",
      detail: "All controlled visits are complete and the validated report is being persisted."
    }
  };

  if (!progress) {
    return {
      title: "Submitting scan request",
      detail: "Waiting for the scanner to confirm the request.",
      completedRuns: null
    };
  }

  return {
    ...phaseCopy[progress.phase],
    completedRuns:
      progress.phase === "queued"
        ? null
        : progress.totalRuns === 2
          ? `${progress.completedRuns} of ${progress.totalRuns} controlled visits completed.`
          : progress.completedRuns === 1
            ? "The controlled visit is complete."
            : "0 of 1 controlled visits completed."
  };
}
