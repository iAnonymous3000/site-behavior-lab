# Toolchain epoch playbook

Use one reviewed toolchain epoch per month to keep measurements representative without severing temporal cohorts for every patch release. Batch the behavior-affecting inputs that intentionally create a new cohort:

- Playwright, its bundled Chromium, and the matching Playwright container tag
- `adblock-rust`, the rebuilt committed WASM, and the disclosed engine version
- `tldts` and the disclosed normalization version
- the container base-image digest and lockfiles

Keep the weekly Brave-list refresh separate. It has its own provenance and validation path; combining it with an epoch would make a failed canary harder to attribute. Cut an urgent epoch outside the monthly cadence for an actively exploitable security issue.

## Release record and boundaries

Before changing pins, record the baseline commit and the exact old/new versions and digests for every item above. Build the candidate as a local commit in a clean checkout. Do not push it yet: pushing `main` starts CI and, if every gate passes, may fast-forward the exact tested commit to the deploy-only `production` branch. `main` is the release-candidate branch; `production` is the deployment boundary.

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

Record the Rust-side generator versions in the release record, rebuild with the locked Cargo graph, copy the complete generated `sbl_adblock_wasm*` set, and prove the committed copies are byte-identical:

```sh
wasm-pack --version
wasm-bindgen --version
wasm-pack build tools/adblock-wasm --mode no-install --target nodejs --release -- --locked
cp tools/adblock-wasm/pkg/sbl_adblock_wasm* lib/adblock-wasm/
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm.js lib/adblock-wasm/sbl_adblock_wasm.js
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm.d.ts lib/adblock-wasm/sbl_adblock_wasm.d.ts
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm_bg.wasm lib/adblock-wasm/sbl_adblock_wasm_bg.wasm
cmp tools/adblock-wasm/pkg/sbl_adblock_wasm_bg.wasm.d.ts lib/adblock-wasm/sbl_adblock_wasm_bg.wasm.d.ts
npm run lists:verify
```

Treat any generated artifact, lockfile, disclosed version, Docker pin, or methodology guard that does not move together as a failed epoch.

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
