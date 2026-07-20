# Site Behavior Lab

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

**See what a site does, not just what it says.**

Site Behavior Lab runs controlled Chromium visits and reports observable site behavior: network requests, third-party domains, curated service labels, cookies, storage keys, screenshot evidence, scan conditions, high-entropy browser API calls, behavioral fingerprinting heuristics, third-party session/input-monitoring listener signals, an active keystroke/input-capture probe, DNS-based CNAME-uncloaking of disguised trackers, consent-banner (pre-consent tracking) detection, advertising-pixel event decoding (the events Meta/TikTok/X pixels fire, and whether their personal-identifier fields were populated; each value is checked only transiently for being non-empty and is never stored, decoded, or reported, so identifier delivery is not asserted), and a privacy-policy cross-check (the site's own policy text compared against the observed evidence).

> **Deployment status.** The public site at [https://sitebehavior.org](https://sitebehavior.org) is the static **Cloudflare Pages** front door. Its **live scanner is the full Node/Playwright scanner, including the Brave-list block simulation (the tried-vs-blocked diff with Brave's engine and default Shields lists in the scanner's browser, not a live Brave visit)**, deployed on **Cloudflare Containers** at `scan.sitebehavior.org` with R2-backed report storage and open behind Cloudflare Turnstile plus atomic per-client rate limiting. On 2026-07-13 the promoted build `003060abfba64ace4ede56453e979df851678f0a` enabled public r2 reports and consent verification; its authenticated scan/save/read smoke passed before the operator lock was removed, and the final public health posture was verified after unlock. Pages serves the r2 schema alias, fresh r2 corpus reports cover GPC, Shields, and consent, and the Brave-list refresh rerun succeeded. Shared report links resolve to the scanner origin, which also redirects its own root back to the front door. The lighter **Browser Run Worker** is retired as a public deployment: its config now defaults to gated with no `workers.dev` alias, because its preflight-only DNS check cannot pin the browser's eventual connection the way the Containers scanner does. See the front-Worker gate in [cloudflare/container-worker.ts](cloudflare/container-worker.ts), the go-live sequence in [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md), the container build in [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md), and the topology decision in [docs/deployment-topology.md](docs/deployment-topology.md).

> **Durable execution status.** Restart-safe queued/running execution is an opt-in Cloudflare Containers path behind `SITE_BEHAVIOR_LAB_DURABLE_JOBS=1`. The committed deployment configuration keeps that flag at `0`: production continues to use the current in-process queue plus the IDs-only restart-recovery registry until the encryption key and private coordinator channel are configured, the privacy disclosure is live, and the no-polling lease-expiry recovery gate passes. Enabling the flag without every prerequisite fails closed rather than falling back silently.

> **Scheduled-rescan status.** Accountless encrypted watches are a separate post-durability feature behind `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=1`, also committed at `0`. They run one immediate single-mode scan and then attempt an independent scan at a fixed seven-day cadence, with a 30-day/five-attempt cap, capability-only control, Worker-only encryption, and fresh target validation on every attempt. They are scheduled rescans, not change alerts; see [docs/encrypted-watches.md](docs/encrypted-watches.md).

## Why It Is Different

Site Behavior Lab is built for reproducible, inspectable evidence instead of opaque scoring. Each report records the scan conditions that affect results, including browser version, viewport, timezone, locale, Global Privacy Control state, scanner egress, tracker catalog version, and scanner disclosure text.

The project is open source under the [AGPL-3.0-or-later](LICENSE) so anyone can inspect the scanner, URL-safety checks, catalog labels, and report UI behind the results.

## Current Capabilities

- Next.js app with a server-side Playwright scanner.
- Public URL input with desktop/mobile viewport selection.
- Optional Global Privacy Control signal, plus off/on GPC, Shields, and consent (accept-all vs reject-all) comparison modes in the Node scanner.
- SSRF guard that blocks localhost, private networks, link-local addresses, and reserved test ranges, with the Node scanner routing Chromium through a connect-time public-address proxy.
- Basic server-side guardrails: request body limit, per-client scan and report-read rate limits, scan concurrency cap, scan duration cap, per-scan request cap, and shared Chromium reuse.
- Optional scan access key enforcement for public or gated deployments.
- Report URLs omit credentials and fragments. First-party URLs omit query strings; third-party request logs keep only reviewed, exact query-key literals and always discard values. Unknown keys, path segments, subdomain labels, cookie names, and storage keys are generalized before a report crosses a public or persistent boundary.
- Stable report permalinks (date-prefixed random IDs) and JSON endpoints under `/reports/:id` and `/api/reports/:id`. Runtime-saved reports are retained for a configurable window (7 days / 500 reports by default, then pruned); reports committed under `public/reports/` are permanent.
- Runtime health/readiness metadata under `/api/health`.
- Static export (deployed on Cloudflare Pages) for the report viewer, generated report gallery, saved-report comparisons, and committed report JSON under `public/reports/`.
- Plain-language headline at the top of every report, plus per-report Open Graph / X (`summary_large_image`) share cards and link metadata generated from that headline, so a shared report link unfurls with the site name, the lead finding, and key counts in both the Node app and the static export.
- Curated "Start here" gallery on the static site that groups pre-scanned popular sites by category (banking & money, health, dating, kids & education, news & media, shopping, search & social, and government) with plain-language headline cards, so a first-time visitor sees real evidence without running a scan. The curated list lives in `public/featured-sites.json`.
- Discoverability and structured data: brand favicon, `robots.txt`, a `sitemap.xml` that lists committed report pages on the static export, sitewide `WebSite`/`SoftwareApplication` JSON-LD, and per-report schema.org `Dataset` JSON-LD (lead finding, scanned site, headline metrics, and a machine-readable download link).
- Accessibility: the signal-colour ramp is tuned to WCAG AA contrast (>=4.5:1 as text, including on its tinted chip backgrounds), and severity is always paired with text and icons so it never relies on colour alone.
- Corpus-relative severity: once enough real sites have been scanned, the findings compare a report with measured percentile marks from `public/corpus-stats.json` ("at or above the 90th-percentile mark for sites scanned so far"); below a minimum sample size they fall back to fixed reference thresholds, so population claims never appear without data to back them. The mark-anchored wording remains correct when multiple sites tie at the threshold.
- Server-rendered, indexable `/directory/` page that lists every committed report with its plain-language headline and key metrics, linked from the gallery and included in `sitemap.xml` for crawlable internal linking.
- Per-site history pages under `/sites/<registrable-domain>/` for every corpus site: the latest controlled visit, observed differences across comparable visits (only within the same versioned measurement/condition cohort; capped or failed visits never pair), a history sparkline over the timeline's own numbers, and the full evidence timeline, linked from the directory rows. Each site also publishes an Atom feed at `/sites/<registrable-domain>/feed.xml` (autodiscoverable from the history page) so new corpus reports for a site can be watched from any feed reader.
- On-site `/methodology/` page describing the measurement in plain language: what the automated visit does, the two bounded interactions, how comparisons are paired and gated, what the Brave-list blocking simulation means, redaction at publication, and how the corpus percentiles are built.
- Transparency-index hero that leads the static homepage with measured corpus highlights (how many real sites have been scanned and the median catalogued tracker-request count per site for the top categories), linking straight into `/directory/` and the report library, so the landing view is evidence rather than a pitch.
- Paired GraphML + sidecar [PageGraph r2 importer](docs/pagegraph-adapter.md) with strict request-only provenance, explicit unsupported-family availability, and a sanitized real Brave Nightly fixture; tolerant v1 adapter helpers remain legacy/internal compatibility utilities.
- PageGraph corpus Phase 0 (`npm run corpus:pagegraph`): GraphML in, DuckDB-queryable fact tables out, with a filter-rule impact simulator that computes downstream removal as a transitive closure over the causal graph. See the [proposal](docs/pagegraph-corpus-db-proposal.md) and the [Phase 0 spike](docs/pagegraph-corpus-phase0.md).
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
  - CNAME-uncloaked trackers: first-party subdomains whose DNS CNAME chain resolves to a known tracking service, which request-URL matching alone would miss
  - consent-tooling (CMP) detection that surfaces tracking companies that loaded before the scanner made any consent choice; a CMP loader does not prove a banner was shown or establish consent requirements or legal compliance
  - consent comparison (Node scanner): two paired visits, one clicking the banner's "Accept all" and one clicking "Reject all" (known CMP controls first, then a conservative whole-label text match; first banner layer only), diffed to show what differed between the two visits and which tracking companies still appeared in the Reject-all visit. Legacy v1 reports record click dispatch only; r2 reports also record bounded TCF/OneTrust readbacks and state whether registration was verified or contradicted, only a weak banner-transition signal was seen, or verification was unavailable or failed. Even verified r2 request evidence spans before and after the click, so traffic can be pre-choice, strictly necessary, or processing claimed under legitimate interest. When no control can be clicked, the run is disclosed as pre-consent and no claim is made
  - advertising-pixel event decoding for Meta, TikTok, and X: the events each pixel fired (PageView, Purchase, ...; standard vocabulary names are stored verbatim, site-defined names are generalized to "custom event") and whether its advanced-matching identifier fields were populated, detected by checking that a known identifier parameter carries a non-empty value, so the identifier category is reported while the value itself is inspected only transiently in memory and never persisted, exposed, semantically interpreted, or hash-validated (the platforms document the values as hashed; that is not verified). On Shields comparison reports the diff also names which pixel events blocking removed
  - privacy-policy cross-check (Node scanner): the scanner discovers the site's privacy-policy link, reads the policy through the same SSRF-guarded browser context, and compares its text against the visit's evidence. It flags contradictions of checkable statements (a "we do not use third-party cookies" claim against observed third-party cookies, a blanket "we do not use cookies" claim against observed cookies, a "we do not sell personal information" claim against advertising pixels that carried personal-identifier fields; Global Privacy Control claims are never judged from request counts, which cannot show whether data sales stopped) and lists observed tracking companies the policy never names. Every match quotes the policy sentence so it can be verified in context; it is an automated text match, not a legal reading
  - screenshot
  - methodology disclosure
  - sanitized JSON export and request-log CSV export

## Acceptable Use

Use Site Behavior Lab for transparency research, journalism, compliance review, debugging your own sites, or inspecting public websites where that activity is allowed. Do not use it for attacking, brute-forcing, crawling at abusive rates, bypassing access controls, or scanning systems you do not own or do not have permission to test.

The visit is passive except for two bounded interactions. First, an **active input probe**: the Node/Playwright scanner types a synthetic, non-PII test value into up to a handful of *visible* form fields to test for keystroke/input capture. It **never submits the form, never presses Enter, and never enters real data**, the typed value is synthetic and is not stored, and every report discloses how many fields were typed into. Second, in **consent comparison mode only**, the scanner clicks a single accept-all or reject-all control on the page's cookie/consent banner (first layer only, recognized CMP controls or an exact accept/reject label), and every such run discloses exactly what was clicked or that nothing was. Both interactions' requests still pass through the scanner's SSRF/public-address guard. Operators running an open deployment should be aware their scanner performs these bounded interactions on scanned sites at a visitor's request.

With optional durable execution, an attempt whose execution, publication, or status coordination was lost may be abandoned and retried once under a fenced two-attempt lease. The target can therefore receive an extra automated visit that was partial or that completed before its result was lost. The report still contains one completed attempt per condition and never merges evidence from separate attempts; if a complete R2 report already exists, recovery reconciles that exact stored report instead of visiting again.

Operators of public deployments are still responsible for abuse prevention and local legal compliance. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).

## Data Attribution

The tracker/service catalog is a US-biased, hand-curated, in-repo list of high-prevalence third-party services in [lib/tracker-catalog.ts](lib/tracker-catalog.ts), licensed with this repository under AGPL-3.0-or-later. It deliberately bundles no third-party dataset, so there is no separate NonCommercial term to clear before commercial use.

Coverage is intentionally a lower bound: the curated list names recognizable services rather than every tracker. The Shields filter-list-match and block-simulation signals are computed separately, with Brave's own ad-block engine (the [`adblock`](https://github.com/brave/adblock-rust) Rust crate compiled to WASM, built from `tools/adblock-wasm/`) over Brave's default filter lists, vendored as a pinned snapshot; those lists do not assign the service/entity labels shown by the curated catalog.

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
| `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS` | unset | Cloudflare Workers only (Browser Run and Containers). Set to `1` only for an intentionally open public scanner, with no scan token set. On the Browser Run worker it also requires the DNS-rebinding risk flag below; the Containers scanner pins DNS at connect time, so it does not. The Containers front Worker still enforces Turnstile (when configured) and an atomic Durable Object quota. See [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md). |
| `SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK` | unset | Browser Run worker only. Must be `1` before unauthenticated Browser Run scans are enabled, because Browser Run cannot currently pin the browser connection to the DNS answer verified by the Worker. Not used by the Containers scanner. |
| `SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK` | unset | Containers front Worker only. Open public scans fail closed with `503` when no `TURNSTILE_SECRET_KEY` is configured. Set to `1` only to consciously waive human verification and run an open scanner on atomic rate limiting alone. See [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md). |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE` | `6` | Cloudflare Workers only. Maximum public scan tokens per client per minute. GPC, Shields, and consent comparisons cost two tokens. The Containers front Worker accounts atomically in the scanner Durable Object's SQLite storage; the retired Browser Run worker uses `REPORTS_KV`. |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY` | `120` | Cloudflare Workers only. Maximum public scan tokens per client per day. GPC, Shields, and consent comparisons cost two tokens. |
| `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS` | unset | Set to `1` only when traffic reaches the app through a trusted proxy that controls forwarding headers and blocks direct origin access. Rate limiting uses in-memory counters per Node process. |
| `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` | `*` | Browser CORS allow-list for the `/api` routes (also honored by the Cloudflare Worker). Default `*` lets any site invoke the scanner from a browser, fine for a single-origin (B1) deployment or an intentionally open scanner. Set it to one origin (for example `https://sitebehavior.org`) to allow only that site's cross-origin browser requests; others are denied. The scan API uses no cookies, so `*` is safe by default. |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` | `this scanner instance` | Describes the scanner's egress location in report disclosures and JSON exports, for example a region, datacenter, or lab network label. |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION` | unset | Node scanner only. Recorded egress region for ScanReport v2/r2 (`conditions.egress.region`). Unset, the scanner falls back only when Cloudflare Containers supplies the complete `CLOUDFLARE_REGION`/`CLOUDFLARE_LOCATION`/`CLOUDFLARE_COUNTRY_A2` placement tuple; a partial tuple is a health misconfiguration. With neither source the region stays unrecorded, and r2 comparison deltas are refused because an unrecorded condition never counts as matching across two visits. Declare it only when it truthfully names where scan traffic leaves from. |
| `SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX` | unset | Set to `1` to launch scan Chromium with its sandbox enabled. Opt-in because the sandbox needs kernel features (unprivileged user namespaces or a setuid helper) that a container platform may not provide, and a failed launch breaks every scan; verify one deployed scan succeeds before leaving it on. The container process runs as a non-root user either way, and WebRTC egress is disabled at launch (`disable_non_proxied_udp`) so no scan traffic can bypass the connect-time public-address guard. |
| `SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION` | unset | Node scanner only. Set to `1` to read back the site's registered consent state after a dispatched banner click (TCF `__tcfapi` and OneTrust consent-cookie interpreters, plus banner-visibility observations) and to attempt one disclosed post-choice page reload that re-reads the registered state; requests observed during the reload's measurement phase are excluded from the recorded request log and counts. The readback is recorded in r2 reports; a legacy v1 fallback response records only its compatible disclosure warning. |
| `SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS` | unset | Node scanner only. Exact fail-closed gate for returning and persisting ScanReport v2/r2 from the live API and async jobs. Unset or `0` selects the legacy v1 compatibility response plus independently controlled shadow behavior. `1` requires `SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION=1`, a full 40-character `SITE_BEHAVIOR_LAB_BUILD_COMMIT`, and an available report store; any invalid/incomplete configuration refuses scans instead of silently falling back to v1. `/api/health` exposes the effective state at `checks.publicR2Reports.status` and sets `scansAvailable: false` when the requested producer is not ready. Immediate sync/job responses retain their ephemeral screenshots; saved shares contain only the named-field public projection. |
| `SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION` | unset | Node scanner only. Set to `1` to additionally build ScanReport v2/r2 public wires (redacted, screenshots stripped): one single artifact for a single scan, or one complete pair artifact for a comparison. Comparison axis, semantic arms, execution order, verification, comparability, and diff are derived from the two visits' staged facts; partial per-arm files are never written. Shadow output remains operator-only, successful writes log only closed artifact metadata, and a failed shadow build/store is a diagnostic, never a failed primary scan. Requires `SITE_BEHAVIOR_LAB_BUILD_COMMIT`; observe-mode visits also need the consent-verification flag so the always-on banner detector records a real outcome. |
| `SITE_BEHAVIOR_LAB_V2_SHADOW_BACKEND` | `filesystem` | Node scanner only. `filesystem` uses the local shadow directory. `r2` reuses the configured R2 bucket credentials but writes create-only objects under the operator-only, build-pinned `v2-shadow/<build>/<single\|comparison>/` prefix, disjoint from public `reports/`. Cloudflare Containers fixes this to `r2`; no scanner read/list endpoint exposes the objects. The prefix is not an ACL: before enabling it, require the bucket's `r2.dev` URL disabled and every custom domain absent or Access-protected, as detailed in the [Containers runbook](docs/deploy-cloudflare-containers.md#8-verify-private-v2r2-shadows-before-the-schema-alias-flip). |
| `SITE_BEHAVIOR_LAB_V2_SHADOW_DIR` | `.site-behavior-lab/v2-shadow` | Filesystem shadow backend only. Container disk is ephemeral, so deployed verification uses the R2 backend. |
| `SITE_BEHAVIOR_LAB_ASYNC_SCANS` | unset | Set to `1` to make `/api/scan` return `202 { jobId, statusPath, reportId }`. With durable jobs off, scans use the current single-process in-memory queue; the Containers front Worker retains only TTL-bounded ID linkage for completed-report recovery. Clients poll `/api/scans/:jobId`, and `DELETE` cooperatively cancels work until publication begins. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS` | `0` | Cloudflare Containers only. `1` replaces the in-memory admission source of truth with the restart-safe Durable Object queue. The encrypted payload, execution row, and request-independent drain schedule must commit before the Worker returns `202`; claims are oldest-first, fenced, and limited to two attempts. Requires async scans, R2/public-r2 persistence, the key and internal-token secrets below, the coordinator URL, the privacy disclosure, and a live no-polling lease-expiry recovery test. Missing or invalid prerequisites fail closed. The committed deployment config intentionally remains `0` until that gate is complete. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY` | unset | **Worker-only secret.** Canonical base64url encoding of exactly 32 random bytes, used for application-level AES-256-GCM encryption of the active job payload. Never expose it to the browser or forward it into the Node container. Rotation requires draining the 75-minute active-job window unless both key versions are explicitly supported. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN` | unset | **Separate Worker-to-Node secret**, forwarded only to the container to authenticate private prepare/execute/heartbeat/publication/reconciliation callbacks. Do not reuse the public scan access token, Turnstile secret, R2 credentials, or encryption key. Public requests must never be able to supply or reach the trusted internal channel. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL` | unset | Non-secret canonical scanner origin used by the Node runner for callbacks to the Durable Object coordinator. Required only when durable jobs are enabled; use the fixed HTTPS scanner origin, with no path, query, credentials, or fragment. |
| `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES` | `0` | Cloudflare Containers only. Independent post-durability gate for encrypted scheduled rescans. `1` requires access-token-gated scanner ingress, durable jobs to be fully ready, an isolated Worker-only watch key, the published disclosure, and a gated create/run/read/delete canary. Open public ingress makes only this optional capability misconfigured and refuses creation; ordinary scans remain available. Metadata read/delete remains rollback-safe. |
| `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY` | unset | **Worker-only secret.** Current canonical base64url encoding of exactly 32 random bytes for AES-256-GCM watch target/options encryption. It must not alias any durable-job, coordinator, scan, Turnstile, or R2 secret and is never forwarded into Node. |
| `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY` | unset | **Optional Worker-only rotation secret.** The immediately previous 32-byte watch key may decrypt retained envelopes while every new write uses the current key. Keep it for the maximum 30-day watch TTL (or delete all old-key watches), then remove it. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND` | `filesystem` | Backend for persisted share reports: `filesystem` (default) or `r2`. The `filesystem` backend needs a persistent volume to survive restarts; `r2` stores reports in Cloudflare R2 (S3-compatible) so share links survive container redeploys and host replacement, and is what multi-node hosting needs. The report-store policy (share IDs, screenshot stripping, validation, expiry, prune counts) is identical across backends. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` | `.site-behavior-lab/reports` | Filesystem backend only. Directory for persisted share reports. Use a persistent volume in production. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` | `7` | Maximum age for persisted share reports before they are ignored and pruned. Durable jobs require this effective age policy to retain reports for at least 75 minutes. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` | `500` | Target maximum number of persisted share reports. Newly published shares receive the short survival window below before count pruning can evict them, so a burst may exceed the target temporarily. |
| `SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS` | `60000` | Minimum time (capped at two hours) a newly committed share survives count pruning, preventing a successful concurrent save from returning an already-dead link. Durable jobs fail closed unless the effective value is at least `4500000` (75 minutes). Age expiry still wins. |
| `SITE_BEHAVIOR_LAB_R2_BUCKET` | `site-behavior-lab-reports` | R2 backend only. Name of the R2 bucket that holds report JSON. |
| `SITE_BEHAVIOR_LAB_R2_ENDPOINT` | unset | R2 backend only. S3-compatible endpoint, for example `https://<accountid>.r2.cloudflarestorage.com`. Required when the public report store or v2 shadow backend is `r2`. |
| `SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID` / `SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY` | unset | R2 backend only. Credentials for an R2 API token scoped to the reports bucket (Object Read & Write). Required when the public report store or v2 shadow backend is `r2`. These are secrets. |
| `SITE_BEHAVIOR_LAB_R2_PREFIX` | `reports/` | R2 backend only. Key prefix under which report objects are stored. |
| `SITE_BEHAVIOR_LAB_R2_REQUEST_TIMEOUT_MS` | `10000` | R2 backend only. Per-attempt S3 request deadline, capped at two minutes. Retry policy remains bounded separately. |
| `SITE_BEHAVIOR_LAB_DNS_RESOLVER_URL` | `https://cloudflare-dns.com/dns-query` | Cloudflare Worker only. DNS-over-HTTPS resolver used for the Worker's public-address preflight checks. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` | unset | Optional public API base for static builds. When set for a static deployment (such as Cloudflare Pages), the static UI shows a live scan form and sends scans to this Cloudflare Worker/API origin. Do not put secrets in this value. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY` | unset | Build-time public Turnstile site key for the static scan UI. Required when the target Cloudflare Worker is deployed with `TURNSTILE_SECRET_KEY`; the static UI renders the Turnstile widget and sends its token with each scan. Without it, a Turnstile-gated Worker leaves the scan button disabled with an explanation. This is a public site key, not a secret. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS` | unset | Build-time hint for static builds. Set to `1` only when the target scan API is an intentionally open public scanner, so the static UI hides the access-key field immediately instead of waiting on `/api/health`. The UI also infers open access from the live health response, so this only affects first paint. This is a public flag, not a secret. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` | unset | Canonical public origin (scheme and host only, for example `https://sitebehavior.org`) used as the metadata base so report social cards (Open Graph / X) resolve to absolute image URLs, and as the canonical origin for `robots.txt`, `sitemap.xml`, and JSON-LD URLs. Any GitHub Pages project-page subpath is applied automatically via the base path, so do not include it here. Set this for any public deployment; without it, card image URLs fall back to `http://localhost:3000` and will not unfurl. Do not put secrets in this value. |

Copy `.env.example` for a production-oriented starting point.

Validate downloaded shadow artifacts with the same structural and semantic reader used by the app:

```bash
npm run reports:verify-v2-shadow -- \
  --expected-build "$(git rev-parse HEAD)" \
  --dir .site-behavior-lab/v2-shadow
```

The verifier accepts only public v2/r2 artifacts from the expected full build SHA, binds filenames to run/pair IDs, and summarizes comparison axes, AB/BA order, eligibility, verification, and arm outcomes without printing subjects or evidence.

## Architecture

![Site Behavior Lab architecture: a visitor loads the static Cloudflare Pages UI and submits a scan to the Front Worker (Turnstile and rate limits), which forwards to the Node and Playwright container scanner. The scanner reaches the target site only over public HTTP(S) on standard ports through an SSRF egress proxy that pins a public IP at connect time, records its detections, and writes durable saved reports to R2. CI reuses the Node producer, the paired PageGraph importer emits request-only r2, and the retired Browser Run Worker remains a legacy v1 self-host path.](docs/architecture.svg)

The Cloudflare Pages site is the static front door; live scans run on the Node/Playwright container behind a Turnstile/rate-limit Worker, reach the public web only through a connect-time SSRF proxy, and persist to R2. CI reuses that Node r2 producer. Paired PageGraph uploads emit request-only r2 reports locally, while the retired Browser Run Worker remains a gated legacy-v1 self-host path. See [docs/deployment-topology.md](docs/deployment-topology.md) for the decision record.

## Production Deployment

> **Choosing a topology.** For a public deployment the Node container and the Cloudflare Worker are not equivalent: they sit on opposite sides of the SSRF/DNS-rebinding boundary (the Node scanner pins to a public IP at connect time; the Worker preflight can be rebound). See [docs/deployment-topology.md](docs/deployment-topology.md) for the decision record. The recommended path is the Node scanner container behind Cloudflare for edge/WAF/R2. **That path now ships on Cloudflare Containers** (open to the public behind Turnstile and rate limits, R2-backed; see [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md)); the generic single-node steps below remain the runbook for any other host. The static Pages site remains the public front door, pointed at the container scanner. The GPC/trackers Worker (under "Cloudflare Worker Deployment") is retired as a public deployment; its config defaults to gated for self-hosters.

**CI-gated deployment.** Production (Cloudflare Pages and the scanner's Workers Builds) tracks the **`production`** branch, never `main`. After both CI jobs pass, CI fast-forwards `production` to the exact SHA it tested; `.github/workflows/promote-production.yml` provides an idempotent fallback for ordinary push/user-dispatched runs. Both paths share the same serialized, fast-forward-only checks: they never force-push, skip out-of-order completions, and hard-fail on a tested SHA no longer reachable from `main`. CI promotes directly because workflow runs dispatched by repo-writing workflows with `GITHUB_TOKEN` do not reliably cascade into a third `workflow_run`. Set the repository variable `SITE_BEHAVIOR_LAB_PROMOTION_PAUSED=1` to hold production during an incident, then clear it and rerun CI to resume. Operator setup, once: point the Cloudflare Pages project's production branch and the scanner's Workers Builds branch at `production`, and disable non-production builds on both.

For a single-node deployment:

1. Set `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` unless the scanner is intentionally public and protected by stronger external controls.
2. Set `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` to a persistent volume, and tune report age/count retention.
3. Set `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` to the region/network label users should see in report methodology.
4. Put the app behind a trusted HTTPS reverse proxy. Set `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS=1` only when direct origin access is blocked.
5. Run `/api/health` from your load balancer or monitor and alert when `status` is `degraded`; the Node health response includes Brave ad-block engine load status under `checks.adblock`. For the reference deployment, `.github/workflows/production-health.yml` polls the live scanner's `/api/health` every 15 minutes and fails on availability or security-posture regressions (Turnstile off, sandbox off, wrong report store, missing rate limits).
6. Enforce egress firewall rules at the host/container/VPC layer so Chromium cannot reach localhost, private, link-local, metadata, or other internal networks even if an application bug is found. The Node scanner routes Chromium through a per-scan local proxy that resolves, validates, pins, and connects to public IP addresses at connection time; the external firewall remains the required defense-in-depth boundary for public deployments.

Docker:

```bash
docker build --build-arg SITE_BEHAVIOR_LAB_BUILD_COMMIT="$(git rev-parse HEAD)" -t site-behavior-lab .
docker run --rm -p 3000:3000 \
  --env-file .env.production \
  -v site-behavior-lab-reports:/var/lib/site-behavior-lab/reports \
  site-behavior-lab
```

Validate the container path end to end with:

```bash
npm run test:smoke:docker
```

Horizontally scaled deployments need shared durable report storage and queue authority. With `SITE_BEHAVIOR_LAB_DURABLE_JOBS=0`, the Cloudflare Containers front Worker accounts public quotas atomically and keeps an IDs-only recovery registry, but queued/running execution remains process-local and is not replayed after restart. The opt-in Phase-2 path moves admission and execution state into the same singleton Durable Object, uses its persistent schedule for request-independent liveness, and reconciles publication against R2. After durable jobs are proven live, the separately gated `SITE_BEHAVIOR_LAB_CONTAINER_SHARDING=1` path may distribute only fenced durable execution across the configured bounded shard count; ordinary/Phase-1 traffic remains on the singleton. The independent encrypted-watch gate reuses the authoritative coordinator schedule but admits each due run as an ordinary durable job. All three rollout gates remain off in the committed production configuration.

For the exact flag-off and Phase-2 contracts, see [docs/scan-job-model.md](docs/scan-job-model.md).

## Static Hosting (Cloudflare Pages)

Production runs as a static export on Cloudflare Pages at https://sitebehavior.org; any static host can serve the same artifact (GitHub Pages also works). Static hosting serves the static interface, generated report gallery, and client-side report viewer. It cannot run the Node/Playwright scanner, `/api/scan`, `/api/health`, or filesystem-backed report reads. The Pages build strips API routes, generates `public/reports/index.json` from committed report JSON, and pre-renders `/reports/:id/` pages for every `public/reports/:id.json` file present at build time.

Static report JSON files are public artifacts. Treat them as intentionally published evidence, not private scan storage.

The Pages artifact embeds its exact source commit and therefore builds only
from a clean Git checkout whose declared CI commit matches `HEAD`. Use the
ordinary `npm run build` while iterating on uncommitted changes; validate the
static artifact from a clean review branch or disposable committed worktree.

Build the static artifact locally:

```bash
npm run build:pages
```

The static site is written to `out/` with a `.nojekyll` marker. The build automatically infers a project-page base path from `GITHUB_REPOSITORY` in GitHub Actions, for example `/site-behavior-lab`. For a user/org Pages site or custom domain hosted at the domain root, set:

```bash
SITE_BEHAVIOR_LAB_PAGES_BASE_PATH=/
```

Cloudflare Pages builds and deploys `out/` from the **`production` branch** via its Git integration: in the Pages project set the production branch to `production`, the build command to `npm run build:pages` and the output directory to `out`, with production env vars `SITE_BEHAVIOR_LAB_PAGES_BASE_PATH=/`, `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://sitebehavior.org`, and `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` pointed at the scan API. `production` is the CI-gated promotion branch (see "CI-gated deployment" above): only the exact `main` SHA a successful CI run tested ever reaches it, so a red revision cannot publish. Any other static host can serve the same `out/` directory.

A static export cannot send the server security headers configured for the Node deployment, so the build ships [`public/_headers`](public/_headers) into `out/`: Cloudflare Pages serves its CSP, HSTS, frame, and Permissions-Policy set automatically. The CSP names this deployment's scan origin (`scan.sitebehavior.org`) in `connect-src`; self-hosts pointing the static UI at a different scan API must add their origin there. Hosts that ignore `_headers` (plain static servers, GitHub Pages) need the equivalent headers configured at the CDN/host layer.

## CI as Scanner

The `.github/workflows/scan.yml` workflow is the zero-server scan path. It runs the built app inside GitHub Actions, calls the same `/api/scan` endpoint as the live product, writes a screenshot-stripped static report to `public/reports/<id>.json`, rebuilds `public/reports/index.json`, uploads the JSON artifact, and commits the report back to the repository. The workflow then dispatches CI on the new commit (its own push uses `GITHUB_TOKEN`, which never fires `on: push` workflows), and once both CI jobs pass, that CI run advances the `production` branch, which triggers Cloudflare Pages to rebuild and republish the updated static gallery.

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

Filter and tune with `FEATURED_CATEGORIES` (comma-separated category ids), `FEATURED_LIMIT`, `FEATURED_COMPARE_SHIELDS` (the Shields off/on comparison; takes precedence over the other modes), `FEATURED_COMPARE_CONSENT` (the consent accept/reject comparison; takes precedence over GPC), `FEATURED_COMPARE_GPC` (default `true`, the GPC off/on comparison), `FEATURED_DEVICE`, and `FEATURED_DELAY_MS`. Edit the catalog in `public/featured-sites.json`, then re-run the scan to refresh the gallery.

> **Preview a corpus run before publishing.** The workflow commits and pushes the new reports to the branch it runs on, so dispatch it from a non-production branch (in **Actions > Scan Featured Sites**, choose the branch under "Use workflow from") to stage the corpus there instead of `main`. With non-production Pages builds disabled (the CI-gated deployment posture), review the staged branch locally (`npm run build:pages` on that branch), check the gallery, `/directory/`, and whether the corpus cleared `CORPUS_MIN_SAMPLE` (the run's job summary reports the report and distinct-site counts), then merge into `main`; CI runs on the merge and promotion publishes it. Running it directly on `main` publishes after that commit's CI passes.

## Corpus Percentiles and Directory

`npm run corpus:stats` (`scripts/build-corpus-stats.mjs`) reads the committed reports under `public/reports/`, keeps one data point per distinct real site (most recent scan wins; reserved/test domains like `example.com` are excluded), and writes percentile distributions of the key behavior metrics to `public/corpus-stats.json`. The Pages build and both scan workflows rebuild it after the report manifest, so the committed stats stay in sync with the corpus.

The findings board uses these percentiles to describe severity in relative terms ("at or above the 90th-percentile mark for the N sites scanned so far"). This only activates once the corpus reaches `CORPUS_MIN_SAMPLE` distinct sites (see `lib/corpus-stats.ts`); below that, the findings keep the fixed reference-threshold wording so the product never makes a percentile claim it cannot back with data. Anchoring the sentence to the measured threshold, rather than claiming a strict fraction below the current site, keeps it accurate when values tie.

These percentiles compare a site with the scanned corpus, **not a random sample of the web**. The corpus is seeded from the curated featured catalog (popular, mostly commercial sites chosen for their tracker prevalence), so reaching a high percentile mark means heavy even among popular sites, and a value below that mark only means lighter than that set, not light in absolute terms. The sample is also small (tens of sites at launch), so tail percentile marks (p90/p95) are approximate; the wording says "at or above" and "so far", and the bottom-line finding states the comparison set explicitly.

To reduce that popular-commercial skew, scan the **corpus de-bias seed list** in `public/corpus-seed-sites.json`, a broader, lighter mix (open source, nonprofit, education, reference, international government, community/personal) kept separate from the gallery. Run **Actions > Scan Featured Sites** with the `sites_file` input set to `public/corpus-seed-sites.json`, or locally:

```bash
FEATURED_SITES_FILE=public/corpus-seed-sites.json BASE_URL=http://127.0.0.1:3100 npm run scan:featured
```

Those scans populate `public/reports/`, the corpus stats, and `/directory/`, but **not** the curated "Start here" gallery (which only matches `public/featured-sites.json`). It is a curated-diverse list, not a random sample, so it widens the distribution without claiming to represent the whole web.

`/directory/` is a server-rendered, indexable index of every committed report: domain, plain-language headline, and key metrics, linking to the full evidence. It is generated for both the Node app and the static export, listed in `sitemap.xml`, and linked from the public gallery.

The scan workflow prunes committed static reports before updating the manifest. By default it keeps reports for 7 days up to a hard ceiling of 1,000 committed reports, except that the newest two reports in each exact site, kind, subject, and versioned measurement/condition cohort are exempt from age pruning (tune with `SITE_BEHAVIOR_LAB_STATIC_REPORT_KEEP_PER_SITE`; 0 restores pure age pruning). Unknown or generalized legacy identities never match one another, but the newest report for each broad site/kind remains as a disappearance guard. The directory shows "changed since last scan" only for the same exact identity; retention alone never makes two reports comparable. Override static retention with `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_COUNT`, or use the existing `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` variables as shared fallbacks.

The featured-scan workflow also runs on a weekly schedule (Mondays 05:23 UTC) with its default inputs (Shields comparisons over the featured catalog), so the corpus refreshes itself. On `/directory/`, a site's newest report shows what changed only when a previous successful, uncapped report has the same kind and requested/final subject and a compatible schema revision, methodology, browser environment, device/viewport, intervention state, filter snapshot, and tracker catalog. Unknown or generalized v1 subjects fail closed. These deltas are observed differences between two automated visits, which can also reflect ad rotation, experiments, caching, or bot detection, and the UI says so.

## Researcher Export

`/corpus.json` and `/corpus.csv` export the committed corpus with one row per published report: domain, category, absolute report and JSON URLs, scan date, report kind (Shields / consent / GPC / single), device, GPC and consent mode of the lead run, consent-click dispatch plus the evaluator-derived consent states of the lead and variant arms (`consent_clicks`, `consent_choice_state`, and `variant_consent_choice_state`), the lead run's HTTP status (400 or higher marks an error or block page, not the site's normal behavior; exclude those rows from aggregate statistics, as this project's own percentiles and category medians do), plain-language headline, the third-party / catalogued-service / cookie counts, the observed blocking change (the `shields_third_party_change` column: the SIGNED third-party request change of an eligible Brave-list blocking pair, the blocking visit's count minus the unblocked baseline's, so negative means fewer with blocking and positive means more, a simulation with Brave's engine and default lists in the scanner's browser rather than a live Brave visit, blank otherwise; increases are real paired-visit observations and are reported signed rather than clamped to zero, and it is never a count of individually blocked requests; the JSON payload's `shieldsChangeSummary` counts the paired rows by direction), the since-last-scan deltas with the previous report's id, and the schema columns (`schema_version`/`schema_revision` for the wire generation, `schema_origin` marking historical v1 rows, and `limited` marking rows whose revision supports only descriptive claims). Comparison rows also expose the pair-level `comparison_decision_mode` plus `compatibility_fingerprint_origin` and the tri-state `compatibility_fingerprint_matched` verdict. Pair-level `comparable` does not make every metric family comparable or authorize causal wording; the linked report carries those family gates and their reasons. The raw per-arm fingerprint digests stay in that full report and are deliberately omitted from the flattened corpus to avoid stable-linkability and noise without a documented consumer. The five new CSV fields are appended after the existing columns, so all earlier positions remain stable. The export is deliberately mixed-version: historical v1 rows remain legacy-derived and limited, while newly committed r2 rows expose their native revision and claim strength. Both formats are generated at build time from the same loader as `/directory/`, so the three surfaces cannot disagree; the JSON payload embeds the framing note and the CSV stays header-plus-rows for parsers. This is a measured corpus of curated sites (popular, mostly commercial, plus a diversity seed list), not a random sample of the web: treat cross-site statistics as describing this corpus only, and cite per-report evidence via the linked report pages. Licensed AGPL-3.0-or-later with the repository.

## Cloudflare Worker Deployment

The repo also includes a Cloudflare-native scanner in `cloudflare/worker.ts`, built on Cloudflare Browser Run with KV-backed report storage, DNS-over-HTTPS public-address checks, public scan quotas, and GPC comparison support. It no longer powers the public scan form: sitebehavior.org runs the full Node/Playwright container scanner (see the note below), and this Worker is retired as a public deployment because its preflight-only DNS check cannot pin the browser's eventual connection. It remains a lightweight self-hosted option for token-gated GPC/trackers scans.

> For the **full Node/Playwright scanner with the Brave-list blocking simulation** running on Cloudflare (Containers, fronted by a Worker, with R2 report storage), see [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md). That is the Cloudflare-native version of the Node container path and the one serving production; this Browser Run Worker stays a lightweight self-hosted GPC/trackers option.

One-time Cloudflare setup:

1. Create the KV namespace used by the report store and public scan rate limiter:

```bash
npm run cf:kv:create
```

2. Put the returned namespace id in `wrangler.browser-run.jsonc` under the `REPORTS_KV` binding.
3. The committed `wrangler.browser-run.jsonc` ships gated: `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS` and the DNS-rebinding risk flag are both `0`, the safer default for self-hosting. (An intentionally open instance flips both to `1`, see step 5.) For a gated instance, set a scan token:

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

The stable public JSON Schema alias [`/scan-report.schema.json`](https://sitebehavior.org/scan-report.schema.json) points to ScanReport v2 revision 2; the immutable [r1](https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json) and [r2](https://sitebehavior.org/schemas/scan-report.v2.r2.schema.json) URLs remain available for exact validation. Moving the alias does not rewrite stored data or change a producer by itself: historical reports may remain `schemaVersion: 1` or v2/r1, and readers validate each artifact against its declared generation and revision before rendering.

Runtime capability parity is intentionally explicit:

| Producer | Single scan | GPC comparison | Shields comparison | Consent comparison | Async jobs | DNS guard | Tracker catalog | Store |
|---|---:|---:|---:|---:|---:|---|---|---|
| Node / Playwright | yes | yes | yes | yes | yes | connect-time public-address proxy | hand-curated service catalog | filesystem or R2 |
| Cloudflare Worker / Browser Run | yes | yes | no | no | no | DNS-over-HTTPS preflight only | none | KV or R2 |
| Paired GraphML + sidecar r2 import | yes (requests only) | no | no | no | no | no navigation; source artifact only | bundled curated catalog | local / caller-managed |

## Checks

```bash
npm run check
```

Or individually:

```bash
npm run typecheck
npm run cf:typecheck
npm run test:unit
npm run build
npm run build:pages
npm run test:smoke:static
npm run reports:manifest
npm run test:smoke:docker
```

`npm run test:smoke:static` drives the freshly built `out/` export end to end (gallery, permalinks, uploads, compare tools); run it right after `npm run build:pages` so it never checks a stale artifact.

The smoke test needs a built app running:

```bash
npm run build
npm run start -- --port 3100
BASE_URL=http://127.0.0.1:3100 npm run test:smoke
```

If the server has `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` set, pass the same value to the smoke runner as `SMOKE_SCAN_ACCESS_TOKEN`.

## Important Limitations

The Node scanner blocks Service Worker registration so Service Worker fetches
cannot evade Playwright routing or the report recorder. That is a deliberate
containment choice and can make the visit differ from a normal returning-user
session; Web Worker and WebSocket evidence can still be incomplete.

Site Behavior Lab reports what happened during automated Chromium visits from the configured scanner instance: one completed visit for a single report, or one completed visit per condition for a comparison. Optional durable execution may abandon an attempt whose execution, publication, or status coordination was lost and retry it once, so the target can see an extra visit that was partial or that completed before its result was lost; report evidence is never merged across attempts. Recorded counts are a lower bound of what the completed visit observed: activity inside Web or Service Workers and WebSocket traffic is not recorded, and storage keys are read from the top frame only. Each visit is otherwise passive (no scrolling or clicking) except for two bounded steps, both described here: a scripted consent-banner click in consent comparison mode only (detailed below), and the keystroke/input-exfiltration probe, which types a synthetic, non-PII sentinel into form fields present on the loaded page and never submits the form, then watches for that value being sent off-site (requests the page sends during and after that typing, including unload beacons, are part of the recorded request log and counts). It is a lower bound: it covers fields visible after load, not flows behind login, multiple steps, or other frames; it catches real-time, on-blur, and on-unload transmission (it navigates away at the end to flush recorders that buffer keystrokes and send via `sendBeacon`). Separately, the scanner uncloaks CNAME-disguised trackers (third parties hidden behind a first-party subdomain) by resolving first-party subdomains' DNS CNAME chains to known tracking services (the curated catalog first, then the broader Brave Shields lists); this is a bounded, best-effort step that depends on current DNS resolution and that tracker coverage. Advertising-pixel event decoding reads the events Meta/TikTok/X pixels fire from the request itself; standard-vocabulary event names are stored verbatim and site-defined names are generalized to "custom event", while populated advanced-matching identifier fields are detected by checking that a known identifier parameter carries a non-empty value; the value is inspected only transiently in memory and never persisted, exposed, semantically interpreted, or hash-validated (the platforms document the values as hashed; that is not verified). The privacy-policy cross-check is a bounded extra page visit on the Node scanner: it reads the policy the site links from the scanned page (through the same SSRF-guarded browser context, after the request log is closed so the visit never inflates the report's counts) and runs conservative sentence-level text matches, quoting each matched sentence. Only same-site policy links and known policy-hosting services (Termly, iubenda, and similar) are attributed to the site, so another company's policy (a Cloudflare challenge page's link, the reCAPTCHA badge's Google policy) is never analyzed as the site's own, and the check is skipped entirely when the page load failed. It can miss policies without a discoverable link or hosted on an unrelated corporate domain, misread unusual phrasing, and cannot interpret legal definitions, so its findings are documented discrepancies to review, never legal conclusions. Because the visit is passive and not logged in, advanced-matching identifiers usually appear only on interaction-gated flows (checkout, sign-in, form submit), so a passive visit reports the events fired far more often than the identifiers attached. GPC comparison mode runs two sequential visits, one without GPC and one with it. Shields comparison mode runs one classification-only visit and one Brave Shields block-simulation visit. The two visits of every completed comparison attempt run in randomized (counterbalanced) order so time-ordered site behavior cannot load systematically onto one arm, and each report discloses which visit ran first. Consent comparison mode runs one visit that clicks the banner's accept-all choice and one that clicks reject-all: the click targets known CMP controls first (OneTrust, Cookiebot, Didomi, Usercentrics, TrustArc, Sourcepoint, and similar, including consent iframes and shadow-DOM hosts), then a conservative exact-label match ("Accept all", "Reject all", "Only necessary cookies", and similar whole labels only), on the banner's first layer only; choices hidden behind a settings layer are not navigated. Banner presence varies by scanner location (many CMPs only gate EEA/UK/California traffic), so a visit where no control could be clicked is disclosed as pre-consent and the report makes no claim about the choice. Legacy v1 reports record only that the click was dispatched; r2 reports also record bounded TCF/OneTrust readbacks and state whether registration was verified or contradicted, only a weak banner-transition signal was seen, or verification was unavailable or failed. Even verified r2 request evidence spans before and after the click, so trackers in the reject-click visit can be pre-choice traffic, strictly-necessary vendors, or processing claimed under legitimate interest; that finding is an observation to review, not a violation ruling. The simulation uses Brave's own ad-block engine (the open-source [`adblock`](https://github.com/brave/adblock-rust) Rust crate, compiled to WASM) with the `default_enabled` lists from Brave's filter-list catalog. Under the Node scanner's `shields-request-context-v2-adblock-rust-0.13.2-request-method-v1` methodology, each route-evaluated request is matched with its actual HTTP method against the document that initiated it: an ordinary subresource uses its requesting frame, a subframe navigation uses the parent document, and a non-HTTP inherited frame such as `about:blank` walks to its nearest HTTP(S) ancestor. Main-frame navigations are deliberately neither blocked nor counted as matches, and redirect follow-up URLs that Playwright does not re-route are not independently evaluated. The source URL is used transiently by the engine and never added to the public v1 report. It matches network requests only: it does not apply cosmetic/element-hiding rules (CNAME cloaking is handled by the separate DNS step described above, not the block simulation), and the lists are a pinned snapshot, so blocked counts are a close lower-bound approximation of Brave's default Shields rather than a guarantee of identical behavior in a live Brave browser. Differences in either comparison can also reflect timing, experiments, cache state, consent state, or bot detection. Comparisons count as two rate-limit tokens and hold one scan slot until both visits finish. Results are not universal claims about what every visitor will receive. Sites can vary behavior by browser, region, IP reputation, account state, consent state, automation detection, or time.

Shareable reports are stored on the configured report store (filesystem or Cloudflare R2) with 128-bit random IDs behind a date prefix. Report JSON and permalink reads are rate-limited, and old/excess stored reports are pruned by age and count. Persisted reports omit inline screenshots to keep stored JSON and permalink responses smaller; the immediate in-browser scan result can still show the viewport screenshot. A persistent filesystem volume is suitable for single-node deployments; public or horizontally scaled deployments should use durable shared storage.

When the optional durable queue is enabled, its active payload is a separate application-encrypted Durable Object record containing only scheme + host + path and scan options. It excludes IP/client hash, Turnstile and access tokens, headers, cookies, screenshots, evidence, and results. Non-content scheduling metadata is unencrypted but contains no target or client identity. The active ciphertext is deleted on every terminal outcome and hard-bounded to 75 minutes; Cloudflare platform recovery snapshots may retain application-encrypted copies until their own retention window expires.

Static reports under `public/reports/` are different from filesystem share reports: they are committed, public, and retained until removed from git. They are useful for reproducible public evidence and gallery pages, not private or temporary scan results.

The fingerprinting section is an observation layer, not a definitive accusation. API calls such as canvas, WebGL, audio, or WebRTC access can be legitimate. Behavioral heuristics currently cover canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, WebRTC peer-connection setup, and third-party listener coverage; comparison runs are still required before making stronger claims.
