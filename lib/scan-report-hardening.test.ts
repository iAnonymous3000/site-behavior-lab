/**
 * Acceptance tests for the foundation-hardening patch (v2 RFC review,
 * 2026-07-09): closed diff boundary, deep default-deny validation, semantic
 * reject-on-read, hardened v1 boundary, and the consumer seam.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeEphemeralSingleReport,
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeScanReportV1,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import { isPublicComparisonReportV2, isPublicScanReportV2, isPublicSingleReportV2 } from "./scan-report-v2-validation";
import { readStoredScanReport } from "./scan-report-reader";
import {
  comparisonArmViews,
  comparisonDiffView,
  displayRunView,
  familyCensoredOnRun,
  publicWireForExportOrPersistence,
  readScanTransportPayload,
  requestEvidenceState,
  runHitRequestRecordingCap,
  schemaProvenanceLabel,
  toReportView,
  viewFromV1Report,
  viewFromV2
} from "./scan-report-view";
import { degradedRunNotice, runCensorshipNotes, runQualitySummary } from "./scan-report-censorship";
import { makeGpcInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { evaluateComparability, evaluateQuality } from "./scan-report-v2-evaluators";
import {
  compareScanResults,
  createComparisonReport,
  createConsentComparisonReport,
  createGpcComparisonReport,
  createShieldsComparisonReport,
  createTemporalComparisonReport
} from "./compare-reports";
import type { ScanReport, ScanResult } from "./types";
import { buildFingerprints } from "./scan-report-v2-fingerprints";
import { makeScanRunV2 } from "./scan-report-v2-fixtures";
import { sha256Hex } from "./sha256";
import { COMPARISON_REQUEST_CAP } from "./comparison-eligibility";
import { buildReportHeadline } from "./report-headline";

function mutate<T>(fixture: T, apply: (draft: T) => void): T {
  const draft = structuredClone(fixture);
  apply(draft);
  return draft;
}

type AnyRecord = Record<string, any>;

test("a secret smuggled under diff is rejected by validation", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    (draft.diff as AnyRecord).screenshot = "SECRET";
  });
  assert.equal(isPublicComparisonReportV2(report), false);

  const nested = mutate(makeInterventionComparisonReportV2(), (draft) => {
    (draft.diff.families["raw-counts"] as AnyRecord).screenshot = "SECRET";
  });
  assert.equal(isPublicComparisonReportV2(nested), false);
});

test("a forged diff that does not derive from the runs reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    draft.diff.families["raw-counts"].metrics.totalRequests.delta = 999;
  });
  assert.equal(isPublicComparisonReportV2(report), true); // structurally fine
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("unknown fields in every nested evidence record are rejected", () => {
  const injections: Array<(draft: ReturnType<typeof makePublicSingleReportV2>) => void> = [
    (draft) => ((draft.run.evidence.requests[0] as AnyRecord).rawHeaders = { cookie: "SECRET" }),
    (draft) => ((draft.run.evidence.requests[0].tracker as AnyRecord) = { domain: "t.example", entity: "T", category: "ads", confidence: "curated", extra: 1 }),
    (draft) => draft.run.evidence.cookiesFinal.push({ extra: true } as AnyRecord as never),
    (draft) => draft.run.evidence.storageFinal.push({ area: "localStorage", key: "k", valueBytes: 1, extra: 1 } as AnyRecord as never),
    (draft) => draft.run.evidence.fingerprintEvents.push({ api: "canvas", count: 1, phaseId: 0, extra: 1 } as AnyRecord as never),
    (draft) =>
      draft.run.evidence.cnameCloaks.push({ host: "a.example.com", cname: "t.tracker.example", tracker: { domain: "t", entity: "T", category: "c", confidence: "curated" }, extra: 1 } as AnyRecord as never),
    (draft) =>
      draft.run.evidence.pixelEvents.push({ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: ["not-a-field"], requests: 1, phaseId: 0 } as AnyRecord as never),
    (draft) =>
      ((draft.run.evidence as AnyRecord).privacyPolicy = { url: "https://example.com/privacy", claims: [{ kind: "made-up-claim", quote: "q" }], mentionedEntities: [], unmentionedEntities: [], policyTextLength: 10 }),
    (draft) =>
      draft.run.evidence.cookieMutations.push({ phaseId: 0, op: "added", cookie: { name: "a", domain: "example.com", path: "/", sameSite: "Lax", secure: true, httpOnly: false, session: true, thirdParty: false }, extra: 1 } as AnyRecord as never),
    (draft) => ((draft.run.qualityFacts.captureLoss as AnyRecord[]).push({ family: "requests", phaseId: 0, kind: "cap", count: 1, detail: "NOT A CODE!" }))
  ];
  for (const [index, inject] of injections.entries()) {
    const report = mutate(makePublicSingleReportV2(), inject);
    assert.equal(isPublicSingleReportV2(report), false, `injection ${index} was accepted`);
  }

  // A request that is nothing but a phaseId and a smuggled field.
  const skeletonRequest = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.evidence.requests as AnyRecord[])[0] = { phaseId: 0, screenshot: "SECRET" };
  });
  assert.equal(isPublicSingleReportV2(skeletonRequest), false);
});

test("raw CMP payloads cannot ship in consent observations", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.evidence as AnyRecord).consent = {
      mode: "reject-all",
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [
        { phaseId: 0, method: "onetrust-cookie@1", observed: "groups=C0001:1,C0002:0", consistentWithChoice: true }
      ],
      choiceState: "verified",
      reverifiedAfterReload: false
    };
  });
  assert.equal(isPublicSingleReportV2(report), false);
});

test("a malformed v1 upload returns a typed error without crashing", () => {
  const nullRequest = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).requests = [null];
  });
  assert.deepEqual(readStoredScanReport(nullRequest), { ok: false, error: "invalid" });

  const namelessCookie = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).cookies = [{ domain: 3 }];
  });
  assert.deepEqual(readStoredScanReport(namelessCookie), { ok: false, error: "invalid" });

  const stringSummary = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).summary.totalRequests = "12";
  });
  assert.deepEqual(readStoredScanReport(stringSummary), { ok: false, error: "invalid" });
});

test("a structurally valid v1 upload must reconcile its conclusions with its evidence", () => {
  const forgedSummary = mutate(makeScanReportV1(), (draft) => {
    if (draft.reportType === "comparison") throw new Error("expected single fixture");
    draft.summary.totalRequests = 400;
    draft.summary.thirdPartyRequests = 95;
  });
  const summaryRead = readStoredScanReport(forgedSummary);
  assert.equal(summaryRead.ok, false);
  if (!summaryRead.ok) {
    assert.equal(summaryRead.error, "inconsistent");
    assert.equal(summaryRead.violations?.some((entry) => entry.includes("summary.totalRequests")), true);
  }

  const forgedDiff = makeScanReportV1Comparison();
  forgedDiff.diff.totalRequests = { before: 1, after: 1, delta: 999 };
  const diffRead = readStoredScanReport(forgedDiff);
  assert.equal(diffRead.ok, false);
  if (!diffRead.ok) {
    assert.equal(diffRead.error, "inconsistent");
    assert.equal(diffRead.violations?.includes("comparison: diff does not reconcile with the two runs"), true);
  }
});

test("a negative v1 fingerprint-event count is rejected before it can drive an absence headline", () => {
  const report = mutate(makeScanReportV1(), (draft) => {
    if (draft.reportType === "comparison") throw new Error("expected single fixture");
    draft.fingerprintEvents = [{ api: "canvas.toDataURL", count: -1 }];
    draft.summary.fingerprintEvents = -1;
  });

  const read = readStoredScanReport(report);
  const renderedSubhead = read.ok ? buildReportHeadline(toReportView(read.stored)).subhead : null;
  assert.equal(
    read.ok,
    false,
    `negative fingerprint evidence reached the public headline: ${renderedSubhead ?? "not rendered"}`
  );
  assert.deepEqual(read, { ok: false, error: "invalid" });
});

test("v1 count-like facts and derived diff endpoints must be non-negative safe integers", () => {
  const invalidRuns: Array<[string, (draft: AnyRecord) => void]> = [
    ["fractional event count", (draft) => {
      draft.fingerprintEvents = [{ api: "canvas.toDataURL", count: 0.5 }];
      draft.summary.fingerprintEvents = 0.5;
    }],
    ["negative storage size", (draft) => {
      draft.storage = [{ area: "localStorage", key: "theme", valueBytes: -1 }];
      draft.summary.storageEntries = 1;
    }],
    ["negative pixel request count", (draft) => {
      draft.pixelEvents = [{ platform: "Meta", product: "Meta Pixel", events: [], advancedMatching: [], requests: -1 }];
    }],
    ["negative catalog entry count", (draft) => {
      draft.conditions.trackerCatalog.entries = -1;
    }],
    ["unsafe summary count", (draft) => {
      draft.summary.cookies = Number.MAX_SAFE_INTEGER + 1;
    }]
  ];

  for (const [label, mutateRun] of invalidRuns) {
    const report = mutate(makeScanReportV1(), (draft) => {
      if (draft.reportType === "comparison") throw new Error("expected single fixture");
      mutateRun(draft as AnyRecord);
    });
    assert.deepEqual(readStoredScanReport(report), { ok: false, error: "invalid" }, label);
  }

  const invalidDiff = makeScanReportV1Comparison();
  invalidDiff.diff.totalRequests = { before: -1, after: 0, delta: 1 };
  assert.deepEqual(readStoredScanReport(invalidDiff), { ok: false, error: "invalid" });
});

test("v1 binds the observed URL host and comparison root identity to the recorded run", () => {
  const wrongHost = mutate(makeScanReportV1(), (draft) => {
    if (draft.reportType === "comparison") throw new Error("expected single fixture");
    draft.conditions.finalUrl = "https://other.example/path";
  });
  const hostRead = readStoredScanReport(wrongHost);
  assert.equal(hostRead.ok, false);
  if (!hostRead.ok) {
    assert.equal(hostRead.error, "inconsistent");
    assert.equal(hostRead.violations?.some((entry) => entry.includes("firstPartyDomain")), true);
  }

  for (const field of ["requestedUrl", "scannedAt", "device"] as const) {
    const comparison = makeScanReportV1Comparison();
    if (field === "requestedUrl") comparison.requestedUrl = "https://forged.example/";
    if (field === "scannedAt") comparison.scannedAt = "2026-07-10T00:00:00.000Z";
    if (field === "device") comparison.device = "mobile";
    const read = readStoredScanReport(comparison);
    assert.equal(read.ok, false, field);
    if (!read.ok) {
      assert.equal(read.error, "inconsistent", field);
      assert.equal(read.violations?.some((entry) => entry.includes(`root ${field}`)), true, field);
    }
  }

  const crossSite = makeScanReportV1Comparison();
  crossSite.baseline = structuredClone(crossSite.baseline);
  crossSite.baseline.conditions.requestedUrl = "https://attacker.example/";
  crossSite.baseline.conditions.finalUrl = "https://attacker.example/landing";
  crossSite.baseline.summary.firstPartyDomain = "attacker.example";
  crossSite.diff = compareScanResults(crossSite.baseline, crossSite.variant);
  const crossSiteRead = readStoredScanReport(crossSite);
  assert.equal(crossSiteRead.ok, false);
  if (!crossSiteRead.ok) {
    assert.equal(crossSiteRead.error, "inconsistent");
    assert.equal(crossSiteRead.violations?.some((entry) => entry.includes("requestedUrl does not match both runs")), true);
    assert.equal(crossSiteRead.violations?.some((entry) => entry.includes("same final site")), true);
  }

  const mixedDevice = makeScanReportV1Comparison();
  mixedDevice.baseline = structuredClone(mixedDevice.baseline);
  mixedDevice.baseline.conditions.viewport.isMobile = true;
  const mixedDeviceRead = readStoredScanReport(mixedDevice);
  assert.equal(mixedDeviceRead.ok, false);
  if (!mixedDeviceRead.ok) {
    assert.equal(mixedDeviceRead.violations?.some((entry) => entry.includes("device does not match both runs")), true);
  }

  const legitimateRedirects = makeScanReportV1Comparison();
  legitimateRedirects.baseline = structuredClone(legitimateRedirects.baseline);
  legitimateRedirects.variant = structuredClone(legitimateRedirects.variant);
  legitimateRedirects.baseline.conditions.scannedAt = "2026-07-09T09:59:00.000Z";
  legitimateRedirects.baseline.conditions.finalUrl = "https://www.example.com/landing";
  legitimateRedirects.baseline.summary.firstPartyDomain = "www.example.com";
  legitimateRedirects.variant.conditions.finalUrl = "https://shop.example.com/home";
  legitimateRedirects.variant.summary.firstPartyDomain = "shop.example.com";
  legitimateRedirects.diff = compareScanResults(legitimateRedirects.baseline, legitimateRedirects.variant);
  assert.equal(
    readStoredScanReport(legitimateRedirects).ok,
    true,
    "arm timestamps and same-site redirect targets may legitimately differ"
  );
});

test("v1 accepts set reordering but rejects duplicate set members", () => {
  const run = makeMaximalScanReportV1() as ScanResult;
  run.requests.push({ ...structuredClone(run.requests[0]), id: 2, status: 204, resourceType: "xhr", startedAtMs: 13 });
  run.summary.totalRequests = 2;
  run.summary.thirdPartyRequests = 2;
  run.summary.knownTrackerRequests = 2;
  run.summary.shieldsBlockedRequests = 2;
  run.domains[0] = {
    ...run.domains[0],
    requests: 2,
    statuses: [204, 200],
    resourceTypes: ["xhr", "image"]
  };
  assert.equal(readStoredScanReport(run).ok, true, "status/resource set order is non-semantic");

  const duplicateStatus = structuredClone(run);
  duplicateStatus.domains[0].statuses.push(200);
  assert.equal(readStoredScanReport(duplicateStatus).ok, false, "duplicate status is not a set");

  const duplicateResourceType = structuredClone(run);
  duplicateResourceType.domains[0].resourceTypes.push("image");
  assert.equal(readStoredScanReport(duplicateResourceType).ok, false, "duplicate resource type is not a set");

  const duplicatePixelEvent = makeMaximalScanReportV1() as ScanResult;
  duplicatePixelEvent.pixelEvents![0].events.push(duplicatePixelEvent.pixelEvents![0].events[0]);
  assert.equal(readStoredScanReport(duplicatePixelEvent).ok, false, "duplicate pixel event name is not a set");

  const duplicatePixelField = makeMaximalScanReportV1() as ScanResult;
  duplicatePixelField.pixelEvents![0].advancedMatching.push(
    duplicatePixelField.pixelEvents![0].advancedMatching[0]
  );
  assert.equal(readStoredScanReport(duplicatePixelField).ok, false, "duplicate pixel field is not a set");

  const duplicatePixelPlatform = makeMaximalScanReportV1() as ScanResult;
  duplicatePixelPlatform.pixelEvents!.push(structuredClone(duplicatePixelPlatform.pixelEvents![0]));
  assert.equal(readStoredScanReport(duplicatePixelPlatform).ok, false, "pixel summaries are unique per platform");

  const comparison = makeScanReportV1Comparison();
  comparison.baseline = makeMaximalScanReportV1();
  comparison.variant = structuredClone(comparison.baseline);
  comparison.variant.cookies.push(
    { name: "a", domain: "example.com", path: "/", sameSite: "Lax", secure: true, httpOnly: false, session: true, thirdParty: false },
    { name: "b", domain: "example.com", path: "/", sameSite: "Lax", secure: true, httpOnly: false, session: true, thirdParty: false }
  );
  comparison.variant.summary.cookies += 2;
  comparison.requestedUrl = comparison.variant.conditions.requestedUrl;
  comparison.scannedAt = comparison.variant.conditions.scannedAt;
  comparison.device = comparison.variant.conditions.viewport.isMobile ? "mobile" : "desktop";
  comparison.diff = compareScanResults(comparison.baseline, comparison.variant);
  comparison.diff.addedCookies.reverse();
  assert.equal(readStoredScanReport(comparison).ok, true, "diff member order is non-semantic");

  comparison.diff.addedCookies.push(structuredClone(comparison.diff.addedCookies[0]));
  assert.equal(readStoredScanReport(comparison).ok, false, "duplicate diff members are rejected");

  const pixelComparison = makeScanReportV1Comparison();
  pixelComparison.baseline = makeMaximalScanReportV1();
  pixelComparison.variant = structuredClone(pixelComparison.baseline);
  pixelComparison.variant.pixelEvents[0].events.push("Purchase", "Lead");
  pixelComparison.variant.pixelEvents[0].advancedMatching.push("phone", "name");
  pixelComparison.requestedUrl = pixelComparison.variant.conditions.requestedUrl;
  pixelComparison.scannedAt = pixelComparison.variant.conditions.scannedAt;
  pixelComparison.device = pixelComparison.variant.conditions.viewport.isMobile ? "mobile" : "desktop";
  pixelComparison.diff = compareScanResults(pixelComparison.baseline, pixelComparison.variant);
  pixelComparison.diff.addedPixelEvents[0].events.reverse();
  pixelComparison.diff.addedPixelEvents[0].advancedMatching.reverse();
  assert.equal(readStoredScanReport(pixelComparison).ok, true, "nested pixel sets are order-insensitive");

  pixelComparison.diff.addedPixelEvents[0].events.push(pixelComparison.diff.addedPixelEvents[0].events[0]);
  assert.equal(readStoredScanReport(pixelComparison).ok, false, "nested pixel diff duplicates are rejected");
});

test("v1 rejects impossible Shields measurements while retaining valid block-simulation counts", () => {
  const noEngine = mutate(makeScanReportV1(), (draft) => {
    if (draft.reportType === "comparison") throw new Error("expected single fixture");
    draft.summary.shieldsBlockedRequests = 1;
  });
  assert.equal(readStoredScanReport(noEngine).ok, false);

  const classificationMismatch = makeMaximalScanReportV1() as ScanResult;
  classificationMismatch.summary.shieldsBlockedRequests = 2;
  assert.equal(readStoredScanReport(classificationMismatch).ok, false);

  const simulation = mutate(makeScanReportV1(), (draft) => {
    if (draft.reportType === "comparison") throw new Error("expected single fixture");
    draft.conditions.shieldsMode = "block-simulation";
    draft.conditions.adblock = { active: true, source: "brave", lists: 1, fetchedAt: "2026-07-01T00:00:00.000Z" };
    draft.summary.shieldsBlockedRequests = 7;
  });
  assert.equal(readStoredScanReport(simulation).ok, true);

  const maximumSimulation = structuredClone(simulation);
  if (maximumSimulation.reportType === "comparison") throw new Error("expected single fixture");
  maximumSimulation.summary.shieldsBlockedRequests = COMPARISON_REQUEST_CAP;
  assert.equal(readStoredScanReport(maximumSimulation).ok, true);

  const absurdSimulation = structuredClone(simulation);
  if (absurdSimulation.reportType === "comparison") throw new Error("expected single fixture");
  absurdSimulation.summary.shieldsBlockedRequests = COMPARISON_REQUEST_CAP + 1;
  const absurdRead = readStoredScanReport(absurdSimulation);
  assert.equal(absurdRead.ok, false);
  if (!absurdRead.ok) {
    assert.equal(absurdRead.violations?.some((entry) => entry.includes("routing cap")), true);
  }

  const impossibleRetainedBlock = makeMaximalScanReportV1() as ScanResult;
  impossibleRetainedBlock.conditions.shieldsMode = "block-simulation";
  assert.equal(readStoredScanReport(impossibleRetainedBlock).ok, false);
});

test("non-canonical timestamps and inverted phase spans read as inconsistent", () => {
  const sloppyTimestamp = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.startedAt = "2026-07-09T10:00:00Z"; // parseable but not canonical ISO
  });
  const read1 = readStoredScanReport(sloppyTimestamp);
  assert.equal(read1.ok, false);
  if (!read1.ok) assert.equal(read1.error, "inconsistent");

  const invertedPhase = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.phases[0] = { phaseId: 0, kind: "passive-load", startedAtMs: 5000, endedAtMs: 0 };
  });
  const read2 = readStoredScanReport(invertedPhase);
  assert.equal(read2.ok, false);
  if (!read2.ok) assert.equal(read2.error, "inconsistent");
});

test("a Shields experiment with no Shields condition delta reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    draft.variant.conditions.shields = "classification"; // same as baseline
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("an arm whose axis differs from the experiment reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.verification.baseline.axis = "gpc";
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("a forged interventionVerified reads as inconsistent", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") {
      draft.experiment.verification.variant.observed = null;
      draft.experiment.verification.variant.outcome = "inconclusive";
    }
    // comparability.interventionVerified stays true: the forgery.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("comparability")), true);
  }
});

test("quality that disagrees with qualityFacts reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.status = 403; // facts say failed load
    draft.run.summary.status = 403;
    // quality.run.outcome stays "complete": the forgery.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("toReportView marks v1 as legacy-derived and v2 as v2", () => {
  const v1 = readStoredScanReport(makeScanReportV1());
  assert.equal(v1.ok, true);
  if (v1.ok) {
    const view = toReportView(v1.stored);
    assert.equal(view.origin, "legacy-derived");
    assert.equal(view.domain, "example.com");
    assert.equal(view.runs.length, 1);
  }

  // A v1 comparison is DESCRIPTIVE by construction (RFC 10.1): its design
  // must never read as intervention or temporal, regardless of what any
  // renderer remembers about `limited`. The attempted axis stays as metadata.
  const v1Single = makeScanReportV1() as ScanResult;
  const v1Comparison = readStoredScanReport(gpcPairV1(v1Single));
  assert.equal(v1Comparison.ok, true);
  if (v1Comparison.ok) {
    const view = toReportView(v1Comparison.stored);
    assert.equal(view.limited, true);
    assert.equal(view.comparison?.kind, "descriptive");
    assert.equal(view.comparison?.axis, "gpc");
    // Default-deny claims: a v1 pair may render as a descriptive pairing with
    // the family deltas its recorded facts prove (same catalog, whole-pair
    // rule), but never a verification-dependent family, attribution,
    // temporal, or strong-causal claim.
    assert.equal(view.claims.pairComparison?.allowed, true);
    assert.equal(view.claims.interventionAttribution, false);
    assert.equal(view.claims.temporalChange, false);
    assert.equal(view.claims.strongCausal, false);
    assert.equal(view.claims.familyDeltas?.["raw-counts"].allowed, true);
    assert.equal(view.claims.familyDeltas?.["tracker-classification"].allowed, true);
    // No arm carries an active engine measurement, so there is no Shields delta.
    assert.equal(view.claims.familyDeltas?.["shields-simulation"].allowed, false);
    assert.equal(view.claims.familyDeltas?.["consent-verification"].allowed, false);
    assert.match(view.claims.familyDeltas?.["consent-verification"].reasons.join(" ") ?? "", /never a verified consent state/);
    assert.equal(view.claims.familyDeltas?.["detector-findings"].allowed, false);
    assert.match(view.claims.familyDeltas?.["detector-findings"].reasons.join(" ") ?? "", /detector versions/);
  }

  const v2 = readStoredScanReport(makeTemporalComparisonReportV2());
  assert.equal(v2.ok, true);
  if (v2.ok) {
    const view = toReportView(v2.stored);
    assert.equal(view.origin, "v2");
    assert.equal(view.comparison?.kind, "temporal");
    assert.equal(view.claims.interventionAttribution, false);
    // r1 is limited (RFC 15.7), so even a valid temporal pair may not claim
    // "the site changed"; its family deltas still render descriptively.
    assert.equal(view.claims.temporalChange, false);
    assert.equal(view.claims.familyDeltas?.["raw-counts"].allowed, true);
    // Retention/sort must key on the NEWEST run, not the older baseline.
    assert.equal(view.latestRunAt, view.runs[1].startedAt);
  }
});

test("intervention attribution requires pair validity, never verification alone", () => {
  // A verified intervention on an invalid pair (subject mismatch, failed run)
  // supports no pair-level claim at all (RFC 4.4): the runs render as
  // independent reports, so attribution and strong-causal framing must fall.
  const report = makeGpcInterventionReportV2R2();
  assert.equal(report.comparability.interventionVerified, true, "fixture should verify both arms");
  report.comparability.pairValidity = { eligible: false, reasons: ["subject-mismatch"] };
  const view = viewFromV2(report, 2);
  assert.equal(view.claims.pairComparison?.allowed, false);
  assert.equal(view.claims.interventionAttribution, false);
  assert.equal(view.claims.strongCausal, false);
});

test("a legacy custom comparison stays baseline-led and is never labeled temporal", () => {
  const v1Single = makeScanReportV1() as ScanResult;
  const custom = createComparisonReport({
    comparisonType: "custom",
    title: "Ad-hoc pairing",
    runLabels: { baseline: "File A", variant: "File B" },
    baseline: structuredClone(v1Single),
    variant: structuredClone(v1Single),
    warningPrefix: "Ad-hoc upload pairing."
  });
  const view = viewFromV1Report(custom);
  // "custom" is axis-less but NOT temporal: it keeps its own labels, leads
  // with the baseline run, and never gets before/after framing.
  assert.equal(view.comparison?.axis, null);
  assert.equal(view.comparison?.temporalPair, false);
  assert.deepEqual(view.comparison?.runLabels, { baseline: "File A", variant: "File B" });
  assert.equal(displayRunView(view), view.runs[0]);

  const temporal = createTemporalComparisonReport(structuredClone(v1Single), structuredClone(v1Single));
  const temporalView = viewFromV1Report(temporal);
  assert.equal(temporalView.comparison?.temporalPair, true);
  assert.equal(displayRunView(temporalView), temporalView.runs[1]);
});

test("legacy Shields wire labels are normalized to the simulation-honest pair", () => {
  const v1Single = makeScanReportV1() as ScanResult;
  const shields = createShieldsComparisonReport(structuredClone(v1Single), structuredClone(v1Single));
  // Already-stored reports carry the older producer labels; display renames
  // exactly that pair ("Shields on" reads as a live Brave visit, which the
  // block simulation is not) and passes any custom labels through untouched.
  shields.runLabels = { baseline: "Shields off", variant: "Shields on" };
  assert.deepEqual(viewFromV1Report(shields).comparison?.runLabels, {
    baseline: "No blocking",
    variant: "Brave-list blocking"
  });
  shields.runLabels = { baseline: "Vanilla", variant: "Filtered" };
  assert.deepEqual(viewFromV1Report(shields).comparison?.runLabels, { baseline: "Vanilla", variant: "Filtered" });
});

test("legacy consent wire labels and title are rewritten from the recorded click dispatch", () => {
  const v1Single = makeScanReportV1() as ScanResult;
  const consentArm = (mode: "accept-all" | "reject-all", clicked: boolean): ScanResult => {
    const run = structuredClone(v1Single);
    run.conditions.consentMode = mode;
    run.consentInteraction = { mode, clicked };
    return run;
  };

  // Already-stored share-store copies carry the legacy producer labels and
  // title, which caption a pre-consent recording as a consent choice; display
  // rewrites exactly those strings from what each visit really dispatched.
  const unclicked = createConsentComparisonReport(consentArm("accept-all", false), consentArm("reject-all", false));
  unclicked.title = "Consent accept/reject comparison";
  unclicked.runLabels = { baseline: "Accept all", variant: "Reject all" };
  const unclickedView = viewFromV1Report(unclicked);
  assert.equal(unclickedView.title, "Consent comparison attempt (no control activated)");
  assert.deepEqual(unclickedView.comparison?.runLabels, {
    baseline: "Accept-all attempt",
    variant: "Reject-all attempt"
  });

  const acceptOnly = createConsentComparisonReport(consentArm("accept-all", true), consentArm("reject-all", false));
  acceptOnly.title = "Consent accept/reject comparison";
  acceptOnly.runLabels = { baseline: "Accept all", variant: "Reject all" };
  const acceptOnlyView = viewFromV1Report(acceptOnly);
  assert.equal(acceptOnlyView.title, "Consent comparison attempt (only Accept all activated)");
  assert.deepEqual(acceptOnlyView.comparison?.runLabels, {
    baseline: "Accept-all click",
    variant: "Reject-all attempt"
  });

  // A pair whose clicks both dispatched keeps the comparison title, with the
  // arms labeled as clicks (dispatched, never verified choices).
  const bothClicked = createConsentComparisonReport(consentArm("accept-all", true), consentArm("reject-all", true));
  bothClicked.title = "Consent accept/reject comparison";
  bothClicked.runLabels = { baseline: "Accept all", variant: "Reject all" };
  const bothClickedView = viewFromV1Report(bothClicked);
  assert.equal(bothClickedView.title, "Consent accept/reject comparison");
  assert.deepEqual(bothClickedView.comparison?.runLabels, {
    baseline: "Accept-all click",
    variant: "Reject-all click"
  });

  // Custom labels and titles pass through untouched.
  const custom = createConsentComparisonReport(consentArm("accept-all", false), consentArm("reject-all", false));
  custom.title = "My consent experiment";
  custom.runLabels = { baseline: "Arm 1", variant: "Arm 2" };
  const customView = viewFromV1Report(custom);
  assert.equal(customView.title, "My consent experiment");
  assert.deepEqual(customView.comparison?.runLabels, { baseline: "Arm 1", variant: "Arm 2" });
});

test("legacy family gates follow the recorded facts: catalog and Shields-mode mismatches deny their families", () => {
  const v1Single = makeScanReportV1() as ScanResult;

  const catalogMismatch = gpcPairV1(v1Single);
  catalogMismatch.variant.conditions.trackerCatalog = {
    ...catalogMismatch.variant.conditions.trackerCatalog,
    version: "different-version"
  };
  const catalogView = viewFromV1Report(catalogMismatch);
  assert.equal(catalogView.claims.pairComparison?.allowed, true);
  assert.equal(catalogView.claims.familyDeltas?.["raw-counts"].allowed, true);
  assert.equal(catalogView.claims.familyDeltas?.["tracker-classification"].allowed, false);
  assert.match(catalogView.claims.familyDeltas?.["tracker-classification"].reasons.join(" ") ?? "", /different catalogs/);

  // A Shields-axis pair measures filter matches on one arm and engine blocks
  // on the other: two different quantities that must never share a delta.
  const shieldsPair = createShieldsComparisonReport(structuredClone(v1Single), structuredClone(v1Single));
  const adblock = { active: true, source: "brave", lists: 3, fetchedAt: "2026-01-01T00:00:00Z" };
  shieldsPair.baseline.conditions.shieldsMode = "classification";
  shieldsPair.baseline.conditions.adblock = { ...adblock };
  shieldsPair.baseline.summary.shieldsBlockedRequests = 5;
  shieldsPair.variant.conditions.shieldsMode = "block-simulation";
  shieldsPair.variant.conditions.adblock = { ...adblock };
  shieldsPair.variant.summary.shieldsBlockedRequests = 9;
  const shieldsView = viewFromV1Report(shieldsPair);
  assert.equal(shieldsView.claims.familyDeltas?.["shields-simulation"].allowed, false);
  assert.match(shieldsView.claims.familyDeltas?.["shields-simulation"].reasons.join(" ") ?? "", /different Shields quantities/);
});

test("family censoring reads from recorded v2 quality and the derived v1 cap", () => {
  const v1Capped = makeScanReportV1() as ScanResult;
  v1Capped.summary.totalRequests = 1200;
  const cappedRun = viewFromV1Report(v1Capped).runs[0];
  assert.equal(familyCensoredOnRun(cappedRun, "requests"), true);
  assert.equal(runHitRequestRecordingCap(cappedRun), true);
  assert.equal(requestEvidenceState(cappedRun), "capped");
  // The cap aborts subsequent loads, which also suppresses the scripts that
  // would have set cookies, written storage, or fired detectors: every
  // family is censored on a capped v1 run.
  assert.equal(familyCensoredOnRun(cappedRun, "cookies"), true);
  assert.equal(familyCensoredOnRun(cappedRun, "detector-output"), true);

  const v2 = readStoredScanReport(makePublicSingleReportV2());
  assert.equal(v2.ok, true);
  if (v2.ok) {
    const run = toReportView(v2.stored).runs[0];
    // The fixture's run is complete; a censored family flips the check.
    assert.equal(familyCensoredOnRun(run, "requests"), false);
    const censored = {
      ...run,
      quality: {
        ...run.quality,
        byFamily: { ...run.quality.byFamily, requests: { outcome: "censored" as const, reasons: ["capture-loss:timeout"] } }
      }
    };
    assert.equal(familyCensoredOnRun(censored, "requests"), true);
    assert.equal(runHitRequestRecordingCap(censored), false);
    assert.equal(requestEvidenceState(censored), "incomplete");
  }
});

test("schema provenance and run quality read as honest human labels", () => {
  const v1 = readStoredScanReport(makeScanReportV1());
  assert.equal(v1.ok, true);
  if (v1.ok) {
    const view = toReportView(v1.stored);
    assert.equal(schemaProvenanceLabel(view), "v1 schema · facts legacy-derived · descriptive report");
    // A derived quality guess must say so; it is never recorded fact.
    assert.equal(runQualitySummary(view.runs[0]), "complete; derived from status and warnings");
  }

  const failed = makeScanReportV1() as ScanResult;
  failed.summary.status = 403;
  const failedView = viewFromV1Report(failed);
  assert.match(runQualitySummary(failedView.runs[0]), /^failed \(HTTP 403\); derived from status and warnings$/);

  const capped = makeScanReportV1() as ScanResult;
  capped.summary.totalRequests = 1200;
  const cappedView = viewFromV1Report(capped);
  assert.match(runQualitySummary(cappedView.runs[0]), /^cut short: .*request-recording cap.*derived from status and warnings$/);

  const v2 = readStoredScanReport(makePublicSingleReportV2());
  assert.equal(v2.ok, true);
  if (v2.ok) {
    const view = toReportView(v2.stored);
    assert.equal(schemaProvenanceLabel(view), "v2 schema (r1) · limited, descriptive report");
    assert.match(runQualitySummary(view.runs[0]), /recorded by the scanner$/);
  }

  const r2 = viewFromV2(makeGpcInterventionReportV2R2(), 2);
  assert.equal(schemaProvenanceLabel(r2), "v2 schema (r2)");
});

/**
 * The incomplete-evidence notice. No committed report has a degraded run, so
 * the corpus can never exercise this: it has to be driven from fixtures or it
 * is untested on every surface that renders it.
 */
