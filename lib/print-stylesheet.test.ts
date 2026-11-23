import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright";

/**
 * What the print stylesheet does, checked in a real engine rather than by
 * reading the cascade.
 *
 * Source assertions cannot answer this: `@media print` adds no specificity, so
 * whether an override wins depends on source order, and `display: none` on an
 * ancestor cannot be reasoned about from a selector list. The fixture carries
 * the real app/globals.css and the real class structure, and every assertion
 * comes in both directions, because a rule that reveals too much is the same
 * defect as one that reveals too little.
 */

const root = process.cwd();
const globalsCss = readFileSync(path.join(root, "app", "globals.css"), "utf8");

/**
 * The markup only, deliberately separate from the page below.
 *
 * The coverage assertion at the bottom greps THIS, never the assembled page:
 * the page inlines the whole stylesheet, so grepping it for a class name is a
 * tautology that passes for a fixture with an empty body. That is how the
 * first version of this file shipped.
 */
const FIXTURE_BODY = `<body>
  <a class="skip-link" id="skiplink" href="#main">Skip to content</a>
  <div class="app-shell report-page-shell">
    <header class="topbar">
      <nav class="topbar-nav" id="nav">nav</nav>
      <nav class="report-section-nav" id="sectionnav">sections</nav>
      <div class="topbar-actions" id="topbaractions">
        <button class="icon-button" id="iconbutton" type="button">theme</button>
      </div>
    </header>
    <main>
      <div class="report-actions" id="reportactions"><button type="button">Download CSV</button></div>
      <div class="headline-actions" id="headlineactions"><button type="button">Share</button></div>
      <div class="report-identity-actions" id="activationactions"><a href="#">Scan again</a></div>
      <div class="earlier-result-note" id="earlierresult">
        <a class="earlier-result-link" href="/reports/20261022-0123456789abcdef0123456789abcdef">Open the earlier result</a>
        <p>This comparison and the earlier result are different visits.</p>
      </div>
      <section class="connection-inspection" id="inspectionpanel">
        <h2>Which scripts asked for https://pixel.example.net/… in this new visit</h2>
        <ul class="connection-inspection-lines"><li>2 requests. Scripts on the call stack, innermost first: cdn.example.net.</li></ul>
      </section>
      <section aria-label="Results" id="report">
        <section class="scroll-check" id="scrollcheckpanel">
          <h2>What this page first contacted after scrolling began</h2>
          <ul class="scroll-check-hosts"><li>example.net: cdn.example.net</li></ul>
        </section>
        <p class="scroll-check-report-note" id="scrollchecknote">The report below covers the visit before the check began.</p>
        <p id="checkedreport">The check visit's ordinary report.</p>
      </section>
      <div class="report-visit-summary">
        <div class="report-visit-limits">
          <h3 class="report-visit-heading">What this visit could not see</h3>
          <ul><li id="visitlimit"><strong>Anything that loads only after interaction or consent.</strong> Trackers that load that late are not observed, so counts are a lower bound.
            <span class="report-visit-entry" id="visitentry">
              <a class="finding-look-closer-link" href="/#scan?url=https%3A%2F%2Fwww.example.com%2F&amp;check=scroll">Check after scrolling</a>
              <span class="report-visit-entry-sentence">Opens the scan form ready for a new visit.</span>
            </span>
          </li></ul>
        </div>
      </div>
      <article class="finding-card tile-warn">
        <div><h3>Third-party cookies were present</h3><p id="findinglead">12 third-party cookies showed up during the visit.</p>
          <div class="finding-look-closer" id="lookcloser">
            <p class="finding-look-closer-name">Look closer</p>
            <a class="finding-look-closer-link" href="/sites/example.com/#history">See other visits' cookie counts</a>
            <p class="finding-look-closer-sentence">Opens this site's history page.</p>
          </div>
        </div>
      </article>
      <section class="report-evidence-loader" id="loader">
        <h2>Open the interactive evidence explorer</h2>
      </section>
      <details class="data-section disclosure" id="log">
        <summary class="section-heading">
          <h2>Request log</h2>
          <span class="count-badge" id="count">12 of 40 recorded</span>
          <span class="disclosure-chevron" id="chevron">v</span>
        </summary>
        <div class="section-tools disclosure-tools request-log-tools" id="tools">
          <div class="request-filter-chips" id="chips" role="group"><button type="button">Trackers</button></div>
          <input class="filter-input" id="filter" type="search" />
        </div>
        <div id="logbody">recorded request rows
          <table class="request-table"><tbody><tr data-request-row><td class="url-cell mono" data-label="URL" id="rowurl">https://pixel.example.net/…
            <a class="inspect-connection-link" id="inspectlink" href="/#scan?url=https%3A%2F%2Fwww.example.com%2F">Inspect this connection</a>
          </td></tr></tbody></table>
        </div>
      </details>
      <p class="muted disclosure-lazy-note" id="lazynote">Open the request log to render its rows.</p>
      <button class="change-list-toggle" id="difftoggle" type="button">Show all 14</button>
      <section class="causal-graph">
        <ul class="attribution-edge-list" id="mapedges"><li><button type="button">a.example to b.example</button></li></ul>
        <div class="attribution-selection" id="mapselection" role="status">a.example to b.example</div>
        <h3 class="visually-hidden print-text-equivalent" id="mapheading">Relationships shown in the attribution map</h3>
        <ol class="visually-hidden print-text-equivalent" id="maplist"><li>3 requests to example.test</li></ol>
      </section>
      <p class="print-only" id="armprint">Evidence below is from the baseline visit.</p>
      <div class="arm-switcher" id="armswitcher"><span>Evidence shown:</span><button class="arm-option">Baseline</button></div>
      <div class="evidence-receipt-links" id="receiptlinks"><a href="#">Open report JSON</a></div>
      <a href="#">Source<span class="visually-hidden" id="newtab"> (opens in a new tab)</span></a>
      <p class="visually-hidden" role="status" aria-live="polite" id="live">3 results</p>
    </main>
    <footer class="app-footer">
      <span class="app-footer-links" id="footerlinks"><a href="#">Glossary</a></span>
      <span class="app-footer-caveat" id="caveat">Reports record one automated visit per condition; visits may be incomplete.</span>
    </footer>
  </div>
  <footer class="print-evidence-footer" id="printfooter">
    <p>Printed copy. Exact evidence bytes: SHA-256 <code>abc</code>.</p>
  </footer>
</body>`;

