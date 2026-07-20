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
    runOutcome: "complete",
    requestEvidenceComplete: true,
    cookieEvidenceComplete: true,
    capped: false,
    requestedUrl: "https://shop.example/",
    finalUrl: "https://shop.example/",
    schemaVersion: 1,
    schemaRevision: null,
    schemaOrigin: "legacy-derived",
    limited: true,
    consentChoiceState: null,
    variantConsentChoiceState: null,
    comparisonDecisionMode: "comparable",
    compatibilityFingerprintOrigin: "legacy-derived",
    compatibilityFingerprintMatched: true,
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
      makeEntry({
        id: "20260625-" + "b".repeat(32),
        shieldsThirdPartyChange: null,
        comparisonType: undefined,
        reportType: "single",
        comparisonDecisionMode: null,
        compatibilityFingerprintOrigin: null,
        compatibilityFingerprintMatched: null
      })
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
  assert.equal(rows[1].comparisonDecisionMode, null);
  assert.equal(rows[1].compatibilityFingerprintOrigin, null);
  assert.equal(rows[1].compatibilityFingerprintMatched, null);
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
  // that loaded (capped recordings included), measuredSampleSize is the exact
  // legacy-v1 passive percentile cohort, and the note defines both.
  assert.equal(payload.siteCount, 104);
  assert.equal(payload.measuredSampleSize, 101);
  assert.equal(payload.note, CORPUS_EXPORT_NOTE);
  assert.match(payload.note, /not a random sample of the web/);
  assert.match(payload.note, /run-to-run variance/);
  assert.match(payload.note, /measuredSampleSize is the exact current percentile cohort/);
  assert.match(payload.note, /passive observe consent state/);
  assert.match(payload.note, /cross-version cohort can differ/);
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
  assert.equal(rows[0].consentChoiceState, null, "v1 click dispatch never becomes a verifier state");
  assert.equal(rows[0].variantConsentChoiceState, null);
  // The note must tell researchers that anything short of accept-and-reject
  // leaves at least one run in the pre-consent state, so the row is not a
  // complete choice comparison. Dispatch and r2 verification stay distinct.
  assert.match(CORPUS_EXPORT_NOTE, /consent_clicks/);
  assert.match(CORPUS_EXPORT_NOTE, /dispatch column, not a verification column/);
  assert.match(CORPUS_EXPORT_NOTE, /v2 reports \(r1 and r2\) carry recorded verification observations/);
  assert.match(CORPUS_EXPORT_NOTE, /pre-consent state/);
});

