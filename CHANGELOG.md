# Changelog

All notable changes to Site Behavior Lab are documented here.

The format is based on Keep a Changelog. The project has not declared a stable
public API or a 1.0 release.

## Unreleased

### Added

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
  and persistence checks; the existing revision-1 lane remains the default.

### Fixed

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

### Security

- A direct GitHub private vulnerability reporting path replaces ambiguous
  disclosure instructions.
- Public canonical-origin validation requires a public DNS-style hostname and
  rejects IP literals plus local or special-use names; recovery state stores
  only opaque job capabilities and bounded timestamps.

### Documentation

- A correction-review workflow requires immutable report identities and
  append-only dispositions.
- Operator guides document the revision-2 corpus rollout and the disclosure,
  infrastructure, and review gates required before aggregate observability can
  be enabled.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
