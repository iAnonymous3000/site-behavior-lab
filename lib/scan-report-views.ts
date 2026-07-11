/**
 * The view layer of the consumer seam (docs/scan-report-v2-rfc.md, 10.1 and
 * 14 step 3): the version-independent `ReportView`/`RunView` shapes plus the
 * builders that derive them from either wire generation.
 *
 * Deliberately LIGHT at runtime: only type-only imports and the dependency-free
 * eligibility rule, so client components can import it statically without
 * dragging the validators into the first-load bundle (the deep readers live in
 * scan-report-view.ts, which is lazy-loaded via lib/client-report-reader.ts).
 */
import { compareRunFacts } from "./compare-reports";
import { comparisonEligibility, runHitRequestCap } from "./comparison-eligibility";
import { summarizeDomains } from "./domain-summaries";
import type {
  CnameCloak,
  ComparisonDiff,
  CookieRecord,
  DomainSummary,
  FingerprintDetectionSummary,
  FingerprintEventSummary,
  NetworkRequestRecord,
  PixelEventSummary,
  PrivacyPolicySummary,
  ScanReport,
  ScanResult,
  StorageRecord
} from "./types";
import type {
  InterventionAxis,
  MetricFamily,
  PublicScanReportV2,
  ScanRunV2
} from "./scan-report-v2";
import type { PublicScanReportV2R2, ScanRunV2R2 } from "./scan-report-v2-r2";
import type { StoredScanReport } from "./scan-report-reader";

/**
 * Per-run evidence, in the record shapes the tables already render. The v2
 * evidence rows extend the v1 record types (a phase-tagged request is still a
 * `NetworkRequestRecord`), so one view shape serves both generations and the
 * components keep their prop types. Raw evidence is not a claim: it always
 * renders; `claims` gates wording only.
 */
export type RunEvidenceView = {
  requests: NetworkRequestRecord[];
  /** Per-domain grouping: v1 carries it on the wire, v2 derives it from requests. */
  domains: DomainSummary[];
  cookies: CookieRecord[];
  storage: StorageRecord[];
  fingerprintEvents: FingerprintEventSummary[];
  fingerprintDetections: FingerprintDetectionSummary[];
  pixelEvents: PixelEventSummary[];
  cnameCloaks: CnameCloak[];
  privacyPolicy: PrivacyPolicySummary | null;
};

/**
 * Normalized disclosure facts for the methodology block. Fields a generation
 * never recorded are null; v2 URLs are the privacy-safe origin + route shape
 * (RFC 9.1), v1 URLs are the already-scrubbed origin + path.
 */
export type RunConditionsView = {
  requestedUrl: string;
  finalUrl: string;
  automation: string;
  headless: boolean;
  scannerEgress: string;
  browserVersion: string | null;
  timezone: string;
  locale: string;
  viewport: { width: number; height: number; isMobile: boolean };
  gpcEnabled: boolean;
  /** "off" | "classification" | "block-simulation"; null when never recorded. */
  shieldsMode: string | null;
  adblockActive: boolean | null;
  /** The blocker's list provenance for the methodology block; null when the engine never ran. */
  adblockLists: { source: string; lists: number; fetchedAt: string } | null;
  consentMode: string;
  /** `region` is a v1-only recorded fact; v2 catalogs pin a digest instead. */
  trackerCatalog: { source: string; version: string; entries: number; region: string | null } | null;
  /** v1's prose scanner disclosure; v2 records structured facts instead. */
  disclosure: string | null;
};

/**
 * Run quality. v2 records this (RFC 5.3: outcome + reasons, per-family
 * censoring); a v1 run never did, so its quality is DERIVED from status and
 * cap warnings and marked "legacy-derived", never presented as recorded fact.
 */
export type RunQualityView = {
  origin: "recorded" | "legacy-derived";
  outcome: "complete" | "failed";
  reasons: string[];
  /** Per evidence family; null on v1 (family censoring was never recorded). */
  byFamily: Record<string, { outcome: "complete" | "censored"; reasons: string[] }> | null;
};

