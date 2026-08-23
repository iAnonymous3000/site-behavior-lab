# Per-detector calibration matrix

Step 2 of the adopted freeze-slip path
([docs/measurement-freeze-schedule-decision.md](measurement-freeze-schedule-decision.md)).
This document is the decision INPUT for step 3, the censoring-policy
retain-or-replace decision. It decides nothing itself: it states, per detector,
the exact claim a study would calibrate, the reference candidates and their
independence, the censoring unit and its observed reasons, the estimands
available under the missingness the corpus actually shows, and the result type
a study can honestly publish. Facts were extracted from the tree at `010a7a1`
by per-detector review with file:line citations, and the load-bearing ones were
independently spot-checked (the pooled prediction disjunction, the keystroke
design memo, the privacy-policy ledger rule, the censoring-corpus figures).

Two ground rules inherited from the record and applied throughout:

- The 44.3% arm zero-loss figure is 61 development runs across two
  scan-date/build clusters. It is evidence that policy A is operationally
  unsuitable, and it is never quoted here as an open-web completion
  probability.
- Policy scope is stated per detector, never as a headline count.
  keystroke-exfiltration is already excluded from open-web sensitivity
  labeling, so "six detectors" is not one population.

## The matrix

| detector | published proposition (compressed) | best reference candidate | independence | result-type ceiling | binding constraint |
|---|---|---|---|---|---|
| fingerprint-heuristics | warn: "fingerprint-like API patterns, heuristic review signals, not proof" (5 high-entropy kinds); info: cross-site listener registration (2 coverage kinds) | none drafted that is independent; the CNAME-style repair (reviewer-owned capture plus external digest-pinned definition) is not sketched for this detector | vendor clause: partially-derived; per-kind clause: circular | vendor-presence agreement or rule conformance | prediction pools all non-keystroke kinds into one boolean spanning two differently-hedged reader claims |
| keystroke-exfiltration | warn: typed sentinel observed leaving in network traffic | synthetic-positive lab pages (ground truth by construction) | independent, lab arm only | accuracy on the lab arm; specificity-only or agreement on the open web | operator has not chosen memo option (a) specificity-only vs (b) synthetic arm; (a) collides with the approved minimum denominators |
| cname-uncloaking | warn: first-party subdomain is a CNAME alias for a classified third-party tracker | reviewer-named resolver chains + SHA-256-pinned external list + reviewer HAR candidates | independent (guard test enforces no repo classifier imports) | accuracy | 88.5% arm scoreable makes the zero-censoring N~350 design "not a study at all" per its own design doc |
| pixel-events | info/warn: recognized advertising-pixel request decoded (tier escalates on identifier fields) | none: every drafted reference restates the detector's own endpoint predicates over the same retained request log | circular | rule conformance | the required accept-all arm rarely completes from the current US egress; the observe arm is where positives occur |
| consent-banner | published card: "a consent management platform was requested" (vendor presence); calibratable seam: first-layer consent control visible | plan-draft blinded human visibility labels | partially-derived (same capture pipeline) | accuracy of the SEAM proposition; the published proposition has no study design at HEAD | detector id spans two propositions; a published rate must name which one it covers |
| privacy-policy | info: policy discovered and summarized; reader value is the contradiction/disclosure-gap comparisons | preregistered blinded labelers over recorded link evidence | partially-derived | rule conformance | the not-detected class is structurally empty: a complete ledger requires a non-null summary, so every scoreable prediction is "detected" |

## Per-detector detail

### fingerprint-heuristics

**Exact claim being calibrated.** No published report asserts "this site
fingerprints". The warn-level headline states the domain "triggered
fingerprint-like browser API patterns", explicitly "heuristic review signals,
not proof of fingerprinting intent" (lib/report-headline.ts:723-760); the
listener-coverage kinds produce only an info-level claim that listeners were
registered through a cross-site call chain (lib/report-findings.ts:1268-1301).
The calibration prediction collapses all non-keystroke detection kinds into one
boolean (scripts/calibration-study-lib.mjs:1260-1264, verified), so a published
rate would attach to a disjunction of two differently-hedged reader
propositions that no single report surface states as one claim. This is the
same detector-id-vs-published-proposition hazard docs/calibration-findings.md
F2 records for consent-banner.

