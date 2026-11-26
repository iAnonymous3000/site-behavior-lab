/**
 * SARIF 2.1.0 exporter for Site Behavior Lab v3 reports & regression diffs.
 *
 * Enables GitHub Code Scanning / Security tab integration in CI pipelines
 * without any external dependencies.
 */

import { sha256Hex } from "../../sha256";
import type { TemporalReportDiffV3 } from "../runtime/watch-diff";
import { SCANNER_V3_VERSION } from "../scanner";
import type { ScanReportV3 } from "../schema";

export type SarifLevel = "error" | "warning" | "note";

export type SarifRule = {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription: { text: string };
  help: { text: string };
  defaultConfiguration: { level: SarifLevel };
  properties?: { tags?: string[] };
};

export type SarifResult = {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  partialFingerprints: { primaryLocationLineHash: string };
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number };
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
    fullDescription: { text: "Synthetic input typed into a form field was transmitted over the network before form submission." },
    help: { text: "Audit session-replay, analytics, and third-party scripts attached to form fields and disable pre-submit keystroke capture." },
    defaultConfiguration: { level: "error" },
    properties: { tags: ["privacy", "security", "keystroke-exfiltration"] }
  },
  "SBL-CNAME-CLOAK": {
    id: "SBL-CNAME-CLOAK",
    name: "CnameCloakedTracker",
    shortDescription: { text: "First-party subdomain CNAME-cloaks a third-party tracker" },
    fullDescription: { text: "A first-party DNS subdomain delegates via CNAME to a third-party tracking infrastructure host." },
    help: { text: "Remove CNAME tracker delegation or disclose and gate the endpoint behind explicit user consent." },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "cname-cloaking"] }
  },
  "SBL-SGTM-ENDPOINT": {
    id: "SBL-SGTM-ENDPOINT",
    name: "FirstPartyServerSideTagging",
    shortDescription: { text: "First-party server-side tagging / CAPI endpoint observed" },
    fullDescription: { text: "A first-party host carried analytics or ad-conversion beacon payloads typical of server-side tagging." },
    help: { text: "Verify server-side forwarding respects user consent, Global Privacy Control, and privacy policy disclosures." },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "server-side-tagging"] }
  },
  "SBL-BEACON-PII": {
    id: "SBL-BEACON-PII",
    name: "BeaconPersonalIdentifiers",
    shortDescription: { text: "Tracking beacon transmits personal-identifier parameters" },
    fullDescription: { text: "A decoded tracking beacon included populated personal identifier parameters (such as email, phone, or user ID)." },
    help: { text: "Strip personal identifiers from tracking requests or ensure explicit prior user consent." },
    defaultConfiguration: { level: "error" },
    properties: { tags: ["privacy", "pii", "beacons"] }
  },
  "SBL-FINGERPRINTING": {
    id: "SBL-FINGERPRINTING",
    name: "FingerprintingOrDomReplay",
    shortDescription: { text: "Browser fingerprinting or DOM-wide session replay observed" },
    fullDescription: { text: "High-entropy browser fingerprinting APIs or root-level DOM mutation replay were observed during page load." },
    help: { text: "Review third-party scripts invoking canvas/WebGL/audio/WebGPU/font/client-hint fingerprinting APIs." },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "fingerprinting"] }
  },
  "SBL-DARK-PATTERNS": {
    id: "SBL-DARK-PATTERNS",
    name: "ConsentBannerDarkPatterns",
    shortDescription: { text: "Consent banner exhibits elevated dark-pattern score" },
    fullDescription: { text: "The site's consent banner showed asymmetric accept/reject paths, hidden reject options, pre-ticked boxes, or a cookie wall." },
    help: { text: "Provide an equally prominent Layer-1 Reject All button with no pre-checked non-essential categories." },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "consent", "dark-patterns"] }
  },
  "SBL-POLICY-GAP": {
    id: "SBL-POLICY-GAP",
    name: "UndisclosedTrackingEntities",
    shortDescription: { text: "Observed tracking entities are not mentioned in the discovered privacy policy" },
    fullDescription: { text: "Third-party tracking companies observed on the page were not named in the site's discovered privacy policy." },
    help: { text: "Update the privacy policy vendor list or remove unintended third-party tags." },
    defaultConfiguration: { level: "note" },
    properties: { tags: ["privacy", "policy-disclosure"] }
  },
  "SBL-REGRESSION": {
    id: "SBL-REGRESSION",
    name: "PrivacyBehaviorRegression",
    shortDescription: { text: "Privacy behavior regressed relative to baseline scan" },
    fullDescription: { text: "One or more privacy metrics or tracking behaviors regressed compared to the baseline scan report." },
    help: { text: "Inspect the diff report and revert or gate newly introduced trackers, beacons, or dark patterns." },
    defaultConfiguration: { level: "error" },
    properties: { tags: ["privacy", "regression"] }
  },
  "SBL-DIFF-INSUFFICIENT-EVIDENCE": {
    id: "SBL-DIFF-INSUFFICIENT-EVIDENCE",
    name: "BaselineComparisonInsufficientEvidence",
    shortDescription: { text: "Baseline comparison lacks comparable evidence for one or more checks" },
    fullDescription: {
      text: "The baseline and current visits differed in visit conditions, load outcome, or probe coverage (such as 0 input fields exercised), so regression judgment could not be completed for one or more families."
    },
    help: {
      text: "Re-scan with matching visit conditions and ensure the target page exposes comparable probe coverage before treating the baseline comparison as clean."
    },
    defaultConfiguration: { level: "warning" },
    properties: { tags: ["privacy", "comparability", "insufficient-evidence"] }
  }
};

