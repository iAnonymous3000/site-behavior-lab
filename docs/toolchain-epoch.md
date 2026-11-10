# Toolchain epoch playbook

Use one reviewed toolchain epoch per month to keep measurements representative without severing temporal cohorts for every patch release. Batch the behavior-affecting inputs that intentionally create a new cohort:

- Playwright, its disclosed `NODE_PLAYWRIGHT_VERSION`, bundled Chromium, and matching Playwright container tag
- `adblock-rust`, the rebuilt committed WASM, and the disclosed engine version
- `tldts` and the disclosed normalization version
- the container base-image digest and lockfiles

Keep the weekly Brave-list refresh separate. It has its own provenance and validation path; combining it with an epoch would make a failed canary harder to attribute. Cut an urgent epoch outside the monthly cadence for an actively exploitable security issue.

## Release record and boundaries

Before changing pins, record the baseline commit and the exact old/new versions and digests for every item above. Build the candidate as a local commit in a clean checkout. Do not push it yet: pushing `main` starts CI and, if every gate passes, may fast-forward the exact tested commit to the deploy-only `production` branch. `main` is the release-candidate branch; `production` is the deployment boundary.

Keep the logs, snapshots and receipts of an epoch in one directory that survives a restart and is outside every checkout, and name it once in the operator shell. The commands below write there. Do not use `/tmp`: it is emptied at restart, and the receipts are part of the epoch record.

```sh
export EPOCH_EVIDENCE="$HOME/toolchain-epoch-evidence"
mkdir -p "$EPOCH_EVIDENCE"
```

Every Node report must carry the exact Playwright pin in its methodology provenance. The provenance guard ties that recorded constant to `package.json`, `package-lock.json`, the installed package, and the digest-pinned container base. The report UI renders Playwright separately from Chromium because a Playwright patch may intentionally keep the same browser build.

The gate has two distinct checks:

