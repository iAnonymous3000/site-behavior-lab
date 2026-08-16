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
  isTrackingEntity,
  isTrackingTrackerMatch,
  keystrokeLeakHashed,
  pixelEventEvidence,
  pixelEventSummaries,
  pixelFieldLabel,
  respondedTrackerEntityNames,
  shieldsRunMeasurement,
  trackerOwnershipBreakdown,
  trackerResponseQualification,
  trackingServiceRequests
} from "./report-insights";
import {
  reviewedOwnershipRelationship
} from "./reviewed-ownership";
import { isCurrentlyCheckablePolicyClaim } from "./privacy-policy";
import {
  comparisonArmViews,
  familyCensoredOnRun,
  runInCorpusDistributionPopulation,
  unsupportedEvidenceFamilies,
  type ClaimGate,
  type ReportView,
  type RunView
} from "./scan-report-views";
import { runCensorshipNotes } from "./scan-report-censorship";
import { displayHost, displayPublicUrl, humanList, plural } from "./text-format";
import type { NetworkRequestRecord, PrivacyPolicyClaimKind, ProvenanceChange } from "./types";
import {
  CONSENT_WHOLE_VISIT_CAVEAT,
  consentChoiceVerified,
  consentRegistrationSentence,
  consentVerificationSummary
} from "./report-consent-copy";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";
import {
  buildReportFacts,
  comparisonSupportsExactClaimDelta,
  retainedCountPhrase,
  strongestReportSeverity,
  type ClaimEligibility,
  type ReportClaimId,
  type ReportSeverity,
  type RunFacts
} from "./report-facts";

export type FindingLevel = ReportSeverity;

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
  /**
   * True on a card whose level is elevated ONLY because its detector did not
   * finish, with nothing actually observed. The bottom line summarizes observed
   * behavior, so an unfinished measurement must not make it say the scan
   * "observed signals" over a board where every card reads "No X observed".
   *
   * Distinct from `methodology`: that marks a card about this report's own
   * eligibility, which is never about the site at all. This marks a card that
   * WOULD be about the site if its measurement had completed.
   */
  incompleteOnly?: true;
  /** Structured meaning for fact-to-render consistency checks. */
  claim?: {
    id: ReportClaimId;
    mode: "presence" | "categorical-absence" | "qualified-absence" | "unavailable";
    scope: "requested-page" | "returned-document";
    eligibility: ClaimEligibility;
  };
};

function findingClaim(
  facts: RunFacts,
  id: ReportClaimId,
  mode: "presence" | "absence" | "unavailable"
): NonNullable<Finding["claim"]> {
  const eligibility = facts.claims[id];
  return {
    id,
    mode:
      mode === "presence"
        ? "presence"
        : mode === "unavailable"
          ? "unavailable"
          : eligibility.allowed
            ? "categorical-absence"
            : "qualified-absence",
    scope: facts.subject.describesSubject ? "requested-page" : "returned-document",
    eligibility
  };
}

function scopedAbsenceTitle(facts: RunFacts, id: ReportClaimId, title: string): string {
  const eligibility = facts.claims[id];
  if (eligibility.allowed) return title;
  const evidenceIncomplete = eligibility.blockers.some(
    (blocker) => blocker !== "subject-not-established"
  );
  if (facts.subject.kind === "http-error") {
    return `Returned HTTP ${facts.subject.status ?? "error"} error or block page${
      evidenceIncomplete ? " with incomplete evidence" : ""
    }: ${title} in retained evidence`;
  }
  if (facts.subject.kind === "interstitial" || facts.subject.kind === "unverified") {
    return `Could not verify the returned document${
      evidenceIncomplete ? " and its evidence was incomplete" : ""
    }: ${title} in retained evidence`;
  }
  if (facts.subject.kind === "failed") {
    return `Incomplete visit: ${title} in retained evidence`;
  }
  if (eligibility.blockers.includes("family-censored")) {
    return `Incomplete evidence: ${title} in retained evidence before collection stopped`;
  }
  if (eligibility.blockers.includes("detector-incomplete")) {
    return `Incomplete detector evidence: ${title} in the completed portion of this visit`;
  }
  return `Limited evidence: ${title} in the available portion of this visit`;
}

type BenchmarkMetric = "thirdPartyDomains" | "trackerEntities" | "thirdPartyCookies" | "fingerprintEvents";

/*
 * Fixed reference thresholds used as the FALLBACK severity bands. When a real
 * corpus exists (public/corpus-stats.json) and is large enough, the findings
 * rank against measured percentiles instead (see corpusBenchmark); these
 * hand-set bands only apply until the corpus passes CORPUS_MIN_SAMPLE.
 */
const FINDING_BENCHMARKS: Record<BenchmarkMetric, { label: string; elevated: number; high: number }> = {
  thirdPartyDomains: { label: "third-party domains", elevated: 15, high: 30 },
  trackerEntities: { label: "distinct tracking-service entities", elevated: 6, high: 12 },
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
  return strongestReportSeverity(levels);
}

// Blacklight's "GA Remarketing Audiences" signal: Google Analytics present AND the
// GA->DoubleClick sync host stats.g.doubleclick.net. Other *.g.doubleclick.net hosts
// (pubads/securepubads = publisher ads, cm = cookie matching) are NOT GA remarketing.
const GOOGLE_ANALYTICS_HOST = /(^|\.)(google-analytics\.com|googletagmanager\.com|analytics\.google\.com)$/;
const DOUBLECLICK_REMARKETING_HOST = /(^|\.)stats\.g\.doubleclick\.net$/;

/** Appended to any absence claim whose evidence family was censored. */
const CENSORED_ABSENCE_NOTE = " Evidence collection was cut short, so this covers only what was recorded before the cutoff.";

// Reader words for the recorded session-recording event types, in the order a
// card names them. The producing gate accepts any five of a sixteen-event
// vocabulary, so a fixed list of categories in the card would publish listener
// registrations the visit never observed: a pointer- and touch-only detection
// is a real detection, and it registered no scroll and no input listener.
// Event types outside this map are simply not named.
const LISTENER_EVENT_CATEGORIES: { category: string; events: string[] }[] = [
  { category: "mouse", events: ["mousedown", "mousemove", "mouseup"] },
  { category: "pointer", events: ["pointerdown", "pointermove", "pointerup"] },
  { category: "touch", events: ["touchmove", "touchstart"] },
  { category: "click", events: ["click"] },
  { category: "scroll", events: ["scroll"] },
  { category: "wheel", events: ["wheel"] },
  { category: "selection", events: ["selectionchange"] },
  { category: "visibility", events: ["visibilitychange"] },
  { category: "keyboard", events: ["keydown", "keyup"] },
  { category: "input", events: ["input"] }
];

/** The category words a detection's own recorded event types support. */
function listenerCoverageCategories(eventTypes: string[]): string[] {
  const observed = new Set(eventTypes.map((type) => type.trim().toLowerCase()));
  return LISTENER_EVENT_CATEGORIES.filter((entry) =>
    entry.events.some((event) => observed.has(event))
  ).map((entry) => entry.category);
}

