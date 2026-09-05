# Site Behavior Lab

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

Site Behavior Lab visits a public website with a controlled, headless Chromium
and publishes a record of what that site did during the visit: the requests it
made, the third parties it contacted, the cookies and storage keys it set, the
browser APIs it touched, whether it registered your consent choice, whether it
sent what you typed somewhere else, and whether its privacy policy contradicts
any of that. Every published sentence is meant to be traceable to recorded
evidence, and the evidence is meant to be reproducible by anyone.

The public instance is [sitebehavior.org](https://sitebehavior.org). This
README is written for someone deciding whether to depend on the project for
something that matters. It says what the scanner does, how to run it, and
where it stops.

## What it does

One scan is one automated visit from one place at one time. The scanner:

- loads the page through a per-scan proxy that pins every connection to a
  verified public IP address at connect time, so redirects and DNS rebinding
  cannot steer the browser into a private network;
- records requests (up to a cap), third-party domains, curated service and
  tracker labels, cookies (names and flags, never values), storage keys (never
  values), and the scan conditions (browser and Playwright version, viewport,
  locale, timezone, Global Privacy Control state, egress, catalog and
  methodology versions);
- observes high-entropy browser API use and fingerprinting heuristics, and
  third-party session-recording and input-monitoring listeners;
- types a synthetic, non-personal sentinel into up to eight supported form fields already in the viewport
  and watches whether it leaves the site, in plain, base64, hex, or hashed
  form. Native form submission is blocked; focus, input and blur callbacks can
  run and send requests. Unsupported, offscreen and failed attempts count as
  omitted coverage. Teardown-only transmissions are not measured. A visit where
  at least one field accepted the value discloses how many fields were typed
  into; a visit where no field accepted it carries no such statement;
- resolves first-party subdomains' CNAME chains to catch trackers hidden behind
  the site's own hostname;
- decodes the events Meta, TikTok, and X pixels fire and whether their
  advanced-matching identifier fields were populated (the values are checked
  only for being non-empty, in memory, and never stored);
- detects consent tooling and, in consent comparison mode only, clicks one
  accept-all or reject-all control on the banner's first layer and reads back
  the registered consent state where the site exposes it;
- reads the site's own privacy policy (HTML or a direct PDF, through the same
  network guard) and reports sentences that contradict the observed evidence,
  quoting each sentence so a reader can check it in context;
- can run two paired visits to compare GPC off against on, a plain visit
  against a Brave Shields block simulation (Brave's own ad-block engine over a
  pinned snapshot of its default lists, not a live Brave browser), or
  accept-all against reject-all consent. The two visits run in random order and
  the order is disclosed.

The output is a report page with a plain-language headline and a
severity-ranked findings board, the underlying JSON, a request CSV bundled with
its source report and correction context,
and a printable PDF. Reports produced by the public instance are stored for a
bounded window; a curated corpus of committed reports under `public/reports/`
drives the site directory, per-site history pages, category pages, and the
corpus percentiles a report is ranked against. Each publication is appended to
a transparency log whose head is periodically anchored with OpenTimestamps.

## What a report proves, and what it does not

- **One visit, not the site.** The report is what one automated Chromium
  visit from the configured scanner saw. Sites vary behaviour by region,
  browser, IP reputation, login state, consent state, bot detection, and time.
- **Counts describe the instrumented visit.** Retained request counts can be
  lower bounds when capture is incomplete; cookie and storage snapshots can
  change in either direction. None estimates an ordinary browser visit.
  Service Workers are blocked by design, a
  SharedWorker's traffic beyond its entry script is not recorded, WebSocket
  traffic is not recorded at all, storage is read from the top frame only, the
  input probe does not scroll to reach offscreen fields, and the service catalog is a
  curated, US-biased list rather than an inventory.
- **A failed or challenged load is not a clean result.** Sites that refuse
  undisguised automated browsers are reported as refusals, never evaded.
- **No detector accuracy is published.** No claim-bearing detector
  (keystroke exfiltration, pixel events, consent banner, fingerprinting
  heuristics, CNAME uncloaking, privacy policy) has an eligible calibration
  study yet, so there are no precision or recall figures to quote. Findings
  are observations to verify, not measurements with known error rates.
- **The claim boundary is investigative evidence requiring independent
  corroboration.** Standalone legal determinations and sole-court-exhibit use
  are explicitly excluded. That decision is recorded, with the other release
  decisions, in `RELEASE_READINESS.json`.
