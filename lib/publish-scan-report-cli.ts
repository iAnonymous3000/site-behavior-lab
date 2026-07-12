import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildStaticReportShare } from "./report-locator";
import {
  buildProvenanceEntry,
  committedSidecarFilename
} from "./redaction-provenance";
import { REPORT_ID_PATTERN } from "./report-validation";
import { readManagedReport } from "./managed-report-reader";
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
  if (path.basename(outputPath) !== `${reportId}.json`) {
    throw new Error("Refusing to publish: output filename must match the report id.");
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

  // Apply both defenses after attaching the generated capability paths: deep
  // named-field projection drops anything the tolerant v1 reader did not
  // recognize, and the idempotent sanitizer minimizes every retained field
  // and rederives comparison diffs from the sanitized arms.
  const publicReport = toPublicScanReportV1({
    ...toPublicScanReportV1(read.stored.report),
    share: buildStaticReportShare(reportId)
  });

  // Belt and braces: the exact bytes about to be committed must round-trip
  // through the same reader every consumer uses.
  const wire = `${JSON.stringify(publicReport, null, 2)}\n`;
  const reread = readStoredScanReport(JSON.parse(wire));
  if (!reread.ok) {
    throw new Error(`Projected report failed re-validation (${reread.error}); refusing to publish.`);
  }

  const createdAt =
    publicReport.reportType === "comparison"
      ? publicReport.scannedAt
      : publicReport.conditions.scannedAt;
  const provenance = buildProvenanceEntry({
    reportId,
    publicReport,
    writtenAt: new Date().toISOString(),
    createdAt,
    expiresAt: null
  });
  const sidecarPath = path.join(path.dirname(outputPath), committedSidecarFilename(reportId));
  const sidecarWire = `${JSON.stringify(provenance, null, 2)}\n`;
  const retention = { createdAt, expiresAt: null };
  const managed = readManagedReport({
    reportId,
    reportContents: wire,
    sidecarContents: sidecarWire,
    retention
  });
  if (!managed.ok) {
    throw new Error(`Managed report pair failed validation (${managed.reason}); refusing to publish.`);
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  // Contractual failure ordering: report first, sidecar second. A crash
  // between writes leaves an unknown/unpublishable report, never false current
  // provenance; the mandatory remediation check catches the partial pair.
  await writeFile(outputPath, wire);
  await writeFile(sidecarPath, sidecarWire);
  const [writtenReport, writtenSidecar] = await Promise.all([
    readFile(outputPath, "utf8"),
    readFile(sidecarPath, "utf8")
  ]);
  const readback = readManagedReport({
    reportId,
    reportContents: writtenReport,
    sidecarContents: writtenSidecar,
    retention
  });
  if (!readback.ok) {
    throw new Error(`Published report pair failed readback (${readback.reason}).`);
  }
  console.log(`Published validated report and provenance sidecar ${reportId}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
