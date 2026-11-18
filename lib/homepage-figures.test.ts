import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  buildFrontPageRecord,
  buildFrontPageRecordFromView,
  buildSiteRowMarks,
  notMeasuredPhrases
} from "./homepage-figures";
import { frozenReportWire } from "./pinned-reports";
import { publishedReportCorrections } from "./published-report-corrections";
import { renderedEvidenceArm } from "./report-evidence-navigation";
import { buildReportFacts } from "./report-facts";
import { buildFindings } from "./report-findings";
import { buildReportHeadline } from "./report-headline";
import { buildReportVisitSummary } from "./report-visit-summary";
import { REQUEST_FIGURE_COPY, buildRequestFigure } from "./request-figure";
import { readStoredScanReport } from "./scan-report-reader";
import { displayRunView, runLoadedSuccessfully, runVisitLabel, toReportView } from "./scan-report-views";

const dir = path.join(process.cwd(), "public", "reports");
const ids = readdirSync(dir)
  .filter((name) => /^\d{8}-[0-9a-f]{32}\.json$/.test(name))
  .map((name) => name.slice(0, -".json".length));

function storedFromWire(wire: string, id: string) {
  const result = readStoredScanReport(JSON.parse(wire));
  assert.ok(result.ok, id);
  return result.stored;
}

function read(id: string) {
  return storedFromWire(readFileSync(path.join(dir, `${id}.json`), "utf8"), id);
}

/**
 * The last single-visit report the site published (xkcd.com, July 30), frozen
 * because retention retired the original on the November 18 refresh. The
 * front-page walk adds it, so its single-visit branch always runs on a real
 * published report whatever retention leaves.
 */
const FROZEN_SINGLE_ID = "20260730-748f7a920c0fdcf86c9a348a8660d395";

function described(id: string) {
  return describedStored(read(id));
}

function describedStored(stored: ReturnType<typeof read>) {
  const view = toReportView(stored);
  const facts = buildReportFacts(view);
  const headline = buildReportHeadline(view, facts);
  const evidenceArm = renderedEvidenceArm(view, headline);
  const run = facts.arms && evidenceArm ? facts.arms[evidenceArm] : facts.display;
  return { stored, view, facts, headline, evidenceArm, run };
}

test("a site row's marks are the described visit's retained request rows, split as the report figure splits them", () => {
  const seen = { marked: 0, lowerBound: 0, unsupported: 0, pairDrawnAsOne: 0 };
  for (const id of ids) {
    const { stored, view, facts, evidenceArm, run } = described(id);
    const marks = buildSiteRowMarks(stored);
    if (run.evidence.requests.state === "unsupported") {
      // No request evidence was captured: the row draws nothing, not zero marks.
      assert.equal(marks, null, id);
      seen.unsupported += 1;
      continue;
    }
    assert.ok(marks, id);
    const requests = run.run.evidence.requests;
    // One mark per retained row of that visit, and the same split the log has.
    assert.equal(marks.site + marks.crossSite, requests.length, id);
    assert.equal(marks.site, requests.filter((request) => !request.thirdParty).length, id);
    assert.equal(marks.lowerBound, run.evidence.requests.state === "censored", id);
    // The same numbers the report page's own figure draws for that visit.
    const figure = buildRequestFigure(view, facts, evidenceArm);
    const label = view.comparison && evidenceArm ? view.comparison.runLabels[evidenceArm] : null;
    const visit = figure.visits.find((candidate) => candidate.label === label);
    assert.ok(visit, id);
    assert.equal(marks.site, visit.rows.find((row) => row.kind === "site")?.count, id);
    assert.equal(marks.crossSite, visit.rows.filter((row) => row.kind !== "site").reduce((sum, row) => sum + row.count, 0), id);
    seen.marked += 1;
    if (marks.lowerBound) seen.lowerBound += 1;
    if (figure.visits.length === 2) seen.pairDrawnAsOne += 1;
  }
  // Each branch the corpus can exercise is exercised. No committed report has
  // an unsupported request family today; that branch is held by the null
  // contract above and reported here, not assumed.
  assert.ok(seen.marked > 0 && seen.lowerBound > 0 && seen.pairDrawnAsOne > 0, JSON.stringify(seen));
});

