import assert from "node:assert/strict";
import { test } from "node:test";
import { SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING } from "./bot-wall-classifier";
import {
  buildReportFacts,
  buildRunFacts,
  retainedCountLabel,
  type RunFacts
} from "./report-facts";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2, type RunView } from "./scan-report-views";
import type {
  DomainSummary,
  FingerprintDetectionSummary,
  ScanResult
} from "./types";

function makeV1Result(): ScanResult {
  return structuredClone(makeScanReportV1()) as ScanResult;
}

function factsForV1(result: ScanResult): RunFacts {
  return buildReportFacts(viewFromV1Report(result)).display;
}

function makeR2RunView(): RunView {
  return viewFromV2(makePublicSingleReportV2R2(), 2).runs[0];
}

function requireFamilyLedger(
  run: RunView
): Record<string, { outcome: "complete" | "censored"; reasons: string[] }> {
  assert.ok(run.quality.byFamily, "r2 fixture must expose its recorded family ledger");
  return run.quality.byFamily;
}

test("claim eligibility is family- and detector-scoped", () => {
  const clean = buildRunFacts(makeR2RunView());
  assert.deepEqual(clean.claims["third-party-cookies"], {
    allowed: true,
    blockers: [],
    families: ["cookies"],
    detectors: [],
    subjectScope: "requested-page",
    exactCountAllowed: true,
    lowerBound: false,
    benchmarkAllowed: true
  });
  assert.equal(clean.claims["third-party-services"].allowed, true);
  assert.equal(clean.claims["fingerprint-apis"].allowed, true);

  const cookieLossRun = makeR2RunView();
  requireFamilyLedger(cookieLossRun).cookies = {
    outcome: "censored",
    reasons: ["capture-loss:truncated"]
  };
  const cookieLoss = buildRunFacts(cookieLossRun);
  assert.equal(cookieLoss.evidence.cookies.state, "censored");
  assert.equal(cookieLoss.claims["third-party-cookies"].allowed, false);
  assert.deepEqual(cookieLoss.claims["third-party-cookies"].blockers, ["family-censored"]);
  assert.equal(cookieLoss.claims["third-party-cookies"].exactCountAllowed, false);
  assert.equal(cookieLoss.claims["third-party-cookies"].benchmarkAllowed, false);
  assert.equal(
    cookieLoss.claims["third-party-services"].allowed,
    true,
    "cookie snapshot loss must not contaminate request-backed service claims"
  );

  const detectorLossRun = makeR2RunView();
  assert.ok(detectorLossRun.detectors);
  detectorLossRun.detectors["fingerprint-heuristics"] = {
    ...detectorLossRun.detectors["fingerprint-heuristics"],
    status: "partial",
    reason: "observer-frame-unavailable"
  };
  const detectorLoss = buildRunFacts(detectorLossRun);
  assert.deepEqual(detectorLoss.claims["fingerprint-apis"].blockers, ["detector-incomplete"]);
  assert.deepEqual(
    detectorLoss.claims["session-recording-input-monitoring"].blockers,
    ["detector-incomplete"]
  );
  assert.equal(detectorLoss.claims["third-party-services"].allowed, true);
});

test("listener coverage and fingerprint API activity remain separate signals", () => {
  const listenerOnly = makeV1Result();
  listenerOnly.fingerprintDetections = [inputMonitoringDetection()];
  const listenerFacts = factsForV1(listenerOnly);

  assert.equal(listenerFacts.signals.fingerprint.listenerCoverageObserved, true);
  assert.equal(listenerFacts.signals.fingerprint.apiActivityObserved, false);
  assert.equal(listenerFacts.signals.fingerprint.eventCount, 0);
  assert.equal(listenerFacts.signals.fingerprint.apiFamilies, 0);
  assert.equal(
    listenerFacts.signals.fingerprint.inputMonitoring?.detection.kind,
    "input-monitoring"
  );
  assert.equal(listenerFacts.strongestObservedSeverity, "info");

  const apiOnly = makeV1Result();
  apiOnly.summary.fingerprintEvents = 3;
  apiOnly.fingerprintEvents = [{ api: "CanvasRenderingContext2D.getImageData", count: 3 }];
  const apiFacts = factsForV1(apiOnly);

  assert.equal(apiFacts.signals.fingerprint.apiActivityObserved, true);
  assert.equal(apiFacts.signals.fingerprint.listenerCoverageObserved, false);
  assert.equal(apiFacts.signals.fingerprint.eventCount, 3);
  assert.equal(apiFacts.signals.fingerprint.apiFamilies, 1);
  assert.equal(apiFacts.signals.fingerprint.sessionRecording, undefined);
  assert.equal(apiFacts.signals.fingerprint.inputMonitoring, undefined);
});