/**
 * The consent-interaction outcome a run recorded, null when the run never
 * attempted one (observe mode). `controlActivated` is v1's `clicked` and v2's
 * `controlActivated`: the scanner dispatched a click on a recognized control.
 * Dispatch is not verification; v2's verification facts stay on the wire and
 * gate claims through the claim policy, never through this block.
 */
export type RunConsentView = {
  mode: "accept-all" | "reject-all";
  controlActivated: boolean;
  /** Consent platform name when a known CMP control matched (e.g. "OneTrust"). */
  cmp: string | null;
};

export type RunView = {
  /** null for a single report's only run. */
  label: "baseline" | "variant" | null;
  domain: string;
  startedAt: string | null;
  status: number | null;
  counts: {
    totalRequests: number;
    thirdPartyRequests: number;
    knownTrackerRequests: number;
    thirdPartyDomains: number;
    cookies: number;
    thirdPartyCookies: number;
    storageEntries: number;
    fingerprintEvents: number;
    shieldsBlockedRequests: number | null;
  };
  pageTitle: string;
  durationMs: number;
  warnings: string[];
  /**
   * The screenshot as stored. Renderers must keep displaying it only through
   * the data-URI-only gate (report-insights displayableScreenshot); the view
   * carries the raw value so exports stay lossless.
   */
  screenshot: string | null;
  evidence: RunEvidenceView;
  conditions: RunConditionsView;
  consent: RunConsentView | null;
  quality: RunQualityView;
};

export type ComparisonView = {
  /** The design label; a LABEL only, never a claim gate (consult `claims`). */
  kind: "intervention" | "temporal" | "descriptive";
  /** The intervention axis the comparison ran or attempted, as metadata. */
  axis: InterventionAxis | null;
  /**
   * The pair was DESIGNED as a same-subject before/after observation (v1
   * comparisonType "temporal", v2 experiment kind "temporal"). Explicit so a
   * legacy "custom" pairing (also axis-less) is never mistaken for a temporal
   * one. Drives the lead-run choice and the temporal card label only; the
   * temporal CLAIM stays behind `claims.temporalChange`.
   */
  temporalPair: boolean;
  /**
   * Display labels for the two runs ("Shields off"/"Shields on"). Presentation
   * only, never a claim gate: a label describes what a run ATTEMPTED, and only
   * `claims` says whether the pair supports comparing them.
   */
  runLabels: { baseline: string; variant: string };
};

/** A gated claim surface: allowed only when the stored facts prove it. */
export type ClaimGate = { allowed: boolean; reasons: string[] };

/**
 * Explicit DEFAULT-DENY claim policy (RFC 4.1/4.2 product rules). Renderers
 * consult THIS block and nothing else: not `comparison.kind`, not `limited`,
 * not wire fields. Every gate is false unless the stored facts prove the
 * claim, so a renderer that forgets a check under-claims instead of
 * over-claiming.
 */
export type ClaimPolicy = {
  /**
   * Pair-level framing ("these two visits compare one subject"). null on
   * single reports (there is no pair). Raw per-run evidence is not a claim
   * and may always render.
   */
  pairComparison: ClaimGate | null;
  /** Per metric family: may this family's delta be quoted as comparable? */
  familyDeltas: Record<MetricFamily, ClaimGate> | null;
  /** Intervention-attributed framing ("Shields blocked", "after the Reject click"). */
  interventionAttribution: boolean;
  /** Same-subject change-over-time framing ("the site changed since..."). */
  temporalChange: boolean;
  /** Strong causal wording; requires replicated counterbalanced evidence (RFC 4.2). */
  strongCausal: boolean;
};

