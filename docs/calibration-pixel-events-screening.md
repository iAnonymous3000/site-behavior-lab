# Screening a `pixel-events` study before collecting it

**Result: a `pixel-events` study is not worth collecting under its canonical
measurement arm from this scanner's egress. No rate is published, and the reason
is not the one the pilot recorded.**

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
declare cannot complete: from a US egress almost nothing exposes a consent
registration to read back. The pilot attributed its failure to privacy-respecting
conditions suppressing pixels; the real mechanism is that the *non*-passive arm
prescribed as the fix is the part that cannot be collected here.

## Why no frame size rescues it

Per candidate, P(scoreable) is 1/36 ≈ 2.8%. If the pixel rate inside the armed
population resembled the rate among served pages (8/23 ≈ 35%), a candidate yields
a scoreable positive about 1% of the time, so `referencePresent ≥ 100` needs on
the order of **10,000 candidates**. The screen cannot even estimate that inner
rate: it produced one armed case, and that case fired no pixel.

Then zero censoring has to hold across every case in the sealed frame. At a 64%
serve rate and a 4.3% arming rate, pre-qualification would have to remove ~97% of
candidates before sealing, and the study's target population would become "sites
that expose a machine-readable consent registration to a US visitor" — a
population so unrepresentative that a rate over it describes almost nothing a
reader cares about.

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
