# Operations, deployment topology, corpus automation, and exports

The operator-facing sections moved out of the README on 2026-09-02: what is
deployed and how it is promoted, the point-in-time operational receipts, the
CI scanner and featured-corpus workflows, corpus percentiles, retention, the
researcher export, the retired worker, the report contract, and the check
commands. The receipts below are point-in-time; re-capture them for any
release that needs the corresponding gates closed.

## Deployment status

> **Deployment status.** The public site at [https://sitebehavior.org](https://sitebehavior.org) is the static **Cloudflare Pages** front door. Live scans use the full **Node/Playwright scanner** on **Cloudflare Containers** at `scan.sitebehavior.org`, including the Brave-list block simulation (not a live Brave visit), with R2-backed reports, public r2 output, consent verification, Turnstile, and atomic per-client rate limiting. Shared report links resolve to the scanner origin. The exact revision currently served by the scanner is published by [`/api/health`](https://scan.sitebehavior.org/api/health), and the Pages revision by [`/deployment.json`](https://sitebehavior.org/deployment.json). Production deployments track the CI-gated `production` branch. Scanner non-production builds are disabled, and Pages automatic preview deployments remain enabled but are Access-protected rather than public. The lighter **Browser Run Worker** was retired and its source deleted on 2026-07-24; the container scanner is the only supported producer. See [docs/go-live-public-scanner.md](docs/go-live-public-scanner.md), [docs/deploy-cloudflare-containers.md](docs/deploy-cloudflare-containers.md), and [docs/deployment-topology.md](docs/deployment-topology.md).

> **Durable execution status.** Restart-safe queued/running execution is implemented behind `SITE_BEHAVIOR_LAB_DURABLE_JOBS=1`, but the committed production configuration keeps durable jobs and container sharding at `0`. Production therefore uses the in-process queue plus the IDs-only restart-recovery registry. Activation still requires the external secrets/private coordinator setup and the staged replay and no-polling lease-expiry receipts; missing prerequisites fail closed.

> **Scheduled-rescan status.** Accountless encrypted watches are a separate post-durability feature behind `SITE_BEHAVIOR_LAB_ENCRYPTED_WATCHES=1`; production remains committed at `0`. They run one immediate single-mode scan and then attempt an independent scan at a fixed seven-day cadence, with a 30-day/five-attempt cap, capability-controlled management, Turnstile/quota-gated public creation, Worker-only encryption, and fresh target validation on every attempt. They are scheduled rescans, not change alerts; see [docs/encrypted-watches.md](docs/encrypted-watches.md).

> **Operational follow-ups.** The hourly production synthetic is active: it runs a neutral scan, verifies the public r2 result, reads the persisted report back, and renders its report page. That proves the scan/write/read/render path, not every external control. The separate fixed-prefix, authenticated R2 delete canary is also active and required: on 2026-07-29 its direct smoke created, read, deleted, and proved absence for one isolated health object, and [Production Health run 30483261603](https://github.com/iAnonymous3000/site-behavior-lab/actions/runs/30483261603) repeated that proof successfully. The same release recheck proved the combined WAF ceiling on both `POST /api/scan` and `GET /api/scan/admission` at ten requests per ten seconds per IP with a ten-second block. For each route, the eleventh bounded invalid request received `429` plus `Retry-After: 10`, Security Events matched the rule, method, and path, and the ordinary application `400` returned after the block expired. A bounded seven-day Workers Observability dashboard query returned 80 visible `/api/health` matches spanning dashboard timestamps `2026-07-22 18:23` through `2026-07-29 11:25`; a separate `/reports/` query returned eight visible matches spanning `2026-07-22 13:04` through `2026-07-29 11:42`, all with report identifiers redacted. These point-in-time receipts are not committed as canonical evidence, so the `waf-ceilings` and `log-retention` release gates both still report open; re-capture them for any release that needs those gates closed. A platform-compatible independent egress backstop and evidence that the committed-corpus self-hosted runner is single-use, isolated, stable-egress, and destroyed after every job remain operator work.

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

**Brave-list and toolchain maintenance.** [`.github/workflows/update-brave-lists.yml`](.github/workflows/update-brave-lists.yml) runs Mondays at 06:17 UTC and can also be dispatched manually. Its refresh job verifies one commit-pinned Brave catalog against its reviewed SHA-256 and exact source set, refuses redirects and unapproved hosts or paths, caps every response and the aggregate input, proves the vendored WASM engine can load and enforce the new snapshot, and syncs the third-party review ledger for the new list bytes (new rows are created **unreviewed**, so filling them in is part of the review). It then asks `npm run lists:adoption` whether the pinned `NODE_R2_CURRENT_ADBLOCK_IDENTITY` still describes the fetched snapshot. While it does, the job runs the unit suite. When upstream rules have moved, the snapshot is a new measurement identity that only a human may declare, so the producer-contract assertions have a predetermined answer: the suite is skipped with a disclosed warning and the proposal carries the exact constant to adopt, the count of committed reports measured under the outgoing identity, and its own CI as the gate that can actually fail informatively. Changed third-party bytes are pushed only to the stable `automation/brave-list-refresh` proposal branch and opened or updated as a review-required PR; the workflow dispatches non-promoting CI on that branch and never advances `main` or `production`. Upstream shipping new rules is the ordinary weekly outcome and is not a failure; scheduled failures of the refresh machinery stay red, as does a run that validated a proposal but could not open its pull request, and both are reconciled into one canonical repair issue. A separate job compares the pinned adblock crate, Playwright package/browser, and Chrome channel with their upstream stable versions and maintains an independent toolchain-drift issue; drift is reported for review, never auto-upgraded.

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
npm run lists:adoption
npm run reports:manifest
npm run test:smoke:docker
```

`npm run test:smoke:static` drives the freshly built `out/` export end to end (gallery, permalinks, uploads, compare tools); run it right after `npm run build:pages` so it never checks a stale artifact.

`npm run lists:adoption` reports whether the pinned Brave measurement identity still describes the vendored snapshot. It exits `0` either way, because "upstream published new rules" is an ordinary outcome rather than a failure; when they have moved it prints the exact `NODE_R2_CURRENT_ADBLOCK_IDENTITY` literal to adopt and counts the committed reports measured under the outgoing identity, which is what decides whether that identity must also be frozen as a historical row.

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

