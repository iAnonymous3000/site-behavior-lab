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

/** Mirrors the real report shell closely enough for the print cascade. */
const FIXTURE = `<!doctype html>
<html><head><style>${globalsCss}</style></head>
<body>
  <div class="app-shell report-page-shell">
    <header class="topbar"><nav class="topbar-nav" id="nav">nav</nav></header>
    <main>
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
          <input class="filter-input" id="filter" type="search" />
        </div>
        <div id="logbody">recorded request rows</div>
      </details>
      <p class="muted disclosure-lazy-note" id="lazynote">Open the request log to render its rows.</p>
      <section class="causal-graph">
        <h3 class="visually-hidden print-text-equivalent" id="mapheading">Relationships shown in the causal map</h3>
        <ol class="visually-hidden print-text-equivalent" id="maplist"><li>3 requests to example.test</li></ol>
      </section>
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
</body></html>`;

const PROBED_IDS = [
  "nav",
  "loader",
  "count",
  "chevron",
  "tools",
  "filter",
  "logbody",
  "lazynote",
  "mapheading",
  "maplist",
  "receiptlinks",
  "newtab",
  "live",
  "footerlinks",
  "caveat",
  "printfooter"
] as const;

type ProbedId = (typeof PROBED_IDS)[number];

let browser: Browser;
let visible: Record<ProbedId, boolean>;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
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
});

test("controls and screen-reader scaffolding stay off paper", () => {
  assert.equal(visible.nav, false, "site navigation is not evidence");
  assert.equal(visible.tools, false, "filter tooling is not evidence");
  assert.equal(visible.filter, false, "a search box is not evidence");
  assert.equal(visible.chevron, false, "a disclosure chevron is decoration");
  assert.equal(visible.receiptlinks, false, "link buttons carry no text on paper");
  assert.equal(visible.footerlinks, false, "footer navigation is not evidence");

  // The exemption must be opt-in. If .visually-hidden were simply revealed,
  // these two would print as body copy.
  assert.equal(visible.newtab, false, "screen-reader link qualifiers must not print");
  assert.equal(visible.live, false, "live-region status text must not print");
});

test("the fixture exercises every class the print block hides", () => {
  const printBlockStart = globalsCss.indexOf("@media print {");
  assert.ok(printBlockStart > 0, "the print block must exist");
  const hideGroup = globalsCss.slice(printBlockStart, globalsCss.indexOf("display: none !important", printBlockStart));

  const hidden = [...hideGroup.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]);
  assert.ok(hidden.length > 5, "the hide group should have been parsed");

  const missing = hidden.filter((className) => !FIXTURE.includes(className));
  assert.deepEqual(
    missing,
    [],
    `the print fixture does not exercise: ${missing.join(", ")}. Add markup for it or this test stops covering the rule.`
  );
});
