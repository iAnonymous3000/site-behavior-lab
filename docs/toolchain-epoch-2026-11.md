# Toolchain epoch 2026-11

The epoch record for the 2026-11 toolchain epoch (Playwright 1.63.0 to 1.64.1, bundled Chromium 153.0.8010.12 to 156.0.8078.4), kept as [the toolchain epoch playbook](./toolchain-epoch.md) asks: the version matrix, the corpus-neutrality result, the exact-build staging A/B and the staging teardown readback. It is the third epoch whose staging A/B ran and the second whose A/B failed under its gate: two matched rounds on 2026-11-08, each FAIL on medians of the guardian case, in opposite directions. It is the first epoch to fail on a compared median; [the 2026-10 epoch](./toolchain-epoch-2026-10.md) failed on capture-loss signatures before any median was compared. On 2026-11-10 the owner decided to release the epoch to production under a recorded exception to that gate, dated below. The gate that judged these captures is the one at the staged candidate, unchanged since 2026-10-02, with the same tolerances and panel. Its comparison rule was changed on 2026-11-10, after both captures and after these two FAILs, in a change this release also carries; the new rule does not judge these results again, and what it prints for these receipts today (exit 2, inconclusive, which is not a pass) is quoted beside each recorded FAIL. This record was committed before production was advanced, so it holds no publication evidence yet.

- Production, and the last released commit: `069e84873226fb52e843d23a1ac294ec135bb82c`. It was also the tip of `main` until 2026-11-10, and the `production` branch still named it when this record was written (read at 08:13 UTC on 2026-11-10).
- Baseline: `59402b6d47c05b767a81eb38ab6c30b0d88c696a`, 20 commits on `069e8487`. It was unpublished when the A/B ran, reached `main` on 2026-11-10, and has never been production. The A/B therefore compared the candidate with this commit, not with the build production runs.
- Staged candidate: `8c6a8fc5fdb056d84a2693fb38e08689cfbc179d` (11 commits on the baseline: `6f6aba61`, `2f78393d`, `ef189f9f`, `931b46e0`, `70d948a9`, `443d5bd9`, `10a17293`, `b4423b6d`, `f1047730`, `1aaab4ab`, `8c6a8fc5`). This is the build both A/B rounds scanned.
- Released commit: not named here, because this record precedes the promotion. `main` stood at `b8292658d739727d04ee2103324026c18d80c573`, 88 commits past the staged candidate, when this record was written, and the commit that adds this record sits on `fc4833d9`, 90 commits past it. No commit after `8c6a8fc5` was staged or scanned: the receipts attest `59402b6d` and `8c6a8fc5` and nothing else.

## Main after the staged candidate

Neither staged commit was on `main` while staging ran. The list of main CI runs holds no push between the run for `069e8487` (2026-10-30) and the run for `6b2360cc` (2026-11-10, 00:28 UTC), and the integrator's notes record both refs read at `069e8487` during round 1, at the pause readback and at 05:23 UTC on 2026-11-08, after the teardown. On 2026-11-08 at 04:02 UTC the repository variable `SITE_BEHAVIOR_LAB_PROMOTION_PAUSED` was set to 1; it still read 1, last changed at that time, when this record was written. Both promotion paths run only while that variable is not `1`: the `ci.yml` job "Advance production to the tested SHA", which needs the supply-chain, app, docker, smoke and attest jobs, and the `promote-production.yml` fallback. The pause holds automatic promotion only. It is not a deployment lock.

`main` then moved five times on 2026-11-10 (UTC), each move a fast-forward, with the pause at 1 throughout:

| Main CI run (started, UTC) | `main` moved | Commits | CI result | Promotion |
| --- | --- | --- | --- | --- |
| [42728539414](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42728539414) (00:28) | `069e8487` to `6b2360cc` | 32 | failure: the Docker Runtime and Public R2 Smoke job, at the step "Enforce container security and package-evidence gates"; every other test job succeeded; attestation skipped | job skipped, after a failed job; [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42733576653) skipped |
| [42739288248](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42739288248) (01:56) | `6b2360cc` to `887a6f75` | 1 | success | job skipped; [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42744085880) skipped |
| [42756424117](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42756424117) (04:31) | `887a6f75` to `58c8a856` | 9 | attempt 1 failure: the Docker job, at the step "Build exact deployable Docker image"; attempt 2 success | job skipped in both attempts; Promote Production skipped after each ([attempt 1](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42759714455), [attempt 2](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42763373758)) |
| [42763517602](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42763517602) (05:39) | `58c8a856` to `6734884b` | 75 | success | job skipped; [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42768156568) skipped |
| [42774381505](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42774381505) (07:18) | `6734884b` to `b8292658d` | 2 | success | job skipped; [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/42779008749) skipped |

In each of the four runs that concluded success, the Supply-chain Security, Typecheck and Unit Tests, Build and Static Export, Chromium Smoke Test and Docker Runtime and Public R2 Smoke jobs and the attestation job all succeeded and the promotion job was skipped, so those skips are hosted evidence that the pause holds automatic promotion. In the first run, and in the first attempt of the third, the `ci.yml` promotion job was skipped after a failed job, which shows nothing about the pause. No Deploy Tested Container or Deploy Tested Pages run was created after the two that deployed `069e8487` on 2026-10-30 (06:47 UTC), as the workflow run lists read when this record was written.

What those 88 commits are, and what the staging A/B says about them (nothing):

