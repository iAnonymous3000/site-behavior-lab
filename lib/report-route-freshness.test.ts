import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();

test("runtime report HTML, RSC, metadata, and social images opt out of persistent route caching", async () => {
  const freshness = await readFile(path.join(root, "lib/report-route-freshness.ts"), "utf8");
  const page = await readFile(path.join(root, "app/reports/[id]/page.tsx"), "utf8");
  const openGraph = await readFile(path.join(root, "app/reports/[id]/opengraph-image.tsx"), "utf8");
  const twitter = await readFile(path.join(root, "app/reports/[id]/twitter-image.tsx"), "utf8");
  const pagesBuild = await readFile(path.join(root, "scripts/build-github-pages.mjs"), "utf8");

  assert.match(freshness, /NEXT_PUBLIC_SITE_BEHAVIOR_LAB_STATIC_EXPORT !== "1"[\s\S]*await connection\(\)/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.doesNotMatch(page, /export async function generateStaticParams/);
  assert.equal((page.match(/await requireFreshRuntimeReportRequest\(\)/g) ?? []).length, 2);
  assert.equal((page.match(/readStoredReportForRequest\(id\)/g) ?? []).length, 2);
  assert.match(page, /cache\(\(id: string\) => readStoredReportForId\(id\)\)/);
  for (const source of [openGraph, twitter]) {
    assert.match(source, /await requireFreshRuntimeReportRequest\(\)/);
    assert.match(source, /export const dynamic = "force-dynamic"/);
    assert.doesNotMatch(source, /export async function generateStaticParams/);
  }
  assert.match(pagesBuild, /runtimeReportRouteFiles[\s\S]*page\.tsx[\s\S]*opengraph-image\.tsx[\s\S]*twitter-image\.tsx/);
  assert.match(pagesBuild, /prepareStaticReportRouteMode\(workDir\)/);
  assert.match(pagesBuild, /source\.replace\(runtimeReportRouteMode, staticReportRouteImplementation\)/);
  assert.match(pagesBuild, /staticReportRouteImplementation[\s\S]*generateStaticParams[\s\S]*listStaticReportIds/);
});
