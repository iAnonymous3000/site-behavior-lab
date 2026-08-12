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
  parseCdpNetworkRequest,
  parseNativeAdblockEvent,
  type BuildNativeShieldsDifferentialInput,
  type RawNativeAdblockEvent
} from "./native-shields-differential";

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
  assert.equal(event.cnameRecheckObserved, true);
  assert.equal(event.local.requestUrlDecision, "would-not-block");
  assert.equal(event.local.checkedUrlDecision, "would-block");
  assert.equal(event.agreement, "native-block-local-canonical-match");
  assert.equal(receipt.coverage.cnameRechecksObserved, 1);
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
    generatedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW,
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
    proxyBlockedTargets: 0,
    proxyResourceLimitHit: false,
    ...overrides
  };
}
