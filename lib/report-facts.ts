import { consentPlatformForDomain } from "./consent-banner";
import {
  HEADLINE_PLATFORMS,
  crossSiteListenerDetection,
  fingerprintDetection,
  highEntropyDetections,
  isOperationalEntity,
  isTrackingEntity,
  isTrackingTrackerMatch,
  isUnclassifiedEntity,
  keystrokeLeakHashed,
  respondedTrackerEntityNames,
  scanLoadFailureStatus,
  scanPageSubjectUnverified,
  scanSuspectedChallengeOrSoftBlock,
  shieldsRunMeasurement,
  trackerEntitySummaries,
  trackerOwnershipBreakdown,
  type CrossSiteListenerDetection,
  type ShieldsRunMeasurement,
  type TrackerEntitySummary,
  type TrackerOwnershipBreakdown
} from "./report-insights";
import {
  reviewedOrganizationForDomain,
  reviewedOwnershipRelationship,
  type ReviewedOwnershipRelationship
} from "./reviewed-ownership";
import {
  comparisonArmViews,
  displayRunView,
  familyCensoredOnRun,
  familyUnsupportedOnRun,
  requestEvidenceState,
  runCensorshipNotes,
  unsupportedEvidenceFamilies,
  type ReportView,
  type RunView
} from "./scan-report-views";
import {
  EVIDENCE_FAMILIES,
  type DetectorId,
  type EvidenceFamily
} from "./scan-report-v2";
import { R2_NAVIGATION_STATUS_UNREPRESENTABLE } from "./scan-report-v2-http-status";
import type { FingerprintDetectionSummary } from "./types";

/**
 * Structured report truth shared by every human-facing consumer.
 *
 * `ReportView` is the version-independent wire seam. `ReportFacts` is the
 * claim seam: it separates observations from interpretation, keeps evidence
 * availability family-scoped, and makes absence eligibility explicit. A
 * renderer may choose different prose, but it must not re-decide these facts.
 */

export type ReportSeverity = "ok" | "quiet" | "info" | "warn" | "loud";

export type EvidenceState = "complete" | "censored" | "unsupported";

export type EvidenceFamilyFact = {
  family: EvidenceFamily;
  state: EvidenceState;
  reasons: string[];
};

export type ReportClaimId =
  | "third-party-services"
  | "named-platforms"
  | "ga-remarketing"
  | "third-party-cookies"
  | "fingerprint-apis"
  | "session-recording-input-monitoring"
  | "keystroke-exfiltration"
  | "storage-keys"
  | "cname-cloaking"
  | "pixel-events"
  | "consent-banner"
  | "shields-blocked"
  | "privacy-policy";

export type ClaimBlocker =
  | "subject-not-established"
  | "family-censored"
  | "family-unsupported"
  | "detector-incomplete";

export type ClaimEligibility = {
  /** Whether a categorical absence may be attributed to the requested page. */
  allowed: boolean;
  blockers: ClaimBlocker[];
  families: EvidenceFamily[];
  detectors: DetectorId[];
  subjectScope: "requested-page" | "returned-document";
  /** Exact counts are unavailable under family or detector incompleteness. */
  exactCountAllowed: boolean;
  lowerBound: boolean;
  benchmarkAllowed: boolean;
};

export type RunSubjectFact = {
  kind: "requested-page" | "http-error" | "unverified" | "interstitial" | "failed";
  describesSubject: boolean;
  status: number | null;
  statusUnrepresentable: boolean;
  reasons: string[];
};

export type IdentitySource = "catalog" | "cmp" | "ownership" | "cname";

export type IdentityNamer = {
  source: IdentitySource;
  name: string;
};

export type IdentifiedHostFact = {
  host: string;
  requests: number;
  namers: IdentityNamer[];
  relationship: ReviewedOwnershipRelationship["kind"];
  /** Every exact third-party request-row catalog identity recorded for this host. */
  catalogMatches: TrackerEntitySummary[];
  /** Catalog classification remains separate from operator identity. */
  tracker: TrackerEntitySummary | null;
};

