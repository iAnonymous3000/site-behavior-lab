# PageGraph Corpus: Phase 0 Spike

Working proof of the pipeline proposed in
[pagegraph-corpus-db-proposal.md](pagegraph-corpus-db-proposal.md): PageGraph
GraphML in, DuckDB-queryable fact tables out, with both flagship queries
answered end to end. This is the proposal's Phase 0 ("Pete's two queries
answered end to end"), demonstrated on the repository's PageGraph fixture; the
same command ingests real crawl exports when we have them.

## Run it

```sh
npm run corpus:pagegraph -- --out /tmp/pg-corpus \
  --rule "||tags.example.net^" \
  lib/__fixtures__/pagegraph/schema-provenance.graphml
```

Ingests each GraphML file through the existing schema-aware parser
(`lib/pagegraph-parser.ts`) and writes to `--out`:

- The fact tables from proposal section 7 as CSV: `page`, `node`, `edge`,
  `request`, `provenance_edge`, `storage_op` (value-blind: key presence and
  byte counts, never values), `js_call`.
- `bootstrap.sql`: DuckDB schema + `COPY` loads + the `closure_edge` view.
- `query-rule-impact.sql` (flagship 1) and `query-cross-site-storage.sql`
  (flagship 2).
- With `--rule`: `directly_blocked.csv` (matched by the vendored Brave adblock
  engine, the same engine Shields simulation uses) and `impact-report.json`
  (the TypeScript closure), plus a one-line summary.

Then:

```sh
cd /tmp/pg-corpus
duckdb corpus.duckdb < bootstrap.sql
duckdb corpus.duckdb < query-rule-impact.sql
duckdb corpus.duckdb < query-cross-site-storage.sql
```

## What the spike proves

Against the fixture graph (an injected loader chain: loader script creates a
script element, which loads `tags.example.net/tag.js`, which fires a
`tracker.example/collect` beacon, writes `seen-banner` to localStorage, and
calls `HTMLCanvasElement.toDataURL`), blocking `||tags.example.net^` reports:

- 1 directly blocked request (the tag script),
- 1 downstream-removed request (the tracker beacon: it only exists because the
  blocked script loaded),
- 1 removed storage write and 1 removed canvas call,
- no first-party breakage risk; re-rooting the page onto the tag CDN's domain
  flips `breakage_risk` to true.

The TypeScript closure (`simulateRuleImpact` in `lib/pagegraph-corpus.ts`) and
the SQL recursive closure (`query-rule-impact.sql` over `closure_edge`) return
the same numbers; both are covered by `lib/pagegraph-corpus.test.ts`, and the
SQL path was validated in DuckDB 1.5.

## Closure semantics (and their limits)

Blocking a request removes its resource node, the script it delivered (the
derived `script_of` relation, needed because PageGraph attributes execution to
the injector rather than the resource), and everything reachable over the
structural causal edges (`execute`, `create node`, `insert node`,
`request start`). Storage writes and JS calls are removed when their acting
script is removed; their target nodes (the storage area, the web API) are
never themselves "removed".

The counterfactual is structural, not behavioral (proposal section 12): it
predicts what would not load, not JS error cascades. Requests without
provenance closure-match nothing, per the "never treat no-provenance as
no-downstream" rule; the ingest warns when a page yields no requests.

## What Phase 0 does not include

Everything the proposal defers: real crawl data (the open Q1: reuse a Brave
PageGraph crawl of the top 1k CRUX), versioned Parquet snapshots with pinned
list/Chromium versions, the CI gate, the dashboard, and CDP breadth fallback.
The fact-table schema here is the proposal's, minus the `crawl` snapshot
dimension, which is added when ingestion moves beyond single ad hoc runs.
