# Critical-use audit, 2026-09-01

Audited revision: `main` at `48ac19c` (2026-08-25), the commit `production`,
`scan.sitebehavior.org` and `sitebehavior.org` were all serving when the audit
started. Branch: `critical-use-audit-2026-09-01`, pull request #218.

This record exists so a reader can see what was found, what changed and why,
and what was deliberately left alone, without re-deriving the reasoning.

## 1. What "critical" means for this repository

Site Behavior Lab is a public, anonymous-use web scanner. A stranger submits
a URL. A Cloudflare container running Chromium visits that site from the
project's own infrastructure, performs two bounded interactions (typing a
sentinel into visible form fields; in consent mode, clicking one banner
control), and publishes a permanent, named, corpus-ranked account of what the
site did. Reports are presented as reproducible investigative evidence,
chained into a transparency log, and cited by third parties. The project's
stated value is that every published sentence is exactly supported by
recorded evidence.

The five things that must hold, in order:

1. **Network boundary integrity.** URLs, redirects, DNS answers, CNAME
   chains, privacy-policy links, PDF bodies and page scripts are all
   attacker-controlled. The scanner must never reach private, link-local,
   metadata, loopback or otherwise non-public addresses on any port, through
   any path. A failure turns a public scanner into an SSRF oracle inside
   Cloudflare and GitHub-runner infrastructure.
2. **Evidence integrity.** What is published must be exactly what was
   observed, filed under the identity it was measured with. The failure
   shapes are silent downgrades, values filed under a wrong or unrefreshable
   identity, a headline that disagrees with the findings board, and guards
   that cannot fail. A failure is a false public statement about a named real
   company, permanent, in a corpus other people cite.
3. **Publication privacy.** A report is public forever. Cookie and storage
   values, personal data, unredacted URLs, page titles, screenshots and raw
   policy text must never cross the public boundary. Redaction must be a
   fixed point and must fail closed.
4. **Abuse and resource bounds.** An open scanner is a free
   browser-as-a-service. Concurrency, duration, request and byte caps, rate
   limits, proxy tunnels and every awaited step must be bounded by something
   the target site cannot extend. No path may let a visitor make the scanner
   act against a third party.
5. **Supply-chain and provenance.** The instrument is pinned: vendored
   filter lists, the WASM engine, Playwright and Chromium, the build commit.
   A failure means a report carries an identity it was not measured under.

Not critical: UI polish, performance short of a hang, the ergonomics of the
calibration and research ceremonies, and the operator-attestation release
gates the readiness manifest already reports as red by design.

The standard the code is held to: at each trust boundary input is validated
before use; every error path is exercised by a test or a real execution;
no failure is silent; guards can actually fail.

## 2. Method

- The definition above was written first; every lane was held to it rather
  than to a generic hardening checklist.
