# Measurement-freeze activation receipt

The measurement freeze is an evidence boundary, not merely a repository
variable. Setting `SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE=1` quiesces the
claim-affecting publishers that already honor it, but the variable cannot prove
which `main` commit was current, whether the controlled r2 lane was configured,
or whether an already-validated automation proposal was still open.

`.github/workflows/activate-measurement-freeze.yml` is the read-only activation
ceremony for those facts. It is manual and has only `contents: read`,
`pull-requests: read`, and `actions: read`. It cannot set the variable, push a
branch, merge a proposal, or publish corpus bytes.

## Before dispatch

1. Complete the featured-site re-adjudication and land the intended final
   measurement candidate on `main`. The 05:23 UTC gallery runs on 2026-08-03
   and 2026-08-10 each upload
   `featured-readjudication-outcomes-<run-id>-<attempt>` for 45 days. The
   artifact contains one closed outcome for each fixed domain: a validated
   report id plus attempt count, one of the five closed unavailable reasons,
   or explicit `not-attempted`. Missing/malformed diagnostics never become a
   site failure. Both cycles must be `complete: true`; any not-attempted domain
   keeps activation red.
2. Build and review the strict aggregate at
   `research/ops-receipts/featured-readjudication.json`. It must bind the two
   distinct immutable artifact ids/digests and their exact canonical outcomes,
   each cycle's exact historical catalog digest, one identical fixed-domain
   target-identity digest across both cycles, and the final
   `public/featured-sites.json` digest. The final catalog may change governed
   `scanAvailability` metadata, but it must preserve that target identity.
   Re-defer a domain only when both attempted outcomes carry the same closed
   unavailable reason; otherwise it remains active. Land the reviewed
   catalog/receipt proposal before activation.
3. Close or merge **every** open `automation/*` or `dependabot/*` proposal,
   whether its checks are green, pending, or parked. A pending pre-freeze
   proposal can become green later while still carrying pre-epoch inputs, so
   activation requires a zero-open set instead of racing check status. New
   controlled-r2 corpus proposals may be created and merged sequentially after
   activation under the evidence-only carrier policy below.
4. Provision the controlled featured runner and set all four repository
   variables truthfully:
   - `FEATURED_RUNNER_LABEL` is a custom label for that controlled runner, not a
     generic `self-hosted`, platform, or architecture label.
   - `SCANNER_EGRESS=controlled-self-hosted`.
   - `SCANNER_EGRESS_REGION` is the stable, non-`unknown` outbound region the
     operator verified.
   - `FEATURED_R2_EGRESS_ATTESTED=1`.
   The workflow also queries the repository runner inventory and requires at
   least one `online` self-hosted runner carrying the exact custom label. If
   `GITHUB_TOKEN` cannot read that endpoint, install a repository-only GitHub
   App with Metadata:read, Administration:read, and Actions:read (no write
   permissions or webhook), then store its client ID as
   `RUNNER_READ_APP_CLIENT_ID` and private key as
   `RUNNER_READ_APP_PRIVATE_KEY`. Freeze activation mints a short-lived token
   narrowed to Administration:read; the durable-soak monitor separately
   narrows its token to this repository and Actions:read. Missing read
   authority is a hard failure, never permission to treat a variable as hosted
   evidence.
5. Set `SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE=1`. Do this last. From this point,
   do not merge a pre-activation automation or Dependabot proposal.
6. Copy the full 40-character `main` SHA. Dispatch **Activate Measurement
   Freeze** on `main` and provide that SHA as `candidate_sha`.

The workflow refuses if `main` moved, the event or checkout identifies another
commit, any required variable is missing or malformed, either historical
re-adjudication run is not the exact scheduled `main` gallery workflow, either
artifact is expired or differs from its live GitHub digest/ZIP bytes, the
historical catalog at either run commit differs from that cycle's catalog
binding, the two cycles and final catalog do not preserve one fixed-domain
target identity, the aggregate dispositions do not re-derive against the final
featured catalog, or the activation is more than 28 calendar days after the
Aug 10 cycle. Every retained deferral must also have a `reviewAfter` date
strictly later than activation. The workflow also refuses when the committed
featured workflow no longer has the controlled-r2 preflight/routing contract
or an open `automation/*`/`dependabot/*` proposal exists.

Create the reviewed aggregate only from the two canonical JSON files extracted
from those immutable artifacts and their GitHub-reported ZIP digests:

```sh
npm run featured:readjudication -- \
  --aggregate \
  --checkout-root "$PWD" \
  --aug-3-outcomes /path/to/aug-3/featured-readjudication-outcomes.json \
  --aug-3-artifact-id <artifact-id> \
  --aug-3-artifact-digest <sha256> \
  --aug-10-outcomes /path/to/aug-10/featured-readjudication-outcomes.json \
  --aug-10-artifact-id <artifact-id> \
  --aug-10-artifact-digest <sha256> \
  --featured-sites "$PWD/public/featured-sites.json" \
  --output "$PWD/research/ops-receipts/featured-readjudication.json"
```

The output path is fixed and create-only. Validate it against the candidate
catalog with:

