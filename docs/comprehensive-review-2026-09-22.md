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
record, and the probe's capture skips it. A value that only a blocked
navigation would carry is not observed: the capture loss censors the requests
family but not the keystroke absence claim. The active probe `v3` move, and a
keystroke detector version move because its output changes, land with this
epoch's identity bookkeeping.

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
