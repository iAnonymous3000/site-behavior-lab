# Release integrity

## Current release state

Site Behavior Lab cuts curated milestones on a private, pre-1.0 development
line. It has no stable public API and no npm publication, and a tag never
changes either: `release-policy.json` keeps `stablePublicApi` and
`npmPublication` disabled in both the `development` and `released` states, and
the evidence gate refuses any policy that says otherwise. A public deployment
can be useful and production-operated without turning this source line into a
stable software release.

Do not call the project stable, generally available, or critical-software ready
from a green local checkout, or from the existence of a tag. The
machine-readable source of the current status is
[`release-policy.json`](release-policy.json).

## What a release tag claims

A `vX.Y.Z` tag claims exactly this, and nothing else:

- the tagged revision passed every required CI gate;
- it was promoted to `production` before the tag existed;
- an exact-source release receipt was generated for it and attested through the
  same Sigstore keyless path CI already uses for exact-SHA evidence; and
- `CHANGELOG.md` carries a dated section for that version and `CITATION.cff`
  carries the matching `date-released`.

It does not claim API stability, support commitments, or that any externally
operated control was activated. The ScanReport schema contracts (v1 frozen,
v2/r1, v2/r2) version independently of this line; a release never moves them.

## Cutting a release

Releases are curated, not automatic. The order matters, because the tag is
created only after the revision it names is already promoted:

1. Land a commit that sets `release-policy.json` to `status: "released"` with
   the new `version`, `releaseTag: "v<version>"`, and today's `releaseDate`;
   bumps `package.json` and `package-lock.json` to the same version; adds
   `date-released` to `CITATION.cff`; and moves the accumulated `Unreleased`
   entries into a `## [<version>] - <date>` section, leaving an empty
   `Unreleased` heading for the next line of work.

   Bumping the version rewrites `package-lock.json`, which is a pinned
   supply-chain input, so the same commit must regenerate the inventory or CI's
   required supply-chain gate fails on a stale digest:

   ```bash
   node scripts/third-party-inventory.mjs
   npm run supply-chain:third-party:check
   ```
2. Let CI go green and let the promotion job advance `production`.
3. Run the **Cut Release Tag** workflow with that version **and the exact
   40-character SHA to tag**. Both inputs are required: a dispatch runs at
   whatever the branch tip happens to be, and inferring the revision from the
   tip or from the version declaration would both guess at something you know.
   The workflow then checks out that exact revision and, against it, re-verifies
   the policy, refuses to move an existing tag, requires the revision to contain
   the commit that declared the version (disclosing how many later commits the
   tag sweeps in), requires it to be an ancestor of `production`, requires a
   completed successful CI run of this repository's `main` branch for that SHA
   with every job in `.github/required-ci-jobs.json` concluding success,
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

   A third fresh job has repository-write permission only: it requires an
   approved `github.actor` *and* `github.triggering_actor`, so re-running a
   dispatch as someone else cannot publish, and it names the `release-tag`
   environment so an external protection rule can gate the one job that can
   write a ref. It then rechecks branch reachability and atomically creates the
   annotated tag through GitHub's Git database API, with no checkout,
   dependency execution, OIDC, or attestation authority. The tag message
   records the receipt's sha256 so it stays identifiable after the uploaded
   artifact expires.

Between steps 1 and 3 the policy truthfully says `released` while no tag exists
yet. That window is expected, and the receipt records it: `release.tagExists`
and `release.evidencesReleaseCommit` say whether the tag is present and whether
the evidenced commit is the tagged one, so a receipt built from a later commit
on the same version never implies it describes the released tree.

## Exact-source evidence

Every candidate receipt is generated by `scripts/release-evidence.mjs`. It
fails unless:

- Git `HEAD` is a full commit and the staged, tracked, untracked, and submodule
  worktree state is clean;
- any CI-provided commit identity exactly matches `HEAD`;
- package, lockfile, citation, and release-policy versions agree;
- the evidence builder runs on exactly Node 24.14.1 with npm 11.11.0;
- the development status still has no tag, stable-API, or npm-publication
  claim; and
- each recorded artifact independently identifies that exact source commit.

The receipt contains no timestamp, branch name, runner ID, or moving URL.
Given the same source and artifact bytes, it serializes identically. Static
evidence lists every output file with its byte length and SHA-256 and validates
`deployment.json`. Container evidence records the exact local image ID, rootfs
layer IDs, OCI source/revision labels, architecture, size, embedded runtime
build commit, the independently executed Node 24.17.0 version, and the asserted
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
`exact-sha-container-evidence-<sha>`. A separate least-privilege job attests
the exact bytes of those two JSON manifests and preserves its Sigstore bundles
and result references as `exact-sha-provenance-attestations-<sha>`. Promotion
depends on all three CI test jobs, the independent supply-chain job, and that
attestation job. A receipt binds source and tested bytes and does **not** claim that a
separately deployed Cloudflare artifact has the same image ID or static-tree
digest. The attestation subjects are the receipt JSON files themselves, not the
static tree, OCI image, registry image, or Cloudflare deployment they describe.
The first live `main` CI attestation receipt and independent readback of both
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
   smoke are green for that SHA. The exact-SHA attestation job is green, both
   bundles are preserved, and both evidence-manifest subjects pass an
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
| CI artifacts | static evidence, container evidence, and evidence-manifest attestation bundles named for that SHA |
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

The digest-pinned Playwright base is verified at Node 24.17.0 with npm 11.13.0
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

### Governance re-check (2026-07-25, read-only)

Re-read from the public rulesets API rather than assumed, because the snapshot
above is dated and governance is the gate a release leans on hardest:

- exactly one ruleset exists, `Protect main history`, active on `refs/heads/main`
  with rules `deletion` and `non_fast_forward` only. It still requires **no**
  status checks and **no** pull request or review;
- no ruleset targets `production`, so whatever protects it is classic
  protection, which the same snapshot recorded as linear history only;
- no tag ruleset exists, so `v*` tags are unprotected and a pushed tag can be
  deleted or moved by anyone who can push;
- no tag exists yet: `v0.2.0` has not been cut.

The repository side of the gate is now as strong as it can be without those
controls: both the promotion path and the release path verify every job in
`.github/required-ci-jobs.json` against a completed successful `main` push run
of this repository. That is enforcement by workflow, and a workflow cannot
constrain a direct push the way a ruleset can, so the four items above remain
operator work and remain release-policy blockers.

## Widening what a release may claim

The evidence schema accepts `development` and `released`, and it verifies the
released state rather than merely permitting it. It refuses a stable-API claim,
npm publication, a `1.0.0` or later version, and a tag that does not match
`v<version>`. Those refusals are the contract: widening any of them is a
separate, explicitly reviewed change to `scripts/release-evidence.mjs` and its
tests, never a side effect of cutting a version.

Reaching a `1.0.0` therefore takes more than a version bump. It requires a
written compatibility promise for the public report, feed, and export surfaces,
the durability and corpus gates in `docs/go-live-public-scanner.md`, the
supply-chain license review, and only then a reviewed widening of the evidence
schema.

Never infer a tag, stable API, or general-availability claim from the `0.x`
package version or from the existence of a public production deployment.
