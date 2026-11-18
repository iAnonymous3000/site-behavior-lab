# Toolchain epoch 2027-01

The epoch record for the 2027-01 toolchain epoch (Playwright 1.65.0 to 1.65.1, bundled Chromium 158.0.8127.18 to 159.0.8154.6, tldts 7.4.16 to 7.5.4, and the container base v1.65.0-noble to v1.65.1-noble with its Node 26.13.0 to 26.13.1), kept as [the toolchain epoch playbook](./toolchain-epoch.md) asks: the commits, the version matrix, the measurement identity, the corpus-neutrality result, the exact-build staging A/B, the owner's decision and the staging teardown readback. It is the fifth epoch whose staging A/B ran, and its A/B did not pass: two matched rounds on 2026-11-17 on panel version 2 (`monthly-toolchain-canary-v2`), round 1 INCONCLUSIVE (exit 2) on three guardian metrics and round 2 FAIL (exit 1) on capture loss, also on guardian. On 2026-11-18 the owner decided to release the epoch under a recorded exception, as the 2026-11 and 2026-12 epochs were released. Round 1 stays INCONCLUSIVE and round 2 stays FAIL. They are not pooled, and nothing in this record presents either as a pass. This record was committed before production was advanced; the Publication section at its end is to be filled after the live readback.

- Production and `main` when both rounds ran: `7ad4bd5b97324b4ea1e5b8e38f34426933c9f907`.
- Baseline: `7ad4bd5b97324b4ea1e5b8e38f34426933c9f907`, the build production ran when it was staged.
- Staged candidate: `c088b0205ce6681989d9291de6dd5290bf9beb63` (6 commits on the baseline: `2125ab51`, `c8ba763d`, `339ca21f`, `46fc7872`, `7bb4a145`, `c088b020`). This is the build both A/B rounds scanned.
- Released commit: not named here. It is later than the staged candidate by the docs-only commits that add the receipts, this record and notes, and it was never staged. No commit other than `7ad4bd5b` and `c088b020` was staged or scanned: the receipts attest those two and nothing else.

## Main after the staged candidate

`main` did not move between the A/B and this record. By `git ls-remote` on 2026-11-18 at 00:59 UTC, `main` and `production` both name the baseline `7ad4bd5b`, which is the candidate's parent. The commits that follow the candidate add only docs, receipts and tests: no scanner source, no Dockerfile, no dependency and no lockfile.

The candidate was first built on `6d9ec912`, the production commit before the dependency landing, and was restacked on `7ad4bd5b` before it was staged. Against its first form it differs only by that landing's own changes (`package.json`, `package-lock.json`, `THIRD_PARTY_INVENTORY.json`, `docs/go-live-public-scanner.md`, `public/transparency-log.json`) and one count in a comment.

## Version matrix

| Input | Baseline `7ad4bd5b` | Candidate `c088b020` |
| --- | --- | --- |
| Playwright (npm `playwright` and `playwright-core`) | 1.65.0 | 1.65.1 |
| Bundled Chromium (and headless shell) | 158.0.8127.18, revision 1254 | 159.0.8154.6, revision 1255 |
| `NODE_PLAYWRIGHT_VERSION` (`lib/legacy-methodology.ts`) | 1.65.0 | 1.65.1 |
| tldts / tldts-core | 7.4.16 | 7.5.4 |
| `PUBLIC_SUFFIX_ENGINE_VERSION` (`lib/redaction-v2.ts`) | `tldts@7.4.16` | `tldts@7.5.4` |
| Container base `mcr.microsoft.com/playwright` | `v1.65.0-noble@sha256:6e3fb709…` | `v1.65.1-noble@sha256:1507cbfc…` |
| Container Node / npm (asserted by the Dockerfile) | 26.13.0 / 11.20.0 | 26.13.1 / 11.20.0 |
| Browser asserted by the Dockerfile's base stage | Google Chrome for Testing 158.0.8127.18 | Google Chrome for Testing 159.0.8154.6 |
| Ubuntu snapshot of the image's two package steps | `20261110T000000Z` | `20261116T000000Z` |
| apt and libapt-pkg6.0t64 in the runner image | 2.8.4ubuntu0.1, by the pinned upgrade | 2.8.4ubuntu0.1, shipped by the base; the pinned upgrade changes nothing |
| Container package ledger | 513 rows, package set `cde067a5…` | 513 rows, package set `f6e674e2…` |
| adblock-rust | 0.13.5 | unchanged |
| Brave Shields lists | 2026-11-16 snapshot (31 lists, manifest `b7bf174e…`) | unchanged |
| Seccomp profile | `cc3e61ca…` | unchanged |
| Canary panel | `monthly-toolchain-canary-v2`, file sha256 `20c913f5…` | unchanged |
| Wrangler (lockfile) | 4.162.0 | unchanged |
| `package-lock.json` sha256 | `5549b2f4…` | `59fe25dd…` |
| Staged image | `sha256:5372d7a0…` | `sha256:83adcc04…` |

