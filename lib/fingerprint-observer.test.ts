import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { isFingerprintDetectionSummary } from "./fingerprint-detection-guard";
import {
  collectFingerprintObservationsWithCoverage,
  fingerprintObserverInitScript
} from "./fingerprint-observer";
import {
  AUDIO_FINGERPRINT_APIS,
  CANVAS_READ_APIS,
  DETECTOR_VERSIONS,
  FINGERPRINT_EVENT_APIS,
  WEBGL_PARAMETERS,
  WEBGL_READ_APIS
} from "./measurement-kernel";
import { isSingleSignalWebglDetection } from "./report-insights";
import type { FingerprintDetectionSummary } from "./types";

// The production API returns observations plus frame-coverage counters; these
// merging tests only assert on the observations half.
async function collectFingerprintObservationsFromFrames(
  frames: Parameters<typeof collectFingerprintObservationsWithCoverage>[0]
) {
  return (await collectFingerprintObservationsWithCoverage(frames)).observations;
}

// A deferred third-party task that first runs a canvas text readback and a
// WebGL renderer-plus-pixel read (neither touches a stack), then registers
// input listeners through whatever addEventListener the page installed.
const PROBE_THEN_REGISTER_SCRIPT =
  "window.probeThenRegister = function probeThenRegister() {" +
  '  const canvas = document.querySelector("#c");' +
  '  canvas.getContext("2d").fillText("abcdefghijklmnop", 0, 16);' +
  "  canvas.toDataURL();" +
  '  const gl = document.querySelector("#g").getContext("webgl");' +
  "  gl.getParameter(37446);" +
  "  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));" +
  '  const field = document.querySelector("#field");' +
  '  ["input","keydown","change","paste"].forEach(type => field.addEventListener(type, () => undefined));' +
  "};";

test("collectFingerprintObservationsFromFrames merges, sorts, and ignores inaccessible frames", async () => {
  const { events } = await collectFingerprintObservationsFromFrames([
    frameWithEvents({
      "canvas.toDataURL": 1,
      "webgl.readPixels": 2
    }),
    frameWithEvents({
      "canvas.toDataURL": 3,
      "audio.createAnalyser": 2
    }),
    {
      evaluate: async () => {
        throw new Error("cross-origin frame unavailable");
      }
    }
  ]);

  assert.deepEqual(events, [
    {
      api: "canvas.toDataURL",
      count: 4
    },
    {
      api: "audio.createAnalyser",
      count: 2
    },
    {
      api: "webgl.readPixels",
      count: 2
    }
  ]);
});

test("collectFingerprintObservationsWithCoverage accepts only validated primitive snapshots", async () => {
  const collection = await collectFingerprintObservationsWithCoverage([
    {
      evaluate: async () =>
        JSON.stringify({
          detections: [],
          events: { "canvas.toDataURL": 2 }
        })
    },
    {
      evaluate: async () => '{"detections":[],"events":{"canvas.toDataURL":"forged"}}'
    },
    {
      evaluate: async () => "{}"
    },
    {
      evaluate: async () => "not json"
    }
  ]);

  assert.deepEqual(collection, {
    observations: {
      detections: [],
      events: [{ api: "canvas.toDataURL", count: 2 }]
    },
    attemptedFrames: 4,
    readableFrames: 1,
    listenerAttributionLostFrames: 0
  });
});

test("collectFingerprintObservationsWithCoverage keeps a listener-bounded frame and rejects contradictory flags", async () => {
  const canvasDetection: FingerprintDetectionSummary = {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis: ["canvas.toDataURL"],
      maxCanvasWidth: 32,
      maxCanvasHeight: 32,
      maxDistinctTextCharacters: 10,
      maxTextWriteCalls: 1
    }
  };
  const collection = await collectFingerprintObservationsWithCoverage([
    {
      evaluate: async () =>
        JSON.stringify({
          detections: [canvasDetection],
          events: { "canvas.toDataURL": 1 },
          listenerAttributionLost: true
        })
    },
    {
      evaluate: async () =>
        JSON.stringify({ detections: [], events: { "canvas.toDataURL": 1 }, listenerAttributionLost: false })
    },
    {
      evaluate: async () =>
        JSON.stringify({ detections: [], events: { "canvas.toDataURL": 1 }, listenerAttributionLost: "true" })
    },
    {
      // A bounded frame never carries a listener summary: the observer
      // withholds both before it sets the flag.
      evaluate: async () =>
        JSON.stringify({
          detections: [
            {
              kind: "input-monitoring",
              heuristic: "input-listener-coverage-v1",
              count: 1,
              evidence: {
                eventTypes: ["input", "keydown"],
                listenerTargets: ["input"],
                thirdPartyOrigins: ["https://recorder.example.net"],
                totalListenerCalls: 4
              }
            }
          ],
          events: { "canvas.toDataURL": 1 },
          listenerAttributionLost: true
        })
    }
  ]);

  assert.deepEqual(collection, {
    observations: {
      detections: [canvasDetection],
      events: [{ api: "canvas.toDataURL", count: 1 }]
    },
    attemptedFrames: 4,
    readableFrames: 1,
    listenerAttributionLostFrames: 1
  });
});

test("fingerprintObserverInitScript survives hostile page prototype poisoning in real Chromium", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({
        body: '<canvas id="source" width="32" height="32"></canvas><input id="field">',
        contentType: "text/html"
      })
    );
    await page.goto("https://example.com/");

    const rawSnapshot = await page.evaluate(() => {
      const canvas = document.querySelector("#source") as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("missing 2d context");
      context.fillText("abcdefghij", 0, 16);
      canvas.toDataURL();

      const poisonedArrayPrototype = Array.prototype as unknown as Record<PropertyKey, unknown>;
      poisonedArrayPrototype.filter = () => [];
      poisonedArrayPrototype.sort = () => [];
      poisonedArrayPrototype.map = () => [];
      poisonedArrayPrototype.every = () => false;
      poisonedArrayPrototype.some = () => false;
      poisonedArrayPrototype.includes = () => false;
      poisonedArrayPrototype.push = () => 0;
      poisonedArrayPrototype[Symbol.iterator] = function* poisonedArrayIterator() {};
      const poisonedStringPrototype = String.prototype as unknown as Record<PropertyKey, unknown>;
      poisonedStringPrototype.endsWith = () => true;
      poisonedStringPrototype.includes = () => true;
      poisonedStringPrototype.match = () => null;
      poisonedStringPrototype.replace = () => "";
      poisonedStringPrototype.split = () => [];
      poisonedStringPrototype.toLowerCase = () => "benign";
      poisonedStringPrototype.trim = () => "";
      poisonedStringPrototype[Symbol.iterator] = function* poisonedStringIterator() {};
      const poisonedRegExpPrototype = RegExp.prototype as unknown as Record<PropertyKey, unknown>;
      poisonedRegExpPrototype.exec = () => null;
      poisonedRegExpPrototype[Symbol.match] = () => null;
      poisonedRegExpPrototype[Symbol.replace] = () => "";
      const poisonedMapPrototype = Map.prototype as unknown as Record<PropertyKey, unknown>;
      poisonedMapPrototype.forEach = () => undefined;
      poisonedMapPrototype.get = () => undefined;
      poisonedMapPrototype.set = () => new Map();
      const poisonedSetPrototype = Set.prototype as unknown as Record<PropertyKey, unknown>;
      poisonedSetPrototype.add = () => new Set();
      poisonedSetPrototype.forEach = () => undefined;
      poisonedSetPrototype.has = () => false;
      Object.defineProperty(Set.prototype, "size", { configurable: true, get: () => 0 });
      Math.abs = () => 0;
      Math.max = () => 0;
      Number.isFinite = () => false;
      Function.prototype.apply = () => {
        throw new Error("poisoned apply");
      };
      Object.defineProperty(URL.prototype, "hostname", { configurable: true, get: () => "example.com" });
      Object.defineProperty(URL.prototype, "origin", { configurable: true, get: () => "https://example.com" });
      Object.defineProperty(URL.prototype, "protocol", { configurable: true, get: () => "https:" });

      Function(
        'function wrappedAddEventListener(){const field = document.querySelector("#field");' +
          'field.addEventListener("input", () => undefined);' +
          'field.addEventListener("keydown", () => undefined);' +
          'field.addEventListener("change", () => undefined);' +
          'field.addEventListener("paste", () => undefined);}wrappedAddEventListener();' +
          "\n//# sourceURL=https://recorder.example.net/recorder.js"
      )();

      const fingerprintWindow = window as Window & {
        __siteBehaviorLabFingerprintSnapshot?: () => unknown;
      };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });

    assert.equal(typeof rawSnapshot, "string");
    const snapshot = JSON.parse(rawSnapshot as string) as {
      detections: FingerprintDetectionSummary[];
      events: Record<string, number>;
    };
    assert.equal(snapshot.events["canvas.toDataURL"], 1);
    assert.deepEqual(
      snapshot.detections.map((detection) => detection.kind),
      ["canvas-fingerprinting", "input-monitoring"]
    );
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript preserves real Chromium evidence across page-controlled snapshot and brand poisoning", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");

    const runCase = async (body: () => unknown) => {
      const page = await context.newPage();
      await page.route("https://example.com/**", (route) =>
        route.fulfill({ body: "<canvas id=source width=32 height=32></canvas>", contentType: "text/html" })
      );
      await page.goto("https://example.com/");
      const raw = await page.evaluate(body);
      await page.close();
      assert.equal(typeof raw, "string");
      return JSON.parse(raw as string) as {
        detections: FingerprintDetectionSummary[];
        events: Record<string, number>;
      };
    };

    const forgedAssign = await runCase(() => {
      const canvas = document.querySelector("#source") as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("missing 2d context");
      context.fillText("abcdefghij", 0, 16);
      canvas.toDataURL();
      Object.assign = () => ({ "canvas.measureText": Number.MAX_SAFE_INTEGER });
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });
    assert.deepEqual(forgedAssign.events, { "canvas.toDataURL": 1 });
    assert.equal(forgedAssign.detections[0]?.kind, "canvas-fingerprinting");

    const poisonedRecords = await runCase(() => {
      Object.defineProperty(Object.prototype, "canvas.toDataURL", { configurable: true, set: () => undefined });
      for (const character of "abcdefghij") {
        Object.defineProperty(Object.prototype, character, { configurable: true, set: () => undefined });
      }
      Object.defineProperty(window, "Set", { configurable: true, value: class PageSet {}, writable: true });
      const canvas = document.querySelector("#source") as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("missing 2d context");
      context.fillText("abcdefghij", 0, 16);
      canvas.toDataURL();
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });
    assert.deepEqual(poisonedRecords.events, { "canvas.toDataURL": 1 });
    assert.equal(poisonedRecords.detections[0]?.kind, "canvas-fingerprinting");

    const replacedConstructor = await runCase(() => {
      const canvas = document.querySelector("#source") as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("missing 2d context");
      Object.defineProperty(window, "HTMLCanvasElement", {
        configurable: true,
        value: class PageCanvas {},
        writable: true
      });
      context.fillText("abcdefghij", 0, 16);
      canvas.toDataURL();
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });
    assert.deepEqual(replacedConstructor.events, { "canvas.toDataURL": 1 });
    assert.equal(replacedConstructor.detections[0]?.kind, "canvas-fingerprinting");
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript keeps qualifying canvas evidence after a real Chromium resize", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({ body: "<canvas id=source width=32 height=32></canvas>", contentType: "text/html" })
    );
    await page.goto("https://example.com/");

    const raw = await page.evaluate(() => {
      const canvas = document.querySelector("#source") as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("missing 2d context");
      context.fillText("abcdefghij", 0, 16);
      canvas.toDataURL();
      canvas.width = 1;
      canvas.height = 1;
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });

    assert.equal(typeof raw, "string");
    const snapshot = JSON.parse(raw as string) as { detections: FingerprintDetectionSummary[] };
    assert.equal(snapshot.detections[0]?.kind, "canvas-fingerprinting");
    assert.equal(snapshot.detections[0]?.evidence.maxCanvasWidth, 32);
    assert.equal(snapshot.detections[0]?.evidence.maxCanvasHeight, 32);
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript uses currentScript or explicit coverage loss when real Chromium stacks are locked", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const externalPage = await context.newPage();
    await externalPage.route("https://example.com/**", (route) =>
      route.fulfill({
        body:
          '<input id="field"><script>Object.defineProperty(Error,"stackTraceLimit",{value:0,writable:false,configurable:false})</script>' +
          '<script src="https://recorder.example.net/recorder.js"></script>',
        contentType: "text/html"
      })
    );
    await externalPage.route("https://recorder.example.net/recorder.js", (route) =>
      route.fulfill({
        body:
          'const field=document.querySelector("#field");' +
          '["input","keydown","change","paste"].forEach(type=>field.addEventListener(type,()=>undefined));',
        contentType: "text/javascript"
      })
    );
    await externalPage.goto("https://example.com/");
    const rawExternal = await externalPage.evaluate(() => {
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });
    assert.equal(typeof rawExternal, "string");
    const externalSnapshot = JSON.parse(rawExternal as string) as { detections: FingerprintDetectionSummary[] };
    assert.equal(externalSnapshot.detections[0]?.kind, "input-monitoring");
    await externalPage.close();

    const unknownPage = await context.newPage();
    await unknownPage.route("https://example.com/**", (route) =>
      route.fulfill({
        body: '<input id="field"><iframe src="https://clean.example.com/frame.html"></iframe>',
        contentType: "text/html"
      })
    );
    await unknownPage.route("https://clean.example.com/**", (route) =>
      route.fulfill({ body: "<!doctype html><title>clean frame</title>", contentType: "text/html" })
    );
    await unknownPage.goto("https://example.com/");
    await unknownPage.evaluate(() => {
      Object.defineProperty(Error, "stackTraceLimit", { value: 0, writable: false, configurable: false });
      Function(
        'const field=document.querySelector("#field");' +
          '["input","keydown","change","paste"].forEach(type=>field.addEventListener(type,()=>undefined));'
      )();
    });
    const coverage = await collectFingerprintObservationsWithCoverage(unknownPage.frames());
    assert.equal(coverage.attemptedFrames, 2);
    assert.equal(coverage.readableFrames, 1);
    assert.deepEqual(coverage.observations, { detections: [], events: [] });

    const oversizedPage = await context.newPage();
    await oversizedPage.route("https://example.com/**", (route) =>
      route.fulfill({ body: '<input id="field">', contentType: "text/html" })
    );
    await oversizedPage.goto("https://example.com/");
    const rawOversized = await oversizedPage.evaluate(() => {
      Object.defineProperty(Error, "stackTraceLimit", {
        configurable: false,
        value: 1_000_000,
        writable: false
      });
      Function(
        'const field=document.querySelector("#field");' +
          '["input","keydown","change","paste"].forEach(type=>field.addEventListener(type,()=>undefined));'
      )();
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });
    assert.equal(rawOversized, null);
    await oversizedPage.close();
  } finally {
    await browser.close();
  }
});

