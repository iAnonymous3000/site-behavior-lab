"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { comparisonArmViews, comparisonDiffView, type ReportView } from "@/lib/scan-report-views";
import { provenanceChangeText } from "@/lib/report-findings";
import { pixelFieldLabel } from "@/lib/report-insights";
import { plural } from "@/lib/text-format";
import type {
  ComparisonMetricDelta,
  CookieChange,
  DomainChange,
  EntityChange,
  FingerprintingChange,
  PixelEventChange,
  ProvenanceChange,
  StorageKeyChange
} from "@/lib/types";

function ComparisonPanel({ view }: { view: ReportView }) {
  const arms = comparisonArmViews(view);
  // The two-arm evidence diff, derived through the same builder the v1
  // producer used to write the wire's diff block, so a v2 pair or a tampered
  // upload renders identically to a freshly produced comparison.
  const diff = useMemo(() => comparisonDiffView(view), [view]);
  if (!arms || !diff) return null;
  // Labels come from the view (wire runLabels or the per-axis defaults), the
  // same source the JSON-LD dataset names its per-arm variables with.
  const labels = view.comparison?.runLabels ?? { baseline: "Baseline", variant: "Variant" };
  // Every delta below is a pair-level claim, gated by the seam's default-deny
  // ClaimPolicy (RFC 4.4): nothing renders without pair validity, and each
  // tile and change list additionally requires its metric family's gate. The
  // per-family gates subsume the old Shields special case (a Shields-axis
  // pair measures filter matches on one arm and engine blocks on the other,
  // so its shields-simulation family is denied at the seam).
  const pairGate = view.claims.pairComparison;
  const pairAllowed = pairGate?.allowed === true;
  const families = view.claims.familyDeltas;
  const rawCountsAllowed = pairAllowed && families?.["raw-counts"]?.allowed === true;
  const classificationAllowed = pairAllowed && families?.["tracker-classification"]?.allowed === true;
  const detectorAllowed = pairAllowed && families?.["detector-findings"]?.allowed === true;
  const shieldsSimAllowed = pairAllowed && families?.["shields-simulation"]?.allowed === true;
  const addedCookies = diff.addedCookies ?? [];
  const removedCookies = diff.removedCookies ?? [];
  const addedStorageKeys = diff.addedStorageKeys ?? [];
  const removedStorageKeys = diff.removedStorageKeys ?? [];
  const addedFingerprinting = diff.addedFingerprinting ?? [];
  const removedFingerprinting = diff.removedFingerprinting ?? [];
  const addedPixelEvents = diff.addedPixelEvents ?? [];
  const removedPixelEvents = diff.removedPixelEvents ?? [];
  const addedProvenance = diff.addedProvenance ?? [];
  const removedProvenance = diff.removedProvenance ?? [];
  const metrics = [
    ...(rawCountsAllowed
      ? [
          { label: "Requests", metric: diff.totalRequests },
          { label: "Third-party requests", metric: diff.thirdPartyRequests },
          { label: "Third-party domains", metric: diff.thirdPartyDomains },
          { label: "Cookies", metric: diff.cookies },
          { label: "Third-party cookies", metric: diff.thirdPartyCookies },
          { label: "Storage keys", metric: diff.storageEntries }
        ]
      : []),
    ...(classificationAllowed ? [{ label: "Known-service requests", metric: diff.knownTrackerRequests }] : []),
    ...(detectorAllowed ? [{ label: "Fingerprint events", metric: diff.fingerprintEvents }] : []),
    ...(shieldsSimAllowed && diff.shieldsBlockedRequests
      ? [{ label: "Matched Shields lists", metric: diff.shieldsBlockedRequests }]
      : [])
  ].filter((item): item is { label: string; metric: ComparisonMetricDelta } => Boolean(item.metric));

  // Families the pair supports in principle but whose deltas are not
  // comparable across these two visits, with the seam's human-readable reason
  // so the absence is explained rather than silent.
  const suppressed: { label: string; reason: string }[] = [];
  if (pairAllowed && families) {
    if (!rawCountsAllowed) {
      suppressed.push({ label: "Request, cookie, and storage deltas", reason: families["raw-counts"].reasons[0] ?? "" });
    }
    if (!classificationAllowed) {
      suppressed.push({ label: "Known-service and entity deltas", reason: families["tracker-classification"].reasons[0] ?? "" });
    }
    if (!detectorAllowed) {
      suppressed.push({
        label: "Fingerprinting, ad-pixel, and causal-path deltas",
        reason: families["detector-findings"].reasons[0] ?? ""
      });
    }
    if (!shieldsSimAllowed && diff.shieldsBlockedRequests) {
      suppressed.push({ label: "The Shields-number delta", reason: families["shields-simulation"].reasons[0] ?? "" });
    }
  }

  return (
    <section className="comparison-card">
      <div className="comparison-heading">
        <div>
          <p className="eyebrow">{comparisonEyebrow(view)}</p>
          <h2>
            {labels.baseline} → {labels.variant} delta
          </h2>
        </div>
        <div className="comparison-runs">
          <span>
            {labels.baseline}: {arms.baseline.durationMs.toLocaleString()}ms
          </span>
          <span>
            {labels.variant}: {arms.variant.durationMs.toLocaleString()}ms
          </span>
        </div>
      </div>
      {!pairAllowed && pairGate && (
        <div className="comparison-ineligible" role="note">
          <strong>These two visits do not support a side-by-side comparison, so no deltas are shown.</strong>
          <ul>
            {pairGate.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="muted">
            Each visit&apos;s own evidence still stands: the lead visit&apos;s tables are below, and both visits are in the
            downloaded JSON.
          </p>
        </div>
      )}
      {suppressed.length > 0 && (
        <div className="comparison-ineligible" role="note">
          <strong>Some deltas are not comparable across these two visits and are not shown.</strong>
          <ul>
            {suppressed.map((item) => (
              <li key={item.label}>
                {item.label}: {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pairAllowed && (
        <>
          <div className="comparison-metrics">
            {metrics.map((item) => (
              <DeltaTile key={item.label} label={item.label} metric={item.metric} />
            ))}
          </div>
          <div className="comparison-lists">
            {rawCountsAllowed && (
              <>
                <ChangeList title={`Domains only with ${labels.variant}`} changes={diff.addedDomains} tone="added" />
                <ChangeList title={`Domains only with ${labels.baseline}`} changes={diff.removedDomains} tone="removed" />
                <CookieChangeList title={`Cookies only with ${labels.variant}`} changes={addedCookies} tone="added" />
                <CookieChangeList title={`Cookies only with ${labels.baseline}`} changes={removedCookies} tone="removed" />
                <StorageChangeList title={`Storage keys only with ${labels.variant}`} changes={addedStorageKeys} tone="added" />
                <StorageChangeList title={`Storage keys only with ${labels.baseline}`} changes={removedStorageKeys} tone="removed" />
              </>
            )}
            {classificationAllowed && (
              <>
                <EntityChangeList title={`Entities only with ${labels.variant}`} changes={diff.addedEntities} tone="added" />
                <EntityChangeList title={`Entities only with ${labels.baseline}`} changes={diff.removedEntities} tone="removed" />
              </>
            )}
            {detectorAllowed && (addedFingerprinting.length > 0 || removedFingerprinting.length > 0) && (
              <>
                <FingerprintingChangeList title={`Fingerprinting only with ${labels.variant}`} changes={addedFingerprinting} tone="added" />
                <FingerprintingChangeList title={`Fingerprinting only with ${labels.baseline}`} changes={removedFingerprinting} tone="removed" />
              </>
            )}
            {detectorAllowed && (addedPixelEvents.length > 0 || removedPixelEvents.length > 0) && (
              <>
                <PixelEventChangeList title={`Ad pixels only with ${labels.variant}`} changes={addedPixelEvents} tone="added" />
                <PixelEventChangeList title={`Ad pixels only with ${labels.baseline}`} changes={removedPixelEvents} tone="removed" />
              </>
            )}
            {/* Provenance is instrumentation-derived (PageGraph initiator
                attribution), so its cross-arm deltas need the same
                detector-findings gate as fingerprinting and pixels. */}
            {detectorAllowed && (addedProvenance.length > 0 || removedProvenance.length > 0) && (
              <>
                <ProvenanceChangeList title={`Causal paths only with ${labels.variant}`} changes={addedProvenance} tone="added" />
                <ProvenanceChangeList title={`Causal paths only with ${labels.baseline}`} changes={removedProvenance} tone="removed" />
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function comparisonEyebrow(view: ReportView): string {
  const axis = view.comparison?.axis ?? null;
  if (axis === "gpc") return "GPC Comparison";
  if (axis === "shields") return "Brave Shields Comparison";
  if (axis === "consent") return "Consent Comparison";
  // Keyed on the explicit design marker: a legacy "custom" comparison is also
  // axis-less and must not be labeled temporal.
  if (view.comparison?.temporalPair) return "Temporal Comparison";
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
    case "keystroke-exfiltration":
      return "Keystroke exfiltration";
    default:
      return kind;
  }
}

function PixelEventChangeList({ title, changes, tone }: { title: string; changes: PixelEventChange[]; tone: "added" | "removed" }) {
  return (
    <DiffList
      title={title}
      emptyText="No advertising-pixel changes observed."
      items={changes}
      renderItem={(change) => {
        const events = change.events.length > 0 ? change.events.join(", ") : "no named event";
        const identifiers =
          change.advancedMatching.length > 0 ? ` · identifiers: ${change.advancedMatching.map(pixelFieldLabel).join(", ")}` : "";
        return (
          <div className={`change-row change-${tone}`} key={change.platform}>
            <span>
              <strong>{change.product}</strong>
              <small>
                {events}
                {identifiers}
              </small>
            </span>
          </div>
        );
      }}
    />
  );
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