Full digests, each recomputed for this record from the git objects or read from the comparison logs:

- `package-lock.json`: `5549b2f4bf3563a75b241e0199ca2c7f8b4534f08382f0a698b6b806f434a5ad` at `7ad4bd5b`, `59fe25dd4659a19c76f0414ee7094c2e7b620dfe37d9e24158d53e7463689e78` at `c088b020`.
- Container base index digest, as each Dockerfile names it: `6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d` to `1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579`.
- Container package ledger, `inventoryPackageSetDigest`: `cde067a50250f238572fcc922f50aacc2bcd46b7d29be99649daa319909dc673` to `f6e674e2f108f595be331519cd13bc7e7701adfa3a8eddc536ca51969696b871`.
- Staged images: baseline `sha256:5372d7a019aa63773ef207e561d05443326ab9a67ed2654d4d2cba873c7eed21`, candidate `sha256:83adcc04157867a9e4c93aa875f576b7bb2c2ba218b27214d006b82b08e54a8a`.
- Unchanged at both: `scripts/playwright-seccomp-profile.json` `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`, the Brave list manifest `b7bf174ee3b17c822dc7f6162cd9fbef6c0055dc702e067d2c2102bff1c475fd`, and `scripts/fixtures/toolchain-canary-panel.json` `20c913f51ede3e53458f3350d10e076fa5252aec04dbb9b8154d846e8b511173`.

The package ledger's rows differ between the two commits in exactly one package, the new base's own: nodejs 26.13.0 to 26.13.1 on linux/amd64. Against the previous base the runner stand-in's package list differs in thirteen versions, all shipped by the base; only nodejs moves an upstream version, so only its row moves.

Where each version came from, the dates the registries published them, and the tldts shapes the new engine moves are in [the changelog entry for this epoch](../CHANGELOG.md) and in the `SUPERSEDED_R2_NORMALIZATIONS` entry it names, which this record does not restate. Two points bear on how to read the A/B below:

- This epoch moves two measurement inputs at once: Playwright with its Chromium (and the container base that follows it), and the public-suffix engine that the sanitizer uses. The A/B compared both together and can attribute nothing to one of them.
- The scanner in the image runs Node 26.13.1, where the host and the main test jobs use Node 24.14.1. The image's own check is what runs the suite on it. No scan report records the Node version.

### Measurement identity

Of the version strings this repository records, the methodology moves in its Playwright component and the r2 normalization in its public-suffix engine. The base Node methodology, which is also the v1 methodology token and the corpus cohort key, moves from `…-adblock-rust-0.13.5-request-method-v1-playwright-1.65.0+subject-validity-v4+…` to `…-playwright-1.65.1+…`, and the r2 methodology carries the same move under its unchanged suffix. Both r2 normalizations, Node and PageGraph, move from `tldts@7.4.16` to `tldts@7.5.4` under the unchanged public-string-policy-v4 digest `3a2328d7…`. Every report records the browser version, which moves from 158.0.8127.18 to 159.0.8154.6, and the r2 condition, measurement-environment and execution fingerprints hash it. `339ca21f` closes the two outgoing producer rows (`node-v34-detectors-v27-active-lists-2026-11-16` and `node-v34-detectors-v27-active-no-adblock`) to their exact literals, freezes `pagegraph-v4-shared-worker-ended-active`, and declares `node-v35-toolchain-2027-01-active-lists-2026-11-16`, `node-v35-toolchain-2027-01-active-no-adblock` and `pagegraph-v4-tldts754-active`. No detector, registry (node-detectors-v27), obligation, catalog or list identity moves.

