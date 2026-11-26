/**
 * Shared Node runtime context for Site Behavior Lab v3 API routes and CLI.
 *
 * Resolves:
 *  - `BlobStoreV3`: S3-compatible Cloudflare R2 when R2 env vars are configured,
 *    otherwise local filesystem store under `SITE_BEHAVIOR_LAB_V3_DATA_DIR`
 *    (default `<SITE_BEHAVIOR_LAB_REPORT_STORE_DIR>/v3` or `.sbl-v3-data`).
 *    Layered with a read-only fallback over committed redacted seed reports in
 *    `public/v3/` when present so cold containers serve seeded corpus reports.
 *  - `D1ReportIndexStoreV3`: Cloudflare D1 over HTTP REST when
 *    `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_D1_DATABASE_ID` +
 *    `CLOUDFLARE_D1_API_TOKEN` (or `CLOUDFLARE_API_TOKEN`) are configured,
 *    otherwise local `node:sqlite` metadata index (`v3-index.sqlite`).
 *    Idempotently hydrates committed seed reports from `public/v3/manifest.json`
 *    on cold start unless disabled via `SITE_BEHAVIOR_LAB_V3_SEED_DIR=none`.
 *  - Optional Cloudflare Browser Rendering REST API credentials for offloaded
 *    PDF generation.
 *  - Optional signed HMAC regional worker upstreams (`SITE_BEHAVIOR_LAB_REGIONAL_WORKERS_JSON`).
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CloudflareBrowserRenderingConfig } from "../pdf/browser-rendering-pdf";
import { validateScanReportV3, type ScanReportV3 } from "../schema";
import {
  assertSafeReportIdV3,
  createFsBlobStoreV3,
  createLayeredBlobStoreV3,
  createReadOnlySeedBlobStoreV3,
  createS3R2BlobStoreV3,
  reportBlobKeyV3,
  type BlobStoreV3
} from "../storage/blob-store";
import {
  openCloudflareD1HttpReportIndex,
  openNodeSqliteReportIndex,
  type CloudflareD1HttpConfigV3,
  type D1ReportIndexStoreV3
} from "../storage/report-index";
import type { RegionalWorkerUpstreamConfigV3 } from "./worker-dispatch";

export type V3SeedManifestEntryV3 = {
  reportId: string;
  canonicalDomain: string;
  scannedAt: string;
  file: string;
  sha256: string;
  bytes?: number;
};

export type V3SeedManifestV3 = {
  schemaVersion: 1;
  generatedAt: string;
  reports: V3SeedManifestEntryV3[];
};

export type V3RuntimeContext = {
  blobStore: BlobStoreV3;
  reportIndex: D1ReportIndexStoreV3;
  indexBackend: "d1-http" | "sqlite";
  seedDir: string | null;
  browserRendering?: CloudflareBrowserRenderingConfig;
  regionalUpstreams: RegionalWorkerUpstreamConfigV3[];
  dataDir: string;
  close: () => void;
};

let cachedContextPromise: Promise<V3RuntimeContext> | null = null;
let cachedDataDirKey: string | null = null;
let lastExpiredPruneAtMs = 0;
const EXPIRED_PRUNE_INTERVAL_MS = 10 * 60_000;

/**
 * Throttled, best-effort cleanup of expired non-corpus v3 reports (both blobs
 * and metadata rows) so the 7-day retention window holds even without a
 * dedicated R2 lifecycle rule on `v3/`.
 */
export async function maybePruneExpiredV3Reports(ctx: V3RuntimeContext, nowMs = Date.now()): Promise<number> {
  if (nowMs - lastExpiredPruneAtMs < EXPIRED_PRUNE_INTERVAL_MS) return 0;
  lastExpiredPruneAtMs = nowMs;
  try {
    return await ctx.reportIndex.pruneExpiredReports(ctx.blobStore, new Date(nowMs).toISOString(), 100);
  } catch {
    return 0;
  }
}

