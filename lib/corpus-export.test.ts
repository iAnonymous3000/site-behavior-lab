import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCorpusExportPayload, buildCorpusExportRows, CORPUS_EXPORT_NOTE, corpusExportToCsv } from "./corpus-export";
import type { DirectoryEntry } from "./corpus-overview";

function makeEntry(overrides: Partial<DirectoryEntry> & { id: string }): DirectoryEntry {
  return {
    domain: "shop.example",
    tone: "warn",
    headline: "shop.example told Google you were here.",
    thirdPartyRequests: 120,
    trackerRequests: 40,
    thirdPartyCookies: 8,
    shieldsBlocked: 90,
    category: "shopping",
    categoryLabel: "Shopping",
    scannedAt: "2026-07-02T00:00:00.000Z",
    reportType: "comparison",
    comparisonType: "shields",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe",
    status: 200,
    ...overrides
  };
}

test("rows carry absolute report URLs and since-last-scan deltas", () => {
  const rows = buildCorpusExportRows(
    [
      makeEntry({
        id: "20260702-" + "a".repeat(32),
        sinceLastScan: {
          previousId: "20260625-" + "b".repeat(32),
          previousScannedAt: "2026-06-25T00:00:00.000Z",
          thirdPartyRequests: 12,
          trackerRequests: -3
        }
      }),
      makeEntry({ id: "20260625-" + "b".repeat(32), shieldsBlocked: null, comparisonType: undefined, reportType: "single" })
    ],
    "https://sitebehavior.org/"
  );

  assert.equal(rows[0].reportUrl, `https://sitebehavior.org/reports/20260702-${"a".repeat(32)}/`);
  assert.equal(rows[0].jsonUrl, `https://sitebehavior.org/reports/20260702-${"a".repeat(32)}.json`);
  assert.equal(rows[0].deltaThirdPartyRequests, 12);
  assert.equal(rows[0].deltaTrackerRequests, -3);
  assert.equal(rows[0].previousReportId, `20260625-${"b".repeat(32)}`);
  // No delta claimed for a report without a same-kind predecessor.
  assert.equal(rows[1].deltaThirdPartyRequests, null);
  assert.equal(rows[1].comparisonType, null);
  assert.equal(rows[1].shieldsBlocked, null);
});

test("the JSON payload embeds the measured-corpus framing", () => {
  const rows = buildCorpusExportRows([makeEntry({ id: "20260702-" + "a".repeat(32) })], "https://sitebehavior.org");
  const payload = buildCorpusExportPayload(rows, { generatedAt: "2026-07-02T16:00:00.000Z", siteCount: 104 });

  assert.equal(payload.reportCount, 1);
  assert.equal(payload.siteCount, 104);
  assert.equal(payload.note, CORPUS_EXPORT_NOTE);
  assert.match(payload.note, /not a random sample of the web/);
  assert.match(payload.note, /run-to-run variance/);
  // Failed loads are flagged, and the note tells researchers what the flag means.
  assert.match(payload.note, /status of 400 or higher/);
});

test("rows expose the lead run's HTTP status so failed loads are filterable", () => {
  const rows = buildCorpusExportRows(
    [
      makeEntry({ id: "20260702-" + "a".repeat(32) }),
      makeEntry({ id: "20260706-" + "c".repeat(32), status: 403, headline: "shop.example returned an error, so there was little to scan." })
    ],
    "https://sitebehavior.org"
  );
  assert.equal(rows[0].status, 200);
  assert.equal(rows[1].status, 403);
});

test("CSV pins the header and escapes commas and quotes in headlines", () => {
  const csv = corpusExportToCsv(
    buildCorpusExportRows(
      [makeEntry({ id: "20260702-" + "a".repeat(32), headline: 'shop.example told Google, Meta "you were here".' })],
      "https://sitebehavior.org"
    )
  );
  const [header, row] = csv.split("\r\n");

  assert.equal(
    header,
    "id,domain,category,category_label,report_url,json_url,scanned_at,report_type,comparison_type,device,gpc_enabled,consent_mode,status,headline,third_party_requests,tracker_requests,third_party_cookies,shields_blocked,delta_third_party_requests,delta_tracker_requests,previous_report_id,previous_scanned_at"
  );
  assert.match(row, /"shop\.example told Google, Meta ""you were here""\."/);
  assert.match(row, /,desktop,yes,observe,200,/);
  assert.equal(csv.endsWith("\r\n"), true);
});
