import assert from "node:assert/strict";
import { test } from "node:test";
import { SUSPECTED_CHALLENGE_OR_SOFT_BLOCK_WARNING } from "./bot-wall-classifier";
import {
  buildReportFacts,
  buildRunFacts,
  claimCountValue,
  comparisonArmsHaveExactClaimMeasurements,
  retainedCountLabel,
  type RunFacts
} from "./report-facts";
import {
  reportConsistencyViolations,
  validateReportPresentation
} from "./report-consistency";
import type { Finding } from "./report-findings";
import {
  makeGpcInterventionReportV2R2,
  makePublicSingleReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { viewFromV1Report, viewFromV2, type RunView } from "./scan-report-views";
import type {
  DomainSummary,
  FingerprintDetectionSummary,
  NetworkRequestRecord,
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
  result.requests = requestRowsForDomains(result.domains);
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

test("a shared framework endpoint names the standard, not an operator, in identity coverage", () => {
  const result = makeV1Result();
  result.domains = [
    thirdPartyDomain("cmp.mgr.consensu.org"),
    thirdPartyDomain("cdn.cookielaw.org")
  ];
  result.summary.thirdPartyDomains = result.domains.length;
  result.summary.thirdPartyRequests = result.domains.length;
  result.requests = requestRowsForDomains(result.domains);

  const identity = factsForV1(result).identity;
  // The endpoint is still named on its host's namers (so per-host surfaces
  // can render what matched), but marked as a framework endpoint.
  assert.deepEqual(
    identity.hosts.find((host) => host.host === "cmp.mgr.consensu.org")?.namers,
    [{ source: "cmp", name: "IAB TCF", kind: "framework-endpoint" }]
  );
  assert.deepEqual(
    identity.hosts.find((host) => host.host === "cdn.cookielaw.org")?.namers,
    [{ source: "cmp", name: "OneTrust" }]
  );
  // A framework-endpoint-only host is NOT an identified operator: the CMP
  // that actually ran behind the shared endpoint stays unnamed, so the page
  // must not claim it identified an operator for every third-party domain.
  assert.deepEqual(identity.coverage, {
    thirdPartyHosts: 2,
    identifiedHosts: 1,
    unidentifiedHosts: 1
  });
  assert.deepEqual(identity.identifiedHosts, ["cdn.cookielaw.org"]);
  assert.deepEqual(identity.unidentifiedHosts, ["cmp.mgr.consensu.org"]);
  // cmpNames stays truthful about which consent signatures matched, but the
  // framework name must stay out of allNames: every consumer of that union
  // makes an operator claim, and the identity-conflict gate reads it as
  // "operators the identity union named". The consent card names the
  // endpoint through its own consent-banner path, not through allNames.
  assert.deepEqual(identity.cmpNames, ["IAB TCF", "OneTrust"]);
  assert.ok(!identity.allNames.includes("IAB TCF"));
  assert.ok(identity.allNames.includes("OneTrust"));
});

test("a TCF-endpoint-only identity renders the service-absence branch without a false identity conflict", () => {
  // The only recognized identity source is the shared IAB TCF framework
  // endpoint: no catalog match, no vendor CMP, no ownership, no CNAME. The
  // service card renders its absence branch (a framework endpoint is not an
  // identified operator), and the identity-conflict gate must not read the
  // framework's name as an operator the card contradicted.
  const result = makeV1Result();
  result.domains = [thirdPartyDomain("cmp.mgr.consensu.org")];
  result.summary.thirdPartyDomains = result.domains.length;
  result.summary.thirdPartyRequests = result.domains.length;
  result.requests = requestRowsForDomains(result.domains);

  const presentation = validateReportPresentation(viewFromV1Report(result));
  const serviceCard = presentation.findings.find(
    (finding) => finding.id === "third-party-services"
  );
  assert.equal(
    serviceCard?.claim?.mode,
    "categorical-absence",
    "the fixture must exercise the absence branch, or the assertion below is vacuous"
  );
  // The consent card names the framework through its own consent-banner
  // path, so excluding it from allNames loses nothing a card renders.
  const consentCard = presentation.findings.find(
    (finding) => finding.id === "consent-banner"
  );
  assert.ok(consentCard?.lead.includes("IAB TCF"));
  assert.deepEqual(presentation.violations, []);
});

test("a vendor consent-platform name still trips identity-conflict when an absence renders over it", () => {
  const result = makeV1Result();
  result.domains = [thirdPartyDomain("cdn.cookielaw.org")];
  result.summary.thirdPartyDomains = result.domains.length;
  result.summary.thirdPartyRequests = result.domains.length;
  result.requests = requestRowsForDomains(result.domains);

  const presentation = validateReportPresentation(viewFromV1Report(result));
  assert.deepEqual(presentation.violations, []);
  const findings: Finding[] = presentation.findings.map((finding) =>
    finding.id === "third-party-services" && finding.claim
      ? {
          ...finding,
          claim: { ...finding.claim, mode: "categorical-absence" as const }
        }
      : finding
  );

  assert.deepEqual(
    reportConsistencyViolations(presentation.facts, presentation.headline, findings).map(
      (violation) => violation.id
    ),
    ["identity-conflict"]
  );
});

test("identity facts keep unclassified catalog services out of tracking totals", () => {
  const result = makeV1Result();
  result.domains = [
    thirdPartyDomain("experiment.example", {
      domain: "experiment.example",
      entity: "Experiment Co",
      category: "experimentation",
      confidence: "curated"
    })
  ];
  result.summary.thirdPartyDomains = 1;
  result.summary.thirdPartyRequests = 2;
  result.summary.knownTrackerRequests = 2;
  result.requests = requestRowsForDomains(result.domains);

  const identity = factsForV1(result).identity;
  assert.deepEqual(identity.catalogEntities.map((entity) => entity.entity), ["Experiment Co"]);
  assert.deepEqual(identity.trackingEntities, []);
  assert.deepEqual(identity.operationalEntities, []);
  assert.deepEqual(identity.unclassifiedEntities.map((entity) => entity.entity), ["Experiment Co"]);
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
  assert.ok(storageSnapshotLossRun.detectors);
  storageSnapshotLossRun.detectors["keystroke-exfiltration"] = {
    ...storageSnapshotLossRun.detectors["keystroke-exfiltration"],
    status: "complete",
    reason: null,
    phaseId: 0
  };
  storageSnapshotLossRun.detectors["privacy-policy"] = {
    ...storageSnapshotLossRun.detectors["privacy-policy"],
    status: "complete",
    reason: null,
    phaseId: 0
  };
  requireFamilyLedger(storageSnapshotLossRun).storage = {
    outcome: "censored",
    reasons: ["capture-loss:storage-snapshot"]
  };
  assert.equal(
    buildRunFacts(storageSnapshotLossRun).calmEligible,
    true,
    "a storage-only loss does not invalidate the complete detector claims calm copy emits"
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

function requestRowsForDomains(
  domains: readonly DomainSummary[]
): NetworkRequestRecord[] {
  let nextId = 1;
  return domains.flatMap((domain) =>
    Array.from({ length: domain.requests }, () => {
      const id = nextId;
      nextId += 1;
      return {
        id,
        url: `https://${domain.domain}/request-${id}`,
        domain: domain.domain,
        method: "GET",
        resourceType: domain.resourceTypes[0] ?? "other",
        status: domain.statuses[0] ?? null,
        thirdParty: domain.thirdParty,
        tracker: domain.tracker,
        blockedByShields: domain.blockedByShields,
        startedAtMs: id
      };
    })
  );
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

test("a failed detector that recorded no loss cannot publish an exact or rankable zero", () => {
  // The reproduction: fingerprint-heuristics=failed, NO capture loss, and the
  // wire's own quality block therefore still says the fingerprinting family is
  // complete, because quality is derived from capture loss alone. Prose was
  // already safe, but every numeric surface went on treating an unmeasured zero
  // as a measured one.
  const run = makeR2RunView();
  assert.ok(run.detectors);
  run.detectors["fingerprint-heuristics"] = {
    ...run.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "scan-failed"
  };
  // The wire still claims the family completed. That is exactly the state the
  // producer could emit, so the reader must not simply trust it.
  assert.equal(requireFamilyLedger(run).fingerprinting.outcome, "complete");

  const facts = buildRunFacts(run);
  const fingerprint = facts.claims["fingerprint-apis"];
  assert.equal(fingerprint.allowed, false);
  assert.equal(fingerprint.exactCountAllowed, false, "an unmeasured zero is not an exact count");
  assert.equal(fingerprint.benchmarkAllowed, false, "an unmeasured zero may not be ranked against a population");
  assert.equal(fingerprint.lowerBound, false, "a detector that failed is unavailable, not an observed floor");
  assert.equal(claimCountValue(run.counts.fingerprintEvents, fingerprint), "Incomplete");

  // The producer records fingerprint-observer capture loss when the observer
  // fails. That family marker must not turn an unmeasured zero back into the
  // meaningless lower bound "at least zero."
  const failedWithLossRun = makeR2RunView();
  assert.ok(failedWithLossRun.detectors && failedWithLossRun.quality.facts);
  failedWithLossRun.detectors["fingerprint-heuristics"] = {
    ...failedWithLossRun.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "engine-unavailable"
  };
  requireFamilyLedger(failedWithLossRun).fingerprinting = {
    outcome: "censored",
    reasons: ["capture-loss:dropped"]
  };
  failedWithLossRun.quality.facts.captureLoss.push({
    family: "fingerprinting",
    phaseId: null,
    kind: "dropped",
    count: 0,
    detail: "fingerprint-observer"
  });
  const failedWithLoss = buildRunFacts(failedWithLossRun).claims["fingerprint-apis"];
  assert.equal(failedWithLoss.exactCountAllowed, false);
  assert.equal(failedWithLoss.lowerBound, false);
  assert.equal(claimCountValue(0, failedWithLoss), "Incomplete");

  // Scoping holds: an unfinished fingerprint detector says nothing about
  // request-backed claims, which keep their exact counts and benchmarks.
  const services = facts.claims["third-party-services"];
  assert.equal(services.allowed, true);
  assert.equal(services.exactCountAllowed, true);
  assert.equal(services.benchmarkAllowed, true);

  for (const status of ["skipped", "unsupported"] as const) {
    const unavailableRun = makeR2RunView();
    assert.ok(unavailableRun.detectors);
    unavailableRun.detectors["fingerprint-heuristics"] = {
      ...unavailableRun.detectors["fingerprint-heuristics"],
      status,
      reason: status === "skipped" ? "load-failed" : "unsupported-runtime"
    };
    const unavailable = buildRunFacts(unavailableRun).claims["fingerprint-apis"];
    assert.equal(unavailable.exactCountAllowed, false);
    assert.equal(unavailable.lowerBound, false, `${status} is unavailable, not a retained lower bound`);
    assert.equal(unavailable.benchmarkAllowed, false);
  }

  const unsupportedFamilyRun = makeR2RunView();
  assert.ok(unsupportedFamilyRun.detectors && unsupportedFamilyRun.quality.facts);
  unsupportedFamilyRun.detectors["fingerprint-heuristics"] = {
    ...unsupportedFamilyRun.detectors["fingerprint-heuristics"],
    status: "unsupported",
    reason: "unsupported-runtime"
  };
  requireFamilyLedger(unsupportedFamilyRun).fingerprinting = {
    outcome: "censored",
    reasons: ["capture-loss:dropped"]
  };
  unsupportedFamilyRun.quality.facts.captureLoss.push({
    family: "fingerprinting",
    phaseId: null,
    kind: "dropped",
    count: 0,
    detail: "pagegraph-unsupported"
  });
  const unsupportedFamily = buildRunFacts(unsupportedFamilyRun).claims["fingerprint-apis"];
  assert.equal(unsupportedFamily.exactCountAllowed, false);
  assert.equal(unsupportedFamily.lowerBound, false, "unsupported evidence is unavailable, never at least zero");
  assert.equal(unsupportedFamily.benchmarkAllowed, false);
});

test("detector incompleteness stays scoped to the claim that names that detector", () => {
  // keystroke-exfiltration and privacy-policy sit at skipped/probe-disabled on
  // most reports, and they share `detector-output` with pixel, CNAME, and
  // policy claims. Keying family completeness on raw detector status rather
  // than on the accountability predicate marked that whole family unmeasured
  // and dragged a COMPLETED pixel detector down to disallowed, inexact, and
  // lower-bound. One predicate has to govern both call sites.
  const run = makeR2RunView();
  assert.ok(run.detectors);
  assert.equal(run.detectors["keystroke-exfiltration"].status, "skipped");
  assert.equal(run.detectors["keystroke-exfiltration"].reason, "probe-disabled");
  assert.equal(run.detectors["pixel-events"].status, "complete");

  const pixel = buildRunFacts(run).claims["pixel-events"];
  assert.equal(pixel.allowed, true);
  assert.equal(pixel.exactCountAllowed, true);
  assert.equal(pixel.lowerBound, false);
  assert.equal(pixel.benchmarkAllowed, true);

  // The pixel claim closes only when the PIXEL detector falls short, not when
  // some other detector sharing `detector-output` does.
  const attempted = makeR2RunView();
  assert.ok(attempted.detectors);
  attempted.detectors["pixel-events"] = {
    ...attempted.detectors["pixel-events"],
    status: "partial",
    reason: "budget-unavailable"
  };
  const attemptedPixel = buildRunFacts(attempted).claims["pixel-events"];
  assert.equal(attemptedPixel.exactCountAllowed, false);
  assert.equal(attemptedPixel.benchmarkAllowed, false);
  assert.equal(attemptedPixel.lowerBound, true);
  assert.equal(claimCountValue(3, attemptedPixel), "≥3");
  // A CNAME claim names its own detector and is untouched by a pixel failure.
  assert.equal(buildRunFacts(attempted).claims["cname-cloaking"].allowed, true);
});

test("shared detector-output loss is scoped by causal detail, including public caps", () => {
  const policyLoss = makeR2RunView();
  assert.ok(policyLoss.quality.facts);
  requireFamilyLedger(policyLoss)["detector-output"] = {
    outcome: "censored",
    reasons: ["capture-loss:dropped"]
  };
  policyLoss.quality.facts.captureLoss.push({
    family: "detector-output",
    phaseId: null,
    kind: "dropped",
    count: 1,
    detail: "policy-visit"
  });
  const policyFacts = buildRunFacts(policyLoss);
  assert.equal(policyFacts.claims["privacy-policy"].allowed, false);
  assert.equal(
    policyFacts.claims["consent-banner"].allowed,
    true,
    "an unrelated detector-output loss must not suppress consent evidence"
  );
  assert.equal(
    policyFacts.claims["pixel-events"].allowed,
    true,
    "a policy failure must not suppress a completed pixel measurement"
  );
  assert.equal(
    policyFacts.claims["cname-cloaking"].allowed,
    true,
    "a policy failure must not suppress a completed CNAME measurement"
  );

  const publicPixelCap = makeR2RunView();
  assert.ok(publicPixelCap.quality.facts);
  requireFamilyLedger(publicPixelCap)["detector-output"] = {
    outcome: "censored",
    reasons: ["capture-loss:clipped"]
  };
  publicPixelCap.quality.facts.captureLoss.push({
    family: "detector-output",
    phaseId: null,
    kind: "clipped",
    count: 1,
    detail: "public-pixel-events"
  });
  const publicPixelFacts = buildRunFacts(publicPixelCap);
  assert.equal(publicPixelFacts.claims["pixel-events"].allowed, false);
  assert.equal(publicPixelFacts.claims["cname-cloaking"].allowed, true);
  assert.equal(publicPixelFacts.claims["privacy-policy"].allowed, false);

  const publicConsentCap = makeR2RunView();
  assert.ok(publicConsentCap.quality.facts);
  requireFamilyLedger(publicConsentCap)["consent-verification"] = {
    outcome: "censored",
    reasons: ["capture-loss:clipped"]
  };
  publicConsentCap.quality.facts.captureLoss.push({
    family: "consent-verification",
    phaseId: null,
    kind: "clipped",
    count: 1,
    detail: "public-consent-observations"
  });
  const publicConsentFacts = buildRunFacts(publicConsentCap);
  assert.equal(publicConsentFacts.claims["consent-banner"].allowed, false);
  assert.equal(publicConsentFacts.claims["pixel-events"].allowed, true);

  const unsupportedSibling = makeR2RunView();
  assert.ok(unsupportedSibling.quality.facts);
  requireFamilyLedger(unsupportedSibling)["detector-output"] = {
    outcome: "censored",
    reasons: ["capture-loss:pagegraph-unsupported", "capture-loss:clipped"]
  };
  unsupportedSibling.quality.facts.captureLoss.push(
    {
      family: "detector-output",
      phaseId: null,
      kind: "dropped",
      count: 1,
      detail: "pagegraph-unsupported"
    },
    {
      family: "detector-output",
      phaseId: null,
      kind: "clipped",
      count: 1,
      detail: "public-pixel-events"
    }
  );
  const unsupportedSiblingFacts = buildRunFacts(unsupportedSibling);
  assert.equal(unsupportedSiblingFacts.claims["pixel-events"].allowed, false);
  assert.equal(
    unsupportedSiblingFacts.claims["cname-cloaking"].allowed,
    true,
    "broad unsupported detector-output state must not flatten a detail-scoped sibling"
  );
});

test("comparison deltas require an exact measurement in both arms", () => {
  const comparison = makeGpcInterventionReportV2R2();
  comparison.baseline.detectors["fingerprint-heuristics"] = {
    ...comparison.baseline.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "scan-failed"
  };
  comparison.variant.detectors["fingerprint-heuristics"] = {
    ...comparison.variant.detectors["fingerprint-heuristics"],
    status: "failed",
    reason: "scan-failed"
  };
  const facts = buildReportFacts(viewFromV2(comparison, 2));
  assert.equal(
    comparisonArmsHaveExactClaimMeasurements(facts, "fingerprint-apis"),
    false,
    "matching failed statuses are not matching measurements"
  );
  assert.equal(
    comparisonArmsHaveExactClaimMeasurements(facts, "third-party-services"),
    true,
    "the failed fingerprint detector must not suppress exact request deltas"
  );
});

test("comparison exactness pins each claim's own detector version", () => {
  const comparison = makeGpcInterventionReportV2R2();
  comparison.variant.detectors["pixel-events"] = {
    ...comparison.variant.detectors["pixel-events"],
    version: `${comparison.variant.detectors["pixel-events"].version}-different`
  };
  const facts = buildReportFacts(viewFromV2(comparison, 2));
  assert.equal(comparisonArmsHaveExactClaimMeasurements(facts, "pixel-events"), false);
  assert.equal(
    comparisonArmsHaveExactClaimMeasurements(facts, "third-party-services"),
    true
  );
});
