import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  PAGEGRAPH_R2_MAX_ARTIFACT_BYTES,
  PAGEGRAPH_R2_MAX_KEYS,
  PAGEGRAPH_R2_MAX_RECORDS
} from "./pagegraph-parser";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import {
  buildPageGraphScanReportV2R2,
  parsePageGraphCaptureMetadata,
  type PageGraphCaptureMetadataV1
} from "./pagegraph-v2-r2-builder";
import { scanReportV2R2SemanticViolations } from "./scan-report-v2-r2-evaluators";
import {
  R2_NAVIGATION_STATUS_UNREPRESENTABLE,
  R2_REQUEST_STATUS_UNREPRESENTABLE
} from "./scan-report-v2-http-status";
import { isPublicScanReportV2R2 } from "./scan-report-v2-r2-validation";
import {
  familyUnsupportedOnRun,
  runCensorshipNotes,
  runQualitySummary,
  viewFromV2
} from "./scan-report-views";
import { sha256BytesHex } from "./sha256";
import { publicReportDigest } from "./canonical-json";
import {
  R2RedactionRemediationError,
  redactPublicScanReportV2R2
} from "./scan-report-v2-r2-remediation";

const FIXTURE_DIR = path.join(process.cwd(), "lib", "__fixtures__", "pagegraph");
const GRAPH_BYTES = new Uint8Array(readFileSync(path.join(FIXTURE_DIR, "real-wikipedia-2026-07-19.graphml")));
const METADATA = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, "real-wikipedia-2026-07-19.meta.json"), "utf8")
) as PageGraphCaptureMetadataV1;
const CONTEXT = { buildCommit: "a".repeat(40), runId: "pagegraph-test-run-0001" };

function metadata(): PageGraphCaptureMetadataV1 {
  return structuredClone(METADATA);
}

function bytesFor(graphml: string, target: PageGraphCaptureMetadataV1): Uint8Array {
  const bytes = new TextEncoder().encode(graphml);
  target.artifact.bytes = bytes.byteLength;
  target.artifact.sha256 = sha256BytesHex(bytes);
  return bytes;
}

test("real PageGraph capture emits one passive, request-only, valid r2 report", () => {
  const fixtureText = new TextDecoder().decode(GRAPH_BYTES);
  assert.match(fixtureText, /<version>0\.7\.7<\/version>/);
  assert.match(fixtureText, /<data key="d23">DOM root<\/data>/);
  const report = buildPageGraphScanReportV2R2(GRAPH_BYTES, metadata(), CONTEXT);

  assert.equal(
    publicReportDigest(redactPublicScanReportV2R2(report)),
    publicReportDigest(report),
    "real PageGraph producer output is an exact managed-sanitizer fixed point"
  );

  assert.equal(isPublicScanReportV2R2(report), true);
  assert.deepEqual(scanReportV2R2SemanticViolations(report), []);
  assert.equal(report.schemaRevision, 2);
  assert.equal(report.reportType, "single");
  assert.equal(report.run.provenance.observer, "pagegraph-import");
  assert.equal(report.run.provenance.buildCommit, CONTEXT.buildCommit);
  assert.equal(report.run.provenance.sourceArtifactDigest, undefined, "local uploads do not publish linkable digests");
  assert.equal(report.run.conditions.automation, "brave-pagegraph");
  assert.equal(report.run.conditions.gpc, true);
  assert.equal(report.run.conditions.shields, "off");
  assert.equal(report.run.conditions.headless, false);
  assert.equal(report.run.conditions.locale, "en-US");
  assert.equal(report.run.conditions.timezone, "America/Los_Angeles");
  assert.equal(report.run.summary.pageTitle, "", "page-authored titles do not persist in public PageGraph reports");
  assert.deepEqual(report.run.phases, [{ phaseId: 0, kind: "passive-load", startedAtMs: 0, endedAtMs: 15_459 }]);
  assert.equal(report.run.evidence.requests.length, 5);
  assert.equal(report.run.evidence.requests.every((request) => request.phaseId === 0), true);
  assert.equal(report.run.evidence.requests[0].provenance?.graphRecordId, "id-000001");
  assert.equal(report.run.evidence.requests[1].provenance?.initiatorId, "id-000004");
  assert.equal(report.run.evidence.requests[4].provenance?.initiatorId, "id-000004", "encounter aliases preserve joins");
  assert.equal(JSON.stringify(report).includes("portal/wikipedia.org/assets"), false);

  assert.deepEqual(report.run.evidence.cookiesFinal, []);
  assert.deepEqual(report.run.evidence.storageFinal, []);
  assert.deepEqual(report.run.evidence.storageMutations, []);
  assert.deepEqual(report.run.evidence.fingerprintEvents, []);
  assert.deepEqual(report.run.evidence.fingerprintDetections, []);
  for (const family of ["cookies", "storage", "fingerprinting", "detector-output", "consent-verification"] as const) {
    assert.equal(report.run.quality.byFamily[family].outcome, "censored");
    assert.equal(
      report.run.qualityFacts.captureLoss.some(
        (loss) => loss.family === family && loss.detail === "pagegraph-unsupported" && loss.count === 0
      ),
      true
    );
  }
  assert.equal(Object.values(report.run.detectors).every((entry) => entry.status === "unsupported"), true);
  assert.equal(report.run.warnings.some((warning) => warning.includes("request observations only")), true);
  assert.equal(report.run.warnings.some((warning) => warning.includes("not script-to-request causality")), true);
  assert.equal(report.run.warnings.some((warning) => warning.includes("quality and coverage declarations")), true);
});

