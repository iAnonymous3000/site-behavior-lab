const isStaticExport = process.env.SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

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
    NEXT_PUBLIC_SITE_BEHAVIOR_LAB_GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY || ""
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
          const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";
          const securityHeaders = [
            // CSP retains 'unsafe-inline' for scripts/styles in v1: Next emits inline bootstrap
            // scripts plus the pre-paint theme script, so moving to per-request nonces is the
            // post-v1 hardening. React output escaping remains the primary XSS defense.
            {
              key: "Content-Security-Policy",
              value: [
                "default-src 'self'",
                "base-uri 'self'",
                "connect-src 'self'",
                "form-action 'self'",
                "frame-ancestors 'none'",
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
              headers: noStoreHeaders
            }
          ];
        }
      })
};

export default nextConfig;
