"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { provenanceChangeText } from "@/lib/report-findings";
import { plural } from "@/lib/text-format";
import type {
  ComparisonMetricDelta,
  ComparisonScanResult,
  CookieChange,
  DomainChange,
  EntityChange,
  FingerprintingChange,
  ProvenanceChange,
  StorageKeyChange
} from "@/lib/types";

function ComparisonPanel({ report }: { report: ComparisonScanResult }) {
  const labels = comparisonRunLabels(report);
  const addedCookies = report.diff.addedCookies ?? [];
  const removedCookies = report.diff.removedCookies ?? [];
  const addedStorageKeys = report.diff.addedStorageKeys ?? [];
  const removedStorageKeys = report.diff.removedStorageKeys ?? [];
  const addedFingerprinting = report.diff.addedFingerprinting ?? [];
  const removedFingerprinting = report.diff.removedFingerprinting ?? [];
  const addedProvenance = report.diff.addedProvenance ?? [];
  const removedProvenance = report.diff.removedProvenance ?? [];
  const metrics = [
    { label: "Requests", metric: report.diff.totalRequests },
    { label: "Third-party requests", metric: report.diff.thirdPartyRequests },
    { label: "Known-service requests", metric: report.diff.knownTrackerRequests },
    { label: "Third-party domains", metric: report.diff.thirdPartyDomains },
    { label: "Cookies", metric: report.diff.cookies },
    { label: "Third-party cookies", metric: report.diff.thirdPartyCookies },
    { label: "Storage keys", metric: report.diff.storageEntries },
    { label: "Fingerprint events", metric: report.diff.fingerprintEvents },
    ...(report.diff.shieldsBlockedRequests ? [{ label: "Shields-blocked", metric: report.diff.shieldsBlockedRequests }] : [])
  ].filter((item): item is { label: string; metric: ComparisonMetricDelta } => Boolean(item.metric));

  return (
    <section className="comparison-card">
      <div className="comparison-heading">
        <div>
          <p className="eyebrow">{comparisonEyebrow(report)}</p>
          <h2>
            {labels.baseline} → {labels.variant} delta
          </h2>
        </div>
        <div className="comparison-runs">
          <span>
            {labels.baseline}: {report.baseline.summary.durationMs.toLocaleString()}ms
          </span>
          <span>
            {labels.variant}: {report.variant.summary.durationMs.toLocaleString()}ms
          </span>
        </div>
      </div>
      <div className="comparison-metrics">
        {metrics.map((item) => (
          <DeltaTile key={item.label} label={item.label} metric={item.metric} />
        ))}
      </div>
      <div className="comparison-lists">
        <ChangeList title={`Domains only with ${labels.variant}`} changes={report.diff.addedDomains} tone="added" />
        <ChangeList title={`Domains only with ${labels.baseline}`} changes={report.diff.removedDomains} tone="removed" />
        <EntityChangeList title={`Entities only with ${labels.variant}`} changes={report.diff.addedEntities} tone="added" />
        <EntityChangeList title={`Entities only with ${labels.baseline}`} changes={report.diff.removedEntities} tone="removed" />
        <CookieChangeList title={`Cookies only with ${labels.variant}`} changes={addedCookies} tone="added" />
        <CookieChangeList title={`Cookies only with ${labels.baseline}`} changes={removedCookies} tone="removed" />
        <StorageChangeList title={`Storage keys only with ${labels.variant}`} changes={addedStorageKeys} tone="added" />
        <StorageChangeList title={`Storage keys only with ${labels.baseline}`} changes={removedStorageKeys} tone="removed" />
        {(addedFingerprinting.length > 0 || removedFingerprinting.length > 0) && (
          <>
            <FingerprintingChangeList title={`Fingerprinting only with ${labels.variant}`} changes={addedFingerprinting} tone="added" />
            <FingerprintingChangeList title={`Fingerprinting only with ${labels.baseline}`} changes={removedFingerprinting} tone="removed" />
          </>
        )}
        {(addedProvenance.length > 0 || removedProvenance.length > 0) && (
          <>
            <ProvenanceChangeList title={`Causal paths only with ${labels.variant}`} changes={addedProvenance} tone="added" />
            <ProvenanceChangeList title={`Causal paths only with ${labels.baseline}`} changes={removedProvenance} tone="removed" />
          </>
        )}
      </div>
    </section>
  );
}

function comparisonRunLabels(report: ComparisonScanResult): { baseline: string; variant: string } {
  if (report.runLabels) return report.runLabels;
  if (report.comparisonType === "gpc") return { baseline: "GPC off", variant: "GPC on" };
  if (report.comparisonType === "shields") return { baseline: "Shields off", variant: "Shields on" };
  if (report.comparisonType === "temporal") return { baseline: "Before", variant: "After" };
  return { baseline: "Baseline", variant: "Variant" };
}