export type ReportView = {
  origin: "v2" | "legacy-derived";
  /** null for v1 (no v2 revision applies). */
  revision: 1 | 2 | null;
  /**
   * RFC 15.7: v1 and v2 r1 reports are limited/descriptive; their
   * intervention-attributed and causal surfaces are suppressed (r1 lacks the
   * structured facts for authoritative verification). Only r2 views may
   * render causal framing. A labeling aid; the claim gates in `claims`
   * already encode its consequences.
   */
  limited: boolean;
  reportType: "single" | "comparison";
  domain: string;
  /** The wire's report title (v1 comparisons only); null when never recorded. */
  title: string | null;
  /**
   * Report-level warnings. v1 carries them on the wire (a comparison's list
   * already names each run); v2 derives them from the runs, prefixed with the
   * run label on comparisons so a warning stays attributed to its visit.
   */
  warnings: string[];
  /** The lead run's start: the DISPLAY timestamp ("scanned on ..."). */
  scannedAt: string | null;
  /**
   * The newest run's start: the SORT/RETENTION timestamp. Distinct from
   * `scannedAt` because a comparison's lead (baseline) run can be much older
   * than its newest run (a long-span temporal pair), and retention keyed on
   * the lead would age a just-published report immediately.
   */
  latestRunAt: string | null;
  runs: RunView[];
  comparison: ComparisonView | null;
  claims: ClaimPolicy;
};

function runViewFromV2(run: ScanRunV2 | ScanRunV2R2, label: RunView["label"]): RunView {
  return {
    label,
    domain: run.subject.observed.registrableDomain,
    startedAt: run.startedAt,
    status: run.summary.status,
    counts: {
      totalRequests: run.summary.counts.totalRequests,
      thirdPartyRequests: run.summary.counts.thirdPartyRequests,
      knownTrackerRequests: run.summary.counts.knownTrackerRequests,
      thirdPartyDomains: run.summary.counts.thirdPartyDomains,
      cookies: run.summary.counts.cookies,
      thirdPartyCookies: run.summary.counts.thirdPartyCookies,
      storageEntries: run.summary.counts.storageEntries,
      fingerprintEvents: run.summary.counts.fingerprintEvents,
      shieldsBlockedRequests: run.summary.counts.shieldsBlockedRequests ?? null
    },
    pageTitle: run.summary.pageTitle,
    durationMs: run.summary.durationMs,
    warnings: [...run.warnings],
    // v2 public runs carry no screenshot; screenshots are ephemeral-only.
    screenshot: null,
    evidence: {
      requests: run.evidence.requests,
      domains: summarizeDomains(run.evidence.requests),
      cookies: run.evidence.cookiesFinal,
      storage: run.evidence.storageFinal,
      fingerprintEvents: run.evidence.fingerprintEvents,
      fingerprintDetections: run.evidence.fingerprintDetections,
      pixelEvents: run.evidence.pixelEvents,
      cnameCloaks: run.evidence.cnameCloaks,
      privacyPolicy: run.evidence.privacyPolicy ?? null
    },
    conditions: {
      requestedUrl: `${run.subject.requested.origin}${run.subject.requested.routeShape}`,
      finalUrl: `${run.subject.observed.origin}${run.subject.observed.routeShape}`,
      automation: run.conditions.automation,
      headless: run.conditions.headless,
      scannerEgress: run.conditions.egress.label,
      browserVersion: run.conditions.browser.version,
      timezone: run.conditions.timezone,
      locale: run.conditions.locale,
      viewport: { ...run.conditions.device.viewport },
      gpcEnabled: run.conditions.gpc,
      shieldsMode: run.conditions.shields,
      adblockActive: run.toolchain.adblock !== null,
      adblockLists: run.toolchain.adblock
        ? {
            source: run.toolchain.adblock.source,
            lists: run.toolchain.adblock.lists,
            fetchedAt: run.toolchain.adblock.fetchedAt
          }
        : null,
      consentMode: run.conditions.consent,
      trackerCatalog: {
        source: run.toolchain.trackerCatalog.source,
        version: run.toolchain.trackerCatalog.version,
        entries: run.toolchain.trackerCatalog.entries,
        region: null
      },
      // v2 records structured facts; there is no prose disclosure to quote.
      disclosure: null
    },
    consent: run.evidence.consent
      ? {
          mode: run.evidence.consent.mode,
          controlActivated: run.evidence.consent.controlActivated,
          cmp: run.evidence.consent.cmp ?? null
        }
      : null,
    quality: {
      origin: "recorded",
      outcome: run.quality.run.outcome,
      reasons: [...run.quality.run.reasons],
      byFamily: Object.fromEntries(
        Object.entries(run.quality.byFamily).map(([family, entry]) => [
          family,
          { outcome: entry.outcome, reasons: [...entry.reasons] }
        ])
      )
    }
  };
}

