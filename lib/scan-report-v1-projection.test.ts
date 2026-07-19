import assert from "node:assert/strict";
import { test } from "node:test";
import { compareScanResults, createGpcComparisonReport } from "./compare-reports";
import {
  publicWireForExportOrPersistence,
  readScanTransportPayload
} from "./scan-report-view";
import { toPublicScanReportV1 } from "./scan-report-v1-projection";
import { makeScanReportV1 } from "./scan-report-v2-fixtures";
import type { ScanResult } from "./types";

function rawSingle(): ScanResult {
  const report = makeScanReportV1() as ScanResult;
  report.conditions.requestedUrl = "https://example.com/patients/anna?token=secret";
  report.conditions.finalUrl = "https://example.com/account/12345";
  report.requests = [
    {
      id: 1,
      url: "https://a8f3c9d2e1b4f6a7.telemetry.example.net/users/anna?email=x&utm_source=y",
      domain: "a8f3c9d2e1b4f6a7.telemetry.example.net",
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      tracker: null,
      startedAtMs: 1
    }
  ];
  report.domains = [];
  report.cookies = [
    {
      name: "anna_private_cookie",
      domain: ".example.com",
      path: "/patients/anna",
      sameSite: "Lax",
      secure: true,
      httpOnly: true,
      session: true,
      thirdParty: false
    }
  ];
  report.storage = [{ area: "localStorage", key: "anna_private_key", valueBytes: 4 }];
  (report.cookies[0] as unknown as Record<string, unknown>).value = "COOKIE_VALUE_SECRET";
  (report.cookies[0] as unknown as Record<string, unknown>).rawValue = "COOKIE_RAW_VALUE_SECRET";
  (report.storage[0] as unknown as Record<string, unknown>).value = "STORAGE_VALUE_SECRET";
  (report.storage[0] as unknown as Record<string, unknown>).rawValue = "STORAGE_RAW_VALUE_SECRET";
  report.summary = {
    ...report.summary,
    totalRequests: 1,
    thirdPartyRequests: 1,
    knownTrackerRequests: 0,
    thirdPartyDomains: 1,
    cookies: 1,
    thirdPartyCookies: 0,
    storageEntries: 1
  };
  report.screenshot = "data:image/png;base64,PRIVATE";
  (report as unknown as Record<string, unknown>).smuggled = "ROOT_SECRET";
  (report.conditions as unknown as Record<string, unknown>).smuggled = "NESTED_SECRET";
  return report;
}

test("the v1 export projector drops unknowns then sanitizes to a byte-stable fixed point", () => {
  const projected = toPublicScanReportV1(rawSingle()) as ScanResult;
  const json = JSON.stringify(projected);

  assert.equal(json.includes("anna"), false);
  assert.equal(json.includes("SECRET"), false);
  assert.equal(json.includes("PRIVATE"), false);
  assert.equal(projected.conditions.requestedUrl, "https://example.com/{seg}/{seg}");
  assert.equal(projected.requests[0].url, "https://{label}.telemetry.example.net/{seg}/{seg}?%5Bredacted%5D=&utm_source=");
  assert.equal(projected.domains.length, 1);
  assert.equal(projected.summary.thirdPartyDomains, 1);
  assert.equal(projected.cookies[0].name, "[redacted]");
  assert.equal(projected.storage[0].key, "[redacted]");
  assert.equal(projected.screenshot, null);
  assert.equal(JSON.stringify(toPublicScanReportV1(projected)), JSON.stringify(projected));
});

test("comparison exports rederive their diff from sanitized arms", () => {
  const baseline = rawSingle();
  const variant = rawSingle();
  variant.cookies.push({
    name: "bob_private_cookie",
    domain: ".example.com",
    path: "/patients/bob",
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: true,
    thirdParty: false
  });
  variant.summary.cookies = 2;
  const projected = toPublicScanReportV1(createGpcComparisonReport(baseline, variant));
  assert.equal(projected.reportType, "comparison");
  if (projected.reportType !== "comparison") return;

  assert.deepEqual(projected.diff, compareScanResults(projected.baseline, projected.variant));
  assert.equal(JSON.stringify(projected.diff).includes("private_cookie"), false);
});

test("an external v1 upload stays readable but gains no redaction attestation", () => {
  const read = readScanTransportPayload(rawSingle());
  assert.equal(read.kind, "report");
  if (read.kind !== "report") return;
  assert.equal(read.loaded.source, "v1");

  const downloadable = publicWireForExportOrPersistence(read.loaded);
  assert.equal(JSON.stringify(downloadable).includes("anna"), false);
  assert.equal("redactionVersion" in downloadable, false);
});