/** Mirrors the real report shell closely enough for the print cascade. */
const FIXTURE = `<!doctype html>
<html><head><style>${globalsCss}</style></head>
${FIXTURE_BODY}
</html>`;

/**
 * Hide-group classes that a report page cannot render, with the component that
 * owns each. They are in the shared print block because the homepage prints
 * too; demanding markup for them here would bloat the fixture without covering
 * anything a report reader can reach.
 */
const NOT_ON_A_REPORT_PAGE: ReadonlyMap<string, string> = new Map([
  ["corpus-hero", "app/site-behavior-app.tsx"],
  ["empty-state", "app/site-behavior-app.tsx"],
  ["homepage-discovery-actions", "app/site-behavior-app.tsx"],
  ["homepage-tools-disclosure", "app/site-behavior-app.tsx"],
  ["progress-track", "app/site-behavior-app.tsx"],
  ["pulse-dot", "app/site-behavior-app.tsx"],
  ["scan-checks", "app/site-behavior-app.tsx"],
  ["scan-checks-note", "app/site-behavior-app.tsx"],
  ["scan-workbench", "app/site-behavior-app.tsx"],
  ["error-banner", "app/_components/scan-recovery-banner.tsx, used only by the scan workbench"]
]);

const PROBED_IDS = [
  "nav",
  "sectionnav",
  "topbaractions",
  "iconbutton",
  "skiplink",
  "reportactions",
  "headlineactions",
  "activationactions",
  "earlierresult",
  "inspectionpanel",
  "scrollcheckpanel",
  "scrollchecknote",
  "checkedreport",
  "visitlimit",
  "visitentry",
  "findinglead",
  "lookcloser",
  "loader",
  "count",
  "chevron",
  "tools",
  "chips",
  "filter",
  "logbody",
  "rowurl",
  "inspectlink",
  "lazynote",
  "difftoggle",
  "mapedges",
  "mapselection",
  "mapheading",
  "maplist",
  "receiptlinks",
  "newtab",
  "live",
  "footerlinks",
  "caveat",
  "armprint",
  "armswitcher",
  "printfooter"
] as const;

type ProbedId = (typeof PROBED_IDS)[number];

