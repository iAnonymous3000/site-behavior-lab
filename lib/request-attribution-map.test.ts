import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildReportFacts } from "./report-facts";
import {
  buildRequestAttributionMap,
  MAX_DRAWN_ATTRIBUTION_EDGES,
  requestAttributionActor,
  type RequestAttributionMapInput,
  type RequestAttributionMapModel
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

/**
 * Narrows to a drawn map. Every caller reading `coverage` or `edges` wants the
 * drawn case; the withhold case has its own tests.
 */
function drawn(
  model: ReturnType<typeof buildRequestAttributionMap>
): RequestAttributionMapModel {
  assert.ok(model, "expected a model");
  if (model.kind !== "map") throw new Error(`expected a drawn map, got ${model.kind}`);
  return model;
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
  const map = drawn(model);
  assert.deepEqual(map.edges, [
    {
      source: "script.example",
      dest: "third-1.example",
      requests: 1,
      tracker: false,
      role: "script"
    }
  ]);
});

test("complete evidence publishes three reconciling counts and no percentage", () => {
  const model = buildRequestAttributionMap(
    input([
      request(1),
      request(2, { provenance: undefined }),
      request(3, { thirdParty: false, provenance: undefined })
    ])
  );
  const map = drawn(model);
  assert.deepEqual(map.coverage, {
    evidenceState: "complete",
    attributedRequests: 1,
    notAttributableRequests: 1,
    thirdPartyRequests: 2,
    attributedValue: 1,
    thirdPartyValue: "2",
    notAttributableValue: 1,
    lowerBound: false,
    summary:
      "2 third-party requests: 1 attributed to a single recorded actor, 1 not attributable."
  });
  // A ratio is the figure a reader would quote, and quoting it across reports
  // is the comparison the cohort rules forbid. Counts read as observations.
  assert.doesNotMatch(map.coverage.summary, /%/);
});

test("attributed plus not attributable always equals the third-party denominator", () => {
  // The bucket exists so a row the capture could not assign stays visible
  // instead of being dropped out of the graph. If these stop reconciling, the
  // map is publishing a denominator that does not add up.
  for (const rows of [
    [request(1), request(2, { provenance: undefined })],
    [request(1, { provenance: undefined }), request(2, { provenance: undefined })],
    [request(1), request(2), request(3, { thirdParty: false, provenance: undefined })]
  ]) {
    const coverage = drawn(buildRequestAttributionMap(input(rows))).coverage;
    assert.equal(
      coverage.attributedRequests + coverage.notAttributableRequests,
      coverage.thirdPartyRequests
    );
  }
});

test("censored evidence uses canonical lower-bound formatters and refuses a percentage", () => {
  const model = buildRequestAttributionMap(
    input([request(1), request(2, { provenance: undefined })], {
      evidenceState: "censored"
    })
  );
  const map = drawn(model);
  assert.equal(map.coverage.attributedValue, "≥1");
  assert.equal(map.coverage.thirdPartyValue, "≥2");
  assert.equal(map.coverage.notAttributableValue, "≥1");
  assert.equal(map.coverage.lowerBound, true);
  assert.match(map.coverage.summary, /lower bound/);
  assert.match(map.coverage.summary, /no coverage percentage is reported/);
  assert.doesNotMatch(map.coverage.summary, /%/);
});

test("a censored zero is incomplete rather than the meaningless floor at least zero", () => {
  const model = buildRequestAttributionMap(
    input([request(1, { provenance: undefined })], { evidenceState: "censored" })
  );
  const map = drawn(model);
  assert.equal(map.coverage.attributedValue, "Incomplete");
  assert.equal(map.coverage.notAttributableValue, "≥1");
  assert.doesNotMatch(map.coverage.summary, /≥0 of/);
  assert.doesNotMatch(map.coverage.summary, /%/);
});