1. The committed corpus must expose exactly the same canonical comparison decisions. This is a zero-flip policy.
2. Two exact staging builds must scan the committed five-site panel, in opposite order, with three repetitions. Local receipts compare per-site medians against the committed tolerances, and a metric is inconclusive when the repetitions of one build differ among themselves by more than its tolerance and the runs of the two builds are not further apart than that. A case whose own runs spread beyond the tolerance in most comparisons gives the panel no evidence for the metrics that spread; the remedies are a stable case or a statistic that tolerates a page with two modes, and each is a change to the panel (for the statistic, to the comparison rule) that is made before a capture, never after. More repetitions are not a remedy under this rule: [Changing the panel](#changing-the-panel) says why, and how a case is replaced.

The staging canary is deliberately not a public comparison report. `reports:verify-v2-shadow` is not suitable for this job: its comparisons are same-build intervention checks, while the normal v2 comparability rules correctly reject mixed browser/toolchain builds. Never weaken those rules or synthesize a cross-build public report for an epoch.

## 1. Build and static gates

Use isolated clean worktrees for the baseline and candidate. Fetch immediately before choosing the baseline, and bind both worktrees to exact 40-character commits.

Run on the candidate:

```sh
npm ci
npm run lists:verify
npm run check
npm run build:pages
npm run test:smoke:static
```

Record the Rust-side generator versions in the release record, rebuild from a clean Cargo target with the locked Cargo graph, copy the complete generated `sbl_adblock_wasm*` set, regenerate the WASM integrity contract, and commit them together. Then prove the committed copies are reproducible with a second build from a clean target, compared against them before anything is copied. A `cmp` run after `cp` compares a file with itself and always passes, and a rebuild over a warm `tools/adblock-wasm/target` reuses the first compile instead of repeating it.

The generators include wasm-opt, and the vendored bytes depend on it. wasm-pack 0.14.0 runs a `wasm-opt` from `PATH` first, and otherwise the binaryen `version_117` build it downloaded into its tool cache (`$WASM_PACK_CACHE`, by default `~/Library/Caches/.wasm-pack` on macOS and `~/.cache/.wasm-pack` on Linux). `--mode no-install` never downloads: with no cached copy the build logs "Skipping wasm-opt", exits 0, and writes a different, larger `sbl_adblock_wasm_bg.wasm`. So require that no `wasm-opt` is on `PATH` and exactly one cached copy exists, record its version and SHA-256 (on macOS also the `libbinaryen.dylib` it loads), and require the build log to show wasm-opt ran from the cache. wasm-pack chooses wasm-bindgen the same way: a copy on `PATH` only when its version equals the `wasm-bindgen` pin in `tools/adblock-wasm/Cargo.lock`, and otherwise a cached copy, logging "Installing wasm-bindgen...". A `wasm-bindgen --version` on `PATH` is therefore not evidence of the binary the build ran, so require none on `PATH` and record the cached copy. On Apple Silicon macOS, where wasm-pack has no prebuilt wasm-bindgen, that copy is `wasm-bindgen-cargo-install-<version>`; on Intel macOS and Linux wasm-pack tries a prebuilt copy in a hashed `wasm-bindgen-<hash>` directory first, so record that one instead and require exactly one cached wasm-bindgen for the locked version. The commands below are for an Apple Silicon macOS build host; on Linux, also point the cache path at the Linux default and hash only `bin/wasm-opt`.

The cache holds a wasm-bindgen only for the versions it has already installed. When the epoch moves the `wasm-bindgen` pin in `tools/adblock-wasm/Cargo.lock` (`cargo update -p wasm-bindgen --precise <version>` in `tools/adblock-wasm`), populate the cache before the checks below, or the cached-copy `--version` step fails with no such file. wasm-pack installs the CLI itself, and only in its default mode: one build without `--mode no-install` runs `cargo install wasm-bindgen-cli` at exactly the locked version into `wasm-bindgen-cargo-install-<version>`. That install is unlocked (its log reads "Locking N packages to latest compatible versions"), so the walrus the CLI links, and with it the bytes the CLI emits, are resolved on the day of the install and pinned by nothing checked in; that is why the reproducibility contract proves the CLI and its walrus from the vendored binary's `producers` section. Run that build once from a clean target, keep its log, record the cached binary's SHA-256 and the versions in the `producers` section of the binary it wrote, and discard its output: the copied build is a later `--mode no-install` run from a clean target, checked exactly as below. The 2026-10 epoch populated 0.2.129 this way (walrus 0.27.2), and the 2026-12 epoch 0.2.130 (walrus 0.27.3). When the walrus it prints differs from `WALRUS_VERSION` in `scripts/verify-wasm-reproducibility.mjs`, move that constant and its assertions in `lib/wasm-reproducibility.test.ts` in the same change: verification refuses a binary that records another walrus.

```sh
test -z "$(command -v wasm-opt)"
test -z "$(command -v wasm-bindgen)"
WASM_PACK_CACHE_DIR="${WASM_PACK_CACHE:-$HOME/Library/Caches/.wasm-pack}"
WASM_BINDGEN_LOCKED="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/"/,"",$3); print $3}' tools/adblock-wasm/Cargo.lock)"
test ! -e "$WASM_PACK_CACHE_DIR/wasm-bindgen-cargo-install-$WASM_BINDGEN_LOCKED"
rm -rf tools/adblock-wasm/pkg tools/adblock-wasm/target
wasm-pack build tools/adblock-wasm --target nodejs --release -- --locked 2> "$EPOCH_EVIDENCE/toolchain-wasm-install.log"
grep -F 'Installing wasm-bindgen...' "$EPOCH_EVIDENCE/toolchain-wasm-install.log"
grep -F "Installing wasm-bindgen-cli v$WASM_BINDGEN_LOCKED" "$EPOCH_EVIDENCE/toolchain-wasm-install.log"
grep -F 'Locking ' "$EPOCH_EVIDENCE/toolchain-wasm-install.log"
grep -F 'Optimizing wasm binaries with `wasm-opt`' "$EPOCH_EVIDENCE/toolchain-wasm-install.log"
! grep -F 'found wasm-opt at' "$EPOCH_EVIDENCE/toolchain-wasm-install.log"
shasum -a 256 "$WASM_PACK_CACHE_DIR/wasm-bindgen-cargo-install-$WASM_BINDGEN_LOCKED/wasm-bindgen"
node -e 'import("./scripts/verify-wasm-reproducibility.mjs").then((m) => console.log(m.producersProcessedBy(require("node:fs").readFileSync("tools/adblock-wasm/pkg/sbl_adblock_wasm_bg.wasm"))))'
rm -rf tools/adblock-wasm/pkg tools/adblock-wasm/target
```

The contract binds the SHA-256 of the Cargo inputs and all four outputs, so it moves with any rebuilt byte. `--print` regenerates it from the verifier's constants without checking the binary markers, so if the epoch moves rustc and cargo, wasm-pack, wasm-bindgen or wasm-opt (a wasm-pack move can move wasm-opt, whose binaryen version wasm-pack hardcodes), first update `RUSTC_COMMIT`, `WASM_BINDGEN_VERSION`, `WALRUS_VERSION`, `WASM_OPT_VERSION` and every `requiredBuild` pin in `scripts/verify-wasm-reproducibility.mjs`, including `wasmPack`, `rustc` and `cargo`, together with their assertions in `lib/wasm-reproducibility.test.ts`. Then run:

```sh
wasm-pack --version
test -z "$(command -v wasm-opt)"
test -z "$(command -v wasm-bindgen)"
WASM_PACK_CACHE_DIR="${WASM_PACK_CACHE:-$HOME/Library/Caches/.wasm-pack}"
WASM_OPT="$(find "$WASM_PACK_CACHE_DIR" -path '*/wasm-opt-*/bin/wasm-opt' -type f)"
"$WASM_OPT" --version
shasum -a 256 "$WASM_OPT" "$(dirname "$WASM_OPT")/../lib/libbinaryen.dylib"
WASM_BINDGEN_LOCKED="$(awk '/^name = "wasm-bindgen"$/{getline; gsub(/"/,"",$3); print $3}' tools/adblock-wasm/Cargo.lock)"
"$WASM_PACK_CACHE_DIR/wasm-bindgen-cargo-install-$WASM_BINDGEN_LOCKED/wasm-bindgen" --version
rm -rf tools/adblock-wasm/pkg tools/adblock-wasm/target
wasm-pack build tools/adblock-wasm --mode no-install --target nodejs --release -- --locked 2> "$EPOCH_EVIDENCE/toolchain-wasm-build.log"
grep -F 'Compiling sbl-adblock-wasm' "$EPOCH_EVIDENCE/toolchain-wasm-build.log"
grep -F 'Installing wasm-bindgen...' "$EPOCH_EVIDENCE/toolchain-wasm-build.log"
grep -F 'Optimizing wasm binaries with `wasm-opt`' "$EPOCH_EVIDENCE/toolchain-wasm-build.log"
! grep -F 'found wasm-opt at' "$EPOCH_EVIDENCE/toolchain-wasm-build.log"
cp tools/adblock-wasm/pkg/sbl_adblock_wasm* lib/adblock-wasm/
node scripts/verify-wasm-reproducibility.mjs --print > tools/adblock-wasm/reproducibility-contract.json
npm run lists:verify
```

Review the contract diff and commit the vendored set and the contract together. Then prove them from a clean target without copying:

```sh
test -z "$(command -v wasm-opt)"
test -z "$(command -v wasm-bindgen)"
rm -rf tools/adblock-wasm/pkg tools/adblock-wasm/target
wasm-pack build tools/adblock-wasm --mode no-install --target nodejs --release -- --locked 2> "$EPOCH_EVIDENCE/toolchain-wasm-rebuild.log"
grep -F 'Compiling sbl-adblock-wasm' "$EPOCH_EVIDENCE/toolchain-wasm-rebuild.log"
grep -F 'Installing wasm-bindgen...' "$EPOCH_EVIDENCE/toolchain-wasm-rebuild.log"
grep -F 'Optimizing wasm binaries with `wasm-opt`' "$EPOCH_EVIDENCE/toolchain-wasm-rebuild.log"
! grep -F 'found wasm-opt at' "$EPOCH_EVIDENCE/toolchain-wasm-rebuild.log"
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm.js lib/adblock-wasm/sbl_adblock_wasm.js
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm.d.ts lib/adblock-wasm/sbl_adblock_wasm.d.ts
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm_bg.wasm lib/adblock-wasm/sbl_adblock_wasm_bg.wasm
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm_bg.wasm.d.ts lib/adblock-wasm/sbl_adblock_wasm_bg.wasm.d.ts
git diff --exit-code HEAD -- lib/adblock-wasm tools/adblock-wasm/reproducibility-contract.json
npm run wasm:verify-reproducibility
```

Treat any generated artifact, lockfile, disclosed version, Docker pin, or methodology guard that does not move together as a failed epoch.

That includes `CONTAINER_IMAGE_PACKAGE_REVIEWS.json`. A new base image can change the OS packages the runtime image ships. The ledger keys each package by name, upstream version and architecture, and each row's evidence digest covers the source package and Trivy's detected licenses, so main CI's container package-evidence gate fails, and blocks publication of the tested image, until the ledger matches any change in those. It does not see a Debian-revision-only update (the 2026-09 base moved dozens, among them glibc and OpenSSL security revisions); CI's image vulnerability scan still catches a HIGH or CRITICAL finding in one. Sync the ledger in the candidate before the staging deploy, so the staged commit is the commit CI promotes: scan a `linux/amd64` image built from the commit before the sync commit with Trivy v0.70.0 exactly as CI does (license scanner, OS package types, every package), then run the inventory and review-sync producers described in [supply-chain assurance](./supply-chain-assurance.md). Either image works: the full deployable image, or a runner-stage stand-in: the candidate Dockerfile's runner stage built `FROM` the pinned base digest directly (skipping the base stage's Node and npm version assertion), with the same labels, environment and purge step, without the `COPY --from=build` lines, and with a `mkdir -p /app/.next` before the `chown` step, which otherwise fails without the copied `.next` directory. Application files cannot change an OS-package inventory, because the scan is limited to OS package types and the inventory producer rejects any non-OS package result. CI re-derives the inventory from the exact deployable image and checks it against the committed ledger. Never derive or edit a row by hand or from `dpkg-query`.

