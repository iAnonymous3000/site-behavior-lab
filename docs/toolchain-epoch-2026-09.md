# Toolchain epoch 2026-09

The epoch record for issue #9, kept as [the toolchain epoch playbook](./toolchain-epoch.md) asks: the version matrix, the corpus-neutrality result, the exact-build staging A/B, the staging teardown readback, and the publication evidence. It is the first epoch whose staging A/B actually ran.

- Baseline: `cd43c7bce9a980037a74f7ee2a05b722c2638b17` (main and production when the candidate was built)
- Candidate: `c8b189ac59f50121e6f1777dabe12ba4854f6090` (17 commits, pushed to `main` only after the A/B passed)

## Version matrix

| Input | Baseline | Candidate |
| --- | --- | --- |
| Playwright (npm `playwright`, `playwright-core`) | 1.62.1 | 1.63.0 |
| Bundled Chromium | 151.0.7922.34 (r1234) | 153.0.8010.12 (r1243) |
| Container base `mcr.microsoft.com/playwright` | `v1.62.1-noble@sha256:dcc5531e…` | `v1.63.0-noble@sha256:eff16c30…` (amd64 manifest `bc6ab0d6…`, arm64 `a0f44989…`) |
| Container Node / npm | 24.18.1 / 11.16.0 | 24.20.0 / 11.19.0 |
| Seccomp profile | `cc3e61ca…` | unchanged |
| adblock-rust (Cargo.lock) | 0.13.2 (`77420e48…`) | 0.13.3 (`f44b96a6…`) |
| Vendored `sbl_adblock_wasm_bg.wasm` | `aa0df933…`, 2,000,522 bytes | `4034076e…`, 2,006,098 bytes |
| tldts / tldts-core | 7.4.10 | 7.4.13 |
| `package-lock.json` sha256 | `00b2a84e…` | `c6fdff6a…` |

The WASM was built with rustc 1.96.1 (`31fca3adb`), wasm-pack 0.14.0, wasm-bindgen 0.2.126 and wasm-opt 117 (`bin/wasm-opt` `e541f303…`), and a clean rebuild from an empty Cargo target reproduces all four vendored files byte for byte. Inputs were frozen at the tldts 7.4.13 cut; tldts 7.4.14 and 7.4.15 wait for a later epoch.

Measurement identity moves with it: new Node reports record `shields-request-context-v2-adblock-rust-0.13.3-request-method-v1-playwright-1.63.0+subject-validity-v3+detector-coverage-v2` and `tldts@7.4.13`, the producer rows `node-v12-toolchain-2026-09-active-lists-2026-09-21`, `node-v12-toolchain-2026-09-active-no-adblock` and `pagegraph-v4-tldts7413-active` are the active ones, and the node-detectors-v9 rows are closed to their exact literals. Detector versions do not move. The outgoing tldts 7.4.10 normalization stays accepted as a recorded owner exception; which stored reports it orphans, and why that is bounded to the 8 days before the deploy, is in the `SUPERSEDED_R2_NORMALIZATIONS` entry in `lib/scan-report-v2-normalization.ts`.

