import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { resolveDefaultAddressKernelFile } from "./address-kernel";
import {
  ADMISSION_ATTEMPT_MAX_STORED_ROWS,
  chargeAdmissionAttempt,
  isAdmissionAttempt
} from "./admission-attempt-limit";
import type { DurableScanJobStoreSql } from "./durable-scan-job-store";
import { scanTokenCost } from "./edge-scan-gate";
import { parsePublicReportReadPath, refusePublicReportRouteMethod } from "./report-read-edge";
import {
  buildV3ScanBody,
  buildV3ScanHeaders,
  parseV3ScannerHealth,
  resolveV3ApiUrl,
  resolveV3DynamicPageUrl,
  resolveV3StaticPageUrl
} from "./v3/client-urls";
import { evaluateFailOnRulesV3 } from "./v3/cli/formatters";
import { runSblCli } from "./v3/cli/index";
import { reportToSarifV3 } from "./v3/cli/sarif";
import { rootInitiatorDomainV3 } from "./v3/dev-mode";
import { renderReportV3Pdf } from "./v3/pdf/browser-rendering-pdf";
import { decodeBeaconRequestV3, parseGoogleConsentMode, summarizeBeaconEventsV3 } from "./v3/probes/beacons";
import { CMP_RULES_V3 } from "./v3/probes/consent-probe";
import { analyzeFingerprintTelemetryV3 } from "./v3/probes/fingerprint-probe";
import { buildSentinelEncodingsV3, detectKeystrokeLeaksV3 } from "./v3/probes/keystroke-probe";
import { analyzePolicyTextV3 } from "./v3/probes/policy-probe";
import { assertNoUnredactedSecretsV3, redactScanReportV3, redactUrlV3 } from "./v3/redaction";
import { resolveRegionalUpstreamsFromEnv, resolveV3DataDir } from "./v3/runtime/store-context";
import { dispatchScanV3, verifyWorkerDispatchSignatureV3 } from "./v3/runtime/worker-dispatch";
import { buildArmSummaryV3 } from "./v3/scanner/summary";
import { validateScanReportV3, type ScanReportV3 } from "./v3/schema";
import { openNodeSqliteReportIndex } from "./v3/storage/report-index";

function minimalReport(id: string, domain: string): ScanReportV3 {
  return {
    schemaVersion: 3,
    reportId: id,
    scannedAt: "2026-11-25T15:00:00.000Z",
    targetUrl: `https://${domain}/`,
    finalUrl: `https://${domain}/`,
    canonicalDomain: domain,
    provenance: {
      schemaVersion: 3,
      scannerVersion: "sbl-v3.0.0",
      buildCommit: "test",
      engineVersions: {
        chromium: "159.0",
        playwright: "1.65.1",
        adblockRust: "0.12.5",
        filterListsDigest: "abc",
        entityCatalogDigest: "def"
      },
      egressRegion: "us-east",
      locale: "en-US",
      timezone: "America/New_York",
      acquisition: "cli"
    },
    leadArm: {
      armId: "baseline",
      label: "Baseline",
      conditions: {
        device: "desktop",
        gpcEnabled: false,
        shieldsMode: "off",
        consentMode: "observe",
        scrollCheck: true,
        activeInputProbe: true,
        policyCheck: true
      },
      finalUrl: `https://${domain}/`,
      httpStatus: 200,
      loadOutcome: "ok",
      durationMs: 1000,
      phases: [{ name: "passive-load", startedAtMs: 0, endedAtMs: 1000, status: "completed" }],
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
      beacons: [],
      cnameCloaks: [],
      fingerprinting: [],
      keystrokes: { fieldsTyped: 0, iframeFieldsTyped: 0, shadowDomFieldsTyped: 0, fieldTypes: [], leaks: [] },
      consent: {
        mode: "observe",
        banner: {
          detected: false,
          cmp: null,
          hasFirstLayerAccept: false,
          hasFirstLayerReject: false,
          hasSettingsEntry: false,
          clicksToAccept: null,
          clicksToReject: null,
          darkPatternFlags: [],
          darkPatternScore: 0
        },
        interaction: { attempted: false, clicked: false, layer: null },
        verification: {
          tcf: { present: false, gdprApplies: null, eventStatus: null, state: "unavailable" },
          gpp: { present: false, applicableSections: [], state: "unavailable" },
          usp: { present: false, optOutSale: null },
          googleConsentMode: [],
          cmpCookies: [],
          consistency: "unavailable"
        }
      },
      policy: null,
      summary: {
        totalRequests: 1,
        thirdPartyRequests: 0,
        thirdPartyDomains: 0,
        trackingRequests: 0,
        shieldsMatchedRequests: 0,
        shieldsBlockedStandard: 0,
        shieldsBlockedAggressive: 0,
        distinctEntities: 0,
        distinctParentOrgs: 0,
        cookiesTotal: 0,
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
        darkPatternScore: 0,
        topEntities: []
      }
    },
    comparisonArms: [],
    comparisons: [],
    highlights: []
  };
}

