import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildReportFacts } from "./report-facts";
import {
  buildRequestAttributionMap,
  MAX_DRAWN_ATTRIBUTION_EDGES,
  requestAttributionActor,
  type RequestAttributionMapInput
} from "./request-attribution-map";
import { loadedReportFromStored } from "./scan-report-view";
import { readStoredScanReport } from "./scan-report-reader";
import type { NetworkRequestRecord } from "./types";

function request(
  id: number,
  overrides: Partial<NetworkRequestRecord> = {}
): NetworkRequestRecord {
  return {
    id,
    url: `https://third-${id}.example/pixel`,
    domain: `third-${id}.example`,
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty: true,
    tracker: null,
    startedAtMs: id,
    provenance: { initiatorDomain: "first.example" },
    ...overrides
  };
}

function input(
  requests: NetworkRequestRecord[],
  overrides: Partial<RequestAttributionMapInput> = {}
): RequestAttributionMapInput {
  return {
    requests,
    totalRequests: requests.length,
    thirdPartyRequests: requests.filter((row) => row.thirdParty).length,
    automation: "playwright-chromium",
    evidenceState: "complete",
    ...overrides
  };
}

test("the model resolves the same actor precedence and role vocabulary as the request log", () => {
  const row = request(1, {
    provenance: {
      scriptDomain: "script.example",
      initiatorDomain: "initiator.example",
      injectedByDomain: "injector.example"
    }
  });
  assert.deepEqual(requestAttributionActor(row), {
    domain: "script.example",
    role: "script"
  });

  const model = buildRequestAttributionMap(input([row]));
  assert.ok(model);
  assert.deepEqual(model.edges, [
    {
      source: "script.example",
      dest: "third-1.example",
      requests: 1,
      tracker: false,
      role: "script"
    }
  ]);
});

test("complete evidence publishes exact counts and a percentage", () => {
  const model = buildRequestAttributionMap(
    input([
      request(1),
      request(2, { provenance: undefined }),
      request(3, { thirdParty: false, provenance: undefined })
    ])
  );
  assert.ok(model);
  assert.deepEqual(model.coverage, {
    evidenceState: "complete",
    attributedRequests: 1,
    thirdPartyRequests: 2,
    attributedValue: 1,
    thirdPartyValue: "2",
    percentage: 50,
    lowerBound: false,
    summary: "1 of 2 third-party requests had a single recorded actor (50%)."
  });
});

test("censored evidence uses canonical lower-bound formatters and refuses a percentage", () => {
  const model = buildRequestAttributionMap(
    input([request(1), request(2, { provenance: undefined })], {
      evidenceState: "censored"
    })
  );
  assert.ok(model);
  assert.equal(model.coverage.attributedValue, "≥1");
  assert.equal(model.coverage.thirdPartyValue, "≥2");
  assert.equal(model.coverage.percentage, null);
  assert.equal(model.coverage.lowerBound, true);
  assert.match(model.coverage.summary, /counts are lower bounds/);
  assert.match(model.coverage.summary, /no coverage percentage is claimed/);
});

test("a censored zero is incomplete rather than the meaningless floor at least zero", () => {
  const model = buildRequestAttributionMap(
    input([request(1, { provenance: undefined })], { evidenceState: "censored" })
  );
  assert.ok(model);
  assert.equal(model.coverage.attributedValue, "Incomplete");
  assert.doesNotMatch(model.coverage.summary, /≥0 of/);
  assert.equal(model.coverage.percentage, null);
});

test("unsupported request evidence cannot produce a map or counts", () => {
  const unsupported = input([request(1)], { evidenceState: "unsupported" });
  assert.equal(buildRequestAttributionMap(unsupported), null);
  // Unsupported is checked before reconciliation: producer-declared absence of
  // this whole family must never be turned into counts by inspecting stray rows.
  assert.equal(
    buildRequestAttributionMap({ ...unsupported, totalRequests: 999 }),
    null
  );
});

