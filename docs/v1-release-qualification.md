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
| Inspect a truthful observation | Current deep readers and consistency checks | Population accuracy or detector error rates; that a person compared any report with an independent reference |
| Understand uncertainty and interventions | No gate of its own. The scanner's tests run in CI on the candidate, and the signed formal verification report covers the suites it lists | That a covered negative is universal absence, or an intervention proves compliance; that a person reviewed how any report presents unknowns, scanner effects or an incomplete visit |
| Reopen and share the same meaning | Compatibility and corrections gates | Reconstruction of observations never recorded; a human review of display, comparison, persistence or export |
| Use a safely operated service | The approved recovery scope, with durable jobs, sharding and watches committed off. No provider evidence | Reliability of disabled durable jobs; an egress boundary independent of the application guard; a re-verified log-retention window; that the storage bucket's lifecycle rule or the provider's rate rules are in place |
| Identify the shipped instrument | Source-bound CI evidence, an evidence-only carrier, external binding approval, promotion and live verification | Correctness merely because a build passed |
| Know the bounded checks ran on the shipped source | A signed execution report for the candidate: every required suite file ran, no test or describe block was skipped, left todo or failed, and each file met its pinned minimums of tests passed and catches recorded | That a claim holds outside its stated domain, or that a restated rule is the right rule |

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

## Provider settings 1.0 does not read back

- **Report storage lifecycle (`r2-lifecycle`, removed 2026-11-11).** Release
  1.0 reads no lifecycle receipt, and a 1.0 evidence carrier that binds one is
  refused. The application enforces report retention itself: it stops serving
  a saved report at its expiry and prunes by age and count, and
  `lib/report-store.test.ts` holds that. The bucket's own eight-day deletion
  rule is a provider setting that can change the day after a release, so a
  readback at release time said nothing about the days that follow. A 1.0
  release therefore does not establish that the rule is in place.
  `.github/workflows/r2-lifecycle-evidence.yml` remains as an operations
  check, dispatched by hand. The dated receipt at
  `research/ops-receipts/r2-lifecycle-readback.json` remains as a record, and
  `lib/report-store.test.ts` holds the application's retention ceiling below
  the rule that receipt recorded.
- **Provider rate rules (`waf-ceilings`, removed 2026-11-11).** Release 1.0
  reads no WAF receipt and no operator attestation of one, and a 1.0 evidence
  carrier that binds either is refused. The scanner's own admission limits
  are in code and held by its tests. The provider's rate rule on the two
  admission routes is the outer abuse filter, and it too is a setting that
  can change the day after a release. A 1.0 release therefore does not
  establish that the rule is in place.
  `.github/workflows/waf-ceiling-evidence.yml` remains as an operations
  check, dispatched by hand.

## Formal verification suites

Release 1.0 requires the `formal-verification` gate.
[`docs/formal-verification.md`](formal-verification.md) lists what the bounded
suites hold, each claim over a stated domain. The gate requires evidence that
those suites ran at the candidate.

- **The required suites.** The gate's `requiredSuites` in
  `RELEASE_READINESS.json` names every test file the register cites, each with
  a pinned minimum of tests that passed and of catches recorded
  (`minimumVariants` counts catches, not distinct variants).
  `scripts/v1-release-contract.mjs` pins the same list. Removing the gate,
  changing its kind, dropping an entry or lowering a minimum is a refusal. The
  minimums are change detectors: one refuses a suite that lost tests and says
  nothing of the tests it keeps.
- **The report.** `npm run release:formal-verification-report -- --output <file>`
  runs each required file alone at a clean commit and writes one canonical
  execution report: for each file, the test runner's counts, its own counts
  of what those leave out, every test by name with its outcome, and every
  catch the harness recorded, with the variant's name, the property the suite
  named and the property that caught it. It writes
  nothing if a test was skipped, left todo, failed, cancelled or failed as
  expected, if a describe block was skipped, left todo or failed as a block,
  or if a minimum was not met. The test runner counts no failure for a
  describe block that fails as a block, and on the Node this repository pins
  (24.14.1) it also exits cleanly on one. It counts a test that failed as
  expected as passed. Both are therefore read from its events. That reading
  was derived on the pinned Node, and its tests also pass on the container
  image's Node (24.22.1), which differs in two of the cases; it must be
  derived again when the pin moves. `--dry-run` judges the same run on a
  working tree and writes nothing.
