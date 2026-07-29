"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { comparisonArmViews, comparisonDiffView, type ReportView } from "@/lib/scan-report-views";
import {
  comparisonSupportsExactClaimDelta,
  type ReportFacts
} from "@/lib/report-facts";
import { provenanceChangeText } from "@/lib/report-findings";
import { pixelFieldLabel } from "@/lib/report-insights";
import {
  buildEvidenceHash,
  domainRequestDeltas,
  type DomainRequestDelta,
  type EvidenceArm
} from "@/lib/report-evidence-navigation";
import { MAX_DIFF_LIST } from "@/lib/compare-reports";
import { comparisonDeltaHeading, displayHost, plural } from "@/lib/text-format";
import {
  isReviewedCookieName,
  isReviewedStorageKey,
  omitUnreviewedNames
} from "@/lib/public-name-policy";
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

function ComparisonPanel({ view, facts }: { view: ReportView; facts: ReportFacts }) {
  const arms = comparisonArmViews(view);
  // The two-arm evidence diff, derived through the same builder the v1
  // producer used to write the wire's diff block, so a v2 pair or a tampered
  // upload renders identically to a freshly produced comparison.
  const diff = useMemo(() => comparisonDiffView(view), [view]);
  const perDomainDeltas = useMemo(
    () => (arms ? domainRequestDeltas(arms.baseline.evidence.domains, arms.variant.evidence.domains) : []),
    [arms]
  );
  if (!arms || !diff) return null;
  // Labels come from the view (wire runLabels or the per-axis defaults), the
  // same source the JSON-LD dataset names its per-arm variables with.
  const labels = view.comparison?.runLabels ?? { baseline: "Baseline", variant: "Variant" };
  const pairGate = view.claims.pairComparison;
  const pairAllowed = pairGate?.allowed === true;
  const families = view.claims.familyDeltas;
  const rawCountsAllowed = pairAllowed && families?.["raw-counts"]?.allowed === true;
  const classificationAllowed = pairAllowed && families?.["tracker-classification"]?.allowed === true;
  const detectorAllowed = pairAllowed && families?.["detector-findings"]?.allowed === true;
  const fingerprintDeltaAllowed = comparisonSupportsExactClaimDelta(
    view,
    facts,
    "fingerprint-apis"
  );
  const pixelDeltaAllowed = comparisonSupportsExactClaimDelta(
    view,
    facts,
    "pixel-events"
  );
  const shieldsSimAllowed = pairAllowed && families?.["shields-simulation"]?.allowed === true;
  const shieldsMetricLabel = [arms.baseline, arms.variant].every(
    (arm) => arm.conditions.shieldsMode === "block-simulation"
  )
    ? "Requests blocked by Shields simulation"
    : "Requests matched by Shields lists";
  // Keep the persisted v1 diff contract untouched for historical-report
  // compatibility, but never present an unreviewed name as an exact identity.
  // Aggregate deltas above still include every observation.
  const addedCookieNames = omitUnreviewedNames(diff.addedCookies ?? [], (change) => change.name, "cookie");
  const removedCookieNames = omitUnreviewedNames(diff.removedCookies ?? [], (change) => change.name, "cookie");
  const addedStorageNames = omitUnreviewedNames(diff.addedStorageKeys ?? [], (change) => change.key, "storage");
  const removedStorageNames = omitUnreviewedNames(diff.removedStorageKeys ?? [], (change) => change.key, "storage");
  const addedCookies = addedCookieNames.entries;
  const removedCookies = removedCookieNames.entries;
  const addedStorageKeys = addedStorageNames.entries;
  const removedStorageKeys = removedStorageNames.entries;
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
    ...(fingerprintDeltaAllowed
      ? [{ label: "Fingerprint events", metric: diff.fingerprintEvents }]
      : []),
    ...(shieldsSimAllowed && diff.shieldsBlockedRequests
      ? [{ label: shieldsMetricLabel, metric: diff.shieldsBlockedRequests }]
      : [])
  ].filter((item): item is { label: string; metric: ComparisonMetricDelta } => Boolean(item.metric));
  const hasComparableDelta = metrics.length > 0;
  // Inspect the arms, not only the derived name-change arrays: two unrelated
  // raw names can collapse to the same marker and cancel in the canonical v1
  // diff even while aggregate counts changed.
  const cookieNamesPrivacyFiltered = [arms.baseline, arms.variant].some((arm) =>
    arm.evidence.cookies.some((cookie) => !isReviewedCookieName(cookie.name))
  );
  const storageNamesPrivacyFiltered = [arms.baseline, arms.variant].some((arm) =>
    arm.evidence.storage.some((entry) => !isReviewedStorageKey(entry.key))
  );
  const hasPrivacyFilteredNames = cookieNamesPrivacyFiltered || storageNamesPrivacyFiltered;

  // Families whose deltas are not comparable across these two visits, from
  // the single reason-bearing decision: the FULL reason list (never just the
  // first), with the mode distinction spelled out. "raw-only" means each
  // visit's own evidence still renders below with no comparative framing;
  // "suppressed" means the family was never measured, so there is nothing to
  // set side by side at all.
  const decision = view.claims.decision;
  const familyNotes: { label: string; mode: "raw-only" | "suppressed"; reasons: string[] }[] = [];
  if (pairAllowed && decision) {
    const note = (family: keyof typeof decision.families, label: string) => {
      const ruling = decision.families[family];
      if (ruling.mode === "comparable") return;
      familyNotes.push({ label, mode: ruling.mode === "suppressed" ? "suppressed" : "raw-only", reasons: ruling.reasons });
    };
    note("raw-counts", "Request, cookie, and storage deltas");
    note("tracker-classification", "Known-service and entity deltas");
    note("detector-findings", "Other detector and causal-path deltas");
    // A shields ruling matters here when there is a number to withhold OR the
    // family was never measured at all (the suppressed case names why).
    if (!shieldsSimAllowed && (diff.shieldsBlockedRequests || decision.families["shields-simulation"].mode === "suppressed")) {
      note("shields-simulation", "The Shields-number delta");
    }
    if (!fingerprintDeltaAllowed) {
      familyNotes.push({
        label: "Fingerprinting deltas",
        mode: "raw-only",
        reasons: ["At least one visit did not complete the fingerprint measurement, so no exact cross-visit delta is shown."]
      });
    }
    if (!pixelDeltaAllowed) {
      familyNotes.push({
        label: "Ad-pixel deltas",
        mode: "raw-only",
        reasons: ["At least one visit did not complete the pixel measurement, so no exact cross-visit delta is shown."]
      });
    }
  }

  return (
    <section className="comparison-card">
      <div className="comparison-heading">
        <div>
          <p className="eyebrow">{comparisonEyebrow(view)}</p>
          {/* Pair validity is necessary but not sufficient: every metric
              family can still default-deny, leaving no delta to headline. */}
          <h2>{comparisonDeltaHeading(labels, pairAllowed && hasComparableDelta)}</h2>
        </div>
        <div className="comparison-runs">
          <span>
            {labels.baseline}: {arms.baseline.durationMs.toLocaleString("en-US")}ms
          </span>
          <span>
            {labels.variant}: {arms.variant.durationMs.toLocaleString("en-US")}ms
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
            Each visit&apos;s own evidence still stands: use the &ldquo;Evidence shown&rdquo; switcher below to inspect either
            visit&apos;s tables, and both visits are in the downloaded JSON.
          </p>
        </div>
      )}
      {familyNotes.length > 0 && (
        <div className="comparison-ineligible" role="note">
          <strong>
            {hasComparableDelta
              ? "Some deltas are not comparable across these two visits and are not shown."
              : "No metric deltas are comparable across these two visits, so none are shown."}
          </strong>
          <ul>
            {familyNotes.map((item) => (
              <li key={item.label}>
                {item.label}
                {item.mode === "suppressed" ? " (never measured on this pair)" : " (each visit's own evidence still renders below)"}
                {item.reasons.length > 0 ? `: ${item.reasons.join(" ")}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {pairAllowed && (
        <>
          <div className="comparison-metrics">
            {metrics.map((item) => (
              <DeltaTile key={item.label} label={item.label} metric={item.metric} labels={labels} />
            ))}
          </div>
          {hasComparableDelta && (
            <p className="muted comparison-privacy-note">
              Every signed change is {labels.variant} minus {labels.baseline}. A positive or negative direction is descriptive,
              not a judgment that the result is better or worse.
            </p>
          )}
          {rawCountsAllowed && hasPrivacyFilteredNames && (
            <p className="muted comparison-privacy-note">
              Cookie and storage count deltas include every observation. Name-level lists show only reviewed names; unreviewed names are not itemized because they can contain identifiers.
            </p>
          )}
          <div className="comparison-lists">
            {rawCountsAllowed && (
              <>
                <DomainRequestDeltaList changes={perDomainDeltas} labels={labels} />
                <ChangeList
                  title={`Domains only with ${labels.variant}`}
                  changes={diff.addedDomains}
                  arm="variant"
                  armLabel={labels.variant}
                />
                <ChangeList
                  title={`Domains only with ${labels.baseline}`}
                  changes={diff.removedDomains}
                  arm="baseline"
                  armLabel={labels.baseline}
                />
                <CookieChangeList
                  title={`${cookieNamesPrivacyFiltered ? "Visible cookie names" : "Cookies"} only with ${labels.variant}`}
                  changes={addedCookies}
                  privacyFiltered={cookieNamesPrivacyFiltered}
                  producerCapped={(diff.addedCookies ?? []).length >= MAX_DIFF_LIST}
                />
                <CookieChangeList
                  title={`${cookieNamesPrivacyFiltered ? "Visible cookie names" : "Cookies"} only with ${labels.baseline}`}
                  changes={removedCookies}
                  privacyFiltered={cookieNamesPrivacyFiltered}
                  producerCapped={(diff.removedCookies ?? []).length >= MAX_DIFF_LIST}
                />
                <StorageChangeList
                  title={`${storageNamesPrivacyFiltered ? "Visible storage keys" : "Storage keys"} only with ${labels.variant}`}
                  changes={addedStorageKeys}
                  privacyFiltered={storageNamesPrivacyFiltered}
                  producerCapped={(diff.addedStorageKeys ?? []).length >= MAX_DIFF_LIST}
                />
                <StorageChangeList
                  title={`${storageNamesPrivacyFiltered ? "Visible storage keys" : "Storage keys"} only with ${labels.baseline}`}
                  changes={removedStorageKeys}
                  privacyFiltered={storageNamesPrivacyFiltered}
                  producerCapped={(diff.removedStorageKeys ?? []).length >= MAX_DIFF_LIST}
                />
              </>
            )}
            {classificationAllowed && (
              <>
                <EntityChangeList title={`Entities only with ${labels.variant}`} changes={diff.addedEntities} />
                <EntityChangeList title={`Entities only with ${labels.baseline}`} changes={diff.removedEntities} />
              </>
            )}
            {fingerprintDeltaAllowed && (addedFingerprinting.length > 0 || removedFingerprinting.length > 0) && (
              <>
                <FingerprintingChangeList title={`Fingerprinting only with ${labels.variant}`} changes={addedFingerprinting} />
                <FingerprintingChangeList title={`Fingerprinting only with ${labels.baseline}`} changes={removedFingerprinting} />
              </>
            )}
            {pixelDeltaAllowed && (addedPixelEvents.length > 0 || removedPixelEvents.length > 0) && (
              <>
                <PixelEventChangeList title={`Ad pixels only with ${labels.variant}`} changes={addedPixelEvents} />
                <PixelEventChangeList title={`Ad pixels only with ${labels.baseline}`} changes={removedPixelEvents} />
              </>
            )}
            {/* Provenance is instrumentation-derived (PageGraph initiator
                attribution), so its cross-arm deltas need the same
                detector-findings gate as fingerprinting and pixels. */}
            {detectorAllowed && (addedProvenance.length > 0 || removedProvenance.length > 0) && (
              <>
                <ProvenanceChangeList title={`Causal paths only with ${labels.variant}`} changes={addedProvenance} />
                <ProvenanceChangeList title={`Causal paths only with ${labels.baseline}`} changes={removedProvenance} />
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

function DeltaTile({
  label,
  metric,
  labels
}: {
  label: string;
  metric: ComparisonMetricDelta;
  labels: { baseline: string; variant: string };
}) {
  const formattedDelta = signedCount(metric.delta);
  return (
    <div className="delta-tile delta-flat">
      <span>{label}</span>
      <strong aria-label={`${labels.variant} minus ${labels.baseline}: ${formattedDelta}`}>{formattedDelta}</strong>
      <small>
        {labels.baseline}: {metric.before.toLocaleString("en-US")} · {labels.variant}: {metric.after.toLocaleString("en-US")}
      </small>
    </div>
  );
}

function signedCount(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

const DIFF_COLLAPSED_COUNT = 6;

function DiffList<T>({
  title,
  emptyText,
  items,
  renderItem,
  className,
  producerCapped
}: {
  title: string;
  emptyText: string;
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  className?: string;
  /**
   * Whether the PRODUCER truncated this list at its hard cap, judged from the
   * wire array rather than from what is rendered. Inferring it from
   * `items.length` was wrong in both directions: a locally derived list that is
   * never sliced claimed a truncation that did not happen, and a wire list that
   * was clipped and then privacy-filtered below the cap lost the disclosure
   * when it was real.
   */
  producerCapped: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, DIFF_COLLAPSED_COUNT);
  // A capped diff list carries no record of how many entries it dropped, so
  // saying "show all N" over one would assert a completeness the report cannot
  // support.
  const capped = producerCapped;

  return (
    <div className={`change-list${className ? ` ${className}` : ""}`}>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <>
          {visible.map(renderItem)}
          {items.length > DIFF_COLLAPSED_COUNT && (
            <button
              type="button"
              className="change-list-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Show fewer" : capped ? `Show the ${items.length} retained` : `Show all ${items.length}`}
            </button>
          )}
          {capped && (
            <p className="muted change-list-cap-note">
              This list was capped at {MAX_DIFF_LIST.toLocaleString("en-US")} entries when the report was written. Any
              further changes were not retained and are not recoverable from this report.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function DomainRequestDeltaList({
  changes,
  labels
}: {
  changes: DomainRequestDelta[];
  labels: { baseline: string; variant: string };
}) {
  return (
    <DiffList
      title="Largest per-domain request-count changes"
      emptyText="No per-domain request counts changed between these visits."
      items={changes}
      // Derived here from both arms' domain evidence, not read from the wire
      // diff, so it is never truncated and must not claim it was.
      producerCapped={false}
      className="domain-request-deltas"
      renderItem={(change) => {
        const formattedDelta = signedCount(change.delta);
        return (
          <div className="change-row" key={change.domain}>
            <span>
              <strong>{displayHost(change.domain)}</strong>
              <small>
                {change.tracker
                  ? `${change.tracker.entity} · ${change.tracker.category}`
                  : change.thirdParty
                    ? "unlabeled third party"
                    : "first party"}
              </small>
              <small>
                {labels.baseline}: {change.baselineRequests.toLocaleString("en-US")} · {labels.variant}:{" "}
                {change.variantRequests.toLocaleString("en-US")}
              </small>
              <small>
                <EvidenceLink domain={change.domain} arm="baseline" armLabel={labels.baseline} /> ·{" "}
                <EvidenceLink domain={change.domain} arm="variant" armLabel={labels.variant} />
              </small>
            </span>
            <b aria-label={`${labels.variant} minus ${labels.baseline}: ${formattedDelta} requests`}>{formattedDelta}</b>
          </div>
        );
      }}
    />
  );
}

function ChangeList({
  title,
  changes,
  arm,
  armLabel
}: {
  title: string;
  changes: DomainChange[];
  arm: EvidenceArm;
  armLabel: string;
}) {
  return (
    <DiffList
      title={title}
      emptyText="No domain changes observed."
      items={changes}
      producerCapped={changes.length >= MAX_DIFF_LIST}
      renderItem={(change) => (
        <div className="change-row" key={change.domain}>
          <span>
            <strong>{displayHost(change.domain)}</strong>
            <small>
              {change.tracker ? `${change.tracker.entity} · ${change.tracker.category}` : "unlabeled"} ·{" "}
              <EvidenceLink domain={change.domain} arm={arm} armLabel={armLabel} />
            </small>
          </span>
          <b aria-label={`${change.requests.toLocaleString("en-US")} requests with ${armLabel}`}>
            {change.requests.toLocaleString("en-US")}
          </b>
        </div>
      )}
    />
  );
}

function EvidenceLink({ domain, arm, armLabel }: { domain: string; arm: EvidenceArm; armLabel: string }) {
  return (
    <a href={buildEvidenceHash({ section: "requests", arm, query: domain })}>
      Show {armLabel} requests
    </a>
  );
}

function EntityChangeList({ title, changes }: { title: string; changes: EntityChange[] }) {
  return (
    <DiffList
      title={title}
      emptyText="No entity changes observed."
      items={changes}
      producerCapped={changes.length >= MAX_DIFF_LIST}
      renderItem={(change) => (
        <div className="change-row" key={change.entity}>
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

function CookieChangeList({
  title,
  changes,
  privacyFiltered = false,
  producerCapped
}: {
  title: string;
  changes: CookieChange[];
  privacyFiltered?: boolean;
  producerCapped: boolean;
}) {
  return (
    <DiffList
      title={title}
      emptyText={
        privacyFiltered
          ? "No visible cookie-name changes to show; privacy-filtered names are not itemized."
          : "No cookie changes observed."
      }
      items={changes}
      producerCapped={producerCapped}
      renderItem={(change, index) => (
        <div className="change-row" key={`${change.name}:${change.domain}:${index}`}>
          <span>
            <strong>{change.name}</strong>
            <small>{displayHost(change.domain)}</small>
          </span>
          <b className="change-tag">{change.thirdParty ? "third-party" : "first-party"}</b>
        </div>
      )}
    />
  );
}

function StorageChangeList({
  title,
  changes,
  privacyFiltered = false,
  producerCapped
}: {
  title: string;
  changes: StorageKeyChange[];
  privacyFiltered?: boolean;
  producerCapped: boolean;
}) {
  return (
    <DiffList
      title={title}
      emptyText={
        privacyFiltered
          ? "No visible storage-key changes to show; privacy-filtered keys are not itemized."
          : "No storage key changes observed."
      }
      items={changes}
      producerCapped={producerCapped}
      renderItem={(change, index) => (
        <div className="change-row" key={`${change.area}:${change.key}:${index}`}>
          <span>
            <strong>{change.key}</strong>
            <small>{change.area === "sessionStorage" ? "session storage" : "local storage"}</small>
          </span>
        </div>
      )}
    />
  );
}

function FingerprintingChangeList({ title, changes }: { title: string; changes: FingerprintingChange[] }) {
  return (
    <DiffList
      title={title}
      emptyText="No fingerprinting changes observed."
      items={changes}
      producerCapped={changes.length >= MAX_DIFF_LIST}
      renderItem={(change) => (
        <div className="change-row" key={change.kind}>
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

function PixelEventChangeList({ title, changes }: { title: string; changes: PixelEventChange[] }) {
  return (
    <DiffList
      title={title}
      emptyText="No advertising-pixel changes observed."
      items={changes}
      producerCapped={changes.length >= MAX_DIFF_LIST}
      renderItem={(change) => {
        const events = change.events.length > 0 ? change.events.join(", ") : "no named event";
        const identifiers =
          change.advancedMatching.length > 0 ? ` · identifiers: ${change.advancedMatching.map(pixelFieldLabel).join(", ")}` : "";
        return (
          <div className="change-row" key={change.platform}>
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

function ProvenanceChangeList({ title, changes }: { title: string; changes: ProvenanceChange[] }) {
  return (
    <DiffList
      title={title}
      emptyText="No causal path changes observed."
      className="provenance-change-list"
      items={changes}
      producerCapped={changes.length >= MAX_DIFF_LIST}
      renderItem={(change, index) => (
        <div
          className="change-row"
          key={`${index}:${change.domain}:${change.initiator ?? ""}:${change.script ?? ""}:${change.injectedBy ?? ""}`}
        >
          <span>
            <strong>{displayHost(change.domain)}</strong>
            <small>{provenanceChangeText(change)}</small>
          </span>
          <b>{change.requests}</b>
        </div>
      )}
    />
  );
}

export { ComparisonPanel };
