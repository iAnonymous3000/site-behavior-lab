# PageGraph Adapter Note

## Purpose

The internal Brave-oriented seam is `ScanResult`, not the Playwright scanner.
`lib/pagegraph-adapter.ts` defines a normalized PageGraph ingestion shape and
maps it into the same report contract consumed by the comparison engine, UI,
JSON export, report store, and static gallery. `lib/pagegraph-parser.ts`
provides a schema-aware GraphML bridge for real PageGraph node/edge shapes, with
a tolerant fallback for older synthetic fixtures and ad hoc PageGraph-style
exports.

This keeps the existing Playwright scanner useful as a portable external mode
while allowing Brave-owned crawl data to become the higher-fidelity internal
source.

## Adapter Input

The adapter expects normalized observations:

- target conditions: requested URL, final URL, crawl time, browser version,
  user agent, viewport, GPC state, egress label, and catalog metadata
- network observations: URL, method, resource type, status, optional domain,
  timing, and optional provenance
- request provenance: graph record id, initiator actor, script URL/domain, and
  injector URL/domain when the PageGraph export exposes them
- cookie observations with values already excluded
- storage key observations with value byte counts, not values
- high-entropy API or fingerprinting-related event summaries
- optional screenshot and warnings

The parser is intentionally conservative. When it sees real PageGraph
`node type` / `edge type` keys, it extracts requests from `resource` nodes,
pairs `request start` and `request complete` / `request error` edges by
`request id`, and walks actor → script → injector edges to fill request
provenance. It also reads schema-shaped `storage set` and `js call` edges for
storage and high-entropy API summaries. If those schema keys are absent, it
falls back to the older tolerant parser that looks for request/storage/API hints
on arbitrary records.

The real PageGraph GraphML vocabulary (node/edge types, attribute keys, and the
provenance traversal) is documented in [pagegraph-schema.md](pagegraph-schema.md).
The schema-shaped harness under `lib/__fixtures__/pagegraph/` is still synthetic;
replace it with a real Brave export plus versioned `meta.json` before claiming
parser fidelity against production data.

## Catalog Injection

The PageGraph adapter accepts an optional `trackerMatcher` and
`trackerCatalog`. Brave/internal integrations should pass Brave-owned list or
entity data here instead of falling back to the bundled curated catalog.

## Comparison Path

`createComparisonReport` is comparison-type agnostic. Existing GPC comparisons
still use `createGpcComparisonReport`; Brave-oriented code can call
`createShieldsComparisonReport` or `createTemporalComparisonReport` for Shields
off/on and before/after artifacts. Comparisons also include optional causal path
diffs when both reports include request provenance, so a Shields or temporal
report can show which script/request relationships appeared or disappeared
instead of only showing count deltas.

The committed fixture reports under `public/reports/` include a PageGraph-backed
single report and a Shields comparison so the static evidence library exercises
the new path.