export type RunIdentityFacts = {
  catalogEntities: TrackerEntitySummary[];
  trackingEntities: TrackerEntitySummary[];
  operationalEntities: TrackerEntitySummary[];
  /** Services with an unresolved catalog category and no tracking-bearing assignment. */
  unclassifiedEntities: TrackerEntitySummary[];
  ownership: TrackerOwnershipBreakdown;
  respondedEntities: Set<string>;
  cmpNames: string[];
  cnameNames: string[];
  ownershipNames: string[];
  allNames: string[];
  outsideNames: string[];
  sameOrganizationNames: string[];
  majorPlatformNames: string[];
  hosts: IdentifiedHostFact[];
  identifiedHosts: string[];
  unidentifiedHosts: string[];
  cnameAliases: {
    host: string;
    cname: string;
    name: string;
    relationship: ReviewedOwnershipRelationship["kind"];
  }[];
  coverage: {
    thirdPartyHosts: number;
    identifiedHosts: number;
    unidentifiedHosts: number;
  };
};

export type RunSignalFacts = {
  fingerprint: {
    eventCount: number;
    apiFamilies: number;
    highEntropyDetections: FingerprintDetectionSummary[];
    sessionRecording: CrossSiteListenerDetection | undefined;
    inputMonitoring: CrossSiteListenerDetection | undefined;
    sessionReplayNames: string[];
    apiActivityObserved: boolean;
    listenerCoverageObserved: boolean;
    replayVendorObserved: boolean;
  };
  cookies: {
    total: number;
    thirdParty: number;
  };
  storage: {
    entries: number;
  };
  shields: {
    measurement: ShieldsRunMeasurement | null;
    severity: ReportSeverity;
  };
};

export type RunFacts = {
  run: RunView;
  subject: RunSubjectFact;
  evidence: Record<EvidenceFamily, EvidenceFamilyFact>;
  claims: Record<ReportClaimId, ClaimEligibility>;
  identity: RunIdentityFacts;
  signals: RunSignalFacts;
  censorshipNotes: string[];
  unsupportedFamilies: string[];
  requestEvidenceState: "complete" | "capped" | "incomplete";
  strongestObservedSeverity: ReportSeverity;
  /**
   * Deliberately conservative and corpus-independent. A calm headline is
   * eligible only when no positive review signal exists and every supported
   * evidence family completed. Corpus percentiles can therefore never promote
   * a metric under an already reassuring headline.
   */
  calmEligible: boolean;
};

export type ReportFacts = {
  view: ReportView;
  display: RunFacts;
  runs: RunFacts[];
  arms: { baseline: RunFacts; variant: RunFacts } | null;
  /** null on single reports; exact recorded subject identity on comparisons. */
  sameSubject: boolean | null;
};

type ClaimRequirement = {
  families: EvidenceFamily[];
  /**
   * A shared evidence family can carry independent detector products. When
   * present, only these exact capture-loss details censor this claim.
   */
  familyDetails?: Partial<Record<EvidenceFamily, readonly string[]>>;
  detectors?: DetectorId[];
  count: "monotonic" | "snapshot" | "none";
};

/**
 * Claim-to-evidence relation. This replaces prose/regex guesses about which
 * family an absence card depends on.
 */
