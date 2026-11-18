import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCorpusStatsAccumulator } from "../corpus-stats-builder";
import { DECIDED_PACKAGE_INPUT_FILES, pruneStaticReportsWithCorrections } from "../prune-static-reports";
import { toReportView } from "../scan-report-view";
import { listStaticReportCandidateIds, readStaticReportBundle } from "../static-report-files";

/**
 * Retention against the committed corpus, run the way the scan workflow runs
 * it (lib/prune-static-reports-cli.ts) on a scratch copy.
 *
 * What it holds is what the aggregate needs, not that every cohort survives:
 * the count cap is the storage bound and may still shrink an off-line cohort,
 * oldest first. The cohorts the aggregate selection consults must keep every
 * eligible site, because the published aggregate, and whether a new line may
 * take it over, are decided from exactly their site sets. When this fails, the
 * protected representatives of those cohorts no longer fit under the cap: the
 * storage bound itself needs a decision, not this test.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

async function cliDefaults(): Promise<{ maxAgeDays: number; maxCount: number; keepPerSite: number }> {
  // Read from the CLI source, so the scratch prune uses the workflow's policy
  // and a change to it shows up here rather than in a silent mismatch.
  const source = await readFile(path.join(process.cwd(), "lib", "prune-static-reports-cli.ts"), "utf8");
  const literal = (name: string) => {
    const match = new RegExp(`const ${name} = ([0-9_]+);`).exec(source);
    assert.ok(match, `the CLI no longer declares ${name}`);
    return Number(match[1].replaceAll("_", ""));
  };
  return {
    maxAgeDays: literal("DEFAULT_MAX_AGE_DAYS"),
    maxCount: literal("DEFAULT_MAX_COUNT"),
    keepPerSite: literal("DEFAULT_KEEP_PER_SITE")
  };
}

async function aggregateOf(reportsDir: string) {
  const accumulator = createCorpusStatsAccumulator(new Date(0));
  let newest = 0;
  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const read = await readStaticReportBundle(reportsDir, id);
    assert.equal(read.outcome, "found", id);
    if (read.outcome !== "found") continue;
    const view = toReportView(read.stored);
    newest = Math.max(newest, Date.parse(view.latestRunAt ?? view.scannedAt ?? "") || 0);
    accumulator.add(id, view);
  }
  return { stats: accumulator.finish(), used: accumulator.cohortIdsTheSelectionUses(), newest };
}

test("a prune of the committed corpus keeps every site of the cohorts the aggregate uses, and every census input", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "sbl-corpus-retention-"));
  try {
    const reportsDir = path.join(scratch, "reports");
    await cp(path.join(process.cwd(), "public", "reports"), reportsDir, { recursive: true });
    const before = await aggregateOf(reportsDir);
    assert.ok(before.used.size > 0, "the committed corpus has no aggregate, so this guard checked nothing");
    const defaults = await cliDefaults();

    // A week after the newest report: everything older has aged out unless
    // retention protects it.
    const { removed } = await pruneStaticReportsWithCorrections(
      reportsDir,
      path.join(process.cwd(), "public", "corrections.json"),
      {
        maxAgeMs: defaults.maxAgeDays * DAY_MS,
        maxCount: defaults.maxCount,
        keepPerSite: defaults.keepPerSite,
        now: before.newest + (defaults.maxAgeDays + 1) * DAY_MS
      },
      DECIDED_PACKAGE_INPUT_FILES.map((file) => path.join(process.cwd(), file))
    );

    const after = await aggregateOf(reportsDir);
    assert.equal(after.stats.primaryCohortId, before.stats.primaryCohortId);
    for (const id of before.used) {
      const was = before.stats.cohorts.find((cohort) => cohort.id === id);
      const is = after.stats.cohorts.find((cohort) => cohort.id === id);
      assert.ok(was, id);
      assert.equal(
        is?.sampleSize ?? 0,
        was.sampleSize,
        `the prune (${removed.length} removed) shrank cohort ${id}, which the aggregate selection uses`
      );
    }

    const remaining = new Set(await listStaticReportCandidateIds(reportsDir));
    for (const file of DECIDED_PACKAGE_INPUT_FILES) {
      const { reportIds } = JSON.parse(await readFile(path.join(process.cwd(), file), "utf8")) as { reportIds: string[] };
      assert.ok(reportIds.length > 0, `${file} cites nothing`);
      for (const id of reportIds) assert.ok(remaining.has(id), `the prune removed ${id}, which ${file} cites`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
