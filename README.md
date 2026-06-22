# Site Behavior Lab

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

**See what a site does, not just what it says.**

Site Behavior Lab runs controlled Chromium visits and reports observable site behavior: network requests, third-party domains, curated service labels, cookies, storage keys, screenshot evidence, scan conditions, high-entropy browser API calls, behavioral fingerprinting heuristics, and third-party session/input-monitoring listener signals seen by lightweight instrumentation.

> **Deployment status.** The public site at [https://sitebehavior.org](https://sitebehavior.org) is the static **Cloudflare Pages** front door. Its **live scanner is the full Node/Playwright scanner — including live Brave Shields (the tried-vs-blocked diff)** — deployed on **Cloudflare Containers** at `scan.sitebehavior.org` with R2-backed report storage, **open to the public behind Cloudflare Turnstile and per-client rate limiting** (the front-Worker gate in [cloudflare/container-worker.ts](cloudflare/container-worker.ts); go-live sequence in [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md), container build in [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md)). Shared report links resolve to that scanner origin, which also redirects its own root back to the front door. The lighter **Browser Run Worker** remains available as a GPC/trackers-only alternative. Shields evidence is also generated operator/CI-side and published into the static evidence corpus. See [docs/deployment-topology.md](docs/deployment-topology.md) for the decision record.

## Why It Is Different

Site Behavior Lab is built for reproducible, inspectable evidence instead of opaque scoring. Each report records the scan conditions that affect results, including browser version, viewport, timezone, locale, Global Privacy Control state, scanner egress, tracker catalog version, and scanner disclosure text.

The project is open source under the [AGPL-3.0-or-later](LICENSE) so anyone can inspect the scanner, URL-safety checks, catalog labels, and report UI behind the results.

## Current Capabilities

- Next.js app with a server-side Playwright scanner.
- Public URL input with desktop/mobile viewport selection.
- Optional Global Privacy Control signal, plus off/on GPC and Shields comparison modes in the Node scanner.
- SSRF guard that blocks localhost, private networks, link-local addresses, and reserved test ranges, with the Node scanner routing Chromium through a connect-time public-address proxy.
- Basic server-side guardrails: request body limit, per-client scan and report-read rate limits, scan concurrency cap, scan duration cap, per-scan request cap, and shared Chromium reuse.
- Optional scan access key enforcement for public or gated deployments.
- Report URLs omit credentials and fragments. First-party URLs omit query strings; third-party request logs preserve query parameter names with values redacted.
- Immutable local report links and JSON endpoints under `/reports/:id` and `/api/reports/:id`.
- Runtime health/readiness metadata under `/api/health`.
- Static export (deployed on Cloudflare Pages) for the report viewer, generated report gallery, saved-report comparisons, and committed report JSON under `public/reports/`.
- Plain-language headline at the top of every report, plus per-report Open Graph / X (`summary_large_image`) share cards and link metadata generated from that headline, so a shared report link unfurls with the site name, the lead finding, and key counts in both the Node app and the static export.
- Curated "Start here" gallery on the static site that groups pre-scanned popular sites by category (banking & money, health, dating, kids & education, news & media, shopping, search & social, and government) with plain-language headline cards, so a first-time visitor sees real evidence without running a scan. The curated list lives in `public/featured-sites.json`.
- Discoverability and structured data: brand favicon, `robots.txt`, a `sitemap.xml` that lists committed report pages on the static export, sitewide `WebSite`/`SoftwareApplication` JSON-LD, and per-report schema.org `Dataset` JSON-LD (lead finding, scanned site, headline metrics, and a machine-readable download link).
- Accessibility: the signal-colour ramp is tuned to WCAG AA contrast (>=4.5:1 as text, including on its tinted chip backgrounds), and severity is always paired with text and icons so it never relies on colour alone.
- Corpus-relative severity: once enough real sites have been scanned, the findings rank a report against measured percentiles from `public/corpus-stats.json` ("more third-party domains than ~90% of sites scanned so far"); below a minimum sample size they fall back to fixed reference thresholds, so population claims never appear without data to back them.
- Server-rendered, indexable `/directory/` page that lists every committed report with its plain-language headline and key metrics, linked from the gallery and included in `sitemap.xml` for crawlable internal linking.
- Transparency-index hero that leads the static homepage with measured corpus highlights — how many real sites have been scanned and the median tracker count for the top categories — linking straight into `/directory/` and the report library, so the landing view is evidence rather than a pitch.
- Collection-agnostic `ScanResult` contract with a normalized [PageGraph adapter](docs/pagegraph-adapter.md), tolerant GraphML parser, and PageGraph-derived fixture reports for Brave/internal evidence ingestion.
- Evidence report with:
  - plain-language findings board that translates the evidence into severity-ranked cards
  - summary metrics
  - request composition bar and request timeline
  - filterable request log (signal, status, and resource-type filters)
  - domain summary
  - script-to-request causal map rendered from PageGraph provenance, when present
  - Curated tracker/service labels
  - cookies
  - local/session storage keys with values redacted
  - canvas, canvas-font, WebGL, audio, WebRTC, third-party session-recording, and input-monitoring signals
  - active keystroke/input-exfiltration check: a synthetic sentinel is typed into form fields (never submitted) and flagged if it is sent to a third party, in plain, base64, hex, or hashed form
  - screenshot
  - methodology disclosure
  - sanitized JSON export and request-log CSV export

## Acceptable Use

Use Site Behavior Lab for transparency research, journalism, compliance review, debugging your own sites, or inspecting public websites where that activity is allowed. Do not use it for attacking, brute-forcing, crawling at abusive rates, bypassing access controls, or scanning systems you do not own or do not have permission to test.

The visit is passive except for one bounded **active input probe**: the Node/Playwright scanner types a synthetic, non-PII test value into up to a handful of *visible* form fields to test for keystroke/input capture. It **never submits the form, never presses Enter, and never enters real data**, the typed value is synthetic and is not stored, and every report discloses how many fields were typed into. The probe's own requests still pass through the scanner's SSRF/public-address guard. Operators running an open deployment should be aware their scanner performs this bounded interaction on scanned sites at a visitor's request.

Operators of public deployments are still responsible for abuse prevention and local legal compliance. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).

