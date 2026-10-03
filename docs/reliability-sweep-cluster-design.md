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
   0694781e and 591c3096 ("Collect fails closed", below).
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

From a checkout of the collection SHA, with the two pinned sources and their
manifests, this reproduces all three files byte for byte:

```bash
node scripts/calibration-candidate-universe-build.mjs cname-uncloaking-2026-10 \
  tranco-N2Q7W-top1m.csv tranco-N2Q7W-manifest.json 2255 \
  cname-uncloaking-2026-10-candidates.json cname-uncloaking-2026-10-provenance.json \
  --category ercexpo-us-news-domains-v2.0.0.csv ercexpo-manifest.json \
  --pilot 100 cname-uncloaking-2026-10-pilot.json
```

**The collection SHA.** The collection SHA of the restarted sweep is the
commit on main that lands this section. It carries the fail-closed driver
and the corrected exclusion derivation by ancestry, and the universe above
reproduces from it. Every restarted round runs from an isolated worktree
checked out at exactly that commit, with `SITE_BEHAVIOR_LAB_BUILD_COMMIT`
set to its full sha, which the driver now compares with every report. A
document cannot name its own commit, so read it from main:

```bash
git fetch origin
git log origin/main --reverse --format=%H \
  -S'## Restart (2026-10-02)' -- docs/reliability-sweep-cluster-design.md | head -n 1
```

If collection code must change after this section lands and before
restarted round 1 begins, the designation moves only by a dated addition to
this section naming the new commit. Once round 1 has begun nothing moves
it: a different collection build is a new sweep, starting again at round 1.

**Rounds, runner, condition.** Rounds 1 to 5 run again under every rule in
this document (5 scheduled, at least 4 usable, rounds 1 and 2 the
eligibility pair at least 48 hours apart, each round at least 24 hours after
the previous one), from the operator's Mac on the home connection:
`SWEEP_RUNNER_LABEL=operator-macos-arm64`,
`SWEEP_EGRESS=as19108-optimum-residential`, and the fixed desktop / observe /
GPC-off condition. The machine stays awake for the whole of every round.
`caffeinate -is` alone is not enough: its `-s` assertion holds only on AC
power, and the August operator script already wrapped `collect` in it. Keep
the machine on AC power with the lid open. Nothing in the driver detects a
sleep; that is a known gap, not a preregistered rule.

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

**Collect fails closed.** A round records a row for a site outcome only:
a report, or a refusal the server declared against the target
(`target-unreachable`, `private-target`, `page-load-timeout`, or the
scanner's cause-less navigation failure, HTTP 502), which projects to the
all-ineligible row exactly as before. Every other answer stops the round:
a transport failure to the local server; a scanner-side refusal (our access
gate, our own rate limit, an r2 producer that is misconfigured or cannot
persist, an internal error, a busy, asynchronous or durable deployment, any
other declared cause, an unknown cause, or a cause-less refusal); a
malformed body; and any report that is not a ScanReport v2 r2 single report
whose `run.provenance.buildCommit` equals `SITE_BEHAVIOR_LAB_BUILD_COMMIT`
under the declared condition, or that carries no per-family quality ledger.
Every case is checked, not only the first. The stop prints the server's
error and declared cause, exits non-zero, and leaves the round artifact as
the previous case wrote it; that partial round is re-run in full, never
resumed, and receipt assembly refuses it. Filing a scanner refusal as the
site's row would drop the site from the eligible pool for a reason the site
never caused. A refusal that repeats on every re-run at the same case (for
example `invalid-url`) is a candidate-set or scanner defect to adjudicate,
not a site outcome to record. The split lives in
`scripts/calibration-reliability-sweep-response-lib.mjs`, pinned by test to
the `ScanFailureCause` union and to the single producer of the cause-less
502.

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
