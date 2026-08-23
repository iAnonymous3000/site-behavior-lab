# Detector calibration operations

This is the operator contract for producing release-grade detector calibration
evidence. It does not create a label corpus, choose a censoring policy, or turn
an ineligible study into a rate claim. The pure analyzer in
`lib/detector-calibration.ts` remains authoritative.

The workflow supports all six governed detectors:

- `fingerprint-heuristics`
- `keystroke-exfiltration`
- `cname-uncloaking`
- `pixel-events`
- `consent-banner`
- `privacy-policy`

Scaffolding, acquisition, and binding recognize all six ids. The
`consent-banner` result is retained in a module-private process-local `WeakMap`
keyed by the exact scan envelope. It cannot cross JSON, object-spread, or
structured-clone boundaries; the calibration runtime has one narrow accessor.
A complete observation is retained as its own governed artifact and linked to
one complete passive detector phase. CMP request matching is never accepted as
a substitute detector output.

## Frozen candidate and evidence carrier

Release-grade calibration uses two distinct commits and never treats them as
interchangeable:

- **C is the frozen scanner candidate.** The controlled runner checks out and
  executes C. The build, detector implementation, registry, methodology,
  normalization, catalogs, lists, and runtime identities measured by the study
  are all C's identities.
- **H is the one protected evidence-only carrier for that ceremony.** H must
  be a fast-forward descendant of C and contains the exact canonical
  `calibration-labels/<studyId>/sources.json` commitment-coordinate manifest.
  The measurement binding must enumerate the manifest under
  `calibration-label-coordinate` and every other permitted C-to-H evidence
  path, change kind, and digest. The actual changed-path set must be set-equal
  to the binding and its digest-enumerated evidence paths: no unlisted path,
  forbidden change kind, deletion, merge, alternate carrier, or
  non-fast-forward history is accepted.

H is not a new measurement candidate. C-to-H may contain only explicitly
enumerated evidence and the binding that enumerates it; it may not change code,
detector logic, catalogs, filter lists, workflows, configuration, or any other
measurement input. Every trusted roster, acquisition, assembly, and
verification producer path at H must be byte-identical to its version at C.
The hosted roster authorization binds both C and H, and both the roster and the
sole acquisition run use H as their Actions head while the scanner itself
continues to execute C.

This separation lets commitment coordinates be fixed only after GitHub has
created the commitment artifacts without permitting a post-freeze code change.
It does not permit choosing a label roster after seeing predictions: H and the
complete authenticated roster are authorized before acquisition starts.

## Non-negotiable ordering

1. **Approve the policy.** The step-3 decision
   (docs/calibration-censoring-policy-decision.md) superseded
   `complete-case-only-zero-censoring` for new studies: the per-detector C/B
   policy artifact from step 4 is what `RELEASE_READINESS.json` must select
   and digest-bind (path, SHA-256, analyzer disposition digest, human
   approver, timestamp) before acquisition and before giving work to
   labelers. Until that approval exists, no new study starts under either
   policy.
2. **Preregister before candidate C.** Create the plan, frame, shared policy,
   and preregistration; add every candidate input to
   `research/measurement-candidate/measurement-inputs.json`; then freeze the
   final candidate. The workflow will not repair or reinterpret these files.
3. **Activate the measurement freeze.** The live repository variables and
   committed activation receipt must agree on the candidate, custom runner
   label, controlled egress, egress region, and r2 egress attestation.
4. **Commit every blinded label before acquisition.** Two through ten distinct
   GitHub actors independently seal full-frame label sources to the
   candidate-pinned public key and dispatch the hosted commitment workflow. One
   additional distinct actor must precommit a full-frame blind-tiebreaker
   source whether or not the labelers later agree. GitHub artifact creation
   times authenticate that every ciphertext commitment already existed before
   the acquisition run and job started.
