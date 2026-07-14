import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { buildStaticReportShare } from "./report-locator";
import {
  buildProvenanceEntry,
  committedSidecarFilename
} from "./redaction-provenance";
import { REPORT_ID_PATTERN } from "./report-validation";
import { readManagedReport } from "./managed-report-reader";
import { readStoredScanReport } from "./scan-report-reader";
import { publicWireForExportOrPersistence, readScanTransportPayload } from "./scan-report-view";
import { NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES } from "./scan-report-v2-r2-limits";

/**
 * THE persistence boundary for CI-produced committed reports (RFC 14.8/9.2):
 * scripts/run-ci-scan.mjs pipes the scan API's JSON through this compiled CLI
 * instead of spread-copying it into public/reports/. The payload must pass
 * the canonical version-aware transport reader, is then projected through the
 * public persistence boundary (screenshots dropped, unknown/smuggled fields
 * impossible), gets the canonical public share pointer for its id, and is
 * re-validated before a single byte is written. The committed rollout accepts
 * frozen v1 and validator-clean v2/r2; v2/r1 remains read-only compatibility.
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
  const transport = readScanTransportPayload(parsed);
  if (transport.kind !== "report") {
    const detail =
      transport.kind === "unreadable"
        ? `${transport.error}${transport.violations ? `: ${transport.violations[0]}` : ""}`
        : transport.kind === "api-error" || transport.kind === "job-ended"
          ? transport.message
          : `scan job is still ${transport.status}`;
    throw new Error(`Refusing to publish: the scan result is not a readable report (${detail}).`);
  }
  if (transport.loaded.source === "v2-public" || transport.loaded.source === "v2-ephemeral") {
    throw new Error("Refusing to publish: v2/r1 is compatibility-readable but only v1 and v2/r2 may enter the committed corpus.");
  }

  // The transport reader proves the input generation and semantics. The
  // persistence projector then strips ephemeral screenshot shells and applies
  // the frozen v1 allowlist/sanitizer before the generated capability paths
  // are attached.
  const publicCandidate = {
    ...publicWireForExportOrPersistence(transport.loaded),
    share: buildStaticReportShare(reportId)
  };

  // Belt and braces: the exact bytes about to be committed must round-trip
  // through the same reader every consumer uses.
  const wire = `${JSON.stringify(publicCandidate, null, 2)}\n`;
  if (
    (transport.loaded.source === "v2-r2-public" || transport.loaded.source === "v2-r2-ephemeral") &&
    Buffer.byteLength(wire, "utf8") > NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES
  ) {
    throw new Error(
      `Refusing to publish: projected v2/r2 report exceeds the ${NODE_SCAN_REPORT_V2_R2_MAX_PUBLIC_BYTES}-byte public limit.`
    );
  }
  const reread = readStoredScanReport(JSON.parse(wire));
  if (!reread.ok) {
    throw new Error(`Projected report failed re-validation (${reread.error}); refusing to publish.`);
  }
  const publicReport = reread.stored.report;

  const createdAt = committedReportCreatedAt(reread.stored);
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
