/**
 * Markdown formatters, CI policy-gate evaluator (`--fail-on`), and offline
 * cryptographic/redaction verifier for the Site Behavior Lab v3 `sbl` CLI.
 */

import { sha256Hex } from "../../sha256";
import { buildDeveloperRuleBreakdownV3, buildInitiatorCausalityTreeV3 } from "../dev-mode";
import {
  assertNoUnredactedSecretsV3,
  canonicalJsonV3,
  redactScanReportV3,
  reportV3Digest
} from "../redaction";
import type { TemporalReportDiffV3 } from "../runtime/watch-diff";
import { validateScanReportV3, type ScanReportV3 } from "../schema";

export type PolicyGateViolationV3 = {
  rule: string;
  message: string;
};

export type VerifyReportResultV3 = {
  ok: boolean;
  reportId: string | null;
  canonicalDomain: string | null;
  digest: string | null;
  redactionIdempotent: boolean;
  issues: string[];
};

/**
 * Evaluate CI `--fail-on` policy rules against a `ScanReportV3` and optional
 * baseline `TemporalReportDiffV3`.
 *
 * Supported rules:
 *  - `keystrokes` (fail if any pre-submission keystroke leak occurs)
 *  - `cname` (fail if any CNAME-cloaked tracker is found)
 *  - `sgtm` (fail if any first-party server-side tagging endpoint is found)
 *  - `fingerprinting` (fail if any fingerprinting/DOM-replay signal is found)
 *  - `beacon-pii` (fail if any beacon carries email/phone/name/address/dob/gender)
 *  - `dark-patterns` or `dark-patterns>=N` (default threshold 35)
 *  - `third-parties>N` (fail if third-party domains exceed N)
 *  - `new-entities` (with `--diff`: fail if any new entity appeared)
 *  - `regressions` (with `--diff`: fail if any regression alert was raised)
 */
export function evaluateFailOnRulesV3(
  report: ScanReportV3,
  diff: TemporalReportDiffV3 | null,
  rules: readonly string[]
): PolicyGateViolationV3[] {
  const violations: PolicyGateViolationV3[] = [];
  const s = report.leadArm.summary;

  for (const rawRule of rules) {
    const rule = rawRule.trim().toLowerCase();
    if (!rule) continue;

    if (rule === "keystrokes") {
      if (s.keystrokeLeaksCount > 0) {
        violations.push({
          rule,
          message: `Keystroke exfiltration detected (${s.keystrokeLeaksCount} leak${s.keystrokeLeaksCount === 1 ? "" : "s"}).`
        });
      }
    } else if (rule === "cname") {
      if (s.cnameCloaksCount > 0) {
        violations.push({
          rule,
          message: `CNAME-cloaked trackers detected (${s.cnameCloaksCount} host${s.cnameCloaksCount === 1 ? "" : "s"}).`
        });
      }
    } else if (rule === "sgtm") {
      if (s.serverSideTaggingEndpoints > 0) {
        violations.push({
          rule,
          message: `First-party server-side tagging endpoints detected (${s.serverSideTaggingEndpoints}).`
        });
      }
    } else if (rule === "fingerprinting") {
      if (s.fingerprintKindsCount > 0) {
        violations.push({
          rule,
          message: `Fingerprinting or DOM-replay signals detected (${s.fingerprintKindsCount} kinds).`
        });
      }
    } else if (rule === "beacon-pii") {
      const pii = report.leadArm.beacons.flatMap((b) =>
        b.identifierCategories.filter((c) => c !== "external_id")
      );
      if (pii.length > 0) {
        violations.push({
          rule,
          message: `Beacons transmitted personal identifier fields (${[...new Set(pii)].join(", ")}).`
        });
      }
    } else if (rule === "dark-patterns" || rule.startsWith("dark-patterns>=")) {
      const threshold = rule.includes(">=") ? Number(rule.split(">=")[1]) : 35;
      if (Number.isFinite(threshold) && s.darkPatternScore >= threshold) {
        violations.push({
          rule,
          message: `Consent banner dark-pattern score ${s.darkPatternScore} >= ${threshold}.`
        });
      }
    } else if (rule.startsWith("third-parties>")) {
      const limit = Number(rule.split(">")[1]);
      if (Number.isFinite(limit) && s.thirdPartyDomains > limit) {
        violations.push({
          rule,
          message: `Third-party domains (${s.thirdPartyDomains}) exceeded ceiling (${limit}).`
        });
      }
    } else if (rule === "new-entities") {
      if (diff && diff.entitiesAdded.length > 0) {
        violations.push({
          rule,
          message: `New tracking/service entities added relative to baseline: ${diff.entitiesAdded.join(", ")}.`
        });
      }
    } else if (rule === "regressions") {
      if (diff && diff.regressions.length > 0) {
        violations.push({
          rule,
          message: `${diff.regressions.length} privacy regression(s) detected relative to baseline.`
        });
      }
    } else {
      violations.push({
        rule,
        message: `Unknown --fail-on policy rule: "${rawRule}".`
      });
    }
  }

  return violations;
}

