# Deploying the Node Scanner on Cloudflare Containers (live Shields)

The Cloudflare-native way to run the full **Node/Playwright scanner** — and therefore
**live, on-demand Shields tried-vs-blocked** scanning — without leaving your Cloudflare
account. It runs the existing [Dockerfile](../Dockerfile) as a Cloudflare Container,
fronted by a Worker, with your existing Cloudflare Pages site as the UI/gallery front door.

> This replaces "parked pending paid compute." The only prerequisite is the **Workers Paid
> plan** ($5/mo + metered container compute). The scanner code, Dockerfile, Shields engine,
> and R2 report backend already exist; this is configuration.

## Does it fit? (verified against Cloudflare docs, 2026-06)

Chromium needs ~2 GB RAM, and the Playwright base image is ~2–3 GB, and **a container
image cannot exceed its instance's disk**. So the small instance types do **not** work:

| instance_type | RAM | disk (= max image size) | usable here? |
|---|---|---|---|
| `lite` | 256 MiB | 2 GB | no (image too big, no RAM) |
| `basic` | 1 GiB | 4 GB | no (RAM too low for Chromium) |
| **`standard-1`** | 4 GiB | 8 GB | minimum |
| **`standard-2`** | 6 GiB | 12 GB | **recommended** |
| `standard-3/4` | 8–12 GiB | 16–20 GB | for high concurrency |

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
        Cloudflare R2  (durable report store — see "Report storage" below)
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
    // One warm instance keeps the in-memory async job queue coherent. Scale by
    // sharding on a key here once a single instance is not enough.
    return getContainer(env.SCANNER).fetch(request);
  }
};
```

> The committed `cloudflare/container-worker.ts` is fuller than this sketch: it
> also forwards the report-store, egress, async, CORS, and secret env vars into
> the container via the `ScannerContainer` `envVars`. Use the committed file.

`wrangler.container.jsonc` (kept separate from the existing GPC `wrangler.jsonc` so the
live Worker is untouched):

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

> **Verify these against current Cloudflare docs** — the `@cloudflare/containers` routing
> helper (`getContainer`), the Durable Object migration shape (`new_sqlite_classes`), and
> how container env/secrets are passed are the version-sensitive lines. The reliable way to
> get correct, current boilerplate is to scaffold once with
> `npm create cloudflare@latest -- --template=cloudflare/templates/containers-template`
> and copy this project's `class_name`/`image`/`instance_type` into it.

## 3. Report storage — use R2, not the container disk

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
SITE_BEHAVIOR_LAB_ASYNC_SCANS=1                          # long scans don't hold the connection
SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN=<strong secret>     # operator-gated launch (see §6)
```

## 4. Deploy

```bash
npx wrangler deploy -c wrangler.container.jsonc
```

This builds the Dockerfile, pushes the image to Cloudflare's registry, and deploys the
Worker + container. Add a custom domain/route (e.g. `scan.sitebehavior.org`) to the Worker.

## 5. Point the existing Pages site at it

In the Cloudflare **Pages** project (sitebehavior.org) production env, set and redeploy:

```
NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE = https://scan.sitebehavior.org
```

No code change — the UI reads `/api/health` and lights up the **Shields** and GPC toggles.
The scanner's browser CORS allow-list is preconfigured to `https://sitebehavior.org` via
the `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` var in `wrangler.container.jsonc` (the front Worker
forwards it into the container); edit that var if your Pages origin differs, or set it to
`*` for an open scanner. For an open scanner also add `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS=1`
to the Pages build; for Turnstile add `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY=<site-key>`.

## 6. Security: the SSRF backstop is weaker here — launch operator-gated

The Node scanner's safety = the in-app **connect-time proxy** (resolves, validates, and
pins to a public IP) **plus** an external egress firewall as defense-in-depth. On managed
Cloudflare Containers you **cannot add that external egress firewall** (no VPC/iptables
control), so the in-app proxy is your only layer. That is fine for an **operator-gated**
scanner (keep `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` set, you run the scans) and is the
recommended launch: it unlocks live Shields for building the corpus with no open-abuse
surface. Only open `POST /api/scan` to the public behind **Turnstile + a WAF rate rule**,
and only after accepting that the egress backstop is the in-app proxy alone.

## 7. Verify

Run the automated production smoke test against the deployed scanner. It checks health
(live Shields advertised, ad-block engine active, durable storage), runs a real scan and
confirms it is stored screenshot-stripped, runs a live Shields comparison, and confirms a
link-local SSRF target (`169.254.169.254`) is refused. It tolerates async scan mode (the
container returns `202` + a job id to poll):

```bash
SCAN_BASE_URL=https://scan.sitebehavior.org \
  SMOKE_SCAN_ACCESS_TOKEN=<the scan token> \
  npm run test:smoke:scanner
```

Point `SMOKE_SHIELDS_URL` at a tracker-heavy site to also eyeball a non-zero would-block
count. A quick manual check of the same essentials:

```bash
curl -s https://scan.sitebehavior.org/api/health | jq '.capabilities'
# expect: { "singleScan": true, "gpcComparison": true, "shieldsComparison": true, "savedReports": true }
```

## Cost

Workers Paid is $5/mo; container compute is metered while an instance is running
(`sleepAfter` lets it scale to zero between scans). R2 has a free tier that comfortably
covers a report corpus. Realistic low-traffic total: roughly $5–15/mo.
