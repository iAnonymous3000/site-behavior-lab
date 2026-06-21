import type { FingerprintDetectionSummary, FingerprintEventSummary } from "./types";
import { isRecord } from "./guards";
import { isFingerprintDetectionSummary } from "./fingerprint-detection-guard";

export type FingerprintFrameLike = {
  evaluate(pageFunction: () => unknown): Promise<unknown>;
};

export type FingerprintObservations = {
  events: FingerprintEventSummary[];
  detections: FingerprintDetectionSummary[];
};

export function fingerprintObserverInitScript(): void {
  const eventCounts: Record<string, number> = {};
  type CanvasState = {
    eventListenerCalls: number;
    fontValues: Record<string, true>;
    maxMeasuredTextLength: number;
    measuredTextSamples: Record<string, true>;
    measureTextCalls: number;
    readApis: Record<string, true>;
    restoreCalls: number;
    saveCalls: number;
    textCharacters: Record<string, true>;
    textWriteCalls: number;
  };
  type ListenerCoverageState = {
    eventTypes: Record<string, true>;
    listenerTargets: Record<string, true>;
    thirdPartyEventTypes: Record<string, true>;
    thirdPartyListenerTargets: Record<string, true>;
    thirdPartyOrigins: Record<string, true>;
    thirdPartyListenerCalls: number;
    totalListenerCalls: number;
  };
  type WebglState = {
    getParameterCalls: number;
    parameters: Record<string, true>;
    readApis: Record<string, true>;
    readPixelsCalls: number;
  };
  type AudioState = {
    analyserCalls: number;
    apis: Record<string, true>;
    compressorCalls: number;
    offlineRenderCalls: number;
    oscillatorCalls: number;
  };
  type RtcState = {
    constructorCalls: number;
    createDataChannelCalls: number;
    createOfferCalls: number;
    setLocalDescriptionCalls: number;
  };
  const canvasStates = new Map<HTMLCanvasElement, CanvasState>();
  const webglState: WebglState = {
    getParameterCalls: 0,
    parameters: {},
    readApis: {},
    readPixelsCalls: 0
  };
  const audioState: AudioState = {
    analyserCalls: 0,
    apis: {},
    compressorCalls: 0,
    offlineRenderCalls: 0,
    oscillatorCalls: 0
  };
  const rtcState: RtcState = {
    constructorCalls: 0,
    createDataChannelCalls: 0,
    createOfferCalls: 0,
    setLocalDescriptionCalls: 0
  };
  const sessionRecordingEvents = new Set([
    "click",
    "input",
    "keydown",
    "keyup",
    "mousedown",
    "mousemove",
    "mouseup",
    "pointerdown",
    "pointermove",
    "pointerup",
    "scroll",
    "selectionchange",
    "touchmove",
    "touchstart",
    "visibilitychange",
    "wheel"
  ]);
  const inputMonitoringEvents = new Set(["beforeinput", "change", "input", "keydown", "keypress", "keyup", "paste"]);
  const broadListenerTargets = new Set(["body", "document", "documentElement", "window"]);
  const inputListenerTargets = new Set(["contenteditable", "input", "textarea"]);
  const sessionRecordingState: ListenerCoverageState = {
    eventTypes: {},
    listenerTargets: {},
    thirdPartyEventTypes: {},
    thirdPartyListenerTargets: {},
    thirdPartyOrigins: {},
    thirdPartyListenerCalls: 0,
    totalListenerCalls: 0
  };
  const inputMonitoringState: ListenerCoverageState = {
    eventTypes: {},
    listenerTargets: {},
    thirdPartyEventTypes: {},
    thirdPartyListenerTargets: {},
    thirdPartyOrigins: {},
    thirdPartyListenerCalls: 0,
    totalListenerCalls: 0
  };

  Object.defineProperty(window, "__siteBehaviorLabFingerprintEvents", {
    configurable: false,
    value: eventCounts
  });

  const getCanvasState = (canvas: HTMLCanvasElement): CanvasState => {
    let state = canvasStates.get(canvas);
    if (!state) {
      state = {
        eventListenerCalls: 0,
        fontValues: {},
        maxMeasuredTextLength: 0,
        measuredTextSamples: {},
        measureTextCalls: 0,
        readApis: {},
        restoreCalls: 0,
        saveCalls: 0,
        textCharacters: {},
        textWriteCalls: 0
      };
      canvasStates.set(canvas, state);
    }
    return state;
  };

  const getCanvasFromContext = (context: unknown): HTMLCanvasElement | null => {
    if (!context || typeof context !== "object" || !("canvas" in context)) return null;
    const canvas = (context as { canvas?: unknown }).canvas;
    return "HTMLCanvasElement" in window && canvas instanceof HTMLCanvasElement ? canvas : null;
  };

  const distinctTextCharacters = (state: CanvasState) => Object.keys(state.textCharacters).length;

  const isAtLeast16By16 = (width: unknown, height: unknown) =>
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    Math.abs(width) >= 16 &&
    Math.abs(height) >= 16;

  const summarizeCanvasDetections = (): FingerprintDetectionSummary[] => {
    const matches = Array.from(canvasStates.entries()).filter(([canvas, state]) => {
      const readApis = Object.keys(state.readApis);
      return (
        canvas.width >= 16 &&
        canvas.height >= 16 &&
        distinctTextCharacters(state) >= 10 &&
        readApis.length > 0 &&
        state.saveCalls === 0 &&
        state.restoreCalls === 0 &&
        state.eventListenerCalls === 0
      );
    });

    if (matches.length === 0) return [];

    const readApis = new Set<string>();
    let maxCanvasWidth = 0;
    let maxCanvasHeight = 0;
    let maxDistinctTextCharacters = 0;
    let maxTextWriteCalls = 0;

    for (const [canvas, state] of matches) {
      for (const api of Object.keys(state.readApis)) readApis.add(api);
      maxCanvasWidth = Math.max(maxCanvasWidth, canvas.width);
      maxCanvasHeight = Math.max(maxCanvasHeight, canvas.height);
      maxDistinctTextCharacters = Math.max(maxDistinctTextCharacters, distinctTextCharacters(state));
      maxTextWriteCalls = Math.max(maxTextWriteCalls, state.textWriteCalls);
    }

    return [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: matches.length,
        evidence: {
          readApis: Array.from(readApis).sort(),
          maxCanvasWidth,
          maxCanvasHeight,
          maxDistinctTextCharacters,
          maxTextWriteCalls
        }
      }
    ];
  };

  const summarizeCanvasFontDetections = (): FingerprintDetectionSummary[] => {
    const matches = Array.from(canvasStates.values()).filter((state) => {
      return (
        state.measureTextCalls >= 8 &&
        Object.keys(state.fontValues).length >= 4 &&
        Object.keys(state.measuredTextSamples).length >= 1
      );
    });

    if (matches.length === 0) return [];

    let measureTextCalls = 0;
    let maxDistinctFonts = 0;
    let maxDistinctTextSamples = 0;
    let maxTextLength = 0;

    for (const state of matches) {
      measureTextCalls += state.measureTextCalls;
      maxDistinctFonts = Math.max(maxDistinctFonts, Object.keys(state.fontValues).length);
      maxDistinctTextSamples = Math.max(maxDistinctTextSamples, Object.keys(state.measuredTextSamples).length);
      maxTextLength = Math.max(maxTextLength, state.maxMeasuredTextLength);
    }

    return [
      {
        kind: "canvas-font-fingerprinting",
        heuristic: "canvas-font-probing-v1",
        count: matches.length,
        evidence: {
          measureTextCalls,
          maxDistinctFonts,
          maxDistinctTextSamples,
          maxTextLength
        }
      }
    ];
  };

  const sortedKeys = (record: Record<string, true>) => Object.keys(record).sort();

  const summarizeHighEntropyDetections = (): FingerprintDetectionSummary[] => {
    const detections: FingerprintDetectionSummary[] = [];
    const webglParameters = sortedKeys(webglState.parameters);
    const webglReadApis = sortedKeys(webglState.readApis);
    const audioApis = sortedKeys(audioState.apis);

    if (webglParameters.length > 0 || webglState.readPixelsCalls > 0) {
      detections.push({
        kind: "webgl-fingerprinting",
        heuristic: "webgl-entropy-read-v1",
        count: 1,
        evidence: {
          readApis: webglReadApis,
          parameters: webglParameters,
          getParameterCalls: webglState.getParameterCalls,
          readPixelsCalls: webglState.readPixelsCalls
        }
      });
    }

    if (audioState.offlineRenderCalls > 0 && audioApis.length >= 2) {
      detections.push({
        kind: "audio-fingerprinting",
        heuristic: "audio-rendering-v1",
        count: 1,
        evidence: {
          apis: audioApis,
          offlineRenderCalls: audioState.offlineRenderCalls,
          oscillatorCalls: audioState.oscillatorCalls,
          compressorCalls: audioState.compressorCalls,
          analyserCalls: audioState.analyserCalls
        }
      });
    }

    if (
      rtcState.constructorCalls > 0 &&
      (rtcState.createDataChannelCalls > 0 || rtcState.createOfferCalls > 0 || rtcState.setLocalDescriptionCalls > 0)
    ) {
      detections.push({
        kind: "webrtc-fingerprinting",
        heuristic: "webrtc-peerconnection-v1",
        count: 1,
        evidence: {
          constructorCalls: rtcState.constructorCalls,
          createDataChannelCalls: rtcState.createDataChannelCalls,
          createOfferCalls: rtcState.createOfferCalls,
          setLocalDescriptionCalls: rtcState.setLocalDescriptionCalls
        }
      });
    }

    return detections;
  };

  const summarizeInteractionDetections = (): FingerprintDetectionSummary[] => {
    const detections: FingerprintDetectionSummary[] = [];
    const sessionEventTypes = sortedKeys(sessionRecordingState.thirdPartyEventTypes);
    const sessionTargets = sortedKeys(sessionRecordingState.thirdPartyListenerTargets);
    const sessionOrigins = sortedKeys(sessionRecordingState.thirdPartyOrigins);
    const inputEventTypes = sortedKeys(inputMonitoringState.thirdPartyEventTypes);
    const inputTargets = sortedKeys(inputMonitoringState.thirdPartyListenerTargets);
    const inputOrigins = sortedKeys(inputMonitoringState.thirdPartyOrigins);
    const broadSessionTargets = sessionTargets.some((target) => broadListenerTargets.has(target));
    const inputTargetMatched = inputTargets.some((target) => inputListenerTargets.has(target) || broadListenerTargets.has(target));
    const inputEventsIncludeTextSignals = inputEventTypes.some((eventType) =>
      ["beforeinput", "input", "keydown", "keypress", "keyup", "paste"].includes(eventType)
    );

    if (
      sessionRecordingState.thirdPartyListenerCalls >= 8 &&
      sessionEventTypes.length >= 5 &&
      broadSessionTargets &&
      sessionOrigins.length > 0
    ) {
      detections.push({
        kind: "session-recording",
        heuristic: "interaction-listener-coverage-v1",
        count: 1,
        evidence: {
          eventTypes: sessionEventTypes,
          listenerTargets: sessionTargets,
          thirdPartyOrigins: sessionOrigins,
          totalListenerCalls: sessionRecordingState.thirdPartyListenerCalls
        }
      });
    }

    if (
      inputMonitoringState.thirdPartyListenerCalls >= 4 &&
      inputEventTypes.length >= 2 &&
      inputOrigins.length > 0 &&
      inputTargetMatched &&
      inputEventsIncludeTextSignals
    ) {
      detections.push({
        kind: "input-monitoring",
        heuristic: "input-listener-coverage-v1",
        count: 1,
        evidence: {
          eventTypes: inputEventTypes,
          listenerTargets: inputTargets,
          thirdPartyOrigins: inputOrigins,
          totalListenerCalls: inputMonitoringState.thirdPartyListenerCalls
        }
      });
    }

    return detections;
  };

  Object.defineProperty(window, "__siteBehaviorLabFingerprintSnapshot", {
    configurable: false,
    value: () => ({
      detections: [
        ...summarizeCanvasDetections(),
        ...summarizeCanvasFontDetections(),
        ...summarizeHighEntropyDetections(),
        ...summarizeInteractionDetections()
      ],
      events: { ...eventCounts }
    })
  });

  const record = (api: string) => {
    eventCounts[api] = (eventCounts[api] || 0) + 1;
  };

  const defineWrappedMethod = (
    target: object,
    key: string,
    descriptor: PropertyDescriptor,
    value: (...args: unknown[]) => unknown
  ) => {
    Object.defineProperty(target, key, {
      ...descriptor,
      value,
      writable: true
    });
  };

  const wrapCanvasReadMethod = (
    target: object | undefined,
    key: string,
    api: "canvas.getImageData" | "canvas.toBlob" | "canvas.toDataURL",
    canvasForThis: (thisValue: unknown) => HTMLCanvasElement | null,
    qualifies: (args: unknown[]) => boolean = () => true
  ) => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedCanvasReadMethod(this: unknown, ...args: unknown[]) {
      record(api);
      const canvas = canvasForThis(this);
      if (canvas && qualifies(args)) {
        getCanvasState(canvas).readApis[api] = true;
      }
      return descriptor.value.apply(this, args);
    });
  };

  const wrapCanvasTextMethod = (target: object | undefined, key: "fillText" | "strokeText") => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedCanvasTextMethod(this: unknown, ...args: unknown[]) {
      const canvas = getCanvasFromContext(this);
      if (canvas) {
        const state = getCanvasState(canvas);
        state.textWriteCalls += 1;
        for (const character of Array.from(String(args[0] ?? ""))) {
          state.textCharacters[character] = true;
        }
      }
      return descriptor.value.apply(this, args);
    });
  };

  const wrapCanvasMeasureTextMethod = (target: object | undefined) => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, "measureText");
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, "measureText", descriptor, function wrappedCanvasMeasureText(this: unknown, ...args: unknown[]) {
      record("canvas.measureText");
      const canvas = getCanvasFromContext(this);
      if (canvas) {
        const state = getCanvasState(canvas);
        const measuredText = String(args[0] ?? "");
        state.measureTextCalls += 1;
        state.measuredTextSamples[measuredText] = true;
        state.maxMeasuredTextLength = Math.max(state.maxMeasuredTextLength, measuredText.length);

        const contextFont = (this as { font?: unknown })?.font;
        if (typeof contextFont === "string" && contextFont.trim()) {
          state.fontValues[contextFont.trim()] = true;
        }
      }
      return descriptor.value.apply(this, args);
    });
  };

  const wrapCanvasStateMethod = (target: object | undefined, key: "restore" | "save") => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedCanvasStateMethod(this: unknown, ...args: unknown[]) {
      const canvas = getCanvasFromContext(this);
      if (canvas) {
        const state = getCanvasState(canvas);
        if (key === "save") state.saveCalls += 1;
        if (key === "restore") state.restoreCalls += 1;
      }
      return descriptor.value.apply(this, args);
    });
  };

  const classifyListenerTarget = (target: unknown): string => {
    const browserWindow = window as Window & {
      Document?: typeof Document;
      Element?: typeof Element;
      HTMLInputElement?: typeof HTMLInputElement;
      HTMLTextAreaElement?: typeof HTMLTextAreaElement;
      document?: Document;
    };
    const documentValue = browserWindow.document;

    if (target === window) return "window";
    if (documentValue && target === documentValue) return "document";
    if (documentValue?.documentElement && target === documentValue.documentElement) return "documentElement";
    if (documentValue?.body && target === documentValue.body) return "body";
    if (browserWindow.HTMLInputElement && target instanceof browserWindow.HTMLInputElement) return "input";
    if (browserWindow.HTMLTextAreaElement && target instanceof browserWindow.HTMLTextAreaElement) return "textarea";
    if (
      browserWindow.Element &&
      target instanceof browserWindow.Element &&
      (target.getAttribute("contenteditable") === "true" || target.getAttribute("contenteditable") === "")
    ) {
      return "contenteditable";
    }

    return "other";
  };

  const sameSiteHost = (left: string, right: string) =>
    left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);

  const scriptOriginFromStack = (): string | null => {
    const stack = new Error().stack || "";
    for (const line of stack.split("\n")) {
      if (line.includes("wrappedAddEventListener") || line.includes("recordListenerCoverage")) continue;
      const match = line.match(/https?:\/\/[^\s)]+/);
      if (!match) continue;

      const rawUrl = match[0].replace(/:\d+:\d+$/, "");
      try {
        const parsed = new URL(rawUrl);
        return parsed.origin;
      } catch {
        /* keep looking */
      }
    }

    return null;
  };

  const isThirdPartyOrigin = (origin: string | null): origin is string => {
    if (!origin) return false;

    try {
      const script = new URL(origin);
      if (script.protocol !== "http:" && script.protocol !== "https:") return false;
      if (!location.hostname) return false;
      return !sameSiteHost(script.hostname, location.hostname);
    } catch {
      return false;
    }
  };

  const recordCoverage = (state: ListenerCoverageState, eventType: string, targetType: string, thirdPartyOrigin: string | null) => {
    state.eventTypes[eventType] = true;
    state.listenerTargets[targetType] = true;
    state.totalListenerCalls += 1;

    if (!thirdPartyOrigin) return;
    state.thirdPartyEventTypes[eventType] = true;
    state.thirdPartyListenerTargets[targetType] = true;
    state.thirdPartyOrigins[thirdPartyOrigin] = true;
    state.thirdPartyListenerCalls += 1;
  };

  const recordListenerCoverage = (eventTypeValue: unknown, target: unknown) => {
    if (typeof eventTypeValue !== "string") return;
    const eventType = eventTypeValue.toLowerCase();
    const targetType = classifyListenerTarget(target);
    const scriptOrigin = scriptOriginFromStack();
    const thirdPartyOrigin = isThirdPartyOrigin(scriptOrigin) ? scriptOrigin : null;

    if (sessionRecordingEvents.has(eventType)) {
      recordCoverage(sessionRecordingState, eventType, targetType, thirdPartyOrigin);
    }

    if (inputMonitoringEvents.has(eventType)) {
      recordCoverage(inputMonitoringState, eventType, targetType, thirdPartyOrigin);
    }
  };

  const wrapEventTargetAddEventListener = () => {
    if (!("EventTarget" in window)) return;
    const descriptor = Object.getOwnPropertyDescriptor(EventTarget.prototype, "addEventListener");
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(EventTarget.prototype, "addEventListener", descriptor, function wrappedAddEventListener(this: unknown, ...args: unknown[]) {
      recordListenerCoverage(args[0], this);
      if ("HTMLCanvasElement" in window && this instanceof HTMLCanvasElement) {
        getCanvasState(this).eventListenerCalls += 1;
      }
      return descriptor.value.apply(this, args);
    });
  };

  const wrapWebglGetParameter = (target: object | undefined, key: string, api: string) => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedWebglGetParameter(this: unknown, ...args: unknown[]) {
      const parameter = args[0];
      webglState.getParameterCalls += 1;
      if (parameter === 37445) {
        const parameterName = `${api}.UNMASKED_VENDOR_WEBGL`;
        record(parameterName);
        webglState.parameters[parameterName] = true;
      }
      if (parameter === 37446) {
        const parameterName = `${api}.UNMASKED_RENDERER_WEBGL`;
        record(parameterName);
        webglState.parameters[parameterName] = true;
      }
      return descriptor.value.apply(this, args);
    });
  };

  const wrapWebglReadPixels = (target: object | undefined, key: string, api: string) => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedWebglReadPixels(this: unknown, ...args: unknown[]) {
      record(api);
      webglState.readApis[api] = true;
      webglState.readPixelsCalls += 1;
      return descriptor.value.apply(this, args);
    });
  };

  const wrapAudioMethod = (
    target: object | undefined,
    key: "createAnalyser" | "createDynamicsCompressor" | "createOscillator" | "startRendering",
    api: string
  ) => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedAudioMethod(this: unknown, ...args: unknown[]) {
      record(api);
      audioState.apis[api] = true;
      if (key === "createAnalyser") audioState.analyserCalls += 1;
      if (key === "createDynamicsCompressor") audioState.compressorCalls += 1;
      if (key === "createOscillator") audioState.oscillatorCalls += 1;
      if (key === "startRendering") audioState.offlineRenderCalls += 1;
      return descriptor.value.apply(this, args);
    });
  };

  const wrapRtcMethod = (
    target: object | undefined,
    key: "createDataChannel" | "createOffer" | "setLocalDescription",
    api: string
  ) => {
    if (!target) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedRtcMethod(this: unknown, ...args: unknown[]) {
      record(api);
      if (key === "createDataChannel") rtcState.createDataChannelCalls += 1;
      if (key === "createOffer") rtcState.createOfferCalls += 1;
      if (key === "setLocalDescription") rtcState.setLocalDescriptionCalls += 1;
      return descriptor.value.apply(this, args);
    });
  };

  if ("HTMLCanvasElement" in window) {
    wrapCanvasReadMethod(HTMLCanvasElement.prototype, "toDataURL", "canvas.toDataURL", (canvas) =>
      canvas instanceof HTMLCanvasElement ? canvas : null
    );
    wrapCanvasReadMethod(HTMLCanvasElement.prototype, "toBlob", "canvas.toBlob", (canvas) =>
      canvas instanceof HTMLCanvasElement ? canvas : null
    );
  }

  if ("CanvasRenderingContext2D" in window) {
    wrapCanvasReadMethod(
      CanvasRenderingContext2D.prototype,
      "getImageData",
      "canvas.getImageData",
      getCanvasFromContext,
      (args) => isAtLeast16By16(args[2], args[3])
    );
    wrapCanvasTextMethod(CanvasRenderingContext2D.prototype, "fillText");
    wrapCanvasTextMethod(CanvasRenderingContext2D.prototype, "strokeText");
    wrapCanvasMeasureTextMethod(CanvasRenderingContext2D.prototype);
    wrapCanvasStateMethod(CanvasRenderingContext2D.prototype, "restore");
    wrapCanvasStateMethod(CanvasRenderingContext2D.prototype, "save");
  }

  wrapEventTargetAddEventListener();

  if ("WebGLRenderingContext" in window) {
    wrapWebglGetParameter(WebGLRenderingContext.prototype, "getParameter", "webgl.getParameter");
    wrapWebglReadPixels(WebGLRenderingContext.prototype, "readPixels", "webgl.readPixels");
  }

  if ("WebGL2RenderingContext" in window) {
    wrapWebglGetParameter(WebGL2RenderingContext.prototype, "getParameter", "webgl2.getParameter");
    wrapWebglReadPixels(WebGL2RenderingContext.prototype, "readPixels", "webgl2.readPixels");
  }

  if ("OfflineAudioContext" in window) {
    wrapAudioMethod(OfflineAudioContext.prototype, "createAnalyser", "audio.OfflineAudioContext.createAnalyser");
    wrapAudioMethod(
      OfflineAudioContext.prototype,
      "createDynamicsCompressor",
      "audio.OfflineAudioContext.createDynamicsCompressor"
    );
    wrapAudioMethod(OfflineAudioContext.prototype, "createOscillator", "audio.OfflineAudioContext.createOscillator");
    wrapAudioMethod(OfflineAudioContext.prototype, "startRendering", "audio.OfflineAudioContext.startRendering");
  }

  if ("AudioContext" in window) {
    wrapAudioMethod(AudioContext.prototype, "createAnalyser", "audio.createAnalyser");
  }

  type RtcWindow = Window & {
    RTCPeerConnection?: typeof RTCPeerConnection;
    webkitRTCPeerConnection?: typeof RTCPeerConnection;
  };

  const patchPeerConnection = (name: "RTCPeerConnection" | "webkitRTCPeerConnection") => {
    const rtcWindow = window as RtcWindow;
    const OriginalPeerConnection = rtcWindow[name];
    if (!OriginalPeerConnection) return;
    wrapRtcMethod(OriginalPeerConnection.prototype, "createDataChannel", "webrtc.RTCPeerConnection.createDataChannel");
    wrapRtcMethod(OriginalPeerConnection.prototype, "createOffer", "webrtc.RTCPeerConnection.createOffer");
    wrapRtcMethod(OriginalPeerConnection.prototype, "setLocalDescription", "webrtc.RTCPeerConnection.setLocalDescription");

    const PatchedPeerConnection = function patched(this: RTCPeerConnection, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
      record("webrtc.RTCPeerConnection");
      rtcState.constructorCalls += 1;
      return new OriginalPeerConnection(...args);
    } as unknown as typeof RTCPeerConnection;

    PatchedPeerConnection.prototype = OriginalPeerConnection.prototype;
    if (typeof OriginalPeerConnection.generateCertificate === "function") {
      PatchedPeerConnection.generateCertificate = OriginalPeerConnection.generateCertificate.bind(OriginalPeerConnection);
    }
    rtcWindow[name] = PatchedPeerConnection;
  };

  patchPeerConnection("RTCPeerConnection");
  patchPeerConnection("webkitRTCPeerConnection");
}

