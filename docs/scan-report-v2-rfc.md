# RFC: ScanReport v2, the Verified Experiment Contract

> Status: **DRAFT for review, 2026-07-09. Design only; no implementation ships from this
> document.** Successor to the v1 schema pinned at `SCAN_REPORT_SCHEMA_VERSION = 1`
> ([lib/types.ts](../lib/types.ts)). The durable job queue
> ([scan-job-model.md](scan-job-model.md)) and domain watchlists are explicitly out of
> scope and sequenced after this contract.

## Goal

One sentence: **a sanitized report that can prove whether two runs are comparable and
whether an intervention actually took effect.**

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

v2 makes comparability and intervention effect first-class, machine-checkable fields,
and hardens the privacy boundary before any queue or retention layer persists more data.

## Non-goals

- No durable queue, watchlists, scheduled monitoring, or alert channels (later phases).
- No new detectors and no change to what the scanner observes.
- No raw-request archive; the origin+path scrub posture tightens, never loosens.

---

## 1. Core identities

Four separate concepts, never conflated. The first three are declared inputs; the
fourth is an evaluated output.

### 1.1 `subjectKey`, what was scanned

```ts
subjectKey: {
  registrableDomain: string;   // eTLD+1 of the FINAL url ("example.co.uk")
  routeShape: string;          // privacy-safe path shape of the final URL ("/products/{seg}")
}
```

- Derived from the **final** URL (redirects resolve the subject: australia.gov.au is
  a my.gov.au scan, as the corpus already learned).
- `routeShape` comes from the redaction layer (section 4), so the subject key is safe
  to publish, index, and use as the future watchlist key.
- Two runs can only ever be compared when their `subjectKey`s are equal.

### 1.2 `environmentFingerprint`, how the scanner was configured

A canonical, exhaustively enumerated object plus its digest:

```ts
environment: {
  producer: "node-playwright" | "browser-run-worker" | "ci-workflow" | "pagegraph-import";
  buildCommit: string;              // git SHA of the producer build
  methodologyVersion: string;       // bumped when observation semantics change
  browser: { name: string; version: string };   // today: chromiumVersion
  viewport: { width: number; height: number; isMobile: boolean };
  locale: string; language: string; timezone: string;
  egress: { label: string; region?: string };   // today: scannerEgress string
  detectorVersions: Record<DetectorId, string>; // every detector, even skipped ones
  catalogDigests: {
    trackerCatalog: string;         // sha256 of the loaded catalog (today: source/version/entries counts only)
    adblockLists: string;           // sha256 over the pinned list snapshot (today: source + fetchedAt + count)
  };
}
environmentFingerprint: string;      // sha256 over the canonical JSON of `environment`
```

- The digest exists for **equality testing and indexing only**, never secrecy; the full
  object is always stored beside it. Canonicalization: sorted keys, no insignificant
  whitespace, NFC strings (same rules the validator publishes).
- `methodologyVersion` is distinct from the schema version: schema = shape of the JSON,
  methodology = meaning of the numbers (e.g. the 2026-07-07 change that excluded
  status>=400 runs from stats would bump methodology, not schema).

### 1.3 `conditionFingerprint`, environment plus intervention state

```ts
intervention: {
  kind: "none" | "gpc" | "shields" | "consent";
  state: string;                    // "gpc:on", "shields:block-simulation", "consent:reject-all"
}
conditionFingerprint: string;        // sha256 over environment + intervention
```

A **comparison pair** = two runs with equal `subjectKey`, equal `environmentFingerprint`,
and intervention states that differ **only** in the declared intervention. A **temporal
pair** = two runs with equal `subjectKey` and equal `conditionFingerprint` at different
times, both passing quality gates.

### 1.4 `comparability`, an evaluated result

Never part of a fingerprint; computed per pair after both runs exist:

```ts
comparability: {
  comparable: boolean;
  checks: {
    subjectMatch: boolean;          // final registrable domain + route shape agree
    environmentMatch: boolean;
    singleInterventionDelta: boolean;
    statusParity: boolean;          // both < 400, or both the same failure class
    noBotWall: boolean;             // neither run tripped BLOCK_TITLE_PATTERN semantics
    noTruncation: boolean;          // neither run hit request/field caps (privacy.truncation)
    loadComplete: boolean;          // navigation settled within budget on both
  };
  mismatchReasons: ComparabilityReason[];   // enumerated codes, empty when comparable
}
```

