# Deployment Topology Decision

> Status: **Option B DEPLOYED, 2026-06-21; Browser Run Worker retired and deleted
> from Cloudflare 2026-07-09, and its source deleted from this repo 2026-07-24.**
> The comparison below is kept as the decision record for why the Node container
> is the only supported producer; the Worker code it describes no longer exists.
> Workers Paid is active, and the recommended Node/Playwright container (Option B
> below) runs on **Cloudflare Containers** at `scan.sitebehavior.org` (public behind
> Turnstile and rate limits, with R2-backed report storage), so the Shields
> tried-vs-blocked "moat-on-demand" is live (runbook:
> [deploy-cloudflare-containers.md](deploy-cloudflare-containers.md)). The public front
> door is the static **Cloudflare Pages** site at https://sitebehavior.org (the
> published Shields-diff evidence corpus) with its scan-API base pointed at the
> container. The Cloudflare **Browser Run Worker** is retired: its
> preflight-only DNS check cannot pin the browser's eventual connection, so its
> deployment was deleted from Cloudflare on 2026-07-09. The code stays in-repo only
> for gated legacy self-hosting and ships with no `workers.dev` alias; it is not a
> production fallback or a second live lane. The analysis below is the
> decision record that led to Option B, keep it. Production currently routes to
> one warm singleton container. Bounded durable-execution sharding is implemented
> but separately flag-gated until durable jobs are live and proven; shard zero
> reuses that singleton, so `max_instances = 3` covers the complete topology.

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

| Capability | Node / Playwright (current) | Browser Run Worker (deleted 2026-07-24) |
|---|---|---|
| SSRF defense | **connect-time** resolve + validate + **pin** to a public IP via a per-scan local proxy ([lib/public-scan-proxy.ts](../lib/public-scan-proxy.ts)) | DNS-over-HTTPS **preflight only**; Browser Run re-resolved at connect time with no proxy/IP-pin primitive, which is why the worker was deleted rather than kept gated |
| Open unauthenticated scans | supported behind external egress firewall | were disabled unless an operator waived the rebinding risk explicitly; the waiver flag was deleted with the worker |
| Shields "tried vs blocked" diff | yes (vendored Brave adblock-wasm) | no |
| Async job queue | yes (in-process) | no |
| Tracker/service catalog | full curated catalog | none |
| Report store | filesystem **or Cloudflare R2** (durable, redeploy-safe) | KV today; R2 code path exists, unprovisioned |