function runViewFromV1(result: ScanResult, label: RunView["label"], scannedAt: string | null): RunView {
  // v1 never recorded quality; derive the run-level outcome from the same
  // facts the interim gate uses (status, cap) and mark it legacy-derived so it
  // is never presented as recorded fact.
  const reasons: string[] = [];
  if (typeof result.summary.status === "number" && result.summary.status >= 400) reasons.push("http-error-status");
  if (runHitRequestCap(result)) reasons.push("budget-exhausted:request-cap");
  return {
    label,
    domain: result.summary.firstPartyDomain,
    startedAt: scannedAt,
    status: result.summary.status,
    counts: {
      totalRequests: result.summary.totalRequests,
      thirdPartyRequests: result.summary.thirdPartyRequests,
      knownTrackerRequests: result.summary.knownTrackerRequests,
      thirdPartyDomains: result.summary.thirdPartyDomains,
      cookies: result.summary.cookies,
      thirdPartyCookies: result.summary.thirdPartyCookies,
      storageEntries: result.summary.storageEntries,
      fingerprintEvents: result.summary.fingerprintEvents,
      shieldsBlockedRequests: result.summary.shieldsBlockedRequests ?? null
    },
    pageTitle: result.summary.pageTitle,
    durationMs: result.summary.durationMs,
    warnings: [...result.warnings],
    screenshot: result.screenshot ?? null,
    evidence: {
      requests: result.requests,
      domains: result.domains,
      cookies: result.cookies,
      storage: result.storage,
      fingerprintEvents: result.fingerprintEvents,
      fingerprintDetections: result.fingerprintDetections ?? [],
      pixelEvents: result.pixelEvents ?? [],
      cnameCloaks: result.cnameCloaks ?? [],
      privacyPolicy: result.privacyPolicy ?? null
    },
    conditions: {
      requestedUrl: result.conditions.requestedUrl,
      finalUrl: result.conditions.finalUrl,
      automation: result.conditions.automation,
      headless: result.conditions.headless,
      scannerEgress: result.conditions.scannerEgress,
      browserVersion: result.conditions.chromiumVersion || null,
      timezone: result.conditions.timezone,
      locale: result.conditions.locale,
      viewport: { ...result.conditions.viewport },
      gpcEnabled: result.conditions.gpcEnabled,
      shieldsMode: result.conditions.shieldsMode ?? null,
      adblockActive: result.conditions.adblock?.active ?? null,
      adblockLists: result.conditions.adblock
        ? {
            source: result.conditions.adblock.source,
            lists: result.conditions.adblock.lists,
            fetchedAt: result.conditions.adblock.fetchedAt
          }
        : null,
      consentMode: result.conditions.consentMode ?? "observe",
      trackerCatalog: {
        source: result.conditions.trackerCatalog.source,
        version: result.conditions.trackerCatalog.version,
        entries: result.conditions.trackerCatalog.entries,
        region: result.conditions.trackerCatalog.region ?? null
      },
      disclosure: result.conditions.scannerDisclosure || null
    },
    consent: result.consentInteraction
      ? {
          mode: result.consentInteraction.mode,
          controlActivated: result.consentInteraction.clicked,
          cmp: result.consentInteraction.cmp ?? null
        }
      : null,
    quality: {
      origin: "legacy-derived",
      outcome: reasons.includes("http-error-status") ? "failed" : "complete",
      reasons,
      byFamily: null
    }
  };
}

