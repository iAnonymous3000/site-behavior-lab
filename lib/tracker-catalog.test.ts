import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  canonicalTrackerCatalogContents,
  canonicalTrackerCatalogProvenanceContents,
  findTrackerMatch,
  trackerCatalogMetadata,
  trackerCatalogRecords,
  validateTrackerCatalogRecords,
  type TrackerCatalogRecord
} from "./tracker-catalog";

test("tracker catalog metadata describes the bundled source without third-party provenance claims", () => {
  assert.equal(trackerCatalogMetadata.source, "Hand-curated service catalog");
  assert.equal(trackerCatalogMetadata.version, "hand-curated-2026.07");
  assert.equal(trackerCatalogMetadata.region, "US-biased");
  assert.equal(trackerCatalogMetadata.license, "AGPL-3.0-or-later");
  assert.match(trackerCatalogMetadata.digest, /^[a-f0-9]{64}$/);
  assert.equal(trackerCatalogMetadata.provenanceVersion, "catalog-review-v2");
  assert.equal(trackerCatalogMetadata.reviewedEntries, trackerCatalogMetadata.entries);
  assert.match(trackerCatalogMetadata.provenanceDigest, /^[a-f0-9]{64}$/);
});

test("every effective catalog domain has mechanically valid review provenance", () => {
  const records = trackerCatalogRecords();
  assert.equal(records.length, trackerCatalogMetadata.entries);
  assert.deepEqual(validateTrackerCatalogRecords(records), []);
  assert.equal(records.every((record) => record.provenance.entityReferences.length > 0), true);
  assert.equal(
    records.every((record) => ["2026-07-21", "2026-07-28"].includes(record.provenance.reviewedAt)),
    true
  );
  assert.equal(
    records.find((record) => record.domain === "google-analytics.com")?.provenance.reviewedAt,
    "2026-07-21"
  );
  assert.equal(
    records.every((record) => record.provenance.relationship === "entity or product identity reference only"),
    true
  );
  assert.equal(records.every((record) => record.provenance.limitations.includes("may not list this suffix")), true);
  assert.equal(records.every((record) => record.provenance.categoryRationale.includes("not asserted to substantiate")), true);
});

test("catalog provenance has its own stable digest", () => {
  const canonical = canonicalTrackerCatalogProvenanceContents();
  assert.equal(createHash("sha256").update(canonical).digest("hex"), trackerCatalogMetadata.provenanceDigest);
});

test("catalog provenance validation rejects uncited and malformed records", () => {
  const base = trackerCatalogRecords()[0];
  const uncited = structuredClone(base) as TrackerCatalogRecord;
  (uncited.provenance.entityReferences as Array<{ kind: "official"; title: string; url: string }>).splice(0);
  assert.deepEqual(validateTrackerCatalogRecords([uncited]), [`${base.domain}: at least one entity reference is required`]);

  const malformed = structuredClone(base) as TrackerCatalogRecord;
  (malformed.provenance.entityReferences as Array<{ kind: "official"; title: string; url: string }>)[0] = {
    kind: "official",
    title: "",
    url: "http://user:password@example.com/source"
  };
  assert.deepEqual(validateTrackerCatalogRecords([malformed]), [
    `${base.domain}: entity reference 1 needs a title`,
    `${base.domain}: entity reference 1 must use HTTPS`,
    `${base.domain}: entity reference 1 must not include credentials`
  ]);
});

test("tracker catalog digest covers the canonical effective catalog", () => {
  const canonical = canonicalTrackerCatalogContents();
  const entries = JSON.parse(canonical) as Array<{ domain: string }>;

  assert.equal(entries.length, trackerCatalogMetadata.entries);
  assert.deepEqual(entries.map((entry) => entry.domain), [...entries.map((entry) => entry.domain)].sort());
  assert.equal(createHash("sha256").update(canonical).digest("hex"), trackerCatalogMetadata.digest);
});

test("findTrackerMatch returns exact curated matches", () => {
  assert.deepEqual(findTrackerMatch("doubleclick.net"), {
    domain: "doubleclick.net",
    entity: "Google",
    category: "advertising",
    confidence: "curated"
  });
});

test("reviewed advertising-service additions map their exact suffixes", () => {
  assert.deepEqual(
    [
      findTrackerMatch("ads.3lift.com"),
      findTrackerMatch("smartadserver.com"),
      findTrackerMatch("cdn.doubleverify.com"),
      findTrackerMatch("stackadapt.com")
    ].map((match) => match && ({ domain: match.domain, entity: match.entity, category: match.category })),
    [
      { domain: "3lift.com", entity: "TripleLift", category: "advertising / supply-side platform" },
      { domain: "smartadserver.com", entity: "Equativ", category: "advertising / supply-side platform" },
      { domain: "doubleverify.com", entity: "DoubleVerify", category: "advertising measurement / verification" },
      { domain: "stackadapt.com", entity: "StackAdapt", category: "advertising / demand-side platform" }
    ]
  );

  const expectedSources = new Map([
    ["3lift.com", "https://triplelift.com/advertising-technology-platform-cookie-notice/"],
    ["smartadserver.com", "https://help.equativ.com/implement-adstxt-specification"],
    ["doubleverify.com", "https://doubleverify.com/company/about"],
    ["stackadapt.com", "https://www.stackadapt.com/platform"]
  ]);
  const records = trackerCatalogRecords();
  for (const [domain, expectedSource] of expectedSources) {
    const record = records.find((candidate) => candidate.domain === domain);
    assert.ok(record, `expected reviewed record for ${domain}`);
    assert.equal(record.provenance.reviewedAt, "2026-07-28");
    assert.equal(record.provenance.entityReferences[0]?.kind, "official");
    assert.equal(record.provenance.entityReferences[0]?.url, expectedSource);
    assert.match(record.provenance.limitations, /may not list this suffix/);
  }
});

test("findTrackerMatch returns suffix matches for subdomains", () => {
  assert.deepEqual(findTrackerMatch("stats.g.doubleclick.net"), {
    domain: "doubleclick.net",
    entity: "Google",
    category: "advertising",
    confidence: "curated"
  });
});

test("findTrackerMatch normalizes case and a trailing dot", () => {
  assert.deepEqual(findTrackerMatch("Analytics.Google.COM."), {
    domain: "analytics.google.com",
    entity: "Google",
    category: "analytics / tag management",
    confidence: "curated"
  });
});

test("findTrackerMatch does not match embedded suffix lookalikes", () => {
  assert.equal(findTrackerMatch("notdoubleclick.net"), null);
  assert.equal(findTrackerMatch("doubleclick.net.example.invalid"), null);
  assert.equal(findTrackerMatch("example.invalid"), null);
});

test("findTrackerMatch ignores malformed hostnames", () => {
  assert.equal(findTrackerMatch("%2a.googleapis.com"), null);
  assert.equal(findTrackerMatch("assets_polaris.edgekey.net"), null);
});