**Reference candidates.**
- Vendor-endpoint clause (drafted): partially-derived. The prediction never
  consults the request log or catalog, but both labeler inputs are
  project-derived (the scanner's own retained request rows; the curated catalog
  frozen at the candidate commit), and the clause measures vendor presence, a
  different construct from fingerprint-like API behavior.
- Per-kind API-activity clause (drafted): circular. The "retained API-activity
  evidence" is the output of the project's own in-page observer, and the five
  per-kind definitions restate the detector's five high-entropy heuristics one
  for one (lib/fingerprint-observer.ts:448-453, 505, 528-572).
- Independent behavioral construct: not sketched anywhere in the repo for this
  detector. The shape it would need is the CNAME repair pattern
  (reviewer-owned browser capture plus an externally published, digest-pinned
  behavioral definition, docs/calibration-cname-uncloaking-design.md:64-70).
  The earlier categorical claim that no independent construct can exist at any
  price is not restated here; what is true is that the current drafts do not
  contain one.

**Censoring.** Unit: one frozen case (site x arm, one-shot acquisition).
Dominant corpus loss for this detector's causal inputs is its own family:
fingerprinting censored 18/61 on the declared arm, almost entirely
fingerprint-observer/dropped.

**Estimand under missingness.** Pooled-boolean rates on the screening-passing
frame; vendor-presence agreement restricted to request-complete cases;
rule-conformance over fingerprint-evidence-complete cases; per-proposition
split rates (warn-level disjunction vs listener claim) if the pooled boolean is
abandoned. About 62.2% host prevalence makes the reference-absent class the
binding denominator, the reverse of CNAME's arithmetic; the drafted N=400 has
no power derivation for this detector.

**Result type.** Mixed, and neither branch reaches accuracy: vendor branch is
vendor-presence agreement on a construct the detector does not measure;
per-kind branch is rule conformance.

### keystroke-exfiltration

**Exact claim being calibrated.** The typed sentinel was observed leaving in
network traffic. The only evidence exfiltration occurred is the sentinel the
detector's own probe generated, typed, and captured (lib/keystroke-exfiltration.ts:5-9),
so the program-standard blinded labeling construction is circular here: a
labeler re-executes the detector's matching rule over the detector's own
capture.

**Reference candidates.**
- Synthetic-positive lab pages (memo option b): independent; ground truth by
  construction; accuracy is real but its population claim is scoped to
  "a population nobody browses" and the memo forbids generalizing beyond it.
- Reference-absent open-web frame (option a): partially-derived; declaring
  absence still reads the probe's own capture, and steering the frame using
  corpus history damages the population claim.
- Cross-instrument agreement (a second sentinel-typing scanner; the module
  self-describes as the Blacklight test extended): independent instrument,
  same construct and methodology, so it yields agreement, never accuracy. Not
  recorded in any draft; noted here as an unrecorded option.

**Censoring.** Unit: one planned frame case under the frozen arm
(lib/detector-calibration.ts:186-191). The open-web probe path contributed
6/61 detector-output keystroke-probe drops on the declared arm. A synthetic
lab arm has a categorically different (near-zero) censoring exposure, which is
one reason policy scope must be stated per arm.

**Estimand under missingness.**
- Option (a): specificity only, sensitivity denominator structurally
  unreachable. This collides with the approved policy artifact's
  ratePublicationEligibility minimum denominators (referencePresent >= 100 and
  predictedDetected >= 100), which a specificity-only open-web study cannot
  satisfy; a decision to run (a) therefore requires amending the eligibility
  rule or accepting a non-publishable descriptive result.
- Option (b): sensitivity on the synthetic arm, population scoped to lab pages.
- Cross-instrument agreement rate, if ever admitted, on sites both instruments
  complete.

**Result type.** Mixed: accuracy on the synthetic arm only; the open-web leg is
rule conformance or agreement. The choice between (a) and (b) is recorded as a
deliberate, still-unmade operator decision
(docs/calibration-prereg-drafts/README.md:112-117, verified).

