# RFC: ScanReport v2, the Verified Experiment Contract

> Status: **v0.3.1 ACCEPTED, 2026-07-09.** Architecture accepted at v0.3; the v0.3.1
> normative corrections landed with green CI (commit f746887, all checks passed), so
> per the acceptance condition this RFC is the implementation contract. Implementation
> follows section 14 without further architecture review. Successor to the v1 schema
> pinned at `SCAN_REPORT_SCHEMA_VERSION = 1` ([lib/types.ts](../lib/types.ts)). The
> durable job queue ([scan-job-model.md](scan-job-model.md)) and domain watchlists are
> explicitly out of scope and sequenced after this contract.
>
> **Implementation receipt, 2026-07-13:** r2 dual-read, validation, redaction,
> comparability gates, stable-schema alias, controlled Node production emission,
> and public R2 persistence are live. Section 14 is retained as the executed
> sequence, not a current to-do list.

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

### 1.2 Frozen HTTP-status compatibility boundary

HTTP status-code syntax is three decimal digits, so an upstream can produce a
syntactically valid 600-999 response. The already-published v2/r1 and v2/r2
schemas are immutable and admit only 100-599. A producer targeting either
frozen wire must never coerce a higher code to 599 or emit a schema-invalid
number.

The r2 compatibility behavior is therefore fail-closed:

- the affected `status` field becomes `null`;
- `qualityFacts.captureLoss` records
  `r2-navigation-status-unrepresentable` or
  `r2-request-status-unrepresentable` in the requests family;
- request markers are phase-scoped and censor request-derived metrics; and
- a navigation marker derives the existing `http-error-status` run failure, so
  the report cannot describe a 600-999 response as a successful load.

Readers continue to reject a literal 600-999 value on an r2 wire. Exact,
first-class preservation in the status fields requires a new schema revision
whose numeric bounds extend through 999; the frozen schema files and hashes are
not changed. Legacy ScanReport v1 is a separate wire and may retain the exact
three-digit observation under its current compatibility reader.

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
                                     // lowercase, IDN as punycode A-label, default port/trailing dot stripped,
                                     // non-allowlisted subdomain labels generalized
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
| `shields-simulation` | the above + adblock manifest digest + engine version + Shields measurement mode |
| `consent-verification` | the above + CMP interpreter versions |
| `detector-findings` | the above + that detector's version |

Eligibility is evaluated **per metric family** (section 4.4): a pair can be temporally
comparable on raw counts while ineligible on Shields metrics, and the diff renders
exactly that. Unknown values in any key follow the unknown rule.

Metric dependency registry `2` adds the Shields measurement mode to that family's
key: classification counts filter-list matches while block simulation counts requests
the engine actually blocked, so those quantities never share a delta. Registry `1`
remains implemented only to validate already-published reports; readers apply the
same mixed-mode refusal as a display safety erratum without rewriting their wire.

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
  order: "AB" | "BA";                // randomized per pair; one pair is not counterbalanced
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
  method: string;                    // versioned: "gpc-header-readback@1", "shields-engine-status@1", "tcf-api@4"
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
  methodologyVersion: string;        // meaning of the numbers; Node records its exact Playwright version here
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

`count` is normally the exact number of omitted observations and a censored
PageGraph request family therefore requires a positive exact count. The one
versioned exception is the request-only PageGraph r2 producer's
`detail: "pagegraph-unsupported"` entry for a family the producer never
attempts to collect: `count: 0` is an explicit unsupported-family sentinel,
not an estimate of zero missing records. Renderers must present that sentinel
as **not captured / unsupported**, never as an observed absence or an
interrupted visit.

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
    method: string;                        // versioned interpreter id: "tcf-api@4", "onetrust-cookie@1"
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
`post-choice-reload` traffic with `choiceState === "verified"`. The flattened
corpus export keeps click dispatch separate from verification:
`consent_choice_state` is the lead run's state (the accept-all arm on consent
comparisons), and `variant_consent_choice_state` is the comparison's variant
arm (reject-all on consent comparisons). Both are null/blank when that arm has
no recorded verifier state; v1 therefore never acquires a derived state.

Comparison rows also carry the pair-level `comparison_decision_mode`,
`compatibility_fingerprint_origin`, and tri-state
`compatibility_fingerprint_matched` verdict. Pair-level comparability never
substitutes for the per-family gates in the linked report. The flattened corpus
deliberately omits the raw baseline/variant digests: the linked full report
already carries them, and repeating stable digests in the corpus adds
linkability and noise without a documented consumer.

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

## 9. Privacy boundary first (current redaction v4)

Sequenced **before** durable jobs so the queue never persists what minimization would
have removed. Current state ([lib/report-url.ts](../lib/report-url.ts)): userinfo,
hash, and query values are stripped, but the **path is kept verbatim**, and a URL that
fails to parse is **returned unmodified** (`report-url.ts:26`), which v2 forbids.

