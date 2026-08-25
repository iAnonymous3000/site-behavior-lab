# The v4 side-separated reference architecture

## Adopted

- decidedBy: iAnonymous3000
- decidedAt: 2026-08-23T07:21:30Z (operator direction, recorded verbatim below)
- Completes step-4 item 3 of the censoring decision
  ([calibration-censoring-policy-decision.md](calibration-censoring-policy-decision.md))
  in the sense that matters for the sweep and the analyzer: the schemas, the
  tri-state merge, the adjudication representation with its value bound to
  the side, the assembly bridge (validated batches to study-ready sides and
  digested artifacts, `assembleV4ReferenceCases`), and the analyzer
  projection, each mutation-tested. What deliberately remains for
  ceremony-time tooling, before the first v4 ceremony and after the sweep:
  envelope sealing and authenticated artifact fetching for v4 batches
  (reusing the existing custody machinery), CLI wiring, task-byte
  verification against `taskSha256`, and deep release/design identity
  validation, none of which can change a value the bridge produces, only
  refuse to produce one. The final-collection-SHA
  designation moved once more: the step-5 cluster-design amendment
  ([reliability-sweep-cluster-design.md](reliability-sweep-cluster-design.md))
  found the two-pass plan could not produce the decision's defensible loss
  bound, so the merge landing THAT design is the collection SHA every sweep
  round binds to.

## The circularity this removes

The v3 label pipeline cannot represent independent reference information. The
frozen frame binds a per-case `referenceEvidenceDigest` over scanner-derived
evidence carrying a `${detector}-presence` boolean fact, and the machinery
forces every final label to equal that fact from both directions:

- A blind tiebreaker's value must match the frozen presence fact or reveal
  throws (`scripts/calibration-study-lib.mjs:1091-1095`).
- A unanimous labeler value that disagrees with the frozen fact throws at
  assembly (`scripts/calibration-label-sources-lib.mjs:505-511`).

Labels therefore verify a scanner-derived truth value; they never inform. The
step-3 decision's independent references (reviewer-owned capture, reviewer
resolvers, externally pinned definitions) are unrepresentable under v3, and
`reference-label-uncertain` has no producer because uncertainty has no
representation.

## The architecture, as adopted

- A **v4 side-separated study model**, never a third value patched into v3.
- The frozen frame binds a **reference task and protocol**
  (`referenceTask: { protocolId, taskSha256 }` per case), not a
  scanner-derived truth value. There is no frozen presence fact anywhere in
  the v4 path.
- Each reviewer supplies **independent evidence** and a tri-state value
  `present | absent | uncertain`.
- Reviewer evidence need **not** be byte-identical; each source receives its
  own digest and provenance.
- If primary labels are **unanimous**, that result stands. Otherwise the
  precommitted tiebreaker resolves to its **own tri-state** value. A resolved
  `uncertain` becomes the censor reason `reference-label-uncertain`.
- Assembled cases represent **prediction and reference independently**:
  - both sides known: scored;
  - prediction known, reference unknown: policy-C `reference-unknown`, with
    the prediction retained;
  - prediction unknown, reference known: `prediction-unknown`;
  - both unknown: `both-unknown`.
- **v3 is preserved strictly for historical verification.** Its types,
  schemas, validators, and analyzer path do not change; all new ceremonies
  use v4.

## What versions

