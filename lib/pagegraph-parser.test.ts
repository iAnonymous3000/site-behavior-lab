import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  PAGEGRAPH_R2_CHARACTER_REFERENCE_REFUSAL,
  PAGEGRAPH_R2_DATA_NOT_PLAIN_TEXT_REFUSAL,
  PAGEGRAPH_R2_ENTITY_REFUSAL,
  PAGEGRAPH_R2_REQUEST_COUNT_REFUSAL,
  extractPageGraphRootUrl,
  normalizePageGraphResourceType,
  pageGraphGraphmlToAdapterInput,
  pageGraphGraphmlToScanResult,
  pageGraphGraphmlToStrictAdapterInput,
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
      <data key="d1">https://google-analytics.com/collect?id=abc&amp;email=a%40b.test</data>
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
    trackerMatcher: undefined
  });

  assert.equal(result.conditions.automation, "brave-pagegraph");
  assert.equal(result.conditions.trackerCatalog.source, "Hand-curated service catalog");
  assert.equal(result.summary.totalRequests, 2);
  assert.equal(result.summary.thirdPartyRequests, 1);
  assert.equal(result.summary.knownTrackerRequests, 1);
  assert.equal(result.requests[1].url, "https://google-analytics.com/{seg}?id=&%5Bredacted%5D=");
  assert.equal(result.requests[1].provenance?.scriptUrl, "https://example.com/{seg}");
  assert.equal(result.requests[1].tracker?.entity, "Google");
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
  const result = pageGraphUploadToScanResult(SAMPLE_GRAPHML, { requestedUrl: "https://override.example.com/" });

  assert.equal(result.conditions.requestedUrl, "https://{label}.example.com/");
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
    trackerMatcher: undefined
  });

  assert.equal(result.summary.totalRequests, 2);
  assert.equal(result.summary.knownTrackerRequests, 1);
  assert.equal(result.requests[1].method, "OTHER");
  assert.equal(result.requests[1].url, "https://google-analytics.com/{seg}?cid=&%5Bredacted%5D=");
  assert.equal(result.requests[1].provenance?.scriptDomain, "{label}.example.net");
  assert.equal(result.requests[1].provenance?.injectedByDomain, "{label}.example.net");
  assert.equal(result.warnings.some((warning) => warning.includes("not script-to-request causality")), false);
});

test("pageGraphGraphmlToAdapterInput reads the current capture schema (type on the start edge, request-error completions, id-keyed identity)", () => {
  const graphml = readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "schema-current.graphml"), "utf8");
  const input = pageGraphGraphmlToAdapterInput(graphml, {
    requestedUrl: "https://news.example/",
    finalUrl: "https://news.example/",
    scannedAt: new Date(0).toISOString()
  });

  // Blink's human-readable names on the "request start" edge fold into the
  // Playwright vocabulary; the fixture URLs are extensionless so a value of
  // "image"/"stylesheet" proves the type came from the edge, not URL guessing.
  const requests = input.requests ?? [];
  const byId = new Map(requests.map((request) => [request.requestId, request]));
  assert.equal(byId.get("req-img")?.resourceType, "image");
  assert.equal(byId.get("req-css")?.resourceType, "stylesheet");
  assert.equal(byId.get("req-beacon-1")?.resourceType, "xhr");
  // The fixture hand-writes numeric values into the request-edge "status"
  // attribute, which the real producer never does (see the real-capture guard
  // below). Whatever that attribute holds, it is a lifecycle token slot, not
  // an HTTP response code, so no request may carry an invented status.
  assert.equal(
    requests.every((request) => request.status === undefined),
    true,
    "PageGraph request edges carry no HTTP status"
  );

  // Two distinct requests sharing URL, method, and timestamp are kept apart by
  // the graph's own request id.
  assert.equal(requests.length, 4);
  assert.equal(requests.filter((request) => request.url === "https://tracker.example/collect").length, 2);

  const report = pageGraphGraphmlToScanResult(graphml, {
    requestedUrl: "https://news.example/",
    finalUrl: "https://news.example/",
    scannedAt: new Date(0).toISOString()
  });
  assert.equal(report.requests[1].status, null, "PageGraph supplies no HTTP status for a failed request");
});

