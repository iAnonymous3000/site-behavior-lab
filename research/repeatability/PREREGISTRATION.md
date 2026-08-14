# Instrument repeatability study, declared 2026-08-14

**Declared before any scan in this study was run.** The design below is fixed.
Findings become the next study, never a patch to this one.

## The question

If this scanner visits the same page twice under identical conditions, does it
report the same thing?

Nobody has ever measured that, while the product publishes per-site counts,
category medians, and a temporal-difference surface at `/sites/<domain>/` that
are all built from single observations. A reader looking at two visits of one
site cannot currently tell a real change from scanner variation, and neither
can we.

This is not a detector accuracy study. It measures the instrument's
consistency, not whether what it reports is correct. A perfectly repeatable
detector can be repeatably wrong.

## Design, fixed before collection

- **Unit:** one URL.
- **Repeats:** k = 3 per URL, run back to back.
- **Conditions:** identical across every repeat and every URL, desktop,
  `gpcEnabled: false`, `consentMode: "observe"`, one machine, one network
  location, one session.
- **Why back to back:** the corpus already suggests wide spread across repeat
  visits, but those repeats are weeks apart, so real site change and instrument
  noise are confounded. Consecutive repeats bound real change to minutes, which
  is the only way to attribute the remainder to the instrument.
- **Frame:** URLs that a prior screening pass observed serving an honest
  automated browser. This deliberately EXCLUDES sites that refuse automation:
  a refusal is a property of the site, and a study of instrument noise cannot
  learn anything from a page that never loaded. The resulting estimate
  therefore describes repeatability **on pages this scanner can measure at
  all**, and must never be stated as repeatability over the open web.
- **Every attempt is recorded**, including failures. No URL is replaced after
  the fact.

## Measures, fixed before collection

For each URL and each metric, over its k complete repeats:

1. **Relative spread** `(max - min) / mean`, reported as a distribution across
   URLs, with the median and the upper tail named.
2. **Exact agreement** for boolean detector outcomes: did the detector fire in
   all k repeats, or none? A metric that disagrees across repeats of the same
   page is unreliable at the single-visit level regardless of its accuracy.

Metrics: third-party requests, catalogued tracking-service requests,
third-party cookies, and the per-detector fired/not-fired outcome.

## Eligibility, fixed before collection

- A URL contributes only if **all k repeats completed**. A partial set is
  reported as such and excluded from the distributions, never averaged over
  fewer repeats.
- Request-capped runs are excluded from count distributions: a cap truncates
  the number being compared, so its spread measures the cap, not the
  instrument.

## What this study cannot conclude

- Nothing about accuracy. See the calibration work for that.
- Nothing about sites that refuse automation.
- Nothing about variation across networks, regions, times of day, or machines.
  Every repeat here shares one of each, so this is a **lower bound** on the
  variation a reader would see between two arbitrary visits.
- Nothing about a different build. The measured identity is the build that ran
  it, recorded with the results.

## Publication rule

The result is published with its conditions and its denominator, or it is not
published. "The distributions are too wide to support a noise floor" is a
correct and useful outcome, and it would mean the temporal-difference surface
needs a caveat rather than a threshold.
