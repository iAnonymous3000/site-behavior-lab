# Repeated effects and detector calibration

Status: the analysis contracts are implemented. Population-effect and detector-
accuracy claims remain unavailable until the external evidence gates below are
completed.

This layer is additive. It does not alter ScanReport v2/r1 or v2/r2, their JSON
Schemas, or their frozen hashes. A report remains the observation artifact; an
analysis result is a derived sidecar that can always be regenerated from a
validator-clean report or a separately supplied calibration study.

## Repeated-pair effect analysis

`lib/repeated-effect-analysis.ts` reads an unknown artifact through the shared
version-aware reader and accepts only a v2/r2 intervention comparison. It then
recomputes comparability for the primary pair and every embedded supporting
pair using the evaluator and metric-registry versions recorded by the report.
It never trusts pair counters or a producer-authored aggregate.

The model is metric-scoped. It currently derives absolute count effects
(`variant - baseline`) for raw request/cookie/storage counts, known-tracker
requests, Shields blocked-request counts when present, and distinct
fingerprint-finding kinds. Consent verification has no numeric endpoint in the
frozen wire and is named as unmodeled rather than coerced to a number.

For each metric the output exposes:

- the recorded, eligible, and excluded pair denominators;
- every pair id, AB/BA order, eligibility reasons, baseline, variant, and
  signed delta;
- positive, negative, and zero-effect counts;
- arithmetic mean, median, and observed effect range only when every recorded
  pair is eligible; and
- whether at least two counterbalanced pairs show a same-direction, nonzero
  *observation*.

One failed, unverified-intervention, family-censored, incompatible, or
unavailable pair suppresses the entire metric aggregate. The model never drops
that pair and estimates from a quieter complete-case subset. Invalid,
older-revision, non-intervention, and over-limit inputs fail closed.

`repeatedDirectionalObservation` is descriptive bookkeeping, not a replicated
effect. Every result keeps population effect, confidence interval, replicated-
effect wording, and causal wording disabled. Frozen r2 records neither a
sampling frame nor pair independence, pre-registration, endpoint selection,
stopping rule, or a variance model; manufacturing an inferential interval from
two or more embedded pairs would therefore add facts the artifact does not
contain.

### External gate for inferential repeated-effect claims

A later claim-bearing revision or digest-bound analysis sidecar would need, at
minimum, a preselected sampling frame, one prespecified metric endpoint and
direction, pair independence or an explicit repeated-measures correlation
model, randomized order allocation, stopping and exclusion rules fixed before
outcomes, a sample-size/power rationale, and the complete attempted-pair
denominator. Until that design exists and is executed, the r2 wire continues to
say `observed-difference` even when its descriptive effects align.

## Preregistered A/A repeatability studies

The scanner-fidelity driver records every repeated attempt (including failures
and censored runs) into a digest-bound attempt ledger with per-target metric
spread, third-party-domain Jaccard, AB/BA order counts, and identity-drift
exclusions (`scripts/scanner-fidelity-study-lib.mjs`). Those numbers are
descriptive until a study declares acceptance thresholds BEFORE collecting.

`scripts/aa-study-lib.mjs` defines that contract. A preregistration fixes, in
one committed v2 JSON declared before any scan: the exact study-local
`target-frame.json` path and digest, target count, at least two repetitions per
target, scan conditions, the fixed
`research/measurement-candidate/measurement-identity.json` path and exact-file
SHA-256, and numeric thresholds (per-metric relative-range ceilings, a minimum
pairwise Jaccard floor, an eligible-target floor, a maximum failing-target
fraction, and whether comparison orders must be counterbalanced).
Comparison studies use an even repetition count: the governed producer
alternates AB then BA by repetition, so every target has equal non-zero order
counts by construction rather than merely hoping independent random draws
happen to counterbalance.

