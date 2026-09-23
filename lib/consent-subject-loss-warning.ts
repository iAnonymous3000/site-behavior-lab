/**
 * The warning the scanner adds when a consent click navigates the top
 * document to another origin. The producer then keeps that visit's requests,
 * cookies, storage and final URL at the pre-click boundary, so the visit's
 * evidence stops before the choice it attempted and cannot represent it.
 *
 * A dependency-free module so the producer (lib/scanner.ts) and the
 * client-safe comparison gate (lib/comparison-eligibility.ts) read one
 * string: the gate matches it exactly, so a reworded producer sentence cannot
 * silently stop the gate from firing. The same sentence is admitted public
 * v1 vocabulary (lib/redact-scan-report-v1.ts, pinned by the public-string
 * policy digest), so changing it is an identity decision, not a copy edit.
 */
export const CONSENT_INTERACTION_LEFT_SUBJECT_WARNING =
  "The consent interaction left the recorded site; later page state was not used and the active input probe was skipped.";
