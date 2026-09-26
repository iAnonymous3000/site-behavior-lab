# CI performance audit (2026-09-25)

This audit asked one question: how much of the time between a push to `main`
and a verified production deploy can be removed without weakening any gate.
It measured first, changed only what the measurements supported, proved each
changed gate still fails on a deliberately broken input, and left every
decision that belongs to the owner as a recommendation.

## Result in one table

Medians of `main` push runs, with the range in parentheses. "Before" is the
10 newest successful runs before this audit. "After" is the two runs after both
the lanes and the cache change landed (runs 36210992876 and 36212402337).
Branch runs with at least three samples per group, below, back each change
separately.

| | Before, n=10 | After, n=2 | Change |
| --- | ---: | ---: | ---: |
| Push to last job done (end to end) | 1270 s (1218 to 1471) | 1036 s (1019 to 1053) | -234 s (-18%) |
| Docker Runtime and Public R2 Smoke (critical path) | 1230 s (1180 to 1431) | 986 s (986 to 986) | -244 s |
| of which "Build exact deployable Docker image" | 952 s (924 to 1098) | 719 s (688 to 750) | -233 s |
| Typecheck and Unit Tests | 850 s (716 to 969) | 607 s (501 to 713) | -243 s |
| of which "Unit tests" | 728 s (594 to 844) | 502 s (413 to 592) | -226 s |

No gate was removed, skipped or loosened, and the lanes add two checks of
their own (a lint that keeps load-sensitive tests serial, and a tripwire on
`dist/`). `npm run release:readiness` reports the same 16 gates with the same
outcomes, line for line, before and after. The
docker job is still the critical path. The largest remaining items need owner
decisions (below), chiefly repeating the unit suite inside the image on a
different Node version.

## Baseline

### CI, 10 newest successful push runs on `main`

Runs 35950939625, 35960875726, 36030319730, 36035942242, 36044502963,
36060049528, 36061136753, 36091857132, 36134169270 and 36190745647 (SHAs
`84f8cc3` through `89ae341`). Every run was attempt 1 with every job green.
"End to end" is run creation to the last job's completion.

| | median | min | max |
| --- | ---: | ---: | ---: |
| End to end | 1270 s (21.2 min) | 1218 | 1471 |
| Docker Runtime and Public R2 Smoke | 1230 s | 1180 | 1431 |
| of which "Build exact deployable Docker image" | 952 s | 924 | 1098 |
| of which "Publish the tested production image" | 91 s | 81 | 129 |
| Typecheck and Unit Tests | 850 s | 716 | 969 |
| of which "Unit tests" | 728 s | 594 | 844 |
| Build and Static Export | 604 s | 444 | 634 |
| of which "GitHub Pages static export" | 384 s | 269 | 409 |
| Supply-chain Security | 244 s | 177 | 264 |
| Chromium Smoke Test | 141 s | 105 | 156 |
| Attest / promote | 14 s / 14 s | | |

The docker job was the critical path in 10 of 10 runs, and it finished a median
381 s (at least 291 s) after the tests and pages join. The idle time between
dependent jobs was 2 to 4 s (one 39 s outlier). Job queueing was 1 to 4 s.
Docker savings therefore reach end to end one for one, up to about 291 s,
before the tests job takes over the critical path.