- **The binding.** The carrier commits the report and its Sigstore bundle at
  `research/measurement-candidate/site-behavior-lab-formal-verification-report.json`
  and `research/measurement-candidate/formal-verification-report.bundle.json`.
  The binding requires both and authenticates the bundle against the report's
  exact bytes, signed by CI on `main` at the candidate commit. The gate then
  requires the report to name the candidate's commit and tree and to meet
  every entry.

CI's `formal-verification` job writes the report for every commit CI tests and keeps it for
90 days as `exact-sha-formal-verification-report-<sha>`. On `main`, the
`attest` job checks that the report names that commit and is in its canonical
bytes, signs it, and keeps the bundle as
`exact-sha-formal-verification-attestation-<sha>`. The producer and the gate
judge a report with one function against one list, so the report of a green
`main` commit meets the gate's content rule. Until a carrier binds a signed
report for a candidate, the gate fails, and `npm run release:readiness` shows
it as failing today.

What a pass does not establish. The report shows that the cited tests ran and
passed at the candidate. It holds no count a suite pins inside a test and no
method. Its catches are lines the harness appended to a log during the run:
the suite's own process writes that log, so the catches are not independent of
the suite, the gate holds only their number and that none names another
property, and a variant caught for two properties counts twice. The report's
counts, outcomes and catches are the producer's signed statement of one run;
the gate re-derives its verdict from them and does not run the suites again.
The gate does not compare the report's test names with the register's
citations; the register's own guard test holds those in the unit suite. A pass
adds nothing to what a row of the register claims, and a row claims nothing
outside its stated domain, bounds and axioms.

## No mode review

Release 1.0 has no mode review. The `mode-qualification` gate was removed on
2026-11-11. It asked a named person to review five reports (one visit, the
GPC, blocker and consent comparisons, and an incomplete visit) against
references that the same person had collected. A machine could check that the
reports parsed, that their producer was the candidate and that every cited
byte was bound. It could not check that a reference was independent or true,
and in a project with one maintainer the review was that maintainer's own
sign-off.

So a 1.0 release does not establish that any person compared a report with an
independent reference, for any mode. Consent comparison remains experimental.
A 1.0 evidence carrier may not bind anything under `research/v1-qualification/`:
the binding refuses those paths.

What remains is machine-checked and is not release evidence. CI runs the unit
and browser suites on every commit. The controlled reference capture described
under "Collect controlled reference cases" below is a tool a maintainer can
run by hand; CI does not run it.

## Source and evidence sequence

1. Finish source, configuration, release metadata, compatibility decisions and
   reusable license materials. Select a tested commit **C**, with durable jobs,
   sharding and watches still disabled. Run the existing main CI and production
   verification. Selection does not require a Monday, a scheduled collection or
   enabling a disabled feature.
2. Collect the evidence on C or an evidence-only
   descendant. Retain the existing CI container evidence, package inventory and
   their Sigstore bundles, and the formal verification execution report with
   its bundle, all from the `main` CI run at C, and the release governance
   receipt. Release 1.0 requires no provider evidence and no operator
   attestation.
3. Add `research/v1-release-binding.json` in the final evidence carrier **S**.
   It has schema version 1, kind `site-behavior-v1-release-binding`, repository,
   target release `1.0.0`, C's full `candidateCommit` and `candidateTree`, and an
   `evidence` array of `{category, path, change, sha256}` entries. The verifier
   restricts entries to the fixed evidence paths and checks every C..S commit.
   All evidence is introduced once, and no bound file may be modified after C.
   Code, configuration, existing reports, policies and workflows
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

The contract does not supply the missing source binding or external
governance selection. Those are concrete steps of the release ceremony
to take before v1, not reasons to restart the research calendar.
The egress and log-retention gates are not among them. They refuse
caller-supplied provider evidence, no trusted hosted capture exists for either,
and both are deferred to 1.1.0 as described above. The formal verification
report is not a manual gap either: CI writes and signs one for each `main`
commit, and it reaches its gate when the carrier binds the candidate's.

## Collect controlled reference cases

This capture is a tool, not release evidence. No gate reads its output, and a
1.0 evidence carrier cannot bind it. It checks the scanner against a server
whose request log is recorded independently of the scanner. The unit suite
tests its reference checks on synthetic reports (`scripts/v1-qualification.test.mjs`)
and does not run the capture itself.

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
causes a nonzero exit, but its available evidence remains. The capture
approves no reference. Public DNS, TLS,
Cloudflare ingress, R2 and actual browser rendering remain separate validation
obligations. These examples do not establish population accuracy or error rates.