test("C1/H2: Edge gates decode percent-encoded /api/v3/scan, price v3 comparisons, and meter v3 read/PDF/corpus routes", () => {
  assert.equal(isAdmissionAttempt("POST", "/api/v3/scan"), true);
  assert.equal(isAdmissionAttempt("POST", "/%61pi/v%33/sc%61n"), true);
  assert.equal(isAdmissionAttempt("POST", "/api/scan"), true);
  assert.equal(isAdmissionAttempt("OPTIONS", "/api/v3/scan"), false);

  assert.equal(scanTokenCost({ comparisons: ["shields-standard", "gpc"] }), 2);
  assert.equal(scanTokenCost({ comparisons: [] }), 1);

  const reportId = "20261125-0123456789abcdef0123456789abcdef";
  assert.equal(parsePublicReportReadPath("GET", `/api/v3/reports/${reportId}`)?.quota, "report-json-read");
  assert.equal(parsePublicReportReadPath("GET", `/api/v3/reports/${reportId}/pdf`)?.quota, "report-pdf");
  assert.equal(parsePublicReportReadPath("GET", "/api/v3/corpus")?.quota, "report-json-read");
  assert.equal(parsePublicReportReadPath("GET", "/api/v3/watches/diff")?.quota, "report-json-read");
  assert.equal(parsePublicReportReadPath("GET", `/v3/reports/${reportId}`)?.quota, "report-read");
  assert.equal(parsePublicReportReadPath("GET", "/v3/sites/example.com")?.quota, "report-read");
  assert.equal(refusePublicReportRouteMethod("POST", `/v3/reports/${reportId}`), true);
  assert.equal(refusePublicReportRouteMethod("POST", "/api/v3/corpus"), true);
});

test("C2: Address kernel resolves vendored WASM even when process.cwd() is outside the repo", () => {
  const resolved = resolveDefaultAddressKernelFile();
  assert.match(resolved, /lib[/\\]trust-kernel-wasm[/\\]sbl_trust_kernel_wasm\.wasm$/);
});