test("PageGraph producer identity fails closed on impossible non-request evidence", () => {
  const report = buildPageGraphScanReportV2R2(GRAPH_BYTES, metadata(), CONTEXT);
  report.run.evidence.storageFinal.push({ area: "localStorage", key: "safe", valueBytes: 1 });
  assert.throws(
    () => redactPublicScanReportV2R2(report),
    (error: unknown) =>
      error instanceof R2RedactionRemediationError && error.reason === "sanitizer-rejected-evidence"
  );
});

test("PageGraph r2 records valid 600-999 statuses as explicit frozen-wire limitations", () => {
  const original = new TextDecoder().decode(GRAPH_BYTES);
  const graphml = original.replace(
    '<data key="d42">complete</data>',
    '<data key="d42">699</data>'
  );
  const target = metadata();
  target.quality.status = 699;

  const report = buildPageGraphScanReportV2R2(bytesFor(graphml, target), target, CONTEXT);
  assert.equal(report.run.qualityFacts.status, null);
  assert.equal(report.run.summary.status, null);
  assert.equal(report.run.evidence.requests.some((request) => request.status === null), true);
  assert.equal(report.run.evidence.requests.some((request) => request.status === 599), false);
  assert.equal(report.run.quality.run.outcome, "failed");
  assert.equal(report.run.quality.run.reasons.includes("http-error-status"), true);
  assert.equal(report.run.quality.byFamily.requests.outcome, "censored");
  assert.equal(
    report.run.qualityFacts.captureLoss.some(
      (entry) => entry.detail === R2_NAVIGATION_STATUS_UNREPRESENTABLE && entry.phaseId === null && entry.count === 1
    ),
    true
  );
  assert.equal(
    report.run.qualityFacts.captureLoss.some(
      (entry) => entry.detail === R2_REQUEST_STATUS_UNREPRESENTABLE && entry.phaseId === 0 && entry.count === 1
    ),
    true
  );
  assert.equal(isPublicScanReportV2R2(report), true);
  assert.deepEqual(scanReportV2R2SemanticViolations(report), []);
});

