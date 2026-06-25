import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareScanResults,
  createComparisonReport,
  createShieldsComparisonReport,
  createTemporalComparisonReport
} from "./compare-reports";
import {
  SCAN_REPORT_SCHEMA_VERSION,
  type CookieRecord,
  type DomainSummary,
  type FingerprintDetectionSummary,
  type NetworkRequestRecord,
  type PixelEventSummary,
  type ScanResult,
  type StorageRecord
} from "./types";

test("compareScanResults reports metric, domain, and entity deltas", () => {
  const before = makeScanResult([
    makeDomain("old.example", 4, "OldCo"),
    makeDomain("shared.example", 2, "SharedCo")
  ]);
  const after = makeScanResult([
    makeDomain("new.example", 3, "NewCo"),
    makeDomain("shared.example", 1, "SharedCo")
  ]);

  const diff = compareScanResults(before, after);

  assert.deepEqual(diff.totalRequests, { before: 6, after: 4, delta: -2 });
  assert.deepEqual(diff.addedDomains.map((domain) => domain.domain), ["new.example"]);
  assert.deepEqual(diff.removedDomains.map((domain) => domain.domain), ["old.example"]);
  assert.deepEqual(diff.addedEntities.map((entity) => entity.entity), ["NewCo"]);
  assert.deepEqual(diff.removedEntities.map((entity) => entity.entity), ["OldCo"]);
});

test("compareScanResults reports PageGraph provenance deltas", () => {
  const before = makeScanResult([makeDomain("tracker.example", 1, "TrackerCo")]);
  before.requests = [makeRequest("tracker.example", "old-script.example")];
  const after = makeScanResult([makeDomain("tracker.example", 1, "TrackerCo")]);
  after.requests = [makeRequest("tracker.example", "new-script.example")];

  const diff = compareScanResults(before, after);

  assert.equal(diff.addedProvenance[0].domain, "tracker.example");
  assert.equal(diff.addedProvenance[0].script, "new-script.example");
  assert.equal(diff.removedProvenance[0].script, "old-script.example");
});

test("compareScanResults reports cookie, storage, and fingerprinting deltas", () => {
  const before = makeScanResult([], {
    cookies: [makeCookie("shared", "example.com", false), makeCookie("old_ad", "ads.example", true)],
    storage: [makeStorage("localStorage", "kept"), makeStorage("sessionStorage", "old_session")],
    fingerprintDetections: [makeCanvasDetection()]
  });
  const after = makeScanResult([], {
    cookies: [makeCookie("shared", "example.com", false), makeCookie("new_ad", "ads.example", true)],
    storage: [makeStorage("localStorage", "kept"), makeStorage("localStorage", "new_key")],
    fingerprintDetections: [makeCanvasDetection(), makeWebglDetection()]
  });

  const diff = compareScanResults(before, after);

  assert.deepEqual(diff.storageEntries, { before: 2, after: 2, delta: 0 });
  assert.deepEqual(
    diff.addedCookies.map((cookie) => cookie.name),
    ["new_ad"]
  );
  assert.deepEqual(
    diff.removedCookies.map((cookie) => cookie.name),
    ["old_ad"]
  );
  assert.deepEqual(diff.addedStorageKeys, [{ area: "localStorage", key: "new_key" }]);
  assert.deepEqual(diff.removedStorageKeys, [{ area: "sessionStorage", key: "old_session" }]);
  assert.deepEqual(
    diff.addedFingerprinting.map((change) => change.kind),
    ["webgl-fingerprinting"]
  );
  assert.deepEqual(diff.removedFingerprinting, []);
});

test("compareScanResults includes a shields-blocked delta only when measured", () => {
  const plain = compareScanResults(makeScanResult([]), makeScanResult([]));
  assert.equal(plain.shieldsBlockedRequests, undefined);

  const before = makeScanResult([], { shieldsBlockedRequests: 0 });
  const after = makeScanResult([], { shieldsBlockedRequests: 7 });
  assert.deepEqual(compareScanResults(before, after).shieldsBlockedRequests, { before: 0, after: 7, delta: 7 });
});

test("compareScanResults surfaces pixel events Shields blocked, only when changed", () => {
  const metaPixel: PixelEventSummary = {
    platform: "Meta",
    product: "Meta Pixel",
    events: ["PageView", "Purchase"],
    advancedMatching: ["email"],
    requests: 2
  };

  // Shields off fires the Meta pixel; Shields on blocks it entirely.
  const off = makeScanResult([], { pixelEvents: [metaPixel] });
  const on = makeScanResult([]);
  const blocked = compareScanResults(off, on);
  assert.equal(blocked.addedPixelEvents, undefined);
  assert.deepEqual(blocked.removedPixelEvents, [
    { platform: "Meta", product: "Meta Pixel", events: ["PageView", "Purchase"], advancedMatching: ["email"] }
  ]);

  // No pixel change across runs leaves both lists absent.
  const stable = compareScanResults(off, makeScanResult([], { pixelEvents: [metaPixel] }));
  assert.equal(stable.addedPixelEvents, undefined);
  assert.equal(stable.removedPixelEvents, undefined);
});