test("stack-reader integrity exits still withhold the whole frame after canvas and WebGL evidence", async () => {
  // Only a saturated capture is scoped to listener attribution. A page that
  // locks the stack reader (stackTraceLimit pinned at an unusable value, or a
  // prepareStackTrace the observer cannot neutralize) has tampered with the
  // instrument itself, so the frame stays unreadable even though its canvas
  // and WebGL counters were recorded before the registration.
  const locks: Record<string, string> = {
    "stackTraceLimit locked at zero":
      'Object.defineProperty(Error,"stackTraceLimit",{value:0,writable:false,configurable:false});',
    "stackTraceLimit locked oversized":
      'Object.defineProperty(Error,"stackTraceLimit",{value:1000000,writable:false,configurable:false});',
    "prepareStackTrace locked":
      'Object.defineProperty(Error,"prepareStackTrace",{value:()=>"https://example.com/forged.js:1:1",writable:false,configurable:false});'
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    for (const [label, lock] of Object.entries(locks)) {
      const page = await context.newPage();
      await page.route("https://example.com/**", (route) =>
        route.fulfill({
          body:
            '<input id="field"><canvas id="c" width="64" height="32"></canvas><canvas id="g" width="32" height="32"></canvas>' +
            `<script>${lock}</script>` +
            '<script src="https://recorder.example.net/recorder.js"></script>' +
            "<script>setTimeout(() => window.probeThenRegister(), 0)</script>",
          contentType: "text/html"
        })
      );
      await page.route("https://recorder.example.net/recorder.js", (route) =>
        route.fulfill({ body: PROBE_THEN_REGISTER_SCRIPT, contentType: "text/javascript" })
      );
      await page.goto("https://example.com/");
      await page.waitForTimeout(50);
      const inPage = await page.evaluate(() => {
        const fingerprintWindow = window as Window & {
          __siteBehaviorLabFingerprintEvents?: Record<string, number>;
          __siteBehaviorLabFingerprintSnapshot?: () => unknown;
        };
        return {
          events: { ...fingerprintWindow.__siteBehaviorLabFingerprintEvents },
          snapshot: fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.()
        };
      });
      assert.equal(inPage.events["canvas.toDataURL"], 1, `${label}: the canvas readback was recorded`);
      assert.equal(
        inPage.events["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
        1,
        `${label}: the WebGL renderer read was recorded`
      );
      assert.equal(inPage.snapshot, null, `${label}: an integrity exit withholds the whole frame`);
      const coverage = await collectFingerprintObservationsWithCoverage(page.frames());
      assert.deepEqual(
        { ...coverage, observations: undefined },
        { observations: undefined, attemptedFrames: 1, readableFrames: 0, listenerAttributionLostFrames: 0 },
        label
      );
      assert.deepEqual(coverage.observations, { detections: [], events: [] }, label);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("first-party addEventListener wrappers do not hide a deferred third-party registrant", async () => {
  // Angular's Zone.js saves the observer-installed method, replaces the
  // prototype, and later calls the saved method from its own first-party
  // wrapper. SpaceX uses this shape. The old guard invalidated the whole frame
  // before reading a healthy stack; merely deleting that guard would instead
  // credit every registration to the first-party wrapper. The bounded stack
  // walk must keep looking and recover the real third-party caller.
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({
        body:
          '<input id="field">' +
          '<script src="https://example.com/zone.js"></script>' +
          '<script src="https://recorder.example.net/recorder.js"></script>' +
          '<script>setTimeout(() => window.registerRecorder(), 0)</script>',
        contentType: "text/html"
      })
    );
    await page.route("https://example.com/zone.js", (route) =>
      route.fulfill({
        body:
          "const observerAdd = EventTarget.prototype.addEventListener;" +
          "EventTarget.prototype.addEventListener = function zoneAdd(...args) {" +
          "  return observerAdd.apply(this, args);" +
          "};",
        contentType: "text/javascript"
      })
    );
    await page.route("https://recorder.example.net/recorder.js", (route) =>
      route.fulfill({
        body:
          "window.registerRecorder = function registerRecorder() {" +
          '  const field = document.querySelector("#field");' +
          '  ["input","keydown","change","paste"].forEach(type => field.addEventListener(type, () => undefined));' +
          "};",
        contentType: "text/javascript"
      })
    );

    await page.goto("https://example.com/");
    await page.waitForTimeout(50);
    const coverage = await collectFingerprintObservationsWithCoverage(page.frames());

    assert.equal(coverage.attemptedFrames, 1);
    assert.equal(coverage.readableFrames, 1);
    assert.equal(coverage.observations.detections[0]?.kind, "input-monitoring");
    assert.deepEqual(
      coverage.observations.detections[0]?.evidence.thirdPartyOrigins,
      ["https://recorder.example.net"]
    );
  } finally {
    await browser.close();
  }
});

// Shared page shape for the depth-bound cases: a first-party wrapper pads the
// synchronous call chain by `padDepth` frames before delegating to the
// observer-installed addEventListener, and a third-party recorder registers
// input listeners in a deferred task (currentScript null, stack-only
// attribution). Only the pad depth varies, unless `withOtherEvidence` adds
// the stack-independent canvas and WebGL probe to the recorder's task and a
// second third-party vendor that registers through the observer's method
// directly, so its chain resolves within the bound.
async function coverageWithPaddedWrapper(padDepth: number, withOtherEvidence = false) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({
        body: withOtherEvidence
          ? '<input id="field"><canvas id="c" width="64" height="32"></canvas><canvas id="g" width="32" height="32"></canvas>' +
            '<script src="https://direct.example.org/direct.js"></script>' +
            '<script src="https://example.com/wrapper.js"></script>' +
            '<script src="https://recorder.example.net/recorder.js"></script>' +
            "<script>setTimeout(() => { window.registerDirect(); window.probeThenRegister(); }, 0)</script>"
          : '<input id="field">' +
            '<script src="https://example.com/wrapper.js"></script>' +
            '<script src="https://recorder.example.net/recorder.js"></script>' +
            '<script>setTimeout(() => window.registerRecorder(), 0)</script>',
        contentType: "text/html"
      })
    );
    await page.route("https://direct.example.org/direct.js", (route) =>
      route.fulfill({
        body:
          "const directAdd = EventTarget.prototype.addEventListener;" +
          "window.registerDirect = function registerDirect() {" +
          '  const field = document.querySelector("#field");' +
          '  ["input","keydown","change","paste"].forEach(type => directAdd.call(field, type, () => undefined));' +
          "};",
        contentType: "text/javascript"
      })
    );
    await page.route("https://example.com/wrapper.js", (route) =>
      route.fulfill({
        body:
          "const observerAdd = EventTarget.prototype.addEventListener;" +
          "function pad(target, args, depth) {" +
          "  if (depth > 0) return pad(target, args, depth - 1);" +
          "  return observerAdd.apply(target, args);" +
          "}" +
          "EventTarget.prototype.addEventListener = function deepAdd(...args) {" +
          `  return pad(this, args, ${padDepth});` +
          "};",
        contentType: "text/javascript"
      })
    );
    await page.route("https://recorder.example.net/recorder.js", (route) =>
      route.fulfill({
        body: withOtherEvidence
          ? PROBE_THEN_REGISTER_SCRIPT
          : "window.registerRecorder = function registerRecorder() {" +
            '  const field = document.querySelector("#field");' +
            '  ["input","keydown","change","paste"].forEach(type => field.addEventListener(type, () => undefined));' +
            "};",
        contentType: "text/javascript"
      })
    );

    await page.goto("https://example.com/");
    await page.waitForTimeout(50);
    return await collectFingerprintObservationsWithCoverage(page.frames());
  } finally {
    await browser.close();
  }
}

test("a first-party wrapper deep in the bounded stack still yields the third-party registrant", async () => {
  // Forty pad frames defeated the previous 32-frame capture: the registrant
  // fell past the truncation point and the frame read clean and complete with
  // zero detections. The raised bound keeps the registrant inside the capture,
  // so this exact page now produces the detection instead of a clean read.
  const coverage = await coverageWithPaddedWrapper(40);
  assert.equal(coverage.attemptedFrames, 1);
  assert.equal(coverage.readableFrames, 1);
  assert.equal(coverage.listenerAttributionLostFrames, 0);
  assert.equal(coverage.observations.detections[0]?.kind, "input-monitoring");
  assert.deepEqual(
    coverage.observations.detections[0]?.evidence.thirdPartyOrigins,
    ["https://recorder.example.net"]
  );
});

test("a wrapper chain deeper than the stack bound records coverage loss instead of a clean read", async () => {
  // One hundred pad frames exceed the observer's raised bound, so the capture
  // saturates with first-party frames and the third-party registrant is
  // structurally invisible. The honest wire outcome is a bounded read: the
  // frame stays readable but is counted as listener-attribution loss, which
  // the scanner records as fingerprint capture loss with a partial detector.
  // A clean complete read here would let any page hide a registrant behind a
  // deep first-party wrapper.
  const coverage = await coverageWithPaddedWrapper(100);
  assert.equal(coverage.attemptedFrames, 1);
  assert.equal(coverage.readableFrames, 1);
  assert.equal(coverage.listenerAttributionLostFrames, 1);
  assert.deepEqual(coverage.observations.detections, []);
});

test("a saturated listener stack keeps the frame's canvas and WebGL evidence and withholds only its listener summaries", async () => {
  // The citi.com and capitalone.com shape: a deep first-party wrapper
  // saturates the stack capture on a listener registration in a frame that
  // also read canvas text back and read the unmasked WebGL renderer. Nulling
  // that frame discarded canvas and WebGL evidence that never depended on
  // stack attribution. The registrant stays unknown, so the frame's
  // listener-coverage summaries are withheld, including the input-monitoring
  // summary a second vendor's resolvable registrations would otherwise earn.
  const coverage = await coverageWithPaddedWrapper(100, true);
  assert.equal(coverage.attemptedFrames, 1);
  assert.equal(coverage.readableFrames, 1);
  assert.equal(coverage.listenerAttributionLostFrames, 1);
  assert.deepEqual(
    coverage.observations.detections.map((detection) => detection.kind),
    ["canvas-fingerprinting", "webgl-fingerprinting"]
  );
  assert.deepEqual(coverage.observations.detections[1]?.evidence, {
    readApis: ["webgl.readPixels"],
    parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
    getParameterCalls: 1,
    readPixelsCalls: 1
  });
  assert.deepEqual(coverage.observations.events, [
    { api: "canvas.toDataURL", count: 1 },
    { api: "webgl.getParameter.UNMASKED_RENDERER_WEBGL", count: 1 },
    { api: "webgl.readPixels", count: 1 }
  ]);

  // The control: at a depth the capture can hold, the same page resolves
  // both vendors and publishes their input-monitoring summary beside the
  // canvas and WebGL detections, so the summary withheld above was real.
  const resolved = await coverageWithPaddedWrapper(40, true);
  assert.equal(resolved.readableFrames, 1);
  assert.equal(resolved.listenerAttributionLostFrames, 0);
  assert.deepEqual(
    resolved.observations.detections.map((detection) => detection.kind),
    ["canvas-fingerprinting", "input-monitoring", "webgl-fingerprinting"]
  );
  const inputMonitoring = resolved.observations.detections.find((detection) => detection.kind === "input-monitoring");
  assert.deepEqual(
    (inputMonitoring?.evidence as { thirdPartyOrigins: string[] }).thirdPartyOrigins,
    ["https://direct.example.org", "https://recorder.example.net"]
  );
});

