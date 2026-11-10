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
| `pageReady(page)` | The page exists and is still `about:blank`. What is and is not installed then is listed below. | The visit's scan deadline. The time the hook takes comes out of the time the visit has to load its page. |
| `initScript` | The scanner adds it with `page.addInitScript` right after `pageReady`, before its own fingerprint observer. | The scan deadline. |
| `finalFingerprintRead(collection)` | The moment the scanner makes its own final fingerprint read. The collection is a copy. | Nothing: the hook is synchronous and the scanner does not wait. A hook that returns a promise fails the visit. |
| `afterEnvelope(read)` | The visit's result and its envelope are built, and the page is still open. A check after scrolling has not begun. The hook is handed readings only and holds no reference to the result, which is why it cannot change it. The result object itself is not frozen; the envelope and its measurement are. | `afterEnvelopeTimeoutMs`: 1,000 to 600,000 ms, and 30,000 ms when absent. |
| `scrollCheckBoundary(boundary, readFingerprint)` | At each of a check's four boundaries: `check-start`, `control-start`, `control-end`, `scroll-end`. | The check's own deadline. `scrollCheckDeadlineMarginMs` replaces that deadline's margin for this visit: 2,000 to 600,000 ms. It can lengthen the deadline and never shorten it. |

When `pageReady` is called, these are already installed: the bounded page collector's init script (and the script that captures consent shadow roots, when the visit's consent mode is not `observe` or consent verification is on); on a GPC visit, its binding, header and init script; the page's crash listener; the scanner's attribution session over DevTools, with its handler for `Network.requestWillBeSent` and the network domain enabled; the request listener that counts each request for the initiator index; the worker witness; and the worker realm channel, which installs the fingerprint observer in each worker. The attribution session and the worker realm channel are best effort: a visit goes on without either. These are not installed yet: the fingerprint observer's init script for documents, the context and page routes, the request and response recorders, and the popup closer.

For a caller this means one thing above all: make no request from the page in `pageReady`. A request made there is not in the report's request log, and no route sees it, so the route's checks do not apply to it and it is not counted against the visit's request budget, though it still goes through the scan proxy and its guard. The attribution session and the initiator index do count it. The index gives a URL an initiator only when every observation of that URL agrees, so such a request can leave the visit's own later request for the same URL without one.

`afterEnvelope` receives three readings: the page's fingerprint observations by source (each frame in turn, then the worker realms together), the visit's request budget and its proxy's budgets as they stand, and the value of one expression evaluated in every frame. A boundary callback receives one: the page's fingerprint observations at that moment.

Every wait also ends as soon as the caller's `signal` is aborted. A wait that the scan deadline or a timeout ends leaves no listener on that signal: the visit takes its seam's listeners off on every way out. A hook that throws fails the visit with its own error, after the visit's ordinary cleanup. A boundary callback that the check's deadline ends leaves the check cut short at that boundary. The use record keeps that call with no time, and nothing the callback does after that changes the use record or fails the visit. The exception to the cut is `scroll-end`: both windows have closed by then, so the check keeps its outcome.

A boundary callback's time falls in a fixed place. For `check-start` it falls in the settle. For `control-start` it falls before the window with no input opens, in no window. For `control-end` it falls at the end of that window, which is longer by it. For `scroll-end` it falls after the scroll window has closed.

### Where the init script runs

In each document the seam's script runs after the scanner's bounded page collector and before its fingerprint observer. The observer therefore wraps over whatever the seam's script wraps. A call the page makes reaches the observer's wrapper first and the seam's wrapper second, so a logger in the seam's script sees the observer's frame between itself and the page's own script. The first investigation's patch added its script at the same point.

Playwright does not document the order in which init scripts run. `lib/investigation-seam-fixture.test.ts` pins the order at the Playwright version in use, so a version that changes it fails that test.

### Nothing public can reach it

- `lib/runtime-boundaries.test.ts` fails if any source file under `app/`, `cloudflare/`, `lib/` or `scripts/`, or at the root, names the seam, its key, or anything that `lib/investigation-seam.ts` or `lib/seam-visit-mark.ts` exports. The three files that may are those two and `lib/scanner.ts`. Each module that refuses a seam visit is listed in that test with the helper it calls, and may name that helper and nothing else. Test files are not swept.
- The scan API refuses options that carry the field, before the visit starts.
- Every public caller of the scanner but one also has a refusal on its path at run time: `/api/scan`, the scan jobs and the A/A acquirer go through the scan API; the calibration runtime, the pixel screening script and the qualification acquirer go through the runtime builders. The one without is `scripts/repeatability-run.mjs`, which calls `scanSite` with no options and writes counts. It cannot set the seam without naming it, so the sweep is what holds it, and nothing else does.
- A visit that sets no seam runs the statements it always ran. Every use of the seam in the scanner and in the check sits behind a condition on its presence, which `lib/investigation-seam-guard.test.ts` holds. `lib/visit-setup-calls.test.ts` holds the list of what such a visit registers on its context and page.

### A seam visit is never published

The scanner marks a seam visit in two ways. By identity: it remembers the envelope the visit returns, its result and its measurement. In band: the result and the measurement each carry the key `investigationSeamVisit`, which a structured clone, a JSON copy and an object spread all keep. A visit that sets no seam has neither mark: no key and no value.

