"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, Fingerprint, Radar } from "lucide-react";
import { requestProvenanceSearchText, requestProvenanceSummary } from "@/lib/report-findings";
import { visitPhaseLabel } from "@/lib/report-phase-evidence";
import { displayEvidenceName, displayHost, hostMatchesQuery, plural } from "@/lib/text-format";
import { detectionEvidence, detectionLabel, pixelFieldLabel } from "@/lib/report-insights";
import { isReviewedCookieName, isReviewedStorageKey } from "@/lib/public-name-policy";
import { listOverflowCopy } from "@/lib/report-table-copy";
import {
  identifiedHostCatalogMatchLabel,
  type IdentifiedHostFact,
  type RunFacts
} from "@/lib/report-facts";
import {
  parseEvidenceHash,
  type EvidenceRequestSignal,
  type EvidenceSection,
  type EvidenceTarget
} from "@/lib/report-evidence-navigation";
import type {
  CookieRecord,
  DomainSummary,
  FingerprintDetectionSummary,
  FingerprintEventSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  StorageRecord
} from "@/lib/types";
import type { PhaseSpan } from "@/lib/scan-report-v2";

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

function roleTag(
  domain: DomainSummary,
  identity: IdentifiedHostFact | undefined
) {
  if ((identity?.catalogMatches.length ?? 0) > 0) {
    return <span className="role-tag role-tracker">service</span>;
  }
  if (domain.thirdParty) return <span className="role-tag role-third">third-party</span>;
  return <span className="role-tag role-first">first-party</span>;
}

