import { comparisonEligibility } from "./comparison-eligibility";
import {
  HEADLINE_PLATFORMS,
  crossSiteListenerDetection,
  fingerprintDetection,
  highEntropyDetections,
  isOperationalEntity,
  keystrokeLeakHashed,
  pixelFieldLabel,
  scanLoadFailureStatus,
  shieldsRunMeasurement,
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

const SINGLE_VISIT_CAVEAT = "Observed in one automated visit: evidence to check, not a verdict.";
const COMPARISON_CAVEAT = "Observed in two automated visits: evidence to check, not a verdict.";
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
  // Listener-coverage claims are restricted to genuinely cross-site origins:
  // the in-page probe's hostname heuristic can misread same-site siblings
  // (see crossSiteListenerDetection), and a same-party listener is normal.
  const sessionRecording = Boolean(crossSiteListenerDetection(result, "session-recording"));
  const inputMonitoring = Boolean(crossSiteListenerDetection(result, "input-monitoring"));
  const stats = buildStats(result, trackingEntities.length);
  // Comparison claims are gated on the SHARED eligibility rule: a failed,
  // request-capped, or mismatched arm disqualifies every causal-sounding
  // comparison framing below, and the report falls back to the evidence-led
  // single-visit story (the findings board explains why).
  const comparisonUsable = isComparison(report) ? comparisonEligibility(report).eligible : false;

  const extras: string[] = [];
  if (inputMonitoring) {
    extras.push("a third-party script registered listeners on keyboard input");
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
      caveat: isComparison(report) ? COMPARISON_CAVEAT : SINGLE_VISIT_CAVEAT,
      stats: resolvedStats,
      domain,
      shareText: buildShareText(headline, resolvedStats)
    };
  };

  // A page that answered with an HTTP error or block status (403/404/500/503…)
  // did not really load, so its low tracker/cookie/fingerprint counts are an
  // artifact of the failed load, not a privacy result. Lead with that instead
  // of letting it fall through to "kept this visit relatively private".
  const loadFailureStatus = scanLoadFailureStatus(result);
  if (loadFailureStatus !== null) {
    return finish(
      "info",
      `${domain} returned an error, so there was little to scan.`,
      `The page responded with HTTP ${loadFailureStatus}, an error or block page, not the real site. The low tracker, cookie, and fingerprinting counts mean the page did not load, not that ${domain} is private. Re-scan when it is reachable.`,
      [{ label: "HTTP status", value: n(loadFailureStatus), emphasis: true }]
    );
  }

  // Confirmed input capture leads over every other story, including the
  // comparison framing. A one-way HASH of the typed value (md5/sha1/sha256)
  // cannot drive a functional type-ahead, so it is the distinctive sign of
  // deliberate identity capture and gets the alarm. Plain text or a reversible
  // encoding (base64/hex) reads as a third-party search/autocomplete and gets a
  // calmer warn, though the keystrokes still leave the site.
  const keystrokeExfil = fingerprintDetection(result, "keystroke-exfiltration");
  if (keystrokeExfil) {
    const recipientCount = plural(keystrokeExfil.evidence.recipients.length, "third party", "third parties");
    const recipients = joinNames(keystrokeExfil.evidence.recipients);
    return keystrokeLeakHashed(keystrokeExfil.evidence.encodings)
      ? finish(
          "alarm",
          `${domain} sent a hashed copy of what you type to ${recipientCount}.`,
          `A unique value typed into a form on ${domain} reached ${recipients} as a one-way hash, without the form being submitted, the pattern used to match you to a known identity. A real visitor's keystrokes could be captured the same way.`
        )
      : finish(
          "warn",
          `${domain} sends what you type to ${recipientCount} as you type.`,
          `A unique value typed into a form on ${domain} was sent to ${recipients} as it was typed, without the form being submitted, typically search or autocomplete handled by a third party, not necessarily covert capture, but your keystrokes still leave the site.`
        );
  }

  // An ad pixel that attached hashed personal identifiers (advanced matching)
  // ties this visit to a known person, a stronger story than mere presence, so
  // it outranks the platform/comparison framings below. Event-only pixels carry
  // no identifier and fall through to the named-platform line.
  const pixelsWithMatching = (result.pixelEvents ?? []).filter((pixel) => pixel.advancedMatching.length > 0);
  if (pixelsWithMatching.length > 0) {
    const products = joinNames(pixelsWithMatching.map((pixel) => pixel.product));
    const fields = joinNames(
      Array.from(new Set(pixelsWithMatching.flatMap((pixel) => pixel.advancedMatching))).map(pixelFieldLabel)
    );
    return finish(
      "warn",
      `${domain} sent personal identifiers to ${products}.`,
      `An advertising pixel on ${domain} attached hashed personal identifiers (${fields}) to the events it reported, which lets the platform tie this visit to a known person.${extraNote}`
    );
  }

  // Consent comparison: the story is what changed between the two visits.
  // Claims are gated on the reject click having really been dispatched AND on
  // the shared eligibility rule; when either fails, the report falls through to
  // the ordinary evidence-led headline instead of pretending the choice was
  // measured. The scanner clicks the control but cannot verify the site
  // accepted the choice, and recording covers the whole visit including
  // pre-click traffic, so the wording stays observational.
  if (comparisonUsable && isComparison(report) && report.comparisonType === "consent" && report.variant.consentInteraction?.clicked === true) {
    const rejectTracking = trackerEntitySummaries(report.variant).filter((entity) => !isOperationalEntity(entity));
    if (rejectTracking.length > 0) {
      return finish(
        "warn",
        `${domain} still reached ${plural(rejectTracking.length, "tracking company", "tracking companies")} in the Reject-all visit.`,
        `After the scanner clicked Reject all, ${joinNames(
          rejectTracking.map((entity) => entity.entity)
        )} still received requests during that visit. The visit records traffic from before and after the click, and some vendors may be claimed as strictly necessary; the diff lists the services that appeared only in the Accept-all visit.`
      );
    }
    if (report.baseline.consentInteraction?.clicked === true && trackingEntities.length > 0) {
      return finish(
        "info",
        `The Reject-all visit to ${domain} loaded no catalogued trackers.`,
        `The Reject-all visit loaded no catalogued tracking company, while the Accept-all visit loaded ${plural(
          trackingEntities.length,
          "tracking company",
          "tracking companies"
        )}: ${plural(report.diff.thirdPartyRequests.before, "third-party request")} became ${report.diff.thirdPartyRequests.after.toLocaleString("en-US")}.`
      );
    }
  }

  if (comparisonUsable && isComparison(report) && report.comparisonType === "gpc") {
    const before = report.diff.thirdPartyRequests.before;
    const after = report.diff.thirdPartyRequests.after;
    const reductionPct = before > 0 ? Math.round(((before - after) / before) * 100) : 0;
    // GPC "on" can load as many (or even more) off-site requests than "off",
    // so phrase the residual instead of emitting "down just -12%".
    const changePhrase =
      reductionPct > 0
        ? `down just ${reductionPct}%`
        : reductionPct < 0
          ? `${Math.abs(reductionPct)}% more than without it`
          : "with no measurable drop";

    // This claim is about the GPC-ON visit, so every number and name in it must
    // come from the variant run. The report's lead result (and its extras) is
    // the baseline run, which would mix the two arms' evidence.
    const gpcOnTracking = trackerEntitySummaries(report.variant).filter((entity) => !isOperationalEntity(entity));
    if (gpcOnTracking.length > 0 && after > 0 && reductionPct < 25) {
      return finish(
        "alarm",
        `Your privacy signal barely changed what ${domain} loaded.`,
        `Even with a "do not sell or share" (GPC) signal switched on, ${domain} still contacted ${plural(
          gpcOnTracking.length,
          "tracking company",
          "tracking companies"
        )}: ${plural(after, "third-party request")}, ${changePhrase}. Request counts cannot show whether data sales stopped, only what loaded.`
      );
    }
    if (reductionPct >= 50) {
      return finish(
        "calm",
        `Off-site requests to ${domain} dropped ${reductionPct}% with a privacy signal on.`,
        `With a Global Privacy Control signal on, off-site requests dropped ${reductionPct}% (${n(before)} → ${n(after)}). An observed difference for this pair of visits, not proof the site honors the signal.`
      );
    }
  }

  if (comparisonUsable && isComparison(report) && report.comparisonType === "shields") {
    const before = report.diff.thirdPartyRequests.before;
    const after = report.diff.thirdPartyRequests.after;
    const removed = Math.max(0, before - after);
    const total = report.diff.totalRequests.before;
    // The engine-blocked count (block simulation, variant run) and the total
    // third-party reduction are DIFFERENT measurements: blocking one script
    // also prevents its follow-on requests from ever starting, so the
    // reduction usually exceeds the direct blocks. Say both, never blend them.
    const engineBlocks = shieldsRunMeasurement(report.variant);
    if (removed > 0) {
      const engineNote =
        engineBlocks && engineBlocks.kind === "engine-blocked"
          ? ` The blocker directly stopped ${plural(engineBlocks.count, "request")}; the remaining difference may include follow-on requests that never started once their sources were blocked, plus run-to-run variance.`
          : "";
      return finish(
        removed >= 30 ? "warn" : "info",
        `${domain} loaded ${plural(removed, "fewer third-party request")} with Brave Shields on.`,
        `The visit without Brave Shields (the ad and tracker blocker built into the Brave browser) made ${plural(
          total,
          "request"
        )}; with Shields on, ${plural(removed, "third-party request")} did not load.${engineNote}${extraNote}`
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
