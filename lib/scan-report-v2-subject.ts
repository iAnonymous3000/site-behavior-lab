import type { ScanRunV2 } from "./scan-report-v2";

/**
 * Whether two runs observed the same normalized origin and route shape.
 *
 * Kept dependency-light because comparison policy is rendered on the static
 * application shell, while the full semantic evaluator is needed only when a
 * report wire is read.
 */
export function subjectsMatch(a: ScanRunV2, b: ScanRunV2): boolean {
  return (
    a.subject.observed.origin === b.subject.observed.origin &&
    a.subject.observed.routeShape === b.subject.observed.routeShape
  );
}
