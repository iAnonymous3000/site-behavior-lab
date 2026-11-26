import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  buildDeveloperRuleBreakdownV3,
  buildInitiatorCausalityTreeV3,
  buildPhaseTimelineV3,
  getCatalogDirectoryV3,
  PARSER_INITIATOR_KEY_V3,
  rootInitiatorDomainV3,
  UNKNOWN_INITIATOR_KEY_V3
} from "./v3/dev-mode";
import type { ScanArmV3, ScanReportV3 } from "./v3/schema";

function makeSampleArm(): ScanArmV3 {
  return {
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
    finalUrl: "https://publisher.example/",
    httpStatus: 200,
    loadOutcome: "ok",
    durationMs: 3200,
    phases: [
      { name: "passive-load", startedAtMs: 0, endedAtMs: 1500, status: "completed" },
      { name: "scroll-interaction", startedAtMs: 1500, endedAtMs: 2500, status: "completed" },
      { name: "active-input", startedAtMs: 2500, endedAtMs: 3200, status: "completed" }
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
    network: [
      {
        id: 1,
        url: "https://publisher.example/",
        domain: "publisher.example",
        registrableDomain: "publisher.example",
        thirdParty: false,
        method: "GET",
        resourceType: "document",
        status: 200,
        protocol: "h2",
        encodedBytes: 4096,
        durationMs: 40,
        redirectChain: [],
        requestHeaders: {},
        responseHeaders: {},
        phase: "passive-load",
        startedAtMs: 0,
        initiator: { type: "parser" },
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
        entity: null
      },
      {
        id: 2,
        url: "https://www.google-analytics.com/g/collect",
        domain: "www.google-analytics.com",
        registrableDomain: "google-analytics.com",
        thirdParty: true,
        method: "POST",
        resourceType: "fetch",
        status: 204,
        protocol: "h2",
        encodedBytes: 0,
        durationMs: 25,
        redirectChain: [],
        requestHeaders: {},
        responseHeaders: {},
        phase: "passive-load",
        startedAtMs: 400,
        initiator: {
          type: "script",
          scriptUrl: "https://www.googletagmanager.com/gtm.js",
          scriptDomain: "www.googletagmanager.com",
          callStack: [
            {
              url: "https://www.googletagmanager.com/gtm.js",
              domain: "www.googletagmanager.com",
              line: 42,
              column: 10
            },
            {
              url: "https://publisher.example/assets/boot.js",
              domain: "publisher.example",
              line: 12,
              column: 4
            }
          ]
        },
        shields: {
          matched: true,
          shouldBlockStandard: true,
          shouldBlockAggressive: true,
          blocked: false,
          rule: "||google-analytics.com/g/collect$third-party",
          list: "EasyPrivacy",
          exception: null,
          redirect: null,
          rewrittenUrl: null,
          important: false
        },
        entity: {
          entity: "Google Analytics",
          parentOrg: "Alphabet",
          category: "analytics",
          region: "US",
          confidence: "curated",
          matchedDomain: "google-analytics.com"
        }
      },
      {
        id: 3,
        url: "https://connect.facebook.net/en_US/fbevents.js",
        domain: "connect.facebook.net",
        registrableDomain: "facebook.net",
        thirdParty: true,
        method: "GET",
        resourceType: "script",
        status: 200,
        protocol: "h2",
        encodedBytes: 12000,
        durationMs: 55,
        redirectChain: [],
        requestHeaders: {},
        responseHeaders: {},
        phase: "scroll-interaction",
        startedAtMs: 1700,
        initiator: {
          type: "script",
          scriptUrl: "https://publisher.example/assets/boot.js",
          scriptDomain: "publisher.example"
        },
        shields: {
          matched: true,
          shouldBlockStandard: true,
          shouldBlockAggressive: true,
          blocked: false,
          rule: "||connect.facebook.net/en_US/fbevents.js",
          list: "EasyPrivacy",
          exception: null,
          redirect: "noopjs",
          rewrittenUrl: null,
          important: false
        },
        entity: {
          entity: "Meta Pixel",
          parentOrg: "Meta",
          category: "advertising",
          region: "US",
          confidence: "curated",
          matchedDomain: "facebook.net"
        }
      }
    ],
    websockets: [],
    serviceWorkers: [],
    cookies: [],
    storage: [],
    beacons: [
      {
        platform: "Google Analytics 4",
        product: "GA4",
        format: "ga4",
        endpointHost: "www.google-analytics.com",
        firstPartyEndpoint: false,
        serverSideTagging: false,
        phases: ["passive-load"],
        events: ["page_view"],
        scrollDepths: [],
        consentModeSignals: [],
        identifierCategories: [],
        requests: 1,
        complete: true
      }
    ],
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
      totalRequests: 3,
      thirdPartyRequests: 2,
      thirdPartyDomains: 2,
      trackingRequests: 2,
      shieldsMatchedRequests: 2,
      shieldsBlockedStandard: 2,
      shieldsBlockedAggressive: 2,
      distinctEntities: 2,
      distinctParentOrgs: 2,
      cookiesTotal: 0,
      thirdPartyCookies: 0,
      longLivedCookies: 0,
      partitionedCookies: 0,
      storageKeysTotal: 0,
      websocketsTotal: 0,
      serviceWorkersTotal: 0,
      beaconPlatforms: 1,
      serverSideTaggingEndpoints: 0,
      cnameCloaksCount: 0,
      fingerprintKindsCount: 0,
      keystrokeLeaksCount: 0,
      darkPatternScore: 0,
      topEntities: []
    }
  };
}

