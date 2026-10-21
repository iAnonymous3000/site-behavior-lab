import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadCorpusOverview } from "../corpus-overview";
import { siteHistoryLookCloserHref } from "../report-site-history";
import { readStoredScanReport } from "../scan-report-reader";
import { toReportView } from "../scan-report-views";
import { siteProfilePath } from "../site-profile";
import { sitePagesBasePath } from "../site-url";

/**
 * The cookie card's Look closer view opens this site's history page at its
 * report table. Over the committed corpus, through the same overview the
 * history pages are generated from: every target is a generated page that
 * lists the report and at least one other, and the view is withheld exactly
 * where the page would list fewer than two. Not pinned to a count, since
 * retention moves the corpus; the synthetic listings in
 * lib/report-site-history.test.ts hold the one-report case whatever it holds.
 */
test("every committed history view opens a generated site history listing this visit and another", async () => {
  const { entries } = await loadCorpusOverview();
  const listedBySite = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.siteKey) listedBySite.set(entry.siteKey, [...(listedBySite.get(entry.siteKey) ?? []), entry.id]);
  }
  const siteByTarget = new Map(
    [...listedBySite.keys()].map((key) => [`${sitePagesBasePath()}${siteProfilePath(key)}/#history`, key])
  );
  const siteById = new Map(entries.map((entry) => [entry.id, entry.siteKey]));

  const dir = path.join(process.cwd(), "public", "reports");
  const files = readdirSync(dir).filter((name) => /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(name));
  assert.ok(files.length > 0, "no committed reports; this test would be vacuous");
  let offered = 0;
  for (const name of files) {
    const id = name.slice(0, -".json".length);
    const read = readStoredScanReport(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
    assert.equal(read.ok, true, `reader rejected committed report ${name}`);
    if (!read.ok) continue;
    const href = await siteHistoryLookCloserHref({ id, view: toReportView(read.stored), committed: true });
    const site = siteById.get(id) ?? null;
    const listed = site ? listedBySite.get(site) ?? [] : [];
    if (href === null) {
      assert.ok(listed.length < 2, `${id}: no history view though ${site}'s history lists ${listed.length} reports`);
      continue;
    }
    assert.equal(siteByTarget.get(href), site, `${id}: ${href} is not the generated history page of ${site}`);
    assert.ok(listed.includes(id) && listed.length >= 2, `${id}: ${href} lists ${listed.length} reports`);
    offered += 1;
  }
  assert.ok(offered > 0, "no committed report offered a history view, so the rule went unchecked");
});
