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

## Policy simulation

Statistical half-width is Wilson at the worst case `p = 0.5` on the usable
denominator; `C` additionally widens by the indeterminate share. The approved
maximum worst-case half-width is **0.1**.

| policy | N | usable | indet | stat | missing | total |
|---|---:|---:|---:|---:|---:|---:|
| A zero-censoring | 350 | 155 | 0 | 7.8% | 0.0% | **7.8%** |
| B detector-specific | 350 | 310 | 0 | 5.5% | 0.0% | **5.5%** |
| C bounded + conservative | 350 | 310 | 34 | 5.5% | 9.7% | **10.4%** |
| C bounded + conservative | 500 | 443 | 49 | 4.6% | 9.8% | **9.5%** |

Policy A's column is misleading on its own: it publishes only when *every* case
is clean, so at a 44.3% arm rate it is not a smaller study, it is no study.

**C does not clear 0.1 at N = 350.** It needs roughly N = 500. That is the
opposite of this analysis's first conclusion and follows directly from counting
indeterminate predictions honestly.

## Recommendation

- **B as the preregistered primary policy.** It is a correction rather than a
  concession: the current rule requires evidence the study never uses, and
  every recovered case has whole inputs for the detector under study.
- **C as the preregistered sensitivity analysis**, sized at N ≈ 500 rather than
  350 if its bounds are to be publishable.
- **A retained as the gold tier**, reported when it happens to hold.
- Choose the maximum bound width from what is scientifically useful, **not**
  from the observed censoring rate. The rates here establish feasibility only.

## Not settled here

- Reference availability, which is an independent-reviewer question.
- Whether the 12-host lookup cap should become a bounded work queue. It fired
  once in the arm (`cname-uncloaking: partial(evidence-cap-reached) = 1`), so it
  is not currently a yield problem, but cap-exceeded must publish as "no
  measurement", never "not detected".
- The representative stratified study that must follow the enriched
  instrument-validation study before any broader claim.
