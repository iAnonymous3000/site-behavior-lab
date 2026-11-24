/**
 * Shared publication-eligibility thresholds for detector calibration studies.
 *
 * Kept in a zero-import leaf module so report readers and static pages share
 * the exact same numbers as the host release-gate verifier
 * (`lib/measurement-candidate-binding.ts`) without pulling Node/Git/Sigstore
 * verification machinery into reader or page module graphs.
 */
export const MEASUREMENT_CALIBRATION_MINIMUM_CLASS_DENOMINATOR = 100;
export const MEASUREMENT_CALIBRATION_CONFIDENCE_LEVEL = 0.95;
export const MEASUREMENT_CALIBRATION_MAXIMUM_WORST_CASE_HALF_WIDTH = 0.1;
