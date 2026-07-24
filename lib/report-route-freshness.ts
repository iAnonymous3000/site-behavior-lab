import { connection } from "next/server";

/**
 * Runtime share reports carry store-owned expiry metadata, so every HTTP
 * request must consult that store instead of Next's persistent Full Route
 * Cache. The committed-corpus export has no runtime store and deliberately
 * skips this request boundary so `output: export` can still prerender it.
 */
export async function requireFreshRuntimeReportRequest(): Promise<void> {
  if (process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT !== "1") {
    await connection();
  }
}