export async function collectFingerprintObservationsFromFrames(frames: FingerprintFrameLike[]): Promise<FingerprintObservations> {
  const merged = new Map<string, number>();
  const detections = new Map<FingerprintDetectionSummary["kind"], FingerprintDetectionSummary>();

  for (const frame of frames) {
    const snapshot = await frame
      .evaluate(() => {
        type FingerprintWindow = Window & {
          __siteBehaviorLabFingerprintEvents?: Record<string, number>;
          __siteBehaviorLabFingerprintSnapshot?: () => {
            detections?: FingerprintDetectionSummary[];
            events?: Record<string, number>;
          };
        };
        const fingerprintWindow = window as FingerprintWindow;
        return fingerprintWindow.__siteBehaviorLabFingerprintSnapshot?.() ?? fingerprintWindow.__siteBehaviorLabFingerprintEvents ?? {};
      })
      .catch(() => ({}));

    const { events, detections: frameDetections } = normalizeFingerprintSnapshot(snapshot);
    for (const [api, count] of Object.entries(events)) {
      merged.set(api, (merged.get(api) ?? 0) + count);
    }
    for (const detection of frameDetections) {
      mergeFingerprintDetection(detections, detection);
    }
  }

  return {
    events: Array.from(merged.entries())
      .map(([api, count]) => ({ api, count }))
      .sort((a, b) => b.count - a.count || a.api.localeCompare(b.api)),
    detections: Array.from(detections.values()).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
  };
}

