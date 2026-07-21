import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("expiring runtime reports are crawlable only so their noindex policy can be read", () => {
  const reportPage = readFileSync(path.join(root, "app", "reports", "[id]", "page.tsx"), "utf8");
  const layout = readFileSync(path.join(root, "app", "layout.tsx"), "utf8");
  const robotsRoute = readFileSync(path.join(root, "app", "robots.ts"), "utf8");
  const sitemapRoute = readFileSync(path.join(root, "app", "sitemap.ts"), "utf8");
  const nextConfig = readFileSync(path.join(root, "next.config.mjs"), "utf8");

  assert.match(reportPage, /STATIC_EXPORT[\s\S]*index: false, follow: true, noarchive: true/);
  assert.match(reportPage, /canonical: STATIC_EXPORT \? reportUrl : null/);
  assert.doesNotMatch(reportPage, /publishedTime/);
  assert.match(reportPage, /url: reportUrl/);
  assert.match(reportPage, /STATIC_EXPORT && !correction\.suppressIndexing/);
  assert.match(reportPage, /reports\/\$\{id\}\$\{STATIC_EXPORT \? "\/" : ""\}/);
  assert.match(layout, /robots: STATIC_EXPORT[\s\S]*index: false, follow: false, noarchive: true/);
  assert.match(robotsRoute, /buildRobotsPolicy\(STATIC_EXPORT, siteBaseUrl\(\)\)/);
  assert.match(sitemapRoute, /if \(!STATIC_EXPORT\) return \[\]/);
  assert.match(nextConfig, /X-Robots-Tag", value: "noindex, follow, noarchive"/);
});

test("public page metadata is base-path aware through the shared absolute helper", () => {
  const layout = readFileSync(path.join(root, "app", "layout.tsx"), "utf8");
  assert.match(layout, /metadataBase: new URL\(`\$\{siteBaseUrl\(\)\}\/`\)/);
  assert.match(layout, /canonical: siteUrl\("\/"\)/);
  assert.equal((layout.match(/url: siteUrl\("\/"\)/g) ?? []).length >= 3, true);

  for (const file of [
    "app/glossary/page.tsx",
    "app/methodology/page.tsx",
    "app/privacy/page.tsx",
    "app/directory/page.tsx",
    "app/catalog/page.tsx",
    "app/status/page.tsx",
    "app/security/page.tsx",
    "app/corrections/page.tsx",
    "app/categories/[category]/page.tsx",
    "app/directory/page/[page]/page.tsx",
    "app/sites/[domain]/page.tsx"
  ]) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.match(source, /publicPageMetadata\(/, `${file} bypasses complete absolute page metadata`);
  }
});
