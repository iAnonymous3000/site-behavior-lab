# Deploying the Node Scanner on Cloudflare Containers (live Shields)

The Cloudflare-native way to run the full **Node/Playwright scanner**, and therefore
**live, on-demand Shields tried-vs-blocked** scanning, without leaving your Cloudflare
account. It runs the existing [Dockerfile](../Dockerfile) as a Cloudflare Container,
fronted by a Worker, with your existing Cloudflare Pages site as the UI/gallery front door.

> This replaces "parked pending paid compute." The only prerequisite is the **Workers Paid
> plan** ($5/mo + metered container compute). The scanner code, Dockerfile, Shields engine,
> and R2 report backend already exist; this is configuration.

## Does it fit? (verified against Cloudflare docs, 2026-06)

Chromium needs ~2 GB RAM, and the Playwright base image is ~2-3 GB, and **a container
image cannot exceed its instance's disk**. So the small instance types do **not** work:

| instance_type | RAM | disk (= max image size) | usable here? |
|---|---|---|---|
| `lite` | 256 MiB | 2 GB | no (image too big, no RAM) |
| `basic` | 1 GiB | 4 GB | no (RAM too low for Chromium) |
| **`standard-1`** | 4 GiB | 8 GB | minimum |
| **`standard-2`** | 6 GiB | 12 GB | **recommended** |
| `standard-3/4` | 8-12 GiB | 16-20 GB | for high concurrency |

## Architecture

```
visitor ─▶ Cloudflare Pages (sitebehavior.org)         ← UI, gallery, committed corpus
                 │  browser calls NEXT_PUBLIC_..._SCAN_API_BASE
                 ▼
        Worker (Container class)  scan.sitebehavior.org/*
                 ▼  forwards to port 3000
        ScannerContainer = the Dockerfile (Next.js + Playwright Chromium)
          /api/scan  /api/scans/:id  /api/reports/:id  /api/health
          per-scan connect-time SSRF proxy ─▶ public internet only
                 ▼
        Cloudflare R2  (durable report store, see "Report storage" below)
```

## 1. Enable Workers Paid

Containers require it. Workers & Pages → Plans → Workers Paid.

## 2. Add a container Worker

The front Worker just routes requests to a container instance running the image.

`cloudflare/container-worker.ts`:

```ts
import { Container, getContainer } from "@cloudflare/containers";

export class ScannerContainer extends Container {
  defaultPort = 3000;      // the Dockerfile serves Next on :3000
  sleepAfter = "15m";      // keep warm between scans; cold start re-launches Chromium
}

export default {
  async fetch(request: Request, env: { SCANNER: DurableObjectNamespace }): Promise<Response> {
    // The default singleton remains the Phase-1 route and durable coordinator.
    // The committed Worker alone may fan fenced Phase-2 execution out.
    return getContainer(env.SCANNER).fetch(request);
  }
};
```

> The committed `cloudflare/container-worker.ts` is fuller than this sketch: it
> also forwards the report-store, egress, async, CORS, and secret env vars into
> the container via the `ScannerContainer` `envVars`. Use the committed file.

