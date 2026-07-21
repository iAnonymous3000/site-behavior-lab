# Security Policy

Site Behavior Lab launches a real browser and makes outbound network requests to
attacker-influenced URLs. That makes a few classes of bug security-relevant. We
take them seriously and appreciate responsible disclosure.

## Reporting a vulnerability

Please do not disclose security problems publicly before there is a fix or
mitigation. Use the repository's
[private vulnerability report](https://github.com/iAnonymous3000/site-behavior-lab/security/advisories/new).
Do not put a vulnerability, personal data, access token, or sensitive
unredacted URL in a public issue.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a target URL or payload, if applicable).
- Affected version/commit.

We aim to acknowledge reports within a few days and to ship a fix or mitigation
as quickly as is practical for a volunteer-maintained project.

## Areas of particular interest

- **SSRF / network-boundary escapes.** The scanner must never reach localhost,
  private, link-local, or reserved ranges. Of special interest: DNS rebinding,
  redirect chains to private targets, and IPv6/encoded-host bypasses. See
  [`lib/url-safety.ts`](lib/url-safety.ts). The Node scanner routes all browser
  HTTP(S) traffic through a per-scan local proxy that re-resolves each host,
  validates every answer, and pins the connection to a verified public IP at
  connect time ([`lib/public-scan-proxy.ts`](lib/public-scan-proxy.ts)), so a
  rebinding answer after the preflight cannot redirect the browser to a private
  address. The legacy Browser Run worker has only preflight DNS checks (no
  connect-time pinning), which is why its config defaults to gated. Bypasses of
  the pinning proxy are exactly what we want to hear about.
- **Data leakage.** Raw cookie/storage *values* or PII appearing in reports,
  exports, or logs. Cookie values are omitted. Storage values are omitted while
  their byte counts may remain. Report URLs omit credentials and fragments;
  query values always drop, and only reviewed exact query-key literals may
  survive, with all others generalized. Shareable
  reports are persisted as screenshot-stripped JSON under the configured
  filesystem or R2 report store. Report links use random IDs and report reads are
  rate-limited. Public and horizontally scaled deployments should use a protected
  shared store such as R2; the reference deployment does.
- **Resource exhaustion.** Crashing or hanging the server via a hostile target.
  The app includes basic request-size, rate, concurrency, scan-duration, and
  per-scan request-count guardrails. The Node scanner also blocks Service
  Workers and independently caps proxy transactions, unique network targets,
  response bytes, and upload bytes; an HTTPS CONNECT tunnel is one opaque proxy
  transaction, so the byte caps remain the bound inside a reused tunnel. GPC,
  Shields, and consent comparisons each
  consume two rate-limit tokens but occupy one scan slot until both sequential
  visits finish. The configured report store prunes by age and count. Node keeps a
  per-process defense; the reference Containers deployment additionally charges
  its minute and day quotas atomically in Durable Object SQLite and uses edge WAF
  controls. Other public or horizontally scaled deployments still need an
  equivalent external limit.
- **Unauthorized scanner use.** Operator-only deployments should set
  `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` or enforce equivalent upstream access.
  An intentionally open Containers deployment must instead use Turnstile plus
  atomic quotas and edge abuse controls. A token or human check is a deployment
  control, not a complete abuse-prevention system; pair it with proxy, firewall,
  and monitoring limits.
  Legacy Browser Run Worker deployments stay gated unless operators explicitly set both
  `SITE_BEHAVIOR_LAB_ALLOW_UNAUTHENTICATED_SCANS=1` and
  `SITE_BEHAVIOR_LAB_ACCEPT_BROWSER_RUN_DNS_REBINDING_RISK=1`, acknowledging
  that Browser Run currently has only DNS-over-HTTPS preflight checks rather
  than Node's connect-time DNS pinning proxy.

## Scope and acceptable use

This tool is for inspecting **publicly reachable websites** for transparency,
research, journalism, and compliance. It is **not** a tool for attacking,
brute-forcing, or scanning systems you do not own or have permission to test.
Operators of public deployments are responsible for rate limiting and abuse
prevention. Production hosts should also enforce outbound network policy outside
the Node process so private, metadata, and internal networks remain unreachable
even if an application-layer SSRF bypass is discovered. The reference Cloudflare
Containers deployment currently relies on its connect-time pinning proxy because
the platform's internet-disable mode also blocks that proxy's pinned raw-TCP
connections; a compatible platform egress backstop remains defense-in-depth work.
