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
import { corpusCohortIdentityForView } from "./corpus-cohort";
import { corpusBenchmark, corpusIsUsable, selectCorpusStatsCohort, type CorpusStats } from "./corpus-stats";
import {
  HEADLINE_PLATFORMS,
  crossSiteListenerDetection,
  type CrossSiteListenerDetection,
  detectionEvidence,
  detectionLabel,
  fingerprintDetection,
  highEntropyDetections as highEntropyFingerprintDetections,
  isOperationalEntity,
  keystrokeLeakHashed,
  pixelEventEvidence,
  pixelEventSummaries,
  pixelFieldLabel,
  respondedTrackerEntityNames,
  scanLoadFailureStatus,
  shieldsRunMeasurement,
  trackerResponseQualification,
  trackerEntitySummaries
} from "./report-insights";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  familyUnsupportedOnRun,
  runCensorshipNotes,
  unsupportedEvidenceFamilies,
  type ClaimGate,
  type ReportView,
  type RunView
} from "./scan-report-views";
import { humanList, plural } from "./text-format";
import type { NetworkRequestRecord, PrivacyPolicyClaimKind, ProvenanceChange } from "./types";
import {
  CONSENT_WHOLE_VISIT_CAVEAT,
  consentChoiceVerified,
  consentRegistrationSentence,
  consentVerificationSummary
} from "./report-consent-copy";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";

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
  /**
   * True on cards that describe this REPORT's methodology (an ineligible
   * pair) rather than the site's observed behavior. The bottom line
   * summarizes observed signals, so these never flip it to "review-worthy".
   */
  methodology?: true;
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

function corpusBenchmarkScope(corpus: CorpusStats): string {
  const coverage = corpus.coverageSiteCount;
  if (corpus.cohorts && corpus.primaryCohortId) {
    return `report's exact schema, methodology, producer, and Global Privacy Control cohort, with each percentile card naming its metric-specific measured-site denominator${
      typeof coverage === "number" && coverage > corpus.sampleSize
        ? ` (among ${coverage.toLocaleString("en-US")} sites with a successful load across all cohorts; other methodologies, request-capped visits, and post-choice consent visits are excluded from this denominator, while failed or block-page attempts are outside that coverage)`
        : ""
    }`;
  }
  return `legacy-v1 cohort, with each percentile card naming its metric-specific measured-site denominator${
    typeof coverage === "number" && coverage > corpus.sampleSize
      ? ` (among ${coverage.toLocaleString("en-US")} sites with a successful load; request-capped, post-choice consent, and v2 loads are included in that coverage but excluded from this legacy-v1 cohort, while failed or block-page attempts are outside it)`
      : ""
  }`;
}

