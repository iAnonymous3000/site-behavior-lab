/**
 * Canonical public URL helpers for build-time SEO routes (robots, sitemap).
 *
 * The origin comes from `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` (the same
 * variable that drives social-card `metadataBase`); any GitHub Pages project
 * base path is appended for the static export. When the origin is unset it
 * falls back to localhost, matching the documented social-card behavior.
 */

const DEFAULT_ORIGIN = "http://localhost:3000";

/** Public origin (scheme + host only), no trailing slash. */
export function siteOrigin(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL?.trim();
  if (!raw) return DEFAULT_ORIGIN;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_ORIGIN;
    return `${url.protocol}//${url.host}`;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

/** Public base URL including any GitHub Pages project base path, no trailing slash. */
export function siteBaseUrl(): string {
  const basePath = normalizeBasePath(process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH || "");
  return `${siteOrigin()}${basePath}`;
}

function normalizeBasePath(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}
