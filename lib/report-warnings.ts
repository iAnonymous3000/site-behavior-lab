/**
 * Grouping for a report's measurement caveats.
 *
 * A comparison report carries one flat `warnings: string[]` in which every
 * entry from a paired visit is prefixed with that visit's display label
 * (`scan-report-views.ts` builds it that way for v2, and v1 producers wrote the
 * same shape onto the wire). A real Brave-list comparison therefore renders
 * around sixteen consecutive caution banners, and most of them are the SAME
 * sentence twice: "No blocking: This report is one automated, headless Chromium
 * visit..." immediately followed by "Brave-list blocking: This report is one
 * automated, headless Chromium visit...". The reader gets a wall that reads as
 * sixteen alarms and is skipped entirely, which is the opposite of what a
 * measurement caveat is for.
 *
 * This groups them instead. A sentence recorded by both visits becomes one row
 * attributed to both; the rest stay attributed to the visit that recorded them.
 *
 * Two properties the UI depends on, and neither is optional:
 *
 * 1. NOTHING IS HIDDEN. Every distinct sentence appears in exactly one group,
 *    and the caller renders every group. Putting caveats behind a disclosure or
 *    a "show more" is a defect this project has already filed and fixed once:
 *    a collapsed caveat reaches nobody who was not already looking for it, and
 *    it cannot reach paper at all.
 * 2. IT FAILS BACK TO FLAT. Any ambiguity about which visit a sentence belongs
 *    to (no labels, equal labels, or one label being a prefix of the other, so
 *    a strip could pick the wrong arm) returns the original list unchanged and
 *    unattributed. Losing the grouping is cosmetic; misattributing a caveat to
 *    the wrong visit is a claim the evidence does not support.
 */

export type ReportWarningScope = "report" | "both" | "baseline" | "variant";

export type ReportWarningGroup = {
  scope: ReportWarningScope;
  /**
   * The heading for this group, or null when there is nothing to attribute
   * (a single-run report, or a fall back to the flat list).
   */
  label: string | null;
  /** The caveat sentences, with any visit-label prefix removed. */
  warnings: string[];
};

export type ComparisonRunLabels = { baseline: string; variant: string };

const PREFIX_SEPARATOR = ": ";

/**
 * The producer records the measurement-limits caveat PER RUN, where "This
 * report is one automated, headless Chromium visit" is true. A comparison
 * carries both runs' copies, so after deduping it renders once, at report
 * level, still telling the reader the report is a single visit directly below
 * a headline that says "Observed in two automated visits". It is on every
 * committed comparison, in print, in the PDF, and in the exported JSON.
 *
 * The subject is corrected here, on the read side, and only for a report that
 * really does hold more than one visit. The producer's sentence is an admitted
 * public string whose bytes feed the r2 normalization identity, so rewriting it
 * at the producer would retire that identity and require remediating every
 * published report; nothing about the wire changes here.
 */
const SINGLE_VISIT_CLAUSE = " is one automated, headless Chromium visit";
const MULTI_VISIT_SUBJECTS: ReadonlyArray<readonly [string, string]> = [
  ["This report", "Each visit in this report"],
  ["This Cloudflare report", "Each Cloudflare visit in this report"]
];

export function reSubjectForMultipleVisits(warning: string): string {
  for (const [subject, replacement] of MULTI_VISIT_SUBJECTS) {
    const at = warning.indexOf(`${subject}${SINGLE_VISIT_CLAUSE}`);
    // Only at the start of the sentence: either the whole string, or straight
    // after a visit-label prefix. Anywhere else it is part of another clause.
    if (at === -1) continue;
    if (at !== 0 && !warning.startsWith(PREFIX_SEPARATOR, at - PREFIX_SEPARATOR.length)) continue;
    return `${warning.slice(0, at)}${replacement}${warning.slice(at + subject.length)}`;
  }
  return warning;
}

/**
 * Group a report's warnings by the visit that recorded them.
 *
 * @param warnings The report-level warning list, exactly as the view carries it.
 * @param runLabels The comparison's display labels, or null for a single run.
 */
