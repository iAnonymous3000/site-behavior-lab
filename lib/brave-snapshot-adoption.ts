import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical-json";
import { NODE_ADBLOCK_ENGINE_VERSION, recordedAdblockEngineVersion } from "./legacy-methodology";
import type { StoredScanReport } from "./scan-report-reader";
import {
  braveListMeasurementIdentity,
  NODE_R2_CURRENT_ADBLOCK_IDENTITY
} from "./scan-report-v2-r2-producer-contract";
import type { ScanConditions } from "./types";

/**
 * Answer one question the refresh workflow could not previously ask:
 * does the pinned Node producer identity still describe the vendored snapshot?
 *
 * WHY THIS EXISTS. `scripts/fetch-brave-lists.mjs` overwrites the snapshot;
 * `NODE_R2_CURRENT_ADBLOCK_IDENTITY` is a source literal no workflow may edit,
 * because minting a measurement identity is a human declaration in this
 * project. When upstream rules move, the two disagree, and the only place that
 * showed up was three unit tests failing with `unknown Node producer tuple`,
 * `redaction-not-idempotent`, and a durable job that never published -- a
 * symptom chain that reads as a redaction bug and sends the next reader hunting
 * one. Naming the condition directly turns that cascade into one sentence.
 *
 * NOT A SECOND DEFINITION OF IDENTITY. The comparison routes through
 * `braveListMeasurementIdentity`, the same function the producer tuple uses, so
 * this cannot drift from the rule it reports on.
 */

export type BraveSnapshotIdentity = {
  source: string;
  lists: number;
  fetchedAt: string;
  manifestDigest: string;
  engineVersion: string;
};

export type BraveSnapshotAdoption = {
  /** True when a human must declare a new measurement identity before the snapshot can publish. */
  adoptionRequired: boolean;
  reason: "identical" | "rules-moved" | "snapshot-unreadable";
  snapshot: BraveSnapshotIdentity | null;
  pinned: BraveSnapshotIdentity;
};

export const BRAVE_SNAPSHOT_METADATA_PATH = path.join(
  "lib",
  "adblock-wasm",
  "brave-default-filters.meta.json"
);

/**
 * The identity the scanner would stamp on a report built from the snapshot on
 * disk right now.
 *
 * Deliberately mirrors `lib/scan-result-v2-r2-builder.ts`'s
 * `{ ...adblockListMeta(), engineVersion: NODE_ADBLOCK_ENGINE_VERSION }`
 * without importing the engine module, which would pull the WASM loader into
 * every consumer of this check. `brave-snapshot-adoption.test.ts` asserts the
 * two constructions agree, so the mirror cannot drift silently.
 */
export function readBraveSnapshotIdentity(rootDir = process.cwd()): BraveSnapshotIdentity | null {
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(path.join(rootDir, BRAVE_SNAPSHOT_METADATA_PATH), "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const { sourceCount, fetchedAt, manifestDigest } = meta as Record<string, unknown>;
  if (
    !Number.isSafeInteger(sourceCount) ||
    (sourceCount as number) <= 0 ||
    typeof fetchedAt !== "string" ||
    typeof manifestDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifestDigest)
  ) {
    return null;
  }
  return {
    source: "Brave default ad-block lists",
    lists: sourceCount as number,
    fetchedAt,
    manifestDigest,
    engineVersion: NODE_ADBLOCK_ENGINE_VERSION
  };
}

export function compareBraveSnapshotAdoption(
  snapshot: BraveSnapshotIdentity | null,
  pinned: BraveSnapshotIdentity = NODE_R2_CURRENT_ADBLOCK_IDENTITY as BraveSnapshotIdentity
): BraveSnapshotAdoption {
  if (snapshot === null) {
    return { adoptionRequired: true, reason: "snapshot-unreadable", snapshot: null, pinned };
  }
  const same = measuresIdentically(snapshot, pinned);
  return {
    adoptionRequired: !same,
    reason: same ? "identical" : "rules-moved",
    snapshot,
    pinned
  };
}

/** The producer tuple's comparison: `braveListMeasurementIdentity` on both sides. */
function measuresIdentically(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalJson(braveListMeasurementIdentity(a)) === canonicalJson(braveListMeasurementIdentity(b));
}

/** A committed report's wire generation, as `readStoredScanReport` classifies it. */
export type BraveAdoptionReportGeneration = "v1" | "v2-r1" | "v2-r2";

export const BRAVE_ADOPTION_REPORT_GENERATIONS: readonly BraveAdoptionReportGeneration[] = Object.freeze([
  "v1",
  "v2-r1",
  "v2-r2"
]);

export function storedReportGeneration(stored: StoredScanReport): BraveAdoptionReportGeneration {
  if (stored.schemaVersion === 1) return "v1";
  return stored.schemaRevision === 1 ? "v2-r1" : "v2-r2";
}

/**
 * Whether any run of a committed report was measured under `identity`.
 *
 * Each generation is read through the fields it records, and every comparison
 * goes through `measuresIdentically`, the rule `compareBraveSnapshotAdoption`
 * and the producer tuple apply. v2 (both revisions) records the whole identity
 * in `toolchain.adblock`, so it compares as recorded.
 *
 * v1 records neither the manifest nor an engine field. `conditions.adblock`
 * carries source, lists and `fetchedAt`, and the engine appears only inside the
 * methodology token. There `fetchedAt` is the only witness of the rule bytes:
 * `scripts/fetch-brave-lists.mjs` stamps one timestamp per fetch and writes the
 * manifest with it, so an equal `fetchedAt` names the fetch that produced
 * `identity.manifestDigest`. Only after that proof does the lift borrow the
 * manifest; source, lists and engine still go through the one comparison.
 *
 * THE v1 FIGURE IS A FLOOR. A byte-identical refetch moves `fetchedAt` without
 * moving the identity, and a v1 run whose methodology names no engine proves
 * nothing, so both are left uncounted rather than guessed.
 */
