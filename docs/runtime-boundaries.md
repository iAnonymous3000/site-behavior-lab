# Runtime Boundaries

Site Behavior Lab now has three runtime lanes:

| Lane | Entrypoints | Allowed imports | Disallowed imports |
|---|---|---|---|
| Browser client | `app/site-behavior-app.tsx`, `app/reports/[id]/saved-report-client.tsx`, `lib/pagegraph-client-import.ts`, `lib/pagegraph-v2-r2-builder.ts` | React UI, browser-only PageGraph import/build code, type-only report contracts, pure report helpers | Node builtins, Playwright, `next/server`, Node scanner/store/gate modules |
| Cloudflare Worker | `cloudflare/container-worker.ts`, `cloudflare/r2-remediation-worker.ts`, `cloudflare/r2-delete-canary-worker.ts`, `cloudflare/investigation-worker.ts` | Worker APIs, `@cloudflare/containers` for production ingress, edge-safe pure helpers | Node builtins, Node Playwright, Next server modules, Node scanner/store/gate modules |
| Node scanner/server | Next API routes, `lib/scanner.ts`, `lib/scan-api.ts`, `lib/scan-jobs.ts` | Node builtins, Playwright, filesystem or R2 report storage, connect-time proxy guard | Browser-only UI imports |

The pure/shared modules are intentionally small and dependency-light: report comparison and validation, URL redaction/normalization, domain summarization, scan result assembly, runtime request recording, fingerprint observation summarization, PageGraph adaptation, and report types. They can be used from Node, Worker, or the browser when their own imports stay pure.

Node-only modules include the access-token check, filesystem/R2 report stores, ad-block list loader, Node Playwright scanner, async job queue, in-process rate limits, runtime health aggregation, static-report filesystem reader, public-scan proxy, and Node DNS URL safety guard. The production Containers front Worker separately owns Turnstile and atomic quota enforcement, the IDs-only recovery registry, and the gated durable-job, sharding, and encrypted-watch coordination paths; those edge responsibilities do not move into Node.

`lib/runtime-boundaries.test.ts` walks runtime imports from all four Worker entrypoints and all four browser entrypoints listed above. It fails if either graph reaches Node-only modules, Node builtins, or server-only packages. Type-only imports are ignored because they are erased before runtime, but new runtime helpers should still live in the narrowest lane that can own them.

`cloudflare/investigation-worker.ts` and `investigation/` are a separate, private deployment: an owner-only workspace behind Cloudflare Access, which today denies everything and which nothing deploys. No public artifact includes them. The same test walks every file under `app/`, the other Workers and the build config and fails if any reaches them, and walks the workspace's own entrypoint to show the edge it is looking for exists.

Run the boundary guard with:

```bash
npm run test:unit
```

## The investigation seam

The scanner has one optional connection for a private capture: the field `investigationSeam` of a visit's options, defined in `lib/investigation-seam.ts`. A caller that sets it gives the scanner hooks, and the scanner calls them at fixed points of that one visit. It exists so that the private workspace can run the real scanner at a recorded commit, in place of a patch applied to a copy of it. The seam is not a runner. It starts no browser, visits nothing on its own, and stores nothing.

### The hooks

In the order a visit reaches them:

| Field | When the scanner calls it | What bounds the wait |
|---|---|---|
| `pageReady(page)` | The page exists and is still `about:blank`. The scanner's own DevTools clients are attached. Its fingerprint observer, routes and recorders are not yet installed. | The visit's scan deadline. The time the hook takes comes out of the time the visit has to load its page. |
| `initScript` | The scanner adds it with `page.addInitScript` right after `pageReady`, before its own fingerprint observer. | The scan deadline. |
| `finalFingerprintRead(collection)` | The moment the scanner makes its own final fingerprint read. The collection is a copy. | Nothing: the hook is synchronous and the scanner does not wait. A hook that returns a promise fails the visit. |
| `afterEnvelope(read)` | The visit's result is built and frozen, and the page is still open. A check after scrolling has not begun. | `afterEnvelopeTimeoutMs`: 1,000 to 600,000 ms, and 30,000 ms when absent. |
| `scrollCheckBoundary(boundary, readFingerprint)` | At each of a check's four boundaries: `check-start`, `control-start`, `control-end`, `scroll-end`. | The check's own deadline. `scrollCheckDeadlineMarginMs` replaces that deadline's margin for this visit: 2,000 to 600,000 ms. It can lengthen the deadline and never shorten it. |

