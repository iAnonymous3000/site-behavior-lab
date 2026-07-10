# RFC: ScanReport v2, the Verified Experiment Contract

> Status: **v0.3 DRAFT, 2026-07-09, awaiting acceptance. Design only; no implementation
> ships from this document.** v0.3 is the final planned revision (changelog at the end);
> further changes only if a normative example (section 12) exposes a contradiction.
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
(section 13), not a v2 requirement.

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

## Non-goals

- No durable queue, watchlists, scheduled monitoring, or alert channels (later phases).
- No new detectors and no change to what the scanner observes.
- No raw-request archive; the origin+path scrub posture tightens, never loosens.
- No v2 upgrade of the Browser Run Worker producer (frozen at v1, section 11.1).

---

## 1. Report shapes: evidence is per-run

`quality`, `privacy`, `detectors`, conditions, and provenance can all legitimately
differ between baseline and variant (one run hits a cap, one detector fails on one side,
a Workers Build lands between runs). The **run** is the unit of evidence:

```ts
type ScanRunV2 = {
  runId: string;
  startedAt: string;                 // ISO 8601, per run (v1 comparisons shared one root scannedAt)
  subject: SubjectIdentity;          // section 2
  conditions: ConditionVector;       // section 3.1
  provenance: Provenance;            // section 5.1
  fingerprints: Fingerprints;        // section 3.2
  qualityFacts: QualityFacts;        // section 5.3, recorded facts
  quality: Quality;                  // section 5.3, derived by the shared evaluator
  privacy: PrivacyStats;             // section 5.2
  detectors: DetectorLedger;         // section 5.4
  phases: PhaseSpan[];               // section 7
  summary: RunSummary;               // section 1.1
  evidence: RunEvidence;             // section 7.1, phase-aware types
  warnings: string[];                // scanner-vocabulary strings only (section 9.4)
};

type PublicSingleReportV2 = {
  schemaVersion: 2;
  schemaRevision: number;            // section 10.2
  reportType: "single";
  run: ScanRunV2;
  share?: ReportShare;
};

type PublicComparisonReportV2 = {
  schemaVersion: 2;
  schemaRevision: number;
  reportType: "comparison";
  baseline: ScanRunV2;
  variant: ScanRunV2;
  experiment: Experiment;            // section 4.2; `design` lives HERE and only here
  comparability: Comparability;      // section 4.4, evaluated
  diff: ComparisonDiffV2;            // per-metric eligibility applied (section 3.3)
  share?: ReportShare;
};
```

Ephemeral counterparts (`EphemeralSingleReport`, `EphemeralComparisonReport`) are the
same shapes plus ephemeral-only fields (screenshot, and any future immediate-response
extras); section 8 defines the projection. The wire type is a discriminated union,
never a synthesis (section 10.1):

```ts
type StoredScanReport = ScanReportV1 | PublicSingleReportV2 | PublicComparisonReportV2;
```

### 1.1 `RunSummary`, concrete

```ts
type RunSummary = {
  pageTitle: string;                 // string policy applied (section 9.4)
  status: number | null;
  durationMs: number;
  counts: {
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyDomains: number;
    cookies: number;
    thirdPartyCookies: number;
    storageEntries: number;
    fingerprintEvents: number;
    shieldsBlockedRequests?: number;
  };
  countsByPhase: Array<{
    phaseId: PhaseId;
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
  }>;
};
```

---

## 2. Subject identity

Requested and observed subjects are distinct facts and both are kept. Registrable
domain alone collapses `shop.example.com` and `auth.example.com`, so identity carries
the normalized origin as well:

```ts
type SubjectIdentity = {
  requested: SubjectKey;             // what the submitter asked for
  observed: SubjectKey;              // derived from the FINAL url
};
type SubjectKey = {
  origin: string;                    // normalized privacy-safe origin: lowercase, IDN as
                                     // punycode A-label, default port stripped ("https://shop.example.com")
  registrableDomain: string;         // eTLD+1 ("example.com")
  routeShape: string;                // section 9.1 ("/products/{seg}")
};
```

- **Comparison identity** is `observed.origin` + `observed.routeShape`.
- **Public profile grouping** is `observed.registrableDomain` (origins are display
  detail within a profile).
- Redirects make the observed subject the measured one; `requested !== observed` is
  itself evidence and feeds `comparability.checks.subjectMatch`.
- **Route-specific watches (future) never use route identity in public keys.** A watch
  is a random opaque ID referencing an encrypted target URL (section 9.7). No stable
  hashes of routes, no public route identifiers: a stable hash is linkable and a
  low-entropy route is dictionary-recoverable.

---

## 3. Conditions and fingerprints

### 3.1 The condition vector

