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
    shieldsThirdPartyChange: -90,
    category: "shopping",
    categoryLabel: "Shopping",
    scannedAt: "2026-07-02T00:00:00.000Z",
    reportType: "comparison",
    comparisonType: "shields",
    device: "desktop",
    gpcEnabled: true,
    consentMode: "observe",
    consentClicks: null,
    status: 200,
    capped: false,
    requestedUrl: "https://shop.example/",
    finalUrl: "https://shop.example/",
    schemaVersion: 1,
    schemaRevision: null,
    schemaOrigin: "legacy-derived",
    limited: true,
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
      makeEntry({ id: "20260625-" + "b".repeat(32), shieldsThirdPartyChange: null, comparisonType: undefined, reportType: "single" })
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
  assert.equal(rows[1].shieldsThirdPartyChange, null);
});

test("the JSON payload embeds the measured-corpus framing", () => {
  const rows = buildCorpusExportRows([makeEntry({ id: "20260702-" + "a".repeat(32) })], "https://sitebehavior.org");
  const payload = buildCorpusExportPayload(rows, {
    generatedAt: "2026-07-02T16:00:00.000Z",
    siteCount: 104,
    measuredSampleSize: 101
  });

  assert.equal(payload.reportCount, 1);
  // Coverage and measurement are separate concepts: siteCount is every site
  // that loaded (capped recordings included), measuredSampleSize the
  // statistics basis, and the note defines both.
  assert.equal(payload.siteCount, 104);
  assert.equal(payload.measuredSampleSize, 101);
  assert.equal(payload.note, CORPUS_EXPORT_NOTE);
  assert.match(payload.note, /not a random sample of the web/);
  assert.match(payload.note, /run-to-run variance/);
  assert.match(payload.note, /measuredSampleSize counts the sites/);
  // Capped counts are floors/snapshots, never measured behavior.
  assert.match(payload.note, /floors cut off mid-collection/);
  assert.match(payload.note, /end-state snapshots of an interrupted visit/);
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

test("consent rows expose the dispatched click state so unclicked runs are filterable", () => {
  const rows = buildCorpusExportRows(
    [
      makeEntry({
        id: "20260702-" + "a".repeat(32),
        comparisonType: "consent",
        consentMode: "accept-all",
        consentClicks: "none",
        shieldsThirdPartyChange: null
      })
    ],
    "https://sitebehavior.org"
  );

  assert.equal(rows[0].consentClicks, "none");
  // The note must tell researchers that anything short of accept-and-reject
  // leaves at least one run in the pre-consent state, so the row is not a
  // verified choice comparison.
  assert.match(CORPUS_EXPORT_NOTE, /consent_clicks/);
  assert.match(CORPUS_EXPORT_NOTE, /pre-consent state/);
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
    "id,domain,category,category_label,report_url,json_url,scanned_at,report_type,comparison_type,device,gpc_enabled,consent_mode,consent_clicks,status,request_capped,headline,third_party_requests,tracker_requests,third_party_cookies,shields_third_party_change,delta_third_party_requests,delta_tracker_requests,previous_report_id,previous_scanned_at,schema_version,schema_revision,schema_origin,limited"
  );
  assert.match(row, /"shop\.example told Google, Meta ""you were here""\."/);
  assert.match(row, /,desktop,yes,observe,,200,/);
  // Schema columns: every current corpus row is v1, legacy-derived, limited.
  assert.match(row, /,1,,legacy-derived,yes$/);
  assert.equal(csv.endsWith("\r\n"), true);
});

test("signed Shields changes pass through unclamped and the payload publishes the direction mix", () => {
  // Counterexample pin: an increased pair (more third-party requests with
  // blocking on) must export its positive signed value, never a clamped zero,
  // and the payload summary must count it as increased.
  const rows = buildCorpusExportRows(
    [
      makeEntry({ id: "20260702-" + "a".repeat(32), shieldsThirdPartyChange: -77 }),
      makeEntry({ id: "20260706-" + "b".repeat(32), shieldsThirdPartyChange: 264 }),
      makeEntry({ id: "20260706-" + "c".repeat(32), shieldsThirdPartyChange: 0 }),
      makeEntry({ id: "20260706-" + "d".repeat(32), shieldsThirdPartyChange: null, comparisonType: undefined, reportType: "single" })
    ],
    "https://sitebehavior.org"
  );

  assert.equal(rows[0].shieldsThirdPartyChange, -77);
  assert.equal(rows[1].shieldsThirdPartyChange, 264);
  assert.equal(rows[2].shieldsThirdPartyChange, 0);

  const payload = buildCorpusExportPayload(rows, {
    generatedAt: "2026-07-11T00:00:00.000Z",
    siteCount: 4,
    measuredSampleSize: 4
  });
  assert.deepEqual(payload.shieldsChangeSummary, { pairedReports: 3, decreased: 1, flat: 1, increased: 1 });
  // The note defines the signed semantics and the summary by name.
  assert.match(payload.note, /shields_third_party_change is the SIGNED/);
  assert.match(payload.note, /shieldsChangeSummary/);
  assert.match(payload.note, /not clamped to zero/);

  // The CSV row keeps the sign.
  const csv = corpusExportToCsv(rows);
  const lines = csv.split("\r\n");
  assert.match(lines[1], /,-77,/);
  assert.match(lines[2], /,264,/);
});

test("rows carry the schema generation so researchers can filter by wire version", () => {
  const rows = buildCorpusExportRows([makeEntry({ id: "20260702-" + "a".repeat(32) })], "https://sitebehavior.org");
  assert.equal(rows[0].schemaVersion, 1);
  assert.equal(rows[0].schemaRevision, null);
  assert.equal(rows[0].schemaOrigin, "legacy-derived");
  assert.equal(rows[0].limited, true);
  assert.match(CORPUS_EXPORT_NOTE, /schema_version/);
  assert.match(CORPUS_EXPORT_NOTE, /legacy-derived/);
});
