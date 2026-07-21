import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateMetricsDataPoint,
  handleAggregateMetricsRequest,
  type AggregateMetricsDataPoint
} from "./privacy-safe-observability-edge";
import {
  profileActionEvent,
  routeViewEvent,
  scanFunnelEvent,
  shareActionEvent
} from "./privacy-safe-observability";

const ENDPOINT = "https://scan.sitebehavior.org/api/metrics";
const ORIGIN = "https://sitebehavior.org";

function request(body: unknown, overrides: RequestInit = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...overrides
  });
}

function sink() {
  const points: AggregateMetricsDataPoint[] = [];
  return {
    points,
    dataset: { writeDataPoint: (point: AggregateMetricsDataPoint) => points.push(point) }
  };
}

test("edge collector is a hard 404 while disabled and fails closed without binding or exact origin", async () => {
  const event = routeViewEvent("home");
  assert.equal((await handleAggregateMetricsRequest(request(event), {})).status, 404);
  assert.equal(
    (await handleAggregateMetricsRequest(request(event), { enabledFlag: "1", allowedOrigin: ORIGIN })).status,
    503
  );
  assert.equal(
    (
      await handleAggregateMetricsRequest(request(event), {
        enabledFlag: "1",
        allowedOrigin: "*",
        dataset: sink().dataset
      })
    ).status,
    503
  );
  assert.equal(
    (
      await handleAggregateMetricsRequest(
        request(event, { headers: { Origin: "https://attacker.example", "Content-Type": "application/json" } }),
        { enabledFlag: "1", allowedOrigin: ORIGIN, dataset: sink().dataset }
      )
    ).status,
    403
  );
});

test("edge collector writes only fixed categories and a unit count", async () => {
  const events = [
    routeViewEvent("directory"),
    scanFunnelEvent("home", "accepted", "blocker", "mobile"),
    shareActionEvent("dataset", "copy-citation", "completed"),
    profileActionEvent("search", "opened")
  ];
  const receiver = sink();
  for (const event of events) {
    const result = await handleAggregateMetricsRequest(request(event), {
      enabledFlag: "1",
      allowedOrigin: ORIGIN,
      dataset: receiver.dataset
    });
    assert.equal(result.status, 204);
    assert.equal(result.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
  assert.deepEqual(receiver.points, events.map(aggregateMetricsDataPoint));
  for (const point of receiver.points) {
    assert.deepEqual(point.indexes, ["site-behavior-lab-v1"]);
    assert.deepEqual(point.doubles, [1]);
    assert.equal(JSON.stringify(point).includes("sitebehavior.org"), false);
  }
});

test("edge collector rejects query strings, malformed bodies, unknown fields, wrong media, and oversized bodies", async () => {
  const config = { enabledFlag: "1", allowedOrigin: ORIGIN, dataset: sink().dataset };
  const withQuery = new Request(`${ENDPOINT}?report=secret`, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(routeViewEvent("home"))
  });
  assert.equal((await handleAggregateMetricsRequest(withQuery, config)).status, 404);
  assert.equal(
    (await handleAggregateMetricsRequest(request({ ...routeViewEvent("home"), reportId: "secret" }), config)).status,
    400
  );
  assert.equal(
    (
      await handleAggregateMetricsRequest(
        new Request(ENDPOINT, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "application/json" },
          body: "{"
        }),
        config
      )
    ).status,
    400
  );
  assert.equal(
    (
      await handleAggregateMetricsRequest(
        new Request(ENDPOINT, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "text/plain" },
          body: JSON.stringify(routeViewEvent("home"))
        }),
        config
      )
    ).status,
    415
  );
  assert.equal(
    (
      await handleAggregateMetricsRequest(
        new Request(ENDPOINT, {
          method: "POST",
          headers: { Origin: ORIGIN, "Content-Type": "application/json" },
          body: JSON.stringify({ ...routeViewEvent("home"), padding: "x".repeat(400) })
        }),
        config
      )
    ).status,
    413
  );
});

test("edge collector supports narrow preflight and never falls back when the aggregate sink throws", async () => {
  const preflight = new Request(ENDPOINT, { method: "OPTIONS", headers: { Origin: ORIGIN } });
  const preflightResult = await handleAggregateMetricsRequest(preflight, {
    enabledFlag: "1",
    allowedOrigin: ORIGIN,
    dataset: sink().dataset
  });
  assert.equal(preflightResult.status, 204);
  assert.equal(preflightResult.headers.get("access-control-allow-methods"), "POST, OPTIONS");

  const failed = await handleAggregateMetricsRequest(request(routeViewEvent("home")), {
    enabledFlag: "1",
    allowedOrigin: ORIGIN,
    dataset: { writeDataPoint: () => { throw new Error("unavailable"); } }
  });
  assert.equal(failed.status, 503);
  assert.equal(await failed.text(), "");
});
