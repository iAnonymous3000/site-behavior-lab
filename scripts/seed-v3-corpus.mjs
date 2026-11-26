#!/usr/bin/env node
/**
 * Fresh v3 corpus seeder script for Site Behavior Lab 2.0.
 *
 * Modes:
 *  1. Runtime mode (default): scans target URLs with the v3 concurrent CDP
 *     scanner, writes redacted `ScanReportV3` JSON to the configured
 *     `BlobStoreV3` (R2 or local FS), and indexes metadata in
 *     `D1ReportIndexStoreV3` (Cloudflare D1 HTTP or local SQLite).
 *  2. Public seed mode (`--public-seed`): scans a curated, diverse set of live
 *     public websites, verifies redaction + secret-scanner safety + v3 schema,
 *     and writes compact committed seed files under `public/v3/`:
 *       - `public/v3/reports/<reportId>.json` (minified, redacted ScanReportV3)
 *       - `public/v3/manifest.json` (SHA-256 verified seed manifest)
 *       - `public/v3/corpus-snapshot.json` (static corpus stats + rows + vendor index)
 *     Completely disjoint from legacy `public/reports/` and `public/transparency-log.json`.
 *
 * Usage:
 *   node scripts/seed-v3-corpus.mjs --public-seed
 *   node scripts/seed-v3-corpus.mjs --url https://example.com --url https://mozilla.org
 *   node scripts/seed-v3-corpus.mjs --featured --limit 10 --region us-east --compare shields-standard,gpc
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Curated diverse baseline spanning reference, news, health, gov, education, search & commerce. */
const DEFAULT_PUBLIC_SEED_URLS = [
  "https://example.com/",
  "https://www.mozilla.org/",
  "https://www.wikipedia.org/",
  "https://duckduckgo.com/",
  "https://www.theguardian.com/",
  "https://www.bbc.com/",
  "https://www.npr.org/",
  "https://www.nytimes.com/",
  "https://www.usatoday.com/",
  "https://www.cnn.com/",
  "https://www.webmd.com/",
  "https://www.healthline.com/",
  "https://www.clevelandclinic.org/",
  "https://www.cdc.gov/",
  "https://www.nasa.gov/",
  "https://www.weather.gov/",
  "https://www.medicare.gov/",
  "https://www.target.com/",
  "https://www.khanacademy.org/",
  "https://pbskids.org/"
];