test("identity coverage unions catalog, CMP, reviewed ownership, and CNAME namers", () => {
  const result = makeV1Result();
  result.domains = [
    thirdPartyDomain("analytics.vendor.test", {
      domain: "analytics.vendor.test",
      entity: "AdCo",
      category: "analytics",
      confidence: "curated"
    }),
    thirdPartyDomain("cdn.cookielaw.org"),
    thirdPartyDomain("static.twimg.com"),
    thirdPartyDomain("mystery.invalid")
  ];
  result.summary.thirdPartyDomains = result.domains.length;
  result.summary.thirdPartyRequests = result.domains.length;
  result.summary.knownTrackerRequests = 1;
  result.cnameCloaks = [
    {
      host: "metrics.example.com",
      cname: "example.eulerian.net",
      tracker: {
        domain: "eulerian.net",
        entity: "Eulerian",
        category: "advertising",
        confidence: "curated"
      }
    }
  ];

  const identity = factsForV1(result).identity;
  assert.deepEqual(identity.allNames, ["AdCo", "Eulerian", "OneTrust", "X"]);
  assert.deepEqual(identity.cmpNames, ["OneTrust"]);
  assert.deepEqual(identity.ownershipNames, ["X"]);
  assert.deepEqual(identity.cnameNames, ["Eulerian"]);
  assert.deepEqual(identity.coverage, {
    thirdPartyHosts: 4,
    identifiedHosts: 3,
    unidentifiedHosts: 1
  });
  assert.deepEqual(identity.unidentifiedHosts, ["mystery.invalid"]);
  assert.deepEqual(
    identity.hosts.find((host) => host.host === "cdn.cookielaw.org")?.namers,
    [{ source: "cmp", name: "OneTrust" }]
  );
  assert.deepEqual(
    identity.hosts.find((host) => host.host === "static.twimg.com")?.namers,
    [{ source: "ownership", name: "X" }]
  );
  assert.deepEqual(identity.trackingEntities.map((entity) => entity.entity), ["AdCo"]);
  assert.deepEqual(identity.cnameAliases, [
    {
      host: "metrics.example.com",
      cname: "example.eulerian.net",
      name: "Eulerian",
      relationship: "unreviewed"
    }
  ]);
});

test("subject facts prevent returned error and interstitial documents from describing the requested page", () => {
  const requested = factsForV1(makeV1Result());
  assert.deepEqual(requested.subject, {
    kind: "requested-page",
    describesSubject: true,
    status: 200,
    statusUnrepresentable: false,
    reasons: []
  });
  assert.equal(requested.claims["third-party-services"].subjectScope, "requested-page");

  const serverError = makeV1Result();
  serverError.summary.status = 503;
  const errorFacts = factsForV1(serverError);
  assert.equal(errorFacts.subject.kind, "http-error");
  assert.equal(errorFacts.subject.describesSubject, false);
  assert.equal(errorFacts.subject.status, 503);
  assert.equal(errorFacts.claims["third-party-services"].subjectScope, "returned-document");
  assert.equal(errorFacts.claims["third-party-services"].allowed, false);
  assert.ok(errorFacts.claims["third-party-services"].blockers.includes("subject-not-established"));

  const interstitial = makeV1Result();
  interstitial.warnings.push(SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING);
  const interstitialFacts = factsForV1(interstitial);
  assert.equal(interstitialFacts.subject.kind, "interstitial");
  assert.equal(interstitialFacts.subject.describesSubject, false);
  assert.equal(interstitialFacts.claims["third-party-cookies"].subjectScope, "returned-document");
  assert.ok(interstitialFacts.claims["third-party-cookies"].blockers.includes("subject-not-established"));
});

