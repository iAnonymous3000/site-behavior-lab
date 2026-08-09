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
- scans the exact `site-behavior-lab:smoke` image after both Docker smoke lanes;
  then runs a separate standard-license pass over every OS package in that
  already-smoked image.

Both fixed and unfixed HIGH/CRITICAL Trivy findings fail their jobs. Scanner
steps continue only far enough to upload machine-readable JSON; explicit final
steps turn every scanner, JSON-validation, or artifact-upload failure back into
a blocking result. Action caches are disabled and database updates are
mandatory. The first real GitHub run still has to prove outbound advisory/DB
access and the current absence of findings; static workflow tests cannot supply
that receipt.

The digest-pinned Playwright base is verified at Node 24.18.1/npm 11.16.0 and
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
`package-lock.json`, both checked Cargo files, the pinned 31-list metadata, and
the canonical `scripts/github-cli-build-tool-manifest.json` declaration.
`npm run supply-chain:third-party:check` recomputes it and rejects byte drift.
It records the evidence present in those files, including package versions,
registry integrity/checksums, filter URLs, byte counts, and SHA-256 identities.

The downloaded-tool entry is GitHub CLI 2.96.0, used only to verify artifact
attestations when a build host does not provide the exact CLI. The inventory
binds the immutable upstream release and tagged MIT license, the upstream
checksum manifest, and the exact Linux x64/arm64 and macOS x64/arm64 archive
URLs, archive SHA-256 digests, and extracted `gh` binary SHA-256 digests. The
bootstrap and generated inventory both parse that same strict canonical
manifest; neither carries an independent copy of the trust pins. The entry
explicitly records `usage: "build-only"`, `runtime: false`, and
`redistributed: false`: the downloaded verifier is not part of either shipped
runtime. Its separate `downloaded-tool` review row is created as `unreviewed`,
like every other new inventory item; the declared MIT identifier is upstream
evidence, not a substituted human legal determination.

Bootstrap reads the response stream under a 64 MiB ceiling before accepting
the archive digest, then extracts only the expected `bin/gh` bytes with the
bounded Node gzip/tar or ZIP parser; `tar`, `unzip`, and other PATH extraction
tools are never invoked. PATH candidates and the cache output must be
canonical absolute regular files. Cache parents must be owned, non-writable by
group/other, and free of symlinks; installation uses an exclusive no-follow
temporary, verifies it, and creates the final name with an atomic no-clobber
hard link. An existing file, symlink, directory, or racing destination is
refused rather than replaced.

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
carries from the inventory: 61 of the 149 npm entries are not marked
development-only in `package-lock.json`.

## Exact container OS-package inventory

Container system packages stay outside `THIRD_PARTY_INVENTORY.json` and
`THIRD_PARTY_REVIEWS.json`. Those files are deterministic source inventories;
an OS package set is instead a property of one platform-specific final image,
its immutable base, and every runtime-stage filesystem change.

After Docker smoke, CI runs a second pinned Trivy v0.70.0 image pass with the
standard license scanner, OS-only package scope, and `list-all-pkgs`. The raw
`trivy-container-image-licenses.json` is preserved with the vulnerability JSON
as diagnostic scanner output, but it is not canonical evidence: Trivy includes
per-run fields such as `ReportID`, `CreatedAt`, target names, and moving tags.

`npm run supply-chain:container-inventory` reduces that report to
`site-behavior-lab-container-package-inventory.json`. It refuses the report
unless its exact image ID, ordered rootfs diff IDs, operating system,
architecture, and source commit match the independently generated container
release-evidence manifest. The canonical artifact records sorted package
name/version/architecture/source-package/license facts, a SHA-256 evidence
digest per row, and a SHA-256 digest over the exact package array. Timestamp,
tag, target, and scanner-report IDs are deliberately omitted.

`CONTAINER_IMAGE_PACKAGE_REVIEWS.json` is the separate human ledger for those
rows. `npm run supply-chain:container-reviews:sync -- --inventory <path>` adds
new facts as `unreviewed`, drops absent rows, and resets a determination when
its package evidence digest changes. It never invents a license conclusion.
`npm run supply-chain:container-reviews:check -- --inventory <path>` fails CI
on a missing, orphaned, duplicate, malformed, or stale row. Tracked
`unreviewed` rows remain mergeable and are reported as incomplete; legal
review completeness remains a release gate rather than making every ordinary
pull request depend on a later human review. The checker accepts only the
canonical ledger, row, and obligation fields, refuses future review dates, and
exports a readiness validator that returns the exact candidate commit,
container image digest, canonical inventory digest, and package-set digest
only alongside the completeness verdict.

