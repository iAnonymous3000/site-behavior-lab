/**
 * Canonical public URL helpers for build-time SEO routes (robots, sitemap).
 *
 * The origin comes from `NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL` (the same
 * variable that drives social-card `metadataBase`); any GitHub Pages project
 * base path is appended for the static export. Development may use the
 * localhost fallback, but a production build fails closed when the origin is
 * missing, malformed, non-HTTPS, or contains anything beyond an origin. That
 * prevents a public artifact from quietly publishing localhost canonicals.
 */

const DEFAULT_ORIGIN = "http://localhost:3000";
const DEFAULT_PUBLIC_LIBRARY_ORIGIN = "https://sitebehavior.org";

/** Public origin (scheme + host only), no trailing slash. */
export function siteOrigin(): string {
  return resolveSiteOrigin(process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL, {
    publicBuild:
      process.env.NODE_ENV === "production" ||
      process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1" ||
      process.env.SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1"
  });
}

export function resolveSiteOrigin(
  rawValue: string | undefined,
  { publicBuild = false }: { publicBuild?: boolean } = {}
): string {
  const raw = rawValue?.trim();
  if (!raw) {
    if (publicBuild) {
      throw new Error(
        "NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL is required for production builds so canonical URLs cannot fall back to localhost."
      );
    }
    return DEFAULT_ORIGIN;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL must be an absolute HTTP(S) origin.");
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL must contain only an HTTP(S) scheme and host; put project paths in SITE_BEHAVIOR_LAB_PAGES_BASE_PATH."
    );
  }
  if (publicBuild && url.protocol !== "https:") {
    throw new Error("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL must use HTTPS for production builds.");
  }
  const hostname = url.hostname.toLowerCase();
  if (publicBuild && !isPublicCanonicalHostname(hostname)) {
    throw new Error("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL must use a public hostname for production builds.");
  }

  return url.origin;
}

/** Public base URL including any GitHub Pages project base path, no trailing slash. */
export function siteBaseUrl(): string {
  return `${siteOrigin()}${sitePagesBasePath()}`;
}

/** Absolute public URL rooted at the configured origin and project base path. */
export function siteUrl(pathname = "/"): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${siteBaseUrl()}${normalizedPath}`;
}

/**
 * Canonical static-library origin, deliberately separate from the origin that
 * renders a live scanner report. The production container builds its own SEO
 * URLs against scan.sitebehavior.org, but status receipts belong to the public
 * Pages library. A self-host can override this public build-time value without
 * allowing an insecure or path-bearing origin.
 */
export function publicLibraryOrigin(): string {
  return resolvePublicLibraryOrigin(
    process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN
  );
}

export function resolvePublicLibraryOrigin(rawValue: string | undefined): string {
  return resolveSiteOrigin(rawValue?.trim() || DEFAULT_PUBLIC_LIBRARY_ORIGIN, {
    publicBuild: true
  });
}

/** Absolute URL to an artifact on the canonical public static library. */
export function publicLibraryUrl(pathname = "/"): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${publicLibraryOrigin()}${normalizedPath}`;
}

/**
 * The Pages project base path alone ("" at a domain root), for origin-relative
 * links to non-page files (e.g. /corpus.json) from server components, where
 * next/link's automatic basePath prefixing does not apply.
 */
export function sitePagesBasePath(): string {
  return normalizeBasePath(process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH || "");
}

function normalizeBasePath(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

/** Canonical public builds use a DNS hostname, never an IP or special-use name. */
function isPublicCanonicalHostname(hostname: string): boolean {
  // URL normalizes alternate IPv4 spellings before exposing hostname.
  if (parseIpv4(hostname) || (hostname.startsWith("[") && hostname.endsWith("]"))) return false;
  if (hostname.endsWith(".") || !hostname.includes(".")) return false;

  const specialUseNames = [
    "localhost",
    "test",
    "example",
    "invalid",
    "local",
    "internal",
    "home.arpa",
    "onion"
  ];
  return !specialUseNames.some((name) => hostname === name || hostname.endsWith(`.${name}`));
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return null;
  const octets = hostname.split(".").map(Number) as [number, number, number, number];
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/**
 * The printable rendering of a report, from that report's public URL.
 *
 * A plain `${reportUrl}print/` is wrong: publicReportUrl appends a trailing
 * slash only on the static export, so on the container it produced
 * `.../reports/<id>print/`. Normalising here keeps both callers correct
 * regardless of which form they hold.
 */
export function printableReportHref(reportUrl: string): string {
  return `${reportUrl.replace(/\/+$/, "")}/print/`;
}

/** The configured renderer; static builds must explicitly declare PDF capability. */
export function reportPdfHref(id: string): string | null {
  if (process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1") {
    if (process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PDF_EXPORT_ENABLED !== "1") return null;
    const base = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE;
    if (!base) return null;
    return `${resolveSiteOrigin(base, { publicBuild: true })}/api/reports/${id}/pdf`;
  }
  return `${siteOrigin()}/api/reports/${id}/pdf`;
}
