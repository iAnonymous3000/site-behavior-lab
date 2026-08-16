# Calibration censoring policy: decision package

Evidence for a named decision on
`RELEASE_READINESS.json → calibrationCensoringPolicy`, whose only currently
supported selection is `complete-case-only-zero-censoring`. That entry already
carries the assessment "near-unsatisfiable on the open web (pilot capture
failure: 37.5%)", and this package measures what the alternatives would actually
yield.

Reproduce with:

```bash
node research/calibration-censoring/analyze-corpus-censoring.mjs
```

Output is committed as [corpus-censoring-findings.txt](corpus-censoring-findings.txt).

## Boundaries

These bind every number below and are enforced in the script's own comments.

1. **Development evidence, not frame-selection evidence.** These reports are a
   policy dataset. Nothing here may choose the confirmatory frame. Only
   aggregates are emitted; no per-site result is printed or written. The sites
   represented here should be excluded from a confirmatory frame, or the frame
   fixed from an independently defined universe before site-level results are
   examined.
2. **Prediction availability only.** Scanner-produced DNS evidence is never
   treated as a reference. Whether an independent reviewer could obtain a
   reference is not answerable from a committed report. "Scoreable" here means
   the scanner side is scoreable and nothing more, so the fourth clause of the
   full definition is deliberately absent.
3. **Failures are not i.i.d.** The corpus spans two scan dates on two builds. No
   pooled `q^N` is computed. Cluster intervals print their cluster count, and in
   the primary arm there are too few clusters to bootstrap at all. This corpus
   cannot support cluster-robust inference; that is a finding, not an oversight.

## The correction that decides the package

**A finished detector stage is not a complete prediction.** `cname-uncloaking`
builds its candidate hosts from `publicRequests` (`lib/scanner.ts`), so a
censored requests family hides candidate hostnames *before the detector runs*. A
complete ledger proves DNS resolution finished for the requests that survived,
not that the input was whole.

The calibration seam has the same gap today: `detectorPredictionFromRun`
(`scripts/calibration-study-lib.mjs`) checks the run outcome and the detector
ledger and never checks request completeness.

So three quantities must be kept apart:

| | CNAME arm (n=61) |
|---|---|
| generic all-family zero-loss | 27/61 · 44.3% |
| CNAME scoreable, inputs whole | 54/61 · 88.5% |
| CNAME stage finished | 60/61 · 98.4% |
| of which **indeterminate** (inputs cut) | 6/61 · 9.8% |

An earlier version of this analysis reported the 98.4% figure as
"component-recoverable" and concluded the bounded tier cost under 1% of bound
width. That was wrong: those cases are predictions of unknown completeness, and
they must enter conservative bounds as indeterminate.

## Primary analysis is arm-restricted

The CNAME study declares `desktop / GPC off / observe`
(`lib/detector-calibration.ts`). Pooling conditions was measuring an
instrumentation artifact: all 24 null-detail `requests` losses in the corpus are
GPC-on runs carrying the GPC-worker warning, and none appear in the arm. Pooled
CNAME-scoreable is 73.8%; in the declared arm it is **88.5%**.

That null-detail attribution is **compatibility-derived** from warning text. The
frozen r2 ledger carries no structured detail for it, which is why the sweep's
own receipt must require structured loss reasons rather than inheriting this
limitation.

## Bare-load validity is not the problem

100% of arm runs are bare-load sound: every one loaded, settled, verified its
subject, matched no bot wall, and agreed with its own recorded status. **Every
rejection is downstream evidence censoring**, not a failed visit. Screening
candidates for load reliability will not move these rates.

## What zero-censoring discards

27 arm cases are CNAME-scoreable but rejected by zero-censoring, lost only to
`detector-output` (16), `fingerprinting` (15), `storage` (1). A CNAME reference
is a DNS chain; none of those families touch it. These are genuine recoveries,
not a relaxation of evidence.

## Policy definitions

The first draft conflated A and B. They are different *shapes* of rule:

- **A `zero-censoring` (current).** Publishes only if the study censored
  **nothing**. One censored case and there is no rate at all.
- **B `detector-scoped-complete-case`.** Analyses cases whose detector-required
  inputs are whole and reports the rest as coverage loss. This is a
  complete-case analysis; calling it "detector-scoped zero-censoring" would
  claim a study-level guarantee it does not make.
- **C `bounded-censoring-with-sensitivity-analysis`.** Admits all bare-load-valid
  cases, assigning indeterminate predictions adversarially to produce bounds.

## Policy simulation

Every rate is sized on **its own marginal denominator**, never the usable total.
`predictedDetected` is not `referencePresent`: at recall `r` it is
`r·referencePresent + (1−specificity)·referenceAbsent`, so sizing the reference
class to 100 can still starve the detector's own class. An earlier draft computed
one Wilson half-width from the total and reported 5.5% where the binding class
carries 8–9%.

Floors (≥100 per class) are enforced **alongside** width (≤0.1), because a study
can be narrow and still ineligible.

The operating point is an **assumption, not a measurement** — the corpus has no
independent references — so several are shown.

**`precision` is the binding metric at every point**, because `predictedDetected`
is the smallest class.

| operating point | policy | N=350 | N=500 |
|---|---|---|---|
| prev .50 · recall .90 | A | ✗ floors | ✓ 9.4% |
| | B | **✓ 8.0%** | ✓ 6.7% |
| | C balanced | ✗ 10.6% | ✓ 9.4% |
| | C worst-class | ✗ 17.4% | ✗ 16.2% |
| prev .50 · recall .70 | B | **✓ 9.0%** | ✓ 7.5% |
| | C balanced | ✗ 11.4% | ✗ 10.1% |
| | C worst-class | ✗ 20.3% | ✗ 18.9% |
| prev .35 · recall .70 | B | ✗ floor | ✓ 8.7% |
| | C balanced | ✗ 13.1% | ✗ 11.4% |
| | C worst-class | ✗ 24.5% | ✗ 22.9% |

**No categorical "N clears" claim is made.** An earlier draft asserted C clears at
N≈500; under class-specific denominators C fails the worst-class-concentration
scenario at every N shown, and B's publishability depends on prevalence.

Policy A cannot be read from width at all: at the arm's 44.3% zero-loss rate it
is not a narrower study, it is no study.

## What the evidence supports

- **B recovers 27 genuinely usable historical runs** and is the only candidate
  that publishes at N=350 under favourable operating points.
- **C's cost is scenario-dependent and large.** Without independent references
  the corpus cannot say which class holds the indeterminate cases, so the
  worst-class-concentration row governs — and it clears nowhere yet.
- Unrelated-family losses should not censor CNAME.
- Six arm predictions are indeterminate because request inputs were incomplete.
- Bare-load-only screening is insufficient: screening must measure
  **detector-input readiness** without reading prediction values.

It does **not** yet support "B is publishable at N=350" as an unconditional
claim, nor any statement that C clears at a given N.

## Not settled here

- Reference availability, which is an independent-reviewer question.
- Whether the 12-host lookup cap should become a bounded work queue. It fired
  once in the arm (`cname-uncloaking: partial(evidence-cap-reached) = 1`), so it
  is not currently a yield problem, but cap-exceeded must publish as "no
  measurement", never "not detected".
- The representative stratified study that must follow the enriched
  instrument-validation study before any broader claim.
