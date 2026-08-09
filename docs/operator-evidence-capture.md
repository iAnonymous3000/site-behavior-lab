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
`WAF_ANALYTICS_API_TOKEN` has **Account Analytics Read** with its Zone Resources
restricted to only that zone. Configure the non-secret repository variable
`CLOUDFLARE_ZONE_ID`. The workflow refuses a
missing or reused token, a non-GitHub-hosted runner, a candidate input different
from its trusted `github.sha`, or a live deployment different from that
candidate.

The adapter reads the zone `http_ratelimit` phase entrypoint, selects exactly one
enabled rule by the human-authored ref `scan-api-rate-limit`, validates its
exact route expression and ten-per-ten-second block policy, and then binds the
provider's immutable **rule API `id` and `version`**. The ref is only the
selector; it is not the `ruleId` stored in the receipt or Security Events. The
adapter also refuses an alternate counting expression, origin-only counting,
or complexity-score counting; an empty Cloudflare `counting_expression` is
accepted because it canonically means the rule expression.

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
waits out that route's mitigation timeout plus a one-second isolation margin,
and then executes eleven POST requests. Each individual request has a
five-second abort timeout. Each first ten must avoid 429; for POST, each first
ten must return exactly 400 so the invalid probe cannot create a scan or
report. Each eleventh must be 429 with an integer `Retry-After` equal to the
policy.

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

The receipt producer is data-only: it never loads provider code, reads
credentials, or performs network operations, and it never deletes resources. Conduct the
reviewed staging-only teardown through the provider's approved operator path,
then export one sanitized transcript covering the before inventory, every
removal/revocation/disable/unregister action, and the after inventory. All
records use the fixed plan order and the same lowercase UUIDv4 session id.

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

Release use additionally requires the dedicated
`Staging Teardown Evidence` workflow and its authenticated hosted archive. The
workflow may upload only `receipt.json` and
`sanitized-provider-manifest.json`; private provider responses are destroyed
inside the hosted job. Its capture command currently refuses closed until a
reviewed provider adapter is committed and configured. The safe manifest must
also enumerate the exact ordered SHA-256 closure of the capture workflow,
capture CLI, semantic/provider library, shared canonical serializer and digest
sources, package metadata, and TypeScript build configuration. Archive
validation recomputes that closure from the authenticated capture
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
