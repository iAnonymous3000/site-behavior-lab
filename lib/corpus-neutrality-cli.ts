import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ComparisonDecisionMode } from "./comparison-decision";
import { METRIC_FAMILIES, type MetricFamily } from "./scan-report-v2";
import { toReportView } from "./scan-report-view";
import { REPORT_ID_PATTERN } from "./report-validation";
import {
  listDanglingStaticSidecarIds,
  listStaticReportCandidateIds,
  readStaticReportBundle,
  StaticReportBundleError
} from "./static-report-files";

/**
 * A deterministic, metadata-only record of the comparison decisions exposed
 * by the canonical report view. It deliberately contains no timestamps,
 * subjects, measurements, or evidence, so it is safe to keep as a local
 * before/after toolchain audit artifact.
 */
export type CorpusNeutralitySnapshot = {
  snapshotVersion: 1;
  reports: CorpusNeutralityReportDecision[];
};

export type CorpusNeutralityReportDecision = {
  reportId: string;
  overallMode: "comparable" | "raw-only";
  families: CorpusNeutralityFamilyDecision[];
};

export type CorpusNeutralityFamilyDecision = {
  family: MetricFamily;
  mode: ComparisonDecisionMode;
  reasons: string[];
};

export type CorpusNeutralityDifference =
  | { kind: "report-added"; reportId: string }
  | { kind: "report-removed"; reportId: string }
  | {
      kind: "overall-mode";
      reportId: string;
      baseline: CorpusNeutralityReportDecision["overallMode"];
      candidate: CorpusNeutralityReportDecision["overallMode"];
    }
  | {
      kind: "family-mode";
      reportId: string;
      family: MetricFamily;
      baseline: ComparisonDecisionMode;
      candidate: ComparisonDecisionMode;
    }
  | {
      kind: "family-reasons";
      reportId: string;
      family: MetricFamily;
      baseline: string[];
      candidate: string[];
    };

export type CorpusNeutralityComparison = {
  ok: boolean;
  baselineReports: number;
  candidateReports: number;
  reportSetDifferences: number;
  overallModeFlips: number;
  familyModeFlips: number;
  familyReasonChanges: number;
  differences: CorpusNeutralityDifference[];
};

export type CorpusNeutralityCliArgs =
  | { command: "snapshot"; rootDir: string; outputFile: string }
  | { command: "compare"; baselineFile: string; candidateFile: string };

/** Read every managed committed report and retain comparison decisions only. */
export async function buildCorpusNeutralitySnapshot(rootDir = process.cwd()): Promise<CorpusNeutralitySnapshot> {
  const reportsDir = path.join(rootDir, "public", "reports");
  const reports: CorpusNeutralityReportDecision[] = [];

  // This canonical inventory fails closed on dangling sidecars and on any
  // report that is not a complete, readable managed bundle.
  const dangling = await listDanglingStaticSidecarIds(reportsDir);
  if (dangling.length > 0) throw new StaticReportBundleError(dangling[0], "dangling-sidecar");
  for (const reportId of await listStaticReportCandidateIds(reportsDir)) {
    const read = await readStaticReportBundle(reportsDir, reportId);
    if (read.outcome !== "found") {
      throw new StaticReportBundleError(
        reportId,
        read.outcome === "not-found" ? "missing-report" : read.reason
      );
    }

    const view = toReportView(read.stored);
    if (view.reportType !== "comparison") continue;
    const decision = view.claims.decision;
    if (!decision) throw new Error(`Comparison report ${reportId} has no canonical decision.`);

    const families = METRIC_FAMILIES.map((family) => {
      const entry = decision.families[family];
      if (!entry) throw new Error(`Comparison report ${reportId} has no ${family} decision.`);
      return {
        family,
        mode: entry.mode,
        reasons: [...entry.reasons].sort(compareText)
      };
    }).sort((left, right) => compareText(left.family, right.family));

    reports.push({ reportId, overallMode: decision.mode, families });
  }

  reports.sort((left, right) => compareText(left.reportId, right.reportId));
  return { snapshotVersion: 1, reports };
}

export function serializeCorpusNeutralitySnapshot(snapshot: CorpusNeutralitySnapshot): string {
  return `${JSON.stringify(parseCorpusNeutralitySnapshot(snapshot), null, 2)}\n`;
}

