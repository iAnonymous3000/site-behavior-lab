# Runtime Boundaries

Site Behavior Lab now has three runtime lanes:

| Lane | Entrypoints | Allowed imports | Disallowed imports |
|---|---|---|---|
| Browser client | `app/site-behavior-app.tsx`, `app/reports/[id]/saved-report-client.tsx` | React UI, type-only report contracts, pure report helpers | Node builtins, Playwright, `next/server`, Node scanner/store/gate modules |
| Cloudflare Worker | `cloudflare/worker.ts` | Worker APIs, `@cloudflare/playwright`, edge-safe pure scanner helpers | Node builtins, Node Playwright, Next server modules, Node scanner/store/gate modules |
| Node scanner/server | Next API routes, `lib/scanner.ts`, `lib/scan-api.ts`, `lib/scan-jobs.ts` | Node builtins, Playwright, filesystem report store, connect-time proxy guard | Browser-only UI imports |

The pure/shared modules are intentionally small and dependency-light: report comparison and validation, URL redaction/normalization, domain summarization, scan result assembly, runtime request recording, fingerprint observation summarization, PageGraph adaptation, and report types. They can be used from Node, Worker, or the browser when their own imports stay pure.

Node-only modules include the access-token check, filesystem report store, ad-block list loader, Node Playwright scanner, async job queue, in-process rate limits, runtime health aggregation, static-report filesystem reader, public-scan proxy, and Node DNS URL safety guard.

`lib/runtime-boundaries.test.ts` walks runtime imports from the browser and Worker entrypoints and fails if either graph reaches Node-only modules, Node builtins, or server-only packages. Type-only imports are ignored because they are erased before runtime, but new runtime helpers should still live in the narrowest lane that can own them.

Run the boundary guard with:

```bash
npm run test:unit
```