## Data Attribution

The tracker/service catalog is a US-biased, hand-curated, in-repo list of high-prevalence third-party services in [lib/tracker-catalog.ts](lib/tracker-catalog.ts), licensed with this repository under AGPL-3.0-or-later. It deliberately bundles no third-party dataset, so there is no separate NonCommercial term to clear before commercial use.

Coverage is intentionally a lower bound: the curated list names recognizable services rather than every tracker. The Shields would-block and block-simulation signals are computed separately, with Brave's own ad-block engine (the [`adblock`](https://github.com/brave/adblock-rust) Rust crate compiled to WASM, built from `tools/adblock-wasm/`) over Brave's default filter lists, vendored as a pinned snapshot; those lists do not assign the service/entity labels shown by the curated catalog.

## Run Locally

```bash
npm install
npx playwright install chromium
npm run dev
```

Open `http://127.0.0.1:3000`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` | unset | When set, `/api/scan` requires the token in `Authorization: Bearer ...` or `x-site-behavior-lab-access-token`. Leave unset only for trusted local development or intentionally public deployments with external abuse controls. |
| `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS` | unset | Cloudflare Workers only (Browser Run and Containers). Set to `1` only for an intentionally open public scanner, with no scan token set. On the Browser Run worker it also requires the DNS-rebinding risk flag below; the Containers scanner pins DNS at connect time, so it does not. The Containers front Worker still enforces Turnstile (when configured) and the KV rate limit. See [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md). |
| `SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK` | unset | Browser Run worker only. Must be `1` before unauthenticated Browser Run scans are enabled, because Browser Run cannot currently pin the browser connection to the DNS answer verified by the Worker. Not used by the Containers scanner. |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE` | `6` | Cloudflare Workers only. Maximum public scan tokens per client per minute. GPC/Shields comparisons cost two tokens. The Containers front Worker needs a `RATE_LIMITS_KV` binding; the Browser Run worker uses `REPORTS_KV`. |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY` | `120` | Cloudflare Workers only. Maximum public scan tokens per client per day. GPC/Shields comparisons cost two tokens. |
| `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS` | unset | Set to `1` only when traffic reaches the app through a trusted proxy that controls forwarding headers and blocks direct origin access. Rate limiting uses in-memory counters per Node process. |
| `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` | `*` | Browser CORS allow-list for the `/api` routes (also honored by the Cloudflare Worker). Default `*` lets any site invoke the scanner from a browser — fine for a single-origin (B1) deployment or an intentionally open scanner. Set it to one origin (for example `https://sitebehavior.org`) to allow only that site's cross-origin browser requests; others are denied. The scan API uses no cookies, so `*` is safe by default. |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` | `this scanner instance` | Describes the scanner's egress location in report disclosures and JSON exports, for example a region, datacenter, or lab network label. |
| `SITE_BEHAVIOR_LAB_ASYNC_SCANS` | unset | Set to `1` to make `/api/scan` return `202 { jobId, statusPath }` and run scans through the single-process in-memory job queue. Clients poll `/api/scans/:id` until the report is ready. Completed async reports are saved under the job ID so the client can recover from a lost status record, but queued/running job state is still in-memory. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND` | `filesystem` | Backend for persisted share reports: `filesystem` (default) or `r2`. The `filesystem` backend needs a persistent volume to survive restarts; `r2` stores reports in Cloudflare R2 (S3-compatible) so share links survive container redeploys and host replacement, and is what multi-node hosting needs. The report-store policy (share IDs, screenshot stripping, validation, expiry, prune counts) is identical across backends. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` | `.site-behavior-lab/reports` | Filesystem backend only. Directory for persisted share reports. Use a persistent volume in production. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` | `7` | Maximum age for persisted share reports before they are ignored and pruned. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` | `500` | Maximum number of persisted share reports to retain. |
| `SITE_BEHAVIOR_LAB_R2_BUCKET` | `site-behavior-lab-reports` | R2 backend only. Name of the R2 bucket that holds report JSON. |
| `SITE_BEHAVIOR_LAB_R2_ENDPOINT` | unset | R2 backend only. S3-compatible endpoint, for example `https://<accountid>.r2.cloudflarestorage.com`. Required when `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2`. |
| `SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID` / `SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY` | unset | R2 backend only. Credentials for an R2 API token scoped to the reports bucket (Object Read & Write). Required when the backend is `r2`. These are secrets. |
| `SITE_BEHAVIOR_LAB_R2_PREFIX` | `reports/` | R2 backend only. Key prefix under which report objects are stored. |
| `SITE_BEHAVIOR_LAB_DNS_RESOLVER_URL` | `https://cloudflare-dns.com/dns-query` | Cloudflare Worker only. DNS-over-HTTPS resolver used for the Worker's public-address preflight checks. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` | unset | Optional public API base for static builds. When set for a static deployment (such as Cloudflare Pages), the static UI shows a live scan form and sends scans to this Cloudflare Worker/API origin. Do not put secrets in this value. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY` | unset | Build-time public Turnstile site key for the static scan UI. Required when the target Cloudflare Worker is deployed with `TURNSTILE_SECRET_KEY`; the static UI renders the Turnstile widget and sends its token with each scan. Without it, a Turnstile-gated Worker leaves the scan button disabled with an explanation. This is a public site key, not a secret. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` | unset | Canonical public origin — scheme and host only, for example `https://sitebehavior.org` — used as the metadata base so report social cards (Open Graph / X) resolve to absolute image URLs, and as the canonical origin for `robots.txt`, `sitemap.xml`, and JSON-LD URLs. Any GitHub Pages project-page subpath is applied automatically via the base path, so do not include it here. Set this for any public deployment; without it, card image URLs fall back to `http://localhost:3000` and will not unfurl. Do not put secrets in this value. |

