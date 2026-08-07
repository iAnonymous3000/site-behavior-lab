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

## What the frame tooling still needs (build item)

A small `calibration:frame` producer that takes the screened pool, the
committed preregistration digest as seed, and emits: the drawn cases with
their canonical selection and condition files, the three-digest plan rows,
the labeler endpoint appendix frozen from the candidate catalog, and the
sweep receipts. Deterministic, create-only, no network. This does not exist
yet and should ride the same PR as the assemble custody wiring.
