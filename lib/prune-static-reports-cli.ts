import path from "node:path";
import { pruneStaticReports } from "./prune-static-reports";

/**
 * CLI wrapper for corpus retention pruning. Invoked (compiled to the
 * dist/schema production artifact, RFC 10.3) by scripts/prune-static-reports.mjs,
 * which the scan workflows call before committing.
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */
const DEFAULT_MAX_AGE_DAYS = 7;
// Hard ceiling on committed reports. With per-site-per-kind history retention
// the protected set alone can approach sites x kinds x 2, so this sits well
// above it; at ~150 KB per report the ceiling bounds the repo at roughly
// 150 MB of report JSON.
const DEFAULT_MAX_COUNT = 1_000;
// Each site's newest reports PER KIND stay exempt from AGE pruning so the
// directory's "changed since last scan" view keeps a current and a previous
// generation. Set to 0 to restore pure age-based pruning.
const DEFAULT_KEEP_PER_SITE = 2;

async function main(): Promise<void> {
  // The launcher runs this with cwd = repo root.
  const reportsDir = path.join(process.cwd(), "public", "reports");

  const maxAgeMs =
    positiveNumberFromEnv(
      "SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_AGE_DAYS",
      positiveNumberFromEnv("SITE_BEHAVIOR_LAB_REPORT_MAX_AGE_DAYS", DEFAULT_MAX_AGE_DAYS)
    ) *
    24 *
    60 *
    60 *
    1_000;
  const maxCount = Math.max(
    1,
    Math.floor(
      positiveNumberFromEnv(
        "SITE_BEHAVIOR_LAB_STATIC_REPORT_MAX_COUNT",
        positiveNumberFromEnv("SITE_BEHAVIOR_LAB_REPORT_MAX_COUNT", DEFAULT_MAX_COUNT)
      )
    )
  );
  const keepPerSite = Math.max(
    0,
    Math.floor(nonNegativeNumberFromEnv("SITE_BEHAVIOR_LAB_STATIC_REPORT_KEEP_PER_SITE", DEFAULT_KEEP_PER_SITE))
  );

  const { removed, warnings } = await pruneStaticReports(reportsDir, { maxAgeMs, maxCount, keepPerSite });
  for (const warning of warnings) {
    console.warn(warning);
  }
  console.log(`Pruned ${removed.length} static report${removed.length === 1 ? "" : "s"}.`);
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] || "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
