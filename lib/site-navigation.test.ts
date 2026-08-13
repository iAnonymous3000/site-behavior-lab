import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { SITE_PRIMARY_NAV, SITE_TRUST_LINKS, SOURCE_REPOSITORY_URL } from "./site-navigation";

const root = process.cwd();

/**
 * Every surface that publishes the WHOLE trust-link set, with the region of
 * the file that does it.
 *
 * There is exactly one now. This list used to name three files: a shared
 * `TrustLinks` component that secondary pages rendered, plus a hand-written
 * footer inside each of the two client shells. That arrangement is what the
 * drift guard below was written for, and it is now structurally impossible:
 * `SiteChrome` renders the header and the footer for every route, so a second
 * copy cannot exist without someone writing a second shell.
 *
 * The header's primary nav is a deliberately curated subset (SITE_PRIMARY_NAV),
 * not a drifted copy of this set. Its own well-formedness is checked below.
 */
const NAV_SURFACES = [{ file: "app/_components/site-chrome.tsx", from: null, to: null }] as const;

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

function region(surface: (typeof NAV_SURFACES)[number]): string {
  const text = source(surface.file);
  if (surface.from === null || surface.to === null) return text;
  const start = text.indexOf(surface.from);
  assert.ok(start >= 0, `${surface.file} no longer contains ${surface.from}`);
  const end = text.indexOf(surface.to, start);
  assert.ok(end > start, `${surface.file} has no ${surface.to} after ${surface.from}`);
  return text.slice(start, end);
}

test("the trust-link set is well formed and points at real routes", () => {
  assert.ok(SITE_TRUST_LINKS.length > 0);
  const hrefs = SITE_TRUST_LINKS.map((link) => link.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "duplicate href in the trust-link set");

  for (const link of SITE_TRUST_LINKS) {
    assert.match(link.href, /^\/[a-z0-9-]+\/$/, `${link.href} must be a rooted, trailing-slash route`);
    assert.ok(link.label.trim().length > 0, `${link.href} needs a label`);
    // A nav entry pointing at a route that does not exist is a 404 shipped on
    // every page, which is worse than the missing link this file exists to stop.
    const route = path.join(root, "app", link.href.replace(/^\/|\/$/g, ""), "page.tsx");
    assert.ok(existsSync(route), `${link.href} has no route at ${path.relative(root, route)}`);
  }

  assert.ok(SITE_TRUST_LINKS.some((link) => link.href === "/about/"), "About must stay in the set");
  assert.equal(SITE_TRUST_LINKS[0].href, "/about/", "About leads: a first-time reader needs it most");
});

test("the primary nav is well formed and points at real routes", () => {
  assert.ok(SITE_PRIMARY_NAV.length > 0);
  const hrefs = SITE_PRIMARY_NAV.map((link) => link.href);
  assert.equal(new Set(hrefs).size, hrefs.length, "duplicate href in the primary nav");
  assert.equal(SITE_PRIMARY_NAV[0].href, "/", "the scan workbench leads: it is what the product does");

  for (const link of SITE_PRIMARY_NAV) {
    assert.match(link.href, /^\/([a-z0-9-]+\/)?$/, `${link.href} must be a rooted, trailing-slash route`);
    assert.ok(link.label.trim().length > 0, `${link.href} needs a label`);
    // A nav entry pointing at a route that does not exist is a 404 shipped on
    // every page, which is worse than the missing link this file exists to stop.
    const route = path.join(root, "app", link.href.replace(/^\/|\/$/g, ""), "page.tsx");
    assert.ok(existsSync(route), `${link.href} has no route at ${path.relative(root, route)}`);
  }

  // The two halves of the product must be able to reach each other from every
  // page. Before one shell existed, thirteen of fifteen routes linked neither.
  for (const required of ["/", "/directory/"]) {
    assert.ok(
      SITE_PRIMARY_NAV.some((link) => link.href === required),
      `${required} must stay in the primary nav`
    );
  }
});

/**
 * The load-bearing test. `/about/` shipped in the shared component and was
 * absent from the home shell's own hand-written copy, so the front door did
 * not link the page that explains the project. Both surfaces must render the
 * shared list rather than restating it.
 */
test("every navigation surface renders the shared list instead of its own copy", () => {
  for (const surface of NAV_SURFACES) {
    const text = region(surface);
    assert.match(
      text,
      /SITE_TRUST_LINKS/,
      `${surface.file} must render the shared trust-link set`
    );
    for (const link of SITE_TRUST_LINKS) {
      assert.doesNotMatch(
        text,
        new RegExp(`["'\`]${link.href}["'\`]`),
        `${surface.file} hardcodes ${link.href}; that is how the two footers drifted apart`
      );
    }
  }
});

test("the sitemap publishes every trust link, and links every page it publishes", () => {
  const sitemap = source("app/sitemap.ts");
  for (const link of SITE_TRUST_LINKS) {
    assert.match(
      sitemap,
      new RegExp(`\\$\\{base\\}${link.href}`),
      `${link.href} is linked in the UI but missing from the sitemap`
    );
  }
  // The converse is the actual bug that shipped: /about/ sat in the sitemap,
  // so crawlers found it while a reader on the homepage could not.
  const published = [...sitemap.matchAll(/\$\{base\}(\/[a-z0-9-]+\/)`/g)].map((match) => match[1]);
  const policyPages = published.filter(
    (route) => !["/directory/", "/reports/", "/sites/", "/categories/"].includes(route)
  );
  const linked = new Set(SITE_TRUST_LINKS.map((link) => link.href));
  const orphaned = policyPages.filter((route) => !linked.has(route));
  assert.deepEqual(
    orphaned,
    [],
    `these routes are published to crawlers but reachable from no navigation surface: ${orphaned.join(", ")}`
  );
});

test("the drift guard fails on the copy that actually shipped", () => {
  // Mutation coverage against the real defect: the home shell's former footer,
  // which listed seven routes by hand and omitted /about/ entirely.
  const shipped = `
    <a className="footer-link" href={staticAssetPath("/glossary/")}>Glossary</a>
    <a className="footer-link" href={staticAssetPath("/methodology/")}>Methodology</a>
  `;
  assert.doesNotMatch(shipped, /SITE_TRUST_LINKS/, "the old copy did not use the shared list");
  const hardcoded = SITE_TRUST_LINKS.filter((link) =>
    new RegExp(`["'\`]${link.href}["'\`]`).test(shipped)
  );
  assert.ok(hardcoded.length > 0, "the guard must notice hardcoded routes in the old footer");
  assert.ok(
    !shipped.includes("/about/"),
    "and the omission it could not notice is exactly why the shared list is required"
  );
});

test("the source link is a real repository URL", () => {
  assert.match(SOURCE_REPOSITORY_URL, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  assert.match(source("app/_components/site-chrome.tsx"), /SOURCE_REPOSITORY_URL/);
});