export async function collectFingerprintEventsFromFrames(frames: FingerprintFrameLike[]): Promise<FingerprintEventSummary[]> {
  return (await collectFingerprintObservationsFromFrames(frames)).events;
}

function normalizeFingerprintSnapshot(snapshot: unknown): {
  detections: FingerprintDetectionSummary[];
  events: Record<string, number>;
} {
  if (!isRecord(snapshot)) return { detections: [], events: {} };

  if (isRecord(snapshot.events) || Array.isArray(snapshot.detections)) {
    return {
      detections: Array.isArray(snapshot.detections) ? snapshot.detections.filter(isFingerprintDetectionSummary) : [],
      events: isRecord(snapshot.events) ? numericRecord(snapshot.events) : {}
    };
  }

  return {
    detections: [],
    events: numericRecord(snapshot)
  };
}

function numericRecord(value: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item) && item > 0) {
      result[key] = item;
    }
  }
  return result;
}

// Fingerprint-detection validation lives in ./fingerprint-detection-guard (shared
// with report-validation) so the in-page snapshot and uploaded reports validate
// detections identically. The shared module uses the stricter finite-number and
// http(s)-origin checks; the in-page observer only ever emits finite counts and
// http(s) script origins, so genuine detections still pass.

function mergeFingerprintDetection(
  detections: Map<FingerprintDetectionSummary["kind"], FingerprintDetectionSummary>,
  detection: FingerprintDetectionSummary
) {
  const existing = detections.get(detection.kind);
  if (!existing) {
    detections.set(detection.kind, cloneFingerprintDetection(detection));
    return;
  }

  if (existing.kind === "canvas-fingerprinting" && detection.kind === "canvas-fingerprinting") {
    detections.set(detection.kind, {
      ...existing,
      count: existing.count + detection.count,
      evidence: {
        readApis: Array.from(new Set([...existing.evidence.readApis, ...detection.evidence.readApis])).sort(),
        maxCanvasWidth: Math.max(existing.evidence.maxCanvasWidth, detection.evidence.maxCanvasWidth),
        maxCanvasHeight: Math.max(existing.evidence.maxCanvasHeight, detection.evidence.maxCanvasHeight),
        maxDistinctTextCharacters: Math.max(
          existing.evidence.maxDistinctTextCharacters,
          detection.evidence.maxDistinctTextCharacters
        ),
        maxTextWriteCalls: Math.max(existing.evidence.maxTextWriteCalls, detection.evidence.maxTextWriteCalls)
      }
    });
    return;
  }

  if (existing.kind === "canvas-font-fingerprinting" && detection.kind === "canvas-font-fingerprinting") {
    detections.set(detection.kind, {
      ...existing,
      count: existing.count + detection.count,
      evidence: {
        measureTextCalls: existing.evidence.measureTextCalls + detection.evidence.measureTextCalls,
        maxDistinctFonts: Math.max(existing.evidence.maxDistinctFonts, detection.evidence.maxDistinctFonts),
        maxDistinctTextSamples: Math.max(existing.evidence.maxDistinctTextSamples, detection.evidence.maxDistinctTextSamples),
        maxTextLength: Math.max(existing.evidence.maxTextLength, detection.evidence.maxTextLength)
      }
    });
    return;
  }

  if (existing.kind === "webgl-fingerprinting" && detection.kind === "webgl-fingerprinting") {
    detections.set(detection.kind, {
      ...existing,
      count: existing.count + detection.count,
      evidence: {
        readApis: Array.from(new Set([...existing.evidence.readApis, ...detection.evidence.readApis])).sort(),
        parameters: Array.from(new Set([...existing.evidence.parameters, ...detection.evidence.parameters])).sort(),
        getParameterCalls: existing.evidence.getParameterCalls + detection.evidence.getParameterCalls,
        readPixelsCalls: existing.evidence.readPixelsCalls + detection.evidence.readPixelsCalls
      }
    });
    return;
  }

  if (existing.kind === "audio-fingerprinting" && detection.kind === "audio-fingerprinting") {
    detections.set(detection.kind, {
      ...existing,
      count: existing.count + detection.count,
      evidence: {
        apis: Array.from(new Set([...existing.evidence.apis, ...detection.evidence.apis])).sort(),
        offlineRenderCalls: existing.evidence.offlineRenderCalls + detection.evidence.offlineRenderCalls,
        oscillatorCalls: existing.evidence.oscillatorCalls + detection.evidence.oscillatorCalls,
        compressorCalls: existing.evidence.compressorCalls + detection.evidence.compressorCalls,
        analyserCalls: existing.evidence.analyserCalls + detection.evidence.analyserCalls
      }
    });
    return;
  }

  if (existing.kind === "webrtc-fingerprinting" && detection.kind === "webrtc-fingerprinting") {
    detections.set(detection.kind, {
      ...existing,
      count: existing.count + detection.count,
      evidence: {
        constructorCalls: existing.evidence.constructorCalls + detection.evidence.constructorCalls,
        createDataChannelCalls: existing.evidence.createDataChannelCalls + detection.evidence.createDataChannelCalls,
        createOfferCalls: existing.evidence.createOfferCalls + detection.evidence.createOfferCalls,
        setLocalDescriptionCalls: existing.evidence.setLocalDescriptionCalls + detection.evidence.setLocalDescriptionCalls
      }
    });
    return;
  }

  if (
    (existing.kind === "session-recording" || existing.kind === "input-monitoring") &&
    (detection.kind === "session-recording" || detection.kind === "input-monitoring")
  ) {
    detections.set(detection.kind, {
      ...existing,
      count: existing.count + detection.count,
      evidence: {
        eventTypes: Array.from(new Set([...existing.evidence.eventTypes, ...detection.evidence.eventTypes])).sort(),
        listenerTargets: Array.from(new Set([...existing.evidence.listenerTargets, ...detection.evidence.listenerTargets])).sort(),
        thirdPartyOrigins: Array.from(new Set([...existing.evidence.thirdPartyOrigins, ...detection.evidence.thirdPartyOrigins])).sort(),
        totalListenerCalls: existing.evidence.totalListenerCalls + detection.evidence.totalListenerCalls
      }
    });
  }
}

