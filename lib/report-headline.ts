import {
  HEADLINE_PLATFORMS,
  fingerprintDetection,
  highEntropyDetections,
  isOperationalEntity,
  trackerEntitySummaries
} from "./report-insights";
import { plural } from "./text-format";
import type {
  ComparisonScanResult,
  FingerprintDetectionSummary,
  ScanReport,
  ScanResult
} from "./types";

/**
 * Plain-language "headline" layer.
 *
 * This module turns a {@link ScanReport} into the single punchy, shareable
 * takeaway that leads the report UI, the social unfurl metadata, and the
 * generated Open Graph card. It deliberately leads with the most concrete,
 * defensible signal (a privacy-signal that changed little, named platforms,
 * tracking companies) and keeps the rigor in `caveat` so the framing never
 * outruns the evidence.
 *
 * It is intentionally dependency-free (types only) so it can run in the React
 * client, in server-side `generateMetadata`, and inside the `next/og` image
 * route without pulling in browser- or Node-only code.
 *
 * The tracker/fingerprint classification it relies on lives in
 * `lib/report-insights.ts`, shared with the report UI so the two cannot drift.
 */

export type HeadlineTone = "alarm" | "warn" | "info" | "calm";

export type ReportHeadlineStat = {
  label: string;
  value: string;
  emphasis?: boolean;
};

export type ReportHeadline = {
  tone: HeadlineTone;
  kicker: string;
  headline: string;
  subhead: string;
  caveat: string;
  stats: ReportHeadlineStat[];
  domain: string;
  /** Suggested post text (without the URL); the UI appends the report link. */
  shareText: string;
};

const CAVEAT = "Observed in one automated visit: evidence to check, not a verdict.";
const KICKER = "What this actually means";
const SHARE_TAGLINE = "See what a site does, not what it says. Open-source and reproducible:";

export function buildReportHeadline(report: ScanReport): ReportHeadline {
  const result = displayScanResult(report);
  const domain = friendlyDomain(result);
  const entities = trackerEntitySummaries(result);
  const trackingEntities = entities.filter((entity) => !isOperationalEntity(entity));
  const trackingNames = trackingEntities.map((entity) => entity.entity);
  const platforms = entities.filter((entity) => HEADLINE_PLATFORMS.includes(entity.entity)).map((entity) => entity.entity);
  const highEntropy = highEntropyDetections(result);
  const sessionReplay = trackingEntities.some((entity) =>
    entity.categories.some((category) => category.toLowerCase().includes("session replay"))
  );
  const sessionRecording = hasDetection(result, "session-recording");
  const inputMonitoring = hasDetection(result, "input-monitoring");
  const stats = buildStats(result, trackingEntities.length);

  const extras: string[] = [];
  if (inputMonitoring) {
    extras.push("a third-party script watched keyboard input");
  } else if (sessionRecording || sessionReplay) {
    extras.push("a session-replay vendor can record how you move and click");
  }
  if (highEntropy.length > 0) {
    extras.push(`${plural(highEntropy.length, "browser-fingerprinting heuristic")} matched`);
  }
  const extraNote = extras.length > 0 ? ` It also looks like ${joinNames(extras, 2)}.` : "";

  const finish = (tone: HeadlineTone, headline: string, subhead: string, statsOverride?: ReportHeadlineStat[]): ReportHeadline => {
    const resolvedStats = statsOverride ?? stats;
    return {
      tone,
      kicker: KICKER,
      headline,
      subhead,
      caveat: CAVEAT,
      stats: resolvedStats,
      domain,
      shareText: buildShareText(headline, resolvedStats)
    };
  };

  // Confirmed input capture is the loudest possible signal — it leads over every
  // other story, including the comparison framing.
  const keystrokeExfil = fingerprintDetection(result, "keystroke-exfiltration");
  if (keystrokeExfil) {
    return finish(
      "alarm",
      `${domain} sent what you type to ${plural(
        keystrokeExfil.evidence.recipients.length,
        "third party",
        "third parties"
      )}.`,
      `A unique value typed into a form on ${domain} turned up in requests to ${joinNames(
        keystrokeExfil.evidence.recipients
      )} — and the form was never submitted. A real visitor's keystrokes could be captured the same way.`
    );
  }

  if (isComparison(report) && report.comparisonType === "gpc") {
    const before = report.diff.thirdPartyRequests.before;
    const after = report.diff.thirdPartyRequests.after;
    const reductionPct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
    // GPC "on" can load as many — or even more — off-site requests than "off",
    // so phrase the residual instead of emitting "down just -12%".
    const changePhrase =
      reductionPct > 0
        ? `down just ${reductionPct}%`
        : reductionPct < 0
          ? `${Math.abs(reductionPct)}% more than without it`
          : "with no measurable drop";

    if (trackingEntities.length > 0 && after > 0 && reductionPct < 25) {
      return finish(
        "alarm",
        `Your privacy signal barely changed what ${domain} loaded.`,
        `Even with a "do not sell or share" (GPC) signal switched on, ${domain} still contacted ${plural(
          trackingEntities.length,
          "tracking company",
          "tracking companies"
        )}: ${plural(after, "third-party request")}, ${changePhrase}.${extraNote}`
      );
    }
    if (reductionPct >= 50) {
      return finish(
        "calm",
        `${domain} pulled back when you sent a privacy signal.`,
        `With a Global Privacy Control signal on, off-site requests dropped ${reductionPct}% (${n(before)} → ${n(after)}).`
      );
    }
  }

  if (isComparison(report) && report.comparisonType === "shields") {
    const before = report.diff.thirdPartyRequests.before;
    const after = report.diff.thirdPartyRequests.after;
    const removed = Math.max(0, before - after);
    const total = report.diff.totalRequests.before;
    if (removed > 0) {
      return finish(
        removed >= 30 ? "warn" : "info",
        `A basic blocker would stop ${plural(removed, "request")} on ${domain}.`,
        `Of ${plural(total, "request")} this page made, ${plural(
          removed,
          "third-party request"
        )} were ads or trackers a default blocker would remove.${extraNote}`
      );
    }
  }

  if (platforms.length > 0) {
    return finish(
      platforms.length >= 3 ? "alarm" : "warn",
      `${domain} told ${joinNames(platforms)} you were here.`,
      `${
        trackingEntities.length > 0
          ? `${plural(trackingEntities.length, "tracking company", "tracking companies")} saw this visit`
          : "Trackers saw this visit"
      } across ${plural(result.summary.thirdPartyDomains, "third-party domain")}.${extraNote}`
    );
  }

  if (trackingEntities.length > 0) {
    return finish(
      trackingEntities.length >= 6 ? "warn" : "info",
      `${domain} shared this visit with ${plural(trackingEntities.length, "tracking company", "tracking companies")}.`,
      `${joinNames(trackingNames)} loaded with the page: ${plural(
        result.summary.thirdPartyRequests,
        "request"
      )} went to ${plural(result.summary.thirdPartyDomains, "third-party domain")}.${extraNote}`
    );
  }

  if (highEntropy.length > 0 || sessionRecording || inputMonitoring) {
    const probeStats: ReportHeadlineStat[] =
      stats.length > 0 ? stats : [{ label: "fingerprinting signals", value: n(highEntropy.length), emphasis: true }];
    return finish(
      "warn",
      `${domain} probed your browser, not just served a page.`,
      `No catalogued tracking company matched, but ${joinNames(
        extras.length > 0 ? extras : ["fingerprint-like browser APIs were called"],
        2
      )}.`,
      probeStats
    );
  }

  const calmStats: ReportHeadlineStat[] = stats.length > 0 ? stats : [{ label: "third-party requests", value: "0", emphasis: true }];
  return finish(
    "calm",
    `${domain} kept this visit relatively private.`,
    result.summary.thirdPartyDomains > 0
      ? `${plural(
          result.summary.thirdPartyDomains,
          "third-party domain"
        )} loaded, but no catalogued tracking company, third-party cookie, or fingerprinting signal showed up in this visit.`
      : "No third-party domains, tracking companies, cookies, or fingerprinting signals showed up in this visit.",
    calmStats
  );
}

