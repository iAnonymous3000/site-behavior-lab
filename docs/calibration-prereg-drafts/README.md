# Calibration preregistration drafts

Working drafts for the 1.1 detector-accuracy evidence program. Nothing in
this directory is a ceremony input: the ceremony reads
`calibration/<studyId>/` and `research/measurement-candidate/`, never this
directory. Every draft plan carries deliberately invalid placeholder digests,
so feeding one to `npm run calibration:scaffold` fails until the operator
replaces them through the real keygen step. That is intentional. These files
exist so the operator ceremonies start from reviewed, corpus-informed
decisions instead of a blank page.

The authoritative contract is `docs/calibration-study-operations.md` plus the
validators in `scripts/calibration-study-lib.mjs`. Where this directory and
those disagree, those win, and the draft is stale.

## What stands between these drafts and published accuracy numbers

In dependency order:

1. **Build the frame producer** (code, unimplemented). Custody assembly is
   implemented: `scripts/calibration-study-assemble.mjs` re-fetches and
   cross-binds the roster authorization, roster-selection ledger, and complete
   acquisition-attempt ledger before it reads the reveal key, with the refusal
   paths covered by `scripts/calibration-assemble-custody-lib.test.mjs`. The
   remaining engineering milestone is the deterministic `calibration:frame`
   producer specified in `frame-construction.md`; the frame cannot freeze until
   it emits the canonical case inputs, plan rows, labeler appendix, and sweep
   receipts.
2. **A controlled runner** (operator). The single authorized acquisition
   executes candidate C on the self-hosted runner named by
   `FEATURED_RUNNER_LABEL`, with attested egress.
3. **Labelers** (operator recruiting). Two to ten distinct GitHub actors seal
   blinded label sources, plus one more distinct actor precommitting the
   blind tiebreaker. Minimum three humans besides the operator. Their GitHub
   identities become part of the public provenance record; each must accept
   that before sealing.
4. **One RSA keypair per study** (operator ceremony). At least 2048 bits,
   generated outside the repository. Public half committed at
   `calibration/<studyId>/label-sealing-public-key.pem` as Node-canonical
   SPKI PEM; private half lives only in the protected
   `calibration-label-reveal` environment secret and is destroyed after the
   attested proposal merges.
5. **The freeze**. Preregistration and scaffold land BEFORE candidate C is
   frozen; the activation receipt, runner label, egress attestation, and
   candidate must agree. The manifest still records the
   `complete-case-only-zero-censoring` approval, but the step-3 decision
   (docs/calibration-censoring-policy-decision.md) supersedes that policy for
   NEW studies: step 4 must implement the per-detector C/B artifact and a
   named human must approve its exact bytes and digests before any new
   acquisition or labeling. A further policy ceremony IS needed.

## The zero-censoring arithmetic, stated plainly

SUPERSEDED FOR NEW STUDIES by the step-3 decision
(docs/calibration-censoring-policy-decision.md): accuracy studies run policy C
primary with scope-tagged policy B secondary, and no new study starts from the
zero-censoring artifact. The arithmetic below is retained because it is
correct about the policy it describes and it documents why that policy was
superseded.

The superseded policy makes any censored case fatal to the whole study. Every
marginal denominator (reference present, reference absent, predicted detected,
predicted not detected) must reach 100 on the labeled data, which sets a
**structural floor of 200 planned cases**. Not 400: those four class minimums
are two partitions of the same N, so 100 in each of four classes needs 200
cases, and summing all four counts every case twice. `structuralMinimumCasesFor`
in `scripts/calibration-study-lib.mjs` is the enforced floor, and the arithmetic
is worked through in
[calibration-study-operations.md](../calibration-study-operations.md). The pilot
lost 37.5 percent of attempts to capture failure on consumer retail sites.

