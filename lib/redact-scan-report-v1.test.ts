import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PAGE_SUBJECT_UNVERIFIED_WARNING } from "./bot-wall-classifier";
import { ACTIVE_PROBE_SUBJECT_WARNING, CONSENT_RELOAD_SUBJECT_WARNING } from "./active-probe-subject-warnings";
import {
  compareScanResults,
  createGpcComparisonReport,
  createShieldsComparisonReport
} from "./compare-reports";
import { runHitResponseByteCap, runHitUploadByteCap } from "./comparison-eligibility";
import { CONSENT_PROBE_OUTCOMES, consentInteractionWarning } from "./consent-interaction";
import { summarizeDomains } from "./domain-summaries";
import {
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION,
  NODE_SHIELDS_REQUEST_CONTEXT_VERSION,
  recordedPlaywrightVersion
} from "./legacy-methodology";
import { isCurrentlyCheckablePolicyClaim } from "./privacy-policy";
import {
  assertKnownPixelEventVocabulary,
  PUBLIC_STRING_POLICY_DIGEST,
  publicStringPolicyInputs,
  redactPixelEvents,
  redactPrivacyPolicy,
  redactScanReportV1,
  redactScanResultV1,
  redactScannerWarnings,
  redactTrackerMatch,
  RedactionPass,
  scrubPolicyQuoteIdentifiers
} from "./redact-scan-report-v1";
import { prepareScanReportBundle } from "./report-store";
import { canonicalJson } from "./scan-report-v2-fingerprints";
import { sha256Hex } from "./sha256";
import { scannerDisclosure } from "./scan-condition-disclosure";
import {
  aggregateByteBudgetWarning,
  AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING,
  FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING,
  FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING,
  KEYSTROKE_PROBE_PAGE_LEFT_WARNING,
  KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING,
  KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING,
  LISTENER_DETECTION_WITHHELD_WARNING,
  PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING
} from "./scan-runtime";
import { readStoredScanReport } from "./scan-report-reader";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { canonicalTrackerCatalogContents, findTrackerMatch } from "./tracker-catalog";
import { PRIVATE_SUFFIX_TENANT_SHAPES, redactHostnameV2 } from "./redaction-v2";
import type {
  FingerprintDetectionSummary,
  NetworkRequestRecord,
  PrivacyPolicyClaim,
  ScanResult,
  TrackerMatch
} from "./types";

const TOKEN_HOST = "a8f3c9d2e1b4f6a7.google-analytics.com";

function sensitiveSingle(): ScanResult {
  const report = makeScanReportV1() as ScanResult;
  report.summary.pageTitle = "  Anna\u0000 Schmidt's private dashboard  ";
  report.summary.firstPartyDomain = "patient-a8f3c9d2e1b4f6a7.example.com";
  report.conditions = {
    ...report.conditions,
    requestedUrl: "https://patient-a8f3c9d2e1b4f6a7.example.com/patients/anna-schmidt?token=secret",
    finalUrl: "https://patient-a8f3c9d2e1b4f6a7.example.com/account/12345"
  };
  report.requests = [
    {
      id: 1,
      url: `https://${TOKEN_HOST}/collect/anna-schmidt?email=x&utm_source=y`,
      domain: TOKEN_HOST,
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      tracker: {
        domain: "google-analytics.com",
        entity: "Google",
        category: "analytics / tag management",
        confidence: "curated"
      },
      provenance: {
        graphRecordId: "https://patient.example/anna",
        initiatorId: "element-1",
        initiatorType: "element",
        initiatorUrl: "https://patient-a8f3c9d2e1b4f6a7.example.com/profile/anna",
        initiatorDomain: "patient-a8f3c9d2e1b4f6a7.example.com",
        scriptId: "script-1",
        scriptUrl: `https://${TOKEN_HOST}/users/anna/script.js`,
        scriptDomain: TOKEN_HOST,
        injectedById: "anna@example.com",
        injectedByUrl: `https://${TOKEN_HOST}/loader/secret`,
        injectedByDomain: TOKEN_HOST
      },
      startedAtMs: 10
    }
  ];
  report.cookies = [
    {
      name: "anna_session_123",
      domain: `.${TOKEN_HOST}`,
      path: "/patients/anna-schmidt;sid=secret",
      sameSite: "Lax",
      secure: true,
      httpOnly: true,
      session: true,
      thirdParty: true
    }
  ];
  report.storage = [{ area: "localStorage", key: "anna_private_record", valueBytes: 12 }];
  report.fingerprintDetections = [
    {
      kind: "session-recording",
      heuristic: "interaction-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["input"],
        listenerTargets: ["document"],
        thirdPartyOrigins: [`https://${TOKEN_HOST}/users/anna`],
        totalListenerCalls: 1
      }
    },
    {
      kind: "keystroke-exfiltration",
      heuristic: "input-sentinel-exfiltration-v1",
      count: 1,
      evidence: {
        recipients: [TOKEN_HOST],
        encodings: ["plain"],
        fieldsTyped: 1,
        fieldTypes: ["text"]
      }
    }
  ];
  report.cnameCloaks = [
    {
      host: "patient-a8f3c9d2e1b4f6a7.example.com",
      cname: TOKEN_HOST,
      tracker: {
        domain: "google-analytics.com",
        entity: "Google",
        category: "analytics / tag management",
        confidence: "curated"
      }
    }
  ];
  report.privacyPolicy = {
    url: "https://example.com/legal/anna-policy?patient=secret",
    claims: [{ kind: "no-cookies", quote: "We do not use cookies.\u0000" }],
    mentionedEntities: ["Google"],
    unmentionedEntities: [],
    policyTextLength: 1_000
  };
  report.consentInteraction = {
    mode: "reject-all",
    clicked: true,
    cmp: "Anna CMP",
    selector: "#anna-private-choice",
    matchedText: "reject all",
    frameUrl: `https://${TOKEN_HOST}/consent/anna`
  };
  report.pixelEvents = [
    {
      platform: "Meta",
      product: "Anna's private pixel",
      events: ["Purchase", "Anna Schmidt"],
      advancedMatching: ["email", "secret" as "email"],
      requests: 1
    },
    {
      platform: "Anna Analytics",
      product: "Private pixel",
      events: ["Anna"],
      advancedMatching: [],
      requests: 1
    }
  ];
  report.share = {
    id: "20260712-0123456789abcdef0123456789abcdef",
    path: "/reports/anna",
    jsonPath: "https://patient.example/anna.json"
  };
  report.screenshot = "data:image/jpeg;base64,submitter-only";
  report.warnings = [
    "  The page did not reach network idle before the scan window ended.\u0000  ",
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget.",
    "The scan stopped forwarding additional request bytes after reaching the 16 MiB aggregate upload-byte budget.",
    'The two visits ran in randomized order; the "GPC on" visit ran first.',
    `Blocked a request that could not be verified as public: https://${TOKEN_HOST}/users/anna?token=secret`,
    "Patient Anna's private warning",
    // A page-controlled label must never ride the counterbalancing sentence.
    'The two visits ran in randomized order; the "Anna Schmidt" visit ran first.'
  ];
  return report;
}

