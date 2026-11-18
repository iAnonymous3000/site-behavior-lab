import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DOMAIN_TABLE_ROWS, DOMAIN_TABLE_SHARED_COPY, buildDomainEvidenceTable, visitTimeScale } from "./domain-evidence-table";
import { buildRequestTimelineModel } from "./request-timeline";
import { notMeasuredLeads } from "./visit-limits";
import { notMeasuredPhrases } from "./homepage-figures";
import { buildReportVisitSummary } from "./report-visit-summary";
import { siteNameStep } from "./site-name-size";
import { renderedEvidenceArm } from "./report-evidence-navigation";
import { buildReportFacts } from "./report-facts";
import { buildReportHeadline } from "./report-headline";
import { buildFindings } from "./report-findings";
import {
  MARK_CHARACTER,
  PRINT_MARK_COLUMNS,
  PRINT_OPEN_BOX_COLUMNS,
  REQUEST_FIGURE_COPY,
  buildRequestFigure,
  figureMarks
} from "./request-figure";
import { frozenReportWire } from "./pinned-reports";
import { readStoredScanReport } from "./scan-report-reader";
import { toReportView } from "./scan-report-views";

const dir = path.join(process.cwd(), "public", "reports");

/** A committed report, by the name it is listed under in public/reports. */
function build(id: string) {
  return fromWire(readFileSync(path.join(dir, `${id}.json`), "utf8"), id);
}

/**
 * One particular report a test needs, from its frozen copy
 * (test-fixtures/reports, read through lib/pinned-reports.ts), so retention
 * of the published corpus cannot take it away.
 */
function buildFrozen(id: string) {
  return fromWire(frozenReportWire(id), id);
}

function fromWire(wire: string, id: string) {
  const read = readStoredScanReport(JSON.parse(wire));
  assert.ok(read.ok, id);
  const view = toReportView(read.stored);
  const facts = buildReportFacts(view);
  const evidenceArm = renderedEvidenceArm(view, buildReportHeadline(view, facts));
  return { view, facts, evidenceArm, figure: buildRequestFigure(view, facts, evidenceArm) };
}

/**
 * The last single-visit report the site published (xkcd.com, July 30), frozen
 * because retention retired the original on the November 18 refresh. The
 * corpus walks below add it, so their single-visit branch always runs on a
 * real published report whatever retention leaves.
 */
const FROZEN_SINGLE_ID = "20260730-748f7a920c0fdcf86c9a348a8660d395";

/** Every committed report, then the frozen single-visit one unless it is still committed. */
function committedAndFrozenSingle(): { id: string; built: () => ReturnType<typeof fromWire> }[] {
  const ids = readdirSync(dir)
    .filter((name) => /^\d{8}-[0-9a-f]{32}\.json$/.test(name))
    .map((name) => name.slice(0, -".json".length));
  assert.ok(ids.length > 0, "no committed report to draw");
  const reports = ids.map((id) => ({ id, built: () => build(id) }));
  if (!ids.includes(FROZEN_SINGLE_ID)) reports.push({ id: FROZEN_SINGLE_ID, built: () => buildFrozen(FROZEN_SINGLE_ID) });
  return reports;
}

test("the frozen single-visit report is a single visit", () => {
  assert.equal(buildFrozen(FROZEN_SINGLE_ID).view.reportType, "single");
});

test("every committed report's figure draws one mark per retained request row, for the visits its claim policy allows", () => {
  const drawn = { single: 0, both: 0, described: 0, lowerBound: 0 };
  for (const { id, built } of committedAndFrozenSingle()) {
    const { view, facts, evidenceArm, figure } = built();
    const expected =
      view.reportType !== "comparison"
        ? [facts.display]
        : view.claims.pairComparison?.allowed === true
          ? [facts.arms!.baseline, facts.arms!.variant]
          : [facts.arms![evidenceArm!]];
    assert.equal(figure.visits.length, expected.length, id);
    if (view.reportType !== "comparison") drawn.single += 1;
    else if (expected.length === 2) drawn.both += 1;
    else drawn.described += 1;
    figure.visits.forEach((visit, index) => {
      const run = expected[index].run;
      const marks = visit.rows.reduce((sum, row) => sum + row.count, 0);
      assert.equal(marks, run.evidence.requests.length, `${id}: marks against retained rows`);
      assert.equal(visit.lowerBound, expected[index].evidence.requests.state === "censored", id);
      if (visit.lowerBound) drawn.lowerBound += 1;
      for (const row of visit.rows) {
        // A lower bound is said in words in every row, not by the open box alone.
        assert.equal(/^at least /.test(row.countPhrase), visit.lowerBound, `${id}: ${row.countPhrase}`);
      }
      const site = visit.rows.find((row) => row.kind === "site");
      assert.equal(site?.count, run.evidence.requests.filter((request) => !request.thirdParty).length, id);
    });
    // The legend explains the open box exactly when one is drawn.
    assert.equal(figure.legend.lowerBound !== null, figure.visits.some((visit) => visit.lowerBound), id);
    // A refused comparison names the one visit it draws.
    if (view.reportType === "comparison" && expected.length === 1) {
      assert.ok(figure.caption.startsWith(REQUEST_FIGURE_COPY.visitLead(view.comparison!.runLabels[evidenceArm!])), id);
    }
  }
  // Each drawing branch is exercised by the corpus, so none passes empty.
  assert.ok(drawn.single > 0 && drawn.both > 0 && drawn.described > 0 && drawn.lowerBound > 0, JSON.stringify(drawn));
});