function buildStats(result: ScanResult, trackingCount: number): ReportHeadlineStat[] {
  const stats: ReportHeadlineStat[] = [];

  if (trackingCount > 0) {
    stats.push({ label: trackingCount === 1 ? "tracking company" : "tracking companies", value: n(trackingCount), emphasis: true });
  } else if (result.summary.thirdPartyDomains > 0) {
    stats.push({
      label: result.summary.thirdPartyDomains === 1 ? "third-party domain" : "third-party domains",
      value: n(result.summary.thirdPartyDomains),
      emphasis: true
    });
  }

  if (result.summary.thirdPartyRequests > 0) {
    stats.push({ label: "data requests sent off-site", value: n(result.summary.thirdPartyRequests) });
  }
  if (result.summary.thirdPartyCookies > 0) {
    stats.push({
      label: result.summary.thirdPartyCookies === 1 ? "third-party cookie" : "third-party cookies",
      value: n(result.summary.thirdPartyCookies)
    });
  }

  const fingerprintSignals = highEntropyDetections(result).length;
  if (fingerprintSignals > 0) {
    stats.push({ label: fingerprintSignals === 1 ? "fingerprinting signal" : "fingerprinting signals", value: n(fingerprintSignals) });
  }

  return stats.slice(0, 4);
}

function buildShareText(headline: string, stats: ReportHeadlineStat[]): string {
  const top = stats
    .slice(0, 2)
    .map((stat) => `${stat.value} ${stat.label}`)
    .join(" · ");
  return top ? `${headline} ${top}. ${SHARE_TAGLINE}` : `${headline} ${SHARE_TAGLINE}`;
}

function hasDetection(result: ScanResult, kind: FingerprintDetectionSummary["kind"]): boolean {
  return (result.fingerprintDetections ?? []).some((detection) => detection.kind === kind);
}

function isComparison(report: ScanReport): report is ComparisonScanResult {
  return report.reportType === "comparison";
}

/**
 * The run to display as the report's primary view. Comparison reports lead with
 * the baseline (the off / unprotected run) so the report shows what the site
 * actually did; the GPC/Shields "on" run is the protected state, surfaced in the
 * comparison diff rather than the headline numbers. Temporal diffs lead with the
 * newer "after" run.
 */
export function displayScanResult(report: ScanReport): ScanResult {
  if (report.reportType !== "comparison") return report;
  return report.comparisonType === "temporal" ? report.variant : report.baseline;
}

function friendlyDomain(result: ScanResult): string {
  return result.summary.firstPartyDomain.replace(/^www\./, "") || result.summary.firstPartyDomain;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function joinNames(items: string[], limit = 3): string {
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  if (visible.length === 0) return "";
  if (visible.length === 1) return remaining > 0 ? `${visible[0]} and ${remaining} more` : visible[0];
  const base = `${visible.slice(0, -1).join(", ")} and ${visible[visible.length - 1]}`;
  return remaining > 0 ? `${base}, +${remaining} more` : base;
}
