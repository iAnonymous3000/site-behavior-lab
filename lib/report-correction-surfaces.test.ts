import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { publishedReportCorrections } from "./published-report-corrections";
import { readStoredScanReport } from "./scan-report-reader";
import { toReportView } from "./scan-report-view";
import { buildReportHeadline } from "./report-headline";
import { buildFindings } from "./report-findings";
import { requestLogToCsv, requestLogRecordingState } from "./csv-export";
import ledger from "../public/corrections.json";

test("corrected archived purchase claims cannot lead the headline, findings or CSV without correction context", () => {
  const event = ledger.entries.find(e => e.state === "corrected")!;
  assert.ok(event);
  for (const id of event.reportIds) {
    const read = readStoredScanReport(JSON.parse(readFileSync(`public/reports/${id}.json`, "utf8")));
    assert.ok(read.ok);
    if (!read.ok) continue;
    const view = toReportView(read.stored);
    const context = publishedReportCorrections(id);
    assert.equal(context.suppressIndexing, true);
    const headline = buildReportHeadline(view);
    assert.equal(headline.semantic.story, "correction");
    assert.equal(headline.semantic.reassuring, false);
    assert.deepEqual(headline.stats, []);
    assert.match(headline.shareText, /correction/);
    assert.deepEqual(buildFindings(view, null).map(f => f.id), ["public-correction"]);
    const run = view.runs[0];
    const csv = requestLogToCsv(run.evidence.requests, requestLogRecordingState(run), context.subjectEvents);
    assert.match(csv, /correction_event,correction_state,correction_summary,correction_url/);
    for (const correction of context.subjectEvents) assert.ok(csv.includes(correction.eventId));
  }
});


test("historical policy alias misses are unknown, not evidence that Amazon or Oracle was omitted", () => {
  const event = ledger.entries.find(e => e.eventId.endsWith("002"))!;
  assert.ok(event);
  let checked = 0;
  for (const id of event.reportIds) {
    if (publishedReportCorrections(id).suppressIndexing) continue;
    const read = readStoredScanReport(JSON.parse(readFileSync(`public/reports/${id}.json`, "utf8")));
    assert.ok(read.ok);
    if (!read.ok) continue;
    const view = toReportView(read.stored);
    for (const run of view.runs) {
      if (!run.evidence.privacyPolicy?.unmentionedEntities.some(name => name === "Amazon Ads" || name === "Oracle Advertising")) continue;
      const singleView = { ...view, runs: [run] };
      const finding = buildFindings(singleView, null).find(f => f.id === "privacy-policy");
      if (!finding) continue;
      assert.match(finding.evidence ?? "", /historical alias matcher was incomplete/);
      assert.doesNotMatch(finding.lead, /(?:Amazon Ads|Oracle Advertising).*sent requests.*matched none/);
      checked++;
    }
  }
  assert.ok(checked > 0);
});
