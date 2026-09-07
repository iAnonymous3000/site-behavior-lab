import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Where the force-dynamic report routes are allowed to live, and what the
 * static export does with each one.
 *
 * `next build` with `output: "export"` fails outright on a force-dynamic route,
 * so every such file under app/ must be either rewritten to force-static by
 * scripts/build-github-pages.mjs or excluded from the copied worktree. A new
 * route that is neither breaks the Pages build, and it breaks it at the point
 * where the failure is least legible: inside an isolated copied worktree, in
 * CI, after the app job has already passed.
 */

const root = process.cwd();
const buildScript = readFileSync(path.join(root, "scripts", "build-github-pages.mjs"), "utf8");

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

function appSourceFiles(dir = "app"): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, dir))) {
    if (entry.startsWith(".")) continue;
    const relative = path.posix.join(dir, entry);
    if (statSync(path.join(root, relative)).isDirectory()) {
      found.push(...appSourceFiles(relative));
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      found.push(relative);
    }
  }
  return found;
}

/** Paths the build script rewrites from force-dynamic to force-static. */
function rewrittenRoutes(): string[] {
  const block = buildScript.slice(
    buildScript.indexOf("const runtimeReportRouteFiles"),
    buildScript.indexOf("const runtimeReportRouteMode")
  );
  return [...block.matchAll(/path\.join\(([^)]+)\)/g)].map((match) =>
    match[1]
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .join("/")
  );
}

/** Directories the build script drops from the copied worktree entirely. */
function serverOnlyDirs(): string[] {
  const block = buildScript.slice(
    buildScript.indexOf("const serverOnlyAppDirs"),
    buildScript.indexOf("const runtimeReportRouteFiles")
  );
  return [...block.matchAll(/path\.join\(rootDir,\s*([^)]+)\)/g)].map((match) =>
    match[1]
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .filter((part) => part.length > 0)
      .join("/")
  );
}

test("every force-dynamic app route is either rewritten or excluded for the static export", () => {
  const rewritten = new Set(rewrittenRoutes());
  const excluded = serverOnlyDirs();
  assert.ok(rewritten.size > 0, "the rewrite list should have been parsed");
  assert.ok(excluded.length > 0, "the server-only list should have been parsed");

  const unhandled = appSourceFiles().filter((file) => {
    if (!/^\s*export const dynamic = "force-dynamic";\s*$/m.test(source(file))) return false;
    if (rewritten.has(file)) return false;
    return !excluded.some((dir) => file === dir || file.startsWith(`${dir}/`));
  });

  assert.deepEqual(
    unhandled,
    [],
    `these force-dynamic routes would break the static export: ${unhandled.join(", ")}. ` +
      "Add each to runtimeReportRouteFiles (to prerender it) or to serverOnlyAppDirs (to keep it container-only)."
  );
});

test("the rewrite list names files that exist and declare the mode it rewrites", () => {
  for (const file of rewrittenRoutes()) {
    const contents = source(file);
    const declarations = contents.match(/^\s*export const dynamic = "force-dynamic";\s*$/gm) ?? [];
    assert.equal(
      declarations.length,
      1,
      `${file} must declare force-dynamic exactly once; the build script asserts that before substituting`
    );
    assert.doesNotMatch(
      contents,
      /export async function generateStaticParams/,
      `${file} must not already export generateStaticParams; the build script injects it`
    );
  }
});

test("the printable route is container-only, and says why in the file a reader lands in", () => {
  const printRoute = "app/reports/[id]/print/page.tsx";
  assert.ok(
    serverOnlyDirs().some((dir) => printRoute.startsWith(`${dir}/`)),
    "the printable route must stay out of the static export until its size is measured"
  );

  const contents = source(printRoute);
  assert.match(contents, /printComplete/, "the printable route exists to render the complete evidence");
  assert.match(contents, /robots:\s*\{\s*index:\s*false/, "the printable route must not be indexed");
  assert.match(
    contents,
    /alternates:\s*\{\s*canonical/,
    "the printable route must canonicalise to the interactive report"
  );
  // A lazy import here would defeat the whole route: it would print the same
  // summary-only page the interactive route already prints.
  assert.doesNotMatch(contents, /lazy\(/, "the printable route must import the renderer statically");
});

test("the printable route is not advertised to crawlers", () => {
  assert.doesNotMatch(source("app/sitemap.ts"), /\/print/, "the printable rendering must stay out of the sitemap");
});

test("the printable link follows the configured renderer rather than a nonexistent static route", () => {
  const context = source("app/_components/report-page-context.tsx");
  assert.match(context, /Printable version/);
  assert.match(context, /pdfHref &&/);
  assert.match(context, /new URL\(pdfHref\).origin/);
  assert.match(context, /printableReportHref/);
});

test("the document download and PDF preview use the configured renderer, including static library pages", () => {
  const context = source("app/_components/report-page-context.tsx");
  assert.match(context, /Download PDF \+ evidence/);
  assert.match(context, /Open PDF/);
  assert.match(context, /boundPdfHref &&/);
  assert.match(context, /download=bundle/);
  const helper = source("lib/site-url.ts");
  assert.match(helper, /NEXT_PUBLIC_SITE_BEHAVIOR_LAB_PDF_EXPORT_ENABLED/);
  assert.match(helper, /NEXT_PUBLIC_SITE_BEHAVIOR_LAB_SCAN_API_BASE/);
});

test("the PDF route is an API route, so the static export drops it with the rest of app/api", () => {
  // If it ever moved out of app/api it would become a force-dynamic route the
  // export build fails on, and it would fail inside a copied worktree in CI.
  // The generic force-dynamic test above would catch that; this names why.
  const route = "app/api/reports/[id]/pdf/route.ts";
  assert.ok(
    serverOnlyDirs().some((dir) => route.startsWith(`${dir}/`)),
    "the PDF route must live under a directory the static export excludes"
  );
  const contents = source(route);
  assert.match(contents, /export const runtime = "nodejs"/, "rendering needs the Node runtime, not the edge");
  assert.match(contents, /assertReportReadRateLimit/, "rendering costs a browser tab and must be rate limited");
  assert.match(
    contents,
    /x-robots-tag/,
    "a generated rendering must not become an indexable surface competing with the report"
  );
  // `inline`, so the tab the control opens SHOWS the document. With
  // `attachment` that tab goes blank and a file lands in a downloads folder,
  // which is how a reader ends up forwarding evidence they never looked at.
  // Saving still works from the viewer, and still uses this filename.
  assert.match(
    contents,
    /"content-disposition": `inline; filename="\$\{filename\}"`/,
    "the PDF must render in the browser's viewer rather than downloading unseen"
  );

  // The same rule is asserted again in scripts/smoke-docker.mjs, against a
  // real running container. That copy is the one CI runs, and it is the reason
  // switching this header passed every local gate and still failed the Docker
  // smoke: the contract lived in two files and only the far one was exercised.
  // Pin them to each other so a local run catches the divergence.
  const smoke = source("scripts/smoke-docker.mjs");
  const smokeRule = smoke.match(/if \(!\/\^(\w+);\\s\*filename=/);
  assert.ok(smokeRule, "the Docker smoke must still assert a content-disposition shape");
  assert.equal(
    smokeRule![1],
    "inline",
    "smoke-docker.mjs expects a different disposition than the route emits; they are one contract"
  );
});
