import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inventoryStoredReport,
  inventoryV1Report,
  policyQuoteIdentifierCount,
  policyQuoteIdentifiersInR2Report,
  summarizeInventories
} from "./remediation-inventory";
import {
  makePublicSingleReportV2R2,
  makeShieldsInterventionReportV2R2
} from "./scan-report-v2-r2-fixtures";
import { makePublicSingleReportV2, makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanReport, ScanResult } from "./types";

function reportWithSensitiveArtifacts(): ScanReport {
  const report = makeScanReportV1() as ScanResult;
  report.conditions = {
    ...report.conditions,
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/patients/anna-schmidt/records"
  };
  report.requests = [
    {
      id: 1,
      url: "https://a8f3c9d2e1b4f6a7.t.example.net/collect?email=anna%40example.com&utm_source=x",
      domain: "a8f3c9d2e1b4f6a7.t.example.net",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: true,
      tracker: null,
      startedAtMs: 10
    },
    {
      id: 2,
      url: "https://example.com/privacy",
      domain: "example.com",
      method: "GET",
      resourceType: "document",
      status: 200,
      thirdParty: false,
      tracker: null,
      startedAtMs: 12
    }
  ];
  report.cookies = [
    { name: "_ga", domain: ".example.com", path: "/", sameSite: "Lax", secure: true, httpOnly: false, session: false, thirdParty: false },
    { name: "8f14e45fceea167a5a36dedd4bea2543", domain: ".t.example.net", path: "/", sameSite: "None", secure: true, httpOnly: false, session: false, thirdParty: true }
  ];
  report.storage = [
    { area: "localStorage", key: "theme", valueBytes: 4 },
    { area: "localStorage", key: "uid_123e4567-e89b-12d3-a456-426614174000", valueBytes: 36 }
  ];
  return report;
}

test("the dry-run inventory quantifies what the sanitizer would change, without mutating anything", () => {
  const report = reportWithSensitiveArtifacts();
  const frozen = JSON.stringify(report);
  const inventory = inventoryV1Report("20260711-" + "a".repeat(32), report);

  // Nothing mutated: this is an audit, not a rewrite.
  assert.equal(JSON.stringify(report), frozen);

  // The name-bearing final URL and the token-subdomain tracker URL change; the
  // allowlisted privacy route survives untouched.
  assert.equal(inventory.totalUrlFields, 4);
  assert.equal(inventory.changedUrlFields, 2);
  assert.equal(inventory.counters.subdomainLabelsGeneralized > 0, true);
  assert.equal(inventory.counters.pathSegmentsGeneralized > 0, true);
  // email=... is not on the query allowlist; utm_source is.
  assert.equal(inventory.counters.queryKeysRedacted, 1);

  // Names: one cookie and one storage key would redact.
  assert.deepEqual(inventory.cookieNames, { total: 2, wouldRedact: 1 });
  assert.deepEqual(inventory.storageKeys, { total: 2, wouldRedact: 1 });

  // Risk signals for the RFC 9.6 step-2 history decision: the stored query
  // carried an email-like string; the tracker host has two non-allowlisted labels.
  assert.equal(inventory.riskSignals.emailLikeStrings, 1);
  assert.equal(inventory.riskSignals.unallowlistedSubdomainLabels, 2);

  // Image-density "@" suffixes are not addresses and must not inflate the
  // audit signal (the corpus's dominant false positive: logo@2x.png).
  const density = reportWithSensitiveArtifacts() as ScanResult;
  density.requests = [
    {
      id: 1,
      url: "https://cdn.example.com/assets/logo%402x.png",
      domain: "cdn.example.com",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: true,
      tracker: null,
      startedAtMs: 5
    }
  ];
  density.conditions = { ...density.conditions, finalUrl: "https://example.com/" };
  density.cookies = [];
  density.storage = [];
  const densityInventory = inventoryV1Report("20260711-" + "c".repeat(32), density);
  assert.equal(densityInventory.riskSignals.emailLikeStrings, 0);

  // Examples carry the exact before/after for operator review.
  assert.equal(inventory.examples.length, 2);
  assert.equal(inventory.examples.some((example) => example.after.includes("{label}")), true);
});

test("summarizeInventories aggregates and counts changed reports once", () => {
  const report = reportWithSensitiveArtifacts();
  const clean = makeScanReportV1();
  const entries = [
    inventoryV1Report("20260711-" + "a".repeat(32), report),
    inventoryV1Report("20260711-" + "b".repeat(32), clean)
  ];
  const totals = summarizeInventories(entries);
  assert.equal(totals.reports, 2);
  assert.equal(totals.reportsWithUrlOrNameChanges >= 1, true);
  assert.equal(totals.totalUrlFields, entries[0].totalUrlFields + entries[1].totalUrlFields);
  assert.equal(totals.riskSignals.emailLikeStrings, 1);
});

