"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LatestClientOperation, fetchJsonWithPolicy } from "@/lib/client-fetch-policy";
import { corpusFreshnessCounts, readStatusSnapshot, type StatusSnapshot } from "@/lib/status-snapshot";
import { PUBLIC_STATUS_MAX_CORPUS_AGE_MS, PUBLIC_STATUS_MAX_FILTER_LIST_AGE_MS, PUBLIC_STATUS_UI_REFRESH_MS } from "@/lib/public-status";
import { staticAssetPath } from "../client-runtime";
import { StatusFreshness } from "./status-freshness";

export function StatusEvidence({ initial }: { initial: StatusSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [verified, setVerified] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const operation = useRef(new LatestClientOperation()).current;
  useEffect(() => {
    const check = () => {
      setNow(Date.now());
      void operation.run(async (signal) => readStatusSnapshot(await fetchJsonWithPolicy(
        staticAssetPath("/status/snapshot.json"), { cache: "no-store" },
        { signal, label: "Published status evidence", maxBytes: 64 * 1024 }
      )), {
        onSuccess: (next) => { setSnapshot(next); setVerified(true); setCheckedAt(new Date().toISOString()); },
        onError: () => setVerified(false)
      });
    };
    check();
    const visibleCheck = () => { if (document.visibilityState === "visible") check(); };
    const timer = window.setInterval(visibleCheck, PUBLIC_STATUS_UI_REFRESH_MS);
    document.addEventListener("visibilitychange", visibleCheck);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibleCheck); operation.cancel(); };
  }, [operation]);
  const { latestAggregateEvidence, latestEligibleEvidence, newerEligibleOutsideAggregate, mostPagesRankElsewhere, categoryCohortCount, scanRankingSentence } = snapshot;
  const coverage = now === null ? { current: 0, stale: 0, unknown: snapshot.siteCount } : corpusFreshnessCounts(snapshot.aggregateSiteDates, now);
  return <>
    <p className="status-note" aria-live="polite">{verified
      ? "Published evidence is checked every minute and when this tab becomes visible."
      : "The latest published evidence has not been verified from this browser. The last available snapshot is shown below."}</p>
    <p className="status-note">Snapshot source: {snapshot.sourceRevision ? <code title={snapshot.sourceRevision}>{snapshot.sourceRevision.slice(0, 12)}</code> : "Unknown"}. Last successful retrieval: {formatUtc(checkedAt)}. Retrieval time does not change the observation dates below.</p>
      <section className="legal-section" aria-labelledby="freshness-heading">
        <p className="eyebrow">Publication freshness</p>
        <h2 id="freshness-heading">Evidence and measurement inputs</h2>
        <div className="status-card-grid">
          <article className="status-card">
            <div className="status-heading-row">
              <h3>Latest aggregate-cohort evidence</h3>
              <StatusFreshness timestamp={latestAggregateEvidence} maxAgeMs={PUBLIC_STATUS_MAX_CORPUS_AGE_MS} verified={verified} />
            </div>
            <p className="status-value">{formatUtc(latestAggregateEvidence)}</p>
            <p>
              {snapshot.siteCount.toLocaleString()}{" "}distinct sites make up the measurement cohort this
              page&apos;s aggregates describe, and the date above is the newest eligible evidence inside that same
              cohort. Across all committed cohorts, {snapshot.coverageSiteCount.toLocaleString()} sites have at least one
              successful load.
            </p>
            <p>Across these measured sites: {coverage.current} current, {coverage.stale} stale, {coverage.unknown} unknown. Each site is dated by its newest eligible visit in this cohort.</p>
            <p className="status-note">{newerEligibleOutsideAggregate ? `Eligible evidence as new as ${formatUtc(latestEligibleEvidence)} sits in cohorts this aggregate excludes; the date above deliberately covers the aggregate cohort only.` : latestAggregateEvidence !== null ? "Today the aggregate cohort also holds the newest eligible evidence in the committed corpus." : "Today no committed report is eligible for these aggregates."} This is not the cohort every report page uses. Each report ranks against its own exact cohort{mostPagesRankElsewhere ? ", and most committed pages carry a different one than this" : ""}: a page compares only against scans that share its schema revision, methodology, tracker catalog, role taxonomy, metric contract, producer and requested-GPC state. Where no cohort reaches fifty sites, that page falls back to fixed thresholds instead. {scanRankingSentence} Each percentile card names its own denominator, and the <a href="/methodology/#corpus">methodology</a> states the rule. {categoryCohortCount > 1 ? `Category medians are published one cohort per category and span ${categoryCohortCount} cohorts in total, so no single cohort backs every published aggregate.` : snapshot.categoriesUseAggregateCohort ? "Category medians are published one cohort per category, and today that is this same cohort." : "Category medians do not currently use this aggregate cohort."} Current means no more than eight days old. It does not mean every site was refreshed in that window. A site that loaded but whose evidence was cut short, by a request cap or a censored family, is counted as covered and never as measured, and coverage also includes visits in other cohorts. {snapshot.v1ReportCount.toLocaleString()} committed reports use frozen schema v1 and {snapshot.v2ReportCount.toLocaleString()} use schema v2; the <a href="/methodology/#corpus">methodology</a> states what v1 evidence can and cannot support.</p>
          </article>

          <article className="status-card">
            <div className="status-heading-row">
              <h3>Brave default-list snapshot</h3>
              <StatusFreshness timestamp={snapshot.filterFetchedAt} maxAgeMs={PUBLIC_STATUS_MAX_FILTER_LIST_AGE_MS} verified={verified} />
            </div>
            <p className="status-value">{formatUtc(snapshot.filterFetchedAt)}</p>
            <p>
              {snapshot.filterSourceCount.toLocaleString()} source files · manifest{" "}
              <code title={snapshot.filterManifestDigest}>{snapshot.filterManifestDigest.slice(0, 12)}</code>
            </p>
            <p className="status-note">Current means no more than eight days old. A failed refresh never replaces the last validated snapshot.</p>
          </article>
        </div>
      </section>

      <section className="legal-section" aria-labelledby="toolchain-heading">
        <p className="eyebrow">Recorded toolchain</p>
        <h2 id="toolchain-heading">Versions that shape the measurement</h2>
        <dl className="status-fact-grid">
          <div><dt>Playwright</dt><dd><code>{snapshot.playwrightVersion}</code></dd></div>
          <div><dt>Ad-block engine</dt><dd><code>{snapshot.adblockEngineVersion}</code></dd></div>
          <div><dt>Service catalog</dt><dd><code>{snapshot.catalogVersion}</code></dd></div>
          <div><dt>Catalog entries</dt><dd>{snapshot.catalogEntries.toLocaleString()}</dd></div>
        </dl>
        <p>
          These are the installed measurement versions, not a claim that they are the latest upstream releases. <a href="https://github.com/iAnonymous3000/site-behavior-lab/issues/9">Toolchain update status</a>. Exact browser versions and per-report toolchain identities remain attached to each report. See the{" "}
          <Link href="/methodology/">methodology</Link> for what these inputs can and cannot establish.
        </p>
      </section>

  </>;
}

function formatUtc(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }) + " UTC";
}
