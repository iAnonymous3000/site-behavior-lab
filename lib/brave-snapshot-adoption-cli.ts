import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  compareBraveSnapshotAdoption,
  formatBraveAdoptionSummary,
  readBraveSnapshotIdentity
} from "./brave-snapshot-adoption";
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
 * Count committed reports whose evidence was measured under one exact Brave
 * manifest.
 *
 * Walks for the key rather than reading a fixed path: a single report, a
 * comparison pair, and a legacy v1 bundle each nest `toolchain` differently,
 * and a path list would be a fourth place that has to know the wire shape.
 */
export async function countReportsUnderManifest(rootDir: string, manifestDigest: string): Promise<number> {
  const reportsDir = path.join(rootDir, "public", "reports");
  let matched = 0;
  for (const reportId of await listStaticReportCandidateIds(reportsDir)) {
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(path.join(reportsDir, `${reportId}.json`), "utf8")) as unknown;
    } catch {
      // An unreadable committed bundle is a real defect, but it is the
      // corpus gates' defect to report. Counting is not the place to fail the
      // refresh, and treating it as a match would overstate the impact.
      continue;
    }
    if (containsManifestDigest(stored, manifestDigest)) matched += 1;
  }
  return matched;
}

function containsManifestDigest(value: unknown, manifestDigest: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsManifestDigest(entry, manifestDigest));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.manifestDigest === manifestDigest) return true;
  return Object.values(record).some((entry) => containsManifestDigest(entry, manifestDigest));
}

async function main(): Promise<void> {
  const args = parseBraveAdoptionCliArgs(process.argv.slice(2));
  const adoption = compareBraveSnapshotAdoption(readBraveSnapshotIdentity(args.rootDir));
  const publishedUnderPinned = adoption.adoptionRequired
    ? await countReportsUnderManifest(args.rootDir, adoption.pinned.manifestDigest)
    : 0;

  const summary = formatBraveAdoptionSummary(adoption, publishedUnderPinned);
  console.log(summary);

  if (args.githubOutput !== null) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      args.githubOutput,
      [
        `adoption_required=${adoption.adoptionRequired}`,
        `adoption_reason=${adoption.reason}`,
        `published_under_pinned=${publishedUnderPinned}`,
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