The container package ledger moves by one row, nodejs 24.18.1 to 24.20.0 (package set `09443a8c…`), synced from a Trivy v0.70.0 inventory of a runner-stage stand-in on the new base. A HIGH/CRITICAL scan of that base found six findings, all in components the runner stage removes (the purged gstreamer plugins and the base image's global npm tree).

## Corpus neutrality

`npm run corpus:audit-neutrality` at the baseline and at the candidate each wrote 981 managed comparison decisions, and the two snapshots are byte-identical (`0fa6bb4f7108f5d5d17ee8323c27c3551b440f592f342823069b6fc1c4af75a5`): zero overall-mode, family-mode and family-reason changes. The published corpus overview, status snapshot, category pages and directory match the baseline except the status snapshot's installed Playwright and ad-block engine versions.

## Staging A/B

Both builds ran on the isolated staging Worker `site-behavior-lab-scanner-staging` at `https://scan-staging.sitebehavior.org`, one standard-2 container, token-gated, with the staging-only R2 bucket. Authenticated health reported the exact deployment SHA, status ok, no warnings, the Chromium sandbox, the ad-block engine, public r2 reports and a ready durable lane before each capture. Both captures ran from candidate checkouts against the committed panel `monthly-toolchain-canary-v1` (5 sites, 3 repetitions, egress `WNAM/pdx03/US` for every run): the baseline from `fb85f510`, the candidate from `c8b189ac`. The canary code differs only in comments between those two commits, and both receipts carry panel digest `86fe39f8e4e75e9a2925c1849006909968b67bc507d2aec6cb688ce9cc22be29`.

| | Baseline | Candidate |
| --- | --- | --- |
| Build | `cd43c7bc` | `c8b189ac` |
| Order | forward | reverse |
| Runs | 15 | 15 |
| Browser | 151.0.7922.34 | 153.0.8010.12 |
| Receipt sha256 | `2376cac67750ec6311a2e9d07d7fed7d0a505d9bc5b6cf42d32e3fd421111e91` | `0f90b984003b3b9d7ed60a2c0fdd61eff3b6271e75b20608a5c7bd9ff191a8fb` |

The receipts are committed beside this record in [`toolchain-epoch-2026-09/`](./toolchain-epoch-2026-09/). Re-run the comparison from a checkout of the candidate:

```sh
npm run toolchain:canary -- compare \
  --baseline docs/toolchain-epoch-2026-09/baseline-receipt.json \
  --candidate docs/toolchain-epoch-2026-09/candidate-receipt.json
```

Result:

```text
LEFT OUT guardian.fingerprintEvents: every run of both builds records fingerprinting capture loss
PASS cd43c7bce9a980037a74f7ee2a05b722c2638b17 -> c8b189ac59f50121e6f1777dabe12ba4854f6090: all 44 compared fixed-panel medians are within tolerance; 1 left out for shared capture loss.
```

36 of the 44 compared medians are identical across the two builds. The 8 that moved are all on theguardian.com, the one ad-heavy live page, and each is inside its committed tolerance:

| Metric | Baseline | Candidate | Delta | Allowed |
| --- | --- | --- | --- | --- |
| totalRequests | 202 | 182 | 20 | 40.4 |
| thirdPartyRequests | 169 | 152 | 17 | 42.25 |
| knownTrackerRequests | 30 | 27 | 3 | 9 |
| thirdPartyDomains | 30 | 29 | 1 | 7.5 |
| cookies | 22 | 23 | 1 | 6.6 |
| thirdPartyCookies | 6 | 5 | 1 | 3 |
| storageEntries | 24 | 26 | 2 | 7.2 |
| shieldsBlockedRequests | 78 | 69 | 9 | 23.4 |

Two panel sites carry a capture loss on every run of both builds: github.com a keystroke-probe truncation (detector output, which no canary metric is counted from) and theguardian.com the node-detectors-v9 fingerprint listener-attribution loss. The canary's original gate refused any capture loss, so the baseline build itself could not produce a receipt. Before any receipt existed and without scanning the candidate, the gate was changed to compare capture loss like with like and the panel was kept, because the same fingerprint loss fires on nearly every ad-heavy site (Fox News, BBC and USA Today were probed) and a clean-only panel would have dropped the tracker, cookie and fingerprint coverage the canary exists for. The consequence is that `fingerprintEvents` is compared only on the four lighter sites, where both builds record 0.

Getting a buildable staging image took three fixes that belong to this environment, not the epoch: the build host's DNS resolvers fail for ubuntu.com, so the two apt mirrors were pinned with `--add-host` for the image build only; Docker Desktop stopped once while exporting an image and was restarted; and the in-image `npm run check` failed a wall-clock test under amd64 emulation until the test was timed from the synthetic's first request instead of its spawn (commit `c8b189ac`).

## Staging teardown

Torn down with Wrangler and read back on 2026-09-24 (UTC), after the comparison:

- Worker `site-behavior-lab-scanner-staging` deleted; the API now returns code 10007 ("This Worker does not exist").
- Container application `a0357313-98f0-42a6-a6fa-6bfd2351d76e` deleted; no staging container application is listed.
- The two staging images this epoch pushed (`f88bcc3f`, `224ea2a9`) deleted from the managed registry.
- `scan-staging.sitebehavior.org` has no DNS records and no longer accepts HTTPS connections.

Remaining cleanup completed and read back on 2026-09-24 (UTC):

- Revoked the bucket-scoped R2 API token `sbl-staging-toolchain-canary` (ID `4bcca63e421d56cd95b3fd5bebfba48a`) in the dashboard after verifying its ID. It no longer appears in the account API-token list.
- The staging bucket still contained objects, so an initial delete request refused with code 10008. Emptied `site-behavior-lab-reports-staging`, verified the dashboard's empty object list, then deleted the bucket. `npx wrangler r2 bucket list` lists `site-behavior-lab-reports` and no staging bucket. The production bucket was not modified.
- Deleted the older image `site-behavior-lab-scanner-staging-container:ceb57f4b` (digest `sha256:8760fc67b3f0aaeb659ca71b1ff3d9f4b8677ef049ab089076f6452f30c107df`). The subsequent `npx wrangler containers images list` returned no rows containing `staging`.
- The complete Durable Objects dashboard inventory shows one namespace, belonging to the production Worker. There is no namespace for `site-behavior-lab-scanner-staging` and no surviving namespace `ccdbebe9ddf14aefabbd0cca1a16ede2`. No namespace was deleted during this readback.
- The `sitebehavior.org` Edge Certificates inventory has no certificate dedicated to `scan-staging.sitebehavior.org`. It lists an Advanced certificate for `*.scan.sitebehavior.org`, `scan.sitebehavior.org`, and `sitebehavior.org`, plus shared Universal and Backup certificates for `*.sitebehavior.org` and `sitebehavior.org`. All were left unchanged.
- An exact DNS search for `scan-staging.sitebehavior.org` returned no records. The complete Workers custom-domain API inventory returned two entries and no match for that hostname. The zone's Workers Routes page also has no routes configured.
- Deleted `~/.sbl-staging/scan-access-token` without reading its contents, removed the empty `~/.sbl-staging` directory, and verified both are absent. Ran `npx wrangler logout` from the repository; Wrangler confirmed successful logout.

Not yet done, and not claimed:

- This is not the canonical twelve-resource teardown receipt from [the go-live runbook](./go-live-public-scanner.md), which needs the hosted adapter, six scoped read credentials and protected-environment approval.

## Publication

The candidate was pushed to `main` as a fast-forward from `cd43c7bc` only after the A/B passed and staging was torn down, with `main` re-read as the recorded baseline immediately before.

- CI run [35937344107](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/35937344107) at `c8b189ac` succeeded (2026-09-24 00:12 to 00:36 UTC). On the exact deployable image its container job passed the Trivy HIGH/CRITICAL scan, the package-review coverage check (the ledger synced from the stand-in matched the real image's inventory exactly), the security and package-evidence enforcement step, and published the tested image; the exact-SHA evidence manifests were attested.
- [Promote Production](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/35939192077) advanced `production` to `c8b189ac`, and [Deploy Tested Container](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/35939187275) and [Deploy Tested Pages](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/35939187225) succeeded.
- Live readback: `https://scan.sitebehavior.org/api/health` reports deployment `c8b189ac59f50121e6f1777dabe12ba4854f6090`, status ok, no warnings, and `https://sitebehavior.org/deployment.json` names the same SHA.
- The governed [Production Health](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/35939857974) lane succeeded against the new production build. A dispatched [Scanner Fidelity](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/35939868726) run (single, desktop), which builds and scans the checked-out `c8b189ac` on a GitHub runner rather than calling production, also succeeded: the real-site acceptance check on Chromium 153.
