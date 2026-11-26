/**
 * Standalone Site Behavior Lab v3 CLI (`sbl`).
 *
 * Commands:
 *   sbl scan <url>     Run a live v3 concurrent CDP scan with optional baseline diff, SARIF/Markdown output, and CI `--fail-on` policy gates
 *   sbl diff <a> <b>   Compare two archived ScanReportV3 JSON files (temporal or staging-vs-prod)
 *   sbl verify <file>  Offline verification of schema, redaction fixed-point, and canonical SHA-256 digest
 *   sbl catalog [q]    Search the 150+ global entity catalog from the terminal
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCatalogDirectoryV3 } from "../dev-mode";
import { getV3RuntimeContext } from "../runtime/store-context";
import { diffScanReportsV3 } from "../runtime/watch-diff";
import { applyRegionalProfileV3, type ScanRegionIdV3 } from "../runtime/worker-dispatch";
import { closeSharedBrowserV3, SCANNER_V3_VERSION, scanSiteV3, type ScanRequestV3, type ScanSiteV3Deps } from "../scanner";
import {
  validateScanReportV3,
  type ComparisonAxisV3,
  type ScanDeviceV3,
  type ScanReportV3
} from "../schema";
import { saveReportV3 } from "../storage/blob-store";
import {
  evaluateFailOnRulesV3,
  formatDiffMarkdownV3,
  formatReportMarkdownV3,
  verifyReportV3Json
} from "./formatters";
import { diffToSarifV3, reportToSarifV3 } from "./sarif";

export type CliOutputFormatV3 = "json" | "markdown" | "sarif";

export type SblCliDeps = {
  scanImpl?: (req: ScanRequestV3, deps?: ScanSiteV3Deps) => Promise<ScanReportV3>;
  closeBrowserImpl?: () => Promise<void>;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
};

const VALID_COMPARISONS = new Set<ComparisonAxisV3>([
  "shields-standard",
  "shields-aggressive",
  "gpc",
  "consent-accept",
  "consent-reject"
]);

const VALID_REGIONS = new Set<ScanRegionIdV3>(["auto", "us-east", "eu-central", "ap-northeast"]);

export const SBL_CLI_HELP = `Site Behavior Lab CLI (${SCANNER_V3_VERSION})

Usage:
  sbl scan <url> [options]
  sbl diff <before.json> <after.json> [options]
  sbl summary <report.json>
  sbl verify <report.json> [--expected-sha256 <hex>] [--manifest <manifest.json>] [--json]
  sbl catalog [query] [--json]

Scan options:
  --device <desktop|mobile>         Browser device profile (default: desktop)
  --region <auto|us-east|eu-central|ap-northeast>  Regional locale/timezone profile
  --compare <axes>                  Comma-separated concurrent arms (shields-standard,shields-aggressive,gpc,consent-accept,consent-reject)
  --format <json|markdown|sarif>    Output format (default: markdown)
  --output <path>                   Write formatted output to a file
  --save-report <path>              Also write raw ScanReportV3 JSON to a file
  --diff <baseline.json>            Compare scan result against a baseline ScanReportV3 JSON file
  --fail-on <rules>                 Comma-separated CI policy gates (keystrokes,cname,sgtm,fingerprinting,beacon-pii,dark-patterns>=35,third-parties>20,new-entities,regressions)
  --fail-on-insufficient-evidence   Exit with code 3 when a --diff baseline comparison lacks comparable evidence
  --index                           Persist report into local v3 store & SQLite corpus index
  --allow-loopback                  Permit scanning localhost/127.0.0.1 staging servers

Diff options:
  --format <markdown|json|sarif>    Output format (default: markdown)
  --output <path>                   Write output to a file
  --fail-on-regression              Exit with code 2 on confirmed regression, or code 3 on insufficient comparable evidence

Exit codes:
  0  Pass (and baseline comparable when regression gate is enabled)
  1  Invocation or runtime error
  2  Policy gate or confirmed privacy regression failure
  3  Unevaluable baseline comparison (insufficient comparable evidence)
`;

export async function runSblCli(argv: readonly string[], deps: SblCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((s: string) => process.stdout.write(s));
  const err = deps.stderr ?? ((s: string) => process.stderr.write(s));

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    out(SBL_CLI_HELP);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    out(`${SCANNER_V3_VERSION}\n`);
    return 0;
  }

  const [command, ...rest] = argv;
  if (command === "scan") return handleScanCommand(rest, deps, out, err);
  if (command === "diff") return handleDiffCommand(rest, out, err);
  if (command === "summary") return handleSummaryCommand(rest, out, err);
  if (command === "verify") return handleVerifyCommand(rest, out, err);
  if (command === "catalog") return handleCatalogCommand(rest, out);

  err(`Unknown command: ${command}\n\n${SBL_CLI_HELP}`);
  return 1;
}

async function handleScanCommand(
  args: string[],
  deps: SblCliDeps,
  out: (s: string) => void,
  err: (s: string) => void
): Promise<number> {
  const url = args[0] && !args[0].startsWith("-") ? args[0] : "";
  if (!url) {
    err("Usage: sbl scan <url> [options]\n");
    return 1;
  }

  let device: ScanDeviceV3 = "desktop";
  let region: ScanRegionIdV3 = "auto";
  let format: CliOutputFormatV3 = "markdown";
  let outputPath: string | null = null;
  let saveReportPath: string | null = null;
  let diffBaselinePath: string | null = null;
  let indexLocally = false;
  let allowLoopback = false;
  let failOnInsufficientEvidence = false;
  const comparisons: ComparisonAxisV3[] = [];
  const failOnRules: string[] = [];

  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--device" && args[i + 1]) {
      const val = args[++i];
      if (val !== "desktop" && val !== "mobile") {
        err(`Invalid --device value: ${val} (expected desktop or mobile)\n`);
        return 1;
      }
      device = val;
    } else if (flag === "--region" && args[i + 1]) {
      const val = args[++i] as ScanRegionIdV3;
      if (!VALID_REGIONS.has(val)) {
        err(`Invalid --region value: ${val}\n`);
        return 1;
      }
      region = val;
    } else if (flag === "--compare" && args[i + 1]) {
      for (const piece of args[++i].split(",")) {
        const ax = piece.trim() as ComparisonAxisV3;
        if (!ax) continue;
        if (!VALID_COMPARISONS.has(ax)) {
          err(`Invalid --compare axis: ${ax}\n`);
          return 1;
        }
        if (!comparisons.includes(ax)) comparisons.push(ax);
      }
    } else if (flag === "--format" && args[i + 1]) {
      const val = args[++i];
      if (val !== "json" && val !== "markdown" && val !== "sarif") {
        err(`Invalid --format value: ${val} (expected json, markdown, or sarif)\n`);
        return 1;
      }
      format = val;
    } else if (flag === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (flag === "--save-report" && args[i + 1]) {
      saveReportPath = args[++i];
    } else if (flag === "--diff" && args[i + 1]) {
      diffBaselinePath = args[++i];
    } else if (flag === "--fail-on" && args[i + 1]) {
      for (const piece of args[++i].split(",")) {
        if (piece.trim()) failOnRules.push(piece.trim());
      }
    } else if (flag === "--fail-on-insufficient-evidence") {
      failOnInsufficientEvidence = true;
    } else if (flag === "--index") {
      indexLocally = true;
    } else if (flag === "--allow-loopback") {
      allowLoopback = true;
    } else {
      err(`Unknown option: ${flag}\n`);
      return 1;
    }
  }

  const req = applyRegionalProfileV3(
    {
      url,
      device,
      comparisons,
      acquisition: "cli"
    },
    region
  );

  const scanFn = deps.scanImpl ?? scanSiteV3;
  const closeFn = deps.closeBrowserImpl ?? closeSharedBrowserV3;

  try {
    const report = await scanFn(req, { allowLoopbackFixture: allowLoopback });

    if (saveReportPath) {
      await writeTextFile(saveReportPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    if (indexLocally) {
      const ctx = await getV3RuntimeContext();
      try {
        const r2Key = await saveReportV3(ctx.blobStore, report);
        await ctx.reportIndex.indexReport(report, { r2Key, visibility: "public" });
      } finally {
        ctx.close();
      }
    }

    let diff = null;
    if (diffBaselinePath) {
      const baseline = await loadReportJsonFile(diffBaselinePath);
      diff = diffScanReportsV3(baseline, report);
    }

    const rendered =
      format === "json"
        ? `${JSON.stringify(diff ? { report, diff } : report, null, 2)}\n`
        : format === "sarif"
          ? `${JSON.stringify(reportToSarifV3(report, diff), null, 2)}\n`
          : formatReportMarkdownV3(report, diff);

    if (outputPath) {
      await writeTextFile(outputPath, rendered);
    } else {
      out(rendered);
    }

    const violations = evaluateFailOnRulesV3(report, diff, failOnRules);
    if (
      failOnInsufficientEvidence &&
      diff &&
      diff.comparability.status !== "comparable" &&
      !violations.some((v) => v.kind === "insufficient-evidence")
    ) {
      const detail =
        diff.comparability.reasons.length > 0
          ? diff.comparability.reasons.join(" ")
          : diff.comparability.insufficientEvidence
              .map((item) => `${item.family}: ${item.reason}`)
              .join(" ");
      violations.push({
        rule: "comparability",
        kind: "insufficient-evidence",
        message: `Baseline comparison unevaluable (${diff.comparability.status}): ${detail}`
      });
    }
    if (violations.length > 0) {
      const hasConfirmedViolation = violations.some((v) => v.kind !== "insufficient-evidence");
      if (hasConfirmedViolation) {
        err(`\nPolicy gate failed (${violations.length} finding${violations.length === 1 ? "" : "s"}):\n`);
        for (const v of violations) {
          err(`  - [${v.rule}] ${v.message}\n`);
        }
        return 2;
      }
      err(`\nBaseline comparison unevaluable — insufficient evidence (${violations.length} notice${violations.length === 1 ? "" : "s"}):\n`);
      for (const v of violations) {
        err(`  - [${v.rule}] ${v.message}\n`);
      }
      return 3;
    }
    return 0;
  } catch (error) {
    err(`sbl scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await closeFn().catch(() => {});
  }
}

async function handleDiffCommand(
  args: string[],
  out: (s: string) => void,
  err: (s: string) => void
): Promise<number> {
  const beforePath = args[0] && !args[0].startsWith("-") ? args[0] : "";
  const afterPath = args[1] && !args[1].startsWith("-") ? args[1] : "";
  if (!beforePath || !afterPath) {
    err("Usage: sbl diff <before.json> <after.json> [--format markdown|json|sarif] [--output <file>] [--fail-on-regression]\n");
    return 1;
  }

  let format: CliOutputFormatV3 = "markdown";
  let outputPath: string | null = null;
  let failOnRegression = false;

  for (let i = 2; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--format" && args[i + 1]) {
      const val = args[++i];
      if (val === "json" || val === "markdown" || val === "sarif") format = val;
    } else if (flag === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (flag === "--fail-on-regression") {
      failOnRegression = true;
    } else {
      err(`Unknown option: ${flag}\n`);
      return 1;
    }
  }

  try {
    const [before, after] = await Promise.all([
      loadReportJsonFile(beforePath),
      loadReportJsonFile(afterPath)
    ]);
    const diff = diffScanReportsV3(before, after);
    const rendered =
      format === "json"
        ? `${JSON.stringify(diff, null, 2)}\n`
        : format === "sarif"
          ? `${JSON.stringify(diffToSarifV3(diff), null, 2)}\n`
          : formatDiffMarkdownV3(diff);

    if (outputPath) {
      await writeTextFile(outputPath, rendered);
    } else {
      out(rendered);
    }

    if (failOnRegression) {
      if (diff.regressions.length > 0) {
        err(`Detected ${diff.regressions.length} privacy regression(s).\n`);
        return 2;
      }
      if (diff.comparability.status !== "comparable") {
        const detail =
          diff.comparability.reasons.length > 0
            ? diff.comparability.reasons.join(" ")
            : diff.comparability.insufficientEvidence
                .map((item) => `${item.family}: ${item.reason}`)
                .join(" ");
        err(`Baseline comparison unevaluable — insufficient evidence (${diff.comparability.status}): ${detail}\n`);
        return 3;
      }
    }
    return 0;
  } catch (error) {
    err(`sbl diff failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function handleSummaryCommand(
  args: string[],
  out: (s: string) => void,
  err: (s: string) => void
): Promise<number> {
  const filePath = args[0] && !args[0].startsWith("-") ? args[0] : "";
  if (!filePath) {
    err("Usage: sbl summary <report.json>\n");
    return 1;
  }
  try {
    const report = await loadReportJsonFile(filePath);
    out(formatReportMarkdownV3(report));
    return 0;
  } catch (error) {
    err(`sbl summary failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function handleVerifyCommand(
  args: string[],
  out: (s: string) => void,
  err: (s: string) => void
): Promise<number> {
  const filePath = args[0] && !args[0].startsWith("-") ? args[0] : "";
  if (!filePath) {
    err("Usage: sbl verify <report.json> [--expected-sha256 <hex>] [--manifest <manifest.json>] [--json]\n");
    return 1;
  }
  let asJson = false;
  let expectedSha256: string | null = null;
  let manifestPath: string | null = null;
  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--json") {
      asJson = true;
    } else if (flag === "--expected-sha256" && args[i + 1]) {
      expectedSha256 = args[++i];
    } else if (flag === "--manifest" && args[i + 1]) {
      manifestPath = args[++i];
    } else {
      err(`Unknown verify option: ${flag}\n`);
      return 1;
    }
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const manifestJson = manifestPath ? await readFile(manifestPath, "utf8") : null;
    const result = verifyReportV3Json(raw, { expectedSha256, manifestJson });
    if (asJson) {
      out(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.ok) {
      const externalParts: string[] = [];
      if (result.digestMatched) externalParts.push("expected SHA-256 matched");
      if (result.manifestMatched) externalParts.push("manifest entry matched");
      const scopeSuffix =
        externalParts.length > 0
          ? externalParts.join(" + ")
          : "internal consistency only (no external digest or publisher signature checked)";
      out(
        `OK ${result.reportId} (${result.canonicalDomain}) · canonical SHA-256 ${result.digest} · raw SHA-256 ${result.rawDigest} · ${scopeSuffix}\n`
      );
    } else {
      err(`INVALID ${filePath}:\n${result.issues.map((x) => `  - ${x}`).join("\n")}\n`);
    }
    return result.ok ? 0 : 2;
  } catch (error) {
    err(`sbl verify failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function handleCatalogCommand(args: string[], out: (s: string) => void): number {
  const asJson = args.includes("--json");
  const query = args.find((a) => !a.startsWith("-"))?.toLowerCase() ?? "";
  const dir = getCatalogDirectoryV3();
  const matches = query
    ? dir.entries.filter(
        (e) =>
          e.entity.toLowerCase().includes(query) ||
          e.parentOrg.toLowerCase().includes(query) ||
          e.region.toLowerCase() === query ||
          e.domains.some((d) => d.includes(query))
      )
    : dir.entries;

  if (asJson) {
    out(`${JSON.stringify({ stats: dir.stats, total: matches.length, entries: matches }, null, 2)}\n`);
  } else {
    out(`Site Behavior Lab v3 Entity Catalog (${matches.length}/${dir.entries.length} entities):\n`);
    for (const e of matches.slice(0, 40)) {
      out(`  ${e.entity} [${e.parentOrg}] (${e.category}, ${e.region}) — ${e.domains.slice(0, 4).join(", ")}\n`);
    }
    if (matches.length > 40) {
      out(`  ... and ${matches.length - 40} more (pass --json to list all).\n`);
    }
  }
  return 0;
}

async function loadReportJsonFile(filePath: string): Promise<ScanReportV3> {
  const raw = await readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as ScanReportV3;
  const issues = validateScanReportV3(parsed);
  if (issues.length > 0) {
    throw new Error(`${filePath} is not a valid ScanReportV3: ${issues.join("; ")}`);
  }
  return parsed;
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
