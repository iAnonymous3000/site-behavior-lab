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
build commit, the independently executed Node 24.18.0 version, and the asserted
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

The digest-pinned Playwright base is verified at Node 24.18.0 with npm 11.16.0
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
affect in-flight runs. Two rules the variable cannot enforce: do not MERGE any
open `automation/*` proposal during a freeze window (a proposal validated
before the freeze still carries pre-epoch inputs), and schedule the featured
deferral re-adjudication (`reviewAfter` dates) before the window so the
collection lane does not go red mid-epoch.

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
policy widening wires the check into the release workflow as a required
step; until then it is advisory, and a unit test pins the honest NOT READY
state so the surface cannot drift.

Three gate families, all fail-closed (the manifest, not this prose, is the
authoritative gate list):

- **Decisions.** Recommended values are recorded in the manifest but stay
  red until a human edits the decision to `"status": "approved"` with
  `decidedBy` and `decidedAt`. The gate carries its own required-decision
  list, so deleting a pending decision is a failure, not an approval. A
  recommendation in a manifest is not a decision; approving one is a
  reviewed change like any other. The `compatibilitySurface` decision
  additionally pins the exact sha256 of `docs/compatibility-promise.md`, so
  editing the promise without re-approving it turns the gate red, and the
  open-errata gate stays red until the revision decision that can carry the
  fixes is approved.
- **Derived gates.** Corpus denominators, A/A studies, calibration
  eligibility, the third-party review ledger, runner destruction receipts,
  the lifecycle readback receipt, and the release-receipt archive are all
  re-derived from committed evidence on every run; no artifact's
  self-declared verdict is trusted (A/A studies are re-scored from their
  preregistration and ledger, lifecycle rules re-validated from the recorded
  rule bytes, runner cycles counted as distinct Actions runs). Missing,
  malformed, future-dated, or stale evidence is a failure with a reason,
  never a skip.
- **Operator attestations.** Host truths code cannot see (durable soak,
  egress backstop, WAF ceilings, log retention, staging teardown, container
  image licensing) require a JSON attestation under `research/ops-receipts/`
  shaped as:

  ```json
  {
    "kind": "site-behavior-operator-attestation",
    "gateId": "egress-backstop",
    "attestedBy": "iAnonymous3000",
    "attestedAt": "2026-08-15T00:00:00Z",
    "statements": [
      { "claim": "Private, link-local, and metadata destinations are blocked by an independent network boundary.", "true": true }
    ],
    "evidenceRefs": ["actions-run-<id>", "network-policy-export-<digest>"]
  }
  ```

  Every statement must be literally true; the validator refuses soft values.

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
