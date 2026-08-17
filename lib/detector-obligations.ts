import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import {
  R2_NAVIGATION_STATUS_UNREPRESENTABLE
} from "./scan-report-v2-http-status";
import type {
  CaptureLossEntry,
  DetectorId,
  DetectorStatus,
  EvidenceFamily,
  ScanRunV2
} from "./scan-report-v2";
import type { DetectorReasonCode } from "./detector-status-contract";

export const DETECTOR_OBLIGATION_CONTRACT_VERSION = "detector-obligations-v1";

/**
 * Exact producer registries governed by this obligation contract. Kept beside
 * the reader-safe rules so browser readers do not import the Node measurement
 * kernel merely to decide whether the rules apply. The former active epoch
 * remains enforced after a producer-version transition; only pre-accountability
 * registries are exempt.
 */
export const HISTORICAL_DETECTOR_OBLIGATION_TARGET_REGISTRY = Object.freeze({
  detectorRegistryVersion: "node-detectors-v3",
  detectorRegistryDigest: "ad2971a6c3eff3a0ba537529ba91cb28686a5101bf2f2c290e47c176cd23c38b"
});

export const HISTORICAL_SERVICE_ROLE_DETECTOR_OBLIGATION_TARGET_REGISTRY = Object.freeze({
  detectorRegistryVersion: "node-detectors-v4",
  detectorRegistryDigest: "100de91713270067dff4f5ecebeea61d330982c7a5aa33395bae3dd604adedd2"
});

/**
 * The single-day epoch that completed framework-wrapped visits and direct PDF
 * policies (fingerprint-observer@2). Closed when bounded-stack attribution
 * honesty revised the fingerprint observer to @3.
 */
export const HISTORICAL_WRAPPED_VISIT_DETECTOR_OBLIGATION_TARGET_REGISTRY = Object.freeze({
  detectorRegistryVersion: "node-detectors-v5",
  detectorRegistryDigest: "65547960bf03ca7d6d7b8279aa8b5ffed3a995bed2f36a64535d4179743ce204"
});

export const DETECTOR_OBLIGATION_TARGET_REGISTRY = Object.freeze({
  detectorRegistryVersion: "node-detectors-v6",
  detectorRegistryDigest: "81866718b36e35239f0418cc543eee845660e686849da1b816d937a601c1528b"
});

export const DETECTOR_OBLIGATION_TARGET_REGISTRIES = Object.freeze([
  HISTORICAL_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_SERVICE_ROLE_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  HISTORICAL_WRAPPED_VISIT_DETECTOR_OBLIGATION_TARGET_REGISTRY,
  DETECTOR_OBLIGATION_TARGET_REGISTRY
]);

type LossKind = CaptureLossEntry["kind"];

export type DetectorLossPhaseRule =
  | "detector-phase"
  | "captured-request-phase"
  | "fingerprint-coverage-phase";

export type DetectorLossObligation = Readonly<{
  family: EvidenceFamily;
  detail: string;
  kinds: readonly LossKind[];
  phaseRule: DetectorLossPhaseRule;
}>;

export type DetectorObligationRule = Readonly<{
  detector: DetectorId;
  status: Exclude<DetectorStatus, "complete">;
  reason: DetectorReasonCode;
  loss?: DetectorLossObligation;
  silent?: "probe-off" | "policy-unsupported" | "failed-page";
}>;

function freezeLoss(
  family: EvidenceFamily,
  detail: string,
  kinds: readonly LossKind[],
  phaseRule: DetectorLossPhaseRule
): DetectorLossObligation {
  return Object.freeze({
    family,
    detail,
    kinds: Object.freeze([...kinds]),
    phaseRule
  });
}

/**
 * Immutable causal registry for the active Node detector epoch.
 *
 * Absence from this registry is meaningful: the active producer may not emit
 * that non-complete status/reason tuple. A generic reader can therefore reject
 * a structurally valid but semantically invented detector outcome.
 */
