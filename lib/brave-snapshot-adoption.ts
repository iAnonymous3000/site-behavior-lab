import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical-json";
import { NODE_ADBLOCK_ENGINE_VERSION } from "./legacy-methodology";
import {
  braveListMeasurementIdentity,
  NODE_R2_CURRENT_ADBLOCK_IDENTITY
} from "./scan-report-v2-r2-producer-contract";

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
  const same =
    canonicalJson(braveListMeasurementIdentity(snapshot)) ===
    canonicalJson(braveListMeasurementIdentity(pinned));
  return {
    adoptionRequired: !same,
    reason: same ? "identical" : "rules-moved",
    snapshot,
    pinned
  };
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
  publishedUnderPinned: number
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
    `- Committed r2 reports published under the pinned identity: **${publishedUnderPinned}**`,
    "",
    "Replace `NODE_R2_CURRENT_ADBLOCK_IDENTITY` in `lib/scan-report-v2-r2-producer-contract.ts` with:",
    "",
    "```ts",
    formatBraveAdoptionConstant(snapshot),
    "```",
    ""
  ];
  lines.push(
    publishedUnderPinned > 0
      ? "Reports were published under the outgoing identity, so it must ALSO be frozen as a " +
          "`HISTORICAL_R2_LISTS_<date>_ADBLOCK_IDENTITY` row and added to the historical tuple " +
          "families, or every one of those reports becomes unreadable through the producer contract."
      : "No committed report carries the outgoing identity, so freezing it would guard an empty " +
          "set. Do not add a historical row for it."
  );
  return lines.join("\n");
}
