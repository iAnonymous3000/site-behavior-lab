# RFC: ScanReport v2, the Verified Experiment Contract

> Status: **v0.3.1 ACCEPTED, 2026-07-09.** Architecture accepted at v0.3; the v0.3.1
> normative corrections landed with green CI (commit f746887, all checks passed), so
> per the acceptance condition this RFC is the implementation contract. Implementation
> follows section 14 without further architecture review. Successor to the v1 schema
> pinned at `SCAN_REPORT_SCHEMA_VERSION = 1` ([lib/types.ts](../lib/types.ts)). The
> durable job queue ([scan-job-model.md](scan-job-model.md)) and domain watchlists are
> explicitly out of scope and sequenced after this contract.

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
  toolchain: Toolchain;              // section 3.5: the digests/versions the fingerprints hash
  fingerprints: Fingerprints;        // section 3.2
  qualityFacts: QualityFacts;        // section 5.3, recorded facts
  quality: Quality;                  // section 5.3, derived by the shared evaluator
  privacy: PrivacyStats;             // section 5.2
  detectors: DetectorLedger;         // section 5.4
  phases: PhaseSpan[];               // section 7
  summary: RunSummary;               // section 1.1
  evidence: RunEvidence;             // section 7.1, phase-aware, sanitized (section 8)
  warnings: string[];                // scanner-vocabulary strings only (section 9.4)
};

type PublicSingleReportV2 = {
  schemaVersion: 2;
  schemaRevision: 1;                 // literal per revision; r2 types would say 2 (section 10.2)
  reportType: "single";
  run: ScanRunV2;
  share?: ReportShare;
};

type PublicComparisonReportV2 = {
  schemaVersion: 2;
  schemaRevision: 1;
  reportType: "comparison";
  baseline: ScanRunV2;
  variant: ScanRunV2;
  experiment: Experiment;            // section 4.1, a discriminated union; the design lives HERE and only here
  comparability: Comparability;      // section 4.4, evaluated
  diff: ComparisonDiffV2;            // NORMATIVE since the hardening amendment (10.5); rebuilt-and-compared on read
  share?: ReportShare;
};
```

The wire type is a discriminated union, never a synthesis (section 10.1):

```ts
type StoredScanReport = ScanReportV1 | PublicSingleReportV2 | PublicComparisonReportV2;
```

Ephemeral report shells and the raw/sanitized evidence boundary are defined in
section 8.

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
  origin: string;                    // normalized privacy-safe origin (sections 9.1/9.2 host policy):
                                     // lowercase, IDN as punycode A-label, default port stripped,
                                     // token-like subdomain labels generalized
  registrableDomain: string;         // eTLD+1 ("example.com")
  routeShape: string;                // section 9.1 ("/products/{seg}")
};
```

- **Comparison identity** is `observed.origin` + `observed.routeShape`.
- **Public profile grouping** is `observed.registrableDomain` (origins are display
  detail within a profile).
- Redirects make the observed subject the measured one; `requested !== observed` is
  itself evidence and feeds `comparability.pairValidity`.
- **Route-specific watches (future) never use route identity in public keys.** A watch
  is a random opaque ID referencing an encrypted target URL (section 9.7). No stable
  hashes of routes, no public route identifiers: a stable hash is linkable and a
  low-entropy route is dictionary-recoverable.

---

## 3. Conditions, toolchain, fingerprints

### 3.1 The condition vector

Conditions are an **orthogonal vector of every input the operator controls**; an
intervention experiment separately declares which single axis it intends to move:

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
intentionally changing one condition. The model is three digests:

```ts
type Fingerprints = {
  // Exact reproducibility: sha256 over canonical JSON of the COMPLETE condition
  // vector + buildCommit + methodologyVersion + detectorRegistry version/digest +
  // the full toolchain (section 3.5).
  execution: string;

  // Behavior-affecting environment, EXCLUDING the intervention axes' values
  // (gpc, shields, consent are removed before hashing; device, probes, locale/tz,
  // egress, browser, headless, automation remain) + methodologyVersion + detector
  // registry + toolchain, MINUS buildCommit. Two runs with equal
  // measurementEnvironment fingerprints were measured the same way; they may still
  // differ in intervention state.
  measurementEnvironment: string;

  // The complete condition vector alone (all axes, including intervention values),
  // no versions or digests. Equal conditionFingerprints = same requested setup.
  condition: string;
};
```

Canonicalization: sorted keys, no insignificant whitespace, NFC strings; the exact
rules ship with the validator and the published schema. Digests exist for equality
testing and indexing only, never secrecy; the hashed values are always stored on the
run (`conditions`, `provenance`, `toolchain`), so every fingerprint is recomputable
from the report.

**The unknown rule:** any required dimension whose value is unknown (a v1-derived view,
a failed probe of the environment) makes strict eligibility **unprovable**. Two
`"unknown"` values never count as a match; the evaluator returns ineligible with reason
`unknown-dimension:<field>`.

### 3.3 Versioned per-metric compatibility

Fingerprint equality is still too blunt: a filter-list update invalidates Shields
metrics but not raw request counts. v2 ships a **metric dependency registry**, itself
versioned (`metricRegistryVersion`, recorded in every comparability result), mapping
each metric family to the compatibility key it depends on:

```ts
type MetricFamily =
  | "raw-counts"                // request/cookie/storage totals
  | "tracker-classification"
  | "shields-simulation"
  | "consent-verification"
  | "detector-findings";
```

| Metric family | Compatibility key (must match between runs) |
|---|---|
| `raw-counts` | browser, device, locale/tz, egress, methodologyVersion |
| `tracker-classification` | the above + trackerCatalog digest |
| `shields-simulation` | the above + adblock manifest digest + engine version |
| `consent-verification` | the above + CMP interpreter versions |
| `detector-findings` | the above + that detector's version |

Eligibility is evaluated **per metric family** (section 4.4): a pair can be temporally
comparable on raw counts while ineligible on Shields metrics, and the diff renders
exactly that. Unknown values in any key follow the unknown rule.

### 3.4 List digests

Each run stores one **aggregate digest** per catalog (in `toolchain`), and the repo
publishes an **immutable per-list digest manifest** (list name, version, sha256,
fetchedAt) keyed by the aggregate digest, so a mismatch can be diagnosed to the
specific list without bloating every report.

### 3.5 `toolchain`, stored on the run

The fingerprints hash these values, so the run must store them (v0.3 referenced them
without a home):