export function resolveV3DataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SITE_BEHAVIOR_LAB_V3_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  // Inside the production Docker / Cloudflare Container image (`USER pwuser`),
  // `/app` is read-only while `SITE_BEHAVIOR_LAB_REPORT_STORE_DIR` is writable
  // and backed by the container volume. Store v3 state under `<report-store>/v3`.
  const reportStoreDir = env.SITE_BEHAVIOR_LAB_REPORT_STORE_DIR?.trim();
  if (reportStoreDir) return path.join(path.resolve(reportStoreDir), "v3");
  return path.resolve(process.cwd(), ".sbl-v3-data");
}

export function resolveV3SeedDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.SITE_BEHAVIOR_LAB_V3_SEED_DIR?.trim();
  if (configured) {
    if (/^(?:0|false|none|off)$/i.test(configured)) return null;
    const resolved = path.resolve(configured);
    return existsSync(path.join(resolved, "manifest.json")) ? resolved : null;
  }

  const bases = [process.cwd()];
  if (typeof __dirname === "string" && __dirname.length > 0) {
    bases.push(__dirname);
  }
  for (const start of bases) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(dir, "public", "v3");
      if (existsSync(path.join(candidate, "manifest.json"))) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

export function resolveD1HttpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CloudflareD1HttpConfigV3 | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID?.trim();
  const apiToken = env.CLOUDFLARE_D1_API_TOKEN?.trim() || env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !databaseId || !apiToken) return undefined;
  return {
    accountId,
    databaseId,
    apiToken,
    endpointBase: env.CLOUDFLARE_API_BASE_URL?.trim() || undefined
  };
}

export function resolveBlobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStoreV3 {
  const endpoint = env.SITE_BEHAVIOR_LAB_R2_ENDPOINT?.trim();
  const bucket = env.SITE_BEHAVIOR_LAB_R2_BUCKET?.trim();
  const accessKeyId = env.SITE_BEHAVIOR_LAB_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.SITE_BEHAVIOR_LAB_R2_SECRET_ACCESS_KEY?.trim();

  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return createS3R2BlobStoreV3({ endpoint, bucket, accessKeyId, secretAccessKey });
  }
  return createFsBlobStoreV3(path.join(resolveV3DataDir(env), "blobs"));
}

export function resolveBrowserRenderingFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CloudflareBrowserRenderingConfig | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_BROWSER_RENDERING_API_TOKEN?.trim() || env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !apiToken) return undefined;
  return {
    accountId,
    apiToken,
    endpointBase: env.CLOUDFLARE_API_BASE_URL?.trim() || undefined
  };
}

export function resolveRegionalUpstreamsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RegionalWorkerUpstreamConfigV3[] {
  const raw = env.SITE_BEHAVIOR_LAB_REGIONAL_WORKERS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const valid: RegionalWorkerUpstreamConfigV3[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (
        (obj.region === "us-east" || obj.region === "eu-central" || obj.region === "ap-northeast") &&
        typeof obj.endpointUrl === "string" &&
        /^https:\/\//i.test(obj.endpointUrl) &&
        typeof obj.hmacSecret === "string" &&
        obj.hmacSecret.length >= 16
      ) {
        valid.push({
          region: obj.region,
          endpointUrl: obj.endpointUrl,
          hmacSecret: obj.hmacSecret,
          timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined
        });
      }
    }
    return valid;
  } catch {
    return [];
  }
}

/**
 * Idempotently hydrate committed redacted v3 reports from `public/v3/manifest.json`
 * into `reportIndex`. Verifies each file's SHA-256 and v3 schema before indexing.
 */
