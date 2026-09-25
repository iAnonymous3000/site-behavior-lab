/**
 * The two warnings, besides the consent interaction's own
 * (lib/consent-subject-loss-warning.ts), that the scanner adds when the page
 * is off the recorded site before or during the active input probe, so the
 * probe is skipped or stops. r2 records the keystroke detector as skipped or
 * partial for each. v1 has no detector ledger and these sentences are its only
 * record, so v1 readers censor the keystroke claim for them.
 *
 * A dependency-free module for the reason the consent line has one: the
 * producer (lib/scanner.ts) and the client-safe readers
 * (lib/comparison-eligibility.ts) match one string exactly, so a reworded
 * producer sentence cannot silently stop a reader from firing. Both sentences
 * are admitted public v1 vocabulary (lib/redact-scan-report-v1.ts, pinned by
 * the public-string policy digest), so changing one is an identity decision,
 * not a copy edit.
 */
export const CONSENT_RELOAD_SUBJECT_WARNING =
  "The post-consent reload left the recorded site; its state was not used and the active input probe was skipped.";
export const ACTIVE_PROBE_SUBJECT_WARNING =
  "The page left the recorded site before or during the active input probe; the probe stopped without acting on the other site.";