test("request loss yields retained lower bounds while cookie and storage loss stays snapshot-scoped", () => {
  const requestLossRun = makeR2RunView();
  requireFamilyLedger(requestLossRun).requests = {
    outcome: "censored",
    reasons: ["capture-loss:truncated"]
  };
  const requestLoss = buildRunFacts(requestLossRun);
  assert.equal(requestLoss.requestEvidenceState, "incomplete");
  assert.equal(requestLoss.evidence.requests.state, "censored");
  assert.equal(
    retainedCountLabel(requestLoss.run.counts.totalRequests, requestLoss.evidence.requests.state),
    `≥${requestLoss.run.counts.totalRequests.toLocaleString("en-US")}`
  );
  assert.equal(requestLoss.claims["third-party-services"].lowerBound, true);
  assert.equal(requestLoss.claims["third-party-services"].exactCountAllowed, false);

  const snapshotLossRun = makeR2RunView();
  snapshotLossRun.counts.cookies = 2;
  snapshotLossRun.counts.thirdPartyCookies = 1;
  snapshotLossRun.counts.storageEntries = 3;
  const snapshotLedger = requireFamilyLedger(snapshotLossRun);
  snapshotLedger.cookies = {
    outcome: "censored",
    reasons: ["capture-loss:cookie-snapshot"]
  };
  snapshotLedger.storage = {
    outcome: "censored",
    reasons: ["capture-loss:storage-snapshot"]
  };
  const snapshotLoss = buildRunFacts(snapshotLossRun);

  assert.equal(snapshotLoss.requestEvidenceState, "complete");
  assert.equal(snapshotLoss.evidence.requests.state, "complete");
  assert.equal(snapshotLoss.evidence.cookies.state, "censored");
  assert.equal(snapshotLoss.evidence.storage.state, "censored");
  assert.deepEqual(snapshotLoss.signals.cookies, { total: 2, thirdParty: 1 });
  assert.equal(snapshotLoss.signals.storage.entries, 3);
  assert.equal(snapshotLoss.claims["third-party-cookies"].allowed, false);
  assert.equal(snapshotLoss.claims["storage-keys"].allowed, false);
  assert.equal(snapshotLoss.claims["third-party-cookies"].lowerBound, false);
  assert.equal(snapshotLoss.claims["storage-keys"].lowerBound, false);
  assert.equal(snapshotLoss.claims["third-party-cookies"].exactCountAllowed, false);
  assert.equal(snapshotLoss.claims["storage-keys"].exactCountAllowed, false);
  assert.equal(
    retainedCountLabel(snapshotLoss.run.counts.totalRequests, snapshotLoss.evidence.requests.state),
    snapshotLoss.run.counts.totalRequests.toLocaleString("en-US"),
    "snapshot loss must not turn completed request activity into a floor"
  );

  const capped = makeV1Result();
  capped.warnings.push(
    "The scanner stopped recording or loading additional requests after reaching its request-recording cap."
  );
  const cappedFacts = factsForV1(capped);
  assert.equal(cappedFacts.requestEvidenceState, "capped");
  assert.equal(cappedFacts.evidence.requests.state, "censored");
});

test("calm eligibility is conservative, signal-aware, and scoped to calm claims", () => {
  assert.equal(factsForV1(makeV1Result()).calmEligible, true);

  const listener = makeV1Result();
  listener.fingerprintDetections = [inputMonitoringDetection()];
  assert.equal(factsForV1(listener).calmEligible, false);

  const requestLossRun = makeR2RunView();
  requireFamilyLedger(requestLossRun).requests = {
    outcome: "censored",
    reasons: ["capture-loss:truncated"]
  };
  assert.equal(buildRunFacts(requestLossRun).calmEligible, false);

  const storageSnapshotLossRun = makeR2RunView();
  requireFamilyLedger(storageSnapshotLossRun).storage = {
    outcome: "censored",
    reasons: ["capture-loss:storage-snapshot"]
  };
  assert.equal(
    buildRunFacts(storageSnapshotLossRun).calmEligible,
    true,
    "a storage-only loss does not invalidate the service, platform, cookie, or fingerprint claims calm copy emits"
  );

  const serverError = makeV1Result();
  serverError.summary.status = 500;
  assert.equal(factsForV1(serverError).calmEligible, false);
});

function thirdPartyDomain(
  domain: string,
  tracker: DomainSummary["tracker"] = null
): DomainSummary {
  return {
    domain,
    requests: 1,
    thirdParty: true,
    tracker,
    statuses: [200],
    resourceTypes: ["script"]
  };
}

function inputMonitoringDetection(): FingerprintDetectionSummary {
  return {
    kind: "input-monitoring",
    heuristic: "input-listener-coverage-v1",
    count: 1,
    evidence: {
      eventTypes: ["input", "keydown"],
      listenerTargets: ["input"],
      thirdPartyOrigins: ["https://recorder.example.net"],
      totalListenerCalls: 4
    }
  };
}
