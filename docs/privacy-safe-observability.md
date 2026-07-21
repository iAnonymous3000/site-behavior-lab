# Privacy-safe aggregate observability

**Status: implemented but disabled.** The reference deployment must keep both
`SITE_BEHAVIOR_LAB_AGGREGATE_METRICS` and
`NEXT_PUBLIC_SITE_BEHAVIOR_LAB_AGGREGATE_METRICS` unset or `0` until every
activation gate below is complete. Disabled edge collection is a hard `404`.
A missing or failed aggregate binding produces `503`; it never falls back to a
log, database, local storage, cookie, or queued retry.

This system answers a deliberately narrow set of product questions: which route
classes are useful, whether Core Web Vitals are in published quality bands, and
where the scan/share/profile/rescan funnels lose users. It is not visitor
analytics and cannot answer who a visitor is, which site they inspected, or
which report they read.

## Privacy boundary

The browser can send exactly one event at a time from the closed contract in
[`lib/privacy-safe-observability.ts`](../lib/privacy-safe-observability.ts).
Unknown keys, arbitrary strings, nested payloads, alternate schema versions,
accessors, symbols, and custom prototypes are rejected. The contract has no
field for:

- a target URL, host or domain;
- a route path, dynamic segment, query string or fragment;
- a report, scan, job, watch, corpus or correction identifier;
- evidence, request data, errors, page text or search terms;
- cookies, storage values or browser fingerprints;
- an IP address, user/client/session identifier or timestamp; or
- arbitrary metadata, properties or free-form payloads.

Dynamic routes are reduced in memory to a class such as `report` or
`site-profile`; the underlying path is discarded. Raw Web Vital values are
reduced in memory to `good`, `needs-improvement` or `poor`; the number is
discarded. The client sends with `credentials: "omit"`, `referrerPolicy:
"no-referrer"`, no retry, and no local persistence. Global Privacy Control or
Do Not Track opts the browser out before any request.

The event endpoint is derived only from the already-approved scan API origin;
there is no configurable third-party analytics hostname. The production edge
accepts only the exact configured HTTPS front-door origin, one JSON event per
request, and a maximum 320-byte body. Cloudflare necessarily processes ordinary
connection metadata while providing the site and edge, but the application does
not write that metadata into the metrics dataset or attach it to an event.

## Closed event vocabulary

| Event | Stored dimensions |
|---|---|
| `route-view` | route class |
| `core-web-vital` | route class, `LCP`/`INP`/`CLS`, quality band |
| `scan-funnel` | fixed surface, stage, mode and desktop/mobile class |
| `share-action` | fixed surface, channel and outcome |
| `profile-action` | fixed source and action |
| `rescan-action` | report/profile surface, stage, mode and device class |

No server-side report/profile read emits an event. Initial instrumentation must
cover explicit user actions only. If route views or Core Web Vitals are added,
instrumentation must call `routeClassFromLocation` first and may pass only its
enum result—not `location`, `pathname`, a URL object, route parameters or report
data—to the event factory.

## Aggregate storage layout

Cloudflare Analytics Engine is the selected deployment-compatible sink. It is
bound as `AGGREGATE_METRICS` and remains inert behind the edge flag. A validated
event becomes one data point:

- `index1`: `site-behavior-lab-v1`;
- `blob1`: event name;
- `blob2` through `blob5`: event-specific closed enum dimensions; and
- `double1`: `1`.

The sink receives nothing else. Counts are directional product evidence, not a
security, billing, scientific-sample, or unique-visitor measure. The public
endpoint has no secret, so automated traffic can distort counts; dashboards
must say so and must never label event counts as people or unique visitors.

Example seven-day aggregate query:

```sql
SELECT
  blob1 AS event_name,
  blob2 AS dimension_1,
  blob3 AS dimension_2,
  blob4 AS dimension_3,
  blob5 AS dimension_4,
  SUM(_sample_interval) AS event_count
FROM site_behavior_lab_aggregate_metrics
WHERE timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY blob1, blob2, blob3, blob4, blob5
ORDER BY event_count DESC
```

Do not export raw rows. Dashboard and scheduled-report queries must return only
grouped counts. Suppress any public cell below 20 events, and do not combine
dimensions to infer a browsing sequence.

## Activation gates

All gates are mandatory:

