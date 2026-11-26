import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readStoredScanReport } from "./scan-report-reader";

const root = process.cwd();

test("retired legacy scan API routes are removed or return 410 Gone pointing to /api/v3/scan", () => {
  const legacyScanRoute = readFileSync(path.join(root, "app", "api", "scan", "route.ts"), "utf8");
  assert.match(legacyScanRoute, /status:\s*410/);
  assert.match(legacyScanRoute, /migration:\s*"\/api\/v3\/scan"/);
  assert.match(legacyScanRoute, /cause:\s*"feature-unavailable"/);
  assert.match(legacyScanRoute, /"cache-control":\s*"no-store"/);
  assert.match(legacyScanRoute, /"x-content-type-options":\s*"nosniff"/);
  assert.match(legacyScanRoute, /export function OPTIONS/);
  assert.doesNotMatch(legacyScanRoute, /runScanRequest|submitScanJobRequest|prepareDurableScanJobRequest/);

  assert.equal(existsSync(path.join(root, "app", "api", "scans", "[id]", "route.ts")), false);
  assert.equal(existsSync(path.join(root, "app", "api", "internal", "durable-scans")), false);

  const worker = readFileSync(path.join(root, "cloudflare", "container-worker.ts"), "utf8");
  assert.match(worker, /function retiredLegacyScanApiResponse/);
  assert.match(worker, /status:\s*410/);
  assert.match(worker, /decodedPathname === "\/api\/scan"/);
  assert.match(worker, /decodedPathname\.startsWith\("\/api\/scans\/"\)/);
  assert.match(worker, /decodedPathname === "\/api\/v3\/scan"/);
});

test("historical committed v1/v2 archive reports remain readable after retiring legacy producers", () => {
  const indexPath = path.join(root, "public", "reports", "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as { reports: Array<{ id: string }> };
  assert.ok(index.reports.length > 0, "committed historical report index must remain populated");

  const sampleId = index.reports[0].id;
  const raw = readFileSync(path.join(root, "public", "reports", `${sampleId}.json`), "utf8");
  const parsed = readStoredScanReport(JSON.parse(raw));
  assert.equal(parsed.ok, true, `historical report ${sampleId} must remain readable`);
});
