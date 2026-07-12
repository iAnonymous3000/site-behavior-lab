import assert from "node:assert/strict";
import { test } from "node:test";
import { inventoryV1Report, summarizeInventories } from "./remediation-inventory";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
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
