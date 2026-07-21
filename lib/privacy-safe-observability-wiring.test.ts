import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production aggregate observability wiring is committed fail-closed", async () => {
  const [worker, config, docs] = await Promise.all([
    readFile("cloudflare/container-worker.ts", "utf8"),
    readFile("wrangler.container.jsonc", "utf8"),
    readFile("docs/privacy-safe-observability.md", "utf8")
  ]);

  assert.match(worker, /url\.pathname === PRIVACY_SAFE_OBSERVABILITY_PATH/);
  assert.match(worker, /handleAggregateMetricsRequest\(request/);
  assert.match(config, /"SITE_BEHAVIOR_LAB_AGGREGATE_METRICS": "0"/);
  assert.match(config, /"binding": "AGGREGATE_METRICS"/);
  assert.match(config, /"dataset": "site_behavior_lab_aggregate_metrics"/);
  assert.match(docs, /Status: implemented but disabled/);
  assert.match(docs, /privacy page must disclose/i);
  assert.match(docs, /methodology page must identify/i);
  assert.match(docs, /Do not instrument API\/report\/profile reads/);
});