```sh
npm run featured:readjudication -- \
  --verify \
  --receipt "$PWD/research/ops-receipts/featured-readjudication.json" \
  --featured-sites "$PWD/public/featured-sites.json"
```

The proposal guard deliberately records the canonical empty API result and its
digest rather than accepting a `passed: true` or operator verdict. Runner
evidence is likewise derived from the live repository runner inventory: the
receipt retains only domain-separated hashes of matching runner identity,
name, and label set, plus the observed `online`/busy state. It never publishes
the runner host name.

## Collect governed cycles through sequential evidence-only carriers

Let `C` be `candidate.commit` in the validated activation receipt. Dispatch
the first governed post-activation controlled-r2 featured cycle from `C`. Its workflow,
reports, artifact, and destruction receipt truthfully record `C`. After that
proposal and receipt verify, merge the evidence-only proposal through normal
checks. Call the resulting carrier commit `S1`. Dispatch the second cycle only
after `S1` is current on `main`; its source and receipt truthfully record `S1`,
not `C`. Merge its verified evidence-only proposal to produce the next carrier.

No code, catalog, dependency, filter-list, methodology, or runtime
configuration change may land between `C` and these sequential carrier commits.
Each carrier is limited to the typed, digest-enumerated evidence paths and the
single deterministic manifest/statistics rebuild accepted by the measurement
candidate binding. This sequencing avoids conflicting proposals and preserves
the normal prohibition on hand-merging generated output.

Freeze-time publication may append new report/provenance pairs to its proposal,
but it must not prune any governed report inherited from its source carrier.
The publisher skips the ordinary retention pruner, rejects any report deletion
in the resulting diff, and rebuilds only the derived manifest/statistics around
the additions. Before that rebuild, it also preserves the validated
artifact's exact `publication.json` bytes and a canonical digest cross-binding
under
`research/controlled-publications/<actions-run-id>-<acquisition-attempt>/`.
The attempt comes from the immutable acquisition artifact name, so a
publish-only rerun cannot mislabel the evidence with its later publisher
attempt. Each evidence-only carrier must include this exact per-cycle archive
alongside the report additions; a freeze-time r2 proposal without it is
refused before commit.

Readiness treats `C` as the immutable measurement/calibration candidate and
accepts scan sources only from the binding's exact
`acceptedProducerCommits` chain (`C`, then the reviewed evidence-only carriers
that actually produced later cycles). Calibration remains bound exactly to
`C`; advancing an evidence-only carrier never permits calibration against
whatever commit happens to be `HEAD`.

## Receipt and independent validation

The successful run uploads one immutable, per-attempt artifact named:

```text
measurement-freeze-activation-<actions-run-id>-<run-attempt>
```

It contains only `measurement-freeze-activation-receipt.json`. The canonical
receipt binds:

- the exact repository, `main` candidate, checkout, and observed live main ref;
- the activation workflow digest, run id, attempt, URL, start, and activation
  instant;
- the featured workflow digest and exact r2/`ci-workflow` lane;
- the committed re-adjudication aggregate and final catalog digests;
- both Aug 3/Aug 10 live scheduled-run identities, their exact historical
  workflow-at-head and catalog-at-head digests, the shared fixed-domain target
  identity, immutable artifact metadata/digests, exact downloaded ZIP-byte
  digests, and canonical outcome digests;
- the literal non-sensitive flags plus domain-separated SHA-256 digests of the
  runner label and region (the raw label and region are not published);
- at least one live online controlled-runner match, represented only by hashed
  identity/name/label-set evidence;
- the zero-open proposal observation and its canonical digest; and
- its unique artifact name and 90-day retention contract.

Tokens and secret values are never accepted as receipt fields. The capture
script uses `GITHUB_TOKEN` only for read-only GitHub API calls and never writes
it to disk or output. Every JSON response is read through a 30-second,
redirect-refusing, streaming 1 MiB ceiling with fatal UTF-8/JSON parsing; the
artifact ZIP uses its own bounded streaming path.

### Token boundary

This activation ceremony has a narrower, documented trust boundary than
release preparation. Release runs npm dependencies and builds publishable
bytes, so candidate processes there receive no GitHub token at all. Activation
installs no npm package and executes no dependency code: after a
credential-less checkout and pinned Node setup, one reviewed
`main`-resident capture script using Node built-ins and local validators
receives only repository-scoped read tokens. The ordinary workflow token has
`contents: read`, `pull-requests: read`, and `actions: read`; the optional
repository-only App is configured with `Administration: read` and
`Actions: read`, while the token minted for this ceremony is narrowed to only
`Administration: read` for runner inventory. Neither can mutate a ref,
variable, environment, artifact, issue, or pull request. The independent
receipt validator and artifact upload steps receive neither token.

This is still a trusted-code assumption: a malicious capture script could
exfiltrate the read-only observations or token during its short step. Protected
`main`, exact-candidate dispatch, the bound workflow digest, pinned actions,
the absence of persisted checkout credentials, and the no-dependency execution
surface are therefore part of the activation security model. Moving all API
reads to workflow-owned inline prefetch and feeding the capture script a
trusted-digest offline context would remove that assumption, but is not
silently claimed by the current receipt.

