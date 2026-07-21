/** Keep the static library indexable and the scanner execution origin dark. */
export function buildRobotsPolicy(staticExport: boolean, baseUrl: string) {
  if (staticExport) {
    return {
      rules: { userAgent: "*", allow: "/" },
      sitemap: `${baseUrl}/sitemap.xml`
    };
  }

  // Reports stay crawlable only so their page-level noindex policy can be
  // read. The longer allow rule wins over the ordinary-route disallow.
  return {
    rules: {
      userAgent: "*",
      allow: "/reports/",
      disallow: "/"
    }
  };
}
