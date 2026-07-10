# RFC: ScanReport v2, the Verified Experiment Contract

> Status: **v0.2 DRAFT, 2026-07-09, awaiting acceptance. Design only; no implementation
> ships from this document.** v0.2 revises v0.1 per review (changelog at the end).
> Successor to the v1 schema pinned at `SCAN_REPORT_SCHEMA_VERSION = 1`
> ([lib/types.ts](../lib/types.ts)). The durable job queue
> ([scan-job-model.md](scan-job-model.md)) and domain watchlists are explicitly out of
> scope and sequenced after this contract.

## Goal

One sentence: **a sanitized report that carries machine-checkable evidence of whether
two runs are comparable and whether an intervention actually took effect.**

"Machine-checkable evidence" is the honest phrase: the report's provenance is
self-reported metadata that tools can verify for consistency, not cryptographic proof.
A signed attestation over canonical public-report bytes is a deferred extension
(section 12), not a v2 requirement.

v1 reports are honest but under-specified for that claim. They record conditions
(browser, viewport, locale, GPC, consent mode) yet cannot answer, from the report alone:

- Were these two runs produced by the same scanner build, methodology, and filter lists?
- Did the consent click actually change the CMP's stored choice, or did a button get
  pressed into the void?
- Is a delta causal (the intervention did it) or circumstantial (ad rotation, a bot
  wall, a truncated run)?
- Was a detector's silence "ran and found nothing" or "never ran"? In v1, absence of an
  optional field (`cnameCloaks`, `pixelEvents`, `consentInteraction`) is ambiguous, and
  only free-text `warnings` disambiguate.

v2 makes comparability and intervention effect first-class fields and hardens the
privacy boundary before any queue or retention layer persists more data.

## Non-goals

- No durable queue, watchlists, scheduled monitoring, or alert channels (later phases).
- No new detectors and no change to what the scanner observes.
- No raw-request archive; the origin+path scrub posture tightens, never loosens.
- No v2 upgrade of the Browser Run Worker producer (frozen at v1, section 11.1).

---

## 1. Report shapes: evidence is per-run

The v1 comparison shape hangs `schemaVersion`, `warnings`, and conditions partly on the
root and partly on each embedded `ScanResult`, and v0.1 of this RFC repeated the
mistake by proposing report-level `quality`/`privacy`/`detectors` blocks. Those can all
legitimately differ between baseline and variant (one run hits a request cap, one
detector fails on one side only, a Workers Build lands between runs). v2 therefore
defines the **run** as the unit of evidence:

```ts
type ScanRunV2 = {
  runId: string;
  subject: SubjectIdentity;          // section 2
  conditions: ConditionVector;       // section 3.1
  provenance: Provenance;            // section 5.1
  fingerprints: {                    // section 3.2
    execution: string;
    measurement: string;
  };
  quality: Quality;                  // section 5.3
  privacy: PrivacyStats;             // section 5.2
  detectors: DetectorLedger;         // section 5.4
  phases: PhaseSpan[];               // section 7
  summary: RunSummary;               // counts, status, duration (v1 summary, per phase where applicable)
  evidence: {                        // v1's request/cookie/storage/detection arrays, phase-tagged
    requests: NetworkRequestRecord[];
    cookies: CookieRecord[];
    storage: StorageRecord[];
    fingerprintEvents: FingerprintEventSummary[];
    fingerprintDetections: FingerprintDetectionSummary[];
    cnameCloaks: CnameCloak[];
    pixelEvents: PixelEventSummary[];
    privacyPolicy?: PrivacyPolicySummary;
    consent?: ConsentEvidence;       // section 6
  };
  warnings: string[];
};

type SingleReportV2 = {
  schemaVersion: 2;
  reportType: "single";
  run: ScanRunV2;
  share?: ReportShare;
};

type ComparisonReportV2 = {
  schemaVersion: 2;
  reportType: "comparison";
  design: ComparisonDesign;          // section 4.1
  baseline: ScanRunV2;
  variant: ScanRunV2;
  experiment: Experiment;            // section 4.2: intended intervention, order, pairId, manipulation check
  comparability: Comparability;      // section 4.4, evaluated
  diff: ComparisonDiff;              // computed, per-metric eligibility applied (section 3.3)
  share?: ReportShare;
};
```

