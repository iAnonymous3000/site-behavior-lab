# Step-5 reliability sweep: the cluster design

Preregistered before any collection. This document amends the two-pass
collection plan and supersedes it: the merge landing this design became the
collection SHA both the eligibility pair and every sizing round bind to, and
the "final step-4 SHA" note in
[calibration-v4-reference-architecture.md](calibration-v4-reference-architecture.md)
is superseded accordingly. The 2026-10-02 restart below moves that
designation again and names the live study; read it first.

## Restart (2026-10-02): the live study is cname-uncloaking-2026-10

Recorded by owner decision on 2026-10-02, before any restarted round exists
and before any pilot label exists. Where this section and the rest of the
document disagree, this section wins; everything it does not change stands.

**What ran in August, and why it is not continued.** The August collection
ran one round: round 1 of study `cname-uncloaking-2026-08`, on build
`bd68cf4ad171c84eb02ab21fbe866fcc575753ec`, runner `operator-macos-arm64`,
egress `as19108-optimum-residential`, 2,262 cases observed from
2026-08-24T02:03Z to 2026-08-24T18:22Z, artifact sha256
`7dfc91056e1f194ae2b53c6807d0c6ffe0064b58dbb3fce817ffe05dd81e00e3` (kept
outside the repository, never assembled). Round 2 never launched, and by
2026-10-02 bd68cf4 was 353 commits behind main. Continuing would have bound
four more rounds to a build with three defects that a read-only review
found:

