/**
 * Plain-language findings engine.
 *
 * Turns a {@link ReportView} into the severity-ranked "findings board" cards
 * shown at the top of the report UI. This is the methodology core: it decides
 * what each card says and how loud it is, leaning on measured corpus
 * percentiles when available (see `corpus-stats.ts`) and falling back to fixed
 * reference thresholds otherwise.
 *
 * It consumes the version-independent view seam, never a wire shape: every
 * comparison number derives from the two arms' run views (the same counts the
 * v1 wire's diff was computed from), and every comparison card is gated on
 * `view.claims` (default-deny), so the board can never disagree with the
 * headline or the comparison panel's banner.
 *
 * It is intentionally React-free, `icon` is a semantic key the UI maps to a
 * component, so the methodology can be unit-tested directly and reused outside
 * the client bundle. The tracker/fingerprint classification it relies on lives
 * in `report-insights.ts`, shared with the headline layer so the three cannot
 * drift.
 */

import { detectConsentPlatform } from "./consent-banner";
import { corpusBenchmark, corpusIsUsable, type CorpusStats } from "./corpus-stats";
import {
  HEADLINE_PLATFORMS,
  crossSiteListenerDetection,
  detectionEvidence,
  detectionLabel,
  fingerprintDetection,
  highEntropyDetections as highEntropyFingerprintDetections,
  isOperationalEntity,
  keystrokeLeakHashed,
  pixelEventEvidence,
  pixelEventSummaries,
  pixelFieldLabel,
  scanLoadFailureStatus,
  shieldsRunMeasurement,
  trackerEntitySummaries
} from "./report-insights";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  runCensorshipNotes,
  type ClaimGate,
  type ReportView,
  type RunView
} from "./scan-report-views";
import { humanList, plural } from "./text-format";
import type { NetworkRequestRecord, PrivacyPolicyClaimKind, ProvenanceChange } from "./types";

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
  | "alert"
  | "file-text";

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

// Blacklight's "GA Remarketing Audiences" signal: Google Analytics present AND the
// GA->DoubleClick sync host stats.g.doubleclick.net. Other *.g.doubleclick.net hosts
// (pubads/securepubads = publisher ads, cm = cookie matching) are NOT GA remarketing.
const GOOGLE_ANALYTICS_HOST = /(^|\.)(google-analytics\.com|googletagmanager\.com|analytics\.google\.com)$/;
const DOUBLECLICK_REMARKETING_HOST = /(^|\.)stats\.g\.doubleclick\.net$/;

/** Appended to any absence claim whose evidence family was censored. */
const CENSORED_ABSENCE_NOTE = " Evidence collection was cut short, so this covers only what was recorded before the cutoff.";