### 9.1 URL policy, default-deny

- **Host**: lowercase, IDN to punycode A-label, trailing dot stripped, and no
  explicit port retained (including non-default ports). IPv4 and IPv6 literals,
  including alternate/obfuscated IPv4 spellings accepted by the URL parser,
  fail closed to `{invalid-host}` / `{invalid-url}` rather than becoming public
  subject or request identity.
  The registrable domain survives only when the pinned public-suffix engine identifies
  an ICANN or private suffix; special-use and suffix-less hosts fail closed. Every
  subdomain label left of the registrable domain survives only through the versioned
  exact-literal allowlist; every other label becomes `{label}`
  (`privacy.redaction.subdomainLabelsGeneralized`). Existing `{label}` markers are
  terminal so repeated public-boundary passes are byte-idempotent.
- **Path**: at most N segments (proposal: 6). A segment survives literally **only** if
  it appears in the versioned literal allowlist `routeLiteralAllowlist@<version>`
  (common route words: `products`, `privacy`, `search`, `api`, `docs`; shipped as a
  reviewed data file). Everything else becomes a marker: numeric to `{n}`, all else to
  `{seg}`. No heuristics: a heuristic that passes short lowercase words also passes
  names, health topics, and identifiers.
- **Matrix parameters**: everything from the first `;` in each segment is stripped
  before classification; the parameter name survives only via
  `queryKeyAllowlist@<version>`.
- **Query**: values always dropped; a key survives only via an exact literal in
  `queryKeyAllowlist@<version>`, else it becomes `[redacted]`. Prefix rules are
  forbidden because an open-ended namespace can carry page- or operator-controlled
  identifiers.
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

Page titles are used transiently for bot-wall detection and then withheld from
the public wire as the required empty-string marker; renderers fall back to the
public domain. Bounded privacy-policy quotes remain deliberate page-derived
evidence in their documented evidence field. Condition metadata, detector labels,
tracker associations, enums, methodology disclosures, and provenance identities
are closed producer-owned vocabularies and may not inherit arbitrary page strings.

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
| `summary.pageTitle` | bot-wall matching before publication, then withheld as the required empty-string marker |
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

Static reports, their sidecars, generated corpus statistics/manifest, and retained
R2 objects form one coordinated predeploy gate. A schema-r2 v3 object is migratable
only when its exact reviewed producer-normalization identity and a digest/clock-
matching v3 sidecar are present. The v3-to-v4 transform preserves report IDs,
run/pair identities, timestamps, and retention clocks; mixed versions or any
ambiguity fail closed. Do not deploy a strict v4 reader between remediating only
one storage plane and the other. Keep writers gated, migrate both planes, require
an idempotent zero-rewrite check, deploy the exact tested SHA, verify readback, and
only then reopen writes.

Remediation emits a separate versioned transition audit for title withholding,
explicit-port removal, and IP-literal rejection. Those migration-only counts are
not representable in the frozen public `PrivacyStats.redaction` vocabulary and
must not be relabeled as one of its seven legacy counters. Static and R2 dry-run
counts must match their corresponding apply receipts; the final fixed-point check
must report zero transition counts.

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
- Comparability evaluator `2` requires both requested controls to have been activated
  before a consent intervention is pair-valid. Evaluator `1` remains implemented only
  for exact validation of historical reports; readers apply the same missing-control
  refusal as a display safety erratum without rewriting their wire.
- **v1 is frozen** (commit 0619050): no fields are added to v1, including the
  previously floated `redactionVersion` marker; that plan is superseded by 15.8.
  v1 changes require a demonstrated leak, crash, documented legacy
  incompatibility, or corpus failure.
- **The r1 freeze is executable**: the published r1 schema's SHA-256
  (`018584cefeebedfe2d17ba0117216257865637fc23ba7aafbf2092fee2898821`) is pinned in
  `scripts/build-schema.mjs` (the build refuses to write a differing generation)
  and asserted byte-for-byte in the parity tests, so editing the r1 types and
  regenerating both files cannot pass.
- **v2 r2** is specified normatively in section 15. r1 arm fields are RETAINED and
  become DERIVED from the structured facts (never replaced); r2 publishes as its
  own immutable file. The complete dual-read gate has passed, so the stable alias
  now points to r2; immutable r1 remains revision-addressable for historical
  reports, and the alias move itself rewrites no stored artifact.

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
tracked by the sidecar manifest of 15.8), Browser Run stays v1, and the corpus
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
4. **AB/BA**: order is randomized from the first v2 experiment release (no added
   scan cost), on intervention experiments only. A single pair is not counterbalanced;
   only aggregated independent pairs covering both AB and BA orders are. Evidence
   strength is explicit (4.2) and behavior alerts require replicated evidence.
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
- **Result under metric registry 2**: `pairValidity.eligible = true`;
  `perMetric["shields-simulation"] = { eligible: false, reasons:
  ["dependency-version-mismatch:shieldsMode"] }`; `interventionVerified = true`.
  Like-for-like raw-count families may state an **observed intervention difference**
  (`strength: "observed-difference"`), but each arm's Shields measurement stays
  per-run evidence under its own label and the two values never form a delta. Strong
  causal wording still requires replicated evidence (`"replicated-difference"`).

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
2026-07-09** through commit 0619050. Steps 1-12 below subsequently executed and
are retained as the implementation receipt and ordering invariant:

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
   9.6; sidecar redaction-provenance manifest per 15.8).
