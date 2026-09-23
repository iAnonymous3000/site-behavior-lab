# Toolchain epoch playbook

Use one reviewed toolchain epoch per month to keep measurements representative without severing temporal cohorts for every patch release. Batch the behavior-affecting inputs that intentionally create a new cohort:

- Playwright, its disclosed `NODE_PLAYWRIGHT_VERSION`, bundled Chromium, and matching Playwright container tag
- `adblock-rust`, the rebuilt committed WASM, and the disclosed engine version
- `tldts` and the disclosed normalization version
- the container base-image digest and lockfiles

Keep the weekly Brave-list refresh separate. It has its own provenance and validation path; combining it with an epoch would make a failed canary harder to attribute. Cut an urgent epoch outside the monthly cadence for an actively exploitable security issue.

## Release record and boundaries

Before changing pins, record the baseline commit and the exact old/new versions and digests for every item above. Build the candidate as a local commit in a clean checkout. Do not push it yet: pushing `main` starts CI and, if every gate passes, may fast-forward the exact tested commit to the deploy-only `production` branch. `main` is the release-candidate branch; `production` is the deployment boundary.

Every Node report must carry the exact Playwright pin in its methodology provenance. The provenance guard ties that recorded constant to `package.json`, `package-lock.json`, the installed package, and the digest-pinned container base. The report UI renders Playwright separately from Chromium because a Playwright patch may intentionally keep the same browser build.

The gate has two distinct checks:

1. The committed corpus must expose exactly the same canonical comparison decisions. This is a zero-flip policy.
2. Two exact staging builds must scan the committed five-site panel, in opposite order, with three repetitions. Local receipts compare per-site medians against the committed tolerances.

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

The contract binds the SHA-256 of the Cargo inputs and all four outputs, so it moves with any rebuilt byte. `--print` regenerates it from the verifier's constants without checking the binary markers, so if the epoch moves rustc and cargo, wasm-pack, wasm-bindgen or wasm-opt (a wasm-pack move can move wasm-opt, whose binaryen version wasm-pack hardcodes), first update `RUSTC_COMMIT`, `WASM_BINDGEN_VERSION`, `WASM_OPT_VERSION` and every `requiredBuild` pin in `scripts/verify-wasm-reproducibility.mjs`, including `wasmPack`, `rustc` and `cargo`, together with their assertions in `lib/wasm-reproducibility.test.ts`. Then run:

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
wasm-pack build tools/adblock-wasm --mode no-install --target nodejs --release -- --locked 2> /private/tmp/toolchain-wasm-build.log
grep -F 'Compiling sbl-adblock-wasm' /private/tmp/toolchain-wasm-build.log
grep -F 'Installing wasm-bindgen...' /private/tmp/toolchain-wasm-build.log
grep -F 'Optimizing wasm binaries with `wasm-opt`' /private/tmp/toolchain-wasm-build.log
! grep -F 'found wasm-opt at' /private/tmp/toolchain-wasm-build.log
cp tools/adblock-wasm/pkg/sbl_adblock_wasm* lib/adblock-wasm/
node scripts/verify-wasm-reproducibility.mjs --print > tools/adblock-wasm/reproducibility-contract.json
npm run lists:verify
```

Review the contract diff and commit the vendored set and the contract together. Then prove them from a clean target without copying:

```sh
test -z "$(command -v wasm-opt)"
test -z "$(command -v wasm-bindgen)"
rm -rf tools/adblock-wasm/pkg tools/adblock-wasm/target
wasm-pack build tools/adblock-wasm --mode no-install --target nodejs --release -- --locked 2> /private/tmp/toolchain-wasm-rebuild.log
grep -F 'Compiling sbl-adblock-wasm' /private/tmp/toolchain-wasm-rebuild.log
grep -F 'Installing wasm-bindgen...' /private/tmp/toolchain-wasm-rebuild.log
grep -F 'Optimizing wasm binaries with `wasm-opt`' /private/tmp/toolchain-wasm-rebuild.log
! grep -F 'found wasm-opt at' /private/tmp/toolchain-wasm-rebuild.log
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
npm run corpus:audit-neutrality -- snapshot --out /private/tmp/toolchain-baseline-neutrality.json

cd /path/to/candidate
npm ci
npm run corpus:audit-neutrality -- snapshot --out /private/tmp/toolchain-candidate-neutrality.json
npm run corpus:audit-neutrality -- compare \
  --baseline /private/tmp/toolchain-baseline-neutrality.json \
  --candidate /private/tmp/toolchain-candidate-neutrality.json
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
  --out /private/tmp/toolchain-baseline-receipt.json \
  --confirm I_ACKNOWLEDGE_THIS_SUBMITS_LIVE_STAGING_SCANS
```

Deploy the clean candidate checkout to the same isolated staging origin, then capture it in reverse site order:

```sh
npm run cf:container:staging:deploy
npm run toolchain:canary -- capture \
  --expected-build <candidate-40-character-sha> \
  --order reverse \
  --out /private/tmp/toolchain-candidate-receipt.json \
  --confirm I_ACKNOWLEDGE_THIS_SUBMITS_LIVE_STAGING_SCANS
```

Compare the two local, create-only receipts:

```sh
npm run toolchain:canary -- compare \
  --baseline /private/tmp/toolchain-baseline-receipt.json \
  --candidate /private/tmp/toolchain-candidate-receipt.json
```

The command fails closed on degraded or stale health, missing sandbox/R2/durable staging attestations, incomplete quality, subject or egress drift, mixed provenance inside a capture, incomplete panel coverage, or a median outside the committed absolute/relative tolerance. It submits ordinary token-gated single scans only; it never sends the staging fault-injection headers. Receipts are mode `0600`, stay outside `public/`, contain no access token, and record the exact staging report IDs for audit and teardown.

An external site can change during the run. A tolerance failure therefore means stop and investigate, not automatically "toolchain regression." Re-run the complete matched panel only after confirming the same staging region and stable subjects. If it fails again, bisect the batched upgrades. Do not relax a tolerance or edit the panel to make the current epoch pass; review such changes before a future baseline capture.

Always complete the staging teardown and readback receipt in the go-live runbook, including removal of the staging token, Worker/container resources, and staging R2 objects. Production remains untouched throughout this gate.

## 4. Publish and verify

Immediately before publication, fetch again and confirm `origin/main` is still the recorded baseline. If it moved, rebase the candidate, rerun the affected static/corpus gates, and repeat the exact-build canary when any behavior-affecting input changed.

After pushing the candidate:

- verify required CI completed for the exact candidate SHA;
- verify the production deployment reference resolves to that SHA;
- read authenticated/live health and require the exact deployment marker with no warnings;
- retain the version matrix, corpus snapshots, canary receipts, teardown receipt, and CI/deployment links as the epoch record.

Do not call an epoch complete from green source tests alone. Completion requires exact-artifact provenance, zero corpus-decision flips, a passing staging A/B, isolated-staging teardown, and exact-SHA production readback.