export function groupReportWarnings(
  warnings: readonly string[],
  runLabels: ComparisonRunLabels | null
): ReportWarningGroup[] {
  // Reports saved before the collector deduped can carry exact-duplicate
  // warnings; a repeat adds nothing and would break the message-text keys.
  // A single-run report is correctly described by the producer's own sentence,
  // so the re-subjecting applies only where a second visit exists. It runs
  // before the label prefixes are stripped so the flat fall back is corrected
  // too, and it preserves any prefix it finds.
  const unique = [...new Set(warnings)].map((warning) =>
    runLabels === null ? warning : reSubjectForMultipleVisits(warning)
  );
  if (unique.length === 0) return [];
  if (!canAttribute(runLabels)) return [{ scope: "report", label: null, warnings: unique }];

  const baselinePrefix = `${runLabels.baseline}${PREFIX_SEPARATOR}`;
  const variantPrefix = `${runLabels.variant}${PREFIX_SEPARATOR}`;

  // First appearance wins the ordering, so a grouped list still reads in the
  // order the producer recorded.
  const order: string[] = [];
  const seenIn = new Map<string, { baseline: boolean; variant: boolean; report: boolean }>();

  for (const warning of unique) {
    const arm = warning.startsWith(baselinePrefix)
      ? "baseline"
      : warning.startsWith(variantPrefix)
        ? "variant"
        : "report";
    const body =
      arm === "baseline"
        ? warning.slice(baselinePrefix.length)
        : arm === "variant"
          ? warning.slice(variantPrefix.length)
          : warning;
    // A bare label with nothing after it carries no caveat and would render an
    // empty row; keep the original string rather than inventing one.
    const key = body.length > 0 ? body : warning;
    const record = seenIn.get(key);
    if (record) {
      record[arm] = true;
      continue;
    }
    order.push(key);
    seenIn.set(key, {
      baseline: arm === "baseline",
      variant: arm === "variant",
      report: arm === "report"
    });
  }

  const buckets: Record<ReportWarningScope, string[]> = {
    report: [],
    both: [],
    baseline: [],
    variant: []
  };
  for (const key of order) {
    const record = seenIn.get(key)!;
    // A sentence that arrived both with and without an arm prefix cannot be
    // attributed to one visit, so it is reported as covering the report.
    if (record.report) buckets.report.push(key);
    else if (record.baseline && record.variant) buckets.both.push(key);
    else if (record.baseline) buckets.baseline.push(key);
    else buckets.variant.push(key);
  }

  const groups: ReportWarningGroup[] = [];
  if (buckets.report.length > 0) {
    groups.push({ scope: "report", label: "This report", warnings: buckets.report });
  }
  if (buckets.both.length > 0) {
    groups.push({ scope: "both", label: "Both visits", warnings: buckets.both });
  }
  if (buckets.baseline.length > 0) {
    groups.push({
      scope: "baseline",
      label: `${runLabels.baseline} visit only`,
      warnings: buckets.baseline
    });
  }
  if (buckets.variant.length > 0) {
    groups.push({
      scope: "variant",
      label: `${runLabels.variant} visit only`,
      warnings: buckets.variant
    });
  }
  return groups;
}

/** Total sentences across every group, for a heading that states the count. */
export function reportWarningCount(groups: readonly ReportWarningGroup[]): number {
  return groups.reduce((total, group) => total + group.warnings.length, 0);
}

/**
 * Whether the two labels can strip unambiguously.
 *
 * Equal labels make every entry look like both arms. Otherwise the test is on
 * the whole PREFIX, separator included, not the label: one arm's prefix being a
 * prefix of the other's ("A: " against "A: B: ") means the shorter matches an
 * entry belonging to the longer, and the sentence is filed under the wrong
 * visit with a fragment left in front of it. A label that is merely a word
 * prefix ("Blocking" against "Blocking off") is safe, because the separator
 * ends it, and that is the shape this project's own comparison labels take.
 */
function canAttribute(runLabels: ComparisonRunLabels | null): runLabels is ComparisonRunLabels {
  if (!runLabels) return false;
  const baseline = `${runLabels.baseline}${PREFIX_SEPARATOR}`;
  const variant = `${runLabels.variant}${PREFIX_SEPARATOR}`;
  if (!runLabels.baseline || !runLabels.variant) return false;
  if (baseline === variant) return false;
  return !baseline.startsWith(variant) && !variant.startsWith(baseline);
}
