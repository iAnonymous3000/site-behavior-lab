# Site Behavior Lab

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

**See what a site does, not just what it says.**

Site Behavior Lab runs controlled Chromium visits and reports observable site behavior: network requests, third-party domains, curated service labels, cookies, storage keys, screenshot evidence, scan conditions, high-entropy browser API calls, behavioral fingerprinting heuristics, and third-party session/input-monitoring listener signals seen by lightweight instrumentation.

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
- Curated "Start here" gallery on the static site that groups pre-scanned popular sites by category (banking, health, dating, kids, news, shopping, search/social, government) with plain-language headline cards, so a first-time visitor sees real evidence without running a scan. The curated list lives in `public/featured-sites.json`.
- Discoverability and structured data: brand favicon, `robots.txt`, a `sitemap.xml` that lists committed report pages on the static export, sitewide `WebSite`/`SoftwareApplication` JSON-LD, and per-report schema.org `Dataset` JSON-LD (lead finding, scanned site, headline metrics, and a machine-readable download link).
- Accessibility: the signal-colour ramp is tuned to WCAG AA contrast (>=4.5:1 as text, including on its tinted chip backgrounds), and severity is always paired with text and icons so it never relies on colour alone.
- Corpus-relative severity: once enough real sites have been scanned, the findings rank a report against measured percentiles from `public/corpus-stats.json` ("more third-party domains than ~90% of sites scanned so far"); below a minimum sample size they fall back to fixed reference thresholds, so population claims never appear without data to back them.
- Server-rendered, indexable `/directory/` page that lists every committed report with its plain-language headline and key metrics, linked from the gallery and included in `sitemap.xml` for crawlable internal linking.
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
  - screenshot
  - methodology disclosure
  - sanitized JSON export and request-log CSV export

## Acceptable Use

Use Site Behavior Lab for transparency research, journalism, compliance review, debugging your own sites, or inspecting public websites where that activity is allowed. Do not use it for attacking, brute-forcing, crawling at abusive rates, bypassing access controls, or scanning systems you do not own or do not have permission to test.

Operators of public deployments are still responsible for abuse prevention and local legal compliance. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).

## Data Attribution

The tracker/service catalog is a US-biased, hand-curated, in-repo list of high-prevalence third-party services in [lib/tracker-catalog.ts](lib/tracker-catalog.ts), licensed with this repository under AGPL-3.0-or-later. It deliberately bundles no third-party dataset, so there is no separate NonCommercial term to clear before commercial use.

Coverage is intentionally a lower bound: the curated list names recognizable services rather than every tracker. Brave default ad-block lists are vendored separately for Shields would-block and block-simulation signals; those lists do not assign the service/entity labels shown by the curated catalog.

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
| `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS` | unset | Cloudflare Worker only. Set to `1` only for an intentionally open public scanner. It overrides Worker scan-token and Turnstile checks only when the Browser Run DNS risk acceptance flag is also set. |
| `SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK` | unset | Cloudflare Worker only. Must be `1` before unauthenticated Worker scans are enabled, because Browser Run cannot currently pin the browser connection to the DNS answer verified by the Worker. |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE` | `6` | Cloudflare Worker only. Maximum public scan tokens per client per minute. GPC comparisons cost two tokens. |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY` | `120` | Cloudflare Worker only. Maximum public scan tokens per client per day. GPC comparisons cost two tokens. |
| `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS` | unset | Set to `1` only when traffic reaches the app through a trusted proxy that controls forwarding headers and blocks direct origin access. Rate limiting uses in-memory counters per Node process. |
| `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` | `*` | Browser CORS allow-list for the `/api` routes (also honored by the Cloudflare Worker). Default `*` lets any site invoke the scanner from a browser — fine for a single-origin (B1) deployment or an intentionally open scanner. Set it to one origin (for example `https://sitebehavior.org`) to allow only that site's cross-origin browser requests; others are denied. The scan API uses no cookies, so `*` is safe by default. |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` | `this scanner instance` | Describes the scanner's egress location in report disclosures and JSON exports, for example a region, datacenter, or lab network label. |
| `SITE_BEHAVIOR_LAB_ASYNC_SCANS` | unset | Set to `1` to make `/api/scan` return `202 { jobId, statusPath }` and run scans through the single-process in-memory job queue. Clients poll `/api/scans/:id` until the report is ready. Completed async reports are saved under the job ID so the client can recover from a lost status record, but queued/running job state is still in-memory. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` | `.site-behavior-lab/reports` | Filesystem directory for persisted share reports. Use a persistent volume in production. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` | `7` | Maximum age for locally persisted share reports before they are ignored and pruned. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` | `500` | Maximum number of locally persisted share reports to retain on disk. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` | unset | Optional public API base for static builds. When set for a static deployment (such as Cloudflare Pages), the static UI shows a live scan form and sends scans to this Cloudflare Worker/API origin. Do not put secrets in this value. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY` | unset | Build-time public Turnstile site key for the static scan UI. Required when the target Cloudflare Worker is deployed with `TURNSTILE_SECRET_KEY`; the static UI renders the Turnstile widget and sends its token with each scan. Without it, a Turnstile-gated Worker leaves the scan button disabled with an explanation. This is a public site key, not a secret. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` | unset | Canonical public origin — scheme and host only, for example `https://sitebehavior.org` — used as the metadata base so report social cards (Open Graph / X) resolve to absolute image URLs, and as the canonical origin for `robots.txt`, `sitemap.xml`, and JSON-LD URLs. Any GitHub Pages project-page subpath is applied automatically via the base path, so do not include it here. Set this for any public deployment; without it, card image URLs fall back to `http://localhost:3000` and will not unfurl. Do not put secrets in this value. |

