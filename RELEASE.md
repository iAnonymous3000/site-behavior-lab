# Release integrity

For the current `investigative-v1` profile, follow
[the v1 qualification contract](docs/v1-release-qualification.md). It uses
`research/v1-release-binding.json` with the existing externally selected
`RELEASE_MEASUREMENT_BINDING_SHA256`. The research binding and measurement-freeze
instructions below apply to the separate research programme. They do not impose
its calendar, controlled-collection quotas or durable enablement on lean v1.
All CI, exact-source attestation, release authority, promotion and live
verification instructions still apply.

## Current release state

Site Behavior Lab cuts curated milestones on its governed 0.x development line
and, once every readiness gate passes, on the exact 1.0.0 line. It has no
blanket stable public API and no npm publication, and a tag never
changes either: `release-policy.json` keeps `stablePublicApi` and
`npmPublication` disabled in both the `development` and `released` states, and
the evidence gate refuses any policy that says otherwise. A public deployment
can be useful and production-operated without turning this source line into a
stable software release.

Do not call the project stable, generally available, or critical-software ready
from a green local checkout, or from the existence of a tag. The
machine-readable source of the current status is
[`release-policy.json`](release-policy.json).

The current release is `v0.4.0`, tagged 2026-08-02, with its receipt durably
archived at
[`docs/release-receipts/0.4.0/release-receipt.json`](docs/release-receipts/0.4.0/release-receipt.json).
The source policy currently declares `v0.5.0`, but that version is not a
release until the governed tag ceremony succeeds. Do not describe the policy
declaration by itself as a published release.

One historical failure is worth keeping on the record because its recovery
path is the template for any future tag-ceremony failure. The first
`v0.4.0-rc.1` dispatch, run
[`30653749957`](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30653749957),
was approved but its atomic tag request failed with HTTP 403 on 2026-08-01 at
12:22:43Z. Recovery was exactly the prescribed path: the distinct release-App
configuration landed through the protected PR flow, a **fresh dispatch from
the updated `main` workflow** created the tag the same day (2026-08-01 at
20:44:52Z, receipt at
[`docs/release-receipts/0.4.0-rc.1/release-receipt.json`](docs/release-receipts/0.4.0-rc.1/release-receipt.json)),
and `v0.4.0` followed on 2026-08-02. A failed dispatch is never approved or
rerun; the ceremony restarts from `main`.

## What a release tag claims

A `vX.Y.Z` tag claims exactly this, and nothing else:

- the tagged revision passed every required CI gate;
- it was promoted to `production` before the tag existed;
- an exact-source release receipt was generated for it and attested through the
  same Sigstore keyless path CI already uses for exact-SHA evidence; and
- `CHANGELOG.md` carries a dated section for that version. `CITATION.cff`
  still cites the previous receipted release when the tag is created, and
  catches up to this version, with the matching `date-released`, only after
  the receipt is archived (step 5): the receipt this ceremony produces is what
  makes the citation truthful, so every gate that runs at the tagged revision,
  the release-evidence gate in `prepare` and the attestation validator alike,
  requires the citation to name the most recent receipted release, never the
  declared one.

It does not claim API stability, support commitments, or that any externally
operated control was activated. The ScanReport schema contracts (v1 frozen,
v2/r1, v2/r2) version independently of this line; a release never moves them.

## Cutting a release

Releases are curated, not automatic. The order matters, because the tag is
created only after the revision it names is already promoted:

1. Land a commit that sets `release-policy.json` to `status: "released"` with
   the new `version`, `releaseTag: "v<version>"`, and today's `releaseDate`;
   bumps `package.json` and `package-lock.json` to the same version; records
   `tagPending.declaredAt` so the open declare-then-tag window is explicit; and
   moves the accumulated `Unreleased`
   entries into a `## [<version>] - <date>` section, leaving an empty
   `Unreleased` heading for the next line of work.

   Bumping the version rewrites `package-lock.json`, which is a pinned
   supply-chain input, so the same commit must regenerate the inventory or CI's
   required supply-chain gate fails on a stale digest:

   ```bash
   node scripts/third-party-inventory.mjs
   npm run supply-chain:third-party:check
   ```

   **`CITATION.cff` is NOT advanced here.** It is consumed standalone by
   citation tooling, which never sees this sequence or `release-policy.json`,
   so advancing it at declaration time asserts a release date for a version
   that has no tag and no receipt. It moves in step 5, once the receipt is
   archived. A guard enforces both halves: the cited version must lag while the
   receipt is absent, and must match once it exists.
2. Let CI go green and let the promotion job advance `production`.
3. Complete the governance-carrier sequence described below before dispatch:
   configure the distinct release App and creation-only ruleset; install
   `RELEASE_APP_PRIVATE_KEY` only on `release-tag`; capture the fresh receipt;
   commit its content-addressed file; and let that carrier commit pass CI and
   reach both `main` and `production`. Then set
   `RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256` to that receipt's digest.
