import assert from "node:assert/strict";
import { test } from "node:test";
import { findTrackerMatch, trackerCatalogMetadata } from "./tracker-catalog";

test("tracker catalog metadata describes the bundled source without third-party provenance claims", () => {
  assert.equal(trackerCatalogMetadata.source, "Hand-curated service catalog");
  assert.equal(trackerCatalogMetadata.version, "hand-curated-2026.06");
  assert.equal(trackerCatalogMetadata.region, "US-biased");
  assert.equal(trackerCatalogMetadata.license, "AGPL-3.0-or-later");
});

test("findTrackerMatch returns exact curated matches", () => {
  assert.deepEqual(findTrackerMatch("doubleclick.net"), {
    domain: "doubleclick.net",
    entity: "Google",
    category: "advertising",
    confidence: "curated"
  });
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
