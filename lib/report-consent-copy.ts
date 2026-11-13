import { isReviewedSameOrganizationDomain } from "./reviewed-ownership";
import type { ReportView, RunConsentView, RunView } from "./scan-report-views";

/**
 * Whether presentation may treat a visit as a verified consent choice.
 * Dispatch, banner disappearance, and a contradictory registered state are
 * useful observations, but none establishes that the requested choice was
 * registered. Public accept-versus-reject outcomes require this stronger gate
 * independently on both arms.
 */
export function consentChoiceVerified(consent: RunConsentView | null): boolean {
  return consent?.controlActivated === true && consent.choiceState === "verified";
}

/** Compact, human-facing status for the methodology row; never expose wire tokens. */
export function consentVerificationSummary(consent: RunConsentView): string {
  // `controlActivated` records that a control was found AND visibly reacted.
  // It is false both for a search that found nothing and for a click that was
  // dispatched and never confirmed, and the wire cannot tell those apart, so
  // this may only report the activation, never claim nothing was dispatched.
  if (!consent.controlActivated) return "no activated choice";
  switch (consent.choiceState) {
    case "verified":
      return "registered choice verified";
    case "contradicted":
      return "registered state contradicted the click";
    case "weak-signal":
      return "banner dismissed; registered state unverified";
    case "failed":
      return "registered-state check failed";
    case "unavailable":
      return "registered state unavailable";
    case null:
      return "registration unverified";
  }
}

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
      // The state is read whether or not a control was activated. Without an
      // activation the record holds no click for the state to contradict.
      return consent?.controlActivated === true
        ? `The site's registered consent state contradicted the ${choiceLabel} click.`
        : `The scanner read a registered state inconsistent with the requested ${choiceLabel} choice, but it did not activate that control.`;
    case "weak-signal":
      return `The banner disappeared after the ${choiceLabel} click, but no registered consent state was verified.`;
    case "failed":
      return `The registered-state check failed, so the ${choiceLabel} click remains unverified.`;
    case "unavailable":
      return `The scanner could not read a registered consent state, so the ${choiceLabel} click remains unverified.`;
    case null: {
      // Reachable for v1 (which never recorded a registered state) and,
      // defensively, for a v2 report whose wire carries no consent evidence;
      // name the actual generation so the sentence stays true on r2 too.
      const generation = view.origin === "legacy-derived" ? "v1" : view.revision === 1 ? "v2/r1" : "v2/r2";
      return `This ${generation} report records only that the scanner dispatched the ${choiceLabel} click; it cannot verify whether the site registered the choice.`;
    }
  }
}

/** Verification does not retroactively make a whole-visit request log post-choice. */
export const CONSENT_WHOLE_VISIT_CAVEAT =
  "The recorded requests span before and after the click, so some can be pre-choice traffic, from vendors the site treats as strictly necessary, or processing claimed under legitimate interest.";

/**
 * Whether the report's own phase tags place every request this visit made to
 * the given outside tracking services in the page-load phase, before the
 * phase in which the scanner searched for and clicked a consent control.
 *
 * Only an r2 visit can answer: it tags each request row with its phase. The
 * answer is true only when the visit recorded a consent-interaction phase,
 * at least one such request exists, and EVERY one carries a tag naming a
 * passive-load phase. An untagged row, a row in any later phase, or a visit
 * with no consent phase leaves it false, and the whole-visit wording stands.
 * A row tagged with the consent phase itself may precede the click inside
 * that phase, which the report cannot tell, so it is never counted as
 * before.
 */
export function trackerRequestsAllPrecedeConsentPhase(run: RunView, trackerEntities: readonly string[]): boolean {
  if (!run.phases || !run.phases.some((phase) => phase.kind === "consent-interaction")) return false;
  const passivePhaseIds = new Set(
    run.phases.filter((phase) => phase.kind === "passive-load").map((phase) => phase.phaseId)
  );
  const names = new Set(trackerEntities);
  const rows = run.evidence.requests.filter(
    (request) =>
      request.thirdParty &&
      request.tracker !== null &&
      names.has(request.tracker.entity) &&
      !isReviewedSameOrganizationDomain(run.domain, request.domain)
  );
  return (
    rows.length > 0 &&
    rows.every((request) => {
      const phaseId = (request as { phaseId?: unknown }).phaseId;
      return typeof phaseId === "number" && passivePhaseIds.has(phaseId);
    })
  );
}

/**
 * What a visit whose tracker requests all precede the consent phase can say
 * about afterward. The first sentence is true by construction of the check
 * above. The second is added only when the visit recorded a post-choice
 * reload, whose requests the request log leaves out by design
 * (CONSENT_RELOAD_DISCLOSURE): there the report is silent, not clean.
 */
export function consentPreClickOnlyNote(run: RunView): string {
  const reloaded = run.phases?.some((phase) => phase.kind === "post-choice-reload") === true;
  return `No such request was recorded in the later phases this report keeps.${
    reloaded
      ? " Requests during the reload after the click are not recorded, so this shows nothing about that interval."
      : ""
  }`;
}
