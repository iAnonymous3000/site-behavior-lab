#!/usr/bin/env node

/**
 * Batch-scan the curated "Start here" sites from public/featured-sites.json to
 * populate the static gallery. Each site is scanned by spawning the existing,
 * battle-tested scripts/run-ci-scan.mjs (so this stays a thin, low-risk
 * orchestrator), then the static report manifest is rebuilt once at the end.
 *
 * Environment:
 *   BASE_URL                          Scanner origin (default http://127.0.0.1:3100), passed through to run-ci-scan.
 *   SITE_BEHAVIOR_LAB_SCAN_ACCESS_TOKEN  Forwarded to the scanner when set.
 *   FEATURED_SITES_FILE               Catalog to scan, relative to repo root (default public/featured-sites.json).
 *                                     Set to public/corpus-seed-sites.json to scan the corpus de-bias seed list.
 *   FEATURED_CATEGORIES               Comma-separated category ids to include (default: all).
 *   FEATURED_LIMIT                    Max number of sites to scan (default: all).
 *   FEATURED_COMPARE_SHIELDS          "true"/"false" Shields off/on comparison per site (default: false; takes precedence over consent and GPC).
 *   FEATURED_COMPARE_CONSENT          "true"/"false" consent accept/reject comparison per site (default: false; takes precedence over GPC).
 *   FEATURED_COMPARE_GPC              "true"/"false" GPC off/on comparison per site (default: true).
 *   FEATURED_DEVICE                   "desktop"/"mobile" (default: desktop).
 *   FEATURED_DELAY_MS                 Delay between sites in ms (default: 1500).
 *   FEATURED_MIN_SUCCESS_RATE         Minimum fraction of sites that must scan
 *                                     successfully for the run to succeed
 *                                     (default: 0.9). Below it the run exits
 *                                     nonzero so a partial refresh is never
 *                                     silently published as a green run.
 */

import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sitesFileEnv = process.env.FEATURED_SITES_FILE?.trim();
const configPath = sitesFileEnv ? path.resolve(rootDir, sitesFileEnv) : path.join(rootDir, "public", "featured-sites.json");
const ciScanScript = path.join(rootDir, "scripts", "run-ci-scan.mjs");
const manifestScript = path.join(rootDir, "scripts", "build-static-report-manifest.mjs");

