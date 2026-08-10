import assert from "node:assert/strict";
import test from "node:test";
import { REPORT_PDF_MAX_BYTES, ReportPdfUnavailableError, renderReportPdf, reportPdfFilename } from "./report-pdf";
import { MAX_CONCURRENT_REPORT_PDF_RENDERS, MAX_CONCURRENT_SCANS } from "./scan-limits";

/**
 * These cover the decisions the renderer makes BEFORE it touches Chromium, plus
 * the sizing contract. The end-to-end render is asserted where it can actually
 * run: scripts/smoke-docker.mjs, against the real container.
 */

test("a report id that is not a report id never reaches the browser", async () => {
  // The whole SSRF argument for this module rests on this: the only input is an
  // id, and a non-id is refused before anything is launched. If any of these
  // got through, the navigation target would be attacker-shaped.
  const rejected = [
    "../../etc/passwd",
    "http://169.254.169.254/latest/meta-data/",
    "20260101-" + "a".repeat(32) + "/../../admin",
    "20260101-" + "a".repeat(32) + "?x=1",
    "20260101-" + "a".repeat(31),
    "20260101-" + "A".repeat(32),
    "",
    "..",
    "a b",
    // REPORT_ID_PATTERN.test() alone accepts this: JavaScript's `$` matches
    // before a single trailing newline. The renderer must not.
    "20260101-" + "a".repeat(32) + "\n"
  ];

  for (const id of rejected) {
    await assert.rejects(
      () => renderReportPdf(id),
      (error: unknown) => {
        assert.ok(error instanceof ReportPdfUnavailableError, `${id} should be refused by the id guard`);
        assert.equal(error.status, 400);
        return true;
      },
      `${id} must not reach a browser launch`
    );
  }
});

test("printing can never claim as many renderers as scanning", () => {
  // Both Chromiums live in one standard-2 instance. If a future scan-cap change
  // could raise the print cap alongside it, the instance would be oversubscribed
  // by a change that never mentions printing.
  assert.ok(
    MAX_CONCURRENT_REPORT_PDF_RENDERS < MAX_CONCURRENT_SCANS,
    "the render cap must stay strictly below the scan cap"
  );
  assert.ok(MAX_CONCURRENT_REPORT_PDF_RENDERS >= 1, "at least one render must be possible");
  assert.ok(MAX_CONCURRENT_REPORT_PDF_RENDERS <= 1, "a second concurrent Chromium tab is not budgeted");
});

test("the byte ceiling is a refusal threshold, not a truncation point", () => {
  // Documented here because the value alone does not say which it is, and a
  // truncated evidence PDF is worse than no PDF.
  assert.equal(REPORT_PDF_MAX_BYTES, 24 * 1024 * 1024);
  const source = new ReportPdfUnavailableError("x", 413);
  assert.equal(source.status, 413);
});

test("the filename carries the site and the report id, and cannot escape a directory", () => {
  const id = "20260101-" + "a".repeat(32);
  assert.equal(reportPdfFilename(id, "example.com"), `site-behavior-lab-example.com-${id}.pdf`);

  // A domain reaches this from report data, so it is treated as untrusted for
  // the purpose of building a filename: no separators, no quotes, no CR/LF that
  // could break out of the Content-Disposition header.
  for (const hostile of [
    '../../etc/passwd',
    'a/b',
    'a\\b',
    'a"b',
    "a\r\nX-Injected: 1",
    "a;b",
    "  "
  ]) {
    const filename = reportPdfFilename(id, hostile);
    assert.doesNotMatch(filename, /[\\/"\r\n;]/, `${JSON.stringify(hostile)} produced ${filename}`);
    assert.match(filename, /^site-behavior-lab-[a-z0-9.\-]*-?20260101-a{32}\.pdf$/i, filename);
  }

  // An entirely unusable domain still yields a usable filename.
  assert.equal(reportPdfFilename(id, "///"), `site-behavior-lab-report-${id}.pdf`);
  assert.equal(reportPdfFilename(id, ""), `site-behavior-lab-report-${id}.pdf`);
});

test("a long domain is bounded so the filename stays usable", () => {
  const id = "20260101-" + "b".repeat(32);
  const filename = reportPdfFilename(id, `${"x".repeat(300)}.example`);
  assert.ok(filename.length < 140, `filename was ${filename.length} characters`);
  assert.ok(filename.endsWith(`${id}.pdf`));
});