## 2. Corpus-neutrality gate

Compile and run the audit command separately inside each exact checkout. The
snapshot command deliberately has no cross-checkout `--root` override: using
the candidate evaluator against both report directories would create a false
negative for a decision-code regression. The snapshot contains only report IDs
and canonical decision modes/reasons; it excludes subjects, evidence,
measurements, and timestamps. Output creation is exclusive, so choose new paths.

```sh
cd /path/to/baseline
npm ci
npm run corpus:audit-neutrality -- snapshot --out "$EPOCH_EVIDENCE/toolchain-baseline-neutrality.json"

cd /path/to/candidate
npm ci
npm run corpus:audit-neutrality -- snapshot --out "$EPOCH_EVIDENCE/toolchain-candidate-neutrality.json"
npm run corpus:audit-neutrality -- compare \
  --baseline "$EPOCH_EVIDENCE/toolchain-baseline-neutrality.json" \
  --candidate "$EPOCH_EVIDENCE/toolchain-candidate-neutrality.json"
```

Proceed only when the report sets are identical and there are zero overall-mode, family-mode, and family-reason changes. A corpus change and a toolchain change must not share this gate; split them into separate reviews.

## 3. Exact-build staging A/B

Provision the isolated staging Worker, container, secrets, and staging-only R2 bucket exactly as described in [the public-scanner go-live runbook](./go-live-public-scanner.md). The canary command accepts only `https://scan-staging.sitebehavior.org`, requires the whole-origin access token, verifies the authenticated health document against the expected commit before and after capture, and refuses production or arbitrary origins.

