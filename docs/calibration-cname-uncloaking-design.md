# Designing a publishable `cname-uncloaking` calibration study

This is design work, not a preregistration. It states which detector should be
calibrated first and why, corrects two defects in the drafted plan that would
have made the study either unfalsifiable or near-certain to fail, and records
the arithmetic that any replacement design has to satisfy.

It deliberately stops short of creating `calibration/<studyId>/preregistration.json`.
Preregistration binds, and the non-negotiable ordering in
[calibration-study-operations.md](calibration-study-operations.md) puts a human
policy approval in `RELEASE_READINESS.json` **before** the plan is written.
Committing a preregistration artifact here would fabricate that approval.

## Why `cname-uncloaking` first

Five detectors were compared on two axes: whether an independent party can
establish ground truth without trusting this codebase, and whether a study can
reach the approved denominators at all.

| Detector | Independent ground truth | Host prevalence (default arm) |
|---|---|---|
| `cname-uncloaking` | **Yes** - a DNS CNAME chain is resolvable by anyone with `dig` | 13.3% |
| `pixel-events` | Yes - three documented endpoint rules | 5.1% |
| `privacy-policy` | Weak proposition only ("is there a discoverable policy link") | 67.3% |
| `fingerprint-heuristics` | **No** - the labeler would have to adopt our own `>= 8` / `>= 5` thresholds | 62.2% |
| `consent-banner` | Contested - the implemented seam measures banner visibility, which is not the published claim | 16.3% |

`fingerprint-heuristics` has the prevalence to clear the denominators easily and
is the wrong choice anyway: no third party can label "does this page
fingerprint" without adopting this project's thresholds, so the study would
measure whether our code agrees with our own specification. That is a unit
test wearing a study's clothes.

`cname-uncloaking` is the only detector where ground truth lives outside the
instrument entirely. It is also the only one measured to be perfectly
condition-invariant: across 64 hosts scanned under both `observe` and
`accept-all`, zero gained and zero lost, so there is no arm to defend and no
conditional caveat beyond the standard one.

Its cost is prevalence, and the arithmetic below is about paying that cost
honestly rather than legislating it away.

## Defect 1: the drafted reference protocol cannot detect our own errors

`docs/calibration-prereg-drafts/plan-cname-uncloaking.draft.json` says:

> Each labeler independently reviews the blinded per-case evidence bundle,
> **including recorded DNS chains**, and asserts present when a first-party
> subdomain resolves through a CNAME chain to a documented tracking vendor
> **per the protocol's vendor list**.

Both emphasised inputs come from this project. The recorded chain is what our
resolver returned. The vendor list is our catalog. A labeler reading them is
independent of our *classifier* and of nothing else. If our resolver follows a
chain wrongly, or our catalog has never heard of a tracking vendor, the
reference makes the identical mistake and the study reports the agreement as
accuracy. Independent labelers do not help: two people reading the same wrong
input agree perfectly.

The replacement protocol takes nothing from the scanner:

- **Chains** are resolved by the reviewer through a resolver they name, and the
  exact `dig` command that reproduces each answer is written into their
  worksheet. DNS is location- and time-dependent, so the resolver and the
  timestamp are part of the label, not context around it.
- **"Is this a tracking service"** is decided against an external, publicly
  published list the reviewer pins by SHA-256. Catalog gaps then become real
  false negatives instead of invisible ones.
- **Candidate hostnames** come from the reviewer's own browser capture (a HAR,
  which no code here produces), never from a scan report.

`npm run calibration:cname-reference` implements this. It is a reviewer's
instrument, not an oracle: it proposes a label and shows the evidence, and the
reviewer forms their own judgement and seals their own source. Automating the
reviewer away would rebuild the same single point of failure from the other
side. A guard test asserts the module imports nothing but Node builtins, because
the independence claim is worth exactly as much as that check.

One scope rule matters and is easy to get wrong. The reference must draw the
same candidate boundary as the detector, which skips only the registrable apex
(`lib/cname-uncloaking.ts` `cnameCloakCandidates`). A reference that enumerates
subdomains from certificate transparency instead would find cloaked hosts the
page never contacted, and score the detector wrong for correctly ignoring them.
That is a scope difference, not a detector error.