const FORBIDDEN_SECRET_PATTERNS = [
  /eyJhbGci[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /sk_live_[A-Za-z0-9]{16,}/
];

function parseArgs(argv) {
  const urls = [];
  let featured = false;
  let publicSeed = false;
  let limit = 20;
  let region = "auto";
  let device = "desktop";
  let comparisons = ["shields-standard", "gpc"];
  let outDir = path.join(ROOT, "public", "v3");
  let syncRuntime = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url" && argv[i + 1]) {
      urls.push(argv[++i]);
    } else if (arg === "--featured") {
      featured = true;
    } else if (arg === "--public-seed") {
      publicSeed = true;
    } else if (arg === "--sync-runtime") {
      syncRuntime = true;
    } else if (arg === "--out-dir" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg === "--limit" && argv[i + 1]) {
      limit = Math.max(1, Math.min(50, Number(argv[++i]) || 20));
    } else if (arg === "--region" && argv[i + 1]) {
      region = argv[++i];
    } else if (arg === "--device" && argv[i + 1]) {
      device = argv[++i];
    } else if (arg === "--compare" && argv[i + 1]) {
      comparisons = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  return { urls, featured, publicSeed, limit, region, device, comparisons, outDir, syncRuntime };
}

function assertNoSecretPatterns(rawJson, domain) {
  for (const re of FORBIDDEN_SECRET_PATTERNS) {
    if (re.test(rawJson)) {
      throw new Error(`Refusing to persist seeded report for ${domain}: matched forbidden secret pattern ${re}`);
    }
  }
}

async function resolveTargets(opts) {
  const targets = [...opts.urls];
  if (targets.length > 0) return targets.slice(0, opts.limit);
  if (opts.publicSeed) return DEFAULT_PUBLIC_SEED_URLS.slice(0, opts.limit);

  const raw = JSON.parse(await readFile(path.join(ROOT, "public/featured-sites.json"), "utf8"));
  const entries = Array.isArray(raw.sites) ? raw.sites : [];
  for (const entry of entries) {
    if (entry?.scanAvailability?.status === "temporarily-unavailable") continue;
    if (typeof entry?.url === "string") targets.push(entry.url);
    if (targets.length >= opts.limit) break;
  }
  return targets;
}

async function runPublicSeed(opts, modules, targets) {
  const {
    scanSiteV3,
    closeSharedBrowserV3,
    dispatchScanV3,
    redactScanReportV3,
    assertNoUnredactedSecretsV3,
    validateScanReportV3,
    extractAllArmEntitiesV3,
    openNodeSqliteReportIndex,
    reportBlobKeyV3,
    getV3RuntimeContext,
    saveReportV3
  } = modules;

  const reportsDir = path.join(opts.outDir, "reports");
  await mkdir(reportsDir, { recursive: true });

  const { store: memIndex, close: closeMemIndex } = await openNodeSqliteReportIndex(":memory:");
  const staged = [];
  const entityDomains = new Map();
  const parentOrgDomains = new Map();
  const entitySiteStats = new Map();
  const parentOrgSiteStats = new Map();
  let failed = 0;

  try {
    for (const url of targets) {
      const started = Date.now();
      try {
        const { report: rawReport } = await dispatchScanV3(
          {
            url,
            device: opts.device,
            comparisons: opts.comparisons,
            acquisition: "ci-corpus"
          },
          {
            region: opts.region,
            upstreams: [],
            defaultExecutor: (req) => scanSiteV3(req)
          }
        );

        const httpStatus = rawReport.leadArm.httpStatus;
        if (rawReport.leadArm.loadOutcome !== "ok" || (typeof httpStatus === "number" && httpStatus >= 400)) {
          failed += 1;
          console.warn(
            `[skip] ${rawReport.canonicalDomain}: loadOutcome=${rawReport.leadArm.loadOutcome} status=${httpStatus}`
          );
          continue;
        }

        const clean = redactScanReportV3(rawReport);
        assertNoUnredactedSecretsV3(clean);
        const schemaIssues = validateScanReportV3(clean);
        if (schemaIssues.length > 0) {
          throw new Error(`Schema validation failed: ${schemaIssues.join("; ")}`);
        }

        const serialized = JSON.stringify(clean);
        assertNoSecretPatterns(serialized, clean.canonicalDomain);
        const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");

        await memIndex.indexReport(clean, {
          r2Key: reportBlobKeyV3(clean.reportId),
          visibility: "corpus"
        });

        const allEntities =
          clean.leadArm.network.length > 0 ? extractAllArmEntitiesV3(clean.leadArm) : clean.leadArm.summary.topEntities;
        const parentAgg = new Map();
        for (const ent of allEntities) {
          const eSet = entityDomains.get(ent.entity) ?? new Set();
          eSet.add(clean.canonicalDomain);
          entityDomains.set(ent.entity, eSet);

          const eStats = entitySiteStats.get(ent.entity) ?? [];
          eStats.push({
            domain: clean.canonicalDomain,
            requests: ent.requests,
            domains: ent.domains,
            category: ent.category
          });
          entitySiteStats.set(ent.entity, eStats);

          const pSet = parentOrgDomains.get(ent.parentOrg) ?? new Set();
          pSet.add(clean.canonicalDomain);
          parentOrgDomains.set(ent.parentOrg, pSet);

          const curParent = parentAgg.get(ent.parentOrg) ?? { requests: 0, domains: 0, category: ent.category };
          curParent.requests += ent.requests;
          curParent.domains += ent.domains;
          parentAgg.set(ent.parentOrg, curParent);
        }
        for (const [parentOrg, agg] of parentAgg.entries()) {
          const pStats = parentOrgSiteStats.get(parentOrg) ?? [];
          pStats.push({
            domain: clean.canonicalDomain,
            requests: agg.requests,
            domains: agg.domains,
            category: agg.category
          });
          parentOrgSiteStats.set(parentOrg, pStats);
        }

        staged.push({ report: clean, serialized, sha256 });
        console.log(
          `[ok] ${clean.canonicalDomain} (${clean.reportId}) — ${clean.leadArm.summary.thirdPartyDomains} 3P domains, ` +
            `${clean.leadArm.summary.cookiesTotal} cookies, ${(serialized.length / 1024).toFixed(1)} KB, ${Date.now() - started}ms`
        );
      } catch (err) {
        failed += 1;
        console.error(`[fail] ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (staged.length === 0) {
      throw new Error("Public v3 corpus seed produced 0 valid reports; leaving existing seed files untouched.");
    }

    // Replace existing report files cleanly so public/v3/ stays strictly bounded.
    const existingFiles = await readdir(reportsDir).catch(() => []);
    for (const file of existingFiles) {
      if (file.endsWith(".json")) {
        await rm(path.join(reportsDir, file), { force: true });
      }
    }

    const manifestEntries = [];
    let totalBytes = 0;
    for (const item of staged) {
      const relFile = `reports/${item.report.reportId}.json`;
      await writeFile(path.join(opts.outDir, relFile), item.serialized, "utf8");
      const byteLength = Buffer.byteLength(item.serialized, "utf8");
      totalBytes += byteLength;
      manifestEntries.push({
        reportId: item.report.reportId,
        canonicalDomain: item.report.canonicalDomain,
        scannedAt: item.report.scannedAt,
        file: relFile,
        sha256: item.sha256,
        bytes: byteLength
      });
    }

    const generatedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      generatedAt,
      reports: manifestEntries
    };
    await writeFile(path.join(opts.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const stats = await memIndex.getCorpusOverviewStats();
    const { items } = await memIndex.queryCorpus({ visibility: "all-public", latestPerSite: true, limit: 200 });
    const snapshot = {
      schemaVersion: 1,
      generatedAt,
      stats,
      items,
      entityDomains: Object.fromEntries([...entityDomains.entries()].map(([k, s]) => [k, [...s].sort()])),
      parentOrgDomains: Object.fromEntries([...parentOrgDomains.entries()].map(([k, s]) => [k, [...s].sort()])),
      entitySiteStats: Object.fromEntries(
        [...entitySiteStats.entries()].map(([k, arr]) => [
          k,
          arr.sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain))
        ])
      ),
      parentOrgSiteStats: Object.fromEntries(
        [...parentOrgSiteStats.entries()].map(([k, arr]) => [
          k,
          arr.sort((a, b) => b.requests - a.requests || a.domain.localeCompare(b.domain))
        ])
      )
    };
    await writeFile(path.join(opts.outDir, "corpus-snapshot.json"), JSON.stringify(snapshot), "utf8");

    if (opts.syncRuntime) {
      const ctx = await getV3RuntimeContext();
      try {
        for (const item of staged) {
          const r2Key = await saveReportV3(ctx.blobStore, item.report);
          await ctx.reportIndex.indexReport(item.report, { r2Key, visibility: "corpus" });
        }
        console.log(`Synced ${staged.length} reports to runtime backend (${ctx.indexBackend}).`);
      } finally {
        ctx.close();
      }
    }

    console.log(
      `Public v3 corpus seed complete: ${staged.length} reports (${(totalBytes / 1024 / 1024).toFixed(2)} MiB), ` +
        `${failed} skipped/failed -> ${opts.outDir}`
    );
  } finally {
    closeMemIndex();
    await closeSharedBrowserV3();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targets = await resolveTargets(opts);

  // Stamp real git commit provenance when SITE_BEHAVIOR_LAB_BUILD_COMMIT is not set.
  if (!process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT?.trim()) {
    try {
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) {
        process.env.SITE_BEHAVIOR_LAB_BUILD_COMMIT = sha.toLowerCase();
      }
    } catch {}
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
  const { saveReportV3, reportBlobKeyV3 } = require(path.join(ROOT, ".unit-test-dist/lib/v3/storage/blob-store.js"));
  const { openNodeSqliteReportIndex } = require(path.join(ROOT, ".unit-test-dist/lib/v3/storage/report-index.js"));
  const { redactScanReportV3, assertNoUnredactedSecretsV3 } = require(path.join(
    ROOT,
    ".unit-test-dist/lib/v3/redaction.js"
  ));
  const { validateScanReportV3 } = require(path.join(ROOT, ".unit-test-dist/lib/v3/schema.js"));
  const { extractAllArmEntitiesV3 } = require(path.join(ROOT, ".unit-test-dist/lib/v3/scanner/summary.js"));

  if (opts.publicSeed) {
    await runPublicSeed(
      opts,
      {
        scanSiteV3,
        closeSharedBrowserV3,
        dispatchScanV3,
        redactScanReportV3,
        assertNoUnredactedSecretsV3,
        validateScanReportV3,
        extractAllArmEntitiesV3,
        openNodeSqliteReportIndex,
        reportBlobKeyV3,
        getV3RuntimeContext,
        saveReportV3
      },
      targets
    );
    return;
  }

  const ctx = await getV3RuntimeContext();
  let succeeded = 0;
  let failed = 0;

  try {
    for (const url of targets) {
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

  console.log(
    `v3 corpus seeding finished: ${succeeded} succeeded, ${failed} failed (backend: ${ctx.indexBackend}, data dir: ${ctx.dataDir})`
  );
  if (succeeded === 0 && failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
