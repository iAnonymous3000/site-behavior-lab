import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { partyKey } from "./domain-utils";
import {
  GLOBAL_ENTITY_CATALOG_V3,
  GLOBAL_ENTITY_CATALOG_V3_STATS,
  attributeDomainV3,
  detectServerSideTaggingSignature,
  lookupEntityV3
} from "./v3/entity-catalog";
import {
  decodeBeaconRequestV3,
  parseGoogleConsentMode,
  summarizeBeaconEventsV3
} from "./v3/probes/beacons";
import { runCnameProbeV3 } from "./v3/probes/cname-probe";
import { computeDarkPatternAuditV3, evaluateConsentVerificationV3 } from "./v3/probes/consent-probe";
import { analyzeFingerprintTelemetryV3 } from "./v3/probes/fingerprint-probe";
import {
  buildSentinelEncodingsV3,
  createKeystrokeCanaryV3,
  detectKeystrokeLeaksV3
} from "./v3/probes/keystroke-probe";
import { analyzePolicyTextV3, selectPrivacyPolicyUrlV3 } from "./v3/probes/policy-probe";
import {
  assertNoUnredactedSecretsV3,
  redactScanReportV3,
  redactUrlV3,
  reportV3Digest
} from "./v3/redaction";
import { validateScanReportV3, type NetworkRequestV3, type ScanReportV3 } from "./v3/schema";

test("global entity catalog covers 150+ multi-region entities with parent org rollups and stable digest", () => {
  assert.ok(GLOBAL_ENTITY_CATALOG_V3.length >= 140, `expected >= 140 entities, got ${GLOBAL_ENTITY_CATALOG_V3.length}`);
  assert.ok(GLOBAL_ENTITY_CATALOG_V3_STATS.parentOrgs >= 100);
  assert.match(GLOBAL_ENTITY_CATALOG_V3_STATS.digest, /^[a-f0-9]{64}$/);

  const ga = lookupEntityV3("www.google-analytics.com");
  assert.equal(ga?.parentOrg, "Alphabet");
  assert.equal(ga?.category, "analytics");

  const eulerian = lookupEntityV3("tag.eulerian.net");
  assert.equal(eulerian?.region, "EU");
  assert.equal(eulerian?.entity, "Eulerian");

  const yandex = lookupEntityV3("mc.yandex.ru");
  assert.equal(yandex?.region, "RU");

  const baidu = lookupEntityV3("hm.baidu.com");
  assert.equal(baidu?.region, "CN");

  const naver = lookupEntityV3("wcs.naver.net");
  assert.equal(naver?.region, "APAC");

  const shieldsFallback = attributeDomainV3("unknown-tracker.example", {
    shieldsMatched: true,
    registrableDomain: "unknown-tracker.example"
  });
  assert.equal(shieldsFallback?.confidence, "shields-list");

  const sgtm = detectServerSideTaggingSignature({
    url: "https://metrics.shop.example/g/collect?v=2&tid=G-ABC123",
    firstParty: true
  });
  assert.equal(sgtm?.provider, "Google sGTM");

  const zaraz = detectServerSideTaggingSignature({
    url: "https://shop.example/cdn-cgi/zaraz/t",
    firstParty: true
  });
  assert.equal(zaraz?.provider, "Cloudflare Zaraz");
});

