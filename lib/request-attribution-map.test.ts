import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildReportFacts } from "./report-facts";
import {
  buildRequestAttributionMap,
  MAX_DRAWN_ATTRIBUTION_EDGES,
  requestAttributionActor,
  requestMatchesAttributionPair,
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
      requestsLabel: "1",
      requestsPhrase: "1 request",
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
    requestsLabel: "2",
    requestsPhrase: "2 requests",
    tracker: false,
    role: "mixed"
  });
  assert.equal(map.coverage.attributedRequests, rows.length);
});

/**
 * The defect this pins: the map drew exact per-edge counts while the coverage
 * block directly above it printed floors from the same censored run. Formatting
 * in the model rather than the renderer is what keeps the drawn figure, the
 * spoken figure and the printed figure from disagreeing.
 */
test("a censored capture states every drawn count as a floor, never as an exact figure", () => {
  // Two rows on ONE host, so they aggregate into a single edge and a single
  // destination and both counts read 2.
  const rows: NetworkRequestRecord[] = [
    request(1, { provenance: { scriptDomain: "script.example" } }),
    request(2, {
      domain: "third-1.example",
      url: "https://third-1.example/second",
      provenance: { scriptDomain: "script.example" }
    })
  ];
  const censored = drawn(
    buildRequestAttributionMap({
      ...input(rows),
      evidenceState: "censored"
    })
  );
  assert.equal(censored.edges[0].requestsLabel, "≥2");
  assert.equal(censored.edges[0].requestsPhrase, "at least 2 retained requests");
  assert.equal(censored.destinations[0].requestsLabel, "≥2");
  assert.equal(censored.destinations[0].requestsPhrase, "at least 2 retained requests");

  // The same rows on a complete capture must NOT hedge, or the floor language
  // stops meaning anything.
  const complete = drawn(buildRequestAttributionMap(input(rows)));
  assert.equal(complete.edges[0].requestsLabel, "2");
  assert.equal(complete.edges[0].requestsPhrase, "2 requests");
});

/**
 * The drill-down contract, pinned to a real committed report rather than to a
 * fixture that would agree by construction.
 *
 * `20260814-469dd801...` is AP News. Its baseline arm draws 12 edges out of 368
 * recorded paths with a CENSORED request family, which is exactly the shape a
 * reader meets: a long tail, company grouping, a host that is both a source and
 * a destination, and counts that are floors.
 *
 * Named explicitly instead of "whichever report sorts first", because a guard
 * pinned to a corpus accident silently stops testing what it claims to when the
 * corpus moves. If this report is ever retired, this test fails loudly and
 * should be re-pinned deliberately.
 */
const AP_REPORT_ID = "20260814-469dd801c3015de7d2d2f04ed56ec14c";

function apNewsArm(arm: "baseline" | "variant") {
  const file = path.join(process.cwd(), "public", "reports", `${AP_REPORT_ID}.json`);
  assert.ok(
    readdirSync(path.join(process.cwd(), "public", "reports")).includes(
      `${AP_REPORT_ID}.json`
    ),
    `the pinned attribution report ${AP_REPORT_ID} is gone; re-pin this guard deliberately rather than deleting it`
  );
  const report = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  const run = report[arm];
  assert.ok(run, `${AP_REPORT_ID} has no ${arm} arm`);
  const requests = run.evidence.requests as NetworkRequestRecord[];
  const model = buildRequestAttributionMap({
    requests,
    totalRequests: run.summary.counts.totalRequests,
    thirdPartyRequests: run.summary.counts.thirdPartyRequests,
    automation: "playwright-chromium",
    evidenceState:
      run.quality.byFamily.requests.outcome === "censored" ? "censored" : "complete"
  });
  return { model: drawn(model), requests };
}

function selected(
  requests: readonly NetworkRequestRecord[],
  model: RequestAttributionMapModel,
  actor: string,
  destination: string
): number {
  return requests.filter((request) =>
    requestMatchesAttributionPair(
      request,
      { actor, destination },
      model.destinationByHost
    )
  ).length;
}

