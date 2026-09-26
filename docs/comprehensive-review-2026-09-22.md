# Comprehensive review, 2026-09-22

A review of `main` at `3c18992` for broken builds, report accuracy,
methodology, architecture, code quality and documentation, followed by fixes
and repository cleanup. This record states what was found, what changed, what
was deliberately left and why, and what was refuted, so later audits do not
re-file it.

## 1. Method

- **Orientation.** CI, promotion, production health, open PRs, issues and
  branches were read first. Production health was green and `production`
  matched `main`, but every open proposal failed Supply-chain Security.
- **Finders.** Seventeen read-only lanes, one per evidence family or concern:
  request attribution, fingerprinting and storage, pixel events and the input
  probe, comparison modes, subject validity and the policy cross-check, the
  presentation layer, corpus aggregates and status, redaction and producer
  identity, scanner runtime, edge and API security, the frontend, CI and
  automation, dead code, duplication, complexity, documentation, and a
  pending-work inventory. Each lane had to execute its reproduction against
  the committed corpus or a compiled module and try to refute itself.
- **Verification.** Every finding went to an adversarial verifier instructed
  to refute it by execution, to mark anything already recorded as refuted or
  deliberately left, and to judge whether the proposed fix was correct and
  whether it touched measurement identity. Several verifiers rewrote the fix;
  where they did, the fix followed the verifier.
- **Result.** 64 findings: 57 confirmed or partially confirmed (7 medium,
  49 low, 1 no impact) and 7 refuted or already known. Severities are the
  verifiers' corrected values; they were deliberately stingy.

## 2. What was breaking

| Defect | Effect | Fix |
|---|---|---|
| npm audit and Trivy began failing on next 16.2.12 (GHSA-2xp9-vwfh-vxw4, critical) and sharp 0.35.3 (GHSA-rgj7-g3m4-5g8c, high) | The next push to `main` and every open proposal would fail Supply-chain Security and the Docker image scan | `c016ff6`: next 16.3.6, sharp override 0.35.4, inventory and review ledger regenerated, the `next-env.d.ts` line Next 16.3 writes |
| Next 16.3 grew the framework chunk by about 4.6 KB gzip, past the homepage initial-JavaScript budget | `28d2b66` went red on the static smoke; production stayed on `3c18992` | `d88bc27`: the homepage imported one small function from `lib/corpus-cohort.ts`, which pulled the report views, comparison modules and hashing into the first load. Moving it to a leaf module took the page from 198,108 to 182,235 gzip bytes with byte-identical no-JavaScript markup; the budget is unchanged |
| `release.yml` requires `## [0.6.0] - 2026-09-06`; the changelog said `## 0.6.0 - 2026-09-06`, and main CI's own check accepted either | The 0.6.0 tag ceremony would refuse at the attest job | `452e0f3`: bracketed heading, and `release-evidence` now requires the form the ceremony reads |
| The readiness evaluator needs the compiled `dist/schema` contract, and `release.yml` runs it straight after `npm ci` | A 1.0 or 1.0 release candidate ceremony would fail `decisions-approved`, reported as an unparseable artifact | `b677137`: both readiness scripts build the contract first, and the evaluator reports the real cause |
| `tsconfig.json` compiled the Worker sources, so `@cloudflare/workers-types` globals shadowed Node's in the Node program | The root cause of #228: 60 type errors (`Buffer.equals`, `readUInt32LE`) under the current Worker types | `f3a6dba`; the development tooling update followed in `b7198f4` |

## 3. Confirmed and fixed

38 of the 57 confirmed findings were fixed; the rest are in sections 4 and 5.
Each fix reproduced the defect by execution first, added a test that fails
without the fix (the commit message records the mutation), and was run over
the whole committed corpus to count which published pages change. No report
bundle, schema, detector version, catalog entry, producer tuple or admitted
public string changed. Derived manifests were regenerated through their
producers; only one headline in `public/reports/index.json` changed.

**Published copy and report pages**

| Defect | Commit |
|---|---|
| The privacy page and the homepage scan note still said the input probe flushes unload beacons and that teardown transmissions are measured, which SBL-CORR-2026-001 retired | `eac4baf` |
| A consent arm with many uncatalogued cross-site hosts rendered an ok services card under a green "few review signals" bottom line (3 committed boards) | `47fe79e` |
| A verified consent pair's headline led with the Accept-all visit while the board described the Reject-all visit (khanacademy.org 20260714-ad6a59f3); a consistency rule now refuses a headline that describes another visit | `61ddab8` |
| Pair-framed Shields share text and social cards showed one arm's unlabeled counts after a sentence about the difference (514 cards, 280 share texts) | `1d60c16` |
| The fingerprint card counted phase-split rows as API families | `b8859c9` |
| JSON-LD named two same-site pairs a "returned-document scan" | `3daa7e4` |
| Report titles cut the domain to keep the date (279 committed titles); the date now yields first, kind and reference stay | `53a6635` |
| The report description's claim-bearing candidates could never fit | `780b731` |
| Pair comparability reasons rendered raw wire tokens such as `"conditionFingerprint"` | `1833317` |
| A v1 consent comparison whose click left the recorded site was diffed as an accept-versus-reject effect | `0e45293` |
| A pixel that fired in two phases was named twice and its per-phase count read as the visit total | `c292c75` |
| A visit that landed on a different site than requested (two committed australia.gov.au comparisons land on my.gov.au) had no disclosure | `58bccf4` |
| The coverage boundary did not say OffscreenCanvas 2D work is unobserved | `de10f51` |

**Corpus, status and directory**

