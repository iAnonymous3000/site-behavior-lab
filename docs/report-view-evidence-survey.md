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

## Codex round 8 (2026-07-11): wording leaks, absence gating, gate tightening

Round 8 confirmed the round-7 direction but rejected "methodology blocker
closed": public wording still exceeded the evidence in places and v2 remains
unsafe to enable. Landed same day:

- 92b0884: every Shields surface names the block SIMULATION (headline
  "with Brave-list blocking on" + disclosure; findings, run-mode copy,
  directory, producer labels for future reports, and a view-level
  normalization of the legacy "Shields off/on" label pair on stored
  reports); consent wording never sequences traffic relative to the
  unverified click; catalog-leaning cross-arm framings (consent contrasts,
  GPC still-contacted alarm) require tracker-classification; provenance
  panel lists gate on detector-findings; pixel findings title says
  populated identifier fields; shields_blocked export column renamed to
  shields_third_party_reduction with a framing-note definition; buildFindings
  never benchmarks a v2 view against the v1-only corpus percentiles.
- 6c86159: familyCensoredOnRun (recorded v2 byFamily censoring, derived v1
  request cap) gates every absence claim: the no-services / no-platforms /
  no-GA / no-cookies / no-fingerprinting cards drop to info and hedge when
  their family was censored; the censored-quiet bottom line covers
  info-level-only runs.
- 33b3335: comparisonEligibility tightened to the RFC compatibility rules:
  exact route, viewport dimensions, browser version, timezone, locale,
  egress, headless, with the unknown rule (unrecorded never matches).
  Verified corpus-neutral: 214/235 eligible before AND after, zero flips.

Still open from round 8, all folded into the atomic v2 slice (or the UI
slice) per Codex's own order:

- Explicit three-state claim policy (raw side-by-side vs comparable vs
  suppressed) with reusable required-family checks; consent findings
  consulting consent-verification for choice-dependent claims.
- Phase-aware counts, cookie/storage mutations, verification observations
  and reasons, post-choice evidence on ReportView.
- The atomic LoadedReport migration incl. the corpus-benchmark cohort
  policy (the v1-only guard is in; a v2 cohort policy comes with v2 rows),
  then the fixture matrix and manifest/directory/gallery/export migration.
- UI slice (medium): variant-focused headlines can open with baseline
  evidence selected; arm changes not announced to assistive technology;
  the CSV control does not name its selected arm; filters can go silently
  empty after switching arms; phase identity invisible.
- Migration debt AFTER the v2 state migration: site-behavior-app.tsx size,
  duplicated stripShare, readScanReport without production callers.

## Codex round 9 (2026-07-11): aggregate accuracy before the atomic slice

Round 9 blocked the atomic migration on one more production-accuracy pass.
Landed same day:

- c40af38: capped runs are floors, not behavior: the v1 cap censors EVERY
  evidence family (absence cards hedge), capped runs leave the percentiles
  (corpus-stats regenerated, 96 sites, p95s matching Codex's sensitivity
  check), rollups, leaderboard (AP/USA Today gone), and since-last-scan
  pairing; temporal deltas pair by SUBJECT (equal requested + final routes);
  exports gain request_capped; the consent note stops calling a mixed
  recording "post-click".
- 1329798: the 169 committed Shields reports remediated in place
  (format-preserving: both legacy titles, run labels, warning sentence,
  1,333 warning prefixes; all 235 revalidate; eligibility unchanged),
  manifest regenerated, view normalizes both legacy titles for share-store
  copies, README fixed (no "live Brave Shields", no pixel identifier
  assertion), Shields card reports SIGNED per-family deltas classified
  fewer/more/mixed/flat (Khan Academy case pinned), fingerprint absence
  consults the separate v2 "fingerprinting" family, consent/policy
  reassurance cards hedge under censoring, the conditional pixel observation
  can only produce a "may conflict" info card, and the ineligible panel
  stops heading nothing with "delta".
- 5b4abb3: the legacy gate covers user agent, language, final page (consent
  exempt), null status, literal "unknown", and DECLARED-axis verification
  (GPC off->on, blocking arm really blocked, accept/reject modes); catalog
  entries/overrides join the classification gate; corpus-neutral (214/235,
  zero flips); fixtures now vary their axes like real runs.