test("a drawn edge and the rows it was summed from are the same set", () => {
  const { model, requests } = apNewsArm("baseline");
  assert.equal(model.totalEdges, 368);
  assert.equal(model.edges.length, MAX_DRAWN_ATTRIBUTION_EDGES);

  const edge = model.edges.find(
    (candidate) =>
      candidate.source === "apnews.com" && candidate.dest === "*.primis.tech"
  );
  assert.ok(edge, "the pinned edge is no longer drawn; re-pin deliberately");
  assert.equal(edge.requests, 22);
  assert.equal(edge.requestsLabel, "≥22", "this arm's request family is censored");
  assert.equal(selected(requests, model, "apnews.com", "*.primis.tech"), 22);
});

/**
 * Why the pair is structural and not a text search. On this report a needle
 * naming the destination matches every row INITIATED by that host as well, and
 * a needle naming the actor matches most of the capture.
 */
test("a text needle cannot stand in for edge membership", () => {
  const { model, requests } = apNewsArm("baseline");
  const textMatches = (needle: string) =>
    requests.filter((request) =>
      JSON.stringify(request).toLowerCase().includes(needle)
    ).length;
  assert.equal(selected(requests, model, "apnews.com", "*.primis.tech"), 22);
  assert.ok(
    textMatches("primis.tech") > 22,
    "a destination needle should over-match, which is the reason this predicate exists"
  );
  assert.ok(textMatches("apnews.com") > 200, "an actor needle matches most of the capture");
});

/**
 * The case that closes the "just label the link by one endpoint" escape: one
 * host is drawn as a source node AND a destination node, including a self-loop,
 * so a single-endpoint filter is undecidable between three drawn edges.
 */
test("a host that is both a source and a destination keeps its edges distinct", () => {
  const { model, requests } = apNewsArm("baseline");
  for (const [actor, destination, expected] of [
    ["www.dianomi.com", "www.dianomi.com", 72],
    ["apnews.com", "www.dianomi.com", 22],
    ["www.dianomi.com", "*.dianomi.com", 18]
  ] as const) {
    const edge = model.edges.find(
      (candidate) => candidate.source === actor && candidate.dest === destination
    );
    assert.ok(edge, `${actor} -> ${destination} is no longer drawn`);
    assert.equal(edge.requests, expected);
    assert.equal(selected(requests, model, actor, destination), expected);
  }
});

/**
 * Company grouping: several raw hosts share one destination node, so membership
 * cannot be decided by the node label alone.
 */
test("a destination node spanning several hosts selects every one of them", () => {
  const { model, requests } = apNewsArm("variant");
  const edge = model.edges.find((candidate) => candidate.dest === "Equativ");
  assert.ok(edge, "the pinned grouped destination is no longer drawn");
  assert.equal(selected(requests, model, edge.source, "Equativ"), edge.requests);
  const hosts = [...model.destinationByHost.entries()]
    .filter(([, label]) => label === "Equativ")
    .map(([host]) => host);
  assert.ok(
    hosts.length > 1,
    "this guard is only meaningful while the node really spans several hosts"
  );
  assert.ok(
    !hosts.includes("Equativ"),
    "the node label is a company name, not a host, so a label-equals-host filter would select nothing"
  );
});

/**
 * The cap is a drawing limit, not a measurement. A destination node's total
 * sums only the edges that were drawn, so it must not be presented as the
 * host's full retained volume.
 */