test("the domain table is a bounded excerpt that says what it leaves out", () => {
  const { facts, evidenceArm } = buildFrozen("20261019-35a2deb55fb041d4989532b0c0690449");
  const arm = facts.arms![evidenceArm!];
  const table = buildDomainEvidenceTable(arm, "No blocking");
  assert.equal(table.rows.length, DOMAIN_TABLE_ROWS);
  assert.ok(arm.run.evidence.domains.length > DOMAIN_TABLE_ROWS);
  assert.match(table.overflow ?? "", /^\+\d+ more in /);
  assert.deepEqual(table.notes, [DOMAIN_TABLE_SHARED_COPY.retainedOnly]);
  for (const row of table.rows) {
    assert.ok(row.ticks.every((tick) => tick >= 0 && tick <= 1), row.host);
    assert.ok(row.ticks.length <= row.requests, `${row.host}: more ticks than requests`);
  }
  const busiest = Math.max(...arm.run.evidence.domains.map((domain) => domain.requests));
  assert.equal(table.rows[0].requests, busiest);
});

test("a visit has one time scale, and the explorer's filter keeps the table's count", () => {
  const { facts, evidenceArm } = buildFrozen("20261019-35a2deb55fb041d4989532b0c0690449");
  const arm = facts.arms![evidenceArm!];
  const run = arm.run;
  const scale = visitTimeScale(run);
  // The scale ends at the visit's end or its last request, whichever is later.
  const latest = Math.max(...run.evidence.requests.map((request) => request.startedAtMs));
  assert.equal(scale.spanMs, Math.max(run.durationMs, latest, 1));
  assert.ok(scale.spanMs > latest, "this report's visit outlasts its last request, so the two scales differ");
  // The table's strip column and the timeline both run on it.
  assert.equal(buildDomainEvidenceTable(arm, null).whenColumn, scale.whenColumn);
  const timeline = buildRequestTimelineModel(run.evidence.requests, undefined, scale.spanMs);
  assert.equal(timeline.maxTime, scale.spanMs);
  assert.ok(timeline.marks.every((mark) => mark.xRatio >= 0 && mark.xRatio <= 1));
  assert.equal(buildRequestTimelineModel(run.evidence.requests).maxTime, latest, "without a span the scale ends at the last request");
  // The explorer's rows and strips are the report page's, under a filter.
  const all = buildDomainEvidenceTable(arm, null, Number.POSITIVE_INFINITY);
  assert.equal(all.matched, run.evidence.domains.length);
  assert.deepEqual(all.rows.slice(0, DOMAIN_TABLE_ROWS), buildDomainEvidenceTable(arm, null).rows);
  const filtered = buildDomainEvidenceTable(arm, null, 100, (domain) => domain.includes("npr.org"));
  assert.ok(filtered.matched > 0 && filtered.matched < run.evidence.domains.length);
  assert.equal(filtered.rows.length, Math.min(100, filtered.matched));
  assert.ok(filtered.rows.every((row) => row.host.includes("npr.org")));
  assert.equal(filtered.countLabel, all.countLabel, "the count label states every recorded domain, filtered or not");
  assert.equal(buildDomainEvidenceTable(arm, null, 100, () => false).matched, 0);
});

test("the table's shared sentences are still the evidence explorer's own", () => {
  const explorer = readFileSync(path.join(process.cwd(), "app", "_components", "report-tables.tsx"), "utf8");
  for (const [key, sentence] of Object.entries(DOMAIN_TABLE_SHARED_COPY)) {
    assert.ok(explorer.includes(sentence), `report-tables.tsx no longer prints "${sentence}" (${key})`);
  }
  assert.ok(explorer.includes(REQUEST_FIGURE_COPY.unsupported), "the unsupported-requests sentence moved");
});

test("new figure and table wording carries no dash characters", () => {
  const sources = ["request-figure.ts", "domain-evidence-table.ts"].map((file) =>
    readFileSync(path.join(process.cwd(), "lib", file), "utf8")
  );
  for (const source of sources) assert.doesNotMatch(source, /[–—]/);
});

test("the record block's labels are ones the shared report header and receipt already print", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const record = read("app/_design/record-block.tsx");
  const shared = read("app/_components/report-page-context.tsx");
  for (const label of [
    "Requested address",
    "View site history",
    "Scan this exact route again",
    "Scan this site again",
    "Report an evidence problem",
    "(opens in a new tab)",
    'term="Report ID"',
    'term="Site"',
    'term="Schema"',
    'term="Scanner"'
  ]) {
    assert.ok(shared.includes(label), `the shared header or receipt no longer prints ${label}`);
    const text = label.startsWith("term=") ? `<dt>${label.slice(6, -1)}</dt>` : label;
    assert.ok(record.includes(text), `the record block does not print ${text}`);
  }
});

