import assert from "node:assert/strict";
import { test } from "node:test";
import allowlists from "./redaction-allowlists.json";
import {
  isRedactedNameMarker,
  isReviewedCookieName,
  isReviewedStorageKey,
  omitUnreviewedNames,
} from "./public-name-policy";

// The public-name policy is the composition of the reviewed allowlist and the
// terminal redaction markers; the standalone composed exports were removed as
// unused, so these tests compose the two surviving predicates the same way
// their production consumers do.
function isPublicCookieName(value: string): boolean {
  return isReviewedCookieName(value) || isRedactedNameMarker(value);
}
function isPublicStorageKey(value: string): boolean {
  return isReviewedStorageKey(value) || isRedactedNameMarker(value);
}

test("the reviewed GitHub literals are versioned and public while arbitrary identifiers remain private", () => {
  assert.equal(allowlists.version, "allowlists-v3");
  assert.equal(allowlists.cookieNames.version, "cookie-v2");
  assert.equal(allowlists.storageKeys.version, "storage-v2");

  for (const name of ["_octo", "logged_in", "cpu_bucket", "preferred_color_mode", "tz", "_gh_sess"]) {
    assert.equal(isReviewedCookieName(name), true);
    assert.equal(isPublicCookieName(name), true);
  }
  assert.equal(isReviewedStorageKey("soft-nav:marker"), true);
  assert.equal(isPublicStorageKey("soft-nav:marker"), true);

  assert.equal(isReviewedCookieName("alice_private_session"), false);
  assert.equal(isPublicCookieName("alice_private_session"), false);
  assert.equal(isReviewedStorageKey("alice@example.com"), false);
  assert.equal(isPublicStorageKey("alice@example.com"), false);
});

test("only the closed terminal marker vocabulary is accepted as a redacted public name", () => {
  for (const marker of [
    "[redacted]",
    "[redacted:uuid-like]",
    "[redacted:numeric]",
    "[redacted:hex-like]",
    "[redacted:long-token]"
  ]) {
    assert.equal(isRedactedNameMarker(marker), true);
    assert.equal(isPublicCookieName(marker), true);
    assert.equal(isPublicStorageKey(marker), true);
  }
  assert.equal(isRedactedNameMarker("[redacted:invented]"), false);
  assert.equal(isPublicCookieName("[redacted:invented]"), false);
  assert.equal(isPublicStorageKey("[redacted:invented]"), false);
});

test("presentation filtering shows only reviewed literals without mutating its source", () => {
  const changes = [
    { name: "_octo", domain: "example.com" },
    { name: "[redacted]", domain: "example.com" },
    { name: "logged_in", domain: "example.com" },
    { name: "[redacted:uuid-like]", domain: "example.com" },
    { name: "alice_private_session", domain: "example.com" },
    { name: "[redacted:invented]", domain: "example.com" }
  ];
  const before = structuredClone(changes);
  const filtered = omitUnreviewedNames(changes, (change) => change.name, "cookie");

  assert.deepEqual(filtered, {
    entries: [
      { name: "_octo", domain: "example.com" },
      { name: "logged_in", domain: "example.com" }
    ],
    omitted: 4
  });
  assert.deepEqual(changes, before);
});
