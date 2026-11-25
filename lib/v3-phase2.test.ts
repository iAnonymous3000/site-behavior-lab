import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { renderReportV3Pdf, renderReportV3PrintHtml } from "./v3/pdf/browser-rendering-pdf";
import {
  resolveBrowserRenderingFromEnv,
  resolveRegionalUpstreamsFromEnv
} from "./v3/runtime/store-context";
import { diffScanReportsV3 } from "./v3/runtime/watch-diff";
import {
  applyRegionalProfileV3,
  dispatchScanV3,
  signWorkerDispatchPayloadV3,
  verifyWorkerDispatchSignatureV3
} from "./v3/runtime/worker-dispatch";
import type { ScanReportV3 } from "./v3/schema";
import {
  assertSafeReportIdV3,
  createFsBlobStoreV3,
  createWorkerR2BlobStoreV3,
  loadReportV3,
  saveReportV3
} from "./v3/storage/blob-store";
import { openNodeSqliteReportIndex } from "./v3/storage/report-index";

function makeReport(overrides: {
  reportId: string;
  canonicalDomain: string;
  scannedAt: string;
  egressRegion?: string;
  thirdPartyDomains?: number;
  trackingRequests?: number;
  darkPatternScore?: number;
  keystrokeLeaks?: number;
  cnameCloaks?: number;
  serverSideTagging?: boolean;
  beaconIdentifiers?: ("email" | "phone" | "name" | "address" | "date_of_birth" | "gender" | "external_id")[];
  fingerprintKinds?: ("canvas" | "webgl" | "mutation-observer-replay")[];
  unmentionedEntities?: string[];
  topEntities?: ScanReportV3["leadArm"]["summary"]["topEntities"];
  topHighlightTitle?: string;
}): ScanReportV3 {
  const domain = overrides.canonicalDomain;
  const thirdPartyDomains = overrides.thirdPartyDomains ?? 8;
  const trackingRequests = overrides.trackingRequests ?? 14;
  const darkPatternScore = overrides.darkPatternScore ?? 10;
  const keystrokeCount = overrides.keystrokeLeaks ?? 0;
  const cnameCount = overrides.cnameCloaks ?? 0;
  const fpKinds = overrides.fingerprintKinds ?? [];
  const sgtm = overrides.serverSideTagging ?? false;
  const topEntities = overrides.topEntities ?? [
    {
      entity: "Google Analytics",
      parentOrg: "Alphabet",
      category: "analytics",
      requests: 6,
      domains: 1
    },
    {
      entity: "Meta Pixel",
      parentOrg: "Meta",
      category: "advertising",
      requests: 4,
      domains: 1
    }
  ];

  return {
    schemaVersion: 3,
    reportId: overrides.reportId,
    scannedAt: overrides.scannedAt,
    targetUrl: `https://${domain}/`,
    finalUrl: `https://${domain}/`,
    canonicalDomain: domain,
    provenance: {
      schemaVersion: 3,
      scannerVersion: "sbl-v3.0.0",
      buildCommit: "test-commit",
      engineVersions: {
        chromium: "159.0.0.0",
        playwright: "1.65.1",
        adblockRust: "0.12.5",
        filterListsDigest: "abc123",
        entityCatalogDigest: "def456"
      },
      egressRegion: overrides.egressRegion ?? "us-east",
      locale: "en-US",
      timezone: "America/New_York",
      acquisition: "live-api"
    },
    leadArm: {
      armId: "baseline",
      label: "Baseline visit",
      conditions: {
        device: "desktop",
        gpcEnabled: false,
        shieldsMode: "off",
        consentMode: "observe",
        scrollCheck: true,
        activeInputProbe: true,
        policyCheck: true
      },
      loadOutcome: "ok",
      httpStatus: 200,
      finalUrl: `https://${domain}/`,
      durationMs: 2500,
      phases: [
        { name: "passive-load", startedAtMs: 0, endedAtMs: 1200, status: "completed" },
        { name: "scroll-interaction", startedAtMs: 1200, endedAtMs: 2000, status: "completed" }
      ],
      probes: {
        network: { status: "complete" },
        websockets: { status: "complete" },
        serviceWorkers: { status: "complete" },
        cookies: { status: "complete" },
        storage: { status: "complete" },
        beacons: { status: "complete" },
        cname: { status: "complete" },
        fingerprinting: { status: "complete" },
        keystrokes: { status: "complete" },
        consent: { status: "complete" },
        policy: { status: "complete" }
      },
      network: [],
      websockets: [],
      serviceWorkers: [],
      cookies: [],
      storage: [],
      beacons: [
        {
          platform: "Google Analytics 4",
          product: "GA4",
          format: "ga4",
          endpointHost: sgtm ? `metrics.${domain}` : "www.google-analytics.com",
          firstPartyEndpoint: sgtm,
          serverSideTagging: sgtm,
          events: ["page_view"],
          scrollDepths: [75],
          consentModeSignals: [],
          identifierCategories: overrides.beaconIdentifiers ?? ["external_id"],
          requests: 3,
          phases: ["passive-load"],
          complete: true
        }
      ],
      cnameCloaks: Array.from({ length: cnameCount }, (_, i) => ({
        host: `t${i}.${domain}`,
        cnameChain: [`t${i}.${domain}`, "collector.criteo.com"],
        targetDomain: "criteo.com",
        entity: {
          entity: "Criteo",
          parentOrg: "Criteo",
          category: "advertising",
          region: "EU",
          confidence: "cname-uncloaked",
          matchedDomain: "criteo.com"
        },
        shieldsMatched: true,
        requestCount: 2
      })),
      fingerprinting: fpKinds.map((kind) => ({
        kind,
        count: 2,
        realms: ["main"],
        apis: [kind],
        scriptDomains: [`cdn.${domain}`],
        evidence: { observed: true }
      })),
      keystrokes: {
        fieldsTyped: 2,
        iframeFieldsTyped: 0,
        shadowDomFieldsTyped: 1,
        fieldTypes: ["email", "text"],
        leaks: Array.from({ length: keystrokeCount }, () => ({
          domain: "collector.replay.example",
          registrableDomain: "replay.example",
          thirdParty: true,
          transport: "http-body",
          encoding: "plain",
          phase: "active-input"
        }))
      },
      consent: {
        mode: "observe",
        banner: {
          detected: true,
          cmp: "OneTrust",
          hasFirstLayerAccept: true,
          hasFirstLayerReject: darkPatternScore < 25,
          hasSettingsEntry: true,
          clicksToAccept: 1,
          clicksToReject: darkPatternScore >= 25 ? 3 : 1,
          darkPatternScore,
          darkPatternFlags: darkPatternScore >= 25 ? ["reject-hidden-in-settings", "prominence-asymmetry"] : []
        },
        interaction: {
          attempted: false,
          clicked: false,
          layer: null
        },
        verification: {
          tcf: { present: false, gdprApplies: null, eventStatus: null, state: "unavailable" },
          gpp: { present: false, applicableSections: [], state: "unavailable" },
          usp: { present: false, optOutSale: null },
          googleConsentMode: [],
          cmpCookies: [],
          consistency: "unavailable"
        }
      },
      policy: {
        url: `https://${domain}/privacy`,
        language: "en",
        textLength: 2400,
        fromIframe: false,
        claims: [{ kind: "honors-gpc", quote: "We honor Global Privacy Control signals." }],
        mentionedEntities: ["Google Analytics"],
        unmentionedEntities: overrides.unmentionedEntities ?? []
      },
      summary: {
        totalRequests: 24,
        thirdPartyRequests: 14,
        thirdPartyDomains,
        trackingRequests,
        shieldsMatchedRequests: 12,
        shieldsBlockedStandard: 9,
        shieldsBlockedAggressive: 12,
        distinctEntities: topEntities.length,
        distinctParentOrgs: new Set(topEntities.map((e) => e.parentOrg)).size,
        cookiesTotal: 6,
        thirdPartyCookies: 2,
        longLivedCookies: 3,
        partitionedCookies: 1,
        storageKeysTotal: 5,
        websocketsTotal: 0,
        serviceWorkersTotal: 0,
        beaconPlatforms: 1,
        serverSideTaggingEndpoints: sgtm ? 1 : 0,
        cnameCloaksCount: cnameCount,
        fingerprintKindsCount: fpKinds.length,
        keystrokeLeaksCount: keystrokeCount,
        darkPatternScore,
        topEntities
      }
    },
    comparisonArms: [],
    comparisons: [],
    highlights: [
      {
        id: "hl-1",
        severity: keystrokeCount > 0 ? "critical" : "medium",
        category: keystrokeCount > 0 ? "keystrokes" : "third-parties",
        title: overrides.topHighlightTitle ?? `${domain} contacted ${thirdPartyDomains} third-party domains`,
        detail: "Observed during controlled visit."
      }
    ]
  };
}