test("buildInitiatorCausalityTreeV3 attributes downstream trackers to their originating first-party script", () => {
  const tree = buildInitiatorCausalityTreeV3(makeSampleArm());
  assert.equal(tree.length, 1);
  assert.equal(tree[0].scriptDomain, "publisher.example");
  assert.equal(tree[0].isFirstPartyScript, true);
  assert.equal(tree[0].line, 12);
  assert.equal(tree[0].totalRequests, 2);
  assert.equal(tree[0].distinctEntities, 2);
  assert.deepEqual(
    tree[0].entities.map((e) => e.entity),
    ["Google Analytics", "Meta Pixel"]
  );
});

test("buildPhaseTimelineV3 breaks down first-party, third-party, tracking, and beacon counts per phase", () => {
  const timeline = buildPhaseTimelineV3(makeSampleArm());
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].phase, "passive-load");
  assert.equal(timeline[0].totalRequests, 2);
  assert.equal(timeline[0].thirdPartyRequests, 1);
  assert.equal(timeline[0].trackingRequests, 1);
  assert.equal(timeline[0].beacons, 1);
  assert.equal(timeline[1].phase, "scroll-interaction");
  assert.equal(timeline[1].trackingRequests, 1);
});

test("buildDeveloperRuleBreakdownV3 surfaces exact matched Brave Shields rules, lists, redirects & initiators", () => {
  const rules = buildDeveloperRuleBreakdownV3(makeSampleArm());
  assert.equal(rules.length, 2);
  const fbRule = rules.find((r) => r.rule.includes("fbevents.js"));
  assert.ok(fbRule);
  assert.equal(fbRule.list, "EasyPrivacy");
  assert.equal(fbRule.redirect, "noopjs");
  assert.deepEqual(fbRule.initiatorScripts, ["https://publisher.example/assets/boot.js"]);
});

test("getCatalogDirectoryV3 returns 150+ entities and corporate parent rollups", () => {
  const dir = getCatalogDirectoryV3();
  assert.ok(dir.entries.length >= 150, `expected >= 150 catalog entries, got ${dir.entries.length}`);
  assert.ok(dir.parentOrgs.some((p) => p.parentOrg === "Alphabet"));
  assert.ok(dir.parentOrgs.some((p) => p.parentOrg === "Meta"));
});

