import assert from "node:assert/strict";
import { test } from "node:test";
import { compareScanResults, createGpcComparisonReport } from "./compare-reports";
import { redactScanReportV1, redactScanResultV1 } from "./redact-scan-report-v1";
import { readStoredScanReport } from "./scan-report-reader";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanResult } from "./types";

const TOKEN_HOST = "a8f3c9d2e1b4f6a7.telemetry.example.net";

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
        domain: TOKEN_HOST,
        entity: "Example Analytics",
        category: "analytics",
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
        domain: TOKEN_HOST,
        entity: "Example Analytics",
        category: "analytics",
        confidence: "curated"
      }
    }
  ];
  report.privacyPolicy = {
    url: "https://example.com/legal/anna-policy?patient=secret",
    claims: [{ kind: "no-cookies", quote: "We do not use cookies.\u0000" }],
    mentionedEntities: ["Example Analytics"],
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
    `Blocked a request that could not be verified as public: https://${TOKEN_HOST}/users/anna?token=secret`,
    "Patient Anna's private warning"
  ];
  return report;
}

test("the v1 transform sanitizes every page-controlled field without mutating its input", () => {
  const input = sensitiveSingle();
  const before = JSON.stringify(input);
  const { report, counters } = redactScanResultV1(input);

  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(report).includes("anna-schmidt"), false);
  assert.equal(JSON.stringify(report).includes("anna_private_record"), false);
  assert.equal(JSON.stringify(report).includes("patient-a8f3c9d2e1b4f6a7"), false);
  assert.equal(report.summary.pageTitle, "Anna Schmidt's private dashboard");
  assert.equal(report.conditions.requestedUrl, "https://{label}.example.com/{seg}/{seg}");
  assert.equal(report.conditions.finalUrl, "https://{label}.example.com/account/{n}");
  assert.equal(report.requests[0].url, "https://{label}.telemetry.example.net/{seg}/{seg}?%5Bredacted%5D=&utm_source=");
  assert.equal(report.requests[0].domain, "{label}.telemetry.example.net");
  assert.equal(report.requests[0].provenance?.graphRecordId, "{invalid-id}");
  assert.equal(report.requests[0].provenance?.initiatorId, "element-1");
  assert.equal(report.requests[0].provenance?.scriptId, "script-1");
  assert.equal(report.requests[0].provenance?.injectedById, "{invalid-id}");
  assert.equal(report.requests[0].provenance?.scriptUrl, "https://{label}.telemetry.example.net/{seg}/{seg}/{seg}");
  assert.equal(report.cookies[0].name, "[redacted:long-token]");
  assert.equal(report.cookies[0].domain, ".{label}.telemetry.example.net");
  assert.equal(report.cookies[0].path, "/{seg}/{seg}");
  assert.equal(report.storage[0].key, "[redacted]");
  assert.equal(report.domains.length, 1);
  assert.equal(report.domains[0].domain, "{label}.telemetry.example.net");
  assert.equal(report.summary.totalRequests, 1);
  assert.equal(report.summary.thirdPartyDomains, 1);
  assert.equal(report.summary.cookies, 1);
  assert.equal(report.summary.storageEntries, 1);
  assert.equal(report.cnameCloaks?.[0].cname, "{label}.telemetry.example.net");
  assert.equal(report.privacyPolicy?.url, "https://example.com/legal/{seg}");
  assert.equal(report.consentInteraction?.cmp, "[redacted]");
  assert.equal(report.consentInteraction?.selector, "[redacted]");
  assert.equal(report.consentInteraction?.matchedText, "reject all");
  assert.equal(report.consentInteraction?.frameUrl, "https://{label}.telemetry.example.net/{seg}/{seg}");
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
    "Blocked a request that could not be verified as public: https://{label}.telemetry.example.net/{seg}/{seg}",
    "[redacted warning]"
  ]);
  assert.ok(counters.pathSegmentsGeneralized > 0);
  assert.ok(counters.subdomainLabelsGeneralized > 0);
  assert.equal(counters.cookieNamesRedacted, 1);
  assert.equal(counters.storageKeysRedacted, 1);
  assert.equal(readStoredScanReport(report).ok, true);
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
