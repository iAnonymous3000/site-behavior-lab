# Changelog

All notable changes to Site Behavior Lab are documented here.

The format is based on Keep a Changelog. The project has not declared a stable
public API or a 1.0 release.

## Unreleased

Work landing after the 0.4.0-rc.1 milestone. Nothing here is released.

## [0.4.0-rc.1] - 2026-07-31

Release-candidate rehearsal for the prerelease tag mechanics the 1.0 ceremony
will use, cut on the release-1.0 preparation batch. It does not declare a
stable public API, enable npm publication, or claim any readiness gate that
its own evaluator reports as failing. ScanReport contracts are unchanged
(v1 frozen, v2/r1 and v2/r2 byte-immutable).

### Added

- A machine-readable release-readiness manifest (`RELEASE_READINESS.json`)
  evaluated by `npm run release:readiness`: release decisions stay red until
  a named human approves them, derived gates re-score committed evidence on
  every run without trusting any artifact's self-declared verdict, and
  operator attestations bind a literally-true statement contract to the
  target release with per-gate freshness windows. The proposed compatibility
  promise is digest-pinned by its decision. The evaluator currently reports
  NOT READY, and a test pins that honest state.
- The corpus statistics artifact now keeps one distribution cohort per exact
  schema/revision, methodology, tracker-catalog, ServiceRole-taxonomy,
  metric-contract, producer, and requested-GPC identity, and percentile
  wording requires both the exact cohort and the named metric to reach the
  50-site floor. `metric-contract-v1` and `service-role-taxonomy-v1` are
  published as digest-pinned artifacts, separating all catalog-matched
  request rows from the read-time third-party tracking-role subset.
- A measurement-freeze switch (`SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE`)
  quiesces every corpus writer except the controlled collection lane, with a
  loud notice job on each skipped writer and a preflight refusal of both
  frozen-v1 lanes during a freeze.
- Preregistered A/A repeatability studies: a declared-before-collection
  preregistration (frame digest, repetitions, conditions, thresholds) and an
  evaluator that treats binding mismatches, including a preregistration
  declared after collection began, as identity violations rather than
  threshold failures.
- Detector-calibration readiness is derived by re-analyzing committed studies
  against the exact current release identity on every build, so a study
  bound to an earlier build, catalog, or filter-list revision demotes itself;
  the committed pixel pilot is disclosed as ineligible instead of invisible.
- Operational evidence became machine-readable receipts: controlled-runner
  destruction receipts with a fail-closed verifier, an R2 lifecycle readback
  (API-token or wrangler-OAuth sourced) that detects conflicting retention
  rules production health cannot see, a durable archive lane that copies each
  release receipt into the repository after digest review against the
  annotated tag, and a third-party review ledger with one version-keyed row
  per inventory item gated against drift in CI.
- The report-consistency gate validates rendered semantics (absence claims,
  identity conflicts, reassuring copy over loud findings, subject scope)
  against structured report facts, and report identity flows through one
  exact per-host catalog seam that never renders the lossy one-slot domain
  summary directly.

### Changed

- Every pressable control meets the 44px touch-target floor whenever any
  coarse pointer exists, without inheriting the narrow-viewport layout; the
  static smoke asserts computed target sizes in both a mobile and a wide
  hybrid-pointer context, and the two error boundaries gained their first
  coverage.
- Both production promotion workflows can mint their App token via the
  non-deprecated client-id input the moment the operator stores the App
  client id; the deprecated path keeps working until then.
- The thirteen 2026-07-21 featured-site deferrals were removed ahead of
  their hard expiry so the next scheduled cycles can generate fresh
  adjudication evidence; deferral-exclusion mechanics remain covered by
  synthetic tests.
- The release runbook documents rollback (revert forward through the pull
  request flow; tags and production never rewind), the identity-versus-bytes
  meaning of the committed-report freeze, quantified durable-jobs soak
  durations, and the measurement-freeze rules a repository variable cannot
  enforce.
- The v0.3.0 release receipt is durably archived in-repository with its
  digest verified against the annotated tag.

## [0.3.0] - 2026-07-30

