import { mkdir } from "node:fs/promises";
import path from "node:path";
import { replaceUtf8FileAtomically } from "./exact-atomic-file";
import { acquireReportCorpusLock } from "./report-corpus-lock";
import { STATIC_REPORT_MANIFEST_JSON_MAX_BYTES } from "./report-resource-limits";
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
  const lock = await acquireReportCorpusLock(reportsDir, "build-static-report-manifest");
  try {
    const { manifest, warnings } = await buildStaticReportManifest(reportsDir);
    for (const warning of warnings) {
      console.warn(warning);
    }

    await replaceUtf8FileAtomically(
      path.join(reportsDir, "index.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      STATIC_REPORT_MANIFEST_JSON_MAX_BYTES
    );
    console.log(
      `Static report manifest written with ${manifest.reports.length} report${manifest.reports.length === 1 ? "" : "s"}.`
    );
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