let browser: Browser;
let visible: Record<ProbedId, boolean>;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    try {
      await page.emulateMedia({ media: "print" });
      await page.setContent(FIXTURE, { waitUntil: "load" });
      // checkVisibility, not getComputedStyle: a collapsed <details> hides its
      // content through content-visibility on ::details-content in current
      // Chromium, so the child's computed `display` says "block" either way and
      // would make the disclosure assertion pass without meaning anything.
      const measured = await page.evaluate((ids) => {
        const result: Record<string, boolean> = {};
        for (const id of ids) {
          const element = document.getElementById(id);
          if (!element) throw new Error(`print fixture is missing #${id}`);
          result[id] = element.checkVisibility({
            checkVisibilityCSS: true,
            contentVisibilityAuto: true
          });
        }
        return result;
      }, [...PROBED_IDS]);
      visible = measured as Record<ProbedId, boolean>;
    } finally {
      await page.close();
    }
  } catch (error) {
    // Without this the browser outlives a failed setup and the suite hangs.
    await browser.close();
    throw error;
  }
});

test.after(async () => {
  await browser?.close();
});

test("evidence and its qualifications survive onto paper", () => {
  // The evidence itself, including a disclosure the reader never opened.
  assert.equal(visible.logbody, true, "a collapsed disclosure must still print its evidence");
  // The text equivalent of the attribution map: the SVG may not survive page width.
  assert.equal(visible.mapheading, true, "the attribution map text equivalent must print");
  assert.equal(visible.maplist, true, "the attribution map relationship list must print");
  // A findings card's own statements, beside the view that hides.
  assert.equal(visible.findinglead, true, "a findings card's statement must print");
  // What the visit could not see, beside the new visit that hides.
  assert.equal(visible.visitlimit, true, "a visit summary's limit must print");
  // The digest and the standing scope caveat.
  assert.equal(visible.printfooter, true, "the evidence footer must print");
  assert.equal(visible.caveat, true, "the standing scope caveat must print");

  // Marks that more evidence exists than was printed. Dropping these is what
  // turns a partial print into a claim of completeness.
  assert.equal(visible.count, true, "the recorded-vs-shown count must print");
  assert.equal(visible.lazynote, true, "the unopened-disclosure note must print");
  assert.equal(visible.loader, true, "the evidence-explorer prompt must print");
  assert.equal(visible.difftoggle, true, "the truncated-diff control names how many rows were withheld");

  // Every table below the switcher shows one arm. Paper cannot switch, so it
  // has to say which arm it is showing and that the other is absent.
  assert.equal(visible.armprint, true, "a printed comparison must name the arm it shows");
});

test("controls and screen-reader scaffolding stay off paper", () => {
  assert.equal(visible.nav, false, "site navigation is not evidence");
  assert.equal(visible.sectionnav, false, "the in-page section nav is navigation, not evidence");
  assert.equal(visible.topbaractions, false, "topbar controls are not evidence");
  assert.equal(visible.iconbutton, false, "the theme toggle is not evidence");
  assert.equal(visible.skiplink, false, "the skip link is not evidence");
  assert.equal(visible.reportactions, false, "report action buttons are not evidence");
  assert.equal(visible.headlineactions, false, "headline action buttons are not evidence");
  assert.equal(visible.activationactions, false, "activation links are not evidence");
  // A view opens rows, a card or a history page on screen; paper can follow
  // none of them, and the printable route renders none.
  assert.equal(visible.lookcloser, false, "a findings card's Look closer view is navigation, not evidence");
  // A fresh result's "Check after scrolling" opens a new visit, and the
  // printable route renders none.
  assert.equal(visible.visitentry, false, "a visit summary's Check after scrolling is navigation, not evidence");
  // The homepage prints its result region too; the link back to an earlier
  // result is a link to follow, and it is never part of a report.
  assert.equal(visible.earlierresult, false, "a homepage result's link back to the earlier result is navigation, not evidence");
  // A request row's link to inspect its connection opens a new visit; the
  // row's own address beside it is evidence and prints.
  assert.equal(visible.inspectlink, false, "a request row's inspection link is navigation, not evidence");
  // An inspection's panel is the homepage result's own, never the report's.
  assert.equal(visible.inspectionpanel, false, "an inspection's immediate-only panel must not print");
  // Nothing from a check visit prints: its panel, the line under it, and the
  // ordinary report beneath, which describes a visit that went on to scroll.
  assert.equal(visible.scrollcheckpanel, false, "a check's panel must not print");
  assert.equal(visible.scrollchecknote, false, "the line under a check's panel must not print");
  assert.equal(visible.checkedreport, false, "a check visit's ordinary report must not print");
  assert.equal(visible.rowurl, true, "a request row's address must print beside the hidden link");
  assert.equal(visible.tools, false, "filter tooling is not evidence");
  assert.equal(visible.chips, false, "request signal filter chips are not evidence");
  assert.equal(visible.filter, false, "a search box is not evidence");
  assert.equal(visible.chevron, false, "a disclosure chevron is decoration");
  assert.equal(visible.receiptlinks, false, "link buttons carry no text on paper");
  assert.equal(visible.footerlinks, false, "footer navigation is not evidence");
  assert.equal(visible.armswitcher, false, "the arm switcher is a control; its print-only replacement carries the fact");
  // The attribution map's interactive layer. Its relationship list, which is
  // marked print-text-equivalent, is what carries those relationships onto
  // paper, so hiding the controls loses no evidence.
  assert.equal(visible.mapedges, false, "the edge buttons are controls");
  assert.equal(visible.mapselection, false, "the selection detail is a live region");

  // The exemption must be opt-in. If .visually-hidden were simply revealed,
  // these two would print as body copy.
  assert.equal(visible.newtab, false, "screen-reader link qualifiers must not print");
  assert.equal(visible.live, false, "live-region status text must not print");
});

