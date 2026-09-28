import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  classifyFeaturedFailures,
  featuredBatchOutcome,
  featuredStepSummaryLines,
  selectSites
} from "./run-featured-scans.mjs";
import {
  buildFeaturedRefreshIssueReport,
  FEATURED_REFUSAL_CEILING,
  featuredBatchHealth,
  featuredCatalogEligibility,
  featuredPublicationDecision,
  publicFailureTaxonomy,
  publicFeaturedScanSummary,
  summarizeFailureTaxonomy,
  UNAMBIGUOUS_TARGET_REFUSALS
} from "./run-featured-scans-diagnostics.mjs";
import { FEATURED_READJUDICATION_REASONS } from "./featured-readjudication-lib.mjs";
import { awaitSubmittedScanJob } from "./run-ci-scan-job.mjs";

/**
 * Pinned to the EXACT strings two real runs produced on 2026-08-14, not to
 * invented ones. A classifier written against paraphrases is a classifier that
 * silently stops matching the first time the producer rewords a message, and
 * the failure mode is the worst kind: everything lands in `unclassified` while
 * the run still looks green.
 */
const REAL_FAILURES = [
  { site: "coinbase.com", message: "Skipping scan target: primary baseline arm: main navigation returned HTTP 403.", unavailableReason: "access-denied" },
  { site: "reuters.com", message: "Skipping scan target: primary baseline arm: main navigation returned HTTP 401.", unavailableReason: "authentication-required" },
  { site: "wayfair.com", message: "Skipping scan target: primary baseline arm: main navigation returned HTTP 429.", unavailableReason: "rate-limited" },
  { site: "fidelity.com", message: "The page could not be loaded. The site may be down, unreachable, or blocking automated visits.", unavailableReason: null },
  { site: "cnn.com", message: "Skipping scan target: primary baseline arm: only 1 network request(s) observed, navigation likely failed or was blocked.", unavailableReason: "navigation-incomplete" },
  { site: "ebay.com", message: "The scan exceeded the maximum scan duration.", unavailableReason: null },
  { site: "americanexpress.com", message: "Skipping scan target: primary baseline arm: report could not verify the rendered page subject.", unavailableReason: "navigation-incomplete" }
];

test("site refusals are separated from scanner faults", () => {
  const groups = classifyFeaturedFailures(REAL_FAILURES);
  const refused = groups.get("target-refused") ?? [];
  assert.deepEqual(
    refused.map((entry) => entry.site).sort(),
    ["cnn.com", "coinbase.com", "fidelity.com", "reuters.com", "wayfair.com"],
    "403, 401, 429, an unreachable load and a one-request navigation are all the site declining"
  );
  assert.deepEqual((groups.get("scanner-timeout") ?? []).map((e) => e.site), ["ebay.com"]);
  assert.deepEqual((groups.get("subject-unverified") ?? []).map((e) => e.site), ["americanexpress.com"]);
});

test("nothing real lands in unclassified", () => {
  // The bucket exists so an unfamiliar message is visible rather than silently
  // counted as a refusal. If a producer reword drops known failures into it,
  // this fails instead of quietly reclassifying the web as hostile.
  const groups = classifyFeaturedFailures(REAL_FAILURES);
  assert.equal(groups.get("unclassified"), undefined);
  const unknown = classifyFeaturedFailures([{ site: "x.example", message: "something nobody has seen" }]);
  assert.equal((unknown.get("unclassified") ?? []).length, 1);
});

/**
 * The sampled fixture above was seven of the ten sentences the producer can
 * emit, and it happened to contain the five the regexes matched. Enumerating
 * the producer's whole vocabulary is the difference between a guard and a
 * coincidence: five of these ten reached `unclassified`, which is counted as
 * scanner-attributable, so every bot-walled site was published inside "N are
 * attributable to this scanner and are worth investigating."
 *
 * Every one of them carries a structured `unavailableReason`, because
 * `botBlockUnavailableReason` classifies the same run from report facts rather
 * than from its own English. Reading that is what fixes them all at once.
 */
/**
 * Every sentence `botBlockReason`/`runFailureReason` can emit, PAIRED WITH THE
 * REASON THAT REAL RUN CARRIES. An earlier version of this guard stamped
 * "automation-blocked" on all ten, which reduced it to asserting that a
 * constant is a member of a constant list: it could not fail however wrong the
 * sentence-to-reason mapping was, and it hid that mapping every
 * `navigation-incomplete` failure -- including our own subject-verification
 * failures -- onto "the site refused".
 */