**Product rule:** an incomparable pair may keep descriptive deltas ("we observed 42 vs
17 requests") but must suppress causal headlines, "Shields blocked", "rejection changed
nothing" framings, since-last-scan deltas, and any future alert. This generalizes the
per-feature gates that already exist (consent claims require `clicked === true`, temporal
deltas pair same-kind only, stats exclude status>=400) into one evaluated object that
every consumer reads instead of re-deriving.

---

## 2. Structured blocks

New top-level blocks on every v2 report (single and comparison):

### 2.1 `provenance`

```ts
provenance: {
  producer: Producer;               // as in environment.producer
  buildCommit: string;
  methodologyVersion: string;
  sourceArtifactDigest?: string;    // e.g. sha256 of the PageGraph GraphML an import consumed
}
```

### 2.2 `privacy`

```ts
privacy: {
  redactionVersion: number;         // version of the sanitization policy applied (section 4)
  truncation: {
    requestsDropped: number;
    storageKeysRedacted: number;
    queryKeysRedacted: number;
    pathSegmentsGeneralized: number;
    fieldsTruncated: number;
  };
}
```

Truncation counters double as quality inputs: `comparability.noTruncation` reads them.

### 2.3 `quality`

```ts
quality: {
  outcome: "complete" | "censored" | "failed";
  reasons: QualityReason[];         // enumerated: http-error-status, bot-wall-title,
                                    // navigation-timeout, request-cap-hit, empty-load,
                                    // scan-slot-timeout, ...
}
```

"Censored" is the statistician's sense: the run ended or was capped before observation
completed, so counts are lower bounds even more than usual. This replaces scattered
heuristics (the manifest builder's bot-wall regex, `<=1 request` checks, corpus status
filtering) with a producer-declared status those tools verify instead of infer.

### 2.4 `detectors`

```ts
detectors: Record<DetectorId, {
  version: string;
  status: "complete" | "partial" | "skipped" | "unsupported" | "failed";
  reason?: string;                  // enumerated where possible ("no-form-fields", "budget-exhausted")
}>
// DetectorId: "keystroke-exfiltration" | "cname-uncloaking" | "pixel-events"
//   | "consent-banner" | "privacy-policy" | "fingerprint-heuristics" | ...
```

Every known detector appears in every v2 report. "No entry" is a validation error, so
silence is never ambiguous again. The Browser Run producer marks Node-only detectors
`unsupported` rather than omitting them.

### 2.5 `experiment` (comparison reports)

```ts
experiment: {
  intervention: Intervention;       // section 1.3
  pairId: string;                   // random id shared by both runs of the pair
  order: "AB" | "BA";               // execution order actually used
  repetition?: { run: number; of: number };   // for future repeated-run designs
  phases: PhaseSpan[];              // section 3.2: phase tags over the request timeline
  comparability: Comparability;     // section 1.4
}
```

`order` is recorded now and randomized/alternated when the verified-experiment work
lands, so order effects become measurable instead of invisible.

---

## 3. Consent semantics

### 3.1 Replace the overloaded `clicked`

v1's `ConsentInteractionSummary.clicked` conflates "we pressed something" with "the
choice took effect". v2 splits it:

```ts
consent: {
  mode: "accept-all" | "reject-all";
  interactionAttempted: boolean;    // the scanner looked for a control
  controlActivated: boolean;        // a control was actually clicked (v1 `clicked`)
  choiceStateVerified: boolean;     // the CMP's stored state reflects the choice
  verificationMethod: "tcf-api" | "cmp-cookie" | "banner-dismissed" | "none";
  verificationFailureReason?: string;   // enumerated: banner-persisted, tcf-unavailable,
                                        // cookie-absent, state-contradicts-choice, ...
  cmp?: string; selector?: string; matchedText?: string; frameUrl?: string;  // carried from v1
}
```

Verification is best-effort and layered: read `__tcfapi` TCData where the CMP exposes
IAB TCF; else known CMP state cookies (OneTrust `OptanonConsent` and peers); else the
weakest signal, banner no longer visible after the click. `choiceStateVerified: false`
with `controlActivated: true` is the grindr-style asymmetric case stated precisely.

### 3.2 Phase-tagged experiment flow

The consent experiment becomes a phased protocol, and every network request carries a
phase tag (one added field on `NetworkRequestRecord`, or span boundaries by request id;
implementation detail for the design review):

1. `passive-load`: initial navigation, pre-interaction traffic.
2. `consent-interaction`: from click attempt to settle.
3. `post-choice-reload`: a reload under the established consent state. **This reload
   becomes the measured run for post-choice claims**, because today's post-click
   traffic mixes pre-click and post-click observations in one log.
4. `active-probe`: keystroke sentinel and unload-flush window.
5. `policy-analysis`: the bounded policy-page visit (already excluded from counts).

Claims gate on phases: "trackers that survived rejection" reads `post-choice-reload`
traffic with `choiceStateVerified: true`, not the whole log. Unsupported or unstable
combinations (no reload possible, verification unavailable) mark the experiment
inconclusive via `comparability` rather than downgrading silently.

The public corpus is regenerated after this lands so published consent rows carry the
new semantics; `consent_clicks` in the export gains a sibling `consent_verified` column.

---

## 4. Privacy boundary first (redaction v2)

Sequenced **before** durable jobs so the queue never persists what minimization would
have removed. Current state ([lib/report-url.ts](../lib/report-url.ts)): userinfo, hash,
and query values are stripped (query keys preserved for third parties behind a safe-key
pattern), but the **path is kept verbatim** everywhere a URL is stored.

### 4.1 Path-shape redaction

- Keep scheme + host. Reduce paths to a bounded shape: at most N segments (proposal:
  6), each segment either kept literally when it matches a conservative safe pattern
  (short, lowercase, dictionary-ish route words: `products`, `privacy`, `api`) or
  generalized: numeric to `{n}`, UUID/hex/base64-ish or long or high-entropy to `{seg}`.
- **Semicolon (matrix) parameters**: `;jsessionid=...` and friends live in path
  segments and survive today's redaction. v2 strips everything from the first `;` in
  each segment before shape classification, preserving the parameter name only under
  the same safe-key rule as query keys.
- `privacy.truncation.pathSegmentsGeneralized` counts the generalizations so honesty
  is auditable.
- **No public unsalted hashes for token-like segments.** A hash of a low-entropy token
  is a dictionary lookup away from the token, and a stable hash is itself a linkable
  identifier. Token-like segments become the fixed `{seg}` marker, full stop.

### 4.2 Every persistent or public sink

The same policy applies to all of: `requests[].url`, `conditions.requestedUrl` /
`finalUrl`, `consentInteraction.frameUrl`, `privacyPolicy.url`, PageGraph fact-table
rows ([lib/pagegraph-corpus.ts](../lib/pagegraph-corpus.ts)), corpus exports, share
links surfaced in UI, server logs, and any future queued job payload. One function, one
version number (`privacy.redactionVersion`), one test suite.

### 4.3 Storage keys

`StorageRecord.key` is stored verbatim today. v2: keep keys matching the safe-key
pattern (short, conventional: `_ga`, `theme`, `cartId`); redact the rest to a class
marker plus shape info (`[redacted:uuid-like]`), keeping `area` and `valueBytes`
(values were never stored). Counter: `privacy.truncation.storageKeysRedacted`.

### 4.4 Size limits

Per-field string caps, per-array caps (requests, cookies, storage, detections), and a
total serialized-report cap, all enforced at build time with explicit truncation
counters, so a hostile page cannot bloat public artifacts or smuggle data through
unbounded fields.

### 4.5 Public vs ephemeral fields

Classify every field once in the schema: **public** (persisted, exported, shareable) vs
**ephemeral** (immediate scan response only). Screenshot is already ephemeral at
persistence time; v2 writes the classification into the published JSON Schema so the
rule is testable rather than conventional.

### 4.6 Remediation of already-published identifiers

Forward-only redaction does not fix what is already public. Decisions needed (user
call, listed here for the review):

1. **Committed static reports** (`public/reports/`, in git history since June): run a
   one-time re-redaction script over the working tree (new commit, IDs preserved).
   History rewrite (`git filter-repo` + force push) only if an audit of historical
   paths finds actual sensitive segments; otherwise accept the residual and document it.
2. **R2 share reports**: rewrite objects in place with re-redacted bodies (IDs and
   share links survive), or rely on age/count pruning plus a shortened retention pass.
3. **Pages deployment history**: old immutable deployments retain old artifacts;
   delete stale deployments in the dashboard as part of the same pass.

### 4.7 Queue payloads (forward constraint on the later milestone)

The durable queue must store the original target URL to run the scan, which redaction
cannot touch. Constraint recorded now: queued payloads are encrypted at rest or held
only until execution, carry a hard TTL, never appear in logs, and job records embed the
**redacted** URL everywhere except the executor's decrypt path.

---

## 5. Backward compatibility

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

### 5.1 The v1 reader

- One adapter, `readScanReport(json): VersionedScanReport`, accepts v1 and v2. It
  upgrades v1 in memory to the v2 **view** with explicitly weak values: `quality`
  inferred from status/bot-wall heuristics and marked `derived`, `detectors` entries
  set to `status: "unknown-v1"` where v1 absence is ambiguous, fingerprints computed
  from the fields v1 does have and flagged `derived: true`.
- Display and export keep working for every legacy report: permalinks, directory,
  corpus rows (which gain a `schema_version` column so researchers can filter).
- **v1 reports are ineligible for strict v2 comparisons**: their environment was never
  fully recorded (no build commit, no list digests, no detector versions), so
  `environmentMatch` cannot be proven. They may appear in descriptive temporal context,
  never in causal claims. This is stated in the export note, not silently applied.

### 5.2 One validator, published schema

Today three hand-rolled validators can drift (TS validation, and the two `.mjs` copies).
v2 ships a single TypeScript validator in `lib/`, consumed by the app, the Worker, and
the scripts (the scripts already run compiled lib code via the `.unit-test-dist` path
used by `corpus:pagegraph`, so there is precedent and no new build machinery). A JSON
Schema is generated from the same source and published at `/scan-report.schema.json`
(versioned URL per major), which also becomes researcher documentation.

### 5.3 Migration order

1. Adapter + unified validator land; all readers accept both versions (no emit change).
2. Redaction v2 ships inside v1 emission (removing data is schema-compatible), with
   the remediation pass of section 4.6.
3. Producers emit v2 (Node scanner, compare-reports, CI script, PageGraph adapter;
   decision below on Browser Run).
4. Manifest builder, corpus stats, exports, smoke tests assert v2 for new artifacts
   while tolerating v1 rows.
5. Corpus regeneration via the weekly cron replaces committed v1 reports organically;
   per-site keep-two retention means both generations coexist during the transition.

---

## 6. Implementation order after approval

1. Legacy v1 reading (adapter + unified validator + published JSON Schema).
2. Sanitization/redaction v2 + published-artifact remediation.
3. Provenance, quality, detector status, fingerprints (v2 emission).
4. Phase-aware verified consent experiments (section 3).
5. Unified cohort/comparison selection: one `comparability` evaluator consumed by
   headlines, diffs, temporal deltas, corpus stats, exports.
6. Corpus regeneration under v2.
7. Durable queue + job metadata layer (per [scan-job-model.md](scan-job-model.md),
   inheriting section 4.7's constraints).
8. Registrable-domain profiles and watchlists (keyed by `subjectKey`).

## 7. Open questions for review

1. **Browser Run producer**: upgrade `cloudflare/worker.ts` to v2 or freeze it at v1
   as a self-host-only legacy producer (readers keep accepting v1 either way)?
   Freezing is less work; upgrading keeps the "same schema from every producer" claim.
2. **Remediation depth** (section 4.6): re-redact in place only, or also rewrite git
   history? Needs the audit result first.
3. **Phase tagging shape**: a `phase` field on every `NetworkRequestRecord` (bigger
   reports, simpler queries) vs span boundaries in `experiment.phases` (smaller, needs
   join logic). Leaning per-request field with the size caps of section 4.4.
4. **AB/BA and repetition**: record-only in the first cut (proposed), with
   randomization and repeated runs as a follow-up once run cost is measured?
5. **Digest granularity**: is one `adblockLists` digest enough, or per-list digests
   for diagnosing which list changed between runs?
