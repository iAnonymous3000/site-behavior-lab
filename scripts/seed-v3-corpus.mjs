#!/usr/bin/env node
/**
 * Fresh v3 corpus seeder script for Site Behavior Lab 2.0.
 *
 * Scans a curated list of URLs (or URLs passed via CLI / JSON file) using the
 * clean-slate v3 concurrent CDP scanner, persists redacted `ScanReportV3` JSON
 * into the configured `BlobStoreV3` (R2 or local FS), and indexes metadata
 * into `D1ReportIndexStoreV3`.
 *
 * Usage:
 *   node scripts/seed-v3-corpus.mjs --url https://example.com --url https://mozilla.org
 *   node scripts/seed-v3-corpus.mjs --featured --limit 10 --region us-east --compare shields-standard,gpc
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const urls = [];
  let featured = false;
  let limit = 15;
  let region = "auto";
  let device = "desktop";
  let comparisons = ["shields-standard", "gpc"];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) {
      urls.push(argv[++i]);
    } else if (arg === "--featured") {
      featured = true;
    } else if (arg === "--limit" && argv[i + 1]) {
      limit = Math.max(1, Number(argv[++i]) || 15);
    } else if (arg === "--region" && argv[i + 1]) {
      region = argv[++i];
    } else if (arg === "--device" && argv[i + 1]) {
      device = argv[++i];
    } else if (arg === "--compare" && argv[i + 1]) {
      comparisons = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return { urls, featured, limit, region, device, comparisons };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = [...opts.urls];

  if (opts.featured || targets.length === 0) {
    const raw = JSON.parse(await readFile(path.join(ROOT, "public/featured-sites.json"), "utf8"));
    const entries = Array.isArray(raw.sites) ? raw.sites : [];
    for (const entry of entries) {
      if (entry?.scanAvailability?.status === "temporarily-unavailable") continue;
      if (typeof entry?.url === "string") targets.push(entry.url);
      if (targets.length >= opts.limit) break;
    }
  }

  // Compile TypeScript sources once into .unit-test-dist so Node executes the exact v3 scanner.
  const tscBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  execFileSync(tscBin, ["-p", "tsconfig.test.json"], {
    cwd: ROOT,
    stdio: "inherit"
  });

  const require = createRequire(import.meta.url);
  const { scanSiteV3, closeSharedBrowserV3 } = require(path.join(ROOT, ".unit-test-dist/lib/v3/scanner/index.js"));
  const { getV3RuntimeContext } = require(path.join(ROOT, ".unit-test-dist/lib/v3/runtime/store-context.js"));
  const { dispatchScanV3 } = require(path.join(ROOT, ".unit-test-dist/lib/v3/runtime/worker-dispatch.js"));
  const { saveReportV3 } = require(path.join(ROOT, ".unit-test-dist/lib/v3/storage/blob-store.js"));

  const ctx = await getV3RuntimeContext();
  let succeeded = 0;
  let failed = 0;

  try {
    for (const url of targets.slice(0, opts.limit)) {
      const started = Date.now();
      try {
        const { report } = await dispatchScanV3(
          {
            url,
            device: opts.device,
            comparisons: opts.comparisons,
            acquisition: "ci-corpus"
          },
          {
            region: opts.region,
            upstreams: ctx.regionalUpstreams,
            defaultExecutor: (req) => scanSiteV3(req)
          }
        );
        const r2Key = await saveReportV3(ctx.blobStore, report);
        await ctx.reportIndex.indexReport(report, { r2Key, visibility: "corpus" });
        succeeded += 1;
        console.log(
          `[ok] ${report.canonicalDomain} (${report.reportId}) — ${report.leadArm.summary.thirdPartyDomains} 3P domains, ${Date.now() - started}ms`
        );
      } catch (err) {
        failed += 1;
        console.error(`[fail] ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await closeSharedBrowserV3();
    ctx.close();
  }

  console.log(`v3 corpus seeding finished: ${succeeded} succeeded, ${failed} failed (data dir: ${ctx.dataDir})`);
  if (succeeded === 0 && failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