test("PageGraph r2 rejects malformed statuses but admits the complete three-digit grammar before normalization", () => {
  const accepted = metadata();
  accepted.quality.status = 999;
  assert.equal(parsePageGraphCaptureMetadata(accepted).quality.status, 999);

  for (const status of [99, 1_000, 200.5]) {
    const target = metadata();
    target.quality.status = status;
    assert.throws(() => parsePageGraphCaptureMetadata(target), /100 through 999/);
  }

  const original = new TextDecoder().decode(GRAPH_BYTES);
  const malformedGraph = original.replace(
    '<data key="d42">complete</data>',
    '<data key="d42">1000</data>'
  );
  const target = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(malformedGraph, target), target, CONTEXT),
    /request 1 HTTP status.*100 through 999/
  );
});

test("PageGraph unsupported sentinels require the exact r2 producer and family set", () => {
  const report = buildPageGraphScanReportV2R2(GRAPH_BYTES, metadata(), CONTEXT);

  const missing = structuredClone(report);
  missing.run.qualityFacts.captureLoss = missing.run.qualityFacts.captureLoss.filter(
    (loss) => !(loss.family === "cookies" && loss.detail === "pagegraph-unsupported")
  );
  assert.equal(isPublicScanReportV2R2(missing), false, "a missing unsupported family is rejected");

  const duplicate = structuredClone(report);
  const sentinel = duplicate.run.qualityFacts.captureLoss.find((loss) => loss.detail === "pagegraph-unsupported");
  assert.ok(sentinel);
  duplicate.run.qualityFacts.captureLoss.push(structuredClone(sentinel));
  assert.equal(isPublicScanReportV2R2(duplicate), false, "a duplicate unsupported family is rejected");

  const wrongProducer = structuredClone(report);
  wrongProducer.run.provenance.observer = "node-playwright";
  assert.equal(isPublicScanReportV2R2(wrongProducer), false, "another producer cannot mint the sentinel");
});

test("request-only PageGraph reports render unsupported families as unavailable, never zero or interrupted", () => {
  const report = buildPageGraphScanReportV2R2(GRAPH_BYTES, metadata(), CONTEXT);
  const view = viewFromV2(report, 2);
  const run = view.runs[0];
  assert.equal(familyUnsupportedOnRun(run, "cookies"), true);
  assert.equal(familyUnsupportedOnRun(run, "storage"), true);
  assert.equal(familyUnsupportedOnRun(run, "fingerprinting"), true);
  assert.deepEqual(runCensorshipNotes(run), []);
  assert.match(runQualitySummary(run), /complete for supported evidence; unsupported:/);
  assert.match(runQualitySummary(run), /declared by the supplied PageGraph sidecar/);
  assert.doesNotMatch(runQualitySummary(run), /cut short/);

  const headline = buildReportHeadline(view);
  assert.match(headline.headline, /PageGraph report covers requests/);
  assert.match(headline.subhead, /not captured.*unavailable measurements, not observed absences/);
  assert.doesNotMatch(`${headline.headline} ${headline.subhead}`, /kept this visit relatively private|cut short/);

  const findings = buildFindings(view, null);
  const cookie = findings.find((finding) => finding.id === "third-party-cookies");
  const fingerprint = findings.find((finding) => finding.id === "fingerprint-apis");
  assert.equal(cookie?.title, "Cookie evidence was not captured");
  assert.equal(fingerprint?.title, "Fingerprinting evidence was not captured");
  assert.match(findings[0]?.title ?? "", /covers requests; other evidence was not captured/);
  const rendered = JSON.stringify(findings);
  assert.doesNotMatch(rendered, /No third-party cookies observed|No fingerprint-like API calls observed|cut short/);

  const overviewSource = readFileSync(path.join(process.cwd(), "app", "_components", "report-overview.tsx"), "utf8");
  const tablesSource = readFileSync(path.join(process.cwd(), "app", "_components", "report-tables.tsx"), "utf8");
  const phasesSource = readFileSync(
    path.join(process.cwd(), "app", "_components", "visit-phases-and-state-changes.tsx"),
    "utf8"
  );
  const rendererSource = readFileSync(
    path.join(process.cwd(), "app", "_components", "report-renderer.tsx"),
    "utf8"
  );
  assert.match(overviewSource, /cookiesUnsupported \? "Not captured"/);
  assert.match(overviewSource, /storageUnsupported \? "Not captured"/);
  assert.match(overviewSource, /fingerprintUnsupported \? "Not captured"/);
  assert.match(tablesSource, /Cookie evidence was not captured/);
  assert.match(tablesSource, /Storage evidence was not captured/);
  assert.match(tablesSource, /Browser-behavior evidence was not captured/);
  assert.match(phasesSource, /Not captured/);
  assert.match(phasesSource, /PageGraph unsupported/);
  assert.match(rendererSource, /unsupported=\{familyUnsupportedOnRun\(displayedRun, "cookies"\)\}/);
});

