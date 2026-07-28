# pixel-events calibration pilot, 2026-07-28

**Purpose: validate the calibration pipeline end to end. Not a measurement of detector accuracy.**

The study analyzer returned `ineligible`. No precision, recall, or specificity figure is
available from this pilot, and none is claimed anywhere in this document.

- Build: `6579e6b3c0b72a8f3d7cadca1d377317b8d49950`
- Detector: `pixel-events` (`pixel-request-decoder@1`)
- Study digest: `77258614be85f4dc193a052a8a353f32ea5da26e4373a8e61ea44497f8fb7e9f`
- Analyzer: `detector-calibration-analysis-v2`

## What ran

24 prespecified cases, fixed before any scan and before any evidence was seen: 12 likely
positives (consumer retail, where Meta/TikTok/X pixels are common) and 12 hard negatives
(sites that do carry third-party requests, so an absent label is not trivially explained by an
empty request log). Every case was attempted. None was replaced.

Conditions were identical for all 24: desktop, `consentMode: observe`, GPC enabled, no
comparison arm, one machine, one network location, one session. Chromium 151.0.7922.34,
Playwright 1.62.0, Node 24.14.1, darwin 25.5.0 arm64.

Reference labels came from two independent automated labelers, each a separate agent with no
shared context, each shown only the visit's distinct recorded requests and an exact
endpoint-matching definition. The detector's own output, the design stratum, and all report copy
were withheld. A third agent was wired to adjudicate disagreements.

## Result

| | |
|---|---|
| Planned cases | 24 |
| Recorded cases | 24 |
| Complete | 15 |
| Censored | 9 |
| Reference present | 0 |
| Reference absent | 15 |
| Predicted detected | 0 |
| Predicted not-detected | 15 |
| Inter-labeler agreement | 15/15, no adjudication invoked |

Ineligibility reasons: `censored-cases-present`, `missing-positive-reference-denominator`.

## What the pilot established

**The pipeline works, and the contract holds.** Scan, artifact digest, blinded packet, two
independent labelers, adjudication path, `detector-calibration-study.v1` artifact, analyzer
verdict. The study passed schema validation with zero issues and was then correctly refused
rates for exactly the two reasons that should refuse them. The suppression is not cosmetic: it
fires before any number is computed.

**The blinding held.** On `pos-12` (allbirds.com) both labelers independently found the
`facebook.net` rows, identified them as the Meta loader library rather than a `facebook.com/tr`
pixel fire, and labelled the case absent. Both also rejected `doubleclick.net`,
`googletagmanager.com`, `rubiconproject.com`, and `reddit.com` as non-matching. That is the
distinction the label definition exists to enforce, and it survived contact with real evidence.

## What the pilot found wrong with its own design

**1. The positive stratum produced no positives, for two independent reasons.**

Eight of the twelve likely positives never served a page: sephora, wayfair, etsy, chewy, hm,
and bhphotovideo returned 403 or 429, and rei and underarmour did not resolve to a status at
all. Consumer retail blocks undisguised automated browsers aggressively. Those are censored,
not negative: a page that never loaded cannot test the detector.

The four that did load fired no pixel. This is the more interesting half. allbirds.com loaded
`connect.facebook.net`, the Meta Pixel loader, and never issued a single `facebook.com/tr`
request. Under a passive visit with GPC on and no consent interaction, the pixel initialises and
does not fire.

**A sensitivity measurement for `pixel-events` is therefore not obtainable under
`consentMode: observe` with GPC enabled.** The conditions that make a scan privacy-respecting
are the same conditions that suppress the behaviour the detector exists to catch. A study that
needs positive cases must include a consent-accepted arm, and must then say plainly that its
rates are conditional on that arm.

**2. A 24-case frame cannot survive the no-censoring rule against the open web.**

`censored-cases-present` makes any censoring at all fatal to the whole study. With a 37.5%
capture failure rate on consumer retail, no realistic small frame will clear it. Either the
frame must be large enough and drawn from sites that reliably serve automated visits, or the
contract needs a reviewed way to report a censored subset without discarding the eligible one.
That is a real design question this pilot surfaced, and it should be settled before a held-out
study is run, not during it.

**3. The reference labelers are automated, not human.**

Two independent language-model agents are enough to exercise blinding, agreement measurement,
and the adjudication path. They are not a substitute for human expert reference labels in a
study intended to support published rates. Recorded honestly in the study's
`referenceProtocol` and in the `automated-llm-labeler-*` identifiers.

## What it did not establish

No false positive occurred among the 15 labeled cases. That is a fact about these 15 recorded
cases and nothing more. It is not a specificity estimate, it has no confidence interval, and the
analyzer explicitly withholds one (`uncertainty.method: none`, `reason: study-ineligible`).
Fifteen absent cases with zero positives cannot distinguish a detector that is correctly
conservative from one that never fires at all.

## Recommended next design

1. Add a consent-accepted arm as a fixed condition, so positive cases can exist at all.
2. Draw the frame from sites that reliably serve automated visits, and size it so the expected
   censored count is tolerable, or resolve the censoring rule first.
3. Use human reference labelers for any study meant to support published rates.
4. Keep the endpoint-matching label definition. It was unambiguous under real evidence and
   produced perfect agreement.

## Files

- `frame.json` — the prespecified frame, digested into the study
- `run-scans.mjs` — attempts every case, records artifacts, emits blinded packets
- `packets/` — exactly what the labelers saw, bound by `evidenceArtifactDigest`
- `labeling-workflow.js` — the two blinded labelers and the adjudication path
- `labels.json` — reference labels with labeler provenance
- `assemble-study.mjs` — builds the study artifact and runs the analyzer
- `study.json`, `analysis.json` — the artifact and its verdict
- `artifacts.tar.gz` — raw scan responses, sha256
  `5fb890d5c0a5db0bce4291723f03011080503080ea311a75520b03ef55c22783`