**That floor is not a sample size.** It says only that fewer cases cannot fill
the four classes; it never says a design of that size is adequate. Real sizing
is power-derived per study from the detector's prevalence and the recall it must
tolerate, and is argued in that study's own preregistration. For a rare-positive
detector the honest number sits far above the floor: the CNAME design sizes
N ~ 350 so that `referencePresent` is expected near 175, because
`predictedDetected` is roughly recall times `referencePresent`. An earlier
version of this page fixed every study at 400 and called that the optimal frame.
It was neither the structural floor nor a power calculation, and it rejected
designs this project's own power analysis justifies, including the CNAME study
described here.

One consequence that shapes every draft here:

- **Plan the minimum, not a margin.** Extra cases cannot replace failures
  (substitution is forbidden) and every planned case must complete, so each
  additional case beyond the power-derived N only adds another chance to kill
  the study. Draw the frame from the most reliably scannable sites available.
- **Reliability screening is the whole game.** The frame must be built from
  sites with demonstrated repeated successful automated visits under the
  exact measurement condition. The weekly corpus already measures this for
  126 catalog sites; a dedicated pre-freeze reliability sweep must extend it
  to every frame candidate, twice, before the frame is frozen. The declared
  target population then honestly reads: sites that reliably serve
  unauthenticated automated visits under the stated condition.

## Per-detector feasibility, from committed-corpus prevalence

Corpus evidence (574 reports, 108 hosts) says the six detectors are not
equally studiable at the 100-per-class floor:

| Detector | Verdict | Corpus signal |
|---|---|---|
| `pixel-events` | **Feasible, flagship** | 8 positive hosts under passive observe; the accept-all arm is expected to fire far more widely on retail and media, which is exactly why the arm exists. Frame draws likely-positives from retail, news, and health commerce. |
| `consent-banner` | **Feasible** | CMP evidence is pervasive across the corpus; both classes reachable. |
| `fingerprint-heuristics` | **Feasible** | session-recording 509 and input-monitoring 464 detections corpus-wide; positives abundant, clean negatives available from the reference and open-source pools. |
| `privacy-policy` | **Feasible** | policy summaries present on 683 v1 runs; both classes reachable. |
| `cname-uncloaking` | **Feasible with care** | 15 positive hosts known (finance and news skew); reaching 100 reference-present cases requires a finance-heavy frame and confirms only at scan time. Rate the risk before committing a frame. |
| `keystroke-exfiltration` | **Not feasible on the open web** | One positive host in the entire corpus (weather.gov, sentinel to an arcgis.com recipient). One hundred naturally occurring reference-present cases do not exist to be found. See the memo below before spending any ceremony on this detector. |

### The keystroke memo

Do not preregister a keystroke study against the open web; it will either
fail the present-class floor or tempt frame construction toward the handful
of known positives, which destroys the population claim. The honest options
are: (a) publish specificity only for this detector, with a frame of
reference-absent sites and the sensitivity denominator stated as
structurally unreachable; or (b) a synthetic-positive arm: lab sites that
genuinely exfiltrate typed input, built and labeled by construction, with
the population claim scoped to synthetic pages and never generalized. Both
are defensible; (a) publishes less and claims nothing it cannot support,
(b) publishes sensitivity against a population nobody browses. This is a
design decision for the operator, recorded here so it is made deliberately.

## Files here

- `plan-pixel-events.draft.json` and four sibling drafts: the exact
  `schemaVersion: 2` plan shape the scaffold validates, with placeholder
  sealing-key digests that fail validation until replaced. Case arrays are
  empty by design: cases are minted by the frame tooling after the
  reliability sweep, not hand-typed.
- `labeling-protocol.md`: operational definitions per detector, what a label
  source asserts, blinding and tiebreaker procedure.
- `frame-construction.md`: the reliability sweep, class-balance strategy,
  candidate pools with corpus receipts, and the case-file digest pipeline.
- `operator-checklist.md`: every ceremony step in order, who performs it,
  and what refuses if skipped, keyed to the freeze calendar.