test("an incomplete visit is announced above the numbers it qualifies, and a clean one is not", () => {
  const clean = readStoredScanReport(makeScanReportV1());
  assert.equal(clean.ok, true);
  if (clean.ok) {
    // The common case must stay silent, or the notice becomes furniture.
    assert.equal(degradedRunNotice(toReportView(clean.stored)), null);
  }

  const failed = makeScanReportV1() as ScanResult;
  failed.summary.status = 403;
  const failedNotice = degradedRunNotice(viewFromV1Report(failed));
  assert.ok(failedNotice, "a visit that did not complete must be announced");
  assert.match(failedNotice!, /^Incomplete evidence: /);
  assert.match(failedNotice!, /did not complete/);
  // The reason a reader needs: silence in an unfinished visit proves less.
  assert.match(failedNotice!, /absence here is especially weak evidence/);

  const capped = makeScanReportV1() as ScanResult;
  capped.summary.totalRequests = 1200;
  const cappedNotice = degradedRunNotice(viewFromV1Report(capped));
  assert.ok(cappedNotice, "a cut-short visit must be announced");
  assert.match(cappedNotice!, /cut short before completion/);
  assert.match(cappedNotice!, /request-recording cap/);
  // It must not claim the visit failed when it merely lost evidence.
  assert.doesNotMatch(cappedNotice!, /did not complete/);
});

