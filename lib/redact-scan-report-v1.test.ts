import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PAGE_SUBJECT_UNVERIFIED_WARNING } from "./bot-wall-classifier";
import { compareScanResults, createGpcComparisonReport } from "./compare-reports";
import { runHitResponseByteCap, runHitUploadByteCap } from "./comparison-eligibility";
import { CONSENT_PROBE_OUTCOMES, consentInteractionWarning } from "./consent-interaction";
import {
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION,
  NODE_SHIELDS_REQUEST_CONTEXT_VERSION
} from "./legacy-methodology";
import {
  assertKnownPixelEventVocabulary,
  redactPixelEvents,
  redactScanReportV1,
  redactScanResultV1
} from "./redact-scan-report-v1";
import { scannerDisclosure } from "./scan-condition-disclosure";
import {
  aggregateByteBudgetWarning,
  INVALID_UPSTREAM_RESPONSE_WARNING,
  KEYSTROKE_PROBE_INCOMPLETE_WARNING,
  PIXEL_DECODE_CAPTURE_LOSS_WARNING,
  UNSETTLED_ROUTED_REQUEST_WARNING
} from "./scan-runtime";
import { readStoredScanReport } from "./scan-report-reader";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { findTrackerMatch } from "./tracker-catalog";
import type { ScanResult } from "./types";

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

test("the incomplete synthetic-input probe disclosure survives the public boundary", () => {
  const input = sensitiveSingle();
  input.warnings = [KEYSTROKE_PROBE_INCOMPLETE_WARNING];

  const { report } = redactScanResultV1(input);
  assert.deepEqual(report.warnings, [KEYSTROKE_PROBE_INCOMPLETE_WARNING]);
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
  assert.equal(readStoredScanReport(first).ok, true);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
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