const PRODUCER_OUTCOMES = [
  ["landing page title matches a bot-block/challenge page", "automation-blocked", "target-refused"],
  ["report recorded a suspected challenge or soft block", "automation-blocked", "target-refused"],
  ["main navigation returned HTTP 403", "access-denied", "target-refused"],
  ["main navigation returned HTTP 401", "authentication-required", "target-refused"],
  ["main navigation returned HTTP 429", "rate-limited", "target-refused"],
  ["main navigation produced no HTTP response", "navigation-incomplete", "target-refused"],
  ["main navigation returned HTTP 503", "navigation-incomplete", "target-refused"],
  ["only 1 network request(s) observed, navigation likely failed or was blocked", "navigation-incomplete", "target-refused"],
  ["report could not verify the rendered page subject", "navigation-incomplete", "subject-unverified"],
  ["main navigation did not settle", "navigation-incomplete", "unclassified"],
  ["report quality evaluator marked the run failed", "navigation-incomplete", "unclassified"]
];

test("every sentence the producer can emit lands where its cause belongs", () => {
  for (const [sentence, unavailableReason, expected] of PRODUCER_OUTCOMES) {
    const kinds = [
      ...classifyFeaturedFailures([
        {
          site: "example.test",
          message: `Skipping scan target: primary baseline arm: ${sentence}.`,
          unavailableReason
        }
      ]).keys()
    ];
    assert.deepEqual(kinds, [expected], `"${sentence}" (${unavailableReason})`);
  }
});

/**
 * Failures raised BEFORE a report exists carry no structured reason, so the
 * sentence alone decides them, and a refused sentence leaves the gate's
 * denominator. Mentioning a refusal's status code is therefore not enough: the
 * scanner's own status route answers 429 too, and its private-address guard
 * also says the page "could not be loaded". Each sentence is pinned verbatim to
 * its producer, the scanner's by reading lib/scanner.ts and the status route's
 * by running the real poller, so a reword fails here instead of moving the gate.
 */
const PRE_REPORT_OUTCOMES = [
  ["The page could not be loaded. The site may be down, unreachable, or blocking automated visits.", "target-refused"],
  ["The page could not be loaded because it resolved to a local or private network address.", "unclassified"],
  ["The page did not load before the scan timeout.", "scanner-timeout"],
  ["The scan exceeded the maximum scan duration.", "scanner-timeout"]
];

async function statusRouteFailure(status) {
  try {
    await awaitSubmittedScanJob({
      submission: { jobId: "job-1", statusPath: "/api/scans/job-1" },
      baseUrl: "http://127.0.0.1:3100",
      isPublishableScanReport: () => false,
      fetcher: async () => new Response("busy", { status }),
      wait: async () => {}
    });
  } catch (error) {
    return error.message;
  }
  assert.fail("the poller must give up on a status route that never recovers");
}

const kindsOf = (message) => [
  ...classifyFeaturedFailures([{ site: "example.test", message, unavailableReason: null }]).keys()
];

test("a pre-report sentence is a refusal only when it is the target's own answer", async () => {
  const scanner = readFileSync(new URL("../lib/scanner.ts", import.meta.url), "utf8");
  for (const [sentence, expected] of PRE_REPORT_OUTCOMES) {
    assert.ok(scanner.includes(`"${sentence}"`), `lib/scanner.ts no longer emits "${sentence}"`);
    assert.deepEqual(kindsOf(sentence), [expected], sentence);
  }

  for (const status of [429, 503]) {
    const message = await statusRouteFailure(status);
    assert.equal(message, `Scan job status remained temporarily unavailable (HTTP ${status}).`);
    assert.deepEqual(kindsOf(message), ["unclassified"], `our status route's ${status} is not the site declining`);
  }
});

test("the catch-all reason never decides fault on its own", () => {
  // navigation-incomplete covers a missing HTTP response AND three outcomes
  // that are ours. Short-circuiting on it published a scanner-side
  // verification failure as a site refusing an honest browser.
  assert.equal(
    UNAMBIGUOUS_TARGET_REFUSALS.has("navigation-incomplete"),
    false,
    "navigation-incomplete is the producer catch-all and must not short-circuit"
  );
  for (const reason of UNAMBIGUOUS_TARGET_REFUSALS) {
    assert.ok(
      FEATURED_READJUDICATION_REASONS.includes(reason),
      `${reason} must remain a real readjudication reason`
    );
  }

  const ours = classifyFeaturedFailures([
    {
      site: "s.example",
      message: "Skipping scan target: primary baseline arm: report could not verify the rendered page subject.",
      unavailableReason: "navigation-incomplete"
    }
  ]);
  assert.deepEqual([...ours.keys()], ["subject-unverified"], "our own verification failure stays ours");
});

