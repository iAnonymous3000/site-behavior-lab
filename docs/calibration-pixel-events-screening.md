# Screening a `pixel-events` study before collecting it

**Result: a `pixel-events` study is not worth collecting under its canonical
measurement arm from this scanner's egress. No rate is published, and the reason
is not the one the pilot recorded.**

Two screens, 60 live sites. The binding constraint is the consent arm the study
is required to declare, not the detector: across both screens only 4 cases
reached a scoreable state, and none of them fired a pixel. Targeting sites that
run consent platforms triples the arming rate and still does not reach a
collectable design.

This is a feasibility screen, run before any preregistration exists, to decide
whether a study is worth the collection budget. It is allowed to see detector
output precisely because nothing it produces may become a frame. The
pre-qualification sweep that selects a sealed frame is a different pass and must
be a bare load check.

Reproduce with `scripts/pixel-events-screening.mjs`; raw rows are in the run's
output JSON. 36 candidates, 2026-08-13, one machine, one US egress, under the
canonical arm the analyzer requires a pixel study to declare: desktop, GPC
disabled, `consentMode: accept-all`.

## What the screen measured

Three gates, kept apart because they fail for different reasons and only the
third is about the detector.

| gate | result | |
|---|---|---|
| **served** a page to an honest automated browser | 23 / 36 | 63.9% |
| **armed**: reached a *verified* accept-all registration | 1 / 23 | 4.3% of served |
| **scoreable** (served and armed) | 1 / 36 | 2.8% |
| **fired** a pixel among scoreable cases | 0 / 1 | — |

Why cases were lost:

- **Not served (13).** `http-error-status` on 11, of which 6 also matched a bot
  wall title; one `capture-loss:page-subject-validity`; one transport failure
  (`ERR_HTTP2_PROTOCOL_ERROR`). These are the same properties the pilot lost, and
  several are literally the same sites.
- **Not armed (22).** `choice-unavailable` on 21, `choice-weak-signal` on 1.
  `unavailable` is returned when the page exposes no `__tcfapi` and no readable
  OneTrust state: the scanner clicked, and there was no registration to read
  back. The operations contract retains exactly that as an
  `eligibility-criteria-not-met` censored attempt.

## A second screen: targeting consent platforms does not rescue it

The first screen's single armed case was bankrate, which runs a TCF consent
platform. That suggested an obvious rescue: draw the pool from sites that run
TCF CMPs, since European publishers render them to all visitors rather than only
to EEA addresses. A second screen tested it on 24 candidates — 16 EU publishers,
bankrate as a positive control, and 7 US ad-funded media.

| | general pool (36) | TCF-targeted pool (24) |
|---|---|---|
| served | 23 (63.9%) | 20 (83.3%) |
| armed | 1 (4.3% of served) | 3 (15.0% of served) |
| scoreable | 1 (2.8%) | 3 (12.5%) |
| fired a pixel | 0 / 1 | 0 / 3 |

The mechanism is real: targeting consent platforms roughly triples the arming
rate and lifts the serve rate to 83%. It is still not enough. Three armed cases
in twenty served is far below what a design needing 100 in each of four
denominators can use, and **no scoreable case in either screen fired a pixel**,
so the positive rate inside the armed population remains unmeasured at 0/4.

This narrows the claim rather than restating it. The arm is not impossible from
this egress; it completes on roughly one site in six even when the pool is
chosen to favour it.

## An open question this screen did not settle

Thirteen served sites in the TCF pool returned `choice-unavailable`, including
theguardian.com and spiegel.de, which do run TCF platforms. Two readings fit:

1. Those sites serve a non-TCF US privacy flow to a US visitor, so there is
   genuinely no registration to read. The account above stands as written.
2. A registration exists and the readback did not see it — a limit of the
   instrument, not a fact about the web. Two `choice-weak-signal` results
   (mirror.co.uk, repubblica.it) are consistent with this: a banner was seen and
   the click changed something, but no strong registration was read.

The distinction matters, because under (2) part of the arming rate measured here
is an artifact and the refusal would need requalifying. It is not settled, and
nothing in this document should be read as settling it. Dumping the full consent
block for a known-TCF site — whether a control was activated, whether a banner
transition was recorded — separates the two, and is the next diagnostic to run.

## The pilot's diagnosis was wrong, and this matters

The committed pilot concluded:

> A sensitivity measurement for `pixel-events` is therefore not obtainable under
> `consentMode: observe` with GPC enabled. The conditions that make a scan
> privacy-respecting are the same conditions that suppress the behaviour the
> detector exists to catch.

That is refuted twice. It was already refuted by the corpus: 17 retained runs
across 5 hosts and 3 scan dates fire pixels under `observe` with GPC **on**
(recorded as F1 in [calibration-findings.md](calibration-findings.md)). This
screen refutes it again from the other side. Ignoring the consent gate entirely,
**8 of the 23 served pages carried a decodable pixel** — Meta on bumble,
homedepot and paypal; TikTok on creditkarma, healthline, nike, eventbrite and
grubhub.

Pixels are not scarce. Roughly a third of pages that serve this scanner fire one.

**The binding constraint is the consent arm, not the detector.** A case dies
before the detector is ever consulted, because the arm the study is required to
declare mostly does not complete: 4 of the 43 served pages across both screens
reached a verified registration. The pilot attributed its failure to
privacy-respecting conditions suppressing pixels; the real mechanism is that the
*non*-passive arm prescribed as the fix is the part that rarely collects.

## Why no frame size rescues it

Per candidate, P(scoreable) is 1/36 ≈ 2.8%. If the pixel rate inside the armed
population resembled the rate among served pages (8/23 ≈ 35%), a candidate yields
a scoreable positive about 1% of the time, so `referencePresent ≥ 100` needs on
the order of **10,000 candidates**. The screen cannot even estimate that inner
rate: it produced one armed case, and that case fired no pixel.

The TCF-targeted pool is the favourable case and does not change the verdict.
At 12.5% scoreable per candidate it would need about 800 candidates to reach 100
scoreable cases, before any of them is required to be a positive -- and the
positive rate inside that population is still unmeasured, at 0 of 4.

Then zero censoring has to hold across every case in the sealed frame.
Pre-qualification would have to remove the great majority of candidates before
sealing, and the study's target population would become "sites that expose a
machine-readable consent registration to this scanner" -- a population so
unrepresentative that a rate over it describes almost nothing a reader cares
about.

Even the optimistic reading fails. With 1 armed case in 23, the Wilson 95%
interval on the arming rate runs from 0.8% to 21.0%. Even at the *upper* bound,
and assuming the served-page pixel rate held inside it, reaching 100 armed
positives needs about 2,100 candidates, every one of which must complete
cleanly.

## What would actually make this study collectable

None of these is a relaxation of a criterion, and none is a change to the
detector.

1. **Egress where consent banners appear.** The arm requires a registration to
   read back. An EEA/UK egress is where CMPs render and register. This is an
   operator change; it also moves the declared population, which the study must
   then state.
2. **Or a different declared arm.** `observe` produces positives — the corpus
   shows it and this screen shows pixels present on a third of served pages.
   `detectorCalibrationMeasurementCondition("pixel-events")` currently hardcodes
   `accept-all`, and a Layer A check binds every future pixel study to it.
   Changing it is a preregistration decision for the *next* study, not a patch
   justified by this screen. This screen is the evidence such a proposal would
   cite; it is not permission to edit the constant.
3. **Pre-qualification that screens the arm, not the detector.** Checking that a
   candidate exposes a readable consent registration is a property of the site,
   not a detector prediction, so it is legitimate before sealing. It does not fix
   the population problem in (1); it only stops the frame from censoring.

## What this screen did not establish

It is 36 sites from one machine, one egress, one afternoon, chosen to be
pixel-rich rather than sampled from any population. Every rate here is a
feasibility estimate for deciding whether to collect, not a measurement of the
web, and none of it may enter a frame.

It also says nothing about the detector's accuracy. Zero scoreable positives
means precision and recall remain exactly as unmeasured as before, which is what
every report already tells its reader.

## One harness defect worth recording

The first version of this screen ran through `tsx` and reported **every** case as
`run-failed` with `capture-loss:page-subject-validity` — a clean 0% serve rate
that reads exactly like "the open web refuses this scanner". It was esbuild's
`__name` wrapper breaking the bounded page collector serialized into the page.
Running the compiled build took the same sites from 0% to 100% served.

A second version posted to `/api/scan`, which never passes a consent mode on the
single-scan path, so accept-all requests silently ran `observe`. That would have
measured the wrong arm and reported a base rate no study could ever collect.

Both failures produce confident, publishable-looking numbers. Both are recorded
in the harness docblock so the next person does not spend the hour twice.
