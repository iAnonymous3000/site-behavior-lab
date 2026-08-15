import assert from "node:assert/strict";
import { test } from "node:test";
import {

  detectionEvidence,
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
import type { DomainSummary, NetworkRequestRecord, SessionRecordingDetectionSummary } from "./types";

function requestRows(
  count: number,
  input: Pick<NetworkRequestRecord, "domain" | "thirdParty" | "tracker">,
  firstId = 1,
  status: number | null = 200
): NetworkRequestRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    url: `https://${input.domain}/request-${firstId + index}`,
    domain: input.domain,
    method: "GET",
    resourceType: "script",
    status,
    thirdParty: input.thirdParty,
    tracker: input.tracker,
    startedAtMs: firstId + index
  }));
}

test("receipt facts distinguish dispatched requests from observed responses", () => {
  const requests = [
    ...requestRows(
      2,
      {
        domain: "quiet.example",
        thirdParty: true,
        tracker: { domain: "quiet.example", entity: "Quiet", category: "analytics", confidence: "curated" }
      },
      1,
      null
    ),
    ...requestRows(
      1,
      {
        domain: "answered.example",
        thirdParty: true,
        tracker: { domain: "answered.example", entity: "Answered", category: "advertising", confidence: "curated" }
      },
      100,
      204
    )
  ];
  assert.deepEqual([...respondedTrackerEntityNames({ requests })], ["Answered"]);
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

  const requests = domains.flatMap((domain, index) =>
    requestRows(domain.requests, domain, index * 100 + 1)
  );
  const breakdown = trackerOwnershipBreakdown({ requests }, "youtube.com");
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
    origin: "recorded",
    // The evaluated denominator travels with the count. Pairing the count with
    // the retained request total instead described a ratio over requests the
    // engine never evaluated.
    evaluated: 12
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
    { kind: "filter-matches", count: 3, origin: "legacy-derived", evaluated: null }
  );
  assert.deepEqual(
    shieldsRunMeasurement({
      counts: { shieldsBlockedRequests: 7 },
      conditions: { adblockActive: true, shieldsMode: "block-simulation" },
      verificationFacts: null
    }),
    { kind: "engine-blocked", count: 7, origin: "legacy-derived", evaluated: null }
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

  const requests = domains.flatMap((domain, index) =>
    requestRows(domain.requests, domain, index * 100 + 1)
  );
  const entities = trackerEntitySummaries({ requests });
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

  assert.equal(trackingServiceRequests({ requests }), 5);

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

test("tracking request totals classify each exact third-party match instead of its entity", () => {
  const requests = [
    ...requestRows(
      4,
      {
        domain: "mixed.example",
        thirdParty: true,
        tracker: {
          domain: "mixed.example",
          entity: "Mixed Co",
          category: "analytics",
          confidence: "curated"
        }
      },
      1
    ),
    ...requestRows(
      9,
      {
        // Same host and entity: a domain/entity-first reduction would cause
        // these CDN rows to inherit the analytics role above.
        domain: "mixed.example",
        thirdParty: true,
        tracker: {
          domain: "mixed.example",
          entity: "Mixed Co",
          category: "cdn / hosting",
          confidence: "curated"
        }
      },
      100
    ),
    ...requestRows(
      7,
      {
        domain: "first-party-analytics.example",
        thirdParty: false,
        tracker: {
          domain: "first-party-analytics.example",
          entity: "First Party Match",
          category: "analytics",
          confidence: "curated"
        }
      },
      200
    )
  ];

  assert.equal(trackingServiceRequests({ requests }), 4);
});

test("tracking request totals count retained direct matches only", () => {
  const cnameOnlyEvidence = {
    requests: requestRows(2, {
      domain: "first-party.example",
      thirdParty: false,
      tracker: null
    }),
    // CNAME evidence is intentionally outside the request-row formula.
    cnameCloaks: [{ hostname: "first-party.example", resolvedHostname: "analytics.example" }]
  };
  assert.equal(trackingServiceRequests(cnameOnlyEvidence), 0);

  const incompleteEvidence = {
    requests: requestRows(3, {
      domain: "analytics.example",
      thirdParty: true,
      tracker: {
        domain: "analytics.example",
        entity: "Analytics Co",
        category: "analytics",
        confidence: "curated"
      }
    }),
    quality: { requests: "incomplete" }
  };
  // Eligibility/censoring is enforced by aggregate consumers. At report scope
  // the retained rows remain a lower bound instead of being silently discarded.
  assert.equal(trackingServiceRequests(incompleteEvidence), 3);
});

test("listener-coverage evidence names addEventListener calls instead of live listeners", () => {
  // The observer increments per addEventListener invocation and never wraps
  // removeEventListener, so re-registering an identical handler (a DOM no-op)
  // still counts, as does a handler removed before the snapshot. Publishing
  // that total as a count of "listeners" overstates what is live on the page.
  const detection: SessionRecordingDetectionSummary = {
    kind: "session-recording",
    heuristic: "interaction-listener-coverage-v1",
    count: 1,
    evidence: {
      eventTypes: ["scroll", "click"],
      listenerTargets: ["document"],
      thirdPartyOrigins: ["analytics.example.net"],
      // Four attach passes over five module-level handlers: 20 calls, 5 live listeners.
      totalListenerCalls: 20
    }
  };

  const rendered = detectionEvidence(detection);
  assert.match(rendered, /20 third-party addEventListener calls/);
  // The count must never be published with a bare "listener(s)" noun, which a
  // reader takes as the number of handlers live at snapshot time.
  assert.doesNotMatch(rendered, /\d+ third-party listeners?\b/);
  assert.match(rendered, /removals are not observed/);

  const single = detectionEvidence({
    ...detection,
    evidence: { ...detection.evidence, totalListenerCalls: 1 }
  });
  assert.match(single, /1 third-party addEventListener call from/);

  const privacyReduced = detectionEvidence({
    ...detection,
    evidence: {
      ...detection.evidence,
      thirdPartyOrigins: ["https://static.{label}.fbcdn.net/{seg}"]
    }
  });
  assert.match(privacyReduced, /https:\/\/static\.\*\.fbcdn\.net\/…/);
  assert.doesNotMatch(privacyReduced, /\{label\}|\{seg\}/);
});
