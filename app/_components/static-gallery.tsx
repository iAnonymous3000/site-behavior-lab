"use client";

import { ExternalLink, FileJson, Loader2, Search, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type Ref } from "react";
import { clientReportRuntime, staticAssetPath } from "../client-runtime";
import { FileUploadButton } from "./file-upload-button";
import { readLoadedReport } from "@/lib/client-report-reader";
import { comparableSubjectHosts } from "@/lib/comparison-eligibility";
import {
  LatestClientOperation,
  fetchBytesResponseWithPolicy,
  parseJsonTextWithPolicy
} from "@/lib/client-fetch-policy";
import { parseDigestBoundReportJson } from "@/lib/client-report-integrity";
import { readClientFileText } from "@/lib/client-file-policy";
import { committedReportLocation } from "@/lib/report-locator";
import { BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES } from "@/lib/report-resource-limits";
import type { LoadedReport } from "@/lib/scan-report-view";
import {
  staticReportCardLabel,
  staticReportRequestCountLabel,
  staticReportRequestEvidenceStatus
} from "@/lib/static-report-card-copy";
import { plural } from "@/lib/text-format";
import {
  createLoadedTemporalComparison,
  temporalUploadSelectionError
} from "@/lib/temporal-report-comparison";
import type { ScanDevice, StaticReportManifestEntry } from "@/lib/types";

/**
 * The committed-report surfaces of the static export: the curated "Start here"
 * gallery, the saved-report archive with filters, and the temporal comparison
 * tools. Split from the app shell so the shell stays focused on scanning and
 * report rendering.
 */

const ARCHIVE_PAGE_SIZE = 24;