test("run views carry the full evidence surface and honest quality for both generations", () => {
  // v1: evidence rows come through in the shapes the tables render, and the
  // quality block is derived (status/cap) and marked legacy-derived.
  const v1 = readStoredScanReport(makeScanReportV1());
  assert.equal(v1.ok, true);
  if (v1.ok) {
    const run = toReportView(v1.stored).runs[0];
    assert.ok(Array.isArray(run.evidence.requests));
    assert.ok(Array.isArray(run.evidence.cookies));
    assert.equal(run.evidence.privacyPolicy, null);
    assert.equal(run.quality.origin, "legacy-derived");
    assert.equal(run.quality.byFamily, null, "v1 never recorded family censoring");
    assert.equal(run.quality.outcome, "complete");
    assert.equal(typeof run.counts.storageEntries, "number");
    assert.equal(typeof run.pageTitle, "string");
  }

  // v1 failed load: derived quality says failed with the named reason.
  const failed = makeScanReportV1() as ScanResult;
  failed.summary = { ...failed.summary, status: 403 };
  const failedRead = readStoredScanReport(failed);
  assert.equal(failedRead.ok, true);
  if (failedRead.ok) {
    const run = toReportView(failedRead.stored).runs[0];
    assert.equal(run.quality.outcome, "failed");
    assert.deepEqual(run.quality.reasons, ["http-error-status"]);
  }

  // v2: quality is the RECORDED block, per-family censoring included, and the
  // evidence maps cookiesFinal/storageFinal onto the shared view names.
  const v2 = readStoredScanReport(makeTemporalComparisonReportV2());
  assert.equal(v2.ok, true);
  if (v2.ok) {
    const run = toReportView(v2.stored).runs[0];
    assert.equal(run.quality.origin, "recorded");
    assert.notEqual(run.quality.byFamily, null);
    assert.ok(Array.isArray(run.evidence.cookies));
    assert.ok(Array.isArray(run.evidence.storage));
    assert.equal(run.screenshot, null, "v2 public runs never carry a screenshot");
    // Conditions normalize across generations: v2 has no prose disclosure and
    // privacy-safe subject URLs (origin + route shape).
    assert.equal(run.conditions.disclosure, null);
    assert.match(run.conditions.finalUrl, /^https:\/\//);
    assert.equal(typeof run.conditions.gpcEnabled, "boolean");
  }

  // v1 conditions carry the prose disclosure and the scrubbed URLs verbatim.
  const v1Again = readStoredScanReport(makeScanReportV1());
  assert.equal(v1Again.ok, true);
  if (v1Again.ok) {
    const run = toReportView(v1Again.stored).runs[0];
    assert.equal(typeof run.conditions.requestedUrl, "string");
    assert.equal(typeof run.conditions.consentMode, "string");
    assert.notEqual(run.conditions.trackerCatalog, null);
  }
});

test("transport: errors, job submissions, and reports are distinguished without payload.ok sniffing", () => {
  assert.deepEqual(readScanTransportPayload({ ok: false, error: "Turnstile verification is required." }), {
    kind: "api-error",
    message: "Turnstile verification is required."
  });

  const job = readScanTransportPayload({ jobId: "job-1", status: "queued", statusPath: "/api/scans/job-1", reportId: "r-1" });
  assert.deepEqual(job, {
    kind: "job-pending",
    status: "queued",
    jobId: "job-1",
    statusPath: "/api/scans/job-1",
    reportId: "r-1",
    progress: null
  });

  const v1 = readScanTransportPayload(makeScanReportV1());
  assert.equal(v1.kind, "report");
  if (v1.kind === "report") assert.equal(v1.loaded.source, "v1");

  const v2 = readScanTransportPayload(makePublicSingleReportV2());
  assert.equal(v2.kind, "report");
  if (v2.kind === "report") assert.equal(v2.loaded.source, "v2-public");
});

test("ephemeral screenshots survive only the immediate result, never the public wire report", () => {
  const result = readScanTransportPayload(makeEphemeralSingleReport());
  assert.equal(result.kind, "report");
  if (result.kind !== "report" || result.loaded.source !== "v2-ephemeral") {
    assert.fail("expected an ephemeral report");
  }
  // The immediate-response wire still carries the screenshot for the UI...
  assert.equal(JSON.stringify(result.loaded.wire).includes("AAAA"), true);
  // ...and so does the VIEW the immediate result renders from (the public
  // projection strips it, so the reader restores it onto the view's run)...
  assert.equal(result.loaded.view.runs[0].screenshot?.includes("AAAA"), true);
  // ...but the persistable/downloadable form never does.
  assert.equal(JSON.stringify(result.loaded.public).includes("AAAA"), false);
  assert.equal(JSON.stringify(result.loaded.public).includes("ephemeral"), false);
  assert.equal(isPublicScanReportV2(result.loaded.public), true);
  assert.equal(isPublicScanReportV2(result.loaded.wire), false);
});

test("view conditions state what v2 recorded: applied shields, route-shape URLs, verified consent state", () => {
  const v1 = readStoredScanReport(makeScanReportV1());
  assert.equal(v1.ok, true);
  if (v1.ok) {
    const run = toReportView(v1.stored).runs[0];
    assert.equal(run.conditions.urlsAreRouteShapes, false);
    if (run.consent) assert.equal(run.consent.choiceState, null);
  }

  const v2 = readStoredScanReport(makePublicSingleReportV2());
  assert.equal(v2.ok, true);
  if (v2.ok && v2.stored.schemaVersion === 2 && v2.stored.report.reportType === "single") {
    const run = toReportView(v2.stored).runs[0];
    // v2 subject URLs are privacy-generalized route shapes, never links.
    assert.equal(run.conditions.urlsAreRouteShapes, true);
    // Applied state comes from the recorded shields condition, not from the
    // toolchain block's presence (a pinned engine is not an active engine).
    assert.equal(run.conditions.adblockActive, v2.stored.report.run.conditions.shields !== "off");
  } else {
    assert.fail("expected a stored v2 single report");
  }
});

// ---------------------------------------------------------------------------
// Integrity foundation (2026-07-09 follow-up review)
// ---------------------------------------------------------------------------

test("sha256 matches known vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a forged fingerprint reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.fingerprints.measurementEnvironment = "f".repeat(64);
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("fingerprints")), true);
  }
});