Copy `.env.example` for a production-oriented starting point.

## Production Deployment

> **Choosing a topology.** For a public deployment the Node container and the Cloudflare Worker are not equivalent: they sit on opposite sides of the SSRF/DNS-rebinding boundary (the Node scanner pins to a public IP at connect time; the Worker preflight can be rebound). See [docs/deployment-topology.md](docs/deployment-topology.md) for the decision record — recommended path is the Node scanner container behind Cloudflare for edge/WAF/R2.

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

## Corpus Percentiles and Directory

`npm run corpus:stats` (`scripts/build-corpus-stats.mjs`) reads the committed reports under `public/reports/`, keeps one data point per distinct real site (most recent scan wins; reserved/test domains like `example.com` are excluded), and writes percentile distributions of the key behavior metrics to `public/corpus-stats.json`. The Pages build and both scan workflows rebuild it after the report manifest, so the committed stats stay in sync with the corpus.

The findings board uses these percentiles to describe severity in population terms ("more third-party domains than about 90% of the N sites scanned so far"). This only activates once the corpus reaches `CORPUS_MIN_SAMPLE` distinct sites (see `lib/corpus-stats.ts`); below that, the findings keep the fixed reference-threshold wording so the product never makes a percentile claim it cannot back with data.

`/directory/` is a server-rendered, indexable index of every committed report — domain, plain-language headline, and key metrics, linking to the full evidence. It is generated for both the Node app and the static export, listed in `sitemap.xml`, and linked from the public gallery.

The scan workflow prunes committed static reports before updating the manifest. By default it keeps the filesystem report-store policy of 7 days and 500 reports. Override static retention with `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_COUNT`, or use the existing `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` variables as shared fallbacks.

## Cloudflare Worker Deployment

The repo also includes a Cloudflare-native scanner in `cloudflare/worker.ts`. It powers the public static scan form with Cloudflare Browser Run, KV-backed report storage, DNS-over-HTTPS public-address checks, public scan quotas, and GPC comparison support.

One-time Cloudflare setup:

1. Create the KV namespace used by the report store and public scan rate limiter:

```bash
npm run cf:kv:create
```

2. Put the returned namespace id in `wrangler.jsonc` under the `REPORTS_KV` binding.
3. Gated deployments are the default. Keep `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=0` and set a scan token:

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

Site Behavior Lab reports what happened during one automated Chromium visit from the configured scanner instance. GPC comparison mode runs two sequential visits, first without GPC and then with GPC. Shields comparison mode runs one classification-only visit and one Brave Shields block-simulation visit using the vendored Brave default ad-block lists. Differences in either comparison can also reflect timing, experiments, cache state, consent state, or bot detection. Comparisons count as two rate-limit tokens and hold one scan slot until both visits finish. Results are not universal claims about what every visitor will receive. Sites can vary behavior by browser, region, IP reputation, account state, consent state, automation detection, or time.

Shareable reports are stored on the configured filesystem report store with 128-bit random IDs behind a date prefix. Report JSON and permalink reads are rate-limited, and old/excess local reports are pruned by age and count. Persisted reports omit inline screenshots to keep stored JSON and permalink responses smaller; the immediate in-browser scan result can still show the viewport screenshot. A persistent filesystem volume is suitable for single-node deployments; public or horizontally scaled deployments should use durable shared storage.

Static reports under `public/reports/` are different from filesystem share reports: they are committed, public, and retained until removed from git. They are useful for reproducible public evidence and gallery pages, not private or temporary scan results.

The fingerprinting section is an observation layer, not a definitive accusation. API calls such as canvas, WebGL, audio, or WebRTC access can be legitimate. Behavioral heuristics currently cover canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, WebRTC peer-connection setup, and third-party listener coverage; comparison runs are still required before making stronger claims.