Export the token only in the operator shell; never put it in arguments, receipts, logs, or URLs:

```sh
export TOOLCHAIN_CANARY_ACCESS_TOKEN='<staging whole-origin token>'
```

Deploy the clean baseline checkout with the staging deploy wrapper. It resolves the checkout's exact `HEAD`; do not override that SHA.

```sh
npm run cf:container:staging:deploy
```

From the candidate checkout, capture the baseline in forward order. Replace the placeholder with the exact deployed baseline commit:

```sh
npm run toolchain:canary -- capture \
  --expected-build <baseline-40-character-sha> \
  --order forward \
  --out "$EPOCH_EVIDENCE/toolchain-baseline-receipt.json" \
  --confirm I_ACKNOWLEDGE_THIS_SUBMITS_LIVE_STAGING_SCANS
```

Deploy the clean candidate checkout to the same isolated staging origin, then capture it in reverse site order:

```sh
npm run cf:container:staging:deploy
npm run toolchain:canary -- capture \
  --expected-build <candidate-40-character-sha> \
  --order reverse \
  --out "$EPOCH_EVIDENCE/toolchain-candidate-receipt.json" \
  --confirm I_ACKNOWLEDGE_THIS_SUBMITS_LIVE_STAGING_SCANS
```

Compare the two local, create-only receipts:

```sh
npm run toolchain:canary -- compare \
  --baseline "$EPOCH_EVIDENCE/toolchain-baseline-receipt.json" \
  --candidate "$EPOCH_EVIDENCE/toolchain-candidate-receipt.json"
```

