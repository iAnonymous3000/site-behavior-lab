# Featured corpus r2 rollout

The committed corpus is dual-read. Existing v1 reports remain historical v1
evidence: their schema, report identity, timestamps, and experiment identity
are never upgraded to r2. Reviewed security remediation may re-redact their
stored public bytes and refresh the digest-bound provenance sidecar while
preserving those identities. The committed-report workflows append newly
produced reports under a fail-closed producer mode; they never rewrite a v1
file as r2.

## Current default: r2 when the runner exists, disclosed v1 fallback until then

The moment `FEATURED_RUNNER_LABEL` is configured, scheduled refreshes and every
`repository_dispatch` of the featured workflow are forced to
`FEATURED_REPORT_MODE=r2`; a then-incomplete r2 gate (missing region or
attestation) is rejected visibly in preflight before Chromium starts, and an
automated v1 run is refused outright. Neither workflow ever reads a report-mode
repository variable or payload field.

While the controlled runner is NOT configured, the scheduled refresh keeps
running on the production-proven frozen v1 lane instead of failing every week
against infrastructure that does not exist yet. That fallback is never silent:
the preflight emits a workflow `::warning::` annotation, writes a
"scheduled fallback" line into the run summary, and the publish job commits it
as "Add scheduled v1 fallback scan reports". `scan.yml` (single-site
repository_dispatch) has no scheduled cadence to protect and stays
unconditionally r2 for automated events.

GitHub-hosted runners expose their platform but do not provide a stable,
verifiable outbound region. ScanReport r2 treats an unrecorded egress region as
an unknown comparison dimension, so automated production requires a controlled
self-hosted runner with truthful placement declarations.

## Activating r2 comparisons

Use a controlled runner whose outbound placement is stable and independently
known. Configure these repository Actions variables:

- `FEATURED_RUNNER_LABEL`: the public-safe opaque custom label
  `sbl-controlled-r2-<16 lowercase hex>`.
- `SCANNER_EGRESS=controlled-self-hosted`: this configuration-only alias emits
  the generic public report label. The location-specific identity belongs in
  the region field below; every other label fails committed-r2 preflight.
- `SCANNER_EGRESS_REGION`: the truthful stable outbound region.
- `FEATURED_R2_EGRESS_ATTESTED=1`: explicit operator confirmation
  that the preceding two values describe the runner's actual network path.

`FEATURED_REPORT_MODE` is selected by the workflow, not by a report-mode
repository variable: automated runs are r2 exactly when `FEATURED_RUNNER_LABEL`
exists (the same variable that routes the job to the controlled runner, so mode
and placement cannot disagree). Once the label exists, the remaining variables
decide whether the r2 gate is ready; if they are incomplete, the run is red and
publishes nothing.

The preflight also requires `GITHUB_SHA` to be a full commit equal to checked-out
`HEAD`, a clean worktree, and exact comparison flags. It then enables public r2
and consent verification with that exact commit. Once the runner label exists,
any missing or contradictory prerequisite fails before Next starts or Chromium
visits a site; there is no fallback to v1 and no invented region.

Do not set the attestation merely to make the workflow green. If the controlled
egress cannot be verified, automated corpus production must remain red.

The runner is ephemeral, but its exact Jobs API metadata is retained in the
authenticated destruction archive. Register it with the public-safe name
`sbl-controlled-<16 lowercase hex>`, the exact GitHub `Default` runner group,
and no labels other than `self-hosted`, `Linux`, `X64`, and the
`FEATURED_RUNNER_LABEL` above. Never embed provider, account/project, ARN,
instance, hostname, IP, or region identifiers in the runner name, group, or
labels; collection refuses nonconforming metadata before it can be archived.

## Privilege boundary and unresolved runner gate

