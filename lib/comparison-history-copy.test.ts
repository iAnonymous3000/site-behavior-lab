import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { siteProfileComparableVisitsNote } from "./comparable-visits-note";
import { COMPARISON_HISTORY_IDENTITY_SENTENCES } from "./comparison-history-copy";
import { loadCorpusOverview } from "./corpus-overview";
import { comparisonHistoryKeyEra } from "./temporal-deltas";

const root = process.cwd();
const source = (file: string): string => readFileSync(path.join(root, file), "utf8");

test("each era's identity sentence states its own pairing rule, not the other era's", () => {
  const v1 = COMPARISON_HISTORY_IDENTITY_SENTENCES.v1;
  const v2 = COMPARISON_HISTORY_IDENTITY_SENTENCES.v2;
  // The v1 key BINDS the Brave-list source and list count (mutation-verified
  // against the pairing fingerprint) and lets only the snapshot date drift.
  assert.match(v1, /^This v1 history holds /);
  assert.match(v1, /Brave-list source and list count constant/);
  assert.doesNotMatch(v1, /omits/);
  // The v2/r2 key omits the ad-block source, list count and snapshot
  // entirely, so its sentence may not claim they are held constant.
  assert.match(v2, /^This v2\/r2 history holds /);
  assert.doesNotMatch(v2, /Brave-list source|list count/);
  assert.notEqual(v1, v2);

  const v1Note = siteProfileComparableVisitsNote("v1");
  const v2Note = siteProfileComparableVisitsNote("v2");
  assert.ok(v1Note.startsWith(v1), "the v1 note must open with the shared v1 identity sentence");
  assert.ok(v2Note.startsWith(v2), "the v2 note must open with the shared v2 identity sentence");
  // Only the v2 note may claim the omission; stating it over v1 pairs is the
  // exact defect this module closes.
  assert.match(v2Note, /deliberately omits the ad-block source, list count and snapshot/);
  assert.doesNotMatch(v1Note, /omits/);
  assert.match(v1Note, /does not hold the filter-list snapshot date\s+constant/);
  // Neither era's delta is blocking evidence, and both notes must say so.
  for (const note of [v1Note, v2Note]) {
    assert.match(note, /not evidence that blocking behaviour\s+changed/);
    assert.match(note, /site experiments, ad rotation, caching or bot detection/);
  }
});

test("both surfaces render the shared identity sentences, never a local restatement", () => {
  const gallery = source("app/_components/static-gallery.tsx");
  const profile = source("app/sites/[domain]/page.tsx");
  assert.match(gallery, /COMPARISON_HISTORY_IDENTITY_SENTENCES\.v1/);
  assert.match(gallery, /COMPARISON_HISTORY_IDENTITY_SENTENCES\.v2/);
  assert.match(profile, /siteProfileComparableVisitsNote\(era\)/);
  // The profile must render one note per era its pairs actually carry, keyed
  // by the entry field the corpus loader derives from the pairing key itself.
  assert.match(profile, /entry\.comparisonHistoryEra === era/);
  // Neither surface may restate what an identity holds constant in local
  // prose: that is exactly how the profile's note drifted onto the v2 rule
  // while the gallery stayed correct.
  for (const [name, text] of [
    ["static-gallery", gallery],
    ["site profile", profile]
  ] as const) {
    assert.doesNotMatch(
      text,
      /history holds the route/,
      `${name} must not restate an identity sentence`
    );
    assert.doesNotMatch(
      text,
      /deliberately omits the ad-block/,
      `${name} must not restate the omission rule`
    );
  }
});

test("the note selected for the committed corpus's pairs matches their schema era", async () => {
  const { entries } = await loadCorpusOverview();
  const paired = entries.filter((entry) => entry.sinceLastScan);
  // The empty set must assert: an empty pass would be indistinguishable from
  // this guard checking nothing. If a prune legitimately removes every pair,
  // re-derive the guard rather than skipping it.
  assert.ok(
    paired.length > 0,
    "no comparable-visit pair exists in the committed corpus for this guard to execute against"
  );
  for (const entry of paired) {
    // The era travels with the delta and must agree with the paired report's
    // actual wire schema, derived independently here: only v1 reports carry
    // v1 keys, and only v2/r2 reports can enter the v2 history cohort.
    const expectedEra = entry.schemaVersion === 2 ? "v2" : "v1";
    assert.equal(entry.comparisonHistoryEra, expectedEra, entry.id);
    if (expectedEra === "v2") assert.equal(entry.schemaRevision, 2, entry.id);
    const note = siteProfileComparableVisitsNote(expectedEra);
    if (expectedEra === "v1") {
      assert.match(note, /Brave-list source and list count constant/, entry.id);
      assert.doesNotMatch(note, /deliberately omits/, entry.id);
    } else {
      assert.match(note, /deliberately omits the ad-block source, list count and snapshot/, entry.id);
    }
  }
});

test("the era parser agrees with the key producer in both directions", () => {
  // Round-trip through the real key builder is covered by the corpus check
  // above; these pin the parser's refusal branches.
  assert.equal(comparisonHistoryKeyEra(null), null);
  assert.equal(comparisonHistoryKeyEra("temporal-pairing|something"), null);
  assert.equal(comparisonHistoryKeyEra("comparison-history-key-v1|v1-comparison-history:x"), "v1");
  assert.equal(comparisonHistoryKeyEra("comparison-history-key-v2|v2-r2-comparison-history:x"), "v2");
});
