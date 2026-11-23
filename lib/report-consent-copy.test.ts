import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
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

test("an unverified consent click is described as the record holds it, by generation", () => {
  // Older v1 reports record a dispatched click, later ones a visible reaction,
  // and none says which; a v2 report with no consent evidence holds no state.
  for (const choice of ["Accept all", "Reject all"] as const) {
    assert.equal(
      consentRegistrationSentence({ origin: "legacy-derived", revision: null } as never, null, choice),
      `This v1 report records the ${choice} click as dispatched or, in later versions, as a visible reaction, without saying which, and cannot verify whether the site registered it.`,
      `v1, ${choice}`
    );
    assert.equal(
      consentRegistrationSentence({ origin: "v2", revision: 2 } as never, null, choice),
      `This v2/r2 report holds no registered consent state for the ${choice} choice, so it cannot verify whether the site registered it.`,
      `v2/r2, ${choice}`
    );
    assert.equal(
      consentRegistrationSentence({ origin: "v2", revision: 1 } as never, null, choice),
      `This v2/r1 report holds no registered consent state for the ${choice} choice, so it cannot verify whether the site registered it.`,
      `v2/r1, ${choice}`
    );
  }
});

test("four documents state one fact about a legacy consent click, in the same words", () => {
  // The card above and these four pages describe the same record. One clause,
  // and the methodology page ends it with a full stop.
  const clause =
    "Legacy v1 reports record a click, never its registration: older ones record that a click was dispatched, later ones that the clicked control visibly reacted, and no v1 report says which";
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  for (const file of ["docs/limitations.md", "docs/capabilities.md", "app/glossary/page.tsx"]) {
    assert.equal(read(file).split(`${clause};`).length, 2, `${file} states the clause once`);
  }
  assert.equal(read("app/methodology/page.tsx").split(`${clause}.`).length, 2, "the methodology page states the clause once, with a full stop");
  assert.ok(
    read("app/methodology/page.tsx").includes(
      "that platform&apos;s control may not express the whole choice), that a control was clicked and never visibly responded, that none was found, that none was clicked, or that whether one exists, was found or was clicked is unknown."
    ),
    "the methodology page lists every way a consent click can end"
  );
});