test("fixture provenance digest is an explicit opt-in and r2 requires lowercase SHA-256", () => {
  const report = buildPageGraphScanReportV2R2(GRAPH_BYTES, metadata(), {
    ...CONTEXT,
    includeSourceArtifactDigest: true
  });
  assert.equal(report.run.provenance.sourceArtifactDigest, METADATA.artifact.sha256);

  const forged = structuredClone(report);
  forged.run.provenance.sourceArtifactDigest = "A".repeat(64);
  assert.equal(isPublicScanReportV2R2(forged), false);
});

test("metadata is exact-key and cannot self-report the app build", () => {
  const extraRoot = metadata() as PageGraphCaptureMetadataV1 & { buildCommit?: string };
  extraRoot.buildCommit = "b".repeat(40);
  assert.throws(() => parsePageGraphCaptureMetadata(extraRoot), /unknown field/);

  const extraNested = metadata() as PageGraphCaptureMetadataV1 & {
    capture: PageGraphCaptureMetadataV1["capture"] & { guessed?: boolean };
  };
  extraNested.capture.guessed = true;
  assert.throws(() => parsePageGraphCaptureMetadata(extraNested), /unknown field/);

  assert.throws(
    () => buildPageGraphScanReportV2R2(GRAPH_BYTES, metadata(), { ...CONTEXT, buildCommit: "main" }),
    /app-build Git SHA/
  );
});

test("artifact digest, byte length, UTF-8, and parser envelopes fail closed", () => {
  const wrongDigest = metadata();
  wrongDigest.artifact.sha256 = "0".repeat(64);
  assert.throws(() => buildPageGraphScanReportV2R2(GRAPH_BYTES, wrongDigest, CONTEXT), /SHA-256/);

  const wrongLength = metadata();
  wrongLength.artifact.bytes -= 1;
  assert.throws(() => buildPageGraphScanReportV2R2(GRAPH_BYTES, wrongLength, CONTEXT), /byte length/);

  const uppercaseDigest = metadata();
  uppercaseDigest.artifact.sha256 = uppercaseDigest.artifact.sha256.toUpperCase();
  assert.throws(() => parsePageGraphCaptureMetadata(uppercaseDigest), /lowercase 64-character digest/);

  const oversized = metadata();
  oversized.artifact.bytes = PAGEGRAPH_R2_MAX_ARTIFACT_BYTES + 1;
  assert.throws(() => parsePageGraphCaptureMetadata(oversized), /artifact bytes/);

  const invalidUtf8 = new Uint8Array([0xff]);
  const invalidUtf8Meta = metadata();
  invalidUtf8Meta.artifact.bytes = 1;
  invalidUtf8Meta.artifact.sha256 = sha256BytesHex(invalidUtf8);
  assert.throws(() => buildPageGraphScanReportV2R2(invalidUtf8, invalidUtf8Meta, CONTEXT), /valid UTF-8/);

  const graphml = new TextDecoder().decode(GRAPH_BYTES).replace(
    "[redacted]",
    "x".repeat(16_385)
  );
  const fieldMeta = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(graphml, fieldMeta), fieldMeta, CONTEXT),
    /fields exceed/
  );
});

