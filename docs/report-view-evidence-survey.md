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
   DONE 2026-07-10 (fully): banner on `view.claims.pairComparison`, run
   labels on `view.comparison.runLabels`, and the diff tiles/lists on
   `comparisonDiffView` (scan-report-views), which derives the v1-shaped
   diff from the two arms through `compareRunFacts`, the SAME builder the
   producer's `compareScanResults` now delegates to, so parity with the
   wire diff holds by construction (pinned) and v2 pairs (whose wire diff
   is family-shaped) or tampered uploads render identically. The panel no
   longer takes the wire report at all.
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
   serve v2 reports the moment the store holds them. The sitemap moved to
   the stored read + view as well (same follow-up slice), and the
   v1-narrowing `readReportForId` wrapper is deleted; every server surface
   now reads through `readStoredReportForId`.

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

## Codex round 7 (2026-07-11): compound claim gates and the corrected order

Round 7 rejected the "one final unit remains" convergence claim: most of
`ClaimPolicy` was dead (only `pairComparison` consulted anywhere), so the
seam SAID familyDeltas-denied while 114/235 committed reports published
delta wording, `v2Claims` could grant attribution without pair validity, a
legacy "custom" comparison was misread as temporal, censored/capped runs
still earned the calm headline, and the pixel headline asserted more than
field population proves.

Landed in the compound-gates slice (this commit):

- `legacyClaims` now states per family what v1's recorded facts prove
  (RFC 4.4 enforcement + 10.1 legacy-display continuity): raw-counts behind
  the whole-pair rule; tracker-classification additionally behind catalog
  source/version/region equality; shields-simulation behind both arms
  carrying an active same-mode measurement from the same list snapshot
  (denies every Shields-axis pair by construction, subsuming the panel's old
  special case); consent-verification and detector-findings always denied
  (dispatch is not verification; detector versions were never recorded).
  All of it supports DESCRIPTIVE wording only.
- Engines and panel consume the compound gates: count-delta wording needs
  pair + raw-counts; the findings Shields card composes per allowed family
  (v1 cards no longer quote fingerprint-call deltas); the panel renders
  tiles/lists per family with human-readable suppression notes, and a
  pair-invalid comparison shows NO deltas at all (runs render as
  independent evidence).
- `v2Claims` attribution now requires `pairValidity.eligible` on top of
  `interventionVerified`.
- The GPC alarm headline is descriptive ("still contacted N tracking
  companies with a privacy signal on ... versus M without"); "the signal
  barely changed what loaded" is RFC-4.4 attributed phrasing reserved for
  `claims.interventionAttribution`, which nothing readable grants yet.
- `ComparisonView.temporalPair` (explicit design marker) drives lead-run
  choice, the temporal findings card, and the panel eyebrow; "custom"
  pairs stay baseline-led with their own labels.
- `runCensorshipNotes` + quality-gated calm surfaces: a capped/censored run
  gets "scan was cut short" instead of "relatively private", and the
  findings bottom line says the quiet result is a floor.
- Pixel wording: "sent data in personal-identifier fields" (population is
  proven; values/hashing/matching are not), conditional no-sale conflict.

Remaining per the round-7 order (next slices, in order):

1. UI provenance surfacing: DONE (323ee28): schemaProvenanceLabel chip in
   the report header, Schema + Run quality methodology rows via
   runQualitySummary (recorded vs derived basis stated).
2. Two-arm evidence switcher: DONE (37951af): arm switcher below the panel
   drives every per-visit surface (tables, sidebar, methodology, causality
   graph) and the CSV export (filename names the arm); defaults to the lead
   run, resets per report; pair-level surfaces untouched.
3. View-contract expansion: MOSTLY DONE (a042466): ephemeral screenshots
   restored onto the view by the transport reader, adblockActive from the
   recorded shields condition, urlsAreRouteShapes gates the header link,
   RunConsentView.choiceState (shown in the methodology consent row),
   distinct-API metric count, index-based row keys for phase-tagged rows.
   STILL OPEN: cookie/storage MUTATIONS and phase-count UI (need new
   surfaces; fold into the v2 render slice).
4. Atomic client migration: `readRenderableReport` returns v2 LoadedReports,
   shell state -> `LoadedReport` across the seven producer paths, drop the
   two v1 render gates (report page + client reader) TOGETHER with the
   fixture matrix, so discoverability (metadata/OG/sitemap already accept
   v2) never points at a failing page. Note: a committed v2 report today
   would break the static build (generateStaticParams prerenders a page
   that throws), so do not commit v2 fixtures to public/reports before this.
5. Manifest/gallery/directory/exports v2 rows + a deliberate cross-version
   corpus-statistics policy.
6. Fixture matrix: v1 / r1 / r2, split-eligibility, censored-quality,
   custom, ephemeral, malformed, future-revision, plus a static build
   containing a valid v2 report.
7. Then: redaction remediation/provenance, verified phased experiments,
   corpus regeneration, r2 producer rollout, durable queue.