The decisive asymmetry: **the Node path already solves blocker #1, the Worker path
structurally cannot today.** The Worker's preflight-then-reconnect pattern is a
textbook DNS-rebinding window (TTL 0; answer a public A record on the preflight,
a private one on Browser Run's own connection). This is exactly why the README
gates open Worker scans behind a risk-acceptance flag. For a *public* product,
"set the risk flag" is not an option, it is the hole.

## Options

### Option A, Worker-native, Turnstile/token-gated (fast, not fully open)

Ship the Cloudflare Worker as the scanner, but never flip the rebinding-risk flag.
Every scan is gated by Turnstile + (optionally) a token, and KV quotas throttle
volume. Cloudflare WAF rate rules front the endpoint.

- **Pros:** edge-native, zero always-on server, lowest ops. Ships now.
- **Cons:** it is "gated public," not "open public", a human-verification wall on
  every scan. Still missing Shields, async, and the catalog, which are net-new
  Worker work. The rebinding gap is *contained by gating*, not *closed*.
- **Unlocks:** requires P2 (atomic KV→Durable Object quotas) and P4 (Shields on the
  Worker) to be built from scratch.

### Option B, Node-container scanner, Cloudflare for edge + storage (recommended)

Run the **Node/Playwright scanner as a container** behind a trusted reverse proxy
(the path already documented in the README "Production Deployment" section). Keep
Cloudflare in front for the **static UI, CDN, WAF, and report store** (R2). The
Browser Run code has now been deleted outright rather than kept as a gated edge
fallback or part of the production topology.

- **Pros:** launches on our **most complete and safest** producer. Blocker #1 is
  already solved (connect-time IP pinning), and P4 (Shields diff, our structural
  edge over Blacklight) and the async queue **already exist** in this path, so
  Option B makes them free instead of net-new. One canonical scanner to keep green.
- **Cons:** an always-on container to run, patch, and autoscale (vs. the Worker's
  zero-server model). A host/VPC egress firewall is the required independent
  defense-in-depth boundary where the platform can support it. The current
  Cloudflare Containers raw-TCP proxy path relies on its in-app connect-time guard;
  a compatible independent egress backstop remains explicit operator follow-up.
- **Unlocks:** P2 collapsed to R2 plus layered limits. Since launch, the front
  Worker has added an atomic Durable Object SQLite quota and a bounded durable
  IDs-only recovery registry. Full execution replay is staged behind its live
  gate; bounded horizontal execution sharding is implemented behind a second,
  post-durability gate documented in [scan-job-model.md](scan-job-model.md).

### Option C, Wait for Browser Run connect-time pinning

Not a plan, a dependency. If/when `@cloudflare/playwright` exposes a proxy or
IP-pinned navigation primitive, Option A's gap closes and Worker-native open scans
become viable. Track upstream; do not block launch on it.

## Decision

**Recommend Option B.** A public scanner cannot ship with an unclosed SSRF/rebinding
window, and Option B is the only path where blocker #1 is *closed* rather than
*gated around*, using code we already wrote and test. It also folds in the two
features (Shields diff, async) that would otherwise be duplicate Worker work, and
it keeps Cloudflare doing what it is unambiguously good at (CDN, WAF, R2, static
hosting) without asking Browser Run to do something it cannot yet do safely.

Option A remains the right choice **only** if a fully serverless edge deployment is
a hard product constraint that outweighs being "open", in which case accept the
Turnstile wall on every scan and budget P2 + P4 as new Worker work.

## Consequences and sequenced follow-on work

Once Option B is chosen, the roadmap re-collapses (**executed 2026-06-21:** P1 container
deploy + P2 R2 store; P3 corpus active; P4 Shields runs live on the container.
**Executed 2026-06-22:** live Shields on the public front door at scan.sitebehavior.org,
open access behind edge WAF/Turnstile. **Executed by 2026-07-13:** atomic Durable
Object quotas and the Phase-1 IDs-only job recovery registry. **Implemented but
operator-gated:** Phase-2 execution leases/replay, followed by bounded execution
sharding beyond the singleton container):

1. **Container + edge wiring (P1 execution).** Build/ship the Node scanner container
   ([Dockerfile](../Dockerfile) exists; validate with `npm run test:smoke:docker`),
   front it with Cloudflare (WAF + Turnstile at the edge), verify the external WAF
   ceiling, and preserve an independent host/VPC egress backstop wherever the
   platform supports one. The Cloudflare Containers exception and its still-open
   compatible-egress follow-up are documented in the step-by-step runbook:
   [deploy-node-container.md](deploy-node-container.md).
2. **Durable report store (P2, reduced).** The Node container now ships an R2
   report-store backend ([lib/report-store-r2.ts](../lib/report-store-r2.ts), enabled
   with `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND=r2`), so this is **provisioning, not
   code** and is complete in production: the bucket, scoped token, and R2 env are
   provisioned. Keep filesystem for local development. Atomic per-client quotas
   come from the front Worker's Durable Object SQLite transaction, backed by WAF
   and the existing in-process Node limits.
3. **Corpus activation (P3).** Independent of topology, expand
   [public/featured-sites.json](../public/featured-sites.json) (81 curated sites)
   and run the featured-scan workflow. Repository-dispatch production is
   unconditionally r2; the scheduled refresh is r2 once the controlled runner
   variable `FEATURED_RUNNER_LABEL` is configured and otherwise takes a loudly
   disclosed frozen-v1 fallback. Deliberate frozen v1 is an explicit manual
   compatibility lane. The committed corpus has cleared
   `CORPUS_MIN_SAMPLE = 50`, so corpus-relative percentiles are active.
4. **Shields diff (P4).** Already in the Node path under Option B, surface it as a
   first-class public comparison mode; no Worker port needed.
5. **Durable async jobs (P5).** Phase 1 recovers completed R2 reports after a
   process restart. Phase 2 durable payloads, fenced leases, replay, and bounded
   execution sharding are implemented behind independent activation gates; the
   replay canaries and production flag changes remain operator work. Follow
   [scan-job-model.md](scan-job-model.md).

If Option A is chosen instead, steps 2 and 4 become net-new Worker engineering and a
Durable Object replaces the best-effort KV quota counters.

## Litmus test

The deployment is launch-ready for "public" when an unauthenticated request that
resolves to `169.254.169.254`, `127.0.0.1`, or an RFC-1918 host is refused **at the
moment the browser connects**, not just at preflight. Option B passes this today via
the connect-time proxy; Option A passes it only by refusing unauthenticated scans
entirely.
