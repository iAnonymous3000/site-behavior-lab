import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCorpusStats } from "./corpus-stats-builder";

/**
 * CLI wrapper for the corpus percentile builder. Invoked (compiled) by
 * scripts/build-corpus-stats.mjs, which the Pages build and the scan
 * workflows call.
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */
async function main(): Promise<void> {
  // Compiled to .unit-test-dist/lib/, so the repo root is two levels up.
  const rootDir = path.resolve(__dirname, "..", "..");
  const reportsDir = path.join(rootDir, "public", "reports");
  const outPath = path.join(rootDir, "public", "corpus-stats.json");

  const { stats, warnings } = await buildCorpusStats(reportsDir);
  for (const warning of warnings) {
    console.warn(warning);
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`Corpus stats written: ${stats.sampleSize} distinct real site${stats.sampleSize === 1 ? "" : "s"}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
