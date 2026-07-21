import { resolvePublicBuildCommit } from "./scripts/public-build-commit.mjs";

const isStaticExport = process.env.SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";
const publicBuildCommit = resolvePublicBuildCommit();
const publicLibraryOrigin = normalizePublicLibraryOrigin(
  process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN
);

function normalizePublicLibraryOrigin(value) {
  const raw = value?.trim() || "https://sitebehavior.org";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN must be an absolute HTTPS origin.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN must contain only an HTTPS scheme and host.");
  }
  return parsed.origin;
}

function normalizeBasePath(value) {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "");
}

function inferredGithubPagesBasePath() {
  const repository = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (!repository || repository.endsWith(".github.io")) return "";
  return `/${repository}`;
}

const pagesBasePath = isStaticExport
  ? normalizeBasePath(
      process.env.SITE_BEHAVIOR_LAB_PAGES_BASE_PATH === undefined
        ? inferredGithubPagesBasePath()
        : process.env.SITE_BEHAVIOR_LAB_PAGES_BASE_PATH
    )
  : "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  env: {
    NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT: isStaticExport ? "1" : "0",
    NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH: pagesBasePath,
    NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN: publicLibraryOrigin,
    NEXT_PUBLIC_SITE_BEHAVIOR_LAB_GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || "",
    NEXT_PUBLIC_SITE_BEHAVIOR_LAB_BUILD_COMMIT: publicBuildCommit
  },
  ...(isStaticExport
    ? {
        output: "export",
        trailingSlash: true,
        images: {
          unoptimized: true
        },
        ...(pagesBasePath
          ? {
              basePath: pagesBasePath,
              assetPrefix: pagesBasePath
            }
          : {})
      }
    : {
        async headers() {
          // Next.js dev mode (React Refresh / webpack HMR) evaluates module code with
          // eval(), so the dev CSP must allow 'unsafe-eval' or the client bundle never
          // executes and the app never hydrates. Production keeps the stricter policy.
          const isDev = process.env.NODE_ENV !== "production";
          // challenges.cloudflare.com is Cloudflare Turnstile: the scan form on
          // saved-report pages (served by this Node deployment) loads its widget
          // script and renders its challenge iframe, so both script-src and
          // frame-src must allow it or shared-report visitors can never start a
          // scan (the button waits on a token that can't arrive).
          const scriptSrc = isDev
            ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://challenges.cloudflare.com"
            : "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com";
          const securityHeaders = [
            // CSP retains 'unsafe-inline' for scripts/styles in v1: Next emits inline bootstrap
            // scripts plus the pre-paint theme script, so moving to per-request nonces is the
            // post-v1 hardening. React output escaping remains the primary XSS defense.
            {
              key: "Content-Security-Policy",
              value: [
                "default-src 'self'",
                "base-uri 'self'",
                `connect-src 'self' ${publicLibraryOrigin}`,
                "form-action 'self'",
                "frame-ancestors 'none'",
                "frame-src https://challenges.cloudflare.com",
                "img-src 'self' data:",
                "object-src 'none'",
                scriptSrc,
                "style-src 'self' 'unsafe-inline'"
              ].join("; ")
            },
            { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
            { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "X-Frame-Options", value: "DENY" },
            {
              key: "Permissions-Policy",
              value: "camera=(), geolocation=(), microphone=(), payment=(), serial=(), usb=()"
            }
          ];

          const noStoreHeaders = [
            { key: "Cache-Control", value: "no-store" },
            ...securityHeaders
          ];
          const expiringReportHeaders = [
            { key: "Cache-Control", value: "no-store" },
            { key: "X-Robots-Tag", value: "noindex, follow, noarchive" },
            ...securityHeaders
          ];

          return [
            {
              source: "/(.*)",
              headers: securityHeaders
            },
            {
              source: "/api/:path*",
              headers: noStoreHeaders
            },
            {
              source: "/reports/:path*",
              headers: expiringReportHeaders
            }
          ];
        }
      })
};

export default nextConfig;
