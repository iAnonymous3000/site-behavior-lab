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
  kind?: "policy-violation" | "insufficient-evidence";
};

export type VerifyReportOptionsV3 = {
  /** Expected canonical JSON SHA-256 or raw UTF-8 file SHA-256 (64 lowercase hex chars). */
  expectedSha256?: string | null;
  /** Optional raw JSON contents of a v3 corpus manifest (`public/v3/manifest.json`) to verify against. */
  manifestJson?: string | null;
};

export type VerifyReportResultV3 = {
  ok: boolean;
  reportId: string | null;
  canonicalDomain: string | null;
  /** Canonical JSON SHA-256 digest (`reportV3Digest`). */
  digest: string | null;
  /** Raw UTF-8 serialized JSON SHA-256 digest (matches `manifest.json` entry `sha256`). */
  rawDigest: string | null;
  redactionIdempotent: boolean;
  expectedSha256: string | null;
  digestMatched: boolean | null;
  manifestMatched: boolean | null;
  verificationScope: string;
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
      let threshold = 35;
      if (rule.includes(">=")) {
        const rawThreshold = rule.slice(rule.indexOf(">=") + 2).trim();
        if (!/^\d+(?:\.\d+)?$/.test(rawThreshold)) {
          violations.push({
            rule,
            message: `Invalid numeric threshold in --fail-on rule: "${rawRule}".`
          });
          continue;
        }
        threshold = Number(rawThreshold);
      }
      if (s.darkPatternScore >= threshold) {
        violations.push({
          rule,
          message: `Consent banner dark-pattern score ${s.darkPatternScore} >= ${threshold}.`
        });
      }
    } else if (rule.startsWith("third-parties>")) {
      const rawLimit = rule.slice(rule.indexOf(">") + 1).trim();
      if (!/^\d+$/.test(rawLimit)) {
        violations.push({
          rule,
          message: `Invalid numeric limit in --fail-on rule: "${rawRule}".`
        });
        continue;
      }
      const limit = Number(rawLimit);
      if (s.thirdPartyDomains > limit) {
        violations.push({
          rule,
          message: `Third-party domains (${s.thirdPartyDomains}) exceeded ceiling (${limit}).`
        });
      }
    } else if (rule === "new-entities") {
      if (!diff) {
        violations.push({
          rule,
          kind: "insufficient-evidence",
          message: `--fail-on new-entities requires --diff <baseline.json> to compare against.`
        });
      } else if (diff.comparability.families.network.status !== "comparable") {
        violations.push({
          rule,
          kind: "insufficient-evidence",
          message: `Insufficient evidence to evaluate new-entities against baseline: ${diff.comparability.families.network.reasons.join(" ")}`
        });
      } else if (diff.entitiesAdded.length > 0) {
        violations.push({
          rule,
          kind: "policy-violation",
          message: `New tracking/service entities added relative to baseline: ${diff.entitiesAdded.join(", ")}.`
        });
      }
    } else if (rule === "regressions") {
      if (!diff) {
        violations.push({
          rule,
          kind: "insufficient-evidence",
          message: `--fail-on regressions requires --diff <baseline.json> to compare against.`
        });
      } else {
        if (diff.regressions.length > 0) {
          violations.push({
            rule,
            kind: "policy-violation",
            message: `${diff.regressions.length} privacy regression(s) detected relative to baseline.`
          });
        }
        if (diff.comparability.status !== "comparable") {
          const detail =
            diff.comparability.reasons.length > 0
              ? diff.comparability.reasons.join(" ")
              : diff.comparability.insufficientEvidence
                  .map((item) => `${item.family}: ${item.reason}`)
                  .join(" ");
          violations.push({
            rule,
            kind: "insufficient-evidence",
            message: `Baseline comparison unevaluable (${diff.comparability.status}): ${detail}`
          });
        }
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
  const keystrokeCell =
    report.leadArm.keystrokes.fieldsTyped === 0
      ? "n/t (0 fields)"
      : `${s.keystrokeLeaksCount} (${report.leadArm.keystrokes.fieldsTyped} ${report.leadArm.keystrokes.fieldsTyped === 1 ? "field" : "fields"})`;
  lines.push(`| Keystroke leaks / CNAME cloaks / Fingerprinting | ${keystrokeCell} / ${s.cnameCloaksCount} / ${s.fingerprintKindsCount} |`);

  const nonCompleteProbes = Object.entries(report.leadArm.probes)
    .filter(([, p]) => p.status !== "complete")
    .map(([name, p]) => `${name}: ${p.status}${p.reason ? ` (${p.reason})` : ""}`);
  if (nonCompleteProbes.length > 0) {
    lines.push("");
    lines.push(`- **Probe coverage notes:** ${nonCompleteProbes.join("; ")}`);
  }

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
  const compLabel =
    diff.comparability.status === "comparable"
      ? "comparable"
      : diff.comparability.status === "partial"
        ? `partial (${diff.comparability.insufficientEvidence.map((i) => i.family).join(", ")}: insufficient evidence)`
        : "insufficient evidence";
  lines.push(`- **Comparability:** ${compLabel}`);
  if (diff.comparability.notes.length > 0) {
    lines.push(`- **Context notes:** ${diff.comparability.notes.join(" ")}`);
  }
  lines.push("");
  lines.push("| Metric | Delta |");
  lines.push("| --- | ---: |");
  lines.push(`| Third-party domains | ${signed(diff.metrics.thirdPartyDomainsDelta)} |`);
  lines.push(`| Third-party requests | ${signed(diff.metrics.thirdPartyRequestsDelta)} |`);
  lines.push(`| Cookies | ${signed(diff.metrics.cookiesDelta)} |`);
  lines.push(`| CMP dark-pattern score | ${signed(diff.metrics.darkPatternScoreDelta)} |`);
  lines.push(`| Keystroke leaks | ${signed(diff.metrics.keystrokeLeaksDelta)} |`);
  lines.push(`| CNAME cloaks | ${signed(diff.metrics.cnameCloaksDelta)} |`);

  if (diff.comparability.reasons.length > 0) {
    lines.push("");
    lines.push("#### Insufficient Evidence");
    for (const reason of diff.comparability.reasons) {
      lines.push(`- ${reason}`);
    }
  } else if (diff.comparability.insufficientEvidence.length > 0) {
    lines.push("");
    lines.push("#### Insufficient Evidence");
    for (const item of diff.comparability.insufficientEvidence) {
      lines.push(`- **${item.family}:** ${item.reason}`);
    }
  }

  if (diff.regressions.length > 0) {
    lines.push("");
    lines.push("#### Regression Alerts");
    for (const r of diff.regressions) {
      lines.push(`- **[${r.severity.toUpperCase()}]** ${r.title} — ${r.detail}`);
    }
  } else if (diff.comparability.status === "comparable") {
    lines.push("");
    lines.push("No privacy regressions detected relative to baseline.");
  } else if (diff.comparability.status === "partial") {
    lines.push("");
    lines.push(
      "No privacy regressions detected across comparable probe families; unevaluable families are listed under Insufficient Evidence above."
    );
  } else {
    lines.push("");
    lines.push("Insufficient comparable evidence to evaluate privacy regressions relative to baseline.");
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

/**
 * Offline verification of a serialized `ScanReportV3` JSON document.
 *
 * Always checks schema validity, absence of unredacted secrets, redaction
 * fixed-point idempotency, and computes both canonical and raw-file SHA-256
 * digests. When `expectedSha256` or `manifestJson` is supplied, also verifies
 * exact digest/manifest agreement; publisher authenticity depends on how that
 * expected digest or manifest was obtained.
 */
export function verifyReportV3Json(
  rawJson: string,
  options: VerifyReportOptionsV3 = {}
): VerifyReportResultV3 {
  const issues: string[] = [];
  const rawDigest = sha256Hex(rawJson);
  const expectedNorm = options.expectedSha256 ? options.expectedSha256.trim().toLowerCase() : null;
  const hasExternalCheck = Boolean(expectedNorm || options.manifestJson);
  const verificationScope = hasExternalCheck
    ? "internal-consistency-and-digest-match (schema, redaction fixed-point, and caller-supplied digest/manifest checked; publisher authenticity depends on trust in the supplied digest or manifest)"
    : "internal-consistency-only (schema, redaction fixed-point, and canonical/raw SHA-256 computed; no external digest, manifest, or publisher signature checked)";

  let parsed: ScanReportV3;
  try {
    parsed = JSON.parse(rawJson) as ScanReportV3;
  } catch (err) {
    return {
      ok: false,
      reportId: null,
      canonicalDomain: null,
      digest: null,
      rawDigest,
      redactionIdempotent: false,
      expectedSha256: expectedNorm,
      digestMatched: expectedNorm ? false : null,
      manifestMatched: options.manifestJson ? false : null,
      verificationScope,
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
    const canonicalDigest = sha256Hex(canonicalJsonV3(parsed));
    const afterRedacted = redactScanReportV3(parsed);
    const afterDigest = sha256Hex(canonicalJsonV3(afterRedacted));
    redactionIdempotent = canonicalDigest === afterDigest;
    if (!redactionIdempotent) {
      issues.push("Report is not a redaction fixed point (re-redacting changes canonical SHA-256 digest).");
    }
    digest = canonicalDigest;
  }

  let digestMatched: boolean | null = null;
  if (expectedNorm !== null) {
    if (!/^[a-f0-9]{64}$/.test(expectedNorm)) {
      digestMatched = false;
      issues.push(`Invalid --expected-sha256 value (must be 64 lowercase hex characters).`);
    } else {
      digestMatched = expectedNorm === digest || expectedNorm === rawDigest;
      if (!digestMatched) {
        issues.push(
          `SHA-256 mismatch: expected ${expectedNorm}, got canonical ${digest ?? "n/a"} and raw ${rawDigest}.`
        );
      }
    }
  }

  let manifestMatched: boolean | null = null;
  if (options.manifestJson !== undefined && options.manifestJson !== null) {
    try {
      const manifest = JSON.parse(options.manifestJson) as {
        schemaVersion?: number;
        reports?: Array<{
          reportId?: string;
          canonicalDomain?: string;
          sha256?: string;
          bytes?: number;
          byteLength?: number;
        }>;
        entries?: Array<{
          reportId?: string;
          canonicalDomain?: string;
          sha256?: string;
          bytes?: number;
          byteLength?: number;
        }>;
      };
      const manifestRows = Array.isArray(manifest?.reports)
        ? manifest.reports
        : Array.isArray(manifest?.entries)
          ? manifest.entries
          : null;
      if (!manifestRows) {
        manifestMatched = false;
        issues.push("Manifest JSON does not contain a reports array.");
      } else {
        const entry = manifestRows.find((e) => e.reportId === parsed.reportId);
        if (!entry) {
          manifestMatched = false;
          issues.push(`Report ${parsed.reportId ?? "(missing id)"} was not found in the supplied manifest.`);
        } else {
          const entryHash = typeof entry.sha256 === "string" ? entry.sha256.trim().toLowerCase() : "";
          const byteLen = Buffer.byteLength(rawJson, "utf8");
          const expectedBytes =
            typeof entry.bytes === "number"
              ? entry.bytes
              : typeof entry.byteLength === "number"
                ? entry.byteLength
                : null;
          const hashOk = entryHash === rawDigest || entryHash === digest;
          const domainOk =
            typeof entry.canonicalDomain !== "string" ||
            entry.canonicalDomain.toLowerCase() === String(parsed.canonicalDomain ?? "").toLowerCase();
          const lenOk = expectedBytes === null || expectedBytes === byteLen;
          manifestMatched = hashOk && domainOk && lenOk;
          if (!hashOk) {
            issues.push(`Manifest SHA-256 mismatch for ${parsed.reportId}: manifest has ${entryHash || "(none)"}, file raw SHA-256 is ${rawDigest}.`);
          }
          if (!domainOk) {
            issues.push(`Manifest domain mismatch for ${parsed.reportId}: manifest has ${entry.canonicalDomain}, report has ${parsed.canonicalDomain}.`);
          }
          if (!lenOk) {
            issues.push(`Manifest byte size mismatch for ${parsed.reportId}: manifest has ${expectedBytes}, file is ${byteLen} bytes.`);
          }
        }
      }
    } catch (err) {
      manifestMatched = false;
      issues.push(`Invalid manifest JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: issues.length === 0,
    reportId: typeof parsed?.reportId === "string" ? parsed.reportId : null,
    canonicalDomain: typeof parsed?.canonicalDomain === "string" ? parsed.canonicalDomain : null,
    digest,
    rawDigest,
    redactionIdempotent,
    expectedSha256: expectedNorm,
    digestMatched,
    manifestMatched,
    verificationScope,
    issues
  };
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