function DomainTable({ domains, facts }: { domains: DomainSummary[]; facts: RunFacts }) {
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const evidenceTarget = useEvidenceTarget("domains");
  const filtered = useMemo(
    () => domains.filter((domain) => hostMatchesQuery(domain.domain, query)),
    [domains, query]
  );
  const shown = filtered.slice(0, 100);

  useEffect(() => {
    if (!evidenceTarget) return;
    setQuery(evidenceTarget.query ?? "");
    if (detailsRef.current) detailsRef.current.open = true;
    revealEvidenceSection(detailsRef.current);
  }, [evidenceTarget]);

  return (
    <details id="domain-evidence" ref={detailsRef} className="data-section disclosure" open>
      <summary className="section-heading">
        <h2>Domain evidence</h2>
        <span className="count-badge">{plural(domains.length, "recorded domain")}</span>
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
      <div className="table-wrap" role="region" aria-label="Domain evidence table" tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>Domain</th>
              <th>Role</th>
              <th>Requests</th>
              <th>Catalog match</th>
              <th>Resource types</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((domain) => {
              const identity = facts.identity.hosts.find(
                (entry) => entry.host === domain.domain
              );
              return (
                <tr key={domain.domain}>
                  <td className="mono" data-label="Domain">{displayHost(domain.domain)}</td>
                  <td data-label="Role">{roleTag(domain, identity)}</td>
                  <td data-label="Requests">{domain.requests.toLocaleString("en-US")}</td>
                  <td data-label="Catalog match">
                    {identifiedHostCatalogMatchLabel(identity) ?? "-"}
                  </td>
                  <td data-label="Resource types">{domain.resourceTypes.join(", ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="table-empty">
            {query
              ? <>No recorded domains match &ldquo;{query}&rdquo;.</>
              : facts.evidence.requests.state === "unsupported"
                ? "Domain measurement was unavailable for this report."
                : facts.evidence.requests.state === "censored"
                  ? "No domain rows were retained before collection stopped; this is not evidence that no requests occurred."
                  : facts.subject.describesSubject
                    ? "No domains were recorded in this passive visit."
                    : "No domains were recorded for the returned document; the requested page was not established."}
          </p>
        )}
        {filtered.length > 0 && facts.evidence.requests.state === "censored" && (
          <p className="muted">These are retained domain rows, not a complete inventory.</p>
        )}
        {filtered.length > 0 && !facts.subject.describesSubject && (
          <p className="muted">These domains describe the returned document, not a verified normal page load.</p>
        )}
        {filtered.length > shown.length && (
          <p className="row-more">Showing first 100 of {filtered.length} matching domains. Export JSON for the full list.</p>
        )}
      </div>
    </details>
  );
}

function RequestTable({
  requests,
  phases,
  facts
}: {
  requests: NetworkRequestRecord[];
  phases: PhaseSpan[] | null;
  facts: RunFacts;
}) {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [signalFilter, setSignalFilter] = useState<RequestSignalFilter>("all");
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>("all");
  const [resourceFilter, setResourceFilter] = useState("all");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const evidenceTarget = useEvidenceTarget("requests");

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
        hostMatchesQuery(request.domain, q) ||
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
  useEffect(() => {
    if (!evidenceTarget) return;
    setQuery(evidenceTarget.query ?? "");
    setSignalFilter(evidenceTarget.signal ?? "all");
    setStatusFilter("all");
    setResourceFilter("all");
    setOpened(true);
    if (detailsRef.current) detailsRef.current.open = true;
    revealEvidenceSection(detailsRef.current);
  }, [evidenceTarget]);
  // v2 evidence rows are phase-tagged; the column renders only when at least
  // one row carries a phase, so v1 tables stay unchanged.
  const hasPhases = useMemo(() => requests.some((request) => typeof (request as { phaseId?: unknown }).phaseId === "number"), [requests]);
  const phaseLabels = useMemo(
    () => new Map((phases ?? []).map((phase) => [phase.phaseId, visitPhaseLabel(phase.kind)])),
    [phases]
  );

  return (
    <details
      id="request-evidence"
      ref={detailsRef}
      className="data-section disclosure"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="section-heading">
        <h2>Request log</h2>
        <span className="count-badge">
          {filtered.length === requests.length
            ? plural(requests.length, "recorded request")
            : `${filtered.length} of ${requests.length} recorded`}
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
      <div
        className={`table-wrap request-table${hasPhases ? " has-phase-column" : ""}`}
        role="region"
        aria-label="Request log table"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Time</th>
              {hasPhases && <th title="The recorded visit phase this request belongs to; the phase table above shows its span">Phase</th>}
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
                  <td data-label="Phase">
                    {requestPhaseLabel(request, phaseLabels)}
                  </td>
                )}
                <td data-label="Status">
                  <StatusCell status={request.status} />
                </td>
                <td data-label="Type">{request.resourceType}</td>
                <td className="mono" data-label="Domain">{displayHost(request.domain)}</td>
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
              : facts.evidence.requests.state === "unsupported"
                ? "Request measurement was unavailable for this report."
                : facts.evidence.requests.state === "censored"
                  ? "No request rows were retained before collection stopped; this is not evidence that no requests occurred."
                  : facts.subject.describesSubject
                    ? "No requests were recorded in this passive visit."
                    : "No requests were recorded for the returned document; the requested page was not established."}
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
        {shown.length > 0 && facts.evidence.requests.state === "censored" && (
          <p className="muted">This log contains retained rows only; collection did not produce a complete request inventory.</p>
        )}
        {shown.length > 0 && !facts.subject.describesSubject && (
          <p className="muted">These requests describe the returned document, not a verified normal page load.</p>
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

/**
 * A dash glyph is not an accessible cell value: screen readers either skip it
 * or announce punctuation, so an untagged row reads as an empty cell. Name the
 * state in words instead, the way the sibling phase table already does.
 */
function requestPhaseLabel(request: NetworkRequestRecord, labels: ReadonlyMap<number, string>): string {
  const phaseId = requestPhaseId(request);
  if (phaseId === null) return "Untagged";
  const label = labels.get(phaseId);
  return label ? `P${phaseId} · ${label}` : `P${phaseId}`;
}

type RequestSignalFilter = EvidenceRequestSignal;
type RequestStatusFilter = "all" | "ok" | "redirect" | "client-error" | "server-error" | "pending";

const REQUEST_SIGNAL_FILTERS: { value: RequestSignalFilter; label: string; title: string }[] = [
  { value: "all", label: "All", title: "Every recorded request row." },
  { value: "third-party", label: "Third-party", title: "Requests to any domain other than the site itself." },
  {
    value: "known-service",
    label: "Catalog matches",
    title:
      "Retained request rows whose recorded host matched a reviewed service-catalog suffix (either the full host or a parent-domain suffix). Includes first-party and third-party matches and does not imply a tracking-related role."
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
    title: "Catalog-matched request rows whose catalog entry carries a fingerprinting signal."
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

function useEvidenceTarget(section: EvidenceSection): EvidenceTarget | null {
  const [target, setTarget] = useState<EvidenceTarget | null>(null);

  useEffect(() => {
    function readTarget(hash: string) {
      const parsed = parseEvidenceHash(hash);
      setTarget(parsed?.section === section ? parsed : null);
    }
    const readCurrentTarget = () => readTarget(window.location.hash);

    // A same-hash link does not emit `hashchange`. Re-apply it when a reader
    // has adjusted the filters manually and then asks for the same evidence
    // link again.
    function readRepeatedTarget(event: MouseEvent) {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a");
      const href = anchor?.getAttribute("href") ?? "";
      if (!href.startsWith("#evidence=") || anchor?.hash !== window.location.hash) return;
      readTarget(anchor.hash);
    }

    readCurrentTarget();
    window.addEventListener("hashchange", readCurrentTarget);
    document.addEventListener("click", readRepeatedTarget);
    return () => {
      window.removeEventListener("hashchange", readCurrentTarget);
      document.removeEventListener("click", readRepeatedTarget);
    };
  }, [section]);

  return target;
}

function revealEvidenceSection(details: HTMLDetailsElement | null) {
  if (!details) return;
  window.requestAnimationFrame(() => {
    // The global reduced-motion rule cannot reach a scroll requested in JS, so this
    // is the one animation a vestibular-sensitive visitor would still be served.
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    details.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    details.querySelector("summary")?.focus({ preventScroll: true });
  });
}

function TopThirdParties({ facts }: { facts: RunFacts }) {
  const domains = facts.run.evidence.domains;
  const thirdParty = domains.filter((domain) => domain.thirdParty);
  const top = thirdParty.slice(0, 8);
  if (top.length === 0) {
    if (facts.evidence.requests.state === "unsupported") {
      return <p className="muted">Request evidence was not captured by this producer.</p>;
    }
    if (facts.evidence.requests.state === "censored") {
      return <p className="muted">No third-party hosts were retained before request capture stopped; absence is unproven.</p>;
    }
    if (!facts.subject.describesSubject) {
      return <p className="muted">No third-party hosts were observed on the returned document; this does not describe the site&apos;s normal page.</p>;
    }
    return <p className="muted">No third-party hosts observed in this scan.</p>;
  }

  return (
    <div className="domain-stack">
      {top.map((domain) => {
        const identity = facts.identity.hosts.find((entry) => entry.host === domain.domain);
        const names = Array.from(new Set(identity?.namers.map((namer) => namer.name) ?? []));
        const catalogMatch = identifiedHostCatalogMatchLabel(identity);
        return (
          <div className="domain-chip" key={domain.domain}>
            <div className="chip-main">
              <strong>{displayHost(domain.domain)}</strong>
              <span className="chip-sub">
                {catalogMatch
                  ? catalogMatch
                  : names.length > 0
                    ? `${names.join(", ")} · operator identified; no tracking-service classification`
                    : "operator unidentified"}
              </span>
            </div>
            <span className="count-pill">{domain.requests.toLocaleString("en-US")}</span>
          </div>
        );
      })}
      <ListOverflowNote total={thirdParty.length} shown={top.length} where="the domain table" />
      {facts.evidence.requests.state === "censored" && (
        <p className="muted">Only retained request evidence is listed; additional hosts may be missing.</p>
      )}
      {!facts.subject.describesSubject && (
        <p className="muted">These hosts belong to the returned error or interstitial document, not a verified normal page load.</p>
      )}
    </div>
  );
}

// Shared "+N more" footer so truncated sidebar lists never look complete.
function ListOverflowNote({ total, shown, where }: { total: number; shown: number; where?: string }) {
  const copy = listOverflowCopy(total, shown, where);
  if (!copy) return null;
  return (
    <p className="muted list-overflow-note">
      {copy}
    </p>
  );
}

function CookieList({ cookies, facts }: { cookies: CookieRecord[]; facts: RunFacts }) {
  const state = facts.evidence.cookies.state;
  if (state === "unsupported") {
    return <p className="muted">Cookie evidence was not captured; this PageGraph import does not support it.</p>;
  }
  if (cookies.length === 0) {
    if (state === "censored") {
      return <p className="muted">The cookie snapshot was incomplete; no cookie rows were retained, so absence is unproven.</p>;
    }
    if (!facts.subject.describesSubject) {
      return <p className="muted">No cookies were visible on the returned document; this does not describe the site&apos;s normal page.</p>;
    }
    return <p className="muted">No cookies were visible to the scan context.</p>;
  }

  const shown = Math.min(cookies.length, 12);
  const hiddenNames = cookies.filter((cookie) => !isReviewedCookieName(cookie.name)).length;
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
            {displayEvidenceName(cookie.name, "cookie", index + 1)}
            <small>
              {displayHost(cookie.domain)} · {cookie.session ? "session" : "persistent"} · {cookie.thirdParty ? "third-party" : "first-party"}
            </small>
          </span>
        </div>
      ))}
      {hiddenNames > 0 && (
        <p className="muted privacy-filter-note">
          {plural(hiddenNames, "cookie name")} hidden because unreviewed names can contain identifiers. Cookie values are never recorded.
        </p>
      )}
      <ListOverflowNote total={cookies.length} shown={shown} />
      {state === "censored" && <p className="muted">Cookie snapshot incomplete; these are retained rows, not a complete final state.</p>}
      {!facts.subject.describesSubject && (
        <p className="muted">These cookies describe the returned document, not a verified normal page load.</p>
      )}
    </div>
  );
}

function StorageList({ storage, facts }: { storage: StorageRecord[]; facts: RunFacts }) {
  const state = facts.evidence.storage.state;
  if (state === "unsupported") {
    return <p className="muted">Storage evidence was not captured; this PageGraph import does not support it.</p>;
  }
  if (storage.length === 0) {
    if (state === "censored") {
      return <p className="muted">The storage snapshot was incomplete; no keys were retained, so absence is unproven.</p>;
    }
    if (!facts.subject.describesSubject) {
      return <p className="muted">No storage keys were observed on the returned document; this does not describe the site&apos;s normal page.</p>;
    }
    return <p className="muted">No local or session storage keys observed on the final page.</p>;
  }

  const shown = Math.min(storage.length, 12);
  const hiddenKeys = storage.filter((item) => !isReviewedStorageKey(item.key)).length;
  return (
    <div className="compact-list">
      {storage.slice(0, 12).map((item, index) => (
        <div key={`${index}:${item.area}:${item.key}`}>
          <Database className="ico-neutral" size={14} aria-hidden="true" />
          <span>
            {displayEvidenceName(item.key, "storage", index + 1)}
            <small>
              {item.area} · {item.valueBytes} bytes
            </small>
          </span>
        </div>
      ))}
      {hiddenKeys > 0 && (
        <p className="muted privacy-filter-note">
          {plural(hiddenKeys, "storage key")} hidden because unreviewed keys can contain identifiers. Values are not stored; only byte counts are kept.
        </p>
      )}
      <ListOverflowNote total={storage.length} shown={shown} />
      {state === "censored" && <p className="muted">Storage snapshot incomplete; these are retained keys, not a complete final state.</p>}
      {!facts.subject.describesSubject && (
        <p className="muted">These keys describe the returned document, not a verified normal page load.</p>
      )}
    </div>
  );
}

function FingerprintList({
  events,
  detections,
  facts
}: {
  events: FingerprintEventSummary[];
  detections: FingerprintDetectionSummary[];
  facts: RunFacts;
}) {
  const apiState = facts.evidence.fingerprinting.state;
  const detectorIncomplete = facts.claims["fingerprint-apis"].blockers.includes("detector-incomplete");
  if (apiState === "unsupported" && detectorIncomplete) {
    return <p className="muted">Browser-behavior evidence was not captured; this PageGraph import does not support it.</p>;
  }
  if (events.length === 0 && detections.length === 0) {
    if (apiState === "censored" || detectorIncomplete) {
      return <p className="muted">No browser-behavior signals were retained, but collection or detector work was incomplete; absence is unproven.</p>;
    }
    if (!facts.subject.describesSubject) {
      return <p className="muted">No instrumented browser-behavior signals appeared on the returned document; this does not describe the site&apos;s normal page.</p>;
    }
    return <p className="muted">No instrumented high-entropy API or interaction listener signals were observed.</p>;
  }

  return (
    <div className="compact-list">
      {detections.map((detection) => (
        <div key={detection.kind}>
          <Fingerprint
            className={
              detection.kind === "session-recording" || detection.kind === "input-monitoring"
                ? "ico-neutral"
                : "ico-warn"
            }
            size={14}
            aria-hidden="true"
          />
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
      {(apiState === "censored" || detectorIncomplete) && (
        <p className="muted">Only retained browser-behavior evidence is shown; collection or detector work was incomplete.</p>
      )}
      {!facts.subject.describesSubject && (
        <p className="muted">These signals describe the returned document, not a verified normal page load.</p>
      )}
    </div>
  );
}

function PixelEventsList({ pixels, facts }: { pixels: PixelEventSummary[]; facts: RunFacts }) {
  const evidenceIncomplete = facts.claims["pixel-events"].blockers.some(
    (blocker) => blocker !== "subject-not-established"
  );
  if (pixels.length === 0) {
    return (
      <p className="muted">
        {evidenceIncomplete
          ? "No advertising-pixel events were retained; collection or decoding was incomplete, so this is not an absence finding."
          : facts.subject.describesSubject
            ? "No advertising-pixel events were decoded in this passive visit."
            : "No advertising-pixel events were decoded in the returned document; the requested page was not established."}
      </p>
    );
  }

  return (
    <div className="compact-list">
      {pixels.map((pixel) => {
        const events = pixel.events.length > 0 ? pixel.events.join(", ") : "no named event retained";
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
      {evidenceIncomplete && (
        <p className="muted">Only retained pixel evidence is shown; collection or decoding was incomplete.</p>
      )}
      {!facts.subject.describesSubject && (
        <p className="muted">These events describe the returned document, not a verified normal page load.</p>
      )}
    </div>
  );
}

export { CookieList, DomainTable, FingerprintList, PixelEventsList, RequestTable, StorageList, TopThirdParties, Warnings };