test("C3: Redaction blocks raw gcs secrets, %40 emails, JWTs, highlight query leaks, and injected Client Hints", () => {
  // Raw invalid gcs must never persist
  assert.equal(parseGoogleConsentMode(new URLSearchParams("gcs=alice@example.com")), null);
  const validGcm = parseGoogleConsentMode(new URLSearchParams("gcs=G100"));
  assert.equal(validGcm?.gcs, "G100");
  assert.equal(validGcm?.adStorage, "denied");

  // Percent-encoded email, embedded UUID, JWT in path
  assert.equal(redactUrlV3("https://app.example/users/alice%40example.com/profile"), "https://app.example/users/[redacted-email]/profile");
  assert.equal(
    redactUrlV3("https://app.example/u/user_123e4567-e89b-12d3-a456-426614174000"),
    "https://app.example/u/[redacted-token]"
  );
  const syntheticJwt = [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from('{"sub":"1234567890"}').toString("base64url"),
    Buffer.from("synthetic-test-signature-bytes").toString("base64url")
  ].join(".");
  assert.equal(
    redactUrlV3(`https://app.example/auth/${syntheticJwt}`),
    "https://app.example/auth/[redacted-token]"
  );

  // Highlight with raw policy URL query string is redacted
  const rep = minimalReport("20261125-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "shop.example");
  rep.highlights.push({
    id: "policy-gap",
    severity: "medium",
    category: "policy",
    title: "Policy gap",
    detail: "Unmentioned in https://shop.example/privacy?session=secret123: Meta"
  });
  assert.throws(() => assertNoUnredactedSecretsV3(rep), /unredacted query\/fragment/);
  const cleaned = redactScanReportV3(rep);
  assert.equal(cleaned.highlights[0].detail, "Unmentioned in https://shop.example/privacy: Meta");
  assert.doesNotThrow(() => assertNoUnredactedSecretsV3(cleaned));

  // Client Hints allowlist rejects arbitrary page-injected strings
  const fps = analyzeFingerprintTelemetryV3([
    {
      api: "clientHints.getHighEntropyValues",
      realm: "main",
      scriptDomain: "evil.example",
      detail: { hints: "platformVersion,secret=alice@example.com,arbitraryInjection" }
    },
    // MutationObserver without characterData (e.g. OneTrust/GTM) must NOT fire mutation-observer-replay
    {
      api: "mutationObserver.observe",
      realm: "main",
      scriptDomain: "cdn.cookielaw.org",
      detail: { root: true, subtree: true, attributes: true, childList: true, characterData: false }
    }
  ]);
  const ch = fps.find((f) => f.kind === "client-hints-high-entropy");
  assert.deepEqual(ch?.evidence.requestedHints, ["platformVersion"]);
  assert.equal(fps.some((f) => f.kind === "mutation-observer-replay"), false);
});

test("H1: Rotating single-shot IPv6 flood cannot evict an active high-rate client's admission limit", () => {
  const db = new DatabaseSync(":memory:");
  const sql: DurableScanJobStoreSql = {
    exec<T extends Record<string, ArrayBuffer | string | number | null>>(
      query: string,
      ...bindings: Array<ArrayBuffer | string | number | null>
    ) {
      const stmt = db.prepare(query);
      const vals = bindings.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
      const rows = /^\s*SELECT/.test(query) ? (stmt.all(...vals) as T[]) : [];
      if (!/^\s*SELECT/.test(query)) stmt.run(...vals);
      return { toArray: () => rows };
    }
  };
  const hashOf = (n: number) => n.toString(16).padStart(64, "0");
  try {
    const attacker = hashOf(1);
    for (let i = 0; i < 10; i++) assert.equal(chargeAdmissionAttempt(sql, attacker, 1_000).allowed, true);
    assert.equal(chargeAdmissionAttempt(sql, attacker, 1_001).allowed, false);

    // Flood 5,200 distinct single-shot rotating identities at t=1_002
    for (let ip = 10; ip < 10 + ADMISSION_ATTEMPT_MAX_STORED_ROWS + 200; ip++) {
      assert.equal(chargeAdmissionAttempt(sql, hashOf(ip), 1_002).allowed, true);
    }

    // Attacker #1 MUST STILL BE BLOCKED (not evicted by rotating single-shot noise!)
    assert.equal(chargeAdmissionAttempt(sql, attacker, 1_005).allowed, false);
  } finally {
    db.close();
  }
});

test("H2: renderReportV3Pdf deduplicates concurrent renders via single-flight and rejects invalid non-PDF payloads", async () => {
  const rep = minimalReport("20261125-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "pdf.example");
  let calls = 0;
  let releaseFetch!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const pdfBytes = new Uint8Array(Buffer.from("%PDF-1.7\n%ok\n"));
  const slowFetch: typeof fetch = async () => {
    calls += 1;
    await gate;
    return new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } });
  };
  const pending = Promise.all([
    renderReportV3Pdf(rep, { cloudflareBrowserRendering: { accountId: "a", apiToken: "t" }, fetchImpl: slowFetch }),
    renderReportV3Pdf(rep, { cloudflareBrowserRendering: { accountId: "a", apiToken: "t" }, fetchImpl: slowFetch }),
    renderReportV3Pdf(rep, { cloudflareBrowserRendering: { accountId: "a", apiToken: "t" }, fetchImpl: slowFetch })
  ]);
  await Promise.resolve();
  releaseFetch();
  const results = await pending;
  assert.equal(calls, 1, "Single-flight must coalesce concurrent renders for the same reportId");
  assert.equal(results.length, 3);

  // Reject HTML/JSON masquerading as HTTP 200 PDF
  const badFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ success: false }), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    () => renderReportV3Pdf(rep, { cloudflareBrowserRendering: { accountId: "a", apiToken: "t" }, fetchImpl: badFetch }),
    /invalid non-PDF/
  );
});

