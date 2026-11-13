"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePrintComplete } from "./print-mode";
import { staticAssetPath } from "../client-runtime";
import { comparisonVisitOrderLine } from "@/lib/comparison-visit-order";
import { comparisonArmViews, comparisonDiffView, type ReportView } from "@/lib/scan-report-views";
import {
  comparisonExactClaimDeltaBlockers,
  comparisonSupportsStorageDelta,
  hostCatalogMatchScope,
  type IdentifiedHostFact,
  type ReportFacts
} from "@/lib/report-facts";
import { provenanceChangeText } from "@/lib/report-findings";
import { pixelEventLabel, pixelFieldLabel } from "@/lib/report-insights";
import { publishedReportCorrections } from "@/lib/published-report-corrections";
import {
  buildEvidenceHash,
  domainRequestDeltas,
  type DomainRequestDelta,
  type EvidenceArm
} from "@/lib/report-evidence-navigation";
import { comparisonListsCut, MAX_DIFF_LIST } from "@/lib/compare-reports";
import { comparisonDeltaHeading, displayHost, plural } from "@/lib/text-format";
import { readableVisitStart, unshownVisitStart } from "@/lib/visit-timestamp";
import {
  isReviewedCookieName,
  isReviewedStorageKey,
  omitUnreviewedNames
} from "@/lib/public-name-policy";
import type {
  ComparisonDiff,
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
  // Which of those lists were cut at the cap. A list's length cannot say: one
  // that holds exactly the cap is whole, and telling its reader that further
  // changes exist would send them looking for rows that are not there. The
  // builder counts one entry past the cap and names the lists that have one.
  const cutLists = useMemo(() => {
    const pair = comparisonArmViews(view);
    return pair ? comparisonListsCut(pair.baseline, pair.variant, "rows") : null;
  }, [view]);
  const cut = (list: keyof ComparisonDiff) => cutLists?.has(list) === true;
  const domainDeltas = useMemo(
    () => (arms ? domainRequestDeltas(arms.baseline.evidence.domains, arms.variant.evidence.domains) : []),
    [arms]
  );
  if (!arms || !diff) return null;
  // Labels come from the view (wire runLabels or the per-axis defaults), the
  // same source the JSON-LD dataset names its per-arm variables with.
  const labels = view.comparison?.runLabels ?? { baseline: "Baseline", variant: "Variant" };
  // Which visit ran first, or that the order was not recorded. Disclosure, not
  // a claim, so it renders whether or not the pair supports any delta; a
  // temporal pair has no line, because Before and After already are the order.
  const visitOrder = view.comparison ? comparisonVisitOrderLine(view.comparison.visitOrder, labels) : null;
  // A row prints one catalog label beside a host's whole request count. Where
  // the label covers only part of those requests, the row says which part.
  const hostsOf = (arm: EvidenceArm) => facts.arms?.[arm].identity.hosts ?? [];
  const perDomainDeltas = domainDeltas.map((change) => ({
    ...change,
    matchScope: hostCatalogMatchScope(
      (["baseline", "variant"] as const).map((arm) => ({
        label: labels[arm],
        host: hostsOf(arm).find((host) => host.host === change.domain)
      }))
    )
  }));
  const pairGate = view.claims.pairComparison;
  const pairAllowed = pairGate?.allowed === true;
  const families = view.claims.familyDeltas;
  const rawCountsAllowed = pairAllowed && families?.["raw-counts"]?.allowed === true;
  // Storage rides on raw-counts but also needs both storage reads complete: a
  // v1 storage-snapshot loss leaves raw-counts open for the request deltas.
  const storageDeltaAllowed = comparisonSupportsStorageDelta(view, facts);
  const classificationAllowed = pairAllowed && families?.["tracker-classification"]?.allowed === true;
  const detectorAllowed = pairAllowed && families?.["detector-findings"]?.allowed === true;
  // The reasons a delta is withheld and the gate that withholds it are one
  // list, so the note below can only state the cause that closed the gate.
  const fingerprintBlockers = comparisonExactClaimDeltaBlockers(view, facts, "fingerprint-apis", labels);
  const pixelBlockers = comparisonExactClaimDeltaBlockers(view, facts, "pixel-events", labels);
  const fingerprintDeltaAllowed = fingerprintBlockers.length === 0;
  const pixelDeltaAllowed = pixelBlockers.length === 0;
  // The single-visit pixel list marks a label a published correction withdrew;
  // the change lists name the same events and must mark it too.
  const corrected = publishedReportCorrections(view.reportId).suppressIndexing;
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
          { label: "Third-party cookies", metric: diff.thirdPartyCookies }
        ]
      : []),
    ...(storageDeltaAllowed ? [{ label: "Storage keys", metric: diff.storageEntries }] : []),
    ...(classificationAllowed ? [{ label: "Catalog-matched requests", metric: diff.knownTrackerRequests }] : []),
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
  // The note explains the name lists that render, so withheld storage lists
  // neither trigger it nor appear in it.
  const hasPrivacyFilteredNames = cookieNamesPrivacyFiltered || (storageDeltaAllowed && storageNamesPrivacyFiltered);

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
    note("tracker-classification", "Catalog-matched request and entity deltas");
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
        reasons: fingerprintBlockers
      });
    }
    if (!pixelDeltaAllowed) {
      familyNotes.push({
        label: "Ad-pixel deltas",
        mode: "raw-only",
        reasons: pixelBlockers
      });
    }
    // Only when raw-counts is open: otherwise its own note already names storage.
    if (rawCountsAllowed && !storageDeltaAllowed) {
      familyNotes.push({
        label: "Storage-key deltas",
        mode: "raw-only",
        reasons: ["At least one visit did not read the page's storage in full, so no exact cross-visit delta is shown."]
      });
    }
  }

  return (
    <section className="comparison-card" id="comparison">
      <div className="comparison-heading">
        <div>
          <p className="eyebrow">{comparisonEyebrow(view)}</p>
          {/* Pair validity is necessary but not sufficient: every metric
              family can still default-deny, leaving no delta to headline. */}
          <h2>{comparisonDeltaHeading(labels, pairAllowed && hasComparableDelta)}</h2>
        </div>
        <div className="comparison-runs">
          {/* When each visit started, beside how long it took. "Before" and
              "After" name an order and no dates, and a pair built from the
              archive or from two files can be weeks apart. */}
          <span>
            {labels.baseline}: {visitStart(arms.baseline.startedAt)} · {arms.baseline.durationMs.toLocaleString("en-US")}ms
          </span>
          <span>
            {labels.variant}: {visitStart(arms.variant.startedAt)} · {arms.variant.durationMs.toLocaleString("en-US")}ms
          </span>
          {visitOrder && (
            <span>
              {visitOrder.text}
              {/* The link names its page, so the line still says where the
                  reason is on paper and in the PDF, where it cannot be followed. */}
              {visitOrder.seeMethodology && (
                <>
                  {" "}(see <a href={staticAssetPath("/methodology/#comparisons")}>Methodology</a>)
                </>
              )}
            </span>
          )}
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
              {storageDeltaAllowed ? "Cookie and storage count deltas" : "Cookie count deltas"} include every observation. Name-level lists show only reviewed names; unreviewed names are not itemized because they can contain identifiers.
            </p>
          )}
          <div className="comparison-lists">
            {rawCountsAllowed && (
              <>
                <DomainRequestDeltaList changes={perDomainDeltas} labels={labels} />
                <ChangeList
                  title={`Domains only with ${labels.variant}`}
                  changes={diff.addedDomains}
                  cut={cut("addedDomains")}
                  arm="variant"
                  armLabel={labels.variant}
                  hosts={hostsOf("variant")}
                />
                <ChangeList
                  title={`Domains only with ${labels.baseline}`}
                  changes={diff.removedDomains}
                  cut={cut("removedDomains")}
                  arm="baseline"
                  armLabel={labels.baseline}
                  hosts={hostsOf("baseline")}
                />
                <CookieChangeList
                  title={`${cookieNamesPrivacyFiltered ? "Visible cookie names" : "Cookies"} only with ${labels.variant}`}
                  changes={addedCookies}
                  privacyFiltered={cookieNamesPrivacyFiltered}
                  producerCapped={cut("addedCookies")}
                />
                <CookieChangeList
                  title={`${cookieNamesPrivacyFiltered ? "Visible cookie names" : "Cookies"} only with ${labels.baseline}`}
                  changes={removedCookies}
                  privacyFiltered={cookieNamesPrivacyFiltered}
                  producerCapped={cut("removedCookies")}
                />
              </>
            )}
            {storageDeltaAllowed && (
              <>
                <StorageChangeList
                  title={`${storageNamesPrivacyFiltered ? "Visible storage keys" : "Storage keys"} only with ${labels.variant}`}
                  changes={addedStorageKeys}
                  privacyFiltered={storageNamesPrivacyFiltered}
                  producerCapped={cut("addedStorageKeys")}
                />
                <StorageChangeList
                  title={`${storageNamesPrivacyFiltered ? "Visible storage keys" : "Storage keys"} only with ${labels.baseline}`}
                  changes={removedStorageKeys}
                  privacyFiltered={storageNamesPrivacyFiltered}
                  producerCapped={cut("removedStorageKeys")}
                />
              </>
            )}
            {classificationAllowed && (
              <>
                <EntityChangeList title={`Entities only with ${labels.variant}`} changes={diff.addedEntities} cut={cut("addedEntities")} />
                <EntityChangeList title={`Entities only with ${labels.baseline}`} changes={diff.removedEntities} cut={cut("removedEntities")} />
              </>
            )}
            {fingerprintDeltaAllowed && (addedFingerprinting.length > 0 || removedFingerprinting.length > 0) && (
              <>
                <FingerprintingChangeList title={`Fingerprinting only with ${labels.variant}`} changes={addedFingerprinting} cut={cut("addedFingerprinting")} />
                <FingerprintingChangeList title={`Fingerprinting only with ${labels.baseline}`} changes={removedFingerprinting} cut={cut("removedFingerprinting")} />
              </>
            )}
            {pixelDeltaAllowed && (addedPixelEvents.length > 0 || removedPixelEvents.length > 0) && (
              <>
                <PixelEventChangeList title={`Ad pixels only with ${labels.variant}`} changes={addedPixelEvents} cut={cut("addedPixelEvents")} corrected={corrected} />
                <PixelEventChangeList title={`Ad pixels only with ${labels.baseline}`} changes={removedPixelEvents} cut={cut("removedPixelEvents")} corrected={corrected} />
              </>
            )}
            {/* Provenance is instrumentation-derived (PageGraph initiator
                attribution), so its cross-arm deltas need the same
                detector-findings gate as fingerprinting and pixels. */}
            {detectorAllowed && (addedProvenance.length > 0 || removedProvenance.length > 0) && (
              <>
                <ProvenanceChangeList title={`Causal paths only with ${labels.variant}`} changes={addedProvenance} cut={cut("addedProvenance")} />
                <ProvenanceChangeList title={`Causal paths only with ${labels.baseline}`} changes={removedProvenance} cut={cut("removedProvenance")} />
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function visitStart(startedAt: string | null): string {
  const at = readableVisitStart(startedAt);
  return at ? `started ${at}` : `start time ${unshownVisitStart(startedAt)}`;
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
   * Whether the diff builder cut this list at its cap, as the builder itself
   * reports it (comparisonListsCut). Never inferred from a length: a list that
   * holds exactly the cap was not cut, a locally derived list is never cut at
   * all, and a list cut and then privacy-filtered below the cap still was.
   */
  producerCapped: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Paper cannot expand a list, so print renders every retained entry.
  const printComplete = usePrintComplete();
  const visible = expanded || printComplete ? items : items.slice(0, DIFF_COLLAPSED_COUNT);
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
          {/* The list is derived here, at read time, from both visits' rows
              and cut at the cap, so nothing was lost: the rows it did not
              reach are still in the report. */}
          {capped && (
            <p className="muted change-list-cap-note">
              This list stops at the first {MAX_DIFF_LIST.toLocaleString("en-US")} changes. Further changes are not
              listed here; they can be worked out from both visits&apos; rows in the report JSON.
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
  changes: (DomainRequestDelta & { matchScope: string | null })[];
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
                  ? `${change.tracker.entity} · ${change.tracker.category}${change.matchScope ? ` · ${change.matchScope}` : ""}`
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
  cut,
  arm,
  armLabel,
  hosts
}: {
  title: string;
  changes: DomainChange[];
  cut: boolean;
  arm: EvidenceArm;
  armLabel: string;
  hosts: readonly IdentifiedHostFact[];
}) {
  return (
    <DiffList
      title={title}
      emptyText="No domain changes observed."
      items={changes}
      producerCapped={cut}
      renderItem={(change) => {
        const matchScope = hostCatalogMatchScope([
          { label: armLabel, host: hosts.find((host) => host.host === change.domain) }
        ]);
        return (
        <div className="change-row" key={change.domain}>
          <span>
            <strong>{displayHost(change.domain)}</strong>
            <small>
              {change.tracker
                ? `${change.tracker.entity} · ${change.tracker.category}${matchScope ? ` · ${matchScope}` : ""}`
                : "unlabeled"} ·{" "}
              <EvidenceLink domain={change.domain} arm={arm} armLabel={armLabel} />
            </small>
          </span>
          <b aria-label={`${change.requests.toLocaleString("en-US")} requests with ${armLabel}`}>
            {change.requests.toLocaleString("en-US")}
          </b>
        </div>
        );
      }}
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

function EntityChangeList({ title, changes, cut }: { title: string; changes: EntityChange[]; cut: boolean }) {
  return (
    <DiffList
      title={title}
      emptyText="No entity changes observed."
      items={changes}
      producerCapped={cut}
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

function FingerprintingChangeList({ title, changes, cut }: { title: string; changes: FingerprintingChange[]; cut: boolean }) {
  return (
    <DiffList
      title={title}
      emptyText="No fingerprinting changes observed."
      items={changes}
      producerCapped={cut}
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

function PixelEventChangeList({ title, changes, cut, corrected }: { title: string; changes: PixelEventChange[]; cut: boolean; corrected: boolean }) {
  return (
    <DiffList
      title={title}
      emptyText="No advertising-pixel changes observed."
      items={changes}
      producerCapped={cut}
      renderItem={(change) => {
        const events =
          change.events.length > 0
            ? change.events.map((event) => pixelEventLabel(change.platform, event, corrected)).join(", ")
            : "no named event";
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

function ProvenanceChangeList({ title, changes, cut }: { title: string; changes: ProvenanceChange[]; cut: boolean }) {
  return (
    <DiffList
      title={title}
      emptyText="No causal path changes observed."
      className="provenance-change-list"
      items={changes}
      producerCapped={cut}
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
