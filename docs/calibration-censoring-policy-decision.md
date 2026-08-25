# Calibration censoring policy decision

## Status and authority

**Step 3 technical decision, taken 2026-08-23 UTC:** replace the global
`complete-case-only-zero-censoring` design with a per-detector assignment.

This decision is the engineering input to step 4 of the adopted measurement
freeze path. It is based on the per-detector matrix at `f59093c` and the
single, test-enforced CNAME and consent labeling protocol at `41e522e`.

This record is deliberately not a release-readiness approval. Step 4 must first
implement the selected policy artifact and its analyzer disposition. Only then
can a named human approve those exact bytes by updating
`RELEASE_READINESS.json`, its policy-artifact digest, its disposition digest,
and its `decidedBy` / `decidedAt` fields. Until that happens, the current
approved artifact remains historical machinery and must not be used to start a
new study.

## Decision

Policy A (`complete-case-only-zero-censoring`) is superseded for new studies.
It remains readable only so existing artifacts and historical decisions remain
verifiable.

Accuracy-bearing studies use policy C
(`bounded-censoring-with-sensitivity-analysis`) as their primary analysis and
may publish policy B (`detector-scoped-complete-case`) as a separately named
secondary analysis. The policy-C result carries the declared-population claim.
The policy-B result describes only the detector-scoreable subpopulation. A
policy-B result never rescues an ineligible or inconclusive policy-C result.

Rule-conformance studies may use policy B as their primary analysis because
they make no target-population accuracy claim. A detector with no coherent
proposition, independent accuracy reference, or reachable estimand does not
enter a ceremony merely because the analyzer can produce a table for it.

| detector | disposition | primary analysis | permitted secondary analysis |
|---|---|---|---|
| `cname-uncloaking` | proceed | C, target-population accuracy | B, scoreable-subpopulation accuracy |
| `consent-banner` | proceed for `banner-visibility@1` only | C, target-population accuracy of the seam | B, scoreable-subpopulation accuracy of the seam |
| `keystroke-exfiltration` | choose memo option (b); synthetic-positive arm only | C, sensitivity on the synthetic-positive population | B, scoreable synthetic-positive sensitivity |
| `pixel-events` | proceed as rule conformance only | B, request-complete endpoint-rule conformance | none |
| `fingerprint-heuristics` | hold | none | none |
| `privacy-policy` | hold | none | none |

## Proposition and inference-scope bindings

Every result must name the proposition it measured. A detector id is not a
claim.

- `cname-uncloaking`: at least one contacted first-party subdomain in the
  reviewer-owned browser capture independently resolved through a CNAME chain
  to a service classified by the SHA-256-pinned external tracker definition.
- `consent-banner`: a first-layer consent control was visibly offered at the
  observation time in the retained capture. The rate does not cover the public
  card's separate claim that a consent management platform was requested.
- `keystroke-exfiltration`: under the synthetic-positive lab protocol, the
  detector observed its typed sentinel leaving in network traffic. The result
  is sensitivity for that constructed population, not open-web accuracy.
- `pixel-events`: the implementation agreed with the pinned Meta, TikTok, and X
  endpoint predicates when independently re-executed over retained,
  request-complete rows. This is not accuracy about tracking behavior and does
  not cover the populated-identifier tier.
- `fingerprint-heuristics`: no rate until the pooled boolean is split into the
  separately hedged published propositions and an independent behavioral
  reference is preregistered.
- `privacy-policy`: no 2x2 rate until the analyzer exposes a real negative class
  and the evidence vocabulary separates subject absence from capture or budget
  failure. A future study may instead preregister discovery completion and
  censor-reason composition as non-accuracy estimands.

## Non-negotiable censoring semantics

All planned attempts remain conserved in the study record. Ordinary
measurement or reference uncertainty may be analyzed under the chosen policy;
custody, provenance, blinding, identity, or measurement-invariant violations
remain fatal and must not be converted into censoring.

Policy C assigns an indeterminate side adversarially across every realizable
2x2 cell consistent with the known side, computes every preregistered metric
for each assignment, and publishes the envelope of the resulting 95% Wilson
intervals. In particular:

- known reference-present with an unknown prediction can be only TP or FN;
- known reference-absent with an unknown prediction can be only FP or TN;
- known predicted-detected with an unknown reference can be only TP or FP;
- known predicted-not-detected with an unknown reference can be only FN or TN;
- a row with both sides unknown may occupy any of the four cells.

