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
 *   FEATURED_TRANSIENT_RETRIES        Extra attempts for explicitly transient failures (default: 1, max: 2).
 *   FEATURED_TRANSIENT_RETRY_DELAY_MS Delay before the first transient retry (default: 5000).
 *   FEATURED_INCLUDE_UNAVAILABLE      Include versioned temporarily-unavailable catalog entries for manual review (default: false).
 *   FEATURED_MIN_SUCCESS_RATE         Minimum fraction of sites that must scan
 *                                     successfully for the run to succeed
 *                                     (default: 0.9, hard floor: 0.8). Below it the run exits
 *                                     nonzero, even though independently
 *                                     validated successes can still publish.
 *
 * CLI:
 *   --plan                            Print the selected domains, conditions,
 *                                     and bounded attempt/page-visit budget as
 *                                     JSON without building or scanning.
 *
 * A full featured-catalog run also has fixed, non-overridable eligibility
 * gates: at least 80% of the whole catalog and at least 50 sites must remain
 * active. Temporarily unavailable entries stay in that denominator.
 */

import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFeaturedFailures,
  failureDiagnosticFromStderr,
  featuredCatalogEligibility,
  featuredCatalogVersion,
  featuredMinimumSuccessRate,
  featuredScanRetryReason,
  featuredSiteUnavailability,
  featuredTransientRetryLimit,
  isFullFeaturedCatalogSelection,
  summarizeFailureTaxonomy
} from "./run-featured-scans-diagnostics.mjs";

// The classifier lives with the canonical-issue builder that also needs it, so
// the console taxonomy and the issue taxonomy cannot describe the same run
// differently. Re-exported because this module is its established import site.
export { classifyFeaturedFailures };
import { FEATURED_READJUDICATION_REASONS } from "./featured-readjudication-lib.mjs";
import { measurementFreezeRetentionPolicy } from "./measurement-freeze-retention-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sitesFileEnv = process.env.FEATURED_SITES_FILE?.trim();
const configPath = sitesFileEnv ? path.resolve(rootDir, sitesFileEnv) : path.join(rootDir, "public", "featured-sites.json");
const ciScanScript = path.join(rootDir, "scripts", "run-ci-scan.mjs");
const manifestScript = path.join(rootDir, "scripts", "build-static-report-manifest.mjs");

class ClassifiedFeaturedUnavailableError extends Error {
  constructor(message, unavailableReason) {
    super(message);
    this.name = "ClassifiedFeaturedUnavailableError";
    this.unavailableReason = unavailableReason;
  }
}