export const REPORT_CLAIM_REQUIREMENTS: Readonly<Record<ReportClaimId, ClaimRequirement>> = {
  "third-party-services": { families: ["requests"], count: "monotonic" },
  "named-platforms": { families: ["requests"], count: "monotonic" },
  "ga-remarketing": { families: ["requests"], count: "monotonic" },
  "third-party-cookies": { families: ["cookies"], count: "snapshot" },
  "fingerprint-apis": {
    families: ["fingerprinting"],
    detectors: ["fingerprint-heuristics"],
    count: "monotonic"
  },
  "session-recording-input-monitoring": {
    families: ["detector-output"],
    familyDetails: {
      "detector-output": ["public-fingerprint-detections"]
    },
    detectors: ["fingerprint-heuristics"],
    count: "none"
  },
  "keystroke-exfiltration": {
    families: ["detector-output"],
    familyDetails: {
      "detector-output": [
        "keystroke-probe",
        "keystroke-probe-capture",
        "public-fingerprint-detections"
      ]
    },
    detectors: ["keystroke-exfiltration"],
    count: "none"
  },
  "storage-keys": { families: ["storage"], count: "snapshot" },
  "cname-cloaking": {
    families: ["detector-output"],
    familyDetails: {
      "detector-output": ["cname-lookups", "public-cname-cloaks"]
    },
    detectors: ["cname-uncloaking"],
    count: "none"
  },
  "pixel-events": {
    families: ["requests", "detector-output"],
    familyDetails: {
      "detector-output": ["pixel-decode", "public-pixel-events"]
    },
    detectors: ["pixel-events"],
    count: "monotonic"
  },
  "consent-banner": {
    families: ["requests", "detector-output", "consent-verification"],
    familyDetails: {
      "detector-output": ["consent-banner"],
      "consent-verification": ["public-consent-observations"]
    },
    detectors: ["consent-banner"],
    count: "none"
  },
  "shields-blocked": { families: ["requests"], count: "monotonic" },
  "privacy-policy": {
    families: ["requests", "cookies", "detector-output"],
    familyDetails: {
      "detector-output": [
        "policy-link-candidates",
        "policy-visit",
        "public-policy-claims",
        "public-policy-entities"
      ]
    },
    detectors: ["privacy-policy"],
    count: "none"
  }
};

const SEVERITY_ORDER: ReportSeverity[] = ["ok", "quiet", "info", "warn", "loud"];

export function strongestReportSeverity(levels: readonly ReportSeverity[]): ReportSeverity {
  return levels.reduce(
    (strongest, level) =>
      SEVERITY_ORDER.indexOf(level) > SEVERITY_ORDER.indexOf(strongest) ? level : strongest,
    "ok"
  );
}

export function buildReportFacts(view: ReportView): ReportFacts {
  const runs = view.runs.map(buildRunFacts);
  const displayRun = displayRunView(view);
  const display = runs.find((facts) => facts.run === displayRun) ?? buildRunFacts(displayRun);
  const armViews = comparisonArmViews(view);
  const arms = armViews
    ? {
        baseline: runs.find((facts) => facts.run === armViews.baseline) ?? buildRunFacts(armViews.baseline),
        variant: runs.find((facts) => facts.run === armViews.variant) ?? buildRunFacts(armViews.variant)
      }
    : null;
  return {
    view,
    display,
    runs,
    arms,
    sameSubject: arms ? view.claims.decision?.sameSubject ?? false : null
  };
}