test("v1 redaction preserves exact current and historical canonical scanner disclosures only", () => {
  const report = makeScanReportV1() as ScanResult;
  report.conditions.scannerEgress = "this scanner instance";
  report.conditions.shieldsMode = "classification";
  const input = {
    chromiumVersion: report.conditions.chromiumVersion,
    locale: report.conditions.locale,
    scannerEgress: report.conditions.scannerEgress,
    shieldsMode: report.conditions.shieldsMode,
    timezone: report.conditions.timezone
  };
  const current = scannerDisclosure("node-playwright", input);
  report.conditions.scannerDisclosure = current;
  assert.equal(redactScanResultV1(report).report.conditions.scannerDisclosure, current);

  const historicalMethodology =
    "shields-request-context-v2-adblock-rust-0.12.3-request-method-v1-playwright-1.61.0";
  const historical = current
    .replace(`Playwright ${NODE_PLAYWRIGHT_VERSION}`, "Playwright 1.61.0")
    .replace(NODE_SCANNER_METHODOLOGY_VERSION, historicalMethodology);
  report.conditions.scannerDisclosure = historical;
  assert.equal(redactScanResultV1(report).report.conditions.scannerDisclosure, historical);

  const previous = current
    .replace(` using Playwright ${NODE_PLAYWRIGHT_VERSION}`, "")
    .replace(
      NODE_SCANNER_METHODOLOGY_VERSION,
      NODE_SHIELDS_REQUEST_CONTEXT_VERSION.replace(
        /adblock-rust-\d+\.\d+\.\d+/,
        "adblock-rust-0.12.3"
      )
    );
  report.conditions.scannerDisclosure = previous;
  assert.equal(redactScanResultV1(report).report.conditions.scannerDisclosure, previous);

  report.conditions.scannerDisclosure = historical.replace("using Playwright 1.61.0", "using Playwright 1.60.0");
  assert.match(redactScanResultV1(report).report.conditions.scannerDisclosure, /invalid and was removed/);

  report.conditions.scannerDisclosure = `${historical} untrusted suffix`;
  assert.match(redactScanResultV1(report).report.conditions.scannerDisclosure, /invalid and was removed/);

  report.conditions.scannerDisclosure = historical.replace("adblock-rust-0.12.3", "adblock-rust-00.12.3");
  assert.match(redactScanResultV1(report).report.conditions.scannerDisclosure, /invalid and was removed/);
});

test("a reviewed superseded methodology survives the toolchain move that retired it", () => {
  // The regexes above only reconstruct disclosures whose methodology token ENDS
  // at the Playwright version. A report published under an extended identity is
  // a fixed point only while that identity is current, so a Playwright move
  // orphans it unless the outgoing identity joins the reviewed list. The
  // committed corpus proves this today, but retention may prune those reports;
  // this pins the contract independently of what the corpus still holds.
  const report = makeScanReportV1() as ScanResult;
  report.conditions.scannerEgress = "this scanner instance";
  report.conditions.shieldsMode = "classification";
  const current = scannerDisclosure("node-playwright", {
    chromiumVersion: report.conditions.chromiumVersion,
    locale: report.conditions.locale,
    scannerEgress: report.conditions.scannerEgress,
    shieldsMode: report.conditions.shieldsMode,
    timezone: report.conditions.timezone
  });
  const supersededMethodology =
    "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.0+subject-validity-v2+detector-coverage-v2";
  const superseded = current
    .replace(`Playwright ${NODE_PLAYWRIGHT_VERSION}`, "Playwright 1.62.0")
    .replace(NODE_SCANNER_METHODOLOGY_VERSION, supersededMethodology);
  report.conditions.scannerDisclosure = superseded;
  assert.equal(redactScanResultV1(report).report.conditions.scannerDisclosure, superseded);

  // The line the 2026-09 toolchain epoch retired moved the ad-block engine as
  // well as Playwright; both components come from the reviewed literal.
  const toolchainMethodology =
    "shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.1+subject-validity-v3+detector-coverage-v2";
  assert.notEqual(toolchainMethodology, NODE_SCANNER_METHODOLOGY_VERSION);
  const toolchainSuperseded = current
    .replace(`Playwright ${NODE_PLAYWRIGHT_VERSION}`, "Playwright 1.62.1")
    .replace(NODE_SCANNER_METHODOLOGY_VERSION, toolchainMethodology);
  report.conditions.scannerDisclosure = toolchainSuperseded;
  assert.equal(redactScanResultV1(report).report.conditions.scannerDisclosure, toolchainSuperseded);

  // The line subject-validity-v4 retired kept the current Playwright and
  // ad-block engine: only a methodology component moved. Production recorded
  // it with no committed report to prove it.
  const subjectValidityMethodology =
    "shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v3+detector-coverage-v2";
  assert.notEqual(subjectValidityMethodology, NODE_SCANNER_METHODOLOGY_VERSION);
  assert.equal(recordedPlaywrightVersion(subjectValidityMethodology), NODE_PLAYWRIGHT_VERSION);
  const subjectValiditySuperseded = current.replace(NODE_SCANNER_METHODOLOGY_VERSION, subjectValidityMethodology);
  assert.notEqual(subjectValiditySuperseded, current);
  report.conditions.scannerDisclosure = subjectValiditySuperseded;
  assert.equal(redactScanResultV1(report).report.conditions.scannerDisclosure, subjectValiditySuperseded);

  // An unreviewed extended identity is still refused: the reviewed list is
  // exact, so a report cannot mint its own methodology tail and publish it.
  report.conditions.scannerDisclosure = current
    .replace(`Playwright ${NODE_PLAYWRIGHT_VERSION}`, "Playwright 1.62.0")
    .replace(NODE_SCANNER_METHODOLOGY_VERSION, `${supersededMethodology}+unreviewed-suffix-v1`);
  assert.match(redactScanResultV1(report).report.conditions.scannerDisclosure, /invalid and was removed/);
});