async function main(args = process.argv.slice(2)) {
  // Resolve before reading a catalog, building, or spawning a scan. A typo in
  // the freeze variable must fail closed rather than silently selecting the
  // ordinary deletion policy in the later trusted publisher.
  const retentionPolicy = measurementFreezeRetentionPolicy(process.env);
  const planOnly = parseArguments(args);
  const config = await readConfig();
  const { sites, unavailable, catalogTotal, catalogVersion, fullCatalog, eligibility } = selectSites(config);

  if (sites.length === 0) {
    console.error("No featured sites matched the requested filters.");
    process.exit(1);
  }

  const compareShields = booleanEnv("FEATURED_COMPARE_SHIELDS", false);
  const compareConsent = !compareShields && booleanEnv("FEATURED_COMPARE_CONSENT", false);
  const compareGpc = !compareShields && !compareConsent && booleanEnv("FEATURED_COMPARE_GPC", true);
  const device = process.env.FEATURED_DEVICE === "mobile" ? "mobile" : "desktop";
  const delayMs = positiveIntEnv("FEATURED_DELAY_MS", 1500);
  const transientRetries = featuredTransientRetryLimit(process.env.FEATURED_TRANSIENT_RETRIES);
  const transientRetryDelayMs = positiveIntEnv("FEATURED_TRANSIENT_RETRY_DELAY_MS", 5000);
  const minSuccessRate = featuredMinimumSuccessRate(process.env.FEATURED_MIN_SUCCESS_RATE, 0.9, 0.8);

  if (planOnly) {
    console.log(
      JSON.stringify(
        featuredRunPlan({
          sites,
          unavailable,
          catalogTotal,
          catalogVersion,
          fullCatalog,
          eligibility,
          compareShields,
          compareConsent,
          compareGpc,
          device,
          delayMs,
          transientRetries,
          transientRetryDelayMs,
          minSuccessRate,
          retentionPolicy
        }),
        null,
        2
      )
    );
    return;
  }

  if (retentionPolicy.measurementFreeze) {
    console.log(
      "Measurement freeze active: collection may append candidate-bound r2 evidence, but governed report pruning is forbidden."
    );
  }
  console.log(
    `Scanning ${sites.length} eligible featured site${sites.length === 1 ? "" : "s"} (compareShields=${compareShields}, compareConsent=${compareConsent}, compareGpc=${compareGpc}, device=${device}, transientRetries=${transientRetries}).`
  );
  if (unavailable.length > 0) {
    console.log(
      `Deferring ${unavailable.length} versioned temporarily-unavailable catalog entr${unavailable.length === 1 ? "y" : "ies"}; each remains public with a mandatory review date.`
    );
  }

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
  let retried = 0;
  const failures = [];
  const scanResults = [];

  for (const [index, site] of sites.entries()) {
    console.log(`\n[${index + 1}/${sites.length}] ${site.domain}`);
    try {
      const result = await runOneScanWithRetry(
        site,
        { compareGpc, compareShields, compareConsent, device },
        { transientRetries, transientRetryDelayMs }
      );
      if (result.attempts > 1) retried += 1;
      succeeded += 1;
      scanResults.push({
        domain: site.domain,
        status: "available",
        reportId: result.reportId,
        attemptCount: result.attempts
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed: ${message}`);
      failures.push({ site: site.domain, message });
      scanResults.push(
        error instanceof ClassifiedFeaturedUnavailableError
          ? {
              domain: site.domain,
              status: "unavailable",
              reason: error.unavailableReason
            }
          : { domain: site.domain, status: "not-attempted" }
      );
    }

    if (index < sites.length - 1 && delayMs > 0) {
      await delay(delayMs);
    }
  }

  const successRate = succeeded / sites.length;
  await publishRunDiagnostics({
    sites,
    unavailable,
    catalogTotal,
    catalogVersion,
    fullCatalog,
    eligibility,
    succeeded,
    failures,
    scanResults,
    retried,
    minSuccessRate,
    successRate
  });

  console.log("\nVerifying report redaction and provenance...");
  await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "reports:remediate", "--", "--check"], {
    SITE_BEHAVIOR_LAB_SCHEMA_DIST_READY: "1"
  });

  console.log("\nRebuilding static report manifest...");
  await run(process.execPath, [manifestScript], {});

  console.log(`\nFeatured scan complete: ${succeeded} succeeded, ${failures.length} failed.`);
  if (retried > 0) console.log(`  ${retried} site${retried === 1 ? "" : "s"} succeeded after a bounded transient retry.`);
  for (const failure of failures) {
    console.log(`  - ${failure.site}: ${failure.message}`);
  }

  // Say WHY, not just how many. A bare rate cannot distinguish "the scanner
  // broke" from "these sites refuse an honest automated browser", and those
  // need opposite responses: one is a defect to fix, the other is a property of
  // the web that no amount of fixing changes short of disguising the scanner,
  // which this project refuses to do. Reading the rate alone, every operator
  // sees a number below a threshold and starts debugging code.
  const taxonomy = classifyFeaturedFailures(failures);
  if (failures.length > 0) {
    console.log("\nFailure taxonomy:");
    for (const [kind, group] of taxonomy) {
      console.log(`  ${kind.padEnd(22)} ${String(group.length).padStart(3)}  ${group.map((f) => f.site).join(", ")}`);
    }
    const refused = (taxonomy.get("target-refused") ?? []).length;
    const ours = failures.length - refused;
    console.log(
      `\n  ${refused} of ${failures.length} failures are sites refusing automation, which is an honest result rather than a scanner defect.`
    );
    console.log(`  ${ours} ${ours === 1 ? "is" : "are"} attributable to this scanner and ${ours === 1 ? "is" : "are"} worth investigating.`);
  }

  // A green run must mean a meaningful refresh. Individual bot walls and
  // outages are tolerated up to the threshold; beyond it the run stays red
  // and its canonical issue stays open. The workflow may still revalidate and
  // publish the successful reports without treating failed targets as fresh.
  if (succeeded === 0 || successRate < minSuccessRate) {
    console.error(
      `Refusing to treat this as a successful refresh: ${succeeded}/${sites.length} sites succeeded (${Math.round(
        successRate * 100
      )}%), below the ${Math.round(minSuccessRate * 100)}% threshold (FEATURED_MIN_SUCCESS_RATE).`
    );
    process.exit(1);
  }
}

export function featuredRunPlan({
  sites,
  unavailable,
  catalogTotal,
  catalogVersion,
  fullCatalog,
  eligibility,
  compareShields,
  compareConsent,
  compareGpc,
  device,
  delayMs,
  transientRetries,
  transientRetryDelayMs,
  minSuccessRate,
  retentionPolicy = measurementFreezeRetentionPolicy({})
}) {
  const comparisonMode = compareShields ? "shields" : compareConsent ? "consent" : compareGpc ? "gpc" : "single";
  const pageVisitsPerAttempt = comparisonMode === "single" ? 1 : 2;
  const attemptsPerTarget = transientRetries + 1;
  return {
    planVersion: 1,
    kind: "site-behavior-featured-scan-plan",
    mutatesReports: false,
    catalog: {
      version: catalogVersion,
      fullCatalog,
      selected: sites.length,
      deferred: unavailable.length,
      total: catalogTotal,
      coverage: eligibility.catalogCoverage
    },
    conditions: {
      comparisonMode,
      device
    },
    budget: {
      attemptsPerTarget,
      pageVisitsPerAttempt,
      maximumSubmittedScans: sites.length * attemptsPerTarget,
      maximumPageVisits: sites.length * attemptsPerTarget * pageVisitsPerAttempt,
      delayBetweenTargetsMs: delayMs,
      initialTransientRetryDelayMs: transientRetryDelayMs
    },
    acceptance: {
      minimumSuccessRate: minSuccessRate,
      requiredSuccesses: Math.ceil(sites.length * minSuccessRate)
    },
    retention: {
      measurementFreeze: retentionPolicy.measurementFreeze,
      pruningAllowed: retentionPolicy.pruningAllowed,
      mode: retentionPolicy.mode
    },
    targets: sites.map((site) => ({ domain: site.domain, category: site.category })),
    deferred: unavailable
  };
}

function parseArguments(args) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--plan") return true;
  throw new Error("Usage: node scripts/run-featured-scans.mjs [--plan]");
}

async function publishRunDiagnostics({
  sites,
  unavailable,
  catalogTotal,
  catalogVersion,
  fullCatalog,
  eligibility,
  succeeded,
  failures,
  scanResults,
  retried,
  minSuccessRate,
  successRate
}) {
  const summary = {
    generatedAt: new Date().toISOString(),
    catalogVersion,
    fullCatalog,
    catalogTotal,
    unavailable: unavailable.length,
    unavailableSites: unavailable,
    total: sites.length,
    succeeded,
    failed: failures.length,
    retried,
    successRate,
    requiredSuccessRate: minSuccessRate,
    catalogCoverage: eligibility.catalogCoverage,
    requiredCatalogCoverage: eligibility.requiredCatalogCoverage,
    minimumEligibleSites: eligibility.minimumEligibleSites,
    // Counts by kind, carried alongside the rate. The alerting job never sees
    // `failures` itself, so this is the only way the canonical issue can say
    // which kind of red a run is instead of publishing a bare rate.
    failureTaxonomy: summarizeFailureTaxonomy(failures),
    scanResults,
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
    `- Eligible scan success: **${succeeded}/${sites.length}** (${Math.round(successRate * 100)}%)`,
    `- Required eligible success rate: **${Math.round(minSuccessRate * 100)}%**`,
    `- Failed eligible targets: **${failures.length}**`,
    `- Active eligible catalog coverage: **${sites.length}/${catalogTotal}** (${Math.round(eligibility.catalogCoverage * 100)}%)`,
    `- Fixed full-catalog coverage gate: **${Math.round(eligibility.requiredCatalogCoverage * 100)}% and at least ${eligibility.minimumEligibleSites} active sites**`,
    `- Catalog entries temporarily unavailable: **${unavailable.length}/${catalogTotal}**`,
    "- Scope note: passing these gates does not mean every catalog entry was freshly scanned.",
    `- Sites recovered by bounded retry: **${retried}**`
  ];
  if (unavailable.length > 0) {
    lines.push("", "### Temporarily unavailable catalog entries", "");
    for (const entry of unavailable) {
      lines.push(
        `- **${entry.site}:** ${entry.reason}; observed ${entry.observedAt}; mandatory review by ${entry.reviewAfter}`
      );
    }
  }
  if (failures.length > 0) {
    lines.push("", "### Failed targets", "");
    for (const failure of failures) lines.push(`- **${failure.site}:** ${failure.message}`);
  }
  await appendFile(githubSummary, `${lines.join("\n")}\n`, "utf8");
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

export function selectSites(config, environment = process.env, today = new Date().toISOString().slice(0, 10)) {
  const categoryFilter = (environment.FEATURED_CATEGORIES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const validSite = (site) =>
    site && typeof site.url === "string" && typeof site.domain === "string" && typeof site.category === "string";
  const fullCatalog = isFullFeaturedCatalogSelection(environment);
  if (fullCatalog && !config.sites.every(validSite)) {
    throw new Error("The full featured catalog contains an invalid site entry.");
  }
  let candidates = config.sites.filter(validSite);

  if (categoryFilter.length > 0) {
    candidates = candidates.filter((site) => categoryFilter.includes(site.category.toLowerCase()));
  }

  const limit = positiveIntEnv("FEATURED_LIMIT", 0, environment);
  if (limit > 0) {
    candidates = candidates.slice(0, limit);
  }

  const includeUnavailable = booleanEnv("FEATURED_INCLUDE_UNAVAILABLE", false, environment);
  const hasAvailabilityMetadata = config.sites.some((site) => site?.scanAvailability !== undefined);
  const catalogVersion =
    hasAvailabilityMetadata || fullCatalog
      ? featuredCatalogVersion(config.version)
      : Number.isSafeInteger(config.version)
        ? config.version
        : null;
  const sites = [];
  const unavailable = [];
  for (const site of candidates) {
    const availability = featuredSiteUnavailability(site, today);
    if (availability && !includeUnavailable) {
      unavailable.push({ site: site.domain, ...availability });
      continue;
    }
    sites.push({ ...site, label: site.label || site.domain });
  }
  const catalogTotal = candidates.length;
  const eligibility = featuredCatalogEligibility(catalogTotal, sites.length, fullCatalog);
  return { sites, unavailable, catalogTotal, catalogVersion, fullCatalog, eligibility };
}

async function runOneScanWithRetry(site, scanOptions, { transientRetries, transientRetryDelayMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reportId = await runOneScan(site, scanOptions);
      return { attempts: attempt + 1, reportId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = featuredScanRetryReason(message);
      if (!reason || attempt >= transientRetries) throw error;
      const retryNumber = attempt + 1;
      const waitMs = Math.min(transientRetryDelayMs * 2 ** (retryNumber - 1), 30_000);
      console.warn(`  Transient ${reason}; retry ${retryNumber}/${transientRetries} in ${waitMs}ms.`);
      await delay(waitMs);
    }
  }
}

async function runOneScan(site, { compareGpc, compareShields, compareConsent, device }) {
  const resultDir = await mkdtemp(path.join(tmpdir(), "sbl-featured-result-"));
  const resultPath = path.join(resultDir, "scan-result.json");
  try {
    let childError = null;
    try {
      await run(
        process.execPath,
        [ciScanScript],
        {
          SCAN_URL: site.url,
          SCAN_DEVICE: device,
          // Only one comparison mode per scan; Shields (the tried-vs-blocked moat) wins,
          // then the consent accept/reject diff, then GPC (main() already resolves the
          // precedence, so these flags are mutually exclusive here).
          SCAN_COMPARE_SHIELDS: compareShields ? "true" : "false",
          SCAN_COMPARE_CONSENT: compareConsent ? "true" : "false",
          SCAN_COMPARE_GPC: compareGpc ? "true" : "false",
          // Send GPC only when GPC is the measured axis. Held ON for every scan,
          // it made the Shields lane claim a signal it was not testing, and the
          // GPC worker injector blocks any non-http(s) Worker because it cannot
          // add the signal to a blob: realm without changing that realm's origin.
          // Blob workers are ordinary on modern sites, so the block censored the
          // request family and pushed the site out of the corpus aggregate: 80 of
          // 451 committed reports carry that capture loss and every one of them is
          // a Shields comparison. A Shields visit with gpcEnabled false is also the
          // more representative baseline, since most visitors send no GPC header.
          SCAN_GPC_ENABLED: compareGpc ? "true" : "false",
          // Each child publisher still deep-validates the exact new report and
          // provenance sidecar. Defer the O(corpus) remediation pass to this
          // trusted parent, which runs it once after every child has exited.
          CI_SCAN_DEFER_CORPUS_CHECK: "1",
          // Avoid each child appending duplicate keys to a shared GITHUB_OUTPUT file.
          GITHUB_OUTPUT: "",
          // This file is created only after the child has published and validated
          // the exact report/sidecar pair. It is the parent's narrow report-id
          // handoff and never contains target diagnostics.
          CI_SCAN_RESULT_PATH: resultPath
        },
        { captureFailureDiagnostic: true }
      );
    } catch (error) {
      childError = error;
    }
    let value = null;
    try {
      const text = await readFile(resultPath, "utf8");
      value = JSON.parse(text);
      if (text !== `${JSON.stringify(value)}\n`) {
        throw new Error("scan-result handoff is not canonical JSON");
      }
    } catch (error) {
      if (childError) throw childError;
      throw error;
    }
    if (childError) {
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) ===
          JSON.stringify(["reason", "schemaVersion", "status"]) &&
        value.schemaVersion === 1 &&
        value.status === "unavailable" &&
        FEATURED_READJUDICATION_REASONS.includes(value.reason)
      ) {
        throw new ClassifiedFeaturedUnavailableError(
          childError instanceof Error ? childError.message : String(childError),
          value.reason
        );
      }
      throw childError;
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(["reportId", "schemaVersion", "status"]) ||
      value.schemaVersion !== 1 ||
      value.status !== "available" ||
      typeof value.reportId !== "string" ||
      !/^[0-9]{8}-[0-9a-f]{32}$/.test(value.reportId)
    ) {
      throw new Error("run-ci-scan returned a malformed report-id handoff");
    }
    return value.reportId;
  } finally {
    await rm(resultDir, { recursive: true, force: true });
  }
}

function run(command, args, extraEnv, { captureFailureDiagnostic = false } = {}) {
  return new Promise((resolve, reject) => {
    let stderrTail = "";
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: captureFailureDiagnostic ? ["inherit", "inherit", "pipe"] : "inherit",
      env: { ...process.env, ...extraEnv }
    });
    if (captureFailureDiagnostic) {
      child.stderr?.on("data", (chunk) => {
        stderrTail = `${stderrTail}${String(chunk)}`.slice(-8192);
        // Preserve the inherited-stderr behavior's backpressure. Without
        // pausing this pipe, a noisy failed child can enqueue unbounded writes
        // in the orchestrator while diagnostics are being captured.
        if (!process.stderr.write(chunk)) {
          child.stderr?.pause();
          process.stderr.once("drain", () => child.stderr?.resume());
        }
      });
    }
    child.on("error", reject);
    // Wait for stdio to close so the final diagnostic line cannot race the
    // process exit event and disappear from the summary artifact.
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const fallback = `${path.basename(args[0] ?? command)} exited with status ${code}`;
        reject(new Error(failureDiagnosticFromStderr(stderrTail) || fallback));
      }
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function booleanEnv(name, fallback, environment = process.env) {
  const value = environment[name];
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function positiveIntEnv(name, fallback, environment = process.env) {
  const value = Number(environment[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