Download the artifact and validate the bytes against the candidate:

```sh
node scripts/validate-measurement-freeze-activation-receipt.mjs \
  --receipt /path/to/measurement-freeze-activation-receipt.json \
  --candidate <40-character-candidate-sha> \
  --run-id <actions-run-id> \
  --run-attempt <run-attempt> \
  --readjudication-receipt research/ops-receipts/featured-readjudication.json \
  --featured-sites public/featured-sites.json
```

That structural invocation is what the activation workflow can run before its
artifact exists. A trusted host validating an already-completed activation
must also prove artifact authenticity:

```sh
GITHUB_TOKEN=<read-only-token> \
node scripts/validate-measurement-freeze-activation-receipt.mjs \
  --receipt /path/to/measurement-freeze-activation-receipt.json \
  --candidate <40-character-candidate-sha> \
  --activation-workflow .github/workflows/activate-measurement-freeze.yml \
  --featured-workflow .github/workflows/scan-featured.yml \
  --readjudication-receipt research/ops-receipts/featured-readjudication.json \
  --featured-sites public/featured-sites.json \
  --verify-live-artifact
```

The live check uses `activation.runId` and `activation.runAttempt`; it requires
that exact workflow run to be completed successfully on the receipt candidate,
lists every artifact for the run, discovers exactly one non-expired artifact
with the receipt's per-attempt handoff name, re-reads its immutable metadata,
refuses a declared size above 1 MiB before download, streams the exact ZIP
under the same ceiling, verifies the GitHub SHA-256,
strictly extracts only `measurement-freeze-activation-receipt.json`, and
byte-compares it to the committed carrier receipt. The receipt does not
self-assert an artifact id.

Release candidate code and dependencies must never receive a GitHub token.
The release workflow therefore prefetches the same read-only API evidence in a
workflow-owned token-scoped step, removes the token, and gives the candidate
validator only an absolute offline context directory containing exactly:

```text
run.json
artifacts-pages.json
artifact.json
artifact.zip
```

`artifacts-pages.json` is the JSON array of raw bounded artifact-list page
responses. The token-scoped prefetch also produces a domain-separated SHA-256
over the exact names, sizes, and bytes of all four files. The offline
invocation replaces `--verify-live-artifact` with
`--live-artifact-context /absolute/path/to/context
--live-artifact-context-sha256 <trusted-prefetch-digest>`. The digest must come
from the workflow-owned prefetch step, not from candidate code. Missing, extra,
substituted, expired, duplicate, malformed-ZIP, artifact-digest-mismatched, or
context-digest-mismatched inputs all fail. Both modes apply the same identity
and byte checks.

When validating in the exact candidate checkout, additionally bind both
workflow digests:

```sh
node scripts/validate-measurement-freeze-activation-receipt.mjs \
  --receipt /path/to/measurement-freeze-activation-receipt.json \
  --candidate <40-character-candidate-sha> \
  --run-id <actions-run-id> \
  --run-attempt <run-attempt> \
  --activation-workflow .github/workflows/activate-measurement-freeze.yml \
  --featured-workflow .github/workflows/scan-featured.yml \
  --readjudication-receipt research/ops-receipts/featured-readjudication.json \
  --featured-sites public/featured-sites.json
```

Supplying the five repository variables in the validator process also
independently recomputes the private configuration digests. Do not print those
variables or place them on a command line.

## Readiness-manifest integration

The release-readiness manifest should gain a `measurementFreezeActivation`
gate with these inputs:

- the fixed committed archive path
  `research/ops-receipts/measurement-freeze-activation.json`;
- candidate commit;
- activation run id and attempt;
- the deterministic per-attempt artifact name;
- receipt SHA-256; and
- the expected activation and featured workflow digests.

The gate must discover exactly one artifact by the bound run and deterministic
name, verify the immutable artifact metadata and ZIP digest bind it to the
named activation run and candidate SHA, extract exactly the one expected
regular JSON file, byte-compare it to the committed carrier, and call
`parseAndVerifyMeasurementFreezeActivationReceipt`. It should also require the
receipt activation instant to precede both controlled-r2 collection cycles.

This is now a mechanical gate, not a pending candidate/evidence-binding
decision. The activation receipt names the explicitly selected measurement
candidate `C`; the immutable Actions artifact and its committed byte-identical
receipt prove activation for `C`; and
`research/measurement-candidate-binding.json` permits later commits only as
digest-enumerated evidence carriers. The verifier checks the complete
candidate-to-carrier Git history, not the moving repository `HEAD`, so
archiving the fixed receipt does not redefine the candidate or create a
self-reference.

Do not add an implicit `HEAD` exception or reopen this as an operator choice.
A code, workflow, catalog, list, dependency, methodology, or runtime-policy
change after `C` is outside the evidence-carrier allowlist and requires a new
candidate and activation ceremony. Evidence-only carrier changes must remain
set-equal to the binding's path, change type, digest, and causal-producer
enumeration.
