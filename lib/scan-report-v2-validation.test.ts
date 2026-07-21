import assert from "node:assert/strict";
import { test } from "node:test";
import {
  makeDescriptiveComparisonReportV2,
  makeEphemeralSingleReport,
  makeInterventionComparisonReportV2,
  makePublicSingleReportV2,
  makeScanReportV1,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import { isPublicComparisonReportV2, isPublicScanReportV2, isPublicSingleReportV2 } from "./scan-report-v2-validation";
import { readStoredScanReport } from "./scan-report-reader";
import { buildComparisonDiffV2, evaluateQuality } from "./scan-report-v2-evaluators";

function mutate<T>(fixture: T, apply: (draft: T) => void): unknown {
  const draft = structuredClone(fixture);
  apply(draft);
  return draft;
}

test("valid v2 fixtures pass: single plus all three experiment kinds", () => {
  assert.equal(isPublicSingleReportV2(makePublicSingleReportV2()), true);
  assert.equal(isPublicComparisonReportV2(makeInterventionComparisonReportV2()), true);
  assert.equal(isPublicComparisonReportV2(makeTemporalComparisonReportV2()), true);
  assert.equal(isPublicComparisonReportV2(makeDescriptiveComparisonReportV2()), true);
});

test("the ephemeral block makes a report unpersistable: public validation rejects it", () => {
  // RFC section 8: the projector drops `ephemeral`; the strict report root is
  // the enforcement that a screenshot-bearing shell can never validate as public.
  assert.equal(isPublicScanReportV2(makeEphemeralSingleReport()), false);
});

test("unknown keys at the report root and run level are rejected", () => {
  assert.equal(
    isPublicSingleReportV2(mutate(makePublicSingleReportV2(), (draft) => {
      (draft as unknown as Record<string, unknown>).extra = 1;
    })),
    false
  );
  assert.equal(
    isPublicSingleReportV2(mutate(makePublicSingleReportV2(), (draft) => {
      (draft.run as unknown as Record<string, unknown>).screenshot = "data:...";
    })),
    false
  );
});

test("temporal experiments carry no intervention fields and must be chronological", () => {
  const withVerification = mutate(makeTemporalComparisonReportV2(), (draft) => {
    (draft.experiment as unknown as Record<string, unknown>).verification = {};
  });
  assert.equal(isPublicComparisonReportV2(withVerification), false);

  const withOrder = mutate(makeTemporalComparisonReportV2(), (draft) => {
    (draft.experiment as unknown as Record<string, unknown>).order = "AB";
  });
  assert.equal(isPublicComparisonReportV2(withOrder), false);

  const reversed = mutate(makeTemporalComparisonReportV2(), (draft) => {
    draft.baseline.startedAt = "2026-07-10T10:00:00.000Z"; // after the variant
  });
  assert.equal(isPublicComparisonReportV2(reversed), false);
});

test("descriptive experiments need sourceOrder and reject manipulation fields", () => {
  const missingSourceOrder = mutate(makeDescriptiveComparisonReportV2(), (draft) => {
    delete (draft.experiment as unknown as Record<string, unknown>).sourceOrder;
  });
  assert.equal(isPublicComparisonReportV2(missingSourceOrder), false);

  const withAxis = mutate(makeDescriptiveComparisonReportV2(), (draft) => {
    (draft.experiment as unknown as Record<string, unknown>).axis = "gpc";
  });
  assert.equal(isPublicComparisonReportV2(withAxis), false);
});

test("intervention experiments require both arms and the evidence block", () => {
  const missingVerification = mutate(makeInterventionComparisonReportV2(), (draft) => {
    delete (draft.experiment as unknown as Record<string, unknown>).verification;
  });
  assert.equal(isPublicComparisonReportV2(missingVerification), false);

  const missingBaselineArm = mutate(makeInterventionComparisonReportV2(), (draft) => {
    delete ((draft.experiment as unknown as Record<string, Record<string, unknown>>).verification).baseline;
  });
  assert.equal(isPublicComparisonReportV2(missingBaselineArm), false);

  const badStrength = mutate(makeInterventionComparisonReportV2(), (draft) => {
    ((draft.experiment as unknown as Record<string, Record<string, unknown>>).evidence).strength = "proven";
  });
  assert.equal(isPublicComparisonReportV2(badStrength), false);
});

test("interventionVerified exists exactly when the experiment is an intervention", () => {
  const missingOnIntervention = mutate(makeInterventionComparisonReportV2(), (draft) => {
    delete (draft.comparability as unknown as Record<string, unknown>).interventionVerified;
  });
  assert.equal(isPublicComparisonReportV2(missingOnIntervention), false);

  const presentOnTemporal = mutate(makeTemporalComparisonReportV2(), (draft) => {
    (draft.comparability as unknown as Record<string, unknown>).interventionVerified = true;
  });
  assert.equal(isPublicComparisonReportV2(presentOnTemporal), false);
});

test("the detector ledger, quality families, and metric families must be complete", () => {
  const missingDetector = mutate(makePublicSingleReportV2(), (draft) => {
    delete (draft.run.detectors as unknown as Record<string, unknown>)["cname-uncloaking"];
  });
  assert.equal(isPublicSingleReportV2(missingDetector), false);

  const missingFamily = mutate(makePublicSingleReportV2(), (draft) => {
    delete (draft.run.quality.byFamily as unknown as Record<string, unknown>)["consent-verification"];
  });
  assert.equal(isPublicSingleReportV2(missingFamily), false);

  const missingMetric = mutate(makeInterventionComparisonReportV2(), (draft) => {
    delete (draft.comparability.perMetric as unknown as Record<string, unknown>)["shields-simulation"];
  });
  assert.equal(isPublicComparisonReportV2(missingMetric), false);
});

test("phase references must point into the run's phase table", () => {
  const requestOutOfRange = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.evidence.requests[0].phaseId = 7;
  });
  assert.equal(isPublicSingleReportV2(requestOutOfRange), false);

  const captureLossOutOfRange = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.captureLoss.push({ family: "requests", phaseId: 9, kind: "cap", count: 1 });
  });
  assert.equal(isPublicSingleReportV2(captureLossOutOfRange), false);

  const emptyPhases = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run as unknown as Record<string, unknown>).phases = [];
  });
  assert.equal(isPublicSingleReportV2(emptyPhases), false);
});

