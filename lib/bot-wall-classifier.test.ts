import assert from "node:assert/strict";
import { test } from "node:test";
import { isLikelyBotWallPage } from "./bot-wall-classifier";

test("bot-wall classification requires a whole-title signature and corroborating visit facts", () => {
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Just a moment...",
      status: 200,
      navigationSettled: true,
      totalRequests: 4
    }),
    false,
    "a sparse successful page remains a successful page even with a challenge-like title"
  );
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Security check",
      status: 200,
      navigationSettled: true,
      totalRequests: 20
    }),
    false,
    "a title alone must not fail an otherwise healthy visit"
  );
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "How to enable JavaScript in your browser",
      status: 200,
      navigationSettled: true,
      totalRequests: 2
    }),
    false,
    "ordinary prose containing a challenge phrase is not a challenge title"
  );
  for (const pageTitle of ["Security check", "Captcha", "Enable JavaScript"]) {
    assert.equal(
      isLikelyBotWallPage({ pageTitle, status: 200, navigationSettled: true, totalRequests: 1 }),
      false,
      `${pageTitle} is generic page-controlled testimony even on a sparse page`
    );
  }
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Account security check results",
      status: 429,
      navigationSettled: false,
      totalRequests: 1
    }),
    false,
    "HTTP/navigation quality remains independent of an unrelated title"
  );
});

test("bot-wall classification recognizes vendor title variants without exposing raw titles", () => {
  for (const pageTitle of [
    "Attention Required! | Cloudflare",
    "Checking your browser before accessing example.com...",
    "Request unsuccessful. Incapsula incident ID: 123",
    "Unusual traffic from your computer network"
  ]) {
    assert.equal(
      isLikelyBotWallPage({ pageTitle, status: 200, navigationSettled: false, totalRequests: 8 }),
      true,
      pageTitle
    );
  }
});
