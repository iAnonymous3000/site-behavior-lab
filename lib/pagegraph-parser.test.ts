import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  extractPageGraphRootUrl,
  pageGraphGraphmlToAdapterInput,
  pageGraphGraphmlToScanResult,
  pageGraphUploadToScanResult,
  parseGraphmlRecords
} from "./pagegraph-parser";

const SAMPLE_GRAPHML = `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="d0" for="all" attr.name="type" attr.type="string"/>
  <key id="d1" for="all" attr.name="url" attr.type="string"/>
  <key id="d2" for="all" attr.name="method" attr.type="string"/>
  <key id="d3" for="all" attr.name="status" attr.type="int"/>
  <key id="d4" for="all" attr.name="resource type" attr.type="string"/>
  <key id="d5" for="all" attr.name="api" attr.type="string"/>
  <key id="d6" for="all" attr.name="key" attr.type="string"/>
  <key id="d7" for="all" attr.name="value" attr.type="string"/>
  <graph id="G" edgedefault="directed">
    <node id="n0">
      <data key="d0">DOM root</data>
      <data key="d1">https://example.com/</data>
    </node>
    <edge id="e0" source="n0" target="n1">
      <data key="d0">request start</data>
      <data key="d1">https://example.com/main.js?cache=123</data>
      <data key="d2">GET</data>
      <data key="d3">200</data>
      <data key="d4">script</data>
    </edge>
    <node id="n1">
      <data key="d0">script</data>
      <data key="d1">https://example.com/main.js?cache=123</data>
    </node>
    <edge id="e1" source="n1" target="n2">
      <data key="d0">request start</data>
      <data key="d1">https://analytics.brave.test/collect?id=abc&amp;email=a%40b.test</data>
      <data key="d2">POST</data>
      <data key="d3">204</data>
      <data key="d4">xhr</data>
    </edge>
    <edge id="e2" source="n1" target="n3">
      <data key="d0">js call</data>
      <data key="d5">canvas.toDataURL</data>
    </edge>
    <node id="n4">
      <data key="d0">local storage set</data>
      <data key="d6">seen-banner</data>
      <data key="d7">true</data>
    </node>
  </graph>
</graphml>`;

const PAGEGRAPH_FIXTURE_DIR = path.join(process.cwd(), "lib", "__fixtures__", "pagegraph");

test("parseGraphmlRecords reads PageGraph nodes and edges", () => {
  const records = parseGraphmlRecords(SAMPLE_GRAPHML);

  assert.equal(records.length, 6);
  assert.equal(records.some((record) => record.kind === "edge" && record.fields.type === "request start"), true);
});

test("pageGraphGraphmlToAdapterInput extracts normalized observations", () => {
  const input = pageGraphGraphmlToAdapterInput(SAMPLE_GRAPHML, {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString()
  });

  assert.equal(input.requests?.length, 2);
  assert.equal(input.requests?.[1].provenance?.scriptDomain, "example.com");
  assert.equal(input.requests?.[1].provenance?.scriptUrl, "https://example.com/main.js?cache=123");
  assert.equal(input.storage?.[0].key, "seen-banner");
  assert.equal(input.storage?.[0].valueBytes, 4);
  assert.deepEqual(input.fingerprintEvents, [{ api: "canvas.toDataURL", count: 1 }]);
});

test("pageGraphGraphmlToScanResult produces a PageGraph-backed ScanResult", () => {
  const result = pageGraphGraphmlToScanResult(SAMPLE_GRAPHML, {
    requestedUrl: "https://example.com/?token=secret",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString(),
    trackerCatalog: {
      source: "Brave test catalog",
      version: "test",
      region: "global",
      entries: 1,
      curatedOverrides: 0,
      license: "internal"
    },
    trackerMatcher: (domain) =>
      domain === "analytics.brave.test"
        ? {
            domain,
            entity: "Brave Test Analytics",
            category: "test analytics",
            confidence: "curated"
          }
        : null
  });

  assert.equal(result.conditions.automation, "brave-pagegraph");
  assert.equal(result.conditions.trackerCatalog.source, "Brave test catalog");
  assert.equal(result.summary.totalRequests, 2);
  assert.equal(result.summary.thirdPartyRequests, 1);
  assert.equal(result.summary.knownTrackerRequests, 1);
  assert.equal(result.requests[1].url, "https://analytics.brave.test/collect?id=&email=");
  assert.equal(result.requests[1].provenance?.scriptUrl, "https://example.com/main.js?cache=");
  assert.equal(result.requests[1].tracker?.entity, "Brave Test Analytics");
});

test("pageGraphUploadToScanResult infers the page URL from a root node without overrides", () => {
  const result = pageGraphUploadToScanResult(SAMPLE_GRAPHML);

  assert.equal(extractPageGraphRootUrl(SAMPLE_GRAPHML), "https://example.com/");
  assert.equal(result.conditions.requestedUrl, "https://example.com/");
  assert.equal(result.summary.totalRequests, 2);
  assert.equal(
    result.warnings.some((warning) => warning.includes("inferred from the first observed URL")),
    false
  );
});

test("pageGraphUploadToScanResult warns when the page URL is only inferred from traffic", () => {
  const graphml = readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "schema-provenance.graphml"), "utf8");
  const result = pageGraphUploadToScanResult(graphml);

  assert.equal(typeof result.conditions.requestedUrl, "string");
  assert.equal(
    result.warnings.some((warning) => warning.includes("inferred from the first observed URL")),
    true
  );
});

test("pageGraphUploadToScanResult honors an explicit page URL override", () => {
  const result = pageGraphUploadToScanResult(SAMPLE_GRAPHML, { requestedUrl: "https://override.example/" });

  assert.equal(result.conditions.requestedUrl, "https://override.example/");
  assert.equal(
    result.warnings.some((warning) => warning.includes("inferred from the first observed URL")),
    false
  );
});

test("pageGraphGraphmlToAdapterInput follows real PageGraph resource/request/provenance schema", () => {
  const graphml = readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "schema-provenance.graphml"), "utf8");
  const expected = JSON.parse(readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "schema-provenance.expected.json"), "utf8")) as {
    requests: unknown[];
    storage: unknown[];
    fingerprintEvents: unknown[];
  };

  const input = pageGraphGraphmlToAdapterInput(graphml, {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString()
  });

  assert.deepEqual(input.requests, expected.requests);
  assert.deepEqual(input.storage, expected.storage);
  assert.deepEqual(input.fingerprintEvents, expected.fingerprintEvents);
});

test("pageGraphGraphmlToScanResult preserves real-schema provenance through the adapter", () => {
  const graphml = readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "schema-provenance.graphml"), "utf8");
  const result = pageGraphGraphmlToScanResult(graphml, {
    requestedUrl: "https://example.com/?token=secret",
    finalUrl: "https://example.com/",
    scannedAt: new Date(0).toISOString(),
    trackerMatcher: (domain) =>
      domain === "tracker.example"
        ? {
            domain,
            entity: "Tracker Fixture",
            category: "test tracker",
            confidence: "curated"
          }
        : null
  });

  assert.equal(result.summary.totalRequests, 2);
  assert.equal(result.summary.knownTrackerRequests, 1);
  assert.equal(result.requests[1].method, "UNKNOWN");
  assert.equal(result.requests[1].url, "https://tracker.example/collect?cid=&email=");
  assert.equal(result.requests[1].provenance?.scriptDomain, "tags.example.net");
  assert.equal(result.requests[1].provenance?.injectedByDomain, "loader.example");
  assert.equal(result.warnings.some((warning) => warning.includes("not script-to-request causality")), false);
});