The initial 512 unreviewed rows were mechanically seeded from a
checksum-verified Trivy v0.70.0 scan of the digest-pinned Playwright base, with
the two packages explicitly purged by the runtime Dockerfile removed. That
bootstrap is not trusted as final-image proof: every CI run rescans the actual
smoke-tested final image and fails if its exact package evidence differs.

This ledger covers OS package-manager records. It does not claim that arbitrary
unmanaged Chromium/Playwright files are OS packages, replace the source
inventory for npm/Cargo/filter inputs, or by itself prove that distribution
obligations are satisfied. A reviewed row must record a substantive
determination with at least one authoritative license-evidence reference,
including when no distribution obligations apply. Any obligations use
separate structured dispositions and evidence references; the release-level
legal attestation remains separate.

Every legal evidence reference is content-addressed. The only accepted forms
are `repo:<normalized-relative-path>#sha256=<64-lowercase-hex>` and a canonical,
credential-free, query-free
`https://<dns-name>/<path>#sha256=<64-lowercase-hex>` URL. A label such as
`x`, a dashboard pointer, a moving URL, or a bare filesystem path is rejected.
The exact-image licensing producer reopens every `repo:` target beneath the
real repository root, refuses symlinks and non-files, bounds its size, and
checks its exact bytes against the reference digest. It also requires the same
path and digest to exist as a Git blob at the exact reviewed candidate commit;
an untracked, post-candidate, or disappearing working-tree file is not release
evidence. The licensing receipt enumerates the complete canonical evidence set
and binds its digest and candidate-resident repository paths. The repository
root is an explicit validator dependency and never falls back to the process
working directory. HTTPS references remain explicit content commitments for
legal review; their canonical URL and digest are bound by the review-ledger
digest, but the local producer does not fetch or runtime-authenticate the remote
HTTPS content.

The measurement-candidate binding repeats that check at the release boundary:
it digest-binds the final review ledger, enumerates a unique sorted
`packageLegalEvidence` entry for every `repo:` reference in both license and
obligation rows, and requires each entry to be byte-identical to its
candidate-resident Git blob. The review ledger is an explicitly enumerated
post-candidate evidence modification; the referenced legal files are frozen at
the candidate. A local or untracked file therefore cannot become release
evidence merely because the licensing producer could read it.

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
`3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` and `actions/attest` v4.2.1 at
reviewed commit `508db95dd578ae2727ebd6217d5ba78e4fbda05d`. It downloads the artifact
names for the current `github.sha`, parses both receipts plus the normalized
package inventory, and rejects any source mismatch. It independently
recomputes the package-row and package-set digests and cross-checks the
inventory's image ID, platform, and rootfs layers against the container
receipt. It then creates separate attestations whose exact subjects are:

- `site-behavior-lab-static-release-evidence.json`;
- `site-behavior-lab-container-release-evidence.json`; and
- `site-behavior-lab-container-package-inventory.json`.

The resulting Sigstore bundles, attestation IDs, and GitHub URLs are preserved
for 90 days as `exact-sha-provenance-attestations-<sha>`. Promotion depends on
this job.

This boundary is deliberate. The attested subjects are three JSON evidence
artifacts, not the static output directory, the smoke-tested OCI image, a
registry image, the raw Trivy reports, or either Cloudflare deployment. The
subjects bind and describe those tested bytes, but attesting a manifest does
not transitively turn each referenced artifact into an attestation subject and
does not prove that Cloudflare deployed it.

The workflow contract is statically tested, but no local run can prove that
GitHub accepted, stored, and can independently return these attestations for
this repository. Before treating the gate as operational release evidence,
the first successful live `main` CI run must preserve all three bundles and an
operator must independently read back and verify all three evidence subjects
against `iAnonymous3000/site-behavior-lab`. That live receipt/readback remains
an external release gate until it actually succeeds.
