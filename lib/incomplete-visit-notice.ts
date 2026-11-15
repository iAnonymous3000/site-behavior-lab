/**
 * The incomplete-visit notice's label and title: the shared header's notice,
 * the report page's limit line and the homepage record's limit line print the
 * same two strings. A module of its own, so a page can state them without
 * loading the header that also prints them.
 */
export const INCOMPLETE_VISIT_NOTICE = Object.freeze({
  label: "Evidence quality",
  title: "This report is built on an incomplete visit"
});
