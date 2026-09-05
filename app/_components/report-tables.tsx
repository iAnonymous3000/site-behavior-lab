"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Database, Fingerprint, Radar } from "lucide-react";
import { requestProvenanceSearchText, requestProvenanceSummary } from "@/lib/report-findings";
import { visitPhaseLabel } from "@/lib/report-phase-evidence";
import { displayHost, displayPublicUrl, hostMatchesQuery, plural } from "@/lib/text-format";
import { detectionEvidence, detectionLabel, pixelFieldLabel } from "@/lib/report-insights";
import { isReviewedCookieName, isReviewedStorageKey } from "@/lib/public-name-policy";
import { PRINT_ROW_CAPS } from "@/lib/print-row-caps";
import { usePrintComplete } from "./print-mode";
import { listOverflowCopy } from "@/lib/report-table-copy";
import {
  groupCookiesByDomain,
  groupStorageByArea,
  recordsCovered
} from "@/lib/report-evidence-grouping";
import {
  groupReportWarnings,
  reportWarningCount,
  type ComparisonRunLabels
} from "@/lib/report-warnings";
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
import {
  attributionDestinationByHost,
  requestMatchesAttributionPair
} from "@/lib/request-attribution-map";
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

/**
 * The report's measurement caveats, as one structured block.
 *
 * This was a flat list of full-width caution banners. On a comparison that is
 * around sixteen of them in a row, and most are the same sentence twice, once
 * per visit, because the report-level list prefixes each entry with the visit
 * that recorded it. Sixteen identical-looking alarms is a wall a reader skips,
 * which is the exact opposite of what a caveat is for.
 *
 * Grouped, nothing is hidden: every distinct sentence still renders, unclicked,
 * on screen and on paper. Only the attribution moved, from a prefix repeated on
 * every line to a heading over the lines it covers. `groupReportWarnings` falls
 * back to the flat list whenever the attribution is not certain.
 */
