# Toolchain epoch 2026-10

The epoch record for issue #9, kept as [the toolchain epoch playbook](./toolchain-epoch.md) asks: the version matrix, the corpus-neutrality result, the exact-build staging A/B, the staging teardown readback, and the publication evidence. It is the second epoch whose staging A/B ran, and the first whose A/B failed under its gate: twice, each time on a detector-output capture-loss signature that no canary metric is counted from. The owner published under a recorded exception to that gate, dated below. The gate, its tolerances and the panel are unchanged.

- Baseline: `f9d6c46e744c60a3485eba3951f0b168b9170941` (main and production when the candidate was built)
- Staged candidate: `34d6847b54d804c449bed160a53129ca2e1f16ef` (9 commits on the baseline: `c3baccce`, `9eaa43ab`, `10800c0d`, `a96b9760`, `2e01c95b`, `3aee3c7f`, `15175c88`, `84e37b33`, `34d6847b`). This is the build both A/B rounds scanned. It was pushed to `main` as a fast-forward from the baseline on 2026-09-30 after the staging teardown, with `origin/main` re-read as the baseline immediately before.
- Published commit: `5d908f89f9a7054b2e3d5074a08e523ba2fa3ab4` ("Upgrade the runtime image's OpenSSL past CVE-2026-84782"), two commits on the staged candidate: `4dfd0ca13affba7f39f1b3eb06c7325a2dabb16f` ("Patch the dev-only brace-expansion and fast-uri advisories") and `5d908f89`. Neither was staged or scanned; the receipts attest `34d6847b`.

## The published commit

Main CI for `34d6847b` (run [36740225476](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36740225476), started 2026-09-30 15:54 UTC) concluded failure: two jobs failed, and the exact-SHA attestation and the production promotion were skipped. The typecheck, unit-test, build and Chromium smoke jobs succeeded.