test("node totals describe the drawn subgraph only", () => {
  const { model, requests } = apNewsArm("baseline");
  const destination = model.destinations.find(
    (candidate) => candidate.label === "*.primis.tech"
  );
  assert.ok(destination);
  const drawnToNode = model.edges
    .filter((edge) => edge.dest === destination.label)
    .reduce((total, edge) => total + edge.requests, 0);
  assert.equal(destination.requests, drawnToNode);

  const everyRetainedRow = requests.filter(
    (request) =>
      request.thirdParty &&
      (model.destinationByHost.get(request.domain) ?? "") === destination.label
  ).length;
  assert.ok(
    everyRetainedRow > destination.requests,
    "the pinned report should have rows this node does not draw, which is why a node may not offer a drill-down"
  );
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

/**
 * A catalog match is recorded per REQUEST, so one host can carry matched and
 * unmatched rows in the same visit. While each row was keyed on
 * `entity || host`, that host became two nodes. Not hypothetical: report
 * 20260814-1fc99c87bf75fc63a724167a5bab396d holds `{label}.google.com` as
 * "Google" (1 request) and "*.google.com" (8), and across the committed corpus
 * the drawn destination count changed in 56 of 126 runs.
 *
 * The corpus reconciliation gate cannot catch this. Every row is still counted
 * exactly once, so `attributed + notAttributable === thirdParty` holds; only
 * the destination count and the drawn picture are wrong.
 */
test("one host is one destination even when only some of its rows matched the catalog", () => {
  const rows: NetworkRequestRecord[] = [
    request(1, {
      domain: "{label}.google.com",
      url: "https://{label}.google.com/a",
      thirdParty: true,
      tracker: { domain: "google.com", entity: "Google", category: "advertising", confidence: "curated" },
      provenance: { initiatorDomain: "shop.example" }
    }),
    ...Array.from({ length: 8 }, (_, index) =>
      request(index + 2, {
        domain: "{label}.google.com",
        url: `https://{label}.google.com/b${index}`,
        thirdParty: true,
        tracker: null,
        provenance: { initiatorDomain: "shop.example" }
      })
    )
  ];

  const model = buildRequestAttributionMap({
    requests: rows,
    totalRequests: rows.length,
    thirdPartyRequests: rows.length,
    automation: "playwright-chromium",
    evidenceState: "complete"
  });

  assert.ok(model && model.kind === "map");
  assert.equal(model.destinations.length, 1, "nine rows for one host are one destination, not two");
  assert.equal(model.destinations[0].label, "Google", "one matched row names the host for all of them");
  assert.equal(model.destinations[0].requests, 9, "no request is stranded on a second node");
  assert.equal(model.edges.length, 1);
  assert.equal(model.edges[0].requests, 9);
  assert.equal(
    model.coverage.attributedRequests + model.coverage.notAttributableRequests,
    model.coverage.thirdPartyRequests,
    "the invariant the corpus gate checks holds either way, which is why it could not catch this"
  );
});

test("distinct hosts of one company stay grouped under that company", () => {
  // Company grouping is what the map is for; the fix above must not undo it by
  // drawing two nodes that both read "Meta".
  const rows: NetworkRequestRecord[] = [
    request(1, {
      domain: "static.fbcdn.net",
      url: "https://static.fbcdn.net/a",
      thirdParty: true,
      tracker: { domain: "fbcdn.net", entity: "Meta", category: "advertising", confidence: "curated" },
      provenance: { initiatorDomain: "shop.example" }
    }),
    request(2, {
      domain: "connect.facebook.net",
      url: "https://connect.facebook.net/b",
      thirdParty: true,
      tracker: { domain: "facebook.net", entity: "Meta", category: "advertising", confidence: "curated" },
      provenance: { initiatorDomain: "shop.example" }
    })
  ];

  const model = buildRequestAttributionMap({
    requests: rows,
    totalRequests: rows.length,
    thirdPartyRequests: rows.length,
    automation: "playwright-chromium",
    evidenceState: "complete"
  });

  assert.ok(model && model.kind === "map");
  assert.deepEqual(model.destinations.map((d) => d.label), ["Meta"]);
  assert.equal(model.destinations[0].requests, 2);
});

test("conflicting entity names on one public host fall back deterministically to the host", () => {
  const rows = [
    request(1, {
      domain: "{label}.example.com",
      tracker: { domain: "a.example.com", entity: "Alpha", category: "analytics", confidence: "curated" },
      provenance: { initiatorDomain: "shop.example" }
    }),
    request(2, {
      domain: "{label}.example.com",
      tracker: { domain: "b.example.com", entity: "Beta", category: "analytics", confidence: "curated" },
      provenance: { initiatorDomain: "shop.example" }
    })
  ];
  const build = (requests: NetworkRequestRecord[]) =>
    buildRequestAttributionMap({
      requests,
      totalRequests: requests.length,
      thirdPartyRequests: requests.length,
      automation: "playwright-chromium",
      evidenceState: "complete"
    });

  const forward = build(rows);
  const reversed = build([...rows].reverse());
  assert.ok(forward && forward.kind === "map");
  assert.ok(reversed && reversed.kind === "map");
  assert.deepEqual(forward.destinations, reversed.destinations);
  assert.deepEqual(forward.destinations, [
    {
      label: "*.example.com",
      requests: 2,
      requestsLabel: "2",
      requestsPhrase: "2 requests",
      tracker: true
    }
  ]);
});
