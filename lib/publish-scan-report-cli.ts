import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPORT_ID_PATTERN } from "./report-validation";
import { readStoredScanReport } from "./scan-report-reader";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";

/**
 * THE persistence boundary for CI-produced committed reports (RFC 14.8/9.2):
 * scripts/run-ci-scan.mjs pipes the scan API's JSON through this compiled CLI
 * instead of spread-copying it into public/reports/. The payload must pass
 * the canonical version-aware deep reader, is then projected through the
 * named-field v1 projector (screenshots dropped, unknown/smuggled fields
 * impossible), gets the canonical public share pointer for its id, and is
 * re-validated before a single byte is written.
 *
 *   node dist/schema/lib/publish-scan-report-cli.js <input.json> <output.json> <report-id>
 *
 * Node-only CLI: never imported by app, worker, or browser code.
 */
async function main(): Promise<void> {
  const [inputPath, outputPath, reportId] = process.argv.slice(2);
  if (!inputPath || !outputPath || !reportId) {
    throw new Error("Usage: publish-scan-report-cli <input.json> <output.json> <report-id>");
  }
  if (!REPORT_ID_PATTERN.test(reportId)) {
    throw new Error(`Refusing to publish under invalid report id "${reportId}".`);
  }

  const parsed = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const read = readStoredScanReport(parsed);
  if (!read.ok) {
    throw new Error(
      `Refusing to publish: the scan result is not a readable report (${read.error}${read.violations ? `: ${read.violations[0]}` : ""}).`
    );
  }
  if (read.stored.schemaVersion !== 1) {
    throw new Error("Refusing to publish: committed corpus reports are v1 until the r2 producer rollout (RFC 14 step 12).");
  }

  const projected = toPublicScanReportV1(read.stored.report);
  const share = {
    id: reportId,
    path: `/reports/${reportId}/`,
    jsonPath: `/reports/${reportId}.json`
  };
  const publicReport = { ...projected, share };

  // Belt and braces: the exact bytes about to be committed must round-trip
  // through the same reader every consumer uses.
  const wire = `${JSON.stringify(publicReport, null, 2)}\n`;
  const reread = readStoredScanReport(JSON.parse(wire));
  if (!reread.ok) {
    throw new Error(`Projected report failed re-validation (${reread.error}); refusing to publish.`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, wire);
  console.log(`Published validated report ${reportId}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
