import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { crossSiteLanding, crossSiteLandingLines, crossSiteLandingNote } from "./report-subject-landing";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import { makeGpcInterventionReportV2R2, makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import type { ScanRunV2R2 } from "./scan-report-v2-r2";
import { viewFromV1Report, viewFromV2 } from "./scan-report-views";
import type { NetworkRequestRecord, ScanResult } from "./types";

const root = process.cwd();

function source(file: string): string {
  return readFileSync(path.join(root, file), "utf8");
}

// The shape of the executed repro: brand-example.com answered 302 and the
// visit landed on the fixture's shop.example.com, so the only cross-site row
// is the requested site's own redirect response.
function redirectToLandingSite(run: ScanRunV2R2): void {
  run.subject.requested = { origin: "https://brand-example.com", registrableDomain: "brand-example.com", routeShape: "/" };
  const landing = run.evidence.requests[0];
  run.evidence.requests = [
    { ...landing, url: "https://brand-example.com/", domain: "brand-example.com", status: 302, thirdParty: true, tracker: null },
    { ...landing, id: landing.id + 1 }
  ];
}

function v1Request(overrides: Partial<NetworkRequestRecord>): NetworkRequestRecord {
  return {
    id: 1,
    url: "https://my.gov.au/",
    domain: "my.gov.au",
    method: "GET",
    resourceType: "document",
    status: 200,
    thirdParty: false,
    tracker: null,
    startedAtMs: 0,
    ...overrides
  };
}

test("a v2 visit that redirected to another site says so and names the counted redirect", () => {
  const report = makePublicSingleReportV2R2();
  redirectToLandingSite(report.run);
  const run = viewFromV2(report, 2).runs[0];

  assert.deepEqual(crossSiteLanding(run), {
    requestedHost: "brand-example.com",
    landedHost: "shop.example.com",
    requestedSite: "brand-example.com",
    landedSite: "example.com",
    countedRequests: 1,
    countedRedirects: 1,
    countedHosts: 1
  });
  assert.equal(
    crossSiteLandingNote(run),
    "Requested brand-example.com; the visit landed on shop.example.com, a different site, which this report describes. " +
      "Requests are classified against the landing site, so this report's cross-site totals count " +
      "1 request to brand-example.com (a redirect response) and 1 brand-example.com host."
  );
});

test("a same-site redirect, including a generalized subdomain, says nothing", () => {
  const report = makePublicSingleReportV2R2();
  report.run.subject.requested = { origin: "https://{label}.example.com", registrableDomain: "example.com", routeShape: "/" };
  assert.equal(crossSiteLandingNote(viewFromV2(report, 2).runs[0]), null);

  // v1 recorded no registrable domain, and the public-suffix library rejects
  // the marker host outright; read naively it would key to itself and claim
  // www.example.com is a different site from example.com.
  const v1 = makeScanReportV1() as ScanResult;
  v1.conditions.requestedUrl = "https://{label}.example.com/";
  v1.conditions.finalUrl = "https://www.example.com/{seg}";
  assert.equal(crossSiteLandingNote(viewFromV1Report(v1).runs[0]), null);
});

test("a v1 visit compares registrable domains under the public-suffix rule", () => {
  // The committed australia.gov.au reports: gov.au is a public suffix, so the
  // 301 from www.australia.gov.au to my.gov.au crossed sites and the scanner
  // flagged the hop third-party.
  const v1 = makeScanReportV1() as ScanResult;
  v1.summary.firstPartyDomain = "my.gov.au";
  v1.conditions.requestedUrl = "https://www.australia.gov.au/";
  v1.conditions.finalUrl = "https://my.gov.au/en/{seg}";
  v1.requests = [
    v1Request({ url: "https://www.australia.gov.au/", domain: "www.australia.gov.au", status: 301, thirdParty: true }),
    v1Request({ id: 2, url: "https://my.gov.au/en/{seg}" })
  ];
  assert.equal(
    crossSiteLandingNote(viewFromV1Report(v1).runs[0]),
    "Requested www.australia.gov.au; the visit landed on my.gov.au, a different site, which this report describes. " +
      "Requests are classified against the landing site, so this report's cross-site totals count " +
      "1 request to australia.gov.au (a redirect response) and 1 australia.gov.au host."
  );

  // A host with no public registrable domain yields no statement, not a guess.
  const special = makeScanReportV1() as ScanResult;
  special.conditions.requestedUrl = "http://redirecting-subject.test/";
  special.conditions.finalUrl = "http://other-site.test/landing";
  assert.equal(crossSiteLanding(viewFromV1Report(special).runs[0]), null);
});

test("a client-side redirect counts the requested site's rows without calling them redirects", () => {
  const report = makePublicSingleReportV2R2();
  redirectToLandingSite(report.run);
  const [hop, landing] = report.run.evidence.requests;
  report.run.evidence.requests = [
    { ...hop, status: 200 },
    { ...hop, id: 10, url: "https://cdn.brand-example.com/app.js", domain: "cdn.brand-example.com", resourceType: "script", status: 304 },
    { ...hop, id: 11, url: "https://cdn.brand-example.com/app.css", domain: "cdn.brand-example.com", resourceType: "stylesheet", status: 200 },
    landing
  ];
  const note = crossSiteLandingNote(viewFromV2(report, 2).runs[0]);
  assert.match(note ?? "", /cross-site totals count 3 requests to brand-example\.com and 2 brand-example\.com hosts\.$/);
  assert.doesNotMatch(note ?? "", /redirect response/);

  // A partial set of redirects is counted, not generalized to every row.
  report.run.evidence.requests[0] = { ...hop, status: 307 };
  assert.match(
    crossSiteLandingNote(viewFromV2(report, 2).runs[0]) ?? "",
    /count 3 requests to brand-example\.com \(1 redirect response among them\) and 2 brand-example\.com hosts\.$/
  );
});

test("comparisons label the arm that landed elsewhere and state an identical pair once", () => {
  const variantOnly = makeGpcInterventionReportV2R2();
  redirectToLandingSite(variantOnly.variant);
  const variantLines = crossSiteLandingLines(viewFromV2(variantOnly, 2));
  assert.equal(variantLines.length, 1);
  // A pair has two sets of totals, so an arm's sentence speaks for its visit,
  // in the identity line and in that arm's receipt alike.
  const variantSentence =
    "Requested brand-example.com; the visit landed on shop.example.com, a different site, which this report describes. " +
    "Requests are classified against the landing site, so this visit's cross-site totals count " +
    "1 request to brand-example.com (a redirect response) and 1 brand-example.com host.";
  assert.equal(variantLines[0], `Variant visit: ${variantSentence}`);
  const variantView = viewFromV2(variantOnly, 2);
  assert.equal(crossSiteLandingNote(variantView.runs[1]), variantSentence);
  assert.equal(crossSiteLandingNote(variantView.runs[0]), null);

  const both = makeGpcInterventionReportV2R2();
  redirectToLandingSite(both.baseline);
  redirectToLandingSite(both.variant);
  const bothLines = crossSiteLandingLines(viewFromV2(both, 2));
  assert.equal(bothLines.length, 1);
  assert.equal(
    bothLines[0],
    "Requested brand-example.com; both visits landed on shop.example.com, a different site, which this report describes. " +
      "Requests are classified against the landing site, so each visit's cross-site totals count " +
      "1 request to brand-example.com (a redirect response) and 1 brand-example.com host."
  );

  assert.deepEqual(crossSiteLandingLines(viewFromV2(makeGpcInterventionReportV2R2(), 2)), []);
});

test("the permalink states the landing in its identity block and receipt, and labels both addresses", () => {
  const context = source("app/_components/report-page-context.tsx");
  const identity = context.slice(context.indexOf('<header className="report-identity">'), context.indexOf("</header>"));
  assert.match(identity, /Requested address<\/span>\s*\{displayPublicUrl\(run\.conditions\.requestedUrl\)\}/);
  assert.match(identity, /\{crossSiteLandingLines\(view\)\.map\(/);
  const receipt = context.slice(context.indexOf("function RunReceipt"));
  assert.match(receipt, /const landingNote = crossSiteLandingNote\(run\);/);
  assert.match(receipt, /\{landingNote && <ReceiptFact term="Requested site"><span>\{landingNote\}<\/span><\/ReceiptFact>\}/);

  const header = source("app/_components/report-header.tsx");
  assert.match(header, /Recorded final address<\/span>\{" "\}\s*\{finalUrl \?/);

  // The rule carries the public-suffix table; it must stay on server-rendered
  // surfaces and out of every client bundle.
  const clientFiles = ["app", "app/_components", "app/_hooks"]
    .flatMap((dir) => readdirSync(path.join(root, dir)).map((file) => path.join(dir, file)))
    .filter((file) => /\.tsx?$/.test(file) && /^\s*["']use client["']/.test(source(file)));
  assert.ok(clientFiles.length > 0);
  for (const file of clientFiles) {
    assert.doesNotMatch(source(file), /report-subject-landing/, `${file} is a client module`);
  }
});
