/**
 * Pure summary, comparison-delta, and behavior-first highlight builders for
 * Site Behavior Lab v3 reports.
 *
 * Replaces the old boilerplate Shields-delta-only headline with site-behavior-
 * first highlights ordered by real behavioral severity (keystroke leaks,
 * CNAME cloaking, server-side tagging, fingerprinting/replay, consent dark
 * patterns, long-lived third-party tracking, policy contradictions).
 */

import { isTrackingCategoryV3 } from "../entity-catalog";
import type {
  ArmSummaryV3,
  BeaconEventSummaryV3,
  CnameCloakV3,
  ComparisonAxisV3,
  ComparisonDeltaV3,
  ConsentSummaryV3,
  CookieRecordV3,
  FingerprintDetectionV3,
  KeystrokeSummaryV3,
  NetworkRequestV3,
  ReportHighlightV3,
  ScanArmV3,
  ServiceWorkerRecordV3,
  StorageRecordV3,
  WebSocketRecordV3
} from "../schema";

export function buildArmSummaryV3(input: {
  network: readonly NetworkRequestV3[];
  websockets: readonly WebSocketRecordV3[];
  serviceWorkers: readonly ServiceWorkerRecordV3[];
  cookies: readonly CookieRecordV3[];
  storage: readonly StorageRecordV3[];
  beacons: readonly BeaconEventSummaryV3[];
  cnameCloaks: readonly CnameCloakV3[];
  fingerprinting: readonly FingerprintDetectionV3[];
  keystrokes: KeystrokeSummaryV3;
  consent: ConsentSummaryV3;
}): ArmSummaryV3 {
  const thirdPartyDomains = new Set<string>();
  const entities = new Map<
    string,
    { entity: string; parentOrg: string; category: NonNullable<NetworkRequestV3["entity"]>["category"]; requests: number; domains: Set<string> }
  >();
  const parentOrgs = new Set<string>();

  let thirdPartyRequests = 0;
  let trackingRequests = 0;
  let shieldsMatchedRequests = 0;
  let shieldsBlockedStandard = 0;
  let shieldsBlockedAggressive = 0;

  for (const req of input.network) {
    if (req.thirdParty) {
      thirdPartyRequests += 1;
      thirdPartyDomains.add(req.registrableDomain);
    }
    if (req.shields.matched) shieldsMatchedRequests += 1;
    if (req.shields.shouldBlockStandard) shieldsBlockedStandard += 1;
    if (req.shields.shouldBlockAggressive) shieldsBlockedAggressive += 1;

    if (req.entity) {
      if (isTrackingCategoryV3(req.entity.category) || req.shields.shouldBlockAggressive) {
        trackingRequests += 1;
      }
      if (req.thirdParty || isTrackingCategoryV3(req.entity.category)) {
        parentOrgs.add(req.entity.parentOrg);
        const existing = entities.get(req.entity.entity);
        if (existing) {
          existing.requests += 1;
          existing.domains.add(req.domain);
        } else {
          entities.set(req.entity.entity, {
            entity: req.entity.entity,
            parentOrg: req.entity.parentOrg,
            category: req.entity.category,
            requests: 1,
            domains: new Set([req.domain])
          });
        }
      }
    } else if (req.shields.shouldBlockAggressive) {
      trackingRequests += 1;
    }
  }

  for (const cloak of input.cnameCloaks) {
    parentOrgs.add(cloak.entity.parentOrg);
    const existing = entities.get(cloak.entity.entity);
    if (existing) {
      existing.requests += cloak.requestCount;
      existing.domains.add(cloak.host);
    } else {
      entities.set(cloak.entity.entity, {
        entity: cloak.entity.entity,
        parentOrg: cloak.entity.parentOrg,
        category: cloak.entity.category,
        requests: cloak.requestCount,
        domains: new Set([cloak.host])
      });
    }
  }

  const topEntities = [...entities.values()]
    .map((e) => ({
      entity: e.entity,
      parentOrg: e.parentOrg,
      category: e.category,
      requests: e.requests,
      domains: e.domains.size
    }))
    .sort((a, b) => b.requests - a.requests || a.entity.localeCompare(b.entity))
    .slice(0, 15);

  const thirdPartyCookies = input.cookies.filter((c) => c.thirdParty).length;
  const longLivedCookies = input.cookies.filter((c) => c.ttlDays !== null && c.ttlDays > 30).length;
  const partitionedCookies = input.cookies.filter((c) => c.partitionKey !== null).length;
  const serverSideTaggingEndpoints = input.beacons.filter((b) => b.serverSideTagging).length;

  return {
    totalRequests: input.network.length,
    thirdPartyRequests,
    thirdPartyDomains: thirdPartyDomains.size,
    trackingRequests,
    shieldsMatchedRequests,
    shieldsBlockedStandard,
    shieldsBlockedAggressive,
    distinctEntities: entities.size,
    distinctParentOrgs: parentOrgs.size,
    cookiesTotal: input.cookies.length,
    thirdPartyCookies,
    longLivedCookies,
    partitionedCookies,
    storageKeysTotal: input.storage.length,
    websocketsTotal: input.websockets.length,
    serviceWorkersTotal: input.serviceWorkers.length,
    beaconPlatforms: new Set(input.beacons.map((b) => b.platform)).size,
    serverSideTaggingEndpoints,
    cnameCloaksCount: input.cnameCloaks.length,
    fingerprintKindsCount: input.fingerprinting.length,
    keystrokeLeaksCount: input.keystrokes.leaks.length,
    darkPatternScore: input.consent.banner.darkPatternScore,
    topEntities
  };
}

