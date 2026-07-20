# PageGraph GraphML Schema Reference

Authoritative vocabulary for the real Brave PageGraph GraphML export, so the
`lib/pagegraph-parser.ts` real-schema path and its golden fixtures are mapped
against PageGraph as it actually emits, not against a hand-guessed shape.

> **Source.** Extracted from Brave's own parser, `brave/pagegraph-rust`
> (`pagegraph/src/types.rs`, `pagegraph/src/from_xml.rs`) on 2026-06-19. PageGraph's
> schema is versioned and tracks Chromium/Brave; treat the string literals below
> as current-`main` and re-confirm against the `meta.json` version recorded with
> any committed real export. See the [PageGraph wiki](https://github.com/brave/brave-browser/wiki/PageGraph)
> and [pagegraph-rust types](https://docs.rs/pagegraph/latest/pagegraph/types/).

## How a real PageGraph graph is shaped

- It is GraphML. Every `<node>`/`<edge>` carries its kind in a **`<data>` whose
  key resolves to `attr.name="node type"` or `attr.name="edge type"`**, two
  distinct keys, not one shared `type`.
- **Nodes are actors/actees** (a script, an HTML element, a fetched resource, a
  storage area, a Web API). **Edges are actions** (this script started this
  request; this script created that element; this script called that Web API).
- A network request is **not** a single edge with a URL on it. It is a
  `resource` node (which holds the `url`) connected by `request start` /
  `request complete` / `request error` edges to the actor that caused it.

## Attribute keys (`attr.name`)

`node type`, `edge type`, `url`, `tag name`, `node id`, `is deleted`, `text`,
`script type`, `script id`, `source`, `method`, `frame id`, `rule`, `binding`,
`binding type`, `binding event`, `parent`, `before`, `value`, `args`,
`script position`, `resource type`, `status`, `response hash`, `request id`,
`headers`, `size`, `key`, `event listener id`, `attr name`, `is style`,
`timestamp`.

Note: `method` is the **Web API / JS-builtin name** on those nodes, it is **not**
an HTTP verb. PageGraph does not record GET/POST on request edges (see caveats).

## Node types (26)

| `node type` literal | key fields |
| --- | --- |
| `resource` | `url` |
| `script` | `url?`, `script type`, `script id`, `source` |
| `HTML element` | `tag name`, `node id`, `is deleted` |
| `text node` | `text?`, `node id`, `is deleted` |
| `DOM root` | `url?`, `tag name`, `node id`, `is deleted` |
| `frame owner` | `tag name`, `node id`, `is deleted` |
| `parser` |, |
| `web API` | `method` (API name) |
| `JS builtin` | `method` (builtin name) |
| `local storage` / `session storage` / `cookie jar` / `storage` |, |
| `remote frame` | `frame id` |
| `binding` / `binding event` | `binding`, `binding type` / `binding event` |
| `ad filter` | `rule` |
| `tracker filter` / `fingerprinting filter` |, |
| `Brave Shields`, `ads shield`, `trackers shield`, `javascript shield`, `fingerprinting shield`, `fingerprintingV2 shield` |, |
| `extensions` |, |

## Edge types (31)

Requests: `request start` (`request type`, lifecycle `status`, `request id`),
`request complete` (`resource type`, lifecycle `status`, `request id`, `response hash`,
`headers`, `size`, `value?`), `request error` (`status`, `request id`, …),
`request response`.

In the current `0.7.7` capture, request-edge `status` values are lifecycle
tokens such as `started` and `complete`, not HTTP response codes. The importer
therefore records HTTP status as unavailable (`null`) rather than inventing a
numeric response status.

Causality / JS: `execute`, `execute from attribute` (`attr name`), `js call`
(`args`, `script position`), `js result` (`value?`).

DOM: `create node`, `insert node` (`parent`, `before?`), `remove node`,
`delete node`, `text change`, `set attribute` (`key`, `value?`, `is style`),
`delete attribute`, `structure`, `cross DOM`.

Storage: `storage set` (`key`, `value?`), `read storage call` (`key`),
`storage read result` (`key`, `value?`), `delete storage`, `clear storage`,
`storage bucket`.

Events: `add event listener` (`key`, `event listener id`, `script id`),
`remove event listener`, `event listener`.

Filtering: `filter`, `shield`, `resource block`. Bindings: `binding`,
`binding event`.

## Provenance traversal → `NetworkRequestProvenance`

For each `resource` node reached by a `request start` edge, let `actor` be the
**source node of that `request start` edge**:

| `NetworkRequestProvenance` field | How to derive it |
| --- | --- |
| request `domain` / `url` | host / value of the `resource` node's `url` |
| `graphRecordId` | the `resource` node id (or the `request id`) |
| `initiatorId` | `actor` node id |
| `initiatorType` | `actor`'s `node type` (`script`, `HTML element`, `parser`, `DOM root`, `frame owner`) |
| `initiatorUrl` / `initiatorDomain` | `actor.url` when `actor` is a `script`; absent for an `HTML element` (describe by `tag name`) |
| `scriptId` | if `actor` is `script` → its `script id`; if `actor` is an `HTML element` → walk the incoming `create node`/`insert node` edge to its source `script` node |
| `scriptUrl` / `scriptDomain` | that script node's `url` |
| `injectedById` | source of the `execute` (or `execute from attribute`) edge whose target is the attributed script node, i.e. the script/parser that caused it to run |
| `injectedByUrl` / `injectedByDomain` | that injecting node's `url`; mark first-party/document when the source is `parser`/`DOM root` |

The injector chain is the payoff: `resource ← request start ← actor (element or
script) ← create node / execute ← injecting script ← execute ← … ← parser`.
Walking `execute` edges upward gives "third-party script X injected script Y
which fetched tracker Z".

Completion/type pairing: pair `request start` and `request complete`/`request error`
by `request id`. `resource type` comes from the completion edge; its `status`
is a lifecycle/completion state, so the current schema does not supply an HTTP
response code. Storage and fingerprint events carry their own provenance too, the
`storage set` / `js call` edge's source script attributes who set the key or
called the Web API.

## Historical gaps in the legacy synthetic fixture and tolerant fallback

Checked against `lib/pagegraph-parser.test.ts` `SAMPLE_GRAPHML` and the tolerant
fallback parser. These were the concrete deltas that the current real-schema
path, provenance harness, and committed real capture close; the legacy
heuristic fallback alone still cannot establish them:

1. **Type key.** The fixture uses one `attr.name="type"`; real exports use **two**
   keys, `node type` and `edge type`. A real export keyed on `type` yields nothing.
2. **No `resource` nodes.** The fixture puts `url`/`method`/`status`/`resource
   type` directly on a `request start` edge pointing at a `script` node. Real
   exports put the `url` on a `resource` node; the edge carries `request id` /
   `request type` / `status` only.
3. **No request-id pairing.** Final `status` and `resource type` live on a
   separate `request complete` edge joined by `request id`; the fixture has none.
4. **Initiators are script-only.** Real initiators are frequently `HTML element`
   nodes, requiring the implemented `create node`/`insert node` walk to reach
   the script; the schema harness and real fixture exercise this path.
5. **No injector chain in the old sample.** Its missing `execute`/`create node`
   edges could never populate `injectedById`/`injectedByUrl`/`injectedByDomain`;
   the synthetic provenance golden now covers that specific chain.
6. **HTTP method is invented.** The fixture sets `method=GET/POST`; PageGraph has
   no HTTP verb on request edges. Map `request type` → `resourceType`; leave
   `NetworkRequestRecord.method` defaulted/absent for PageGraph-sourced reports.
7. **Storage shape.** The fixture models a `local storage set` *node*; real
   exports use a `local storage`/`cookie jar` *node* plus `storage set` *edges*
   from the writing script (so storage carries provenance too).
8. **Fingerprint calls.** The fixture reads an `api` attribute off a `js call`
   edge; real exports name the API on the **target `web API`/`JS builtin`
   node's `method`**, with the `js call` edge carrying `args`/`script position`.

## What a real fixture must capture

When refreshing a real export under `lib/__fixtures__/pagegraph/`, prefer a
controlled public fixture page whose graph contains a **dynamically injected
third-party script that then fetches a resource**. That single path exercises
`request start` → `resource`, `create node`/`execute` for the script, and the
`execute` injector hop, which is what proves `initiatorId` / `scriptId` /
`injectedById` and the script/injector domains all populate. If a live public
site is used instead, commit only a deterministic bounded subgraph: remove
request/response headers, storage values, JS arguments/results, and script
source; inspect URLs and retained fields for identifiers; and bind the exact
committed bytes and sanitization rules in a versioned sidecar. Never commit the
raw graph merely to claim real-capture coverage.

`real-wikipedia-2026-07-19.graphml` is the first such real-capture fixture. It
proves the current Brave schema against real request pairing, Blink resource
types, parser/element initiators, script execution, JS calls, and storage
mutations. Wikipedia did not produce a dynamically injected third-party
request in this passive visit, so the synthetic provenance golden remains the
test for that specific chain; this schema note records the limitation
explicitly.

See also [pagegraph-adapter.md](pagegraph-adapter.md) for the adapter contract
that consumes this.
