// The correction context the static smoke expects for one report ID, read
// from the raw public/corrections.json it checks the built site against.
//
// The smoke runs over the exported site without the compiled library, so it
// restates the rule of reportCorrections in lib/corrections-ledger-model.ts:
// a report's subject events are the events that name it and, for a privacy
// replacement, every non-privacy event that names the original it replaced,
// in ledger order; the last one is its current disposition, and any current
// state other than "active" suppresses indexing. A restated rule can drift
// from the one it restates, so lib/report-correction-surfaces.test.ts holds
// the two to the same answer for every committed report and for a ledger
// with a later event naming a removed original.

/** The events that apply to a report, in ledger order. */
export function reportSubjectCorrectionEvents(corrections, reportId) {
  const privacyEvent = corrections.entries.find(
    (event) => event.state === "privacy-superseded" && (event.replacementReportIds ?? []).includes(reportId)
  );
  const originalId = privacyEvent?.reportIds[privacyEvent.replacementReportIds.indexOf(reportId)];
  return corrections.entries.filter(
    (event) =>
      event.reportIds.includes(reportId) ||
      (originalId !== undefined && event.state !== "privacy-superseded" && event.reportIds.includes(originalId))
  );
}

/** Whether the report's current disposition keeps it out of the sitemap and search. */
export function reportCorrectionSuppressesIndexing(corrections, reportId) {
  const current = reportSubjectCorrectionEvents(corrections, reportId).at(-1);
  return current !== undefined && current.state !== "active";
}