test("r2 rows keep click dispatch separate from both consent-arm verification states", () => {
  const rows = buildCorpusExportRows(
    [
      makeEntry({
        id: "20260714-" + "c".repeat(32),
        comparisonType: "consent",
        consentMode: "accept-all",
        consentClicks: "accept-and-reject",
        consentChoiceState: "verified",
        variantConsentChoiceState: "contradicted",
        schemaVersion: 2,
        schemaRevision: 2,
        schemaOrigin: "v2",
        limited: false,
        comparisonDecisionMode: "raw-only",
        compatibilityFingerprintOrigin: "recorded",
        compatibilityFingerprintMatched: false,
        shieldsThirdPartyChange: null
      })
    ],
    "https://sitebehavior.org"
  );

  assert.equal(rows[0].consentClicks, "accept-and-reject");
  assert.equal(rows[0].consentChoiceState, "verified", "the lead consent arm is accept-all");
  assert.equal(rows[0].variantConsentChoiceState, "contradicted", "the variant consent arm is reject-all");
  assert.equal(rows[0].comparisonDecisionMode, "raw-only");
  assert.equal(rows[0].compatibilityFingerprintOrigin, "recorded");
  assert.equal(rows[0].compatibilityFingerprintMatched, false);

  assert.match(CORPUS_EXPORT_NOTE, /consent_choice_state records the lead run/);
  assert.match(CORPUS_EXPORT_NOTE, /variant_consent_choice_state records the comparison's variant arm/);
  assert.match(CORPUS_EXPORT_NOTE, /including every v1 run/);
});

test("comparison metadata exports the fingerprint verdict but deliberately omits raw digests", () => {
  const rows = buildCorpusExportRows(
    [
      makeEntry({
        id: "20260714-" + "d".repeat(32),
        comparisonDecisionMode: "comparable",
        compatibilityFingerprintOrigin: "recorded",
        compatibilityFingerprintMatched: true,
        schemaVersion: 2,
        schemaRevision: 2,
        schemaOrigin: "v2",
        limited: false
      })
    ],
    "https://sitebehavior.org"
  );

  const row = rows[0] as unknown as Record<string, unknown>;
  assert.equal(row.comparisonDecisionMode, "comparable");
  assert.equal(row.compatibilityFingerprintOrigin, "recorded");
  assert.equal(row.compatibilityFingerprintMatched, true);
  assert.equal("baselineMeasurementEnvironmentFingerprint" in row, false);
  assert.equal("variantMeasurementEnvironmentFingerprint" in row, false);
  assert.match(CORPUS_EXPORT_NOTE, /never a metric-family or causal gate/);
  assert.match(CORPUS_EXPORT_NOTE, /deliberately omits the raw baseline and variant fingerprint digests/);
  assert.match(CORPUS_EXPORT_NOTE, /two unknown fingerprints never match/);
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
    "id,domain,category,category_label,report_url,json_url,scanned_at,report_type,comparison_type,device,gpc_enabled,consent_mode,consent_clicks,status,request_capped,headline,third_party_requests,tracker_requests,third_party_cookies,shields_third_party_change,delta_third_party_requests,delta_tracker_requests,previous_report_id,previous_scanned_at,schema_version,schema_revision,schema_origin,limited,consent_choice_state,variant_consent_choice_state,comparison_decision_mode,compatibility_fingerprint_origin,compatibility_fingerprint_matched"
  );
  assert.match(row, /"shop\.example told Google, Meta ""you were here""\."/);
  assert.match(row, /,desktop,yes,observe,,200,/);
  // This fixture is a historical v1, legacy-derived, limited row.
  assert.match(row, /,1,,legacy-derived,yes,,,comparable,legacy-derived,true$/);
  assert.equal(csv.endsWith("\r\n"), true);
});

test("CSV preserves false versus unknown for the compatibility verdict", () => {
  const rows = buildCorpusExportRows(
    [
      makeEntry({
        id: "20260714-" + "e".repeat(32),
        consentChoiceState: "verified",
        variantConsentChoiceState: "failed",
        comparisonDecisionMode: "raw-only",
        compatibilityFingerprintOrigin: "recorded",
        compatibilityFingerprintMatched: false
      }),
      makeEntry({
        id: "20260714-" + "f".repeat(32),
        comparisonType: undefined,
        reportType: "single",
        comparisonDecisionMode: null,
        compatibilityFingerprintOrigin: null,
        compatibilityFingerprintMatched: null,
        shieldsThirdPartyChange: null
      })
    ],
    "https://sitebehavior.org"
  );
  const [header, comparison, single] = corpusExportToCsv(rows).trimEnd().split("\r\n").map((line) => line.split(","));
  const index = (name: string) => header.indexOf(name);

  assert.equal(comparison[index("consent_choice_state")], "verified");
  assert.equal(comparison[index("variant_consent_choice_state")], "failed");
  assert.equal(comparison[index("comparison_decision_mode")], "raw-only");
  assert.equal(comparison[index("compatibility_fingerprint_origin")], "recorded");
  assert.equal(comparison[index("compatibility_fingerprint_matched")], "false");
  assert.equal(single[index("comparison_decision_mode")], "");
  assert.equal(single[index("compatibility_fingerprint_origin")], "");
  assert.equal(single[index("compatibility_fingerprint_matched")], "");
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
      makeEntry({
        id: "20260706-" + "d".repeat(32),
        shieldsThirdPartyChange: null,
        comparisonType: undefined,
        reportType: "single",
        comparisonDecisionMode: null,
        compatibilityFingerprintOrigin: null,
        compatibilityFingerprintMatched: null
      })
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
  assert.match(CORPUS_EXPORT_NOTE, /percentile distributions remain v1-only/);
});
