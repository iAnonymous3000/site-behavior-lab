# Release gates: purpose, evidence and remaining work

**2026-09-06 scope update:** the table below records the earlier research-coupled
contract. [V1 release qualification](v1-release-qualification.md) supersedes its
v1 sequencing and universal collection requirements. The original manifest is
preserved verbatim in `release-gate-history/research-program-2026-09-05.json`.
The corpus consistency correction described here remains enforced, now across
all published cohorts.

The product turns a website visit into inspectable evidence. A useful gate must
protect a concrete claim, contain a concrete operational risk, or preserve the
ability to identify and interpret an artifact later. Its evidence must address
that property. Passing unrelated tests, accumulating receipts, or reaching a
sample-size threshold cannot substitute for it.

The existing separation between main CI, production promotion and the v1 release
ceremony is appropriate. Routine changes go directly to main. Production still
requires the five jobs in `.github/required-ci-jobs.json`, attested artifacts for
that exact source, and the promotion App. A v1 tag additionally requires the
release evidence. Re-running a container build in Cloudflare would not add a new
kind of evidence; deploying the already tested image does. Live health still
matters because artifact tests cannot establish that production is configured
or operating correctly.

## Problems corrected

1. **The corpus gate did not verify the statistics it authorized.** It checked
   denominator floors, the cohort identity, distinct-site count and recency, but
   did not compare the published metric distributions with the bound reports.
   Its separate population implementation also omitted correction suppression
   and duplicated recency and eligibility logic. It now uses the canonical aggregation
   rules and compares every primary-cohort metric denominator and percentile,
   including absent metrics. Both the cohort and top-level compatibility view
   must agree with the bound observations. The artifact must also pass the same
   current-version structural validator used by consumers.
2. **Tests required missing evidence to remain missing.** The committed-manifest
   test pinned failing statuses and a null runner environment. Valid new evidence
   could therefore break CI. Tests now pin the gate identities, governance
   settings and deferrals, while controlled cases exercise acceptance and refusal.
   No gate, required job, threshold, freshness window or approval was removed.
3. **The plan confused candidate selection with binding finalization.** Selection
   and freeze precede collection; the complete candidate binding includes the
   resulting evidence and must be finalized afterward. The plan now distinguishes
   those steps. CLI output also explains that unsatisfied checks can share missing
   prerequisites and that READY is not an accuracy certification.

The aggregation refactor preserves the existing public contract. A fixed-time
rebuild of the entire committed corpus was identical before and after: 94 primary
sites across nine cohorts. Independent test cases specify the expected nearest-rank
statistics for observations `[1, 2, 7]`, exclude an older repeat and a corrected
report, and keep a failed detector out of its metric denominator. Mutations of
every reported distribution field are rejected. This establishes structural and
internal-consistency behavior, not real-world detector accuracy.

## What the existing gates protect

