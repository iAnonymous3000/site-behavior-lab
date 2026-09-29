import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  braveIdentityReportsMatched,
  compareBraveSnapshotAdoption,
  emptyBraveIdentityReportTally,
  formatBraveAdoptionSummary,
  readBraveSnapshotIdentity,
  reportCarriesBraveIdentity,
  storedReportGeneration,
  type BraveIdentityReportTally,
  type BraveSnapshotIdentity
} from "./brave-snapshot-adoption";
import { readStoredScanReport, type ReadStoredScanReportResult } from "./scan-report-reader";
import { listStaticReportCandidateIds } from "./static-report-files";

/**
 * Report whether the vendored Brave snapshot still matches the pinned Node
 * producer identity, and what a maintainer must do when it does not.
 *
 * Exits 0 either way ON PURPOSE. "Upstream published new rules" is the ordinary
 * weekly outcome, not a failure, and the refresh workflow needs to branch on it
 * rather than die on it. The caller decides what the answer means; `--require-
 * adoption` and `--forbid-adoption` are available when a caller wants it to be
 * an assertion.
 */

export type BraveAdoptionCliArgs = {
  rootDir: string;
  mode: "report" | "require-adoption" | "forbid-adoption";
  githubOutput: string | null;
};

export function parseBraveAdoptionCliArgs(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env
): BraveAdoptionCliArgs {
  let mode: BraveAdoptionCliArgs["mode"] = "report";
  for (const argument of args) {
    if (argument === "--require-adoption") {
      if (mode !== "report") throw new Error("Choose at most one of --require-adoption and --forbid-adoption.");
      mode = "require-adoption";
    } else if (argument === "--forbid-adoption") {
      if (mode !== "report") throw new Error("Choose at most one of --require-adoption and --forbid-adoption.");
      mode = "forbid-adoption";
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return {
    rootDir: path.resolve(process.cwd()),
    mode,
    githubOutput: env.GITHUB_OUTPUT ?? null
  };
}

/**
 * Count committed reports measured under one Brave-list identity, per wire
 * generation.
 *
 * Reads each report through `readStoredScanReport`, so a generation is what the
 * typed reader says it is, and `reportCarriesBraveIdentity` decides the match
 * through the fields that generation records. Matching a bare `manifestDigest`
 * anywhere in the JSON, as this once did, counted zero of the 95 v1 reports
 * committed under the outgoing snapshot on 2026-09-28: v1 never records one.
 */
export async function countReportsUnderIdentity(
  rootDir: string,
  identity: BraveSnapshotIdentity
): Promise<BraveIdentityReportTally> {
  const reportsDir = path.join(rootDir, "public", "reports");
  const tally = emptyBraveIdentityReportTally();
  for (const reportId of await listStaticReportCandidateIds(reportsDir)) {
    let read: ReadStoredScanReportResult;
    try {
      read = readStoredScanReport(JSON.parse(await readFile(path.join(reportsDir, `${reportId}.json`), "utf8")) as unknown);
    } catch {
      read = { ok: false, error: "invalid" };
    }
    if (!read.ok) {
      // An unreadable committed bundle is a real defect, but it is the
      // corpus gates' defect to report. Counting is not the place to fail the
      // refresh, and treating it as a match would overstate the impact, so it
      // is disclosed as unreadable instead.
      tally.unreadable += 1;
      continue;
    }
    const counts = tally.generations[storedReportGeneration(read.stored)];
    counts.read += 1;
    if (reportCarriesBraveIdentity(read.stored, identity)) counts.matched += 1;
  }
  return tally;
}

async function main(): Promise<void> {
  const args = parseBraveAdoptionCliArgs(process.argv.slice(2));
  const adoption = compareBraveSnapshotAdoption(readBraveSnapshotIdentity(args.rootDir));
  const publishedUnderPinned = adoption.adoptionRequired
    ? await countReportsUnderIdentity(args.rootDir, adoption.pinned)
    : null;

  const summary = formatBraveAdoptionSummary(adoption, publishedUnderPinned);
  console.log(summary);

  if (args.githubOutput !== null) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      args.githubOutput,
      [
        `adoption_required=${adoption.adoptionRequired}`,
        `adoption_reason=${adoption.reason}`,
        `published_under_pinned=${publishedUnderPinned === null ? 0 : braveIdentityReportsMatched(publishedUnderPinned)}`,
        "adoption_summary<<SBL_ADOPTION_EOF",
        summary,
        "SBL_ADOPTION_EOF",
        ""
      ].join("\n")
    );
  }

  if (args.mode === "require-adoption" && !adoption.adoptionRequired) {
    console.error("Expected the refreshed snapshot to need a new measurement identity; it does not.");
    process.exitCode = 1;
  }
  if (args.mode === "forbid-adoption" && adoption.adoptionRequired) {
    console.error(
      "The pinned Node producer identity does not describe the committed Brave snapshot. " +
        "A refresh must carry the new snapshot AND the pinned constant in one commit."
    );
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
