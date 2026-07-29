import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyPageSubject,
  isLikelyBotWallPage,
  PAGE_SUBJECT_UNVERIFIED_STATE,
  SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE
} from "./bot-wall-classifier";

test("bot-wall classification requires a whole-title signature and corroborating visit facts", () => {
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Just a moment...",
      pageText: "Please wait while the article loads.",
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
      pageText: "A guide to reviewing your account security settings.",
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
      pageText: "This help article explains how to enable JavaScript.",
      status: 200,
      navigationSettled: true,
      totalRequests: 2
    }),
    false,
    "ordinary prose containing a challenge phrase is not a challenge title"
  );
  for (const pageTitle of ["Security check", "Captcha", "Enable JavaScript"]) {
    assert.equal(
      isLikelyBotWallPage({
        pageTitle,
        pageText: "Ordinary page content.",
        status: 200,
        navigationSettled: true,
        totalRequests: 1
      }),
      false,
      `${pageTitle} is generic page-controlled testimony even on a sparse page`
    );
  }
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Account security check results",
      pageText: "Account results",
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

test("a settled Amazon-like HTTP-200 robot page needs corroborating body and request-shape signals", () => {
  const amazonRobotText =
    "Enter the characters you see below. Sorry, we just need to make sure you're not a robot. " +
    "For best results, please make sure your browser is accepting cookies.";

  assert.equal(
    classifyPageSubject({
      pageTitle: "",
      pageText: amazonRobotText,
      status: 200,
      navigationSettled: true,
      totalRequests: 3
    }),
    SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE
  );
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "",
      pageText: amazonRobotText,
      status: 200,
      navigationSettled: true,
      totalRequests: 80
    }),
    false,
    "quoted challenge prose alone must not fail a normal-sized page"
  );
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "",
      pageText: "This short article quotes the instruction: Enter the characters you see below.",
      status: 200,
      navigationSettled: true,
      totalRequests: 2
    }),
    false,
    "one quoted challenge signature plus sparsity is not enough"
  );
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Robot Check",
      pageText: amazonRobotText,
      status: 200,
      navigationSettled: true,
      totalRequests: 40
    }),
    true,
    "a specific title and specific body phrase corroborate one another without a sparsity requirement"
  );
});

test("an unavailable content collector makes page-subject validity unknown", () => {
  assert.equal(
    classifyPageSubject({
      pageTitle: "Example Domain",
      pageText: "",
      pageTextAvailable: false,
      status: 200,
      navigationSettled: true,
      totalRequests: 4
    }),
    PAGE_SUBJECT_UNVERIFIED_STATE
  );
});

test("a blocking consent interstitial needs both a wall title and wall body", () => {
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Before you continue to Google",
      pageText: "Before you continue to Google, we use cookies and data to deliver and maintain our services.",
      status: 200,
      navigationSettled: true,
      totalRequests: 14
    }),
    true
  );
  assert.equal(
    isLikelyBotWallPage({
      pageTitle: "Example Domain",
      pageText: "We use cookies and data to improve this site. You can keep reading without choosing.",
      status: 200,
      navigationSettled: true,
      totalRequests: 2
    }),
    false,
    "a normal page with cookie-banner prose is not a blocking consent wall"
  );
});

test("a blocked response is named from its body when the title says nothing", () => {
  // zillow.com answers 403 with a PerimeterX "Press & Hold" interstitial under
  // an ordinary title. A title-only rule reported a specific, nameable block as
  // a generic HTTP error and threw away the reason. Reading the body is safe
  // here precisely because the status already failed quality on its own.
  const zillow = {
    pageTitle: "zillow.com",
    pageText: "Press & Hold to confirm you are a human",
    pageTextAvailable: true,
    status: 403,
    navigationSettled: true,
    totalRequests: 3
  };
  assert.equal(classifyPageSubject(zillow), SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE);

  // The gesture phrase alone is ordinary UI language and must not be enough.
  assert.equal(
    classifyPageSubject({ ...zillow, pageText: "Press and hold the shutter button to record video." }),
    "normal"
  );

  // A blocked page with no challenge evidence at all stays a plain HTTP error,
  // so the honest "the site refused this visit" wording is preserved.
  assert.equal(
    classifyPageSubject({ ...zillow, pageText: "Forbidden. You do not have access to this resource." }),
    "normal"
  );

  // On a SUCCESSFUL load the stricter rule still governs: one body signature is
  // not enough, because there no independent fact has failed and a page-
  // controlled phrase alone must never turn a healthy visit into a failed one.
  assert.equal(
    classifyPageSubject({ ...zillow, status: 200, pageText: "Press & Hold to verify" }),
    "normal"
  );
  // Two distinct signatures plus a sparse shape do clear that bar, which is the
  // existing HTTP-200 interstitial rule and stays unchanged.
  assert.equal(
    classifyPageSubject({
      ...zillow,
      status: 200,
      pageText: "Press & Hold to confirm you are a human"
    }),
    SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_STATE
  );
});
