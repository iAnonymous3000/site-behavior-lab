import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { adblockListMeta } from "./adblock-engine";
import { consentInteractionWarning } from "./consent-interaction";
import { TCF_API_METHOD } from "./consent-verification";
import {
  NODE_ADBLOCK_ENGINE_VERSION,
  NODE_PLAYWRIGHT_VERSION,
  NODE_SCANNER_METHODOLOGY_VERSION,
  recordedPlaywrightVersion
} from "./legacy-methodology";
import {
  DETECTOR_REGISTRY_DIGEST,
  DETECTOR_REGISTRY_VERSION,
  DETECTOR_VERSIONS
} from "./measurement-kernel";
import { BUDGET_FAMILIES } from "./scan-report-v2-evaluators";
import { readStoredScanReport } from "./scan-report-reader";
import {
  R2_NAVIGATION_STATUS_UNREPRESENTABLE,
  R2_REQUEST_STATUS_UNREPRESENTABLE
} from "./scan-report-v2-http-status";
import { toPublicScanReportR2 } from "./scan-report-v2-r2-projection";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import { isEphemeralScanReportR2, isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import type { DetectorLedger } from "./scan-report-v2";
import {
  NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION,
  NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
  NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES,
  assertKnownNodeToolchainIdentity,
  buildNodeComparisonScanReportV2R2,
  buildNodeScanReportV2R2,
  type NodeInterventionComparisonV2R2Input,
  type NodeScanReportV2R2Input
} from "./scan-result-v2-r2-builder";
import { trackerCatalogMetadata } from "./tracker-catalog";
import { findTrackerMatch } from "./tracker-catalog";
import { publicReportDigest } from "./canonical-json";
import { redactPublicScanReportV2R2 } from "./scan-report-v2-r2-remediation";
import { prepareScanReportBundle } from "./report-store";

const BUILD_COMMIT_ENV = "SITE_BEHAVIOR_LAB_BUILD_COMMIT";
process.env[BUILD_COMMIT_ENV] = "a".repeat(40);

function detectorLedger(): DetectorLedger {
  return {
    "fingerprint-heuristics": { version: DETECTOR_VERSIONS["fingerprint-heuristics"], status: "complete" },
    "keystroke-exfiltration": {
      version: DETECTOR_VERSIONS["keystroke-exfiltration"],
      status: "skipped",
      reason: "probe-disabled"
    },
    "cname-uncloaking": { version: DETECTOR_VERSIONS["cname-uncloaking"], status: "complete" },
    "pixel-events": { version: DETECTOR_VERSIONS["pixel-events"], status: "complete" },
    "consent-banner": { version: DETECTOR_VERSIONS["consent-banner"], status: "complete" },
    "privacy-policy": {
      version: DETECTOR_VERSIONS["privacy-policy"],
      status: "skipped",
      reason: "probe-disabled"
    }
  };
}

function baseInput(): NodeScanReportV2R2Input {
  const privateHost = `${"0123456789abcdef".repeat(2)}.shop.example.com`;
  return {
    runId: "run-r2-builder-1",
    startedAt: "2026-07-12T18:00:00.000Z",
    requestedUrl: `https://${privateHost}/products/Alice-Private?token=secret#account`,
    observedUrl: `https://${privateHost}/products/Alice-Private?session=secret`,
    conditions: {
      gpc: true,
      shields: "classification",
      consent: "observe",
      device: { kind: "desktop", viewport: { width: 1440, height: 980, isMobile: false } },
      probes: { keystroke: false, policyVisit: false },
      locale: "en-US",
      language: "en-US",
      timezone: "UTC",
      egress: { label: "production-scanner", region: "us-west" },
      browser: { name: "chromium", version: "136.0.0.0" },
      headless: true,
      automation: "playwright-chromium"
    },
    acquisition: "public-api",
    adblockEngineLoaded: true,
    measurement: {
      phases: [{ phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 1000 }],
      detectors: detectorLedger(),
      qualityFacts: {
        status: 200,
        botWallTitleMatched: false,
        navigationSettled: true,
        budgetsExhausted: [],
        captureLoss: []
      }
    },
    evidence: {
      requests: [
        {
          id: 1,
          url: `https://${privateHost}/products/Alice-Private`,
          domain: privateHost,
          method: "GET",
          resourceType: "document",
          status: 200,
          thirdParty: false,
          tracker: null,
          blockedByShields: false,
          startedAtMs: 20,
          phaseId: 0
        }
      ],
      cookieMutations: [],
      cookiesFinal: [],
      storageMutations: [],
      storageFinal: [],
      fingerprintEvents: [],
      fingerprintDetections: [],
      cnameCloaks: [],
      pixelEvents: []
    },
    summary: { pageTitle: "  Example\u0000   Shop  ", durationMs: 1000 },
    warnings: [],
    screenshot: "data:image/png;base64,PRIVATE_SCREENSHOT"
  };
}

test("real Node producer output is an exact managed-sanitizer fixed point", () => {
  const report = buildNodeScanReportV2R2(baseInput());
  const publicReport = toPublicScanReportR2(report);
  assert.equal(
    publicReportDigest(redactPublicScanReportV2R2(publicReport)),
    publicReportDigest(publicReport)
  );
  const prepared = prepareScanReportBundle(report, {
    shareId: `20260721-${"e".repeat(32)}`,
    now: new Date("2026-07-21T12:00:00.000Z")
  });
  assert.equal(prepared.reportWire.includes("ephemeral"), false);
  assert.equal(prepared.manifest.reportId, `20260721-${"e".repeat(32)}`);
});

function comparisonInput(
  axis: "gpc" | "shields" | "consent",
  executedFirst: "baseline" | "variant"
): NodeInterventionComparisonV2R2Input {
  const baseline = baseInput();
  const variant = baseInput();
  baseline.runId = `run-${axis}-baseline-${executedFirst}`;
  variant.runId = `run-${axis}-variant-${executedFirst}`;
  baseline.startedAt = executedFirst === "baseline" ? "2026-07-12T18:00:00.000Z" : "2026-07-12T18:01:00.000Z";
  variant.startedAt = executedFirst === "baseline" ? "2026-07-12T18:01:00.000Z" : "2026-07-12T18:00:00.000Z";
  baseline.screenshot = "data:image/png;base64,BASELINE_PRIVATE";
  variant.screenshot = "data:image/png;base64,VARIANT_PRIVATE";

  if (axis === "gpc") {
    baseline.conditions.gpc = false;
    variant.conditions.gpc = true;
    baseline.verificationFacts = {
      gpc: {
        method: "gpc-header-readback@1",
        header: "confirmed-absent",
        jsSignal: "confirmed-absent",
        observedOn: "first-party-navigation",
        phaseId: 0
      }
    };
    variant.verificationFacts = {
      gpc: {
        method: "gpc-header-readback@1",
        header: "confirmed-present",
        jsSignal: "confirmed-true",
        observedOn: "first-party-navigation",
        phaseId: 0
      }
    };
  } else if (axis === "shields") {
    baseline.conditions.shields = "classification";
    variant.conditions.shields = "block-simulation";
    baseline.verificationFacts = {
      shields: {
        method: "shields-engine-status@1",
        engineLoaded: true,
        applied: false,
        requestsEvaluated: 1,
        requestsMatched: 0,
        requestsActuallyBlocked: 0,
        phaseId: 0
      }
    };
    variant.verificationFacts = {
      shields: {
        method: "shields-engine-status@1",
        engineLoaded: true,
        applied: true,
        requestsEvaluated: 1,
        requestsMatched: 0,
        requestsActuallyBlocked: 0,
        phaseId: 0
      }
    };
  } else {
    makeVerifiedConsentInput(baseline, "accept-all");
    makeVerifiedConsentInput(variant, "reject-all");
  }

  return { pairId: `pair-${axis}-${executedFirst}`, executedFirst, baseline, variant };
}

function makeVerifiedConsentInput(input: NodeScanReportV2R2Input, mode: "accept-all" | "reject-all"): void {
  input.conditions.consent = mode;
  input.measurement.phases.push(
    { phaseId: 1, kind: "consent-interaction", startedAtMs: 1000, endedAtMs: 1500 },
    { phaseId: 2, kind: "post-choice-reload", startedAtMs: 1500, endedAtMs: 2000 }
  );
  input.summary.durationMs = 2000;
  const observed = mode === "accept-all" ? "accepted-all" : "rejected-all";
  input.consent = {
    interactionAttempted: true,
    controlActivated: true,
    verificationObservations: [
      { phaseId: 1, method: TCF_API_METHOD, observed, result: { outcome: "read", sequence: 0 } },
      { phaseId: 2, method: TCF_API_METHOD, observed, result: { outcome: "read", sequence: 1 } }
    ]
  };
}

test("the Node comparison builder derives all three canonical interventions in both execution orders", () => {
  for (const axis of ["gpc", "shields", "consent"] as const) {
    for (const executedFirst of ["baseline", "variant"] as const) {
      const report = buildNodeComparisonScanReportV2R2(comparisonInput(axis, executedFirst));
      assert.equal(report.reportType, "comparison");
      assert.equal(report.experiment.kind, "intervention");
      if (report.experiment.kind !== "intervention") throw new Error("expected intervention");
      assert.equal(report.experiment.axis, axis);
      assert.equal(report.experiment.order, executedFirst === "baseline" ? "AB" : "BA");
      assert.deepEqual(report.experiment.evidence, {
        pairs: 1,
        counterbalanced: false,
        strength: "observed-difference"
      });
      assert.equal(report.experiment.verification.baseline.outcome, "passed");
      assert.equal(report.experiment.verification.variant.outcome, "passed");
      assert.equal(report.comparability.pairValidity.eligible, true);
      assert.equal(report.comparability.interventionVerified, true);
      assert.equal(isEphemeralScanReportR2(report), true);
      assert.deepEqual(scanReportV2R2SemanticViolations(toPublicScanReportR2(report)), []);
      assert.equal(report.ephemeral.baselineScreenshot, "data:image/png;base64,BASELINE_PRIVATE");
      assert.equal(report.ephemeral.variantScreenshot, "data:image/png;base64,VARIANT_PRIVATE");
      assert.equal(JSON.stringify(toPublicScanReportR2(report)).includes("PRIVATE"), false);
    }
  }
});

test("the comparison builder rejects identity, chronology, orientation, and missing-fact defects", () => {
  const invalidOrder = comparisonInput("gpc", "baseline");
  (invalidOrder as { executedFirst: string }).executedFirst = "first";
  assert.throws(() => buildNodeComparisonScanReportV2R2(invalidOrder), /exactly baseline or variant/);

  const duplicateRun = comparisonInput("gpc", "baseline");
  duplicateRun.variant.runId = duplicateRun.baseline.runId;
  assert.throws(() => buildNodeComparisonScanReportV2R2(duplicateRun), /distinct runId/);

  const equalTime = comparisonInput("gpc", "baseline");
  equalTime.variant.startedAt = equalTime.baseline.startedAt;
  assert.throws(() => buildNodeComparisonScanReportV2R2(equalTime), /distinct startedAt/);

  const schedulerMismatch = comparisonInput("gpc", "baseline");
  schedulerMismatch.executedFirst = "variant";
  assert.throws(() => buildNodeComparisonScanReportV2R2(schedulerMismatch), /scheduler order disagrees/);

  const reversed = comparisonInput("gpc", "baseline");
  reversed.baseline.conditions.gpc = true;
  reversed.variant.conditions.gpc = false;
  assert.throws(() => buildNodeComparisonScanReportV2R2(reversed), /canonical baseline\/variant orientation/);

  const missingFacts = comparisonInput("gpc", "baseline");
  delete missingFacts.variant.verificationFacts;
  assert.throws(() => buildNodeComparisonScanReportV2R2(missingFacts), /structured verificationFacts\.gpc/);
});

test("a facts-proven arm failure remains an honest comparison result", () => {
  const input = comparisonInput("gpc", "baseline");
  const facts = input.baseline.verificationFacts?.gpc;
  assert.notEqual(facts, undefined);
  if (facts === undefined) throw new Error("expected GPC facts");
  facts.header = "confirmed-present";
  facts.jsSignal = "confirmed-true";
  const report = buildNodeComparisonScanReportV2R2(input);
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention");
  assert.equal(report.experiment.verification.baseline.outcome, "failed");
  assert.equal(report.comparability.interventionVerified, false);
  assert.deepEqual(scanReportV2R2SemanticViolations(toPublicScanReportR2(report)), []);
});

test("an unavailable consent arm leaves raw runs but makes the pair and every delta raw-only", () => {
  const input = comparisonInput("consent", "baseline");
  input.variant.consent = {
    interactionAttempted: true,
    controlActivated: false,
    verificationObservations: []
  };
  const report = buildNodeComparisonScanReportV2R2(input);
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention");
  assert.deepEqual(report.experiment.verification.variant, {
    axis: "consent",
    expected: "consent:reject-all",
    observed: null,
    method: "consent-verification-unavailable@1",
    outcome: "inconclusive",
    phaseId: 1
  });
  assert.deepEqual(report.comparability.pairValidity, { eligible: false, reasons: ["design-invalid"] });
  for (const entry of Object.values(report.comparability.perMetric)) {
    assert.equal(entry.eligible, false);
    assert.equal(entry.reasons.includes("design-invalid"), true);
  }
  assert.equal(report.diff.families["raw-counts"].eligible, false);
  assert.equal(report.comparability.perMetric["consent-verification"].eligible, false);
  assert.equal(
    report.comparability.perMetric["consent-verification"].reasons.includes(
      "arm-verification-inconclusive:variant"
    ),
    true
  );
  assert.equal(report.comparability.interventionVerified, false);
  assert.equal(report.baseline.evidence.requests.length, input.baseline.evidence.requests.length);
  assert.equal(report.variant.evidence.requests.length, input.variant.evidence.requests.length);
  assert.equal(report.baseline.summary.counts.totalRequests, report.baseline.evidence.requests.length);
  assert.equal(report.variant.summary.counts.totalRequests, report.variant.evidence.requests.length);
  assert.deepEqual(scanReportV2R2SemanticViolations(toPublicScanReportR2(report)), []);
});

test("present but unobservable axis facts derive an inconclusive arm instead of a missing-facts error", () => {
  const input = comparisonInput("gpc", "baseline");
  const facts = input.variant.verificationFacts?.gpc;
  assert.notEqual(facts, undefined);
  if (facts === undefined) throw new Error("expected GPC facts");
  facts.header = "unobservable";
  facts.jsSignal = "unobservable";
  const report = buildNodeComparisonScanReportV2R2(input);
  assert.equal(report.experiment.kind, "intervention");
  if (report.experiment.kind !== "intervention") throw new Error("expected intervention");
  assert.equal(report.experiment.verification.variant.observed, null);
  assert.equal(report.experiment.verification.variant.outcome, "inconclusive");
  assert.equal(report.comparability.interventionVerified, false);
  assert.deepEqual(scanReportV2R2SemanticViolations(toPublicScanReportR2(report)), []);
});

test("subject mismatch remains an honestly ineligible, diff-censored comparison", () => {
  const input = comparisonInput("gpc", "baseline");
  input.variant.requestedUrl = "https://different.example.net/";
  input.variant.observedUrl = "https://different.example.net/";
  input.variant.evidence.requests[0].url = "https://different.example.net/";
  input.variant.evidence.requests[0].domain = "different.example.net";
  const report = buildNodeComparisonScanReportV2R2(input);
  assert.deepEqual(report.comparability.pairValidity, { eligible: false, reasons: ["subject-mismatch"] });
  assert.equal(report.comparability.perMetric["raw-counts"].eligible, false);
  assert.equal(report.diff.families["raw-counts"].eligible, false);
  assert.deepEqual(scanReportV2R2SemanticViolations(toPublicScanReportR2(report)), []);
});

test("comparison screenshots remain ephemeral even when each exceeds the public byte cap", () => {
  const input = comparisonInput("gpc", "baseline");
  const hugeScreenshot = `data:image/png;base64,${"A".repeat(NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES + 1)}`;
  input.baseline.screenshot = hugeScreenshot;
  input.variant.screenshot = hugeScreenshot;
  const report = buildNodeComparisonScanReportV2R2(input);
  assert.equal(report.ephemeral.baselineScreenshot, hugeScreenshot);
  assert.equal(report.ephemeral.variantScreenshot, hugeScreenshot);
  assert.equal(JSON.stringify(toPublicScanReportR2(report)).includes("screenshot"), false);
});

test("the comparison byte cap covers the aggregate public pair", () => {
  const input = comparisonInput("gpc", "baseline");
  const origins = Array.from({ length: 150_000 }, () => "https://example.com/");
  for (const arm of [input.baseline, input.variant]) {
    arm.evidence.fingerprintDetections.push({
      kind: "session-recording",
      heuristic: "interaction-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["input"],
        listenerTargets: ["document"],
        thirdPartyOrigins: origins,
        totalListenerCalls: 1
      },
      phaseId: 0
    });
  }
  const publicSize = (arm: NodeScanReportV2R2Input): number =>
    Buffer.byteLength(`${JSON.stringify(toPublicScanReportR2(buildNodeScanReportV2R2(arm)), null, 2)}\n`, "utf8");
  assert.ok(publicSize(input.baseline) < NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES);
  assert.ok(publicSize(input.variant) < NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES);
  assert.throws(
    () => buildNodeComparisonScanReportV2R2(input),
    new RegExp(`comparison larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES}`)
  );
});