10. **Verified phased experiments and unified corpus eligibility** (sections 4, 6,
    7; comparability + metric registry consumed by headlines, diffs, temporal
    deltas, stats, exports), with corpus regeneration.
11. **Move the stable schema alias to r2**, only after the complete dual-read gate
    and the phases above.
12. **Controlled r2 producer emission** (Node scanner, compare-reports, CI
    script, and the paired PageGraph GraphML + metadata importer). Browser Run
    stays v1 per 11.1. The PageGraph importer moved to request-only r2 after a
    representative Brave Nightly capture and exact versioned metadata contract
    supplied mandatory conditions, provenance, one passive phase, detector
    ledger, and quality facts; unsupported evidence families are explicit
    `pagegraph-unsupported` sentinels. Comparison producers emit r2 only once step 10's
    verified phased experiments exist to populate the structured facts; emitting
    them earlier would mint r2 reports whose mandatory semantics nothing can satisfy.

Larger follow-on phases:

13. Durable jobs (inheriting 9.7's constraints): fenced execution leases,
    bounded replay, staging fault canaries, and IDs-only recovery are
    implemented. Production activation remains an operator gate.
14. Registrable-domain profiles and opaque encrypted scheduled rescans are
    implemented behind fail-closed durability/readiness and feature gates.
    Production activation remains sequenced after the durable-job canaries.

---

## 15. Revision 2 addendum (normative)

> Status: **r2-a4 ACCEPTED, 2026-07-10.** a4 applies the final four surgical
> corrections from the a3 review (optional discriminated observation result
> block, Shields facts phaseId, non-contradictory zero-observation consent
> semantics, and a storage-accurate redaction-manifest contract); everything
> else was accepted at a3. Implementation proceeds in slices: types and
> fixtures first, validator/evaluator next; readers, consumers, producers,
> historical data, and the stable alias do not move during the types slice.

### 15.1 Principles and revision policy

- **Additive, precisely defined.** The r2 structural schema is a superset of r1:
  every new block is STRUCTURALLY OPTIONAL, so no r1-shaped payload is
  structurally unrepresentable in r2. Semantic requirements are per revision and
  MAY be stricter: the r2 evaluator makes the new blocks MANDATORY where
  applicable (15.3 for the intervention axis, 15.4 for consent-mode runs),
  exactly as r1 already requires consent evidence on consent-mode runs. A payload
  is validated against the semantics of its own declared revision, never a
  blend. Removing or incompatibly replacing an r1 field remains a new major.
- **Every r1 field remains present in r2 and becomes derived.** The r2 evaluator
  recomputes each retained r1 field (arm `expected`/`observed`/`outcome`/
  `method`/`phaseId`, consent `choiceState`/`reverifiedAfterReload`, observation
  `consistentWithChoice`, experiment `evidence`) from the structured facts below
  and rejects disagreement on read. Asserted strings never outrank facts.
- **r1 stays immutable**, enforced by the executable hash gate (10.2). r2 types
  declare `schemaRevision: 2`; the r1 constant and generic types are untouched.
- **Reader dispatch is exact**: v2 r1 and v2 r2 each validate against their own
  revision; r3+ returns `unsupported-revision`.
- **The stable alias now points to r2** after step 14.11. Immutable r1 remains
  available for historical reports; producer rollout is a separate boundary.

### 15.2 The r2 wire-type graph (complete)

Intersection on `ScanRunV2` alone cannot change nested consent evidence, so the
graph is explicit, `Omit`-based, and total; these are the only r2 wire types:

```ts
// Structurally OPTIONAL so r1 payloads stay structurally representable (15.1);
// the r2 evaluator makes it MANDATORY on every observation that is present in
// an r2 consent run. Discriminated: each outcome pins its allowed code.
type ConsentObservationResultR2 =
  | { outcome: "read"; sequence: number }
  | { outcome: "unreadable"; sequence: number }
  | { outcome: "error"; sequence: number; errorCode: "interpreter-threw" | "state-format-unrecognized" }
  | { outcome: "timeout"; sequence: number; errorCode: "api-timeout" }
  | { outcome: "unsupported-frame"; sequence: number; errorCode: "cross-origin-frame-blocked" };

type ConsentVerificationObservationR2 = ConsentVerificationObservation & {
  result?: ConsentObservationResultR2;   // 15.4: optional in the schema, required by the evaluator
};

type ConsentEvidenceR2 = Omit<ConsentEvidence, "verificationObservations"> & {
  verificationObservations: ConsentVerificationObservationR2[];
  bannerTransition?: BannerTransitionR2;          // 15.5
};

type RunEvidenceR2 = Omit<RunEvidence, "consent"> & { consent?: ConsentEvidenceR2 };

type ScanRunV2R2 = Omit<ScanRunV2, "evidence"> & {
  evidence: RunEvidenceR2;
  verificationFacts?: {                            // 15.3
    gpc?: GpcVerificationFactsR2;
    shields?: ShieldsVerificationFactsR2;
  };
};

// supportingPairs exist ONLY on intervention experiments (15.6); temporal and
// descriptive experiments are reused unchanged.
type InterventionExperimentR2 = InterventionExperiment & { supportingPairs?: SupportingPairR2[] };
type ExperimentR2 = InterventionExperimentR2 | TemporalExperiment | DescriptiveExperiment;

type PublicSingleReportV2R2 = Omit<PublicSingleReportV2, "schemaRevision" | "run"> & {
  schemaRevision: 2;
  run: ScanRunV2R2;
};
type PublicComparisonReportV2R2 = Omit<
  PublicComparisonReportV2,
  "schemaRevision" | "baseline" | "variant" | "experiment"
> & {
  schemaRevision: 2;
  baseline: ScanRunV2R2;
  variant: ScanRunV2R2;
  experiment: ExperimentR2;
};
type PublicScanReportV2R2 = PublicSingleReportV2R2 | PublicComparisonReportV2R2;

type EphemeralSingleReportR2 = PublicSingleReportV2R2 & {
  ephemeral: { screenshot: string | null };
};
type EphemeralComparisonReportR2 = PublicComparisonReportV2R2 & {
  ephemeral: { baselineScreenshot: string | null; variantScreenshot: string | null };
};
```

### 15.3 Structured arm facts (`run.verificationFacts`)

```ts
type GpcVerificationFactsR2 = {
  method: "gpc-header-readback@1";
  header: "confirmed-present" | "confirmed-absent" | "unobservable";
  jsSignal: "confirmed-true" | "confirmed-false" | "confirmed-absent" | "read-failed" | "unobservable";
  observedOn: "first-party-navigation";  // the only scope in r2 (see below)
  phaseId: PhaseId;
};

type ShieldsVerificationFactsR2 = {
  method: "shields-engine-status@1";
  engineLoaded: boolean;
  applied: boolean;
  requestsEvaluated: number;        // nonnegative integers, all three
  requestsMatched: number;
  requestsActuallyBlocked: number;
  phaseId: PhaseId;                 // the passive-load phase of the engine-status observation
};
```

Both runs of an intervention pair MUST carry the facts block for the declared
axis (GPC and Shields; consent verifies via 15.4/15.5).

**GPC sampling semantics (closed).** r2 permits only `"first-party-navigation"`:
the signals are read on an observed eligible first-party navigation, and the
facts' `phaseId` must reference a `passive-load` phase containing one. If no
eligible navigation was observed, both signals are `"unobservable"`; a
`confirmed-*` state without one is invalid. (A sampled multi-request scope may
return in a later revision with explicit inspected/present/absent counts and a
mixed-results-derive-inconclusive rule; it is out of r2.)

**GPC derivation**: `observed = "gpc:on"` iff `header === "confirmed-present" &&
jsSignal === "confirmed-true"`; `observed = "gpc:off"` iff `header ===
"confirmed-absent"` and `jsSignal` is `"confirmed-absent"` or
`"confirmed-false"`; `observed = null` otherwise. Mixed, failed, or unobservable
signals are inconclusive, never rounded up.

**Shields invariants** (the collector REMOVES actually blocked requests from the
public request evidence, so no invariant may equate `requestsActuallyBlocked`
with a count derived from retained requests):

- all three counters are nonnegative integers, with
  `requestsActuallyBlocked <= requestsMatched <= requestsEvaluated`;
- `engineLoaded === false` implies `applied === false` and all three counters `0`;
- `applied === false` implies `requestsActuallyBlocked === 0`;
- toolchain reconciliation: `engineLoaded === true` iff `toolchain.adblock !== null`;
- retained-evidence reconciliation: on a `block-simulation` run the retained
  evidence carries zero `blockedByShields` flags; on a `classification` run the
  count of retained requests flagged `blockedByShields` equals `requestsMatched`.

**Exact compatibility-summary derivation**: `summary.counts.shieldsBlockedRequests`
equals `requestsMatched` on a classification run and `requestsActuallyBlocked` on
a block-simulation run; it is omitted when `engineLoaded === false`.

**Shields derivation (nonzero exercise required)**:
`observed = "shields:block-simulation"` iff `engineLoaded && applied &&
requestsEvaluated > 0`; `"shields:classification"` iff `engineLoaded && !applied
&& requestsEvaluated > 0`; `"shields:off"` iff `!engineLoaded`; `observed =
null` otherwise. An engine that evaluated nothing verified nothing: `applied`
with zero evaluations is inconclusive, never a pass. The facts' `phaseId` must
reference a `passive-load` phase (the engine-status observation). `outcome` then
follows the generic expected/observed rule; the retained arm's `method` and
`phaseId` must equal the facts'.

### 15.4 Consent observation outcomes (total derivation)

The observations array itself keeps its r1 structure and MAY be empty (an
interaction that produced no interpreter reads is representable). Every
observation that IS present in an r2 consent run must carry the `result` block
of 15.2 (structurally optional, semantically mandatory per 15.1); the array
MUST be ordered by `(phaseId, result.sequence)`, `sequence` values are unique
within the evidence, and "earliest" below means exactly that order. The
outcome/code mapping is the discriminated union itself: `"read"` iff `observed`
is non-null; `error`/`timeout`/`unsupported-frame` pin their `errorCode`;
`"unreadable"` and `"read"` carry none.

Derived fields, all of them:

- `consistentWithChoice` derives per observation: for outcome `"read"`,
  `deriveObservationConsistency(mode, observed)` (accept-all reads
  `accepted-all` as `true`, reject-all reads `rejected-all` as `true`,
  `partial` as `false`, `unknown` as `null`); for every other outcome, `null`.
- `choiceState` derives by precedence, first match wins:
  1. `contradicted`: at least one strong-interpreter `read` inconsistent with
     the choice.
  2. `verified`: strong consistent `read`s in BOTH consent phases, control
     activated, no contradiction.
  3. `failed`: at least one recorded strong observation with outcome
     `error`/`timeout`. (Not vacuous: zero strong observations cannot derive
     `failed`. And total: a successful interaction-phase read followed by a
     reload timeout derives `failed`, because `verified` did not match and a
     strong timeout is recorded.)
  4. `weak-signal`: the grounded banner transition of 15.5.
  5. `unavailable`: everything else.
- `reverifiedAfterReload` derives as: a strong observation exists in a
  `post-choice-reload` phase with outcome `"read"` and
  `consistentWithChoice === true`. **Decision:** it is retained as exactly that
  reload-agreement fact and MAY be `true` on an overall `contradicted` run
  (interaction contradicted, reload agreed). It is never a verification
  surface: `choiceState` is the only verification signal, and UI code must
  never treat `reverifiedAfterReload` alone as verification.
- **Singular compatibility fields** (arm `method`/`phaseId`): those of the
  earliest observation that established the derived state (`verified`: the
  post-choice-reload read; `contradicted`: the first inconsistent read;
  `failed`: the first error/timeout; `weak-signal`: the 15.5
  after-interaction observation). For `unavailable` with recorded
  observations: the earliest observation of any outcome. With ZERO
  observations, no interpreter ran and none is fabricated: the closed
  placeholder method `"consent-verification-unavailable@1"` is used with
  `phaseId` = the run's `consent-interaction` phase (which every consent-mode
  run has). The placeholder is a compatibility value only; it never appears on
  an observation.