function cloneFingerprintDetection(detection: FingerprintDetectionSummary): FingerprintDetectionSummary {
  if (detection.kind === "canvas-fingerprinting") {
    return {
      ...detection,
      evidence: {
        ...detection.evidence,
        readApis: [...detection.evidence.readApis].sort()
      }
    };
  }

  if (detection.kind === "canvas-font-fingerprinting") {
    return {
      ...detection,
      evidence: {
        ...detection.evidence
      }
    };
  }

  if (detection.kind === "webgl-fingerprinting") {
    return {
      ...detection,
      evidence: {
        ...detection.evidence,
        parameters: [...detection.evidence.parameters].sort(),
        readApis: [...detection.evidence.readApis].sort()
      }
    };
  }

  if (detection.kind === "audio-fingerprinting") {
    return {
      ...detection,
      evidence: {
        ...detection.evidence,
        apis: [...detection.evidence.apis].sort()
      }
    };
  }

  if (detection.kind === "webrtc-fingerprinting") {
    return {
      ...detection,
      evidence: {
        ...detection.evidence
      }
    };
  }

  return {
    ...detection,
    evidence: {
      ...detection.evidence,
      eventTypes: [...detection.evidence.eventTypes].sort(),
      listenerTargets: [...detection.evidence.listenerTargets].sort(),
      thirdPartyOrigins: [...detection.evidence.thirdPartyOrigins].sort()
    }
  };
}