| surface | v3 | v4 |
|---|---|---|
| study schema | `detector-calibration-study.v3.schema.json` (frozen) | `detector-calibration-study.v4.schema.json`, generated from `lib/detector-calibration-v4.ts`, sha-pinned |
| case model | one `outcome` with a merged reference | side-separated `prediction` and `reference`, each `known` or `unknown` |
| label batch | v1, binary value, frame-pinned shared evidence | v2, tri-state value, per-reviewer `{ sha256, provenance }` evidence, bound to the frame's study/detector/candidate/protocol |
| adjudication artifact | v1, binary, must equal the frozen fact | v2, tri-state, the tiebreaker's own value, with a strict validator; the value is also carried in the study-side adjudication record and bound to the side by the study validator |
| labels manifest | v3 | v4, self-identifying kind, listing per-reviewer evidence digests, with a strict validator |
| frame case binding | `referenceEvidenceDigest` (a truth value's evidence) | `referenceTask` (a task, not an answer), in a self-identifying, study-bound frame-tasks artifact |
| custody trio | unchanged mechanically; v4 artifacts enter the same digest chain | |

The prediction side's censor reasons are the scan-side three
(`capture-failed`, `artifact-unreadable`, `eligibility-criteria-not-met`);
`reference-label-uncertain` is exclusively a reference-side outcome. The four
projection quadrants feed the B/C analyzer
(`lib/calibration-censoring-analysis.ts`) directly; the reference-unknown
quadrant is what makes a surviving prediction beside an uncertain reference
finally representable, which the analyzer was built expecting.

## Mutation obligations

Landed with the implementation, each verified by running the mutation:

1. **Uncertainty cannot become absence**: no code path maps a resolved
   `uncertain` to `absent`, and the v4 validator refuses a known reference
   side carrying `uncertain`.
2. **Evidence independence**: the v4 merge takes no frozen fact and no shared
   evidence digest; reintroducing either fails tests.
3. **Prediction retention**: a reference-unknown case preserves its
   prediction value through projection.
4. **v3/v4 separation**: each generation's validator refuses the other's
   rows; the v3 schema digests are untouched.

## Ceremony tooling (landed)

The five deferred items above are now implemented, each refusal-only as
adopted, with the custody machinery REUSED rather than restated:

- **Envelope sealing**: `sealV4LabelBatch`
  (scripts/calibration-v4-ceremony-lib.mjs) validates the batch against the
  frame (including content binding, below) and verifies every task's bytes
  BEFORE sealing through the existing
  `sealCalibrationLabelSourceEnvelope` with the existing 9-field identity;
  CLI `npm run calibration:v4-seal-label-batch`.
- **Authenticated fetching/reveal**: fetching reuses the
  generation-agnostic `fetchAuthenticatedCalibrationLabelCommitments`
  unchanged; `revealAuthenticatedV4LabelBatches` composes the custody rules
  EXTRACTED from the v3 assembly (roster custody record, commitment-set
  arity/chronology/uniqueness, revealed-set-equals-roster, per-entry
  envelope open) and then validates each plaintext as a v4 batch. The v3
  byte-identical-evidence and frozen-presence rules are deliberately
  absent. The reveal key arrives as a THUNK invoked only after every
  key-free custody check passes, preserving the reveal-key secrecy rule.
- **Task-byte verification**: `buildV4FrameTasksArtifact` /
  `verifyV4TaskBytes` produce and verify per-case reference-task files
  against `taskSha256` over exact canonical bytes, with task identity
  fields inside the digested bytes; CLI
  `npm run calibration:v4-frame-tasks` (`build` and `check`).
- **Deep release/design identity validation** , 
  `deepValidateV4StudyIdentity` calls
  `detectorCalibrationReleaseMismatchReasons`, extracted verbatim from the
  v3 analyzer (lib/detector-calibration.ts) so the mismatch vocabulary,
  reason order, fail-closed availability arms, and the fetchedAt-excluded
  Brave-list comparison keep one home; the design half compares REQUIRED
  caller-stated digests and derives the expected measurement condition from
  the study's own detector through the one canonical-arm export. All four
  pinned schema digests are unchanged by the extraction.
- **Frame-content binding (review-driven)**: v4 batches carry a required
  `frameTasksSha256`: caseIds are positional, so identity fields alone
  cannot distinguish two frames, and a batch sealed for one frame would
  otherwise replay against another. The digest chain batch → frame-tasks
  bytes → per-case taskSha256 → task bytes closes it.

Recorded for the pilot runbook: the frame does NOT live in the commit its
`candidateCommit` names, and cannot. Every task file embeds that sha, so a
commit containing the tasks would have to be named by bytes it already
contains. A pilot therefore has two commits: the input carrier K (pilot
set, universe provenance, sealing public key, no frame files), which is
what `candidateCommit` binds, and the later frame freeze F, which carries
`frame-tasks.json`, `tasks/`, and a `pilot-carrier.txt` naming K. Reveal
and every reviewer read the frame from F; `npm run
calibration:v4-pilot-carrier-check` re-derives the committed frame by
running K's own producer over K's own inputs, so the derivation is a
checked fact rather than a claim. A `referenceProtocolId` names exactly
one frozen protocol byte sequence, and protocol drift is caught only by
the deep design digests.

## Pilot ceremony closure (landed)

- **Fixed-length padding, RESOLVED**: GCM ciphertext length equals
  plaintext length, so an unpadded tri-state batch leaks its label
  distribution. v4 batches (schemaVersion 3) carry a required `padding`
  field and must serialize to their frame's ONE fixed byte length
  (`v4PaddedBatchByteLength`: the field-wise maximal template with role
  "tiebreaker", every value "uncertain", every provenance at the 200-char
  bound), enforced in `validateV4LabelBatch` and again byte-level at seal
  (canonical plaintext bytes required). Both roles pad to one target, and
  provenance is bounded printable ASCII without quotes or backslashes so
  the target needs no escape analysis. This binds confirmatory batches
  too, not only the pilot.
- **Pilot identity and chronology**: the pilot has no acquisition event,
  so both come from the repo-committed PILOT LABELING AUTHORIZATION
  (`site-behavior-detector-calibration-pilot-labeling-authorization`),
  produced at close time from authenticated-fetcher records and committed
  at calibration/<pilotStudyId>/pilot-labeling-authorization.json BEFORE
  any reveal. It carries the labeling-close instant and the authorized
  14-field commitment projection; the reveal accepts neither as a free
  parameter, so a moved close or substituted commitment self-defeats.
- **Executable reveal**: `npm run calibration:v4-reveal` (key-free custody
  first; the reveal key arrives only through
  CALIBRATION_LABEL_REVEAL_PRIVATE_KEY after custody passes), emitting the
  RESOLVED-LABELS artifact, a pure projection of the assembly bridge, plus
  per-case adjudication artifacts.
- **Canonical sizing producer**: `npm run calibration:v4-pilot-sizing`
  consumes resolved labels and frame-tasks bytes only (no typed counts),
  partitions cases into a CLOSED present/absent/uncertain vocabulary, and
  derives N through the preregistered uncertainty envelope
  (docs/reliability-sweep-cluster-design.md), recording feasibility
  against a supplied swept pool for the preregistered fail condition.
- Ceremony order: seal (`calibration:v4-seal-label-batch`, which pads an
  unpadded reviewer batch) -> hosted commitments -> close
  (`calibration:v4-pilot-close`) -> commit the authorization -> reveal ->
  size. The whole pipeline is executed end to end by the ceremony suite's
  spawn smoke test. Mutation obligations were re-run for the batch-shape change
and the new surface: task digest deleted, seal-validation deleted,
chronology deleted, uniqueness deleted, roster-equality made vacuous, key
read before custody, content binding weakened to shape, evidence
byte-identity reintroduced, uncertain coerced to absent, and buildCommit
comparison deleted, each fails its suite.