test("H3: getEntityFootprint deduplicates multi-entity parent orgs (prevalence <= 100%) and LIKE escapes wildcards", async () => {
  const { store, close } = await openNodeSqliteReportIndex(":memory:");
  try {
    const rep = minimalReport("20261125-cccccccccccccccccccccccccccccccc", "media.example");
    rep.leadArm.summary.topEntities = [
      { entity: "Google Analytics", parentOrg: "Alphabet", category: "analytics", requests: 4, domains: 1 },
      { entity: "Google Ads / DoubleClick", parentOrg: "Alphabet", category: "advertising", requests: 6, domains: 2 },
      { entity: "Google Tag Manager", parentOrg: "Alphabet", category: "tag-manager", requests: 2, domains: 1 }
    ];
    await store.indexReport(rep, { r2Key: "v3/reports/media.json", visibility: "corpus" });

    const fp = await store.getEntityFootprint("Alphabet");
    assert.equal(fp.corpusSites, 1);
    assert.equal(fp.totalSites, 1);
    assert.equal(fp.sites.length, 1);
    assert.equal(fp.prevalencePct, 100);
    assert.equal(fp.sites[0].requestCount, 12);

    // Wildcard query `%` must not match unrelated domains
    const wild = await store.queryCorpus({ query: "100%_literal" });
    assert.equal(wild.total, 0);
  } finally {
    close();
  }
});

test("H5/M3: TrustArc has no bare .call, email-canary hashes exist, document-cookie-writes excluded from FP count, Mixpanel base64 & CJK policy split", () => {
  const trustArc = CMP_RULES_V3.find((r) => r.cmp === "TrustArc");
  assert.ok(trustArc);
  assert.equal(trustArc.accept.includes(".call"), false);

  const encodings = buildSentinelEncodingsV3("sblcanary12345678");
  assert.ok(encodings.some((e) => e.encoding === "sha256-email"));

  const sum = buildArmSummaryV3({
    network: [],
    websockets: [],
    serviceWorkers: [],
    cookies: [],
    storage: [],
    beacons: [],
    cnameCloaks: [],
    fingerprinting: [
      {
        kind: "document-cookie-writes",
        count: 10,
        realms: ["main"],
        apis: ["document.cookie.write"],
        scriptDomains: [],
        evidence: { writeCalls: 10 }
      }
    ],
    keystrokes: { fieldsTyped: 0, iframeFieldsTyped: 0, shadowDomFieldsTyped: 0, fieldTypes: [], leaks: [] },
    consent: minimalReport("20261125-dddddddddddddddddddddddddddddddd", "a.example").leadArm.consent
  });
  assert.equal(sum.fingerprintKindsCount, 0);

  // Mixpanel base64 payload decoding
  const mpPayload = Buffer.from(JSON.stringify({ event: "$mp_web_page_view", properties: { email: "a@b.c", country: "US" } })).toString("base64");
  const mp = decodeBeaconRequestV3({
    url: `https://api-js.mixpanel.com/track/?data=${encodeURIComponent(mpPayload)}`,
    method: "GET",
    thirdParty: true,
    phase: "passive-load"
  });
  assert.equal(mp?.platform, "Mixpanel");
  assert.equal(mp?.complete, true);
  assert.deepEqual(mp?.identifierCategories, ["email"]); // country must NOT false-positive as address!

  // CJK policy sentence splitting without spaces
  const cjkText = `${"プライバシーポリシー。".repeat(40)}当サイトでは個人情報を第三者に販売しません。Google Analyticsを利用しています。`;
  const policy = analyzePolicyTextV3({
    url: "https://jp.example/privacy",
    text: cjkText,
    language: "ja",
    observedEntities: ["Google Analytics"]
  });
  assert.ok(policy);
  assert.ok(policy.mentionedEntities.includes("Google Analytics"));
});