test("the Node builder emits a validator-clean r2 shell with current provenance and derived blocks", () => {
  const report = buildNodeScanReportV2R2(baseInput());
  const meta = adblockListMeta();
  assert.notEqual(meta, null);

  assert.equal(report.schemaVersion, 2);
  assert.equal(report.schemaRevision, 2);
  assert.equal(report.reportType, "single");
  assert.equal(isEphemeralScanReportR2(report), true);
  assert.equal(report.run.provenance.observer, "node-playwright");
  assert.equal(report.run.provenance.methodologyVersion, NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION);
  assert.equal(report.run.provenance.methodologyVersion.includes(NODE_SCANNER_METHODOLOGY_VERSION), true);
  assert.equal(recordedPlaywrightVersion(report.run.provenance.methodologyVersion), NODE_PLAYWRIGHT_VERSION);
  assert.match(report.run.provenance.methodologyVersion, /\+consent-r2-v4\+/);
  assert.deepEqual(report.run.provenance.detectorRegistry, {
    version: DETECTOR_REGISTRY_VERSION,
    digest: DETECTOR_REGISTRY_DIGEST
  });
  assert.deepEqual(report.run.toolchain.trackerCatalog, {
    source: trackerCatalogMetadata.source,
    version: trackerCatalogMetadata.version,
    entries: trackerCatalogMetadata.entries,
    digest: trackerCatalogMetadata.digest
  });
  assert.equal(report.run.toolchain.adblock?.manifestDigest, meta?.manifestDigest);
  assert.equal(report.run.toolchain.adblock?.engineVersion, NODE_ADBLOCK_ENGINE_VERSION);
  assert.equal(report.run.toolchain.normalizationVersion, NODE_SCAN_REPORT_V2_R2_NORMALIZATION_VERSION);
  assert.match(report.run.fingerprints.execution, /^[0-9a-f]{64}$/);
  assert.equal(report.run.quality.run.outcome, "complete");
  assert.equal(report.run.summary.pageTitle, "", "page-authored titles do not persist in public r2 reports");
  assert.deepEqual(report.run.summary.countsByPhase, [
    { phaseId: 0, totalRequests: 1, thirdPartyRequests: 0, knownTrackerRequests: 0 }
  ]);
  assert.deepEqual(scanReportV2R2SemanticViolations(toPublicScanReportR2(report)), []);
});