```ts
type Toolchain = {
  trackerCatalog: { source: string; version: string; entries: number; digest: string };
  adblock: {
    source: string;
    lists: number;
    fetchedAt: string;
    manifestDigest: string;          // aggregate digest, keys the published per-list manifest
    engineVersion: string;           // vendored adblock-wasm build
  } | null;                          // null when no engine was loaded (e.g. classification-only producers)
  normalizationVersion: string;      // URL/host canonicalization rules version (section 9)
};
```

---

## 4. Experiments, verification, comparability

### 4.1 `Experiment` is a discriminated union

v0.3's single `Experiment` shape required AB/BA order and two intervention-axis
verifications on every comparison, but a temporal or descriptive comparison has no
intervention axis (its own example 12.3 could not be typed). The union fixes it;
verification and order fields **exist only on the intervention variant**:

```ts
type Experiment = InterventionExperiment | TemporalExperiment | DescriptiveExperiment;

type InterventionExperiment = {
  kind: "intervention";
  axis: InterventionAxis;
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

type TemporalExperiment = {
  kind: "temporal";
  pairId: string;
  // baseline is the chronologically earlier run; the validator enforces
  // baseline.startedAt < variant.startedAt. No order field, no verification:
  // nothing was manipulated.
};

type DescriptiveExperiment = {
  kind: "descriptive";
  pairId: string;
  sourceOrder: "as-provided" | "chronological" | "unknown";   // ordering if known; NEVER causal
};
```

Validity requirements, enforced by the evaluator:

- `intervention`: equal observed subjects, equal `measurementEnvironment`
  fingerprints, condition vectors differing in exactly the declared axis, both runs
  run-level complete. Verification (4.3) additionally gates intervention-attributed
  claims.
- `temporal`: equal observed subjects, equal `condition` fingerprints, baseline
  chronologically first, both runs run-level complete; per-family compatibility per
  3.3.
- `descriptive`: structurally always valid as a pairing of two well-formed runs;
  every causal surface is suppressed unconditionally.

v1's `comparisonType` maps onto the union: gpc/shields/consent to
`intervention` + axis, "temporal" to `temporal`, "custom" and ad-hoc uploads to
`descriptive`.

### 4.2 Evidence strength

Evidence strength is part of the claim vocabulary: one valid pair supports "we
observed an intervention difference"; only counterbalanced replicated evidence
(`strength: "replicated-difference"`) upgrades to stronger causal wording; and
**future behavior alerts require a confirmation run** regardless.

### 4.3 Per-arm verification (intervention experiments only)

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
intervention-attributed claims are suppressed and the pair is reported descriptively,
never as "the intervention changed nothing".

### 4.4 Comparability: pair validity + per-metric eligibility

v0.3's global `comparable`/`environmentComparable` gate conflicted with its own
example 12.3 (raw metrics eligible, Shields ineligible would have been suppressed
globally). The evaluated result has **no global comparable flag**; it has structural
pair validity, per-family eligibility, and an intervention gate that exists only for
intervention experiments:

```ts
type Comparability = {
  evaluatorVersion: string;
  metricRegistryVersion: string;

  // Structural: observed subjects match, the experiment is well-formed for its kind
  // (axis delta valid / chronology valid), and BOTH runs are run-level complete
  // (section 5.3). Matching failure statuses never make a pair valid.
  pairValidity: { eligible: boolean; reasons: ComparabilityReason[] };

  // Per metric family: pairValidity + that family's compatibility key matches
  // (unknown never matches) + that family is uncensored on both runs.
  perMetric: Record<MetricFamily, { eligible: boolean; reasons: ComparabilityReason[] }>;

  // ONLY present when experiment.kind === "intervention": both arms' verification
  // passed. Gates intervention-ATTRIBUTED claims, not family eligibility.
  interventionVerified?: boolean;
};
```

**Product rules, per claim surface:**

- `pairValidity.eligible === false`: no pair-level claims at all; the two runs render
  as independent reports.
- A family delta (counts, classifications, Shields numbers) renders iff
  `perMetric[family].eligible`.
- An intervention-attributed framing ("Shields blocked", "kept tracking after you
  clicked Reject all", "GPC changed nothing") additionally requires
  `interventionVerified === true`.
- Strong causal wording requires `strength === "replicated-difference"`; a single
  valid pair supports "observed intervention difference" phrasing only.
- Future alerts require a confirmation run.

This generalizes the per-feature gates that already exist (consent claims require a
real click, temporal deltas pair same-kind only, stats exclude status>=400) into one
evaluated object every consumer reads instead of re-deriving.

```ts
// Normative initial reason vocabulary (extensible only with a metricRegistryVersion
// or evaluatorVersion bump). Parameterized codes use "code:qualifier".
type ComparabilityReason =
  | "subject-mismatch"
  | "design-invalid"
  | `run-failed:${"baseline" | "variant"}`
  | `unknown-dimension:${string}`
  | `dependency-digest-mismatch:${string}`
  | `dependency-version-mismatch:${string}`
  | `family-censored:${"baseline" | "variant"}`
  | `arm-verification-failed:${"baseline" | "variant"}`
  | `arm-verification-inconclusive:${"baseline" | "variant"}`;
```

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
    subdomainLabelsGeneralized: number;
    malformedUrlsDropped: number;
  };
};
```

### 5.3 Quality: run-level validity, family-level censoring

Producers do not declare quality; they record facts, and **one shared versioned
evaluator** derives the outcome. Family-scoped capture loss must not censor the whole
run: a consent-verification timeout does not invalidate raw request counts.

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
  // Run-level: did the page load produce a valid observation at all?
  // "failed" = error/block page, bot wall, navigation never settled, empty load.
  run: { outcome: "complete" | "failed"; reasons: QualityReason[] };
  // Family-level: censoring from capture loss, scoped so one family's loss
  // never contaminates another's eligibility.
  byFamily: Record<EvidenceFamily, { outcome: "complete" | "censored"; reasons: QualityReason[] }>;
};

// Normative initial vocabulary; extensible only with an evaluatorVersion bump.
type QualityReason =
  | "http-error-status" | "bot-wall-title" | "navigation-timeout" | "empty-load"
  | "scan-slot-timeout" | `capture-loss:${string}` | `budget-exhausted:${string}`;
```

The mapping from evidence families to metric families is part of the metric dependency
registry: `raw-counts` reads requests/cookies/storage, `shields-simulation` reads
requests, `consent-verification` reads its own family, and so on. "Censored" is the
statistician's sense: observation ended or was capped before completion. Size-limit
clipping (section 9.5) is capture loss, never a privacy statistic.

