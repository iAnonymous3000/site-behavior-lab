import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatReportMarkdownV3, verifyReportV3Json } from "./v3/cli/formatters";
import {
  buildVendorFootprintFromSnapshotV3,
  filterStaticCorpusSnapshotV3,
  type StaticCorpusSnapshotV3
} from "./v3/corpus-snapshot-client";
import { renderReportV3Pdf, renderReportV3PrintHtml } from "./v3/pdf/browser-rendering-pdf";
import {
  getV3RuntimeContext,
  hydrateV3SeedCorpus,
  resetV3RuntimeContextForTests,
  resolveBrowserRenderingFromEnv,
  resolveD1HttpConfigFromEnv,
  resolveRegionalUpstreamsFromEnv,
  resolveV3SeedDir
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
  createLayeredBlobStoreV3,
  createReadOnlySeedBlobStoreV3,
  createS3R2BlobStoreV3,
  createWorkerR2BlobStoreV3,
  loadReportV3,
  pdfBlobKeyV3,
  reportBlobKeyV3,
  saveReportV3
} from "./v3/storage/blob-store";
import {
  createCloudflareD1HttpExecutorV3,
  openCloudflareD1HttpReportIndex,
  openNodeSqliteReportIndex
} from "./v3/storage/report-index";

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

  // Regional profile enrichment sets locale & timezone without fabricating
  // physical egress unless verifiedEgress is true.
  const euReq = applyRegionalProfileV3({ url: "https://eu-site.example/" }, "eu-central");
  assert.equal(euReq.egressRegion, undefined);
  assert.equal(euReq.locale, "de-DE");
  assert.equal(euReq.timezone, "Europe/Berlin");
  assert.equal(applyRegionalProfileV3({ url: "https://eu-site.example/" }, "eu-central", { verifiedEgress: true }).egressRegion, "eu-central");

  // Default path when no upstream matches must NOT forge egressRegion
  const defaultRes = await dispatchScanV3(
    { url: "https://eu-site.example/" },
    {
      region: "eu-central",
      upstreams: [],
      defaultExecutor: async (req) => {
        assert.equal(req.locale, "de-DE");
        assert.equal(req.egressRegion, undefined);
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

test("createCloudflareD1HttpExecutorV3 sends parameterized queries without BEGIN and sanitizes errors", async () => {
  const seenCalls: Array<{ url: string; auth: string | null; sql: string; params?: unknown[] }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as { sql: string; params?: unknown[] };
    seenCalls.push({ url, auth: headers.get("authorization"), sql: body.sql, params: body.params });

    if (body.sql.includes("FAIL_ME")) {
      return new Response(
        JSON.stringify({ success: false, errors: [{ code: 7500, message: "syntax error near FAIL_ME" }] }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }
    if (body.sql.startsWith("SELECT report_id FROM reports")) {
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ success: true, results: [{ report_id: "20261125-00000000000000000000000000000001" }] }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ success: true, result: [{ success: true, results: [], meta: { changes: 1 } }] }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  const secretToken = "cf-d1-test-token-do-not-leak-9999";
  const { store } = await openCloudflareD1HttpReportIndex({
    accountId: "acct-123",
    databaseId: "db-456",
    apiToken: secretToken,
    endpointBase: "https://api.cloudflare.test/client/v4",
    fetchImpl: fakeFetch
  });

  const sample = makeReport({
    reportId: "20261125-00000000000000000000000000000001",
    canonicalDomain: "d1-example.org",
    scannedAt: "2026-11-25T10:00:00.000Z",
    topEntities: Array.from({ length: 25 }, (_, i) => ({
      entity: `Entity-${i}`,
      parentOrg: `Org-${i}`,
      category: "analytics" as const,
      requests: i + 1,
      domains: 1
    }))
  });
  const callsBeforeIndex = seenCalls.length;
  await store.indexReport(sample, { r2Key: reportBlobKeyV3(sample.reportId), visibility: "corpus" });
  const indexCalls = seenCalls.length - callsBeforeIndex;
  assert.ok(indexCalls <= 8, `Expected batched multi-row D1 inserts (<= 8 HTTP calls for 25 entities), got ${indexCalls}`);
  const ids = await store.listIndexedReportIds();
  assert.equal(ids.has(sample.reportId), true);

  // Never emits BEGIN IMMEDIATE / COMMIT over stateless HTTP REST
  assert.equal(
    seenCalls.some((c) => /^\s*BEGIN\b/i.test(c.sql)),
    false
  );
  assert.equal(
    seenCalls.every((c) => c.url === "https://api.cloudflare.test/client/v4/accounts/acct-123/d1/database/db-456/query"),
    true
  );
  assert.equal(
    seenCalls.every((c) => c.auth === `Bearer ${secretToken}`),
    true
  );

  // Error messages surface D1 failure without leaking the API token
  const rawExec = createCloudflareD1HttpExecutorV3({
    accountId: "acct-123",
    databaseId: "db-456",
    apiToken: secretToken,
    endpointBase: "https://api.cloudflare.test/client/v4",
    fetchImpl: fakeFetch
  });
  await assert.rejects(
    async () => {
      await rawExec.run("SELECT FAIL_ME");
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /syntax error near FAIL_ME/);
      assert.equal(err.message.includes(secretToken), false);
      return true;
    }
  );

  assert.deepEqual(
    resolveD1HttpConfigFromEnv({
      CLOUDFLARE_ACCOUNT_ID: "a1",
      CLOUDFLARE_D1_DATABASE_ID: "d1",
      CLOUDFLARE_D1_API_TOKEN: "tok1"
    }),
    { accountId: "a1", databaseId: "d1", apiToken: "tok1", endpointBase: undefined }
  );
  assert.equal(resolveD1HttpConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: "a1" }), undefined);
});

test("layered blob store & cold-start seed hydration verify digests and protect read-only seed dir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-v3-seed-test-"));
  try {
    const seedDir = path.join(dir, "seed");
    const reportsDir = path.join(seedDir, "reports");
    const primaryDir = path.join(dir, "primary");
    const dataDir = path.join(dir, "runtime-data");
    await mkdir(reportsDir, { recursive: true });

    const validReport = makeReport({
      reportId: "20261125-000000000000000000000000000000aa",
      canonicalDomain: "seeded-valid.example",
      scannedAt: "2026-11-25T12:00:00.000Z",
      thirdPartyDomains: 12
    });
    const tamperedReport = makeReport({
      reportId: "20261125-000000000000000000000000000000bb",
      canonicalDomain: "seeded-tampered.example",
      scannedAt: "2026-11-25T12:05:00.000Z"
    });

    const validJson = JSON.stringify(validReport);
    const tamperedJson = JSON.stringify(tamperedReport);
    await writeFile(path.join(reportsDir, `${validReport.reportId}.json`), validJson, "utf8");
    await writeFile(path.join(reportsDir, `${tamperedReport.reportId}.json`), tamperedJson, "utf8");

    const validSha = createHash("sha256").update(validJson, "utf8").digest("hex");
    await writeFile(
      path.join(seedDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-11-25T12:10:00.000Z",
        reports: [
          {
            reportId: validReport.reportId,
            canonicalDomain: validReport.canonicalDomain,
            scannedAt: validReport.scannedAt,
            file: `reports/${validReport.reportId}.json`,
            sha256: validSha
          },
          {
            reportId: tamperedReport.reportId,
            canonicalDomain: tamperedReport.canonicalDomain,
            scannedAt: tamperedReport.scannedAt,
            file: `reports/${tamperedReport.reportId}.json`,
            sha256: "0".repeat(64)
          }
        ]
      }),
      "utf8"
    );

    // Read-only seed blob store rejects mutations and path traversal
    const seedStore = createReadOnlySeedBlobStoreV3(seedDir);
    await assert.rejects(() => seedStore.putJson(reportBlobKeyV3(validReport.reportId), "{}"), /Read-only/);
    await assert.rejects(() => seedStore.delete(reportBlobKeyV3(validReport.reportId)), /Read-only/);
    assert.equal(await seedStore.getJson("v3/reports/../../etc/passwd"), null);
    assert.equal(await seedStore.getJson("manifest.json"), null);

    // Layered store falls back to seed dir and prioritizes primary writes
    const primaryStore = createFsBlobStoreV3(primaryDir);
    const layered = createLayeredBlobStoreV3(primaryStore, seedStore);
    const loadedFallback = await loadReportV3(layered, validReport.reportId);
    assert.equal(loadedFallback?.canonicalDomain, "seeded-valid.example");

    const overrideReport = { ...validReport, finalUrl: "https://seeded-valid.example/updated" };
    await saveReportV3(layered, overrideReport);
    const loadedPrimary = await loadReportV3(layered, validReport.reportId);
    assert.equal(loadedPrimary?.finalUrl, "https://seeded-valid.example/updated");

    // Cold-start hydration indexes only SHA-verified reports and is idempotent
    const { store, close } = await openNodeSqliteReportIndex(":memory:");
    try {
      const firstPass = await hydrateV3SeedCorpus(store, seedDir);
      assert.deepEqual(firstPass, { hydrated: 1, skipped: 0, rejected: 1 });
      const secondPass = await hydrateV3SeedCorpus(store, seedDir);
      assert.deepEqual(secondPass, { hydrated: 0, skipped: 1, rejected: 1 });
    } finally {
      close();
    }

    // Runtime context honors SITE_BEHAVIOR_LAB_V3_SEED_DIR and "none" opt-out
    assert.equal(resolveV3SeedDir({ SITE_BEHAVIOR_LAB_V3_SEED_DIR: "none" }), null);
    assert.equal(resolveV3SeedDir({ SITE_BEHAVIOR_LAB_V3_SEED_DIR: seedDir }), path.resolve(seedDir));

    await resetV3RuntimeContextForTests();
    const ctx = await getV3RuntimeContext({
      SITE_BEHAVIOR_LAB_V3_DATA_DIR: dataDir,
      SITE_BEHAVIOR_LAB_V3_SEED_DIR: seedDir
    });
    try {
      assert.equal(ctx.indexBackend, "sqlite");
      const stats = await ctx.reportIndex.getCorpusOverviewStats();
      assert.equal(stats.distinctSites, 1);
      const fetched = await loadReportV3(ctx.blobStore, validReport.reportId);
      assert.equal(fetched?.canonicalDomain, "seeded-valid.example");
    } finally {
      await resetV3RuntimeContextForTests();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hardening: S3 R2 blob store drains 404 XML fast without awaiting body.cancel, corpus beats public, and pruneExpiredReports deletes blobs", async () => {
  // 1. S3 R2 404 body drain must NOT invoke or await stream cancel() (which can stall on undici 8)
  let cancelCalled = false;
  const r2 = createS3R2BlobStoreV3({
    endpoint: "https://r2.invalid",
    bucket: "test-bucket",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    fetchImpl: async () => {
      const xmlBytes = new TextEncoder().encode("<Error><Code>NoSuchKey</Code></Error>");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(xmlBytes);
          controller.close();
        },
        cancel() {
          cancelCalled = true;
          return new Promise<void>(() => {});
        }
      });
      return new Response(stream, {
        status: 404,
        headers: { "content-type": "application/xml", "content-length": String(xmlBytes.byteLength) }
      });
    }
  });
  const missing = await r2.getJson("v3/reports/20261125-00000000000000000000000000000000.json");
  assert.equal(missing, null);
  assert.equal(cancelCalled, false, "R2 404 miss must drain the small XML error body instead of calling body.cancel()");

  // 2. Curated `corpus` records take precedence over newer `public` submissions for the same domain,
  //    and `pruneExpiredReports` deletes both JSON + PDF blobs and index rows.
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-v3-hardening-"));
  const { store, close } = await openNodeSqliteReportIndex(":memory:");
  try {
    const blobStore = createFsBlobStoreV3(dir);
    const corpusRep = makeReport({
      reportId: "20261120-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      canonicalDomain: "protected.example",
      scannedAt: "2026-11-20T10:00:00.000Z",
      thirdPartyDomains: 22
    });
    const publicOverrideAttempt = makeReport({
      reportId: "20261125-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      canonicalDomain: "protected.example",
      scannedAt: "2026-11-25T10:00:00.000Z",
      thirdPartyDomains: 0
    });
    const expiringRep = makeReport({
      reportId: "20261110-cccccccccccccccccccccccccccccccc",
      canonicalDomain: "transient.example",
      scannedAt: "2026-11-10T10:00:00.000Z",
      thirdPartyDomains: 4
    });

    await store.indexReport(corpusRep, { r2Key: reportBlobKeyV3(corpusRep.reportId), visibility: "corpus" });
    await store.indexReport(publicOverrideAttempt, {
      r2Key: reportBlobKeyV3(publicOverrideAttempt.reportId),
      visibility: "public"
    });
    const expKey = await saveReportV3(blobStore, expiringRep);
    await blobStore.putBinary(pdfBlobKeyV3(expiringRep.reportId), new Uint8Array(Buffer.from("%PDF-1.7\n")), "application/pdf");
    await store.indexReport(expiringRep, {
      r2Key: expKey,
      visibility: "unlisted",
      expiresAt: "2026-11-17T10:00:00.000Z"
    });

    const latest = await store.queryCorpus({ latestPerSite: true });
    assert.equal(latest.items.find((i) => i.canonicalDomain === "protected.example")?.reportId, corpusRep.reportId);

    const pruned = await store.pruneExpiredReports(blobStore, "2026-11-25T12:00:00.000Z");
    assert.equal(pruned, 1);
    assert.equal(await loadReportV3(blobStore, expiringRep.reportId), null);
    assert.equal(await blobStore.getBinary(pdfBlobKeyV3(expiringRep.reportId)), null);
    assert.equal(await store.getReportMeta(expiringRep.reportId), null);
  } finally {
    close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("v3 PDF HTML, Markdown formatter, and corpus index distinguish unexercised keystroke probes from tested zeros", async () => {
  const untested = makeReport({
    reportId: "20261126-77777777777777777777777777777777",
    canonicalDomain: "untested.example",
    scannedAt: "2026-11-26T00:00:00.000Z"
  });
  untested.leadArm.keystrokes.fieldsTyped = 0;
  untested.leadArm.probes.keystrokes = { status: "skipped", reason: "no-eligible-input-fields" };

  const tested = makeReport({
    reportId: "20261126-88888888888888888888888888888888",
    canonicalDomain: "tested.example",
    scannedAt: "2026-11-26T00:00:00.000Z"
  });
  tested.leadArm.keystrokes.fieldsTyped = 2;
  tested.leadArm.probes.keystrokes = { status: "complete" };

  const untestedHtml = renderReportV3PrintHtml(untested);
  assert.match(untestedHtml, /not exercised \(0 eligible input fields/);
  assert.match(untestedHtml, /no-eligible-input-fields/);
  const testedHtml = renderReportV3PrintHtml(tested);
  assert.match(testedHtml, /complete \(2 fields exercised; no pre-submission keystroke transmission observed\)/);

  const untestedMd = formatReportMarkdownV3(untested);
  assert.match(untestedMd, /n\/t \(0 fields\)/);
  assert.match(untestedMd, /keystrokes: skipped \(no-eligible-input-fields\)/);
  const testedMd = formatReportMarkdownV3(tested);
  assert.match(testedMd, /0 \(2 fields\)/);

  const { store, close } = await openNodeSqliteReportIndex(":memory:");
  try {
    await store.indexReport(untested, { r2Key: reportBlobKeyV3(untested.reportId), visibility: "corpus" });
    await store.indexReport(tested, { r2Key: reportBlobKeyV3(tested.reportId), visibility: "corpus" });
    const stats = await store.getCorpusOverviewStats();
    assert.equal(stats.distinctSites, 2);
    assert.equal(stats.sitesWithKeystrokeLeaks, 0);
    assert.equal(stats.sitesWithKeystrokeProbeExercised, 1);

    const rows = await store.queryCorpus({ latestPerSite: true });
    const untestedRow = rows.items.find((r) => r.canonicalDomain === "untested.example");
    const testedRow = rows.items.find((r) => r.canonicalDomain === "tested.example");
    assert.equal(untestedRow?.keystrokeFieldsTyped, 0);
    assert.equal(testedRow?.keystrokeFieldsTyped, 2);
  } finally {
    close();
  }
});

test("sbl verify supports external --expected-sha256 and --manifest integrity checks with explicit scope", () => {
  const report = makeReport({
    reportId: "20261126-99999999999999999999999999999999",
    canonicalDomain: "verify.example",
    scannedAt: "2026-11-26T00:00:00.000Z"
  });
  const raw = JSON.stringify(report);
  const rawSha = createHash("sha256").update(raw, "utf8").digest("hex");

  // Default mode: internal consistency only
  const base = verifyReportV3Json(raw);
  assert.equal(base.ok, true);
  assert.equal(base.rawDigest, rawSha);
  assert.equal(base.digestMatched, null);
  assert.equal(base.manifestMatched, null);
  assert.match(base.verificationScope, /internal-consistency-only/);

  // Expected canonical SHA-256 match & raw SHA-256 match
  assert.equal(verifyReportV3Json(raw, { expectedSha256: base.digest! }).ok, true);
  const rawMatch = verifyReportV3Json(raw, { expectedSha256: rawSha });
  assert.equal(rawMatch.ok, true);
  assert.equal(rawMatch.digestMatched, true);
  assert.match(rawMatch.verificationScope, /internal-consistency-and-digest-match/);

  // Expected SHA-256 mismatch fails
  const wrongHash = verifyReportV3Json(raw, { expectedSha256: "0".repeat(64) });
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.digestMatched, false);

  // Manifest exact match & mismatch (matching public/v3/manifest.json shape: `reports` + `bytes`)
  const manifest = JSON.stringify({
    schemaVersion: 1,
    reports: [
      {
        reportId: report.reportId,
        canonicalDomain: report.canonicalDomain,
        sha256: rawSha,
        bytes: Buffer.byteLength(raw, "utf8")
      }
    ]
  });
  const okManifest = verifyReportV3Json(raw, { manifestJson: manifest });
  assert.equal(okManifest.ok, true);
  assert.equal(okManifest.manifestMatched, true);

  const badManifest = JSON.stringify({
    schemaVersion: 1,
    reports: [
      {
        reportId: report.reportId,
        canonicalDomain: report.canonicalDomain,
        sha256: "f".repeat(64),
        bytes: Buffer.byteLength(raw, "utf8")
      }
    ]
  });
  const failManifest = verifyReportV3Json(raw, { manifestJson: badManifest });
  assert.equal(failManifest.ok, false);
  assert.equal(failManifest.manifestMatched, false);
});

test("shared static corpus snapshot filter and vendor footprint builder stay deterministic", () => {
  const snapshot: StaticCorpusSnapshotV3 = {
    schemaVersion: 1,
    generatedAt: "2026-11-26T00:00:00.000Z",
    stats: {
      totalReports: 2,
      distinctSites: 2,
      medianThirdPartyDomains: 5,
      sitesWithKeystrokeLeaks: 0,
      sitesWithKeystrokeProbeExercised: 1,
      sitesWithCnameCloaks: 1,
      sitesWithServerSideTagging: 1,
      sitesWithFingerprinting: 0,
      sitesWithDarkPatterns: 1,
      topEntities: [],
      topParentOrgs: []
    },
    items: [
      {
        reportId: "20261126-11111111111111111111111111111111",
        canonicalDomain: "alpha.example",
        finalUrl: "https://alpha.example/",
        scannedAt: "2026-11-26T01:00:00.000Z",
        visibility: "corpus",
        egressRegion: "us",
        device: "desktop",
        loadOutcome: "ok",
        httpStatus: 200,
        totalRequests: 20,
        thirdPartyRequests: 8,
        thirdPartyDomains: 4,
        trackingRequests: 5,
        shieldsBlockedStandard: 3,
        shieldsBlockedAggressive: 5,
        distinctEntities: 2,
        distinctParentOrgs: 1,
        cookiesTotal: 3,
        thirdPartyCookies: 1,
        longLivedCookies: 1,
        partitionedCookies: 0,
        storageKeysTotal: 2,
        websocketsTotal: 0,
        serviceWorkersTotal: 0,
        beaconPlatforms: 1,
        serverSideTaggingEndpoints: 1,
        cnameCloaksCount: 1,
        fingerprintKindsCount: 0,
        keystrokeLeaksCount: 0,
        keystrokeFieldsTyped: 1,
        darkPatternScore: 45,
        topHighlight: "CNAME cloak",
        r2Key: "v3/reports/20261126-11111111111111111111111111111111.json",
        reportDigest: "a".repeat(64),
        expiresAt: null
      },
      {
        reportId: "20261126-22222222222222222222222222222222",
        canonicalDomain: "beta.example",
        finalUrl: "https://beta.example/",
        scannedAt: "2026-11-26T02:00:00.000Z",
        visibility: "corpus",
        egressRegion: "us",
        device: "desktop",
        loadOutcome: "ok",
        httpStatus: 200,
        totalRequests: 10,
        thirdPartyRequests: 2,
        thirdPartyDomains: 8,
        trackingRequests: 1,
        shieldsBlockedStandard: 1,
        shieldsBlockedAggressive: 1,
        distinctEntities: 1,
        distinctParentOrgs: 1,
        cookiesTotal: 1,
        thirdPartyCookies: 0,
        longLivedCookies: 0,
        partitionedCookies: 0,
        storageKeysTotal: 0,
        websocketsTotal: 0,
        serviceWorkersTotal: 0,
        beaconPlatforms: 0,
        serverSideTaggingEndpoints: 0,
        cnameCloaksCount: 0,
        fingerprintKindsCount: 0,
        keystrokeLeaksCount: 0,
        keystrokeFieldsTyped: 0,
        darkPatternScore: 10,
        topHighlight: null,
        r2Key: "v3/reports/20261126-22222222222222222222222222222222.json",
        reportDigest: "b".repeat(64),
        expiresAt: null
      }
    ],
    entityDomains: { "Google Analytics": ["alpha.example"] },
    entitySiteStats: {
      "Google Analytics": [{ domain: "alpha.example", requests: 5, domains: 2, category: "analytics" }]
    }
  };

  const sorted = filterStaticCorpusSnapshotV3(snapshot, {
    q: "",
    entity: "",
    parentOrg: "",
    sort: "third-parties",
    hasKeystrokes: false,
    hasCname: false,
    hasSgtm: false,
    hasFp: false,
    highDarkPattern: false
  });
  assert.deepEqual(sorted.map((r) => r.canonicalDomain), ["beta.example", "alpha.example"]);

  const filtered = filterStaticCorpusSnapshotV3(snapshot, {
    q: "",
    entity: "google analytics",
    parentOrg: "",
    sort: "newest",
    hasKeystrokes: false,
    hasCname: true,
    hasSgtm: true,
    hasFp: false,
    highDarkPattern: true
  });
  assert.deepEqual(filtered.map((r) => r.canonicalDomain), ["alpha.example"]);

  const fp = buildVendorFootprintFromSnapshotV3(snapshot, "Google Analytics");
  assert.equal(fp.totalSites, 1);
  assert.equal(fp.corpusSites, 2);
  assert.equal(fp.prevalencePct, 50);
  assert.equal(fp.sites[0]?.requestCount, 5);
});