test("a censored zero in the not-attributable bucket is also incomplete", () => {
  const map = drawn(
    buildRequestAttributionMap(input([request(1)], { evidenceState: "censored" }))
  );
  assert.equal(map.coverage.attributedValue, "≥1");
  assert.equal(map.coverage.notAttributableValue, "Incomplete");
  assert.doesNotMatch(map.coverage.summary, /≥0/);
  assert.doesNotMatch(map.coverage.summary, /%/);
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

test("the model withholds the map when summary counts and retained rows diverge", () => {
  // It must not THROW. This runs inside a client component with no error
  // boundary in the report render path, so a throw would blank an entire
  // readable report over the one section it could not draw. 162373c settled
  // the same question the same way: a dropped row must not fail the run
  // around it. Refusing to draw is still the honest outcome, because a map
  // built from rows that contradict the report's own totals would publish a
  // denominator the request log disagrees with.
  const base = input([request(1)]);
  const withheld = (patch: Partial<RequestAttributionMapInput>, pattern: RegExp) => {
    const model = buildRequestAttributionMap({ ...base, ...patch });
    assert.ok(model);
    if (model.kind !== "unreconciled") throw new Error("expected the map to be withheld");
    assert.match(model.reason, pattern);
  };
  withheld({ totalRequests: 2 }, /do not match the recorded total/);
  withheld({ thirdPartyRequests: 0 }, /third-party rows do not match/);
  withheld(
    { requests: [{ ...base.requests[0], thirdParty: false }] },
    /third-party rows do not match/
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
  const map = drawn(model);
  assert.equal(map.totalEdges, MAX_DRAWN_ATTRIBUTION_EDGES + 1);
  assert.equal(map.edges.length, MAX_DRAWN_ATTRIBUTION_EDGES);
  assert.deepEqual(map.edges[0], {
    source: "actor.example",
    dest: "shared.example",
    requests: 2,
    tracker: false,
    role: "mixed"
  });
  assert.equal(map.coverage.attributedRequests, rows.length);
});

test("every committed run reconciles through the attribution model", () => {
  const reportsDir = path.join(process.cwd(), "public", "reports");
  const reportPattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;
  // Deliberately not wrapped in a try/return. A gate that passes when it
  // cannot read the corpus is a gate that reports success for having done
  // nothing; an unreadable corpus must fail loudly instead.
  const files = readdirSync(reportsDir).filter((name) => reportPattern.test(name));
  assert.ok(files.length > 0, "expected a committed corpus");

  let runs = 0;
  let censoredRuns = 0;
  let comparisonReports = 0;
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
        // Every committed run must DRAW. A withheld verdict here means a
        // published report disagrees with its own recorded totals.
        const coverage = drawn(model).coverage;
        assert.equal(
          coverage.thirdPartyRequests,
          run.counts.thirdPartyRequests,
          `${name}: third-party coverage count`
        );
        assert.equal(
          coverage.attributedRequests + coverage.notAttributableRequests,
          coverage.thirdPartyRequests,
          `${name}: attributed + not attributable must equal the third-party denominator`
        );
        assert.doesNotMatch(
          coverage.summary,
          /%/,
          `${name}: coverage is published as counts, never a ratio`
        );
        if (runFacts.evidence.requests.state === "censored") censoredRuns += 1;
      }
      runs += 1;
    }
    if (facts.runs.length > 1) comparisonReports += 1;
  }
  assert.ok(runs >= files.length, "every report contributes at least one run");
  assert.ok(runs > 500, `expected a substantial corpus, walked only ${runs} runs`);
  assert.ok(comparisonReports > 0, "no comparison report exercised both arms");

  /**
   * The censored branch must be exercised by REAL reports, not fixtures alone.
   *
   * Scanning committed JSON for a `requests` capture-loss marker finds none,
   * which is the wrong instrument and reads as "no incomplete evidence
   * exists". `familyCensoredOnRun` is the canonical predicate and it is much
   * wider: ANY exhausted budget censors every family, because a torn-down load
   * also suppresses the scripts that would have produced the rest of the
   * evidence. By that definition the corpus carries a large censored
   * population, and this holds the lower-bound wording to it.
   */
  assert.ok(
    censoredRuns > 0,
    "no committed run exercised the censored lower-bound path"
  );
});
