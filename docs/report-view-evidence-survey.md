# ReportView evidence-surface survey (RFC 14.8 renderer migration)

Working note for the renderer migration. Captures what every consumer reads
from the v1 wire today, so the expanded `ReportView` contract
(lib/scan-report-view.ts) covers all of it before components migrate. Delete
when the migration completes.

## Why

The view seam currently carries counts, timestamps, design labels, and the
default-deny `ClaimPolicy`. Codex's review (2026-07-10, sixth round) named the
thin view a 14.8 blocker: migrating components now would push them back into
the raw wire. The contract must first grow the evidence surface below.

## What consumers read from the v1 wire today

Per-run evidence (all from `ScanResult`):

- `summary.*`: totalRequests, thirdPartyRequests, knownTrackerRequests,
  thirdPartyDomains, cookies, thirdPartyCookies, storageEntries,
  fingerprintEvents, shieldsBlockedRequests, status, durationMs,
  firstPartyDomain, pageTitle.
- `requests` (rows: domain, url, thirdParty, tracker, status, resourceType,
  blockedByShields, provenance) for the request table, CSV export, provenance
  highlights, GA-remarketing host checks.
- `domains` (DomainSummary rows) for entity summaries
  (trackerEntitySummaries), CMP detection, GA host checks.
- `cookies`, `storage` for tables and diff panels.
- `fingerprintEvents` (API counts) and `fingerprintDetections` (typed
  evidence per kind) for the fingerprint table, findings, and headline.
- `pixelEvents`, `cnameCloaks`, `privacyPolicy`, `consentInteraction` for
  findings and headline branches.
- `conditions.*`: scannedAt, finalUrl, automation, gpcEnabled, shieldsMode,
  adblock, consentMode, viewport, trackerCatalog, disclosure (methodology
  block in report-overview).
- `warnings`, `screenshot`, `share`.

Comparison-level (from `ComparisonScanResult`): `diff.*` metric deltas and
added/removed lists (domains, entities, cookies, storage keys,
fingerprinting, pixel events, provenance), `runLabels`, `comparisonType`,
`title`, `warnings`.

## Consumers to migrate (in order)

1. `app/_components/report-overview.tsx` (summary + conditions disclosure).
2. `app/_components/report-tables.tsx` (requests/cookies/storage/fingerprint
   /pixel tables).
3. `app/_components/comparison-panel.tsx` (diff tiles + lists; already
   consults `comparisonEligibility`, should consult `view.claims`).
   DONE 2026-07-10: banner on `view.claims.pairComparison`, run labels on
   `view.comparison.runLabels`. The diff tiles/lists still read the v1 wire
   `diff` (raw evidence, not claims); they move to arm-derived deltas in the
   v2 render slice, since v2 comparisons carry no precomputed diff.
4. `lib/report-headline.ts` + `lib/report-findings.ts` (claim wording; must
   consult `view.claims` instead of the interim gate; two-arm evidence work
   lands here). DONE 2026-07-10: both engines take `ReportView`; every
   comparison number and entity list derives from the two arms' run views
   (`comparisonArmViews`), so a tampered wire diff cannot drive wording
   (pinned in both engine test files), and `claimsForV1Report` is retired in
   favor of `view.claims` everywhere. `RunView` gained the `consent` block
   (v1 `clicked` / v2 `controlActivated`) the consent framings key on.
5. `app/site-behavior-app.tsx` shell (state holds `LoadedReport`; exports via
   `publicWireForExportOrPersistence`). PARTIAL 2026-07-10 (second slice):
   every rendering read in the shell is now view-fed. `ReportHeader` takes
   view + run (title from the new `ReportView.title`, wire report kept only
   for the share permalink), `CausalityGraph` takes the request slice,
   `Warnings` renders the new report-level `ReportView.warnings` (v1 wire
   list; v2 derives run-labeled entries), and the sidebar
   (screenshot/pixels/methodology incl. the new `conditions.adblockLists`,
   `trackerCatalog.region`, `consent.cmp`, and `disclosure`) reads the
   display run's view. No `ScanResult` remains in the shell; what's left is
   the `ScanReport` STATE plus the seven v1 producer paths, which swap to
   `LoadedReport` in the v2 render slice per the sequencing decision below.
   SEQUENCING DECISION (2026-07-10,
   after the claims consolidation): deferred until the v2 render slice. All
   seven producer paths (sync scan, poll, upload, PageGraph, gallery
   comparison, saved-page initialResult, recovery) are v1-only because
   `readRenderableReport` rejects v2 by design while renderers cannot draw
   it, and the shell already derives `reportView`/`primaryRun` from `result`
   each render, which IS `LoadedReport{source:"v1"}` decomposed
   (wire=result, view=derived). Swapping the state shape before a v2 source
   can arrive changes no behavior and risks a broad half-refactor; do it in
   the same slice that teaches `readRenderableReport` to return v2 loads.
6. Metadata/OG (`lib/report-jsonld.ts`, og image route), directory, sitemap.
   DONE 2026-07-10 except the sitemap: `generateMetadata`, both OG image
   routes, the JSON-LD dataset, the gallery headlines, and the directory
   builder (`corpus-overview`, incl. `consentClicksForView` and the
   claims-gated Shields reduction) all consume `ReportView`; the metadata/OG
   surfaces read via `readStoredReportForId` + `toReportView` and so will
   serve v2 reports the moment the store holds them. The sitemap still uses
   the v1-narrowing `readReportForId` (it reads only id/scannedAt); fold it
   into the v2 render slice.

## Contract sketch (to be refined against the v2 run shapes)

Extend `RunView` with an `evidence` block mirroring the v1 names where the
concepts match v2 (`ScanRunV2` evidence blocks, `RunEvidenceR2`), plus:

- `conditions`: normalized disclosure facts (automation, gpc, shields mode,
  adblock, consent mode, viewport, catalog, timezone/locale where recorded).
- `warnings: string[]` per run; comparison-level warnings on the view root.
- `quality`: run-level outcome and censoring reasons (v2 records these;
  v1 derives status>=400 and cap warnings as legacy-derived quality guesses,
  marked as such).
- `screenshotPolicy`: data-URI-only display rule stays in the view so
  renderers cannot regress it.
- Sharing/download policy: `wire` serialization only, via
  `publicWireForExportOrPersistence` (already enforced at the seam).

Rules that must not regress during migration:

- Renderers consult `view.claims` (default-deny), never `kind`/`limited`.
- v1 facts are `legacy-derived`; never presented as recorded v2 fact.
- Raw per-run evidence always renders; claims gates govern wording only.
- Screenshot display stays data-URI-only (upload beacon fix, 4763242).
- Fixtures: v1, v2 r1, v2 r2, inconsistent, and future-revision payloads
  must pass through every migrated consumer's tests.