export function buildFindings(view: ReportView, corpusInput: CorpusStats | null): Finding[] {
  // Benchmark cohort = same methodology generation: the published corpus
  // distributions are built from v1 reports only, so a v2 view is never
  // ranked against them and falls back to the fixed reference thresholds
  // until a matching-methodology cohort exists.
  const corpus = view.origin === "legacy-derived" ? corpusInput : null;
  const run = displayRunView(view);
  const arms = comparisonArmViews(view);
  const axis = view.comparison?.axis ?? null;
  const entities = trackerEntitySummaries(run.evidence);
  const trackingEntities = entities.filter((entity) => !isOperationalEntity(entity));
  const operationalEntities = entities.filter((entity) => isOperationalEntity(entity));
  const trackingNames = trackingEntities.map((entity) => entity.entity);
  const operationalNames = operationalEntities.map((entity) => entity.entity);
  const topCategories = Array.from(new Set(trackingEntities.flatMap((entity) => entity.categories))).slice(0, 3);
  // Corpus percentiles when available + large enough; otherwise fixed thresholds.
  const domainsBenchmark = corpusBenchmark(corpus, "thirdPartyDomains", run.counts.thirdPartyDomains);
  const cookiesBenchmark = corpusBenchmark(corpus, "thirdPartyCookies", run.counts.thirdPartyCookies);
  const thirdPartyLevel = strongestLevel([
    levelForMetric("trackerEntities", trackingEntities.length),
    domainsBenchmark ? domainsBenchmark.level : levelForMetric("thirdPartyDomains", run.counts.thirdPartyDomains)
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
  const provenanceHighlights = requestProvenanceHighlights(run.evidence.requests);
  const requestsWithProvenance = run.evidence.requests.filter((request) => request.provenance).length;

  const googleAnalyticsPresent = run.evidence.domains.some((domain) => GOOGLE_ANALYTICS_HOST.test(domain.domain));
  const gaRemarketingOn =
    googleAnalyticsPresent && run.evidence.domains.some((domain) => DOUBLECLICK_REMARKETING_HOST.test(domain.domain));

  // An ABSENCE claim over a censored evidence family cannot reassure: nothing
  // proves the absence held after collection stopped, so those cards hedge
  // and drop to "info" instead of "ok".
  const requestsCensored = familyCensoredOnRun(run, "requests");
  const cookiesCensored = familyCensoredOnRun(run, "cookies");
  // Raw fingerprint events live in the "fingerprinting" evidence family;
  // detector conclusions live in "detector-output". The absence card covers
  // both, so censoring in either hedges it.
  const detectorCensored = familyCensoredOnRun(run, "detector-output") || familyCensoredOnRun(run, "fingerprinting");

  const keystrokeDetection = fingerprintDetection(run.evidence, "keystroke-exfiltration");
  if (keystrokeDetection) {
    const recipients = humanList(keystrokeDetection.evidence.recipients);
    const recipientCount = plural(keystrokeDetection.evidence.recipients.length, "third party", "third parties");
    const fields = plural(keystrokeDetection.evidence.fieldsTyped, "form field");
    // A one-way HASH of the typed value (md5/sha1/sha256) cannot drive a
    // functional type-ahead, so it is the distinctive sign of deliberate
    // identity capture and earns the loud alarm. Plain text or a reversible
    // encoding (base64/hex) reads as a third-party search/autocomplete and stays
    // a calmer warn, though the keystrokes still leave the site.
    const hashed = keystrokeLeakHashed(keystrokeDetection.evidence.encodings);
    findings.push({
      id: "keystroke-exfiltration",
      icon: "keyboard",
      level: hashed ? "loud" : "warn",
      title: hashed
        ? `What you type was sent to ${recipientCount} as a hash`
        : `Your typing is sent to ${recipientCount} as you go`,
      lead: hashed
        ? `When the scanner typed a unique test value into ${fields}, that value reached ${recipients} as a one-way hash (${humanList(keystrokeDetection.evidence.encodings)}) and without the form ever being submitted.`
        : `When the scanner typed a unique test value into ${fields}, that value was sent to ${recipients} as it was typed (${humanList(keystrokeDetection.evidence.encodings)}), without the form ever being submitted, typically search type-ahead or autocomplete handled by a third party.`,
      detail: hashed
        ? `The typed value was hashed (${humanList(
            keystrokeDetection.evidence.encodings
          )}) before being sent. A hash cannot drive a functional type-ahead, so this is the pattern used to match you to a known identity, not a visible API call. A real visitor's keystrokes could be captured the same way. The scanner types only synthetic values and never submits the form.`
        : `The value was sent in a recoverable form (${humanList(
            keystrokeDetection.evidence.encodings
          )}), consistent with a functional type-ahead or autocomplete (a search or location lookup) handled by a third party. Still worth knowing your keystrokes leave to ${recipients}, but not on its own evidence of covert capture. The scanner types only synthetic values and never submits the form.`,
      evidence: `Test value reached ${recipients} via ${humanList(keystrokeDetection.evidence.encodings)}.`
    });
  }

  const cnameCloaks = run.evidence.cnameCloaks;
  if (cnameCloaks.length > 0) {
    const vendors = humanList(Array.from(new Set(cnameCloaks.map((cloak) => cloak.tracker.entity))));
    findings.push({
      id: "cname-cloaking",
      icon: "radar",
      level: "warn",
      title: `${plural(cnameCloaks.length, "tracker")} hidden behind a first-party subdomain`,
      lead: `${humanList(cnameCloaks.map((cloak) => cloak.host))} look like part of ${
        run.domain
      }, but DNS shows ${cnameCloaks.length === 1 ? "it is" : "they are"} actually ${vendors} (CNAME cloaking).`,
      detail:
        "CNAME cloaking disguises a third-party tracker as a first-party subdomain, so it slips past request-URL matching (this scanner's default, and Blacklight's) and many third-party-cookie protections. Found by following each first-party subdomain's DNS CNAME chain to a known tracking service.",
      evidence: humanList(
        cnameCloaks.map((cloak) => `${cloak.host} → ${cloak.cname} (${cloak.tracker.entity})`),
        4
      )
    });
  }

  // The pre-consent framing ("the scanner never clicks the banner") only holds
  // for observe-mode runs. Consent-comparison runs clicked a choice, and their
  // story is carried by the dedicated consent-comparison card below instead.
  const consentPlatform = run.conditions.consentMode === "observe" ? detectConsentPlatform(run.evidence.domains) : null;
  if (consentPlatform) {
    const preConsentTrackers = trackingEntities.length;
    findings.push({
      id: "consent-banner",
      icon: "cookie",
      level: preConsentTrackers > 0 ? "warn" : "info",
      title:
        preConsentTrackers > 0
          ? "Consent management loaded, but trackers had already loaded too"
          : "A consent management platform loaded",
      lead:
        preConsentTrackers > 0
          ? `${run.domain} loaded ${consentPlatform.name}, a consent management platform (the tooling that shows cookie banners), yet ${plural(
              preConsentTrackers,
              "tracking company",
              "tracking companies"
            )} already loaded before any consent was given.`
          : `${run.domain} loaded ${consentPlatform.name}, a consent management platform (the tooling that shows cookie banners); no catalogued tracking company loaded before consent in this visit.`,
      detail:
        'A request to the platform\'s loader proves the consent tooling loaded, not that a banner was visibly shown to this scanner (many banners appear only in regions where the law requires them). The scanner never clicks a banner in this mode, so this is the pre-consent state: loading trackers before the visitor accepts is often not permitted under GDPR/ePrivacy, and more trackers can load after "Accept" that this report does not capture. Tracker counts here are a lower bound for users who consent.',
      evidence: `Consent platform detected via a request to ${consentPlatform.domain}.`
    });
  }

  const policy = run.evidence.privacyPolicy;
  if (policy) {
    // Each entry pairs a testable statement from the policy with the observed
    // evidence that cuts against it. Quotes come along so a reader can check
    // the sentence in context; this is a text match, never a legal reading.
    const conflicts: string[] = [];
    const quotes: string[] = [];
    const policyClaim = (kind: PrivacyPolicyClaimKind) => policy.claims.find((claim) => claim.kind === kind);

    const noThirdPartyCookies = policyClaim("no-third-party-cookies");
    if (noThirdPartyCookies && run.counts.thirdPartyCookies > 0) {
      conflicts.push(
        `the policy says third-party cookies are not used, but ${plural(run.counts.thirdPartyCookies, "third-party cookie")} appeared in this visit`
      );
      quotes.push(noThirdPartyCookies.quote);
    }

    const noCookies = policyClaim("no-cookies");
    if (noCookies && run.counts.cookies > 0) {
      conflicts.push(`the policy says cookies are not used, but ${plural(run.counts.cookies, "cookie")} appeared in this visit`);
      quotes.push(noCookies.quote);
    }

    // Field POPULATION is what the scanner proves; the values are never
    // read, so this observation is CONDITIONAL and must never headline as a
    // definite contradiction the way the count-based checks above may.
    const conditionalConflicts: string[] = [];
    const noSelling = policyClaim("no-selling-or-sharing");
    const pixelsWithIdentifiers = pixelEventSummaries(run.evidence).filter((pixel) => pixel.advancedMatching.length > 0);
    if (noSelling && pixelsWithIdentifiers.length > 0) {
      conditionalConflicts.push(
        `the policy says personal information is not sold, and advertising events to ${humanList(
          pixelsWithIdentifiers.map((pixel) => pixel.product)
        )} carried populated personal-identifier fields in this visit; IF those fields held real visitor data, many regulators treat that as sharing, but the scanner never reads the values`
      );
      quotes.push(noSelling.quote);
    }

    // Deliberately NOT checked as a conflict: an "honors GPC" claim. Honoring
    // GPC means not selling or sharing data, which request counts cannot
    // observe; a site can honor the signal while loading identical requests.
    // The claim stays in the stored policy summary, but no request-count
    // comparison is allowed to contradict it.

    const namedCount = policy.mentionedEntities.length;
    const totalObserved = namedCount + policy.unmentionedEntities.length;
    const coverage =
      totalObserved > 0
        ? `${namedCount} of ${plural(totalObserved, "observed tracking company", "observed tracking companies")} named in the policy`
        : "no catalogued tracking companies observed to check against it";

    // A "nothing contradicted" reassurance is itself an absence claim over
    // the checked evidence, so censored collection hedges it.
    const policyEvidenceCensored = requestsCensored || cookiesCensored || detectorCensored;
    findings.push({
      id: "privacy-policy",
      icon: "file-text",
      level:
        conflicts.length > 0
          ? "warn"
          : conditionalConflicts.length > 0 || policy.unmentionedEntities.length > 0
            ? "info"
            : policyEvidenceCensored
              ? "info"
              : "ok",
      title:
        conflicts.length > 0
          ? "The privacy policy says one thing; this visit shows another"
          : conditionalConflicts.length > 0
            ? "A policy statement may conflict with observed advertising events"
            : policy.unmentionedEntities.length > 0
              ? "Tracking companies the privacy policy never names"
              : "Privacy policy read; no checked statement contradicted",
      lead:
        conflicts.length > 0
          ? `Comparing the site's own privacy policy against this visit: ${humanList(conflicts, 3)}.`
          : conditionalConflicts.length > 0
            ? `Comparing the site's own privacy policy against this visit: ${humanList(conditionalConflicts, 2)}.`
            : policy.unmentionedEntities.length > 0
              ? `${humanList(policy.unmentionedEntities)} received requests during this visit but ${policy.unmentionedEntities.length === 1 ? "is" : "are"} never named in the privacy policy text.`
              : `The policy's checkable statements did not contradict this visit's evidence (${coverage}).`,
      detail:
        conflicts.length > 0 || conditionalConflicts.length > 0
          ? `Matched policy wording: ${quotes.map((quote) => `"${quote}"`).join(" / ")}. This is an automated sentence match against the policy's own text, quoted so it can be verified in context. Policies can define terms narrowly (such as what counts as selling), so treat this as a documented discrepancy to review, not a legal conclusion.`
          : policy.unmentionedEntities.length > 0
            ? `Policies often disclose vendor categories rather than company names, so an unnamed vendor is a transparency gap worth reviewing, not automatically a violation.${namedCount > 0 ? ` Named in the policy: ${humanList(policy.mentionedEntities)}.` : ""}`
            : `Statements checked automatically: blanket no-cookie claims, third-party-cookie claims, and do-not-sell claims against advertising-pixel identifier fields. Global Privacy Control claims are never checked against request counts, which cannot show whether data sales stopped.${policyEvidenceCensored ? CENSORED_ABSENCE_NOTE : ""}`,
      evidence: `Policy at ${policy.url}; ${plural(policy.claims.length, "checkable statement")} matched; ${coverage}.`
    });
  }

  findings.push({
    id: "third-party-services",
    icon: "globe",
    level: trackingEntities.length > 0 ? thirdPartyLevel : requestsCensored ? "info" : "ok",
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
          ? `These are monitoring or support tools, not cross-site trackers. Unlabeled third parties may still be present.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
          : `There may still be unlabeled third parties, but no known catalog entity was matched.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence: `${plural(run.counts.thirdPartyRequests, "third-party request")} across ${plural(run.counts.thirdPartyDomains, "third-party domain")}.`,
    benchmark: domainsBenchmark
      ? domainsBenchmark.label
      : trackingEntities.length > 0
        ? benchmarkLabel("trackerEntities", trackingEntities.length)
        : benchmarkLabel("thirdPartyDomains", run.counts.thirdPartyDomains)
  });

  findings.push({
    id: "named-platforms",
    icon: "network",
    level: headlineNames.length === 0 ? (requestsCensored ? "info" : "ok") : headlineNames.length >= 3 ? "warn" : "info",
    title: headlineNames.length > 0 ? "Data reached major platforms" : "No major platforms received data",
    lead:
      headlineNames.length > 0
        ? `This visit sent requests to ${humanList(headlineNames)}.`
        : "No requests to Google, Meta, TikTok, or X were observed in this visit.",
    detail:
      headlineNames.length > 0
        ? "These platforms can link this visit to the profile they already hold about you from other sites and apps."
        : `Major ad-platform pixels were not observed in this single passive visit; interaction-gated pixels could still load for real users.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence:
      headlineNames.length > 0
        ? `${plural(headlineRequests, "request")} to these platforms.`
        : `${plural(run.counts.thirdPartyDomains, "third-party domain")} seen overall.`
  });

  const pixelEvents = pixelEventSummaries(run.evidence);
  if (pixelEvents.length > 0) {
    const pixelsWithMatching = pixelEvents.filter((pixel) => pixel.advancedMatching.length > 0);
    const matchingFields = Array.from(new Set(pixelsWithMatching.flatMap((pixel) => pixel.advancedMatching))).map(pixelFieldLabel);
    findings.push({
      id: "pixel-events",
      icon: "radar",
      level: pixelsWithMatching.length > 0 ? "warn" : "info",
      title:
        pixelsWithMatching.length > 0
          ? "Advertising pixels carried populated identifier fields"
          : "Advertising pixels reported specific events",
      lead:
        pixelsWithMatching.length > 0
          ? `${humanList(pixelsWithMatching.map((pixel) => pixel.product))} attached populated personal-identifier fields (${humanList(
              matchingFields
            )}) to the events fired in this visit.`
          : `${humanList(pixelEvents.map((pixel) => pixel.product))} reported specific named events, not just their presence, during this visit.`,
      detail:
        pixelsWithMatching.length > 0
          ? "Beyond detecting that a pixel is present, this reads each pixel request's event type and whether its advanced-matching parameters held values. These are the fields the platforms document as carrying hashed emails or phone numbers so events can be matched to a known person; the scanner records only which fields were populated, never their values, so neither the contents nor the hashing is verified."
          : "This reads each pixel request's event type (such as PageView, ViewContent, or Purchase), not just that the pixel loaded. No advanced-matching identifier fields were observed in this passive visit; interaction-gated events could still carry them for real users.",
      evidence: humanList(pixelEvents.map(pixelEventEvidence), 4)
    });
  }

  if (run.conditions.automation === "brave-pagegraph") {
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
    level: gaRemarketingOn ? "warn" : requestsCensored ? "info" : "ok",
    title: gaRemarketingOn
      ? "Google Analytics remarketing signal detected"
      : googleAnalyticsPresent
        ? "Google Analytics present, no remarketing signal"
        : "No Google Analytics observed",
    lead: gaRemarketingOn
      ? "Google Analytics fired a sync to stats.g.doubleclick.net, the request Blacklight treats as the marker that advertising and remarketing features are on."
      : googleAnalyticsPresent
        ? "Google Analytics was observed, but no DoubleClick remarketing sync appeared in this visit."
        : "This visit did not contact Google Analytics.",
    detail: gaRemarketingOn
      ? "If remarketing is on, this visit can be added to Google advertising audiences and matched to the profile Google already holds about you across sites. The DoubleClick sync is a strong signal, not configuration-level proof."
      : googleAnalyticsPresent
        ? `Standard analytics collection was observed, without the stats.g.doubleclick.net advertising sync.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
        : `Neither Google Analytics nor its remarketing sync was observed in this visit.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence: gaRemarketingOn
      ? "Google Analytics host plus a request to stats.g.doubleclick.net (Blacklight's remarketing marker)."
      : googleAnalyticsPresent
        ? "Google Analytics host observed; no stats.g.doubleclick.net request."
        : "No google-analytics.com or googletagmanager.com requests."
  });

  findings.push({
    id: "third-party-cookies",
    icon: "cookie",
    level:
      run.counts.thirdPartyCookies === 0 && cookiesCensored
        ? "info"
        : cookiesBenchmark
          ? cookiesBenchmark.level
          : levelForMetric("thirdPartyCookies", run.counts.thirdPartyCookies),
    title: run.counts.thirdPartyCookies > 0 ? "Third-party cookies were present" : "No third-party cookies observed",
    lead:
      run.counts.thirdPartyCookies > 0
        ? `${plural(run.counts.thirdPartyCookies, "third-party cookie")} showed up during the visit.`
        : "The automated visit did not observe third-party cookies.",
    detail:
      run.counts.thirdPartyCookies > 0
        ? "Third-party cookies can help outside services recognize repeat visits across sites when the browser allows them."
        : `This does not prove the site never uses cookies; it means this visit did not observe third-party cookies.${cookiesCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence: `${plural(run.counts.cookies, "cookie")} total in this report.`,
    benchmark: cookiesBenchmark ? cookiesBenchmark.label : benchmarkLabel("thirdPartyCookies", run.counts.thirdPartyCookies)
  });

  // Restricted to genuinely cross-site listener origins: the in-page probe's
  // hostname heuristic can misread same-site siblings (verified.example.com vs
  // www.example.com) as third parties, and a same-party listener is normal
  // site behavior, not monitoring by an outside party.
  const sessionRecordingDetection = crossSiteListenerDetection(run.evidence, "session-recording");
  const inputMonitoringDetection = crossSiteListenerDetection(run.evidence, "input-monitoring");
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
        "This is a behavioral instrumentation signal from listener registration, stack-attributed script origins, and known-vendor requests: it shows a script was positioned to observe interaction, not that anything was transmitted. On scanners that run the active keystroke-capture probe, actual transmission is tested separately (a synthetic value is typed, never real input, and no typed values are collected); treat this card as a review prompt rather than proof.",
      evidence: humanList(behaviorNotes, 4)
    });
  }

  const highEntropyDetections = highEntropyFingerprintDetections(run.evidence);
  const highEntropyDetectionLabels = highEntropyDetections.map(detectionLabel);
  const topFingerprintApis = run.evidence.fingerprintEvents.slice(0, 3).map((event) => event.api);
  findings.push({
    id: "fingerprint-apis",
    icon: "fingerprint",
    level:
      highEntropyDetections.length > 0
        ? "warn"
        : run.counts.fingerprintEvents > 0 || detectorCensored
          ? "info"
          : "ok",
    title:
      highEntropyDetections.length > 0
        ? highEntropyDetections.length === 1
          ? `${highEntropyDetectionLabels[0]} matched`
          : "Behavioral fingerprinting heuristics matched"
        : run.counts.fingerprintEvents > 0
          ? "Fingerprint-like browser APIs were called"
          : "No fingerprint-like API calls observed",
    lead:
      highEntropyDetections.length > 0
        ? `${plural(highEntropyDetections.length, "behavioral heuristic")} matched: ${humanList(highEntropyDetectionLabels, 5)}.`
        : run.counts.fingerprintEvents > 0
          ? `${plural(run.counts.fingerprintEvents, "high-entropy API call")} appeared in the instrumentation log.`
          : "The scan did not observe the instrumented high-entropy browser APIs.",
    detail:
      highEntropyDetections.length > 0
        ? "These heuristics look for behavior patterns such as canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, or WebRTC peer-connection setup. They are review prompts for this visit, not proof of cross-site identity tracking."
        : run.counts.fingerprintEvents > 0
          ? `These calls can be legitimate (charts, graphics, media), so the count is observational, not a severity score, and it excludes Web and Service Workers. Top calls: ${humanList(topFingerprintApis)}.`
          : `This is an observation layer, not proof that fingerprinting is impossible.${detectorCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence:
      highEntropyDetections.length > 0
        ? humanList(highEntropyDetections.map(detectionEvidence), 4)
        : `${plural(run.evidence.fingerprintEvents.length, "API family", "API families")} recorded.`
  });

  // Every comparison card runs through the SHARED claim policy (the seam's
  // default-deny derivation, the same one the comparison panel's banner and
  // the headline consult): a failed, request-capped, or mismatched arm means
  // the pair supports no comparison claim, and the card must say why instead
  // of quoting the two arms' difference.
  const pairGate = view.claims.pairComparison;

  // Each family's numbers may be quoted only through its own gate (RFC 4.4:
  // a family delta renders iff its family is eligible); the card composes
  // from whatever families the pair supports.
  const familyGates = view.claims.familyDeltas;
  const rawCountsAllowed = familyGates?.["raw-counts"]?.allowed === true;
  const classificationAllowed = familyGates?.["tracker-classification"]?.allowed === true;
  const detectorAllowed = familyGates?.["detector-findings"]?.allowed === true;

  if (arms && axis === "shields") {
    if (pairGate && !pairGate.allowed) {
      findings.unshift(ineligibleComparisonFinding("shields-comparison", "This Shields comparison is not conclusive", pairGate));
    } else {
      // SIGNED deltas per allowed family (variant minus baseline; negative =
      // fewer with blocking on), classified as decreased / increased / mixed
      // / flat. Never clamped and never summed across families: a pair with
      // more third-party requests but one fewer known-service request is a
      // MIXED result, not "fewer tracking signals".
      const signedDeltas: { label: string; singular: string; value: number }[] = [];
      if (rawCountsAllowed) {
        signedDeltas.push(
          {
            label: "third-party requests",
            singular: "third-party request",
            value: arms.variant.counts.thirdPartyRequests - arms.baseline.counts.thirdPartyRequests
          },
          {
            label: "third-party cookies",
            singular: "third-party cookie",
            value: arms.variant.counts.thirdPartyCookies - arms.baseline.counts.thirdPartyCookies
          }
        );
      }
      if (classificationAllowed) {
        signedDeltas.push({
          label: "known-service requests",
          singular: "known-service request",
          value: arms.variant.counts.knownTrackerRequests - arms.baseline.counts.knownTrackerRequests
        });
      }
      if (detectorAllowed) {
        signedDeltas.push({
          label: "fingerprint-like calls",
          singular: "fingerprint-like call",
          value: arms.variant.counts.fingerprintEvents - arms.baseline.counts.fingerprintEvents
        });
      }
      const decreased = signedDeltas.some((delta) => delta.value < 0);
      const increased = signedDeltas.some((delta) => delta.value > 0);
      const direction = decreased && increased ? "mixed" : decreased ? "decreased" : increased ? "increased" : "flat";
      const changedParts = signedDeltas
        .filter((delta) => delta.value !== 0)
        .map((delta) => `${Math.abs(delta.value).toLocaleString("en-US")} ${delta.value < 0 ? "fewer" : "more"} ${Math.abs(delta.value) === 1 ? delta.singular : delta.label}`);
      const removedEntityNames = classificationAllowed ? entitiesOnlyIn(arms.baseline, arms.variant) : [];
      // The direct engine-block count is a different measurement from the total
      // reduction: blocking one script prevents its follow-on requests from
      // ever starting, so the reduction usually exceeds the direct blocks.
      // It is the variant run's OWN recorded measurement, not a pair delta,
      // so it renders regardless of the family gates.
      const engineBlocks = shieldsRunMeasurement(arms.variant);
      const engineNote =
        engineBlocks && engineBlocks.kind === "engine-blocked"
          ? ` The blocking visit's engine directly blocked ${plural(engineBlocks.count, "request")}; the remaining difference may include follow-on requests that never started once their sources were blocked.`
          : "";

      if (signedDeltas.length === 0) {
        findings.unshift(
          ineligibleComparisonFinding(
            "shields-comparison",
            "This Shields comparison supports no comparable delta",
            familyGates?.["raw-counts"] ?? { allowed: false, reasons: ["No metric family is comparable across these two visits."] }
          )
        );
      } else {
        // "Brave-list blocking", never "Brave Shields on": the blocking arm
        // ran Brave's ad-block engine and default Shields lists as a block
        // SIMULATION in this scanner's browser, not a live Brave visit.
        const simulationNote =
          "Brave's ad-block engine and default Shields filter lists actively blocking (a simulation in this scanner's browser, not a live Brave-browser visit)";
        findings.unshift({
          id: "shields-comparison",
          icon: "shield-check",
          level: direction === "decreased" ? "ok" : direction === "flat" ? "quiet" : "info",
          title:
            direction === "decreased"
              ? "Fewer tracking signals observed with Brave-list blocking on"
              : direction === "increased"
                ? "More third-party activity observed with Brave-list blocking on"
                : direction === "mixed"
                  ? "Mixed changes observed with Brave-list blocking on"
                  : "No change observed with Brave-list blocking on",
          lead:
            direction === "flat"
              ? `The blocking visit (${simulationNote}) showed no change in the comparable metrics (${humanList(
                  signedDeltas.map((delta) => delta.label),
                  4
                )}).`
              : `With ${simulationNote}, this paired visit showed ${humanList(changedParts, 4)}.`,
          detail: `${
            removedEntityNames.length > 0 ? `Services only seen in the unblocked visit: ${humanList(removedEntityNames)}. ` : ""
          }${engineNote ? `${engineNote.trim()} ` : ""}A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments), so treat this as an observed difference, not a measured blocking rate.`,
          evidence: `Signed per-metric differences between the two visits; nothing is summed across metrics.`
        });
      }
    }
  }

  if (arms && axis === "consent") {
    // A pair that never dispatched both clicks keeps the consent-specific
    // story: its card explains WHICH click was missed and why that means the
    // pre-consent state, and (with the family gates denied) quotes no deltas.
    // The generic ineligible card is for pairs whose clicks both happened but
    // whose arms are otherwise not comparable.
    const bothClicksDispatched =
      arms.baseline.consent?.controlActivated === true && arms.variant.consent?.controlActivated === true;
    findings.unshift(
      pairGate && !pairGate.allowed && bothClicksDispatched
        ? ineligibleComparisonFinding("consent-comparison", "This consent comparison is not conclusive", pairGate)
        : buildConsentComparisonFinding(arms.baseline, arms.variant, rawCountsAllowed, classificationAllowed)
    );
  }

  if (arms && axis === "gpc" && pairGate && !pairGate.allowed) {
    findings.unshift(ineligibleComparisonFinding("gpc-comparison", "This GPC comparison is not conclusive", pairGate));
  }

  // Keyed on the explicit design marker: a legacy "custom" comparison is also
  // axis-less and must not receive the before/after card (its non-conclusive
  // story is the comparison panel's banner).
  if (arms && view.comparison?.temporalPair === true && pairGate && !pairGate.allowed) {
    findings.unshift(ineligibleComparisonFinding("temporal-comparison", "This before/after comparison is not conclusive", pairGate));
  }

  // A failed/blocked load (HTTP >= 400) produces low counts that are an artifact
  // of the page not loading, not a privacy result. Lead with that so the bottom
  // line never reads an error page as "few review signals".
  const loadFailureStatus = scanLoadFailureStatus(run.status);
  if (loadFailureStatus !== null) {
    findings.unshift({
      id: "bottom-line",
      icon: "alert",
      level: "info",
      title: `Bottom line: ${run.domain} did not load (HTTP ${loadFailureStatus})`,
      lead: `The page responded with HTTP ${loadFailureStatus}, so this report reflects an error or block page, not the site itself.`,
      detail:
        "Low tracker, cookie, and fingerprinting counts here mean the page did not load, not that the site is private. Re-scan when the site is reachable; the request log and methodology below still show exactly what was observed.",
      evidence: `${plural(run.counts.totalRequests, "request")} observed before or with the error response.`
    });
    return findings;
  }

  // A quiet result on a censored run is a floor, not a verdict: the bottom
  // line must lead with the truncation instead of "few review signals".
  // "Quiet" here means nothing warn-or-louder surfaced; the hedged absence
  // cards themselves sit at "info" on a censored run and must not read as
  // review-worthy signals.
  const censorshipNotes = runCensorshipNotes(run);
  const overallLevel = strongestLevel(findings.map((finding) => finding.level));
  const censoredQuiet =
    censorshipNotes.length > 0 && (overallLevel === "ok" || overallLevel === "quiet" || overallLevel === "info");
  findings.unshift({
    id: "bottom-line",
    icon: overallLevel === "ok" && !censoredQuiet ? "check" : "alert",
    level: censoredQuiet ? "info" : overallLevel,
    title: censoredQuiet
      ? "Bottom line: the visit was cut short, so few signals is not a verdict"
      : overallLevel === "ok"
        ? "Bottom line: few review signals in this visit"
        : "Bottom line: this visit has review-worthy signals",
    lead: censoredQuiet
      ? `Evidence collection did not finish (${humanList(censorshipNotes, 2)}), so the quiet result is a floor for this visit, not a verdict about the site.`
      : overallLevel === "ok"
        ? "The automated visit did not observe known third-party services, third-party cookies, or instrumented fingerprint-like calls."
        : `The scan observed signals a non-expert should not have to decode from raw request tables.${
            censorshipNotes.length > 0
              ? ` Evidence collection was also cut short (${humanList(censorshipNotes, 2)}), so every count is a floor for this visit.`
              : ""
          }`,
    detail: corpusIsUsable(corpus)
      ? `The cards below translate the evidence into plain language. Where a measured distribution exists, severity ranks this visit against percentiles from the ${corpus.sampleSize.toLocaleString("en-US")} sites scanned so far (a curated set of popular, mostly commercial sites, not a random sample of the web) and otherwise uses fixed reference thresholds. The request log, domain table, and methodology remain below for verification.`
      : "The cards below translate the evidence into plain language; severity reflects fixed reference thresholds, not measured population percentiles. The request log, domain table, and methodology remain below for verification.",
    evidence: `${plural(run.counts.totalRequests, "request")} observed in one controlled visit.`
  });

  const shieldsMeasurement = shieldsRunMeasurement(run);
  if (shieldsMeasurement) {
    const blocked = shieldsMeasurement.count;
    const simulated = shieldsMeasurement.kind === "engine-blocked";
    findings.splice(1, 0, {
      id: "shields-blocked",
      icon: "shield-check",
      level: blocked === 0 ? "ok" : blocked >= 10 ? "warn" : "info",
      title:
        blocked > 0
          ? simulated
            ? `Brave's blocking engine stopped ${blocked.toLocaleString("en-US")} requests in this visit`
            : `${blocked.toLocaleString("en-US")} of ${run.counts.totalRequests.toLocaleString("en-US")} requests matched Brave Shields filter lists`
          : simulated
            ? "Brave's blocking engine stopped nothing in this visit"
            : "No requests matched Brave Shields filter lists",
      lead:
        blocked > 0
          ? simulated
            ? `${plural(blocked, "request")} were aborted before they could load by Brave's ad-block engine running Shields' default filter lists, a block simulation in this scanner's browser, not a live Brave-browser visit.`
            : `${plural(blocked, "request")} matched the default filter lists of Brave Shields, the ad and tracker blocker built into the Brave browser, while loading normally.`
          : "No requests matched the default filter lists of Brave Shields, the ad and tracker blocker built into the Brave browser.",
      detail: simulated
        ? "Measured with Brave's own ad-block engine and default filter lists actively blocking (network requests only, so no cosmetic or CNAME-based blocking). Blocked requests are not in this run's totals, and requests a blocked script would have made never started."
        : "Computed with Brave's own ad-block engine and default filter lists in classification mode: matched requests LOADED normally and are counted in this report. Matching shows what Shields would target on this visit's traffic; an actual Shields visit blocks these and also prevents their follow-on requests, so this number is neither a measured block count nor the total effect.",
      evidence: `${plural(run.counts.knownTrackerRequests, "named-service request")} of them are also in the curated catalog.`
    });
  }

  // Emit every finding. The conditionals above bound this to at most ~9 cards,
  // all of them meaningful; a fixed cap here silently dropped the last-pushed
  // card (the fingerprinting finding) on Node Shields-comparison reports that
  // also surfaced a session-recording or input-monitoring signal.
  return findings;
}