/**
 * Every v1 comparison is DESCRIPTIVE by construction (RFC 10.1): the v1
 * environment was never fully recorded, so per the unknown rule (3.2) neither
 * an intervention nor a temporal design is provable from it. The kind must
 * not depend on renderers remembering `limited: true`; `axis` still records
 * which intervention the comparison ATTEMPTED, as descriptive metadata.
 */
function legacyComparisonAxis(comparisonType: string): InterventionAxis | null {
  if (comparisonType === "gpc" || comparisonType === "shields" || comparisonType === "consent") return comparisonType;
  return null;
}

/** Default per-axis display labels, shared by both generations' builders. */
function defaultRunLabels(axis: InterventionAxis | null, temporal: boolean): { baseline: string; variant: string } {
  if (axis === "gpc") return { baseline: "GPC off", variant: "GPC on" };
  if (axis === "shields") return { baseline: "Shields off", variant: "Shields on" };
  if (axis === "consent") return { baseline: "Accept all", variant: "Reject all" };
  return temporal ? { baseline: "Before", variant: "After" } : { baseline: "Baseline", variant: "Variant" };
}

/** The default-deny policy: every claim surface refused. */
function deniedClaims(): ClaimPolicy {
  return {
    pairComparison: null,
    familyDeltas: null,
    interventionAttribution: false,
    temporalChange: false,
    strongCausal: false
  };
}

/**
 * Claims a v1 comparison can support: at most a descriptive pairing with
 * per-family DESCRIPTIVE deltas where the facts v1 actually recorded prove
 * the two arms measured alike. The pair-level gate reuses the shared v1
 * eligibility rule (failed, capped, or mismatched arms); each family then
 * adds the recorded-fact checks v1 makes possible:
 *
 * - raw-counts: the whole-pair rule (same subject, both loaded, uncapped,
 *   same device class and pipeline) is the only compatibility v1 can state,
 *   and it covers what raw counts depend on.
 * - tracker-classification: additionally requires the SAME tracker catalog
 *   (source, version, region) on both arms; a different catalog classifies
 *   differently, so entity/known-service deltas would compare instruments.
 * - shields-simulation: additionally requires both arms to carry an active
 *   engine measurement of the SAME kind (equal shieldsMode) from the same
 *   list snapshot (equal source and fetchedAt); a Shields-axis pair measures
 *   filter matches on one arm and engine blocks on the other, two different
 *   quantities that must never share a delta.
 * - consent-verification: denied; v1 recorded that a click was dispatched,
 *   never a verified consent state (RFC 6).
 * - detector-findings: denied; v1 never recorded detector versions, so
 *   fingerprinting/pixel deltas cannot be proven to come from matching
 *   instrumentation (RFC 3.2: unknown never matches).
 *
 * Everything here supports descriptive wording only (RFC 10.1: v1 pairs are
 * descriptive at best); attribution, temporal, and strong-causal framing are
 * denied by construction.
 */
