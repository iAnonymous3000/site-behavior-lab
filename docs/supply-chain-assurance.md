# Supply-chain assurance gates

This document separates checks the repository can enforce automatically from
release claims that still require an externally verified build or service.

## Licenses: what is recorded and what is not

Third-party items and the container image's OS packages are inventoried with
their declared licenses, and the inventories are checked by machine. No human
license review has been performed, of the third-party items or of the
container packages. What a package's metadata or a scanner says about a
license is evidence, not a legal conclusion. No release gate asks for a
license review, and release 1.0 does not claim one. The sections below give
the detail: `THIRD_PARTY_INVENTORY.json` for source dependencies, the signed
container package inventory for the image, and
`CONTAINER_IMAGE_PACKAGE_REVIEWS.json`, which is a record of the image's
package set with every row `unreviewed`, not a release requirement.

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

The digest-pinned Playwright base is verified at Node 26.13.0/npm 11.20.0 and
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
runtime. The declared MIT identifier is upstream evidence, like every other
declared license in the inventory, not a human legal determination.

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
licenses for its 65 third-party packages, and the filter metadata proves no
licenses for its 31 sources; those entries remain `UNKNOWN`.

No human license review has been performed. The third-party items are
inventoried with the licenses their own metadata declares, and CI checks the
committed inventory by machine against the files it is generated from, so a
new or bumped dependency cannot merge without its inventory row. A declared
license is evidence of what a package says about itself. It is not a legal
conclusion. Nobody has located authoritative terms for the `UNKNOWN` entries,
decided redistribution, notice or source-offer obligations, or collected
license texts. Release 1.0 does not require that review and does not claim
it.

Until 2026-11-11 the repository carried `THIRD_PARTY_REVIEWS.json`, a ledger
with one row per inventory item for a human determination, and a 1.0 release
gate that required every runtime row to be reviewed. No row was ever
reviewed. The gate and the ledger were removed together, because a gate whose
only evidence is one maintainer's sign-off adds no independent assurance.
The inventory records the runtime and development split:
77 of the 168 npm entries are not marked
development-only in `package-lock.json`.

## Exact container OS-package inventory

Container system packages stay outside `THIRD_PARTY_INVENTORY.json`. That
file is a deterministic source inventory;
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

No human license review of these packages has been performed. The inventory
records the licenses Trivy detected for each package, and that scanner output
is evidence, not a legal conclusion. The inventory itself is checked by
machine: its producer refuses a report that does not match the image, CI signs
its exact bytes, and a 1.0 evidence carrier must bind it with that signature.

`CONTAINER_IMAGE_PACKAGE_REVIEWS.json` is the separate ledger that was meant
to hold a human determination for each of those rows. As of 2026-11-11 every
row is `unreviewed`. `npm run supply-chain:container-reviews:sync -- --inventory <path>` adds
new facts as `unreviewed`, drops absent rows, and resets a determination when
its package evidence digest changes. It never invents a license conclusion.
`npm run supply-chain:container-reviews:check -- --inventory <path>` fails CI
on a missing, orphaned, duplicate, malformed, or stale row. Tracked
`unreviewed` rows remain mergeable and are reported as incomplete. The checker
accepts only the canonical ledger, row, and obligation fields, refuses future
review dates, and exports a readiness validator that returns the exact
candidate commit, container image digest, canonical inventory digest, and
package-set digest only alongside the completeness verdict.

Release 1.0 no longer reads this ledger row by row. The
`container-package-review` gate, which required every row to be reviewed, was
removed on 2026-11-11, and a 1.0 evidence carrier no longer binds the ledger.
The `container-image-licensing` gate, which asked an operator to attest that
the review was complete and every distribution obligation met, was removed
the same day. Release 1.0 therefore requires no license review of the image,
by row or by attestation, and none has been performed. The ledger and its CI
check remain because two other things depend on them. The check is the only step that fails CI when the final
image's OS package set differs from the committed rows. And the research
programme's measurement-candidate binding digest-binds the ledger, as
described below.

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
separate structured dispositions and evidence references. No release reads
those rows today: the ledger is a record of the image's package set, not a
release requirement.