Pre-1.0 milestone prepared for the repository's first attested tag ceremony.
It does not declare a stable public API, enable npm publication, turn automated
observations into legal conclusions, or claim that disabled operational paths
are live. The ScanReport schema contracts (v1 frozen, v2/r1, v2/r2) continue to
version independently.

### Added

- Exact-source release receipt isolation now separates candidate builds,
  hostile-data validation and attestation, and atomic tag publication. The
  release gate independently requires the exact promoted commit and all five
  named main-branch CI conclusions.
- Detector accountability records the exact detector and phase obligations for
  each metric family, preserves historical producer tuples, and refuses to use
  public output as proof that a detector ran.
- A first pixel-events calibration pilot exercises the labeled-study pipeline
  and deliberately publishes no precision or recall rate because it contains no
  representative labeled cases.
- Real-site scanner-fidelity coverage checks both supported wire generations,
  renders every returned report, and rejects contradictions between navigation,
  detector status, findings, and reader-facing summaries.
- Production-control receipts now record the bounded WAF admission ceiling,
  log-retention queries, and required R2 create/read/delete/absence canary
  without treating those observations as permanent infrastructure guarantees.

### Changed

- Report and corpus metrics now remain cohort-, methodology-, producer-, and
  detector-status-specific. Unsupported, omitted, censored, or deadline-lost
  families remain unavailable instead of silently becoming reassuring zeroes.
- Featured and one-off report publishers now propose reviewed pull requests;
  corpus floors are structural, and a stale proposal must be regenerated from
  one current tree rather than updated in place.
- Both production promotion paths authenticate with a repository-scoped GitHub
  App token and keep checkout credentials out of Git configuration. The
  production updater ruleset grants that App its sole bypass while the exact-
  SHA evidence ruleset retains none; freeze refusals and the positive
  promotion canary are recorded separately from workflow source.
- The browser and container measurement toolchain moved to Playwright 1.62,
  the application moved to Next.js 16, and reviewed GitHub Actions pins and
  dependency overrides moved with the corresponding evidence contracts.
- Evidence Library, comparison, shared-link, print, reduced-motion, live-scan,
  and narrow-screen states now expose more of their evidence and status without
  turning missing or incomplete observations into verdicts.

### Fixed

- Detector-specific failures, phase omissions, capture loss, and evidence caps
  no longer borrow another detector's success, report unmeasured rates, or use
  budget-exhaustion language for a bounded evidence cap.
- CNAME, privacy-policy, platform-request, consent, navigation, detached-frame,
  and third-party-host findings now stay aligned with the exact facts their
  detectors observed.
- Scanner setup, CNAME resolution, worker fetches, cancellation, durable-job
  pumping, and response parsing now spend and report the deadline that actually
  governs them instead of continuing work or misclassifying the stop.
- A blocked or still-working scan no longer reads as a clean result or failed
  navigation, and a widget or shared-link error no longer blanks otherwise
  valid live evidence.
- Corpus cards and rankings no longer pool incompatible cohorts, count covered
  sites as measured sites, or headline comparison deltas that the selected pair
  could not support.
- Link-state announcements, new-tab disclosure, printable evidence, reduced
  motion, mobile overflow, and representative control-state handling were
  repaired across the report and scan surfaces.

### Security

- `main` now uses a no-bypass, linear-history pull-request ruleset with strict
  candidate checks and resolved review threads; any matching `v*` release tag,
  once created, is protected from update or deletion by a separate no-bypass
  ruleset.
- Production promotion authority is separated from ordinary workflow tokens,
  while exact-SHA evidence checks stay in a distinct no-bypass boundary.
- Supply-chain CI verifies the deterministic dependency/filter inventory,
  audited registry state, Rust advisories, repository configuration, and the
  smoke-tested runtime image without suppressing blocking findings.

### Documentation

- Release and governance documentation now distinguishes source evidence,
  deployment convergence, environment approval, immutable tags, the closed
  production-updater gate, and the still administrator-bypassable,
  non-App-exclusive tag-creation path instead of presenting them as one gate.
- Evidence and calibration language states that one automated visit is a
  lower-bound observation rather than a universal or legal conclusion, and
  that a pilot with no representative labeled cases cannot emit rates.

## [0.2.0] (declared 2026-07-25; never tagged)