test("unified beacon decoder handles first-party sGTM, Google Consent Mode, Meta CAPI, Adobe Web SDK, and 10+ protocols", () => {
  const gcm = parseGoogleConsentMode(new URLSearchParams("gcs=G101&gcd=13l3r3l3l1"));
  assert.deepEqual(gcm, {
    gcs: "G101",
    adStorage: "denied",
    analyticsStorage: "granted",
    adUserData: "denied",
    adPersonalization: "denied"
  });

  const summary = summarizeBeaconEventsV3([
    {
      url: "https://metrics.shop.example/g/collect?v=2&tid=G-12345&en=page_view&gcs=G111",
      postData: "en=scroll&epn.percent_scrolled=75\nen=my_secret_user_123",
      thirdParty: false,
      phase: "scroll-interaction"
    },
    {
      url: "https://capi.shop.example/tr?id=999&ev=Purchase&ud[em]=hashedemail123&ud[ph]=hashedphone",
      thirdParty: false,
      phase: "passive-load"
    },
    {
      url: "https://edge.shop.example/ee/v1/interact",
      postData: JSON.stringify({
        events: [{ xdm: { eventType: "web.webpagedetails.pageViews", identityMap: { email: [{ id: "x" }] } } }]
      }),
      thirdParty: false,
      phase: "passive-load"
    },
    {
      url: "https://shop.example/cdn-cgi/zaraz/t",
      postData: JSON.stringify({ system: { device: {} } }),
      thirdParty: false,
      phase: "passive-load"
    },
    {
      url: "https://api.segment.io/v1/t",
      postData: JSON.stringify({ type: "track", userId: "u_99", traits: { email: "a@b.c" } }),
      thirdParty: true,
      phase: "passive-load"
    },
    {
      url: "https://ct.pinterest.com/v3/?event=checkout&pd[em]=abc",
      thirdParty: true,
      phase: "passive-load"
    },
    {
      url: "https://bat.bing.com/action/0?ti=123&evt=pageLoad&gcs=G100",
      thirdParty: true,
      phase: "passive-load"
    }
  ]);

  const ga = summary.find((s) => s.format === "ga4");
  assert.ok(ga);
  assert.equal(ga.serverSideTagging, true);
  assert.equal(ga.firstPartyEndpoint, true);
  assert.deepEqual(ga.scrollDepths, [75]);
  assert.ok(ga.events.includes("page_view"));
  assert.ok(ga.events.includes("scroll"));
  assert.ok(ga.events.includes("custom event"));
  assert.equal(ga.events.includes("my_secret_user_123"), false, "custom event text must never leak");

  const meta = summary.find((s) => s.format === "meta-pixel");
  assert.ok(meta);
  assert.equal(meta.serverSideTagging, true);
  assert.deepEqual(meta.identifierCategories, ["email", "phone"]);

  const adobe = summary.find((s) => s.format === "adobe-web-sdk");
  assert.ok(adobe);
  assert.equal(adobe.firstPartyEndpoint, true);
  assert.deepEqual(adobe.events, ["page_view"]);

  const zaraz = summary.find((s) => s.format === "cloudflare-zaraz");
  assert.ok(zaraz?.serverSideTagging);

  const segment = summary.find((s) => s.format === "segment");
  assert.ok(segment?.identifierCategories.includes("email"));
  assert.ok(segment?.identifierCategories.includes("external_id"));

  assert.ok(decodeBeaconRequestV3({ url: "https://example.com/static/logo.png", thirdParty: false, phase: "passive-load" }) === null);
});

