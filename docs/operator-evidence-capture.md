# Canonical operator evidence

Release attestations state what a named operator reviewed. They do not get to
invent their own subject digests. The producer tools in this document create
the underlying canonical receipts from which release readiness derives those
bindings.

All receipts use schema version 1 and recursively key-sorted compact JSON with
one trailing newline. The verifier rejects any other byte serialization. Every
producer creates a new mode-`0600` file and refuses an existing file, directory,
or symlink. Output must stay under the real repository root, and no parent
component may be a symlink. Provider exports and policy inputs are read through
bounded, regular-file-only, no-final-symlink readers. Do not edit a generated
receipt. Re-run the capture into a new path.

The canonical target paths are:

| Evidence | Canonical path |
|---|---|
| WAF ceilings | `research/ops-evidence/waf-ceilings.json` |
| WAF probe transcript | `research/ops-evidence/waf-probe-transcript.json` |
| Log retention | `research/ops-evidence/log-retention.json` |
| Egress backstop | `research/ops-evidence/egress-backstop.json` |
| Staging teardown | `research/ops-evidence/staging-teardown.json` |
| Container licensing | `research/ops-evidence/container-image-licensing.json` |

Verify any finished receipt with:

```bash
npm run ops:evidence:verify -- --evidence research/ops-evidence/<receipt>.json
```

The command parses the exact bytes, re-computes every policy or inventory
digest, and rejects unknown fields. Container licensing also re-opens the bound
candidate inventory and review ledger and re-runs their semantic validators.

For WAF, log-retention, egress, and staging teardown, these local producers
establish deterministic receipt semantics but are not, by themselves, trusted
release provenance. Each v1 gate must also verify a dedicated GitHub-hosted
capture job that obtained the private provider bytes through scoped secrets,
ran the canonical sanitizer and producer, attested a privacy-safe manifest
plus receipt, and destroyed the raw response. A `workflow_dispatch` input
containing a caller-supplied digest is not evidence, and private provider
exports must never be copied into a public PR archive. Until the
provider-specific hosted capture exists for one of those evidence classes,
that release gate remains red even when a locally generated receipt validates.

Container licensing is the deliberate exception: its complete inputs are
repository-local, exact-candidate package inventory and review-ledger bytes.
The candidate verifier re-opens those bytes, re-runs the semantic license
checks, and verifies the inventory's candidate-bound Sigstore attestation.
There is no private provider response to acquire, so an additional hosted
provider-capture job would add no independent source of truth.

## WAF GET and POST ceilings

The release gate permits evidence no older than 30 days, but that is a hard
freshness ceiling, not the operating schedule. Capture the WAF probe and the
log-retention readback inside the final two-week release-ceremony window so
review, environment approval, and tag publication do not consume the safety
margin. If the candidate or effective deployment changes, recapture even when
the earlier receipt is still under 30 days old.

For release evidence, use the dedicated `WAF Ceiling Evidence` workflow on the
exact protected-main candidate that `/api/health` reports as deployed. Configure
the `release-evidence` environment with two distinct least-privilege secrets:
`WAF_RULES_API_TOKEN` has **Zone WAF Read** for only the production zone, while
`WAF_ANALYTICS_API_TOKEN` has **Zone Analytics Read** restricted to only that zone. Configure the non-secret repository variable
`CLOUDFLARE_ZONE_ID`. The workflow refuses a
missing or reused token, a non-GitHub-hosted runner, a candidate input different
from its trusted `github.sha`, or a live deployment different from that
candidate.

The adapter reads the zone `http_ratelimit` phase entrypoint, selects exactly one
enabled rule by the provider-assigned ref `dcfa52c1a2664133be6f4ae2a5d95d39`, validates its
exact route expression (optionally restricted to `scan.sitebehavior.org`) and ten-per-ten-second block policy, and then binds the
provider's immutable **rule API `id` and `version`**. The ref is only the
selector; it is not the `ruleId` stored in the receipt or Security Events. The
adapter also refuses an alternate counting expression, origin-only counting,
or complexity-score counting; an empty Cloudflare `counting_expression` is
accepted because it canonically means the rule expression.

The dashboard name `scan-api-rate-limit` is not the API ref. Use the workflow's
`preflight_only` input to check the two provider credentials and the configured
rule before waiting for deployment. This makes no admission probes, writes no
raw provider files, and uploads no artifact; a successful preflight cannot
satisfy any release evidence gate. Full capture still requires the exact
candidate to be deployed and both blocked requests to correlate with Security Events.

For a local semantic rehearsal, prepare a non-secret rule-policy JSON object
using the immutable provider identity/version, a ten-request limit, the
configured window and mitigation timeout, and these ordered routes:

```json
{
  "provider": "cloudflare",
  "ruleId": "<immutable-cloudflare-rule-api-id>",
  "ruleVersion": "<immutable-cloudflare-rule-api-version>",
  "requestLimit": 10,
  "windowSeconds": 10,
  "mitigationTimeoutSeconds": 10,
  "routes": [
    {
      "id": "get-admission",
      "method": "GET",
      "path": "/api/scan/admission"
    },
    {
      "id": "post-admission",
      "method": "POST",
      "path": "/api/scan"
    }
  ]
}
```

Supply local request material only through process environment:

```bash
export SBL_WAF_GET_HEADERS_JSON='<runtime-only JSON headers>'
export SBL_WAF_POST_HEADERS_JSON='<runtime-only JSON headers>'
npm run ops:evidence:waf:capture -- \
  --probe \
  --base-url https://scan.sitebehavior.org \
  --candidate-commit <candidate-sha> \
  --deployment-commit <deployed-sha> \
  --rule-policy <rule-policy.json> \
  --output research/ops-evidence/waf-probe-transcript.json
unset SBL_WAF_GET_HEADERS_JSON SBL_WAF_POST_HEADERS_JSON
```

The local CLI proves the canonical receipt semantics but does not replace the
trusted hosted capture and archive. It refuses any origin other than exactly
`https://scan.sitebehavior.org`. It also refuses `SBL_WAF_POST_BODY`: the POST
probe always sends the internally pinned invalid body `{}` with
`Content-Type: application/json`, and its fixed digest is retained in the
transcript and final receipt. The producer executes eleven GET requests,
waits out the counting window plus the mitigation timeout and a one-second margin,
and then executes eleven POST requests. Each individual request has a
five-second abort timeout. Each first ten must avoid 429; for POST, each first
ten must return exactly 400 so the invalid probe cannot create a scan or
report. Each eleventh must be 429 with an integer `Retry-After` equal to the
policy.

