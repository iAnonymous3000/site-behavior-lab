# Site Behavior Lab

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

**See what a site does, not just what it says.**

Site Behavior Lab runs controlled Chromium visits and reports observable site behavior: network requests, third-party domains, curated service labels, cookies, storage keys, an ephemeral viewport screenshot in the immediate result, scan conditions, high-entropy browser API calls, behavioral fingerprinting heuristics, third-party session/input-monitoring listener signals, an active keystroke/input-capture probe, DNS-based CNAME-uncloaking of disguised trackers, consent-banner (pre-consent tracking) detection, advertising-pixel event decoding (the events Meta/TikTok/X pixels fire, and whether their personal-identifier fields were populated; each value is checked only transiently for being non-empty and is never stored, decoded, or reported, so identifier delivery is not asserted), and a privacy-policy cross-check (the site's own policy text compared against the observed evidence). Screenshots are stripped before reports are saved or shared.

> **Deployment status.** The public site at [https://sitebehavior.org](https://sitebehavior.org) is the static **Cloudflare Pages** front door. Live scans use the full **Node/Playwright scanner** on **Cloudflare Containers** at `scan.sitebehavior.org`, including the Brave-list block simulation (not a live Brave visit), with R2-backed reports, public r2 output, consent verification, Turnstile, and atomic per-client rate limiting. Shared report links resolve to the scanner origin. The exact revision currently served by the scanner is published by [`/api/health`](https://scan.sitebehavior.org/api/health), and the Pages revision by [`/deployment.json`](https://sitebehavior.org/deployment.json). Production deployments track the CI-gated `production` branch. Scanner non-production builds are disabled, and Pages automatic preview deployments remain enabled but are Access-protected rather than public. The lighter **Browser Run Worker** was retired and its source deleted on 2026-07-24; the container scanner is the only supported producer. See [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md), [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md), and [docs/deployment-topology.md](docs/deployment-topology.md).

> **Durable execution status.** Restart-safe queued/running execution is implemented behind `SITE_BEHAVIOR_LAB_DURABLE_JOBS=1`, but the committed production configuration keeps durable jobs and container sharding at `0`. Production therefore uses the in-process queue plus the IDs-only restart-recovery registry. Activation still requires the external secrets/private coordinator setup and the staged replay and no-polling lease-expiry receipts; missing prerequisites fail closed.

> **Scheduled-rescan status.** Accountless encrypted watches are a separate post-durability feature behind `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=1`; production remains committed at `0`. They run one immediate single-mode scan and then attempt an independent scan at a fixed seven-day cadence, with a 30-day/five-attempt cap, capability-controlled management, Turnstile/quota-gated public creation, Worker-only encryption, and fresh target validation on every attempt. They are scheduled rescans, not change alerts; see [docs/encrypted-watches.md](docs/encrypted-watches.md).

> **Operational follow-ups.** The hourly production synthetic is active: it runs a neutral scan, verifies the public r2 result, reads the persisted report back, and renders its report page. That proves the scan/write/read/render path, not every external control. The separate fixed-prefix, authenticated R2 delete canary is also active and required: on 2026-07-29 its direct smoke created, read, deleted, and proved absence for one isolated health object, and [Production Health run 30483261603](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30483261603) repeated that proof successfully. The same release recheck proved the combined WAF ceiling on both `POST /api/scan` and `GET /api/scan/admission` at ten requests per ten seconds per IP with a ten-second block. For each route, the eleventh bounded invalid request received `429` plus `Retry-After: 10`, Security Events matched the rule, method, and path, and the ordinary application `400` returned after the block expired. A bounded seven-day Workers Observability dashboard query returned 80 visible `/api/health` matches spanning dashboard timestamps `2026-07-22 18:23` through `2026-07-29 11:25`; a separate `/reports/` query returned eight visible matches spanning `2026-07-22 13:04` through `2026-07-29 11:42`, all with report identifiers redacted. These point-in-time receipts close the WAF and historical log-query follow-ups for this release; capture fresh receipts for later releases. A platform-compatible independent egress backstop and evidence that the committed-corpus self-hosted runner is single-use, isolated, stable-egress, and destroyed after every job remain operator work.

## Why It Is Different

Site Behavior Lab is built for reproducible, inspectable evidence instead of opaque scoring. Each current Node report records the scan conditions that affect results, including exact Playwright and browser versions, viewport, timezone, locale, Global Privacy Control state, scanner egress, tracker catalog version, and scanner methodology provenance. Historical reports that predate an exact Playwright disclosure are shown as `not recorded`, never backfilled from the current deployment.

The project is open source under the [AGPL-3.0-or-later](LICENSE) so anyone can inspect the scanner, URL-safety checks, catalog labels, and report UI behind the results.

## Current Capabilities

- Next.js app with a server-side Playwright scanner.
- Public URL input with desktop/mobile viewport selection.
- Optional Global Privacy Control signal, plus off/on GPC, Shields, and consent (accept-all vs reject-all) comparison modes in the Node scanner.
- SSRF guard that blocks localhost, private networks, link-local addresses, and reserved test ranges, with the Node scanner routing Chromium through a connect-time public-address proxy.
- Basic server-side guardrails: request body limit, per-client scan and report-JSON limits, an atomic edge quota for runtime report pages/social cards, scan concurrency cap, scan duration cap, per-scan request cap, and shared Chromium reuse.
- Optional scan access key enforcement for public or gated deployments.
- Report URLs omit credentials and fragments. First-party URLs omit query strings; third-party request logs keep only reviewed, exact query-key literals and always discard values. Unknown keys, path segments, subdomain labels, cookie names, and storage keys are generalized before a report crosses a public or persistent boundary.
- Stable report permalinks (date-prefixed random IDs) and JSON endpoints under `/reports/:id` and `/api/reports/:id`. Runtime-saved reports are retained for a configurable window (7 days / 500 reports by default, then pruned). Versioned reports under `public/reports/` form the currently retained research corpus and follow separate age, count, and cohort pruning rules; reports cited by the corrections ledger are retention-pinned.
- Runtime health/readiness metadata under `/api/health`.
- Static export (deployed on Cloudflare Pages) for the report viewer, generated report gallery, saved-report comparisons, and committed report JSON under `public/reports/`.
- Plain-language headline at the top of every report, plus per-report Open Graph / X (`summary_large_image`) share cards and link metadata generated from that headline, so a shared report link unfurls with the site name, the lead finding, and key counts in both the Node app and the static export.
- Curated "Start here" gallery on the static site that groups pre-scanned popular sites by category (banking & money, health, dating, kids & education, news & media, shopping, search & social, and government) with plain-language headline cards, so a first-time visitor sees real evidence without running a scan. The curated list lives in `public/featured-sites.json`.
- Discoverability and structured data: brand favicon, `robots.txt`, a `sitemap.xml` that lists committed report pages on the static export, sitewide `WebSite`/`SoftwareApplication` JSON-LD, and per-report schema.org `Dataset` JSON-LD (lead finding, scanned site, headline metrics, and a machine-readable download link).
- Accessibility: the signal-colour ramp is tuned to WCAG AA contrast (>=4.5:1 as text, including on its tinted chip backgrounds), and severity is always paired with text and icons so it never relies on colour alone.
- Corpus-relative severity: `public/corpus-stats.json` v4 keeps separate cohorts for each exact report schema/revision, methodology, tracker catalog, read-time ServiceRole taxonomy, metric contract, producer, and requested-GPC condition. Within each cohort, the newest eligible passive lead run per site contributes only to evidence-family distributions it measured completely; percentile wording activates when both the exact cohort and the named metric contain at least 50 sites. Failed/no-response, request-incomplete, and post-choice consent runs stay out of statistical distributions, while v1 and v2 remain eligible only inside their own identities. Request statistics distinguish all catalog-matched request rows (`cataloguedServiceRequests`) from the third-party tracking-role subset (`trackingServiceRequests`). A successful single run or primary comparison arm still counts its site toward successful-load corpus coverage even when the other primary arm failed or request recording was capped; each site counts once, and sites represented only by failed or block-page attempts stay outside coverage.
- Server-rendered, indexable `/directory/` pages with one current profile per canonical site, backed by the reports currently retained in the versioned corpus; individual profiles expose that site's retained timeline and the sitemap provides crawlable internal linking.
- Per-site history pages under `/sites/<registrable-domain>/` for every corpus site: the latest controlled visit, observed differences across comparable visits (only within the same versioned measurement/condition cohort; capped or failed visits never pair), a history sparkline over the timeline's own numbers, and the full retained evidence timeline, linked from the directory rows. Each site also publishes an Atom feed at `/sites/<registrable-domain>/feed.xml` (autodiscoverable from the history page) so new corpus reports for a site can be watched from any feed reader.
- On-site `/methodology/` page describing the measurement in plain language: what the automated visit does, the two bounded interactions, how comparisons are paired and gated, what the Brave-list blocking simulation means, redaction at publication, and how the corpus percentiles are built.
- Transparency-index hero that leads the static homepage with measured corpus highlights (how many real sites have been scanned and the median catalogued tracker-request count per site for the top categories), linking straight into `/directory/` and the report library, so the landing view is evidence rather than a pitch.
- Paired GraphML + sidecar [PageGraph r2 importer](docs/pagegraph-adapter.md) with strict request-only provenance, explicit unsupported-family availability, and a sanitized real Brave Nightly fixture; tolerant v1 adapter helpers remain legacy/internal compatibility utilities.
- Browser evidence imports fail closed above 8 MiB for public report JSON, 16 MiB for GraphML, or 256 KiB for its metadata sidecar; the separate 32 MiB server/history ceiling remains available only to managed storage and remediation paths.
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
  - consent-tooling (CMP) detection that surfaces catalogued tracking-related service domains requested before the scanner made any consent choice; a domain match does not prove request purpose, and a CMP loader does not prove a banner was shown or establish consent requirements or legal compliance
  - consent comparison (Node scanner): two paired visits, one clicking the banner's "Accept all" and one clicking "Reject all" (known CMP controls first, then a conservative whole-label text match; first banner layer only), diffed to show what differed between the two visits and which catalogued tracking-related service domains still appeared in the Reject-all visit. Legacy v1 reports record click dispatch only; r2 reports also record bounded TCF/OneTrust readbacks and state whether registration was verified or contradicted, only a weak banner-transition signal was seen, or verification was unavailable or failed. Even verified r2 request evidence spans before and after the click, so traffic can be pre-choice, strictly necessary, or processing claimed under legitimate interest. When no control can be clicked, the run is disclosed as pre-consent and no claim is made
  - advertising-pixel event decoding for Meta, TikTok, and X: the events each pixel fired (PageView, Purchase, ...; standard vocabulary names are stored verbatim, site-defined names are generalized to "custom event") and whether its advanced-matching identifier fields were populated, detected by checking that a known identifier parameter carries a non-empty value, so the identifier category is reported while the value itself is inspected only transiently in memory and never persisted, exposed, semantically interpreted, or hash-validated (the platforms document the values as hashed; that is not verified). On Shields comparison reports the diff also names which pixel events blocking removed
  - privacy-policy cross-check (Node scanner): the scanner discovers the site's privacy-policy link, reads the policy through the same SSRF-guarded browser context, and compares its text against the visit's evidence. It flags contradictions of checkable statements (a "we do not use third-party cookies" claim against observed third-party cookies, a blanket "we do not use cookies" claim against observed cookies, a "we do not sell personal information" claim against advertising pixels that carried personal-identifier fields; Global Privacy Control claims are never judged from request counts, which cannot show whether data sales stopped) and lists observed tracking companies the policy never names. Every match quotes the policy sentence so it can be verified in context; it is an automated text match, not a legal reading
  - ephemeral screenshot in the immediate result (never persisted in saved/shared report JSON)
  - methodology disclosure
  - sanitized JSON export and request-log CSV export

## Acceptable Use

Use Site Behavior Lab for transparency research, journalism, compliance review, debugging your own sites, or inspecting public websites where that activity is allowed. Do not use it for attacking, brute-forcing, crawling at abusive rates, bypassing access controls, or scanning systems you do not own or do not have permission to test.

The visit is passive except for two bounded interactions. First, an **active input probe**: the Node/Playwright scanner types a synthetic, non-PII test value into up to a handful of *visible* form fields to test for keystroke/input capture. It **never submits the form, never presses Enter, and never enters real data**, the typed value is synthetic and is not stored, and every report discloses how many fields were typed into. Second, in **consent comparison mode only**, the scanner clicks a single accept-all or reject-all control on the page's cookie/consent banner (first layer only, recognized CMP controls or an exact accept/reject label), and every such run discloses exactly what was clicked or that nothing was. Both interactions' requests still pass through the scanner's SSRF/public-address guard. Operators running an open deployment should be aware their scanner performs these bounded interactions on scanned sites at a visitor's request.

With optional durable execution, an attempt whose execution, publication, or status coordination was lost may be abandoned and retried once under a fenced two-attempt lease. The target can therefore receive an extra automated visit that was partial or that completed before its result was lost. The report still contains one completed attempt per condition and never merges evidence from separate attempts; if a complete R2 report already exists, recovery reconciles that exact stored report instead of visiting again.

Operators of public deployments are still responsible for abuse prevention and local legal compliance. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).

### What this is ready for

Site Behavior Lab produces **reproducible investigative evidence**: a recorded,
versioned account of what one automated Chromium visit observed, with its
measurement boundaries stated in the report itself. That is a sound basis for
research, journalism, debugging your own properties, and building a documented
case to investigate further.

It is **not** a calibrated detector suite or a compliance oracle, and the
repository says so in machine-readable form rather than in marketing prose. Run
the gate yourself before relying on it:

```bash
npm run release:readiness
```

To verify a published report's exact bytes against what this project
published, one command replays the digest chain:

```bash
npm run verify:report -- <report-id>
```

Add `--from <dir>` to check bytes you saved yourself rather than the bytes this
site serves today; if you intend to rely on a report, read
[docs/evidence-custody.md](docs/evidence-custody.md) first, and note that a
printed copy is a rendering whose footer carries the wire digest, not the
evidence.

Every publication is also chained into the append-only
[transparency log](https://sitebehavior.org/transparency-log.json), whose
heads carry OpenTimestamps anchors covering the entries beneath them, and the
detectors' enumerated blind spots are published on the
[catalog page](https://sitebehavior.org/catalog/) with the test that keeps each
claim honest.

Two limits matter most for serious work, and both are deliberate:

- **No published detector accuracy.** No claim-bearing detector
  (keystroke-exfiltration, pixel-events, consent-banner, fingerprint-heuristics,
  cname-uncloaking, privacy-policy) has an eligible calibration study yet, so
  there are no precision/recall numbers to quote. Findings are observations to
  verify, not measurements with known error rates. Any future published rate
  must use the v3 study schema and is conditional on its exact structured
  measurement arm; in particular, pixel-event sensitivity is measured only in
  the desktop, GPC-disabled arm where accept-all registration was verified
  again after reload, never from a requested click alone and never generalized
  to all visits. The release-grade, role-separated producer and operator sequence are documented in
  [docs/calibration-study-operations.md](docs/calibration-study-operations.md).
- **The claim boundary is investigative evidence requiring independent
  corroboration.** Standalone legal determinations and sole-court-exhibit use
  are explicitly excluded; that decision is approved and recorded in
  [`RELEASE_READINESS.json`](RELEASE_READINESS.json).

Three practical consequences when interpreting a report:

- A **failed or challenged load is not an absence of trackers.** Sites refuse
  undisguised automated browsers, and the scanner reports that honestly instead
  of evading it. Check the report's quality and bot-wall disclosures before
  reading a low count as a clean result.
- **Counts are a lower bound, never an inventory.** Service Workers are blocked
  by design; Web Worker and WebSocket traffic can be incomplete; storage is read
  from the top frame only; the service catalog is US-biased.
- **Severity may not be corpus-ranked.** Percentile severity needs a
  current-method cohort of at least 50 sites. Where none exists the report falls
  back to fixed thresholds, and `public/corpus-stats.json` shows each cohort's
  real size.

If you self-host for serious use, read the Docker build-arg note below (the
image bakes in public URLs at build time), and treat durable jobs and an
independent egress backstop as prerequisites rather than options: both are off
in the committed production configuration and are tracked as release gates.

## Data Attribution

The tracker/service catalog is a US-biased, hand-curated, in-repo list of high-prevalence third-party services in [lib/tracker-catalog.ts](lib/tracker-catalog.ts), licensed with this repository under AGPL-3.0-or-later. It deliberately bundles no third-party dataset, so there is no separate NonCommercial term to clear before commercial use.

Coverage is intentionally a lower bound: the curated list names recognizable services rather than every tracker. The Shields filter-list-match and block-simulation signals are computed separately, with Brave's own ad-block engine (the [`adblock`](https://github.com/brave/adblock-rust) Rust crate compiled to WASM, built from `tools/adblock-wasm/`) over Brave's default filter lists, vendored as a pinned snapshot; those lists do not assign the service/entity labels shown by the curated catalog.

[`THIRD_PARTY_INVENTORY.json`](THIRD_PARTY_INVENTORY.json) is the deterministic dependency and filter-source evidence inventory. It is not a complete notice set: the checked lockfiles do not establish licenses for 68 third-party Cargo packages or any of the 31 filter-list sources, so legal review and any required notice/source-offer work remain release gates. The automated dependency/CVE checks, WASM reproducibility boundary, and artifact-attestation gate are documented in [`docs/supply-chain-assurance.md`](docs/supply-chain-assurance.md).

## Run Locally

Use Node.js 24.14.1 with npm 11.11.0, matching `package.json`, the version files, and GitHub Actions:

```bash
npm ci
npx playwright install chromium
npm run dev
```

Open `http://127.0.0.1:3000`.

`npm run dev` needs no extra environment. Anything that runs `next build` does:
`NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` must be set to the public origin, and
the build fails closed without it rather than publishing `localhost` canonical
URLs. That covers `npm run build`, `npm run build:pages`, and `npm run check`:

```bash
NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://example.org npm run check
```

The digest-pinned Playwright container base is verified at Node 24.18.1 with npm 11.16.0 during the build, which is intentionally distinct from the host/Actions authoring toolchain above; the Docker build fails if the base versions drift. The runtime stage then removes every global package manager (npm, npx, yarn, corepack) and the WebKit-only GStreamer "bad" plugins, so the shipped image serves the built app with node alone. Container release evidence re-runs the node binary from the exact image ID with no network, a read-only root filesystem, all capabilities dropped, and no-new-privileges, and independently asserts that no npm binary answers from that image.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` | unset | When set, `/api/scan` requires the token in `Authorization: Bearer ...` or `x-site-behavior-lab-access-token`. Leave unset only for trusted local development or intentionally public deployments with external abuse controls. |
| `SITE_BEHAVIOR_LAB_SYNTHETIC_MONITOR_TOKEN` | unset | Cloudflare Containers front Worker only. Distinct Worker-only credential for the scheduled production synthetic. It bypasses Turnstile only for the fixed desktop/GPC-on/observe single-scan contract against one of the ordered candidate targets in `lib/production-synthetic.ts` (currently iana.org, then w3.org), is stripped before forwarding to Node, and does not close or weaken the visitor Turnstile path. Configure the same value as the repository secret `PRODUCTION_SYNTHETIC_MONITOR_TOKEN`, then set `PRODUCTION_SYNTHETIC_MONITOR_REQUIRED=1` as a repository variable so later credential loss fails loudly. |
| `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS` | unset | Containers front Worker only. Set to `1` only for an intentionally open public scanner, with no scan token set. The front Worker still enforces Turnstile (when configured) and an atomic Durable Object quota, and the container pins DNS at connect time. See [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md). |
| `SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK` | unset | Containers front Worker only. Open public scans fail closed with `503` when no `TURNSTILE_SECRET_KEY` is configured. Set to `1` only to consciously waive human verification and run an open scanner on atomic rate limiting alone. See [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md). |
| `TURNSTILE_SECRET_KEY` | unset | Cloudflare Worker secret used to verify scan-submission Turnstile tokens. The open Containers scanner fails closed without it unless `SITE_BEHAVIOR_LAB_ACCEPT_NO_TURNSTILE_RISK=1` explicitly waives that control. Pair it with the matching public site key below; never expose this secret to the browser or Node container. |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE` | `6` | Cloudflare Workers only. Maximum public scan tokens per client per minute. GPC, Shields, and consent comparisons cost two tokens. The Containers front Worker accounts atomically in the scanner Durable Object's SQLite storage. |
| `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_DAY` | `120` | Cloudflare Workers only. Maximum public scan tokens per client per day. GPC, Shields, and consent comparisons cost two tokens. |
| `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS` | unset | Set to `1` only when traffic reaches the app through a trusted proxy that controls forwarding headers and blocks direct origin access. Rate limiting uses in-memory counters per Node process. |
| `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` | `*` | Browser CORS allow-list for the `/api` routes (also honored by the Cloudflare Worker). Default `*` lets any site invoke the scanner from a browser, fine for a single-origin (B1) deployment or an intentionally open scanner. Set it to one origin (for example `https://sitebehavior.org`) to allow only that site's cross-origin browser requests; others are denied. The scan API uses no cookies, so `*` is safe by default. |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` | `this scanner instance` | Reviewed public egress label used in report disclosures and JSON exports: `this scanner instance`, `cloudflare-containers`, `cloudflare-browser-run`, `github-actions-ubuntu`, `docker-smoke`, or `test`. An unreviewed value is canonicalized to the generic label and degrades health instead of breaking r2 production. The committed-r2 workflow requires the private configuration alias `controlled-self-hosted`; reports still emit the generic label, with the stable location in `SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION`. |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION` | unset | Node scanner only. Recorded egress region for ScanReport v2/r2 (`conditions.egress.region`). Unset, the scanner falls back only when Cloudflare Containers supplies the complete `CLOUDFLARE_REGION`/`CLOUDFLARE_LOCATION`/`CLOUDFLARE_COUNTRY_A2` placement tuple; a partial tuple is a health misconfiguration. With neither source the region stays unrecorded, and r2 comparison deltas are refused because an unrecorded condition never counts as matching across two visits. Declare it only when it truthfully names where scan traffic leaves from. |
| `SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX` | unset | Set to `1` to launch scan Chromium with its sandbox enabled. Opt-in because the sandbox needs kernel features (unprivileged user namespaces or a setuid helper) that a container platform may not provide, and a failed launch breaks every scan; verify one deployed scan succeeds before leaving it on. The container process runs as a non-root user either way, and WebRTC egress is disabled at launch (`disable_non_proxied_udp`) so no scan traffic can bypass the connect-time public-address guard. |
| `SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION` | unset | Node scanner only. Set to `1` to read back the site's registered consent state after a dispatched banner click (TCF `__tcfapi` and OneTrust consent-cookie interpreters, plus banner-visibility observations) and to attempt one disclosed post-choice page reload that re-reads the registered state; requests observed during the reload's measurement phase are excluded from the recorded request log and counts. The readback is recorded in r2 reports; a legacy v1 fallback response records only its compatible disclosure warning. |
| `SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS` | unset | Node scanner only. Exact fail-closed gate for returning and persisting ScanReport v2/r2 from the live API and async jobs. Unset or `0` selects the legacy v1 compatibility response plus independently controlled shadow behavior. `1` requires `SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION=1`, a full 40-character `SITE_BEHAVIOR_LAB_BUILD_COMMIT`, and an available report store; any invalid/incomplete configuration refuses scans instead of silently falling back to v1. `/api/health` exposes the effective state at `checks.publicR2Reports.status` and sets `scansAvailable: false` when the requested producer is not ready. Immediate sync/job responses retain their ephemeral screenshots; saved shares contain only the named-field public projection. |
| `SITE_BEHAVIOR_LAB_BUILD_COMMIT` | unset | Exact lowercase 40-character Git SHA embedded in Node/r2 provenance and `/api/health`. Production container builds must supply it as the Docker build argument; the deploy wrapper injects the tested commit and the Dockerfile rejects missing, symbolic, or placeholder values. |
| `SITE_BEHAVIOR_LAB_V2_SHADOW_EMISSION` | unset | Node scanner only. Set to `1` to additionally build ScanReport v2/r2 public wires (redacted, screenshots stripped): one single artifact for a single scan, or one complete pair artifact for a comparison. Comparison axis, semantic arms, execution order, verification, comparability, and diff are derived from the two visits' staged facts; partial per-arm files are never written. Shadow output remains operator-only, successful writes log only closed artifact metadata, and a failed shadow build/store is a diagnostic, never a failed primary scan. Requires `SITE_BEHAVIOR_LAB_BUILD_COMMIT`; observe-mode visits also need the consent-verification flag so the always-on banner detector records a real outcome. |
| `SITE_BEHAVIOR_LAB_V2_SHADOW_BACKEND` | `filesystem` | Node scanner only. `filesystem` uses the local shadow directory. `r2` reuses the configured R2 bucket credentials but writes create-only objects under the operator-only, build-pinned `v2-shadow/<build>/<single\|comparison>/` prefix, disjoint from public `reports/`. Cloudflare Containers fixes this to `r2`; no scanner read/list endpoint exposes the objects. The prefix is not an ACL: before enabling it, require the bucket's `r2.dev` URL disabled and every custom domain absent or Access-protected, as detailed in the [Containers runbook](docs/deploy-cloudflare-containers.md#8-verify-private-v2r2-shadows-before-the-schema-alias-flip). |
| `SITE_BEHAVIOR_LAB_V2_SHADOW_DIR` | `.site-behavior-lab/v2-shadow` | Filesystem shadow backend only. Container disk is ephemeral, so deployed verification uses the R2 backend. |
| `SITE_BEHAVIOR_LAB_ASYNC_SCANS` | unset | Set to `1` to make `/api/scan` return `202 { jobId, statusPath, reportId }`. With durable jobs off, scans use the current single-process in-memory queue; the Containers front Worker retains only TTL-bounded ID linkage for completed-report recovery. Clients poll `/api/scans/:jobId`, and `DELETE` cooperatively cancels work until publication begins. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS` | `0` | Cloudflare Containers only. `1` replaces the in-memory admission source of truth with the restart-safe Durable Object queue. The encrypted payload, execution row, and request-independent drain schedule must commit before the Worker returns `202`; claims are oldest-first, fenced, and limited to two attempts. Requires async scans, R2/public-r2 persistence, the key and internal-token secrets below, the coordinator URL, the privacy disclosure, and a live no-polling lease-expiry recovery test. Missing or invalid prerequisites fail closed. The committed deployment config intentionally remains `0` until that gate is complete. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS_KEY` | unset | **Worker-only secret.** Canonical base64url encoding of exactly 32 random bytes, used for application-level AES-256-GCM encryption of the active job payload. Never expose it to the browser or forward it into the Node container. Rotation requires draining the 75-minute active-job window unless both key versions are explicitly supported. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS_INTERNAL_TOKEN` | unset | **Separate Worker-to-Node secret**, forwarded only to the container to authenticate private prepare/execute/heartbeat/publication/reconciliation callbacks. Do not reuse the public scan access token, Turnstile secret, R2 credentials, or encryption key. Public requests must never be able to supply or reach the trusted internal channel. |
| `SITE_BEHAVIOR_LAB_DURABLE_JOBS_COORDINATOR_URL` | unset | Non-secret canonical scanner origin used by the Node runner for callbacks to the Durable Object coordinator. Required only when durable jobs are enabled; use the fixed HTTPS scanner origin, with no path, query, credentials, or fragment. |
| `SITE_BEHAVIOR_LAB_CONTAINER_SHARDING` | `0` | Containers front Worker only. Independent post-durability gate for distributing fenced durable execution. Enabling it requires durable jobs to be ready and a shard count from 2 to 3; disabling durable jobs always collapses routing back to the singleton. The committed production value is `0`. |
| `SITE_BEHAVIOR_LAB_CONTAINER_SHARD_COUNT` | unset (production: `3`) | Requested bounded shard count when sharding is enabled. Shard zero reuses the default singleton, so the production value `3` consumes the complete `max_instances: 3` ceiling rather than creating four instances. Ignored while sharding is off. |
| `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES` | `0` | Cloudflare Containers only. Independent post-durability gate for encrypted scheduled rescans. `1` requires durable jobs to be fully ready, an isolated Worker-only watch key, the published disclosure, an operator-second-factor staging canary, and a final public-UI Turnstile canary with no watch token. Ordinary scans and public watch creation share Turnstile plus atomic quota. Metadata read/delete remains rollback-safe. |
| `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_KEY` | unset | **Worker-only secret.** Current canonical base64url encoding of exactly 32 random bytes for AES-256-GCM watch target/options encryption. It must not alias any durable-job, coordinator, scan, Turnstile, or R2 secret and is never forwarded into Node. |
| `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_PREVIOUS_KEY` | unset | **Optional Worker-only rotation secret.** The immediately previous 32-byte watch key may decrypt retained envelopes while every new write uses the current key. Keep it for the maximum 30-day watch TTL (or delete all old-key watches), then remove it. |
| `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES_ACCESS_TOKEN` | unset | **Optional Worker-only staging/operator second factor.** When configured, a distinct header-safe value of at least 32 characters is mandatory as `x-site-behavior-lab-watch-access-token` on `POST /api/watches`, checked before capability/DO/quota work, and stripped before Node forwarding. Leave it unset for public self-service creation, which uses Turnstile (or the scanner's normal access token) plus atomic quota. Any presented header fails closed when this secret is unset. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND` | `filesystem` | Backend for persisted share reports: `filesystem` (default) or `r2`. The `filesystem` backend needs a persistent volume to survive restarts; `r2` stores reports in Cloudflare R2 (S3-compatible) so share links survive container redeploys and host replacement, and is what multi-node hosting needs. The report-store policy (share IDs, screenshot stripping, validation, expiry, prune counts) is identical across backends. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` | `.site-behavior-lab/reports` | Filesystem backend only. Directory for persisted share reports. Use a persistent volume in production. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` | `7` | Maximum age for persisted share reports before they are ignored and pruned, **clamped strictly below the storage bucket's own `reports/` deletion rule** (8 days today, so the effective ceiling is 7). The bucket deletes on its own timer with no exemption path, so a larger value would publish an expiry the bytes do not survive. A clamped value is applied silently; `/status` reports the effective number. Durable jobs require this effective age policy to retain reports for at least 75 minutes. This variable is also the fallback for committed static-report retention, which is **not** clamped: those files are in git, not under the bucket rule. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` | `500` | Target maximum number of persisted share reports. Newly published shares receive the short survival window below before count pruning can evict them, so a burst may exceed the target temporarily. |
| `SITE_BEHAVIOR_LAB_REPORT_MIN_SURVIVAL_MS` | `60000` | Minimum time (capped at two hours) a newly committed share survives count pruning, preventing a successful concurrent save from returning an already-dead link. Durable jobs fail closed unless the effective value is at least `4500000` (75 minutes). Age expiry still wins. |
| `SITE_BEHAVIOR_LAB_R2_BUCKET` | unset | Name of the R2 bucket that holds report JSON. Required by both the generic Node r2 backend and the Cloudflare Containers front Worker; either path fails closed when it is unset. The committed production, replay-staging, and watch-staging Wrangler configurations set their bucket names explicitly. |
| `SITE_BEHAVIOR_LAB_R2_ENDPOINT` | unset | R2 backend only. S3-compatible endpoint, for example `https://<accountid>.r2.cloudflarestorage.com`. Required when the public report store or v2 shadow backend is `r2`. |
| `SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID` / `SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY` | unset | R2 backend only. Credentials for an R2 API token scoped to the reports bucket (Object Read & Write). Required when the public report store or v2 shadow backend is `r2`. These are secrets. |
| `SITE_BEHAVIOR_LAB_R2_PREFIX` | unset (bucket root) | R2 backend only. Optional key prefix under which report objects are stored; the generic Node backend defaults to the bucket root. The committed Cloudflare Containers configs explicitly set `reports/`, so production does not use the generic default. |
| `SITE_BEHAVIOR_LAB_R2_REQUEST_TIMEOUT_MS` | `10000` | R2 backend only. Per-attempt S3 request deadline, capped at two minutes. Retry policy remains bounded separately. |
| `SITE_BEHAVIOR_LAB_PAGES_BASE_PATH` | inferred for GitHub Pages | Build-time base path for the static export. Set `/` for a root-domain deployment such as `sitebehavior.org`; otherwise the build can infer a GitHub project-page subpath from `GITHUB_REPOSITORY`. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` | unset | Optional public API base for static builds. When set for a static deployment (such as Cloudflare Pages), the static UI shows a live scan form and sends scans to this Cloudflare Worker/API origin. Do not put secrets in this value. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY` | unset | Build-time public Turnstile site key for the static scan UI. Required when the target Cloudflare Worker is deployed with `TURNSTILE_SECRET_KEY`; the static UI renders the Turnstile widget and sends its token with each scan. Without it, a Turnstile-gated Worker leaves the scan button disabled with an explanation. This is a public site key, not a secret. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS` | unset | Build-time hint for static builds. Set to `1` only when the target scan API is an intentionally open public scanner, so the static UI hides the access-key field immediately instead of waiting on `/api/health`. The UI also infers open access from the live health response, so this only affects first paint. This is a public flag, not a secret. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN` | `https://sitebehavior.org` | Build-time public HTTPS origin (scheme and host only) of the evidence library this deployment belongs to. The container's `/status/` page reads `<origin>/deployment.json` to compare the live site and scanner revisions, and report permalinks resolve there. A self-hosted container that leaves this at the default compares its own revision against sitebehavior.org and reports "degraded" for an unrelated project's deploy, so set it to your own Pages origin (or to your container origin when it serves the UI too). It is baked into the client bundle at build time, so it must be passed as a Docker build argument, not a runtime environment variable. Do not put secrets in this value. |
| `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` | unset | Canonical public HTTPS origin (scheme and host only, for example `https://sitebehavior.org`) used for canonicals, report social cards, `robots.txt`, `sitemap.xml`, and JSON-LD URLs. Any GitHub Pages project-page subpath is applied automatically via the base path, so do not include it here. Production builds fail closed when this is missing, non-HTTPS, malformed, or contains a path; only development falls back to `http://localhost:3000`. Do not put secrets in this value. |

Copy `.env.example` for a production-oriented starting point.

Validate downloaded shadow artifacts with the same structural and semantic reader used by the app:

```bash
npm run reports:verify-v2-shadow -- \
  --expected-build "$(git rev-parse HEAD)" \
  --dir .site-behavior-lab/v2-shadow
```

The verifier accepts only public v2/r2 artifacts from the expected full build SHA, binds filenames to run/pair IDs, and summarizes comparison axes, AB/BA order, eligibility, verification, and arm outcomes without printing subjects or evidence.

## Architecture

![Site Behavior Lab architecture: a visitor loads the static Cloudflare Pages UI and submits a scan to the Front Worker (Turnstile and rate limits), which forwards to the Node and Playwright container scanner. The scanner reaches the target site only over public HTTP(S) on standard ports through an SSRF egress proxy that pins a public IP at connect time, records its detections, and writes durable saved reports to R2. The live Containers API and single-site Actions dispatch emit public r2, the scheduled corpus refresh emits r2 once its controlled runner variable is configured and otherwise takes a disclosed frozen-v1 fallback, and explicit manual Actions dispatch may select frozen v1 deliberately; the paired PageGraph importer emits request-only r2.](docs/architecture.svg)

The Cloudflare Pages site is the static front door; live scans run on the Node/Playwright container behind a Turnstile/rate-limit Worker, reach the public web only through a connect-time SSRF proxy, persist to R2, and emit public r2. GitHub Actions invokes the same Node scanner: single-site repository-dispatch production is unconditionally r2, and the scheduled featured refresh emits r2 once the controlled self-hosted runner variable (`FEATURED_RUNNER_LABEL`) is configured, otherwise a loudly disclosed frozen-v1 fallback. Only an explicit human workflow dispatch may select frozen v1 deliberately. Paired PageGraph uploads emit request-only r2 reports locally. See [docs/deployment-topology.md](docs/deployment-topology.md) for the decision record.

## Production Deployment

> **Choosing a topology.** For a public deployment the Node container and the Cloudflare Worker are not equivalent: they sit on opposite sides of the SSRF/DNS-rebinding boundary (the Node scanner pins to a public IP at connect time; the Worker preflight can be rebound). See [docs/deployment-topology.md](docs/deployment-topology.md) for the decision record. The recommended path is the Node scanner container behind Cloudflare for edge/WAF/R2. **That path now ships on Cloudflare Containers** (open to the public behind Turnstile and rate limits, R2-backed; see [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md)); the generic single-node steps below remain the runbook for any other host. The static Pages site remains the public front door, pointed at the container scanner. The GPC/trackers Worker (under "Cloudflare Worker Deployment") is retired: its source and its wrangler config were deleted from the repo on 2026-07-24, so it is not a self-hosting option.

**CI-gated deployment.** Production (Cloudflare Pages and the scanner's Workers Builds) tracks the **`production`** branch, never `main`. CI fast-forwards `production` to the exact SHA it tested only after all five promotion gates pass: Supply-chain Security, Typecheck/Unit Tests/Build, Chromium Smoke Test, Docker Runtime and Public R2 Smoke, and exact-SHA evidence-manifest attestation. `.github/workflows/promote-production.yml` provides an idempotent fallback for ordinary push/user-dispatched runs, including a retry when every gate passed but CI's direct promotion step failed; it re-reads and requires the successful conclusion of those same five named jobs before moving the ref. Both paths share the same serialized, fast-forward-only checks: they never force-push, skip out-of-order completions, and hard-fail on a tested SHA no longer reachable from `main`. CI promotes directly because workflow runs dispatched by repo-writing workflows with `GITHUB_TOKEN` do not reliably cascade into a third `workflow_run`. Set the repository variable `SITE_BEHAVIOR_LAB_PROMOTION_PAUSED=1` to hold production during an incident, then clear it and rerun CI to resume. Current operator state: both production integrations point at `production`, scanner non-production builds are disabled, and Pages automatic preview deployments remain enabled but are Access-protected. That satisfies the required release posture, which is that previews are either disabled or behind Access; do not describe them as disabled, because they still build.

For a single-node deployment:

1. Set `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` unless the scanner is intentionally public and protected by stronger external controls.
2. Set `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` to a persistent volume, and tune report age/count retention.
3. For committed r2 production, set `SITE_BEHAVIOR_LAB_SCANNER_EGRESS=controlled-self-hosted` and record the operator-verified stable location separately in `SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION`. The alias is configuration-only; public reports use the generic label.
4. Put the app behind a trusted HTTPS reverse proxy. Set `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS=1` only when direct origin access is blocked.
5. Run `/api/health` from your load balancer or monitor and alert when `status` is `degraded`; the Node health response includes Brave ad-block engine load status under `checks.adblock`. For the reference deployment, `.github/workflows/production-health.yml` requests four best-effort GitHub-scheduled checks per hour, supports an independent `production-health` repository dispatch, and reconciles delivered failures into a bot-owned, workflow-labeled canonical issue. It fails on availability or security-posture regressions (Turnstile off, sandbox off, wrong report store, missing rate limits). Every delivered run also checks the separate visitor-facing `/api/health/public-ingress` preflight: Siteverify must recognize the configured Turnstile secret and the public quota ledger must answer a non-consuming public-scope peek. That preflight does not solve a challenge or submit a visitor scan. After the matching operator-only synthetic secrets are activated, the hourly run separately performs a fixed real scan, R2 readback, and report-page render; GitHub cron delivery itself is not an uptime SLA.
6. Enforce an independent egress policy at the host/container/VPC layer where the platform supports one, so private, link-local, metadata, and other internal networks remain unreachable even if the application guard is bypassed. The Node scanner itself routes Chromium through a per-scan proxy that resolves, validates, pins, and connects only to public IP addresses. The reference Cloudflare Containers deployment currently relies on that connect-time proxy because the platform's internet-disable mode also blocks its pinned raw-TCP connections; a compatible independent backstop remains defense-in-depth work.

Docker:

```bash
docker build \
  --build-arg SITE_BEHAVIOR_LAB_BUILD_COMMIT="$(git rev-parse HEAD)" \
  --build-arg NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL="https://scan.example.org" \
  --build-arg NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY="0xYOUR_TURNSTILE_SITE_KEY" \
  --build-arg NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN="https://example.org" \
  -t site-behavior-lab .
docker run --rm -p 3000:3000 \
  --env-file .env.production \
  -v site-behavior-lab-reports:/var/lib/site-behavior-lab/reports \
  site-behavior-lab
```

Pass those three `NEXT_PUBLIC_*` build args when self-hosting. They are baked
into the image at build time, so the `--env-file` at run time cannot change
them, and the Dockerfile defaults them to the reference deployment
(`https://scan.sitebehavior.org`, that deployment's Turnstile site key, and
`https://sitebehavior.org`). Building without them produces an image that
serves your scanner while advertising someone else's origin in every canonical
URL, `sitemap.xml` entry, `robots.txt` sitemap line, report JSON-LD link, and
social card, and that renders a Turnstile widget your secret cannot verify.

Validate the container path end to end with:

```bash
npm run test:smoke:docker
```

Horizontally scaled deployments need shared durable report storage and queue authority. With `SITE_BEHAVIOR_LAB_DURABLE_JOBS=0`, the Cloudflare Containers front Worker accounts public quotas atomically and keeps an IDs-only recovery registry, but queued/running execution remains process-local and is not replayed after restart. The opt-in Phase-2 path moves admission and execution state into the same singleton Durable Object, uses its persistent schedule for request-independent liveness, and reconciles publication against R2. After durable jobs are proven live, the separately gated `SITE_BEHAVIOR_LAB_CONTAINER_SHARDING=1` path may distribute only fenced durable execution across the configured bounded shard count; ordinary/Phase-1 traffic remains on the singleton. The independent encrypted-watch gate reuses the authoritative coordinator schedule but admits each due run as an ordinary durable job. All three rollout gates remain off in the committed production configuration.

For the exact flag-off and Phase-2 contracts, see [docs/scan-job-model.md](docs/scan-job-model.md).

## Static Hosting (Cloudflare Pages)

Production runs as a static export on Cloudflare Pages at https://sitebehavior.org; any static host can serve the same artifact (GitHub Pages also works). Static hosting serves the static interface, generated report gallery, and client-side report viewer. It cannot run the Node/Playwright scanner, `/api/scan`, `/api/health`, or filesystem-backed report reads. The Pages build strips API routes and the container-only printable report route (`/reports/:id/print`, so report pages on the static site render no link to it, nor to the PDF export at `/api/reports/:id/pdf` that renders it), generates `public/reports/index.json` from committed report JSON, and pre-renders `/reports/:id/` pages for every `public/reports/:id.json` file present at build time.

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

The `.github/workflows/scan.yml` workflow is the zero-server scan path. Its acquisition job runs the built app, calls the same `/api/scan` endpoint as the live product, and has only read access to the repository. It can upload only a bounded data artifact containing screenshot-stripped report JSON, its provenance sidecar, and canonical aggregate files. A separate GitHub-hosted publisher checks out the exact source SHA, prechecks exact GitHub artifact metadata, downloads the raw immutable-ID ZIP without auto-extraction, and uses repo-owned central/local ZIP validation plus bounded inflation into a fresh directory. It then rejects malformed/duplicate-key JSON, schema or digest mismatch, symlinks, traversal, excess files/bytes, changed historical evidence, or an unexpected new-report set before copying only new report/sidecar pairs. That trusted job independently prunes retention, rebuilds the manifest and corpus statistics, then proposes the result on a per-attempt `automation/*` branch, opens a pull request against the dispatching branch, and dispatches CI on the proposal branch (where promotion is gated off). After the pull request merges, the required CI and exact-SHA attestation gates run on `main` and CI advances `production`, which triggers Cloudflare Pages to rebuild the static gallery.

Committed r2 scans are labeled `ci-workflow` only by a server process that
still satisfies the preflight's CI, sandbox, r2, and controlled-egress facts;
the API request cannot supply that provenance. Publication rechecks that label,
the exact build SHA, selected redacted target shape, device, comparison arms,
and every embedded supporting pair before copying evidence.

Repository dispatch defaults unconditionally to r2 and fails closed if the
configured self-hosted runner lacks a truthful stable-egress attestation. Frozen
v1 is available only when a human explicitly selects it in `workflow_dispatch`;
missing inputs never downgrade automated production to v1.

The source-level privilege split is not evidence that the external acquisition
host is isolated. Automated r2 corpus publication remains blocked for a
critical release until operators prove the configured self-hosted runner is
single-use, carries no production/control-plane credentials or persistent
cache, uses the declared independently restricted egress, and is destroyed
after each job. See [docs/featured-corpus-r2-rollout.md](docs/featured-corpus-r2-rollout.md).

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

Populate it from `.github/workflows/scan-featured.yml` (**Actions > Scan Featured Sites**) or a `repository_dispatch` of type `site-behavior-featured-scan`. The read-only acquisition job scans every public homepage in the catalog through the same `/api/scan` path as `scan:ci`; the separate trusted publisher validates the bounded data artifact, applies retention, rebuilds the manifest/statistics, and commits only new canonical report pairs. Run it locally against a built scanner with:

```bash
npm run build
npm run start -- --port 3100
BASE_URL=http://127.0.0.1:3100 npm run scan:featured
```

Filter and tune with `FEATURED_CATEGORIES` (comma-separated category ids), `FEATURED_LIMIT`, `FEATURED_COMPARE_SHIELDS` (the Shields off/on comparison; takes precedence over the other modes), `FEATURED_COMPARE_CONSENT` (the consent accept/reject comparison; takes precedence over GPC), `FEATURED_COMPARE_GPC` (default `true`, the GPC off/on comparison), `FEATURED_DEVICE`, and `FEATURED_DELAY_MS`. Edit the catalog in `public/featured-sites.json`, then re-run the scan to refresh the gallery.

> **Preview a corpus run before publishing.** The workflow pushes the new reports to a per-attempt `automation/*` branch and opens a pull request against the branch it runs on, so the corpus never lands anywhere without review. Dispatch it from `main` or a staging branch (in **Actions > Scan Featured Sites**, choose the branch under "Use workflow from"); the proposal PR is the staging surface. Pages previews are Access-protected in the current deployment; review the staged branch through that protected preview or locally (`npm run build:pages` on the branch), check the gallery, `/directory/`, and whether the corpus cleared `CORPUS_MIN_SAMPLE` (the run's job summary reports the report and distinct-site counts), then merge the proposal if its base is `main`; the trusted CI, attestation, and promotion chain runs only on `main`, so a proposal merged into any other branch stays a preview and publishes nothing.

## Corpus Percentiles and Directory

`npm run corpus:stats` (`scripts/build-corpus-stats.mjs`) reads the committed reports under `public/reports/` and builds the v4 corpus artifact. It keeps one distribution cohort for every exact schema/revision, methodology, tracker-catalog, read-time ServiceRole-taxonomy, metric-contract, producer, and requested-GPC identity, with the newest eligible lead run per distinct non-reserved site inside each cohort. The main document must have loaded successfully, request evidence must be complete, and the run must remain in passive `observe` consent state. Failed/no-response, request-incomplete, and accept/reject consent runs are excluded from statistical measurement; v1 and v2 runs can contribute only to their own exact cohorts. Request distributions separately publish all catalog-matched rows (`cataloguedServiceRequests`) and the third-party tracking-role subset (`trackingServiceRequests`) under `metric-contract-v1`. Coverage considers a single run or either primary comparison arm: a successful primary arm contributes its site once to `coverageSiteCount`, and an exact request-capped successful primary arm contributes it to `cappedSiteCount`; sites represented only by failed or block-page attempts do not. Attempted sites, successful-load coverage, and statistical measurement are therefore separate concepts. The Pages build and both scan workflows rebuild the artifact after the report manifest.

Eligible findings use percentile wording only when the report's exact cohort and the named metric distribution each reach `CORPUS_MIN_SAMPLE = 50`, for example "at or above the 90th-percentile mark ... across the N sites measured for this metric." Below either threshold, findings use fixed reference thresholds. Anchoring the sentence to the stored percentile mark, rather than claiming a strict fraction below the current site, keeps it accurate when values tie.

These percentiles compare a site with this **curated corpus, not a random sample of the web**. The corpus is seeded from a featured catalog of popular, mostly commercial sites plus a separate diversity list. A high mark therefore means heavy within that measured set, while a lower mark does not mean light in absolute terms. Tail marks should be read as descriptive corpus summaries, not population estimates.

To reduce that popular-commercial skew, scan the **corpus de-bias seed list** in `public/corpus-seed-sites.json`, a broader, lighter mix (open source, nonprofit, education, reference, international government, community/personal) kept separate from the gallery. The weekly 07:23 UTC scheduled leg already walks this list (see below). To refresh it out of band, run **Actions > Scan Featured Sites** with the `sites_file` input set to `public/corpus-seed-sites.json`, or locally:

```bash
FEATURED_SITES_FILE=public/corpus-seed-sites.json BASE_URL=http://127.0.0.1:3100 npm run scan:featured
```

Those scans populate `public/reports/`, the corpus stats, and `/directory/`, but **not** the curated "Start here" gallery (which only matches `public/featured-sites.json`). It is a curated-diverse list, not a random sample, so it widens the distribution without claiming to represent the whole web.

`/directory/` is a paginated, server-rendered, indexable index with one current row per canonical site: domain, plain-language headline, and key metrics. Each profile links the reports for that site that are currently retained in the versioned corpus. The directory is generated for both the Node app and static export, listed in `sitemap.xml`, and linked from the public gallery.

The scan workflows' trusted publisher prunes committed static reports before updating the manifest. By default it keeps reports for 7 days up to a hard ceiling of 1,000 committed reports, except that the newest two reports in each exact site, kind, subject, and versioned measurement/condition cohort are exempt from age pruning (tune with `SITE_BEHAVIOR_LAB_STATIC_REPORT_KEEP_PER_SITE`; 0 restores pure age pruning). Unknown or generalized legacy identities never match one another, but the newest report for each broad site/kind remains as a disappearance guard. Report IDs referenced by the corrections ledger and their provenance sidecars are pinned against automated pruning. The directory uses the separate compatible passive-history identity described below; retention alone never makes two reports comparable. Override static retention with `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_COUNT`, or use the existing `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` and `SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT` variables as shared fallbacks. The static pruner reads that fallback unclamped: committed reports live in git rather than under the R2 `reports/` lifecycle rule, so the share-store ceiling does not apply to them, and one variable can therefore mean two different retentions.

The featured-scan workflow also runs on a weekly schedule, in two separate legs every Monday, so both halves of the corpus refresh themselves: 05:23 UTC walks the featured gallery catalog and 07:23 UTC walks the de-bias seed list above. Each leg opens its own `automation/*` proposal PR and consumes its own scan capacity, so a maintenance window or freeze has to account for both. Only the gallery leg is judged against the full-catalog completeness floor, because the seed list is deliberately smaller than that floor; a seed leg still goes red on scan failures, an unhealthy batch, or a malformed summary. Scheduled runs emit r2 when the controlled runner variable `FEATURED_RUNNER_LABEL` is set; until it is, they fall back to frozen v1 and say so loudly (a preflight `::warning`, a "scheduled fallback" summary line, and an "Add scheduled v1 fallback scan reports" commit message). Only an explicit human dispatch may select frozen v1 deliberately. See [docs/featured-corpus-r2-rollout.md](docs/featured-corpus-r2-rollout.md). Scheduled runs use an explicit 80% health gate (override it deliberately with the `FEATURED_MIN_SUCCESS_RATE` repository Actions variable); a lower-yield batch stays red and keeps its canonical repair issue open, while independently validated successful reports still publish. Retention pruning still runs after any publishable batch: the pruner preserves each cohort's newest generations and a broad newest-per-site disappearance guard, so failed targets keep evidence without letting partial refreshes grow the corpus forever. On `/directory/`, a site's newest report shows what changed only when a previous successful, uncapped report has the same kind and requested/final subject and a compatible schema revision, methodology, browser environment, device/viewport, intervention state, filter-list engine/source/count, known snapshot dates (which may differ), and tracker catalog. Unknown or generalized v1 subjects fail closed. These deltas are observed differences between two automated visits, which can also reflect ad rotation, experiments, caching, or bot detection, and the UI says so.

**Scanner fidelity against real sites.** [`.github/workflows/scanner-fidelity.yml`](.github/workflows/scanner-fidelity.yml) runs daily at 04:35 UTC and on manual dispatch. It builds the scanner from the tested SHA, scans a pinned roster of real public sites (`public/scanner-fidelity-sites.json`), and asserts scanner invariants on every produced report: capture-loss scoping, censoring justification, count consistency, honest failure reporting, and a full render through the site's own view, headline, findings, and JSON-LD modules. The scheduled run fans out across all four scan shapes (`single`, `shields`, `gpc`, `consent`) so the comparison producers are exercised on real sites every day, not only when someone dispatches them; a manual dispatch runs exactly the requested shape (`npm run test:smoke:scanner-fidelity` locally, mode via `SCANNER_FIDELITY_MODE`). A site refusing the undisguised automated browser is recorded as an honest refusal, never retried around; the gate fails only on invariant violations or missing digest-bound producer provenance.

**Brave-list and toolchain maintenance.** [`.github/workflows/update-brave-lists.yml`](.github/workflows/update-brave-lists.yml) runs Mondays at 06:17 UTC and can also be dispatched manually. Its refresh job verifies one commit-pinned Brave catalog against its reviewed SHA-256 and exact source set, refuses redirects and unapproved hosts or paths, caps every response and the aggregate input, proves the vendored WASM engine can load and enforce the new snapshot, and runs the unit suite. Changed third-party bytes are pushed only to the stable `automation/brave-list-refresh` proposal branch and opened or updated as a review-required PR; the workflow dispatches non-promoting CI on that branch and never advances `main` or `production`. Scheduled failures stay red and are reconciled into one canonical repair issue. A separate job compares the pinned adblock crate, Playwright package/browser, and Chrome channel with their upstream stable versions and maintains an independent toolchain-drift issue; drift is reported for review, never auto-upgraded.

## Researcher Export

`/corpus.json` and `/corpus.csv` export one row per committed report, including report/JSON URLs, scan and condition metadata, lead-run status, the `request_capped` flag, headline counts, eligible Shields change, since-last-compatible-scan deltas, schema provenance, consent verification state, and comparison-decision metadata. The JSON payload embeds the complete framing note; both formats come from the same loader as `/directory/`.

Rows with a null status or status `>= 400`, rows with `request_evidence_complete: false` (including but not limited to exact request-cap hits), and post-choice consent lead runs remain visible as evidence but stay out of this project's percentiles and aggregate cohorts. The export keeps `request_capped` separate so consumers can distinguish the exact cap from other bounded capture loss. The `cookie_evidence_complete` column is the same completeness flag for the cookie family and moves independently of the request flags: a producer that records no cookie evidence at all (a PageGraph import) leaves `request_evidence_complete` true while `cookie_evidence_complete` is false, and where it is false, `third_party_cookies` is not a measurement and must not be read as a zero. It is deliberately mixed-version: historical v1 rows are `legacy-derived` and `limited`, while r2 rows expose their native revision and claim strength. Current percentiles remain v1-only; category rollups use their separately disclosed eligible cross-version cohort. Filter by `schema_version`, `schema_revision`, `schema_origin`, `limited`, and the completeness flags before aggregation.

`shields_third_party_change` is the signed third-party request change for an eligible Brave-list blocking pair (blocking minus unblocked baseline), not a count of individually blocked requests: negative means fewer with blocking, positive means more. Pair-level `comparable` never makes every metric family comparable or authorizes causal wording; consult the linked report's family gates and reasons. This is a curated measured corpus, not a random sample of the web. Licensed AGPL-3.0-or-later with the repository.

## Cloudflare Worker Deployment (removed)

The repo used to ship a second, Cloudflare-native scanner built on Browser Run
(`cloudflare/worker.ts` plus `wrangler.browser-run.jsonc`). It was retired as a
public deployment, deleted from Cloudflare on 2026-07-09, and its source was
deleted from this repo on 2026-07-24.

The reason is structural rather than incidental: Browser Run exposes no proxy or
IP-pinned navigation primitive, so that worker could only do a DNS-over-HTTPS
**preflight** and Browser Run then re-resolved the name at connect time. A
name that resolves public during the check and private at connect time defeats
it, and no configuration closes that gap. Keeping it as a gated self-host option
meant shipping a second scanner with a known SSRF weakness that was one
environment flag away from being reachable.

The supported deployment is the Node/Playwright container, which resolves,
validates, and **pins** to a public IP through a per-scan local proxy
([lib/public-scan-proxy.ts](lib/public-scan-proxy.ts)). See
[docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md) for
Cloudflare Containers, or [docs/deploy-node-container.md](docs/deploy-node-container.md)
for a plain Node container. The decision record is
[docs/deployment-topology.md](docs/deployment-topology.md).

Reports produced by the retired worker remain readable: `browser-run-worker` is
still a recognized `observer` in the frozen v2 schema vocabulary, and the
`cloudflare-browser-run` conditions profile is still honored by the readers.

## Report Contract

The stable public JSON Schema alias [`/scan-report.schema.json`](https://sitebehavior.org/scan-report.schema.json) points to ScanReport v2 revision 2; the immutable [r1](https://sitebehavior.org/schemas/scan-report.v2.r1.schema.json) and [r2](https://sitebehavior.org/schemas/scan-report.v2.r2.schema.json) URLs remain available for exact validation. Their frozen wording errata are published on the site's [methodology page](https://sitebehavior.org/methodology/#schema-errata) and in the [v2 RFC](docs/scan-report-v2-rfc.md#errata). Moving the alias does not rewrite stored data or change a producer by itself: historical reports may remain `schemaVersion: 1` or v2/r1, and readers validate each artifact against its declared generation and revision before rendering.

Runtime capability parity is intentionally explicit:

| Producer | Single scan | GPC comparison | Shields comparison | Consent comparison | Async jobs | DNS guard | Tracker catalog | Store |
|---|---:|---:|---:|---:|---:|---|---|---|
| Node / Playwright | yes | yes | yes | yes | yes | connect-time public-address proxy | hand-curated service catalog | filesystem or R2 |
| Paired GraphML + sidecar r2 import | yes (requests only) | no | no | no | no | no navigation; source artifact only | bundled curated catalog | local / caller-managed |

## Checks

```bash
npm run check
```

`npm run check` expands to:

```bash
npm run typecheck
npm run cf:typecheck
npm run test:unit
npm run build
```

Additional release and runtime checks include:

```bash
npm run build:pages
npm run test:smoke:static
npm run lists:verify
npm run reports:manifest
npm run test:smoke:docker
```

`npm run test:smoke:static` drives the freshly built `out/` export end to end (gallery, permalinks, uploads, compare tools); run it right after `npm run build:pages` so it never checks a stale artifact.

Versioned releases are cut as `vX.Y.Z` tags under the release-integrity
contract in [RELEASE.md](RELEASE.md): a tag claims only that the tagged
revision passed every required CI gate, was promoted to `production` before
the tag existed, and has a Sigstore-attested exact-source release receipt,
archived durably under [docs/release-receipts/](docs/release-receipts/). The
machine-readable release state is [release-policy.json](release-policy.json);
a tag does not claim API stability or npm publication, both of which remain
explicitly disabled there.

CI also runs the dependency audit, static export, and static smoke test; separate Chromium Smoke Test and required Docker Runtime and Public R2 Smoke jobs exercise the built Node app and production image.

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

Site Behavior Lab reports what happened during automated Chromium visits from the configured scanner instance: one completed visit for a single report, or one completed visit per condition for a comparison. Optional durable execution may abandon an attempt whose execution, publication, or status coordination was lost and retry it once, so the target can see an extra visit that was partial or that completed before its result was lost; report evidence is never merged across attempts. Recorded counts are a lower bound of what the completed visit observed: activity inside Web or Service Workers and WebSocket traffic is not recorded, and storage keys are read from the top frame only. Each visit is otherwise passive (no scrolling or clicking) except for two bounded steps, both described here: a scripted consent-banner click in consent comparison mode only (detailed below), and the keystroke/input-exfiltration probe, which types a synthetic, non-PII sentinel into form fields present on the loaded page and never submits the form, then watches for that value being sent off-site (requests the page sends during and after that typing, including unload beacons, are part of the recorded request log and counts). It is a lower bound: it covers fields visible after load, not flows behind login, multiple steps, or other frames; it catches real-time, on-blur, and on-unload transmission (it navigates away at the end to flush recorders that buffer keystrokes and send via `sendBeacon`). Separately, the scanner uncloaks CNAME-disguised trackers (third parties hidden behind a first-party subdomain) by resolving first-party subdomains' DNS CNAME chains to known tracking services (the curated catalog first, then the broader Brave Shields lists); this is a bounded, best-effort step that depends on current DNS resolution and that tracker coverage. Advertising-pixel event decoding reads the events Meta/TikTok/X pixels fire from the request itself; standard-vocabulary event names are stored verbatim and site-defined names are generalized to "custom event", while populated advanced-matching identifier fields are detected by checking that a known identifier parameter carries a non-empty value; the value is inspected only transiently in memory and never persisted, exposed, semantically interpreted, or hash-validated (the platforms document the values as hashed; that is not verified). The privacy-policy cross-check is a bounded extra page visit on the Node scanner: it reads the policy the site links from the scanned page (through the same SSRF-guarded browser context, after the request log is closed so the visit never inflates the report's counts) and runs conservative sentence-level text matches, quoting each matched sentence. Only same-site policy links and known policy-hosting services (Termly, iubenda, and similar) are attributed to the site, so another company's policy (a Cloudflare challenge page's link, the reCAPTCHA badge's Google policy) is never analyzed as the site's own, and the check is skipped entirely when the page load failed. It can miss policies without a discoverable link or hosted on an unrelated corporate domain, misread unusual phrasing, and cannot interpret legal definitions, so its findings are documented discrepancies to review, never legal conclusions. Because the visit is passive and not logged in, advanced-matching identifiers usually appear only on interaction-gated flows (checkout, sign-in, form submit), so a passive visit reports the events fired far more often than the identifiers attached. GPC comparison mode runs two sequential visits, one without GPC and one with it. Shields comparison mode runs one classification-only visit and one Brave Shields block-simulation visit. From the July 13, 2026 randomization release onward, the two visits of a completed comparison attempt run in randomized order so time-ordered site behavior is not systematically assigned to the same arm across scans. Post-release v1 report warnings name the visit that ran first; post-release v2 JSON records `AB` for baseline first or `BA` for variant first. Comparisons captured before that release used a fixed baseline-then-variant order and carry no randomized-order disclosure. A single two-visit report is not counterbalanced; only an aggregate containing independent AB and BA pairs can make that claim. Consent comparison mode runs one visit that clicks the banner's accept-all choice and one that clicks reject-all: the click targets known CMP controls first (OneTrust, Cookiebot, Didomi, Usercentrics, TrustArc, Sourcepoint, and similar, including consent iframes and shadow-DOM hosts), then a conservative exact-label match ("Accept all", "Reject all", "Only necessary cookies", and similar whole labels only), on the banner's first layer only; choices hidden behind a settings layer are not navigated. Banner presence varies by scanner location (many CMPs only gate EEA/UK/California traffic), so a visit where no control could be clicked is disclosed as pre-consent and the report makes no claim about the choice. Legacy v1 reports record only that the click was dispatched; r2 reports also record bounded TCF/OneTrust readbacks and state whether registration was verified or contradicted, only a weak banner-transition signal was seen, or verification was unavailable or failed. Even verified r2 request evidence spans before and after the click, so trackers in the reject-click visit can be pre-choice traffic, strictly-necessary vendors, or processing claimed under legitimate interest; that finding is an observation to review, not a violation ruling. The simulation uses Brave's own ad-block engine (the open-source [`adblock`](https://github.com/brave/adblock-rust) Rust crate, compiled to WASM) with the `default_enabled` lists from Brave's filter-list catalog. Under the Node scanner's `shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.1+subject-validity-v2+detector-coverage-v2` base methodology (production r2 reports record the full extended identity, this base plus the phase-kernel, consent, budget, accountability, and ServiceRole-taxonomy suffixes, in `provenance.methodologyVersion`), each route-evaluated request is matched with its actual HTTP method against the document that initiated it: an ordinary subresource uses its requesting frame, a subframe navigation uses the parent document, and a non-HTTP inherited frame such as `about:blank` walks to its nearest HTTP(S) ancestor. Main-frame navigations are deliberately neither blocked nor counted as matches, and redirect follow-up URLs that Playwright does not re-route are not independently evaluated. The source URL is used transiently by the engine and never added to the public v1 report. It matches network requests only: it does not apply cosmetic/element-hiding rules (CNAME cloaking is handled by the separate DNS step described above, not the block simulation), and the lists are a pinned snapshot, so blocked counts are a close lower-bound approximation of Brave's default Shields rather than a guarantee of identical behavior in a live Brave browser. Differences in either comparison can also reflect timing, experiments, cache state, consent state, or bot detection. Comparisons count as two rate-limit tokens and hold one scan slot until both visits finish. Results are not universal claims about what every visitor will receive. Sites can vary behavior by browser, region, IP reputation, account state, consent state, automation detection, or time.

Shareable reports are stored on the configured report store (filesystem or Cloudflare R2) with 128-bit random IDs behind a date prefix. The JSON endpoint has the Node per-client read limit. On the Cloudflare Containers topology, `GET`/`HEAD` requests for runtime report HTML/RSC and both generated social cards share an additional atomic Durable Object quota of 120 requests per client and 1,200 globally per fixed minute; refusals are fail-closed and `no-store`. Those runtime routes are request-rendered and re-check store expiry every time, so Next's Full Route Cache cannot retain an expired report. Old/excess stored reports are pruned by age and count. Persisted reports omit inline screenshots to keep stored JSON and permalink responses smaller; the immediate in-browser scan result can still show the viewport screenshot. A persistent filesystem volume is suitable for single-node deployments; public or horizontally scaled deployments should use durable shared storage.

When the optional durable queue is enabled, its active payload is a separate application-encrypted Durable Object record containing only scheme + host + path and scan options. It excludes IP/client hash, Turnstile and access tokens, headers, cookies, screenshots, evidence, and results. Non-content scheduling metadata is unencrypted but contains no target or client identity. The active ciphertext is deleted on every terminal outcome and hard-bounded to 75 minutes; Cloudflare platform recovery snapshots may retain application-encrypted copies until their own retention window expires.

Static reports under `public/reports/` are different from filesystem share reports: they are committed, public, and retained until removed from git. They are useful for reproducible public evidence and gallery pages, not private or temporary scan results.

The fingerprinting section is an observation layer, not a definitive accusation. API calls such as canvas, WebGL, audio, or WebRTC access can be legitimate. Behavioral heuristics currently cover canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, WebRTC peer-connection setup, and third-party listener coverage; comparison runs are still required before making stronger claims.