Inside the image build, `RUN npm run check` (BuildKit step #15) took 949.8,
854.2 and 812.7 s in the three runs whose log tails include it. Of that, the
serial lib suite took 526 to 648 s and the corpus-overview group 141 to 147 s;
`next build` took 89 to 94 s. After #15 came the export to the local daemon
(#26, about 54 s including a 35 s import) and the GitHub Actions cache export
(#28, 13.7, 36.7 and 113.4 s).

### Local profile

One `npm run check` on a 4-vCPU, 15 GB Linux container (the same shape as a
GitHub-hosted runner), Node 24.14.1 and npm 11.11.0, alone on the machine,
2026-09-25 22:03 to 22:23 UTC. The 1-minute load average stayed at a mean of
1.27 (maximum 3.15), so the suite used about one of four cores.

| Stage | Seconds |
| --- | ---: |
| `typecheck` | 13.8 |
| `cf:typecheck` | 4.5 |
| test compile (`tsc -p tsconfig.test.json`) | 19.1 |
| lib tests, 343 files, `--test-concurrency=1` | 802.1 |
| `test:corpus-overview` | 183.9 |
| 12 further `test:*` stages | 39.4 |
| `next build`, cold / warm | 92.6 / 70.8 |
| `build:pages`, cold / warm | 453.3 / 446.4 |
| `test:smoke:static` | 81.4 |

The lib stage's 759 s of test time is concentrated: the slowest file
(`scanner.test.ts`, 177 s, mostly Chromium waiting on timers) is 23 percent,
the slowest 5 files 55 percent, and the slowest 11 files 79 percent. Most of
the rest of the top 11 read and re-validate the whole committed corpus (982
reports, 156 MB) in their own process.

Slowest files, summed test time: `scanner` 176.9 s, `report-contract` 102.4,
`release-readiness` 50.7, `measurement-candidate-binding` 48.2,
`publication-transparency-log-corpus` 37.9, `print-row-caps` 36.1,
`scan-report-v2-r2-producer-contract` 34.9, `release-evidence` 32.5,
`scan-report-corpus-roundtrip` 30.1, `scanner-policy-navigation` 27.9.

Slowest tests: "every committed report is a sanitizer fixed point, and so is
its sanitized form" 63.9 s; "the committed manifest preserves its gate contract
without requiring evidence to remain absent" 43.4 s; "every logged entry
matches the report bytes actually committed" 37.8 s; "static fixture reports
are current version-aware managed reports" 36.2 s; "every print row cap clears
the corpus maximum it claims to be derived from" 36.1 s; "every committed
managed bundle remains readable through the exact producer rows" 34.8 s; "a
public page that stalls after a loopback WebSocket probe is a load timeout, not
a private target" 30.2 s (a timer bound).

`build:pages` barely benefits from its compiler cache (453 vs 446 s): about 90
percent of it is proportional to the corpus (the remediation check, three full
corpus audits, page data, and 3,192 generated pages). Two builds of the same
SHA are not byte-identical (Next's random build ID, and `generatedAt` in two
JSON files), so any cache proof has to compare with those masked.

### Flake history

The 60 most recent CI runs (2026-09-07 to 2026-09-25) contain zero test flakes:
no test failed and then passed on a rerun or on the same SHA. Of 37 failed
runs, 14 ran no jobs (automation pull requests awaiting approval), 7 failed only
on live advisory state (npm audit or Trivy), 3 tripped the Brave list adoption
gate by design, 6 were dependency-bump regressions, 3 were real regressions, and
4 were a missing promotion App installation. Widening to 100 runs finds one
timing flake: `lib/policy-pdf.test.ts` failed in the image with "the parse
returned after 499ms against a 500ms deadline" (run 34058977553), fixed by
`2dcfeaa`. GitHub-hosted runners do not report load averages; the same SHA
built twice in the same minute agreed within 1.8 to 3.2 percent, while unit
suite durations across runners span 476 to 713 s in two clusters, which fits
hardware variance rather than contention.

## What landed

Each change was measured on the throwaway branch `claude/sleepy-curie-9ezvmn`
with `workflow_dispatch` runs, which skip publication, attestation and
promotion, so branch medians are compared with branch medians. The baseline for
branch runs is commit `efd4aa0` (main `89ae341` plus a documentation stub, never
landed): runs 36201194884, 36201198641 and 36201200380.

### 1. Load-insensitive lib tests run three at a time (`scripts/unit-test-lanes.mjs`)

The lib suite ran strictly one file at a time, so a 4-vCPU runner sat at a load
near 1.3 through the longest phase of both the host tests job and the in-image
check. `test:unit` now runs the compiled lib tests in two phases.

- **Serial lane.** The 61 files in `scripts/unit-test-serial-lane.json`, each
  with its reason, keep exactly their former conditions: one at a time, after
  everything else, with nothing beside them. They are the Chromium launches,
  wall-clock and CPU-time assertions, timers and short deadlines, Miniflare
  runtimes, Git fixture teardown races, and the one test that recompiles
  `dist/schema` in place.
- **Parallel lane.** The other 282 files run first, three at a time and each in
  its own process as before, while the corpus-overview group (one process by
  design) runs beside them.
- **Fail-closed.** A failure in the parallel phase stops the run before the
  serial lane. So does any change to `dist/` during it, because several tests
  read `dist/schema` and `tsc` rewrites it in place. An empty lane is skipped,
  never handed to `node --test` with no files.
- **Guarded.** `scripts/unit-test-lanes.test.mjs` forces any lib test matching
  a browser, timing, timer, deadline, direct Git or Miniflare pattern into the
  serial lane, checks the partition and the `test:unit` wiring, and runs the
  real CLI to prove it fails when a parallel test, the alongside command, a
  serial test or a `dist/` rewrite fails.

The same 3534 lib tests run with the same assertions, timeouts and tolerances.

**How the partition was chosen.** An investigator screened every test file for
hazards. Then eight independent reviewers read all 296 proposed parallel-lane
files in full, following spawned scripts and helpers, and tried to refute each
one. That found the one real shared-path writer
(`controlled-publication-receipt.test.ts` recompiles `dist/schema` under a 60 s
timeout) and four Git and timeout hazards, all moved to the serial lane. A
three-lens adversarial review of the diff then moved
`release-tag-governance-receipt.test.ts` for the same Git teardown race, and
led to the empty-lane guard and to ending through `process.exitCode`.

**Measured.**

| | Baseline, n=3 | Lanes, n=12 | Change |
| --- | ---: | ---: | ---: |
| Host "Unit tests" step | 819 s (659 to 845) | 544 s (432 to 587) | -275 s (-34%) |
| Typecheck and Unit Tests job | 932 s (767 to 972) | 666 s (526 to 712) | -266 s |
| In-image `npm run check` (#15), n=3 and 9 | 776 s (744 to 891) | 669 s (481 to 691) | -107 s |
| Docker job | 1147 s (1117 to 1169) | 936 s (857 to 1129) | -211 s |
| End to end (branch runs) | 1150 s (1119 to 1171) | 938 s (859 to 1131) | -212 s |

Locally, alone on 4 vCPUs, `npm run check` fell from 1160 s to 596 to 628 s.
Its peak load was 5.2 and peak memory 2.6 GB. The in-image gain is smaller than
the host gain because the parallel phase is CPU-bound inside the image build
(134 to 245 s depending on the runner), while the serial lane takes about 280 s
in both places.

**Flakes.** Twelve consecutive green CI runs on the change, each running the
suite on the host and inside the image (24 executions), had no unexpected
failure. Neither did two further runs whose deliberate breaks were elsewhere.
Before the change, the 60 most recent runs had zero test flakes.

**Gate proof.** Runs on the throwaway branch, old pipeline against new:

| Break | Old pipeline (run) | New pipeline (run) |
| --- | --- | --- |
| A failing test in a parallel-lane file (`lib/text-format.test.ts`) | 36206847057: tests job red at "Unit tests", docker job red at "Build exact deployable Docker image", both with `AssertionError [ERR_ASSERTION]: GATE PROOF parallel-lane assertion must fail test:unit` | 36206878060: the same two jobs and steps, the same message, plus "Parallel lib lane (282 files) failed with exit code 1" and "stopped before the serial lane" |
| A failing test in a serial-lane file (`lib/url-safety.test.ts`) | 36206847057 (same run): the same two steps, `GATE PROOF serial-lane assertion must fail test:unit` | 36206895584: the same two jobs and steps, the same message, plus "Serial lib lane (61 files) failed with exit code 1" |

In every one of these runs the required `Typecheck, Unit Tests, Build` join
also failed ("Tests: failure").

### 2. Only the dependency layers are exported to the Docker build cache

The image build exported every layer with `mode=max`, including the source,
check and runner layers. Every one of those follows `COPY . .` and can never be
reused by another commit. The dependency layers now form a `deps` stage built
from the same instructions. A new step refreshes the cache from that target
alone before the exact-SHA build, which still reads the cache but no longer
writes to it. The host browser for the smoke step now installs in the
background while the image builds. A step before the smoke waits for that exact
command and exits with its status. Builder teardown is left to the discarded
runner.

**Measured.** "Before" is the branch baseline (n=3) and the lanes-only runs
(n=6); "after" is lanes plus this change (n=3). Medians, range in parentheses.

| | Baseline, n=3 | Lanes only, n=6 | Lanes + cache change, n=3 |
| --- | ---: | ---: | ---: |
| Per-commit cache export (BuildKit #28) | 32 s (17 to 33) | 69 s (18 to 106) | none |
| New dependency-cache refresh step | none | none | 2 s (2 to 4) |
| Blocking host Chromium install | 22 s (20 to 25) | 22 s (19 to 41) | 0 s on the critical path |
| Builder teardown after the job | 13 s (7 to 14) | 9 s (8 to 13) | 0 s |
| Docker job minus its `npm run check` | 371 s (278 to 373) | 384 s (282 to 438) | 252 s (237 to 323) |
| End to end (branch runs) | 1150 s (1119 to 1171) | 1007 s (859 to 1131) | 908 s (885 to 940) |

The per-commit export grew whenever several runs exported at once (four
concurrent lanes runs took 65 to 106 s each), and on `main` it had reached
113 s in one of the ten baseline runs.

**Evidence identity.** The container package evidence was identical in every
run examined, before and after, on main and on the branch: 512 OS packages,
package set `sha256:09443a8c141cbc3ec4447edae1149be0256e0d87449b3cccdef40f4a897aa3fc`.
The image layers after `COPY . .` differ per commit by construction, and the
static export is not byte-reproducible across builds of one SHA (random build
ID), so neither can be compared across runs. This change touches neither.

**Gate proof.** With the host browser download pointed at an unresolvable host,
the old pipeline's docker job failed at "Install Chromium" (run 36206864305).
The new one failed at "Finish installing host Chromium" (run 36206913639), before
the smoke step. Both reported `Error: Failed to download Chrome for Testing
153.0.8010.12 (playwright chromium v1243)` and `Download failure, code=1`. The
contract tests fail if the exact build regains a `cache-to`, if the refresh
loses its target, if the wait step stops exiting with the install's status, or
if anything source-bound enters the `deps` stage. Each was checked by mutation.

### 3. The static smoke prints the bytes it measures

The homepage runs close to its initial-JavaScript budget, and CI is the one
place it is measured with the real public configuration. The PASS lines now
state the numbers. CI on the change printed a homepage of 62,255 of 163,840 HTML
bytes and 184,969 of 194,560 initial-JavaScript gzip bytes (9,591 bytes of
headroom), and a saved report of 80,021 and 154,001 bytes. The comparison and the
thresholds are unchanged. The static smoke step took a median 66 s before and
after.

**Gate proof.** With about 18 KB of incompressible text added to the homepage
bundle, both pipelines failed the static smoke with the same message:
`homepage initial JavaScript is 205061 gzip bytes; budget is 194560 bytes`
(old, run 36206864305) and `... 205062 ...` (new, run 36206913639).

### On `main`

Each change landed as its own fresh commit on `main` (not the measured branch
commits), after local validation on a clean tree: `npm run check`, `npm run
build:pages`, and `npm run test:smoke:static`. Each was then followed through
CI, promotion, both deploys, and production health before the next was pushed,
so every one has its own green record:

| Commit | CI | Promote | Pages deploy | Container deploy | Production health |
| --- | --- | --- | --- | --- | --- |
| `3178b30` lanes | 36208576572, 1206 s | 36209694458 | 36209692066 | 36209692107 | 36209763704, 36210751020 |
| `4a63ac9` cache | 36210992876, 1053 s | 36211935845 | 36211932849 | 36211932870 | 36211994770, 36212290928 |
| `6d24c8b` budget output | 36212402337, 1019 s | 36213284565 | 36213280177 | 36213280132 | 36213329593, 36213672343 |

In each pair of health runs, the first (requested by the Pages deploy) waits
for the container revision and skips the deep checks, and the second
(requested by the container deploy) runs all of them: the Pages report contract,
the ingress probe, the production scan with R2 readback and the report-page
synthetic, and the isolated R2 write, read and delete canary.

Local validation, 4 vCPU, alone on the machine:

| Commit | `npm run check` | peak load | `build:pages` | `test:smoke:static` |
| --- | ---: | ---: | ---: | ---: |
| `3178b30` | 596 s | 5.0 | 406 s | 73 s |
| `4a63ac9` | 596 s | 4.9 | 407 s | 74 s |
| `6d24c8b` | 597 s | 5.0 | 407 s | 74 s |

Before the change, the same machine took 1160 s for `npm run check`, at a mean
load of 1.3.


## Rejected, and why

Each of these was measured or checked against the code and decided. None is
worth reopening without new evidence.

- **Skipping the in-image `npm run check` and gating the image on the tests
  job.** Already measured and rejected on 2026-09-24: the image would queue
  behind the tests job, and the only unit run on the production runtime would
  be lost. The flake history also shows the in-image run catching an
  environment defect the host run missed (a test that assumed `.git`, run
  34010114222).
- **A global `--test-concurrency=N`, or `--test-isolation=none`, for the lib
  suite.** It would expose the 61 timing, browser, Git and Miniflare files to
  exactly the load that produced the recorded false failures (`a1a6a0a`, and
  `docs/comprehensive-review-2026-09-22.md` lines 570 to 572). Isolation
  `none` would also leak process-level stubs, env changes and memos across 20
  or more files.
- **Incremental `tsc` for the test build, or dropping `rm -rf
  .unit-test-dist`.** The removal is part of the gate (stale compiled tests
  from deleted sources would otherwise run), and CI never has a warm build
  directory anyway.
- **`tsx` or Node type stripping instead of `tsc`.** It breaks the tests that
  serialize functions into Chromium, and it would drop the only type check of
  the 348 test files, which `tsconfig.json` excludes from `npm run typecheck`.
- **A parallel `next build` stage inside the Dockerfile.** Estimated, not run in
  CI. After the lanes, the image has no idle CPU outside the serial lane, which
  must stay alone. Overlapping `next build` (about 90 s on about 2.5 cores) with
  the CPU-bound parallel phase nets about 35 s at best, and it needs a stage
  restructure that the Dockerfile contract tests pin.
- **Next's compiler cache for `build:pages`.** Measured locally: 453 s cold and
  446 s warm. The export is corpus-bound, not compile-bound.
- **Persisting Next's compiler caches through `actions/cache`.** At most about
  25 s per build, all off the critical path, at the cost of about 450 MB per key
  in the same 10 GB repository cache the Docker layers depend on.
- **Caching the Playwright browser download.** Of the 22 s install, the
  apt dependencies take about 10 s and the browser download about 8 s. A cache
  would add a new pinned action and cache trust for a few seconds off the
  critical path; the docker job now hides the whole install instead.
- **Different npm cache keys, or caching `node_modules`.** `setup-node` already
  restores npm's tarball store keyed on `package-lock.json` (about 1.6 s), and
  `npm ci` takes about 10 s. Caching `node_modules` would skip the
  lockfile-verified install for a few seconds.
- **A BuildKit cache mount for `.next/cache`.** Cache mounts do not travel with
  the `type=gha` exporter to a fresh runner, so CI gains nothing.
- **`cache-to` with `mode=min`.** It exports only the final stage's layers,
  which are all per-commit, and drops the one reusable dependency layer.
- **Merging the two container Trivy passes, or publishing before them.** The
  passes differ in exit code, severity and report shape, and both feed attested
  evidence. Publishing earlier would put unscanned bytes in the production
  registry.
- **Merging the attest and promote jobs.** It saves 3 to 5 s and merges the
  OIDC attestation and promotion App permission boundaries.
- **Cancelling superseded main runs.** It loses exact-SHA evidence and
  promotion ordering (see `AGENTS.md`).
- **Deleting or thinning scheduled work.** Every uploaded artifact has a
  reader or is deliberate audit evidence costing about 1 s. GitHub already
  delivers only 350 of 2,880 requested production-health slots, and the weekly
  gallery legs feed the measurement-freeze activation. The 2026-09-22 claim of
  unused re-adjudication artifacts stays refuted
  (`scripts/capture-measurement-freeze-activation.mjs` reads them).
- **Removing the Pages job's first `Build`.** It is the only non-export build
  of the Pages public configuration.
- **Skipping Next's in-build TypeScript pass (about 10 s per build).**
  Equivalence with `npm run typecheck` is unproven, and the Pages worktree
  compiles an edited program.
- **Caching the Trivy or RustSec databases.** Both freshness rules are gates.
- **A per-process memo of admitted reports inside the corpus-overview
  group.** It would cache admission outcomes, which
  `docs/validation-performance.md` says the readers never do. That is a policy
  question, not a speedup.
- **Moving the serial-lane files into a subdirectory.** `lib/detector-validation.ts`
  publishes three of their paths on the catalog page.


## Needs an owner decision

These need a decision that belongs to the owner. Each has a recommendation.

1. **Run the host unit suite on the container's Node and npm, then stop
   repeating it in the image in CI.** The host runs Node 24.14.1 and npm
   11.11.0; the digest-pinned Playwright base runs 24.20.0 and 11.19.0, and
   `lib/toolchain-provenance.test.ts` asserts the two are intentionally
   distinct. The in-image `npm run check` (now about 670 s, of which about 520 s
   is tests) is the largest item on the critical path.
   *Recommendation:* adopt a toolchain epoch that moves the host to 24.20.0 and
   11.19.0, then add a build argument that defaults to running the full check
   and that only CI turns off, so Workers, staging and self-hosted builds keep
   it. The docker job would drop to roughly 550 s, and the critical path would
   become the Pages job (about 600 s) or the tests job (about 560 s): end to end
   near 11 minutes. What is lost: the in-image run's container filesystem (no
   `.git`, root user) and the base image's own Chromium. Keep those by running
   only the serial lane in the image, or accept them as covered by the Docker
   smoke. Changing the host runtime is on the stop list, so this was not done.
   The two alternatives this audit was asked to weigh were also checked. A
   build-only image bound by digest to the tested SHA, with the suite run inside
   the built image in a parallel job, needs publication to move behind that job
   and the image (about 1.1 GB) to travel between jobs as an artifact;
   `docs/deploy-cloudflare-containers.md` says no image tarball is stored that
   way, and it touches the production publication path. Running the suite
   inside the image in the background of the docker job would put the
   timing-sensitive serial lane beside the smoke and Trivy work on the same 4
   vCPUs.
2. **Stop re-uploading unchanged base layers on every publish.** "Publish the
   tested production image" takes a median 91 s (81 to 129 s) on the critical
   path, and in every logged run 16 or 17 of 18 layers upload as "Pushed",
   including all seven base layers (about 956 MB) that were identical to the
   previous commit. The per-commit layers finish in about 40 s. The cause is
   unconfirmed (the daemon has no distribution metadata for layers loaded from
   a tarball, or the registry does not report existing blobs).
   *Recommendation:* capture `docker push` debug output in one run to see the
   blob existence checks, then decide. Estimated saving about 50 s. It touches
   production publication, so it was not changed.
3. **Supply-chain job: install a prebuilt, checksum-pinned `cargo-audit`
   instead of compiling it (160 s of every run).** Off the critical path by 919
   to 1206 s, and GitHub bills this public repository nothing, so the saving is
   about 380 runner-minutes a month only.
   *Recommendation:* leave it. If runner time ever matters, use the same
   pinned-download pattern as the GitHub CLI manifest rather than a cache.
4. **CI dispatched onto automation proposals that are later closed.** Fourteen
   such runs in 30 days used about 730 to 810 runner-minutes; the Brave refresh
   dispatches CI even when its own adoption check has already decided the
   result is red.
   *Recommendation:* skip the Brave dispatch when `adoption_required` is true;
   keep the others, which give maintainers a pre-approval signal.
5. **The report social card is rendered twice.** All 982 `twitter-image` files
   are byte-identical to `opengraph-image` (94.6 MiB, 16.9 percent of the static
   export).
   *Recommendation:* keep both URLs but render once and copy the bytes in
   `build:pages`, which keeps the published surface and the smoke checks.
   Off the critical path; do it for export size, not CI time.


## What is left

Ranked by likely effect on time to a verified deploy. Items marked
UNCONFIRMED are estimates; the place each was checked is named.

1. **The in-image test run** (decision 1 above): about 520 s on the critical
   path.
2. **Registry re-upload of base layers** (decision 2): about 50 s, UNCONFIRMED
   cause (docker job logs, push sections).
3. **The export of the built image to the local daemon** (#26 and #27, a
   median 54 s including a 35 s import). A builder that writes straight into
   the daemon's image store would avoid it, but it changes how the image ID and
   layers reach the release evidence. UNCONFIRMED whether the runner's daemon
   uses the containerd store; needs one experiment run.
4. **Once the docker job shrinks, the Pages job (about 600 s) is next.** Its
   `build:pages` runs the same full corpus audit three times (manifest, corpus
   statistics and route discovery, about 29 s each) and a single-threaded
   remediation check (about 115 s). One audited pass would save about 58 s, and
   spreading the remediation check across workers about 55 to 75 s
   (UNCONFIRMED; `scripts/build-github-pages.mjs`, job 108254989803 log).
5. **The parallel lane is CPU-bound.** About a dozen lib test processes each
   re-read and re-validate the whole 156 MB corpus. A shared, content-keyed
   validation result would shorten the parallel phase, but it is the same
   policy question as the rejected corpus-overview memo.
6. **The homepage's initial JavaScript has 9,592 gzip bytes of headroom** (CI
   now prints it; run 36212402337). The scheduled-rescan panel is dead weight for nearly every
   visitor while encrypted watches are off, and lazy-loading it would free about
   5.3 KB; moving `REPORT_ID_PATTERN` and three text helpers into leaf modules
   about 3.2 KB; loading the report resource pre-check with the deep reader up
   to 4.2 KB (all UNCONFIRMED estimates from built chunks, `out/_next`).
7. **Test debt found on the way.** `lib/release-tag-governance-receipt.test.ts`,
   `lib/v1-release-contract.test.ts` and
   `lib/durable-soak-exercise-hosted.test.ts` commit in fixture repos through
   plain Git instead of `lib/git-fixture.ts`, so Git's detached maintenance can
   race their teardown (the failure `lib/git-fixture.ts` documents). They are
   in the serial lane now; switching them to `runFixtureGit` and
   `removeFixtureTree` would fix the cause.
8. **The lanes lint is a heuristic.** A deadline inside a helper module, or
   `{ timeout }` shorthand, would slip past it. The rule stands: a test that
   ever fails only in the parallel lane moves to the serial lane.
9. **Off the critical path:** background browser installs in the tests, Pages
   and smoke jobs (about 22 s each), `--only-shell` Chromium downloads (about
   4.5 s per job), and the eight identical app builds in each scheduled
   scanner-fidelity run (about 300 runner-minutes a month).
10. **`package.json` is in the staging-teardown source closure**
   (`lib/measurement-candidate-binding.ts`). No staging-teardown evidence is
   committed today, so nothing was invalidated, but any future capture must be
   taken at or after the commit it binds.


## Reproducing this

Measurements: the lanes, the Docker cache change and the budget output were
each measured on the branch `claude/sleepy-curie-9ezvmn` with
`workflow_dispatch` runs of `ci.yml`, compared with the baseline runs listed
above. Step and job durations come from the Actions jobs API (`started_at`,
`completed_at`); in-image phases come from the BuildKit `#15` lines in the
docker job log. Local numbers came from a 4-vCPU Linux container with Node
24.14.1 and npm 11.11.0, the pinned Chromium copied from the digest-pinned
Playwright image, and nothing else running.

To repeat the local profile, run each `npm run check` stage in order and time
it, with `node --test --test-reporter=junit` added to the lib stage for
per-test times. Never run two checks in one checkout at once.