4. Run the **Cut Release Tag** workflow with that version **and the exact
   40-character governance-carrier SHA to tag**. The SHA is normally later than
   the version-declaration commit because the selected receipt must exist in
   the tree being tagged. Both inputs are required: a dispatch runs at whatever
   the branch tip happens to be, and inferring the revision from the tip or
   from the version declaration would both guess at something you know.
   The workflow then checks out that exact revision and, against it, re-verifies
   the policy, refuses to move an existing tag, requires the revision to contain
   the commit that declared the version (disclosing how many later commits the
   tag sweeps in), requires it to be an ancestor of `production`, requires a
   completed successful CI run of this repository's `main` branch for that SHA
   with every job in `.github/required-ci-jobs.json` concluding success,
   runs `release:readiness:check` for exact `1.0.0` and `1.0.0-rc.N`,
   rebuilds the static artifact, and generates the receipt. Candidate and
   dependency code runs only in that read-only preparation job, whose checkout
   does not persist credentials. That job hands two immutable artifacts to the
   next one: the receipt, and the built `out/` bytes the receipt describes.

   A fresh job downloads both by ID, independently rechecks each one's GitHub
   artifact metadata, then validates the receipt as hostile data against exact
   source inputs, CI jobs, production ancestry, canonical JSON, and manifest
   totals. Because that receipt was written by the job that built it, internal
   consistency is not evidence: the same job then walks the downloaded bytes,
   recomputes every file's sha256, and requires an exact set match against the
   manifest. A manifest describing a file the build never produced, a build
   carrying a file the manifest omits, any differing byte count or digest, a
   symlink, or a missing static handoff all refuse before anything is signed.
   Only then does it attest, and it never holds repository-write permission.

   A third fresh job keeps its native workflow token read-only. It requires an
   approved `github.actor` *and* `github.triggering_actor`, so re-running a
   dispatch as someone else cannot publish, and it names the `release-tag`
   environment so an external protection rule can gate the only job capable of
   writing a ref. After approval and a final branch-reachability check, it
   requires the nonsecret variables `RELEASE_APP_CLIENT_ID`,
   `RELEASE_APP_INTEGRATION_ID`, `RELEASE_TAG_CREATION_RULESET_ID`,
   `RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256`, and
   `PROMOTION_APP_CLIENT_ID`, `PROMOTION_APP_INTEGRATION_ID`, and
   `PROMOTION_APP_SLUG` together with the `release-tag` environment secret
   `RELEASE_APP_PRIVATE_KEY`, then refuses if either identity is absent or the
   two App identities overlap. Only the release credentials feed the token
   action, which mints a current-repository contents-write token from the
   dedicated release App. Missing or reused configuration refuses the release;
   for this release App there is no deprecated App-ID fallback, no fallback to
   `GITHUB_TOKEN`, and no fallback to the separately scoped production
   promotion App. The job then
   atomically creates the annotated tag through GitHub's Git database API, with
   no checkout, package-manager execution, OIDC, or attestation authority. The
   tag message records the receipt's sha256 so it stays identifiable after the
   uploaded artifact expires.

   Configure that authority once as a distinct GitHub App installed on this
   repository only, with metadata read and contents read/write, and no webhook.
   Do not grant Administration permission: a tag publisher must never be able
   to weaken the rulesets it is required to obey.
   Store its client ID and numeric GitHub Integration id as the nonsecret
   `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_INTEGRATION_ID` variables; do not
   configure a legacy `RELEASE_APP_ID` fallback. Store its private key
   **only** as the `RELEASE_APP_PRIVATE_KEY` secret on the `release-tag`
   environment; no repository- or organization-scoped secret with that name
   may exist. The promotion App remains separate and keeps its existing
   `PROMOTION_APP_ID` path until its distinct nonsecret
   `PROMOTION_APP_CLIENT_ID` is configured; the two mutually exclusive token
   steps ensure exactly one identity input mints. Retain its
   `PROMOTION_APP_INTEGRATION_ID`, and `PROMOTION_APP_SLUG` populated for the
   equality and public-identity refusals. Do not reuse any `PROMOTION_APP_*`
   credential, give the release App
   a production-ruleset bypass, or install it on unrelated repositories.

   Installing the App is not the end of the authorization change. Leave
   `Protect immutable release tags` (ruleset `20050122`) exactly as the
   zero-bypass `refs/tags/v*` update-and-deletion boundary. Add a **second**
   active `refs/tags/v*` ruleset containing only the tag-creation restriction,
   with the release App as its sole bypass actor. Never put that bypass on the
   immutable ruleset: a ruleset bypass applies to every rule in that ruleset,
   which would let the publisher move or delete tags. Do not add the release
   App to either production ruleset: `Protect production evidence` keeps no
   bypass, and `Restrict production updates to promoter App` keeps only the
   distinct promotion App. Store the numeric id of the new creation-only
   ruleset as `RELEASE_TAG_CREATION_RULESET_ID`.

   The public detailed-ruleset API does not reveal `bypass_actors` to a
   metadata-only token. Capture them once with a maintainer credential after
   configuring all four rulesets. The capture also requires separate,
   short-lived `RELEASE_APP_JWT` and `PROMOTION_APP_JWT` environment values:
   it uses each App JWT to discover the installation and mint one deliberately
   un-narrowed, immediately revoked installation token whose repository
   enumeration must contain this repository and nothing else. Do not treat the
   release workflow's current-repository-scoped token as proof of the
   underlying installation scope.

   Install the release App private key **before capture**, only as the
   `RELEASE_APP_PRIVATE_KEY` secret on `release-tag`. The producer records a
   point-in-time secret-name inventory and refuses if that name is missing from
   the environment or exists at repository or applicable organization scope.

   Inject the three short-lived credentials from a secret manager, or enter
   them silently in a disposable subshell. Never put their values in command
   arguments, inline assignments, or shell history:

   ```bash
   (
   set -euo pipefail
   cleanup_release_governance_credentials() {
     unset GH_TOKEN RELEASE_APP_JWT PROMOTION_APP_JWT
   }
   trap cleanup_release_governance_credentials EXIT

   printf 'Maintainer GitHub token: ' >&2
   IFS= read -r -s GH_TOKEN; printf '\n' >&2
   printf 'Short-lived release App JWT: ' >&2
   IFS= read -r -s RELEASE_APP_JWT; printf '\n' >&2
   printf 'Short-lived promotion App JWT: ' >&2
   IFS= read -r -s PROMOTION_APP_JWT; printf '\n' >&2
   export GH_TOKEN RELEASE_APP_JWT PROMOTION_APP_JWT

   npm run release:governance:capture -- \
     --repository iAnonymous3000/site-behavior-lab \
     --release-app-client-id <client-id> \
     --release-app-integration-id <numeric-id> \
     --release-app-slug <slug> \
     --promotion-app-client-id <client-id> \
     --promotion-app-integration-id <numeric-id> \
     --promotion-app-slug <slug> \
     --creation-ruleset-id <numeric-id>
   )
   ```

   The capture writes the canonical receipt once at
   `research/ops-receipts/release-tag-governance/<sha256>.json`; it will not
   overwrite an existing path. Review that receipt. For a governed `0.x`
   release, commit the new receipt as an add-only evidence carrier; the
   measurement-candidate binding is explicitly not required. For exact `1.0.0`
   or `1.0.0-rc.N`, capture only after candidate `C` is selected, add the
   receipt as category `release-tag-governance-receipt` with change `added`
   and the same path and digest in
   `research/measurement-candidate-binding.json`, and commit both together.
   Let the resulting carrier commit pass every required CI job and reach both
   `main` and `production`. Configure the GitHub Actions `vars` selector
   `RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256` at repository or organization scope
   with the printed digest. Do not configure it only on the `release-tag`
   environment: `prepare` deliberately runs before any environment is entered.
   Local readiness cannot read GitHub Actions variables. Reproduce the selected
   gate locally by placing the same non-secret digest in the command's process
   environment (and use the same prefix with `release:readiness:check`):

   ```bash
   RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256=<receipt-sha256> \
     npm run release:readiness
   ```

   Before opening the workflow UI, verify the exact carrier selection locally:

   ```bash
   npm run release:governance:verify-selection -- \
     --commit <full-governance-carrier-sha> \
     --receipt-sha256 <receipt-sha256>
   ```

   Dispatch that verified carrier SHA, not the earlier version-declaration
   SHA. The workflow repeats this check in its read-only `prepare` job before
   the protected environment can ask for approval; the privileged tag job then
   repeats the authoritative live App, ruleset, secret-scope, and receipt
   checks before creating the tag.

   The static `RELEASE_READINESS.json` descriptor names that external selector
   and add-only directory, so no ceremony-time manifest edit is permitted. The
   selected receipt contains the complete bypass list for all four rulesets,
   each App's exact public permissions (`contents: write`, `metadata: read`)
   and empty event subscriptions, both selected-repository installation
   identities and full repository enumerations, and the exact promotion App
   identity that alone bypasses production updates. It also carries an
   explicitly point-in-time secret-name inventory: at capture time
   `RELEASE_APP_PRIVATE_KEY` must exist on `release-tag`, be absent at
   repository scope, and be absent at organization scope when the owner is an
   organization. That inventory does not claim continuous absence. Capture or
   recapture it only after measurement candidate `C` is selected, on the same
   UTC day immediately before **every** fresh release ceremony, and again after
   any known secret-scope change. Never merge its evidence carrier during the
   flag-only `P` to `F` freeze or before `C`. Both readiness and the
   post-environment-approval tag job enforce the same fixed 24-hour maximum
   age using their trusted current time. Readiness also requires `capturedAt`
   to be no earlier than the candidate commit and no later than the add-only
   carrier commit that introduced the retained bytes. If CI, promotion, or environment
   review carries the receipt outside that window, recapture to a new
   content-addressed path, add that path to the binding, commit it, rotate the
   external Actions selector, let the carrier commit promote, and start a fresh
   dispatch; never rewrite or re-date an old inventory. At publication,
   `prepare` resolves `${{ vars.RELEASE_TAG_GOVERNANCE_RECEIPT_SHA256 }}` exactly
   once outside every environment, validates one lowercase sha256, and freezes
   it as an immutable job output. Attestation and tag jobs consume only that
   output and never evaluate an environment-shadowable `vars` value. Changing
   the external selector after `prepare` therefore cannot change the active
   dispatch. The selected digest is explicit in the schema-v2 attested release
   receipt and annotated tag message. The restricted release token then reads
   that exact committed
   governance receipt and readiness manifest, resolves its own
   public App identity, and reads the public shape of all four rulesets. It
   requires every ruleset id
   and GitHub-controlled `updated_at` value, plus the complete public conditions
   and rules, to match the maintainer capture. In particular, production
   evidence must retain deletion, non-fast-forward, linear history, and the
   exact five GitHub Actions checks with Integration id `15368`; the updater's
   live canonical rule and the immutable ruleset's update rule are both the
   bare `{"type":"update"}` shape. A later bypass edit changes
   `updated_at`; any public shape change or candidate-authored receipt rewrite
   therefore refuses before the create request without granting the publisher
   ruleset-write authority. Recapture, review, commit add-only evidence, and
   deliberately rotate the external digest selector after any intentional
   governance change. The first fresh
   release is the write proof that the release App can create the intended
   immutable tag; do not create a disposable `v*` canary, because a correctly
   protected canary cannot be deleted. The proof set is therefore: the
   maintainer-pinned full-bypass capture, a live public-shape and `updated_at`
   match for all four rulesets under the restricted token, and the successful
   App-authenticated atomic tag creation.

   Exact `1.0.0` and `1.0.0-rc.N` releases have one additional external trust
   root: repository- or organization-scoped Actions variable
   `RELEASE_MEASUREMENT_BINDING_SHA256`. An authorized maintainer may set or
   rotate it **only after** independently verifying the complete raw
   `research/measurement-candidate-binding.json` bytes offline from a clean,
   full-history checkout with trusted controller tooling. That verification
   must cover the binding's candidate/tree and carrier history, complete
   evidence enumeration and byte digests, durable transition and soak
   chronology, governance receipt row, and every required Sigstore bundle and
   signer/source identity. A digest printed by candidate CI, a candidate build
   proof, or candidate-owned verifier output is not sufficient authority to
   set the variable. After the independent verification succeeds, compute the
   pin over the exact raw canonical file bytes (for example,
   `shasum -a 256 research/measurement-candidate-binding.json`) and retain the
   reviewed verification record outside the candidate-controlled workflow.

   `prepare` reads that Actions variable exactly once in its first step, before
   checkout or package execution. After resolving the release version it
   requires the snapshotted value to be one lowercase SHA-256 for exact 1.0,
   while supported 0.x releases bind `bindingRequired=false` and the fixed
   `not-required` sentinel. The fresh tag runner performs no binding fetch for
   0.x. For exact 1.0 it fetches the raw file with its native read-only token,
   hashes and structurally validates those bytes, confirms the candidate
   commit/tree and ancestry plus the add-only governance row, and does all of
   that before minting the release App token. The immutable annotated tag
   records both `bindingRequired` and the selected digest or sentinel. Any
   binding-byte change requires a new independent offline verification, pin
   rotation, and fresh workflow dispatch; never accept a candidate-produced
   replacement digest during a running ceremony.

   A workflow re-run retains the original event SHA and workflow definition.
   After any change to `.github/workflows/release.yml`, start a **fresh
   workflow dispatch** from `main`; re-running an older attempt cannot pick up
   the repair. On attempt 1 the tag job requires the exact ref preflight to
   return HTTP 404. There is one narrower recovery after a current-workflow
   attempt reaches publication: if its tag job fails after the create request
   may have succeeded, re-run the **failed tag job only**, not all jobs. The
   create-only path enters reconciliation only for exact HTTP 422 with message
   `Reference already exists`; transport errors, 403, 5xx, and every other
   response refuse. Recovery then succeeds only when the ref name, tag-object
   type, target commit, and exact message (including the same attestation URL,
   receipt digest, and workflow run id) match. Every mismatch remains a hard
   refusal.