5. **Create exactly one evidence carrier H.** Commit the canonical coordinate
   manifest as an append-only `calibration-label-coordinate` evidence path,
   place H on the protected main-branch lineage, and update the measurement
   binding's explicit evidence inventory. Verify C is an ancestor of H, the
   full C-to-H diff is set-equal to that inventory, and all trusted producer and
   verifier bytes are identical at C and H.
6. **Authorize one roster and one acquisition.** Dispatch **Calibration Label
   Roster Authorization** at H. Its server-timestamped artifact fixes C, H, the
   exact authenticated commitment set, the domain-separated case-input-root
   digest, and acquisition attempt 1 before it dispatches acquisition. The
   controlled self-hosted runner receives only frozen selection and condition
   files, executes C, and uploads predictions, retained scanner inputs, or
   governed censored-attempt records. It has neither the reveal private key nor
   Actions-artifact read permission.
7. **Reveal and assemble last.** Only the protected `calibration-label-reveal`
   environment exposes the private key, and only to the hosted assembly step
   after acquisition. The lane authenticates the successful Actions run and raw
   artifact ZIP by repository, workflow, H, run, attempt, artifact id, name,
   digest, size, and exact member manifest. It re-fetches the pre-acquisition
   roster and commitment artifacts, decrypts all sources, and uses the
   precommitted tiebreaker only for disagreements.
8. **Attest in isolation.** A separate GitHub-hosted job with no checkout,
   package installation, candidate execution, or self-hosted runner access
   attests the exact runtime receipt. The finalizer binds the Sigstore bundle
   before it can open a proposal.
9. **Merge only the generated proposal.** Finalization recomputes the study,
   analysis, runtime receipt, retained-input and label manifests, and
   measurement binding; verifies the complete committed evidence carrier and
   live GitHub custody state; then pushes one unique
   `automation/calibration-*` branch and opens a PR. If another evidence carrier
   merges first, close the conflicting PR and rerun assembly. Do not hand-merge
   generated evidence.

Calibration is perishable. The study release identity binds the exact build,
detector implementation, registry, methodology, normalization, tracker
catalog, Brave lists, Node, Playwright, Chromium, operating system,
architecture, runner, and egress. A later change to a bound identity makes the
study ineligible; it does not silently transfer old rates to new code.

The release-grade custody-lane study schema is
`/schemas/detector-calibration-study.v3.schema.json`. Published v1 and v2
studies remain readable as historical evidence; their immutable schemas are
not rewritten. V1 lacks a structured fixed measurement condition and remains
ineligible for rate publication. V3 preserves v2's condition binding while
replacing the ambiguous post-hoc adjudicator vocabulary with an explicit
precommitted blind tiebreaker. It also binds the archived roster authorization,
roster-selection ledger, and complete acquisition-attempt ledger by path and
SHA-256. Analysis v3 emits the exact structured condition and one
condition-scoped claim string; neither the target population nor a rate may be
presented without that condition.

Every release-grade v3 study uses one desktop, GPC-disabled measurement arm across its
entire frozen frame:

| Detector | Consent mode | Exact interpretation |
|---|---|---|
| `pixel-events` | `accept-all` | Rates are conditional on desktop visits where accept-all registration was verified and reverified after reload, with GPC disabled. |
| `consent-banner` | `observe` | Rates are conditional on desktop visits with GPC disabled under passive consent-banner observation with no consent action. |
| `fingerprint-heuristics` | `observe` | Rates are conditional on desktop visits with GPC disabled under passive consent observation with no consent action. |
| `keystroke-exfiltration` | `observe` | Rates are conditional on desktop visits with GPC disabled under passive consent observation with no consent action. |
| `cname-uncloaking` | `observe` | Rates are conditional on desktop visits with GPC disabled under passive consent observation with no consent action. |
| `privacy-policy` | `observe` | Rates are conditional on desktop visits with GPC disabled under passive consent observation with no consent action. |

