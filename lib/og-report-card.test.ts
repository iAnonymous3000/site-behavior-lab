import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { shieldsRunMeasurement } from "./report-insights";
import { buildReportHeadline, type ReportHeadline } from "./report-headline";
import { readStoredScanReport } from "./scan-report-reader";
import { toReportView } from "./scan-report-view";
import { makeShieldsInterventionReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { comparisonArmViews, type ReportView } from "./scan-report-views";

type OgReportCardModule = {
  OG_REPORT_SUBHEAD_MAX_CHARACTERS: number;
  buildReportCardSubhead: (view: ReportView, headline?: ReportHeadline) => string;
  buildReportCardAttribution: (view: ReportView, domain?: string) => string;
};

const reportsDir = path.join(process.cwd(), "public", "reports");
const reportFilePattern = /^[0-9]{8}-[0-9a-f]{32}\.json$/;

/**
 * The unit compiler intentionally excludes TSX. Compile this one renderer in
 * memory so the regression exercises its real semantic fitting function
 * without expanding the test build to every React component in lib/.
 */
function loadOgReportCardModule(): OgReportCardModule {
  const file = path.join(process.cwd(), "lib", "og-report-card.tsx");
  const source = readFileSync(file, "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2017
    }
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  const localRequire = (id: string): unknown => {
    if (id === "next/og") return { ImageResponse: class ImageResponse {} };
    if (id === "./report-insights") return require("./report-insights");
    if (id === "./report-headline") return require("./report-headline");
    if (id === "./scan-report-views") return require("./scan-report-views");
    return require(id);
  };
  const evaluate = new Script(`(function (require, module, exports) { ${compiled}\n})`, { filename: file }).runInThisContext() as (
    requireModule: (id: string) => unknown,
    targetModule: typeof module,
    exports: typeof module.exports
  ) => void;
  evaluate(localRequire, module, module.exports);
  return module.exports as OgReportCardModule;
}

function readReportView(name: string): ReportView {
  const raw: unknown = JSON.parse(readFileSync(path.join(reportsDir, name), "utf8"));
  const read = readStoredScanReport(raw);
  if (!read.ok) throw new Error(`reader rejected committed report ${name}: ${read.error}`);
  return toReportView(read.stored);
}

function stableOverLimitShieldsView(): ReportView {
  const report = makeShieldsInterventionReportV2R2();
  const view = toReportView({ schemaVersion: 2, schemaRevision: 2, report });
  const arms = comparisonArmViews(view);
  if (!arms) throw new Error("stable Shields fixture lost its comparison arms");
  arms.baseline.counts.totalRequests = 342;
  arms.baseline.counts.thirdPartyRequests = 298;
  arms.variant.counts.totalRequests = 142;
  arms.variant.counts.thirdPartyRequests = 98;
  arms.variant.counts.shieldsBlockedRequests = 30;
  const shields = arms.variant.verificationFacts?.shields;
  if (!shields) throw new Error("stable Shields fixture lost its verification facts");
  shields.requestsEvaluated = 142;
  shields.requestsMatched = 30;
  shields.requestsActuallyBlocked = 30;
  return view;
}

test("an over-limit Shields OG report keeps its complete qualification in bounded copy", () => {
  const og = loadOgReportCardModule();
  const view = stableOverLimitShieldsView();
  const headline = buildReportHeadline(view);
  const subhead = og.buildReportCardSubhead(view, headline);
  const arms = comparisonArmViews(view);

  assert.ok(headline.subhead.length > og.OG_REPORT_SUBHEAD_MAX_CHARACTERS, "fixture must exercise semantic fitting");
  assert.ok(arms, "fixture must remain a comparison");
  const removed = arms.baseline.counts.thirdPartyRequests - arms.variant.counts.thirdPartyRequests;
  const engineBlocks = shieldsRunMeasurement(arms.variant);
  assert.match(subhead, /not a live Brave-browser visit/);
  assert.match(subhead, new RegExp(`${arms.baseline.counts.totalRequests.toLocaleString("en-US")} requests? without blocking`));
  assert.match(subhead, new RegExp(`${removed.toLocaleString("en-US")} fewer third-party requests?`));
  if (engineBlocks?.kind === "engine-blocked") {
    assert.match(subhead, new RegExp(`directly stopped ${engineBlocks.count.toLocaleString("en-US")} requests?`));
    assert.match(subhead, /prevented follow-on requests/);
  }
  assert.match(subhead, /run-to-run variance/);
  assert.ok(subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);
  assert.doesNotMatch(subhead, /(?:\.\.\.|…)$/);
});

test("report social-card attribution names the observed site and UTC scan date", () => {
  const og = loadOgReportCardModule();
  const view = stableOverLimitShieldsView();
  const attribution = og.buildReportCardAttribution(view);
  assert.match(attribution, new RegExp(`^${view.domain.replace(".", "\\.")} · latest visit `));
  assert.doesNotMatch(attribution, /date not recorded/);

  const withoutDate = structuredClone(view);
  withoutDate.scannedAt = null;
  withoutDate.latestRunAt = null;
  assert.equal(
    og.buildReportCardAttribution(withoutDate, "example.com"),
    "example.com · latest visit date not recorded"
  );
});

test("an over-long subhead drops its secondary observation, never its qualification", () => {
  // The real case (homedepot.com, 2026-07-27 corpus refresh): a pixel
  // identifier finding whose subhead runs 415 characters. The compaction above
  // only knows how to restate a Shields comparison, so this fell straight
  // through to the withheld-claim fallback and the card published no finding
  // at all. Dropping the trailing "It also looks like ..." clause states
  // nothing false and keeps the lead claim AND its hedge.
  const og = loadOgReportCardModule();
  const view = stableOverLimitShieldsView();
  const primary =
    "An advertising pixel on shop.example attached populated personal-identifier fields (external ID) to the events it reported. " +
    "These fields exist to match a visit to a known person; the scanner records only that they were filled, never their values, so what they contained is not verified.";
  const secondary =
    " It also looks like a third-party script registered listeners on keyboard input and 4 browser-fingerprinting heuristics matched.";
  const headline = {
    ...buildReportHeadline(view),
    subhead: `${primary}${secondary}`,
    subheadPrimaryClaim: primary
  };
  assert.ok(headline.subhead.length > og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);

  const subhead = og.buildReportCardSubhead(view, headline);
  assert.equal(subhead, primary);
  assert.doesNotMatch(subhead, /^Automated-visit headline only/);
  // The qualification is the whole point of keeping it.
  assert.match(subhead, /never their values/);
  assert.ok(subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS);

  // When even the lead claim will not fit, withholding is still correct.
  const unfittable = {
    ...headline,
    subhead: `${"x".repeat(400)}${secondary}`,
    subheadPrimaryClaim: "x".repeat(400)
  };
  assert.match(og.buildReportCardSubhead(view, unfittable), /^Automated-visit headline only/);
});

test("every committed OG report has bounded, non-truncated subhead copy", () => {
  const og = loadOgReportCardModule();
  for (const name of readdirSync(reportsDir).filter((entry) => reportFilePattern.test(entry))) {
    const view = readReportView(name);
    const headline = buildReportHeadline(view);
    const subhead = og.buildReportCardSubhead(view, headline);
    assert.ok(subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS, `${name} has ${subhead.length} characters`);
    assert.doesNotMatch(subhead, /(?:\.\.\.|…)$/, `${name} ends in visual truncation`);
    assert.doesNotMatch(subhead, /^Automated-visit headline only/, `${name} fell back instead of retaining its qualification`);
    if (headline.subhead.length <= og.OG_REPORT_SUBHEAD_MAX_CHARACTERS) assert.equal(subhead, headline.subhead, name);
  }
});
