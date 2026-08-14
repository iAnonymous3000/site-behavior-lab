# Instrument repeatability, 2026-08-14

Design declared in [PREREGISTRATION.md](PREREGISTRATION.md) before any scan in
this study ran. Collected with `scripts/repeatability-run.mjs` at build
`b03eada`, 20 URLs, k = 3 back-to-back repeats, desktop / GPC off /
`consentMode: observe`, one machine, one network location, one session.

**20 of 20 URLs contributed.** Every repeat completed and none was
request-capped, so no URL was dropped by the preregistered eligibility rule.

## Result

Relative spread `(max - min) / mean` across the three repeats of one page:

| metric | identical in all 3 | median | p90 | max |
|---|---|---|---|---|
| third-party requests | 8/20 | 0.8% | 7.4% | 11.8% |
| catalogued tracking-service requests | 7/20 | 3.2% | 9.0% | 10.1% |
| third-party cookies | 14/20 | 0.0% | 21.8% | 34.8% |

Detector outcome agreement across the three repeats of one page:

| detector | agreed |
|---|---|
| fingerprint-heuristics | 20/20 |
| pixel-events | 20/20 |
| cname-uncloaking | **19/20** |

## What this changes

**Most of the spread visible in the corpus is real site change, not scanner
noise.** Across 154 same-site, same-condition groups in the committed corpus
the median relative spread is 5.5% with a tail past 190%, but those repeats are
weeks apart. Measured back to back, the median is 0.8% for third-party requests
and the worst case across all 20 sites is 11.8%. The instrument is far steadier
than the corpus alone suggested, and the temporal-difference surface at
`/sites/<domain>/` is therefore showing mostly real movement.

**But the floor is not zero, and it differs by metric.** Only 8 of 20 pages
returned an identical third-party request count three times in a row. A
single-visit difference smaller than roughly 12% on request counts, or 35% on
third-party cookies, is inside the variation this instrument produced on pages
that did not change. Cookies are bimodal: usually exact (14/20 identical), and
occasionally off by a third.

## The defect this found

`cname-uncloaking` disagreed with itself on **webmd.com**, firing `false`,
`true`, `true` across three consecutive visits.

The request log was byte-stable across those visits: 980 third-party requests
in all three. So the disagreement is not explained by the page loading
different things. The detector reached a different conclusion from the same
observable traffic, which points at its DNS resolution step rather than at the
site: a CNAME chain is resolved live, and resolution can fail, time out, or be
served differently by a resolver between one visit and the next.

That is a reliability defect at the single-visit level, and it is independent
of whether the detector is accurate when it does fire. One visit is the unit
this product publishes, so a detector that answers differently on identical
evidence cannot be read as a property of the site.

**Recorded, not fixed.** Changing the detector on the strength of the study
that measured it is exactly what the calibration rules forbid, and the same
discipline applies here. The next study takes this as its question: how often
does the CNAME step fail to resolve, and should an unresolved chain be reported
as "not determined" rather than collapsing into "no cloaking found"?

## What this study does not say

- Nothing about accuracy. A repeatable detector can be repeatably wrong.
- Nothing about sites that refuse automation. The frame deliberately holds only
  pages a prior screening pass observed serving an honest automated browser, so
  this is repeatability **on pages this scanner can measure at all**.
- Nothing about variation across networks, regions, times of day, or machines.
  Every repeat shared one of each, so these figures are a **lower bound** on
  what a reader comparing two arbitrary visits would see.
- Nothing about another build. The identity that produced it is `b03eada`.

## Reproduce

```bash
npx tsc -p tsconfig.test.json --outDir .unit-test-dist
SITE_BEHAVIOR_LAB_BUILD_COMMIT=$(git rev-parse HEAD) \
  node scripts/repeatability-run.mjs research/repeatability/urls.json /tmp/out.json
```
