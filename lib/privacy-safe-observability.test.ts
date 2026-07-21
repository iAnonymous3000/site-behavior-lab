import assert from "node:assert/strict";
import test from "node:test";
import {
  coreWebVitalEvent,
  parsePrivacySafeObservabilityEvent,
  profileActionEvent,
  rescanActionEvent,
  routeClassFromLocation,
  routeViewEvent,
  scanFunnelEvent,
  shareActionEvent,
  type PrivacySafeObservabilityEvent
} from "./privacy-safe-observability";

const validEvents: PrivacySafeObservabilityEvent[] = [
  routeViewEvent("home"),
  coreWebVitalEvent("directory", "LCP", 1_800)!,
  scanFunnelEvent("home", "completed", "single", "desktop"),
  shareActionEvent("report", "copy-citation", "completed"),
  profileActionEvent("category", "latest-evidence-opened"),
  rescanActionEvent("site-profile", "accepted", "gpc", "mobile")
];

test("closed observability contract accepts every supported event family", () => {
  for (const event of validEvents) assert.deepEqual(parsePrivacySafeObservabilityEvent(event), event);
});

test("route classification erases host, dynamic path values, query, fragment, and base path", () => {
  assert.equal(
    routeClassFromLocation("https://secret-target.example/sites/sensitive.example/?email=a@example.test#private"),
    "site-profile"
  );
  assert.equal(
    routeClassFromLocation("/site-behavior-lab/reports/20260721-secret-id/?token=secret", "/site-behavior-lab"),
    "report"
  );
  assert.equal(routeClassFromLocation("https://sitebehavior.org/categories/health/?q=condition"), "category");
  assert.equal(routeClassFromLocation("not a valid [url"), "other");
});

test("Web Vitals retain only metric, route class, and published quality band", () => {
  assert.deepEqual(coreWebVitalEvent("home", "LCP", 2_500), {
    schemaVersion: 1,
    name: "core-web-vital",
    route: "home",
    metric: "LCP",
    rating: "good"
  });
  assert.equal(coreWebVitalEvent("home", "LCP", 2_501)?.rating, "needs-improvement");
  assert.equal(coreWebVitalEvent("home", "LCP", 4_001)?.rating, "poor");
  assert.equal(coreWebVitalEvent("report", "INP", 200)?.rating, "good");
  assert.equal(coreWebVitalEvent("report", "INP", 500)?.rating, "needs-improvement");
  assert.equal(coreWebVitalEvent("report", "INP", 501)?.rating, "poor");
  assert.equal(coreWebVitalEvent("directory", "CLS", 0.1)?.rating, "good");
  assert.equal(coreWebVitalEvent("directory", "CLS", 0.25)?.rating, "needs-improvement");
  assert.equal(coreWebVitalEvent("directory", "CLS", 0.251)?.rating, "poor");
  assert.equal(coreWebVitalEvent("home", "LCP", Number.NaN), null);
  assert.equal(coreWebVitalEvent("home", "LCP", -1), null);
});

test("unknown fields structurally forbid sensitive and free-form payloads", () => {
  const forbiddenKeys = [
    "url",
    "targetUrl",
    "domain",
    "hostname",
    "reportId",
    "jobId",
    "query",
    "queryString",
    "evidence",
    "cookie",
    "cookies",
    "userId",
    "sessionId",
    "clientId",
    "ip",
    "timestamp",
    "payload",
    "metadata",
    "properties"
  ];
  for (const event of validEvents) {
    for (const key of forbiddenKeys) {
      assert.equal(
        parsePrivacySafeObservabilityEvent({ ...event, [key]: key === "payload" ? { arbitrary: "secret" } : "secret" }),
        null,
        `${event.name} accepted forbidden ${key}`
      );
    }
  }
});

test("closed enums reject arbitrary strings, nested values, arrays, and alternate schemas", () => {
  assert.equal(parsePrivacySafeObservabilityEvent({ schemaVersion: 1, name: "route-view", route: "/secret" }), null);
  assert.equal(
    parsePrivacySafeObservabilityEvent({
      schemaVersion: 1,
      name: "scan-funnel",
      surface: "home",
      stage: "failed: https://secret.example?q=x",
      mode: "single",
      device: "desktop"
    }),
    null
  );
  assert.equal(parsePrivacySafeObservabilityEvent({ schemaVersion: 1, name: "custom", payload: "anything" }), null);
  assert.equal(parsePrivacySafeObservabilityEvent({ schemaVersion: 2, name: "route-view", route: "home" }), null);
  assert.equal(parsePrivacySafeObservabilityEvent([routeViewEvent("home")]), null);
  assert.equal(parsePrivacySafeObservabilityEvent("route-view"), null);
});

test("accessors, symbols, and custom prototypes cannot smuggle data through validation", () => {
  const accessor = { schemaVersion: 1, name: "route-view" } as Record<string, unknown>;
  Object.defineProperty(accessor, "route", { enumerable: true, get: () => "home" });
  assert.equal(parsePrivacySafeObservabilityEvent(accessor), null);

  const symbol = { ...routeViewEvent("home"), [Symbol("secret")]: "value" };
  assert.equal(parsePrivacySafeObservabilityEvent(symbol), null);

  const custom = Object.assign(Object.create({ inherited: "secret" }), routeViewEvent("home"));
  assert.equal(parsePrivacySafeObservabilityEvent(custom), null);
});