test("strict parser rejects inferred request facts and sidecar/artifact disagreement", () => {
  const original = new TextDecoder().decode(GRAPH_BYTES);

  const noTimestamp = original.replace('<data key="d26">207</data>', "");
  const noTimestampMeta = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(noTimestamp, noTimestampMeta), noTimestampMeta, CONTEXT),
    /integer millisecond timestamp/
  );

  const noType = original.replace('<data key="d31">Image</data>', "");
  const noTypeMeta = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(noType, noTypeMeta), noTypeMeta, CONTEXT),
    /explicit resource type/
  );

  const wrongRoot = metadata();
  wrongRoot.capture.finalUrl = "https://en.wikipedia.org/";
  assert.throws(() => buildPageGraphScanReportV2R2(GRAPH_BYTES, wrongRoot, CONTEXT), /root URL/);

  const shortDuration = metadata();
  shortDuration.capture.durationMs = 206;
  assert.throws(
    () => buildPageGraphScanReportV2R2(GRAPH_BYTES, shortDuration, CONTEXT),
    /description time interval does not match/
  );

  const noncanonicalTimestamp = original.replace('<data key="d26">207</data>', '<data key="d26">2e2</data>');
  const noncanonicalTimestampMeta = metadata();
  assert.throws(
    () =>
      buildPageGraphScanReportV2R2(
        bytesFor(noncanonicalTimestamp, noncanonicalTimestampMeta),
        noncanonicalTimestampMeta,
        CONTEXT
      ),
    /canonical nonnegative integer millisecond timestamp tokens/
  );
});

test("invalid request URLs produce exact loss facts and one bounded aggregate warning", () => {
  const original = new TextDecoder().decode(GRAPH_BYTES);
  const invalidUrl = original.replace(
    "https://www.wikipedia.org/portal/wikipedia.org/assets/img/Wikipedia-logo-v2@2x.png",
    "ftp://invalid.example/logo.png"
  );
  const target = metadata();
  const report = buildPageGraphScanReportV2R2(bytesFor(invalidUrl, target), target, CONTEXT);
  assert.equal(report.run.evidence.requests.length, 4);
  assert.equal(
    report.run.qualityFacts.captureLoss.some(
      (loss) => loss.family === "requests" && loss.detail === "pagegraph-invalid-request" && loss.count === 1
    ),
    true
  );
  assert.equal(
    report.run.warnings.filter((warning) => warning.includes("requests were omitted because their URLs")).length,
    1
  );
  assert.equal(report.run.warnings.some((warning) => /Skipped PageGraph request \d+/.test(warning)), false);
});

