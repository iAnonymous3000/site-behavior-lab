import assert from "node:assert/strict";
import { test } from "node:test";
import { siteHistoryLookCloserHrefFrom } from "./report-site-history";
import { reportActivation } from "./report-trust";
import { makePublicSingleReportV2R2 } from "./scan-report-v2-r2-fixtures";
import { viewFromV2 } from "./scan-report-views";
import { sitePagesBasePath } from "./site-url";

const ID = "20260721-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "20260722-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const THIRD = "20260723-cccccccccccccccccccccccccccccccc";

test("the cookie card's history view opens a site history that lists this report and another", () => {
  const view = viewFromV2(makePublicSingleReportV2R2(), 2);
  const input = { id: ID, view, committed: true };
  // The page the identity block's "View site history" action links, at its
  // report table, so the two never name different pages.
  const profilePath = reportActivation({ id: ID, reportUrl: "", siteHistoryAvailable: true, view }).profilePath;
  assert.equal(profilePath, "/sites/example.com");
  const listed = [
    { id: ID, siteKey: "example.com" },
    { id: OTHER, siteKey: "example.com" }
  ];
  assert.equal(siteHistoryLookCloserHrefFrom(listed, input), `${sitePagesBasePath()}${profilePath}/#history`);

  // One retained report for the site: there is no other visit to show, and
  // another site's reports, or a report keyed to no site, never count.
  const alone = [
    { id: ID, siteKey: "example.com" },
    { id: OTHER, siteKey: "example.org" },
    { id: THIRD, siteKey: null }
  ];
  assert.equal(siteHistoryLookCloserHrefFrom(alone, input), null);
  // A page that does not list this report does not show this visit's peers.
  assert.equal(
    siteHistoryLookCloserHrefFrom(
      [
        { id: OTHER, siteKey: "example.com" },
        { id: THIRD, siteKey: "example.com" }
      ],
      input
    ),
    null
  );
  // A share or a homepage result has no history, whatever the corpus lists.
  assert.equal(siteHistoryLookCloserHrefFrom(listed, { ...input, committed: false }), null);
});

test("a visit asked for a generalized host opens no history, as its identity block links none", () => {
  const report = makePublicSingleReportV2R2();
  report.run.subject.requested = { ...report.run.subject.requested, origin: "https://{label}.example.com" };
  const view = viewFromV2(report, 2);
  assert.equal(reportActivation({ id: ID, reportUrl: "", siteHistoryAvailable: true, view }).profilePath, null);
  assert.equal(
    siteHistoryLookCloserHrefFrom(
      [
        { id: ID, siteKey: "example.com" },
        { id: OTHER, siteKey: "example.com" }
      ],
      { id: ID, view, committed: true }
    ),
    null
  );
});