test("H6/M1/M7/L1: CLI policy gates fail closed, SARIF has partialFingerprints, regional HTTP rejected, canonicalDomain strict", async () => {
  const rep = minimalReport("20261125-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "ci.example");
  assert.ok(evaluateFailOnRulesV3(rep, null, ["dark-patterns>=abc"]).length === 1);
  assert.ok(evaluateFailOnRulesV3(rep, null, ["third-parties>abc"]).length === 1);
  assert.ok(evaluateFailOnRulesV3(rep, null, ["regressions"]).length === 1);
  assert.ok(evaluateFailOnRulesV3(rep, null, ["new-entities"]).length === 1);

  let errOut = "";
  const badFlagExit = await runSblCli(["scan", "https://ci.example", "--device", "tablet"], {
    stderr: (s) => {
      errOut += s;
    }
  });
  assert.equal(badFlagExit, 1);
  assert.match(errOut, /Invalid --device/);

  // SARIF excludes document-cookie-writes and includes partialFingerprints + region
  rep.leadArm.fingerprinting.push(
    { kind: "document-cookie-writes", count: 5, realms: ["main"], apis: ["document.cookie.write"], scriptDomains: [], evidence: {} },
    { kind: "canvas", count: 2, realms: ["main"], apis: ["canvas.toDataURL"], scriptDomains: [], evidence: {} }
  );
  const sarif = reportToSarifV3(rep);
  assert.equal(sarif.runs[0].results.length, 1);
  assert.equal(sarif.runs[0].results[0].level, "warning");
  assert.match(sarif.runs[0].results[0].partialFingerprints.primaryLocationLineHash, /^[a-f0-9]{32}$/);
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 1);

  // Regional dispatch rejects plaintext http:// and short secrets
  assert.equal(
    resolveRegionalUpstreamsFromEnv({
      SITE_BEHAVIOR_LAB_REGIONAL_WORKERS_JSON: JSON.stringify([
        { region: "eu-central", endpointUrl: "http://insecure.example", hmacSecret: "1234567890123456" }
      ])
    }).length,
    0
  );
  await assert.rejects(
    () =>
      dispatchScanV3(
        { url: "https://ci.example" },
        {
          region: "eu-central",
          upstreams: [{ region: "eu-central", endpointUrl: "http://insecure.example", hmacSecret: "1234567890123456" }],
          defaultExecutor: async () => rep
        }
      ),
    /non-HTTPS/
  );
  assert.equal(
    verifyWorkerDispatchSignatureV3({
      secret: "short",
      timestampSec: "1764100000",
      signatureHex: "0".repeat(64),
      body: "{}"
    }),
    false
  );

  // Strict canonicalDomain blocks header injection characters
  const badDomain = minimalReport("20261125-ffffffffffffffffffffffffffffffff", 'evil.example";\r\nX-Test: 1');
  assert.ok(validateScanReportV3(badDomain).length > 0);

  // Shared rootInitiatorDomainV3 resolves outermost stack frame
  assert.equal(
    rootInitiatorDomainV3({
      id: 1,
      phase: "passive-load",
      url: "https://tracker.example/p",
      domain: "tracker.example",
      registrableDomain: "tracker.example",
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      protocol: "h2",
      encodedBytes: 10,
      startedAtMs: 0,
      durationMs: 1,
      redirectChain: [],
      requestHeaders: {},
      responseHeaders: {},
      entity: null,
      shields: {
        matched: false,
        shouldBlockStandard: false,
        shouldBlockAggressive: false,
        blocked: false,
        rule: null,
        list: null,
        exception: null,
        redirect: null,
        rewrittenUrl: null,
        important: false
      },
      initiator: {
        type: "script",
        scriptDomain: "googletagmanager.com",
        callStack: [
          { url: "https://googletagmanager.com/gtm.js", domain: "googletagmanager.com" },
          { url: "https://site.example/app.js", domain: "site.example" }
        ]
      }
    }),
    "site.example"
  );

  // Docker/Cloudflare Container fallback: uses writable SITE_BEHAVIOR_LAB_REPORT_STORE_DIR/v3
  assert.equal(
    resolveV3DataDir({ SITE_BEHAVIOR_LAB_REPORT_STORE_DIR: "/var/lib/site-behavior-lab/reports" }),
    "/var/lib/site-behavior-lab/reports/v3"
  );
  assert.equal(
    resolveV3DataDir({
      SITE_BEHAVIOR_LAB_V3_DATA_DIR: "/custom/v3-dir",
      SITE_BEHAVIOR_LAB_REPORT_STORE_DIR: "/var/lib/site-behavior-lab/reports"
    }),
    "/custom/v3-dir"
  );

  // Cross-origin static Pages -> live Cloudflare Container URL & Turnstile wiring
  assert.equal(
    resolveV3ApiUrl("/api/v3/corpus?view=stats", "https://scan.sitebehavior.org/"),
    "https://scan.sitebehavior.org/api/v3/corpus?view=stats"
  );
  assert.equal(resolveV3ApiUrl("/api/v3/scan", ""), "/api/v3/scan");
  assert.equal(
    resolveV3DynamicPageUrl("/v3/reports/20261125-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      staticExport: true,
      scanApiBase: "https://scan.sitebehavior.org"
    }),
    "https://scan.sitebehavior.org/v3/reports/20261125-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  );
  assert.equal(
    resolveV3DynamicPageUrl("/v3/sites/example.com", {
      staticExport: false,
      scanApiBase: "https://scan.sitebehavior.org"
    }),
    "/v3/sites/example.com"
  );
  assert.equal(resolveV3StaticPageUrl("/v3/catalog/?entity=Meta", "/site-behavior-lab"), "/site-behavior-lab/v3/catalog/?entity=Meta");
  assert.deepEqual(
    buildV3ScanHeaders({ turnstileToken: "ts-tok", accessToken: "op-key" }),
    {
      "content-type": "application/json",
      "cf-turnstile-response": "ts-tok",
      "x-site-behavior-lab-access-token": "op-key"
    }
  );
  assert.deepEqual(buildV3ScanHeaders({}), { "content-type": "application/json" });
  assert.deepEqual(
    buildV3ScanBody({
      url: " https://example.com ",
      device: "desktop",
      region: "auto",
      comparisons: ["shields-standard", "gpc"],
      turnstileToken: "ts-tok"
    }),
    {
      url: "https://example.com",
      device: "desktop",
      region: "auto",
      comparisons: ["shields-standard", "gpc"],
      turnstileToken: "ts-tok"
    }
  );
  assert.deepEqual(
    parseV3ScannerHealth({ ok: true, turnstile: true, authenticated: false, scansAvailable: true }),
    { reachable: true, scansAvailable: true, authenticated: false, turnstileRequired: true }
  );
});