**Also recorded.** The sole corpus positive (weather.gov to arcgis.com) is
described from detector output; no independent confirmation of that positive
exists anywhere read, so even the anchor example of the present class rests on
the instrument.

### cname-uncloaking

**Exact claim being calibrated.** A contacted first-party subdomain resolves
through a CNAME chain to a classified third-party tracking service. The
prediction is any retained cnameCloaks row
(scripts/calibration-study-lib.mjs:1271-1272, verified); the reader's warn card
exists only for tracking-classified matches, a construct gap the
preregistration must close or disclose.

**Reference candidates.** This is the one detector with a genuinely
independent replacement protocol, and it is the template the others lack:
- Reviewer-side DNS through a reviewer-named resolver, with the exact
  reproducing dig command written into the worksheet.
- An external, publicly published tracking-service list pinned by SHA-256,
  loaded from reviewer-supplied bytes; a guard test asserts the reference
  module imports nothing but Node builtins, so catalog errors surface as real
  false negatives instead of invisible agreement.
- The reviewer's own browser capture (HAR) as the candidate-subdomain source;
  chosen precisely because no repo code produces HAR.
- The superseded drafted protocol (recorded chains judged against a
  catalog-drawn appendix) is circular and remains in labeling-protocol.md even
  though the plan draft forbids it; see cross-cutting drift below.
- Certificate transparency: independent but declined by name for scope (it
  finds hosts the page never contacted).

**Censoring.** Unit: one frozen case. The detector's fragility is structural:
one DNS flake on any of up to ten candidates marks the whole ledger failed and
censors the case (lib/scanner.ts:2441-2448), so per-case survival is roughly
per-lookup success raised to the candidate count. The corpus arm shows 88.5%
CNAME-scoreable, and 27 arm cases are CNAME-scoreable but rejected by
zero-censoring for losses in families (detector-output, fingerprinting,
storage) that a DNS-chain reference never touches.

**Estimand under missingness.** Complete-case sensitivity/specificity/PPV/NPV
against the independent reference on the declared high-prevalence pool;
scoreable-case-conditional versions of the same; condition-invariance across
consent arms (already measured descriptively: 64 hosts, zero gained).

**Result type.** Accuracy, with two honest residuals: the reference is a
different visit at a different time through a different network, and scope
alignment (contacted subdomains only, apex skipped) is by protocol rather than
shared code.

**Also recorded.** The prereg drafts said a 12-host lookup cap against the
shipping MAX_CNAME_LOOKUPS = 10 (lib/scanner.ts:278); resolved during step 4
by moving the drafts to 10, since a preregistration describes the instrument
that ships.

### pixel-events

**Exact claim being calibrated.** A recognized advertising-pixel request was
decoded (Meta/TikTok/X endpoint predicates). Every drafted reference restates
the detector's own endpoint predicates in prose and applies them to the same
retained request log, with query and body content explicitly irrelevant to the
label; the committed pilot did the same with LLM labelers and is pilot-only by
its own ground rules. No reference independent of the scanner's capture exists
or is drafted.

**Censoring.** Unit: one frame case. The load-bearing operational fact is the
arm: the observe arm is where positives occur (17 retained corpus runs across
5 hosts; 8 of 23 served screening pages), while the required accept-all arm
rarely completes from the current US egress, and 13 served TCF-pool sites
returned choice-unavailable with the screening explicitly refusing to decide
why. An EEA/UK egress would move the arming rate and simultaneously change the
declared population; no such egress exists in the current operator setup.