`reference-label-uncertain` is an unknown reference, never reference-absent.
Step 4 must add its label/adjudication emitter and assembly handling before the
first governed study. The protocol text added at `41e522e` defines the source
condition; it does not assert that this machinery already exists.

Policy B includes a case only when the detector's causal inputs and the final
reference label are complete. It must publish the planned count, analyzed
count, coverage loss, loss reasons, and the exact
`scoreable-subpopulation` inference-scope tag beside every rate.

## Publication eligibility

The 95% confidence level and maximum worst-case half-width of `0.10` remain
unchanged. A target-population result publishes only when the full policy-C
envelope clears that width. The descriptive policy-B estimate may still be
reported if preregistered, but it cannot inherit the target-population claim or
make the policy-C gate pass.

The existing four-margin minimum is a publication profile for a two-class
accuracy study, not a universal definition of evidence. Step 4 must bind
minimum denominators to each preregistered estimand without weakening a claimed
class:

- two-class accuracy keeps at least 100 cases in every claimed reference and
  prediction margin, plus its detector-specific power calculation;
- synthetic-positive keystroke sensitivity requires at least 100
  reference-present cases and a power calculation for sensitivity; it makes no
  absent-class claim;
- pixel conformance must preregister the positive and negative endpoint-rule
  strata it reports and size each claimed stratum independently.

No frame size is approved by this decision. The committed simulations show no
modeled N at which policy C clears under the worst realizable missing-reference
composition. The fresh multi-cluster reliability sweep must establish a
defensible detector-input loss bound before the frame producer sizes or seals a
study. Failure to establish one leaves the study infeasible; it is not grounds
to substitute policy B or narrow the declared population after seeing results.

## Step 4 implementation contract

Step 4 is unblocked to implement:

1. A policy schema that binds detector, proposition id, result type, primary
   analysis, optional secondary analysis, inference scope, and
   estimand-specific publication profile.
2. Analyzer support for independently missing predictions and references,
   policy-C realizable-assignment envelopes, policy-B complete-case summaries,
   and conservation of every planned attempt.
3. The `reference-label-uncertain` emitter, adjudication representation, and
   assembly path, with mutation tests proving that uncertainty cannot become
   absence.
4. A reliability-sweep caller that measures detector-input readiness with
   structured loss reasons without reading predictions or reference labels.
5. Updates to the stale zero-censoring prose in the preregistration and
   operations documents, and resolution of the CNAME 12-host draft versus
   10-host shipping-cap mismatch before any frame is drawn.

After those behaviors and their tests exist, the exact candidate-resident
policy artifact, analyzer disposition, and digests return to a named human for
the approval required before acquisition or labeling.

## Alternatives rejected

- Retaining A: one unrelated censored case invalidates an otherwise scoreable
  detector study; every modeled operating point failed.
- Using B as primary for an accuracy claim: measurement difficulty selects the
  analyzed cases, so the resulting rate does not describe the declared frame.
- Using C without a B diagnostic: valid but unnecessarily hides the performance
  of the scoreable instrument. B is useful so long as its narrower scope is
  inseparable from the number.
- Running all six detectors through one ceremony shape: it would label rule
  conformance as accuracy and manufacture rates for structurally empty or
  undefined estimands.

## Step-4 implementation status (2026-08-24)

The selected policy artifact and its analyzer disposition are implemented:
`research/measurement-candidate/calibration-censoring-policy-assignments.json`
is derived from the step-3 table by `npm run calibration:policy-artifact`
(whose `check` mode runs in CI so the table and artifact cannot drift), the
disposition digest uses the domain
`site-behavior-calibration-censoring-policy-disposition-v3` over the
artifact digest, the analyzer version, and the per-detector semantic
projection, and every scaffold, preflight, binding verification, and v4
pilot entrypoint requires the approved digests. The shared reference
protocol (docs/calibration-prereg-drafts/labeling-protocol.md) and the
cname external definitions (AdGuard cname-trackers justdomains at
`d2ef7cb2`, publicsuffix list at `e8c9a2b2`) are pinned inside the
artifact. `RELEASE_READINESS.json` carries the exact digests with status
pending-named-human-approval; per the authority section above, only a named
human's approval commit permits labeling. That commit is exactly: the
status flip, decidedBy/decidedAt, and the release-readiness test's
documented AS_OF bump (its ritual for any newly landed evidence), changing
nothing else, and the superseded zero-censoring approval
is preserved verbatim in the decision's `superseded` block with its
artifact readable at its historical path.