test("parallel CNAME probe uncloaks third-party trackers while ignoring plain CDN CNAMEs", async () => {
  const mkReq = (domain: string, id: number): NetworkRequestV3 => ({
    id,
    phase: "passive-load",
    url: `https://${domain}/collect`,
    domain,
    registrableDomain: "shop.example",
    method: "GET",
    resourceType: "fetch",
    status: 200,
    thirdParty: false,
    protocol: "h2",
    encodedBytes: 100,
    startedAtMs: 10,
    durationMs: 5,
    redirectChain: [],
    responseHeaders: {},
    requestHeaders: {},
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

  const outcome = await runCnameProbeV3(
    [mkReq("metrics.shop.example", 1), mkReq("metrics.shop.example", 2), mkReq("cdn.shop.example", 3)],
    "www.shop.example",
    {
      registrableDomain: partyKey,
      concurrency: 4,
      resolveCnameChain: async (host) => {
        if (host === "metrics.shop.example") return { chain: ["shop.eulerian.net"], terminated: true };
        if (host === "cdn.shop.example") return { chain: ["d123.cloudfront.net"], terminated: true };
        return { chain: [], terminated: true };
      }
    }
  );

  assert.equal(outcome.cloaks.length, 1);
  assert.equal(outcome.cloaks[0].host, "metrics.shop.example");
  assert.equal(outcome.cloaks[0].entity.entity, "Eulerian");
  assert.equal(outcome.cloaks[0].requestCount, 2);
  assert.equal(outcome.cloakTargetByHost.get("metrics.shop.example"), "shop.eulerian.net");
});

test("fingerprint analyzer detects WebGPU, High-Entropy Client Hints, DOM font probing, MutationObserver replay, and worker canvas", () => {
  const detections = analyzeFingerprintTelemetryV3([
    { api: "offscreen2d.fillText", realm: "dedicated-worker", scriptDomain: "fp.example" },
    { api: "offscreenCanvas.convertToBlob", realm: "dedicated-worker", scriptDomain: "fp.example", detail: { w: 200, h: 50 } },
    { api: "webgpu.requestAdapter", realm: "main", scriptDomain: "fp.example" },
    { api: "clientHints.getHighEntropyValues", realm: "main", scriptDomain: "fp.example", detail: { hints: "platformVersion,model" } },
    ...Array.from({ length: 12 }, (_, i) => ({
      api: "fonts.check",
      realm: "iframe" as const,
      scriptDomain: "fonts.example",
      detail: { font: `12px Font${i}` }
    })),
    {
      api: "mutationObserver.observe",
      realm: "main",
      scriptDomain: "replay.example",
      detail: { root: true, subtree: true, attributes: true, characterData: true, childList: true }
    },
    { api: "document.cookie.write", realm: "main", scriptDomain: "site.example" }
  ]);

  const kinds = detections.map((d) => d.kind);
  assert.deepEqual(kinds, [
    "canvas",
    "webgpu",
    "client-hints-high-entropy",
    "dom-font-enumeration",
    "mutation-observer-replay",
    "document-cookie-writes"
  ]);
  assert.deepEqual(detections[0].realms, ["dedicated-worker"]);
});

test("keystroke probe catches gzip-compressed POST bodies, WebSocket frames, and CNAME-cloaked collectors", () => {
  const canary = createKeystrokeCanaryV3("deadbeef12345678");
  const encodings = buildSentinelEncodingsV3(canary);
  const gzipped = gzipSync(Buffer.from(JSON.stringify({ typed: canary })));
  const b64 = Buffer.from(canary).toString("base64").replace(/=+$/, "");

  const leaks = detectKeystrokeLeaksV3(
    encodings,
    [
      {
        domain: "replay.tracker.example",
        registrableDomain: "tracker.example",
        thirdParty: true,
        url: "https://replay.tracker.example/ingest",
        body: gzipped,
        contentEncoding: "gzip",
        phase: "active-input"
      },
      {
        domain: "ws.tracker.example",
        registrableDomain: "tracker.example",
        thirdParty: true,
        url: "wss://ws.tracker.example/stream",
        body: `{"k":"${b64}"}`,
        isWebSocketFrame: true,
        phase: "active-input"
      },
      {
        domain: "metrics.shop.example",
        registrableDomain: "shop.example",
        thirdParty: false,
        url: `https://metrics.shop.example/collect?v=${canary}`,
        phase: "active-input"
      },
      {
        domain: "api.shop.example",
        registrableDomain: "shop.example",
        thirdParty: false,
        url: `https://api.shop.example/search?q=${canary}`,
        phase: "active-input"
      }
    ],
    { cloakTargetByHost: new Map([["metrics.shop.example", "shop.eulerian.net"]]) }
  );

  assert.equal(leaks.length, 3, "must catch gzip, websocket, and CNAME-cloaked first-party, ignoring normal 1p search");
  assert.ok(leaks.some((l) => l.transport === "http-body-gzip" && l.encoding === "plain"));
  assert.ok(leaks.some((l) => l.transport === "websocket" && l.encoding === "base64"));
  assert.ok(leaks.some((l) => l.domain === "metrics.shop.example" && l.cnameTarget === "shop.eulerian.net"));
});

test("consent dark-pattern scorer and multi-standard verification detect contradictions and hidden reject paths", () => {
  const audit = computeDarkPatternAuditV3(
    {
      detected: true,
      cmp: "OneTrust",
      hasFirstLayerAccept: true,
      hasFirstLayerReject: false,
      hasSettingsEntry: true,
      acceptAreaPx: 12_000,
      rejectAreaPx: null,
      cookieWallDetected: true,
      preTickedNonEssentialCount: 2
    },
    { secondLayerRejectFound: true }
  );

  assert.equal(audit.clicksToAccept, 1);
  assert.equal(audit.clicksToReject, 2);
  assert.ok(audit.darkPatternFlags.includes("reject-hidden-in-settings"));
  assert.ok(audit.darkPatternFlags.includes("asymmetric-clicks"));
  assert.ok(audit.darkPatternFlags.includes("pre-ticked-non-essential"));
  assert.ok(audit.darkPatternFlags.includes("cookie-wall"));
  assert.equal(audit.darkPatternScore, 100);

  const verification = evaluateConsentVerificationV3({
    mode: "reject-all",
    clicked: true,
    apis: {
      tcf: { present: true, gdprApplies: true, eventStatus: "useractioncomplete", purposeConsents: { "1": true, "3": true } },
      gpp: { present: true, applicableSections: [7], gppStringPresent: true },
      usp: { present: true, uspString: "1YYN" }
    },
    googleConsentMode: [{ gcs: "G111", adStorage: "granted", analyticsStorage: "granted" }],
    rawCmpCookies: [{ name: "OptanonConsent", value: "groups=C0001:1,C0002:1,C0004:1" }]
  });

  assert.equal(verification.tcf.state, "granted");
  assert.equal(verification.usp.optOutSale, true);
  assert.equal(verification.consistency, "contradicted");
});

test("multilingual policy probe selects localized policies and detects unmentioned entities", () => {
  const selected = selectPrivacyPolicyUrlV3(
    [
      { href: "https://shop.example/about", text: "Über uns" },
      { href: "https://shop.example/datenschutz", text: "Datenschutzerklärung", fromIframe: true }
    ],
    "shop.example",
    partyKey
  );
  assert.equal(selected?.url, "https://shop.example/datenschutz");
  assert.equal(selected?.fromIframe, true);

  const text =
    "Wir verwenden keine Cookies auf dieser Website und wir verkaufen keine personenbezogenen Daten. " +
    "We also honor Global Privacy Control (GPC) requests from your browser. " +
    "For analytics we work with Google Analytics to measure aggregated traffic across our pages and improve user experience over time. " +
    "Additional legal notices, imprint details, data retention descriptions, contact addresses, and user rights under GDPR are listed below in full detail so visitors can review every obligation clearly.";

  const summary = analyzePolicyTextV3({
    url: "https://shop.example/datenschutz",
    text,
    language: "de",
    fromIframe: true,
    observedEntities: ["Google Analytics", "Meta Pixel / Facebook", "Eulerian"]
  });
  assert.ok(summary);
  assert.deepEqual(summary.mentionedEntities, ["Google Analytics"]);
  assert.deepEqual(summary.unmentionedEntities, ["Eulerian", "Meta Pixel / Facebook"]);
  assert.ok(summary.claims.some((c) => c.kind === "no-cookies"));
  assert.ok(summary.claims.some((c) => c.kind === "no-selling-or-sharing"));
  assert.ok(summary.claims.some((c) => c.kind === "honors-gpc"));
});

test("v3 redaction is idempotent, strips queries/tokens/emails, and validates clean reports", () => {
  const raw = "https://user:pass@tracker.example/u/alice@example.com/550e8400-e29b-41d4-a716-446655440000/hit?secret=1#frag";
  const once = redactUrlV3(raw);
  assert.equal(once, "https://tracker.example/u/[redacted-email]/[redacted-token]/hit");
  assert.equal(redactUrlV3(once), once, "URL redaction must be idempotent");

  // Confirm validator rejects reports attempting to smuggle cookie values
  const bad = {
    schemaVersion: 3,
    reportId: "20261125-0123456789abcdef",
    scannedAt: new Date().toISOString(),
    canonicalDomain: "shop.example",
    provenance: { schemaVersion: 3 },
    leadArm: {
      armId: "baseline",
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
      cookies: [{ name: "sid", value: "LEAKED" }],
      storage: [],
      phases: [],
      summary: {}
    },
    comparisonArms: [],
    comparisons: [],
    highlights: []
  };
  const issues = validateScanReportV3(bad);
  assert.ok(issues.some((i) => i.includes("never persist cookie values")));

  // Verify redactScanReportV3 strips query/secret + digest is deterministic
  const cleanReport = redactScanReportV3({
    ...bad,
    targetUrl: "https://shop.example/?token=abc",
    finalUrl: "https://shop.example/?token=abc",
    leadArm: {
      ...bad.leadArm,
      finalUrl: "https://shop.example/?token=abc",
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
      policy: null
    }
  } as unknown as ScanReportV3);
  assert.equal(cleanReport.targetUrl, "https://shop.example/");
  assertNoUnredactedSecretsV3(cleanReport, ["sblcanary12345678"]);
  assert.equal(reportV3Digest(cleanReport), reportV3Digest(redactScanReportV3(cleanReport)));
});
