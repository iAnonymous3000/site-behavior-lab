"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, Fingerprint } from "lucide-react";
import { requestProvenanceSearchText, requestProvenanceSummary } from "@/lib/report-findings";
import { detectionEvidence, detectionLabel, fingerprintDetections } from "@/lib/report-insights";
import type { CookieRecord, DomainSummary, NetworkRequestRecord, ScanResult } from "@/lib/types";

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <section className="warnings">
      {warnings.map((warning) => (
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
            {filtered.map((domain) => (
              <tr key={domain.domain}>
                <td className="mono" data-label="Domain">{domain.domain}</td>
                <td data-label="Role">{roleTag(domain)}</td>
                <td data-label="Requests">{domain.requests.toLocaleString()}</td>
                <td data-label="Known service">{domain.tracker ? `${domain.tracker.entity}: ${domain.tracker.category}` : "-"}</td>
                <td data-label="Resource types">{domain.resourceTypes.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="table-empty">No domains match &ldquo;{query}&rdquo;.</p>}
      </div>
    </details>
  );
}

function RequestTable({ result }: { result: ScanResult }) {
  const [query, setQuery] = useState("");
  const [signalFilter, setSignalFilter] = useState<RequestSignalFilter>("all");
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>("all");
  const [resourceFilter, setResourceFilter] = useState("all");

  const resourceTypes = useMemo(
    () => Array.from(new Set(result.requests.map((request) => request.resourceType))).sort((a, b) => a.localeCompare(b)),
    [result.requests]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return result.requests.filter((request) => {
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
  }, [result.requests, query, resourceFilter, signalFilter, statusFilter]);

  const shown = filtered.slice(0, 80);

  return (
    <details className="data-section disclosure">
      <summary className="section-heading">
        <h2>Request log</h2>
        <span className="count-badge">
          {filtered.length === result.requests.length
            ? `${result.requests.length} requests`
            : `${filtered.length} of ${result.requests.length}`}
        </span>
        <ChevronDown className="disclosure-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="section-tools disclosure-tools request-log-tools">
        <div className="request-filter-chips" role="group" aria-label="Request signal filters">
          {REQUEST_SIGNAL_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={signalFilter === filter.value ? "secondary-button" : "ghost-button"}
              aria-pressed={signalFilter === filter.value}
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
              <th>Status</th>
              <th>Type</th>
              <th>Domain</th>
              <th>Provenance</th>
              <th>URL</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((request) => (
              <tr key={request.id}>
                <td className="mono" data-label="Time">{request.startedAtMs.toLocaleString()}ms</td>
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
        {shown.length === 0 && <p className="table-empty">No requests match the current filter.</p>}
        {filtered.length > shown.length && (
          <p className="row-more">Showing first 80 of {filtered.length} matching requests. Export JSON for the full log.</p>
        )}
      </div>
    </details>
  );
}

type RequestSignalFilter = "all" | "third-party" | "known-service" | "shields-blocked" | "fingerprinting" | "provenance";
type RequestStatusFilter = "all" | "ok" | "redirect" | "client-error" | "server-error" | "pending";

const REQUEST_SIGNAL_FILTERS: { value: RequestSignalFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "third-party", label: "Third-party" },
  { value: "known-service", label: "Known services" },
  { value: "shields-blocked", label: "Shields-blocked" },
  { value: "fingerprinting", label: "Fingerprinting" },
  { value: "provenance", label: "Provenance" }
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
  const top = domains.filter((domain) => domain.thirdParty).slice(0, 8);
  if (top.length === 0) return <p className="muted">No third-party domains observed in this scan.</p>;

  return (
    <div className="domain-stack">
      {top.map((domain) => (
        <div className="domain-chip" key={domain.domain}>
          <div className="chip-main">
            <strong>{domain.domain}</strong>
            <span className="chip-sub">{domain.tracker ? `${domain.tracker.entity} · ${domain.tracker.category}` : "unlabeled third party"}</span>
          </div>
          <span className="count-pill">{domain.requests.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function CookieList({ cookies }: { cookies: CookieRecord[] }) {
  if (cookies.length === 0) return <p className="muted">No cookies were visible to the scan context.</p>;

  return (
    <div className="compact-list">
      {cookies.slice(0, 12).map((cookie) => (
        <div key={`${cookie.domain}:${cookie.name}:${cookie.path}`}>
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
    </div>
  );
}

function StorageList({ result }: { result: ScanResult }) {
  if (result.storage.length === 0) return <p className="muted">No local or session storage keys observed on the final page.</p>;

  return (
    <div className="compact-list">
      {result.storage.slice(0, 12).map((item) => (
        <div key={`${item.area}:${item.key}`}>
          <Database className="ico-neutral" size={14} aria-hidden="true" />
          <span>
            {item.key}
            <small>
              {item.area} · {item.valueBytes} bytes
            </small>
          </span>
        </div>
      ))}
    </div>
  );
}

function FingerprintList({ result }: { result: ScanResult }) {
  const detections = fingerprintDetections(result);
  if (result.fingerprintEvents.length === 0 && detections.length === 0) {
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
      {result.fingerprintEvents.map((event) => (
        <div key={event.api}>
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

export { CookieList, DomainTable, FingerprintList, RequestTable, StorageList, TopThirdParties, Warnings };