1. The privacy page must disclose the fixed aggregate event classes, Cloudflare
   as processor/sink, no cookies/identifiers/target/report data, GPC/DNT opt-out,
   and the current retention chosen by the operator. It must continue to say
   there are no analytics **profiles** or cross-site tracking cookies, not claim
   that no aggregate measurements exist.
2. The methodology page must identify event counts as untrusted directional
   product telemetry, not unique visitors, research evidence, or scan evidence.
3. A reviewer must compare every call site with the contract. Event factories
   may receive only enum literals and Web Vital numbers; they must never receive
   a report object, scan request, target, route params, exception or page text.
4. Do not instrument API/report/profile reads, scanner/container execution,
   background refreshes, imported reports, scheduled watches or synthetic
   monitors. Do not add automatic error capture.
5. Create a Cloudflare WAF rate rule for exact path `/api/metrics`: allow `POST`
   and `OPTIONS`, rate-limit each source to 60 requests per minute, and block for
   10 minutes. The WAF may use IP transiently; the application must not receive,
   hash or persist it for metrics.
6. Build a private dashboard using grouped queries only. Add the caveats above
   and a visible generated-at time. Do not expose the Analytics Engine query API
   token to the browser.
7. Run the unit, Cloudflare typecheck and endpoint smoke checks below. Capture a
   screenshot or query result proving that only the documented columns exist.
8. Obtain a privacy/reputation review of the page copy, dashboard and event call
   sites before either feature flag changes.

Suggested truthful privacy-page copy before activation:

> The reference site uses optional, first-party aggregate product measurements
> to learn whether broad route classes load quickly and whether anonymous scan,
> share, profile and rescan actions succeed. Events contain only fixed categories;
> they never contain the site or URL scanned, a report or job identifier, query
> strings, evidence, cookies, page text, IP/user/session identifiers, or free-form
> fields. The application sets no analytics cookie and does not build visitor
> profiles. Global Privacy Control and Do Not Track disable these events. Cloudflare
> processes the request and stores only the fixed categories plus an aggregate
> count for the disclosed retention period.

Suggested methodology-page copy before activation:

> Aggregate product events are operational UX measurements, not scan evidence.
> They use closed route/action/performance categories, contain no target or report
> identity, and can be distorted by automation. Counts are directional events,
> never unique visitors, people, prevalence estimates or research observations.

## Safe activation order

1. Keep the committed Worker flag at `0` and deploy the edge/binding once.
2. Confirm disabled behavior:

   ```bash
   curl -i -X POST https://scan.sitebehavior.org/api/metrics \
     -H 'Origin: https://sitebehavior.org' \
     -H 'Content-Type: application/json' \
     --data '{"schemaVersion":1,"name":"route-view","route":"home"}'
   ```

   Expected: `404`, no data point.
3. Add reviewed client call sites, but leave the Pages build flag unset. Confirm
   browsers send no `/api/metrics` requests.
4. Publish the reviewed privacy and methodology disclosure, WAF rule and private
   dashboard.
5. Change `SITE_BEHAVIOR_LAB_AGGREGATE_METRICS` to `1`, deploy the edge, and
   repeat the request. Expected: `204` and one fixed-dimension point. Verify that
   an unknown `reportId` key returns `400` and writes nothing.
6. In Cloudflare Pages production variables set
   `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_AGGREGATE_METRICS=1`, then rebuild the exact
   reviewed commit. The client derives `/api/metrics` from
   `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE`.
7. Verify GPC and DNT browsers send no event and ordinary browsers send only the
   documented fixed JSON. Verify product actions still work when the endpoint is
   blocked or returns `503`.

Run before activation:

```bash
npx tsc -p tsconfig.test.json
node --test --test-concurrency=1 \
  .unit-test-dist/lib/privacy-safe-observability.test.js \
  .unit-test-dist/lib/privacy-safe-observability-client.test.js \
  .unit-test-dist/lib/privacy-safe-observability-edge.test.js \
  .unit-test-dist/lib/privacy-safe-observability-wiring.test.js
npm run cf:typecheck
```

## Kill switch

If the contract, disclosure, sink or dashboard is in doubt:

1. Remove/unset `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_AGGREGATE_METRICS` in Pages and
   rebuild so browsers stop sending.
2. Set `SITE_BEHAVIOR_LAB_AGGREGATE_METRICS` to `0` and deploy the Worker so the
   endpoint becomes a hard `404`.
3. Do not capture rejected bodies or substitute request logs. Investigate using
   synthetic fixed-enum events only.
