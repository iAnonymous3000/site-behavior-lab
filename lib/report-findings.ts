/**
 * Plain-language findings engine.
 *
 * Turns a {@link ScanReport} into the severity-ranked "findings board" cards
 * shown at the top of the report UI. This is the methodology core: it decides
 * what each card says and how loud it is, leaning on measured corpus
 * percentiles when available (see `corpus-stats.ts`) and falling back to fixed
 * reference thresholds otherwise.
 *
 * It is intentionally React-free — `icon` is a semantic key the UI maps to a
 * component — so the methodology can be unit-tested directly and reused outside
 * the client bundle. The tracker/fingerprint classification it relies on lives
 * in `report-insights.ts`, shared with the headline layer so the three cannot
 * drift.
 */

import { corpusBenchmark, corpusIsUsable, type CorpusStats } from "./corpus-stats";
import {
  HEADLINE_PLATFORMS,
  detectionEvidence,
  detectionLabel,
  fingerprintDetection,
  highEntropyDetections as highEntropyFingerprintDetections,
  isOperationalEntity,
  keystrokeLeakObfuscated,
  trackerEntitySummaries
} from "./report-insights";
import { humanList, plural } from "./text-format";
import type { ComparisonScanResult, NetworkRequestRecord, ProvenanceChange, ScanReport, ScanResult } from "./types";

export type FindingLevel = "ok" | "quiet" | "info" | "warn" | "loud";

/** Semantic icon key. The report UI maps each to a lucide component. */
export type FindingIconKey =
  | "globe"
  | "network"
  | "radar"
  | "cookie"
  | "eye"
  | "keyboard"
  | "fingerprint"
  | "shield-check"
  | "check"
  | "alert";

export type Finding = {
  id: string;
  icon: FindingIconKey;
  level: FindingLevel;
  title: string;
  lead: string;
  detail: string;
  evidence: string;
  benchmark?: string;
};

type BenchmarkMetric = "thirdPartyDomains" | "trackerEntities" | "thirdPartyCookies" | "fingerprintEvents";

/*
 * Fixed reference thresholds used as the FALLBACK severity bands. When a real
 * corpus exists (public/corpus-stats.json) and is large enough, the findings
 * rank against measured percentiles instead (see corpusBenchmark); these
 * hand-set bands only apply until the corpus passes CORPUS_MIN_SAMPLE.
 */
const FINDING_BENCHMARKS: Record<BenchmarkMetric, { label: string; elevated: number; high: number }> = {
  thirdPartyDomains: { label: "third-party domains", elevated: 15, high: 30 },
  trackerEntities: { label: "tracking services", elevated: 6, high: 12 },
  thirdPartyCookies: { label: "third-party cookies", elevated: 5, high: 12 },
  fingerprintEvents: { label: "fingerprint-like API calls", elevated: 4, high: 12 }
};

function levelForMetric(metric: BenchmarkMetric, value: number): FindingLevel {
  if (value === 0) return "ok";
  const benchmark = FINDING_BENCHMARKS[metric];
  if (value >= benchmark.high) return "loud";
  if (value >= benchmark.elevated) return "warn";
  return "info";
}

function benchmarkLabel(metric: BenchmarkMetric, value: number): string {
  const benchmark = FINDING_BENCHMARKS[metric];
  if (value === 0) return `No ${benchmark.label} observed.`;
  if (value >= benchmark.high) return `High ${benchmark.label} count (at or above the ${benchmark.high} reference threshold).`;
  if (value >= benchmark.elevated) return `Elevated ${benchmark.label} count (at or above the ${benchmark.elevated} reference threshold).`;
  return `Modest ${benchmark.label} count.`;
}

function strongestLevel(levels: FindingLevel[]): FindingLevel {
  const order: FindingLevel[] = ["ok", "quiet", "info", "warn", "loud"];
  return levels.reduce((strongest, level) => (order.indexOf(level) > order.indexOf(strongest) ? level : strongest), "ok");
}

function isComparisonReport(report: ScanReport): report is ComparisonScanResult {
  return report.reportType === "comparison";
}

// Blacklight's "GA Remarketing Audiences" signal: Google Analytics present AND the
// GA->DoubleClick sync host stats.g.doubleclick.net. Other *.g.doubleclick.net hosts
// (pubads/securepubads = publisher ads, cm = cookie matching) are NOT GA remarketing.
const GOOGLE_ANALYTICS_HOST = /(^|\.)(google-analytics\.com|googletagmanager\.com|analytics\.google\.com)$/;
const DOUBLECLICK_REMARKETING_HOST = /(^|\.)stats\.g\.doubleclick\.net$/;