- **Interpreter compatibility key**: the sorted unique set of ALL attempted
  strong interpreter method strings across the run's observations, regardless
  of outcome (an attempt that timed out still names the interpreter that ran).
  The two arms' sets must be equal, and every supporting pair's set must equal
  the primary's; a mismatch is `dependency-version-mismatch:consent-interpreter`.
  An EMPTY set is an unknown dimension (`unknown-dimension:consent-interpreter`):
  two runs that attempted nothing never establish consent-verification
  compatibility.

### 15.5 Banner-transition facts (unambiguous)

```ts
type BannerTransitionR2 = {
  method: "banner-visibility@1";
  observations: Array<{
    moment: "before-interaction" | "after-interaction" | "after-reload";
    phaseId: PhaseId;      // before/after-interaction: a consent-interaction phase;
                           // after-reload: a post-choice-reload phase
    atMs: number;          // must lie inside the referenced phase's span
    visible: boolean;
  }>;
};
```

Structural rules: at most ONE observation per moment; duplicate moments reject.
Chronology: `before-interaction.atMs < after-interaction.atMs`, and when
`after-reload` is present it is later still; each `atMs` must lie inside its
phase's span. `weak-signal` requires EXACTLY one `before-interaction` and
exactly one `after-interaction` observation with the transition observed
(`visible: true` then `visible: false`), plus `interactionAttempted === true`,
`controlActivated === true`, and a `"complete"` consent-banner detector. A
disappearance without an activated control, or observations without the
transition, derive `unavailable`.

