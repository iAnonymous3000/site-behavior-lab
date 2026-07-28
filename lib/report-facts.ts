import { consentPlatformForDomain } from "./consent-banner";
import {
  HEADLINE_PLATFORMS,
  crossSiteListenerDetection,
  fingerprintDetection,
  highEntropyDetections,
  isOperationalEntity,
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
  /** Exact counts are unavailable under family censoring; monotonic counts remain lower bounds. */
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
  /** Catalog classification remains separate from operator identity. */
  tracker: TrackerEntitySummary | null;
};

export type RunIdentityFacts = {
  catalogEntities: TrackerEntitySummary[];
  trackingEntities: TrackerEntitySummary[];
  operationalEntities: TrackerEntitySummary[];
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
    families: [],
    detectors: ["fingerprint-heuristics"],
    count: "none"
  },
  "storage-keys": { families: ["storage"], count: "snapshot" },
  "cname-cloaking": {
    families: [],
    detectors: ["cname-uncloaking"],
    count: "none"
  },
  "pixel-events": {
    families: ["requests", "detector-output"],
    detectors: ["pixel-events"],
    count: "monotonic"
  },
  "consent-banner": {
    families: ["requests"],
    detectors: ["consent-banner"],
    count: "none"
  },
  "shields-blocked": { families: ["requests"], count: "monotonic" },
  "privacy-policy": {
    families: ["requests", "cookies", "detector-output"],
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
    "fingerprint-apis"
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

export function claimEligibilityFor(facts: RunFacts, claim: ReportClaimId): ClaimEligibility {
  return facts.claims[claim];
}

export function evidenceStateFor(facts: RunFacts, family: EvidenceFamily): EvidenceState {
  return facts.evidence[family].state;
}

export function retainedCountLabel(value: number, state: EvidenceState): string {
  return state === "censored" ? `≥${value.toLocaleString("en-US")}` : value.toLocaleString("en-US");
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
    if (evidence[family].state === "unsupported") blockers.add("family-unsupported");
    if (evidence[family].state === "censored") blockers.add("family-censored");
  }
  const detectors = requirement.detectors ?? [];
  if (
    run.detectors &&
    detectors.some((detector) => run.detectors?.[detector]?.status !== "complete")
  ) {
    blockers.add("detector-incomplete");
  }
  const familyIncomplete = requirement.families.some(
    (family) => evidence[family].state !== "complete"
  );
  const familyCensored = requirement.families.some(
    (family) => evidence[family].state === "censored"
  );
  return {
    allowed: blockers.size === 0,
    blockers: [...blockers],
    families: [...requirement.families],
    detectors: [...detectors],
    subjectScope: subject.describesSubject ? "requested-page" : "returned-document",
    exactCountAllowed: requirement.count !== "none" && !familyIncomplete,
    lowerBound: requirement.count === "monotonic" && familyCensored,
    benchmarkAllowed:
      subject.describesSubject &&
      run.quality.outcome === "complete" &&
      requirement.families.every((family) => evidence[family].state === "complete")
  };
}

function identityFacts(run: RunView): RunIdentityFacts {
  const catalogEntities = trackerEntitySummaries(run.evidence);
  const trackingEntities = catalogEntities.filter((entity) => !isOperationalEntity(entity));
  const operationalEntities = catalogEntities.filter(isOperationalEntity);
  const ownership = trackerOwnershipBreakdown(run.evidence, run.domain);
  const respondedEntities = respondedTrackerEntityNames(run.evidence);
  const hosts: IdentifiedHostFact[] = [];
  const cmpNames = new Set<string>();
  const ownershipNames = new Set<string>();

  for (const domain of run.evidence.domains) {
    if (!domain.thirdParty) continue;
    const namers: IdentityNamer[] = [];
    if (domain.tracker) {
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
    const tracker = domain.tracker
      ? catalogEntities.find((entity) => entity.entity === domain.tracker?.entity) ?? null
      : null;
    hosts.push({
      host: domain.domain,
      requests: domain.requests,
      namers: dedupeNamers(namers),
      relationship: reviewedOwnershipRelationship(run.domain, domain.domain).kind,
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
  const majorPlatformNames = [...allNames].filter((name) => HEADLINE_PLATFORMS.includes(name)).sort();
  const identifiedHosts = hosts.filter((host) => host.namers.length > 0).map((host) => host.host);
  const unidentifiedHosts = hosts.filter((host) => host.namers.length === 0).map((host) => host.host);

  return {
    catalogEntities,
    trackingEntities,
    operationalEntities,
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
    run.evidence.cnameCloaks.length > 0 ? "warn" : "ok",
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
