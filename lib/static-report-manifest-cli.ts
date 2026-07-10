import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildStaticReportManifest } from "./static-report-manifest";

/**
 * CLI wrapper for the static gallery manifest builder. Invoked (compiled to
 * the dist/schema production artifact, RFC 10.3) by
 * scripts/build-static-report-manifest.mjs, which the Pages build, the
 * featured-scan refresh, and the scan workflows all call.
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */
async function main(): Promise<void> {
  // The launcher runs this with cwd = repo root (works identically from the
  // Pages builder's isolated worktree, which carries no dist/ of its own).
  const rootDir = process.cwd();
  const reportsDir = path.join(rootDir, "public", "reports");
  await mkdir(reportsDir, { recursive: true });

  const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
  for (const warning of warnings) {
    console.warn(warning);
  }

  await writeFile(path.join(reportsDir, "index.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Static report manifest written with ${manifest.reports.length} report${manifest.reports.length === 1 ? "" : "s"}.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