export function buildRunFacts(run: RunView): RunFacts {
  const subject = subjectFact(run);
  const evidence = Object.fromEntries(
    EVIDENCE_FAMILIES.map((family) => [family, evidenceFamilyFact(run, family)])
  ) as Record<EvidenceFamily, EvidenceFamilyFact>;
  const identity = identityFacts(run);
  const highEntropy = highEntropyDetections(run.evidence);
  const sessionRecording = crossSiteListenerDetection(run.evidence, "session-recording");
  const inputMonitoring = crossSiteListenerDetection(run.evidence, "input-monitoring");
  const sessionReplayNames = identity.trackingEntities
    .filter((entity) => entity.categories.some((category) => category.toLowerCase().includes("session replay")))
    .map((entity) => entity.entity);
  const shieldsMeasurement = shieldsRunMeasurement(run);
  const shieldsSeverity = shieldsMeasurement
    ? shieldsMeasurement.count === 0
      ? "ok"
      : shieldsMeasurement.count >= 10
        ? "warn"
        : "info"
    : "ok";
  const signals: RunSignalFacts = {
    fingerprint: {
      eventCount: run.counts.fingerprintEvents,
      apiFamilies: new Set(run.evidence.fingerprintEvents.map((event) => event.api)).size,
      highEntropyDetections: highEntropy,
      sessionRecording,
      inputMonitoring,
      sessionReplayNames,
      apiActivityObserved: run.counts.fingerprintEvents > 0 || highEntropy.length > 0,
      listenerCoverageObserved: Boolean(sessionRecording || inputMonitoring),
      replayVendorObserved: sessionReplayNames.length > 0
    },
    cookies: { total: run.counts.cookies, thirdParty: run.counts.thirdPartyCookies },
    storage: { entries: run.counts.storageEntries },
    shields: { measurement: shieldsMeasurement, severity: shieldsSeverity }
  };
  const claims = Object.fromEntries(
    (Object.keys(REPORT_CLAIM_REQUIREMENTS) as ReportClaimId[]).map((claim) => [
      claim,
      claimEligibility(run, subject, evidence, REPORT_CLAIM_REQUIREMENTS[claim])
    ])
  ) as Record<ReportClaimId, ClaimEligibility>;
  const strongestObservedSeverity = observedSeverity(run, identity, signals);
  const calmClaimIds: ReportClaimId[] = [
    "third-party-services",
    "named-platforms",
    "third-party-cookies",
    "fingerprint-apis",
    "session-recording-input-monitoring",
    "keystroke-exfiltration",
    "cname-cloaking",
    "pixel-events",
    "consent-banner",
    "privacy-policy"
  ];
  const calmEligible =
    subject.describesSubject &&
    run.quality.outcome === "complete" &&
    calmClaimIds.every((claim) => claims[claim].allowed) &&
    strongestObservedSeverity === "ok";

  return {
    run,
    subject,
    evidence,
    claims,
    identity,
    signals,
    censorshipNotes: runCensorshipNotes(run),
    unsupportedFamilies: unsupportedEvidenceFamilies(run),
    requestEvidenceState: requestEvidenceState(run),
    strongestObservedSeverity,
    calmEligible
  };
}

/**
 * A cross-arm numeric delta is exact only when both runs measured that claim
 * exactly. The wire's broad detector-findings comparison family can still be
 * comparable when the same detector stopped in both arms; equal failure is
 * instrument parity, not a pair of measurements.
 */
export function comparisonArmsHaveExactClaimMeasurements(
  facts: ReportFacts,
  claim: ReportClaimId
): boolean {
  if (
    !facts.arms?.baseline.claims[claim].exactCountAllowed ||
    !facts.arms.variant.claims[claim].exactCountAllowed
  ) {
    return false;
  }
  const detectors = REPORT_CLAIM_REQUIREMENTS[claim].detectors ?? [];
  return detectors.every((detector) => {
    const baseline = facts.arms?.baseline.run.detectors?.[detector]?.version;
    const variant = facts.arms?.variant.run.detectors?.[detector]?.version;
    return Boolean(
      baseline &&
        variant &&
        baseline.toLowerCase() !== "unknown" &&
        variant.toLowerCase() !== "unknown" &&
        baseline === variant
    );
  });
}

/**
 * A claim-specific detector delta is allowed only when its own two
 * measurements are exact and the pair has no blocker shared by every metric
 * family. Shared reasons are pair/environment constraints copied into every
 * family by the comparison evaluator; a detector-family-only reason can come
 * from an unrelated detector and must not flatten an exact sibling claim.
 */
export function comparisonSupportsExactClaimDelta(
  view: Pick<ReportView, "claims">,
  facts: ReportFacts,
  claim: ReportClaimId
): boolean {
  if (
    view.claims.pairComparison?.allowed !== true ||
    !comparisonArmsHaveExactClaimMeasurements(facts, claim)
  ) {
    return false;
  }
  const gates = Object.values(view.claims.familyDeltas ?? {});
  if (gates.length === 0) return false;
  const globallySharedBlocker = gates[0].reasons.some((reason) =>
    gates.every((gate) => gate.reasons.includes(reason))
  );
  return !globallySharedBlocker;
}

export function retainedCountLabel(value: number, state: EvidenceState): string {
  return state === "censored" ? `≥${value.toLocaleString("en-US")}` : value.toLocaleString("en-US");
}