The wire type is a discriminated union, never a synthesis (section 10.1):

```ts
type StoredScanReport = ScanReportV1 | SingleReportV2 | ComparisonReportV2;
```

---

## 2. Subject identity

Requested and observed subjects are distinct facts and both are kept:

```ts
subject: {
  requested: { registrableDomain: string; routeShape: string };  // what the submitter asked for
  observed:  { registrableDomain: string; routeShape: string };  // eTLD+1 + route shape of the FINAL url
}
```

- Redirects make the observed subject the measured one (australia.gov.au is a
  my.gov.au scan, as the corpus already learned); `requested !== observed` is itself
  evidence and feeds `comparability.subjectMatch`.
- `routeShape` comes from the redaction layer (section 9), so both identities are safe
  to publish and index.
- **Public profiles group primarily by observed registrable domain.** Route shapes are
  display detail, not identity.
- **Route-specific watches (future) never use route identity in public keys.** A watch
  is a random opaque ID referencing an encrypted target URL (section 9.7). No stable
  hashes of routes, no public route identifiers: a stable hash is linkable and a
  low-entropy route is dictionary-recoverable.

Comparisons require equal observed subjects.

---

## 3. Conditions and fingerprints

### 3.1 The condition vector

One `{kind, state}` pair (v0.1) cannot represent Shields running with GPC enabled.
Conditions are an **orthogonal vector of every input the operator controls**; the
experiment separately declares which single axis it intends to move (section 4.2):

```ts
conditions: {
  gpc: boolean;
  shields: "off" | "classification" | "block-simulation";
  consent: "observe" | "accept-all" | "reject-all";
  device: { kind: "desktop" | "mobile"; viewport: { width: number; height: number; isMobile: boolean } };
  probes: { keystroke: boolean; policyVisit: boolean };   // active steps are conditions too
  locale: string; language: string; timezone: string;
  egress: { label: string; region?: string };
  browser: { name: string; version: string };
  headless: boolean;
  automation: ScanAutomation;
}
```

### 3.2 Execution vs measurement fingerprints

v0.1's single `environmentFingerprint` overreached: a documentation-only `buildCommit`
change would have invalidated every temporal comparison. v2 splits exact
reproducibility from semantic compatibility:

```ts
fingerprints: {
  // Exact reproducibility: sha256 over canonical JSON of conditions + buildCommit +
  // methodologyVersion + detectorVersions + catalog/list digests + engine +
  // normalization versions. Two runs with equal execution fingerprints ran the same
  // bits the same way.
  execution: string;

  // Behavior-affecting methodology only: as above MINUS buildCommit (and any other
  // fields the methodology registry marks non-behavioral). Bumping
  // methodologyVersion is the explicit act that declares "results mean something
  // different now".
  measurement: string;
}
```

Canonicalization: sorted keys, no insignificant whitespace, NFC strings; the exact
rules ship with the validator and the published schema. Digests exist for equality
testing and indexing only, never secrecy; the full objects are always stored alongside.

### 3.3 Per-metric compatibility

Fingerprint equality is still too blunt: a filter-list update invalidates Shields
metrics but not raw request counts. v2 ships a **metric dependency registry** (code +
published table) mapping each metric family to the fingerprint components it depends
on:

| Metric family | Depends on |
|---|---|
| raw request/cookie/storage counts | browser, device, locale/tz, egress, methodology |
| tracker classification | the above + trackerCatalog digest |
| Shields simulation (`shieldsBlockedRequests`, tried-vs-blocked) | the above + adblock list digests + engine version |
| consent verification | the above + CMP interpreter versions |
| detector findings | the above + that detector's version |

Comparability (section 4.4) is then evaluated **per metric family**: a pair can be
temporally comparable on raw counts while ineligible on Shields metrics, and the diff
renders exactly that.

### 3.4 List digests

Each run stores one **aggregate digest** over the pinned list/catalog snapshot
(`catalogDigests.trackerCatalog`, `catalogDigests.adblockManifest`), plus engine and
normalization versions. Separately, the repo publishes an **immutable per-list digest
manifest** (list name, version, sha256, fetchedAt) keyed by the aggregate digest, so a
mismatch can be diagnosed to the specific list without bloating every report.

