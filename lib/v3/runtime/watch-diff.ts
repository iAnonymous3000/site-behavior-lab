/**
 * Diff-aware temporal comparison & regression watch alerting for
 * Site Behavior Lab v3.
 *
 * Allows developers to inspect any two `ScanReportV3` snapshots (including
 * staging vs. production), while gating every regression alert and improvement
 * claim on comparable visit conditions, clean load outcomes, and complete
 * probe coverage.
 */

import { extractAllArmEntitiesV3 } from "../scanner/summary";
import type {
  DiffComparabilityV3,
  DiffFamilyComparabilityV3,
  DiffFamilyNameV3,
  DiffInsufficientEvidenceItemV3,
  ProbeCoverageV3,
  ScanArmV3,
  ScanReportV3,
  TemporalReportDiffV3,
  WatchRegressionAlertV3,
  WatchRegressionKindV3
} from "../schema";

export type {
  DiffComparabilityV3,
  DiffFamilyComparabilityV3,
  DiffFamilyNameV3,
  DiffInsufficientEvidenceItemV3,
  TemporalReportDiffV3,
  WatchRegressionAlertV3,
  WatchRegressionKindV3
};

const ALL_DIFF_FAMILIES: readonly DiffFamilyNameV3[] = [
  "keystrokes",
  "cname",
  "beacons",
  "fingerprinting",
  "consent",
  "network",
  "policy"
];

function formatProbeNote(probe: ProbeCoverageV3 | undefined): string {
  if (!probe) return "unknown";
  return probe.reason ? `${probe.status}: ${probe.reason}` : probe.status;
}

function evaluateProbePair(
  label: string,
  prevProbe: ProbeCoverageV3 | undefined,
  currProbe: ProbeCoverageV3 | undefined
): string[] {
  const reasons: string[] = [];
  if (!prevProbe || prevProbe.status !== "complete") {
    reasons.push(
      `Insufficient evidence for ${label}: baseline probe was ${formatProbeNote(prevProbe)}.`
    );
  }
  if (!currProbe || currProbe.status !== "complete") {
    reasons.push(
      `Insufficient evidence for ${label}: current probe was ${formatProbeNote(currProbe)}.`
    );
  }
  return reasons;
}

function evaluateKeystrokeComparability(prevArm: ScanArmV3, currArm: ScanArmV3): string[] {
  const reasons: string[] = [];
  if (!prevArm.conditions.activeInputProbe || !currArm.conditions.activeInputProbe) {
    reasons.push(
      `Insufficient evidence for keystrokes: activeInputProbe condition differed or was disabled (baseline=${String(prevArm.conditions.activeInputProbe)}, current=${String(currArm.conditions.activeInputProbe)}).`
    );
    return reasons;
  }

  const prevFields = prevArm.keystrokes.fieldsTyped;
  const currFields = currArm.keystrokes.fieldsTyped;
  const prevLeaks = prevArm.keystrokes.leaks.length;
  const currLeaks = currArm.keystrokes.leaks.length;

  if (prevFields === 0 && currFields === 0) {
    reasons.push(
      `Insufficient evidence for keystrokes: neither visit exercised an eligible input field (baseline=${formatProbeNote(prevArm.probes.keystrokes)}, current=${formatProbeNote(currArm.probes.keystrokes)}), so pre-submission keystroke transmission could not be compared.`
    );
    return reasons;
  }
  if (prevFields > 0 && currFields === 0) {
    reasons.push(
      `Insufficient evidence for keystrokes: baseline exercised ${prevFields} input ${prevFields === 1 ? "field" : "fields"} (${prevLeaks} transmitted-input ${prevLeaks === 1 ? "finding" : "findings"}), but current typed into 0 fields (${formatProbeNote(currArm.probes.keystrokes)}), so pre-submission transmission could not be tested in the current visit.`
    );
    return reasons;
  }
  if (prevFields === 0 && currFields > 0) {
    reasons.push(
      `Insufficient evidence for keystrokes: baseline typed into 0 fields (${formatProbeNote(prevArm.probes.keystrokes)}), so pre-submission transmission could not be tested in the baseline visit (current exercised ${currFields} ${currFields === 1 ? "field" : "fields"}, ${currLeaks} ${currLeaks === 1 ? "finding" : "findings"}).`
    );
    return reasons;
  }

  return evaluateProbePair("keystrokes", prevArm.probes.keystrokes, currArm.probes.keystrokes);
}