export function buildComparisonDeltaV3(
  baseline: ScanArmV3,
  variant: ScanArmV3,
  axis: ComparisonAxisV3
): ComparisonDeltaV3 {
  const baseEntities = new Set(baseline.summary.topEntities.map((e) => e.entity));
  const variantEntities = new Set(variant.summary.topEntities.map((e) => e.entity));
  const entitiesRemoved = [...baseEntities].filter((e) => !variantEntities.has(e)).sort();
  const entitiesAdded = [...variantEntities].filter((e) => !baseEntities.has(e)).sort();
  const shieldsBlockedCount = variant.network.filter((r) => r.shields.blocked).length;

  return {
    baselineArmId: baseline.armId,
    variantArmId: variant.armId,
    axis,
    requestsDelta: variant.summary.totalRequests - baseline.summary.totalRequests,
    thirdPartyRequestsDelta: variant.summary.thirdPartyRequests - baseline.summary.thirdPartyRequests,
    thirdPartyDomainsDelta: variant.summary.thirdPartyDomains - baseline.summary.thirdPartyDomains,
    cookiesDelta: variant.summary.cookiesTotal - baseline.summary.cookiesTotal,
    beaconsDelta: variant.summary.beaconPlatforms - baseline.summary.beaconPlatforms,
    fingerprintKindsDelta: variant.summary.fingerprintKindsCount - baseline.summary.fingerprintKindsCount,
    keystrokeLeaksDelta: variant.summary.keystrokeLeaksCount - baseline.summary.keystrokeLeaksCount,
    entitiesRemoved,
    entitiesAdded,
    shieldsBlockedCount
  };
}

