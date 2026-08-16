# Frame construction (draft)

How each study's 400 cases get chosen, screened, and frozen. Under the
approved zero-censoring policy one failed case kills a study, so the frame
is an exercise in reliability engineering first and sampling second.

## The reliability sweep

Before any frame freezes, every candidate site is visited twice under the
exact measurement condition of its study (desktop, GPC off, observe or
accept-all), at least 48 hours apart, from the controlled runner's egress.
A candidate joins the eligible pool only if both visits completed: page
loaded, no bot wall, subject verified, no capture-loss censoring. The sweep
reuses the featured-scan machinery with a dedicated catalog file and
publishes nothing.

Two sweep passes are the floor, not a guarantee. The pilot's 37.5 percent
failure was on unscreened consumer retail; screened pools should do far
better, but the residual risk that a screened site fails on acquisition day
is the risk the zero-censoring policy chose to carry. Minimizing it means:
frame exactly 400 (never more; substitution is forbidden and every planned
case must complete), draw from the most reliable screened candidates, and
schedule acquisition close to the second sweep pass.

## Pool composition per study

Each pool holds 600 or more screened candidates, composed so a simple
random draw of 400 plausibly clears every 100-minimum marginal denominator.
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
catalog, and the sweep receipts.

**Sizing note.** The 400-case figure above predates the arithmetic in
[../calibration-cname-uncloaking-design.md](../calibration-cname-uncloaking-design.md).
For a rare-positive detector a 400-case draw from a ~0.20 pool misses the
100-positive floor about 99% of the time, and enlarging the frame makes
zero-censoring survival worse, not better. Size from the pool's base rate.

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

`censoredFamilyCount` is deliberately a count rather than a list of families:
knowing that CNAME evidence specifically was censored is itself a weak signal
about the detector, and the sweep has no need for it. The receipt carries no
pass/fail — whether the pool clears is a preregistered threshold a human
applies, not something the producer decides. An unloadable case is recorded as a
failed load rather than skipped, because silently dropping uncooperative sites
would bias the frame by another route.

Mutation-tested: widening the projection to carry `cnameCloaks` fails five of
the seven guards; disabling the field check fails three.