test("tampered summary counts no longer reconcile with the evidence", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.counts.totalRequests = 12; // evidence records one request
    draft.run.summary.countsByPhase[0].totalRequests = 12;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("reconcile")), true);
  }
});

test("capture loss never authorizes summary counts beyond the retained evidence", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.captureLoss.push({ family: "requests", phaseId: 0, kind: "clipped", count: 1 });
    draft.run.quality = evaluateQuality(draft.run.qualityFacts, { observedRequests: draft.run.evidence.requests.length });
    draft.run.summary.counts.totalRequests = 500;
    draft.run.summary.countsByPhase[0].totalRequests = 500;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("summary.counts.totalRequests")), true);
  }
});

test("budget exhaustion must surface in quality", () => {
  const facts = { ...makeScanRunV2().qualityFacts, budgetsExhausted: ["keystroke-probe"] };
  const derived = evaluateQuality(facts, { observedRequests: 1 });
  assert.equal(derived.run.reasons.includes("budget-exhausted:keystroke-probe"), true);

  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.budgetsExhausted = ["keystroke-probe"];
    // quality left untouched: the silent absorption the review flagged.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("overlapping phase spans read as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.phases = [
      { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 5000 },
      { phaseId: 1, kind: "active-probe", startedAtMs: 4000, endedAtMs: 6000 } // overlaps phase 0
    ];
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("a detector reporting activity for a disabled probe reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.detectors["keystroke-exfiltration"] = { version: "1", status: "complete" };
    // probes.keystroke stays false.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("consent evidence on an observe-mode run reads as inconsistent", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.evidence as AnyRecord).consent = {
      mode: "reject-all",
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [],
      choiceState: "weak-signal",
      reverifiedAfterReload: false
    };
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("temporal eligibility requires equal condition fingerprints", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b", shields: "block-simulation" }); // a different condition vector
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.pairValidity.eligible, false);
  assert.equal(comparability.pairValidity.reasons.includes("dependency-digest-mismatch:conditionFingerprint"), true);
});