The measurement-identity manifest is deliberately separate from
`measurement-inputs.json`. The latter is candidate-residency evidence that
hashes the preregistration, target frame, and policy inputs; embedding its
digest in the preregistration would create an impossible hash cycle. The
identity manifest excludes preregistration and target-frame artifacts and
instead binds the claim-affecting implementation, catalog, list, and runtime
identities. Its digest is the SHA-256 of the canonical file bytes. The attempt
ledger retains the truthful producer build commit as provenance but A/A v2
does not require that post-candidate evidence-carrier SHA to equal a
preregistered build SHA.

`scripts/evaluate-aa-study.mjs` scores a collected ledger against its
preregistration. It first verifies the ledger's exact closed shape, canonical
timestamps, driver-runtime digest, producer-runtime identity digests, and
whole-receipt digest. Any mismatch in measurement identity, target-frame path
or digest, repetitions, conditions, target count, collection ordering, or a
trimmed attempt denominator is an identity violation rather than a threshold
failure. A passing study claims only that repeated automated visits agreed
within the preregistered thresholds on that frozen frame at that exact
measurement identity. It is never a population estimate and never evidence
about a single site. Committed studies live under
`research/aa-studies/<study-id>/` as `target-frame.json`,
`preregistration.json`, `attempt-ledger.json`, and the generated
`evaluation.json`.

Release-grade collection is deliberately separate from the scheduled
scanner-fidelity smoke. Dispatch `.github/workflows/aa-study.yml` on `main`
with the candidate-resident study id and frozen candidate SHA. Its hosted
preflight verifies the candidate inputs, activated freeze, controlled egress,
and exactly one freeze-attested online runner. One self-hosted job then runs
the complete frame unsharded through the process-local scanner, injecting the
private deterministic AB/BA schedule directly into the scan executor; the
public scan API retains its ordinary randomized behavior.

Only after that producer run concludes successfully does
`.github/workflows/archive-aa-study.yml` run. A fresh hosted job reads back the
exact run attempt and artifact metadata, verifies the archive digest,
candidate/frame bytes, complete attempt set, evaluation, runner and egress
bindings, and creates `producer-receipt.json`. The hosted attestation authority
signs that receipt. The final write-capable job has no OIDC or attestation
write permission: it verifies `producer-receipt.sigstore.json`, archives the
exact ledger/evaluation/receipt/bundle bytes, updates the measurement binding,
and opens an `automation/aa-study-*` proposal. The measurement binding
verifies any bound study end to end: the certificate, workflow source/head,
candidate checkout, successful producer run, and artifact digest. A generic
scanner-fidelity ledger or self-authored receipt cannot satisfy that
verification. The A/A gate itself is recorded in `RELEASE_READINESS.json`
`deferredGates` as gating the 1.1 calibrated-claims release rather than 1.0.

## Detector calibration

The public detector matrix is an acceptance-fixture inventory: 18 selected
positive, negative, and adversarial/boundary tests pin known implementation
behavior. Those handpicked fixtures are not a representative labeled corpus
and do not estimate precision, recall, sensitivity, specificity, or accuracy.

`lib/detector-calibration.ts` therefore accepts separate, strict historical
and current study artifacts. A current release-grade study binds:

- schema version 3 and one current detector id;
- the exact source build plus a domain-separated detector-implementation
  digest derived from that Git commit, detector version, and detector-registry
  version/digest;
- the current methodology and normalization versions, tracker-catalog content
  and review-provenance digests, and Brave-list catalog commit, list/rules
  digests, fetch snapshot, and engine version;
- a digest-bound runtime declaration (Node, Playwright, Chromium, operating
  system, and architecture), while each case separately records the complete
  scan-condition fingerprint;
- a named target population, digest-bound sampling frame, selection protocol,
  reference-label protocol, and precommitted blind-tiebreaker protocol;
- the planned case denominator;
- declared sampling, independence, and prediction/reference blinding; and
- one unique case id per planned unit, including explicit censored outcomes
  with an attempt-artifact digest.