### The two declared recall ceilings

The detector sees only subdomains contacted during one visit, and resolves at
most `maxHosts` of them (the scanner passes `MAX_CNAME_LOOKUPS = 10`, lib/scanner.ts; the library default of 12 is not what ships). Both are already handled correctly and neither is
a hidden false-negative source:

- Truncation sets the detector ledger to `partial` / `evidence-cap-reached`
  (`lib/scanner.ts:2380`), a probe failure sets `failed`, an unavailable budget
  sets `skipped`.
- The producer censors any case whose ledger is not `complete`
  (`scripts/calibration-study-lib.mjs:1166`), so a truncated lookup becomes an
  `eligibility-criteria-not-met` censored case rather than a scored negative.

The reference instrument mirrors this: a case where any candidate failed to
resolve is marked `determined: false`, because a reference that could not look
cannot honestly answer "absent".

Under zero-censoring these become population boundaries rather than error
sources: **the declared population must exclude sites whose visit exceeds the
lookup cap**, and the study must say so.

## Defect 2: the drafted frame is sized to fail

The draft specifies 400 cases drawn from a pool that is "half likely-positive
strata and half likely-clean strata". Measured prevalence in the richest strata
is 39% (13 of 33 commercial hosts across finance, health and news), and near
zero in the reference/government/open-source half, so that pool's base rate is
about 0.20.

`referencePresent` must reach 100. At p = 0.20 and N = 400:

| pool base rate | N=300 | N=400 | N=500 | N=600 | N=750 |
|---|---|---|---|---|---|
| 0.20 | ~1 | **0.99** | 0.48 | 0.017 | 6.7e-7 |
| 0.25 | ~1 | 0.48 | 3.6e-3 | 3.4e-7 | 1.1e-15 |
| 0.30 | 0.88 | 1.2e-2 | 1.5e-7 | 1.7e-14 | 2.0e-27 |
| 0.40 | 7.4e-3 | 9.7e-11 | 3.5e-22 | 9.0e-36 | 1.0e-58 |
| 0.50 | 2.0e-9 | 4.3e-25 | 2.1e-44 | 6.7e-66 | 1.0e-100 |

(`P(referencePresent < 100)`, binomial.)

The drafted design has roughly a **99% chance of missing the positive floor**,
before censoring is considered at all. The draft's own target population
concedes this - "the study accepts the risk that the floor is not reached" -
but a one-shot ceremony that cannot be re-run should not be aimed at a 1%
success rate.

### Why the answer is a smaller frame, not a larger one

The instinct is to raise N. That makes it worse, because the two constraints
pull in opposite directions. `censored-cases-present` fires on *any* censored
case, so ceremony survival decays exponentially in N:

| per-case capture reliability | N=300 | N=400 | N=750 |
|---|---|---|---|
| 0.990 | 4.9% | 1.8% | 0.1% |
| 0.995 | 22.2% | 13.5% | 2.3% |
| 0.999 | 74.1% | 67.0% | 47.2% |
| 0.9995 | 86.1% | 81.9% | 68.7% |

SCOPE NOTE (step-5 correction): everything below conditions on an ASSUMED
pool base rate of 0.50 that no independent evidence justifies, and on the
superseded zero-censoring rule. The arithmetic stands as arithmetic; the
assumption does not stand as a design input. The current draft assumes no
base rate, sizes from the sweep's cluster-aware loss bound plus an
independently justified prevalence estimate for the declared scope, and
conserves cap-exceeding visits under policy C instead of excluding them.

The positive floor needs about 100 successes; the censoring rule punishes every
additional case. So the design should **raise the pool's base rate to lower N**,
not raise N to reach the floor. A declared, deliberately high-prevalence
population with N around 300-350 dominates a broad pool at N=750 on both axes
simultaneously.

This forfeits nothing the analyzer checks. `sampling: "simple-random"` requires
an equal-probability draw *within the declared population*; it does not require
that population to resemble the web. The honesty is carried by
`targetPopulation` and by the analyzer's own `conditionalRateClaim`, which
prints the population into every quoted rate. A rate for "finance and news
sites of this kind" is a real, useful, checkable claim. A rate for "the web" was
never on offer at any frame size.

