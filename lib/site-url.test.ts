import assert from "node:assert/strict";
import test from "node:test";
import {
  printableReportHref,
  publicLibraryUrl,
  resolvePublicLibraryOrigin,
  resolveSiteOrigin,
  siteUrl
} from "./site-url";

test("site origin permits the explicit localhost fallback only outside public builds", () => {
  assert.equal(resolveSiteOrigin(undefined), "http://localhost:3000");
  assert.throws(() => resolveSiteOrigin(undefined, { publicBuild: true }), /required for production builds/);
});

test("site origin accepts and normalizes a bare public HTTPS origin", () => {
  assert.equal(resolveSiteOrigin(" https://sitebehavior.org/ ", { publicBuild: true }), "https://sitebehavior.org");
  assert.equal(resolveSiteOrigin("https://sitebehavior.org:443"), "https://sitebehavior.org");
});

test("site origin rejects unsafe or ambiguous canonical origins", () => {
  assert.throws(() => resolveSiteOrigin("http://sitebehavior.org", { publicBuild: true }), /must use HTTPS/);
  assert.throws(() => resolveSiteOrigin("https://localhost:3000", { publicBuild: true }), /public hostname/);
  assert.throws(() => resolveSiteOrigin("https://127.0.0.1", { publicBuild: true }), /public hostname/);
  assert.throws(() => resolveSiteOrigin("https://sitebehavior.org/reports"), /scheme and host/);
  assert.throws(() => resolveSiteOrigin("https://user:pass@sitebehavior.org"), /scheme and host/);
  assert.throws(() => resolveSiteOrigin("not a URL"), /absolute HTTP\(S\) origin/);
});

test("site origin rejects IP literals and special-use hostnames in public builds", () => {
  for (const origin of [
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.1.1",
    "https://169.254.10.2",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "https://[::ffff:192.168.1.1]",
    "https://203.0.113.10",
    "https://[2606:4700:4700::1111]",
    "https://scanner",
    "https://scanner.internal",
    "https://scanner.example",
    "https://scanner.test",
    "https://hidden.onion",
    "https://sitebehavior.org."
  ]) {
    assert.throws(() => resolveSiteOrigin(origin, { publicBuild: true }), /public hostname/, origin);
  }
});

test("siteUrl includes the configured project base path in absolute URLs", () => {
  const previousOrigin = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL;
  const previousBasePath = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH;
  process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL = "https://example.com";
  process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH = "/site-behavior-lab";
  try {
    assert.equal(siteUrl(), "https://example.com/site-behavior-lab/");
    assert.equal(siteUrl("directory/"), "https://example.com/site-behavior-lab/directory/");
  } finally {
    restore("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL", previousOrigin);
    restore("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PAGES_BASE_PATH", previousBasePath);
  }
});

test("public library URLs stay separate from the scanner canonical origin", () => {
  const previousSiteOrigin = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL;
  const previousLibraryOrigin = process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN;
  process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL = "https://scan.sitebehavior.org";
  delete process.env.NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN;
  try {
    assert.equal(publicLibraryUrl("/deployment.json"), "https://sitebehavior.org/deployment.json");
    assert.equal(
      resolvePublicLibraryOrigin("https://library.example.org/"),
      "https://library.example.org"
    );
    assert.throws(
      () => resolvePublicLibraryOrigin("http://library.example.org"),
      /must use HTTPS/
    );
  } finally {
    restore("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SITE_URL", previousSiteOrigin);
    restore("NEXT_PUBLIC_SITE_BEHAVIOR_LAB_LIBRARY_ORIGIN", previousLibraryOrigin);
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("printableReportHref survives both report-URL forms", () => {
  // publicReportUrl appends the trailing slash only on the static export, so a
  // naive template produced ".../reports/<id>print/" on the container. A
  // browser found that; the source-regex contract test had encoded it as
  // correct, which is why this is asserted on the function instead.
  assert.equal(
    printableReportHref("https://example.test/reports/20260101-" + "a".repeat(32)),
    "https://example.test/reports/20260101-" + "a".repeat(32) + "/print/"
  );
  assert.equal(
    printableReportHref("https://example.test/reports/20260101-" + "a".repeat(32) + "/"),
    "https://example.test/reports/20260101-" + "a".repeat(32) + "/print/"
  );
  assert.equal(
    printableReportHref("https://example.test/reports/x//"),
    "https://example.test/reports/x/print/"
  );
  assert.doesNotMatch(printableReportHref("https://example.test/reports/x"), /xprint/);
});