export function buildFindings(view: ReportView, corpusInput: CorpusStats | null): Finding[] {
  // New artifacts publish one distribution per exact schema/methodology/
  // producer/requested-GPC cohort. Select the report's own cohort or fail
  // closed. The
  // origin-only fallback exists solely for historical version-1 artifacts,
  // whose only distribution was explicitly legacy-v1.
  const corpus = corpusInput?.cohorts
    ? selectCorpusStatsCohort(corpusInput, corpusCohortIdentityForView(view).id)
    : view.origin === "legacy-derived"
      ? corpusInput
      : null;
  const run = displayRunView(view);
  const arms = comparisonArmViews(view);
  const axis = view.comparison?.axis ?? null;
  const entities = trackerEntitySummaries(run.evidence);
  const trackingEntities = entities.filter((entity) => !isOperationalEntity(entity));
  const operationalEntities = entities.filter((entity) => isOperationalEntity(entity));
  const trackingNames = trackingEntities.map((entity) => entity.entity);
  const operationalNames = operationalEntities.map((entity) => entity.entity);
  const respondedEntities = respondedTrackerEntityNames(run.evidence);
  const topCategories = Array.from(new Set(trackingEntities.flatMap((entity) => entity.categories))).slice(0, 3);
  const cookiesUnsupported = familyUnsupportedOnRun(run, "cookies");
  const detectorUnsupported =
    familyUnsupportedOnRun(run, "detector-output") || familyUnsupportedOnRun(run, "fingerprinting");
  const requestsCensored = familyCensoredOnRun(run, "requests");
  const cookiesCensored = familyCensoredOnRun(run, "cookies");
  // Raw fingerprint events live in the "fingerprinting" evidence family;
  // detector conclusions live in "detector-output". The absence card covers
  // both, so censoring in either hedges it.
  const detectorCensored = familyCensoredOnRun(run, "detector-output") || familyCensoredOnRun(run, "fingerprinting");
  const runCompleted = run.quality.outcome === "complete";
  // The distribution these percentiles rank against is built from plain first
  // visits only: corpus-stats-builder, entryEligibleForCorpusRollups, and the
  // researcher export all drop a post-choice consent arm from the denominator.
  // Ranking such an arm against it compares an accepted-cookies state to a
  // pre-consent population, in the direction that inflates the rank, on the
  // very page whose own bottom line says post-choice visits are excluded.
  const postChoiceConsentLead =
    run.conditions.consentMode === "accept-all" || run.conditions.consentMode === "reject-all";
  const benchmarkPopulationMatches = runCompleted && !postChoiceConsentLead;
  const domainsBenchmarkAllowed = benchmarkPopulationMatches && !requestsCensored;
  const cookiesBenchmarkAllowed = benchmarkPopulationMatches && !cookiesUnsupported && !cookiesCensored;
  // Corpus percentiles when available + large enough; otherwise fixed thresholds.
  const domainsBenchmark = domainsBenchmarkAllowed
    ? corpusBenchmark(corpus, "thirdPartyDomains", run.counts.thirdPartyDomains)
    : null;
  const cookiesBenchmark = cookiesBenchmarkAllowed
    ? corpusBenchmark(corpus, "thirdPartyCookies", run.counts.thirdPartyCookies)
    : null;
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
        ? `When the scanner typed a unique test value into ${fields}, that value was sent to ${recipients} as a one-way hash (${humanList(keystrokeDetection.evidence.encodings)}) and without the form ever being submitted.`
        : `When the scanner typed a unique test value into ${fields}, that value was sent to ${recipients} as it was typed (${humanList(keystrokeDetection.evidence.encodings)}), without the form ever being submitted, typically search type-ahead or autocomplete handled by a third party.`,
      detail: hashed
        ? `The typed value was hashed (${humanList(
            keystrokeDetection.evidence.encodings
          )}) before being sent. A hash cannot drive a functional type-ahead, so this is the pattern used to match you to a known identity, not a visible API call. A real visitor's keystrokes could be captured the same way. The scanner types only synthetic values and never submits the form.`
        : `The value was sent in a recoverable form (${humanList(
            keystrokeDetection.evidence.encodings
          )}), consistent with a functional type-ahead or autocomplete (a search or location lookup) handled by a third party. Still worth knowing your keystrokes leave to ${recipients}, but not on its own evidence of covert capture. The scanner types only synthetic values and never submits the form.`,
      evidence: `Test value was sent to ${recipients} via ${humanList(keystrokeDetection.evidence.encodings)}.`
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
    const consentPlatformAnswered =
      (run.evidence.domains.find((domain) => domain.domain === consentPlatform.domain)?.statuses.length ?? 0) > 0;
    const answeredPreConsentTrackers = trackingEntities.filter((entity) => respondedEntities.has(entity.entity)).length;
    findings.push({
      id: "consent-banner",
      icon: "cookie",
      level: preConsentTrackers > 0 ? "warn" : "info",
      title:
        preConsentTrackers > 0
          ? "Consent tooling and tracker requests appeared before any choice"
          : consentPlatformAnswered
            ? "A consent management platform answered"
            : "A consent management platform was requested",
      lead:
        preConsentTrackers > 0
          ? `${run.domain} sent a request to ${consentPlatform.name}, a consent management platform (the tooling that shows cookie banners), and sent requests to ${plural(
              preConsentTrackers,
              "tracking company",
              "tracking companies"
            )} before the scanner made any consent choice${answeredPreConsentTrackers > 0 ? `; ${plural(answeredPreConsentTrackers, "company", "companies")} answered` : "; none recorded a response"}.`
          : `${run.domain} sent a request to ${consentPlatform.name}, a consent management platform (the tooling that shows cookie banners); no request to a catalogued tracking company was recorded before the scanner made any consent choice in this visit.`,
      detail:
        'A request to the platform\'s loader proves the page attempted to fetch consent tooling; an observed response supports delivery, but neither fact proves a banner was visibly shown to this scanner. Banner display can vary by region and visit context. The scanner never clicks a banner in this mode, so this report records requests made before the scanner made a consent choice. It does not determine whether any request required consent or whether the site\'s behavior complied with applicable law. More trackers may appear after "Accept" than this report captures, so tracker counts here are a lower bound for users who consent.',
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
        )} carried populated personal-identifier fields in this visit; IF those fields held real visitor data, many regulators treat that as sharing, but the scanner only checks those fields for being non-empty and never stores the values`
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
    // The same rule applied to the other side of the comparison: with no
    // checkable statement extracted, "no checked statement contradicted" is
    // vacuously true and reads as a clean result from zero checks. 83 of the
    // committed reports publish exactly that, so this needs its own branch
    // rather than the reassuring default.
    const noCheckableClaims = policy.claims.length === 0;
    findings.push({
      id: "privacy-policy",
      icon: "file-text",
      level:
        conflicts.length > 0
          ? "warn"
          : conditionalConflicts.length > 0 || policy.unmentionedEntities.length > 0
            ? "info"
            : policyEvidenceCensored || noCheckableClaims
              ? "info"
              : "ok",
      title:
        conflicts.length > 0
          ? "The privacy policy says one thing; this visit shows another"
          : conditionalConflicts.length > 0
            ? "A policy statement may conflict with observed advertising events"
            : policy.unmentionedEntities.length > 0
              ? "Tracking companies the privacy policy never names"
              : noCheckableClaims
                ? "Privacy policy read; it made no statement this scan can check"
                : "Privacy policy read; no checked statement contradicted",
      lead:
        conflicts.length > 0
          ? `Comparing the site's own privacy policy against this visit: ${humanList(conflicts, 3)}.`
          : conditionalConflicts.length > 0
            ? `Comparing the site's own privacy policy against this visit: ${humanList(conditionalConflicts, 2)}.`
            : policy.unmentionedEntities.length > 0
              ? `${humanList(policy.unmentionedEntities)} ${policy.unmentionedEntities.length === 1 ? "was" : "were"} sent requests during this visit but ${policy.unmentionedEntities.length === 1 ? "is" : "are"} never named in the privacy policy text.`
              : noCheckableClaims
                ? `None of the statements this scan knows how to check appear in the policy text, so nothing was compared against this visit's evidence (${coverage}). That is a limit of the automated check, not a finding about the site either way.`
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
        ? trackingEntities.every((entity) => respondedEntities.has(entity.entity))
          ? "Tracking and ad services responded during this visit"
          : "Requests were sent to tracking and ad services"
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
        ? `These services can profile visitors across sites.${topCategories.length > 0 ? ` Catalog labels for those services include ${humanList(topCategories)}.` : ""}${sessionReplayNote}${operationalNote}`
        : operationalEntities.length > 0
          ? `These are monitoring or support tools, not cross-site trackers. Unlabeled third parties may still be present.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
          : `There may still be unlabeled third parties, but no known catalog entity was matched.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence: `${plural(run.counts.thirdPartyRequests, "third-party request")} across ${plural(run.counts.thirdPartyDomains, "third-party domain")}.`,
    benchmark: !domainsBenchmarkAllowed
      ? undefined
      : domainsBenchmark
        ? domainsBenchmark.label
        : trackingEntities.length > 0
          ? benchmarkLabel("trackerEntities", trackingEntities.length)
          : benchmarkLabel("thirdPartyDomains", run.counts.thirdPartyDomains)
  });

  findings.push({
    id: "named-platforms",
    icon: "network",
    level: headlineNames.length === 0 ? (requestsCensored ? "info" : "ok") : headlineNames.length >= 3 ? "warn" : "info",
    title: headlineNames.length > 0 ? "Requests were sent to major platforms" : "No requests to major platforms were recorded",
    lead:
      headlineNames.length > 0
        ? `This visit sent requests to ${humanList(headlineNames)}.`
        : "No requests to Google, Meta, TikTok, or X were observed in this visit.",
    detail:
      headlineNames.length > 0
        ? "If received, these platforms can link this visit to the profile they already hold about you from other sites and apps."
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
          : "This reads each pixel request's event type (such as PageView, ViewContent, or Purchase), not just that a pixel request was recorded. No advanced-matching identifier fields were observed in this passive visit; interaction-gated events could still carry them for real users.",
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
      cookiesUnsupported
        ? "info"
        : run.counts.thirdPartyCookies === 0 && cookiesCensored
        ? "info"
        : cookiesBenchmark
          ? cookiesBenchmark.level
          : levelForMetric("thirdPartyCookies", run.counts.thirdPartyCookies),
    title: cookiesUnsupported
      ? "Cookie evidence was not captured"
      : run.counts.thirdPartyCookies > 0
        ? "Third-party cookies were present"
        : "No third-party cookies observed",
    lead:
      cookiesUnsupported
        ? "This request-only PageGraph import does not capture cookie evidence."
        : run.counts.thirdPartyCookies > 0
        ? `${plural(run.counts.thirdPartyCookies, "third-party cookie")} showed up during the visit.`
        : "The automated visit did not observe third-party cookies.",
    detail:
      cookiesUnsupported
        ? "The report's zero-valued cookie fields are schema placeholders for an unavailable measurement, not evidence that the site set no cookies."
        : run.counts.thirdPartyCookies > 0
        ? "Third-party cookies can help outside services recognize repeat visits across sites when the browser allows them."
        : `This does not prove the site never uses cookies; it means this visit did not observe third-party cookies.${cookiesCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence: cookiesUnsupported
      ? "Unsupported by the request-only PageGraph r2 producer."
      : `${plural(run.counts.cookies, "cookie")} total in this report.`,
    benchmark: !cookiesBenchmarkAllowed
      ? undefined
      : cookiesBenchmark
        ? cookiesBenchmark.label
        : benchmarkLabel("thirdPartyCookies", run.counts.thirdPartyCookies)
  });

  // Restricted to genuinely cross-site listener origins: the in-page probe's
  // hostname heuristic can misread same-site siblings (verified.example.com vs
  // www.example.com) as third parties, and a same-party listener is normal
  // site behavior, not monitoring by an outside party.
  const sessionRecordingDetection = crossSiteListenerDetection(run.evidence, "session-recording");
  const inputMonitoringDetection = crossSiteListenerDetection(run.evidence, "input-monitoring");
  if (sessionRecordingDetection || inputMonitoringDetection || sessionReplayNames.length > 0) {
    // The probe reports one listener-call total across every origin it
    // attributed. When same-site origins were filtered out of that set, the
    // total still covers them, so binding it to the narrowed names would
    // credit calls to third parties that did not make them.
    const listenerNote = (
      entry: CrossSiteListenerDetection | undefined,
      noun: "third-party interaction listener" | "third-party input listener"
    ): string => {
      if (!entry) return "";
      const names = humanList(entry.detection.evidence.thirdPartyOrigins);
      const calls = entry.detection.evidence.totalListenerCalls;
      return entry.originsNarrowed
        ? `${plural(calls, noun.replace("third-party ", ""))} attributed across ${names} and same-site origins the probe could not separate`
        : `${plural(calls, noun)} from ${names}`;
    };
    const behaviorNotes = [
      listenerNote(sessionRecordingDetection, "third-party interaction listener"),
      listenerNote(inputMonitoringDetection, "third-party input listener"),
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
      detectorUnsupported
        ? "info"
        : highEntropyDetections.length > 0
        ? "warn"
        : run.counts.fingerprintEvents > 0 || detectorCensored
          ? "info"
          : "ok",
    title:
      detectorUnsupported
        ? "Fingerprinting evidence was not captured"
        : highEntropyDetections.length > 0
        ? highEntropyDetections.length === 1
          ? `${highEntropyDetectionLabels[0]} matched`
          : "Behavioral fingerprinting heuristics matched"
        : run.counts.fingerprintEvents > 0
          ? "Fingerprint-like browser APIs were called"
          : "No fingerprint-like API calls observed",
    lead:
      detectorUnsupported
        ? "This request-only PageGraph import does not capture fingerprinting or detector evidence."
        : highEntropyDetections.length > 0
        ? `${plural(highEntropyDetections.length, "behavioral heuristic")} matched: ${humanList(highEntropyDetectionLabels, 5)}.`
        : run.counts.fingerprintEvents > 0
          ? `${plural(run.counts.fingerprintEvents, "high-entropy API call")} appeared in the instrumentation log.`
          : "The scan did not observe the instrumented high-entropy browser APIs.",
    detail:
      detectorUnsupported
        ? "The report's zero-valued fingerprint fields are schema placeholders for an unavailable measurement, not an observed absence of fingerprint-like behavior."
        : highEntropyDetections.length > 0
        ? "These heuristics look for behavior patterns such as canvas readback after drawing, repeated canvas font measurement, WebGL entropy reads, offline audio rendering, or WebRTC peer-connection setup. They are review prompts for this visit, not proof of cross-site identity tracking."
        : run.counts.fingerprintEvents > 0
          ? `These calls can be legitimate (charts, graphics, media), so the count is observational, not a severity score, and it excludes Web and Service Workers. Top calls: ${humanList(topFingerprintApis)}.`
          : `This is an observation layer, not proof that fingerprinting is impossible.${detectorCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence:
      detectorUnsupported
        ? "Unsupported by the request-only PageGraph r2 producer."
        : highEntropyDetections.length > 0
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
      // "The remaining difference" only describes a reduction: on a mixed,
      // increased, or flat pair the residual sentence must explain how totals
      // can hold steady or rise despite direct blocks, not imply a reduction
      // that is not there.
      const engineNote =
        engineBlocks && engineBlocks.kind === "engine-blocked"
          ? direction === "decreased"
            ? ` The blocking visit's engine directly blocked ${plural(engineBlocks.count, "request")}; the remaining difference may include follow-on requests that never started once their sources were blocked.`
            : ` The blocking visit's engine directly blocked ${plural(engineBlocks.count, "request")}; ad rotation, experiments, or caching between the two visits can offset or outweigh what blocking removed, which is how totals can hold steady or rise despite direct blocks.`
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
        const simulationNote = view.claims.interventionAttribution
          ? "Brave's ad-block engine and default Shields filter lists verified as actively blocking (a simulation in this scanner's browser, not a live Brave-browser visit)"
          : "the scanner configured to apply Brave's ad-block engine and default Shields filter lists (a simulation in this scanner's browser, not a live Brave-browser visit; application was not verified)";
        findings.unshift({
          id: "shields-comparison",
          icon: "shield-check",
          level: direction === "decreased" ? "ok" : direction === "flat" ? "quiet" : "info",
          title:
            direction === "decreased"
              ? "Fewer tracking signals observed in the Brave-list blocking attempt"
              : direction === "increased"
                ? "More third-party activity observed in the Brave-list blocking attempt"
                : direction === "mixed"
                  ? "Mixed changes observed in the Brave-list blocking attempt"
                  : "No change observed in the Brave-list blocking attempt",
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
    const bothChoicesVerified = consentChoiceVerified(arms.baseline.consent) && consentChoiceVerified(arms.variant.consent);
    const contradicted =
      arms.baseline.consent?.choiceState === "contradicted" || arms.variant.consent?.choiceState === "contradicted";
    const unverifiedCompletedPair = bothClicksDispatched && !bothChoicesVerified;
    findings.unshift(
      contradicted
        ? unconfirmedConsentInteractionFinding(view, arms.baseline, arms.variant)
        : pairGate && !pairGate.allowed && bothClicksDispatched
          ? ineligibleComparisonFinding("consent-comparison", "This consent comparison is not conclusive", pairGate)
          : unverifiedCompletedPair
            ? unconfirmedConsentInteractionFinding(view, arms.baseline, arms.variant)
          : buildConsentComparisonFinding(view, arms.baseline, arms.variant, rawCountsAllowed, classificationAllowed)
    );
  }

  if (arms && axis === "gpc") {
    if (pairGate && !pairGate.allowed) {
      findings.unshift(ineligibleComparisonFinding("gpc-comparison", "This GPC comparison is not conclusive", pairGate));
    } else {
      // Same signed, per-family, never-summed composition as the Shields card.
      // An ELIGIBLE GPC pair used to produce no card at all, so the headline
      // could describe the pair while the findings board narrated only the
      // baseline arm.
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

      if (signedDeltas.length === 0) {
        findings.unshift(
          ineligibleComparisonFinding(
            "gpc-comparison",
            "This GPC comparison supports no comparable delta",
            familyGates?.["raw-counts"] ?? { allowed: false, reasons: ["No metric family is comparable across these two visits."] }
          )
        );
      } else {
        // Honoring GPC means not selling or sharing data. Request counts cannot
        // observe that, and cannot even show the signal was received, so every
        // line here describes the two visits and stops.
        findings.unshift({
          id: "gpc-comparison",
          icon: "shield-check",
          level: direction === "decreased" ? "ok" : direction === "flat" ? "quiet" : "info",
          // `direction` is computed over every comparable family, so a pair
          // whose only movement is in cookies or fingerprint-like calls would
          // headline a request reduction the evidence never measured. The noun
          // stays family-neutral, matching the Shields card; the lead below
          // already names the exact metrics that moved.
          title:
            direction === "decreased"
              ? "Fewer tracking signals observed in the visit with a privacy signal"
              : direction === "increased"
                ? "More tracking signals observed in the visit with a privacy signal"
                : direction === "mixed"
                  ? "Mixed changes observed in the visit with a privacy signal"
                  : "No change observed in the visit with a privacy signal",
          lead:
            direction === "flat"
              ? `The visit configured with a "do not sell or share" (GPC) signal showed no change in the comparable metrics (${humanList(
                  signedDeltas.map((delta) => delta.label),
                  4
                )}).`
              : `The visit configured with a "do not sell or share" (GPC) signal showed ${humanList(changedParts, 4)}.`,
          detail: `${
            removedEntityNames.length > 0 ? `Services only seen in the visit without the signal: ${humanList(removedEntityNames)}. ` : ""
          }An observed difference for this pair of visits, not proof the site received or honored the signal. A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments).`,
          evidence: `Signed per-metric differences between the two visits; nothing is summed across metrics.`
        });
      }
    }
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
    // Same rule as the failed-navigation branch below: an error or block page
    // cannot support reassuring absence cards. This branch used to return before
    // reaching that loop, so a 403 published a board of green "no trackers"
    // cards about a page that was never served.
    hedgeAbsenceCards(
      findings,
      `The page returned HTTP ${loadFailureStatus}, so this absence describes an error or block page, not the site.`
    );
    findings.unshift({
      id: "bottom-line",
      icon: "alert",
      level: "info",
      title: `Bottom line: ${run.domain} did not serve its page (HTTP ${loadFailureStatus})`,
      lead: `The page responded with HTTP ${loadFailureStatus}, so this report reflects an error or block page, not the site itself.`,
      detail: `Low tracker, cookie, and fingerprinting counts here mean no page was served, not that the site is private. ${retryGuidance(
        loadFailureStatus,
        run
      )} The request log and methodology below still show exactly what was observed.`,
      evidence: `${plural(run.counts.totalRequests, "request")} observed before or with the error response.`
    });
    return findings;
  }

  // A recorded failed run with no numeric status is not an unknown-but-quiet
  // visit. Frozen r2 deliberately maps otherwise-valid 600-999 navigation
  // statuses to null and records this marker; lead with the failed navigation
  // while withholding the exact code rather than manufacturing one.
  if (run.quality.outcome === "failed") {
    const statusUnrepresentable =
      run.quality.facts?.captureLoss.some((loss) => loss.detail === R2_NAVIGATION_STATUS_UNREPRESENTABLE) === true;
    hedgeAbsenceCards(
      findings,
      "The main page did not complete a trustworthy load, so this absence describes only an incomplete visit."
    );
    findings.unshift({
      id: "bottom-line",
      icon: "alert",
      level: "info",
      title: `Bottom line: ${run.domain}'s main page did not complete a trustworthy load`,
      lead: statusUnrepresentable
        ? "The site returned an HTTP status outside this frozen report format's representable range. The exact code is withheld instead of being coerced, and the navigation is recorded as failed."
        : "The scanner's recorded quality facts mark the main-page load as failed or incomplete.",
      detail:
        "Tracker, cookie, storage, and fingerprinting counts here are evidence retained from an incomplete visit, not a positive privacy conclusion. Re-scan when the page can complete a trustworthy load; the request log and methodology below still show what was observed.",
      evidence: `${plural(run.counts.totalRequests, "request")} retained from the failed or incomplete visit.`
    });
    return findings;
  }

  // A quiet result on a censored run is a floor, not a verdict: the bottom
  // line must lead with the truncation instead of "few review signals".
  // "Quiet" here means nothing warn-or-louder surfaced; the hedged absence
  // cards themselves sit at "info" on a censored run and must not read as
  // review-worthy signals.
  // Built BEFORE the bottom line so its level is part of overallLevel. While
  // it was spliced in afterwards, a warn-level Shields card could never raise
  // the bottom line, so a visit with ten or more matched requests could still
  // headline "few review signals".
  const shieldsMeasurement = shieldsRunMeasurement(run);
  if (shieldsMeasurement) {
    const blocked = shieldsMeasurement.count;
    const simulated = shieldsMeasurement.kind === "engine-blocked";
    findings.unshift({
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
            ? `Brave's ad-block engine running Shields' default filter lists stopped ${plural(blocked, "request")} from loading, a block simulation in this scanner's browser, not a live Brave-browser visit.`
            : `${plural(blocked, "request")} matched the default filter lists of Brave Shields, the ad and tracker blocker built into the Brave browser, while loading normally.`
          : "No requests matched the default filter lists of Brave Shields, the ad and tracker blocker built into the Brave browser.",
      detail: simulated
        ? "Measured with Brave's own ad-block engine and default filter lists actively blocking (network requests only, so no cosmetic or CNAME-based blocking). Blocked requests are not in this run's totals, and requests a blocked script would have made never started."
        : "Computed with Brave's own ad-block engine and default filter lists in classification mode: matched requests were not blocked by the scanner and remain in this report's observed request counts. Matching shows what Shields would target on this visit's traffic; an actual Shields visit blocks these and also prevents their follow-on requests, so this number is neither a measured block count nor the total effect.",
      // The catalog count is run-wide: it is a separate labeling layer, not a
      // proven subset of the Shields-matched requests, so the sentence must
      // not chain the two sets together.
      evidence: `The hand-curated service catalog separately labels ${plural(run.counts.knownTrackerRequests, "request")} in this visit.`
    });
  }

  const censorshipNotes = runCensorshipNotes(run);
  const unsupportedFamilies = unsupportedEvidenceFamilies(run);
  // Methodology cards (an ineligible pair) are about this report, not the
  // site: "review-worthy signals" must reflect observed behavior only.
  const overallLevel = strongestLevel(
    findings.filter((finding) => finding.methodology !== true).map((finding) => finding.level)
  );
  const censoredQuiet =
    censorshipNotes.length > 0 && (overallLevel === "ok" || overallLevel === "quiet" || overallLevel === "info");
  const unsupportedQuiet =
    censorshipNotes.length === 0 &&
    unsupportedFamilies.length > 0 &&
    (overallLevel === "ok" || overallLevel === "quiet" || overallLevel === "info");
  findings.unshift({
    id: "bottom-line",
    icon: overallLevel === "ok" && !censoredQuiet && !unsupportedQuiet ? "check" : "alert",
    level: censoredQuiet || unsupportedQuiet ? "info" : overallLevel,
    title: censoredQuiet
      ? "Bottom line: the visit was cut short, so few signals is not a verdict"
      : unsupportedQuiet
        ? "Bottom line: this PageGraph report covers requests; other evidence was not captured"
      : overallLevel === "ok"
        ? "Bottom line: few review signals in this visit"
        : "Bottom line: this visit has review-worthy signals",
    lead: censoredQuiet
      ? `Evidence collection did not finish (${humanList(censorshipNotes, 2)}), so the quiet result reflects an interrupted recording, not a verdict about the site.`
      : unsupportedQuiet
        ? `Request evidence was recorded, but ${humanList(unsupportedFamilies)} evidence is unsupported by this producer. Those zero-valued fields are unavailable measurements, not observed absences.`
      : overallLevel === "ok"
        ? "The automated visit did not observe known third-party services, third-party cookies, or instrumented fingerprint-like calls."
        : `The scan observed signals a non-expert should not have to decode from raw request tables.${
            censorshipNotes.length > 0
              ? ` Evidence collection was also cut short (${humanList(censorshipNotes, 2)}), so activity counts are floors for this visit and end-state figures are snapshots of an interrupted recording.`
              : ""
          }`,
    detail: corpusIsUsable(corpus) && (domainsBenchmarkAllowed || cookiesBenchmarkAllowed)
      ? `The cards below translate the evidence into plain language. Where a measured distribution exists, severity ranks this visit against percentiles from the ${corpusBenchmarkScope(corpus)}, a curated set of popular, mostly commercial sites, not a random sample of the web, and otherwise uses fixed reference thresholds. The request log, domain table, and methodology remain below for verification.`
      : corpusIsUsable(corpus)
        ? "The cards below translate the evidence into plain language. This failed or incomplete evidence is not ranked against corpus percentiles; positive signals remain visible as lower bounds. The request log, domain table, and methodology remain below for verification."
        : "The cards below translate the evidence into plain language; severity reflects fixed reference thresholds, not measured population percentiles. The request log, domain table, and methodology remain below for verification.",
    evidence: `${plural(run.counts.totalRequests, "request")} observed in one controlled visit.`
  });

  // Emit every finding. The conditionals above bound this to at most ~9 cards,
  // all of them meaningful; a fixed cap here silently dropped the last-pushed
  // card (the fingerprinting finding) on Node Shields-comparison reports that
  // also surfaced a session-recording or input-monitoring signal.
  return findings;
}

function unconfirmedConsentInteractionFinding(view: ReportView, baseline: RunView, variant: RunView): Finding {
  const unresolved = [
    { label: "Accept all" as const, consent: baseline.consent },
    { label: "Reject all" as const, consent: variant.consent }
  ].filter(
    (entry) =>
      entry.consent !== null &&
      !consentChoiceVerified(entry.consent) &&
      (entry.consent.controlActivated || entry.consent.choiceState === "contradicted")
  );
  const contradicted = unresolved.some((entry) => entry.consent?.choiceState === "contradicted");
  const contradictionWithoutActivation = unresolved.some(
    (entry) => entry.consent?.choiceState === "contradicted" && entry.consent.controlActivated !== true
  );
  return {
    id: "consent-comparison",
    icon: "alert",
    level: contradicted ? "warn" : "info",
    // A contradictory registered-state observation is site evidence, not
    // merely a report-method caveat. Keep neutral unverified attempts out of
    // the bottom-line severity calculation, but let contradictions prevent a
    // reassuring bottom line.
    ...(contradicted ? {} : { methodology: true as const }),
    title: contradicted
      ? contradictionWithoutActivation
        ? "A registered consent-state observation contradicted a requested choice"
        : "The registered consent state contradicted a dispatched choice"
      : `${unresolved.length === 1 ? "A consent choice was" : "Consent choices were"} attempted, but not verified`,
    lead: unresolved
      .map((entry) =>
        entry.consent?.choiceState === "contradicted" && entry.consent.controlActivated !== true
          ? `The scanner read a registered state inconsistent with the requested ${entry.label} choice, but it did not activate that control.`
          : consentRegistrationSentence(view, entry.consent, entry.label)
      )
      .join(" "),
    detail:
      "The raw visits remain available as separate observations, but they do not support an accept-versus-reject outcome or a reassuring consent result unless both requested choices are verified as registered.",
    evidence: unresolved
      .map((entry) => `${entry.label}: ${entry.consent ? consentVerificationSummary(entry.consent) : "not attempted"}`)
      .join("; ")
  };
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
    methodology: true,
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
  view: ReportView,
  baseline: RunView,
  variant: RunView,
  rawCountsAllowed: boolean,
  classificationAllowed: boolean
): Finding {
  const acceptClicked = baseline.consent?.controlActivated === true;
  const rejectClicked = variant.consent?.controlActivated === true;
  const acceptTracking = trackerEntitySummaries(baseline.evidence).filter((entity) => !isOperationalEntity(entity));
  const rejectTracking = trackerEntitySummaries(variant.evidence).filter((entity) => !isOperationalEntity(entity));
  const rejectResponded = respondedTrackerEntityNames(variant.evidence);
  const requestsBefore = baseline.counts.thirdPartyRequests;
  const requestsAfter = variant.counts.thirdPartyRequests;
  const registration = consentRegistrationSentence(view, variant.consent, "Reject all");
  // The count juxtaposition is a raw-counts family delta; when that family is
  // not comparable across the two visits, the card keeps its per-visit story
  // but quotes no numbers side by side. The count labels come from what each
  // visit RECORDED: "21 with Accept all" on a visit that never clicked
  // anything would caption an unactivated visit as a consent choice.
  const evidence = rawCountsAllowed
    ? `Third-party requests: ${requestsBefore.toLocaleString("en-US")} ${
        acceptClicked ? "with the accept-all click" : "in the accept-attempt visit (no activation recorded)"
      }, ${requestsAfter.toLocaleString("en-US")} ${
        rejectClicked ? "with the reject-all click" : "in the reject-attempt visit (no activation recorded)"
      }.`
    : "Third-party request totals are not comparable across these two visits, so no count delta is quoted.";

  if (!acceptClicked && !rejectClicked) {
    return {
      id: "consent-comparison",
      icon: "cookie",
      level: "info",
      title: "No consent control activation was recorded in either visit",
      lead: "Neither visit recorded a control activation, so neither can be shown to reflect the choice it attempted, and this diff mostly shows run-to-run variance.",
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
      lead: `The ${clickedLabel} visit clicked the banner, but the ${missingLabel} visit recorded no control activation, so that run cannot be shown to reflect its choice and this diff does not measure the ${missingLabel.toLowerCase()} choice.`,
      detail:
        missingLabel === "Reject all"
          ? "Many banners offer no first-layer reject control and put refusal behind a settings layer this scanner does not navigate. That design is itself worth noting, but it can also mean this scanner's catalog simply does not recognize the control, so treat the asymmetry as a prompt to check the banner yourself."
          : "The accept visit recorded no control activation, so the accept side of this diff cannot be shown to reflect that choice. Treat the comparison as incomplete rather than as evidence about the site's consent behavior.",
      evidence
    };
  }

  if (rejectTracking.length > 0) {
    return {
      id: "consent-comparison",
      icon: "cookie",
      level: "warn",
      title: `Requests were sent to ${plural(rejectTracking.length, "tracking company", "tracking companies")} in the visit that clicked Reject all`,
      // The cross-arm contrast ("N appeared in the accept-click visit") is a
      // classification-family juxtaposition; without that family the card
      // keeps the reject-click visit's own facts only.
      lead: `In the visit where the scanner clicked Reject all, ${humanList(rejectTracking.map((entity) => entity.entity))} ${trackerResponseQualification(rejectTracking, rejectResponded)}${
        classificationAllowed
          ? ` (${plural(acceptTracking.length, "tracking company", "tracking companies")} appeared in the request log for the visit that clicked Accept all)`
          : ""
      }.`,
      detail: `${registration} ${CONSENT_WHOLE_VISIT_CAVEAT} It is a documented observation to review against the banner's promises, not a violation ruling. The diff below lists the services that appeared only in the visit that clicked Accept all.`,
      evidence
    };
  }

  // "No catalogued trackers" is an absence claim over the reject visit's
  // request evidence: censored collection makes it a floor, not reassurance.
  const rejectEvidenceCensored = familyCensoredOnRun(variant, "requests");
  const rejectChoiceVerified = variant.consent?.choiceState === "verified";
  const reassuring = !rejectEvidenceCensored && rejectChoiceVerified;
  return {
    id: "consent-comparison",
    icon: reassuring ? "shield-check" : "alert",
    level: reassuring ? "ok" : "info",
    title: rejectEvidenceCensored
      ? "No catalogued trackers before the reject-click visit was cut short"
      : rejectChoiceVerified
        ? "The visit that clicked Reject all had no catalogued trackers"
        : "No catalogued trackers were recorded in the reject-click visit",
    lead:
      classificationAllowed && acceptTracking.length > 0
        ? `The visit where the scanner clicked Reject all recorded no request to a catalogued tracking company, while the visit that clicked Accept all recorded requests to ${plural(
            acceptTracking.length,
            "tracking company",
            "tracking companies"
          )}.`
        : classificationAllowed
          ? "No request to a catalogued tracking company was recorded in either visit; on this page the two visits differed little because there was little to consent to."
          : "The visit where the scanner clicked Reject all recorded no request to a catalogued tracking company.",
    detail: `${registration} ${CONSENT_WHOLE_VISIT_CAVEAT} A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments), so treat this as an observed difference for this pair of visits.${
      rejectEvidenceCensored ? CENSORED_ABSENCE_NOTE : ""
    }`,
    evidence
  };
}

/**
 * An error or block page cannot support reassuring "no trackers here" cards.
 * Preserve affirmative observations as lower-bound evidence, downgrade every
 * absence card, and attach the scope boundary that says what the absence really
 * describes. Shared by the HTTP-status branch and the failed-navigation branch
 * so the two cannot drift apart.
 */
function hedgeAbsenceCards(findings: Finding[], scope: string): void {
  for (const finding of findings) {
    if (finding.level !== "ok" && finding.level !== "quiet") continue;
    finding.level = "info";
    finding.benchmark = undefined;
    finding.detail = `${finding.detail} ${scope}`;
  }
}

/**
 * Retry advice that matches the status class instead of assuming every failure
 * is a transient outage.
 *
 * The scanner announces itself as an undisguised headless browser and does not
 * evade bot detection, so a site that refuses automation refuses it on every
 * visit: telling that reader to "re-scan when it is reachable" sends them into a
 * loop against a site that answered immediately. Naming the likely cause is
 * disclosure of our own posture, not a claim about the site, so it stays hedged.
 */
function retryGuidance(status: number, run: RunView): string {
  const undisguisedAutomation = run.conditions.headless && run.conditions.automation !== "brave-pagegraph";
  if ((status === 401 || status === 403) && undisguisedAutomation) {
    return "The site answered, so it was reachable; it refused this visit. Refusing an openly automated browser is the most common reason for this status, and because this scanner does not disguise itself, re-scanning will usually return the same response.";
  }
  if (status === 401 || status === 403) {
    return "The site answered, so it was reachable; it refused this visit. Re-scanning returns the same response until whatever refused the request changes.";
  }
  if (status === 429) return "The site rate-limited this visit, so a later re-scan may succeed.";
  if (status === 404) return "That address did not exist on the site; check the URL rather than re-scanning it.";
  if (status >= 500) return "That is a server-side error, so a later re-scan may succeed.";
  return "Re-scan when the site serves the page.";
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
