import {
  CAPTURE_LOSS_DETAIL_CONTRACT,
  type KnownCaptureLossDetail
} from "./capture-loss-detail-contract";
import { isRecord } from "./guards";
import type { DetectorId, EvidenceFamily } from "./scan-report-v2";

/**
 * The evidence a detector's answer CAUSALLY depends on, so a prediction is
 * never scored from a run whose inputs were cut.
 *
 * WHY THIS EXISTS. A finished detector stage is not a complete prediction.
 * `cname-uncloaking` builds its candidate hosts from the retained request log,
 * so a censored `requests` family hides candidate hostnames BEFORE the detector
 * runs. The stage still reports `complete`, because it did finish: it resolved
 * DNS for the requests that survived. The calibration seam read exactly those
 * two signals, the run outcome and the detector ledger, and scored such a run
 * as a usable prediction. On the CNAME arm of the committed policy corpus that
 * is 60 of 61 runs scored where the analysis rule admits 54, an error in the
 * optimistic direction, in the one place that decides what the instrument
 * knows about its own accuracy.
 *
 * TWO AXES, AND THE DISTINCTION IS LOAD-BEARING.
 *
 * `families` are evidence families whose censoring invalidates this detector.
 * They are checked at family granularity because that is the granularity at
 * which the producer records them.
 *
 * `ownStageDetails` are capture-loss detail tokens WITHIN `detector-output`.
 * That family is shared by every detector in the registry, so a family-level
 * rule over it would censor a keystroke prediction because a privacy-policy
 * visit was dropped. `detector-output` must therefore never appear in
 * `families`; it is scoped by detail instead, and the accompanying test refuses
 * any entry that lists it.
 *
 * WHERE THE DETAIL LIVES. `quality.byFamily[...].reasons` carries
 * `capture-loss:<kind>` ("capture-loss:cap"), never the detail token, so the
 * detail scoping reads `qualityFacts.captureLoss` where `detail` is recorded.
 * Both are required run fields in ScanReport v2, so requiring them is a schema
 * guarantee rather than an assumption about producers.
 *
 * ONE DEFINITION, TWO CALLERS. The acquisition producer
 * (`scripts/calibration-study-lib.mjs`) and the independent binding verifier
 * (`lib/measurement-candidate-binding.ts`) both evaluate predictions, and this
 * defect exists because that contract was already restated in both with the
 * input check missing from each. Both now read this module, the producer
 * through the compiled-module loader it already uses for its other shared
 * contracts. A third copy is the shape that produced the bug.
 */
export type DetectorCausalInputs = {
  /**
   * Evidence families whose censoring makes this detector's prediction
   * unscoreable. Never includes `detector-output`; see `ownStageDetails`.
   */
  readonly families: readonly EvidenceFamily[];
  /**
   * `detector-output` capture-loss details belonging to THIS detector's own
   * stage, including the publication-boundary tokens for its evidence, since a
   * dropped public projection is the same loss of input to a scored prediction.
   */
  readonly ownStageDetails: readonly KnownCaptureLossDetail[];
};

/** Every detector a calibration study can score. `consent-banner` is excluded
 * upstream: its prediction requires the process-local result and cannot be
 * recomputed from public evidence at all. */
export type CalibratableDetectorId = Exclude<DetectorId, "consent-banner">;

export const DETECTOR_CAUSAL_INPUTS = Object.freeze({
  "fingerprint-heuristics": {
    // Genuinely causal, unlike the keystroke entry below: these detections ARE
    // what the passive observer produced, so a loss in its family cuts the
    // input. It happens to censor nothing in the current corpus (0 of 43), but
    // the declaration is about the dependency, not about today's yield.
    families: ["fingerprinting"],
    ownStageDetails: ["public-fingerprint-detections"]
  },
  "keystroke-exfiltration": {
    // Deliberately empty, and NOT `fingerprinting`, which an earlier draft of
    // this table declared. Keystroke detections travel in the same array the
    // observer fills (`lib/scanner.ts` appends `keystrokeDetection` to
    // `fingerprintObservations.detections`), but transport is not provenance:
    // the detection is produced by `probeKeystrokeExfiltration`, which installs
    // its own request listener and matches sentinel encodings against what it
    // captured itself. An unreadable frame in the passive observer cannot
    // change whether the sentinel appeared there. The array's own publication
    // token, `public-fingerprint-detections`, is a `detector-output` detail and
    // is declared below, so the real dependency is carried either way.
    //
    // The cost of getting this wrong was measured on the 61 committed
    // desktop/GPC-off/observe runs: declaring `fingerprinting` here censored 16
    // of the 53 otherwise-scoreable keystroke cases, all of them
    // `fingerprint-observer/dropped`, which under a zero-censoring policy makes
    // a keystroke study unpassable for a reason that is not about keystrokes.
    families: [],
    ownStageDetails: [
      "keystroke-probe",
      "keystroke-probe-capture",
      "public-fingerprint-detections"
    ]
  },
  "cname-uncloaking": {
    families: ["requests"],
    ownStageDetails: ["cname-lookups", "public-cname-cloaks"]
  },
  "pixel-events": {
    families: ["requests"],
    ownStageDetails: ["pixel-decode", "public-pixel-events"]
  },
  "privacy-policy": {
    // Deliberately empty. The policy page is discovered from page links and
    // fetched on its own navigation, so a truncated request log does not cut
    // its input. Its stage details carry the whole dependency.
    families: [],
    ownStageDetails: [
      "policy-visit",
      "policy-link-candidates",
      "public-policy-claims",
      "public-policy-entities"
    ]
  }
} as const satisfies Record<CalibratableDetectorId, DetectorCausalInputs>);

