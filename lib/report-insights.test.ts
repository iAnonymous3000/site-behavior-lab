import assert from "node:assert/strict";
import { test } from "node:test";
import {
  catalogCoverage,
  gpcRunMeasurement,
  isOperationalEntity,
  isTrackingEntity,
  isTrackingTrackerMatch,
  isUnclassifiedEntity,
  respondedTrackerEntityNames,
  shieldsRunMeasurement,
  trackerEntitySummaries,
  trackerOwnershipBreakdown,
  trackerResponseQualification,
  trackingServiceRequests
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

test("ownership interpretation does not turn cross-domain counts into outside-company recipients", () => {
  const domains: DomainSummary[] = [
    {
      domain: "stats.g.doubleclick.net",
      requests: 2,
      thirdParty: true,
      tracker: { domain: "doubleclick.net", entity: "Google", category: "advertising", confidence: "curated" },
      statuses: [204],
      resourceTypes: ["fetch"]
    },
    {
      domain: "facebook.net",
      requests: 1,
      thirdParty: true,
      tracker: { domain: "facebook.net", entity: "Meta", category: "advertising", confidence: "curated" },
      statuses: [200],
      resourceTypes: ["script"]
    }
  ];

  const breakdown = trackerOwnershipBreakdown({ domains }, "youtube.com");
  assert.equal(breakdown.sameOrganizationName, "Google");
  assert.equal(breakdown.sameOrganizationDomainCount, 1);
  assert.deepEqual(breakdown.sameOrganization.map((entry) => entry.entity), ["Google"]);
  assert.deepEqual(breakdown.otherOrUnreviewed.map((entry) => entry.entity), ["Meta"]);

  // The wire still records both as cross-registrable-domain observations.
  assert.equal(domains.filter((domain) => domain.thirdParty).length, 2);
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

test("catalog coverage counts the third-party domains the catalog could not name", () => {
  const domain = (name: string, thirdParty: boolean, catalogued: boolean): DomainSummary => ({
    domain: name,
    requests: 1,
    thirdParty,
    tracker: catalogued
      ? { domain: name, entity: "Named", category: "analytics", confidence: "curated" }
      : null,
    statuses: [200],
    resourceTypes: ["script"]
  });

  // First-party rows never enter the denominator: the metric is about who else
  // the visit contacted, not about the site's own hosts.
  assert.deepEqual(
    catalogCoverage({
      domains: [
        domain("self.example", false, false),
        domain("known.example", true, true),
        domain("unknown-a.example", true, false),
        domain("unknown-b.example", true, false)
      ]
    }),
    { thirdPartyDomains: 3, identified: 1, unidentified: 2 }
  );

  // Full coverage and no third parties at all are distinct states, and neither
  // may be reported as the other.
  assert.deepEqual(
    catalogCoverage({ domains: [domain("known.example", true, true)] }),
    { thirdPartyDomains: 1, identified: 1, unidentified: 0 }
  );
  assert.deepEqual(catalogCoverage({ domains: [domain("self.example", false, false)] }), {
    thirdPartyDomains: 0,
    identified: 0,
    unidentified: 0
  });

  // A filter-list match names the domain just as a curated entry does.
  assert.deepEqual(
    catalogCoverage({
      domains: [
        {
          domain: "listed.example",
          requests: 1,
          thirdParty: true,
          tracker: {
            domain: "listed.example",
            entity: "listed.example",
            category: "tracking (Brave Shields list)",
            confidence: "shields-list"
          },
          statuses: [200],
          resourceTypes: ["script"]
        }
      ]
    }),
    { thirdPartyDomains: 1, identified: 1, unidentified: 0 }
  );
});

test("tracking totals use positive service-role assignments and preserve unknown identities", () => {
  const domains: DomainSummary[] = [
    {
      domain: "ads.example",
      requests: 5,
      thirdParty: true,
      tracker: {
        domain: "ads.example",
        entity: "AdCo",
        category: "advertising",
        confidence: "curated"
      },
      statuses: [200],
      resourceTypes: ["script"]
    },
    {
      domain: "experiment.example",
      requests: 3,
      thirdParty: true,
      tracker: {
        domain: "experiment.example",
        entity: "Experiment Co",
        category: "experimentation",
        confidence: "curated"
      },
      statuses: [200],
      resourceTypes: ["script"]
    },
    {
      domain: "support.example",
      requests: 2,
      thirdParty: true,
      tracker: {
        domain: "support.example",
        entity: "Support Co",
        category: "customer support",
        confidence: "curated"
      },
      statuses: [200],
      resourceTypes: ["script"]
    }
  ];

  const entities = trackerEntitySummaries({ domains });
  const ad = entities.find((entity) => entity.entity === "AdCo");
  const experiment = entities.find((entity) => entity.entity === "Experiment Co");
  const support = entities.find((entity) => entity.entity === "Support Co");
  assert.ok(ad && experiment && support);

  assert.equal(isTrackingEntity(ad), true);
  assert.equal(isOperationalEntity(ad), false);
  assert.equal(isUnclassifiedEntity(ad), false);

  assert.equal(isTrackingEntity(experiment), false);
  assert.equal(isOperationalEntity(experiment), false);
  assert.equal(isUnclassifiedEntity(experiment), true);

  assert.equal(isTrackingEntity(support), false);
  assert.equal(isOperationalEntity(support), true);
  assert.equal(isUnclassifiedEntity(support), false);

  assert.equal(trackingServiceRequests({ domains }), 5);

  const mixed = {
    entity: "Mixed Co",
    requests: 2,
    domains: 2,
    categories: ["analytics", "experimentation"]
  };
  assert.equal(isTrackingEntity(mixed), true);
  assert.equal(isOperationalEntity(mixed), false);
  assert.equal(isUnclassifiedEntity(mixed), false);

  assert.equal(
    isTrackingTrackerMatch({
      category: "advertising"
    }),
    true
  );
  assert.equal(
    isTrackingTrackerMatch({
      category: "experimentation"
    }),
    false
  );
});
