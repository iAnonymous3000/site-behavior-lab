import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AdblockEngineStatus } from "./adblock-engine";
import {
  parseNativeShieldsCliArgs,
  prepareDedicatedProfileDirectory
} from "./native-shields-differential-cli";
import {
  NATIVE_SHIELDS_DIFFERENTIAL_LIMITATIONS,
  buildNativeShieldsDifferentialReceipt,
  nativeShieldsDifferentialReceiptIssues,
  nativeShieldsDifferentialReceiptText,
  nativeShieldsDifferentialStatus,
  parseCdpNetworkRequest,
  parseNativeAdblockEvent,
  type BuildNativeShieldsDifferentialInput,
  type RawNativeAdblockEvent
} from "./native-shields-differential";
import { sha256Hex } from "./sha256";

const NOW = "2026-08-11T12:00:00.000Z";
const SHA = "a".repeat(64);
const COMMIT = "b".repeat(40);

const ACTIVE_ENGINE: AdblockEngineStatus = {
  active: true,
  engine: "loaded",
  version: "adblock-rust-0.13.2",
  engineVersion: "adblock-rust-0.13.2",
  source: "Brave default ad-block lists",
  lists: 31,
  fetchedAt: NOW,
  manifestDigest: "c".repeat(64)
};

test("native Brave event parsing keeps request identity and rejects partial payloads", () => {
  const parsed = parseNativeAdblockEvent(
    {
      requestId: "123.4",
      info: {
        requestUrl: "https://ads.example.net/collect",
        checkedUrl: "https://canonical.example.org/collect",
        sourceHost: "www.example.com",
        resourceType: "XHR",
        aggressive: false,
        blocked: true,
        didMatchImportantRule: true,
        didMatchRule: true,
        didMatchException: false,
        hasMockData: false,
        rewrittenUrl: "https://replacement.example.org/script.js"
      }
    },
    9
  );
  assert.equal(parsed?.requestId, "123.4");
  assert.equal(parsed?.sequence, 9);
  assert.equal(parsed?.rewrittenUrl, "https://replacement.example.org/script.js");

  assert.equal(
    parseNativeAdblockEvent(
      {
        requestId: "123.4",
        info: {
          requestUrl: "https://ads.example.net/collect",
          checkedUrl: "https://ads.example.net/collect",
          sourceHost: "example.com",
          aggressive: false,
          blocked: true
        }
      },
      10
    ),
    null
  );
});

test("CDP request parsing is bounded and preserves redirect correlation identity", () => {
  assert.deepEqual(
    parseCdpNetworkRequest(
      {
        requestId: "77.1",
        documentURL: "https://shop.example.com/",
        frameId: "root",
        type: "Fetch",
        request: { url: "https://api.example.net/v1", method: "POST" }
      },
      3
    ),
    {
      sequence: 3,
      requestId: "77.1",
      url: "https://api.example.net/v1",
      documentUrl: "https://shop.example.com/",
      method: "POST",
      resourceType: "Fetch",
      frameId: "root"
    }
  );
});