Conditions are an **orthogonal vector of every input the operator controls**; the
experiment separately declares which single axis it intends to move (section 4.2):

```ts
type ConditionVector = {
  gpc: boolean;
  shields: "off" | "classification" | "block-simulation";
  consent: "observe" | "accept-all" | "reject-all";
  device: { kind: "desktop" | "mobile"; viewport: { width: number; height: number; isMobile: boolean } };
  probes: { keystroke: boolean; policyVisit: boolean };
  locale: string; language: string; timezone: string;
  egress: { label: string; region?: string };
  browser: { name: string; version: string };
  headless: boolean;
  automation: ScanAutomation;
};

// The axes an experiment may move. Everything else is environment.
type InterventionAxis = "gpc" | "shields" | "consent";
```

### 3.2 Three fingerprints

v0.2 had a hard contradiction: its measurement fingerprint included the condition
vector, while intervention validity required equal measurement fingerprints despite
intentionally changing one condition. v0.3 fixes the model with three digests:

```ts
type Fingerprints = {
  // Exact reproducibility: sha256 over canonical JSON of the COMPLETE condition
  // vector + buildCommit + methodologyVersion + detectorRegistry version/digest +
  // catalog/list digests + engine and normalization versions.
  execution: string;

  // Behavior-affecting environment, EXCLUDING the intervention axes' values
  // (gpc, shields, consent are removed before hashing; device, probes, locale/tz,
  // egress, browser, headless, automation remain) + methodologyVersion + detector
  // registry + catalog/list digests + engine/normalization versions, MINUS
  // buildCommit. Two runs with equal measurementEnvironment fingerprints were
  // measured the same way; they may still differ in intervention state.
  measurementEnvironment: string;

  // The complete condition vector alone (all axes, including intervention values),
  // no versions or digests. Equal conditionFingerprints = same requested setup.
  condition: string;
};
```

Canonicalization: sorted keys, no insignificant whitespace, NFC strings; the exact
rules ship with the validator and the published schema. Digests exist for equality
testing and indexing only, never secrecy; the full objects are always stored alongside.

**The unknown rule:** any required dimension whose value is unknown (a v1-derived view,
a failed probe of the environment) makes strict eligibility **unprovable**. Two
`"unknown"` values never count as a match; the evaluator returns ineligible with reason
`unknown-dimension:<field>`.

### 3.3 Versioned per-metric compatibility

Fingerprint equality is still too blunt: a filter-list update invalidates Shields
metrics but not raw request counts. v2 ships a **metric dependency registry**, itself
versioned (`metricRegistryVersion`, recorded in every comparability result), mapping
each metric family to the fingerprint components it depends on:

| Metric family | Compatibility key (must match between runs) |
|---|---|
| raw request/cookie/storage counts | browser, device, locale/tz, egress, methodologyVersion |
| tracker classification | the above + trackerCatalog digest |
| Shields simulation (`shieldsBlockedRequests`, tried-vs-blocked) | the above + adblock manifest digest + engine version |
| consent verification | the above + CMP interpreter versions |
| detector findings | the above + that detector's version |

Comparability (section 4.4) is evaluated **per metric family**: a pair can be
temporally comparable on raw counts while ineligible on Shields metrics, and the diff
renders exactly that. Unknown values in any key follow the unknown rule.

### 3.4 List digests

Each run stores one **aggregate digest** over the pinned list/catalog snapshot
(`catalogDigests.trackerCatalog`, `catalogDigests.adblockManifest`), plus engine and
normalization versions. Separately, the repo publishes an **immutable per-list digest
manifest** (list name, version, sha256, fetchedAt) keyed by the aggregate digest, so a
mismatch can be diagnosed to the specific list without bloating every report.

---

## 4. Designs, per-arm verification, comparability

### 4.1 The design union

```ts
type ComparisonDesign =
  | { kind: "intervention"; axis: InterventionAxis }  // exactly one condition axis differs
  | { kind: "temporal" }        // measurement-compatible conditions separated by time
  | { kind: "descriptive" };    // arbitrary pair, NEVER causal (imports, ad-hoc uploads)
```

Validity requirements, enforced by the evaluator:

- `intervention`: equal observed subjects, equal `measurementEnvironment`
  fingerprints, condition vectors differing in exactly the declared axis, **both
  arms' verification passed** (4.3), both runs `quality.outcome === "complete"`.
- `temporal`: equal observed subjects, equal `condition` fingerprints,
  measurement-compatible per metric family (3.3), both runs complete.
- `descriptive`: no requirements; every causal surface is suppressed unconditionally.

v1's `comparisonType` maps onto design + axis; "custom" maps to `descriptive`.
`design` appears in exactly one place: `experiment.design`.

