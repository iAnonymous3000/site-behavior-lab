# Changelog

All notable changes to Site Behavior Lab are documented here.

The format is based on Keep a Changelog. The project has not declared a stable
public API or a 1.0 release.

## Unreleased

Work landing after the 0.2.0 milestone. Nothing here is released.

## [0.2.0] - 2026-07-25

First tagged milestone of the pre-1.0 development line. This does not declare a
stable public API, and npm publication stays disabled: the tag marks a reviewed,
CI-green, promoted source revision with an attested evidence receipt, nothing
more. The ScanReport schema contracts (v1 frozen, v2/r1, v2/r2) version
independently of this line and are unchanged by it.

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
[0.2.0]: https://github.com/iAnonymous3000/site-behavior-lab/releases/tag/v0.2.0
