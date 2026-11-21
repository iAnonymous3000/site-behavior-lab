import { phaseOmissionExplainedByDetector } from "./detector-phase-omission";
import type { ConditionVector, DetectorLedger, PhaseSpan } from "./scan-report-v2";

/**
 * The phase plan a Node r2 run must carry, as one rule for the producer that
 * writes the run and the reader that accepts it.
 *
 * The builder (lib/scan-result-v2-r2-builder.ts) throws the first violation,
 * with the message it always threw, so no producer behaviour moves. The r2
 * reader (lib/scan-report-v2-r2-evaluators.ts) refuses a node-playwright run
 * with any violation, where it used to check only consent-mode phases, so a
 * file or stored report the producer could never have written is no longer
 * read as one. PageGraph imports keep their own rule.
 *
 * Every rule here predates the oldest committed r2 report, and the one rule
 * changed since was a widening, so every earlier Node producer meets this
 * version. The reader applies it to every Node r2 run. That holds only while
 * the rule never narrows: a change that would refuse a run an earlier producer
 * wrote needs a new version pinned per producer tuple, as the phase-omission
 * contract is (lib/detector-phase-omission.ts), never an edit here. The
 * version is a code constant only: it enters no report, no digest and no
 * producer tuple.
 */
export const NODE_R2_PHASE_PLAN_CONTRACT_VERSION = "node-phase-plan-v1";

/** The consent facts the plan reads. */
export type PhasePlanConsentFacts = { interactionAttempted: boolean; controlActivated: boolean };

/**
 * Every rule of the Node r2 phase plan the run breaks, in the order the
 * producer checks them, each with the producer's own message. Empty for a
 * plan the producer can write.
 */
export function nodeR2PhasePlanViolations(
  conditions: ConditionVector,
  phases: readonly PhaseSpan[],
  detectors: DetectorLedger,
  consent: PhasePlanConsentFacts | undefined
): string[] {
  const violations: string[] = [];
  for (const [index, phase] of phases.entries()) {
    if (
      phase.phaseId !== index ||
      !Number.isSafeInteger(phase.startedAtMs) ||
      !Number.isSafeInteger(phase.endedAtMs) ||
      phase.startedAtMs < 0 ||
      phase.endedAtMs < phase.startedAtMs
    ) {
      violations.push("Node measurement phases require sequential IDs and nonnegative integer spans.");
      break;
    }
  }
  const kinds = phases.map((phase) => phase.kind);
  if (kinds[0] !== "passive-load") violations.push("A Node r2 phase plan must start with passive-load.");
  if (new Set(kinds).size !== kinds.length) violations.push("A Node r2 phase plan cannot repeat a phase kind.");
  const order = new Map([
    ["passive-load", 0],
    ["consent-interaction", 1],
    ["post-choice-reload", 2],
    ["active-probe", 3],
    ["policy-analysis", 4]
  ] as const);
  for (let index = 1; index < kinds.length; index += 1) {
    if ((order.get(kinds[index - 1]) ?? -1) >= (order.get(kinds[index]) ?? -1)) {
      violations.push("A Node r2 phase plan is out of order.");
      break;
    }
  }

  const hasConsent = kinds.includes("consent-interaction");
  const hasReload = kinds.includes("post-choice-reload");
  if (conditions.consent === "observe" && (hasConsent || hasReload)) {
    violations.push("Observe-mode runs cannot carry consent interaction or reload phases.");
  }
  if (conditions.consent !== "observe" && !hasConsent) {
    // A bot wall, a failed navigation, or a probe that ran out of budget means
    // the interaction never happened, so there is no phase to record. That is
    // representable only if the run says so on BOTH channels: the detector
    // accountably explains the absence and the consent facts claim no attempt
    // and no activation. Otherwise a consent-mode run really is missing a
    // phase it should have, which stays a hard refusal. This mirrors the
    // phase-omission rule the keystroke and policy probes already use.
    const phaseOmissionExplained =
      phaseOmissionExplainedByDetector(detectors["consent-banner"]) &&
      consent !== undefined &&
      consent.interactionAttempted === false &&
      consent.controlActivated === false;
    if (!phaseOmissionExplained) {
      violations.push("Consent-mode runs require a consent-interaction phase.");
    }
  }
  if (hasReload && !hasConsent) violations.push("A post-choice reload requires a consent-interaction phase.");
  const hasActiveProbe = kinds.includes("active-probe");
  if (hasActiveProbe && !conditions.probes.keystroke) {
    violations.push("An active-probe phase requires the declared keystroke probe condition.");
  }
  if (conditions.probes.keystroke && !hasActiveProbe && !phaseOmissionExplainedByDetector(detectors["keystroke-exfiltration"])) {
    violations.push("A skipped active probe requires a keystroke detector outcome that explains the omission.");
  }
  if (
    hasActiveProbe &&
    !executedDetector(detectors["keystroke-exfiltration"]) &&
    !phaseOmissionExplainedByDetector(detectors["keystroke-exfiltration"])
  ) {
    // The scanner opens the active-probe phase BEFORE it knows whether any
    // field can be typed, so a page that navigates away mid-search (delayed
    // redirect, SPA route change, auto-submitting form) legitimately ends with
    // an existing phase and `keystroke-exfiltration: skipped/load-failed`.
    // Refusing that combination made the r2 producer throw on an ordinary real
    // page instead of publishing an honest report. An unaccountable skip
    // (`not-requested`, `probe-disabled`) is still refused, because those
    // reasons are deliberately absent from the phase-omission vocabulary.
    violations.push("An active-probe phase requires an executed or accountably skipped keystroke detector outcome.");
  }
  if (!hasActiveProbe && executedDetector(detectors["keystroke-exfiltration"])) {
    violations.push("An executed keystroke detector requires an active-probe phase.");
  }
  const hasPolicy = kinds.includes("policy-analysis");
  if (hasPolicy && !conditions.probes.policyVisit) {
    violations.push("A policy-analysis phase requires the declared policy-visit condition.");
  }
  if (conditions.probes.policyVisit && !hasPolicy && !phaseOmissionExplainedByDetector(detectors["privacy-policy"])) {
    violations.push("A skipped policy visit requires a privacy-policy detector outcome that explains the omission.");
  }
  if (hasPolicy && !executedDetector(detectors["privacy-policy"])) {
    violations.push("A policy-analysis phase requires an executed privacy-policy detector outcome.");
  }
  // A failed outcome explains a missing phase (detector-phase-omission): the
  // scanner records a link read that failed before any visit as
  // `failed/scan-failed` with no phase, and the obligation registry admits it.
  // Only an outcome that reports activity needs the phase it reports from.
  // The explanation needs the declared probe: a run that never declared a
  // policy visit has no link read to fail.
  if (
    !hasPolicy &&
    executedDetector(detectors["privacy-policy"]) &&
    !(conditions.probes.policyVisit && phaseOmissionExplainedByDetector(detectors["privacy-policy"]))
  ) {
    violations.push("An executed privacy-policy detector requires a policy-analysis phase.");
  }

  for (const id of ["fingerprint-heuristics", "cname-uncloaking", "pixel-events", "consent-banner"] as const) {
    const entry = detectors[id];
    if (entry?.status === "skipped" && (entry.reason === "not-requested" || entry.reason === "probe-disabled")) {
      violations.push(`Always-on detector ${id} cannot remain in its default unrequested state.`);
    }
  }
  return violations;
}

function executedDetector(entry: DetectorLedger[keyof DetectorLedger] | undefined): boolean {
  return entry !== undefined && (entry.status === "complete" || entry.status === "partial" || entry.status === "failed");
}