Milestone of the pre-1.0 development line, declared for tagging on 2026-07-25.
No `v0.2.0` tag or GitHub release was created. On 2026-07-29 the release policy
returned to development rather than retroactively tagging a later tree. The
0.3.0 milestone supersedes that untagged declaration, while this section remains
as the source-level record of what the project called 0.2.0. Neither declaration
creates a stable public API or enables npm publication. The ScanReport schema
contracts (v1 frozen, v2/r1, v2/r2) version independently of this line and are
unchanged by it.

These entries describe source-level work on the private development line. A
feature-gated path, test, canary, or runbook is not evidence that its external
activation gate has passed or that the corresponding production control is live.

### Added

- A machine-readable development release policy plus deterministic exact-clean-
  HEAD receipts for the tested static tree and local container image. CI retains
  both receipts under artifact names containing the tested commit.
- OCI source, revision, title, and license labels on the runtime image, with the
  release-evidence gate requiring its label and embedded runtime commit to agree.
- Native v2/r2 temporal-report construction for archive and uploaded singles,
  with chronology, subject/device identity, methodology, producer, toolchain,
  per-family comparability, and every diff recomputed before rendering or
  export. Mixed v1/v2 pairs and frozen v2/r1 pairs refuse explicitly.
- An active-producer contract matrix that takes Node/Playwright and request-only
  PageGraph r2 output through managed receipt validation, rendering, temporal
  comparison, and corpus shaping while separately pinning the controlled
  featured-corpus preflight. Retired Browser Run output remains outside active
  parity, and PageGraph-unsupported families remain unavailable rather than
  zero.
- Analysis-only repeated-pair and detector-calibration contracts. Repeated
  effects remain metric-scoped and descriptive, while detector rates require a
  separately labeled study with complete denominators; no representative
  calibration study, population-effect claim, or detector-accuracy claim is
  supplied by the repository today.
- A keyboard and assistive-technology contract covering replacement-region
  focus, sibling page landmarks, explicit directory submission, non-tooltip
  explanations, visible clipped-card focus, comparison announcements, text
  equivalents for request timelines, definition-list semantics, and touch
  targets. Static browser smoke also samples representative light, dark,
  archive, comparison, report, explorer, and narrow states for serious or
  critical Axe findings; that is not WCAG certification or manual screen-reader
  coverage.
- A shared browser JSON-fetch policy with connection and whole-operation
  deadlines, decompressed-response byte ceilings, caller-abort composition,
  and latest-operation ownership. Report, archive, comparison, corpus,
  scanner-health, ordinary and durable scan-submission, admission-recovery, and
  cancellation reads now cross bounded response-body contracts.
- Request-bound durable-admission recovery using a fresh 256-bit browser
  capability, canonical semantic commitment, tab-scoped pre-POST retention,
  header-only readback, and one atomic quota/work/recovery record. The browser
  enables it only when health reports a ready durable edge, and inability to
  retain the recovery capability stops the POST before any request leaves the
  tab.
- A budgeted persistent durable-job pump that prioritizes lease recovery and
  ordinary dispatch, isolates optional scheduled-rescan failures, aborts hung
  work, and persists a successor before yielding. Durable execution and its
  sharding path remain disabled in the committed production configuration.
- Accountless encrypted scheduled rescans with bounded cadence, TTL, attempts,
  history, atomic quota/admission, capability-only management, Worker-only
  encryption and key rotation, and fresh target validation. The post-durability
  feature flag remains off in production and still requires the staged canaries
  and operator receipts in its runbook.
- A fixed-prefix, independently authenticated R2 create/read/delete/absence
  canary plus a production-health lane. Its Worker, secrets, URL, and required
  gate are not configured live, so the implementation does not prove deletion
  of production report objects.
- Crawlable, canonical per-site profiles, paginated directory pages, qualified
  category summaries, corpus exports, and a searchable detector catalog.
- Compact evidence receipts, report breadcrumbs, exact-rescan and history
  paths, social cards, and an evidence-problem reporting link.
- A public status page that fails closed across current, stale, degraded, and
  unknown deployment or artifact evidence.
- Public security and corrections pages, RFC 9116 security.txt discovery, and
  an append-only machine-readable corrections ledger contract.
