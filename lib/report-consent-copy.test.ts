import assert from "node:assert/strict";
import { test } from "node:test";
import { consentVerificationSummary } from "./report-consent-copy";
import type { RunConsentView } from "./scan-report-views";

function consent(choiceState: RunConsentView["choiceState"], controlActivated = true): RunConsentView {
  return {
    mode: "reject-all",
    interactionAttempted: true,
    controlActivated,
    cmp: null,
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
  assert.equal(consentVerificationSummary(consent(null, false)), "no choice dispatched");
  assert.equal(consentVerificationSummary(consent("unavailable", false)), "no choice dispatched");
});
