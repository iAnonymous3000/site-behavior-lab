/**
 * Decoupled PDF rendering for Site Behavior Lab v3.
 *
 * Replaces the in-container second Chromium instance (1-slot 503 wall) with:
 *  1. Pure trusted HTML rendering from a redacted `ScanReportV3` (strict CSP,
 *     zero external network loads, HTML-escaped values).
 *  2. Cloudflare Browser Rendering REST API (`/browser-rendering/pdf`) offload
 *     so PDF exports consume zero scanner-container RAM.
 *  3. R2 caching (`v3/pdfs/{reportId}.pdf`) so repeat downloads are instant O(1)
 *     object reads.
 */

import { reportV3Digest } from "../redaction";
import type { ScanReportV3 } from "../schema";
import { pdfBlobKeyV3, type BlobStoreV3 } from "../storage/blob-store";

export type CloudflareBrowserRenderingConfig = {
  accountId: string;
  apiToken: string;
  endpointBase?: string;
};

export type RenderPdfOptionsV3 = {
  cacheStore?: BlobStoreV3;
  cloudflareBrowserRendering?: CloudflareBrowserRenderingConfig;
  fetchImpl?: typeof fetch;
  /** Optional local renderer fallback for self-hosted/non-Cloudflare deployments. */
  localHtmlToPdf?: (html: string) => Promise<Uint8Array>;
};

export type RenderPdfResultV3 = {
  pdf: Uint8Array;
  source: "r2-cache" | "cloudflare-browser-rendering" | "local-fallback";
};

/**
 * Render a self-contained, strict-CSP, XSS-escaped print HTML document for a
 * `ScanReportV3` suitable for Cloudflare Browser Rendering or browser print.
 */
