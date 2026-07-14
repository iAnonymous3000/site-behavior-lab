// Titles served by common bot walls (Cloudflare, Akamai, PerimeterX, Google).
// Never include the matched title in the returned reason: CI logs are public.
const BLOCK_TITLE_PATTERN =
  /access denied|attention required|just a moment|pardon our interruption|are you (a )?(human|robot)|verify (you are|you'?re|your) (a )?human|checking your browser|unusual traffic|security check|request unsuccessful|captcha|enable javascript/i;

/**
 * The CI lane publishes frozen v1 and the current v2/r2 revision. V2 roots do
 * not carry the legacy `ok` success flag, so success must dispatch by schema
 * version/revision instead of truth-testing that field. The compiled publisher
 * performs the authoritative structural and semantic validation later.
 */
export function isPublishableScanReport(response) {
  if (!isRecord(response) || (response.reportType !== "single" && response.reportType !== "comparison")) {
    return false;
  }
  if (response.schemaVersion === 1) return response.ok === true;
  return response.schemaVersion === 2 && response.schemaRevision === 2;
}

/**
 * Fail closed when ANY run embedded in a report looks like a bot wall or a
 * failed navigation. Comparisons are evidence bundles: checking only the lead
 * baseline would allow a blocked primary variant or supporting replication arm
 * into the corpus and make the resulting comparison misleading.
 */
export function botBlockReason(report) {
  for (const run of reportRuns(report)) {
    const title = String(run.summary?.pageTitle || "").trim();
    const totalRequests = Number(
      report.schemaVersion === 2
        ? run.summary?.counts?.totalRequests
        : run.summary?.totalRequests
    ) || 0;
    if (title && BLOCK_TITLE_PATTERN.test(title)) {
      return `${run.label}: landing page title matches a bot-block/challenge page`;
    }
    if (totalRequests <= 1) {
      return `${run.label}: only ${totalRequests} network request(s) observed, navigation likely failed or was blocked`;
    }
  }
  return null;
}

function reportRuns(report) {
  if (!isRecord(report)) return [];

  if (report.reportType === "single") {
    const run = report.schemaVersion === 2 ? report.run : report;
    return isRecord(run) ? [{ label: "single run", summary: run.summary }] : [];
  }
  if (report.reportType !== "comparison") return [];

  const runs = [];
  if (isRecord(report.baseline)) {
    runs.push({ label: "primary baseline arm", summary: report.baseline.summary });
  }
  if (isRecord(report.variant)) {
    runs.push({ label: "primary variant arm", summary: report.variant.summary });
  }
  if (
    report.schemaVersion === 2 &&
    report.schemaRevision === 2 &&
    isRecord(report.experiment) &&
    report.experiment.kind === "intervention" &&
    Array.isArray(report.experiment.supportingPairs)
  ) {
    for (const [index, pair] of report.experiment.supportingPairs.entries()) {
      if (!isRecord(pair)) continue;
      if (isRecord(pair.baseline)) {
        runs.push({ label: `supporting pair ${index + 1} baseline arm`, summary: pair.baseline.summary });
      }
      if (isRecord(pair.variant)) {
        runs.push({ label: `supporting pair ${index + 1} variant arm`, summary: pair.variant.summary });
      }
    }
  }
  return runs;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
