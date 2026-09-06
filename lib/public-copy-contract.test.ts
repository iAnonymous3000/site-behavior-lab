import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { entryEligibleForCorpusRollups, loadCorpusOverview } from "./corpus-overview";
import { SITE_TRUST_LINKS } from "./site-navigation";
import { buildCategoryEvidencePages } from "./directory-view";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

test("public corpus copy describes current retention and correction-ledger pins", () => {
  const files = [
    "README.md",
    "app/_components/report-page-context.tsx",
    "app/directory/directory-index.tsx",
    "app/_components/site-evidence-table.tsx",
    "app/categories/[category]/page.tsx",
    "app/privacy/page.tsx",
    "app/methodology/page.tsx"
  ];
  const combined = files.map(source).join("\n");
  assert.doesNotMatch(combined, /permanent public evidence|permanent site artifacts|complete published evidence timeline|complete report history|deliberately permanent evidence/i);
  assert.match(combined, /currently retained/i);
  assert.match(source("README.md"), /reports cited by the corrections ledger are retention-pinned/i);
  assert.match(source("app/privacy/page.tsx"), /reports cited by[\s\S]*the corrections ledger are pinned/i);
});

test("catalog copy scopes official references to entity identity, not suffixes or categories", () => {
  const page = source("app/catalog/page.tsx");
  const provenance = source("lib/tracker-catalog-provenance.ts");
  assert.match(page, /identifies the named entity or product only/);
  assert.match(page, /not presented as a[\s\S]*citation for every suffix/);
  assert.match(provenance, /may not list this suffix, prove the domain mapping, or support the functional category/);
});

test("catalog and project trust surfaces are linked from the site footer", () => {
  // The one shell renders the one shared list, so the routes are guaranteed by
  // membership rather than by three copies of the same grep. Those greps were
  // why /about/ could ship absent from two of the three former footers: each
  // one only ever asserted the routes it already had.
  for (const route of ["/catalog/", "/status/", "/security/", "/corrections/"]) {
    assert.ok(
      SITE_TRUST_LINKS.some((link) => link.href === route),
      `${route} must stay in the shared trust-link set`
    );
  }
  assert.match(
    source("app/_components/site-chrome.tsx"),
    /SITE_TRUST_LINKS/,
    "the site shell must render the shared set"
  );
});

/**
 * The directory and the category pages publish the same facts, through one
 * table and one row mapper.
 *
 * They were two independent card grids before, and they disagreed: /directory/
 * withheld a cookie count it could not vouch for ("Not measured") while the
 * category page published the bare number for the same report. That is this
 * repository's most-filed defect shape -- one contract restated in two places,
 * each internally consistent and disagreeing with the other -- so the shared
 * path is pinned rather than left to convention.
 */