Remaining, unchanged in scope, all recorded above: the explicit three-state
claim policy, phase/mutation/verification views, the atomic LoadedReport
migration with cohort-aware statistics and the full fixture matrix, then
the UI polish slice and transitional-duplication cleanup.

## Codex round 10 (2026-07-11): consent semantics before the reader migration

Round 10's verdict: round 9 was directionally correct and the deployment is
healthy, but consent-arm semantics had to precede the atomic migration. Its
lead finding was corpus-verified exactly: 56 of the 59 then-eligible consent
pairs never dispatched both clicks (55 neither, 1 accept-only), yet every
surface labeled their arms "Accept all"/"Reject all", producing pages that
said "no consent banner could be clicked" and "21 with Accept all, 21 with
Reject all" at once. Landed same day:

- a9c2bc8: consent pairs require BOTH dispatched clicks (missing interaction
  is unprovable, clicked:false is pre-consent), completing round 9's
  declared-axis rule; corpus goes 214/235 -> 158/235 eligible with exactly
  the 3 both-click pairs (bumble, paypal, khanacademy) keeping comparisons.
  Producer + view derive click-aware titles/labels ("Accept-all
  click"/"Accept-all attempt", "Consent comparison attempt (no banner
  clicked)"), mirroring the Shields label normalization for share-store
  copies; all 66 committed consent reports remediated in place (titles,
  label blocks, 654 warning prefixes, the procedure sentence); the findings
  board keeps the informative no-banner/one-click narrative for
  dispatch-failed pairs and labels counts by what each visit recorded;
  "Reject-all visit" phrasing became click-descriptive everywhere.
- 105043a: the gate holds NON-declared experiment dimensions constant
  (GPC/consent-mode/blocking cross-axis checks), applies the unknown rule to
  the subject itself (literal-"unknown" hosts and URLs prove nothing), and
  orders temporal pairs by recorded timestamps (reversed/missing =
  ineligible; the gallery compare tools auto-order via orderTemporalPair).
  Corpus-neutral beyond the consent flips.
- e55deb0: coverage vs measurement split (corpus-stats coverageSiteCount 98
  alongside the 96-site measured sample; export gains measuredSampleSize and
  siteCount now matches its own loaded-sites definition; percentile copy
  says "fully measured sites (of 98 scanned...)"), capped counts reworded
  (activity floors vs end-state snapshots of an interrupted visit),
  "recording capped" chips in directory rows and gallery cards (new
  requestCapped manifest field), direction-aware Shields residual sentence,
  "Brave-list blocking comparison" directory label, README/hero fixes
  ("values are never read" -> transient non-emptiness check with the frozen
  v2 schema docblock kept verbatim under erratum E1 and a guard comment;
  no "live Shields"; no "record every request").

NOT adopted from round 10: Codex's strict position that v1 comparability is
generally unprovable (missing methodology/toolchain identity should resolve
every pair to raw-only). The project's standing position (RFC 10.1) is that
v1 pairs are DESCRIPTIVE-only by construction, gated on the facts v1 DID
record; family gates already carry catalog identity. Recorded here so the
disagreement is explicit rather than silent.

Remaining, order per round 10's own list: the single reason-bearing
raw-only/comparable/suppressed decision object with a shared compatibility
fingerprint (folds into the three-state claim policy), the ReportView
expansion (phases, mutations, detector-ledger, capture loss, toolchain
identity, attempts/failures, configured-vs-verified), the r1/r2 fixture
matrix as acceptance gate, the atomic LoadedReport migration across all
consumers (v2 consent labels move with it: defaultRunLabels still says
"Accept all"/"Reject all" for a hypothetical v2 consent pair, acceptable
only while producers emit v1), the UI polish slice (cap indicators,
arm-switch announcements, CSV arm labels, filter reconciliation,
aria-expanded, full suppression reasons), and only then v2 production
emission with a corpus regeneration.

## Decision object (2026-07-11): the reason-bearing three-state ruling

DONE, first item of the round-10 remaining order. lib/comparison-decision.ts
is the single reason-bearing ruling per pair and per metric family:

- Modes: "comparable" (comparative framing allowed), "raw-only" (arms render
  side by side, reasons say why no framing), "suppressed" (the family was
  never measured, nothing to set side by side). Pair-level mode is never
  suppressed (two readable arms always render).
- `ClaimPolicy` gained `decision`; `pairComparison` and `familyDeltas` are now
  DERIVED from it (claimsFromDecision in scan-report-views.ts), so the boolean
  gates and the decision cannot disagree. All existing consumers (headline,
  findings, panel, corpus overview) keep reading the derived gates unchanged;
  the mode distinction and the fingerprint are new surface for the UI slice
  (full suppression reasons) and the export slice.
- v1: legacyComparisonDecision moves the family rules out of the claim-policy
  builder verbatim, with one refinement: the old single "at most one visit"
  shields sentence split into never-measured (suppressed) vs one-arm
  (raw-only); consent-verification is suppressed (never measured), and
  detector-findings stays raw-only (evidence renders, deltas unprovable).
- v2: v2ComparisonDecision maps the RECORDED comparability block
  (pairValidity/perMetric) and never invents a suppression the evaluator did
  not record.
- Compatibility fingerprint: per-arm measurementEnvironment digest. v2 arms
  carry the recorded digest; v1 arms get a legacy-derived sha256 (lane-free
  lib/sha256) over a versioned canonical form ("legacy-env-v3") of the
  environment dimensions the legacy gate holds constant, EXCLUDING the
  intervention axes and the subject. `legacy-env-v3` includes the active
  Brave-list source/count/snapshot as well as the dependency-light
  methodology identity derived from frozen v1's scannerDisclosure: reports carrying a
  `methodology <token>` marker use that token; older reports form the explicit
  `legacy-v1-methodology-unspecified` cohort. Cross-cohort temporal pairs are
  raw-only, while same-cohort pairs remain comparable. The unknown rule still
  applies to recorded environment fields (any missing or literal-"unknown"
  dimension makes the fingerprint null, and null never matches). A GPC flip
  does not change the fingerprint (pinned).
- Cost: report page first-load 154 -> 156 kB (the sha256 implementation now
  reaches the client-safe views chain; upload views compute fingerprints in
  the browser).

## ReportView expansion (2026-07-11): the recorded-evidence surface

DONE, second item of the round-10 remaining order. The view now carries every
recorded v2 surface the migration needs, with v1 nulling each block ("never
recorded", so no derived stand-in can present as recorded fact):

- RunView: `phases` (RFC 7 spans) + `countsByPhase`; `detectors` (RFC 5.4
  ledger, reason/phaseId normalized to explicit nulls); `fingerprints` (the
  run's recorded digests; the pair-level legacy DERIVED digest stays on
  claims.decision); `provenance` (observer/acquisition/buildCommit/
  methodology/detector-registry identity); `toolchainIdentity` (catalog and
  adblock digests + normalizationVersion; the human-facing blocks stay on
  `conditions`); `verificationFacts` (r2 RFC 15.3 gpc/shields readbacks,
  null wrapper never fabricated, r1 and v1 stay null).
- RunQualityView.facts: the RECORDED quality facts (botWallTitleMatched,
  navigationSettled, budgetsExhausted, captureLoss ledger).
- RunEvidenceView: `cookieMutations`/`storageMutations` phase-tagged ledgers
  (null on v1, distinct from an empty recorded ledger).
- RunConsentView: `interactionAttempted` (v1: true by construction),
  `verificationObservations` (the attempts ledger, r2 result blocks pass
  through), `reverifiedAfterReload`, `verificationFailureReason`,
  `bannerTransition` (r2 15.5).
- ComparisonView: `verification` (RFC 4.3 configured-vs-verified per arm),
  `order`, `evidenceStrength`, `supportingPairs` (r2 15.6 count; absent wire
  block stays null, never a fabricated zero).

Pins in lib/scan-report-views.test.ts (v1 nulls, v2 relational passthrough,
r2 readbacks/supporting pairs); the hardening consent-view pins extended.
Report page first-load 157 kB.

## Fixture matrix (2026-07-11): the acceptance gate before the atomic flip

DONE, third item of the round-10 remaining order.
lib/report-fixture-matrix.test.ts runs six fixtures (v1 single/comparison,
v2 r1 single/intervention, v2 r2 single/intervention) through every consumer
entry path: the transport reader directly (upload / sync result), wrapped in
a succeeded job envelope (poll), and the canonical stored reader (permalink,
and the gallery's static JSON loads use the same reader). Per row it pins the
LoadedReport source tag, view origin/revision, headline + findings engine
acceptance (nonempty output on every generation), the decision object's
presence rule (comparisons only), and the JSON-download rule
(publicWireForExportOrPersistence: deep v1 projection, wire passthrough for
v2 public, projection for ephemeral shells with the view-restored screenshot
never reaching the persistable wire). The client seam's v1-only render gate
is PINNED (v2 refuses with the capability message), so the atomic migration
removes it by consciously updating the matrix; a future schemaRevision 3 is
pinned as a named capability gap on all three paths. All matrix rows passed
on first run: the version-aware reader stack is ready for the consumer flip.
Note: a v2 fixture must still never be committed under public/reports (it
would break the static build until the atomic slice lands); the gallery path
is therefore covered at the reader level plus the existing v1 static smoke.

## Atomic LoadedReport migration (2026-07-11): the consumer flip

DONE, fourth item of the round-10 remaining order. Every consumer of report
data now holds/loads the version-independent LoadedReport; producers still
emit v1 only (unchanged, per the migration order):

- Client seam: readRenderableReport becomes readLoadedReport (lazy transport
  reader), returning LoadedReport for every readable generation; the v1-only
  refusal is gone, job envelopes and API-error payloads refuse with their own
  messages. saved-report-recovery returns LoadedReport.
- Shell (site-behavior-app.tsx): state is LoadedReport; all seven producer
  paths land on it (sync scan, poll incl. recovery, report upload with
  share-stripping across every source shape, PageGraph import and the
  gallery's client-built temporal comparison via a light v1 wrap, and the
  permalink page's initialLoaded prop); reportView = loaded.view (the old
  toReportView v1 wrap is gone); JSON download lazy-imports
  publicWireForExportOrPersistence (the serialization boundary; the static
  toPublicScanReportV1 import left the bundle, report page 157 -> 155 kB);
  ReportHeader/HeadlineBanner take the share pointer instead of the wire.
- Pages: app/reports/[id]/page.tsx drops its schemaVersion gate; the client
  page renders any readable generation.
- Gallery: featured headlines build from the loaded view; the temporal
  compare tools keep a CONSCIOUS residual gate (the client-side temporal
  builder composes v1 runs, so v2 singles refuse with "temporal comparison
  across schema generations is not supported yet").
- Corpus/manifest: corpus-overview and static-report-manifest drop their v1
  gates and derive entries from the view (manifest keeps byte parity with the
  committed corpus: variant-fed requestedUrl/device on comparisons, title
  fallback, capped chip from familyCensoredOnRun). corpus-stats-builder KEEPS
  its guard deliberately: that is the measurement-cohort policy (v2 metrics
  never join the v1 percentile distribution), not a render gate.
- v2 consent labels moved with the migration: viewFromV2 derives consent arm
  labels from recorded dispatch (click/attempt) exactly like v1.
- Matrix updated consciously: the pinned v1-only client-seam refusal flipped
  to every-generation loading with source tags.

Verified: 560 tests, both typechecks, production build (report page 155 kB),
11/11 static smoke on a fresh out/, and 16/16 server smoke against the
production build (real scans, GPC comparison, JSON export, share permalink,
saved-report page). Remaining after this slice: the UI polish slice, then
exports migration details and v2 production emission with corpus
regeneration.

## UI polish slice (2026-07-11): the round-8/round-10 accessibility items

DONE except one recorded residual. Landed, browser-verified on the capped
usatoday and eligible webmd Shields reports with a clean console:

- Cap indicator: the report header eyebrow shows the "recording capped" chip
  (familyCensoredOnRun on the lead run) with the floors/snapshots tooltip.
- CSV arm labels: the CSV button reads "CSV · <arm label>" on comparisons and
  follows the evidence switcher; its tooltip names the visit it exports.
- Arm-switch announcements: an aria-live status inside the switcher announces
  "Showing evidence from the <arm> visit." on every switch.
- Filter reconciliation: a filtered-empty request log says no requests match
  the current filters (noting that filters stay applied across the evidence
  switcher, wording accurate whether the user typed the filter or switched
  arms) and offers a working "Clear filters" reset; a genuinely empty visit
  says so instead.
- aria-expanded on the comparison change-list toggles.
- Full suppression reasons: the panel's family notes consume
  claims.decision.families: ALL reasons (never just the first), with the mode
  spelled out ("never measured on this pair" for suppressed vs "each visit's
  own evidence still renders below" for raw-only), including a suppressed
  shields family with no number to withhold.
- Phase identity: the request log gains a Phase column that renders only when
  rows carry phaseIds (v2), so v1 tables are unchanged.

Residual (recorded, not landed): the headline-focus default arm ("variant-
focused headlines can open with baseline evidence selected"). Temporal pairs
already lead with the variant; picking a focus arm for the other headline
branches needs the headline engine to declare which arm its lead finding
describes, an engine change deferred to the exports/emission work.

## Redaction v2 foundation (2026-07-11): sanitizer, digests, sidecars, audit

RFC step 9 groundwork, repo-only (no producer wiring, no corpus rewrite; both
are separate decisions gated on the dry-run audit below):

- lib/redaction-v2.ts: the default-deny sanitizer. Survival is
  allowlist-only (lib/redaction-allowlists.json, versioned reviewed data:
  route literals, query keys incl. utm_/ud[ prefixes, cookie names, storage
  keys); everything else generalizes ({seg}/{n} paths capped at 6 segments,
  {label} token-shaped subdomain labels with the registrable domain always
  surviving and xn-- IDN labels exempt from the entropy heuristic, matrix
  params stripped, [redacted:*] shape-classed markers for names). Malformed
  or non-http input becomes {invalid-url}, never a pass-through (the v1
  report-url defect). Every removal counts through the exact
  PrivacyStats.redaction vocabulary. Node-side module (tldts).
- lib/canonical-json.ts: canon-v1 canonicalization (sorted keys, NFC, no
  whitespace, loud rejection of non-JSON values) + publicReportDigest, so
  pretty-printed corpus files and compact R2 objects digest identically.
- lib/redaction-provenance.ts: the 15.8 sidecar contract (entry shape,
  <id>.provenance.json naming outside the report-id pattern, digest
  match/mismatch/unknown with every defect resolving toward re-remediation,
  createdAt/expiresAt carried verbatim and never an input to retention).
- lib/remediation-inventory.ts + remediation-inventory-cli.ts +
  scripts/remediation-inventory.mjs (npm run reports:remediation-inventory):
  the RFC 9.6 step-1 DRY-RUN audit over public/reports. Never writes.

Live dry-run over the 235-report corpus: all 235 would change; 67,161 of
68,769 URL fields; 251,375 path segments, 991 subdomain labels, 98,283 query
keys would generalize; 7,735/8,627 cookie names and 4,832/4,846 storage keys
would redact. Risk signals for the 9.6 step-2 history decision: ZERO
address-shaped strings (the raw "@" matches are logo@2x.png density suffixes,
excluded by the tool), 9,329 token-shaped path segments and 991 token-shaped
subdomain labels that read as asset hashes/build ids, not per-user
identifiers. Audit conclusion to confirm with the operator: no credentials,
session tokens, or direct identifiers found, so per 9.6 the git-history
rewrite is NOT indicated (accept and document the residual); the in-place
corpus re-redaction plus sidecar backfill remains the pending remediation
decision, weighed against how much evidence granularity (paths, cookie
names) the public corpus should keep.

## Codex round 11 (2026-07-12): the production-readiness review

An external full-stack review (browser isolation, egress, methodology, UX,
ops). Every finding was verified against the code before acting; four slices
landed same-day (faf7fe6 container hardening, 3a52d3e PageGraph fidelity,
2945ac4 honesty/accuracy, 25acde5 Pages front-door headers). Follow-up
disposition after the review:

- **Shields initiator context (landed as its own methodology slice).** The Node
  scanner now captures adblock-rust's source context synchronously at route
  time, before public-host verification can await while a frame navigates or
  detaches: ordinary subresources use the requesting frame, subframe
  navigations use the parent document (Playwright exposes the not-yet-committed
  child with an empty URL), inherited non-HTTP frames walk to the nearest
  HTTP(S) ancestor, and a Service Worker is guarded before frame() because that
  API throws for worker-originated requests. Main-frame and frame-less
  navigations remain deliberately fail-open and are not counted as matches.
  Only the resulting boolean is retained in a WeakMap keyed by Request and
  replayed into the public record; the raw source URL is transient and never
  enters frozen v1. This removes the old target-at-block-time versus
  final-URL-at-report-time disagreement and is identified in future Node
  report disclosures as `shields-request-context-v2-adblock-rust-0.13.0-request-method-v1`; a future v2 producer must
  carry that identity in provenance.methodologyVersion. The legacy-derived
  environment fingerprint now reads this disclosure token, so an old/new v1
  temporal pair is raw-only instead of silently comparing methodologies.
  Corpus impact was
  bounded before the change: re-evaluating all 67,588 stored requests across
  471 runs with requested versus final top-level source changed zero matches
  under the pinned lists (58 runs redirected, 12 across hostnames), and zero of
  478 likely top-level document rows matched. Iframe impact cannot be
  reconstructed because v1 did not retain frame sources, so the 235 committed
  reports stay legacy/limited and are not retroactively rewritten.
- **Durable jobs / atomic rate limiting / cancellation.** Known and
  user-sequenced (durability phase, DO SQLite). The KV read-then-write
  overshoot is documented in-code and backstopped by the WAF ceiling.
- **Redaction v2 wiring + corpus remediation.** Foundation landed 499ccc0;
  the wiring order is RFC 14.10 and the remediation/granularity trade is an
  explicit operator decision (see the redaction section above).
- **Proxy aggregate byte budget.** Real gap (per-request-count and duration
  budgets exist, no byte cap). Queued with the durability slice, where
  resource metering lands anyway.
- **v2 detector-findings dependency registry.** Confirmed incomplete:
  METRIC_EVIDENCE maps detector-findings to [detector-output] only, so
  censored request/fingerprint evidence leaves detector metrics eligible.
  Fix belongs to the v2 emission slice (no producer emits v2 yet; the
  registry can be corrected before first emission without a version bump).
- **Product/UX restructure** (permalink buries evidence below the scanner,
  235-card unpaginated gallery, featured cards fetching 12 full reports,
  archive compare accepting only the corpus's zero singles, directory as
  report dump, 27,800px mobile reports, no scan cancellation): all real, all
  deferred to the product-loop work (the reviewer's "/sites/<domain>
  longitudinal loop" framing matches the deferred multi-browser/monitoring
  direction). The headline-focus default arm residual was already recorded.

Operator-side items surfaced to the user (not repo-fixable):
R2 lifecycle rule for the 7-day promise (prune is opportunistic:
save-triggered or read-of-expired only), Cloudflare Insights beacon on the
Pages project vs the privacy page's disclosure, container observability,
WAF ceiling verification, re-run of the failed scheduled Brave-list refresh,
and the two standing dashboard flips (production branch for both builds,
non-production builds off). Chromium sandbox is now opt-in via
SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1 after a verified deployed scan.

Review overclaims rejected after verification: the percentile copy said
"about 90%" (hedged, not the claimed "more than 90%"; replaced anyway with
tie-safe mark-anchored wording), the "consent copy still says attribution is
always unverifiable" finding matched no current string, and the health
CONTRACT always had consentComparison (only the human status line omitted
it). pagegraph-rust models the OLD start-edge schema ("request type"), so
the round's resource-type fix keeps that name as a legacy fallback; a
validation pass against a fresh real capture (Brave nightly +
pagegraph-crawl) is still owed because the repo pins the schema from source
reading, not from a live capture.
