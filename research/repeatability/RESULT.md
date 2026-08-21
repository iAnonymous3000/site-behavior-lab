# Instrument repeatability, 2026-08-14

Design declared in [PREREGISTRATION.md](PREREGISTRATION.md) before any scan in
this study ran. Collected with `scripts/repeatability-run.mjs` at build
`b03eada`, 20 URLs, k = 3 back-to-back repeats, desktop / GPC off /
`consentMode: observe`, one machine, one network location, one session.

> ## Correction, 2026-08-21
>
> **The collector never enforced either preregistered eligibility check.** Both
> were dead code. The rule this study actually applied was "`scanSite` did not
> throw."
>
> `observe()` in `scripts/repeatability-run.mjs` is written against the v2
> public report shape (`report.run`, `run.quality.run.outcome`), but the study
> calls `scanSite`, whose frozen-v1 `ScanResult` (`lib/types.ts:371`) has no
> `run` wrapper and no `quality` field at all. So `outcome` always fell through
> to `summary ? "complete" : null`, and **`complete` is `true` on every row that
> did not throw**. Separately, the cap test matched `/recording cap|request
> cap/i` against the run warnings, while the scanner emits "The scan stopped
> recording or loading additional requests after N requests."
> (`lib/scan-runtime.ts:187`). Neither alternative can match, so **`capped` is
> `false` on all 60 repeat rows by construction**.
>
> The original sentence here read: "20 of 20 URLs contributed. Every repeat
> completed and none was request-capped, so no URL was dropped by the
> preregistered eligibility rule." No URL was dropped because nothing could
> drop one. That sentence is withdrawn as unsupported.
>
> **Cap status cannot be recovered from this study's artifact.** `results.json`
> records neither `totalRequests` nor the run warnings, so no row can now be
> shown to be eligible, and none can be shown to be ineligible either. What
> follows is a screen, not a determination.
>
> Findings become the next study, never a patch to this one
> (PREREGISTRATION.md). Nothing below was re-collected. The recomputations are
> the committed 60 rows re-read under a saturation screen.

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

### The saturation screen

The recording cap counts **every** recorded request, first-party and
third-party alike (`allowRecordedRequest`, `MAX_RECORDED_REQUESTS` = 1,000,
`lib/scan-runtime.ts`). A row reporting 980 third-party requests therefore
recorded at least 980 of its 1,000-request budget.

Three of the twenty rows sit in a tight band just under that ceiling, and the
rest of the frame is nowhere near it:

| url | third-party requests | catalogued tracker requests |
|---|---|---|
| www.webmd.com | 980 / 980 / 980 | 417 / 402 / 414 |
| www.techradar.com | 955 / 955 / 955 | 285 / 282 / 276 |
| www.independent.co.uk | 951 / 954 / 953 | 346 / 365 / 352 |
| *(next highest)* www.theguardian.com | 669 / 668 / 636 | 265 / 256 / 252 |

The gap between the third row and the fourth is 285 requests, so the screen is
a natural break in this frame rather than a chosen threshold.

Two of the three returned an identical third-party count three times running
while their catalogued-tracker counts moved. The tracker count is a **subset of
the same request set**, so the sets were not identical. A total that does not
move while its own subset does is what a count pinned to a ceiling looks like.

### Recomputed with the three screened rows excluded

| metric | identical in all 3 | median | p90 | max |
|---|---|---|---|---|
| third-party requests | 6/17 | 1.0% | 7.4% | 11.8% |
| catalogued tracking-service requests | 7/17 | 2.8% | 9.0% | 10.1% |
| third-party cookies | 14/17 | 0.0% | 21.8% | 34.8% |

**The spread distributions survive.** Every p90 and every maximum is unchanged,
and the medians move by fractions of a percent in opposite directions. The
quantitative headline of this study does not depend on the screen.

**The "identical in all 3" count does not survive unchanged**, and it moves the
wrong way: 8/20 becomes 6/17, because two of the eight perfectly-stable rows are
the two pinned at the ceiling. Counts that agree because both hit the same limit
measure the limit, not the instrument.

Detector agreement, with the same three rows excluded:

| detector | agreed |
|---|---|
| fingerprint-heuristics | 17/17 |
| pixel-events | 17/17 |
| cname-uncloaking | 17/17 |

Both figures are stated because the preregistration and the collector disagree
about scope. The preregistration excludes request-capped runs from **count
distributions** only; the collector applied its (dead) exclusion to detector
agreement as well. Under the preregistered rule as written, the screened rows
still contribute to detector agreement and the figure is 19/20. Under the
collector's intended rule it is 17/17.

## What this changes

**Most of the spread visible in the corpus is real site change, not scanner
noise.** Across 154 same-site, same-condition groups in the committed corpus
the median relative spread is 5.5% with a tail past 190%, but those repeats are
weeks apart. Measured back to back, the median is 0.8% for third-party requests
(1.0% with the screen applied) and the worst case across the frame is 11.8%
either way. The instrument is far steadier than the corpus alone suggested, and
the temporal-difference surface at `/sites/<domain>/` is therefore showing
mostly real movement.

