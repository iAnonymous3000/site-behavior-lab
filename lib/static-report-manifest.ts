import { isReservedReportDomain } from "./reserved-report-domains";
import { buildReportFacts } from "./report-facts";
import { buildReportHeadline } from "./report-headline";
import {
  displayRunView,
  requestEvidenceState,
  runHitRequestRecordingCap,
  toReportView,
  type ReportView
} from "./scan-report-views";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  StaticReportBundleError
} from "./static-report-files";
import type { StaticReportManifest, StaticReportManifestEntry } from "./types";
import { comparisonHistoryPairingKey, temporalPairingKey } from "./temporal-deltas";
import {
  comparisonHistoryCohortForStoredReport,
  consentClicksForView,
  temporalCohortForStoredReport
} from "./temporal-report-identity";
import type { StoredScanReport } from "./scan-report-reader";
import { sha256Hex } from "./sha256";

/**
 * Builds the static gallery manifest (public/reports/index.json) from the
 * committed report corpus. Recognition goes through the canonical
 * version-aware deep reader (RFC 14.8) and the entry derives from the
 * version-independent VIEW, so every readable generation joins the gallery: a
 * malformed or unmanaged report fails the managed-corpus build instead of
 * silently disappearing. Metrics are the validated summary numbers verbatim,
 * never a silently zero-coerced guess.
 *
 * Node-only module (filesystem); used by the CLI wrapper the build scripts and
 * workflows invoke. Never imported by app, worker, or browser code.
 */

export type ManifestBuildResult = {
  manifest: StaticReportManifest;
  /** One line per skipped file, already formatted for the build log. */
  warnings: string[];
};

export async function buildStaticReportManifest(reportsDir: string, now = new Date()): Promise<ManifestBuildResult> {
  const warnings: string[] = [];
  const entries: StaticReportManifestEntry[] = [];

  const dangling = await listDanglingStaticSidecarIds(reportsDir);
  if (dangling.length > 0) throw new StaticReportBundleError(dangling[0], "dangling-sidecar");

  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const read = await readStaticReportBundle(reportsDir, id);
    if (read.outcome !== "found") {
      throw new StaticReportBundleError(id, read.outcome === "not-found" ? "missing-report" : read.reason);
    }

    const view = toReportView(read.stored);
    const entry = toManifestEntry(id, read.stored, view, read.wire);
    if (!entry) continue;
    entries.push(entry);
  }

  entries.sort((a, b) => Date.parse(b.scannedAt) - Date.parse(a.scannedAt));
  return { manifest: { generatedAt: now.toISOString(), reports: entries }, warnings };
}

function toManifestEntry(
  id: string,
  stored: StoredScanReport,
  view: ReportView,
  reportWire: string
): StaticReportManifestEntry | null {
  // Cards summarize the baseline (the plain "off" state) so a Shields card
  // shows what the site tried, not the blocked residual; the blocked count is
  // surfaced separately. The v1 producer wrote the comparison root's
  // requestedUrl/device from the VARIANT arm, so those two stay variant-fed
  // for byte parity with the committed manifest.
  const lead = displayRunView(view);
  const tail = view.runs[view.runs.length - 1];
  if (!lead) return null;
  const comparison = view.reportType === "comparison";

  // Keep reserved/test domains (example.com fixtures, localhost) out of the
  // public gallery.
  if (isReservedReportDomain(lead.domain)) return null;

  const comparisonType = comparison
    ? view.comparison?.axis ?? (view.comparison?.temporalPair ? ("temporal" as const) : ("custom" as const))
    : undefined;
  const historyKey = temporalPairingKey({
    domain: lead.domain,
    reportType: view.reportType,
    comparisonType,
    consentClicks: consentClicksForView(view),
    requestedUrl: lead.conditions.requestedUrl,
    finalUrl: lead.conditions.finalUrl,
    temporalCohort: temporalCohortForStoredReport(stored, view)
  });
  const comparisonHistoryKey = comparisonHistoryPairingKey({
    domain: lead.domain,
    reportType: view.reportType,
    comparisonType,
    consentClicks: consentClicksForView(view),
    requestedUrl: lead.conditions.requestedUrl,
    finalUrl: lead.conditions.finalUrl,
    comparisonHistoryCohort: comparisonHistoryCohortForStoredReport(stored, view)
  });
  const reportFacts = buildReportFacts(view);
  const headline = buildReportHeadline(view, reportFacts);
  const leadFacts = reportFacts.display;

  return {
    id,
    reportWireBytes: new TextEncoder().encode(reportWire).byteLength,
    reportWireSha256: sha256Hex(reportWire),
    title: (view.title ?? "").trim() || lead.pageTitle || lead.domain,
    headline: headline.headline,
    tone: headline.tone,
    domain: headline.domain,
    requestedUrl: (comparison ? tail : lead).conditions.requestedUrl,
    scannedAt: view.scannedAt ?? "",
    reportType: view.reportType,
    ...(comparison
      ? {
          comparisonType
        }
      : {}),
    device: (comparison ? tail : lead).conditions.viewport.isMobile ? "mobile" : "desktop",
    gpcEnabled: comparison ? "comparison" : lead.conditions.gpcEnabled,
    ...(runHitRequestRecordingCap(lead) ? { requestCapped: true } : {}),
    requestEvidenceComplete: requestEvidenceState(lead) === "complete",
    ...(historyKey ? { historyKey } : {}),
    ...(comparisonHistoryKey ? { comparisonHistoryKey } : {}),
    metrics: {
      totalRequests: lead.counts.totalRequests,
      thirdPartyRequests: lead.counts.thirdPartyRequests,
      knownTrackerRequests: lead.counts.knownTrackerRequests,
      thirdPartyDomains: lead.counts.thirdPartyDomains,
      cookies: lead.counts.cookies,
      thirdPartyCookies: lead.counts.thirdPartyCookies,
      ...(leadFacts.claims["fingerprint-apis"].exactCountAllowed
        ? { fingerprintEvents: lead.counts.fingerprintEvents }
        : {}),
      ...(lead.counts.shieldsBlockedRequests !== null ? { shieldsBlockedRequests: lead.counts.shieldsBlockedRequests } : {})
    }
  };
}
