import assert from "node:assert/strict";
import { test } from "node:test";
import { consentChoiceVerified, consentRegistrationSentence, consentVerificationSummary } from "./report-consent-copy";
import type { RunConsentView } from "./scan-report-views";

function consent(choiceState: RunConsentView["choiceState"], controlActivated = true): RunConsentView {
  return {
    mode: "reject-all",
    interactionAttempted: true,
    controlActivated,
    cmp: null,
    matchedControlQualification: null,
    choiceState,
    verificationObservations: null,
    reverifiedAfterReload: null,
    verificationFailureReason: null,
    bannerTransition: null
  };
}

test("consent methodology summaries translate every wire state into plain language", () => {
  assert.equal(consentVerificationSummary(consent("verified")), "registered choice verified");
  assert.equal(consentVerificationSummary(consent("contradicted")), "registered state contradicted the click");
  assert.equal(
    consentVerificationSummary(consent("weak-signal")),
    "banner dismissed; registered state unverified"
  );
  assert.equal(consentVerificationSummary(consent("failed")), "registered-state check failed");
  assert.equal(consentVerificationSummary(consent("unavailable")), "registered state unavailable");
  assert.equal(consentVerificationSummary(consent(null)), "registration unverified");
});

test("a missing click is described as no dispatched choice regardless of verifier state", () => {
  assert.equal(consentVerificationSummary(consent(null, false)), "no activated choice");
  assert.equal(consentVerificationSummary(consent("unavailable", false)), "no activated choice");
});

test("public consent outcomes require a verified registered choice, not dispatch or banner transition", () => {
  assert.equal(consentChoiceVerified(consent("unavailable")), false);
  assert.equal(consentChoiceVerified(consent("verified")), true);
  assert.equal(consentChoiceVerified(consent("contradicted")), false);
  assert.equal(consentChoiceVerified(consent("weak-signal")), false);
  assert.equal(consentChoiceVerified(consent(null)), false);
  assert.equal(consentChoiceVerified(consent("verified", false)), false);

  const transitioned = consent("failed");
  transitioned.bannerTransition = {
    method: "banner-visibility@1",
    observations: [
      { moment: "before-interaction", phaseId: 1, atMs: 1, visible: true },
      { moment: "after-interaction", phaseId: 1, atMs: 2, visible: false }
    ]
  };
  assert.equal(consentChoiceVerified(transitioned), false);
});

test("a contradicted state is set against a click only when the record holds an activation", () => {
  const view = { origin: "v2", revision: 2 } as Parameters<typeof consentRegistrationSentence>[0];
  assert.equal(
    consentRegistrationSentence(view, consent("contradicted"), "Reject all"),
    "The site's registered consent state contradicted the Reject all click."
  );
  const unactivated = consentRegistrationSentence(view, consent("contradicted", false), "Reject all");
  assert.equal(
    unactivated,
    "The scanner read a registered state inconsistent with the requested Reject all choice, but it did not activate that control."
  );
  assert.doesNotMatch(unactivated, /contradicted the|\bclick\b/);
});