test("both site listings render the shared evidence table, not their own grid", () => {
  // The directory renders the table through its search controls, which own
  // the query the table filters by; the category page renders it directly.
  const surfaces = ["app/directory/directory-index.tsx", "app/categories/[category]/page.tsx"];
  for (const file of surfaces) {
    const contents =
      file === "app/directory/directory-index.tsx"
        ? source(file) + source("app/directory/directory-controls.tsx")
        : source(file);
    assert.match(contents, /<SiteEvidenceTable/, `${file} does not render the shared table`);
    assert.match(contents, /siteEvidenceRow\(/, `${file} does not build rows through the shared mapper`);
    // The cookie count is the field the two grids disagreed on. Neither surface
    // may format it itself again.
    assert.doesNotMatch(
      contents,
      /thirdPartyCookies\.toLocaleString\(\)/,
      `${file} formats a cookie count outside the shared row mapper`
    );
  }
  const mapper = source("lib/site-evidence-row.ts");
  assert.match(mapper, /cookieEvidenceComplete: report\.cookieEvidenceComplete/);
  assert.match(
    source("app/_components/site-evidence-table.tsx"),
    /row\.cookieEvidenceComplete \? \(\s*row\.thirdPartyCookies\.toLocaleString\(\)\s*\) : \(/,
    "the one renderer must still withhold a cookie count it cannot vouch for"
  );
});

test("public metric copy keeps request rows and distinct service entities separate", () => {
  const home = source("app/site-behavior-app.tsx");
  // The rows moved from card grids in directory-index.tsx and the category page
  // to ONE shared table. Both routes are read together with it, so the metric
  // vocabulary is pinned wherever the rows are actually rendered from.
  const evidenceTable = source("app/_components/site-evidence-table.tsx");
  const directory = source("app/directory/directory-index.tsx") + evidenceTable;
  const category = source("app/categories/[category]/page.tsx") + evidenceTable;
  const site = source("app/sites/[domain]/page.tsx");
  const siteFeed = source("app/sites/[domain]/feed.xml/route.ts");
  const glossary = source("app/glossary/page.tsx");
  const overview = source("app/_components/report-overview.tsx");
  const requestTable = source("app/_components/report-tables.tsx");
  const phaseTable = source("app/_components/visit-phases-and-state-changes.tsx");
  const comparison = source("app/_components/comparison-panel.tsx");
  const staticGallery = source("app/_components/static-gallery.tsx");
  const evidenceNavigation = source("lib/report-evidence-navigation.ts");
  const corpusExport = source("lib/corpus-export.ts");
  const readme = source("README.md");
  const methodology = source("app/methodology/page.tsx");

  assert.match(home, /median third-party tracking-service requests per site/);
  assert.match(home, /third-party tracking-service requests/);
  assert.match(home, /!item\.requestEvidenceComplete && "at least "/);
  assert.match(home, /item\.requestCapped \? "recording capped" : "request evidence incomplete"/);
  assert.match(source("app/page.tsx"), /requestEvidenceComplete: entry\.requestEvidenceComplete/);
  assert.match(directory, /third-party tracking-service requests/);
  assert.match(directory, /!row\.requestEvidenceComplete && <span className=\{styles\.bound\}>at least <\/span>/);
  assert.match(category, /Third-party tracking-service requests/);
  assert.match(category, /recorded host matched a reviewed service-catalog suffix/);
  assert.match(site, /Third-party tracking-service requests/);
  assert.match(site, /!latest\.requestEvidenceComplete && "at least "/);
  assert.match(site, /!entry\.requestEvidenceComplete && "at least "/);
  assert.match(site, /its request counts are lower bounds/);
  assert.match(siteFeed, /const requestPrefix = entry\.requestEvidenceComplete \? "" : "at least "/);
  assert.match(siteFeed, /request counts are lower bounds/);
  assert.doesNotMatch(siteFeed, /; counts are lower bounds\./);

  assert.match(glossary, /term: "Catalog-matched request"/);
  assert.match(glossary, /recorded host matched a reviewed service-catalog suffix/);
  assert.match(glossary, /includes first-party and third-party matches/);
  assert.match(glossary, /term: "Third-party tracking-service request"/);
  assert.match(glossary, /term: "Tracking-service entity"/);

  assert.match(overview, /buildRequestComposition\(/);
  assert.doesNotMatch(overview, /Math\.min\(run\.counts\.knownTrackerRequests/);
  assert.match(overview, /distinct catalogued service/);
  assert.match(requestTable, /label: "Catalog matches"/);
  assert.match(requestTable, /recorded host matched a reviewed service-catalog suffix/);
  assert.match(requestTable, /Includes first-party and third-party matches/);
  assert.match(phaseTable, /<th scope="col">Catalog-matched requests<\/th>/);
  assert.match(comparison, /Catalog-matched request and entity deltas/);
  assert.match(staticGallery, /Most retained third-party request rows/);
  assert.match(staticGallery, /Most retained catalog matches/);
  assert.doesNotMatch(staticGallery, /Most third-party</);
  assert.doesNotMatch(staticGallery, /Most catalogued-service requests</);
  assert.match(evidenceNavigation, /label: "Show catalog-matched requests"/);
  // The corpus-percentile section moved from the README into the operations
  // document on 2026-09-02; the sentences it pins moved with it verbatim.
  const operations = source("docs/operations.md");
  assert.match(operations, /builds the v4 corpus artifact/);
  assert.match(operations, /v1 and v2 runs can contribute only to their own exact cohorts/);
  assert.match(methodology, /v1 and v2 runs\s+can contribute only inside their own exact cohorts/);
  assert.doesNotMatch(readme, /every v2 lead run (?:is|are) excluded/);
  assert.doesNotMatch(methodology, /every v2 run (?:is|are) excluded/);

  for (const publicSource of [home, directory, category, site]) {
    assert.doesNotMatch(publicSource, /catalogued tracking requests|catalogued tracking-service requests/);
  }
  for (const publicSource of [glossary, requestTable, comparison, evidenceNavigation, corpusExport]) {
    assert.doesNotMatch(
      publicSource,
      /exact domain matched|own exact catalog match|Known-service and entity deltas|Show known-service requests/
    );
  }
});

test("a rejected URL stays a field problem instead of erasing the homepage", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const home = source("app/site-behavior-app.tsx");
  const submit = hook.slice(hook.indexOf("function handleSubmit"), hook.indexOf("function useExample"));

  // The library (the corpus numbers, the featured cards and the actions) renders
  // whenever no report is loading or loaded. It is deliberately NOT gated on
  // `error`: a failed scan raises the recovery banner beside the library rather
  // than deleting it, and clearUrlNotice only clears urlError, so mirroring a
  // typo into `error` would have announced it twice. The contract is that no
  // URL-field problem can reach either gate.
  assert.match(home, /!loaded && !loading && !activeScanJob && !pendingScanAdmission && \(\s*<EmptyState/);
  assert.match(home, /\{highlights && <CorpusHero highlights=\{highlights\} \/>\}/);
  assert.doesNotMatch(home, /urlError[^\n]*<EmptyState|urlError[^\n]*<CorpusHero/);
  assert.match(submit, /setUrlError\("Enter a public URL to scan/);
  assert.match(submit, /setUrlError\("Enter a valid public URL/);
  assert.doesNotMatch(submit, /setError\(/, "URL validation must not raise the scan-recovery banner");
});

test("a completed cancellation reads as done, not as a failure", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const banner = source("app/_components/scan-recovery-banner.tsx");

  // cancelRuntimeScan resolves with "Scan cancelled."; routing that through setError
  // rendered a successful cancel as a red warning-triangle alert.
  const cancel = hook.slice(hook.indexOf("async function cancelActiveScan"), hook.indexOf("function dismissActiveScan"));
  assert.match(cancel, /setScanNotice\(message\)/);
  assert.doesNotMatch(cancel, /setError\(message\)/);
  assert.match(banner, /const settled = Boolean\(notice\) && !failed/);
});

test("the pre-admission escape does not claim a cancellation it cannot perform", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const home = source("app/site-behavior-app.tsx");

  assert.match(hook, /function stopWaitingForAdmission\(\): void/);
  assert.match(hook, /Stopped waiting for the scanner\. The request may already have been accepted/);
  assert.match(home, /cancelLabel=\{activeScanJob \? "Cancel scan" : "Stop waiting"\}/);
});

test("methodology dates never render a broken Date object", () => {
  const renderer = source("app/_components/report-renderer.tsx");
  // adblockLists.fetchedAt carries the literal "unknown" sentinel when list metadata
  // was unreadable, and imported report files can carry anything.
  assert.match(renderer, /function formatListSnapshot\(value: string\): string/);
  assert.match(renderer, /if \(Number\.isNaN\(date\.getTime\(\)\)\) return "date not recorded"/);
  assert.match(renderer, /fetched\{" "\}\s*\{formatListSnapshot\(displayedRun\.conditions\.adblockLists\.fetchedAt\)\}/);
});

test("the status card never claims one cohort backs every corpus aggregate while the homepage counts several", async () => {
  const status = source("app/status/page.tsx");
  const home = source("app/page.tsx");

  // Both surfaces must count published cohorts from the SAME category pages.
  // The homepage names them via a local; /status inlines the same expression.
  assert.match(home, /new Set\(categoryPages\.map\(\(category\) => category\.cohort\.id\)\)\.size/);
  assert.match(
    status,
    /const categoryCohortCount = new Set\(\s*buildCategoryEvidencePages\(overview\.entries\)\.map\(\(category\) => category\.cohort\.id\)\s*\)\.size;/
  );
  // The count is rendered, never restated as a literal that can go stale.
  assert.match(status, /span \$\{categoryCohortCount\} cohorts in total/);

  // overview.siteCount is the selectPrimaryCorpusCohort winner: newest
  // eligible evidence within the benchmark generation, behind a site floor,
  // a composition veto, and a measurement-line handoff, with size only a
  // tiebreak. The winner can lawfully coexist with a larger cohort (the
  // handoff and the 10% dropped-site allowance are designed to produce that
  // state), so the card may not call it "the largest": that restates the
  // exact selection rule the selector's own docblock rejects.
  assert.doesNotMatch(status, /largest/i);
  assert.match(status, /make up the measurement cohort this\s+page&apos;s aggregates describe/);
  assert.match(status, /This is not the cohort every report page uses/);
  assert.doesNotMatch(status, /the corpus sample a report page/);
  assert.doesNotMatch(status, /the one measurement cohort behind that comparison/);
  assert.doesNotMatch(status, /cohort the corpus aggregates use/);
  assert.doesNotMatch(status, /qualify for corpus aggregates/);

  // The card's date is deliberately scoped to the aggregate cohort: an
  // excluded cohort's refresh must not re-green the aggregates' freshness
  // badge. That scope is a fact about the date, so it must be stated next to
  // the value, and eligible evidence newer than the cohort's must be
  // disclosed from a derived date. An earlier rewrite deleted the one
  // sentence carrying the scope while /directory rendered rows three days
  // newer on the same build, so the disclosure is pinned to the derivation,
  // not just to wording.
  assert.match(status, /<h3>Latest aggregate-cohort evidence<\/h3>/);
  assert.doesNotMatch(status, /Latest eligible corpus evidence/);
  assert.match(
    status,
    /const latestAggregateEvidence = newestEligibleScannedAt\(\s*eligibleEntries\.filter\(\(entry\) => entry\.corpusCohort\.id === aggregateCohortId\)\s*\)/
  );
  assert.match(status, /const latestEligibleEvidence = newestEligibleScannedAt\(eligibleEntries\)/);
  // Every "eligible" claim on the card flows through eligibleEntries, so the
  // eligibility filter itself is load-bearing: without this pin, dropping
  // entryEligibleForCorpusRollups from the filter moves the disclosure onto
  // ineligible evidence while every derivation pin above stays green.
  assert.match(
    status,
    /\(entry\) => entryEligibleForCorpusRollups\(entry\) && Number\.isFinite\(Date\.parse\(entry\.scannedAt\)\)/
  );
  assert.match(status, /Date\.parse\(latestEligibleEvidence\) > Date\.parse\(latestAggregateEvidence\)/);
  assert.match(status, /StatusFreshness timestamp=\{latestAggregateEvidence\}/);
  assert.match(status, /className="status-value">\{formatUtc\(latestAggregateEvidence\)\}/);
  assert.match(status, /the date above is the newest eligible evidence inside that same\s+cohort/);
  assert.match(
    status,
    /\{newerEligibleOutsideAggregate \? `Eligible evidence as new as \$\{formatUtc\(latestEligibleEvidence\)\} sits in cohorts this aggregate excludes; the date above deliberately covers the aggregate cohort only\.` : latestAggregateEvidence !== null \? "Today the aggregate cohort also holds the newest eligible evidence in the committed corpus\." : "Today no committed report is eligible for these aggregates\."\}/
  );

  // Whether most committed pages carry a cohort other than the aggregate's is
  // corpus state, not a timeless fact: a generation flip or one large refresh
  // inverts it with every guard green if the sentence is pinned prose. The
  // page must derive the majority claim and render it conditionally.
  assert.doesNotMatch(status, /a different and older one than this/);
  assert.match(
    status,
    /const mostPagesRankElsewhere = committedPagesOnAggregateCohort \* 2 < overview\.entries\.length/
  );
  assert.match(
    status,
    /cohort\{mostPagesRankElsewhere \? ", and most committed pages carry a different one than this" : ""\}/
  );

  // What a scan run TODAY ranks against is a corpus-plus-epoch state, not a
  // timeless fact. The page once pinned "no cohort exists yet, so it is ranked
  // against fixed thresholds", which was true only in the gap after #158 moved
  // the methodology past the newest refresh; one matched-epoch refresh made
  // the fixed sentence false with every guard green. So the page must RENDER
  // the derived sentence (currentScanRankingSentence, whose two branches are
  // exercised against corpus fixtures in current-scan-cohort.test.ts) and may
  // not restate either branch as prose of its own.
  assert.match(status, /currentScanRankingSentence\(/);
  assert.match(status, /\{scanRankingSentence\}/);
  assert.doesNotMatch(status, /no cohort exists yet/);
  assert.doesNotMatch(status, /ranked against fixed thresholds and not against this number/);
  assert.doesNotMatch(status, /is ranked against its own committed/);

  const overview = await loadCorpusOverview();
  // Selected by property, with the empty state asserted rather than silently
  // vacuous: the card's fallback sentence ("no committed report is eligible")
  // renders only when no aggregate date exists, so eligible evidence must
  // imply a selected aggregate cohort or that fallback would be false.
  const eligibleEntries = overview.entries.filter(
    (entry) => entryEligibleForCorpusRollups(entry) && Number.isFinite(Date.parse(entry.scannedAt))
  );
  assert.ok(
    eligibleEntries.length > 0,
    "the committed corpus holds no eligible dated evidence; re-review the /status freshness copy before weakening this"
  );
  assert.ok(
    overview.aggregateCohort !== null,
    "eligible evidence exists but no aggregate cohort was selected; the /status fallback sentence would be false"
  );
  const categoryCohortCount = new Set(
    buildCategoryEvidencePages(overview.entries).map((category) => category.cohort.id)
  ).size;
  if (categoryCohortCount > 1) {
    // With the committed corpus in this state, an unconditional single-cohort
    // sentence on /status would contradict the homepage on the same build.
    assert.doesNotMatch(status, /single measurement cohort/);
    assert.match(status, /categoryCohortCount > 1/);
    assert.match(status, /no single cohort backs every published aggregate/);
  }
});