test("GraphML description provenance is version-locked and bound to the sidecar", () => {
  const original = new TextDecoder().decode(GRAPH_BYTES);

  const newerSchema = original.replace("<version>0.7.7</version>", "<version>0.7.8</version>");
  const newerSchemaMeta = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(newerSchema, newerSchemaMeta), newerSchemaMeta, CONTEXT),
    /require PageGraph schema 0\.7\.7/
  );

  const mismatchedDate = original.replace("1784504849.150528", "1784504850.150528");
  const mismatchedDateMeta = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(mismatchedDate, mismatchedDateMeta), mismatchedDateMeta, CONTEXT),
    /description capture date does not match/
  );

  const mismatchedDuration = original.replace("<end>15459</end>", "<end>15460</end>");
  const mismatchedDurationMeta = metadata();
  assert.throws(
    () =>
      buildPageGraphScanReportV2R2(
        bytesFor(mismatchedDuration, mismatchedDurationMeta),
        mismatchedDurationMeta,
        CONTEXT
      ),
    /description time interval does not match/
  );

  const sidecarSchema = metadata();
  sidecarSchema.tool.pageGraphSchemaVersion = "0.7.8";
  assert.throws(() => parsePageGraphCaptureMetadata(sidecarSchema), /requires PageGraph schema 0\.7\.7/);

  const malformedDescriptions: Array<[string, string, RegExp]> = [
    ["wrong about", original.replace("/wiki/PageGraph</about>", "/wiki/Other</about>"), /current PageGraph about URL/],
    ["non-root frame", original.replace("<frame_id>0</frame_id>", "<frame_id>1</frame_id>"), /root frame_id 0/],
    [
      "unknown child",
      original.replace("<time><start>", "<unknown>value</unknown><time><start>"),
      /unknown, duplicate, or malformed child/
    ],
    [
      "duplicate child",
      original.replace("<about>", "<about>https://github.com/brave/brave-browser/wiki/PageGraph</about><about>"),
      /exactly one attribute-free about value/
    ]
  ];
  for (const [label, graphml, expected] of malformedDescriptions) {
    const target = metadata();
    assert.throws(
      () => buildPageGraphScanReportV2R2(bytesFor(graphml, target), target, CONTEXT),
      expected,
      label
    );
  }
});

test("strict GraphML structure rejects ambiguous identities and duplicate declarations", () => {
  const original = new TextDecoder().decode(GRAPH_BYTES);
  const cases: Array<[string, string, RegExp]> = [
    ["missing id", original.replace('<node id="n1">', "<node>"), /require an explicit nonempty id/],
    ["duplicate id", original.replace('<node id="n2">', '<node id="n1">'), /duplicate node\/edge ids/],
    ["duplicate key", original.replace('<key id="d3"', '<key id="d2"'), /duplicate key declarations/],
    ["unknown attribute", original.replace('<node id="n1">', '<node id="n1" guessed="true">'), /unknown attributes/],
    ["malformed attribute", original.replace('<node id="n1">', '<node id="n1" stray>'), /malformed attribute syntax/],
    [
      "duplicate field",
      original.replace(
        '<data key="d23">Brave Shields</data>',
        '<data key="d23">Brave Shields</data><data key="d23">Brave Shields</data>'
      ),
      /duplicate data field declarations/
    ]
  ];

  for (const [label, graphml, expected] of cases) {
    const target = metadata();
    assert.throws(
      () => buildPageGraphScanReportV2R2(bytesFor(graphml, target), target, CONTEXT),
      expected,
      label
    );
  }
});

test("strict parser stops at the PageGraph record ceiling", () => {
  const description =
    '<desc><version>0.7.7</version><about>https://github.com/brave/brave-browser/wiki/PageGraph</about>' +
    '<is_root>true</is_root><frame_id>0</frame_id><url>https://www.wikipedia.org/</url>' +
    '<date>1784504849.150528</date><time><start>0</start><end>15459</end></time></desc>';
  const records = Array.from({ length: PAGEGRAPH_R2_MAX_RECORDS + 1 }, (_, index) =>
    `<node id="n${index}"></node>`
  ).join("");
  const graphml = `<graphml>${description}<graph>${records}</graph></graphml>`;
  const target = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(graphml, target), target, CONTEXT),
    /must not exceed 250000 graph records/
  );
});

test("strict parser bounds key declarations before record parsing", () => {
  const original = new TextDecoder().decode(GRAPH_BYTES);
  const extraKeys = Array.from(
    { length: PAGEGRAPH_R2_MAX_KEYS + 1 },
    (_, index) => `<key id="extra-${index}" for="node" attr.name="extra-${index}" attr.type="string"/>`
  ).join("");
  const graphml = original.replace("</desc>", `</desc>${extraKeys}`);
  const target = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(graphml, target), target, CONTEXT),
    /must not exceed 1024 key declarations/
  );

  const oversizedId = original.replace('<key id="d2"', `<key id="${"k".repeat(257)}"`);
  const oversizedIdMeta = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(oversizedId, oversizedIdMeta), oversizedIdMeta, CONTEXT),
    /key ids and names.*at most 256/
  );
});