test("receipt redacts raw URLs, correlates by request id, and isolates a native CNAME-only block", () => {
  const receipt = buildNativeShieldsDifferentialReceipt(
    fixture({
      engine: {
        checkWithMethod: (url) => url.includes("canonical.example.org")
      }
    })
  );
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.events.length, 1);
  const event = receipt.events[0];
  assert.equal(event.correlated, true);
  assert.equal(event.requestIdDigest.length, 64);
  assert.notEqual(event.requestIdDigest, "123.4");
  assert.equal(event.checkedHostDiffers, true);
  assert.equal(event.local.requestUrlDecision, "would-not-block");
  assert.equal(event.local.checkedUrlDecision, "would-block");
  assert.equal(event.agreement, "native-block-local-canonical-match");
  assert.equal(receipt.coverage.checkedHostDifferences, 1);
  assert.equal(receipt.coverage.localEvaluations, 2);
  const wire = nativeShieldsDifferentialReceiptText(receipt);
  assert.doesNotMatch(wire, /alice|secret|email|123\.4/);
  assert.doesNotMatch(event.requestUrl, /[?#]/);
  assert.match(event.requestUrl, /\{seg\}/);
  assert.deepEqual(receipt.limitations, NATIVE_SHIELDS_DIFFERENTIAL_LIMITATIONS);
  assert.deepEqual(nativeShieldsDifferentialReceiptIssues(JSON.parse(wire)), []);
});

test("native exception stays distinct from absence and from the local boolean verdict", () => {
  const nativeEvent: RawNativeAdblockEvent = {
    ...fixture().nativeEvents[0],
    checkedUrl: fixture().nativeEvents[0].requestUrl,
    blocked: false,
    didMatchImportantRule: false,
    didMatchRule: true,
    didMatchException: true
  };
  const receipt = buildNativeShieldsDifferentialReceipt(
    fixture({
      nativeEvents: [nativeEvent],
      engine: { checkWithMethod: () => true }
    })
  );
  assert.equal(receipt.coverage.nativeExceptionEvents, 1);
  assert.equal(receipt.events[0].agreement, "native-exception-local-would-block");
});

test("zero native events is inconclusive and never interpreted as an allow verdict", () => {
  const receipt = buildNativeShieldsDifferentialReceipt(fixture({ nativeEvents: [] }));
  assert.equal(receipt.status, "inconclusive");
  assert.equal(receipt.coverage.networkRequestRecordsWithoutNativeEvent, 1);
  assert.equal(receipt.events.length, 0);
  assert.ok(receipt.limitations.includes("no-native-event-is-not-an-allow-verdict"));
});

test("receipt status and local engine availability are validator-derived", () => {
  const unavailable = buildNativeShieldsDifferentialReceipt(fixture({ engine: null }));
  assert.equal(unavailable.status, "partial");
  assert.equal(unavailable.simulation.engineLoaded, false);
  assert.equal(unavailable.simulation.engineVersion, null);

  const forged = structuredClone(buildNativeShieldsDifferentialReceipt(fixture()));
  forged.status = "inconclusive";
  assert.ok(
    nativeShieldsDifferentialReceiptIssues(forged).includes(
      "status does not derive from capture coverage"
    )
  );
});

test("an early native block without requestWillBeSent uses the labeled native-host fallback", () => {
  const receipt = buildNativeShieldsDifferentialReceipt(
    fixture({
      networkRequests: [],
      engine: { checkWithMethod: (url) => url.includes("tenant.example.net") }
    })
  );
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.coverage.uncorrelatedNativeEvents, 1);
  assert.equal(receipt.coverage.localEvaluations, 2);
  assert.equal(receipt.events[0].local.sourceUrlBasis, "native-source-host");
  assert.equal(receipt.events[0].local.requestUrlDecision, "would-block");
  assert.equal(receipt.events[0].agreement, "agrees-block");
});

test("a redirect hop sharing a request id never counts as a correlated match", () => {
  // CDP reuses one requestId across every hop, so the id alone cannot say the
  // record is the request Brave checked. The old fallback took an arbitrary
  // hop, marked the event correlated, and compared adblock-rust's verdict on
  // hop B with Brave's on hop A while reporting status "complete".
  const base = fixture();
  const nativeUrl = base.nativeEvents[0].requestUrl;
  const receipt = buildNativeShieldsDifferentialReceipt(
    fixture({
      networkRequests: [
        { ...base.networkRequests[0], sequence: 1, url: "https://tenant.example.net/redirect-hop" },
        { ...base.networkRequests[0], sequence: 2, url: "https://tenant.example.net/second-hop" }
      ],
      // Would block the decoy hops but not the URL Brave actually checked, so
      // borrowing a hop's URL would invent an "agrees-block".
      engine: { checkWithMethod: (url) => url.includes("hop") }
    })
  );
  assert.equal(receipt.events[0].correlated, false);
  assert.equal(receipt.coverage.uncorrelatedNativeEvents, 1);
  assert.equal(receipt.status, "partial");
  assert.notEqual(receipt.events[0].agreement, "agrees-block");
  assert.ok(nativeUrl.includes("/collect/"));
});

test("data Brave flagged as mock can never be reported complete", () => {
  const base = fixture();
  const receipt = buildNativeShieldsDifferentialReceipt(
    fixture({ nativeEvents: [{ ...base.nativeEvents[0], hasMockData: true }] })
  );
  assert.equal(receipt.events[0].native.hasMockData, true);
  assert.equal(receipt.coverage.nativeMockDataEvents, 1);
  assert.equal(receipt.status, "partial");
});