### 15.6 Supporting pairs: replication machinery without replication claims

```ts
type SupportingPairR2 = {
  pairId: string;
  order: "AB" | "BA";
  baseline: ScanRunV2R2;               // COMPLETE embedded runs, never counters
  variant: ScanRunV2R2;
  verification: { baseline: ArmVerification; variant: ArmVerification };
};
```

`supportingPairs` exists only on `InterventionExperimentR2` (15.2). Uniqueness
and matching rules (normative):

- `pairId`s unique across the report and distinct from the primary's; `runId`s
  unique across ALL runs in the report (a run is never reused between pairs).
- Each pair's chronology must match its declared order (the r1 rule, per pair).
- Each supporting pair must match the primary's observed subject, and its
  baseline/variant `condition` fingerprints must equal the primary
  baseline/variant `condition` fingerprints respectively.
- Each supporting pair must pass the SAME evaluator gates as the primary: run
  completeness, exact axis delta, measurement-environment equality (including
  with the primary's runs), both arms passed with their structured facts, and
  for consent, the interpreter compatibility key of 15.4.

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

The additive analysis contract in
[`research-evidence-model.md`](research-evidence-model.md) now derives bounded,
metric-scoped repeated observations without changing this frozen wire. It
fails a metric closed when any recorded pair is ineligible and keeps every
inferential, replicated-effect, and causal claim disabled until a separately
bound sampling and analysis design exists.

### 15.7 r1 display status

Stored and uploaded v2 r1 reports stay readable and downloadable, but views mark
them **limited/descriptive**: intervention-attributed and causal surfaces are
suppressed for r1, which lacks the structured facts for authoritative
verification. Asserted r1 strings never regain causal claims. (v1 reports remain
`legacy-derived` and descriptive, per 10.1.)

### 15.8 Redaction provenance manifest (supersedes the withdrawn v1-r2 marker)

v1 is frozen, so no `redactionVersion` field is added to v1. Redaction v2 ships
in the sanitizer while producers still emit v1 wire (14.9); the version becomes
observable on the wire only with v2 emission (`privacy.redactionVersion`).

For v1 reports, provenance is NEVER inferred from scan dates. Managed reports
(the committed corpus and the **Cloudflare R2 object storage** share store,
"R2" the storage product, not schema revision r2) get a sidecar provenance
manifest with one entry per report:

```ts
type RedactionProvenanceEntry = {
  reportId: string;
  /** sha256 hex over the CANONICAL JSON of the public report (3.2 rules). */
  publicDigest: string;
  canonicalizationVersion: string;     // versions the digesting itself
  redactionVersion: number;            // the sanitizer that produced these bytes
  writtenAt: string;                   // manifest write / remediation timestamp
  createdAt: string;                   // ORIGINAL creation, copied from the object
  expiresAt: string | null;            // ORIGINAL expiry; null for committed reports
};
```

Contract (written for the storage that actually exists: R2 writes today store
only a content type, and a report write plus a sidecar write is NOT atomic):

- **Location**: one sidecar per report, beside it. R2 object storage:
  `<reportKey>.provenance.json` in the same bucket. Committed corpus:
  `public/reports/<id>.provenance.json` (outside the report-file id pattern, so
  corpus tooling never confuses it for a report).
- Digesting uses the canonical JSON rules of 3.2 (sorted keys, NFC, no
  insignificant whitespace), so formatting differences between storage backends
  cannot break matching; `canonicalizationVersion` pins those rules.
- **Failure ordering**: report first, sidecar second, no atomicity assumed. A
  report matches its sidecar iff the recomputed `publicDigest` equals the
  stored one; until a matching sidecar exists, provenance is UNKNOWN and the
  report is treated as unremediated. A crash between the two writes therefore
  fails safe (toward re-remediation, never toward false provenance).
- **Runtime retention metadata**: from the redaction milestone on, every NEW
  runtime share write stores `createdAt`/`expiresAt` as R2 custom metadata at
  creation time (today's writes do not), so rewrites can preserve the original
  clock verbatim.
- **Write-before-known**: reports written before the manifest existed have no
  sidecar and are "redaction version unknown", treated as unremediated until
  the remediation pass (9.6) handles them. Every subsequent managed write (new
  scan, remediation rewrite) upserts the sidecar right after the report.
- **Bootstrap rule for legacy shares**: a runtime R2 share whose original
  retention clock cannot be recovered (no custom metadata, predates the
  manifest) is DELETED during remediation rather than rewritten; rewriting
  would restart its storage timestamps and silently extend a share that was
  due to expire. Committed corpus reports are exempt (git history preserves
  their dates and they carry no expiry) and are rewritten and backfilled
  normally.
- **Retention preservation**: `createdAt`/`expiresAt` are copied from the
  original custom metadata and preserved verbatim through every rewrite; the
  manifest is never an input to retention decisions, and a sidecar never
  extends or restarts a report's lifetime.
- **Lifecycle and pruning**: when a managed report is pruned or expires, its
  sidecar is deleted in the same operation; a dangling sidecar (no report) is
  invalid and removed by the next remediation pass.
- Externally uploaded v1 reports never get sidecars and remain
  **"redaction version unknown"**.

---

## Errata

- **E1 (2026-07-10, published erratum; 1.0 disposition no-r3-for-1.0 approved 2026-08-02)**: two
  descriptions in the PUBLISHED v2 r1 and r2 schemas overstate the pixel
  identifier handling. The `PixelMatchField` description states detection is
  "by parameter-key presence only: the scanner never reads, decodes, or
  stores the (usually hashed) value", and the advanced-matching array field's
  own description repeats "detected by key presence only". The decoder
  actually requires the identifier parameter to carry a NON-EMPTY value, so
  the value is inspected transiently in memory for that emptiness test (query
  values are URL-decoded and JSON bodies parsed on the way). It is never
  persisted, exposed, semantically interpreted, or hash-validated; only the
  category label is stored. The published r1/r2 schema files are immutable
  (10.2: hash-pinned, byte-for-byte parity-tested), so the wording is
  corrected here and in the runtime copy (lib/pixel-events.ts, README,
  glossary). This published erratum is the terminal correction for those
  existing revisions. Any future revision that carries these descriptions
  must declare the corrected prose in its own types. Under the approved
  disposition, creating that revision is not a 1.0 requirement and
  never rewrites the frozen files.

- **E2 (2026-07-20, published erratum; 1.0 disposition no-r3-for-1.0 approved 2026-08-02)**: the
  published v2 r1 and r2 schemas describe `InterventionExperiment.order` as
  "Counterbalanced across pairs from the first v2 release." That conflates a
  pair's randomized execution order with counterbalancing. `AB` means the
  baseline ran first and `BA` means the variant ran first. A single pair is
  randomized, not counterbalanced; only independent pairs covering both orders
  support `evidence.counterbalanced: true`. The published r1/r2 schema files
  remain byte-for-byte unchanged under the freeze. The recommended pending
  1.0 disposition treats this published erratum as the correction; a future
  revision may carry the corrected description, but r3 would be deferred to
  the 1.1 evidence-package design rather than created solely to restate this
  correction.

- **E3 (2026-07-20, fixed by metric dependency registry 2)**: registry 1 omitted
  the Shields measurement mode from the `shields-simulation` compatibility key,
  allowing a classification arm's filter-list matches to be subtracted from a block
  simulation arm's actually blocked requests. Registry 2 refuses that family with
  `dependency-version-mismatch:shieldsMode`. Historical registry-1 reports remain
  byte-for-byte readable under their recorded evaluator; the reader decision layer
  independently suppresses the mixed-mode Shields delta.

- **E4 (2026-07-20, fixed by comparability evaluator 2)**: evaluator 1 did not
  require both requested consent controls to have been activated before treating the
  visits as a pair, so raw-count and other family deltas could render when one arm was
  still pre-consent. Evaluator 2 marks that design invalid and denies every pair-level
  delta while retaining both runs as raw evidence. Historical evaluator-1 reports
  remain readable; the reader decision layer applies the same refusal when a recorded
  consent arm lacks an activated control.

- **E5 (2026-07-20, fixed by `tcf-api@2` and `consent-r2-v2`)**: the first TCF
  interpreter projected only Purposes 1–10 and treated empty or zero-grant
  purpose-consent vectors as reject-all even though TCF records legitimate-interest
  state and publisher restrictions separately. `tcf-api@2` projects Purpose 11 and
  classifies only a multi-purpose unanimous grant; mixed, empty, zero-grant, and
  single-purpose vectors remain `unknown` rather than fabricating a verification or
  contradiction. Readers retain `tcf-api@1` for historical validation, but the exact
  attempted-interpreter-set compatibility key refuses an `@1`/`@2` consent delta. New
  producer output also records methodology component `consent-r2-v2`, preventing any
  pre/post-change metric family from comparing as the same measurement instrument.

- **E6 (2026-07-20, fixed by `tcf-api@3` and `consent-r2-v3`)**: `tcf-api@2`'s
  conservative zero-grant rule avoided the fabricated reject-all result described in
  E5, but also made a real reject-all registration unreachable and hid a reject click
  that retained legitimate-interest grants. `tcf-api@3` projects both
  `purpose.consents` and `purpose.legitimateInterests` for Purposes 1–11 without
  retaining raw TCData. It classifies only settled, GDPR-applicable reads whose two
  vectors expose the same multi-purpose key set: every purpose enabled under either
  legal basis is `accepted-all`, every purpose disabled under both bases is
  `rejected-all`, and any other complete pair is `partial`; absent, asymmetric,
  unsettled, or single-purpose state remains `unknown`. Thus a legitimate-interest
  grant retained after a reject click is detectable as a contradiction without
  treating a consent/legitimate-interest split as a failed accept registration.
  Readers retain `tcf-api@1` and `tcf-api@2` for historical validation, while the
  exact attempted-interpreter-set compatibility key refuses cross-version consent
  deltas. New producer output records methodology component `consent-r2-v3`, so the
  projection change cannot compare as the same measurement instrument.

- **E7 (2026-07-20, fixed by `tcf-api@4` and `consent-r2-v4`)**: `tcf-api@3`
  collapsed purpose consent and legitimate-interest flags into one enabled vector.
  A first-layer Reject all can lawfully withdraw every consent while leaving the
  separately managed legitimate-interest objection state unchanged, so that mapping
  could publish `contradicted` against the requested choice. It also omitted the
  vendor-specific `publisher.restrictions` that the TCF requires consumers to apply
  before legal-basis signals. `tcf-api@4` projects restrictions only as the bounded,
  non-identifying summary `none | present | unknown`. An all-consent-false vector with
  any retained legitimate interest is now `unknown`, never `partial` or
  `accepted-all`; both legal-basis vectors unanimously false remain `rejected-all`.
  Present or malformed restrictions make every other purpose-only conclusion
  `unknown`, because applying them requires vendor declarations and the matching GVL,
  neither of which this privacy-minimizing interpreter retains. Historical methods
  remain readable, exact interpreter-set matching refuses cross-version deltas, and
  new output carries `consent-r2-v4` in its methodology identity.

## Changelog

- **r2-a6 addendum (2026-07-20, ACCEPTED)**: makes the TCF interpreter
  publisher-restriction-aware and prevents retained legitimate interest after a
  first-layer Reject all from becoming a fabricated contradiction. `tcf-api@4`
  retains only a bounded restriction-presence summary, returns `unknown` where
  vendor/GVL interpretation or the separate LI objection state is required, and
  records `consent-r2-v4` so older and newer instruments cannot compare silently.
- **r2-a5 addendum (2026-07-20, ACCEPTED)**: documents the complete TCF
  dual-legal-basis projection introduced by `tcf-api@3`: identical multi-purpose
  consent and legitimate-interest key sets are required before classification;
  every purpose enabled under either legal basis maps to `accepted-all`, every
  purpose disabled under both bases maps to `rejected-all`, other complete pairs
  map to `partial`, and incomplete or ambiguous state stays `unknown`. Historical `tcf-api@1` and
  `tcf-api@2` observations remain readable but cannot compare across interpreter
  sets, and new output carries `consent-r2-v3` in its methodology identity.
- **r2-a4 addendum (2026-07-10, ACCEPTED)**: four surgical corrections per the
  a3 review. Observation `sequence`/`outcome` moved into an optional
  discriminated `result` block so the r2 schema stays a structural superset
  (the evaluator requires the block on every present observation).
  `ShieldsVerificationFactsR2` gains `phaseId`, constrained to the passive-load
  engine-status observation. Zero-observation consent made non-contradictory:
  the array may be empty while present observations require their result
  block; the zero-observation compatibility method is the closed placeholder
  `consent-verification-unavailable@1` (banner-visibility is never fabricated);
  the interpreter compatibility key is the sorted unique set of ALL attempted
  strong interpreter versions with the empty set following the unknown rule;
  `reverifiedAfterReload` is explicitly retained as reload-agreement only (may
  be true on a contradicted run, never a verification surface). 15.8 rewritten
  against real storage: per-report sidecar locations, report-first
  sidecar-second failure ordering with provenance unknown until digests match,
  custom retention metadata required on new runtime shares, sidecar lifecycle
  and pruning, and legacy runtime shares whose retention clock cannot be
  recovered are deleted rather than rewritten.
- **r2-a3 addendum (2026-07-10)**: the final narrow specification pass per
  review. Complete Omit-based r2 wire-type graph (observation, consent
  evidence, run evidence, run, experiments with supportingPairs restricted to
  interventions, public and ephemeral reports). Consent derivation made total:
  wire-level `sequence` ordering, explicit `consistentWithChoice` and
  `reverifiedAfterReload` derivations, `failed` on any recorded strong
  error/timeout (so a reload timeout after a good interaction read is failed,
  not unavailable, and never vacuous), singular method/phaseId defined for
  `unavailable` and the zero-observation case, structurally-optional-but-
  semantically-mandatory stated, and the CMP-interpreter compatibility key
  added between arms and supporting pairs. Shields block-simulation requires
  nonzero evaluations (zero-exercise is inconclusive) and counters are
  nonnegative integers. GPC r2 permits only first-party-navigation scope with
  an observed eligible navigation and passive-load phase constraint (sampled
  scope deferred with counts and a mixed-inconclusive rule). Banner
  transitions: at most one observation per moment, in-span `atMs` timestamps,
  strict before < after (< reload) chronology, weak-signal requires exactly
  one before and after. 15.8 finishes the redaction-manifest contract
  (canonical-JSON digesting with its own version, redaction version,
  write/remediation timestamp, preserved original creation/expiry,
  write-before-known behavior, retention non-interference, pruning, and
  explicit "Cloudflare R2 object storage" naming).
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