function makeLocation(artifactUri: string) {
  // Repo-relative artifact path keeps GitHub Code Scanning SARIF ingestion compatible.
  return [{ physicalLocation: { artifactLocation: { uri: artifactUri }, region: { startLine: 1 } } }];
}

function makeFingerprint(ruleId: string, key: string): { primaryLocationLineHash: string } {
  return { primaryLocationLineHash: sha256Hex(`${ruleId}:${key}`).slice(0, 32) };
}

/** Export a single `ScanReportV3` (and optional `TemporalReportDiffV3`) as SARIF 2.1.0 JSON. */
export function reportToSarifV3(
  report: ScanReportV3,
  diff?: TemporalReportDiffV3 | null,
  artifactUri = "sbl-report.v3.json"
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
      partialFingerprints: makeFingerprint("SBL-KEYSTROKE-EXFIL", `${report.canonicalDomain}:${leak.domain}:${leak.transport}`),
      locations: makeLocation(artifactUri),
      properties: {
        targetUrl: targetUri,
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
      partialFingerprints: makeFingerprint("SBL-CNAME-CLOAK", `${report.canonicalDomain}:${cloak.host}:${cloak.targetDomain}`),
      locations: makeLocation(artifactUri),
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
        partialFingerprints: makeFingerprint("SBL-SGTM-ENDPOINT", `${report.canonicalDomain}:${beacon.platform}:${beacon.endpointHost}`),
        locations: makeLocation(artifactUri),
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
        partialFingerprints: makeFingerprint("SBL-BEACON-PII", `${report.canonicalDomain}:${beacon.platform}:${beacon.identifierCategories.join(",")}`),
        locations: makeLocation(artifactUri),
        properties: {
          platform: beacon.platform,
          identifierCategories: beacon.identifierCategories
        }
      });
    }
  }

  const HIGH_ENTROPY_FP = new Set(["canvas", "webgl", "audio", "webgpu", "mutation-observer-replay"]);
  for (const fp of arm.fingerprinting) {
    if (fp.kind === "document-cookie-writes") continue;
    usedRuleIds.add("SBL-FINGERPRINTING");
    results.push({
      ruleId: "SBL-FINGERPRINTING",
      level: HIGH_ENTROPY_FP.has(fp.kind) ? "warning" : "note",
      message: {
        text: `Observed ${fp.kind} signal (${fp.count} calls) across realms: ${fp.realms.join(", ")}.`
      },
      partialFingerprints: makeFingerprint("SBL-FINGERPRINTING", `${report.canonicalDomain}:${fp.kind}`),
      locations: makeLocation(artifactUri),
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
      partialFingerprints: makeFingerprint("SBL-DARK-PATTERNS", `${report.canonicalDomain}:${arm.consent.banner.cmp ?? "generic"}`),
      locations: makeLocation(artifactUri),
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
      partialFingerprints: makeFingerprint("SBL-POLICY-GAP", `${report.canonicalDomain}:${arm.policy.url}`),
      locations: makeLocation(artifactUri),
      properties: { policyUrl: arm.policy.url, unmentionedEntities: arm.policy.unmentionedEntities }
    });
  }

  if (diff) {
    for (const reg of diff.regressions) {
      usedRuleIds.add("SBL-REGRESSION");
      results.push({
        ruleId: "SBL-REGRESSION",
        level: reg.severity === "critical" || reg.severity === "high" ? "error" : "warning",
        message: { text: `[${reg.kind}] ${reg.title} — ${reg.detail}` },
        partialFingerprints: makeFingerprint("SBL-REGRESSION", `${report.canonicalDomain}:${reg.kind}`),
        locations: makeLocation(artifactUri),
        properties: {
          kind: reg.kind,
          severity: reg.severity,
          previousReportId: diff.previousReportId,
          currentReportId: diff.currentReportId
        }
      });
    }
    for (const item of buildInsufficientEvidenceSarifResults(diff, artifactUri)) {
      usedRuleIds.add("SBL-DIFF-INSUFFICIENT-EVIDENCE");
      results.push(item);
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

function buildInsufficientEvidenceSarifResults(
  diff: TemporalReportDiffV3,
  artifactUri: string
): SarifResult[] {
  if (diff.comparability.status === "comparable") return [];
  if (diff.comparability.reasons.length > 0) {
    return [
      {
        ruleId: "SBL-DIFF-INSUFFICIENT-EVIDENCE",
        level: "warning",
        message: {
          text: `Insufficient evidence to compare baseline ${diff.previousReportId} and current ${diff.currentReportId}: ${diff.comparability.reasons.join(" ")}`
        },
        partialFingerprints: makeFingerprint(
          "SBL-DIFF-INSUFFICIENT-EVIDENCE",
          `${diff.canonicalDomain}:global:${diff.comparability.status}`
        ),
        locations: makeLocation(artifactUri),
        properties: {
          comparabilityStatus: diff.comparability.status,
          reasons: diff.comparability.reasons,
          previousReportId: diff.previousReportId,
          currentReportId: diff.currentReportId
        }
      }
    ];
  }
  return diff.comparability.insufficientEvidence.map((item) => ({
    ruleId: "SBL-DIFF-INSUFFICIENT-EVIDENCE",
    level: "warning",
    message: {
      text: `[${item.family}] ${item.reason}`
    },
    partialFingerprints: makeFingerprint(
      "SBL-DIFF-INSUFFICIENT-EVIDENCE",
      `${diff.canonicalDomain}:${item.family}`
    ),
    locations: makeLocation(artifactUri),
    properties: {
      comparabilityStatus: diff.comparability.status,
      family: item.family,
      previousReportId: diff.previousReportId,
      currentReportId: diff.currentReportId
    }
  }));
}

/** Export a standalone `TemporalReportDiffV3` as SARIF 2.1.0 JSON. */
export function diffToSarifV3(diff: TemporalReportDiffV3, artifactUri = "sbl-diff.v3.json"): SarifLogV210 {
  const usedRuleIds = new Set<string>();
  const results: SarifResult[] = diff.regressions.map((reg) => {
    usedRuleIds.add("SBL-REGRESSION");
    return {
      ruleId: "SBL-REGRESSION",
      level: reg.severity === "critical" || reg.severity === "high" ? "error" : "warning",
      message: { text: `[${reg.kind}] ${reg.title} — ${reg.detail}` },
      partialFingerprints: makeFingerprint("SBL-REGRESSION", `${diff.canonicalDomain}:${reg.kind}`),
      locations: makeLocation(artifactUri),
      properties: {
        kind: reg.kind,
        severity: reg.severity,
        previousReportId: diff.previousReportId,
        currentReportId: diff.currentReportId
      }
    };
  });

  for (const item of buildInsufficientEvidenceSarifResults(diff, artifactUri)) {
    usedRuleIds.add("SBL-DIFF-INSUFFICIENT-EVIDENCE");
    results.push(item);
  }

  return {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Site Behavior Lab",
            version: SCANNER_V3_VERSION,
            informationUri: "https://sitebehavior.org",
            rules: [...usedRuleIds].map((id) => RULES[id])
          }
        },
        results
      }
    ]
  };
}