The outgoing normalizations join `SUPERSEDED_R2_NORMALIZATIONS` as a recorded owner exception, not as a widening, because tldts 7.5.4 removes admitted strings. Its comment carries the four parts the docblock requires:

1. The shapes that stop being fixed points: a host at an added exact rule, the apex and direct children of an added wildcard, every host under the removed TLDs helsinki and juniper, a label the older engine kept whole under a removed private rule, and the stored subject and tracker domains in those zones.
2. The committed corpus proof: no host or URL under `public/`, in an allowlist or in a catalog moves, and every committed report stays a fixed point.
3. The retention bound on the live store: the 7-day share expiry and the bucket rule `reports-retention-backstop-8d`, from the receipt recorded 2026-07-31 and the readback of 2026-09-30. That rule was NOT read back for this epoch.
4. The owner's acceptance of orphaning the stored reports that hold such a host, given on 2026-11-16 on the shape list of the step-0 measurement. The stored-position walk and its counts in the comment were measured on 2026-11-17, after that acceptance; they describe the same shapes and widen nothing.

The A/B receipts show the move end to end. All 30 baseline runs record build `7ad4bd5b`, Chromium 158.0.8127.18, a methodology naming `playwright-1.65.0` and a normalization naming `tldts@7.4.16`; all 30 candidate runs record `c088b020`, 159.0.8154.6, `playwright-1.65.1` and `tldts@7.5.4`. Every one of the 60 runs records the same detector registry (`node-detectors-v27`), the same tracker catalog, the same list manifest and the same ad-block engine (`adblock-rust-0.13.5`).