- **Attribution is not causation.** The script-to-request map records the
  initiator Chromium reported, which may itself have been told what to fetch.
- **Consent evidence spans the click.** Even a verified reject-all visit
  records traffic from before and after the choice, so a tracker seen there
  may be pre-choice, strictly necessary, or claimed under legitimate interest.
- **Percentiles need a cohort.** Corpus-relative severity is used only when
  the report's exact measurement cohort and the metric both hold at least 50
  sites; otherwise fixed thresholds apply and the report says so.

The published coverage boundary, per detector, is on the
[catalog page](https://sitebehavior.org/catalog/); each entry states
whether a test enforces it against the scanner source or it rests on review.

## Limits you should know before depending on it

Hard bounds in the Node scanner (`lib/scanner.ts`, `lib/scan-runtime.ts`,
`lib/public-scan-proxy.ts`, `lib/scan-limits.ts`):

| Bound | Value |
|---|---|
| Scan duration, per visit | 45 s (navigation 30 s) |
| Recorded requests, per visit | 1,000 |
| Proxy transactions / unique targets, per visit | 2,000 / 256 |
| Response bytes / upload bytes through the proxy, per visit | 64 MiB / 16 MiB |
| Concurrent scans per Node process, queued waiters, queue wait | 2, 8, 15 s |
| Async job queue (when enabled), all clients | 32 |
| Scan request body | 4 KiB |
| Report JSON reads, PDF renders, per client per minute | 120, 10 (one render slot) |
| Privacy-policy PDF | 8 MiB, 64 pages |
| Public instance, per client (edge quota) | 6 scans per minute, 120 per day; a comparison costs two |

What the reference deployment keeps switched off, deliberately, and what that
means: durable (restart-safe) jobs, container sharding, and encrypted
scheduled rescans are all implemented behind flags and all committed at `0`.
Production runs the in-process queue; a scan interrupted by a container
restart is lost and must be re-run. Aggregate product metrics are also off.

Release state: the latest tag is `v0.4.0` (2026-08-02). `release-policy.json`
declares `0.5.0`, but no `v0.5.0` tag or release receipt exists yet, and the
policy file says so in its `tagPending` field. The 1.0 readiness manifest
(`npm run release:readiness`) enforces eighteen gates; most of the open ones
are operator attestations, controlled-runner receipts, and legal review rather
than code, and two evidence programs (detector calibration and an A/A
repeatability study) are deferred to 1.1. There is no stable public API and no
npm package.

Retention: reports saved by the public instance are kept for seven days or
500 reports, whichever prunes first (the R2 backend clamps the count to 936);
the committed corpus under `public/reports/` is the currently retained
research corpus and follows its own age, count, and cohort rules, and
reports cited by the corrections ledger are retention-pinned. Published reports are
never rewritten in place; corrections go through the append-only ledger in
`docs/corrections-ledger.md`.

Network boundary: the Node scanner refuses loopback, private, link-local,
carrier-grade NAT, multicast, and reserved ranges in both IP families, on
standard ports only, and re-checks every address at connect time. On the
reference Cloudflare Containers deployment that connect-time proxy is the only
egress control; an independent platform-level egress backstop is tracked as an
open release gate, so an application-layer bypass would not be caught by a
second layer there. See `SECURITY.md`.

Published data: cookie and storage values, credentials, URL fragments, query
values, and screenshots never enter a saved report. Query keys survive only
from a reviewed allow-list; unknown keys, path segments, subdomain labels,
cookie names, and storage keys are generalized. Policy sentences are quoted
verbatim up to a length cap, which is a deliberate, documented exception.

## Run it locally

Use Node.js 24.14.1 with npm 11.11.0 (`.nvmrc`, `package.json`, and CI pin the
same versions).

```bash
npm ci
npx playwright install chromium
npm run dev
```

Open `http://127.0.0.1:3000`. Development needs no environment variables. A
local scan uses the same scanner, proxy, and limits as production, and by
default produces the legacy v1 report format; the public r2 format is a
fail-closed opt-in (below).

Anything that runs `next build` needs the public origin, and refuses to guess
one:

```bash
NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://example.org npm run check
```

`npm run check` runs the TypeScript and Cloudflare type checks, the unit suite,
and the production build. `npm run test:unit` recreates `.unit-test-dist/` on
every run, so never run two of them in one checkout at once. The static export
and its smoke test are `npm run build:pages` followed by `npm run
test:smoke:static`.

## Self-host

The supported scanner is the Node/Playwright container built from the
`Dockerfile`; the legacy Browser Run worker was deleted rather than gated
because its DNS preflight could not pin the browser's eventual connection.

```bash
docker build \
  --build-arg SITE_BEHAVIOR_LAB_BUILD_COMMIT="$(git rev-parse HEAD)" \
  --build-arg NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://scan.example.org \
  --build-arg NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN=https://example.org \
  -t site-behavior-lab .
```

The three build arguments are baked into the client bundle: the exact commit
the container reports in `/api/health`, the origin the scanner is served from,
and the origin of the static site it belongs to. The container runs as a
non-root user, launches Chromium with an explicit environment allow-list, and
removes every package manager from the runtime image.

The decisions that matter when you configure it:

| Variable | Default | What it decides |
|---|---|---|
| `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` | unset | When set, `/api/scan` requires it in `Authorization: Bearer`, `x-site-behavior-lab-access-token`, or the legacy `x-sbl-scan-token` header. Leave it unset only for trusted local use or an intentionally open deployment with external abuse controls. |
| `SITE_BEHAVIOR_LAB_PUBLIC_R2_REPORTS` | unset | `1` makes the scanner return and persist the public ScanReport v2/r2 format. It requires `SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION=1`, a full 40-character `SITE_BEHAVIOR_LAB_BUILD_COMMIT`, and an available report store, and refuses scans rather than silently emitting v1 when any of those is missing. Unset, the scanner emits the legacy v1 format. |
| `SITE_BEHAVIOR_LAB_CONSENT_VERIFICATION` | unset | `1` reads back the registered consent state after a banner click (TCF and OneTrust interpreters) and attempts one disclosed post-choice reload. Required by r2. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND` | `filesystem` | `filesystem` needs a persistent volume; `r2` needs `SITE_BEHAVIOR_LAB_R2_BUCKET`, `_ENDPOINT`, `_ACCESS_KEY_ID`, and `_SECRET_ACCESS_KEY`, and is what a public or multi-node deployment needs. |
| `SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS` / `_MAX_COUNT` | `7` / `500` | Retention for saved shares; the R2 backend clamps age below the bucket's own deletion rule and count to 936. |
| `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS` | unset | `1` only behind a proxy that controls forwarding headers and blocks direct origin access; the rate-limit identity then reads the rightmost `X-Forwarded-For` entry. |
| `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` | `*` | Browser CORS allow-list for the `/api` routes. |
| `SITE_BEHAVIOR_LAB_ASYNC_SCANS` | unset | `1` makes `/api/scan` return `202` with a job id to poll at `/api/scans/:id`; single-process, in-memory. |
| `SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX` | unset | `1` enables Chromium's sandbox (production does); needs unprivileged user namespaces on the host. |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` / `_EGRESS_REGION` | `this scanner instance` / unset | The disclosed egress label and region recorded in reports. Declare a region only when it is true; without one, r2 comparison deltas are refused. |

The complete variable reference, including the Cloudflare-only quota,
Turnstile, durable-job, sharding, and watch settings, is in
`docs/configuration.md`, with `.env.example` as a starting point. The
Cloudflare Containers runbook is `docs/deploy-cloudflare-containers.md`; a
generic single-node runbook is `docs/deploy-node-container.md`; the topology
decision record is `docs/deployment-topology.md`.

## The public deployment

[sitebehavior.org](https://sitebehavior.org) is a static Cloudflare Pages
export of this repository (report viewer, gallery, directory, corpus).
[scan.sitebehavior.org](https://scan.sitebehavior.org) runs the container
scanner on Cloudflare Containers behind a front Worker that enforces Turnstile
and an atomic per-client quota, stores reports in R2, and emits public r2.
Both track the `production` branch, which CI fast-forwards to the exact SHA
it tested only after five gates pass: supply-chain security, typecheck and
unit tests and build, Chromium smoke, Docker runtime and public R2 smoke, and
exact-SHA evidence attestation. The revision each surface is serving is
published at [`/api/health`](https://scan.sitebehavior.org/api/health) and
[`/deployment.json`](https://sitebehavior.org/deployment.json).
Scanner non-production builds are disabled, and Pages automatic
preview deployments remain enabled but Access-protected.

The hourly production synthetic is active (a neutral scan, a public r2 result,
a persisted read-back, and a rendered report page), and the separate
authenticated R2 delete canary is also active and required. The WAF ceiling,
log-retention, and independent egress backstop controls rest on point-in-time
operator receipts recorded in the runbook, not on committed evidence, and the
corresponding release gates stay open until they are re-captured.

Scheduled automation: featured-site rescans run weekly and open a pull request
that a human must approve and merge (never hand-merged); the transparency-log
head is anchored weekly; production health is checked every quarter hour and
hourly; Dependabot proposals get their derived manifests regenerated
automatically but still need a human. The weekly Brave Shields list refresh
is currently disabled by the operator while a reliability sweep characterizes
the present instrument, and the measurement-toolchain drift issue it maintains
therefore stays open.

## API

`POST /api/scan` with a JSON body of `url`, `device` (`desktop` or `mobile`),
`gpcEnabled`, and at most one of `compareGpc`, `compareShields`,
`compareConsent`. A synchronous deployment answers with the report; an async
one answers `202` with `jobId` and `statusPath`, and `DELETE /api/scans/:id`
cancels cooperatively until publication begins. Refusals are `400` for an
invalid or non-public target, `401` for a missing token, `413` for an oversize
body, `429` for the per-client limit, and `503` when the scanner is busy, a
producer is misconfigured, or public-host verification could not complete.
`GET /api/reports/:id` returns the stored wire byte-for-byte, and
`GET /api/reports/:id/pdf` renders it. `GET /api/health` reports readiness,
the build commit, and the effective state of every producer flag.

## Verify a report

```bash
npm run verify:report -- <report-id>
```

That replays the digest chain from the committed report to the transparency
log; add `--from <dir>` to check bytes you saved yourself. Anchors cover a
prefix of the log: entries published since the most recently anchored head
have no external time bound until the next anchoring run. Read
`docs/verify-a-report.md` and `docs/evidence-custody.md` before relying on a
report, and note that a printed copy is a rendering whose footer carries the
wire digest, not the evidence.

## Measurement identity

Every r2 report records the exact instrument it was measured with. The base
Node methodology is
`shields-request-context-v2-adblock-rust-0.13.2-request-method-v1-playwright-1.62.1+subject-validity-v2+detector-coverage-v2`,
and production r2 reports extend it with the phase-kernel, boundary-state,
consent, resource-budget, proxy-traffic, service-worker-block,
detector-accountability, service-role-taxonomy, GPC worker-application,
active-probe, and auxiliary-context-block components, recorded verbatim in `provenance.methodologyVersion`. The Shields
simulation uses the `adblock` Rust crate compiled to WASM from
`tools/adblock-wasm/` over a pinned snapshot of Brave's default lists whose
manifest digest is part of the identity; the curated service catalog is
`lib/tracker-catalog.ts`, versioned by digest. Corpus statistics keep a
separate cohort for every exact combination of schema, methodology, catalog,
taxonomy, metric contract, producer, and requested GPC state, so a value is
never compared across instruments. Changing any of these is a measurement
identity change and follows `RELEASE.md`, not a routine edit.

## Where the details live

- `docs/runtime-boundaries.md`, `docs/scan-job-model.md`: what runs where,
  and the job lifecycle.
- `docs/scan-report-v2-rfc.md`, `docs/compatibility-promise.md`: the report
  contract and what may change in a committed report.
- `docs/research-evidence-model.md`, `docs/calibration-study-operations.md`,
  `docs/calibration-findings.md`: the evidence model and the calibration
  program that gates published detector accuracy.
- `docs/supply-chain-assurance.md`, `THIRD_PARTY_INVENTORY.json`,
  `THIRD_PARTY_REVIEWS.json`: dependency and filter-list provenance.
- `RELEASE.md`, `release-policy.json`, `RELEASE_READINESS.json`,
  `CHANGELOG.md`: what a tag claims and what still blocks 1.0.
- `docs/pagegraph-adapter.md`, `docs/native-shields-differential.md`:
  research-only importers and comparisons that never write public reports.
- `docs/critical-use-audit-2026-09-01.md`: the most recent audit against the
  critical-use definition, with what was found, fixed, and deliberately left.

## Contributing, security, license

Read `CONTRIBUTING.md` before opening a change; the rule that matters most is
that a published claim never outruns the recorded evidence. Report
vulnerabilities through the private advisory channel described in
`SECURITY.md`, never in a public issue. The scanner is for inspecting publicly
reachable websites where that is allowed; it is not a tool for attacking or
probing systems you do not own. The code is licensed under
AGPL-3.0-or-later (`LICENSE`); the curated catalog ships with it and bundles
no third-party dataset.
