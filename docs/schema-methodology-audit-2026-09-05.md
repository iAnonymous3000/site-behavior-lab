# Schema and methodology audit — 2026-09-05

The product turns an instrumented website visit into inspectable evidence. Its
contract must let a reader distinguish what happened, what the instrument could
observe, what the observations support, and what later review changed. This
audit extends the approved lean-v1 work in PR #222. The additional reproducible
failures below were observed at `6fc5fe54f7f085dd24a7a1c282c14a8801a63916`.

## Contract derived from the product

1. **Observation:** retain the requested and returned subject, visit and phase,
   request/response observations, state snapshots, interventions, and applicable
   evidence references. A detector label is an interpretation of those inputs.
2. **Coverage:** retain attempts, omissions, losses, failures, unsupported
   surfaces and bounded observation time. Zero retained observations, no usable
   measurement and measured absence have different meanings. A complete capture
   of a returned error page does not establish a successful requested visit.
3. **Instrument:** identify the implementation, methodology, runtime, catalog,
   lists and normalization used. Scanner-induced input and suppressed browser
   behavior are part of the conditions, not ordinary-user behavior.
4. **Interpretation:** derive claims from the required evidence families and
   detector availability. Retained request counts can be lower bounds within
   that instrumented visit. End-state snapshots are not monotonic; neither
   quantity bounds an unmeasured ordinary-browser visit. Sequential comparison
   supports descriptive differences, not causal or legal conclusions.
5. **Publication:** preserve the public measurement and its identity. Later
   corrections remain separate and discoverable. Importing, composing, displaying
   or exporting must not silently detach the notices used to interpret it.

These requirements do not justify manufacturing historical phases, coverage or
provenance. Legacy-derived views must remain labeled as derived, and historical
unknowns must remain unknown.

## End-to-end review and decisions

| Path | Evidence boundary and disposition |
| --- | --- |
| Measurement — `scan-runtime.ts`, `measurement-kernel.ts`, detector producers | The preceding v1 changes correct pixel/policy interpretation and record input-probe omissions and scanner actions. Detector and methodology identities change with behavior; outgoing producer identities remain readable. Fixtures verify mechanisms, not population accuracy. |
| Wire admission — `scan-report-reader.ts`, revision validators and evaluators | Keep structural rejection, semantic inconsistency and unsupported future versions distinct. Recompute quality, fingerprints, summaries, consent verification, comparison and diff under the admitted historical contract. Internally generated fixtures alone cannot validate their own methodology. |
| Persistence — public projectors, `report-store*.ts`, correction ledger | Keep the existing public projection boundary and immutable stored reports/sidecars. No additional redaction, migration, schema-alias movement or rewriting of published measurements. Missing jobs recover a saved report before reporting terminal failure. |
| Interpretation/display — report views, facts, headline, findings, JSON-LD | Preserve family-specific claim gates and returned-document scope. Centralize failed-visit request status for the header and CSV. Capture coverage remains a separate fact rather than a fabricated loss event. Narrow the unestablished Brave approximation claim in public methodology. |
| Comparison — compatibility decisions and `temporal-report-comparison.ts` | A real corrected historical pair passed compatibility, then lost all correction context. Refuse composition of reports with published notices because a derived wire cannot retain the parent notice linkage. Keep individual reports readable and clean compatible comparisons available. |
| Import/export — loaded-report envelope, CSV and ZIP download | Local import previously stripped `share.id`; re-export/reopen restored suppressed findings. Preserve recorded identity and make local sharing a UI-only decision. CSV downloads now include the public source report and correction snapshot, even with zero rows; comparison CSV filenames name the selected arm. |
| Aggregate publication — manifest, corpus exports/statistics, gallery, feeds, sitemap | The preceding v1 changes carry correction context and exclude corrected reports from findings-led indexing and distributions. Loaded coverage and distribution eligibility remain separate. Cohorts retain schema, methodology, producer and metric identities. |

The correction roundtrip was reproduced with
`20260625-e633e42c3ccc90348ea024fe00356d18`; its local temporal pairing with
`20260706-7eba401fdd41ef20f5baf2651d4cf6e7` also lost the notices. Both cases are
now regression tests against the original archived inputs. A 403 visit likewise
previously said `complete` in header facts and `failed` in its CSV.

## Compatibility decision

Keep v1, v2/r1 and v2/r2 readable. No new measurement-schema revision is needed
for these fixes: the existing wire already carries report identity, quality and
instrument facts. Local sharing capability belongs in the consumer envelope.
CSV columns keep their order and meaning; the download ZIP adds the existing
report JSON and correction context rather than inventing a metadata row.

The deliberate limitation is portable composition with later correction context.
Blocking that operation is the lean-v1 choice. A future evidence-package contract
could bind source artifacts and notices by digest and support composition/import;
that requirement should be demonstrated before expanding the measurement wire.
These downloads do not include a full provenance sidecar or signed attestation.
They are not the deferred research-grade evidence package.

An imported ID is a correction lookup key, not authentication of the file. The
included correction snapshot reflects the app build's ledger. Older offline
readers cannot know later notices; consumers must consult the published ledger
before relying on an archived report. Removing an ID externally also removes the
lookup key. No claim of tamper-proof custody or universal correction discovery
is made.

## Validation and remaining direction

Validation is recorded separately for four questions:

- **Structural validity:** frozen-schema hash checks, generation-aware readers,
  typechecks, and byte-preserved historical inputs.
- **Internal consistency:** semantic evaluators, independently specified 403 and
  correction-roundtrip expectations, real corrected comparison inputs, and CSV
  and JSON-LD agreement. These checks cannot establish that a detector's model
  matches the world.
- **Operational reliability:** full tests, actual browser import/download/reopen,
  builds, and CI. The ZIP test uses an independent system reader; Docker now
  declares its missing build-stage `unzip` prerequisite instead of skipping it.
  A green build does not prove deployed scan completion or restart reliability.
- **Real-world accuracy:** representative current-candidate mode qualification
  and independent corroboration remain outstanding. No detector error rates,
  native Brave equivalence, legal compliance or causal effects are established.

Next: finish review and CI on the exact candidate, qualify each advertised mode
with retained attempt denominators, and obtain the candidate-bound publication,
runner and operator evidence required by release readiness. Formal error-rate
calibration remains the separate 1.1 milestone. Keep consent visibly experimental,
durable flags disabled and release gates unchanged. See the
[v1 implementation plan](v1-implementation-plan.md) for the release sequence.