test("valid 600-999 Node statuses fail closed at the frozen r2 boundary without inventing 599", () => {
  const input = baseInput();
  input.measurement.qualityFacts.status = 699;
  input.evidence.requests[0].status = 699;

  const report = buildNodeScanReportV2R2(input);
  const publicReport = toPublicScanReportR2(report);

  assert.equal(input.measurement.qualityFacts.status, 699, "the caller's staged facts are not mutated");
  assert.equal(input.evidence.requests[0].status, 699, "the caller's request evidence is not mutated");
  assert.equal(report.run.qualityFacts.status, null);
  assert.equal(report.run.summary.status, null);
  assert.equal(report.run.evidence.requests[0].status, null);
  assert.equal(report.run.quality.run.outcome, "failed");
  assert.equal(report.run.quality.run.reasons.includes("http-error-status"), true);
  assert.equal(report.run.quality.byFamily.requests.outcome, "censored");
  assert.deepEqual(
    report.run.qualityFacts.captureLoss.filter((entry) => entry.detail?.startsWith("r2-")),
    [
      {
        family: "requests",
        phaseId: null,
        kind: "dropped",
        count: 1,
        detail: R2_NAVIGATION_STATUS_UNREPRESENTABLE
      },
      {
        family: "requests",
        phaseId: 0,
        kind: "dropped",
        count: 1,
        detail: R2_REQUEST_STATUS_UNREPRESENTABLE
      }
    ]
  );
  assert.equal(JSON.stringify(publicReport).includes('"status":599'), false);
  assert.deepEqual(scanReportV2R2SemanticViolations(publicReport), []);
  assert.equal(readStoredScanReport(publicReport).ok, true);
});

test("an unrepresentable subresource status censors requests without failing a successful navigation", () => {
  const input = baseInput();
  input.evidence.requests.push({
    ...input.evidence.requests[0],
    id: 2,
    status: 799,
    startedAtMs: 30
  });

  const report = buildNodeScanReportV2R2(input);
  assert.equal(report.run.qualityFacts.status, 200);
  assert.equal(report.run.evidence.requests[1].status, null);
  assert.equal(report.run.quality.run.outcome, "complete");
  assert.equal(report.run.quality.run.reasons.includes("http-error-status"), false);
  assert.equal(report.run.quality.byFamily.requests.outcome, "censored");
  assert.deepEqual(scanReportV2R2SemanticViolations(toPublicScanReportR2(report)), []);
});

