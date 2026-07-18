# Go live: opening the public Shields scanner

> **Status: LIVE on r2 (2026-07-13).** The original public go-live completed on
> 2026-06-22. The full Containers scanner at `scan.sitebehavior.org` now returns
> public r2 reports behind Turnstile and the in-app atomic quota. The WAF
> rate-limit rule still needs explicit ceiling verification above that quota.

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

The front Worker chooses one of three postures from its config:

| Posture | Config | Behavior |
|---|---|---|
| **Gated** (default) | `SCAN_ACCESS_TOKEN` secret set | Only callers with the token can scan. |
| **Public** | no token + `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` + `TURNSTILE_SECRET_KEY` | Anyone can scan; Turnstile **and** the atomic per-client quota are enforced. |
| **Refused** | no token + not opened | `/api/scan` returns `503`, an unconfigured scanner is never silently world-open. |
| **Refused (fail-closed)** | open, but no `TURNSTILE_SECRET_KEY` and no waiver | `/api/scan` returns `503`. The operator must set `SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK=1` to consciously waive human verification and rely on atomic quota + WAF controls alone. |

## Pre-flight

1. Confirm the gated scanner is healthy and reachable:

   ```bash
   SCAN_BASE_URL=https://<scanner-domain> \
   SMOKE_SCAN_ACCESS_TOKEN=<token> \
   npm run test:smoke:scanner
   ```

2. Confirm `GET /api/health` returns `ok: true` and advertises the Shields
   comparison capability.

## Durable-job ship gate (committed off)

The production config deliberately keeps `SITE_BEHAVIOR_LAB_DURABLE_JOBS=0`.
Do not flip it merely because the unit suite is green. Durable execution adds an
encrypted Durable Object queue and scheduled, fenced lease recovery; it requires
both edge and Node prerequisites plus two live failure canaries on a gated
staging deployment.

The committed non-secret coordinator origin is
`SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL=https://scan.sitebehavior.org`.
The container also keeps reports recoverable for the full 75-minute job window
with `SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS=4500000`. Configure these two
distinct Worker secrets interactively; never reuse the public scan-access token:

```bash
# Generate one value, then paste it into the first secret prompt. The output is
# canonical unpadded base64url for exactly 32 random bytes.
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
npx wrangler secret put SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY -c wrangler.container.jsonc

# Generate a different value for the private Node-to-Worker coordinator channel.
node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'
npx wrangler secret put SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN -c wrangler.container.jsonc
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
      "faultInjection": {
        "environment": "staging",
        "enabled": true,
        "modes": ["lease-expiry", "lost-resolve"],
        "modeHeaderName": "x-staging-fault-mode",
        "tokenHeaderName": "x-staging-fault-token",
        "minimumNoPollMs": 240000
      }
    }
  }
}
```

The example header names and timing are illustrative; the staging hook owns the
actual values. Use a separate staging Worker/configuration, and override
`SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL=https://<gated-staging-scanner>`
so Node callbacks return to that exact staging origin rather than the committed
production origin. Configure a staging-only key and internal token that are
distinct from each other and from every production secret. Do not reuse the
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

For the lease-expiry canary, arm the staging hook so the first claimed worker is
abandoned before resolution. Set `DURABLE_REPLAY_NO_POLL_MS` at or above the
deployment-advertised lease-expiry plus scheduled-replay margin:

```bash
DURABLE_REPLAY_BASE_URL=https://<gated-staging-scanner> \
DURABLE_REPLAY_ACCESS_TOKEN=<staging-access-token> \
DURABLE_REPLAY_TARGET_URL=https://example.com/ \
DURABLE_REPLAY_FAULT_TOKEN=<staging-fault-token> \
DURABLE_REPLAY_FAULT_MODE=lease-expiry \
DURABLE_REPLAY_NO_POLL_MS=<lease-plus-replay-margin-ms> \
DURABLE_REPLAY_CONFIRM=I_ACKNOWLEDGE_THIS_SUBMITS_A_LIVE_SCAN \
DURABLE_REPLAY_STAGING_CONFIRM=I_ACKNOWLEDGE_THIS_IS_A_GATED_STAGING_DEPLOYMENT \
npm run test:smoke:durable-job-replay
```