test("zero-count capture loss is reserved for the exact PageGraph unsupported sentinel", () => {
  const zeroLoss = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.captureLoss.push({ family: "requests", phaseId: 0, kind: "clipped", count: 0 });
  });
  assert.equal(isPublicSingleReportV2(zeroLoss), false);

  const forgedSentinel = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.qualityFacts.captureLoss.push({
      family: "requests",
      phaseId: null,
      kind: "dropped",
      count: 0,
      detail: "pagegraph-unsupported"
    });
  });
  assert.equal(isPublicSingleReportV2(forgedSentinel), false, "requests are never an unsupported PageGraph family");

  const wrongRevision = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.provenance.observer = "pagegraph-import";
    draft.run.provenance.acquisition = "upload";
    draft.run.conditions.automation = "brave-pagegraph";
    draft.run.qualityFacts.captureLoss = [
      "cookies",
      "storage",
      "fingerprinting",
      "detector-output",
      "consent-verification"
    ].map((family) => ({
      family,
      phaseId: null,
      kind: "dropped",
      count: 0,
      detail: "pagegraph-unsupported"
    })) as typeof draft.run.qualityFacts.captureLoss;
  });
  assert.equal(isPublicSingleReportV2(wrongRevision), false, "the PageGraph unsupported contract is r2-only");
});

test("set-like v2 diff arrays are order-insensitive and reject duplicates", () => {
  const report = makeInterventionComparisonReportV2();
  report.variant.evidence.requests.push(
    {
      id: 2,
      url: "https://alpha.tracker.example/a.js",
      domain: "alpha.tracker.example",
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      tracker: { domain: "alpha.tracker.example", entity: "Alpha", category: "analytics", confidence: "curated" },
      startedAtMs: 20,
      phaseId: 0
    },
    {
      id: 3,
      url: "https://beta.tracker.example/b.js",
      domain: "beta.tracker.example",
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      tracker: { domain: "beta.tracker.example", entity: "Beta", category: "analytics", confidence: "curated" },
      startedAtMs: 30,
      phaseId: 0
    }
  );
  Object.assign(report.variant.summary.counts, {
    totalRequests: 3,
    thirdPartyRequests: 2,
    knownTrackerRequests: 2,
    thirdPartyDomains: 2
  });
  Object.assign(report.variant.summary.countsByPhase[0], {
    totalRequests: 3,
    thirdPartyRequests: 2,
    knownTrackerRequests: 2
  });
  report.diff = buildComparisonDiffV2(report.baseline, report.variant, report.comparability.perMetric);
  report.diff.families["tracker-classification"].addedTrackerDomains.reverse();

  const reorderedRead = readStoredScanReport(report);
  assert.equal(reorderedRead.ok, true, JSON.stringify(!reorderedRead.ok ? reorderedRead.violations : []));

  report.diff.families["tracker-classification"].addedTrackerDomains.push("alpha.tracker.example");
  assert.equal(isPublicComparisonReportV2(report), false, "duplicate members are structurally rejected");
});

test("set-like evaluator reasons are order-insensitive and reject duplicates", () => {
  const report = makePublicSingleReportV2();
  report.run.qualityFacts.captureLoss = [
    { family: "requests", phaseId: 0, kind: "cap", count: 1 },
    { family: "requests", phaseId: 0, kind: "clipped", count: 1 }
  ];
  report.run.quality = evaluateQuality(report.run.qualityFacts, {
    observedRequests: report.run.evidence.requests.length
  });
  report.run.quality.byFamily.requests.reasons.reverse();
  assert.equal(readStoredScanReport(report).ok, true, "reason order is non-semantic");

  report.run.quality.byFamily.requests.reasons.push("capture-loss:cap");
  assert.equal(isPublicSingleReportV2(report), false, "duplicate reasons are structurally rejected");
});

