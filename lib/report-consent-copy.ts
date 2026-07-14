import type { ReportView, RunConsentView } from "./scan-report-views";

/** Version-aware statement of what the recorded consent evidence established. */
export function consentRegistrationSentence(
  view: Pick<ReportView, "origin" | "revision">,
  consent: RunConsentView | null,
  choiceLabel: "Accept all" | "Reject all"
): string {
  switch (consent?.choiceState ?? null) {
    case "verified":
      return consent?.reverifiedAfterReload === true
        ? `The report verified that the site registered ${choiceLabel} after the click and again after one page reload.`
        : `The report verified that the site registered ${choiceLabel} after the click.`;
    case "contradicted":
      return `The site's registered consent state contradicted the ${choiceLabel} click.`;
    case "weak-signal":
      return `The banner disappeared after the ${choiceLabel} click, but no registered consent state was verified.`;
    case "failed":
      return `The registered-state check failed, so the ${choiceLabel} click remains unverified.`;
    case "unavailable":
      return `The scanner could not read a registered consent state, so the ${choiceLabel} click remains unverified.`;
    case null: {
      const generation = view.origin === "legacy-derived" ? "v1" : view.revision === 1 ? "v2/r1" : "legacy";
      return `This ${generation} report records only that the scanner dispatched the ${choiceLabel} click; it cannot verify whether the site registered the choice.`;
    }
  }
}

/** Verification does not retroactively make a whole-visit request log post-choice. */
export const CONSENT_WHOLE_VISIT_CAVEAT =
  "The recorded requests span before and after the click, so some can be pre-choice traffic, from vendors the site treats as strictly necessary, or processing claimed under legitimate interest.";