### Sizing the detector's own denominators

`predictedDetected` must also reach 100, and it is not `referencePresent`. At
recall r it is roughly `r x referencePresent + falsePositives`. Sizing so that
`E[referencePresent] = 100` leaves `predictedDetected` short whenever recall is
below 1:

- E[present] = 150, recall 0.70 -> predictedDetected ~ 105. Marginal.
- E[present] = 175, recall 0.70 -> predictedDetected ~ 123. Clears.

So the frame should target **E[referencePresent] ~ 175**, i.e. N ~ 350 at a
pool base rate of 0.50. At that size `P(referencePresent < 100)` is
approximately 1e-11 and the floor stops being a risk worth reasoning about.

The Wilson ceiling is not a binding constraint at these sizes. At n = 100 the
95% half-width is 0.096 at an estimate of 0.5 and narrower everywhere else, so
the policy's `>= 100` denominator floor and its `<= 0.1` half-width ceiling are
consistent by construction:

| estimate | 0.50 | 0.70 | 0.80 | 0.90 | 0.95 |
|---|---|---|---|---|---|
| half-width at n=100 | 0.096 | 0.089 | 0.078 | 0.060 | 0.045 |

## The honest expected outcome

With N = 350 and a pre-qualified pool, the dominant risk is no longer the
denominator. It is the zero-censoring rule meeting the open web.

**This section's premise is superseded.** It was written when the committed
corpus held six r2 runs, all clean, so per-case reliability was unmeasured and
the ceremony survival odds it originally stated were derived from assumed
per-case reliability figures, not from data. The corpus refreshed at #144
one day later: it now holds **126 r2 runs, 73 of them carrying capture-loss
censoring**, and
[research/calibration-censoring](../research/calibration-censoring/README.md)
measures the declared arm's all-family zero-loss rate at **44.3%**.

At that rate a zero-censoring ceremony is not a long shot, it is not a study at
all, which is what the decision package concluded. No survival probability
should be written into the preregistration from a single per-case figure either:
failures cluster by batch and build, so an i.i.d. exponent is not defensible.
The nearest measured analogue is the 88.5% CNAME-scoreable rate, and 0.885^350
is indistinguishable from zero under any mapping.

The retained lesson is the one below, not the arithmetic above it: the expected
outcome belongs in the preregistration, because
it is the design's most likely failure mode and stating it in advance is
what stops a later ceremony from being quietly retried until one passes. The
ops document is explicit that a failed, cancelled or duplicated attempt remains
in the server history and makes the ceremony ineligible: the study is one shot,
and "ineligible, here is why" is the designed behaviour of a correct pipeline,
not a defect in it.

## What is already built, and what remains

Built and verified:

- The analyzer, its 20 ineligibility reasons, Wilson intervals, and the
  fail-closed layering (`lib/detector-calibration.ts`).
- The prediction seam for every detector, including `cname-uncloaking`, with
  both recall ceilings censoring correctly
  (`scripts/calibration-study-lib.mjs:1154`, `scripts/calibration-study-acquire.mjs:168`).
- Independent recomputation of every prediction by the binding verifier
  (`lib/measurement-candidate-binding.ts:5494`).
- The independent reference instrument and its guard tests
  (`npm run calibration:cname-reference`).
- Reader-facing calibration status, derived at render time and refusing to
  quote a rate that would not clear the release policy
  (`lib/detector-calibration-reader.ts`).

Remaining, and none of it is code:

1. A human policy approval recorded in `RELEASE_READINESS.json`.
2. A candidate-resident preregistration and frame built from a declared
   high-prevalence population, with the pre-qualification sweep run as a bare
   load check that never evaluates the detector - a full scan before the frame
   is sealed would mean predictions were seen before preregistration, voiding
   it.
3. Two to ten distinct authenticated reviewers sealing full-frame label sources,
   plus one precommitted blind tiebreaker.
4. A protected reveal environment, a single-use controlled runner with stable
   egress, and isolated Sigstore attestation.

Until (1) through (4) happen, no rate publishes, and every report says so.
