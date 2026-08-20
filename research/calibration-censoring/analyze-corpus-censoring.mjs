#!/usr/bin/env node
/**
 * Corpus censoring analysis for the calibration censoring-policy decision.
 *
 * WHAT THIS IS FOR
 * The approved analyzer policy publishes a rate only when EVERY case in a study
 * is uncensored. `RELEASE_READINESS.json` already calls that "near-unsatisfiable
 * on the open web". This measures, from committed reports, what the three
 * candidate policies would actually yield, so the policy decision rests on
 * reproducible numbers rather than on an estimate.
 *
 * BOUNDARIES, which bind every number this prints
 *
 *  1. DEVELOPMENT EVIDENCE, NOT FRAME-SELECTION EVIDENCE. These reports are a
 *     policy dataset. Nothing here may choose the confirmatory frame. Only
 *     aggregates are emitted; no per-site result is printed or written, and the
 *     sites represented here should be excluded from, or fixed before, any
 *     confirmatory frame.
 *
 *  2. PREDICTION AVAILABILITY ONLY. Scanner-produced DNS evidence is never
 *     treated as a reference. Whether an independent reviewer could obtain a
 *     reference is not answerable from a committed report, so "scoreable" here
 *     means the SCANNER SIDE is scoreable and nothing more.
 *
 *  3. A FINISHED DETECTOR STAGE IS NOT A COMPLETE PREDICTION. `cname-uncloaking`
 *     builds its candidate hosts from `publicRequests` (lib/scanner.ts), so a
 *     censored requests family can hide candidate hostnames before the detector
 *     ever runs. A complete detector ledger proves DNS resolution finished for
 *     the requests that SURVIVED, not that the input was whole. The calibration
 *     seam `detectorPredictionFromRun` checks the run outcome and the ledger and
 *     does NOT check request completeness, so this distinction is currently
 *     unenforced upstream too.
 *
 *  4. FAILURES ARE NOT i.i.d. The corpus spans few batch dates on few builds, so
 *     a pooled q^N is not defensible and none is computed. Cluster intervals are
 *     printed with their cluster count so their weakness is visible.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDiscriminatorMatchesProduct,
  normalizeHistoricalLossDetail
} from "./historical-loss-detail.mjs";
import {
  METRIC_DENOMINATOR,
  POLICIES,
  simulatePolicy
} from "../../scripts/calibration-censoring-simulation-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reportsDir = path.join(root, "public", "reports");

/**
 * The exact arm the CNAME study declares, and the canonical family list.
 *
 * Both are RESTATED here because this driver is plain ESM and the sources are
 * TypeScript, so they are checked against those sources at startup rather than
 * trusted. A silent drift would make the primary analysis describe a condition
 * the study does not run in.
 */
const CNAME_ARM = Object.freeze({ device: "desktop", gpcEnabled: false, consentMode: "observe" });

const EXPECTED_FAMILIES = Object.freeze([
  "requests", "cookies", "storage", "fingerprinting", "detector-output", "consent-verification"
]);

function assertCanonicalConstants(repoRoot) {
  const calibration = fs.readFileSync(path.join(repoRoot, "lib", "detector-calibration.ts"), "utf8");
  // Anchor on the passive arm's own interpretation constant; the file has many
  // `return {` blocks and the last one is a different function.
  const marker = calibration.indexOf("interpretation: PASSIVE_CALIBRATION_CONDITION_INTERPRETATION");
  if (marker < 0) throw new Error("lib/detector-calibration.ts no longer declares a passive calibration arm");
  const blockStart = calibration.lastIndexOf("return {", marker);
  const passiveArm = calibration.slice(blockStart, marker);
  for (const [key, value] of [["device", '"desktop"'], ["gpcEnabled", "false"], ["consentMode", '"observe"']]) {
    if (!passiveArm.includes(`${key}: ${value}`)) {
      throw new Error(`declared CNAME arm drifted: lib/detector-calibration.ts no longer says ${key}: ${value}`);
    }
  }
  const schema = fs.readFileSync(path.join(repoRoot, "lib", "scan-report-v2.ts"), "utf8");
  const declared = schema
    .match(/export const EVIDENCE_FAMILIES[^=]*=\s*\[([^\]]+)\]/)?.[1]
    ?.match(/"([^"]+)"/g)
    ?.map((entry) => entry.replaceAll('"', ""));
  const same =
    Array.isArray(declared) &&
    declared.length === EXPECTED_FAMILIES.length &&
    [...declared].sort().join(",") === [...EXPECTED_FAMILIES].sort().join(",");
  if (!same) {
    throw new Error(`evidence family list drifted from EVIDENCE_FAMILIES: ${JSON.stringify(declared)}`);
  }
  // Pinned in its own module, which the driver and its test both read, so the
  // restatement cannot drift from the product rule it mirrors.
  assertDiscriminatorMatchesProduct(repoRoot);
}