/** Human-facing numeric value for a claim whose measurement may be partial or unavailable. */
export function claimCountValue(
  value: number,
  eligibility: Pick<ClaimEligibility, "exactCountAllowed" | "lowerBound">
): number | string {
  if (eligibility.exactCountAllowed) return value;
  if (eligibility.lowerBound && value > 0) return `≥${value.toLocaleString("en-US")}`;
  return "Incomplete";
}

export function retainedCountPhrase(
  value: number,
  singular: string,
  plural: string,
  state: EvidenceState
): string {
  const noun = value === 1 ? singular : plural;
  return state === "censored"
    ? `at least ${value.toLocaleString("en-US")} retained ${noun}`
    : `${value.toLocaleString("en-US")} ${noun}`;
}

/**
 * Compact exact-match copy for host-level summaries.
 *
 * The compatibility `DomainSummary.tracker` slot cannot represent a shared
 * host carrying multiple request-row matches. Renderers use this helper over
 * `IdentifiedHostFact.catalogMatches`, keeping every exact name/category and
 * directing readers to the row-level evidence when the host is mixed.
 */
export function identifiedHostCatalogMatchLabel(
  host: IdentifiedHostFact | undefined
): string | null {
  const matches = host?.catalogMatches ?? [];
  if (matches.length === 0) return null;
  const labels = matches.map(
    (match) => `${match.entity}: ${match.categories.join(", ")}`
  );
  return matches.length === 1
    ? labels[0]
    : `${labels.join("; ")} (multiple exact matches; see request rows)`;
}

function evidenceFamilyFact(run: RunView, family: EvidenceFamily): EvidenceFamilyFact {
  const state: EvidenceState = familyUnsupportedOnRun(run, family)
    ? "unsupported"
    : familyCensoredOnRun(run, family)
      ? "censored"
      : "complete";
  return {
    family,
    state,
    reasons: run.quality.byFamily?.[family]?.reasons ?? []
  };
}

function subjectFact(run: RunView): RunSubjectFact {
  const failureStatus = scanLoadFailureStatus(run.status);
  if (failureStatus !== null) {
    return {
      kind: "http-error",
      describesSubject: false,
      status: failureStatus,
      statusUnrepresentable: false,
      reasons: [...run.quality.reasons]
    };
  }
  if (scanPageSubjectUnverified(run)) {
    return {
      kind: "unverified",
      describesSubject: false,
      status: run.status,
      statusUnrepresentable: false,
      reasons: [...run.quality.reasons]
    };
  }
  if (scanSuspectedChallengeOrSoftBlock(run)) {
    return {
      kind: "interstitial",
      describesSubject: false,
      status: run.status,
      statusUnrepresentable: false,
      reasons: [...run.quality.reasons]
    };
  }
  if (run.quality.outcome === "failed") {
    return {
      kind: "failed",
      describesSubject: false,
      status: run.status,
      statusUnrepresentable:
        run.quality.facts?.captureLoss.some(
          (loss) => loss.detail === R2_NAVIGATION_STATUS_UNREPRESENTABLE
        ) === true,
      reasons: [...run.quality.reasons]
    };
  }
  return {
    kind: "requested-page",
    describesSubject: true,
    status: run.status,
    statusUnrepresentable: false,
    reasons: [...run.quality.reasons]
  };
}

