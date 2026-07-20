"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cookie,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FileText,
  Fingerprint,
  Globe2,
  Keyboard,
  Network,
  Radar,
  Shield,
  ShieldCheck
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { clientReportRuntime, staticAssetPath } from "../client-runtime";
import { isCorpusStats, type CorpusStats } from "@/lib/corpus-stats";
import { buildFindings, type FindingIconKey } from "@/lib/report-findings";
import { buildReportHeadline } from "@/lib/report-headline";
import { committedReportLocation, locateReport, type ReportRuntime } from "@/lib/report-locator";
import {
  displayRunView,
  familyUnsupportedOnRun,
  type ReportView,
  type RunView
} from "@/lib/scan-report-views";
import { plural } from "@/lib/text-format";
import { isReviewedStorageKey } from "@/lib/public-name-policy";
import type { NetworkRequestRecord, ReportShare } from "@/lib/types";

/**
 * The report page's overview cluster: the plain-language headline banner, the
 * findings board, the by-the-numbers metric grid, and the request
 * composition/timeline visualization, plus the share-permalink helpers the
 * headline's social actions and the app shell's Share button both resolve
 * links through. Moved byte-for-byte out of the app shell.
 */

export function reportSharePath(share: ReportShare | null | undefined, liveApiServesReportPages: boolean): string | null {
  if (!share?.id) return null;
  // The scan API only yields a shareable permalink when it serves its own report
  // pages (the full Node app / container). The JSON-only Browser Run Worker does
  // not, so `locateReport` then withholds the link rather than 404 it.
  const runtime: ReportRuntime = { ...clientReportRuntime(), liveApiServesReportPages };
  // A report whose JSON lives behind the scan API (`/api/reports/:id`) was just
  // produced by a running Node/container scanner; on a live-API static build it
  // is only servable from that API's own origin, so resolve it there. Committed
  // reports instead carry the static-file convention (`/reports/:id.json`) and
  // are served by the page that is already rendering them.
  const apiBacked = share.jsonPath.startsWith("/api/");
  if (runtime.staticExport && runtime.liveApiBacked && apiBacked) {
    return locateReport(share.id, runtime).pagePath;
  }
  return committedReportLocation(share.id, runtime).pagePath;
}

/**
 * Resolve a report permalink to an absolute URL fit for the clipboard or a
 * social post. Node and committed-static reports yield origin-relative paths
 * (e.g. `/reports/:id`) that navigate fine in an anchor but are useless once
 * pasted elsewhere; a live-API report already carries an absolute origin and is
 * left unchanged. Must run in the browser, it reads `window.location`.
 */
export function absoluteShareUrl(sharePath: string): string {
  try {
    return new URL(sharePath, window.location.origin).toString();
  } catch {
    return sharePath;
  }
}

