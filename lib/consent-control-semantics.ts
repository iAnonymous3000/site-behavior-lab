/**
 * What a catalogued consent control SUBMITS, as distinct from which control was
 * clicked.
 *
 * A catalogued selector proves which control the scanner activated. It does not
 * prove what that control expressed: some platforms give their primary button a
 * configuration-dependent meaning, so the same id is an allow-all on one
 * deployment and a submit-what-is-currently-ticked on another. Reporting such a
 * click as `Accept all` would be the recorded fact (a click on a catalogued
 * accept control) standing in for an inference it does not support (that the
 * visit expressed accept-all).
 *
 * Its own module, not part of consent-interaction.ts, for two reasons: the view
 * layer needs it without dragging the serialized page functions into the client
 * bundle, and one table read by both the producer's disclosure and the reader's
 * view keeps the two from drifting into disagreeing copies.
 */

/**
 * Keyed by catalogued selector; the value is the curated clause the disclosure
 * uses. The text describes the control's ROLE as its vendor documents it, never
 * a visible label: the scanner does not read the button's text in the CMP tier,
 * and banner wording varies by site, language, and configuration.
 *
 * Absence means "not known to be qualified", NOT "audited and found to express
 * the full choice". Only add an entry backed by vendor documentation, and keep
 * any qualified selector LAST in its catalog entry's list so an unqualified
 * control on the same banner is always preferred (both pinned by test).
 */
export const CONSENT_QUALIFIED_CHOICE_CONTROLS: Readonly<Record<string, string>> = Object.freeze({
  // Cookiebot's generic dialog accept. On a deployment that renders category
  // toggles this submits the categories currently ticked, and Cookiebot's GDPR
  // default pre-ticks none of preferences/statistics/marketing. The dedicated
  // allow-all (#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll) is
  // listed before it, so this is only reached when no allow-all control is
  // present and visible.
  "#CybotCookiebotDialogBodyButtonAccept":
    "the platform's general accept control, which on some deployments submits only the cookie categories already selected"
});

/** The curated qualification for a matched control, when it has one. */
export function consentControlQualification(selector: string | undefined | null): string | null {
  if (!selector) return null;
  return Object.prototype.hasOwnProperty.call(CONSENT_QUALIFIED_CHOICE_CONTROLS, selector)
    ? CONSENT_QUALIFIED_CHOICE_CONTROLS[selector]
    : null;
}