/** Generate site-behavior-first highlights ordered by severity. */
export function buildReportHighlightsV3(leadArm: ScanArmV3): ReportHighlightV3[] {
  const highlights: ReportHighlightV3[] = [];
  const s = leadArm.summary;

  if (leadArm.keystrokes.leaks.length > 0) {
    const recipients = [...new Set(leadArm.keystrokes.leaks.map((l) => l.cnameTarget ?? l.domain))];
    highlights.push({
      id: "keystroke-exfiltration",
      severity: "critical",
      category: "keystrokes",
      title: `Typed form input transmitted before submission to ${recipients.length} ${plural(recipients.length, "recipient")}`,
      detail: `Synthetic canary observed leaving via ${[...new Set(leadArm.keystrokes.leaks.map((l) => l.transport))].join(", ")} to ${recipients.slice(0, 4).join(", ")}.`
    });
  }

  if (leadArm.cnameCloaks.length > 0) {
    const names = [...new Set(leadArm.cnameCloaks.map((c) => c.entity.entity))];
    highlights.push({
      id: "cname-cloaking",
      severity: "high",
      category: "cname-cloaking",
      title: `${leadArm.cnameCloaks.length} first-party ${plural(leadArm.cnameCloaks.length, "subdomain")} CNAME-cloaked to third-party trackers`,
      detail: `DNS CNAME uncloaking linked ${leadArm.cnameCloaks.map((c) => c.host).slice(0, 3).join(", ")} to ${names.slice(0, 4).join(", ")}.`
    });
  }

  const piiBeacons = leadArm.beacons.filter((b) => b.identifierCategories.length > 0);
  if (piiBeacons.length > 0) {
    const categories = [...new Set(piiBeacons.flatMap((b) => b.identifierCategories))];
    highlights.push({
      id: "beacon-identifiers",
      severity: "high",
      category: "beacons",
      title: `Tracking beacons attached personal-identifier fields (${categories.join(", ")})`,
      detail: `Observed populated identifier parameters on ${piiBeacons.map((b) => b.platform).slice(0, 4).join(", ")} requests (values never stored).`
    });
  }

  const sgtmBeacons = leadArm.beacons.filter((b) => b.serverSideTagging);
  if (sgtmBeacons.length > 0) {
    highlights.push({
      id: "server-side-tagging",
      severity: "high",
      category: "server-side-tagging",
      title: `First-party server-side tagging detected on ${sgtmBeacons.length} ${plural(sgtmBeacons.length, "endpoint")}`,
      detail: `First-party hosts (${sgtmBeacons.map((b) => b.endpointHost).slice(0, 3).join(", ")}) carried ${sgtmBeacons.map((b) => b.product).slice(0, 3).join(", ")}.`
    });
  }

  const replayFp = leadArm.fingerprinting.filter(
    (f) => f.kind === "canvas" || f.kind === "webgl" || f.kind === "audio" || f.kind === "webgpu" || f.kind === "mutation-observer-replay"
  );
  if (replayFp.length > 0) {
    highlights.push({
      id: "fingerprinting-and-replay",
      severity: "high",
      category: "fingerprinting",
      title: `${replayFp.length} high-entropy fingerprinting or DOM-replay ${plural(replayFp.length, "signal")} observed`,
      detail: `Detected ${replayFp.map((f) => f.kind).join(", ")} across ${[...new Set(replayFp.flatMap((f) => f.realms))].join(", ")}.`
    });
  }

  if (leadArm.consent.banner.detected && leadArm.consent.banner.darkPatternScore >= 35) {
    highlights.push({
      id: "consent-dark-patterns",
      severity: "medium",
      category: "consent",
      title: `Consent banner scored ${leadArm.consent.banner.darkPatternScore}/100 on dark-pattern audit`,
      detail: `Observed flags: ${leadArm.consent.banner.darkPatternFlags.join(", ")}.`
    });
  }

  if (leadArm.policy && leadArm.policy.unmentionedEntities.length > 0) {
    highlights.push({
      id: "policy-unmentioned-entities",
      severity: "medium",
      category: "policy",
      title: `${leadArm.policy.unmentionedEntities.length} observed tracking ${plural(leadArm.policy.unmentionedEntities.length, "company", "companies")} not named in privacy policy`,
      detail: `Unmentioned in ${leadArm.policy.url}: ${leadArm.policy.unmentionedEntities.slice(0, 5).join(", ")}.`
    });
  }

  if (s.thirdPartyDomains > 0) {
    highlights.push({
      id: "third-party-footprint",
      severity: s.thirdPartyDomains >= 25 ? "medium" : "info",
      category: "third-parties",
      title: `Contacted ${s.thirdPartyDomains} third-party ${plural(s.thirdPartyDomains, "domain")} across ${s.distinctParentOrgs} corporate ${plural(s.distinctParentOrgs, "group")}`,
      detail: `${s.trackingRequests} of ${s.totalRequests} requests matched tracking services or Brave Shields filter rules (${s.shieldsBlockedStandard} standard / ${s.shieldsBlockedAggressive} aggressive).`
    });
  } else {
    highlights.push({
      id: "minimal-footprint",
      severity: "info",
      category: "third-parties",
      title: "No third-party domains contacted during this visit",
      detail: `Recorded ${s.totalRequests} first-party requests and ${s.cookiesTotal} cookies.`
    });
  }

  return highlights;
}

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return n === 1 ? singular : pluralForm;
}