test("two third-party origins in one registration chain attribute the chain instead of censoring the frame", async () => {
  // The common cross-vendor shape: one vendor registers input listeners
  // through a one-line helper served from a second CDN, deferred via
  // setTimeout so currentScript is null and only the bounded stack remains.
  // Both third-party origins sit in one captured chain. The published claim
  // is chain presence, not sole registrant, so the honest outcome is a
  // readable frame and a detection naming BOTH origins; censoring the whole
  // frame here would turn a benign, attributable page into coverage loss.
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({
        body:
          '<input id="field">' +
          '<script src="https://cdn.helperlib.net/helper.js"></script>' +
          '<script src="https://recorder.example.net/recorder.js"></script>' +
          "<script>setTimeout(() => window.registerRecorder(), 0)</script>",
        contentType: "text/html"
      })
    );
    await page.route("https://cdn.helperlib.net/helper.js", (route) =>
      route.fulfill({
        body: "window.on = function on(el, type, fn) { el.addEventListener(type, fn); };",
        contentType: "text/javascript"
      })
    );
    await page.route("https://recorder.example.net/recorder.js", (route) =>
      route.fulfill({
        body:
          "window.registerRecorder = function registerRecorder() {" +
          '  const field = document.querySelector("#field");' +
          '  ["input","keydown","change","paste"].forEach(type => window.on(field, type, () => undefined));' +
          "};",
        contentType: "text/javascript"
      })
    );

    await page.goto("https://example.com/");
    await page.waitForTimeout(100);
    const coverage = await collectFingerprintObservationsWithCoverage(page.frames());

    assert.equal(coverage.attemptedFrames, 1);
    assert.equal(coverage.readableFrames, 1);
    assert.equal(coverage.observations.detections[0]?.kind, "input-monitoring");
    // Both chain origins, not whichever one the walk met first: crediting a
    // single origin either accuses the helper CDN alone or hides it entirely.
    assert.deepEqual(
      coverage.observations.detections[0]?.evidence.thirdPartyOrigins,
      ["https://cdn.helperlib.net", "https://recorder.example.net"]
    );
    // Four registration calls, each with a two-origin chain: the published
    // count stays a count of addEventListener CALLS, never of chain origins.
    const evidence = coverage.observations.detections[0]?.evidence as { totalListenerCalls: number };
    assert.equal(evidence.totalListenerCalls, 4);
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript coerces DOMString inputs once in real Chromium", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({
        body: '<canvas id="canvas" width="32" height="32"></canvas><input id="field">',
        contentType: "text/html"
      })
    );
    await page.goto("https://example.com/");

    const result = await page.evaluate(() => {
      const coercionProbe = (text: string) => {
        let calls = 0;
        return {
          calls: () => calls,
          value: {
            [Symbol.toPrimitive]() {
              calls += 1;
              if (calls > 1) throw new Error("DOMString input was coerced more than once");
              return text;
            }
          }
        };
      };

      const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
      const context2d = canvas.getContext("2d");
      if (!context2d) throw new Error("missing 2d context");
      const fillProbe = coercionProbe("abcdefghij");
      context2d.fillText(fillProbe.value as unknown as string, 0, 16);

      const measureCalls: number[] = [];
      const fonts = ["16px Arial", "17px Arial", "18px Arial", "19px Arial"];
      for (let index = 0; index < 8; index += 1) {
        context2d.font = fonts[index % fonts.length];
        const measureProbe = coercionProbe(`sample-${index}`);
        context2d.measureText(measureProbe.value as unknown as string);
        measureCalls.push(measureProbe.calls());
      }
      canvas.toDataURL();

      const eventCalls = Function(`
        const field = document.querySelector("#field");
        const counts = [];
        for (const type of ["input", "keydown", "change", "paste"]) {
          let calls = 0;
          const value = {
            [Symbol.toPrimitive]() {
              calls += 1;
              if (calls > 1) throw new Error("event type was coerced more than once");
              return type;
            }
          };
          field.addEventListener(value, () => undefined);
          counts.push(calls);
        }
        return counts;
        //# sourceURL=https://recorder.example.net/coercion.js
      `)() as number[];

      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return {
        eventCalls,
        fillCalls: fillProbe.calls(),
        measureCalls,
        raw: fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.()
      };
    });

    assert.equal(result.fillCalls, 1);
    assert.deepEqual(result.measureCalls, Array(8).fill(1));
    assert.deepEqual(result.eventCalls, Array(4).fill(1));
    assert.equal(typeof result.raw, "string");
    const snapshot = JSON.parse(result.raw as string) as { detections: FingerprintDetectionSummary[] };
    assert.deepEqual(
      snapshot.detections.map((detection) => detection.kind),
      ["canvas-fingerprinting", "canvas-font-fingerprinting", "input-monitoring"]
    );
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript converts no text argument for a receiver the native method rejects in real Chromium", async () => {
  // A native text or measure method checks its receiver before it converts
  // any argument. The observer converts the text once itself, so it must hand
  // a receiver its family's canvas getter rejects straight to the native
  // call, or a page's toString would run where it never runs unobserved.
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({ body: "<!doctype html><title>receivers</title>", contentType: "text/html" })
    );
    await page.goto("https://example.com/");

    const conversions = await page.evaluate(() => {
      const pageContext = document.createElement("canvas").getContext("2d");
      const offscreenContext = new OffscreenCanvas(32, 32).getContext("2d");
      if (!pageContext || !offscreenContext) throw new Error("missing 2d context");
      const counts: Record<string, number> = {};
      const calls: Record<string, [(...args: unknown[]) => unknown, unknown, number]> = {
        "fillText on a plain object": [CanvasRenderingContext2D.prototype.fillText as never, {}, 3],
        "strokeText on an offscreen context": [CanvasRenderingContext2D.prototype.strokeText as never, offscreenContext, 3],
        "measureText on an offscreen context": [CanvasRenderingContext2D.prototype.measureText as never, offscreenContext, 1],
        "offscreen fillText on a page context": [OffscreenCanvasRenderingContext2D.prototype.fillText as never, pageContext, 3],
        "offscreen strokeText on a plain object": [OffscreenCanvasRenderingContext2D.prototype.strokeText as never, {}, 3],
        "offscreen measureText on a page context": [OffscreenCanvasRenderingContext2D.prototype.measureText as never, pageContext, 1]
      };
      for (const [name, [method, receiver, arity]] of Object.entries(calls)) {
        counts[name] = 0;
        const text = {
          toString() {
            counts[name] += 1;
            return "abcdefghij";
          }
        };
        try {
          Reflect.apply(method, receiver, [text, 0, 16].slice(0, arity));
        } catch {
          /* expected native illegal-invocation error */
        }
      }
      return counts;
    });
    for (const [name, count] of Object.entries(conversions)) assert.equal(count, 0, name);
    assert.equal(Object.keys(conversions).length, 6);
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript records only native-successful calls in real Chromium", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({ body: '<canvas id="canvas"></canvas>', contentType: "text/html" })
    );
    await page.goto("https://example.com/");

    const raw = await page.evaluate(() => {
      const attempt = (callback: () => unknown) => {
        try {
          callback();
        } catch {
          /* expected native illegal-invocation error */
        }
      };
      attempt(() => HTMLCanvasElement.prototype.toDataURL.call({}));
      attempt(() => CanvasRenderingContext2D.prototype.fillText.call({}, "abcdefghij", 0, 0));
      attempt(() => CanvasRenderingContext2D.prototype.measureText.call({}, "abcdefghij"));
      attempt(() => EventTarget.prototype.addEventListener.call({}, "input", () => undefined));

      const canvas = document.querySelector("#canvas") as HTMLCanvasElement;
      const gl = canvas.getContext("webgl");
      if (gl) {
        attempt(() => gl.getParameter.call({}, 37446));
        attempt(() => gl.readPixels.call({}, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)));
      }
      if ("OfflineAudioContext" in window) {
        attempt(() => OfflineAudioContext.prototype.startRendering.call({}));
      }
      if ("RTCPeerConnection" in window) {
        attempt(() =>
          (RTCPeerConnection.prototype.createOffer as unknown as (this: unknown) => unknown).call({})
        );
      }

      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });

    assert.equal(typeof raw, "string");
    assert.deepEqual(JSON.parse(raw as string), { detections: [], events: {} });
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript fails a real Chromium frame closed when canvas tracking reaches its cap", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({ body: "<!doctype html><title>bounded observer</title>", contentType: "text/html" })
    );
    await page.goto("https://example.com/");

    const raw = await page.evaluate(() => {
      for (let index = 0; index <= 256; index += 1) {
        const canvas = document.createElement("canvas");
        canvas.getContext("2d")?.fillText("abcdefghij", 0, 16);
      }
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });
    assert.equal(raw, null);
    const coverage = await collectFingerprintObservationsWithCoverage(page.frames());
    assert.equal(coverage.attemptedFrames, 1);
    assert.equal(coverage.readableFrames, 0);
  } finally {
    await browser.close();
  }
});

type ObserverSnapshot = {
  detections: FingerprintDetectionSummary[];
  events: Record<string, number>;
};

// Thirty distinct characters, the shape a canvas fingerprinting script draws.
const OFFSCREEN_PROBE_TEXT = "abcdefghijklmnopqrstuvwxyz0123";

async function withObservedPages(run: (runCase: (body: () => unknown) => Promise<unknown>) => Promise<void>) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    await run(async (body) => {
      const page = await context.newPage();
      await page.route("https://example.com/**", (route) =>
        route.fulfill({ body: "<!doctype html><title>offscreen canvas</title>", contentType: "text/html" })
      );
      await page.goto("https://example.com/");
      const raw = await page.evaluate(body);
      await page.close();
      return raw;
    });
  } finally {
    await browser.close();
  }
}

// v1 redaction generalizes, and the r2 builder refuses, any token outside the
// kernel vocabulary, and neither runs inside a scan. Holding the tokens a real
// observer emits to that vocabulary here ties the two halves together, rather
// than two hand-typed copies of each token agreeing by construction.
function assertKernelVocabulary(snapshot: ObserverSnapshot) {
  const within = (values: readonly string[], vocabulary: readonly string[], label: string) => {
    for (const value of values) assert.ok(vocabulary.includes(value), `${value} is not in ${label}`);
  };
  within(Object.keys(snapshot.events), FINGERPRINT_EVENT_APIS, "FINGERPRINT_EVENT_APIS");
  for (const detection of snapshot.detections) {
    if (detection.kind === "canvas-fingerprinting") {
      within(detection.evidence.readApis, CANVAS_READ_APIS, "CANVAS_READ_APIS");
    } else if (detection.kind === "webgl-fingerprinting") {
      within(detection.evidence.readApis, WEBGL_READ_APIS, "WEBGL_READ_APIS");
      within(detection.evidence.parameters, WEBGL_PARAMETERS, "WEBGL_PARAMETERS");
    } else if (detection.kind === "audio-fingerprinting") {
      within(detection.evidence.apis, AUDIO_FINGERPRINT_APIS, "AUDIO_FINGERPRINT_APIS");
    }
  }
}

function parseObserverSnapshot(raw: unknown): ObserverSnapshot {
  assert.equal(typeof raw, "string");
  const snapshot = JSON.parse(raw as string) as ObserverSnapshot;
  assertKernelVocabulary(snapshot);
  return snapshot;
}