/**
 * Families whose loss can corrupt a CNAME PREDICTION.
 *
 * `requests` is an INPUT family: the detector enumerates candidate hosts from
 * the retained request records, so losing requests silently shrinks the
 * candidate set. `detector-output` matters only via the cname-lookups entry,
 * which is the detector's own budget.
 */
const CNAME_INPUT_FAMILIES = Object.freeze(["requests"]);
const CNAME_OWN_LOSS_DETAILS = new Set(["cname-lookups"]);

const catalog = JSON.parse(fs.readFileSync(path.join(root, "public", "featured-sites.json"), "utf8"));
const categoryOf = new Map((catalog.sites ?? []).map((s) => [s.domain, s.category ?? "uncategorized"]));

function loadRuns() {
  const runs = [];
  for (const file of fs.readdirSync(reportsDir).sort()) {
    if (!file.endsWith(".json") || file.includes("provenance")) continue;
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(reportsDir, file), "utf8")); } catch { continue; }
    for (const arm of ["run", "baseline", "variant"]) {
      const run = report[arm];
      if (!run?.qualityFacts || !run.quality?.byFamily) continue;
      runs.push({
        scanDate: file.slice(0, 8),
        build: (run.provenance?.buildCommit ?? "unrecorded").slice(0, 8),
        domain: run.subject?.observed?.registrableDomain ?? run.subject?.requested?.registrableDomain ?? "unknown",
        device: run.conditions?.device?.kind ?? "unknown",
        gpcEnabled: run.conditions?.gpc === true,
        consentMode: typeof run.conditions?.consent === "string" ? run.conditions.consent : "unknown",
        run
      });
    }
  }
  return runs;
}

const facts = (r) => r.run.qualityFacts;
const fam = (r) => r.run.quality.byFamily;
const runWarnings = (r) => (Array.isArray(r.run?.warnings) ? r.run.warnings : []);

const rawLosses = (r) => (Array.isArray(facts(r).captureLoss) ? facts(r).captureLoss : []);
const losses = (r) =>
  rawLosses(r).map((l) => normalizeHistoricalLossDetail(l, runWarnings(r)));
const ledger = (r, d) => r.run.detectors?.[d];

const inCnameArm = (r) =>
  r.device === CNAME_ARM.device && r.gpcEnabled === CNAME_ARM.gpcEnabled && r.consentMode === CNAME_ARM.consentMode;

const bareLoadValid = (r) => {
  const status = typeof r.run.summary?.status === "number" ? r.run.summary.status : null;
  return (
    status !== null && status >= 200 && status < 400 &&
    facts(r).status === status &&
    facts(r).navigationSettled === true &&
    facts(r).botWallTitleMatched === false &&
    !losses(r).some((l) => l.detail === "page-subject-validity")
  );
};

const runComplete = (r) => r.run.quality?.run?.outcome === "complete";

const allFamilyZeroLoss = (r) =>
  bareLoadValid(r) && runComplete(r) &&
  EXPECTED_FAMILIES.every((f) => fam(r)[f]?.outcome === "complete") &&
  losses(r).length === 0 && (facts(r).budgetsExhausted ?? []).length === 0;