export function buildFindings(report: ScanReport, result: ScanResult, corpus: CorpusStats | null): Finding[] {
  const entities = trackerEntitySummaries(result);
  const trackingEntities = entities.filter((entity) => !isOperationalEntity(entity));
  const operationalEntities = entities.filter((entity) => isOperationalEntity(entity));
  const trackingNames = trackingEntities.map((entity) => entity.entity);
  const operationalNames = operationalEntities.map((entity) => entity.entity);
  const topCategories = Array.from(new Set(trackingEntities.flatMap((entity) => entity.categories))).slice(0, 3);
  // Corpus percentiles when available + large enough; otherwise fixed thresholds.
  const domainsBenchmark = corpusBenchmark(corpus, "thirdPartyDomains", result.summary.thirdPartyDomains);
  const cookiesBenchmark = corpusBenchmark(corpus, "thirdPartyCookies", result.summary.thirdPartyCookies);
  const thirdPartyLevel = strongestLevel([
    levelForMetric("trackerEntities", trackingEntities.length),
    domainsBenchmark ? domainsBenchmark.level : levelForMetric("thirdPartyDomains", result.summary.thirdPartyDomains)
  ]);
  const findings: Finding[] = [];

  const operationalNote =
    operationalNames.length > 0
      ? ` Operational services (monitoring, support) also appeared and are not cross-site trackers: ${humanList(operationalNames)}.`
      : "";

  const sessionReplayNames = trackingEntities
    .filter((entity) => entity.categories.some((category) => category.toLowerCase().includes("session replay")))
    .map((entity) => entity.entity);
  const sessionReplayNote =
    sessionReplayNames.length > 0
      ? ` Includes session-replay vendor(s) that can record how you interact with the page: ${humanList(sessionReplayNames)}.`
      : "";

  const headlineEntities = entities.filter((entity) => HEADLINE_PLATFORMS.includes(entity.entity));
  const headlineNames = headlineEntities.map((entity) => entity.entity);
  const headlineRequests = headlineEntities.reduce((total, entity) => total + entity.requests, 0);
  const provenanceHighlights = requestProvenanceHighlights(result);
  const requestsWithProvenance = result.requests.filter((request) => request.provenance).length;

  const googleAnalyticsPresent = result.domains.some((domain) => GOOGLE_ANALYTICS_HOST.test(domain.domain));
  const gaRemarketingOn =
    googleAnalyticsPresent && result.domains.some((domain) => DOUBLECLICK_REMARKETING_HOST.test(domain.domain));

  const keystrokeDetection = fingerprintDetection(result, "keystroke-exfiltration");
  if (keystrokeDetection) {
    const recipients = humanList(keystrokeDetection.evidence.recipients);
    const recipientCount = plural(keystrokeDetection.evidence.recipients.length, "third party", "third parties");
    const fields = plural(keystrokeDetection.evidence.fieldsTyped, "form field");
    // Plain-text leaks read as functional type-ahead/autocomplete; transformed
    // (base64/hex/hashed) ones are more consistent with deliberate capture, so
    // only those earn the loud alarm.
    const obfuscated = keystrokeLeakObfuscated(keystrokeDetection.evidence.encodings);
    findings.push({
      id: "keystroke-exfiltration",
      icon: "keyboard",
      level: obfuscated ? "loud" : "warn",
      title: obfuscated
        ? `What you type was sent to ${recipientCount}`
        : `Your typing is sent to ${recipientCount} as you go`,
      lead: obfuscated
        ? `When the scanner typed a unique test value into ${fields}, that value reached ${recipients} — transformed (${humanList(keystrokeDetection.evidence.encodings)}) and without the form ever being submitted.`
        : `When the scanner typed a unique test value into ${fields}, that value was sent in plain text to ${recipients} as it was typed, without the form being submitted — typically search type-ahead or autocomplete handled by a third party.`,
      detail: obfuscated
        ? `The typed value was transformed (${humanList(
            keystrokeDetection.evidence.encodings
          )}) before being sent, which is more consistent with deliberate input capture than a visible API call. A real visitor's keystrokes could be captured the same way. The scanner types only synthetic values and never submits the form.`
        : `The value was sent in plain text, consistent with a functional type-ahead or autocomplete (a search or location lookup) handled by a third party — still worth knowing your keystrokes leave to ${recipients}, but not on its own evidence of covert capture. The scanner types only synthetic values and never submits the form.`,
      evidence: `Test value reached ${recipients} via ${humanList(keystrokeDetection.evidence.encodings)}.`
    });
  }

  findings.push({
    id: "third-party-services",
    icon: "globe",
    level: trackingEntities.length > 0 ? thirdPartyLevel : "ok",
    title:
      trackingEntities.length > 0
        ? "Tracking and ad services saw this visit"
        : operationalEntities.length > 0
          ? "Only operational services matched"
          : "No known services matched",
    lead:
      trackingEntities.length > 0
        ? `${humanList(trackingNames)} appeared in the request log.`
        : operationalEntities.length > 0
          ? `Only operational tools matched the catalog: ${humanList(operationalNames)}.`
          : "This scan did not match any third-party domains to the service catalog.",
    detail:
      trackingEntities.length > 0
        ? `These services can profile visitors across sites.${topCategories.length > 0 ? ` Observed categories include ${humanList(topCategories)}.` : ""}${sessionReplayNote}${operationalNote}`
        : operationalEntities.length > 0
          ? "These are monitoring or support tools, not cross-site trackers. Unlabeled third parties may still be present."
          : "There may still be unlabeled third parties, but no known catalog entity was matched.",
    evidence: `${plural(result.summary.thirdPartyRequests, "third-party request")} across ${plural(result.summary.thirdPartyDomains, "third-party domain")}.`,
    benchmark: domainsBenchmark
      ? domainsBenchmark.label
      : trackingEntities.length > 0
        ? benchmarkLabel("trackerEntities", trackingEntities.length)
        : benchmarkLabel("thirdPartyDomains", result.summary.thirdPartyDomains)
  });

  findings.push({
    id: "named-platforms",
    icon: "network",
    level: headlineNames.length === 0 ? "ok" : headlineNames.length >= 3 ? "warn" : "info",
    title: headlineNames.length > 0 ? "Data reached major platforms" : "No major platforms received data",
    lead:
      headlineNames.length > 0
        ? `This visit sent requests to ${humanList(headlineNames)}.`
        : "No requests to Google, Meta, TikTok, or X were observed in this visit.",
    detail:
      headlineNames.length > 0
        ? "These platforms can link this visit to the profile they already hold about you from other sites and apps."
        : "Major ad-platform pixels were not observed in this single passive visit; interaction-gated pixels could still load for real users.",
    evidence:
      headlineNames.length > 0
        ? `${plural(headlineRequests, "request")} to these platforms.`
        : `${plural(result.summary.thirdPartyDomains, "third-party domain")} seen overall.`
  });

  if (result.conditions.automation === "brave-pagegraph") {
    findings.push({
      id: "pagegraph-provenance",
      icon: "network",
      level: provenanceHighlights.length > 0 ? "info" : "quiet",
      title: provenanceHighlights.length > 0 ? "PageGraph causality is attached" : "PageGraph causality was not supplied",
      lead:
        provenanceHighlights.length > 0
          ? `${plural(requestsWithProvenance, "request")} include initiator or script provenance.`
          : "This PageGraph-derived report did not include request initiator metadata.",
      detail:
        provenanceHighlights.length > 0
          ? `Examples: ${humanList(provenanceHighlights, 3)}.`
          : "Counts and domains still describe observed traffic, but this artifact cannot explain which script caused each request.",
      evidence:
        provenanceHighlights.length > 0
          ? "The request log preserves redacted actor URLs and domains when PageGraph provides them."
          : "Ask the PageGraph export pipeline for source, initiator, script, or injector fields before treating this as causal evidence."
    });
  }

  findings.push({
    id: "ga-remarketing",
    icon: "radar",
    level: gaRemarketingOn ? "warn" : "ok",
    title: gaRemarketingOn
      ? "Google Analytics remarketing signal detected"
      : googleAnalyticsPresent
        ? "Google Analytics present, no remarketing signal"
        : "No Google Analytics observed",
    lead: gaRemarketingOn
      ? "Google Analytics fired a sync to stats.g.doubleclick.net — the request Blacklight treats as the marker that advertising and remarketing features are on."
      : googleAnalyticsPresent
        ? "Google Analytics was observed, but no DoubleClick remarketing sync appeared in this visit."
        : "This visit did not contact Google Analytics.",
    detail: gaRemarketingOn
      ? "If remarketing is on, this visit can be added to Google advertising audiences and matched to the profile Google already holds about you across sites. The DoubleClick sync is a strong signal, not configuration-level proof."
      : googleAnalyticsPresent
        ? "Standard analytics collection was observed, without the stats.g.doubleclick.net advertising sync."
        : "Neither Google Analytics nor its remarketing sync was observed in this visit.",
    evidence: gaRemarketingOn
      ? "Google Analytics host plus a request to stats.g.doubleclick.net (Blacklight's remarketing marker)."
      : googleAnalyticsPresent
        ? "Google Analytics host observed; no stats.g.doubleclick.net request."
        : "No google-analytics.com or googletagmanager.com requests."
  });

  findings.push({
    id: "third-party-cookies",
    icon: "cookie",
    level: cookiesBenchmark ? cookiesBenchmark.level : levelForMetric("thirdPartyCookies", result.summary.thirdPartyCookies),
    title: result.summary.thirdPartyCookies > 0 ? "Third-party cookies were present" : "No third-party cookies observed",
    lead:
      result.summary.thirdPartyCookies > 0
        ? `${plural(result.summary.thirdPartyCookies, "third-party cookie")} showed up during the visit.`
        : "The automated visit did not observe third-party cookies.",
    detail:
      result.summary.thirdPartyCookies > 0
        ? "Third-party cookies can help outside services recognize repeat visits across sites when the browser allows them."
        : "This does not prove the site never uses cookies; it means this visit did not observe third-party cookies.",
    evidence: `${plural(result.summary.cookies, "cookie")} total in this report.`,
    benchmark: cookiesBenchmark ? cookiesBenchmark.label : benchmarkLabel("thirdPartyCookies", result.summary.thirdPartyCookies)
  });

  const sessionRecordingDetection = fingerprintDetection(result, "session-recording");
  const inputMonitoringDetection = fingerprintDetection(result, "input-monitoring");
  if (sessionRecordingDetection || inputMonitoringDetection || sessionReplayNames.length > 0) {
    const behaviorNotes = [
      sessionRecordingDetection
        ? `${plural(sessionRecordingDetection.evidence.totalListenerCalls, "third-party interaction listener")} from ${humanList(sessionRecordingDetection.evidence.thirdPartyOrigins)}`
        : "",
      inputMonitoringDetection
        ? `${plural(inputMonitoringDetection.evidence.totalListenerCalls, "third-party input listener")} from ${humanList(inputMonitoringDetection.evidence.thirdPartyOrigins)}`
        : "",
      sessionReplayNames.length > 0 ? `known session-replay vendor(s): ${humanList(sessionReplayNames)}` : ""
    ].filter(Boolean);
    const replayCorroborated = Boolean(sessionRecordingDetection && sessionReplayNames.length > 0);

    findings.push({
      id: "session-recording-input-monitoring",
      icon: "eye",
      level: replayCorroborated ? "warn" : "info",
      title: inputMonitoringDetection
        ? "Third-party input monitoring signal matched"
        : replayCorroborated
          ? "Session-recording signal matched a known vendor"
          : sessionRecordingDetection
            ? "Third-party interaction monitoring signal matched"
            : "Session-replay vendor observed",
      lead: inputMonitoringDetection
        ? "A third-party script registered listener coverage that could observe typing-related input events."
        : replayCorroborated
          ? "The page registered broad third-party interaction listeners and contacted a known session-replay service."
          : sessionRecordingDetection
            ? "A third-party script registered broad mouse, scroll, visibility, and input listener coverage during the visit."
            : `${humanList(sessionReplayNames)} appeared in the request log.`,
      detail:
        "This is a behavioral instrumentation signal from listener registration, stack-attributed script origins, and known-vendor requests. The scanner does not type into fields and does not collect typed values, so treat it as a review prompt rather than proof that form contents were transmitted.",
      evidence: humanList(behaviorNotes, 4)
    });
  }

  const highEntropyDetections = highEntropyFingerprintDetections(result);
  const highEntropyDetectionLabels = highEntropyDetections.map(detectionLabel);
  const topFingerprintApis = result.fingerprintEvents.slice(0, 3).map((event) => event.api);
  findings.push({
    id: "fingerprint-apis",
    icon: "fingerprint",
    level: highEntropyDetections.length > 0 ? "warn" : result.summary.fingerprintEvents > 0 ? "info" : "ok",
    title:
      highEntropyDetections.length > 0
        ? highEntropyDetections.length === 1
          ? `${highEntropyDetectionLabels[0]} matched`
          : "Behavioral fingerprinting heuristics matched"
        : result.summary.fingerprintEvents > 0
          ? "Fingerprint-like browser APIs were called"
          : "No fingerprint-like API calls observed",
    lead:
      highEntropyDetections.length > 0
        ? `${plural(highEntropyDetections.length, "behavioral heuristic")} matched: ${humanList(highEntropyDetectionLabels, 5)}.`
        : result.summary.fingerprintEvents > 0
          ? `${plural(result.summary.fingerprintEvents, "high-entropy API call")} appeared in the instrumentation log.`
          : "The scan did not observe the instrumented high-entropy browser APIs.",
    detail:
      highEntropyDetections.length > 0
        ? "These heuristics look for behavior patterns such as canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, or WebRTC peer-connection setup. They are review prompts for this visit, not proof of cross-site identity tracking."
        : result.summary.fingerprintEvents > 0
          ? `These calls can be legitimate (charts, graphics, media), so the count is observational, not a severity score, and it excludes Web and Service Workers. Top calls: ${humanList(topFingerprintApis)}.`
          : "This is an observation layer, not proof that fingerprinting is impossible.",
    evidence:
      highEntropyDetections.length > 0
        ? humanList(highEntropyDetections.map(detectionEvidence), 4)
        : `${plural(result.fingerprintEvents.length, "API family", "API families")} recorded.`
  });

  if (isComparisonReport(report) && report.comparisonType === "shields") {
    const removedThirdPartyRequests = Math.max(0, -report.diff.thirdPartyRequests.delta);
    const removedTrackerRequests = Math.max(0, -report.diff.knownTrackerRequests.delta);
    const removedCookies = Math.max(0, -report.diff.thirdPartyCookies.delta);
    const removedFingerprintEvents = Math.max(0, -report.diff.fingerprintEvents.delta);
    const removedEntityNames = report.diff.removedEntities.map((entity) => entity.entity);
    const blockedTotal = removedThirdPartyRequests + removedTrackerRequests + removedCookies + removedFingerprintEvents;

    findings.unshift({
      id: "shields-comparison",
      icon: "shield-check",
      level: blockedTotal > 0 ? "ok" : "quiet",
      title: blockedTotal > 0 ? "Fewer tracking signals observed with Shields on" : "No reduction observed with Shields on",
      lead:
        blockedTotal > 0
          ? `Shields on showed ${removedThirdPartyRequests.toLocaleString("en-US")} fewer third-party and ${removedTrackerRequests.toLocaleString("en-US")} fewer known-service requests in this single paired visit.`
          : "The Shields-on run did not show fewer third-party requests, known-service requests, cookies, or fingerprint-like calls.",
      detail: `${
        removedEntityNames.length > 0 ? `Services only seen with Shields off: ${humanList(removedEntityNames)}. ` : ""
      }A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments), so treat this as an observed difference, not a measured blocking rate.`,
      evidence: `${removedCookies.toLocaleString("en-US")} fewer third-party cookies and ${removedFingerprintEvents.toLocaleString("en-US")} fewer fingerprint-like calls with Shields on.`
    });
  }

  const overallLevel = strongestLevel(findings.map((finding) => finding.level));
  findings.unshift({
    id: "bottom-line",
    icon: overallLevel === "ok" ? "check" : "alert",
    level: overallLevel,
    title: overallLevel === "ok" ? "Bottom line: few review signals in this visit" : "Bottom line: this visit has review-worthy signals",
    lead:
      overallLevel === "ok"
        ? "The automated visit did not observe known third-party services, third-party cookies, or instrumented fingerprint-like calls."
        : "The scan observed signals a non-expert should not have to decode from raw request tables.",
    detail: corpusIsUsable(corpus)
      ? `The cards below translate the evidence into plain language. Where a measured distribution exists, severity ranks this visit against percentiles from the ${corpus.sampleSize.toLocaleString("en-US")} sites scanned so far — a curated set of popular, mostly commercial sites, not a random sample of the web — and otherwise uses fixed reference thresholds. The request log, domain table, and methodology remain below for verification.`
      : "The cards below translate the evidence into plain language; severity reflects fixed reference thresholds, not measured population percentiles. The request log, domain table, and methodology remain below for verification.",
    evidence: `${plural(result.summary.totalRequests, "request")} observed in one controlled visit.`
  });

  if (result.conditions.adblock?.active) {
    const blocked = result.summary.shieldsBlockedRequests ?? 0;
    findings.splice(1, 0, {
      id: "shields-blocked",
      icon: "shield-check",
      level: blocked === 0 ? "ok" : blocked >= 10 ? "warn" : "info",
      title:
        blocked > 0
          ? `Brave Shields would block ${blocked.toLocaleString("en-US")} of ${result.summary.totalRequests.toLocaleString("en-US")} requests`
          : "Brave Shields would block nothing on this page",
      lead:
        blocked > 0
          ? `${plural(blocked, "request")} matched Brave's default ad-block and tracking lists.`
          : "No requests matched Brave's default ad-block and tracking lists in this visit.",
      detail:
        blocked > 0
          ? "Computed with Brave's own ad-block engine and default filter lists — network requests only, so no cosmetic or CNAME-based blocking — which reflects Brave's real blocking, not just the named-service catalog. The rest loaded normally."
          : "The page's requests did not match Brave's default lists in this visit.",
      evidence: `${plural(result.summary.knownTrackerRequests, "named-service request")} of them are also in the curated catalog.`
    });
  }

  // Emit every finding. The conditionals above bound this to at most ~9 cards,
  // all of them meaningful; a fixed cap here silently dropped the last-pushed
  // card (the fingerprinting finding) on Node Shields-comparison reports that
  // also surfaced a session-recording or input-monitoring signal.
  return findings;
}

