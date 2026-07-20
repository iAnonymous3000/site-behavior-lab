import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const URL_PATTERN = /https?:\/\/\S+/gi;
const MAX_DIAGNOSTIC_LENGTH = 500;
const FEATURED_REFRESH_MARKER = "<!-- site-behavior-lab:featured-corpus-refresh -->";

/**
 * Preserve the child scanner's final public-safe error without copying an
 * unbounded stderr stream into the workflow summary or diagnostics artifact.
 * URLs are redacted defensively: scan targets must never leak through a future
 * child error message even though the current CI scanner already avoids them.
 */
export function failureDiagnosticFromStderr(stderr) {
  if (typeof stderr !== "string" || stderr.trim() === "") return null;

  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_ESCAPE_PATTERN, "").replace(CONTROL_CHARACTER_PATTERN, " ").trim())
    .filter(Boolean);
  const finalLine = lines.at(-1);
  if (!finalLine) return null;

  const redacted = finalLine.replace(URL_PATTERN, "[redacted URL]");
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH - 3)}...`;
}

function boundedCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function boundedRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * Extract only aggregate, public-safe fields from the detailed diagnostics
 * artifact. Per-target names and child failure reasons stay in the artifact;
 * they are deliberately never copied into the public tracking issue.
 */
export function publicFeaturedScanSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const total = boundedCount(value.total);
  const succeeded = boundedCount(value.succeeded, total ?? -1);
  const failed = boundedCount(value.failed, total ?? -1);
  const successRate = boundedRate(value.successRate);
  const requiredSuccessRate = boundedRate(value.requiredSuccessRate);
  if (
    total === null ||
    total === 0 ||
    succeeded === null ||
    failed === null ||
    succeeded + failed !== total ||
    successRate === null ||
    requiredSuccessRate === null ||
    Math.abs(successRate - succeeded / total) > 1e-12
  ) {
    return null;
  }
  return { total, succeeded, failed, successRate, requiredSuccessRate };
}

function inlineCode(value, fallback) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._/-]{1,200}$/.test(normalized) ? normalized : fallback;
}

function workflowRunUrl({ serverUrl, repository, runId }) {
  const server = typeof serverUrl === "string" && /^https:\/\/github\.com\/?$/.test(serverUrl.trim())
    ? serverUrl.trim().replace(/\/$/, "")
    : "https://github.com";
  const repo = typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.trim())
    ? repository.trim()
    : null;
  const id = typeof runId === "string" && /^\d+$/.test(runId.trim()) ? runId.trim() : null;
  return repo && id ? `${server}/${repo}/actions/runs/${id}` : null;
}

export function buildFeaturedRefreshIssueReport({ failed, summary, branch, serverUrl, repository, runId }) {
  const aggregate = publicFeaturedScanSummary(summary);
  const runUrl = workflowRunUrl({ serverUrl, repository, runId });
  const safeBranch = inlineCode(branch, "default branch");
  const lines = [
    FEATURED_REFRESH_MARKER,
    "",
    "# Featured corpus refresh status",
    "",
    failed
      ? "The authoritative featured-corpus refresh did not complete successfully."
      : "The authoritative featured-corpus refresh completed successfully.",
    "",
    `- Branch: \`${safeBranch}\``
  ];
  if (runUrl) lines.push(`- Workflow run: [view run](${runUrl})`);
  if (aggregate) {
    lines.push(
      `- Sites succeeded: **${aggregate.succeeded}/${aggregate.total}** (${Math.round(aggregate.successRate * 100)}%)`,
      `- Required success rate: **${Math.round(aggregate.requiredSuccessRate * 100)}%**`,
      `- Failed targets: **${aggregate.failed}**`
    );
  } else {
    lines.push("- Aggregate scan summary: **unavailable or invalid**");
  }
  lines.push("");
  lines.push(
    failed
      ? "Per-target names and failure reasons are intentionally omitted from this public issue. " +
          "Repository maintainers can inspect the bounded failed-run diagnostics artifact on the workflow run."
      : "Per-target diagnostic details are intentionally omitted from this public issue."
  );
  return `${lines.join("\n")}\n`;
}

export function isAuthoritativeFeaturedRefresh(environment) {
  const sitesFile = environment.FEATURED_SITES_FILE?.trim() ?? "";
  return (
    environment.GITHUB_REF_TYPE === "branch" &&
    environment.GITHUB_REF_NAME === environment.FEATURED_DEFAULT_BRANCH &&
    (sitesFile === "" || sitesFile === "public/featured-sites.json") &&
    (environment.FEATURED_CATEGORIES?.trim() ?? "") === "" &&
    (environment.FEATURED_LIMIT?.trim() ?? "") === "" &&
    environment.FEATURED_COMPARE_SHIELDS === "true" &&
    environment.FEATURED_COMPARE_CONSENT === "false" &&
    environment.FEATURED_COMPARE_GPC === "false" &&
    environment.FEATURED_DEVICE === "desktop"
  );
}

async function prepareAlertFromEnvironment() {
  const summaryPath = process.env.FEATURED_SUMMARY_PATH?.trim();
  const reportPath = process.env.FEATURED_ALERT_REPORT_PATH?.trim();
  if (!reportPath) throw new Error("FEATURED_ALERT_REPORT_PATH is required.");

  let summary = null;
  if (summaryPath) {
    try {
      summary = JSON.parse(await readFile(summaryPath, "utf8"));
    } catch {
      // Missing or malformed diagnostics are represented explicitly in the
      // safe issue report instead of copying parser or filesystem details.
    }
  }
  const aggregate = publicFeaturedScanSummary(summary);
  const failed =
    process.env.FEATURED_SCAN_OUTCOME !== "success" ||
    process.env.FEATURED_JOB_STATUS !== "success" ||
    aggregate === null;
  const authoritative = isAuthoritativeFeaturedRefresh(process.env);
  const report = buildFeaturedRefreshIssueReport({
    failed,
    summary: aggregate,
    branch: process.env.GITHUB_REF_NAME,
    serverUrl: process.env.GITHUB_SERVER_URL,
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID
  });
  await writeFile(reportPath, report, "utf8");

  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (outputPath) {
    await appendFile(outputPath, `failed=${failed}\nauthoritative=${authoritative}\n`, "utf8");
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--prepare-alert") {
    console.error("Usage: run-featured-scans-diagnostics.mjs --prepare-alert");
    process.exitCode = 1;
  } else {
    prepareAlertFromEnvironment().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
