# Corrections ledger

The public/corrections.json file is the machine-readable, append-only record of
reviewed evidence corrections. Its contract is
public/corrections.schema.json.

## Invariants

- Never edit or delete a published event. Append a new event and set
  supersedesEventId when a prior disposition needs qualification.
- Never replace a report artifact in place. A corrected measurement receives a
  new report ID and is listed in replacementReportIds.
- Every reportIds and replacementReportIds reference is a retention pin. The
  static-report pruner keeps both the questioned evidence and any replacement,
  even when either artifact is older than the normal age limit or the pinned
  set exceeds the normal count limit.
- Every referenced report must already resolve to a valid committed static
  report plus provenance sidecar. A missing or unreadable referenced bundle
  aborts pruning before unrelated reports are considered.
- Retention parses the entire ledger before it evaluates any deletion. A
  missing, malformed, or contract-invalid ledger aborts pruning; it never falls
  back to an empty pin set.
- Use active when review found no artifact correction but a public
  clarification is warranted, corrected for a claim or metadata correction,
  superseded when newer evidence replaces the report, and withdrawn when the
  evidence should no longer support a claim.
- The summary must explain the disposition without implying that one automated
  visit proves universal site behavior. The detailsUrl must link to the public
  review record.
- Event IDs are sequential within a calendar year:
  SBL-CORR-YYYY-NNN.

## Review workflow

1. Open an evidence-problem issue with the report ID, scan date, disputed
   statement, expected statement, and supporting evidence.
2. Reproduce the rendered claim from the immutable report and provenance
   sidecar. Record whether the problem is an artifact defect, presentation
   defect, catalog issue, or ordinary visit variation.
3. Add the ledger event and any replacement report in one reviewed change.
4. Validate the JSON against the checked-in schema, run the retention tests,
   build the static site, and verify the public corrections page before
   publication. Report IDs must use the canonical YYYYMMDD- plus 32-lowercase-
   hex format so retention can pin their exact immutable bundles.

Security vulnerabilities, personal data, tokens, or sensitive unredacted URLs
must use GitHub private vulnerability reporting instead of a public issue.
