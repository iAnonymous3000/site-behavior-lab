# The v4 side-separated reference architecture

## Adopted

- decidedBy: iAnonymous3000
- decidedAt: 2026-08-23T07:21:30Z (operator direction, recorded verbatim below)
- Completes step-4 item 3 of the censoring decision
  ([calibration-censoring-policy-decision.md](calibration-censoring-policy-decision.md)).
  The merge landing this architecture becomes the final step-4 SHA; sweep
  pass 1 collects on it, and pass 2 on the identical SHA.

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
| label batch | v1, binary value, frame-pinned shared evidence | v2, tri-state value, per-reviewer `{ sha256, provenance }` evidence |
| adjudication artifact | v1, binary, must equal the frozen fact | v2, tri-state, the tiebreaker's own value |
| labels manifest | v3 | v4, listing per-reviewer evidence digests |
| frame case binding | `referenceEvidenceDigest` (a truth value's evidence) | `referenceTask` (a task, not an answer) |
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
