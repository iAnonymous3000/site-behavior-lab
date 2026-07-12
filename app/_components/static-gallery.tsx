"use client";

import { ExternalLink, FileJson, Loader2, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { clientReportRuntime, staticAssetPath } from "../client-runtime";
import { FileUploadButton } from "./file-upload-button";
import { comparableSubjectHosts, comparisonEligibility } from "@/lib/comparison-eligibility";
import { legacyComparisonDecision } from "@/lib/comparison-decision";
import { createTemporalComparisonReport, orderTemporalPair } from "@/lib/compare-reports";
import { domainsMatch, isFeaturedSiteConfig, type FeaturedSite, type FeaturedSiteConfig } from "@/lib/featured-sites";
import { committedReportLocation } from "@/lib/report-locator";
import { readLoadedReport } from "@/lib/client-report-reader";
import { plural } from "@/lib/text-format";
import type { ComparisonScanResult, ScanDevice, ScanResult, StaticReportManifestEntry } from "@/lib/types";

/**
 * The committed-report surfaces of the static export: the curated "Start here"
 * gallery, the saved-report archive with filters, and the temporal comparison
 * tools. Split from the app shell so the shell stays focused on scanning and
 * report rendering.
 */

const FEATURED_MAX_PER_CATEGORY = 4;
const FEATURED_MAX_TOTAL = 12;
const ARCHIVE_PAGE_SIZE = 24;

type FeaturedGroup = {
  category: FeaturedSiteConfig["categories"][number];
  items: { site: FeaturedSite; entry: StaticReportManifestEntry }[];
};

function pickFeaturedEntry(
  reports: StaticReportManifestEntry[],
  site: FeaturedSite,
  used: Set<string>
): StaticReportManifestEntry | null {
  const matches = reports.filter((report) => !used.has(report.id) && domainsMatch(report.domain, site.domain));
  if (matches.length === 0) return null;

  // Prefer comparisons (the GPC off/on gotcha makes the strongest card), then newest.
  return matches.sort((a, b) => {
    const aRank = a.reportType === "comparison" ? 0 : 1;
    const bRank = b.reportType === "comparison" ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return Date.parse(b.scannedAt) - Date.parse(a.scannedAt);
  })[0];
}

function buildFeaturedGroups(config: FeaturedSiteConfig, reports: StaticReportManifestEntry[]): FeaturedGroup[] {
  const used = new Set<string>();
  const groups: FeaturedGroup[] = [];
  let total = 0;

  for (const category of config.categories) {
    if (total >= FEATURED_MAX_TOTAL) break;

    const items: FeaturedGroup["items"] = [];
    for (const site of config.sites.filter((candidate) => candidate.category === category.id)) {
      if (items.length >= FEATURED_MAX_PER_CATEGORY || total >= FEATURED_MAX_TOTAL) break;
      const entry = pickFeaturedEntry(reports, site, used);
      if (!entry) continue;
      used.add(entry.id);
      items.push({ site, entry });
      total += 1;
    }

    if (items.length > 0) groups.push({ category, items });
  }

  return groups;
}

function FeaturedGallery({ reports }: { reports: StaticReportManifestEntry[] }) {
  const [config, setConfig] = useState<FeaturedSiteConfig | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      try {
        const response = await fetch(staticAssetPath("/featured-sites.json"), { cache: "no-store" });
        if (!response.ok) throw new Error("Featured config unavailable.");
        const payload = (await response.json()) as unknown;
        if (!cancelled) setConfig(isFeaturedSiteConfig(payload) ? payload : null);
      } catch {
        if (!cancelled) setConfig(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => (config ? buildFeaturedGroups(config, reports) : []), [config, reports]);

  if (!ready || groups.length === 0) return null;

  return (
    <section className="featured-gallery" aria-labelledby="featured-title">
      <div className="featured-heading">
        <p className="eyebrow">Start here</p>
        <h3 id="featured-title">Real sites, already scanned</h3>
        <p>Open one to see what it actually did during a controlled visit. No scan needed.</p>
      </div>
      {groups.map((group) => (
        <div className="featured-group" key={group.category.id}>
          <h4>{group.category.label}</h4>
          <div className="featured-cards">
            {group.items.map(({ site, entry }) => (
              <FeaturedReportCard key={entry.id} site={site} entry={entry} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function FeaturedReportCard({
  site,
  entry
}: {
  site: FeaturedSite;
  entry: StaticReportManifestEntry;
}) {
  return (
    <a
      className={`featured-card tone-${entry.tone}`}
      href={committedReportLocation(entry.id, clientReportRuntime()).pagePath}
    >
      <span className="featured-card-top">
        <span className="featured-card-site">{site.label}</span>
        {entry.requestCapped && (
          <span
            className="capped-chip"
            title="This visit hit the 1,000-request recording cap: its counts are truncated, and it is excluded from corpus statistics."
          >
            recording capped
          </span>
        )}
        <span className="featured-card-dot" aria-hidden="true" />
      </span>
      <span className="featured-card-headline">{entry.headline}</span>
      <span className="featured-card-stats">
        <span className="featured-card-stat">
          <b>{entry.metrics.thirdPartyRequests.toLocaleString("en-US")}</b> third-party
        </span>
        <span className="featured-card-stat">
          <b>{entry.metrics.knownTrackerRequests.toLocaleString("en-US")}</b> catalogued-service
        </span>
      </span>
    </a>
  );
}

function StaticReportGallery({
  reports,
  error,
  onCreateComparison,
  onComparisonError
}: {
  reports: StaticReportManifestEntry[] | null;
  error: string | null;
  onCreateComparison: (comparison: ComparisonScanResult) => void;
  onComparisonError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "comparison" | "single">("all");
  const [deviceFilter, setDeviceFilter] = useState<"all" | ScanDevice>("all");
  const [sortBy, setSortBy] = useState<"newest" | "domain" | "thirdParty" | "trackers">("newest");
  const [historyGroupKey, setHistoryGroupKey] = useState("");
  const [beforeReportId, setBeforeReportId] = useState("");
  const [afterReportId, setAfterReportId] = useState("");
  const [uploadBefore, setUploadBefore] = useState<UploadedCompareReport | null>(null);
  const [uploadAfter, setUploadAfter] = useState<UploadedCompareReport | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(ARCHIVE_PAGE_SIZE);

  const historyGroups = useMemo(() => buildHistoryGroups(reports ?? []), [reports]);
  const selectedHistoryGroup = historyGroups.find((group) => group.key === historyGroupKey) ?? historyGroups[0] ?? null;

  const filteredReports = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const matches = (reports ?? []).filter((report) => {
      const searchable = `${report.title} ${report.domain} ${report.requestedUrl}`.toLowerCase();
      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (typeFilter === "all" || report.reportType === typeFilter) &&
        (deviceFilter === "all" || report.device === deviceFilter)
      );
    });

    return matches.sort((a, b) => {
      if (sortBy === "domain") return a.domain.localeCompare(b.domain) || Date.parse(b.scannedAt) - Date.parse(a.scannedAt);
      if (sortBy === "thirdParty") return b.metrics.thirdPartyRequests - a.metrics.thirdPartyRequests || a.domain.localeCompare(b.domain);
      if (sortBy === "trackers") return b.metrics.knownTrackerRequests - a.metrics.knownTrackerRequests || a.domain.localeCompare(b.domain);
      return Date.parse(b.scannedAt) - Date.parse(a.scannedAt);
    });
  }, [deviceFilter, query, reports, sortBy, typeFilter]);

  useEffect(() => {
    setVisibleCount(ARCHIVE_PAGE_SIZE);
  }, [deviceFilter, query, sortBy, typeFilter]);

  const visibleReports = filteredReports.slice(0, visibleCount);

  useEffect(() => {
    const group = historyGroups.find((candidate) => candidate.key === historyGroupKey) ?? historyGroups[0];
    if (!group) {
      setHistoryGroupKey("");
      setBeforeReportId("");
      setAfterReportId("");
      return;
    }
    if (group.key !== historyGroupKey) setHistoryGroupKey(group.key);
    setBeforeReportId(group.reports[1]?.id ?? group.reports[0].id);
    setAfterReportId(group.reports[0].id);
  }, [historyGroupKey, historyGroups]);

  async function compareArchiveReports() {
    const before = selectedHistoryGroup?.reports.find((report) => report.id === beforeReportId) ?? null;
    const after = selectedHistoryGroup?.reports.find((report) => report.id === afterReportId) ?? null;
    if (!before || !after) {
      setCompareError("Choose two saved visits from one site history.");
      return;
    }
    if (before.id === after.id) {
      setCompareError("Choose two different reports.");
      return;
    }
    // A temporal diff only means something for the same subject under the same
    // conditions; two unrelated sites or devices produce a diff that reads as
    // a site change but is really an apples-to-oranges pairing.
    if (!comparableSubjectHosts(before.domain, after.domain)) {
      setCompareError(`Temporal comparison needs two scans of the same site (${before.domain} vs ${after.domain}).`);
      return;
    }
    if (before.device !== after.device) {
      setCompareError("Temporal comparison needs two scans on the same device type (desktop vs mobile).");
      return;
    }

    setCompareLoading(true);
    setCompareError(null);

    try {
      const [beforeReport, afterReport] = await Promise.all([loadStaticTemporalRun(before), loadStaticTemporalRun(after)]);
      // "Before" follows the recorded timestamps, not the pick order: a
      // temporal pair whose arms are reversed in time records no change.
      const ordered = orderTemporalPair(beforeReport, afterReport);
      if (!ordered) {
        setCompareError("The two reports' recorded timestamps cannot order a before/after pair.");
        return;
      }
      const comparison = createTemporalComparisonReport(ordered[0], ordered[1]);
      const decision = legacyComparisonDecision(comparison);
      const supportsDescriptiveDelta =
        decision.mode === "comparable" &&
        (decision.families["raw-counts"].mode === "comparable" ||
          decision.families["tracker-classification"].mode === "comparable");
      if (!supportsDescriptiveDelta) {
        setCompareError(`These visits do not support a comparable descriptive delta. ${decision.reasons.slice(0, 2).join(" ")}`);
        return;
      }
      onCreateComparison(comparison);
    } catch (readError) {
      const message = readError instanceof Error ? readError.message : "Saved reports could not be compared.";
      setCompareError(message);
      onComparisonError(message);
    } finally {
      setCompareLoading(false);
    }
  }

  function compareUploadedReports() {
    if (!uploadBefore || !uploadAfter) {
      setCompareError("Open two single-scan report files.");
      return;
    }
    if (!comparableSubjectHosts(uploadBefore.report.summary.firstPartyDomain, uploadAfter.report.summary.firstPartyDomain)) {
      setCompareError(
        `Temporal comparison needs two scans of the same site (${uploadBefore.report.summary.firstPartyDomain} vs ${uploadAfter.report.summary.firstPartyDomain}).`
      );
      return;
    }
    if (uploadBefore.report.conditions.viewport.isMobile !== uploadAfter.report.conditions.viewport.isMobile) {
      setCompareError("Temporal comparison needs two scans on the same device type (desktop vs mobile).");
      return;
    }

    const ordered = orderTemporalPair(uploadBefore.report, uploadAfter.report);
    if (!ordered) {
      setCompareError("The two reports' recorded timestamps cannot order a before/after pair.");
      return;
    }

    const comparison = createTemporalComparisonReport(ordered[0], ordered[1]);
    const eligibility = comparisonEligibility(comparison);
    if (!eligibility.eligible) {
      setCompareError(`These visits are not methodologically comparable. ${eligibility.reasons.slice(0, 2).join(" ")}`);
      return;
    }

    setCompareError(null);
    onCreateComparison(comparison);
  }

  if (reports === null) {
    return <p className="muted">Loading generated reports...</p>;
  }

  if (reports.length === 0) {
    return (
      <div className="static-gallery-empty">
        <FileJson size={18} aria-hidden="true" />
        <span>{error ?? "No generated reports committed yet."}</span>
      </div>
    );
  }

  return (
    <div className="static-gallery">
      <FeaturedGallery reports={reports} />
      <div className="static-gallery-heading">
        <div>
          <h3>Saved reports</h3>
          <p>{plural(reports.length, "report")} in the public archive</p>
        </div>
        <div className="static-gallery-heading-actions">
          <a className="directory-link" href={staticAssetPath("/directory/")}>
            Browse the full directory
            <ExternalLink size={14} aria-hidden="true" />
          </a>
          <span className="static-gallery-count" aria-live="polite">
            {visibleReports.length.toLocaleString("en-US")} of {filteredReports.length.toLocaleString("en-US")} shown
          </span>
        </div>
      </div>
      <div className="static-gallery-controls" aria-label="Filter saved reports">
        <label className="static-gallery-search">
          <Search size={16} aria-hidden="true" />
          <span className="visually-hidden">Search reports</span>
          <input
            type="search"
            value={query}
            placeholder="Search domain or URL"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
        <label>
          <span className="visually-hidden">Report type</span>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.currentTarget.value as "all" | "comparison" | "single")}>
            <option value="all">All types</option>
            <option value="comparison">Comparisons</option>
            <option value="single">Single scans</option>
          </select>
        </label>
        <label>
          <span className="visually-hidden">Device</span>
          <select value={deviceFilter} onChange={(event) => setDeviceFilter(event.currentTarget.value as "all" | ScanDevice)}>
            <option value="all">All devices</option>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile</option>
          </select>
        </label>
        <label>
          <span className="visually-hidden">Sort reports</span>
          <select value={sortBy} onChange={(event) => setSortBy(event.currentTarget.value as "newest" | "domain" | "thirdParty" | "trackers")}>
            <option value="newest">Newest</option>
            <option value="domain">Domain</option>
            <option value="thirdParty">Most third-party</option>
            {/* Sorts on summary.knownTrackerRequests, which counts every catalog
                match including operational-only services, and counts REQUESTS,
                not distinct services, so the label must say both. */}
            <option value="trackers">Most catalogued-service requests</option>
          </select>
        </label>
      </div>
      {reports.length > 0 && (
        <section className="static-compare-panel" aria-labelledby="static-compare-title">
          <div className="static-compare-heading">
            <div>
              <h3 id="static-compare-title">Compare reports</h3>
              <p>Descriptive raw and catalogued-service differences between compatible visits</p>
            </div>
            {selectedHistoryGroup && (
              <button className="primary-button" type="button" onClick={() => void compareArchiveReports()} disabled={compareLoading}>
                {compareLoading ? <Loader2 className="spin" size={17} aria-hidden="true" /> : <FileJson size={17} aria-hidden="true" />}
                Compare
              </button>
            )}
          </div>
          {selectedHistoryGroup ? (
            <>
              <div className="static-compare-controls">
                <label>
                  <span>Site history</span>
                  <select value={selectedHistoryGroup.key} onChange={(event) => setHistoryGroupKey(event.currentTarget.value)}>
                    {historyGroups.map((group) => (
                      <option key={group.key} value={group.key}>
                        {group.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Before</span>
                  <select value={beforeReportId} onChange={(event) => setBeforeReportId(event.currentTarget.value)}>
                    {selectedHistoryGroup.reports.map((report) => (
                      <option key={report.id} value={report.id}>
                        {staticReportOptionLabel(report)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>After</span>
                  <select value={afterReportId} onChange={(event) => setAfterReportId(event.currentTarget.value)}>
                    {selectedHistoryGroup.reports.map((report) => (
                      <option key={report.id} value={report.id}>
                        {staticReportOptionLabel(report)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="static-compare-note">
                Archive groups hold the route, scanner method, browser, device, conditions, catalog, Brave-list
                source and list count constant. A changed list snapshot can support raw and catalogued-service
                differences, but never a Shields or detector delta.
              </p>
            </>
          ) : (
            <p className="static-compare-note">
              The public archive currently has no two successful, uncapped passive visits with the same route,
              scanner method, browser, device, conditions, catalog, Brave-list source and list count. Upload two
              compatible single-scan JSON files below to use the stricter full-snapshot gate.
            </p>
          )}
          <div className="static-compare-upload">
            <CompareUploadButton
              label={uploadBefore ? uploadBefore.name : "Open before JSON"}
              onUploadReport={async (file) => {
                const uploaded = await readCompareUpload(file, "before");
                setUploadBefore(uploaded);
                setCompareError(null);
              }}
              onError={setCompareError}
            />
            <CompareUploadButton
              label={uploadAfter ? uploadAfter.name : "Open after JSON"}
              onUploadReport={async (file) => {
                const uploaded = await readCompareUpload(file, "after");
                setUploadAfter(uploaded);
                setCompareError(null);
              }}
              onError={setCompareError}
            />
            <button className="secondary-button" type="button" onClick={compareUploadedReports}>
              <Upload size={17} aria-hidden="true" />
              Compare files
            </button>
          </div>
          {compareError && <p className="static-compare-error">{compareError}</p>}
        </section>
      )}
      <div className="static-report-list">
        {visibleReports.map((report) => (
          <StaticReportCard key={report.id} report={report} />
        ))}
      </div>
      {visibleReports.length < filteredReports.length && (
        <button
          className="secondary-button static-gallery-more"
          type="button"
          onClick={() => setVisibleCount((current) => current + ARCHIVE_PAGE_SIZE)}
        >
          Show {Math.min(ARCHIVE_PAGE_SIZE, filteredReports.length - visibleReports.length).toLocaleString("en-US")} more reports
        </button>
      )}
      {filteredReports.length === 0 && (
        <div className="static-gallery-empty">
          <FileJson size={18} aria-hidden="true" />
          <span>No reports match those filters.</span>
        </div>
      )}
    </div>
  );
}

function StaticReportCard({ report }: { report: StaticReportManifestEntry }) {
  return (
    <a className="static-report-card" href={committedReportLocation(report.id, clientReportRuntime()).pagePath}>
      <span className="static-report-main">
        <strong>{report.title || report.domain}</strong>
        <small>
          {report.domain} · {formatDateTime(report.scannedAt)}
        </small>
        <em>{report.requestedUrl}</em>
      </span>
      <span className="static-report-meta" aria-label={staticReportCardLabel(report)}>
        <b>{report.metrics.thirdPartyRequests.toLocaleString("en-US")} third-party</b>
        <small>
          {report.comparisonType === "shields" && (report.metrics.shieldsBlockedRequests ?? 0) > 0
            ? `${(report.metrics.shieldsBlockedRequests ?? 0).toLocaleString("en-US")} matched Shields lists · ${report.device}`
            : `${report.reportType === "comparison" ? "Comparison" : "Single"} · ${report.device}`}
        </small>
      </span>
    </a>
  );
}

type UploadedCompareReport = {
  name: string;
  report: ScanResult;
};

function CompareUploadButton({
  label,
  onUploadReport,
  onError
}: {
  label: string;
  onUploadReport: (file: File | null) => Promise<void>;
  onError: (message: string) => void;
}) {
  return (
    <FileUploadButton accept="application/json,.json" onSelect={onUploadReport} onError={onError}>
      <span className="compare-upload-label">{label}</span>
    </FileUploadButton>
  );
}

async function loadStaticTemporalRun(entry: StaticReportManifestEntry): Promise<ScanResult> {
  const response = await fetch(committedReportLocation(entry.id, clientReportRuntime()).dataUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not load ${entry.domain}.`);
  }

  const payload = (await response.json()) as unknown;
  const read = await readLoadedReport(payload, entry.domain);
  if (!read.ok) throw new Error(read.message);
  // The client-side temporal builder composes v1 runs; a pair mixing schema
  // generations would compare two different recording contracts, so other
  // generations are refused honestly here until a cross-generation temporal
  // design exists.
  if (read.loaded.source !== "v1") {
    throw new Error(`${entry.domain} uses the v2 schema; temporal comparison across schema generations is not supported yet.`);
  }
  const wire = read.loaded.wire;
  // A comparison report still contains complete visits. Use the same lead-run
  // convention as the directory: temporal reports lead with the later visit;
  // intervention/descriptive reports lead with their baseline. The versioned
  // archive identity suggests passive cohorts, then legacyComparisonDecision
  // rechecks the loaded pair. Shields remains strict to the exact snapshot.
  const run = wire.reportType === "comparison" ? (wire.comparisonType === "temporal" ? wire.variant : wire.baseline) : wire;
  return stripShare(run);
}

async function readCompareUpload(file: File | null, slot: "before" | "after"): Promise<UploadedCompareReport> {
  if (!file) {
    throw new Error(`Open a ${slot} report file.`);
  }

  const payload = JSON.parse(await file.text()) as unknown;
  const read = await readLoadedReport(payload, `The ${slot} file`);
  if (!read.ok) throw new Error(read.message);
  if (read.loaded.source !== "v1") {
    throw new Error(`The ${slot} file uses the v2 schema; temporal comparison across schema generations is not supported yet.`);
  }
  if (read.loaded.wire.reportType === "comparison") {
    throw new Error("Choose a single-scan Site Behavior Lab JSON report.");
  }

  return {
    name: file.name,
    report: stripShare(read.loaded.wire)
  };
}

// A run pulled into a temporal comparison has no servable permalink of its own.
function stripShare(report: ScanResult): ScanResult {
  return { ...report, share: undefined };
}

function staticReportOptionLabel(report: StaticReportManifestEntry): string {
  return `${report.domain} · ${formatDateTime(report.scannedAt)} · ${report.device}`;
}

type HistoryGroup = { key: string; label: string; reports: StaticReportManifestEntry[] };

function buildHistoryGroups(reports: StaticReportManifestEntry[]): HistoryGroup[] {
  const groups = new Map<string, StaticReportManifestEntry[]>();
  for (const report of reports) {
    const key = report.comparisonHistoryKey;
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) existing.push(report);
    else groups.set(key, [report]);
  }

  return [...groups.entries()]
    .filter(([, entries]) => entries.length >= 2)
    .map(([key, entries]) => {
      const sorted = entries.sort((left, right) => Date.parse(right.scannedAt) - Date.parse(left.scannedAt));
      const first = sorted[0];
      const kind = first.reportType === "comparison" ? first.comparisonType ?? "comparison" : "single scans";
      return {
        key,
        label: `${first.domain} · ${kind} · ${first.device} (${sorted.length})`,
        reports: sorted
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function staticReportCardLabel(report: StaticReportManifestEntry): string {
  const parts = [
    plural(report.metrics.thirdPartyRequests, "third-party request"),
    plural(report.metrics.knownTrackerRequests, "catalogued service request"),
    plural(report.metrics.thirdPartyDomains, "third-party domain")
  ];
  if (report.comparisonType === "shields" && (report.metrics.shieldsBlockedRequests ?? 0) > 0) {
    parts.push(`${plural(report.metrics.shieldsBlockedRequests ?? 0, "request")} matched Brave Shields filter lists`);
  }
  return parts.join(", ");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC"
  });
}

export { StaticReportGallery };