- Truthful scan stages and tab-scoped recovery for accepted jobs without
  persisting scanner access keys.
- A disabled-by-default, enum-only aggregate observability boundary with
  Global Privacy Control and Do Not Track opt-outs.
- Contribution, conduct, code ownership, issue-form, pull-request, citation,
  and source-package metadata.

### Changed

- The homepage now leads with the scan task, delays archive and full-report
  code until requested, and offers server-selected examples plus known-site
  history without downloading the full manifest on first load.
- Saved report pages server-render a compact summary and load the full evidence
  explorer only after the reader requests it.
- Canonical, Open Graph, Twitter, robots, and sitemap output now uses one
  fail-closed public HTTPS origin and respects the configured base path.
- Runtime scanner pages and expiring runtime report URLs are excluded from
  search indexing while currently retained, versioned static evidence remains
  discoverable.
- Featured-corpus refreshes use bounded transient-only retries and require at
  least 80 percent active-catalog coverage across at least 50 sites; temporary
  deferrals are versioned, time-bounded, and publicly explained.
- Revision-2 featured-corpus publication is gated on an attested stable-region
  self-hosted runner, exact clean-checkout provenance, consent verification,
  and persistence checks. Automated schedule and repository dispatches require
  that controlled r2 lane once the runner label is configured; until then the
  weekly refresh continues on a loudly disclosed frozen v1 fallback (workflow
  warning annotation, distinct commit message) instead of failing against
  unprovisioned infrastructure. Legacy v1 otherwise remains an explicit manual
  dispatch lane, and manual v1 cannot reconcile the authoritative refresh state.
- Corpus statistics, category summaries, leaderboards, and researcher exports
  now select exact schema/methodology/recorded-producer cohorts. R2 and legacy
  v1 data are never silently pooled; rows expose provenance, quality,
  consent-verification, comparison-decision, compatibility, inclusion, and
  cohort-denominator metadata while excluded rows remain auditable.
- Node r2 facts now travel with the frozen-v1 compatibility result in an owned,
  process-local, non-serializable measurement envelope, so cloning, queuing,
  and async execution cannot silently detach evidence before public or shadow
  emission.
- Valid HTTP 600-999 observations now cross the frozen r2 boundary as `null`
  plus explicit request-family capture-loss facts instead of a fabricated 599.
  Readers remain strict, and affected navigation claims are treated as failed
  or incomplete rather than reassuring privacy results.
- Comparison changes are presented as signed variant-minus-baseline
  observations, including per-domain request contributions, without treating
  either direction as inherently better or upgrading descriptive differences
  into causal claims.
- Encrypted-watch creation shares the ordinary Turnstile or scanner-token gate
  and atomic quota path; an optional separate edge-only factor is confined to
  isolated operator staging canaries and never reaches the public browser.

### Fixed