test("intervention eligibility requires equal measurement-environment fingerprints", () => {
  const baseline = makeScanRunV2({ runId: "a" });
  const variant = makeScanRunV2({ runId: "b", startedAt: "2026-07-09T10:01:00.000Z", shields: "block-simulation" });
  variant.conditions.locale = "de-DE"; // environment drift beyond the declared axis
  // Re-mint the fingerprints as a correct producer would; the drift must
  // surface through the fingerprint invariant, not a stale-digest violation.
  variant.fingerprints = buildFingerprints({
    conditions: variant.conditions,
    provenance: variant.provenance,
    toolchain: variant.toolchain,
    detectors: variant.detectors
  });
  const comparability = evaluateComparability(
    {
      kind: "intervention",
      axis: "shields",
      pairId: "p",
      order: "AB",
      verification: {
        baseline: { axis: "shields", expected: "shields:classification", observed: "shields:classification", method: "shields-engine-status@1", outcome: "passed", phaseId: 0 },
        variant: { axis: "shields", expected: "shields:block-simulation", observed: "shields:block-simulation", method: "shields-engine-status@1", outcome: "passed", phaseId: 0 }
      },
      evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
    },
    baseline,
    variant
  );
  assert.equal(comparability.pairValidity.eligible, false);
  assert.equal(comparability.pairValidity.reasons.includes("dependency-digest-mismatch:measurementEnvironment"), true);
});

test("a malformed ephemeral payload returns unreadable instead of throwing", () => {
  const result = readScanTransportPayload({
    schemaVersion: 2,
    schemaRevision: 1,
    reportType: "single",
    run: { runId: "not-a-real-run" },
    ephemeral: { screenshot: null }
  });
  assert.deepEqual(result, { kind: "unreadable", error: "invalid" });
});

test("async polling envelopes unwrap without payload.ok sniffing", () => {
  const succeeded = readScanTransportPayload({ status: "succeeded", report: makeScanReportV1() });
  assert.equal(succeeded.kind, "report");
  if (succeeded.kind === "report") assert.equal(succeeded.loaded.source, "v1");

  assert.deepEqual(readScanTransportPayload({ status: "failed", error: "target unreachable" }), {
    kind: "job-ended",
    status: "failed",
    message: "target unreachable"
  });

  const running = readScanTransportPayload({ status: "running", jobId: "job-9", progress: { step: "navigating" } });
  assert.equal(running.kind, "job-pending");
  if (running.kind === "job-pending") assert.deepEqual(running.progress, { step: "navigating" });
});

test("expired and cancelled jobs are meaningful states, not unreadable", () => {
  assert.deepEqual(readScanTransportPayload({ status: "expired", jobId: "job-2" }), {
    kind: "job-ended",
    status: "expired",
    message: "Scan job expired."
  });
  assert.deepEqual(readScanTransportPayload({ status: "cancelled", jobId: "job-3" }), {
    kind: "job-ended",
    status: "cancelled",
    message: "Scan job cancelled."
  });
});

// ---------------------------------------------------------------------------
// Final integrity patch (2026-07-09 pre-emission audit)
// ---------------------------------------------------------------------------

function remintFingerprints(run: ReturnType<typeof makeScanRunV2>): void {
  run.fingerprints = buildFingerprints({
    conditions: run.conditions,
    provenance: run.provenance,
    toolchain: run.toolchain,
    detectors: run.detectors
  });
}

/** A consistent consent-mode run: phased, verified, evaluator-minted blocks. */
function makeConsentRun(mode: "accept-all" | "reject-all") {
  const run = makeScanRunV2();
  run.conditions = { ...run.conditions, consent: mode };
  run.phases = [
    { phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 2000 },
    { phaseId: 1, kind: "consent-interaction", startedAtMs: 2000, endedAtMs: 3000 },
    { phaseId: 2, kind: "post-choice-reload", startedAtMs: 3000, endedAtMs: 5000 }
  ];
  const observed = mode === "accept-all" ? ("accepted-all" as const) : ("rejected-all" as const);
  run.evidence = {
    ...run.evidence,
    consent: {
      mode,
      interactionAttempted: true,
      controlActivated: true,
      verificationObservations: [
        { phaseId: 1, method: "onetrust-cookie@1", observed, consistentWithChoice: true },
        { phaseId: 2, method: "onetrust-cookie@1", observed, consistentWithChoice: true }
      ],
      choiceState: "verified",
      reverifiedAfterReload: true
    }
  };
  remintFingerprints(run);
  return run;
}

test("a consistent consent-mode run passes end to end", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run = makeConsentRun("reject-all");
  });
  const read = readStoredScanReport(report);
  assert.deepEqual(read.ok, true, JSON.stringify(!read.ok ? read.violations : []));
});

test("a Reject-all run whose interpreter read accepted-all cannot claim verification", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const run = makeConsentRun("reject-all");
    // The reproduced forgery: both observations actually read accepted-all,
    // yet claim consistency and a verified choice.
    run.evidence.consent!.verificationObservations = [
      { phaseId: 1, method: "onetrust-cookie@1", observed: "accepted-all", consistentWithChoice: true },
      { phaseId: 2, method: "onetrust-cookie@1", observed: "accepted-all", consistentWithChoice: true }
    ];
    draft.run = run;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("does not derive from its observed state")), true);
  }
});

test("a consent-mode run without consent evidence is rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.conditions = { ...draft.run.conditions, consent: "reject-all" };
    remintFingerprints(draft.run);
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("carries no consent evidence")), true);
  }
});

test("invented verification methods are rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const run = makeConsentRun("accept-all");
    run.evidence.consent!.verificationObservations[0].method = "magic@9";
    draft.run = run;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("unknown interpreter method")), true);
});

test("self-asserted evidence strength is rejected", () => {
  const forgedCounterbalance = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.evidence.counterbalanced = true; // pairs stays 1
  });
  const read1 = readStoredScanReport(forgedCounterbalance);
  assert.equal(read1.ok, false);
  if (!read1.ok) assert.equal(read1.error, "inconsistent");

  const forgedStrength = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.evidence.strength = "replicated-difference";
  });
  const read2 = readStoredScanReport(forgedStrength);
  assert.equal(read2.ok, false);
  if (!read2.ok) assert.equal(read2.error, "inconsistent");
});

test("consent arm failures censor the consent-verification family", () => {
  const baseline = makeConsentRun("accept-all");
  const variant = makeConsentRun("reject-all");
  variant.startedAt = "2026-07-09T10:01:00.000Z";
  const comparability = evaluateComparability(
    {
      kind: "intervention",
      axis: "consent",
      pairId: "p",
      order: "AB",
      verification: {
        baseline: { axis: "consent", expected: "consent:accept-all", observed: "consent:accept-all", method: "onetrust-cookie@1", outcome: "passed", phaseId: 2 },
        variant: { axis: "consent", expected: "consent:reject-all", observed: null, method: "onetrust-cookie@1", outcome: "inconclusive", phaseId: 2 }
      },
      evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" }
    },
    baseline,
    variant
  );
  assert.equal(comparability.perMetric["consent-verification"].eligible, false);
  assert.equal(
    comparability.perMetric["consent-verification"].reasons.includes("arm-verification-inconclusive:variant"),
    true
  );
  assert.equal(comparability.interventionVerified, false);
});

test("an exhausted budget without a captureLoss mapping is rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.budgetsExhausted = ["keystroke-probe"];
    draft.run.quality = evaluateQuality(draft.run.qualityFacts, { observedRequests: 1 }); // quality consistent
    // but no captureLoss entry maps the budget: the silent absorption.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("no captureLoss entry in its")), true);
});

test("JSON property order is non-semantic for derived-block equality", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const { execution, measurementEnvironment, condition } = draft.run.fingerprints;
    (draft.run as AnyRecord).fingerprints = { condition, execution, measurementEnvironment }; // reordered
  });
  assert.equal(readStoredScanReport(report).ok, true);
});

test("summary.status must equal qualityFacts.status", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.status = 204; // facts say 200
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("summary.status")), true);
});

test("countsByPhase cannot omit phases with observed requests", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.countsByPhase = [];
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("omits phase")), true);
});

test("a request timestamp outside its declared phase span is rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.evidence.requests[0].startedAtMs = 999999; // phase 0 ends at 5000
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("outside its declared phase span")), true);
});

test("an empty load cannot claim complete quality", () => {
  const derived = evaluateQuality(
    { status: 200, botWallTitleMatched: false, navigationSettled: true, budgetsExhausted: [], captureLoss: [] },
    { observedRequests: 0 }
  );
  assert.equal(derived.run.outcome, "failed");
  assert.equal(derived.run.reasons.includes("empty-load"), true);

  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.evidence.requests = [];
    draft.run.summary.counts = { ...draft.run.summary.counts, totalRequests: 0 };
    draft.run.summary.countsByPhase = [];
    // quality stays "complete": the forgery.
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.error, "inconsistent");
});