| Defect | Commit |
|---|---|
| Six of twelve category pages are published from an older cohort while saying each row is the site's newest eligible visit; the copy is now scoped to the page's cohort and discloses newer visits outside it (the cohort selector is unchanged) | `29e7ea0` |
| Keyless generalized-host rows counted as eligible for status dates and cohort recency | `848ab5f` |
| Category rows printed a different report count than the directory and profile (86 of 86 rows) | `f77d32e` |
| The homepage called its successfully loaded site count "measured" | `f280d07` |

**Scanner, edge and automation**

| Defect | Commit |
|---|---|
| A page that stalls after opening a loopback WebSocket was reported as a private-network target instead of a load timeout | `50fbe47` |
| With encrypted watches disabled, watch creation redeemed the visitor's Turnstile token and did Durable Object work first | `22f7606` |
| The anchoring workflow re-proposed the same log head weekly (#213 and #220, #238 and #243); one fixed proposal branch now carries pending anchors forward without discarding the earlier, tighter proof | `e02faf2` |
| `#238` was merged as `81293b9`, so the current log head (entry 1026) is anchored on main | `81293b9` |

**Tests, code quality and dependencies**

| Item | Commit |
|---|---|
| Worker source-shape tests passed when the ordering they enforce was violated (`indexOf` returning -1); a shared marker helper now fails loudly, and the documented mutation now fails | `27feefd` |
| Deadline tests used a 250 ms wall-clock bound that failed under load; bounds are now 1 s, still below every fallback default | `a1a6a0a` |
| The loadCorpusOverview tests re-read the corpus in five processes; they now share one read (about 2 minutes per CI suite run) | `7268772` |
| The historical censoring-policy verifiers were never exercised | `6785a19` |
| Dead code: an uncalled policy gate, never-referenced exports, production-dead helpers kept alive by their own tests, a never-emitted failure cause | `1d319b5`, `15af7b3`, `efeac66`, `4500f5b` |
| The PageGraph corpus CLI used an ICANN-only eTLD+1 rule unlike the scanner | `56b639f` |
| React 19.3, lucide-react 1.47, and the development tooling from #242 | `08a09d3`, `b7198f4` |
| Docker build actions to v4.4.1 and v7.4.0 (digests verified against the upstream tags) | `28d2b66` |

**Documentation**

| Defect | Commit |
|---|---|
| README said the Brave list refresh was disabled; it runs weekly and needs a human identity declaration to merge | `4a3417b` |
| README and three docs said the log is anchored weekly; a run only proposes, and the gap closes when a proposal merges | `ef29243` |
| docs/operations.md described the retired Git-integration deployment and enabled previews | `d8466b7` |
| docs/limitations.md listed nine of eleven methodology components and claimed guard coverage it did not have | `d37ab4b` |
| CONTRIBUTING.md told contributors to run `npm install`, which breaks `npm run check` | `fd83250` |
| 37 links in the docs moved out of the README resolved from the wrong directory | `d7d1287` |
| Runbooks did not name the transition-receipt and universe-builder commands | `ec9d3b4` |

**Read-side corrections for already-published reports**

| Defect | Commit |
|---|---|
| 64 reports from 2026-06-25 to 2026-07-06 show WebGL detections that match only the rule the observer dropped on 2026-07-20 (parameters or readback, not both), at warn level; they are now labelled with the earlier rule and no longer drive the warn decision (34 fingerprint cards move to info, three twitch.tv headlines change) | `53dff0a` |
| Three bing.com reports recorded the homepage as the privacy policy and showed omission cards over homepage text; a policy read whose URL is the site root is now presented as a cross-check not established | `548f7ea` |

## 4. Confirmed and deliberately left: the next measurement epoch

These are real accuracy defects whose fixes change what a scan records. Frozen
v1 corpus reports carry no detector versions; their only measurement identity
is the methodology token in the scanner disclosure, which is also the corpus
cohort key. A detector fix without a methodology change would change v1
semantics silently; with one, it splits the corpus cohort and restarts corpus
percentiles for new reports. Either way it is a measurement-identity decision
for the maintainer, best taken once, together with the pending toolchain epoch
(#9: Playwright 1.63, adblock-rust 0.13.3, tldts 7.4.13) and the Brave list
adoption in #232. The designs below are the verifiers' corrected versions.

**Update, 2026-09-23.** On review, the reasoning above overstated one
constraint. v1 comparison pairs already treat detector findings as raw-only
(detector versions are unknown on v1), and the one corpus metric fed by these
detectors, `fingerprintEvents`, admits a run only when the fingerprinting family
is uncensored. So a detector fix that keeps runs with lost listener attribution
censored leaves every corpus population unchanged and needs no cohort split,
which is how the v8 pixel epoch landed. The first four rows below (fingerprint,
pixel, policy landing and aliases) were therefore fixed as detector epoch
`node-detectors-v9`: `fd2685f`, `98b1f27`, `7641a99`, `64fc001`, with the
identity bookkeeping in `8078dd7` (outgoing producer rows closed to their exact
literals, one new admitted warning for listener-only loss) and review fixes in
`f7370fb` (policy text excludes script and style content, so a vendor loader on
the policy page never counts as a mention), `3d0e554` and `de39348`. The
policy check now fails closed more often; `3ff1487` states that recall cost.
The remaining rows change what v1 reports pool (the subject's HTTP status,
request counts after a probe-aborted navigation) or are low severity; they wait
for the toolchain epoch in #9, which also requires the staging A/B described in
docs/toolchain-epoch.md. The Brave list snapshot of 2026-09-21 was adopted
separately in `e249350`, as the playbook asks.

| Finding | Severity | Identity change | Corrected design |
|---|---|---|---|
| Listener stack saturation discards a frame's whole fingerprint snapshot; about a quarter of corpus visits since 2026-08-07 publish no fingerprint evidence the observer recorded (citi.com, capitalone.com) | medium | observer `@4`; the v1 capture-loss warning wording is an admitted public string | Latch a listener-attribution flag only at the saturation exit (not the integrity exits); carry it through snapshot normalization; keep canvas, font, WebGL, audio and WebRTC detections; record the fingerprinting loss and mark the heuristics partial; reword or add the v1 warning under the normalization-widening ritual |
| Meta pixel beacons sent as `FormData` (multipart) pass the form-body check and publish as fully decoded with no events or identifier fields | medium | decoder `@6` | Recognize multipart bodies and parse each part into the same parameter set, bounded like other bodies; pass the content type from the scanner; add a multipart fixture |
| The policy probe accepts any same-site 2xx document as the privacy policy (a policy link that redirects to the homepage, a soft 404, or a text-only link to the root yields a transparency-gap card over non-policy text) | medium | policy cross-check `@7` | Reject candidates that point at the scanned page or the root at selection time; after navigation require a policy-shaped title, heading or text and reject a landed URL that lost its policy path segment; return into the existing load-failed and capture-loss path |
| Entity aliases disagree with the catalog (multi-word entities fall back to exact names; "clarity" collides with ordinary prose) | low | policy cross-check `@7` | Key aliases by catalog entity; use `clarity.ms` or a case-sensitive pattern for Microsoft Clarity; do not add bare generic words |
| HTTP status and load-failure classification describe the first document, not the frozen subject, after a script redirect | medium | subject validity `v4`, cohort split | Record the status of the last passive-phase main-frame document whose URL equals the frozen subject, falling back to the latest committed document, then the navigation response; move all five consumers together; test 200 to 403 and 404 to 200 |
| A navigation the scanner itself aborts during the input probe stays in the request log and inflates counts | low | active probe `v3` and the v1 methodology token | Remove the aborted request from the recorder after the abort succeeds, keep its capture-loss record, and exclude it from the probe's own capture |
| The Shields boundary snapshots request ids and classifier counters at different instants | low | engine status semantics | Needs a single-instant snapshot; the obvious reordering narrows but does not close the window |
| The v1 sanitizer drops a whole listener detection when any script origin has no public registrable domain, with no disclosure | low | admitted public string, normalization widening | Match r2: drop the detection, publish a fixed warning, and map it to a claim blocker for the listener claim |
| `canvas-font-probing-v1` can flag chart and text-layout measurement | low | heuristic id | The proposed threshold would drop about 77 of 217 committed instances, including real probes; needs a better discriminator before any change |
| GPC worker accounting: nested worker attachments can mask an unattached page-level worker | low | none for a reader note; the full fix changes GPC capture | Tag nested attaches by parent session; the remaining hole needs a construction count that cannot be masked |

Published reports: pixel request bodies were not retained, so reports affected
by the multipart gap cannot be identified from recorded evidence. The
fingerprint loss is already disclosed on each affected report as capture loss.
Three bing.com reports (20260727-165807d3, 20260817-08181f13, 20260824-7d6e9ff3)
stored the homepage as the policy URL; their policy card now reads as a cross-check
not established (`548f7ea`), without a correction event.

**Update, 2026-09-24.** The Shields boundary row is fixed without moving any
identity. Its diagnosis was wrong: the request ids and the classifier counters
were already read in one synchronous step, so no reordering could matter. The
gap was between lifecycle stages. A request is recorded at Playwright's request
event but classified only after its route's public-host check, so a request the
page issued just before the boundary could be recorded but not yet evaluated,
and the classification arm's match recount then counted it against a
denominator that never saw it (above that denominator on a small page, which
the r2 evaluator refuses). Each classifier call now stamps its request in the
same synchronous step as the evaluated counter, and the recount covers only
requests recorded and classified at the boundary. The only published value that
moves is the r2 classification-arm `requestsMatched` (and the summary count
derived from it), and it can only go down; v1 counts are unchanged.

**Update, 2026-09-24.** The HTTP status row is fixed in the scanner. The scan
keeps every passive main-frame document response and, in the same synchronous
step that freezes the subject URL, takes the newest one on the subject's origin
that Chromium could have committed (redirect hops and 204/205 responses
excluded), falling back to the newest such document and then the navigation
response. It matches by origin, not by the URL equality this row asks for: a
static host's SPA fallback restores the requested path with
`history.replaceState`, so the subject URL is exactly the URL that answered 404
and an equality rule would keep the defect. One value feeds all five consumers.
Tests cover 200 then 403, 404 then 200, and a 204 navigation that never
commits. The subject-validity `v4` methodology move lands with this epoch's
identity bookkeeping.

**Update, 2026-09-24.** The probe-aborted navigation row is fixed in the
scanner. Its premise was only partly right: the default abort (`ERR_FAILED`)
commits an error page on a main-frame navigation, which the probe read as the
page leaving the subject, discarding the probe and its rows, so the row that
survived came from child-frame navigations, where the page stays on the
subject. Playwright's request event fires before the route callback, so the
request was already in the recorder and in the probe's own capture when the
route aborted it, and the input check could name a host that never received
anything. One rule now names what the probe stops, the first hop of any
navigation while it runs (Playwright never routes a redirect hop): the route
removes it from the recorder once the abort succeeds and keeps its capture-loss
record, and the probe's capture skips it. A blocked navigation names no
recipient, since nothing received it, but one whose URL or body carries the
test value to a third party (or cannot be read in full) leaves the probe
`partial` with `scan-failed`, so the keystroke absence claim is withheld; the
requests-family loss alone would not have censored that claim. Other blocked
navigations, a same-site search redirect or an ad frame rotating during the
wait, cost only the requests-family loss. The active probe `v3` move, and a
keystroke detector version move because its output changes, land with this
epoch's identity bookkeeping.
The same `v3` also takes the companion change: the probe now aborts with
`ERR_ABORTED`, which leaves the current document in place, so its own block of
a main-frame navigation no longer reads as the page leaving the subject, and
no longer discards the probe or censors fingerprinting.

**Update, 2026-09-24.** The GPC worker accounting row is fixed in the scanner.
Nested attaches are tagged by the session they arrive on, and the count the row
asks for, one the page cannot mask, is a browser-side witness: the scanner
counts every dedicated worker Playwright's own recursive auto-attach reports
for the measured page. That population matches the verification client's
attaches, nested workers included, and page script cannot step around it as it
can around the construction wrap (`Worker.prototype.constructor` is the native
constructor, so tagging alone would not have closed the row). The loss nets
constructions against page-level attaches and the witness against all
attaches, and discloses the larger, since both are lower bounds on the same
unattached workers. Two narrow holes remain: a worker in a frame Playwright
cannot place, and dedicated workers started inside a SharedWorker, which
neither record sees (such a run is already disclosed through its shared
worker). A worker started just as the evidence freezes can reach the witness
before the verification client and read as one lost worker, as it could
already reach the construction count first. The fix changes when the capture
loss is recorded, so the r2 methodology component moves to
`gpc-worker-application-v3` with this epoch's identity bookkeeping.

**Update, 2026-09-24.** An older backlog row lands in the same epoch: a
banner-visibility moment recorded "not visible" from a read that lost a frame,
which the observe-mode read already refused. A partial negative read now
records no observation, as a read that could not read any frame already did,
so a missing after-click moment derives `unavailable` instead of
`weak-signal`. It records no capture loss either: a first cut recorded a
`consent-verification` loss, which censored that family, withheld the
consent-banner claim and made consent comparisons ineligible even when TCF
reads had verified the choice, a derivation that never reads banner moments.
A frame that detached during the read shows nothing and no longer counts as
unread; the observe-mode calibration read keeps counting it, so the
consent-banner detector's outcomes do not move. The wire method
`banner-visibility@1` and the consent-banner detector version stay: a
recorded observation means what it meant, and the detector ledger and its
`detector-output` losses are unchanged. Only when an observation is recorded
changes, so the r2 methodology component moves to `consent-r2-v5` with this
epoch's identity bookkeeping.

**Update, 2026-09-24.** The v1 sanitizer row is fixed as a vocabulary widening.
When redaction refuses a session-recording or input-monitoring detection (an
origin it names redacts to the invalid-URL marker), the sanitizer still drops
the whole detection, as r2 does, and now appends one fixed warning,
`LISTENER_DETECTION_WITHHELD_WARNING`, to a new array, so the r2 measurement
that shares the scanner's warning list never carries it. A malformed detection
of any other kind still drops silently, since it is not this cause. v1 readers
map the line to the legacy reason `capture-loss:public-fingerprint-detections`,
named for the r2 detail, and a claim-level `legacyReasons` field censors the
listener claim alone: the fingerprinting and detector-output families, every
sibling claim and every corpus population stay as measured. Unlike r2's shared
detail, it does not censor keystroke exfiltration, because a v1 keystroke
recipient redacts to a host marker the guard accepts. The admitted string moves
the public-string policy digest off `cb7064a1...059d`, and with it both r2
normalization identities; with the input probe's three lines admitted below,
the epoch's value is `b40a333a...3d51`. The `dynamicWarningPatterns` label and
its source pin do not move. The outgoing normalizations and producer rows are
closed with this epoch's identity bookkeeping. Re-sanitizing all 919
committed v1 reports leaves each one byte-identical and adds the line to none.
Reports whose listener detection was dropped at scan time cannot be
identified, because raw evidence is not retained, so they stay undisclosed.

**Update, 2026-09-24.** The fixes above land as one measurement epoch,
`node-detectors-v10`, whose identity bookkeeping closes five rows of the table,
the HTTP status (subject validity `v4`), the probe-aborted navigation (active
probe `v3` and `synthetic-sentinel@5`), the Shields boundary (no identity), the
v1 sanitizer (a normalization widening, `cb7064a1...059d` to
`b40a333a...3d51` with the probe lines below) and the GPC worker accounting
(`gpc-worker-application-v3`),
and, from the older backlog, the partial banner read (`consent-r2-v5`). Of the
table, only `canvas-font-probing-v1` stays open. The probe row asked for the v1
methodology token; the token moves through subject validity `v4`, which
advances the reviewed corpus line, and the probe and GPC worker components
stay in the r2 suffix where their earlier revisions were declared, so both
changes to what v1 reports record ride on that advance without being named in
the token. The 2026-09 toolchain epoch's producer rows are closed to their
exact literals, byte for byte what c8b189ac deployed, and new active rows carry
the moved identities. The sentence above that these rows wait for #9 and its
staging A/B went stale when #9 landed at c8b189ac without them. This epoch
moves no toolchain input, which is what docs/toolchain-epoch.md's A/B covers;
the subject validity `v3` and `node-detectors-v9` epochs (`557891e`,
`8078dd7`) landed the same way.

**Update, 2026-09-25.** The probe-aborted navigation fix left the v1 wire
behind. v1 has no detector ledger, so the run whose r2 keystroke detector ends
`partial` with `scan-failed` over a stopped navigation that carried the test
value published an allowed "no typed value left this page" on v1, where before
this epoch the same visit named the frame's host. The probe's older
`scan-failed` path, a request whose URL or body it could not read, had the same
v1 gap. The scanner now adds one fixed warning,
`KEYSTROKE_PROBE_REQUEST_UNREAD_WARNING`, whenever the probe's capture records
either cause and the probe was not cancelled; a field that refused the value
and a request cut at the capture bounds are other causes and add nothing. v1
readers map the line to the legacy reason
`capture-loss:keystroke-probe-request-unread`, which censors the keystroke claim
alone through its `legacyReasons`, the way the listener line censors the
listener claim, and leaves the request family, comparison eligibility and the
corpus population as v1 measured them, unlike the incomplete-probe line. That
scope fits a request the probe could not read, which was sent and is in the
log, where request censoring would over-censor. It does not fit a stopped
navigation, which r2 records as lost request coverage. r2 carries the same line
beside its detector status. The admitted string is a second widening in this
epoch, so the public-string policy digest the outgoing `cb7064a1...059d` moves
to is `ab262b83...2560` (`b40a333a...3d51` with the two lines of the next
update); the `dynamicWarningPatterns` label and its source pin do not move.
Re-sanitizing all 919 committed v1 reports leaves each one unchanged and adds
the line to none. The line is added where the probe's capture closes, so a
probe that threw after typing, lost the subject, or had no field keep the value
still carries it when a request went unread. Still open on v1, where r2
withholds the claim with no request unread: a probe cut at its capture bounds,
a probe whose own work threw, a field that refused the value, and a probe that
lost the subject.

Also open, and wider than the keystroke claim: every navigation the probe
stops, whether or not it carried the value, is lost request coverage on r2 and
has no v1 channel. The page route records a `dropped` requests-family loss for
each one. In the child-frame and main-frame browser tests, r2 censors the
requests family with `capture-loss:dropped`, leaves the run out of the corpus
distribution population, reads its request evidence as `incomplete` and
withholds `third-party-services` with `family-censored`. v1 of the same visit
reads its request evidence as complete, keeps the run in the population and
allows `third-party-services` with `benchmarkAllowed: true`, so the v1 visit is
benchmarked and pooled where r2 withholds it. The unread-request line cannot
close this: it fires only for a stopped navigation that may have carried the
value, and censoring the request family for it would over-censor the
unreadable-request case. The fix is a separate v1 line for any probe-stopped
navigation, read like `capture-loss:unsettled-routed-requests` (request-family
censoring, `runRequestEvidenceCapped` and comparison eligibility), tracked as
its own identity change.

**Update, 2026-09-25, later.** Both are closed in the same epoch, so the only
identity cost is one more move of a digest that is already moving. Every r2
outcome of the keystroke detector other than `complete` now leaves a v1 line
that v1 readers censor the keystroke claim for, and the table test in
lib/scanner.test.ts drives each probe exit through the real sanitizer, view
and facts to hold that. Before the fix nine of its eleven non-complete exits
published the absence on v1: no time left once the probe started, a refused
field, an untested field, a body or URL past the capture bounds, requests past
the capture's request bound, a thrown wait, and the subject lost with and
without a typed field. So did a probe the scan had no time left to start, and
a consent interaction or post-consent reload that left the site. Two existing strings cover most of them. The
unread-request line now also fires for a request cut or skipped at the capture
bounds, since the probe could not read it in full and the unread part may have
carried the value. The three admitted lines that say the page was off the
recorded site before or during the probe (the consent interaction's, the
post-consent reload's and the probe's own) are already emitted on every r2
skip or stop for subject loss and are literally true there, so v1 readers now
read them as `capture-loss:keystroke-probe-subject-lost`, scoped to the
keystroke claim; no committed report carries any of the three. The
incomplete-probe line is not true for the rest: its request clause describes a
deadline that can cut the log, while a probe whose own work threw has stopped
and its requests are in the log. So a new admitted line,
`KEYSTROKE_PROBE_TEST_INCOMPLETE_WARNING`, covers a probe the scan had no time
to start (the one case the scan decides, through `keystrokeProbeScanWarnings`,
and a browser test forces it with a test-only budget option), a field left
untested or refusing the value, and the probe's own work throwing. It is worded
so it holds when the probe never started or the page has no fields, and v1
readers map it to `capture-loss:keystroke-probe-test-incomplete`, scoped to the
keystroke claim. Untested fields include every number or date field and every
field past the probe's eight-field and 64-candidate bounds. More new v1 visits
therefore lose the calm headline, each where r2 was already partial: 15 of the
126 committed r2 runs (earlier probe versions) and all 6 github.com runs of the
2026-09 toolchain canary ended with the keystroke check incomplete.

For request coverage, the page route now adds a second new admitted line,
`KEYSTROKE_PROBE_NAVIGATION_STOPPED_WARNING`, beside its r2 loss and before the
abort is awaited, so both wires carry the stop whether or not the abort holds.
v1 readers map it to `capture-loss:keystroke-probe-navigation-stopped` and read
it like the unsettled routed-request line: it censors the request family,
enters `runRequestEvidenceCapped` and comparison eligibility, and leaves the
keystroke claim to the probe's own lines. In the child-frame and main-frame
browser tests v1 now withholds `third-party-services` with `family-censored`
and `benchmarkAllowed: false`, leaves the corpus population and reads its
request evidence as `incomplete`, as r2 does; the foreign-realm test's
first-party submission censors the request family on v1 while its keystroke
claim stands on both wires. The route stops every navigation started while the
probe runs, an ad frame rotating during the wait included, and such a v1 visit
now leaves the corpus population and the third-party benchmark, as r2 visits
already did. None of the 30 runs of the 2026-09 toolchain canary recorded one
(the only loss on theguardian.com was fingerprinting), so this is expected to
be uncommon; where it happens, a refreshed v1 aggregate pools fewer runs for
that reason. No committed report carries the line, so the published
aggregate does not move until a refresh. The two strings move the public-string policy
digest from `ab262b83...2560` to `b40a333a...3d51`; the outgoing
`cb7064a1...059d` literals, the closed v12 rows and the `SUPERSEDED` entries do
not change, and `isScannerWarning` is untouched, so
`scanner-warning-patterns-v9` holds. Re-sanitizing all 919 committed v1 reports
leaves each one unchanged, adds neither line to any, and gives none of them a
new reader reason.

Still divergent, outside the keystroke claim and probe-stopped navigations:

- Part of the request, cookie, storage and fingerprinting coverage after the
  page leaves the recorded site. r2 records dropped losses for those families
  when the consent interaction leaves it (all four), when the page leaves before
  the passive snapshot (all four) and when it leaves during the probe (requests
  and fingerprinting). The consent interaction's case and the request loss of a
  probe that typed before the page left are closed by reader-only mappings (see
  the update below). The rest was open until redaction v5: the page leaving
  before the passive snapshot, the probe losing the page before any field kept
  the value, and fingerprinting when it lost the page after typing. The only v1
  line on those paths is the probe's subject line, which cannot carry family
  censoring because it is also added when the page is off the site just before
  the probe, where r2 records no family loss, and the typed-field disclosure
  says nothing about fingerprinting. Closing them needs a new admitted line per
  cause, which is an identity change; see the last update of this section.
- Auxiliary pages. The context-level route records a dropped requests-family
  loss for every popup request in any phase, and v1 had no line for it until
  redaction v5 (the last update of this section). It is not probe-specific, so
  the stopped-navigation line would be false for it.
- The listener-withheld drop. r2's shared `public-fingerprint-detections`
  detail censors the keystroke claim too; v1 does not. That drop does not
  undermine the keystroke negative, and the v1 sanitizer never drops a
  keystroke detection (a recipient that does not redact to a publishable host
  becomes a host marker the guard accepts), so this is r2 over-censoring and
  is left.

**Update, 2026-09-25, on review.** The unread-request line says a request "may
have carried its test value", which is false for a request the probe lost
before its first keystroke: the page had not seen the value. Unreadable bodies
already fired it there, and the capture-bound extension above widened the case
to a URL or body past the bounds and to requests past the request bound,
including on a page with no fields or only untested ones. The probe now takes
the capture's loss count in Node just before its first typing call and adds
the unread-request line only when the count grew after it; a loss with none
after the first keystroke, or with no keystroke at all, takes the
incomplete-test line, which holds with nothing typed. Both lines are scoped to
the keystroke claim, so censoring does not move on either wire and no string
or digest changes. A request the page started before typing whose event
arrives after the snapshot still takes the unread line, which only says "may".
A table in lib/scanner.test.ts covers the pre-keystroke cases (six failed at
the parent) and the dispatched ones: a loss before typing and another during
it, a refused value, a typing call that threw, and a loss while typing the
first of two fields.

**Update, 2026-09-25, on review, continued.** The divergence list above first
gave "a v1 line per cause is its own identity change" as the reason for
leaving all of the coverage after the page leaves the site open. That was
wrong for two subsets: in each, an admitted v1 line already maps one to one to
r2's family loss, so closing it is a reader-only change that moves no digest.

- `CONSENT_INTERACTION_LEFT_SUBJECT_WARNING` is added only in
  `markConsentInteractionSubjectLoss`, which always records dropped request,
  cookie, storage and fingerprinting losses, and the scan then ends the
  fingerprint detector partial. Its words say later page state was not used. v1
  readers now also map it to `capture-loss:consent-interaction-left-subject`,
  which censors those four families and enters `runRequestEvidenceCapped`; the
  listener claim takes it through its `legacyReasons`. It does not censor
  `detector-output`, where r2 scopes its consent, keystroke and policy losses to
  their own claims. On a browser fixture whose Accept click leaves the site,
  with a third-party script, v1 used to allow third-party services
  (benchmarked), named platforms, GA remarketing, third-party cookies,
  fingerprint APIs, session recording, storage keys, Shields and the consent
  banner where r2 withholds each. A browser test now holds that no claim r2
  withholds stands on v1; it failed at the parent. Residue: v1 still reads the
  `detector-output` and `consent-verification` families as complete where r2
  reads them censored, and no claim moves with either.
- The typed-field disclosure's omitted tail ("Requests from this incomplete
  probe were omitted from the recorded request log and counts.") is written only
  on the two paths where the probe lost the page after typing, where the scan
  records r2's dropped requests and fingerprinting losses. v1 readers now map it
  to `capture-loss:keystroke-probe-requests-omitted` and read it like a
  probe-stopped navigation: request-family censoring, `runRequestEvidenceCapped`
  and comparison eligibility. The fragment is that tail sentence, so it matches
  both admitted disclosure generations that carry it and neither retained form.

No committed report carries either line, so no published reading or aggregate
moves, and no string changes. Reader tests cover each reason's families,
claims, notes, corpus population and eligibility, and the predicate
cross-matrix now includes both disclosure generations. Eighteen of nineteen
mutations were killed; the survivor, adding the consent reason to the
keystroke claim's `legacyReasons`, is equivalent, since the same line already
gives that claim the subject-lost reason.

**Update, 2026-09-25, with redaction v5.** The remaining request, cookie,
storage and fingerprinting divergences above are closed in the identity move
redaction v5 already makes, so three new admitted lines cost no separate
identity change. No existing line was literally true for any of them with an
emission that maps one to one to r2's losses, so each is a new fixed warning
in `lib/scan-runtime.ts`, added beside its r2 loss and after it:

- `PAGE_LEFT_SUBJECT_BEFORE_STATE_WARNING`, beside the four dropped losses the
  scan records when the page left before its state was read with no consent
  interaction to blame. Both sites now call one helper, which also adds the
  probe's subject line. v1 readers map it to
  `capture-loss:page-left-subject-before-state`, which censors the request,
  cookie, storage and fingerprinting families, enters
  `runRequestEvidenceCapped` and comparison eligibility, and reaches the
  listener claim through its `legacyReasons`, as r2 withholds that claim over
  the partial or failed fingerprint detector. On a browser fixture that leaves
  in observe mode, v1 used to allow third-party services (benchmarked), named
  platforms, GA remarketing, third-party cookies, storage keys and Shields;
  the report published no cookies and no storage at all and read both as a
  complete absence.
- `KEYSTROKE_PROBE_PAGE_LEFT_WARNING`, beside the dropped request and
  fingerprinting losses the scan records when the probe lost the page. v1
  readers map it to `capture-loss:keystroke-probe-page-left`, which censors
  those two families and enters `runRequestEvidenceCapped` and comparison
  eligibility; the keystroke claim stays the subject line's. Browser fixtures
  leave for `about:blank`, a navigation that makes no request and so passes
  the probe's route, from a refusing field's first keystroke and from an
  accepting field's blur.
  Before any field kept the value v1 allowed third-party services
  (benchmarked), named platforms, GA remarketing, fingerprint APIs, the
  consent banner and Shields; after one did, fingerprint APIs alone.
- `AUXILIARY_PAGE_REQUESTS_BLOCKED_WARNING`, beside the context route's
  dropped requests-family loss, under the same `measuringRequests` guard. v1
  readers map it to `capture-loss:auxiliary-page-requests-blocked` and read it
  like an unsettled routed request. The wording rests on what reaches that
  route, measured through the scanner with GPC on and off: a dedicated
  worker's fetch and import, a `SharedWorker`'s script, an iframe and its
  fetch, prefetch, preload, a beacon and a keepalive fetch all go through the
  page route, and a browser test holds that none of them adds the line; a
  window the page opens reaches the context route. On a fixture that opens a popup during the load, v1 allowed
  third-party services (benchmarked), named platforms, GA remarketing, the
  consent banner and Shields.

Each browser test holds that no claim r2 withholds stands on v1, and each
failed at the parent. Re-sanitizing all 919 committed v1 reports leaves each
one unchanged except the two homedepot reports the privacy replacement
removes, adds none of the three lines to any, and gives none of their 1,837
runs a new reader reason, so no published reading or aggregate moves until a
refresh. How often live visits open a window is not measured here; where one
does, a refreshed v1 aggregate pools fewer runs for that reason, as r2 already
did. Still divergent: the listener-withheld drop above, the
`detector-output` and `consent-verification` residue of the consent line, and
the `detector-output` residue of a probe that lost the page. On both probe
fixtures r2 marks that family censored over the keystroke detector while v1
reads it complete, carrying the loss only through the keystroke claim's
`legacyReasons` (the probe's subject line). Requests and fingerprinting are
censored on both wires, and no v1 surface renders `detector-output`, so every
claim r2 withholds is withheld on v1 too.

**Update, 2026-09-25, OffscreenCanvas.** The section 3 row that disclosed
unobserved OffscreenCanvas 2D work (`de10f51`) is now fixed in the page. The
observer reads text drawing, `drawImage`, `getImageData` and `measureText` on
an OffscreenCanvas 2D context under the existing heuristics and thresholds,
records a fulfilled `convertToBlob` as its own `canvas.convertToBlob` token,
and carries offscreen text provenance into page canvases. It lands as its own
measurement epoch, `node-detectors-v11`: `fingerprint-observer@5`, the base
methodology component `fingerprint-surface-v2` (which advances the reviewed
corpus line, since v1 `fingerprintEvents` counts change), and a normalization
widening under `public-string-policy-v4`, `359b216f...e9bc` to
`63947670...7366`, for the admitted token and the worker line below. The
`public-string-policy-v4` producer rows are closed to their exact literals,
byte for byte what `89ae341f` deployed. The canvas-font heuristic, which the
section 5 update keeps as it is, now also sees offscreen measurement, with its
thresholds unchanged.

The same epoch then closed the gap this update first left open. Canvas and
WebGL work inside a Web Worker stayed unobserved at first, because
instrumenting it pauses every worker in every arm through DevTools, a new
intervention in the baseline visit. The owner decided on 2026-09-25 to take
that intervention. Every arm now holds each dedicated worker paused before its
first statement, installs the same observer there (after GPC in the GPC arm),
and reads each worker back at both freezes. A worker it cannot read in full,
and any shared worker the DevTools channel sees the page start, are
fingerprinting capture loss with a new admitted v1 line, never a clean read (a
visit without the channel sees no shared worker start). The design measured a prototype of
the install at 3 to 6 ms per worker start in every arm, baseline included. None of this moves the
detector version or the registry digest, since `fingerprint-observer@5` never
shipped and the worker realm adds no vocabulary, reason code or obligation.
`fingerprint-surface-v2` is defined to cover the worker realm, so the v1 token
moves once, and the r2 methodology gains `worker-fingerprint-v1`. The boundary
entry is now `cross-realm-canvas`: work split across the page and a worker,
shared workers and worklets stay unobserved.

## 5. Confirmed and left for other reasons

- **The Dockerfile re-runs `npm run check` inside the image build** (about 16
  of the Docker job's 22 minutes). Replacing it with a build alone would let
  the image job stage an image whose tests failed and would remove the only
  automatic test gate from self-hosted and staging builds. The safer shape is
  a build argument that defaults to running the checks, with CI skipping them
  only when the tests job is a dependency. A CI restructure, not a patch.
- **The CNAME reference instrument restates the public-suffix algorithm
  without wildcard and exception rules.** A research-tool identity
  (`cname-reference@2`) for the calibration milestone.
- **Seven hand-rolled canonical JSON serializers.** Routing them through
  canon-v1 would change committed receipt bytes and loosen two refusals;
  receipt digests are ceremony identities.
- **Two report PDF href implementations and several restated validation
  primitives.** The proposed consolidations were unsafe as written; recorded
  for a careful refactor.
- **A load-sensitive CPU assertion in `lib/policy-pdf.test.ts`** and the
  1,000 ms deadline in `lib/production-synthetic-smoke.test.ts` failed once
  each at load average 33 to 37 and pass alone; the same class as `a1a6a0a`.
- **`rate-limited` and `scan-conflict` failure causes are declared but never
  emitted**, so a 429 reaches the visitor as a raw message.
- **Oversized functions and restated tiny helpers** (the scanner visit, the
  findings builder, the staging-teardown adapters). The proposed splits would
  change producer source closures or remove the per-call budget a closure
  enforces; a planned refactor, not a patch.
- **A leading-dot invalid-host marker re-enters the hostname parser** and
  moves its counters on each pass. Hygiene only: the builder refuses that scan
  before redaction.
- **An anchoring run that pushes the proposal branch but fails to open the
  pull request** would, on re-run, carry the anchors, find nothing new and
  finish green without a pull request. No proof is lost.

**Update, 2026-09-24.** Every row above was re-verified at `bc2d438b`. Fixed
without moving any identity: the `rate-limited` cause (declared at the scan-quota
429 sites with copy that is true for all four quota windows; `scan-conflict`
stays undeclared because every visitor-reachable 409 carries specific wording),
the leading-dot marker, the anchoring re-run, the policy PDF CPU assertion, the
CNAME reference instrument (`cname-reference@2`; nothing committed bound `@1`),
and two real disagreements between the PDF href implementations (an undeclared
static build offered a PDF control the receipt hid, and the saved-page header
link skipped the hash binding). Left, with evidence: the Dockerfile build
argument (the tests job takes about 14 minutes, so gating the image on it makes
the pipeline slower, and skipping the in-image run removes the only unit run on
production's Node and npm); the canonical JSON serializers (no input any
producer builds or verifier reads yields divergent bytes, and routing them
through canon-v1 would loosen three undefined-member refusals, not two); and the
oversized functions (no restated helper disagrees with its original). Older
backlog rows fixed in the same pass: unrepresentable-status markers counted
before sanitization (a completed scan could 500), grounding drops recorded as
exhausted budgets, the shared retention-debt ledger refusing another container's
publication, the durable admission clock and refused-preparation replay, the
proxy DNS deadline, and the print caveat and row-cap drift. The canvas-font
heuristic in section 4 stays as it is: 213 of the 217 committed instances are
plausibly real probes, and every rule available from retained evidence drops
some of them.

## 6. Refuted or already known (do not re-file)

| Finding | Why it was refuted |
|---|---|
| Featured proposal PR bodies are identical for red and green batches | Every sentence is true for both; the v1 disclosure the operations doc promises is present, and publishing validated reports from a below-gate batch is the documented design |
| The weekly re-adjudication step uploads artifacts nothing consumes | The steps are a required input to the pending measurement-freeze activation, whose capture and receipt validators check them, and step 6 of the adopted schedule needs exactly those Monday cycles |
| Locale-unpinned `toLocaleString()` causes hydration mismatches | Needs a count of 1,000 or more; retention and correction pins keep every rendered count below that |
| README self-host build omits the Turnstile site-key argument | The documented path works; the sentence is incomplete, not false |
| Open-web keystroke negatives are scoreable from runs that typed nothing | Consistent with the adopted censoring policy (synthetic-positive arm only) |
| `lib/measurement-candidate-binding.ts` is too large to be cohesive | Already refuted in the 2026-08-07 audit |
| The static smoke's profile-key mirror omits the www collapse | Its only input is already stripped of `www.` |

## 7. Pending work that is not code

Code cannot close these; they need the maintainer:

- **Reinstall the promotion App.** Since this review, "Advance production to
  the tested SHA" fails with 404 on `/repos/.../installation` for App
  4436250. `main` is green and attested but `production` is still `3c18992`,
  which carries next 16.2.12. Nothing in the repository changed; the App's
  installation on the repository must be restored.
- **Tag 0.6.0.** The changelog heading is fixed. The release App, the
  creation-only tag ruleset and a governance receipt are still required
  (RELEASE.md), and the tag will include every commit since the declaration.
- **Decide the next measurement epoch** (section 4, #9, #232).
- **Featured refresh threshold (#59).** 21 of 23 gallery failures are sites
  declining an automated browser; expired deferrals returned them to the
  denominator, so the 80% gate fails weekly.
- **v1 mode qualification, the legal review of 175 runtime items, and the
  operator evidence gates** in `RELEASE_READINESS.json`.
- **v4 commitment path (#229)** stays deferred to the calibration milestone;
  its branch is kept.