The committed-report workflows split acquisition from publication. The
acquisition job visits hostile public sites with only `contents: read`, no
repository or Actions write permission, no persistent npm cache, and
`SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1`. Preflight checks that exact sandbox flag
before Chromium is installed or started, and startup health must independently
report `checks.chromiumSandbox=enabled`. Acquisition can emit only a bounded
data artifact containing JSON reports, provenance sidecars, the report index,
corpus statistics, and a digest manifest tied to the exact source SHA.
For r2, successful preflight also sets the server-only
`SITE_BEHAVIOR_LAB_REPORT_ACQUISITION=ci-workflow` process setting. The scan API
accepts that provenance label only with `CI=1`, r2, sandboxing, and the
operator-attested controlled self-hosted egress facts; request bodies and
headers cannot select it. The publisher then requires every primary and
embedded supporting run to carry that exact acquisition label and source SHA.

A separate `ubuntu-latest` publisher receives the minimum repository and
Actions write permissions. It checks out that exact source SHA, installs locked
dependencies with lifecycle scripts disabled, downloads the artifact by its
immutable artifact id, and treats every downloaded byte as untrusted data. The
publisher rejects malformed UTF-8, duplicate JSON keys, schema/mode mismatch,
undeclared paths, symlinks, traversal, missing sidecars, digest mismatch,
non-canonical manifests/statistics, file/count/byte limit violations, changes
to any existing managed report, or a different set of newly declared report
ids. Before extraction, repo-owned trusted code also binds GitHub artifact
metadata to the exact run, id, name, source SHA, digest, and compressed size,
then parses the raw ZIP central and local records. It rejects ZIP64,
encryption, unsupported methods/flags, duplicate or non-allowlisted paths,
directories/symlinks, traversal, forged sizes/CRC, local-header disagreement,
and aggregate/compressed/inflated limit violations; inflation is output-bounded
and writes are exclusive into a fresh temporary directory. The publisher does
not use `actions/download-artifact` auto-extraction. It copies only new
report/sidecar pairs, then rebuilds the public manifest and corpus statistics
before pushing a per-attempt automation/* proposal branch and opening a pull
request for review. Outside a measurement freeze it first applies the ordinary
seven-day/count retention policy. With
`SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE=1`, pruning is forbidden: the publisher
skips the pruner, fails on a malformed freeze value, and separately rejects
any deletion under `public/reports`. The pruner launcher independently refuses
to run during a freeze, so another caller cannot silently bypass the workflow
condition. Featured-refresh issue writes happen in a third
GitHub-hosted job that receives only the bounded, revalidated public aggregate;
per-target diagnostics remain in private workflow logs.

### Freeze-time publication cross-binding

An exact freeze-time r2 publication also commits a create-only archive at:

```text
research/controlled-publications/<actions-run-id>-<acquisition-attempt>/
```

The directory contains exactly two regular files. `publication.json` is the
byte-for-byte manifest extracted from the already validated immutable
publication artifact; it is not parsed and reserialized for storage.
`receipt.json` is canonical, recursively key-sorted, two-space JSON with one
trailing newline and this exact schema:

```json
{
  "actionsRun": {
    "attempt": 2,
    "id": 30600000001,
    "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "artifactKind": "site-behavior-controlled-r2-publication-receipt",
  "publicationArtifact": {
    "archiveSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "id": 8760000001,
    "manifestSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "name": "site-behavior-featured-publication-30600000001-2"
  },
  "publicationKind": "featured",
  "reportMode": "r2",
  "reports": [
    {
      "id": "20260801-11111111111111111111111111111111",
      "provenancePath": "public/reports/20260801-11111111111111111111111111111111.provenance.json",
      "provenanceSha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "reportPath": "public/reports/20260801-11111111111111111111111111111111.json",
      "reportSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  ],
  "schemaVersion": 1
}
```

The receipt operation does not trust or accept the extraction directory used
by the preceding publisher step. It revalidates GitHub metadata and the raw ZIP
digest/size, then invokes the same bounded ZIP parser to extract that exact
archive into a fresh private temporary directory. The publisher derives the
sorted `reports` set only from that extraction's
`publication.json.expectedReportIds`, requires each declared report and
provenance digest/length to match both those authenticated extracted bytes and
the newly committed `public/reports` bytes, and removes the temporary
extraction. This prevents an unrelated caller-supplied directory from being
paired with an authenticated archive digest.

A publish-only rerun can have a different publisher attempt, so the archive's
attempt is deliberately parsed from the immutable artifact name minted by
acquisition, never from the current `GITHUB_RUN_ATTEMPT`.

This archive is created only when
`SITE_BEHAVIOR_LAB_MEASUREMENT_FREEZE=1` and `FEATURED_REPORT_MODE=r2`; the
commit step stages only its exact per-run path. It is separate from, and
cross-links rather than replaces, the controlled-runner destruction receipt.
Reviewers can independently rebind the archived manifest, receipt, and
committed report bytes with:

```sh
npm run reports:controlled-publication-receipt -- \
  --verify \
  --checkout-root "$PWD" \
  --directory "$PWD/research/controlled-publications/<run-id>-<attempt>" \
  --run-id <run-id> \
  --run-attempt <attempt> \
  --source-commit <producer-sha> \
  --artifact-id <artifact-id> \
  --archive-digest <artifact-sha256>
```

Request binding uses the privacy-preserving public requested-subject shape in
the report. Redirected observed/final destinations are allowed because they are
measurements, not dispatch inputs. Raw path values, query values, and redacted
subdomain labels that intentionally collapse to the same public shape cannot be
distinguished after redaction; the publisher does not claim otherwise.

This software boundary does **not** prove the self-hosted acquisition host is
safe. Automated r2 production remains an external release gate until operators
can produce current evidence that the configured runner is:

- single-use and destroyed after exactly one job, with no persistent workspace,
  package cache, browser profile, or cross-run process state;
- isolated from cloud metadata, control-plane credentials, SSH/deploy keys,
  production secrets, and other internal services;
- routed through the declared stable outbound region and an independently
  enforced egress policy that blocks private, link-local, metadata, and
  non-required destinations;
- registered with the intended repository and labels for only the lifetime of
  the job, with teardown recorded against the Actions run id; and
- monitored well enough to show sandbox availability, host-image identity,
  outbound NAT identity, and successful destruction for each production run.

Repository configuration and source code cannot attest those host controls.
Do not describe the r2 acquisition lane as production-ready, isolated, or
ephemeral until the operator evidence exists and is reviewed; the existing
egress attestation is necessary but is not a substitute for that evidence.

That evidence now has a machine-readable shape: one destruction receipt per
production run (`scripts/runner-receipt-lib.mjs`, verified by
`scripts/verify-runner-destruction-receipt.mjs`), committed under
`research/runner-receipts/<actions-run-id>.json`. The verifier enforces
completeness and internal consistency: every isolation and egress gate must
be literally true; registration must be ephemeral, job-scoped, for exactly
`iAnonymous3000/site-behavior-lab`, and include the declared runner label; and
the provisioning, successful job, destruction, absence verification, and
recording timestamps must be ordered. Receipt version 3 binds the exact
`scan-featured.yml` run to its lowercase source SHA, r2/`ci-workflow`
provenance, one of the two committed collection catalogs, the acquisition job,
the immutable publication artifact, and a separate hosted destruction
readback. Version 2 receipts remain readable for historical diagnosis but are
release-ineligible. Version 3 exposes only domain-separated SHA-256 references
for the runner label, host image, registration labels, and NAT identity:

```json
{
  "kind": "site-behavior-controlled-runner-destruction-receipt",
  "receiptVersion": 3,
  "actionsRunId": 30600000001,
  "actionsRunAttempt": 1,
  "workflow": "scan-featured.yml",
  "runnerLabelRef": "sha256:6786aaad2225cf8b2d9659dc71941110c1db9ff797ed417e6aaf6da85215f609",
  "recordedAt": "2026-08-03T08:00:00.000Z",
  "provisioning": {
    "provisionedAt": "2026-08-03T05:20:00.000Z",
    "hostImageIdentityRef": "sha256:213c97ea41074671d75ed417e1fae3d93ec608562d7bd89a3e6d3197cbcd8bec",
    "singleUse": true,
    "registration": {
      "repository": "iAnonymous3000/site-behavior-lab",
      "labelRefs": [
        "sha256:6786aaad2225cf8b2d9659dc71941110c1db9ff797ed417e6aaf6da85215f609"
      ],
      "ephemeral": true
    }
  },
  "runEvidence": {
    "conclusion": "success",
    "reportMode": "r2",
    "acquisition": "ci-workflow",
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "catalog": "public/featured-sites.json",
    "collectionDate": "2026-08-03",
    "job": {
      "id": 90600000001,
      "name": "Populate Featured Gallery",
      "startedAt": "2026-08-03T05:23:00.000Z",
      "completedAt": "2026-08-03T07:40:00.000Z",
      "url": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/job/90600000001"
    },
    "artifact": {
      "id": 8760000001,
      "name": "site-behavior-featured-publication-30600000001-1",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "url": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/artifacts/8760000001"
    }
  },
  "isolation": {
    "cloudMetadataBlocked": true,
    "controlPlaneCredentialsAbsent": true,
    "persistentStateAbsent": true
  },
  "egress": {
    "declaredRegion": "us-east",
    "natIdentityRef": "sha256:ffe7c4ef96c80086ec086bdc71002e0d6d777011827bbf9ddd3ea6b9be0bca90",
    "independentPolicyEnforced": true,
    "blockedClasses": ["private", "link-local", "metadata"]
  },
  "destruction": {
    "destroyedAt": "2026-08-03T07:45:00.000Z",
    "verifiedAbsentAt": "2026-08-03T07:50:00.000Z",
    "method": "instance-terminate",
    "verification": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
  },
  "destructionEvidence": {
    "workflow": ".github/workflows/runner-destruction-evidence.yml",
    "runId": 30700000001,
    "runAttempt": 1,
    "headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "conclusion": "success",
    "job": {
      "id": 90700000001,
      "name": "Read back provider destruction and absence",
      "startedAt": "2026-08-03T07:51:00.000Z",
      "completedAt": "2026-08-03T07:55:00.000Z",
      "url": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001/job/90700000001"
    },
    "artifact": {
      "id": 8770000001,
      "name": "site-behavior-runner-destruction-evidence-30700000001-1",
      "sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "url": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001/artifacts/8770000001"
    },
    "readback": {
      "path": "destruction-evidence.json",
      "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  },
  "operator": {
    "attestedBy": "iAnonymous3000",
    "evidenceRefs": [
      {
        "kind": "github-actions-run-evidence",
        "actionsRunId": 30600000001,
        "runUrl": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001",
        "artifactName": "site-behavior-featured-publication-30600000001-1",
        "artifactRef": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30600000001/artifacts/8760000001",
        "artifactSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      {
        "kind": "github-actions-run-evidence",
        "actionsRunId": 30700000001,
        "runUrl": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001",
        "artifactName": "site-behavior-runner-destruction-evidence-30700000001-1",
        "artifactRef": "https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30700000001/artifacts/8770000001",
        "artifactSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      }
    ]
  }
}
```

`collectionDate` is the UTC date on which the acquisition job started. When
multiple receipts are verified together, those dates and Actions run ids must
be distinct: a second job or rerun on the same date is useful evidence, but is
not a second temporal cycle. The verifier also requires every receipt to carry
the same controlled-environment tuple: runner-label reference, exact host-image
reference, registration-label references, declared region, outbound-NAT
reference, and blocked network classes. A host or
network change starts a new evidence set rather than silently contributing a
second supposedly comparable cycle. A cycle without a verifying receipt does
not count toward the two-successful-cycles milestone.

The verifier proves only that the receipt is complete and internally coherent,
including exact Actions run URLs and exactly two digest-bound immutable
operator-evidence artifacts: collection and hosted destruction. Arbitrary
extras, strings, and moving, digest-free references are rejected. Receipt files
must use the exact canonical JSON bytes, so duplicate keys and noncanonical
hidden content fail before digesting. Every receipt object is exact-keyed, so an accidentally embedded
credential, target URL, or ungoverned side claim fails validation instead of
being committed as an ignored field. The standalone verifier does not fetch
GitHub; release readiness separately authenticates both hosted runs, workflow
bytes, jobs, and artifact members. Neither layer independently proves
the operator's statements about host isolation, NAT policy, image identity, or
destruction. Review must confirm the referenced run and artifact; the host
truths remain supported by the referenced external evidence and human
attestation.

Release readiness must call the set validator with its own bindings:
`expectedCandidateCommit` when every run is made from one immutable source SHA,
the validator-derived digest of the candidate-resident `expectedEnvironment`
tuple to bind the internally compatible receipts to the reviewed runner/NAT
configuration, `epochStartedAt` to exclude pre-freeze acquisition, and `now`
plus `maxAgeDays` to reject future or stale evidence. If
reviewed report-data commits are allowed to advance `HEAD` inside the freeze, do
not misuse
`expectedCandidateCommit`: first define and bind a separate digest for the
claim-affecting measurement inputs, then compare that governed digest across
the permitted source commits. The exported set verdict also returns the
controlled-environment digest, source commits, earliest collection time, and
latest recording time for an exact readiness or attestation binding.

Before declaring candidate `P`, review and record the exact privacy-safe tuple
in `RELEASE_READINESS.json` at `gates.runner-cycles.expectedEnvironment`. Its
shape is exactly:

```json
{
  "runnerLabelRef": "sha256:<64 lowercase hex>",
  "hostImageIdentityRef": "sha256:<64 lowercase hex>",
  "registrationLabelRefs": ["sha256:<64 lowercase hex>"],
  "declaredRegion": "us-west",
  "natIdentityRef": "sha256:<64 lowercase hex>",
  "blockedClasses": ["link-local", "metadata", "private"]
}
```

Do not put the raw runner label, image identity, registration labels, or NAT
identity in command arguments, shell history, or the repository. A secret
manager may inject the six exact variables accepted by the helper. For manual
entry, use silent shell reads; the commands themselves contain no raw value:

```bash
(
set -euo pipefail
cleanup_expected_runner_environment() {
  unset SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_LABEL \
    SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_HOST_IMAGE_IDENTITY \
    SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_REGISTRATION_LABELS_JSON \
    SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_DECLARED_REGION \
    SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_NAT_IDENTITY \
    SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_BLOCKED_CLASSES_JSON
}
trap cleanup_expected_runner_environment EXIT

printf 'Runner label: ' >&2
IFS= read -r -s SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_LABEL; printf '\n' >&2
printf 'Host image identity: ' >&2
IFS= read -r -s SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_HOST_IMAGE_IDENTITY; printf '\n' >&2
printf 'Registration labels as a JSON string array: ' >&2
IFS= read -r -s SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_REGISTRATION_LABELS_JSON; printf '\n' >&2
printf 'Coarse declared region: ' >&2
IFS= read -r -s SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_DECLARED_REGION; printf '\n' >&2
printf 'Outbound NAT identity: ' >&2
IFS= read -r -s SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_NAT_IDENTITY; printf '\n' >&2
printf 'Blocked classes as a JSON string array: ' >&2
IFS= read -r -s SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_BLOCKED_CLASSES_JSON; printf '\n' >&2

export SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_LABEL \
  SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_HOST_IMAGE_IDENTITY \
  SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_REGISTRATION_LABELS_JSON \
  SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_DECLARED_REGION \
  SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_NAT_IDENTITY \
  SITE_BEHAVIOR_LAB_EXPECTED_RUNNER_BLOCKED_CLASSES_JSON
npm run --silent runner:expected-environment
)
```

The command accepts no arguments and emits only an `expectedEnvironment`
object with those six fields plus `expectedEnvironmentDigest`. Copy only the
six-field object into the readiness manifest; use the digest as a review
diagnostic. The helper rejects unrecognized variables in its dedicated prefix,
hashes every private identity under its role-specific domain, sorts and
deduplicates the resulting registration references, and validates the complete
tuple without echoing a raw identity.

The tuple also contains the coarse region and sorted blocked network classes.
The three role references must be pairwise distinct, and registration labels
may not reuse the host-image or NAT reference. It must match the controlled
runner configuration that will be used for both cycles; do not derive it from a
future receipt or invent values to make the gate green. The validator
canonicalizes that candidate-owned tuple and derives its digest itself.

After both cycle receipts exist, run the set verifier over the committed
directory and compare the printed digest as a diagnostic:

```bash
node scripts/verify-runner-destruction-receipt.mjs \
  research/runner-receipts/
# final line must equal the digest derived from the candidate-owned tuple

npm run release:readiness
```

The tuple is a pre-P policy input: once `P` is declared, do not edit it. Each
cycle is append-only evidence in a permitted carrier commit. Readiness derives
both sides independently, so a typo, environment drift, missing receipt, or
substituted cycle stays red without a post-freeze manifest finalization.
Candidate verification also reads `RELEASE_READINESS.json` from `P` and every
ancestry-path commit through candidate `C`, canonicalizes the tuple, and
refuses any missing or changed value, including a transient change that was
later reverted. If the reviewed environment must change after `P`, abandon
that replay lineage and select a fresh parent before collecting either cycle;
never edit the tuple to fit receipts already observed.

### Pre-freeze Aug 3/Aug 10 re-adjudication evidence

The scheduled 05:23 UTC gallery legs on 2026-08-03 and 2026-08-10 each
canonicalize a separate
`featured-readjudication-outcomes-<run-id>-<attempt>` artifact even when the
scan batch fails. It is retained for 45 days and contains exactly the fixed 13
formerly deferred domains. Successful outcomes carry only the validated
report id and attempt count; classified failures carry only one closed reason.
Anything the child scanner did not classify from structured report facts is
`not-attempted`, with no free text, and makes the cycle incomplete.

The reviewed aggregate at
`research/ops-receipts/featured-readjudication.json` accepts exactly those two
complete scheduled cycles, their distinct immutable artifact ids/digests, and
the final featured-catalog digest. Both cycle catalogs and the final catalog
must preserve one digest of the fixed 13 target records; only governed
`scanAvailability` metadata may change between them. It re-defers a site only
when both cycles attempted it and returned the same closed unavailable reason.
Measurement freeze activation independently downloads both exact artifact ZIPs
by id, checks live run/artifact/workflow-at-head metadata and digests, fetches
the historical catalog bytes at each run commit, extracts the single canonical
JSON file with the strict ZIP reader, and re-derives the catalog dispositions.
Activation must occur within 28 calendar days after the Aug 10 cycle, and each
retained deferral must still have a `reviewAfter` date later than activation.
A self-asserted boolean cannot satisfy this gate.

### Post-activation governed cycles use sequential accepted producer commits

After the measurement-freeze receipt names candidate `C`, run the first
governed post-activation controlled-r2 cycle from that exact commit. Validate its
artifact, destruction receipt, and additions-only proposal, then merge that
proposal through the normal checks. The resulting evidence carrier is `S1`.
Run the second cycle only after `S1` is current on `main`; the second report
batch and runner receipt must truthfully name `S1`, not `C`. This sequential
flow avoids conflicting generated manifest/statistics proposals and never
requires a hand merge.

Each cycle therefore has all of these properties:

- acquisition `GITHUB_SHA`, report build commit, publication artifact source,
  and runner receipt `runEvidence.headSha` equal that cycle's exact accepted
  producer commit;
- the controlled-publication archive preserves the artifact's exact manifest
  bytes and binds its expected report pairs to the same committed carrier;
- every governed report inherited from the preceding producer is preserved
  byte-for-byte—no age/count pruning or other report deletion occurs;
- each new report/provenance set is validated and merged as one evidence-only
  carrier before the next cycle starts; and
- the two cycle receipts use distinct run ids and UTC collection dates while
  retaining the same validated controlled-environment tuple.

Between `C`, `S1`, and the later carrier, no code, catalog, dependency,
filter-list, methodology, or runtime-configuration change may land. The
measurement-candidate binding enumerates the typed evidence-only changes and
lists the commits that actually produced scans in `acceptedProducerCommits`.
Calibration remains exact to `C` even though later evidence collection
truthfully uses a reviewed carrier commit.

## Manual v1 compatibility lane

`workflow_dispatch` alone exposes `report_mode=v1`. That explicit choice runs
on GitHub-hosted Ubuntu and produces frozen v1 solely for compatibility work.
With the controlled runner configured, the preflight rejects v1 for scheduled
and repository-dispatch events (only the disclosed fallback above may produce
automated v1, and only while the runner is unconfigured); a missing mode is an
error rather than a legacy default. Normal manual runs default to r2.