test("unknown environment dimensions never establish compatibility", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  delete baseline.conditions.egress.region;
  delete variant.conditions.egress.region; // unknown on BOTH sides
  remintFingerprints(baseline);
  remintFingerprints(variant);
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.perMetric["raw-counts"].eligible, false);
  assert.equal(comparability.perMetric["raw-counts"].reasons.includes("unknown-dimension:egress.region"), true);
});

// ---------------------------------------------------------------------------
// Verification-model closure (2026-07-09 second pre-emission audit)
// ---------------------------------------------------------------------------

test("banner dismissal alone can never establish verified", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const run = makeConsentRun("reject-all");
    run.evidence.consent!.verificationObservations = [
      { phaseId: 1, method: "banner-visibility@1", observed: null, consistentWithChoice: null },
      { phaseId: 2, method: "banner-visibility@1", observed: null, consistentWithChoice: null }
    ];
    // choiceState stays "verified": the reproduced forgery.
    run.evidence.consent!.reverifiedAfterReload = false;
    draft.run = run;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("does not derive from the observations")), true);

  // A weak method claiming a definite state is itself a violation.
  const definiteWeak = mutate(makePublicSingleReportV2(), (draft) => {
    const run = makeConsentRun("reject-all");
    run.evidence.consent!.verificationObservations[0].method = "banner-visibility@1";
    draft.run = run;
  });
  const read2 = readStoredScanReport(definiteWeak);
  assert.equal(read2.ok, false);
  if (!read2.ok) assert.equal(read2.violations?.some((entry) => entry.includes("weak UI method")), true);
});

test("weak-signal requires actual weak evidence", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    const run = makeConsentRun("reject-all");
    run.evidence.consent!.verificationObservations = [];
    run.evidence.consent!.choiceState = "weak-signal"; // nothing supports it
    run.evidence.consent!.reverifiedAfterReload = false;
    run.evidence.consent!.controlActivated = true;
    draft.run = run;
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("expected unavailable")), true);
});

test("one stored pair cannot claim replicated counterbalanced evidence", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") {
      draft.experiment.evidence = { pairs: 2, counterbalanced: true, strength: "replicated-difference" };
    }
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("exactly the one pair")), true);
  }
});

test("matching unknown engine versions never make Shields metrics eligible", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  baseline.toolchain.adblock!.engineVersion = "unknown";
  variant.toolchain.adblock!.engineVersion = "unknown";
  remintFingerprints(baseline);
  remintFingerprints(variant);
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.perMetric["shields-simulation"].eligible, false);
  assert.equal(comparability.perMetric["shields-simulation"].reasons.includes("unknown-dimension:adblockEngine"), true);
  // Other families stay unaffected by the engine dimension.
  assert.equal(comparability.perMetric["raw-counts"].eligible, true);
});

test("a budget mapped to the wrong family is rejected", () => {
  const report = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.budgetsExhausted = ["request-capture"];
    // Attached to an unrelated detector loss, not the requests family.
    draft.run.qualityFacts.captureLoss = [
      { family: "detector-output", phaseId: 0, kind: "timeout", count: 1, detail: "request-capture" }
    ];
    draft.run.quality = evaluateQuality(draft.run.qualityFacts, { observedRequests: 1 });
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) assert.equal(read.violations?.some((entry) => entry.includes("in its requests family")), true);

  const unknownBudget = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.budgetsExhausted = ["made-up-budget"];
    draft.run.quality = evaluateQuality(draft.run.qualityFacts, { observedRequests: 1 });
  });
  const read2 = readStoredScanReport(unknownBudget);
  assert.equal(read2.ok, false);
  if (!read2.ok) assert.equal(read2.violations?.some((entry) => entry.includes("not in the budget registry")), true);
});

test("failed or asymmetric detector statuses censor detector-findings eligibility", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  variant.detectors["pixel-events"] = { version: "1", status: "failed" };
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.perMetric["detector-findings"].eligible, false);
  assert.equal(
    comparability.perMetric["detector-findings"].reasons.includes("unknown-dimension:detectorStatus.pixel-events"),
    true
  );

  const skippedOnOne = makeScanRunV2({ runId: "c" });
  skippedOnOne.detectors["pixel-events"] = { version: "1", status: "skipped" };
  const asymmetric = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, skippedOnOne);
  assert.equal(asymmetric.perMetric["detector-findings"].eligible, false);
});

test("the export/persistence boundary never serializes an ephemeral shell", () => {
  const ephemeral = readScanTransportPayload(makeEphemeralSingleReport());
  assert.equal(ephemeral.kind, "report");
  if (ephemeral.kind === "report") {
    const wire = publicWireForExportOrPersistence(ephemeral.loaded);
    assert.equal(JSON.stringify(wire).includes("AAAA"), false);
    assert.equal(isPublicScanReportV2(wire), true);
  }

  const v1 = readScanTransportPayload(makeScanReportV1());
  assert.equal(v1.kind, "report");
  if (v1.kind === "report") {
    const wire = publicWireForExportOrPersistence(v1.loaded) as ScanReport;
    assert.equal(readStoredScanReport(wire).ok, true);
    assert.equal(wire.reportType, "single");
    if (wire.reportType === "single") {
      // The canonical public count remains derived from retained evidence.
      assert.equal(wire.summary.totalRequests, 0);
    }
  }
});

test("polling progress is validated to flat primitives", () => {
  const result = readScanTransportPayload({
    status: "running",
    jobId: "job-9",
    progress: { step: "navigating", requests: 12, nested: { leak: "SECRET" }, fn: null }
  });
  assert.equal(result.kind, "job-pending");
  if (result.kind === "job-pending") {
    assert.deepEqual(result.progress, { step: "navigating", requests: 12 });
  }
});

// ---------------------------------------------------------------------------
// r1-only safety patch (2026-07-09 third pre-emission audit)
// ---------------------------------------------------------------------------

test("the persistence helper strips v1 screenshots", () => {
  const withScreenshot = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).screenshot = "data:image/png;base64,SECRET";
  });
  const result = readScanTransportPayload(withScreenshot);
  assert.equal(result.kind, "report");
  if (result.kind === "report") {
    // The immediate-response wire keeps it for the UI...
    assert.equal(JSON.stringify(result.loaded.wire).includes("SECRET"), true);
    // ...but the persistence/export boundary never emits it.
    const persisted = publicWireForExportOrPersistence(result.loaded);
    assert.equal(JSON.stringify(persisted).includes("SECRET"), false);
  }
});

test("cross-producer pairs are never compatible", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  variant.provenance = { ...variant.provenance, observer: "pagegraph-import" };
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.perMetric["raw-counts"].eligible, false);
  assert.equal(comparability.perMetric["raw-counts"].reasons.includes("dependency-version-mismatch:environment"), true);
});

test("a normalization change invalidates every family", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  variant.toolchain = { ...variant.toolchain, normalizationVersion: "2" };
  remintFingerprints(variant);
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.perMetric["raw-counts"].eligible, false);
  assert.equal(comparability.perMetric["tracker-classification"].eligible, false);
});

test("symmetric incomplete detectors are still incomplete", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  baseline.detectors["pixel-events"] = { version: "1", status: "partial" };
  variant.detectors["pixel-events"] = { version: "1", status: "partial" };
  const comparability = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(comparability.perMetric["detector-findings"].eligible, false);
  assert.equal(
    comparability.perMetric["detector-findings"].reasons.includes("dependency-version-mismatch:detectorStatus.pixel-events"),
    true
  );
  // Probe-gated detectors stay legitimately skipped when the probe is off on
  // both runs: the fixture's keystroke/privacy-policy skips remain eligible.
  const clean = evaluateComparability(
    { kind: "temporal", pairId: "p" },
    makeScanRunV2({ runId: "c", startedAt: "2026-06-18T10:00:00.000Z" }),
    makeScanRunV2({ runId: "d" })
  );
  assert.equal(clean.perMetric["detector-findings"].eligible, true);
});

test("detector findings bind the Brave-list identity whenever CNAME fallback is enabled", () => {
  const baseline = makeScanRunV2({ runId: "a", startedAt: "2026-06-18T10:00:00.000Z" });
  const variant = makeScanRunV2({ runId: "b" });
  assert.notEqual(variant.toolchain.adblock, null);
  if (variant.toolchain.adblock !== null) variant.toolchain.adblock.manifestDigest = "c".repeat(64);
  const mismatched = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(mismatched.perMetric["raw-counts"].eligible, true);
  assert.equal(mismatched.perMetric["detector-findings"].eligible, false);
  assert.equal(
    mismatched.perMetric["detector-findings"].reasons.includes("dependency-digest-mismatch:adblockManifest"),
    true
  );

  baseline.toolchain.adblock = null;
  variant.toolchain.adblock = null;
  const disabled = evaluateComparability({ kind: "temporal", pairId: "p" }, baseline, variant);
  assert.equal(disabled.perMetric["detector-findings"].eligible, true);
});

test("declared order must match the runs' chronology", () => {
  const report = mutate(makeInterventionComparisonReportV2(), (draft) => {
    if (draft.experiment.kind === "intervention") draft.experiment.order = "BA"; // baseline actually ran first
  });
  const read = readStoredScanReport(report);
  assert.equal(read.ok, false);
  if (!read.ok) {
    assert.equal(read.error, "inconsistent");
    assert.equal(read.violations?.some((entry) => entry.includes("chronology")), true);
  }
});

// ---------------------------------------------------------------------------
// Deep v1 public projector (first commit of the r2 milestone)
// ---------------------------------------------------------------------------

function makeScanReportV1Comparison(): AnyRecord {
  const emptyDelta = { before: 0, after: 0, delta: 0 };
  const single = makeScanReportV1() as AnyRecord;
  const { reportType: _ignored, ...run } = single;
  return {
    ok: true,
    schemaVersion: 1,
    reportType: "comparison",
    comparisonType: "gpc",
    title: "GPC Comparison",
    requestedUrl: "https://example.com/",
    scannedAt: "2026-07-09T10:00:00.000Z",
    device: "desktop",
    baseline: { ...run },
    variant: { ...run },
    diff: {
      totalRequests: emptyDelta,
      thirdPartyRequests: emptyDelta,
      knownTrackerRequests: emptyDelta,
      thirdPartyDomains: emptyDelta,
      cookies: emptyDelta,
      thirdPartyCookies: emptyDelta,
      storageEntries: emptyDelta,
      fingerprintEvents: emptyDelta,
      addedDomains: [],
      removedDomains: [],
      addedEntities: [],
      removedEntities: [],
      addedCookies: [],
      removedCookies: [],
      addedStorageKeys: [],
      removedStorageKeys: [],
      addedFingerprinting: [],
      removedFingerprinting: [],
      addedProvenance: [],
      removedProvenance: []
    },
    warnings: []
  };
}

