# Deploying the Node Container Behind Cloudflare (Option B)

> **Status: PARKED (2026-06-21).** This is the *future* path for live, on-demand Shields
> scanning, and it requires **paid compute** — Cloudflare Workers Paid + Containers, or a
> Docker-capable host — none of which is available today. The **current free launch does
> not use this**: the live public product is the **Cloudflare Pages corpus** (published
> Shields-diff evidence) plus the **Worker GPC / trackers scan**. Keep this runbook for
> when paid compute is on the table.

The runbook for the recommended public topology from
[deployment-topology.md](deployment-topology.md): the **Node/Playwright scanner
runs as a container** (it pins to a public IP at connect time, so it closes the
DNS-rebinding window), and **Cloudflare sits in front** for CDN, WAF, Turnstile,
and—when you outgrow a single node—R2.

```
visitor ─▶ Cloudflare (WAF + rate rules + Turnstile + cache)
                 │  proxied DNS, TLS terminated at edge
                 ▼
        Node container  (Next.js + Playwright Chromium)
          /  (scan UI)   /reports/:id  (report pages)   ← B1 serves these too
          /api/scan  /api/scans/:id  /api/reports/:id  /api/health
          per-scan connect-time SSRF proxy  ──▶  public internet only
                 │
                 ▼
        durable report store  (persistent volume, or Cloudflare R2)
```

**Chosen path — B1, single origin.** The container serves *everything* from one
origin: the scan UI (`/`), the API (`/api/*`), and report permalinks
(`/reports/:id`). Visitors hit the Cloudflare-proxied container directly — there is
no separate site and **no cross-origin (CORS) surface to configure**. Steps 1–4 and
6 are the B1 launch path. **Optional (B2):** add a separate static Cloudflare Pages site
as a cached marketing/gallery door whose scan form posts here via
`NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE` — that variant is step 5.

**Recommended launch sequence.** Stand the container up **private/operator-only**
first (token-gated, no public inbound), publish an operator-run **report corpus**
(see [deployment-topology.md](deployment-topology.md) P3) so the site is useful with
zero open-internet abuse surface, and only then decide whether to open
`POST /api/scan` to the public behind Turnstile + the egress backstop below.

## 1. Build and run the container

```bash
docker build -t site-behavior-lab .
docker run --rm -p 3000:3000 \
  --env-file .env.production \
  -v site-behavior-lab-reports:/var/lib/site-behavior-lab/reports \
  site-behavior-lab
```

Validate the container path end to end before exposing it:

```bash
npm run test:smoke:docker
```

## 2. Production environment

Start from [.env.example](../.env.example). For a public-but-safe deployment:

| Variable | Set to | Why |
|---|---|---|
| `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` | a strong secret **or** leave unset | Unset = open scanner; rely on edge Turnstile + WAF (step 3). Set = gated. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_BACKEND` | `filesystem` or `r2` | `filesystem` needs a persistent volume (below). `r2` stores reports in Cloudflare R2 so share links survive **redeploys and host replacement** — the durable, multi-node-ready option. |
| `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` | `/var/lib/site-behavior-lab/reports` | Filesystem backend only. Must be a **persistent volume** or shared reports vanish on restart. |
| `SITE_BEHAVIOR_LAB_R2_*` | bucket, endpoint, key id, secret, prefix | Required when `REPORT_STORE_BACKEND=r2`. Use an R2 API token scoped to the bucket (Object Read & Write). See [.env.example](../.env.example). |
| `SITE_BEHAVIOR_LAB_SCANNER_EGRESS` | a region/network label | Shown in report methodology and JSON export. |
| `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS` | `1` | **Only** once Cloudflare fronts the origin and you block direct origin access (step 3). Without a trusted proxy this lets clients spoof their rate-limit identity. |
| `SITE_BEHAVIOR_LAB_ASYNC_SCANS` | `0` (or `1`) | `1` returns `202 + jobId` so long scans do not hold the HTTP connection. Still single-process/in-memory—fine for one node. |

`/api/health` reports `degraded` until the token, store dir, and egress label are
all set; drive it from your load balancer and alert on `degraded`.

## 3. Put Cloudflare in front

1. Proxy the origin hostname through Cloudflare (orange-cloud DNS), TLS at the edge.
2. **Block direct origin access.** Orange-clouding alone does not hide the origin IP
   (cert logs, historical DNS, and scanners expose it), and an exposed origin lets
   clients bypass your WAF and spoof `x-forwarded-for`. Put the container behind a
   **Cloudflare Tunnel** (`cloudflared`) so it has **no public inbound**, or restrict
   the host firewall to Cloudflare's IP ranges. Do this **before** setting
   `SITE_BEHAVIOR_LAB_TRUST_PROXY_HEADERS=1`.
3. Add **WAF rate-limiting rules** on `POST /api/scan` — this is the atomic abuse
   control the topology decision relies on (it replaces the Worker's best-effort
   KV counters). A GPC/Shields comparison is two visits, so budget accordingly.
4. Optional: enable **Turnstile** at the edge (or keep the in-app token). For an
   open scanner, Turnstile is the human-verification wall that makes "open" safe
   to expose. Note Turnstile only gates the browser UI path; a programmatic
   `POST /api/scan` needs the access token or a per-key quota instead.
5. Cache the static gallery aggressively; never cache `POST /api/scan` responses.

## 4. Lock down egress (defense in depth)

The in-app connect-time proxy refuses non-public targets, but it is **not** the
only line of defense. Enforce host/container/VPC egress firewall rules so Chromium
cannot reach localhost, RFC-1918, link-local, or cloud-metadata
(`169.254.169.254`) even if an application bug slips the in-app guard. This is the
required backstop for any public scanner.

On a cloud host, also harden the instance metadata service directly: require
**IMDSv2** (token + hop limit 1) or disable IMDS for the container, so a slipped
guard cannot reach `169.254.169.254` even if an egress rule is misconfigured.

## 5. Optional: separate static Pages front door (two-origin / B2)

**Skip this for B1 — the container already serves the UI at its own origin.** Do
this only to add a separate cached Pages marketing/gallery door. Build the Pages
artifact pointing at the container origin:

```bash
NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE=https://scan.example.org \
NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL=https://example.org \
npm run build:pages
```

- The UI reads `GET /api/health` and enables the **GPC** and **Shields**
  comparison toggles from `capabilities.gpcComparison` / `capabilities.shieldsComparison`.
  The Node health now advertises both (Shields only when the Brave ad-block engine
  loaded), so the static UI correctly surfaces the Shields "tried vs blocked" diff
  when pointed at this container. Confirm with:

  ```bash
  curl -s https://scan.example.org/api/health | jq '.capabilities'
  # { "singleScan": true, "gpcComparison": true, "shieldsComparison": true, "savedReports": true }
  ```

- If the scanner is intentionally open, also set
  `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_OPEN_ACCESS=1` so the UI hides the access-key field.
- If you gate with edge Turnstile, build with
  `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_TURNSTILE_SITE_KEY=<site-key>`.
- **Cross-origin (CORS).** The Pages UI calls this origin from the browser, so the
  container answers the CORS preflight and sets `Access-Control-Allow-Origin` on
  every `/api` response. Leave `SITE_BEHAVIOR_LAB_ALLOWED_ORIGIN` as `*` for an open
  scanner, or set it to your Pages origin (e.g. `https://sitebehavior.org`) to restrict
  which sites may invoke the scanner from a browser. Serving the UI from the **same**
  origin as the container avoids CORS entirely — the Node app already renders the
  full UI, so the separate Pages front door is optional.

## 6. Verify

```bash
npm run build && npm run start -- --port 3100
BASE_URL=http://127.0.0.1:3100 npm run test:smoke
# add SMOKE_SCAN_ACCESS_TOKEN=<token> if the access token is set
```

Then confirm against the live edge: `/api/health` is `ok`, a scan of a known
tracker-heavy site returns Shields-blocked counts, and a request to a private
target is refused at connection time.

## 7. When one node is not enough (deferred)

Single-node filesystem + in-memory queue is fine to launch. Before horizontal
scaling, replace the report store with shared durable storage (R2/S3) and the
in-process queue with a shared queue, per
[scan-job-model.md](scan-job-model.md). Those are the next *code* items on this
path; everything above is configuration of components that already exist.