export const DETECTOR_OBLIGATION_REGISTRY: readonly DetectorObligationRule[] = Object.freeze([
  // Fingerprinting observations.
  Object.freeze({
    detector: "fingerprint-heuristics",
    status: "partial",
    reason: "load-failed",
    loss: freezeLoss(
      "fingerprinting",
      "fingerprint-observer",
      ["dropped"],
      "fingerprint-coverage-phase"
    )
  }),
  Object.freeze({
    detector: "fingerprint-heuristics",
    status: "partial",
    reason: "scan-failed",
    loss: freezeLoss(
      "fingerprinting",
      "fingerprint-observer",
      ["dropped"],
      "fingerprint-coverage-phase"
    )
  }),
  Object.freeze({
    detector: "fingerprint-heuristics",
    status: "failed",
    reason: "load-failed",
    loss: freezeLoss(
      "fingerprinting",
      "fingerprint-observer",
      ["dropped"],
      "fingerprint-coverage-phase"
    )
  }),
  Object.freeze({
    detector: "fingerprint-heuristics",
    status: "failed",
    reason: "engine-unavailable",
    loss: freezeLoss(
      "fingerprinting",
      "fingerprint-observer",
      ["dropped"],
      "fingerprint-coverage-phase"
    )
  }),

  // Synthetic keystroke probe. Probe-off is the only intentionally silent
  // state; every attempted-but-incomplete probe identifies its exact loss.
  Object.freeze({
    detector: "keystroke-exfiltration",
    status: "skipped",
    reason: "probe-disabled",
    silent: "probe-off"
  }),
  Object.freeze({
    detector: "keystroke-exfiltration",
    status: "skipped",
    reason: "not-requested",
    silent: "probe-off"
  }),
  Object.freeze({
    detector: "keystroke-exfiltration",
    status: "partial",
    reason: "evidence-cap-reached",
    loss: freezeLoss(
      "detector-output",
      "keystroke-probe-capture",
      ["truncated"],
      "detector-phase"
    )
  }),
  ...(["budget-unavailable", "load-failed", "scan-failed"] as const).map((reason) =>
    Object.freeze({
      detector: "keystroke-exfiltration" as const,
      status: "partial" as const,
      reason,
      loss: freezeLoss(
        "detector-output",
        "keystroke-probe",
        ["timeout", "cap", "dropped"],
        "detector-phase"
      )
    })
  ),
  ...(["budget-unavailable", "load-failed"] as const).map((reason) =>
    Object.freeze({
      detector: "keystroke-exfiltration" as const,
      status: "skipped" as const,
      reason,
      loss: freezeLoss(
        "detector-output",
        "keystroke-probe",
        ["timeout", "cap", "dropped"],
        "detector-phase"
      )
    })
  ),
  ...(["load-failed", "engine-unavailable", "scan-failed"] as const).map((reason) =>
    Object.freeze({
      detector: "keystroke-exfiltration" as const,
      status: "failed" as const,
      reason,
      loss: freezeLoss(
        "detector-output",
        "keystroke-probe",
        ["dropped"],
        "detector-phase"
      )
    })
  ),

  // Bounded CNAME and pixel evidence.
  Object.freeze({
    detector: "cname-uncloaking",
    status: "partial",
    reason: "evidence-cap-reached",
    loss: freezeLoss(
      "detector-output",
      "cname-lookups",
      ["cap", "truncated"],
      "detector-phase"
    )
  }),
  Object.freeze({
    detector: "cname-uncloaking",
    status: "skipped",
    reason: "budget-unavailable",
    loss: freezeLoss(
      "detector-output",
      "cname-lookups",
      ["cap", "timeout"],
      "detector-phase"
    )
  }),
  Object.freeze({
    detector: "cname-uncloaking",
    status: "failed",
    reason: "scan-failed",
    loss: freezeLoss(
      "detector-output",
      "cname-lookups",
      ["dropped"],
      "detector-phase"
    )
  }),
  Object.freeze({
    detector: "pixel-events",
    status: "partial",
    reason: "evidence-cap-reached",
    loss: freezeLoss(
      "detector-output",
      "pixel-decode",
      ["cap", "truncated"],
      "captured-request-phase"
    )
  }),
  Object.freeze({
    detector: "pixel-events",
    status: "partial",
    reason: "scan-failed",
    loss: freezeLoss(
      "detector-output",
      "pixel-decode",
      ["dropped"],
      "captured-request-phase"
    )
  }),

  // Consent is always-on for active r2 output. Every incomplete observation
  // therefore identifies the banner coverage that was lost.
  ...([
    ["partial", "budget-unavailable"],
    ["partial", "load-failed"],
    ["partial", "scan-failed"],
    ["skipped", "budget-unavailable"],
    ["skipped", "load-failed"],
    ["failed", "engine-unavailable"],
    ["failed", "scan-failed"]
  ] as const).map(([status, reason]) =>
    Object.freeze({
      detector: "consent-banner" as const,
      status,
      reason,
      loss: freezeLoss(
        "detector-output",
        "consent-banner",
        ["cap", "timeout", "dropped"],
        "detector-phase"
      )
    })
  ),

  // Policy exceptions are deliberately narrow. Disabled/not-requested and a
  // genuine no-link outcome need no loss; HTTP/interstitial pages deliberately
  // suppress a vendor policy visit. An unverified page is not such an
  // exception and must carry policy-visit loss.
  Object.freeze({
    detector: "privacy-policy",
    status: "skipped",
    reason: "probe-disabled",
    silent: "probe-off"
  }),
  Object.freeze({
    detector: "privacy-policy",
    status: "skipped",
    reason: "not-requested",
    silent: "probe-off"
  }),
  Object.freeze({
    detector: "privacy-policy",
    status: "unsupported",
    reason: "unsupported",
    silent: "policy-unsupported"
  }),
  Object.freeze({
    detector: "privacy-policy",
    status: "skipped",
    reason: "load-failed",
    silent: "failed-page",
    loss: freezeLoss(
      "detector-output",
      "policy-visit",
      ["dropped", "timeout"],
      "detector-phase"
    )
  }),
  Object.freeze({
    detector: "privacy-policy",
    status: "skipped",
    reason: "evidence-cap-reached",
    loss: freezeLoss(
      "detector-output",
      "policy-link-candidates",
      ["truncated", "cap"],
      "detector-phase"
    )
  }),
  Object.freeze({
    detector: "privacy-policy",
    status: "skipped",
    reason: "budget-unavailable",
    loss: freezeLoss(
      "detector-output",
      "policy-visit",
      ["cap", "timeout"],
      "detector-phase"
    )
  }),
  Object.freeze({
    detector: "privacy-policy",
    status: "failed",
    reason: "load-failed",
    loss: freezeLoss(
      "detector-output",
      "policy-visit",
      ["dropped", "timeout"],
      "detector-phase"
    )
  }),
  Object.freeze({
    detector: "privacy-policy",
    status: "failed",
    reason: "scan-failed",
    loss: freezeLoss(
      "detector-output",
      "policy-visit",
      ["dropped"],
      "detector-phase"
    )
  })
]);

