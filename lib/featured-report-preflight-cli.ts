import { appendFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { featuredReportPreflight } from "./featured-report-preflight";

/** Node-only GitHub Actions entry point; compiled through tsconfig.schema.json. */
async function main(): Promise<void> {
  const githubEnv = process.env.GITHUB_ENV?.trim();
  if (!githubEnv) throw new Error("GITHUB_ENV is required for the featured report preflight.");

  const checkoutCommit = git(["rev-parse", "HEAD"]);
  const worktreeClean = git(["status", "--porcelain", "--untracked-files=all"]) === "";
  const plan = featuredReportPreflight({
    mode: process.env.FEATURED_REPORT_MODE,
    eventName: process.env.GITHUB_EVENT_NAME,
    eventCommit: process.env.GITHUB_SHA,
    checkoutCommit,
    worktreeClean,
    compareGpc: process.env.FEATURED_COMPARE_GPC ?? process.env.SCAN_COMPARE_GPC,
    compareShields: process.env.FEATURED_COMPARE_SHIELDS ?? process.env.SCAN_COMPARE_SHIELDS,
    compareConsent: process.env.FEATURED_COMPARE_CONSENT ?? process.env.SCAN_COMPARE_CONSENT,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
    egressLabel: process.env.SITE_BEHAVIOR_LAB_SCANNER_EGRESS,
    egressRegion: process.env.SITE_BEHAVIOR_LAB_SCANNER_EGRESS_REGION,
    egressAttested: process.env.FEATURED_R2_EGRESS_ATTESTED,
    chromiumSandbox: process.env.SITE_BEHAVIOR_LAB_CHROMIUM_SANDBOX,
    controlledRunnerConfigured: (process.env.FEATURED_CONTROLLED_RUNNER_CONFIGURED ?? "").trim() !== ""
  });

  for (const warning of plan.warnings) {
    console.log(`::warning::${warning}`);
  }

  await appendFile(
    githubEnv,
    `${Object.entries(plan.environment).map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
    "utf8"
  );

  const stepSummary = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (stepSummary) {
    await appendFile(
      stepSummary,
      `## Committed report production gate\n\n${plan.summary.map((line) => `- ${line}`).join("\n")}\n`,
      "utf8"
    );
  }
  console.log(`Committed report preflight passed (${plan.mode}${plan.comparison ? " comparison" : " single"}).`);
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