The compare command is the release comparison, and it runs on the current panel (`scripts/fixtures/toolchain-canary-panel.json`) only. It refuses a receipt that was captured on an earlier panel and names the replay command, which reads such receipts and is never a release comparison. See [Changing the panel](#changing-the-panel).

The command fails closed on degraded or stale health, missing sandbox/R2/durable staging attestations, a failed, bot-walled, unsettled, budget-exhausted or not run-level complete scan, an evidence family censored by anything other than its own recorded capture loss, a capture-loss difference between the builds under the rule below, subject or egress drift, mixed provenance inside a capture, incomplete panel coverage, or a metric that fails the comparison rule below: runs of the two builds that are separated by more than the committed absolute/relative tolerance, or a median outside that tolerance on a metric whose repetitions stay within it in each build. It submits ordinary token-gated single scans only; it never sends the staging fault-injection headers. A health read that fails as a read (the request, the HTTP status or the JSON) is tried up to 3 times, 1 second and then 2 seconds apart. The health gate is not tried again: it is applied once, to the first health that was read, and a health that reports a warning or another build fails the capture, whatever a later read would say. A status poll or a read of the saved report that fails is read again at the next poll, 2 seconds later, inside a window of 180 reads, and ends the scan only when that window ends. A submission is never sent twice. A capture opens its receipt file before its first request, create-only, so a directory that does not exist or a file that is already there is refused before a scan is spent. The file is empty until the one write at the end. A capture that fails removes it. A capture that is stopped from outside (the process is killed, the machine stops) cannot, and leaves the empty file: it is not a receipt, `compare` refuses it and `capture` refuses to write over it, so remove it before the next capture. Receipts are mode `0600`, contain no access token, and record the exact staging report IDs for audit and teardown. The capture refuses a receipt path under `public/`, with links resolved.

Capture loss is judged per site by its signature: family, kind and detail (a loss recorded without a detail is identified by family and kind alone; counts are not compared). The rule depends on whether the signature's evidence family feeds a canary metric:

- The families the canary metrics are counted from (`METRIC_EVIDENCE_FAMILIES` in `scripts/toolchain-canary-lib.mjs`: requests, cookies, storage and fingerprinting) are compared strictly. Every run of a site in both builds must record the same signatures in these families, or the comparison fails. A loss shared that way is compared like with like: the metrics its family feeds are left out for that site and printed as `LEFT OUT`, as the report's claim eligibility (`REPORT_CLAIM_REQUIREMENTS`) treats a censored family, and the gate fails if that would leave a metric compared on no site.
- A loss in any other family (detector output, consent verification, or a family added later) feeds no compared median. For each such signature the gate counts the runs of the site that carry it in each build, and fails when more than half of one build's runs carry it and none of the other build's do (2 or 3 of 3 against 0 of 3): a systematic difference between the builds. Otherwise it does not fail: it is printed as `NOTED` with both counts, recorded and not compared, whether it is sporadic (1 of 3 against 0 of 3, or 2 of 3 against 1 of 3) or on every run of both builds (3 of 3 against 3 of 3, as github's keystroke-probe truncation is).

Since node-detectors-v9 the fingerprint listener-attribution loss fires on most ad-heavy pages, so `fingerprintEvents` is usually left out for the heavy news case and compared only on the lighter sites; a keystroke-probe truncation censors detector output, which no canary metric is counted from.

On 2026-10-02, before the next baseline capture, the owner chose to refine the gate along the lines of the proposal in [the 2026-10 record](./toolchain-epoch-2026-10.md). The rule above goes beyond that proposal: it still fails a systematic difference between the builds, which the proposal would have printed as an informational row; it covers every family that feeds no metric, not only detector output; and it prints as `NOTED` a signature every run of both builds carries, not only one that differs. Until the refinement every family was compared strictly, and the 2026-10 epoch failed its A/B twice on detector-output signatures that 1 of 3 runs of one build carried and no run of the other (round 1: a dropped consent-banner probe on one baseline Guardian run; round 2: a truncated privacy-policy link search on one candidate python.org run, and again a consent-banner drop on one baseline Guardian run), while no metric-feeding family differed and every median the record's diagnostic compared was within tolerance. The receipts and their version are unchanged; only the comparison moved. Compared under the refined gate, each round of the committed 2026-10 receipts passes with 44 compared medians within tolerance, the values in the record's diagnostic table, and prints those signatures as `NOTED` beside github's every-run keystroke-probe truncation; that is not a retroactive pass. That epoch was published under the owner's recorded exception, and its record states the gate that ran. The record says its FAILs reproduce from any checkout that contains it; from the refinement on, its compare commands print PASS with those `NOTED` lines instead, and the FAIL output it quotes reproduces only from a checkout that predates the refinement, such as `eecb7335`. The committed 2026-09 receipts pass under both rules with the same 44 compared medians and the same `LEFT OUT` row; the refined gate adds one `NOTED` line, for github's keystroke-probe truncation, which every run of both builds carries, and ends its PASS line with that count. The [2026-09 record](./toolchain-epoch-2026-09.md) has its comparison re-run from a checkout of its candidate, which prints the output it quotes; run from a checkout that contains the refinement, the same command prints those two differences, and the quoted output reproduces verbatim only from a checkout that predates the refinement, such as `eecb7335`.

The medians are judged by comparison rule `median-with-within-arm-spread-v2`. A comparison that reaches the medians prints the rule first, as a `RULE` line, and gives each compared metric of each site one of three outcomes. The tolerance of a metric is the larger of its committed absolute term and its relative term times the baseline median. The spread of a build is the largest minus the smallest of that build's repetitions of the metric on that site. The rule decides in this order:

1. Fail on separated runs: every run of one build differs from every run of the other by more than the tolerance, so the smallest run of one build is more than the tolerance above the largest run of the other (a gap equal to the tolerance is not separated). The spreads do not matter here: no pairing of runs closes the gap, so what one build shows against itself cannot explain it. The command prints a `FAIL` line with both medians, the gap and the runs of both builds.
2. Inconclusive: otherwise, the spread of either build is greater than the tolerance (a spread equal to the tolerance is not). The page varied within one build by more than the comparison allows, so neither a difference nor an agreement of the two medians can be attributed to the build. Medians that agree under that much spread are not a pass, and medians that differ under it are not a fail. The command prints an `INCONCLUSIVE` line with the site and metric, the repetitions and spread of each build, the tolerance and both medians.
3. Otherwise the two medians decide. Pass: they differ by no more than the tolerance. Fail: they differ by more than the tolerance, and the command prints a `FAIL` line with both medians.

A difference of medians is evidence about the build only when it is larger than what one build shows against itself. A live page can load in more than one state of its own. With three repetitions per build, the medians of such a page can land in different states under identical builds, and in the same state under different ones, so the median comparison alone would fail or pass on the page and not on the toolchain.

The exit status of the compare command follows from the outcomes:

- 0: every compared metric passes. The last line is `PASS`.
- 1: one or more metrics fail, or the command refuses the comparison for one of the other reasons above (a refusal judges no median and prints no `RULE` line). The last line is `FAIL`. One failed metric gives exit 1 whatever else is inconclusive.
- 2: no metric fails and one or more are inconclusive. The last line is `INCONCLUSIVE` and names each such metric.

Exit 2 is not a pass and not a failure. For the metrics it names, the comparison is no evidence for the toolchain and no evidence against it. `npm run toolchain:canary` passes the status of the command to the shell unchanged. A compile failure ahead of the command exits 1, never 2.

When the compare command exits 2:

1. Record each inconclusive metric by name in the epoch record and in the release decision, with the repetitions, spreads, tolerance and medians that the command printed.
2. Do not record the A/B as passed, and do not record a toolchain regression for that metric. The comparison shows neither.
3. To get evidence for that metric, use one of the remedies in the description of the panel above: a stable case, or a statistic that tolerates a page with two modes. Make the change before a capture, never after. More repetitions do not give that evidence (see [Changing the panel](#changing-the-panel)).

This rule was added on 2026-11-10. Results recorded before it were judged by the earlier rule, which compared the two medians alone and printed no `RULE` line. Those results stand as recorded, and this playbook does not judge them again. Where the paragraph on the 2026-10-02 refinement above, or the 2026-10-02 addendum in the 2026-10 record, says what the compare command prints for the committed 2026-09 and 2026-10 receipts, it describes the gate from that refinement until this rule: that output reproduces from a checkout in that range, such as `f662f462`. Each dated record carries a 2026-11-10 addendum that says what the command does from this rule on and names the checkout that reproduces the record. This rule did not change how capture loss is judged.

An external site can change during the run. A tolerance failure therefore means stop and investigate, not automatically "toolchain regression." Re-run the complete matched panel only after confirming the same staging region and stable subjects. If it fails again, bisect the batched upgrades. Do not relax a tolerance, edit the panel or change the capture-loss rule to make the current epoch pass; review such changes before a future baseline capture.

Always complete the staging teardown and readback receipt in the go-live runbook, including removal of the staging token, Worker/container resources, and staging R2 objects. Production remains untouched throughout this gate.

## 4. Publish and verify

Immediately before publication, fetch again and confirm `origin/main` is still the recorded baseline. If it moved, rebase the candidate, rerun the affected static/corpus gates, and repeat the exact-build canary when any behavior-affecting input changed.

After pushing the candidate:

- verify required CI completed for the exact candidate SHA;
- verify the production deployment reference resolves to that SHA;
- read authenticated/live health and require the exact deployment marker with no warnings;
- retain the version matrix, corpus snapshots, canary receipts, teardown receipt, and CI/deployment links as the epoch record.

Do not call an epoch complete from green source tests alone. Completion requires exact-artifact provenance, zero corpus-decision flips, a passing staging A/B, isolated-staging teardown, and exact-SHA production readback. A passing staging A/B is a compare command that exits 0. Exit 1 is a failed A/B, and the epoch is not complete. Exit 2 is neither a pass nor a failure, and it does not complete the epoch: the epoch record names each inconclusive metric with the runs of both builds and says that the comparison gave no evidence about the toolchain for that metric, and the release then needs the owner's recorded decision. Never write up an exit 2 as a pass.

## Changing the panel

The current panel is `scripts/fixtures/toolchain-canary-panel.json`. Every panel a receipt may carry is also committed in `scripts/fixtures/toolchain-canary-panels/`, one file per panel, named for its `panelId`: the current panel, byte for byte, and each panel before it. A receipt embeds its panel and the digest of that panel, and no canary command runs while the current panel is missing from that directory, so a receipt can be read against the panel it was captured with for as long as that panel's file is committed there. The tests pin the bytes of panel version 1 and replay the ten committed receipts on it, so that file cannot change or go without a test failing.

The directory holds panel files and nothing else. A file in it that is not a panel (a `.DS_Store`, for instance) stops every canary command with a message that names the file: remove the file.

### Release comparison and replay

Two commands read a pair of receipts, and one cannot stand in for the other.

- `compare` is the release comparison. It runs on the current panel only. A passing staging A/B is this command exiting 0.
- `replay` reads two receipts on the committed panel that both carry, whichever panel that is. Every line it prints starts with `REPLAY`, a refusal included, of its options as of its receipts. Its first line gives the id, version, digest and file of that panel and says whether that panel is the current one. Its per-metric lines are the lines `compare` prints, with that mark. Its result line (`REPLAY PASS`, `REPLAY INCONCLUSIVE` or `REPLAY FAIL`) ends by saying that it is not a release comparison. Its exit statuses (0, 2 and 1) mean what they mean for `compare`, about the replayed pair and under the rule in force when it runs. A replay never completes an epoch and changes nothing a dated record states.

`compare` refuses a receipt that names another committed panel, with exit 1. Its message says that a release needs a fresh capture of both builds on the current panel, and names `replay` for reading the old receipts. Both commands refuse a receipt whose panel is no committed panel, and both refuse a qualification receipt. The dated records quote `compare` commands for their own receipts. Those commands were written while panel version 1 was current: from the commit that changes the current panel, they print that refusal, and `replay` on the same two files reads the receipts.

### Why a case is replaced and not repeated

More repetitions do not make an inconclusive metric conclusive under `median-with-within-arm-spread-v2`. The spread of a build is the range of its repetitions, and a range does not shrink when runs are added. A page that loads in one of two states more than a tolerance apart is conclusive only when every run of a build lands in one state, and that is less likely with every added run. In the committed receipts the Guardian case shows a low state (19 known-tracker requests or fewer, where every other run has 26 or more) in 3 of the 18 runs of 2026-09 and 2026-10 and in 7 of the 12 runs of 2026-11. At one low visit in six, every run of both builds lands in one state in about 33% of comparisons at three repetitions, 16% at five and 8% at seven. The remedy for such a case is another case, or a statistic that tolerates two modes, which is a change of the comparison rule.

### The rule

A panel changes through one qualifying capture, judged by a rule that is committed before the capture runs. The rule for the change from panel version 1 is `QUALIFICATION_RULE` in `scripts/toolchain-canary-lib.mjs`, with the id `panel-qualification-2026-11-10`. It was fixed on 2026-11-10, before any qualifying capture. Its candidates are the qualification panel, `scripts/fixtures/toolchain-canary-qualification-panel.json`: bumble.com, ssa.gov and who.int at five repetitions, under the conditions and the tolerances of the current panel. A qualification panel may submit at most 15 scans (cases times repetitions), the size of one comparison capture.

The rule judges each case alone:

- A case qualifies when every run completed with a 2xx document, no run records capture loss in a family a canary metric is counted from (requests, cookies, storage, fingerprinting), every run ended on the candidate's own site, all runs landed on one subject and were captured under one set of conditions and toolchain provenance, and for every metric the spread of the runs is at most the tolerance at their median. A run ended on the candidate's own site when its report records both of these for the page the visit ended on: a registrable domain that is the candidate's catalog domain, and an origin whose host is that domain or ends in a dot and that domain. So a subdomain of the candidate is its site, and a redirect to another site is not. Without this condition a candidate that redirects to another site on every run would qualify under the candidate's name. The comparison would refuse runs of one case on two subjects, or runs of one build under two sets of conditions.
- A qualifying case is a signal case when its medians of `knownTrackerRequests` and `shieldsBlockedRequests` are each at least 8. At 8 a halved count moves the median by more than the tolerance. At 7 it can round to a move inside the tolerance.
- The Guardian's slot goes to bumble.com and to no other case, and only if bumble.com qualifies, is a signal case, and has a median above the tolerance on each of the five metrics that only the Guardian carries in panel version 1 (`knownTrackerRequests`, `thirdPartyDomains`, `thirdPartyCookies`, `storageEntries`, `shieldsBlockedRequests`), so that a zeroed count would still fail. If not, the Guardian stays.
- The gov.uk slot goes to the first of ssa.gov, then who.int, that qualifies and is a signal case. If neither does, gov.uk stays, and the tracker and Shields signal of the panel rests on one site.
- A case is judged only when every one of its runs is recorded. A case whose capture ended first is not judged, which the slots treat as not qualified: it takes no slot.
- The next panel keeps the repetitions, conditions and tolerances of the panel it changes. Each new case takes the place of the case it replaces.

The loss condition is stricter than the comparison, which leaves a metric out when every run of both builds shares a loss. The comparison refuses outright when the loss signatures of a site differ between any two of its runs, and one capture cannot show that a loss will be on every later run.

One capture cannot prove that a page has a single state. A page that shows a second state in one visit of three still shows only one of the two in about 14% of five-run captures. A page that shows it in one visit of six, the Guardian's rate in its 2026-09 and 2026-10 receipts, does so in about 40%. So the five runs are not the protection against such a page. The closed candidate list is: it holds the candidates whose committed history was accepted when the rule was fixed, and a case that is not on it cannot take a slot, whatever one capture shows.

### The qualifying capture

The `qualify` command runs the capture. Before its first scan it keeps the gates of a comparison capture: the confirmation string, the staging origin and its token, and authenticated health against the expected build. It holds every saved report to the committed report schema.

There is one capture for one qualification panel. The command holds one worktree to that, and no more: it takes no path for its receipt, and while the receipt exists in the worktree it refuses to run, whatever the file holds. It cannot see another clone, and a clone that does not have the receipt can run the capture again. That is why the receipt is committed and pushed before anything else (step 4).

The receipt goes to `docs/<qualificationPanelId>/qualification-receipt.json` in the worktree, which for the committed qualification panel is `docs/toolchain-canary-qualification-2026-11/qualification-receipt.json`. The command creates that file, empty, before its first request, create-only and readable by its owner alone. It refuses a path that a link leads out of that place, before it makes anything beyond the link. Each write after that replaces the receipt whole: the text goes to `qualification-receipt.json.partial` beside it, is flushed, and is renamed over it, so the receipt is never half written.

A health read that fails as a read (the request, the HTTP status or the JSON) is tried up to 3 times, 1 second and then 2 seconds apart. The health gate is applied once, to the first health that was read, and is never a reason to read again. A status poll that cannot be read counts as one poll of the window of 180 polls, 2 seconds apart, and the status is read again at the next. The saved report is read with the same patience: up to 180 reads, 2 seconds apart. A scan is recorded with an unreadable status or an unreadable report only when its window ends. A submission is never sent twice.

From the first scan on, nothing the capture has seen is discarded. The receipt is written to disk before each scan, and again as soon as the last scan ends and before the health read that follows it, marked not finished each time. It is written once more when it is finished. A scan that leaves no report (its job failed, expired, was cancelled or did not end within the polling window, or its status or its saved report could not be read by the end of its window) is recorded against its case, and so is a saved report whose visit was blocked, failed, did not settle or ran out of budget. The capture goes on after either.

The capture ends in one of four ways:

- Finished. Every scan was attempted and recorded. The health read after the last scan is recorded in the receipt, pass or fail: a failure there does not void the runs, which each record their build. The command exits 0.
- Ended by a scan. A saved report from another build, toolchain or condition vector, a report the schema refuses, or a submission that the server does not answer with a job ends the capture. The receipt holds the runs so far and the reason, and is not finished. The command exits 1. This includes a first submission that got no answer, or an answer that is neither a job nor one of the refusals below: the server may have accepted that scan, so the receipt is kept with no scan recorded.
- Stopped from outside (the process is killed, the machine stops). The command cannot say what it left, so read the receipt file. If it is a JSON document, it is not finished and holds every scan that had been written: each scan is written as soon as it ends, before the next request, so a stop can lose only the scan in progress, or one that ended in that instant. If it is an empty file (0 bytes), no scan was submitted: the first write of the receipt comes before the first submission, so an empty receipt can mean nothing else. An empty receipt is the only receipt the operator may remove. A file `qualification-receipt.json.partial` beside the receipt is a write that the stop cut off. It is not a receipt: remove it and do not commit it.
- Not started. A gate fails before the first scan (a wrong flag, a place for the receipt that cannot be written, a health read that fails three times, or a health that the gate refuses), or the server refuses the first submission (status 400, 401, 403, 413, 422 or 429) before it has accepted any scan. No scan was accepted and no receipt file is left, so the capture has not been used. The capture is used from the first job the server acknowledges: a refusal after that keeps the receipt.

The receipt records the id and the digest of the rule, the digest of the qualification panel, and the version and digest of the panel it would change. `verdict` refuses a receipt that was recorded under another rule. It reads the committed panel that the receipt names, not the current panel, so it gives the same verdict after panel version 2 is current. It reads a receipt that is not finished: it judges each case whose runs are all recorded and reports every other case as not judged. The qualification receipt is a kind of its own: `compare` and `replay` refuse it, and `verdict` refuses a capture receipt.

A panel past version 1 is committed only as the bytes `verdict` gives for the committed qualification receipt. The tests hold the repository to that, so a panel made by hand, with a tolerance loosened or a case exchanged, fails them.

### Procedure

1. Commit the rule and the qualification panel before the capture. Do not change either after a qualification receipt exists. A changed rule is a new rule: give it a new id, a new qualification panel id and its own capture.
2. Deploy the current build to the isolated staging origin and export the token, as in section 3.
3. Run the qualifying capture once:

   ```sh
   npm run toolchain:canary -- qualify \
     --expected-build <deployed-40-character-sha> \
     --confirm I_ACKNOWLEDGE_THIS_SUBMITS_LIVE_STAGING_SCANS
   ```

4. Commit and push `docs/toolchain-canary-qualification-2026-11/qualification-receipt.json` immediately, whatever it holds, before anything else. The command refuses a second capture only in a worktree that has the receipt, and another clone does not have it until it is pushed. If the command ended without a finished receipt, stop and ask the owner. Do not run the command again, and do not remove or edit the receipt. There are two exceptions. In both no scan was accepted, the capture has not been used, and there is nothing to commit: correct the cause and do step 3 again.
   - The command printed a message that ends `no receipt is kept: the qualifying capture has not been used.` It gives that message when health did not pass before the first scan, or when the server refused the first submission. It has removed the file.
   - The receipt is an empty file (0 bytes). The command leaves one when it is stopped from outside, or cannot write the receipt, before its first submission. Remove the empty file. Remove a receipt in no other case.
5. Read the verdict. It reads the committed receipt. For each case it prints the runs, median, spread and tolerance of each metric and each reason against the case. Then it prints each slot, the cases that carry the Guardian's five metrics in the resulting panel, and the next panel or the statement that the panel does not change. It exits 0 for either verdict and 1 when it refuses the receipt.

   ```sh
   npm run toolchain:canary -- verdict \
     --panel-out scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json
   ```

6. If the verdict changes the panel, commit the next panel before any comparison capture. Make the current panel file a copy of the file the verdict wrote, and do not edit either:

   ```sh
   cp scripts/fixtures/toolchain-canary-panels/monthly-toolchain-canary-v2.json \
     scripts/fixtures/toolchain-canary-panel.json
   ```

   In the same commit:
   - Add the new file to `DEVELOPMENT_EXCLUSION_SURFACES` in `scripts/calibration-development-exclusions-lib.mjs`, and add its probe to the test beside that file. That test names the new file until this is done.
   - Add a dated addendum to each dated epoch record that quotes a `compare` command for its own receipts (`docs/toolchain-epoch-2026-09.md`, `docs/toolchain-epoch-2026-10.md` and `docs/toolchain-epoch-2026-11.md`). The addendum says that from this commit the command needs `replay` in place of `compare`.
   - Do not edit or remove an earlier panel file.
7. If the verdict does not change the panel, commit no panel. The inconclusive metrics stay recorded as inconclusive.
8. Complete the staging teardown.
9. Capture the baseline and the candidate of the next epoch from a checkout that holds the new panel, and compare them with `compare`, as in section 3.

Once panel version 2 is current, `qualify` refuses to run: the rule of 2026-11-10 changes panel version 1 only. A later change needs its own rule, fixed before its capture.