- `6b2360cc` ("Say what each check, bound and log holds, and where it stops"), one commit on the staged candidate: 22 files, 173 insertions and 60 deletions, in documents, the changelog and files under `lib/` and `investigation/`. It touches no file under `.github` and no Dockerfile, package, lockfile or configuration file. Per the integrator's notes, a token diff with comments removed found no change in production code and, in tests, eleven changed string literals, none of which changes what a test asserts. That it leaves staged behavior unchanged is an inference from that diff, not a measurement.
- `887a6f75` ("Make the base stage's two checks one step, so a native image lists no layer twice") answers the first hosted run. That run's container package inventory refused the image with the annotation "container artifact.rootfsLayers must not contain duplicates", so nothing was published, attested or promoted from it. The commit's message gives the cause: the Playwright base stage held two steps that only check (the Node and npm version check, and the browser check `70d948a9` added), a step that changes no file adds the same empty layer each time, and the runtime image is built from that stage. The candidate's images, the staged one among them, were built for linux/amd64 under emulation, where the same commands leave a Node compile cache behind, so one of the two layers was not empty and no local build showed the defect. The baseline's Dockerfile has one such step, so its images could not show it. The commit changes the Dockerfile (the two checks become one `RUN` step, with the same expected Node, npm and browser versions), `lib/toolchain-provenance.test.ts` and the changelog, and nothing else. Its hosted run built the image natively and passed the inventory.
- `887a6f75..58c8a856` (9 commits) changes gates and their documents, not the scanner. Five of them (`30483bdd`, `989f636c`, `0593609b`, `1e6c2e14`, `a13d08be`) add the comparison rule `median-with-within-arm-spread-v2` to the canary's `compare` command, with its three outcomes and exit statuses 0, 1 and 2, the playbook's wording for them, and the dated addenda in the 2026-09 and 2026-10 records. `30483bdd` was committed on 2026-11-10 at 03:16 UTC, two days after both captures. Until then the canary's code was byte for byte what production's commit `069e8487` holds, last changed on 2026-10-02 (`f662f462`). The other four commits defer two 1.0 release gates by name, say so in the release documents, and record both changes in the changelog.
- `58c8a856..6734884b` (75 commits) is not part of this epoch and moves no toolchain input. It changes scanner and scan-server behavior (for example `602e033b`, "Make no report from a visit whose page crashed", and `214104b9`, "Refuse every IPv6 address outside global unicast as a scan destination"), how saved reports are read (`d3edf622`, below under corpus neutrality), the pages and many documents.
- `6734884b..b8292658d` (2 commits) removes the aggregate-metrics pipeline (`fbb01c41`, which changes `cloudflare/container-worker.ts` and `wrangler.container.jsonc` among 14 files) and records it in the changelog. Two more commits, `123a4484` and `fc4833d9`, sit between `b8292658d` and this record.

Everything that is a toolchain input reads the same at the staged candidate and at `fc4833d9`, by `git diff`: the Playwright pin and `package-lock.json` (sha256 `a12b37a7…`), the base image digest with its expected Node, npm and browser versions, the vendored WASM and `Cargo.lock`, the list snapshot, the seccomp profile, the container package ledger, the canary panel, the r2 producer contract and the normalization table. That is a statement about inputs read from git. It is not a staging result, and the image main CI builds for the commit to be released is neither staged image: it is a native build of a later commit with a different base-stage layering.

## Version matrix

| Input | Baseline `59402b6d` | Candidate `8c6a8fc5` |
| --- | --- | --- |
| Playwright (npm `playwright` and `playwright-core`) | 1.63.0 | 1.64.1 |
| Bundled Chromium (and headless shell) | 153.0.8010.12, revision 1243 | 156.0.8078.4, revision 1248 |
| `NODE_PLAYWRIGHT_VERSION` (`lib/legacy-methodology.ts`) | 1.63.0 | 1.64.1 |
| Container base `mcr.microsoft.com/playwright` | `v1.63.0-noble@sha256:eff16c30…` | `v1.64.1-noble@sha256:47b510dd…`, the 2026-10-23 build of that tag |
| Container Node / npm (asserted by the Dockerfile) | 24.20.0 / 11.19.0 | 24.22.1 / 11.19.1 |
| Browser asserted by the Dockerfile's base stage | none | Google Chrome for Testing 156.0.8078.4 in `chromium_headless_shell-1248` (`70d948a9`) |
| Seccomp profile | `cc3e61ca…` | unchanged |
| apt and libapt-pkg6.0t64 in the runner image | 2.8.3 | 2.8.4ubuntu0.1 (`10a17293`, past CVE-2026-109518) |
| Container package ledger | 512 rows, package set `09443a8c…` | 513 rows, package set `830642c8…` (`b4423b6d`) |
| adblock-rust (Cargo.lock) | 0.13.3 | unchanged |
| wasm-bindgen (Cargo.lock) | 0.2.129 | unchanged |
| `tools/adblock-wasm/Cargo.lock` sha256 | `106c9724…` | unchanged |
| Vendored `sbl_adblock_wasm_bg.wasm` | `7dda4b30…` | unchanged |
| tldts / tldts-core | 7.4.16 | unchanged |
| Brave Shields lists | 2026-10-19 snapshot (31 lists, manifest `25bef053…`) | unchanged |
| glob / minimatch (development only, by `package.json` override) | 13.0.6 / 10.2.5 | 14.0.3 / 11.0.3 (`1aaab4ab`) |
| Wrangler (lockfile) | 4.151.1 | unchanged |
| `package-lock.json` sha256 | `d49639b5…` (the same at `069e8487`) | `a12b37a7…` (the same at every later commit through `fc4833d9`) |

Full digests, each recomputed for this record from the git objects:

- `package-lock.json`: `d49639b5e05e2cd915bcd3031da725205a7ab69fe8f410a6c91d9a508733e6cc` at `069e8487` and `59402b6d`, `a12b37a7c9a83e92052e08ce970903493d729f5ba769b5ffc3f5f03c079ae4e3` at `8c6a8fc5`, `6b2360cc`, `887a6f75` and `fc4833d9`.
- Container base index digest: `eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` to `47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea`.
- Container package ledger, `inventoryPackageSetDigest`: `09443a8c141cbc3ec4447edae1149be0256e0d87449b3cccdef40f4a897aa3fc` to `830642c80370c0ec35ebfa110e445046a4936420ec785d7821aaeecb636a850e`.
- Unchanged at both: `scripts/playwright-seccomp-profile.json` `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`, `tools/adblock-wasm/Cargo.lock` `106c97247df0f699510239c5db330d513d09832a9206eaecf54ef54bc5beff35`, `lib/adblock-wasm/sbl_adblock_wasm_bg.wasm` `7dda4b30ce6d4cc9fb9722b6763cfade690f85ff5f2d8a4bdb992fdae6d1d3cc`, and the Brave list manifest `25bef053aac3c343e99c5ae44836c6ce0550669a75cd7568bc95fda8a3d6f624`.

Playwright 1.64.1 was published to the npm registry on 2026-10-14; 1.64.0 (2026-10-07) was passed over, and 1.65.0 (published 2026-11-05) is not part of this epoch. The container base is pinned to the 2026-10-23 build of `v1.64.1-noble`, not to what the tag resolves to now: the changelog entry for this epoch records that the tag moved to a later rebuild (index `2f05f8a7…`) carrying Node 26.13.0 and Chrome for Testing 156.0.8078.80, which this epoch does not adopt, and the base-stage assertion `70d948a9` added fails an image build on a base whose headless shell is not the build playwright-core names.