test("an unmapped native resource type declines to evaluate instead of guessing", () => {
  const base = fixture();
  const receipt = buildNativeShieldsDifferentialReceipt(
    fixture({
      networkRequests: [],
      // Not a CDP Network.ResourceType spelling. Mapping it would collapse to
      // "other" and manufacture a disagreement against type-scoped rules.
      nativeEvents: [{ ...base.nativeEvents[0], resourceType: "sub_frame" }],
      engine: { checkWithMethod: () => false }
    })
  );
  assert.equal(receipt.events[0].local.requestTypeMapped, false);
  assert.equal(receipt.events[0].local.requestUrlDecision, "not-evaluated");
  assert.equal(receipt.coverage.unmappedNativeResourceTypes, 1);
  assert.equal(receipt.status, "partial");

  const mapped = buildNativeShieldsDifferentialReceipt(fixture());
  assert.equal(mapped.events[0].local.requestTypeMapped, true);
  assert.equal(mapped.coverage.unmappedNativeResourceTypes, 0);
});

test("a rule match without a block is distinguishable from silence", () => {
  const base = fixture();
  const ruleMatch = buildNativeShieldsDifferentialReceipt(
    fixture({
      nativeEvents: [
        { ...base.nativeEvents[0], blocked: false, didMatchException: false, didMatchRule: true }
      ]
    })
  );
  assert.equal(ruleMatch.events[0].agreement, "native-rule-match-no-block");

  const silent = buildNativeShieldsDifferentialReceipt(
    fixture({
      nativeEvents: [
        {
          ...base.nativeEvents[0],
          blocked: false,
          didMatchException: false,
          didMatchRule: false,
          didMatchImportantRule: false
        }
      ]
    })
  );
  assert.equal(silent.events[0].agreement, "native-event-unclassified");
});

test("the status rule is one function, so builder and validator cannot disagree", () => {
  // The builder validates its own output, so a divergence here would throw
  // away a completed capture rather than fail a test.
  assert.equal(
    nativeShieldsDifferentialStatus({
      nativeEvents: 3,
      uncorrelatedNativeEvents: 0,
      nativeMockDataEvents: 0,
      unmappedNativeResourceTypes: 0,
      droppedNetworkRequestRecords: 0,
      droppedNativeEvents: 0,
      unparsableNetworkRecords: 0,
      unparsableNativeEvents: 0,
      proxyBlockedTargets: 0,
      proxyResourceLimitHit: false,
      navigationCompleted: true,
      engineLoaded: true
    }),
    "complete"
  );
  for (const loss of [
    { uncorrelatedNativeEvents: 1 },
    { nativeMockDataEvents: 1 },
    { unmappedNativeResourceTypes: 1 },
    { unparsableNetworkRecords: 1 },
    { unparsableNativeEvents: 1 },
    { droppedNativeEvents: 1 },
    { proxyResourceLimitHit: true },
    { navigationCompleted: false },
    { engineLoaded: false }
  ]) {
    assert.equal(
      nativeShieldsDifferentialStatus({
        nativeEvents: 3,
        uncorrelatedNativeEvents: 0,
        nativeMockDataEvents: 0,
        unmappedNativeResourceTypes: 0,
        droppedNetworkRequestRecords: 0,
        droppedNativeEvents: 0,
        unparsableNetworkRecords: 0,
        unparsableNativeEvents: 0,
        proxyBlockedTargets: 0,
        proxyResourceLimitHit: false,
        navigationCompleted: true,
        engineLoaded: true,
        ...loss
      }),
      "partial",
      `${JSON.stringify(loss)} must forbid a complete receipt`
    );
  }
});

test("an unparsable payload is not reported as a capacity drop", () => {
  const receipt = buildNativeShieldsDifferentialReceipt(fixture({ unparsableNativeEvents: 4 }));
  assert.equal(receipt.coverage.unparsableNativeEvents, 4);
  assert.equal(receipt.coverage.droppedNativeEvents, 0);
  assert.equal(receipt.status, "partial");
});

test("request id digests are salted per capture and not a hash of the bare id", () => {
  const receipt = buildNativeShieldsDifferentialReceipt(fixture());
  const other = buildNativeShieldsDifferentialReceipt(fixture({ requestIdSalt: "f".repeat(64) }));
  assert.notEqual(receipt.events[0].requestIdDigest, other.events[0].requestIdDigest);
  assert.notEqual(receipt.events[0].requestIdDigest, sha256Hex("123.4"));
  assert.throws(() => buildNativeShieldsDifferentialReceipt(fixture({ requestIdSalt: "short" })), /requestIdSalt/);
});