test("the v1 transform sanitizes every page-controlled field without mutating its input", () => {
  const input = sensitiveSingle();
  const before = JSON.stringify(input);
  const { report, counters } = redactScanResultV1(input);

  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(report).includes("anna-schmidt"), false);
  assert.equal(JSON.stringify(report).includes("anna_private_record"), false);
  assert.equal(JSON.stringify(report).includes("patient-a8f3c9d2e1b4f6a7"), false);
  assert.equal(report.summary.pageTitle, "", "page-authored titles never persist in public reports");
  assert.equal(report.conditions.requestedUrl, "https://{label}.example.com/{seg}/{seg}");
  assert.equal(report.conditions.finalUrl, "https://{label}.example.com/account/{n}");
  assert.equal(report.requests[0].url, "https://{label}.google-analytics.com/{seg}/{seg}?%5Bredacted%5D=&utm_source=");
  assert.equal(report.requests[0].domain, "{label}.google-analytics.com");
  assert.equal(report.requests[0].provenance?.graphRecordId, "id-000001");
  assert.equal(report.requests[0].provenance?.initiatorId, "id-000002");
  assert.equal(report.requests[0].provenance?.initiatorType, "[redacted]");
  assert.equal(report.requests[0].provenance?.scriptId, "id-000003");
  assert.equal(report.requests[0].provenance?.injectedById, "id-000004");
  assert.equal(report.requests[0].provenance?.scriptUrl, "https://{label}.google-analytics.com/{seg}/{seg}/{seg}");
  assert.equal(report.cookies[0].name, "[redacted:long-token]");
  assert.equal(report.cookies[0].domain, ".{label}.google-analytics.com");
  assert.equal(report.cookies[0].path, "/{seg}/{seg}");
  assert.equal(report.storage[0].key, "[redacted]");
  assert.equal(report.domains.length, 1);
  assert.equal(report.domains[0].domain, "{label}.google-analytics.com");
  assert.equal(report.summary.totalRequests, 1);
  assert.equal(report.summary.thirdPartyDomains, 1);
  assert.equal(report.summary.cookies, 1);
  assert.equal(report.summary.storageEntries, 1);
  assert.equal(report.cnameCloaks?.[0].cname, "{label}.google-analytics.com");
  assert.equal(report.privacyPolicy?.url, "https://example.com/legal/{seg}");
  assert.equal(report.consentInteraction?.cmp, "[redacted]");
  assert.equal(report.consentInteraction?.selector, "[redacted]");
  assert.equal(report.consentInteraction?.matchedText, "reject all");
  assert.equal(report.consentInteraction?.frameUrl, "https://{label}.google-analytics.com/{seg}/{seg}");
  assert.deepEqual(report.pixelEvents, [
    {
      platform: "Meta",
      product: "Meta Pixel",
      events: ["custom event", "Purchase"],
      advancedMatching: ["email"],
      requests: 1
    }
  ]);
  assert.equal(report.share, undefined);
  assert.equal(report.screenshot, "data:image/jpeg;base64,submitter-only");
  assert.deepEqual(report.warnings, [
    "The page did not reach network idle before the scan window ended.",
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget.",
    "The scan stopped forwarding additional request bytes after reaching the 16 MiB aggregate upload-byte budget.",
    'The two visits ran in randomized order; the "GPC on" visit ran first.',
    "Blocked a request that could not be verified as public: https://{label}.google-analytics.com/{seg}/{seg}",
    "[redacted warning]"
  ]);
  assert.ok(counters.pathSegmentsGeneralized > 0);
  assert.ok(counters.subdomainLabelsGeneralized > 0);
  assert.equal(counters.cookieNamesRedacted, 1);
  assert.equal(counters.storageKeysRedacted, 1);
  assert.equal(readStoredScanReport(report).ok, true);
});

test("the scanner's emitted byte-budget warnings survive redaction and still trip the cap-censoring gates", () => {
  const input = sensitiveSingle();
  input.warnings = [
    aggregateByteBudgetWarning("response", 64 * 1024 * 1024),
    aggregateByteBudgetWarning("upload", 16 * 1024 * 1024)
  ];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, input.warnings);
  assert.equal(runHitResponseByteCap(report), true);
  assert.equal(runHitUploadByteCap(report), true);
});

test("the invalid-upstream-response warning survives the public redaction boundary", () => {
  const input = sensitiveSingle();
  input.warnings = [INVALID_UPSTREAM_RESPONSE_WARNING];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [INVALID_UPSTREAM_RESPONSE_WARNING]);
});

test("the unsettled routed-request disclosure survives the public boundary", () => {
  // v1 has no quality block, so this line is the only thing separating a visit
  // whose request evidence was cut short from one that saw everything.
  const input = sensitiveSingle();
  input.warnings = [UNSETTLED_ROUTED_REQUEST_WARNING];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [UNSETTLED_ROUTED_REQUEST_WARNING]);
});

test("the unverified page-subject disclosure survives the public boundary", () => {
  const input = sensitiveSingle();
  input.warnings = [PAGE_SUBJECT_UNVERIFIED_WARNING];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [PAGE_SUBJECT_UNVERIFIED_WARNING]);
});

test("the incomplete pixel-decoder disclosure survives the public boundary", () => {
  const input = sensitiveSingle();
  input.warnings = [PIXEL_DECODE_CAPTURE_LOSS_WARNING];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [PIXEL_DECODE_CAPTURE_LOSS_WARNING]);
});

test("both fingerprint-observer disclosures survive the public boundary", () => {
  // The frame line stays admitted for every report that carries it; the
  // listener line is the fingerprint-observer@4 widening beside it.
  const input = sensitiveSingle();
  input.warnings = [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING, FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING, FINGERPRINT_LISTENER_ATTRIBUTION_LOSS_WARNING]);
});

test("the incomplete synthetic-input probe disclosure survives the public boundary", () => {
  const input = sensitiveSingle();
  input.warnings = [KEYSTROKE_PROBE_INCOMPLETE_WARNING];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [KEYSTROKE_PROBE_INCOMPLETE_WARNING]);
});

test("the input probe's unread-request disclosure survives the public boundary, alone and labeled", () => {
  // v1's only record that a finished probe stopped or could not read a
  // request that may have carried its test value. Replaced by the redacted
  // marker, the keystroke claim would publish the absence r2 withholds.
  const input = sensitiveSingle();
  input.warnings = [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING];
  const first = redactScanResultV1(input).report;
  assert.deepEqual(first.warnings, [KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING]);
  assert.equal(JSON.stringify(redactScanResultV1(first).report), JSON.stringify(first));
  assert.deepEqual(
    redactScannerWarnings([`Shields on: ${KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING}`], new RedactionPass()),
    [`Shields on: ${KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING}`]
  );
});

test("the input probe's incomplete-test and stopped-navigation lines survive the public boundary, alone and labeled", () => {
  // v1's only records that the probe did not complete its test for a cause
  // other than a request, and that its route stopped a navigation. Replaced by
  // the redacted marker, the keystroke claim or the request family would read
  // as complete where r2 withholds it. The subject-loss lines v1 readers now
  // also read for the keystroke claim were admitted before and stay so.
  for (const warning of [
    KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING,
    KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING,
    CONSENT_RELOAD_SUBJECT_WARNING,
    ACTIVE_PROBE_SUBJECT_WARNING
  ]) {
    const input = sensitiveSingle();
    input.warnings = [warning];
    const first = redactScanResultV1(input).report;
    assert.deepEqual(first.warnings, [warning], warning);
    assert.equal(JSON.stringify(redactScanResultV1(first).report), JSON.stringify(first), warning);
    assert.deepEqual(
      redactScannerWarnings([`Shields on: ${warning}`], new RedactionPass()),
      [`Shields on: ${warning}`],
      warning
    );
  }
});

test("the lines for a page that left the site or opened a window survive the public boundary, alone and labeled", () => {
  // v1's only records of the request, cookie, storage and fingerprinting
  // losses r2 records when the page leaves before its state is read or while
  // the input probe runs, and when the context route blocks a window the page
  // opened. Replaced by the redacted marker, each family would read as
  // complete where r2 withholds it.
  for (const warning of [
    PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING,
    KEYSTROKE_PROBE_PAGE_LEFT_WARNING,
    AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING
  ]) {
    const input = sensitiveSingle();
    input.warnings = [warning];
    const first = redactScanResultV1(input).report;
    assert.deepEqual(first.warnings, [warning], warning);
    assert.equal(JSON.stringify(redactScanResultV1(first).report), JSON.stringify(first), warning);
    assert.deepEqual(
      redactScannerWarnings([`Shields on: ${warning}`], new RedactionPass()),
      [`Shields on: ${warning}`],
      warning
    );
  }
});