export function HeadlineBanner({
  share,
  view,
  liveApiServesReportPages
}: {
  /** The wire report's share pointer, needed only to resolve the permalink. */
  share: ReportShare | null;
  view: ReportView;
  liveApiServesReportPages: boolean;
}) {
  const headline = useMemo(() => buildReportHeadline(view), [view]);
  const [shareLink, setShareLink] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Reuse the same permalink rule as the main Share button so "Post on X" /
    // "Copy post" never hand out a link the report's origin cannot render. When
    // there is no shareable permalink (a JSON-only scan API has no report page),
    // post the headline with no URL rather than the current app page, which is
    // not this report.
    const sharePath = reportSharePath(share, liveApiServesReportPages);
    setShareLink(sharePath ? absoluteShareUrl(sharePath) : "");
  }, [share, liveApiServesReportPages]);

  const postText = shareLink ? `${headline.shareText} ${shareLink}` : headline.shareText;
  const xHref = `https://twitter.com/intent/tweet?${new URLSearchParams({
    text: headline.shareText,
    ...(shareLink ? { url: shareLink } : {})
  }).toString()}`;

  async function copyPost() {
    try {
      await navigator.clipboard.writeText(postText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={`headline-banner tone-${headline.tone}`} aria-label="Plain-language summary">
      <p className="headline-kicker">{headline.kicker}</p>
      <h2 className="headline-title">{headline.headline}</h2>
      <p className="headline-subhead">{headline.subhead}</p>

      {headline.stats.length > 0 && (
        <div className="headline-stats">
          {headline.stats.map((stat) => (
            <div className={`headline-stat${stat.emphasis ? " is-emphasis" : ""}`} key={stat.label}>
              <span className="headline-stat-value">{stat.value}</span>
              <span className="headline-stat-label">{stat.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="headline-footer">
        <span className="headline-caveat">{headline.caveat}</span>
        <div className="headline-actions">
          <a className="headline-share primary" href={xHref} target="_blank" rel="noreferrer">
            <ExternalLink size={15} aria-hidden="true" />
            Post on X
          </a>
          <button type="button" className="headline-share" onClick={copyPost}>
            {copied ? <CheckCircle2 size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
            {copied ? "Copied" : "Copy post"}
          </button>
        </div>
      </div>
    </section>
  );
}

// Module-level cache so the corpus stats are fetched once per session.
let corpusStatsCache: CorpusStats | null | undefined;

function useCorpusStats(): CorpusStats | null {
  const [corpus, setCorpus] = useState<CorpusStats | null>(corpusStatsCache ?? null);

  useEffect(() => {
    if (corpusStatsCache !== undefined) {
      setCorpus(corpusStatsCache);
      return;
    }

    let cancelled = false;

    async function loadCorpus() {
      try {
        const response = await fetch(staticAssetPath("/corpus-stats.json"), { cache: "no-store" });
        if (!response.ok) throw new Error("Corpus stats unavailable.");
        const payload = (await response.json()) as unknown;
        corpusStatsCache = isCorpusStats(payload) ? payload : null;
      } catch {
        corpusStatsCache = null;
      }
      if (!cancelled) setCorpus(corpusStatsCache ?? null);
    }

    void loadCorpus();
    return () => {
      cancelled = true;
    };
  }, []);

  return corpus;
}

// Maps the findings engine's React-free icon keys to lucide components.
const FINDING_ICONS: Record<FindingIconKey, typeof Eye> = {
  globe: Globe2,
  network: Network,
  radar: Radar,
  cookie: Cookie,
  eye: Eye,
  keyboard: Keyboard,
  fingerprint: Fingerprint,
  "shield-check": ShieldCheck,
  check: CheckCircle2,
  alert: AlertTriangle,
  "file-text": FileText
};

export function FindingsBoard({ view }: { view: ReportView }) {
  const corpus = useCorpusStats();
  const findings = buildFindings(view, corpus);

  return (
    <section className="findings-board">
      <div className="findings-heading">
        <div>
          <p className="eyebrow">Plain-Language Findings</p>
          <h2>What this visit means</h2>
          <a className="glossary-link" href={staticAssetPath("/glossary/")}>
            Unfamiliar terms are defined in the glossary
          </a>
        </div>
        <span>{displayRunView(view).conditions.automation}</span>
      </div>
      <div className="finding-list">
        {findings.map((finding) => {
          const Icon = FINDING_ICONS[finding.icon];
          return (
            <article className={`finding-card tile-${finding.level}`} key={finding.id}>
              <div className="finding-icon">
                <Icon size={18} aria-hidden="true" />
              </div>
              <div>
                <h3>{finding.title}</h3>
                <p className="finding-lead">{finding.lead}</p>
                <p>{finding.detail}</p>
                <div className="finding-meta">
                  <span>{finding.evidence}</span>
                  {finding.benchmark && <span>{finding.benchmark}</span>}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function MetricGrid({ run }: { run: RunView }) {
  // Distinct catalogued entities among third-party requests: the same set
  // trackerEntitySummaries derives from the domain table.
  const knownServices = new Set(
    run.evidence.requests.filter((request) => request.thirdParty && request.tracker).map((request) => request.tracker!.entity)
  ).size;
  // DISTINCT APIs, not row count: v2 evidence is phase-tagged, so one API
  // family can contribute a row per phase.
  const apiFamilies = new Set(run.evidence.fingerprintEvents.map((event) => event.api)).size;
  const detectionCount = run.evidence.fingerprintDetections.reduce((total, detection) => total + detection.count, 0);
  const privacyFilteredStorageKeys = run.evidence.storage.filter((entry) => !isReviewedStorageKey(entry.key)).length;
  const cookiesUnsupported = familyUnsupportedOnRun(run, "cookies");
  const storageUnsupported = familyUnsupportedOnRun(run, "storage");
  const fingerprintUnsupported =
    familyUnsupportedOnRun(run, "fingerprinting") || familyUnsupportedOnRun(run, "detector-output");
  const metrics = [
    {
      label: "Requests",
      value: run.counts.totalRequests,
      detail: `${run.counts.thirdPartyRequests.toLocaleString("en-US")} third-party`,
      icon: Network
    },
    ...(run.conditions.adblockActive
      ? [
          run.conditions.shieldsMode === "block-simulation"
            ? {
                label: "Blocked by Brave lists",
                value: run.counts.shieldsBlockedRequests ?? 0,
                detail: "aborted in this visit",
                icon: ShieldCheck
              }
            : {
                label: "Matched Shields lists",
                value: run.counts.shieldsBlockedRequests ?? 0,
                detail: `of ${run.counts.totalRequests.toLocaleString("en-US")} requests`,
                icon: ShieldCheck
              }
        ]
      : []),
    {
      label: "Third-party domains",
      value: run.counts.thirdPartyDomains,
      detail: `${knownServices.toLocaleString("en-US")} known ${knownServices === 1 ? "service" : "services"}`,
      icon: Globe2
    },
    {
      label: "Cookies",
      value: cookiesUnsupported ? "Not captured" : run.counts.cookies,
      detail: cookiesUnsupported
        ? "unsupported by PageGraph import"
        : `${run.counts.thirdPartyCookies.toLocaleString("en-US")} third-party`,
      icon: Cookie
    },
    {
      label: "Storage keys",
      value: storageUnsupported ? "Not captured" : run.counts.storageEntries,
      detail: storageUnsupported
        ? "unsupported by PageGraph import"
        : privacyFilteredStorageKeys > 0
          ? `${privacyFilteredStorageKeys.toLocaleString("en-US")} ${privacyFilteredStorageKeys === 1 ? "key" : "keys"} privacy-filtered; values omitted`
          : "values omitted",
      icon: Database
    },
    {
      label: "Fingerprint-like calls",
      value: fingerprintUnsupported ? "Not captured" : run.counts.fingerprintEvents,
      detail: fingerprintUnsupported
        ? "unsupported by PageGraph import"
        : detectionCount > 0
          ? `${plural(detectionCount, "behavior")} matched`
          : `${apiFamilies.toLocaleString("en-US")} API ${apiFamilies === 1 ? "family" : "families"}`,
      icon: Fingerprint
    },
    {
      label: "GPC signal",
      value: run.conditions.gpcEnabled ? "Sent" : "Off",
      detail: run.conditions.gpcEnabled ? "opt-out sent" : "no opt-out sent",
      icon: run.conditions.gpcEnabled ? ShieldCheck : Shield
    },
    {
      label: "Duration",
      value: `${Math.round(run.durationMs / 100) / 10}s`,
      detail: run.startedAt
        ? new Date(run.startedAt).toLocaleTimeString("en-US", { timeZone: "UTC" })
        : "start time not recorded",
      icon: Clock
    }
  ];

  return (
    <section className="numbers-section">
      <div className="numbers-heading">
        <p className="eyebrow">By the numbers</p>
        <span>Recorded counts and evidence availability from this one visit. The findings above interpret them.</span>
      </div>
      <div className="metric-grid">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div className="metric-card" key={metric.label}>
              <Icon size={18} aria-hidden="true" />
              <span className="m-label">{metric.label}</span>
              <strong className="m-value">
                {typeof metric.value === "number" ? metric.value.toLocaleString("en-US") : metric.value}
              </strong>
              <small className="m-detail">{metric.detail}</small>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function TrafficViz({ run }: { run: RunView }) {
  // Clamp so the three segments always partition the total exactly, even in the
  // edge case of scanning a tracker's own domain (where a first-party request can
  // match the catalog and knownTrackerRequests can exceed thirdPartyRequests).
  const total = run.counts.totalRequests;
  const thirdParty = Math.min(run.counts.thirdPartyRequests, total);
  const tracker = Math.min(run.counts.knownTrackerRequests, thirdParty);
  const third = thirdParty - tracker;
  const first = total - thirdParty;

  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 10000) / 100}%` : "0%");

  return (
    <section className="viz-card">
      <h2>Request composition &amp; timeline</h2>
      <div className="party-bar" role="img" aria-label={`${first} first-party, ${third} third-party, ${tracker} known-service requests`}>
        {first > 0 && <span className="party-seg-first" style={{ width: pct(first) }} />}
        {third > 0 && <span className="party-seg-third" style={{ width: pct(third) }} />}
        {tracker > 0 && <span className="party-seg-track" style={{ width: pct(tracker) }} />}
      </div>
      <div className="party-legend">
        <div>
          <span className="legend-swatch party-seg-first" />
          First-party <span className="legend-count">{first.toLocaleString("en-US")}</span>
        </div>
        <div>
          <span className="legend-swatch party-seg-third" />
          Third-party <span className="legend-count">{third.toLocaleString("en-US")}</span>
        </div>
        <div>
          <span className="legend-swatch party-seg-track" />
          Known service <span className="legend-count">{tracker.toLocaleString("en-US")}</span>
        </div>
      </div>
      <RequestTimeline requests={run.evidence.requests} />
    </section>
  );
}

function RequestTimeline({ requests }: { requests: NetworkRequestRecord[] }) {
  if (requests.length === 0) return null;
  const maxTime = Math.max(...requests.map((request) => request.startedAtMs), 1);
  const width = 1000;
  const height = 44;

  return (
    <div className="timeline">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="When requests fired during the visit">
        {/* Keyed with the index: v2 evidence rows are phase-tagged, so one
            request id can legitimately appear in several phases. */}
        {requests.map((request, index) => {
          const x = (request.startedAtMs / maxTime) * (width - 2);
          const color = request.tracker
            ? "var(--sig-warn)"
            : request.thirdParty
              ? "var(--sig-info)"
              : "var(--sig-quiet)";
          return <rect key={`${request.id}:${index}`} x={x} y={request.tracker ? 4 : request.thirdParty ? 12 : 20} width={2} height={height - 24} fill={color} opacity={0.85} rx={1} />;
        })}
      </svg>
      <div className="timeline-axis">
        <span>0 ms</span>
        <span>{maxTime.toLocaleString("en-US")} ms</span>
      </div>
    </div>
  );
}