/** Strictly parse and normalize a local snapshot before it is used as a gate. */
function parseCorpusNeutralitySnapshot(
  value: unknown,
  label = "Corpus-neutrality snapshot"
): CorpusNeutralitySnapshot {
  if (!isRecord(value) || !hasExactKeys(value, ["snapshotVersion", "reports"])) {
    throw new Error(`${label} has an invalid root shape.`);
  }
  if (value.snapshotVersion !== 1 || !Array.isArray(value.reports)) {
    throw new Error(`${label} must use snapshotVersion 1 and contain a reports array.`);
  }

  const seenReports = new Set<string>();
  const reports = value.reports.map((report, reportIndex) => {
    const reportLabel = `${label} report ${reportIndex + 1}`;
    if (!isRecord(report) || !hasExactKeys(report, ["reportId", "overallMode", "families"])) {
      throw new Error(`${reportLabel} has an invalid shape.`);
    }
    if (typeof report.reportId !== "string" || !REPORT_ID_PATTERN.test(report.reportId)) {
      throw new Error(`${reportLabel} has an invalid reportId.`);
    }
    if (seenReports.has(report.reportId)) throw new Error(`${label} repeats report ${report.reportId}.`);
    seenReports.add(report.reportId);
    if (!isOverallMode(report.overallMode) || !Array.isArray(report.families)) {
      throw new Error(`${reportLabel} has an invalid overall mode or families array.`);
    }

    const seenFamilies = new Set<MetricFamily>();
    const families = report.families.map((entry, familyIndex) => {
      const familyLabel = `${reportLabel} family ${familyIndex + 1}`;
      if (!isRecord(entry) || !hasExactKeys(entry, ["family", "mode", "reasons"])) {
        throw new Error(`${familyLabel} has an invalid shape.`);
      }
      if (!isMetricFamily(entry.family) || !isDecisionMode(entry.mode) || !Array.isArray(entry.reasons)) {
        throw new Error(`${familyLabel} has an invalid family, mode, or reasons array.`);
      }
      if (seenFamilies.has(entry.family)) {
        throw new Error(`${reportLabel} repeats the ${entry.family} family.`);
      }
      seenFamilies.add(entry.family);
      if (entry.reasons.some((reason) => typeof reason !== "string" || reason.length === 0)) {
        throw new Error(`${familyLabel} contains an invalid reason.`);
      }
      return {
        family: entry.family,
        mode: entry.mode,
        reasons: [...entry.reasons].sort(compareText)
      };
    });

    const missingFamilies = METRIC_FAMILIES.filter((family) => !seenFamilies.has(family));
    if (missingFamilies.length > 0 || seenFamilies.size !== METRIC_FAMILIES.length) {
      throw new Error(
        `${reportLabel} must contain exactly these metric families: ${[...METRIC_FAMILIES].sort(compareText).join(", ")}.`
      );
    }

    return {
      reportId: report.reportId,
      overallMode: report.overallMode,
      families: families.sort((left, right) => compareText(left.family, right.family))
    };
  });

  reports.sort((left, right) => compareText(left.reportId, right.reportId));
  return { snapshotVersion: 1, reports };
}

/** Exact-set, zero-change comparison. Any recorded decision difference fails. */
export function compareCorpusNeutralitySnapshots(
  baselineValue: unknown,
  candidateValue: unknown
): CorpusNeutralityComparison {
  const baseline = parseCorpusNeutralitySnapshot(baselineValue, "Baseline snapshot");
  const candidate = parseCorpusNeutralitySnapshot(candidateValue, "Candidate snapshot");
  const baselineById = new Map(baseline.reports.map((report) => [report.reportId, report]));
  const candidateById = new Map(candidate.reports.map((report) => [report.reportId, report]));
  const differences: CorpusNeutralityDifference[] = [];

  for (const reportId of [...baselineById.keys()].sort(compareText)) {
    if (!candidateById.has(reportId)) differences.push({ kind: "report-removed", reportId });
  }
  for (const reportId of [...candidateById.keys()].sort(compareText)) {
    if (!baselineById.has(reportId)) differences.push({ kind: "report-added", reportId });
  }

  for (const reportId of [...baselineById.keys()].filter((id) => candidateById.has(id)).sort(compareText)) {
    const baselineReport = baselineById.get(reportId)!;
    const candidateReport = candidateById.get(reportId)!;
    if (baselineReport.overallMode !== candidateReport.overallMode) {
      differences.push({
        kind: "overall-mode",
        reportId,
        baseline: baselineReport.overallMode,
        candidate: candidateReport.overallMode
      });
    }

    const candidateFamilies = new Map(candidateReport.families.map((entry) => [entry.family, entry]));
    for (const baselineFamily of baselineReport.families) {
      const candidateFamily = candidateFamilies.get(baselineFamily.family)!;
      if (baselineFamily.mode !== candidateFamily.mode) {
        differences.push({
          kind: "family-mode",
          reportId,
          family: baselineFamily.family,
          baseline: baselineFamily.mode,
          candidate: candidateFamily.mode
        });
      }
      if (!sameStrings(baselineFamily.reasons, candidateFamily.reasons)) {
        differences.push({
          kind: "family-reasons",
          reportId,
          family: baselineFamily.family,
          baseline: baselineFamily.reasons,
          candidate: candidateFamily.reasons
        });
      }
    }
  }

  const reportSetDifferences = differences.filter(
    (difference) => difference.kind === "report-added" || difference.kind === "report-removed"
  ).length;
  const overallModeFlips = differences.filter((difference) => difference.kind === "overall-mode").length;
  const familyModeFlips = differences.filter((difference) => difference.kind === "family-mode").length;
  const familyReasonChanges = differences.filter((difference) => difference.kind === "family-reasons").length;
  return {
    ok: differences.length === 0,
    baselineReports: baseline.reports.length,
    candidateReports: candidate.reports.length,
    reportSetDifferences,
    overallModeFlips,
    familyModeFlips,
    familyReasonChanges,
    differences
  };
}

