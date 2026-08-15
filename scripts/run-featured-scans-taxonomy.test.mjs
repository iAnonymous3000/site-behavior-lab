import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFeaturedFailures } from "./run-featured-scans.mjs";
import {
  buildFeaturedRefreshIssueReport,
  publicFailureTaxonomy,
  publicFeaturedScanSummary,
  summarizeFailureTaxonomy,
  UNAMBIGUOUS_TARGET_REFUSALS
} from "./run-featured-scans-diagnostics.mjs";
import { FEATURED_READJUDICATION_REASONS } from "./featured-readjudication-lib.mjs";

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
  // It names the parts; it must never alter the denominator or the rate. A
  // classifier that drops or duplicates a failure would move the gate it exists
  // to explain.
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
