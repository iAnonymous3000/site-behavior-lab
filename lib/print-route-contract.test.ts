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

test("the link to the printable route is conditioned on the same signal the build uses", () => {
  // The route is excluded from the static export, so an unconditional link
  // would ship a dead link on every one of the committed reports Pages serves.
  // The condition must be the export signal itself, not a proxy for it.
  const context = source("app/_components/report-page-context.tsx");
  assert.match(context, /Printable version/, "a reader needs a way to reach the complete rendering");
  assert.match(
    context,
    /NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT === "1"/,
    "the link must be gated on the export signal"
  );
  // Assert the gate and the helper, not a hand-built template: the first
  // version of this test matched `${reportUrl}print/` and so certified a
  // missing separator as correct. lib/site-url.test.ts owns the URL shape.
  assert.match(
    context,
    /\{!STATIC_EXPORT && \(/,
    "the printable link must render only when this is not the static export"
  );
  assert.match(
    context,
    /href=\{printableReportHref\(reportUrl\)\}/,
    "the printable link must use the normalising helper, not string concatenation"
  );
});