/** Format a `ScanReportV3` (plus optional diff) as crisp GitHub-Flavored Markdown for PR comments & step summaries. */
export function formatReportMarkdownV3(
  report: ScanReportV3,
  diff?: TemporalReportDiffV3 | null
): string {
  const s = report.leadArm.summary;
  const lines: string[] = [];

  lines.push(`## Site Behavior Lab v3 — \`${report.canonicalDomain}\``);
  lines.push("");
  lines.push(
    `- **URL:** \`${report.finalUrl}\` · **Region:** \`${report.provenance.egressRegion}\` · **Device:** \`${report.leadArm.conditions.device}\``
  );
  lines.push(`- **Report ID:** \`${report.reportId}\` · **SHA-256:** \`${reportV3Digest(report).slice(0, 16)}...\``);
  lines.push("");
  lines.push("| Metric | Observed |");
  lines.push("| --- | ---: |");
  lines.push(`| Third-party domains | **${s.thirdPartyDomains}** (${s.distinctEntities} entities / ${s.distinctParentOrgs} parent orgs) |`);
  lines.push(`| Tracking / total requests | **${s.trackingRequests}** / ${s.totalRequests} |`);
  lines.push(`| Shields blocked (Std / Agg) | ${s.shieldsBlockedStandard} / ${s.shieldsBlockedAggressive} |`);
  lines.push(`| Cookies (>30d / CHIPS) | ${s.cookiesTotal} (${s.longLivedCookies} / ${s.partitionedCookies}) |`);
  lines.push(`| Beacons (1st-party sGTM) | ${s.beaconPlatforms} (${s.serverSideTaggingEndpoints}) |`);
  lines.push(`| CMP dark-pattern score | **${s.darkPatternScore}/100** |`);
  lines.push(`| Keystroke leaks / CNAME cloaks / Fingerprinting | ${s.keystrokeLeaksCount} / ${s.cnameCloaksCount} / ${s.fingerprintKindsCount} |`);

  if (report.highlights.length > 0) {
    lines.push("");
    lines.push("### Key Behaviors");
    for (const h of report.highlights) {
      lines.push(`- **[${h.severity.toUpperCase()}]** ${h.title} — ${h.detail}`);
    }
  }

  if (report.comparisons.length > 0) {
    lines.push("");
    lines.push("### Concurrent Intervention Comparisons (vs. Baseline)");
    lines.push("| Intervention | Requests Δ | 3P Domains Δ | Cookies Δ | Shields Blocked |");
    lines.push("| --- | ---: | ---: | ---: | ---: |");
    for (const c of report.comparisons) {
      lines.push(
        `| ${c.axis} | ${signed(c.requestsDelta)} | ${signed(c.thirdPartyDomainsDelta)} | ${signed(c.cookiesDelta)} | ${c.shieldsBlockedCount} |`
      );
    }
  }

  const roots = buildInitiatorCausalityTreeV3(report.leadArm).slice(0, 5);
  if (roots.length > 0) {
    lines.push("");
    lines.push("### Top Originating Initiators (Root Cause)");
    for (const r of roots) {
      lines.push(
        `- \`${r.label}\` (${r.totalRequests} req, ${r.trackingRequests} tracking) → ${r.entities.map((e) => e.entity).slice(0, 5).join(", ")}`
      );
    }
  }

  const rules = buildDeveloperRuleBreakdownV3(report.leadArm).slice(0, 5);
  if (rules.length > 0) {
    lines.push("");
    lines.push("### Top Matched Brave Shields Rules");
    for (const r of rules) {
      lines.push(`- \`${r.rule}\` (*${r.list}*, ${r.matchedRequests} hits)`);
    }
  }

  if (diff) {
    lines.push("");
    lines.push(formatDiffMarkdownV3(diff));
  }

  return `${lines.join("\n")}\n`;
}