test("a homepage result without a check still prints", async () => {
  const page = await browser.newPage();
  try {
    await page.emulateMedia({ media: "print" });
    await page.setContent(
      `<!doctype html><html><head><style>${globalsCss}</style></head><body><main>` +
        `<section aria-label="Results" id="report"><section class="report-header" id="ordinaryheader"><h2>Example</h2></section>` +
        `<p id="ordinaryresult">An ordinary result's evidence.</p></section></main></body></html>`,
      { waitUntil: "load" }
    );
    const shown = await page.evaluate(() =>
      ["ordinaryheader", "ordinaryresult"].map((id) => document.getElementById(id)?.checkVisibility({ checkVisibilityCSS: true }) ?? null)
    );
    assert.deepEqual(shown, [true, true], "only a result with a check's panel stays off paper");
  } finally {
    await page.close();
  }
});

test("the fixture exercises every report-page class the print block hides", () => {
  const printBlockStart = globalsCss.indexOf("@media print {");
  assert.ok(printBlockStart > 0, "the print block must exist");
  const hideGroup = globalsCss.slice(
    printBlockStart,
    globalsCss.indexOf("display: none !important", printBlockStart)
  );

  // Comments in this block deliberately NAME the classes that are not hidden,
  // explaining why. Harvesting them as selectors would demand markup for rules
  // that do not exist.
  const selectorsOnly = hideGroup.replace(/\/\*[\s\S]*?\*\//g, "");
  const hidden = [...selectorsOnly.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]);
  assert.ok(hidden.length > 5, "the hide group should have been parsed");

  const missing = hidden.filter(
    (className) => !FIXTURE_BODY.includes(className) && !NOT_ON_A_REPORT_PAGE.has(className)
  );
  assert.deepEqual(
    missing,
    [],
    `the print fixture has no markup for: ${missing.join(", ")}. Add an element and a PROBED_IDS entry, ` +
      "or list it in NOT_ON_A_REPORT_PAGE with the component that owns it."
  );

  // The allowlist must not rot into a place where report-page rules hide. Every
  // entry has to still be a real selector in the hide group.
  const stale = [...NOT_ON_A_REPORT_PAGE.keys()].filter((className) => !hidden.includes(className));
  assert.deepEqual(stale, [], `NOT_ON_A_REPORT_PAGE lists classes the print block no longer hides: ${stale.join(", ")}`);
});

/**
 * The print block's palette must actually win, in every theme state.
 *
 * The existing setup above calls `emulateMedia({ media: "print" })` with no
 * `colorScheme`, which defaults to light, so it structurally cannot see the
 * defect this covers: the system-dark palette is declared under
 * `:root:not([data-theme="light"])` (0,2,0), a media query adds no specificity,
 * and the print override's matching selector for an element with no data-theme
 * was a bare `:root` (0,1,0). It lost. A visitor whose OS is dark and who never
 * touched the toggle printed the whole dark palette -- rgb(231,239,233) body
 * text -- on white paper, and that is the DEFAULT path, since app/layout.tsx
 * only stamps data-theme after an explicit choice.
 *
 * Reading resolved custom properties rather than asserting on the source, for
 * the reason this file's header already gives: specificity between an @media
 * block and a bare selector is not visible in the text.
 */