Every legal evidence reference is content-addressed. The only accepted forms
are `repo:<normalized-relative-path>#sha256=<64-lowercase-hex>` and a canonical,
credential-free, query-free
`https://<dns-name>/<path>#sha256=<64-lowercase-hex>` URL. A label such as
`x`, a dashboard pointer, a moving URL, or a bare filesystem path is rejected.
The exact-image licensing producer
(`npm run ops:evidence:container-licensing`) serves the research programme's
contract only. Release 1.0 has no gate that reads its receipt, and a 1.0
evidence carrier that binds the receipt is refused. It reopens every `repo:` target beneath the
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
`31fca3adb283cc9dfd56b49cdee9a96eb9c96ffd` and, in its `producers` section,
the wasm-bindgen 0.2.130 CLI that processed it (since 0.2.129 the binary no
longer embeds the wasm-bindgen crate's own source path, which the 0.2.126
binary carried), but it also embeds the building host's Cargo registry paths.
The wasm-bindgen 0.2.130 rebuild of adblock-rust 0.13.5 recorded its wasm-pack
command and generator versions in the commit that vendored it, and clean
rebuilds with that command on that host produced the vendored bytes. wasm-pack
installs that CLI with an unlocked `cargo install`, so the walrus it links
is resolved on the day of the install and pinned by nothing checked in. The
contract declares the walrus the current binary records in its `producers`
section (0.27.3), and verification fails for a binary that records another.
Those bytes also depend on wasm-opt. wasm-pack 0.14.0
downloads binaryen `version_117` from the upstream GitHub release into its
local tool cache and verifies no checksum; with no cached copy and
`--mode no-install` it skips wasm-opt and writes different bytes. The cached
copy on the host that built the vendored set (arm64-macos), with which a rebuild
reproduces all four vendored files, has `bin/wasm-opt` SHA-256
`e541f303219f9b6caa1661daea44510249da278736b7f2e320910051e7bbd4cd` and
`lib/libbinaryen.dylib` SHA-256
`9dc88d02f1aa84de40a8e8dbe5f3a023a8b5bcafaf1308ae20926ab425c533fb`; neither
has been checked against the upstream release. The contract declares
`wasmOpt` 117 and names that unverified download as a blocker, but the WASM
records no wasm-opt marker, so that entry binds the documented toolchain, not
observed bytes. The toolchain epoch playbook records the version and hashes
and requires the build log to show wasm-opt ran. CI does not rebuild the
binary, so the committed bytes cannot currently be derived from checked inputs
alone.

Do not call this artifact reproducible until one reviewed change does all of
the following:

1. Pins rustc 1.96.1, Cargo 1.96.1, wasm-pack 0.14.0, wasm-bindgen CLI 0.2.130,
   wasm-opt (binaryen `version_117`), and the `wasm32-unknown-unknown` target
   from independently reviewed sources.
2. Builds with `Cargo.lock`, a fixed source-date policy, and fixed path-prefix
   remapping so host paths cannot enter the output.
3. Produces identical bytes in two clean isolated builds, then replaces all
   four vendored generated files together.
4. Makes CI perform the clean rebuild and byte comparison before the static
   integrity contract can change from `blocked`.

Legal review is separate, and none has been performed: byte reproducibility does not establish that the
bundled engine or filter-list corpus satisfies every notice or redistribution
obligation.

## GitHub artifact attestations

The separate `Attest exact-SHA evidence manifests` job runs only for a
non-pull-request workflow on `main`, after the supply-chain, app, Docker, and
Chromium smoke jobs pass. Candidate code is never checked out or executed in
that job. Its permissions are exactly `contents: read`, `id-token: write`,
`attestations: write`, and `artifact-metadata: write`, so pull-request code does
not receive OIDC or attestation authority.

The job uses `actions/download-artifact` v8.0.2 at commit
`9000827ccba6bdab643e8b6fd33ac0654aef8333` and `actions/attest` v4.2.2 at
reviewed commit `1e69f48acb82d1966a394da916b4c1698aa569d6`. It downloads the artifact
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

This boundary is deliberate. Those three attested subjects are JSON evidence
artifacts, not the static output directory, the smoke-tested OCI image, a
registry image, the raw Trivy reports, or either Cloudflare deployment. The
subjects bind and describe those tested bytes, but attesting a manifest does
not transitively turn each referenced artifact into an attestation subject and
does not prove that Cloudflare deployed it.

The same job signs one more subject and keeps it apart from those three:
`site-behavior-lab-formal-verification-report.json`, the execution report the
`formal-verification` job writes with `npm run release:formal-verification-report` and
preserves as `exact-sha-formal-verification-report-<sha>` (see
[docs/v1-release-qualification.md](v1-release-qualification.md)). The job
checks the report's kind and version, that it names the current `github.sha`,
and that its bytes are canonical, then attests it and preserves the bundle for
90 days as `exact-sha-formal-verification-attestation-<sha>`. It does not run
the suites again or judge the report's content: the producer writes a report
only after its own run met the release gate's rule, and the gate judges the
content again when a carrier binds it. The signature shows that the `attest`
job of a `main` CI run at that commit signed those exact bytes. That they are
the bytes the `formal-verification` job wrote follows from the workflow, in which the job
downloads the artifact that run uploaded, and is not something the signature
shows. Neither shows that a claim of the bounded suites holds outside its
stated domain.

The workflow contract is statically tested, but no local run can prove that
GitHub accepted, stored, and can independently return these attestations for
this repository. Before treating the gate as operational release evidence,
the first successful live `main` CI run must preserve all three bundles and an
operator must independently read back and verify all three evidence subjects
against `iAnonymous3000/site-behavior-lab`. That live receipt/readback remains
an external release gate until it actually succeeds. The same holds for the
formal verification report: until a live `main` run has signed one and an
operator has read its bundle back, that subject's workflow contract is tested
statically only.
