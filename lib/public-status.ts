/**
 * Public status evaluation shared by the status page and its tests.
 *
 * The status UI is deliberately fail-closed: absent or malformed evidence is
 * `unknown`, old evidence is `stale`, and a fresh matching Pages/scanner pair
 * proves endpoint alignment only. It does not prove a successful synthetic
 * scan or persistence round trip.
 */

export const PUBLIC_STATUS_MAX_CLOCK_SKEW_MS = 60_000;
export const PUBLIC_STATUS_MAX_HEALTH_AGE_MS = 5 * 60_000;
export const PUBLIC_STATUS_MAX_CORPUS_AGE_MS = 8 * 24 * 60 * 60_000;
export const PUBLIC_STATUS_MAX_FILTER_LIST_AGE_MS = 8 * 24 * 60 * 60_000;
export const PUBLIC_STATUS_UI_REFRESH_MS = 60_000;
/**
 * How long after a revision's commit a Pages/scanner mismatch still counts as
 * a rollout in progress rather than a fault. Pages publishes in about a minute
 * while the scanner rebuilds its container image, so EVERY promotion produces
 * a mismatch for several minutes. Reporting that as "degraded" trains readers
 * to ignore the badge, which is worse than showing nothing.
 */
export const PUBLIC_STATUS_MAX_ROLLOUT_MS = 45 * 60_000;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/;

export type FreshnessState = "current" | "stale" | "unknown";
export type LiveDeploymentState = "aligned" | "rolling-out" | "degraded" | "stale" | "unknown";

export type LiveDeploymentEvaluation = {
  state: LiveDeploymentState;
  summary: string;
  pagesDeployment: string | null;
  scannerDeployment: string | null;
  checkedAt: string | null;
};

type PublicScannerHealth = {
  ok: boolean;
  status: "ok" | "degraded";
  timestamp: string;
  deployment: string;
  scansAvailable: boolean;
  warnings: string[];
};

/**
 * Classify a dated public artifact without ever interpreting malformed or
 * future timestamps as fresh.
 */
export function freshnessState(
  timestamp: string | null | undefined,
  maxAgeMs: number,
  nowMs: number = Date.now()
): FreshnessState {
  if (!timestamp || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(nowMs)) return "unknown";
  const observedAt = Date.parse(timestamp);
  if (!Number.isFinite(observedAt) || observedAt - nowMs > PUBLIC_STATUS_MAX_CLOCK_SKEW_MS) return "unknown";
  return nowMs - observedAt <= maxAgeMs ? "current" : "stale";
}

/** Milliseconds until currently fresh evidence must be evaluated as stale. */
export function freshnessExpiryDelayMs(
  timestamp: string | null | undefined,
  maxAgeMs: number,
  nowMs: number = Date.now()
): number | null {
  if (freshnessState(timestamp, maxAgeMs, nowMs) !== "current" || !timestamp) return null;
  const observedAt = Date.parse(timestamp);
  if (!Number.isFinite(observedAt)) return null;
  // freshnessState is current through the exact max-age boundary.
  return Math.max(1, observedAt + maxAgeMs - nowMs + 1);
}

/**
 * Evaluate only the public, non-secret subset of deployment health. Network
 * failures are handled by the caller and become `unknown` rather than a false
 * outage claim.
 */
