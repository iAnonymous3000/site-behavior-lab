"use client";

import {
  AlertOctagon,
  AlertTriangle,
  AlertCircle,
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
import { useEffect, useRef, useState } from "react";
import { clientReportRuntime, staticAssetPath } from "../client-runtime";
import {
  LatestClientOperation,
  MAX_CORPUS_STATS_JSON_BYTES,
  fetchJsonWithPolicy
} from "@/lib/client-fetch-policy";
import { isCorpusStats, type CorpusStats } from "@/lib/corpus-stats";
import { buildFindings, type FindingIconKey } from "@/lib/report-findings";
import type { HeadlineTone, ReportHeadline } from "@/lib/report-headline";
import {
  REPORT_SEVERITY_LABELS,
  claimCountValue,
  retainedCountLabel,
  type ReportFacts,
  type RunFacts
} from "@/lib/report-facts";
import {
  buildEvidenceHash,
  findingEvidenceLink,
  renderedEvidenceArm,
  requestTimingSummary,
  type EvidenceArm
} from "@/lib/report-evidence-navigation";
import { gpcRunMeasurement, shieldsFilterMatchDetail } from "@/lib/report-insights";
import {
  committedReportLocation,
  locateReport,
  reportPdfLocation,
  type ReportRuntime
} from "@/lib/report-locator";
import { buildRequestComposition } from "@/lib/request-composition";
import { buildRequestTimelineModel } from "@/lib/request-timeline";
import type { ReportView } from "@/lib/scan-report-views";
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
 * The PDF download URL for this report, or null when no reachable origin can
 * render one.
 *
 * Same shape as `reportSharePath` and for the same reason: a freshly scanned
 * report lives only behind the scan API, so its PDF is rendered there, while a
 * committed report on the static export has no renderer to reach at all. The
 * `apiBacked` test is what separates the two, exactly as it does above.
 */
export function reportPdfHref(
  share: ReportShare | null | undefined,
  liveApiServesReportPages: boolean
): string | null {
  if (!share?.id) return null;
  const runtime: ReportRuntime = { ...clientReportRuntime(), liveApiServesReportPages };
  if (runtime.staticExport && !share.jsonPath.startsWith("/api/")) return null;
  return reportPdfLocation(share.id, runtime);
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
  headline,
  liveApiServesReportPages
}: {
  /** The wire report's share pointer, needed only to resolve the permalink. */
  share: ReportShare | null;
  headline: ReportHeadline;
  liveApiServesReportPages: boolean;
}) {
  const [shareLink, setShareLink] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

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
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2500);
    }
  }

  return (
    <section className={`headline-banner tone-${headline.tone}`} aria-label="Plain-language summary">
      {/* The banner's tone had one channel, a hue on its left border and its
          kicker, and the kicker text is a single constant across all four
          tones. The icon is the shape channel WCAG 1.4.1 asks for. It stays
          aria-hidden deliberately: the headline sentence below already carries
          the meaning in words, and inventing a second spoken rank here would
          put a name on the tone that the findings board's own severity scale
          does not have to agree with. */}
      <p className="headline-kicker">
        <ToneIcon tone={headline.tone} />
        {headline.kicker}
      </p>
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
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          <button type="button" className="headline-share" onClick={copyPost} aria-live="polite">
            {copyState === "copied" ? (
              <CheckCircle2 size={15} aria-hidden="true" />
            ) : copyState === "failed" ? (
              <AlertCircle size={15} aria-hidden="true" />
            ) : (
              <Copy size={15} aria-hidden="true" />
            )}
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy post"}
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
  const operationRef = useRef<LatestClientOperation | null>(null);
  if (!operationRef.current) operationRef.current = new LatestClientOperation();
  const operation = operationRef.current;

  useEffect(() => {
    if (corpusStatsCache !== undefined) {
      setCorpus(corpusStatsCache);
      return;
    }

    void operation.run(
      (signal) => fetchJsonWithPolicy(staticAssetPath("/corpus-stats.json"), { cache: "no-store" }, {
        label: "Corpus statistics",
        maxBytes: MAX_CORPUS_STATS_JSON_BYTES,
        signal,
        httpError: () => new Error("Corpus stats unavailable.")
      }),
      {
        onSuccess: (payload) => {
          corpusStatsCache = isCorpusStats(payload) ? payload : null;
          setCorpus(corpusStatsCache);
        },
        onError: () => {
          // Deliberately does NOT write the cache. A transport or parse failure
          // is transient, and caching it disabled percentile severity for the
          // rest of the tab even after /corpus-stats.json recovered, so a later
          // PDF render in a fresh realm could rank a report differently from
          // the page still open in front of the reader. Leaving the cache
          // unset lets the next mount retry.
          //
          // The success branch above still caches `null` for a payload that was
          // served but failed the shape check: refetching a deployment's own
          // malformed asset cannot produce a different answer, so that negative
          // is durable and this one is not.
          setCorpus(null);
        }
      }
    );
    return () => operation.cancel();
  }, [operation]);

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

export function FindingsBoard({
  view,
  facts,
  headline
}: {
  view: ReportView;
  facts: ReportFacts;
  headline: ReportHeadline;
}) {
  const corpus = useCorpusStats();
  const evidenceArm: EvidenceArm | undefined = renderedEvidenceArm(view, headline);
  // The board describes the same arm as the headline, the stat chips, the
  // tables, and the evidence links this component already derives below.
  const findings = buildFindings(view, corpus, facts, evidenceArm);

  return (
    <section className="findings-board" id="findings">
      <div className="findings-heading">
        <div>
          <p className="eyebrow">Plain-Language Findings</p>
          <h2>What this visit means</h2>
          <a className="glossary-link" href={staticAssetPath("/glossary/")}>
            Unfamiliar terms are defined in the glossary
          </a>
        </div>
        <span>{facts.display.run.conditions.automation}</span>
      </div>
      <div className="finding-list">
        {findings.map((finding) => {
          const Icon = FINDING_ICONS[finding.icon];
          const evidenceLink = findingEvidenceLink(finding.id, evidenceArm);
          return (
            <article className={`finding-card tile-${finding.level}`} key={finding.id}>
              <div className="finding-icon">
                <Icon size={18} aria-hidden="true" />
              </div>
              <div>
                {/* The card's rank had exactly one channel: a hue on the left
                    border and the icon tint. The icon itself is chosen per
                    FINDING, not per level, so five levels shared no shape and no
                    text, and the prose never states the rank. Naming it is the
                    second channel WCAG 1.4.1 asks for, and it also lets a reader
                    scan the board for what matters without decoding colour. */}
                <p className="finding-level">{REPORT_SEVERITY_LABELS[finding.level]}</p>
                <h3>{finding.title}</h3>
                <p className="finding-lead">{finding.lead}</p>
                <p>{finding.detail}</p>
                <div className="finding-meta">
                  <span>{finding.evidence}</span>
                  {finding.benchmark && <span>{finding.benchmark}</span>}
                  {evidenceLink && (
                    <a
                      className="glossary-link"
                      href={buildEvidenceHash(evidenceLink.target)}
                      aria-label={`${evidenceLink.label} for ${finding.title}`}
                    >
                      {evidenceLink.label}
                    </a>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The headline banner's tone as a shape, not only a hue.
 *
 * Decorative by design (`aria-hidden`): the headline sentence directly below
 * states the finding in words, so this adds the non-colour channel sighted
 * readers were missing without asserting a rank that the findings board's own
 * severity scale never has to agree with.
 */
function ToneIcon({ tone }: { tone: HeadlineTone }) {
  const Icon =
    tone === "alarm"
      ? AlertOctagon
      : tone === "warn"
        ? AlertTriangle
        : tone === "info"
          ? Radar
          : CheckCircle2;
  return <Icon className="tone-icon" size={14} aria-hidden="true" />;
}

export function MetricGrid({ facts }: { facts: RunFacts }) {
  const run = facts.run;
  // Catalog classification is deliberately separate from CMP/ownership/CNAME
  // operator identity.
  const knownServices = facts.identity.catalogEntities.length;
  // DISTINCT APIs, not row count: v2 evidence is phase-tagged, so one API
  // family can contribute a row per phase.
  const apiFamilies = facts.signals.fingerprint.apiFamilies;
  const highEntropyDetectionCount =
    facts.signals.fingerprint.highEntropyDetections.length;
  const privacyFilteredStorageKeys = run.evidence.storage.filter((entry) => !isReviewedStorageKey(entry.key)).length;
  const cookieState = facts.evidence.cookies.state;
  const storageState = facts.evidence.storage.state;
  const fingerprintState = facts.evidence.fingerprinting.state;
  const fingerprintClaim = facts.claims["fingerprint-apis"];
  const fingerprintDetectorIncomplete =
    fingerprintClaim.blockers.includes("detector-incomplete");
  const fingerprintValue =
    fingerprintState === "unsupported"
      ? "Not captured"
      : fingerprintDetectorIncomplete
        ? claimCountValue(run.counts.fingerprintEvents, fingerprintClaim)
        : fingerprintState === "censored"
          ? retainedCountLabel(run.counts.fingerprintEvents, fingerprintState)
          : run.counts.fingerprintEvents;
  const fingerprintDetail =
    fingerprintState === "unsupported"
      ? "unsupported by PageGraph import"
      : fingerprintDetectorIncomplete
        ? run.counts.fingerprintEvents > 0
          ? `${run.counts.fingerprintEvents.toLocaleString("en-US")} API events retained; fingerprint detector incomplete`
          : "fingerprint detector incomplete; no exact count available"
        : highEntropyDetectionCount > 0
          ? `${plural(highEntropyDetectionCount, "high-entropy heuristic")} matched`
          : `${apiFamilies.toLocaleString("en-US")} API ${apiFamilies === 1 ? "family" : "families"}`;
  const shieldsMeasurement = facts.signals.shields.measurement;
  const shieldsConfigured = run.conditions.shieldsMode !== null && run.conditions.shieldsMode !== "off";
  const gpcMeasurement = gpcRunMeasurement(run);
  const gpcDisplay =
    gpcMeasurement.outcome === "verified"
      ? {
          value: gpcMeasurement.observed ? "Verified on" : "Verified off",
          detail: "header and JavaScript readback agreed"
        }
      : gpcMeasurement.outcome === "contradicted"
        ? { value: "Mismatch", detail: `configured ${gpcMeasurement.configured ? "on" : "off"}; readback disagreed` }
        : gpcMeasurement.outcome === "unverified"
          ? { value: "Not verified", detail: `configured ${gpcMeasurement.configured ? "on" : "off"}; readback inconclusive` }
          : { value: gpcMeasurement.configured ? "Configured on" : "Configured off", detail: "readback not recorded" };
  const metrics = [
    {
      label: "Requests",
      value: retainedCountLabel(run.counts.totalRequests, facts.evidence.requests.state),
      detail: `${retainedCountLabel(
        run.counts.thirdPartyRequests,
        facts.evidence.requests.state
      )} ${facts.evidence.requests.state === "censored" ? "retained third-party" : "third-party"}`,
      icon: Network
    },
    ...(shieldsMeasurement
      ? [
          shieldsMeasurement.kind === "engine-blocked"
            ? {
                label: "Blocked by Brave lists",
                value: retainedCountLabel(
                  shieldsMeasurement.count,
                  facts.evidence.requests.state
                ),
                // Only a run that recorded engine verification facts may be
                // called verified. A legacy wire carries the count alone, and
                // the verification is exactly what it lacks.
                detail:
                  shieldsMeasurement.origin === "recorded"
                    ? "verified engine blocks in this visit"
                    : "engine blocks reported by this visit; no engine readback recorded",
                icon: shieldsMeasurement.origin === "recorded" ? ShieldCheck : Shield
              }
            : {
                label: "Matched Shields lists",
                value: retainedCountLabel(
                  shieldsMeasurement.count,
                  facts.evidence.requests.state
                ),
                // The denominator is what the engine EVALUATED, never the
                // retained request total: those are different populations,
                // and a legacy v1 wire records no evaluated count at all, so
                // its line states the counter's provenance with no ratio.
                // Both branches come from one shared builder so this line,
                // the card, and the headline cannot disagree again.
                detail: shieldsFilterMatchDetail(shieldsMeasurement),
                icon: shieldsMeasurement.origin === "recorded" ? ShieldCheck : Shield
              }
        ]
      : shieldsConfigured || run.verificationFacts?.shields
        ? [
            {
              label: "Brave-list measurement",
              value: "Not verified",
              detail: "engine application or request evaluation was inconclusive",
              icon: Shield
            }
          ]
        : []),
    {
      label: "Third-party domains",
      value: retainedCountLabel(run.counts.thirdPartyDomains, facts.evidence.requests.state),
      detail: `${knownServices.toLocaleString("en-US")} distinct catalogued service ${
        knownServices === 1 ? "entity" : "entities"
      }${
        facts.evidence.requests.state === "censored" ? " retained" : ""
      }`,
      icon: Globe2
    },
    {
      label: "Cookies",
      value:
        cookieState === "unsupported"
          ? "Not captured"
          : cookieState === "censored"
            ? "Snapshot incomplete"
            : run.counts.cookies,
      detail: cookieState === "unsupported"
        ? "unsupported by PageGraph import"
        : cookieState === "censored"
          ? `${run.counts.cookies.toLocaleString("en-US")} cookie records retained; final state incomplete`
        : `${run.counts.thirdPartyCookies.toLocaleString("en-US")} third-party`,
      icon: Cookie
    },
    {
      label: "Storage keys",
      value:
        storageState === "unsupported"
          ? "Not captured"
          : storageState === "censored"
            ? "Snapshot incomplete"
            : run.counts.storageEntries,
      detail: storageState === "unsupported"
        ? "unsupported by PageGraph import"
        : storageState === "censored"
          ? `${run.counts.storageEntries.toLocaleString("en-US")} keys retained; final state incomplete`
        : privacyFilteredStorageKeys > 0
          ? `${privacyFilteredStorageKeys.toLocaleString("en-US")} ${privacyFilteredStorageKeys === 1 ? "key" : "keys"} privacy-filtered; values omitted`
          : "values omitted",
      icon: Database
    },
    {
      label: "Fingerprint API calls",
      value: fingerprintValue,
      detail: fingerprintDetail,
      icon: Fingerprint
    },
    ...(facts.signals.fingerprint.listenerCoverageObserved
      ? [
          {
            label: "Interaction listeners",
            value: facts.signals.fingerprint.inputMonitoring ? "Input" : "Broad",
            detail: "third-party listener coverage; transmission tested separately",
            icon: Eye
          }
        ]
      : []),
    {
      label: "GPC signal",
      value: gpcDisplay.value,
      detail: gpcDisplay.detail,
      icon: gpcMeasurement.observed === true ? ShieldCheck : Shield
    },
    {
      label: "Duration",
      value: `${Math.round(run.durationMs / 100) / 10}s`,
      // On the homepage scan flow this is the only clock time on the whole report, and
      // ReportPageContext (which labels its own timestamps) renders on the permalink
      // only. Without the zone marker a reader in Pacific reads a UTC time as local.
      detail: run.startedAt
        ? new Date(run.startedAt).toLocaleTimeString("en-US", {
            timeZone: "UTC",
            timeZoneName: "short"
          })
        : "start time not recorded",
      icon: Clock
    }
  ];

  return (
    <section className="numbers-section" id="numbers">
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

export function TrafficViz({ facts }: { facts: RunFacts }) {
  const run = facts.run;
  const total = run.counts.totalRequests;
  const {
    firstPartyRequests: first,
    otherThirdPartyRequests: otherThirdParty,
    catalogMatchedThirdPartyRequests: catalogMatchedThirdParty
  } = buildRequestComposition({
    totalRequests: total,
    thirdPartyRequests: run.counts.thirdPartyRequests,
    requests: run.evidence.requests
  });

  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 10000) / 100}%` : "0%");

  return (
    <section className="viz-card" id="traffic">
      <h2>{facts.evidence.requests.state === "censored" ? "Retained request composition & timeline" : "Request composition & timeline"}</h2>
      <div
        className="party-bar"
        role="img"
        aria-label={`${facts.evidence.requests.state === "censored" ? "Retained requests: " : ""}${first} first-party, ${otherThirdParty} other third-party, ${catalogMatchedThirdParty} catalog-matched third-party requests`}
      >
        {first > 0 && <span className="party-seg-first" style={{ width: pct(first) }} />}
        {otherThirdParty > 0 && <span className="party-seg-third" style={{ width: pct(otherThirdParty) }} />}
        {catalogMatchedThirdParty > 0 && (
          <span className="party-seg-track" style={{ width: pct(catalogMatchedThirdParty) }} />
        )}
      </div>
      <div className="party-legend">
        <div>
          <span className="legend-swatch party-seg-first" />
          First-party requests <span className="legend-count">{first.toLocaleString("en-US")}</span>
        </div>
        <div>
          <span className="legend-swatch party-seg-third" />
          Other third-party requests <span className="legend-count">{otherThirdParty.toLocaleString("en-US")}</span>
        </div>
        <div>
          <span className="legend-swatch party-seg-track" />
          Catalog-matched third-party requests{" "}
          <span className="legend-count">{catalogMatchedThirdParty.toLocaleString("en-US")}</span>
        </div>
      </div>
      <RequestTimeline requests={run.evidence.requests} />
    </section>
  );
}

function RequestTimeline({ requests }: { requests: NetworkRequestRecord[] }) {
  if (requests.length === 0) return null;
  const { marks, maxTime } = buildRequestTimelineModel(requests);
  const timingSummary = requestTimingSummary(requests);
  const width = 1000;
  const height = 44;

  return (
    <div className="timeline">
      <p className="muted">
        {timingSummary}{" "}
        <a href={buildEvidenceHash({ section: "requests" })}>Open the request log for exact timing and request details.</a>
      </p>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {marks.map((mark, index) => {
          const x = mark.xRatio * (width - 2);
          const color = mark.role === "tracker"
            ? "var(--sig-warn)"
            : mark.role === "third-party"
              ? "var(--sig-info)"
              : "var(--sig-quiet)";
          return <rect key={index} x={x} y={mark.role === "tracker" ? 4 : mark.role === "third-party" ? 12 : 20} width={2} height={height - 24} fill={color} opacity={0.85} rx={1} />;
        })}
      </svg>
      <div className="timeline-axis">
        <span>0 ms</span>
        <span>{maxTime.toLocaleString("en-US")} ms</span>
      </div>
    </div>
  );
}