function legacyClaims(report: Extract<ScanReport, { reportType: "comparison" }>): ClaimPolicy {
  const eligibility = comparisonEligibility(report);
  const pairReasons = [...eligibility.reasons];

  const familyGate = (extraReasons: string[]): ClaimGate =>
    eligibility.eligible && extraReasons.length === 0
      ? { allowed: true, reasons: [] }
      : { allowed: false, reasons: [...pairReasons, ...extraReasons] };

  const catalogReasons: string[] = [];
  const baselineCatalog = report.baseline.conditions.trackerCatalog;
  const variantCatalog = report.variant.conditions.trackerCatalog;
  if (!baselineCatalog.source || !variantCatalog.source || !baselineCatalog.version || !variantCatalog.version) {
    catalogReasons.push("A visit did not record its tracker-catalog identity, so classification comparability is unprovable.");
  } else if (
    baselineCatalog.source !== variantCatalog.source ||
    baselineCatalog.version !== variantCatalog.version ||
    (baselineCatalog.region ?? null) !== (variantCatalog.region ?? null)
  ) {
    catalogReasons.push(
      "The two visits classified trackers with different catalogs, so classification deltas would compare instruments, not the site."
    );
  }

  const shieldsReasons: string[] = [];
  const baselineShields = report.baseline.summary.shieldsBlockedRequests;
  const variantShields = report.variant.summary.shieldsBlockedRequests;
  const baselineAdblock = report.baseline.conditions.adblock;
  const variantAdblock = report.variant.conditions.adblock;
  if (
    typeof baselineShields !== "number" ||
    typeof variantShields !== "number" ||
    baselineAdblock?.active !== true ||
    variantAdblock?.active !== true
  ) {
    shieldsReasons.push("A Shields measurement exists on at most one visit, so there is no like-for-like Shields delta.");
  } else if ((report.baseline.conditions.shieldsMode ?? null) !== (report.variant.conditions.shieldsMode ?? null)) {
    shieldsReasons.push(
      "The two visits measured different Shields quantities (filter-list matches vs engine-blocked requests), which must never share a delta."
    );
  } else if (baselineAdblock.source !== variantAdblock.source || baselineAdblock.fetchedAt !== variantAdblock.fetchedAt) {
    shieldsReasons.push("The two visits used different filter-list snapshots, so their Shields numbers measure different lists.");
  }

  return {
    ...deniedClaims(),
    pairComparison: { allowed: eligibility.eligible, reasons: pairReasons },
    familyDeltas: {
      "raw-counts": familyGate([]),
      "tracker-classification": familyGate(catalogReasons),
      "shields-simulation": familyGate(shieldsReasons),
      "consent-verification": {
        allowed: false,
        reasons: ["v1 recorded whether a consent click was dispatched, never a verified consent state, so consent-verification deltas are unprovable."]
      },
      "detector-findings": {
        allowed: false,
        reasons: [
          "v1 never recorded detector versions, so fingerprinting and pixel deltas cannot be proven to come from matching instrumentation."
        ]
      }
    }
  };
}

/** The newest parseable timestamp among the runs, for sorting and retention. */
function latestRunAt(runs: RunView[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    if (run.startedAt === null) continue;
    const ms = Date.parse(run.startedAt);
    if (Number.isFinite(ms) && ms > latestMs) {
      latest = run.startedAt;
      latestMs = ms;
    }
  }
  return latest;
}

/**
 * The view for a v1 wire report held OUTSIDE a stored envelope: the shell's
 * live scan result, the gallery's static loads, and corpus rows. Stored reads
 * go through {@link toReportView}, which dispatches on the envelope's schema
 * metadata instead of assuming a generation.
 */
export function viewFromV1Report(report: ScanReport): ReportView {
  if (report.reportType === "comparison") {
    const runs = [
      runViewFromV1(report.baseline, "baseline", report.baseline.conditions.scannedAt),
      runViewFromV1(report.variant, "variant", report.variant.conditions.scannedAt)
    ];
    const axis = legacyComparisonAxis(report.comparisonType);
    return {
      origin: "legacy-derived",
      revision: null,
      limited: true,
      reportType: "comparison",
      domain: report.baseline.summary.firstPartyDomain,
      title: report.title || null,
      warnings: [...report.warnings],
      scannedAt: report.scannedAt,
      latestRunAt: latestRunAt(runs),
      runs,
      comparison: {
        kind: "descriptive",
        axis,
        temporalPair: report.comparisonType === "temporal",
        runLabels: report.runLabels ? { ...report.runLabels } : defaultRunLabels(axis, report.comparisonType === "temporal")
      },
      claims: legacyClaims(report)
    };
  }
  const runs = [runViewFromV1(report, null, report.conditions.scannedAt)];
  return {
    origin: "legacy-derived",
    revision: null,
    limited: true,
    reportType: "single",
    domain: report.summary.firstPartyDomain,
    title: null,
    warnings: [...report.warnings],
    scannedAt: report.conditions.scannedAt,
    latestRunAt: latestRunAt(runs),
    runs,
    comparison: null,
    claims: deniedClaims()
  };
}

/**
 * Claims a v2 comparison supports, straight from its recorded facts (RFC 4.1
 * product rules): pair framing from pairValidity, family deltas from
 * perMetric, intervention attribution only for a verified intervention on an
 * unlimited (r2+) report, temporal framing only for a valid temporal pair,
 * and strong causal wording only with replicated counterbalanced evidence.
 */
