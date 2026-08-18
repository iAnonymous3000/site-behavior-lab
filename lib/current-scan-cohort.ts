import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  corpusCohortIdForIdentity,
  type CorpusCohortIdentityComponents
} from "./corpus-cohort";
import {
  CORPUS_MIN_SAMPLE,
  corpusIsUsable,
  isCorpusStats,
  selectCorpusStatsCohort,
  type CorpusStats
} from "./corpus-stats";
import { METRIC_CONTRACT_DIGEST, METRIC_CONTRACT_VERSION } from "./metric-contract";
import { NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION } from "./scan-report-v2-r2-producer-contract";
import { SCAN_REPORT_V2_SCHEMA_REVISION_2 } from "./scan-report-v2-r2";
import { SCAN_REPORT_V2_SCHEMA_VERSION } from "./scan-report-v2";
import {
  SERVICE_ROLE_TAXONOMY_DIGEST,
  SERVICE_ROLE_TAXONOMY_VERSION
} from "./service-role";
import { trackerCatalogMetadata } from "./tracker-catalog";

/**
 * Server-only: what a scan run TODAY is ranked against.
 *
 * The measurement cohort of a fresh production scan, and whether the committed
 * corpus artifact holds a usable cohort for it. /status uses this to say
 * truthfully how a visitor's own scan will be ranked; that sentence used to be
 * a verbatim claim ("no cohort exists yet ... fixed thresholds") that was true
 * only in the gap between a methodology bump and the next corpus refresh, and
 * one refresh would have made the page false with every guard green.
 *
 * This module deliberately aliases the ACTIVE producer constants, which is the
 * opposite choice from CURRENT_MEASUREMENT_LINE_METHODOLOGY's reviewed frozen
 * literal in corpus-cohort.ts. That literal decides which cohorts may take over
 * the PUBLISHED aggregate, so an epoch move must not silently restate it. This
 * module answers "what will a scan run right now record", so it must move with
 * the epoch, or it becomes the exact stale claim it exists to prevent. The
 * parity test in current-scan-cohort.test.ts binds these components to a report
 * built by the real Node producer, so a restatement here cannot drift from what
 * production actually emits.
 */
export function currentScanCohortComponents(gpc: boolean): CorpusCohortIdentityComponents {
  return {
    schemaVersion: SCAN_REPORT_V2_SCHEMA_VERSION,
    schemaRevision: SCAN_REPORT_V2_SCHEMA_REVISION_2,
    methodologyVersion: NODE_SCAN_REPORT_V2_R2_METHODOLOGY_VERSION,
    methodologyOrigin: "recorded",
    // The literal the Node producer records as provenance.observer
    // (lib/scan-result-v2-r2-builder.ts); pinned to it by the parity test.
    producer: "node-playwright",
    gpc,
    trackerCatalogDigest: trackerCatalogMetadata.digest,
    trackerCatalogOrigin: "recorded",
    serviceRoleTaxonomyVersion: SERVICE_ROLE_TAXONOMY_VERSION,
    serviceRoleTaxonomyDigest: SERVICE_ROLE_TAXONOMY_DIGEST,
    metricContractVersion: METRIC_CONTRACT_VERSION,
    metricContractDigest: METRIC_CONTRACT_DIGEST
  };
}

/** Public cohort key a fresh scan's report page looks up in corpus-stats.json. */
export function currentScanCohortId(gpc: boolean): string {
  return corpusCohortIdForIdentity(currentScanCohortComponents(gpc));
}

/**
 * Sites in the committed cohort a fresh scan requesting this GPC state ranks
 * against, or null when that page would fall back to fixed thresholds. Mirrors
 * the report page's own lookup (report-findings.ts): exact-id cohort selection,
 * then the CORPUS_MIN_SAMPLE honesty gate. Per-metric denominators can still be
 * narrower; callers must not claim more than cohort-level usability from this.
 */
export function currentScanUsableCohortSampleSize(
  corpus: CorpusStats | null,
  gpc: boolean
): number | null {
  const cohort = selectCorpusStatsCohort(corpus, currentScanCohortId(gpc));
  return corpusIsUsable(cohort) ? cohort.sampleSize : null;
}

/**
 * The /status sentence about how a scan run today is ranked, derived from the
 * committed corpus artifact instead of pinned as prose. Both requested-GPC
 * states are covered because the requested signal is part of the cohort key and
 * is the one tuple component a visitor's own choice changes.
 *
 * `aggregateCohortId` is the cohort whose site count the surrounding paragraph
 * reports. When a fresh scan's usable cohort IS that cohort, saying "not
 * against this number" would be false, so that state gets its own wording.
 */
export function currentScanRankingSentence(
  corpus: CorpusStats | null,
  aggregateCohortId: string | null
): string {
  const arms = [
    { gpc: false, phrase: "a visit that did not request GPC" },
    { gpc: true, phrase: "a visit that requested GPC" }
  ].map((arm) => ({
    ...arm,
    id: currentScanCohortId(arm.gpc),
    sampleSize: currentScanUsableCohortSampleSize(corpus, arm.gpc)
  }));
  const floor = `${CORPUS_MIN_SAMPLE}-site floor`;
  if (arms.every((arm) => arm.sampleSize === null)) {
    return (
      "A scan run today records the current methodology, and no committed cohort " +
      `matching its exact tuple, under either requested-GPC state, has reached the ${floor}, ` +
      "so it is ranked against fixed thresholds and not against this number."
    );
  }
  const clauses = arms.map((arm) => {
    if (arm.sampleSize === null) {
      return (
        `${arm.phrase} is ranked against fixed thresholds, because no committed ` +
        `cohort matching its exact tuple has reached the ${floor}`
      );
    }
    if (arm.id === aggregateCohortId) {
      return `${arm.phrase} is ranked against this same cohort`;
    }
    return (
      `${arm.phrase} is ranked against its own committed ` +
      `${arm.sampleSize.toLocaleString("en-US")}-site cohort, not against this number`
    );
  });
  return (
    "A scan run today records the current methodology, and its ranking follows " +
    `the same rule: ${clauses.join("; ")}.`
  );
}

/**
 * The committed corpus artifact, read the fail-closed way its consumers read
 * it: an unreadable or invalid artifact is null, which every caller above
 * treats as "no usable cohort", exactly as the report page's fetch does.
 */
export async function loadCommittedCorpusStats(): Promise<CorpusStats | null> {
  try {
    const raw = await readFile(path.join(process.cwd(), "public", "corpus-stats.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isCorpusStats(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
