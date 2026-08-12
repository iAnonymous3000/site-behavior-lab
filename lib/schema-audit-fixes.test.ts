import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { isFeaturedSiteConfig } from "./featured-sites";

const root = process.cwd();

/**
 * Guards for the non-ScanReport public shapes.
 *
 * The frozen ScanReport contract is the strong one. The shapes around it
 * (featured-sites, JSON-LD, provenance sidecars) had weaker guarantees, and
 * two of them were wrong in the same direction: a published surface asserting
 * something the code did not support.
 */

/**
 * `buildReportDataset` hard-coded "Automated Chromium visit". A PageGraph
 * import sets automation "brave-pagegraph" on the wire, so structured data
 * described an instrument that did not take the measurement. Structured data
 * is read by aggregators that never see the page, which makes a wrong value
 * here more durable than wrong prose.
 */
test("JSON-LD names the instrument that actually produced the run", () => {
  const jsonld = readFileSync(path.join(root, "lib/report-jsonld.ts"), "utf8");
  assert.doesNotMatch(
    jsonld,
    /measurementTechnique: "Automated Chromium visit"/,
    "measurementTechnique must be derived from the run, not hard-coded"
  );
  assert.match(jsonld, /measurementTechnique: measurementTechniqueFor\(run\.conditions\.automation\)/);
  // Every automation the wire can carry needs an honest string.
  const helper = jsonld.slice(jsonld.indexOf("function measurementTechniqueFor"));
  for (const automation of ["brave-pagegraph", "external"]) {
    assert.ok(helper.includes(`"${automation}"`), `${automation} needs its own description`);
  }
  assert.match(helper, /Automated Chromium visit/, "the Chromium case must remain");
});

/**
 * 13 of 81 committed sites carry scanAvailability, the type guard the homepage
 * runs validated only four strings, and the real rules lived in scripts. A
 * malformed or hand-edited block passed unnoticed and failed later, inside a
 * workflow.
 */
test("the featured catalog validates scanAvailability instead of ignoring it", () => {
  const base = {
    version: 2,
    categories: [{ id: "money", label: "Money" }],
    sites: [{ domain: "example.com", label: "Example", category: "money", url: "https://example.com/" }]
  };
  assert.equal(isFeaturedSiteConfig(base), true, "a catalog with no availability block stays valid");

  const valid = {
    ...base,
    sites: [
      {
        ...base.sites[0],
        scanAvailability: {
          status: "temporarily-unavailable",
          reason: "automation-blocked",
          observedAt: "2026-08-01T00:00:00.000Z",
          reviewAfter: "2026-09-01T00:00:00.000Z",
          workflowRunIds: ["30798490888"]
        }
      }
    ]
  };
  assert.equal(isFeaturedSiteConfig(valid), true, "the committed shape must validate");

  // Each of these passed the old guard, which checked four strings and ignored
  // every other key.
  const rejected: Record<string, unknown>[] = [
    { status: "available", reason: "x", observedAt: "2026-08-01T00:00:00.000Z", reviewAfter: "2026-09-01T00:00:00.000Z" },
    { status: "temporarily-unavailable", reason: "", observedAt: "2026-08-01T00:00:00.000Z", reviewAfter: "2026-09-01T00:00:00.000Z" },
    { status: "temporarily-unavailable", reason: "x", observedAt: "not-a-date", reviewAfter: "2026-09-01T00:00:00.000Z" },
    { status: "temporarily-unavailable", reason: "x", observedAt: "2026-08-01T00:00:00.000Z" },
    { status: "temporarily-unavailable", reason: "x", observedAt: "2026-08-01T00:00:00.000Z", reviewAfter: "2026-09-01T00:00:00.000Z", surprise: 1 },
    // Numbers are the shape I first assumed; the producer writes strings, and
    // the committed catalog proved it. Both wrong forms must be refused.
    { status: "temporarily-unavailable", reason: "x", observedAt: "2026-08-01T00:00:00.000Z", reviewAfter: "2026-09-01T00:00:00.000Z", workflowRunIds: [30798490888] },
    { status: "temporarily-unavailable", reason: "x", observedAt: "2026-08-01T00:00:00.000Z", reviewAfter: "2026-09-01T00:00:00.000Z", workflowRunIds: ["0"] },
    { status: "temporarily-unavailable", reason: "x", observedAt: "2026-08-01T00:00:00.000Z", reviewAfter: "2026-09-01T00:00:00.000Z", workflowRunIds: ["abc"] }
  ];
  for (const scanAvailability of rejected) {
    assert.equal(
      isFeaturedSiteConfig({ ...base, sites: [{ ...base.sites[0], scanAvailability }] }),
      false,
      `must reject ${JSON.stringify(scanAvailability)}`
    );
  }
});

test("the committed catalog satisfies the guard that now reads it", () => {
  const catalog = JSON.parse(readFileSync(path.join(root, "public/featured-sites.json"), "utf8"));
  assert.equal(isFeaturedSiteConfig(catalog), true, "the shipped catalog must pass its own validator");
  const withAvailability = catalog.sites.filter(
    (site: Record<string, unknown>) => site.scanAvailability !== undefined
  );
  assert.ok(
    withAvailability.length > 0,
    "if no site carries availability the guard above is no longer exercised by real data"
  );
});
