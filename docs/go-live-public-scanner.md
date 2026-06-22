# Go live: opening the public Shields scanner

This runbook takes the full Node/Playwright scanner (the path that runs **live
Brave Shields**, tried-vs-blocked) from operator-gated to a **public** front door
on [sitebehavior.org](https://sitebehavior.org), behind Cloudflare Turnstile and
rate limiting.

It assumes the scanner is already deployed on Cloudflare Containers per
[deploy-cloudflare-containers.md](deploy-cloudflare-containers.md). The Containers
front Worker (`cloudflare/container-worker.ts`) is the enforcement point: it
applies the access-token / Turnstile / KV rate-limit gate (shared with the
Browser Run worker via [`lib/edge-scan-gate.ts`](../lib/edge-scan-gate.ts))
**before** any request reaches the container's real Chromium.

> **Why this needs care.** Each public scan launches a real browser against a
> caller-chosen URL: it costs container compute/egress and is an abuse magnet.
> The connect-time DNS proxy in the Node scanner is the SSRF backstop (unlike
> Browser Run, the container pins DNS at connect time, so opening it does **not**
> require the DNS-rebinding risk flag). Turnstile + the KV rate limit + a
> Cloudflare WAF rule are the cost/abuse controls. The KV counter is best-effort
> (read-then-write, not atomic), so the WAF rate-limit rule is the hard cap.

## Gating model

The front Worker chooses one of three postures from its config:

| Posture | Config | Behavior |
|---|---|---|
| **Gated** (default) | `SCAN_ACCESS_TOKEN` secret set | Only callers with the token can scan. |
| **Public** | no token + `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` | Anyone can scan; Turnstile (if `TURNSTILE_SECRET_KEY` set) **and** the KV rate limit are enforced. |
| **Refused** | no token + not opened | `/api/scan` returns `503` — an unconfigured scanner is never silently world-open. |

## Pre-flight

1. Confirm the gated scanner is healthy and reachable:

   ```bash
   SCAN_BASE_URL=https://<scanner>.workers.dev \
   SMOKE_SCAN_ACCESS_TOKEN=<token> \
   npm run test:smoke:scanner
   ```

2. Confirm `GET /api/health` returns `ok: true` and advertises the Shields
   comparison capability.

## Open it to the public

1. **Create a Turnstile site** in the Cloudflare dashboard (Turnstile → Add site,
   pointed at `sitebehavior.org`). Note the **site key** (public) and **secret
   key**.

2. **Create the rate-limit KV namespace** and wire it in
   [`wrangler.container.jsonc`](../wrangler.container.jsonc):

   ```bash
   npx wrangler kv namespace create site-behavior-lab-scanner-rate-limits
   ```

   Uncomment the `kv_namespaces` binding and paste the returned id.

3. **Set the open-access vars** in `wrangler.container.jsonc` (uncomment
   `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` and the optional per-minute /
   per-day limits). Make sure **no** `SCAN_ACCESS_TOKEN` secret is set on this
   Worker — a token forces the gated posture.

4. **Set the Turnstile secret** so the gate verifies tokens:

   ```bash
   npx wrangler secret put TURNSTILE_SECRET_KEY -c wrangler.container.jsonc
   ```

5. **Deploy the front Worker:**

   ```bash
   npm run cf:container:deploy
   ```

6. **Add a Cloudflare WAF / rate-limiting rule** on the scanner route as the hard
   cap (the KV counter is best-effort). Throttle `POST /api/scan` per client IP to
   a ceiling above the in-app per-minute limit, and consider a managed challenge
   for known-bot ASNs.

7. **Point the public site at the scanner.** Rebuild and deploy Cloudflare Pages
   with:

   - `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` = the scanner origin
   - `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY` = the Turnstile **site
     key** (the static UI renders the widget and sends its token; without it the
     scan button stays disabled with an explanation)

   Optionally map a custom domain (`scan.sitebehavior.org`) to the Worker first
   and use that as the API base.

## Verify

1. `GET <scanner>/api/health` → `ok: true`, `openAccess: true`, `turnstile: true`.
2. From sitebehavior.org, complete the Turnstile challenge and run a real scan;
   confirm a report renders with the live Shields (tried-vs-blocked) diff.
3. Confirm a request **without** a Turnstile token is rejected (`400`), and that
   exceeding the per-minute limit returns `429`.
4. Re-run the smoke test against the public origin (no token):

   ```bash
   SCAN_BASE_URL=https://<scanner-origin> npm run test:smoke:scanner
   ```

## Roll back

Either set the `SCAN_ACCESS_TOKEN` secret again, or remove
`SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS` from `vars`, then
`npm run cf:container:deploy`. To take the live form off the public site, redeploy
Pages without `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE`; the static gallery and
the committed Shields corpus keep working unchanged.

## Operate

- Watch container compute/egress cost and `max_instances`; lower `sleepAfter` to
  save cost or raise it to cut cold starts.
- Alert on `/api/health` `status: degraded` (includes the ad-block engine load
  state used for Shields).
- Tune `SITE_BEHAVIOR_LAB_PUBLIC_SCAN_RATE_LIMIT_PER_MINUTE` / `_PER_DAY` and the
  WAF rule together as real traffic arrives.