The package ledger's rows differ between the two commits in exactly seven packages: apt and libapt-pkg6.0t64 (2.8.3 to 2.8.4ubuntu0.1, the upgrade `10a17293` makes in the runner stage), four of the new base's own packages (nodejs 24.20.0 to 24.22.1, tzdata 2026c to 2026e, ca-certificates 20260601~24.04.1 to 20260816ubuntu0.24.04.1, base-files 13ubuntu10.4 to 13ubuntu10.5), and zstd 1.5.5+dfsg2, which only the new base ships.

Three changes sit beside the pin, as the 2026-10 epoch took its security patches; the changelog entry for this epoch describes each. `10a17293` upgrades exactly apt and libapt-pkg6.0t64 past CVE-2026-109518, which both bases ship and main CI's image scan refuses, and drops the OpenSSL pin of 2026-10 because the new base ships the fixed revision. `f1047730` folds a package-version check into that upgrade step. `1aaab4ab` moves two development-only packages past two advisories published on 2026-10-30 that main CI's whole-lockfile `npm audit` fails on; the pruned runtime image contains neither.

### Measurement identity

Of the version strings this repository records, only the methodology moves, and only in its Playwright component: `…-request-method-v1-playwright-1.63.0+subject-validity-v4+…` becomes `…-request-method-v1-playwright-1.64.1+subject-validity-v4+…` in the base Node methodology (which is also the v1 methodology token and the corpus cohort key), and the r2 methodology carries the same move under its unchanged suffix. Every report also records the browser version, which moves from 153.0.8010.12 to 156.0.8078.4, and the r2 condition, measurement-environment and execution fingerprints hash it. `2f78393d` closes the two outgoing producer rows (`node-v28-detectors-v23-active-lists-2026-10-19` and `node-v28-detectors-v23-active-no-adblock`) to their exact literals and declares `node-v29-toolchain-2026-11-active-lists-2026-10-19` and `node-v29-toolchain-2026-11-active-no-adblock`, the two producer rows that carry the new methodology. No normalization, detector, registry, obligation, catalog, list identity or engine version moves, so there is no `SUPERSEDED_R2_NORMALIZATIONS` entry for this epoch.

The A/B receipts show the move end to end. All 30 baseline runs record build `59402b6d`, Chromium 153.0.8010.12 and a methodology naming `playwright-1.63.0`; all 30 candidate runs record `8c6a8fc5`, 156.0.8078.4 and `playwright-1.64.1`. Every one of the 60 runs records the same registry (`node-detectors-v23`, digest `643765c7…`), the same normalization (`tldts@7.4.16` under the public-string-policy-v4 digest `3a2328d7…`), the same engine version (`adblock-rust-0.13.3`) and the same list manifest.