test("PageGraph request-edge status is a lifecycle token, so no HTTP status is invented from a real capture", () => {
  const graphml = readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "real-wikipedia-2026-07-19.graphml"), "utf8");
  const options = {
    requestedUrl: "https://www.wikipedia.org/",
    finalUrl: "https://www.wikipedia.org/",
    scannedAt: new Date(0).toISOString()
  };

  // The committed 0.7.7 capture declares status as a string and only ever
  // writes the lifecycle vocabulary into it. If this stops holding, the
  // parser's premise (and this guard) has to be re-derived from the producer.
  const statusValues = new Set(
    parseGraphmlRecords(graphml)
      .filter((record) => record.kind === "edge")
      .map((record) => record.fields.status)
      .filter((value): value is string => value !== undefined)
  );
  assert.deepEqual([...statusValues].sort(), ["complete", "started"]);

  const requests = pageGraphGraphmlToStrictAdapterInput(graphml, options).requests ?? [];
  assert.equal(requests.length, 5);
  assert.equal(
    requests.every((request) => request.status === undefined),
    true
  );

  // A numeric token in that slot is still a lifecycle-attribute value, not an
  // HTTP response code, and must never reach the report as one. Without this
  // the strict importer publishes "204" as a request's HTTP status.
  const numericStatusGraphml = graphml.replaceAll(">complete<", ">204<");
  const numericStatusRequests = pageGraphGraphmlToStrictAdapterInput(numericStatusGraphml, options).requests ?? [];
  assert.equal(numericStatusRequests.length, 5);
  assert.equal(
    numericStatusRequests.every((request) => request.status === undefined),
    true,
    "a numeric lifecycle token must not be published as an HTTP status"
  );
});

test("normalizePageGraphResourceType folds Blink names into the Playwright vocabulary", () => {
  assert.equal(normalizePageGraphResourceType("Image"), "image");
  assert.equal(normalizePageGraphResourceType("SVG document"), "image");
  assert.equal(normalizePageGraphResourceType("CSS stylesheet"), "stylesheet");
  assert.equal(normalizePageGraphResourceType("XSL stylesheet"), "stylesheet");
  assert.equal(normalizePageGraphResourceType("Script"), "script");
  assert.equal(normalizePageGraphResourceType("Raw"), "xhr");
  assert.equal(normalizePageGraphResourceType("Text track"), "texttrack");
  assert.equal(normalizePageGraphResourceType("Font"), "font");
  assert.equal(normalizePageGraphResourceType("Audio"), "media");
  assert.equal(normalizePageGraphResourceType("Video"), "media");
  assert.equal(normalizePageGraphResourceType("Manifest"), "manifest");
  assert.equal(normalizePageGraphResourceType("Link prefetch"), "other");
  // Playwright-native values pass through unchanged.
  assert.equal(normalizePageGraphResourceType("fetch"), "fetch");
  assert.equal(normalizePageGraphResourceType("xhr"), "xhr");
  assert.equal(normalizePageGraphResourceType(""), "other");
});

const WIKIPEDIA_OPTIONS = {
  requestedUrl: "https://www.wikipedia.org/",
  finalUrl: "https://www.wikipedia.org/",
  scannedAt: new Date(0).toISOString()
};

/**
 * The real capture with one more `insert node` edge from script n12981 to
 * image n232. The parser created and inserted n232 at 197 ms and its request
 * (id 2) started at 207 ms, so only an edge at or before 207 can have loaded it.
 */
function wikipediaWithScriptInsert(timestamp: string): string {
  const graphml = readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "real-wikipedia-2026-07-19.graphml"), "utf8");
  const edge =
    `<edge id="e900001" source="n12981" target="n232"><data key="d9">insert node</data>` +
    `<data key="d24">900001</data><data key="d26">${timestamp}</data><data key="d11">9</data></edge>\n`;
  assert.equal(graphml.split("</graph>").length, 2, "the fixture has one graph to append to");
  return graphml.replace("</graph>", `${edge}</graph>`);
}