test("receipt validator rejects query-bearing URL regression", () => {
  const receipt = buildNativeShieldsDifferentialReceipt(fixture());
  const mutated = structuredClone(receipt) as unknown as {
    events: Array<{ requestUrl: string }>;
  };
  mutated.events[0].requestUrl = "https://example.net/collect?secret=raw";
  assert.ok(nativeShieldsDifferentialReceiptIssues(mutated).some((issue) => issue.includes("requestUrl")));
});

test("CLI parsing requires explicit output and keeps capture bounds closed", () => {
  assert.deepEqual(
    parseNativeShieldsCliArgs([
      "--url",
      "https://example.com",
      "--output",
      "/tmp/native.json",
      "--label",
      "brave-nightly",
      "--dwell-ms",
      "2500",
      "--headed"
    ]),
    {
      url: "https://example.com",
      output: "/tmp/native.json",
      bravePath: null,
      executableLabel: "brave-nightly",
      profileDir: null,
      dwellMs: 2500,
      timeoutMs: 30000,
      headless: false
    }
  );
  assert.throws(
    () => parseNativeShieldsCliArgs(["--url", "https://example.com", "--output", "/tmp/x", "--dwell-ms", "30001"]),
    /dwell-ms/
  );
});

test("dedicated profile guard marks new state and refuses existing personal or unowned state", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sbl-native-profile-test-"));
  try {
    const dedicated = path.join(root, "dedicated");
    assert.equal(prepareDedicatedProfileDirectory(dedicated), realpathSync(dedicated));
    assert.ok(existsSync(path.join(dedicated, ".site-behavior-lab-native-shields-profile-v1")));
    writeFileSync(path.join(dedicated, "Local State"), "{}\n");
    assert.equal(prepareDedicatedProfileDirectory(dedicated), realpathSync(dedicated));

    const unmarked = path.join(root, "unmarked");
    mkdirSync(unmarked);
    writeFileSync(path.join(unmarked, "Local State"), "{}\n");
    assert.throws(() => prepareDedicatedProfileDirectory(unmarked), /unmarked existing profile directory/);
    assert.throws(() => prepareDedicatedProfileDirectory(homedir()), /normal or broad profile directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(overrides: Partial<BuildNativeShieldsDifferentialInput> = {}): BuildNativeShieldsDifferentialInput {
  const requestUrl = "https://tenant.example.net/collect/alice?email=secret@example.com";
  return {
    startedAt: NOW,
    finishedAt: NOW,
    requestIdSalt: "e".repeat(64),
    buildCommit: COMMIT,
    requestedUrl: "https://shop.example.com/account/alice?token=secret",
    observedUrl: "https://shop.example.com/account/alice?token=secret",
    navigation: { outcome: "completed", status: 200 },
    browser: {
      executableLabel: "brave-nightly",
      version: "151.1.94.81",
      executableSha256: SHA,
      runtimeBinarySha256: "d".repeat(64),
      runtimeBinaryKind: "macos-framework",
      headless: true
    },
    profile: "playwright-temporary-persistent",
    engineStatus: ACTIVE_ENGINE,
    engine: { checkWithMethod: () => false },
    rootFrameId: "root",
    frames: [{ id: "root", url: "https://shop.example.com/account/alice?token=secret" }],
    networkRequests: [
      {
        sequence: 1,
        requestId: "123.4",
        url: requestUrl,
        documentUrl: "https://shop.example.com/account/alice?token=secret",
        method: "POST",
        resourceType: "XHR",
        frameId: "root"
      }
    ],
    nativeEvents: [
      {
        sequence: 2,
        requestId: "123.4",
        requestUrl,
        checkedUrl: "https://canonical.example.org/collect/alice?email=secret@example.com",
        sourceHost: "shop.example.com",
        resourceType: "XHR",
        aggressive: false,
        blocked: true,
        didMatchImportantRule: false,
        didMatchRule: true,
        didMatchException: false,
        hasMockData: false
      }
    ],
    droppedNetworkRequestRecords: 0,
    droppedNativeEvents: 0,
    unparsableNetworkRecords: 0,
    unparsableNativeEvents: 0,
    proxyBlockedTargets: 0,
    proxyResourceLimitHit: false,
    ...overrides
  };
}