function claimEligibility(
  run: RunView,
  subject: RunSubjectFact,
  evidence: Record<EvidenceFamily, EvidenceFamilyFact>,
  requirement: ClaimRequirement
): ClaimEligibility {
  const blockers = new Set<ClaimBlocker>();
  if (!subject.describesSubject) blockers.add("subject-not-established");
  for (const family of requirement.families) {
    const state = claimFamilyState(run, evidence, family, requirement.familyDetails?.[family]);
    if (state === "unsupported") blockers.add("family-unsupported");
    if (state === "censored") blockers.add("family-censored");
  }
  const detectors = requirement.detectors ?? [];
  const detectorStatuses = run.detectors
    ? detectors.map((detector) => run.detectors?.[detector]?.status ?? null)
    : [];
  const detectorIncomplete = detectorStatuses.some((status) => status !== "complete");
  if (detectorIncomplete) {
    blockers.add("detector-incomplete");
  }
  const familyStates = requirement.families.map((family) =>
    claimFamilyState(run, evidence, family, requirement.familyDetails?.[family])
  );
  const familyIncomplete = familyStates.some((state) => state !== "complete");
  const familyCensored = familyStates.some((state) => state === "censored");
  const familyUnsupported = familyStates.some((state) => state === "unsupported");
  // An unfinished detector's zero is not a measurement, so it may not be
  // published as an exact count or ranked against a population.
  //
  // Scoped to THIS CLAIM'S OWN detectors. Flattening it to every family the
  // registry touches censored unrelated measurements: `detector-output` is
  // shared, so an ordinary probe-disabled keystroke or policy detector would
  // have dragged down a completed pixel or CNAME claim that measured fine.
  // Only a PARTIAL detector supports a retained lower bound on its own.
  // Failed/skipped/unsupported can mean the measurement never ran, so absent
  // a recorded family loss they are unavailable rather than "at least zero."
  const detectorPartial =
    detectorStatuses.some((status) => status === "partial") &&
    detectorStatuses.every((status) => status === "complete" || status === "partial");
  const detectorUnavailable = detectorStatuses.some(
    (status) => status !== "complete" && status !== "partial"
  );
  const exactCountAllowed =
    requirement.count !== "none" && !familyIncomplete && !detectorIncomplete;
  return {
    allowed: blockers.size === 0,
    blockers: [...blockers],
    families: [...requirement.families],
    detectors: [...detectors],
    subjectScope: subject.describesSubject ? "requested-page" : "returned-document",
    exactCountAllowed,
    lowerBound:
      requirement.count === "monotonic" &&
      !familyUnsupported &&
      !detectorUnavailable &&
      (familyCensored || detectorPartial),
    benchmarkAllowed:
      exactCountAllowed &&
      subject.describesSubject &&
      run.quality.outcome === "complete"
  };
}

function claimFamilyState(
  run: RunView,
  evidence: Record<EvidenceFamily, EvidenceFamilyFact>,
  family: EvidenceFamily,
  details: readonly string[] | undefined
): EvidenceState {
  if (!details) return evidence[family].state;
  // Frozen v1 has no causal loss ledger. Preserve its legacy family state;
  // detector identity already defaults claims that need it to unavailable.
  if (!run.quality.facts) return evidence[family].state;
  return run.quality.facts.captureLoss.some(
    (loss) => loss.family === family && loss.detail !== undefined && details.includes(loss.detail)
  )
    ? "censored"
    : "complete";
}

/**
 * Aggregate the catalog matches the DOMAIN summaries carry. Request rows
 * stay the primary identity source (a shared host can carry several entities
 * across its rows while its summary keeps one). Stored reports cannot
 * diverge here: the reader's reconciliation rule requires domains to equal
 * summarizeDomains(rows). But presentation code also renders locally
 * constructed views that never passed the reader, and on those a party named
 * only by a summary was still named; the identity union (and the consistency
 * gate that reads it) must not lose the name.
 */
function domainTrackerEntitySummaries(
  domains: RunView["evidence"]["domains"]
): TrackerEntitySummary[] {
  const byEntity = new Map<string, TrackerEntitySummary>();
  for (const domain of domains) {
    if (!domain.thirdParty || !domain.tracker) continue;
    const current = byEntity.get(domain.tracker.entity) ?? {
      entity: domain.tracker.entity,
      requests: 0,
      domains: 0,
      categories: []
    };
    current.requests += domain.requests;
    current.domains += 1;
    if (!current.categories.includes(domain.tracker.category)) {
      current.categories.push(domain.tracker.category);
    }
    byEntity.set(domain.tracker.entity, current);
  }
  return [...byEntity.values()];
}