Copy `.env.example` for a production-oriented starting point.

## Production Deployment

> **Choosing a topology.** For a public deployment the Node container and the Cloudflare Worker are not equivalent: they sit on opposite sides of the SSRF/DNS-rebinding boundary (the Node scanner pins to a public IP at connect time; the Worker preflight can be rebound). See [docs/deployment-topology.md](docs/deployment-topology.md) for the decision record — the recommended path is the Node scanner container behind Cloudflare for edge/WAF/R2. **That path now ships on Cloudflare Containers** (operator-gated, R2-backed — see [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md)); the generic single-node steps below remain the runbook for any other host. The static Pages site plus the GPC/trackers Worker (described under "Static Hosting" and "Cloudflare Worker Deployment") remains the public front door.

For a single-node deployment:

1. Set `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` unless the scanner is intentionally public and protected by stronger external controls.
2. Set `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` to a persistent volume, and tune report age/count retention.
3. Set `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` to the region/network label users should see in report methodology.
4. Put the app behind a trusted HTTPS reverse proxy. Set `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS=1` only when direct origin access is blocked.
5. Run `/api/health` from your load balancer or monitor and alert when `status` is `degraded`; the Node health response includes Brave ad-block engine load status under `checks.adblock`.
6. Enforce egress firewall rules at the host/container/VPC layer so Chromium cannot reach localhost, private, link-local, metadata, or other internal networks even if an application bug is found. The Node scanner routes Chromium through a per-scan local proxy that resolves, validates, pins, and connects to public IP addresses at connection time; the external firewall remains the required defense-in-depth boundary for public deployments.