function v2Claims(report: Extract<PublicScanReportV2 | PublicScanReportV2R2, { reportType: "comparison" }>, limited: boolean): ClaimPolicy {
  const experiment = report.experiment;
  const comparability = report.comparability;
  // Attribution REQUIRES pair validity: verification proves the intervention
  // was applied, but an invalid pair (subject mismatch, failed run) supports
  // no pair-level claim at all (RFC 4.4), so a verified intervention on an
  // invalid pair must still render as two independent runs.
  const interventionAttribution =
    !limited &&
    experiment.kind === "intervention" &&
    comparability.pairValidity.eligible &&
    comparability.interventionVerified === true;
  return {
    pairComparison: {
      allowed: comparability.pairValidity.eligible,
      reasons: [...comparability.pairValidity.reasons]
    },
    familyDeltas: Object.fromEntries(
      Object.entries(comparability.perMetric).map(([family, entry]) => [
        family,
        { allowed: entry.eligible, reasons: [...entry.reasons] }
      ])
    ) as Record<MetricFamily, ClaimGate>,
    interventionAttribution,
    temporalChange: !limited && experiment.kind === "temporal" && comparability.pairValidity.eligible,
    strongCausal:
      interventionAttribution &&
      experiment.kind === "intervention" &&
      experiment.evidence.strength === "replicated-difference"
  };
}

export function viewFromV2(report: PublicScanReportV2 | PublicScanReportV2R2, revision: 1 | 2): ReportView {
  // RFC 15.7: r1 reports stay readable but limited/descriptive; the
  // intervention-attributed surface (interventionVerified) is suppressed and
  // may never be re-derived from asserted r1 strings.
  const limited = revision === 1;
  if (report.reportType === "comparison") {
    const runs = [runViewFromV2(report.baseline, "baseline"), runViewFromV2(report.variant, "variant")];
    const axis = report.experiment.kind === "intervention" ? report.experiment.axis : null;
    const runLabels = defaultRunLabels(axis, report.experiment.kind === "temporal");
    return {
      origin: "v2",
      revision,
      limited,
      reportType: "comparison",
      domain: report.baseline.subject.observed.registrableDomain,
      title: null,
      // v2 records warnings per run; the report-level list keeps each warning
      // attributed to its visit (the same shape v1's producer wrote).
      warnings: [
        ...report.baseline.warnings.map((warning) => `${runLabels.baseline}: ${warning}`),
        ...report.variant.warnings.map((warning) => `${runLabels.variant}: ${warning}`)
      ],
      scannedAt: report.baseline.startedAt,
      latestRunAt: latestRunAt(runs),
      runs,
      comparison: {
        kind: report.experiment.kind,
        axis,
        temporalPair: report.experiment.kind === "temporal",
        runLabels
      },
      claims: v2Claims(report, limited)
    };
  }
  const runs = [runViewFromV2(report.run, null)];
  return {
    origin: "v2",
    revision,
    limited,
    reportType: "single",
    domain: report.run.subject.observed.registrableDomain,
    title: null,
    warnings: [...report.run.warnings],
    scannedAt: report.run.startedAt,
    latestRunAt: latestRunAt(runs),
    runs,
    comparison: null,
    claims: deniedClaims()
  };
}

export function toReportView(stored: StoredScanReport): ReportView {
  if (stored.schemaVersion === 1) return viewFromV1Report(stored.report);
  return viewFromV2(stored.report, stored.schemaRevision);
}

/**
 * The two arms of a comparison view in wire order (baseline first), or null
 * for single reports. Every delta a consumer quotes derives from these two
 * runs' counts, the same numbers the v1 wire's `diff` block was computed
 * from, so an inconsistent uploaded diff can never drive wording, and v2
 * comparisons (which carry no precomputed diff) get identical treatment.
 */
