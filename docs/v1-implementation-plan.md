# V1 implementation plan

Approved in the project task on 2026-09-05. V1 promises that a user can inspect a
page, understand observed behavior and measurement limits, and share evidence
that supports the report's claims.

## Implementation

- [x] Correct policy and pixel interpretations, input-probe coverage, and
  scanner-action disclosures; preserve historical detector identities.
- [x] Carry corrections and shared evidence completeness through report pages,
  findings, gallery, social cards, feeds, and exports without rewriting immutable
  measurement artifacts.
- [x] Give missing scans a terminal outcome after checking for a saved report;
  preserve recoverable transport failures and require an explicit new scan.
- [ ] Qualify advertised comparison modes independently on a representative
  current-candidate sample. Consent is visibly experimental pending that evidence.
- [x] Repair fresh-source release verification, reconcile the approved v1
  recovery scope, and identify remaining candidate-bound operational evidence.

## Implemented evidence boundary

The detector registry is node-detectors-v7: synthetic-sentinel@4,
pixel-request-decoder@4 and policy-text-cross-check@6. The methodology records
active-probe-v2 and auxiliary-context-block-v1. Focus, input and blur callbacks
can send requests; native submissions and probe-triggered navigation are
blocked. Unsupported fields, failed attempts and offscreen fields count as
omissions. Teardown-only transmissions are not measured.

The existing redaction rules are retained. The only public-string change admits
the new fixed scanner disclosure in addition to the old one. Its warning-pattern
identity is v9. Both old normalization identities and their producer rows remain
readable; no measurement report or provenance sidecar is rewritten.

The corrections ledger identifies 406 reports with overstated input-probe
coverage, 95 with unreliable Amazon/Oracle mention results, and six with an
unsupported X Purchase label. These sets overlap. Corrected reports retain their
observations but no longer lead with the original findings or enter statistical
distributions. A loaded document still counts toward descriptive corpus coverage.
JSON downloads from the explorer include a separate corrections file in a ZIP;
raw JSON and its provenance remain independently available. Request CSVs carry
all applicable clarification summaries.

Closed producer rows also restore the ServiceRole/b68c window and the August 11,
August 14 evening and pre-resource-budget-v2 August 15 list windows. The source
commits are pinned alongside those rows. Future list adoption must preserve every
outgoing production identity, even when its reports are absent from the corpus.

## Qualification before v1

Engineering fixtures and healthy scans do not establish representative accuracy.
Keep the following mode decisions independent:

| Mode | Required evidence before qualification |
| --- | --- |
| Single visit | Admitted scans reach a truthful report or failure; failed documents, omissions, cancellation and saved-report recovery remain visible. |
| GPC comparison | Both arms record their signal and worker verification state; the report stays descriptive when verification or comparability is insufficient. Request counts cannot establish compliance. |
| Blocker comparison | Use the pinned engine/list identity, record evaluated and actually blocked requests, and retain the one-pair descriptive limit. |
| Consent comparison | Record attempted controls and registered choices across representative consent systems. Missing or unverified choices cannot become an accept/reject comparison. Keep the mode experimental. |

Run the existing scanner-fidelity study lanes separately for each mode against
the reviewed candidate, retain every attempt including failures, and publish
mode-specific denominators and limitations. Do not use the historical corpus or
acceptance fixtures as current-method qualification evidence.

The repaired readiness evaluator still reports **NOT READY: 13 of 18 gates**
without candidate/operator artifacts. The next release sequence is:

1. Review and test the final commit, select the measurement candidate, and
   complete the governed freeze and candidate binding.
2. Produce current-method observations and controlled publication/runner
   receipts against that candidate, preserving their provenance and denominators.
3. Capture and verify release governance, R2 lifecycle, egress, WAF, log-retention,
   container-package and licensing evidence through their existing workflows.
4. Require the readiness check and applicable mode qualification to pass before
   tagging v1. Deployment health alone cannot satisfy these gates.

## Scope

Additional redaction, scheduled watches, sharding, new detector families, blanket
stable API promises, and stronger research or legal claims are out of scope.
Automatic restart recovery is deferred: v1 requires explicit failure and safe
retry. Durable jobs, sharding and encrypted watches remain disabled; the recovery
scope check is not durable-soak evidence.

Implementation does not by itself establish mode accuracy, production rollout,
or completion of the remaining operator evidence. This work does not enable a
production flag or perform a release ceremony.