/** The detector stage finished. NOT the same as a complete prediction. */
const cnameStageFinished = (r) =>
  bareLoadValid(r) && runComplete(r) && ledger(r, "cname-uncloaking")?.status === "complete";

/** Input families whole AND the detector's own budget intact. */
const cnameInputsComplete = (r) =>
  CNAME_INPUT_FAMILIES.every((f) => fam(r)[f]?.outcome === "complete") &&
  !losses(r).some((l) => CNAME_OWN_LOSS_DETAILS.has(l.detail));

/**
 * Scanner-side scoreable. The fourth clause of the full definition -- an
 * independent reference exists -- cannot be evaluated from a committed report
 * and is deliberately absent.
 */
const cnameScoreable = (r) => cnameStageFinished(r) && cnameInputsComplete(r);

/** Stage finished but inputs truncated: a prediction of unknown completeness. */
const cnameIndeterminate = (r) => cnameStageFinished(r) && !cnameInputsComplete(r);

const wilson = (k, n, z = 1.96) => {
  if (n === 0) return { lo: 0, hi: 1, half: 0.5 };
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h), half: h };
};

function clusterInterval(items, predicate, keyOf, iterations = 4000) {
  const clusters = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push(item);
  }
  const pool = [...clusters.values()];
  if (pool.length < 3) return { lo: null, hi: null, clusters: pool.length };
  let seed = 20260816;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const rates = [];
  for (let i = 0; i < iterations; i++) {
    let k = 0, n = 0;
    for (let c = 0; c < pool.length; c++) {
      const picked = pool[Math.floor(rnd() * pool.length)];
      for (const item of picked) { n++; if (predicate(item)) k++; }
    }
    if (n > 0) rates.push(k / n);
  }
  rates.sort((a, b) => a - b);
  return { lo: rates[Math.floor(rates.length * 0.025)], hi: rates[Math.floor(rates.length * 0.975)], clusters: pool.length };
}

const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