test("the sweep reaches the privacy-policy quote, the one field that keeps page text", () => {
  // Every other risk signal comes from a URL or a name the sanitizer rewrites.
  // A policy quote is admitted page-derived text that passes through with only
  // whitespace normalization and a length cap, so the corpus-clean statement
  // was being made on a sweep that could not see the only field at risk.
  const report = makeScanReportV1() as ScanResult;
  report.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [
      {
        kind: "no-selling-or-sharing",
        quote:
          "We do not sell or share your personal information; write to contact@example.com to object."
      },
      { kind: "no-cookies", quote: "We do not use cookies on this website." }
    ],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 120
  };

  const inventory = inventoryV1Report("policy-quote", report);

  assert.equal(inventory.riskSignals.policyQuoteIdentifiers, 1);
  assert.equal(
    inventory.riskSignals.emailLikeStrings,
    0,
    "the URL-derived signal must stay a URL-derived signal"
  );
});

test("an ordinary policy quote raises no identifier signal", () => {
  const report = makeScanReportV1() as ScanResult;
  report.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [
      // Bare figures must not register, or every policy would be flagged.
      { kind: "honors-gpc", quote: "We honor Global Privacy Control signals and retain logs for 30 days." }
    ],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 80
  };

  assert.equal(inventoryV1Report("clean-quote", report).riskSignals.policyQuoteIdentifiers, 0);
});

test("the identifier matcher counts addresses and numbers, not ordinary figures", () => {
  assert.equal(policyQuoteIdentifierCount(undefined), 0);
  assert.equal(
    policyQuoteIdentifierCount([
      { quote: "Call us on +1 (415) 555-0132." },
      { quote: "Reach the DPO at dpo@example.org." },
      { quote: "We retain logs for 30 days." }
    ]),
    2
  );
});

test("an r2 single report's policy quote is swept, the shape that actually leaked", () => {
  // The v1 inventory is unreachable for schema-r2 rows: the CLI handles them on
  // its own branch and returns first. Every report the scanner writes today is
  // r2, and the report that leaked an address in the 1,320-site audit was an r2
  // SINGLE report, so this traversal is the one that matters. Exercising only
  // the string matcher would leave that path unverified, which is how the gap
  // arose in the first place.
  const report = makePublicSingleReportV2R2();
  assert.equal(policyQuoteIdentifiersInR2Report(report), 0, "the fixture must start clean");

  report.run.evidence.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [
      {
        kind: "no-selling-or-sharing",
        quote: "Copyright 2007-2026 Example Bench contact@example.com Privacy Policy Licensing"
      }
    ],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 90
  };

  assert.equal(policyQuoteIdentifiersInR2Report(report), 1);
});

test("an r2 comparison is swept on both arms, not just the one the reader sees", () => {
  const report = makeShieldsInterventionReportV2R2();
  assert.equal(policyQuoteIdentifiersInR2Report(report), 0, "the fixture must start clean");

  for (const run of [report.baseline, report.variant]) {
    run.evidence.privacyPolicy = {
      url: "https://example.com/privacy",
      claims: [{ kind: "honors-gpc", quote: "Write to dpo@example.com to exercise your rights." }],
      mentionedEntities: [],
      unmentionedEntities: [],
      policyTextLength: 60
    };
  }

  assert.equal(
    policyQuoteIdentifiersInR2Report(report),
    2,
    "a quote on the variant arm alone must not be able to hide"
  );
});

test("routing a stored report to its inventory sweeps r2 quotes, v1 entries, and skips the rest", () => {
  // The original defect was a schema that never reached its sweep. Asserting
  // that from the CLI's source could not tell a call that runs from one
  // stranded after the branch's `continue`, so the routing is a pure function
  // and the test just asks it for the answer.
  const r2Report = makePublicSingleReportV2R2();
  r2Report.run.evidence.privacyPolicy = {
    url: "https://example.com/privacy",
    claims: [{ kind: "no-cookies", quote: "Questions? contact@example.com" }],
    mentionedEntities: [],
    unmentionedEntities: [],
    policyTextLength: 40
  };

  const routedR2 = inventoryStoredReport("r2-row", {
    schemaVersion: 2,
    schemaRevision: 2,
    report: r2Report
  });
  assert.equal(routedR2.schema, "r2");
  assert.equal(
    routedR2.schema === "r2" ? routedR2.policyQuoteIdentifiers : -1,
    1,
    "an r2 row must reach the quote sweep, which is the format the scanner writes today"
  );

  const routedV1 = inventoryStoredReport("v1-row", {
    schemaVersion: 1,
    report: makeScanReportV1()
  });
  assert.equal(routedV1.schema, "v1");

  // Revision 1 has no reviewed migration, so it is reported as unsupported
  // rather than silently inventoried under the wrong assumptions.
  const routedOld = inventoryStoredReport("r1-row", {
    schemaVersion: 2,
    schemaRevision: 1,
    report: makePublicSingleReportV2()
  });
  assert.deepEqual(routedOld, { schema: "unsupported", schemaVersion: 2, schemaRevision: 1 });
});
