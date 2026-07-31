import assert from "node:assert/strict";
import test from "node:test";
import {
  staticReportCardLabel,
  staticReportRequestCountLabel,
  staticReportRequestEvidenceStatus
} from "./static-report-card-copy";
import type { StaticReportManifestEntry } from "./types";

const COMPLETE_ENTRY: StaticReportManifestEntry = {
  id: `20260721-${"a".repeat(32)}`,
  reportWireBytes: 1024,
  reportWireSha256: "b".repeat(64),
  title: "Example",
  headline: "Example recorded third-party requests",
  tone: "warn",
  domain: "example.test",
  requestedUrl: "https://example.test/",
  scannedAt: "2026-07-21T00:00:00.000Z",
  reportType: "single",
  device: "desktop",
  gpcEnabled: false,
  requestEvidenceComplete: true,
  metrics: {
    totalRequests: 8,
    thirdPartyRequests: 4,
    knownTrackerRequests: 2,
    thirdPartyDomains: 3,
    cookies: 0,
    thirdPartyCookies: 0
  }
};

test("an incomplete non-cap archive row announces retained request counts as lower bounds", () => {
  const incomplete = { ...COMPLETE_ENTRY, requestEvidenceComplete: false };

  assert.equal(
    staticReportRequestCountLabel(incomplete, incomplete.metrics.thirdPartyRequests, "third-party request"),
    "at least 4 third-party requests"
  );
  assert.equal(
    staticReportRequestEvidenceStatus(incomplete),
    "request evidence incomplete; retained request counts are lower bounds"
  );
  assert.equal(
    staticReportCardLabel(incomplete),
    "at least 4 third-party requests, at least 2 catalogued service requests, at least 3 third-party domains, " +
      "request evidence incomplete; retained request counts are lower bounds"
  );
});

test("a capped archive row keeps its specific reason distinct from other incomplete evidence", () => {
  const capped = {
    ...COMPLETE_ENTRY,
    requestCapped: true,
    requestEvidenceComplete: false
  };

  assert.equal(
    staticReportRequestEvidenceStatus(capped),
    "request recording capped; retained request counts are lower bounds"
  );
  assert.doesNotMatch(staticReportCardLabel(capped), /request evidence incomplete/);
});

test("incomplete Shields matched-request counts are also announced as lower bounds", () => {
  const incompleteShields: StaticReportManifestEntry = {
    ...COMPLETE_ENTRY,
    reportType: "comparison",
    comparisonType: "shields",
    gpcEnabled: "comparison",
    requestEvidenceComplete: false,
    metrics: {
      ...COMPLETE_ENTRY.metrics,
      shieldsBlockedRequests: 3
    }
  };

  assert.match(
    staticReportCardLabel(incompleteShields),
    /at least 3 requests matched Brave Shields filter lists/
  );
});