export function reportCarriesBraveIdentity(stored: StoredScanReport, identity: BraveSnapshotIdentity): boolean {
  if (stored.schemaVersion === 1) {
    const report = stored.report;
    const runs = report.reportType === "comparison" ? [report.baseline, report.variant] : [report];
    return runs.some((run) => legacyRunCarriesBraveIdentity(run.conditions, identity));
  }
  const report = stored.report;
  const runs = report.reportType === "comparison" ? [report.baseline, report.variant] : [report.run];
  return runs.some((run) => run.toolchain.adblock !== null && measuresIdentically(run.toolchain.adblock, identity));
}

function legacyRunCarriesBraveIdentity(conditions: ScanConditions, identity: BraveSnapshotIdentity): boolean {
  const adblock = conditions.adblock;
  if (adblock?.active !== true || adblock.fetchedAt !== identity.fetchedAt) return false;
  return measuresIdentically(
    {
      source: adblock.source,
      lists: adblock.lists,
      fetchedAt: adblock.fetchedAt,
      manifestDigest: identity.manifestDigest,
      // Null when the methodology names no engine, which then matches nothing.
      engineVersion: recordedAdblockEngineVersion(conditions.scannerDisclosure)
    },
    identity
  );
}

export type BraveIdentityReportTally = {
  /** Per generation: reports the typed reader accepted, and how many of those carry the identity. */
  generations: Record<BraveAdoptionReportGeneration, { read: number; matched: number }>;
  /** Report files that did not parse or that the typed reader rejected; never counted as matches. */
  unreadable: number;
};

export function emptyBraveIdentityReportTally(): BraveIdentityReportTally {
  return {
    generations: {
      v1: { read: 0, matched: 0 },
      "v2-r1": { read: 0, matched: 0 },
      "v2-r2": { read: 0, matched: 0 }
    },
    unreadable: 0
  };
}

export function braveIdentityReportsMatched(tally: BraveIdentityReportTally): number {
  return BRAVE_ADOPTION_REPORT_GENERATIONS.reduce((sum, generation) => sum + tally.generations[generation].matched, 0);
}

function formatBraveIdentityReportTally(tally: BraveIdentityReportTally | null): string[] {
  if (tally === null) return ["- Committed reports measured under the outgoing identity: not counted"];
  const generations = BRAVE_ADOPTION_REPORT_GENERATIONS.map((generation) => {
    const { read, matched } = tally.generations[generation];
    return `${generation} ${matched} of ${read}`;
  }).join(", ");
  return [
    `- Committed reports measured under the outgoing identity: **${braveIdentityReportsMatched(tally)}**`,
    `  - By generation (matched of read): ${generations}; ${tally.unreadable} unreadable and not counted.`,
    "  - v1 records no manifest, so a v1 report counts only when its snapshot `fetchedAt` and the engine " +
      "its methodology names both match. The v1 figure is a floor."
  ];
}

/**
 * The exact source literal a maintainer pastes over the pinned constant.
 *
 * Emitting it beats describing it: the alternative is a human transcribing a
 * 64-character digest and an ISO timestamp out of a workflow log by hand, into
 * a value whose whole job is to be exact.
 */
export function formatBraveAdoptionConstant(identity: BraveSnapshotIdentity): string {
  return [
    "export const NODE_R2_CURRENT_ADBLOCK_IDENTITY = Object.freeze({",
    `  source: ${JSON.stringify(identity.source)},`,
    `  lists: ${identity.lists},`,
    `  fetchedAt: ${JSON.stringify(identity.fetchedAt)},`,
    `  manifestDigest: ${JSON.stringify(identity.manifestDigest)},`,
    "  engineVersion: NODE_ADBLOCK_ENGINE_VERSION",
    '} satisfies NonNullable<Toolchain["adblock"]>);'
  ].join("\n");
}

export function formatBraveAdoptionSummary(
  adoption: BraveSnapshotAdoption,
  publishedUnderPinned: BraveIdentityReportTally | null
): string {
  if (adoption.reason === "snapshot-unreadable") {
    return `The vendored snapshot at ${BRAVE_SNAPSHOT_METADATA_PATH} could not be read as a Brave list manifest.`;
  }
  if (!adoption.adoptionRequired) {
    return (
      "The refreshed snapshot measures identically to the pinned Node producer identity " +
      `(manifest ${adoption.pinned.manifestDigest.slice(0, 12)}), so no identity declaration is needed.`
    );
  }

  const snapshot = adoption.snapshot!;
  const lines = [
    "Upstream rules moved, so these bytes are a NEW measurement identity and a human must declare it.",
    "",
    `- Pinned manifest:   \`${adoption.pinned.manifestDigest}\``,
    `- Refreshed manifest: \`${snapshot.manifestDigest}\``,
    ...formatBraveIdentityReportTally(publishedUnderPinned),
    "",
    "Replace `NODE_R2_CURRENT_ADBLOCK_IDENTITY` in `lib/scan-report-v2-r2-producer-contract.ts` with:",
    "",
    "```ts",
    formatBraveAdoptionConstant(snapshot),
    "```",
    ""
  ];
  lines.push(
    "The outgoing production identity must ALSO be frozen as a closed producer row before adoption, " +
    "including every deployed methodology and the no-list variant. Live reports and downloaded copies " +
    "can outlive server retention without appearing in the committed corpus; zero committed reports " +
    "is not evidence that no report was produced. Preserve the exact constants from the outgoing source revision."
  );
  return lines.join("\n");
}