- The Supply-chain Security job failed at the step "Enforce all supply-chain security gates" with the annotation "npm audit finished with failure". That gate audits the whole lockfile at `--audit-level=low` against the live registry, and four advisories published in the GitHub advisory database on 2026-09-29 (UTC, between 23:44 and 23:54: after the baseline's own main CI run at 19:10 UTC that day and before this run) cover two development-only packages in the lock: brace-expansion below 5.0.12 (GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p, high; GHSA-q2hr-2g5m-vwhr, moderate; those three are every advisory that names 5.0.9) and fast-uri below 3.1.8 (GHSA-hrr3-gc8f-f4qj, moderate). `4dfd0ca1`'s commit message dates them 2026-09-30, the day the gate first failed on them. `4dfd0ca1` (committed 15:57 UTC) moves the `package.json` override for brace-expansion from 5.0.9 to 5.0.12, lets the lock resolve fast-uri 3.1.8 inside ajv's existing range, regenerates `THIRD_PARTY_INVENTORY.json`, syncs `THIRD_PARTY_REVIEWS.json` (two rows replaced) and restores the lock root's `packageManager` entry. It touches those four files and nothing else. Its CI run ([36740701743](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36740701743)) passed that job.
- The Docker Runtime and Public R2 Smoke job built and smoke-tested the exact deployable image, ran Trivy v0.70.0 over it for HIGH and CRITICAL vulnerabilities (the scan step is `continue-on-error` and concluded success), and failed at the step "Enforce container security and package-evidence gates", which reads the scan step's outcome, with the annotation "Trivy image scan finished with failure". The scan read two targets: the image's 512 Ubuntu packages (the log's detection line counts 511; the inventory step that follows records 512) and one language-specific target of type `node-pkg`, the 44 installed `package.json` files of the pruned runtime tree (`app/package.json` and 43 under `app/node_modules`, tldts 7.4.16 among them). An image scan does not parse `package-lock.json`; the copied lock is not a target. It failed the same way on `4dfd0ca1`'s run, with the audit gate passing, so the image-scan failure was not the lockfile advisories. The scan's findings are in each run's preserved container-security artifact (`container-security-<sha>`), not in its log. The `34d6847b` artifact's only findings are two HIGH rows, both CVE-2026-84782 (OpenSSL, published 2026-09-29T16:17Z), in the pinned base's libssl3t64 and openssl 3.0.13-0ubuntu3.15, fixed in 3.0.13-0ubuntu3.16; the language-specific target has none. That finding sits in the base image every build on the pinned digest shares, so the scan would refuse a rebuild of the baseline `f9d6c46e` as well; it is not an input of this epoch. `5d908f89` (committed 16:19 UTC) changes the Dockerfile and nothing else: the runner stage's existing purge step now first runs `apt-get update` and upgrades exactly those two packages to 3.0.13-0ubuntu3.16 (`--only-upgrade`, no recommends), then purges the GStreamer plugins as before and cleans apt's cache and lists. A linux/amd64 runner-stage stand-in on the pinned base recorded "2 upgraded, 0 newly installed, 0 to remove and 57 not upgraded", unpacking each package's 3.0.13-0ubuntu3.16 over 3.0.13-0ubuntu3.15. The commit records, from `ldd` in the built image, that neither `/usr/bin/node` nor the bundled Chromium links the system libssl or libcrypto, so the scanner's TLS stacks do not change; this record has not repeated that readback. The container package ledger keys packages by upstream version and its evidence excludes the Ubuntu revision, so it is unchanged, as the playbook says of a revision-only update; CI's image scan is the gate that sees such a change. The pin is to be dropped once a base digest ships the fix.

The staged image was built from `34d6847b`; the published one is built from `5d908f89`. The staging A/B did not exercise the published image, nor `4dfd0ca1`'s: the receipts attest `34d6847b`, and the published SHA is attested by the publication evidence at the end of this record, not by the receipts. Main CI for `5d908f89` is run [36743389278](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36743389278) (started 16:19 UTC); its conclusion, the image it published, the promotion and the live readback are the Publication section's evidence. What differs between the staged image and the published one:

- `package.json` and `package-lock.json`, which the runner stage copies. CI's image scan does not read the lock: its one language-specific target is the installed `package.json` files of the pruned runtime tree, which name neither patched package, so `4dfd0ca1`'s rows were visible to the audit gate and never to the container gate. Both patched packages are `dev: true` in the lock (brace-expansion under ts-json-schema-generator's glob and minimatch, fast-uri under ajv). The build stage runs `npm run check` and then `npm prune --omit=dev`, and the runner stage copies that pruned `node_modules`: the 75 lock entries not marked development-only are the same 75 at `34d6847b` and at `5d908f89`, by name, version and integrity, and the 92 development entries differ by exactly the two patched rows. The lock is unchanged between `4dfd0ca1` and `5d908f89`.
- The Ubuntu revision of libssl3t64 and openssl in the runner image, 3.0.13-0ubuntu3.15 to 3.0.13-0ubuntu3.16.
- The `org.opencontainers.image.revision` label and `SITE_BEHAVIOR_LAB_BUILD_COMMIT`, which carry the SHA, and the build stage's own tool tree, where the two patched npm packages live, whose `next build` output is not byte-reproducible between builds in any case (build ids and generation timestamps).

Everything else is the same: every scanner source file, the vendored WASM and its contract, the identity tables, the pruned runtime `node_modules`, the base digest, Node and npm, Chromium, the list snapshot and the seccomp profile. No recorded identity names any of the three differences, so no measurement identity moves.

## Version matrix

| Input | Baseline | Candidate |
| --- | --- | --- |
| Playwright (npm `playwright`) | 1.63.0 | unchanged |
| Bundled Chromium | 153.0.8010.12 | unchanged; Chromium 154 waits for Playwright 1.64 to reach a stable release |
| Container base `mcr.microsoft.com/playwright` | `v1.63.0-noble@sha256:eff16c30…` | unchanged |
| Container Node / npm | 24.20.0 / 11.19.0 | unchanged |
| Seccomp profile | `cc3e61ca…` | unchanged |
| Container package ledger | unchanged (the base image did not move) | unchanged |
| adblock-rust (Cargo.lock) | 0.13.3 | unchanged |
| wasm-bindgen (Cargo.lock; `-macro`, `-macro-support` and `-shared` move with it) | 0.2.126 | 0.2.129, with syn 3.0.6 added beside syn 2.0.118 as a proc-macro dependency |
| `tools/adblock-wasm/Cargo.lock` sha256 | `c745cfc6…` (69 packages) | `106c9724…` (70) |
| Vendored `sbl_adblock_wasm_bg.wasm` | `4034076e…`, 2,006,098 bytes | `7dda4b30…`, 2,005,939 bytes |
| Vendored `sbl_adblock_wasm.js` | `4046ec7a…`, 6,366 bytes | `7021d2c9…`, 6,366 bytes |
| Vendored `sbl_adblock_wasm.d.ts` | `0d808eb1…`, 1,024 bytes | `919759b3…`, 1,024 bytes |
| Vendored `sbl_adblock_wasm_bg.wasm.d.ts` | `91f718d4…`, 751 bytes | unchanged |
| WASM `producers` section (processed-by) | rustc 1.96.1 (31fca3adb), walrus 0.26.4, wasm-bindgen 0.2.126 | rustc 1.96.1 (31fca3adb), walrus 0.27.2, wasm-bindgen 0.2.129 |
| tldts / tldts-core | 7.4.13 | 7.4.16 |
| Public-suffix trie | 10,784 rules | 10,793 rules |
| Brave Shields lists | 2026-09-28 snapshot (31 lists, manifest `2e8c9278…`) | unchanged |
| `package-lock.json` sha256 | `62bad24c…` | `0f2623cc…`; `02edcaa2…` at `4dfd0ca1` and at the published `5d908f89` |

Full digests, each recomputed for this record from the git objects:

- `package-lock.json`: `62bad24cb4e37613e30ce93204a9d0744178a33a2ebe6b5408e88deb5035c961` at `f9d6c46e`, `0f2623cc0c4e0b6dd7d25a85a5a285bc25d287279689daa5fc55cd1bbb146eca` at `34d6847b`, `02edcaa2da0603a82d79b6e055d4935b31b72aba5b4e10b70d91f8d77d3aa0f5` at `4dfd0ca1` and at `5d908f89`.
- `lib/adblock-wasm/sbl_adblock_wasm_bg.wasm`: `4034076ed79f1b8aa7c023c03ec87b7c3c84ae01c447097d4d9650b93a4a1082` to `7dda4b30ce6d4cc9fb9722b6763cfade690f85ff5f2d8a4bdb992fdae6d1d3cc`.
- `lib/adblock-wasm/sbl_adblock_wasm.js`: `4046ec7a1a85b7d608bc8495460428c3981ecd117501cb87bb80b5dcedea71ed` to `7021d2c92dc55bf0347e3a465f17313e1f9590ebe06a989aa95d50f383a9cc31`.
- `lib/adblock-wasm/sbl_adblock_wasm.d.ts`: `0d808eb178fd591cd4702e9ec549683ff9713c866f34b3c464f195a9fb615603` to `919759b3a73fc490df296a07b1685273e5c2d298c315ab6996480007de246885`.
- `lib/adblock-wasm/sbl_adblock_wasm_bg.wasm.d.ts`: `91f718d4028beabfc116fc092221c640f25cc69584479999357f785cb5cd1412` at both.
- `tools/adblock-wasm/Cargo.lock`: `c745cfc603b1f621238abda26953f56219fa711e0c23b8960c3f82e79fcbdb6e` to `106c97247df0f699510239c5db330d513d09832a9206eaecf54ef54bc5beff35`.
- Container base index digest: `eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`. Brave list manifest: `2e8c9278c65ff2872c7cefacf0ea485dba9c93bab01bdd954aeddabe49d49668`.

tldts 7.4.16 was the registry's latest at the cut (published 2026-09-27); 7.4.14 (published 2026-09-21) and 7.4.15 (2026-09-23) passed over. tldts-core 7.4.16 differs from 7.4.13 only in how its boolean expressions are parenthesized, in comments, and in the CommonJS interop helpers its compiler emits; tldts changes only its suffix trie. Counting root-to-rule paths in the installed packages' flat tries gives 10,784 rules (10,776 plus 8 exceptions) and 10,793 (10,785 plus 8): 11 private rules added, two of them wildcards (`*.azure.databricksapps.com`, `*.compute.herokuapp.com`) and nine exact (`aws.databricksapps.com`, `gcp.databricksapps.com`, `aws-gov.databricksapps.us`, `glideos.app`, `hosted-by-files.com`, `iqhs.pl`, `site.hosting-cluster.nl`, `site.webhosting.be`, `surge.sh`), and 2 private rules removed (`alpha-myqnapcloud.com`, `dev-myqnapcloud.com`); no ICANN rule and no rule's section changes.

### The WASM build and its reproducibility

The vendored set was built with rustc 1.96.1 (`31fca3adb`), cargo 1.96.1, wasm-pack 0.14.0, the wasm-bindgen CLI 0.2.129 and the cached wasm-opt 117 (`bin/wasm-opt` `e541f303219f9b6caa1661daea44510249da278736b7f2e320910051e7bbd4cd`, `lib/libbinaryen.dylib` `9dc88d02f1aa84de40a8e8dbe5f3a023a8b5bcafaf1308ae20926ab425c533fb`), with no wasm-opt or wasm-bindgen on `PATH`. This epoch was the first to move the wasm-bindgen pin under the playbook, so the cached CLI for 0.2.129 did not exist: wasm-pack installed it itself through one normal-mode build (`cargo install wasm-bindgen-cli` at exactly 0.2.129, unlocked, which resolved walrus 0.27.2 on the day of the install; cached binary `3f2fa9bd9d477a5aa9352a2b2d94cc21ce9ffb60546732ae27d9b8382801c20f`). That build's output was discarded; the copied set came from a later `--mode no-install` build from a clean target, and a second clean build compared equal to it before anything was copied (commit `9eaa43ab`). The integrator's own clean build from an empty target, on a separate checkout, compiled every crate again (its log shows "Installing wasm-bindgen...", "Optimizing wasm binaries with `wasm-opt`" and no "found wasm-opt at") and, per the integrator's notes, matched all four vendored files byte for byte; that log is in the epoch working directory, not committed. The playbook gained the cache-population step for a moved pin (`15175c88`).

The 0.2.129 CLI no longer embeds its crate's source path in the binary, so the reproducibility contract moved its marker from that path to the binary's `producers` custom section, which the CLI writes itself. Reading that section from the committed binaries gives walrus 0.26.4 and wasm-bindgen 0.2.126 at the baseline and walrus 0.27.2 and wasm-bindgen 0.2.129 at the candidate, rustc 1.96.1 (`31fca3adb`) at both. `npm run wasm:verify-reproducibility` on the committed set prints "WASM integrity contract OK: 3 source inputs and 4 vendored outputs are hash-bound; reproducible build remains explicitly blocked." The contract's blockers, activation criteria and status are unchanged.

The engine differential between the old and new WASM over the committed list snapshot (107,388 hosts, two sources, four resource types, GET and POST: 1,718,208 tuples, plus 12 synthetic control tuples) found no changed block decision; the CHANGELOG entry for this epoch records it.

### Measurement identity

Of everything a report records, only the r2 normalization moves: its public-suffix component, `tldts@7.4.13` to `tldts@7.4.16`, for the Node and PageGraph observers alike, under the unchanged public-string-policy-v4 digest `344fdfdf…1563`. The v1 methodology token, the reviewed corpus line, the r2 methodology, the detector registry (node-detectors-v12), the obligations, the policy digest, the September 28 list identity and the disclosed engine version (`adblock-rust-0.13.3`) are unchanged; no identity names wasm-bindgen or the WASM bytes. The deployed producer rows `node-v16-detectors-v12-active-lists-2026-09-28` and `node-v16-detectors-v12-active-no-adblock` are closed to their exact literals (the v15 methodology, the `344fdfdf` normalization under tldts 7.4.13, frozen node-detectors-v12 fields and a frozen copy of the September 28 lists under adblock-rust 0.13.3), and `pagegraph-v4-storage-snapshot-active` to its `344fdfdf` normalization under tldts 7.4.13 and the 2026.08 catalog. The new active rows are `node-v17-toolchain-2026-10-active-lists-2026-09-28`, `node-v17-toolchain-2026-10-active-no-adblock` and `pagegraph-v4-tldts7416-active`. The A/B receipts show the move end to end: all 30 baseline runs record build `f9d6c46e` and `tldts@7.4.13`, all 30 candidate runs record `34d6847b` and `tldts@7.4.16`, with the same methodology, registry, engine version and list manifest on every run.

The outgoing tldts 7.4.13 normalization stays accepted as the recorded owner exception in `SUPERSEDED_R2_NORMALIZATIONS` (`lib/scan-report-v2-normalization.ts`), the Node one paired with the v15 methodology both v16 rows ran. The entry carries the complete set of shapes that stop being fixed points, the committed-corpus proof (every report, sidecar and tracked text file parses and redacts identically under both engines, none in a changed zone, so no committed report is affected), and the measured exposure over 117 synthetic probes: 19 of 117 published host strings, 67 of 115 stored subject keys, 78 of 115 request tracker domains and 78 of 115 cloak tracker domains stop being fixed points. Exposure on the live store is bounded to reports saved in the 8 days before the deploy: the production bucket's lifecycle was read back with wrangler 4.140.0 on 2026-09-30T02:40:08Z, `reports-retention-backstop-8d` enabled on the `reports/` prefix, expiring objects after 8 days, beside the default 7-day multipart abort rule and `v2-shadow-expire-1d` (commit `34d6847b` cites that readback). Publishing the candidate is the owner's acceptance of orphaning those reports instead of remediating them; the push dated below is that act.

## Corpus neutrality

`npm run corpus:audit-neutrality -- snapshot` ran in two separate checkouts, each with its own `npm ci`: the baseline at `f9d6c46e` (resolving tldts 7.4.13) and the candidate at `15175c88` (resolving 7.4.16; the two commits after it touch documentation, tests and the normalization docblock, no runtime source). Each wrote 1028 managed comparison decisions, and the two snapshots are byte-identical (`917f947e6fc3b9bd3997107bf136596c8a3f563bb62618cfea1252490ed00f64`). The compare, re-run for this record from the `5d908f89` checkout on the two snapshot files, prints "Corpus neutrality unchanged across 1028 managed comparison reports."

Local gates on the candidate: every typecheck and unit lane passed at `15175c88`. The final `next build` inside `npm run check` requires `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` (without it the build stops at "Failed to collect page data for /_not-found"); with it, `build`, `build:pages` and `test:smoke:static` passed, and, per the integrator's notes rather than a committed diff, the published `out/` equals the baseline's except for the deployment SHA, generation timestamps, build ids and RSC row renumbering on four category pages. The in-image `npm run check` passed in both emulated amd64 staging image builds.

## Staging A/B

### Provisioning and the R2 credential incident

The operator provisioned staging on 2026-09-30 between 02:24 and 02:37 UTC, at `f9d6c46e` with wrangler 4.140.0, as [the go-live runbook](./go-live-public-scanner.md) describes: the same-session collision preflight (Worker absent with code 10007, bucket absent with 10006, no DNS answers for `scan-staging.sitebehavior.org`, no staging application in the complete Containers inventory), the staging-only bucket `site-behavior-lab-reports-staging` with the lifecycle rule `durable-replay-staging-cleanup` (all prefixes, expire after 1 day, abort multipart uploads after 1 day), the bucket-scoped R2 API token `sbl-staging-toolchain-canary-2026-10` (Object Read & Write on that bucket only; ID `c715549020539b160abadf1a6202228d`), the seven staging secrets read back by name only, and the draft Worker `site-behavior-lab-scanner-staging`. The operator deployed nothing and ran no canary.

After the first baseline deploy, authenticated staging health read degraded with the warning "The report store retention maintenance check failed (malformed-response)": the first token's Access Key ID had been stored at the wrong length. The diagnosis read no secret. The report store classifies a failure from the HTTP status on the error value and never from its message (`lib/report-store-failure-reason.ts`): 401 and 403 are `unauthorized`, 5xx, 408 and 429 `unreachable`, 404 `misconfigured`, and any other status, 400 included, `malformed-response`. The integrator's notes record that a probe of the R2 S3 endpoint with fabricated credentials returned HTTP 400 InvalidArgument ("Credential access key has length 40/64, should be 32") for a key id of the wrong length and 401 for a 32-character wrong key, which is exactly the `malformed-response` and `unauthorized` split, so the warning named a wrong-length key id and not a wrong key. That probe is the notes' observation, not a committed artifact. The operator created a replacement token (ID `e5962ea411f4730cba135338c4d207c5`, per the notes) and re-entered both keys. A running container keeps the environment it started with, so each secret change was applied by deleting the staging container application and redeploying the same baseline image: the deploy logs show three baseline deploys each creating a new application (`a0319118…` at about 03:17 UTC, `a03599ee…` at about 03:45, `a03e7dc0-d368-4e94-8b53-26c3a435e3f8` at about 15:05) and every later deploy editing `a03e7dc0`, which served all four captures. Staging health then read ok, no warnings, at the exact SHA; the canary verifies that before and after every capture and fails closed otherwise.

### Builds and panel

| | Baseline | Candidate |
| --- | --- | --- |
| Build | `f9d6c46e` | `34d6847b` |
| Image | `sha256:2b07c6eeafb14b11a653a20af38542290004772786706fa6d6c7fbac3269e686` (registry tag `082e3045`) | `sha256:f4e225370c48ccbed936dc57869b68f52e62c597ddfa86572a6e9a409e6b3753` (registry tag `df833e20`) |
| Built | by the staging deploy wrapper; all four baseline deploys exported this same manifest digest | prebuilt locally with the exact build arguments; both candidate deploys exported this same digest |

Both images were built through the Docker DNS shim of 2026-09 (`--add-host` for the two Ubuntu mirrors, image build only) on the same base digest. All four captures ran from the candidate checkout at `34d6847b` against the committed panel `monthly-toolchain-canary-v1` (`scripts/fixtures/toolchain-canary-panel.json`: wikipedia, github, python, gov-uk, guardian; 3 repetitions; panel digest `86fe39f8e4e75e9a2925c1849006909968b67bc507d2aec6cb688ce9cc22be29`, the digest the 2026-09 receipts carry). The canary code does not differ between the two commits. Every one of the 60 receipted runs records egress `WNAM/lax11/US`, Chromium 153.0.8010.12, run outcome complete with HTTP 200, and the same observed subject per site in both builds.

| | Round 1 baseline | Round 1 candidate | Round 2 baseline | Round 2 candidate |
| --- | --- | --- | --- | --- |
| Order | forward | reverse | forward | reverse |
| Runs | 15 | 15 | 15 | 15 |
| Created (UTC) | 15:11:48 | 15:21:06 | 15:34:46 | 15:45:32 |
| Receipt | `round-1-baseline-receipt.json` | `round-1-candidate-receipt.json` | `round-2-baseline-receipt.json` | `round-2-candidate-receipt.json` |
| Receipt sha256 | `0641770950a51c8d03661115a2a6d12134780aa9107543cc81e2c47a423f4e92` | `3432a1712ac70d41cb52ff3a5b2a5c2cd16a3e9fdaa3fc5b9595c80bbd511a1a` | `591e83e6ce61e3350ea58398402934a90285e41806b3e69e716850081c8ab292` | `d309bdd2324e9e7bcd3b3efd281092349fa6d451ef593ae497a190dd9371540a` |

The four receipts are committed byte for byte beside this record in [`toolchain-epoch-2026-10/`](./toolchain-epoch-2026-10/). Each carries the exact staging report IDs of its 15 runs.

### Round 1: FAIL

From a checkout that contains this record (the canary code and the panel are unchanged since the baseline; the receipts are what earlier checkouts lack):

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2026-10/round-1-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2026-10/round-1-candidate-receipt.json
```

Result, as run from the `5d908f89` checkout for this record:

```text
FAIL Capture loss differs between runs of guardian: ["fingerprinting/dropped/fingerprint-observer"] vs ["detector-output/dropped/consent-banner","fingerprinting/dropped/fingerprint-observer"].
```

The differing loss is in the baseline arm. Guardian repetition 2 (sequence 14 of 15 in the forward order, report `20260930-84121955f437be619d614437a372245f`) records `detector-output/dropped/consent-banner` (phase 0, count 1) beside the fingerprint-observer loss that every guardian run of both builds records. The receipt marks that run's detector-output family censored (`capture-loss:dropped`) with the run outcome complete and its requests, cookies and storage families complete. That visit loaded 165 requests; the round's other five guardian runs loaded 188 and 191 (baseline) and 183, 184 and 188 (candidate). The integrator's notes, from the staging report before teardown, read the run's consent-control-and-state@3 detector as partial with reason scan-failed and the warning "The scanner could not complete its check for a visible cookie/consent banner on this page"; the receipt carries only the loss signature, and the staging report is no longer readable. No candidate guardian run carries a consent-banner loss.

### Round 2: FAIL

The playbook asks for one complete matched re-run after confirming the same staging region and stable subjects. The baseline image was redeployed and its first re-capture scanned all 15 runs, then the canary's closing authenticated health read returned 503 and the command wrote no receipt:

```text
FAIL Authenticated staging health returned 503.
```

That is the fail-closed path working as designed: those 15 scans exist in the staging bucket and in no receipt. The wrapper's next health read, at 15:31:19 UTC, was ok at `f9d6c46e`; the integrator's notes place the 503 at 15:30:11 UTC with recovery 16 seconds later on the same instance, a timing the committed logs do not carry. The baseline was captured again (round-2 baseline receipt, 15:34:46 UTC), the candidate image redeployed and captured (15:45:32 UTC), and compared:

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2026-10/round-2-baseline-receipt.json \
  --candidate docs/toolchain-epoch-2026-10/round-2-candidate-receipt.json
```

```text
FAIL Capture loss differs between runs of python: [] vs ["detector-output/truncated/policy-link-candidates"].
```

This time the differing loss is in the candidate arm. Python repetition 1 (sequence 7 in the reverse order, report `20260930-ef2816e2d784eb121f520b309c18f2db`) records `detector-output/truncated/policy-link-candidates` (phase 2, count 1: the privacy-policy link search was truncated). Its counts equal every other python run of both rounds in all nine metrics (32 requests, 7 third-party, 3 third-party domains, 2 Shields-blocked, no cookies, storage entries or fingerprint events). The notes add that the run still found and read the same 11,618-character policy as the clean runs, again a reading of the staging report rather than of the receipt. The compare reports the first mismatch only: guardian's baseline repetition 3 (sequence 15, report `20260930-bc06c52311c80bf7ee342d301bf5efe6`, 164 requests) again carries `detector-output/dropped/consent-banner`, so the round would have failed on guardian had python passed.

Across both rounds, the consent-banner loss hit 2 of 6 baseline guardian runs (sequences 14 and 15, in the forward order that scans guardian last) and 0 of 6 candidate guardian runs (scanned first in the reverse order); the policy-link truncation hit 1 of 12 python runs. Two losses were shared by every run of a site in both builds and passed the gate's signature check; had either round reached the medians they would have been compared like with like as in 2026-09, the fingerprint loss leaving out `guardian.fingerprintEvents`: github's `detector-output/truncated/keystroke-probe-capture` (count 2 on one baseline run in round 2, count 1 on the other eleven; the signature is family, kind and detail, not the count) and guardian's `fingerprinting/dropped/fingerprint-observer`.

Both failing signatures are in the detector-output family. No canary metric is counted from it: `METRIC_EVIDENCE_FAMILIES` in `scripts/toolchain-canary-lib.mjs` maps the nine metrics to the requests, cookies, storage and fingerprinting families.

### Diagnostic median comparison (not the gate)

The gate refuses a differing loss signature before it compares a single median, so the receipts above contain no median comparison. As a diagnostic only, a reimplementation of the gate's median step (a 26-line script that imports the gate's metric and family tables and nothing else of `compareReceipts`) was run over the committed receipts with each run's capture-loss signature restricted to the families that feed a canary metric, restating the tolerances, the like-with-like rule and the left-out rule as the gate applies them; it skips the gate's subject, egress and provenance checks, and its median averages the two middle values at an even count where the gate takes the upper, which cannot differ at three repetitions. In each round: 44 medians within tolerance, 0 outside, and `guardian.fingerprintEvents` left out for the shared fingerprinting loss, exactly as in 2026-09. The medians that moved at all:

| Round | Metric (guardian) | Baseline | Candidate | Delta | Allowed |
| --- | --- | --- | --- | --- | --- |
| 1 | totalRequests | 188 | 184 | 4 | 37.6 |
| 1 | thirdPartyRequests | 158 | 154 | 4 | 39.5 |
| 1 | shieldsBlockedRequests | 70 | 71 | 1 | 21 |
| 2 | totalRequests | 189 | 195 | 6 | 37.8 |
| 2 | thirdPartyRequests | 159 | 165 | 6 | 39.75 |
| 2 | knownTrackerRequests | 27 | 29 | 2 | 8.1 |
| 2 | thirdPartyDomains | 29 | 30 | 1 | 7.25 |
| 2 | shieldsBlockedRequests | 71 | 76 | 5 | 21.3 |

The other 41 (round 1) and 39 (round 2) compared medians are identical across the two builds. This diagnostic is not the gate and does not make the A/B pass: the script that produced it is not committed, and the numbers describe what the gate would have compared, not what it compared.

### Why there was no bisect

The playbook says: do not relax a tolerance or edit the panel for the current epoch; if the re-run fails again, bisect the batched upgrades. A bisect was not meaningful here.

- The recurring loss is in the baseline arm. Bisecting the candidate's commits cannot remove a consent-banner drop from a build that contains none of them.
- The builds share every scanner source file the failing detectors run. `git diff f9d6c46e..34d6847b` outside tests, documentation and the third-party inventories touches only `lib/adblock-wasm/*`, `lib/redaction-v2.ts` (the `PUBLIC_SUFFIX_ENGINE_VERSION` constant), the two identity tables (`lib/scan-report-v2-normalization.ts`, `lib/scan-report-v2-r2-producer-contract.ts`), `package.json` and `package-lock.json` (tldts), `scripts/verify-wasm-reproducibility.mjs`, `tools/adblock-wasm/Cargo.lock` and the reproducibility contract. Neither the consent-banner probe nor the privacy-policy link search is among them.
- The two input commits cannot build an image. `c3baccce` and `9eaa43ab` each fail their own identity tests (the r2 identity ledger and the producer contract's closed literal, until `10800c0d` closed the rows), and the Dockerfile's build stage runs `npm run check` before anything is copied into the runner stage. Of the seven commits after them, only `10800c0d` changes runtime source, and only the two identity tables listed above, which neither the consent-banner probe nor the policy-link search reads; `a96b9760` and `34d6847b` change the normalization file's docblocks only, and the rest change documentation and tests.

### The owner's decision

On 2026-09-30 the owner decided to publish the candidate with a recorded exception to the A/B gate: two rounds, each failing on one detector-output loss signature (one in each arm), no metric-feeding family differing on any site, the diagnostic medians within tolerance in both rounds, and no scanner source shared with the failing detectors changed between the builds. The push of `34d6847b` to `main` (main CI run started 15:54 UTC, after the 15:53 UTC teardown readback) is the act; this record dates it. The gate itself, its tolerances and the panel are unchanged, and the two committed receipts per round reproduce each FAIL.

### Proposed gate refinement (a proposal, not applied)

Proposed for review before the next baseline capture: compare capture loss like with like only for the signatures of families that feed a canary metric (requests, cookies, storage, fingerprinting), and print a differing detector-output signature as an informational row instead of a FAIL, so that one dropped consent-banner probe on an ad-heavy news page does not decide the epoch while any loss in a metric-feeding family that differs between builds still fails it. It is not applied to this epoch, and it would not make this epoch's gate pass in retrospect: a refined gate is a new gate, and this record states the gate that ran.

## Staging teardown

Torn down with Wrangler and read back on 2026-09-30 at 15:53:18 UTC, after the second comparison:

- Container application `a03e7dc0-d368-4e94-8b53-26c3a435e3f8` deleted (`a0319118…` and `a03599ee…` had been deleted during the credential fix); the readback lists no staging container application. The production container application `site-behavior-lab-scanner-scannercontainer` is untouched; the readback lists exactly one production application.
- Worker `site-behavior-lab-scanner-staging` deleted; its deployments list returns code 10007.
- Both staging images this epoch pushed (`082e3045` = `sha256:2b07c6ee…`, `df833e20` = `sha256:f4e22537…`) deleted from the managed registry; the readback lists no image containing `staging`.
- `scan-staging.sitebehavior.org` has no A, AAAA or CNAME answers and accepts no HTTPS connection.
- `~/.sbl-staging/scan-access-token` deleted without reading its contents and the directory removed; `wrangler logout` completed at 15:53:43 UTC.

Not yet done, and not claimed:

- The staging bucket `site-behavior-lab-reports-staging` still exists (the readback's bucket list shows it beside the production bucket) and holds the canary reports (the 60 receipted runs and the 15 from the fail-closed attempt) until its 1-day expiry rule empties it. The operator then deletes the bucket.
- The R2 API tokens are not revoked: `e5962ea411f4730cba135338c4d207c5` (the replacement) and, to be confirmed, `c715549020539b160abadf1a6202228d` (the first, recorded in the provisioning receipt). Both are to be revoked in the dashboard.
- This is not the canonical twelve-resource teardown receipt from [the go-live runbook](./go-live-public-scanner.md), which needs the hosted adapter, six scoped read credentials and protected-environment approval (the same limitation as 2026-09).
- The Durable Object namespace of the staging Worker (`c26a9286…`, per the integrator's notes) and any certificate dedicated to the staging hostname were not separately read back, as they were in 2026-09.

## Publication

`5d908f89` was the tip of `main` when its CI started, and the recorded baseline and staged candidate are its ancestors.

- CI run [36743389278](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36743389278) at `5d908f89` succeeded (2026-09-30, started 16:19 UTC): Supply-chain Security (with the npm audit gate), Typecheck and Unit Tests, Build and Static Export, Chromium Smoke Test, and Docker Runtime and Public R2 Smoke, whose Trivy scan of the exact deployable image passed the container security and package-evidence gates with the unchanged package ledger; the exact-SHA evidence manifests were attested and production was advanced to the tested SHA.
- [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36745918496) advanced `production` to `5d908f89`, and [Deploy Tested Container](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36745908319) and [Deploy Tested Pages](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36745908333) succeeded.
- Live readback at 16:51:49 UTC: `https://scan.sitebehavior.org/api/health` reports deployment `5d908f89f9a7054b2e3d5074a08e523ba2fa3ab4`, status ok, no warnings, and `https://sitebehavior.org/deployment.json` names the same SHA.
- The governed Production Health lane verified the new production build in run [36747252670](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36747252670) (16:51 UTC), with the scanner and Pages both serving `5d908f89`. An earlier run, [36746169461](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36746169461) (16:42 UTC), also concluded success, but on its "Production rollout in progress" warning path, while the old build was still being served; it does not attest `5d908f89`.
- A dispatched [Scanner Fidelity](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/36747338382) run (single, desktop), which builds and scans the checked-out `5d908f89` on a GitHub runner rather than calling production, succeeded: every real-site invariant passed on Chromium 153. Its log shows each Guardian repetition censoring the requests family on ten detail-less `dropped` losses at phase 1. That is the scanner's context-level fallback route, which blocks and records every request from a page other than the scanned one (an auxiliary window the site opened), added in `0493a84b` and present in the baseline; it runs before any ad-block engine call, and neither tldts nor the WASM is on that path. Earlier fidelity runs of the baseline recorded no such window on Guardian and the staging runs of both builds recorded none, so this is a per-visit difference in what the site opened, not a change between the builds.

The two operator items under "Not yet done" (the staging bucket and the R2 token revocations) remain open after publication.
