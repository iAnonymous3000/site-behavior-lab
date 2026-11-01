import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTURE_LOSS_DETAIL_CONTRACT,
  captureLossDetailAllowsFamily,
  isKnownCaptureLossDetail
} from "./capture-loss-detail-contract";
import {
  DETECTOR_OBLIGATION_CONTRACT_VERSION,
  DETECTOR_OBLIGATION_REGISTRY,
  HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION,
  HISTORICAL_DETECTOR_OBLIGATION_REGISTRY,
  HISTORICAL_V2_DETECTOR_OBLIGATION_CONTRACT_VERSION,
  HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY,
  type DetectorObligationRule
} from "./detector-obligations";
import { assertCaughtBy, holds, loadVariant, type SourceEdit } from "./finite-check";
import { METRIC_EVIDENCE_SOURCES } from "./metric-evidence-sources";
import {
  EVIDENCE_FAMILIES,
  METRIC_FAMILIES,
  type CaptureLossEntry,
  type Comparability,
  type EvidenceFamily,
  type QualityFacts,
  type ScanRunV2
} from "./scan-report-v2";
import { evaluateComparability, evaluateQuality } from "./scan-report-v2-evaluators";
import {
  makeDescriptiveComparisonReportV2,
  makeInterventionComparisonReportV2,
  makeTemporalComparisonReportV2
} from "./scan-report-v2-fixtures";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";
import { evaluateComparabilityR2 } from "./scan-report-v2-r2-evaluators";
import {
  makeConsentInterventionReportV2R2,
  makeDescriptiveReportV2R2,
  makeGpcInterventionReportV2R2,
  makeShieldsInterventionReportV2R2,
  makeTemporalReportV2R2
} from "./scan-report-v2-r2-fixtures";

/**
 * CL1, CL2 and CL4: how recorded capture loss reaches what a report may claim.
 *
 * Each holds for all inputs in the stated domain at this commit. None says that
 * capture loss was recorded when it should have been: whether a real visit lost
 * evidence is a measurement, and the readout's own accounting is CL7 and CL8.
 */

const LOSS_KINDS: readonly CaptureLossEntry["kind"][] = ["dropped", "clipped", "truncated", "timeout", "cap"];
const DETAILS = Object.keys(CAPTURE_LOSS_DETAIL_CONTRACT) as (keyof typeof CAPTURE_LOSS_DETAIL_CONTRACT)[];

function facts(captureLoss: CaptureLossEntry[]): QualityFacts {
  return { status: 200, botWallTitleMatched: false, navigationSettled: true, budgetsExhausted: [], captureLoss };
}

function entriesForDetail(detail: (typeof DETAILS)[number]): CaptureLossEntry[] {
  return (CAPTURE_LOSS_DETAIL_CONTRACT[detail].families as readonly EvidenceFamily[]).map((family) => ({
    family,
    phaseId: null,
    kind: "dropped",
    count: 1,
    detail
  }));
}

type EvaluateQuality = typeof evaluateQuality;
type EvaluateComparability = (
  experiment: never,
  baseline: never,
  variant: never
) => Comparability;

function checkFamilySubsets(evaluate: EvaluateQuality): number {
  let cases = 0;
  for (let subset = 0; subset < 1 << EVIDENCE_FAMILIES.length; subset += 1) {
    for (const kind of LOSS_KINDS) {
      cases += 1;
      const named = EVIDENCE_FAMILIES.filter((_, index) => (subset & (1 << index)) !== 0);
      const quality = evaluate(
        facts(named.map((family) => ({ family, phaseId: null, kind, count: 1 }))),
        { observedRequests: 1 }
      );
      for (const family of EVIDENCE_FAMILIES) {
        const lost = named.includes(family);
        const input = () => ({ named, kind, family });
        holds("censored-iff-a-loss-names-the-family", (quality.byFamily[family].outcome === "censored") === lost, input);
        holds(
          "censoring-names-the-loss-kind",
          JSON.stringify(quality.byFamily[family].reasons) === JSON.stringify(lost ? [`capture-loss:${kind}`] : []),
          input
        );
      }
    }
  }
  return cases;
}

/** How many add-one steps a walk over subsets of up to `size` of `count` details takes. */
function addOneSteps(count: number, size: number): number {
  let steps = 0;
  let subsets = 1;
  for (let taken = 0; taken <= size; taken += 1) {
    steps += subsets * (count - taken);
    subsets = (subsets * (count - taken)) / (taken + 1);
  }
  return steps;
}