export function detectorCausalInputs(
  detector: CalibratableDetectorId
): DetectorCausalInputs {
  return DETECTOR_CAUSAL_INPUTS[detector];
}

/**
 * Complete, or the first proven reason it is not.
 *
 * `cause` is a diagnostic for an operator reading a refusal; nothing branches
 * on its text, and the calibration reason vocabulary is unchanged.
 */
export type DetectorCausalInputVerdict =
  | { readonly complete: true }
  | { readonly complete: false; readonly cause: string };

/**
 * FAILS CLOSED. Every path that cannot PROVE the causal inputs whole returns
 * incomplete, including a run missing `quality.byFamily` entirely. An
 * optional-chained rule would read a missing ledger as "nothing censored" and
 * pass every malformed run, which is the same optimistic direction as the
 * defect this closes.
 */
export function evaluateDetectorCausalInputs(
  run: unknown,
  detector: CalibratableDetectorId
): DetectorCausalInputVerdict {
  const contract = DETECTOR_CAUSAL_INPUTS[detector];
  if (!contract) return { complete: false, cause: `unknown detector ${detector}` };
  if (!isRecord(run)) return { complete: false, cause: "run is not an object" };

  const quality = run.quality;
  if (!isRecord(quality)) return { complete: false, cause: "quality is missing" };
  const byFamily = quality.byFamily;
  if (!isRecord(byFamily)) {
    return { complete: false, cause: "quality.byFamily is missing" };
  }
  for (const family of contract.families) {
    const entry = byFamily[family];
    if (!isRecord(entry)) {
      return { complete: false, cause: `quality.byFamily.${family} is missing` };
    }
    if (entry.outcome !== "complete") {
      return { complete: false, cause: `${family} evidence is censored` };
    }
  }

  const qualityFacts = run.qualityFacts;
  if (!isRecord(qualityFacts)) {
    return { complete: false, cause: "qualityFacts is missing" };
  }
  const captureLoss = qualityFacts.captureLoss;
  if (!Array.isArray(captureLoss)) {
    return { complete: false, cause: "qualityFacts.captureLoss is missing" };
  }
  const ownStageDetails = new Set<string>(contract.ownStageDetails);
  for (const loss of captureLoss) {
    if (!isRecord(loss)) {
      return { complete: false, cause: "qualityFacts.captureLoss entry is not an object" };
    }
    if (loss.family !== "detector-output") continue;
    if (typeof loss.detail !== "string") continue;
    if (ownStageDetails.has(loss.detail)) {
      return { complete: false, cause: `${loss.detail} stage evidence is incomplete` };
    }
  }
  return { complete: true };
}

/** Detail tokens this module scopes, for the contract test that holds every one
 * of them to `detector-output` in the producer's own capture-loss registry. */
export function declaredOwnStageDetails(): readonly KnownCaptureLossDetail[] {
  return Object.values(DETECTOR_CAUSAL_INPUTS).flatMap(
    (entry) => entry.ownStageDetails
  );
}

/** True when every declared own-stage detail is a real producer token recorded
 * under `detector-output`. Exported so the check itself can be shown to fail. */
export function ownStageDetailsAreDetectorOutput(
  details: readonly string[]
): boolean {
  return details.every((detail) => {
    const entry = (
      CAPTURE_LOSS_DETAIL_CONTRACT as Record<
        string,
        { families: readonly EvidenceFamily[] } | undefined
      >
    )[detail];
    return entry !== undefined && entry.families.includes("detector-output");
  });
}