test("printing resolves the ink palette whatever theme the reader is in", async () => {
  const page = await browser.newPage();
  try {
    for (const colorScheme of ["light", "dark"] as const) {
      for (const dataTheme of [null, "dark", "light"] as const) {
        await page.emulateMedia({ media: "print", colorScheme });
        await page.setContent(FIXTURE, { waitUntil: "load" });
        const resolved = await page.evaluate((theme) => {
          if (theme) document.documentElement.dataset.theme = theme;
          else delete document.documentElement.dataset.theme;
          const style = getComputedStyle(document.documentElement);
          const read = (name: string) => style.getPropertyValue(name).trim();
          return {
            text: read("--text"),
            surface: read("--surface"),
            accentStrong: read("--accent-strong"),
            sigOk: read("--sig-ok"),
            sigLoud: read("--sig-loud")
          };
        }, dataTheme);
        const where = `colorScheme=${colorScheme} data-theme=${dataTheme ?? "unset"}`;

        assert.equal(resolved.text, "#000000", `body text must print as ink (${where})`);
        assert.equal(resolved.surface, "#ffffff", `surfaces must print as paper (${where})`);

        // These four are the ones the print block used to omit entirely. They
        // print as TEXT even though browsers drop backgrounds by default, so a
        // screen value like #4ade80 landed on white at roughly 1.7:1.
        for (const [name, value] of Object.entries({
          "--accent-strong": resolved.accentStrong,
          "--sig-ok": resolved.sigOk,
          "--sig-loud": resolved.sigLoud
        })) {
          assert.ok(
            contrastOnWhite(value) >= 4.5,
            `${name} prints as ${value}, ${contrastOnWhite(value).toFixed(2)}:1 on paper (${where})`
          );
        }
      }
    }
  } finally {
    await page.close();
  }
});

test("the printable guide's digests fit a phone screen and keep their paper layout", async () => {
  // The guide prints a 64-character SHA-256 and a 40-character commit as
  // inline code. Unbreakable, the SHA-256 made /reports/<id>/print/ 513 px
  // wide on a 375 px phone (measured 2026-10-17 and again 2026-10-18).
  const guide = `<!doctype html>
<html><head><style>${globalsCss}</style></head><body>
  <div class="app-shell report-page-shell printable-report"><main>
    <section class="print-document-guide">
      <h2>How to use this report</h2>
      <p>Correction context SHA-256: <code id="digest">${"8b4dc650".repeat(8)}</code></p>
      <p>Renderer revision: <code id="commit">${"a1686ebe".repeat(5)}</code></p>
    </section>
  </main></div>
</body></html>`;
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  try {
    await page.emulateMedia({ media: "screen" });
    await page.setContent(guide, { waitUntil: "load" });
    const screen = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    assert.ok(screen.scrollWidth <= screen.innerWidth, `the guide made a 375 px screen ${screen.scrollWidth} px wide`);

    // The rule is screen-only, so a printed guide breaks nowhere it did not.
    await page.emulateMedia({ media: "print" });
    const paper = await page.evaluate(() =>
      ["digest", "commit"].map((id) => getComputedStyle(document.getElementById(id)!).overflowWrap)
    );
    assert.deepEqual(paper, ["normal", "normal"]);
  } finally {
    await page.close();
  }
});

/*
 * The printed request log's columns, with the real sheets in the printable
 * route's order (app/layout.tsx, then app/reports/[id]/print/page.tsx). The
 * font sheet is left out: it only names files this fixture cannot load.
 *
 * Widths are read as Chromium computes them, so a width is checked whichever
 * sheet and selector set it. The log stands in a box as wide as the landscape
 * sheet's content, 966 CSS px as measured in an exported PDF: emulated print
 * does not lay out the named landscape page, so the box gives that width.
 */
const DESIGN_SHEETS = ["tokens", "base", "components", "report", "explorer", "print"].map((name) =>
  readFileSync(path.join(root, "app", "_design", `${name}.css`), "utf8")
);
const ROUTE_SHEETS = [globalsCss, ...DESIGN_SHEETS];
/** The same sheets without app/globals.css, so print.css is the one that gives widths. */
const WITHOUT_GLOBALS = DESIGN_SHEETS;
const SHEET_WIDTH = 966;
const UNBREAKABLE_HOST = `${"a".repeat(260)}.example`;

