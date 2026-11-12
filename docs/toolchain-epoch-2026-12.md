# Toolchain epoch 2026-12

The epoch record for the 2026-12 toolchain epoch (Playwright 1.64.1 to 1.65.0, bundled Chromium 156.0.8078.4 to 158.0.8127.18, adblock-rust 0.13.3 to 0.13.5 with the vendored WASM rebuilt, and the container's Node 24 to Node 26), kept as [the toolchain epoch playbook](./toolchain-epoch.md) asks: the version matrix, the corpus-neutrality result, the exact-build staging A/B and the staging teardown readback. It is the fourth epoch whose staging A/B ran and the third whose A/B failed under its gate: two matched rounds on 2026-11-12, each FAIL on capture loss, each on a different site and a different signature. In both rounds the comparison was refused before any median was judged, so this A/B compared no median at all. It is the first A/B on panel version 2 (`monthly-toolchain-canary-v2`) and the first captured after the comparison rule `median-with-within-arm-spread-v2` was added; neither round reached that rule. On 2026-11-12 the owner decided to release the epoch under a recorded exception, as [the 2026-11 epoch](./toolchain-epoch-2026-11.md) was released. Both rounds stay FAIL. They are not pooled, and nothing in this record presents either as a pass. This record was first committed before production was advanced; the Publication section at its end was added after the live readback.

- Production and `main` when both rounds ran: `35b8f6a64395dfcaa0850cb5c201edb7ca0481d4`, per the integrator's notes.
- Baseline: `35b8f6a64395dfcaa0850cb5c201edb7ca0481d4`. Unlike the 2026-11 baseline, it was the build production ran when it was staged.
- Staged candidate: `d84033671430f4acbc94f0cd4451b87e9c1d1215` (8 commits on the baseline: `40bc335e`, `58e5aca7`, `f3d3358c`, `95731b43`, `b7fbf7ef`, `78fa3d14`, `8704834d`, `d8403367`). This is the build both A/B rounds scanned.
- Released commit: `2d5efbe075847fec212dcefa7d3d6425ea704395`, three commits past the replayed candidate `a5ec3a3f`. It is later than the staged candidate and was never staged. The record's first version left it unnamed, because it preceded the promotion. No commit other than `35b8f6a6` and `d8403367` was staged or scanned: the receipts attest those two and nothing else.

## Main after the staged candidate

`main` moved once between the A/B and this record, from the baseline `35b8f6a6` to `cbec10be728215d571004cc4bd5d56148ceb4e61`, eleven commits (`7326be58`, `9e6c7f72`, `1e987656`, `c0f5b5c7`, `0110973b`, `2bd2af88`, `9b5e50f7`, `e3973867`, `5205187f`, `abddd576`, `cbec10be`). They add two TLA+ specifications with their exports and conformance tests (`specs/`, `scripts/tla-*`), two npm test stages and a changelog entry. By `git diff 35b8f6a6 cbec10be`, they change `CHANGELOG.md`, `package.json` and new files under `specs/` and `scripts/`, and nothing else: no file under `lib/`, `app/`, `cloudflare/` or `investigation/`, no Dockerfile, no lockfile and no workflow. In `package.json` they change three entries of the `scripts` block (`test:unit`, and the new `test:tla-case-machine` and `test:tla-worker-hold`) and nothing outside it.

The candidate's eight commits were then replayed on `cbec10be` with no conflict, as `e317b148`, `27735aca`, `f6f1752b`, `f85c8024`, `a9827acc`, `70c5d11b`, `5dd3adda` and `a5ec3a3f`; `git range-diff` reports each of the eight equal to its original. The receipts and this record follow as further commits.

Everything that is a toolchain input reads the same at the staged candidate `d8403367` and at `a5ec3a3f`, by `git diff`: `package-lock.json` (sha256 `7ef1326d…`), the Dockerfile with its base image digest, its expected Node, npm and browser versions and its snapshot time, `.node-version` and `.nvmrc`, the workflows, the vendored WASM with `Cargo.lock` and the reproducibility contract, the Playwright constant, the list snapshot, the seccomp profile, the container package ledger, the third-party inventory, the table of Chromium build times, the canary command, its library and its panels, the r2 producer contract, the normalization, `cloudflare/` and the two container configurations. Over the whole tree the two commits differ only in the files the eleven commits above changed. `package.json` is the one input file that is not byte for byte the same: it differs in those three `scripts` entries, and its dependencies, overrides and every other field are equal. That is a statement about inputs read from git. It is not a staging result, and the image main CI builds for the commit to be released is neither staged image: it is a native build of a later commit.

## Version matrix

| Input | Baseline `35b8f6a6` | Candidate `d8403367` |
| --- | --- | --- |
| Playwright (npm `playwright` and `playwright-core`) | 1.64.1 | 1.65.0 |
| Bundled Chromium (and headless shell) | 156.0.8078.4, revision 1248 | 158.0.8127.18, revision 1254 |
| `NODE_PLAYWRIGHT_VERSION` (`lib/legacy-methodology.ts`) | 1.64.1 | 1.65.0 |
| Container base `mcr.microsoft.com/playwright` | `v1.64.1-noble@sha256:47b510dd…` | `v1.65.0-noble@sha256:6e3fb709…` |
| Container Node / npm (asserted by the Dockerfile) | 24.22.1 / 11.19.1 | 26.13.0 / 11.20.0 |
| Browser asserted by the Dockerfile's base stage | Google Chrome for Testing 156.0.8078.4 | Google Chrome for Testing 158.0.8127.18 |
| Ubuntu package source of the image's two package steps | the live mirrors | Ubuntu's snapshot service at `20261110T000000Z` (`d8403367`) |
| apt and libapt-pkg6.0t64 in the runner image | 2.8.4ubuntu0.1 | unchanged |
| Container package ledger | 513 rows, package set `830642c8…` | 513 rows, package set `cde067a5…` |
| adblock-rust (Cargo.lock) | 0.13.3 | 0.13.5 |
| wasm-bindgen (Cargo.lock) | 0.2.129 | 0.2.130 |
| `tools/adblock-wasm/Cargo.lock` | 70 packages, sha256 `106c9724…` | 66 packages, sha256 `e05232c6…` |
| Vendored `sbl_adblock_wasm_bg.wasm` | `7dda4b30…` | `e24f4484…` |
| tldts / tldts-core | 7.4.16 | unchanged |
| Brave Shields lists | 2026-10-19 snapshot (31 lists, manifest `25bef053…`) | unchanged |
| Seccomp profile | `cc3e61ca…` | unchanged |
| Canary panel | `monthly-toolchain-canary-v2`, file sha256 `20c913f5…` | unchanged |
| Wrangler (lockfile) | 4.159.0 | unchanged |
| `package-lock.json` sha256 | `3b7a8f53…` (the same at `cbec10be`) | `7ef1326d…` (the same at `a5ec3a3f`) |

Full digests, each recomputed for this record from the git objects:

- `package-lock.json`: `3b7a8f53cfe6e7bc227265f7e98354c92836277b8d1f6441333850f69b82eb2a` at `35b8f6a6` and `cbec10be`, `7ef1326d66abb7c4535362178153740d5bac8f1ecf2d60682a33c241adecb651` at `d8403367` and `a5ec3a3f`.
- Container base index digest, as each Dockerfile names it: `47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea` to `6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d`.
- Container package ledger, `inventoryPackageSetDigest`: `830642c80370c0ec35ebfa110e445046a4936420ec785d7821aaeecb636a850e` to `cde067a50250f238572fcc922f50aacc2bcd46b7d29be99649daa319909dc673`.
- `tools/adblock-wasm/Cargo.lock`: `106c97247df0f699510239c5db330d513d09832a9206eaecf54ef54bc5beff35` to `e05232c649d85e60f69ebc8a791b7611101fc5adf267132da671a7f300efe94a`.
- `lib/adblock-wasm/sbl_adblock_wasm_bg.wasm`: `7dda4b30ce6d4cc9fb9722b6763cfade690f85ff5f2d8a4bdb992fdae6d1d3cc` to `e24f44849c65b429f63a88de371505d8a188fbc27230ace3b093caa0be3d3911`.
- `tools/adblock-wasm/reproducibility-contract.json`: `02296a7299f67d4ab438e6fcf463b903edb2586f15e290fa0857994a0fbde216` to `727da186b400d6b6bc1d497a9b841af56314697f2e1a903ed20886249356a7d2`.
- Unchanged at both: `scripts/playwright-seccomp-profile.json` `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`, the Brave list manifest `25bef053aac3c343e99c5ae44836c6ce0550669a75cd7568bc95fda8a3d6f624`, and `scripts/fixtures/toolchain-canary-panel.json` `20c913f51ede3e53458f3350d10e076fa5252aec04dbb9b8154d846e8b511173`.

The package ledger's rows differ between the two commits in exactly two packages, both the new base's own: nodejs 24.22.1 to 26.13.0 and ca-certificates 20260816ubuntu0.24.04.1 to 20260816ubuntu0.24.04.2.

Where each version came from, the dates the registries published them, how the WASM was rebuilt and what the new ad-block engine blocks that the outgoing one let pass are in [the changelog entry for this epoch](../CHANGELOG.md), which this record does not restate. Two of its points bear on how to read the A/B below:

- This epoch moves more inputs at once than the 2026-11 epoch did. That one moved Playwright with its Chromium and the container base that follows it. This one also moves the ad-block engine, with a rebuilt WASM whose blocking decisions differ in two shapes the changelog entry describes, and the container's Node by a major version. The A/B compared all of them together and can attribute nothing to one of them.
- The scanner in the image runs Node 26.13.0, two majors ahead of the Node 24.14.1 that the host and the main test jobs use. The image's own check is what runs the suite on it. No scan report records the Node version.

### Measurement identity

Of the version strings this repository records, the methodology moves in two components and the ad-block identity in one. The base Node methodology, which is also the v1 methodology token and the corpus cohort key, moves from `…-adblock-rust-0.13.3-request-method-v1-playwright-1.64.1+subject-validity-v4+…` to `…-adblock-rust-0.13.5-request-method-v1-playwright-1.65.0+subject-validity-v4+…`, and the r2 methodology carries the same move under its unchanged suffix. A report measured with the lists also records the engine as `adblock-rust-0.13.5` where it recorded `adblock-rust-0.13.3`. Every report records the browser version, which moves from 156.0.8078.4 to 158.0.8127.18, and the r2 condition, measurement-environment and execution fingerprints hash it. `f3d3358c` closes the two outgoing producer rows (`node-v30-detectors-v24-active-lists-2026-10-19` and `node-v30-detectors-v24-active-no-adblock`) to their exact literals and declares `node-v31-toolchain-2026-12-active-lists-2026-10-19` and `node-v31-toolchain-2026-12-active-no-adblock`. No normalization, detector, registry, obligation, catalog or list identity moves, so there is no `SUPERSEDED_R2_NORMALIZATIONS` entry for this epoch. Because the methodology names the engine, reports of the two engines fall in different corpus cohorts.

The A/B receipts show the move end to end. All 30 baseline runs record build `35b8f6a6`, Chromium 156.0.8078.4, a methodology naming `adblock-rust-0.13.3` and `playwright-1.64.1`, and the engine version `adblock-rust-0.13.3`; all 30 candidate runs record `d8403367`, 158.0.8127.18, `adblock-rust-0.13.5` and `playwright-1.65.0`. Every one of the 60 runs records the same registry (`node-detectors-v24`, digest `24ac4881…`), the same normalization (`tldts@7.4.16` under the public-string-policy-v4 digest `3a2328d7…`), the same tracker catalog and the same list manifest.

One recorded behavior that moved with the browser in 2026-11 does not move here. Chromium stops applying its built-in HSTS preload list 70 days after its build ([the limitations](./limitations.md#the-scan-browsers-hsts-preload-list)). By the estimate from each version tag's commit time, 156.0.8078.4 applies the list until about 2026-12-08 23:57 UTC and 158.0.8127.18 until about 2027-01-13 01:08 UTC. Both captures ran on 2026-11-12, inside both windows, so by that estimate both browsers applied the list during the A/B. The inputs of this record hold no probe result taken beside these captures, as the 2026-11 record had, so that rests on the estimate.

## Corpus neutrality

`npm run corpus:audit-neutrality -- snapshot` was run for this record in two separate trees, each extracted from its exact commit with `git archive` and given its own `npm ci`: the baseline `35b8f6a6` (resolving Playwright 1.64.1) and the staged candidate `d8403367` (resolving 1.65.0). Each wrote 1028 managed comparison decisions, and the two snapshots are byte-identical (sha256 `63cef2c06a262ac0d901f2b8b5e28a3f2bf7f65a88b3cf9c6fb9d240efdac746`, the digest the 2026-11 record gives for a snapshot at `fc4833d9`). The compare, run from the candidate tree, prints "Corpus neutrality unchanged across 1028 managed comparison reports." and exits 0. A third snapshot, taken in the working clone at the commit that added this record, has the same digest. Both installs ran from the local npm cache with the network off and with install scripts off (`npm ci --offline --ignore-scripts`), which the playbook's commands do not ask for; the snapshot command compiled and ran in each tree.

Qualification outside staging, per the integrator's notes and not from committed logs. The candidate's eight commits were gated locally and in hosted CI one rebase earlier, as `68993036` on `b554198e`, which is three commits before the baseline; `git range-diff` reports each of those eight equal to its counterpart in the staged candidate. The local gate on `68993036` passed with 7,325 tests and none failed. Hosted CI ran on it once, for evidence only, from a draft pull request that is not to be merged: [run 43077778779](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43077778779) concluded success on 2026-11-11, with every test job successful and the attestation and promotion jobs skipped. Per the notes its Docker job built the image natively for linux/amd64 and ran the image's own suite on Node 26.13.0 with Chromium 158 (7,325 tests, 7,289 passed, none failed, 36 skipped), and its image scan and package-evidence steps succeeded. That run is of `68993036`, not of the staged candidate and not of the commit to be released.

## Staging A/B

### Provisioning, and what stopped before capture

The operator provisioned staging on 2026-11-11 from 20:18 UTC, as [the go-live runbook](./go-live-public-scanner.md) describes, per the integrator's notes: the collision preflight (Worker absent with code 10007, bucket absent with 10006, no A, AAAA or CNAME record for `scan-staging.sitebehavior.org`, and no staging application in the Containers inventory), the staging-only bucket `site-behavior-lab-reports-staging` (created at 20:19 UTC) with the lifecycle rule `durable-replay-staging-cleanup` (expire objects after 1 day, abort incomplete multipart uploads after 1 day), a bucket-scoped R2 API token, the seven staging secrets read back by name only, and the draft Worker `site-behavior-lab-scanner-staging`.

The same staging deployment first served the one qualifying capture of the panel change, on 2026-11-11 from 21:30 to 21:35 UTC, of the build `b554198e` that was then `main`. Its receipt is committed at `docs/toolchain-canary-qualification-2026-11/qualification-receipt.json`, and its verdict gave panel version 2: ssa.gov takes gov.uk's slot and the Guardian stays. Panel version 2 became the current panel at `9686f06f`, which the baseline contains, so the panel both rounds ran on was committed before the first comparison capture. The qualifying deploy created the staging container application (`a031618a-6cc8-42c5-9a27-3a5780a7ac29`), which then served all four comparison captures.

Each arm was deployed from a clone of its exact commit with `npm run cf:container:staging:deploy`. The identity table of round 2 records each arm's commit and tree (`bdae87ee…` and `81ba2c0d…`, the trees of the two commits) and names Wrangler 4.159.0, the version both lockfiles resolve. Round 1's baseline arm completed at 00:11 UTC on 2026-11-12. Its candidate arm was then attempted four times, and the first three stopped before any capture and wrote no receipt. An arm that stops before capture is not a round. Per the integrator's notes:

1. Refused before the deploy, at 01:06 UTC. The stage script requires the Containers application list and the per-application read to agree on the deployed image before each deploy, the check the 2026-11 record describes. Over its 150 polls, more than an hour, the list still named the image of the qualifying capture's build while the application itself named the baseline image, with no rollout active. Nothing was deployed and no candidate scan was submitted.
2. Failed in the local image build, at 01:52 UTC, before any Worker upload and before any change to staging. One test of the suite the image build runs failed under host load (`lib/scroll-check-fixture.test.ts`, "each page ends the check as the outline says"). The notes read it as a timing failure under load and not as a result about Chromium 158; that is a reading.
3. Lost its image push, at 03:06 UTC. The image built and its suite passed, Wrangler uploaded the staging Worker, and the push of one layer to the registry then timed out. No capture ran. From then until the fourth attempt's deploy, staging held the candidate's Worker code beside the baseline's image.
4. Completed. The deploy and the push succeeded and 15 runs were captured from 03:12 to 03:17 UTC.

### Deviations

Each of these departs from the playbook, from the runbook or from the stage script as it was prepared, and each is stated here so that a reader can weigh the rounds with it.

- A stale application list was accepted by an override in round 1. After the first candidate attempt was refused, the integrator added an override to the stage script and used it for attempts 2, 3 and 4. It accepts a stale list only when the list names one exact digest given beforehand, for the same application, with no rollout active, after at least three polls, and it logs the word DEVIATION. The check after the deploy, that the deploy edited the application to the arm's own image, still decided, and the health gate still passed only once the container reported the arm's own SHA. The override was not used in round 2. Because it was added between the two arms of round 1, those arms ran different revisions of the stage script.
- Round 1's two captures are three hours apart: the baseline's scans started between 00:06 and 00:11 UTC and the candidate's between 03:12 and 03:17 UTC. A matched round assumes the pages are the same pages for both builds. Over three hours that is a weaker assumption than over the ten minutes of round 2.
- After the third attempt the stage script advised a teardown, because staging held one build's Worker beside another build's image. The integrator reran the candidate arm instead, and the notes give the reasons: the state was known, the same deploy repairs it, the health gate refuses a mismatch, and the baseline receipt had been written before it. No capture ran in that state.
- No bisect was run after the second failed round, where the playbook asks for one. See [No bisect](#no-bisect).
- The staging teardown was manual, with no hosted canonical receipt. See [Staging teardown](#staging-teardown).
- The corpus-neutrality installs for this record ran offline with install scripts off, as stated above.

### Builds and panel

| | Baseline | Candidate |
| --- | --- | --- |
| Build | `35b8f6a6` | `d8403367` |
| Image | `sha256:f0d3958f5e99421befb3330490084fddf14acd9f8e7efc579fa5d4e37fc43895` | `sha256:6fc91b9e6845a84c645908671d70c360726fb89980b045df836063c7fe2039e3` |
| Built | by the round 1 staging deploy; the round 2 deploy reproduced the same manifest digest and pushed nothing | by the round 1 staging deploy, attempt 3; the round 2 deploy reproduced the same manifest digest and pushed nothing |
| Node in the image | v24.22.1, equal to the Dockerfile's assertion | v26.13.0, equal to the Dockerfile's assertion |
| Browser in the image | Google Chrome for Testing 156.0.8078.4, equal to the Dockerfile's assertion | Google Chrome for Testing 158.0.8127.18, equal to the Dockerfile's assertion |

The image digests are the ones the criteria for round 2 froze, and round 2's identity table records that each arm's build reproduced its digest, that the registry held it already, that the application list and the application agreed at the first poll before each deploy, and that the image's runtime user can read the application files. That table covers round 2. The inputs of this record hold no such table for round 1.

All four captures ran against the committed panel `monthly-toolchain-canary-v2` (`scripts/fixtures/toolchain-canary-panel.json`: wikipedia, github, python, ssa-gov, guardian; 3 repetitions; panel digest `51f0ebcb7997559738a8891256a10d25d5783730b1b6238f8d3ec478682df376`). The canary command and its library, the panels, the staging configuration, `cloudflare/` and the deploy script do not differ between the two commits, and neither does the scanner's own source: outside tests, the candidate changes four files under `lib/` (`legacy-methodology.ts`, `corpus-cohort.ts`, `redact-scan-report-v1.ts` and `scan-report-v2-r2-producer-contract.ts`, the constants and tables that carry the new identities) and the vendored WASM with its loader. The Worker each arm bundled is built from its own commit, so it can differ in those files.

Every one of the 60 receipted runs records egress `WNAM/lax08/US`, run outcome complete with HTTP 200, and complete requests, cookies and storage families. The comparison checks the observed subject, the egress region and the conditions of every run of both builds before it reads capture loss, and neither round was refused there. The 30 baseline runs record Chromium 156.0.8078.4 and the 30 candidate runs 158.0.8127.18.

| | Round 1 baseline | Round 1 candidate | Round 2 baseline | Round 2 candidate |
| --- | --- | --- | --- | --- |
| Order | forward | reverse | forward | reverse |
| Runs | 15 | 15 | 15 | 15 |
| First to last scan start (UTC) | 00:06:59 to 00:11:06 | 03:12:48 to 03:17:34 | 03:39:53 to 03:44:25 | 03:49:48 to 03:54:29 |
| Receipt created (UTC) | 00:11:32 | 03:17:46 | 03:44:50 | 03:54:42 |
| Receipt | `round-1-baseline-receipt.json` | `round-1-candidate-receipt.json` | `round-2-baseline-receipt.json` | `round-2-candidate-receipt.json` |
| Receipt sha256 | `6597cf85b0d01773b27724ec36beb00f3ec54fcd3329fcb0ada6bc476e2a4de4` | `34fc94af3ac711917c12884f97da06a6cea58eeb9365f68a6e5f1e9232db5ca7` | `5eb4348e53e50e91dc84e270074c77ef002e84e4ab153acf1226cd989249e20d` | `1112f1020687da49702eb6e3092e24e03c70cbf949ade85f8d17a56c87c557e5` |

The four receipts are committed byte for byte beside this record in [`toolchain-epoch-2026-12/`](./toolchain-epoch-2026-12/), and each sha256 above equals the digest the comparison log of its round recorded when the comparison ran. Each carries the exact staging report IDs of its 15 runs. Their key set is the key set of the committed 2026-11 receipts, and they hold no token, no account identifier and no local path.

### Round 1: FAIL

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2026-12/round-1-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2026-12/round-1-candidate-receipt.json
```

Result recorded on 2026-11-12 at 03:17 UTC, from a clean checkout of the staged candidate (the comparison log, exit 1):

```text
FAIL Capture loss detector-output/truncated/policy-link-candidates differs systematically between the builds on python: 3 of 3 baseline runs vs 0 of 3 candidate runs.
```

That result stands as recorded. It reproduces: run for this record from the checkout this record was committed on, on the two committed files, the command prints that line and exits 1. It prints no `RULE` line, because a comparison that is refused on capture loss judges no median.

What the line means. Detector output feeds no canary metric, so a loss in it fails the comparison only when it differs systematically between the builds: more than half of one build's runs of a site carry it and none of the other build's do. All three baseline runs of python.org record that the search for privacy-policy links was truncated, and none of the three candidate runs does.

What the receipts hold beside it, which the command did not judge, because it stops at the first requirement that fails and python is the third of the five cases:

- On wikipedia, github and python, all six runs of the round record the same nine counts. On ssa-gov the baseline's runs record 76, 77 and 76 requests and the candidate's the same, and one candidate run records 17 Shields-blocked requests where every other run records 16.
- Guardian's three baseline runs record the same nine counts (163 requests, 17 known-tracker, 49 Shields-blocked). Its candidate runs record 163, 168 and 195 requests, 17, 17 and 32 known-tracker requests and 44, 48 and 59 Shields-blocked requests.
- One candidate guardian run (repetition 3) records a dropped fingerprint observer, the signature round 2 failed on, and no baseline run does. The comparison rule requires every run of a site in both builds to record the same loss signatures in the families that feed a metric, and fingerprinting is one. The command did not reach guardian in this round, so it printed nothing about it.
- github's keystroke-probe truncation and guardian's dropped policy visit are on every run of both builds. Guardian's dropped consent-banner probe is on all three baseline runs and on one candidate run.

Why python's link search was truncated in one arm and not the other is not established. The scanner source that searches for those links does not differ between the two commits. The search marks its result truncated when the page holds more than 2,000 links, when a link's address cannot be read, when 12 candidates are found with links remaining, or when a link that does not match has text past the 512 characters read to decide it (the constants are in `lib/scanner.ts`). The integrator's reading is that python.org's page changed between the two captures, three hours apart: per the integrator's notes, the two python reports read from staging were equal in every count and request, and the page fetched shortly after the candidate capture held one link whose text was about 516 characters, in a sponsor paragraph. That is a hypothesis, not a measurement. Nothing recorded what the page held at 00:09 UTC, when the baseline visited it. The committed receipts of earlier epochs are consistent with a signature that comes and goes with the page and do not prove it: python's link search was truncated on every run of both builds in round 1 of 2026-11, on no run in round 2 of 2026-11, and on one candidate run of six in round 2 of 2026-10.

### Round 2: FAIL

The playbook asks for one complete matched re-run after confirming the same staging region and stable subjects. The owner approved it ("Yes, run round 2"), with its criteria written before any capture. The criteria file fixed: one complete matched re-run on round 1's two images, frozen by digest; the same panel, rule, tolerances and capture-loss rule, with nothing relaxed and no case dropped; both rounds reported separately and in full, not pooled, with round 1 staying a FAIL; the result being the compare command's exit status and lines, unedited; the stale-list override not used; and no further round whatever this one showed. It also fixed what round 2 could say about round 1's line: with the arms minutes apart the same line should not appear, and if it appeared again the hypothesis above would not be supported and the update would not land on this session's evidence. The file states that it was written at 03:25 UTC, before round 2's first capture at 03:39 UTC. This record has the file's own statement for that time and nothing independent of it. The file is in the epoch working directory, not committed (sha256 of the copy read for this record: `925346a105b3b1518db914cb91c8d7af7a5397f58cefc6cc909b390d5931927d`).

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2026-12/round-2-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2026-12/round-2-candidate-receipt.json
```

Result recorded on 2026-11-12 at 03:54 UTC, from a clean checkout of the staged candidate (the comparison log, exit 1):

```text
FAIL Capture loss differs between runs of guardian: ["fingerprinting/dropped/fingerprint-observer"] vs [].
```

That result stands as recorded, and it reproduces the same way: from the checkout this record was committed on, on the two committed files, the command prints that line and exits 1, with no `RULE` line.

What the line means. Fingerprinting is a family a canary metric is counted from, so its capture loss is compared strictly: every run of a site in both builds must record the same signatures. The first guardian run of the baseline and the first guardian run of the candidate each record that the fingerprint observer was dropped, and the other four guardian runs record no fingerprinting loss. So the six runs do not agree, and the comparison is refused. The loss is on one run of three in each build. It does not differ between the builds.

What round 2 shows about round 1's line: it did not repeat. No python run of either build records the truncation in round 2, with the two captures ten minutes apart. That is what the hypothesis predicted. One round in which a signature is absent does not establish why it was present in the other.

What the receipts hold beside it, which the command did not judge. The capture loss of wikipedia, github, python and ssa-gov was read and did not refuse the comparison. Guardian is the last case, and the command stopped there, before guardian's other losses and before every median:

- On github and python, all six runs of the round record the same nine counts. On wikipedia five runs record 6 requests and one candidate run records 7. On ssa-gov the baseline's runs record 76, 77 and 76 requests and the candidate's 76, 78 and 77.
- Guardian's baseline runs record 182, 164 and 197 requests, 25, 17 and 28 known-tracker requests and 56, 49 and 69 Shields-blocked requests. Its candidate runs record 189, 195 and 196 requests, 27, 28 and 28 known-tracker requests and 56, 70 and 67 Shields-blocked requests.
- github's keystroke-probe truncation and guardian's dropped policy visit are again on every run of both builds. Guardian's dropped consent-banner probe is on one baseline run and on two candidate runs.

Those counts are what the receipts record. No median of them was compared in either round, so this record gives none of them as within tolerance, outside it or inconclusive.

### The fingerprint observer on guardian

Across the four epochs' committed receipts, the guardian case records a dropped fingerprint observer on every run of both builds in 2026-09 and 2026-10 (18 of 18 runs), on no run in 2026-11 (0 of 12), and on 3 of 12 runs in this epoch: none of the baseline's and one of the candidate's in round 1, and one of each build's in round 2. All 12 runs of this epoch record the detector registry `node-detectors-v24`. A loss that every run of both builds shares leaves the metric out for that site, as in 2026-09 and 2026-10. A loss that some runs carry refuses the comparison, as here.

What this does not show: why the observer is dropped on some guardian visits and not on others, and whether the new browser changes how often. Three runs of twelve, split one and two between the builds, cannot say. It is an open question about the scanner on this page, and this record does not answer it.

### No bisect

The playbook says that if the matched re-run fails again, the batched upgrades are bisected. Round 2 was that re-run and it failed again. No bisect was run. The criteria written before round 2 fixed that there would be no further round whatever it showed. The integrator's notes give one more reason: round 2's failing loss is on one run of each build, so it does not separate the builds and a bisect has no difference between them to follow. That is a reading of one round, not a result. What the commits and the receipts show about the question:

- Of the playbook's four batched inputs the candidate moves three: Playwright with its Chromium (`40bc335e`), adblock-rust with the rebuilt WASM (`58e5aca7`), and the container base with its package ledger (`78fa3d14`). tldts and the lists do not move. `f3d3358c` and `95731b43` move the identity tables and the HSTS expectations to follow the pins, `b7fbf7ef` changes the changelog, and `8704834d` and `d8403367` reorder the image's package step and move its package source to a fixed snapshot.
- Round 1's failing signature did not repeat in round 2, on the same two image digests and in the same region.
- Round 2's failing signature is carried by one run of each build.
- Neither round reached a median, so the A/B holds no judged difference in any count that a bisect could be aimed at, and no judged agreement either.

### The owner's decision

On 2026-11-12 the integrator asked the owner: "Release the browser update under a recorded exception, as in November?" The owner answered, in their words: "yes to both, go with your recommendations". The second question of the two concerned the staging teardown, below. The integrator's notes record the answer at 07:36 UTC.

This is an exception to the playbook itself. The playbook says that a compare command that exits 1 is a failed A/B and that the epoch is then not complete, and it names the owner's recorded decision as the way forward only for exit 2. Both rounds here exit 1. The release rests on the owner's decision and not on a completed gate.

What the evidence shows about the two comparisons (the recorded decision states no reasons):

- The two rounds failed on different sites and different signatures. Round 1's signature did not repeat: no python run of round 2 records the truncation. Round 2's signature, a dropped fingerprint observer on guardian, is on one run of each build in round 2, and round 1's receipts hold it on one candidate run, which that round's comparison did not reach.
- The scanner source that produces both signatures is the same in both builds, by `git diff`. The browser, the ad-block engine and the container's Node are not.
- Every run of both builds completed with HTTP 200, with complete requests, cookies and storage families, on the same observed subject per site and in the same egress region.
- The committed corpus exposes the same 1028 comparison decisions at the baseline and at the staged candidate.

What the exception does not establish, and what was never staged:

- The A/B did not pass. Both rounds are recorded FAIL by the gate that ran, under panel version 2 and the comparison rule `median-with-within-arm-spread-v2`, and they stay FAIL. By the playbook the epoch is not complete.
- It is not established that the two browsers measure alike. No median was judged in either round, so the A/B gives no evidence that any count agrees between Chromium 156.0.8078.4 and 158.0.8127.18, and no evidence that any count differs. The counts quoted above are what the receipts hold, not a comparison.
- It is not established that the new ad-block engine or the container's Node 26 changes nothing. The A/B moved the browser, the engine and Node together and judged none of them.
- It is not established why python's link search was truncated in one arm of round 1. The page-change reading is a hypothesis that round 2 did not contradict.
- It is not established why the fingerprint observer is dropped on some guardian visits, or that the rate is the same under both browsers.
- The exception says nothing about any commit after the staged candidate. The commit to be released is later than `d8403367` and was never staged. That the eleven commits on `main` and the replay of the candidate on them leave staged behavior unchanged is an inference from `git diff`, stated above, not a measurement.
- The exception says nothing about the image main CI builds. Production deploys the image main CI builds and tests from the released commit, a native linux/amd64 build. Neither staged image is that build: both were built for linux/amd64 under emulation on the operator's machine, from earlier commits, and the staged baseline image is a local build of the baseline commit, not the image production ran. The 2026-11 epoch's first native build showed a layering defect that its emulated builds had hidden.
- Round 1 is weaker than a matched round should be: its arms are three hours apart, its candidate arm was deployed under an override that accepted a stale application list, and its two arms ran different revisions of the stage script.
- The hosted CI run cited above is of an earlier rebase of the candidate, not of the staged candidate and not of the commit to be released.
- The canonical hosted teardown receipt of [the go-live runbook](./go-live-public-scanner.md) is unavailable for this staging deployment, as described under the teardown below.
- The staging comparison does not close the independent-egress gate, and it does not settle any open detector finding.
- The staging evidence has gaps of its own. The inputs of this record hold an identity table for round 2 and none for round 1. The round 2 criteria are dated by their own text. The times and causes of the three candidate attempts that stopped, the provisioning steps and the local and hosted qualification are per the integrator's notes and not from committed logs.

## Staging teardown

A manual teardown by the staging scripts on 2026-11-12 from 07:37 to 07:41 UTC, after the owner's decision. The owner decided against the hosted canonical teardown in the same answer.

Read before the teardown: the Worker present, the seven staging secret names, one staging container application (`a031618a-6cc8-42c5-9a27-3a5780a7ac29`, on the candidate image, with 0 live placements) and one production application, three staging image tags in the managed registry (`26b7f6b8`, `407355e0`, `bd2dc52e`), the staging bucket with no lock rule, DNS answers for the staging hostname, and 401 from an unauthenticated HTTPS request to it.

Read back after it:

- The container application reads absent ("Not Found").
- The Worker's seven secrets read absent with code 10007, the code for a Worker that does not exist.
- The registry lists no staging image tag.
- The staging bucket is still present, by design: it holds what the captures wrote until its 1-day expiry rule empties it (its analytics count read 150 objects before and after the teardown, a count that the 2026-11 record found to lag the listing in both directions). It has no lock rule.
- One readback failed. An HTTPS request to the staging hostname answered 530 (error 1016) while both of the zone's name servers gave no record for it.

A second, read-only inventory at 07:59 UTC read every item absent that the teardown removes: the Worker and its secrets absent with code 10007, no staging container application and one production application in the list, no staging image tag, no A, AAAA or CNAME answer for the staging hostname, and no HTTPS answer from it (the name no longer resolved on the operator's machine). The 530 answers eighteen minutes earlier are read as an address that machine still held, since neither name server gave a record at either time; that is a reading, not a measurement. The production bucket and the production application read present throughout.

Not done when this record was committed: the staging bucket is not empty and not deleted, and the staging R2 API token is not revoked. Both are the owner's steps or wait on the owner's readback, and this record does not claim them.

One more thing ran on the staging bucket, after round 2's comparison and before the teardown, with object commands only and no scan: a trial of an R2 bucket lock rule, from 03:55 to 03:56 UTC. With a lock rule on the `reports/` prefix (1 day), an overwrite of an existing object was refused (HTTP 409, code 10069) and the object kept its first version; a delete of it exited 0 and the object still read as before; and a new object under the locked prefix was accepted. The rule was then removed, the bucket lists no lock rule, and both trial objects read absent. The trial is no part of the A/B and changed nothing the captures read.

What this teardown is not:

- It is not the canonical twelve-resource teardown receipt from [the go-live runbook](./go-live-public-scanner.md). The owner decided for the manual scripts on 2026-11-12. A manual teardown forecloses the canonical receipt for this deployment, and the runbook refuses an all-absent rerun as retrospective evidence.
- No release or durable-activation gate is satisfied by this teardown.
- It is not complete when this record is written: the bucket and its token remain.

## Publication

Added on 2026-11-12 after the live readback. Everything above this section is as it was committed before the promotion, except the opening paragraph's last sentence and the released-commit bullet, which now name the commit.

`2d5efbe0` was the tip of `main` when its CI started, and the baseline is its ancestor. The staged candidate `d8403367` is not: the released history holds its eight commits as replayed on `cbec10be`, each equal to its original by `git range-diff`. Three commits follow the replayed candidate `a5ec3a3f`, and none changes scanner source, the Dockerfile, a dependency or a lockfile: `92115004` adds the four receipts and tests that replay them, `802d41b6` adds this record with its tests and a changelog entry, and `2d5efbe0` adds the second teardown readback to this record.

- `main` was fast-forwarded from `cbec10be` to `2d5efbe0` at 16:34:20 UTC, after a reading of `main` and `production` both at `cbec10be`, the promotion pause at 0 and no active workflow run.
- CI run [43260130270](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43260130270) at `2d5efbe0` failed on its first attempt and succeeded on its second. In attempt 1 the job Docker Runtime and Public R2 Smoke failed at the step "Build exact deployable Docker image" (17:03 UTC): inside the image build, one test of the suite failed, "real Chromium: a frame that navigates while a readout drains keeps the worker its document had at the freeze", whose wait for the frame's worker ran its 15 seconds with no worker attached. The same test passed in the Typecheck and Unit Tests job of the same attempt. Every other test job of attempt 1 succeeded, the attestation and the promotion were skipped, and nothing was published from it. The failed job was rerun with no change to the commit. In attempt 2 that job built the exact deployable image natively, passed the container security and package-evidence gates and published the image (17:06 to 17:46 UTC). The exact-SHA evidence manifests were attested at 17:46 UTC, and the job "Advance production to the tested SHA" moved `production` to `2d5efbe0` at 17:47 UTC.
- The same test failed once before in the image build of main CI and passed on a rerun, on 2026-10-30 at `069e8487`, under Chromium 153.0.8010.12, per the integrator's notes. The integrator read this failure as that one again. That is a reading. One failure and one pass of one test do not measure how often it fails under Chromium 158.0.8127.18 and Node 26, or whether that rate moved with this epoch.
- [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43265585644), the fallback, concluded failure at 17:05 UTC after attempt 1, and promoted nothing. [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43273059388) concluded success at 17:47 UTC after attempt 2, after the CI job had moved the branch. [Deploy Tested Pages](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43273047197) succeeded at 17:48 UTC and [Deploy Tested Container](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43273047594) at 17:54 UTC.
- Live readback at 17:55:01 UTC: `https://scan.sitebehavior.org/api/health` reports deployment `2d5efbe075847fec212dcefa7d3d6425ea704395`, status ok, no warnings, and `https://sitebehavior.org/deployment.json` names the same SHA. A later read of the health endpoint, at 17:56 UTC, reports the ad-block engine `adblock-rust-0.13.5` and the list manifest `25bef053…`.
- The governed Production Health lane concluded success after the container deploy finished: run [43274409596](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43274409596) (17:55 to 17:56 UTC, dispatched after the readback). An earlier run, [43273326944](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/43273326944) (17:48 to 17:50 UTC, dispatched by the Pages deploy), also concluded success, but it ended before the container deploy did; this record does not count it as attesting `2d5efbe0`.

What this publication evidence does not show:

- No production report was read for the browser version it records. That production runs Chromium 158.0.8127.18 rests on the image main CI built and tested, whose build fails unless the base's browser is that Chrome for Testing build, and on the deploy of that image. The health endpoint does not report a browser version.
- The image production runs was built once, natively, in attempt 2. The in-image suite failed one test in attempt 1 and passed in attempt 2; the image of attempt 1 was never completed or published.
- The synthetic of the health lane is one scan of the monitor's own target. It says nothing about the guardian case, about python's link search, or about any count the A/B never judged.
- No Scanner Fidelity run accompanies this publication.
- By the playbook this epoch is published without a completed A/B gate, under the owner's decision recorded above. Both rounds stay FAIL.
- The staging bucket and its token remained when this section was written.