The pixel arm is deliberately different: the pilot established that
sensitivity is not measurable under passive observe plus GPC. A pixel study
therefore measures only the consent-accepted arm and must never be described as
an all-visitors sensitivity estimate. “Consent-accepted” is not inferred from
the request or a click: a complete pixel case requires the r2 report to record
an activated accept-all control, `choiceState: "verified"`, and agreement again
after the bounded reload. Both summary fields are recomputed from the retained
strong-interpreter observations and phase ledger; stored `"verified"` text
cannot satisfy the gate by itself. A missing, weak, unavailable, failed, or contradicted
registration is retained as an `eligibility-criteria-not-met` censored attempt.
Consent-banner stays passive because its private visibility observation exists
only in `observe` mode.

## Candidate scaffold

Write a plan outside the repository, then run:

```bash
npm run calibration:scaffold -- \
  --plan /absolute/path/to/plan.json \
  --output-root "$PWD"
```

The plan has this ordered shape:

```json
{
  "schemaVersion": 2,
  "artifactKind": "site-behavior-detector-calibration-plan",
  "studyId": "pixel-events-2026-08",
  "detector": "pixel-events",
  "declaredAt": "2026-08-19T00:00:00.000Z",
  "targetPopulation": "The population named by the approved study protocol.",
  "labelSealingKey": {
    "algorithm": "rsa-oaep-sha256+a256gcm",
    "keyId": "sha256-of-canonical-spki-der-as-64-lowercase-hex",
    "publicKeyPath": "calibration/pixel-events-2026-08/label-sealing-public-key.pem",
    "publicKeySha256": "sha256-of-exact-canonical-pem-bytes-as-64-lowercase-hex"
  },
  "design": {
    "sampling": "simple-random",
    "selectionProtocol": "Exact bounded protocol text.",
    "referenceProtocol": "Two blinded independent reviewers.",
    "adjudicationProtocol": "One distinct blind tiebreaker precommits the full frame before acquisition and resolves only disagreements.",
    "measurementCondition": {
      "device": "desktop",
      "gpcEnabled": false,
      "consentMode": "accept-all",
      "interpretation": "Rates are conditional on desktop visits where accept-all registration was verified and reverified after reload, with GPC disabled."
    },
    "independentUnits": true,
    "predictionBlindedToReference": true,
    "referenceBlindedToPrediction": true
  },
  "cases": [
    {
      "caseId": "case-0001",
      "selectionDigest": "64-lowercase-hex",
      "conditionDigest": "64-lowercase-hex",
      "referenceEvidenceDigest": "64-lowercase-hex"
    }
  ]
}
```

Case ids and cases must be unique and sorted. The scaffold writes:

- `calibration/<studyId>/preregistration.json`
- `calibration/<studyId>/frame.json`
- `research/measurement-candidate/calibration-censoring-policy.json`

The policy is global and byte-identical across studies. `--check` reproduces
and compares the exact bytes without rewriting them. Dispatch preflight also
requires the simple-random, independent, mutually blinded design and at least
200 planned cases before anyone spends time labeling.

That 200 is a **structural floor, not a sample size**. The four class minimums
are two partitions of the same N (`referencePresent + referenceAbsent = N` and
`predictedDetected + predictedNotDetected = N`), so 100 in each of four classes
needs 200 cases, not 400. The preflight previously summed the four and demanded
400, which counted every case twice and rejected adequately powered designs for
no structural reason.

The floor says only that fewer cases *cannot* fill the four classes. It never
says a design of that size is adequate: real sizing comes from the detector's
prevalence and the recall it must tolerate, and is argued in each study's
preregistration. For a rare-positive detector the honest number is far above the
floor -- the CNAME design sizes N ~ 350 so that `referencePresent` is expected
near 175, because `predictedDetected` is roughly `recall x referencePresent` and
falls short of 100 whenever recall is below 1.

Final eligibility is unchanged and stricter than either number: all four class
denominators must independently reach 100 on the labeled data, and every Wilson
95% interval must meet the policy's maximum half-width.