test("fingerprintObserverInitScript flags canvas readback on an OffscreenCanvas 2D context in real Chromium", async () => {
  await withObservedPages(async (runCase) => {
    const readBack = parseObserverSnapshot(
      await runCase(async () => {
        const canvas = new OffscreenCanvas(200, 60);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        context.getImageData(0, 0, 200, 60);
        await canvas.convertToBlob();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.deepEqual(readBack.events, { "canvas.convertToBlob": 1, "canvas.getImageData": 1 });
    assert.deepEqual(readBack.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 1,
        evidence: {
          readApis: ["canvas.convertToBlob", "canvas.getImageData"],
          maxCanvasWidth: 200,
          maxCanvasHeight: 60,
          maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
          maxTextWriteCalls: 1
        }
      }
    ]);

    // An export alone is a read, sized as the canvas was at the call: the
    // blob encodes that bitmap, whatever the page resizes it to before the
    // promise settles.
    const exportedThenResized = parseObserverSnapshot(
      await runCase(async () => {
        const canvas = new OffscreenCanvas(200, 60);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const pending = canvas.convertToBlob();
        canvas.width = 1;
        canvas.height = 1;
        await pending;
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.deepEqual(exportedThenResized.events, { "canvas.convertToBlob": 1 });
    assert.deepEqual(exportedThenResized.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 1,
        evidence: {
          readApis: ["canvas.convertToBlob"],
          maxCanvasWidth: 200,
          maxCanvasHeight: 60,
          maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
          maxTextWriteCalls: 1
        }
      }
    ]);
  });
});

test("fingerprintObserverInitScript carries OffscreenCanvas text provenance into a page canvas readback in real Chromium", async () => {
  const pageCanvasReadback = {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis: ["canvas.toDataURL"],
      maxCanvasWidth: 200,
      maxCanvasHeight: 60,
      maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
      maxTextWriteCalls: 1
    }
  };

  await withObservedPages(async (runCase) => {
    const cases: Record<string, () => unknown> = {
      drawImage: () => {
        const offscreen = new OffscreenCanvas(200, 60);
        offscreen.getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 60;
        canvas.getContext("2d")?.drawImage(offscreen, 0, 0);
        canvas.toDataURL();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      transferToImageBitmap: () => {
        const offscreen = new OffscreenCanvas(200, 60);
        offscreen.getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const bitmap = offscreen.transferToImageBitmap();
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 60;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        canvas.toDataURL();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      createImageBitmap: async () => {
        const offscreen = new OffscreenCanvas(200, 60);
        offscreen.getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const bitmap = await createImageBitmap(offscreen);
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 60;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        canvas.toDataURL();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      }
    };

    for (const [route, body] of Object.entries(cases)) {
      const snapshot = parseObserverSnapshot(await runCase(body));
      assert.deepEqual(snapshot.events, { "canvas.toDataURL": 1 }, route);
      assert.deepEqual(snapshot.detections, [pageCanvasReadback], route);
    }
  });
});

test("fingerprintObserverInitScript reads a transferControlToOffscreen placeholder as its OffscreenCanvas in real Chromium", async () => {
  // A page canvas whose control the page transferred to an OffscreenCanvas
  // shows what that OffscreenCanvas draws, in the page with no worker
  // involved. Reading the placeholder, or drawing it into another canvas,
  // reads that text, and the detection counts the one canvas read, not the
  // offscreen canvas as well.
  const readback = (readApis: string[]) => ({
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis,
      maxCanvasWidth: 200,
      maxCanvasHeight: 60,
      maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
      maxTextWriteCalls: 1
    }
  });
  const cases: Record<string, { body: () => unknown; events: Record<string, number>; readApis: string[] }> = {
    toDataURL: {
      body: async () => {
        const placeholder = document.createElement("canvas");
        placeholder.width = 200;
        placeholder.height = 60;
        document.body.append(placeholder);
        placeholder.transferControlToOffscreen().getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        placeholder.toDataURL();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.toDataURL": 1 },
      readApis: ["canvas.toDataURL"]
    },
    toBlob: {
      body: async () => {
        const placeholder = document.createElement("canvas");
        placeholder.width = 200;
        placeholder.height = 60;
        document.body.append(placeholder);
        placeholder.transferControlToOffscreen().getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise((resolve) => placeholder.toBlob(resolve));
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.toBlob": 1 },
      readApis: ["canvas.toBlob"]
    },
    drawImage: {
      body: async () => {
        const placeholder = document.createElement("canvas");
        placeholder.width = 200;
        placeholder.height = 60;
        document.body.append(placeholder);
        placeholder.transferControlToOffscreen().getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const reader = document.createElement("canvas");
        reader.width = 200;
        reader.height = 60;
        const context = reader.getContext("2d");
        context?.drawImage(placeholder, 0, 0);
        context?.getImageData(0, 0, 200, 60);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.getImageData": 1 },
      readApis: ["canvas.getImageData"]
    },
    createImageBitmap: {
      body: async () => {
        const placeholder = document.createElement("canvas");
        placeholder.width = 200;
        placeholder.height = 60;
        document.body.append(placeholder);
        placeholder.transferControlToOffscreen().getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bitmap = await createImageBitmap(placeholder);
        const reader = document.createElement("canvas");
        reader.width = 200;
        reader.height = 60;
        reader.getContext("2d")?.drawImage(bitmap, 0, 0);
        reader.toDataURL();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.toDataURL": 1 },
      readApis: ["canvas.toDataURL"]
    }
  };

  await withObservedPages(async (runCase) => {
    for (const [route, { body, events, readApis }] of Object.entries(cases)) {
      const snapshot = parseObserverSnapshot(await runCase(body));
      assert.deepEqual(snapshot.events, events, route);
      assert.deepEqual(snapshot.detections, [readback(readApis)], route);
    }
  });
});

test("fingerprintObserverInitScript flags canvas font probing on an OffscreenCanvas in real Chromium", async () => {
  await withObservedPages(async (runCase) => {
    const snapshot = parseObserverSnapshot(
      await runCase(() => {
        const context = new OffscreenCanvas(200, 60).getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        const families = ["Arial", "Verdana", "Georgia", "Tahoma", "Courier", "Impact", "Garamond", "Palatino", "Helvetica", "Futura"];
        for (let index = 0; index < families.length; index += 1) {
          context.font = `16px ${families[index]}`;
          context.measureText("mmmmmmmmmmlli");
        }
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.deepEqual(snapshot.events, { "canvas.measureText": 10 });
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-font-fingerprinting",
        heuristic: "canvas-font-probing-v1",
        count: 1,
        evidence: {
          measureTextCalls: 10,
          maxDistinctFonts: 10,
          maxDistinctTextSamples: 1,
          maxTextLength: 13
        }
      }
    ]);
  });
});

test("fingerprintObserverInitScript holds OffscreenCanvas to the page canvas thresholds and native-success rule in real Chromium", async () => {
  await withObservedPages(async (runCase) => {
    // Below the 16 by 16 readback rule: the call is counted, never a match.
    const smallRead = parseObserverSnapshot(
      await runCase(() => {
        const context = new OffscreenCanvas(200, 60).getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        context.getImageData(0, 0, 8, 8);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.deepEqual(smallRead, { detections: [], events: { "canvas.getImageData": 1 } });

    // Three measurements in one font: counted, below the font-probing rule.
    const oneFont = parseObserverSnapshot(
      await runCase(() => {
        const context = new OffscreenCanvas(200, 60).getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        context.font = "16px Arial";
        context.measureText("label one");
        context.measureText("label two");
        context.measureText("label three");
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.deepEqual(oneFont, { detections: [], events: { "canvas.measureText": 3 } });

    // Rejected exports (a zero-size canvas, a canvas with no rendering
    // context) and illegal invocations record nothing; the one fulfilled
    // export beside them is the only event.
    const failedCalls = parseObserverSnapshot(
      await runCase(async () => {
        const settle = async (callback: () => unknown) => {
          try {
            await callback();
          } catch {
            /* expected native rejection or illegal-invocation error */
          }
        };
        await settle(() => new OffscreenCanvas(0, 0).convertToBlob());
        await settle(() => new OffscreenCanvas(32, 32).convertToBlob());
        await settle(() => OffscreenCanvas.prototype.convertToBlob.call({}));
        await settle(() => OffscreenCanvas.prototype.transferToImageBitmap.call({}));
        await settle(() => OffscreenCanvasRenderingContext2D.prototype.getImageData.call({}, 0, 0, 32, 32));
        await settle(() => OffscreenCanvasRenderingContext2D.prototype.fillText.call({}, "abcdefghij", 0, 0));
        await settle(() => OffscreenCanvasRenderingContext2D.prototype.measureText.call({}, "abcdefghij"));
        const exported = new OffscreenCanvas(32, 32);
        exported.getContext("2d");
        await exported.convertToBlob();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.deepEqual(failedCalls, { detections: [], events: { "canvas.convertToBlob": 1 } });
  });
});

test("fingerprintObserverInitScript keeps OffscreenCanvas WebGL evidence unchanged beside offscreen 2D evidence in real Chromium", async () => {
  await withObservedPages(async (runCase) => {
    const snapshot = parseObserverSnapshot(
      await runCase(() => {
        const gl = new OffscreenCanvas(32, 32).getContext("webgl");
        if (!gl) throw new Error("missing offscreen webgl context");
        gl.getParameter(37446);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        const context = new OffscreenCanvas(200, 60).getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        context.getImageData(0, 0, 200, 60);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    // The WebGL half is what the observer recorded before OffscreenCanvas 2D
    // was instrumented: it shares the WebGL prototype the observer wraps.
    assert.deepEqual(snapshot.events, {
      "canvas.getImageData": 1,
      "webgl.getParameter.UNMASKED_RENDERER_WEBGL": 1,
      "webgl.readPixels": 1
    });
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 1,
        evidence: {
          readApis: ["canvas.getImageData"],
          maxCanvasWidth: 200,
          maxCanvasHeight: 60,
          maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
          maxTextWriteCalls: 1
        }
      },
      {
        kind: "webgl-fingerprinting",
        heuristic: "webgl-entropy-read-v1",
        count: 1,
        evidence: {
          readApis: ["webgl.readPixels"],
          parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
          getParameterCalls: 1,
          readPixelsCalls: 1
        }
      }
    ]);
  });
});

test("fingerprintObserverInitScript keeps OffscreenCanvas evidence when the page replaces its prototypes after init in real Chromium", async () => {
  await withObservedPages(async (runCase) => {
    const snapshot = parseObserverSnapshot(
      await runCase(async () => {
        const OriginalOffscreenCanvas = OffscreenCanvas;
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        const takeSnapshot = fingerprintWindow.__siteBehaviorLabFingerprintSnapshot;
        if (typeof takeSnapshot !== "function") throw new Error("missing observer snapshot");
        const canvasPrototype = OffscreenCanvas.prototype as unknown as Record<string, unknown>;
        const contextPrototype = OffscreenCanvasRenderingContext2D.prototype as unknown as Record<string, unknown>;
        const apply = Reflect.apply;
        const defineProperty = Object.defineProperty;
        const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
        const delegate = (target: Record<string, unknown>, key: string) => {
          const original = target[key] as (...args: unknown[]) => unknown;
          target[key] = function pageWrapper(this: unknown, ...args: unknown[]) {
            return apply(original, this, args);
          };
        };
        const spoofGetter = (target: object, key: string, value: unknown) => {
          const original = getOwnPropertyDescriptor(target, key);
          defineProperty(target, key, { configurable: true, get: () => value, set: original?.set });
        };

        // Methods the page wraps and delegates, so the observer's wrappers
        // still run beneath them; getters the page spoofs; the constructors
        // the page swaps for its own classes.
        delegate(contextPrototype, "fillText");
        delegate(contextPrototype, "getImageData");
        delegate(contextPrototype, "measureText");
        delegate(contextPrototype, "drawImage");
        delegate(canvasPrototype, "convertToBlob");
        delegate(canvasPrototype, "transferToImageBitmap");
        spoofGetter(contextPrototype, "canvas", null);
        spoofGetter(contextPrototype, "font", "10px sans-serif");
        spoofGetter(canvasPrototype, "width", 1);
        spoofGetter(canvasPrototype, "height", 1);
        defineProperty(window, "OffscreenCanvas", { configurable: true, value: class PageOffscreenCanvas {}, writable: true });
        defineProperty(window, "OffscreenCanvasRenderingContext2D", {
          configurable: true,
          value: class PageOffscreenContext {},
          writable: true
        });

        // The same intrinsic poisoning the page-canvas hostile test applies.
        const poisonedArrayPrototype = Array.prototype as unknown as Record<PropertyKey, unknown>;
        poisonedArrayPrototype.sort = () => [];
        poisonedArrayPrototype.push = () => 0;
        poisonedArrayPrototype[Symbol.iterator] = function* poisonedArrayIterator() {};
        const poisonedStringPrototype = String.prototype as unknown as Record<PropertyKey, unknown>;
        poisonedStringPrototype.trim = () => "";
        poisonedStringPrototype[Symbol.iterator] = function* poisonedStringIterator() {};
        const poisonedMapPrototype = Map.prototype as unknown as Record<PropertyKey, unknown>;
        poisonedMapPrototype.forEach = () => undefined;
        poisonedMapPrototype.get = () => undefined;
        poisonedMapPrototype.set = () => new Map();
        const poisonedSetPrototype = Set.prototype as unknown as Record<PropertyKey, unknown>;
        poisonedSetPrototype.add = () => new Set();
        poisonedSetPrototype.forEach = () => undefined;
        poisonedSetPrototype.has = () => false;
        defineProperty(Set.prototype, "size", { configurable: true, get: () => 0 });
        const poisonedWeakMapPrototype = WeakMap.prototype as unknown as Record<PropertyKey, unknown>;
        poisonedWeakMapPrototype.get = () => undefined;
        poisonedWeakMapPrototype.set = () => new WeakMap();
        Math.max = () => 0;
        Number.isFinite = () => false;
        Object.getOwnPropertyDescriptor = () => undefined;
        Object.prototype.isPrototypeOf = () => false;
        Promise.prototype.then = function poisonedThen(this: Promise<unknown>) {
          return this;
        } as typeof Promise.prototype.then;
        Function.prototype.apply = () => {
          throw new Error("poisoned apply");
        };
        Function.prototype.call = () => {
          throw new Error("poisoned call");
        };

        const readCanvas = new OriginalOffscreenCanvas(200, 60);
        const readContext = readCanvas.getContext("2d");
        if (!readContext) throw new Error("missing offscreen 2d context");
        readContext.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        readContext.getImageData(0, 0, 200, 60);
        await readCanvas.convertToBlob();

        const fontContext = new OriginalOffscreenCanvas(200, 60).getContext("2d");
        if (!fontContext) throw new Error("missing offscreen 2d context");
        const families = ["Arial", "Verdana", "Georgia", "Tahoma", "Courier", "Impact", "Garamond", "Palatino", "Helvetica", "Futura"];
        for (let index = 0; index < families.length; index += 1) {
          fontContext.font = `16px ${families[index]}`;
          fontContext.measureText("mmmmmmmmmmlli");
        }

        const transferCanvas = new OriginalOffscreenCanvas(200, 60);
        transferCanvas.getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const bitmap = transferCanvas.transferToImageBitmap();
        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = 200;
        pageCanvas.height = 60;
        pageCanvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        pageCanvas.toDataURL();

        // Called through the captured Reflect.apply, since the page has
        // poisoned Function.prototype.call.
        return apply(takeSnapshot, fingerprintWindow, []);
      })
    );
    assert.deepEqual(snapshot.events, {
      "canvas.convertToBlob": 1,
      "canvas.getImageData": 1,
      "canvas.measureText": 10,
      "canvas.toDataURL": 1
    });
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 2,
        evidence: {
          readApis: ["canvas.convertToBlob", "canvas.getImageData", "canvas.toDataURL"],
          maxCanvasWidth: 200,
          maxCanvasHeight: 60,
          maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
          maxTextWriteCalls: 1
        }
      },
      {
        kind: "canvas-font-fingerprinting",
        heuristic: "canvas-font-probing-v1",
        count: 1,
        evidence: {
          measureTextCalls: 10,
          maxDistinctFonts: 10,
          maxDistinctTextSamples: 1,
          maxTextLength: 13
        }
      }
    ]);
  });
});

test("fingerprintObserverInitScript resolves re-prototyped canvases and contexts through the native getters in real Chromium", async () => {
  // The brand checks are the native canvas, width and height getters, which
  // read internal slots. A prototype test in their place would lose a canvas
  // or context the page has re-prototyped and then drives through saved
  // methods, and the page gets its results either way.
  const readback = (readApis: string[]) => ({
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis,
      maxCanvasWidth: 200,
      maxCanvasHeight: 60,
      maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
      maxTextWriteCalls: 1
    }
  });
  const fontProbe = {
    kind: "canvas-font-fingerprinting",
    heuristic: "canvas-font-probing-v1",
    count: 1,
    evidence: {
      measureTextCalls: 10,
      maxDistinctFonts: 10,
      maxDistinctTextSamples: 1,
      maxTextLength: 13
    }
  };
  const cases: Record<string, { body: () => unknown; events: Record<string, number>; detections: unknown[] }> = {
    pageContextAfterText: {
      body: () => {
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 60;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("missing 2d context");
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const getImageData = CanvasRenderingContext2D.prototype.getImageData;
        Object.setPrototypeOf(context, Object.prototype);
        Reflect.apply(getImageData, context, [0, 0, 200, 60]);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.getImageData": 1 },
      detections: [readback(["canvas.getImageData"])]
    },
    offscreenContextAfterText: {
      body: () => {
        const context = new OffscreenCanvas(200, 60).getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const getImageData = OffscreenCanvasRenderingContext2D.prototype.getImageData;
        Object.setPrototypeOf(context, Object.prototype);
        Reflect.apply(getImageData, context, [0, 0, 200, 60]);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.getImageData": 1 },
      detections: [readback(["canvas.getImageData"])]
    },
    pageContextSavedText: {
      body: () => {
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 60;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("missing 2d context");
        const { fillText, getImageData } = CanvasRenderingContext2D.prototype;
        Object.setPrototypeOf(context, Object.prototype);
        Reflect.apply(fillText, context, ["abcdefghijklmnopqrstuvwxyz0123", 0, 30]);
        Reflect.apply(getImageData, context, [0, 0, 200, 60]);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.getImageData": 1 },
      detections: [readback(["canvas.getImageData"])]
    },
    offscreenContextSavedText: {
      body: () => {
        const context = new OffscreenCanvas(200, 60).getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        const { fillText, getImageData } = OffscreenCanvasRenderingContext2D.prototype;
        Object.setPrototypeOf(context, Object.prototype);
        Reflect.apply(fillText, context, ["abcdefghijklmnopqrstuvwxyz0123", 0, 30]);
        Reflect.apply(getImageData, context, [0, 0, 200, 60]);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.getImageData": 1 },
      detections: [readback(["canvas.getImageData"])]
    },
    pageCanvas: {
      body: () => {
        const canvas = document.createElement("canvas");
        canvas.width = 200;
        canvas.height = 60;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("missing 2d context");
        const toDataURL = HTMLCanvasElement.prototype.toDataURL;
        Object.setPrototypeOf(canvas, Object.prototype);
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        context.getImageData(0, 0, 200, 60);
        Reflect.apply(toDataURL, canvas, []);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.getImageData": 1, "canvas.toDataURL": 1 },
      detections: [readback(["canvas.getImageData", "canvas.toDataURL"])]
    },
    offscreenCanvas: {
      body: async () => {
        const canvas = new OffscreenCanvas(200, 60);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        const convertToBlob = OffscreenCanvas.prototype.convertToBlob;
        Object.setPrototypeOf(canvas, Object.prototype);
        context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        context.getImageData(0, 0, 200, 60);
        await Reflect.apply(convertToBlob, canvas, []);
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.convertToBlob": 1, "canvas.getImageData": 1 },
      detections: [readback(["canvas.convertToBlob", "canvas.getImageData"])]
    },
    pageContextMeasure: {
      body: () => {
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw new Error("missing 2d context");
        const measureText = CanvasRenderingContext2D.prototype.measureText;
        const setFont = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "font")?.set;
        if (!setFont) throw new Error("missing font setter");
        Object.setPrototypeOf(context, Object.prototype);
        const families = ["Arial", "Verdana", "Georgia", "Tahoma", "Courier", "Impact", "Garamond", "Palatino", "Helvetica", "Futura"];
        for (let index = 0; index < families.length; index += 1) {
          Reflect.apply(setFont, context, [`16px ${families[index]}`]);
          Reflect.apply(measureText, context, ["mmmmmmmmmmlli"]);
        }
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.measureText": 10 },
      detections: [fontProbe]
    },
    offscreenContextMeasure: {
      body: () => {
        const context = new OffscreenCanvas(200, 60).getContext("2d");
        if (!context) throw new Error("missing offscreen 2d context");
        const measureText = OffscreenCanvasRenderingContext2D.prototype.measureText;
        const setFont = Object.getOwnPropertyDescriptor(OffscreenCanvasRenderingContext2D.prototype, "font")?.set;
        if (!setFont) throw new Error("missing font setter");
        Object.setPrototypeOf(context, Object.prototype);
        const families = ["Arial", "Verdana", "Georgia", "Tahoma", "Courier", "Impact", "Garamond", "Palatino", "Helvetica", "Futura"];
        for (let index = 0; index < families.length; index += 1) {
          Reflect.apply(setFont, context, [`16px ${families[index]}`]);
          Reflect.apply(measureText, context, ["mmmmmmmmmmlli"]);
        }
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      },
      events: { "canvas.measureText": 10 },
      detections: [fontProbe]
    }
  };

  await withObservedPages(async (runCase) => {
    for (const [name, { body, events, detections }] of Object.entries(cases)) {
      const snapshot = parseObserverSnapshot(await runCase(body));
      assert.deepEqual(snapshot.events, events, name);
      assert.deepEqual(snapshot.detections, detections, name);
    }
  });
});

test("fingerprintObserverInitScript walks no page prototype chain while recording canvas work in real Chromium", async () => {
  // A page can put a Proxy whose getPrototypeOf trap throws anywhere in a
  // prototype chain. The observer brands canvases and contexts with native
  // getters and finds recorded state by identity, so it never reaches such a
  // trap: every call the page makes returns as it would unobserved, and is
  // recorded.
  await withObservedPages(async (runCase) => {
    const outcome = (await runCase(async () => {
      const image = new Image();
      image.src =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
      await image.decode();
      let trapCalls = 0;
      const trapped = (target: object) =>
        new Proxy(target, {
          getPrototypeOf() {
            trapCalls += 1;
            throw new Error("page trap");
          }
        });
      Object.setPrototypeOf(HTMLElement.prototype, trapped(Element.prototype));
      Object.setPrototypeOf(CanvasRenderingContext2D.prototype, trapped(Object.prototype));
      Object.setPrototypeOf(OffscreenCanvas.prototype, trapped(EventTarget.prototype));
      Object.setPrototypeOf(OffscreenCanvasRenderingContext2D.prototype, trapped(Object.prototype));

      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 60;
      const context = canvas.getContext("2d");
      const target = document.createElement("canvas");
      target.width = 200;
      target.height = 60;
      const targetContext = target.getContext("2d");
      const offscreen = new OffscreenCanvas(200, 60);
      const offscreenContext = offscreen.getContext("2d");
      const source = new OffscreenCanvas(200, 60);
      const sourceContext = source.getContext("2d");
      if (!context || !targetContext || !offscreenContext || !sourceContext) throw new Error("missing 2d context");

      const failures: string[] = [];
      const attempt = async (name: string, call: () => unknown) => {
        try {
          await call();
        } catch (error) {
          failures.push(`${name}: ${String(error)}`);
        }
      };
      await attempt("fillText", () => context.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30));
      await attempt("strokeText", () => context.strokeText("abcdefghijklmnopqrstuvwxyz0123", 0, 30));
      await attempt("measureText", () => context.measureText("mmmmmmmmmmlli"));
      await attempt("getImageData", () => context.getImageData(0, 0, 200, 60));
      await attempt("toDataURL", () => canvas.toDataURL());
      await attempt("toBlob", () => new Promise((resolve) => canvas.toBlob(resolve)));
      await attempt("offscreen fillText", () => offscreenContext.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30));
      await attempt("offscreen measureText", () => offscreenContext.measureText("mmmmmmmmmmlli"));
      await attempt("offscreen getImageData", () => offscreenContext.getImageData(0, 0, 200, 60));
      await attempt("offscreen drawImage(image)", () => offscreenContext.drawImage(image, 0, 0));
      await attempt("offscreen drawImage(canvas)", () => offscreenContext.drawImage(canvas, 0, 0));
      await attempt("convertToBlob", () => offscreen.convertToBlob());
      await attempt("drawImage(image)", () => targetContext.drawImage(image, 0, 0));
      await attempt("drawImage(offscreen)", () => targetContext.drawImage(offscreen, 0, 0));
      await attempt("createImageBitmap(image)", () => createImageBitmap(image));
      await attempt("createImageBitmap(offscreen)", () => createImageBitmap(offscreen));
      await attempt("transferToImageBitmap", () => source.transferToImageBitmap());
      await attempt("target toDataURL", () => target.toDataURL());
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return { failures, trapCalls, snapshot: fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.() };
    })) as { failures: string[]; trapCalls: number; snapshot: unknown };

    assert.deepEqual(outcome.failures, []);
    assert.equal(outcome.trapCalls, 0);
    const snapshot = parseObserverSnapshot(outcome.snapshot);
    assert.deepEqual(snapshot.events, {
      "canvas.convertToBlob": 1,
      "canvas.getImageData": 2,
      "canvas.measureText": 2,
      "canvas.toBlob": 1,
      "canvas.toDataURL": 2
    });
    // The page canvas, the offscreen canvas it drew into, and the page canvas
    // the offscreen one was drawn into: three canvases carrying the text, each
    // read back.
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 3,
        evidence: {
          readApis: ["canvas.convertToBlob", "canvas.getImageData", "canvas.toBlob", "canvas.toDataURL"],
          maxCanvasWidth: 200,
          maxCanvasHeight: 60,
          maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
          maxTextWriteCalls: 2
        }
      }
    ]);
  });
});

test("fingerprintObserverInitScript counts OffscreenCanvas toward the canvas tracking cap in real Chromium", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({ body: "<!doctype html><title>bounded observer</title>", contentType: "text/html" })
    );
    await page.goto("https://example.com/");

    // Neither family alone reaches the 256-canvas cap; together they pass it.
    const raw = await page.evaluate(() => {
      for (let index = 0; index < 200; index += 1) {
        document.createElement("canvas").getContext("2d")?.fillText("abcdefghij", 0, 16);
      }
      for (let index = 0; index < 57; index += 1) {
        new OffscreenCanvas(32, 32).getContext("2d")?.fillText("abcdefghij", 0, 16);
      }
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
    });
    assert.equal(raw, null);
    const coverage = await collectFingerprintObservationsWithCoverage(page.frames());
    assert.equal(coverage.attemptedFrames, 1);
    assert.equal(coverage.readableFrames, 0);
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript records fulfilled promise calls whatever the page does to Promise species in real Chromium", async () => {
  // Promise.prototype.then looks up the promise's constructor and its
  // Symbol.species before it registers anything. A page that swaps either
  // around a call must not keep a fulfilled export, render or offer from
  // being recorded, and must not make its own call throw.
  const offscreenExport = {
    kind: "canvas-fingerprinting",
    heuristic: "openwpm-canvas-v1",
    count: 1,
    evidence: {
      readApis: ["canvas.convertToBlob"],
      maxCanvasWidth: 200,
      maxCanvasHeight: 60,
      maxDistinctTextCharacters: OFFSCREEN_PROBE_TEXT.length,
      maxTextWriteCalls: 1
    }
  };

  await withObservedPages(async (runCase) => {
    const exports: Record<string, () => unknown> = {
      species: async () => {
        const canvas = new OffscreenCanvas(200, 60);
        canvas.getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species) as PropertyDescriptor;
        Object.defineProperty(Promise, Symbol.species, { configurable: true, value: function PageSpecies() {} });
        const pending = canvas.convertToBlob();
        Object.defineProperty(Promise, Symbol.species, original);
        const blob = await pending;
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return { blobBytes: blob.size, snapshot: fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.() };
      },
      constructor: async () => {
        const canvas = new OffscreenCanvas(200, 60);
        canvas.getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
        const original = Object.getOwnPropertyDescriptor(Promise.prototype, "constructor") as PropertyDescriptor;
        Object.defineProperty(Promise.prototype, "constructor", {
          configurable: true,
          get() {
            throw new Error("page constructor");
          }
        });
        const pending = canvas.convertToBlob();
        Object.defineProperty(Promise.prototype, "constructor", original);
        const blob = await pending;
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return { blobBytes: blob.size, snapshot: fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.() };
      }
    };
    for (const [poisoning, body] of Object.entries(exports)) {
      const exported = (await runCase(body)) as { blobBytes: number; snapshot: unknown };
      assert.ok(exported.blobBytes > 0, poisoning);
      const snapshot = parseObserverSnapshot(exported.snapshot);
      assert.deepEqual(snapshot.events, { "canvas.convertToBlob": 1 }, poisoning);
      assert.deepEqual(snapshot.detections, [offscreenExport], poisoning);
    }

    const rendered = parseObserverSnapshot(
      await runCase(async () => {
        const context = new OfflineAudioContext(1, 44100, 44100);
        const oscillator = context.createOscillator();
        const compressor = context.createDynamicsCompressor();
        oscillator.connect(compressor);
        compressor.connect(context.destination);
        oscillator.start(0);
        const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species) as PropertyDescriptor;
        Object.defineProperty(Promise, Symbol.species, { configurable: true, value: function PageSpecies() {} });
        const pending = context.startRendering();
        Object.defineProperty(Promise, Symbol.species, original);
        await pending;
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.deepEqual(rendered.detections.map((detection) => detection.heuristic), ["audio-rendering-v1"]);
    assert.equal(rendered.events["audio.OfflineAudioContext.startRendering"], 1);

    const offered = parseObserverSnapshot(
      await runCase(async () => {
        const connection = new RTCPeerConnection();
        connection.createDataChannel("probe");
        const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species) as PropertyDescriptor;
        Object.defineProperty(Promise, Symbol.species, { configurable: true, value: function PageSpecies() {} });
        const pending = connection.createOffer();
        Object.defineProperty(Promise, Symbol.species, original);
        await pending;
        connection.close();
        const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.();
      })
    );
    assert.equal(offered.events["webrtc.RTCPeerConnection.createOffer"], 1);

    // createImageBitmap hands the page a derived promise. Before, deriving it
    // under a page species threw into the page's own call.
    const bitmapped = (await runCase(async () => {
      const offscreen = new OffscreenCanvas(200, 60);
      offscreen.getContext("2d")?.fillText("abcdefghijklmnopqrstuvwxyz0123", 0, 30);
      const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species) as PropertyDescriptor;
      Object.defineProperty(Promise, Symbol.species, { configurable: true, value: function PageSpecies() {} });
      let pending: Promise<ImageBitmap> | undefined;
      let thrown = "";
      try {
        pending = createImageBitmap(offscreen);
      } catch (error) {
        thrown = String(error);
      }
      Object.defineProperty(Promise, Symbol.species, original);
      if (!pending) return { thrown };
      const bitmap = await pending;
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 60;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      canvas.toDataURL();
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return { bitmapWidth: bitmap.width, snapshot: fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.() };
    })) as { bitmapWidth?: number; snapshot?: unknown; thrown?: string };
    assert.equal(bitmapped.thrown, undefined);
    assert.equal(bitmapped.bitmapWidth, 200);
    assert.deepEqual(parseObserverSnapshot(bitmapped.snapshot).detections, [
      { ...offscreenExport, evidence: { ...offscreenExport.evidence, readApis: ["canvas.toDataURL"] } }
    ]);
  });
});

test("fingerprintObserverInitScript leaves a rejection the page never handles unhandled in real Chromium", async () => {
  // Observing a native promise marks its rejection handled, so the observer
  // hands the page a promise of its own for every promise call it records. A
  // rejection the page leaves unhandled must still reach unhandledrejection
  // (and the error monitoring that listens for it), as it does unobserved,
  // and one the page handles must not.
  const provoke = async () => {
    const seen: string[] = [];
    window.addEventListener("unhandledrejection", (event) => {
      seen.push(String((event.reason as { name?: unknown } | undefined)?.name));
    });
    void new OffscreenCanvas(0, 0).convertToBlob();
    new OffscreenCanvas(0, 0).convertToBlob().catch(() => undefined);
    const context = new OfflineAudioContext(1, 128, 44100);
    context.startRendering().catch(() => undefined);
    void context.startRendering();
    const closed = new RTCPeerConnection();
    closed.close();
    void closed.createOffer();
    closed.createOffer().catch(() => undefined);
    void new RTCPeerConnection().setLocalDescription({ type: "answer", sdp: "not sdp" });
    void createImageBitmap(new OffscreenCanvas(0, 0));
    const deadline = Date.now() + 5000;
    while (seen.length < 5 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    return seen.sort();
  };

  const browser = await chromium.launch({ headless: true });
  try {
    const seenBy = async (observed: boolean) => {
      const context = await browser.newContext();
      if (observed) await context.addInitScript(fingerprintObserverInitScript, "example.com");
      const page = await context.newPage();
      await page.route("https://example.com/**", (route) =>
        route.fulfill({ body: "<!doctype html><title>rejections</title>", contentType: "text/html" })
      );
      await page.goto("https://example.com/");
      const seen = await page.evaluate(provoke);
      await context.close();
      return seen;
    };

    const unobserved = await seenBy(false);
    assert.deepEqual(unobserved, ["IndexSizeError", "InvalidStateError", "InvalidStateError", "InvalidStateError", "OperationError"]);
    assert.deepEqual(await seenBy(true), unobserved);
  } finally {
    await browser.close();
  }
});

test("fingerprintObserverInitScript keeps a failure while recording a promise call out of the page in real Chromium", async () => {
  // A connection the page re-prototypes onto a Proxy whose getPrototypeOf
  // trap throws makes the WebRTC recording throw after the native offer has
  // fulfilled. The page's own promise must still fulfill, no rejection it
  // never caused may reach it, and the frame fails closed.
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({ body: "<!doctype html><title>trapped offer</title>", contentType: "text/html" })
    );
    await page.goto("https://example.com/");

    const outcome = await page.evaluate(async () => {
      const seen: string[] = [];
      window.addEventListener("unhandledrejection", (event) => {
        seen.push(String(event.reason));
      });
      const connection = new RTCPeerConnection();
      const createOffer = RTCPeerConnection.prototype.createOffer;
      Object.setPrototypeOf(
        connection,
        new Proxy(RTCPeerConnection.prototype, {
          getPrototypeOf() {
            throw new Error("page trap");
          }
        })
      );
      const offer = (await Reflect.apply(createOffer, connection, [])) as RTCSessionDescriptionInit;
      await new Promise((resolve) => setTimeout(resolve, 100));
      connection.close();
      const fingerprintWindow = window as Window & { __siteBehaviorLabFingerprintSnapshot?: () => unknown };
      return { offerType: offer.type, seen, snapshot: fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.() };
    });
    assert.deepEqual(outcome, { offerType: "offer", seen: [], snapshot: null });
  } finally {
    await browser.close();
  }
});

test("collectFingerprintObservationsFromFrames merges canvas detections across frames", async () => {
  const observations = await collectFingerprintObservationsFromFrames([
    frameWithSnapshot({
      detections: [
        {
          kind: "canvas-fingerprinting",
          heuristic: "openwpm-canvas-v1",
          count: 1,
          evidence: {
            readApis: ["canvas.toDataURL"],
            maxCanvasWidth: 32,
            maxCanvasHeight: 32,
            maxDistinctTextCharacters: 10,
            maxTextWriteCalls: 1
          }
        }
      ],
      events: {
        "canvas.toDataURL": 1
      }
    }),
    frameWithSnapshot({
      detections: [
        {
          kind: "canvas-fingerprinting",
          heuristic: "openwpm-canvas-v1",
          count: 2,
          evidence: {
            readApis: ["canvas.getImageData"],
            maxCanvasWidth: 64,
            maxCanvasHeight: 48,
            maxDistinctTextCharacters: 12,
            maxTextWriteCalls: 2
          }
        }
      ],
      events: {
        "canvas.getImageData": 2
      }
    })
  ]);

  assert.deepEqual(observations, {
    events: [
      {
        api: "canvas.getImageData",
        count: 2
      },
      {
        api: "canvas.toDataURL",
        count: 1
      }
    ],
    detections: [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 3,
        evidence: {
          readApis: ["canvas.getImageData", "canvas.toDataURL"],
          maxCanvasWidth: 64,
          maxCanvasHeight: 48,
          maxDistinctTextCharacters: 12,
          maxTextWriteCalls: 2
        }
      }
    ]
  });
});

test("collectFingerprintObservationsFromFrames merges interaction detections across frames", async () => {
  const observations = await collectFingerprintObservationsFromFrames([
    frameWithSnapshot({
      detections: [
        {
          kind: "session-recording",
          heuristic: "interaction-listener-coverage-v1",
          count: 1,
          evidence: {
            eventTypes: ["mousemove", "scroll", "visibilitychange", "wheel"],
            listenerTargets: ["document", "window"],
            thirdPartyOrigins: ["https://recorder.example.net"],
            totalListenerCalls: 6
          }
        }
      ],
      events: {}
    }),
    frameWithSnapshot({
      detections: [
        {
          kind: "session-recording",
          heuristic: "interaction-listener-coverage-v1",
          count: 1,
          evidence: {
            eventTypes: ["click", "input", "scroll", "selectionchange"],
            listenerTargets: ["body", "input"],
            thirdPartyOrigins: ["https://analytics.example.net"],
            totalListenerCalls: 7
          }
        },
        {
          kind: "input-monitoring",
          heuristic: "input-listener-coverage-v1",
          count: 1,
          evidence: {
            eventTypes: ["change", "input", "keydown", "paste"],
            listenerTargets: ["input"],
            thirdPartyOrigins: ["https://analytics.example.net"],
            totalListenerCalls: 4
          }
        }
      ],
      events: {}
    })
  ]);

  assert.deepEqual(observations.detections, [
    {
      kind: "session-recording",
      heuristic: "interaction-listener-coverage-v1",
      count: 2,
      evidence: {
        eventTypes: ["click", "input", "mousemove", "scroll", "selectionchange", "visibilitychange", "wheel"],
        listenerTargets: ["body", "document", "input", "window"],
        thirdPartyOrigins: ["https://analytics.example.net", "https://recorder.example.net"],
        totalListenerCalls: 13
      }
    },
    {
      kind: "input-monitoring",
      heuristic: "input-listener-coverage-v1",
      count: 1,
      evidence: {
        eventTypes: ["change", "input", "keydown", "paste"],
        listenerTargets: ["input"],
        thirdPartyOrigins: ["https://analytics.example.net"],
        totalListenerCalls: 4
      }
    }
  ]);
});

test("collectFingerprintObservationsFromFrames merges high-entropy behavioral detections across frames", async () => {
  const observations = await collectFingerprintObservationsFromFrames([
    frameWithSnapshot({
      detections: [
        {
          kind: "canvas-font-fingerprinting",
          heuristic: "canvas-font-probing-v1",
          count: 1,
          evidence: {
            measureTextCalls: 8,
            maxDistinctFonts: 4,
            maxDistinctTextSamples: 1,
            maxTextLength: 12
          }
        },
        {
          kind: "webgl-fingerprinting",
          heuristic: "webgl-entropy-read-v1",
          count: 1,
          evidence: {
            readApis: ["webgl.readPixels"],
            parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
            getParameterCalls: 2,
            readPixelsCalls: 1
          }
        }
      ],
      events: {}
    }),
    frameWithSnapshot({
      detections: [
        {
          kind: "audio-fingerprinting",
          heuristic: "audio-rendering-v1",
          count: 1,
          evidence: {
            apis: ["audio.OfflineAudioContext.createOscillator", "audio.OfflineAudioContext.startRendering"],
            offlineRenderCalls: 1,
            oscillatorCalls: 1,
            compressorCalls: 0,
            analyserCalls: 0
          }
        },
        {
          kind: "webrtc-fingerprinting",
          heuristic: "webrtc-peerconnection-v1",
          count: 1,
          evidence: {
            constructorCalls: 1,
            createDataChannelCalls: 1,
            createOfferCalls: 1,
            setLocalDescriptionCalls: 0
          }
        }
      ],
      events: {}
    })
  ]);

  assert.deepEqual(observations.detections, [
    {
      kind: "audio-fingerprinting",
      heuristic: "audio-rendering-v1",
      count: 1,
      evidence: {
        apis: ["audio.OfflineAudioContext.createOscillator", "audio.OfflineAudioContext.startRendering"],
        offlineRenderCalls: 1,
        oscillatorCalls: 1,
        compressorCalls: 0,
        analyserCalls: 0
      }
    },
    {
      kind: "canvas-font-fingerprinting",
      heuristic: "canvas-font-probing-v1",
      count: 1,
      evidence: {
        measureTextCalls: 8,
        maxDistinctFonts: 4,
        maxDistinctTextSamples: 1,
        maxTextLength: 12
      }
    },
    {
      kind: "webgl-fingerprinting",
      heuristic: "webgl-entropy-read-v1",
      count: 1,
      evidence: {
        readApis: ["webgl.readPixels"],
        parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
        getParameterCalls: 2,
        readPixelsCalls: 1
      }
    },
    {
      kind: "webrtc-fingerprinting",
      heuristic: "webrtc-peerconnection-v1",
      count: 1,
      evidence: {
        constructorCalls: 1,
        createDataChannelCalls: 1,
        createOfferCalls: 1,
        setLocalDescriptionCalls: 0
      }
    }
  ]);
});

test("fingerprintObserverInitScript flags the canvas heuristic after text write and readback", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const canvas = new harness.Canvas();
    const context = new harness.Context(canvas);

    context.fillText("abcdefghij", 0, 0);
    canvas.toDataURL();

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 1,
        evidence: {
          readApis: ["canvas.toDataURL"],
          maxCanvasWidth: 32,
          maxCanvasHeight: 32,
          maxDistinctTextCharacters: 10,
          maxTextWriteCalls: 1
        }
      }
    ]);
    assert.equal(snapshot.events["canvas.toDataURL"], 1);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript flags third-party session recording and input listener coverage", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const input = new harness.Input();

    withStackOrigin("https://recorder.example.net", () => {
      harness.window.addEventListener("mousemove", () => undefined);
      harness.window.addEventListener("wheel", () => undefined);
      harness.document.addEventListener("scroll", () => undefined);
      harness.document.addEventListener("visibilitychange", () => undefined);
      harness.document.body.addEventListener("click", () => undefined);
      harness.document.documentElement.addEventListener("pointermove", () => undefined);
      input.addEventListener("input", () => undefined);
      input.addEventListener("keydown", () => undefined);
      input.addEventListener("change", () => undefined);
      input.addEventListener("paste", () => undefined);
    });

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "session-recording",
        heuristic: "interaction-listener-coverage-v1",
        count: 1,
        evidence: {
          eventTypes: ["click", "input", "keydown", "mousemove", "pointermove", "scroll", "visibilitychange", "wheel"],
          listenerTargets: ["body", "document", "documentElement", "input", "window"],
          thirdPartyOrigins: ["https://recorder.example.net"],
          totalListenerCalls: 8
        }
      },
      {
        kind: "input-monitoring",
        heuristic: "input-listener-coverage-v1",
        count: 1,
        evidence: {
          eventTypes: ["change", "input", "keydown", "paste"],
          listenerTargets: ["input"],
          thirdPartyOrigins: ["https://recorder.example.net"],
          totalListenerCalls: 4
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript withholds subframe listener coverage from the page-level summary", () => {
  const harness = installInteractionHarness();
  try {
    // A cross-origin embed (a video player, an ad slot, a captcha widget) runs
    // the observer in its own frame, where window.top is the scanned page's
    // window. Its vendor's listeners only cover the embed's own document, and
    // the merged page-level summary cannot say so, so nothing is published.
    harness.window.top = { name: "scanned page window" };
    fingerprintObserverInitScript();
    const input = new harness.Input();

    withStackOrigin("https://recorder.example.net", () => {
      harness.window.addEventListener("mousemove", () => undefined);
      harness.window.addEventListener("wheel", () => undefined);
      harness.document.addEventListener("scroll", () => undefined);
      harness.document.addEventListener("visibilitychange", () => undefined);
      harness.document.body.addEventListener("click", () => undefined);
      harness.document.documentElement.addEventListener("pointermove", () => undefined);
      input.addEventListener("input", () => undefined);
      input.addEventListener("keydown", () => undefined);
      input.addEventListener("change", () => undefined);
      input.addEventListener("paste", () => undefined);
    });

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, []);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript records both chain origins when a third-party agent wraps addEventListener above the observer", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const eventTarget = harness.window.EventTarget as {
      prototype: { addEventListener: (...args: unknown[]) => unknown };
    };
    const observerWrapper = eventTarget.prototype.addEventListener;
    // A RUM or error agent instruments EventTarget.prototype.addEventListener
    // after the observer, so every captured chain contains its origin as well
    // as the registrant's. The published claim is chain presence, never sole
    // registrant, so two distinct third-party origins in one chain are a
    // detection naming both, not censored coverage: the agent really is in
    // every registration call chain it forwards.
    const createPageWrapper = Function(
      "wrapped",
      "return function pageAddEventListener(...args) { return wrapped.apply(this, args); };\n//# sourceURL=https://rum.example.org/agent.js"
    ) as (wrapped: unknown) => (...args: unknown[]) => unknown;
    Object.defineProperty(eventTarget.prototype, "addEventListener", {
      configurable: true,
      value: createPageWrapper(observerWrapper),
      writable: true
    });
    const input = new harness.Input();

    withStackOrigin("https://recorder.example.net", () => {
      harness.window.addEventListener("mousemove", () => undefined);
      harness.window.addEventListener("wheel", () => undefined);
      harness.document.addEventListener("scroll", () => undefined);
      harness.document.addEventListener("visibilitychange", () => undefined);
      harness.document.body.addEventListener("click", () => undefined);
      harness.document.documentElement.addEventListener("pointermove", () => undefined);
      input.addEventListener("input", () => undefined);
      input.addEventListener("keydown", () => undefined);
      input.addEventListener("change", () => undefined);
      input.addEventListener("paste", () => undefined);
    });

    const snapshot = readSnapshot(harness.window);
    const kinds = snapshot.detections.map((detection) => detection.kind).sort();
    assert.deepEqual(kinds, ["input-monitoring", "session-recording"]);
    for (const detection of snapshot.detections) {
      assert.deepEqual(
        (detection.evidence as { thirdPartyOrigins: string[] }).thirdPartyOrigins,
        ["https://recorder.example.net", "https://rum.example.org"]
      );
    }
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript attributes synchronous third-party listeners when stack traces are disabled", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const input = new harness.Input();

    withStackOrigin(
      "https://recorder.example.net",
      () => {
        input.addEventListener("input", () => undefined);
        input.addEventListener("keydown", () => undefined);
        input.addEventListener("change", () => undefined);
        input.addEventListener("paste", () => undefined);
      },
      { stackTraceLimit: 0 }
    );

    const snapshot = readSnapshot(harness.window);
    assert.equal(snapshot.detections.length, 1);
    assert.equal(snapshot.detections[0].kind, "input-monitoring");
    assert.deepEqual((snapshot.detections[0].evidence as { thirdPartyOrigins: string[] }).thirdPartyOrigins, [
      "https://recorder.example.net"
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript restores and overrides a non-numeric stackTraceLimit for attribution", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const input = new harness.Input();

    withStackOrigin(
      "https://recorder.example.net",
      () => {
        input.addEventListener("input", () => undefined);
        input.addEventListener("keydown", () => undefined);
        input.addEventListener("change", () => undefined);
        input.addEventListener("paste", () => undefined);
      },
      { stackTraceLimit: "disabled" }
    );

    const snapshot = readSnapshot(harness.window);
    assert.equal(snapshot.detections.length, 1);
    assert.equal(snapshot.detections[0].kind, "input-monitoring");
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript temporarily pins an oversized stackTraceLimit", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const input = new harness.Input();

    withStackOrigin(
      "https://recorder.example.net",
      () => {
        input.addEventListener("input", () => undefined);
        input.addEventListener("keydown", () => undefined);
        input.addEventListener("change", () => undefined);
        input.addEventListener("paste", () => undefined);
      },
      { stackTraceLimit: 1_000_000 }
    );

    assert.equal(readSnapshot(harness.window).detections[0]?.kind, "input-monitoring");
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript keeps native stack attribution when the page replaces Error", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const input = new harness.Input();

    withStackOrigin(
      "https://recorder.example.net",
      () => {
        input.addEventListener("input", () => undefined);
        input.addEventListener("keydown", () => undefined);
        input.addEventListener("change", () => undefined);
        input.addEventListener("paste", () => undefined);
      },
      { replaceGlobalError: true }
    );

    const snapshot = readSnapshot(harness.window);
    assert.equal(snapshot.detections.length, 1);
    assert.equal(snapshot.detections[0].kind, "input-monitoring");
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript neutralizes page prepareStackTrace tampering during listener attribution", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const input = new harness.Input();
    const forgedFirstPartyStack = () =>
      "Error\n    at install (https://example.com/forged-first-party.js:10:5)";

    withStackOrigin(
      "https://recorder.example.net",
      () => {
        input.addEventListener("input", () => undefined);
        input.addEventListener("keydown", () => undefined);
        input.addEventListener("change", () => undefined);
        input.addEventListener("paste", () => undefined);
      },
      { prepareStackTrace: forgedFirstPartyStack }
    );

    const snapshot = readSnapshot(harness.window);
    assert.equal(snapshot.detections.length, 1);
    assert.equal(snapshot.detections[0].kind, "input-monitoring");
    assert.deepEqual((snapshot.detections[0].evidence as { thirdPartyOrigins: string[] }).thirdPartyOrigins, [
      "https://recorder.example.net"
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript treats sibling subdomains of the site key as same-site", () => {
  const harness = installInteractionHarness();
  try {
    (harness.window.location as { hostname: string }).hostname = "www.capitalone.com";
    // The scanner passes the site's registrable domain as the init-script
    // argument; sibling subdomains (verified. vs www.) share no suffix
    // relationship, so without the key they were misread as third parties.
    fingerprintObserverInitScript("capitalone.com");
    const input = new harness.Input();

    withStackOrigin("https://verified.capitalone.com", () => {
      input.addEventListener("input", () => undefined);
      input.addEventListener("keydown", () => undefined);
      input.addEventListener("change", () => undefined);
      input.addEventListener("paste", () => undefined);
    });

    assert.deepEqual(readSnapshot(harness.window).detections, []);

    // A genuinely cross-site origin still triggers the detection.
    withStackOrigin("https://recorder.example.net", () => {
      input.addEventListener("input", () => undefined);
      input.addEventListener("keydown", () => undefined);
      input.addEventListener("change", () => undefined);
      input.addEventListener("paste", () => undefined);
    });

    const detections = readSnapshot(harness.window).detections;
    assert.equal(detections.length, 1);
    assert.equal(detections[0].kind, "input-monitoring");
    assert.deepEqual(
      (detections[0].evidence as { thirdPartyOrigins: string[] }).thirdPartyOrigins,
      ["https://recorder.example.net"]
    );
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript flags repeated canvas font probing without collecting measured text", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const canvas = new harness.Canvas();
    const context = new harness.Context(canvas);
    const fonts = ["12px Arial", "12px Times", "12px Courier", "12px Helvetica"];

    for (let index = 0; index < 8; index += 1) {
      context.font = fonts[index % fonts.length];
      context.measureText("mmmmmmmmmmmm");
    }

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-font-fingerprinting",
        heuristic: "canvas-font-probing-v1",
        count: 1,
        evidence: {
          measureTextCalls: 8,
          maxDistinctFonts: 4,
          maxDistinctTextSamples: 1,
          maxTextLength: 12
        }
      }
    ]);
    assert.equal(snapshot.events["canvas.measureText"], 8);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript aggregates canvas font probing across the document", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const fonts = ["12px Arial", "12px Times", "12px Courier", "12px Helvetica"];

    for (let index = 0; index < 8; index += 1) {
      const context = new harness.Context(new harness.Canvas());
      context.font = fonts[index % fonts.length];
      context.measureText("mmmmmmmmmmmm");
    }

    assert.deepEqual(readSnapshot(harness.window).detections, [
      {
        kind: "canvas-font-fingerprinting",
        heuristic: "canvas-font-probing-v1",
        count: 1,
        evidence: {
          measureTextCalls: 8,
          maxDistinctFonts: 4,
          maxDistinctTextSamples: 1,
          maxTextLength: 12
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript tracks magic-key font probes without prototype collisions", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const context = new harness.Context(new harness.Canvas());
    const fonts = ["__proto__", "constructor", "prototype", "toString"];

    for (let index = 0; index < 8; index += 1) {
      context.font = fonts[index % fonts.length];
      context.measureText("__proto__");
    }

    assert.deepEqual(readSnapshot(harness.window).detections, [
      {
        kind: "canvas-font-fingerprinting",
        heuristic: "canvas-font-probing-v1",
        count: 1,
        evidence: {
          measureTextCalls: 8,
          maxDistinctFonts: 4,
          maxDistinctTextSamples: 1,
          maxTextLength: 9
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript flags WebGL entropy reads", () => {
  const harness = installWebglHarness();
  try {
    fingerprintObserverInitScript();
    const context = new harness.WebGL();

    context.getParameter(37446);
    context.readPixels();

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "webgl-fingerprinting",
        heuristic: "webgl-entropy-read-v1",
        count: 1,
        evidence: {
          readApis: ["webgl.readPixels"],
          parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"],
          getParameterCalls: 1,
          readPixelsCalls: 1
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript requires both WebGL parameter and pixel entropy signals", () => {
  // This predicate is measurement identity. 4be4fed (2026-07-20) changed it
  // from OR to AND under the same heuristic id, and reports measured before
  // then carry detections the current rule would not emit; the reader tells
  // them apart only by evidence shape (isSingleSignalWebglDetection). Pinned
  // beside the detector version: changing the rule needs a version bump and
  // a reader that keys on it, so re-pin both together.
  assert.equal(DETECTOR_VERSIONS["fingerprint-heuristics"], "fingerprint-observer@5");

  const parameterHarness = installWebglHarness();
  try {
    fingerprintObserverInitScript();
    const parameterContext = new parameterHarness.WebGL();
    parameterContext.getParameter(37446);

    assert.deepEqual(readSnapshot(parameterHarness.window).detections, []);
  } finally {
    parameterHarness.restore();
  }

  const pixelHarness = installWebglHarness();
  try {
    fingerprintObserverInitScript();
    const pixelContext = new pixelHarness.WebGL();
    pixelContext.readPixels();

    assert.deepEqual(readSnapshot(pixelHarness.window).detections, []);
  } finally {
    pixelHarness.restore();
  }

  const bothHarness = installWebglHarness();
  let emitted: FingerprintDetectionSummary[];
  try {
    fingerprintObserverInitScript();
    const bothContext = new bothHarness.WebGL();
    bothContext.getParameter(37446);
    bothContext.readPixels();
    emitted = readSnapshot(bothHarness.window).detections;
  } finally {
    bothHarness.restore();
  }
  assert.equal(emitted.length, 1);
  assert.equal(isSingleSignalWebglDetection(emitted[0]), false);

  // The two shapes the earlier rule emitted. Historical wires carrying them
  // must still read, and the reader must present them as that earlier rule.
  const earlierRuleShapes: FingerprintDetectionSummary[] = [
    {
      kind: "webgl-fingerprinting",
      heuristic: "webgl-entropy-read-v1",
      count: 1,
      evidence: { readApis: [], parameters: ["webgl.getParameter.UNMASKED_RENDERER_WEBGL"], getParameterCalls: 1, readPixelsCalls: 0 }
    },
    {
      kind: "webgl-fingerprinting",
      heuristic: "webgl-entropy-read-v1",
      count: 1,
      evidence: { readApis: ["webgl2.readPixels"], parameters: [], getParameterCalls: 0, readPixelsCalls: 1 }
    }
  ];
  for (const shape of earlierRuleShapes) {
    assert.equal(isFingerprintDetectionSummary(shape), true);
    assert.equal(isSingleSignalWebglDetection(shape), true);
  }
});

test("fingerprintObserverInitScript flags offline audio rendering signatures", async () => {
  const harness = installAudioHarness();
  try {
    fingerprintObserverInitScript();
    const context = new harness.OfflineAudioContext();

    context.createOscillator();
    context.createDynamicsCompressor();
    await context.startRendering();

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "audio-fingerprinting",
        heuristic: "audio-rendering-v1",
        count: 1,
        evidence: {
          apis: [
            "audio.OfflineAudioContext.createDynamicsCompressor",
            "audio.OfflineAudioContext.createOscillator",
            "audio.OfflineAudioContext.startRendering"
          ],
          offlineRenderCalls: 1,
          oscillatorCalls: 1,
          compressorCalls: 1,
          analyserCalls: 0
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript fails the frame closed when a promise call's result cannot be observed", () => {
  // A native promise API always returns a promise. If the observer cannot
  // register on what came back, it cannot tell a fulfilled call from a
  // rejected one, so the frame must not read as quiet.
  const harness = installAudioHarness();
  try {
    (harness.OfflineAudioContext.prototype as unknown as { startRendering: () => unknown }).startRendering = () => ({});
    fingerprintObserverInitScript();
    const context = new harness.OfflineAudioContext();
    assert.deepEqual(context.startRendering() as unknown, {});
    assert.equal(readRawSnapshot(harness.window), null);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript preserves online AudioContext analyser events without a detection", () => {
  const harness = installAudioHarness();
  try {
    fingerprintObserverInitScript();
    const context = new harness.AudioContext();

    context.createAnalyser();

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, []);
    assert.equal(snapshot.events["audio.createAnalyser"], 1);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript flags WebRTC peer connection probing", async () => {
  const harness = installRtcHarness();
  try {
    fingerprintObserverInitScript();
    const PeerConnection = harness.window.RTCPeerConnection as typeof harness.PeerConnection;
    const connection = new PeerConnection();

    connection.createDataChannel("probe");
    await connection.createOffer();
    await connection.setLocalDescription({});

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "webrtc-fingerprinting",
        heuristic: "webrtc-peerconnection-v1",
        count: 1,
        evidence: {
          constructorCalls: 1,
          createDataChannelCalls: 1,
          createOfferCalls: 1,
          setLocalDescriptionCalls: 1
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript does not flag benign first-party form listeners", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const firstField = new harness.Input();
    const secondField = new harness.Input();

    firstField.addEventListener("input", () => undefined);
    firstField.addEventListener("change", () => undefined);
    secondField.addEventListener("input", () => undefined);
    harness.document.addEventListener("keydown", () => undefined);

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, []);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript requires getImageData reads to cover at least 16 by 16 pixels", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const smallCanvas = new harness.Canvas();
    const smallContext = new harness.Context(smallCanvas);
    const largeCanvas = new harness.Canvas();
    const largeContext = new harness.Context(largeCanvas);

    smallContext.fillText("abcdefghij", 0, 0);
    smallContext.getImageData(0, 0, 1, 1);
    largeContext.fillText("abcdefghij", 0, 0);
    (largeContext.getImageData as unknown as (...args: unknown[]) => unknown)(0, 0, "16", "16");

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 1,
        evidence: {
          readApis: ["canvas.getImageData"],
          maxCanvasWidth: 32,
          maxCanvasHeight: 32,
          maxDistinctTextCharacters: 10,
          maxTextWriteCalls: 1
        }
      }
    ]);
    assert.equal(snapshot.events["canvas.getImageData"], 2);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript does not let save or restore calls suppress canvas detection", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const canvas = new harness.Canvas();
    const context = new harness.Context(canvas);

    context.save();
    context.restore();
    context.fillText("abcdefghij", 0, 0);
    canvas.toDataURL();

    const snapshot = readSnapshot(harness.window);
    assert.equal(snapshot.detections.length, 1);
    assert.equal(snapshot.detections[0].kind, "canvas-fingerprinting");
    assert.equal(snapshot.events["canvas.toDataURL"], 1);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript does not let a no-op canvas listener suppress detection", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const canvas = new harness.Canvas();
    const context = new harness.Context(canvas);

    canvas.addEventListener("click", () => undefined);
    context.fillText("abcdefghij", 0, 0);
    canvas.toDataURL();

    const snapshot = readSnapshot(harness.window);
    assert.equal(snapshot.detections.length, 1);
    assert.equal(snapshot.detections[0].kind, "canvas-fingerprinting");
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript correlates canvas text writes and readback across canvases", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const writeCanvas = new harness.Canvas();
    const readCanvas = new harness.Canvas();
    const readContext = new harness.Context(readCanvas);

    new harness.Context(writeCanvas).fillText("abcdefghij", 0, 0);
    readContext.drawImage(writeCanvas, 0, 0);
    readCanvas.toDataURL();

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 1,
        evidence: {
          readApis: ["canvas.toDataURL"],
          maxCanvasWidth: 32,
          maxCanvasHeight: 32,
          maxDistinctTextCharacters: 10,
          maxTextWriteCalls: 1
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript preserves canvas provenance through ImageBitmap drawImage", async () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const writeCanvas = new harness.Canvas();
    const readCanvas = new harness.Canvas();

    new harness.Context(writeCanvas).fillText("abcdefghij", 0, 0);
    const bitmap = await harness.createImageBitmap(writeCanvas);
    new harness.Context(readCanvas).drawImage(bitmap, 0, 0);
    readCanvas.toDataURL();

    assert.deepEqual(readSnapshot(harness.window).detections, [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: 1,
        evidence: {
          readApis: ["canvas.toDataURL"],
          maxCanvasWidth: 32,
          maxCanvasHeight: 32,
          maxDistinctTextCharacters: 10,
          maxTextWriteCalls: 1
        }
      }
    ]);
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript exposes only immutable event snapshots", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const canvas = new harness.Canvas();
    canvas.toDataURL();

    const exposed = harness.window.__siteBehaviorLabFingerprintEvents as Record<string, number>;
    assert.equal(Object.isFrozen(exposed), true);
    assert.equal(Reflect.deleteProperty(exposed, "canvas.toDataURL"), false);
    assert.equal(Reflect.set(exposed, "canvas.toDataURL", Number.MAX_SAFE_INTEGER), false);
    assert.equal(Reflect.set(exposed, "forged.api", Number.MAX_SAFE_INTEGER), false);
    assert.notEqual(exposed, harness.window.__siteBehaviorLabFingerprintEvents);
    assert.equal(typeof readRawSnapshot(harness.window), "string");
    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.events, { "canvas.toDataURL": 1 });
  } finally {
    harness.restore();
  }
});

test("fingerprintObserverInitScript keeps evidence when page serialization intrinsics are replaced", () => {
  const harness = installCanvasHarness();
  const objectKeysDescriptor = Object.getOwnPropertyDescriptor(Object, "keys");
  const stringifyDescriptor = Object.getOwnPropertyDescriptor(JSON, "stringify");
  const toJsonDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  let rawSnapshot: unknown;
  try {
    fingerprintObserverInitScript();
    const canvas = new harness.Canvas();
    const context = new harness.Context(canvas);

    Object.defineProperty(Object, "keys", {
      configurable: true,
      value: () => [],
      writable: true
    });
    Object.defineProperty(JSON, "stringify", {
      configurable: true,
      value: () => '{"detections":[],"events":{}}',
      writable: true
    });
    Object.defineProperty(Object.prototype, "toJSON", {
      configurable: true,
      value: () => ({ detections: [], events: {} }),
      writable: true
    });

    context.fillText("abcdefghij", 0, 0);
    canvas.toDataURL();
    rawSnapshot = readRawSnapshot(harness.window);
  } finally {
    if (objectKeysDescriptor) Object.defineProperty(Object, "keys", objectKeysDescriptor);
    if (stringifyDescriptor) Object.defineProperty(JSON, "stringify", stringifyDescriptor);
    if (toJsonDescriptor) {
      Object.defineProperty(Object.prototype, "toJSON", toJsonDescriptor);
    } else {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }
    harness.restore();
  }

  assert.equal(typeof rawSnapshot, "string");
  const snapshot = JSON.parse(rawSnapshot as string) as {
    detections: FingerprintDetectionSummary[];
    events: Record<string, number>;
  };
  assert.equal(snapshot.events["canvas.toDataURL"], 1);
  assert.equal(snapshot.detections.length, 1);
  assert.equal(snapshot.detections[0].kind, "canvas-fingerprinting");
});

test("fingerprintObserverInitScript latches coverage loss when attacker-controlled cardinality caps are exceeded", () => {
  const canvasHarness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    for (let index = 0; index <= 256; index += 1) {
      new canvasHarness.Context(new canvasHarness.Canvas()).fillText("abcdefghij", 0, 0);
    }
    assert.equal(readRawSnapshot(canvasHarness.window), null);
  } finally {
    canvasHarness.restore();
  }

  const provenanceHarness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const firstSource = new provenanceHarness.Canvas();
    const secondSource = new provenanceHarness.Canvas();
    const target = new provenanceHarness.Canvas();
    const distinctText = (offset: number) =>
      Array.from({ length: 256 }, (_value, index) => String.fromCharCode(offset + index)).join("");
    new provenanceHarness.Context(firstSource).fillText(distinctText(0), 0, 0);
    new provenanceHarness.Context(secondSource).fillText(distinctText(256), 0, 0);
    const targetContext = new provenanceHarness.Context(target);
    targetContext.drawImage(firstSource, 0, 0);
    targetContext.drawImage(secondSource, 0, 0);
    assert.equal(readRawSnapshot(provenanceHarness.window), null);
  } finally {
    provenanceHarness.restore();
  }

  const sampleHarness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const context = new sampleHarness.Context(new sampleHarness.Canvas());
    for (let index = 0; index <= 128; index += 1) context.measureText(`sample-${index}`);
    assert.equal(readRawSnapshot(sampleHarness.window), null);
  } finally {
    sampleHarness.restore();
  }

  const fontHarness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const context = new fontHarness.Context(new fontHarness.Canvas());
    for (let index = 0; index <= 128; index += 1) {
      context.font = `12px font-${index}`;
      context.measureText("constant");
    }
    assert.equal(readRawSnapshot(fontHarness.window), null);
  } finally {
    fontHarness.restore();
  }
});

test("fingerprintObserverInitScript bounds only listener attribution when a listener origin bound overflows", () => {
  // The two origin bounds limit what the listener-coverage summaries can
  // retain and nothing else, so overflowing either one withholds those
  // summaries and flags the frame instead of discarding its other evidence.
  // Each case would otherwise publish input monitoring from the origins it
  // did retain.
  const registerFrom = (origin: string, input: { addEventListener(type: string, listener: () => void): void }) => {
    withStackOrigin(origin, () => {
      input.addEventListener("input", () => undefined);
      input.addEventListener("keydown", () => undefined);
      input.addEventListener("change", () => undefined);
      input.addEventListener("paste", () => undefined);
    });
  };
  const cases: Record<string, (input: { addEventListener(type: string, listener: () => void): void }) => void> = {
    "more than 128 distinct third-party origins": (input) => {
      for (let index = 0; index <= 128; index += 1) registerFrom(`https://recorder-${index}.example.net`, input);
    },
    "an origin longer than 2048 characters": (input) => {
      registerFrom("https://recorder.example.net", input);
      registerFrom(`https://${"a".repeat(2100)}.example.net`, input);
    }
  };
  for (const [label, register] of Object.entries(cases)) {
    const harness = installInteractionHarness();
    try {
      fingerprintObserverInitScript("example.com");
      register(new harness.Input());
      const raw = readRawSnapshot(harness.window);
      assert.equal(typeof raw, "string", `${label}: the frame stays readable`);
      assert.deepEqual(
        JSON.parse(raw as string),
        { detections: [], events: {}, listenerAttributionLost: true },
        label
      );
    } finally {
      harness.restore();
    }
  }
});

function frameWithEvents(events: Record<string, number>) {
  return {
    evaluate: async () => events
  };
}

function frameWithSnapshot(snapshot: {
  detections: FingerprintDetectionSummary[];
  events: Record<string, number>;
}) {
  return {
    evaluate: async () => snapshot
  };
}

function installCanvasHarness() {
  class FakeEventTarget {
    addEventListener(_type?: string, _listener?: unknown) {
      return undefined;
    }
  }

  class FakeCanvas extends FakeEventTarget {
    height = 32;
    width = 32;

    toBlob() {
      return undefined;
    }

    toDataURL() {
      return "data:image/png;base64,";
    }
  }

  class FakeImageBitmap {}

  class FakeCanvasRenderingContext2D {
    font = "10px sans-serif";

    constructor(public canvas: InstanceType<typeof FakeCanvas>) {}

    drawImage(_source?: InstanceType<typeof FakeCanvas> | InstanceType<typeof FakeImageBitmap>, _dx?: number, _dy?: number) {
      return undefined;
    }

    fillText(_text?: string, _x?: number, _y?: number) {
      return undefined;
    }

    getImageData(_sx?: number, _sy?: number, sw?: number | string, sh?: number | string) {
      return { height: Math.abs(Number(sh)), width: Math.abs(Number(sw)) };
    }

    measureText(_text?: string) {
      return { width: 12 };
    }

    restore() {
      return undefined;
    }

    save() {
      return undefined;
    }

    strokeText(_text?: string, _x?: number, _y?: number) {
      return undefined;
    }
  }

  const fakeWindow: Record<string, unknown> = {
    CanvasRenderingContext2D: FakeCanvasRenderingContext2D,
    createImageBitmap: async (_source: unknown) => new FakeImageBitmap(),
    EventTarget: FakeEventTarget,
    HTMLCanvasElement: FakeCanvas
  };
  const globals = {
    CanvasRenderingContext2D: FakeCanvasRenderingContext2D,
    EventTarget: FakeEventTarget,
    HTMLCanvasElement: FakeCanvas,
    window: fakeWindow
  };
  const previous = new Map<keyof typeof globals, PropertyDescriptor | undefined>();

  for (const [name, value] of Object.entries(globals) as [keyof typeof globals, unknown][]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true
    });
  }

  return {
    Canvas: FakeCanvas,
    Context: FakeCanvasRenderingContext2D,
    createImageBitmap: async (source: InstanceType<typeof FakeCanvas>) => {
      const createImageBitmap = fakeWindow.createImageBitmap;
      assert.equal(typeof createImageBitmap, "function");
      return (createImageBitmap as (source: InstanceType<typeof FakeCanvas>) => Promise<InstanceType<typeof FakeImageBitmap>>)(
        source
      );
    },
    restore: () => {
      for (const name of Object.keys(globals) as (keyof typeof globals)[]) {
        const descriptor = previous.get(name);
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
    },
    window: fakeWindow
  };
}

function installWebglHarness() {
  class FakeWebGLRenderingContext {
    getParameter(_parameter?: number) {
      return "renderer";
    }

    readPixels() {
      return undefined;
    }
  }

  const fakeWindow: Record<string, unknown> = {
    WebGLRenderingContext: FakeWebGLRenderingContext
  };
  const globals = {
    WebGLRenderingContext: FakeWebGLRenderingContext,
    window: fakeWindow
  };
  const previous = new Map<keyof typeof globals, PropertyDescriptor | undefined>();

  for (const [name, value] of Object.entries(globals) as [keyof typeof globals, unknown][]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true
    });
  }

  return {
    restore: () => {
      for (const name of Object.keys(globals) as (keyof typeof globals)[]) {
        const descriptor = previous.get(name);
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
    },
    WebGL: FakeWebGLRenderingContext,
    window: fakeWindow
  };
}

function installAudioHarness() {
  class FakeBaseAudioContext {
    createAnalyser() {
      return {};
    }

    createDynamicsCompressor() {
      return {};
    }

    createOscillator() {
      return {};
    }
  }

  class FakeOfflineAudioContext extends FakeBaseAudioContext {
    startRendering() {
      return Promise.resolve({});
    }
  }

  class FakeAudioContext extends FakeBaseAudioContext {}

  const fakeWindow: Record<string, unknown> = {
    AudioContext: FakeAudioContext,
    BaseAudioContext: FakeBaseAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext
  };
  const globals = {
    AudioContext: FakeAudioContext,
    BaseAudioContext: FakeBaseAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext,
    window: fakeWindow
  };
  const previous = new Map<keyof typeof globals, PropertyDescriptor | undefined>();

  for (const [name, value] of Object.entries(globals) as [keyof typeof globals, unknown][]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true
    });
  }

  return {
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext,
    restore: () => {
      for (const name of Object.keys(globals) as (keyof typeof globals)[]) {
        const descriptor = previous.get(name);
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
    },
    window: fakeWindow
  };
}

function installRtcHarness() {
  class FakePeerConnection {
    static generateCertificate() {
      return Promise.resolve({});
    }

    createDataChannel(_label?: string) {
      return {};
    }

    createOffer() {
      return Promise.resolve({});
    }

    setLocalDescription(_description?: unknown) {
      return Promise.resolve();
    }
  }

  const fakeWindow: Record<string, unknown> = {
    RTCPeerConnection: FakePeerConnection
  };
  const globals = {
    RTCPeerConnection: FakePeerConnection,
    window: fakeWindow
  };
  const previous = new Map<keyof typeof globals, PropertyDescriptor | undefined>();

  for (const [name, value] of Object.entries(globals) as [keyof typeof globals, unknown][]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true
    });
  }

  return {
    PeerConnection: FakePeerConnection,
    restore: () => {
      for (const name of Object.keys(globals) as (keyof typeof globals)[]) {
        const descriptor = previous.get(name);
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
    },
    window: fakeWindow
  };
}

function installInteractionHarness() {
  class FakeEventTarget {
    addEventListener(_type?: string, _listener?: unknown) {
      return undefined;
    }
  }

  class FakeElement extends FakeEventTarget {
    constructor(private readonly attributes: Record<string, string> = {}) {
      super();
    }

    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    }
  }

  class FakeBody extends FakeElement {}
  class FakeDocumentElement extends FakeElement {}
  class FakeInput extends FakeElement {}
  class FakeTextArea extends FakeElement {}
  class FakeDocument extends FakeEventTarget {
    body = new FakeBody();
    documentElement = new FakeDocumentElement();
  }
  class FakeWindow extends FakeEventTarget {}

  const fakeDocument = new FakeDocument();
  const fakeLocation = { hostname: "example.com" };
  const fakeWindow = new FakeWindow() as FakeWindow & Record<string, unknown>;
  fakeWindow.EventTarget = FakeEventTarget;
  fakeWindow.Document = FakeDocument;
  fakeWindow.Element = FakeElement;
  fakeWindow.HTMLInputElement = FakeInput;
  fakeWindow.HTMLTextAreaElement = FakeTextArea;
  fakeWindow.document = fakeDocument;
  fakeWindow.location = fakeLocation;

  const globals = {
    Document: FakeDocument,
    Element: FakeElement,
    EventTarget: FakeEventTarget,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    document: fakeDocument,
    location: fakeLocation,
    window: fakeWindow
  };
  const previous = new Map<keyof typeof globals, PropertyDescriptor | undefined>();

  for (const [name, value] of Object.entries(globals) as [keyof typeof globals, unknown][]) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true
    });
  }

  return {
    Input: FakeInput,
    document: fakeDocument,
    restore: () => {
      for (const name of Object.keys(globals) as (keyof typeof globals)[]) {
        const descriptor = previous.get(name);
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[name];
        }
      }
    },
    window: fakeWindow
  };
}

function withStackOrigin(
  origin: string,
  callback: () => void,
  options: {
    prepareStackTrace?: (...args: unknown[]) => unknown;
    replaceGlobalError?: boolean;
    stackTraceLimit?: number | string;
  } = {}
): void {
  const globalErrorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Error");
  const StackError = Error as ErrorConstructor & {
    prepareStackTrace?: (...args: unknown[]) => unknown;
    stackTraceLimit?: number;
  };
  const prepareStackTraceDescriptor = Object.getOwnPropertyDescriptor(StackError, "prepareStackTrace");
  const stackTraceLimitDescriptor = Object.getOwnPropertyDescriptor(StackError, "stackTraceLimit");

  if (options.prepareStackTrace) {
    Object.defineProperty(StackError, "prepareStackTrace", {
      configurable: true,
      value: options.prepareStackTrace,
      writable: true
    });
  }

  if (options.stackTraceLimit !== undefined) {
    Object.defineProperty(StackError, "stackTraceLimit", {
      configurable: true,
      value: options.stackTraceLimit,
      writable: true
    });
  }

  if (options.replaceGlobalError) {
    class PageError extends StackError {
      constructor(message?: string) {
        super(message);
        this.stack = "";
      }
    }

    Object.defineProperty(globalThis, "Error", {
      configurable: true,
      value: PageError,
      writable: true
    });
  }

  try {
    const invokeFromOrigin = Function("callback", `callback();\n//# sourceURL=${origin}/recorder.js`) as (
      callback: () => void
    ) => void;
    invokeFromOrigin(callback);
    if (options.stackTraceLimit !== undefined) {
      assert.equal(StackError.stackTraceLimit, options.stackTraceLimit);
    }
    if (options.prepareStackTrace) {
      assert.equal(StackError.prepareStackTrace, options.prepareStackTrace);
    }
  } finally {
    if (options.replaceGlobalError && globalErrorDescriptor) {
      Object.defineProperty(globalThis, "Error", globalErrorDescriptor);
    }
    if (prepareStackTraceDescriptor) {
      Object.defineProperty(StackError, "prepareStackTrace", prepareStackTraceDescriptor);
    } else {
      Reflect.deleteProperty(StackError, "prepareStackTrace");
    }
    if (stackTraceLimitDescriptor) {
      Object.defineProperty(StackError, "stackTraceLimit", stackTraceLimitDescriptor);
    } else {
      Reflect.deleteProperty(StackError, "stackTraceLimit");
    }
  }
}

function readSnapshot(fakeWindow: Record<string, unknown>): {
  detections: FingerprintDetectionSummary[];
  events: Record<string, number>;
} {
  const raw = readRawSnapshot(fakeWindow);
  assert.equal(typeof raw, "string");
  return JSON.parse(raw as string) as {
    detections: FingerprintDetectionSummary[];
    events: Record<string, number>;
  };
}

function readRawSnapshot(fakeWindow: Record<string, unknown>): unknown {
  const snapshot = fakeWindow.__siteBehaviorLabFingerprintSnapshot;
  assert.equal(typeof snapshot, "function");
  const snapshotFn = snapshot as () => unknown;
  return snapshotFn();
}