function printedLog(hasPhases: boolean, shell: string): string {
  const row = (reference: string, host: string) => `<tr data-request-row>
    <td class="request-ref"><code>${reference}</code></td>
    <td class="mono time-cell" data-label="Time">12,345ms</td>
    ${hasPhases ? '<td data-label="Phase">P0</td>' : ""}
    <td data-label="Status"><span class="status-ok">200</span></td>
    <td data-label="Type">stylesheet</td>
    <td class="mono host-cell" data-label="Domain">${host}</td>
    <td data-label="Provenance"><span class="provenance-cell"><span>initiated by www.example.com</span></span></td>
    <td class="url-cell mono" data-label="URL">https://www.example.com/…</td>
  </tr>`;
  return `<body><div class="${shell}"><main><div class="report-grid" style="display:block">
    <div class="report-evidence-tables" style="display:block;width:${SHEET_WIDTH}px">
      <div class="table-wrap request-table${hasPhases ? " has-phase-column" : ""}">
        <table>
          <thead>
            <tr>
              <th scope="col" class="request-ref">Ref</th>
              <th scope="col" class="time-cell">Time</th>
              ${hasPhases ? '<th scope="col">Phase</th>' : ""}
              <th scope="col">Status</th>
              <th scope="col">Type</th>
              <th scope="col">Domain</th>
              <th scope="col">Provenance</th>
              <th scope="col">URL</th>
            </tr>
            <tr class="print-table-limit-row"><th colspan="${hasPhases ? 8 : 7}">This log contains retained rows only.</th></tr>
          </thead>
          <tbody>${row("B:R0001", "www.<wbr>example.<wbr>com")}${row("B:R0002", UNBREAKABLE_HOST)}</tbody>
        </table>
      </div>
    </div>
  </div></main></div></body>`;
}

const PRINTABLE_SHELL = "app-shell report-page-shell printable-report da";

async function measureLog(sheets: readonly string[], hasPhases: boolean, shell = PRINTABLE_SHELL) {
  const page = await browser.newPage({ viewport: { width: SHEET_WIDTH, height: 696 } });
  try {
    await page.emulateMedia({ media: "print" });
    await page.setContent(
      `<!doctype html><html><head>${sheets.map((css) => `<style>${css}</style>`).join("")}</head>${printedLog(hasPhases, shell)}</html>`,
      { waitUntil: "load" }
    );
    if (sheets === ROUTE_SHEETS) {
      // Without this, every reading below could describe a narrow log that no
      // exported page has. The other sheet sets are partial, so only the
      // route's own is held to it.
      const tableWidth = await page.evaluate(() => document.querySelector("table")!.getBoundingClientRect().width);
      assert.ok(
        Math.abs(tableWidth - SHEET_WIDTH) <= 0.5,
        `the fixture's table is not as wide as the sheet: ${tableWidth} px of ${SHEET_WIDTH}`
      );
    }
    return await page.evaluate(() => {
      const table = document.querySelector("table")!;
      const box = document.querySelector(".report-evidence-tables")!.getBoundingClientRect();
      const heads = [...table.rows[0].cells];
      const body = [...table.tBodies[0].rows[0].cells];
      return {
        declared: heads.map((cell) => String(cell.computedStyleMap().get("width"))),
        bodyDeclared: body.map((cell) => String(cell.computedStyleMap().get("width"))),
        used: heads.map((cell) => cell.getBoundingClientRect().width),
        tablePastSheet: table.getBoundingClientRect().right - box.right,
        columnsPastSheet: heads.filter((cell) => cell.getBoundingClientRect().right > box.right + 0.5).map((cell) => cell.textContent),
        headFonts: heads.map((cell) => getComputedStyle(cell).fontSize),
        limitFont: getComputedStyle(table.rows[1].cells[0]).fontSize,
        bodyFonts: body.map((cell) => getComputedStyle(cell.querySelector("code") ?? cell).fontSize),
        wrapping: {
          referenceHead: getComputedStyle(heads[0]).whiteSpace,
          timeHead: getComputedStyle(heads[1]).whiteSpace,
          statusHead: getComputedStyle(heads[heads.length - 5]).whiteSpace,
          referenceCell: getComputedStyle(body[0]).whiteSpace,
          timeCell: getComputedStyle(body[1]).whiteSpace
        }
      };
    });
  } finally {
    await page.close();
  }
}

test("the printed request log's computed column widths fill the sheet exactly", async () => {
  for (const hasPhases of [true, false]) {
    const where = hasPhases ? "with a phase column" : "without a phase column";
    const { declared, used } = await measureLog(ROUTE_SHEETS, hasPhases);
    assert.deepEqual(declared.filter((width) => !width.endsWith("%")), [], `every printed column states a share (${where})`);
    const total = declared.reduce((sum, width) => sum + Number.parseFloat(width), 0);
    assert.ok(Math.abs(total - 100) < 0.001, `the printed columns' shares add up to ${total.toFixed(3)}%, not 100% (${where})`);
    // Each column gets the share it states, so nothing is rescaled behind it.
    declared.forEach((width, index) => {
      const expected = (Number.parseFloat(width) / 100) * SHEET_WIDTH;
      assert.ok(Math.abs(used[index] - expected) < 1, `column ${index + 1} is ${used[index]} px for a stated ${width} (${where})`);
    });
  }
});

