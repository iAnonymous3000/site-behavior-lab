# Security Policy

Site Behavior Lab launches a real browser and makes outbound network requests to
attacker-influenced URLs. That makes a few classes of bug security-relevant. We
take them seriously and appreciate responsible disclosure.

## Reporting a vulnerability

Please do not disclose security problems publicly before there is a fix or
mitigation. Use GitHub's private vulnerability reporting if it is enabled on the
repository, or contact the maintainer privately.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (a target URL or payload, if applicable).
- Affected version/commit.

We aim to acknowledge reports within a few days and to ship a fix or mitigation
as quickly as is practical for a volunteer-maintained project.

## Areas of particular interest

- **SSRF / network-boundary escapes.** The scanner must never reach localhost,
  private, link-local, or reserved ranges. Of special interest: DNS rebinding
  (the Node-side allow-check and the browser's own resolver are separate), redirect
  chains to private targets, and IPv6/encoded-host bypasses. See
  [`lib/url-safety.ts`](lib/url-safety.ts). Browser-routed HTTP(S) requests are
  re-checked before they continue, but current host verification does not pin DNS
  answers into Chromium and is not a complete DNS-rebinding defense.
- **Data leakage.** Raw cookie/storage *values* or PII appearing in reports,
  exports, or logs. Values are intentionally redacted to byte counts, and report
  URLs omit credentials and fragments. Third-party request logs preserve query
  parameter names as evidence, but redact parameter values. Shareable
  reports are persisted as JSON under the configured filesystem report store,
  with inline screenshots stripped from the stored copy. Report links use random
  IDs and report reads are rate-limited, but protect or replace that store for
  public or horizontally scaled deployments.
- **Resource exhaustion.** Crashing or hanging the server via a hostile target.
  The app includes basic request-size, rate, concurrency, scan-duration, and
  per-scan request-count guardrails. GPC comparisons consume two rate-limit
  tokens but still occupy one scan slot until both sequential visits finish. The
  local report store prunes by age and count. Limits are in-memory per Node
  process. Public or horizontally scaled deployments may still need external
  limits.
- **Unauthorized scanner use.** Public deployments should set
  `SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN` or enforce an equivalent upstream access
  control before `/api/scan`. The token gate is a deployment control, not a full
  abuse-prevention system; pair it with proxy, firewall, and monitoring limits.
  Cloudflare Worker deployments stay gated unless operators explicitly set both
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
even if an application-layer SSRF bypass is discovered.