/**
 * Union row-derived and domain-derived entity summaries. Row-derived entries
 * are exact and stay untouched: a shared host's summary count spans rows that
 * belong to OTHER entities, so folding it into a row-present entity would
 * misattribute those rows. Domain summaries only contribute entities the
 * rows never named at all, where the summary is the only place the view
 * recorded that party.
 */
function mergeEntitySummaries(
  rowDerived: TrackerEntitySummary[],
  domainDerived: TrackerEntitySummary[]
): TrackerEntitySummary[] {
  const rowNamed = new Set(rowDerived.map((entity) => entity.entity));
  const additions = domainDerived.filter((candidate) => !rowNamed.has(candidate.entity));
  if (additions.length === 0) return rowDerived;
  return [...rowDerived, ...additions].sort(
    (a, b) => b.requests - a.requests || a.entity.localeCompare(b.entity)
  );
}

function identityFacts(run: RunView): RunIdentityFacts {
  const catalogEntities = mergeEntitySummaries(
    trackerEntitySummaries(run.evidence),
    domainTrackerEntitySummaries(run.evidence.domains)
  );
  const trackingEntities = catalogEntities.filter(isTrackingEntity);
  const operationalEntities = catalogEntities.filter(isOperationalEntity);
  const unclassifiedEntities = catalogEntities.filter(isUnclassifiedEntity);
  const ownership = trackerOwnershipBreakdown(run.evidence, run.domain);
  // Responded stays row-derived on purpose: a host summary aggregates its
  // statuses across rows that can carry DIFFERENT entities, so the summary's
  // (tracker, statuses) pair cannot prove that ITS entity was the one that
  // responded. A party named only by a summary renders as dispatched-only.
  const respondedEntities = respondedTrackerEntityNames(run.evidence);
  const hosts: IdentifiedHostFact[] = [];
  const cmpNames = new Set<string>();
  const ownershipNames = new Set<string>();

  for (const domain of run.evidence.domains) {
    if (!domain.thirdParty) continue;
    const namers: IdentityNamer[] = [];
    const exactHostEntities = trackerEntitySummaries({
      requests: run.evidence.requests.filter(
        (request) =>
          request.thirdParty && request.domain === domain.domain
      )
    });
    for (const entity of exactHostEntities) {
      namers.push({ source: "catalog", name: entity.entity });
    }
    if (
      domain.tracker &&
      !exactHostEntities.some((entity) => entity.entity === domain.tracker?.entity)
    ) {
      // The host's own summary named an entity no row carries. Impossible on
      // a reader-validated report, but locally constructed views render too.
      namers.push({ source: "catalog", name: domain.tracker.entity });
    }
    const cmp = consentPlatformForDomain(domain.domain);
    if (cmp) {
      cmpNames.add(cmp);
      namers.push({ source: "cmp", name: cmp });
    }
    const owner = reviewedOrganizationForDomain(domain.domain);
    if (owner) {
      ownershipNames.add(owner);
      namers.push({ source: "ownership", name: owner });
    }
    // The historical domain summary can retain only one match for a shared
    // host. Keep the singular compatibility field only when the exact rows
    // support one unambiguous entity; `namers` above preserves every match.
    // With no retained rows at all, the summary's own match is the one
    // unambiguous identity the report recorded for this host.
    const tracker =
      exactHostEntities.length === 1
        ? exactHostEntities[0]
        : exactHostEntities.length === 0 && domain.tracker
          ? {
              entity: domain.tracker.entity,
              requests: domain.requests,
              domains: 1,
              categories: [domain.tracker.category]
            }
          : null;
    hosts.push({
      host: domain.domain,
      requests: domain.requests,
      namers: dedupeNamers(namers),
      relationship: reviewedOwnershipRelationship(run.domain, domain.domain).kind,
      catalogMatches: exactHostEntities,
      tracker
    });
  }

  const cnameAliases = run.evidence.cnameCloaks.map((cloak) => ({
    host: cloak.host,
    cname: cloak.cname,
    name: cloak.tracker.entity,
    relationship: reviewedOwnershipRelationship(run.domain, cloak.host).kind
  }));
  const cnameNames = new Set(cnameAliases.map((cloak) => cloak.name));
  const allNames = new Set<string>([
    ...catalogEntities.map((entity) => entity.entity),
    ...cmpNames,
    ...ownershipNames,
    ...cnameNames
  ]);
  const outsideNames = new Set<string>();
  const sameOrganizationNames = new Set<string>();
  for (const host of hosts) {
    const target =
      host.relationship === "same-organization" ? sameOrganizationNames : outsideNames;
    for (const namer of host.namers) target.add(namer.name);
  }
  for (const alias of cnameAliases) {
    const target =
      alias.relationship === "same-organization" ? sameOrganizationNames : outsideNames;
    target.add(alias.name);
  }
  const majorPlatformNames = trackingEntities
    .map((entity) => entity.entity)
    .filter((name) => HEADLINE_PLATFORMS.includes(name))
    .sort();
  const identifiedHosts = hosts.filter((host) => host.namers.length > 0).map((host) => host.host);
  const unidentifiedHosts = hosts.filter((host) => host.namers.length === 0).map((host) => host.host);

  return {
    catalogEntities,
    trackingEntities,
    operationalEntities,
    unclassifiedEntities,
    ownership,
    respondedEntities,
    cmpNames: [...cmpNames].sort(),
    cnameNames: [...cnameNames].sort(),
    ownershipNames: [...ownershipNames].sort(),
    allNames: [...allNames].sort(),
    outsideNames: [...outsideNames].sort(),
    sameOrganizationNames: [...sameOrganizationNames].sort(),
    majorPlatformNames,
    hosts,
    identifiedHosts,
    unidentifiedHosts,
    cnameAliases,
    coverage: {
      thirdPartyHosts: hosts.length,
      identifiedHosts: identifiedHosts.length,
      unidentifiedHosts: unidentifiedHosts.length
    }
  };
}

