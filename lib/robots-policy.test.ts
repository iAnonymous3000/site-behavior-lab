import assert from "node:assert/strict";
import test from "node:test";
import { buildRobotsPolicy } from "./robots-policy";

test("static export is indexable and advertises its base-path sitemap", () => {
  assert.deepEqual(buildRobotsPolicy(true, "https://example.com/project"), {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://example.com/project/sitemap.xml"
  });
});

test("runtime scanner origin excludes ordinary routes and advertises no sitemap", () => {
  const policy = buildRobotsPolicy(false, "https://scan.example.com");
  assert.deepEqual(policy, {
    rules: { userAgent: "*", allow: "/reports/", disallow: "/" }
  });
  assert.equal("sitemap" in policy, false);
});
