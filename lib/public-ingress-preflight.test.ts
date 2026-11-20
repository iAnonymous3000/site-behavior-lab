import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PUBLIC_INGRESS_PREFLIGHT_REFUSAL, publicIngressPreflightRefusal } from "./public-ingress-preflight";
import { publicErrorBody, publicErrorHeaders, toPublicError } from "./public-errors";
import { PUBLIC_INGRESS_PREFLIGHT_RATE_LIMIT_PER_MINUTE } from "./public-scan-rate-limit-store";
import { requireIndex, sliceBetween } from "./source-markers";

const root = process.cwd();
test("the ceiling refuses with the gate's existing shape and a Retry-After", () => {
  assert.equal(publicIngressPreflightRefusal({ allowed: true }), null);
  const refusal = publicIngressPreflightRefusal({ allowed: false, retryAfterSeconds: 37 });
  assert.ok(refusal, "a refused charge is refused");
  const publicError = toPublicError(refusal);
  assert.equal(publicError.status, 429);
  assert.deepEqual(publicErrorBody(publicError), {
    ok: false,
    error: PUBLIC_INGRESS_PREFLIGHT_REFUSAL,
    retryAfterSeconds: 37
  }, "the body is the gate's existing refusal shape, without a cause");
  assert.deepEqual(publicErrorHeaders(publicError), { "Retry-After": "37" });
});

test("Production Health's preflights stay far under the per-client ceiling", () => {
  // The monitor's ingress step is one curl with --retry 2: at most 3 requests
  // a run. Its schedules start at minutes 7, 22, 37 and 52, so no two
  // scheduled runs share a minute, and even a dispatched run beside one keeps
  // a minute at 6 requests. The ceiling is 30.
  const workflow = readFileSync(path.join(root, ".github", "workflows", "production-health.yml"), "utf8");
  const step = sliceBetween(
    workflow,
    "- name: Probe visitor-facing ingress dependencies without submitting a scan",
    "- name: Validate availability and production posture",
    "production-health.yml"
  );
  assert.equal((step.match(/curl /g) ?? []).length, 1, "one curl per run");
  const retries = Number(/--retry (\d+)\b/.exec(step)?.[1]);
  assert.equal(retries, 2);
  const perRun = retries + 1;
  assert.equal(perRun, 3);
  assert.ok(2 * perRun <= PUBLIC_INGRESS_PREFLIGHT_RATE_LIMIT_PER_MINUTE / 5, "two runs in one minute use at most a fifth of the ceiling");
  assert.equal(PUBLIC_INGRESS_PREFLIGHT_RATE_LIMIT_PER_MINUTE, 30);
});

test("the scan form does not call the ingress preflight", () => {
  // The per-client ceiling was set for the monitor alone. No page or client
  // module may read the route, or one visitor's ordinary use would spend it.
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx|js|mjs)$/.test(name)) sources.push(full);
    }
  };
  walk(path.join(root, "app"));
  walk(path.join(root, "lib"));
  assert.ok(sources.length > 100, "the walk reached the client sources");
  const callers = sources.filter((file) => readFileSync(file, "utf8").includes("/api/health/public-ingress"));
  assert.deepEqual(callers, []);
});

test("the Worker charges the preflight before answering it, for a GET with no query string only", () => {
  const worker = readFileSync(path.join(root, "cloudflare", "container-worker.ts"), "utf8");
  const start = requireIndex(worker, 'url.pathname === "/api/health/public-ingress"', "container-worker.ts");
  const route = worker.slice(worker.lastIndexOf("if (", start), worker.indexOf("\n    }\n", start) + 6);
  assert.match(route, /request\.method === "GET" && url\.pathname === "\/api\/health\/public-ingress" && !url\.search/);
  const charge = route.indexOf("chargePublicIngressPreflight(request, env)");
  const answer = route.indexOf("publicIngressPreflightResponse(request, env)");
  assert.ok(charge !== -1, "the route must take the charge");
  assert.ok(charge < answer, "the charge comes before the preflight answers");
});