function observedSeverity(
  run: RunView,
  identity: RunIdentityFacts,
  signals: RunSignalFacts
): ReportSeverity {
  const trackerCount = identity.trackingEntities.length;
  const thirdPartyHosts = run.counts.thirdPartyDomains;
  const cookieCount = run.counts.thirdPartyCookies;
  const listenerCorroborated =
    Boolean(signals.fingerprint.sessionRecording) && signals.fingerprint.sessionReplayNames.length > 0;
  const keystroke = fingerprintDetection(run.evidence, "keystroke-exfiltration");
  const pixelIdentifiers = run.evidence.pixelEvents.some((pixel) => pixel.advancedMatching.length > 0);
  const levels: ReportSeverity[] = [
    metricSeverity(trackerCount, 6, 12),
    metricSeverity(thirdPartyHosts, 15, 30),
    metricSeverity(cookieCount, 5, 12),
    signals.fingerprint.highEntropyDetections.length > 0
      ? "warn"
      : signals.fingerprint.eventCount > 0
        ? "info"
        : "ok",
    signals.fingerprint.listenerCoverageObserved ? (listenerCorroborated ? "warn" : "info") : "ok",
    signals.fingerprint.replayVendorObserved ? "info" : "ok",
    signals.shields.severity,
    run.evidence.cnameCloaks.some((cloak) => isTrackingTrackerMatch(cloak.tracker))
      ? "warn"
      : run.evidence.cnameCloaks.length > 0
        ? "info"
        : "ok",
    pixelIdentifiers ? "warn" : run.evidence.pixelEvents.length > 0 ? "info" : "ok",
    keystroke ? (keystrokeLeakHashed(keystroke.evidence.encodings) ? "loud" : "warn") : "ok"
  ];
  return strongestReportSeverity(levels);
}

function metricSeverity(value: number, elevated: number, high: number): ReportSeverity {
  if (value === 0) return "ok";
  if (value >= high) return "loud";
  if (value >= elevated) return "warn";
  return "info";
}

function dedupeNamers(namers: IdentityNamer[]): IdentityNamer[] {
  const seen = new Set<string>();
  return namers
    .filter((namer) => {
      const key = `${namer.source}:${namer.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}
