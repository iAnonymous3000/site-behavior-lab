/**
 * Diff-aware temporal comparison & regression watch alerting for
 * Site Behavior Lab v3.
 *
 * Compares two `ScanReportV3` snapshots (previous vs. current) for the same
 * domain (or staging vs. production in Developer Mode!) and emits structured
 * regression alerts and clean metric deltas.
 */

import type { ScanReportV3 } from "../schema";

export type WatchRegressionKindV3 =
  | "new-keystroke-leak"
  | "new-cname-cloak"
  | "new-server-side-tagging"
  | "new-beacon-identifiers"
  | "new-fingerprint-signal"
  | "new-tracking-entities"
  | "third-party-domain-spike"
  | "dark-pattern-regression"
  | "policy-disclosure-regression";

export type WatchRegressionAlertV3 = {
  kind: WatchRegressionKindV3;
  severity: "critical" | "high" | "medium";
  title: string;
  detail: string;
};

export type TemporalReportDiffV3 = {
  previousReportId: string;
  currentReportId: string;
  previousScannedAt: string;
  currentScannedAt: string;
  canonicalDomain: string;
  metrics: {
    totalRequestsDelta: number;
    thirdPartyRequestsDelta: number;
    thirdPartyDomainsDelta: number;
    cookiesDelta: number;
    longLivedCookiesDelta: number;
    darkPatternScoreDelta: number;
    keystrokeLeaksDelta: number;
    cnameCloaksDelta: number;
    fingerprintKindsDelta: number;
  };
  entitiesAdded: string[];
  entitiesRemoved: string[];
  beaconsAdded: string[];
  beaconsRemoved: string[];
  fingerprintsAdded: string[];
  fingerprintsRemoved: string[];
  regressions: WatchRegressionAlertV3[];
  improvements: string[];
};

export function diffScanReportsV3(previous: ScanReportV3, current: ScanReportV3): TemporalReportDiffV3 {
  const prevS = previous.leadArm.summary;
  const currS = current.leadArm.summary;

  const prevEntities = new Set(prevS.topEntities.map((e) => e.entity));
  const currEntities = new Set(currS.topEntities.map((e) => e.entity));
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

  if (currS.cnameCloaksCount > prevS.cnameCloaksCount) {
    regressions.push({
      kind: "new-cname-cloak",
      severity: "high",
      title: `New CNAME-cloaked tracking subdomain detected (+${currS.cnameCloaksCount - prevS.cnameCloaksCount})`,
      detail: `Cloaked hosts: ${current.leadArm.cnameCloaks.map((c) => `${c.host} -> ${c.entity.entity}`).join(", ")}.`
    });
  }

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

  if (currS.darkPatternScore >= prevS.darkPatternScore + 15) {
    regressions.push({
      kind: "dark-pattern-regression",
      severity: "medium",
      title: `Consent banner dark-pattern score increased (${prevS.darkPatternScore} -> ${currS.darkPatternScore})`,
      detail: `Flags: ${current.leadArm.consent.banner.darkPatternFlags.join(", ")}.`
    });
  } else if (currS.darkPatternScore <= prevS.darkPatternScore - 15) {
    improvements.push(`Consent dark-pattern score improved from ${prevS.darkPatternScore} to ${currS.darkPatternScore}.`);
  }

  const tpDelta = currS.thirdPartyDomains - prevS.thirdPartyDomains;
  if (tpDelta >= 5 || (prevS.thirdPartyDomains > 0 && tpDelta / prevS.thirdPartyDomains >= 0.25 && tpDelta >= 3)) {
    regressions.push({
      kind: "third-party-domain-spike",
      severity: "medium",
      title: `Third-party domain count jumped by +${tpDelta} (${prevS.thirdPartyDomains} -> ${currS.thirdPartyDomains})`,
      detail: entitiesAdded.length > 0 ? `Newly observed entities: ${entitiesAdded.slice(0, 6).join(", ")}.` : "Review network waterfall for newly added hosts."
    });
  } else if (tpDelta <= -3) {
    improvements.push(`Third-party domains reduced from ${prevS.thirdPartyDomains} to ${currS.thirdPartyDomains}.`);
  }

  if (entitiesAdded.length > 0 && !regressions.some((r) => r.kind === "third-party-domain-spike")) {
    regressions.push({
      kind: "new-tracking-entities",
      severity: "medium",
      title: `${entitiesAdded.length} new tracking/service ${entitiesAdded.length === 1 ? "entity" : "entities"} appeared`,
      detail: `Added: ${entitiesAdded.slice(0, 8).join(", ")}.`
    });
  }

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

  return {
    previousReportId: previous.reportId,
    currentReportId: current.reportId,
    previousScannedAt: previous.scannedAt,
    currentScannedAt: current.scannedAt,
    canonicalDomain: current.canonicalDomain,
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
