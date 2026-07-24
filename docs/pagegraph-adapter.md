# PageGraph Adapter Note

## Public producer

The browser-facing importer produces a public ScanReport v2 revision 2, not a
legacy `ScanResult`. A user selects exactly two same-stem files: a bounded
GraphML artifact and its `.meta.json` sidecar. `lib/pagegraph-client-import.ts`
reads both locally in the tab, and `lib/pagegraph-v2-r2-builder.ts` emits one
single-run, passive-load r2 report.

The browser picker accepts at most 16 MiB of GraphML and 256 KiB of metadata so
decoding and the synchronous strict parser remain bounded on everyday devices.
The server/parser retains its separate 32 MiB historical artifact ceiling for
existing managed data; that storage compatibility limit is not a browser
allocation budget.

The r2 producer is deliberately request-only. It extracts request URL, method,
resource type, status, navigation-relative timestamp, catalog label, and
script/actor provenance when the graph supplies it. Cookies, storage,
fingerprinting, detector output, and consent verification are not inferred from
an upload: every one is recorded as censored with a
`detail: "pagegraph-unsupported", count: 0` sentinel. That zero is a versioned
availability marker for a family the producer never collected, not an observed
absence and not an interrupted capture. A censored request family, by contrast,
must declare a positive exact omitted count in the sidecar.

The strict r2 path accepts PageGraph schema `0.7.7` and fails closed on missing
or duplicate graph identities, keys, fields, non-canonical timestamps, or
structural limits. It requires the current root GraphML `<desc>` and binds its
schema version, `is_root=true`, root-frame URL, capture date, and start/end
interval to the sidecar. The sidecar's artifact byte length and lowercase
SHA-256 digest bind the selected file. Browser/environment conditions,
pagegraph-crawl and sanitizer identities, and quality/coverage declarations
remain sidecar testimony rather than cryptographic or artifact-derived
attestation, and the report says so.

Arbitrary local uploads omit `sourceArtifactDigest` from the public report to
avoid making two separately shared reports linkable by their raw-file hash.
The committed sanitized fixture opts into that digest only for repository
provenance. The exact app build commit comes from trusted compile-time build
provenance, never from the untrusted sidecar.

## Legacy utilities

`lib/pagegraph-adapter.ts` and the tolerant exports in
`lib/pagegraph-parser.ts` remain legacy/internal compatibility utilities for
older synthetic fixtures and tests. They can normalize caller-supplied cookie,
storage, and fingerprint summaries into v1 `ScanResult`, and they retain a
heuristic fallback when schema keys are absent. They are not the public upload
producer and must not be used to describe the current r2 contract. The strict
r2 entry point reuses only request normalization and does not materialize
unused storage or JavaScript-event summaries.

The real PageGraph GraphML vocabulary (node/edge types, attribute keys, and the
provenance traversal) is documented in [pagegraph-schema.md](pagegraph-schema.md).
The small `schema-*` harnesses under `lib/__fixtures__/pagegraph/` remain
synthetic golden cases. `real-wikipedia-2026-07-19.graphml` is a bounded,
sanitized subgraph from a live Brave Nightly capture, and its adjacent
`real-wikipedia-2026-07-19.meta.json` binds the exact committed bytes to the
browser, PageGraph, capture-tool, condition, and sanitization provenance. The
unredacted capture is intentionally not committed: PageGraph request headers
and storage results can contain client IP, geolocation, and fresh cookie
identifiers.

### Real-fixture capture receipt

- Captured `https://www.wikipedia.org/` at `2026-07-19T23:47:29.150Z`
  with a clean checkout of official `brave/pagegraph-crawl` package `1.2.13`
  at `7f48717737906e81ae5993bee34a9abe4c2caca6` (lockfile SHA-256
  `e80f96152a3f49dd16442b5b55e9025eb5bd340981c9e5e7393bcc2f37ea72e5`).
  The CLI banner at that revision is stale and reports `1.2.1`; the sidecar
  records the package version tied to the lockfile and source revision.
- Browser: Brave Nightly `151.1.94.81`, Chromium `151.0.7922.34`, PageGraph
  schema `0.7.7`; 15-second dwell, Shields down, GPC enabled, `en-US`,
  `America/Los_Angeles`, desktop window `1365x768`, direct unpinned egress,
  headful, and the capture tool's disposable bundled profile.
- The private raw graph was 3,251,469 bytes with SHA-256
  `1dc75405e30e0c6858d4913f9c5bf54822ffe7cda43ace63ede4b46e432604cc`.
  That digest is provenance for the non-committed source only; it is not an
  importable or remotely attestable artifact.
- Sanitizer `pagegraph-public-fixture@1` retained the behavior edge families,
  every retained edge endpoint, the explicit target root, and the
  `create node` / `insert node` edges for request and execution actors, all in
  capture order. It replaced all 10 header payloads, four script sources, 13
  JS-argument payloads, and 26 JS/storage result or write values. The committed
  graph is 27,149 bytes with SHA-256
  `5f3a2fd225f871508aa6141f6d78ae141ec0d750a2c57048ba97902c3b694885`.
- The retained graph has 36 nodes and 81 edges: five request starts paired to
  five completions, four script executions, 13 JS calls, ten storage reads,
  three storage writes, and one storage delete. `xmllint` accepted it, all
  retained timestamps are nonnegative integer navigation-relative
  milliseconds, and a forbidden-field scan found no local paths, header or
  cookie values, client IP/geolocation values, authorization values, or private
  query data.

## Capabilities and limits

The public importer emits one single observation and does not mint GPC,
Shields, consent, or temporal comparisons. It uses the bundled curated tracker
catalog and caller-managed local output; it does not perform DNS navigation or
store the raw artifact. Optional causal UI is available only when retained
requests contain human-readable actor/script provenance. Otherwise the report
explicitly says it can show requests but not script-to-request causality.

Raw PageGraph captures can include sensitive headers, storage identifiers,
local paths, or page-controlled values. The committed real fixture is a bounded
sanitized artifact; do not treat arbitrary raw captures as safe to publish.