Docker:

```bash
docker build -t site-behavior-lab .
docker run --rm -p 3000:3000 \
  --env-file .env.production \
  -v site-behavior-lab-reports:/var/lib/site-behavior-lab/reports \
  site-behavior-lab
```

Validate the container path end to end with:

```bash
npm run test:smoke:docker
```

Horizontally scaled deployments should replace or front the filesystem report store with shared durable storage and external rate limiting/queueing. The in-process async scan queue and rate counters protect one Node process, not an entire cluster. Async queued/running job records are not durable across process restarts; only completed reports that reached persistence can be recovered by job ID.

For the planned queue/worker extraction path, see [docs/scan-job-model.md](docs/scan-job-model.md).

## Static Hosting (Cloudflare Pages)

Production runs as a static export on Cloudflare Pages at https://sitebehavior.org; any static host can serve the same artifact (GitHub Pages also works). Static hosting serves the static interface, generated report gallery, and client-side report viewer. It cannot run the Node/Playwright scanner, `/api/scan`, `/api/health`, or filesystem-backed report reads. The Pages build strips API routes, generates `public/reports/index.json` from committed report JSON, and pre-renders `/reports/:id/` pages for every `public/reports/:id.json` file present at build time.

Static report JSON files are public artifacts. Treat them as intentionally published evidence, not private scan storage.

Build the static artifact locally:

```bash
npm run build:pages
```

The static site is written to `out/` with a `.nojekyll` marker. The build automatically infers a project-page base path from `GITHUB_REPOSITORY` in GitHub Actions, for example `/site-behavior-lab`. For a user/org Pages site or custom domain hosted at the domain root, set:

```bash
SITE_BEHAVIOR_LAB_PAGES_BASE_PATH=/
```

Cloudflare Pages builds and deploys `out/` from `main` via its Git integration: in the Pages project set the build command to `npm run build:pages` and the output directory to `out`, with production env vars `SITE_BEHAVIOR_LAB_PAGES_BASE_PATH=/`, `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://sitebehavior.org`, and `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` pointed at the scan API. Any other static host can serve the same `out/` directory.

A static export cannot send the server security headers configured for the Node deployment. Configure CSP/HSTS/custom headers at the CDN/host layer instead — on Cloudflare, via response-header Rules.

