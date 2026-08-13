# Calibration findings

Findings become the next study, never a patch to the one that produced them.
This file records what was learned about the detectors and the calibration
design, with the evidence, so a later preregistration can act on it under its
own declaration rather than someone quietly adjusting a constant.

Nothing here changes a detector. Two of these findings deliberately leave a
committed constant and a committed post-mortem exactly as they are.

---

## F1. The pixel pilot's central conclusion does not hold

**Status: refuted, by the project's own corpus. No code changed.**

The committed pilot concluded:

> A sensitivity measurement for `pixel-events` is therefore not obtainable under
> `consentMode: observe` with GPC enabled.
>
> — `calibration/pixel-events-pilot-2026-07-28/REPORT.md`

That generalises from four sites. Of the pilot's twelve likely-positives, eight
never served a page (403/429/no status) and the remaining four fired no pixel.
The conclusion drawn was structural: that privacy-respecting conditions suppress
the behaviour the detector exists to catch.

The committed corpus contradicts it. Filtering every retained run for
`consentMode: observe` **and** `gpcEnabled: true` **and** a non-empty
`pixelEvents` array returns **17 runs across 5 distinct hosts and 3 separate
scan dates**:

| host | dates | decoded |
|---|---|---|
| bumble.com | 2026-06-25, 07-06, 07-21 | Meta PageView |
| homedepot.com | 2026-06-25, 07-06, 07-21 | Meta PageView |
| creditkarma.com | 2026-06-25, 07-06, 07-21 | TikTok Pageview + custom event |
| webmd.com | 2026-06-25, 07-06, 07-21 | X Purchase |
| healthline.com | 2026-07-06 | TikTok Pageview + custom event |

Pixels do fire under passive observation with GPC on, repeatably, across weeks.
Measured paired within-host on the 64 hosts scanned under both arms, moving to
`accept-all` adds one host and loses none. The accept-all arm is worth roughly
1.6 percentage points, not the categorical unlock the pilot inferred.

`pixel-events`' real obstacle is base rate: 5.1% of hosts under the default arm,
which is about seven times short of what the approved denominator floor needs,
and enrichment does not close it (5 of 33 hosts, 15%, even in the richest
commercial strata).

**Deliberately not done.** `detectorCalibrationMeasurementCondition("pixel-events")`
still returns the `accept-all` arm, and the pilot's `REPORT.md` is unedited.
That constant is enforced by a Layer A analyzer check
(`design.measurementCondition must equal the canonical detector-specific
measurement arm`), so changing it would rewrite what every future pixel study
must declare — on a detector that is not the flagship, on the strength of a
finding that has not itself been through a study. The pilot's bytes are
committed evidence of what was concluded at the time; correcting them in place
would destroy the record this finding is written against.

The next pixel preregistration should declare its own arm and cite this
finding. Caveat carried forward: the five hosts above are `schema=1` rows. The
decoder module is shared, but they were not re-run under the current build.

**Reproduce:**

```bash
node -e "const fs=require('fs');const files=fs.readdirSync('public/reports').filter(f=>f.endsWith('.json')&&f!=='index.json');let n=0;for(const f of files){const r=JSON.parse(fs.readFileSync('public/reports/'+f,'utf8'));for(const run of [r.run,r.baseline,r.variant].filter(Boolean)){const c=run.conditions||{};if((run.pixelEvents||[]).length&&c.consentMode==='observe'&&c.gpcEnabled===true)n++;}}console.log(n)"
```

---

## F2. The `consent-banner` seam and its drafted label measure different things

**Status: draft corrected before it could bind. Seam unchanged.**

The implemented calibration seam predicts one thing: whether a consent control
was **visible**, via the `banner-visibility@1` DOM probe
(`lib/calibration-scan-runtime.ts:87`). This project's own evaluator classifies
that method as weak — `WEAK_CONSENT_INTERPRETERS = new Set(["banner-visibility@1"])`
(`lib/scan-report-v2-evaluators.ts:92`).

The drafted reference label was a **disjunction**:

> ... asserts present when the recorded evidence shows a consent banner or
> consent management platform was offered to the visit (banner markup, **CMP
> loader request**, or consent framework endpoint ...)