function evaluatePolicyComparability(prevArm: ScanArmV3, currArm: ScanArmV3): string[] {
  const reasons: string[] = [];
  if (!prevArm.conditions.policyCheck || !currArm.conditions.policyCheck) {
    reasons.push(
      `Insufficient evidence for policy disclosure: policyCheck was disabled (baseline=${String(prevArm.conditions.policyCheck)}, current=${String(currArm.conditions.policyCheck)}).`
    );
    return reasons;
  }
  reasons.push(...evaluateProbePair("policy", prevArm.probes.policy, currArm.probes.policy));
  reasons.push(...evaluateProbePair("network (required for policy cross-check)", prevArm.probes.network, currArm.probes.network));
  if (!prevArm.policy) {
    reasons.push(
      `Insufficient evidence for policy disclosure: no readable privacy policy was analyzed in baseline (${formatProbeNote(prevArm.probes.policy)}).`
    );
  }
  if (!currArm.policy) {
    reasons.push(
      `Insufficient evidence for policy disclosure: no readable privacy policy was analyzed in current (${formatProbeNote(currArm.probes.policy)}).`
    );
  }
  return [...new Set(reasons)];
}

export function evaluateDiffComparabilityV3(
  previous: ScanReportV3,
  current: ScanReportV3
): DiffComparabilityV3 {
  const prevArm = previous.leadArm;
  const currArm = current.leadArm;
  const globalReasons: string[] = [];
  const notes: string[] = [];

  if (previous.reportId === current.reportId) {
    globalReasons.push(
      `Insufficient evidence: both inputs refer to the same report (${previous.reportId}); choose two distinct visits to judge change.`
    );
  }

  if (prevArm.loadOutcome !== "ok" || currArm.loadOutcome !== "ok") {
    globalReasons.push(
      `Insufficient evidence: both visits must complete with loadOutcome=ok to judge regressions or improvements (baseline=${prevArm.loadOutcome}, current=${currArm.loadOutcome}).`
    );
  }

  if (prevArm.conditions.device !== currArm.conditions.device) {
    globalReasons.push(
      `Insufficient evidence: visit device conditions differ (baseline=${prevArm.conditions.device}, current=${currArm.conditions.device}).`
    );
  }
  if (prevArm.conditions.gpcEnabled !== currArm.conditions.gpcEnabled) {
    globalReasons.push(
      `Insufficient evidence: GPC visit conditions differ (baseline=${String(prevArm.conditions.gpcEnabled)}, current=${String(currArm.conditions.gpcEnabled)}).`
    );
  }
  if (prevArm.conditions.shieldsMode !== currArm.conditions.shieldsMode) {
    globalReasons.push(
      `Insufficient evidence: Shields visit conditions differ (baseline=${prevArm.conditions.shieldsMode}, current=${currArm.conditions.shieldsMode}).`
    );
  }
  if (prevArm.conditions.consentMode !== currArm.conditions.consentMode) {
    globalReasons.push(
      `Insufficient evidence: consent-interaction visit conditions differ (baseline=${prevArm.conditions.consentMode}, current=${currArm.conditions.consentMode}).`
    );
  }

  // Non-blocking context advisories so developers can inspect and compare
  // staging vs. production or cross-region snapshots honestly.
  if (previous.canonicalDomain.toLowerCase() !== current.canonicalDomain.toLowerCase()) {
    notes.push(
      `Comparing different domains (${previous.canonicalDomain} vs ${current.canonicalDomain}); interpret host and entity deltas in environment context (e.g. staging vs production).`
    );
  }
  if (previous.provenance.egressRegion !== current.provenance.egressRegion) {
    notes.push(
      `Egress regions differ (${previous.provenance.egressRegion} vs ${current.provenance.egressRegion}); geo-dependent consent banners or vendors may vary.`
    );
  }

  const families = {} as Record<DiffFamilyNameV3, DiffFamilyComparabilityV3>;
  if (globalReasons.length > 0) {
    for (const family of ALL_DIFF_FAMILIES) {
      families[family] = { status: "insufficient-evidence", reasons: [...globalReasons] };
    }
    return {
      status: "insufficient-evidence",
      reasons: globalReasons,
      notes,
      families,
      insufficientEvidence: ALL_DIFF_FAMILIES.map((family) => ({
        family,
        status: "insufficient-evidence",
        reason: globalReasons.join(" ")
      }))
    };
  }

  const scrollMismatchReason =
    prevArm.conditions.scrollCheck !== currArm.conditions.scrollCheck
      ? `Insufficient evidence: scrollCheck visit condition differed (baseline=${String(prevArm.conditions.scrollCheck)}, current=${String(currArm.conditions.scrollCheck)}).`
      : null;

  const perFamilyReasons: Record<DiffFamilyNameV3, string[]> = {
    keystrokes: evaluateKeystrokeComparability(prevArm, currArm),
    cname: evaluateProbePair("CNAME uncloaking", prevArm.probes.cname, currArm.probes.cname),
    beacons: [
      ...(scrollMismatchReason ? [scrollMismatchReason] : []),
      ...evaluateProbePair("beacons", prevArm.probes.beacons, currArm.probes.beacons),
      ...evaluateProbePair("network (required for beacons)", prevArm.probes.network, currArm.probes.network)
    ],
    fingerprinting: evaluateProbePair("fingerprinting", prevArm.probes.fingerprinting, currArm.probes.fingerprinting),
    consent: evaluateProbePair("consent", prevArm.probes.consent, currArm.probes.consent),
    network: [
      ...(scrollMismatchReason ? [scrollMismatchReason] : []),
      ...evaluateProbePair("network", prevArm.probes.network, currArm.probes.network)
    ],
    policy: evaluatePolicyComparability(prevArm, currArm)
  };

  const insufficientEvidence: DiffInsufficientEvidenceItemV3[] = [];
  for (const family of ALL_DIFF_FAMILIES) {
    const reasons = [...new Set(perFamilyReasons[family])];
    if (reasons.length > 0) {
      families[family] = { status: "insufficient-evidence", reasons };
      insufficientEvidence.push({
        family,
        status: "insufficient-evidence",
        reason: reasons.join(" ")
      });
    } else {
      families[family] = { status: "comparable", reasons: [] };
    }
  }

  const status =
    insufficientEvidence.length === 0
      ? "comparable"
      : insufficientEvidence.length === ALL_DIFF_FAMILIES.length
        ? "insufficient-evidence"
        : "partial";

  return {
    status,
    reasons: globalReasons,
    notes,
    families,
    insufficientEvidence
  };
}