Generate one RSA keypair of at least 2048 bits per study in approved credential
handling. Store the public half as canonical SPKI PEM at the exact
`labelSealingKey.publicKeyPath`; derive `keyId` from the canonical SPKI DER
bytes and `publicKeySha256` from the exact PEM file bytes. Add that PEM path,
the frame, preregistration, and policy to
`research/measurement-candidate/measurement-inputs.json` before freezing C.
The private half is not a candidate input and must never be committed.

## Controlled case inputs

The acquire dispatch accepts an absolute `case_input_root` on the ephemeral
controlled runner. It must contain exactly two regular, non-symlink JSON
files per frozen case:

```text
cases/<caseId>/selection.json
cases/<caseId>/condition.json
```

Selection and condition bytes must match the digests in the frozen frame.
Selection uses one HTTPS URL. Every case condition must exactly equal the
detector-specific `design.measurementCondition`: desktop and GPC-disabled for
all detectors, `accept-all` for `pixel-events`, and passive `observe` for the
other five. Device, GPC, and consent mode cannot vary between cases. Any
reference-evidence file, label, adjudication, or extra input makes acquisition
fail closed.

## Independent labels

Create the protected `calibration-label-reveal` environment, require the
intended human reviewers for deployment, and store the study's private key only
as `CALIBRATION_LABEL_REVEAL_PRIVATE_KEY`. The public key is already
candidate-resident; the label commitment workflow has no environment, private
key, or label plaintext.

Each reviewer prepares one canonical closed-whitelist source JSON and seals it
locally with their own normalized GitHub login and the candidate public key:

```bash
npm run calibration:seal-label-source -- \
  --study-id <study> \
  --detector <detector> \
  --role labeler \
  --actor <github-login> \
  --candidate-commit <C> \
  --public-key /absolute/path/to/label-sealing-public-key.pem \
  --input /absolute/private/source.json \
  --output /absolute/repo/path/source.enc.json
```

Repeat with `--role tiebreaker` for exactly one additional independent actor.
The tiebreaker labels the same full frozen frame without seeing the labelers'
answers or predictions. It is not created after a disagreement.

The source shape deliberately has no free-text or URL fields. Each case's
reference evidence uses a unique random 256-bit `blindingNonce`, an opaque
`urn:sbl:reference:sha256:<digest>` locator, and only the detector-specific
`<detector>-presence` boolean plus optional bounded `observation-count`.
Anything placed in reference evidence becomes public after protected reveal,
so never include secrets, names, patient data, account identifiers, raw URLs,
or other personal data. Study ids, case ids, and reviewer-facing filenames
must likewise be opaque and non-identifying. Final artifacts also publish the
authenticated reviewers' GitHub identities, so reviewers must understand that
their participation is part of the public provenance record.

Each actor then dispatches **Calibration Label Commitment** from `main` with
the sealed source commit/path. The workflow authenticates that the dispatching
actor equals the actor bound into the envelope, validates the candidate key
identity without decrypting, and uploads only `commitment.json`. This
identity-bound envelope prevents one actor from replaying another actor's
source under a different login.

After every commitment workflow is terminal and before any acquisition, record
each immutable artifact's role, run, attempt, artifact id, and upload digest in
canonical `calibration-labels/<studyId>/sources.json`. It must contain two
through ten distinct labeler commitments and exactly one distinct
blind-tiebreaker commitment, canonically sorted. Every server-created
commitment must strictly predate the roster authorization, its artifact, the
acquisition run, and the acquisition job.

Commit that exact coordinate manifest as one append-only evidence path in H.
The manifest is data only: neither the roster nor assembly executes code from
it. Do not amend H, create a second carrier, or add a later commitment. The
candidate binding must prove both the exact C-to-H evidence inventory and
byte-identical trusted producer/verifier closure. If the roster must change,
retire the ceremony and create a new preregistered identity; never select a
different subset after acquisition.

