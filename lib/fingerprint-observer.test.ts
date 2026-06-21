import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectFingerprintEventsFromFrames,
  collectFingerprintObservationsFromFrames,
  fingerprintObserverInitScript
} from "./fingerprint-observer";
import type { FingerprintDetectionSummary } from "./types";

test("collectFingerprintEventsFromFrames merges, sorts, and ignores inaccessible frames", async () => {
  const events = await collectFingerprintEventsFromFrames([
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

test("fingerprintObserverInitScript flags offline audio rendering signatures", () => {
  const harness = installAudioHarness();
  try {
    fingerprintObserverInitScript();
    const context = new harness.OfflineAudioContext();

    context.createOscillator();
    context.createDynamicsCompressor();
    context.startRendering();

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
    largeContext.getImageData(0, 0, 16, 16);

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

test("fingerprintObserverInitScript does not flag canvases with save or restore calls", () => {
  const harness = installCanvasHarness();
  try {
    fingerprintObserverInitScript();
    const canvas = new harness.Canvas();
    const context = new harness.Context(canvas);

    context.save();
    context.fillText("abcdefghij", 0, 0);
    canvas.toDataURL();

    const snapshot = readSnapshot(harness.window);
    assert.deepEqual(snapshot.detections, []);
    assert.equal(snapshot.events["canvas.toDataURL"], 1);
  } finally {
    harness.restore();
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

  class FakeCanvasRenderingContext2D {
    font = "10px sans-serif";

    constructor(public canvas: InstanceType<typeof FakeCanvas>) {}

    fillText(_text?: string, _x?: number, _y?: number) {
      return undefined;
    }

    getImageData(_sx?: number, _sy?: number, _sw?: number, _sh?: number) {
      return {};
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
  class FakeOfflineAudioContext {
    createAnalyser() {
      return {};
    }

    createDynamicsCompressor() {
      return {};
    }

    createOscillator() {
      return {};
    }

    startRendering() {
      return Promise.resolve({});
    }
  }

  const fakeWindow: Record<string, unknown> = {
    OfflineAudioContext: FakeOfflineAudioContext
  };
  const globals = {
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

function withStackOrigin(origin: string, callback: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Error");
  const OriginalError = Error;

  class FakeStackError extends OriginalError {
    constructor(message?: string) {
      super(message);
      this.stack = `Error\n    at wrappedAddEventListener (<anonymous>:1:1)\n    at install (${origin}/recorder.js:10:5)`;
    }
  }

  Object.defineProperty(globalThis, "Error", {
    configurable: true,
    value: FakeStackError,
    writable: true
  });

  try {
    callback();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "Error", descriptor);
    } else {
      delete (globalThis as Record<string, unknown>).Error;
    }
  }
}

function readSnapshot(fakeWindow: Record<string, unknown>): {
  detections: FingerprintDetectionSummary[];
  events: Record<string, number>;
} {
  const snapshot = fakeWindow.__siteBehaviorLabFingerprintSnapshot;
  assert.equal(typeof snapshot, "function");
  const snapshotFn = snapshot as () => {
    detections: FingerprintDetectionSummary[];
    events: Record<string, number>;
  };
  return snapshotFn();
}
