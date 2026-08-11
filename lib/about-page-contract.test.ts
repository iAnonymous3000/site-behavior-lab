import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * What the About page promises, held in place.
 *
 * The page exists to answer "what is this and why should I trust it" for a
 * reader who has never heard of the project, so its failure modes are different
 * from a report's: a dead link, a claim wider than the evidence allows, or a
 * second copy of copy that is single-sourced elsewhere.
 */

const root = process.cwd();
const about = readFileSync(path.join(root, "app", "about", "page.tsx"), "utf8");

/** Every internal href the page renders. */
function internalLinks(source: string): string[] {
  return [...source.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1]);
}

test("every internal link on the About page points at a route that exists", () => {
  // This is the test that would have caught the real bug: the first draft
  // linked to /categories/, which looks obviously right, renders as a normal
  // link, and 404s -- app/categories only holds a [category] segment, with no
  // index page. Nothing but loading the page caught it.
  const missing: string[] = [];

  for (const href of internalLinks(about)) {
    const segments = href.split("/").filter(Boolean);
    const routeDir = path.join(root, "app", ...segments);
    const candidates = [
      path.join(routeDir, "page.tsx"),
      path.join(routeDir, "page.ts"),
      // A file route like /corpus.json is served from public/ instead.
      path.join(root, "public", ...segments)
    ];
    if (!candidates.some((candidate) => existsSync(candidate))) missing.push(href);
  }

  assert.deepEqual(
    missing,
    [],
    `these About-page links have no route: ${missing.join(", ")}. ` +
      "A directory holding only a dynamic segment (app/x/[y]/page.tsx) does NOT serve /x/."
  );
});

test("the About page quotes the approved claim boundary rather than restating it", () => {
  // The boundary is an approved decision rendered on every report. A second
  // copy here could widen the claim without the decision changing, which is the
  // one thing this page must never do.
  assert.match(
    about,
    /claimBoundaryParagraph\(CLAIM_BOUNDARY\)/,
    "the About page must render the single-sourced boundary"
  );
  for (const forbidden of [
    "investigative evidence that requires independent corroboration",
    "not a standalone legal determination"
  ]) {
    assert.ok(
      !about.includes(forbidden),
      `the About page must not restate the claim boundary in its own words (found: ${forbidden})`
    );
  }
});

test("the About page makes no claim the project has refused elsewhere", () => {
  // The project's standing position: a scan is not a legal determination and
  // not a compliance verdict. Prose written for a lay audience is exactly where
  // that slips, so the words are checked rather than trusted.
  for (const forbidden of [/\bHIPAA\b/i, /\bGDPR[- ]compliant\b/i, /\bcourt[- ]admissible\b/i, /\bproves? that\b/i]) {
    assert.doesNotMatch(about, forbidden, `the About page must not claim ${forbidden}`);
  }
});

test("the About page is reachable, and is not excluded from the static export", () => {
  const trustLinks = readFileSync(path.join(root, "app", "_components", "trust-links.tsx"), "utf8");
  assert.match(trustLinks, /href="\/about\/"/, "a page nobody can navigate to is not an About page");

  const sitemap = readFileSync(path.join(root, "app", "sitemap.ts"), "utf8");
  assert.match(sitemap, /\/about\//, "the About page must be in the sitemap");

  const buildScript = readFileSync(path.join(root, "scripts", "build-github-pages.mjs"), "utf8");
  const serverOnly = buildScript.slice(
    buildScript.indexOf("const serverOnlyAppDirs"),
    buildScript.indexOf("const runtimeReportRouteFiles")
  );
  assert.ok(
    !serverOnly.includes('"about"'),
    "the About page must ship on the static site, which is where most readers arrive"
  );
});