test("the front-page record is one visit of one report: its site, date, sentence, limits and figure agree", () => {
  // A single visit, a pair the claim policy allows, and a pair it refuses.
  const kinds = { single: 0, allowedPair: 0, refusedPair: 0, incomplete: 0, ordered: 0 };
  // The committed reports, then the frozen single visit unless it is still committed.
  const walk = ids.map((id) => ({ id, load: () => described(id) }));
  if (!ids.includes(FROZEN_SINGLE_ID)) {
    walk.push({
      id: FROZEN_SINGLE_ID,
      load: () => describedStored(storedFromWire(frozenReportWire(FROZEN_SINGLE_ID), FROZEN_SINGLE_ID))
    });
  }
  for (const { id, load } of walk) {
    const { stored, view, facts, headline, evidenceArm, run } = load();
    if (kinds.single > 3 && kinds.allowedPair > 3 && kinds.refusedPair > 3 && kinds.incomplete > 3 && kinds.ordered > 3) break;
    const kind =
      view.reportType !== "comparison" ? "single" : view.claims.pairComparison?.allowed === true ? "allowedPair" : "refusedPair";
    if (kinds[kind] > 3) continue;
    const record = buildFrontPageRecord(id, stored, null);
    if (!record) continue;
    kinds[kind] += 1;
    const display = displayRunView(view);
    assert.equal(record.reportId, id);
    assert.equal(record.visitLabel, runVisitLabel(display), id);
    assert.equal(record.startedAt, display.startedAt ?? view.scannedAt ?? null, id);
    // The sentence and its limit are the report page's own.
    assert.equal(record.headline, headline.headline, id);
    assert.equal(record.caveat, headline.caveat, id);
    // One visit, the described one, under the caption that names it.
    assert.equal(record.figure.visits.length, 1, id);
    assert.equal(record.figure.visits[0].rows.reduce((sum, row) => sum + row.count, 0), run.run.evidence.requests.length, id);
    if (view.comparison && evidenceArm) {
      assert.equal(
        record.figure.caption,
        `${REQUEST_FIGURE_COPY.visitLead(view.comparison.runLabels[evidenceArm])} ${REQUEST_FIGURE_COPY.markUnit}`,
        id
      );
      if (record.visitOrder) kinds.ordered += 1;
    } else {
      assert.equal(record.figure.caption, REQUEST_FIGURE_COPY.markUnit, id);
      assert.equal(record.visitOrder, null, id);
    }
    if (record.incompleteNotice) kinds.incomplete += 1;
    // The "Not measured" row is the report page's: the visit summary's limit leads.
    const findings = buildFindings(view, null, facts, evidenceArm);
    assert.deepEqual(
      record.notMeasured,
      buildReportVisitSummary({ view, facts, findings, evidenceArm }).limits.map((limit) => limit.lead.replace(/\.$/, "")),
      id
    );
    assert.deepEqual(record.notMeasured, notMeasuredPhrases({ view, facts, findings, evidenceArm }), id);
  }
  assert.ok(Object.values(kinds).every((count) => count > 0), JSON.stringify(kinds));
});

test("no record is built for a withheld report or a visit that did not load", () => {
  const seen = { withheld: 0, notLoaded: 0, noFigure: 0, built: 0 };
  for (const id of ids) {
    const { stored, view, run } = described(id);
    const withheld = publishedReportCorrections(id).suppressIndexing;
    const notLoaded = !runLoadedSuccessfully(displayRunView(view));
    const noFigure = run.evidence.requests.state === "unsupported";
    if (!(withheld || notLoaded || noFigure)) {
      // Building every loaded report's record is slow; the builds are sampled
      // by the test above. Here the refusals are built, and a few others.
      if (seen.built < 5) {
        assert.ok(buildFrontPageRecord(id, stored, null), id);
        seen.built += 1;
      }
      continue;
    }
    assert.equal(buildFrontPageRecord(id, stored, null), null, id);
    if (withheld) seen.withheld += 1;
    if (notLoaded) seen.notLoaded += 1;
    if (noFigure) seen.noFigure += 1;
  }
  // Withheld reports are refused on real reports.
  assert.ok(seen.withheld > 0 && seen.built > 0, JSON.stringify(seen));

  // No committed report's described visit failed to load today, so that
  // refusal is stated on a report that builds, with its visit made to fail
  // each way the rule names: an error status, no status, a failed outcome.
  const id = ids.find((candidate) => !publishedReportCorrections(candidate).suppressIndexing)!;
  const view = toReportView(read(id));
  assert.ok(buildFrontPageRecordFromView(id, view, null), id);
  const display = displayRunView(view);
  const withDisplay = (change: object) => ({
    ...view,
    runs: view.runs.map((run) => (run === display ? { ...run, ...change } : run))
  });
  for (const change of [{ status: 503 }, { status: null }, { quality: { ...display.quality, outcome: "failed" } }]) {
    const failed = withDisplay(change) as typeof view;
    assert.equal(runLoadedSuccessfully(displayRunView(failed)), false, JSON.stringify(change));
    assert.equal(buildFrontPageRecordFromView(id, failed, null), null, JSON.stringify(change));
  }
  console.log(`front-page record refusals in the corpus: ${JSON.stringify(seen)}`);
});