export function diffScanReportsV3(previous: ScanReportV3, current: ScanReportV3): TemporalReportDiffV3 {
  const prevS = previous.leadArm.summary;
  const currS = current.leadArm.summary;
  const comparability = evaluateDiffComparabilityV3(previous, current);

  const prevEntities = new Set(
    (previous.leadArm.network.length > 0 ? extractAllArmEntitiesV3(previous.leadArm) : prevS.topEntities).map(
      (e) => e.entity
    )
  );
  const currEntities = new Set(
    (current.leadArm.network.length > 0 ? extractAllArmEntitiesV3(current.leadArm) : currS.topEntities).map(
      (e) => e.entity
    )
  );
  const entitiesAdded = [...currEntities].filter((e) => !prevEntities.has(e)).sort();
  const entitiesRemoved = [...prevEntities].filter((e) => !currEntities.has(e)).sort();

  const prevBeacons = new Set(previous.leadArm.beacons.map((b) => `${b.platform}@${b.endpointHost}`));
  const currBeacons = new Set(current.leadArm.beacons.map((b) => `${b.platform}@${b.endpointHost}`));
  const beaconsAdded = [...currBeacons].filter((b) => !prevBeacons.has(b)).sort();
  const beaconsRemoved = [...prevBeacons].filter((b) => !currBeacons.has(b)).sort();

  const prevFps = new Set(previous.leadArm.fingerprinting.map((f) => f.kind));
  const currFps = new Set(current.leadArm.fingerprinting.map((f) => f.kind));
  const fingerprintsAdded = [...currFps].filter((f) => !prevFps.has(f)).sort();
  const fingerprintsRemoved = [...prevFps].filter((f) => !currFps.has(f)).sort();

  const regressions: WatchRegressionAlertV3[] = [];
  const improvements: string[] = [];

  if (comparability.families.keystrokes.status === "comparable") {
    if (currS.keystrokeLeaksCount > prevS.keystrokeLeaksCount) {
      regressions.push({
        kind: "new-keystroke-leak",
        severity: "critical",
        title: `New pre-submission keystroke exfiltration detected (+${currS.keystrokeLeaksCount - prevS.keystrokeLeaksCount})`,
        detail: `Recipients: ${[...new Set(current.leadArm.keystrokes.leaks.map((l) => l.cnameTarget ?? l.domain))].join(", ")}.`
      });
    } else if (currS.keystrokeLeaksCount < prevS.keystrokeLeaksCount) {
      improvements.push(`Keystroke leaks dropped from ${prevS.keystrokeLeaksCount} to ${currS.keystrokeLeaksCount}.`);
    }
  }

  if (comparability.families.cname.status === "comparable") {
    if (currS.cnameCloaksCount > prevS.cnameCloaksCount) {
      regressions.push({
        kind: "new-cname-cloak",
        severity: "high",
        title: `New CNAME-cloaked tracking subdomain detected (+${currS.cnameCloaksCount - prevS.cnameCloaksCount})`,
        detail: `Cloaked hosts: ${current.leadArm.cnameCloaks.map((c) => `${c.host} -> ${c.entity.entity}`).join(", ")}.`
      });
    } else if (currS.cnameCloaksCount < prevS.cnameCloaksCount) {
      improvements.push(`CNAME-cloaked trackers dropped from ${prevS.cnameCloaksCount} to ${currS.cnameCloaksCount}.`);
    }
  }

  if (comparability.families.beacons.status === "comparable") {
    if (currS.serverSideTaggingEndpoints > prevS.serverSideTaggingEndpoints) {
      regressions.push({
        kind: "new-server-side-tagging",
        severity: "high",
        title: `New first-party server-side tagging endpoint detected`,
        detail: `Endpoints: ${current.leadArm.beacons.filter((b) => b.serverSideTagging).map((b) => b.endpointHost).join(", ")}.`
      });
    }

    const prevPiiBeacons = new Set(
      previous.leadArm.beacons.flatMap((b) => b.identifierCategories.map((c) => `${b.platform}:${c}`))
    );
    const currPiiBeacons = current.leadArm.beacons.flatMap((b) =>
      b.identifierCategories.map((c) => `${b.platform}:${c}`)
    );
    const newPii = [...new Set(currPiiBeacons.filter((x) => !prevPiiBeacons.has(x)))];
    if (newPii.length > 0) {
      regressions.push({
        kind: "new-beacon-identifiers",
        severity: "high",
        title: `Tracking beacons added new personal-identifier parameters`,
        detail: `Newly observed identifier fields: ${newPii.join(", ")}.`
      });
    }
  }

  if (comparability.families.fingerprinting.status === "comparable") {
    if (fingerprintsAdded.length > 0) {
      regressions.push({
        kind: "new-fingerprint-signal",
        severity: "high",
        title: `New fingerprinting or DOM-replay signals appeared (${fingerprintsAdded.join(", ")})`,
        detail: `Observed in ${current.reportId} but absent in ${previous.reportId}.`
      });
    } else if (fingerprintsRemoved.length > 0) {
      improvements.push(`Removed fingerprinting signals: ${fingerprintsRemoved.join(", ")}.`);
    }
  }

  if (comparability.families.consent.status === "comparable") {
    if (currS.darkPatternScore >= prevS.darkPatternScore + 15) {
      regressions.push({
        kind: "dark-pattern-regression",
        severity: "medium",
        title: `Consent banner dark-pattern score increased (${prevS.darkPatternScore} -> ${currS.darkPatternScore})`,
        detail: `Flags: ${current.leadArm.consent.banner.darkPatternFlags.join(", ")}.`
      });
    } else if (currS.darkPatternScore <= prevS.darkPatternScore - 15) {
      improvements.push(
        `Consent dark-pattern score improved from ${prevS.darkPatternScore} to ${currS.darkPatternScore}.`
      );
    }
  }

  const tpDelta = currS.thirdPartyDomains - prevS.thirdPartyDomains;
  if (comparability.families.network.status === "comparable") {
    if (tpDelta >= 5 || (prevS.thirdPartyDomains > 0 && tpDelta / prevS.thirdPartyDomains >= 0.25 && tpDelta >= 3)) {
      regressions.push({
        kind: "third-party-domain-spike",
        severity: "medium",
        title: `Third-party domain count jumped by +${tpDelta} (${prevS.thirdPartyDomains} -> ${currS.thirdPartyDomains})`,
        detail:
          entitiesAdded.length > 0
            ? `Newly observed entities: ${entitiesAdded.slice(0, 6).join(", ")}.`
            : "Review network waterfall for newly added hosts."
      });
    } else if (tpDelta <= -3) {
      improvements.push(
        `Third-party domains reduced from ${prevS.thirdPartyDomains} to ${currS.thirdPartyDomains}.`
      );
    }

    if (entitiesAdded.length > 0 && !regressions.some((r) => r.kind === "third-party-domain-spike")) {
      regressions.push({
        kind: "new-tracking-entities",
        severity: "medium",
        title: `${entitiesAdded.length} new tracking/service ${entitiesAdded.length === 1 ? "entity" : "entities"} appeared`,
        detail: `Added: ${entitiesAdded.slice(0, 8).join(", ")}.`
      });
    }
  }

  if (comparability.families.policy.status === "comparable") {
    const prevUnmentioned = previous.leadArm.policy?.unmentionedEntities.length ?? 0;
    const currUnmentioned = current.leadArm.policy?.unmentionedEntities.length ?? 0;
    if (currUnmentioned > prevUnmentioned) {
      regressions.push({
        kind: "policy-disclosure-regression",
        severity: "medium",
        title: `Unmentioned tracking companies in privacy policy grew (${prevUnmentioned} -> ${currUnmentioned})`,
        detail: `Current unmentioned: ${(current.leadArm.policy?.unmentionedEntities ?? []).slice(0, 6).join(", ")}.`
      });
    }
  }

  return {
    previousReportId: previous.reportId,
    currentReportId: current.reportId,
    previousScannedAt: previous.scannedAt,
    currentScannedAt: current.scannedAt,
    canonicalDomain: current.canonicalDomain,
    comparability,
    metrics: {
      totalRequestsDelta: currS.totalRequests - prevS.totalRequests,
      thirdPartyRequestsDelta: currS.thirdPartyRequests - prevS.thirdPartyRequests,
      thirdPartyDomainsDelta: tpDelta,
      cookiesDelta: currS.cookiesTotal - prevS.cookiesTotal,
      longLivedCookiesDelta: currS.longLivedCookies - prevS.longLivedCookies,
      darkPatternScoreDelta: currS.darkPatternScore - prevS.darkPatternScore,
      keystrokeLeaksDelta: currS.keystrokeLeaksCount - prevS.keystrokeLeaksCount,
      cnameCloaksDelta: currS.cnameCloaksCount - prevS.cnameCloaksCount,
      fingerprintKindsDelta: currS.fingerprintKindsCount - prevS.fingerprintKindsCount
    },
    entitiesAdded,
    entitiesRemoved,
    beaconsAdded,
    beaconsRemoved,
    fingerprintsAdded,
    fingerprintsRemoved,
    regressions,
    improvements
  };
}