Between steps 1 and 3 the policy truthfully says `released` while no tag exists
yet. That window is expected, and the receipt records it: `release.tagExists`
and `release.evidencesReleaseCommit` say whether the tag is present and whether
the evidenced commit is the tagged one, so a receipt built from a later commit
on the same version never implies it describes the released tree.

## After a successful tag

Do not leave the validated receipt only in a 90-day Actions artifact. Dispatch
**Archive Release Receipt** with the completed successful release run id,
manually approve the automation proposal's parked push-event CI run, compare
the proposed receipt SHA-256 with the digest embedded in the annotated tag
message, and merge the generated archive PR through the required checks. The
durable copy must land at
`docs/release-receipts/<version>/release-receipt.json`; never hand-transplant
or edit the generated bytes.

Once that receipt is archived, advance `CITATION.cff` to the released version
and date, and remove `tagPending` from `release-policy.json`. Those two edits
are what close the declare-then-tag window, and guards enforce both directions:
`CITATION.cff` may not cite the declared version while its receipt is missing,
and may not lag once that receipt exists.

After a successful prerelease rehearsal, close the prerelease line promptly
rather than leaving the repository indefinitely in an RC-labelled released
state. This is how `0.4.0` closed its `0.4.0-rc.1` line on 2026-08-02, through
the ordinary release commit: retitle the RC changelog section as the final
version, update the package, lockfile, citation, and release-policy version,
tag, and date together, regenerate the third-party inventory, then repeat CI,
promotion, fresh tag dispatch, and receipt archival. The final tag is a
separate immutable ceremony; it does not
move or replace the RC tag.