- Single-column mobile grid collapses now use `minmax(0, 1fr)` like their
  desktop counterparts, so an item whose font-dependent minimum content width
  exceeds the viewport (as on CI's font set at 390px) can no longer blow the
  track out and force page-level horizontal overflow.
- The runtime container image no longer ships the base image's global package
  managers (npm, npx, yarn, corepack, whose bundled tar, undici, and sigstore
  copies carried fixed-upstream HIGH/CRITICAL advisories the app never
  executes) or the WebKit-only GStreamer "bad" plugins. Container release
  evidence now asserts the package-manager absence instead of a version, and
  the blocking Trivy image gate passes on real findings removal, not
  suppression.
- A consent control identified by a known CMP selector keeps its CMP
  attribution when its page-owned click handler throws on the first dispatch
  and the control only reacts to the later generic-tier retry; the report no
  longer downgrades that click to a generic text match.
- The promotion smoke and the hourly production synthetic no longer hard-depend
  on one third party: both walk an ordered list of fixed, independently hosted
  candidate targets (iana.org, then w3.org; the synthetic's candidates stay
  server-allowlisted for the monitor credential), fall through only on a
  target-attributable scan failure with a logged warning, and stay red when
  every candidate fails, which indicates scanner-side breakage.
- Directory search now normalizes pasted URLs and `www` hosts, keeps one
  current profile per canonical site, and selects the newest eligible Shields
  comparison independently of the latest general report.
- Public-suffix-apex sites such as `gov.uk` remain discoverable, and pasted
  subdomain URLs resolve to their canonical site profile.
- Corrections-linked original and replacement reports are protected from age
  and count pruning, with malformed or dangling ledger references failing
  closed before deletion.
- Correction events now render on the public ledger and affected report pages;
  corrected, superseded, or withdrawn reports are `noindex`, and CI enforces
  unchanged event history plus byte-identical previously pinned bundles.
- Scanner workflows reject stale local processes and fail safely on a
  non-fast-forward publication race instead of rebasing already validated
  retention output.
- Status freshness expires in the browser instead of leaving a stale positive
  badge, and status copy no longer implies that endpoint alignment proves a
  successful scan or storage round trip.
- Evidence-problem links open the required GitHub form with safe report fields,
  and runtime status reads the canonical public deployment receipt rather than
  a missing scanner-local file.
- Mobile evidence receipts wrap safely at 320 CSS pixels, and source links for
  validation fixtures are pinned to the exact public build commit.
- Stale or superseded browser reads can no longer overwrite newer report state
  or clear its busy indicator, and oversized or stalled JSON responses fail at
  the shared bounded transport boundary.
- Ordinary scan submission, scanner-health, and cancellation responses now
  bound stalled headers, stalled bodies, malformed JSON, and decompressed size;
  caller cancellation remains distinct from a transport deadline.
- Outcome-unknown durable submissions retain one request-bound admission across
  reload and use a bounded, header-only GET window to recover exact accepted
  identifiers without another POST. Exact retries converge without charging
  quota or admitting work twice; changed semantics fail before the network,
  definitive rejections clear the pending record, and uncertain failures keep
  it available through the accessible recovery UI.
- Turnstile validation derives a retry UUID from the admission capability hash
  and exact challenge token: the same token converges on one Siteverify
  operation, while a refreshed challenge receives a distinct identity.
- Failed r2 navigations whose exact status is unrepresentable now lead report
  headlines and findings with an explicit incomplete-load explanation; quiet
  or positive absence cards are downgraded instead of becoming false claims.
- The CONNECT egress proxy preserves already queued response bytes through a
  graceful tunnel half-close instead of truncating them when one side ends
  first.

### Security

- A direct GitHub private vulnerability reporting path replaces ambiguous
  disclosure instructions.
- Public canonical-origin validation requires a public DNS-style hostname and
  rejects IP literals plus local or special-use names; recovery state stores
  only opaque job capabilities and bounded timestamps.
- Routed GPC initialization binds script and worker instrumentation to the
  measured first-party request, preserves worker/module semantics, and refuses
  redirects or request-metadata drift. Unparseable modules keep their original
  bytes and produce disclosed, bounded capture loss rather than aborting or
  silently overstating GPC coverage.
- Durable admission and encrypted-watch capabilities stay in headers or URL
  fragments rather than request paths and queries; authoritative stores retain
  only bounded identifiers, hashes, encrypted targets, and required recovery
  metadata rather than raw browser bearers or caller identity.

### Documentation

- A correction-review workflow requires immutable report identities and
  append-only dispositions.
- Operator guides document the revision-2 corpus rollout and the disclosure,
  infrastructure, and review gates required before aggregate observability can
  be enabled.
- Release and operator runbooks separate clean-source artifact receipts from
  live deployment proof and record the still-open governance, preview-access,
  Node-version, delete-canary, and independent-egress gates.
- The research evidence model documents why repeated directional observations
  are not replication or causal claims and why source-pinned acceptance
  fixtures are not detector calibration data.
- Durable-job, encrypted-watch, and R2 delete-canary runbooks require isolated
  staging, distinct credentials, explicit teardown, exact-source readback, and
  a separately reviewed production activation; none of those documents
  authorizes enabling the currently off feature flags.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[0.4.0-rc.1]: https://github.com/iAnonymous3000/site-behavior-lab/releases/tag/v0.4.0-rc.1
[0.3.0]: https://github.com/iAnonymous3000/site-behavior-lab/releases/tag/v0.3.0
[0.2.0]: https://github.com/iAnonymous3000/site-behavior-lab/commit/4240d32d1fa987e8d61d74fe719f6a8382422efa
