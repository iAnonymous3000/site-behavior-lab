import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { reportNewVisitTarget, reportRescanTargets } from "./report-rescan-targets";
import { reportActivation } from "./report-trust";
import { scanPrefillHref } from "./scan-prefill";
import { readStoredScanReport } from "./scan-report-reader";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { toReportView, viewFromV1Report, type ReportView } from "./scan-report-views";
import type { ScanResult } from "./types";

/**
 * An r2 single report asked for `requested` that landed on `observed`, read
 * back through the reader. URLs are split as text, since a parser would
 * percent-encode a route shape's markers.
 */
function r2View(requested: string, observed = requested): ReportView {
  const wire = makePublicSingleReportV2R2();
  const subject = (value: string) => {
    const [, origin, routeShape] = /^(https?:\/\/[^/]+)(\/.*)$/.exec(value) ?? [];
    const domain = origin.replace(/^https?:\/\//, "").split(".").slice(-2).join(".");
    return { origin, registrableDomain: domain, routeShape };
  };
  wire.run.subject = { requested: subject(requested), observed: subject(observed) };
  const read = readStoredScanReport(JSON.parse(JSON.stringify(wire)));
  assert.equal(read.ok, true, `the reader refused the ${requested} fixture`);
  if (!read.ok) throw new Error("fixture invariant");
  return toReportView(read.stored);
}

function v1View(requestedUrl: string): ReportView {
  const legacy = makeScanReportV1() as ScanResult;
  legacy.conditions.requestedUrl = requestedUrl;
  return viewFromV1Report(legacy);
}

test("the header's rescan links and a new visit read one derivation of the target", () => {
  for (const view of [
    r2View("https://www.example.com/"),
    r2View("https://shop.example.com/products/{seg}"),
    v1View("https://www.example.com/account/settings"),
    v1View("https://example.com/{seg}/settings")
  ]) {
    const { exactTarget, siteTarget } = reportRescanTargets(view);
    const activation = reportActivation({ id: "id", reportUrl: "https://sitebehavior.org/reports/id/", siteHistoryAvailable: false, view });
    assert.equal(activation.exactRescanHref, exactTarget ? scanPrefillHref(exactTarget) : null);
    assert.equal(activation.siteRescanHref, siteTarget ? scanPrefillHref(siteTarget) : null);
    // A new visit's page is one of these, never a third.
    const target = reportNewVisitTarget(view, true);
    assert.ok(target === null || target === exactTarget || target === siteTarget, `${target} is a second derivation`);
  }
  // reportActivation reads the shared module, not a copy of it.
  const trust = readFileSync(path.join(process.cwd(), "lib", "report-trust.ts"), "utf8");
  assert.ok(/const \{ exactTarget, siteTarget \} = reportRescanTargets\(input\.view\);/.test(trust), "expected report-trust to read the shared targets");
  assert.ok(!/safeNavigableHttpUrl/.test(trust), "expected report-trust to derive no target of its own");
});

test("only a fresh report has a page to visit again", () => {
  for (const view of [r2View("https://www.example.com/"), v1View("https://www.example.com/account/settings")]) {
    assert.equal(reportNewVisitTarget(view, false), null, "a committed report, an opened file or an archive comparison");
    assert.notEqual(reportNewVisitTarget(view, true), null);
  }
});

test("without a replayable route, a new visit needs a report that requested the site root (G4)", () => {
  // A legacy exact route replays, subpage or not.
  assert.equal(reportNewVisitTarget(v1View("https://www.example.com/account/settings"), true), "https://www.example.com/account/settings");
  assert.equal(reportNewVisitTarget(v1View("https://example.com/{seg}/settings"), true), null, "a privacy-marked legacy route");
  // Every v2 route is a shape: the target is the site root, https://<domain>/.
  assert.equal(reportNewVisitTarget(r2View("https://example.com/"), true), "https://example.com/");
  assert.equal(reportNewVisitTarget(r2View("https://www.example.com/"), true), "https://example.com/", "the www front door is the site root");
  for (const [requested, observed, reason] of [
    ["https://shop.example.com/products/{seg}", undefined, "a subpage"],
    ["https://www.example.com/about", undefined, "a named subpage"],
    ["https://www.example.com/?lang=fr", undefined, "the root with a query"],
    ["https://shop.example.com/", undefined, "another subdomain's root"],
    ["https://{label}.example.com/", undefined, "a hidden label's root"],
    ["https://other.example/", "https://www.example.com/", "a landing on another site"]
  ] as const) {
    assert.equal(reportNewVisitTarget(r2View(requested, observed ?? requested), true), null, reason);
  }
});

test("every committed r2 report requested its site root, as the draft counted", () => {
  // The draft's count behind the owner's G4 ruling: all 63 r2 reports
  // requested a site root. Not pinned to a number, since retention moves the
  // corpus; every r2 report there must keep a page to visit again.
  const reportsDir = path.join(process.cwd(), "public", "reports");
  let r2 = 0;
  for (const name of readdirSync(reportsDir).filter((file) => /^[0-9]{8}-[0-9a-f]{32}\.json$/.test(file))) {
    const read = readStoredScanReport(JSON.parse(readFileSync(path.join(reportsDir, name), "utf8")));
    if (!read.ok || read.stored.schemaVersion !== 2) continue;
    r2 += 1;
    const view = toReportView(read.stored);
    assert.notEqual(reportNewVisitTarget(view, true), null, `${name} requested ${view.runs[0].conditions.requestedUrl}`);
  }
  assert.ok(r2 > 0, "no committed r2 report; this test would be vacuous");
});
