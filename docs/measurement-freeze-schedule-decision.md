# Measurement-freeze schedule decision, 2026-08-20

## Adopted

**Decision: adopted as proposed.** Do not attempt freeze activation by
2026-09-06 UTC; let the date pass deliberately and select a new candidate
window once the calibration censoring policy is settled.

- decidedBy: iAnonymous3000
- decidedAt: 2026-08-23T01:28:05Z (14 days before the declined deadline)

This record lives here rather than in `RELEASE_READINESS.json` because the
slip is a schedule decision, not a release decision: the manifest's
`decisions-approved` gate governs release decisions and validates every entry
it finds, and no readiness gate resolves against a schedule record. The
enforcement of this decision is the calendar constants themselves
(`scripts/featured-readjudication-lib.mjs`), which stay frozen until step 6 of
the adopted path below edits them under a new candidate.

Facts re-verified at adoption, at `010a7a1` (they had been drafted at
`e0fb9b3`): readiness still reports 14 of 18 gates failing;
`research/measurement-candidate-binding.json` still does not exist; the
open-proposal set is now five (#169 to #172, #178; #176 merged 2026-08-21).

The adopted sequencing, superseding the ordering sketch at the end of this
document where they differ:

1. This adoption.
2. Draft the per-detector claim/reference/censoring/estimand matrix.
3. Re-decide the censoring policy against that matrix; retain-or-replace,
   potentially per detector. `complete-case-only-zero-censoring` is formally
   `approved` in the manifest, but the same record calls it near-unsatisfiable
   and warns against treating availability as a recommendation, so step 3 is a
   deliberate decision, not a missing approval.
4. Implement the required analyzer behavior and the reliability-sweep caller.
5. Run the fresh multi-cluster sweep; close proposals and provision the
   controlled environment.
6. Edit the frozen schedule constants, create a new candidate, and complete
   two fresh Monday gallery cycles.
7. Freeze that candidate.
8. Only then collect candidate-bound calibration studies, the qualifying
   corpus, runner cycles, and controlled publications.
9. Complete durable activation and the 168-hour soak, operational
   attestations, and legal/package reviews.
10. Re-evaluate the critical-use claim boundary separately from the lean 1.0
    gate.

The argument for the decision is the drafted text below, unchanged except
that the open-proposal count and its examples were refreshed at adoption.

## The decision being proposed

**Do not attempt freeze activation by 2026-09-06. Let the date pass
deliberately, and select a new candidate window once the calibration policy is
settled.**

## Why the date exists at all

Activation is calendar-bounded by constants, not by preference.
`FEATURED_READJUDICATION_DATES` is frozen at `2026-08-03` and `2026-08-10`
(`scripts/featured-readjudication-lib.mjs`), activation must occur within
`FEATURED_READJUDICATION_ACTIVATION_MAX_AGE_DAYS` of 28 days of the later
cycle, and every deferred domain in `research/ops-receipts/featured-readjudication.json`
carries `reviewAfter: "2026-09-07"`, which must be strictly later than
activation. Those three together put the last admissible activation at
2026-09-06 UTC.

Missing it is not free. Re-dating requires editing a frozen constant, which is
itself a code change, which requires a new measurement candidate and two fresh
Monday gallery cycles. That cost is real and is the reason to decide
deliberately rather than drift.

## Why the date should be allowed to pass

Readiness reports **14 of 18 gates failing** at `e0fb9b3`. None is an
engineering capability gap; `research/measurement-candidate-binding.json` does
not exist, so candidate `C` has never been selected, and five proposals remain
open against a required zero-open set.

The heavier reason is upstream of any gate. The freeze exists so that
calibration has a stable identity to bind to, and a calibration study's
eligibility is perishable by construction. Freezing now would bind an epoch to
`complete-case-only-zero-censoring`, a policy whose own record in
`RELEASE_READINESS.json` states that human review is required and warns against
approving the selection. The censoring policy is not a parameter that can be
adjusted afterwards: its identifier is a typed literal read by the analyzer,
the producer, and the readiness gate, so changing it after `C` is a code change
that invalidates the candidate.

So the sequence that fits in the remaining days produces an epoch on which the
intended study cannot complete. The sequence that produces a usable epoch does
not fit in the remaining days. Preferring the date over the second sequence
would mean freezing an instrument whose accuracy is unmeasurable by the
programme it was frozen for.

## What this decision explicitly does not authorize

Recovering schedule by weakening anything. Specifically not: reducing
provenance or attestation requirements, relaxing labeling independence or the
sealed-window discipline, lowering a denominator or interval threshold,
admitting a study that its own policy would refuse, or narrowing the population
a claim covers in order to make a target reachable. If the schedule and the
evidence bar conflict, the schedule yields. That is the whole point of
declaring the slip rather than absorbing it.

## What has to happen before a new window is chosen

In order, each blocked by the one above it:

1. A per-detector matrix: for each detector, the exact claim being calibrated,
   the independent reference source, admissible evidence, the censoring unit
   and its reasons, the estimand under missingness, and whether the result is
   accuracy, vendor-presence agreement, or rule conformance.
2. The censoring policy decision, which may be per-detector rather than global,
   taken against that matrix.
3. Analyzer work implementing whatever the decision requires. Only policy A
   exists in production code today.
4. A caller for the reliability sweep. The library is complete and tested and
   nothing invokes it, so making the sweep a prerequisite is engineering, not a
   procedural note.
5. A fresh multi-cluster sweep, then operator provisioning and the zero-open
   proposal set.

## One number to stop misusing

The 44.3% all-family zero-loss rate comes from 61 development runs across two
clusters. It is strong evidence that the current policy is operationally
unsuitable. It is **not** a defensible open-web completion probability, and it
should not be quoted as one, including in this document's own argument above.
The argument here rests on the policy's structure, not on that figure.