test("raw subject URLs cross redaction v2 inside the builder and never survive the shell", () => {
  const report = buildNodeScanReportV2R2(baseInput());
  assert.deepEqual(report.run.subject, {
    requested: {
      origin: "https://{label}.shop.example.com",
      registrableDomain: "example.com",
      routeShape: "/products/{seg}"
    },
    observed: {
      origin: "https://{label}.shop.example.com",
      registrableDomain: "example.com",
      routeShape: "/products/{seg}"
    }
  });
  assert.equal(report.run.privacy.redaction.pathSegmentsGeneralized, 3);
  assert.equal(report.run.privacy.redaction.subdomainLabelsGeneralized, 4);
  assert.equal(report.run.privacy.redaction.queryKeysRedacted, 2);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("Alice-Private"), false);
  assert.equal(serialized.includes("token=secret"), false);
  assert.equal(serialized.includes("session=secret"), false);
  assert.equal(serialized.includes("0123456789abcdef"), false);
});

test("trailing-dot subjects canonicalize to the correct registrable party", () => {
  const input = baseInput();
  input.requestedUrl = "https://WWW.EXAMPLE.COM./";
  input.observedUrl = "https://www.example.com./";
  input.evidence.requests[0].url = "https://www.example.com/";
  input.evidence.requests[0].domain = "www.example.com";
  const report = buildNodeScanReportV2R2(input);
  assert.equal(report.run.subject.requested.origin, "https://www.example.com");
  assert.equal(report.run.subject.requested.registrableDomain, "example.com");
  assert.equal(report.run.evidence.requests[0].thirdParty, false);
});

test("warnings cross the shared scanner-vocabulary boundary", () => {
  const input = baseInput();
  input.warnings = [
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget.",
    "The page says Alice's account is private"
  ];
  assert.deepEqual(buildNodeScanReportV2R2(input).run.warnings, [
    "The scan stopped loading additional response bytes after reaching the 64 MiB aggregate response-byte budget.",
    "[redacted warning]"
  ]);
});

test("verified r2 consent pairs drop the contradictory v1 dispatch-only warning", () => {
  const input = comparisonInput("consent", "baseline");
  for (const [arm, mode] of [
    [input.baseline, "accept-all"],
    [input.variant, "reject-all"]
  ] as const) {
    if (!arm.consent) throw new Error("fixture invariant");
    arm.consent.cmp = "OneTrust";
    arm.warnings = [consentInteractionWarning({ mode, clicked: true, cmp: "OneTrust" })];
  }

  const report = buildNodeComparisonScanReportV2R2(input);
  assert.equal(report.comparability.interventionVerified, true);
  assert.equal(report.baseline.evidence.consent?.choiceState, "verified");
  assert.equal(report.variant.evidence.consent?.choiceState, "verified");
  for (const warning of [...report.baseline.warnings, ...report.variant.warnings]) {
    assert.doesNotMatch(warning, /dispatched, not verified as registered/);
  }
});

test("the builder sanitizes every raw evidence and consent string at its own boundary", () => {
  const input = baseInput();
  input.evidence.requests[0].url =
    "https://alice-account.tracker.example.net/private/Alice?token=secret&utm_alice_private_account=secret&ud%5Balice_private_account%5D=secret";
  input.evidence.requests[0].domain = "alice-account.tracker.example.net";
  input.evidence.requests[0].thirdParty = true;
  input.evidence.requests[0].method = "ALICE-PRIVATE-ACCOUNT";
  input.evidence.requests[0].resourceType = "alice-secret-resource";
  input.evidence.cookiesFinal.push({
    name: "alice@example.com",
    domain: ".alice-account.example.com",
    path: "/patients/Alice",
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: true,
    thirdParty: false
  });
  input.evidence.storageFinal.push({ area: "localStorage", key: "alice@example.com", valueBytes: 12 });

  const report = buildNodeScanReportV2R2(input);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("Alice"), false);
  assert.equal(serialized.includes("alice@example.com"), false);
  assert.equal(serialized.includes("token=secret"), false);
  assert.equal(serialized.includes("utm_alice"), false);
  assert.equal(report.run.evidence.requests[0].method, "OTHER");
  assert.equal(report.run.evidence.requests[0].resourceType, "other");
  assert.ok(report.run.privacy.redaction.cookieNamesRedacted > 0);
  assert.ok(report.run.privacy.redaction.storageKeysRedacted > 0);

  const consentInput = baseInput();
  consentInput.conditions.consent = "reject-all";
  consentInput.measurement.phases.push({
    phaseId: 1,
    kind: "consent-interaction",
    startedAtMs: 1000,
    endedAtMs: 1500
  });
  consentInput.summary.durationMs = 1500;
  consentInput.consent = {
    interactionAttempted: true,
    controlActivated: true,
    verificationObservations: [],
    cmp: "Alice Private CMP",
    selector: "#alice-private-account",
    matchedText: "Alice's private choice",
    frameUrl: "https://alice-account.example.com/private/Alice?token=secret"
  };
  const consent = buildNodeScanReportV2R2(consentInput).run.evidence.consent;
  assert.equal(consent?.cmp, "[redacted]");
  assert.equal(consent?.selector, "[redacted]");
  assert.equal(consent?.matchedText, "[redacted]");
  assert.equal(consent?.frameUrl, "https://{label}.example.com/{seg}/{seg}");
  assert.equal(JSON.stringify(consent).includes("Alice"), false);
});

test("the builder publishes reviewed GitHub names but still omits cookie and storage values", () => {
  const input = baseInput();
  const cookie = {
    name: "_octo",
    domain: ".example.com",
    path: "/",
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: false,
    thirdParty: false,
    value: "must-not-serialize"
  };
  const storage = {
    area: "sessionStorage" as const,
    key: "soft-nav:marker",
    valueBytes: 1,
    value: "must-not-serialize"
  };
  input.evidence.cookiesFinal.push(cookie);
  input.evidence.cookieMutations.push({ phaseId: 0, op: "added", cookie });
  input.evidence.storageFinal.push(storage);
  input.evidence.storageMutations.push({ phaseId: 0, op: "added", entry: storage });

  const report = buildNodeScanReportV2R2(input);
  assert.equal(report.run.evidence.cookiesFinal[0].name, "_octo");
  assert.equal(report.run.evidence.cookieMutations[0].cookie.name, "_octo");
  assert.equal(report.run.evidence.storageFinal[0].key, "soft-nav:marker");
  assert.equal(report.run.evidence.storageMutations[0].entry.key, "soft-nav:marker");
  assert.equal(report.run.privacy.redaction.cookieNamesRedacted, 0);
  assert.equal(report.run.privacy.redaction.storageKeysRedacted, 0);
  assert.equal(JSON.stringify(report).includes("must-not-serialize"), false);
});

test("Playwright's closed network resource vocabulary survives without loss", () => {
  for (const resourceType of ["ping", "cspreport", "beacon"]) {
    const input = baseInput();
    input.evidence.requests[0].resourceType = resourceType;
    assert.equal(buildNodeScanReportV2R2(input).run.evidence.requests[0].resourceType, resourceType);
  }
});