test("every consent disclosure the producer can emit survives the public boundary", () => {
  // The three failure sentences are the ones that say the INSTRUMENT failed
  // rather than the site. Admitting only the completed-search default replaced
  // exactly those with the placeholder, so the reader lost the disclosure on
  // every run where the probe could not do its job.
  for (const mode of ["accept-all", "reject-all"] as const) {
    for (const failure of CONSENT_PROBE_OUTCOMES) {
      const warning = consentInteractionWarning({ mode, clicked: false }, failure);
      const input = sensitiveSingle();
      input.warnings = [warning];

      const { report } = redactScanResultV1(input);
      assert.deepEqual(report.warnings, [warning], `${mode}/${failure ?? "searched"} was not admitted`);
    }
  }
});

test("valid generated consent and share literals survive exactly while invalid capability paths do not", () => {
  const input = sensitiveSingle();
  input.consentInteraction = {
    mode: "accept-all",
    clicked: true,
    cmp: "OneTrust",
    selector: "#onetrust-accept-btn-handler",
    matchedText: "Accept all!"
  };
  input.share = {
    id: "20260712-0123456789abcdef0123456789abcdef",
    path: "/reports/20260712-0123456789abcdef0123456789abcdef/",
    jsonPath: "/reports/20260712-0123456789abcdef0123456789abcdef.json"
  };

  const first = redactScanResultV1(input).report;
  const second = redactScanResultV1(first).report;
  assert.deepEqual(first.consentInteraction, {
    mode: "accept-all",
    clicked: true,
    cmp: "OneTrust",
    selector: "#onetrust-accept-btn-handler",
    matchedText: "accept all"
  });
  assert.deepEqual(first.share, input.share);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("the full report transform is byte-idempotent and rebuilds comparison diffs from sanitized arms", () => {
  const baseline = sensitiveSingle();
  baseline.conditions.gpcEnabled = false;
  const variant = sensitiveSingle();
  variant.conditions.gpcEnabled = true;
  variant.cookies.push({
    name: "another_private_cookie",
    domain: `.${TOKEN_HOST}`,
    path: "/users/bob",
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: true,
    thirdParty: true
  });
  const comparison = createGpcComparisonReport(baseline, variant);
  const first = redactScanReportV1(comparison);
  const second = redactScanReportV1(first.report);

  assert.equal(first.report.schemaVersion, 1);
  assert.equal(first.report.title, "GPC off/on comparison", "trusted producer-owned comparison titles survive");
  assert.equal(first.report.baseline.summary.pageTitle, "");
  assert.equal(first.report.variant.summary.pageTitle, "");
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
  assert.deepEqual(first.report.diff, compareScanResults(first.report.baseline, first.report.variant));
  assert.equal(JSON.stringify(first.report.diff).includes("private_cookie"), false);
  assert.equal(first.report.requestedUrl, "https://{label}.example.com/{seg}/{seg}");
  assert.deepEqual(second.counters, {
    pathSegmentsGeneralized: 0,
    queryKeysRedacted: 0,
    storageKeysRedacted: 0,
    cookieNamesRedacted: 0,
    matrixParamsStripped: 0,
    subdomainLabelsGeneralized: 0,
    malformedUrlsDropped: 0
  });
  assert.equal(readStoredScanReport(first.report).ok, true);
});

test("v1 redaction preserves a reviewed historical tracker-catalog identity", () => {
  const report = sensitiveSingle();
  report.conditions.trackerCatalog = {
    source: "Hand-curated service catalog",
    version: "hand-curated-2026.06",
    region: "US-biased",
    entries: 133,
    curatedOverrides: 133,
    license: "AGPL-3.0-or-later"
  };

  const first = redactScanResultV1(report).report;
  const second = redactScanResultV1(first).report;
  assert.deepEqual(first.conditions.trackerCatalog, report.conditions.trackerCatalog);
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  report.conditions.trackerCatalog = {
    ...report.conditions.trackerCatalog,
    version: "self-declared-catalog"
  };
  assert.notEqual(
    redactScanResultV1(report).report.conditions.trackerCatalog.version,
    "self-declared-catalog"
  );
});

test("v1 comparison redaction preserves marker-backed diff entries at its fixed point", () => {
  const baseline = sensitiveSingle();
  baseline.conditions.gpcEnabled = false;
  baseline.cookies = [];
  baseline.storage = [];
  const variant = sensitiveSingle();
  variant.conditions.gpcEnabled = true;
  const comparison = createGpcComparisonReport(baseline, variant);

  const first = redactScanReportV1(comparison).report;
  const second = redactScanReportV1(first).report;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.diff.addedCookies, [
    {
      name: "[redacted:long-token]",
      domain: ".{label}.google-analytics.com",
      thirdParty: true
    }
  ]);
  assert.deepEqual(first.diff.addedStorageKeys, [{ area: "localStorage", key: "[redacted]" }]);
});

test("subdomain-specific curated tracker matches survive an idempotent public boundary", () => {
  const input = sensitiveSingle();
  const tracker = findTrackerMatch("connect.facebook.net");
  assert.notEqual(tracker, null);
  input.requests[0].url = "https://connect.facebook.net/en_US/fbevents.js";
  input.requests[0].domain = "connect.facebook.net";
  input.requests[0].tracker = tracker;
  input.cnameCloaks = [{ host: "pixel.example.com", cname: "connect.facebook.net", tracker: tracker! }];
  input.privacyPolicy!.mentionedEntities = [tracker!.entity];

  const first = redactScanResultV1(input).report;
  const second = redactScanResultV1(first).report;
  assert.equal(first.requests[0].tracker?.entity, "Meta");
  assert.equal(first.requests[0].tracker?.domain, "{label}.facebook.net");
  assert.equal(first.cnameCloaks?.[0].tracker.entity, "Meta");
  assert.deepEqual(first.privacyPolicy?.mentionedEntities, ["Meta"]);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("every catalog service survives repeated public boundaries on observed subdomains", () => {
  const entries = JSON.parse(canonicalTrackerCatalogContents()) as Array<{ domain: string }>;
  for (const { domain } of entries) {
    for (const host of [domain, `tenant.${domain}`, `customer.region.${domain}`]) {
      if (redactHostnameV2(host).value === "{invalid-host}") continue;
      const original = findTrackerMatch(host);
      assert.ok(original, host);
      const first = redactTrackerMatch(original, new RedactionPass(), host);
      assert.ok(first, host);
      const second = redactTrackerMatch(first, new RedactionPass(), redactHostnameV2(host).value);
      assert.deepEqual(second, first, host);
      assert.equal(first.entity, original.entity, host);
      assert.notEqual(first.domain, "{invalid-host}", host);
    }
  }
});

test("catalog suffix metadata does not admit forged matches or expose observed tenant labels", () => {
  const azure = findTrackerMatch("private-customer.b02.azurefd.net")!;
  const first = redactTrackerMatch(azure, new RedactionPass(), "private-customer.b02.azurefd.net");
  assert.equal(first?.domain, "azurefd.net");
  assert.equal(redactHostnameV2("private-customer.b02.azurefd.net").value, "{label}.b02.azurefd.net");
  for (const host of ["{label}.notazurefd.net", "{label}.azurefd.net.example.com", "{invalid-host}"]) {
    assert.equal(redactTrackerMatch(azure, new RedactionPass(), host), null, host);
  }
  assert.equal(redactTrackerMatch({ ...azure, entity: "Made up service" }, new RedactionPass(), "{label}.b02.azurefd.net"), null);
});

test("legacy fingerprint sanitization drops detections that become structurally invalid", () => {
  const input = sensitiveSingle();
  input.fingerprintDetections?.push(
    {
      kind: "audio-fingerprinting",
      heuristic: "audio-rendering-v1",
      count: 1,
      evidence: {
        apis: ["AlicePrivateAudio", "BobPrivateAudio"],
        offlineRenderCalls: 1,
        oscillatorCalls: 1,
        compressorCalls: 1,
        analyserCalls: 1
      }
    },
    {
      kind: "session-recording",
      heuristic: "interaction-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["input"],
        listenerTargets: ["document"],
        thirdPartyOrigins: ["https://alice.internal/"],
        totalListenerCalls: 1
      }
    }
  );
  const first = redactScanResultV1(input).report;
  const second = redactScanResultV1(first).report;
  assert.equal(first.fingerprintDetections?.length, 2, "only the two valid original detections remain");
  // The withheld alice.internal listener detection is disclosed; the malformed
  // audio detection beside it is not the named cause and adds nothing.
  assert.equal(first.warnings.filter((warning) => warning === LISTENER_DETECTION_WITHHELD_WARNING).length, 1);
  assert.equal(readStoredScanReport(first).ok, true);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

function listenerDetection(
  kind: "session-recording" | "input-monitoring",
  thirdPartyOrigins: string[]
): FingerprintDetectionSummary {
  return kind === "session-recording"
    ? {
        kind,
        heuristic: "interaction-listener-coverage-v1",
        count: 1,
        evidence: { eventTypes: ["mousemove"], listenerTargets: ["document"], thirdPartyOrigins, totalListenerCalls: 3 }
      }
    : {
        kind,
        heuristic: "input-listener-coverage-v1",
        count: 1,
        evidence: { eventTypes: ["input"], listenerTargets: ["document"], thirdPartyOrigins, totalListenerCalls: 3 }
      };
}

test("a listener detection with an unpublishable script origin is withheld with a fixed disclosure", () => {
  // Redaction turns an origin with no publishable registrable domain into the
  // invalid-URL marker and the shared guard refuses the detection, because
  // naming the origin is its evidence. r2 records that drop as a
  // public-fingerprint-detections capture loss. v1 has no quality block, so the
  // detection used to vanish with no trace and the reader then printed an
  // unhedged "no listener signals" absence.
  const sanitize = (detections: FingerprintDetectionSummary[]): ScanResult => {
    const input = makeScanReportV1() as ScanResult;
    input.fingerprintDetections = detections;
    input.warnings = [];
    const first = redactScanResultV1(input).report;
    const second = redactScanResultV1(first).report;
    assert.equal(JSON.stringify(second), JSON.stringify(first), "a second pass is byte-identical");
    assert.equal(readStoredScanReport(first).ok, true);
    return first;
  };
  const lines = (report: ScanResult) =>
    report.warnings.filter((warning) => warning === LISTENER_DETECTION_WITHHELD_WARNING).length;

  for (const origin of [
    "https://s3.us-east-1.amazonaws.com",
    "https://93.184.216.34",
    "https://web.app",
    "https://alice.internal"
  ]) {
    for (const kind of ["session-recording", "input-monitoring"] as const) {
      const report = sanitize([listenerDetection(kind, [origin])]);
      assert.deepEqual(report.fingerprintDetections, [], `${kind} ${origin}`);
      assert.deepEqual(report.warnings, [LISTENER_DETECTION_WITHHELD_WARNING], `${kind} ${origin}`);
    }
    const both = sanitize([
      listenerDetection("session-recording", [origin]),
      listenerDetection("input-monitoring", [origin])
    ]);
    assert.deepEqual(both.fingerprintDetections, [], origin);
    assert.equal(lines(both), 1, `${origin}: two withheld detections publish the line once`);
  }

  // One unpublishable origin withholds the whole detection, publishable origin
  // included, exactly as r2 drops it.
  const mixed = sanitize([
    listenerDetection("session-recording", ["https://cdn.example.com", "https://s3.us-east-1.amazonaws.com"])
  ]);
  assert.deepEqual(mixed.fingerprintDetections, []);
  assert.deepEqual(mixed.warnings, [LISTENER_DETECTION_WITHHELD_WARNING]);

  // Inverses: a publishable origin keeps the detection with no line, and a
  // malformed non-listener detection is not this cause and stays silent.
  const kept = sanitize([listenerDetection("session-recording", ["https://cdn.example.com"])]);
  assert.equal(kept.fingerprintDetections?.length, 1);
  assert.deepEqual(kept.warnings, []);
  const audio = sanitize([
    {
      kind: "audio-fingerprinting",
      heuristic: "audio-rendering-v1",
      count: 1,
      evidence: {
        apis: ["AlicePrivateAudio"],
        offlineRenderCalls: 1,
        oscillatorCalls: 1,
        compressorCalls: 1,
        analyserCalls: 1
      }
    }
  ]);
  assert.deepEqual(audio.fingerprintDetections, []);
  assert.deepEqual(audio.warnings, []);
});

test("the withheld-listener disclosure is admitted alone and under a comparison label", () => {
  assert.deepEqual(redactScannerWarnings([LISTENER_DETECTION_WITHHELD_WARNING], new RedactionPass()), [
    LISTENER_DETECTION_WITHHELD_WARNING
  ]);
  assert.deepEqual(redactScannerWarnings([`GPC off: ${LISTENER_DETECTION_WITHHELD_WARNING}`], new RedactionPass()), [
    `GPC off: ${LISTENER_DETECTION_WITHHELD_WARNING}`
  ]);
});

test("the HTTP status disclosure survives for the full three-digit grammar the producer can emit", () => {
  const input = sensitiveSingle();
  input.warnings = [
    // In-band failure codes, the only range the pre-v8 vocabulary admitted.
    "The page returned HTTP 403; this report reflects an error or block page, not a normal load.",
    // Out-of-band refusals the producer records verbatim from the wire:
    // LinkedIn answers 999 and several WAFs answer other 6xx-9xx codes.
    // These became "[redacted warning]" before scanner-warning-patterns-v8.
    "The page returned HTTP 600; this report reflects an error or block page, not a normal load.",
    "The page returned HTTP 999; this report reflects an error or block page, not a normal load.",
    // Look-alikes outside the three-digit grammar must not ride through.
    "The page returned HTTP 99; this report reflects an error or block page, not a normal load.",
    "The page returned HTTP 1000; this report reflects an error or block page, not a normal load.",
    "The page returned HTTP 099; this report reflects an error or block page, not a normal load."
  ];

  const { report } = redactScanResultV1(input);
  // The warning list is set-deduplicated, so all three rejected look-alikes
  // collapse into a single placeholder while the admitted three stay distinct.
  assert.deepEqual(report.warnings, [...input.warnings.slice(0, 3), "[redacted warning]"]);
});

test("both consent-arm profile disclosure generations survive, and the producer emits the admitted one", () => {
  const input = sensitiveSingle();
  const scannerSource = readFileSync(path.join(process.cwd(), "lib", "scanner.ts"), "utf8");
  const emitted = scannerSource.match(
    /"This report is one automated, headless Chromium visit from a fixed en-US \/ UTC profile, with no scrolling or clicking except [^"]+"/
  );
  assert.ok(emitted, "scanner.ts no longer emits the consent-arm profile disclosure");
  const producerSentence = JSON.parse(emitted[0]) as string;
  assert.match(
    producerSentence,
    /scripted attempts to activate one choice/,
    "the producer disclosure must not return to the single-click overclaim: the probe can dispatch several clicks on candidate controls while seeking one choice"
  );
  input.warnings = [
    // What the scanner writes today. Reading it from the producer source makes
    // this an end-to-end pin: if either the emitted sentence or the admitted
    // vocabulary drifts alone, this test goes red.
    producerSentence,
    // The pre-v8 sentence carried by committed reports; replays keep it.
    "This report is one automated, headless Chromium visit from a fixed en-US / UTC profile, with no scrolling or clicking except one scripted choice on the cookie/consent banner (disclosed below). Sites can behave differently for real users, browsers, regions, accounts, or network locations."
  ];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, input.warnings);
});

test("both CNAME disclosure generations survive redaction; look-alike page text does not", () => {
  const input = sensitiveSingle();
  input.warnings = [
    // The grammatical singular the scanner emits today.
    "Resolved 1 first-party subdomain that is a CNAME alias for a third-party tracker (CNAME cloaking), which request-URL matching alone would miss.",
    // The older singular carried by committed corpus reports; remediation
    // replays must keep it intact.
    "Resolved 1 first-party subdomain that are CNAME aliases for third-party trackers (CNAME cloaking), which request-URL matching alone would miss.",
    "Resolved 3 first-party subdomains that are CNAME aliases for third-party trackers (CNAME cloaking), which request-URL matching alone would miss.",
    // A page-controlled look-alike must not ride the pattern through.
    "Resolved 1 first-party subdomain that is a CNAME alias for a third-party tracker (CNAME cloaking), visit evil.example now."
  ];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [...input.warnings.slice(0, 3), "[redacted warning]"]);
});

test("an inherited Object.prototype key cannot pass the pixel catalog's fail-closed guard", () => {
  // PIXEL_PRODUCTS[platform] on a plain object literal resolves inherited
  // members, so "constructor" returned a truthy Function, walked past the
  // `if (!catalog) continue` guard, and then threw on catalog.events. The
  // scanner only emits literal platform names, but imported and uploaded
  // reports carry values that are not ours.
  for (const platform of ["constructor", "toString", "__proto__", "valueOf", "hasOwnProperty"]) {
    assert.deepEqual(
      redactPixelEvents([{ platform, product: "x", events: ["SecretEventName"], advancedMatching: [], requests: 1 }]),
      [],
      `${platform} must be dropped, not thrown on`
    );
    assert.throws(() =>
      assertKnownPixelEventVocabulary({
        platform,
        product: "x",
        events: [],
        advancedMatching: [],
        requests: 1
      })
    );
  }
  // A real platform still round-trips.
  assert.equal(
    redactPixelEvents([{ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: [], requests: 1 }])
      .length,
    1
  );
});

// ---------------------------------------------------------------------------
// Private-suffix tenant labels and policy-quote identifiers
// ---------------------------------------------------------------------------

const ADDRESS_TENANT = "192-0-2-41_s-198-51-100-43_ts-1767225600-clienttons-s.akamaihd.net";
const TOKEN_TENANT = "qwert2yuiop3asdfg4hj-zxc5v6-79b48c136-clientnsv4-s.akamaihd.net";
const GENERALIZED_TENANT = "{label}.akamaihd.net";

function shieldsListMatch(host: string): TrackerMatch {
  return { domain: host, entity: host, category: "tracking (Brave Shields list)", confidence: "shields-list" };
}

function beaconRequest(id: number, host: string, thirdParty: boolean, tracker: TrackerMatch | null): NetworkRequestRecord {
  return {
    id,
    url: `https://${host}/beacon`,
    domain: host,
    method: "GET",
    resourceType: thirdParty ? "ping" : "document",
    status: 200,
    thirdParty,
    tracker,
    startedAtMs: id * 10
  };
}

/** A single visit whose two Shields-matched beacons sit on token tenants of one suffix. */
function tokenTenantSingle(): ScanResult {
  const report = makeScanReportV1() as ScanResult;
  report.requests = [
    beaconRequest(1, "example.com", false, null),
    beaconRequest(2, ADDRESS_TENANT, true, shieldsListMatch(ADDRESS_TENANT)),
    beaconRequest(3, TOKEN_TENANT, true, shieldsListMatch(TOKEN_TENANT))
  ];
  report.domains = summarizeDomains(report.requests);
  report.summary = {
    ...report.summary,
    totalRequests: 3,
    thirdPartyRequests: 2,
    knownTrackerRequests: 2,
    thirdPartyDomains: 2
  };
  report.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 1_000
  };
  return report;
}