## CI as Scanner

The `.github/workflows/scan.yml` workflow is the zero-server scan path. It runs the built app inside GitHub Actions, calls the same `/api/scan` endpoint as the live product, writes a screenshot-stripped static report to `public/reports/<id>.json`, rebuilds `public/reports/index.json`, uploads the JSON artifact, and commits the report back to the repository. The push to `main` then triggers Cloudflare Pages to rebuild and republish the updated static gallery.

Run it manually from **Actions > Run Site Scan**, or trigger it from trusted automation with a `repository_dispatch` event of type `site-behavior-scan` and a payload like:

```json
{
  "url": "https://example.com",
  "device": "desktop",
  "gpc_enabled": "true",
  "compare_gpc": "false"
}
```

Only trusted operators should be able to dispatch scans. A public static page should not expose a GitHub token directly to visitors.

## Featured Gallery

The static site shows a curated "Start here" gallery, grouped by category, sourced from `public/featured-sites.json`. Each featured card shows the plain-language headline for the matching committed report, so first-time visitors see real evidence immediately.

Populate it from `.github/workflows/scan-featured.yml` (**Actions > Scan Featured Sites**) or a `repository_dispatch` of type `site-behavior-featured-scan`. The workflow scans every public homepage in the catalog by spawning the same `/api/scan` path as `scan:ci`, then prunes, rebuilds the manifest, and commits the reports. Run it locally against a built scanner with:

```bash
npm run build
npm run start -- --port 3100
BASE_URL=http://127.0.0.1:3100 npm run scan:featured
```

Filter and tune with `FEATURED_CATEGORIES` (comma-separated category ids), `FEATURED_LIMIT`, `FEATURED_COMPARE_GPC` (default `true`, the GPC off/on comparison), `FEATURED_DEVICE`, and `FEATURED_DELAY_MS`. Edit the catalog in `public/featured-sites.json`, then re-run the scan to refresh the gallery.

