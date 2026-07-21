import type { MetadataRoute } from "next";
import { buildRobotsPolicy } from "@/lib/robots-policy";
import { siteBaseUrl } from "@/lib/site-url";

export const dynamic = "force-static";

const STATIC_EXPORT = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1";

export default function robots(): MetadataRoute.Robots {
  // The static export publishes curated, currently retained report pages under /reports/
  // that are meant to be indexed and shared. The Node app instead serves
  // random-ID, short-lived share permalinks there. Those pages emit noindex in
  // both metadata and X-Robots-Tag; they must remain crawlable or a search
  // engine cannot see that directive. Private API routes remain disallowed.
  return buildRobotsPolicy(STATIC_EXPORT, siteBaseUrl());
}