### 5.4 `detectors`

```ts
// Normative initial registry (version "1"); the ledger must contain an entry for
// every detector in the referenced registry version, or validation fails.
type DetectorId =
  | "fingerprint-heuristics" | "keystroke-exfiltration" | "cname-uncloaking"
  | "pixel-events" | "consent-banner" | "privacy-policy";

type DetectorLedger = Record<DetectorId, {
  version: string;
  status: "complete" | "partial" | "skipped" | "unsupported" | "failed";
  reason?: string;                   // enumerated where possible ("no-form-fields", "budget-exhausted")
  phaseId?: PhaseId;
}>;
```

---

## 6. Consent semantics

### 6.1 Observations first, states derived

v1's `ConsentInteractionSummary.clicked` conflates "we pressed something" with "the
choice took effect". v2 records the raw verification **observations** (before and
after reload, each phase-tagged) and derives the states from them, so
`reverifiedAfterReload` is machine-checkable rather than asserted:

```ts
type ConsentEvidence = {
  mode: "accept-all" | "reject-all";
  interactionAttempted: boolean;
  controlActivated: boolean;               // a control was actually clicked (v1 `clicked`)

  // The recorded facts: one entry per state read, phase-tagged. An intervention-
  // grade verification has at least one observation in the consent-interaction
  // phase and one in the post-choice-reload phase.
  verificationObservations: Array<{
    phaseId: PhaseId;
    method: string;                        // versioned interpreter id: "tcf-api@1", "onetrust-cookie@1"
    observed: string | null;               // the state read; null = interpreter ran, nothing readable
    consistentWithChoice: boolean | null;  // null when observed is null
  }>;

  // Derived by the shared evaluator from the observations above:
  choiceState: "verified" | "contradicted" | "weak-signal" | "unavailable" | "failed";
  reverifiedAfterReload: boolean;          // true iff a post-choice-reload observation exists and agrees
  verificationFailureReason?: string;      // enumerated: banner-persisted, tcf-unavailable,
                                           // cookie-absent, state-contradicts-choice, ...

  cmp?: string; selector?: string; matchedText?: string; frameUrl?: string;   // carried from v1
};
```

- `verified`: interpreter observations consistent with the choice in both the
  consent-interaction and post-choice-reload phases.
- `contradicted`: any interpreter observation inconsistent with the click.
- `weak-signal`: no interpreter observation; the only evidence is banner dismissal,
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
2. `consent-interaction`: from click attempt to settle, plus the first state read.
3. `post-choice-reload`: a reload under the established consent state, then the
   second state read. **This reload is the measured run for post-choice claims.**
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

The phase-aware records are the v1 records plus `phaseId`; that addition is normative,
the rest of each record's shape carries over from v1 with the string policies of
section 9.4 applied:

```ts
type NetworkRequestRecordV2 = NetworkRequestRecordV1 & { phaseId: PhaseId };   // start phase
type CookieRecordV2         = CookieRecordV1;                                   // names/paths per policy
type StorageRecordV2        = StorageRecordV1;                                  // keys per policy

type RunEvidence = {
  requests: NetworkRequestRecordV2[];
  cookieMutations: CookieMutation[];       // section 7.2
  cookiesFinal: CookieRecordV2[];          // final-jar snapshot
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

## 8. Raw, ephemeral, public: three tiers, one sanitizer

Intersecting a public type with a screenshot field does not enforce deep sanitization,
so the boundary is modeled as tiers with the sanitizer at the only place raw strings
exist:

```ts
// Tier 0: scanner-internal working state. Unsanitized URLs, bodies, jar dumps.
// NEVER serialized, never leaves the scan process. Not part of any schema.
type RawCapture = /* internal to the producer */;

// Tier 0 -> Tier 1: THE sanitizer. Every string crossing this boundary goes
// through the section 9 policies. Its output is ScanRunV2, whose evidence is
// sanitized by construction; there is no unsanitized ScanRunV2.
function sanitizeCapture(raw: RawCapture, policy: RedactionPolicy): ScanRunV2;

// Tier 1 (ephemeral): the immediate-response shells. Sanitized evidence plus an
// explicit ephemeral block; ephemeral extras are grouped, not intersected in.
type EphemeralSingleReport = Omit<PublicSingleReportV2, never> & {
  ephemeral: { screenshot: string | null /* + future immediate-only fields */ };
};
type EphemeralComparisonReport = PublicComparisonReportV2 & {
  ephemeral: { baselineScreenshot: string | null; variantScreenshot: string | null };
};