function comparisonEyebrow(report: ComparisonScanResult): string {
  if (report.comparisonType === "gpc") return "GPC Comparison";
  if (report.comparisonType === "shields") return "Shields Comparison";
  if (report.comparisonType === "temporal") return "Temporal Comparison";
  return "Comparison Report";
}

function DeltaTile({ label, metric }: { label: string; metric: ComparisonMetricDelta }) {
  const direction = metric.delta > 0 ? "up" : metric.delta < 0 ? "down" : "flat";
  const formattedDelta = `${metric.delta > 0 ? "+" : ""}${metric.delta.toLocaleString()}`;
  return (
    <div className={`delta-tile delta-${direction}`}>
      <span>{label}</span>
      <strong>{formattedDelta}</strong>
      <small>
        {metric.before.toLocaleString()} → {metric.after.toLocaleString()}
      </small>
    </div>
  );
}

const DIFF_COLLAPSED_COUNT = 6;

function DiffList<T>({
  title,
  emptyText,
  items,
  renderItem,
  className
}: {
  title: string;
  emptyText: string;
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, DIFF_COLLAPSED_COUNT);

  return (
    <div className={`change-list${className ? ` ${className}` : ""}`}>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <>
          {visible.map(renderItem)}
          {items.length > DIFF_COLLAPSED_COUNT && (
            <button type="button" className="change-list-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Show fewer" : `Show all ${items.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ChangeList({ title, changes, tone }: { title: string; changes: DomainChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No domain changes observed."
      items={changes}
      renderItem={(change) => (
        <div className={`change-row change-${tone}`} key={change.domain}>
          <span>
            <strong>{change.domain}</strong>
            <small>{change.tracker ? `${change.tracker.entity} · ${change.tracker.category}` : "unlabeled"}</small>
          </span>
          <b>{change.requests}</b>
        </div>
      )}
    />
  );
}

function EntityChangeList({ title, changes, tone }: { title: string; changes: EntityChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No entity changes observed."
      items={changes}
      renderItem={(change) => (
        <div className={`change-row change-${tone}`} key={change.entity}>
          <span>
            <strong>{change.entity}</strong>
            <small>{plural(change.domains, "domain")}</small>
          </span>
          <b>{change.requests}</b>
        </div>
      )}
    />
  );
}

function CookieChangeList({ title, changes, tone }: { title: string; changes: CookieChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No cookie changes observed."
      items={changes}
      renderItem={(change, index) => (
        <div className={`change-row change-${tone}`} key={`${change.name}:${change.domain}:${index}`}>
          <span>
            <strong>{change.name}</strong>
            <small>{change.domain}</small>
          </span>
          <b className="change-tag">{change.thirdParty ? "third-party" : "first-party"}</b>
        </div>
      )}
    />
  );
}

function StorageChangeList({ title, changes, tone }: { title: string; changes: StorageKeyChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No storage key changes observed."
      items={changes}
      renderItem={(change, index) => (
        <div className={`change-row change-${tone}`} key={`${change.area}:${change.key}:${index}`}>
          <span>
            <strong>{change.key}</strong>
            <small>{change.area === "sessionStorage" ? "session storage" : "local storage"}</small>
          </span>
        </div>
      )}
    />
  );
}

function FingerprintingChangeList({ title, changes, tone }: { title: string; changes: FingerprintingChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No fingerprinting changes observed."
      items={changes}
      renderItem={(change) => (
        <div className={`change-row change-${tone}`} key={change.kind}>
          <span>
            <strong>{fingerprintingKindLabel(change.kind)}</strong>
            <small>{change.heuristic}</small>
          </span>
          <b>{change.count}</b>
        </div>
      )}
    />
  );
}

function fingerprintingKindLabel(kind: FingerprintingChange["kind"]): string {
  switch (kind) {
    case "canvas-fingerprinting":
      return "Canvas readback";
    case "canvas-font-fingerprinting":
      return "Canvas font probing";
    case "webgl-fingerprinting":
      return "WebGL entropy read";
    case "audio-fingerprinting":
      return "Audio rendering";
    case "webrtc-fingerprinting":
      return "WebRTC peer connection";
    case "session-recording":
      return "Session-recording listeners";
    case "input-monitoring":
      return "Input-monitoring listeners";
    default:
      return kind;
  }
}

function ProvenanceChangeList({ title, changes, tone }: { title: string; changes: ProvenanceChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No causal path changes observed."
      className="provenance-change-list"
      items={changes}
      renderItem={(change) => (
        <div
          className={`change-row change-${tone}`}
          key={`${change.domain}:${change.initiator ?? ""}:${change.script ?? ""}:${change.injectedBy ?? ""}`}
        >
          <span>
            <strong>{change.domain}</strong>
            <small>{provenanceChangeText(change)}</small>
          </span>
          <b>{change.requests}</b>
        </div>
      )}
    />
  );
}

export { ComparisonPanel };