function walkSubsets(size: number, visit: (subset: readonly number[], added: number) => void): void {
  const walk = (subset: number[], from: number) => {
    for (let added = 0; added < DETAILS.length; added += 1) {
      if (!subset.includes(added)) visit(subset, added);
    }
    if (subset.length === size) return;
    for (let next = from; next < DETAILS.length; next += 1) walk([...subset, next], next + 1);
  };
  walk([], 0);
}

/**
 * A family named by any entry stays censored however many more arrive, because a
 * superset names every family its subset names. So holding the equivalence at every
 * subset is the monotonicity: a separate before-and-after comparison would add nothing.
 */
function checkDetailSubsets(evaluate: EvaluateQuality): number {
  let cases = 0;
  const entries = DETAILS.map(entriesForDetail);
  walkSubsets(3, (subset, added) => {
    cases += 1;
    const after = [...subset, added].flatMap((index) => entries[index]);
    const quality = evaluate(facts(after), { observedRequests: 1 });
    for (const family of EVIDENCE_FAMILIES) {
      holds(
        "censored-iff-a-loss-names-the-family",
        (quality.byFamily[family].outcome === "censored") === after.some((entry) => entry.family === family),
        () => ({ subset: subset.map((index) => DETAILS[index]), added: DETAILS[added], family })
      );
    }
  });
  return cases;
}

/** Entries of mixed kinds in one family, in either order: the reasons name each kind once, sorted. */
function checkMixedKinds(evaluate: EvaluateQuality): number {
  let cases = 0;
  for (const family of EVIDENCE_FAMILIES) {
    for (let subset = 1; subset < 1 << LOSS_KINDS.length; subset += 1) {
      const kinds = LOSS_KINDS.filter((_, index) => (subset & (1 << index)) !== 0);
      const expected = kinds.map((kind) => `capture-loss:${kind}`).sort();
      for (const ordered of [kinds, [...kinds].reverse()]) {
        cases += 1;
        const quality = evaluate(facts(ordered.map((kind) => ({ family, phaseId: null, kind, count: 1 }))), { observedRequests: 1 });
        holds("family-reasons-name-every-kind", JSON.stringify(quality.byFamily[family].reasons) === JSON.stringify(expected), () => ({ family, ordered }));
      }
    }
  }
  return cases;
}

/** Every fact that can fail a run or add a run reason on its own, crossed with loss. */
const RUN_BASES: readonly Omit<QualityFacts, "captureLoss">[] = [200, 404, null].flatMap((status) =>
  [false, true].flatMap((botWallTitleMatched) =>
    [true, false].flatMap((navigationSettled) =>
      [[], ["request-capture"]].map((budgetsExhausted) => ({ status, botWallTitleMatched, navigationSettled, budgetsExhausted }))
    )
  )
);

/**
 * More loss never clears what already failed a run. The one exception is an empty
 * load: with nothing observed and nothing recorded lost, the run failed as empty, and
 * a recorded request loss explains that. A loss that fails the run itself replaces it.
 */
function checkRunFailures(evaluate: EvaluateQuality): number {
  let cases = 0;
  const entries = DETAILS.map(entriesForDetail);
  for (const base of RUN_BASES) {
    for (const observedRequests of [0, 1]) {
      walkSubsets(1, (subset, added) => {
        cases += 1;
        const beforeEntries = subset.flatMap((index) => entries[index]);
        const afterEntries = [...beforeEntries, ...entries[added]];
        const before = evaluate({ ...base, captureLoss: beforeEntries }, { observedRequests });
        const after = evaluate({ ...base, captureLoss: afterEntries }, { observedRequests });
        const input = () => ({ base, observedRequests, subset: subset.map((index) => DETAILS[index]), added: DETAILS[added] });
        holds(
          "more-loss-never-clears-a-run-failure",
          before.run.reasons.every((reason) => reason === "empty-load" || after.run.reasons.includes(reason)),
          input
        );
        holds(
          "only-a-request-loss-explains-an-empty-load",
          !(before.run.outcome === "failed" && after.run.outcome === "complete") ||
            (JSON.stringify(before.run.reasons.filter((reason) => !reason.startsWith("budget-exhausted:"))) === '["empty-load"]' &&
              afterEntries.some((entry) => entry.family === "requests")),
          input
        );
      });
    }
  }
  return cases;
}