### 4.2 Experiment

```ts
type Experiment = {
  design: ComparisonDesign;
  pairId: string;                    // random id shared by both runs
  order: "AB" | "BA";                // counterbalanced from the first v2 release (no scan cost)
  verification: {                    // section 4.3: BOTH arms, always
    baseline: ArmVerification;
    variant: ArmVerification;
  };
  evidence: {
    pairs: number;                   // 1 in the first release
    counterbalanced: boolean;        // true only when replicated AB and BA pairs are aggregated
    strength: "observed-difference" | "replicated-difference";
  };
};
```

Evidence strength is part of the claim vocabulary: one valid pair supports "we observed
an intervention difference"; only counterbalanced replicated evidence upgrades to the
stronger causal framing; and **future behavior alerts require a confirmation run**
regardless.

### 4.3 Per-arm verification (the manipulation check, both directions)

A singular variant-only check cannot distinguish "the intervention worked" from "both
arms silently ran in the same state". Every intervention pair verifies **both arms**:

```ts
type ArmVerification = {
  axis: InterventionAxis;
  expected: string;                  // "gpc:off", "shields:block-simulation", "consent:reject-all"
  observed: string | null;           // what the interpreter actually read; null = unobservable
  method: string;                    // versioned: "gpc-header-readback@1", "shields-engine-status@1", "tcf-api@1"
  outcome: "passed" | "failed" | "inconclusive";
  phaseId: PhaseId;                  // when verification ran
};
```

- GPC: baseline verifies `Sec-GPC` absent and `navigator.globalPrivacyControl` unset;
  variant verifies header present and the in-page signal true.
- Shields: baseline verifies the engine was not applied (classification mode, zero
  block actions); variant verifies engine active with a nonzero evaluation count.
- Consent: **accept and reject must both verify** via `choiceState === "verified"`
  (section 6); a verified accept with an inconclusive reject is not an intervention
  result.

Any arm outcome other than `passed` makes the pair **inconclusive as an experiment**:
causal surfaces are suppressed and the pair is reported descriptively, never as "the
intervention changed nothing".

### 4.4 Comparability, an evaluated result

Computed per pair by one shared, versioned evaluator; never part of a fingerprint:

```ts
type Comparability = {
  evaluatorVersion: string;
  metricRegistryVersion: string;
  comparable: boolean;                       // for the declared design as a whole
  perMetric: Record<MetricFamily, { eligible: boolean; reasons: ComparabilityReason[] }>;
  checks: {
    subjectMatch: boolean;                   // observed origin + routeShape equal
    conditionDeltaValid: boolean;            // matches the declared design
    environmentComparable: boolean;          // per fingerprints + unknown rule
    bothRunsComplete: boolean;               // quality.outcome === "complete" on BOTH;
                                             // matching failure statuses never make a pair comparable
    verificationPassed: boolean;             // both arms, section 4.3
  };
  mismatchReasons: ComparabilityReason[];    // enumerated, empty when comparable
};
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

The observer (what measured) is separate from the acquisition channel (what asked for
the measurement); CI is an orchestrator, not a scanner:

```ts
type Provenance = {
  observer: "node-playwright" | "browser-run-worker" | "pagegraph-import";
  acquisition: "public-api" | "operator-cli" | "ci-workflow" | "upload";
  buildCommit: string;               // self-reported, machine-checkable metadata
  methodologyVersion: string;        // meaning of the numbers; distinct from schemaVersion (shape)
  detectorRegistry: { version: string; digest: string };   // the known-detector set itself is versioned
  sourceArtifactDigest?: string;     // e.g. sha256 of an imported PageGraph GraphML
};
```

### 5.2 `privacy` (redaction stats, not loss)

Redaction is **expected behavior**, not evidence degradation. Its counters make the
policy auditable but never censor a run:

```ts
type PrivacyStats = {
  redactionVersion: number;
  redaction: {
    pathSegmentsGeneralized: number;
    queryKeysRedacted: number;
    storageKeysRedacted: number;
    cookieNamesRedacted: number;
    matrixParamsStripped: number;
    malformedUrlsDropped: number;
  };
};
```

### 5.3 Quality: recorded facts, one shared evaluator

Producers do not declare quality; they record facts, and **one shared versioned
evaluator** derives the outcome, so no producer can grade its own homework
differently from another:

```ts
type QualityFacts = {
  status: number | null;
  botWallTitleMatched: boolean;
  navigationSettled: boolean;
  budgetsExhausted: string[];              // enumerated budget names
  captureLoss: CaptureLossEntry[];         // by family AND phase
};

