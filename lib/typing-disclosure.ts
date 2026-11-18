import { KEYSTROKE_PROBE_REQUESTS_OMITTED_WARNING_FRAGMENT } from "./comparison-eligibility";

/**
 * The one reader parse of the scanner's typing disclosure.
 *
 * The sanitizer's patterns (lib/redact-scan-report-v1.ts) are the pinned copy
 * of the whole sentence; a report can carry only a sentence they admit. This
 * module reads two things from an admitted sentence: how many fields were
 * typed into, and whether it ends by saying the probe's requests were left
 * out of the request log. It is client-safe (the headline reads it in the
 * browser) and holds no sentence of its own: the omitted ending is the one
 * lib/comparison-eligibility.ts holds and reads the same way.
 */
export const TYPED_FIELDS_DISCLOSURE = /^This scan typed a synthetic test value into (1 form field|([0-9]+) form fields) /;

/**
 * What a run's typing disclosure records, or null when it carries none.
 *
 * Fails closed: only the omitted ending says the probe's requests are not in
 * the counts. Every other ending, a form this reader has not seen included,
 * leaves them counted (`requestsOmitted: false`).
 */
export type TypingProbeRecord = {
  fields: number;
  requestsOmitted: boolean;
};

export function typingProbeRecord(run: { warnings: readonly string[] }): TypingProbeRecord | null {
  for (const warning of run.warnings) {
    const match = TYPED_FIELDS_DISCLOSURE.exec(warning);
    if (!match) continue;
    return {
      fields: match[2] === undefined ? 1 : Number(match[2]),
      requestsOmitted: warning.includes(KEYSTROKE_PROBE_REQUESTS_OMITTED_WARNING_FRAGMENT)
    };
  }
  return null;
}