- Twenty lens-scoped finders, one per trust boundary or guarantee, each in
  an isolated git worktree of the audited commit. Each had to ground a
  finding in something it executed (a harness against the compiled code, a
  Chromium fixture on loopback, a query over the 887 committed reports, a
  mutation of a guard) and to refute its own candidates before reporting.
  Finders were told what earlier audits had already refuted or deliberately
  left, so those were not re-filed. Seventeen of the twenty completed; the
  operational-truth, docs-claims and second-visit (policy fetch and CNAME)
  lanes were cut off by usage limits and their ground was covered by hand
  (sections 4.2 to 4.4 and the network-boundary lane's clean surfaces).
- Independent verification was planned as two verifiers per finding with a
  tie-breaker. The verifier fleet was cut off by usage limits twice, so the
  adjudication below rests on the finders' executed evidence, my own reading
  of the cited code, and, for every finding that was fixed, an adversarial
  reviewer who re-ran the finder's reproduction against the fix and
  mutation-tested the new guard. Where a fix reviewer was also cut off, I
  reviewed the diff myself and say so. In the end no fix had a separate
  reviewer agent: every fix carries its own mutation proof in the commit
  body, and I read every production hunk before cherry-picking it.
- Fixes were made one cluster per worktree, each with a guard test proven to
  fail without the fix, then cherry-picked onto the branch. Nothing that
  moves a measurement identity (a redaction token, an admitted public string,
  a catalog entry, a producer tuple, a methodology string, a detector version
  or a registry digest) was changed in this pass; those items are recorded
  in section 3.2 with what they would take.
- Baseline at the audited commit: typecheck, Cloudflare typecheck, 3,211
  unit tests and the script suites all green.

## 3. Findings

Severity: blocking = a reachable network-boundary escape, a false public
claim on committed reports, or a public privacy leak; high = reachable on the
production path with a concrete trigger; medium = reachable under a
non-default configuration or an uncommon trigger; low = latent, test-only or
documentation.

### 3.1 Confirmed and fixed on this branch

One commit per finding; each commit body records the mutation proof (the
production change reverted, the new test failing with the quoted assertion).

| Finding | Axis | Severity | What was wrong | What changed |
|---|---|---|---|---|
| Policy-PDF parse ran on the scanner's event loop | abuse bounds | high | pdf.js decodes on the calling thread, so a 700 KB PDF whose one stream expands to hundreds of MB froze the only event loop for tens of seconds past the 45 s wall, stalling the other slot, the queue and the health check. | The parse runs on a worker thread with a wall-clock bound clamped to the remaining scan budget and a polled memory bound; a decode that overruns is terminated and reported as the existing privacy-policy load failure. |
| Unread policy-PDF bodies destroyed without a listener | abuse bounds | medium | A policy link answering 3xx or non-2xx made the scanner destroy an unread undici body; the synthesized error had no listener and became an uncaught exception that exits any plain Node host. | Bodies are drained with the bounded `dump()`; a test drives a 302 and a 404 and asserts no process-level error. |
| Keystroke probe inherited Playwright's 30 s default | abuse bounds | low | A page that removes its fields once one is focused made the next candidate lookup wait 30 s of the 45 s budget. | Each lookup and typing action carries an explicit bound clamped to the scan budget. |
| Body reader raced every chunk against one abort promise | abuse bounds | low | Retained memory grew per chunk while zero-length chunks never touched the byte cap; a source settling reads from the microtask queue never yielded to the deadline timer. | One abort listener per body and a periodic yield to the event loop. |
| Filesystem backend wrote the report before its retention companion | abuse bounds | low | A crash between the two writes left a clockless report no prune pass could ever schedule. | The companion lands first; rollback removes only what this call created. |
| Printable report unmetered at the edge; non-read methods forwarded | abuse bounds | medium | `/reports/<id>/print` was rendered outside the report-read quota, and a POST to a report route bought a full render the quota never saw. | The print representation is charged as a read; any non-GET/HEAD on `/reports/*` is answered 405 at the edge. |
| Brave-list and drift issue reconcilers adopt a stranger's issue | abuse bounds | medium | Both `issues:write` steps selected the canonical issue by marker alone. | Trusted-author predicate; an executed test runs every inline selector against impostor fixtures. |
| Promotion gate set restated twice with no two-way pin | supply chain | low | A job added to `promote.needs` alone passed every suite. | The required-jobs test asserts equality in both directions. |
| In-process job queue reported a landed publication as a failed job | evidence integrity | low | A store deadline after the R2 write landed marked the job failed while the report stayed public. | The in-process saver reconciles from the stored bytes through the same helper the durable path uses. |
| GPC reduction rendered a reassuring headline over an alert board | evidence integrity | high | The GPC comparison branch could render "calm" on the delta alone; by construction its bottom line is an alert. | The branch never reassures; the reduction stays with the number and hedge. Corpus check: 0 contradictions before and after (no committed instance), guard added. |
| A silent non-complete detector became "an informational signal" | evidence integrity | medium | wikipedia.org's pair, every count zero, published "retained an informational signal" because the privacy-policy detector was unsupported with no recorded loss. | The headline names the check that did not complete and the completed families' absences. Corpus check: 2 presentations to 0. |
| Curated sub-properties collapsed into their apex | evidence integrity | high | A visit asked for `{label}.stanford.edu` (plato) became stanford.edu's data point, directory row, latest visit and history over www's own visit; three sub-properties, and unicode.org's only visit, were misfiled. | One site-key derivation from the requested host that every reader follows; corpus-stats.json regenerated (primary cohort 95 to 94 sites). |
| v1 reports published redaction markers as the schema.org WebSite URL | publication privacy | medium | Four committed v1 reports emitted `https://{label}.mit.edu/` and the like as `about.url`, live on the site. | The JSON-LD gate applies the same marker rule every link surface uses. |
| Atom feed, site profile and directory rows printed exact counts for failed visits | evidence integrity | low | Sixteen 403/429 visits read "8 third-party requests, 0 third-party cookies" as fact where the JSON-LD says lower bound and withholds the snapshot. | Failed outcome makes counts floors and the cookie snapshot unmeasured on every entry surface. |
| Listener cards called a site's own asset CDN a "third-party script" | evidence integrity | medium | githubassets.com, paypalobjects.com and the like were named as an outside party monitoring input. | "Third-party" only for an origin reviewed ownership or the catalog attributes to another operator; otherwise "a script served from another registrable domain". 160 of 421 corpus cards change wording. |
| Request-log CSV of a capped or failed visit carried no marker | evidence integrity | low | The downloaded file read as a complete log. | A `recording_state` column on every row. |
| About page: the log "records every report this project has released" | disclosure | low | Share reports join no log. | Corrected to committed corpus reports. |
| Client dropped the server's cancel reason | disclosure | low | A 409 "already being saved" became "HTTP 409". | The declared reason is kept. |
| verify:report silent about the sidecar's own timestamps | disclosure | low | A forged `createdAt` verified green with no boundary line. | The boundary list and the custody doc say the sidecar bytes are bound only by the CI evidence manifest. |
| Guards that could not fail | guards | high | The consent no-submit rule was a source grep; the proxy's dial-the-pinned-address rule and the every-address-public rule had no test at either layer; the board's population predicate was unpinned. | Four executed guards, each proven against the finder's mutation; one test seam under the proxy's dial. |
| README claims versus the code | disclosure | low | Retention pointer to `/status`, seven undocumented variables, unstated bounds. | README rewritten; configuration reference corrected and extended. |
| Supply-chain gate: fast-uri advisory | supply chain | (CI) | Four advisories published against the transitive dependency after the branch's base failed the live audit. | Lockfile moved to 3.1.7 with inventory and ledger regenerated; the root `packageManager` pin restored after `npm audit fix` dropped it. |

### 3.2 Confirmed and deliberately left

| Finding | Axis | Severity | Why left | What it would take |
|---|---|---|---|---|
| Dash-encoded client IP and per-visit token survive redaction under a PSL private suffix (`akamaihd.net`); two committed v1 reports carry the GitHub runner's egress IP as a "third-party domain" | publication privacy | medium | The fix narrows the admitted public-string set, which the redaction ledger treats as a remediation-class move that must stop for a decision: it changes `redactHostnameV2` output, so it is a `REDACTION_VERSION` bump, a `SUPERSEDED_R2_NORMALIZATIONS` entry, a remediation rewrite of the two committed reports and a `PUBLIC_STRING_POLICY` seam bump. The exposed value is an ephemeral runner address, not a person. | The identity ceremony above; at minimum refuse any private-suffix tenant label containing a dashed IPv4 or a long-token shape. |
| X pixel decoder publishes "Purchase" for the tag's default `tw_sale_amount=0` pageview beacon; all 7 committed X entries (six WebMD comparison reports) say Purchase on a publisher homepage | evidence integrity | high | Correct fix bumps the pixel-events detector version and the registry digest, which changes the active producer tuple; that is the detector-epoch ritual (close the active rows as historical, declare the new epoch) and the committed reports need a corrections-ledger event rather than a rewrite. Scheduled as the identity wave. | Parse the amount as a number and mark a purchase only above zero; detector version bump; ledger event for the six reports. |
| Cookie policy claims extracted from any sentence with a first-person negation ("We do not sell..., but we do use third-party cookies") become a warn-level contradiction card; `ENTITY_ALIASES` keys `Amazon`/`Oracle` never match the catalog's `Amazon Ads`/`Oracle Advertising` so a policy naming Amazon is published as not naming it (115 reports carry that entity as unmentioned); "Privacy Centre" is vetoed by the French non-policy list | evidence integrity | high / medium / low | All three change stored detector semantics and therefore the privacy-policy detector version. No committed report carries a cookie-claim card today. | Scope the cookie kinds like `noSellingOrSharingClaimScope`; key aliases by catalog entity strings with a guard that every key is an emitted entity; exempt policy-shaped text from the localized veto; one detector version bump. |
| 406 committed reports state that unload beacons are in the recorded request log; the pinned Playwright build reports no request issued during document teardown, so an unload-only transmission is provoked but never observed | evidence integrity | high | The sentence is an admitted public string in the redaction vocabulary; changing it is a sanitizer identity bump. Capturing teardown traffic at the proxy instead is a methodology change. The README, the limitations document and the methodology page were corrected now; the per-report sentence waits for the identity wave. | Drop the unload clause from the probe disclosure (identity bump) or record post-teardown proxy transactions and feed them to the sentinel matcher (methodology change), plus a pagehide fixture either way. |
| The keystroke probe scrolls below-fold fields into view while reports say the visit does not scroll; number/date inputs are counted as "prevented" and censor the family as scan-failed; per-field exceptions are swallowed uncounted; a page that removes fields mid-probe stalls the lookup for 30 s and discards a captured leak; blur can trigger an `onchange` form submit; popups load through the proxy but bypass the route guard and request log | evidence integrity | high to low | All are one rewrite of the probe's candidate handling and disclosure, and every disclosure string involved is an admitted public string. The 30 s stall's timeout half is fixed in wave 1; the rest is the identity wave. | Resolve candidates once, gate on the initial viewport with `preventScroll`, exclude value-constrained input types, count per-field failures as omitted, cancel submit during the probe, close popups and record a capture loss; one detector version bump and one sanitizer bump. |
| Three deployed Brave-list identities (2026-08-11, 2026-08-14 evening, 2026-08-15 under resource-budget-v1) and the b68c/service-role-v1 epoch (2026-07-30 to 08-01) have no closed producer row; a report produced in those windows fails HEAD's contract as "redaction-not-idempotent" | evidence integrity | high / medium | Adding closed rows is the ledger ritual and needs the exact constants of each window reconstructed from archived trees; the adoption rule itself must change so a closed row is required whenever the outgoing identity was promoted, not only when `public/reports/` holds a report under it. Live reports from those windows are past retention; saved copies and the ledger's completeness claim remain wrong. Scheduled as the identity wave. | Closed rows for the four windows; `lists:adoption` counting promotion windows; a reader reason for `R2ProducerContractError` distinct from redaction failure. |
| A corrected or withdrawn report still unfurls its claim on the social card, feed, listings, sitemap and exports | evidence integrity | medium (latent) | The corrections ledger is empty today, so no live page shows it; threading the ledger state through six shared surfaces is a larger change than this pass took on. | `renderReportCard(view, corrections)`, a `correctionState` on directory entries and export rows, and dropping suppressed reports from the sitemap. |
| The static gallery manifest computes its own `requestEvidenceComplete` with the pre-fix shape, so gallery cards can still print exact counts for a failed visit | evidence integrity | low | The manifest is a frozen public artifact contract and 16 rows of `index.json` would change; a separate decision. | Derive it from the shared completeness rule and regenerate the manifest. |
| The cross-container retention marker makes a second container refuse a finished publication | abuse bounds | medium | Production runs one container; the fix (per-pass failure accounting in the prune ledger) was not reached in this pass. | Per-pass accounting so one container's refusal does not read as another's failure. |
| Cross-container retention marker makes a second container refuse a finished publication; a filesystem-backend crash between the report write and its retention companion leaves an immortal file; durable-path clock skew can poison the purge pass; a refused durable preparation replays one Turnstile token without charge; the release-readiness fresh compile can never load the verifier on a fresh checkout | abuse bounds / other | medium to low | The first two are wave-1 small fixes; the durable ones affect features committed at `0` in production and are recorded for the day they are enabled; the readiness one fails closed and lives in a 1.0-only ceremony that has never executed. | Per-pass failure accounting for the ledger; companion-first write; DO-clock-bound `admittedAt`; a refusal marker per capability; emit the fresh compile inside the repository. |
| 0.5.0 declared and untagged for three weeks with a CHANGELOG link to a release that does not exist | disclosure | low | Adjudicated on 2026-08-16 as the operator's decision (complete or abandon the ceremony); the README now states the true release state. | Run the tag ceremony or retitle the CHANGELOG heading as the 0.2.0 precedent did. |
| Proxy DNS lookups have no per-lookup deadline and share the 4-thread libuv pool | abuse bounds | low, unexecuted | Could not be reproduced without a deliberately slow authoritative resolver; bounded by 256 unique targets per scan and two scans. | `UV_THREADPOOL_SIZE` in the container, or a cancellable resolver with a per-lookup deadline. |

### 3.3 Refuted, already handled, or by design

Condensed from the lanes' own discard lists so nobody re-files them. Each was
executed or traced against the audited commit.

- Every loopback, private, CGNAT, link-local, metadata, multicast, ULA,
  site-local, NAT64, 6to4, Teredo, ORCHID, discard, documentation and
  benchmark spelling (95 URL forms) is refused by shape, by the preflight and
  by the proxy; a resolver answering public then private is refused at
  connect time; mixed public and private answers are refused at both layers;
  Chromium cannot reach loopback around the proxy through images, frames,
  fetch, beacons, EventSource, WebSocket, workers, prefetch, popups, mixed
  content, WebRTC over UDP or TCP, or WebTransport (zero direct packets).
- Percent-encoded, backslash, case, dot-segment and double-slash spellings of
  the Worker's exact path checks cannot reach a Node-private route: Next
  answers 404 or a 308 back onto the canonical path, and the Node token check
  refuses forwarded requests when durable jobs are off.
- The scan request parser rejects or normalizes every hostile body shape
  tried; report and job ids are pattern-enforced in every reader; error
  bodies never carry a stack, path, bucket or hostname; the stored wire never
  carries a screenshot.
- Turnstile is verified with the client IP, single-use, fail-closed; the
  quota is charged atomically before the container is touched and never
  refunded; the 4 KiB body cap holds for declared and chunked bodies; every
  visitor-supplied credential header is stripped before forwarding.
- The v1 redactor and the r2 projection are fixed points over all 887
  committed reports; no cookie value, storage value, raw query value,
  credential, fragment, page title, screenshot, email, JWT, dotted IP or
  over-cap policy quote exists in the corpus, index, statistics, transparency
  log or research JSON; every persistence path re-applies the sanitizer.
- Six report-consistency rules hold over all 887 reports with and without
  the corpus; no committed report reassures over a failed, capped or
  censored visit; no percentile is quoted from a cohort under 50 sites;
  the shields numerator never exceeds its evaluated denominator.
- corpus-stats.json and reports/index.json reproduce byte-for-byte from the
  committed corpus; the primary-cohort rule has one authority; a v1 cohort
  cannot leak into an r2 aggregate; all 176 since-last-scan pairs are within
  one cohort and subject.
- Every committed r2 run replays through an exact producer row; the catalog
  digest, list manifest digest, engine version and Playwright pin all equal
  their recomputed or live values; production is deployed at the audited
  commit and emits exactly its active identity.
- The transparency chain recomputes independently from the log alone (931
  entries, 0 mismatches); every retained report is in the log, the manifest
  and the live sitemap; served bytes equal committed bytes; verify:report
  fails closed on every corruption tried; a bogus anchor is refused in CI.
- All 129 action references across 25 workflows are full-SHA pinned; no
  pull_request_target; workflow_run consumers check out literal refs; the
  fast-forward promotion guard refuses non-ancestors, rewrites and unknown
  SHAs; repository_dispatch payloads never reach a shell; the publication
  artifact ZIP boundary refuses traversal, symlinks, bombs and duplicates.
- Earlier-adjudicated items were confirmed still true and not re-filed: the
  pump livelock, the unhandled rejection in `withDeadlineDisposing`, watch
  credentials reaching Node, the v1 write-time size bound, the TrustArc and
  Osano selectors, the policy-quote identifier scrub, the `azureedge.net`
  non-idempotency, `/status` reading stale across the era flip, and the 14
  red readiness gates being operator work rather than code.

### 3.4 Proven sound by execution

The lanes' clean-surface lists, condensed. Where a lane says "executed", a
harness ran against the compiled code or a Chromium fixture on loopback.

- Bounds: 1,001 requests stop at the 1,000 cap with the warning; a 70 MiB
  body stops at the 64 MiB budget without stalling; a slow-loris document
  times out at 30 s; an endless redirect chain fails in under a second;
  thousands of workers and a busy CPU loop cannot stall Node; 30 popups do
  not extend the scan; the queue returns its slot on every error path;
  `page.pdf()` and `page.close()` are now inside the render deadline.
- Store: attacker-supplied ids create no files; share ids are 128-bit;
  symlinks, oversize and truncated files fail closed; expired shares are
  deleted on read; R2 writes are create-only and signed; retries and
  deadlines are bounded; a half-written R2 object is unreadable and
  repairable.
- Queue: cancellation at every state; a cancelled job never publishes; a
  publish failure never reports success; store unavailability is refused
  before Chromium; every terminal state frees its slot; a 120-job randomized
  stress ends with everything terminal and nothing leaked.
- Rendering: inline JSON-LD escapes `<`, `>`, `&` and the line separators;
  CSV cells with formula prefixes are neutralized; feeds escape XML; sitemap
  components are pattern-validated; outbound links refuse every marker
  spelling and `javascript:`; download names are restricted; uploads are
  size- and depth-bounded.
- Detectors: CNAME uncloaking flags none of 50 common CDN targets; catalog
  suffix matching is a label walk; the sentinel encodings are at least 8
  characters; consent selectors and pixel canonicalization are pinned.

## 4. Public surface

### 4.1 README

Rewritten for a reader deciding whether to depend on the project (what it
does, what a report proves and does not, the bounds in a table, what is off
in production, the release state, how to run and self-host, the API, how to
verify a report, the measurement identity). Nothing was deleted: the
long-form sections moved verbatim into `docs/capabilities.md`,
`docs/limitations.md`, `docs/operations.md` and `docs/configuration.md`.
Three statements the audit proved wrong or missing were corrected
(retention pointer, undocumented variables, unstated bounds), and two moved
sentences were corrected because the audit proved them false (unload beacons,
scrolling). The guard tests that pin README wording all pass against the new
text.

### 4.2 Issues

- #9 (toolchain drift, bot-managed): left open with a note. The drift is
  real (adblock-rust 0.13.2 vs 0.13.3); the workflow that maintains the
  issue is disabled by hand for the reliability-sweep epoch, so it will not
  refresh until re-enabled; the upgrade is a coordinated toolchain change,
  not a dependency bump.

### 4.3 Pull requests

- #212 (v4 pilot commitment path, the maintainer's own): its required checks
  had never executed (a startup failure GitHub refuses to retry, and a run
  whose jobs never left the queue). Closed and reopened to trigger a fresh
  run; note posted.
- #213 (transparency anchor): mergeable, additive; needs the parked CI run
  approved; note posted.
- #214 and #217 (featured-refresh legs of 2026-08-31): only one can merge
  as-is because both regenerate `corpus-stats.json` and `index.json`; the
  other must be closed and re-run per the PR's own rule; notes posted.
- #215 (cargo patches, adblock 0.13.3): blocked by the same adjudication
  that closed #198; left open with a note rather than churning the weekly
  group.
- #216 (npm group, wrangler 4.127.1): will fail the unit suite on the
  go-live runbook's pinned Wrangler sentence; note posted with the fix.

### 4.4 Branches

Dead (content already on main or superseded); none deleted:

- `agent/bound-brave-browser-install` (local, 2026-08-19): its one commit is
  on main by patch-id; main carries the same timeout-and-retry lines.
- `worktree-wf_cd56a2a4-1d0-2` (local, 2026-08-17): fully merged; a leftover
  workflow worktree branch.
- `origin/automation/brave-list-refresh` (2026-08-24): PR #196 closed
  unmerged by adjudication, 35 commits behind; the disabled weekly workflow
  recreates this branch name when re-enabled.

Live: `v4-commitment-path` (#212), the five automation and Dependabot
branches behind #213 to #217, `production` (equal to main), and this
branch. The detached worktrees under `../site-behavior-lab-sweep/` belong
to the reliability sweep and are not branches.

## 5. What was not covered

- The operational-truth, docs-claims and second-visit lanes did not
  complete. Operational truth was established by hand (workflow states,
  run history, live health, branch and PR distances). The docs beyond the
  README were not systematically re-verified against the code in this pass;
  `RELEASE.md`'s current-state section was read and is consistent with the
  tags and receipts. The CNAME probe is bounded by hops, a per-lookup
  timeout and the scan deadline (network-boundary lane), but deep, looping
  and internal-name chains were not executed.
- No verifier ran independently of the finders; see section 2.
- A live public scan is not performable (Turnstile); the scan, persist,
  read, render cycle is proven by the container smoke in CI, not against
  production.