type CaptureLossEntry = {
  family: EvidenceFamily;
  phaseId: PhaseId | null;                 // null = not attributable to a phase
  kind: "dropped" | "clipped" | "truncated" | "timeout" | "cap";
  count: number;
  detail?: string;
};

type EvidenceFamily =
  | "requests" | "cookies" | "storage"
  | "fingerprinting" | "detector-output" | "consent-verification";

type Quality = {
  evaluatorVersion: string;
  outcome: "complete" | "censored" | "failed";
  reasons: QualityReason[];                // enumerated
};
```

Capture loss is scoped to family and phase so eligibility can be genuinely
metric-scoped: dropped requests censor request-derived metrics, a consent-verification
timeout censors consent metrics, and neither poisons the other. "Censored" is the
statistician's sense: observation ended or was capped before completion. Size-limit
clipping (section 9.5) is capture loss, never a privacy statistic.

### 5.4 `detectors`

```ts
type DetectorLedger = Record<DetectorId, {
  version: string;
  status: "complete" | "partial" | "skipped" | "unsupported" | "failed";
  reason?: string;                   // enumerated where possible ("no-form-fields", "budget-exhausted")
  phaseId?: PhaseId;
}>;
```

The ledger must contain an entry for **every detector in the referenced detector
registry version**; a missing entry is a validation error, so silence is never
ambiguous again.

---

## 6. Consent semantics

### 6.1 Replace the overloaded `clicked`

```ts
type ConsentEvidence = {
  mode: "accept-all" | "reject-all";
  interactionAttempted: boolean;
  controlActivated: boolean;               // a control was actually clicked (v1 `clicked`)
  choiceState: "verified" | "contradicted" | "weak-signal" | "unavailable" | "failed";
  verificationMethod?: string;             // versioned interpreter id: "tcf-api@1", "onetrust-cookie@1"
  verificationFailureReason?: string;      // enumerated: banner-persisted, tcf-unavailable,
                                           // cookie-absent, state-contradicts-choice, ...
  reverifiedAfterReload: boolean;          // the post-reload re-check ran and agreed
  cmp?: string; selector?: string; matchedText?: string; frameUrl?: string;   // carried from v1
};
```

- `verified`: a versioned CMP-state interpreter (IAB TCF `__tcfapi` TCData, or a known
  CMP state cookie such as OneTrust `OptanonConsent`) read a stored state consistent
  with the choice, **and** the re-verification after reload agreed.
- `contradicted`: an interpreter read state inconsistent with the click.
- `weak-signal`: no interpreter available; the only evidence is banner dismissal,
  which is a UI signal, not consent state.
- `unavailable`: no interpreter and no usable UI signal.
- `failed`: interpreter errored.

Interpreters are versioned (they encode third-party formats that change) and
participate in the consent-verification compatibility key (3.3). The per-arm
verification of a consent intervention (4.3) maps `choiceState` to the arm outcome:
`verified` passes, `contradicted`/`failed` fail, `weak-signal`/`unavailable` are
inconclusive.

### 6.2 Phased experiment flow

1. `passive-load`: initial navigation, pre-interaction traffic.
2. `consent-interaction`: from click attempt to settle, plus initial state read.
3. `post-choice-reload`: a reload under the established consent state, then
   re-verification. **This reload is the measured run for post-choice claims.**
4. `active-probe`: keystroke sentinel and unload-flush window.
5. `policy-analysis`: the bounded policy-page visit (already excluded from counts).

Claims gate on phases and state: "trackers that survived rejection" reads
`post-choice-reload` traffic with `choiceState === "verified"`. The public corpus is
regenerated after this lands; the export gains `consent_choice_state` beside
`consent_clicks`.

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

Runs without experiments have a single `passive-load` phase (plus probe/policy phases
when enabled), so the model is uniform.

### 7.1 Phase-aware evidence types

```ts
type RunEvidence = {
  requests: NetworkRequestRecordV2[];      // v1 record + { phaseId } (start phase)
  cookieMutations: CookieMutation[];       // section 7.2
  cookiesFinal: CookieRecordV2[];          // final-jar snapshot (names/paths per string policy)
  storageMutations: StorageMutation[];     // section 7.2
  storageFinal: StorageRecordV2[];
  fingerprintEvents: Array<FingerprintEventSummary & { phaseId: PhaseId }>;
  fingerprintDetections: Array<FingerprintDetectionSummary & { phaseId: PhaseId }>;
  cnameCloaks: CnameCloak[];               // derived from requests; phase via the requests
  pixelEvents: Array<PixelEventSummary & { phaseId: PhaseId }>;
  privacyPolicy?: PrivacyPolicySummary;    // policy-analysis phase by definition
  consent?: ConsentEvidence;
};
```

### 7.2 Cookie and storage mutations, not "first observed"

"First observed" cannot show that a value changed or disappeared (a consent rejection
that deletes a tracking cookie is exactly the evidence we want). The producer snapshots
the cookie jar and storage at each phase boundary and stores the final snapshot plus
per-phase mutations:

```ts
type CookieMutation = {
  phaseId: PhaseId;                        // phase in which the mutation was observed
  op: "added" | "changed" | "removed";
  cookie: CookieRecordV2;                  // state after the op (or last state, for "removed")
};
type StorageMutation = {
  phaseId: PhaseId;
  op: "added" | "changed" | "removed";
  entry: StorageRecordV2;                  // key per policy, area, valueBytes after the op
};
```

`countsByPhase` and the consent claims read mutations; the final snapshots keep the v1
"what was there at the end" view.

---

## 8. Ephemeral vs public schemas

Schema annotations cannot stop a screenshot from being persisted; types and a single
projection function can:

```ts
type EphemeralSingleReport     = PublicSingleReportV2     & { run: { screenshot: string | null } /* + future ephemeral fields */ };
type EphemeralComparisonReport = PublicComparisonReportV2 & { baseline: {...}; variant: {...} };