export function comparisonArmViews(view: ReportView): { baseline: RunView; variant: RunView } | null {
  if (view.reportType !== "comparison" || view.runs.length < 2) return null;
  return { baseline: view.runs[0], variant: view.runs[view.runs.length - 1] };
}

/**
 * The two-arm evidence diff, derived from the arms' run views through the SAME
 * builder the v1 producer used to write the wire's `diff` (parity by
 * construction), so v2 comparisons (whose wire diff is family-shaped, not
 * list-shaped) and tampered uploads render identically. Raw evidence, not a
 * claim: it always renders; `claims` gates wording only.
 */
export function comparisonDiffView(view: ReportView): ComparisonDiff | null {
  const arms = comparisonArmViews(view);
  return arms ? compareRunFacts(arms.baseline, arms.variant) : null;
}

/** Human phrasing for the recorded quality-reason vocabulary (RFC 5.3). */
const QUALITY_REASON_NOTES: Record<string, string> = {
  "budget-exhausted:request-cap": "the visit hit the scanner's request-recording cap, so its counts are truncated"
};

/**
 * Human-readable notes on evidence the run did NOT finish collecting: budget
 * exhaustion and per-family censoring (v2 records them, v1 derives the cap
 * from its warnings). Empty for a complete run. The HTTP load-failure story
 * is handled by the run's `status` first and is not repeated here. Consumers
 * must consult this before any "quiet page" framing: censored evidence makes
 * low counts a floor, never a calm result.
 */
export function runCensorshipNotes(run: RunView): string[] {
  const notes: string[] = [];
  for (const reason of run.quality.reasons) {
    if (reason === "http-error-status") continue;
    notes.push(QUALITY_REASON_NOTES[reason] ?? `the run recorded a quality limitation (${reason})`);
  }
  if (run.quality.byFamily) {
    for (const [family, entry] of Object.entries(run.quality.byFamily)) {
      if (entry.outcome !== "censored") continue;
      notes.push(
        `${family} evidence was censored before completion${entry.reasons.length > 0 ? ` (${entry.reasons.join(", ")})` : ""}`
      );
    }
  }
  return notes;
}

/**
 * Short human label for the report's schema provenance, shown beside the
 * report header and in the methodology block: names the wire generation,
 * whether the normalized facts are legacy-derived, and whether the report is
 * limited/descriptive (RFC 15.7 / 10.1). A LABEL only; the enforcement lives
 * in `claims`.
 */
export function schemaProvenanceLabel(view: ReportView): string {
  if (view.origin === "legacy-derived") return "v1 schema · facts legacy-derived · descriptive report";
  if (view.revision === 1) return "v2 schema (r1) · limited, descriptive report";
  return `v2 schema (r${view.revision ?? 2})`;
}

/**
 * One-line run-quality summary for the methodology block: outcome, censoring
 * notes, and whether the quality block was recorded by the scanner (v2) or
 * derived from status and warnings (v1), so a derived guess is never read as
 * recorded fact.
 */
export function runQualitySummary(run: RunView): string {
  const basis = run.quality.origin === "recorded" ? "recorded by the scanner" : "derived from status and warnings";
  if (run.quality.outcome === "failed") {
    const status = typeof run.status === "number" && run.status >= 400 ? ` (HTTP ${run.status})` : "";
    return `failed${status}; ${basis}`;
  }
  const notes = runCensorshipNotes(run);
  if (notes.length > 0) return `cut short: ${notes.join("; ")}; ${basis}`;
  return `complete; ${basis}`;
}

/**
 * The run a report page leads with: the newer run for pairs DESIGNED as
 * before/after observations, the baseline (off / unprotected) run otherwise.
 * Keyed on the explicit `temporalPair` design marker, never on "axis is
 * null": a legacy "custom" comparison is also axis-less and must stay
 * baseline-led with its own labels, not be misread as temporal.
 */
export function displayRunView(view: ReportView): RunView {
  if (view.reportType !== "comparison" || view.runs.length === 0) return view.runs[0];
  return view.comparison?.temporalPair ? view.runs[view.runs.length - 1] : view.runs[0];
}
