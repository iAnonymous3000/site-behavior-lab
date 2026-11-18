import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { corpusRollupMembership, createCorpusStatsAccumulator } from "../corpus-stats-builder";
import { readCorrectionsLedgerReportIds } from "../corrections-ledger";
import { preferCorpusRepresentative } from "../corpus-representative";
import {
  DECIDED_PACKAGE_INPUT_FILES,
  pruneStaticReportsWithCorrections,
  readDecidedPackageReportIds
} from "../prune-static-reports";
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
  const sites = new Map<string, Set<string>>();
  const representatives = new Map<string, { id: string; scannedAt: string; cohortId: string }>();
  let newest = 0;
  for (const id of await listStaticReportCandidateIds(reportsDir)) {
    const read = await readStaticReportBundle(reportsDir, id);
    assert.equal(read.outcome, "found", id);
    if (read.outcome !== "found") continue;
    const view = toReportView(read.stored);
    newest = Math.max(newest, Date.parse(view.latestRunAt ?? view.scannedAt ?? "") || 0);
    const membership = corpusRollupMembership(id, view);
    if (membership) {
      const cohortSites = sites.get(membership.identity.id) ?? new Set<string>();
      cohortSites.add(membership.siteKey);
      sites.set(membership.identity.id, cohortSites);
      const key = `${membership.identity.id}|${membership.siteKey}`;
      const existing = representatives.get(key);
      if (!existing || preferCorpusRepresentative({ id, scannedAt: membership.scannedAt }, existing)) {
        representatives.set(key, { id, scannedAt: membership.scannedAt, cohortId: membership.identity.id });
      }
    }
    accumulator.add(id, view);
  }
  const ids = await listStaticReportCandidateIds(reportsDir);
  return { stats: accumulator.finish(), used: accumulator.cohortIdsTheSelectionUses(), sites, representatives, ids, newest };
}

type Aggregate = Awaited<ReturnType<typeof aggregateOf>>;

/**
 * One scratch copy of the committed corpus pruned as the workflow prunes it,
 * and one pruned the same way with no count cap. Computed once for the tests
 * below, since each prune walks every committed report.
 */
let prunes: Promise<{
  before: Aggregate;
  capped: Aggregate;
  tight: Aggregate;
  uncapped: Aggregate;
  removed: number;
  remaining: Set<string>;
}> | null = null;

function prunedCopies() {
  prunes ??= (async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "sbl-corpus-retention-"));
    try {
      const prune = async (name: string, maxCount: number | null) => {
        const reportsDir = path.join(scratch, name);
        await cp(path.join(process.cwd(), "public", "reports"), reportsDir, { recursive: true });
        const before = await aggregateOf(reportsDir);
        const defaults = await cliDefaults();
        // A week after the newest report: everything older has aged out
        // unless retention protects it.
        const { removed } = await pruneStaticReportsWithCorrections(
          reportsDir,
          path.join(process.cwd(), "public", "corrections.json"),
          {
            maxAgeMs: defaults.maxAgeDays * DAY_MS,
            maxCount: maxCount ?? defaults.maxCount,
            keepPerSite: defaults.keepPerSite,
            now: before.newest + (defaults.maxAgeDays + 1) * DAY_MS
          },
          DECIDED_PACKAGE_INPUT_FILES.map((file) => path.join(process.cwd(), file))
        );
        return {
          before,
          after: await aggregateOf(reportsDir),
          removed: removed.length,
          remaining: new Set(await listStaticReportCandidateIds(reportsDir))
        };
      };
      const capped = await prune("capped", null);
      const uncapped = await prune("uncapped", Number.MAX_SAFE_INTEGER);
      // The tightest cap the pins and the last-trimmed tier still fit under:
      // every other protected report is trimmed, so a cohort the selection
      // depends on but the tier leaves out cannot hide behind spare room.
      const pins = new Set([
        ...(await readCorrectionsLedgerReportIds(path.join(process.cwd(), "public", "corrections.json"))),
        ...(await Promise.all(DECIDED_PACKAGE_INPUT_FILES.map((file) => readDecidedPackageReportIds(path.join(process.cwd(), file))))).flatMap(
          (ids) => [...ids]
        )
      ]);
      const before = capped.before;
      const tier = [...before.representatives.values()].filter((entry) => before.used.has(entry.cohortId) && !pins.has(entry.id));
      const tight = await prune("tight", before.ids.filter((id) => pins.has(id)).length + tier.length);
      return {
        before,
        capped: capped.after,
        tight: tight.after,
        uncapped: uncapped.after,
        removed: capped.removed,
        remaining: capped.remaining
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  })();
  return prunes;
}

test("a prune of the committed corpus keeps every site of the cohorts the aggregate uses, and every census input", async () => {
  const { before, capped, removed, remaining } = await prunedCopies();
  assert.ok(before.used.size > 0, "the committed corpus has no aggregate, so this guard checked nothing");
  assert.equal(capped.stats.primaryCohortId, before.stats.primaryCohortId);
  for (const id of before.used) {
    const was = before.stats.cohorts.find((cohort) => cohort.id === id);
    const is = capped.stats.cohorts.find((cohort) => cohort.id === id);
    assert.ok(was, id);
    assert.equal(
      is?.sampleSize ?? 0,
      was.sampleSize,
      `the prune (${removed} removed) shrank cohort ${id}, which the aggregate selection uses`
    );
  }

  for (const file of DECIDED_PACKAGE_INPUT_FILES) {
    const { reportIds } = JSON.parse(await readFile(path.join(process.cwd(), file), "utf8")) as { reportIds: string[] };
    assert.ok(reportIds.length > 0, `${file} cites nothing`);
    for (const id of reportIds) assert.ok(remaining.has(id), `the prune removed ${id}, which ${file} cites`);
  }
});

/**
 * The count cap may trim reports outside the last-trimmed tier, and an
 * off-line cohort may shrink. What it may not do is move the selection:
 * the cohort it picks, the cohorts it consults on the way, and each of
 * their site sets, which the line handoffs compare, come out as they do
 * when no count cap trims anything.
 */
test("the count cap's trims outside the last-trimmed tier leave the selection's result as it is without them", async () => {
  const { capped, tight, uncapped } = await prunedCopies();
  for (const [cap, pruned] of [["the workflow's cap", capped], ["the tightest cap the tier fits", tight]] as const) {
    assert.equal(pruned.stats.primaryCohortId, uncapped.stats.primaryCohortId, cap);
    assert.deepEqual([...pruned.used].sort(), [...uncapped.used].sort(), cap);
    for (const id of uncapped.used) {
      assert.deepEqual(
        [...(pruned.sites.get(id) ?? [])].sort(),
        [...(uncapped.sites.get(id) ?? [])].sort(),
        `${cap} changed the sites of cohort ${id}, which the selection consults`
      );
    }
  }
});