test("strict root selection accepts only the described DOM root or web-page node", () => {
  const original = new TextDecoder().decode(GRAPH_BYTES);
  const frameOwnerOnly = original.replace(
    '<data key="d23">DOM root</data>',
    '<data key="d23">frame owner</data>'
  );
  const target = metadata();
  assert.throws(
    () => buildPageGraphScanReportV2R2(bytesFor(frameOwnerOnly, target), target, CONTEXT),
    /explicit DOM root\/web-page node/
  );
});

test("unsupported coverage and detector claims cannot be upgraded by metadata", () => {
  const storage = metadata();
  storage.quality.families.storage = { outcome: "complete" } as never;
  assert.throws(() => parsePageGraphCaptureMetadata(storage), /storage coverage.*unsupported/);

  const detector = metadata();
  detector.detectors["fingerprint-heuristics"] = {
    version: "pagegraph-import-unsupported@1",
    status: "complete"
  };
  assert.throws(() => parsePageGraphCaptureMetadata(detector), /missing required fields|must explicitly declare/);

  const shields = metadata();
  shields.capture.shields = "classification" as never;
  assert.throws(() => parsePageGraphCaptureMetadata(shields), /Shields explicitly off/);

  const unknownRequestLoss = metadata();
  unknownRequestLoss.quality.families.requests = {
    outcome: "censored",
    kind: "dropped",
    count: null,
    budget: "request-capture"
  } as never;
  assert.throws(() => parsePageGraphCaptureMetadata(unknownRequestLoss), /exact positive loss count/);

  const zeroRequestLoss = metadata();
  zeroRequestLoss.quality.families.requests = {
    outcome: "censored",
    kind: "dropped",
    count: 0,
    budget: "request-capture"
  };
  assert.throws(() => parsePageGraphCaptureMetadata(zeroRequestLoss), /exact positive loss count/);

  const exactRequestLoss = metadata();
  exactRequestLoss.quality.families.requests = {
    outcome: "censored",
    kind: "dropped",
    count: 2,
    budget: "request-capture"
  };
  const parsedRequestLoss = parsePageGraphCaptureMetadata(exactRequestLoss).quality.families.requests;
  if (parsedRequestLoss.outcome !== "censored") assert.fail("expected censored request coverage");
  assert.equal(parsedRequestLoss.count, 2);
});

test("capture identities and environment facts cannot use guessed placeholders", () => {
  const noncanonicalTime = metadata();
  noncanonicalTime.capture.scannedAt = "2026-07-19T23:47:29Z";
  assert.throws(() => parsePageGraphCaptureMetadata(noncanonicalTime), /canonical ISO timestamp/);

  const unknownTimezone = metadata();
  unknownTimezone.capture.timezone = "unknown";
  assert.throws(() => parsePageGraphCaptureMetadata(unknownTimezone), /timezone.*closed public vocabulary/);

  const deviceMismatch = metadata();
  deviceMismatch.capture.device.viewport.isMobile = true;
  assert.throws(() => parsePageGraphCaptureMetadata(deviceMismatch), /device kind disagrees/);

  const shortRevision = metadata();
  shortRevision.tool.sourceRevision = shortRevision.tool.sourceRevision.slice(0, 8);
  assert.throws(() => parsePageGraphCaptureMetadata(shortRevision), /full lowercase Git SHA/);

  const credentialUrl = metadata();
  credentialUrl.capture.requestedUrl = "https://user:password@www.wikipedia.org/";
  assert.throws(() => parsePageGraphCaptureMetadata(credentialUrl), /credential-free/);
});
