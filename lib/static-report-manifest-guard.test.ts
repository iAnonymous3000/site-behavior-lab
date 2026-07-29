import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_STATIC_REPORT_MANIFEST_ENTRIES,
  isStaticReportManifest
} from "./static-report-manifest-guard";

const ENTRY = {
  id: `20260721-${"a".repeat(32)}`,
  reportWireBytes: 1024,
  reportWireSha256: "b".repeat(64),
  title: "Example",
  headline: "Example recorded no third-party requests",
  tone: "calm",
  domain: "example.test",
  requestedUrl: "https://example.test/",
  scannedAt: "2026-07-21T00:00:00.000Z",
  reportType: "single",
  device: "desktop",
  gpcEnabled: false,
  metrics: {
    totalRequests: 1,
    thirdPartyRequests: 0,
    knownTrackerRequests: 0,
    thirdPartyDomains: 0,
    cookies: 0,
    thirdPartyCookies: 0,
    fingerprintEvents: 0
  }
} as const;

test("the static manifest guard accepts one complete bounded entry", () => {
  assert.equal(isStaticReportManifest({
    generatedAt: "2026-07-21T00:00:00.000Z",
    reports: [ENTRY]
  }), true);
});

test("renderer-required metrics are mandatory while detector-incomplete fingerprint counts may be omitted", () => {
  for (const metric of Object.keys(ENTRY.metrics).filter((metric) => metric !== "fingerprintEvents")) {
    const metrics = { ...ENTRY.metrics } as Record<string, unknown>;
    delete metrics[metric];
    assert.equal(isStaticReportManifest({
      generatedAt: "2026-07-21T00:00:00.000Z",
      reports: [{ ...ENTRY, metrics }]
    }), false, `accepted missing ${metric}`);
  }

  assert.equal(isStaticReportManifest({
    generatedAt: "2026-07-21T00:00:00.000Z",
    reports: [{ ...ENTRY, metrics: { ...ENTRY.metrics, knownTrackerRequests: Number.NaN } }]
  }), false);
  const withoutFingerprint = { ...ENTRY.metrics } as Record<string, unknown>;
  delete withoutFingerprint.fingerprintEvents;
  assert.equal(isStaticReportManifest({
    generatedAt: "2026-07-21T00:00:00.000Z",
    reports: [{ ...ENTRY, metrics: withoutFingerprint }]
  }), true);
  assert.equal(isStaticReportManifest({
    generatedAt: "2026-07-21T00:00:00.000Z",
    reports: [{ ...ENTRY, metrics: { ...ENTRY.metrics, fingerprintEvents: Number.NaN } }]
  }), false);
});

test("the manifest guard rejects duplicate ids, unknown fields and oversized collections", () => {
  const generatedAt = "2026-07-21T00:00:00.000Z";
  assert.equal(isStaticReportManifest({ generatedAt, reports: [ENTRY, ENTRY] }), false);
  assert.equal(isStaticReportManifest({ generatedAt, reports: [{ ...ENTRY, unexpected: true }] }), false);
  assert.equal(isStaticReportManifest({
    generatedAt,
    reports: Array.from({ length: MAX_STATIC_REPORT_MANIFEST_ENTRIES + 1 }, () => ENTRY)
  }), false);
});

test("the manifest guard requires an exact positive byte length and lowercase SHA-256", () => {
  const generatedAt = "2026-07-21T00:00:00.000Z";
  assert.equal(isStaticReportManifest({ generatedAt, reports: [{ ...ENTRY, reportWireBytes: 0 }] }), false);
  assert.equal(isStaticReportManifest({ generatedAt, reports: [{ ...ENTRY, reportWireSha256: "B".repeat(64) }] }), false);
  const missingDigest = { ...ENTRY } as Record<string, unknown>;
  delete missingDigest.reportWireSha256;
  assert.equal(isStaticReportManifest({ generatedAt, reports: [missingDigest] }), false);
});