function Warnings({
  warnings,
  runLabels
}: {
  warnings: string[];
  runLabels: ComparisonRunLabels | null;
}) {
  const groups = groupReportWarnings(warnings, runLabels);
  if (groups.length === 0) return null;
  const total = reportWarningCount(groups);

  return (
    <section className="warnings" id="measurement-limits" aria-labelledby="measurement-limits-title">
      <div className="warnings-heading">
        <AlertTriangle size={16} aria-hidden="true" />
        <h2 id="measurement-limits-title">Measurement limits</h2>
        <span className="warnings-count">
          {plural(total, "condition")} {total === 1 ? "affects" : "affect"} how this evidence reads
        </span>
      </div>
      {groups.map((group) => (
        <div className="warnings-group" key={group.scope}>
          {group.label && <p className="warnings-group-label">{group.label}</p>}
          <ul>
            {group.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
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
  const printComplete = usePrintComplete();
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const evidenceTarget = useEvidenceTarget("domains");
  const filtered = useMemo(
    () => domains.filter((domain) => hostMatchesQuery(domain.domain, query)),
    [domains, query]
  );
  const shown = filtered.slice(0, printComplete ? PRINT_ROW_CAPS.domains : 100);

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
          {/* The wrapper's role="region" names the SCROLLPORT, not the table.
              A table with no accessible name is announced as "table" with no
              indication of what it holds, and `scope` is what lets a screen
              reader read a cell back with its column. */}
          <caption className="visually-hidden">
            Every domain this visit recorded, with its role, request count and catalog match.
          </caption>
          <thead>
            <tr>
              <th scope="col">Domain</th>
              <th scope="col">Role</th>
              <th scope="col">Requests</th>
              <th scope="col">Catalog match</th>
              <th scope="col">Resource types</th>
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
                    {identifiedHostCatalogMatchLabel(identity) ?? (
                      <span className="muted">No catalog match</span>
                    )}
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
        {/* The count, not a literal. On a printComplete render this cap is
            PRINT_ROW_CAPS.domains (200), so the hardcoded 100 told a reader of
            the printed exhibit that half the rows in front of them were not
            there. The request table one section down already does this. */}
        {filtered.length > shown.length && (
          <p className="row-more">Showing first {shown.length} of {filtered.length} matching domains. Export JSON for the full list.</p>
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
  const printComplete = usePrintComplete();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState("");
  const [signalFilter, setSignalFilter] = useState<RequestSignalFilter>("all");
  const [statusFilter, setStatusFilter] = useState<RequestStatusFilter>("all");
  const [resourceFilter, setResourceFilter] = useState("all");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const evidenceTarget = useEvidenceTarget("requests");
  /**
   * An attribution drill-down selects the rows one drawn edge was summed from.
   *
   * Structural, never a text needle: the free-text filter below ORs one needle
   * across eight fields including the provenance text, so a needle naming a
   * destination also matches every row INITIATED by that host, and one host can
   * be both endpoints of different drawn edges. The predicate and the host
   * resolution both come from the map's own module so this table and the
   * diagram cannot disagree about which rows an edge covers.
   */
  const attributionPair = evidenceTarget?.pair ?? null;
  const destinationByHost = useMemo(
    () => attributionDestinationByHost(requests),
    [requests]
  );

  const resourceTypes = useMemo(
    () => Array.from(new Set(requests.map((request) => request.resourceType))).sort((a, b) => a.localeCompare(b)),
    [requests]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requests.filter((request) => {
      if (
        attributionPair &&
        !requestMatchesAttributionPair(request, attributionPair, destinationByHost)
      ) {
        return false;
      }
      if (!requestMatchesSignalFilter(request, signalFilter)) return false;
      if (!requestMatchesStatusFilter(request, statusFilter)) return false;
      if (resourceFilter !== "all" && request.resourceType !== resourceFilter) return false;
      if (!q) return true;
      return (
        hostMatchesQuery(request.domain, q) ||
        request.url.toLowerCase().includes(q) ||
        displayPublicUrl(request.url).toLowerCase().includes(q) ||
        request.method.toLowerCase().includes(q) ||
        request.resourceType.toLowerCase().includes(q) ||
        requestProvenanceSearchText(request).toLowerCase().includes(q) ||
        request.tracker?.entity.toLowerCase().includes(q) ||
        request.tracker?.category.toLowerCase().includes(q)
      );
    });
  }, [
    attributionPair,
    destinationByHost,
    requests,
    query,
    resourceFilter,
    signalFilter,
    statusFilter
  ]);

  const shown = filtered.slice(0, printComplete ? PRINT_ROW_CAPS.requests : REQUEST_SCREEN_ROW_CAP);
  const filtersActive =
    signalFilter !== "all" ||
    statusFilter !== "all" ||
    resourceFilter !== "all" ||
    query.trim() !== "" ||
    attributionPair !== null;
  function resetFilters() {
    setQuery("");
    setSignalFilter("all");
    setStatusFilter("all");
    setResourceFilter("all");
    // The attribution pair lives in the fragment, not in local state, so
    // clearing the controls without clearing it would leave a filter the reader
    // can see the effect of and cannot switch off.
    if (attributionPair && typeof window !== "undefined") {
      window.location.hash = "#evidence=requests";
    }
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
      // onToggle never fires for an element that mounts already open, so the
      // body gate below must test printComplete too. The attribute alone would
      // print an open disclosure with nothing inside it.
      open={printComplete || undefined}
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
      {printComplete || opened ? (
        <>
      <p className="muted privacy-filter-note">
        In hosts and URLs, * and … mark details hidden for privacy.
      </p>
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
        {/* The one filter with no control of its own. A query, a signal chip, a
            status and a resource all render their own state, so a reader can
            see they are set and unset them. An attribution pair arrives in the
            fragment from the map and had no visible presence at all, so a
            successful drill-down left the log filtered with nothing on screen
            saying so and nothing to press: the reader had to edit the URL. It
            renders whether or not rows survived, because an empty result is
            exactly when knowing why matters most.

            ABOVE THE TABLE, not after it. The drill-down link scrolls to the top
            of the log, so a label rendered below the rows arrives off-screen:
            measured at 360px it sat roughly 3,845px below the fold, which is a
            label the arriving reader cannot see and a control they cannot
            reach. Placement is the feature here, not decoration. */}
        {attributionPair && (
          <p className="attribution-active-filter">
            <span>
              Showing only the rows behind one attribution path:{" "}
              <strong>{attributionPair.actor}</strong> to{" "}
              <strong>{attributionPair.destination}</strong>.
            </span>{" "}
            <button type="button" className="change-list-toggle" onClick={resetFilters}>
              Clear filters
            </button>
          </p>
        )}
      <div
        className={`table-wrap request-table${hasPhases ? " has-phase-column" : ""}`}
        role="region"
        aria-label="Request log table"
        tabIndex={0}
      >
        <table>
          <caption className="visually-hidden">
            Every request row this visit retained, with its time, status, resource type, domain and
            recorded provenance.
          </caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {hasPhases && <th scope="col" title="The recorded visit phase this request belongs to; the phase table above shows its span">Phase</th>}
              <th scope="col">Status</th>
              <th scope="col">Type</th>
              <th scope="col">Domain</th>
              <th scope="col">Provenance</th>
              <th scope="col">URL</th>
            </tr>
          </thead>
          <tbody>
            {/* Keyed with the index: v2 evidence rows are phase-tagged, so one
                request id can legitimately appear in several phases. */}
            {shown.map((request, index) => (
              <tr key={`${request.id}:${index}`}>
                <td className="mono time-cell" data-label="Time">{request.startedAtMs.toLocaleString("en-US")}ms</td>
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
                <td className="url-cell mono" data-label="URL">{displayPublicUrl(request.url)}</td>
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
          <p className="row-more">
            Showing first {shown.length} of {filtered.length} matching requests. Export JSON for the full log.
          </p>
        )}
      </div>
        </>
      ) : (
        <p className="muted disclosure-lazy-note">
          Open the request log to render its bounded first {REQUEST_SCREEN_ROW_CAP} rows and filters.
        </p>
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

/** Screen keeps the log light until a reader asks for it; print does not. */
const REQUEST_SCREEN_ROW_CAP = 80;

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
    title: "Requests whose recorded provenance can be shown: the initiator, script, or injecting actor the request is attributed to."
  }
];

function requestMatchesSignalFilter(request: NetworkRequestRecord, filter: RequestSignalFilter): boolean {
  if (filter === "third-party") return request.thirdParty;
  if (filter === "known-service") return Boolean(request.tracker);
  if (filter === "shields-blocked") return request.blockedByShields === true;
  if (filter === "fingerprinting") return (request.tracker?.fingerprinting ?? 0) > 0;
  // Match what the row can actually show, not merely that a provenance object
  // exists. The adapter deliberately retains id-only provenance (graph join
  // keys with no url or domain), so Boolean(request.provenance) matched rows
  // the table then rendered with no causal chain at all, while the report was
  // simultaneously warning that no provenance was supplied. The summary is the
  // same predicate the row itself uses.
  if (filter === "provenance") return requestProvenanceSummary(request) !== null;
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
  // Same rule as requestPhaseLabel above: a dash glyph is not an accessible
  // cell value. This is not a rare path -- a v1 report, or any capture without
  // PageGraph attribution, renders nothing here on every row, so the whole
  // column read as blank. Name the state instead.
  if (!summary) return <span className="muted">Not attributed</span>;

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
        // A framework-endpoint namer (a shared IAB TCF host) names the standard,
        // not the operator that ran it, so it must not render as "operator
        // identified"; the platform behind such a host stays unnamed.
        const operatorNames = Array.from(
          new Set(
            (identity?.namers ?? [])
              .filter((namer) => namer.kind !== "framework-endpoint")
              .map((namer) => namer.name)
          )
        );
        const frameworkNames = Array.from(
          new Set(
            (identity?.namers ?? [])
              .filter((namer) => namer.kind === "framework-endpoint")
              .map((namer) => namer.name)
          )
        );
        const catalogMatch = identifiedHostCatalogMatchLabel(identity);
        return (
          <div className="domain-chip" key={domain.domain}>
            <div className="chip-main">
              <strong>{displayHost(domain.domain)}</strong>
              <span className="chip-sub">
                {catalogMatch
                  ? catalogMatch
                  : operatorNames.length > 0
                    ? `${operatorNames.join(", ")} · operator identified; no tracking-service classification`
                    : frameworkNames.length > 0
                      ? `${frameworkNames.join(", ")} · shared consent framework endpoint; operator not identified`
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
  const printComplete = usePrintComplete();
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

  // Grouped by setting domain, because the field these rows used to LEAD with
  // is the one redaction blanks. A real report spent the whole rail on twelve
  // rows of "Cookie N · name hidden for privacy" and then disclosed that 259
  // further records were not shown at all. The same twelve rows now cover every
  // record on the busiest domains, and the reader can see which third parties
  // set how many, and whether they persist.
  const groups = groupCookiesByDomain(cookies);
  const shownGroups = Math.min(groups.length, printComplete ? PRINT_ROW_CAPS.cookies : 12);
  // The overflow disclosure counts records, not domains.
  const shown = recordsCovered(groups, shownGroups);
  const hiddenNames = cookies.filter((cookie) => !isReviewedCookieName(cookie.name)).length;
  return (
    <div className="evidence-group-list">
      {groups.slice(0, shownGroups).map((group) => (
        <div className="evidence-group" key={group.domain}>
          <div className="evidence-group-top">
            {group.thirdParty ? (
              <AlertTriangle className="ico-third" size={14} aria-hidden="true" />
            ) : (
              <CheckCircle2 className="ico-first" size={14} aria-hidden="true" />
            )}
            <span className="evidence-group-name">{displayHost(group.domain)}</span>
            <span className="evidence-group-count">{group.count.toLocaleString("en-US")}</span>
          </div>
          <p className="evidence-group-facts">
            {group.thirdParty ? "third-party" : "first-party"}
            {group.persistent > 0 && ` · ${group.persistent.toLocaleString("en-US")} persistent`}
            {group.session > 0 && ` · ${group.session.toLocaleString("en-US")} session`}
          </p>
          {/* A publishable name is stronger evidence than a count, so the names
              redaction does allow are still shown rather than folded away. */}
          {group.namedCookies.length > 0 && (
            <p className="evidence-group-names">{group.namedCookies.join(", ")}</p>
          )}
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
  const printComplete = usePrintComplete();
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

  // Same reasoning as the cookie list: the key is the redacted field, so twelve
  // rows of "Storage key N · name hidden for privacy" spent the rail on the one
  // thing it could not say. The area, the count and the recorded size survive
  // redaction, so those lead.
  const groups = groupStorageByArea(storage);
  const shownGroups = Math.min(groups.length, printComplete ? PRINT_ROW_CAPS.storage : 12);
  const shown = recordsCovered(groups, shownGroups);
  const hiddenKeys = storage.filter((item) => !isReviewedStorageKey(item.key)).length;
  return (
    <div className="evidence-group-list">
      {groups.slice(0, shownGroups).map((group) => (
        <div className="evidence-group" key={group.area}>
          <div className="evidence-group-top">
            <Database className="ico-neutral" size={14} aria-hidden="true" />
            <span className="evidence-group-name">{group.area}</span>
            <span className="evidence-group-count">{group.count.toLocaleString("en-US")}</span>
          </div>
          <p className="evidence-group-facts">
            {plural(group.count, "key")} · {plural(group.valueBytes, "byte")} recorded
          </p>
          {group.namedKeys.length > 0 && (
            <p className="evidence-group-names">{group.namedKeys.join(", ")}</p>
          )}
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
  const behaviorEvidenceIncomplete = facts.claims["session-recording-input-monitoring"].blockers.some(
    (blocker) => blocker !== "subject-not-established"
  );
  if (apiState === "unsupported" && detectorIncomplete) {
    return <p className="muted">Browser-behavior evidence was not captured; this PageGraph import does not support it.</p>;
  }
  if (events.length === 0 && detections.length === 0) {
    if (apiState === "censored" || detectorIncomplete) {
      return <p className="muted">No browser-behavior signals were retained, but collection or detector work was incomplete; absence is unproven.</p>;
    }
    if (behaviorEvidenceIncomplete) {
      return <p className="muted">No instrumented API event records were retained. Heuristic and listener evidence is unavailable or incomplete; their absence is unproven.</p>;
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
            <small>{plural(event.count, "call")}</small>
          </span>
        </div>
      ))}
      {(apiState === "censored" || detectorIncomplete) && (
        <p className="muted">Only retained browser-behavior evidence is shown; collection or detector work was incomplete.</p>
      )}
      {behaviorEvidenceIncomplete && (
        <p className="muted">Heuristic and listener evidence is unavailable or incomplete; only retained observations are shown.</p>
      )}
      {!facts.subject.describesSubject && (
        <p className="muted">These signals describe the returned document, not a verified normal page load.</p>
      )}
    </div>
  );
}

function PixelEventsList({ pixels, facts, corrected = false }: { pixels: PixelEventSummary[]; facts: RunFacts; corrected?: boolean }) {
  const evidenceIncomplete = facts.claims["pixel-events"].blockers.some(
    (blocker) => blocker !== "subject-not-established"
  );
  if (pixels.length === 0) {
    return (
      <p className="muted">
        {facts.claims["pixel-events"].blockers.includes("evidence-unrecorded")
          ? "This legacy report did not record pixel evidence; an empty display is not an absence finding."
          : evidenceIncomplete
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
        const events = pixel.events.length > 0 ? pixel.events.map(event =>
          corrected && pixel.platform === "X" && event === "Purchase"
            ? "Purchase (unsupported historical label; see correction)" : event
        ).join(", ") : "no named event retained";
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