Chromium stops applying its built-in HSTS preload list 70 days after its build ([the limitations](./limitations.md#the-scan-browsers-hsts-preload-list)). By the estimate from each version tag's commit time, 158.0.8127.18 applies the list until about 2027-01-13 01:08 UTC and 159.0.8154.6 until about 2027-01-20 21:11 UTC. Both captures ran on 2026-11-17, inside both windows. The environment test that reads the list ran on 159.0.8154.6 inside the candidate's native linux/arm64 image build on 2026-11-17, before the restack, and passed; no probe ran beside the captures.

## Corpus neutrality

`npm run corpus:audit-neutrality -- snapshot` was run for this record in two separate trees, each extracted from its exact commit with `git archive` and given its own `npm ci`: the baseline `7ad4bd5b` (resolving Playwright 1.65.0 and tldts 7.4.16) and the staged candidate `c088b020` (resolving 1.65.1 and 7.5.4). Each wrote 1028 managed comparison decisions, and the two snapshots are byte-identical (sha256 `63cef2c06a262ac0d901f2b8b5e28a3f2bf7f65a88b3cf9c6fb9d240efdac746`, the digest the 2026-11 and 2026-12 records give). The compare, run from the candidate tree, prints "Corpus neutrality unchanged across 1028 managed comparison reports." and exits 0. Both installs ran from the local npm cache with the network off and with install scripts off (`npm ci --offline --ignore-scripts`), which the playbook's commands do not ask for. `npm run reports:remediate -- --check` reports all 1029 committed reports and sidecars current under each engine.

Qualification outside staging, from the builder's logs. The candidate's first form (`62ee9270`, on `6d9ec912`) was built natively for linux/arm64 with the Dockerfile's own `npm run check`: 21 test stages, none failed, on Chromium 159.0.8154.6 and Node 26.13.1. That build is of the first form, not of the staged candidate and not of the commit to be released. The inputs of this record hold no hosted CI run of the candidate.

## Staging A/B

### Provisioning

The takeover session provisioned staging on 2026-11-17 from a clean clone of the baseline, per its provisioning record: the collision preflight (Worker absent with code 10007, no staging container application and no staging image tag, no A, AAAA or CNAME record for `scan-staging.sitebehavior.org`), the existing staging bucket `site-behavior-lab-reports-staging` adopted with its lifecycle rule `durable-replay-staging-cleanup` (expire after 1 day, abort incomplete multipart uploads after 1 day) and no lock rule, a new bucket-scoped R2 API token created by the owner after the previous epoch's token was deleted, and the seven staging secrets read back by name only.

### Deviations

Each of these departs from the playbook or the runbook, and each is stated here so that a reader can weigh the rounds with it.

- The R2 key values of the staging token went through a chat: the owner pasted them there when the token was created. The key was treated as exposed from then. The owner chose to use it for the session rather than replace it first, and revokes it after the session; its revocation is recorded with the bucket step, which this record does not yet include.
- The account-name field of Wrangler's identity check was not printed.
- No capture-only retry was used, and no arm was rerun.
- Round 1's two captures are about 70 minutes apart: the baseline's scans started between 20:45 and 20:49 UTC and the candidate's between 21:55 and 21:59 UTC. Round 2's are about 8 minutes apart.

### Builds and panel

| | Baseline | Candidate |
| --- | --- | --- |
| Build | `7ad4bd5b` | `c088b020` |
| Image | `sha256:5372d7a019aa63773ef207e561d05443326ab9a67ed2654d4d2cba873c7eed21` | `sha256:83adcc04157867a9e4c93aa875f576b7bb2c2ba218b27214d006b82b08e54a8a` |
| Built | by the round 1 staging deploy; the round 2 deploy reproduced the same digest and pushed nothing | the same |
| Node in the image | v26.13.0, equal to the Dockerfile's assertion | v26.13.1, equal to the Dockerfile's assertion |
| Browser in the image | Google Chrome for Testing 158.0.8127.18, equal to the Dockerfile's assertion | Google Chrome for Testing 159.0.8154.6, equal to the Dockerfile's assertion |
| Wrangler that deployed it | 4.162.0 | 4.162.0 |

Both rounds' identity tables record each arm's commit, tree, base image, image digest, the image's Node and browser against the Dockerfile's assertions, the Worker version, and that the image's runtime user can read the application files. Round 2's table also records that each arm's build reproduced its digest from round 1 and that the registry held it already.

All four captures ran against the committed panel `monthly-toolchain-canary-v2` (`scripts/fixtures/toolchain-canary-panel.json`: wikipedia, github, python, ssa-gov, guardian; 3 repetitions; desktop, GPC on, consent observe; panel digest `51f0ebcb7997559738a8891256a10d25d5783730b1b6238f8d3ec478682df376`). Every one of the 60 receipted runs records egress `WNAM/pdx03/US` and run outcome complete with HTTP 200. The 30 baseline runs record Chromium 158.0.8127.18 and the 30 candidate runs 159.0.8154.6.

| | Round 1 baseline | Round 1 candidate | Round 2 baseline | Round 2 candidate |
| --- | --- | --- | --- | --- |
| Order | forward | reverse | forward | reverse |
| Runs | 15 | 15 | 15 | 15 |
| First to last scan start (UTC) | 20:45:10 to 20:48:44 | 21:55:43 to 21:59:33 | 22:05:05 to 22:09:18 | 22:13:41 to 22:20:59 |
| Receipt created (UTC) | 20:49:03 | 21:59:44 | 22:09:37 | 22:21:12 |
| Receipt | `round-1-baseline-receipt.json` | `round-1-candidate-receipt.json` | `round-2-baseline-receipt.json` | `round-2-candidate-receipt.json` |
| Receipt sha256 | `53f58dc008b5106bf8cf4ee9643d3cfa8fd9aa4a07149f1211751d94adce95f9` | `22adc03a65050dc42ee0398f81dd27c77bf3bc4c9ad843fe89094d1c1e6f3096` | `bf376323c2745c6549cf08f9a8a41fb1ee982a2b88d3ef17cd2c5edb80f80e83` | `2c2e7a641f1e3f0e1ea0ddd755ccdcc9ba3a9bd829092fed05f4ab2c4397859a` |

The four receipts are committed byte for byte beside this record in [`toolchain-epoch-2027-01/`](./toolchain-epoch-2027-01/), and each sha256 above equals the digest the comparison log of its round recorded when the comparison ran. Each carries the exact staging report IDs of its 15 runs. Their key set is the key set of the committed 2026-12 receipts, and they hold no token, no account identifier and no local path.

### Round 1: INCONCLUSIVE

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2027-01/round-1-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2027-01/round-1-candidate-receipt.json
```

Result recorded on 2026-11-17 at 21:59 UTC, from a clean checkout of the staged candidate (the comparison log, exit 2):

```text
RULE median-with-within-arm-spread-v2
NOTED github: detector-output/truncated/keystroke-probe-capture capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED guardian: detector-output/dropped/consent-banner capture loss on 2 of 3 baseline and 1 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
NOTED guardian: detector-output/dropped/policy-visit capture loss on 3 of 3 baseline and 3 of 3 candidate runs; recorded, not compared: its family feeds no canary metric
INCONCLUSIVE guardian.knownTrackerRequests: baseline runs 16, 16, 16 (spread 0), candidate runs 27, 16, 16 (spread 11), tolerance 4.8; the page varied within one build by more than the tolerance, so medians 16 -> 16 say nothing about the toolchain for this metric
INCONCLUSIVE guardian.thirdPartyDomains: baseline runs 25, 25, 25 (spread 0), candidate runs 34, 26, 26 (spread 8), tolerance 6.25; the page varied within one build by more than the tolerance, so medians 25 -> 26 say nothing about the toolchain for this metric
INCONCLUSIVE guardian.shieldsBlockedRequests: baseline runs 48, 47, 47 (spread 1), candidate runs 77, 48, 49 (spread 29), tolerance 14.1; the page varied within one build by more than the tolerance, so medians 47 -> 49 say nothing about the toolchain for this metric
INCONCLUSIVE 7ad4bd5b97324b4ea1e5b8e38f34426933c9f907 -> c088b0205ce6681989d9291de6dd5290bf9beb63: not a pass. No compared fixed-panel median failed, but for 3 of 45 the page varied within one build by more than the tolerance, so the comparison says nothing about the toolchain for guardian.knownTrackerRequests, guardian.thirdPartyDomains, guardian.shieldsBlockedRequests. The release decision has to record each inconclusive metric by name with its values above.
```

The `RULE` and `NOTED` lines are what the command prints on stdout and the `INCONCLUSIVE` lines what it prints on stderr; they are shown here in the order of the round's console log. That result stands as recorded. It reproduces: run for this record from the checkout this record was committed on, on the two committed files, the command prints those lines and exits 2.

What the lines mean. No compared median failed. For three of guardian's metrics one candidate run (repetition 1) counted far more than the other two, so the within-arm spread exceeded the tolerance and the medians cannot speak for the toolchain: known-tracker requests 27 against 16 and 16, third-party domains 34 against 26 and 26, Shields-blocked requests 77 against 48 and 49. The baseline's three guardian runs varied by at most one in each. The other 42 compared medians are within tolerance. Three capture losses were noted and not compared, because their families feed no canary metric: github's keystroke-probe truncation and guardian's dropped policy visit on every run of both builds, and guardian's dropped consent-banner probe on two baseline runs and one candidate run.

### Round 2: FAIL

The playbook asks for one matched re-run after an inconclusive or failed round. Its criteria were written before any round 2 capture, at 22:00:40 UTC by the file's own statement (round 2 started at 22:00:54 UTC). The criteria file fixed: round 1 stands as recorded, exit 2, INCONCLUSIVE, with each of its three metrics named with its values; round 2 deploys round 1's two images, frozen by digest, and an arm whose build is another image stops before its capture; the same panel, order, rule and tolerances, with nothing relaxed, no case dropped and no panel edit; both rounds reported separately and in full, not pooled, and round 2 neither overrules nor averages round 1; exit 0, 1 or 2 read as the playbook reads them; and, whatever the result, no further round, with the release needing the owner's recorded decision on the two rounds as they stand. It also recorded its preconditions: the same configured egress region in both arms' health replies, and every panel subject scanned in both round 1 arms. The file is in the epoch working directory, not committed (sha256 of the copy read for this record: `d2d34cf31b4deac3f886d8cf5318005e1ab285efaf86ad1f98263b39ccfd34f2`).

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2027-01/round-2-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2027-01/round-2-candidate-receipt.json
```

Result recorded on 2026-11-17 at 22:21 UTC, from a clean checkout of the staged candidate (the comparison log, exit 1):

```text
FAIL Capture loss detector-output/dropped/consent-banner differs systematically between the builds on guardian: 0 of 3 baseline runs vs 2 of 3 candidate runs.
```

That result stands as recorded, and it reproduces the same way: from the checkout this record was committed on, on the two committed files, the command prints that line and exits 1. It prints no `RULE` line, because a comparison that is refused on capture loss judges no median.

What the line means. Detector output feeds no canary metric, so a loss in it fails the comparison only when it differs systematically between the builds: more than half of one build's runs of a site carry it and none of the other build's do. Two of the three candidate guardian runs record that the consent-banner probe was dropped, and none of the three baseline runs does.

What the receipts hold beside it, which the command did not judge, because it stopped there and before every median:

- On wikipedia and python all six runs of the round record the same counts. On github one candidate run records 2 Shields-blocked requests where the other five record 1, and one baseline run 117 requests where the other five record 116. On ssa-gov one candidate run records 76 requests where the other five record 75.
- Guardian's baseline runs record 171, 191 and 171 requests, 16, 26 and 16 known-tracker requests and 48, 71 and 48 Shields-blocked requests. Its candidate runs record 193, 173 and 172 requests, 26, 16 and 16 known-tracker requests and 73, 48 and 48 Shields-blocked requests. Each build has one high guardian run.
- github's keystroke-probe truncation and guardian's dropped policy visit are again on every run of both builds.

Those counts are what the receipts record. No median of them was compared in round 2, so this record gives none of them as within tolerance, outside it or inconclusive.

### The consent-banner probe on guardian

Read for the diagnosis from the twelve guardian staging reports of both rounds, before the teardown, and agreeing with the committed receipts, the consent-banner detector ended partial with the reason `scan-failed` on these runs:

| Run | Round 1 baseline | Round 1 candidate | Round 2 baseline | Round 2 candidate |
| --- | --- | --- | --- | --- |
| Repetition 1 | complete | complete | complete | complete |
| Repetition 2 | partial, scan-failed | partial, scan-failed | complete | partial, scan-failed |
| Repetition 3 | partial, scan-failed | complete | complete | partial, scan-failed |
| Browser | 158.0.8127.18 | 159.0.8154.6 | 158.0.8127.18 | 159.0.8154.6 |

The same failure occurs in both builds: on 2 of 6 baseline runs, under the browser production runs, and on 3 of 6 candidate runs. It never occurs on the first repetition of a capture in either build. Round 2's FAIL is a split of 0 against 2 within one round of a failure the production browser also shows, and that showed 2 against 1 in round 1. This is evidence that the cause is on the guardian page's side, not proof of it. The consent family feeds no canary metric.

### The owner's decision

On 2026-11-18, in the takeover session, the owner was asked: "Confirm: release the browser update under a recorded exception from 09:00 UTC today?" The owner answered, in their words: "Yes, release it".

This is an exception to the playbook itself. The playbook names the owner's recorded decision as the way forward for an inconclusive comparison (exit 2), with each inconclusive metric recorded by name: those are guardian.knownTrackerRequests, guardian.thirdPartyDomains and guardian.shieldsBlockedRequests, with their values quoted under round 1. It reads exit 1 as a failed A/B and the epoch as not complete. Round 2 exits 1. The release rests on the owner's decision and not on a completed gate.

What the evidence shows about the two comparisons (the recorded decision states no reasons):

- No compared median failed in round 1. Its three inconclusive metrics come from one candidate guardian run.
- Round 2 was refused on a consent-banner loss that the production browser's runs also carry, in 2 of 6 runs across the two rounds.
- The scanner source that produces the consent result is the same in both builds, by `git diff`. The browser, the public-suffix engine and the container's Node are not.
- Every run of both builds completed with HTTP 200, in the same egress region.
- The committed corpus exposes the same 1028 comparison decisions at the baseline and at the staged candidate.

What the exception does not establish, and what was never staged:

- The A/B did not pass. Round 1 is recorded INCONCLUSIVE and round 2 FAIL by the gate that ran, under panel version 2 and the comparison rule `median-with-within-arm-spread-v2`, and they stay so. By the playbook the epoch is not complete.
- It is not established that the two browsers measure alike. Round 1 judged 42 medians within tolerance and could judge three guardian metrics not at all; round 2 judged no median.
- It is not established that the new public-suffix engine or the container's Node 26.13.1 changes nothing the canary measures. The A/B moved them with the browser and judged none of them alone.
- It is not established why the consent-banner probe fails on some guardian visits, or that the rate is the same under both browsers.
- The exception says nothing about any commit after the staged candidate. The commit to be released follows it by docs-only commits and was never staged.
- The exception says nothing about the image main CI builds. Production deploys the image main CI builds and tests from the released commit, a native linux/amd64 build. Neither staged image is that build: both were built on the operator's machine from the staged commits.
- The staging comparison does not close the independent-egress gate, and it does not settle any open detector finding.

## Staging teardown

The compute teardown ran by the staging scripts on 2026-11-17 after round 2, with readbacks before and after.

Read before the teardown: the Worker present, the seven staging secret names, one staging container application (`a0368f11-9835-4d25-ba83-129108775e92`, on the candidate image, with 1 live placement) and one production application, two staging image tags in the managed registry (`364b783d`, `49d4fbea`), the staging bucket with no lock rule (its count read 90 objects), DNS answers for the staging hostname, and 401 from an unauthenticated HTTPS request to it.

Read back after it, and again in a read-only inventory:

- The container application reads absent ("Not Found").
- The Worker and its secrets read absent with code 10007, the code for a Worker that does not exist.
- The registry lists no staging image tag.
- No A, AAAA or CNAME answer for the staging hostname, and no HTTPS answer from it.
- The production bucket and the production application read present throughout.
- The staging bucket is still present, by design, with no lock rule; its count read 90 objects before and after.

Not done when this record was committed: the bucket step. The staging bucket is not emptied or deleted, and this record does not claim it. It is to be added here when it is done.

## The investigation runner's lag

The investigation runner does not move with this epoch. It stays at Playwright 1.65.0: its S5c fixture image installs the packages of its own steps lock (`investigation/runner/s5/steps/package-lock-1.65.0.json`: playwright and playwright-core 1.65.0, tldts and tldts-core 7.4.16, undici 8.12.3), and its steps guard (`investigation/runner/s5/steps/check-and-transpile.cjs`) refuses to build that image while the commit's `package-lock.json` holds another version, resolved URL or integrity for any of those packages. The repository lock has differed in undici since `6d9ec912` (8.12.4), and with this epoch it also differs in Playwright (1.65.1) and tldts (7.5.4). So the S5c fixture image does not build at the commit to be released until the runner's steps move; S5f is the step that moves them.

## Publication

To be filled after the live readback.