test("the v1 projector drops unknown root and nested fields", () => {
  const smuggled = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).secret = "ROOT_SECRET";
    (draft as AnyRecord).conditions.secret = "NESTED_SECRET";
    (draft as AnyRecord).summary.secret = "SUMMARY_SECRET";
    (draft as AnyRecord).screenshot = "data:image/png;base64,SHOT_SECRET";
  });
  const result = readScanTransportPayload(smuggled);
  assert.equal(result.kind, "report"); // the tolerant v1 reader accepts it
  if (result.kind === "report") {
    const persisted = JSON.stringify(publicWireForExportOrPersistence(result.loaded));
    assert.equal(persisted.includes("ROOT_SECRET"), false);
    assert.equal(persisted.includes("NESTED_SECRET"), false);
    assert.equal(persisted.includes("SUMMARY_SECRET"), false);
    assert.equal(persisted.includes("SHOT_SECRET"), false);
  }
});

test("the v1 projector strips single and comparison screenshots", () => {
  const comparison = makeScanReportV1Comparison();
  comparison.screenshot = "data:image/png;base64,TOP_SECRET"; // smuggled top-level field
  comparison.baseline.screenshot = "data:image/png;base64,BASE_SECRET";
  comparison.variant.screenshot = "data:image/png;base64,VAR_SECRET";
  comparison.baseline.conditions.secret = "NESTED_SECRET";

  const result = readScanTransportPayload(comparison);
  assert.equal(result.kind, "report");
  if (result.kind === "report") {
    const persisted = JSON.stringify(publicWireForExportOrPersistence(result.loaded));
    assert.equal(persisted.includes("SECRET"), false);
  }
});

test("legitimate v1 reports project to valid, evidence-derived public reports", () => {
  const single = readScanTransportPayload(makeScanReportV1());
  assert.equal(single.kind, "report");
  if (single.kind === "report") {
    const projected = publicWireForExportOrPersistence(single.loaded) as ScanReport;
    assert.equal(readStoredScanReport(projected).ok, true);
    assert.equal(projected.reportType, "single");
    if (projected.reportType === "single") {
      assert.equal(projected.summary.totalRequests, projected.requests.length);
      assert.equal(projected.screenshot, null);
    }
  }

  const comparison = readScanTransportPayload(makeScanReportV1Comparison());
  assert.equal(comparison.kind, "report");
  if (comparison.kind === "report") {
    const projected = publicWireForExportOrPersistence(comparison.loaded) as ScanReport;
    assert.equal(readStoredScanReport(projected).ok, true);
    assert.equal(projected.reportType, "comparison");
    if (projected.reportType === "comparison") {
      assert.equal(projected.baseline.summary.totalRequests, projected.baseline.requests.length);
      assert.equal(projected.variant.summary.totalRequests, projected.variant.requests.length);
      assert.equal(projected.baseline.screenshot, null);
      assert.equal(projected.variant.screenshot, null);
    }
  }
});

// ---------------------------------------------------------------------------
// Exhaustive v1 guard: reader/projector totality (fifth pre-emission audit)
// ---------------------------------------------------------------------------

test("the four reproduced malformed v1 shapes are rejected before projection", () => {
  const missingViewport = mutate(makeScanReportV1(), (draft) => {
    delete (draft as AnyRecord).conditions.viewport;
  });
  assert.deepEqual(readStoredScanReport(missingViewport), { ok: false, error: "invalid" });

  const nullStatuses = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).domains = [
      { domain: "example.com", requests: 1, thirdParty: false, tracker: null, statuses: null, resourceTypes: [] }
    ];
  });
  assert.deepEqual(readStoredScanReport(nullStatuses), { ok: false, error: "invalid" });

  const partialCookie = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).cookies = [{ name: "a", domain: "example.com" }]; // missing required fields
  });
  assert.deepEqual(readStoredScanReport(partialCookie), { ok: false, error: "invalid" });

  const incompleteDiff = makeScanReportV1Comparison();
  delete incompleteDiff.diff.addedDomains;
  delete incompleteDiff.diff.totalRequests;
  assert.deepEqual(readStoredScanReport(incompleteDiff), { ok: false, error: "invalid" });
});

/** Every optional field of the frozen v1 shape populated. */
function makeMaximalScanReportV1(): AnyRecord {
  const report = makeScanReportV1() as AnyRecord;
  report.conditions.shieldsMode = "classification";
  report.conditions.adblock = { active: true, source: "brave", lists: 31, fetchedAt: "2026-07-01T00:00:00.000Z" };
  report.requests = [
    {
      id: 1,
      url: "https://google-analytics.com/pixel",
      domain: "google-analytics.com",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: true,
      tracker: { domain: "google-analytics.com", entity: "Google", category: "analytics / tag management", confidence: "curated" },
      blockedByShields: true,
      provenance: { initiatorUrl: "https://example.com/", scriptDomain: "example.com" },
      startedAtMs: 12
    }
  ];
  report.domains = [
    {
      domain: "google-analytics.com",
      requests: 1,
      thirdParty: true,
      tracker: { domain: "google-analytics.com", entity: "Google", category: "analytics / tag management", confidence: "curated" },
      blockedByShields: true,
      statuses: [200],
      resourceTypes: ["image"]
    }
  ];
  report.cookies = [
    { name: "_ga", domain: ".example.com", path: "/", sameSite: "Lax", secure: true, httpOnly: false, session: false, thirdParty: false }
  ];
  report.storage = [{ area: "localStorage", key: "theme", valueBytes: 4 }];
  report.fingerprintEvents = [{ api: "canvas.toDataURL", count: 2 }];
  report.fingerprintDetections = [
    {
      kind: "canvas-fingerprinting",
      heuristic: "openwpm-canvas-v1",
      count: 1,
      evidence: { readApis: ["canvas.toDataURL"], maxCanvasWidth: 280, maxCanvasHeight: 60, maxDistinctTextCharacters: 24, maxTextWriteCalls: 3 }
    }
  ];
  report.cnameCloaks = [
    { host: "metrics.example.com", cname: "google-analytics.com", tracker: { domain: "google-analytics.com", entity: "Google", category: "analytics / tag management", confidence: "curated" } }
  ];
  report.pixelEvents = [{ platform: "Meta", product: "Meta Pixel", events: ["PageView"], advancedMatching: ["email"], requests: 1 }];
  report.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [{ kind: "honors-gpc", quote: "We honor GPC signals." }],
    mentionedEntities: ["Google"],
    unmentionedEntities: [],
    policyTextLength: 1200
  };
  report.consentInteraction = { mode: "accept-all", clicked: true, cmp: "OneTrust", selector: "#accept", frameUrl: "https://cmp.example/frame" };
  report.screenshot = "data:image/png;base64,MAXSHOT";
  report.share = { id: "20260709-" + "a".repeat(32), path: "/reports/x", jsonPath: "/api/reports/x" };
  report.summary.totalRequests = 1;
  report.summary.thirdPartyRequests = 1;
  report.summary.knownTrackerRequests = 1;
  report.summary.thirdPartyDomains = 1;
  report.summary.cookies = 1;
  report.summary.thirdPartyCookies = 0;
  report.summary.storageEntries = 1;
  report.summary.fingerprintEvents = 2;
  report.summary.shieldsBlockedRequests = 1;
  return report;
}

test("maximal v1 single and comparison fixtures retain every public evidence family after sanitization", () => {
  const maximal = makeMaximalScanReportV1();
  const single = readScanTransportPayload(maximal);
  assert.equal(single.kind, "report");
  if (single.kind === "report") {
    const projected = publicWireForExportOrPersistence(single.loaded) as AnyRecord;
    assert.equal(readStoredScanReport(projected).ok, true);
    assert.equal(projected.screenshot, null);
    assert.equal(projected.conditions.adblock.engine, maximal.conditions.adblock.engine);
    assert.equal(projected.fingerprintDetections.length, maximal.fingerprintDetections.length);
    assert.equal(projected.cnameCloaks.length, maximal.cnameCloaks.length);
    assert.equal(projected.pixelEvents.length, maximal.pixelEvents.length);
    assert.equal(projected.privacyPolicy.claims.length, maximal.privacyPolicy.claims.length);
    assert.equal(projected.consentInteraction.selector, "[redacted]");
    assert.equal(projected.summary.totalRequests, projected.requests.length);
    assert.equal(projected.share, undefined); // the fixture's foreign pair is not a valid capability

    const reread = readScanTransportPayload(projected);
    assert.equal(reread.kind, "report");
    if (reread.kind === "report") {
      assert.deepEqual(publicWireForExportOrPersistence(reread.loaded), projected);
    }
  }

  const comparison = makeScanReportV1Comparison();
  comparison.runLabels = { baseline: "Shields off", variant: "Shields on" };
  comparison.baseline = makeMaximalScanReportV1();
  delete comparison.baseline.reportType;
  comparison.diff = compareScanResults(comparison.baseline, comparison.variant);
  const comparisonResult = readScanTransportPayload(comparison);
  assert.equal(comparisonResult.kind, "report");
  if (comparisonResult.kind === "report") {
    const projected = publicWireForExportOrPersistence(comparisonResult.loaded) as AnyRecord;
    assert.equal(readStoredScanReport(projected).ok, true);
    assert.equal(projected.baseline.screenshot, null);
    assert.equal(projected.variant.screenshot, null);
    assert.equal(projected.baseline.fingerprintDetections.length, comparison.baseline.fingerprintDetections.length);
    assert.equal(projected.baseline.cnameCloaks.length, comparison.baseline.cnameCloaks.length);
    assert.equal(projected.baseline.pixelEvents.length, comparison.baseline.pixelEvents.length);
    assert.equal(projected.baseline.privacyPolicy.claims.length, comparison.baseline.privacyPolicy.claims.length);
    assert.equal(projected.baseline.summary.totalRequests, projected.baseline.requests.length);

    const reread = readScanTransportPayload(projected);
    assert.equal(reread.kind, "report");
    if (reread.kind === "report") {
      assert.deepEqual(publicWireForExportOrPersistence(reread.loaded), projected);
    }
  }
});

// ---------------------------------------------------------------------------
// Final r1 enum/compat corrections (sixth pre-emission audit)
// ---------------------------------------------------------------------------

