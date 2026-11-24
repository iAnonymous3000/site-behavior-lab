import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseCorrectionsLedger, reportCorrections, type CorrectionsLedgerEvent } from "./corrections-ledger-model";
import { LEDGER_CURRENCY_BOUNDARY, publishedCorrection, publishedCorrectionLine } from "./verify-report-corrections";

const committed = parseCorrectionsLedger(
  JSON.parse(readFileSync(path.join(process.cwd(), "public", "corrections.json"), "utf8"))
);

function ledgerOf(entries: object[]) {
  return parseCorrectionsLedger({
    $schema: "https://sitebehavior.org/corrections.schema.json",
    schemaVersion: 1,
    policy: "https://sitebehavior.org/corrections/",
    entries
  });
}

const reportId = "20260709-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const event = (eventId: string, state: string, publishedAt: string) => ({
  eventId,
  publishedAt,
  state,
  reportIds: [reportId],
  summary: `The ${state} event's own summary.`,
  detailsUrl: `https://sitebehavior.org/corrections/${eventId.toLowerCase()}/`
});

test("the verifier names the event the report page names, for every report in the committed ledger", () => {
  // One rule for the current event: the ledger model's currentSubjectEvent,
  // which the report page's notice uses. A report removed for privacy keeps
  // its own removal line instead.
  const ids = new Set(committed.entries.flatMap((entry) => [...entry.reportIds, ...(entry.replacementReportIds ?? [])]));
  assert.ok(ids.size > 0, "the committed ledger names reports");
  let named = 0;
  let removed = 0;
  for (const id of ids) {
    const corrections = reportCorrections(committed, id);
    const removedForPrivacy = corrections.subjectEvents.some((entry) => entry.state === "privacy-superseded");
    const expected: CorrectionsLedgerEvent | null = removedForPrivacy ? null : corrections.currentSubjectEvent;
    assert.equal(publishedCorrection(committed, id), expected, `${id}: the verifier's event`);
    if (expected === null) removed += Number(removedForPrivacy);
    else named += 1;
  }
  assert.ok(named > 0 && removed > 0, `both kinds are reached: ${named} named, ${removed} removed for privacy`);
});

test("a correction stands beside a later clarification, and the clarification never replaces it", () => {
  // No committed report reaches this, so the ledger is built here.
  const ledger = ledgerOf([
    event("SBL-CORR-2026-001", "corrected", "2026-07-10T12:00:00.000Z"),
    event("SBL-CORR-2026-002", "active", "2026-07-11T12:00:00.000Z")
  ]);
  assert.equal(
    publishedCorrectionLine(ledger, reportId),
    "This report was corrected: SBL-CORR-2026-001. The corrected event's own summary. Read the public review record: https://sitebehavior.org/corrections/sbl-corr-2026-001/. Matching bytes do not lift a published correction."
  );
});

test("each event state prints the owner's line, and a privacy removal prints none", () => {
  for (const state of ["corrected", "superseded", "withdrawn"]) {
    assert.equal(
      publishedCorrectionLine(ledgerOf([event("SBL-CORR-2026-001", state, "2026-07-10T12:00:00.000Z")]), reportId),
      `This report was ${state}: SBL-CORR-2026-001. The ${state} event's own summary. Read the public review record: https://sitebehavior.org/corrections/sbl-corr-2026-001/. Matching bytes do not lift a published correction.`
    );
  }
  assert.equal(
    publishedCorrectionLine(ledgerOf([event("SBL-CORR-2026-001", "active", "2026-07-10T12:00:00.000Z")]), reportId),
    "This report has a reviewed clarification: SBL-CORR-2026-001. The active event's own summary. Read the public review record: https://sitebehavior.org/corrections/sbl-corr-2026-001/."
  );
  const removal = {
    ...event("SBL-CORR-2026-001", "privacy-superseded", "2026-07-10T12:00:00.000Z"),
    replacementReportIds: ["20260709-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
  };
  assert.equal(publishedCorrectionLine(ledgerOf([removal]), reportId), null);
  assert.equal(publishedCorrectionLine(ledgerOf([]), reportId), null);
  assert.equal(
    LEDGER_CURRENCY_BOUNDARY,
    "that the corrections ledger in this working directory (public/corrections.json) is current."
  );
});

test("every committed event summary prints as published, ending a sentence", () => {
  // The line adds no punctuation after the summary, so each must end one.
  for (const entry of committed.entries) {
    assert.match(entry.summary, /[.?!]$/, `${entry.eventId}: its summary ends a sentence`);
  }
});
