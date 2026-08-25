# Operator checklist (draft)

Every ceremony step in order, who performs it, and what refuses when it is
skipped. Steps marked OPERATOR need the repository owner; steps marked CODE
are engineering that can land as ordinary PRs before the ceremony; LABELERS
are the recruited actors. The authoritative sequence is
`docs/calibration-study-operations.md`; this is the same sequence with
owners and the current gaps attached.

## Before anything else

- [x] CODE: assemble custody wiring is implemented in
      `scripts/calibration-study-assemble.mjs` and
      `scripts/calibration-assemble-custody-lib.mjs`, with refusal paths covered
      by `scripts/calibration-assemble-custody-lib.test.mjs`.
- [ ] CODE: build the deterministic `calibration:frame` producer from
      frame-construction.md. No frame can freeze until it emits the canonical
      case inputs, plan rows, labeler appendix, and sweep receipts.
- [ ] OPERATOR: provision the controlled runner (`FEATURED_RUNNER_LABEL`)
      with attested egress. Also unlocks r2 corpus production.
- [ ] OPERATOR: recruit two to ten labelers plus one tiebreaker, all
      distinct GitHub actors, all accepting public provenance. Three humans
      minimum.
- [ ] Policy approval: the step-4 per-detector C/B artifact is IMPLEMENTED
      and its exact digests sit in `RELEASE_READINESS.json` with status
      pending-named-human-approval; the recorded
      `complete-case-only-zero-censoring` approval is preserved in the
      decision's `superseded` block. A named human must flip the status and
      add decidedBy/decidedAt before any new acquisition or
      labeling.

## Per study, in order

1. [ ] OPERATOR: generate the study RSA keypair (2048-bit minimum) outside
       the repo. Commit the canonical SPKI PEM at
       `calibration/<studyId>/label-sealing-public-key.pem`; store the
       private key ONLY as `CALIBRATION_LABEL_REVEAL_PRIVATE_KEY` in the
       protected `calibration-label-reveal` environment. One keypair per
       study, never reused, destroyed after the proposal merges.
2. [ ] CODE then OPERATOR: run the reliability sweep, build the pool, draw
       the frame with the seeded tooling, fill the draft plan's sealing-key
       digests and cases, and run `npm run calibration:scaffold` with the
       finished plan. The scaffold refuses placeholder digests, existing
       frame or preregistration files, and a byte-different shared policy.
3. [ ] OPERATOR: commit preregistration, frame, PEM, and every candidate
       input to `research/measurement-candidate/measurement-inputs.json`;
       THEN freeze candidate C. Preregistration after the freeze is an
       identity violation the workflow will not repair.
4. [ ] OPERATOR: activate the measurement freeze; live variables and the
       committed activation receipt must agree on candidate, runner label,
       controlled egress, region, and r2 attestation.
5. [ ] LABELERS: every labeler seals their full-frame source to the study
       public key and dispatches the hosted commitment workflow; the
       tiebreaker seals theirs. All commitments must exist before
       acquisition; GitHub artifact timestamps authenticate the ordering.
6. [ ] OPERATOR: create evidence carrier H (append-only
       `calibration-label-coordinate` manifest, C an ancestor of H, C-to-H
       diff set-equal to the binding's inventory, producer bytes identical
       at C and H).
7. [ ] OPERATOR: dispatch Calibration Label Roster Authorization at H,
       exactly once. Never dispatch acquire mode by hand; never rerun a
       failed roster or acquisition. Any duplicate or retry makes the
       ceremony ineligible and requires a fresh preregistered identity.
8. [ ] AUTOMATIC: the controlled runner executes C against the frozen
       cases; reveal and assembly run only in the protected lane; a
       separate hosted job attests the runtime receipt; finalization opens
       one `automation/calibration-*` PR.
9. [ ] OPERATOR: merge only that generated proposal. If another evidence
       carrier merged first, close the conflicting PR and rerun assembly.

## Calendar reality

The freeze window opens no earlier than 2026-08-10, and the drafts carry
declaredAt 2026-08-19T00:00:00.000Z, matching the operations doc's own
example date and the deferral re-adjudication window. The chain that must
complete before that date: frame tooling, runner, keygen, and labeler
commitments. The two long poles are the runner and the labelers;
both are OPERATOR items with lead time, which is why they are listed first.

## What publishes when it works

One eligible v3 study per detector flips that detector's row in the
readiness calibration gate and replaces the README's "no published detector
accuracy" bullet with a conditional rate: complete-case rates with exact
denominators, scoped to the study's frame population and measurement arm,
under `sample-estimate` status only when the simple-random design held end
to end. The keystroke detector publishes specificity only, or a
synthetic-arm sensitivity, per the memo in the README of this directory.