export const DETECTOR_OBLIGATION_REGISTRY_DIGEST = sha256Hex(
  canonicalJson({
    version: DETECTOR_OBLIGATION_CONTRACT_VERSION,
    rules: DETECTOR_OBLIGATION_REGISTRY
  })
);

const RULES_BY_TUPLE: ReadonlyMap<string, DetectorObligationRule> = new Map(
  DETECTOR_OBLIGATION_REGISTRY.map((rule) => [
    `${rule.detector}\u0000${rule.status}\u0000${rule.reason}`,
    rule
  ])
);

function isFailedPage(run: ScanRunV2): boolean {
  return (
    (run.qualityFacts.status !== null && run.qualityFacts.status >= 400) ||
    run.qualityFacts.botWallTitleMatched ||
    run.qualityFacts.captureLoss.some(
      (loss) => loss.detail === R2_NAVIGATION_STATUS_UNREPRESENTABLE
    )
  );
}

function silentRuleSatisfied(rule: DetectorObligationRule, run: ScanRunV2): boolean {
  const entry = run.detectors[rule.detector];
  if (rule.silent === "probe-off") {
    const off =
      rule.detector === "keystroke-exfiltration"
        ? !run.conditions.probes.keystroke
        : rule.detector === "privacy-policy"
          ? !run.conditions.probes.policyVisit
          : false;
    return off && entry.phaseId === undefined;
  }
  if (rule.silent === "policy-unsupported") {
    return (
      run.conditions.probes.policyVisit &&
      entry.phaseId === undefined &&
      run.evidence.privacyPolicy === undefined
    );
  }
  if (rule.silent === "failed-page") {
    return (
      run.conditions.probes.policyVisit &&
      entry.phaseId === undefined &&
      run.evidence.privacyPolicy === undefined &&
      isFailedPage(run)
    );
  }
  return false;
}