`wrangler.container.jsonc` (named rather than defaulted; the retired Browser Run
worker's `wrangler.browser-run.jsonc` was deleted with its source on 2026-07-24):

```jsonc
{
  "name": "site-behavior-lab-scanner",
  "main": "cloudflare/container-worker.ts",
  "compatibility_date": "2026-06-19",
  "vars": {
    // Browser CORS allow-list, forwarded into the container by container-worker.ts.
    "SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN": "https://sitebehavior.org"
  },
  "containers": [
    {
      "class_name": "ScannerContainer",
      "image": "./Dockerfile",
      "instance_type": "standard-2",
      "max_instances": 3
    }
  ],
  "durable_objects": {
    "bindings": [{ "name": "SCANNER", "class_name": "ScannerContainer" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ScannerContainer"] }]
}
```

`max_instances` is a platform ceiling. With the committed flags off, the Worker
routes through one default `getContainer(env.SCANNER)` singleton so the
process-local queue remains coherent. After durable jobs are live and proven,
`SITE_BEHAVIOR_LAB_CONTAINER_SHARDING=1` plus an exact count from 2 to 3 fans out
only durable private activation, abort, and reconciliation requests. Shard zero
is the default singleton and only shards one/two are named instances, so a count
of 3 consumes exactly this configured ceiling. The authoritative job/status
state and the per-job persisted route remain in the default Durable Object.

Encrypted scheduled rescans are another independent post-durability gate. The
default Durable Object remains their authoritative encrypted store and scheduler;
each due watch is freshly prepared by Node, then routed as a normal durable job.
Keep `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=0` until durable execution is live and
proven. Public watch creation uses the same Turnstile and atomic quota gate as
an ordinary open scan, so the existing browser UI remains self-service. An
optional isolated watch-only second factor is reserved for staging/operator
canaries and hides the public creation capability while configured. It and the
two encryption keys are Worker-only and never part of `ScannerContainer.envVars`; see
[encrypted-watches.md](encrypted-watches.md).
The committed `wrangler.container.watch-staging.jsonc` describes the separate,
temporary open/Turnstile canary topology; it is not a production deployment and
must never share production R2, Durable Object, container, DNS, or credentials.

> **Verify these against current Cloudflare docs**, the `@cloudflare/containers` routing
> helper (`getContainer`), the Durable Object migration shape (`new_sqlite_classes`), and
> how container env/secrets are passed are the version-sensitive lines. The reliable way to
> get correct, current boilerplate is to scaffold once with
> `npm create cloudflare@latest -- --template=cloudflare/templates/containers-template`
> and copy this project's `class_name`/`image`/`instance_type` into it.

## 3. Report storage, use R2, not the container disk

Container disk is **ephemeral** (it does not survive instance recycling), so the
filesystem report store would lose share links. Use the existing R2 backend instead:

```bash
npm run cf:bucket:create   # creates the site-behavior-lab-reports R2 bucket
```

Set on the scanner (non-secret values can go in the `ScannerContainer` `envVars`;
secrets via `wrangler secret put -c wrangler.container.jsonc`):

```
SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2
SITE_BEHAVIOR_LAB_R2_BUCKET=site-behavior-lab-reports
SITE_BEHAVIOR_LAB_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID=<r2 token key id>   # secret
SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY=<r2 token secret> # secret
SITE_BEHAVIOR_LAB_R2_PREFIX=reports/
SITE_BEHAVIOR_LAB_SCANNER_EGRESS=cloudflare-containers
# The r2 egress region is auto-recorded only when the platform injects the full
# CLOUDFLARE_REGION/CLOUDFLARE_LOCATION/CLOUDFLARE_COUNTRY_A2 placement tuple;
# a partial tuple makes health fail. Set SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION
# only to override it with a value that truthfully names the egress location.
SITE_BEHAVIOR_LAB_ASYNC_SCANS=1                          # long scans don't hold the connection
SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=0                    # separate post-durability gate
# Worker secrets only; never forward into the container:
# SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY=<32-byte unpadded base64url>
# SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY=<optional prior key>
# SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_ACCESS_TOKEN=<optional staging/operator second factor>
SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX=1                    # asserted by health + deployed smoke
SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN=<strong secret>     # operator-gated launch (see §6)
```

### Migrating retained shares after a redaction revision

Do not deploy a stricter managed-report provenance gate before retained R2
shares have matching public bytes and sidecars. If the stricter reader is
already live, treat this as an incident: pause promotion and gate scanner writes
before running inventory. A successful new save may prune metadata-free legacy
objects, and an old writer left active during remediation can create a report
outside the preflight worklist.

1. Pause automatic production promotion by setting the repository Actions
   variable `SITE_BEHAVIOR_LAB_PROMOTION_PAUSED=1`. Do not advance
   `production` until the final dry run below is clean.
2. Gate new scans by setting a temporary, strong
   `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` secret on the scanner (or equivalently
   block `POST /api/scan` at the edge), then confirm `/api/health` reports
   `authenticated: true` and `openAccess: false`. Keep the gate in place for
   this entire procedure. Drain or cancel every scan accepted before the gate;
   a queued/running async scan can still write R2 after ingress is closed.
3. Determine the exact `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` used by the
   legacy writer. Its default was `7`. If that value changed while the retained
   legacy population was being written, stop and establish object-specific
   evidence instead of applying one guessed lifetime to every object.

With promotion and writers still gated, migrate the committed corpus first in
the same maintenance window. Review the first command's exact report/sidecar
counts before authorizing `--apply`; it performs no writes. After apply,
regenerate every derived artifact and require the managed-reader check to pass:

```bash
npm run reports:remediate
npm run reports:remediate -- --apply
npm run corpus:stats
npm run reports:manifest
npm run reports:remediate -- --check
git diff --check
```

The apply preserves filenames, embedded report/run/pair identities, and the
committed `createdAt` clock. A schema-r2 v3 report additionally requires its
exact digest-matching v3 sidecar, no-expiry clock, and reviewed producer
normalization; missing, mixed, or self-declared provenance blocks the entire
preflight before any report is written. Do not publish these static changes yet:
the retained R2 plane must pass the corresponding migration below before the
strict v4 code is deployed.

Record the versioned `transitionAudit` from the dry run and compare it with the
apply result. It separately counts page titles withheld, explicit-port fields
removed, and IP-literal fields rejected. These are v3-to-v4 policy-transition
counts, not additions to the frozen seven-field public privacy-counter
vocabulary. A final `--check` must report zero for all three transition counts.

The one-off operator Worker is never deployed: it runs through a remote
Wrangler development session bound to the production bucket. `GET /` is
read-only and returns aggregate counts only, including the same versioned
`transitionAudit`. `POST /apply` requires an ephemeral bearer token. Save the
dry-run, apply, and final dry-run JSON receipts and require the apply transition
counts to equal preflight and the final counts to be zero. Pass the historical
max age explicitly (the shown value is the legacy default):

```bash
TOKEN=$(openssl rand -hex 32)
npx wrangler dev --remote -c wrangler.r2-remediation.jsonc --port 8791 \
  --var "SITE_BEHAVIOR_LAB_R2_REMEDIATION_APPLY_TOKEN:$TOKEN" \
  --var "SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS:7" &
DEV_PID=$!

curl --fail-with-body http://127.0.0.1:8791/
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8791/apply
curl --fail-with-body http://127.0.0.1:8791/

kill "$DEV_PID"
unset TOKEN
```

For a metadata-free report with no sidecar, the planner derives `createdAt` from
the R2 object's original `uploaded` (the R2/HTTP Last-Modified clock) and
computes `expiresAt` using that historical max age. It never derives a clock
from the report payload or the report ID. Partial, malformed, or conflicting
retention fields, an absent/invalid upload clock, a future upload clock, or a
sidecar on a metadata-free report block apply as ambiguous. Already-expired
legacy shares are reported and skipped without parsing or rewriting, so their
lifetime cannot restart.

Apply preflights the complete `reports/` prefix, repeats a full inventory and
object-snapshot barrier before the first write, and runs a complete postflight.
Every required report PUT retains HTTP/storage metadata, is conditioned on its
preflight ETag, and for a legacy object attaches the exact derived retention
clock. The report is always written before the conditionally created/replaced
sidecar. Managed-reader and redaction fixed-point checks run after readback.
These checks detect a missed in-flight write; the write gate is what prevents a
new write in the remaining interval between the barrier and PUTs.

Keep the scan gate in place while the compatible revision passes CI. Then clear
`SITE_BEHAVIOR_LAB_PROMOTION_PAUSED` and rerun CI on `main`, allowing that exact
tested SHA to advance `production` and deploy through the normal path. After the
new live SHA and health are verified, run `GET /` once more and require
`issues: 0` and `rewrites: 0` (expired legacy objects may still be counted and
remain skipped). Only then remove the temporary scan token and deliberately
restore the intended public posture. There must be no ungated old-writer window
between remediation and rollout.

This is a coordinated cutover, not a claim that live R2 is already remediated.
The repository can prove the planner and local corpus path; only the operator
`GET`/`POST /apply`/`GET` receipts against the bound production bucket can prove
the live state. Do not roll back to a v3 writer after v4 objects exist. If the
new deployment fails, keep ingress gated and repair or redeploy a v4-compatible
SHA rather than reopening an old-writer window.

## 4. Deploy

```bash
npm run cf:container:deploy
```

The wrapper injects the exact Git SHA into the image, then builds the Dockerfile,
pushes the image to Cloudflare's registry, and deploys the Worker + container. Add
a custom domain/route (e.g. `scan.sitebehavior.org`) to the Worker.

### Building without local Docker (Cloudflare Workers Builds)

`wrangler deploy` builds the image locally and uploads it, which needs a working Docker
daemon and can stall when a slow or proxied uplink pushes the multi-GB image. To build the
image **on Cloudflare instead**, connect the repo under the scanner Worker's
**Settings → Build**: set the deploy command to `npm run cf:container:deploy`,
leave the build command empty, and trigger a build. Cloudflare builds and stores the image
server-side, so nothing is uploaded from your machine. Worker secrets set beforehand are
preserved across Workers Builds deploys. The deploy command must stay explicit: on
2026-07-11 a Workers Builds settings regression reset it to the default
(`npx wrangler versions upload`), which loaded the repo-root wrangler config, hit the
retired Browser Run worker's name, and failed the build. That config was named
`wrangler.browser-run.jsonc` rather than `wrangler.jsonc`, and has since been deleted
along with the worker; no root `wrangler.jsonc` exists either, so a defaulted command
fails with "no config file found" instead of silently targeting the wrong Worker. The production scanner always deploys through the wrapper, which defaults to
the repo-root `wrangler.container.jsonc`. Its bounded `--config <filename>` override
accepts only a regular `.jsonc` file directly in the repository root and exists for the
separate `wrangler.container.staging.jsonc` replay-canary deployment; the production
Workers Builds command must not select that override.
Workers Builds supplies `WORKERS_CI_COMMIT_SHA`; local deployments require a
clean worktree and then fall back to the exact local `HEAD`. The Dockerfile rejects an empty or placeholder SHA, and
`/api/health` exposes the deployed revision for rollout verification.

## 5. Point the existing Pages site at it

In the Cloudflare **Pages** project (sitebehavior.org) production env, set and redeploy:

```
NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE = https://scan.sitebehavior.org
```

No code change, the UI reads `/api/health` and lights up the **Shields** and GPC toggles.
The scanner's browser CORS allow-list is preconfigured to `https://sitebehavior.org` via
the `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` var in `wrangler.container.jsonc` (the front Worker
forwards it into the container); edit that var if your Pages origin differs, or set it to
`*` for an open scanner. For an open scanner also add `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS=1`
to the Pages build; for Turnstile add `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY=<site-key>`.

## 6. Security: the SSRF backstop is weaker here, gate accordingly

The Node scanner's safety centers on the in-app **connect-time proxy**, which resolves,
validates, and pins each public destination IP. Cloudflare Containers now offers
[`enableInternet = false` and outbound interception](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/),
but the scanner proxy deliberately opens raw TCP connections to those pinned public IPs.
Turning off container internet access would block those connections; passing arbitrary
targets through a catch-all Worker fetch could perform a second DNS resolution and defeat
the pin. Do not enable that switch until the proxy architecture has a deployed test proving
both arbitrary public HTTP(S) scans and connect-time IP pinning still work. The current
deployment therefore relies on the in-app proxy plus Chromium's non-proxied-WebRTC block,
not a platform egress firewall. Start **operator-gated**
(keep `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` set, you run the scans): it unlocks live
Shields for building the corpus with no open-abuse surface. Open `POST /api/scan` to the
public only behind **Turnstile + a WAF rate rule**, and only after accepting that the
egress backstop is the in-app proxy alone. That open posture is what sitebehavior.org has
run in production since 2026-06-22; the switch sequence is
[go-live-public-scanner.md](go-live-public-scanner.md).

## 7. Verify

Run the automated production smoke test against the deployed scanner. It checks health
(live Shields advertised, ad-block engine active, Chromium sandbox enabled, durable
storage), runs a real scan and confirms it is stored screenshot-stripped, runs a live
Shields comparison, and confirms a
link-local SSRF target (`169.254.169.254`) is refused. It tolerates async scan mode (the
container returns `202` + a job id to poll):

```bash
SCAN_BASE_URL=https://scan.sitebehavior.org \
  SMOKE_SCAN_ACCESS_TOKEN=<the scan token> \
  SMOKE_EXPECTED_STORAGE=r2 \
  npm run test:smoke:scanner
```

R2 is the smoke default. A self-host intentionally using a filesystem store must
set `SMOKE_EXPECTED_STORAGE=filesystem`; that checks the configured backend but
cannot prove the host volume survives replacement.

The default Shields targets are an ordered candidate list of independently
hosted sites (`https://www.iana.org/`, then `https://www.w3.org/`): a
sitebehavior.org outage cannot block promotion of its own repair, and no single
third party's outage or bot wall can block every promotion either. A later
candidate runs only after an earlier candidate's scan failed; if every
candidate fails to scan, the smoke stays red (independent targets all failing
indicates scanner-side breakage). Point `SMOKE_SHIELDS_URL` (space-separated
list) at a tracker-heavy site to also eyeball non-zero engine-blocked and
baseline filter-match counts. A quick manual check of the same essentials:

```bash
curl -s https://scan.sitebehavior.org/api/health | jq '{capabilities, chromiumSandbox: .checks.chromiumSandbox}'
# expect chromiumSandbox: "enabled" plus singleScan/Shields/savedReports capabilities
```

### Production synthetic (active)

Every delivered production-health run calls the distinct public
`/api/health/public-ingress` preflight first. The Worker submits a deliberately
invalid response token directly to the exact Cloudflare Siteverify origin and
requires the valid-secret `invalid-input-response` result, then performs a
non-consuming `public`-scope peek against the Durable Object quota ledger. The
response explicitly records that no CAPTCHA was solved, no visitor scan was
submitted, no quota was consumed, and the monitor bypass was not used. This is
stronger than configuration-only health, but it is not an end-to-end visitor
scan; keep the manual browser challenge check in the go-live runbook.

The reference deployment has this lane active. For a fresh deployment or a
credential rotation, configure one new random value in both control planes only
after the commit containing the lane is live on the `production` branch. The
Cloudflare secret stays in the front Worker and bypasses Turnstile only for the
monitor's authenticated `POST /api/scan`; the GitHub secret is disclosed only to
the hourly workflow step.

```bash
SBL_MONITOR_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$SBL_MONITOR_TOKEN" | npx wrangler secret put \
  -c wrangler.container.jsonc SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN
printf '%s' "$SBL_MONITOR_TOKEN" | gh secret set PRODUCTION_SYNTHETIC_MONITOR_TOKEN
gh variable set PRODUCTION_SYNTHETIC_MONITOR_REQUIRED --body 1
unset SBL_MONITOR_TOKEN

# Immediate receipt; the manual dispatch runs the synthetic as well as posture checks.
gh workflow run production-health.yml --ref main
```

The separate operator-only synthetic performs one neutral IANA scan, polls it to
completion, verifies the public v2/r2 result, reads the exact persisted report back
from R2, and renders its HTML report page. Every request rejects redirects,
returned capability URLs are restricted to the exact scanner origin and expected
path, and per-request plus whole-run deadlines bound failure handling. Its report
follows the ordinary seven-day/500-report retention policy; the synthetic never
deletes that report and does not replace the separately authenticated delete
canary. The workflow
requests four best-effort checks per hour, runs this synthetic on the hourly `:07`
schedule, and maintains one canonical failure issue. For an actual
detection-latency SLA, have an independent scheduler send the `production-health`
repository dispatch; GitHub cron delivery can be delayed.

### External controls the synthetic does not prove

Keep these as four separate operator receipts; neither `/api/health` nor the
active scan/write/read/render synthetic can attest them:

Use the create-only canonical producers in
[`operator-evidence-capture.md`](operator-evidence-capture.md) for the WAF,
log-retention, egress, staging-teardown, and exact-image licensing evidence.
The later human release attestations bind their digests; they do not replace
the underlying receipts.

1. Verify that the Cloudflare WAF ceiling covers both `POST /api/scan` and
   `GET /api/scan/admission`, sits above each stricter in-app quota, and has a
   bounded proof that it rejects traffic at the intended boundary.
2. Verify the effective Worker/container log-retention window and execute one
   bounded query that can diagnose a failed health or synthetic run without
   retaining report evidence or target details beyond the documented policy.
3. Keep the repo's R2 delete-canary Worker independently credentialed and the
   production-health gate required. It accepts no caller-selected object key,
   uses only `health/r2-delete-canary/`, and requires its own bearer token. Its
   write/read/**delete** transaction must prove the exact object is absent after
   deletion. Do not reuse a scanner, synthetic, staging, Turnstile, durable-job,
   watch, or R2 API credential for the invocation token.
4. Establish a platform-compatible independent egress backstop that preserves the
   scanner's connect-time IP pinning, or keep the absence explicitly accepted and
   reviewed. Cloudflare Containers internet-disable/interception is not a drop-in
   control for the current raw-TCP proxy path.

The reference deployment satisfied the first three receipts on 2026-07-29. It
proved the combined WAF ceiling on both `POST /api/scan` and
`GET /api/scan/admission` at ten requests per ten seconds per IP with a
ten-second block. For each route, the eleventh bounded invalid request received
`429` plus `Retry-After: 10`, Security Events matched
`scan-api-rate-limit` to the exact method and path, and the ordinary application
`400` returned after the block expired. A bounded seven-day Workers
Observability dashboard query returned 80 visible `/api/health` matches spanning
dashboard timestamps `2026-07-22 18:23` through `2026-07-29 11:25`; a separate
`/reports/` query returned eight visible matches spanning `2026-07-22 13:04`
through `2026-07-29 11:42`, all with report identifiers redacted. The required
delete canary receipt is recorded below. These point-in-time receipts are not
committed as canonical evidence, so the `waf-ceilings` and `log-retention`
release gates both still report open; re-capture them for any release that
needs those gates closed. The independent egress backstop remains operator
work.

### Activate the dedicated R2 delete canary

The repository includes the bounded implementation, tests, production-health
lane, and [`wrangler.r2-delete-canary.jsonc`](../wrangler.r2-delete-canary.jsonc).
The reference deployment's R2 delete canary is active and required as of
2026-07-29: the direct smoke and
[Production Health run 30483261603](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30483261603)
both passed the write/read/delete/absence contract, and the required gate is
enabled. For any fresh deployment, the source is only code-ready: do not claim
deletion coverage until the dedicated Worker is deployed, its independent
credential and exact HTTPS origin are configured, and both readbacks pass.
The Worker binding reaches the production reports bucket, but its request surface
accepts no object key and its implementation can touch only the fixed health
prefix; it never operates under `reports/`.

Deploy it fail-closed first. With no secret installed, every request is
unauthorized. Then generate and install one distinct token. Capture the exact
credential-free HTTPS origin printed by Wrangler; do not place `/run`, a query,
credentials, or a fragment in the configured origin:

```bash
set -euo pipefail
umask 077
R2_DELETE_CANARY_TOKEN_FILE="$(mktemp)"
export R2_DELETE_CANARY_TOKEN_FILE
openssl rand -hex 32 > "$R2_DELETE_CANARY_TOKEN_FILE"

npx wrangler deploy -c wrangler.r2-delete-canary.jsonc
npx wrangler secret put SITE_BEHAVIOR_LAB_R2_DELETE_CANARY_TOKEN \
  -c wrangler.r2-delete-canary.jsonc < "$R2_DELETE_CANARY_TOKEN_FILE"

# Set this to the exact origin emitted by the deploy, for example the dedicated
# workers.dev origin. It must be this canary Worker, never the scanner origin.
R2_DELETE_CANARY_ORIGIN=https://<dedicated-delete-canary-origin>
export R2_DELETE_CANARY_ORIGIN
```

First prove the deployed Worker directly through the same strict client used by
production health. A pass requires authenticated `POST /run`, a create-only write
beneath `health/r2-delete-canary/`, exact marker readback, deletion, and a final
absence readback:

```bash
PRODUCTION_R2_DELETE_CANARY_URL="$R2_DELETE_CANARY_ORIGIN" \
PRODUCTION_R2_DELETE_CANARY_TOKEN="$(tr -d '\r\n' < "$R2_DELETE_CANARY_TOKEN_FILE")" \
node scripts/smoke-production-r2-delete.mjs
```

Only after that direct receipt passes, configure both GitHub values. Only then make credential loss fail loudly
by setting the gate required. Production health
intentionally fails when the gate, URL, or token is absent:

```bash
gh secret set PRODUCTION_R2_DELETE_CANARY_TOKEN \
  < "$R2_DELETE_CANARY_TOKEN_FILE"
gh variable set PRODUCTION_R2_DELETE_CANARY_URL \
  --body "$R2_DELETE_CANARY_ORIGIN"
gh variable set PRODUCTION_R2_DELETE_CANARY_REQUIRED --body 1

gh workflow run production-health.yml --ref main
```

Read back that dispatched run and require the step **Run isolated production R2
write/read/delete canary** to pass with the summary `one isolated health object,
absence verified`. Then remove the temporary local token file:

```bash
rm -f "$R2_DELETE_CANARY_TOKEN_FILE"
unset R2_DELETE_CANARY_TOKEN_FILE R2_DELETE_CANARY_ORIGIN
```

The application records a durable, content-free debt marker before each expiry
or count-pruning delete and clears it only after physical deletion succeeds.
`/api/health` degrades and report publication is refused while any marker or
bounded-maintenance continuation remains. Expired reads stay `404` and never
become readable merely because deletion failed. To prevent public health polling
from amplifying signed R2 work, concurrent checks share one process-local probe;
successful retention state is reused for at most 30 seconds and failed state for
at most five seconds. `retentionCheckedAt` and `retentionCheckMaxAgeMs` disclose
that freshness. Publication never uses this cache and always preflights retention
directly. Configure an independent R2
lifecycle backstop one whole day beyond the ordinary seven-day application TTL;
it is disaster cleanup, not evidence that application deletion works:

```bash
npx wrangler r2 bucket lifecycle list site-behavior-lab-reports
npx wrangler r2 bucket lifecycle add site-behavior-lab-reports \
  reports-retention-backstop-8d reports/ --expire-days 8
npx wrangler r2 bucket lifecycle list site-behavior-lab-reports
```

This lifecycle mutation is an action-time production gate: inspect the current
rules, obtain approval, add only an equivalent missing `reports/` rule, and read
it back before release. Never shorten it to the application TTL, because the
platform rule must not race the app's provenance-aware bundle deletion.

The readback is scripted: `node scripts/r2-lifecycle-readback.mjs
[new-receipt.json]` (with `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` set)
reads the bucket's rules through the API and fails unless exactly one enabled
`reports/` deletion backstop exists at eight days or later, with no second
rule whose ancestor, child, exact, or bucket-wide scope intersects it. The
command enforces a whole-operation network deadline, refuses redirects, and
publishes only to a new symlink-safe path. Its version-2 receipt embeds the
bounded exact provider response bytes and re-derives the rules, verdict, and
receipt digest from those bytes. The observed 7-day/8-day conflict is exactly
what it detects. Production health only sees the app-level TTL through
`/api/health`, so run the readback and keep its receipt whenever lifecycle
rules are touched and as part of the release evidence.

For release provenance, do not run the local command and then submit its hash
to Actions. Create the protected `release-evidence` environment, configure its
`CLOUDFLARE_ACCOUNT_ID` variable and scoped read-only
`CLOUDFLARE_R2_LIFECYCLE_READ_TOKEN` secret, then dispatch
`.github/workflows/r2-lifecycle-evidence.yml` from `main`. Its fixed
GitHub-hosted job calls the API producer directly and uploads exactly
`receipt.json` as
`site-behavior-r2-lifecycle-evidence-<run-id>-<run-attempt>`. The hosted
provenance archive must authenticate that exact run, job, artifact digest, and
receipt before the lifecycle gate can pass.

For rollback or teardown, disable the required contract before removing either
half of its configuration, then remove the GitHub URL/token and delete only the
dedicated Worker. Never delete or rename the production reports bucket as part of
this rollback:

```bash
gh variable set PRODUCTION_R2_DELETE_CANARY_REQUIRED --body 0
gh variable delete PRODUCTION_R2_DELETE_CANARY_URL
gh secret delete PRODUCTION_R2_DELETE_CANARY_TOKEN
npx wrangler delete site-behavior-lab-r2-delete-canary --force \
  -c wrangler.r2-delete-canary.jsonc
```

Confirm the captured canary origin is unreachable, the exact Worker is absent,
production scanner health remains green on its expected SHA, and the last
successful canary receipt showed absence after deletion. If the final canary
failed after creating an object, investigate and remove only its exact fixed-prefix
health object before considering teardown complete.

## 8. Verify private v2/r2 shadows before the schema alias flip

The container writes flag-gated v2/r2 shadows to the existing reports bucket under
`v2-shadow/<full-build-sha>/<single|comparison>/`. Objects are create-only and disjoint
from public `reports/` shares. The scanner has no endpoint that reads or lists them.
A prefix is not an access-control boundary, so the bucket itself must also pass the
private-access preflight below. Do not move the public schema alias or regenerate the
corpus until one deployed GPC, Shields, and consent comparison has passed the verifier.

First inspect both independent R2 public-access mechanisms:

```bash
npx wrangler r2 bucket dev-url get site-behavior-lab-reports
npx wrangler r2 bucket domain list site-behavior-lab-reports
```

Require the `r2.dev` Public Development URL to be disabled. Require no enabled custom
domain, or independently prove that every connected domain is protected by Cloudflare
Access and does not anonymously serve an exact object key. Stop before enabling shadow
emission if either check is uncertain. Cloudflare documents that `r2.dev` and custom
domains expose bucket objects independently; disabling one does not disable the other.
See [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) and
the [`r2 bucket` Wrangler commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/).

Shadow objects have no public sidecar or scanner-side retention/listing mechanism. A
prefix-scoped lifecycle rule is therefore a precondition even for this bounded test, not
deferred cleanup. Inspect the existing rules and, if an equivalent `v2-shadow/` rule is
absent, add a one-day expiry before enabling emission:

```bash
npx wrangler r2 bucket lifecycle list site-behavior-lab-reports
npx wrangler r2 bucket lifecycle add site-behavior-lab-reports \
  v2-shadow-expire-1d v2-shadow/ --expire-days 1
npx wrangler r2 bucket lifecycle list site-behavior-lab-reports
```

After the exact candidate commit is live, record its build SHA. The production scanner
is normally open, so first place it behind a temporary operator token and verify the gate
before enabling either staging flag. That ordering prevents concurrent public scans from
creating untracked shadows. Any jobs accepted before the gate ran with shadow emission
off. Using Worker secrets keeps these rollout values out of committed configuration:

```bash
SCAN_BASE_URL=https://scan.sitebehavior.org
DEPLOYMENT=$(curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq -er '.deployment')
SHADOW_SCAN_TOKEN=$(openssl rand -hex 32)

printf '%s' "$SHADOW_SCAN_TOKEN" | npx wrangler secret put \
  SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN -c wrangler.container.jsonc

curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq \
  '{deployment, authenticated, openAccess}'
# require the same full deployment SHA, authenticated == true, openAccess == false

printf '1' | npx wrangler secret put SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION \
  -c wrangler.container.jsonc
printf '1' | npx wrangler secret put SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION \
  -c wrangler.container.jsonc

curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq \
  '{deployment, authenticated, openAccess, shadow: .checks.v2ShadowEmission, consent: .checks.consentVerification}'
# require the same full deployment SHA, shadow.status == "enabled",
# shadow.backend == "r2", consent == "enabled", authenticated == true,
# and openAccess == false
```

Open the scanner Worker's **Containers → Observability** live logs in the Cloudflare
dashboard; `observability.enabled` is already committed in `wrangler.container.jsonc`.
Enter `SHADOW_SCAN_TOKEN` in the UI's access-key field and complete one GPC comparison,
one Shields comparison, and one consent comparison. The operator-token path deliberately
bypasses Turnstile while the public gate is closed. Wait for each scan to finish and
record the exact object key from the container's `Shadow v2/r2 emission written.` log
entry; its closed `axis` field maps each key deterministically and `order` records AB/BA.
The success log contains only the private key, report type, opaque IDs, closed axis/order,
and build SHA; it never contains the target or evidence. Because ingress is gated, exactly
three comparison writes should appear. If any extra success entry appears, account for,
retrieve, and delete its key too. `npx wrangler tail -c wrangler.container.jsonc` may also
be useful for Worker logs, but do not depend on it for container stdout unless the
deployed platform proves it is present. See Cloudflare's
[container logging guidance](https://developers.cloudflare.com/containers/faq/#how-do-container-logs-work).

Download only those exact keys. Do not grant the scanner a list/read route and do not
copy the objects into `reports/`:

```bash
SHADOW_DIR=$(mktemp -d)
npx wrangler r2 object get "site-behavior-lab-reports/$GPC_KEY" \
  --remote --file "$SHADOW_DIR/$(basename "$GPC_KEY")"
npx wrangler r2 object get "site-behavior-lab-reports/$SHIELDS_KEY" \
  --remote --file "$SHADOW_DIR/$(basename "$SHIELDS_KEY")"
npx wrangler r2 object get "site-behavior-lab-reports/$CONSENT_KEY" \
  --remote --file "$SHADOW_DIR/$(basename "$CONSENT_KEY")"

npm run reports:verify-v2-shadow -- \
  --expected-build "$DEPLOYMENT" \
  --dir "$SHADOW_DIR" \
  --require-axes gpc,shields,consent
```

The verifier must report all three axes, the observed AB/BA order, eligibility,
verification, and both arm outcomes without printing subjects or evidence. Any invalid
object, filename/ID mismatch, non-r2 revision, or build mismatch fails the run.

### Optional operator/CI supporting-pair artifact

ScanReport v2/r2 can record a second complete pair, but it cannot claim a replicated
effect: its strength remains `observed-difference` even when the two recorded orders
cover both AB and BA. To exercise that wire shape without adding an undercharged public
four-visit mode, run the same comparison axis twice as two ordinary jobs. Each job is
independently admitted and costs two scan tokens. Preselect the two attempts; never keep
or discard a pair based on its measured delta.

Download the two exact comparison keys into an input directory, then aggregate them into
a different, local-only output directory:

```bash
REPEAT_INPUT_DIR=$(mktemp -d)
REPEAT_OUTPUT_DIR=$(mktemp -d)

npx wrangler r2 object get "site-behavior-lab-reports/$PRIMARY_KEY" \
  --remote --file "$REPEAT_INPUT_DIR/primary.json"
npx wrangler r2 object get "site-behavior-lab-reports/$SUPPORTING_KEY" \
  --remote --file "$REPEAT_INPUT_DIR/supporting.json"

npm run reports:aggregate-v2-shadow -- \
  --expected-build "$DEPLOYMENT" \
  --primary "$REPEAT_INPUT_DIR/primary.json" \
  --supporting "$REPEAT_INPUT_DIR/supporting.json" \
  --primary-key "$PRIMARY_KEY" \
  --supporting-key "$SUPPORTING_KEY" \
  --out-dir "$REPEAT_OUTPUT_DIR"
```

The command requires primary-only, validator-clean, pair-eligible, verified inputs from
the same build and axis; the final four run IDs and two pair IDs must be unique, and the
subject, conditions, and measurement environment must match. It writes one public r2
JSON artifact plus a separate local receipt binding the exact input keys and byte hashes.
The receipt is operator provenance, not part of the frozen report schema. Add
`--require-counterbalanced` only when the two preselected pairs recorded opposite AB/BA
orders; otherwise the artifact truthfully records `counterbalanced: false`. The command
is create-only and refuses a combined public wire larger than 8 MiB. Do not upload either
file into `reports/` or describe it as a replicated difference. Delete both source
objects by exact key and remove both temporary directories after verification.

Keep the operator gate in place while disabling shadow emission, then delete every test
object by exact key and remove the temporary directory. Restore the scan gate last so no
public request can race the cleanup. These commands assume all three rollout secrets were
previously absent and the scanner was public; if they were already managed, restore the
intended managed values instead:

```bash
npx wrangler secret delete SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION \
  -c wrangler.container.jsonc
npx wrangler secret delete SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION \
  -c wrangler.container.jsonc

curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq \
  '{deployment, authenticated, openAccess, shadow: .checks.v2ShadowEmission, consent: .checks.consentVerification}'
# require shadow.status == "disabled", consent == "disabled",
# authenticated == true, and openAccess == false

npx wrangler r2 object delete "site-behavior-lab-reports/$GPC_KEY" --remote
npx wrangler r2 object delete "site-behavior-lab-reports/$SHIELDS_KEY" --remote
npx wrangler r2 object delete "site-behavior-lab-reports/$CONSENT_KEY" --remote
rm -rf "$SHADOW_DIR"

npx wrangler secret delete SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN \
  -c wrangler.container.jsonc
unset SHADOW_SCAN_TOKEN

curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq \
  '{deployment, authenticated, openAccess, shadow: .checks.v2ShadowEmission, consent: .checks.consentVerification}'
# for the normal public posture require shadow.status == "disabled",
# consent == "disabled", authenticated == false, and openAccess == true
```

## 9. Enable public v2/r2 reports after verification

Public r2 production is a separate fail-closed switch from private shadow emission.
Enable it only after the candidate build has passed the shadow verifier and the public
report-store configuration is constructible. Health verifies configuration readiness,
not remote bucket reachability or permissions; confirm those with a saved-report smoke.
The exact prerequisites are a full deployed build SHA,
`SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION=1`, and a configured report-store backend.
When the gate is on, a builder or persistence failure fails the scan; it never returns a
v1 substitute. Shadow emission remains independently usable when both flags are on.

The production values are committed under `vars` in `wrangler.container.jsonc`, so the
tested production branch is the source of truth and a later deploy cannot silently reset
them. Before promoting the enabling commit, set the temporary scan access token so no
public scan can enter during the mixed Pages/container rollout. Keep that lock until the
updated Pages client and container both serve the exact tested SHA, then require the
combined edge/container health signal:

```bash
umask 077
export R2_ROLLOUT_TOKEN_FILE="$(mktemp)"
openssl rand -hex 32 > "$R2_ROLLOUT_TOKEN_FILE"
npx wrangler secret put SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN \
  -c wrangler.container.jsonc < "$R2_ROLLOUT_TOKEN_FILE"

curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq \
  '{authenticated, openAccess, turnstile}'
# require authenticated == true, openAccess == false, and turnstile == false
```

Before enabling the producer, deploy the updated Pages client that recognizes r2 report
roots without a v1-style `ok` field; an older client will reject a valid r2 result.

```bash
curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq \
  '{deployment, scansAvailable, publicR2: .checks.publicR2Reports, consent: .checks.consentVerification, store: .checks.reportStore}'
# require deployment == the verified full SHA, scansAvailable == true,
# publicR2.status == "enabled", consent == "enabled", and store.kind != "unavailable"

curl --fail-with-body -s https://sitebehavior.org/scan-report.schema.json | jq -e \
  '."$id" == "https://sitebehavior.org/schemas/scan-report.v2.r2.schema.json"'

SCAN_BASE_URL="$SCAN_BASE_URL" \
  SMOKE_SCAN_ACCESS_TOKEN="$(tr -d '\r\n' < "$R2_ROLLOUT_TOKEN_FILE")" \
  npm run test:smoke:scanner
```

Run one authenticated deployed scan and retrieve its saved JSON before removing the
temporary access token. That write/read round trip is the remote R2 permission and
reachability proof that `/api/health` intentionally does not attempt.

The synchronous response and the submitter-only completed-job response may carry the
ephemeral screenshot block. `/api/reports/:id` and the stored report object carry only
the public r2 projection plus its share pointer. Managed provenance is written as a
separate sidecar object.

Remove the lock last, then prove the public posture. Keep the token file until the
secret deletion succeeds so a failed unlock can be retried safely:

```bash
npx wrangler secret delete SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN \
  -c wrangler.container.jsonc
rm -f "$R2_ROLLOUT_TOKEN_FILE"
unset R2_ROLLOUT_TOKEN_FILE

curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq -e '
  .authenticated == false and .openAccess == true and .turnstile == true and
  .checks.publicR2Reports.status == "enabled" and
  .checks.consentVerification == "enabled" and
  .checks.v2ShadowEmission.status == "disabled"'
```

Rollback the public producer first. Keep or restore the temporary scan access token and
change `SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS` to `0`. Leave consent verification enabled
until private shadow emission is also disabled, then optionally return consent to `0`
and promote the tested rollback. With the public gate off, the runtime returns to its v1
response path. The production-health workflow intentionally fails while r2 is disabled;
if the rollback is expected to persist, change its asserted posture in the same rollback
commit. Do not reopen traffic until health proves the rollback SHA and disabled producer:

```bash
curl --fail-with-body -s "$SCAN_BASE_URL/api/health" | jq \
  '{deployment, scansAvailable, publicR2: .checks.publicR2Reports, consent: .checks.consentVerification}'
# require the rollback SHA, scansAvailable == true, publicR2.status == "disabled",
# and consent == "disabled"
```

## Cost

Workers Paid is $5/mo; container compute is metered while an instance is running
(`sleepAfter` lets it scale to zero between scans). R2 has a free tier that comfortably
covers a report corpus. Realistic low-traffic total: roughly $5-15/mo.
