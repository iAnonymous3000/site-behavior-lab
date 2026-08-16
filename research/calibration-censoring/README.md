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

Bounds come from a **full 2x2**, not from four margins. The four class
denominators are two partitions of the same cases and sum to `2n`, so allocating
a missing case once across them is not a realizable assignment: "all of them in
`predictedDetected`" never says what their reference class is. An earlier draft
did exactly that and every C row it produced was invalid.

A case with a missing prediction but a known reference can only land in the two
cells of its reference row; a case missing both is unconstrained. The bound is
the envelope over those corner assignments, and **all seven published rates**
are derived from each extremal matrix.

`publishable` requires every class floor, every rate's width, **and** the
policy's own all-or-nothing rule. An earlier draft omitted the last, so A read
publishable at N=500 while only 44.3% of cases were usable.

The operating point is an **assumption, not a measurement** — the corpus has no
independent references.

**`precision` binds at every point**, because `predictedDetected` is the
smallest class.

| operating point | policy | N=350 | N=500 |
|---|---|---|---|
| prev .50 · recall .90 | A | ✗ all-or-nothing (44.3% usable) | ✗ all-or-nothing |
| | B | **✓ 8.0%** | ✓ 6.7% |
| | C | ✗ 17.3% | ✗ 16.2% |

**C clears nowhere.** Under a realizable 2x2 assignment the unassigned cases move
`precision` by far more than the margin-allocation model suggested. Any earlier
statement that C clears at some N is withdrawn.

## B's inference scope

Complete-case analysis is **potentially selected on measurement difficulty**: the
cases B drops are exactly the ones the instrument found hard, and nothing
justifies assuming the detector behaves the same on them. So a B rate describes
the **scoreable subpopulation**, not the randomized frame.

The preregistration must pick one resolution:

1. **Define the target population before sampling** as sites that pass
   detector-input screening — making B a target-population estimate for a
   narrower, explicitly stated population; or
2. **Publish B as descriptive** scoreable-subpopulation evidence and let C carry
   the target-population claim through its bounds.

This is recorded as `inferenceScope` on the policy object and asserted by a test,
so it cannot be quietly dropped.

## What the evidence supports

- **B recovers 27 genuinely usable historical runs** in the arm.
- Unrelated-family losses should not censor CNAME.
- Six arm predictions are indeterminate from incomplete request inputs.
- Bare-load-only screening is insufficient; screening must measure
  **detector-input readiness** without reading prediction values.

It does **not** support B as a target-population claim without resolution (1),
nor any statement that C clears at a given N.

## Reducing the sizing circularity

`precision` binds, and it depends on the detector's own recall, which is unknown
until a study runs. That is reducible rather than circular:

- Estimate **predicted-positive prevalence** on a **disjoint development pool**
  under the exact arm, exclude that pool from the confirmatory frame, and size
  from a conservative lower confidence bound.
- **Reference prevalence** still requires an independent labeled pilot or a
  preregistered minimum operating point. It cannot come from the scanner.

## Not settled here

- Reference availability, which is an independent-reviewer question.
- Whether the 12-host lookup cap should become a bounded work queue. It fired
  once in the arm (`cname-uncloaking: partial(evidence-cap-reached) = 1`), so it
  is not currently a yield problem, but cap-exceeded must publish as "no
  measurement", never "not detected".
- The representative stratified study that must follow the enriched
  instrument-validation study before any broader claim.