Both routes share the IP/data-center counter. On September 6, a hosted capture
and a local repeat throttled POST early after the former 11-second gap. A
POST-only burst after idle time and a paired probe with a 21-second gap passed
the unchanged response checks. The producer now allows both periods to elapse;
historical receipt semantics and release requirements are unchanged. These
observations do not establish a universal hard ceiling:
[Cloudflare documents counter-update delays and non-exact request limits](https://developers.cloudflare.com/waf/rate-limiting-rules/).

The first phase writes only a canonical sanitized probe transcript.
After it finishes, export the provider's Security Events query to a bounded
private JSON file with exact top-level `tool`, `query`, `exportedAt`, and
`events` fields. `tool` contains `name` and `version`. `query` contains
`provider: "cloudflare"`, the private `zoneId`, and canonical `startedAt` and
`endedAt` values spanning both route probes within a five-minute maximum
window. Event objects must expose exactly `ruleId`, `method`, `path`, `action`,
`timestamp`, and the event's base Cloudflare Ray ID as `requestId`. The exporter must
remove IP addresses, URLs, query strings, account ids, and provider payloads
before finalization; an extra event field is a hard refusal.

Finalize only after that export exists:

```bash
npm run ops:evidence:waf:capture -- \
  --finalize \
  --probe-transcript research/ops-evidence/waf-probe-transcript.json \
  --provider-events-export <private-security-events-export.json> \
  --output research/ops-evidence/waf-ceilings.json
```

No provider module is loaded into the process that holds the WAF request
material. Finalization binds the exact probe-transcript and provider-export
byte digests and lengths, the exporter tool/version, the exact provider query
window, and a domain-separated zone reference. It requires exactly one matching
block event for each route. The probe hashes the normalized base ID from the
eleventh response's `Cf-Ray` header; finalization hashes each provider
`requestId` in the same domain and requires an exact match. The POP suffix is
not part of the hash, matching Cloudflare's separate Ray ID and edge-colo
shapes. The committed receipt keeps only `ruleId`, `method`, `path`, `action`,
`timestamp`, and the domain-separated `providerRequestRef`; IP addresses, full
URLs, query values, provider payloads, account ids, and raw request identities
are discarded. The rule id and route must match the pinned policy, each
timestamp must fall inside its corresponding probe window, and concurrent
traffic with another Ray ID cannot satisfy the readback. This exact correlation
is what distinguishes the edge WAF ceiling from an application limiter.
`providerEventReadbackDigest` is derived from those exact redacted event bytes
and is exposed as a release-attestation binding.

The final receipt's `capturedAt` is derived exactly from the provider export's
canonical `exportedAt`; the CLI does not accept a caller-supplied freshness
label. Validation exposes the same instant as `effectiveSourceObservedAt`.

Only route id, ordinal, status, parsed delay, and the domain-separated request
reference for each eleventh response are retained from HTTP responses. Base
URL, raw headers, raw Ray IDs, POST body, response headers other than the
parsed delay and one-way request reference, and all response bodies are
structurally absent from the receipt.

The hosted adapter performs that probe directly, polls a bounded
`firewallEventsAdaptive` GraphQL window, and fails closed if the result reaches
its fixed limit, contains ambiguous correlated events, or does not expose one
matching block event per Ray ID. Raw Rulesets and GraphQL response bytes exist
only under a new mode-`0700` directory in `RUNNER_TEMP`; the process destroys
that directory and verifies absence before it writes or uploads safe output.
The artifact contains exactly `receipt.json` and
`sanitized-provider-manifest.json`. When Cloudflare supplies a whole-second
event time, the adapter treats it as a one-second precision interval and emits
the earliest millisecond in its intersection with the exact local probe
window. It refuses the event when those intervals do not overlap.

The sanitized manifest also carries an exact producer closure: ordered
SHA-256 bindings for the trusted workflow, WAF capture and evidence adapters,
shared canonical serializer and digest sources, TypeScript build
configuration, and package manifest/lockfile. Archive validation recomputes
that closure with `git show` from the authenticated capture run's exact
`head_sha`; current-worktree bytes or a semantically coherent manifest from a
different producer revision cannot satisfy the archive.

After proposing the artifact's exact `receipt.json` bytes at
`research/ops-evidence/waf-ceilings.json`, archive the source run with the
`waf-ceilings` profile in `Archive Hosted Evidence`. Its only source role is
`provider-capture`, its trusted workflow is
`.github/workflows/waf-ceiling-evidence.yml`, and its selected artifact must be
the exact `site-behavior-waf-ceiling-evidence-<run_id>-<run_attempt>` artifact.
Release readiness accepts the WAF receipt only when this authenticated archive
is digest-enumerated by the measurement carrier.

Failed hosted attempts keep a separate `site-behavior-waf-ceiling-failure-*`
artifact after private-response destruction succeeds. Its `failure.json`
contains only the candidate, fixed route identifiers, attempt ordinals,
timestamps, HTTP statuses and numeric Retry-After values. It preserves the
actual unexpected response even when transcript validation fails. It contains
no response bodies, credentials, raw Ray IDs or release receipt and cannot
satisfy readiness. The workflow still fails on the original contradiction.

## Bounded, redacted log queries

Export the provider readback to a file outside the repository. The capture
object supplies `candidateCommit`, `deploymentCommit`, `policy`,
`retentionReadback`, `rawResults`, `sourceTool` (`name` and `version`), and the
private `providerQueryId`. Policy is exact and contains:

- provider and private provider policy id;
- configured retention of 1–30 days;
- a canonical UTC query window no longer than that retention;
- a maximum of 1–1000 results per query;
- ordered `health` (`/api/health`) and `reports` (`/reports/`) queries; and
- the producer's fixed redaction contract.

Each raw result needs only `queryId` and `observedAt`; provider-specific fields
may be present in the private export. The producer groups and sorts the
timestamps and discards every other raw field:

```bash
npm run ops:evidence:log-retention -- \
  --capture <private-provider-export.json> \
  --output research/ops-evidence/log-retention.json
```

The receipt cannot carry a target URL, query value, credential, request body,
payload, or report identifier because result events admit exactly one field:
`observedAt`. `logPolicyDigest` is re-derived from the canonical policy bytes,
and the provider retention readback must equal the policy. The committed
`sourceArtifact` binds the exact private export byte length and SHA-256 digest,
the exporter name/version, a domain-separated digest of the provider query id,
the exact query window, and a digest of the retention readback. The policy id
and retention-readback policy reference are also converted to separate
domain-separated SHA-256 references. The raw query id, policy identifiers, and
provider-specific result fields never enter the receipt.
`capturedAt` is derived exactly from `retentionReadback.readAt`, which must
follow the bounded query window, and the validator exposes that source instant
as `effectiveSourceObservedAt`.

## Independent egress backstop

Create three separate inputs. The small binding JSON contains exactly
`candidateCommit` and `deploymentCommit`. A provider policy
export contains the exact `networkPolicy`. An independently produced failure
probe transcript contains the `failureModeProbe`. Keep the two source artifacts
outside the repository if they contain provider metadata; both must already be
sanitized before this command reads them.

The policy must be owned outside the application process, default-deny, allow
only public TCP 80/443, and contain the canonical private, link-local, and
metadata CIDR sets. It also records domain-separated references for the
controlled collection egress label and NAT identity, plus the coarse public
region. The positive control is fail-closed to the reviewed
literal `1.1.1.1:443`; IPv6, mapped IPv6, documentation ranges, and alternate
destinations are not accepted as a substitute.

The probe must run outside the application with the application guard
disabled. It records one deny decision for each configured blocked class plus
one allowed public control, all inside one window of at most one minute. Every
observation must occur within 30 seconds of probe completion. Generate the
receipt only from the retained policy export and probe transcript:

```bash
npm run ops:evidence:egress -- \
  --binding <candidate-binding.json> \
  --network-policy-export <provider-network-policy.json> \
  --failure-probe-transcript <independent-probe-transcript.json> \
  --output research/ops-evidence/egress-backstop.json
```

`networkPolicyDigest` is always calculated from the canonical policy. Replacing
it with an arbitrary digest, changing a rule id, or relabeling an allowed
connection as blocked fails verification. The receipt also records the exact
byte length and `sha256:<digest>` of each source artifact. The release
attestation must bind both source-artifact digests; a hand-authored
`outcome: blocked` object without the separately retained policy export and
probe transcript is not accepted by the producer. Provider, policy, firewall
rule, and NAT identities are converted to domain-separated SHA-256 references
before the receipt is committed. Their raw values remain only in the bound
private source artifacts.
The receipt's `capturedAt` is derived exactly from
`failureModeProbe.completedAt`; callers cannot relabel an old probe as fresh,
and validation exposes that instant as `effectiveSourceObservedAt`.

## Same-session staging teardown

Preview the complete fixed deletion surface without loading an adapter or
changing external state:

```bash
npm run ops:evidence:staging-teardown -- --dry-run
```

The plan includes both Workers, custom DNS names, container applications, and
R2 buckets, plus both staging credential sets, the replay fault hook, and the
`durable-replay-staging-runner-registration`. The exact buckets are
`site-behavior-lab-reports-staging` and
`site-behavior-lab-reports-watch-staging`.

The controlled-r2 runner registration is deliberately not a staging teardown
resource. It remains available for freeze activation and both controlled corpus
cycles, then follows the per-cycle runner-destruction receipt lifecycle.

The local receipt producer remains data-only: it never loads provider code,
never reads credentials, never performs network operations, and never deletes
resources. The
hosted ceremony uses the reviewed provider kind
`cloudflare-github-exact-v1`. It combines two bounded direct API clients:
Cloudflare owns the first eleven logical resources and GitHub owns only the
exact repository runner registration. It does not invoke Wrangler because
Wrangler's container JSON command does not expose complete cursor pagination.
Every before inventory finishes before the first mutation. Removal closes the
runner and ingress first, deletes both Workers, revokes the two exact staging
R2 writers before any bucket re-list/delete, then removes containers, buckets,
and the fault-hook surface. The complete twelve-resource after inventory must
prove absence in the same lowercase UUIDv4 session.

Inventory records contain exactly the fixed kind and logical name, sorted
external IDs, state, and an `evidenceArtifact`. Action records contain the same
identity, matching external IDs, the required disposition, a canonical
completion timestamp, and an `evidenceArtifact`. Each artifact has exactly
`kind`, `sessionId`, and `bytes`: inventory uses
`provider-inventory-response`, completed actions use
`provider-removal-response`, and the session id must equal the transcript
session. Supply only sanitized provider response bytes; never include
credentials, tokens, request headers, or account-private payloads.

```bash
npm run ops:evidence:staging-teardown -- \
  --capture <sanitized-staging-teardown-transcript.json> \
  --output research/ops-evidence/staging-teardown.json
```

The transcript carries `stagingSourceCommit`, `recordedAt`, the five fixed
session timestamps, and `{before, actions, after}` inventory arrays. The
producer rejects extra fields, hashes each external identifier with a
domain-separated resource binding, hashes every exact sanitized response, and
keeps only structured `{kind, sessionId, digest}` response references. It also
binds the exact transcript byte length and SHA-256. Any surviving resource,
wrong disposition, cross-session response, missing fixed resource, or
non-monotonic timestamp refuses the canonical receipt. So does a transcript in
which no resource was observed present and removed: an all-already-absent
inventory proves only that nothing was there, which is what a rerun of a
completed ceremony produces. Output is create-only
and symlink-safe.

This receipt is a pre-candidate durable prerequisite: it carries
`stagingSourceCommit`, `recordedAt`, and the re-derived
`teardownInventoryDigest`, not a future candidate commit.

Release use additionally requires the dedicated `Staging Teardown Evidence`
workflow and its authenticated hosted archive. The workflow may upload only
`receipt.json` and `sanitized-provider-manifest.json`; bounded raw provider
responses are written with mode `0600` under a private `RUNNER_TEMP` directory
inside a create-only mode-`0700` parent. The capture CLI destroys that complete
private directory on both success and failure before either safe file is
created. A missing directory or failed destruction is authoritative failure and
prevents safe-output creation. Neither the workflow artifact nor the later
archive may contain, download, or reconstruct those raw responses. The
safe manifest must also enumerate the exact ordered SHA-256 closure of the
capture workflow,
capture CLI, composite/provider HTTP libraries, strict and canonical JSON
parsers, digest sources, package metadata, and TypeScript build configuration.
Archive validation recomputes that closure from the authenticated capture
`head_sha`; candidate verification then requires every listed source byte to
equal the candidate-approved byte. Missing, extra, stale, or replayed producer
sources fail closed. A local receipt can exercise the schema, but cannot clear
the durable prerequisite while that adapter or the digest-addressed hosted
archive is absent. The hosted archive's subject commit is the unique
pre-candidate commit that first contains the exact receipt bytes;
`stagingSourceCommit` remains the separate replay-deployment identity.
Candidate `C` contains the fixed receipt, never the hosted archive. The
digest-addressed archive is introduced afterward through the append-only
evidence carrier, whose enumerated bytes and authenticated archiver/source
history are verified against `C`.

### Preserve the hosted receipt and archive it after `C`

The release subject is the exact `receipt.json` uploaded by the successful
hosted teardown run. Do not regenerate it from the sanitized manifest or a
caller-authored transcript. At teardown time, record the exact successful run
id, run attempt, workflow head SHA, and immutable artifact id in the private
ceremony log. Do not merge an evidence commit while `P` is waiting for its
flag-only child `F`, or while `F` is frozen for the durable soak.

After the `P` to `F` transition and soak are complete, but before selecting
candidate `C`, copy the hosted receipt byte-for-byte into the repository. The
following handoff authenticates the recorded run and artifact, verifies the
downloaded ZIP against GitHub's artifact digest, refuses any member other than
the two privacy-safe files, and compares the receipt digest before and after
the create-only copy:

```bash
set -euo pipefail
umask 077
TEARDOWN_RUN_ID='<successful-run-id>'
TEARDOWN_RUN_ATTEMPT='<successful-run-attempt>'
TEARDOWN_HEAD_SHA='<40-character-workflow-head-sha>'
TEARDOWN_ARTIFACT_ID='<immutable-artifact-id>'
TEARDOWN_ARTIFACT_NAME="site-behavior-staging-teardown-evidence-${TEARDOWN_RUN_ID}-${TEARDOWN_RUN_ATTEMPT}"
TEARDOWN_SUBJECT_PATH='research/ops-evidence/staging-teardown.json'
TEARDOWN_HANDOFF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/site-behavior-staging-teardown-handoff.XXXXXX")"
trap 'rm -rf "$TEARDOWN_HANDOFF_DIR"' EXIT
install -d -m 0700 "$TEARDOWN_HANDOFF_DIR/safe"

gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/iAnonymous3000/site-behavior-lab/actions/runs/${TEARDOWN_RUN_ID}" \
  > "$TEARDOWN_HANDOFF_DIR/run.json"
jq -e \
  --argjson runId "$TEARDOWN_RUN_ID" \
  --argjson runAttempt "$TEARDOWN_RUN_ATTEMPT" \
  --arg headSha "$TEARDOWN_HEAD_SHA" \
  '.id == $runId and .run_attempt == $runAttempt and
   .head_sha == $headSha and .head_branch == "main" and
   .event == "workflow_dispatch" and .status == "completed" and
   .conclusion == "success" and
   .path == ".github/workflows/staging-teardown-evidence.yml"' \
  "$TEARDOWN_HANDOFF_DIR/run.json" >/dev/null

gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/iAnonymous3000/site-behavior-lab/actions/artifacts/${TEARDOWN_ARTIFACT_ID}" \
  > "$TEARDOWN_HANDOFF_DIR/artifact.json"
jq -e \
  --argjson artifactId "$TEARDOWN_ARTIFACT_ID" \
  --argjson runId "$TEARDOWN_RUN_ID" \
  --arg name "$TEARDOWN_ARTIFACT_NAME" \
  --arg headSha "$TEARDOWN_HEAD_SHA" \
  '.id == $artifactId and .name == $name and .expired == false and
   .workflow_run.id == $runId and .workflow_run.head_sha == $headSha and
   (.digest | test("^sha256:[0-9a-f]{64}$"))' \
  "$TEARDOWN_HANDOFF_DIR/artifact.json" >/dev/null
TEARDOWN_ARTIFACT_DIGEST="$(jq -r .digest "$TEARDOWN_HANDOFF_DIR/artifact.json")"

gh api \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "repos/iAnonymous3000/site-behavior-lab/actions/artifacts/${TEARDOWN_ARTIFACT_ID}/zip" \
  > "$TEARDOWN_HANDOFF_DIR/artifact.zip"
test "sha256:$(shasum -a 256 "$TEARDOWN_HANDOFF_DIR/artifact.zip" | awk '{print $1}')" \
  = "$TEARDOWN_ARTIFACT_DIGEST"
test "$(unzip -Z1 "$TEARDOWN_HANDOFF_DIR/artifact.zip" | LC_ALL=C sort)" \
  = $'receipt.json\nsanitized-provider-manifest.json'
unzip -p "$TEARDOWN_HANDOFF_DIR/artifact.zip" receipt.json \
  > "$TEARDOWN_HANDOFF_DIR/safe/receipt.json"
unzip -p "$TEARDOWN_HANDOFF_DIR/artifact.zip" sanitized-provider-manifest.json \
  > "$TEARDOWN_HANDOFF_DIR/safe/sanitized-provider-manifest.json"

npm ci --ignore-scripts
npm run build:schema
TEARDOWN_VERIFY_JSON="$(node scripts/staging-teardown-hosted-capture.mjs \
  --verify --directory "$TEARDOWN_HANDOFF_DIR/safe")"
TEARDOWN_RECEIPT_SHA256="$(shasum -a 256 \
  "$TEARDOWN_HANDOFF_DIR/safe/receipt.json" | awk '{print $1}')"
test "$(printf '%s' "$TEARDOWN_VERIFY_JSON" | jq -r .receiptSha256)" \
  = "$TEARDOWN_RECEIPT_SHA256"

test ! -e "$TEARDOWN_SUBJECT_PATH"
install -m 0600 "$TEARDOWN_HANDOFF_DIR/safe/receipt.json" \
  "$TEARDOWN_SUBJECT_PATH"
cmp -s "$TEARDOWN_HANDOFF_DIR/safe/receipt.json" "$TEARDOWN_SUBJECT_PATH"
test "$(shasum -a 256 "$TEARDOWN_SUBJECT_PATH" | awk '{print $1}')" \
  = "$TEARDOWN_RECEIPT_SHA256"
npm run ops:evidence:verify -- --evidence "$TEARDOWN_SUBJECT_PATH"
```

### Retire teardown authorities only after authoritative success

Do not automate credential retirement inside the hosted teardown job. A
partial attempt needs the same narrowly scoped authorities to inventory its
survivors, seal a new exact target, and resume safely. Keep those authorities
only for that bounded recovery window.

Recovery is component-specific. A partially removed DNS logical resource is
resumable: capture its exact surviving custom-domain, record, and certificate
components, seal a new survivor manifest, and resume the bounded deletions. An
absent Worker with its own Durable Object namespace still present is not
resumable by this adapter. Preserve the authorities and escalate for the
separately reviewed manual tombstone or tombstone-deployment path; do not mark
the run complete, retire credentials, or turn the orphan into an all-absent
target.

After the exact successful run and immutable artifact have been authenticated,
the safe directory has verified, and its receipt proves every contracted
resource absent, retire the ceremony's authority before doing unrelated work:

1. Using a separate maintainer credential that is not one of the teardown
   tokens, revoke all five Cloudflare API tokens supplied as
   `STAGING_TEARDOWN_CF_COMPUTE_TOKEN`, `STAGING_TEARDOWN_CF_DNS_TOKEN`,
   `STAGING_TEARDOWN_CF_R2_TOKEN`,
   `STAGING_TEARDOWN_CF_TOKEN_ADMIN_TOKEN`, and
   `STAGING_TEARDOWN_CF_OBSERVATION_TOKEN`. Read back each exact public token
   id/name as absent; never record or re-display a token value.
2. Delete every teardown secret from the protected `release-evidence`
   environment: the sealed target JSON, all five Cloudflare tokens, and
   `STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY`. Delete the teardown-only
   variables `STAGING_TEARDOWN_PROVIDER_KIND`,
   `STAGING_TEARDOWN_TARGETS_SHA256`, `STAGING_TEARDOWN_CF_ZONE_ID`, and
   `STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID`. Keep the shared
   `CLOUDFLARE_ACCOUNT_ID` variable because the lifecycle and durable-restart
   evidence lanes also consume it.
3. Disable the dedicated runner-administration App key and uninstall or disable
   that repository-only App installation when it has no other approved use.
   The job's installation tokens were already revoked by the capture code;
   removing the protected private key and installation closes the longer-lived
   minting authority.

The GitHub cleanup is name-only and accepts no secret values:

```bash
(
set -euo pipefail
teardown_secret_names=(
  STAGING_TEARDOWN_TARGETS_JSON
  STAGING_TEARDOWN_CF_COMPUTE_TOKEN
  STAGING_TEARDOWN_CF_DNS_TOKEN
  STAGING_TEARDOWN_CF_R2_TOKEN
  STAGING_TEARDOWN_CF_TOKEN_ADMIN_TOKEN
  STAGING_TEARDOWN_CF_OBSERVATION_TOKEN
  STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY
)
teardown_variable_names=(
  STAGING_TEARDOWN_PROVIDER_KIND
  STAGING_TEARDOWN_TARGETS_SHA256
  STAGING_TEARDOWN_CF_ZONE_ID
  STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID
)
for name in "${teardown_secret_names[@]}"; do
  gh secret delete "$name" --env release-evidence
done
for name in "${teardown_variable_names[@]}"; do
  gh variable delete "$name" --env release-evidence
done

remaining_secret_names="$(
  gh secret list --env release-evidence --json name --jq '.[].name'
)"
remaining_variable_names="$(
  gh variable list --env release-evidence --json name --jq '.[].name'
)"
for name in "${teardown_secret_names[@]}"; do
  ! grep -Fqx "$name" <<<"$remaining_secret_names"
done
for name in "${teardown_variable_names[@]}"; do
  ! grep -Fqx "$name" <<<"$remaining_variable_names"
done
unset remaining_secret_names remaining_variable_names \
  teardown_secret_names teardown_variable_names
)
```

Record only the UTC retirement time; the five revoked Cloudflare token
ids/names; the GitHub App installation/key disposition; and the name-only
absence readback for the protected secrets and variables in the private
ceremony log. Do not copy that private log, target JSON, or credential material
into the repository or hosted evidence archive.

Commit that one byte-exact subject through normal review before `C`, and record
the protected-main commit that first introduced it. After merge, re-read that
Git object rather than trusting the proposal branch SHA:

```bash
git fetch origin main
TEARDOWN_SUBJECT_COMMIT="$(git log origin/main --diff-filter=A \
  --format=%H -- research/ops-evidence/staging-teardown.json)"
[[ "$TEARDOWN_SUBJECT_COMMIT" =~ ^[0-9a-f]{40}$ ]]
test "$(git show \
  "${TEARDOWN_SUBJECT_COMMIT}:research/ops-evidence/staging-teardown.json" \
  | shasum -a 256 | awk '{print $1}')" = "$TEARDOWN_RECEIPT_SHA256"
```

Only `receipt.json` becomes the candidate-resident subject. The sanitized
provider manifest remains in the authenticated safe artifact and later hosted
archive; do not commit a second loose copy. The private provider-response
directory was destroyed before the safe artifact existed and must never be
downloaded, reconstructed, or placed in the repository.

After selecting `C`, dispatch the `staging-teardown` profile from protected
`main` with exactly one `provider-capture` source. The source must name the
original teardown run, not the later subject commit or an all-absent rerun:

```bash
(
set -euo pipefail
: "${TEARDOWN_SUBJECT_COMMIT:?record the protected-main subject introduction first}"
: "${TEARDOWN_RUN_ID:?record the original teardown run id first}"
: "${TEARDOWN_RUN_ATTEMPT:?record the original run attempt first}"
: "${TEARDOWN_HEAD_SHA:?record the original workflow head SHA first}"
: "${TEARDOWN_ARTIFACT_ID:?record the immutable artifact id first}"
CANDIDATE_COMMIT='<40-character-measurement-candidate-sha>'
git merge-base --is-ancestor "$TEARDOWN_SUBJECT_COMMIT" "$CANDIDATE_COMMIT"
TEARDOWN_SOURCES_JSON="$(jq -cn \
  --argjson runId "$TEARDOWN_RUN_ID" \
  --argjson runAttempt "$TEARDOWN_RUN_ATTEMPT" \
  --arg headSha "$TEARDOWN_HEAD_SHA" \
  --argjson artifactId "$TEARDOWN_ARTIFACT_ID" \
  '{sources:[{
    role:"provider-capture",
    workflowPath:".github/workflows/staging-teardown-evidence.yml",
    runId:$runId,
    runAttempt:$runAttempt,
    headSha:$headSha,
    artifact:{id:$artifactId}
  }]}')"
gh workflow run archive-hosted-evidence.yml --ref main \
  -f profile=staging-teardown \
  -f subject_path=research/ops-evidence/staging-teardown.json \
  -f subject_commit="$TEARDOWN_SUBJECT_COMMIT" \
  -f sources_json="$TEARDOWN_SOURCES_JSON"
)
```

The workflow must succeed and open its generated
`automation/hosted-evidence-staging-teardown-*` proposal. Review that proposal
as an append-only carrier: it may add only
`research/hosted-evidence/staging-teardown/<receipt-sha256>/`, and every file in
that directory must remain byte-for-byte as generated. Approve the proposal's
parked push-event CI run, require the normal checks, and merge it without hand
editing, transplanting, or combining it with unrelated changes. If it conflicts
with another evidence proposal, close it and rerun the archiver.

Before the final carrier can verify, every generated archive file must appear
exactly once in `research/measurement-candidate-binding.json` as
`hosted-evidence-archive`, `change:"added"`, with its own SHA-256. The complete
`C..S` history must remain a linear single-parent evidence-only chain, and its
changed paths must be set-equal to the binding. A directory digest, loose copy
of the sanitized manifest, or archive that is not digest-enumerated cannot
substitute for that carrier.

### Configure the protected hosted adapter

Do not provision these authorities until the teardown blast radius is approved.
The `release-evidence` environment must require reviewers, and its App must be
installed only on `iAnonymous3000/site-behavior-lab`. Configure these protected
environment variables:

- `STAGING_TEARDOWN_PROVIDER_KIND=cloudflare-github-exact-v1`;
- `STAGING_TEARDOWN_TARGETS_SHA256`, the generator-reported SHA-256 of the
  canonical strict target manifest;
- `CLOUDFLARE_ACCOUNT_ID`, the exact 32-hex account identity independently
  checked against the manifest;
- `STAGING_TEARDOWN_CF_ZONE_ID`, the exact 32-hex staging zone identity
  independently checked against the manifest; and
- `STAGING_TEARDOWN_RUNNER_APP_CLIENT_ID`, the GitHub App client id (never the
  deprecated numeric App id).

Configure these protected environment secrets:

- `STAGING_TEARDOWN_TARGETS_JSON`, the sealed generator output;
- `STAGING_TEARDOWN_CF_COMPUTE_TOKEN`, restricted to the exact account with
  **Workers Scripts Write** and **Containers Write**. Worker custom-domain list
  and detach also use this token because that API requires Workers Scripts
  Write;
- `STAGING_TEARDOWN_CF_DNS_TOKEN`, restricted to the exact zone with **DNS
  Write**, plus **SSL and Certificates Write** only when the manifest names a
  certificate pack dedicated to exactly one staging hostname;
- `STAGING_TEARDOWN_CF_R2_TOKEN`, restricted to the exact account with
  **Workers R2 Storage Write**. This authority performs only the reviewed
  bucket/object/configuration reads and exact object/bucket deletes. Cloudflare
  does not offer a bucket-name-scoped authority for every endpoint used here,
  so the adapter pins the two exact names and complete bucket, configuration,
  and object projections immediately before mutation;
- `STAGING_TEARDOWN_CF_TOKEN_ADMIN_TOKEN`, restricted to the exact account with
  **Account API Tokens Read** and **Account API Tokens Write**. Cloudflare does
  not offer token-id-scoped revocation authority, so the adapter repeats the
  exact id/name/canonical-policy comparison immediately before each DELETE.
  Each external-writer proof also resolves the current provider permission-
  group directory with this authority and classifies Storage, Bucket Item, and
  Data Catalog write policies by provider id; an omitted policy-group display
  name cannot hide a live R2 writer;
- `STAGING_TEARDOWN_CF_OBSERVATION_TOKEN`, a read-only **user-scoped API token**
  restricted to the exact account, with **Zone Read**, **Workers CI Read**,
  **Workers Scripts Read**,
  **Pipelines Read**, and **Workers R2 Data Catalog Read**. Its zone resources
  must include every zone in that one account, with **Email Routing Rules
  Read** and **Workers Routes Read** for those zones. Cloudflare's Worker Builds
  API rejects account-owned tokens, so this one observation credential is
  intentionally user-scoped; the other Cloudflare teardown authorities remain
  separately scoped as described above. The Event Subscriptions inventory is
  authorized by the already-required Workers Scripts Read permission, so do
  not add redundant Queues authority. The wider all-account-zone
  read is necessary because a route or Email Routing rule in any of the
  account's zones can still target a Worker being deleted; do not restrict this
  token to only `STAGING_TEARDOWN_CF_ZONE_ID`; and
- `STAGING_TEARDOWN_RUNNER_APP_PRIVATE_KEY`, for an App granted repository
  **Administration write**. GitHub exposes runner unregistration only through
  that broader repository permission. The capture process signs a GitHub App
  JWT from the protected client id and private key, resolves the installation
  through the canonical repository endpoint, and requests
  `Administration: write` for `site-behavior-lab` explicitly. It refuses an
  all-repositories installation, any extra effective token permission other
  than GitHub's implicit Metadata read, or any mint response that does not name
  exactly `iAnonymous3000/site-behavior-lab`. The approximately one-hour token
  is cached only while more than five minutes remain and is then re-minted;
  every superseded token is revoked before its replacement becomes usable,
  and the final current token is revoked on both successful and failed capture
  paths. A syntactically usable token from a 201 response is registered for
  cleanup immediately after bounded strict parsing and before the fallible raw
  sink; raw-response persistence failure remains authoritative while the token
  is still revoked. The checked refresh ceiling and derived App request budget
  are the exported
  `STAGING_TEARDOWN_GITHUB_APP_TOKEN_REFRESH_MAX_COUNT` and
  `STAGING_TEARDOWN_GITHUB_APP_REQUEST_BUDGET` values in
  `scripts/staging-teardown-github-app-token.mjs`; do not substitute a stale
  prose refresh count. The adapter accepts only runner id/name plus the
  exact sorted labels `Linux`, `X64`, `durable-replay-staging`, and
  `self-hosted`, with `busy=false` and `status=offline`. Stop the exact staging
  runner service and confirm it is offline before dispatch; an online idle
  runner is still eligible to accept a queued job and is refused.

The five Cloudflare secrets must be pairwise distinct; a single super-token is
refused. The mutation clients permit only GET and DELETE, and every operation
uses only the client holding the corresponding authority. The observation
token is used only for bounded GET inventories. The separate App
credential client additionally permits only the canonical JSON POST needed to
mint an installation token, with a 16 KiB request-body ceiling. It additionally
reserves one bounded `DELETE /installation/token` for every possible mint,
including final cleanup.

All clients follow no redirects, cap each response at 1 MiB
in one fixed buffer, parse provider and target JSON with the
duplicate-key/depth-safe strict parser, and apply a surface-specific page cap
no greater than the global ten-page ceiling. The
manifest permits at most 20 exact DNS records and 180 R2 object keys across the
two buckets. Every helper client has a local ceiling of 250 requests, while
all helpers using the same credential also consume one shared cumulative
per-authority request/deadline ledger; constructing another helper cannot reset
that ledger. Those ceilings reserve enough of each authority's checked budget
to finish re-inventory after its first destructive call. The canonical target
is also capped at 48 KiB so every sealed file accepted by the generator fits
the GitHub Actions secret that carries it. The authoritative per-client proof,
aggregate request-duration ceiling, and non-provider reserve are
`STAGING_TEARDOWN_PROVIDER_REQUEST_BUDGET_PROOF`,
`STAGING_TEARDOWN_PROVIDER_WORST_CASE_MILLISECONDS`, and
`STAGING_TEARDOWN_WORKFLOW_NON_PROVIDER_RESERVE_MILLISECONDS` in
`scripts/staging-teardown-provider-adapters.mjs`. The committed
`timeout-minutes` in `.github/workflows/staging-teardown-evidence.yml` must
cover their checked sum; the durable-producer tests enforce that relationship.
No copied timeout or request total in this runbook overrides those source
constants. An object key with a
`.` or `..` path segment is refused before inventory; other reserved and
Unicode bytes are percent-encoded while key slashes remain literal.

The Super Slurper inventory is a deliberate permission boundary. The adapter
uses the R2 authority to exhaustively GET the bounded
`/accounts/{account}/slurper/jobs` surface and refuses an active job whose R2
source or target is either staging bucket. This repository does not claim that
Cloudflare exposes a separately named, independently demonstrated read-only
Super Slurper permission. Before provisioning, verify privately which current
Cloudflare capability authorizes that GET for the exact-account R2 token. A
403, incomplete list, or pressure to add an unrelated broad permission leaves
the ceremony blocked; never skip this inventory or silently move it to a
super-token.

The provider proof enumerates account-owned API tokens, active deployed Worker
versions and their direct R2 bindings, Pipeline R2 sinks, Super Slurper jobs,
and R2 Data Catalog warehouses. That is not an exhaustive R2 proof. Cloudflare
REST does not enumerate incomplete multipart uploads or S3-only encryption
state, and it does not expose an exhaustive account inventory of user-owned R2
credentials, dashboard-created S3 credentials, derived temporary credentials,
or credentials already handed to an external process.

Therefore the protected-environment reviewer must record an independent
operator assertion in the private ceremony log before dispatch: both named
buckets were created as isolated staging-only resources for this same ceremony
and were never shared; no client used multipart upload and no incomplete upload
is outstanding (otherwise stop until an exact one-day abort-incomplete-multipart
lifecycle has been verified and its full interval has elapsed); both buckets
use only the provider's default encryption and have no S3-only or SSE-C state;
the five teardown tokens were provisioned for this same ceremony and are not
shared; all staging writers have been stopped; and no unenumerable user-owned,
temporary, or externally held credential can write either bucket during the
complete before/mutation/after session. These are residual human boundaries,
not facts the sanitized receipt can establish. Missing or uncertain
confirmation blocks the teardown.

Worker deletion never uses `force=true`. Immediately before each non-force
DELETE, the adapter rechecks the reviewed immutable Worker id against its
script name, the exact `SCANNER` / `ScannerContainer` namespace id, and the
account namespace list. It requires the exact Worker attachment graph to show
no custom domain, queue consumer, Worker service binding, dispatch-namespace
outbound, Tail Worker consumer, or external Durable Object reference. It also
requires the Wrangler-compatible references and Tail-producer endpoints to
show no incoming service, Pages Function, external Durable Object, dispatch
outbound, or tail producer; independently lists every account custom domain
and refuses any whose service still names the Worker; enumerates all zones in
the account for classic routes and Email Routing actions; refuses Worker-build
Event Subscriptions; and requires empty Worker Builds triggers/deploy hooks,
the exact target-pinned stopped-build history with no live build, and an empty
script cron list. The complete build inventory brackets the final sealed Worker
projection so a build cannot finish and deploy unnoticed between those reads.
workers.dev and preview ingress must be disabled, and settings may contain no provider-
resource binding beyond plain text, secrets, and the one reviewed Durable
Object namespace. The exact own namespace must disappear
atomically with the Worker. Cloudflare exposes no direct namespace DELETE API:
if a Worker is absent but its own namespace remains, the adapter refuses every
mutation. Stop, re-cut the candidate, and obtain a separately reviewed manual
tombstone or tombstone-deployment escalation, such as a deleted-export
tombstone migration; this adapter never silently deploys one.

Each container target independently pins the application id/name, its
`durable_objects.namespace_id`, resolved image and application state, complete
deployments and rollouts, and a privacy-safe digest of every inactive Durable
Object row. The application may omit `jobs` or set it exactly to `false`;
`jobs:true`, `jobs:null`, or any other value selects or ambiguously represents
provider job mode, whose separate queue the instance API cannot prove drained.
The adapter completely
paginates the pinned Wrangler application-
instances endpoint during initial inventory and again immediately before both
Worker and application deletion. Any live/nonterminal instance, any inactive
row still carrying a deployment or placement id, pagination gap, or digest
drift refuses before mutation. A container that survives its Worker therefore
remains exactly recoverable. A container may be treated as a cascade only
after deletion of its specifically mapped Worker; every explicit container
DELETE must converge to an exact-id 404.

Zero live placements is necessary but does not authenticate the application's
Durable Object job ledger. Before dispatch, record a separate authenticated
staging readback proving both replay jobs completed and that neither application
has queued, running, publishing, retryable, or restart-scheduled work. Stop all
canary/scheduler writers and wait through the configured 15-minute container
sleep interval before sealing the target. Missing ledger/drain evidence blocks
teardown; the sanitized provider receipt cannot infer it from the instance API.

### Generate and seal the exact target manifest

Never author or hand-populate the destructive JSON shape. The primary path is
`staging:teardown-targets --capture`: it generates the canonical all-absent
shape for the exact replay source commit and account/zone identities, fills it
from fresh bounded provider reads, validates it, and writes one create-only
mode-`0600` captured manifest. It creates the requested private provider-
response directory itself at mode `0700`, writes each exact decoded response-
body byte sequence once as a strictly indexed mode-`0600` file, and destroys
that entire directory before
the captured manifest writer becomes reachable. A capture refusal writes no
manifest and reports only a generic error; provider bytes and credential
values never enter stdout, argv, shell history, a safe artifact, or Git.

Provision six pairwise-distinct read credentials. The command accepts each
secret only in its named environment variable or, preferably, through the
corresponding `_FILE` variable naming a current-user-owned, non-symlink,
mode-`0600` file:

- `STAGING_TEARDOWN_CAPTURE_CF_COMPUTE_READ_TOKEN_FILE`: exact-account
  **Workers Scripts Read** and **Containers Read**, for Durable Object
  namespace, Worker-domain, container application, deployment, rollout, and
  instance inventories;
- `STAGING_TEARDOWN_CAPTURE_CF_DNS_READ_TOKEN_FILE`: exact-zone **DNS Read**
  and **SSL and Certificates Read**;
- `STAGING_TEARDOWN_CAPTURE_CF_R2_READ_TOKEN_FILE`: exact-account **Workers
  R2 Storage Read**;
- `STAGING_TEARDOWN_CAPTURE_CF_TOKEN_READ_TOKEN_FILE`: exact-account
  **Account API Tokens Read**;
- `STAGING_TEARDOWN_CAPTURE_CF_OBSERVATION_READ_TOKEN_FILE`: a user-scoped
  token restricted to the exact account with **Workers Scripts Read** and
  **Workers CI Read**, because Worker Builds refuses an account-owned token;
  and
- `STAGING_TEARDOWN_CAPTURE_GITHUB_APP_READ_TOKEN_FILE`: a short-lived
  installation token minted separately from an App installed only on
  `iAnonymous3000/site-behavior-lab`, with repository **Administration read**
  plus GitHub's implicit Metadata read and no other repository permission.

The capture code enforces credential separation, endpoint/client separation,
GET-only requests, response and page bounds, no redirects, strict JSON, and an
execution ceiling below the installation token's one-hour lifetime. It cannot
inspect how an operator minted or scoped a token. Before capture, independently
prove the six effective permission/resource sets, the exact repository-only
App installation, and sufficient remaining GitHub token lifetime. Never reuse
the later destructive adapter's write authorities for this read ceremony.

A present target pins all of the following, not merely its display name:

- each Worker's immutable `scripts-search?id=` id, script name, creation and
  modification instants, latest script ETag, exact Durable Object
  binding/class/namespace, mapped container, sorted secret-name set, complete
  bounded version state, and canonical SHA-256 projections of version
  settings, script settings, deployments, each version's metadata, and each
  version's resources, plus the privacy-safe digest of the complete bounded
  stopped Worker Builds history;
- each custom domain's id and `cert_id`; every matching DNS record's
  id/type/name/content/proxied/TTL/priority/comment/tags/settings and creation
  and modification instants; and the full dedicated Advanced Certificate pack
  projection and matching SHA-256: pack id/type/status/one-host set plus every
  nested certificate's id, exact host set, and status;
- each container's application id, mapped Worker and namespace, resolved image
  digest, and canonical SHA-256 projections of the complete application,
  deployment set, fully paginated rollout set, and inactive Durable Object
  instance rows; `jobs` must be absent or exactly `false`, and no live
  placement is an acceptable target state;
- each R2 bucket's name, creation date, jurisdiction, location, storage class,
  exact one-day lifecycle rule, disabled managed `r2.dev` bucket id/domain, and
  every object key with ETag, size, last-modified instant, SSE-C state, storage
  class, custom metadata, and HTTP metadata; and
- each account-owned staging token's id, canonical name, complete policy array,
  and canonical policy SHA-256; the exact fault-hook binding state; and the
  offline runner's id, name, and exact labels.

The account-wide Durable Object namespace API documents ownership fields as
optional. That does not make an ownerless row safe to ignore: capture refuses
any row without a nonempty `script`, because it cannot exclude an orphaned
canonical namespace. A row with a validated noncanonical script may omit its
class; either canonical script requires the exact reviewed class/id linkage.

The two logical R2 targets are specifically the default-jurisdiction bucket
resources selected by the `_default_` credential-policy resource ids. Capture
explicitly lists `default`, `eu`, and `fedramp` with the documented
`cf-r2-jurisdiction` header, fails closed on any unsupported/non-200 inventory,
and refuses either canonical bucket name in a nondefault inventory. Every
target-scoped bucket, lifecycle, managed-domain, and object read explicitly
selects `default`. The destructive adapter repeats the complete three-
jurisdiction inventory during its initial all-resource proof and immediately
before each bucket mutation, and sends the same explicit `default` header on
every target-scoped read or delete. An unrelated nondefault bucket remains
outside this deletion contract; a same-name nondefault bucket blocks the
ceremony.

All projection digests are SHA-256 over the adapter's shared normalized
canonical projection bytes, not over a raw provider envelope or ordinary JSON
output. The GET-only generator and destructive runtime import the same
projectors. The sealer validates those facts and recomputes the two credential-
policy digests; it never invents Worker, container, DNS, certificate, bucket,
or object state. A resource not provisioned remains explicitly
`expectedPresent:false`; it is never omitted.

Each target token policy must be one allow-only exact-bucket resource with only
permission group id `2efd5506f9c8494dacb1fa10a3e7d5b6` / name `Workers R2
Storage Bucket Item Write`; account and wildcard resource selectors are
refused. Every present custom domain must pin its generated Advanced
Certificate pack because detaching the domain does not remove that pack. A
certificate pack may be named only when it is type `advanced`, its exact host
set is the single corresponding staging hostname, every nested certificate has
that same exact host set, and its explicit projection hashes to
`certificatePackSha256`. When the custom domain is present, exactly one child
id must equal the domain's pinned `cert_id`. A domain-absent recovery target
keeps `workerDomainCertId:null` and may seal a still-present pending pack with
zero certificate children. An off-host child always refuses capture.

The manifest deliberately does not turn every negative preflight into a
caller-supplied assertion. Before Worker deletion the adapter itself requires
empty Worker Builds triggers/deploy hooks, a complete target-pinned stopped
build history with no queued/initializing/running execution, account-wide Email
Routing Worker actions, Worker-build Event Subscriptions, and classic Worker routes, in
addition to its service, queue, Tail, dispatch, cron, custom-domain, and
Durable Object dependency checks. Before R2
deletion it itself requires empty CORS, object-lock, event-notification, custom
domain, Sippy, and Data Catalog attachments and compares the exact managed
domain and lifecycle configuration. Do not add hand-authored fields to stand
in for those live readbacks.

The DNS logical resource is the union of three independently represented
components: the Worker custom domain, exact DNS-record set, and dedicated
certificate pack. After an interrupted attempt the fresh capture automatically
sets `workerDomainExpectedPresent:false`, `workerDomainId:null`, and
`workerDomainCertId:null` while retaining exact surviving records and/or the
full certificate-pack projection; `expectedPresent` equals that component
union. A pack already in `pending_deletion` remains a recoverable present
component. The runtime verifies its captured projection and resumes bounded
convergence without a second DELETE. A terminal `deleted` pack is absent from a
new capture.

Keep capture, seal, verification, protected-environment upload, and local
destruction inside the disposable subshell below. The sealed JSON reaches
GitHub only over standard input. The only retained shell value derived from it
is the non-secret SHA-256:

```bash
(
set -euo pipefail
umask 077
TEARDOWN_CANDIDATE_COMMIT='<40-hex-replay-source-commit>'
TEARDOWN_CF_ACCOUNT_ID='<32-hex-account-id>'
TEARDOWN_CF_ZONE_ID='<32-hex-zone-id>'
: "${STAGING_TEARDOWN_CAPTURE_CF_COMPUTE_READ_TOKEN_FILE:?mode-0600 compute-read credential file required}"
: "${STAGING_TEARDOWN_CAPTURE_CF_DNS_READ_TOKEN_FILE:?mode-0600 DNS-read credential file required}"
: "${STAGING_TEARDOWN_CAPTURE_CF_R2_READ_TOKEN_FILE:?mode-0600 R2-read credential file required}"
: "${STAGING_TEARDOWN_CAPTURE_CF_TOKEN_READ_TOKEN_FILE:?mode-0600 token-read credential file required}"
: "${STAGING_TEARDOWN_CAPTURE_CF_OBSERVATION_READ_TOKEN_FILE:?mode-0600 observation credential file required}"
: "${STAGING_TEARDOWN_CAPTURE_GITHUB_APP_READ_TOKEN_FILE:?mode-0600 GitHub App token file required}"
TEARDOWN_TARGET_DIR="$(mktemp -d "${TMPDIR:-/tmp}/site-behavior-staging-teardown.XXXXXX")"
TEARDOWN_TARGET_DIR="$(cd "$TEARDOWN_TARGET_DIR" && pwd -P)"
chmod 0700 "$TEARDOWN_TARGET_DIR"
cleanup_staging_teardown_target() {
  rm -rf -- "$TEARDOWN_TARGET_DIR"
  unset TEARDOWN_CANDIDATE_COMMIT TEARDOWN_CF_ACCOUNT_ID \
    TEARDOWN_CF_ZONE_ID TEARDOWN_TARGET_SHA256 TEARDOWN_TARGET_DIR \
    STAGING_TEARDOWN_CAPTURE_CF_COMPUTE_READ_TOKEN_FILE \
    STAGING_TEARDOWN_CAPTURE_CF_DNS_READ_TOKEN_FILE \
    STAGING_TEARDOWN_CAPTURE_CF_R2_READ_TOKEN_FILE \
    STAGING_TEARDOWN_CAPTURE_CF_TOKEN_READ_TOKEN_FILE \
    STAGING_TEARDOWN_CAPTURE_CF_OBSERVATION_READ_TOKEN_FILE \
    STAGING_TEARDOWN_CAPTURE_GITHUB_APP_READ_TOKEN_FILE
}
trap cleanup_staging_teardown_target EXIT

npm run --silent staging:teardown-targets -- \
  --capture \
  --candidate-commit "$TEARDOWN_CANDIDATE_COMMIT" \
  --account-id "$TEARDOWN_CF_ACCOUNT_ID" \
  --zone-id "$TEARDOWN_CF_ZONE_ID" \
  --private-dir "$TEARDOWN_TARGET_DIR/provider-responses" \
  --output "$TEARDOWN_TARGET_DIR/staging-teardown-targets.captured.json" \
  >/dev/null
test ! -e "$TEARDOWN_TARGET_DIR/provider-responses"

npm run --silent staging:teardown-targets -- \
  --seal \
  --candidate-commit "$TEARDOWN_CANDIDATE_COMMIT" \
  --account-id "$TEARDOWN_CF_ACCOUNT_ID" \
  --zone-id "$TEARDOWN_CF_ZONE_ID" \
  --input "$TEARDOWN_TARGET_DIR/staging-teardown-targets.captured.json" \
  --output "$TEARDOWN_TARGET_DIR/staging-teardown-targets.sealed.json" \
  >/dev/null

TEARDOWN_TARGET_SHA256="$(
  npm run --silent staging:teardown-targets -- \
    --verify \
    --candidate-commit "$TEARDOWN_CANDIDATE_COMMIT" \
    --account-id "$TEARDOWN_CF_ACCOUNT_ID" \
    --zone-id "$TEARDOWN_CF_ZONE_ID" \
    --input "$TEARDOWN_TARGET_DIR/staging-teardown-targets.sealed.json" \
  | jq -er 'if .ok == true and (.sha256 | test("^[0-9a-f]{64}$")) then .sha256 else error("target verification failed") end'
)"
test "$(shasum -a 256 \
  "$TEARDOWN_TARGET_DIR/staging-teardown-targets.sealed.json" \
  | awk '{print $1}')" = "$TEARDOWN_TARGET_SHA256"

gh secret set STAGING_TEARDOWN_TARGETS_JSON \
  --env release-evidence \
  < "$TEARDOWN_TARGET_DIR/staging-teardown-targets.sealed.json"
gh variable set STAGING_TEARDOWN_TARGETS_SHA256 \
  --env release-evidence \
  --body "$TEARDOWN_TARGET_SHA256"
)
```

The block sets `STAGING_TEARDOWN_TARGETS_JSON` from the sealed file and
`STAGING_TEARDOWN_TARGETS_SHA256` from only the verified `sha256` field. At
dispatch, the strict canonical bytes of the target secret must hash to that
protected variable before any provider client is created. The manifest commit
must equal trusted `GITHUB_SHA`, the workflow must be the protected `main` ref
on the canonical repository, and the protected account and zone values must
equal the manifest. Any state or identity drift aborts; no caller-authored
transcript or digest is accepted.

The raw provider directory is already absent before `captured.json` exists;
the `EXIT` trap removes the captured and sealed target files on every exit.
After the protected upload, revoke the five Cloudflare capture tokens and the
short-lived GitHub App installation token through their separately approved
control paths, then securely destroy every credential file. If immediate App-
token revocation is unavailable, prove its expiry before teardown approval.
Do not add token deletion, minting, or any other mutation to this GET-only
capture command.

The target JSON is an ephemeral protected input and is never copied into a safe
artifact. Only its non-secret `targetManifestSha256` survives in the canonical
receipt and sanitized provider manifest, and later in the digest-addressed
hosted archive. Retire `STAGING_TEARDOWN_TARGETS_JSON` after authoritative
completion, but retain that digest as the durable binding between the reviewed
target and teardown evidence.

`--template` and manual `--seal` remain available only for schema inspection or
an explicitly reviewed recovery. They are not the normal ceremony and do not
authorize guessing provider facts. A manual recovery still needs fresh
complete read evidence for every populated projection and an independent
review; use a new GET-only capture whenever the provider state is representable.

## Exact-image licensing

This gate is intentionally impossible while any exact-image package review is
unreviewed. After the canonical candidate inventory and every legal-review row
pass their own checks:

```bash
npm run ops:evidence:container-licensing -- \
  --inventory research/measurement-candidate/site-behavior-lab-container-package-inventory.json \
  --review-ledger CONTAINER_IMAGE_PACKAGE_REVIEWS.json \
  --captured-at <canonical-UTC-instant> \
  --repository-root <exact-repository-root> \
  --output research/ops-evidence/container-image-licensing.json
```

The producer does not accept image or package digests as arguments. It derives
the candidate and image identity from the inventory, hashes the exact canonical
inventory and review-ledger bytes, and re-runs complete-review validation.
Legal evidence references must be exact content-addressed `repo:` or canonical
HTTPS references. Repository references are reopened without symlinks, their
local bytes must match the declared SHA-256, and the same path must be a Git
blob with that digest at the exact candidate commit. An untracked, post-candidate,
or missing working-tree file cannot satisfy the gate. The receipt enumerates
the complete canonical legal-evidence set, including every candidate-resident
repository path, and exposes the set digest as a scalar validator binding.
`repositoryRoot` is
mandatory so evaluating another checkout can never fall back to the process
working directory.