export async function hydrateV3SeedCorpus(
  reportIndex: D1ReportIndexStoreV3,
  seedDir: string
): Promise<{ hydrated: number; skipped: number; rejected: number }> {
  const manifestPath = path.join(seedDir, "manifest.json");
  let manifest: V3SeedManifestV3;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as V3SeedManifestV3;
  } catch {
    return { hydrated: 0, skipped: 0, rejected: 0 };
  }
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.reports) || manifest.reports.length === 0) {
    return { hydrated: 0, skipped: 0, rejected: 0 };
  }

  const existingIds = await reportIndex.listIndexedReportIds();
  const reportsRoot = path.resolve(seedDir, "reports");
  let hydrated = 0;
  let skipped = 0;
  let rejected = 0;

  for (const entry of manifest.reports) {
    if (!entry || typeof entry.reportId !== "string" || typeof entry.sha256 !== "string") {
      rejected += 1;
      continue;
    }
    if (existingIds.has(entry.reportId)) {
      skipped += 1;
      continue;
    }
    try {
      assertSafeReportIdV3(entry.reportId);
      const expectedFile = `reports/${entry.reportId}.json`;
      if (entry.file !== expectedFile) {
        rejected += 1;
        continue;
      }
      const fullPath = path.resolve(reportsRoot, `${entry.reportId}.json`);
      if (!fullPath.startsWith(`${reportsRoot}${path.sep}`)) {
        rejected += 1;
        continue;
      }
      const raw = await readFile(fullPath, "utf8");
      const digest = createHash("sha256").update(raw, "utf8").digest("hex");
      if (digest !== entry.sha256.toLowerCase()) {
        rejected += 1;
        continue;
      }
      const report = JSON.parse(raw) as ScanReportV3;
      if (report.reportId !== entry.reportId || validateScanReportV3(report).length > 0) {
        rejected += 1;
        continue;
      }
      await reportIndex.indexReport(report, {
        r2Key: reportBlobKeyV3(report.reportId),
        visibility: "corpus"
      });
      existingIds.add(report.reportId);
      hydrated += 1;
    } catch {
      rejected += 1;
    }
  }

  return { hydrated, skipped, rejected };
}

export async function getV3RuntimeContext(env: NodeJS.ProcessEnv = process.env): Promise<V3RuntimeContext> {
  const dataDir = resolveV3DataDir(env);
  const seedDir = resolveV3SeedDir(env);
  const d1Config = resolveD1HttpConfigFromEnv(env);
  const envKey = [
    dataDir,
    seedDir ?? "",
    env.SITE_BEHAVIOR_LAB_R2_ENDPOINT ?? "",
    env.SITE_BEHAVIOR_LAB_R2_BUCKET ?? "",
    env.CLOUDFLARE_ACCOUNT_ID ?? "",
    env.CLOUDFLARE_D1_DATABASE_ID ?? "",
    env.CLOUDFLARE_D1_API_TOKEN ? "d1tok" : env.CLOUDFLARE_API_TOKEN ? "cftok" : "",
    env.CLOUDFLARE_API_BASE_URL ?? "",
    env.SITE_BEHAVIOR_LAB_REGIONAL_WORKERS_JSON ?? ""
  ].join("|");

  if (cachedContextPromise && cachedDataDirKey === envKey) {
    return cachedContextPromise;
  }

  const previous = cachedContextPromise;
  cachedDataDirKey = envKey;
  cachedContextPromise = (async () => {
    if (previous) {
      try {
        (await previous).close();
      } catch {}
    }

    const indexBackend: "d1-http" | "sqlite" = d1Config ? "d1-http" : "sqlite";
    const { store: reportIndex, close } = d1Config
      ? await openCloudflareD1HttpReportIndex(d1Config)
      : await openNodeSqliteReportIndex(path.join(dataDir, "v3-index.sqlite"));

    const primaryBlobStore = resolveBlobStoreFromEnv(env);
    const blobStore = seedDir
      ? createLayeredBlobStoreV3(primaryBlobStore, createReadOnlySeedBlobStoreV3(seedDir))
      : primaryBlobStore;

    if (seedDir) {
      try {
        await hydrateV3SeedCorpus(reportIndex, seedDir);
      } catch {
        // Seed hydration is best-effort so a transient remote D1 error never bricks server boot.
      }
    }

    const runtimeCtx: V3RuntimeContext = {
      blobStore,
      reportIndex,
      indexBackend,
      seedDir,
      browserRendering: resolveBrowserRenderingFromEnv(env),
      regionalUpstreams: resolveRegionalUpstreamsFromEnv(env),
      dataDir,
      close
    };
    void maybePruneExpiredV3Reports(runtimeCtx);
    return runtimeCtx;
  })();

  cachedContextPromise.catch(() => {
    cachedContextPromise = null;
    cachedDataDirKey = null;
  });

  return cachedContextPromise;
}

export async function resetV3RuntimeContextForTests(): Promise<void> {
  if (!cachedContextPromise) return;
  const p = cachedContextPromise;
  cachedContextPromise = null;
  cachedDataDirKey = null;
  try {
    const ctx = await p;
    ctx.close();
  } catch {}
}