Use one keypair per study. Do not reuse the private key across candidates or
studies. Because the protected environment has one fixed secret slot, reveal
ceremonies are serial: load the exact study key, verify its derived key id
against the frozen frame, approve only that study's waiting deployment, and do
not rotate the secret while another reveal is queued or running. The assembly
process reads the key once and deletes
`CALIBRATION_LABEL_REVEAL_PRIVATE_KEY` from its process environment before it
invokes any `git` or `gh` child process. A wrong key fails closed, but it still
wastes the protected reveal window. After the attested proposal is merged,
remove the secret from the GitHub environment, destroy every remaining
private-key copy under the project's credential-destruction procedure, and
record the destruction. The candidate-pinned public key, ciphertext
commitments, final public evidence, and attested receipt remain as the audit
trail.

## Roster authorization and one-shot acquisition

Do not manually dispatch `Detector Calibration Study` in `acquire` mode.
Instead, at exact protected carrier H, dispatch **Calibration Label Roster
Authorization** once and provide:

- the preregistered study id and detector;
- full frozen candidate C;
- `sources_ref` equal to exact H;
- `sources_path` equal to the canonical coordinate-manifest path;
- the controlled runner's absolute case-input directory; and
- the workflow's domain-separated SHA-256 of that exact directory.

Required repository variables are:

- `SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE=1`
- `FEATURED_RUNNER_LABEL=<dedicated custom label>`
- `SCANNER_EGRESS=controlled-self-hosted`
- `SCANNER_EGRESS_REGION=<stable non-unknown region>`
- `FEATURED_R2_EGRESS_ATTESTED=1`

The roster workflow authenticates every commitment and publishes one immutable,
server-timestamped authorization. Its deterministic identity binds the study,
C, H, exact commitment-set digest, exact case-input-root digest, a fresh
authorization nonce, and only acquisition attempt 1. After the roster run
reaches terminal success, that same run dispatches the governed acquisition
workflow exactly once at H. The acquisition preflight re-fetches the roster
artifact and GitHub run metadata before the controlled job can start.

The roster identity must have exactly one server-visible successful workflow
run at attempt 1. The resulting acquisition authorization must likewise have
exactly one run and exactly one successful attempt, attempt 1. Never click
**Re-run jobs**, manually clone the acquisition dispatch, or submit a second
same-identity roster. A failed, cancelled, skipped, duplicate, or later attempt
is not replaceable evidence: it remains in the server history and makes the
ceremony ineligible. Retire that ceremony and start with a new preregistered
identity rather than hiding or retrying an attempt.

The preflight also verifies the committed measurement binding, policy decision,
freeze receipt, C-to-H ancestry and exact allowlist, producer/verifier closure,
external attestations, and the executing runner's freeze-attested identity. A
configured label never falls back to GitHub-hosted acquisition. The controlled
runner checks out H only for trusted preflight verification, then separately
checks out and executes C.

The acquisition retains the exact frozen selection and condition bytes for
every case, the public source report whenever a scan produced one, and the
private consent observation only when that detector completed. The trusted
inspector independently recomputes every complete prediction from those
retained inputs before assembly. It also requires every retained source report
to repeat the exact preregistered device, GPC, and consent mode. For
`pixel-events`, the independent recomputation additionally requires the public
r2 consent evidence to prove the accept-all choice was registered and
reverified after reload; dispatch or a banner transition is not enough.

The job summary records C, H, the roster run and artifact, and the acquisition
run, attempt, immutable artifact id, and artifact digest. Preserve the
acquisition coordinates for assembly. The artifact contains the exact roster
authorization and roster-selection snapshot that existed before scanning, but
no reference plaintext, blind-tiebreaker value, or reveal key.

## Assemble dispatch

The assemble CLI re-fetches the authenticated roster artifact the
authorization pinned, re-derives the selection snapshot and acquisition
attempt ledger from live Actions history, and cross-binds every pinned
coordinate (roster bytes, run, artifact, archive digest, commitment set, and
the acquisition-embedded snapshot) before the reveal key is read. A custody
failure therefore never costs a sealed envelope its secrecy, and the three
custody files the study binds by digest are archived from the same verified
bytes. The binding rules live in
`scripts/calibration-assemble-custody-lib.mjs` and are exercised offline by
`scripts/calibration-assemble-custody-lib.test.mjs`.

