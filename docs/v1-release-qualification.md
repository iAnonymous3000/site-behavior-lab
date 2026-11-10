# V1 release qualification

Approved in the project task on 2026-09-06. V1 lets a user investigate a visit,
inspect the recorded evidence, and share conclusions that remain within that
evidence. This approval changes the requirements; it does not approve a release
or certify evidence that has not been collected.

`RELEASE_READINESS.json` selects `investigative-v1`. Its complete gate set is
enforced: deleting a gate or changing its kind is a refusal. Four gates are
deferred to 1.1.0 and held by name in `deferredGates`: removing a deferral
record, or restoring one of those gates without the reviewed edit to
`scripts/v1-release-contract.mjs`, is also a refusal. The previous
research contract is preserved verbatim in
`docs/release-gate-history/research-program-2026-09-05.json`. Existing research
verifiers and historical reports, schemas, receipts and approvals remain intact.

## What must hold

| User promise | Release requirement | What it does not establish |
| --- | --- | --- |
| Inspect a truthful observation | Current deep readers and consistency checks; bounded independent mode review | Population accuracy or detector error rates |
| Understand uncertainty and interventions | Review unknowns, scanner effects and interpretation, including an incomplete visit | That a covered negative is universal absence, or an intervention proves compliance |
| Reopen and share the same meaning | Review display, comparison, persistence and export against retained evidence; compatibility and corrections gates | Reconstruction of observations never recorded |
| Use a safely operated service | Authenticated admission-ceiling, report-lifecycle and exact-image distribution evidence | Reliability of disabled durable jobs; an egress boundary independent of the application guard; a re-verified log-retention window |
| Identify the shipped instrument | Source-bound CI evidence, an evidence-only carrier, external binding approval, promotion and live verification | Correctness merely because a build passed |
| Know the bounded checks ran on the shipped source | A signed execution report for the candidate: every required suite file ran, no test was skipped, each pinned minimum was met and every variant was caught for its reason | That a claim holds outside its stated domain, or that a restated rule is the right rule |

## Operational protections 1.0 does not verify

Two operator gates are deferred to 1.1.0. `RELEASE_READINESS.json` records each
in `deferredGates` with its reason. Neither could pass as written: each accepts
only a GitHub-hosted provider capture, no such capture lane exists for either,
and a hand attestation is refused.

- **Independent egress boundary (`egress-backstop`).** Release 1.0 does not
  verify an egress boundary that is independent of application code. The
  application's own egress guard is the only boundary that exists. A review
  on 2026-11-01 found no documented configuration of the hosting platform, on
  the current plan, that offers an independent one. If the application guard
  fails, nothing that 1.0 verifies
  stops a scan from reaching a private, link-local or metadata address.
- **Log retention (`log-retention`).** Release 1.0 does not re-verify the
  log-retention window and does not re-capture a redacted log query for the
  candidate. The configured retention and the redaction tests are what exist.
  The dated operator receipts in the runbooks are not release evidence.

Both gates keep their definitions, evidence producers and verifiers. The
release binding does not require their evidence for 1.0. Evidence for either
gate that a carrier binds anyway is evaluated in full and counts toward
readiness, so it still fails until a trusted capture lane exists.
`npm run release:readiness` lists both gates as `DEFERRED`, with no verdict.
Meeting `egress-backstop` needs a capture lane and a platform boundary first.
Meeting `log-retention` needs a capture lane first.

## Formal verification suites

Release 1.0 requires the `formal-verification` gate.
[`docs/formal-verification.md`](formal-verification.md) lists what the bounded
suites hold, each claim over a stated domain. The gate requires evidence that
those suites ran at the candidate.

- **The required suites.** The gate's `requiredSuites` in
  `RELEASE_READINESS.json` names every test file the register cites, each with
  a pinned minimum of tests that passed and of variants caught.
  `scripts/v1-release-contract.mjs` pins the same list. Removing the gate,
  changing its kind, dropping an entry or lowering a minimum is a refusal. The
  minimums are change detectors: one refuses a suite that lost tests and says
  nothing of the tests it keeps.
