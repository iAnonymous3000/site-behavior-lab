import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPARISON_REQUEST_CAP } from "./comparison-eligibility";
import { csvCell, requestLogRecordingState, requestLogToCsv } from "./csv-export";
import { viewFromV1Report } from "./scan-report-views";
import { SCAN_REPORT_SCHEMA_VERSION, type NetworkRequestRecord, type ScanResult } from "./types";

test("csvCell quotes separators, quotes, and newlines per RFC 4180", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(200), "200");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\r\nline2"), '"line1\r\nline2"');
});

test("csvCell neutralizes spreadsheet formula injection (CWE-1236)", () => {
  // A scanned site controls its request URLs/domains; a leading =,+,-,@ must not
  // be interpreted as a formula when the CSV is opened in Excel/Sheets.
  assert.equal(csvCell("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1");
  assert.equal(csvCell("+1+2"), "'+1+2");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@SUM(A1:A9)"), "'@SUM(A1:A9)");
  // A formula trigger combined with a separator is both prefixed and quoted.
  assert.equal(csvCell("=1,2"), '"\'=1,2"');
  // Program-generated numbers are exempt: a negative count's "-" is a sign,
  // not page content, and prefixing it would break numeric parsing of the
  // signed delta and Shields-change columns. A page-controlled STRING with a
  // leading "-" (above) is still guarded.
  assert.equal(csvCell(-77), "-77");
  assert.equal(csvCell(-3), "-3");
});

test("csvCell neutralizes a formula that a semicolon or tab reader would start a field with", () => {
  // Excel opens a .csv with the locale's list separator, a semicolon in much of
  // Europe, and a TSV import splits on tabs: "ok;=HYPERLINK(1)" passed through
  // and became a field "=HYPERLINK(1)" for such a reader.
  assert.equal(csvCell("ok;=HYPERLINK(1)"), "ok;'=HYPERLINK(1)");
  assert.equal(csvCell(";=HYPERLINK(1)"), ";'=HYPERLINK(1)");
  assert.equal(csvCell("ok; =1"), "ok; '=1");
  assert.equal(csvCell("a\t-1+2"), "a\t'-1+2");
  assert.equal(csvCell('a;"=1'), '"a;""\'=1"');
  // Ordinary prose and numbers are unchanged.
  assert.equal(csvCell("one; two"), "one; two");
  assert.equal(csvCell(-5), "-5");

  const formulaStart = /^[=+\-@\t\r]/;
  const hostile = ["ok;=1", "x;+cmd", "y;-2", "z;@SUM(A1)", "a; \"=1", "b;'=1", "c\t=1", "d;;=1", "=e;=1"];
  for (const value of hostile) {
    const cell = csvCell(value);
    const unquoted = cell.startsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
    for (const field of unquoted.split(/[;\t]/)) {
      const trimmed = field.replace(/^[\s"]+/, "");
      assert.doesNotMatch(trimmed, formulaStart, `${JSON.stringify(value)} -> ${JSON.stringify(cell)}`);
    }
  }
});

test("requestLogToCsv escapes a hostile domain/url without breaking columns", () => {
  const requests: NetworkRequestRecord[] = [
    {
      id: 1,
      domain: "=HYPERLINK(0)",
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      url: "https://evil.example/=cmd",
      tracker: { domain: "evil.example", entity: "Evil", category: "advertising", confidence: "curated" },
      startedAtMs: 0
    }
  ];
  const csv = requestLogToCsv(requests, "complete");
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  // The hostile domain cell is prefixed so it is inert in spreadsheet apps.
  assert.ok(lines[1].includes("'=HYPERLINK(0)"));
  assert.ok(lines[1].endsWith("https://evil.example/=cmd,complete"));
});

test("requestLogToCsv exports human-readable privacy notation", () => {
  const requests: NetworkRequestRecord[] = [
    {
      id: 1,
      domain: "static.{label}.fbcdn.net",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: true,
      tracker: null,
      url: "https://static.{label}.fbcdn.net/{seg}/{seg}?%5Bredacted%5D=&version=",
      startedAtMs: 0
    }
  ];
  const csv = requestLogToCsv(requests, "complete");
  assert.match(csv, /static\.\*\.fbcdn\.net/);
  assert.match(csv, /https:\/\/static\.\*\.fbcdn\.net\/…\?…&version/);
  assert.equal(csv.includes("{label}"), false);
  assert.equal(csv.includes("{seg}"), false);
  assert.equal(csv.includes("%5Bredacted%5D"), false);
});

function makeV1Result(overrides: { status?: number; totalRequests?: number; warnings?: string[] }): ScanResult {
  const request: NetworkRequestRecord = {
    id: 1,
    domain: "cdn.example",
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty: true,
    tracker: null,
    url: "https://cdn.example/app.js",
    startedAtMs: 0
  };
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: overrides.status ?? 200,
      durationMs: 1,
      firstPartyDomain: "shop.example",
      totalRequests: overrides.totalRequests ?? 1,
      thirdPartyRequests: 1,
      knownTrackerRequests: 0,
      thirdPartyDomains: 1,
      cookies: 0,
      thirdPartyCookies: 0,
      storageEntries: 0,
      fingerprintEvents: 0
    },
    conditions: {
      requestedUrl: "https://shop.example/",
      finalUrl: "https://shop.example/",
      scannedAt: new Date(0).toISOString(),
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: { width: 1440, height: 980, isMobile: false },
      gpcEnabled: false,
      consentMode: "observe",
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: { source: "test", version: "test", region: "test", entries: 0, curatedOverrides: 0, license: "test" },
      scannerDisclosure: "test"
    },
    requests: [request],
    domains: [],
    cookies: [],
    storage: [],
    fingerprintEvents: [],
    screenshot: null,
    warnings: overrides.warnings ?? []
  };
}

test("the request-log CSV carries the recording state on every row, so a capped or failed log is not a complete one", () => {
  // A capped visit downloads as exactly 1,000 rows and a failed visit as a
  // short log; header plus rows carried no marker, so once the file left the
  // page the cap and the failure the report page and JSON-LD disclose were
  // gone. Same precedence as the JSON-LD quality property.
  const complete = viewFromV1Report(makeV1Result({})).runs[0];
  const capped = viewFromV1Report(makeV1Result({ totalRequests: COMPARISON_REQUEST_CAP })).runs[0];
  const failed = viewFromV1Report(makeV1Result({ status: 403 })).runs[0];
  const failedAndCapped = viewFromV1Report(makeV1Result({ status: 403, totalRequests: COMPARISON_REQUEST_CAP })).runs[0];
  assert.equal(requestLogRecordingState(complete), "complete");
  assert.equal(requestLogRecordingState(capped), "capped");
  assert.equal(requestLogRecordingState(failed), "failed");
  assert.equal(requestLogRecordingState(failedAndCapped), "failed");

  const csv = requestLogToCsv(capped.evidence.requests, requestLogRecordingState(capped));
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0].split(",").at(-1), "recording_state");
  for (const line of lines.slice(1)) assert.equal(line.split(",").at(-1), "capped", line);

  const failedCsv = requestLogToCsv(failed.evidence.requests, requestLogRecordingState(failed));
  for (const line of failedCsv.trimEnd().split("\r\n").slice(1)) assert.equal(line.split(",").at(-1), "failed", line);
});