test("a structured reason outranks the wording, and its absence falls back to it", () => {
  for (const reason of UNAMBIGUOUS_TARGET_REFUSALS) {
    const groups = classifyFeaturedFailures([
      { site: "s.example", message: "something nobody has seen", unavailableReason: reason }
    ]);
    assert.deepEqual([...groups.keys()], ["target-refused"], `${reason} is the site declining`);
  }

  // Failures raised BEFORE a report exists carry no structured reason, so the
  // regexes must still classify them. A scan deadline is ours, not theirs.
  const preReport = classifyFeaturedFailures([
    { site: "s.example", message: "The scan exceeded the maximum scan duration.", unavailableReason: null }
  ]);
  assert.deepEqual([...preReport.keys()], ["scanner-timeout"]);

  // Without its reason, the target's own status still reads as its answer.
  for (const status of [401, 403, 429]) {
    assert.deepEqual(
      kindsOf(`Skipping scan target: primary baseline arm: main navigation returned HTTP ${status}.`),
      ["target-refused"],
      `the target's own ${status}`
    );
  }

  // An unrecognized reason must not be trusted into the refused bucket.
  const bogus = classifyFeaturedFailures([
    { site: "s.example", message: "something nobody has seen", unavailableReason: "invented" }
  ]);
  assert.deepEqual([...bogus.keys()], ["unclassified"]);
});

test("refusals are reported first", () => {
  // They are the large, expected group. Listing a one-off scanner fault above
  // them is what makes a rate read as a regression.
  const order = [...classifyFeaturedFailures(REAL_FAILURES).keys()];
  assert.equal(order[0], "target-refused");
});

test("the taxonomy changes no counts", () => {
  // It names the parts, and the refused part now leaves the success-rate
  // denominator. A classifier that drops or duplicates a failure would move
  // that gate by exactly the failures it lost or invented.
  const groups = classifyFeaturedFailures(REAL_FAILURES);
  const total = [...groups.values()].reduce((sum, group) => sum + group.length, 0);
  assert.equal(total, REAL_FAILURES.length);
  assert.deepEqual(classifyFeaturedFailures([]).size, 0);
});

/**
 * The 2026-08-10 gallery leg published `61/81 (75%)` into the canonical issue
 * and nothing else. An operator reading that starts debugging a scanner that
 * is working. These tests hold the split all the way onto the issue an
 * operator actually reads.
 */
function summaryFor(failures, { succeeded = 74, catalogTotal = 81 } = {}) {
  const total = succeeded + failures.length;
  return {
    fullCatalog: true,
    catalogVersion: 2,
    catalogTotal,
    unavailable: catalogTotal - total,
    total,
    succeeded,
    failed: failures.length,
    successRate: succeeded / total,
    requiredSuccessRate: 0.8,
    catalogCoverage: total / catalogTotal,
    requiredCatalogCoverage: 0.8,
    minimumEligibleSites: 50,
    failureTaxonomy: summarizeFailureTaxonomy(failures),
    failures
  };
}

test("the split survives the sanitized cross-job projection", () => {
  // The alerting job never sees `failures`, only this projection. Computing
  // the taxonomy where the issue is written would render nothing at all.
  const aggregate = publicFeaturedScanSummary(summaryFor(REAL_FAILURES));
  assert.notEqual(aggregate, null);
  assert.deepEqual(aggregate.failureTaxonomy, [
    { kind: "target-refused", count: 5 },
    { kind: "scanner-timeout", count: 1 },
    { kind: "subject-unverified", count: 1 }
  ]);
});

