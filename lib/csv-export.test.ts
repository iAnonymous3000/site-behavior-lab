import assert from "node:assert/strict";
import { test } from "node:test";
import { csvCell, requestLogToCsv } from "./csv-export";
import type { NetworkRequestRecord } from "./types";

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
  const csv = requestLogToCsv(requests);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines.length, 2);
  // The hostile domain cell is prefixed so it is inert in spreadsheet apps.
  assert.ok(lines[1].includes("'=HYPERLINK(0)"));
  assert.ok(lines[1].endsWith("https://evil.example/=cmd"));
});