| Gate | Property and evidence | Scope or invalidation boundary |
| --- | --- | --- |
| `decisions-approved` | Named approval of the claim boundary, compatibility and selected release policies | Approval covers the recorded decision bytes, not measurement results. The calibration policy identity remains governed; formal calibration results remain deferred. |
| `release-tag-governance` | Current, authenticated control of tag creation and production promotion | Capture is selected by a trusted digest and expires after one day. A local unsupplied digest is an unmet ceremony input, not proof that production is broken. |
| `measurement-candidate-binding` | Reports, provenance and operational receipts belong to the selected candidate and evidence carriers | Full verification binds exact bytes, source history and authenticated artifacts. It cannot be finalized before evidence collection. |
| `measurement-freeze` | Governed activation establishes the candidate and collection boundary | Pre-freeze or differently produced observations cannot silently become current-candidate evidence. |
| `compatibility-surface-pinned` | The released promise matches its approved document | The digest protects the promise; reader and workflow tests exercise its implementation. Historical artifacts stay readable. |
| `errata-resolution` | Known frozen-schema mistakes have an approved, visible disposition | Preserve the original schemas and publish companion corrections. A corrected explanation is not a repaired historical measurement. |
| `current-method-corpus` | The published primary cohort and distributions follow from the bound reports | Retain the 50-site per-metric floor used for descriptive benchmark availability. It establishes neither representativeness nor an error rate. Failed or unavailable measurements cannot become zeros. |
| `legal-review` | Runtime dependencies have recorded distribution and license reviews | Reconcile against the exact inventory. An unreviewed item is not automatically a vulnerability; automation must not invent a reviewer. |
| `runner-cycles` | Two distinct collection cycles use the reviewed environment and verify destruction | These receipts establish the recorded collection and cleanup procedures, not statistical replication or instrument accuracy. |
| `controlled-publications` | Published reports trace to the two controlled collections and archived bytes | Distinct from counting scans: this closes the collection-to-publication chain. Keep failed attempts visible in the applicable study ledger. |
| `r2-lifecycle` | A current authenticated rule readback backs the retention claim | Configuration can drift; a successful create/read/delete health probe does not prove lifecycle expiry. |
| `release-receipt-archive` | A release receipt can be independently read and verified after the workflow | Historical archive success proves the lane, not freshness or success of the new release. |
| `durable-soak` | The selected recovery promise agrees with enabled production features | With explicit failure/safe retry and all durable features disabled, PASS means scope conformance. Activation restores the authenticated soak obligations. |
| `egress-backstop` | Provider enforcement constrains scanner network access outside application code | Requires canonical hosted evidence and a matching attestation. Unit tests of URL validation cannot establish provider enforcement. |
| `waf-ceilings` | Provider limits bound public scanner exposure | Evidence must describe the deployed account and configuration, not an intended setup. |
| `log-retention` | Actual logging and retention match the published operational promise | Current provider evidence and attestation are needed; application source alone is insufficient. |
| `container-image-licensing` | The exact distributed image meets the declared licensing obligations | Bind the image, evidence and attestation; a reviewed npm inventory alone does not cover the OS image. |
| `container-package-review` | The image package inventory, authenticated provenance and review ledger agree | A changed image/package set invalidates the corresponding proof. Preserve exact-image provenance rather than reusing a nearby build's review. |

These checks are conjunctive, not independent estimates of progress. Missing
candidate binding, freeze, runner selection and hosted evidence account for
several downstream failures. Report those prerequisites before counting individual
failed checks. Do not convert a dependent failure into PASS or treat it as proof
of a defect in the underlying service.

## Evidence that remains separate

- **Structural validity:** parsers and schema checks admit the recorded shape.
- **Internal consistency:** independently specified cases, derivation checks and
  source binding show that consumers use those observations consistently.
- **Operational reliability:** Docker, browser and hosted smoke tests exercise
  specific paths; continued health observations establish only their measured
  duration and conditions. The R2 lifecycle configuration needs its own evidence.
- **Real-world accuracy:** mode qualification needs independent expectations and
  retained attempts on the current candidate. Scanner-fidelity invariants and
  repeatability help diagnose problems but cannot supply ground truth.

Formal detector error-rate calibration and A/A studies remain the separately
governed 1.1 milestone. Removing or hollowing their explicit deferral records
restores their requirements. Do not publish calibrated-accuracy or stronger
causal claims before the corresponding evidence exists. Consent remains visibly
experimental pending qualification. Additional report redaction stays out of scope.

## Work in impact order

1. Qualify the advertised modes against independently recorded expectations on
   the candidate. This addresses whether users can interpret the reports correctly;
   a larger old corpus or green CI cannot close it.
2. Select the current candidate and reviewed collection environment, activate the
   governed freeze, and collect the current-method corpus with controlled runner
   and publication evidence. Finalize the binding only after its inputs exist.
3. Complete the runtime and exact-image license reviews and capture the missing
   provider controls, lifecycle and governance evidence. This work can proceed
   alongside qualification where it does not depend on the final image/source.
4. Run the trusted release ceremony against the complete binding, then verify the
   resulting public artifacts and deployed source. No readiness percentage or
   deployment health result substitutes for the unmet evidence above.

The historical freeze-schedule and calibration approval records remain historical
records. Their dates and approvals must not be rewritten to manufacture a current
candidate. Use the existing governed selection and evidence workflows.
