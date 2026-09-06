# Validation and deployment performance

The objective is shorter time to trustworthy feedback and live deployment,
without changing report meaning or weakening the release contract.

## Maintainer delivery

Routine maintainer work is validated locally and pushed directly to `main`.
Main CI remains the full production gate; a PR is used only when explicitly
requested. This removes the PR-then-main validation cycle for routine work.

An existing PR head must not be reused when switching to this path. GitHub's
production rules evaluate same-named checks attached to the commit, including
cancelled PR jobs. On `8c4ccaf`, every required main job and attestation passed,
but cancelled PR checks blocked promotion. A fresh direct-to-main commit avoids
that collision while retaining the existing required checks and failed history.

## Measured bottlenecks

Baseline source: `e6051c4ca2bcc949b258edc9644c593642e50fba`. Its tree is identical
to PR #222's tested head `3ebef9dc17da14e69fd7f727f6ffc472504b0caf`.

- [PR CI](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/33986926509)
  took 26m28s; the same tree's
  [main CI](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/33988409866)
  took 20m38s. Runner variation makes a single cross-run difference an observed
  timing, not a controlled speedup measurement.
- On main, the application job spent 603 seconds in unit tests, 67 seconds in
  the runtime build, 379 seconds in the static export, and 40 seconds in static
  browser checks, sequentially. The container smoke/build spent 985 seconds;
  its Dockerfile independently runs the full checks on the container runtime.
- The main push was at 19:52:21 UTC on 2026-09-05. Cloudflare Pages reported
  success at 20:27:04 and Workers Builds at 20:34:27: 42m06s from push to the last
  provider success. These check records expose completion times, not build-start
  times; the whole gap must not be called Cloudflare computation time or live
  rollout verification.
- A CPU profile of all 887 managed report reads spent about two-thirds of its
  sampled CPU time serializing canonical JSON and hashing it in JavaScript.
  Corpus-wide correctness tests and static generation repeat this underlying
  operation, so optimizing it helps CI, Cloudflare rebuilds and runtime readers.

## Changes