**But the floor is not zero, and it differs by metric.** Only 6 of 17 screened
pages returned an identical third-party request count three times in a row. A
single-visit difference smaller than roughly 12% on request counts, or 35% on
third-party cookies, is inside the variation this instrument produced on pages
that did not change. Cookies are bimodal: usually exact (14 of 17 identical),
and occasionally off by a third.

## The disagreement this found

`cname-uncloaking` disagreed with itself on **webmd.com**, firing `false`,
`true`, `true` across three consecutive visits.

**webmd.com is the most saturation-suspect row in the frame**, at 980 recorded
third-party requests against a 1,000-request budget. It is the single row this
study is least able to defend as eligible, and it carries the only detector
disagreement. With the three screened rows removed, no detector disagrees with
itself anywhere in the frame.

**This study cannot say why the detector flapped.** At least three mechanisms
remain unseparated, and it recorded nothing that distinguishes them:

- **The candidate list is drawn from the recorded request log.** Candidates are
  the page's own first-party subdomains, in request-arrival order
  (`cnameCloakCandidates`, `lib/cname-uncloaking.ts`). A truncated log yields a
  truncated candidate list.
- **At most ten hosts are resolved.** The scanner passes `maxHosts:
  MAX_CNAME_LOOKUPS` = 10 (`lib/scanner.ts:278`) and the resolver slices the
  candidates to that. On a page with more than ten first-party subdomains,
  *which* ten get resolved depends on arrival order, which moves between visits.
- **Resolution happens live.** A chain can fail, time out, or be answered
  differently by a resolver between one visit and the next.

The earlier text here asserted the first of these away: "The request log was
byte-stable across those visits: 980 third-party requests in all three. So the
disagreement is not explained by the page loading different things." That is
**contradicted inside this artifact**. The catalogued-tracker count over those
same three visits was 417, 402, 414, and those requests are part of the same
log, so the log was not byte-stable. The DNS attribution that followed from it
is withdrawn: it named one of three candidate mechanisms as the cause on the
strength of a premise the data does not support.

What stands: a detector answered differently across three consecutive visits to
one page, on a row whose evidence may have been truncated. One visit is the unit
this product publishes, so this is worth the next study's attention either way.

**Recorded, not fixed.** Changing the detector on the strength of the study that
measured it is exactly what the calibration rules forbid, and the same
discipline applies here.

## What this study does not say

- Nothing about accuracy. A repeatable detector can be repeatably wrong.
- Nothing about sites that refuse automation. The frame deliberately holds only
  pages a prior screening pass observed serving an honest automated browser, so
  this is repeatability **on pages this scanner can measure at all**.
- Nothing about variation across networks, regions, times of day, or machines.
  Every repeat shared one of each, so these figures are a **lower bound** on
  what a reader comparing two arbitrary visits would see.
- Nothing about another build. The identity that produced it is `b03eada`.
- **Nothing about which runs were eligible.** Both preregistered eligibility
  checks were inoperative, and the artifact does not record what would decide
  them.
- **No detector agreement rate.** The frame is too small to carry one in either
  direction. 19/20 has a 95% Wilson interval of [0.76, 0.99]; the screened
  17/17 has [0.82, 1.00]. Both are descriptions of this frame, not rates.

## What the next study must record

Named here so the next preregistration can be checked against it rather than
rediscovering this:

- `totalRequests` per repeat, so cap saturation is decidable from the artifact
  instead of inferred from a screen.
- The run warnings, or the structured capture-loss ledger, per repeat.
- Per-detector **status** from the detector ledger, not the length of a
  detections array. A detector that reports `partial` because its own capture
  was cut is currently indistinguishable here from one that ran fully and found
  nothing.
- Eligibility decided by a tested predicate this repository already owns,
  rather than by a hand-written string match. Study 2 settled on
  `classifyObservation` (`scripts/scanner-fidelity-study-lib.mjs`), which reads
  the producer's structured `quality.byFamily.requests.outcome` instead of
  matching any warning text; `runHitRequestRecordingCap` and
  `familyCensoredOnRun` (`lib/scan-report-views.ts`) are the reader-facing
  equivalents. Every one of them needs the v2 report, not the frozen-v1
  `ScanResult` this collector asked for. See
  [`research/repeatability-2/PREREGISTRATION.md`](../repeatability-2/PREREGISTRATION.md).

## Reproduce

**The committed collector reproduces the defect described in the correction
above.** It is left unmodified so this artifact stays reproducible as published.
A repaired collector belongs to the next study, under its own preregistration.

```bash
npx tsc -p tsconfig.test.json --outDir .unit-test-dist
SITE_BEHAVIOR_LAB_BUILD_COMMIT=$(git rev-parse HEAD) \
  node scripts/repeatability-run.mjs research/repeatability/urls.json /tmp/out.json
```

The screen and both recomputed tables are derived from the committed
`results.json` alone, with the quantile estimator copied from the collector so
the published figures reproduce exactly.
