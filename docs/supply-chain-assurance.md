# Supply-chain assurance gates

This document separates checks the repository can enforce automatically from
release claims that still require an externally verified build or service.

## Enforced CI checks

The `Supply-chain Security` CI job is a required production-promotion
dependency. It uses exactly Node 24.14.1 and npm 11.11.0, then:

- pings the live npm registry and performs a fresh, all-severity JSON audit of
  the lockfile;
- installs cargo-audit 0.22.1 from its locked package, creates a unique RustSec
  database checkout for the run, denies vulnerabilities and warnings, and
  preserves JSON;
- runs Trivy v0.70.0 through the reviewed immutable v0.36.0 action commit over
  the repository, lockfiles, secrets, and configuration; and
- scans the exact `site-behavior-lab:smoke` image after both Docker smoke lanes.

Both fixed and unfixed HIGH/CRITICAL Trivy findings fail their jobs. Scanner
steps continue only far enough to upload machine-readable JSON; explicit final
steps turn every scanner, JSON-validation, or artifact-upload failure back into
a blocking result. Action caches are disabled and database updates are
mandatory. The first real GitHub run still has to prove outbound advisory/DB
access and the current absence of findings; static workflow tests cannot supply
that receipt.

The digest-pinned Playwright base is verified at Node 24.18.0/npm 11.16.0 and
Dockerfile assertions fail the build if those base versions drift. The runtime
stage then removes the base's global npm/yarn/corepack (whose bundled tar,
undici, and sigstore copies would otherwise ship as unexecuted vulnerable
code) and the WebKit-only GStreamer "bad" plugins. Release evidence executes
the node version command from the exact inspected image ID with `--pull=never`,
no network, a read-only root filesystem, all capabilities dropped, and
no-new-privileges, and separately asserts that no npm binary answers from that
image. This is a verified-but-distinct container runtime, not
parity with the Node 24.14.1/npm 11.11.0 host and Actions toolchain.

## Third-party inventory

`THIRD_PARTY_INVENTORY.json` is generated deterministically from
`package-lock.json`, both checked Cargo files, and the pinned 31-list metadata.
`npm run supply-chain:third-party:check` recomputes it and rejects byte drift.
It records the evidence present in those files, including package versions,
registry integrity/checksums, filter URLs, byte counts, and SHA-256 identities.

The inventory is deliberately not named a notices file. Cargo.lock proves no
licenses for its 68 third-party packages, and the filter metadata proves no
licenses for its 31 sources; those entries remain `UNKNOWN`. A legal review
must locate authoritative terms, decide redistribution/notice/source-offer
obligations, and add any required license texts before a critical release.

That review now has a place to land: `THIRD_PARTY_REVIEWS.json` keeps one row
per inventory item (ecosystem, name, exact version; a bump is a new row that
re-enters review). `npm run supply-chain:reviews:sync` creates missing rows as
`unreviewed` and never touches reviewed rows; a human review fills reviewer,
review date, the determined license, and the obligations list, and flips the
row to `reviewed`. CI runs `npm run supply-chain:reviews:check`, which fails
when the ledger drifts from the inventory or a reviewed row is incomplete, so
a new dependency cannot merge without at least an explicit unreviewed row.
Review COMPLETENESS is reported per ecosystem but gated only at release
readiness, not per commit. Note the runtime/development split the ledger
carries from the inventory: 61 of the 148 npm packages ship at runtime, and
the container base image's system packages remain outside both files, tracked
only by its pinned digest.

## Vendored adblock WASM

`tools/adblock-wasm/reproducibility-contract.json` deterministically binds the
three checked Rust inputs and all four runtime WASM/JavaScript outputs by byte
count and SHA-256. `npm run wasm:verify-reproducibility` fails when any bound
file or any blocker policy changes without a reviewed contract update.

That check is an integrity contract, not a reproducible-build receipt. The
current binary identifies rustc 1.96.1 commit
`31fca3adb283cc9dfd56b49cdee9a96eb9c96ffd` and wasm-bindgen 0.2.126, but it
also embeds the original host's Cargo registry paths. The historical build did
not record a separately verifiable wasm-pack/wasm-bindgen CLI invocation, and
CI does not rebuild the binary. A local offline rebuild reached the locked Rust
compile and then could not run the missing generator without installing it, so
the committed bytes cannot currently be derived from checked inputs alone.

Do not call this artifact reproducible until one reviewed change does all of
the following:

1. Pins rustc 1.96.1, Cargo 1.96.1, wasm-pack 0.14.0, wasm-bindgen CLI 0.2.126,
   and the `wasm32-unknown-unknown` target from independently reviewed sources.
2. Builds with `Cargo.lock`, a fixed source-date policy, and fixed path-prefix
   remapping so host paths cannot enter the output.
3. Produces identical bytes in two clean isolated builds, then replaces all
   four vendored generated files together.
4. Makes CI perform the clean rebuild and byte comparison before the static
   integrity contract can change from `blocked`.

Legal review is separate: byte reproducibility does not establish that the
bundled engine or filter-list corpus satisfies every notice or redistribution
obligation.

## GitHub artifact attestations

The separate `Attest exact-SHA evidence manifests` job runs only for a
non-pull-request workflow on `main`, after the supply-chain, app, Docker, and
Chromium smoke jobs pass. Candidate code is never checked out or executed in
that job. Its permissions are exactly `contents: read`, `id-token: write`,
`attestations: write`, and `artifact-metadata: write`, so pull-request code does
not receive OIDC or attestation authority.

The job uses `actions/download-artifact` v8.0.1 at reviewed commit
`3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` and `actions/attest` v4.2.0 at
reviewed commit `f7c74d28b9d84cb8768d0b8ca14a4bac6ef463e6`. It downloads the artifact
names for the current `github.sha`, parses both receipts, and rejects either
unless `source.commit` equals that SHA. It then creates separate attestations
whose exact subjects are:

- `site-behavior-lab-static-release-evidence.json`; and
- `site-behavior-lab-container-release-evidence.json`.

The resulting Sigstore bundles, attestation IDs, and GitHub URLs are preserved
for 90 days as `exact-sha-provenance-attestations-<sha>`. Promotion depends on
this job.

This boundary is deliberate. The attested subjects are the two JSON evidence
manifests, not the static output directory, the smoke-tested OCI image, a
registry image, or either Cloudflare deployment. The manifests bind and
describe those tested bytes, but attesting a manifest does not transitively
turn each referenced artifact into an attestation subject and does not prove
that Cloudflare deployed it.

The workflow contract is statically tested, but no local run can prove that
GitHub accepted, stored, and can independently return these attestations for
this repository. Before treating the gate as operational release evidence,
the first successful live `main` CI run must preserve both bundles and an
operator must independently read back and verify both evidence manifests
against `iAnonymous3000/site-behavior-lab`. That live receipt/readback remains
an external release gate until it actually succeeds.
