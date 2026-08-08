import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
      <div class="topbar-actions" id="topbaractions">
        <button class="icon-button" id="iconbutton" type="button">theme</button>
      </div>
    </header>
    <main>
      <div class="report-actions" id="reportactions"><button type="button">Download CSV</button></div>
      <div class="headline-actions" id="headlineactions"><button type="button">Share</button></div>
      <div class="report-activation-actions" id="activationactions"><a href="#">Scan again</a></div>
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
        <div id="logbody">recorded request rows</div>
      </details>
      <p class="muted disclosure-lazy-note" id="lazynote">Open the request log to render its rows.</p>
      <button class="change-list-toggle" id="difftoggle" type="button">Show all 14</button>
      <section class="causal-graph">
        <h3 class="visually-hidden print-text-equivalent" id="mapheading">Relationships shown in the causal map</h3>
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
      <span class="app-footer-caveat" id="caveat">Reports use one completed automated visit per condition.</span>
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
  "topbaractions",
  "iconbutton",
  "skiplink",
  "reportactions",
  "headlineactions",
  "activationactions",
  "loader",
  "count",
  "chevron",
  "tools",
  "chips",
  "filter",
  "logbody",
  "lazynote",
  "difftoggle",
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
  // The text equivalent of the causal map: the SVG may not survive page width.
  assert.equal(visible.mapheading, true, "the causal map text equivalent must print");
  assert.equal(visible.maplist, true, "the causal map relationship list must print");
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
  assert.equal(visible.topbaractions, false, "topbar controls are not evidence");
  assert.equal(visible.iconbutton, false, "the theme toggle is not evidence");
  assert.equal(visible.skiplink, false, "the skip link is not evidence");
  assert.equal(visible.reportactions, false, "report action buttons are not evidence");
  assert.equal(visible.headlineactions, false, "headline action buttons are not evidence");
  assert.equal(visible.activationactions, false, "activation links are not evidence");
  assert.equal(visible.tools, false, "filter tooling is not evidence");
  assert.equal(visible.chips, false, "request signal filter chips are not evidence");
  assert.equal(visible.filter, false, "a search box is not evidence");
  assert.equal(visible.chevron, false, "a disclosure chevron is decoration");
  assert.equal(visible.receiptlinks, false, "link buttons carry no text on paper");
  assert.equal(visible.footerlinks, false, "footer navigation is not evidence");
  assert.equal(visible.armswitcher, false, "the arm switcher is a control; its print-only replacement carries the fact");

  // The exemption must be opt-in. If .visually-hidden were simply revealed,
  // these two would print as body copy.
  assert.equal(visible.newtab, false, "screen-reader link qualifiers must not print");
  assert.equal(visible.live, false, "live-region status text must not print");
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