Select `assemble` from `main` and provide the same study, detector, and C plus:

- acquisition run id and attempt;
- acquisition artifact id and upload digest.

The trusted lane downloads the raw ZIP through the GitHub API and never invokes
an archive executable. Its in-process ZIP reader cross-checks central and local
headers, rejects duplicate, traversal, option-like, symlink, encrypted, ZIP64,
oversized, CRC-invalid, and overlapping entries, bounds decompression, and
writes only `O_EXCL`/`O_NOFOLLOW` regular files. Assembly derives H and the
complete commitment roster from the acquisition's precommitted authorization;
there is no operator-selected label reference at this stage.

Before reveal, assembly re-enumerates all same-identity roster runs and all
matching acquisition runs and attempts from the GitHub API. It requires the
live state to equal the pre-acquisition roster snapshot and the canonical
complete attempt ledger. It separately reads each exact commitment artifact by
id, authenticates its run, actor, head SHA, digest, server timestamps, and
closed ZIP shape, and rejects commitments that do not predate the roster and
acquisition. Only then does the protected step decrypt all sources. It requires
byte-identical evidence for each case, accepts genuine labeler agreement, and
resolves genuine disagreement with the already-committed tiebreaker value.
Final artifacts retain separate selection, condition, source-report, private
detector-observation, prediction, public-safe evidence, label,
blind-tiebreaker resolution, and censored-attempt roles as applicable.

The proposal adds only:

```text
calibration/<studyId>/study.json
calibration/<studyId>/analysis.json
calibration/<studyId>/runtime-receipt.json
calibration/<studyId>/runtime-receipt.sigstore.json
calibration/<studyId>/artifact-manifest.json
calibration/<studyId>/labels-manifest.json
calibration/<studyId>/label-roster-authorization.json
calibration/<studyId>/roster-selection-ledger.json
calibration/<studyId>/acquisition-attempt-ledger.json
calibration/<studyId>/artifacts/<caseId>/*.json
research/measurement-candidate-binding.json
```

Assembly first creates an unpublished prepared Git bundle. Only the receipt
leaves that job for isolated attestation. The finalizer materializes the exact
prepared JSON-only diff, binds the returned bundle, and runs the canonical
measurement verifier before the proposal branch is pushed. Committed
verification recomputes predictions and `analysis.json`, enforces policy
adequacy, validates chronology from policy/freeze through hosted labels,
the server-bound roster and acquisition job, archival, assembly, and evidence
introduction, and verifies the receipt's GitHub attestation against the
workflow's main-branch producer commit. The study, receipt, labels manifest,
and measurement binding cross-bind the roster authorization, roster-selection
ledger, and complete acquisition-attempt ledger by path and SHA-256.

Release-readiness verification repeats the live roster and acquisition
enumeration instead of trusting only the archived snapshot. A later competing
roster, cloned acquisition, rerun, failed attempt, or cancelled attempt makes
the previously assembled evidence ineligible. This is deliberate
zero-censoring: every server-visible acquisition attempt is accounted for and
none can be omitted because it produced an inconvenient result. A censored
case likewise preserves the planned denominator and makes the zero-censor
policy study-ineligible. It is never dropped to improve a rate.

## Fixture-only local verification

The focused tests create only temporary fixtures and do not invoke live
acquisition or labeling:

```bash
npm run test:calibration-producer
```

They cover all six detector mappings, explicit policy approval and sample
adequacy, frozen-frame set equality, nonserializable consent facts, retained
input recomputation, label separation and chronology, binding entry generation,
Actions metadata authentication, isolated attestation workflow structure, and
hostile raw-ZIP inputs without consulting `PATH`.