test("D1ReportIndexStoreV3 supports indexing, faceted search, site history, reverse vendor lookup, stats & expiry", async () => {
  const { store, close } = await openNodeSqliteReportIndex(":memory:");
  try {
    const rAlphaOld = makeReport({
      reportId: "20261120-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      canonicalDomain: "alpha.example",
      scannedAt: "2026-11-20T10:00:00.000Z",
      thirdPartyDomains: 5,
      darkPatternScore: 10
    });
    const rAlphaNew = makeReport({
      reportId: "20261125-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canonicalDomain: "alpha.example",
      scannedAt: "2026-11-25T10:00:00.000Z",
      egressRegion: "eu-central",
      thirdPartyDomains: 18,
      darkPatternScore: 55,
      keystrokeLeaks: 2,
      cnameCloaks: 1,
      serverSideTagging: true,
      fingerprintKinds: ["canvas", "mutation-observer-replay"]
    });
    const rBeta = makeReport({
      reportId: "20261125-cccccccccccccccccccccccccccccccc",
      canonicalDomain: "beta.example",
      scannedAt: "2026-11-25T11:00:00.000Z",
      egressRegion: "us-east",
      thirdPartyDomains: 3,
      darkPatternScore: 0,
      topEntities: [
        {
          entity: "Google Analytics",
          parentOrg: "Alphabet",
          category: "analytics",
          requests: 2,
          domains: 1
        }
      ]
    });
    const rExpired = makeReport({
      reportId: "20261101-dddddddddddddddddddddddddddddddd",
      canonicalDomain: "expired.example",
      scannedAt: "2026-11-01T10:00:00.000Z",
      thirdPartyDomains: 1
    });

    await store.indexReport(rAlphaOld, { r2Key: "v3/reports/alpha-old.json", visibility: "corpus" });
    await store.indexReport(rAlphaNew, { r2Key: "v3/reports/alpha-new.json", visibility: "corpus" });
    await store.indexReport(rBeta, { r2Key: "v3/reports/beta.json", visibility: "public" });
    await store.indexReport(rExpired, {
      r2Key: "v3/reports/expired.json",
      visibility: "public",
      expiresAt: "2026-11-10T00:00:00.000Z"
    });

    // Latest-per-site deduplicates alpha.example (2 reports -> 1 latest)
    const allLatest = await store.queryCorpus({ latestPerSite: true });
    assert.equal(allLatest.total, 3);
    assert.equal(allLatest.items.find((i) => i.canonicalDomain === "alpha.example")?.reportId, rAlphaNew.reportId);

    // All-history returns both alpha reports
    const allHistory = await store.queryCorpus({ latestPerSite: false, query: "https://www.alpha.example" });
    assert.equal(allHistory.total, 2);

    // Faceted behavioral filters
    const filtered = await store.queryCorpus({
      region: "eu-central",
      hasKeystrokeLeaks: true,
      hasCnameCloaks: true,
      hasServerSideTagging: true,
      hasFingerprinting: true,
      minDarkPatternScore: 40,
      parentOrg: "Meta"
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.items[0].canonicalDomain, "alpha.example");

    // Site history ordering (newest first)
    const history = await store.getSiteHistory("alpha.example");
    assert.equal(history.length, 2);
    assert.equal(history[0].reportId, rAlphaNew.reportId);
    assert.equal(history[1].reportId, rAlphaOld.reportId);

    // Reverse vendor lookup by entity & parent org
    const gaFootprint = await store.getEntityFootprint("Google Analytics");
    assert.equal(gaFootprint.corpusSites, 3);
    assert.equal(gaFootprint.totalSites, 3);
    assert.equal(gaFootprint.prevalencePct, 100);

    const metaFootprint = await store.getEntityFootprint("Meta");
    assert.equal(metaFootprint.totalSites, 2); // alpha.example + expired.example

    // Aggregate corpus stats
    const stats = await store.getCorpusOverviewStats();
    assert.equal(stats.totalReports, 4);
    assert.equal(stats.distinctSites, 3);
    assert.equal(stats.medianThirdPartyDomains, 3); // [1, 3, 18]
    assert.equal(stats.sitesWithKeystrokeLeaks, 1);
    assert.equal(stats.sitesWithCnameCloaks, 1);
    assert.equal(stats.sitesWithServerSideTagging, 1);
    assert.equal(stats.sitesWithFingerprinting, 1);
    assert.equal(stats.sitesWithDarkPatterns, 1);
    assert.equal(stats.topParentOrgs[0].parentOrg, "Alphabet");

    // Expiry cleanup
    const removed = await store.deleteExpiredRows("2026-11-25T12:00:00.000Z");
    assert.equal(removed, 1);
    assert.equal(await store.getReportMeta(rExpired.reportId), null);
    assert.equal((await store.getCorpusOverviewStats()).distinctSites, 2);
  } finally {
    close();
  }
});

test("BlobStoreV3 (FS + Worker R2) enforces ID safety, path traversal protection, and round-trips", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-v3-blob-"));
  try {
    const fsStore = createFsBlobStoreV3(dir);
    const report = makeReport({
      reportId: "20261125-0123456789abcdef0123456789abcdef",
      canonicalDomain: "shop.example",
      scannedAt: "2026-11-25T12:00:00.000Z"
    });

    const key = await saveReportV3(fsStore, report);
    assert.equal(key, `v3/reports/${report.reportId}.json`);
    const loaded = await loadReportV3(fsStore, report.reportId);
    assert.ok(loaded);
    assert.equal(loaded.reportId, report.reportId);
    assert.equal(loaded.canonicalDomain, "shop.example");

    assert.throws(() => assertSafeReportIdV3("../etc/passwd"), /Invalid v3 report ID/);
    await assert.rejects(() => fsStore.putJson("../../escape.json", "{}"), /path traversal/);

    // Worker R2 binding adapter
    const mem = new Map<string, string | Uint8Array>();
    const r2Store = createWorkerR2BlobStoreV3({
      async put(k, val) {
        mem.set(k, val instanceof ArrayBuffer ? new Uint8Array(val) : val);
      },
      async get(k) {
        const v = mem.get(k);
        if (v === undefined) return null;
        return {
          async text() {
            return typeof v === "string" ? v : Buffer.from(v).toString("utf8");
          },
          async arrayBuffer() {
            const buf = typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          }
        };
      },
      async delete(k) {
        mem.delete(k);
      }
    });

    await saveReportV3(r2Store, report);
    const fromR2 = await loadReportV3(r2Store, report.reportId);
    assert.equal(fromR2?.reportId, report.reportId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderReportV3PrintHtml escapes XSS and renderReportV3Pdf offloads + caches in R2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-v3-pdf-"));
  try {
    const cacheStore = createFsBlobStoreV3(dir);
    const report = makeReport({
      reportId: "20261125-fedcba9876543210fedcba9876543210",
      canonicalDomain: "xss.example",
      scannedAt: "2026-11-25T12:00:00.000Z",
      topHighlightTitle: `<script>alert("xss")</script>`
    });

    const html = renderReportV3PrintHtml(report);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
    assert.match(html, /Canonical SHA-256: [a-f0-9]{64}/);

    let fetchCalls = 0;
    const fakePdf = new Uint8Array(Buffer.from("%PDF-1.7\n%mock\n"));
    const mockFetch: typeof fetch = async (input, init) => {
      fetchCalls += 1;
      assert.match(String(input), /\/accounts\/acct-123\/browser-rendering\/pdf$/);
      assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer tok-secret");
      return new Response(fakePdf, { status: 200, headers: { "content-type": "application/pdf" } });
    };

    const first = await renderReportV3Pdf(report, {
      cacheStore,
      cloudflareBrowserRendering: { accountId: "acct-123", apiToken: "tok-secret" },
      fetchImpl: mockFetch
    });
    assert.equal(first.source, "cloudflare-browser-rendering");
    assert.equal(fetchCalls, 1);
    assert.deepEqual(first.pdf, fakePdf);

    // Second render hits R2 cache with zero upstream calls
    const second = await renderReportV3Pdf(report, {
      cacheStore,
      cloudflareBrowserRendering: { accountId: "acct-123", apiToken: "tok-secret" },
      fetchImpl: mockFetch
    });
    assert.equal(second.source, "r2-cache");
    assert.equal(fetchCalls, 1);
    assert.deepEqual(second.pdf, fakePdf);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatchScanV3 supports pure-Cloudflare default + HMAC-signed regional worker upstreams", async () => {
  const sampleReport = makeReport({
    reportId: "20261125-11112222333344445555666677778888",
    canonicalDomain: "eu-site.example",
    scannedAt: "2026-11-25T12:00:00.000Z",
    egressRegion: "eu-central"
  });

  // Regional profile enrichment
  const euReq = applyRegionalProfileV3({ url: "https://eu-site.example/" }, "eu-central");
  assert.equal(euReq.egressRegion, "eu-central");
  assert.equal(euReq.locale, "de-DE");
  assert.equal(euReq.timezone, "Europe/Berlin");

  // Default path when no upstream matches
  const defaultRes = await dispatchScanV3(
    { url: "https://eu-site.example/" },
    {
      region: "eu-central",
      upstreams: [],
      defaultExecutor: async (req) => {
        assert.equal(req.locale, "de-DE");
        return sampleReport;
      }
    }
  );
  assert.equal(defaultRes.backend, "cloudflare-default");

  // Regional signed upstream dispatch
  const secret = "super-secret-regional-dispatch-key-32b";
  const nowMs = 1_764_100_000_000;
  let capturedSig = "";
  let capturedTs = "";
  let capturedBody = "";

  const regionalRes = await dispatchScanV3(
    { url: "https://eu-site.example/" },
    {
      region: "eu-central",
      upstreams: [{ region: "eu-central", endpointUrl: "https://eu.worker.example", hmacSecret: secret }],
      defaultExecutor: async () => {
        throw new Error("Should not call default executor");
      },
      nowMs: () => nowMs,
      fetchImpl: async (input, init) => {
        assert.equal(String(input), "https://eu.worker.example/internal/v3/scan");
        const headers = init?.headers as Record<string, string>;
        capturedSig = headers["x-sbl-dispatch-sig"];
        capturedTs = headers["x-sbl-dispatch-ts"];
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify(sampleReport), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
  );
  assert.equal(regionalRes.backend, "regional-http-worker");

  // Signature verification: valid, tampered, expired
  assert.equal(
    verifyWorkerDispatchSignatureV3({
      secret,
      timestampSec: capturedTs,
      signatureHex: capturedSig,
      body: capturedBody,
      nowMs
    }),
    true
  );
  assert.equal(
    verifyWorkerDispatchSignatureV3({
      secret,
      timestampSec: capturedTs,
      signatureHex: capturedSig,
      body: `${capturedBody} `,
      nowMs
    }),
    false
  );
  assert.equal(
    verifyWorkerDispatchSignatureV3({
      secret,
      timestampSec: capturedTs,
      signatureHex: signWorkerDispatchPayloadV3(secret, capturedTs, capturedBody),
      body: capturedBody,
      nowMs: nowMs + 120_000
    }),
    false
  );

  // Env parsers
  const parsedUpstreams = resolveRegionalUpstreamsFromEnv({
    SITE_BEHAVIOR_LAB_REGIONAL_WORKERS_JSON: JSON.stringify([
      { region: "eu-central", endpointUrl: "https://eu.example", hmacSecret: secret },
      { region: "invalid", endpointUrl: "https://bad.example", hmacSecret: secret }
    ])
  });
  assert.equal(parsedUpstreams.length, 1);
  assert.equal(parsedUpstreams[0].region, "eu-central");
  assert.deepEqual(
    resolveBrowserRenderingFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a1", CLOUDFLARE_API_TOKEN: "t1" }),
    { accountId: "a1", apiToken: "t1", endpointBase: undefined }
  );
});

test("diffScanReportsV3 identifies regressions and improvements accurately", () => {
  const prev = makeReport({
    reportId: "20261120-00000000000000000000000000000001",
    canonicalDomain: "news.example",
    scannedAt: "2026-11-20T00:00:00.000Z",
    thirdPartyDomains: 10,
    darkPatternScore: 15,
    keystrokeLeaks: 0,
    cnameCloaks: 0,
    serverSideTagging: false,
    beaconIdentifiers: ["external_id"],
    fingerprintKinds: [],
    unmentionedEntities: []
  });

  const regressed = makeReport({
    reportId: "20261125-00000000000000000000000000000002",
    canonicalDomain: "news.example",
    scannedAt: "2026-11-25T00:00:00.000Z",
    thirdPartyDomains: 17,
    darkPatternScore: 45,
    keystrokeLeaks: 1,
    cnameCloaks: 1,
    serverSideTagging: true,
    beaconIdentifiers: ["external_id", "email"],
    fingerprintKinds: ["canvas", "mutation-observer-replay"],
    unmentionedEntities: ["Criteo"],
    topEntities: [
      { entity: "Google Analytics", parentOrg: "Alphabet", category: "analytics", requests: 6, domains: 1 },
      { entity: "Meta Pixel", parentOrg: "Meta", category: "advertising", requests: 4, domains: 1 },
      { entity: "Criteo", parentOrg: "Criteo", category: "advertising", requests: 3, domains: 1 }
    ]
  });

  const diff = diffScanReportsV3(prev, regressed);
  const kinds = new Set(diff.regressions.map((r) => r.kind));
  assert.ok(kinds.has("new-keystroke-leak"));
  assert.ok(kinds.has("new-cname-cloak"));
  assert.ok(kinds.has("new-server-side-tagging"));
  assert.ok(kinds.has("new-beacon-identifiers"));
  assert.ok(kinds.has("new-fingerprint-signal"));
  assert.ok(kinds.has("dark-pattern-regression"));
  assert.ok(kinds.has("third-party-domain-spike"));
  assert.ok(kinds.has("policy-disclosure-regression"));
  assert.equal(diff.regressions.find((r) => r.kind === "new-keystroke-leak")?.severity, "critical");
  assert.deepEqual(diff.entitiesAdded, ["Criteo"]);
  assert.equal(diff.metrics.thirdPartyDomainsDelta, 7);

  // Reverse diff detects improvements
  const improved = diffScanReportsV3(regressed, prev);
  assert.equal(improved.regressions.length, 0);
  assert.ok(improved.improvements.some((s) => /Keystroke leaks dropped/i.test(s)));
  assert.ok(improved.improvements.some((s) => /Removed fingerprinting signals/i.test(s)));
  assert.ok(improved.improvements.some((s) => /dark-pattern score improved/i.test(s)));
  assert.ok(improved.improvements.some((s) => /Third-party domains reduced/i.test(s)));
});