function toPublicScanReport(r: EphemeralSingleReport): PublicSingleReportV2;
function toPublicScanReport(r: EphemeralComparisonReport): PublicComparisonReportV2;
```

- The projection copies **named fields only** (allowlist); unknown or new fields are
  dropped by construction, so a future ephemeral addition cannot leak by default.
- The report store, corpus scripts, exports, and share endpoints accept the public
  **types only**; the immediate scan response is the one surface that may carry the
  ephemeral types (today's screenshot behavior, made structural).
- The published JSON Schema documents the public types; ephemeral fields are simply
  absent from it.

---

## 9. Privacy boundary first (redaction v2)

Sequenced **before** durable jobs so the queue never persists what minimization would
have removed. Current state ([lib/report-url.ts](../lib/report-url.ts)): userinfo,
hash, and query values are stripped, but the **path is kept verbatim**, and a URL that
fails to parse is **returned unmodified** (`report-url.ts:26`), which v2 forbids.

### 9.1 Path-shape redaction, default-deny

- Keep scheme + normalized host. Reduce paths to a bounded shape: at most N segments
  (proposal: 6).
- A segment survives literally **only** if it appears in a small versioned literal
  allowlist (`routeLiteralAllowlist@<version>`: common route words like `products`,
  `privacy`, `search`, `api`, `docs`; shipped with the repo, a few hundred entries,
  changes reviewed like code). **Everything else becomes a marker**: numeric to
  `{n}`, everything else to `{seg}`. No "dictionary-ish" heuristics: a heuristic that
  passes short lowercase words also passes names, health topics, and identifiers.
- **Semicolon (matrix) parameters**: everything from the first `;` in each segment is
  stripped before classification; the parameter name is preserved only if it passes
  the same safe-key rule as query keys.
- **Malformed input redacts, never passes through**: an unparseable URL becomes
  `{invalid-url}` and increments `privacy.redaction.malformedUrlsDropped`.
- **No public unsalted hashes for token-like segments.** A hash of a low-entropy token
  is a dictionary lookup away from the token, and a stable hash is itself a linkable
  identifier. Tokens become `{seg}`, full stop.

### 9.2 Every persistent or public sink

The same URL policy applies to: `evidence.requests[].url`, **nested provenance URLs**
(`NetworkRequestProvenance.initiatorUrl/scriptUrl/injectedByUrl`), requested/final
URLs, `consent.frameUrl`, `privacyPolicy.url`, PageGraph fact-table rows
([lib/pagegraph-corpus.ts](../lib/pagegraph-corpus.ts)), corpus exports, share links
surfaced in UI, server logs, and any future queued job payload. One function, one
version number, one test suite.

### 9.3 Storage keys and cookie names

Keys/names matching the safe-key pattern (short, conventional: `_ga`, `theme`,
`cartId`) survive; the rest become a class marker plus shape info
(`[redacted:uuid-like]`), keeping `area`/`valueBytes` for storage and flags for
cookies. Cookie `path` follows the route-shape rules; cookie `domain` is host
normalization only.

### 9.4 Field-by-field policy for every public string

The schema documents, for **every** public string field, which policy applies:

| Field | Policy |
|---|---|
| all URL fields incl. nested provenance | origin + route shape (9.1) |
| cookie name / storage key | safe-key allowlist or class marker (9.3) |
| cookie path | route shape (9.1) |
| `summary.pageTitle` | length cap + control-character strip (bot-wall matching runs before capping) |
| `consent.matchedText` | only the scanner's own conservative phrase list verbatim (existing rule), else marker |
| `warnings`, `reason`, `detail` fields | enumerated codes or scanner-vocabulary text only; never page-derived strings |
| privacy-policy quotes (`PrivacyPolicyClaim`) | page-derived by design (the quote is the evidence); bounded sentence-level matches only, length-capped, and flagged as quoted material in the schema |
| pixel event names | existing `isSafeEventToken` filter (value-shaped strings rejected) |
| PageGraph identifiers | opaque numeric ids; embedded URLs through 9.1 |

Anything not in the table does not ship; adding a public string field requires adding
its policy row in the same change.

### 9.5 Size limits

Per-field string caps, per-array caps, and a total serialized-report cap, enforced at
build time. Clipping is **capture loss** (`quality.captureLoss`, family- and
phase-scoped), not a privacy statistic: a hostile page must not bloat public
artifacts, and the report must say which evidence was cut.

### 9.6 Remediation of already-published identifiers

Forward-only redaction does not fix what is already public. **Audit first**, then
re-redact in place across the full inventory:

1. **Committed static reports** (`public/reports/` working tree).
2. **Git history** of those reports: rewrite (`git filter-repo` + force push) **only
   if the audit confirms** credentials, session tokens, direct identifiers, or stable
   per-user identifiers in historical paths; otherwise accept and document the
   residual.
3. **R2 share reports**: rewrite objects in place, **preserving the original retention
   clock**: `createdAt`/`expiresAt` (and the ID's date prefix) are immutable, carried
   in object metadata, and any age logic must read them rather than the rewrite's
   `LastModified`. A remediation pass must not restart retention.
4. **Generated exports**: `/corpus.json`, `/corpus.csv` regenerate from re-redacted
   inputs on the next build.
5. **KV remnants**: the retired Browser Run worker's `REPORTS_KV` namespace still
   holds v1 report blobs; re-redact or delete.
6. **GitHub Actions artifacts**: scan-workflow artifacts and job summaries that embed
   URLs; expire or delete.
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

## 10. Backward compatibility, versioning, tooling

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

v1 is **never synthesized into something that looks authoritatively v2**:

```ts
function readStoredScanReport(json: unknown): StoredScanReport;   // the union, or a typed error

