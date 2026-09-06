# V1 release qualification

Approved in the project task on 2026-09-06. V1 lets a user investigate a visit,
inspect the recorded evidence, and share conclusions that remain within that
evidence. This approval changes the requirements; it does not approve a release
or certify evidence that has not been collected.

`RELEASE_READINESS.json` selects `investigative-v1`. Its complete gate set is
enforced: deleting a gate or changing its kind is a refusal. The previous
research contract is preserved verbatim in
`docs/release-gate-history/research-program-2026-09-05.json`. Existing research
verifiers and historical reports, schemas, receipts and approvals remain intact.

## What must hold

| User promise | Release requirement | What it does not establish |
| --- | --- | --- |
| Inspect a truthful observation | Current deep readers and consistency checks; bounded independent mode review | Population accuracy or detector error rates |
| Understand uncertainty and interventions | Review unknowns, scanner effects and interpretation, including an incomplete visit | That a covered negative is universal absence, or an intervention proves compliance |
| Reopen and share the same meaning | Review display, comparison, persistence and export against retained evidence; compatibility and corrections gates | Reconstruction of observations never recorded |
| Use a safely operated service | Authenticated production egress, admission, retention, lifecycle and exact-image distribution evidence | Reliability of disabled durable jobs |
| Identify the shipped instrument | Source-bound CI evidence, an evidence-only carrier, external binding approval, promotion and live verification | Correctness merely because a build passed |

## Bounded qualification

Retain one case for each obligation: `single-observation`, `gpc-intervention`,
`blocker-intervention`, `consent-intervention`, and `incomplete-coverage`.
These are coverage obligations, not a statistically representative sample.
The comparison cases require an actually verified pair on the correct axis.
The incomplete case requires recorded loss or failed document coverage.
Consent remains experimental even when this bounded review passes.

For each case, retain the current v2/r2 report, an independently captured
reference, and a concrete expectation. A reference can include a controlled
server's request log, a separately recorded browser trace, or a manual inspection
record. A copy of the report's own conclusions is not independent evidence.
Retain failures and contradictions encountered during qualification; resolve a
contradiction by fixing the candidate and recollecting, not by marking it passed.
The review is limited to these cases and explicitly describes remaining gaps.

The named review at `research/v1-qualification/review.json` has schema version 1,
artifact kind `site-behavior-v1-mode-qualification`, `candidateCommit`,
`reviewedBy`, `reviewedAt`, `cases`, and `limitations`. Each case contains `id`,
`mode`, `report`, `reference`, `expectation`, and `checks`. Checks cover
`observations`, `unknowns`, `scanner-effects`, `interpretation`, `display`,
`comparison`, `persistence`, and `export`. Each records `status`, a bound
`evidence` path, and an `explanation`. Shipped behavior must be `supported`;
only comparison on a single visit can be `explicitly-unavailable`.

Reports live at `research/v1-qualification/<case>/report.json`; references and
inspection records use `reference` or `review-evidence` with `.json`, `.txt`, or
`.png` extensions. The verifier deep-reads every report, checks intervention
identity and acquisition chronology, and requires all referenced bytes in the
binding. Human review still has to establish independence and correctness of
the references. These checks cannot authenticate a person's observations on
their own. The externally pinned whole-binding review remains mandatory.

## Source and evidence sequence

1. Finish source, configuration, release metadata, compatibility decisions and
   reusable license materials. Select a tested commit **C**, with durable jobs,
   sharding and watches still disabled. Run the existing main CI and production
   verification. Selection does not require a Monday, a scheduled collection or
   enabling a disabled feature.
2. Collect qualification and authentic operator evidence on C or an evidence-only
   descendant. Retain the existing CI container evidence, package inventory and
   their Sigstore bundles. Complete the exact-image package review. Provider
   evidence still needs its existing authenticated capture, freshness and
   failure-probe checks. A hand-written statement cannot replace those proofs.
   `node scripts/release-attestation-scaffold.mjs --gate <gate-id>` can prepare
   the operator review from canonical evidence before the binding exists. Its
   statements remain false and its approval fields empty; it grants no release
   authority and cannot pass readiness.
3. Add `research/v1-release-binding.json` in the final evidence carrier **S**.
   It has schema version 1, kind `site-behavior-v1-release-binding`, repository,
   target release `1.0.0`, C's full `candidateCommit` and `candidateTree`, and an
   `evidence` array of `{category, path, change, sha256}` entries. The verifier
   restricts entries to the fixed evidence paths and checks every C..S commit.
   All evidence is introduced once; only the container review ledger may be
   refreshed once. Code, configuration, existing reports, policies and workflows
   cannot change after C. A source fix requires a new candidate and recollection.
4. Run `npm run release:readiness:check`. Independently verify and hash the whole
   binding, then select that digest with the existing
   `RELEASE_MEASUREMENT_BINDING_SHA256` variable. Its historical variable name is
   retained. The release workflow selects the v1 artifact path and authenticates
   the raw bytes again before obtaining release authority. Governance selection,
   exact-S CI checks, artifact attestation, promotion App and live checks remain.

This smaller binding does not feed calibration readers or authorize calibrated
claims. The old `research/measurement-candidate-binding.json` remains the
research programme's separate contract. Its freeze, controlled-runner,
publication, calibration and durable prerequisites are not silently relaxed.

## Benchmarks and research

The existing 50-site per-metric floor still governs whether a benchmark can be
shown. It is not an accuracy threshold or a universal v1 prerequisite. The new
release gate recomputes the complete published corpus through the canonical
managed reader and compares every cohort, denominator, percentile and coverage
field. Small or unavailable cohorts are valid when they remain unavailable to
benchmark consumers. Historical data need not be recollected to stay readable.

Formal error-rate calibration and A/A remain a separate 1.1 milestone. Scheduled
research publication and durable activation retain their own qualification
requirements. No additional report redaction or measurement schema revision is
introduced here.

## Remaining blockers

The contract does not supply the missing mode review, source binding, external
governance selection, current lifecycle/provider evidence, or completed
dependency and exact-image license reviews. In particular, the existing egress
and log-retention gates still refuse caller-supplied provider evidence where a
trusted hosted capture is unavailable. Those are concrete operational evidence
gaps to close before v1, not reasons to restart the research calendar.