function imageRequestProvenance(graphml: string) {
  const requests = pageGraphGraphmlToStrictAdapterInput(graphml, WIKIPEDIA_OPTIONS).requests ?? [];
  const request = requests.find((candidate) => candidate.requestId === "2");
  assert.ok(request, "the image request is in the capture");
  return request.provenance;
}

test("a script is credited with an element's request only through a DOM edge at or before the request", () => {
  const original = readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "real-wikipedia-2026-07-19.graphml"), "utf8");
  const before = imageRequestProvenance(original);
  assert.equal(before?.scriptId, undefined, "the parser loaded this image; no script made it");

  const later = imageRequestProvenance(wikipediaWithScriptInsert("450"));
  assert.equal(later?.scriptId, undefined, "an insertion 243 ms after the request did not make it");
  assert.equal(later?.injectedById, undefined);
  assert.deepEqual(later, before, "a later insertion changes nothing about the request");

  const earlier = imageRequestProvenance(wikipediaWithScriptInsert("150"));
  assert.equal(earlier?.scriptId, "15", "an insertion before the request credits its script");

  const sameMillisecond = imageRequestProvenance(wikipediaWithScriptInsert("207"));
  assert.equal(sameMillisecond?.scriptId, "15", "the capture cannot order within a millisecond, so equal counts as before");
});

test("a DOM edge whose time cannot be read credits no script", () => {
  for (const timestamp of ["", "1e2", "0x10", "-5", "later"]) {
    const provenance = imageRequestProvenance(wikipediaWithScriptInsert(timestamp));
    assert.equal(provenance?.scriptId, undefined, `timestamp ${JSON.stringify(timestamp)} must not order the edge`);
  }
});

test("without a request timestamp no DOM edge can be ordered, so no script is credited", () => {
  // The strict importer refuses a request with no timestamp; the legacy
  // viewer reads one, so the order rule must hold there too.
  const graphml = wikipediaWithScriptInsert("150").replace(
    '<data key="d26">207</data><data key="d30">2</data>',
    '<data key="d30">2</data>'
  );
  assert.notEqual(graphml, wikipediaWithScriptInsert("150"), "the request timestamp was removed");
  const request = (pageGraphGraphmlToAdapterInput(graphml, WIKIPEDIA_OPTIONS).requests ?? []).find(
    (candidate) => candidate.requestId === "2"
  );
  assert.ok(request);
  assert.equal(request.provenance?.scriptId, undefined);
});

const WIKIPEDIA_GRAPHML = () =>
  readFileSync(path.join(PAGEGRAPH_FIXTURE_DIR, "real-wikipedia-2026-07-19.graphml"), "utf8");

/** Rewrite the first request-start edge's type label as `label`. */
function withFirstRequestStartLabel(label: string): string {
  const graphml = WIKIPEDIA_GRAPHML();
  const original = '<data key="d9">request start</data>';
  assert.ok(graphml.includes(original));
  return graphml.replace(original, `<data key="d9">${label}</data>`);
}

const strictRequests = (graphml: string) =>
  pageGraphGraphmlToStrictAdapterInput(graphml, WIKIPEDIA_OPTIONS).requests ?? [];

test("an XML character reference reads as the character it names, so no request is lost", () => {
  assert.equal(strictRequests(WIKIPEDIA_GRAPHML()).length, 5);
  assert.equal(strictRequests(withFirstRequestStartLabel("request&#32;start")).length, 5, "decimal reference");
  assert.equal(strictRequests(withFirstRequestStartLabel("&#x72;equest start")).length, 5, "hexadecimal reference");
  assert.equal(
    (pageGraphGraphmlToAdapterInput(withFirstRequestStartLabel("request&#32;start"), WIKIPEDIA_OPTIONS).requests ?? []).length,
    5,
    "the legacy reader decodes it too"
  );
});

