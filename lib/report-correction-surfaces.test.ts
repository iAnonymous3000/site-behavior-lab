import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseCorrectionsLedger } from "./corrections-ledger-model";
import { publishedReportCorrections, publishedReportCorrectionWire } from "./published-report-corrections";
import { committedReportCreatedAt } from "./committed-report-created-at";
import { readStoredScanReport } from "./scan-report-reader";
import { toReportView, publicWireForExportOrPersistence, readScanTransportPayload } from "./scan-report-view";
import { asLocalReport, shareForLoadedReport } from "./client-report-reader";
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
    const initial = readScanTransportPayload(read.stored.report);
    assert.equal(initial.kind, "report");
    if (initial.kind !== "report") continue;
    const local = asLocalReport(initial.loaded);
    assert.equal(shareForLoadedReport(local), null);
    const reopened = readScanTransportPayload(JSON.parse(JSON.stringify(publicWireForExportOrPersistence(local))));
    assert.equal(reopened.kind, "report");
    if (reopened.kind !== "report") continue;
    assert.equal(reopened.loaded.view.reportId, id);
    assert.equal(buildReportHeadline(reopened.loaded.view).semantic.story, "correction");
    assert.deepEqual(buildFindings(reopened.loaded.view, null).map(f => f.id), ["public-correction"]);
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

test("a privacy replacement carries its removed original's correction context on every surface", () => {
  // Every replacement a privacy-superseded event names is checked. The floor
  // is the committed event: expected and checked both come from the parsed
  // ledger, so a refactor that stopped parsing the state would otherwise
  // leave both at zero and pass.
  const events = parseCorrectionsLedger(ledger).entries.filter(event => event.state === "privacy-superseded");
  assert.deepEqual(
    events.map(event => [event.eventId, event.reportIds.map((id, index) => [id, event.replacementReportIds?.[index]])]),
    [["SBL-CORR-2026-004", [
      ["20260727-f378d41658184b8e1b014ae2e41b8541", "20260727-4006618d80dc779268592042b119010e"],
      ["20260817-693b5bc1c455e1be2d0b42b4d8efa292", "20260817-8d7ada3c1897a6c494396ed15db32a53"]
    ]]]
  );
  const expected = events.reduce((count, event) => count + (event.replacementReportIds?.length ?? 0), 0);
  let checked = 0;
  for (const event of events) {
    for (const [index, originalId] of event.reportIds.entries()) {
      const replacementId = event.replacementReportIds?.[index] ?? "";
      // The pairing: a redacted copy keeps its original's scan date, and its
      // sidecar keeps the scan's creation clock, which falls on that date.
      assert.equal(replacementId.slice(0, 9), originalId.slice(0, 9), replacementId);
      for (const suffix of [".json", ".provenance.json"]) {
        assert.equal(existsSync(`public/reports/${originalId}${suffix}`), false, `${originalId}${suffix} is still published`);
      }
      const inherited = ledger.entries
        .filter(item => item.state !== "privacy-superseded" && item.reportIds.includes(originalId))
        .map(item => item.eventId);
      const context = publishedReportCorrections(replacementId);
      assert.equal(context.privacyReplacementOf, originalId);
      assert.deepEqual(context.subjectEvents.map(item => item.eventId), inherited);
      const wire = JSON.parse(publishedReportCorrectionWire(replacementId));
      assert.equal(wire.privacyReplacementOf, originalId);
      assert.deepEqual(wire.replacementEvents.map((item: { eventId: string }) => item.eventId), [event.eventId]);

      const read = readStoredScanReport(JSON.parse(readFileSync(`public/reports/${replacementId}.json`, "utf8")));
      assert.ok(read.ok);
      if (!read.ok) continue;
      const sidecar = JSON.parse(readFileSync(`public/reports/${replacementId}.provenance.json`, "utf8"));
      assert.equal(sidecar.createdAt, committedReportCreatedAt(read.stored), replacementId);
      assert.equal(sidecar.createdAt.slice(0, 10).replaceAll("-", ""), originalId.slice(0, 8), replacementId);
      const view = toReportView(read.stored);
      // Every surface keys its correction lookup on the identity inside the
      // wire, so a replacement that still names its original would show the
      // removal notice instead of the inherited context.
      assert.equal(view.reportId, replacementId);
      const current = context.currentSubjectEvent;
      if (current) assert.ok(buildReportHeadline(view).subhead.includes(current.eventId));
      const run = view.runs[0];
      const csv = requestLogToCsv(run.evidence.requests, requestLogRecordingState(run), context.subjectEvents);
      for (const eventId of inherited) assert.ok(csv.includes(eventId), `${replacementId} CSV lost ${eventId}`);
      checked++;
    }
  }
  assert.equal(checked, expected);
  assert.equal(checked, 2);
});
