import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consentVerificationEnabled,
  onetrustObservedState,
  tcfObservedState,
  type TcfApiReadOutcome
} from "./consent-verification";

function tcfRead(overrides: Partial<Extract<TcfApiReadOutcome, { status: "read" }>>): Extract<TcfApiReadOutcome, { status: "read" }> {
  return {
    status: "read",
    gdprApplies: true,
    eventStatus: "useractioncomplete",
    purposeConsents: {},
    ...overrides
  };
}

test("consentVerificationEnabled reads only the exact opt-in value", () => {
  assert.equal(consentVerificationEnabled({}), false);
  assert.equal(consentVerificationEnabled({ SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "1" }), true);
  assert.equal(consentVerificationEnabled({ SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "true" }), false);
  assert.equal(consentVerificationEnabled({ SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION: "0" }), false);
});

test("tcfObservedState only classifies settled registrations", () => {
  // Outside the GDPR regime or before the CMP settles, nothing is provable.
  assert.equal(tcfObservedState(tcfRead({ gdprApplies: false, purposeConsents: { "1": true, "2": true } })), "unknown");
  assert.equal(tcfObservedState(tcfRead({ eventStatus: "cmpuishown", purposeConsents: { "1": false } })), "unknown");
  assert.equal(tcfObservedState(tcfRead({ eventStatus: null })), "unknown");

  // Settled states classify over the purposes the site actually requested.
  assert.equal(tcfObservedState(tcfRead({ purposeConsents: { "1": true, "2": true, "3": true } })), "accepted-all");
  assert.equal(
    tcfObservedState(tcfRead({ eventStatus: "tcloaded", purposeConsents: { "1": false, "2": false } })),
    "rejected-all"
  );
  assert.equal(tcfObservedState(tcfRead({ purposeConsents: { "1": true, "2": false } })), "partial");

  // A single granted purpose cannot distinguish acceptance from necessity.
  assert.equal(tcfObservedState(tcfRead({ purposeConsents: { "1": true } })), "unknown");

  // An empty consent set is rejected-all only when GDPR provably applies.
  assert.equal(tcfObservedState(tcfRead({ purposeConsents: {} })), "rejected-all");
  assert.equal(tcfObservedState(tcfRead({ gdprApplies: null, purposeConsents: {} })), "unknown");
});

test("onetrustObservedState classifies only the unambiguous extremes", () => {
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0002:1,C0003:1"), { parsed: true, observed: "accepted-all" });
  // The single granted group is the always-active strictly-necessary one.
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0002:0,C0003:0"), { parsed: true, observed: "rejected-all" });
  assert.deepEqual(onetrustObservedState("groups=C0001:0,C0002:0"), { parsed: true, observed: "rejected-all" });
  // Two granted among three could be a reject with two always-active groups;
  // never guess "partial" from site-configured group ids.
  assert.deepEqual(onetrustObservedState("groups=C0001:1,C0002:1,C0003:0"), { parsed: true, observed: "unknown" });
  // A single group cannot distinguish accept from reject.
  assert.deepEqual(onetrustObservedState("groups=C0001:1"), { parsed: true, observed: "unknown" });
  // URL-encoded cookie values decode before parsing.
  assert.deepEqual(onetrustObservedState("groups%3DC0001%3A1%2CC0002%3A0"), { parsed: true, observed: "rejected-all" });
  // Surrounding OneTrust bookkeeping parameters are ignored.
  assert.deepEqual(
    onetrustObservedState("isGpcEnabled=0&datestamp=xyz&groups=C0001:1,C0002:0&geolocation=US"),
    { parsed: true, observed: "rejected-all" }
  );
});

test("onetrustObservedState refuses unparseable state instead of guessing", () => {
  assert.deepEqual(onetrustObservedState("datestamp=xyz&geolocation=US"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=C0001"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=C0001:2"), { parsed: false });
  assert.deepEqual(onetrustObservedState("groups=:1"), { parsed: false });
  assert.deepEqual(onetrustObservedState("%E0%A4%A"), { parsed: false });
});