function exactCausalLoss(
  run: ScanRunV2,
  detector: DetectorId,
  obligation: DetectorLossObligation
): CaptureLossEntry | undefined {
  return run.qualityFacts.captureLoss.find(
    (loss) =>
      !loss.detail?.startsWith("public-") &&
      loss.family === obligation.family &&
      loss.detail === obligation.detail &&
      lossPhaseMatches(run, detector, loss, obligation.phaseRule) &&
      obligation.kinds.includes(loss.kind)
  );
}

function lossPhaseMatches(
  run: ScanRunV2,
  detector: DetectorId,
  loss: CaptureLossEntry,
  rule: DetectorLossPhaseRule
): boolean {
  if (rule === "detector-phase") {
    return loss.phaseId === (run.detectors[detector].phaseId ?? null);
  }

  if (rule === "fingerprint-coverage-phase") {
    const detectorPhaseId = run.detectors[detector].phaseId;
    if (loss.phaseId === null || detectorPhaseId === undefined) return false;
    const detectorPhase = run.phases.find(
      (candidate) => candidate.phaseId === detectorPhaseId
    );
    const lossPhase = run.phases.find(
      (candidate) => candidate.phaseId === loss.phaseId
    );
    if (
      !detectorPhase ||
      !lossPhase ||
      (detectorPhase.kind !== "passive-load" &&
        detectorPhase.kind !== "consent-interaction")
    ) {
      return false;
    }
    if (loss.phaseId === detectorPhaseId) return true;
    return (
      detectorPhase.kind === "consent-interaction" &&
      lossPhase.kind === "passive-load" &&
      lossPhase.endedAtMs <= detectorPhase.startedAtMs
    );
  }

  if (loss.phaseId === null) return false;
  const phase = run.phases.find((candidate) => candidate.phaseId === loss.phaseId);
  return (
    phase !== undefined &&
    phase.kind !== "policy-analysis" &&
    run.evidence.requests.some((request) => request.phaseId === loss.phaseId)
  );
}

/**
 * Validate only an explicitly named obligation epoch. Historical detector
 * registries remain readable under their frozen semantics.
 */
export function detectorObligationViolations(
  run: ScanRunV2,
  label: string,
  epoch: Readonly<{ detectorRegistryVersion: string; detectorRegistryDigest: string }>
): string[] {
  if (
    run.provenance.detectorRegistry.version !== epoch.detectorRegistryVersion ||
    run.provenance.detectorRegistry.digest !== epoch.detectorRegistryDigest
  ) {
    return [];
  }

  const violations: string[] = [];
  for (const [detector, entry] of Object.entries(run.detectors) as Array<
    [DetectorId, ScanRunV2["detectors"][DetectorId]]
  >) {
    if (entry.status === "complete") continue;
    const rule = RULES_BY_TUPLE.get(
      `${detector}\u0000${entry.status}\u0000${entry.reason ?? ""}`
    );
    if (!rule) {
      violations.push(
        `${label}: detector ${detector} uses an outcome outside ${DETECTOR_OBLIGATION_CONTRACT_VERSION}`
      );
      continue;
    }
    if (rule.silent !== undefined && silentRuleSatisfied(rule, run)) continue;
    if (rule.loss && exactCausalLoss(run, detector, rule.loss)) continue;
    if (rule.silent !== undefined && rule.loss === undefined) {
      violations.push(
        `${label}: detector ${detector} does not satisfy its ${rule.silent} exception`
      );
      continue;
    }
    {
      const phase = entry.phaseId ?? null;
      violations.push(
        `${label}: detector ${detector} lacks causal ${rule.loss?.family ?? "unknown"}/${rule.loss?.detail ?? "unknown"} loss under ${rule.loss?.phaseRule ?? "unknown"} (detector phase ${phase})`
      );
    }
  }
  return violations;
}