---

## 4. Comparison designs, manipulation, comparability

### 4.1 The design union

```ts
type ComparisonDesign =
  | { kind: "intervention"; axis: "gpc" | "shields" | "consent" }  // exactly one condition axis differs
  | { kind: "temporal" }        // measurement-compatible conditions separated by time
  | { kind: "descriptive" };    // arbitrary pair, NEVER causal (imports, ad-hoc uploads)
```

Validity requirements differ by design and are enforced by the comparability
evaluator, not by convention:

- `intervention`: equal observed subject, equal measurement fingerprint, exactly the
  declared axis differs in the condition vector, manipulation check passed on the
  variant, both runs pass quality gates.
- `temporal`: equal observed subject, equal condition vector, measurement-compatible
  fingerprints (per metric family), both pass quality gates.
- `descriptive`: no requirements; every causal surface is suppressed unconditionally.

v1's `comparisonType` ("gpc"/"shields"/"consent"/"temporal"/"custom") maps onto
design + axis; "custom" maps to `descriptive`.

### 4.2 Experiment

```ts
experiment: {
  design: ComparisonDesign;
  pairId: string;                    // random id shared by both runs
  order: "AB" | "BA";                // counterbalanced from the first v2 release (no scan cost)
  manipulationCheck: ManipulationCheck;   // section 4.3
}
```

Repeated pairs are deferred, but the constraint is recorded now: **future behavior
alerts require a confirmation run** before firing.

### 4.3 The manipulation check

Comparability says the pair is well-formed; the manipulation check says **the
intervention was actually applied**. Distinct facts, stored separately:

```ts
manipulationCheck: {
  passed: boolean;
  method: string;                    // versioned, per axis
  detail?: string;
}
```

- GPC: the variant's own evidence shows `Sec-GPC: 1` was sent and
  `navigator.globalPrivacyControl` read true in-page.
- Shields: the engine reports active with N rules evaluated over the variant's
  request set (`adblock.active` plus a nonzero evaluation count).
- Consent: `choiceState === "verified"` (section 6).

An intervention pair whose manipulation check failed is reported as **inconclusive**,
never as "the intervention changed nothing".

### 4.4 Comparability, an evaluated result

Never part of a fingerprint; computed per pair after both runs exist:

```ts
comparability: {
  comparable: boolean;                       // for the declared design as a whole
  perMetric: Record<MetricFamily, { eligible: boolean; reasons: ComparabilityReason[] }>;
  checks: {
    subjectMatch: boolean;                   // observed subjects agree
    conditionDeltaValid: boolean;            // matches the declared design
    measurementCompatible: boolean;          // per section 3.2/3.3
    statusParity: boolean;                   // both < 400, or same failure class
    noBotWall: boolean;
    noCaptureLoss: boolean;                  // quality.captureLoss clean on both (section 5.3)
    loadComplete: boolean;
  };
  mismatchReasons: ComparabilityReason[];    // enumerated, empty when comparable
}
```

**Product rule:** an incomparable pair (or ineligible metric family) keeps descriptive
numbers ("we observed 42 vs 17 requests") but suppresses causal headlines, "Shields
blocked", "rejection changed nothing" framings, since-last-scan deltas, and any future
alert. This generalizes the per-feature gates that already exist (consent claims
require a real click, temporal deltas pair same-kind only, stats exclude status>=400)
into one evaluated object every consumer reads instead of re-deriving.

---

## 5. Per-run blocks

### 5.1 `provenance`

```ts
provenance: {
  producer: "node-playwright" | "browser-run-worker" | "ci-workflow" | "pagegraph-import";
  buildCommit: string;               // self-reported, machine-checkable metadata
  methodologyVersion: string;        // meaning of the numbers; distinct from schemaVersion (shape)
  sourceArtifactDigest?: string;     // e.g. sha256 of an imported PageGraph GraphML
}
```

### 5.2 `privacy` (redaction stats, not loss)

Redaction is **expected behavior**, not evidence degradation. Its counters make the
policy auditable but never censor a run:

```ts
privacy: {
  redactionVersion: number;
  redaction: {
    pathSegmentsGeneralized: number;
    queryKeysRedacted: number;
    storageKeysRedacted: number;
    matrixParamsStripped: number;
  };
}
```

### 5.3 `quality` (capture loss censors)

Only genuine capture loss makes evidence censored:

```ts
quality: {
  outcome: "complete" | "censored" | "failed";
  reasons: QualityReason[];          // enumerated: http-error-status, bot-wall-title,
                                     // navigation-timeout, empty-load, scan-slot-timeout, ...
  captureLoss: {
    requestsDropped: number;         // caps hit
    arraysClipped: number;           // size limits truncated evidence arrays
    fieldsTruncated: number;
    timeoutsHit: string[];           // enumerated budget names
  };
}
```

"Censored" is the statistician's sense: observation ended or was capped before
completion, so counts are lower bounds even more than usual. This replaces scattered
heuristics (the manifest builder's bot-wall regex, `<=1 request` checks, corpus status
filtering) with a producer-declared status those tools verify instead of infer.

### 5.4 `detectors`

```ts
detectors: Record<DetectorId, {
  version: string;
  status: "complete" | "partial" | "skipped" | "unsupported" | "failed";
  reason?: string;                   // enumerated where possible ("no-form-fields", "budget-exhausted")
  phaseId?: PhaseId;                 // when the detector ran (section 7)
}>
```

Every known detector appears in every run; a missing entry is a validation error, so
silence is never ambiguous again.

---

## 6. Consent semantics

### 6.1 Replace the overloaded `clicked`

v1's `ConsentInteractionSummary.clicked` conflates "we pressed something" with "the
choice took effect". v2 splits attempt, activation, and verified state, and treats
banner disappearance as what it is, a weak UI signal:

```ts
consent: {
  mode: "accept-all" | "reject-all";
  interactionAttempted: boolean;
  controlActivated: boolean;               // a control was actually clicked (v1 `clicked`)
  choiceState: "verified" | "contradicted" | "weak-signal" | "unavailable" | "failed";
  verificationMethod?: string;             // versioned interpreter id: "tcf-api@1", "onetrust-cookie@1", ...
  verificationFailureReason?: string;      // enumerated: banner-persisted, tcf-unavailable,
                                           // cookie-absent, state-contradicts-choice, ...
  reverifiedAfterReload: boolean;          // section 6.2 phase 3 re-check ran and agreed
  cmp?: string; selector?: string; matchedText?: string; frameUrl?: string;   // carried from v1
}
```

- `verified`: a versioned CMP-state interpreter (IAB TCF `__tcfapi` TCData, or a known
  CMP state cookie such as OneTrust `OptanonConsent`) read a stored state consistent
  with the choice, **and** the re-verification after reload agreed.
- `contradicted`: an interpreter read state inconsistent with the click (pressed
  "Reject all", storage says consented).
- `weak-signal`: no interpreter available; the only evidence is banner dismissal.
- `unavailable`: no interpreter and no usable UI signal.
- `failed`: interpreter errored.

Interpreters are versioned (they encode third-party formats that change), and their
versions participate in the consent-verification metric family (section 3.3).

### 6.2 Phased experiment flow

The consent experiment becomes a phased protocol (phase model in section 7):

1. `passive-load`: initial navigation, pre-interaction traffic.
2. `consent-interaction`: from click attempt to settle, plus initial state read.
3. `post-choice-reload`: a reload under the established consent state, then
   re-verification. **This reload is the measured run for post-choice claims**,
   because post-click traffic in one log mixes pre-click and post-click observations.
4. `active-probe`: keystroke sentinel and unload-flush window.
5. `policy-analysis`: the bounded policy-page visit (already excluded from counts).

Claims gate on phases and state: "trackers that survived rejection" reads
`post-choice-reload` traffic with `choiceState === "verified"`. Unsupported or
unstable combinations mark the experiment inconclusive via the manipulation check and
comparability rather than downgrading silently.

The public corpus is regenerated after this lands; the export gains
`consent_choice_state` beside `consent_clicks`.

---