test("frozen v1 enums reject arbitrary strings", () => {
  const badConsentMode = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).conditions.consentMode = "yolo-mode";
  });
  assert.deepEqual(readStoredScanReport(badConsentMode), { ok: false, error: "invalid" });

  const badAutomation = mutate(makeScanReportV1(), (draft) => {
    (draft as AnyRecord).conditions.automation = "selenium-grid";
  });
  assert.deepEqual(readStoredScanReport(badAutomation), { ok: false, error: "invalid" });

  const badFingerprintKind = makeScanReportV1Comparison();
  badFingerprintKind.diff.addedFingerprinting = [{ kind: "made-up-kind", heuristic: "h", count: 1 }];
  assert.deepEqual(readStoredScanReport(badFingerprintKind), { ok: false, error: "invalid" });
});

test("an omitted v1 screenshot is accepted and canonicalized to null", () => {
  // The UI's JSON export drops the screenshot key entirely; those legacy
  // files must keep re-opening (frozen validator rule).
  const single = mutate(makeScanReportV1(), (draft) => {
    delete (draft as AnyRecord).screenshot;
  });
  const singleResult = readScanTransportPayload(single);
  assert.equal(singleResult.kind, "report");
  if (singleResult.kind === "report") {
    const projected = publicWireForExportOrPersistence(singleResult.loaded) as AnyRecord;
    assert.equal(projected.screenshot, null);
  }

  const comparison = makeScanReportV1Comparison();
  delete comparison.baseline.screenshot;
  delete comparison.variant.screenshot;
  const comparisonResult = readScanTransportPayload(comparison);
  assert.equal(comparisonResult.kind, "report");
  if (comparisonResult.kind === "report") {
    const projected = publicWireForExportOrPersistence(comparisonResult.loaded) as AnyRecord;
    assert.equal(projected.baseline.screenshot, null);
    assert.equal(projected.variant.screenshot, null);
  }
});

test("run views carry the consent outcome and comparison views carry display labels", () => {
  // v1: the recorded consentInteraction maps to the consent view (clicked ->
  // controlActivated); a run that never attempted one maps to null.
  const clicked = mutate(makeScanReportV1() as ScanResult, (draft) => {
    (draft as AnyRecord).consentInteraction = { mode: "reject-all", clicked: true };
  });
  const v1Read = readStoredScanReport(clicked);
  assert.equal(v1Read.ok, true);
  if (v1Read.ok) {
    // choiceState stays null on v1: a dispatched click was never verified,
    // and the verification surface is null ("never ran"), never an empty
    // recorded ledger. interactionAttempted is null for the same reason the
    // wire cannot answer it: a run whose budget ran out before the banner
    // search began writes this same block.
    assert.deepEqual(toReportView(v1Read.stored).runs[0].consent, {
      mode: "reject-all",
      interactionAttempted: null,
      controlActivated: true,
      cmp: null,
      matchedControlQualification: null,
      choiceState: null,
      verificationObservations: null,
      reverifiedAfterReload: null,
      verificationFailureReason: null,
      bannerTransition: null
    });
  }

  // A catalogued control whose submitted choice is configuration-dependent is
  // disclosed off the recorded selector, so an ALREADY-PUBLISHED report gains
  // the qualification without its stored bytes changing.
  const qualified = mutate(makeScanReportV1() as ScanResult, (draft) => {
    (draft as AnyRecord).consentInteraction = {
      mode: "accept-all",
      clicked: true,
      cmp: "Cookiebot",
      selector: "#CybotCookiebotDialogBodyButtonAccept"
    };
  });
  const qualifiedRead = readStoredScanReport(qualified);
  assert.equal(qualifiedRead.ok, true);
  if (qualifiedRead.ok) {
    assert.equal(
      toReportView(qualifiedRead.stored).runs[0].consent?.matchedControlQualification,
      "the platform's general accept control, which on some deployments submits only the cookie categories already selected"
    );
  }
  const v1Plain = readStoredScanReport(makeScanReportV1());
  assert.equal(v1Plain.ok, true);
  if (v1Plain.ok) {
    assert.equal(toReportView(v1Plain.stored).runs[0].consent, null);
    // Single reports have no arms.
    assert.equal(comparisonArmViews(toReportView(v1Plain.stored)), null);
  }

  // v2: evidence.consent.controlActivated comes through unchanged. Dispatch
  // is not verification; the verification facts stay on the wire and gate
  // claims through the policy, not through this block.
  const v2Consent = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run = makeConsentRun("reject-all");
  });
  const v2Read = readStoredScanReport(v2Consent);
  assert.equal(v2Read.ok, true, JSON.stringify(!v2Read.ok ? v2Read.violations : []));
  if (v2Read.ok) {
    // v2 carries the evaluator-derived choice state alongside the dispatch
    // fact, plus the recorded verification-attempt ledger.
    assert.deepEqual(toReportView(v2Read.stored).runs[0].consent, {
      mode: "reject-all",
      interactionAttempted: true,
      controlActivated: true,
      cmp: null,
      matchedControlQualification: null,
      choiceState: "verified",
      verificationObservations: [
        { phaseId: 1, method: "onetrust-cookie@1", observed: "rejected-all", consistentWithChoice: true },
        { phaseId: 2, method: "onetrust-cookie@1", observed: "rejected-all", consistentWithChoice: true }
      ],
      reverifiedAfterReload: true,
      verificationFailureReason: null,
      bannerTransition: null
    });
  }

  // Comparison labels: the wire's runLabels win on v1, per-design defaults
  // otherwise. Labels are presentation only; `claims` stays the only gate.
  const v1Single = makeScanReportV1() as ScanResult;
  const labeled = createGpcComparisonReport(structuredClone(v1Single), structuredClone(v1Single));
  labeled.runLabels = { baseline: "Custom off", variant: "Custom on" };
  const labeledRead = readStoredScanReport(labeled);
  assert.equal(labeledRead.ok, true);
  if (labeledRead.ok) {
    const view = toReportView(labeledRead.stored);
    assert.deepEqual(view.comparison?.runLabels, { baseline: "Custom off", variant: "Custom on" });
    // Report-level title and warnings come through for the header and the
    // warnings card; a v1 comparison carries both on the wire.
    assert.equal(view.title, "GPC off/on comparison");
    assert.deepEqual(view.warnings, labeled.warnings);
    // The two-arm accessor returns the runs in wire order.
    const arms = comparisonArmViews(view);
    assert.equal(arms?.baseline, view.runs[0]);
    assert.equal(arms?.variant, view.runs[1]);
  }

  const v2Temporal = readStoredScanReport(makeTemporalComparisonReportV2());
  assert.equal(v2Temporal.ok, true);
  if (v2Temporal.ok) {
    const view = toReportView(v2Temporal.stored);
    assert.deepEqual(view.comparison?.runLabels, { baseline: "Before", variant: "After" });
    // v2 records no report title; root warnings derive from the runs with the
    // run label prefixed so each warning stays attributed to its visit.
    assert.equal(view.title, null);
    assert.deepEqual(view.warnings, [
      ...view.runs[0].warnings.map((warning) => `Before: ${warning}`),
      ...view.runs[1].warnings.map((warning) => `After: ${warning}`)
    ]);
  }
});

test("the view's two-arm diff equals the wire diff the producer wrote", () => {
  // One builder serves both: the producer computed the wire's diff from the
  // arms, and comparisonDiffView recomputes it from the arms' run views, so
  // parity holds by construction for any producer-built v1 comparison.
  const v1Single = makeScanReportV1() as ScanResult;
  const report = createGpcComparisonReport(structuredClone(v1Single), structuredClone(v1Single));
  const read = readStoredScanReport(report);
  assert.equal(read.ok, true);
  if (read.ok) {
    const view = toReportView(read.stored);
    assert.deepEqual(comparisonDiffView(view), report.diff);
    // Single reports have no arms and therefore no diff.
    const single = readStoredScanReport(makeScanReportV1());
    assert.equal(single.ok, true);
    if (single.ok) assert.equal(comparisonDiffView(toReportView(single.stored)), null);
  }
});

/**
 * A pair-eligible v1 GPC comparison: the eligibility gate verifies the
 * declared axis actually varied, so the fixture flips the signal the way a
 * real producer run does.
 */
function gpcPairV1(run: ScanResult) {
  const baseline = structuredClone(run);
  const variant = structuredClone(run);
  baseline.conditions = { ...baseline.conditions, gpcEnabled: false };
  variant.conditions = { ...variant.conditions, gpcEnabled: true };
  return createGpcComparisonReport(baseline, variant);
}


test("prototype-named quality reasons and evidence families never reach reader prose", () => {
  // PRIMARY defense: validation closes both vocabularies, so neither shape can
  // arrive on a stored or uploaded report at all.
  for (const reason of ["constructor", "toString", "valueOf", "__proto__"]) {
    const forgedReason = mutate(makePublicSingleReportV2(), (draft) => {
      (draft as AnyRecord).run.quality.run.reasons = [reason];
    });
    assert.equal(
      readStoredScanReport(forgedReason).ok,
      false,
      `"${reason}" must not validate as a quality reason`
    );
  }
  const forgedFamily = mutate(makePublicSingleReportV2(), (draft) => {
    (draft as AnyRecord).run.quality.byFamily.constructor = { outcome: "censored", reasons: [] };
  });
  assert.equal(readStoredScanReport(forgedFamily).ok, false);

  // DEFENSE IN DEPTH, and the reason the lookups are own-property now: a plain
  // object literal resolves inherited Object.prototype members, so a key of
  // "constructor" returned a truthy Function that walked past `if (mapped)`
  // and defeated `?? "recorded"`, rendering Object's source text into
  // reader-facing prose. The pixel catalog had the identical shape and WAS
  // reachable from uploads before it was fixed; these two were not converted
  // with it. A view is forged directly here because validation above means no
  // report can produce one.
  const view = viewFromV2(makePublicSingleReportV2(), 2);
  const forgedRun = {
    ...view.runs[0],
    quality: {
      ...view.runs[0].quality,
      reasons: ["constructor", "toString", "valueOf"],
      byFamily: {
        ...(view.runs[0].quality.byFamily ?? {}),
        constructor: { outcome: "censored", reasons: [] },
        toString: { outcome: "censored", reasons: [] }
      }
    }
  } as unknown as Parameters<typeof runCensorshipNotes>[0];

  const notes = runCensorshipNotes(forgedRun);
  assert.equal(notes.length > 0, true, "the forged run must actually exercise both lookups");
  for (const note of notes) {
    assert.equal(
      /function |\[native code\]|=> |prototype/.test(note),
      false,
      `prototype source text reached reader prose: ${note}`
    );
  }
  // The family label must fall back rather than resolve Object.prototype.toString.
  assert.equal(
    notes.some((note) => note.startsWith("recorded evidence was censored")),
    true,
    "a prototype-named family must render through the fallback label"
  );
});