function corpusBenchmarkScope(corpus: CorpusStats): string {
  const coverage = corpus.coverageSiteCount;
  if (corpus.cohorts && corpus.primaryCohortId) {
    return `report's exact schema, methodology, tracker-catalog, ServiceRole-taxonomy, metric-contract, producer, and Global Privacy Control cohort, with each percentile card naming its metric-specific measured-site denominator${
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

export function buildFindings(
  view: ReportView,
  corpusInput: CorpusStats | null,
  reportFacts = buildReportFacts(view),
  /**
   * The comparison arm the rest of the page is describing, from the headline.
   *
   * Three headline branches (both consent branches and the GPC "still
   * contacted" branch) describe the variant arm and set focusArm to it, and
   * everything else follows: the stat chips, the arm switcher's default and so
   * the metric grid, the traffic view and every evidence table, and even each
   * card's own "open the evidence" link. The board was the one surface left
   * pinned to the display run, so the same page stated two different counts for
   * "this visit" and each card's evidence link landed in an arm its numbers did
   * not come from.
   *
   * Passing it switches `facts`, and `run` is derived from `facts` below, so
   * the whole board moves together rather than splitting a third way.
   */
  focusArm?: "baseline" | "variant"
): Finding[] {
  const facts = (focusArm && reportFacts.arms?.[focusArm]) ?? reportFacts.display;
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
  const run = facts.run;
  const visibleDomain = displayHost(run.domain);
  const arms = comparisonArmViews(view);
  const axis = view.comparison?.axis ?? null;
  const ownership = facts.identity.ownership;
  const trackingEntities = facts.identity.trackingEntities;
  const operationalEntities = facts.identity.operationalEntities;
  const unclassifiedEntities = facts.identity.unclassifiedEntities;
  const trackingNames = trackingEntities.map((entity) => entity.entity);
  const operationalNames = operationalEntities.map((entity) => entity.entity);
  const unclassifiedNames = unclassifiedEntities.map((entity) => entity.entity);
  const respondedEntities = facts.identity.respondedEntities;
  const topCategories = Array.from(new Set(trackingEntities.flatMap((entity) => entity.categories))).slice(0, 3);
  const trackingCnameCloaks = run.evidence.cnameCloaks.filter((cloak) =>
    isTrackingTrackerMatch(cloak.tracker)
  );
  const trackingCnameNames = Array.from(
    new Set(trackingCnameCloaks.map((cloak) => cloak.tracker.entity))
  ).sort();
  const trackingCnameNameSet = new Set(trackingCnameNames);
  const catalogReach = facts.identity.coverage;
  // Quantify what the report could not name. "No known services matched" is
  // otherwise read as "no third parties", when it can equally mean the catalog
  // does not cover the ones that were there. This counts every namer the report
  // has, the service catalog and the consent-platform signatures, so it can
  // never claim a domain is unidentifiable that another card names outright.
  const catalogCoverageNote =
    catalogReach.thirdPartyHosts === 0
      ? ""
      : catalogReach.unidentifiedHosts === 0
        ? ` This scan identified an operator for every one of the ${plural(catalogReach.thirdPartyHosts, "third-party domain")} recorded here using catalog, consent-platform, reviewed-ownership, and CNAME evidence.`
        : ` This scan could not identify ${catalogReach.unidentifiedHosts} of the ${plural(catalogReach.thirdPartyHosts, "third-party host")} recorded here, so it cannot say who operates ${catalogReach.unidentifiedHosts === 1 ? "it" : "them"}. That is a limit of identity coverage, not evidence about the site.`;
  const catalogEntityNames = new Set(facts.identity.catalogEntities.map((entity) => entity.entity));
  const nonCatalogOutsideIdentityNames = facts.identity.outsideNames.filter(
    (name) => !catalogEntityNames.has(name) && !trackingCnameNameSet.has(name)
  );
  const nonCatalogSameOrganizationNames = facts.identity.sameOrganizationNames.filter(
    (name) => !catalogEntityNames.has(name) && !trackingCnameNameSet.has(name)
  );
  const nonCatalogIdentityNames = Array.from(
    new Set([...nonCatalogOutsideIdentityNames, ...nonCatalogSameOrganizationNames])
  ).sort();
  const cookiesUnsupported = facts.evidence.cookies.state === "unsupported";
  const fingerprintDetectorStatus = run.detectors?.["fingerprint-heuristics"]?.status;
  const fingerprintClaim = facts.claims["fingerprint-apis"];
  const detectorUnsupported =
    facts.evidence.fingerprinting.state === "unsupported" ||
    fingerprintDetectorStatus === "unsupported";
  const requestsCensored = facts.evidence.requests.state === "censored";
  const cookiesCensored = facts.evidence.cookies.state === "censored";
  // Raw fingerprint events live in the "fingerprinting" evidence family;
  // the fingerprint-heuristics detector owns the interpreted conclusions. An
  // unrelated detector-output failure must not make fingerprinting unavailable.
  const detectorCensored =
    facts.evidence.fingerprinting.state === "censored" ||
    (fingerprintDetectorStatus !== undefined && fingerprintDetectorStatus !== "complete") ||
    fingerprintClaim.blockers.includes("detector-incomplete");
  const pixelDetectorCensored = facts.claims["pixel-events"].blockers.some(
    (blocker) => blocker !== "subject-not-established"
  );
  // The distribution these percentiles rank against is built from plain first
  // visits only: corpus-stats-builder, entryEligibleForCorpusRollups, and the
  // researcher export all drop a post-choice consent arm from the denominator.
  // Ranking such an arm against it compares an accepted-cookies state to a
  // pre-consent population, in the direction that inflates the rank, on the
  // very page whose own bottom line says post-choice visits are excluded.
  //
  // Request-capped and request-censored runs are excluded for the same reason:
  // their activity counts are floors cut off mid-collection, and the builder
  // drops them from the distribution outright. runInCorpusDistributionPopulation
  // is the one predicate both sides now read, so the renderer cannot rank a run
  // against a population the builder defined to exclude it.
  //
  // A focused non-display arm is excluded on top of that. The corpus
  // distribution admits only lead runs, and the cohort selected above is keyed
  // by the DISPLAY run's identity, including its requested-GPC condition; a
  // GPC comparison's alarm headline focuses the GPC-on variant, whose counts
  // would otherwise rank against the gpc-off cohort under scope copy claiming
  // an exact-cohort match. The consent branches only dodged this because their
  // variant's consent mode already fails the population predicate. Fixed
  // reference thresholds still apply to a focused variant; only percentile
  // wording is withheld.
  const displayArm: "baseline" | "variant" =
    view.comparison?.temporalPair ? "variant" : "baseline";
  const boardDescribesDisplayRun =
    focusArm === undefined || view.reportType !== "comparison" || focusArm === displayArm;
  const benchmarkPopulationMatches =
    boardDescribesDisplayRun && runInCorpusDistributionPopulation(run);
  const domainsBenchmarkAllowed =
    benchmarkPopulationMatches && facts.claims["third-party-services"].benchmarkAllowed;
  const cookiesBenchmarkAllowed =
    benchmarkPopulationMatches && facts.claims["third-party-cookies"].benchmarkAllowed;
  // Corpus percentiles when available + large enough; otherwise fixed thresholds.
  const domainsBenchmark = domainsBenchmarkAllowed
    ? corpusBenchmark(corpus, "thirdPartyDomains", run.counts.thirdPartyDomains)
    : null;
  const cookiesBenchmark = cookiesBenchmarkAllowed
    ? corpusBenchmark(corpus, "thirdPartyCookies", run.counts.thirdPartyCookies)
    : null;
  // The severity the third-party-host COUNT carries on its own, independent of
  // whether the catalog identified anybody. This is the number the card's
  // benchmark badge already reports, so gating the level on it keeps the badge
  // and the level from contradicting each other: a visit to 40 uncatalogued
  // cross-site hosts used to render an "ok" card titled "No known services
  // matched" carrying a "High third-party domains count" badge, under a green
  // "few review signals" bottom line, while ReportFacts scored the same run
  // "loud". Scoped to the same condition as the badge so error pages and
  // non-comparable populations, which show no badge, keep their absence copy.
  const domainsCountLevel: FindingLevel = domainsBenchmarkAllowed
    ? domainsBenchmark
      ? domainsBenchmark.level
      : levelForMetric("thirdPartyDomains", run.counts.thirdPartyDomains)
    : "ok";
  const entityLevel = levelForMetric("trackerEntities", trackingEntities.length);
  const domainsLevel = domainsBenchmark
    ? domainsBenchmark.level
    : levelForMetric("thirdPartyDomains", run.counts.thirdPartyDomains);
  const thirdPartyLevel = strongestLevel([entityLevel, domainsLevel]);
  // True when entities are why this card is as severe as it is, so the badge
  // has to say so rather than reporting the domains percentile alone.
  const entityBenchmarkAlsoDrivesLevel =
    trackingEntities.length > 0 && strongestLevel([entityLevel, domainsLevel]) === entityLevel;
  // The level tracks the badge at every volume; the TITLE only stops saying
  // "no known services matched" once the count itself is elevated, where an
  // absence title over a warn/loud card would actively mislead.
  const uncataloguedVolume = domainsCountLevel === "warn" || domainsCountLevel === "loud";
  const findings: Finding[] = [];

  const operationalNote =
    operationalNames.length > 0
      ? ` The role taxonomy assigns these additional services explicitly non-tracking operational, support, security, consent-management, or hosting roles: ${humanList(operationalNames)}.`
      : "";
  const unclassifiedNote =
    unclassifiedNames.length > 0
      ? ` The role taxonomy leaves at least one catalog category unclassified for these identified services and assigns none a tracking-related role, so they are not counted as tracking-related: ${humanList(unclassifiedNames)}.`
      : "";
  const sameOrganizationNote =
    ownership.sameOrganizationDomainCount > 0
      ? ` ${plural(
          ownership.sameOrganizationDomainCount,
          "catalogued cross-site domain"
        )} ${
          ownership.sameOrganizationDomainCount === 1 ? "belongs" : "belong"
        } to the same reviewed ${ownership.sameOrganizationName ?? "organization"} domain family as the site, so that traffic is not evidence of disclosure to an outside company.`
      : "";

  const sessionReplayNames = facts.signals.fingerprint.sessionReplayNames;
  const sessionReplayNote =
    sessionReplayNames.length > 0
      ? ` Catalog labels include session-replay or behavior-analytics services: ${humanList(sessionReplayNames)}; the domain match alone does not prove that a recording occurred.`
      : "";

  // Major-platform findings are request-row claims. Domain/entity summaries
  // are intentionally lossy and can preserve only one of several exact
  // catalog matches on a shared host, so they must not decide which platform
  // names exist or how many requests belong to them.
  const cataloguedPlatformRequestRows = run.evidence.requests.filter(
    (request) =>
      request.thirdParty &&
      request.tracker !== null &&
      HEADLINE_PLATFORMS.includes(request.tracker.entity)
  );
  const outsideCataloguedPlatformRequestRows = cataloguedPlatformRequestRows.filter(
    (request) =>
      reviewedOwnershipRelationship(run.domain, request.domain).kind !==
      "same-organization"
  );
  const headlineRequestRows = outsideCataloguedPlatformRequestRows.filter(
    (request) => request.tracker !== null && isTrackingTrackerMatch(request.tracker)
  );
  const cataloguedNonTrackingHeadlineRequestRows =
    outsideCataloguedPlatformRequestRows.filter(
      (request) =>
        request.tracker !== null && !isTrackingTrackerMatch(request.tracker)
    );
  const platformNamesForRows = (
    rows: typeof cataloguedPlatformRequestRows
  ): string[] =>
    HEADLINE_PLATFORMS.filter((platform) =>
      rows.some((request) => request.tracker?.entity === platform)
    );
  const headlineNames = platformNamesForRows(headlineRequestRows);
  const cataloguedNonTrackingHeadlineNames = platformNamesForRows(
    cataloguedNonTrackingHeadlineRequestRows
  );
  // Platform domains the ownership map names but the service catalog does not
  // carry, for example fonts.googleapis.com and gstatic.com. The card's absence
  // claim is derived from catalog matches alone, so without these it published
  // a green "no requests to Google domains were observed" over an observed
  // request to exactly such a domain.
  const cataloguedHeadlineNames = new Set(
    cataloguedPlatformRequestRows.flatMap((request) =>
      request.tracker ? [request.tracker.entity] : []
    )
  );
  const sameOrganizationPlatformRequestRows = run.evidence.requests.filter(
    (request) => {
      if (!request.thirdParty) return false;
      const relationship = reviewedOwnershipRelationship(
        run.domain,
        request.domain
      );
      return (
        relationship.kind === "same-organization" &&
        HEADLINE_PLATFORMS.includes(relationship.organization)
      );
    }
  );
  const sameOrganizationPlatformNames = HEADLINE_PLATFORMS.filter(
    (platform) =>
      facts.identity.sameOrganizationNames.includes(platform) ||
      sameOrganizationPlatformRequestRows.some((request) => {
        const relationship = reviewedOwnershipRelationship(
          run.domain,
          request.domain
        );
        return (
          relationship.kind === "same-organization" &&
          relationship.organization === platform
        );
      })
  );
  const uncataloguedPlatformOrganizations = facts.identity.outsideNames.filter(
    (organization) =>
      HEADLINE_PLATFORMS.includes(organization) &&
      !cataloguedHeadlineNames.has(organization)
  );
  const sameOrganizationPlatformRequests =
    sameOrganizationPlatformRequestRows.length;
  const headlineRequests = headlineRequestRows.length;
  const cataloguedNonTrackingHeadlineRequests =
    cataloguedNonTrackingHeadlineRequestRows.length;
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
    const recipientCount = plural(keystrokeDetection.evidence.recipients.length, "cross-site domain");
    const sameOrganizationRecipients = keystrokeDetection.evidence.recipients.filter(
      (recipient) => reviewedOwnershipRelationship(run.domain, recipient).kind === "same-organization"
    );
    const recipientOwnershipNote =
      sameOrganizationRecipients.length > 0
        ? ` ${plural(
            sameOrganizationRecipients.length,
            "recipient domain"
          )} ${
            sameOrganizationRecipients.length === 1 ? "belongs" : "belong"
          } to the site's same reviewed organization, so that portion is not disclosure to an outside company.`
        : "";
    const fields = plural(keystrokeDetection.evidence.fieldsTyped, "form field");
    // A one-way hash is a stronger transformation signal and retains the loud
    // level, but neither encoding nor this frozen summary proves recipient
    // purpose, real-user handling, or timing within typing/blur/unload.
    const hashed = keystrokeLeakHashed(keystrokeDetection.evidence.encodings);
    findings.push({
      id: "keystroke-exfiltration",
      icon: "keyboard",
      level: hashed ? "loud" : "warn",
      title: hashed
        ? `A hashed form of synthetic input reached ${recipientCount} before submission`
        : `Synthetic form input reached ${recipientCount} before submission`,
      lead: hashed
        ? `When the scanner typed a unique test value into ${fields}, a one-way hash of that value appeared in requests to ${recipients} (${humanList(keystrokeDetection.evidence.encodings)}) without the form being submitted.`
        : `When the scanner typed a unique test value into ${fields}, that value appeared in requests to ${recipients} (${humanList(keystrokeDetection.evidence.encodings)}) without the form being submitted.`,
      detail: hashed
        ? `The synthetic value was hashed (${humanList(
            keystrokeDetection.evidence.encodings
          )}) before being sent. The report does not establish whether transmission happened during typing, blur, or unload, what the recipient used it for, or whether real visitor input follows the same path. The scanner types only synthetic values and never submits the form.${recipientOwnershipNote}`
        : `The synthetic value appeared in a recoverable form (${humanList(
            keystrokeDetection.evidence.encodings
          )}). The report does not establish whether transmission happened during typing, blur, or unload, why it was sent, or whether real visitor input follows the same path. The scanner types only synthetic values and never submits the form.${recipientOwnershipNote}`,
      evidence: `Synthetic test value appeared in requests to ${recipients} via ${humanList(keystrokeDetection.evidence.encodings)}.`,
      claim: findingClaim(facts, "keystroke-exfiltration", "presence")
    });
  }

  const cnameCloaks = trackingCnameCloaks;
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
      ),
      claim: findingClaim(facts, "cname-cloaking", "presence")
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
    // A framework endpoint identifies the tooling standard, not the vendor that
    // ran it, so it may not be printed in the slot a named platform occupies.
    // The catalog's kind is the single source: a host regex here disagreed
    // with the catalog on non-normalized uploaded bytes (mixed case, trailing
    // dot), naming IAB TCF in the vendor slot for exactly those reports.
    const frameworkEndpoint = consentPlatform.kind === "framework-endpoint";
    const consentPlatformPhrase = frameworkEndpoint
      ? `${consentPlatform.name}, a consent framework endpoint shared by many consent management platforms (the tooling that shows cookie banners) rather than one named platform`
      : `${consentPlatform.name}, a consent management platform (the tooling that shows cookie banners)`;
    findings.push({
      id: "consent-banner",
      icon: "cookie",
      level: preConsentTrackers > 0 ? "warn" : "info",
      title:
        preConsentTrackers > 0
          ? "Consent tooling and requests to tracking-service entities appeared before any choice"
          : frameworkEndpoint
            ? consentPlatformAnswered
              ? "A shared consent framework endpoint answered"
              : "A shared consent framework endpoint was requested"
            : consentPlatformAnswered
              ? "A consent management platform answered"
              : "A consent management platform was requested",
      lead:
        preConsentTrackers > 0
          ? `${visibleDomain} sent a request to ${consentPlatformPhrase}, and the request log included ${retainedCountPhrase(
              preConsentTrackers,
              "distinct catalogued tracking-related service",
              "distinct catalogued tracking-related services",
              facts.evidence.requests.state
            )} before the scanner made any consent choice${
              answeredPreConsentTrackers > 0
                ? `; ${plural(answeredPreConsentTrackers, "company", "companies")} answered`
                : requestsCensored
                  ? "; none of the retained matches recorded a response before collection stopped"
                  : "; none recorded a response"
            }.`
          : `${visibleDomain} sent a request to ${consentPlatformPhrase}, before the scanner made any consent choice.${
              frameworkEndpoint ? " This scan could not name the platform that served it." : ""
            } Tracker-service observations are reported separately so this positive tooling signal does not imply an absence.`,
      detail:
        'A request to the platform\'s loader proves the page attempted to fetch consent tooling; an observed response supports delivery, but neither fact proves a banner was visibly shown to this scanner. Banner display can vary by region and visit context. The scanner never clicks a banner in this mode, so this report records requests made before the scanner made a consent choice. It does not determine whether any request required consent or whether the site\'s behavior complied with applicable law. More tracking-service entities or requests may appear after "Accept" than this report captures, so the counts here are lower bounds for users who consent.',
      evidence: `${
        frameworkEndpoint ? "Consent framework endpoint" : "Consent platform"
      } detected via a request to ${consentPlatform.domain}.`,
      claim: findingClaim(facts, "consent-banner", "presence")
    });
  }

  const policy = run.evidence.privacyPolicy;
  if (policy) {
    // Each entry pairs a testable statement from the policy with the observed
    // evidence that cuts against it. Quotes come along so a reader can check
    // the sentence in context; this is a text match, never a legal reading.
    const conflicts: string[] = [];
    const quotes: string[] = [];
    const checkablePolicyClaims = policy.claims.filter(isCurrentlyCheckablePolicyClaim);
    const policyClaim = (kind: PrivacyPolicyClaimKind) =>
      checkablePolicyClaims.find((claim) => claim.kind === kind);

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
    const noSellingOrSharing = policyClaim("no-selling-or-sharing");
    const pixelsWithIdentifiers = pixelEventSummaries(run.evidence).filter((pixel) => pixel.advancedMatching.length > 0);
    if (noSellingOrSharing && pixelsWithIdentifiers.length > 0) {
      conditionalConflicts.push(
        `the policy says personal information is not sold or shared, and advertising events to ${humanList(
          pixelsWithIdentifiers.map((pixel) => pixel.product)
        )} carried populated personal-identifier fields in this visit; IF those fields held real visitor data, many regulators treat that as sharing, but the scanner only checks those fields for being non-empty and never stores the values`
      );
      quotes.push(noSellingOrSharing.quote);
    }

    // Deliberately NOT checked as a conflict: an "honors GPC" claim. Honoring
    // GPC means not selling or sharing data, which request counts cannot
    // observe; a site can honor the signal while loading identical requests.
    // The claim stays in the stored policy summary, but no request-count
    // comparison is allowed to contradict it.
    //
    // Enforced rather than remembered: COMPARED_POLICY_CLAIM_KINDS in
    // privacy-policy.ts is what isCurrentlyCheckablePolicyClaim filters on, so
    // a kind with no comparison here cannot be counted as checkable, and the
    // card falls to its "nothing this scan can check" branch instead of
    // publishing a reassurance backed by zero comparisons.

    // Frozen producer arrays recorded every catalogued entity as a potential
    // tracking company. Rebind them to the current, positive ServiceRole
    // classification before publishing a disclosure claim; an operational or
    // unclassified catalog match must not become tracking merely because an
    // older producer put its name in one of these arrays.
    const policyMentionedEntityNames = new Set(policy.mentionedEntities);
    const policyUnmentionedEntityNames = new Set(policy.unmentionedEntities);
    const mentionedTrackingEntities = trackingNames.filter((entity) =>
      policyMentionedEntityNames.has(entity)
    );
    const unmentionedTrackingEntities = trackingNames.filter((entity) =>
      policyUnmentionedEntityNames.has(entity)
    );
    const namedCount = mentionedTrackingEntities.length;
    const totalObserved = namedCount + unmentionedTrackingEntities.length;
    const coverage =
      totalObserved > 0
        ? `${namedCount} of ${plural(totalObserved, "observed tracking company", "observed tracking companies")} named in the policy`
        : "no catalogued tracking companies observed to check against it";

    // A "nothing contradicted" reassurance is itself an absence claim over
    // the checked evidence, so censored collection hedges it.
    const policyAbsenceIneligible = !facts.claims["privacy-policy"].allowed;
    const policyEvidenceCensored = facts.claims["privacy-policy"].blockers.some(
      (blocker) => blocker !== "subject-not-established"
    );
    // The same rule applied to the other side of the comparison: with no
    // checkable statement extracted, "no checked statement contradicted" is
    // vacuously true and reads as a clean result from zero checks. 83 of the
    // committed reports publish exactly that, so this needs its own branch
    // rather than the reassuring default.
    const noCheckableClaims = checkablePolicyClaims.length === 0;
    // "Nothing could be checked" is a statement about the AUTOMATED CHECK, not
    // about the site -- this card's own lead says so. Left as ordinary evidence
    // it raised the bottom line to "this visit has review-worthy signals" on
    // gov.uk, whose every other card was ok and whose headline was the calm
    // "showed few catalogued or fingerprint-like signals". Two computations
    // were answering "is this visit quiet?" (calmEligible and the findings
    // board) and disagreeing on the same page.
    const policyCheckUnavailable =
      conflicts.length === 0 &&
      conditionalConflicts.length === 0 &&
      unmentionedTrackingEntities.length === 0 &&
      (policyAbsenceIneligible || noCheckableClaims);
    findings.push({
      id: "privacy-policy",
      icon: "file-text",
      ...(policyCheckUnavailable ? { methodology: true as const } : {}),
      level:
        conflicts.length > 0
          ? "warn"
          : conditionalConflicts.length > 0 || unmentionedTrackingEntities.length > 0
            ? "info"
            : policyAbsenceIneligible || noCheckableClaims
              ? "info"
              : "ok",
      title:
        conflicts.length > 0
          ? "The privacy policy says one thing; this visit shows another"
          : conditionalConflicts.length > 0
            ? "A policy statement may conflict with observed advertising events"
            : unmentionedTrackingEntities.length > 0
              ? "Tracking companies the privacy policy does not appear to name"
              : noCheckableClaims
                ? "Privacy policy read; it made no statement this scan can check"
                : scopedAbsenceTitle(
                    facts,
                    "privacy-policy",
                    "Privacy policy read; no checked statement contradicted"
                  ),
      lead:
        conflicts.length > 0
          ? `Comparing the site's own privacy policy against this visit: ${humanList(conflicts, 3)}.`
          : conditionalConflicts.length > 0
            ? `Comparing the site's own privacy policy against this visit: ${humanList(conditionalConflicts, 2)}.`
            : unmentionedTrackingEntities.length > 0
              ? `${humanList(unmentionedTrackingEntities)} ${unmentionedTrackingEntities.length === 1 ? "was" : "were"} sent requests during this visit, but the policy text matched none of the names this scan knows ${unmentionedTrackingEntities.length === 1 ? "that company" : "those companies"} by.`
              : noCheckableClaims
                ? `None of the statements this scan knows how to check appear in the policy text, so nothing was compared against this visit's evidence (${coverage}). That is a limit of the automated check, not a finding about the site either way.`
                : `The policy's checkable statements did not contradict this visit's evidence (${coverage}).`,
      detail:
        conflicts.length > 0 || conditionalConflicts.length > 0
          ? `Matched policy wording: ${quotes.map((quote) => `"${quote}"`).join(" / ")}. This is an automated sentence match against the policy's own text, quoted so it can be verified in context. Policies can define terms narrowly (such as what counts as selling or sharing), so treat this as a documented discrepancy to review, not a legal conclusion.`
          : unmentionedTrackingEntities.length > 0
            ? `Policies often disclose vendor categories rather than company names, so an unnamed vendor is a transparency gap worth reviewing, not automatically a violation.${namedCount > 0 ? ` Named in the policy: ${humanList(mentionedTrackingEntities)}.` : ""}`
            : `Statements checked automatically: blanket no-cookie claims, third-party-cookie claims, and combined do-not-sell-or-share claims against advertising-pixel identifier fields. Global Privacy Control claims are never checked against request counts, which cannot show whether selling or sharing stopped.${policyEvidenceCensored ? CENSORED_ABSENCE_NOTE : ""}`,
      evidence: `Policy at ${policy.url}; ${plural(checkablePolicyClaims.length, "checkable statement")} matched; ${coverage}.`,
      claim: findingClaim(
        facts,
        "privacy-policy",
        conflicts.length > 0 || conditionalConflicts.length > 0 || unmentionedTrackingEntities.length > 0
          ? "presence"
          : noCheckableClaims
            ? "unavailable"
            : "absence"
      )
    });
  }

  findings.push({
    id: "third-party-services",
    icon: "globe",
    level:
      trackingEntities.length > 0
        ? thirdPartyLevel
        : trackingCnameNames.length > 0
          ? "warn"
        : strongestLevel([
            operationalEntities.length > 0 ||
            unclassifiedEntities.length > 0 ||
            nonCatalogIdentityNames.length > 0 ||
            requestsCensored
              ? "info"
              : "ok",
            domainsCountLevel
          ]),
    title:
      trackingEntities.length > 0
        ? trackingEntities.every((entity) => respondedEntities.has(entity.entity))
          ? "Catalogued service domains recorded responses during this visit"
          : "Requests were dispatched to catalogued service domains"
        : trackingCnameNames.length > 0
          ? "Tracking services were identified behind first-party aliases"
        : operationalEntities.length > 0
          ? "Operational service matches were recorded"
          : unclassifiedEntities.length > 0
            ? "Identified services have unclassified functional roles"
          : nonCatalogOutsideIdentityNames.length > 0
            ? "Other third-party operators were identified outside the tracking-service catalog"
            : nonCatalogSameOrganizationNames.length > 0
              ? "Same-organization operators were identified across a site boundary"
            : uncataloguedVolume
              ? `${plural(
                  run.counts.thirdPartyDomains,
                  "cross-site host"
                )} recorded, none matched to the service catalog`
            : scopedAbsenceTitle(facts, "third-party-services", "No known services matched"),
    lead:
      trackingEntities.length > 0
        ? `${humanList(trackingNames)} appeared in the request log.`
        : trackingCnameNames.length > 0
          ? `DNS CNAME evidence identified ${humanList(trackingCnameNames)} behind first-party-looking hostnames.`
        : operationalEntities.length > 0
          ? `The catalog matched operational tools: ${humanList(operationalNames)}.`
          : unclassifiedEntities.length > 0
            ? `The catalog identified ${humanList(unclassifiedNames)}, but its read-time role taxonomy leaves at least one category unclassified and assigns ${unclassifiedEntities.length === 1 ? "that service" : "those services"} no tracking-related role.`
          : nonCatalogOutsideIdentityNames.length > 0
            ? `${humanList(nonCatalogOutsideIdentityNames)} were named by consent-platform signatures, reviewed ownership, or CNAME evidence without being classified as tracking services.`
            : nonCatalogSameOrganizationNames.length > 0
              ? `${humanList(nonCatalogSameOrganizationNames)} were named across a registrable-domain boundary, but the reviewed ownership map groups them with the site rather than an outside company.`
            : "This scan did not match any third-party domains to the service catalog or another identity source.",
    detail:
      trackingEntities.length > 0
        ? `A catalog match identifies a maintainer-reviewed service/domain mapping; it does not establish why an individual request occurred, what it carried, or whether profiling happened.${topCategories.length > 0 ? ` Functional catalog labels include ${humanList(topCategories)}.` : ""}${catalogCoverageNote}${sessionReplayNote}${operationalNote}${unclassifiedNote}${sameOrganizationNote}`
        : trackingCnameNames.length > 0
          ? `The read-time role taxonomy classifies the resolved CNAME targets as tracking-related. That identifies the service behind the alias, but does not establish the request's purpose, payload, or whether profiling occurred.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
        : operationalEntities.length > 0
          ? `The role taxonomy assigns these services explicitly non-tracking operational, support, security, consent-management, or hosting roles; the matches do not establish each request's purpose.${catalogCoverageNote}${unclassifiedNote}${sameOrganizationNote}${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
          : unclassifiedEntities.length > 0
            ? `Identification and functional classification are separate. An unclassified role is not evidence that a service was harmless, but it is also not a basis for calling the service tracking-related.${catalogCoverageNote}${sameOrganizationNote}${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
          : nonCatalogOutsideIdentityNames.length > 0
            ? `Operator identity and tracking classification are separate: naming an operator does not prove that a request was for tracking.${catalogCoverageNote}${sameOrganizationNote}${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
            : nonCatalogSameOrganizationNames.length > 0
              ? `A cross-site browser boundary is not automatically an outside-company disclosure. The ownership relation names the operator, while the absence of a catalog classification says nothing about the request's purpose.${catalogCoverageNote}${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
            : `No known operator or catalog entity was matched.${catalogCoverageNote}${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    // Counted per distinct HOST, not per registrable domain: two subdomains of
    // one company are two rows here. Calling them registrable-domain
    // boundaries overstated how many separate parties the visit reached.
    evidence:
      trackingEntities.length === 0 && trackingCnameCloaks.length > 0
        ? humanList(
            trackingCnameCloaks.map(
              (cloak) => `${cloak.host} → ${cloak.cname} (${cloak.tracker.entity})`
            ),
            4
          )
        : `${retainedCountPhrase(
            run.counts.thirdPartyRequests,
            "cross-site request",
            "cross-site requests",
            facts.evidence.requests.state
          )} across ${retainedCountPhrase(
            run.counts.thirdPartyDomains,
            "third-party host",
            "third-party hosts",
            facts.evidence.requests.state
          )}.`,
    // The LEVEL is the strongest of two metrics, so a badge naming only one of
    // them can read "below the median for third-party domains" on a card that
    // is warn because of tracking entities. Name every metric that actually
    // contributed, so the reason a card is severe is the reason the badge
    // gives. Deliberately NOT the converse fix of driving the level from the
    // badge's metric: that would drop real severity a reader should see.
    benchmark: trackingCnameNames.length > 0 || !domainsBenchmarkAllowed
      ? undefined
      : domainsBenchmark
        ? entityBenchmarkAlsoDrivesLevel
          ? `${domainsBenchmark.label} ${benchmarkLabel("trackerEntities", trackingEntities.length)}`
          : domainsBenchmark.label
        : trackingEntities.length > 0
          ? benchmarkLabel("trackerEntities", trackingEntities.length)
          : benchmarkLabel("thirdPartyDomains", run.counts.thirdPartyDomains)
    ,
    claim: findingClaim(
      facts,
      "third-party-services",
      trackingEntities.length > 0 ||
        trackingCnameNames.length > 0 ||
        operationalEntities.length > 0 ||
        unclassifiedEntities.length > 0 ||
        nonCatalogIdentityNames.length > 0
        ? "presence"
        : "absence"
    )
  });

  findings.push({
    id: "named-platforms",
    icon: "network",
    level:
      headlineNames.length === 0
        ? cataloguedNonTrackingHeadlineNames.length > 0 ||
          sameOrganizationPlatformNames.length > 0 ||
          uncataloguedPlatformOrganizations.length > 0 ||
          requestsCensored
          ? "info"
          : "ok"
        : headlineNames.length >= 3
          ? "warn"
          : "info",
    title:
      headlineNames.length > 0
        ? "Requests were dispatched to catalogued major-platform domains"
        : cataloguedNonTrackingHeadlineNames.length > 0
          ? "Major-platform domains were identified without a tracking-role assignment"
        : sameOrganizationPlatformNames.length > 0
          ? "Major-platform domains matched within the site's reviewed organization"
          : uncataloguedPlatformOrganizations.length > 0
            ? "Requests were dispatched to major-platform domains the catalog does not carry"
            : scopedAbsenceTitle(facts, "named-platforms", "No requests to major-platform domains were recorded"),
    lead:
      headlineNames.length > 0
        ? `This visit dispatched requests to catalogued domains for ${humanList(headlineNames)}.`
        : cataloguedNonTrackingHeadlineNames.length > 0
          ? `This visit dispatched requests to catalogued domains for ${humanList(cataloguedNonTrackingHeadlineNames)}, but the read-time role taxonomy assigns no tracking-related role to those matches.`
        : sameOrganizationPlatformNames.length > 0
          ? `${humanList(sameOrganizationPlatformNames)} domains appeared across a registrable-domain boundary, but the reviewed ownership map groups them with the site rather than an outside company.`
          : uncataloguedPlatformOrganizations.length > 0
            ? `This visit dispatched requests to ${humanList(
                uncataloguedPlatformOrganizations
              )} domains that the reviewed ownership map names, though the service catalog carries no entry for them.`
            : "No requests to catalogued Google, Meta, TikTok, X, Microsoft, LinkedIn, or Pinterest domains were observed in this visit.",
    detail:
      headlineNames.length > 0
        ? `The domain matches identify services, not the requests' purpose, payload, or whether any profile linking occurred.${sameOrganizationNote}`
        : cataloguedNonTrackingHeadlineNames.length > 0
          ? "Identification and functional classification are separate. These domain matches remain visible, but an operational or unclassified role is not enough to label the requests tracking-related."
        : sameOrganizationPlatformNames.length > 0
          ? "Cross-registrable-domain traffic remains counted in the report, but this reviewed ownership relationship does not support an outside-recipient disclosure claim. Naming the operator also does not prove request purpose."
          : uncataloguedPlatformOrganizations.length > 0
            ? `Asset and font hosts reach this state often: the ownership map establishes who operates the domain, and nothing here establishes the request's purpose or payload. These domains are not counted as catalog-matched requests.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
            : `Major-platform domains were not observed in this single passive visit; interaction-gated requests could still load for real users.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence:
      headlineNames.length > 0
        ? `${retainedCountPhrase(
            headlineRequests,
            "request",
            "requests",
            facts.evidence.requests.state
          )} to these platforms.`
        : cataloguedNonTrackingHeadlineNames.length > 0
          ? `${retainedCountPhrase(
              cataloguedNonTrackingHeadlineRequests,
              "request",
              "requests",
              facts.evidence.requests.state
            )} to these catalogued platform domains.`
        : sameOrganizationPlatformNames.length > 0
          ? `${retainedCountPhrase(
              sameOrganizationPlatformRequests,
              "cross-site request",
              "cross-site requests",
              facts.evidence.requests.state
            )} mapped to a reviewed same-organization domain family.`
          : `${retainedCountPhrase(
              run.counts.thirdPartyDomains,
              "cross-site domain",
              "cross-site domains",
              facts.evidence.requests.state
            )} seen overall.`
    ,
    claim: findingClaim(
      facts,
      "named-platforms",
      headlineNames.length > 0 ||
        cataloguedNonTrackingHeadlineNames.length > 0 ||
        sameOrganizationPlatformNames.length > 0 ||
        uncataloguedPlatformOrganizations.length > 0
        ? "presence"
        : "absence"
    )
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
          : pixelDetectorCensored
            ? "This reads each pixel request's event type (such as PageView, ViewContent, or Purchase), not just that a pixel request was recorded. Pixel decoding was incomplete for one or more request bodies, so whether other pixel requests carried advanced-matching identifier fields is unknown."
            : "This reads each pixel request's event type (such as PageView, ViewContent, or Purchase), not just that a pixel request was recorded. No advanced-matching identifier fields were observed in this passive visit; interaction-gated events could still carry them for real users.",
      evidence: humanList(pixelEvents.map(pixelEventEvidence), 4),
      claim: findingClaim(facts, "pixel-events", "presence")
    });
  }

  if (run.conditions.automation === "brave-pagegraph") {
    findings.push({
      id: "pagegraph-provenance",
      icon: "network",
      level: provenanceHighlights.length > 0 ? "info" : "quiet",
      // Whether the PageGraph export carried initiator metadata is a property
      // of THIS ARTIFACT, not of the site, so it must not move the bottom line
      // the way an observed signal does (same rule as the ineligible-pair and
      // unverified-consent cards).
      methodology: true,
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
        ? scopedAbsenceTitle(facts, "ga-remarketing", "Google Analytics present, no remarketing signal")
        : scopedAbsenceTitle(facts, "ga-remarketing", "No Google Analytics observed"),
    lead: gaRemarketingOn
      ? "Google Analytics fired a sync to stats.g.doubleclick.net, the request Blacklight treats as the marker that advertising and remarketing features are on."
      : googleAnalyticsPresent
        ? "Google Analytics was observed, but no DoubleClick remarketing sync appeared in this visit."
        : "This visit did not contact Google Analytics.",
    detail: gaRemarketingOn
      ? "This Analytics-to-DoubleClick request pattern is consistent with an advertising or remarketing integration. It does not prove that an audience was populated, a profile was matched, or what the request carried."
      : googleAnalyticsPresent
        ? `Standard analytics collection was observed, without the stats.g.doubleclick.net advertising sync.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`
        : `Neither Google Analytics nor its remarketing sync was observed in this visit.${requestsCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence: gaRemarketingOn
      ? "Google Analytics host plus a request to stats.g.doubleclick.net (Blacklight's remarketing marker)."
      : googleAnalyticsPresent
        ? "Google Analytics host observed; no stats.g.doubleclick.net request."
        : "No google-analytics.com or googletagmanager.com requests."
    ,
    claim: findingClaim(facts, "ga-remarketing", gaRemarketingOn ? "presence" : "absence")
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
        : scopedAbsenceTitle(facts, "third-party-cookies", "No third-party cookies observed"),
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
        ? "The scanner observed cookie metadata whose domain crossed the scanned site's registrable-domain boundary. This report does not retain cookie values or partition keys, so it does not establish whether a cookie was a persistent identifier or could recognize a visitor across sites."
        : `This does not prove the site never uses cookies; it means this visit did not observe third-party cookies.${cookiesCensored ? CENSORED_ABSENCE_NOTE : ""}`,
    evidence: cookiesUnsupported
      ? "Unsupported by the request-only PageGraph r2 producer."
      : `${plural(run.counts.cookies, "cookie")} total in this report.`,
    benchmark: !cookiesBenchmarkAllowed
      ? undefined
      : cookiesBenchmark
        ? cookiesBenchmark.label
        : benchmarkLabel("thirdPartyCookies", run.counts.thirdPartyCookies)
    ,
    claim: findingClaim(
      facts,
      "third-party-cookies",
      cookiesUnsupported ? "unavailable" : run.counts.thirdPartyCookies > 0 ? "presence" : "absence"
    )
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
      const names = humanList(entry.detection.evidence.thirdPartyOrigins.map(displayPublicUrl));
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
    // Named from this detection's own event types, never from the vocabulary
    // the gate draws on, so the lead cannot claim coverage of an event class
    // no listener in this visit was registered for.
    const sessionCategories = sessionRecordingDetection
      ? listenerCoverageCategories(sessionRecordingDetection.detection.evidence.eventTypes)
      : [];

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
            ? sessionCategories.length > 0
              ? `A third-party script registered broad ${humanList(
                  sessionCategories,
                  LISTENER_EVENT_CATEGORIES.length
                )} listener coverage during the visit.`
              : "A third-party script registered broad interaction listener coverage during the visit."
            : `${humanList(sessionReplayNames)} appeared in the request log.`,
      detail:
        "This is a behavioral instrumentation signal from listener registration, stack-attributed script origins, and known-vendor requests: it shows a script was positioned to observe interaction, not that anything was transmitted. On scanners that run the active keystroke-capture probe, actual transmission is tested separately (a synthetic value is typed, never real input, and no typed values are collected); treat this card as a review prompt rather than proof.",
      evidence: humanList(behaviorNotes, 4),
      claim: findingClaim(facts, "session-recording-input-monitoring", "presence")
    });
  }

  const highEntropyDetections = facts.signals.fingerprint.highEntropyDetections;
  const highEntropyDetectionLabels = highEntropyDetections.map(detectionLabel);
  const topFingerprintApis = run.evidence.fingerprintEvents.slice(0, 3).map((event) => event.api);
  const fingerprintEventLead = fingerprintClaim.exactCountAllowed
    ? `${plural(
        run.counts.fingerprintEvents,
        "high-entropy API call",
        "high-entropy API calls"
      )} appeared in the instrumentation log.`
    : fingerprintClaim.lowerBound
      ? `At least ${plural(
          run.counts.fingerprintEvents,
          "retained high-entropy API call",
          "retained high-entropy API calls"
        )} appeared in the incomplete instrumentation log.`
      : `The incomplete instrumentation log retained ${plural(
          run.counts.fingerprintEvents,
          "high-entropy API call record",
          "high-entropy API call records"
        )}; this is not an exact total.`;
  const fingerprintEventEvidence = fingerprintClaim.exactCountAllowed
    ? `${plural(
        run.evidence.fingerprintEvents.length,
        "API family",
        "API families"
      )} recorded.`
    : `Retained incomplete evidence includes ${plural(
        run.evidence.fingerprintEvents.length,
        "API event record"
      )}; no exact API-family total is available.`;
  findings.push({
    id: "fingerprint-apis",
    icon: "fingerprint",
    // Elevated to "info" with nothing observed means the detector did not
    // finish, not that the site did something. Mark it so the bottom line can
    // tell those apart; see the `incompleteOnly` docblock on Finding.
    ...(!detectorUnsupported &&
    detectorCensored &&
    highEntropyDetections.length === 0 &&
    run.counts.fingerprintEvents === 0
      ? { incompleteOnly: true as const }
      : {}),
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
          : scopedAbsenceTitle(facts, "fingerprint-apis", "No fingerprint-like API calls observed"),
    lead:
      detectorUnsupported
        ? "This request-only PageGraph import does not capture fingerprinting or detector evidence."
        : highEntropyDetections.length > 0
        ? `${detectorCensored ? "At least " : ""}${plural(
            highEntropyDetections.length,
            "behavioral heuristic"
          )} matched${detectorCensored ? " in retained evidence" : ""}: ${humanList(highEntropyDetectionLabels, 5)}.`
        : run.counts.fingerprintEvents > 0
          ? fingerprintEventLead
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
        : fingerprintEventEvidence,
    claim: findingClaim(
      facts,
      "fingerprint-apis",
      detectorUnsupported
        ? "unavailable"
        : highEntropyDetections.length > 0 || run.counts.fingerprintEvents > 0
          ? "presence"
          : "absence"
    )
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
  const fingerprintComparisonAllowed = comparisonSupportsExactClaimDelta(
    view,
    reportFacts,
    "fingerprint-apis"
  );

  if (arms && axis === "shields") {
    if (pairGate && !pairGate.allowed) {
      findings.unshift(ineligibleComparisonFinding("shields-comparison", "This Shields comparison is not conclusive", pairGate));
    } else {
      // SIGNED deltas per allowed family (variant minus baseline; negative =
      // fewer with blocking on), classified as decreased / increased / mixed
      // / flat. Never clamped and never summed across families: a pair with
      // more third-party requests but one fewer tracking-related service request is a
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
          label: "tracking-related service requests",
          singular: "tracking-related service request",
          value:
            trackingServiceRequests(arms.variant.evidence) -
            trackingServiceRequests(arms.baseline.evidence)
        });
      }
      if (fingerprintComparisonAllowed) {
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
              ? "Lower values observed across comparable metrics in the Brave-list blocking attempt"
              : direction === "increased"
                ? "Higher values observed across comparable metrics in the Brave-list blocking attempt"
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
          }${engineNote ? `${engineNote.trim()} ` : ""}A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments), so treat this as ${
            direction === "flat" && removedEntityNames.length === 0
              ? "no observed difference for this pair of visits, not evidence that blocking removes nothing"
              : "an observed difference, not a measured blocking rate"
          }.`,
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
          label: "tracking-related service requests",
          singular: "tracking-related service request",
          value:
            trackingServiceRequests(arms.variant.evidence) -
            trackingServiceRequests(arms.baseline.evidence)
        });
      }
      if (fingerprintComparisonAllowed) {
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
              ? "Lower values observed across comparable metrics in the visit with a privacy signal"
              : direction === "increased"
                ? "Higher values observed across comparable metrics in the visit with a privacy signal"
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
          // The card's own title and lead say "no change" on the flat branch,
          // so asserting "An observed difference" in the same card contradicts
          // it. Same sentence d3fd83e removed from the headline.
          //
          // `direction` is computed from signed COUNT deltas alone, while
          // `removedEntityNames` is a set difference over entities. They are
          // independent, and both fire together on the commonest case the
          // caveat itself names: ad rotation swaps Criteo for Taboola at equal
          // counts. Denying a difference one sentence after naming a service
          // seen in only one visit would be a worse claim than the one this
          // replaces, so the denial is conditioned on BOTH being empty.
          detail: `${
            removedEntityNames.length > 0 ? `Services only seen in the visit without the signal: ${humanList(removedEntityNames)}. ` : ""
          }${
            direction === "flat" && removedEntityNames.length === 0
              ? "No observed difference for this pair of visits, which is not proof the site received or honored the signal"
              : "An observed difference for this pair of visits, not proof the site received or honored the signal"
          }. A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments).`,
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
  const loadFailureStatus = facts.subject.kind === "http-error" ? facts.subject.status : null;
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
      title: `Bottom line: the requested page returned HTTP ${loadFailureStatus}`,
      lead: `The requested page responded with HTTP ${loadFailureStatus}, so this report reflects the returned error or block document, not the site's normal behavior.`,
      detail: `Tracker, cookie, storage, and fingerprinting signals here describe that returned document. They are retained evidence, not a privacy result for the site's normal page. ${retryGuidance(
        loadFailureStatus
      )} The request log and methodology below still show exactly what was observed.`,
      evidence: `${plural(run.counts.totalRequests, "request")} observed before or with the error response.`
    });
    return findings;
  }

  if (facts.subject.kind === "unverified") {
    hedgeAbsenceCards(
      findings,
      "The scanner could not verify that the rendered document was the requested page, so this absence does not describe the site."
    );
    findings.unshift({
      id: "bottom-line",
      icon: "alert",
      level: "info",
      title: `Bottom line: ${visibleDomain}'s rendered page subject was not verified`,
      lead:
        "The bounded page-content collector was unavailable or unreadable, so the scanner could not establish that the rendered document was the requested page.",
      detail:
        "Tracker, cookie, storage, and fingerprinting counts remain raw evidence from that unverified document, not a positive privacy conclusion about the site's normal behavior. Re-scan for a verified page load.",
      evidence: `${plural(run.counts.totalRequests, "request")} retained from the unverified page subject.`
    });
    return findings;
  }

  if (facts.subject.kind === "interstitial") {
    hedgeAbsenceCards(
      findings,
      "The scanner found a suspected challenge or soft block, so this absence describes only the interstitial, not the site."
    );
    findings.unshift({
      id: "bottom-line",
      icon: "alert",
      level: "info",
      title: `Bottom line: ${visibleDomain} showed a suspected challenge or soft block`,
      lead:
        "Multiple signals indicate that the successful HTTP response was a robot check, CAPTCHA, or blocking consent interstitial rather than the requested page.",
      detail:
        "Tracker, cookie, storage, and fingerprinting counts here come from an incomplete visit to that interstitial, not a positive privacy conclusion about the site's normal behavior. Re-scan for a complete page load; the request log and methodology below still show exactly what was observed.",
      evidence: `${plural(run.counts.totalRequests, "request")} retained from the suspected interstitial.`
    });
    return findings;
  }

  // A recorded failed run with no numeric status is not an unknown-but-quiet
  // visit. Frozen r2 deliberately maps otherwise-valid 600-999 navigation
  // statuses to null and records this marker; lead with the failed navigation
  // while withholding the exact code rather than manufacturing one.
  if (facts.subject.kind === "failed") {
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
      title: `Bottom line: ${visibleDomain}'s main page did not complete a trustworthy load`,
      lead: statusUnrepresentable
        ? "The site returned an HTTP status outside this frozen report format's representable range. The status field is left empty rather than coerced to a value the site never sent, and the navigation is recorded as failed."
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
  const shieldsMeasurement = facts.signals.shields.measurement;
  if (shieldsMeasurement) {
    const blocked = shieldsMeasurement.count;
    const simulated = shieldsMeasurement.kind === "engine-blocked";
    const requestState = facts.evidence.requests.state;
    const blockedPhrase = retainedCountPhrase(
      blocked,
      "request",
      "requests",
      requestState
    );
    const totalPhrase = retainedCountPhrase(
      run.counts.totalRequests,
      "request",
      "requests",
      requestState
    );
    findings.unshift({
      id: "shields-blocked",
      icon: "shield-check",
      level: blocked === 0 ? "ok" : blocked >= 10 ? "warn" : "info",
      title:
        blocked > 0
          ? simulated
            ? `Brave's blocking engine stopped ${blockedPhrase} in this visit`
            : requestState === "complete"
              ? `${blocked.toLocaleString("en-US")} of ${plural(
                  run.counts.totalRequests,
                  "request"
                )} matched Brave Shields filter lists`
              : `${blockedPhrase} out of ${totalPhrase} matched Brave Shields filter lists`
          : scopedAbsenceTitle(
              facts,
              "shields-blocked",
              simulated
                ? "No requests were stopped by Brave's blocking engine"
                : "No requests matched Brave Shields filter lists"
            ),
      lead:
        blocked > 0
          ? simulated
            ? `Brave's ad-block engine running Shields' default filter lists stopped ${blockedPhrase} from loading, a block simulation in this scanner's browser, not a live Brave-browser visit.`
            : `${blockedPhrase} matched the default filter lists of Brave Shields, the ad and tracker blocker built into the Brave browser, while loading normally.`
          : "No requests matched the default filter lists of Brave Shields, the ad and tracker blocker built into the Brave browser.",
      detail: simulated
        ? "Measured with Brave's own ad-block engine and default filter lists actively blocking (network requests only, so no cosmetic or CNAME-based blocking). Blocked requests are not in this run's totals, and requests a blocked script would have made never started."
        : "Computed with Brave's own ad-block engine and default filter lists in classification mode: matched requests were not blocked by the scanner and remain in this report's observed request counts. Matching shows what Shields would target on this visit's traffic; an actual Shields visit blocks these and also prevents their follow-on requests, so this number is neither a measured block count nor the total effect.",
      // The catalog count is run-wide: it is a separate labeling layer, not a
      // proven subset of the Shields-matched requests, so the sentence must
      // not chain the two sets together.
      evidence: `The hand-curated service catalog separately matched ${retainedCountPhrase(
        run.counts.knownTrackerRequests,
        "request row",
        "request rows",
        requestState
      )} in this visit.`,
      claim: findingClaim(facts, "shields-blocked", blocked > 0 ? "presence" : "absence")
    });
  }

  const censorshipNotes = runCensorshipNotes(run);
  const unsupportedFamilies = unsupportedEvidenceFamilies(run);
  const activityCensoredFamilies = [
    facts.evidence.requests.state === "censored"
      ? {
          label: "request evidence",
          effect: "request counts are retained lower bounds"
        }
      : null,
    facts.evidence.cookies.state === "censored"
      ? {
          label: "cookie evidence",
          effect: "cookie counts are an incomplete end-state snapshot"
        }
      : null,
    facts.evidence.storage.state === "censored"
      ? {
          label: "storage evidence",
          effect: "storage counts are an incomplete end-state snapshot"
        }
      : null
  ].filter(
    (entry): entry is { label: string; effect: string } => entry !== null
  );
  const activityEvidenceCensored = activityCensoredFamilies.length > 0;
  const activityCensoringEffects = humanList(
    activityCensoredFamilies.map((entry) => entry.effect)
  );
  // Methodology cards (an ineligible pair) are about this report, not the
  // site: "review-worthy signals" must reflect observed behavior only.
  const overallLevel = strongestLevel(
    findings.filter((finding) => finding.methodology !== true).map((finding) => finding.level)
  );
  const censoredQuiet =
    activityEvidenceCensored &&
    (overallLevel === "ok" || overallLevel === "quiet" || overallLevel === "info");
  const unsupportedQuiet =
    !activityEvidenceCensored &&
    unsupportedFamilies.length > 0 &&
    (overallLevel === "ok" || overallLevel === "quiet" || overallLevel === "info");
  // "quiet" is a NULL RESULT, not a signal: it is the level a flat comparison
  // delta or an absent-provenance note carries. Reading it as review-worthy put
  // an alert icon and "this visit has review-worthy signals" over a board whose
  // every substantive card said ok.
  //
  // That holds only because no metric benchmark may rank a positive count as
  // "quiet". Both benchmark producers now agree that any nonzero observation is
  // at least "info": levelForMetric above, and corpusBenchmark in
  // corpus-stats.ts. corpusBenchmark used to return "quiet" for a below-median
  // count, which broke this premise silently -- the board published "did not
  // observe ... third-party cookies" over a card saying they were present.
  // corpus-stats.test.ts pins the invariant so it cannot drift back.
  const quietEnough = overallLevel === "ok" || overallLevel === "quiet";
  // The severity the SITE actually earned, ignoring cards that are elevated
  // only because their measurement did not finish. Without this, one detector
  // failing to complete on an otherwise silent visit published "The scan
  // observed signals" over a board whose every card read "No X observed" --
  // the same class the comment above describes for `quiet`, re-entered through
  // `info`. A detector loss is not covered by `censoredQuiet`, whose families
  // are requests, cookies and storage only.
  const observedLevel = strongestLevel(
    findings
      .filter((finding) => finding.methodology !== true && finding.incompleteOnly !== true)
      .map((finding) => finding.level)
  );
  const detectorQuiet =
    !censoredQuiet &&
    !unsupportedQuiet &&
    !quietEnough &&
    findings.some((finding) => finding.incompleteOnly === true) &&
    (observedLevel === "ok" || observedLevel === "quiet");
  findings.unshift({
    id: "bottom-line",
    icon: quietEnough && !censoredQuiet && !unsupportedQuiet ? "check" : "alert",
    level: censoredQuiet || unsupportedQuiet || detectorQuiet ? "info" : overallLevel,
    title: censoredQuiet
      ? "Bottom line: activity evidence was cut short, so few signals is not a verdict"
      : unsupportedQuiet
        ? "Bottom line: this PageGraph report covers requests; other evidence was not captured"
      : detectorQuiet
        ? "Bottom line: no listed activity observed, but a detector did not finish"
      : quietEnough
        ? "Bottom line: few review signals in this visit"
        : "Bottom line: this visit has review-worthy signals",
    lead: censoredQuiet
      ? `Evidence collection did not finish for ${humanList(
          activityCensoredFamilies.map((entry) => entry.label)
        )}, so the quiet result reflects incomplete activity evidence, not a verdict about the site. The scoped effect is that ${activityCensoringEffects}.${
          censorshipNotes.length > 0
            ? ` Recorded cause: ${humanList(censorshipNotes, 2)}.`
            : ""
        }`
      : unsupportedQuiet
        ? `Request evidence was recorded, but ${humanList(unsupportedFamilies)} evidence is unsupported by this producer. Those zero-valued fields are unavailable measurements, not observed absences.`
      : detectorQuiet
        ? `The automated visit did not observe known third-party services, third-party cookies, or instrumented fingerprint-like calls. A detector did not finish, so that absence is not established for its scope; its own card states what was retained.${
            censorshipNotes.length > 0 ? ` Recorded cause: ${humanList(censorshipNotes, 2)}.` : ""
          }`
      : quietEnough
        ? "The automated visit did not observe known third-party services, third-party cookies, or instrumented fingerprint-like calls."
        : `The scan observed signals a non-expert should not have to decode from raw request tables.${
            activityEvidenceCensored
              ? ` Some activity evidence was also incomplete: ${activityCensoringEffects}.`
              : censorshipNotes.length > 0
                ? " Some detector evidence was incomplete; each affected detector card states its own retained or unavailable scope, while completed request, cookie, and storage measurements keep their recorded exactness."
              : ""
          }`,
    detail: corpusIsUsable(corpus) && (domainsBenchmarkAllowed || cookiesBenchmarkAllowed)
      ? `The cards below translate the evidence into plain language. Where a measured distribution exists, severity ranks this visit against percentiles from the ${corpusBenchmarkScope(corpus)}, a curated set of popular, mostly commercial sites, not a random sample of the web, and otherwise uses fixed reference thresholds. The request log, domain table, and methodology remain below for verification.`
      : corpusIsUsable(corpus)
        ? "The cards below translate the evidence into plain language. This failed or incomplete evidence is not ranked against corpus percentiles; positive signals remain visible as lower bounds. The request log, domain table, and methodology remain below for verification."
        : "The cards below translate the evidence into plain language; severity reflects fixed reference thresholds, not measured population percentiles. The request log, domain table, and methodology remain below for verification.",
    evidence: `${retainedCountPhrase(
      run.counts.totalRequests,
      "request",
      "requests",
      facts.evidence.requests.state
    )} observed in one controlled visit.`
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
  const otherEntities = new Set(
    trackerOwnershipBreakdown(other.evidence, other.domain).otherOrUnreviewed
      .filter(isTrackingEntity)
      .map((entity) => entity.entity)
  );
  return trackerOwnershipBreakdown(run.evidence, run.domain).otherOrUnreviewed
    .filter(isTrackingEntity)
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
  const acceptTracking = trackerOwnershipBreakdown(
    baseline.evidence,
    baseline.domain
  ).otherOrUnreviewed.filter(isTrackingEntity);
  const rejectTracking = trackerOwnershipBreakdown(
    variant.evidence,
    variant.domain
  ).otherOrUnreviewed.filter(isTrackingEntity);
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
      // Neither visit activated a control, so this card's own detail says "No
      // claim about the site's consent behavior can be made from this pair of
      // visits". It is a report fact, and the committed wikipedia.org report
      // 20260702-68f6a5e7 proved the cost of leaving it as site evidence: a
      // calm "showed few catalogued or fingerprint-like signals" headline over
      // an alert "this visit has review-worthy signals" bottom line, with every
      // other card ok.
      methodology: true,
      title: "No consent control activation was recorded in either visit",
      lead: "Neither visit recorded a control activation, so neither can be shown to reflect the choice it attempted, and this diff mostly shows run-to-run variance.",
      detail:
        "Many consent banners are only shown to visitors in regions where the law requires them (the EEA, UK, or California), so this scanner's location may simply not be served one; a banner may also use controls this scanner's catalog does not recognize, or a click may have been dispatched on a candidate that showed no observable reaction within the scanner's confirmation window. No claim about the site's consent behavior can be made from this pair of visits.",
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
      // Activation, not clickability. The producer writes the same unactivated
      // record for a search that found no control and for a click it dispatched
      // on a control that never visibly responded, and the wire cannot tell the
      // two apart. A title saying the control could not be clicked, and a
      // detail offering only missing-control and unmatched-control causes, both
      // state as fact something this pair of visits did not establish.
      title: `Only the ${clickedLabel} control's activation was recorded`,
      lead: `The ${clickedLabel} visit clicked the banner, but the ${missingLabel} visit recorded no control activation, so that run cannot be shown to reflect its choice and this diff does not measure the ${missingLabel.toLowerCase()} choice.`,
      detail:
        missingLabel === "Reject all"
          ? "Several situations produce this record and the report cannot tell them apart: the banner may offer no first-layer reject control and put refusal behind a settings layer this scanner does not navigate, the control may have been present in a form this scanner's catalog does not match, or a click may have been dispatched on a candidate that showed no observable reaction within the scanner's confirmation window. Treat the asymmetry as a prompt to check the banner yourself, not as a finding about how the banner is built."
          : "The accept visit recorded no control activation, so the accept side of this diff cannot be shown to reflect that choice. Treat the comparison as incomplete rather than as evidence about the site's consent behavior.",
      evidence
    };
  }

  if (rejectTracking.length > 0) {
    return {
      id: "consent-comparison",
      icon: "cookie",
      level: "warn",
      title: `Requests were sent to ${plural(rejectTracking.length, "distinct catalogued tracking-related service")} in the visit that clicked Reject all`,
      // The cross-arm contrast ("N appeared in the accept-click visit") is a
      // classification-family juxtaposition; without that family the card
      // keeps the reject-click visit's own facts only.
      lead: `In the visit where the scanner clicked Reject all, ${humanList(rejectTracking.map((entity) => entity.entity))} ${trackerResponseQualification(rejectTracking, rejectResponded)}${
        classificationAllowed
          ? ` (${plural(acceptTracking.length, "distinct catalogued tracking-related service")} appeared in the request log for the visit that clicked Accept all)`
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
        ? `The visit where the scanner clicked Reject all recorded no request to a catalogued tracking-related service, while the visit that clicked Accept all recorded requests to ${plural(
            acceptTracking.length,
            "distinct catalogued tracking-related service"
          )}.`
        : classificationAllowed
          ? "No request to a catalogued tracking-related service was recorded in either visit; this describes only the two observed visits, not whether there was little to consent to."
          : "The visit where the scanner clicked Reject all recorded no request to a catalogued tracking-related service.",
    // "An observed difference" is only true when there was one. This card also
    // fires when NEITHER visit recorded a catalogued tracking-related service,
    // where the honest caveat is about the absence rather than about a delta.
    detail: `${registration} ${CONSENT_WHOLE_VISIT_CAVEAT} A single paired comparison can also reflect run-to-run variance (ad rotation, caching, experiments), so treat this as ${
      classificationAllowed && acceptTracking.length > 0
        ? "an observed difference for this pair of visits"
        : "what these two visits recorded, not evidence that the choice made no difference"
    }.${rejectEvidenceCensored ? CENSORED_ABSENCE_NOTE : ""}`,
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
    if (
      finding.claim?.mode !== "categorical-absence" &&
      finding.claim?.mode !== "qualified-absence"
    ) {
      continue;
    }
    finding.level = "info";
    finding.benchmark = undefined;
    if (!finding.detail.includes(scope)) finding.detail = `${finding.detail} ${scope}`;
    finding.claim = { ...finding.claim, mode: "qualified-absence", scope: "returned-document" };
  }
}

/**
 * Retry advice that matches the status class instead of assuming every failure
 * is a transient outage.
 *
 * A 401 or 403 proves that this visit was denied, not why. Authentication,
 * authorization policy, automation filtering, and other controls can return
 * the same status, so retry advice must keep the cause unresolved.
 */
function retryGuidance(status: number): string {
  if (status === 401 || status === 403) {
    return "The site answered and denied this visit. The status alone cannot distinguish authentication, access policy, automation filtering, or another cause, so a later re-scan may or may not differ.";
  }
  if (status === 429) return "The site rate-limited this visit, so a later re-scan may succeed.";
  if (status === 404) {
    return "The requested address returned 404; verify the URL. The status does not establish why that response was returned.";
  }
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
    const label = `${displayHost(request.domain)}: ${summary.primary}${summary.secondary ? ` (${summary.secondary})` : ""}`;
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
    change.script ? `script ${displayProvenanceChangeActor(change.script)}` : "",
    change.initiator ? `initiator ${displayProvenanceChangeActor(change.initiator)}` : "",
    change.injectedBy ? `injected by ${displayProvenanceChangeActor(change.injectedBy)}` : "",
    change.tracker ? `${change.tracker.entity} · ${change.tracker.category}` : ""
  ].filter(Boolean);
  return parts.length > 0 ? humanList(parts, 3) : "provenance supplied";
}

function displayProvenanceChangeActor(value: string): string {
  // Frozen comparison rows can prefix a non-script initiator type (for
  // example "parser ") to an actor URL. Preserve that recorded type while
  // still formatting the privacy-reduced locator that follows it.
  const urlIndex = value.search(/https?:\/\//i);
  if (urlIndex >= 0) {
    return `${value.slice(0, urlIndex)}${displayPublicUrl(value.slice(urlIndex))}`;
  }
  return displayHost(value);
}

function provenanceActorDisplay(domain: string | undefined, url: string | undefined, type?: string): string | null {
  const actor = domain ? displayHost(domain) : url ? displayPublicUrl(url) : undefined;
  if (!actor) return null;
  const normalizedType = type?.trim().toLowerCase();
  if (!normalizedType || normalizedType === "script" || normalizedType === "unknown") return actor;
  return `${normalizedType} ${actor}`;
}