test("producer-owned tracker and detector vocabularies cannot carry page strings", () => {
  const tracker = baseInput();
  tracker.evidence.requests[0].url = "https://tracker.example.net/collect";
  tracker.evidence.requests[0].domain = "tracker.example.net";
  tracker.evidence.requests[0].thirdParty = true;
  tracker.evidence.requests[0].tracker = {
    domain: "tracker.example.net",
    entity: "Alice Private Account",
    category: "patient-secret",
    confidence: "curated"
  };
  assert.throws(() => buildNodeScanReportV2R2(tracker), /current curated catalog/);

  const forgedCuratedHost = baseInput();
  forgedCuratedHost.evidence.requests[0].url = "https://tracker.example.net/collect";
  forgedCuratedHost.evidence.requests[0].domain = "tracker.example.net";
  forgedCuratedHost.evidence.requests[0].thirdParty = true;
  forgedCuratedHost.evidence.requests[0].tracker = findTrackerMatch("google-analytics.com");
  assert.notEqual(forgedCuratedHost.evidence.requests[0].tracker, null);
  assert.throws(() => buildNodeScanReportV2R2(forgedCuratedHost), /current curated catalog/);

  const forgedAssociation = baseInput();
  forgedAssociation.evidence.requests[0].tracker = findTrackerMatch("google-analytics.com");
  assert.notEqual(forgedAssociation.evidence.requests[0].tracker, null);
  assert.throws(() => buildNodeScanReportV2R2(forgedAssociation), /First-party request evidence/);

  const fingerprint = baseInput();
  fingerprint.evidence.fingerprintEvents.push({ api: "Alice Private API", count: 1, phaseId: 0 });
  assert.throws(() => buildNodeScanReportV2R2(fingerprint), /Unknown fingerprint event API/);

  const pixel = baseInput();
  pixel.evidence.pixelEvents.push({
    platform: "Alice Analytics",
    product: "Alice Private Pixel",
    events: ["Alice"],
    advancedMatching: [],
    requests: 1,
    phaseId: 0
  });
  assert.throws(() => buildNodeScanReportV2R2(pixel), /Unknown pixel platform or product/);

  const impossiblePixel = baseInput();
  impossiblePixel.evidence.pixelEvents.push({
    platform: "Meta",
    product: "Meta Pixel",
    events: ["PageView"],
    advancedMatching: [],
    requests: 0,
    phaseId: 0
  });
  assert.throws(() => buildNodeScanReportV2R2(impossiblePixel), /positive integer/);
});

test("opaque provenance and cookie enums cannot carry imported private strings", () => {
  const input = baseInput();
  input.evidence.requests[0].provenance = {
    graphRecordId: "AlicePrivatePatient",
    initiatorId: "AlicePrivatePatient",
    initiatorType: "Alice Private",
    scriptId: "BobPrivatePatient"
  };
  input.evidence.cookiesFinal.push({
    name: "_ga",
    domain: "example.com",
    path: "/",
    sameSite: "Alice Private",
    secure: true,
    httpOnly: false,
    session: true,
    thirdParty: false
  });
  const report = buildNodeScanReportV2R2(input);
  assert.deepEqual(report.run.evidence.requests[0].provenance, {
    graphRecordId: "id-000001",
    initiatorId: "id-000001",
    initiatorType: "[redacted]",
    scriptId: "id-000002"
  });
  assert.equal(report.run.evidence.cookiesFinal[0].sameSite, "Unspecified");
  assert.equal(JSON.stringify(report).includes("AlicePrivatePatient"), false);
  assert.equal(JSON.stringify(report).includes("BobPrivatePatient"), false);
});

test("request, cookie, and CNAME evidence is numerically valid and party-grounded", () => {
  for (const status of [-1.5, 99, 1_000]) {
    const badStatus = baseInput();
    badStatus.measurement.qualityFacts.status = status;
    assert.throws(() => buildNodeScanReportV2R2(badStatus), /quality HTTP status/);

    const badRequestStatus = baseInput();
    badRequestStatus.evidence.requests[0].status = status;
    assert.throws(() => buildNodeScanReportV2R2(badRequestStatus), /request evidence HTTP status/);
  }

  const duplicateRequest = baseInput();
  duplicateRequest.evidence.requests.push({ ...duplicateRequest.evidence.requests[0] });
  assert.throws(() => buildNodeScanReportV2R2(duplicateRequest), /positive and unique/);

  const negativePhase = baseInput();
  negativePhase.measurement.phases[0].startedAtMs = -1;
  assert.throws(() => buildNodeScanReportV2R2(negativePhase), /nonnegative integer spans/);

  const wrongCookieParty = baseInput();
  wrongCookieParty.evidence.cookiesFinal.push({
    name: "_ga",
    domain: ".google-analytics.com",
    path: "/",
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: false,
    thirdParty: false
  });
  assert.throws(() => buildNodeScanReportV2R2(wrongCookieParty), /Cookie evidence third-party classification/);

  const google = findTrackerMatch("google-analytics.com");
  assert.notEqual(google, null);
  const validCname = baseInput();
  validCname.evidence.cnameCloaks.push({
    host: validCname.evidence.requests[0].domain,
    cname: "google-analytics.com",
    tracker: google!
  });
  assert.equal(buildNodeScanReportV2R2(validCname).run.evidence.cnameCloaks.length, 1);

  const unrelatedCname = baseInput();
  unrelatedCname.evidence.cnameCloaks.push({
    host: "unrelated.example.net",
    cname: "google-analytics.com",
    tracker: google!
  });
  assert.throws(() => buildNodeScanReportV2R2(unrelatedCname), /observed first-party alias/);

  const unobservedAlias = baseInput();
  unobservedAlias.evidence.cnameCloaks.push({
    host: "cdn.example.com",
    cname: "google-analytics.com",
    tracker: google!
  });
  assert.throws(() => buildNodeScanReportV2R2(unobservedAlias), /grounded in an observed first-party request/);
});

test("policy summaries are unique, disjoint, long enough, and grounded after request clipping", () => {
  const invalid = baseInput();
  invalid.conditions.probes.policyVisit = true;
  invalid.measurement.phases.push({ phaseId: 1, kind: "policy-analysis", startedAtMs: 1000, endedAtMs: 1100 });
  invalid.measurement.detectors["privacy-policy"] = {
    version: DETECTOR_VERSIONS["privacy-policy"],
    status: "complete",
    phaseId: 1
  };
  invalid.summary.durationMs = 1100;
  invalid.evidence.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [
      { kind: "honors-gpc", quote: "We honor Global Privacy Control." },
      { kind: "honors-gpc", quote: "We respect Global Privacy Control." }
    ],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 1_000
  };
  assert.throws(() => buildNodeScanReportV2R2(invalid), /claim kind values must be unique/);

  const short = structuredClone(invalid);
  short.evidence.privacyPolicy!.claims = [];
  short.evidence.privacyPolicy!.policyTextLength = 499;
  assert.throws(() => buildNodeScanReportV2R2(short), /at least 500/);

  const clipped = baseInput();
  clipped.conditions.probes.policyVisit = true;
  clipped.measurement.phases.push({ phaseId: 1, kind: "policy-analysis", startedAtMs: 1000, endedAtMs: 1100 });
  clipped.measurement.detectors["privacy-policy"] = {
    version: DETECTOR_VERSIONS["privacy-policy"],
    status: "complete",
    phaseId: 1
  };
  clipped.summary.durationMs = 1100;
  clipped.evidence.requests = Array.from({ length: 1_000 }, (_, index) => ({
    ...clipped.evidence.requests[0],
    id: index + 1
  }));
  const googleTracker = findTrackerMatch("google-analytics.com");
  assert.notEqual(googleTracker, null);
  clipped.evidence.requests.push({
    ...clipped.evidence.requests[0],
    id: 1_001,
    url: "https://google-analytics.com/g/collect",
    domain: "google-analytics.com",
    thirdParty: true,
    tracker: googleTracker
  });
  clipped.evidence.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [],
    mentionedEntities: [googleTracker!.entity],
    unmentionedEntities: [],
    policyTextLength: 1_000
  };
  const report = buildNodeScanReportV2R2(clipped);
  assert.deepEqual(report.run.evidence.privacyPolicy?.mentionedEntities, []);
  assert.equal(
    report.run.qualityFacts.captureLoss.some(
      (loss) => loss.detail === "public-policy-entities" && loss.count === 1
    ),
    true
  );
});