`afterEnvelope` receives three readings: the page's fingerprint observations by source (each frame in turn, then the worker realms together), the visit's request budget and its proxy's budgets as they stand, and the value of one expression evaluated in every frame. A boundary callback receives one: the page's fingerprint observations at that moment.

Every wait also ends as soon as the caller's `signal` is aborted. A hook that throws fails the visit with its own error, after the visit's ordinary cleanup. A boundary callback that the check's deadline ends leaves the check cut short at that boundary. The exception is `scroll-end`: both windows have closed by then, so the check keeps its outcome.

A boundary callback's time falls in a fixed place. For `check-start` it falls in the settle. For `control-start` it falls before the window with no input opens, in no window. For `control-end` it falls at the end of that window, which is longer by it. For `scroll-end` it falls after the scroll window has closed.

### Where the init script runs

In each document the seam's script runs after the scanner's bounded page collector and before its fingerprint observer. The observer therefore wraps over whatever the seam's script wraps. A call the page makes reaches the observer's wrapper first and the seam's wrapper second, so a logger in the seam's script sees the observer's frame between itself and the page's own script. The first investigation's patch added its script at the same point.

Playwright does not document the order in which init scripts run. `lib/investigation-seam-fixture.test.ts` pins the order at the Playwright version in use, so a version that changes it fails that test.

### Nothing public can reach it

- `lib/runtime-boundaries.test.ts` fails if any source file under `app/`, `cloudflare/`, `lib/` or `scripts/`, or at the root, names the seam. The two exceptions are `lib/investigation-seam.ts` and `lib/scanner.ts`. Test files are not swept.
- The scan API refuses options that carry the field, before the visit starts.
- A visit that sets no seam runs the statements it always ran. Every use of the seam in the scanner and in the check sits behind a condition on its presence, which `lib/investigation-seam-guard.test.ts` holds. `lib/visit-setup-calls.test.ts` holds the list of what such a visit registers on its context and page.

### A seam visit is never published

The scanner marks a seam visit in two ways. By identity: it remembers the envelope the visit returns, its result and its measurement. In band: the result and the measurement each carry the key `investigationSeamVisit`, which a structured clone, a JSON copy and an object spread all keep. A visit that sets no seam has neither mark: no key and no value.

The scan API, both runtime report builders, the report store and the shadow store refuse a value that carries either mark, on itself or on a top-level member. One level is what the publishable shapes need: an envelope holds its result and measurement, and a v1 comparison holds its two results.

The mark does not survive two things. One is a caller who deletes the key from a copy on purpose. The other is code that builds a new object from named fields, as the v1 sanitizer does: its output does not carry the key. Neither is stopped, and nothing here claims otherwise.

### What a runner records

`describeInvestigationSeam(seam)` gives a seam's description without running anything: which hooks are set, the init script's sha256 over its UTF-8 bytes (never its text), and the two bounds as they apply. `investigationSeamUse(envelope)` gives, for a visit that returned, that same description and how long each hook call took by the scanner's own clock.

1. Before a visit, store the description. A visit that throws returns no envelope, so the description is then the only record.
2. After a visit that returns, store the use.
3. Store each beside the scanner's commit.

### Limits

- A check that does not complete its scroll window calls no `scroll-end`, so it gives no last reading. This covers a page with nothing to scroll, a page that was never scrolled, a page that left its site and a check that was cut short.
- `pageReady` hands over a page. It does not hand over the browser's DevTools port.
- A seam visit uses the process's shared scan browser, like any visit. To isolate a browser for each attempt is the caller's job. Nothing in the scanner does it.
- A read that a hook makes can change what the visit's own later reads see. A fingerprint read at a boundary and an expression evaluated in frames are two such reads. A hook also holds the live page and can do anything with it. For both reasons, a seam visit's envelope is never comparable with a public report's.
- `finalFingerprintRead` observes a tentative read. A visit whose page then leaves its site discards that read. A visit whose page had already left does not make it, and so does not call the hook.