test("the renderer passes the canonical request-family state into the pure model", () => {
  const renderer = readFileSync(
    path.join(process.cwd(), "app", "_components", "report-renderer.tsx"),
    "utf8"
  );
  const component = readFileSync(
    path.join(process.cwd(), "app", "_components", "causality-graph.tsx"),
    "utf8"
  );
  assert.match(
    renderer,
    /requestEvidenceState=\{displayedFacts\.evidence\.requests\.state\}/,
    "the arm being rendered must supply its own canonical family state"
  );
  assert.match(component, /evidenceState: requestEvidenceState/);
  assert.doesNotMatch(
    component,
    /quality\.outcome|captureLoss|requestEvidenceState\(/,
    "the component may not invent a second completeness predicate"
  );
});

test("the model fails closed when summary counts and retained rows diverge", () => {
  const base = input([request(1)]);
  assert.throws(
    () => buildRequestAttributionMap({ ...base, totalRequests: 2 }),
    /request rows do not reconcile/
  );
  assert.throws(
    () => buildRequestAttributionMap({ ...base, thirdPartyRequests: 0 }),
    /third-party rows do not reconcile/
  );
  assert.throws(
    () =>
      buildRequestAttributionMap({
        ...base,
        requests: [{ ...base.requests[0], thirdParty: false }]
      }),
    /third-party rows do not reconcile/
  );
});

test("edge aggregation is deterministic, preserves mixed roles, and discloses the cap", () => {
  const shared = request(1, {
    domain: "shared.example",
    provenance: { scriptDomain: "actor.example" }
  });
  const rows = [
    shared,
    {
      ...shared,
      id: 2,
      provenance: { initiatorDomain: "actor.example" }
    },
    ...Array.from({ length: MAX_DRAWN_ATTRIBUTION_EDGES }, (_, index) =>
      request(index + 3, {
        domain: `tail-${String(index).padStart(2, "0")}.example`,
        provenance: { initiatorDomain: `source-${String(index).padStart(2, "0")}.example` }
      })
    )
  ];
  const model = buildRequestAttributionMap(input(rows));
  assert.ok(model);
  assert.equal(model.totalEdges, MAX_DRAWN_ATTRIBUTION_EDGES + 1);
  assert.equal(model.edges.length, MAX_DRAWN_ATTRIBUTION_EDGES);
  assert.deepEqual(model.edges[0], {
    source: "actor.example",
    dest: "shared.example",
    requests: 2,
    tracker: false,
    role: "mixed"
  });
  assert.equal(model.coverage.attributedRequests, rows.length);
});

test("every committed run reconciles through the attribution model", () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const reportPattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;
  let files: string[] = [];
  try {
    files = readdirSync(reportsDir).filter((name) => reportPattern.test(name));
  } catch {
    return;
  }
  assert.ok(files.length > 0, "expected a committed corpus");

  let runs = 0;
  for (const name of files) {
    const raw: unknown = JSON.parse(readFileSync(path.join(reportsDir, name), "utf8"));
    const read = readStoredScanReport(raw);
    assert.equal(read.ok, true, `${name}: report reader`);
    if (!read.ok) continue;
    const facts = buildReportFacts(loadedReportFromStored(read.stored).view);
    for (const runFacts of facts.runs) {
      const run = runFacts.run;
      const model = buildRequestAttributionMap({
        requests: run.evidence.requests,
        totalRequests: run.counts.totalRequests,
        thirdPartyRequests: run.counts.thirdPartyRequests,
        automation: run.conditions.automation,
        evidenceState: runFacts.evidence.requests.state
      });
      if (runFacts.evidence.requests.state === "unsupported") {
        assert.equal(model, null, `${name}: unsupported request family`);
      } else {
        assert.ok(model, `${name}: supported request family`);
        assert.equal(
          model.coverage.thirdPartyRequests,
          run.counts.thirdPartyRequests,
          `${name}: third-party coverage count`
        );
        assert.ok(
          model.coverage.attributedRequests <= model.coverage.thirdPartyRequests,
          `${name}: attribution cannot exceed retained third-party rows`
        );
        assert.equal(
          model.coverage.percentage === null || runFacts.evidence.requests.state === "complete",
          true,
          `${name}: only complete evidence may publish a percentage`
        );
      }
      runs += 1;
    }
  }
  assert.ok(runs >= files.length, "every report contributes at least one run");
});