Every complete case records the immutable detector-output artifact, the
independent evidence artifact used by reviewers, the resulting label artifact,
two through ten unique opaque labeler ids, and an explicit `labelers-agreed` or
`disagreement-resolved-by-blind-tiebreaker` state. The primary labelers and one
distinct blind tiebreaker commit their complete-frame encrypted label sources
before acquisition starts. The tiebreaker is revealed only after acquisition
and contributes to the final reference value only when the primary labels
disagree; an agreed case records null tiebreaker and resolution-artifact
fields. These fields preserve provenance; the analyzer does not infer,
generate, or repair a reference label.

Any missing planned case, censored case, stale detector identity, stale
build, registry/toolchain/list revision, missing current-build context, or
missing or mismatched independently pinned runtime digest suppresses the
complete confusion matrix and every rate. So does an absent positive/negative
reference class. A malformed digest or a digest that does not recompute from
its declared identity makes the artifact invalid. Nothing is silently excluded.

For an eligible study, the model reports the full confusion matrix and the
numerator and denominator for sensitivity, specificity, precision, negative
predictive value, accuracy, false-positive rate, and false-negative rate. A
zero denominator produces `null`, never a fabricated zero rate.

Convenience samples and declared censuses receive descriptive point rates only.
A study gets Wilson 95% binomial intervals and a conditional target-population
scope only when it declares equal-probability simple-random sampling,
independent units, detector
predictions blinded to reference labels, and reference-label resolution
blinded to predictions. Those intervals remain conditional on truthful, externally
reviewed design metadata; this code cannot prove that the declared protocol was
followed.

### External gate for detector-accuracy claims

No representative calibration study is committed today. Before publishing a
detector-accuracy claim, the project must freeze and digest a target-population
frame, select units without looking at detector output, establish an
independent reference-label protocol with two through ten primary labelers and
a distinct precommitted blind tiebreaker, blind both directions where
practical, retain
every attempted case and censor reason, run the exact released build and
digest-bound detector, registry, catalog, list, methodology, normalization, and
runtime identities, retain the immutable prediction/evidence/label and any
blind-tiebreaker resolution artifacts, and have the study design and labels
reviewed independently. Browser/runtime, first- and third-party, benign
hard-negative, and adversarial cases should match the scope of the claim.
Sample size and any subgroup analysis must be fixed before results are opened.

Committed studies satisfy the machine-readable contract at
`/schemas/detector-calibration-study.v3.schema.json`, which historical
verification continues to run against. The adopted forward contract for all
new ceremonies is the v4 side-separated schema at
`/schemas/detector-calibration-study.v4.schema.json`
(docs/calibration-v4-reference-architecture.md). The immutable v1 and v2
schemas remain available for historical studies; v1 lacks the structured fixed
measurement condition, and neither historical shape satisfies either current
lane. JSON Schema enforces the v3 closed shape;
`detectorCalibrationStudyIssues` additionally enforces bounded values, digest
formats, unique labeler and blind-tiebreaker identities, canonical timestamps,
digest recomputation, and the exact detector-specific desktop/GPC-disabled
condition arm. Pixel-event rates are conditional on visits whose accept-all
registration was verified and reverified after reload, never merely requested
or clicked; consent-banner stays in passive observe mode; the other detectors
use their declared passive arm.
Analysis v3 repeats the structured condition and emits one condition-scoped
rate-claim string so a target-population rate cannot silently generalize past
the arm. `analyzeDetectorCalibrationStudy` then compares the well-formed
release declaration with the current repository identities. Its analysis
context must supply both the exact current build commit and the expected
runtime digest from the separately pinned execution plan or runtime receipt;
either missing trust anchor fails closed. The expected runtime digest must not
be copied from the study being evaluated.

The public catalog derives its calibration status on every build by
re-analyzing the committed studies under `calibration/` against the exact
current release identity. Acceptance-fixture coverage is real; the committed
pixel-events pilot is discovered and disclosed, but it is bound to an earlier
build and ships no independent runtime receipt, so it re-analyzes as
ineligible and supports no rate. Eligible studies and eligible labeled cases
therefore remain zero, and any commit that moves the release identity
automatically demotes previously eligible studies rather than leaving stale
copy behind. A study becomes eligible only when collected under the current
identity with its independently written `runtime-receipt.json` sidecar.