test("a Shields-list match on a generalized tenant publishes the redacted domain as its entity", () => {
  const pass = new RedactionPass();
  const first = redactTrackerMatch(shieldsListMatch(ADDRESS_TENANT), pass, ADDRESS_TENANT);
  assert.deepEqual(first, shieldsListMatch(GENERALIZED_TENANT));
  // The domain is generalized once and the entity reuses it: one label, one count.
  assert.equal(pass.counters.subdomainLabelsGeneralized, 1);

  const secondPass = new RedactionPass();
  assert.deepEqual(redactTrackerMatch(first, secondPass, GENERALIZED_TENANT), first);
  assert.equal(secondPass.counters.subdomainLabelsGeneralized, 0);
});

test("a raw Shields-list policy entity stays grounded in its generalized form", () => {
  const input = tokenTenantSingle();
  input.privacyPolicy!.unmentionedEntities = [ADDRESS_TENANT];
  const first = redactScanResultV1(input).report;
  assert.deepEqual(first.privacyPolicy?.unmentionedEntities, [GENERALIZED_TENANT]);
  assert.equal(JSON.stringify(redactScanResultV1(first).report), JSON.stringify(first));

  // Two raw tenants sharing one public form collapse to one entity, and an
  // entity that lands in both lists stays mentioned only (the lists are
  // disjoint on the wire).
  const collided = tokenTenantSingle();
  collided.privacyPolicy!.mentionedEntities = [TOKEN_TENANT, ADDRESS_TENANT];
  collided.privacyPolicy!.unmentionedEntities = [ADDRESS_TENANT];
  const merged = redactScanResultV1(collided).report;
  assert.deepEqual(merged.privacyPolicy?.mentionedEntities, [GENERALIZED_TENANT]);
  assert.deepEqual(merged.privacyPolicy?.unmentionedEntities, []);
  assert.equal(JSON.stringify(redactScanResultV1(merged).report), JSON.stringify(merged));

  // Only a raw lowercase hostname is re-read in its public form, so a
  // dotted name in any other case can never be lowercased into a host
  // entity; an entity whose public form no retained tracker grounds is still
  // dropped.
  const ungrounded = tokenTenantSingle();
  ungrounded.privacyPolicy!.unmentionedEntities = ["metrics.example.net", "Akamai", ADDRESS_TENANT.toUpperCase()];
  assert.deepEqual(redactScanResultV1(ungrounded).report.privacyPolicy?.unmentionedEntities, []);
});