One more recorded behavior moves with the browser and is in no identity table. Chromium stops applying its built-in HSTS preload list 70 days after its build ([the limitations](./limitations.md#the-scan-browsers-hsts-preload-list)). By the estimate from each version tag's commit time, 153.0.8010.12 stopped on 2026-11-03 at about 20:20 UTC, and that is the browser production's commit pins; 156.0.8078.4 applies the list until about 2026-12-08 23:57 UTC. `http://` references to preloaded hosts therefore record differently under the two browsers. `lib/scan-browser-hsts-preload.test.ts` now expects the list applied and fails by name once the browser stops applying it. It runs in the unit suite, which main CI and the image build's in-image check both run, so by that estimate both fail from about 2026-12-08 23:57 UTC until a later toolchain epoch moves the browser. Main CI's Chromium smoke job annotates the cutoff, without failing, once fewer than 21 days remain (`ef189f9f`).

## Corpus neutrality

`npm run corpus:audit-neutrality -- snapshot` was run for this record in two separate trees, each extracted from its exact commit and given its own `npm ci`: the baseline `59402b6d` (resolving Playwright 1.63.0) and the staged candidate `8c6a8fc5` (resolving 1.64.1). Each wrote 1028 managed comparison decisions, and the two snapshots are byte-identical (sha256 `f693abe374984d52ccee7ce66f05fc8c65404b2fc46cd74e49e13ad70ea94c75`). The compare, run from the candidate tree and again from the checkout this record was committed on, prints "Corpus neutrality unchanged across 1028 managed comparison reports." and exits 0. The integrator's notes record the same digest for the snapshots taken during qualification on 2026-11-07, and for one taken at `6b2360cc`.

A checkout that contains this record is not neutral against that baseline, for a reason outside this epoch. A snapshot taken at `fc4833d9` (sha256 `63cef2c06a262ac0d901f2b8b5e28a3f2bf7f65a88b3cf9c6fb9d240efdac746`) and compared with the baseline's prints "Corpus neutrality changed: 0 report-set differences, 47 overall-mode flips, 94 family-mode flips, 237 family-reason changes." and exits 1; all 47 overall flips are from comparable to raw-only. Snapshots taken for this record on both sides of one commit place the whole change there: the snapshot at `602e033b` equals the baseline's, as does the one at `58c8a856`, and the snapshot at its child `d3edf622` ("Read a request the scanner's own guard refused as incomplete request evidence") equals the one at `fc4833d9`. That commit changes how the reading side treats a visit whose warning names a request the scanner's own guard refused, and its message says no saved report changes. It is a change to how the corpus is read, not a toolchain input. The zero-flip result above is for the baseline against the staged candidate. It says nothing about `d3edf622`, which the staging A/B did not run either.

Local qualification, per the integrator's notes and not from committed logs. On the baseline `59402b6d` and on the candidate `8c6a8fc5`, the host gate (install, list verification, the supply-chain inventory and review checks, `npm run check`, `build:pages`, the static smoke and the history gates) exited 0 at every step, with 6,979 of 6,979 and 6,986 of 6,986 tests passing. A no-cache linux/amd64 image of each commit built with its in-image `npm run check` passing (6,979 tests with 37 skipped, and 6,986 with 36 skipped). The vulnerability scan of the baseline's image found, at HIGH or CRITICAL, exactly CVE-2026-109518 in apt and libapt-pkg6.0t64 2.8.3, the finding `10a17293` clears, and the scan of the candidate's image found nothing at HIGH or CRITICAL. The follow-up `6b2360cc` passed the same host gate with 6,986 of 6,986. The notes also record a loss that they count as unobserved rather than passed: the native Linux checks of both commits and the image build of `6b2360cc` each printed fewer results than the suite holds (11, 7 and 16 fewer), every missing one a test of `scripts/staging-teardown-provider-adapters.test.mjs`, whose output tail was lost; the file passed whole, 80 of 80, in separate reruns. None of this replaced hosted CI, whose runs on `main` are in the table above.

## Staging A/B

### Provisioning, and what stopped before capture

The operator provisioned staging on 2026-11-08 between 00:03 and 00:23 UTC from a clean clone at the baseline `59402b6d`, as [the go-live runbook](./go-live-public-scanner.md) describes: the collision preflight (Worker absent with code 10007, bucket absent with 10006, no A, AAAA or CNAME record for `scan-staging.sitebehavior.org`, and no staging application in the Containers inventory), the staging-only bucket `site-behavior-lab-reports-staging` with the lifecycle rule `durable-replay-staging-cleanup` (all prefixes, expire objects after 1 day, abort incomplete multipart uploads after 1 day), the bucket-scoped R2 API token `sbl-staging-toolchain-canary-2026-11` (Object Read & Write on that bucket only), the seven staging secrets read back by name only, and the draft Worker `site-behavior-lab-scanner-staging`. Nothing touched the production Worker, bucket, secrets or hostname.

Each arm was deployed from a fresh clean clone of its exact commit with `npm run cf:container:staging:deploy`, and the deploy log of every receipted arm names Wrangler 4.151.1, the version those clones' lockfile resolves. Two attempts stopped at the health gate before any capture and wrote no receipt; the stage log of each ends with "REFUSED authenticated staging health never passed the gate at 59402b6d47c05b767a81eb38ab6c30b0d88c696a; start teardown". Inside round 1, two more invocations of the stage script were refused before any capture: the baseline's first, with "REFUSED registry digest differs from the exported build manifest" while its rollout was still pending, so that its receipt came from a resumed invocation with no new deploy, and the candidate's first, on a file in its clone that others could not read. Per the integrator's notes, round 1's two arms ran different revisions of the stage script.

- Before round 1 (00:23 to 01:24 UTC). The first baseline deploy created the staging container application (`a03ff526-2f40-4c94-8909-523d7790a146`, at 01:05 UTC) with image `sha256:251ac9a8…`. The stage first refused on its own identity check ("registry digest differs from the exported build manifest"), which per the integrator's notes compared one digest with and without its `sha256:` prefix. Resumed with that corrected, it read 503 from authenticated health on all 45 polls. Per the integrator's notes the container crash-looped on a permission error reading an application file: the staging wrapper script's restrictive umask had also governed the clone, so the image copied source files its runtime user could not read. That image is not a build of record. It was never scanned, and its registry tag (`e10aadc9`) was deleted at teardown. The wrapper was corrected before round 1, and every receipted arm records that the image's runtime user (`pwuser`) can read the application files.
- Between the rounds (02:28 to 02:43 UTC). The baseline redeploy exported the same baseline image, Wrangler printed "No changes to be made", the application stayed on the candidate image, and the health gate refused the wrong build on all 45 polls. The integrator's root-cause note attributes that to Wrangler 4.151.1 comparing the new image with an application list that lagged the per-application read after a rollout. The lag was observed (still stale at least 5 minutes after round 1's rollout, caught up by 04:04 UTC), not measured. For round 2 the wrapper required the application list and the per-application read to agree before each deploy, the deploy log to show the edit to the arm's image, and each arm's build to reproduce the image digest fixed in round 1. Both round 2 arms record all three.

### Builds and panel

| | Baseline | Candidate |
| --- | --- | --- |
| Build | `59402b6d` | `8c6a8fc5` |
| Image | `sha256:5c39f556f73b051dd8fc6cc2c0e51c561910e3b7a4605107b60ffb0077656dad` (registry tag `62ba396b`) | `sha256:acbb40787ecd3d3db95c1e5bbd0c6adc540b7f739bbb6941e779933b0d6085f8` (registry tag `0b2c787a`) |
| Built | by the round 1 staging deploy, with its own in-image `npm run check` (2,352 s; 6,968 results printed: 6,932 pass, 0 fail, 36 skipped); the round 2 deploy exported the same manifest digest and pushed nothing | per the integrator's notes, the image the candidate's local qualification built on 2026-11-07; the round 1 deploy took every build step from cache and exported this digest, and the round 2 deploy exported it again and pushed nothing |
| Node in the image | v24.20.0, equal to the Dockerfile's assertion | v24.22.1, equal to the Dockerfile's assertion |
| Browser in the image | Google Chrome for Testing 153.0.8010.12; the baseline Dockerfile asserts no browser version | Google Chrome for Testing 156.0.8078.4, equal to the Dockerfile's assertion |

Both are linux/amd64 images built under emulation. The deploys of all four receipted arms ran their image build through the Docker DNS shim (`--add-host` for the two Ubuntu mirrors, image build only); the baseline image was built by the first of them, and the candidate's came from cache each time. All four captures ran from a checkout of the candidate `8c6a8fc5` against the committed panel `monthly-toolchain-canary-v1` (`scripts/fixtures/toolchain-canary-panel.json`: wikipedia, github, python, gov-uk, guardian; 3 repetitions; panel digest `86fe39f8e4e75e9a2925c1849006909968b67bc507d2aec6cb688ce9cc22be29`, the digest the 2026-09 and 2026-10 receipts carry). The canary code, the panel, the staging configuration, `cloudflare/` and the deploy wrapper do not differ between the two commits. The Worker each arm bundled does differ, by design: per the integrator's notes it imports two `lib/` files the epoch changes, `lib/legacy-methodology.ts` (the Playwright constant) and `lib/redact-scan-report-v1.ts` (the retired 1.63.0 methodology literal).

Every one of the 60 receipted runs records egress `WNAM/sjc11/US`, run outcome complete with HTTP 200, complete requests, cookies, storage and fingerprinting families, and the same observed subject per site in both builds. The 30 baseline runs record Chromium 153.0.8010.12 and the 30 candidate runs 156.0.8078.4. Before each capture the health gate passed only once the container reported the arm's own SHA, and the authenticated health read after each capture was ok with no warnings at that SHA.

| | Round 1 baseline | Round 1 candidate | Round 2 baseline | Round 2 candidate |
| --- | --- | --- | --- | --- |
| Order | forward | reverse | forward | reverse |
| Runs | 15 | 15 | 15 | 15 |
| First to last scan start (UTC) | 02:12:17 to 02:14:51 | 02:23:25 to 02:26:10 | 04:23:00 to 04:25:30 | 04:30:25 to 04:33:02 |
| Receipt created (UTC) | 02:15:02 | 02:26:17 | 04:25:47 | 04:33:08 |
| Receipt | `round-1-baseline-receipt.json` | `round-1-candidate-receipt.json` | `round-2-baseline-receipt.json` | `round-2-candidate-receipt.json` |
| Receipt sha256 | `f91cc7445d1ca91a02f20c5c64342a6ddd19438400e6773ed6ea74e5ca2d9eb4` | `d5fdb1fa6fe2d92281deb1fe0a78d17f529be3bd35ac8688434ba430aa5680cf` | `5179e817ab6dd03599e22150702118a3dc4a3dfc3078ac0cba816e28dbafa6c2` | `99752e70761c32466e6e1ef78ba072274c5cf5af5518959a49e3ca37b8b7601d` |

The four receipts are committed byte for byte beside this record in [`toolchain-epoch-2026-11/`](./toolchain-epoch-2026-11/), and each sha256 above equals the digest the stage log recorded when the comparison ran. Each carries the exact staging report IDs of its 15 runs. Their key set holds nothing the committed 2026-10 receipts lack.

### Round 1: FAIL

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2026-11/round-1-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2026-11/round-1-candidate-receipt.json
```

Result recorded on 2026-11-08 at 02:26 UTC, by the gate as it stood at the staged candidate (the comparison log, exit 1):

```text
NOTED github: detector-output/truncated/keystroke-probe-capture capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED python: detector-output/truncated/policy-link-candidates capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED guardian: detector-output/dropped/policy-visit capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
FAIL guardian.knownTrackerRequests: median 16 -> 26; delta 10 > 4.8
FAIL guardian.shieldsBlockedRequests: median 48 -> 68; delta 20 > 14.399999999999999
FAIL Toolchain canary metric tolerances failed.
```

That result stands as recorded. It reproduces: run for this record from a tree of the staged candidate `8c6a8fc5` on the two committed files, the command prints those lines and exits 1.

From a checkout that has the comparison rule `median-with-within-arm-spread-v2` (2026-11-10), the same command exits 2. Run from the checkout this record was committed on, it prints (the `INCONCLUSIVE` lines on standard error, the rest on standard output, in the order a terminal shows them):

```text
RULE median-with-within-arm-spread-v2
INCONCLUSIVE guardian.knownTrackerRequests: baseline runs 16, 17, 16 (spread 1), candidate runs 16, 29, 26 (spread 13), tolerance 4.8; the page varied within one build by more than the tolerance, so medians 16 -> 26 say nothing about the toolchain for this metric
INCONCLUSIVE guardian.shieldsBlockedRequests: baseline runs 48, 49, 48 (spread 1), candidate runs 48, 68, 71 (spread 23), tolerance 14.399999999999999; the page varied within one build by more than the tolerance, so medians 48 -> 68 say nothing about the toolchain for this metric
NOTED github: detector-output/truncated/keystroke-probe-capture capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED python: detector-output/truncated/policy-link-candidates capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED guardian: detector-output/dropped/policy-visit capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
INCONCLUSIVE 59402b6d47c05b767a81eb38ab6c30b0d88c696a -> 8c6a8fc5fdb056d84a2693fb38e08689cfbc179d: not a pass. No compared fixed-panel median failed, but for 2 of 45 the page varied within one build by more than the tolerance, so the comparison says nothing about the toolchain for guardian.knownTrackerRequests, guardian.shieldsBlockedRequests. The release decision has to record each inconclusive metric by name with its values above.
```

Exit 2 is not a pass and not a failure, and it does not change the result above: that rule was added after both captures, and the playbook says results recorded before it stand as recorded and are not judged again.

The comparison covers 45 medians, with none left out: no run records a fingerprinting loss, so `guardian.fingerprintEvents` was compared, where 2026-09 and 2026-10 left it out. Two medians failed, both guardian's. The baseline's three guardian runs were all in the low group described below, the candidate's first run was too, and its other two were in the high group. Three more guardian medians moved and stayed within tolerance:

| Metric (guardian) | Baseline runs | Candidate runs | Medians | Delta | Allowed | Recorded |
| --- | --- | --- | --- | --- | --- | --- |
| totalRequests | 161, 166, 165 | 161, 182, 186 | 165 to 182 | 17 | 33 | within |
| thirdPartyRequests | 131, 136, 135 | 131, 151, 155 | 135 to 151 | 16 | 33.75 | within |
| knownTrackerRequests | 16, 17, 16 | 16, 29, 26 | 16 to 26 | 10 | 4.8 | FAIL |
| thirdPartyDomains | 25, 25, 25 | 25, 28, 29 | 25 to 28 | 3 | 6.25 | within |
| shieldsBlockedRequests | 48, 49, 48 | 48, 68, 71 | 48 to 68 | 20 | 14.4 | FAIL |

The gate printed only its failing lines. The other rows, and the allowed values, are computed for this record from the committed receipts with the tolerance the playbook states (the larger of the metric's absolute term and its relative term times the baseline median). The other 40 medians are equal between the builds: on wikipedia, python and gov-uk all three runs of both builds record the same nine counts, and github's runs differ only in totalRequests (120 to 122) and shieldsBlockedRequests (3 to 5), with equal medians. The three `NOTED` signatures are in the detector-output family, which no canary metric is counted from, and each is on every run of both builds.

### Round 2: FAIL

The playbook asks for one complete matched re-run after confirming the same staging region and stable subjects. The owner directed one additional matched round, with its comparison criteria written before any capture and both rounds retained. The criteria file fixed the unchanged gate (the committed panel, tolerances and capture-loss rule, with nothing relaxed, edited or re-weighted), the same order as round 1, both rounds reported separately and in full and not pooled, no further rounds whatever this one showed, a case outside tolerance reported as an unresolved difference with its per-run values, and the HSTS conclusion limited to what each measure shows. The file was last modified at 04:18:32 UTC, before round 2's preparation began at 04:19:45 UTC and its first capture at 04:22:55 UTC. Its sha256 (`399d465ead06ca79b98472c98d2ccc9e6aee7466d0ab1f3dbee2292ea8d814c8`) was recorded at 04:30:48 UTC, during the candidate capture, so "written before the round" rests on the modification time and not on the hash. The file is in the epoch working directory, not committed.

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2026-11/round-2-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2026-11/round-2-candidate-receipt.json
```

Result recorded on 2026-11-08 at 04:33 UTC (the comparison log, exit 1):

```text
NOTED github: detector-output/truncated/keystroke-probe-capture capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED guardian: detector-output/dropped/policy-visit capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
FAIL guardian.shieldsBlockedRequests: median 76 -> 50; delta 26 > 22.8
FAIL Toolchain canary metric tolerances failed.
```

That result stands as recorded, and it reproduces the same way: from a tree of `8c6a8fc5` on the two committed files the command prints those lines and exits 1. From the checkout this record was committed on, it exits 2 and prints:

```text
RULE median-with-within-arm-spread-v2
INCONCLUSIVE guardian.knownTrackerRequests: baseline runs 27, 16, 28 (spread 12), candidate runs 16, 19, 26 (spread 10), tolerance 8.1; the page varied within one build by more than the tolerance, so medians 27 -> 19 say nothing about the toolchain for this metric
INCONCLUSIVE guardian.shieldsBlockedRequests: baseline runs 76, 48, 79 (spread 31), candidate runs 48, 50, 71 (spread 23), tolerance 22.8; the page varied within one build by more than the tolerance, so medians 76 -> 50 say nothing about the toolchain for this metric
NOTED github: detector-output/truncated/keystroke-probe-capture capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED guardian: detector-output/dropped/policy-visit capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
INCONCLUSIVE 59402b6d47c05b767a81eb38ab6c30b0d88c696a -> 8c6a8fc5fdb056d84a2693fb38e08689cfbc179d: not a pass. No compared fixed-panel median failed, but for 2 of 45 the page varied within one build by more than the tolerance, so the comparison says nothing about the toolchain for guardian.knownTrackerRequests, guardian.shieldsBlockedRequests. The release decision has to record each inconclusive metric by name with its values above.
```

As in round 1, that output does not change the recorded FAIL.

The direction reversed. In round 1 the candidate's guardian medians were the higher ones; in round 2 they were the lower ones, on the same two image digests, the same region and the same observed subjects. One median failed, and two more passed by less than one request:

| Metric (guardian) | Baseline runs | Candidate runs | Medians | Delta | Allowed | Recorded |
| --- | --- | --- | --- | --- | --- | --- |
| totalRequests | 196, 165, 200 | 161, 164, 186 | 196 to 164 | 32 | 39.2 | within |
| thirdPartyRequests | 165, 135, 168 | 131, 134, 155 | 165 to 134 | 31 | 41.25 | within |
| knownTrackerRequests | 27, 16, 28 | 16, 19, 26 | 27 to 19 | 8 | 8.1 | within |
| thirdPartyDomains | 33, 25, 33 | 25, 25, 29 | 33 to 25 | 8 | 8.25 | within |
| fingerprintEvents | 1, 0, 1 | 0, 0, 0 | 1 to 0 | 1 | 3 | within |
| shieldsBlockedRequests | 76, 48, 79 | 48, 50, 71 | 76 to 50 | 26 | 22.8 | FAIL |

The other 39 medians are equal between the builds: wikipedia, python and gov-uk again record the same nine counts on every run of both builds, and github differs only in totalRequests (120 to 124), with equal medians. The python truncation noted in round 1 did not occur in round 2.

### Guardian, run by run

Each cell is knownTrackerRequests / shieldsBlockedRequests / totalRequests for one repetition, read for this record from the ten committed receipts of the three epochs:

| Receipt | Build | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- | --- |
| 2026-09 baseline | `cd43c7bc` | 27/75/198 | 30/80/206 | 30/78/202 |
| 2026-09 candidate | `c8b189ac` | 17/48/160 | 27/69/182 | 27/71/182 |
| 2026-10 round 1 baseline | `f9d6c46e` | 27/70/188 | 17/47/165 | 30/77/191 |
| 2026-10 round 1 candidate | `34d6847b` | 27/71/183 | 28/71/184 | 27/72/188 |
| 2026-10 round 2 baseline | `f9d6c46e` | 27/72/190 | 27/71/189 | 17/47/164 |
| 2026-10 round 2 candidate | `34d6847b` | 34/88/201 | 29/76/195 | 27/72/189 |
| 2026-11 round 1 baseline | `59402b6d` | 16/48/161 | 17/49/166 | 16/48/165 |
| 2026-11 round 1 candidate | `8c6a8fc5` | 16/48/161 | 29/68/182 | 26/71/186 |
| 2026-11 round 2 baseline | `59402b6d` | 27/76/196 | 16/48/165 | 28/79/200 |
| 2026-11 round 2 candidate | `8c6a8fc5` | 16/48/161 | 19/50/164 | 26/71/186 |

What the table shows:

- Every one of the 30 runs falls in one of two groups: a low one (16 to 19 known-tracker requests, 47 to 50 Shields-blocked, 160 to 166 requests in all; 10 runs) and a high one (26 to 34, 68 to 88, 182 to 206; 20 runs). No run lies between them.
- Both groups occur inside a single build. In the six receipts of 2026-09 and 2026-10 the low group has 3 of 18 runs, each in a build whose other two runs were high. In this epoch it has 7 of 12.
- The same image gave both. The baseline image drew three low runs in round 1 and one in round 2, so its own shieldsBlockedRequests median moved from 48 to 76 between the rounds, a difference of 28 where the two rounds' between-build deltas were 20 and 26. The candidate image drew one low run in round 1 and two in round 2 (68 to 50).
- A median of three runs lands in the low group when two or more runs do. In both rounds of this epoch the arm with more low runs had the lower median, whichever build it was.

What it does not show: why a run lands in the low group. That it reflects how many ads or third-party frames the live page served on that visit is a hypothesis, consistent with the within-build pattern and tested by neither round. Nor does it show that the candidate's toolchain changes nothing on this page. The comparison cannot separate a toolchain effect on guardian from the group each run drew, and two rounds are too few to say more.

### HSTS comparison (bounded)

The two builds differ in more than the browser's version. The baseline's Chromium 153.0.8010.12 had stopped applying the HSTS preload list about four days before the captures, and the candidate's 156.0.8078.4 applies it. So this A/B measured the browser change and the preload difference together, as the 2026-09 A/B did, in the same direction ([its addendum](./toolchain-epoch-2026-09.md)), and it cannot attribute a median difference to either alone. Two measures were taken beside each capture, and each is limited to what it shows.

The first is a probe run offline, with no network, inside the exact image each deploy used (the image ID in each result file equals the deployed digest). It launches the image's own scan browser through the scanner's launch path behind a local proxy and asks for an `http://` URL of a preloaded host. A plain GET at the proxy means the browser did not apply the list; a CONNECT to port 443 means it upgraded the request first. An `http://` control host that is not preloaded must show a GET.

| Image | Round | Browser | Proxy saw | List applied | Control |
| --- | --- | --- | --- | --- | --- |
| `5c39f556…` (baseline) | 1 | 153.0.8010.12 | GET | no | GET, 200 |
| `acbb4078…` (candidate) | 1 | 156.0.8078.4 | CONNECT | yes | GET, 200 |
| `5c39f556…` (baseline) | 2 | 153.0.8010.12 | GET | no | GET, 200 |
| `acbb4078…` (candidate) | 2 | 156.0.8078.4 | CONNECT | yes | GET, 200 |

The second is an extractor that fetched each run's saved report from staging before teardown, checked it against the digest its receipt records, and counted `http:` request rows. Its output shows all 15 reports of each arm counted in both rounds:

| Measure | Round 1 baseline | Round 1 candidate | Round 2 baseline | Round 2 candidate |
| --- | --- | --- | --- | --- |
| Request rows | 1063 | 1101 | 1137 | 1085 |
| `http:` request rows | 0 | 0 | 0 | 0 |
| 307 then https pairs | 0 | 0 | 0 | 0 |
| Policy URL http / https / none | 0 / 6 / 9 | 0 / 6 / 9 | 0 / 6 / 9 | 0 / 6 / 9 |
| Runs with an `http:` requested subject | 0 of 15 | 0 of 15 | 0 of 15 | 0 of 15 |

What this establishes: the candidate's scan browser applies the preload list and the baseline's does not, and neither round's reports hold an `http:` request row in either arm. What it does not establish: that the preload difference had no effect on these scans. A browser can upgrade a request before Playwright reports it, so an upgraded request may appear only in its https form; the policy visit runs in a page whose requests are not request rows; the extractor holds no preload list, so it cannot say which hosts the list covers; and the panel uses https case URLs only. The staging reports are no longer readable, and the probe and extractor outputs are in the epoch working directory, not committed.

### No bisect

The playbook says that if the matched re-run fails again, the batched upgrades are bisected. Round 2 was that re-run and it failed again. No bisect was run. The criteria written before round 2 fixed that there would be no further rounds whatever it showed and that a case outside tolerance would be reported as an unresolved difference, and that is how this record reports guardian. The sources of this record hold no other recorded reason, and this record does not supply one. What the commits and the receipts show about the question:

- Of the playbook's four batched inputs the candidate moves two: Playwright with its Chromium, and the container base and lockfile that follow it. Of its 11 commits, `6f6aba61` moves the Playwright pin and `443d5bd9` moves the container base to the matching tag; adblock-rust, the vendored WASM, tldts and the lists do not move. `2f78393d` and `931b46e0` move the identity tables and the HSTS environment test to follow the pin, `ef189f9f` adds the CI annotation, `70d948a9` and `f1047730` add image-build assertions, `10a17293` upgrades apt in the runner stage, `b4423b6d` syncs the package ledger, `1aaab4ab` moves two development-only packages, and `8c6a8fc5` changes documents.
- The failing case moved more between the two rounds on one image than between the two images in either round, as the guardian table shows.
- The failure reversed direction between two rounds of the same two images, and under the rule added on 2026-11-10 neither round has a failing metric: each has two inconclusive ones.

### The owner's decision

On 2026-11-10 at 07:57 UTC the owner decided to release this epoch to production under a recorded exception to the A/B gate, accepting the two failed guardian comparisons as no evidence of a regression. The playbook requires the owner's recorded decision when the comparison exits 2, which is what these receipts give under the current rule; the question asked for that decision and for the owner's word to clear the promotion pause, and the owner gave both. When this record was written the pause still read 1 and `production` was unchanged.

What the evidence shows about the two comparisons (the recorded decision states no reasons):

- The two rounds failed in opposite directions on the same two images: the candidate's guardian medians were higher in round 1 (knownTrackerRequests 16 to 26, shieldsBlockedRequests 48 to 68) and lower in round 2 (shieldsBlockedRequests 76 to 50).
- One image's guardian runs differ among themselves by more than the two builds' medians differ. The baseline image's shieldsBlockedRequests runs were 48, 49, 48 in round 1 and 76, 48, 79 in round 2, so its own median moved by 28 between the rounds, against between-build deltas of 20 and 26. The same two groups of runs occur inside single builds in the committed 2026-09 and 2026-10 receipts.
- The other four cases showed no difference. On wikipedia, github, python and gov-uk all 36 compared medians are equal between the builds in each round, and on three of those sites every run of both builds records the same nine counts.
- No evidence family that feeds a canary metric lost evidence on any of the 60 runs, and the only capture loss recorded is in detector output, on every run of both builds for the same sites.
- The committed corpus exposes the same 1028 comparison decisions at the baseline and at the staged candidate.

The playbook asks the release decision to name each inconclusive metric with the values the command printed. For each of these the comparison is no evidence for the toolchain and no evidence against it:

| Round | Metric | Baseline runs (spread) | Candidate runs (spread) | Tolerance | Medians |
| --- | --- | --- | --- | --- | --- |
| 1 | guardian.knownTrackerRequests | 16, 17, 16 (1) | 16, 29, 26 (13) | 4.8 | 16 to 26 |
| 1 | guardian.shieldsBlockedRequests | 48, 49, 48 (1) | 48, 68, 71 (23) | 14.4 | 48 to 68 |
| 2 | guardian.knownTrackerRequests | 27, 16, 28 (12) | 16, 19, 26 (10) | 8.1 | 27 to 19 |
| 2 | guardian.shieldsBlockedRequests | 76, 48, 79 (31) | 48, 50, 71 (23) | 22.8 | 76 to 50 |

What the exception does not establish, and what was never staged:

- The A/B did not pass. Both rounds are recorded FAIL by the gate that ran, and exit 2 from the later rule is not a pass. By the playbook the epoch is not complete; the release rests on the owner's decision, not on a completed gate.
- It is not established that the candidate's toolchain changes nothing on guardian. Why a run lands in the low group is not established either.
- The rest of the panel carries almost no signal for the two metrics that failed. The other four cases record no known-tracker request on any of their 48 runs and between 0 and 5 Shields-blocked requests, so guardian is the only case that exercises those counts at any volume, and it is the inconclusive one. No remedy the playbook names for such a case (more repetitions, a statistic that tolerates a page with two modes, or a stable case) has been applied; the panel is the one these receipts carry.
- The commit to be released is later than the staged candidate and was never staged. The commits after `8c6a8fc5` are listed above. For `6b2360cc`, that staged behavior is unchanged is an inference from a text-only diff. For the later commits no such claim is made: they change scanner, scan-server, reading-side and front-Worker behavior on purpose, and no staging round ran any of them.
- The image to be released was never staged. Production deploys the image main CI builds and tests from the released commit, a native build. Neither staged image is that build, and the first native build of this epoch showed a layering defect the emulated builds had hidden.
- The staged baseline image was a same-commit rebuild, not the baseline's qualified image. Per the integrator's notes, the release evidence, vulnerability scan, package inventory and review check of the baseline's qualification were taken on a different image of the same commit (`sha256:0691cb2f…`), and the staged rebuild's in-image check printed 6,968 of the commit's 6,979 results; the 11 it did not print stay unobserved. Only the candidate's staged image is its qualification image.
- The staged baseline is not the build production runs. It is 20 commits past `069e8487`, and no staging round compared either arm with production's build.
- The baseline's browser check was weaker than the candidate's. Its Dockerfile asserts no browser version, so its browser identity rests on the in-image read and on the version every report in its receipts records, which agree.
- The Worker bundle differs between the arms in the two `lib/` files named above.
- The HSTS comparison is bounded as stated above, and the A/B could not separate the browser change from the preload difference.
- The canonical hosted teardown receipt of [the go-live runbook](./go-live-public-scanner.md) is unavailable for this staging deployment, and the durable replay canaries (lease-expiry and lost-resolve) were not run; both are described under the teardown below.
- The staging comparison does not close the independent-egress gate, and it does not settle any open detector finding.
- The staging evidence has gaps of its own. The stage logs before round 2, and the teardown logs, record no hash of the script that wrote them, so which revision each ran rests on file times. The application-list lag was observed, not measured. The round 2 criteria are dated by a modification time.

The gate that judged these captures is the one both staged commits hold: the panel digest in these receipts is the one the 2026-09 and 2026-10 receipts carry, and the canary code does not differ between the baseline and the staged candidate. The comparison rule was changed on 2026-11-10 (`30483bdd` and the four commits after it), after both captures, after these two FAILs and before this decision, and the change ships in the same release. It does not judge these receipts again, and nothing in this record presents its output as the result.

## Staging teardown

A manual Wrangler teardown with readbacks on 2026-11-08, after the second comparison, in the order the owner ruled: the container application first, then the Worker, then the images.

- Container application `a03ff526-2f40-4c94-8909-523d7790a146` (created by the first deploy attempt at 01:05 UTC; it served all four captures) was deleted at 04:48 UTC, once its live placements read 0. The read-only inventory at 05:20 UTC reads it absent and lists no staging application and exactly one production application.
- Worker `site-behavior-lab-scanner-staging` was deleted at 05:11 UTC. Its deployments list returns code 10007, and so does the read of its seven secrets, which went with it.
- The three staging image tags (`e10aadc9` = `sha256:251ac9a8…`, `62ba396b` = `sha256:5c39f556…`, `0b2c787a` = `sha256:acbb4078…`) were deleted from the managed registry at 05:11 UTC; the readback lists none. Per the integrator's notes both staged images were still in the operator's local Docker store, under their digests, after the registry tags were deleted.
- `scan-staging.sitebehavior.org` has no A, AAAA or CNAME answers, from the zone's authoritative server and from a public resolver, and no longer resolves for an HTTPS request (05:20 UTC).
- Dashboard readbacks between 05:20 and 05:23 UTC, per the teardown's readback notes: Containers lists one application, production's; the complete Durable Objects inventory reads "Showing 1-1 of 1", production's namespace only, so the staging namespace (`9e5a7394…`) is gone; the zone's DNS records no longer hold the staging record and still hold production's; a Workers search shows the production Worker only. The certificate pack dedicated to the staging hostname was removed with the Worker's custom domain, so no certificate was deleted by hand; production's pack and the shared universal and backup certificates are unchanged.
- The production Worker, container application, bucket and hostname were not touched.

The teardown script failed closed three times on the way, and the readbacks above are from after the last correction. Wrangler 4.151.1 printed, for a deleted application, its instances and a deleted Worker's secrets, three absence messages the script did not know, where its test doubles had modelled another. The first pass (04:35 to 04:48 UTC) deleted the application and then refused to touch the Worker or the images; the second (04:55 to 05:04 UTC) was stopped while still read-only, with nothing deleted; the third (05:11 to 05:16 UTC) deleted the Worker and the images and ended with two failed readbacks, the secrets read and an HTTPS check that answered 530 while a cached DNS answer was still in use. The read-only inventory at 05:20 UTC, with the script accepting the three real messages, ended with no failed check. No step deleted anything out of order. The script's absence check matches text (any output containing the code 10007 for the Worker and its secrets, or "Not Found" for an application), so an unrelated error carrying that text would read as an absence; the dashboard readbacks above are the independent check of each one.

Cleanup of what the teardown left, closed on 2026-11-09:

- The R2 API token `sbl-staging-toolchain-canary-2026-11` was revoked in the dashboard on 2026-11-08 at about 15:03 UTC. After a reload the account's R2 API tokens list production's token only, and the user tokens are unchanged. The dashboard readback is the evidence of the revocation; it was not tested with a request.
- The local file that held the staging scan access token is absent, confirmed at 15:19 UTC on 2026-11-08 by existence checks only.
- The staging bucket held the reports of the receipted runs until its 1-day expiry rule emptied it. R2's analytics object count disagreed with the object listing in both directions while it emptied (a zero while objects were still listed on 2026-11-08, and 60 with none listed on 2026-11-09), so the listing was taken as the evidence of empty and the count only as a trigger. On 2026-11-09, after a dashboard listing that showed no object and no folder, the bucket was deleted at 06:06:12 UTC; `r2 bucket info` then failed with "The specified bucket does not exist. [code: 10006]", `r2 bucket list` names only `site-behavior-lab-reports`, and the dashboard's R2 overview lists that bucket alone.
- The operator's Wrangler login was logged out on 2026-11-09 at 17:44 UTC (`wrangler logout`, exit 0, after which `wrangler whoami` reports no login). Wrangler does not check the provider's answer to the revocation, so this shows the local login cleared.

What this teardown is not:

- It is not the canonical twelve-resource teardown receipt from [the go-live runbook](./go-live-public-scanner.md). That ceremony needs a commit on protected `main`, and neither staged commit was on `main` when staging ran. The owner ruled for a manual teardown on 2026-11-07. A manual teardown forecloses the canonical receipt for this deployment, and the runbook refuses an all-absent rerun as retrospective evidence.
- The durable replay canaries (lease-expiry and lost-resolve) were not run. They belong to the durable-jobs activation and need a commit on protected `main`; neither earlier epoch ran them, and the owner excluded them on 2026-11-07.
- No release or durable-activation gate is satisfied by this teardown or by its cleanup.

This record was committed before production was advanced. The publication evidence (the main CI run for the released commit, the promotion, the container and Pages deploys, and the live readback) is added to this record after the readback.