export function evaluateLiveDeployment(
  pagesValue: unknown,
  scannerValue: unknown,
  nowMs: number = Date.now()
): LiveDeploymentEvaluation {
  const pagesDeployment = readPagesDeployment(pagesValue);
  const pagesRevisionCommittedAt = readPagesRevisionCommittedAt(pagesValue);
  const scanner = readScannerHealth(scannerValue);

  if (!pagesDeployment || !scanner || !Number.isFinite(nowMs)) {
    return {
      state: "unknown",
      summary: "Live deployment evidence was missing or invalid.",
      pagesDeployment,
      scannerDeployment: scanner?.deployment ?? null,
      checkedAt: scanner?.timestamp ?? null
    };
  }

  const healthFreshness = freshnessState(scanner.timestamp, PUBLIC_STATUS_MAX_HEALTH_AGE_MS, nowMs);
  if (healthFreshness !== "current") {
    return {
      state: healthFreshness === "stale" ? "stale" : "unknown",
      summary:
        healthFreshness === "stale"
          ? "The last scanner health response is too old to prove current availability."
          : "The scanner health timestamp could not be trusted.",
      pagesDeployment,
      scannerDeployment: scanner.deployment,
      checkedAt: scanner.timestamp
    };
  }

  const scannerUnhealthy =
    !scanner.ok || scanner.status !== "ok" || !scanner.scansAvailable || scanner.warnings.length > 0;

  // A revision mismatch on its own is the NORMAL state during a promotion: the
  // static site publishes long before the scanner finishes rebuilding. Call it
  // a rollout only while the site's revision is genuinely recent and the
  // scanner is otherwise healthy; a mismatch that outlives the rollout window,
  // or one alongside an unhealthy scanner, is a real fault.
  if (pagesDeployment !== scanner.deployment && !scannerUnhealthy) {
    const rolloutAgeMs = revisionAgeMs(pagesRevisionCommittedAt, nowMs);
    if (rolloutAgeMs !== null && rolloutAgeMs <= PUBLIC_STATUS_MAX_ROLLOUT_MS) {
      return {
        state: "rolling-out",
        summary:
          "A new revision is rolling out. The static site publishes before the scanner finishes rebuilding, so the two briefly serve different revisions; the scanner is healthy and serving scans.",
        pagesDeployment,
        scannerDeployment: scanner.deployment,
        checkedAt: scanner.timestamp
      };
    }
  }

  if (pagesDeployment !== scanner.deployment || scannerUnhealthy) {
    return {
      state: "degraded",
      summary:
        pagesDeployment !== scanner.deployment
          ? "The public site and scanner are serving different source revisions, and the newer revision is past its expected rollout window."
          : "The scanner reports a degraded posture or unavailable scans.",
      pagesDeployment,
      scannerDeployment: scanner.deployment,
      checkedAt: scanner.timestamp
    };
  }

  return {
    state: "aligned",
    summary:
      "The public site receipt and scanner health endpoint expose the same fresh source revision; the scanner response reports scans available and no warnings. This check does not submit a scan or verify report persistence.",
    pagesDeployment,
    scannerDeployment: scanner.deployment,
    checkedAt: scanner.timestamp
  };
}

function readPagesDeployment(value: unknown): string | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.deployment !== "string") return null;
  return FULL_GIT_SHA.test(value.deployment) ? value.deployment : null;
}

/**
 * The receipt's revision commit time, when it carries one. Receipts published
 * before this field existed simply have no rollout evidence, so a mismatch
 * stays "degraded" for them: absent evidence never buys a softer verdict.
 */
function readPagesRevisionCommittedAt(value: unknown): string | null {
  if (!isRecord(value) || typeof value.revisionCommittedAt !== "string") return null;
  return value.revisionCommittedAt;
}

/** Positive age in ms, or null when the stamp is malformed or in the future. */
function revisionAgeMs(committedAt: string | null, nowMs: number): number | null {
  if (committedAt === null) return null;
  const parsed = Date.parse(committedAt);
  if (!Number.isFinite(parsed)) return null;
  const ageMs = nowMs - parsed;
  if (ageMs < -PUBLIC_STATUS_MAX_CLOCK_SKEW_MS) return null;
  return Math.max(0, ageMs);
}

function readScannerHealth(value: unknown): PublicScannerHealth | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.ok !== "boolean" ||
    (value.status !== "ok" && value.status !== "degraded") ||
    typeof value.timestamp !== "string" ||
    typeof value.deployment !== "string" ||
    !FULL_GIT_SHA.test(value.deployment) ||
    typeof value.scansAvailable !== "boolean" ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string")
  ) {
    return null;
  }

  return {
    ok: value.ok,
    status: value.status,
    timestamp: value.timestamp,
    deployment: value.deployment,
    scansAvailable: value.scansAvailable,
    warnings: value.warnings
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