test("the v1 producer path publishes a token-tenant visit as a readable fixed point", () => {
  const input = tokenTenantSingle();
  input.privacyPolicy!.mentionedEntities = [ADDRESS_TENANT];
  const redacted = redactScanResultV1(input).report;
  assert.deepEqual(
    redacted.requests.map((request) => [request.domain, request.tracker?.domain, request.tracker?.entity]),
    [
      ["example.com", undefined, undefined],
      [GENERALIZED_TENANT, GENERALIZED_TENANT, GENERALIZED_TENANT],
      [GENERALIZED_TENANT, GENERALIZED_TENANT, GENERALIZED_TENANT]
    ]
  );
  assert.deepEqual(redacted.privacyPolicy?.mentionedEntities, [GENERALIZED_TENANT]);
  assert.equal(JSON.stringify(redacted).includes("clienttons"), false);
  assert.equal(JSON.stringify(redacted).includes("clientnsv4"), false);
  // Persistence re-reads the bundle through the managed reader, which refuses
  // a report that is not a fixed point of the sanitizer.
  const bundle = prepareScanReportBundle(redacted, { shareId: `20260727-${"a".repeat(32)}` });
  assert.equal(bundle.reportWire.includes("akamaihd"), true);
  assert.equal(bundle.reportWire.includes("192-0-2-41"), false);
});