type ReportView = { origin: "v2" | "legacy-derived"; /* normalized display fields */ };
function toReportView(report: StoredScanReport): ReportView;
```

- Display and export keep working for every legacy report: permalinks, directory,
  corpus rows (which gain a `schema_version` column so researchers can filter).
- Where the view derives v2-shaped facts from v1 (a quality guess from status and
  bot-wall heuristics, detector entries inferred from optional-field presence), the
  `legacy-derived` origin is carried through to the UI and export note, never
  presented as recorded fact.
- **v1 reports are ineligible for intervention and temporal designs**: their
  environment was never fully recorded, so per the unknown rule (3.2) measurement
  compatibility is unprovable. v1-v1 and v1-v2 pairs are `descriptive` at best.
- **Builders stay separate**: the frozen v1 builder types
  ([lib/scan-result-builder.ts](../lib/scan-result-builder.ts), used by the Browser
  Run Worker) are not touched by v2 modules; v2 gets its own builder. The frozen
  producer remains type-safe against frozen types.

### 10.2 Versioning

- `schemaVersion` (major, breaking shape changes) + `schemaRevision` (additive,
  optional-field changes within a major). Readers accept any revision of a known
  major; validators know the highest revision they understand.
- JSON Schema files are **immutable per revision** with revisioned `$id` and filename:
  `https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json`. A stable alias
  (`/scan-report.schema.json`) points at the current revision.
- The detector registry (5.1), metric dependency registry, quality evaluator, and
  comparability evaluator each carry their own version, recorded in the artifacts they
  produce, so results are interpretable after any of them changes.
- **v1 revisioning**: if hardened redaction ships in v1 emission before v2 (step 5 of
  section 14), v1 gains an optional top-level `redactionVersion` field as v1
  revision 2 (absent = r1). v1's structural validators tolerate additive optional
  fields, and the v1 schema addendum documents it.

### 10.3 Validator and JSON Schema tooling (executable)

- **Source of truth**: the TypeScript types in `lib/` (zero-dep production posture,
  consistent with the aws4fetch precedent).
- **Runtime validator**: one hand-written `lib/` validator for the union, consumed by
  the app and the scripts.
- **Production-safe artifact**: scripts consume a dedicated compiled artifact from a
  `build:schema` step (own tsconfig emitting `dist/schema/`, built in CI before any
  manifest/corpus step), **not** the `.unit-test-dist` test tree.
- **JSON Schema generation**: `ts-json-schema-generator` (devDependency, build-time
  only) emits the revisioned schema files; publishing is part of the Pages build.
- **Differential + invalid-mutation tests**: the fixture corpus contains valid
  fixtures **and generated invalid mutants** (each required field deleted, each enum
  off-range, each type flipped, unknown fields where forbidden). A differential
  harness asserts the runtime validator and ajv-on-generated-schema (devDependency,
  tests only) agree on accept AND reject for every fixture; any disagreement fails.
  Happy-path fixtures alone cannot establish validator/schema equivalence.

### 10.4 Migration order

Superseded in detail by section 14; the invariants remain: readers land before any
emit change, redaction can ship inside v1 emission (removing data is
schema-compatible, tracked as v1 r2), Browser Run stays v1, and the corpus regenerates
organically via the weekly cron with per-site keep-two retention bridging the
transition.

---

## 11. Resolved review decisions (2026-07-09)

1. **Browser Run Worker: frozen at v1**, deprecated, self-host-only. Security-relevant
   redaction and size limits are backported while it remains deployable; no v2 parity
   work. Builder/type separation per 10.1.
2. **Historical remediation: audit first**, re-redact the current tree, R2, generated
   exports, KV remnants, Actions artifacts, and Pages deployments; git history rewrite
   only on confirmed credentials, session tokens, direct identifiers, or stable
   per-user identifiers (9.6). Retention clocks are preserved through rewrites.
3. **Phase shape**: compact `phaseId` on every phase-sensitive observation, backed by
   the per-run phase table; requests attribute by start phase; cookies/storage get
   per-phase mutations plus final snapshots (7.2).
4. **AB/BA**: counterbalanced from the first v2 experiment release (no added scan
   cost). Repeated pairs deferred; evidence strength is explicit (4.2) and behavior
   alerts will require a confirmation run.
5. **Digests**: aggregate manifest digest per run + published immutable per-list
   digest manifest, including engine and normalization versions (3.4).

---

## 12. Normative examples

The contract is coherent only if the types and evaluator produce these results without
exceptions.

### 12.1 Shields off/on while GPC stays enabled: valid intervention pair

- Baseline conditions: `{ gpc: true, shields: "classification", consent: "observe", ... }`
- Variant conditions: `{ gpc: true, shields: "block-simulation", consent: "observe", ... }`
- `experiment.design = { kind: "intervention", axis: "shields" }`
- Fingerprints: `measurementEnvironment` hashes exclude the gpc/shields/consent
  values, and everything else (device, locale, egress, browser, digests,
  methodology) matches, so the fingerprints are **equal**. GPC being enabled in both
  runs is a constant, not a delta.
- `conditionDeltaValid`: the vectors differ in exactly `shields`. True.
- Verification: baseline `{ axis: "shields", expected: "shields:classification",
  observed: "shields:classification", method: "shields-engine-status@1", outcome:
  "passed" }`; variant expected/observed `"shields:block-simulation"` with a nonzero
  evaluation count, `passed`.
- Both runs `quality.outcome === "complete"`, list digests equal, so
  `perMetric["shields-simulation"].eligible === true`.
- **Result: `comparable: true`; causal Shields framing permitted at
  `strength: "observed-difference"`.** Under v0.2's model this pair was impossible
  (the measurement fingerprint could never match); that is the contradiction v0.3
  fixes.

### 12.2 Accept verifies, Reject inconclusive: descriptive only

- `experiment.design = { kind: "intervention", axis: "consent" }`
- Baseline (accept-all): `consent.choiceState = "verified"` via `onetrust-cookie@1`,
  re-verified after reload. Arm outcome `passed`.
- Variant (reject-all): no interpreter available, banner dismissed, so
  `choiceState = "weak-signal"`. Arm outcome **`inconclusive`**.
- `checks.verificationPassed = false`; `comparable = false` with
  `mismatchReasons: ["arm-verification-inconclusive:variant"]`;
  `perMetric["consent-verification"].eligible = false`.
- **Result: no post-reject claim of any kind** ("kept tracking after you clicked
  Reject all" is suppressed, as is "rejection changed nothing"). The report renders
  descriptive observations (both runs' counts, the verified accept-side state), and
  the experiment is reported inconclusive with the enumerated reason.

### 12.3 Temporal pair across a filter-list update: split eligibility

- Two runs, three weeks apart, equal observed subjects, **equal `condition`
  fingerprints** (same full vector), both `complete`.
- `experiment.design = { kind: "temporal" }`
- Between runs, the pinned adblock lists were refreshed: `adblockManifest` digests
  differ; browser, device, locale, egress, methodology, detector versions all match.
- Per-metric evaluation: raw request/cookie/storage counts depend on browser, device,
  locale/tz, egress, methodology only, all equal, so
  `perMetric["raw-counts"].eligible = true`. Shields simulation depends additionally
  on the adblock manifest digest, which differs, so
  `perMetric["shields-simulation"].eligible = false` with
  `reasons: ["dependency-digest-mismatch:adblockManifest"]` (the published per-list
  manifest identifies which list changed).
- **Result: the diff renders raw-count temporal deltas ("+64 third-party requests
  since Jun 25") and suppresses Shields-derived deltas**, explaining why via the
  enumerated reason.

---

## 13. Deferred extensions

- **Signed attestation**: a producer signature over canonical public-report bytes
  would turn self-reported provenance into verifiable provenance. Deferred until key
  management has an owner; the canonicalization rules shipped with v2 are the
  prerequisite and are designed not to preclude it.
- **Repeated pairs / variance estimation**: the experiment shape already records
  `pairs`/`counterbalanced`/`strength`; scheduling replicated pairs waits for
  run-cost data.

## 14. Implementation order after acceptance

Step 1 is deliberately small and emits nothing new:

1. **Freeze v1**: the existing v1 wire types and validator are frozen as-is (own
   module, no further edits except security backports).
2. **Concrete v2 types + revisioned schemas + fixtures**: the types in this RFC,
   `scan-report.v2.r1.schema.json`, and the valid/invalid fixture corpus with the
   differential harness (10.3).
3. **Union reader + allowlist public projector** (`readStoredScanReport`,
   `toReportView`, `toPublicScanReport`).
4. **Migrate consumers one at a time** (report pages, directory, manifest builder,
   corpus stats, exports, smoke tests) onto the reader/view, still emitting v1
   everywhere.
5. **Only then redaction v2** (sanitizer across every persistent sink, shipped inside
   v1 emission as v1 r2, plus the remediation inventory and pass of 9.6), **and then
   producer v2 emission begins** (Node scanner, compare-reports, CI script, PageGraph
   adapter).

Then the larger phases:

6. Verified phased experiments (sections 4, 6, 7).
7. Unified corpus eligibility (comparability + metric registry consumed by headlines,
   diffs, temporal deltas, stats, exports) and corpus regeneration.
8. Durable queue (inheriting 9.7's constraints).
9. Registrable-domain profiles and watches (opaque watch IDs, encrypted targets).

---

## Changelog

- **v0.3 (2026-07-09)**: fixed the fingerprint contradiction (measurement fingerprint
  included the condition vector, making intervention pairs definitionally
  incomparable): three fingerprints (execution / measurementEnvironment excluding
  intervention axes / condition) plus the unknown rule (two unknowns never match).
  Per-arm verification replaces the variant-only manipulation check (expected,
  observed, versioned method, outcome, phase; both consent choices and both GPC and
  Shields states must verify); `design` deduplicated to `experiment` only; evidence
  strength made explicit (observed vs replicated difference; alerts need
  confirmation). Wire model completed: per-run `startedAt`, normalized origin in
  subject keys (comparison identity = origin + route shape; profiles group by
  registrable domain), concrete `RunSummary`, phase-aware evidence types with cookie
  and storage per-phase mutations plus final snapshots, concrete ephemeral/public
  single and comparison types. Eligibility made metric-scoped end to end: capture
  loss by evidence family and phase, quality derived by one shared versioned
  evaluator from recorded facts, matching failure statuses never make a pair
  comparable. Redaction made default-deny: versioned literal allowlist (no
  dictionary-ish heuristics), malformed input redacts instead of passing through
  (v1's parse-failure passthrough called out), field-by-field policy table for every
  public string, remediation preserves retention clocks. Versioning and tooling made
  executable: `schemaRevision`, immutable revisioned schema `$id`s, detector-registry
  and evaluator versions, observer vs acquisition split in provenance (CI is not a
  producer), production-safe `dist/schema` artifact instead of `.unit-test-dist`,
  differential + invalid-mutation validator tests, explicit v1/v2 builder separation,
  and v1 r2 for redaction shipped inside v1 output. Added three normative examples
  evaluated end to end. Implementation step 1 narrowed per review.
- **v0.2 (2026-07-09)**: evidence blocks moved per-run; orthogonal condition vector;
  execution vs measurement fingerprint split with per-metric compatibility;
  comparison-design union plus manipulation check; redaction separated from capture
  loss; requested vs observed subjects; consent `choiceState`; phase tags on all
  evidence; structural ephemeral/public split; v1 as a distinct wire type; "prove"
  softened; concrete tooling; expanded remediation; five open questions resolved.
- **v0.1 (2026-07-09)**: initial draft.
