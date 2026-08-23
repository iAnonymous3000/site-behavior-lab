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
PRECOMMITTED DISJOINT PILOT: a prefix slice of the same externally defined
universe, carved by the universe builder before any collection, disjoint
from the confirmatory pool by construction, and labeled by reviewers under
the independent reference protocol, never by the detector. Frame size N then
derives from the pilot's prevalence estimate, the sweep's loss bound, and
the per-detector publication profile, with the derivation recorded in the
study preregistration. FAIL CONDITION: a derived N larger than the swept
eligible pool is infeasibility, and the remedy is a larger universe plus
fresh sweep rounds over the enlarged set, never a relaxed exclusion, a
reused pilot site, or a population narrowed to fit.

## What this design does not decide

No frame size, no threshold on the bound's value, and no candidate set. The
candidate universe is constructed independently of scanner results under the
frame-construction rules, and whether the bounded loss and the pilot's
prevalence estimate support any given N under the per-detector policies is
the frame producer's preregistered arithmetic, taken against the bound
artifact after collection.