test("two token tenants of one suffix merge into one domain row and the comparison is recounted", () => {
  const baseline = tokenTenantSingle();
  const variant = makeScanReportV1() as ScanResult;
  variant.requests = [beaconRequest(1, "example.com", false, null)];
  variant.domains = summarizeDomains(variant.requests);
  variant.summary = { ...variant.summary, totalRequests: 1, shieldsBlockedRequests: 2 };
  const comparison = createShieldsComparisonReport(baseline, variant);
  assert.equal(comparison.diff.removedDomains.length, 2, "the raw pair differs by two tenants");

  const first = redactScanReportV1(comparison);
  const arm = first.report.baseline;
  assert.deepEqual(
    arm.domains.filter((row) => row.thirdParty).map((row) => [row.domain, row.requests]),
    [[GENERALIZED_TENANT, 2]]
  );
  assert.equal(arm.summary.thirdPartyDomains, 1);
  assert.equal(arm.summary.thirdPartyRequests, 2);
  assert.deepEqual(first.report.diff.thirdPartyDomains, { before: 1, after: 0, delta: -1 });
  assert.deepEqual(first.report.diff.removedDomains.map((change) => [change.domain, change.requests]), [
    [GENERALIZED_TENANT, 2]
  ]);
  assert.deepEqual(first.report.diff.removedEntities.map((change) => [change.entity, change.requests]), [
    [GENERALIZED_TENANT, 2]
  ]);
  assert.deepEqual(first.report.diff, compareScanResults(first.report.baseline, first.report.variant));
  assert.equal(first.counters.subdomainLabelsGeneralized > 0, true);

  const second = redactScanReportV1(first.report);
  assert.equal(JSON.stringify(second.report), JSON.stringify(first.report));
  assert.equal(second.counters.subdomainLabelsGeneralized, 0);
});

function redactQuote(quote: string, kind: PrivacyPolicyClaim["kind"] = "honors-gpc"): string {
  return redactPrivacyPolicy(
    {
      url: "https://example.com/privacy",
      claims: [{ kind, quote }],
      mentionedEntities: [],
      unmentionedEntities: [],
      policyTextLength: 1_000
    },
    new RedactionPass()
  ).claims[0].quote;
}

function assertQuoteFixedPoint(quote: string): void {
  assert.equal(redactQuote(quote), quote, `not a fixed point: ${quote}`);
}

const POLICY_CLAIM_KINDS: PrivacyPolicyClaim["kind"][] = [
  "no-cookies",
  "no-third-party-cookies",
  "no-selling-or-sharing",
  "honors-gpc"
];

test("identifier spans in a quoted policy sentence become the marker and the quote reads as incomplete", () => {
  const spans = [
    "privacy@acme.com",
    "Jane.Doe+gpc@mail.acme.co.uk",
    "+44 20 7946 0958",
    "+1 (415) 555-0100",
    "(415) 555-0100",
    "1-800-555-0199",
    "415.555.0100",
    "https://acme.com/privacy?uid=12345#gpc",
    "www.acme.com/optout",
    "acme.com/privacy/gpc",
    "@acme",
    "privacy [at] acme [dot] com",
    // An obfuscated address with a plain dotted domain, in either bracket.
    "privacy [at] acme.com",
    "privacy(at)acme.com",
    "privacy (at) mail.acme.co.uk",
    // A [dot]-joined local part is part of the address.
    "jane [dot] doe [at] acme [dot] com",
    // A host label may carry "_".
    "my_company.example.com/optout",
    // Digit groups joined by a Unicode dash, a minus sign, or "/".
    "1\u2011800\u2011555\u20110199",
    "800\u2013555\u20130199",
    "+1\u2212800\u2212555\u22120199",
    "030/12345678"
  ];
  for (const kind of POLICY_CLAIM_KINDS) {
    for (const span of spans) {
      const published = redactQuote(`We honor your choices; contact ${span}, and we reply within 30 days.`, kind);
      assert.equal(
        published,
        "We honor your choices; contact [redacted], and we reply within 30 days...",
        `${kind}: ${span}`
      );
      assertQuoteFixedPoint(published);
    }
  }
  assert.equal(redactQuote("We honor GPC; call 415.555.0100."), "We honor GPC; call [redacted]...");
  assert.equal(redactQuote("Email privacy@acme.com."), "Email [redacted]...");
  assert.equal(redactQuote("Questions? Write to privacy@acme.com!"), "Questions? Write to [redacted]...");

  // Ordinary figures, citations, dates, and bare names stay verbatim with no marker.
  for (const quote of [
    "We do not sell data about anyone under 16 years of age.",
    "See Section 4.1 of this policy.",
    "We honor GPC as Cal. Civ. Code \u00a7 1798.140 requires.",
    "We honor GPC under \u00a7\u00a7 1798.100 \u2013 1798.199.",
    "We honor GPC under \u00a7\u00a7 1798.100 - 1798.199.",
    "This policy is effective 2024-01-01 (version 20240101).",
    "We honor GPC on acme.com and its apps.",
    // "(at)" in prose is not an address: no dotted or [dot] domain follows.
    "Visit us (at) our office to opt out.",
    "\"Sites.Sale\" does not sell your personal information."
  ]) {
    assert.equal(redactQuote(quote), quote, quote);
  }
  // A hyphen-joined statute range reads as a phone-shaped run: a known,
  // accepted false positive that costs the citation, not the claim. Joined by
  // an en dash or "/", it reads the same way.
  for (const range of ["1798.100-1798.199", "1798.100\u20131798.199", "1798.100/1798.105"]) {
    assert.equal(redactQuote(`We honor GPC under \u00a7\u00a7 ${range}.`), "We honor GPC under \u00a7\u00a7 [redacted]...");
  }
  // Known misses, disclosed in docs/limitations.md: a number under the digit
  // threshold, groups separated by a spaced dash (so a spaced statute range
  // stays whole), and a bare hostname.
  for (const quote of [
    "Call us at 555-0199 with questions.",
    "Call 800 - 555 - 0199 with questions.",
    "Visit example.com to opt out."
  ]) {
    assert.equal(redactQuote(quote), quote, quote);
  }
});

