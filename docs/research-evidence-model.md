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

## Detector calibration

The public detector matrix is an acceptance-fixture inventory: 18 selected
positive, negative, and adversarial/boundary tests pin known implementation
behavior. Those handpicked fixtures are not a representative labeled corpus
and do not estimate precision, recall, sensitivity, specificity, or accuracy.

`lib/detector-calibration.ts` therefore accepts a separate, strict study
artifact. A study binds:

- one current detector id/version and detector-registry version;
- a named target population, digest-bound sampling frame, selection protocol,
  and reference-label protocol;
- the planned case denominator;
- declared sampling, independence, and prediction/reference blinding; and
- one unique case id per planned unit, including explicit censored outcomes.

Any missing planned case, censored case, stale detector identity, stale
registry, or absent positive/negative reference class suppresses the complete
confusion matrix and every rate. Nothing is silently excluded.

For an eligible study, the model reports the full confusion matrix and the
numerator and denominator for sensitivity, specificity, precision, negative
predictive value, accuracy, false-positive rate, and false-negative rate. A
zero denominator produces `null`, never a fabricated zero rate.

Convenience samples and declared censuses receive descriptive point rates only.
A study gets Wilson 95% binomial intervals and a conditional target-population
scope only when it declares equal-probability simple-random sampling,
independent units, detector
predictions blinded to reference labels, and reference adjudication blinded to
predictions. Those intervals remain conditional on truthful, externally
reviewed design metadata; this code cannot prove that the declared protocol was
followed.

### External gate for detector-accuracy claims

No representative calibration study is committed today. Before publishing a
detector-accuracy claim, the project must freeze and digest a target-population
frame, select units without looking at detector output, establish an
independent reference-label protocol with disagreement adjudication, blind both
directions where practical, retain every attempted case and censor reason, run
the exact released detector and registry versions, and have the study design
and labels reviewed independently. Browser/runtime, first- and third-party,
benign hard-negative, and adversarial cases should match the scope of the claim.
Sample size and any subgroup analysis must be fixed before results are opened.

The public catalog reports this honestly as “external labeled corpus required”:
acceptance-fixture coverage is real, but calibration studies and labeled
calibration cases remain zero.