// Tier 1 -> Tier 2 (public): allowlist projection DROPS the ephemeral block by
// copying named public fields only. Defense in depth, not the sanitizer.
function toPublicScanReport(r: EphemeralSingleReport): PublicSingleReportV2;
function toPublicScanReport(r: EphemeralComparisonReport): PublicComparisonReportV2;
```

- The report store, corpus scripts, exports, and share endpoints accept the public
  **types only**; the immediate scan response is the one surface that may carry the
  ephemeral shells (today's screenshot behavior, made structural).
- The published JSON Schema documents the public types; the ephemeral block is absent
  from it; tier 0 has no schema at all.

---

## 9. Privacy boundary first (redaction v2)

Sequenced **before** durable jobs so the queue never persists what minimization would
have removed. Current state ([lib/report-url.ts](../lib/report-url.ts)): userinfo,
hash, and query values are stripped, but the **path is kept verbatim**, and a URL that
fails to parse is **returned unmodified** (`report-url.ts:26`), which v2 forbids.

### 9.1 URL policy, default-deny

- **Host**: lowercase, IDN to punycode A-label, default port stripped. The registrable
  domain (public-suffix data) always survives. Each subdomain label left of it is
  screened: labels that are long, high-entropy, hex/UUID/base64-shaped, or exceed a
  length cap generalize to `{label}` (`privacy.redaction.subdomainLabelsGeneralized`).
  Tracker evidence keeps its value (`telemetry.example.com` survives;
  `a8f3c9d2e1.telemetry.example.com` becomes `{label}.telemetry.example.com`).
- **Path**: at most N segments (proposal: 6). A segment survives literally **only** if
  it appears in the versioned literal allowlist `routeLiteralAllowlist@<version>`
  (common route words: `products`, `privacy`, `search`, `api`, `docs`; shipped as a
  reviewed data file). Everything else becomes a marker: numeric to `{n}`, all else to
  `{seg}`. No heuristics: a heuristic that passes short lowercase words also passes
  names, health topics, and identifiers.
- **Matrix parameters**: everything from the first `;` in each segment is stripped
  before classification; the parameter name survives only via
  `queryKeyAllowlist@<version>`.
- **Query**: values always dropped; a key survives only via
  `queryKeyAllowlist@<version>` (exact literals plus a small set of reviewed prefix
  rules such as `utm_`), else it becomes `[redacted]`.
- **Malformed input redacts, never passes through**: an unparseable URL becomes
  `{invalid-url}` and increments `privacy.redaction.malformedUrlsDropped`.
- **No public unsalted hashes for token-like values**, anywhere: a hash of a
  low-entropy token is a dictionary lookup away from the token, and a stable hash is
  itself a linkable identifier.

### 9.2 Every persistent or public sink

The same URL policy applies to: `evidence.requests[].url`, **nested provenance URLs**
(`NetworkRequestProvenance.initiatorUrl/scriptUrl/injectedByUrl`), requested/final
URLs and subject origins, `consent.frameUrl`, `privacyPolicy.url`, PageGraph
fact-table rows ([lib/pagegraph-corpus.ts](../lib/pagegraph-corpus.ts)), corpus
exports, share links surfaced in UI, server logs, and any future queued job payload.
One sanitizer, one version number, one test suite.

### 9.3 Names and keys: versioned literal allowlists, no patterns

Pattern-based "safe key" rules (v1's `SAFE_QUERY_KEY_PATTERN`) pass anything
short-and-alphanumeric, which includes user identifiers. v2 replaces every one of them
with **explicit versioned literal allowlists**, shipped as reviewed data files:

- `queryKeyAllowlist@v` (also governs matrix parameter names),
- `cookieNameAllowlist@v` (`_ga`, `OptanonConsent`, ...),
- `storageKeyAllowlist@v` (`theme`, consent-state keys, ...).

Anything not on the list becomes a class marker with shape info
(`[redacted:uuid-like]`, `[redacted:long-token]`), keeping `area`/`valueBytes` for
storage and flags for cookies. Cookie `path` follows the URL path policy; cookie
`domain` follows the host policy.

### 9.4 The public-string registry, exhaustive

The schema documents, for **every** public string field, which policy applies. A field
without a registry row does not ship; adding a public string field requires adding its
policy row in the same change.

| Field | Policy |
|---|---|
| all URL fields incl. nested provenance, subject origins | URL policy (9.1) |
| cookie name / storage key / query and matrix keys | versioned literal allowlists (9.3) |
| cookie path | URL path policy (9.1) |
| `summary.pageTitle` | length cap + control-character strip (bot-wall matching runs before capping) |
| `consent.matchedText` | scanner's own conservative phrase list verbatim only, else marker |
| `consent.cmp`, `consent.selector` | scanner's curated CMP vocabulary and curated selector list literals only; never page-derived |
| tracker labels (`entity`, `category`) | curated catalog / Shields-list vocabulary only |
| detector `reason`, `verificationFailureReason`, quality/comparability reasons | enumerated vocabularies (sections 4.4, 5.3) |
| `warnings` | scanner-vocabulary text only; never page-derived strings |
| privacy-policy quotes (`PrivacyPolicyClaim`) | page-derived by design (the quote is the evidence); bounded sentence-level matches only, length-capped, flagged as quoted material in the schema |
| pixel event names | existing `isSafeEventToken` filter (value-shaped strings rejected) |
| PageGraph / provenance identifiers (`graphRecordId`, `initiatorId`, ...) | opaque producer-generated ids only; embedded URLs through 9.1 |
| `share.path` / `share.jsonPath` and other generated capability paths | producer-generated, contain only the report id; never page-derived |
| fingerprint API names, resource types, methods, encodings | closed vocabularies from the scanner's own instrumentation |

### 9.5 Size limits

Per-field string caps, per-array caps, and a total serialized-report cap, enforced at
build time. Clipping is **capture loss** (`qualityFacts.captureLoss`, family- and
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
type ReadResult =
  | { ok: true; report: StoredScanReport }
  | { ok: false; error: "invalid" | "unsupported-version" | "unsupported-revision" };

function readStoredScanReport(json: unknown): ReadResult;

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
  environment was never fully recorded, so per the unknown rule (3.2) compatibility is
  unprovable. v1-v1 and v1-v2 pairs are `descriptive` at best.
- **Builders stay separate**: the frozen v1 builder types
  ([lib/scan-result-builder.ts](../lib/scan-result-builder.ts), used by the Browser
  Run Worker) are not touched by v2 modules; v2 gets its own builder. The frozen
  producer remains type-safe against frozen types.

### 10.2 Versioning

- `schemaVersion` (major, breaking shape changes) + `schemaRevision` (additive,
  optional-field changes within a major). **Revision literals are pinned in the
  types**: r1 types declare `schemaRevision: 1`, an r2 release ships new types
  declaring `2`. A reader accepts exactly the revisions it was built to understand;
  an unknown revision of a known major returns `unsupported-revision` (10.1), never a
  silent best-effort parse. Forward compatibility is an explicit reader upgrade, not
  an assumption.
- JSON Schema files are **immutable per revision** with revisioned `$id` and filename:
  `https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json`. A stable alias
  (`/scan-report.schema.json`) points at the current revision.
- The detector registry (5.4), metric dependency registry, quality evaluator, and
  comparability evaluator each carry their own version, recorded in the artifacts they
  produce, so results are interpretable after any of them changes.
- **v1 is frozen** (commit 0619050): no fields are added to v1, including the
  previously floated `redactionVersion` marker; that plan is superseded by 15.7.
  v1 changes require a demonstrated leak, crash, documented legacy
  incompatibility, or corpus failure.
- **The r1 freeze is executable**: the published r1 schema's SHA-256
  (`7b865e6903ecdd1ecc2a5d5e848ffb320b7a1db9742dc108f603e5e21c9756a6`) is pinned in
  `scripts/build-schema.mjs` (the build refuses to write a differing generation)
  and asserted byte-for-byte in the parity tests, so editing the r1 types and
  regenerating both files cannot pass.
- **v2 r2** is specified normatively in section 15. r1 arm fields are RETAINED and
  become DERIVED from the structured facts (never replaced); r2 publishes as its
  own immutable file; **the stable alias stays on r1 for the entire foundation
  milestone** and moves only after complete consumer dual-read migration,
  immediately before producer rollout.

### 10.3 Validator and JSON Schema tooling (executable)

- **Source of truth**: the TypeScript types in `lib/` (zero-dep production posture,
  consistent with the aws4fetch precedent).
- **Runtime validator**: one hand-written `lib/` validator for the union, consumed by
  the app and the scripts.
- **Production-safe artifact**: scripts consume a dedicated compiled artifact from a
  `build:schema` step (own tsconfig emitting `dist/schema/`, built in CI before any
  manifest/corpus step), **not** the `.unit-test-dist` test tree.
- **Pages build wiring**: the static Pages build
  ([scripts/build-github-pages.mjs](../scripts/build-github-pages.mjs)) runs in an
  isolated worktree that does not carry `dist/`. Publishing the schema files requires
  either running `build:schema` inside that worktree or copying `dist/schema/` into
  it as an explicit build step; the RFC makes that wiring part of the acceptance of
  implementation step 1, not an afterthought.
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
emit change, redaction ships in the sanitizer while producers still emit v1 wire
(removing data is schema-compatible; v1 gains NO marker field, provenance is
tracked by the sidecar manifest of 15.7), Browser Run stays v1, and the corpus
regenerates organically via the weekly cron with per-site keep-two retention
bridging the transition.

### 10.5 Normative status of named types

Normative in this RFC (shape and semantics fixed for r1): `ScanRunV2` and all its
blocks, `PublicSingleReportV2`, `PublicComparisonReportV2`, the `Experiment` union,
`ArmVerification`, `Comparability` (including the initial `ComparabilityReason` and
`QualityReason` vocabularies), `Quality`/`QualityFacts`, `PrivacyStats`,
`ConsentEvidence`, `SubjectIdentity`, `ConditionVector`, `Fingerprints`, `Toolchain`,
`Provenance`, the `DetectorId` and `MetricFamily` initial sets, the phase model, the
tier model of section 8, and the versioning rules of 10.2.

`ComparisonDiffV2` was originally non-normative; the 2026-07-09 hardening amendment
made it **normative** before schema generation (an unrestricted object in an immutable
r1 schema would have been an open exfiltration boundary). Its definition is the shared
builder `buildComparisonDiffV2` in
[lib/scan-report-v2-evaluators.ts](../lib/scan-report-v2-evaluators.ts): derivable from
the two runs alone, organized per metric family, carrying each family's eligibility;
the reader rejects any diff that does not equal the rebuilt one.

The same amendment made semantic consistency a read-time requirement: structurally
valid v2 whose derived blocks (quality vs qualityFacts, arm outcomes vs observations,
comparability vs the shared evaluator, diff vs the rebuilt diff) disagree with a
recomputation reads as a distinct `inconsistent` error, never as data. The v1 reader
path gained a deep guard (security backport, new module, frozen files untouched) so
malformed uploads fail typed instead of crashing consumers.

Still explicitly **non-normative**: the exact carried-over field lists of `*RecordV1`
inside the phase-aware types (normative requirement: v1 record + `phaseId` where
phase-sensitive, strings re-policed per 9.4); the concrete contents of the allowlist
data files (versioned, reviewed like code); the internal shape of tier-0 `RawCapture`
(never serialized, no schema).

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
   cost), on intervention experiments only. Repeated pairs deferred; evidence strength
   is explicit (4.2) and behavior alerts will require a confirmation run.
5. **Digests**: aggregate manifest digest per run (stored in `toolchain`) + published
   immutable per-list digest manifest, including engine and normalization versions
   (3.4, 3.5).

---

## 12. Normative examples

The contract is coherent only if the types and evaluator produce these results without
exceptions.

### 12.1 Shields off/on while GPC stays enabled: valid intervention pair

- Baseline conditions: `{ gpc: true, shields: "classification", consent: "observe", ... }`
- Variant conditions: `{ gpc: true, shields: "block-simulation", consent: "observe", ... }`
- `experiment = { kind: "intervention", axis: "shields", pairId, order: "AB",
  verification, evidence: { pairs: 1, counterbalanced: false, strength: "observed-difference" } }`
- Fingerprints: `measurementEnvironment` hashes exclude the gpc/shields/consent
  values, and everything else (device, locale, egress, browser, toolchain,
  methodology) matches, so the fingerprints are **equal**. GPC being enabled in both
  runs is a constant, not a delta.
- Verification: baseline `{ axis: "shields", expected: "shields:classification",
  observed: "shields:classification", method: "shields-engine-status@1", outcome:
  "passed" }`; variant expected/observed `"shields:block-simulation"` with a nonzero
  evaluation count, `passed`.
- Both runs run-level complete; adblock manifest digests equal.
- **Result**: `pairValidity.eligible = true`;
  `perMetric["shields-simulation"].eligible = true`; `interventionVerified = true`.
  The report may state an **observed intervention difference**
  (`strength: "observed-difference"`). Strong causal wording still requires
  replicated evidence (`"replicated-difference"`). Under v0.2's model this pair was
  impossible (the measurement fingerprint could never match); that is the
  contradiction v0.3 fixed.

### 12.2 Accept verifies, Reject inconclusive: no post-reject claim

- `experiment = { kind: "intervention", axis: "consent", ... }`
- Baseline (accept-all): observations in both the consent-interaction and
  post-choice-reload phases via `onetrust-cookie@1`, both consistent, so
  `choiceState = "verified"`. Arm outcome `passed`.
- Variant (reject-all): no interpreter observation, banner dismissed, so
  `choiceState = "weak-signal"`. Arm outcome **`inconclusive`**.
- **Result**: `pairValidity.eligible = true` (both runs loaded fine, subjects match,
  axis delta valid); `perMetric["raw-counts"].eligible = true` (descriptive numbers
  render); `perMetric["consent-verification"].eligible = false`
  (`arm-verification-inconclusive:variant`); `interventionVerified = false`.
  **No intervention-attributed claim of any kind** ("kept tracking after you clicked
  Reject all" is suppressed, as is "rejection changed nothing"). The report renders
  descriptive observations and reports the experiment inconclusive with the
  enumerated reason.

### 12.3 Temporal pair across a filter-list update: split eligibility

- Two runs, three weeks apart, equal observed subjects, **equal `condition`
  fingerprints** (same full vector), both run-level complete, baseline chronologically
  first.
- The experiment is a valid `TemporalExperiment` and nothing more:

```jsonc
"experiment": { "kind": "temporal", "pairId": "9f2c..." }
// No axis. No order. No verification. Those fields do not exist on this type.
```

- Between runs, the pinned adblock lists were refreshed:
  `toolchain.adblock.manifestDigest` differs; browser, device, locale, egress,
  methodology, detector versions all match.
- Evaluation:
  - `pairValidity = { eligible: true, reasons: [] }`.
  - `perMetric["raw-counts"] = { eligible: true, reasons: [] }` (its compatibility
    key excludes list digests).
  - `perMetric["shields-simulation"] = { eligible: false, reasons:
    ["dependency-digest-mismatch:adblockManifest"] }` (the published per-list
    manifest identifies which list changed).
  - `interventionVerified` is **absent**: the experiment kind is not intervention.
- **Result**: the diff renders the raw-count temporal delta ("+64 third-party
  requests since Jun 25") and suppresses Shields-derived deltas, explaining why via
  the enumerated reason. No global gate exists to suppress the eligible family.

### 12.4 Descriptive upload: no order, no verification, never causal

Two arbitrary report files uploaded through the "Open report file" UI, paired ad hoc:

```jsonc
"experiment": { "kind": "descriptive", "pairId": "c41a...", "sourceOrder": "as-provided" }
```

- The type requires no AB/BA order and no manipulation checks; those fields do not
  exist on `DescriptiveExperiment`.
- `pairValidity` may pass (same observed subject, both runs complete) or fail
  (subject mismatch); it does not matter for causality: **every causal surface is
  suppressed unconditionally for descriptive experiments**, including
  intervention-attributed framings and temporal "since last scan" language.
- **Result**: side-by-side observations with descriptive family deltas where
  `perMetric[family].eligible`, labeled as a descriptive comparison; no causal
  headline is ever generated regardless of eligibility.

---

## 13. Deferred extensions

- **Signed attestation**: a producer signature over canonical public-report bytes
  would turn self-reported provenance into verifiable provenance. Deferred until key
  management has an owner; the canonicalization rules shipped with v2 are the
  prerequisite and are designed not to preclude it.
- **Repeated pairs / variance estimation**: the intervention experiment shape already
  records `pairs`/`counterbalanced`/`strength`; scheduling replicated pairs waits for
  run-cost data.

## 14. Implementation order

The r1 foundation (freeze, types, schemas, fixtures, union reader, projectors,
integrity evaluators, exhaustive v1 guard, executable schema freeze) **executed
2026-07-09** through commit 0619050. The remaining order:

1. **Normative r2 addendum** (section 15) reviewed and accepted, plus the
   hard-coded r1 hash gate (10.2). No r2 implementation before acceptance.
2. **Separate r2 types and fixtures.** The r1 revision constant and r1 generic
   types are not bumped or redefined.
3. **Separate r2 validator, evaluator, derivations, and adversarial tests.**
4. **Exact reader dispatch** for v2/r1, v2/r2, and `unsupported-revision` for r3+.
5. **Safe r2 projectors and revision-aware views** (r1 marked limited/descriptive
   per 15.6).
6. **Publish the immutable revisioned r2 schema** with independent r1/r2 parity
   and smoke tests. **The stable alias stays on r1.**
7. **Full gate with every producer still emitting legacy v1** (asserted, not
   assumed).
8. **Dual-read consumer migration**: storage/API, uploads, pages, scripts, corpus,
   exports, and UI.
9. **Redaction v2, historical remediation, and the provenance manifest** (sanitizer
   across every persistent sink per section 9; remediation inventory and pass per
   9.6; sidecar redaction-provenance manifest per 15.7).
10. **Verified phased experiments and unified corpus eligibility** (sections 4, 6,
    7; comparability + metric registry consumed by headlines, diffs, temporal
    deltas, stats, exports), with corpus regeneration.
11. **Move the stable schema alias to r2**, only after the complete dual-read gate
    and the phases above.
12. **Controlled r2 producer emission** (Node scanner, compare-reports, CI script,
    PageGraph adapter; Browser Run stays v1 per 11.1). Comparison producers emit
    r2 only once step 10's verified phased experiments exist to populate the
    structured facts; emitting them earlier would mint r2 reports whose mandatory
    semantics nothing can satisfy.

Then the larger phases:

13. Durable queue (inheriting 9.7's constraints).
14. Registrable-domain profiles and watches (opaque watch IDs, encrypted targets).

---

## 15. Revision 2 addendum (normative)

> Status: **r2-a2 DRAFT, 2026-07-09, awaiting review.** Supersedes r2-a1, whose
> methodology contradictions (global replication strength, collector-impossible
> Shields invariant, boolean GPC signals, vacuous consent failure, ungrounded
> banner transitions, optional-vs-mandatory ambiguity) are corrected below. r2
> implementation is gated on this addendum's acceptance (14.1).

### 15.1 Principles and revision policy

- **Additive, precisely defined.** The r2 structural schema is a superset of r1:
  every new block is STRUCTURALLY OPTIONAL, so no r1-shaped payload is
  structurally unrepresentable in r2. Semantic requirements are per revision and
  MAY be stricter: the r2 evaluator makes the new blocks MANDATORY where
  applicable (15.2 for the intervention axis, 15.3/15.4 for consent-mode runs),
  exactly as r1 already requires consent evidence on consent-mode runs. A payload
  is validated against the semantics of its own declared revision, never a
  blend. Removing or incompatibly replacing an r1 field remains a new major.
- **Every r1 field remains present in r2 and becomes derived.** The r2 evaluator
  recomputes each retained r1 field (arm `expected`/`observed`/`outcome`/
  `method`/`phaseId`, consent `choiceState`/`reverifiedAfterReload`, experiment
  `evidence`) from the structured facts below and rejects disagreement on read.
  Asserted strings never outrank facts.
- **r1 stays immutable**, enforced by the executable hash gate (10.2). r2 types
  declare `schemaRevision: 2`; the r1 constant and generic types are untouched.
- **Reader dispatch is exact**: v2 r1 and v2 r2 each validate against their own
  revision; r3+ returns `unsupported-revision`.
- **The stable alias stays on r1** until step 14.11. Producers emit v1 through
  the entire foundation, asserted in tests.

### 15.2 Structured arm facts (`run.verificationFacts`, r2)

```ts
type ScanRunV2R2 = ScanRunV2 & {
  verificationFacts?: {
    gpc?: {
      method: "gpc-header-readback@1";
      // Closed observation states; booleans cannot distinguish absent, false,
      // and read failure (the scanner leaves navigator.globalPrivacyControl
      // ABSENT when GPC is off, it never sets false).
      header: "confirmed-present" | "confirmed-absent" | "unobservable";
      jsSignal: "confirmed-true" | "confirmed-false" | "confirmed-absent" | "read-failed" | "unobservable";
      observedOn: "first-party-navigation" | "all-requests-sample";  // observation scope
      phaseId: PhaseId;
    };
    shields?: {
      method: "shields-engine-status@1";
      engineLoaded: boolean;
      applied: boolean;                 // block simulation actually wired into this run
      requestsEvaluated: number;        // offered to the engine
      requestsMatched: number;          // engine matched a block rule
      requestsActuallyBlocked: number;  // simulation only: cancelled, thus ABSENT from retained evidence
      phaseId: PhaseId;
    };
  };
};
```

Both runs of an intervention pair MUST carry the facts block for the declared
axis (GPC and Shields; consent verifies via 15.3/15.4).

**GPC derivation** of the retained r1 arm fields: `observed = "gpc:on"` iff
`header === "confirmed-present" && jsSignal === "confirmed-true"`;
`observed = "gpc:off"` iff `header === "confirmed-absent"` and `jsSignal` is
`"confirmed-absent"` or `"confirmed-false"`; `observed = null` otherwise (mixed,
failed, or unobservable signals are inconclusive, never rounded up).

**Shields invariants** (the collector REMOVES actually blocked requests from the
public request evidence, so no invariant may equate `requestsActuallyBlocked`
with a count derived from retained requests):

- `requestsActuallyBlocked <= requestsMatched <= requestsEvaluated`;
- `engineLoaded === false` implies `applied === false` and all three counts `0`;
- `applied === false` implies `requestsActuallyBlocked === 0`;
- toolchain reconciliation: `engineLoaded === true` iff `toolchain.adblock !== null`;
- retained-evidence reconciliation: on a `block-simulation` run the retained
  evidence carries zero `blockedByShields` flags (blocked requests never
  completed); on a `classification` run the count of retained requests flagged
  `blockedByShields` equals `requestsMatched`.

**Exact compatibility-summary derivation**: `summary.counts.shieldsBlockedRequests`
equals `requestsMatched` on a classification run and `requestsActuallyBlocked` on
a block-simulation run; it is omitted when `engineLoaded === false`. (This
replaces r1's retained-evidence-only reconciliation for r2 simulation runs.)

**Shields derivation** of the retained r1 arm fields:
`observed = "shields:block-simulation"` iff `engineLoaded && applied`;
`"shields:classification"` iff `engineLoaded && !applied && requestsEvaluated > 0`;
`"shields:off"` iff `!engineLoaded`; `null` otherwise. `outcome` then follows the
generic expected/observed rule; `method` and `phaseId` must equal the facts'.

### 15.3 Consent observation outcomes (r2)

Each `ConsentVerificationObservation` gains a discriminated outcome; the
outcome/code mapping is exact, not advisory:

| `outcome` | `observed` | `errorCode` |
|---|---|---|
| `"read"` | non-null | absent |
| `"unreadable"` | null | absent (interpreter ran; no state present) |
| `"error"` | null | required: `"interpreter-threw"` or `"state-format-unrecognized"` |
| `"timeout"` | null | required: `"api-timeout"` |
| `"unsupported-frame"` | null | required: `"cross-origin-frame-blocked"` |

Any other combination is invalid. The five-state derivation is evaluated in this
precedence order, first match wins:

1. `contradicted`: at least one strong-interpreter `read` inconsistent with the
   choice.
2. `verified`: strong consistent `read`s in BOTH consent phases, control
   activated, no contradiction.
3. `failed`: **at least one recorded strong observation** with outcome
   `error`/`timeout` AND zero strong `read`s (never vacuous: zero strong
   observations derives `weak-signal`/`unavailable` below, not `failed`).
4. `weak-signal`: the grounded banner transition of 15.4.
5. `unavailable`: everything else.

**Singular compatibility fields**: the retained r1 `method` and `phaseId` (arm
verification and any singular consent surface) are those of the earliest
observation that established the derived state, in array order; the observations
array MUST be ordered by `phaseId` then recording time. For `verified` that is
the post-choice-reload `read`; for `contradicted` the first inconsistent `read`;
for `failed` the first `error`/`timeout`; for `weak-signal` the 15.4 transition's
after-interaction observation.

### 15.4 Banner-transition facts (r2)

Phase-tagged observations, not bare booleans:

```ts
consent.bannerTransition?: {
  method: "banner-visibility@1";
  observations: Array<{
    moment: "before-interaction" | "after-interaction" | "after-reload";
    phaseId: PhaseId;                 // moment must agree with the phase kind:
                                      // before/after-interaction in consent-interaction,
                                      // after-reload in post-choice-reload
    visible: boolean;
  }>;
};
```

`weak-signal` derives ONLY when all of: `interactionAttempted === true`,
`controlActivated === true`, the consent-banner detector status is `"complete"`,
and the transition is observed (`before-interaction` visible `true` and
`after-interaction` visible `false`). A disappearance without an activated
control, or weak observations without a transition, derives `unavailable`.

### 15.5 Supporting pairs (r2): replication machinery without replication claims

```ts
experiment.supportingPairs?: Array<{
  pairId: string;
  order: "AB" | "BA";
  baseline: ScanRunV2R2;               // COMPLETE embedded runs, never counters
  variant: ScanRunV2R2;
  verification: { baseline: ArmVerification; variant: ArmVerification };
}>;
```

Uniqueness and matching rules (normative):

- `pairId`s unique across the report and distinct from the primary's; `runId`s
  unique across ALL runs in the report (a run is never reused between pairs).
- Each pair's chronology must match its declared order (the r1 rule, per pair).
- Each supporting pair must match the primary's observed subject, and its
  baseline/variant `condition` fingerprints must equal the primary
  baseline/variant `condition` fingerprints respectively.
- Each supporting pair must pass the SAME evaluator gates as the primary: run
  completeness, exact axis delta, measurement-environment equality (including
  with the primary's runs), and both arms passed with their structured facts.

Derived experiment evidence: `pairs === 1 + supportingPairs.length` and
`counterbalanced === true` iff the orders across all pairs include both AB and
BA. **`strength` remains `"observed-difference"` unconditionally in r2.**
Eligibility is metric-family-scoped and there is no "claimed family" on the
experiment, so a single global strength cannot encode replication; worse, pairs
with opposite effect directions would count. Replicated wording is DEFERRED to a
future revision that defines a metric-scoped effect model (per family:
same-direction, nonzero effects across all pairs, each pair family-eligible).
Until then `"replicated-difference"` stays unrepresentable and rejected, exactly
as in r1; supporting pairs exist so replication can later be derived from
complete evidence, never from counters or metadata.

### 15.6 r1 display status

Stored and uploaded v2 r1 reports stay readable and downloadable, but views mark
them **limited/descriptive**: intervention-attributed and causal surfaces are
suppressed for r1, which lacks the structured facts for authoritative
verification. Asserted r1 strings never regain causal claims. (v1 reports remain
`legacy-derived` and descriptive, per 10.1.)

### 15.7 Redaction provenance (supersedes the withdrawn v1-r2 marker)

v1 is frozen, so no `redactionVersion` field is added to v1. Redaction v2 ships
in the sanitizer while producers still emit v1 wire (14.9); the version becomes
observable on the wire only with v2 emission (`privacy.redactionVersion`).

For v1 reports, provenance is NEVER inferred from scan dates. Managed reports
(committed corpus and R2 share store) get a **sidecar provenance manifest**:
entries keyed by report ID carrying the SHA-256 of the public report bytes and
the redaction version that produced them, written by the remediation pass (9.6)
and by every subsequent managed write. A report whose digest matches its
manifest entry has that entry's redaction version; a missing or mismatched entry,
and every externally uploaded v1 report, is **"redaction version unknown"** and
is treated as unremediated.

---

## Changelog

- **r2-a2 addendum (2026-07-09)**: corrects r2-a1's methodology contradictions
  per review. Replication: `strength` stays `"observed-difference"`
  unconditionally (eligibility is metric-scoped and no claimed family exists;
  opposite-direction effects must not count); supporting pairs must match the
  primary's subject and per-arm condition fingerprints; replicated wording
  deferred to a future metric-scoped effect model. Shields facts split into
  evaluated/matched/actuallyBlocked with `blocked <= matched <= evaluated`,
  toolchain and retained-evidence reconciliation, and an exact
  summary derivation (the collector removes actually blocked requests from
  public evidence, so the r2-a1 invariant was impossible). GPC signals became
  closed observation states with scope (absent vs false vs read-failed are
  distinct). Consent outcome/errorCode mapping is an exact table; `failed`
  requires at least one recorded strong error/timeout (never vacuous);
  precedence and singular method/phaseId selection defined. Banner transitions
  are phase-tagged moment observations gated on an attempted interaction, an
  activated control, and a complete consent detector. Revision policy resolved:
  new blocks are structurally optional, semantically mandatory per revision.
  10.4 and the v1 types header lose the stale v1-r2 redaction marker; 15.7 now
  specifies the sidecar provenance manifest (report ID + public-bytes digest;
  external uploads stay "redaction version unknown"; no date inference).
  Section 14 tail reordered: dual-read consumers, then redaction/remediation/
  manifest, then verified experiments + unified eligibility, then the alias
  move, then controlled producer rollout.
- **r2-a1 addendum (2026-07-09)**: normative revision-2 specification added as
  section 15 (structured GPC/Shields arm facts with exact derivations of the
  retained r1 fields, consent observation outcome/error vocabulary completing the
  five-state derivation, banner-transition facts, supporting-pair shape with
  uniqueness/order rules, replicated claims disabled at publication). 10.2
  corrected: r1 arm fields are retained-and-derived (not replaced), the withdrawn
  v1 `redactionVersion` marker is superseded by 15.7 (v1 is frozen), the r1
  schema freeze is executable via a pinned SHA-256 in the build and tests, and
  the stable alias stays on r1 until after complete dual-read consumer
  migration. Section 14 reordered accordingly (alias move is step 9, after the
  dual-read gate, before producer rollout).
- **v0.3.1 hardening amendment (2026-07-09, post-acceptance, pre-schema)**: closed the
  `diff` boundary (normative `ComparisonDiffV2` + shared builder, rebuilt-and-compared
  on read); deep default-deny structural validation across every nested evidence
  record; semantic reject-on-read (`inconsistent`) for quality, arm outcomes,
  comparability, and diff; deep v1 guard as a security backport; the consumer seam
  (`ReportView`/`RunView`/`ComparisonView`, `LoadedReport`, transport reader replacing
  `payload.ok` sniffing); normalized public strings (closed consent observed states,
  axis-state vocabulary, scanner vocab codes for reason/detail fields, parameterized
  reason validation). No architecture change; scoped by the 2026-07-09 foundation
  review.
- **v0.3.1 (2026-07-09)**: surgical normative corrections per the v0.3 acceptance
  review; no architecture change. `Experiment` became a discriminated union
  (intervention / temporal / descriptive); order, verification, and evidence-strength
  fields exist only on the intervention variant, fixing the type contradiction the
  temporal example exposed. The global `comparable`/`environmentComparable` gate was
  replaced by `pairValidity` (structural) + `perMetric` eligibility +
  `interventionVerified` (intervention-only claim gate), so split eligibility cannot
  be suppressed globally. Quality split into run-level validity and family-level
  censoring so one family's capture loss cannot censor another's metrics. Wire/version
  model finished: `schemaRevision: 1` literals, `unsupported-revision` reader
  behavior, `toolchain` block stores the digests/versions the fingerprints hash,
  normative-vs-non-normative status for every named type (10.5), initial reason and
  detector vocabularies made normative, Pages-worktree schema-build wiring specified.
  Privacy deepened: versioned literal allowlists replace all pattern-based key rules,
  subdomain-label policy added, public-string registry made exhaustive (CMP
  names/selectors, tracker labels, detector strings, capability paths, provenance
  identifiers), raw/ephemeral/public modeled as three tiers with the sanitizer at the
  tier 0 boundary, consent verification stored as phase-tagged before/after-reload
  observations with derived states. Example 12.1 reworded to observed-difference;
  12.3 rebuilt around a typed `TemporalExperiment` meeting the acceptance condition;
  12.4 (descriptive upload) added.
- **v0.3 (2026-07-09)**: three-fingerprint model and unknown rule; per-arm
  verification; metric-scoped eligibility and shared quality evaluator; default-deny
  redaction with field policies; executable versioning/tooling; normative examples;
  narrowed step 1.
- **v0.2 (2026-07-09)**: per-run evidence blocks; condition vector; fingerprint split;
  design union + manipulation check; redaction vs capture loss; requested vs observed
  subjects; consent `choiceState`; phase tags; ephemeral/public split; v1 as distinct
  wire type; softened proof language; tooling; remediation inventory.
- **v0.1 (2026-07-09)**: initial draft.