export function formatCorpusNeutralityComparison(result: CorpusNeutralityComparison): string {
  if (result.ok) {
    return `Corpus neutrality unchanged across ${result.baselineReports} managed comparison report${result.baselineReports === 1 ? "" : "s"}.`;
  }

  const lines = [
    `Corpus neutrality changed: ${result.reportSetDifferences} report-set difference${result.reportSetDifferences === 1 ? "" : "s"}, ` +
      `${result.overallModeFlips} overall-mode flip${result.overallModeFlips === 1 ? "" : "s"}, ` +
      `${result.familyModeFlips} family-mode flip${result.familyModeFlips === 1 ? "" : "s"}, ` +
      `${result.familyReasonChanges} family-reason change${result.familyReasonChanges === 1 ? "" : "s"}.`
  ];
  const shown = result.differences.slice(0, 12);
  for (const difference of shown) lines.push(`- ${formatDifference(difference)}`);
  if (shown.length < result.differences.length) {
    lines.push(`- ${result.differences.length - shown.length} additional difference${result.differences.length - shown.length === 1 ? "" : "s"} omitted.`);
  }
  return lines.join("\n");
}

export function parseCorpusNeutralityCliArgs(args: string[]): CorpusNeutralityCliArgs {
  const [command, ...rest] = args;
  if (command !== "snapshot" && command !== "compare") {
    throw new Error("First argument must be snapshot or compare.");
  }

  const values = new Map<string, string>();
  const allowed = command === "snapshot" ? new Set(["--out"]) : new Set(["--baseline", "--candidate"]);
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (!allowed.has(argument)) throw new Error(`Unknown ${command} argument: ${argument}`);
    if (values.has(argument)) throw new Error(`${argument} may be specified only once.`);
    const value = rest[++index]?.trim() ?? "";
    if (!value) throw new Error(`${argument} requires a non-empty value.`);
    values.set(argument, value);
  }

  if (command === "snapshot") {
    const outputFile = requiredValue(values, "--out");
    return {
      command,
      rootDir: path.resolve(process.cwd()),
      outputFile: path.resolve(outputFile)
    };
  }

  const baselineFile = path.resolve(requiredValue(values, "--baseline"));
  const candidateFile = path.resolve(requiredValue(values, "--candidate"));
  if (baselineFile === candidateFile) throw new Error("--baseline and --candidate must identify different files.");
  return { command, baselineFile, candidateFile };
}

async function readSnapshotFile(file: string, label: string): Promise<CorpusNeutralitySnapshot> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON.`);
    throw error;
  }
  return parseCorpusNeutralitySnapshot(value, label);
}

function formatDifference(difference: CorpusNeutralityDifference): string {
  if (difference.kind === "report-added") return `${difference.reportId} was added.`;
  if (difference.kind === "report-removed") return `${difference.reportId} was removed.`;
  if (difference.kind === "overall-mode") {
    return `${difference.reportId} overall mode changed ${difference.baseline} -> ${difference.candidate}.`;
  }
  if (difference.kind === "family-mode") {
    return `${difference.reportId} ${difference.family} mode changed ${difference.baseline} -> ${difference.candidate}.`;
  }
  return `${difference.reportId} ${difference.family} reasons changed.`;
}

function requiredValue(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort(compareText);
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort(compareText)[index]);
}

function isOverallMode(value: unknown): value is CorpusNeutralityReportDecision["overallMode"] {
  return value === "comparable" || value === "raw-only";
}

function isDecisionMode(value: unknown): value is ComparisonDecisionMode {
  return value === "comparable" || value === "raw-only" || value === "suppressed";
}

function isMetricFamily(value: unknown): value is MetricFamily {
  return typeof value === "string" && (METRIC_FAMILIES as readonly string[]).includes(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main(): Promise<void> {
  const args = parseCorpusNeutralityCliArgs(process.argv.slice(2));
  if (args.command === "snapshot") {
    const snapshot = await buildCorpusNeutralitySnapshot(args.rootDir);
    await writeFile(args.outputFile, serializeCorpusNeutralitySnapshot(snapshot), { flag: "wx" });
    console.log(
      `Wrote ${snapshot.reports.length} managed comparison decision${snapshot.reports.length === 1 ? "" : "s"} to ${args.outputFile}.`
    );
    return;
  }

  const [baseline, candidate] = await Promise.all([
    readSnapshotFile(args.baselineFile, "Baseline snapshot"),
    readSnapshotFile(args.candidateFile, "Candidate snapshot")
  ]);
  const result = compareCorpusNeutralitySnapshots(baseline, candidate);
  console.log(formatCorpusNeutralityComparison(result));
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
