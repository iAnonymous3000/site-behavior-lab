import assert from "node:assert/strict";
import { test } from "node:test";
import {
  siteEvidenceValueIsRankable,
  sortSiteEvidenceRows,
  type SiteEvidenceRow
} from "./site-evidence-row";

function row(domain: string, overrides: Partial<SiteEvidenceRow> = {}): SiteEvidenceRow {
  return {
    domain,
    profileHref: `/sites/${domain}`,
    reportHref: `/reports/${domain}`,
    headline: "Observed evidence.",
    tone: "info",
    categoryLabel: "News & media",
    reportCount: 1,
    scannedAt: "2026-08-01T00:00:00.000Z",
    scannedLabel: "August 1, 2026",
    device: "desktop",
    kindLabel: "Single visit",
    thirdPartyRequests: 10,
    trackerRequests: 5,
    thirdPartyCookies: 3,
    requestEvidenceComplete: true,
    cookieEvidenceComplete: true,
    capped: false,
    ...overrides
  };
}

/**
 * The table exists to make sites comparable by number, and this ordering is
 * the whole feature. It lived inline in a `"use client"` component where
 * nothing could reach it, which is why the defect below shipped.
 */
test("a lower-bound request count sorts by the number the cell prints", () => {
  // `requestEvidenceComplete: false` renders "at least N" -- the number is
  // published. Sinking those rows ranked a published value below every zero,
  // so under "highest first" the heaviest site in the corpus appeared last,
  // beneath every site that recorded none.
  const heaviest = row("heavy.example", { trackerRequests: 900, requestEvidenceComplete: false });
  const rows = [row("a.example", { trackerRequests: 0 }), row("b.example", { trackerRequests: 4 }), heaviest];

  const highestFirst = sortSiteEvidenceRows(rows, { key: "trackerRequests", descending: true });
  assert.equal(highestFirst[0].domain, "heavy.example", "a lower bound of 900 outranks 4 and 0");

  const lowestFirst = sortSiteEvidenceRows(rows, { key: "trackerRequests", descending: false });
  assert.equal(lowestFirst.at(-1)?.domain, "heavy.example", "and it stays the top value in either direction");
});

test("a withheld cookie count has nothing to rank and sinks in both directions", () => {
  // This cell renders "Not measured": there is no value to compare, so the row
  // must not be ordered as a zero next to a site that genuinely set none.
  const withheld = row("unknown.example", { thirdPartyCookies: 0, cookieEvidenceComplete: false });
  const rows = [withheld, row("a.example", { thirdPartyCookies: 0 }), row("b.example", { thirdPartyCookies: 7 })];

  for (const descending of [true, false]) {
    const sorted = sortSiteEvidenceRows(rows, { key: "thirdPartyCookies", descending });
    assert.equal(
      sorted.at(-1)?.domain,
      "unknown.example",
      `a withheld count sinks with descending=${descending}`
    );
  }
});

test("rankability is keyed on the column, not on one completeness flag", () => {
  const incompleteRequests = row("x.example", { requestEvidenceComplete: false });
  assert.equal(siteEvidenceValueIsRankable(incompleteRequests, "trackerRequests"), true);
  assert.equal(siteEvidenceValueIsRankable(incompleteRequests, "thirdPartyRequests"), true);
  assert.equal(siteEvidenceValueIsRankable(incompleteRequests, "thirdPartyCookies"), true);

  const incompleteCookies = row("y.example", { cookieEvidenceComplete: false });
  assert.equal(siteEvidenceValueIsRankable(incompleteCookies, "thirdPartyCookies"), false);
  assert.equal(siteEvidenceValueIsRankable(incompleteCookies, "trackerRequests"), true);
});

test("ties break on domain so the order is stable across renders", () => {
  const rows = [row("c.example", { trackerRequests: 5 }), row("a.example", { trackerRequests: 5 })];
  assert.deepEqual(
    sortSiteEvidenceRows(rows, { key: "trackerRequests", descending: true }).map((entry) => entry.domain),
    ["a.example", "c.example"]
  );
});

test("domain and date columns sort by their own values", () => {
  const rows = [
    row("b.example", { scannedAt: "2026-08-01T00:00:00.000Z" }),
    row("a.example", { scannedAt: "2026-08-09T00:00:00.000Z" })
  ];
  assert.deepEqual(
    sortSiteEvidenceRows(rows, { key: "domain", descending: false }).map((entry) => entry.domain),
    ["a.example", "b.example"]
  );
  assert.deepEqual(
    sortSiteEvidenceRows(rows, { key: "scannedAt", descending: true }).map((entry) => entry.domain),
    ["a.example", "b.example"]
  );
});

test("sorting never mutates the caller's array", () => {
  const rows = [row("b.example", { trackerRequests: 1 }), row("a.example", { trackerRequests: 9 })];
  const order = rows.map((entry) => entry.domain);
  sortSiteEvidenceRows(rows, { key: "trackerRequests", descending: true });
  assert.deepEqual(rows.map((entry) => entry.domain), order);
});