test("public evidence arrays clip with explicit family-scoped capture loss", () => {
  const input = baseInput();
  input.evidence.requests = Array.from({ length: 1_001 }, (_, index) => ({
    ...input.evidence.requests[0],
    id: index + 1,
    startedAtMs: Math.min(index, 999)
  }));
  const report = buildNodeScanReportV2R2(input);
  assert.equal(report.run.evidence.requests.length, 1_000);
  assert.equal(report.run.quality.byFamily.requests.outcome, "censored");
  assert.deepEqual(report.run.qualityFacts.captureLoss.at(-1), {
    family: "requests",
    phaseId: null,
    kind: "clipped",
    count: 1,
    detail: "public-request-records"
  });
});

test("requests on an exact private suffix are omitted with explicit request capture loss", () => {
  const input = baseInput();
  input.evidence.requests.push({
    ...input.evidence.requests[0],
    id: 2,
    url: "https://s3-us-gov-west-1.amazonaws.com/cdn-digitalgov-us-gov/waittime.json",
    domain: "s3-us-gov-west-1.amazonaws.com",
    resourceType: "fetch",
    thirdParty: true,
    tracker: null,
    startedAtMs: 500
  });

  const report = buildNodeScanReportV2R2(input);
  assert.equal(report.run.evidence.requests.length, 1);
  assert.equal(
    report.run.evidence.requests.some((request) => request.domain.includes("s3-us-gov-west-1")),
    false
  );
  assert.equal(report.run.quality.byFamily.requests.outcome, "censored");
  assert.deepEqual(
    report.run.qualityFacts.captureLoss.find(
      (loss) => loss.detail === "public-request-unregistrable-hosts"
    ),
    {
      family: "requests",
      phaseId: null,
      kind: "dropped",
      count: 1,
      detail: "public-request-unregistrable-hosts"
    }
  );
  assert.equal(
    report.run.qualityFacts.budgetsExhausted.includes("public-request-unregistrable-hosts"),
    false
  );
  assert.deepEqual(scanReportV2R2SemanticViolations(report), []);
});

test("unknown and special-use request hosts remain invalid rather than becoming capture loss", () => {
  const input = baseInput();
  input.evidence.requests.push({
    ...input.evidence.requests[0],
    id: 2,
    url: "https://alice.internal/telemetry",
    domain: "alice.internal",
    resourceType: "fetch",
    thirdParty: true,
    tracker: null,
    startedAtMs: 500
  });

  assert.throws(
    () => buildNodeScanReportV2R2(input),
    /request evidence host has no public registrable domain/i
  );
});

test("the final byte cap covers nested public evidence but excludes the ephemeral screenshot", () => {
  const oversized = baseInput();
  oversized.evidence.fingerprintDetections.push({
    kind: "session-recording",
    heuristic: "interaction-listener-coverage-v1",
    count: 1,
    evidence: {
      eventTypes: ["input"],
      listenerTargets: ["document"],
      thirdPartyOrigins: Array.from({ length: 450_000 }, () => "https://example.com/"),
      totalListenerCalls: 1
    },
    phaseId: 0
  });
  assert.throws(
    () => buildNodeScanReportV2R2(oversized),
    new RegExp(`larger than ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES}`)
  );

  const privateScreenshot = baseInput();
  privateScreenshot.screenshot = `data:image/png;base64,${"A".repeat(NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES + 1)}`;
  assert.equal(buildNodeScanReportV2R2(privateScreenshot).ephemeral.screenshot, privateScreenshot.screenshot);
});

test("missing block-simulation facts and oversized producer strings fail closed", () => {
  const missingFacts = baseInput();
  missingFacts.conditions.shields = "block-simulation";
  assert.throws(() => buildNodeScanReportV2R2(missingFacts), /structured Shields verification facts/);

  const oversized = baseInput();
  oversized.conditions.locale = "x".repeat(100);
  assert.throws(() => buildNodeScanReportV2R2(oversized), /producer-owned text envelope/);
});

test("failed intervention application remains evidence instead of being rejected", () => {
  const input = baseInput();
  input.conditions.gpc = false;
  input.conditions.shields = "block-simulation";
  input.verificationFacts = {
    gpc: {
      method: "gpc-header-readback@1",
      header: "confirmed-present",
      jsSignal: "confirmed-true",
      observedOn: "first-party-navigation",
      phaseId: 0
    },
    shields: {
      method: "shields-engine-status@1",
      engineLoaded: true,
      applied: false,
      requestsEvaluated: 1,
      requestsMatched: 0,
      requestsActuallyBlocked: 0,
      phaseId: 0
    }
  };
  const report = buildNodeScanReportV2R2(input);
  assert.equal(report.run.verificationFacts?.gpc?.header, "confirmed-present");
  assert.equal(report.run.verificationFacts?.shields?.applied, false);
});

test("the named-field r2 projection strips screenshots and reader dispatch accepts the result", () => {
  const shell = buildNodeScanReportV2R2(baseInput());
  const publicReport = toPublicScanReportR2(shell);
  assert.equal("ephemeral" in publicReport, false);
  assert.equal(JSON.stringify(publicReport).includes("PRIVATE_SCREENSHOT"), false);
  assert.equal(isPublicScanReportV2R2(publicReport), true);

  const read = readStoredScanReport(publicReport);
  assert.equal(read.ok, true, JSON.stringify(!read.ok ? read.violations : []));
  if (read.ok && read.stored.schemaVersion === 2) assert.equal(read.stored.schemaRevision, 2);
});

test("consent conclusions are derived: partial strong evidence stays unavailable", () => {
  const input = baseInput();
  input.conditions.consent = "reject-all";
  input.measurement.phases.push({
    phaseId: 1,
    kind: "consent-interaction",
    startedAtMs: 1000,
    endedAtMs: 1500
  });
  input.summary.durationMs = 1500;
  input.consent = {
    interactionAttempted: true,
    controlActivated: true,
    verificationObservations: [
      {
        phaseId: 1,
        method: "onetrust-cookie@1",
        observed: "rejected-all",
        result: { outcome: "read", sequence: 0 }
      }
    ]
  };

  const consent = buildNodeScanReportV2R2(input).run.evidence.consent;
  assert.notEqual(consent, undefined);
  assert.equal(consent?.verificationObservations[0].consistentWithChoice, true);
  assert.equal(consent?.choiceState, "unavailable", "one read without post-reload verification cannot become verified");
  assert.equal(consent?.reverifiedAfterReload, false);
});

test("unknown TCF reads cannot contradict either consent choice", () => {
  for (const mode of ["accept-all", "reject-all"] as const) {
    const input = baseInput();
    input.conditions.consent = mode;
    input.measurement.phases.push(
      { phaseId: 1, kind: "consent-interaction", startedAtMs: 1000, endedAtMs: 1500 },
      { phaseId: 2, kind: "post-choice-reload", startedAtMs: 1500, endedAtMs: 2000 }
    );
    input.summary.durationMs = 2000;
    input.consent = {
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [
        {
          phaseId: 1,
          method: TCF_API_METHOD,
          observed: "unknown",
          result: { outcome: "read", sequence: 0 }
        },
        {
          phaseId: 2,
          method: TCF_API_METHOD,
          observed: "unknown",
          result: { outcome: "read", sequence: 1 }
        }
      ]
    };

    const consent = buildNodeScanReportV2R2(input).run.evidence.consent;
    assert.deepEqual(
      consent?.verificationObservations.map((observation) => observation.consistentWithChoice),
      [null, null],
      mode
    );
    assert.equal(consent?.choiceState, "unavailable", mode);
    assert.equal(consent?.reverifiedAfterReload, false, mode);
  }
});

