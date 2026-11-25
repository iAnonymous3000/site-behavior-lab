/**
 * SARIF 2.1.0 exporter for Site Behavior Lab v3 reports & regression diffs.
 *
 * Enables GitHub Code Scanning / Security tab integration in CI pipelines
 * without any external dependencies.
 */

import type { TemporalReportDiffV3 } from "../runtime/watch-diff";
import type { ScanReportV3 } from "../schema";

export type SarifLevel = "error" | "warning" | "note";

export type SarifRule = {
  id: string;
  name: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties?: { tags?: string[] };
};

export type SarifResult = {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
    };
  }[];
  properties?: Record<string, unknown>;
};

export type SarifLogV210 = {
  $schema: string;
  version: "2.1.0";
  runs: {
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: SarifRule[];
      };
    };
    results: SarifResult[];
  }[];
};

const SARIF_SCHEMA =
  "https://json.schemastore.org/sarif-2.1.0.json";

const RULES: Record<string, SarifRule> = {
  "SBL-KEYSTROKE-EXFIL": {
    id: "SBL-KEYSTROKE-EXFIL",
    name: "PreSubmissionKeystrokeExfiltration",
    shortDescription: { text: "Pre-submission keystroke exfiltration detected" },
    defaultConfiguration: { level: "error" },
    properties: { tags: ["privacy", "security", "keystroke-exfiltration"] }
  },
  "SBL-CNAME-CLOAK": {
    id: "SBL-CNAME-CLOAK",
    name: "CnameCloakedTracker",
    shortDescription: { text: "First-party subdomain CNAME-cloaks a third-party tracker" },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "cname-cloaking"] }
  },
  "SBL-SGTM-ENDPOINT": {
    id: "SBL-SGTM-ENDPOINT",
    name: "FirstPartyServerSideTagging",
    shortDescription: { text: "First-party server-side tagging / CAPI endpoint observed" },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "server-side-tagging"] }
  },
  "SBL-BEACON-PII": {
    id: "SBL-BEACON-PII",
    name: "BeaconPersonalIdentifiers",
    shortDescription: { text: "Tracking beacon transmits personal-identifier parameters" },
    defaultConfiguration: { level: "error" },
    properties: { tags: ["privacy", "pii", "beacons"] }
  },
  "SBL-FINGERPRINTING": {
    id: "SBL-FINGERPRINTING",
    name: "FingerprintingOrDomReplay",
    shortDescription: { text: "Browser fingerprinting or DOM-wide session replay observed" },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "fingerprinting"] }
  },
  "SBL-DARK-PATTERNS": {
    id: "SBL-DARK-PATTERNS",
    name: "ConsentBannerDarkPatterns",
    shortDescription: { text: "Consent banner exhibits elevated dark-pattern score" },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "consent", "dark-patterns"] }
  },
  "SBL-POLICY-GAP": {
    id: "SBL-POLICY-GAP",
    name: "UndisclosedTrackingEntities",
    shortDescription: { text: "Observed tracking entities are not mentioned in the discovered privacy policy" },
    defaultConfiguration: { level: "note" },
    properties: { tags: ["privacy", "policy-disclosure"] }
  },
  "SBL-REGRESSION": {
    id: "SBL-REGRESSION",
    name: "PrivacyBehaviorRegression",
    shortDescription: { text: "Privacy behavior regressed relative to baseline scan" },
    defaultConfiguration: { level: "error" },
    properties: { tags: ["privacy", "regression"] }
  }
};

function makeLocation(uri: string) {
  return [{ physicalLocation: { artifactLocation: { uri } } }];
}