const evaluatorsPath = require.resolve("./scan-report-v2-evaluators");
const evaluatorVariant = (...edits: SourceEdit[]) =>
  loadVariant<{ evaluateQuality: EvaluateQuality; evaluateComparability: EvaluateComparability }>(evaluatorsPath, edits);

test("CL1: a family is censored exactly when a recorded loss names it, over every family subset and kind", () => {
  assert.equal(EVIDENCE_FAMILIES.length, 6);
  assert.equal(checkFamilySubsets(evaluateQuality), 64 * LOSS_KINDS.length);
});

test("CL1: more loss never uncensors, over subsets of up to 3 contract details plus one", () => {
  assert.ok(DETAILS.length >= 37, "the capture-loss contract only grows");
  assert.equal(checkDetailSubsets(evaluateQuality), addOneSteps(DETAILS.length, 3));
});

test("CL1: a family's reasons name every kind of loss it holds, once, in any order", () => {
  assert.equal(checkMixedKinds(evaluateQuality), EVIDENCE_FAMILIES.length * 31 * 2);
});

test("CL1: more loss never clears a run failure, over every run fact crossed with up to 2 details", () => {
  assert.equal(RUN_BASES.length, 24);
  assert.equal(checkRunFailures(evaluateQuality), RUN_BASES.length * 2 * addOneSteps(DETAILS.length, 1));
});

test("CL1 carve-out: a run's outcome alone is not monotone, because a request loss explains an empty load", () => {
  // With nothing observed and nothing recorded lost, the run failed as an empty
  // load. A recorded request loss removes that one reason. No other loss can move
  // the run to complete, and a request detail that fails the run itself keeps it failed.
  assert.deepEqual(evaluateQuality(facts([]), { observedRequests: 0 }).run, { outcome: "failed", reasons: ["empty-load"] });
  const movedToComplete: string[] = [];
  const requestDetails: string[] = [];
  for (const detail of DETAILS) {
    const entries = entriesForDetail(detail);
    const after = evaluateQuality(facts(entries), { observedRequests: 0 });
    if (entries.some((entry) => entry.family === "requests")) {
      requestDetails.push(detail);
      assert.ok(!after.run.reasons.includes("empty-load"), detail);
    }
    if (after.run.outcome === "complete") movedToComplete.push(detail);
  }
  assert.deepEqual(
    movedToComplete,
    requestDetails.filter((detail) => detail !== R2_NAVIGATION_STATUS_UNREPRESENTABLE)
  );
  assert.ok(movedToComplete.length > 0);
});