test("weak consent is emitted only from a grounded banner transition", () => {
  const input = baseInput();
  input.conditions.consent = "accept-all";
  input.measurement.phases.push({
    phaseId: 1,
    kind: "consent-interaction",
    startedAtMs: 1000,
    endedAtMs: 1500
  });
  input.summary.durationMs = 1500;
  input.consent = {
    interactionAttempted: true,
    controlActivated: true,
    verificationObservations: [],
    bannerTransition: {
      method: "banner-visibility@1",
      observations: [
        { moment: "before-interaction", phaseId: 1, atMs: 1100, visible: true },
        { moment: "after-interaction", phaseId: 1, atMs: 1400, visible: false }
      ]
    }
  };

  const consent = buildNodeScanReportV2R2(input).run.evidence.consent;
  assert.equal(consent?.choiceState, "weak-signal");
  assert.equal(consent?.reverifiedAfterReload, false);
});

test("two strong reads can establish verified consent only across interaction and reload phases", () => {
  const input = baseInput();
  input.conditions.consent = "reject-all";
  input.measurement.phases.push(
    { phaseId: 1, kind: "consent-interaction", startedAtMs: 1000, endedAtMs: 1500 },
    { phaseId: 2, kind: "post-choice-reload", startedAtMs: 1500, endedAtMs: 2000 }
  );
  input.summary.durationMs = 2000;
  input.consent = {
    interactionAttempted: true,
    controlActivated: true,
    verificationObservations: [
      {
        phaseId: 1,
        method: TCF_API_METHOD,
        observed: "rejected-all",
        result: { outcome: "read", sequence: 0 }
      },
      {
        phaseId: 2,
        method: TCF_API_METHOD,
        observed: "rejected-all",
        result: { outcome: "read", sequence: 1 }
      }
    ]
  };

  const consent = buildNodeScanReportV2R2(input).run.evidence.consent;
  assert.equal(consent?.choiceState, "verified");
  assert.equal(consent?.reverifiedAfterReload, true);
});

test("build provenance comes only from the immutable environment and fails closed when unknown", () => {
  const original = process.env[BUILD_COMMIT_ENV];
  try {
    const fromEnvironment = baseInput();
    delete process.env[BUILD_COMMIT_ENV];
    assert.throws(() => buildNodeScanReportV2R2(fromEnvironment), /full 40-character Git commit/);

    const injected = buildNodeScanReportV2R2(fromEnvironment, { [BUILD_COMMIT_ENV]: "C".repeat(40) });
    assert.equal(injected.run.provenance.buildCommit, "c".repeat(40));

    process.env[BUILD_COMMIT_ENV] = "B".repeat(40);
    const report = buildNodeScanReportV2R2(fromEnvironment);
    assert.equal(report.run.provenance.buildCommit, "b".repeat(40));
  } finally {
    if (original === undefined) delete process.env[BUILD_COMMIT_ENV];
    else process.env[BUILD_COMMIT_ENV] = original;
  }
});

test("toolchain identity drift and literal unknown values fail closed", () => {
  const report = buildNodeScanReportV2R2(baseInput());
  const unknownCatalog = structuredClone(report.run.toolchain);
  unknownCatalog.trackerCatalog.version = "unknown";
  assert.throws(() => assertKnownNodeToolchainIdentity(unknownCatalog), /unknown|does not match/);

  const staleCatalog = structuredClone(report.run.toolchain);
  staleCatalog.trackerCatalog.digest = "0".repeat(64);
  assert.throws(() => assertKnownNodeToolchainIdentity(staleCatalog), /does not match/);

  const unknownEngine = structuredClone(report.run.toolchain);
  assert.notEqual(unknownEngine.adblock, null);
  if (unknownEngine.adblock !== null) unknownEngine.adblock.engineVersion = "unknown";
  assert.throws(() => assertKnownNodeToolchainIdentity(unknownEngine), /unknown/);

  const noEngine = baseInput();
  noEngine.adblockEngineLoaded = false;
  assert.equal(buildNodeScanReportV2R2(noEngine).run.toolchain.adblock, null, "known absence is represented as null");

  const shieldsTrackerWithoutEngine = baseInput();
  shieldsTrackerWithoutEngine.adblockEngineLoaded = false;
  shieldsTrackerWithoutEngine.evidence.requests.push({
    id: 2,
    url: "https://tracker.example.net/collect",
    domain: "tracker.example.net",
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty: true,
    tracker: {
      domain: "example.net",
      entity: "example.net",
      category: "tracking (Brave Shields list)",
      confidence: "shields-list"
    },
    blockedByShields: false,
    startedAtMs: 30,
    phaseId: 0
  });
  assert.throws(
    () => buildNodeScanReportV2R2(shieldsTrackerWithoutEngine),
    /Shields-list tracker evidence requires the loaded adblock toolchain identity/
  );

  const blockedWithoutEngine = baseInput();
  blockedWithoutEngine.adblockEngineLoaded = false;
  blockedWithoutEngine.evidence.requests[0].blockedByShields = true;
  assert.throws(
    () => buildNodeScanReportV2R2(blockedWithoutEngine),
    /Shields-derived request evidence requires the loaded adblock toolchain identity/
  );
});

test("detector drift and internally inconsistent observations are rejected before emission", () => {
  const drift = baseInput();
  drift.measurement.detectors["pixel-events"].version = "unknown";
  assert.throws(() => buildNodeScanReportV2R2(drift), /does not match registry/);

  const mistagged = baseInput();
  mistagged.evidence.requests[0].startedAtMs = 1500;
  mistagged.summary.durationMs = 1500;
  assert.throws(() => buildNodeScanReportV2R2(mistagged), /starts outside its declared phase span/);

  const malformedConsent = baseInput();
  malformedConsent.conditions.consent = "accept-all";
  malformedConsent.measurement.phases.push({
    phaseId: 1,
    kind: "consent-interaction",
    startedAtMs: 1000,
    endedAtMs: 1500
  });
  malformedConsent.summary.durationMs = 1500;
  malformedConsent.consent = {
    interactionAttempted: true,
    controlActivated: true,
    verificationObservations: [
      {
        phaseId: 1,
        method: TCF_API_METHOD,
        observed: null,
        result: { outcome: "read", sequence: 0 }
      }
    ]
  };
  assert.throws(() => buildNodeScanReportV2R2(malformedConsent), /outcome read disagrees with its observed state/);
});

