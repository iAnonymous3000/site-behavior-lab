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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const reportsDir = path.join(root, "public", "reports");

/** The exact arm the CNAME study declares (lib/detector-calibration.ts). */
const CNAME_ARM = Object.freeze({ device: "desktop", gpcEnabled: false, consentMode: "observe" });

const EXPECTED_FAMILIES = Object.freeze([
  "requests", "cookies", "storage", "fingerprinting", "detector-output", "consent-verification"
]);

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
const losses = (r) => (Array.isArray(facts(r).captureLoss) ? facts(r).captureLoss : []);
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

function rateRow(label, items, predicate) {
  const k = items.filter(predicate).length, n = items.length;
  const w = wilson(k, n);
  const c = clusterInterval(items, predicate, (r) => `${r.scanDate}|${r.build}`);
  const clustered = c.lo === null ? `too few clusters (${c.clusters})` : `[${pct(c.lo)}, ${pct(c.hi)}]`;
  return `  ${label.padEnd(38)} ${String(k).padStart(3)}/${String(n).padEnd(4)} ${pct(k / n).padStart(6)}  Wilson [${pct(w.lo)}, ${pct(w.hi)}]  clustered ${clustered}`;
}

const runs = loadRuns();
const arm = runs.filter(inCnameArm);

const out = [];
const say = (line = "") => { out.push(line); console.log(line); };

say(`CALIBRATION CENSORING DECISION PACKAGE`);
say(`development evidence -- NOT frame-selection evidence`);
say(`generated from ${runs.length} r2 runs; primary analysis restricted to the declared CNAME arm`);
say(`CNAME arm = device ${CNAME_ARM.device} / GPC ${CNAME_ARM.gpcEnabled} / consent ${CNAME_ARM.consentMode}`);
say(`arm runs: ${arm.length}   off-arm (supplementary only): ${runs.length - arm.length}`);
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

say(`POLICY SIMULATION -- CNAME arm rates applied to planned N`);
say(`  statistical half-width is Wilson at the worst case p=0.5 on the usable denominator.`);
say(`  C additionally admits indeterminate predictions and widens by their share.`);
say();
const armRate = (predicate) => (arm.length ? arm.filter(predicate).length / arm.length : 0);
const rateA = armRate(allFamilyZeroLoss);
const rateB = armRate(cnameScoreable);
const rateIndet = armRate(cnameIndeterminate);
say(`  ${"policy".padEnd(34)} ${"N".padStart(4)} ${"usable".padStart(7)} ${"indet".padStart(6)} ${"stat".padStart(7)} ${"missing".padStart(8)} ${"total".padStart(7)}`);
for (const [label, rate, indeterminateRate] of [
  ["A zero-censoring (current)", rateA, 0],
  ["B detector-specific zero-censoring", rateB, 0],
  ["C bounded + conservative bounds", rateB, rateIndet]
]) {
  for (const N of [200, 350, 500]) {
    const usable = Math.round(N * rate);
    const indeterminate = Math.round(N * indeterminateRate);
    const stat = usable > 0 ? wilson(Math.round(usable / 2), usable).half : 0.5;
    const missing = N > 0 ? indeterminate / N : 0;
    say(`  ${label.padEnd(34)} ${String(N).padStart(4)} ${String(usable).padStart(7)} ${String(indeterminate).padStart(6)} ${pct(stat).padStart(7)} ${pct(missing).padStart(8)} ${pct(stat + missing / 2).padStart(7)}`);
  }
  say();
}
say(`  Policy A publishes ONLY when every case is clean. At the arm rate above that`);
say(`  is not a smaller study, it is no study; no q^N is quoted because failures`);
say(`  here are clustered by batch and build rather than independent.`);
say(`  The approved maximum worst-case half-width is 0.1.`);

fs.writeFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "corpus-censoring-findings.txt"),
  `${out.join("\n")}\n`
);