test("the text behind a limit is in the page once, beside its control, and always on paper", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  // The component: the details holds only its summary; the paragraphs are
  // emitted once, in the element directly after it, which the summary names.
  const component = read("app/_design/limit-line.tsx");
  assert.match(component, /if \(!details \|\| details\.length === 0\) \{\s*return <p /, "the plain line is the branch with nothing behind it");
  assert.equal(component.split("details.map(").length - 1, 1, "the paragraphs are rendered more than once");
  assert.match(component, /<summary aria-controls=\{behindId\}>/);
  assert.match(
    component,
    /<\/summary>\s*<\/details>\s*<div className="a-lim-behind" id=\{behindId\}>\s*\{details\.map\(\(paragraph, index\) => <p key=\{index\}>\{paragraph\}<\/p>\)\}\s*<\/div>/
  );
  // A key holding the paragraph would repeat its text in the page data.
  assert.doesNotMatch(component, /key=\{paragraph\}/);

  const css = read("app/_design/components.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const printAt = css.lastIndexOf("@media print {");
  assert.ok(printAt > 0);
  const screen = css.slice(0, printAt);
  const print = css.slice(printAt);
  // Screen: hidden, and shown while the details before it is open.
  assert.match(screen, /\.da \.a-lim-behind \{\s*display: none;/);
  assert.match(screen, /\.da details\.a-lim\[open\] \+ \.a-lim-behind \{\s*display: block;\s*\}/);
  // Paper: shown by a plain rule on the element, whatever the details' state.
  assert.match(print, /\n  \.da \.a-lim-behind \{\s*display: block;\s*\}/);
  // Nothing in the design's stylesheets hides it another way, or leans on how
  // a browser prints a closed details.
  for (const file of ["components.css", "report.css", "base.css", "tokens.css"]) {
    const sheet = read(`app/_design/${file}`).replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(sheet, /::details-content/, file);
    assert.doesNotMatch(sheet, /a-lim-print/, file);
    for (const rule of sheet.matchAll(/([^{}]*a-lim-behind[^{}]*)\{([^}]*)\}/g)) {
      if (rule[1].trim() === ".da .a-lim-behind" && sheet.indexOf(rule[0]) < sheet.lastIndexOf("@media print {")) continue;
      assert.doesNotMatch(rule[2], /display:\s*none|visibility:\s*hidden|content-visibility/, `${file}: ${rule[1].trim()}`);
    }
  }
});

test("a figure row's marks are one run of characters, one per retained request row", () => {
  // The largest committed report, and one whose counts are lower bounds.
  const largest = buildFrozen("20261019-f12899f831d25acf6d1056b8869cb083");
  const lowerBound = buildFrozen("20261019-35a2deb55fb041d4989532b0c0690449");
  assert.ok(lowerBound.figure.visits.some((visit) => visit.lowerBound), "the lower-bound report no longer has one");
  const counts = new Set([0, 1, PRINT_MARK_COLUMNS - 1, PRINT_MARK_COLUMNS, PRINT_MARK_COLUMNS + 1]);
  let most = 0;
  for (const { figure } of [largest, lowerBound]) {
    for (const visit of figure.visits) {
      for (const row of visit.rows) {
        counts.add(row.count);
        most = Math.max(most, row.count);
      }
    }
  }
  assert.ok(most > PRINT_MARK_COLUMNS * 2, `the largest row draws only ${most} marks`);
  for (const count of counts) {
    for (const bound of [false, true]) {
      const marks = figureMarks(count, bound);
      const at = `${count} marks, lower bound ${bound}`;
      // Screen: the run and the mark held to the box are exactly the count,
      // and are nothing but the mark character.
      assert.equal(marks.run.length + (marks.held?.length ?? 0), count, at);
      assert.equal(marks.run + (marks.held ?? ""), MARK_CHARACTER.repeat(count), at);
      // The box takes the last mark with it, and exists only on a lower bound.
      assert.equal(marks.held, bound ? (count > 0 ? MARK_CHARACTER : "") : null, at);
      // Paper: full rows and the last row are exactly the count.
      const { columns, fullRows, remainder, rows } = marks.print;
      assert.equal(columns, PRINT_MARK_COLUMNS, at);
      assert.equal(fullRows * columns + remainder, count, at);
      assert.ok(remainder >= 0 && remainder < columns, at);
      assert.equal(rows, Math.max(1, Math.ceil(count / columns)), at);
    }
  }
  assert.throws(() => figureMarks(-1, false));
  assert.throws(() => figureMarks(1.5, false));
});

test("the figure emits no element per mark, and its pitch cannot depend on the font", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  // The pitch is `1ch` based, and `1ch` is the advance of "0".
  assert.equal(MARK_CHARACTER, "0");
  const css = read("app/_design/components.css");
  const printAt = css.lastIndexOf("@media print {");
  const screen = css.slice(0, printAt).replace(/\/\*[\s\S]*?\*\//g, "");
  const marksRule = /\.da \.a-marks \{([^}]*)\}/.exec(screen)?.[1] ?? "";
  assert.match(marksRule, /--a-adv: calc\(var\(--a-cell\) \+ var\(--a-gap\)\);/);
  assert.match(marksRule, /letter-spacing: calc\(var\(--a-adv\) - 1ch\);/);
  assert.match(marksRule, /user-select: none;/);
  // The square comes from the run's background: one band per line, a cell
  // tall and centered, striped a cell of color and a gap. One gradient the
  // length of the line: no tile and no mask on wrapped text, which WebKit
  // draws with a seam and off the pixel grid.
  const runRule = /\.da \.a-marks \.a-run \{([^}]*)\}/.exec(screen)?.[1] ?? "";
  assert.match(
    runRule,
    /background: repeating-linear-gradient\(90deg, var\(--a-mark\) 0 var\(--a-cell\), transparent var\(--a-cell\) var\(--a-adv\)\) 0 50% \/\s*100% var\(--a-cell\) no-repeat;/
  );
  assert.doesNotMatch(runRule, /mask|repeat-x/);
  assert.match(runRule, /box-decoration-break: clone;/);
  assert.match(runRule, /color: transparent;/);
  // The last mark and its box are one box to the line breaker.
  assert.match(screen, /\.da \.a-marks \.a-tail \{\s*display: inline-block;\s*white-space: nowrap;\s*\}/);
  // Paper hides the run and shows the two blocks, which the screen hides.
  const print = css.slice(printAt).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(screen, /\.da \.a-pf,\s*\.da \.a-pm \{\s*display: none;\s*\}/);
  assert.match(print, /\.da \.a-dest \.a-marks \.a-run \{\s*display: none;\s*\}/);
  assert.match(print, /\.da \.a-pf,\s*\.da \.a-pm \{\s*display: block;/);
  // The printed field is the mark columns and the columns kept for the box.
  // One column's share of it, and the full block's, follow from the two
  // constants the arithmetic uses; only multiplication is left to the browser.
  const field = PRINT_MARK_COLUMNS + PRINT_OPEN_BOX_COLUMNS;
  const column = `${100 / field}%`;
  assert.match(print, new RegExp(`\\.da \\.a-pf \\{[^}]*width: ${(100 * PRINT_MARK_COLUMNS) / field}%;[^}]*aspect-ratio: ${PRINT_MARK_COLUMNS} / var\\(--r\\);`));
  assert.match(print, new RegExp(`\\.da \\.a-pm \\{[^}]*width: calc\\(${column.replace(".", "\\.")} \\* var\\(--m\\)\\);[^}]*aspect-ratio: var\\(--m\\) / 1;`));
  assert.doesNotMatch(print, /round\(|mod\(|rem\(/);

  // The component: a row's marks come from figureMarks as text. Nothing in
  // it builds a list of elements from a count.
  const component = read("app/_design/request-figure.tsx");
  const marks = component.slice(component.indexOf("function Marks("));
  assert.ok(marks.length > 0 && marks.length < component.length, "the Marks component moved");
  assert.match(marks, /const marks = figureMarks\(row\.count, lowerBound\);/);
  assert.match(marks, /<span className="a-run">\{marks\.run\}<\/span>/);
  assert.match(marks, /<span className="a-run">\{marks\.held\}<\/span>/);
  assert.doesNotMatch(marks, /Array\.from|\.map\(|\.fill\(|new Array/);
  assert.equal(marks.split("<i ").length - 1, 2, "the Marks component emits two block elements and no other");
  // Paper's drawing: two elements, sized by the two numbers, and no more.
  assert.match(marks, /\{fullRows > 0 && <i className="a-pf" style=\{\{ "--r": fullRows \} as CSSProperties\} \/>\}/);
  assert.match(marks, /\{remainder > 0 && <i className="a-pm" style=\{\{ "--m": remainder \} as CSSProperties\} \/>\}/);
  assert.doesNotMatch(marks, /<svg|<rect|<pattern/);
  // The key outside it holds two fixed marks and no more.
  assert.equal(component.slice(0, component.indexOf("function Marks(")).split("<i />").length - 1, 2);
  assert.doesNotMatch(component, /Array\.from|new Array|\.fill\(/);
});

test("the report page renders nothing its design hides on screen", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  // The design shows no card icon. The page must not render one and hide it:
  // hidden markup is still stored in every committed report's page.
  assert.match(reportPageSources(read), /<FindingsList[\s\S]*?\n\s+omitIcons\n[\s\S]*?\/>/);
  assert.match(read("app/_components/findings-list.tsx"), /\{!omitIcons && \(\s*<div className="finding-icon">/);
});

test("the hatching, the texture for not measured, survives forced colors", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), "app", "_design", file), "utf8");
  // Every rule that draws hatching opts out of forced colors and takes its
  // ink from one token.
  let drawn = 0;
  for (const file of ["components.css", "report.css"]) {
    for (const rule of read(file).matchAll(/\{([^{}]*repeating-linear-gradient\(135deg[^{}]*)\}/g)) {
      drawn += 1;
      assert.match(rule[1], /repeating-linear-gradient\(135deg, var\(--a-(?:hatch|lim)-ink\) /, file);
      assert.match(rule[1], /forced-color-adjust: none;/, file);
      assert.match(rule[1], /print-color-adjust: exact;/, file);
    }
  }
  assert.equal(drawn, 3, "the key, the figure's list and the limit mark draw hatching");
  // Each ink is a token, and the reader's text color in forced colors.
  const tokens = read("tokens.css");
  assert.match(tokens, /--a-hatch-ink: var\(--a-edge\);/);
  assert.match(tokens, /--a-lim-ink: var\(--a-carbon\);/);
  assert.match(
    tokens,
    /@media \(forced-colors: active\) \{\s*:root:has\(\.da\) \{\s*--a-hatch-ink: CanvasText;\s*--a-lim-ink: CanvasText;\s*\}\s*\}/
  );
});

test("one hatched edge marks a limit everywhere, the could-not-see list included, and no square is left", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), "app", "_design", file), "utf8");
  const components = read("components.css");
  const rule = components.match(/([^{}]*)\{([^{}]*var\(--a-lim-ink\)[^{}]*)\}/);
  assert.ok(rule, "the limit mark's rule is gone");
  const marked = rule[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((selector) => selector.trim());
  assert.deepEqual(marked, [
    ".da .a-lim::before",
    ".da.da .finding-card .finding-lead + p::before",
    ".da.da .evidence-receipt-boundaries .evidence-receipt-note::before",
    ".da.da .report-visit-summary li::before",
    ".da.da .scan-disclosure p::before",
    ".da.da .empty-state .page-section-heading > p::before",
    ".da.da .corpus-hero-cat-note::before",
    ".da.da .featured-heading > p:last-child::before",
    ".da.da .featured-card .capped-chip::before",
    ".da.da .method-note::before",
    '.da.da .scheduled-rescan-status > .scheduled-rescan-private-note:not([role="alert"] + *)::before',
    ".da.da .scheduled-rescan-runs > p::before",
    ".da.da .loading-state > .scan-checks-note::before",
    ".da.da .site-history-table tbody th > div::before",
    ".da.da .report-grid .comparison-ineligible::before",
    ".da.da .report-grid .numbers-heading > span::before",
    ".da.da .report-grid .warnings li::before",
    ".da.da .report-grid .causal-graph-card > .section-heading > .muted::before",
    ".da.da .report-grid .causal-graph-card > .attribution-coverage-note::before",
    ".da.da .report-grid > .report-main > .report-incomplete-notice::before"
  ]);
  for (const declaration of [
    "left: 0;",
    "top: 0.2em;",
    "bottom: 0.2em;",
    "width: 8px;",
    "min-height: 1.1em;",
    "background: repeating-linear-gradient(135deg, var(--a-lim-ink) 0 1.5px, transparent 1.5px 4.5px);"
  ]) {
    assert.ok(rule[2].includes(declaration), declaration);
  }
  // The square was a 10px box with a 1.5px border. None is drawn any more,
  // and no other rule redraws a mark on one of these elements.
  for (const file of ["components.css", "report.css"]) {
    const sheet = read(file);
    assert.doesNotMatch(sheet, /border: 1\.5px solid var\(--a-carbon\)/, file);
    for (const other of sheet.matchAll(/([^{}]*)\{[^{}]*\}/g)) {
      const selectors = other[1].replace(/\/\*[\s\S]*?\*\//g, "");
      if (selectors.includes("--a-lim-ink") || other[0].includes("--a-lim-ink")) continue;
      assert.doesNotMatch(selectors, /(?:a-lim|headline-caveat|finding-lead \+ p|evidence-receipt-note|report-visit-summary li)::before/, file);
    }
  }
});

test("the older-format note is a limit beside the finding sentence, under the record's label; any other note stays a record row", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const record = read("app/_design/record-block.tsx");
  const page = reportPageSources(read);
  const note = read("lib/schema-note.ts");
  // One decision, in one place, read by the record, the page and the homepage's record.
  assert.match(
    note,
    /return view\.origin === "legacy-derived" \? \{ limit: note, record: null \} : \{ limit: null, record: note \};/
  );
  assert.match(record, /const formatChip = schemaNotePlacement\(view\)\.record;/);
  assert.match(note, /export const SCHEMA_LABEL = "Schema";/);
  assert.doesNotMatch(record, /legacy-derived|= "Schema"/);
  assert.match(page, /schemaLimit=\{schemaNotePlacement\(view\)\.limit\}/);
  // The note keeps its label, in the form of the incomplete-visit notice.
  assert.match(page, /<LimitLine>\s*\{SCHEMA_LABEL\}: <strong>\{schemaLimit\}<\/strong>\s*<\/LimitLine>/);
  // Among the limits, so above the figure in the source.
  assert.ok(page.indexOf("{SCHEMA_LABEL}:") < page.indexOf("\n      {figure}\n"));
  assert.ok(page.indexOf('className="headline-footer"') < page.indexOf("{SCHEMA_LABEL}:"));
});

test("on screen the record shows the site, the visit and the address; the id, digest and scanner stay in the markup for paper", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const record = read("app/_design/record-block.tsx");
  const sheet = read("app/_design/report.css");
  // The markup still carries every row, in the order the print rules count.
  const labels = [...record.matchAll(/<dt>([^<{]+)<\/dt>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ["Site", "Requested address", "Report ID", "Evidence SHA-256", "Schema", "Scanner"]);
  // The rule that leaves the three out is a screen rule, so paper prints them.
  const hide = sheet.indexOf(".da.da.da .a-rec :is(dt, dd):is(:nth-of-type(4), :nth-of-type(5), :last-of-type) {\n    display: none;");
  assert.ok(hide > 0, "the screen rule that leaves the id, digest and scanner out of the top is gone");
  const before = sheet.slice(0, hide);
  assert.ok(before.lastIndexOf("@media screen {") > before.lastIndexOf("@media print"), "that rule is not inside a screen block");
  assert.equal(before.lastIndexOf("@media screen {"), before.lastIndexOf("\n@media ") + 1, "that rule is not inside a screen block");
  // The site is the largest type on the page; the sentence is a standfirst.
  const tokens = read("app/_design/tokens.css");
  assert.match(tokens, /--a-t-site: 3\.375rem;/);
  assert.match(tokens, /--a-t-stand: 1\.75rem;/);
  assert.match(tokens, /--a-t-site: 2\.25rem;/);
  assert.match(tokens, /--a-t-stand: 1\.4375rem;/);
  assert.match(sheet, /font: 500 var\(--a-t-site\) \/ 1\.05 var\(--a-serif\);/);
  assert.match(sheet, /font: 400 var\(--a-t-stand\) \/ 1\.28 var\(--a-serif\);/);
});

test("the findings index is the report page's alone, holds labels and titles only, and names nothing new", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const list = read("app/_components/findings-list.tsx");
  const from = list.indexOf('<div className="a-fx">');
  const index = list.slice(from, list.indexOf('<div className="finding-list">'));
  assert.ok(from > 0, "the index is gone");
  // After the heading and before the cards.
  assert.ok(list.indexOf('className="findings-heading"') < from);
  // Plain lists, each named by the visible label above it: no landmark, no
  // heading and no accessible name of its own, so no string of its own.
  assert.doesNotMatch(index, /<nav|<h\d|aria-label=|role=/);
  assert.match(index, /<p id=\{`findings-index-\$\{group\.level\}`\}>\{REPORT_SEVERITY_LABELS\[group\.level\]\}<\/p>/);
  assert.match(index, /<ul aria-labelledby=\{`findings-index-\$\{group\.level\}`\}>/);
  assert.match(index, /<a href=\{`#\$\{findingCardDomId\(finding\.id\)\}`\}>\{finding\.title\}<\/a>/);
  // It writes no text of its own: nothing but expressions between its tags.
  assert.doesNotMatch(index.replace(/\{\/\*[\s\S]*?\*\/\}/g, ""), />\s*[A-Za-z][^<>{}]*</);
  // Keyed by position, so a title is not stored again as a key.
  assert.match(index, /<li key=\{position\}>/);
  // The cards keep their stored order: the index groups, the list does not sort.
  assert.doesNotMatch(list, /findings\.(?:slice\(\)\.)?sort\(|toSorted\(/);
  // Only the report page asks for it.
  assert.match(reportPageSources(read), /\n        omitIcons\n        index\n/);
  for (const file of ["app/_components/report-overview.tsx", "app/reports/[id]/print/page.tsx", "app/_components/report-renderer.tsx"]) {
    for (const use of read(file).matchAll(/<FindingsList[\s\S]*?\/>/g)) assert.doesNotMatch(use[0], /\bindex\b/, file);
  }
  // Paper has no links to follow: the index is not printed.
  const sheet = read("app/_design/report.css");
  const print = sheet.slice(sheet.lastIndexOf("@media print {"));
  assert.match(print, /\.da\.da \.a-fx \{\s*display: none;\s*\}/);
});

test("a card's filed label leads it and its tier sets its weight, with one limit size on every tier", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const list = read("app/_components/findings-list.tsx");
  // The label is the first element of the card's text block.
  assert.match(list, /<div>\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<p className="finding-level">/);
  const sheet = read("app/_design/report.css");
  assert.match(sheet, /\.da\.da \.finding-level \{\s*grid-area: level;\s*margin: 0 0 8px;\s*font: 600 var\(--a-t-fine\) \/ 1\.4 var\(--a-sans\);\s*color: var\(--a-carbon\);/);
  assert.match(sheet, /\.da\.da \.finding-card\.tile-loud \{\s*border-top: 3px solid var\(--a-carbon\);/);
  assert.match(sheet, /\.da\.da \.finding-card\.tile-warn \{\s*border-top-color: var\(--a-carbon\);/);
  assert.match(sheet, /\.da\.da \.finding-card\.tile-loud h3 \{[^}]*font-size: 1\.75rem;/);
  assert.match(sheet, /\.da\.da \.finding-card\.tile-warn h3 \{[^}]*font-size: 1\.375rem;/);
  assert.match(sheet, /\.da\.da \.finding-card h3 \{[^}]*font: var\(--a-w-title\) 1\.125rem \/ 1\.3 var\(--a-serif\);/);
  // No rule sizes a limit by tier.
  for (const rule of sheet.matchAll(/([^{}]*)\{[^}]*\}/g)) {
    if (/tile-/.test(rule[1])) assert.doesNotMatch(rule[1], /a-lim|finding-limit/, rule[1].trim());
  }
});

test("the report page renders the busiest-domains table after its findings, for the visit the figure draws", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const page = reportPageSources(read);
  // Built from the same visit as the figure: the evidence arm, or the display visit.
  assert.match(page, /const tableFacts = evidenceArm && facts\.arms \? facts\.arms\[evidenceArm\] : facts\.display;/);
  assert.match(page, /domainTable=\{<EvidenceTable table=\{domainTable\} \/>\}/);
  // Directly after the findings, inside the summary the explorer replaces, so
  // the page never shows this table and the explorer's own together.
  assert.match(page, /lookCloser=\{printed \? undefined : \{[^}]*\}\}\s*\/>\s*\{domainTable\}\s*<\/div>/);
  // Bounded, and a key never holds the text it keys.
  assert.equal(DOMAIN_TABLE_ROWS, 30);
  const table = read("app/_design/evidence-table.tsx");
  assert.doesNotMatch(table, /key=\{(?:note|row\.host)\}/);
});

test("a long site name is set a step smaller, by its length, on the server", () => {
  assert.equal(siteNameStep("www.npr.org"), "full");
  assert.equal(siteNameStep("a".repeat(18)), "full");
  assert.equal(siteNameStep("a".repeat(19)), "long");
  assert.equal(siteNameStep("www.psychologytoday.com"), "long");
  assert.equal(siteNameStep("a".repeat(26)), "long");
  assert.equal(siteNameStep("a".repeat(27)), "longer");
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const record = read("app/_design/record-block.tsx");
  // From the name as shown, and the same string the h1 prints.
  assert.match(record, /const siteName = displayHost\(run\.domain\);\s*const nameStep = siteNameStep\(siteName\);/);
  assert.match(record, /<SiteHeading\s+className=\{nameStep === "full" \? undefined : `a-site-\$\{nameStep\}`\}[^>]*>\s*<SiteNameText name=\{siteName\} \/>/);
  // The record has no script of its own to measure with.
  assert.doesNotMatch(record, /"use client"|useEffect|useLayoutEffect/);
  const tokens = read("app/_design/tokens.css");
  for (const size of ["--a-t-site-long: 2.75rem;", "--a-t-site-longer: 2.25rem;", "--a-t-site-long: 1.875rem;", "--a-t-site-longer: 1.625rem;"]) {
    assert.ok(tokens.includes(size), size);
  }
  const sheet = read("app/_design/report.css");
  assert.match(sheet, /\.a-rec :is\(h1, h2\)\.a-site-long \{\s*font-size: var\(--a-t-site-long\);/);
  assert.match(sheet, /\.a-rec :is\(h1, h2\)\.a-site-longer \{\s*font-size: var\(--a-t-site-longer\);/);
});

test("the two-column top applies only where the browser has subgrid, and stacks in source order without it", () => {
  const sheet = readFileSync(path.join(process.cwd(), "app/_design/report.css"), "utf8");
  // Every rule that places something on the banner's tracks is inside the
  // support test: outside it the banner's tracks would be its own.
  const from = sheet.indexOf("@supports (grid-template-columns: subgrid) {");
  assert.ok(from > 0, "the support test is gone");
  let depth = 0;
  let to = from;
  for (let at = sheet.indexOf("{", from); at < sheet.length; at += 1) {
    if (sheet[at] === "{") depth += 1;
    if (sheet[at] === "}") depth -= 1;
    if (depth === 0) { to = at; break; }
  }
  const outside = sheet.slice(0, from) + sheet.slice(to);
  assert.doesNotMatch(outside, /subgrid;/);
  assert.doesNotMatch(outside, /\.headline-(?:title|footer) \{[^}]*grid-row:/);
  assert.doesNotMatch(outside, /\.headline-banner \{[^}]*grid-row: 3/);
  assert.doesNotMatch(outside, /\.report-identity-actions \{[^}]*grid-row:/);
  const inside = sheet.slice(from, to);
  assert.match(inside, /\.headline-banner \{\s*grid-row: 3 \/ span 3;[^}]*grid-template-columns: subgrid;[^}]*grid-template-rows: subgrid;/);
  assert.match(inside, /\.headline-title \{\s*grid-column: 1;\s*grid-row: 2;/);
  // The limits span the sentence's row and the actions' row under it.
  assert.match(inside, /\.headline-footer \{\s*grid-column: 2;\s*grid-row: 1 \/ span 3;/);
  assert.match(inside, /\.report-page-summary > \.report-identity-actions \{\s*grid-column: 1;\s*grid-row: 5;/);
});

test("the record's actions follow the finding sentence and its limits in the source, before the figure, outside the identity header", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const record = read("app/_design/record-block.tsx");
  // The header holds the record alone.
  const header = record.slice(record.indexOf('<header className="report-identity">'), record.indexOf("</header>"));
  assert.doesNotMatch(header, /report-identity-actions|<a |<Link /);
  // The links are their own component, with the class the static smoke reads.
  const links = record.slice(record.indexOf("export function ReportRecordLinks("), record.indexOf("export function RecordDateline("));
  assert.match(links, /<div className="report-identity-actions">/);
  // The history is the filled button, a new visit the open one, and the
  // findings link names the board by its own heading and its id.
  assert.match(links, /<a className="primary-button" href=\{profileHref\}>View site history<\/a>/);
  assert.match(links, /<Link className="secondary-button" href=\{activation\.exactRescanHref\}>Scan this exact route again<\/Link>/);
  assert.match(links, /<a className="a-findings-link" href="#findings">What this visit means<\/a>/);
  const board = read("app/_components/findings-list.tsx");
  assert.match(board, /<section className="findings-board" id="findings">\s*<div className="findings-heading">\s*<div>[\s\S]{0,120}<h2>What this visit means<\/h2>/);
  // After the banner (the sentence and its limits) and before the figure, in the summary.
  const page = reportPageSources(read);
  const summary = page.slice(page.indexOf("function ReportPageSummary("));
  const at = summary.indexOf("\n      {recordLinks}\n");
  assert.ok(at > 0, "the summary no longer renders the record's links");
  assert.ok(summary.lastIndexOf("</section>", at) > summary.indexOf('<section className={`headline-banner'), "the actions are not after the banner");
  assert.ok(at < summary.indexOf("\n      {figure}\n"), "the actions are not before the figure");
  // One element, in the summary. The summary stays when the explorer opens,
  // so the client holds no second copy to show in its place.
  assert.equal([...page.matchAll(/<ReportRecordLinks /g)].length, 1);
  assert.equal([...page.matchAll(/recordLinks=\{recordLinks\}/g)].length, 1);
  assert.equal([...summary.matchAll(/\{recordLinks\}/g)].length, 1);
  const client = read("app/reports/[id]/saved-report-client.tsx");
  assert.match(client, /\{context\}\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?\{summary\}/);
  assert.doesNotMatch(client, /recordLinks|!loaded && summary/);
  // The header is an ordinary block again: nothing gives its children away.
  const sheet = read("app/_design/report.css");
  for (const rule of sheet.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    if (/\.report-identity\s*$/.test(rule[1].trim())) assert.doesNotMatch(rule[2], /display: contents/);
  }
  assert.doesNotMatch(sheet, /\.report-identity > \*/);
  // The board lands 16px below the top of the window.
  assert.match(sheet, /\.da\.da \.findings-board \{[^}]*scroll-margin-top: 16px;/);
});

test("the requested address breaks between its parts, and has the whole line on a phone", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
  const record = read("app/_design/record-block.tsx");
  // The same string, split after each "/" and "." with a break opportunity between the parts.
  assert.match(record, /displayPublicUrl\(run\.conditions\.requestedUrl\)\.split\(\/\(\?<=\[\/\.\]\)\/\)\.map\(\(part, index\) => \(\s*<Fragment key=\{index\}>\{index > 0 && <wbr \/>\}\{part\}<\/Fragment>/);
  assert.deepEqual("https://news.ycombinator.com/".split(/(?<=[/.])/), ["https:/", "/", "news.", "ycombinator.", "com/"]);
  assert.equal("https://news.ycombinator.com/".split(/(?<=[/.])/).join(""), "https://news.ycombinator.com/");
  // On a phone the label is above the value and both span the record.
  const sheet = read("app/_design/report.css");
  const phone = sheet.slice(sheet.indexOf("/* A phone: label beside value"), sheet.lastIndexOf("@media print {"));
  assert.match(phone, /dt:nth-of-type\(3\) \{\s*grid-area: 3 \/ 1 \/ auto \/ -1;/);
  assert.match(phone, /dd:nth-of-type\(3\) \{\s*grid-area: 4 \/ 1 \/ auto \/ -1;/);
});

test("a figure asked for the described visit only draws that one visit of an allowed pair, under the caption that names it", () => {
  const seen = { single: 0, allowedPair: 0, refusedPair: 0 };
  for (const { id, built } of committedAndFrozenSingle()) {
    const { view, facts, evidenceArm, figure } = built();
    const one = buildRequestFigure(view, facts, evidenceArm, { describedVisitOnly: true });
    // Always one visit.
    assert.equal(one.visits.length, 1, id);
    if (view.reportType !== "comparison") {
      // A single visit is unchanged, caption included.
      assert.deepEqual(one, figure, id);
      seen.single += 1;
      continue;
    }
    const arm = facts.arms![evidenceArm!];
    const label = view.comparison!.runLabels[evidenceArm!];
    // The visit the headline describes: its label, its retained rows, its lower bound.
    assert.equal(one.visits[0].label, label, id);
    assert.equal(one.visits[0].rows.reduce((sum, row) => sum + row.count, 0), arm.run.evidence.requests.length, id);
    assert.equal(one.visits[0].lowerBound, arm.evidence.requests.state === "censored", id);
    // An existing caption: the visit's lead, then the mark unit. Never "Both visits."
    assert.equal(one.caption, `${REQUEST_FIGURE_COPY.visitLead(label)} ${REQUEST_FIGURE_COPY.markUnit}`, id);
    // The legend explains the open box exactly when this one visit draws it.
    assert.equal(one.legend.lowerBound !== null, one.visits[0].lowerBound, id);
    if (view.claims.pairComparison?.allowed === true) {
      assert.equal(figure.visits.length, 2, id);
      seen.allowedPair += 1;
    } else {
      // A refused pair already drew one visit: the option changes nothing.
      assert.deepEqual(one, figure, id);
      seen.refusedPair += 1;
    }
  }
  assert.ok(seen.single > 0 && seen.allowedPair > 0 && seen.refusedPair > 0, JSON.stringify(seen));
});

test("the shell's links keep a focus ring although they are cleared with all: unset", () => {
  const base = readFileSync(path.join(process.cwd(), "app/_design/base.css"), "utf8");
  assert.match(
    base,
    /\.da\.da :is\(\.brand, \.topbar-link, \.footer-link\):focus-visible \{\s*outline: 3px solid var\(--a-focus\);\s*outline-offset: 2px;/
  );
});

test("under reduced motion the homepage's running state neither moves nor shows a bar that would read as an amount done", () => {
  const sheet = readFileSync(path.join(process.cwd(), "app/_design/home.css"), "utf8");
  const reduced = sheet.slice(sheet.indexOf("@media (prefers-reduced-motion: reduce) {"));
  assert.match(reduced, /\.da\.da\.da \.spin,\s*\.da\.da\.da \.progress-fill \{\s*animation: none;\s*\}/);
  assert.match(reduced, /\.da\.da\.da \.progress-track \{\s*display: none;\s*\}/);
  // The pulse dot is not drawn at all on this page.
  assert.match(sheet, /\.da\.da\.da \.loading-state \.pulse-dot \{\s*display: none;\s*\}/);
});

/**
 * The report page's source and its summary's, read as one text: the summary
 * is a component of its own (app/_design/report-summary.tsx) since a result
 * on the homepage renders it too, and these tests hold what the two files
 * render together.
 */
function reportPageSources(read: (file: string) => string): string {
  return `${read("app/reports/[id]/page.tsx")}\n${read("app/_design/report-summary.tsx")}`;
}

test("a result's Not measured row and its report page's are one function of the same evidence", () => {
  // One source: the report page's row is the module's own function.
  assert.equal(notMeasuredPhrases, notMeasuredLeads);
  const visit = readFileSync(path.join(process.cwd(), "lib", "visit-limits.ts"), "utf8");
  // The module reads no consent, censorship, egress or scroll-check code.
  const imports = [...visit.matchAll(/from\s*"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ["./report-evidence-navigation", "./report-facts", "./scan-report-views"]);
  // Across every committed report the row is exactly the summary's limit leads.
  let compared = 0;
  let withLeads = 0;
  for (const name of readdirSync(dir).filter((entry) => /^\d{8}-[0-9a-f]{32}\.json$/.test(entry))) {
    const id = name.slice(0, -".json".length);
    const { view, facts, evidenceArm } = build(id);
    const findings = buildFindings(view, null, facts, evidenceArm);
    const leads = buildReportVisitSummary({ view, facts, findings, evidenceArm }).limits.map((limit) => limit.lead.replace(/\.$/, ""));
    assert.deepEqual(notMeasuredLeads({ view, facts, findings, evidenceArm }), leads, id);
    compared += 1;
    if (leads.length > 0) withLeads += 1;
  }
  // Every report the manifest publishes, whatever retention leaves: a fixed
  // floor here held only while the corpus sat above the 1,000-report cap.
  const published = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8")) as { reports: unknown[] };
  assert.ok(compared > 0 && compared === published.reports.length, `${compared} committed reports were compared, ${published.reports.length} published`);
  assert.ok(withLeads > 0, "no committed report has a Not measured row to compare");
});