**Estimand under missingness.** Conditional presence-classification rates
against endpoint-rule labels on the frozen frame; descriptive confusion counts
on a convenience frame (the pilot's shape); operational feasibility rates of
the measurement arm itself; base rate of decodable firing under observe.

**Result type.** Rule conformance: conformance of the implemented decoder to
the documented endpoint rule under independent re-execution. That does catch
real decoder defects; it is not accuracy about tracking behavior. Note also
the tier gap: the calibration prediction is presence-only while the report's
strongest tier asserts populated identifier fields, and no drafted reference
covers that tier.

**Also recorded.** The five corpus hosts that fire under observe with GPC on
are schema=1 rows never re-run under the current build, so even the observe-arm
base-rate evidence predates the current instrument identity.

### consent-banner

**Exact claim being calibrated.** Two propositions share the detector id, and
the study must name one:
- The PUBLISHED card asserts "a consent management platform was requested", a
  curated loader-domain signature match over the request log. No study design
  at HEAD targets this proposition.
- The CALIBRATABLE seam (banner-visibility@1) predicts that a first-layer
  consent control was visible, and can be scored against blinded human
  visibility labels. Its prediction derives from the process-local measurement
  envelope, not the public report (lib/calibration-scan-runtime.ts:57-74), and
  unlike detectorPredictionFromRun it never consults run-level quality, an
  asymmetry the preregistration must either justify or repair.

**Reference candidates.** Plan-draft blinded human labels: partially-derived
(mutually blinded and human-adjudicated, but the bundle is produced by the same
scanner visit and capture pipeline; a banner the capture failed to retain is
invisible to both sides). The legacy shared protocol's disjunction (CMP loader
request OR visible control) is circular for the published proposition and
structurally mismatched for the seam; F2 already records that scoring the
visibility predictor against it makes region-gated CMP loads score as errors.

**Censoring.** Unit: one planned frame case, retained as a governed
censored-attempt row. One integrity edge is one-shot-fatal rather than
censoring: CalibrationMeasurementInvariantError is rethrown as fatal by the
acquisition loop (scripts/calibration-study-acquire.mjs:203-208), so an
invariant breach on any single case destroys the ceremony. Under the
non-retryable ceremony rule this is a real study-level risk that the step-3
decision should weigh explicitly.

**Estimand under missingness.** Sensitivity/specificity of banner-visibility@1
against adjudicated visibility labels on the frozen frame; detector-free
prevalence of visibly offered consent controls; complete-case-conditional
agreement under a relaxed policy. Not estimable by any current machinery:
error rates for the published CMP-requested proposition.

**Result type.** Mixed: accuracy for the seam proposition; the published
proposition currently has no calibratable design at all. Sizing is undone: the
draft fixes N=400 while F2 records CMP loader reach at 16.3% of hosts under
the relevant arm.

### privacy-policy

**Exact claim being calibrated.** The pipeline discovered, fetched, and
summarized a privacy policy. This detector reads declarations, never behavior.

**Structural fact that reshapes the whole study.** The scanner marks the
privacy-policy ledger complete only when a non-null summary exists; a null
summary is a failed ledger with a capture loss (lib/scanner.ts:2585-2596,
verified). The prediction is presence of evidence.privacyPolicy. Therefore
every scoreable prediction is "detected" and the not-detected class is
structurally empty: sensitivity/specificity framing collapses, and the honest
estimands are (1) positive-presence agreement among scored cases, (2) the
censoring-reason composition over the full frame, and (3) discovery-completion
among reference-present cases. Compounding it, the pinned reason
eligibility-criteria-not-met covers both "the site offers no policy link" (a
subject property) and "our probe ran out of budget" (an instrument limit), so
the reason vocabulary cannot separate absence from failure.

**Reference candidates.** Preregistered blinded labelers over recorded link
evidence: partially-derived (same capture, same policy-shape vocabulary; the
label asserts only a reachable policy destination while the prediction also
requires fetch success and extraction thresholds, a construct mismatch the
prereg must state). Out-of-band live-site discovery would be independent but
breaks the label-is-a-property-of-recorded-evidence blinding model and
introduces temporal drift. References for the contradiction and disclosure-gap
halves are circular by construction (catalog-derived observed-entity lists,
project alias vocabulary), and the drafted plan does not score those halves at
all, which is a scope-leakage risk: the reader-facing value of this detector
is precisely the halves the study would not cover.

**Result type.** Rule conformance over captured links plus fetch/extraction
completion.

## Cross-cutting facts the step-3 decision rests on

