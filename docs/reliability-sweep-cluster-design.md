# Step-5 reliability sweep: the cluster design

Preregistered before any collection. This document amends the two-pass
collection plan and supersedes it: the merge landing this design is the
collection SHA both the eligibility pair and every sizing round bind to, and
the "final step-4 SHA" note in
[calibration-v4-reference-architecture.md](calibration-v4-reference-architecture.md)
is superseded accordingly.

## Why two passes were not enough

The adopted censoring decision sizes per-detector policies from a defensible
detector-input loss bound. The repository's own censoring analysis is
explicit about what defensible means: its cluster bootstrap refuses fewer
than three clusters outright
(`scripts/cluster-interval-lib.mjs`, extracted verbatim from
`research/calibration-censoring/analyze-corpus-censoring.mjs` with the
committed findings' byte-exact reproduction as proof), and its README records
that a per-case Wilson endpoint over two clusters "is not a defensible design
lower bound", only an iid diagnostic. The two-pass caller produced exactly
two time clusters and descriptive counts, so the loss bound the decision
requires was uncomputable by the repository's own standard.

## The design, fixed before collection

- **Cluster unit: the collection round.** One round is one contiguous
  collection session over the entire candidate set, under one build, runner,
  egress, and measurement condition.
- **Rounds are disjoint sessions.** Every round begins at least
  `SWEEP_MINIMUM_ROUND_SEPARATION_MS` (24 hours) after the previous round's
  last observation, enforced at assembly. Two rounds an hour apart mostly
  re-measure one web state, which is the two-cluster problem by another
  route.
- **Rounds 1 and 2 remain the eligibility pair**, at least 48 hours apart
  per case, exactly as before: a candidate joins the eligible pool only if
  both are bare-load valid. Eligibility semantics are unchanged by this
  design.
- **Scheduled rounds: 5. Minimum usable for the bound: 4**
  (`SWEEP_BOUND_MINIMUM_ROUNDS`), one above the bootstrap implementation's
  own hard floor of 3, which is the implementation's bare minimum, not a
  design target. If attrition leaves fewer than 4 usable rounds, the remedy
  is MORE ROUNDS, and nothing else.
- **Bound method**: the repository's one cluster-bootstrap implementation,
  shared with the censoring analysis: resample rounds with replacement,
  4000 iterations, fixed seed 20260816, report the 2.5% and 97.5%
  percentiles. Bounded quantities: the bare-load-valid fraction, the
  all-families-complete fraction (the conservative per-detector scoreable
  floor), and the per-family censor fractions for all six evidence families.
- **Fail-closed, never iid.** Below 4 usable rounds the bound command
  throws; it never emits a Wilson interval, a wider interval, or a partial
  artifact. Identity or condition drift between rounds refuses assembly as
  two sweeps. A partial round is re-run, never assembled. There is no code
  path from insufficient clusters to any published number.
- **The frame producer sizes from the bound artifact and nothing else**:
  not from the receipt's descriptive counts, not from a console line, not
  from any single round.

## Collection procedure

One `collect <round>` invocation per round (rounds 1 to 12 accepted; 5
scheduled), all on the identical collection SHA from an isolated worktree,
with identical `SITE_BEHAVIOR_LAB_BUILD_COMMIT`, `SWEEP_RUNNER_LABEL`,
`SWEEP_EGRESS`, and the fixed desktop / observe / GPC-off condition. Then
`receipt` over all round artifacts, then `bound` over the receipt. The
receipt binds the candidate set and every round artifact by digest; the
bound artifact binds the receipt by digest and records the method
parameters, so a stranger can recompute every number.

## Prevalence and sizing

The withdrawn 0.50 base-rate assumption is not replaced by another
assumption. Prevalence for the declared scope is estimated from the
PRECOMMITTED DISJOINT PILOT, preregistered here in full:

- **Partition, not prefix.** The universe builder fixes ONE sampling frame
  (the first pilotSize + poolSize scoped survivors in source order) and
  splits MEMBERSHIP by a seeded Fisher-Yates shuffle
  (`seeded-fisher-yates-sha256-v1`). A prefix pilot would confound the
  estimate with popularity rank, which can correlate with CNAME deployment.
  The seed derives entirely from the committed inputs (study id, source and
  category digests, exclusion-list digest, the two sizes), so there is no
  free parameter through which a partition could be steered, and any auditor
  re-derives the identical split from the artifacts alone. The provenance
  records the method, seed, and frame size.
- **Pilot size**: at least `PREREGISTERED_PILOT_MINIMUM` = 100, because the
  Wilson 95% half-width at the worst case (p = 0.5) is 0.096 at n = 100,
  inside the programme's 0.10 half-width convention. The builder refuses a
  smaller pilot: no prevalence estimate, no universe.
- **Labeling**: reviewers label the pilot under the independent reference
  protocol, never the detector's own output; the pilot's sites are excluded
  from the confirmatory pool by construction.
- **The exact sizing rule** (`deriveFrameSizeFromPilot`,
  scripts/calibration-pilot-sizing-lib.mjs): with [pLower, pUpper] the
  pilot's Wilson 95% interval, N is the SMALLEST integer such that
  P(Binomial(N, pLower) >= minimumPerClass) >= 0.99 AND
  P(Binomial(N, 1 - pUpper) >= minimumPerClass) >= 0.99, computed with the
  exact binomial tail. Both reference classes are guarded at their own
  conservative endpoint; under the v4 side-separated model the reference
  margins do not depend on scan-side completeness, so this rule converts
  prevalence uncertainty alone, and the prediction-side margins remain the
  study preregistration's detector-specific power calculation against the
  sweep's loss bound.

FAIL CONDITION (`assertFrameFeasible`): a derived N larger than the swept
eligible pool is infeasibility, and the remedy is a larger universe plus
fresh sweep rounds over the enlarged set, never a relaxed exclusion, a
reused pilot site, or a population narrowed to fit. The function offers no
parameter through which any of those could be expressed.

## What this design does not decide

No frame size, no threshold on the bound's value, and no candidate set. The
candidate universe is constructed independently of scanner results under the
frame-construction rules, and whether the bounded loss and the pilot's
prevalence estimate support any given N under the per-detector policies is
the frame producer's preregistered arithmetic, taken against the bound
artifact after collection.