/**
 * Catalogued tracker entities observed in one arm's domain table and not the
 * other's, busiest first: the same derivation the v1 wire's added/removed
 * entity lists were computed from, now taken from the arms directly so v2
 * comparisons (no precomputed diff) and inconsistent uploads get identical
 * treatment.
 */
function entitiesOnlyIn(run: RunView, other: RunView): string[] {
  const otherEntities = new Set(trackerEntitySummaries(other.evidence).map((entity) => entity.entity));
  return trackerEntitySummaries(run.evidence)
    .filter((entity) => !otherEntities.has(entity.entity))
    .map((entity) => entity.entity);
}

/**
 * The card that replaces a comparison's story when the seam's pair claim gate
 * fails: it names the disqualifying facts and makes no claim from the pair.
 */
function ineligibleComparisonFinding(id: string, title: string, gate: ClaimGate): Finding {
  return {
    id,
    icon: "alert",
    level: "info",
    title,
    lead: humanList(gate.reasons, 3),
    detail:
      "The raw request logs of both visits remain below for transparency, but the diff between them supports no claim about what the compared condition changed.",
    evidence: `${plural(gate.reasons.length, "disqualifying condition")} named by the report's claim policy.`
  };
}

/**
 * The leading card for a consent accept/reject comparison. Every claim is
 * gated on the click actually having happened: a run whose control was not
 * found is pre-consent, and the card says which run that was instead of
 * pretending the diff measured the choice.
 */