test("each phase-table share is the sheet's own share scaled by 100/106", async () => {
  // Read, not restated: the seven shares are the ones print.css computes for a
  // table without a phase column. A sum of 100 cannot see a share that moved.
  await measureLog(ROUTE_SHEETS, true);
  const shares = async (hasPhases: boolean) =>
    (await measureLog(WITHOUT_GLOBALS, hasPhases)).declared.map((width) => Number.parseFloat(width));
  const seven = await shares(false);
  const eight = await shares(true);
  assert.deepEqual([seven.length, eight.length], [7, 8], "the fixture's two logs have seven and eight columns");
  assert.ok(Math.abs(eight[2] - eight[1]) <= 0.0001, `the phase column's share ${eight[2]} is not the time column's ${eight[1]}`);
  const [reference, time, ...others] = seven;
  [reference, time, time, ...others].forEach((share, index) => {
    const expected = (share * 100) / 106;
    assert.ok(
      Math.abs(eight[index] - expected) <= 0.0001,
      `column ${index + 1}'s share ${eight[index]} is not the sheet's own share scaled by 100/106, ${expected}`
    );
  });
});

test("print.css alone gives every printed column the width both sheets give", async () => {
  for (const hasPhases of [true, false]) {
    const where = hasPhases ? "with a phase column" : "without a phase column";
    const both = await measureLog(ROUTE_SHEETS, hasPhases);
    const alone = await measureLog(WITHOUT_GLOBALS, hasPhases);
    assert.deepEqual(alone.declared, both.declared, `print.css does not own every printed column's width (${where})`);
  }
});

test("globals gives the printable request log no width of its own", async () => {
  for (const hasPhases of [true, false]) {
    const printable = await measureLog([globalsCss], hasPhases);
    const ordinary = await measureLog([globalsCss], hasPhases, "app-shell report-page-shell");
    assert.deepEqual(
      [printable.declared, printable.bodyDeclared],
      [ordinary.declared, ordinary.bodyDeclared],
      `globals.css sets a width only for the printable request log (${hasPhases ? "with" : "without"} a phase column)`
    );
  }
});

test("no printed column or table passes its sheet", async () => {
  for (const sheets of [ROUTE_SHEETS, WITHOUT_GLOBALS]) {
    for (const hasPhases of [true, false]) {
      const { tablePastSheet, columnsPastSheet } = await measureLog(sheets, hasPhases);
      assert.ok(tablePastSheet <= 0.5, `the printed request log passes its sheet by ${tablePastSheet} px`);
      assert.deepEqual(columnsPastSheet, [], "a printed column passes its sheet");
    }
  }
});

test("the printed references and times stay on one line", async () => {
  for (const hasPhases of [true, false]) {
    const { wrapping } = await measureLog(ROUTE_SHEETS, hasPhases);
    assert.deepEqual(
      wrapping,
      { referenceHead: "nowrap", timeHead: "nowrap", statusHead: "nowrap", referenceCell: "nowrap", timeCell: "nowrap" },
      "a printed reference, time or status head may wrap"
    );
  }
});

test("the printed request log's font sizes are the pinned ones", async () => {
  for (const hasPhases of [true, false]) {
    const { headFonts, bodyFonts, limitFont } = await measureLog(ROUTE_SHEETS, hasPhases);
    const columns = hasPhases ? 8 : 7;
    // 9 pt for the reference, 7.5 pt for every other cell, 8.5 pt for the limit.
    assert.deepEqual(bodyFonts, ["12px", ...Array(columns - 1).fill("10px")], "a printed cell's font size moved");
    assert.deepEqual(headFonts, Array(columns).fill("10px"), "a printed head's font size moved");
    assert.equal(Math.round(Number.parseFloat(limitFont) * 0.75 * 10) / 10, 8.5, "the printed limit's font size moved");
  }
});

