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

/** The text enclosed by the parenthesis that `opener` ends with, opener included. */
function balancedParenthesis(source: string, opener: string): string {
  const start = source.indexOf(opener);
  assert.ok(start >= 0, `expected to find ${opener}`);
  let depth = 0;
  for (let index = start + opener.length - 1; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`${opener} is never closed`);
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

test("the PDF download is offered on the same deployment that can render it", () => {
  // The PDF is produced by rendering the printable route in a container-side
  // browser. The static export has neither the route nor a browser, so the
  // link must be behind the same gate: an unconditional one would ship a dead
  // download button on every committed report Pages serves.
  const context = source("app/_components/report-page-context.tsx");
  assert.match(context, /Open PDF/, "a reader needs a way to get the report as a document");
  // Opening beside the report rather than over it. A render can take tens of
  // seconds and can still refuse, so navigating the tab away would cost the
  // reader the page they were on for a document that may never arrive.
  assert.match(
    context,
    /href=\{reportPdfHref\(id\)\}\s*\n\s*target="_blank"/,
    "the PDF control must open in a new tab, like the one in report-header.tsx"
  );
  assert.match(
    context,
    /href=\{reportPdfHref\(id\)\}/,
    "the PDF link must use the helper that roots the API route at the origin, not the Pages base path"
  );

  // The download must sit INSIDE the export gate, not merely somewhere in the
  // same file. Take the block the gate opens and require the link within it.
  // Scanning to the first ")}" does NOT work: `printableReportHref(reportUrl)}`
  // is itself a ")}" and ends the slice one link early, so the first version of
  // this assertion failed on correct source. Match the gate's parenthesis.
  const gatedBlock = balancedParenthesis(context, "{!STATIC_EXPORT && (");
  assert.match(gatedBlock, /reportPdfHref\(id\)/, "the PDF link must be inside the !STATIC_EXPORT block");
  assert.match(gatedBlock, /printableReportHref\(reportUrl\)/, "the printable link must stay inside it too");
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
});
