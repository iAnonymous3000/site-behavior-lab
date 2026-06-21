import type { MetadataRoute } from "next";
import { siteBaseUrl } from "@/lib/site-url";

export const dynamic = "force-static";

const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

export default function robots(): MetadataRoute.Robots {
  const sitemap = `${siteBaseUrl()}/sitemap.xml`;

  // The static export publishes curated, permanent report pages under /reports/
  // that are meant to be indexed and shared. The Node app instead serves
  // random-ID, short-lived share permalinks there (plus private /api routes),
  // which should stay out of search.
  if (STATIC_EXPORT) {
    return {
      rules: { userAgent: "*", allow: "/" },
      sitemap
    };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/reports/"]
    },
    sitemap
  };
}
