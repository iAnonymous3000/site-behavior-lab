# Frame construction (draft)

How each study's N cases get chosen, screened, and frozen. N is
detector-specific and comes from the study's own prevalence and recall
arithmetic, never from the preflight floor: the CNAME design sizes N ~ 350 so
that E[referencePresent] ~ 175. The zero-censoring rule that made one failed
case kill a study is superseded for new studies by the step-3 decision
(../calibration-censoring-policy-decision.md): policy C conserves lossy cases
in an adversarial envelope, so the frame is sampling first, with reliability
screening serving the envelope's width rather than a survival lottery. No
frame size is approved until the fresh multi-cluster sweep establishes a
defensible detector-input loss bound.

## The reliability sweep

Before any frame freezes, every candidate site is visited in at least five
collection rounds under the exact measurement condition of its study, from
the controlled runner's egress, on one collection SHA. Rounds are disjoint
sessions at least 24 hours apart; rounds 1 and 2 are the eligibility pair,
at least 48 hours apart, and the additional rounds exist so the loss bound
has independent time clusters
(docs/reliability-sweep-cluster-design.md).
A candidate joins the eligible pool only if both visits were bare-load valid:
page loaded, no bot wall, subject verified, ledgers consistent. A censored
evidence family does NOT disqualify (see the validity/readiness split below);
it is reported in the receipt diagnostics for sizing. The sweep runs through
`npm run calibration:reliability-sweep` and publishes nothing.

Two sweep passes are the floor, not a guarantee. The pilot's 37.5 percent
failure was on unscreened consumer retail; screened pools should do far
better. Under policy C an acquisition-day failure censors a case into the
envelope instead of killing the study, but every censored case still widens
the published bounds, so the discipline stands for a different reason: frame
exactly N (substitution remains forbidden and every planned attempt stays
conserved), draw from reliable screened candidates, and schedule acquisition
close to the second sweep pass.

## Pool composition per study

Each pool must hold enough screened candidates that a simple random draw of the
study's N plausibly clears every 100-minimum marginal denominator -- for CNAME
at N ~ 350, a pool of 600 or more.
Strata inform pool COMPOSITION only; the draw itself is simple random from
the whole pool, seeded by the SHA-256 of the committed preregistration, so
nobody chooses cases after seeing anything.

Corpus receipts for likely-positive strata (from the 574 committed
reports):

- **pixel-events**: corpus-positive hosts under passive observe: bumble.com,
  americanexpress.com, creditkarma.com, healthline.com, homedepot.com,
  nike.com, paypal.com, webmd.com. The accept-all arm fires far more
  broadly, so the likely-positive stratum is top US retail, news, and
  health-commerce properties; the corpus hosts are seeds, not the stratum.
- **cname-uncloaking**: all 15 corpus-positive hosts: europa.eu,
  americanexpress.com, bankofamerica.com, bbc.com, capitalone.com, citi.com,
  discover.com, everydayhealth.com, foxnews.com, homedepot.com, nike.com,
  nytimes.com, walgreens.com, webmd.com, plus one redacted-subdomain case at
  mit.edu. Finance and news skew is real; the pool leans there, and the
  study accepts that the present-class floor confirms only at scan time.
- **fingerprint-heuristics**: session-recording and input-monitoring are the
  corpus's most common detections (509 and 464); commercial media, dating,
  and retail carry them. Clean stratum from the reference, government, and
  open-source categories, which the corpus shows consistently quiet.
- **consent-banner** and **privacy-policy**: both classes are abundant in
  every category; compose for diversity, not scarcity.

## Case files and digests