**The censoring evidence, with its own boundaries.** On the declared arm
(n=61): detector-output censored 32.8%, fingerprinting 29.5%, requests 9.8%,
storage 1.6%, cookies and consent-verification 0%. Bare-load soundness is
61/61, so load-reliability screening cannot move these rates. Clustering is
severe and explicitly non-iid: one build carries 120 of 126 runs, the arm has
two clusters, and the corpus README states it cannot support cluster-robust
inference. The arm all-family zero-loss rate is 27/61 (44.3%), quotable only
with the cluster caveat and never as an open-web probability. All 24
null-detail request losses are GPC-on runs outside the arm; the pooled 73.8%
scoreable figure is an instrumentation artifact and the arm figure is 88.5%.

**The policy option space.**
- A, complete-case-only-zero-censoring: selected, approved 2026-08-02, and the
  same record's methodologicalAssessment reads: "The currently supported
  analyzer policy is near-unsatisfiable on the open web (pilot capture
  failure: 37.5%). Its presence in currentlySupportedSelections is not a
  recommendation to approve or use it." One censored case makes the study
  ineligible. Every A simulation row fails at every modeled N and operating
  point.
- B, detector-scoped-complete-case: analyzes cases whose detector-required
  inputs are whole; inference scope is the scoreable subpopulation unless the
  preregistration predefines the population as screening-passing sites or
  pairs B (descriptive) with C (population claim). Numerically eligible at
  N=350/500 for two of three modeled operating points, always scope-tagged.
- C, bounded-censoring-with-sensitivity-analysis: admits all bare-load-valid
  cases and carries indeterminates adversarially as a Wilson envelope over
  realizable 2x2 assignments; fails the width requirement everywhere modeled
  once the worst realizable missing-reference composition governs.
- Simulation operating points are assumptions; the corpus has no independent
  references; no categorical "N clears" claim exists to quote.

**Figures that are recorded as NOT quotable**, so the decision does not lean
on them: any cluster-robust arm interval (two clusters); the 78.2% scoreable
lower endpoint; any pooled q^N (deliberately never computed); the pooled 73.8%
as an arm figure; the retracted claims (98.4% "component-recoverable", C
clearing at N=500 under balanced composition, "precision binds everywhere");
category strata at n=6 to 9.

**Per-detector recovery structure, the fact that makes per-detector policies
coherent.** The 27 arm cases rejected by zero-censoring are CNAME-scoreable
and were lost only to detector-output (16), fingerprinting (15), and storage
(1): families a DNS-chain reference never consults. A per-detector B for
cname-uncloaking would recover most of them; the same move does nothing for
fingerprint-heuristics, whose dominant loss IS its own causal family. Policy
fit is therefore detector-specific in a way a single global choice cannot
express.

**The proposition-naming requirement.** Four of six detectors carry a gap
between the calibration boolean and the published claim: fingerprint pools two
differently-hedged claims; consent-banner's seam predicts a proposition its
published card does not state; pixel-events calibrates presence while the
report's strongest tier asserts identifier fields; privacy-policy's study
covers discovery while the reader value is the comparisons. Whatever policy is
chosen, each published rate must name the proposition it covers, or it will be
read as covering the headline.

**Draft drift inside the prereg documents.** labeling-protocol.md still
contains the circular cname protocol its own plan draft forbids, and the
consent-banner disjunction its plan draft supersedes. The repository's top
recorded defect class (one contract restated in two files) is present inside
the calibration drafts themselves and must be resolved before any frame is
sealed.

**Dead and overloaded vocabulary.** reference-label-uncertain is pinned in the
censor-reason vocabulary but nothing emits it; capture-failed collapses
mechanistically different losses (page never loaded vs cap ate the candidate
set); the distinction lives only in the retained artifacts.

## What step 3 decides, stated precisely

Against this matrix, the operator decides, possibly per detector:

1. Retain A, replace with B or C, or adopt a per-detector assignment, knowing
   the inference-scope tag each choice carries.
2. For keystroke-exfiltration: memo option (a) or (b), and if (a), whether the
   minimum-denominator rule is amended or the result accepted as
   non-publishable.
3. Whether fingerprint-heuristics proceeds at all before an independent
   behavioral construct exists, or proceeds explicitly as
   vendor-presence-agreement / rule-conformance with the result type named in
   the published rate.
4. Which proposition each published rate names, per the proposition-naming
   requirement above.

This document does not recommend among these. It exists so the decision is
made against the recorded structure rather than against the gate dashboard.