/** WCAG relative-contrast of a #rrggbb value against white. */
function contrastOnWhite(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(match, `expected a #rrggbb print token, got ${hex}`);
  const channel = (offset: number) => {
    const srgb = parseInt(match[1].slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return 1.05 / (luminance + 0.05);
}

/**
 * Every class the print block hides must still be rendered by something.
 *
 * This is the direction the fixture-coverage test above cannot see. It asks
 * whether each hidden class appears in the FIXTURE, and the fixture is a
 * hand-written copy of the markup, so renaming a class in a component and
 * updating neither leaves the hide rule pointing at nothing while the test goes
 * on passing. That shipped: `.report-activation-actions` was renamed to
 * `.report-identity-actions` when the three report actions moved under the
 * title, and a printed report started showing "View site history" and "Scan
 * this exact route again" as though they were evidence.
 */
test("the print block hides classes something actually renders", () => {
  const globalsCss = readFileSync(path.join(process.cwd(), "app", "globals.css"), "utf8");
  const printBlockStart = globalsCss.indexOf("@media print {");
  const hideGroup = globalsCss.slice(
    printBlockStart,
    globalsCss.indexOf("display: none !important", printBlockStart)
  );
  const hidden = [
    ...hideGroup.replace(/\/\*(?:[^*]|\*(?!\/))*\*\//g, "").matchAll(/\.([a-z][a-z0-9-]*)/g)
  ].map((match) => match[1]);
  assert.ok(hidden.length > 5, "the hide group should have been parsed");

  const rendered = componentSources().join("\n");
  const orphaned = hidden.filter((className) => !rendered.includes(className));
  assert.deepEqual(
    orphaned,
    [],
    `the print block hides classes no component renders: ${orphaned.join(", ")}. ` +
      "Either the class was renamed and the control is now printing, or the rule is dead."
  );
});

/** Every .tsx under app/, so a rename anywhere is visible to the check above. */
function componentSources(): string[] {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) sources.push(readFileSync(full, "utf8"));
    }
  };
  walk(path.join(process.cwd(), "app"));
  return sources;
}

/**
 * The screen's active-filter line, with the sheets the report page loads. Not
 * print, but it needs what this file has: a real engine over the real sheets.
 * The explorer's sheet reverts every earlier rule on the elements inside the
 * report grid, so whether a long host wraps cannot be read from one sheet.
 */
const SCREEN_SHEETS = [
  globalsCss,
  ...["tokens", "base", "components", "report", "explorer"].map((name) =>
    readFileSync(path.join(root, "app", "_design", `${name}.css`), "utf8")
  )
];
/** A committed host's 39 unbroken characters, and the longest label DNS allows. */
const LONG_HOSTS = ["*.a79ab95c1589a13f8a4cab612bc71f9f7.com", `${"b".repeat(63)}.example`];
const FILTER_LINES = {
  host: (host: string) => `Showing only requests with this recorded host: <strong>${host}</strong>.`,
  path: (host: string) =>
    `Showing only the rows behind one attribution path: <strong>${host}</strong> to <strong>${host}</strong>.`
};

test("a filter line wraps a long host on a phone", async () => {
  const problems: string[] = [];
  for (const width of [360, 320]) {
    for (const [kind, words] of Object.entries(FILTER_LINES)) {
      for (const host of LONG_HOSTS) {
        const page = await browser.newPage({ viewport: { width, height: 800 } });
        try {
          await page.setContent(
            `<!doctype html><html><head>${SCREEN_SHEETS.map((css) => `<style>${css}</style>`).join("")}</head>
            <body><div class="app-shell report-page-shell da is-evidence-open"><main id="report">
              <section class="report-grid"><div class="report-evidence-tables">
                <details class="data-section disclosure" open>
                  <summary class="section-heading"><h2>Request log</h2></summary>
                  <p class="attribution-active-filter"><span>${words(host)}</span>
                    <button type="button" class="change-list-toggle">Clear filters</button></p>
                </details>
              </div></section>
            </main></div></body></html>`,
            { waitUntil: "load" }
          );
          const seen = await page.evaluate(() => {
            const line = document.querySelector("p.attribution-active-filter")!;
            const box = line.getBoundingClientRect();
            const words = document.createRange();
            words.selectNodeContents(line.querySelector("span")!);
            const button = line.querySelector("button")!.getBoundingClientRect();
            return {
              sheetsApply: getComputedStyle(line).marginBottom === "10px" && box.width < innerWidth,
              fits: line.scrollWidth <= line.clientWidth && [...words.getClientRects()].every((rect) => rect.right <= box.right + 0.5),
              pageScrolls: document.documentElement.scrollWidth > innerWidth,
              clearInView: button.left >= 0 && button.right <= innerWidth && button.top >= 0 && button.bottom <= innerHeight
            };
          });
          const where = `the ${kind} line at ${width} px with a host of ${host.length} characters`;
          // Without this, every reading below could describe an unstyled paragraph.
          assert.ok(seen.sheetsApply, `the fixture is not styled as the request log is (${where})`);
          if (!seen.fits) problems.push(`${where}: the words pass the line`);
          if (seen.pageScrolls) problems.push(`${where}: the page scrolls sideways`);
          if (!seen.clearInView) problems.push(`${where}: Clear filters is outside the viewport`);
        } finally {
          await page.close();
        }
      }
    }
  }
  assert.deepEqual(problems, [], "a long host does not fit the filter line");
});