## 7. The phase model

Every phase-sensitive observation carries a compact `phaseId` backed by a per-run
phase table; requests attribute by **start** phase:

```ts
type PhaseId = number;               // index into run.phases
type PhaseSpan = {
  phaseId: PhaseId;
  kind: "passive-load" | "consent-interaction" | "post-choice-reload" | "active-probe" | "policy-analysis";
  startedAtMs: number;
  endedAtMs: number;
};
```

Phase ownership applies to **all evidence**, not just requests: `requests[].phaseId`,
`cookies[].phaseId` (first observed), `storage[].phaseId`, fingerprint events and
detections, detector ledger entries, and any summary that aggregates phase-sensitive
counts is either computed over an explicit phase set or split per phase. Runs without
experiments have a single `passive-load` phase (plus probe/policy phases when enabled),
so the model is uniform.

---

## 8. Ephemeral vs public schemas

Schema annotations cannot stop a screenshot from being persisted; types and a single
projection function can:

```ts
type EphemeralScanResult = /* superset: everything the scanner produced, incl. screenshot */;
type PublicScanReport   = /* the persistable/exportable subset */;

function toPublicScanReport(result: EphemeralScanResult): PublicScanReport;  // ALLOWLIST-based
```

- The projection copies **named fields only** (allowlist); unknown or new fields are
  dropped by construction, so a future ephemeral addition cannot leak by default.