test("a successful load is one rule, read by the library's coverage and by the record", () => {
  const overview = readFileSync(path.join(process.cwd(), "lib/corpus-overview.ts"), "utf8");
  assert.match(overview, /const successfulRuns = view\.runs\.filter\(runLoadedSuccessfully\);/);
  assert.doesNotMatch(overview, /candidate\.status < 400/);
  const figures = readFileSync(path.join(process.cwd(), "lib/homepage-figures.ts"), "utf8");
  assert.match(figures, /if \(!runLoadedSuccessfully\(run\)\) return null;/);
});

test("the report page and the homepage take the figure's not-measured phrases from one function", () => {
  const page = readFileSync(path.join(process.cwd(), "app/reports/[id]/page.tsx"), "utf8");
  assert.match(page, /const notMeasured = notMeasuredPhrases\(\{ view, facts, findings, evidenceArm \}\);/);
  assert.doesNotMatch(page, /limit\.lead\.replace/);
});

test("the homepage's record is the report its latest-report link opens, rendered on the server, text before figure", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const page = source("app/page.tsx");
  // The selection the link already uses, read once more. No second selection.
  assert.match(page, /const latest = homepageDiscovery\.latestReport;/);
  assert.match(page, /const latestRead = latest \? await readStoredReportForId\(latest\.latestReportId\) : null;/);
  assert.match(page, /buildFrontPageRecord\(latest\.latestReportId, latestRead\.stored, await loadCommittedCorpusStats\(\)\)/);
  const recordPart = page.slice(page.indexOf("const latest = "), page.indexOf("return ("));
  assert.doesNotMatch(recordPart, /\.sort\(|newestFirst|scannedAt|successfulLoad/);
  // No record, nothing in its place: the element is the record or null.
  assert.match(page, /frontRecord=\{\s*record && \(\s*<FrontPageRecordBlock/);
  // A server component, placed by the client page and not imported by it.
  const block = source("app/_design/front-page-record.tsx");
  assert.doesNotMatch(block, /"use client"|useState|useEffect/);
  // It imports no module that imports next/link: a client component anywhere
  // in the homepage's server graph is loaded as homepage script, and the
  // report page's record and header both import one.
  assert.doesNotMatch(block, /record-block|report-page-context|next\/link/);
  for (const file of ["app/_design/site-name.tsx", "lib/site-name-size.ts", "lib/schema-note.ts", "lib/incomplete-visit-notice.ts", "lib/homepage-labels.ts", "app/_design/limit-line.tsx", "app/_design/request-figure.tsx"]) {
    assert.doesNotMatch(source(file), /next\/link|"use client"/, file);
  }
  const client = source("app/site-behavior-app.tsx");
  assert.doesNotMatch(client, /front-page-record/);
  assert.match(client, /\{!loaded && !loading && !activeScanJob && !pendingScanAdmission && frontRecord\}\s*\{!loaded && !loading && !activeScanJob && !pendingScanAdmission && \(\s*<EmptyState/);
  // The link's words are one string, the record's label and the link under the rows.
  assert.match(block, /<a className="a-fpr-open" href=\{href\}>\{OPEN_LATEST_REPORT_LABEL\}<\/a>/);
  assert.match(client, /\{OPEN_LATEST_REPORT_LABEL\}/);
  assert.doesNotMatch(client, /Open latest report/);
  // Source order: the text, with the limits after the sentence, then the figure.
  const home = block.slice(block.indexOf("export function FrontPageRecordBlock"), block.indexOf("export function RecordLimits"));
  const order = ['className="a-fpr-open"', "<h2 ", 'className="a-fpr-find"', "<RecordLimits ", "<RequestFigure "].map((part) => home.indexOf(part));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), JSON.stringify(order));
  // The record writes no sentence of its own: between its tags, only expressions,
  // the report page's "(see Methodology)" and the label's colon.
  const jsx = block.slice(block.indexOf("export function FrontPageRecordBlock"), block.indexOf("export function SiteRowMarksRun"));
  const literals = [...jsx.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").matchAll(/>\s*([A-Za-z(][^<>{}]*?)\s*</g)].map((match) => match[1]);
  assert.deepEqual(literals, ["Methodology"]);
});

test("a site row's marks are text runs hidden from assistive technology, placed by the client and counted on the server", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const block = source("app/_design/front-page-record.tsx");
  const marks = block.slice(block.indexOf("export function SiteRowMarksRun"), block.indexOf("export function SiteRowKey"));
  assert.match(marks, /<span className="a-marks a-rowmarks" aria-hidden="true">/);
  // The figure's method: runs from figureMarks, never an element per mark.
  assert.match(marks, /const site = figureMarks\(marks\.site, marks\.lowerBound && !boxOnCross\);/);
  assert.match(marks, /const cross = figureMarks\(marks\.crossSite, boxOnCross\);/);
  assert.doesNotMatch(marks, /\.map\(|Array\.from|\.repeat\(/);
  // Same-site first, then cross-site, then the box.
  const order = ['"a-run is-site">{site.run}', '"a-run">{cross.run}', 'className="a-tail"'].map((part) => marks.indexOf(part));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), JSON.stringify(order));
  // Counted from the report the row links, by the figure's builder.
  const page = source("app/page.tsx");
  assert.match(page, /const read = await readStoredReportForId\(item\.id\);\s*const marks = read\.outcome === "found" \? buildSiteRowMarks\(read\.stored\) : null;/);
  assert.match(page, /rowMarks\[item\.id\] = <SiteRowMarksRun marks=\{marks\} \/>;/);
  // The client places the server's markup and draws nothing itself.
  const client = source("app/site-behavior-app.tsx");
  assert.match(client, /<span className="featured-card-stats">\s*\{rowMarks\[item\.id\]\}/);
  assert.doesNotMatch(client, /figureMarks|a-rowmarks/);
  // The key is the figure's own three strings.
  const key = block.slice(block.indexOf("export function SiteRowKey"));
  for (const name of ["legendSite", "legendCrossSite", "legendLowerBound"]) assert.ok(key.includes(`REQUEST_FIGURE_COPY.${name}`), name);
  assert.doesNotMatch(key.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""), />\s*[A-Za-z][^<>{}]*</);
});

test("the record's site is a step below the homepage headline and keeps the report page's length steps", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const block = source("app/_design/front-page-record.tsx");
  assert.match(block, /const nameStep = siteNameStep\(record\.site\);/);
  assert.match(block, /<h2 id="front-record-site" className=\{nameStep === "full" \? undefined : `a-site-\$\{nameStep\}`\}>/);
  const tokens = source("app/_design/tokens.css");
  for (const size of ["--a-t-rec: 2rem;", "--a-t-rec-long: 1.625rem;", "--a-t-rec-longer: 1.3125rem;", "--a-t-rec: 1.75rem;", "--a-t-rec-long: 1.4375rem;", "--a-t-rec-longer: 1.25rem;"]) {
    assert.ok(tokens.includes(size), size);
  }
  const sheet = source("app/_design/record.css");
  assert.match(sheet, /\.a-fpr-text h2 \{[^}]*font: 500 var\(--a-t-rec\) \/ 1\.1 var\(--a-serif\);/);
  assert.match(sheet, /\.a-fpr-text h2\.a-site-long \{\s*font-size: var\(--a-t-rec-long\);/);
  assert.match(sheet, /\.a-fpr-text h2\.a-site-longer \{\s*font-size: var\(--a-t-rec-longer\);/);
  // The headline keeps its own token.
  assert.match(tokens, /--a-t-home: 2\.5rem;/);
});

test("a site page's latest visit is the same record: the homepage's builder, limits and figure, or the block's plain statement", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const page = source("app/sites/[domain]/page.tsx");
  // The builder the homepage uses, for the report the block already leads with.
  assert.match(page, /const latestRead = await readStoredReportForId\(latest\.id\);/);
  assert.match(page, /buildFrontPageRecord\(latest\.id, latestRead\.stored, await loadCommittedCorpusStats\(\)\)/);
  // The shared limits and the shared figure, not a copy of either.
  assert.match(page, /\{record && <RecordLimits record=\{record\} \/>\}/);
  assert.match(page, /\{record && <RequestFigure figure=\{record\.figure\} notMeasured=\{record\.notMeasured\} \/>\}/);
  assert.doesNotMatch(page, /INCOMPLETE_VISIT_NOTICE|schemaNotePlacement|comparisonVisitOrderLine/);
  // With no record the block states what it stated before: its own sentence.
  assert.match(page, /\{record \? record\.headline : latest\.headline\}/);
  // Text before figure in the source, and the block's three numbers kept.
  const block = page.slice(page.indexOf("site-profile-current"), page.indexOf("compatibleChanges.length > 0 && ("));
  const order = ['id="current-title"', "<RecordLimits ", 'className="site-profile-visit"', 'className="site-profile-metrics"', "<RequestFigure "].map((part) => block.indexOf(part));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), JSON.stringify(order));
  // No tone on the block.
  assert.doesNotMatch(block, /tone-/);
  // The record's styles are one sheet, loaded by both pages.
  assert.match(page, /import "@\/app\/_design\/record\.css";/);
  assert.match(source("app/page.tsx"), /import "@\/app\/_design\/record\.css";/);
  assert.doesNotMatch(source("app/_design/home.css"), /\.a-fpr[\s{-]/);
});

