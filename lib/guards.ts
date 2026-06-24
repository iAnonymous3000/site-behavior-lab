/**
 * Shared, dependency-free type guards safe to import from any runtime lane
 * (Node, Cloudflare Worker, browser). Keep this module pure, no imports, no
 * runtime globals, so the runtime-boundary import graph stays clean.
 */

/** True for a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