function buildConsentComparisonFinding(
  baseline: RunView,
  variant: RunView,
  rawCountsAllowed: boolean,
  classificationAllowed: boolean
): Finding {
  const acceptClicked = baseline.consent?.controlActivated === true;
  const rejectClicked = variant.consent?.controlActivated === true;
  const acceptTracking = trackerEntitySummaries(baseline.evidence).filter((entity) => !isOperationalEntity(entity));
  const rejectTracking = trackerEntitySummaries(variant.evidence).filter((entity) => !isOperationalEntity(entity));
  const requestsBefore = baseline.counts.thirdPartyRequests;
  const requestsAfter = variant.counts.thirdPartyRequests;
  // The count juxtaposition is a raw-counts family delta; when that family is
  // not comparable across the two visits, the card keeps its per-visit story
  // but quotes no numbers side by side. The count labels come from what each
  // visit RECORDED: "21 with Accept all" on a visit that never clicked
  // anything would caption the pre-consent state as a consent choice.
  const evidence = rawCountsAllowed
    ? `Third-party requests: ${requestsBefore.toLocaleString("en-US")} ${
        acceptClicked ? "with the accept-all click" : "in the accept-attempt visit (pre-consent)"
      }, ${requestsAfter.toLocaleString("en-US")} ${
        rejectClicked ? "with the reject-all click" : "in the reject-attempt visit (pre-consent)"
      }.`
    : "Third-party request totals are not comparable across these two visits, so no count delta is quoted.";

  if (!acceptClicked && !rejectClicked) {
    return {
      id: "consent-comparison",
      icon: "cookie",
      level: "info",
      title: "No consent banner could be clicked in either visit",
      lead: "Neither visit found a recognizable accept or reject control, so both runs reflect the pre-consent state and this diff mostly shows run-to-run variance.",
      detail:
        "Many consent banners are only shown to visitors in regions where the law requires them (the EEA, UK, or California), so this scanner's location may simply not be served one; a banner may also use controls this scanner's catalog does not recognize. No claim about the site's consent behavior can be made from this pair of visits.",
      evidence
    };
  }

  if (acceptClicked !== rejectClicked) {
    const clickedLabel = acceptClicked ? "Accept all" : "Reject all";
    const missingLabel = acceptClicked ? "Reject all" : "Accept all";
    return {
      id: "consent-comparison",
      icon: "cookie",
      level: "info",
      title: `Only the ${clickedLabel} control could be clicked`,
      lead: `The ${clickedLabel} visit clicked the banner, but no ${missingLabel} control was found, so that run reflects the pre-consent state and this diff does not measure the ${missingLabel.toLowerCase()} choice.`,
      detail:
        missingLabel === "Reject all"
          ? "Many banners offer no first-layer reject control and put refusal behind a settings layer this scanner does not navigate. That design is itself worth noting, but it can also mean this scanner's catalog simply does not recognize the control, so treat the asymmetry as a prompt to check the banner yourself."
          : "The accept control was not recognized on its visit, so the accept side of this diff reflects the pre-consent state. Treat the comparison as incomplete rather than as evidence about the site's consent behavior.",
      evidence
    };
  }

  if (rejectTracking.length > 0) {
    return {
      id: "consent-comparison",
      icon: "cookie",
      level: "warn",
      title: `${plural(rejectTracking.length, "tracking company", "tracking companies")} loaded in the visit that clicked Reject all`,
      // The cross-arm contrast ("N loaded in the accept-click visit") is a
      // classification-family juxtaposition; without that family the card
      // keeps the reject-click visit's own facts only.
      lead: `In the visit where the scanner clicked Reject all, ${humanList(rejectTracking.map((entity) => entity.entity))} received requests${
        classificationAllowed
          ? ` (${plural(acceptTracking.length, "tracking company", "tracking companies")} loaded in the visit that clicked Accept all)`
          : ""
      }.`,
      detail:
        "The visit records traffic from before AND after the click, and the scanner can dispatch the click but cannot verify the site registered the choice, so some of this can be pre-click traffic, vendors a site treats as strictly necessary, or processing claimed under legitimate interest. It is a documented observation to review against the banner's promises, not a violation ruling. The diff below lists the services that appeared only in the visit that clicked Accept all.",
      evidence
    };
  }

  // "No catalogued trackers" is an absence claim over the reject visit's
  // request evidence: censored collection makes it a floor, not reassurance.
  const rejectEvidenceCensored = familyCensoredOnRun(variant, "requests");
  return {
    id: "consent-comparison",
    icon: rejectEvidenceCensored ? "alert" : "shield-check",
    level: rejectEvidenceCensored ? "info" : "ok",
    title: rejectEvidenceCensored
      ? "No catalogued trackers before the reject-click visit was cut short"
      : "The visit that clicked Reject all had no catalogued trackers",
    lead:
      classificationAllowed && acceptTracking.length > 0
        ? `The visit where the scanner clicked Reject all loaded no catalogued tracking company, while the visit that clicked Accept all loaded ${plural(
            acceptTracking.length,
            "tracking company",
            "tracking companies"
          )}.`
        : classificationAllowed
          ? "No catalogued tracking company loaded in either visit; on this page the two visits differed little because there was little to consent to."
          : "The visit where the scanner clicked Reject all loaded no catalogued tracking company.",
    detail: `A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments), and the scanner cannot verify the site registered the click, so treat this as an observed difference for this pair of visits.${
      rejectEvidenceCensored ? CENSORED_ABSENCE_NOTE : ""
    }`,
    evidence
  };
}

function requestProvenanceHighlights(requests: NetworkRequestRecord[]): string[] {
  const seen = new Set<string>();
  const highlights: string[] = [];

  for (const request of requests) {
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