test("phase plans follow enabled conditions and cannot smuggle impossible phases", () => {
  const wrongFirst = baseInput();
  wrongFirst.measurement.phases[0].kind = "active-probe";
  assert.throws(() => buildNodeScanReportV2R2(wrongFirst), /start with passive-load/);

  const observeConsent = baseInput();
  observeConsent.measurement.phases.push({
    phaseId: 1,
    kind: "consent-interaction",
    startedAtMs: 1000,
    endedAtMs: 1100
  });
  observeConsent.summary.durationMs = 1100;
  assert.throws(() => buildNodeScanReportV2R2(observeConsent), /Observe-mode/);

  const undeclaredProbe = baseInput();
  undeclaredProbe.measurement.phases.push({
    phaseId: 1,
    kind: "active-probe",
    startedAtMs: 1000,
    endedAtMs: 1100
  });
  undeclaredProbe.summary.durationMs = 1100;
  assert.throws(() => buildNodeScanReportV2R2(undeclaredProbe), /declared keystroke probe/);

  const unaccountedSkip = baseInput();
  unaccountedSkip.conditions.probes.keystroke = true;
  assert.throws(() => buildNodeScanReportV2R2(unaccountedSkip), /keystroke detector outcome that explains the omission/);

  const accountedSkip = baseInput();
  accountedSkip.conditions.probes.keystroke = true;
  accountedSkip.measurement.detectors["keystroke-exfiltration"] = {
    version: DETECTOR_VERSIONS["keystroke-exfiltration"],
    status: "skipped",
    reason: "budget-unavailable"
  };
  assert.equal(buildNodeScanReportV2R2(accountedSkip).run.phases.length, 1);

  const wrongProbePhase = baseInput();
  wrongProbePhase.conditions.probes.keystroke = true;
  wrongProbePhase.measurement.phases.push({ phaseId: 1, kind: "active-probe", startedAtMs: 1000, endedAtMs: 1100 });
  wrongProbePhase.measurement.detectors["keystroke-exfiltration"] = {
    version: DETECTOR_VERSIONS["keystroke-exfiltration"],
    status: "complete",
    phaseId: 0
  };
  wrongProbePhase.summary.durationMs = 1100;
  assert.throws(() => buildNodeScanReportV2R2(wrongProbePhase), /ledger must identify the active-probe phase/);

  const unrunAlwaysOn = baseInput();
  unrunAlwaysOn.measurement.detectors["pixel-events"] = {
    version: DETECTOR_VERSIONS["pixel-events"],
    status: "skipped",
    reason: "not-requested"
  };
  assert.throws(() => buildNodeScanReportV2R2(unrunAlwaysOn), /Always-on detector pixel-events/);
});

test("a consent run whose interaction never happened still builds a degraded, accountable report", () => {
  // Two invariants used to be jointly unsatisfiable. The contract requires
  // consent evidence on every consent-mode run, a consent-interaction phase,
  // and a consent-banner detector reporting activity; a bot-walled page or a
  // probe that ran out of budget produces none of the last two. The builder
  // then threw, so the whole scan failed instead of publishing an honest
  // "the interaction did not happen" report.
  const blockedByWall = baseInput();
  blockedByWall.conditions.consent = "accept-all";
  blockedByWall.measurement.detectors["consent-banner"] = {
    version: DETECTOR_VERSIONS["consent-banner"],
    status: "skipped",
    reason: "load-failed"
  };
  blockedByWall.consent = {
    interactionAttempted: false,
    controlActivated: false,
    verificationObservations: []
  };

  const report = buildNodeScanReportV2R2(blockedByWall);
  assert.equal(report.reportType, "single");
  const run = report.run;
  assert.equal(run.evidence.consent?.interactionAttempted, false);
  assert.equal(run.evidence.consent?.controlActivated, false);
  assert.equal(run.phases.some((span) => span.kind === "consent-interaction"), false);
  assert.deepEqual(scanReportV2R2SemanticViolations(report), []);

  // A probe that broke mid-run is the same shape with a different reason. The
  // detector registry decides which reason is legal for which status, so this
  // walks the pairs the scanner actually emits.
  for (const { status, reason } of [
    { status: "failed", reason: "scan-failed" },
    { status: "failed", reason: "engine-unavailable" },
    { status: "skipped", reason: "budget-unavailable" }
  ] as const) {
    const brokenProbe = baseInput();
    brokenProbe.conditions.consent = "reject-all";
    brokenProbe.measurement.detectors["consent-banner"] = {
      version: DETECTOR_VERSIONS["consent-banner"],
      status,
      reason
    };
    brokenProbe.consent = { interactionAttempted: false, controlActivated: false, verificationObservations: [] };
    assert.deepEqual(scanReportV2R2SemanticViolations(buildNodeScanReportV2R2(brokenProbe)), [], `${status}/${reason}`);
  }
});

test("an unexplained missing consent interaction is still refused", () => {
  // The escape hatch is accountability, not absence: a consent-mode run that
  // simply omits the phase with a complete detector, or claims an attempt it
  // has no phase for, must still reject.
  const unexplained = baseInput();
  unexplained.conditions.consent = "accept-all";
  unexplained.consent = { interactionAttempted: false, controlActivated: false, verificationObservations: [] };
  assert.throws(() => buildNodeScanReportV2R2(unexplained), /consent-interaction phase/);

  const claimsAnAttempt = baseInput();
  claimsAnAttempt.conditions.consent = "accept-all";
  claimsAnAttempt.measurement.detectors["consent-banner"] = {
    version: DETECTOR_VERSIONS["consent-banner"],
    status: "skipped",
    reason: "load-failed"
  };
  claimsAnAttempt.consent = { interactionAttempted: true, controlActivated: false, verificationObservations: [] };
  assert.throws(() => buildNodeScanReportV2R2(claimsAnAttempt), /consent-interaction phase/);
});

test("every capture-loss detail a producer can record is registered in BUDGET_FAMILIES", async () => {
  // assertQualityVocabulary resolves capture-loss DETAILS through the same
  // table as budget names and throws on an unknown one, which surfaces to the
  // visitor as a 500 from the generic error mapper. `policy-link-candidates`
  // shipped unregistered and broke every scan of a site whose page carries
  // more privacy-policy link candidates than the cap, github.com among them.
  // Two more, `keystroke-probe-capture` and `page-title`, were latent behind
  // rarer conditions. Read the producers instead of restating their vocabulary
  // here, so a new detail cannot be added without registering it.
  const producers = ["scanner.ts", "scan-runtime.ts", "public-scan-proxy.ts", "measurement-kernel.ts"];
  const recorded = new Map<string, Set<string>>();
  for (const name of producers) {
    const source = await readFile(path.join(process.cwd(), "lib", name), "utf8");
    for (const call of source.split("recordCaptureLoss({").slice(1)) {
      const block = call.slice(0, call.indexOf("})"));
      const family = block.match(/family:\s*"([a-z-]+)"/)?.[1];
      const detail = block.match(/detail:\s*"([a-z0-9-]+)"/)?.[1];
      if (!family || !detail) continue;
      if (!recorded.has(detail)) recorded.set(detail, new Set());
      recorded.get(detail)!.add(family);
    }
  }

  assert.ok(recorded.size >= 5, `expected to find recorded details, found ${recorded.size}`);
  assert.ok(recorded.has("policy-link-candidates"), "the regression case must still be covered");
  // The consent helper passes its detail through a typed local variable, so
  // the literal-source scanner below cannot discover it automatically.
  assert.equal(BUDGET_FAMILIES["consent-banner"], "detector-output");

  const unregistered: string[] = [];
  const misfiled: string[] = [];
  for (const [detail, families] of recorded) {
    const registered = BUDGET_FAMILIES[detail];
    if (registered === undefined) {
      unregistered.push(detail);
      continue;
    }
    for (const family of families) {
      if (family !== registered) misfiled.push(`${detail}: recorded as ${family}, registered as ${registered}`);
    }
  }
  assert.deepEqual(unregistered, [], `capture-loss details missing from BUDGET_FAMILIES: ${unregistered.join(", ")}`);
  assert.deepEqual(misfiled, [], `capture-loss details registered under the wrong family: ${misfiled.join(", ")}`);
});
