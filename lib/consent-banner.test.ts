import assert from "node:assert/strict";
import { test } from "node:test";
import { consentPlatformKindForDomain, detectConsentPlatform } from "./consent-banner";

test("detectConsentPlatform names a CMP from its loader host (suffix + exact)", () => {
  assert.equal(detectConsentPlatform([{ domain: "cdn.cookielaw.org" }])?.name, "OneTrust");
  assert.equal(detectConsentPlatform([{ domain: "consent.cookiebot.com" }])?.name, "Cookiebot");
  assert.equal(detectConsentPlatform([{ domain: "didomi.io" }])?.name, "Didomi");
  assert.equal(detectConsentPlatform([{ domain: "sdk.privacy-center.org.sp-prod.net" }])?.name, "Sourcepoint");
  assert.equal(detectConsentPlatform([{ domain: "mysite.mgr.consensu.org" }])?.name, "IAB TCF");
});

test("detectConsentPlatform reports the domain that revealed it and returns the first match", () => {
  const match = detectConsentPlatform([{ domain: "google-analytics.com" }, { domain: "geo.cookiebot.com" }]);
  // Deliberate shape update: every match now declares whether its name is a
  // vendor or a shared framework endpoint.
  assert.deepEqual(match, { name: "Cookiebot", domain: "geo.cookiebot.com", kind: "vendor" });
});

test("a shared framework endpoint carries the framework-endpoint kind, vendors carry vendor", () => {
  // *.consensu.org is IAB Europe's shared TCF endpoint, delegated to many
  // registered CMPs; its name identifies the standard, never the operator.
  assert.equal(
    detectConsentPlatform([{ domain: "mysite.mgr.consensu.org" }])?.kind,
    "framework-endpoint"
  );
  assert.equal(detectConsentPlatform([{ domain: "cdn.cookielaw.org" }])?.kind, "vendor");
  assert.equal(consentPlatformKindForDomain("mysite.mgr.consensu.org"), "framework-endpoint");
  assert.equal(consentPlatformKindForDomain("consensu.org"), "framework-endpoint");
  assert.equal(consentPlatformKindForDomain("geo.cookiebot.com"), "vendor");
  assert.equal(consentPlatformKindForDomain("google-analytics.com"), null);
});

test("detectConsentPlatform returns null when no CMP is present", () => {
  assert.equal(detectConsentPlatform([{ domain: "google-analytics.com" }, { domain: "facebook.net" }]), null);
});

test("detectConsentPlatform does not match a lookalike suffix", () => {
  // notcookielaw.org must not match cookielaw.org.
  assert.equal(detectConsentPlatform([{ domain: "notcookielaw.org" }]), null);
});
