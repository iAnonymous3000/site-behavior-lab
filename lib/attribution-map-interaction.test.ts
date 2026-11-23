import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Source contracts for two interaction defects, and an honest statement of what
 * that can and cannot prove.
 *
 * This repo renders no React in tests: there is no `renderToStaticMarkup`
 * anywhere in `lib/` or `app/`. So these read the component source, the way
 * `print-stylesheet.test.ts` reads the stylesheet. A source contract cannot
 * prove the rendered DOM is right, and it is not offered as though it could.
 * Both behaviours below were verified in a real browser against the committed
 * AP News report; these exist so the specific mistakes cannot come back
 * unnoticed, not as a substitute for that.
 *
 * Deliberately NOT written as "the file contains the fixed string", which would
 * pass against a file that merely mentions it. Each assertion names the defect
 * shape and refuses it.
 */

const root = process.cwd();
const graph = readFileSync(
  path.join(root, "app/_components/causality-graph.tsx"),
  "utf8"
);
const tables = readFileSync(
  path.join(root, "app/_components/report-tables.tsx"),
  "utf8"
);
const css = readFileSync(path.join(root, "app/globals.css"), "utf8");

/**
 * A node with several relationships has no single edge to select. Resolving
 * that by taking whichever edge sorts first is arbitrary edge selection wearing
 * a node's label, and it shipped in the first draft of this feature.
 */
test("a node cannot resolve a selection by picking whichever edge comes first", () => {
  // Scoped to the defect, not to the method. Looking an edge up BY KEY is how
  // the selected edge is resolved and must keep working; looking one up by a
  // bare endpoint is the arbitrary pick, because several edges share one.
  assert.doesNotMatch(
    graph,
    /edges\.find\(\([a-z]+\) => [a-z]+\.(?:source|dest) ===/,
    "resolving a selection from a bare endpoint picks whichever edge sorts first; nodes must not take a selection at all"
  );
  assert.match(
    graph,
    /edges\.find\(\([a-z]+\) => edgeKey\([a-z]+\) === selectedKey\)/,
    "the selected edge must still be resolved by its full key"
  );

  // The node groups must carry no click handler. Sliced rather than grepped
  // globally, so a handler on the edge paths (which are legitimately
  // selectable) cannot satisfy this by accident.
  for (const marker of ["causal-node causal-node-source", "causal-node causal-node-dest"]) {
    const start = graph.indexOf(marker);
    assert.ok(start > 0, `${marker} must exist to be checked`);
    const group = graph.slice(start, graph.indexOf("<title>", start));
    assert.doesNotMatch(
      group,
      /onClick/,
      `${marker} must be presentation-only; selection is edge-only`
    );
  }

  // And the thing that IS selectable still is, or the guard above would pass on
  // a component where nothing works.
  assert.match(
    graph,
    /attribution-edge-control/,
    "the native per-edge controls are the authoritative selection layer"
  );
});

/**
 * The attribution pair is the only filter with no control of its own: a query,
 * a signal, a status and a resource all render their own state. The pair
 * arrives from the map through the fragment, so without a visible label and a
 * clear control a successful drill-down leaves the reader behind a filter they
 * cannot see or switch off except by editing the URL.
 */
test("an applied attribution pair is stated and clearable even when rows survive", () => {
  const start = tables.indexOf('className="attribution-active-filter"');
  assert.ok(start > 0, "the active-pair label must exist");

  // The defect being refused: rendering it only in the empty state, which is
  // where the pre-existing clear control already lived. The label's immediately
  // enclosing conditional must be the pair itself, with no row-count test
  // between the guard and the label.
  assert.ok(tables.includes("shown.length === 0"), "the empty-state branch must exist to compare against");
  const guard = tables.lastIndexOf("{attributionPair && (", start);
  assert.ok(guard > 0, "the label must be guarded by the pair");
  const betweenGuardAndLabel = tables.slice(guard, start);
  assert.ok(
    betweenGuardAndLabel.length < 200 && !betweenGuardAndLabel.includes("shown.length"),
    "the active-pair label must render on the pair alone, not on an empty result"
  );

  // To the end of this line only: the next line has a clear control of its own.
  const block = tables.slice(guard, tables.indexOf("</p>", start));
  assert.match(
    block,
    /onClick=\{resetFilters\}/,
    "the label must offer the clear control, not merely describe the filter"
  );
  assert.match(
    block,
    /attributionPair\.actor[\s\S]*attributionPair\.destination/,
    "the label must name both endpoints; one endpoint does not identify a path"
  );

  // resetFilters must actually clear the fragment-borne pair. Clearing the
  // local controls alone would leave the pair applied under a button that
  // claims to have cleared it.
  // Placement is the feature. The drill-down link scrolls to the top of the
  // log, so a label rendered after the rows arrives off-screen: measured at
  // 360px it sat roughly 3,845px below the fold. A label the arriving reader
  // cannot see is the defect this block exists to fix, wearing its own fix.
  const tableRegion = tables.indexOf('className={`table-wrap request-table');
  assert.ok(tableRegion > 0, "the request table region must exist");
  assert.ok(
    start < tableRegion,
    "the active-pair label must render ABOVE the table; below the rows it lands off-screen for a reader arriving from the map"
  );

  const reset = tables.slice(
    tables.indexOf("function resetFilters()"),
    tables.indexOf("useEffect", tables.indexOf("function resetFilters()"))
  );
  assert.match(
    reset,
    /location\.hash/,
    "resetFilters must clear the fragment pair, not only the local filter state"
  );
});

/**
 * The Focus map control is gone (the owner's approval of 2026-11-15, relayed
 * by the design session): the map is laid out as blocks under the evidence's
 * full width, so there is nothing for it to widen. Nothing may offer it, and
 * no stylesheet keeps a rule for it.
 */
test("no attribution focus control is offered or styled", () => {
  assert.doesNotMatch(graph, /attribution-focus-toggle|is-focused|Focus map|Exit focus/);
  assert.doesNotMatch(css, /attribution-focus-toggle|causal-graph-card\.is-focused/);
});