Each drawn case becomes exactly two frozen files under the case-input root,
`selection.json` (the https URL, no credentials, no fragment) and
`condition.json` (the study's measurement condition), plus one sealed
reference-evidence artifact outside the case root. The plan's per-case
digests are the SHA-256 of those exact frozen bytes.

Open contract question, flagged before anyone computes 1200 digests: the
operations doc requires byte-exact digest matches but does not state the
serialization for hand-produced case files. The generated repo artifacts use
canonical pretty JSON (two-space indent, trailing newline). The frame
tooling must confirm against the acquisition-side digest check before
freezing, and then serialize identically. Do not hand-author case files.

## The frame tooling (built)

`npm run calibration:frame` takes the screened pool and the committed
preregistration, seeds the draw with the SHA-256 of that preregistration's
exact bytes, and emits every case's canonical `selection.json` and
`condition.json` plus `frame-rows.json` carrying the per-case digests.
Deterministic, create-only, no network.

**The draw is a sort, not a shuffle.** Each candidate is keyed by
`sha256(seed + "\n" + url)` and the lowest N keys win. That is an
equal-probability draw without replacement which needs no agreement about a
PRNG: anyone can recompute one hash per pool entry in any language, sort, and
get the same frame. Pool order cannot influence the sample, and a duplicated
URL is refused rather than given two chances.

Two refusals are deliberate. A second run into the same directory is rejected
rather than overwriting a frozen frame, so redrawing requires changing the
preregistration the seed comes from. And a preregistration whose
`measurementCondition` differs from the canonical detector arm - including its
exact `interpretation` text - is rejected up front, because the acquisition
validator compares that text per case and would otherwise refuse a whole
emitted frame after the one-shot ceremony had already started.

`referenceEvidenceDigest` is deliberately NOT produced here. Reference evidence
is sealed independently by reviewers, and the hand that draws the frame must
not also produce the labels it will be scored against.

A guard test writes a drawn frame to disk and runs the real
`validateCalibrationCaseInputs` over it, so the producer's serialization and
the acquisition validator's digest recomputation are proven to agree rather
than separately asserted.

This producer landed on its own, ahead of any ceremony. The
assemble custody wiring is already implemented and tested, so nothing about
drawing a frame waits on the custody lane and an operator reading this should
not treat either as pending code.

Still outstanding here: the labeler endpoint appendix frozen from the candidate
catalog, and a runnable sweep command that owns the scan loop end to end. The
receipt producer and its blinding enforcement are built (below); what is not yet
built is the caller that runs the two passes and hands reports straight into the
projection, so today the blinding boundary is enforced at the library rather
than at the process that holds the reports.

**Sizing note.** This draft originally fixed every study at 400 cases, which predates the arithmetic in
[../calibration-cname-uncloaking-design.md](../calibration-cname-uncloaking-design.md).
For a rare-positive detector a 400-case draw from a ~0.20 pool misses the
100-positive floor about 99% of the time. (The original sizing note also
weighed zero-censoring survival, which compounds in N; under policy C the
corresponding cost is envelope width, which likewise grows with censored
count.) Size from the pool's base rate.

It also had no structural basis. The preflight derived 400 by summing the four
class minimums, but those are two partitions of the same N, so the structural
floor is 200. The 400 was neither the floor nor a power calculation -- it was a
double count that happened to sit above the real floor while rejecting the
~350-case design the base-rate arithmetic actually justifies. The preflight now
derives 200 from the partition structure, and sizing above it belongs to the
study, not to the gate.

**Sweep hazard.** The reliability sweep as described runs full scans, which
produce detector output. Preregistration is void if the frame is chosen after
predictions are seen, so the sweep must be treated as a bare load check whose
detector outputs are never read, and its receipts should record only load
outcome.

That separation is now enforced rather than remembered, in
[`scripts/calibration-reliability-sweep-lib.mjs`](../../scripts/calibration-reliability-sweep-lib.mjs):

1. `bareLoadOutcome` is the only entry point, and it returns a fixed closed
   record (`BARE_LOAD_OUTCOME_FIELDS`). The report is narrowed once, at
   ingestion, so no sweep logic downstream holds a reference to evidence.
2. `assertBareLoadOnly` refuses any object carrying a key outside that
   vocabulary, and runs on every projected case *and* on the assembled receipt.
   A widened projection fails loudly instead of quietly admitting predictions.
3. A source-reading guard asserts the module never names a detector evidence
   field or reaches into `run.evidence` at all.

Validity is fail-closed on every clause, which is the correction that mattered
most: an earlier version defaulted `navigationSettled`, the run outcome and
request-evidence completeness to the PASSING value, so a report carrying nothing
but a 200 came out sound. A candidate now needs positive evidence of a settled
navigation, a verified subject, no bot wall, a complete run, every family
REPORTED, and ledgers that do not contradict each other in the reassuring
direction.

Validity is deliberately SPLIT from input readiness under the step-3 censoring
decision (docs/calibration-censoring-policy-decision.md). The superseded
zero-censoring rule also required zero censored families at screening; policy C
conserves such cases, so screening them out would re-create policy A at the
frame boundary and select the frame on measurement difficulty. A censored
family therefore no longer disqualifies a candidate: `bareLoadValid` decides
eligibility, and `allEvidenceFamiliesComplete` survives only as the reported
diagnostic that lower-bounds every per-detector scoreable rate.

Eligibility is per CANDIDATE, not per visit: both passes must be bare-load valid and at
least `SWEEP_MINIMUM_PASS_SEPARATION_MS` (48 hours) apart, matching the rule
stated at the top of this section. Two visits an hour apart mostly re-measure
one cache state.

`censoredFamilies` carries family IDENTITY. An earlier revision kept only a
count so the sweep could not even weakly hint at a detector; the step-3
decision reverses that deliberately, because per-detector policies are sized
from per-family loss structure. Predictions remain unrepresentable in the
vocabulary, the array is closed by value as well as by key, and frame
SELECTION still reads load validity only, so the anti-selection property
holds at the boundary that matters. The receipt carries no
pass/fail — whether the pool clears is a preregistered threshold a human
applies, not something the producer decides. An unloadable case is recorded as a
failed load rather than skipped, because silently dropping uncooperative sites
would bias the frame by another route.

Mutation-tested: widening the projection to carry `cnameCloaks` fails five of
the seven guards; disabling the field check fails three.