export function renderReportV3PrintHtml(report: ScanReportV3): string {
  const s = report.leadArm.summary;
  const digest = reportV3Digest(report);

  const highlightRows = report.highlights
    .map(
      (h) =>
        `<li class="hl hl-${esc(h.severity)}"><strong>${esc(h.title)}</strong><div>${esc(h.detail)}</div></li>`
    )
    .join("");

  const entityRows = s.topEntities
    .map(
      (e) =>
        `<tr><td>${esc(e.entity)}</td><td>${esc(e.parentOrg)}</td><td>${esc(e.category)}</td><td class="num">${e.requests}</td><td class="num">${e.domains}</td></tr>`
    )
    .join("");

  const beaconRows = report.leadArm.beacons
    .map(
      (b) =>
        `<tr><td>${esc(b.platform)}</td><td>${esc(b.endpointHost)}</td><td>${b.serverSideTagging ? "Yes (1st-party)" : "No"}</td><td>${esc(b.events.join(", "))}</td><td>${esc(b.identifierCategories.join(", ") || "—")}</td></tr>`
    )
    .join("");

  const comparisonRows = report.comparisons
    .map(
      (c) =>
        `<tr><td>${esc(c.axis)}</td><td class="num">${signed(c.requestsDelta)}</td><td class="num">${signed(c.thirdPartyDomainsDelta)}</td><td class="num">${signed(c.cookiesDelta)}</td><td class="num">${c.shieldsBlockedCount}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>Site Behavior Lab Report — ${esc(report.canonicalDomain)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111827; font-size: 11px; line-height: 1.45; margin: 0; }
  header { border-bottom: 2px solid #111827; padding-bottom: 10px; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #4b5563; font-size: 10px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
  .card { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px; }
  .card .val { font-size: 16px; font-weight: 700; }
  .card .lbl { font-size: 9px; color: #6b7280; text-transform: uppercase; }
  h2 { font-size: 13px; margin: 14px 0 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 3px; }
  ul.hl-list { list-style: none; padding: 0; margin: 0; }
  li.hl { border-left: 3px solid #6b7280; padding: 6px 8px; margin-bottom: 6px; background: #f9fafb; }
  li.hl-critical { border-left-color: #dc2626; background: #fef2f2; }
  li.hl-high { border-left-color: #ea580c; background: #fff7ed; }
  li.hl-medium { border-left-color: #d97706; background: #fffbeb; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 10px; }
  th, td { border-bottom: 1px solid #e5e7eb; padding: 4px 6px; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 16px; padding-top: 8px; border-top: 1px solid #d1d5db; font-size: 9px; color: #6b7280; }
</style>
</head>
<body>
  <header>
    <h1>${esc(report.canonicalDomain)} — Privacy &amp; Behavior Evidence</h1>
    <div class="meta">
      Report ID: ${esc(report.reportId)} · Scanned: ${esc(report.scannedAt)} · Region: ${esc(report.provenance.egressRegion)} · Device: ${esc(report.leadArm.conditions.device)}
    </div>
    <div class="meta">Final URL: ${esc(report.finalUrl)} · Outcome: ${esc(report.leadArm.loadOutcome)} (HTTP ${report.leadArm.httpStatus ?? "n/a"})</div>
  </header>

  <section class="grid">
    <div class="card"><div class="val">${s.thirdPartyDomains}</div><div class="lbl">Third-Party Domains</div></div>
    <div class="card"><div class="val">${s.trackingRequests} / ${s.totalRequests}</div><div class="lbl">Tracking / Total Req</div></div>
    <div class="card"><div class="val">${s.cookiesTotal} (${s.longLivedCookies} &gt;30d)</div><div class="lbl">Cookies</div></div>
    <div class="card"><div class="val">${s.darkPatternScore}/100</div><div class="lbl">CMP Dark Pattern Score</div></div>
  </section>

  <h2>Key Observed Behaviors</h2>
  <ul class="hl-list">${highlightRows || "<li>No elevated behavioral signals observed.</li>"}</ul>

  ${
    entityRows
      ? `<h2>Top Entities &amp; Corporate Groups (${s.distinctEntities} entities / ${s.distinctParentOrgs} parent orgs)</h2>
  <table><thead><tr><th>Entity</th><th>Parent Org</th><th>Category</th><th class="num">Requests</th><th class="num">Domains</th></tr></thead><tbody>${entityRows}</tbody></table>`
      : ""
  }

  ${
    beaconRows
      ? `<h2>Decoded Beacons &amp; Server-Side Tagging</h2>
  <table><thead><tr><th>Platform</th><th>Endpoint Host</th><th>Server-Side</th><th>Events</th><th>Identifier Fields</th></tr></thead><tbody>${beaconRows}</tbody></table>`
      : ""
  }

  ${
    comparisonRows
      ? `<h2>Intervention Comparisons (vs. Baseline)</h2>
  <table><thead><tr><th>Intervention</th><th class="num">Requests Δ</th><th class="num">3P Domains Δ</th><th class="num">Cookies Δ</th><th class="num">Shields Blocked</th></tr></thead><tbody>${comparisonRows}</tbody></table>`
      : ""
  }

  <footer>
    Site Behavior Lab v3 (${esc(report.provenance.scannerVersion)}, commit ${esc(report.provenance.buildCommit)}).
    Canonical SHA-256: ${esc(digest)}.
    Evidence reflects one controlled visit; cookie values, storage values, and query strings are never persisted.
  </footer>
</body>
</html>`;
}

/**
 * Render (or retrieve cached) PDF bytes for a `ScanReportV3`.
 * Order of execution:
 *  1. R2 cache (`v3/pdfs/{reportId}.pdf`) -> instant O(1) hit
 *  2. Cloudflare Browser Rendering `/browser-rendering/pdf` REST API -> offloads Chromium off container
 *  3. Optional `localHtmlToPdf` fallback for standalone self-hosting
 */
export async function renderReportV3Pdf(
  report: ScanReportV3,
  options: RenderPdfOptionsV3 = {}
): Promise<RenderPdfResultV3> {
  const cacheKey = pdfBlobKeyV3(report.reportId);

  if (options.cacheStore) {
    const cached = await options.cacheStore.getBinary(cacheKey);
    if (cached && cached.byteLength > 0) {
      return { pdf: cached, source: "r2-cache" };
    }
  }

  const html = renderReportV3PrintHtml(report);

  if (options.cloudflareBrowserRendering) {
    const cfg = options.cloudflareBrowserRendering;
    const base = (cfg.endpointBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    const url = `${base}/accounts/${encodeURIComponent(cfg.accountId)}/browser-rendering/pdf`;
    const fetchFn = options.fetchImpl ?? fetch;

    const resp = await fetchFn(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.apiToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        html,
        pdfOptions: {
          format: "a4",
          printBackground: true,
          preferCSSPageSize: true
        }
      })
    });

    if (!resp.ok) {
      throw new Error(`Cloudflare Browser Rendering PDF failed with HTTP ${resp.status}`);
    }
    const pdf = new Uint8Array(await resp.arrayBuffer());
    if (options.cacheStore) {
      await options.cacheStore.putBinary(cacheKey, pdf, "application/pdf").catch(() => {});
    }
    return { pdf, source: "cloudflare-browser-rendering" };
  }

  if (options.localHtmlToPdf) {
    const pdf = await options.localHtmlToPdf(html);
    if (options.cacheStore) {
      await options.cacheStore.putBinary(cacheKey, pdf, "application/pdf").catch(() => {});
    }
    return { pdf, source: "local-fallback" };
  }

  throw new Error("No PDF renderer configured (configure Cloudflare Browser Rendering or localHtmlToPdf fallback)");
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