for (const [name, property, edit] of [
  [
    "one loss no longer censors",
    "censored-iff-a-loss-names-the-family",
    { find: 'outcome: losses.length > 0 ? "censored" : "complete"', replace: 'outcome: losses.length > 1 ? "censored" : "complete"' }
  ],
  [
    "a family is censored by another family's loss",
    "censored-iff-a-loss-names-the-family",
    { find: "const losses = facts.captureLoss.filter((entry) => entry.family === family);", replace: "const losses = facts.captureLoss;" }
  ],
  [
    "the censoring reason stops naming the kind",
    "censoring-names-the-loss-kind",
    { find: "`capture-loss:${entry.kind}`", replace: "`capture-loss:dropped`" }
  ]
] as const) {
  test(`CL1 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkFamilySubsets(evaluatorVariant(edit).evaluateQuality));
  });
}

test("CL1 catches a variant: a third loss uncensors", async () => {
  const uncensors = evaluatorVariant({
    find: 'outcome: losses.length > 0 ? "censored" : "complete"',
    replace: 'outcome: losses.length > 0 && losses.length < 3 ? "censored" : "complete"'
  });
  await assertCaughtBy("a third loss uncensors", "censored-iff-a-loss-names-the-family", () => checkDetailSubsets(uncensors.evaluateQuality));
});

test("CL1 catches a variant: only the first kind of loss is named", async () => {
  const firstOnly = evaluatorVariant({ find: "new Set(losses.map(", replace: "new Set(losses.slice(0, 1).map(" });
  await assertCaughtBy("only the first kind is named", "family-reasons-name-every-kind", () => checkMixedKinds(firstOnly.evaluateQuality));
});

for (const [name, property, find, replace] of [
  [
    "a request loss clears a bot wall",
    "more-loss-never-clears-a-run-failure",
    "if (facts.botWallTitleMatched)",
    'if (facts.botWallTitleMatched && !facts.captureLoss.some((entry) => entry.family === "requests"))'
  ],
  [
    "any loss clears a navigation that never settled",
    "more-loss-never-clears-a-run-failure",
    "if (!facts.navigationSettled)",
    "if (!facts.navigationSettled && facts.captureLoss.length === 0)"
  ],
  [
    "any loss clears an error status",
    "more-loss-never-clears-a-run-failure",
    "if ((facts.status !== null && facts.status >= 400) || unrepresentableNavigationStatus) {",
    "if ((facts.status !== null && facts.status >= 400 && facts.captureLoss.length === 0) || unrepresentableNavigationStatus) {"
  ],
  [
    "any loss hides an exhausted budget",
    "more-loss-never-clears-a-run-failure",
    "for (const budget of [...facts.budgetsExhausted].sort()) {",
    "for (const budget of facts.captureLoss.length > 0 ? [] : [...facts.budgetsExhausted].sort()) {"
  ],
  [
    "any loss explains an empty load",
    "only-a-request-loss-explains-an-empty-load",
    'const requestLossRecorded = facts.captureLoss.some((entry) => entry.family === "requests");',
    "const requestLossRecorded = facts.captureLoss.length > 0;"
  ]
] as const) {
  test(`CL1 catches a variant: ${name}`, async () => {
    await assertCaughtBy(name, property, () => checkRunFailures(evaluatorVariant({ find, replace }).evaluateQuality));
  });
}

type Pair = { label: string; evaluate: EvaluateComparability; experiment: unknown; baseline: ScanRunV2; variant: ScanRunV2 };

function pairsV2(evaluate: EvaluateComparability): Pair[] {
  return [makeInterventionComparisonReportV2(), makeTemporalComparisonReportV2(), makeDescriptiveComparisonReportV2()].map(
    (report) => ({
      label: report.experiment.kind,
      evaluate,
      experiment: report.experiment,
      baseline: structuredClone(report.baseline),
      variant: structuredClone(report.variant)
    })
  );
}

function pairsR2(): Pair[] {
  return [
    makeGpcInterventionReportV2R2(),
    makeShieldsInterventionReportV2R2(),
    makeConsentInterventionReportV2R2(),
    makeTemporalReportV2R2(),
    makeDescriptiveReportV2R2()
  ].map((report) => ({
    label: `r2-${report.experiment.kind}-${"axis" in report.experiment ? report.experiment.axis : "none"}`,
    evaluate: evaluateComparabilityR2 as unknown as EvaluateComparability,
    experiment: report.experiment,
    baseline: structuredClone(report.baseline) as unknown as ScanRunV2,
    variant: structuredClone(report.variant) as unknown as ScanRunV2
  }));
}

function applyCensoring(run: ScanRunV2, pattern: number): void {
  EVIDENCE_FAMILIES.forEach((family, index) => {
    run.quality.byFamily[family].outcome = (pattern & (1 << index)) !== 0 ? "censored" : "complete";
  });
}

/**
 * Spelled out, not read from METRIC_EVIDENCE_SOURCES: the evaluator reads that table,
 * so a check against it could not tell if a metric lost one of its sources.
 */
const SOURCES_OF_METRIC: Readonly<Record<(typeof METRIC_FAMILIES)[number], readonly EvidenceFamily[]>> = {
  "raw-counts": ["requests", "cookies", "storage"],
  "tracker-classification": ["requests"],
  "shields-simulation": ["requests"],
  "consent-verification": ["consent-verification"],
  "detector-findings": ["requests", "fingerprinting", "detector-output"]
};

function censoredBy(family: (typeof METRIC_FAMILIES)[number], pattern: number): boolean {
  return SOURCES_OF_METRIC[family].some((source) => (pattern & (1 << EVIDENCE_FAMILIES.indexOf(source))) !== 0);
}

function checkCensoringBlocksMetrics(pair: Pair): number {
  let cases = 0;
  const evaluate = (baselinePattern: number, variantPattern: number) => {
    applyCensoring(pair.baseline, baselinePattern);
    applyCensoring(pair.variant, variantPattern);
    return pair.evaluate(pair.experiment as never, pair.baseline as never, pair.variant as never);
  };
  const uncensored = evaluate(0, 0);
  const patterns = 1 << EVIDENCE_FAMILIES.length;
  for (let baselinePattern = 0; baselinePattern < patterns; baselinePattern += 1) {
    for (let variantPattern = 0; variantPattern < patterns; variantPattern += 1) {
      const comparability = evaluate(baselinePattern, variantPattern);
      for (const family of METRIC_FAMILIES) {
        cases += 1;
        const { eligible, reasons } = comparability.perMetric[family];
        const input = () => ({ pair: pair.label, family, baselinePattern, variantPattern, reasons });
        holds(
          "censored-baseline-source-blocks-the-metric",
          reasons.includes("family-censored:baseline") === censoredBy(family, baselinePattern),
          input
        );
        holds(
          "censored-variant-source-blocks-the-metric",
          reasons.includes("family-censored:variant") === censoredBy(family, variantPattern),
          input
        );
        const others = reasons.filter((reason) => reason !== "family-censored:baseline" && reason !== "family-censored:variant");
        holds(
          "censoring-adds-no-other-reason",
          JSON.stringify(others) === JSON.stringify(uncensored.perMetric[family].reasons),
          input
        );
        holds("a-metric-is-eligible-only-with-no-reason", eligible === (reasons.length === 0), input);
      }
    }
  }
  return cases;
}

test("CL2: every metric is blocked exactly by its own censored sources, over every pair of censoring patterns", () => {
  const pairs = [...pairsV2(evaluateComparability as unknown as EvaluateComparability), ...pairsR2()];
  assert.equal(pairs.length, 8);
  assert.equal(METRIC_FAMILIES.length, 5);
  assert.deepEqual(METRIC_EVIDENCE_SOURCES, SOURCES_OF_METRIC);
  for (const pair of pairs) {
    assert.equal(checkCensoringBlocksMetrics(pair), 64 * 64 * METRIC_FAMILIES.length, pair.label);
  }
});

for (const [name, property, edit] of [
  [
    "the variant arm's censoring is ignored",
    "censored-variant-source-blocks-the-metric",
    { find: 'reasons.push("family-censored:variant");', replace: ";" }
  ],
  [
    "the baseline arm's censoring is ignored",
    "censored-baseline-source-blocks-the-metric",
    { find: 'reasons.push("family-censored:baseline");', replace: ";" }
  ],
  [
    "a metric reads another family's sources",
    "censored-variant-source-blocks-the-metric",
    {
      find: "metric_evidence_sources_1.METRIC_EVIDENCE_SOURCES[family]",
      replace: 'metric_evidence_sources_1.METRIC_EVIDENCE_SOURCES["consent-verification"]'
    }
  ],
  [
    "censoring adds a reason of its own",
    "censoring-adds-no-other-reason",
    { find: 'reasons.push("family-censored:variant");', replace: 'reasons.push("family-censored:variant", "design-invalid");' }
  ],
  [
    "a metric reads as eligible whatever its reasons",
    "a-metric-is-eligible-only-with-no-reason",
    { find: "eligible: uniqueReasons.length === 0, reasons: uniqueReasons", replace: "eligible: true, reasons: uniqueReasons" }
  ]
] as const) {
  test(`CL2 catches a variant: ${name}`, async () => {
    const broken = evaluatorVariant(edit).evaluateComparability;
    await assertCaughtBy(name, property, () => checkCensoringBlocksMetrics(pairsV2(broken)[0]));
  });
}

test("CL2 catches a variant: the r2 evaluator loses the base evaluator's consent reasons", async () => {
  const broken = loadVariant<{ evaluateComparabilityR2: EvaluateComparability }>(require.resolve("./scan-report-v2-r2-evaluators"), [
    { find: 'const reasons = [...base.perMetric["consent-verification"].reasons];', replace: "const reasons = [];" }
  ]);
  const pair = pairsR2()[0];
  await assertCaughtBy("r2 loses consent reasons", "censored-variant-source-blocks-the-metric", () =>
    checkCensoringBlocksMetrics({ ...pair, evaluate: broken.evaluateComparabilityR2 })
  );
});

type ObligationRegistries = Readonly<Record<string, readonly DetectorObligationRule[]>>;

function checkObligationLosses(
  registries: ObligationRegistries,
  isKnown: typeof isKnownCaptureLossDetail,
  allowsFamily: typeof captureLossDetailAllowsFamily
): number {
  let cases = 0;
  for (const [version, rules] of Object.entries(registries)) {
    for (const rule of rules) {
      for (const loss of [rule.loss, rule.alternativeLoss]) {
        if (loss === undefined) continue;
        cases += 1;
        const input = () => ({ version, detector: rule.detector, status: rule.status, reason: rule.reason, loss });
        holds("obligation-loss-detail-is-in-the-contract", isKnown(loss.detail), input);
        holds("obligation-loss-family-is-allowed", allowsFamily(loss.detail, loss.family), input);
      }
    }
  }
  return cases;
}

const obligationRegistries = (module: {
  HISTORICAL_DETECTOR_OBLIGATION_REGISTRY: readonly DetectorObligationRule[];
  HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY: readonly DetectorObligationRule[];
  DETECTOR_OBLIGATION_REGISTRY: readonly DetectorObligationRule[];
}): ObligationRegistries => ({
  [HISTORICAL_DETECTOR_OBLIGATION_CONTRACT_VERSION]: module.HISTORICAL_DETECTOR_OBLIGATION_REGISTRY,
  [HISTORICAL_V2_DETECTOR_OBLIGATION_CONTRACT_VERSION]: module.HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY,
  [DETECTOR_OBLIGATION_CONTRACT_VERSION]: module.DETECTOR_OBLIGATION_REGISTRY
});

const obligationsPath = require.resolve("./detector-obligations");
const lossContractPath = require.resolve("./capture-loss-detail-contract");

test("CL4: every loss an obligation names is a contract detail under a family it allows, in all three contracts", () => {
  const registries = obligationRegistries({
    HISTORICAL_DETECTOR_OBLIGATION_REGISTRY,
    HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY,
    DETECTOR_OBLIGATION_REGISTRY
  });
  assert.equal(Object.keys(registries).length, 3);
  const losses = checkObligationLosses(registries, isKnownCaptureLossDetail, captureLossDetailAllowsFamily);
  assert.ok(losses >= 93, `only ${losses} obligation losses were checked`);
});

for (const [name, property, edit] of [
  [
    "an obligation names a detail the contract never heard of",
    "obligation-loss-detail-is-in-the-contract",
    {
      find: 'freezeLoss("detector-output", "cname-lookups", ["cap", "timeout"], "detector-phase")',
      replace: 'freezeLoss("detector-output", "cname-lookup-misspelled", ["cap", "timeout"], "detector-phase")'
    }
  ],
  [
    "an obligation names a detail under the wrong family",
    "obligation-loss-family-is-allowed",
    {
      find: 'freezeLoss("detector-output", "cname-lookups", ["cap", "truncated"], "detector-phase")',
      replace: 'freezeLoss("requests", "cname-lookups", ["cap", "truncated"], "detector-phase")'
    }
  ]
] as const) {
  test(`CL4 catches a variant: ${name}`, async () => {
    const broken = loadVariant<Parameters<typeof obligationRegistries>[0]>(obligationsPath, [edit]);
    await assertCaughtBy(name, property, () =>
      checkObligationLosses(obligationRegistries(broken), isKnownCaptureLossDetail, captureLossDetailAllowsFamily)
    );
  });
}

test("CL4 catches a variant: the contract moves a detail to another family", async () => {
  const broken = loadVariant<{
    isKnownCaptureLossDetail: typeof isKnownCaptureLossDetail;
    captureLossDetailAllowsFamily: typeof captureLossDetailAllowsFamily;
  }>(lossContractPath, [
    { find: '"cname-lookups": { families: ["detector-output"], budget: true }', replace: '"cname-lookups": { families: ["requests"], budget: true }' }
  ]);
  await assertCaughtBy("the contract moves a detail", "obligation-loss-family-is-allowed", () =>
    checkObligationLosses(
      obligationRegistries({
        HISTORICAL_DETECTOR_OBLIGATION_REGISTRY,
        HISTORICAL_V2_DETECTOR_OBLIGATION_REGISTRY,
        DETECTOR_OBLIGATION_REGISTRY
      }),
      broken.isKnownCaptureLossDetail,
      broken.captureLossDetailAllowsFamily
    )
  );
});
