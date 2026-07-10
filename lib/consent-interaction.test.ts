import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cmpSelectorsForChoice,
  consentChoiceLabel,
  consentClickArgs,
  consentInteractionWarning,
  matchesConsentChoice,
  normalizeConsentLabel
} from "./consent-interaction";

test("whole-label matching accepts the known accept/reject phrases", () => {
  assert.equal(matchesConsentChoice("accept-all", "Accept all"), true);
  assert.equal(matchesConsentChoice("accept-all", "  Accept All Cookies  "), true);
  assert.equal(matchesConsentChoice("accept-all", "I agree"), true);
  assert.equal(matchesConsentChoice("reject-all", "Reject all"), true);
  assert.equal(matchesConsentChoice("reject-all", "Decline all cookies"), true);
  assert.equal(matchesConsentChoice("reject-all", "Only necessary cookies"), true);
  assert.equal(matchesConsentChoice("reject-all", "Continue without accepting"), true);
});

test("whole-label matching rejects partial and page-authored phrases", () => {
  // Whole-label only: no phrase embedded in a longer sentence may match, so
  // matchedText can never carry arbitrary page text into the stored report.
  assert.equal(matchesConsentChoice("accept-all", "Accept all the great deals"), false);
  assert.equal(matchesConsentChoice("accept-all", "Learn how we use cookies"), false);
  assert.equal(matchesConsentChoice("reject-all", "Reject all suggestions from the editor"), false);
  assert.equal(matchesConsentChoice("reject-all", "Manage cookie settings"), false);
  // An opposite-choice label never matches.
  assert.equal(matchesConsentChoice("accept-all", "Reject all"), false);
  assert.equal(matchesConsentChoice("reject-all", "Accept all"), false);
});

test("label normalization collapses whitespace and trailing punctuation", () => {
  assert.equal(normalizeConsentLabel("  Accept\n all!  "), "accept all");
  assert.equal(matchesConsentChoice("accept-all", "Accept all!"), true);
  // Over-long labels never match, whatever they contain.
  assert.equal(matchesConsentChoice("accept-all", `accept all${" ".repeat(10)}${"x".repeat(60)}`), false);
});

test("the CMP selector catalog covers both choices for every platform", () => {
  const acceptSelectors = cmpSelectorsForChoice("accept-all");
  const rejectSelectors = cmpSelectorsForChoice("reject-all");
  const acceptCmps = new Set(acceptSelectors.map((entry) => entry.cmp));
  const rejectCmps = new Set(rejectSelectors.map((entry) => entry.cmp));

  for (const cmp of ["OneTrust", "Cookiebot", "Didomi", "Usercentrics", "Sourcepoint"]) {
    assert.ok(acceptCmps.has(cmp), `missing accept selectors for ${cmp}`);
    assert.ok(rejectCmps.has(cmp), `missing reject selectors for ${cmp}`);
  }
  assert.ok(acceptSelectors.some((entry) => entry.selector === "#onetrust-accept-btn-handler"));
  assert.ok(rejectSelectors.some((entry) => entry.selector === "#onetrust-reject-all-handler"));
});

test("consentClickArgs serializes the regex source for the page function", () => {
  const args = consentClickArgs("reject-all");
  const pattern = new RegExp(args.textPatternSource);
  assert.equal(pattern.test("reject all"), true);
  assert.equal(pattern.test("accept all"), false);
  assert.ok(args.selectors.length > 0);
  assert.ok(args.shadowHosts.includes("#usercentrics-root"));
});

test("interaction warnings disclose the click or the honest failure", () => {
  assert.equal(consentChoiceLabel("accept-all"), "Accept all");
  assert.equal(consentChoiceLabel("reject-all"), "Reject all");

  const clicked = consentInteractionWarning({ mode: "reject-all", clicked: true, cmp: "OneTrust" });
  assert.match(clicked, /clicked "Reject all" on the OneTrust banner/);
  // The click is dispatched, never verified as registered, and recording spans
  // the whole visit; the disclosure must not claim a post-choice state.
  assert.match(clicked, /dispatched, not verified/);
  assert.match(clicked, /before and after the click/);
  assert.doesNotMatch(clicked, /post-choice state/);

  const textClicked = consentInteractionWarning({ mode: "accept-all", clicked: true, matchedText: "accept all" });
  assert.match(textClicked, /a control labeled "accept all"/);

  const failed = consentInteractionWarning({ mode: "reject-all", clicked: false });
  assert.match(failed, /no recognizable control was found/);
  assert.match(failed, /pre-consent state/);
});