test("v3 initiator attribution preserves unknown initiators, reserves parser for explicit parser evidence, and matches BBC seed", () => {
  const arm = makeSampleArm();
  arm.network.push(
    {
      id: 10,
      phase: "passive-load",
      url: "https://static.partner.example/embed.js",
      domain: "static.partner.example",
      registrableDomain: "partner.example",
      method: "GET",
      resourceType: "script",
      status: 200,
      thirdParty: true,
      protocol: "h2",
      encodedBytes: 3000,
      startedAtMs: 50,
      durationMs: 25,
      redirectChain: [],
      requestHeaders: {},
      responseHeaders: {},
      initiator: { type: "parser", callStack: [] },
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
      }
    },
    {
      id: 11,
      phase: "passive-load",
      url: "https://pixel.unknown-src.example/ping",
      domain: "pixel.unknown-src.example",
      registrableDomain: "unknown-src.example",
      method: "GET",
      resourceType: "image",
      status: 200,
      thirdParty: true,
      protocol: "h2",
      encodedBytes: 42,
      startedAtMs: 120,
      durationMs: 15,
      redirectChain: [],
      requestHeaders: {},
      responseHeaders: {},
      initiator: { type: "other", callStack: [] },
      entity: null,
      shields: {
        matched: true,
        shouldBlockStandard: true,
        shouldBlockAggressive: true,
        blocked: false,
        rule: "||pixel.unknown-src.example^",
        list: "EasyPrivacy",
        exception: null,
        redirect: null,
        rewrittenUrl: null,
        important: false
      }
    }
  );

  // 1. Unit cases: known script, explicit parser, and unknown initiator
  const knownReq = arm.network.find((r) => r.id === 2)!;
  const parserReq = arm.network.find((r) => r.id === 10)!;
  const unknownReq = arm.network.find((r) => r.id === 11)!;
  assert.equal(rootInitiatorDomainV3(knownReq), "publisher.example");
  assert.equal(rootInitiatorDomainV3(parserReq), PARSER_INITIATOR_KEY_V3);
  assert.equal(rootInitiatorDomainV3(unknownReq), UNKNOWN_INITIATOR_KEY_V3);

  const tree = buildInitiatorCausalityTreeV3(arm);
  const scriptNode = tree.find((n) => n.scriptDomain === "publisher.example");
  const parserNode = tree.find((n) => n.scriptDomain === PARSER_INITIATOR_KEY_V3);
  const unknownNode = tree.find((n) => n.scriptDomain === UNKNOWN_INITIATOR_KEY_V3);

  assert.ok(scriptNode);
  assert.equal(scriptNode.attribution, "source");
  assert.equal(scriptNode.isFirstPartyScript, true);

  assert.ok(parserNode);
  assert.equal(parserNode.label, "HTML Document Parser");
  assert.equal(parserNode.attribution, "parser");
  assert.equal(parserNode.isFirstPartyScript, true);
  assert.equal(parserNode.totalRequests, 1);

  assert.ok(unknownNode);
  assert.equal(unknownNode.label, "Unknown initiator (no source recorded)");
  assert.equal(unknownNode.attribution, "unknown");
  assert.equal(unknownNode.isFirstPartyScript, false);
  assert.equal(unknownNode.totalRequests, 1);

  // Graph node counts and request filter agree 1:1
  for (const node of tree) {
    const filteredCount = arm.network.filter(
      (r) => r.thirdParty && rootInitiatorDomainV3(r) === node.scriptDomain
    ).length;
    if (node.attribution !== "source") {
      assert.equal(filteredCount, node.totalRequests);
    }
  }

  // Developer rule breakdown does not misattribute unknown initiator to parser
  const devRules = buildDeveloperRuleBreakdownV3(arm);
  const unknownRule = devRules.find((r) => r.rule === "||pixel.unknown-src.example^");
  assert.ok(unknownRule);
  assert.deepEqual(unknownRule.initiatorScripts, ["unknown initiator"]);

  // 2. Verify directly against the committed BBC seed report without rewriting its evidence
  const manifest = JSON.parse(
    readFileSync(path.join(process.cwd(), "public/v3/manifest.json"), "utf8")
  ) as { reports: { canonicalDomain: string; file: string }[] };
  const bbcEntry = manifest.reports.find((r) => r.canonicalDomain === "bbc.com");
  assert.ok(bbcEntry, "committed BBC seed report must exist in public/v3/manifest.json");
  const bbc = JSON.parse(
    readFileSync(path.join(process.cwd(), "public/v3", bbcEntry.file), "utf8")
  ) as ScanReportV3;

  const bbcThirdParty = bbc.leadArm.network.filter((r) => r.thirdParty);
  const bbcOtherNoSource = bbcThirdParty.filter(
    (r) =>
      r.initiator?.type === "other" &&
      !r.initiator?.scriptDomain &&
      (!r.initiator?.callStack || r.initiator.callStack.length === 0)
  );
  assert.equal(bbcOtherNoSource.length, 49, "BBC seed carries 49 third-party type=other requests without source");

  const bbcTree = buildInitiatorCausalityTreeV3(bbc.leadArm);
  const bbcParserWithoutSource = bbcTree.find((n) => n.label === "HTML Document Parser");
  assert.equal(
    bbcParserWithoutSource,
    undefined,
    "BBC unattributed type=other requests must never be labeled HTML Document Parser"
  );

  const bbcUnknownNode = bbcTree.find((n) => n.scriptDomain === UNKNOWN_INITIATOR_KEY_V3);
  assert.ok(bbcUnknownNode, "BBC causality graph must preserve an explicit unknown-initiator node");
  assert.equal(bbcUnknownNode.attribution, "unknown");
  assert.equal(bbcUnknownNode.isFirstPartyScript, false);
  assert.equal(bbcUnknownNode.totalRequests, 49);

  // Request filter using rootInitiatorDomainV3 agrees 1:1 with the graph count
  const filteredBbcUnknown = bbcThirdParty.filter((r) => rootInitiatorDomainV3(r) === UNKNOWN_INITIATOR_KEY_V3);
  assert.equal(filteredBbcUnknown.length, bbcUnknownNode.totalRequests);
});