test("createComparisonReport supports non-GPC comparison labels", () => {
  const baseline = makeScanResult([makeDomain("blocked.example", 2, "BlockedCo")]);
  const variant = makeScanResult([]);

  const report = createComparisonReport({
    comparisonType: "shields",
    title: "Shields off/on comparison",
    runLabels: {
      baseline: "Shields off",
      variant: "Shields on"
    },
    baseline,
    variant,
    warningPrefix: "Shields comparison runs are sequential observations."
  });

  assert.equal(report.comparisonType, "shields");
  assert.deepEqual(report.runLabels, { baseline: "Shields off", variant: "Shields on" });
  assert.equal(report.diff.totalRequests.delta, -2);
  assert.equal(report.warnings[0], "Shields comparison runs are sequential observations.");
});

test("comparison helpers create Brave-relevant report types", () => {
  const before = makeScanResult([makeDomain("tracker.example", 2, "TrackerCo")]);
  const after = makeScanResult([]);

  const shields = createShieldsComparisonReport(before, after);
  const temporal = createTemporalComparisonReport(before, after);

  assert.equal(shields.comparisonType, "shields");
  assert.deepEqual(shields.runLabels, { baseline: "Shields off", variant: "Shields on" });
  assert.equal(shields.diff.removedDomains[0].domain, "tracker.example");

  assert.equal(temporal.comparisonType, "temporal");
  assert.deepEqual(temporal.runLabels, { baseline: "Before", variant: "After" });
  assert.equal(temporal.diff.removedEntities[0].entity, "TrackerCo");
});

function makeDomain(domain: string, requests: number, entity: string): DomainSummary {
  return {
    domain,
    requests,
    thirdParty: true,
    tracker: {
      domain,
      entity,
      category: "test",
      confidence: "curated"
    },
    statuses: [200],
    resourceTypes: ["script"]
  };
}

function makeRequest(domain: string, scriptDomain: string): NetworkRequestRecord {
  return {
    id: 1,
    url: `https://${domain}/collect`,
    domain,
    method: "GET",
    resourceType: "script",
    status: 200,
    thirdParty: true,
    tracker: {
      domain,
      entity: "TrackerCo",
      category: "test",
      confidence: "curated"
    },
    provenance: {
      graphRecordId: "edge-1",
      initiatorType: "script",
      scriptDomain,
      scriptUrl: `https://${scriptDomain}/tag.js`
    },
    startedAtMs: 1
  };
}

function makeCookie(name: string, domain: string, thirdParty: boolean): CookieRecord {
  return {
    name,
    domain,
    path: "/",
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: false,
    thirdParty
  };
}

function makeStorage(area: StorageRecord["area"], key: string): StorageRecord {
  return { area, key, valueBytes: 8 };
}

function makeCanvasDetection(): FingerprintDetectionSummary {
  return {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis: ["canvas.toDataURL"],
      maxCanvasWidth: 280,
      maxCanvasHeight: 60,
      maxDistinctTextCharacters: 24,
      maxTextWriteCalls: 3
    }
  };
}

function makeWebglDetection(): FingerprintDetectionSummary {
  return {
    kind: "webgl-fingerprinting",
    heuristic: "webgl-entropy-read-v1",
    count: 1,
    evidence: {
      readApis: [],
      parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
      getParameterCalls: 2,
      readPixelsCalls: 0
    }
  };
}

type ScanResultExtras = {
  requests?: NetworkRequestRecord[];
  cookies?: CookieRecord[];
  storage?: StorageRecord[];
  fingerprintDetections?: FingerprintDetectionSummary[];
  pixelEvents?: PixelEventSummary[];
  shieldsBlockedRequests?: number;
};

function makeScanResult(domains: DomainSummary[], extras: ScanResultExtras = {}): ScanResult {
  const totalRequests = domains.reduce((total, domain) => total + domain.requests, 0);
  const cookies = extras.cookies ?? [];
  const storage = extras.storage ?? [];
  return {
    ok: true,
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportType: "single",
    summary: {
      pageTitle: "",
      status: 200,
      durationMs: 1,
      firstPartyDomain: "example.com",
      totalRequests,
      thirdPartyRequests: totalRequests,
      knownTrackerRequests: totalRequests,
      thirdPartyDomains: domains.length,
      cookies: cookies.length,
      thirdPartyCookies: cookies.filter((cookie) => cookie.thirdParty).length,
      storageEntries: storage.length,
      fingerprintEvents: 0,
      ...(extras.shieldsBlockedRequests === undefined ? {} : { shieldsBlockedRequests: extras.shieldsBlockedRequests })
    },
    conditions: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      scannedAt: new Date(0).toISOString(),
      chromiumVersion: "test",
      userAgent: "test",
      timezone: "UTC",
      locale: "en-US",
      language: "en-US",
      viewport: {
        width: 1440,
        height: 980,
        isMobile: false
      },
      gpcEnabled: false,
      consentMode: "observe",
      automation: "playwright-chromium",
      headless: true,
      scannerEgress: "test",
      trackerCatalog: {
        source: "test",
        version: "test",
        region: "test",
        entries: 0,
        curatedOverrides: 0,
        license: "test"
      },
      scannerDisclosure: "test"
    },
    requests: extras.requests ?? [],
    domains,
    cookies,
    storage,
    fingerprintEvents: [],
    fingerprintDetections: extras.fingerprintDetections ?? [],
    ...(extras.pixelEvents ? { pixelEvents: extras.pixelEvents } : {}),
    screenshot: null,
    warnings: []
  };
}