Scoring a visibility predictor against a label that also counts loader requests
makes every "CMP loaded, no banner rendered" visit a false negative. That case
is not rare and it is not detector error: the scanner egresses from one US
location and most CMPs gate their banner to the EEA/UK, which is why the CMP
loader request reaches only 16.3% of hosts under the default arm. The study
would have measured the scanner's postcode and published it as recall.

The draft's `referenceProtocol` now states the visibility proposition exactly
and names what is excluded and why.

**The residual risk, which no code change resolves.** The detector id
`consent-banner` covers two different published propositions: the report's
finding text says *"A consent management platform was requested"*, while the
calibratable seam answers *"was a consent control visible"*. The ops document
chose the second deliberately — "CMP request matching is never accepted as a
substitute detector output" — so this is not a bug to fix in the seam. But it
means a future `consent-banner` rate must be presented against the proposition
it measured, not against the detector's finding text. Any surface that prints a
rate next to a detector name inherits this hazard.

---

## F3. Zero-censoring and the denominator floor constrain each other

**Status: quantified. No policy weakened.**

`censored-cases-present` fires on any censored case at all, so ceremony survival
decays exponentially in frame size, while the `>= 100` class floor pushes frame
size up. The two rules therefore have a joint feasible region that neither
states on its own, and a study can be designed straight out of it without
anyone noticing until the one-shot acquisition has already run.

The arithmetic, the resulting design rule (raise the pool's base rate to lower
N, rather than raising N to reach the floor), and the demonstration that the
drafted 400-case `cname-uncloaking` frame had about a 99% chance of missing the
positive floor are in
[calibration-cname-uncloaking-design.md](calibration-cname-uncloaking-design.md).

One input is simply unknown: per-case capture reliability under the release-grade
arm. The committed corpus holds six r2 runs, all clean, which supports no
estimate. Until a pre-qualification sweep measures it, the survival probability
of any ceremony is a guess, and the preregistration should say so rather than
imply a number.

---

## F5. The pixel arm cannot be collected from this egress

**Status: measured against 36 live sites. No study collected, no rate published.**

A feasibility screen under the canonical pixel arm (desktop, GPC off,
`accept-all`) served 23 of 36 candidates, and **1 of those 23 reached a verified
consent registration**. Twenty-one returned `choice-unavailable`: the scanner
clicked and there was no registration to read back, which the operations contract
retains as an `eligibility-criteria-not-met` censored attempt.

Meanwhile pixels are plentiful. Ignoring the consent gate, 8 of the 23 served
pages carried a decodable pixel. So F1's refutation of the pilot holds from a
second direction: the detector has plenty to find, and what stops a study is the
arm it is required to declare, not the behaviour it measures.

Full numbers, the sizing arithmetic, the three things that would make the study
collectable, and two harness defects that each produced a confident wrong answer
are in
[calibration-pixel-events-screening.md](calibration-pixel-events-screening.md).

Nothing here licenses editing `detectorCalibrationMeasurementCondition`. That
constant is bound into every future pixel study by a Layer A check; changing the
arm is the next study's declaration, and this screen is the evidence such a
proposal would cite.

---

## F4. What blocks a published rate today is not code

Everything the repository owns is built and verified: the analyzer and its
fail-closed layering, a prediction seam for all six detectors, independent
recomputation of every prediction by the binding verifier, an independent
reference instrument, and a reader surface that states calibration status and
refuses to quote a rate that would not clear the release policy.

What remains is human and operational:

1. A policy approval recorded in `RELEASE_READINESS.json` by a named approver.
2. A candidate-resident preregistration and frame, built from a declared
   population, with a pre-qualification sweep that never evaluates the detector.
3. Two to ten distinct authenticated reviewers sealing full-frame label sources,
   plus one precommitted blind tiebreaker.
4. A protected reveal environment, a single-use controlled runner with stable
   egress, and isolated Sigstore attestation.

None of these can be performed from inside the codebase, and none should be
simulated to produce a number. Until they happen, every report says detector
accuracy is unmeasured, which is the true answer.
