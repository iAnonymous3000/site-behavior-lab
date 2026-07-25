import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gpcRunMeasurement,
  respondedTrackerEntityNames,
  shieldsRunMeasurement,
  trackerResponseQualification
} from "./report-insights";
import type { DomainSummary } from "./types";

test("receipt facts distinguish dispatched requests from observed responses", () => {
  const domains: DomainSummary[] = [
    {
      domain: "quiet.example",
      requests: 2,
      thirdParty: true,
      tracker: { domain: "quiet.example", entity: "Quiet", category: "analytics", confidence: "curated" },
      statuses: [],
      resourceTypes: ["script"]
    },
    {
      domain: "answered.example",
      requests: 1,
      thirdParty: true,
      tracker: { domain: "answered.example", entity: "Answered", category: "advertising", confidence: "curated" },
      statuses: [204],
      resourceTypes: ["fetch"]
    }
  ];
  assert.deepEqual([...respondedTrackerEntityNames({ domains })], ["Answered"]);
  assert.equal(
    trackerResponseQualification([{ entity: "Quiet" }, { entity: "Answered" }], new Set(["Answered"])),
    "were sent requests (1 answered; the rest recorded no response)"
  );
  assert.equal(
    trackerResponseQualification([{ entity: "Quiet" }], new Set()),
    "were sent requests that recorded no response, so receipt is unproven"
  );
});

test("GPC display facts keep requested and observed state separate", () => {
  assert.deepEqual(
    gpcRunMeasurement({ conditions: { gpcEnabled: true }, verificationFacts: null }),
    { configured: true, observed: null, outcome: "configured-only" }
  );
  assert.deepEqual(
    gpcRunMeasurement({
      conditions: { gpcEnabled: true },
      verificationFacts: {
        gpc: { header: "confirmed-absent", jsSignal: "confirmed-false" }
      }
    }),
    { configured: true, observed: false, outcome: "contradicted" }
  );
});

test("Shields display facts follow engine readback instead of configured mode", () => {
  const run = {
    counts: { shieldsBlockedRequests: 0 },
    conditions: { adblockActive: true, shieldsMode: "block-simulation" },
    verificationFacts: {
      shields: {
        engineLoaded: true,
        applied: false,
        requestsEvaluated: 12,
        requestsMatched: 3,
        requestsActuallyBlocked: 0
      }
    }
  };
  assert.deepEqual(shieldsRunMeasurement(run), {
    kind: "filter-matches",
    count: 3,
    origin: "recorded"
  });
  assert.equal(
    shieldsRunMeasurement({
      ...run,
      verificationFacts: { shields: { ...run.verificationFacts.shields, engineLoaded: false } }
    }),
    null
  );
  // A v1 wire carries the count with no engine readback behind it, so the
  // measurement must say so rather than let a reader call it verified.
  assert.deepEqual(
    shieldsRunMeasurement({
      counts: { shieldsBlockedRequests: 3 },
      conditions: { adblockActive: true, shieldsMode: "classification" },
      verificationFacts: null
    }),
    { kind: "filter-matches", count: 3, origin: "legacy-derived" }
  );
  assert.deepEqual(
    shieldsRunMeasurement({
      counts: { shieldsBlockedRequests: 7 },
      conditions: { adblockActive: true, shieldsMode: "block-simulation" },
      verificationFacts: null
    }),
    { kind: "engine-blocked", count: 7, origin: "legacy-derived" }
  );
});