/** Export a single `ScanReportV3` (and optional `TemporalReportDiffV3`) as SARIF 2.1.0 JSON. */
export function reportToSarifV3(
  report: ScanReportV3,
  diff?: TemporalReportDiffV3 | null
): SarifLogV210 {
  const results: SarifResult[] = [];
  const usedRuleIds = new Set<string>();
  const arm = report.leadArm;
  const targetUri = report.finalUrl || report.targetUrl;

  for (const leak of arm.keystrokes.leaks) {
    usedRuleIds.add("SBL-KEYSTROKE-EXFIL");
    results.push({
      ruleId: "SBL-KEYSTROKE-EXFIL",
      level: "error",
      message: {
        text: `Keystroke input transmitted before form submission to ${leak.cnameTarget ?? leak.domain} via ${leak.transport} (${leak.encoding}).`
      },
      locations: makeLocation(targetUri),
      properties: {
        domain: leak.domain,
        cnameTarget: leak.cnameTarget ?? null,
        transport: leak.transport,
        encoding: leak.encoding,
        phase: leak.phase
      }
    });
  }

  for (const cloak of arm.cnameCloaks) {
    usedRuleIds.add("SBL-CNAME-CLOAK");
    results.push({
      ruleId: "SBL-CNAME-CLOAK",
      level: "warning",
      message: {
        text: `First-party host ${cloak.host} CNAME-cloaks ${cloak.entity.entity} (${cloak.targetDomain}) across ${cloak.requestCount} requests.`
      },
      locations: makeLocation(`https://${cloak.host}/`),
      properties: {
        host: cloak.host,
        cnameChain: cloak.cnameChain,
        entity: cloak.entity.entity,
        parentOrg: cloak.entity.parentOrg
      }
    });
  }

  for (const beacon of arm.beacons) {
    if (beacon.serverSideTagging) {
      usedRuleIds.add("SBL-SGTM-ENDPOINT");
      results.push({
        ruleId: "SBL-SGTM-ENDPOINT",
        level: "warning",
        message: {
          text: `First-party server-side tagging endpoint detected: ${beacon.platform} via ${beacon.endpointHost} (${beacon.requests} requests).`
        },
        locations: makeLocation(`https://${beacon.endpointHost}/`),
        properties: { platform: beacon.platform, events: beacon.events }
      });
    }
    if (beacon.identifierCategories.length > 0) {
      usedRuleIds.add("SBL-BEACON-PII");
      results.push({
        ruleId: "SBL-BEACON-PII",
        level: "error",
        message: {
          text: `${beacon.platform} beacon at ${beacon.endpointHost} includes personal identifier fields: ${beacon.identifierCategories.join(", ")}.`
        },
        locations: makeLocation(`https://${beacon.endpointHost}/`),
        properties: {
          platform: beacon.platform,
          identifierCategories: beacon.identifierCategories
        }
      });
    }
  }

  for (const fp of arm.fingerprinting) {
    usedRuleIds.add("SBL-FINGERPRINTING");
    results.push({
      ruleId: "SBL-FINGERPRINTING",
      level: fp.kind === "mutation-observer-replay" ? "warning" : "note",
      message: {
        text: `Observed ${fp.kind} signal (${fp.count} calls) across realms: ${fp.realms.join(", ")}.`
      },
      locations: makeLocation(targetUri),
      properties: { kind: fp.kind, realms: fp.realms, apis: fp.apis }
    });
  }

  if (arm.consent.banner.darkPatternScore >= 35) {
    usedRuleIds.add("SBL-DARK-PATTERNS");
    results.push({
      ruleId: "SBL-DARK-PATTERNS",
      level: "warning",
      message: {
        text: `Consent banner (${arm.consent.banner.cmp ?? "unknown CMP"}) scored ${arm.consent.banner.darkPatternScore}/100 for dark patterns: ${arm.consent.banner.darkPatternFlags.join(", ")}.`
      },
      locations: makeLocation(targetUri),
      properties: {
        score: arm.consent.banner.darkPatternScore,
        flags: arm.consent.banner.darkPatternFlags
      }
    });
  }

  if (arm.policy && arm.policy.unmentionedEntities.length > 0) {
    usedRuleIds.add("SBL-POLICY-GAP");
    results.push({
      ruleId: "SBL-POLICY-GAP",
      level: "note",
      message: {
        text: `${arm.policy.unmentionedEntities.length} observed tracking entities were not mentioned in ${arm.policy.url}: ${arm.policy.unmentionedEntities.slice(0, 8).join(", ")}.`
      },
      locations: makeLocation(arm.policy.url),
      properties: { unmentionedEntities: arm.policy.unmentionedEntities }
    });
  }

  if (diff) {
    for (const reg of diff.regressions) {
      usedRuleIds.add("SBL-REGRESSION");
      results.push({
        ruleId: "SBL-REGRESSION",
        level: reg.severity === "critical" || reg.severity === "high" ? "error" : "warning",
        message: { text: `[${reg.kind}] ${reg.title} — ${reg.detail}` },
        locations: makeLocation(targetUri),
        properties: {
          kind: reg.kind,
          severity: reg.severity,
          previousReportId: diff.previousReportId,
          currentReportId: diff.currentReportId
        }
      });
    }
  }

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Site Behavior Lab",
            version: report.provenance.scannerVersion,
            informationUri: "https://sitebehavior.org",
            rules: [...usedRuleIds].map((id) => RULES[id])
          }
        },
        results
      }
    ]
  };
}

/** Export a standalone `TemporalReportDiffV3` as SARIF 2.1.0 JSON. */
export function diffToSarifV3(diff: TemporalReportDiffV3): SarifLogV210 {
  const results: SarifResult[] = diff.regressions.map((reg) => ({
    ruleId: "SBL-REGRESSION",
    level: reg.severity === "critical" || reg.severity === "high" ? "error" : "warning",
    message: { text: `[${reg.kind}] ${reg.title} — ${reg.detail}` },
    locations: makeLocation(`https://${diff.canonicalDomain}/`),
    properties: {
      kind: reg.kind,
      severity: reg.severity,
      previousReportId: diff.previousReportId,
      currentReportId: diff.currentReportId
    }
  }));

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Site Behavior Lab",
            version: "sbl-v3.0.0",
            informationUri: "https://sitebehavior.org",
            rules: results.length > 0 ? [RULES["SBL-REGRESSION"]] : []
          }
        },
        results
      }
    ]
  };
}
