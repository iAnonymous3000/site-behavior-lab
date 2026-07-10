import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPrivacyPolicySummary,
  classifyEntityMentions,
  extractPolicyClaims,
  MIN_POLICY_TEXT_LENGTH,
  pickPrivacyPolicyLink
} from "./privacy-policy";

const PAD = " Lorem ipsum privacy boilerplate.".repeat(30);

test("pickPrivacyPolicyLink prefers a same-site privacy policy link", () => {
  const url = pickPrivacyPolicyLink(
    [
      { href: "https://cdn.partner.example/privacy", text: "Privacy Policy" },
      { href: "https://shop.example/legal/privacy-policy", text: "Privacy Policy" },
      { href: "https://shop.example/careers", text: "Careers" }
    ],
    "www.shop.example"
  );
  assert.equal(url, "https://shop.example/legal/privacy-policy");
});

test("pickPrivacyPolicyLink picks the real /privacy/ policy over a 'Privacy features' marketing page", () => {
  // Reproduces the brave.com miss: the marketing link's text contains the word
  // "privacy" while the actual policy's link text ("Brave Browser") does not.
  const url = pickPrivacyPolicyLink(
    [
      { href: "https://brave.com/privacy-features/", text: "Privacy features" },
      { href: "https://brave.com/web-standards-at-brave/4-global-privacy-control/", text: "Global Privacy Control" },
      { href: "https://brave.com/privacy-updates/", text: "Privacy updates" },
      { href: "https://brave.com/privacy/browser/", text: "Brave Browser" },
      { href: "https://brave.com/privacy/website/", text: "Website & email" }
    ],
    "brave.com"
  );
  assert.equal(url, "https://brave.com/privacy/browser/");
});

test("pickPrivacyPolicyLink breaks ties toward the shallowest (most canonical) policy path", () => {
  const url = pickPrivacyPolicyLink(
    [
      { href: "https://shop.example/legal/privacy/mobile-app/", text: "Privacy" },
      { href: "https://shop.example/privacy/", text: "Privacy" }
    ],
    "shop.example"
  );
  assert.equal(url, "https://shop.example/privacy/");
});

test("pickPrivacyPolicyLink ignores a bare 'privacy' mention with no policy path", () => {
  assert.equal(
    pickPrivacyPolicyLink(
      [
        { href: "https://shop.example/why-privacy-matters", text: "Why privacy matters to us" },
        { href: "https://shop.example/blog/privacy-tips", text: "Our privacy tips" }
      ],
      "shop.example"
    ),
    null
  );
});

test("pickPrivacyPolicyLink accepts a known policy-hosting service but not arbitrary off-site policies", () => {
  // A CMP-hosted document is still the site's own policy.
  assert.equal(
    pickPrivacyPolicyLink([{ href: "https://app.termly.io/document/privacy-policy/abc", text: "Privacy Policy" }], "shop.example"),
    "https://app.termly.io/document/privacy-policy/abc"
  );
  // Another company's policy (Cloudflare challenge page, reCAPTCHA badge) must
  // never be attributed to the scanned site.
  assert.equal(
    pickPrivacyPolicyLink(
      [
        { href: "https://www.cloudflare.com/privacypolicy/", text: "Privacy Policy" },
        { href: "https://policies.google.com/privacy", text: "Privacy Policy" }
      ],
      "shop.example"
    ),
    null
  );
});

test("pickPrivacyPolicyLink never picks Do Not Sell opt-out links or non-http schemes", () => {
  assert.equal(
    pickPrivacyPolicyLink(
      [
        { href: "https://shop.example/dns", text: "Do Not Sell My Personal Information" },
        { href: "javascript:openPrivacy()", text: "Privacy Policy" }
      ],
      "shop.example"
    ),
    null
  );
});

test("extractPolicyClaims matches first-person testable statements with quotes", () => {
  const claims = extractPolicyClaims(
    "About us. We do not use third-party cookies on this website. " +
      "We will not sell your personal information to anyone. " +
      "We honor the Global Privacy Control signal as a valid opt-out."
  );

  const kinds = claims.map((claim) => claim.kind).sort();
  assert.deepEqual(kinds, ["honors-gpc", "no-selling-or-sharing", "no-third-party-cookies"]);
  const cookieClaim = claims.find((claim) => claim.kind === "no-third-party-cookies");
  assert.ok(cookieClaim?.quote.includes("third-party cookies"));
});

test("extractPolicyClaims never reads a negated GPC sentence as an honors-gpc claim", () => {
  // Each of these states the OPPOSITE of honoring GPC; extracting them as
  // support would invert the policy's meaning.
  for (const sentence of [
    "We do not honor Global Privacy Control signals.",
    "Our systems will not process Global Privacy Control signals at this time.",
    "This website does not currently recognize Global Privacy Control.",
    "We cannot honor Global Privacy Control requests."
  ]) {
    assert.deepEqual(extractPolicyClaims(sentence), [], sentence);
  }

  // The plain positive statement still extracts.
  const positive = extractPolicyClaims("We honor Global Privacy Control signals.");
  assert.deepEqual(
    positive.map((claim) => claim.kind),
    ["honors-gpc"]
  );
});

test("extractPolicyClaims ignores opt-out link labels and scoped cookie statements", () => {
  const claims = extractPolicyClaims(
    "Do Not Sell Or Share My Personal Information. " +
      "We do not use cookies for advertising purposes. " +
      "Your Privacy Choices."
  );
  assert.deepEqual(claims, []);
});

test("extractPolicyClaims matches a blanket no-cookies statement", () => {
  const claims = extractPolicyClaims("We do not use cookies on this site at all.");
  assert.deepEqual(
    claims.map((claim) => claim.kind),
    ["no-cookies"]
  );
});

test("classifyEntityMentions applies aliases (Facebook counts as Meta, Twitter as X)", () => {
  const { mentioned, unmentioned } = classifyEntityMentions(
    "We share data with Facebook and with Twitter for advertising.",
    ["Meta", "X", "Criteo"]
  );
  assert.deepEqual(mentioned, ["Meta", "X"]);
  assert.deepEqual(unmentioned, ["Criteo"]);
});

test("buildPrivacyPolicySummary rejects text too short to be a real policy", () => {
  assert.equal(
    buildPrivacyPolicySummary({ url: "https://shop.example/privacy", policyText: "404 not found", trackingEntities: ["Meta"] }),
    null
  );
});

test("buildPrivacyPolicySummary builds claims and mention lists from real-length text", () => {
  const text = `We do not use third-party cookies. We work with Google for analytics.${PAD}`;
  assert.ok(text.length >= MIN_POLICY_TEXT_LENGTH);

  const summary = buildPrivacyPolicySummary({
    url: "https://shop.example/privacy",
    policyText: text,
    trackingEntities: ["Google", "Meta"]
  });

  assert.ok(summary);
  assert.deepEqual(
    summary.claims.map((claim) => claim.kind),
    ["no-third-party-cookies"]
  );
  assert.deepEqual(summary.mentionedEntities, ["Google"]);
  assert.deepEqual(summary.unmentionedEntities, ["Meta"]);
  assert.equal(summary.policyTextLength, text.length);
});