> **Preview a corpus run before publishing.** The workflow commits and pushes the new reports to the branch it runs on, so dispatch it from a non-production branch (in **Actions > Scan Featured Sites**, choose the branch under "Use workflow from") to stage the corpus there instead of `main`. Cloudflare Pages builds a preview deployment for that branch — review the gallery, `/directory/`, and whether the corpus cleared `CORPUS_MIN_SAMPLE` (the run's job summary reports the report and distinct-site counts) — then merge into `main` to publish. Running it directly on `main` publishes immediately.

## Corpus Percentiles and Directory

`npm run corpus:stats` (`scripts/build-corpus-stats.mjs`) reads the committed reports under `public/reports/`, keeps one data point per distinct real site (most recent scan wins; reserved/test domains like `example.com` are excluded), and writes percentile distributions of the key behavior metrics to `public/corpus-stats.json`. The Pages build and both scan workflows rebuild it after the report manifest, so the committed stats stay in sync with the corpus.

The findings board uses these percentiles to describe severity in relative terms ("more third-party domains than about 90% of the N sites scanned so far"). This only activates once the corpus reaches `CORPUS_MIN_SAMPLE` distinct sites (see `lib/corpus-stats.ts`); below that, the findings keep the fixed reference-threshold wording so the product never makes a percentile claim it cannot back with data.

These percentiles rank a site against the scanned corpus, **not a random sample of the web**. The corpus is seeded from the curated featured catalog — popular, mostly commercial sites chosen for their tracker prevalence — so a "more than ~90%" result means heavy even among popular sites, and a low ranking only means lighter than that set, not light in absolute terms. The sample is also small (tens of sites at launch), so tail percentiles (p90/p95) are approximate; the wording stays hedged ("about", "so far") and the bottom-line finding states the comparison set explicitly.

To reduce that popular-commercial skew, scan the **corpus de-bias seed list** in `public/corpus-seed-sites.json` — a broader, lighter mix (open source, nonprofit, education, reference, international government, community/personal) kept separate from the gallery. Run **Actions > Scan Featured Sites** with the `sites_file` input set to `public/corpus-seed-sites.json`, or locally:

```bash
FEATURED_SITES_FILE=public/corpus-seed-sites.json BASE_URL=http://127.0.0.1:3100 npm run scan:featured
```

Those scans populate `public/reports/`, the corpus stats, and `/directory/`, but **not** the curated "Start here" gallery (which only matches `public/featured-sites.json`). It is a curated-diverse list, not a random sample, so it widens the distribution without claiming to represent the whole web.

`/directory/` is a server-rendered, indexable index of every committed report — domain, plain-language headline, and key metrics, linking to the full evidence. It is generated for both the Node app and the static export, listed in `sitemap.xml`, and linked from the public gallery.

The scan workflow prunes committed static reports before updating the manifest. By default it keeps the filesystem report-store policy of 7 days and 500 reports. Override static retention with `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_COUNT`, or use the existing `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` variables as shared fallbacks.

## Cloudflare Worker Deployment

The repo also includes a Cloudflare-native scanner in `cloudflare/worker.ts`. It powers the public static scan form with Cloudflare Browser Run, KV-backed report storage, DNS-over-HTTPS public-address checks, public scan quotas, and GPC comparison support.

> For the **full Node/Playwright scanner with live Shields** running on Cloudflare (Containers, fronted by a Worker, with R2 report storage), see [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md). That is the Cloudflare-native version of the Node container path; this Browser Run Worker stays the lightweight GPC/trackers option.

One-time Cloudflare setup:

1. Create the KV namespace used by the report store and public scan rate limiter:

```bash
npm run cf:kv:create
```

2. Put the returned namespace id in `wrangler.jsonc` under the `REPORTS_KV` binding.
3. Gating is the safer default for self-hosting, but the committed `wrangler.jsonc` ships the intentionally-open posture used by sitebehavior.org (`SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` plus the risk flag — see step 5). For a gated instance, set both flags back to `0` in `wrangler.jsonc` and set a scan token:

```bash
npx wrangler secret put SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN
```

4. Optional for gated deployments: create a Turnstile site in Cloudflare and set the secret key:

```bash
npx wrangler secret put TURNSTILE_SECRET_KEY
```

   If the static UI drives this Worker, also build it with the matching public site key so the UI can render the Turnstile widget and send its token; otherwise the scan button stays disabled with an explanation:

```bash
NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY=<turnstile-site-key> npm run build:pages
```

5. If you intentionally want an open public Worker, set both `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` and `SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK=1`, keep the KV-backed public scan quotas, and add Cloudflare WAF/rate limiting for abuse-sensitive deployments. If open access is set without the risk-acceptance flag, `/api/scan` returns `503` instead of falling back to token-gated access.

6. Deploy the Worker:

```bash
npm run cf:deploy
```

The Worker exposes:

- `GET /api/health`
- `POST /api/scan`
- `GET /api/reports/:id`

The Worker returns Cloudflare Browser Run reports and stores screenshot-stripped copies in KV. It performs public URL shape checks plus DNS-over-HTTPS public-address checks before navigation and resource loading, using Cloudflare DNS by default or `SITE_BEHAVIOR_LAB_DNS_RESOLVER_URL` when set. Current `@cloudflare/playwright` Browser Run launch options do not expose a proxy or IP-pinned navigation primitive, so the Worker DNS guard is preflight-only: Browser Run still performs its own connection-time DNS resolution. Open unauthenticated Worker scans therefore stay disabled unless the deployment explicitly sets the risk-acceptance flag. GPC comparison runs two sequential Browser Run visits and costs two public scan tokens. KV public-scan quotas are best-effort read-then-write counters and can be exceeded by concurrent requests, so abuse-sensitive public deployments should add Cloudflare WAF/rate limiting or another atomic cost-control layer. R2 is still the better long-term report store, but the account must enable R2 in the Cloudflare dashboard before `npm run cf:bucket:create` can create `site-behavior-lab-reports`. Shields block simulation, queued Cloudflare jobs, richer catalog parity, and Worker-side connect-time DNS pinning remain future parity work.

Set `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` during `npm run build:pages` to expose this Worker from the static UI. Set `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS=1` only when that Worker is intentionally open so the static UI does not show the access key field.

## Report Contract

Every saved or exported scan artifact is a `ScanReport` with `schemaVersion: 1`. Single reports and comparison reports both carry the version, and comparison reports also require the same version on their `baseline` and `variant` runs. Uploads, filesystem shares, static fixtures, and Worker KV/R2 reads are validated against the current schema before rendering.

Runtime capability parity is intentionally explicit:

| Producer | Single scan | GPC comparison | Shields comparison | Async jobs | DNS guard | Tracker catalog | Store |
|---|---:|---:|---:|---:|---|---|---|
| Node / Playwright | yes | yes | yes | yes | connect-time public-address proxy | hand-curated service catalog | filesystem |
| Cloudflare Worker / Browser Run | yes | yes | no | no | DNS-over-HTTPS preflight only | none | KV or R2 |
| Brave PageGraph adapter | yes | no | no | no | source artifact | provided or bundled curated catalog | caller-managed |

## Checks

```bash
npm run check
```

Or individually:

```bash
npm run typecheck
npm run test:unit
npm run build
npm run build:pages
npm run reports:manifest
npm run test:smoke:docker
```

The smoke test needs a built app running:

```bash
npm run build
npm run start -- --port 3100
BASE_URL=http://127.0.0.1:3100 npm run test:smoke
```

If the server has `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` set, pass the same value to the smoke runner as `SMOKE_SCAN_ACCESS_TOKEN`.

## Important Limitations

Site Behavior Lab reports what happened during one automated Chromium visit from the configured scanner instance. The visit is otherwise passive (no scrolling, clicking, or consent interaction) except for one bounded step: the keystroke/input-exfiltration probe types a synthetic, non-PII sentinel into form fields present on the loaded page and never submits the form, then watches for that value being sent off-site. It is a lower bound — it covers fields visible after load, not flows behind login, multiple steps, or other frames, and catches real-time/on-blur capture rather than batch-on-unload transmission. GPC comparison mode runs two sequential visits, first without GPC and then with GPC. Shields comparison mode runs one classification-only visit and one Brave Shields block-simulation visit. The simulation uses Brave's own ad-block engine (the open-source [`adblock`](https://github.com/brave/adblock-rust) Rust crate, compiled to WASM) with the `default_enabled` lists from Brave's filter-list catalog. It matches network requests only: it does not apply cosmetic/element-hiding rules or CNAME uncloaking, and the lists are a pinned snapshot, so blocked counts are a close lower-bound approximation of Brave's default Shields rather than a guarantee of identical behavior in a live Brave browser. Differences in either comparison can also reflect timing, experiments, cache state, consent state, or bot detection. Comparisons count as two rate-limit tokens and hold one scan slot until both visits finish. Results are not universal claims about what every visitor will receive. Sites can vary behavior by browser, region, IP reputation, account state, consent state, automation detection, or time.

Shareable reports are stored on the configured filesystem report store with 128-bit random IDs behind a date prefix. Report JSON and permalink reads are rate-limited, and old/excess local reports are pruned by age and count. Persisted reports omit inline screenshots to keep stored JSON and permalink responses smaller; the immediate in-browser scan result can still show the viewport screenshot. A persistent filesystem volume is suitable for single-node deployments; public or horizontally scaled deployments should use durable shared storage.

Static reports under `public/reports/` are different from filesystem share reports: they are committed, public, and retained until removed from git. They are useful for reproducible public evidence and gallery pages, not private or temporary scan results.

The fingerprinting section is an observation layer, not a definitive accusation. API calls such as canvas, WebGL, audio, or WebRTC access can be legitimate. Behavioral heuristics currently cover canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, WebRTC peer-connection setup, and third-party listener coverage; comparison runs are still required before making stronger claims.
