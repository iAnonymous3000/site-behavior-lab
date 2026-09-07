# Status freshness maintenance — September 7, 2026 UTC

The live status page initially dated its aggregate evidence to August 24 and
its Brave-list snapshot to August 15. All 94 sites in the selected aggregate
were stale. Open tabs only re-aged their original timestamps, without reading
new deployments. The Brave-list workflow was still manually disabled after an
earlier measurement-epoch pause, and previous corpus proposals had not been
published.

The list workflow is enabled again. All 31 reviewed source URLs were fetched
and verified; 23 source contents changed. The new snapshot was fetched at
`2026-09-07T04:11:08.142Z`, with manifest digest
`72487242a444a911e669f41ceda3571c0eed9758e93679d6f3d3cb851de5a41c`.
The outgoing producer tuples remain explicitly frozen; no historical report
or schema bytes were rewritten. Installed toolchain versions were checked
against upstream, with available upgrades recorded in issue #9 rather than
presenting the installed pins as the latest releases.

Both reviewed catalogs were acquired from exact source
`7a3ba71aa8bb3acbab2c40e3e64f74aa1c466b53`, on GitHub-hosted Ubuntu,
desktop, GPC off, with Shields off/on block-simulation comparisons. These are
explicit schema-v1 compatibility acquisitions, not controlled-runner r2
measurements or calibration evidence.

| Catalog | Workflow run | Attempted | New reports | Failed | Deferred |
| --- | --- | ---: | ---: | ---: | ---: |
| Featured gallery | [34083703346](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/34083703346) | 68 | 58 | 10 | 13 |
| De-bias seed | [34083784008](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/34083784008) | 45 | 37 | 8 | 0 |

The gallery artifact is ID `10005102509`, SHA-256
`f82f883179f82776b28ec97b89ec11c5f787a120f58113cd888ab6bf6b51e199`.
The seed artifact is ID `10005553876`, SHA-256
`37cef60583b1c2295b793c7a9f13a0eed946dc7b365f34aace768107bc7cf32a`.
Both workflow acquisitions passed, but their publishers rejected stale derived
headline/tone entries in the committed base index. The failed workflow results
remain unchanged. Maintainer adoption verified immutable artifact metadata and
archive digests, safe extraction, canonical complete snapshots, exact requested
targets and comparison conditions, the declared new-report sets, and unchanged
existing report/provenance bytes. Only the 95 new bundles were added; neither
catalog's older derived index was copied, and no historical bundles were pruned.

Rebuilding the combined corpus selected 88 measured sites in the current
subject-validity-v3 cohort. All 88 have September 7 eligible evidence; zero
were stale or unknown at this check. Across all historical cohorts, 98 sites
have a successful load. The index contains 982 reports: 919 v1 and 63 v2.
Failed visits and capped or otherwise ineligible evidence were not promoted
into measured sites to improve these counts.

The publisher now rebuilds its derived base caches from the trusted managed
reports before its existing complete-snapshot validation. Ordinary expired
catalog deferrals return to selection using one immutable workflow creation
day, independently read by acquisition and publication; frozen-study expiry
and completeness gates remain unchanged. The new reports also exposed an
identifier-field social-card overflow; compact copy now preserves the full
qualification about unrecorded values and unverified contents, hashing,
delivery, and eventual use.

The page fetches its uncached status snapshot every minute and on tab return.
Missing or invalid refresh evidence is explicitly unverified. Freshness counts
use observation dates in the exact named cohort; retrieval dates, deployment
health, and successful unit tests do not establish measurement accuracy or
coverage of every catalog site.