test("references decode in one pass, so an escaped reference stays literal text", () => {
  // "&amp;#32;" is the text "&#32;", not a space: decoding twice would turn
  // this label into "request start" and invent a request.
  assert.equal(strictRequests(withFirstRequestStartLabel("request&amp;#32;start")).length, 4);
});

test("strict import refuses an entity it cannot read", () => {
  for (const label of ["request&nbsp;start", "request & start", "request&#X20;start"]) {
    assert.throws(
      () => strictRequests(withFirstRequestStartLabel(label)),
      { message: PAGEGRAPH_R2_ENTITY_REFUSAL },
      label
    );
    assert.doesNotThrow(() => pageGraphGraphmlToAdapterInput(withFirstRequestStartLabel(label), WIKIPEDIA_OPTIONS), label);
  }
});

test("strict import refuses a character reference outside the XML character range", () => {
  for (const label of ["request&#0;start", "request&#xD800;start", "request&#x110000;start", "request&#99999999999999999999;start"]) {
    assert.throws(
      () => strictRequests(withFirstRequestStartLabel(label)),
      { message: PAGEGRAPH_R2_CHARACTER_REFERENCE_REFUSAL },
      label
    );
    assert.doesNotThrow(() => pageGraphGraphmlToAdapterInput(withFirstRequestStartLabel(label), WIKIPEDIA_OPTIONS), label);
  }
});

test("strict import refuses a data value that is not plain text", () => {
  for (const label of ["<![CDATA[request start]]>", "<?pi request start?>", "<b>request start</b>"]) {
    assert.throws(
      () => strictRequests(withFirstRequestStartLabel(label)),
      { message: PAGEGRAPH_R2_DATA_NOT_PLAIN_TEXT_REFUSAL },
      label
    );
  }
});

test("a self-closing element is empty and never reads the next record's fields", () => {
  const graphml = WIKIPEDIA_GRAPHML();
  const firstRequest = graphml.indexOf('<edge id="e4097"');
  assert.ok(firstRequest > 0);
  // An empty edge between the same two nodes as nothing, written self-closed,
  // placed right before a request-start edge.
  const emptyEdge = graphml.slice(0, firstRequest) + '<edge id="e900002" source="n48" target="n232"/>\n' + graphml.slice(firstRequest);
  const requests = strictRequests(emptyEdge);
  assert.equal(requests.length, 5);
  const image = requests.find((request) => request.requestId === "2");
  assert.equal(image?.provenance?.initiatorId, "n232", "the request keeps its own source");

  // An empty data value, self-closed, placed before the edge-type field.
  const emptyData = graphml.replace(
    '<edge id="e4097" source="n232" target="n4096"><data key="d9">request start</data>',
    '<edge id="e4097" source="n232" target="n4096"><data key="d45"/><data key="d9">request start</data>'
  );
  assert.notEqual(emptyData, graphml);
  assert.equal(strictRequests(emptyData).length, 5, "the type after an empty value is still read");
});

test("a comment can neither hide a record nor invent one", () => {
  const graphml = WIKIPEDIA_GRAPHML();
  const invented = graphml.replace(
    "</graph>",
    '<!-- <edge id="e900003" source="n48" target="n4096"><data key="d9">request start</data></edge> -->\n</graph>'
  );
  assert.equal(strictRequests(invented).length, 5);
  assert.equal((pageGraphGraphmlToAdapterInput(invented, WIKIPEDIA_OPTIONS).requests ?? []).length, 5);
});

test("the request-count refusal is exported as the approved sentence", () => {
  // No input reaches it today, because validation refuses every edge the
  // extractor would skip. The batch C mutation log seeds a skip in the
  // extractor to prove it fires; this pins the sentence it fires with.
  assert.equal(
    PAGEGRAPH_R2_REQUEST_COUNT_REFUSAL,
    "PageGraph r2 import extracted a different number of requests than the capture's request-start edges."
  );
});