test("Hardening audit regressions: non-32-hex v3 edge metering, false-positive filters, GA4 GCM dedup, and sentinel/header redaction", () => {
  // 1. Edge rate-limit matcher covers valid 16-64 hex v3 report IDs (not only 32-hex)
  const shortV3Id = "20261125-0123456789abcdef";
  const longV3Id = `20261125-${"f".repeat(48)}`;
  assert.equal(parsePublicReportReadPath("GET", `/api/v3/reports/${shortV3Id}`)?.quota, "report-json-read");
  assert.equal(parsePublicReportReadPath("GET", `/api/v3/reports/${longV3Id}/pdf`)?.quota, "report-pdf");
  assert.equal(parsePublicReportReadPath("GET", `/v3/reports/${shortV3Id}`)?.quota, "report-read");
  // Legacy v1/v2 routes still require exact 32-hex IDs
  assert.equal(parsePublicReportReadPath("GET", `/api/reports/${shortV3Id}`), null);

  // 2. Public search/geocoding autocomplete GET URLs are excluded from keystroke exfiltration,
  //    while genuine third-party POST exfiltration is still detected.
  const canary = "sblcanarydeadbeef1234";
  const enc = buildSentinelEncodingsV3(canary);
  const leaks = detectKeystrokeLeaksV3(enc, [
    {
      domain: "geocode.arcgis.com",
      registrableDomain: "arcgis.com",
      thirdParty: true,
      url: `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/suggest?text=${canary}`,
      phase: "active-input"
    },
    {
      domain: "clients1.google.com",
      registrableDomain: "google.com",
      thirdParty: true,
      url: `https://clients1.google.com/complete/search?q=${canary}`,
      phase: "active-input"
    },
    {
      domain: "ingest.replay.example",
      registrableDomain: "replay.example",
      thirdParty: true,
      url: "https://ingest.replay.example/events",
      body: JSON.stringify({ input: canary }),
      phase: "active-input"
    }
  ]);
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].domain, "ingest.replay.example");

  // 3. Single-call non-text canvas readback (e.g. WebP feature check) and low-entropy-only
  //    Client Hints do NOT false-positive, and routine UA-CH does not inflate fingerprintKindsCount.
  const benignFps = analyzeFingerprintTelemetryV3([
    { api: "canvas.toDataURL", realm: "main", scriptDomain: "www.cdc.gov", detail: { w: 300, h: 150 } },
    { api: "clientHints.getHighEntropyValues", realm: "main", scriptDomain: "www.cdc.gov", detail: { hints: "brands,mobile,platform" } }
  ]);
  assert.equal(benignFps.length, 0);

  const uachOnly = analyzeFingerprintTelemetryV3([
    { api: "clientHints.getHighEntropyValues", realm: "main", scriptDomain: "www.googletagmanager.com", detail: { hints: "platformVersion,model" } }
  ]);
  assert.equal(uachOnly.length, 1);
  const sum = buildArmSummaryV3({
    network: [],
    websockets: [],
    serviceWorkers: [],
    cookies: [],
    storage: [],
    beacons: [],
    cnameCloaks: [],
    fingerprinting: uachOnly,
    keystrokes: { fieldsTyped: 0, iframeFieldsTyped: 0, shadowDomFieldsTyped: 0, fieldTypes: [], leaks: [] },
    consent: minimalReport("20261125-dddddddddddddddddddddddddddddddd", "a.example").leadArm.consent
  });
  assert.equal(sum.fingerprintKindsCount, 0);

  // 4. GA4 consentModeSignals must NOT duplicate when gcs is in query string
  const gaSummary = summarizeBeaconEventsV3([
    {
      url: "https://www.google-analytics.com/g/collect?v=2&tid=G-TEST1&en=page_view&gcs=G111",
      thirdParty: true,
      phase: "passive-load"
    }
  ]);
  assert.equal(gaSummary.length, 1);
  assert.equal(gaSummary[0].consentModeSignals.length, 1);

  // 5. Redaction scrubs reflected active-probe sentinels, cookie paths, prefixed tokens, and non-allowlisted headers
  const rep = minimalReport("20261125-abababababababababababababababab", "redact.example");
  rep.leadArm.network.push({
    id: 1,
    phase: "active-input",
    url: `https://api.redact.example/echo/${canary}/tok_${"a1b2c3d4e5f60718293a4b5c6d7e"}`,
    domain: "api.redact.example",
    registrableDomain: "redact.example",
    method: "GET",
    resourceType: "fetch",
    status: 200,
    thirdParty: false,
    protocol: "h2",
    encodedBytes: 0,
    startedAtMs: 1,
    durationMs: 1,
    redirectChain: [],
    requestHeaders: { origin: "https://redact.example", authorization: "Bearer LEAK" } as unknown as Record<string, string>,
    responseHeaders: { referrerPolicy: "no-referrer", setCookie: "sid=LEAK" } as unknown as Record<string, string>,
    entity: null,
    shields: {
      matched: false,
      shouldBlockStandard: false,
      shouldBlockAggressive: false,
      blocked: false,
      rule: null,
      list: null,
      exception: null,
      redirect: null,
      rewrittenUrl: null,
      important: false
    },
    initiator: null
  });
  rep.leadArm.cookies.push({
    name: `c_${canary}`,
    domain: "redact.example",
    registrableDomain: "redact.example",
    path: `/u/alice@example.com/${canary}`,
    sameSite: "Lax",
    secure: true,
    httpOnly: false,
    session: true,
    thirdParty: false,
    ttlDays: null,
    partitionKey: null,
    setVia: "js",
    phase: "passive-load",
    entity: null
  });
  const scrubbed = redactScanReportV3(rep, [canary]);
  assert.doesNotThrow(() => assertNoUnredactedSecretsV3(scrubbed, [canary]));
  assert.equal(scrubbed.leadArm.network[0].url, "https://api.redact.example/echo/[redacted-sentinel]/[redacted-token]");
  assert.equal("authorization" in scrubbed.leadArm.network[0].requestHeaders, false);
  assert.equal("setCookie" in scrubbed.leadArm.network[0].responseHeaders, false);
  assert.equal(scrubbed.leadArm.cookies[0].path, "/u/[redacted-email]/[redacted-sentinel]");

  // 6. v3 Chromium launch args MUST block non-proxied WebRTC UDP (preventing UDP SSRF)
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const scannerSrc = readFileSync(require("node:path").join(process.cwd(), "lib/v3/scanner/index.ts"), "utf8");
  assert.match(scannerSrc, /--force-webrtc-ip-handling-policy=disable_non_proxied_udp/);
});
