import type { StoredScanReport } from "./scan-report-reader";

/**
 * The immutable creation clock recorded in a committed report's provenance
 * sidecar. Legacy v1 keeps its historical clock exactly. V2 reports use the
 * latest complete run that contributed evidence to the report, including all
 * r2 supporting-pair arms, so retention/provenance never predates embedded
 * evidence.
 */
export function committedReportCreatedAt(stored: StoredScanReport): string {
  if (stored.schemaVersion === 1) {
    const createdAt =
      stored.report.reportType === "comparison"
        ? stored.report.scannedAt
        : stored.report.conditions.scannedAt;
    assertCanonicalTimestamp(createdAt);
    return createdAt;
  }

  const startedAts =
    stored.report.reportType === "single"
      ? [stored.report.run.startedAt]
      : [stored.report.baseline.startedAt, stored.report.variant.startedAt];

  if (
    stored.schemaRevision === 2 &&
    stored.report.reportType === "comparison" &&
    stored.report.experiment.kind === "intervention"
  ) {
    for (const pair of stored.report.experiment.supportingPairs ?? []) {
      startedAts.push(pair.baseline.startedAt, pair.variant.startedAt);
    }
  }

  let latest = startedAts[0];
  let latestMs = canonicalTimestampMs(latest);
  for (const startedAt of startedAts.slice(1)) {
    const startedAtMs = canonicalTimestampMs(startedAt);
    if (startedAtMs > latestMs) {
      latest = startedAt;
      latestMs = startedAtMs;
    }
  }
  return latest;
}

function assertCanonicalTimestamp(value: string): void {
  canonicalTimestampMs(value);
}

function canonicalTimestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Cannot derive committed report creation time from a non-canonical timestamp.");
  }
  return parsed;
}