## Exact-source evidence

Every candidate receipt is generated by `scripts/release-evidence.mjs`. It
fails unless:

- Git `HEAD` is a full commit and the staged, tracked, untracked, and submodule
  worktree state is clean;
- any CI-provided commit identity exactly matches `HEAD`;
- package, lockfile, and release-policy versions agree, and the citation
  names the most recent receipted release (the declared version itself once
  its receipt is archived) with that receipt's recorded date;
- the evidence builder runs on exactly Node 24.14.1 with npm 11.11.0;
- the development status still has no tag, stable-API, or npm-publication
  claim; and
- each recorded artifact independently identifies that exact source commit.

The receipt contains no timestamp, branch name, runner ID, or moving URL.
Given the same source and artifact bytes, it serializes identically. Static
evidence lists every output file with its byte length and SHA-256 and validates
`deployment.json`. Container evidence records the exact local image ID, rootfs
layer IDs, OCI source/revision labels, architecture, size, embedded runtime
build commit, the independently executed Node 24.18.1 version, and the asserted
absence of any package manager in the runtime image (the runner stage strips
the base's global npm/yarn/corepack). The probes use the exact image ID with
pulling and networking disabled, a read-only root filesystem, every capability
dropped, and no-new-privileges.

Generate a static receipt outside the worktree after a clean static build:

```bash
npm ci
# build:pages and test:smoke:static both fail closed without the public site
# URL: the static export refuses to guess an origin for canonical links.
export NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://sitebehavior.org
npm run build:pages
npm run test:smoke:static
npm run release:evidence -- \
  --static-dir out \
  --output /tmp/site-behavior-lab-static-release-evidence.json
```

The output parent directory must already exist and the output path itself must
not. Receipt creation uses an exclusive, no-follow file open and rechecks the
clean commit before and after artifact inspection and output, so an existing
symlink cannot redirect a receipt write back into the checkout.

Generate a receipt for the exact image exercised by both Docker smoke lanes:

```bash
DOCKER_SMOKE_PUBLIC_R2=1 npm run test:smoke:docker
npm run release:evidence -- \
  --container-image site-behavior-lab:smoke \
  --output /tmp/site-behavior-lab-container-release-evidence.json
```

CI records those receipts after the corresponding build and smoke work, and
preserves them as `exact-sha-static-evidence-<sha>` and
`exact-sha-container-evidence-<sha>`. The container artifact also carries the
canonical `site-behavior-lab-container-package-inventory.json` generated from
the separate Trivy OS-license pass and cross-bound to the receipt's image ID,
rootfs layers, platform, and commit. A separate least-privilege job attests
the exact bytes of all three JSON subjects and preserves its Sigstore bundles
and result references as `exact-sha-provenance-attestations-<sha>`. Promotion
depends on all three CI test jobs, the independent supply-chain job, and that
attestation job. A receipt binds source and tested bytes and does **not** claim that a
separately deployed Cloudflare artifact has the same image ID or static-tree
digest. The attestation subjects are the two receipt JSON files and the
canonical container package inventory, not the raw Trivy reports, static tree,
OCI image, registry image, or Cloudflare deployment they describe. The first
live `main` CI attestation receipt and independent readback of all three
subjects remain an external proof gate; a static workflow test cannot satisfy
that requirement.

## Candidate gate

A release candidate is eligible for external rollout only when all of the
following refer to one reviewed commit:

1. The worktree is clean and local `HEAD`, remote `main`, the CI run SHA, and
   both CI evidence artifact names agree exactly.
2. Fresh npm, RustSec, Trivy filesystem, and smoke-tested-image gates;
   dependency installation; app and Cloudflare typechecks; unit tests;
   production build; static build/smoke; Chromium smoke; and Docker public-R2
   smoke are green for that SHA. The exact-SHA attestation job is green, all
   three bundles are preserved, and the two evidence manifests plus the
   canonical container package-inventory subject pass an
   independent GitHub readback for that repository. See
   [`docs/supply-chain-assurance.md`](docs/supply-chain-assurance.md) for the
   exact claims and remaining external gates.
3. The changelog describes the candidate without moving implemented work out
   of `Unreleased`; the version remains synchronized across package, lockfile,
   citation, and release policy.
4. Security review has no unresolved release-blocking finding. Any accepted
   risk has an owner, bounded scope, and expiry rather than a vague readiness
   claim.
5. Required isolated staging exercises pass on that exact SHA and their
   resources, credentials, objects, DNS, and fault hooks are then proven absent.
6. Repository rules enforce the four candidate-code gates (`supply-chain`,
   `app`, `smoke`, and `docker`) plus the reviewed-change policy before `main`
   can advance. The trusted main-only `attest` job then joins those four as the
   fifth required conclusion before `production` can advance. The actual
   Cloudflare deploy trigger is verified rather than inferred from either ref.

## Live release proof

External deployment is a separate, authority-gated operation. CI
fast-forwarding `production` identifies the eligible source; it does not by
itself prove that Cloudflare is connected to or deployed from that ref. Do not
call the rollout complete until the actual deploy path is verified and all of
these exact identities converge:

| Evidence | Required identity or receipt |
| --- | --- |
| local source | clean `HEAD` |
| GitHub source | `origin/main` and remote `main` |
| promoted source | remote `production` and successful CI SHA |
| deployment control | verified Cloudflare trigger or exact manual deploy receipt |
| scanner runtime | `/api/health` full deployment SHA and ready posture |
| Pages runtime | `/deployment.json` full deployment SHA |
| CI artifacts | static evidence, container evidence plus canonical package inventory, and all three attestation bundles named for that SHA |
| live operations | canonical Production Health success for that SHA |

A deploy operation may report success before either origin converges. Wait for
both live receipts. The CI container image receipt describes the image CI
tested; the Cloudflare dashboard/build configuration or exact manual deploy
receipt must establish how the live artifact was produced. Live health proves
source identity, not byte-for-byte image parity.

The policy must remain `development` while branch governance allows unreviewed
or unchecked advancement, or while the Cloudflare deployment path is not
enforceably tied to the eligible exact SHA. Blocking force-pushes/deletion and
requiring linear history are useful but insufficient alone: `main` needs the
four candidate-code jobs as required checks plus an explicit review or
documented solo-maintainer break-glass policy; `production` needs all five
successful conclusions, including the trusted main-only attestation job, and
restricted updates. A current readback of the real deployment integration is
also required.

Critical-operation claims additionally require current, separately retained
operator receipts for the WAF ceiling, bounded log query and retention,
dedicated-prefix R2 write/read/delete, egress containment or explicit reviewed
acceptance, rollback, credential ownership/rotation, and every feature-specific
staging canary. Feature flags must stay disabled until their own runbooks say
otherwise.

## Security review of the release path (2026-07-26)

An adversarial review of the release-path changes at `0e502f8`, run under the
strongest realistic threat model: an attacker who has fully compromised the
`prepare` job through a malicious dependency or malicious candidate code, and
who therefore controls the receipt bytes, every byte and file name of the built
`out/` tree, and both artifact uploads. The goal set for the attacker was to
obtain an attestation over a receipt that does not describe the real build, or a
tag over an unverified revision.

Three lenses were exercised: hostile-byte handling in the privileged verifier,
shell and expression injection across both changed workflows, and authorization
and privilege isolation. Six candidate findings were raised and all six were
refuted against the code. No trust-boundary regression was found.

Attacks specifically tried and closed, each by a named guard: path traversal and
`..` components out of the walk root; symlinks, FIFOs, sockets and other
non-regular entries; extra, missing, duplicated and lossily-decoded file names;
producer/verifier serialization divergence (executed over the real 3153-file
tree, including hidden entries); receipt key-order, duplicate-key and
numeric-format games; artifact substitution across runs or attempts; command
substitution and option smuggling through the corrections baseline; and
attacker-supplied baselines on `workflow_dispatch`.

Two limits are deliberate and documented rather than fixed. Resource exhaustion
through a single very large file fails the release rather than being rejected
early, which is a denial of service a compromised `prepare` already has by
exiting non-zero, and is not a signing bypass. And the receipt binds to the tree
the release job rebuilt, not to the bytes Cloudflare serves; the deployed SHA is
proven separately by the production-health monitor.

One real defect surfaced during the review and was fixed: the approved-actor
allowlist trimmed whitespace across the whole list after splitting on commas,
which also deleted the separators and collapsed a multi-name list into a single
name matching nobody. It failed closed, so it was never exploitable, but it
would have refused every release as soon as a second approver was added.

## External control snapshot (2026-07-21)

This dated operator snapshot records what was verified; it is not evidence for
a later candidate and must be refreshed before any readiness claim:

- `origin/main`, `origin/production`, scanner `/api/health`, and Pages
  `/deployment.json` converged on
  `ea9e0f1b37388c195e045784bdcf6d40fe877ee0`;
- scanner Cloudflare Workers Builds was connected to
  `iAnonymous3000/site-behavior-lab`, root `/`, production branch `production`,
  deploy command `npm run cf:container:deploy`, include path `*`, non-production
  builds disabled, and build cache disabled; its latest verified build was the
  exact SHA above and was attributed to Dependabot;
- Cloudflare Pages was connected to the same repository with automatic
  deployments, build command `npm run build:pages`, output `out`, production
  branch `production`, include path `*`, build system v3, and build cache
  disabled. Production build variables included the scan API base, site URL,
  public Turnstile site key, Node version, and base path. Preview deployments
  remained public by default rather than Access-restricted;
- the POST `/api/scan` WAF rule was active at ten requests per ten seconds per
  IP with a ten-second block;
- Worker logs were queryable over the configured seven-day range; the inspected
  recent window showed 121 successes, zero errors, and redacted report URLs;
- GitHub governance remained below the release gate: the `main` ruleset blocked
  force-pushes and deletion but required neither status checks nor review, while
  classic `production` protection required only linear history.
- Pages still declared `NODE_VERSION=22` while this repository and CI require
  Node `24.14.1` with npm `11.11.0`; that toolchain mismatch and the public preview posture are
  release-control gaps even though the observed production SHA converged.

The digest-pinned Playwright base is verified at Node 24.18.1 with npm 11.16.0
during the build, and the runtime stage then strips every global package
manager, so the smoke image runs the app with node alone. Dockerfile build
assertions and the hardened release-evidence probes enforce the exact
container Node version plus that package-manager absence. The container
runtime is intentionally distinct from the repository and Actions Node
24.14.1/npm 11.11.0 pins; neither toolchain is presented as parity with the
other.

The source, deployment, WAF, and log observations are useful operational
evidence for that exact snapshot. The governance, toolchain, and public-preview
observations are release-policy blockers, and none of these receipts replaces
fresh verification for the final clean commit.

### Governance re-check (2026-07-30, read-only)

Re-read from GitHub's ruleset and environment APIs rather than assumed, because
the snapshot above is dated and governance is the gate a release leans on
hardest:

- `Protect main history` (ruleset `19473770`) is active on `refs/heads/main`
  with no bypass actors. It requires linear history, a pull request (zero
  approvals, review threads resolved, stale approvals dismissed), the four
  candidate-code checks from the GitHub Actions app, and a branch current with
  `main`; only squash and rebase merges are allowed, and deletion plus
  non-fast-forward updates are blocked;
- `Protect immutable release tags` (ruleset `20050122`) is active on
  `refs/tags/v*` with no bypass actors and blocks both deletion and every update.
  It makes a created release tag immutable, but does not by itself restrict who
  may create a new matching tag;
- the `release-tag` environment exists with `main` as its sole custom branch,
  requires review by `iAnonymous3000`, and allows that solo maintainer to review
  their own deployment. GitHub currently reports administrator bypass enabled,
  so the environment gate is live but is not yet an admin-proof authorization
  boundary;
- `Protect production evidence` (ruleset `20050303`) is active on
  `refs/heads/production` with no bypass actors. It requires linear,
  non-deleting, non-rewinding history and all five exact GitHub Actions checks,
  including the trusted main-only attestation job;
- `Restrict production updates to promoter App` (ruleset `20050309`) is active
  with the dedicated promotion App (`Integration` id `4436250`) as its sole
  bypass actor. During activation, a maintainer fast-forward and both the
  direct CI promotion (run `30553823520`) and independent fallback (run
  `30555628056`, attempt 1) were refused by `GH013` while the updater had no
  bypass. After the App became the sole bypass, fallback attempt 2 independently
  revalidated all five gates and advanced `production` to exact SHA
  `49b9062b845b1c5aa97ea90069083bce274fb79b`. Final readback matched `main`
  and `production`, kept the evidence ruleset's bypass list empty, and exposed
  the aggregate deletion, non-fast-forward, linear-history, status-check, and
  restricted-update rules;
- `v0.2.0` was never cut; `v0.3.0` was cut 2026-07-30 through the full
  ceremony (attestation 38013724, receipt sha256
  `0cc066fd00fb89cca23d591325de43aba37214bbf6f7118aca0cbd2fa3c7eb1b`
  embedded in the annotated tag and durably archived at
  `docs/release-receipts/0.3.0/`).

The main-history, production-evidence, and immutable-tag boundaries are active,
and the release environment gates the workflow job that can publish a tag.
The production-updater gate is closed. Tag publication is restricted by the
main-only reviewed environment plus the workflow's actor and triggering-actor
checks, but creation is not App-exclusive and the environment remains
administrator-bypassable; those limits must not be described as stronger
authorization. One live-proven caveat for automation proposals: a
workflow-dispatched CI run does not satisfy the ruleset's required checks on
a bot-created pull request (they stay "expected"); the parked push-event run
must be approved before such a proposal can merge.

## Working model under branch protection

Activating the `main` ruleset changes how every writer works, including the
maintainer. The order matters: the automated publishers were converted to
pull-request proposals first, because a required-PR rule with direct-push
corpus writers still active would break every scheduled refresh.

Normal change flow, human or automated:

1. Work lands on a topic branch (`codex/*` for the maintainer's sessions,
   `automation/*` for workflow-produced proposals, `dependabot/*` for
   dependency bookkeeping).
2. A pull request targets `main`. The ruleset requires the four candidate-code
   checks (Supply-chain Security; Typecheck, Unit Tests, Build; Chromium Smoke
   Test; Docker Runtime and Public R2 Smoke), an up-to-date branch, and every
   review thread resolved.
3. Merge. Attestation is deliberately NOT a pull-request check: it runs only
   against trusted `main` after the merge, and the promotion path then
   advances `production` from a completed successful `main` run.

Required approvals stay at ZERO while this repository has one maintainer.
GitHub forbids approving your own pull request, so a one-approval rule would
deadlock every change; the protection value here is the required checks, the
PR surface itself, and the audit trail, not a self-review no one can perform.
Raise the approval count the day a second maintainer exists.

Break-glass, for emergencies only (production incident with the PR path
unavailable or too slow):

- The maintainer may temporarily disable the `main` ruleset through repository
  admin access, push the minimal fix, and re-enable the ruleset immediately.
- Every break-glass use is recorded in a GitHub issue before or immediately
  after the push: what was pushed, why the PR path was insufficient, and when
  the ruleset was restored.
- The resulting head still runs the full CI gates; a break-glass push that
  fails CI is reverted, not patched forward.
- Break-glass never applies to `v*` tags or to `production`; those move only
  through their own gated paths.

## Measurement freeze

Setting the repository variable `SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE` to `1`
quiesces every corpus writer except the controlled collection lane, so a
measurement epoch's claim-affecting inputs cannot move while its evidence is
being collected:

- `update-brave-lists` skips its refresh (a mid-epoch filter change would move
  the Shields methodology identity under collected evidence).
- `dependabot-bookkeeping` skips its manifest regeneration.
- `scan.yml` still runs the requested scan and uploads its bounded artifact,
  but the publish job is gated off, so no ad-hoc report can join the corpus.
- `scan-featured` keeps running ONLY as the controlled r2 collection lane; the
  shared preflight refuses both frozen-v1 lanes (the scheduled fallback and
  the manual compatibility dispatch) while the freeze is set, and the r2 run's
  step summary discloses that it executed inside a freeze.
- `production-health` and `scanner-fidelity` are observers and keep running.

Each quiesced workflow runs a loud `Measurement freeze notice` job instead of
skipping silently. The variable is read at run start; flipping it does not
affect in-flight runs.

Do not activate the freeze until the deferral review has completed:

1. Let the scheduled **featured-gallery** legs at 05:23 UTC on 2026-08-03 and
   2026-08-10 attempt all 13 formerly deferred sites: `coinbase.com`,
   `goodrx.com`, `mayoclinic.org`, `drugs.com`, `zocdoc.com`, `match.com`,
   `okcupid.com`, `cnn.com`, `reuters.com`, `etsy.com`, `wayfair.com`,
   `macys.com`, and `reddit.com`. Record both fresh workflow run ids and each
   site's outcome through the separate 45-day
   `featured-readjudication-outcomes-<run-id>-<attempt>` artifact. A missing,
   malformed, or early-aborted scan is `not-attempted`, never inferred as a
   deferrable site failure; both cycle artifacts must say `complete: true`.
   The 07:23 UTC seed-catalog legs do not cover these sites.
   If the controlled runner is not configured yet, the disclosed v1 fallback
   is re-adjudication evidence only; it does not satisfy the current-method r2
   corpus gate.
2. From 2026-08-11 through 2026-08-17 inclusive, land a reviewed
   re-adjudication PR. Its strict
   `research/ops-receipts/featured-readjudication.json` aggregate binds the two
   distinct scheduled-run/artifact identities, exact artifact ZIP digests and
   canonical outcomes, each exact historical cycle-catalog digest, one shared
   fixed-domain target-identity digest, and the final featured-catalog digest.
   Only `scanAvailability` metadata may change without changing that target
   identity. Re-defer only sites whose same closed unavailable reason repeated
   in both complete cycles, bind each deferral to the two fresh run ids, and
   set a new bounded `reviewAfter`; leave recovered sites active.
3. Only after that PR and every other candidate input change have landed,
   record the candidate SHA and activation time, verify the controlled r2
   runner configuration, and set
   `SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE=1`. The activation workflow fetches
   both historical run/workflow records, the historical catalog bytes at each
   run commit, and exact artifact ZIP bytes by immutable id. It verifies them
   against the aggregate, requires activation within 28 calendar days after
   the Aug 10 cycle and every retained deferral's `reviewAfter` to remain later
   than activation, and re-derives every disposition before it can mint the
   freeze receipt.

After the activation run completes, candidate readiness also authenticates the
activation receipt itself. It uses the receipt's run id/attempt to require the
completed successful exact workflow run, discovers exactly one non-expired
per-attempt artifact, re-reads its immutable metadata, verifies the bounded ZIP
digest, strict-extracts only the expected receipt filename, and byte-compares
it to the committed carrier. Release preparation performs the GitHub fetch in
a workflow-owned read-only-token step and passes candidate code only the four
bounded offline context files plus the prefetch step's domain-separated digest
of their exact names, sizes, and bytes; npm, readiness, and build steps never
receive that token.

The variable cannot police merges. An `automation/*` proposal whose
acquisition or validation began **before** freeze activation carries
pre-epoch inputs and must not be merged; close it and re-run its producer
against the frozen candidate. This does not forbid the collection lane:
post-activation `automation/featured-scan-*` proposals produced by the
controlled r2 workflow against that candidate may be reviewed and merged
during the freeze.

The two controlled runner cycles follow the ordinary proposal rule
sequentially. Merge a valid first-cycle proposal, then re-run the next cycle
from the resulting evidence carrier rather than leaving two regenerated
indexes in conflict or hand-combining them. Each report arm, A/A ledger, and
runner receipt records its actual producer commit (`C` or a later `S_i`), and
release readiness accepts it only when the verified measurement binding names
that commit on the clean `C..S` carrier chain and the producer strictly
precedes the commit that introduces its evidence. Calibration alone remains
bound to exact `C`.

A/A evidence has its own governed lane; the scheduled scanner-fidelity smoke
is not a release evidence producer. Dispatch `aa-study.yml` from protected
`main` only after the freeze is active. It runs the complete preregistered
frame in one unsharded controlled-runner job and uses an even repetition count
with deterministic AB/BA alternation for comparison studies. After that run
has concluded successfully, `archive-aa-study.yml` independently reads back
the exact run attempt and artifact digest, verifies the frozen candidate and
frame, and signs a canonical producer receipt on a hosted runner. Its separate
write-capable job verifies the Sigstore bundle before opening the
`automation/aa-study-*` evidence proposal. The archive must retain
`attempt-ledger.json`, `evaluation.json`, `producer-receipt.json`, and
`producer-receipt.sigstore.json`; release readiness requires all four as one
study-local set and re-verifies the hosted attestation.

The binding keeps two candidate-resident contracts distinct. The candidate
input manifest digest-enumerates preregistrations, target frames, calibration
censoring policies, and the other frozen inputs at `C`; those files are not
post-candidate evidence. The separate measurement-identity manifest covers the
claim-affecting implementation, catalog, lists, and runtime identity without
including a preregistration or target frame. An A/A preregistration can
therefore bind that identity digest without forming a circular
preregistration-to-manifest hash.

The variable also quiesces only this repository's Dependabot bookkeeping, not
GitHub's core Dependabot service. Until a later code-enforced Dependabot pause
exists, no `dependabot/*` PR may be merged while the freeze is active. Leave
new dependency proposals unmerged (or close them) until the epoch ends; a
dependency-manifest change would move a claim-affecting candidate input.

One rule governs every stale report proposal: if the base branch advanced
after the proposal was validated, close the proposal and re-run its workflow.
That covers both the conflict case (two open proposals regenerate the report
manifest and corpus statistics from their own trees, so whichever merges
second conflicts in those generated files) and the quieter case where the
corrections-baseline ancestry check fails after a promotion lands. Do not
hand-merge regenerated output, and do not press Update branch on a report
proposal: updating merges the advanced base into the proposal and would mix
evidence generated under the old base with generator and schema code from the
new one, which is exactly the transplanted-tree hazard the proposal flow
exists to forbid. Re-running the workflow regenerates everything from one
tree and costs only machine time.

## Release 1.0 readiness manifest

`RELEASE_READINESS.json` is the single machine-readable source of the 1.0
gates; `npm run release:readiness` reports them and
`npm run release:readiness:check` fails unless every gate passes. The 1.0
release workflow now runs that check as a required step for exact `1.0.0` and
`1.0.0-rc.N`; a unit test pins the honest NOT READY state so the surface cannot
drift. Governed `0.x` ceremonies do not run the 1.0 gate.

Three gate families, all fail-closed (the manifest, not this prose, is the
authoritative gate list):

- **Decisions.** Recommended values are recorded in the manifest but stay
  red until a human edits the decision to `"status": "approved"` with
  `decidedBy` and `decidedAt`. The gate carries its own required-decision
  list, so deleting a pending decision is a failure, not an approval. A
  recommendation in a manifest is not a decision; approving one is a
  reviewed change like any other. The `compatibilitySurface` decision
  additionally pins the exact sha256 of `docs/compatibility-promise.md`, so
  editing the promise without re-approving it turns the gate red. The
  `reportRevisionR3` decision separately records an explicit selection; its
  recommended 1.0 disposition is to keep v2/r2, publish E1 and E2 as
  companion corrections for their immutable schema wording, and bank r3 for
  the 1.1 evidence-package design. The errata gate pins the required erratum
  ids and the exact digest of their published RFC text. Approval must copy the
  validator-reported digest of that complete disposition into the decision's
  `dispositionSha256`; changing even one required id, resolution, document,
  document digest, or selected vehicle then requires re-approval. The gate
  stays red until that disposition is selected and approved by a named human;
  approving a blank selection or merely deleting an erratum cannot satisfy
  it. The calibration decision is equally concrete: it can select only
  `per-detector-censoring-assignments-v1`, must pin the exact
  `research/measurement-candidate/calibration-censoring-policy-assignments.json`
  bytes, and must copy the producer's domain-separated `dispositionSha256`
  binding both the artifact and the per-detector analyzer semantics; the
  superseded zero-censoring approval is preserved verbatim in the decision's
  `superseded` block and its artifact stays readable at its historical path.
  A generic "settled" approval, a different path, or an unbound digest stays
  red, and the decision reads honestly as pending until the named human
  commits the approval.
- **Derived gates.** Corpus denominators, the third-party review ledger,
  runner destruction receipts, controlled publication archives, the lifecycle
  readback receipt, and the release-receipt archive are all
  re-derived from committed evidence on every run; no artifact's
  self-declared verdict is trusted (lifecycle rules are re-validated from the
  recorded rule bytes; runner cycles are counted as distinct Actions runs;
  and each controlled publication manifest/receipt pair is matched to its
  runner artifact and governed report/provenance bytes). Missing,
  malformed, future-dated, or stale evidence is a failure with a reason,
  never a skip. Release-receipt archive verification additionally requires a
  full Git checkout with tags (`fetch-depth: 0`): it resolves the historical
  source commit/tree and input bytes, recomputes the receipt's internal static
  manifest, and requires the annotated release tag to target that commit and
  embed the archived receipt's sha256.
- **Operator attestations.** Host truths code cannot see (the pre-candidate
  durable soak, egress backstop, WAF ceilings, log retention, and container
  image licensing) require a JSON attestation under
  `research/ops-receipts/`. For the four post-candidate gates, first use the
  fixed producer in
  [`docs/operator-evidence-capture.md`](docs/operator-evidence-capture.md) to
  create the canonical receipt under `research/ops-evidence/`. Readiness
  re-parses that exact canonical file, re-runs its semantic verifier, and
  derives the attestation's candidate, deployment, policy, image, and inventory
  bindings from it; a hex digest typed into an attestation cannot satisfy a
  gate by itself. Generate the exact non-passing scaffold for any one of the
  five gates with:

  ```bash
  npm run release:attestation-scaffold -- --gate egress-backstop
  ```

  For the pre-candidate durable soak, the command directly verifies the two
  replay receipts, exact Git 0-to-1 config transition, transition receipt,
  and current enabled config, so it can fill the transition-derived durable
  bindings before candidate C exists. Copy the exact `ledger_sha256` printed by
  the authenticated soak-ledger aggregation into the scaffold's
  `ledgerSha256` placeholder; the hosted-evidence verifier re-derives and
  compares it. The attestation must also name exactly the authenticated
  monitor, restart, and exercise run/artifact digests in that order. The
  durable-soak hosted profile refuses unless the distinct exercise workflow
  ran from the exact enabled deployment inside the ledger window and proved
  normal completion, cancellation, completed-report recovery, and duplicate
  prevention; every completed report carries that deployment in its provenance
  and retained clean health responses bracket the exercise. The restart
  artifact proves the fifth behavior. Candidate verification additionally
  requires the exact digest-addressed archive to be append-only,
  carrier-resident, and digest-enumerated, while its subject attestation
  remains candidate-resident. The monitor, restart, and exercise producer
  closures must be byte-identical to candidate-approved source. A hand-entered
  digest or statement cannot replace any source artifact. For the later gates
  it loads the verified measurement
  binding and the canonical producer receipt, then fills every subject binding,
  `evidenceCapturedAt`, and the receipt's exact path-plus-digest reference. For
  egress that includes `candidateCommit`,
  `collectionEnvironmentDigest`, and `collectionProducerCommitsDigest` from
  the exact controlled-runner receipt set. It deliberately leaves
  only the named operator, attestation time, and any durable-only facts that
  cannot be derived as conspicuous `<required: ...>` placeholders. It also
  emits every claim with `"true": false`. Change a claim to true only after
  personally verifying it. The CLI refuses to guess when candidate, runner,
  replay, canonical operator, or container evidence that should be derivable
  is unavailable.
  Staging teardown is not a second post-candidate attestation gate: its
  canonical same-session receipt is captured between replay and production
  enablement, then digest-bound as part of the candidate-resident durable
  prerequisite.

  The manifest owns each gate's exact claim ids/text and required subject
  bindings. The validator refuses missing, substituted, duplicate, or soft
  claims; malformed or duplicate evidence references; noncanonical evidence
  timestamps; stale underlying evidence hidden behind a fresh signature; and
  malformed commit or digest bindings. The durable-soak gate additionally
  recomputes its minimum 24-hour window (the target remains seven days),
  requires its end to be fresh, and binds `evidenceCapturedAt` exactly to that
  end rather than accepting a duration asserted in prose. Its
  `restartObservedAt` must be a canonical instant inside that same window. A
  window at or above the 168-hour target requires no deviation and binds a
  literal `null`. A 24-to-under-168-hour window requires the separate
  non-passing approval scaffold described in
  [`docs/go-live-public-scanner.md`](docs/go-live-public-scanner.md), completed
  by a named human only after candidate selection. Anything below 24 hours is
  ineligible.

## Rollback

Nothing in this repository rewinds. `v*` tags are immutable and `production`
refuses non-fast-forward pushes, so "roll back" always means moving FORWARD to
a tree without the defect:

1. Revert the offending commits on a topic branch (`git revert`, never a
   force-push) and land the revert through the normal PR flow with all four
   required checks.
2. The merge triggers CI on `main`; a green run promotes `production` to the
   reverted tree through the ordinary App-authenticated fast-forward. No
   special rollback lane exists, on purpose: the fix travels the same gated
   path as the defect did.
3. If the defect shipped in a release, the tag stays: cut the next patch
   version from the reverted tree and note the supersession in its changelog
   section. A released tag is a historical claim about what was published,
   not a pointer to move.
4. If promotion itself must be held while the revert is prepared, set
   `vars.SITE_BEHAVIOR_LAB_PROMOTION_PAUSED=1`, and unset it when the revert
   merges.

Break-glass (above) remains the only exception, and it still cannot touch
tags or `production` directly.

## What may change in a committed report

Two invariants coexist and are easy to conflate; release policy freezes them
separately:

- **Report identity is frozen.** A committed report is never upgraded across
  schema generations, and a measurement correction never edits the original:
  the corrections ledger requires a NEW report id with its own provenance,
  and the superseded report is pruned or annotated, never rewritten into a
  different measurement.
- **Report bytes are not frozen.** A reviewed security remediation (redaction
  widening, sanitizer fix) may rewrite stored bytes in place, preserving the
  report id and its meaning, through format-preserving string replacement
  with a recorded remediation inventory. This is the mechanism behind every
  historical remediation wave and remains lawful.

A release therefore claims that every committed report's MEASUREMENT is the
one its id always described, not that its bytes never changed. Anything that
would change what a report measured requires a new id through the
corrections ledger; anything that changes only how the same measurement is
redacted requires a reviewed remediation, never a quiet edit.

## Widening what a release may claim

The evidence schema accepts `development` and `released`, and it verifies the
released state rather than merely permitting it. Its version vocabulary is
deliberately bounded to the existing `0.x` line plus exact `1.0.0` and numbered
`1.0.0-rc.N` candidates; `1.0.1`, `1.1.0`, arbitrary 1.0 prereleases, a
blanket stable-API claim, npm publication, and a tag that does not match
`v<version>` remain refused.

The mechanical 1.0 vocabulary does not make the release ready. The unprivileged
prepare job runs the canonical `release:readiness:check` over every gate the
manifest declares before any artifact handoff whenever the requested version is
on the exact 1.0 line. Until the frozen candidate, controlled corpus,
durable-operations, and legal gates all pass, `1.0.0` and its release
candidates remain mechanically unpublishable. The detector-calibration and
A/A-repeatability evidence programs are recorded in the manifest's
`deferredGates` as gating the 1.1 calibrated-claims release; restoring them to
the 1.0 set is a reviewed enforcement edit.

Never infer a tag, stable API, or general-availability claim from the `0.x`
package version or from the existence of a public production deployment.