function requestProvenanceHighlights(result: ScanResult): string[] {
  const seen = new Set<string>();
  const highlights: string[] = [];

  for (const request of result.requests) {
    if (!request.thirdParty || !request.provenance) continue;
    const summary = requestProvenanceSummary(request);
    if (!summary) continue;
    const label = `${request.domain}: ${summary.primary}${summary.secondary ? ` (${summary.secondary})` : ""}`;
    if (seen.has(label)) continue;
    seen.add(label);
    highlights.push(label);
    if (highlights.length >= 5) break;
  }

  return highlights;
}

export function requestProvenanceSummary(request: NetworkRequestRecord): { primary: string; secondary?: string } | null {
  const provenance = request.provenance;
  if (!provenance) return null;

  const script = provenanceActorDisplay(provenance.scriptDomain, provenance.scriptUrl, "script");
  const initiator = provenanceActorDisplay(provenance.initiatorDomain, provenance.initiatorUrl, provenance.initiatorType);
  const injectedBy = provenanceActorDisplay(provenance.injectedByDomain, provenance.injectedByUrl);

  if (script) {
    return {
      primary: `script ${script}`,
      secondary: injectedBy ? `injected by ${injectedBy}` : initiator && initiator !== script ? `initiated by ${initiator}` : undefined
    };
  }
  if (initiator) return { primary: `initiated by ${initiator}`, secondary: injectedBy ? `injected by ${injectedBy}` : undefined };
  if (injectedBy) return { primary: `injected by ${injectedBy}` };
  return null;
}

export function requestProvenanceSearchText(request: NetworkRequestRecord): string {
  const summary = requestProvenanceSummary(request);
  return summary ? `${summary.primary} ${summary.secondary ?? ""}` : "";
}

export function provenanceChangeText(change: ProvenanceChange): string {
  const parts = [
    change.script ? `script ${change.script}` : "",
    change.initiator ? `initiator ${change.initiator}` : "",
    change.injectedBy ? `injected by ${change.injectedBy}` : "",
    change.tracker ? `${change.tracker.entity} · ${change.tracker.category}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? humanList(parts, 3) : "provenance supplied";
}

function provenanceActorDisplay(domain: string | undefined, url: string | undefined, type?: string): string | null {
  const actor = domain || url;
  if (!actor) return null;
  const normalizedType = type?.trim().toLowerCase();
  if (!normalizedType || normalizedType === "script" || normalizedType === "unknown") return actor;
  return `${normalizedType} ${actor}`;
}