- The report store, corpus scripts, exports, and share endpoints accept
  `PublicScanReport` **types only**; the immediate scan response is the one surface
  that may carry `EphemeralScanResult` (today's screenshot behavior, made structural).
- The published JSON Schema documents `PublicScanReport`; ephemeral fields are simply
  absent from it.

---

## 9. Privacy boundary first (redaction v2)

Sequenced **before** durable jobs so the queue never persists what minimization would
have removed. Current state ([lib/report-url.ts](../lib/report-url.ts)): userinfo,
hash, and query values are stripped (query keys preserved for third parties behind a
safe-key pattern), but the **path is kept verbatim** everywhere a URL is stored.

### 9.1 Path-shape redaction

- Keep scheme + host. Reduce paths to a bounded shape: at most N segments (proposal:
  6), each segment either kept literally when it matches a conservative safe pattern
  (short, lowercase, dictionary-ish route words: `products`, `privacy`, `api`) or
  generalized: numeric to `{n}`, UUID/hex/base64-ish or long or high-entropy to `{seg}`.
- **Semicolon (matrix) parameters**: `;jsessionid=...` and friends live in path
  segments and survive today's redaction. v2 strips everything from the first `;` in
  each segment before shape classification, preserving the parameter name only under
  the same safe-key rule as query keys (`privacy.redaction.matrixParamsStripped`).
- **No public unsalted hashes for token-like segments.** A hash of a low-entropy token
  is a dictionary lookup away from the token, and a stable hash is itself a linkable
  identifier. Token-like segments become the fixed `{seg}` marker, full stop.

### 9.2 Every persistent or public sink

The same policy applies to all of: `evidence.requests[].url`, requested/final URLs,
`consent.frameUrl`, `privacyPolicy.url`, PageGraph fact-table rows
([lib/pagegraph-corpus.ts](../lib/pagegraph-corpus.ts)), corpus exports, share links
surfaced in UI, server logs, and any future queued job payload. One function, one
version number (`privacy.redactionVersion`), one test suite.

### 9.3 Storage keys

`StorageRecord.key` is stored verbatim today. v2: keep keys matching the safe-key
pattern (short, conventional: `_ga`, `theme`, `cartId`); redact the rest to a class
marker plus shape info (`[redacted:uuid-like]`), keeping `area` and `valueBytes`
(values were never stored).

### 9.4 Size limits

Per-field string caps, per-array caps (requests, cookies, storage, detections), and a
total serialized-report cap, enforced at build time. Clipping is **capture loss** and
lands in `quality.captureLoss`, not in the privacy block: a hostile page must not be
able to bloat public artifacts, and the report must say when evidence was cut.

### 9.5 Public vs ephemeral

Structural, per section 8 (the projection function), not annotation-based.

### 9.6 Remediation of already-published identifiers

Forward-only redaction does not fix what is already public. **Audit first**, then
re-redact in place across the full inventory:

1. **Committed static reports** (`public/reports/` working tree).
2. **Git history** of those reports: rewrite (`git filter-repo` + force push) **only
   if the audit confirms** credentials, session tokens, direct identifiers, or stable
   per-user identifiers in historical paths; otherwise accept and document the
   residual.
3. **R2 share reports**: rewrite objects in place (IDs and share links survive).
4. **Generated exports**: `/corpus.json`, `/corpus.csv` regenerate from re-redacted
   inputs on the next build.
5. **KV remnants**: the retired Browser Run worker's `REPORTS_KV` namespace still
   holds v1 report blobs; re-redact or delete.
6. **GitHub Actions artifacts**: scan-workflow run artifacts and job summaries that
   embed URLs; expire or delete.
7. **Pages deployment history**: old immutable deployments retain old artifacts;
   delete stale deployments.

### 9.7 Queue payloads (forward constraint on the later milestone)

The durable queue must store the original target URL to run the scan, which redaction
cannot touch. Constraint recorded now: queued payloads are encrypted at rest or held
only until execution, carry a hard TTL, never appear in logs, and job records embed
the **redacted** URL everywhere except the executor's decrypt path. Future
route-specific watches follow the same rule (opaque watch ID referencing the encrypted
target, section 2).

---

## 10. Backward compatibility

v1 is hardcoded as a strict equality in at least five places:
[lib/report-validation.ts](../lib/report-validation.ts) (three checks),
[scripts/build-corpus-stats.mjs](../scripts/build-corpus-stats.mjs),
[scripts/build-static-report-manifest.mjs](../scripts/build-static-report-manifest.mjs),
[scripts/smoke-deployed-scanner.mjs](../scripts/smoke-deployed-scanner.mjs), plus the
producers ([lib/scan-result-builder.ts](../lib/scan-result-builder.ts),
[lib/compare-reports.ts](../lib/compare-reports.ts),
[scripts/run-ci-scan.mjs](../scripts/run-ci-scan.mjs),
[cloudflare/worker.ts](../cloudflare/worker.ts),
[lib/pagegraph-adapter.ts](../lib/pagegraph-adapter.ts)). A bump without an adapter
bricks every committed report, every R2 share link, and the corpus pages.

### 10.1 Distinct wire types, one display view

v1 is **never synthesized into something that looks authoritatively v2**. The reader
returns the union; a separate normalization produces the display/export view with its
origin marked:

```ts
function readStoredScanReport(json: unknown): ScanReportV1 | SingleReportV2 | ComparisonReportV2;

type ReportView = { origin: "v2" | "legacy-derived"; /* normalized display fields */ };
function toReportView(report: StoredScanReport): ReportView;
```

- Display and export keep working for every legacy report: permalinks, directory,
  corpus rows (which gain a `schema_version` column so researchers can filter).
- Where the view derives v2-shaped facts from v1 (a quality guess from status and
  bot-wall heuristics, detector entries inferred from optional-field presence), the
  `legacy-derived` origin is carried through to the UI and the export note, never
  presented as recorded fact.
- **v1 reports are ineligible for intervention and temporal designs**: their
  environment was never fully recorded (no build commit, no list digests, no detector
  versions), so measurement compatibility cannot be established. v1-v1 and v1-v2 pairs
  are `descriptive` at best.

### 10.2 Validator and JSON Schema tooling (concrete)

- **Source of truth**: the TypeScript types in `lib/` (matching the repo's zero-dep
  posture; no runtime schema library in production paths, consistent with the
  aws4fetch precedent).
- **Runtime validator**: one hand-written `lib/` validator for the union, consumed by
  the app, the scripts (via the compiled `.unit-test-dist` path the `corpus:pagegraph`
  CLI already uses), and tests. The Worker keeps validating only v1 (frozen producer).
- **JSON Schema**: generated at build time from the TS types with
  `ts-json-schema-generator` (devDependency only), published at
  `/scan-report.v2.schema.json` (immutable per minor bump; `/scan-report.schema.json`
  redirects to current). v1 gets a one-time generated schema for researchers.
- **Anti-drift gate**: a unit suite validates shared fixtures against **both** the
  runtime validator and the generated schema (ajv as a devDependency in tests only)
  and fails on any disagreement, so the hand-written validator cannot drift from the
  published contract.

### 10.3 Migration order

1. Reader union + display view + validator + published schemas land; all consumers
   accept both versions (no emit change).
2. Redaction v2 ships inside v1 emission (removing data is schema-compatible), with
   the remediation pass of section 9.6.
3. Producers emit v2: Node scanner, compare-reports, CI script, PageGraph adapter.
   Browser Run stays v1 (section 11.1).
4. Manifest builder, corpus stats, exports, smoke tests assert v2 for new artifacts
   while tolerating v1 rows.
5. Corpus regeneration via the weekly cron replaces committed v1 reports organically;
   per-site keep-two retention means both generations coexist during the transition.

---

## 11. Resolved review decisions (2026-07-09)

1. **Browser Run Worker: frozen at v1**, deprecated, self-host-only. Security-relevant
   redaction and size limits are backported while it remains deployable; no v2 parity
   work.
2. **Historical remediation: audit first**, re-redact the current tree, R2, generated
   exports, KV remnants, Actions artifacts, and Pages deployments; git history rewrite
   only on confirmed credentials, session tokens, direct identifiers, or stable
   per-user identifiers (section 9.6).
3. **Phase shape**: compact `phaseId` on every phase-sensitive observation, backed by
   the per-run phase table; requests attribute by start phase (section 7).
4. **AB/BA**: counterbalanced from the first v2 experiment release (no added scan
   cost). Repeated pairs deferred; behavior alerts will require a confirmation run.
5. **Digests**: aggregate manifest digest per run + published immutable per-list
   digest manifest, including engine and normalization versions (section 3.4).

## 12. Deferred extensions

- **Signed attestation**: a producer signature over canonical public-report bytes
  would turn self-reported provenance into verifiable provenance. Deferred until key
  management has an owner; the canonicalization rules shipped with v2 are the
  prerequisite and are designed not to preclude it.
- **Repeated pairs / variance estimation**: recorded in the experiment shape
  (`pairId`, order) but not scheduled; revisit with run-cost data.

## 13. Implementation order after acceptance

1. Versioned reader, public projection (`toPublicScanReport`), and validator
   foundation (union types, display view, published schemas, anti-drift gate).
2. Redaction-v2 sanitizer across every persistent sink, plus the remediation
   inventory and pass (section 9.6).
3. v2 provenance, quality, detector status, and fingerprints (v2 emission).
4. Verified phased experiments (sections 6 and 7, manipulation checks).
5. Unified corpus eligibility (comparability + per-metric registry consumed by
   headlines, diffs, temporal deltas, stats, exports) and corpus regeneration.
6. Durable queue (inheriting section 9.7's constraints).
7. Registrable-domain profiles and watches (opaque watch IDs, encrypted targets).

---

## Changelog

- **v0.2 (2026-07-09)**: evidence blocks moved per-run (`ScanRunV2`,
  `ComparisonReportV2`); single `{kind,state}` intervention replaced by an orthogonal
  condition vector plus a declared intervention axis; `environmentFingerprint` split
  into execution vs measurement fingerprints with a per-metric compatibility registry;
  comparison-design union (intervention/temporal/descriptive) plus an explicit
  manipulation check; redaction stats separated from capture loss (only capture loss
  censors); requested vs observed subject identities, profiles keyed by registrable
  domain, watches as opaque IDs over encrypted targets; consent `choiceState`
  five-way enum with versioned interpreters and post-reload re-verification; phase
  tags extended to all evidence via `phaseId` + phase table; ephemeral vs public
  separated structurally by an allowlist projection; v1 kept as a distinct wire type
  normalized into a `legacy-derived` view; "prove" softened to machine-checkable
  evidence with signed attestation deferred; concrete validator/JSON Schema tooling;
  remediation inventory expanded (KV remnants, Actions artifacts, exports); the five
  v0.1 open questions resolved per review and recorded in section 11.
- **v0.1 (2026-07-09)**: initial draft.