- SHA-256 uses Node's synchronous native implementation when available, with
  the existing portable implementation for browsers and other runtimes. The
  [cross-environment loader](https://nodejs.org/docs/latest-v24.x/api/process.html#processgetbuiltinmoduleid)
  introduces no Node module import into browser bundles. Both paths hash the
  same bytes and are checked against independent vectors, Unicode cases and
  byte-array views. Canonicalization and instrument identities are unchanged.
- Canonical serialization reuses its diagnostic path and bounds a per-call
  cache of validated key encodings. It never caches report values, admissions,
  objects, or validation outcomes. NFC checks and exact canonical bytes remain
  part of the contract.
- Tests and static builds run as independent CI jobs. The existing required
  `Typecheck, Unit Tests, Build` check joins both and fails on any unsuccessful
  outcome, including skipped or cancelled work. Attestation and both production
  promotion paths still require that check. All existing checks still execute.
- Superseded PR runs are cancelled. Main and manual runs keep unique concurrency
  groups and retain their evidence and promotion lifecycle.
- The carrier archive error test first verifies the intact fixture, then makes
  the real Git archive command read an empty object store. It checks fresh and
  deliberately packed repositories and requires Git's actual diagnostic to be
  preserved. Deleting a loose blob was insufficient when a packed copy remained
  readable; that fixture assumption caused a false CI failure on `eacdc1a`.
  The verifier must still distinguish an unreadable repository from an invalid
  carrier; its production behavior and release gate are unchanged.
- Static generation compiles its schema tools once and uses that fresh artifact
  for both manifest and statistics generation. Docker dependency layers precede
  source-identity arguments so a new SHA does not invalidate unchanged package
  installation. Actual Docker cache savings depend on the builder's cache.

## Reproduction and evidence

Run `node scripts/benchmark-report-corpus.mjs` after installing the locked
dependencies. The command compiles fresh production tools and measures three
complete corpus reads in separate processes. Compilation and result hashing are
outside the measured interval. Use the same script, runtime, machine and corpus
on both revisions; compare counts and output fingerprints before timings.

On Node 24.14.1 on the same local machine, three fresh-process samples of the
complete managed reader had these medians:

| Source | Reports | Median |
| --- | ---: | ---: |
| Unchanged baseline | 887 | 36.465 s |
| Optimized reader | 887 | 23.985 s |

This is a **34.2% reduction** in that operation, not a claim of the same reduction
in the full pipeline. Every sample produced output fingerprint
`8ad94cc50ebffeda8f842bb55433c7c436b94c56390971e90b1050438bbd49c8`.
The before/after samples used the same reader modules compiled by the test
compiler; the checked-in benchmark uses the equivalent production compilation.
The PR records final CI timings and complete validation results.

## Remaining costs and boundaries

### Compiler and dependency caches (2026-09-05)

Pages and Workers build caching are enabled in Cloudflare. The Pages wrapper
retains only Webpack, SWC, TypeScript incremental state, and Next's `.rscinfo`
compiler identity in an isolated namespace under the provider's `.next/cache`.
Next still owns its normal key expiry and rotation. Generated reports, fetch
data, schemas, manifests, deployment receipts, and rendered pages are rebuilt.
CI uses a GitHub-scoped Docker layer cache with exact commit/proof build inputs;
the full container checks, smoke tests, and fresh security scans remain required.

Local full exports on Node 24.14.1 with the 887-report corpus took 303.45 seconds
cold, then 317.99 and 304.32 seconds warm. Webpack compilation fell from 10.7
seconds to 4.0 and 3.7 seconds. These samples establish compiler reuse, **not an
end-to-end speedup**. A separate small Next build verified unchanged warm reuse,
configuration-only invalidation, and source-only invalidation in fresh worktrees.

Between the warm exports, 1,792 of 1,795 JSON/CSV files were byte-identical.
The two corpus exports contained identical data after excluding their fresh
top-level generation timestamps. The third changed file was the freshly
generated report index; all 887 of its byte lengths and SHA-256 bindings were
checked independently against the exported report files. The deployment receipt
retained the exact source SHA. Static browser and accessibility checks passed.

The observed Cloudflare container build of production commit `6655907` took
25m01s. Workers' [dependency cache](https://developers.cloudflare.com/workers/ci-cd/builds/build-caching/)
does not preserve the Docker builder's layers;
that build still runs the full checks and runtime build. CI Docker cache savings
need a successful cache-producing run followed by a comparable warm run before
claiming a measured improvement.

### Release boundaries

The prebuilt-container follow-up implements an artifact handoff using the
existing release-evidence schema: main CI publishes the already smoke-tested
image, an isolated signer binds its registry digest to the original receipt,
and the production workflow verifies that evidence before deployment. See the
[cutover procedure](deploy-cloudflare-containers.md#production-deployment-from-the-tested-image).
The credential and single-writer cutover were exercised on `9f5330d`:

- [Main CI](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/34002782043)
  built and checked the container in 15m10s, then spent 1m37s publishing the same
  tested image. The complete Docker job, including smoke/security checks and
  evidence handling, took 19m20s. All required main gates passed before promotion.
- The scanner's Workers Builds Git connection was disconnected; Pages kept its
  production connection. The prebuilt deployment workflow now owns scanner
  deployments, using the existing registry and instance capacity.
- The [first deployment](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/34003795125/attempts/1)
  applied the image in seconds but failed its immediate readback while Cloudflare
  still returned the previous digest. The scanner subsequently served `9f5330d`.
  The verifier now waits for provider and runtime convergence with a deadline.
- A [retry of the same image](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/34003795125/attempts/2)
  completed its job in 47 seconds, including attestation verification, deployment,
  exact digest/SHA readback, and independent health dispatch. It performed no
  Docker build. This retry started after the image had already rolled out, so
  47 seconds is **not** a measurement of a fresh rollout's convergence time.

The preceding Workers build of `c6fa959` took 23m21s. Removing that duplicate build
is demonstrated; a controlled end-to-end speedup and complete Pages/scanner health
verification are separate measurements. The cache-only boundary below describes
the earlier change.

PR validation, trusted main validation, and Cloudflare deployment still have
distinct source and trust contexts. This change does not promote PR artifacts
or manufacture a main-commit attestation from another revision's results.
Deploying tested artifacts directly would need to bind the provider's actual
configuration and exact artifacts to the existing attestation and promotion
chain. That is a separate deployment change, not a cache flag.

Whole-corpus checks, static rendering of thousands of routes, and container
validation remain the largest costs. Supply-chain advisory checks still obtain
fresh data. Published reports, provenance sidecars, frozen schemas, test
coverage, and release thresholds are unchanged. A green PR establishes neither
deployment nor real-world detector accuracy; final live rollout timings require
a merged and promoted candidate plus independent live readback.