async function main() {
  const config = await readConfig();
  const sites = selectSites(config);

  if (sites.length === 0) {
    console.error("No featured sites matched the requested filters.");
    process.exit(1);
  }

  const compareShields = booleanEnv("FEATURED_COMPARE_SHIELDS", false);
  const compareConsent = !compareShields && booleanEnv("FEATURED_COMPARE_CONSENT", false);
  const compareGpc = !compareShields && !compareConsent && booleanEnv("FEATURED_COMPARE_GPC", true);
  const device = process.env.FEATURED_DEVICE === "mobile" ? "mobile" : "desktop";
  const delayMs = positiveIntEnv("FEATURED_DELAY_MS", 1500);

  console.log(
    `Scanning ${sites.length} featured site${sites.length === 1 ? "" : "s"} (compareShields=${compareShields}, compareConsent=${compareConsent}, compareGpc=${compareGpc}, device=${device}).`
  );

  // Build the dist/schema production artifact ONCE for the whole run (RFC
  // 10.3: one build step in CI); every child publisher/manifest invocation
  // skips its own compile via the env flag below. An orchestrating workflow
  // that already built the artifact (and set the flag) skips it here too.
  if (process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY !== "1") {
    console.log("Building the dist/schema production artifact once for this run...");
    await run(process.execPath, [path.join(rootDir, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.schema.json"], {});
    process.env.SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY = "1";
  }

  let succeeded = 0;
  const failures = [];

  for (const [index, site] of sites.entries()) {
    console.log(`\n[${index + 1}/${sites.length}] ${site.domain}`);
    try {
      await runOneScan(site, { compareGpc, compareShields, compareConsent, device });
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed: ${message}`);
      failures.push({ site: site.domain, message });
    }

    if (index < sites.length - 1 && delayMs > 0) {
      await delay(delayMs);
    }
  }

  const minSuccessRate = successRateEnv("FEATURED_MIN_SUCCESS_RATE", 0.9);
  const successRate = succeeded / sites.length;
  await publishRunDiagnostics({ sites, succeeded, failures, minSuccessRate, successRate });

  console.log("\nVerifying report redaction and provenance...");
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "reports:remediate", "--", "--check"], {
    SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY: "1"
  });

  console.log("\nRebuilding static report manifest...");
  await run(process.execPath, [manifestScript], {});

  console.log(`\nFeatured scan complete: ${succeeded} succeeded, ${failures.length} failed.`);
  for (const failure of failures) {
    console.log(`  - ${failure.site}: ${failure.message}`);
  }

  // A green run must mean a meaningful refresh. Individual bot walls and
  // outages are tolerated up to the threshold; beyond it the run fails so the
  // workflow never commits and publishes a mostly-stale corpus as fresh.
  if (succeeded === 0 || successRate < minSuccessRate) {
    console.error(
      `Refusing to treat this as a successful refresh: ${succeeded}/${sites.length} sites succeeded (${Math.round(
        successRate * 100
      )}%), below the ${Math.round(minSuccessRate * 100)}% threshold (FEATURED_MIN_SUCCESS_RATE).`
    );
    process.exit(1);
  }
}

async function publishRunDiagnostics({ sites, succeeded, failures, minSuccessRate, successRate }) {
  const summary = {
    generatedAt: new Date().toISOString(),
    total: sites.length,
    succeeded,
    failed: failures.length,
    successRate,
    requiredSuccessRate: minSuccessRate,
    failures
  };
  const outputPath = process.env.FEATURED_SUMMARY_PATH?.trim();
  if (outputPath) {
    await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  const githubSummary = process.env.GITHUB_STEP_SUMMARY?.trim();
  if (!githubSummary) return;
  const lines = [
    "## Featured scan result",
    "",
    `- Succeeded: **${succeeded}/${sites.length}** (${Math.round(successRate * 100)}%)`,
    `- Required success rate: **${Math.round(minSuccessRate * 100)}%**`,
    `- Failed: **${failures.length}**`
  ];
  if (failures.length > 0) {
    lines.push("", "### Failed targets", "");
    for (const failure of failures) lines.push(`- **${failure.site}:** ${failure.message}`);
  }
  await appendFile(githubSummary, `${lines.join("\n")}\n`, "utf8");
}

function successRateEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1, got "${raw}".`);
  }
  return value;
}

async function readConfig() {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read the configured featured-sites catalog: ${error instanceof Error ? error.message : error}`);
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sites)) {
    throw new Error("featured-sites.json is missing a sites array.");
  }
  return parsed;
}

function selectSites(config) {
  const categoryFilter = (process.env.FEATURED_CATEGORIES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  let sites = config.sites.filter(
    (site) => site && typeof site.url === "string" && typeof site.domain === "string" && typeof site.category === "string"
  );

  if (categoryFilter.length > 0) {
    sites = sites.filter((site) => categoryFilter.includes(site.category.toLowerCase()));
  }

  const limit = positiveIntEnv("FEATURED_LIMIT", 0);
  if (limit > 0) {
    sites = sites.slice(0, limit);
  }

  return sites.map((site) => ({ ...site, label: site.label || site.domain }));
}

function runOneScan(site, { compareGpc, compareShields, compareConsent, device }) {
  return run(process.execPath, [ciScanScript], {
    SCAN_URL: site.url,
    SCAN_DEVICE: device,
    // Only one comparison mode per scan; Shields (the tried-vs-blocked moat) wins,
    // then the consent accept/reject diff, then GPC (main() already resolves the
    // precedence, so these flags are mutually exclusive here).
    SCAN_COMPARE_SHIELDS: compareShields ? "true" : "false",
    SCAN_COMPARE_CONSENT: compareConsent ? "true" : "false",
    SCAN_COMPARE_GPC: compareGpc ? "true" : "false",
    SCAN_GPC_ENABLED: "true",
    // Avoid each child appending duplicate keys to a shared GITHUB_OUTPUT file.
    GITHUB_OUTPUT: ""
  });
}

function run(command, args, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      env: { ...process.env, ...extraEnv }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0] ?? command)} exited with status ${code}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function booleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