test("HTTP statuses, request IDs, and timing fields use the producer's bounded integer vocabulary", () => {
  for (const status of [-1, 99, 600, 200.5]) {
    const badRunStatus = mutate(makePublicSingleReportV2(), (draft) => {
      draft.run.qualityFacts.status = status;
      draft.run.summary.status = status;
    });
    assert.equal(isPublicSingleReportV2(badRunStatus), false, `run status ${status}`);

    const badRequestStatus = mutate(makePublicSingleReportV2(), (draft) => {
      draft.run.evidence.requests[0].status = status;
    });
    assert.equal(isPublicSingleReportV2(badRequestStatus), false, `request status ${status}`);
  }

  for (const id of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const badId = mutate(makePublicSingleReportV2(), (draft) => {
      draft.run.evidence.requests[0].id = id;
    });
    assert.equal(isPublicSingleReportV2(badId), false, `request id ${id}`);
  }

  const negativePhase = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.phases[0].startedAtMs = -1;
  });
  assert.equal(isPublicSingleReportV2(negativePhase), false);

  const fractionalPhase = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.phases[0].endedAtMs = 4999.5;
  });
  assert.equal(isPublicSingleReportV2(fractionalPhase), false);

  const fractionalRequestTime = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.evidence.requests[0].startedAtMs = 12.5;
  });
  assert.equal(isPublicSingleReportV2(fractionalRequestTime), false);

  const fractionalDuration = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.durationMs = 5000.5;
  });
  assert.equal(isPublicSingleReportV2(fractionalDuration), false);
});

test("reader rejects duplicate request IDs and a duration shorter than its phase plan", () => {
  const duplicateId = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.evidence.requests.push(structuredClone(draft.run.evidence.requests[0]));
  });
  const duplicateRead = readStoredScanReport(duplicateId);
  assert.equal(duplicateRead.ok, false);
  if (!duplicateRead.ok) {
    assert.equal(duplicateRead.violations?.some((entry) => entry.includes("request id 1 is duplicated")), true);
  }

  const shortDuration = mutate(makePublicSingleReportV2(), (draft) => {
    draft.run.summary.durationMs = draft.run.phases[0].endedAtMs - 1;
  });
  const durationRead = readStoredScanReport(shortDuration);
  assert.equal(durationRead.ok, false);
  if (!durationRead.ok) {
    assert.equal(durationRead.violations?.some((entry) => entry.includes("ends before the final measurement phase")), true);
  }
});

test("enum mutants are rejected", () => {
  const badOutcome = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.quality.run as unknown as Record<string, unknown>).outcome = "censored"; // run-level has no censored
  });
  assert.equal(isPublicSingleReportV2(badOutcome), false);

  const badDetectorStatus = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.detectors["pixel-events"] as unknown as Record<string, unknown>).status = "unknown-v1";
  });
  assert.equal(isPublicSingleReportV2(badDetectorStatus), false);

  const badShields = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.conditions as unknown as Record<string, unknown>).shields = "on";
  });
  assert.equal(isPublicSingleReportV2(badShields), false);

  const badAutomation = mutate(makePublicSingleReportV2(), (draft) => {
    (draft.run.conditions as unknown as Record<string, unknown>).automation = "selenium-grid";
  });
  assert.equal(isPublicSingleReportV2(badAutomation), false);
});

test("reader: v1 routes to the frozen validator, v2 to the r1 validator", () => {
  const v2 = readStoredScanReport(makePublicSingleReportV2());
  assert.equal(v2.ok, true);
  if (v2.ok) assert.equal(v2.stored.schemaVersion, 2);

  const v1 = readStoredScanReport(makeScanReportV1());
  assert.equal(v1.ok, true);
  if (v1.ok) assert.equal(v1.stored.schemaVersion, 1);
});

test("reader: unknown revisions and majors are capability gaps, not silent parses", () => {
  // Revision 2 is a KNOWN revision now (exact dispatch); an r1-shaped payload
  // declaring it validates under the r2 rules (r2 is a structural superset).
  const knownRevision = readStoredScanReport(
    mutate(makePublicSingleReportV2(), (draft) => {
      (draft as unknown as Record<string, unknown>).schemaRevision = 2;
    })
  );
  assert.equal(knownRevision.ok, true);
  if (knownRevision.ok && knownRevision.stored.schemaVersion === 2) {
    assert.equal(knownRevision.stored.schemaRevision, 2);
  }

  const futureRevision = readStoredScanReport(
    mutate(makePublicSingleReportV2(), (draft) => {
      (draft as unknown as Record<string, unknown>).schemaRevision = 3;
    })
  );
  assert.deepEqual(futureRevision, { ok: false, error: "unsupported-revision" });

  const futureMajor = readStoredScanReport(
    mutate(makePublicSingleReportV2(), (draft) => {
      (draft as unknown as Record<string, unknown>).schemaVersion = 3;
    })
  );
  assert.deepEqual(futureMajor, { ok: false, error: "unsupported-version" });

  assert.deepEqual(readStoredScanReport(null), { ok: false, error: "invalid" });
  assert.deepEqual(readStoredScanReport({ schemaVersion: 0 }), { ok: false, error: "invalid" });
});
