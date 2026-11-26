/**
 * Shared Node runtime context for Site Behavior Lab v3 API routes and CLI.
 *
 * Resolves:
 *  - `BlobStoreV3`: S3-compatible Cloudflare R2 when R2 env vars are configured,
 *    otherwise local filesystem store under `SITE_BEHAVIOR_LAB_V3_DATA_DIR`
 *    (default `.sbl-v3-data`).
 *  - `D1ReportIndexStoreV3`: local `node:sqlite` metadata index file alongside
 *    the data directory (or injected D1 binding in Workers).
 *  - Optional Cloudflare Browser Rendering REST API credentials for offloaded
 *    PDF generation.
 *  - Optional signed HMAC regional worker upstreams (`SITE_BEHAVIOR_LAB_REGIONAL_WORKERS_JSON`).
 */

import path from "node:path";
import type { CloudflareBrowserRenderingConfig } from "../pdf/browser-rendering-pdf";
import {
  createFsBlobStoreV3,
  createS3R2BlobStoreV3,
  type BlobStoreV3
} from "../storage/blob-store";
import { openNodeSqliteReportIndex, type D1ReportIndexStoreV3 } from "../storage/report-index";
import type { RegionalWorkerUpstreamConfigV3 } from "./worker-dispatch";

export type V3RuntimeContext = {
  blobStore: BlobStoreV3;
  reportIndex: D1ReportIndexStoreV3;
  browserRendering?: CloudflareBrowserRenderingConfig;
  regionalUpstreams: RegionalWorkerUpstreamConfigV3[];
  dataDir: string;
  close: () => void;
};

let cachedContextPromise: Promise<V3RuntimeContext> | null = null;
let cachedDataDirKey: string | null = null;

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

export async function getV3RuntimeContext(env: NodeJS.ProcessEnv = process.env): Promise<V3RuntimeContext> {
  const dataDir = resolveV3DataDir(env);
  const envKey = [
    dataDir,
    env.SITE_BEHAVIOR_LAB_R2_ENDPOINT ?? "",
    env.SITE_BEHAVIOR_LAB_R2_BUCKET ?? "",
    env.CLOUDFLARE_ACCOUNT_ID ?? "",
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
    const dbPath = path.join(dataDir, "v3-index.sqlite");
    const { store: reportIndex, close } = await openNodeSqliteReportIndex(dbPath);
    return {
      blobStore: resolveBlobStoreFromEnv(env),
      reportIndex,
      browserRendering: resolveBrowserRenderingFromEnv(env),
      regionalUpstreams: resolveRegionalUpstreamsFromEnv(env),
      dataDir,
      close
    };
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