1. **The driver failed open.** Every server refusal (our access gate's 401,
   our own rate limit's 429, a misconfigured r2 producer's 503, a
   persistence failure's 500, any other scanner-side error) and every
   transport error to the local server became a silent all-ineligible row.
   The round still validated, the refusal reason was returned but never
   printed, only case 1 was checked for an r2 report, and no report's
   `run.provenance.buildCommit` was compared with
   `SITE_BEHAVIOR_LAB_BUILD_COMMIT`. A scanner refusal filed as a site's row
   drops the site from the eligible pool for a reason the site never caused,
   and nothing in the August artifact tells those rows apart. Fixed in
   0694781e and 591c3096, and completed by the egress, clock, and checkout
   checks that followed them, because the instrument's own outages and
   sleeps return the same answers as an unreachable site ("Collect fails
   closed", below).
2. **The development exclusion missed development-visited domains.** The
   universe builder read a `config/` directory that has never existed and
   never read the featured catalog, the corpus seed, or the pixel-events
   screening rows, so seven development-visited domains entered the 2026-08
   frame (cnn.com, forbes.com, spiegel.de, elpais.com, telegraph.co.uk,
   dailymail.co.uk, washingtonpost.com). Fixed in 505c3019 ("Development
   exclusion", below). The corrected set changes the partition seed, and a
   different seed is a different partition: redrawing under the old study
   id would mean changing the preregistered inputs the seed derives from,
   so the restart is a new study, never an edit of the old one.
3. **Round 1 was not one contiguous session.** It lost about 9.1 of its
   16.3 hours to the machine sleeping: 36 inter-case gaps of 449 to 1,609
   seconds, each longer than the driver's 180-second per-scan timeout,
   against a median gap of about 12 seconds. The feasibility figures derived
   from it describe no round this design defines.

**Superseded, kept as history.** bd68cf4 as the collection SHA; the August
round-1 artifact; the 2026-08 universe and pilot
(calibration/cname-uncloaking-2026-08-prevalence-pilot/, committed and
unchanged); and the August feasibility figures, the 1,126 ceiling and the
18..82 band ("Early feasibility gate (2026-08)", below). None of them binds
the restarted study, and no August round can be assembled with a restarted
one: receipt assembly refuses rounds of different studies, candidate sets,
or builds.

**The live study.** `cname-uncloaking-2026-10`, built by the corrected
derivation from the same pinned sources as 2026-08 (Tranco N2Q7W; ercexpo
us-news-domains v2.0.0 at 61505468f330000f15494ed302e0d1d719895b83): 2,375
domains after the category intersection, 20 excluded, frame 2,355 = 2,255
pool + 100 pilot.

- universe provenance:
  calibration/cname-uncloaking-2026-10-prevalence-pilot/universe-provenance.json,
  sha256 `2eab6ea4732cee93a601118781fd3313744699e666a9e6da4e8635e5d4674102`
- pilot set: pilot-set.json in the same directory, sha256
  `06dd74369c4b3092dff23f67b2b2cda51f0bad37c0552344334592e0f97f6c55`
- pool candidate set, the 2,255 cases every restarted round sweeps (kept
  outside the repository, as in 2026-08), sha256
  `bc4a846142a92ca8018a87ccfd2f41684c52cbbc76eb5c7d9916f0ff553e7d80`
- partition seed
  `f3e66dafcc3e92bc3297283eaefe1d7c4852aecc7ab1d1b548e7cf71a9f6ae43`,
  derived in part from the whole development-exclusion list (183 domains),
  sha256 `1c22b3d71c5da0d14da7fbc2257e3387bbd8c548b2904304594fc0a61cf89ee7`

The universe was built from the tree at 505c3019, the commit that
introduced the corrected derivation. From a checkout of that commit, with
the two pinned sources and their manifests, this reproduces all three files
byte for byte:

```bash
node scripts/calibration-candidate-universe-build.mjs cname-uncloaking-2026-10 \
  tranco-N2Q7W-top1m.csv tranco-N2Q7W-manifest.json 2255 \
  cname-uncloaking-2026-10-candidates.json cname-uncloaking-2026-10-provenance.json \
  --category ercexpo-us-news-domains-v2.0.0.csv ercexpo-manifest.json \
  --pilot 100 cname-uncloaking-2026-10-pilot.json
```

The exclusion set is a function of the whole tree, so a later checkout
reproduces these files only while its derivation still yields the
exclusion-list digest above, which the build's provenance output names. A
later tree that records more development visits derives another list and
another seed; that never redraws this study, which is fixed by the
committed digests.

**The landing commit and the collection SHA.** The landing commit is the
commit on main that lands this section. It carries the fail-closed driver
and the corrected exclusion derivation by ancestry. A document cannot name
its own commit, so read it from main:

```bash
git fetch origin
git log origin/main --reverse --format=%H \
  -S'## Restart (2026-10-02)' -- docs/reliability-sweep-cluster-design.md | head -n 1
```

The collection SHA is the landing commit until a dated addition to this
section names another commit; from then on the latest such addition names
it, and the command above still prints the landing commit, not the
collection SHA. Every restarted round runs from an isolated worktree
checked out at exactly the collection SHA, with
`SITE_BEHAVIOR_LAB_BUILD_COMMIT` set to its full sha. The driver compares
that value with every report's `run.provenance.buildCommit`, and refuses to
start unless its own checkout's HEAD is that commit with no tracked change.
Nothing can read back what the server was built from (its `buildCommit` is
only the same environment variable), so the server is built fresh with
`npm run build` from that same clean checkout before the first round, never
reused from another tree. The server runs from the driver's own worktree,
so the checkout check also refuses a build that changed a tracked file.

If collection code must change after this section lands and before
restarted round 1 begins, the designation moves only by a dated addition to
this section naming the new commit. Round 1 has begun only when a complete
round-1 artifact exists: one that `collect` wrote through all 2,255 pool
cases on the collection SHA and that ended without a stop. An attempt the
driver stopped, or that was interrupted, is not a round and does not begin
one; the designation may still move after it, and the dated addition that
moves it lists every stopped attempt with its start time, the case it
stopped at, and the reason the driver printed. Once round 1 has begun
nothing moves the designation: a different collection build is a new
sweep, starting again at round 1.

**Rounds, runner, condition.** Rounds 1 to 5 run again under every rule in
this document (5 scheduled, at least 4 usable, rounds 1 and 2 the
eligibility pair at least 48 hours apart, each round at least 24 hours after
the previous one), from the operator's Mac on the home connection:
`SWEEP_RUNNER_LABEL=operator-macos-arm64`,
`SWEEP_EGRESS=as19108-optimum-residential`,
`SWEEP_EGRESS_PROBE_URL=https://sitebehavior.org/` (this project's own
public site, requested with HEAD on a fresh connection before case 1 and
after every answer), and the fixed desktop / observe / GPC-off condition.
The machine stays awake for the whole of every round. `caffeinate -is`
alone is not enough: its `-s` assertion holds only on AC power, and the
August operator script already wrapped `collect` in it. Keep the machine on
AC power with the lid open. The driver now stops a round on any scan that
spans a sleep ("Collect fails closed", below), so a sleep costs the whole
round; detecting it does not make one harmless.

**The feasibility gate for the restarted study.** The rule is preregistered
here; its number comes from restarted round 1. Let C be the bare-load-valid
count of the complete restarted round 1: the `valid` count
`summarizeSweepOutcomes` returns over the round artifact that swept all
2,255 pool cases on the collection SHA, which is the "bare-load valid"
count `collect` prints when the round ends. A candidate joins the eligible
pool only if rounds 1 and 2 are both bare-load valid, so the rounds-1/2
eligible pool can never exceed C. A
present count p of the 100-case pilot is inside the band when the
zero-uncertain rule derives a frame size for it and that size is at most C:
`tryDeriveFrameSizeFromPilotEnvelope({ present: p, absent: 100 - p,
uncertain: 0, minimumPerClass })` returns `sized: true` with
`derivedN <= C`, where `minimumPerClass` is the floor the approved policy
artifact pins (100 for `two-class-accuracy`). A p for which no frame size
derives is outside the band. The band is computed by:

```bash
node --input-type=module -e '
import { tryDeriveFrameSizeFromPilotEnvelope } from "./scripts/calibration-pilot-sizing-lib.mjs";
const ceiling = Number(process.argv[1]);
const band = [];
for (let present = 0; present <= 100; present += 1) {
  const derived = tryDeriveFrameSizeFromPilotEnvelope({ present, absent: 100 - present, uncertain: 0, minimumPerClass: 100 });
  if (derived.sized && derived.derivedN <= ceiling) band.push(present);
}
console.log(band.length === 0 ? "empty" : band.join(","));
' <C>
```

At the August ceiling, 1126, it prints exactly 18 through 82: the
superseded band below is this rule applied to a round that no longer
counts. After restarted round 1 completes, C, that round artifact's sha256,
and the printed band are recorded by a dated addition to this section,
which lands on main before any reviewer is dispatched for the 2026-10
pilot, and so before any pilot label exists. The band is NECESSARY only:
uncertain labels narrow it through the envelope, round 2 sets the real
ceiling, and the binding gate stays `assertFrameFeasible` against the
receipt's rounds-1/2 eligible count. An empty band, or a resolved pilot
outside it, stops the study, and the remedy is a larger universe and fresh
sweep rounds over the enlarged set; never a relaxed exclusion, a reused
pilot site, or a narrowed population.

**Open owner decisions, blocking restarted round 1.** Recorded 2026-10-02
by the review of the restart; each is decided by a dated addition to this
section before restarted round 1 starts, and this text decides none of
them. The owner rulings of 2026-10-03, below, decide all three.

1. **Stop classes a target may cause.** The fail-closed driver stops the
   round on each answer below, where the August driver filed an
   all-ineligible row. Each is a stop because the server declared no cause,
   so nothing in the answer separates a scanner-side failure from a
   property of the site. Some can repeat at the same case on every attempt,
   and once round 1 has begun a repeat has no remedy under this section: a
   scanner fix is a different collection build, so a new sweep, and
   dropping the case changes the candidate digest, so a new study.
   - Cause-less 503 "Public host verification timed out"
     (`PublicUrlDnsTimeoutError` in lib/url-safety.ts,
     `ScanTargetVerificationTimeoutError` in lib/scan-gate.ts): resolution
     took more than 5 seconds, which a target's slow or broken
     authoritative DNS causes as well as a slow local resolver.
   - Cause-less 503 "Public host verification could not complete"
     (`PublicUrlDnsUnavailableError`): every getaddrinfo code except
     `ENOTFOUND` and `ENODATA`, such as `EAI_AGAIN` after a SERVFAIL, which
     a target's broken DNS can return every time. The split is asymmetric:
     `ENOTFOUND` is filed as `target-unreachable`, a row recorded only
     behind the egress probe, while `EAI_AGAIN` and timeouts stop.
   - Cause-less 400 for a host that resolved to more than 64 addresses, a
     property of the target's DNS.
   - Cause-less 400 for a public-suffix or private-suffix-tenant subject,
     fixed by the URL. The gate's own checks, run offline
     (`ScanGate.prepare` with DNS, access and rate limits stubbed) over the
     2,255 pool URLs, refuse none, so no pool case is known to stop here.
   - Cause-less 500: the server's generic "The service could not complete
     this request" answer, whose reason is only in the server's log. That
     includes the persistence refusal the log records as "Refusing to
     persist an unreadable managed report (redaction-not-idempotent)",
     which page content triggers. The August server log on bd68cf4 holds
     142 of these across 2,262 cases, about 6%. Its rate at the collection SHA is unknown: later commits
     changed the redaction path, but nothing has measured the rate since.
     At an August-like rate a complete round is practically unreachable,
     with about 140 stops expected in each 2,255-case attempt.

   The decision is per class: a stop, as now; a target outcome recorded as
   the all-ineligible row; or a separately counted declared outcome, which
   changes the pass-artifact format.
2. **A stop that repeats at the same case after round 1 has begun.** Either
   a preregistered bounded rule (for example: re-run the round after a
   delay, and if the same case stops again with the same answer, record a
   declared, separately counted outcome) or an explicit statement that the
   sweep then restarts, accepted knowingly.
3. **The development-exclusion definition.** The derivation reads report
   subjects only (`reportSubjectValues` in
   scripts/calibration-development-exclusions-lib.mjs), as preregistered.
   Eight more frame domains appear in the repository, none in the 2026-10
   pilot and all in the 2,255 pool:
   - named only in code or prose: philly.com, cbslocal.com, inquirer.com,
     cbsnews.com;
   - recorded by the scanner as third-party request or iframe hosts in
     other subjects' published reports: outbrain.com (58 reports),
     bbc.co.uk (13, every one with subject bbc.com), foxbusiness.com (12,
     every one with subject foxnews.com), and ap.org (1,
     public/reports/20260817-14a52cff14d570ff6c87d9fcd1a70f5d.json, subject
     apnews.com).

   The ruling keeps the subject-only definition or widens it. A widening
   changes the exclusion list and so the seed, the pilot, and the pool:
   the universe, pilot set, and provenance are then rebuilt and committed
   by addition before any round runs, never by rewriting the committed
   2026-10 files.

**Owner rulings (2026-10-03), made before restarted round 1 began.** The
owner decided the three open decisions above on 2026-10-03. No complete
restarted round-1 artifact existed, so restarted round 1 had not begun
under the definition above.

- **R1. The unstable-redaction persistence refusal is instrument loss.** The
  scan API now declares it: a finished r2 report whose redaction is not a
  fixed point (the managed reader's `redaction-not-idempotent`) for a reason
  its own content produced (redacting it again changed it, the sanitizer
  refused evidence the page supplied, or the redacted report broke its own
  invariants) is refused as HTTP 500 with cause `report-redaction-unstable`,
  and the reason and its detail still go to the server's log. The reader
  gives the same reason for refusals the build produces on every report
  alike (a normalization identity or redaction version it cannot read, an
  exception thrown by the sanitizer itself); those stay cause-less 500s and
  stop the round, so a build that cannot read its own reports never
  completes a round of lost rows. The driver records the declared answer as a lost row:
  the all-ineligible record with `answer` `report-redaction-unstable`, not
  bare-load valid, counted against completeness, and never a site outcome.
  Every other cause-less or unknown 500 still stops the round.
- **R2. Refusals the target causes are site rows with their own reason.**
  The scan API now declares a cause for each one that answered without
  one: the host lookup that ran past its 5-second deadline
  (`host-lookup-timeout`, 503, from both deadlines that race at 5 seconds),
  a public-suffix subject (`public-suffix-target`, 400), a token-shaped
  tenant under a private suffix (`generalized-tenant-target`, 400), and a
  host with more than 64 addresses (`address-fanout-target`, 400). With
  `private-target` and `target-unreachable`, which already had declared
  causes, these are every subject-validity refusal the scan gate returns
  before a visit; `invalid-url` refuses the address as written, and the
  candidate grammar admits only addresses the server accepts, so it stays a
  stop. Subject refusals also come after a visit, when the address the
  visit ended on after its redirects is one no report can name: the r2
  builder refused an IP literal or a public suffix there as a cause-less
  500, and the managed reader refused a generalized tenant there as a
  redaction failure, which R1 would have filed as a lost row. Both now
  declare `unnameable-subject-target` (400), which is a site row: the
  address the site redirects to is the site's own and repeats at the case.
  It also covers a requested IP literal, which the gate admits and the
  builder refuses after the visit; the candidate grammar admits no IP
  literal. The site-specific server errors the
  server attributes to the target with a declared cause are the 504
  `page-load-timeout`, already a site row, and the 502 `page-load-failed`.
  The scanner declared `page-load-timeout` for any exhaustion of its
  45-second budget, including one in its own setup (the browser, the
  Shields engine, the scan proxy, the context, page and DevTools sessions)
  before the page was requested, which a wedged browser causes. It now
  declares `page-load-timeout` only for a navigation that timed out inside
  the full 30-second navigation window and for a budget that ran out after
  the page had that window, during collection; a budget exhausted in setup,
  or a navigation that timed out inside a window the setup cut short,
  declares `service-error` (503) and stops the round.
  The scanner's navigation failure was a cause-less 502 when the rulings
  were made, and it also carried the scan proxy's own failures (a resolver
  failure on the navigation, the proxy's traffic bound), so under this
  ruling it could not stay a site row by status. The scanner now declares
  `page-load-failed` only for a navigation failure it attributes to the
  site: Chromium names a network error that is not the scanner's own
  machine's or Chromium's generic one, the scanner's own route did not
  abort the navigation, no proxy budget refused a stream and its block
  record is not full, every proxy refusal of the target or a redirect hop
  is the site's answer (its name has no address by the resolver's
  authoritative answer, its server refused or dropped the connection or
  sent an unusable response, or it redirected to a port the scanner does
  not open), and a proxy or tunnel error has such a refusal on record. Any
  other navigation failure stays a cause-less 502 and stops the round. Each
  site answer is recorded as the all-ineligible record with its cause as
  its `answer`. The driver records them at
  the first occurrence, with no retry: these answers repeat at the same
  case, so they never stop a round and the repeat question in decision 2
  does not arise for them. Infrastructure failures still stop the round,
  as listed below.
- **R3. "Development-visited" means a site the scanner opened as the page
  under test**, requested or landed on. A host recorded only as a third
  party inside another subject's report, or named only in code or prose,
  is not development-visited. outbrain.com, bbc.co.uk, foxbusiness.com and
  ap.org (recorded only as third-party hosts inside other scans) and
  philly.com, cbslocal.com, inquirer.com and cbsnews.com (named only in
  code or prose) stay in the pool. The derivation already applied this
  definition, so the universe, the pilot set, the provenance, the seed, and
  every digest above are unchanged.

Every answer class, and how the restarted rounds handle it. A row is
recorded only while the egress probe after the answer succeeds and the
scan's clocks agree; any answer, a report included, stops the round
otherwise.

| Answer from `/api/scan` | Handling | Row `answer` |
| --- | --- | --- |
| 200, a ScanReport v2 r2 single report from the declared build under the declared condition, with its quality ledger | report row, read from the report | `report` |
| 400 `target-unreachable` (`ENOTFOUND`, `ENODATA`, or no address) | site row | `target-unreachable` |
| 400 `private-target` | site row | `private-target` |
| 504 `page-load-timeout` | site row | `page-load-timeout` |
| 502 `page-load-failed` (a navigation failure the scanner attributes to the site) | site row | `page-load-failed` |
| 503 `host-lookup-timeout` (R2) | site row | `host-lookup-timeout` |
| 400 `public-suffix-target` (R2) | site row | `public-suffix-target` |
| 400 `generalized-tenant-target` (R2) | site row | `generalized-tenant-target` |
| 400 `address-fanout-target` (R2) | site row | `address-fanout-target` |
| 400 `unnameable-subject-target` (R2: after the visit, the address requested or the one it ended on is an IP literal, a public suffix, or a generalized tenant) | site row | `unnameable-subject-target` |
| 500 `report-redaction-unstable` (R1) | lost row | `report-redaction-unstable` |
| 500 with no declared cause: every other managed-reader refusal (`producer-contract-mismatch` and the rest), a `redaction-not-idempotent` refusal the build produces (an unreviewed normalization identity, an unsupported or mixed redaction version, an exception in the sanitizer), the oversized-report refusal, every other builder refusal, any internal error | stop | none |
| 503 with no declared cause: a resolver failure ("Public host verification could not complete": `EAI_AGAIN` and every getaddrinfo code but `ENOTFOUND` and `ENODATA`), a misconfigured r2 producer | stop | none |
| 502 with no declared cause: a navigation failure the scanner could not attribute to the site (a resolver failure or the proxy's traffic bound on the navigation, the scanner's own route abort, a proxy budget refusal, a tunnel failure with no recorded reason, a browser that closed) | stop | none |
| any other answer with no declared cause, such as the 400 for more than one comparison mode | stop | none |
| a declared `invalid-url`, `scanner-busy`, `request-limit`, `challenge-required`, `access-key-required`, `request-rejected`, `feature-unavailable`, `scan-conflict` or `service-error`, or a cause the driver does not know | stop | none |
| 202 (asynchronous or durable admission), a redirect, any other non-error status | stop | none |
| a 200 that is not an r2 single report, is from another build or condition, or carries no quality ledger; a malformed body | stop | none |
| a transport failure to the local server (a dead server included) | stop | none |
| the egress probe failing after an answer, or a scan whose wall-clock and monotonic durations differ by more than 5 seconds or exceed 180 seconds | stop | none |
| the driver's checkout not at the declared build with no tracked change, or the egress probe failing before case 1 | the round does not start | none |

Two consequences follow, and both are deliberate. The asymmetry recorded
under decision 1 remains: `ENOTFOUND` is a site row and a resolver
failure such as `EAI_AGAIN` stops, because the rulings name the lookup
timeout and not the resolver failure. And a stop class that repeats at the
same case after round 1 has begun is still cleared only by a fix that does
not change the collection build; otherwise it starts a new sweep, as
above. A third follows that is not deliberate, and is recorded under "Collect
fails closed" below: a slow resolver on the instrument's side can produce
`host-lookup-timeout` site rows that the egress probe does not catch.

How site and lost rows count. Both are the all-ineligible record: not
bare-load valid, not all-families-complete, and in the denominator of
every bounded quantity, so a lost row lowers C, the eligible pool, and
both loss bounds exactly as a site row does. A candidate with a site or
lost row in round 1 or round 2 is not eligible. A round whose 2,255 rows
include site or lost rows is still complete under the definition above,
because the driver wrote every case without a stop. A lost row also counts
as censored in every evidence family: the scanner measured the visit and
then lost all of its evidence, so it is detector-input loss in each family
(`rowCensoredFamilies` in scripts/calibration-reliability-sweep-lib.mjs,
the one rule the receipt's `familyCensorCounts`, `collect`'s summary and
the bound's per-family censor bounds all read; the bound artifact is
version 2 for this). A site row is censored in no family: the site gave
the scanner nothing to measure, so it counts in every denominator as a
case that is not valid, as site rows always have. `collect` prints the
round's rows by answer and its lost count beside the bare-load-valid
count.

The pass artifact is version 4. Version 3 rows had no way to say why a row
carried no report, so a lost case was indistinguishable from a site that
failed to load. Every row now carries `answer`, closed by value
(`SWEEP_ROW_ANSWERS` in scripts/calibration-reliability-sweep-lib.mjs, pinned
to the classifier's site and lost causes in both directions), and a site or
lost row must equal the all-ineligible record field by field. The check
runs wherever a row is read: building and reading a pass artifact, receipt
assembly and validation, the summary, eligibility, and the bound's
reassembly. `validatePassArtifact` refuses version 3, so no version 3 round,
the superseded August round 1 among them, can be assembled with a
restarted one; the identity rules (study, candidate set, build, runner,
egress, condition) are unchanged. The receipt keeps its shape, and its rows
carry the same `answer`.

These rulings change collection code (the scan API and the driver), so the
collection SHA moves by the dated addition that follows.

**Collection SHA (2026-10-03).** The collection SHA is
`15158e58d25050572d95d0f6fab6d70886504cb6`, the commit "Record target-caused refusals as site rows and the
unstable redaction refusal as loss", which implements the rulings above.
It carries by ancestry the fail-closed driver, the corrected exclusion
derivation, the egress, clock and checkout checks, and the declared causes
the rulings rely on. Every restarted round runs from an isolated worktree
checked out at exactly this commit, with `SITE_BEHAVIOR_LAB_BUILD_COMMIT`
set to it and the server built fresh from that clean checkout, as above.
The locator command above still prints the landing commit, which predates
the instrument checks and these rulings; it is not the collection SHA. No
stopped attempt of restarted round 1 is recorded as of this addition.

**Collection SHA (2026-10-03).** A review of the rulings' implementation,
made before restarted round 1 began, moved the collection SHA to
`ed6c02e46315449387f2d1a510338b71a40e81a4`, the commit "Follow the
setup-phase deadline in the context-cache source pin", the last of the
review's commits; it changes a test only, and the one before it, 44963e43,
holds the last collection-code change. It supersedes 15158e58, on which no
attempt of restarted round 1 ran. Between the two,
the review changed how four answer classes are handled, each now as the
table above states: the scanner declares `page-load-failed` only for a
navigation failure it attributes to the site, and the cause-less 502 now
stops the round (R2 admits a server error as a site row only with a
declared cause); a redirect to an address no report can name declares
`unnameable-subject-target`, a site row, where it was a cause-less 500 or
a lost row (R2's subject refusals); the unstable-redaction loss is
declared only for a report's own fixed-point failure, and the same reader
reason produced by the build stops the round (R1); and a scan budget spent
in the scanner's own setup, or a navigation window its setup cut short,
declares `service-error` and stops the round instead of being a
`page-load-timeout` site row (R2). The durable path declares the same
persistence refusals, and the per-family censor counts and bounds count a
lost row as censored in every family. Every restarted round runs from an
isolated worktree checked out at exactly this commit, with
`SITE_BEHAVIOR_LAB_BUILD_COMMIT` set to it and the server built fresh from
that clean checkout, as above. No stopped attempt of restarted round 1 is
recorded as of this addition.

The pass artifact stays version 4. The review changed the values its
closed `answer` field admits (`navigation-failure` became
`page-load-failed`, and `unnameable-subject-target` joined the site
answers), not its fields, and no version 4 round exists, so no artifact
holds the retired value; every validator reads `SWEEP_ROW_ANSWERS`, so a
row with any other answer is refused wherever it is read. The assembly and
identity rules are unchanged. The loss-bound artifact is version 2,
because its per-family censor bounds now count a lost row as censored; no
bound has been computed over a version 4 round.

## Why two passes were not enough

The adopted censoring decision sizes per-detector policies from a defensible
detector-input loss bound. The repository's own censoring analysis is
explicit about what defensible means: its cluster bootstrap refuses fewer
than three clusters outright
(`scripts/cluster-interval-lib.mjs`, extracted verbatim from
`research/calibration-censoring/analyze-corpus-censoring.mjs` with the
committed findings' byte-exact reproduction as proof), and its README records
that a per-case Wilson endpoint over two clusters "is not a defensible design
lower bound", only an iid diagnostic. The two-pass caller produced exactly
two time clusters and descriptive counts, so the loss bound the decision
requires was uncomputable by the repository's own standard.

## The design, fixed before collection

- **Cluster unit: the collection round.** One round is one contiguous
  collection session over the entire candidate set, under one build, runner,
  egress, and measurement condition.
- **Rounds are disjoint sessions.** Every round begins at least
  `SWEEP_MINIMUM_ROUND_SEPARATION_MS` (24 hours) after the previous round's
  last observation, enforced at assembly. Two rounds an hour apart mostly
  re-measure one web state, which is the two-cluster problem by another
  route.
- **Rounds 1 and 2 remain the eligibility pair**, at least 48 hours apart
  per case, exactly as before: a candidate joins the eligible pool only if
  both are bare-load valid. Eligibility semantics are unchanged by this
  design.
- **Scheduled rounds: 5. Minimum usable for the bound: 4**
  (`SWEEP_BOUND_MINIMUM_ROUNDS`), one above the bootstrap implementation's
  own hard floor of 3, which is the implementation's bare minimum, not a
  design target. If attrition leaves fewer than 4 usable rounds, the remedy
  is MORE ROUNDS, and nothing else.
- **Bound method**: the repository's one cluster-bootstrap implementation,
  shared with the censoring analysis: resample rounds with replacement,
  4000 iterations, fixed seed 20260816, report the 2.5% and 97.5%
  percentiles. Bounded quantities: the bare-load-valid fraction, the
  all-families-complete fraction (the conservative per-detector scoreable
  floor), and the per-family censor fractions for all six evidence families.
- **Fail-closed, never iid.** Below 4 usable rounds the bound command
  throws; it never emits a Wilson interval, a wider interval, or a partial
  artifact. Identity or condition drift between rounds refuses assembly as
  two sweeps. A partial round is re-run, never assembled. There is no code
  path from insufficient clusters to any published number.
- **The frame producer sizes from the bound artifact and nothing else**:
  not from the receipt's descriptive counts, not from a console line, not
  from any single round.

## Collection procedure

One `collect <round>` invocation per round (rounds 1 to 12 accepted; 5
scheduled), all on the identical collection SHA from an isolated worktree,
with identical `SITE_BEHAVIOR_LAB_BUILD_COMMIT`, `SWEEP_RUNNER_LABEL`,
`SWEEP_EGRESS`, and the fixed desktop / observe / GPC-off condition. Then
`receipt` over all round artifacts, then `bound` over the receipt. The
receipt binds the candidate set and every round artifact by digest; the
bound artifact binds the receipt by digest and records the method
parameters, so a stranger can recompute every number.

**Collect fails closed.** A round records a row only for a report; for
the scanner's declared failure to measure the target, a site row
(`target-unreachable`, `private-target`, `page-load-timeout`, and, under
the 2026-10-03 owner rulings, `page-load-failed`, `host-lookup-timeout`,
`public-suffix-target`, `generalized-tenant-target`,
`address-fanout-target` and `unnameable-subject-target`); or for the
scanner losing a measurement it made, a lost row
(`report-redaction-unstable`). Site and lost rows are the all-ineligible
record and carry their answer, so instrument loss is never read as a site
outcome ("Owner rulings (2026-10-03)" above has the full table). The site
answers are the scanner's observation, not proof about the site: the same
answers come back when the instrument itself fails. The gate reads
getaddrinfo `ENOTFOUND` as an authoritative "no such name", and a Mac with
no network or no reachable resolver daemon answers `ENOTFOUND` for every
name in milliseconds; an upstream connection that fails because the
instrument's own egress went down reads, to the scan proxy, like a site
that refused it, and `page-load-failed` is declared on it; and the
scanner's 45-second budget is wall-clock,
so a scan that spans a sleep times out. So a row is recorded only while the
instrument was sound for that scan:

- **Egress.** `SWEEP_EGRESS_PROBE_URL` is requested before case 1 and again
  after every answer, each time on a fresh getaddrinfo lookup and a fresh
  connection. A failed probe before case 1 starts nothing; a failed probe
  after an answer stops the round on that case, whatever the answer was.
- **Clock.** A scan whose wall-clock and monotonic durations differ by more
  than 5 seconds (the machine slept, or its clock was stepped), or whose
  wall-clock duration exceeds the driver's 180-second deadline, stops the
  round, reports included.
- **Checkout.** `collect` refuses to start unless the driver's own checkout
  is at `SITE_BEHAVIOR_LAB_BUILD_COMMIT` with no tracked change.

Every other answer stops the round too: a transport failure to the local
server; a scanner-side refusal (our access gate, our own rate limit, an r2
producer that is misconfigured or cannot persist for any reason but the
unstable redaction, an internal error, a busy, asynchronous or durable
deployment, any other declared cause, an unknown cause, or any cause-less
refusal, which includes the resolver's failures such as `EAI_AGAIN`, every
cause-less 500, the 502 navigation failure the scanner could not attribute
to the site, and, from a server older than the 2026-10-03 causes, the
lookup timeout, the subject refusals and every navigation failure); a
malformed body; and any report that is not a ScanReport v2 r2 single
report whose
`run.provenance.buildCommit` equals `SITE_BEHAVIOR_LAB_BUILD_COMMIT` under
the declared condition, or that carries no per-family quality ledger. Every
case is checked, not only the first. The stop prints the server's error and
declared cause and the probe's result, exits non-zero, and leaves the round
artifact as the previous case wrote it; that partial round is re-run in
full, never resumed, and receipt assembly refuses it. Filing a scanner
refusal as the site's row would drop the site from the eligible pool for a
reason the site never caused. A refusal that repeats on every re-run at the
same case (for example `invalid-url`) is a candidate-set or scanner defect
to adjudicate, not a site outcome to record; which answers a target
itself causes, and what happens when a stop repeats after round 1 has
begun, are decided by the 2026-10-03 owner rulings in "Restart
(2026-10-02)" above. The split lives in
`scripts/calibration-reliability-sweep-response-lib.mjs`, pinned by test to
the `ScanFailureCause` union, to the single producers of `page-load-failed`
and of the lost cause, and to the row answers; the instrument checks live
in `scripts/calibration-reliability-sweep-instrument-lib.mjs`.

Two residuals remain recorded as site outcomes, because nothing outside
the scanner can see them: an outage that begins and ends strictly inside
one scan (the probes on either side both answer), and an awake instrument
too slow to finish a healthy page inside the scanner's 45-second budget.
Separating either needs the scanner to declare a scanner-side cause. Since
the 2026-10-03 review it does so for the part of the second it can see: a
budget spent in its own setup, before the page is requested, or a
navigation window its setup cut below the 30-second navigation timeout,
declares `service-error` and stops the round ("Owner rulings", R2, above).
A slow collection after a full navigation window, and an outage inside one
scan, still read as the site's.

A third residual follows from the 2026-10-03 ruling that a lookup timeout
is a site row, and the egress probe as built does not separate it. The
probe resolves one fixed host, so the system resolver can answer it from
its cache while lookups of uncached target names go upstream, and it allows
10 seconds (`SWEEP_EGRESS_PROBE_TIMEOUT_MS`) for its lookup, connection and
answer together, while the gate refuses a target lookup after 5 seconds. A
resolver that degrades on the instrument's side, slow but not dead, can
therefore turn every uncached target lookup into a `host-lookup-timeout`
site row while the probe after each answer still passes, and the round
completes. Before the ruling the same answers stopped the round. One
mechanism inside the server is bounded by configuration rather than code:
`dns.lookup` runs on libuv's thread pool, four threads by default, the scan
proxy resolves every host a page reaches on that pool and cannot cancel a
lookup, and the gate's 5-second target lookup counts time spent queued
behind them, so lookups left over from one case can push the next case's
lookup past its deadline (docs/critical-use-audit-2026-09-01.md records the
mechanism; it was not reproduced). The production image sets
`UV_THREADPOOL_SIZE=16` for it (Dockerfile). The operator's sweep script,
stage-and-collect-2026-10.sh, kept outside the repository, starts the sweep
server with the same `UV_THREADPOOL_SIZE=16` and records it in the server
environment every later round must match, so it is fixed before round 1.
That narrows the queueing; it does not remove a slow upstream resolver.
The rest is recorded here, not mitigated: the rulings authorize no rule
against it, and a mitigation that needs code is a new collection build,
named by a further dated addition before round 1 begins.

## Prevalence and sizing

The withdrawn 0.50 base-rate assumption is not replaced by another
assumption. Prevalence for the declared scope is estimated from the
PRECOMMITTED DISJOINT PILOT, preregistered here in full:

- **Partition, not prefix.** The universe builder
  (`scripts/calibration-candidate-universe-build.mjs`) fixes ONE sampling frame
  (the first pilotSize + poolSize scoped survivors in source order) and
  splits MEMBERSHIP by a seeded Fisher-Yates shuffle
  (`seeded-fisher-yates-sha256-v1`). A prefix pilot would confound the
  estimate with popularity rank, which can correlate with CNAME deployment.
  The seed derives entirely from the committed inputs (study id, source and
  category digests, exclusion-list digest, the two sizes), so there is no
  free parameter through which a partition could be steered, and any auditor
  re-derives the identical split from the artifacts alone. The provenance
  records the method, seed, and frame size.
- **Development exclusion.** Repository data may only REMOVE a candidate.
  The frame drops every domain that a repository surface records as visited
  by this project's scanner or studies; the surfaces are the closed list
  `DEVELOPMENT_EXCLUSION_SURFACES` in
  scripts/calibration-development-exclusions-lib.mjs, and every other file
  under the scoped roots is classified there with the reason it is not read.
  Each recorded host contributes its www-stripped form and its registrable
  domain (redaction placeholders such as `{label}` dropped first). A declared
  surface that is missing or unparseable, or a record that names no domain,
  refuses the build instead of shrinking the set. This study's own
  artifacts under `calibration/cname-uncloaking-*` are never read, so a
  rebuild cannot exclude its own pilot. The set is a function of the whole
  tree, so a universe re-derives only from the commit it was built at. The
  2026-08 universe predates this derivation: its builder read a `config/`
  directory that never existed and skipped the featured catalog, the corpus
  seed, and the screening rows, and it admitted seven development-visited
  frame domains (cnn.com, forbes.com, spiegel.de, elpais.com,
  telegraph.co.uk, dailymail.co.uk, washingtonpost.com). The restarted study
  `cname-uncloaking-2026-10` is built with this derivation.
- **Pilot size**: at least `PREREGISTERED_PILOT_MINIMUM` = 100, because the
  Wilson 95% half-width at the worst case (p = 0.5) is 0.096 at n = 100,
  inside the programme's 0.10 half-width convention. The builder refuses a
  smaller pilot: no prevalence estimate, no universe.
- **Labeling**: reviewers label the pilot under the independent reference
  protocol, never the detector's own output; the pilot's sites are excluded
  from the confirmatory pool by construction.
- **The exact sizing rule** (`deriveFrameSizeFromPilot`,
  scripts/calibration-pilot-sizing-lib.mjs): with [pLower, pUpper] the
  pilot's Wilson 95% interval, N is the SMALLEST integer such that
  P(Binomial(N, pLower) >= minimumPerClass) >= 0.99 AND
  P(Binomial(N, 1 - pUpper) >= minimumPerClass) >= 0.99, computed with the
  exact binomial tail. Both reference classes are guarded at their own
  conservative endpoint; under the v4 side-separated model the reference
  margins do not depend on scan-side completeness, so this rule converts
  prevalence uncertainty alone, and the prediction-side margins remain the
  study preregistration's detector-specific power calculation against the
  sweep's loss bound.

- **Uncertain pilot labels** (preregistered 2026-08-24, before any pilot
  label exists): a resolved `uncertain` can be either class, so the
  interval is the assignment envelope in the policy-C spirit:
  the lower endpoint is the Wilson lower bound of present/total (every
  uncertain treated as absent) and the upper endpoint is the Wilson upper
  bound of (present+uncertain)/total (every uncertain treated as present),
  implemented once as `deriveFrameSizeFromPilotEnvelope` sharing the point
  rule's search. With zero uncertain labels this reduces exactly to the
  rule above, and the envelope N is monotonically at or above the point
  rule's N.
- **Early feasibility gate (2026-08), SUPERSEDED by the 2026-10-02
  restart and kept as history.** The restarted study's gate is the rule in
  "Restart (2026-10-02)" above; nothing in this bullet binds it. As
  recorded 2026-08-24 against round 1 of the August sweep (artifact sha256
  `7dfc91056e1f194ae2b53c6807d0c6ffe0064b58dbb3fce817ffe05dd81e00e3`):
  round 1 observed 1,126 bare-load-valid cases of
  2,262, so the rounds-1/2 eligible pool can never exceed 1,126. At that
  optimistic ceiling a 100-case pilot must resolve between 18 and 82
  present labels for the reference-class rule to fit (18/100 derives
  N=1053; 17/100 derives 1132). The band is the zero-uncertain boundary
  and therefore NECESSARY only: uncertain labels narrow it through the
  envelope, and round 2 sets the real ceiling. Outside the band the run
  stops and the universe is enlarged; never a relaxed exclusion, a reused
  pilot site, or a narrowed population.

FAIL CONDITION (`assertFrameFeasible`): a derived N larger than the swept
eligible pool is infeasibility, and the remedy is a larger universe plus
fresh sweep rounds over the enlarged set, never a relaxed exclusion, a
reused pilot site, or a population narrowed to fit. The function offers no
parameter through which any of those could be expressed.

## What this design does not decide

No frame size, no threshold on the bound's value, and no candidate set. The
candidate universe is constructed independently of scanner results under the
frame-construction rules, and whether the bounded loss and the pilot's
prevalence estimate support any given N under the per-detector policies is
the frame producer's preregistered arithmetic, taken against the bound
artifact after collection.
