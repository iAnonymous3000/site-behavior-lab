# Go live: opening the public Shields scanner

> **Status: LIVE on r2 (2026-07-13).** The original public go-live completed on
> 2026-06-22. The full Containers scanner at `scan.sitebehavior.org` now returns
> public r2 reports behind Turnstile and the in-app atomic quota. The combined
> WAF rate-limit rule was verified on both admission routes on 2026-07-29;
> retain a fresh receipt for each release rather than treating that dated
> observation as permanent proof.

This runbook takes the full Node/Playwright scanner (the path that runs the
**Brave-list blocking simulation**, tried-vs-blocked) from operator-gated to a **public** front door
on [sitebehavior.org](https://sitebehavior.org), behind Cloudflare Turnstile and
rate limiting.

It assumes the scanner is already deployed on Cloudflare Containers per
[deploy-cloudflare-containers.md](deploy-cloudflare-containers.md). The Containers
front Worker (`cloudflare/container-worker.ts`) is the enforcement point: it
applies the access-token / Turnstile / atomic rate-limit gate, using primitives
shared with the Browser Run worker via
[`lib/edge-scan-gate.ts`](../lib/edge-scan-gate.ts),
**before** any request reaches the container's real Chromium.

> **Why this needs care.** Each public scan launches a real browser against a
> caller-chosen URL: it costs container compute/egress and is an abuse magnet.
> The connect-time DNS proxy in the Node scanner is the SSRF backstop (unlike
> Browser Run, the container pins DNS at connect time, so opening it does **not**
> require the DNS-rebinding risk flag). Turnstile + the atomic Durable Object
> quota + a Cloudflare WAF rule are the cost/abuse controls. The minute and day
> checks are charged together in one SQLite transaction; the WAF is a coarse
> outer ceiling.

## Gating model

Before parsing a scan body, looking up recovery credentials, or contacting
Siteverify, the Worker charges a separate admission-attempt budget in the
existing singleton Durable Object. `POST /api/scan` and
`GET /api/scan/admission` share a rolling ten-second allowance of ten attempts
per client and 100 globally. Invalid requests count; changing route or
credential does not reset the budget. Refusals return `429` and a remaining
`Retry-After`; unavailable storage returns `503` before that work begins.
OPTIONS and job polling retain their existing treatment. This budget does not
consume scan tokens or change the number of browser runs a scan costs.

Only Cloudflare's client-IP header selects an attempt identity, which is hashed
before storage. At most 100 admitted-attempt rows remain; expired rows are
removed on the next charge, and rejected identities create no rows. This adds
SQLite operations to the existing Durable Object, with no new service or
container. It is not a zero-cost claim or a bound on requests arriving at the
Worker itself. WAF remains the outer abuse filter, and its provider evidence
must still be qualified separately; the atomic limit does not turn a failed
WAF capture into a passing receipt.

The front Worker chooses one of three postures from its config:

| Posture | Config | Behavior |
|---|---|---|
| **Gated** (default) | `SCAN_ACCESS_TOKEN` secret set | Only callers with the token can scan. |
| **Public** | no token + `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` + `TURNSTILE_SECRET_KEY` | Anyone can scan; Turnstile **and** the atomic per-client quota are enforced. |
| **Refused** | no token + not opened | `/api/scan` returns `503`, an unconfigured scanner is never silently world-open. |
| **Refused (fail-closed)** | open, but no `TURNSTILE_SECRET_KEY` and no waiver | `/api/scan` returns `503`. The operator must set `SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK=1` to consciously waive human verification and rely on atomic quota + WAF controls alone. |

## Pre-flight

1. Confirm the gated scanner is healthy and reachable:

   Inject the access token from a secret manager, or enter it silently in a
   disposable subshell so it never reaches command arguments or shell history:

   ```bash
   (
   set -euo pipefail
   cleanup_scanner_smoke_token() {
     unset SMOKE_SCAN_ACCESS_TOKEN
   }
   trap cleanup_scanner_smoke_token EXIT
   printf 'Gated scanner access token: ' >&2
   IFS= read -r -s SMOKE_SCAN_ACCESS_TOKEN; printf '\n' >&2
   export SMOKE_SCAN_ACCESS_TOKEN
   SCAN_BASE_URL='https://<scanner-domain>' npm run test:smoke:scanner
   )
   ```

2. Confirm `GET /api/health` returns `ok: true` and advertises the Shields
   comparison capability.

## Durable-job ship gate (committed off)

The production config deliberately keeps `SITE_BEHAVIOR_LAB_DURABLE_JOBS=0`.
Do not flip it merely because the unit suite is green. Durable execution adds an
encrypted Durable Object queue and scheduled, fenced lease recovery; it requires
both edge and Node prerequisites plus two live failure canaries on a gated
staging deployment.

The committed production coordinator origin is
`SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL=https://scan.sitebehavior.org`,
but it is inert while the production gate remains off. The container also keeps
reports recoverable for the full 75-minute job window with
`SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS=4500000`. Do **not** install production
durable credentials as the first rollout step. The canaries below use separately
generated staging-only values and the staging config. For either environment, the
encryption key must be canonical unpadded base64url for exactly 32 random bytes,
and the internal coordinator token must be a different random value:

```bash
# Generate a canonical 32-byte encryption-key value. Paste it only into the
# environment-specific secret prompt in the ordered procedure below.
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'

# Generate a different value for that environment's private coordinator channel.
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
```

`SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY` is Worker-only and must never enter the
container environment. Only the separate internal token and non-secret
coordinator origin are forwarded. Node health may report `node-ready` after it
has R2, public-r2, internal-token, and coordinator readiness; only the front
Worker may upgrade that to `checks.durableJobs.readiness: "ready"` after it also
verifies the encryption key and Durable Object side.

### Required live replay canaries

Run both canaries against a temporary **access-token-gated staging deployment**,
not the open Turnstile production front door. A safe staging-only fault hook must
advertise this health extension:

```json
{
  "checks": {
    "durableJobs": {
      "requested": true,
      "enabled": true,
      "readiness": "ready",
      "coordinatorOrigin": "https://scan-staging.sitebehavior.org",
      "faultInjection": {
        "environment": "staging",
        "enabled": true,
        "modes": ["lease-expiry", "lost-resolve"],
        "modeHeaderName": "x-staging-fault-mode",
        "tokenHeaderName": "x-staging-fault-token",
        "minimumNoPollMs": 240000,
        "attemptEvidence": true,
        "completionBeforeStatusRequestEvidence": true,
        "wholeOriginAccessGate": true
      }
    }
  }
}
```

The repository's staging scaffold is
[`wrangler.container.staging.jsonc`](../wrangler.container.staging.jsonc). It is
fail-closed and deliberately separate from production:

- Worker `site-behavior-lab-scanner-staging` serves only the exact custom-domain
  route `https://scan-staging.sitebehavior.org`; `workers_dev`, version preview
  URLs, and per-route previews are all disabled. While the hook is enabled, the
  scan-access token gates the entire public origin—including health, reports,
  and assets—before any request can touch the singleton Durable Object;
  authenticated private coordinator callbacks remain separate.
- The staging container application has its own name and a one-instance ceiling.
  The source binding/class remain `SCANNER`/`ScannerContainer`, but Cloudflare
  keys that Durable Object namespace to the distinct staging Worker script, so
  its SQLite state is separate from production.
- The config selects the dedicated `site-behavior-lab-reports-staging` bucket,
  disables unauthenticated scans, and enables durable jobs plus the staging-only
  replay hook. Do not deploy it until every isolated resource and secret below
  exists.

Before the first Cloudflare mutation, pin the reviewed source revision, require
a completely clean worktree (including staged and untracked files), and verify
that the deployment wrapper can inject that revision. Do not create a bucket,
token, secret, or draft Worker if this gate fails:

```bash
set -euo pipefail
DURABLE_REPLAY_EXPECTED_SHA="$(git rev-parse HEAD)"
export DURABLE_REPLAY_EXPECTED_SHA
test -z "$(git status --porcelain --untracked-files=all)"
npm run cf:container:staging:verify
```

Immediately before provisioning, run a same-session collision preflight. It
must prove that the exact Worker returns Cloudflare's absent-script code 10007,
the app and bucket names are absent, and DNS has no A, AAAA, or CNAME answer.
Any network/API error other than that named absent-script result is a failed
preflight, not evidence of absence:

```bash
set -euo pipefail
STAGING_PREFLIGHT_DIR="$(mktemp -d)"
export STAGING_PREFLIGHT_DIR

if npx wrangler deployments list --name site-behavior-lab-scanner-staging \
  --json -c wrangler.container.staging.jsonc \
  > "$STAGING_PREFLIGHT_DIR/worker.json" 2> "$STAGING_PREFLIGHT_DIR/worker.err"; then
  echo "Refusing to adopt an existing staging Worker." >&2
  exit 1
fi
grep -q '10007' "$STAGING_PREFLIGHT_DIR/worker.err"

if npx wrangler r2 bucket info site-behavior-lab-reports-staging --json \
  -c wrangler.container.staging.jsonc \
  > "$STAGING_PREFLIGHT_DIR/bucket.json" 2> "$STAGING_PREFLIGHT_DIR/bucket.err"; then
  echo "Refusing to adopt an existing staging bucket." >&2
  exit 1
fi
grep -q '10006' "$STAGING_PREFLIGHT_DIR/bucket.err"

for record_type in A AAAA CNAME; do
  dns_answers="$(dig +short scan-staging.sitebehavior.org "$record_type")"
  test -z "$dns_answers"
done
```

The repository currently locks Wrangler 4.120.0. Do not treat
`wrangler containers list --json` as an account-wide absence proof: its
machine-readable help surface exposes `--per-page` but no page/cursor argument,
and cursor completion must be reverified whenever Wrangler changes. In the
Cloudflare Containers dashboard (or a demonstrably fully paginated API client),
search the complete account-wide application list and confirm that
`site-behavior-lab-scanner-staging-container` is absent. Capture that full-list
receipt; a page-one CLI result is not an absence proof.

Provision the bucket, immediately add a one-day whole-bucket lifecycle as an
interrupted-cleanup backstop, then set every required staging secret. Create a
dedicated R2 API token with object read/write access to only this bucket in the
Cloudflare dashboard; record its token ID (not its value) in the activation
receipt so that exact credential can be revoked later. The R2 access key and
secret must come from that token and must not reuse production credentials. The
internal, scan, and fault tokens must each be 32-4096
characters, distinct from their production counterparts, and distinct from one
another; generate the durable encryption key in the exact 32-byte base64url
format shown above. The account-scoped R2 endpoint is configuration rather than
an isolation boundary and may be the same endpoint used by production:

```bash
npx wrangler r2 bucket create site-behavior-lab-reports-staging \
  -c wrangler.container.staging.jsonc
npx wrangler r2 bucket lifecycle add site-behavior-lab-reports-staging \
  durable-replay-staging-cleanup --expire-days 1 --abort-multipart-days 1 \
  --force -c wrangler.container.staging.jsonc
npx wrangler r2 bucket lifecycle list site-behavior-lab-reports-staging \
  -c wrangler.container.staging.jsonc

npx wrangler secret put SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN \
  -c wrangler.container.staging.jsonc
npx wrangler secret put SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY \
  -c wrangler.container.staging.jsonc
npx wrangler secret put SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN \
  -c wrangler.container.staging.jsonc
npx wrangler secret put SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN \
  -c wrangler.container.staging.jsonc
npx wrangler secret put SITE_BEHAVIOR_LAB_R2_ENDPOINT \
  -c wrangler.container.staging.jsonc
npx wrangler secret put SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID \
  -c wrangler.container.staging.jsonc
npx wrangler secret put SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY \
  -c wrangler.container.staging.jsonc

STAGING_SECRET_LIST="$(mktemp)"
npx wrangler secret list --format json -c wrangler.container.staging.jsonc \
  > "$STAGING_SECRET_LIST"
jq -e \
  '[.[].name] | sort == [
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN",
    "SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY",
    "SITE_BEHAVIOR_LAB_DURABLE_REPLAY_FAULT_TOKEN",
    "SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID",
    "SITE_BEHAVIOR_LAB_R2_ENDPOINT",
    "SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY",
    "SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN"
  ]' "$STAGING_SECRET_LIST" > /dev/null
```

`wrangler.container.staging.jsonc` declares all seven names under
`secrets.required` for tooling and local warnings. The explicit name-only
remote readback above is the deployment gate: it catches a partial secret-put
sequence without exposing values. Verify the
lifecycle readback covers the whole bucket, expires objects after one day, and
aborts incomplete multipart uploads after one day before submitting a scan.

The staging config commits the exact coordinator origin
`https://scan-staging.sitebehavior.org`; there is no first-deploy placeholder to
patch. Verify provenance injection before the real deployment:

```bash
test "$(git rev-parse HEAD)" = "$DURABLE_REPLAY_EXPECTED_SHA"
test -z "$(git status --porcelain --untracked-files=all)"
npm run cf:container:staging:verify
npm run cf:container:staging:deploy
```

Wait until authenticated staging health reports that exact 40-character SHA in
`deployment`, with `status: "ok"`, no warnings, ready durable jobs, the exact
staging coordinator origin, and the fault-injection block above. The canary also
requires `DURABLE_REPLAY_EXPECTED_SHA` and refuses stale staging code. After the
custom domain becomes active, record the ID and exact hostname set of any
dedicated Advanced Certificate pack created only for this staging hostname; the
teardown must use that ID, never a shared certificate.

The canary reads the header names and minimum timing from authenticated health;
the committed hook currently advertises the values shown above. The general
rule for any separate staging configuration is
`SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL=https://<gated-staging-scanner>`
so Node callbacks return to that exact staging origin rather than the committed
production origin. The committed scaffold resolves that template to
`https://scan-staging.sitebehavior.org`. Configure a
staging-only key and internal token that are distinct from each other and from
every production secret. Do not reuse the
production Durable Object namespace, internal token, encryption key, scan-access
token, R2 bucket, or R2 credentials for fault-injection testing.

The production Worker intentionally advertises no fault hook. The script has no
production bypass: it requires both the health response's exact
`faultInjection.environment: "staging"` attestation and an independent operator
staging confirmation, in addition to the selected mode, valid header names, a
minimum lease/replay wait, fully ready durable jobs, and gated access. It also
unconditionally refuses the canonical production hostname as defense in depth.
If no safe staging hook exists, the canary fails as a prerequisite and the
production flag remains off.

### Choose the replay parent BEFORE deploying staging

The replay receipts are named for the deployed commit, and the binding requires
the durable-flip commit to be that commit's **direct first child**
(`git rev-parse <toCommit>^` must equal the replay deployment commit). `main`
allows only squash and rebase merges, so a commit that already has a child can
never carry the transition: its one slot is spent, and the receipts captured
against it are permanently ineligible no matter how sound the canary was.

That is not hypothetical. The receipts archived by PR #98 name `78defca0`, and
`0cf9e1c` landed as its child before any flip commit existed. They remain valid
operational proof that durable replay works, and they can never serve the
release transition.

So run the preflight first, against the exact commit you intend to deploy, and
freeze that commit:

```bash
npm run durable:replay-parent-preflight -- <commit-ish>
```

It refuses a spent parent, and on success prints the flip commit's required
shape, the resulting config digest, and the two receipt paths. Nothing else may
merge between that parent and the flip commit.

For the lease-expiry canary, arm the staging hook so the first claimed worker is
abandoned before resolution. Set `DURABLE_REPLAY_NO_POLL_MS` at or above the
deployment-advertised lease-expiry plus scheduled-replay margin:

Inject the two staging credentials from a secret manager, or enter them
silently once inside this disposable subshell. The `EXIT` trap unsets both on
success, refusal, or interruption. The block runs both required modes against
the same already-exported `DURABLE_REPLAY_EXPECTED_SHA` without placing either
credential in an argument, inline assignment, or shell history:

```bash
(
set -euo pipefail
: "${DURABLE_REPLAY_EXPECTED_SHA:?export the preflight-approved parent SHA first}"
[[ "$DURABLE_REPLAY_EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "DURABLE_REPLAY_EXPECTED_SHA must be the full lowercase preflight-approved parent SHA." >&2
  exit 1
}
cleanup_durable_replay_credentials() {
  unset DURABLE_REPLAY_ACCESS_TOKEN DURABLE_REPLAY_FAULT_TOKEN
}
trap cleanup_durable_replay_credentials EXIT

printf 'Gated staging scanner access token: ' >&2
IFS= read -r -s DURABLE_REPLAY_ACCESS_TOKEN; printf '\n' >&2
printf 'Staging replay fault token: ' >&2
IFS= read -r -s DURABLE_REPLAY_FAULT_TOKEN; printf '\n' >&2
export DURABLE_REPLAY_ACCESS_TOKEN DURABLE_REPLAY_FAULT_TOKEN

DURABLE_REPLAY_RECEIPT_DIR=research/ops-receipts/durable-replay
mkdir -p "$DURABLE_REPLAY_RECEIPT_DIR"
LEASE_EXPIRY_RECEIPT="$DURABLE_REPLAY_RECEIPT_DIR/${DURABLE_REPLAY_EXPECTED_SHA}-lease-expiry.json"
LOST_RESOLVE_RECEIPT="$DURABLE_REPLAY_RECEIPT_DIR/${DURABLE_REPLAY_EXPECTED_SHA}-lost-resolve.json"
test ! -e "$LEASE_EXPIRY_RECEIPT"
test ! -e "$LOST_RESOLVE_RECEIPT"

run_durable_replay() {
  local replay_mode="$1"
  local receipt_path="$2"
  DURABLE_REPLAY_BASE_URL='https://<gated-staging-scanner>' \
  DURABLE_REPLAY_TARGET_URL=https://example.com/ \
  DURABLE_REPLAY_FAULT_MODE="$replay_mode" \
  DURABLE_REPLAY_NO_POLL_MS=600000 \
  DURABLE_REPLAY_EXPECTED_SHA="$DURABLE_REPLAY_EXPECTED_SHA" \
  DURABLE_REPLAY_ORIGIN_LABEL=durable-replay-staging \
  DURABLE_REPLAY_RECEIPT_PATH="$receipt_path" \
  DURABLE_REPLAY_CONFIRM=I_ACKNOWLEDGE_THIS_SUBMITS_A_LIVE_SCAN \
  DURABLE_REPLAY_STAGING_CONFIRM=I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT \
  npm run test:smoke:durable-job-replay
}

run_durable_replay lease-expiry "$LEASE_EXPIRY_RECEIPT"
run_durable_replay lost-resolve "$LOST_RESOLVE_RECEIPT"

node scripts/validate-durable-replay-receipts.mjs \
  "$DURABLE_REPLAY_EXPECTED_SHA" \
  "$LEASE_EXPIRY_RECEIPT" \
  "$LOST_RESOLVE_RECEIPT"
)
```

For `lost-resolve`, the hook drops every successful callback
from the exact first-generation owner after the report is committed, so a retry
cannot bypass scheduled reconciliation. The script deliberately sends no
status, report, or health request during the wait. Its first post-window status
request must already return terminal success; it never polls a nonterminal row.
That response must also set `durable.finishedBeforeStatusRequest: true`, derived
from an ingress timestamp sampled before authentication or any rate-limit/status
Durable Object RPC, so the status request itself cannot earn the receipt.
It then requires exact triggered fault evidence, attempt metadata only from the
staging `durable` evidence envelope, and R2 readback under the same
admission-minted `reportId`. Lease expiry must show exactly two fenced claims
(generation one is abandoned before Node activation); lost resolve must show
exactly one fenced execution claim reconciled to success.

Each successful canary exclusively creates one mode-`0600` JSON receipt and
refuses an existing path rather than overwriting evidence. The receipt contains
the exact mode/build, a bounded operator origin label plus SHA-256 of the
staging origin, pre/post health identities and digests, timestamps, the job and
report ids, attempt count, pre-status completion fact, and exact evidence
references. It contains neither staging credentials nor the scanned target URL.
Before teardown or any production secret/change, the same guarded block above
requires both receipts to validate as one ordered pair on the exact reviewed
SHA. A validation refusal exits the subshell, clears both credentials, and
blocks teardown.

The validator requires exactly one `lease-expiry` receipt followed by exactly
one `lost-resolve` receipt, distinct job/report ids, the same full deployment
SHA, the same labeled origin digest, and the same exact staging health identity.
Preserve its receipt-set digest with the two receipt files. Re-running one mode
after a staging redeploy requires re-running both modes into new append-only
paths; never combine receipts across builds.

Before changing the production flag to `1`, record evidence that:

- the committed production flag is still `0` while both staging tests run;
- staging health `deployment` exactly matches the reviewed commit supplied as
  `DURABLE_REPLAY_EXPECTED_SHA`;
- staging health is `ready` at both Node and edge layers, with distinct secrets,
  and its coordinator URL resolves to that exact staging origin;
- the lease-expiry canary succeeds under the same `reportId` after a true no-poll
  window and reports exactly two fenced attempts;
- the lost-resolve canary reconciles the committed report under the same
  `reportId` with exactly one fenced execution claim;
- the fault-enabled staging deployment and every isolated resource/credential
  below are deleted, and the canonical production health response still omits
  `faultInjection`; and
- the privacy disclosure and 75-minute report-survival setting match the shipped
  behavior.

### Tear down complete or partial staging through the hosted adapter

Any failure after the first staging mutation—bucket/token creation, a secret
put, deployment, runner registration, or either canary—starts teardown
immediately. Keep the production durable-jobs flag at `0`; do not retry
provisioning on top of the partial attempt.

Do not use Wrangler or dashboard clicks as the release teardown. Wrangler's
container JSON path does not prove complete cursor pagination, manual R2
commands cannot bind a complete object-key allowlist to the same session, and
a custom-domain detach may legitimately cascade its DNS record. Those paths
cannot produce the canonical twelve-resource receipt.

Use the `cloudflare-github-exact-v1` hosted adapter described in
`docs/operator-evidence-capture.md`:

1. Validate the accepted replay receipts and obtain an authenticated staging
   ledger readback proving both replay jobs completed with no queued, running,
   publishing, retryable, or restart-scheduled work. Stop all staging
   scheduling and canary activity, wait through the 15-minute container sleep
   interval, and require the provider instance inventory to show zero live
   placements. Stop the exact staging self-hosted runner service and prove
   GitHub reports `status=offline` and `busy=false`; online-idle is not a drain.
2. Run the GET-only `npm run staging:teardown-targets -- --capture` ceremony
   from `docs/operator-evidence-capture.md` for the exact protected-main replay
   source commit. Use its six separately scoped read credentials and mode-0700
   private directory; require that the indexed raw response directory is
   destroyed before the mode-0600 captured manifest exists, then seal and
   verify without hand editing.
3. For a partial attempt, leave every never-created or wholly removed logical
   resource explicitly `expectedPresent:false`; do not omit it. DNS is a
   compound logical resource: independently retain any exact surviving custom
   domain, DNS-record set, or dedicated certificate pack, and set its aggregate
   `expectedPresent` to that component union. A surviving container retains its
   independently pinned application and Durable Object namespace identity even
   after its Worker is gone. At least one resource must still be observed
   present and removed in the successful ceremony. An all-absent rerun is
   intentionally not teardown evidence.
4. Set the sealed file and its canonical SHA in the protected
   `release-evidence` environment, obtain the required reviewer approval, and
   dispatch `Staging Teardown Evidence` at that exact `main` SHA.
5. Archive only `receipt.json` and
   `sanitized-provider-manifest.json`. Never download, copy, or publish the
   private provider-response directory; the job must destroy it before
   creating the safe output.
6. While production is still on the reviewed flag-`0` revision, dispatch the
   governed health lane:

   ```bash
   gh workflow run production-health.yml --ref main
   ```

   Record the exact successful run id and attempt from GitHub Actions, plus the
   immutable artifact id for
   `site-behavior-production-health-evidence-<run-id>-<attempt>`, in the
   operator's private ceremony log.
7. Read back that exact artifact and require `production-health.json` to name
   the committed production SHA and to omit
   `checks.durableJobs.faultInjection`. Do not create `F` until this separate
   production check is green.

The target file always covers both staging halves and every exact fact required
by the canonical target contract in `docs/operator-evidence-capture.md`:
privacy-safe Worker code/settings/version/deployment/secret projections, the
complete stopped Worker Builds history, the complete same-script Durable Object namespace set, full stable custom-domain,
certificate, and DNS-record state, Worker-mapped container image/application/
deployment/rollout/inactive-instance projections with `jobs: false` and zero
live placement,
full R2 bucket/object metadata and the exact
one-day configuration, both staging-only credential policies, the replay fault
hook, and only the exact offline staging runner registration. Do not reduce
that contract to display names, id/content tuples, or object-key sets.
If custom-domain deletion cascades a pinned DNS record, the adapter records
that exact absence and does not issue a blind second DELETE. If the record
remains, its complete sealed stable-state projection must still match before
deletion.

Worker deletion is non-force. The adapter rebinds the immutable Worker id to
the exact script name, then requires the exact Worker attachment graph to show
no custom domain, queue consumer, Worker service binding, dispatch outbound,
Tail Worker consumer, or external Durable Object reference. It independently
requires no incoming service or Pages binding, no Tail-Worker producer, no
account custom domain whose service names the Worker, no classic route, cron
schedule, Email Routing action, Worker Builds trigger/deploy hook, or
Worker-build Event Subscription, and workers.dev/preview ingress disabled. It
refuses any unreviewed provider-resource binding; it then
proves the exact own Durable Object namespace absent. Advanced-certificate deletion rechecks the
custom-domain certificate linkage and converges only on 404 or the exact same
pack in terminal `deleted` status. Explicit container deletion converges only
when the exact application id returns 404.

Worker plus its own namespace is the only atomic compound expectation. The
Cloudflare API exposes no direct namespace DELETE: if the script is absent but
its namespace survives, the hosted adapter fails closed and cannot finish that
partial state. Do not invent an endpoint or let the ceremony deploy code. Re-cut
and obtain separate approval for a manual deleted-export tombstone migration,
then generate a new exact teardown target. DNS records/certificates and
containers do not share this limitation and are independently resumable.

The workflow refuses identity or policy drift, an unexpected R2 object, an
online, busy, or extra-labelled runner, a shared certificate, an unreviewed account or
zone, incomplete/repeated pagination, request-budget exhaustion, or any
surviving resource. If a provider failure occurs after a mutation, do not
resume the same run or broaden a token. Re-inventory, generate a new exact
target file for only the remaining surface, and run the protected ceremony
again. If nothing remains and the first run produced no valid receipt, the
release has no canonical teardown evidence and must be re-cut; an all-absent
transcript cannot be promoted into proof after the fact.

The canonical teardown receipt proves only that its same-session after
inventory found all twelve logical resources absent. The separately dispatched
authenticated Production Health run is an additional operational prerequisite:
it must report the committed production SHA healthy with
`checks.durableJobs.faultInjection` absent before `F`, but its run and artifact
identities are not fields in the teardown receipt. Deletion of the exact
fault-enabled Worker is the reviewed hook-off transition; do not create an ad
hoc dirty hook-disabled deployment.

The successful teardown artifact also starts a mandatory evidence-custody
handoff. Record its exact run id, attempt, workflow head SHA, immutable artifact
id, and artifact digest now, but do **not** merge a receipt carrier while `P` is
waiting for its flag-only child `F` or while `F` is frozen for the durable soak.
After that transition and soak complete, but before selecting candidate `C`,
follow **Preserve the hosted receipt and archive it after `C`** in
`docs/operator-evidence-capture.md`: authenticate and digest-verify the exact
safe artifact, copy its `receipt.json` bytes unchanged to
`research/ops-evidence/staging-teardown.json`, verify the copied digest, and
commit that subject through normal review. Only after `C` is selected, dispatch
`archive-hosted-evidence.yml` with profile `staging-teardown` and exactly one
`provider-capture` source naming the original run and artifact. Merge only the
generated append-only archive proposal, and digest-enumerate every archive byte
in the measurement-candidate binding. The sanitized manifest stays inside the
safe artifact/archive; private provider responses never enter either.

Only after every item passes may a separate reviewed production change install
new production-only values for `SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY` and
`SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN` with
`-c wrangler.container.jsonc`, then set `SITE_BEHAVIOR_LAB_DURABLE_JOBS=1`.
Neither production secret may reuse a destroyed staging value or any scan,
Turnstile, synthetic-monitor, R2, or watch credential. The production deployment
must contain no fault-injection hook and must use the normal CI-gated promotion,
canary, soak, and rollback path. This runbook does not authorize that flip or a
deployment by itself.

The soak is quantified, not advisory: SEVEN days (168 hours) of hourly
production health with durable readiness `ready` is the declared target, and
twenty-four hours is the hard minimum ONLY when the window also contains a real
restart or redeploy proving recovery under the flag. During the soak, exercise
normal completion, cancellation, restart recovery, completed-report recovery,
and duplicate prevention at least once each. Below 24 hours, or a window
missing any one of those five behaviors, is a refusal and cannot be waived.
From 24 hours through anything shorter than 168 hours, the complete five-
behavior window is eligible only with the explicit candidate-bound deviation
approval below. The same durations apply to the separate sharding and watches
soaks below.

At or above 168 hours, the candidate binding must record
`targetDeviationApproval: null`. From 24 hours through anything shorter than
168 hours, readiness requires an explicit named-human approval bound to the
exact candidate commit, soak deployment, authenticated ledger digest, complete
window (including the restart instant), and the 24/168-hour policy. The
approval must postdate both the completed window and candidate selection.
Below 24 hours always fails and cannot be waived.

Run the four non-restart exercises once while protected `main` is still the
exact durable-enabled deployment commit:

```bash
gh workflow run durable-soak-exercises.yml \
  --ref main \
  -f deployment_commit=<exact-durable-enabled-40-sha>
```

The workflow refuses if `github.sha`, live health, or the committed
`wrangler.container.jsonc` identity differs from that deployment. It mints its
own request-bound admissions for two fixed synthetic targets and derives the
artifact directly from live responses: one job must return the same job/report
tuple for an exact admission replay, complete to one persisted report, and
recover that same report from terminal status; a distinct job must cancel and
remain cancelled on readback. There is no receipt/evidence input and no manual
substitute. Every completed or recovered report must carry the exact deployment
commit in its own provenance, and a second retained clean health response after
the cancellation readback proves that production did not converge to another
build during the exercise. The dedicated restart workflow remains the only
accepted proof of the fifth behavior.

At soak end, dispatch `durable-soak-monitor.yml` for the exact window and
restart artifact. The durable-soak attestation must bind its recomputed
`ledgerSha256` and exactly three
`github-actions-run:<id>:artifact-sha256:<digest>` references in this order:
monitor, restart, exercises. Archive that subject with the same three ordered
source roles through `archive-hosted-evidence.yml`. Candidate and release
verification reject an absent/extra role, an expired or unauthenticated
artifact, a source commit other than the durable deployment, an exercise
session outside the ledger window or Actions job, any changed deployment/config
or behavior identity, and any archive byte or Sigstore mismatch. Commit the
digest-addressed durable-soak archive through the append-only evidence carrier
after selecting candidate `C`. The soak attestation itself is candidate
resident; candidate verification requires its carrier archive to be
digest-enumerated and set-equal to the authenticated context inventory,
including the retained subject and every source byte. It also requires the
monitor, restart, and exercise workflow plus every invoked
producer/semantic-verifier source file to be byte-identical between the
authenticated source commit and candidate `C`.

The monitor still accepts the full 192-hour query ceiling. At that ceiling it
admits at most 193 deep runs, 200 attempts, and 607 logical GitHub REST calls.
Collection keeps workflow pagination serial, then captures attempt Jobs pages,
per-run artifact pages, and artifact ZIPs in three separately bounded phases.
Each phase permits at most 32 requests in flight; results are merged back in
source order, every response byte is retained under its exact path, and any
task failure aborts its whole phase before the output directory exists. An
artifact download may follow exactly one API-to-blob redirect. With a
60-second timeout per fetch, the maximum admitted schedule is 43 timeout slots;
the collector also enforces a 45-minute overall collection deadline. The
workflow has a 60-minute job limit, leaving 15 minutes for the clean-checkout
dependency install, schema compile, ledger derivation, and bounded artifact
upload. Do not raise any of the window, request, redirect, concurrency, or time
ceilings independently: the single repository-only App installation token is
minted only after bootstrap and the reviewed schedule intentionally stays
inside its one-hour lifetime.

Before the first artifact download, the monitor also adds every selected
artifact's authenticated `size_in_bytes` to the already-retained API JSON and
requires that lower bound to remain strictly below the 48 MiB aggregate cap.
It rechecks actual ZIP plus copied health bytes as each bounded download
finishes, and checks the final ledger, source manifest, and complete retained
set again before creating the output directory. An oversized provider set
therefore refuses before allocating its ZIP bodies rather than relying on a
late hosted-runner out-of-memory failure.

After candidate `C` exists, generate the non-passing approval scaffold from
the verified soak evidence:

```bash
npm run release:attestation-scaffold -- \
  --gate durable-soak \
  --target-deviation-approval \
  --candidate-commit <exact-40-character-candidate-C>
```

The command derives every identity and duration binding and leaves the approval
status, human name, time, and rationale as conspicuous `<required: ...>`
placeholders. It does not approve the deviation. A reviewer must inspect that
exact candidate and replace the placeholders deliberately; stale, unnamed,
missing, or drifted approvals fail both candidate verification and release
readiness.

### Post-durability container sharding

Do not combine this with durable activation. After production health reports
`checks.durableJobs.readiness: "ready"` and replay/normal traffic has completed a
separate soak, set `SITE_BEHAVIOR_LAB_CONTAINER_SHARDING=1` in a reviewed change.
The committed production shard count is 3 and must stay at or below the
container application's `max_instances`. Shard zero is the existing default
singleton; only shards one and two allocate named instances.

Verify health reports
`checks.durableJobs.containerSharding = { requested: true, enabled: true,
readiness: "ready", shardCount: 3 }`, then submit enough token-gated durable
scans to exercise every shard and confirm status plus cancellation through the
same public job capability. Roll back only the sharding flag to `0` if needed.
Existing jobs retain their admission-time route in authoritative DO SQLite;
new work returns to the singleton. Turning durable jobs off also forces all new
Phase-1 execution to the singleton while retained durable rows remain
status/cancellation-recoverable.

### Post-durability encrypted scheduled rescans

Do not combine watch activation with durable activation or sharding. First require
production `checks.durableJobs.readiness: "ready"`, both replay canaries, ordinary
traffic, and a separate soak. The committed
`SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=0` is the rollback baseline.

1. Use a separate exact-SHA staging deployment with ordinary scanner ingress
   open behind Turnstile and atomic quota. Do not set a scanner access token on
   that staging Worker. Use `wrangler.container.watch-staging.jsonc`, never the
   replay-fault or production config. Generate both a new independent 32-byte watch key and a
   separate 32-byte-or-longer watch-creation token, then install them only as
   Worker secrets. Do not reuse a durable-job key, coordinator/synthetic token,
   Turnstile secret, scan token, or R2 credential, and do not forward either
   value into Node:

   ```bash
   umask 077
   WATCH_KEY_FILE="$(mktemp)"
   openssl rand 32 | openssl base64 -A | tr '+/' '-_' | tr -d '=' > "$WATCH_KEY_FILE"
   npx wrangler secret put SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY \
     -c wrangler.container.watch-staging.jsonc < "$WATCH_KEY_FILE"
   WATCH_ACCESS_TOKEN_FILE="$(mktemp)"
   openssl rand -base64 48 | tr -d '\n' > "$WATCH_ACCESS_TOKEN_FILE"
   npx wrangler secret put SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_ACCESS_TOKEN \
     -c wrangler.container.watch-staging.jsonc < "$WATCH_ACCESS_TOKEN_FILE"
   rm -f "$WATCH_KEY_FILE"
   rm -f "$WATCH_ACCESS_TOKEN_FILE"
   unset WATCH_KEY_FILE
   unset WATCH_ACCESS_TOKEN_FILE
   ```

   Provision the config's staging-only container, Durable Object namespace, R2
   bucket/credential, DNS/certificate, Turnstile secret, durable key, and
   coordinator token. Require the remote secret list to contain exactly the
   config's `secrets.required` set and no general scan access token. Verify the
   build-pinned config with `npm run cf:container:watch-staging:verify`; only an
   authorized operator may then run `npm run cf:container:watch-staging:deploy`.

2. The dedicated staging config requests
   `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=1` only after durable readiness is
   already proven. Require exact scanner/Pages source provenance,
   no warnings, `authenticated: false`, `openAccess: true`, `turnstile: true`,
   `checks.encryptedWatches = { requested: true, enabled: true, readiness:
   "ready", creationAuthorization: "operator" }`, and
   `capabilities.scheduledRescans: false`. The false public capability is
   intentional: the browser never receives the staging second factor. Node
   health alone may report only `node-ready`; combined edge health is
   authoritative.
3. Obtain one fresh Turnstile token immediately before the canary and run
   `npm run test:smoke:encrypted-watches` with
   `ENCRYPTED_WATCH_SMOKE_WATCH_ACCESS_TOKEN`,
   `ENCRYPTED_WATCH_SMOKE_TURNSTILE_TOKEN`, the staging base URL, controlled
   query-free target, exact expected SHA, no-request duration, and these exact
   acknowledgements:

   ```text
   ENCRYPTED_WATCH_SMOKE_CONFIRM=I_ACKNOWLEDGE_THIS_CREATES_A_LIVE_SCHEDULED_RESCAN
   ENCRYPTED_WATCH_SMOKE_STAGING_CONFIRM=I_ACKNOWLEDGE_THIS_IS_AN_OPEN_TURNSTILE_STAGING_DEPLOYMENT
   ```

   The create request sends the endpoint token only in
   `x-site-behavior-lab-watch-access-token`, the browser-held management
   capability only in `x-site-behavior-lab-watch-capability`, and the Turnstile
   token only in the JSON body. Never print any of them or put them in a request
   path/query. Do not poll, health-check, or read status during the canary's blind
   window; the coordinator must schedule and admit the ordinary durable job.
4. Read capability-authenticated metadata, retrieve the normal r2 report, then
   delete the watch. Confirm no API response/log contains the plaintext target
   and that deletion prevents future watch claims. A job admitted before deletion
   may still finish normally.
5. Submit an ordinary Turnstile-backed scan without either watch header and
   confirm it remains open. Then send missing and wrong watch endpoint tokens
   with otherwise valid creation input and require `401` without a quota charge
   or Durable Object admission. Audit logs to confirm both watch credentials
   terminate at the edge.
6. Tear staging down and capture absence receipts. Only then prepare a separate
   reviewed production activation with a newly generated production-only watch
   encryption key. Do **not** install the staging watch access token in
   production, and never add the general scan access token merely to enable
   watches.
7. Before accepting production activation, require
   `checks.encryptedWatches.creationAuthorization: "public"` and
   `capabilities.scheduledRescans: true`, then create/delete one watch through
   the real browser UI with a fresh Turnstile solve and no watch-access header.
   This proves self-service creation, atomic quota, durable admission,
   capability management, and rollback behavior coexist.

Rollback the watch flag to `0` first. New creates and due decryption stop, but
capability-authenticated metadata reads/deletes must remain available. Keep the
current key installed until every retained watch has expired or been deleted.
For rotation, deploy a new current key and the old key as
`SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY`; new envelopes use the new key.
Retain the previous key for the maximum 30-day TTL (or delete every old-key
watch), then remove it. See [encrypted-watches.md](encrypted-watches.md).

## Open it to the public

1. **Create a Turnstile site** in the Cloudflare dashboard (Turnstile → Add site,
   pointed at `sitebehavior.org`). Note the **site key** (public) and **secret
   key**.

2. **Confirm the scanner Durable Object binding and SQLite migration** in
   [`wrangler.container.jsonc`](../wrangler.container.jsonc). The same singleton
   object that owns the container also owns the exact per-client quota ledger;
   no rate-limit KV namespace is required.

3. **Set the open-access vars** in `wrangler.container.jsonc` (uncomment
   `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` and the optional per-minute /
   per-day limits). Make sure **no** `SCAN_ACCESS_TOKEN` secret is set on this
   Worker, a token forces the gated posture.

4. **Set the Turnstile secret** so the gate verifies tokens:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY -c wrangler.container.jsonc
   ```

5. **Deploy the front Worker:**

   ```bash
   npm run cf:container:deploy
   ```

6. **Add a Cloudflare WAF rate-limiting rule** covering both public admission
   routes as a coarse outer cap. This route coverage is a release requirement
   when durable public scans are enabled:

   - throttle `POST /api/scan` per client IP to a ceiling above the in-app scan
     limit; and
   - throttle `GET /api/scan/admission` per client IP to a ceiling above its
     dedicated 30-per-minute client limit (for example, ten requests per ten
     seconds with a short block).

   The recovery endpoint also enforces an atomic 300-per-minute global ceiling
   and bounded SQLite cleanup, but that in-app control does not replace the WAF
   layer. Consider a managed challenge for known-bot ASNs. Do not enable the
   durable public route until the combined WAF rule is active and both routes
   have fresh receipts.

7. **Point the public site at the scanner.** Rebuild and deploy Cloudflare Pages
   with:

   - `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` = the scanner origin
   - `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY` = the Turnstile **site
     key** (the static UI renders the widget and sends its token; without it the
     scan button stays disabled with an explanation)

   Map a custom domain (`scan.sitebehavior.org`) to the Worker first and use
   that as the API base: the production config sets `workers_dev: false`, so
   the custom domain is the scanner's only ingress.

## Verify

1. `GET <scanner>/api/health` → `ok: true`, `openAccess: true`, `turnstile: true`.
2. `GET <scanner>/api/health/public-ingress` → `ok: true`, `status: "ready"`.
   This separate preflight proves that Siteverify recognizes the configured
   secret and that a non-consuming public-scope quota peek succeeds. It must
   also report `challengeSolved: false`, `scanSubmitted: false`,
   `quota.consumed: false`, and `monitorBypassUsed: false`; it is not a claim
   that a visitor completed a scan.
3. From sitebehavior.org, complete the Turnstile challenge and run a real scan;
   confirm a report renders with the live Shields (tried-vs-blocked) diff.
4. Confirm a request **without** a Turnstile token is rejected (`400`), and that
   exceeding the per-minute limit returns `429`.
5. Re-run the automated smoke test. An **open** origin that enforces Turnstile
   cannot be smoked unattended (Turnstile is built to block exactly that, and the
   script has no token to send), so point it at a deployment with an access token
   configured and pass `SMOKE_SCAN_ACCESS_TOKEN`, a matching token is checked
   before Turnstile and bypasses it:

   ```bash
   (
   set -euo pipefail
   cleanup_scanner_smoke_token() {
     unset SMOKE_SCAN_ACCESS_TOKEN
   }
   trap cleanup_scanner_smoke_token EXIT
   printf 'Gated scanner access token: ' >&2
   IFS= read -r -s SMOKE_SCAN_ACCESS_TOKEN; printf '\n' >&2
   export SMOKE_SCAN_ACCESS_TOKEN
   SCAN_BASE_URL='https://<scanner-origin>' npm run test:smoke:scanner
   )
   ```

   For the open public origin, step 3's manual Turnstile scan remains the
   end-to-end visitor check. The public-ingress preflight verifies the secret and
   non-consuming quota dependency without pretending to solve a CAPTCHA; step 4
   confirms the unattended (no-token) request is rejected.

### 2026-07-13 r2 rollout receipt

- The promoted build `003060abfba64ace4ede56453e979df851678f0a`
  enabled public r2 reports and consent verification under a temporary
  access-token lock. Pages serves the r2 schema alias, and an authenticated live
  r2 scan/save/read smoke passed on that exact image.
- Step-5 repeat evidence used two preselected GPC pairs. Both ran AB, both were
  eligible and intervention-verified, and all four primary arms passed. This is
  a one-order-only observed difference, not a replicated-effect claim.
- The repeat receipt ran on the immediately preceding feature build
  `13e4449444ad3eed12fcb3d2e9dd48d5e233a438`; no application logic changed in
  the enabling commit. The shadow secret was deleted and its build-scoped R2
  prefix was cleaned to zero objects after validation.
- Fresh GPC, Shields, and consent r2 reports were validated and added to the
  mixed-version corpus. The access-token lock was then removed last; final
  health proved open access, Turnstile enabled, r2 and consent enabled, shadow
  disabled, and no warnings. At that receipt, routing deliberately used one
  warm singleton. Bounded durable-execution sharding is now implemented behind
  its separate post-durability activation gate; the committed production flags
  still preserve the singleton. The Brave-list refresh rerun also succeeded.
- The hourly production synthetic is active. It performs a neutral scan, verifies
  its public r2 result, reads the exact persisted report back, and renders the
  report page. It does **not** delete the report and is not a delete canary.
  The monitor holds an ordered list of fixed candidate targets (iana.org, then
  w3.org), each server-allowlisted for the monitor credential: one target's
  outage or block falls through to the independent next candidate with a
  workflow warning, and the alert fires only when every candidate fails to
  scan, which indicates the scanner rather than a third party.
- On 2026-07-29 the combined WAF ceiling was verified active on both
  `POST /api/scan` and `GET /api/scan/admission` at ten requests per ten seconds
  per IP with a ten-second block. For each route, the eleventh bounded invalid
  request received `429` plus `Retry-After: 10`, Security Events matched
  `scan-api-rate-limit` to the exact method and path, and the ordinary
  application `400` returned after the block expired. A bounded seven-day
  Workers Observability dashboard query returned 80 visible `/api/health`
  matches spanning dashboard timestamps `2026-07-22 18:23` through
  `2026-07-29 11:25`; a separate `/reports/` query returned eight visible
  matches spanning `2026-07-22 13:04` through `2026-07-29 11:42`, all with
  report identifiers redacted, including `/reports/REDACTED`. These
  point-in-time receipts are not committed as canonical evidence, so the
  `waf-ceilings` and `log-retention` release gates both still report open;
  re-capture them for any release that needs those gates closed. The observed
  WAF behavior closes only the prerequisite for durable public admissions; the
  separate durable-execution rollout gates above still apply. The independently authenticated
  fixed-prefix R2 delete canary is now active and required: its direct smoke and
  Production Health run 30483261603 both passed the write/read/delete/absence
  contract. A platform-compatible independent egress backstop remains an
  external operational follow-up. `/api/health` proves R2 configuration, not
  these separately exercised controls.

## Sharing live-scan results

A freshly scanned report is stored in R2 and served by the scanner's own Node
app, so its permalink lives on the **scan API origin**, not the static Pages
site (which only pre-renders the committed corpus). With the public site pointed
at the scanner, the report's Share button and "Post on X" / "Copy post" actions
resolve to:

```
https://scan.sitebehavior.org/reports/<id>
```

That link renders the full report (request log, findings, Shields diff) for
anyone, backed by R2. Downloading the JSON/CSV still works as an offline,
re-uploadable copy.

Runtime report HTML/RSC, the printable rendering, and both generated social-card
routes are deliberately request-rendered: each request re-reads R2 and applies
the report's immutable expiry metadata, rather than entering Next's persistent
Full Route Cache. The front Worker recognizes the same canonical report ID as the
store and charges all four representations in one atomic Durable Object
namespace before it forwards to Node: 120 reads per client and 1,200 reads
globally per fixed minute. Both a per-client and a global refusal leave every
counter unchanged, and 429 or fail-closed 503 responses are `no-store`. Any
method other than `GET`/`HEAD` on `/reports/*` is answered 405 at the edge and
never forwarded: Next renders a page for a `POST` too, so a forwarded one would
have bought the full read and render with the quota never consulted. The JSON
endpoint retains its separate Node per-client limiter. The static Pages export
is intentionally different: it pre-renders only committed corpus reports, which
have repository-controlled retention and no runtime-store expiry.

For the link to **unfurl with its Open Graph / X card** (headline + key counts),
the scanner image must be built with the public origin baked in, because
`NEXT_PUBLIC_*` values are inlined by `next build`:

- The committed Dockerfile already defaults
  `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://scan.sitebehavior.org`, because
  Workers Builds does not pass custom Docker build arguments. Self-hosters on a
  different public origin must override that build argument in their own image
  build.

Without it, shared links still render the report; they just won't show a card
image.

## Roll back

Either set the `SCAN_ACCESS_TOKEN` secret again, or remove
`SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS` from `vars`, then
`npm run cf:container:deploy`. To take the live form off the public site, redeploy
Pages without `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE`; the static gallery and
the committed Shields corpus keep working unchanged.

## Deploy (CI-gated)

Production deploys track the **`production`** branch, never `main`. After all
five promotion gates (`supply-chain`, `app`, `smoke`, `docker`, and `attest`)
pass, CI fast-forwards `production` to the exact SHA it tested;
`.github/workflows/promote-production.yml` is an idempotent fallback for
ordinary push/user-dispatched runs. It may also retry when all five gates
passed but CI's direct promotion failed, after reading the completed run and
requiring each named job conclusion to be `success`. Both paths share one serialized promotion
group and the same safeguards: no force pushes, no out-of-order rewind, and a
hard failure when the tested SHA is no longer reachable from `main`. CI owns
the direct path because runs dispatched by repo-writing workflows with
`GITHUB_TOKEN` do not reliably cascade into a third `workflow_run`.

One-time dashboard setup (no API token needed):

1. Cloudflare Pages project **sitebehavior.org**: Settings > Builds &
   deployments > production branch = `production`; either disable
   non-production (preview) branch builds or protect every preview with
   Cloudflare Access. The reference deployment disables automatic previews and
   keeps existing previews Access-protected.
2. The scanner's **Workers Builds** (wrangler.container.jsonc project):
   Settings > Builds > branch = `production`; disable non-production branch
   builds.

Current reference state (2026-09-05): scanner non-production builds are disabled.
Pages automatic preview deployments are disabled; existing preview deployments
remain Access-protected. Enable build caching in both
projects. The Pages wrapper maps only Webpack/SWC compiler data into the
provider's cached `.next/cache` directory; it still regenerates the schema,
report manifest, corpus statistics, deployment receipt, and exported pages.

Require TLS 1.2 or newer on the `sitebehavior.org` zone, retaining TLS 1.3.
Verify the scanner hostname independently: Pages has its own TLS floor.
Use a dedicated scanner deployment token. The reference token grants Containers,
Cloudchamber, and Workers Scripts Edit plus Account Settings Read on this account,
and Memberships and User Details Read. It has no zone permissions; the current
deployment config does not manage routes or certificates.
It must not grant unrelated AI, database, queue, or R2 bucket administration.
Before retiring a formerly shared token, identify and migrate its other users.
The scanner's runtime R2 object credential is separate and stays bucket-scoped.

To hold production at a known-good revision during an incident, set the
repository Actions variable `SITE_BEHAVIOR_LAB_PROMOTION_PAUSED=1`. Clear it
and rerun CI on `main` to resume. Never move `production` by hand.

## Operate

- Watch container compute/egress cost. `max_instances` is only a ceiling while
  routing uses the singleton container. After durable jobs are proven, enable
  `SITE_BEHAVIOR_LAB_CONTAINER_SHARDING=1` separately; the configured shard count
  includes shard zero (the existing singleton), so it must never exceed the
  deployment's `max_instances`. Lower `sleepAfter` to save cost or raise it to
  cut cold starts.
- Alert on `/api/health` `status: degraded` (includes the ad-block engine load
  state used for Shields).
- Tune `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE` / `_PER_DAY` and the
  WAF rule together as real traffic arrives.
- Preserve separate receipts for controls the repository cannot infer from health:
  the WAF ceiling above the in-app quota, container-log retention plus one bounded
  operator query, continued successful readback of the required dedicated-prefix
  R2 delete canary, and the independent egress backstop (or an explicit, reviewed
  acceptance while the platform cannot provide one). The active hourly synthetic
  covers scan/write/read/render only.