/** Wilson bounds on an observed rate, for sizing that does not assume the point estimate. */
function wilsonBounds(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

function rateRow(label, items, predicate) {
  const k = items.filter(predicate).length, n = items.length;
  const w = wilson(k, n);
  const c = clusterInterval(items, predicate, clusterKey);
  // Print the cluster count on EVERY row, not only when the bootstrap refused
  // to run. The boundary promises the count is visible so the interval's
  // weakness is visible with it, and the rows that most need it are exactly
  // the ones where the bootstrap DID run: the pooled rows are the only ones
  // with enough clusters to resample, while a single cluster dominates the
  // pool (the CLUSTER STRUCTURE section records the exact split). Printing it
  // only in the too-few branch hid it from every row whose number a reader
  // might actually use.
  const clustered =
    c.lo === null
      ? `too few clusters (${c.clusters})`
      : `[${pct(c.lo)}, ${pct(c.hi)}] over ${c.clusters} clusters`;
  return `  ${label.padEnd(38)} ${String(k).padStart(3)}/${String(n).padEnd(4)} ${pct(k / n).padStart(6)}  Wilson [${pct(w.lo)}, ${pct(w.hi)}]  clustered ${clustered}`;
}

const checkOnly = process.argv.includes("--check");

// Activated, not merely defined. A guard that is never called is the defect
// class this repository keeps finding, and this one was written and left dead.
assertCanonicalConstants(root);

const runs = loadRuns();
const arm = runs.filter(inCnameArm);

/** One bootstrap cluster: a scan date on a build. */
const clusterKey = (r) => `${r.scanDate}|${r.build}`;
const countBy = (items, keyOf) => {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};
const armClusterCount = countBy(arm, clusterKey).size;

const out = [];
const say = (line = "") => { out.push(line); console.log(line); };

say(`CALIBRATION CENSORING DECISION PACKAGE`);
say(`development evidence -- NOT frame-selection evidence`);
say(`generated from ${runs.length} r2 runs; primary analysis restricted to the declared CNAME arm`);
say(`CNAME arm = device ${CNAME_ARM.device} / GPC ${CNAME_ARM.gpcEnabled} / consent ${CNAME_ARM.consentMode}`);
say(`arm runs: ${arm.length}   off-arm (supplementary only): ${runs.length - arm.length}`);
say();

// The non-i.i.d. boundary's own numbers, emitted with the findings so the
// README can scope its prose to this artifact instead of hand-maintaining
// counts that only a corpus refresh can change. The guard in
// scripts/calibration-censoring-simulation-lib.test.mjs holds the README's
// boundary paragraph to this section, so both go stale together with --check.
say(`CLUSTER STRUCTURE -- failures cluster by scan date and build`);
{
  const scanDateCount = countBy(runs, (r) => r.scanDate).size;
  const buildCounts = countBy(runs, (r) => r.build);
  const clusterCount = countBy(runs, clusterKey).size;
  say(`  scan dates: ${scanDateCount}   builds: ${buildCounts.size}   scan-date x build clusters: ${clusterCount}`);
  [...buildCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([build, count]) => say(`  build ${build}  ${String(count).padStart(4)} of ${runs.length} runs`));
  say(`  CNAME arm clusters: ${armClusterCount}`);
}
say();

say(`PRIMARY -- CNAME ARM ONLY (n=${arm.length})`);
say(rateRow("bare-load sound", arm, bareLoadValid));
say(rateRow("A generic all-family zero-loss", arm, allFamilyZeroLoss));
say(rateRow("B CNAME scoreable (inputs whole)", arm, cnameScoreable));
say(rateRow("  CNAME stage finished", arm, cnameStageFinished));
say(rateRow("  of which INDETERMINATE (inputs cut)", arm, cnameIndeterminate));
say();

say(`SUPPLEMENTARY -- pooled across all conditions (n=${runs.length})`);
say(rateRow("A generic all-family zero-loss", runs, allFamilyZeroLoss));
say(rateRow("B CNAME scoreable", runs, cnameScoreable));
say(rateRow("  CNAME stage finished", runs, cnameStageFinished));
say(rateRow("  of which INDETERMINATE", runs, cnameIndeterminate));
say();

say(`EVIDENCE FAMILY CENSORING (CNAME arm)`);
for (const family of EXPECTED_FAMILIES) {
  const c = arm.filter((r) => fam(r)[family]?.outcome === "censored").length;
  say(`  ${family.padEnd(24)} ${String(c).padStart(3)}/${arm.length}  ${pct(c / (arm.length || 1))}`);
}
say();

say(`CAPTURE-LOSS REASONS (CNAME arm)`);
const reasons = new Map();
for (const r of arm) for (const l of losses(r)) {
  const key = `${l.family}/${l.detail ?? "NULL-DETAIL"}/${l.kind}`;
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
[...reasons.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`  ${String(v).padStart(3)}  ${k}`));
say();

say(`DETECTOR LEDGER STATE (CNAME arm)`);
const names = new Set();
for (const r of arm) for (const d of Object.keys(r.run.detectors ?? {})) names.add(d);
for (const name of [...names].sort()) {
  const states = new Map();
  for (const r of arm) {
    const l = ledger(r, name);
    const key = l ? (l.reason ? `${l.status}(${l.reason})` : l.status) : "absent";
    states.set(key, (states.get(key) ?? 0) + 1);
  }
  say(`  ${name.padEnd(24)} ${[...states.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join("  ")}`);
}
say();

say(`RECOVERY: cases B admits that A rejects (CNAME arm)`);
const recovered = arm.filter((r) => cnameScoreable(r) && !allFamilyZeroLoss(r));
say(`  ${recovered.length} cases scoreable for CNAME but rejected by zero-censoring`);
const lostTo = new Map();
for (const r of recovered) for (const f of EXPECTED_FAMILIES) {
  if (fam(r)[f]?.outcome === "censored") lostTo.set(f, (lostTo.get(f) ?? 0) + 1);
}
[...lostTo.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => say(`     censored family present: ${k} = ${v}`));
say();

say(`NULL-DETAIL REQUEST LOSS -- compatibility-derived attribution`);
const nullDetail = runs.filter((r) => losses(r).some((l) => l.family === "requests" && !l.detail));
const withGpcWorker = nullDetail.filter((r) =>
  (r.run.warnings ?? []).some((w) => /worker/i.test(w) && /global privacy control|gpc/i.test(w))
);
say(`  runs with a null-detail requests loss: ${nullDetail.length}`);
say(`  of those, carrying the GPC-worker warning: ${withGpcWorker.length}`);
say(`  all GPC-on: ${nullDetail.every((r) => r.gpcEnabled)}`);
say(`  NOTE: the frozen r2 ledger carries no structured detail for these, so this`);
say(`  attribution is COMPATIBILITY-DERIVED from warning text, not canonical.`);
say();

say(`CATEGORY STRATA (CNAME arm)`);
{
  const groups = new Map();
  for (const r of arm) {
    const k = categoryOf.get(r.domain) ?? "not-in-gallery";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  [...groups.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([k, items]) => {
    const a = items.filter(allFamilyZeroLoss).length;
    const b = items.filter(cnameScoreable).length;
    say(`  ${String(k).padEnd(22)} n=${String(items.length).padStart(3)}  zero-loss ${pct(a / items.length).padStart(6)}  CNAME-scoreable ${pct(b / items.length).padStart(6)}`);
  });
}
say();

say(`POLICY SIMULATION -- every rate on ITS OWN marginal denominator`);
say(`  The gate evaluates each rate on its own class, and every class is a`);
say(`  FRACTION of the usable total, so a pooled half-width understates all of`);
say(`  them. Floors (>=100 per class) are checked alongside width (<=0.1).`);
say();
say(`  Operating point is an ASSUMPTION, not a measurement: the corpus has no`);
say(`  independent references, so prevalence/recall/specificity are declared`);
say(`  inputs. Several are shown because the answer depends on them.`);
say();

const rateOf = (predicate) => (arm.length ? arm.filter(predicate).length / arm.length : 0);
const usableA = rateOf(allFamilyZeroLoss);
const usableB = rateOf(cnameScoreable);
// C retains the WHOLE bare-load-valid frame, so its admitted rate is that
// population -- not scoreable+indeterminate, which drops the stage-incomplete case.
const admittedRate = rateOf(bareLoadValid);

const OPERATING_POINTS = [
  { label: "prev .50 recall .90 spec .95", prevalence: 0.5, recall: 0.9, specificity: 0.95 },
  { label: "prev .50 recall .70 spec .95", prevalence: 0.5, recall: 0.7, specificity: 0.95 },
  { label: "prev .35 recall .70 spec .95", prevalence: 0.35, recall: 0.7, specificity: 0.95 }
];

for (const point of OPERATING_POINTS) {
  say(`  ${point.label}`);
  // The column reports NUMERICAL ELIGIBILITY. Labelling it "publishable" made B
  // print "yes" beside "scope: subpopulation only", which is the opposite of
  // what r.publishable says.
  say(`    ${"policy".padEnd(52)} ${"N".padStart(4)} ${"usable".padStart(6)} ${"widest rate".padEnd(26)} ${"half".padStart(6)}  numEligible  why`);
  for (const [policyId, usableRate] of [
    ["zero-censoring", usableA],
    ["detector-scoped-complete-case", usableB],
    ["bounded-censoring-with-sensitivity-analysis", usableB]
  ]) {
    for (const N of [200, 350, 500]) {
      // For C: references unknown, and references obtained. Obtaining a
      // reference REVEALS the composition of the missing rows; it does not make
      // that composition balanced. Prospective sizing must therefore bound over
      // the composition, so the "obtained" row takes the WORST of
      // all-present / all-absent / balanced rather than assuming balance.
      const scenarios = POLICIES[policyId].admitsIndeterminate
        ? [
            { label: "refs unknown, worst composition", mode: "including-unknown-reference" },
            { label: "refs obtained, worst composition", mode: "references-obtained" }
          ]
        : [{ label: null, mode: false }];
      for (const scenario of scenarios) {
        const r = simulatePolicy({
          policy: policyId, plannedCases: N,
          scoreableRate: usableRate,
          admittedRate: POLICIES[policyId].admitsIndeterminate ? admittedRate : usableRate,
          worstCaseComposition: scenario.mode,
          prevalence: point.prevalence, recall: point.recall, specificity: point.specificity
        });
        const tag = scenario.label ? ` [${scenario.label}]` : "";
        const why = r.allOrNothingUnsatisfiedAt !== null
          ? `all-or-nothing unmet (${pct(r.allOrNothingUnsatisfiedAt)} usable)`
          : r.failingFloors.length ? `FAIL ${r.failingFloors.join(",")}`
          : !r.inferenceScopeResolved ? "scope: subpopulation only"
          : "ok";
        say(
          `    ${(POLICIES[policyId].label + tag).padEnd(52)} ${String(N).padStart(4)} ${String(r.usableCases).padStart(6)} ` +
          `${`${r.widestRate} (${r.bounds[r.widestRate].observedDenominator})`.padEnd(26)} ${pct(r.widestHalfWidth).padStart(6)}  ` +
          `${(r.numericallyEligible ? "yes" : "NO ").padEnd(11)}  ${why}  n=${r.representedCases}`
        );
      }
    }
  }
  say();
}

say(`  SCOREABILITY IS ITSELF ESTIMATED. The rows above use the arm's point`);
say(`  estimate ${pct(usableB)} for CNAME-scoreable. The endpoint below is a`);
say(`  PER-CASE WILSON BOUND and therefore an iid-only diagnostic: this arm has`);
// Derived, not hand-written: the hardcoded "two" would go stale silently the
// first time the corpus refresh changed the arm's date-and-build structure.
say(`  ${armClusterCount} clusters, so it is NOT a defensible design lower bound, only an`);
say(`  indication that sizing on the point estimate assumes what is not pinned down.`);
{
  const lower = wilsonBounds(arm.filter(cnameScoreable).length, arm.length).lo;
  for (const N of [350, 500]) {
    const r = simulatePolicy({
      policy: "bounded-censoring-with-sensitivity-analysis",
      plannedCases: N, scoreableRate: lower, admittedRate: admittedRate,
      missingReferenceSplit: { present: 0.5, absent: 0.5, both: 0 },
      prevalence: 0.5, recall: 0.9, specificity: 0.95
    });
    say(`    C @ N=${N}, scoreable=${pct(lower)} (iid-only endpoint), balanced refs -> ${pct(r.widestHalfWidth)} (${r.widestRate})`);
  }
}
say();
say(`  POLICY A CANNOT BE READ FROM WIDTH. It publishes only when the study`);
say(`  censored NOTHING. At the arm's ${pct(usableA)} zero-loss rate that is not a`);
say(`  narrower study, it is no study, and no q^N is quoted because these`);
say(`  failures are clustered by batch and build rather than independent.`);
say();
say(`  NO CATEGORICAL "N CLEARS" CLAIM IS MADE. Whether any policy publishes`);
say(`  depends on the operating point above, which the corpus cannot supply.`);
say(`  These rows show feasibility under declared assumptions only.`);

const artifactPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus-censoring-findings.txt");
const rendered = `${out.join("\n")}\n`;

if (checkOnly) {
  // --check must never rewrite: it exists to prove the committed artifact still
  // reproduces from the committed corpus.
  const committed = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, "utf8") : null;
  if (committed !== rendered) {
    console.error(
      "\ncorpus-censoring-findings.txt is stale: regenerate with `node research/calibration-censoring/analyze-corpus-censoring.mjs`"
    );
    process.exit(1);
  }
  console.error("\ncorpus-censoring-findings.txt reproduces exactly.");
} else {
  fs.writeFileSync(artifactPath, rendered);
}
