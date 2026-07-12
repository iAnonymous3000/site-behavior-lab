import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  buildCorpusFacts,
  corpusFactsToCsvTables,
  CROSS_SITE_STORAGE_SQL,
  DUCKDB_BOOTSTRAP_SQL,
  RULE_IMPACT_SQL,
  simulateRuleImpact
} from "./pagegraph-corpus";

// Tests execute from the compiled .unit-test-dist tree; fixtures stay in lib/.
const FIXTURE = readFileSync(
  path.join(process.cwd(), "lib", "__fixtures__", "pagegraph", "schema-provenance.graphml"),
  "utf8"
);

// Deterministic eTLD+1 stub: last two labels (tags.example.net -> example.net).
const registrableDomain = (host: string) => host.split(".").slice(-2).join(".");

function fixtureFacts(pageUrl = "https://news.example/") {
  return buildCorpusFacts(FIXTURE, { pageId: "page-1", pageUrl, registrableDomain });
}

test("extracts the fact tables from the provenance fixture", () => {
  const facts = fixtureFacts();

  assert.equal(facts.page.etld1, "news.example");
  assert.equal(facts.nodes.length, 8);
  assert.equal(facts.edges.length, 9);

  assert.deepEqual(
    facts.requests.map((request) => [request.nodeId, request.resourceType, request.status, request.thirdParty]),
    [
      ["resource-child-script", "script", 200, true],
      ["resource-tracker", "xhr", 204, true]
    ]
  );

  // The derived script_of relation pairs the delivered script with its resource.
  assert.deepEqual(
    facts.provenanceEdges.filter((edge) => edge.relation === "script_of"),
    [{ pageId: "page-1", childNodeId: "script-child", parentNodeId: "resource-child-script", relation: "script_of" }]
  );
  assert.equal(facts.provenanceEdges.filter((edge) => edge.relation === "initiated_by").length, 2);

  // Value-blind storage op with script attribution.
  assert.deepEqual(facts.storageOps, [
    {
      pageId: "page-1",
      opId: "edge-storage-set",
      scriptNodeId: "script-child",
      scriptUrl: "https://tags.example.net/tag.js?cache=123",
      scriptEtld1: "example.net",
      storageType: "localStorage",
      key: "seen-banner",
      valueBytes: 4,
      thirdParty: true
    }
  ]);
  assert.deepEqual(
    facts.jsCalls.map((call) => [call.scriptNodeId, call.api]),
    [["script-child", "HTMLCanvasElement.toDataURL"]]
  );
});

test("blocking the tag CDN removes the downstream beacon, storage write, and canvas call", () => {
  const report = simulateRuleImpact([fixtureFacts()], (request) => request.etld1 === "example.net");
  const page = report.pages[0];

  assert.deepEqual(
    page.directlyBlocked.map((request) => request.url),
    ["https://tags.example.net/tag.js?cache=123"]
  );
  assert.deepEqual(
    page.downstreamRequests.map((request) => request.url),
    ["https://tracker.example/collect?cid=abc&email=a%40b.test"]
  );
  assert.equal(page.removedNodeCount, 3);
  assert.equal(page.removedStorageOps, 1);
  assert.equal(page.removedJsCalls, 1);
  assert.equal(page.breakageRisk, false);
  assert.equal(report.summary.pagesAffected, 1);
  assert.deepEqual(report.summary.topRemovedEtld1s, [
    { etld1: "example.net", pages: 1 },
    { etld1: "tracker.example", pages: 1 }
  ]);
});

test("blocking the leaf tracker beacon removes nothing downstream", () => {
  const report = simulateRuleImpact([fixtureFacts()], (request) => request.etld1 === "tracker.example");
  const page = report.pages[0];

  assert.equal(page.directlyBlocked.length, 1);
  assert.equal(page.downstreamRequests.length, 0);
  assert.equal(page.removedStorageOps, 0);
  assert.equal(page.removedJsCalls, 0);
  assert.equal(page.removedNodeCount, 1);
});

test("removing first-party nodes raises the breakage-risk flag", () => {
  // Same graph, but the page itself lives on the tag CDN's registrable domain.
  const report = simulateRuleImpact([fixtureFacts("https://tags.example.net/article")], (request) => request.etld1 === "example.net");
  const page = report.pages[0];

  assert.equal(page.breakageRisk, true);
  assert.deepEqual(page.firstPartyRemovedUrls, ["https://tags.example.net/tag.js?cache=123"]);
  assert.equal(report.summary.breakageRiskPages, 1);
});

test("CSV tables and SQL stay value-blind and DuckDB-loadable", () => {
  const tables = corpusFactsToCsvTables([fixtureFacts()]);

  assert.deepEqual(
    Object.keys(tables).sort(),
    ["edge.csv", "js_call.csv", "node.csv", "page.csv", "provenance_edge.csv", "request.csv", "storage_op.csv"]
  );
  const [storageHeader, storageRow] = tables["storage_op.csv"].split("\r\n");
  assert.equal(
    storageHeader,
    "page_id,op_id,script_node_id,script_url,script_etld1,storage_type,key,value_bytes,third_party"
  );
  // The stored value ("true") appears only as a byte count, never verbatim as a value column.
  assert.match(storageRow, /seen-banner,4,true$/);

  for (const table of Object.keys(tables)) {
    assert.match(DUCKDB_BOOTSTRAP_SQL, new RegExp(`COPY \\w+ FROM '${table}'`));
  }
  assert.match(DUCKDB_BOOTSTRAP_SQL, /CREATE OR REPLACE VIEW closure_edge/);
  assert.match(RULE_IMPACT_SQL, /WITH RECURSIVE removed/);
  assert.match(CROSS_SITE_STORAGE_SQL, /GROUP BY 1, 2, 3/);
});

test("ingests the current capture schema: start-edge resource types, request-error completions, id-keyed rows", () => {
  const currentFixture = readFileSync(
    path.join(process.cwd(), "lib", "__fixtures__", "pagegraph", "schema-current.graphml"),
    "utf8"
  );
  const facts = buildCorpusFacts(currentFixture, {
    pageId: "page-current",
    pageUrl: "https://news.example/",
    registrableDomain
  });

  const byRequestId = new Map(facts.requests.map((request) => [request.requestId, request]));
  // Blink names on the "request start" edge fold into the Playwright
  // vocabulary; the extensionless fixture URLs prove the value came from the
  // edge attribute rather than URL inference.
  assert.equal(byRequestId.get("req-img")?.resourceType, "image");
  assert.equal(byRequestId.get("req-img")?.status, 200);
  assert.equal(byRequestId.get("req-css")?.resourceType, "stylesheet");
  // "request error" is a completion too: dropping it would lose this status.
  assert.equal(byRequestId.get("req-css")?.status, 0);
  assert.equal(byRequestId.get("req-beacon-1")?.resourceType, "xhr");

  // Two concurrent requests to the same URL stay distinct rows via request id.
  assert.equal(facts.requests.length, 4);
  assert.equal(facts.requests.filter((request) => request.url === "https://tracker.example/collect").length, 2);
});