test("scrubbing and marking are one fixed point, even where a pass completes a new span", () => {
  // A second obfuscated address after the first: one global replace does not
  // rescan its own output.
  assert.equal(scrubPolicyQuoteIdentifiers("Write a [at] b [dot] c [at] d [dot] e today."), "Write [redacted] today.");
  assert.equal(redactQuote("Write a [at] b [dot] c [at] d [dot] e today."), "Write [redacted] today...");
  // The appended marker completes "www." and "[dot]..." spans.
  assert.equal(
    redactQuote("Email privacy@acme.com or see the www"),
    "Email [redacted] or see the [redacted]..."
  );
  assert.equal(
    redactQuote("Email privacy@acme.com or write a [at] b [dot]"),
    "Email [redacted] or write [redacted]..."
  );
  // The cut to fit the marker lands just after a ".", which must not become "....".
  const cutAtPeriod = redactQuote(`Email privacy@acme.com ${"a".repeat(179)}. More text past the cap.`);
  assert.equal(cutAtPeriod, `Email [redacted] ${"a".repeat(179)}...`);
  for (const quote of [
    "Write a [at] b [dot] c [at] d [dot] e today.",
    "Email privacy@acme.com or see the www",
    "Email privacy@acme.com or write a [at] b [dot]",
    "Email privacy@acme.com?!",
    `Email privacy@acme.com. ${"word ".repeat(40)}end.`,
    `Email privacy@acme.com ${"a".repeat(179)}. More text past the cap.`
  ]) {
    assertQuoteFixedPoint(redactQuote(quote));
  }
});

test("the obfuscated-address span cannot backtrack exponentially on a run of markers", () => {
  // Each part of the span excludes "[at]", "(at)", "[dot]" and "(dot)", so a
  // quote-length run of "a[dot]" with no "[at]" fails at once. With parts that
  // could span a marker, eighteen repetitions took about 70 ms and every two
  // more took four times as long.
  for (const run of ["a[dot]".repeat(26), "a(dot)".repeat(26), `${"a[dot]".repeat(24)}b[at]c[dot]com`]) {
    const started = Date.now();
    scrubPolicyQuoteIdentifiers(run);
    assert.equal(Date.now() - started < 1_000, true, run);
  }
  assert.equal(scrubPolicyQuoteIdentifiers(`${"a[dot]".repeat(24)}b[at]c[dot]com`), "[redacted]");
});

test("an identifier at the length cap is scrubbed whole before the quote is bounded", () => {
  const filler = (characters: number) => "word ".repeat(characters / 5);
  const cases = [
    // An email starting at character 185, a URL at 190, and a ten-digit phone
    // straddling character 200, where capping first would publish "415-5".
    [`${filler(185)}privacy@acme.com is where to write about your privacy choices.`, "acme"],
    [`${filler(190)}https://acme.com/privacy is our policy page for this service.`, "acme"],
    [`${filler(195)}415-555-0100 is our privacy line for requests.`, "415"]
  ];
  for (const [quote, identifier] of cases) {
    const published = redactQuote(quote);
    assert.equal(published.includes(identifier), false, published);
    assert.equal(published.endsWith("..."), true, published);
    assert.equal(Array.from(published).length <= 200, true, published);
    assertQuoteFixedPoint(published);
  }
});

test("a scrubbed policy claim is never checkable, so a scrub cannot add a finding", () => {
  const checkable = (quote: string) =>
    isCurrentlyCheckablePolicyClaim({ kind: "no-selling-or-sharing", quote });
  const sentences = [
    // Checkable raw: the span's "." ended the governed clause, so a bare
    // scrub would move the later ";" inside it and drop a finding.
    "We do not sell or share your personal information, email privacy@acme.com; we reply within 30 days.",
    // Not checkable raw because of the ":" in the URL; a bare scrub would
    // make a finding appear that the evidence never supported.
    "We do not sell or share your personal information, see https://acme.com/ccpa for details.",
    "We do not sell or share your personal information, write to privacy@acme.com with questions."
  ];
  assert.deepEqual(sentences.map(checkable), [true, false, true], "the raw baseline this test relies on");
  for (const sentence of sentences) {
    const published = redactQuote(sentence, "no-selling-or-sharing");
    assert.notEqual(published, sentence);
    assert.equal(checkable(published), false, published);
  }
  const blanket = "We do not sell or share your personal information.";
  assert.equal(redactQuote(blanket, "no-selling-or-sharing"), blanket);
  assert.equal(checkable(redactQuote(blanket, "no-selling-or-sharing")), true);

  // Every committed claim: sanitizing never makes an uncheckable claim checkable.
  const claims = committedPolicyClaims();
  assert.ok(claims.length > 0, "the corpus walk must reach at least one policy claim");
  for (const claim of claims) {
    const published = { kind: claim.kind, quote: redactQuote(claim.quote, claim.kind) };
    if (isCurrentlyCheckablePolicyClaim(published)) {
      assert.equal(isCurrentlyCheckablePolicyClaim(claim), true, claim.quote);
    }
  }
});

function committedPolicyClaims(): PrivacyPolicyClaim[] {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const claims: PrivacyPolicyClaim[] = [];
  const visit = (value: unknown, key?: string): void => {
    if (Array.isArray(value)) {
      for (const element of value) {
        if (
          key === "claims" &&
          element !== null &&
          typeof element === "object" &&
          typeof (element as PrivacyPolicyClaim).kind === "string" &&
          typeof (element as PrivacyPolicyClaim).quote === "string"
        ) {
          claims.push(element as PrivacyPolicyClaim);
        } else {
          visit(element, key);
        }
      }
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  for (const file of readdirSync(reportsDir).filter((name) => /^\d{8}-[a-f0-9]{32}\.json$/.test(name))) {
    visit(JSON.parse(readFileSync(path.join(reportsDir, file), "utf8")));
  }
  return claims;
}

test("the public-string policy digest hashes both rule tables", () => {
  // A table declared below the digest reads as undefined in an esbuild bundle
  // (top-level const lowered to var), so the digest would silently omit it.
  const inputs = publicStringPolicyInputs();
  assert.equal(PUBLIC_STRING_POLICY_DIGEST, sha256Hex(canonicalJson(inputs)));
  assert.deepEqual(inputs.privateSuffixTenantShapes, PRIVATE_SUFFIX_TENANT_SHAPES);
  assert.equal(PRIVATE_SUFFIX_TENANT_SHAPES.label, "private-suffix-tenant-shapes-v1");
  assert.equal(PRIVATE_SUFFIX_TENANT_SHAPES.patterns.length, 5);
  assert.equal(PRIVATE_SUFFIX_TENANT_SHAPES.minDigitRuns, 3);
  assert.deepEqual(PRIVATE_SUFFIX_TENANT_SHAPES.tokenLabel, { minLength: 32, minDigitRuns: 5 });

  const spans = inputs.policyQuoteIdentifierSpans;
  assert.equal(spans.label, "policy-quote-identifier-spans-v1");
  assert.equal(spans.marker, "[redacted]");
  assert.equal(spans.patterns.length, 7);
  // Each hashed source/flags pair is a live pattern, in the scrub's order.
  const examples = [
    "https://acme.com/x",
    "privacy@acme.com",
    "privacy [at] acme [dot] com",
    "www.acme.com",
    "acme.com/privacy",
    "+44 20 7946 0958",
    "415 555 0100"
  ];
  spans.patterns.forEach((entry, index) => {
    const slash = entry.lastIndexOf("/");
    const pattern = new RegExp(entry.slice(0, slash), entry.slice(slash + 1));
    assert.equal(examples[index].replace(pattern, "[redacted]"), "[redacted]", entry);
  });
});
