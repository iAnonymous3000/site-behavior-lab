# Deployment Topology Decision

> Status: **Free-tier launch (2026-06-21).** No paid compute is available (no host;
> Cloudflare Containers require the Workers Paid plan), so the live public product is the
> static **Cloudflare Pages** site at https://sitebehavior.org — a **published
> Shields-diff evidence corpus** — plus the Cloudflare **Worker** as a **GPC / trackers**
> live scan (no live Shields). **Option B (the Node/Playwright container) is the
> moat-on-demand path, but PARKED** pending paid compute: the Shields tried-vs-blocked
> diff only runs in the Node+wasm scanner, which has no free home. The analysis below is
> the plan to execute if/when paid compute is on the table — keep it, don't delete it.

## Context

The product direction is a **public privacy-scanner**: anyone can point the
scanner at an arbitrary URL and get a `ScanReport`. That changes the threat model
from "one trusted operator on a token" to "the open internet drives our browser."
Three properties become launch blockers rather than nice-to-haves:

1. **SSRF / DNS-rebinding safety.** A public scanner navigates an attacker-chosen
   URL from our egress. If the egress can be steered at internal, link-local, or
   cloud-metadata addresses, the scanner becomes a confused deputy.
2. **Atomic abuse control.** Rate limits and quotas have to hold under concurrency,
   not just on average.
3. **Durable evidence storage.** Shared report links must survive process restarts
   and scale past a single node.

We have two working scan producers behind the same `ScanResult` seam, and they sit
on opposite sides of these blockers.

### Where the producers stand today

| Capability | Node / Playwright | Cloudflare Worker / Browser Run |
|---|---|---|
| SSRF defense | **connect-time** resolve + validate + **pin** to a public IP via a per-scan local proxy ([lib/public-scan-proxy.ts](../lib/public-scan-proxy.ts)) | DNS-over-HTTPS **preflight only**; Browser Run re-resolves at connect time with no proxy/IP-pin primitive ([cloudflare/worker.ts](../cloudflare/worker.ts)) |
| Open unauthenticated scans | supported behind external egress firewall | **disabled by default**; require `ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK=1` because the preflight can be rebound |
| Shields "tried vs blocked" diff | yes (vendored Brave adblock-wasm) | no |
| Async job queue | yes (in-process) | no |
| Tracker/service catalog | full curated catalog | none |
| Report store | filesystem **or Cloudflare R2** (durable, redeploy-safe) | KV today; R2 code path exists, unprovisioned |

The decisive asymmetry: **the Node path already solves blocker #1, the Worker path
structurally cannot today.** The Worker's preflight-then-reconnect pattern is a
textbook DNS-rebinding window (TTL 0; answer a public A record on the preflight,
a private one on Browser Run's own connection). This is exactly why the README
gates open Worker scans behind a risk-acceptance flag. For a *public* product,
"set the risk flag" is not an option — it is the hole.

## Options

### Option A — Worker-native, Turnstile/token-gated (fast, not fully open)

Ship the Cloudflare Worker as the scanner, but never flip the rebinding-risk flag.
Every scan is gated by Turnstile + (optionally) a token, and KV quotas throttle
volume. Cloudflare WAF rate rules front the endpoint.

- **Pros:** edge-native, zero always-on server, lowest ops. Ships now.
- **Cons:** it is "gated public," not "open public" — a human-verification wall on
  every scan. Still missing Shields, async, and the catalog, which are net-new
  Worker work. The rebinding gap is *contained by gating*, not *closed*.
- **Unlocks:** requires P2 (atomic KV→Durable Object quotas) and P4 (Shields on the
  Worker) to be built from scratch.

### Option B — Node-container scanner, Cloudflare for edge + storage (recommended)

Run the **Node/Playwright scanner as a container** behind a trusted reverse proxy
(the path already documented in the README "Production Deployment" section). Keep
Cloudflare in front for the **static UI, CDN, WAF, and report store** (R2). The
Worker stays available as an optional gated/edge fallback, not the primary path.

- **Pros:** launches on our **most complete and safest** producer. Blocker #1 is
  already solved (connect-time IP pinning), and P4 (Shields diff — our structural
  edge over Blacklight) and the async queue **already exist** in this path, so
  Option B makes them free instead of net-new. One canonical scanner to keep green.
- **Cons:** an always-on container to run, patch, and autoscale (vs. the Worker's
  zero-server model). Egress firewall rules at the host/VPC layer are still the
  required defense-in-depth boundary, as the README already states.
- **Unlocks:** P2 collapses to "reuse the existing Node rate limits + put R2/WAF in
  front"; the Durable Object work is **not needed** for launch. P5 (durable queue)
  is the only remaining scale item, and [docs/scan-job-model.md](scan-job-model.md)
  already sketches its seam.

### Option C — Wait for Browser Run connect-time pinning

Not a plan, a dependency. If/when `@cloudflare/playwright` exposes a proxy or
IP-pinned navigation primitive, Option A's gap closes and Worker-native open scans
become viable. Track upstream; do not block launch on it.

## Decision

**Recommend Option B.** A public scanner cannot ship with an unclosed SSRF/rebinding
window, and Option B is the only path where blocker #1 is *closed* rather than
*gated around* — using code we already wrote and test. It also folds in the two
features (Shields diff, async) that would otherwise be duplicate Worker work, and
it keeps Cloudflare doing what it is unambiguously good at (CDN, WAF, R2, static
hosting) without asking Browser Run to do something it cannot yet do safely.

Option A remains the right choice **only** if a fully serverless edge deployment is
a hard product constraint that outweighs being "open" — in which case accept the
Turnstile wall on every scan and budget P2 + P4 as new Worker work.

## Consequences and sequenced follow-on work

Once Option B is chosen, the roadmap re-collapses:

1. **Container + edge wiring (P1 execution).** Build/ship the Node scanner container
   ([Dockerfile](../Dockerfile) exists; validate with `npm run test:smoke:docker`),
   front it with Cloudflare (WAF + Turnstile at the edge), and keep host/VPC egress
   firewall rules as the SSRF backstop. Step-by-step runbook:
   [deploy-node-container.md](deploy-node-container.md).
2. **Durable report store (P2, reduced).** The Node container now ships an R2
   report-store backend ([lib/report-store-r2.ts](../lib/report-store-r2.ts), enabled
   with `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2`), so this is **provisioning, not
   code**: create the bucket + scoped API token and set the R2 env. Keep filesystem
   for local-dev. Atomic per-client quotas come from the edge (WAF rate rules) plus
   the existing in-process Node limits; the Durable Object counter is deferred unless
   Option A is chosen.
3. **Corpus activation (P3).** Independent of topology — expand
   [public/featured-sites.json](../public/featured-sites.json) (done: 58 sites) and
   run the featured-scan workflow until `public/reports/` clears
   `CORPUS_MIN_SAMPLE = 50` so corpus-relative percentiles switch on.
4. **Shields diff (P4).** Already in the Node path under Option B — surface it as a
   first-class public comparison mode; no Worker port needed.
5. **Durable async queue (P5).** Only when connection-holding scans become the wall;
   follow [docs/scan-job-model.md](scan-job-model.md).

If Option A is chosen instead, steps 2 and 4 become net-new Worker engineering and a
Durable Object replaces the best-effort KV quota counters.

## Litmus test

The deployment is launch-ready for "public" when an unauthenticated request that
resolves to `169.254.169.254`, `127.0.0.1`, or an RFC-1918 host is refused **at the
moment the browser connects**, not just at preflight. Option B passes this today via
the connect-time proxy; Option A passes it only by refusing unauthenticated scans
entirely.
