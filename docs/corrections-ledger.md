# Corrections ledger

The public/corrections.json file is the machine-readable, append-only record of
reviewed evidence corrections. Its contract is
public/corrections.schema.json.

## Invariants

- Never edit or delete a published event. Append a new event and set
  supersedesEventId when a prior disposition needs qualification.
- Never replace a report artifact in place. A corrected measurement receives a
  new report ID and is listed in replacementReportIds.
- The one exception that removes published evidence is privacy-superseded,
  for a report that published data redaction should have removed. Each
  reportIds entry is paired, by position, with its redacted copy in
  replacementReportIds under a new report ID, so both arrays have the same
  length. The same change removes the original report and provenance sidecar
  and adds the replacement; the history gate
  (`npm run corrections:verify-history`) accepts only that removal, and still
  refuses any changed pinned byte, a removal with no privacy event, and an
  original left published. An original is removed for privacy at most once,
  and a privacy replacement appears in no other event.
- A privacy replacement is a redacted copy of the same measurement, so every
  other event recorded against its original applies to it, including events
  appended later that name the original. The removal reduces live exposure
  only: Git history and archived releases keep the original's bytes, removed
  values included, and release receipts and the transparency log keep its
  digests.
- Every reportIds and replacementReportIds reference is a retention pin, except
  an original removed for privacy. The static-report pruner keeps both the
  questioned evidence and any replacement, even when either artifact is older
  than the normal age limit or the pinned set exceeds the normal count limit.
- Every pinned report must already resolve to a valid committed static
  report plus provenance sidecar. A missing or unreadable pinned bundle
  aborts pruning before unrelated reports are considered. An original removed
  for privacy must have neither file.
- Retention parses the entire ledger before it evaluates any deletion. A
  missing, malformed, or contract-invalid ledger aborts pruning; it never falls
  back to an empty pin set.
- Use active when review found no artifact correction but a public
  clarification is warranted, corrected for a claim or metadata correction,
  superseded when newer evidence replaces the report, withdrawn when the
  evidence should no longer support a claim, and privacy-superseded when a
  redacted copy replaces a report for privacy.
- The summary must explain the disposition without implying that one automated
  visit proves universal site behavior. The detailsUrl must link to the public
  review record, a page under https://sitebehavior.org/corrections/ that this
  site builds: an event is permanent, and a link to a file view on a branch
  can change or break under it. A privacy-superseded summary and review
  record name the defect class, never the removed value.
- Event IDs are sequential within a calendar year:
  SBL-CORR-YYYY-NNN.

## Review workflow

1. Open an evidence-problem issue with the report ID, scan date, disputed
   statement, expected statement, and supporting evidence.
2. Reproduce the rendered claim from the immutable report and provenance
   sidecar. Record whether the problem is an artifact defect, presentation
   defect, catalog issue, or ordinary visit variation.
3. Add the ledger event and any replacement report in one reviewed change.
   A privacy replacement is produced by
   `npm run reports:remediate -- --privacy-replace <report-id>`, never by
   hand. It accepts only a committed v1 report whose sidecar attests its exact
   bytes and which the current sanitizer changes, writes the redacted copy
   under a new ID with the original's scan-date prefix, and removes the
   original only after the copy reads back. Like the pruner, it refuses during
   a measurement freeze. Then append the event and regenerate
   `npm run reports:manifest`, `npm run corpus:stats` and
   `npm run transparency:log`.
4. Validate the JSON against the checked-in schema, run the retention tests,
   build the static site, and verify the public corrections page before
   publication. Report IDs must use the canonical YYYYMMDD- plus 32-lowercase-
   hex format so retention can pin their exact immutable bundles.

Security vulnerabilities, personal data, tokens, or sensitive unredacted URLs
must use GitHub private vulnerability reporting instead of a public issue.