function StaticReportGallery({
  reports,
  error,
  onRetry,
  onCreateComparison,
  onComparisonError
}: {
  reports: StaticReportManifestEntry[] | null;
  error: string | null;
  onRetry: () => void;
  onCreateComparison: (comparison: LoadedReport) => void;
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
  const pendingFocusIndexRef = useRef<number | null>(null);
  const newlyRevealedReportRef = useRef<HTMLAnchorElement | null>(null);
  const archiveComparisonOperationRef = useRef<LatestClientOperation | null>(null);
  const beforeUploadOperationRef = useRef<LatestClientOperation | null>(null);
  const afterUploadOperationRef = useRef<LatestClientOperation | null>(null);
  const comparisonIntentEpochRef = useRef(0);
  if (!archiveComparisonOperationRef.current) archiveComparisonOperationRef.current = new LatestClientOperation();
  if (!beforeUploadOperationRef.current) beforeUploadOperationRef.current = new LatestClientOperation();
  if (!afterUploadOperationRef.current) afterUploadOperationRef.current = new LatestClientOperation();
  const archiveComparisonOperation = archiveComparisonOperationRef.current;
  const beforeUploadOperation = beforeUploadOperationRef.current;
  const afterUploadOperation = afterUploadOperationRef.current;

  useEffect(() => () => {
    archiveComparisonOperation.cancel();
    beforeUploadOperation.cancel();
    afterUploadOperation.cancel();
  }, [afterUploadOperation, archiveComparisonOperation, beforeUploadOperation]);

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
    pendingFocusIndexRef.current = null;
    setVisibleCount(ARCHIVE_PAGE_SIZE);
  }, [deviceFilter, query, sortBy, typeFilter]);

  const visibleReports = filteredReports.slice(0, visibleCount);
  const countSummary = `${visibleReports.length.toLocaleString("en-US")} of ${filteredReports.length.toLocaleString(
    "en-US"
  )} shown`;

  // The count changes on every keystroke, and polite announcements queue rather than
  // replace, so announcing it live turned an eight-character search into eight
  // announcements still playing after typing stopped. Sighted users keep the instant
  // count; the announced copy waits for a pause.
  const [announcedCount, setAnnouncedCount] = useState(countSummary);
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncedCount(countSummary), 600);
    return () => window.clearTimeout(timer);
  }, [countSummary]);

  useEffect(() => {
    const pendingIndex = pendingFocusIndexRef.current;
    if (pendingIndex === null || pendingIndex >= visibleReports.length) return;
    pendingFocusIndexRef.current = null;
    newlyRevealedReportRef.current?.focus();
  }, [visibleReports.length]);

  useEffect(() => {
    archiveComparisonOperation.cancel();
    setCompareLoading(false);
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
  }, [archiveComparisonOperation, historyGroupKey, historyGroups]);

  async function compareArchiveReports() {
    const intentEpoch = beginComparisonIntent();
    archiveComparisonOperation.cancel();
    setCompareLoading(false);
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

    await archiveComparisonOperation.run(
      async (signal) => {
        const [beforeReport, afterReport] = await loadStaticTemporalPair(before, after, signal);
        const comparison = createLoadedTemporalComparison(beforeReport, afterReport);
        if (!comparison.ok) throw new ComparisonSelectionError(comparison.message);
        return comparison.loaded;
      },
      {
        onStart: () => {
          setCompareLoading(true);
          setCompareError(null);
        },
        onSuccess: (comparison) => {
          if (isCurrentComparisonIntent(intentEpoch)) onCreateComparison(comparison);
        },
        onError: (readError) => {
          if (!isCurrentComparisonIntent(intentEpoch)) return;
          const message = readError instanceof Error ? readError.message : "Saved reports could not be compared.";
          setCompareError(message);
          if (!(readError instanceof ComparisonSelectionError)) onComparisonError(message);
        },
        onSettled: () => setCompareLoading(false)
      }
    );
  }

  function compareUploadedReports() {
    beginComparisonIntent();
    archiveComparisonOperation.cancel();
    setCompareLoading(false);
    if (!uploadBefore || !uploadAfter) {
      setCompareError("Open two single-scan report files.");
      return;
    }
    const comparison = createLoadedTemporalComparison(uploadBefore.loaded, uploadAfter.loaded);
    if (!comparison.ok) {
      setCompareError(comparison.message);
      return;
    }

    setCompareError(null);
    onCreateComparison(comparison.loaded);
  }

  async function openCompareUpload(file: File | null, slot: "before" | "after") {
    const intentEpoch = beginComparisonIntent();
    archiveComparisonOperation.cancel();
    setCompareLoading(false);
    const operation = slot === "before" ? beforeUploadOperation : afterUploadOperation;
    await operation.run(
      async (signal) => {
        const uploaded = await readCompareUpload(file, slot, signal);
        signal.throwIfAborted();
        return uploaded;
      },
      {
        onSuccess: (uploaded) => {
          if (slot === "before") setUploadBefore(uploaded);
          else setUploadAfter(uploaded);
          if (isCurrentComparisonIntent(intentEpoch)) setCompareError(null);
        },
        onError: (readError) => {
          if (!isCurrentComparisonIntent(intentEpoch)) return;
          setCompareError(readError instanceof Error ? readError.message : `The ${slot} report could not be opened.`);
        }
      }
    );
  }

  function surfaceCompareUploadError(slot: "before" | "after", message: string) {
    beginComparisonIntent();
    archiveComparisonOperation.cancel();
    (slot === "before" ? beforeUploadOperation : afterUploadOperation).cancel();
    setCompareLoading(false);
    setCompareError(message);
  }

  function changeComparisonSelection(update: () => void) {
    beginComparisonIntent();
    archiveComparisonOperation.cancel();
    setCompareLoading(false);
    setCompareError(null);
    update();
  }

  function beginComparisonIntent(): number {
    comparisonIntentEpochRef.current += 1;
    return comparisonIntentEpochRef.current;
  }

  function isCurrentComparisonIntent(epoch: number): boolean {
    return comparisonIntentEpochRef.current === epoch;
  }

  if (error) {
    return (
      <div className="static-gallery-empty">
        <FileJson size={18} aria-hidden="true" />
        <span role="alert">{error}</span>
        <button className="secondary-button" type="button" onClick={onRetry}>
          Retry saved-report tools
        </button>
      </div>
    );
  }

  if (reports === null) {
    return <p className="muted" role="status">Loading generated reports…</p>;
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
          <span className="static-gallery-count">{countSummary}</span>
          <span className="visually-hidden" role="status" aria-live="polite">
            {announcedCount}
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
            <option value="thirdParty">Most retained third-party request rows</option>
            {/* Sorts on summary.knownTrackerRequests, which counts every catalog
                match including operational-only services, and counts REQUESTS,
                not distinct services, so the label must say both. */}
            <option value="trackers">Most retained catalog matches</option>
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
                  <select
                    value={selectedHistoryGroup.key}
                    onChange={(event) => changeComparisonSelection(() => setHistoryGroupKey(event.currentTarget.value))}
                  >
                    {historyGroups.map((group) => (
                      <option key={group.key} value={group.key}>
                        {group.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Before</span>
                  <select
                    value={beforeReportId}
                    onChange={(event) => changeComparisonSelection(() => setBeforeReportId(event.currentTarget.value))}
                  >
                    {selectedHistoryGroup.reports.map((report) => (
                      <option key={report.id} value={report.id}>
                        {staticReportOptionLabel(report)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>After</span>
                  <select
                    value={afterReportId}
                    onChange={(event) => changeComparisonSelection(() => setAfterReportId(event.currentTarget.value))}
                  >
                    {selectedHistoryGroup.reports.map((report) => (
                      <option key={report.id} value={report.id}>
                        {staticReportOptionLabel(report)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="static-compare-note">
                {historyGroupMethodNote(selectedHistoryGroup)}
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
              onUploadReport={(file) => openCompareUpload(file, "before")}
              onError={(message) => surfaceCompareUploadError("before", message)}
            />
            <CompareUploadButton
              label={uploadAfter ? uploadAfter.name : "Open after JSON"}
              onUploadReport={(file) => openCompareUpload(file, "after")}
              onError={(message) => surfaceCompareUploadError("after", message)}
            />
            <button className="secondary-button" type="button" onClick={compareUploadedReports}>
              <Upload size={17} aria-hidden="true" />
              Compare files
            </button>
          </div>
          {compareError && <p className="static-compare-error" role="alert">{compareError}</p>}
        </section>
      )}
      <div className="static-report-list">
        {visibleReports.map((report, index) => (
          <StaticReportCard
            focusRef={index === pendingFocusIndexRef.current ? newlyRevealedReportRef : undefined}
            key={report.id}
            report={report}
          />
        ))}
      </div>
      {visibleReports.length < filteredReports.length && (
        <button
          className="secondary-button static-gallery-more"
          type="button"
          onClick={() => {
            pendingFocusIndexRef.current = visibleReports.length;
            setVisibleCount((current) => current + ARCHIVE_PAGE_SIZE);
          }}
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

function StaticReportCard({
  report,
  focusRef
}: {
  report: StaticReportManifestEntry;
  focusRef?: Ref<HTMLAnchorElement>;
}) {
  const requestEvidenceStatus = staticReportRequestEvidenceStatus(report);
  return (
    <a
      className="static-report-card"
      href={committedReportLocation(report.id, clientReportRuntime()).pagePath}
      ref={focusRef}
    >
      <span className="static-report-main">
        <strong>{report.title || report.domain}</strong>
        <small>
          {report.domain} · {formatDateTime(report.scannedAt)}
        </small>
        <em>{report.requestedUrl}</em>
      </span>
      <span className="static-report-meta">
        <span className="visually-hidden">{staticReportCardLabel(report)}</span>
        <b>{staticReportRequestCountLabel(report, report.metrics.thirdPartyRequests, "third-party request")}</b>
        <small>
          {report.comparisonType === "shields" && (report.metrics.shieldsBlockedRequests ?? 0) > 0
            ? `${staticReportRequestCountLabel(
                report,
                report.metrics.shieldsBlockedRequests ?? 0,
                "request"
              )} matched Shields lists · ${report.device}`
            : `${report.reportType === "comparison" ? "Comparison" : "Single"} · ${report.device}`}
          {requestEvidenceStatus ? ` · ${requestEvidenceStatus}` : ""}
        </small>
      </span>
    </a>
  );
}

type UploadedCompareReport = {
  name: string;
  loaded: LoadedReport;
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

async function loadStaticTemporalReport(entry: StaticReportManifestEntry, signal: AbortSignal): Promise<LoadedReport> {
  const { bytes } = await fetchBytesResponseWithPolicy(
    committedReportLocation(entry.id, clientReportRuntime()).dataUrl,
    { cache: "no-store" },
    {
      label: `Saved report for ${entry.domain}`,
      maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,
      signal,
      httpError: () => new Error(`Could not load ${entry.domain}.`)
    }
  );
  if (bytes.byteLength !== entry.reportWireBytes) {
    throw new Error(`Saved report for ${entry.domain} did not match its manifest byte length.`);
  }
  const payload = await parseDigestBoundReportJson(
    bytes,
    entry.reportWireSha256,
    `Saved report for ${entry.domain}`
  );
  signal.throwIfAborted();
  const read = await readLoadedReport(payload, entry.domain);
  if (!read.ok) throw new Error(read.message);
  if (read.loaded.wire.share?.id !== entry.id) {
    throw new Error(`Saved report for ${entry.domain} did not match its manifest identity.`);
  }
  return read.loaded;
}

async function loadStaticTemporalPair(
  before: StaticReportManifestEntry,
  after: StaticReportManifestEntry,
  signal: AbortSignal
): Promise<[LoadedReport, LoadedReport]> {
  const pairController = new AbortController();
  const abortPair = () => pairController.abort(signal.reason);
  if (signal.aborted) abortPair();
  else signal.addEventListener("abort", abortPair, { once: true });
  try {
    return await Promise.all([
      loadStaticTemporalReport(before, pairController.signal),
      loadStaticTemporalReport(after, pairController.signal)
    ]);
  } catch (error) {
    if (!pairController.signal.aborted) {
      pairController.abort(new DOMException("The other comparison report failed to load.", "AbortError"));
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", abortPair);
  }
}

class ComparisonSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComparisonSelectionError";
  }
}

async function readCompareUpload(
  file: File | null,
  slot: "before" | "after",
  signal: AbortSignal
): Promise<UploadedCompareReport> {
  if (!file) {
    throw new Error(`Open a ${slot} report file.`);
  }

  const contents = await readClientFileText(file, {
    label: `The ${slot} report JSON`,
    maxBytes: BROWSER_PUBLIC_REPORT_JSON_MAX_BYTES,
    signal
  });
  const payload = parseJsonTextWithPolicy(contents, `The ${slot} report JSON`);
  const read = await readLoadedReport(payload, `The ${slot} file`);
  signal.throwIfAborted();
  if (!read.ok) throw new Error(read.message);
  const selectionError = temporalUploadSelectionError(read.loaded);
  if (selectionError) throw new Error(selectionError);

  return {
    name: file.name,
    loaded: read.loaded
  };
}

function staticReportOptionLabel(report: StaticReportManifestEntry): string {
  return `${report.domain} · ${formatDateTime(report.scannedAt)} · ${report.device}`;
}

type HistoryGroup = { key: string; label: string; reports: StaticReportManifestEntry[] };

function historyGroupMethodNote(group: HistoryGroup): string {
  if (group.key.startsWith("comparison-history-key-v2|")) {
    return "This v2/r2 history holds the route, device, condition vector, execution environment, methodology, normalization and tracker-catalog snapshot constant. Every selected pair is re-evaluated per metric family before any delta is shown.";
  }
  return "This v1 history holds the route, scanner method, browser, device, conditions, catalog, Brave-list source and list count constant. A changed list snapshot can support raw and catalogued-service differences, but never a Shields or detector delta.";
}

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

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // The gallery is sorted by date, so a bare local-looking time made the ordering appear
  // to contradict the labels for any reader east of UTC. Year is included once a row is
  // no longer from the current year, matching app/reports/[id]/page.tsx.
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return date.toLocaleString("en-US", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  });
}

export { StaticReportGallery };