One check, `isSeamVisit` in `lib/seam-visit-mark.ts`, decides whether a value is a seam visit's or holds one. It finds a mark, by identity or in band, in exactly these places: on the value itself; on one of its top-level members; and, for a value with a `baseline` or a `variant` (a v1 comparison), on one of that member's own members. That covers a result, an envelope around a result and a measurement, and a comparison of two results. It does not cover a mark deeper than that (on one request record, say), a marked result inside any other wrapper (an array of results, an object two levels up), or an object rebuilt from a result's fields by hand. A job envelope is not one of the shapes: the transport reader unwraps it and applies the check again to the report inside.

Every step in `lib/` and `scripts/` that can turn a visit's result, or a JSON copy of one, into something stored, published, exported, printed or sent is one of these or sits behind one of these. Each calls the check before it reads anything else of the value. The tests are in `lib/investigation-seam.test.ts`, named here by how their names begin.

| Step | Answer for a marked input | What goes through it | Test |
|---|---|---|---|
| `executePreparedScan`, at its one call of a runner | Throws. Options that carry the field are refused before the runner starts, and a returned seam visit before anything is derived. | `/api/scan`, the scan jobs and their durable path, the A/A acquirer | "the scan API refuses a seam visit and every copy of one", "the scan API starts no visit whose options carry the seam", "the public path hands a runner exactly the options it always did" |
| `buildRuntimeScanReportV2R2`, `buildRuntimeComparisonScanReportV2R2` | Throws. | The scan API when it builds r2, shadow emission, the calibration runtime (so the calibration acquirer and the pixel screening script), the qualification acquirer | "both runtime builders refuse a seam visit and every copy of one" |
| `prepareScanReportBundle` | Throws. | `saveScanReport`, a durable job's publication, the qualification acquirer | "the report store refuses a seam visit's result and every copy of one" |
| `writeV2ShadowArtifact` | Throws. | Shadow emission | "the shadow store refuses a seam visit's result and every copy of one" |
| `redactScanReportV1`, `redactScanResultV1` | Throws. | The report store, the public projector, the scan API's fallback when a save fails, the managed reader's fixed-point check, remediation and privacy replacement. The scanner's own result builder calls it too, on a result that has no mark yet: a seam visit is marked after its result is built. | "the v1 redactor refuses a seam visit's result and every copy of one" |
| `toPublicScanReportV1` | Throws. | `publicWireForExportOrPersistence`, which every export calls and which calls this for a v1 report: the viewer's download, the publish CLI, `scripts/scanner-fidelity-invariants.mjs`. For an r2 report that function returns what a runtime builder made or a reader returned, and each of those has answered already; the two acquirers' exports are of that kind. | "the v1 public projector refuses a seam visit's result and every copy of one" |
| `readScanTransportPayload` | Answers `unreadable` with `invalid`, also for the report inside a job envelope. Never throws. | The viewer, for everything it opens: a scan's response, a finished job's report, a saved report, a gallery load, an opened file and an export's source; the publish CLI; `scripts/scanner-fidelity-invariants.mjs`; the qualification acquirer when it reopens what it saved | "both readers decline a payload that carries the mark", "the publish CLI refuses a JSON copy of a seam visit's result" |
| `readStoredScanReport` | Answers `invalid`. Never throws. | What reads a stored report, among them: the managed reader (`invalid-report`), so the report store's reads (`unreadable`), the static corpus and its publication checks; the remediation plan and the remediation Worker (`invalid-report`, with the report's ID); the remediation and corrections CLIs (an error that names the file); a durable job's recovery; the shadow verifier and aggregate; the pinned reports | "both readers decline a payload that carries the mark", "a stored report that carries the key is a declared failure that names the report", "the report store answers unreadable for a stored report that gained the key" |

`lib/runtime-boundaries.test.ts` reads this table against the code: the functions it lists are exactly the functions that call the check, and each test it names exists. A step added without a row, or a row left behind, fails that test.

The first six take a value in the process and throw `SeamVisitRefusal`. The two readers take what was parsed from a file or a response, and answer as they answer for any payload that is not a report, so a viewer, a CLI or a Worker that meets a stored report with the key declines it by name and goes on.

Three things have no refusal of their own, and need none. The functions that make a v1 comparison keep their two results by reference, so the next step refuses it. The view builders in `lib/scan-report-views.ts` are for display: each of their callers hands them what one of the two readers returned, and nothing stores, exports or sends a view. And `scripts/repeatability-run.mjs`, as said above, cannot set the seam.

The redactor and the projector build their output field by field, so their output could not carry the mark. That is why each refuses a marked input before it reads anything from it: to sanitize or project a seam visit's result and then save it fails at the first step. The mark and its check live in `lib/seam-visit-mark.ts`, which imports nothing, because the redactor, the projector and the readers also run in the browser and in a Worker.

The mark does not survive a caller who removes it on purpose. There are two ways to do that: to delete the key from a copy, and to build a new object by hand from a marked result's fields, without the key, before any of the steps above has seen the result. Neither is stopped, and nothing here claims otherwise.

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
