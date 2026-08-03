# Release 1.0 compatibility promise

Status: APPROVED 2026-08-02. This document is the reviewable artifact behind
the `compatibilitySurface` decision in `RELEASE_READINESS.json`, which pins
its exact bytes by digest. Editing this file without updating that digest
turns the readiness gate red by construction; the approved decision approves
this exact text. Release 1.0 promises the surfaces below and nothing else.

## What 1.0 promises

Each numbered surface is stable for the life of the 1.x line under the rules
given for it. "Additive" always means: existing fields, keys, columns, and
their meanings never change or disappear; new ones may appear.

1. **Report JSON.** ScanReport v1 stays frozen and readable forever. The
   published v2 revision schemas (`public/schemas/scan-report.v2.r*.json`)
   are byte-immutable once released; corrections travel as errata on
   `/methodology/` and land only in a NEW revision. Readers keep consuming
   every previously published revision for the life of 1.x (dual-read is the
   floor, never a migration). A new revision is additive at the reader seam:
   `readStoredScanReport` accepts every published generation and reports
   unsupported FUTURE revisions as a capability gap, never as corrupt data.
2. **Report permalinks.** `/reports/<id>/` and its `.json` neighbor identify
   one immutable measurement for as long as that report is retained.
   Retention itself is the documented policy: committed corpus reports are
   pruned by the automated retention process (age, count-ceiling, and cohort
   rules, with corrections-ledger pins exempting named ids), and public-scan
   reports follow the documented application TTL. A permalink never changes
   meaning; it either serves the same measurement or honestly ceases to
   exist, and a corrected measurement always appears under a NEW id.
3. **Per-site Atom feeds.** `/sites/<registrable-domain>/feed.xml` remains
   the feed route. Every entry keeps carrying: a stable entry id, the report
   permalink, `updated`, and a title naming the site and visit. Feed-level
   `id`, `title`, `updated`, and `author` remain present. Additions are
   allowed; removals and semantic changes are not.
4. **Corpus statistics JSON.** `public/corpus-stats.json` keeps its top-level
   keys and per-cohort identity fields (schema/revision, methodology,
   producer, gpc, tracker-catalog, service-role-taxonomy, and
   metric-contract identities) additively. Distribution objects keep
   `count`, `min`, `max`, and the published percentile marks. Cohorts are
   never silently pooled across identities.
5. **Researcher CSV export.** Column order is append-only: existing columns
   keep their position and meaning; new columns append. A column whose
   meaning must change instead appears as a NEW column, and the old one is
   retired only at a major version.
6. **Versioned public artifacts.** `public/metric-contract.v1.json` and
   `public/service-role-taxonomy.v1.json` are digest-pinned and immutable at
   their version; changes mint the next version alongside the old one.
7. **Schema alias movement.** The unversioned alias
   `public/scan-report.schema.json` moves only at a release boundary, is
   announced in the CHANGELOG, and the superseded revision's schema stays
   published at its versioned path.

## What 1.0 explicitly does not promise

- Admission, job, cancellation, health, and every other API under
  `/api/`: operational interfaces, changeable at any time.
- UI layout, DOM structure, CSS class names, screenshots, and social-card
  rendering.
- The npm package name or any importable module path: npm publication stays
  disabled and the repository is not a library surface.
- Scanner-internal vocabularies (warning strings, detector reason codes)
  beyond what the published report schemas themselves freeze.
- Timing, scheduling, or availability of scans, refreshes, or the public
  scanner deployment.

## Change discipline

A change to a promised surface requires, in one reviewed change: the surface
edit, the digest update in `RELEASE_READINESS.json`, a CHANGELOG entry, and
(for report JSON) the errata/revision mechanics above. The release-readiness
evaluator fails whenever this document and its pinned digest disagree, so the
promise cannot drift silently.
