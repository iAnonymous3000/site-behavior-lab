import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  collectFingerprintObservationsWithCoverage,
  fingerprintObserverInitScript
} from "./fingerprint-observer";
import type { FingerprintDetectionSummary } from "./types";

// The production API returns observations plus frame-coverage counters; these
// merging tests only assert on the observations half.
async function collectFingerprintObservationsFromFrames(
  frames: Parameters<typeof collectFingerprintObservationsWithCoverage>[0]
) {
  return (await collectFingerprintObservationsWithCoverage(frames)).observations;
}

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
    readableFrames: 1
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
// attribution). Only the pad depth varies.
async function coverageWithPaddedWrapper(padDepth: number) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(fingerprintObserverInitScript, "example.com");
    const page = await context.newPage();
    await page.route("https://example.com/**", (route) =>
      route.fulfill({
        body:
          '<input id="field">' +
          '<script src="https://example.com/wrapper.js"></script>' +
          '<script src="https://recorder.example.net/recorder.js"></script>' +
          '<script>setTimeout(() => window.registerRecorder(), 0)</script>',
        contentType: "text/html"
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
  // frame must report no snapshot (readableFrames 0), which the scanner
  // publishes as partial fingerprint coverage with capture loss. A clean
  // complete read here would let any page hide a registrant behind a deep
  // first-party wrapper.
  const coverage = await coverageWithPaddedWrapper(100);
  assert.equal(coverage.attemptedFrames, 1);
  assert.equal(coverage.readableFrames, 0);
  assert.deepEqual(coverage.observations.detections, []);
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

test("fingerprintObserverInitScript records coverage loss when the page wraps addEventListener above the observer", () => {
  const harness = installInteractionHarness();
  try {
    fingerprintObserverInitScript();
    const eventTarget = harness.window.EventTarget as {
      prototype: { addEventListener: (...args: unknown[]) => unknown };
    };
    const observerWrapper = eventTarget.prototype.addEventListener;
    // A RUM or error agent instruments EventTarget.prototype.addEventListener
    // after the observer. Every stack the observer captures now leads to that
    // agent, so the site's own listeners would be published under its name.
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

    assert.equal(readRawSnapshot(harness.window), null);
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

  const originHarness = installInteractionHarness();
  try {
    fingerprintObserverInitScript("example.com");
    const input = new originHarness.Input();
    for (let index = 0; index <= 128; index += 1) {
      withStackOrigin(`https://recorder-${index}.example.net`, () => {
        input.addEventListener("input", () => undefined);
      });
    }
    assert.equal(readRawSnapshot(originHarness.window), null);
  } finally {
    originHarness.restore();
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