test("the canonical issue says which kind of red, in counts only", () => {
  const aggregate = publicFeaturedScanSummary(summaryFor(REAL_FAILURES));
  const report = buildFeaturedRefreshIssueReport({
    failed: true,
    summary: aggregate,
    branch: "main",
    serverUrl: "https://github.com",
    repository: "iAnonymous3000/site-behavior-lab",
    runId: "1",
    catalogSlug: "gallery"
  });

  assert.match(report, /## Which kind of red/);
  assert.match(report, /sites that refused an automated visit: \*\*5\*\*/);
  assert.match(report, /5 of 7 failures are sites refusing an undisguised automated browser/);
  assert.match(report, /2 are attributable to this scanner/);

  // The issue is deliberately name-free. A taxonomy that leaked one target
  // would be a disclosure regression, not a reporting improvement.
  for (const failure of REAL_FAILURES) {
    assert.ok(!report.includes(failure.site), `${failure.site} must not reach the public issue`);
    assert.ok(!report.includes(failure.message), "raw failure messages must not reach the public issue");
  }
});

test("a taxonomy that contradicts the published counts is dropped, not rendered", () => {
  // It arrives over an untrusted cross-job boundary and sits beside the very
  // numbers it explains. Two disagreeing accounts of one run is worse than one.
  assert.equal(publicFailureTaxonomy([{ kind: "target-refused", count: 5 }], 7), null);
  assert.equal(publicFailureTaxonomy([{ kind: "invented-kind", count: 7 }], 7), null);
  assert.equal(publicFailureTaxonomy([{ kind: "target-refused", count: 1.5 }], 1.5), null);
  assert.equal(
    publicFailureTaxonomy([{ kind: "target-refused", count: 3 }, { kind: "target-refused", count: 4 }], 7),
    null
  );
  assert.notEqual(publicFailureTaxonomy([{ kind: "target-refused", count: 7 }], 7), null);
});

test("a summary predating the taxonomy still publishes every other aggregate", () => {
  const summary = summaryFor(REAL_FAILURES);
  delete summary.failureTaxonomy;
  const aggregate = publicFeaturedScanSummary(summary);
  assert.notEqual(aggregate, null, "an older summary must not become unpublishable");
  assert.equal(aggregate.failureTaxonomy, null);
  assert.equal(aggregate.succeeded, 74);
});

test("a clean run publishes no taxonomy section", () => {
  const aggregate = publicFeaturedScanSummary(summaryFor([], { succeeded: 81 }));
  const report = buildFeaturedRefreshIssueReport({
    failed: false,
    summary: aggregate,
    branch: "main",
    serverUrl: "https://github.com",
    repository: "iAnonymous3000/site-behavior-lab",
    runId: "1",
    catalogSlug: "gallery"
  });
  assert.doesNotMatch(report, /Which kind of red/);
});

/**
 * The health gate judges the scanner, not the sites (owner decision
 * 2026-09-28). The 2026-09-28 gallery leg read 59/81 against an 80% gate while
 * 21 of its 22 failures were sites refusing an undisguised browser, so the
 * canonical issue told an operator to debug a scanner that had failed once.
 *
 * Every fixture below is driven through the classifier with the producer's
 * real sentences on synthetic hosts, and through BOTH halves of the gate: the
 * runner's exit verdict and the trusted publication decision that re-derives
 * health from the summary the runner wrote. Pre-sorted counts would let the two
 * halves pass while disagreeing about what a refusal is.
 */
const REFUSAL_OUTCOMES = PRODUCER_OUTCOMES.filter(([, , kind]) => kind === "target-refused");
const refusal = (index) => {
  const [sentence, unavailableReason] = REFUSAL_OUTCOMES[index % REFUSAL_OUTCOMES.length];
  return {
    site: `refused-${index}.example`,
    message: `Skipping scan target: primary baseline arm: ${sentence}.`,
    unavailableReason
  };
};
const unverifiedSubject = (index) => ({
  site: `unverified-${index}.example`,
  message: "Skipping scan target: primary baseline arm: report could not verify the rendered page subject.",
  unavailableReason: "navigation-incomplete"
});
const scannerTimeout = (index) => ({
  site: `timeout-${index}.example`,
  message: "The scan exceeded the maximum scan duration.",
  unavailableReason: null
});
const unrecognized = (index) => ({
  site: `unrecognized-${index}.example`,
  message: "something nobody has seen",
  unavailableReason: null
});
const times = (count, make) => Array.from({ length: count }, (_, index) => make(index));

function batch({ succeeded, failures, minSuccessRate = 0.8, fullCatalog = true, deferred = 0, catalogSlug = "gallery" }) {
  const total = succeeded + failures.length;
  // The same call main() makes once its scans finish, so the verdict and the
  // summary below are main's, not two values this fixture copied between.
  const { verdict, summary } = featuredBatchOutcome({
    catalogSlug,
    sites: times(total, (index) => ({ domain: `site-${index}.example` })),
    unavailable: times(deferred, (index) => ({
      site: `deferred-${index}.example`,
      reason: "automation-blocked",
      observedAt: "2026-09-21",
      reviewAfter: "2026-10-19"
    })),
    catalogTotal: total + deferred,
    catalogVersion: fullCatalog ? 2 : null,
    fullCatalog,
    eligibility: featuredCatalogEligibility(total + deferred, total),
    succeeded,
    failures,
    scanResults: [],
    retried: 0,
    minSuccessRate
  });
  return {
    verdict,
    summary,
    aggregate: publicFeaturedScanSummary(summary),
    // Judged on its own, with a clean scan outcome, so it cannot simply echo
    // the runner's exit code back.
    decision: featuredPublicationDecision(summary, "success")
  };
}

const issueFor = (aggregate, failed, catalogSlug = "gallery") =>
  buildFeaturedRefreshIssueReport({
    failed,
    summary: aggregate,
    branch: "main",
    serverUrl: "https://github.com",
    repository: "iAnonymous3000/site-behavior-lab",
    runId: "1",
    catalogSlug
  });

const TODAYS_GALLERY = () => ({ succeeded: 59, failures: [...times(21, refusal), unverifiedSubject(0)] });

test("the 2026-09-28 gallery shape passes: refusals leave the denominator, the unverified subject stays", () => {
  const run = batch(TODAYS_GALLERY());
  assert.equal(run.aggregate.successRate < 0.8, true, "the raw rate is still the 73% that used to turn it red");
  assert.equal(run.verdict.health.refused, 21);
  assert.equal(run.verdict.health.scannerJudged, 60, "the one unverified subject stays in the denominator");
  assert.equal(run.verdict.health.scannerSuccessRate, 59 / 60);
  assert.equal(run.verdict.health.refusalRate, 21 / 81);
  assert.deepEqual(run.verdict.reasons, []);
  assert.deepEqual(run.decision, { publishable: true, healthy: true });

  // The alerting job projects the classify step's projection a second time.
  // Anything the round trip loses would be judged as a missing taxonomy there.
  assert.deepEqual(publicFeaturedScanSummary(JSON.parse(JSON.stringify(run.aggregate))), run.aggregate);
});

test("refusals past the 35% ceiling fail with the curation message even when the scanner is flawless", () => {
  assert.equal(FEATURED_REFUSAL_CEILING, 0.35);

  // Seven of twenty is exactly 35%: at the ceiling, not past it.
  const atCeiling = batch({ succeeded: 13, failures: times(7, refusal), fullCatalog: false });
  assert.deepEqual(atCeiling.verdict.reasons, []);
  assert.equal(atCeiling.decision.healthy, true);

  const overCeiling = batch({ succeeded: 12, failures: times(8, refusal), fullCatalog: false });
  assert.equal(overCeiling.verdict.health.scannerSuccessRate, 1, "every target it could be judged on succeeded");
  assert.equal(overCeiling.verdict.reasons.length, 1, "only the ceiling fails");
  assert.match(
    overCeiling.verdict.reasons[0],
    /^8 of 20 eligible targets \(40%\) refused an automated visit, above the fixed 35% ceiling\. The catalog needs curation/
  );
  assert.equal(overCeiling.decision.healthy, false);

  // At gallery scale the line falls between 28 and 29 of 81.
  assert.equal(batch({ succeeded: 53, failures: times(28, refusal) }).decision.healthy, true);
  const decayed = batch({ succeeded: 52, failures: times(29, refusal) });
  assert.equal(decayed.decision.healthy, false);
  assert.match(decayed.verdict.reasons[0], /29 of 81 eligible targets \(36%\)[\s\S]*catalog needs curation/);

  // The issue carries the same sentence, and does not blame the scanner.
  const report = issueFor(decayed.aggregate, true);
  assert.ok(report.includes(decayed.verdict.reasons[0]));
  assert.doesNotMatch(report, /The scanner succeeded on/);
});

/**
 * The seed list is version 1 and carries no `scanAvailability` metadata, and
 * a deferral added to it as written stops its next run before any scan. Its
 * curation advice therefore cannot be the gallery's "defer or replace", and
 * the console, the step summary and the issue for one run must all give the
 * advice for the catalog that run walked.
 */
test("the curation message gives each catalog advice it can follow", () => {
  const cases = [
    ["gallery", /The catalog needs curation: defer or replace the refusing entries rather than changing the scanner\. If the rise/],
    [
      "seed",
      /The catalog needs curation: replace the refusing entries rather than changing the scanner\. The seed list takes no deferrals: a scanAvailability entry stops its next run before any scan unless the list first moves to version 2\. If the rise/
    ]
  ];
  for (const [catalogSlug, advice] of cases) {
    const run = batch({ succeeded: 12, failures: times(8, refusal), fullCatalog: false, catalogSlug });
    assert.equal(run.verdict.reasons.length, 1, catalogSlug);
    assert.match(run.verdict.reasons[0], advice, catalogSlug);
    assert.ok(issueFor(run.aggregate, true, catalogSlug).includes(run.verdict.reasons[0]), `${catalogSlug} issue`);
    assert.ok(
      featuredStepSummaryLines(run.summary, catalogSlug).join("\n").includes(run.verdict.reasons[0]),
      `${catalogSlug} step summary`
    );
  }
  const seed = batch({ succeeded: 12, failures: times(8, refusal), fullCatalog: false, catalogSlug: "seed" });
  assert.doesNotMatch(issueFor(seed.aggregate, true, "seed"), /defer or replace/);

  // Required, not defaulted: a caller that forgot the catalog would otherwise
  // hand the seed leg the gallery's advice.
  assert.throws(() => batch({ succeeded: 12, failures: times(8, refusal), catalogSlug: null }), /catalog slug/);
  assert.throws(() => featuredStepSummaryLines(seed.summary), /catalog slug/);
});

test("the seed list's advice rests on the catalog it describes", () => {
  // The reviewer's probe, in memory: one deferral added to the committed seed
  // list refuses the run before any scan. If the list ever moves to version 2
  // this passes the other way, and the seed wording above must change with it.
  const seedList = JSON.parse(readFileSync(new URL("../public/corpus-seed-sites.json", import.meta.url), "utf8"));
  assert.equal(seedList.sites.some((site) => site.scanAvailability !== undefined), false);
  const environment = { FEATURED_SITES_FILE: "public/corpus-seed-sites.json" };
  const deferral = {
    status: "temporarily-unavailable",
    reason: "automation-blocked",
    observedAt: "2026-09-28",
    reviewAfter: "2026-10-26",
    workflowRunIds: ["100000001", "100000002"]
  };
  const deferred = (version) => ({
    ...seedList,
    version,
    sites: seedList.sites.map((site, index) => (index === 0 ? { ...site, scanAvailability: deferral } : site))
  });
  assert.throws(
    () => selectSites(deferred(seedList.version), environment, "2026-09-28"),
    /must use an integer version of 2 or newer/
  );
  assert.equal(selectSites(deferred(2), environment, "2026-09-28").unavailable.length, 1);
});

test("scanner failures past the gate still fail with zero refusals, and refusals never dilute them", () => {
  const scannerFailures = [...times(9, unverifiedSubject), ...times(4, scannerTimeout), ...times(4, unrecognized)];
  const run = batch({ succeeded: 64, failures: scannerFailures });
  assert.equal(run.verdict.health.refused, 0);
  assert.equal(run.verdict.health.scannerJudged, 81);
  assert.equal(run.verdict.reasons.length, 1, "only the scanner gate fails");
  assert.equal(
    run.verdict.reasons[0],
    "The scanner succeeded on 64 of the 81 eligible targets that did not refuse an automated visit (79%), below the required 80%."
  );
  assert.equal(run.decision.healthy, false);
  assert.ok(issueFor(run.aggregate, true).includes(run.verdict.reasons[0]));
  assert.doesNotMatch(issueFor(run.aggregate, true), /catalog needs curation/);

  // One more success clears it: 65 of 81 is 80.2%.
  assert.equal(batch({ succeeded: 65, failures: scannerFailures.slice(1) }).decision.healthy, true);

  // With refusals present, the scanner is judged on what is left: 47 of the
  // 60 non-refusing targets is 78%, however healthy 21 refusals of 81 look.
  const mixed = batch({ succeeded: 47, failures: [...times(21, refusal), ...times(13, unverifiedSubject)] });
  assert.equal(mixed.verdict.health.scannerJudged, 60);
  assert.equal(mixed.verdict.health.meetsRefusalCeiling, true);
  assert.equal(mixed.verdict.health.meetsSuccessRate, false);
  assert.deepEqual(mixed.verdict.reasons, [
    "The scanner succeeded on 47 of the 60 eligible targets that did not refuse an automated visit (78%), below the required 80%."
  ]);
  assert.equal(mixed.decision.healthy, false);

  // A batch with no success is never healthy, whatever rate it is held to.
  const nothing = featuredBatchHealth({ total: 5, succeeded: 0, failed: 5, failureTaxonomy: null, requiredSuccessRate: 0 });
  assert.equal(nothing.meetsSuccessRate, false);
});

test("the scanner's own control-plane failures stay in the denominator", async () => {
  // 17 status-route 429s and 4 real refusals of 81: excusing the 429s as
  // refusals read this as 60 of 60, green, and published our own rate limit
  // among the sites refusing an automated visit.
  const message = await statusRouteFailure(429);
  const statusRoute = times(17, (index) => ({ site: `status-${index}.example`, message, unavailableReason: null }));
  const run = batch({ succeeded: 60, failures: [...statusRoute, ...times(4, refusal)] });
  assert.equal(run.verdict.health.refused, 4);
  assert.equal(run.verdict.health.scannerJudged, 77);
  assert.deepEqual(run.verdict.reasons, [
    "The scanner succeeded on 60 of the 77 eligible targets that did not refuse an automated visit (78%), below the required 80%."
  ]);
  assert.equal(run.decision.healthy, false);
  assert.match(issueFor(run.aggregate, true), /17 are attributable to this scanner/);
});

test("a summary that lost its taxonomy holds every failure against the scanner", () => {
  const run = batch(TODAYS_GALLERY());

  const stripped = { ...run.summary };
  delete stripped.failureTaxonomy;
  const aggregate = publicFeaturedScanSummary(stripped);
  assert.equal(aggregate.refusalsCounted, false);
  assert.equal(aggregate.refused, 0);
  assert.equal(aggregate.scannerJudged, 81);
  assert.deepEqual(featuredPublicationDecision(stripped, "success"), { publishable: true, healthy: false });
  const report = issueFor(aggregate, true);
  assert.match(report, /Refusals could not be counted, so every failure is held against the scanner/);
  assert.ok(
    report.includes(
      "The scanner succeeded on 59 of the 81 eligible targets it was judged on, with no refusal excused (73%), below the required 80%."
    ),
    "an uncounted run must not claim its denominator excludes refusals"
  );

  // A taxonomy that does not add up to the failures is no better than none.
  const contradicting = {
    ...run.summary,
    failureTaxonomy: [
      { kind: "target-refused", count: 22 },
      { kind: "subject-unverified", count: 1 }
    ]
  };
  assert.equal(publicFeaturedScanSummary(contradicting).refusalsCounted, false);
  assert.equal(featuredPublicationDecision(contradicting, "success").healthy, false);

  // A clean batch has nothing to count, so nothing is missing.
  assert.equal(batch({ succeeded: 81, failures: [] }).aggregate.refusalsCounted, true);
  assert.doesNotMatch(issueFor(batch({ succeeded: 81, failures: [] }).aggregate, false), /could not be counted/);
});

/**
 * `batch()` runs featuredBatchOutcome, the function main() takes both its exit
 * verdict and its written summary from, so agreement here is agreement in the
 * runner's own wiring. The fixtures sit on both sides of each threshold,
 * including a raised required rate and a run with deferred entries, where a
 * summary handed a different rate, total or taxonomy than the verdict would
 * flip one side. That main() then writes this summary and exits on this verdict
 * is guarded only by the source pin in the next test.
 */
test("the runner's exit verdict and the trusted publication decision agree", () => {
  const fixtures = [
    { ...TODAYS_GALLERY(), healthy: true },
    { succeeded: 13, failures: times(7, refusal), fullCatalog: false, healthy: true },
    { succeeded: 12, failures: times(8, refusal), fullCatalog: false, healthy: false },
    { succeeded: 53, failures: times(28, refusal), healthy: true },
    { succeeded: 52, failures: times(29, refusal), healthy: false },
    { succeeded: 64, failures: [...times(9, unverifiedSubject), ...times(8, scannerTimeout)], healthy: false },
    { succeeded: 47, failures: [...times(21, refusal), ...times(13, unverifiedSubject)], healthy: false },
    { succeeded: 0, failures: times(81, refusal), healthy: false },
    { succeeded: 0, failures: times(81, scannerTimeout), healthy: false },
    // A raised required rate, straddled: 73 of 81 is 90.1% and 72 of 81 is 88.9%.
    { succeeded: 73, failures: times(8, scannerTimeout), minSuccessRate: 0.9, healthy: true },
    { succeeded: 72, failures: times(9, scannerTimeout), minSuccessRate: 0.9, healthy: false },
    // Exactly 90% only once the 21 refusals leave the denominator: 54 of 60.
    { succeeded: 54, failures: [...times(21, refusal), ...times(6, scannerTimeout)], minSuccessRate: 0.9, healthy: true },
    // Deferred entries are not eligible targets: 29 refusals are 36% of the 81
    // scanned, and would read as 34% of an 85-entry catalog.
    { ...TODAYS_GALLERY(), deferred: 4, healthy: true },
    { succeeded: 52, failures: times(29, refusal), deferred: 4, healthy: false },
    // The de-bias seed leg's recent shape: same gate, no coverage floor.
    { succeeded: 37, failures: [...times(6, refusal), ...times(2, scannerTimeout)], fullCatalog: false, healthy: true }
  ];
  for (const fixture of fixtures) {
    const run = batch(fixture);
    const label = `${fixture.succeeded}/${fixture.succeeded + fixture.failures.length} at ${fixture.minSuccessRate ?? 0.8}`;
    assert.notEqual(run.aggregate, null, `${label}: main's summary must survive its own projection`);
    assert.deepEqual(run.aggregate.failureTaxonomy, run.verdict.failureTaxonomy, `${label}: one taxonomy`);
    assert.equal(run.verdict.reasons.length === 0, run.decision.healthy, `${label}: exit code and health disagree`);
    assert.equal(run.decision.healthy, fixture.healthy, `${label}: healthy`);
  }
});

test("the issue and the step summary state every gate beside its threshold", () => {
  const run = batch(TODAYS_GALLERY());
  const report = issueFor(run.aggregate, false);
  const step = featuredStepSummaryLines(run.summary, "gallery").join("\n");
  for (const [name, text] of [["issue", report], ["step summary", step]]) {
    assert.match(text, /Eligible scan success \(context, not a gate\): \*\*59\/81\*\* \(73%\)/, name);
    assert.match(text, /Scanner success, excluding sites that refused an automated visit: \*\*59\/60\*\* \(98%\)/, name);
    assert.match(text, /Required scanner success rate: \*\*80%\*\*/, name);
    assert.match(text, /Eligible targets that refused an automated visit: \*\*21\/81\*\* \(26%\)/, name);
    assert.match(text, /Fixed refusal ceiling: \*\*35% of eligible targets\*\*/, name);
    assert.match(text, /Active eligible catalog coverage: \*\*81\/81\*\* \(100%\)/, name);
    assert.match(text, /Fixed full-catalog coverage gate: \*\*80% and at least 50 active sites\*\*/, name);
  }
  // The step summary is private and lists targets; the public issue never does.
  assert.ok(step.includes("refused-0.example"));
  for (const failure of run.summary.failures) {
    assert.ok(!report.includes(failure.site), `${failure.site} must not reach the public issue`);
  }
});

test("the runner exits on the shared verdict, not on a rate of its own", () => {
  // main() scans real sites and cannot run here. featuredBatchOutcome is
  // exercised above; this pins that main takes its verdict and its written
  // summary from that one call and from nothing else.
  const runner = readFileSync(new URL("./run-featured-scans.mjs", import.meta.url), "utf8");
  const start = runner.indexOf("async function main(");
  assert.ok(start >= 0);
  const main = runner.slice(start, runner.indexOf("\n}\n", start));
  assert.match(main, /const catalogSlug = featuredRefreshCatalogSlug\(process\.env\);/);
  assert.match(main, /const \{ verdict, summary \} = featuredBatchOutcome\(\{\n    catalogSlug,\n/);
  assert.match(main, /await publishRunDiagnostics\(summary, catalogSlug\);/);
  assert.doesNotMatch(main, /featuredBatchVerdict\(|buildFeaturedRunSummary\(|featuredBatchHealth\(/);
  const gate = main.indexOf("  if (verdict.reasons.length > 0) {\n");
  assert.ok(gate > 0, "main gates on the verdict's reasons");
  assert.match(main.slice(gate), /process\.exit\(1\);\n  \}$/);
  assert.doesNotMatch(runner, /successRate < minSuccessRate/);
  assert.doesNotMatch(runner, /taxonomy\.get\("target-refused"\)/);
});

test("the public summary carries every kind within its cross-job byte bound", () => {
  // Mirrors MAX_PUBLIC_SUMMARY_BYTES in the diagnostics module; the classify
  // step throws past it, which would cost the run its whole public summary.
  const run = batch({
    succeeded: 50,
    failures: [...times(20, refusal), ...times(4, scannerTimeout), ...times(4, unverifiedSubject), ...times(3, unrecognized)]
  });
  assert.equal(run.aggregate.failureTaxonomy.length, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(run.aggregate), "utf8") <= 4 * 1024);
});