/** Format a `TemporalReportDiffV3` as crisp GitHub-Flavored Markdown. */
export function formatDiffMarkdownV3(diff: TemporalReportDiffV3): string {
  const lines: string[] = [];
  lines.push(`### Baseline Diff (\`${diff.previousReportId}\` → \`${diff.currentReportId}\`)`);
  lines.push("");
  lines.push("| Metric | Delta |");
  lines.push("| --- | ---: |");
  lines.push(`| Third-party domains | ${signed(diff.metrics.thirdPartyDomainsDelta)} |`);
  lines.push(`| Third-party requests | ${signed(diff.metrics.thirdPartyRequestsDelta)} |`);
  lines.push(`| Cookies | ${signed(diff.metrics.cookiesDelta)} |`);
  lines.push(`| CMP dark-pattern score | ${signed(diff.metrics.darkPatternScoreDelta)} |`);
  lines.push(`| Keystroke leaks | ${signed(diff.metrics.keystrokeLeaksDelta)} |`);
  lines.push(`| CNAME cloaks | ${signed(diff.metrics.cnameCloaksDelta)} |`);

  if (diff.regressions.length > 0) {
    lines.push("");
    lines.push("#### Regression Alerts");
    for (const r of diff.regressions) {
      lines.push(`- **[${r.severity.toUpperCase()}]** ${r.title} — ${r.detail}`);
    }
  } else {
    lines.push("");
    lines.push("No privacy regressions detected relative to baseline.");
  }

  if (diff.improvements.length > 0) {
    lines.push("");
    lines.push("#### Improvements");
    for (const imp of diff.improvements) {
      lines.push(`- ${imp}`);
    }
  }

  if (diff.entitiesAdded.length > 0) {
    lines.push("");
    lines.push(`**Entities added:** ${diff.entitiesAdded.join(", ")}`);
  }
  if (diff.entitiesRemoved.length > 0) {
    lines.push(`**Entities removed:** ${diff.entitiesRemoved.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}

/** Offline verification of a serialized `ScanReportV3` JSON document. */
export function verifyReportV3Json(rawJson: string): VerifyReportResultV3 {
  const issues: string[] = [];
  let parsed: ScanReportV3;
  try {
    parsed = JSON.parse(rawJson) as ScanReportV3;
  } catch (err) {
    return {
      ok: false,
      reportId: null,
      canonicalDomain: null,
      digest: null,
      redactionIdempotent: false,
      issues: [`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`]
    };
  }

  const schemaIssues = validateScanReportV3(parsed);
  issues.push(...schemaIssues);

  let redactionIdempotent = false;
  let digest: string | null = null;

  if (schemaIssues.length === 0) {
    try {
      assertNoUnredactedSecretsV3(parsed, []);
    } catch (err) {
      issues.push(err instanceof Error ? err.message : String(err));
    }
    const rawDigest = sha256Hex(canonicalJsonV3(parsed));
    const afterRedacted = redactScanReportV3(parsed);
    const afterDigest = sha256Hex(canonicalJsonV3(afterRedacted));
    redactionIdempotent = rawDigest === afterDigest;
    if (!redactionIdempotent) {
      issues.push("Report is not a redaction fixed point (re-redacting changes canonical SHA-256 digest).");
    }
    digest = rawDigest;
  }

  return {
    ok: issues.length === 0,
    reportId: typeof parsed?.reportId === "string" ? parsed.reportId : null,
    canonicalDomain: typeof parsed?.canonicalDomain === "string" ? parsed.canonicalDomain : null,
    digest,
    redactionIdempotent,
    issues
  };
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