- **The report.** `npm run release:formal-verification-report -- --output <file>`
  runs each required file alone at a clean commit and writes one canonical
  execution report: for each file, the test runner's counts, every test by
  name with its outcome, and every variant the harness caught with the
  property that caught it. It writes nothing if a test was skipped, left todo,
  failed or cancelled, or if a minimum was not met. `--dry-run` judges the
  same run on a working tree and writes nothing.
- **The binding.** The carrier commits the report and its Sigstore bundle at
  `research/measurement-candidate/site-behavior-lab-formal-verification-report.json`
  and `research/measurement-candidate/formal-verification-report.bundle.json`.
  The binding requires both and authenticates the bundle against the report's
  exact bytes, signed by CI on `main` at the candidate commit. The gate then
  requires the report to name the candidate's commit and tree and to meet
  every entry.

No CI job writes or signs that report yet, so no candidate can meet this gate
today, and `npm run release:readiness` shows it as failing.

What a pass does not establish. The report shows that the cited tests ran and
passed at the candidate. It holds no count a suite pins inside a test and no
method. The gate does not compare the report's test names with the register's
citations; the register's own guard test holds those in the unit suite. A pass
adds nothing to what a row of the register claims, and a row claims nothing
outside its stated domain, bounds and axioms.

## Bounded qualification

Retain one case for each obligation: `single-observation`, `gpc-intervention`,
`blocker-intervention`, `consent-intervention`, and `incomplete-coverage`.
These are coverage obligations, not a statistically representative sample.
The comparison cases require an actually verified pair on the correct axis.
The incomplete case requires recorded loss or failed document coverage.
Consent remains experimental even when this bounded review passes.

For each case, retain the current v2/r2 report, an independently captured
reference, and a concrete expectation. A reference can include a controlled
server's request log, a separately recorded browser trace, or a manual inspection
record. A copy of the report's own conclusions is not independent evidence.
Retain failures and contradictions encountered during qualification; resolve a
contradiction by fixing the candidate and recollecting, not by marking it passed.
The review is limited to these cases and explicitly describes remaining gaps.

The named review at `research/v1-qualification/review.json` has schema version 1,
artifact kind `site-behavior-v1-mode-qualification`, `candidateCommit`,
`reviewedBy`, `reviewedAt`, `cases`, and `limitations`. Each case contains `id`,
`mode`, `report`, `reference`, `expectation`, and `checks`. Checks cover
`observations`, `unknowns`, `scanner-effects`, `interpretation`, `display`,
`comparison`, `persistence`, and `export`. Each records `status`, a bound
`evidence` path, and an `explanation`. Shipped behavior must be `supported`;
only comparison on a single visit can be `explicitly-unavailable`.

Reports live at `research/v1-qualification/<case>/report.json`; references and
inspection records use `reference` or `review-evidence` with `.json`, `.txt`, or
`.png` extensions. The verifier deep-reads every report, checks intervention
identity and acquisition chronology, and requires all referenced bytes in the
binding. Human review still has to establish independence and correctness of
the references. These checks cannot authenticate a person's observations on
their own. The externally pinned whole-binding review remains mandatory.

## Source and evidence sequence

1. Finish source, configuration, release metadata, compatibility decisions and
   reusable license materials. Select a tested commit **C**, with durable jobs,
   sharding and watches still disabled. Run the existing main CI and production
   verification. Selection does not require a Monday, a scheduled collection or
   enabling a disabled feature.
2. Collect qualification and authentic operator evidence on C or an evidence-only
   descendant. Retain the existing CI container evidence, package inventory and
   their Sigstore bundles. Complete the exact-image package review. Provider
   evidence still needs its existing authenticated capture, freshness and
   failure-probe checks. A hand-written statement cannot replace those proofs.
   `npm run release:attestation-scaffold -- --gate <gate-id>` can prepare
   the operator review from canonical evidence before the binding exists. Its
   statements remain false and its approval fields empty; it grants no release
   authority and cannot pass readiness.