Then run the same command with `DURABLE_REPLAY_FAULT_MODE=lost-resolve`, arming
the hook to drop the first successful coordinator resolution after the report is
committed. The script deliberately sends no status, report, or health request
during the wait. Afterward it requires terminal success and R2 readback under the
same admission-minted `reportId`; when the status endpoint exposes attempt
metadata, lease expiry must show a second attempt while lost-resolve must show one
site visit reconciled to success.

Before changing the production flag to `1`, record evidence that:

- the committed production flag is still `0` while both staging tests run;
- staging health is `ready` at both Node and edge layers, with distinct secrets,
  and its coordinator URL resolves to that exact staging origin;
- the lease-expiry canary succeeds under the same `reportId` after a true no-poll
  window and, when exposed, reports two attempts;
- the lost-resolve canary reconciles the committed report under the same
  `reportId` without a repeated visit and, when exposed, reports one attempt;
- the staging-only fault hook is removed and health no longer advertises it; and
- the privacy disclosure and 75-minute report-survival setting match the shipped
  behavior.

Only after every item passes may a separate reviewed production change set
`SITE_BEHAVIOR_LAB_DURABLE_JOBS=1`. This runbook does not authorize that flip or
a deployment by itself.

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

6. **Add a Cloudflare WAF / rate-limiting rule** on the scanner route as a coarse
   outer cap. Throttle `POST /api/scan` per client IP to
   a ceiling above the in-app per-minute limit, and consider a managed challenge
   for known-bot ASNs.

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
2. From sitebehavior.org, complete the Turnstile challenge and run a real scan;
   confirm a report renders with the live Shields (tried-vs-blocked) diff.
3. Confirm a request **without** a Turnstile token is rejected (`400`), and that
   exceeding the per-minute limit returns `429`.
4. Re-run the automated smoke test. An **open** origin that enforces Turnstile
   cannot be smoked unattended (Turnstile is built to block exactly that, and the
   script has no token to send), so point it at a deployment with an access token
   configured and pass `SMOKE_SCAN_ACCESS_TOKEN`, a matching token is checked
   before Turnstile and bypasses it:

   ```bash
   SCAN_BASE_URL=https://<scanner-origin> \
   SMOKE_SCAN_ACCESS_TOKEN=<token> npm run test:smoke:scanner
   ```

   For the open public origin, step 2's manual Turnstile scan is the end-to-end
   check; step 3 already confirms the unattended (no-token) request is rejected.

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
  disabled, and no warnings. The deployment config permits at most three
  instances, but the current `getContainer(env.SCANNER)` routing deliberately
  uses one warm singleton; horizontal sharding is still pending. The Brave-list
  refresh rerun also succeeded.
- Container-observability retention/query verification, the WAF ceiling, and a
  scoped synthetic R2 write/read/delete monitor remain external operational
  follow-ups. `/api/health` proves R2 configuration, not remote reachability.

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

Production deploys track the **`production`** branch, never `main`. After both
test jobs pass, CI fast-forwards `production` to the exact SHA it tested;
`.github/workflows/promote-production.yml` is an idempotent fallback for
ordinary push/user-dispatched runs. Both paths share one serialized promotion
group and the same safeguards: no force pushes, no out-of-order rewind, and a
hard failure when the tested SHA is no longer reachable from `main`. CI owns
the direct path because runs dispatched by repo-writing workflows with
`GITHUB_TOKEN` do not reliably cascade into a third `workflow_run`.

One-time dashboard setup (no API token needed):

1. Cloudflare Pages project **sitebehavior.org**: Settings > Builds &
   deployments > production branch = `production`; disable non-production
   (preview) branch builds.
2. The scanner's **Workers Builds** (wrangler.container.jsonc project):
   Settings > Builds > branch = `production`; disable non-production branch
   builds.

To hold production at a known-good revision during an incident, set the
repository Actions variable `SITE_BEHAVIOR_LAB_PROMOTION_PAUSED=1`. Clear it
and rerun CI on `main` to resume. Never move `production` by hand.

## Operate

- Watch container compute/egress cost. `max_instances` is only a ceiling while
  routing uses the singleton container; lower `sleepAfter` to save cost or raise
  it to cut cold starts.
- Alert on `/api/health` `status: degraded` (includes the ad-block engine load
  state used for Shields).
- Tune `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE` / `_PER_DAY` and the
  WAF rule together as real traffic arrives.
