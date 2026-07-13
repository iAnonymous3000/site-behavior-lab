"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, Fingerprint, Radar } from "lucide-react";
import { requestProvenanceSearchText, requestProvenanceSummary } from "@/lib/report-findings";
import { detectionEvidence, detectionLabel, pixelFieldLabel } from "@/lib/report-insights";
import type {
  CookieRecord,
  DomainSummary,
  FingerprintDetectionSummary,
  FingerprintEventSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  StorageRecord
} from "@/lib/types";

function Warnings({ warnings }: { warnings: string[] }) {
  // Reports saved before the collector deduped can carry exact-duplicate
  // warnings; a repeat adds nothing and would break the message-text keys.
  const unique = Array.from(new Set(warnings));
  if (unique.length === 0) return null;
  return (
    <section className="warnings">
      {unique.map((warning) => (
        <div key={warning}>
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{warning}</span>
        </div>
      ))}
    </section>
  );
}

function roleTag(domain: DomainSummary) {
  if (domain.tracker) return <span className="role-tag role-tracker">service</span>;
  if (domain.thirdParty) return <span className="role-tag role-third">third-party</span>;
  return <span className="role-tag role-first">first-party</span>;
}

function DomainTable({ domains }: { domains: DomainSummary[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => domains.filter((domain) => domain.domain.toLowerCase().includes(query.toLowerCase())),
    [domains, query]
  );
  const shown = filtered.slice(0, 100);

  return (
    <details className="data-section disclosure" open>
      <summary className="section-heading">
        <h2>Domain evidence</h2>
        <span className="count-badge">{domains.length} domains</span>
        <ChevronDown className="disclosure-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="section-tools disclosure-tools">
        <input
          className="filter-input"
          type="search"
          placeholder="Filter domains"
          value={query}
          aria-label="Filter domains"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Role</th>
              <th>Requests</th>
              <th>Known service</th>
              <th>Resource types</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((domain) => (
              <tr key={domain.domain}>
                <td className="mono" data-label="Domain">{domain.domain}</td>
                <td data-label="Role">{roleTag(domain)}</td>
                <td data-label="Requests">{domain.requests.toLocaleString("en-US")}</td>
                <td data-label="Known service">{domain.tracker ? `${domain.tracker.entity}: ${domain.tracker.category}` : "-"}</td>
                <td data-label="Resource types">{domain.resourceTypes.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="table-empty">No domains match &ldquo;{query}&rdquo;.</p>}
        {filtered.length > shown.length && (
          <p className="row-more">Showing first 100 of {filtered.length} matching domains. Export JSON for the full list.</p>
        )}
      </div>
    </details>
  );
}

function RequestTable({ requests }: { requests: NetworkRequestRecord[] }) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [signalFilter, setSignalFilter] = useState<RequestSignalFilter>("all");
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>("all");
  const [resourceFilter, setResourceFilter] = useState("all");

  const resourceTypes = useMemo(
    () => Array.from(new Set(requests.map((request) => request.resourceType))).sort((a, b) => a.localeCompare(b)),
    [requests]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requests.filter((request) => {
      if (!requestMatchesSignalFilter(request, signalFilter)) return false;
      if (!requestMatchesStatusFilter(request, statusFilter)) return false;
      if (resourceFilter !== "all" && request.resourceType !== resourceFilter) return false;
      if (!q) return true;
      return (
        request.domain.toLowerCase().includes(q) ||
        request.url.toLowerCase().includes(q) ||
        request.method.toLowerCase().includes(q) ||
        request.resourceType.toLowerCase().includes(q) ||
        requestProvenanceSearchText(request).toLowerCase().includes(q) ||
        request.tracker?.entity.toLowerCase().includes(q) ||
        request.tracker?.category.toLowerCase().includes(q)
      );
    });
  }, [requests, query, resourceFilter, signalFilter, statusFilter]);

  const shown = filtered.slice(0, 80);
  const filtersActive = signalFilter !== "all" || statusFilter !== "all" || resourceFilter !== "all" || query.trim() !== "";
  function resetFilters() {
    setQuery("");
    setSignalFilter("all");
    setStatusFilter("all");
    setResourceFilter("all");
  }
  // v2 evidence rows are phase-tagged; the column renders only when at least
  // one row carries a phase, so v1 tables stay unchanged.
  const hasPhases = useMemo(() => requests.some((request) => typeof (request as { phaseId?: unknown }).phaseId === "number"), [requests]);

  return (
    <details
      className="data-section disclosure"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="section-heading">
        <h2>Request log</h2>
        <span className="count-badge">
          {filtered.length === requests.length
            ? `${requests.length} requests`
            : `${filtered.length} of ${requests.length}`}
        </span>
        <ChevronDown className="disclosure-chevron" size={16} aria-hidden="true" />
      </summary>
      {opened ? (
        <>
      <div className="section-tools disclosure-tools request-log-tools">
        <div className="request-filter-chips" role="group" aria-label="Request signal filters">
          {REQUEST_SIGNAL_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={signalFilter === filter.value ? "secondary-button" : "ghost-button"}
              aria-pressed={signalFilter === filter.value}
              title={filter.title}
              onClick={() => setSignalFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <input
          className="filter-input"
          type="search"
          placeholder="Filter requests"
          value={query}
          aria-label="Filter requests"
          onChange={(event) => setQuery(event.target.value)}
        />
        <label>
          <span className="visually-hidden">Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value as RequestStatusFilter)}>
            <option value="all">All status</option>
            <option value="ok">2xx</option>
            <option value="redirect">3xx</option>
            <option value="client-error">4xx</option>
            <option value="server-error">5xx</option>
            <option value="pending">No status</option>
          </select>
        </label>
        <label>
          <span className="visually-hidden">Resource type</span>
          <select value={resourceFilter} onChange={(event) => setResourceFilter(event.currentTarget.value)}>
            <option value="all">All types</option>
            {resourceTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="table-wrap request-table">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              {hasPhases && <th title="The recorded visit phase this request belongs to (see the methodology block for phase spans)">Phase</th>}
              <th>Status</th>
              <th>Type</th>
              <th>Domain</th>
              <th>Provenance</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {/* Keyed with the index: v2 evidence rows are phase-tagged, so one
                request id can legitimately appear in several phases. */}
            {shown.map((request, index) => (
              <tr key={`${request.id}:${index}`}>
                <td className="mono" data-label="Time">{request.startedAtMs.toLocaleString("en-US")}ms</td>
                {hasPhases && (
                  <td className="mono" data-label="Phase">
                    {requestPhaseId(request) ?? ""}
                  </td>
                )}
                <td data-label="Status">
                  <StatusCell status={request.status} />
                </td>
                <td data-label="Type">{request.resourceType}</td>
                <td className="mono" data-label="Domain">{request.domain}</td>
                <td data-label="Provenance">
                  <RequestProvenanceCell request={request} />
                </td>
                <td className="url-cell mono" data-label="URL">{request.url}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <p className="table-empty">
            {filtersActive
              ? "No requests in this visit match the current filters (filters stay applied when you switch visits)."
              : "No requests recorded for this visit."}
            {filtersActive && (
              <>
                {" "}
                <button type="button" className="change-list-toggle" onClick={resetFilters}>
                  Clear filters
                </button>
              </>
            )}
          </p>
        )}
        {filtered.length > shown.length && (
          <p className="row-more">Showing first 80 of {filtered.length} matching requests. Export JSON for the full log.</p>
        )}
      </div>
        </>
      ) : (
        <p className="muted disclosure-lazy-note">Open the request log to render its bounded first 80 rows and filters.</p>
      )}
    </details>
  );
}

/** The v2 evidence row's phase tag, when present (v1 rows never carry one). */
function requestPhaseId(request: NetworkRequestRecord): number | null {
  const phaseId = (request as NetworkRequestRecord & { phaseId?: unknown }).phaseId;
  return typeof phaseId === "number" ? phaseId : null;
}

type RequestSignalFilter = "all" | "third-party" | "known-service" | "shields-blocked" | "fingerprinting" | "provenance";
type RequestStatusFilter = "all" | "ok" | "redirect" | "client-error" | "server-error" | "pending";

const REQUEST_SIGNAL_FILTERS: { value: RequestSignalFilter; label: string; title: string }[] = [
  { value: "all", label: "All", title: "Every request the page made." },
  { value: "third-party", label: "Third-party", title: "Requests to any domain other than the site itself." },
  {
    value: "known-service",
    label: "Known services",
    title: "Third parties matched in the curated catalog of advertising, analytics, and social services."
  },
  {
    value: "shields-blocked",
    label: "Matched Shields lists",
    title:
      "Requests matching the default filter lists of Brave Shields, the blocker built into the Brave browser. Matching is computed while the page loads normally; it is not a measured block."
  },
  {
    value: "fingerprinting",
    label: "Fingerprinting",
    title: "Requests to catalogued services associated with device fingerprinting."
  },
  {
    value: "provenance",
    label: "Provenance",
    title: "Requests with a recorded causal chain: which script triggered them, and what injected that script."
  }
];

function requestMatchesSignalFilter(request: NetworkRequestRecord, filter: RequestSignalFilter): boolean {
  if (filter === "third-party") return request.thirdParty;
  if (filter === "known-service") return Boolean(request.tracker);
  if (filter === "shields-blocked") return request.blockedByShields === true;
  if (filter === "fingerprinting") return (request.tracker?.fingerprinting ?? 0) > 0;
  if (filter === "provenance") return Boolean(request.provenance);
  return true;
}

function requestMatchesStatusFilter(request: NetworkRequestRecord, filter: RequestStatusFilter): boolean {
  const status = request.status;
  if (filter === "pending") return status === null;
  if (status === null) return filter === "all";
  if (filter === "ok") return status >= 200 && status < 300;
  if (filter === "redirect") return status >= 300 && status < 400;
  if (filter === "client-error") return status >= 400 && status < 500;
  if (filter === "server-error") return status >= 500;
  return true;
}

function RequestProvenanceCell({ request }: { request: NetworkRequestRecord }) {
  const summary = requestProvenanceSummary(request);
  if (!summary) return <span className="muted">-</span>;

  return (
    <span className="provenance-cell">
      <span>{summary.primary}</span>
      {summary.secondary && <small>{summary.secondary}</small>}
    </span>
  );
}

function StatusCell({ status }: { status: number | null }) {
  if (status === null) return <span className="status-pending">n/a</span>;
  if (status >= 400) return <span className="status-bad">{status}</span>;
  return <span className="status-ok">{status}</span>;
}

function TopThirdParties({ domains }: { domains: DomainSummary[] }) {
  const thirdParty = domains.filter((domain) => domain.thirdParty);
  const top = thirdParty.slice(0, 8);
  if (top.length === 0) return <p className="muted">No third-party domains observed in this scan.</p>;

  return (
    <div className="domain-stack">
      {top.map((domain) => (
        <div className="domain-chip" key={domain.domain}>
          <div className="chip-main">
            <strong>{domain.domain}</strong>
            <span className="chip-sub">{domain.tracker ? `${domain.tracker.entity} · ${domain.tracker.category}` : "unlabeled third party"}</span>
          </div>
          <span className="count-pill">{domain.requests.toLocaleString("en-US")}</span>
        </div>
      ))}
      <ListOverflowNote total={thirdParty.length} shown={top.length} where="the domain table" />
    </div>
  );
}

// Shared "+N more" footer so truncated sidebar lists never look complete.
function ListOverflowNote({ total, shown, where }: { total: number; shown: number; where: string }) {
  if (total <= shown) return null;
  return (
    <p className="muted list-overflow-note">
      +{(total - shown).toLocaleString("en-US")} more in {where}.
    </p>
  );
}

function CookieList({ cookies }: { cookies: CookieRecord[] }) {
  if (cookies.length === 0) return <p className="muted">No cookies were visible to the scan context.</p>;

  const shown = Math.min(cookies.length, 12);
  return (
    <div className="compact-list">
      {/* Redaction can generalize many names to the same marker, so content
          alone is not a unique identity for these static rows. */}
      {cookies.slice(0, 12).map((cookie, index) => (
        <div key={`${index}:${cookie.domain}:${cookie.name}:${cookie.path}`}>
          {cookie.thirdParty ? (
            <AlertTriangle className="ico-third" size={14} aria-hidden="true" />
          ) : (
            <CheckCircle2 className="ico-first" size={14} aria-hidden="true" />
          )}
          <span>
            {cookie.name}
            <small>
              {cookie.domain} · {cookie.session ? "session" : "persistent"} · {cookie.thirdParty ? "third-party" : "first-party"}
            </small>
          </span>
        </div>
      ))}
      <ListOverflowNote total={cookies.length} shown={shown} where="the JSON export" />
    </div>
  );
}

function StorageList({ storage }: { storage: StorageRecord[] }) {
  if (storage.length === 0) return <p className="muted">No local or session storage keys observed on the final page.</p>;

  const shown = Math.min(storage.length, 12);
  return (
    <div className="compact-list">
      {storage.slice(0, 12).map((item, index) => (
        <div key={`${index}:${item.area}:${item.key}`}>
          <Database className="ico-neutral" size={14} aria-hidden="true" />
          <span>
            {item.key}
            <small>
              {item.area} · {item.valueBytes} bytes
            </small>
          </span>
        </div>
      ))}
      <ListOverflowNote total={storage.length} shown={shown} where="the JSON export" />
    </div>
  );
}

function FingerprintList({
  events,
  detections
}: {
  events: FingerprintEventSummary[];
  detections: FingerprintDetectionSummary[];
}) {
  if (events.length === 0 && detections.length === 0) {
    return <p className="muted">No instrumented high-entropy API or interaction listener signals were observed.</p>;
  }

  return (
    <div className="compact-list">
      {detections.map((detection) => (
        <div key={detection.kind}>
          <Fingerprint className="ico-warn" size={14} aria-hidden="true" />
          <span>
            {detectionLabel(detection)}
            <small>{detectionEvidence(detection)}</small>
          </span>
        </div>
      ))}
      {/* One API can appear once per phase on v2 runs; the index keeps keys unique. */}
      {events.map((event, index) => (
        <div key={`${event.api}:${index}`}>
          <Fingerprint className="ico-neutral" size={14} aria-hidden="true" />
          <span>
            {event.api}
            <small>{event.count} calls</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function PixelEventsList({ pixels }: { pixels: PixelEventSummary[] }) {
  if (pixels.length === 0) {
    return <p className="muted">No advertising-pixel events were decoded in this visit.</p>;
  }

  return (
    <div className="compact-list">
      {pixels.map((pixel) => {
        const events = pixel.events.length > 0 ? pixel.events.join(", ") : "no named event";
        const identifiers =
          pixel.advancedMatching.length > 0
            ? ` · identifiers: ${pixel.advancedMatching.map(pixelFieldLabel).join(", ")}`
            : "";
        return (
          <div key={pixel.platform}>
            <Radar className={pixel.advancedMatching.length > 0 ? "ico-warn" : "ico-neutral"} size={14} aria-hidden="true" />
            <span>
              {pixel.product}
              <small>
                {events}
                {identifiers} · {pixel.requests} {pixel.requests === 1 ? "request" : "requests"}
              </small>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export { CookieList, DomainTable, FingerprintList, PixelEventsList, RequestTable, StorageList, TopThirdParties, Warnings };