3. Add `research/v1-release-binding.json` in the final evidence carrier **S**.
   It has schema version 1, kind `site-behavior-v1-release-binding`, repository,
   target release `1.0.0`, C's full `candidateCommit` and `candidateTree`, and an
   `evidence` array of `{category, path, change, sha256}` entries. The verifier
   restricts entries to the fixed evidence paths and checks every C..S commit.
   All evidence is introduced once; only the container review ledger may be
   refreshed once. Code, configuration, existing reports, policies and workflows
   cannot change after C. A source fix requires a new candidate and recollection.
4. Run `npm run release:readiness:check`. Independently verify and hash the whole
   binding, then select that digest with the existing
   `RELEASE_MEASUREMENT_BINDING_SHA256` variable. Its historical variable name is
   retained. The release workflow selects the v1 artifact path and authenticates
   the raw bytes again before obtaining release authority. Governance selection,
   exact-S CI checks, artifact attestation, promotion App and live checks remain.

This smaller binding does not feed calibration readers or authorize calibrated
claims. The old `research/measurement-candidate-binding.json` remains the
research programme's separate contract. Its freeze, controlled-runner,
publication, calibration and durable prerequisites are not silently relaxed.

## Benchmarks and research

The existing 50-site per-metric floor still governs whether a benchmark can be
shown. It is not an accuracy threshold or a universal v1 prerequisite. The new
release gate recomputes the complete published corpus through the canonical
managed reader and compares every cohort, denominator, percentile and coverage
field. Small or unavailable cohorts are valid when they remain unavailable to
benchmark consumers. Historical data need not be recollected to stay readable.

Formal error-rate calibration and A/A remain a separate 1.1 milestone. Scheduled
research publication and durable activation retain their own qualification
requirements. No additional report redaction or measurement schema revision is
introduced here.

## Remaining blockers

The contract does not supply the missing mode review, source binding, external
governance selection, current lifecycle/provider evidence, or completed
dependency and exact-image license reviews. Those are concrete operational
evidence gaps to close before v1, not reasons to restart the research calendar.
The egress and log-retention gates are not among them. They refuse
caller-supplied provider evidence, no trusted hosted capture exists for either,
and both are deferred to 1.1.0 as described above.

## Collect controlled reference cases

Run `npm run release:qualification:capture -- --output /private/tmp/v1-capture-<unique-name>`
from committed, clean source. The parent directory must exist; the output must
be a new directory outside the checkout. The command recompiles the production
modules, binds their Git commit, and refuses changed source. It never overwrites
an earlier attempt or writes reports into the published corpus.

The controlled server records incoming HTTP requests before seeing any scanner
output. Real Chromium visits five fixed scenarios through the existing explicit
loopback transport seam. The capture checks the server's document status, script
and image delivery, GPC header and page-realm observations, the delivered versus
prevented analytics request, consent choices and scanner-induced input traffic.
The input beacon proves an active probe caused traffic; it does not establish
that typed data was transmitted. The blocking reference uses a reserved example
domain and a generic filter rule, so no third-party analytics server is contacted.

The same run commits each report through the managed filesystem store, reopens
it, compares JSON export with stored bytes, and evaluates presentation meaning.
For the failed document, an explicit non-reassuring load-failure headline is
required. The frozen `blockedByShields` field denotes a filter match in
classification mode; successful aborts are absent from delivered-request rows
and counted in the explicit verification facts. The reference checks those
meanings separately.

Each case retains `report.json` when construction succeeds, `reference.json`,
and `review-evidence.json` when the consumer checks complete. `capture.json`
records every attempted case, contradiction and artifact digest. A failed case
causes a nonzero exit, but its available evidence remains. The capture does not
create a completed `review.json` or approve any reference. Public DNS, TLS,
Cloudflare ingress, R2 and actual browser rendering remain separate validation
obligations. These examples do not establish population accuracy or error rates.

The v1 lifecycle receipt uses
`research/ops-receipts/v1-r2-lifecycle-readback.json`. The older receipt at
`research/ops-receipts/r2-lifecycle-readback.json` remains intact. A distinct path
lets a fresh receipt be introduced after C without rewriting historical evidence
or relaxing the evidence-only carrier rule.
