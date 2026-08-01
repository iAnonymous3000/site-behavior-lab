# Evidence package (design note, not a promise)

Phase 6 of the release-1.0 roadmap is "critical-evidence readiness": a report a
third party can rely on under adversarial scrutiny, after 1.0 and detector
calibration. `RELEASE_READINESS.json` tracks the gates that precede it; this
note enumerates what the package itself must contain, so the list exists
somewhere other than in audit transcripts. Nothing here is shipped or
scheduled; each item names the gap it closes.

An "evidence package" is everything a third party needs to verify one report
offline, given only the package and public trust roots.

## Contents, per report

1. **The report and its provenance sidecar, byte-exact.** Both files as
   published. Already exists for committed reports.
2. **The covering evidence-manifest excerpt and its Sigstore bundle.** The
   manifest entry naming the report's digest, the full attested manifest, and
   the attestation bundle so `gh attestation verify` (or `cosign`) works with
   no network beyond the Sigstore trust root. Gap today: the bundle is fetched
   at verify time, not archived with releases; `archive-release-receipt.yml`
   should download and commit the bundle pair alongside each archived receipt.
3. **A verification transcript.** The exact commands from
   `docs/verify-a-report.md` and their outputs at packaging time, so the
   package documents that the chain verified at least once, when, and with
   which tool versions.
4. **Deployment identity for the producing scan window.** For container-lane
   scans: the wrangler deployment/version ID, the Workers Builds build ID, and
   the image digest where retrievable, filed as an operator attestation the
   same way the existing `research/ops-receipts/` gates work. Closes the
   largest current gap: nothing binds a live scan to an attested image.
5. **An external time anchor.** An append-only, periodically committed digest
   ledger (or Rekor entries) covering published report digests, giving every
   report a third-party inclusion time. Closes the operator-clock gap for
   ephemeral reports and tightens it for committed ones.
6. **The toolchain snapshot references.** Catalog digest, filter-list manifest
   digest, detector registry version/digest, methodology version: all already
   inside the report wire; the package should state where each is pinned in
   the repo at the covering SHA so a reviewer can diff two reports' toolchains
   without reading source.
7. **The claim-boundary statement.** The approved claim boundary from
   `RELEASE_READINESS.json` (investigative evidence requiring independent
   corroboration; excluded uses named), the calibration status of every
   detector cited, and the URL-generalization boundary: a v2 report identifies
   its subject site and path scope, not a re-fetchable exact URL, by design.
8. **Custody guidance.** One page: save these bytes and digests on receipt,
   anchor them independently (your own timestamping or notarization) if the
   matter is adversarial, and never rely on the live site remaining available.

## Sequencing

Items 2 and 3 are repo-side and small. Item 4 is operator work in the existing
attestation pattern. Item 5 is a design decision (ledger vs Rekor) that should
ride the `reportRevisionR3` decision window since it may want a wire field.
Items 6-8 are documentation once calibration (3B) and the claim-boundary
sign-off exist. None of it is meaningful before detector calibration: a
perfectly verified report whose detector accuracy is unquantified is still
investigative evidence, and the package must not imply otherwise.