test("a record of a report with a published clarification carries the share card's notice, beside its limits", () => {
  // A clarification keeps the report indexed, so its record is built; a
  // suppressing correction refuses the record (the test above).
  let carried = 0;
  for (const id of ids) {
    const context = publishedReportCorrections(id);
    if (!context.currentSubjectEvent || context.suppressIndexing) continue;
    const { stored, headline } = described(id);
    const record = buildFrontPageRecord(id, stored, null);
    if (!record) continue;
    // The headline's compact form, word for word, from the one function both take.
    assert.equal(record.clarification, headline.compactSubhead, id);
    assert.equal(
      record.clarification,
      `A public clarification applies. Open the report and read ${context.currentSubjectEvent.eventId} before using its findings.`,
      id
    );
    carried += 1;
    if (carried >= 5) break;
  }
  assert.ok(carried > 0, "no committed report with a current clarification built a record");

  // A report with no event carries none.
  const plain = ids.find((id) => publishedReportCorrections(id).currentSubjectEvent === null && buildFrontPageRecord(id, read(id), null));
  assert.ok(plain, "no uncorrected report built a record");
  assert.equal(buildFrontPageRecord(plain, read(plain), null)!.clarification, null, plain);

  // The limits print it first, as a plain limit line: visible without a click.
  const block = readFileSync(path.join(process.cwd(), "app/_design/front-page-record.tsx"), "utf8");
  const limits = block.slice(block.indexOf("export function RecordLimits"), block.indexOf("export function SiteRowMarksRun"));
  assert.match(limits, /<div className="a-fpr-limits">\s*\{record\.clarification && <LimitLine>\{record\.clarification\}<\/LimitLine>\}/);
  // One source: the record and the headline call the same function, and no
  // file restates the sentence.
  const headlineSource = readFileSync(path.join(process.cwd(), "lib/report-headline.ts"), "utf8");
  assert.equal(headlineSource.split("A public clarification applies. Open the report").length, 2);
  // The card's notice is the same value; a comparison caveat may follow it (owner packet H-A20).
  assert.match(headlineSource, /compactSubhead: headline\.compactQualifier \? `\$\{clarification\} \$\{headline\.compactQualifier\}` : clarification,/);
  assert.match(readFileSync(path.join(process.cwd(), "lib/homepage-figures.ts"), "utf8"), /clarification: publishedClarificationNotice\(reportId\),/);
});
