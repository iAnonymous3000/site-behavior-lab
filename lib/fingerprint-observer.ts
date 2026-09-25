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

export type FingerprintObservationCollection = {
  observations: FingerprintObservations;
  attemptedFrames: number;
  readableFrames: number;
  /**
   * Readable frames whose listener attribution was bounded: at least one
   * tracked registration could not be attributed, so the frame's
   * session-recording and input-monitoring summaries were withheld while its
   * other detections and event counts were kept. Detector coverage is
   * incomplete whenever this is non-zero, even with every frame readable.
   */
  listenerAttributionLostFrames: number;
};

/**
 * Injected into every page before navigation (Playwright serializes the
 * function; `firstPartySiteKey` travels as the init-script argument).
 *
 * `firstPartySiteKey` is the scanned site's registrable domain (computed with
 * the real public-suffix list in Node, e.g. "capitalone.com"), so the in-page
 * listener-origin classification can recognize same-site siblings such as
 * verified.capitalone.com vs www.capitalone.com without shipping a
 * public-suffix list into the page. Hosts outside the key still fall back to
 * the plain suffix rule.
 */
export function fingerprintObserverInitScript(firstPartySiteKey?: string): void {
  // Capture the few intrinsics used while collecting the final snapshot. The
  // observed page is adversarial input and can replace globals such as
  // Object.keys or JSON.stringify after this init script has run.
  const arrayIsArray = Array.isArray;
  const arraySort = Array.prototype.sort;
  const jsonStringify = JSON.stringify;
  const mapForEach = Map.prototype.forEach;
  const mapGet = Map.prototype.get;
  const mapSet = Map.prototype.set;
  const mathAbs = Math.abs;
  const mathMax = Math.max;
  const numberIsFinite = Number.isFinite;
  const objectCreate = Object.create;
  const objectDefineProperty = Object.defineProperty;
  const objectFreeze = Object.freeze;
  const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const objectKeys = Object.keys;
  const mapSizeGetter = objectGetOwnPropertyDescriptor(Map.prototype, "size")?.get;
  const promiseThen = Promise.prototype.then;
  const reflectApply = Reflect.apply;
  const reflectConstruct = Reflect.construct;
  const reflectDeleteProperty = Reflect.deleteProperty;
  const setAdd = Set.prototype.add;
  const setForEach = Set.prototype.forEach;
  const setHas = Set.prototype.has;
  const setSizeGetter = objectGetOwnPropertyDescriptor(Set.prototype, "size")?.get;
  const TrustedPromise = Promise;
  const TrustedSet = Set;
  const stringEndsWith = String.prototype.endsWith;
  const stringIncludes = String.prototype.includes;
  const stringSlice = String.prototype.slice;
  const stringSplit = String.prototype.split;
  const stringToLowerCase = String.prototype.toLowerCase;
  const stringTrim = String.prototype.trim;
  const stringConstructor = String;
  const weakMapGet = WeakMap.prototype.get;
  const weakMapSet = WeakMap.prototype.set;
  const UrlConstructor = URL;
  const urlHostnameGetter = objectGetOwnPropertyDescriptor(URL.prototype, "hostname")?.get;
  const urlOriginGetter = objectGetOwnPropertyDescriptor(URL.prototype, "origin")?.get;
  const urlProtocolGetter = objectGetOwnPropertyDescriptor(URL.prototype, "protocol")?.get;
  const regExpExec = RegExp.prototype.exec;
  const stackUrlPattern = /https?:\/\/[^\s)]+/;
  const lineColumnPattern = /:\d+:\d+$/;
  const rawSiteKey =
    typeof firstPartySiteKey === "string" ? (reflectApply(stringTrim, firstPartySiteKey, []) as string) : "";
  const siteKey = reflectApply(stringToLowerCase, rawSiteKey, []) as string;
  const eventCounts = objectCreate(null) as Record<string, number>;
  const objectIsPrototypeOf = Object.prototype.isPrototypeOf;
  const StackError = Error as ErrorConstructor & {
    captureStackTrace?: (target: object, constructor?: Function) => void;
    prepareStackTrace?: unknown;
    stackTraceLimit?: number;
  };
  const errorCaptureStackTrace = StackError.captureStackTrace;
  // Deep enough that ordinary synchronous framework wrappers keep the real
  // registrant inside the capture, still bounded so one registration cannot
  // allocate an arbitrarily deep stack. A chain that saturates this bound
  // without resolving attribution records listener-attribution loss, never a
  // clean read.
  const observerStackTraceLimit = mathMax(
    64,
    typeof StackError.stackTraceLimit === "number" ? StackError.stackTraceLimit : 0
  );
  const maxTrackedCanvases = 256;
  const maxUniqueCanvasFontValues = 128;
  const maxUniqueCanvasTextCharacters = 256;
  const maxUniqueCanvasTextSamples = 128;
  const maxRetainedCanvasTextLength = 4096;
  const maxRetainedScriptOriginLength = 2048;
  const maxUniqueThirdPartyOrigins = 128;
  type PrototypeConstructor = { prototype: object };
  type FingerprintObserverWindow = Window & {
    CanvasRenderingContext2D?: PrototypeConstructor;
    Document?: PrototypeConstructor;
    Element?: PrototypeConstructor;
    EventTarget?: PrototypeConstructor;
    HTMLCanvasElement?: PrototypeConstructor;
    ImageData?: PrototypeConstructor;
    HTMLInputElement?: PrototypeConstructor;
    HTMLScriptElement?: PrototypeConstructor;
    HTMLTextAreaElement?: PrototypeConstructor;
    OffscreenCanvas?: PrototypeConstructor;
    OffscreenCanvasRenderingContext2D?: PrototypeConstructor;
    WebGL2RenderingContext?: PrototypeConstructor;
    WebGLRenderingContext?: PrototypeConstructor;
    location?: Location;
  };
  const observerWindow = window as FingerprintObserverWindow;
  const canvasElementPrototype = observerWindow.HTMLCanvasElement?.prototype;
  const canvasContextPrototype = observerWindow.CanvasRenderingContext2D?.prototype;
  const offscreenCanvasPrototype = observerWindow.OffscreenCanvas?.prototype;
  const offscreenContextPrototype = observerWindow.OffscreenCanvasRenderingContext2D?.prototype;
  const documentPrototype = observerWindow.Document?.prototype;
  const elementPrototype = observerWindow.Element?.prototype;
  const eventTargetPrototype = observerWindow.EventTarget?.prototype;
  const inputElementPrototype = observerWindow.HTMLInputElement?.prototype;
  const imageDataPrototype = observerWindow.ImageData?.prototype;
  const scriptElementPrototype = observerWindow.HTMLScriptElement?.prototype;
  const textAreaElementPrototype = observerWindow.HTMLTextAreaElement?.prototype;
  const webgl2Prototype = observerWindow.WebGL2RenderingContext?.prototype;
  const webglPrototype = observerWindow.WebGLRenderingContext?.prototype;
  const documentValue = observerWindow.document;
  const locationValue = observerWindow.location;
  // `window.top` is unforgeable per the HTML standard, so a page script cannot
  // fake it; it is still read here, before any page script has run. A harness
  // window without `top` is treated as the top frame, since a missing `top` is
  // not evidence that the observer is running inside a subframe.
  const topWindowValue = (() => {
    try {
      return observerWindow.top;
    } catch {
      return null;
    }
  })();
  const observerInSubframe = Boolean(topWindowValue) && topWindowValue !== observerWindow;
  const canvasGetter = canvasContextPrototype
    ? objectGetOwnPropertyDescriptor(canvasContextPrototype, "canvas")?.get
    : undefined;
  const canvasFontGetter = canvasContextPrototype
    ? objectGetOwnPropertyDescriptor(canvasContextPrototype, "font")?.get
    : undefined;
  const canvasWidthGetter = canvasElementPrototype
    ? objectGetOwnPropertyDescriptor(canvasElementPrototype, "width")?.get
    : undefined;
  const canvasHeightGetter = canvasElementPrototype
    ? objectGetOwnPropertyDescriptor(canvasElementPrototype, "height")?.get
    : undefined;
  // OffscreenCanvasRenderingContext2D is its own interface: its prototype
  // chain goes straight to Object.prototype, and the page getters above reject
  // its instances, so the offscreen surface keeps its own captured getters.
  const offscreenCanvasGetter = offscreenContextPrototype
    ? objectGetOwnPropertyDescriptor(offscreenContextPrototype, "canvas")?.get
    : undefined;
  const offscreenFontGetter = offscreenContextPrototype
    ? objectGetOwnPropertyDescriptor(offscreenContextPrototype, "font")?.get
    : undefined;
  const offscreenWidthGetter = offscreenCanvasPrototype
    ? objectGetOwnPropertyDescriptor(offscreenCanvasPrototype, "width")?.get
    : undefined;
  const offscreenHeightGetter = offscreenCanvasPrototype
    ? objectGetOwnPropertyDescriptor(offscreenCanvasPrototype, "height")?.get
    : undefined;
  const imageDataWidthGetter = imageDataPrototype
    ? objectGetOwnPropertyDescriptor(imageDataPrototype, "width")?.get
    : undefined;
  const imageDataHeightGetter = imageDataPrototype
    ? objectGetOwnPropertyDescriptor(imageDataPrototype, "height")?.get
    : undefined;
  const documentBodyGetter = documentPrototype
    ? objectGetOwnPropertyDescriptor(documentPrototype, "body")?.get
    : undefined;
  const documentElementGetter = documentPrototype
    ? objectGetOwnPropertyDescriptor(documentPrototype, "documentElement")?.get
    : undefined;
  const currentScriptGetter = documentPrototype
    ? objectGetOwnPropertyDescriptor(documentPrototype, "currentScript")?.get
    : undefined;
  const elementGetAttribute = elementPrototype
    ? objectGetOwnPropertyDescriptor(elementPrototype, "getAttribute")?.value
    : undefined;
  const scriptSrcGetter = scriptElementPrototype
    ? objectGetOwnPropertyDescriptor(scriptElementPrototype, "src")?.get
    : undefined;
  const locationHostnameGetter =
    typeof Location !== "undefined" ? objectGetOwnPropertyDescriptor(Location.prototype, "hostname")?.get : undefined;
  const locationHrefGetter =
    typeof Location !== "undefined" ? objectGetOwnPropertyDescriptor(Location.prototype, "href")?.get : undefined;
  let observerCoverageLost = false;
  // Scoped to listener attribution. A saturated stack capture or an
  // overflowed listener-origin bound leaves unknown which scripts registered
  // listeners; it says nothing about the canvas, font, WebGL, audio and WebRTC
  // observations or the event counters, none of which read a stack or an
  // origin. Only the two listener-coverage summaries are withheld.
  let listenerAttributionLost = false;
  type CanvasState = {
    maxReadHeight: number;
    maxReadWidth: number;
    readApis: Set<string>;
    textCharacters: Set<string>;
    textWriteCalls: number;
  };
  type CanvasFontState = {
    fontValues: Set<string>;
    maxMeasuredTextLength: number;
    measuredTextSamples: Set<string>;
    measureTextCalls: number;
  };
  type CanvasTextProvenance = {
    textCharacters: Set<string>;
    textWriteCalls: number;
  };
  type ListenerCoverageState = {
    eventTypes: Set<string>;
    listenerTargets: Set<string>;
    thirdPartyEventTypes: Set<string>;
    thirdPartyListenerTargets: Set<string>;
    thirdPartyOrigins: Set<string>;
    thirdPartyListenerCalls: number;
    totalListenerCalls: number;
  };
  type WebglState = {
    getParameterCalls: number;
    parameters: Set<string>;
    readApis: Set<string>;
    readPixelsCalls: number;
  };
  type AudioState = {
    analyserCalls: number;
    apis: Set<string>;
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
  type TrackedCanvas = HTMLCanvasElement | OffscreenCanvas;
  // Page and offscreen canvases share one map and one cap, so offscreen
  // canvases cannot exhaust tracking without failing the frame closed.
  const canvasStates = new Map<TrackedCanvas, CanvasState>();
  const imageBitmapProvenance = new WeakMap<object, CanvasTextProvenance>();
  // A page canvas whose control transferControlToOffscreen moved to an
  // OffscreenCanvas (its placeholder) shows what that OffscreenCanvas draws.
  // The link is kept apart from canvasStates, so the two stay two states and
  // a read of the placeholder counts one canvas, not both.
  const placeholderOffscreenCanvases = new WeakMap<object, TrackedCanvas>();
  const canvasFontState: CanvasFontState = {
    fontValues: new TrustedSet(),
    maxMeasuredTextLength: 0,
    measuredTextSamples: new TrustedSet(),
    measureTextCalls: 0
  };
  const webglState: WebglState = {
    getParameterCalls: 0,
    parameters: new TrustedSet(),
    readApis: new TrustedSet(),
    readPixelsCalls: 0
  };
  const audioState: AudioState = {
    analyserCalls: 0,
    apis: new TrustedSet(),
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
  const patchedRtcPrototypes = new TrustedSet<object>();
  const sessionRecordingEvents = new TrustedSet([
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
  const inputMonitoringEvents = new TrustedSet(["beforeinput", "change", "input", "keydown", "keypress", "keyup", "paste"]);
  const broadListenerTargets = new TrustedSet(["body", "document", "documentElement", "window"]);
  const inputListenerTargets = new TrustedSet(["contenteditable", "input", "textarea"]);
  const sessionRecordingState: ListenerCoverageState = {
    eventTypes: new TrustedSet(),
    listenerTargets: new TrustedSet(),
    thirdPartyEventTypes: new TrustedSet(),
    thirdPartyListenerTargets: new TrustedSet(),
    thirdPartyOrigins: new TrustedSet(),
    thirdPartyListenerCalls: 0,
    totalListenerCalls: 0
  };
  const inputMonitoringState: ListenerCoverageState = {
    eventTypes: new TrustedSet(),
    listenerTargets: new TrustedSet(),
    thirdPartyEventTypes: new TrustedSet(),
    thirdPartyListenerTargets: new TrustedSet(),
    thirdPartyOrigins: new TrustedSet(),
    thirdPartyListenerCalls: 0,
    totalListenerCalls: 0
  };

  const safeMapGet = <K, V>(map: Map<K, V>, key: K): V | undefined => reflectApply(mapGet, map, [key]) as V | undefined;
  const safeMapSet = <K, V>(map: Map<K, V>, key: K, value: V): void => {
    reflectApply(mapSet, map, [key, value]);
  };
  const safeMapSize = (map: Map<unknown, unknown>): number =>
    mapSizeGetter ? (reflectApply(mapSizeGetter, map, []) as number) : 0;
  const safeSetAdd = <T>(set: Set<T>, value: T): void => {
    reflectApply(setAdd, set, [value]);
  };
  const safeSetHas = <T>(set: Set<T>, value: T): boolean => reflectApply(setHas, set, [value]) as boolean;
  const safeSetSize = (set: Set<unknown>): number =>
    setSizeGetter ? (reflectApply(setSizeGetter, set, []) as number) : 0;
  const safeSortStrings = (values: string[]): string[] => reflectApply(arraySort, values, []) as string[];
  const webIdlDomString = (value: unknown): string => `${value}`;
  const safeArrayAppend = <T>(values: T[], value: T): void => {
    objectDefineProperty(values, stringConstructor(values.length), {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  };
  const copyStringSet = (values: Set<string>): Set<string> => {
    const copy = new TrustedSet<string>();
    reflectApply(setForEach, values, [
      (value: string) => {
        safeSetAdd(copy, value);
      }
    ]);
    return copy;
  };
  const sortedSetValues = (values: Set<string>): string[] => {
    const result: string[] = [];
    reflectApply(setForEach, values, [
      (value: string) => {
        safeArrayAppend(result, value);
      }
    ]);
    return safeSortStrings(result);
  };
  const markObserverCoverageLost = (): void => {
    observerCoverageLost = true;
  };
  const markListenerAttributionLost = (): void => {
    listenerAttributionLost = true;
  };
  const addBoundedUniqueString = (
    values: Set<string>,
    value: string,
    limit: number,
    onOverflow: () => void = markObserverCoverageLost
  ): void => {
    if (safeSetHas(values, value)) return;
    if (safeSetSize(values) >= limit) {
      onOverflow();
      return;
    }
    safeSetAdd(values, value);
  };
  // Promise.prototype.then looks up its receiver's constructor and that
  // constructor's Symbol.species before it registers anything, and a page can
  // swap either around a call, which makes then throw. The throw comes before
  // registration, so the retry cannot register twice: it gives the native
  // promise, which the page has not seen yet, an own constructor of undefined
  // for the length of the call, so then falls back to the intrinsic Promise.
  // The plain call goes first because defining that property disables the
  // engine's promise fast path for the whole page.
  const observeSettlement = (
    value: unknown,
    onFulfilled: (fulfilled: unknown) => void,
    onRejected: (reason: unknown) => void
  ): boolean => {
    try {
      reflectApply(promiseThen, value, [onFulfilled, onRejected]);
      return true;
    } catch {
      /* retried below against the intrinsic Promise */
    }
    try {
      objectDefineProperty(value, "constructor", { configurable: true, value: undefined });
    } catch {
      return false;
    }
    try {
      reflectApply(promiseThen, value, [onFulfilled, onRejected]);
      return true;
    } catch {
      return false;
    } finally {
      reflectDeleteProperty(value as object, "constructor");
    }
  };

  // Runs onFulfilled once a native promise call fulfills, and returns the
  // promise the page gets in its place. Observing the native promise marks
  // its rejection handled, so handing that promise back would keep a
  // rejection the page never handles from reaching unhandledrejection (and
  // the error monitoring that listens for it). The page gets a promise of its
  // own instead, which settles as the native one does, one microtask later,
  // and is unhandled exactly when the page leaves it so. A native promise API
  // always returns a promise; if what came back cannot be observed, the page
  // gets it untouched and the frame fails closed rather than reading quiet.
  // The recording itself runs inside a reaction whose own promise nothing
  // handles, so a throw there (a page trap met while recording) would surface
  // in the page as an unhandled rejection the page never caused; it fails the
  // frame closed instead.
  const settleAfterNative = (value: unknown, onFulfilled: (fulfilled: unknown) => void): unknown => {
    let resolvePage: (fulfilled: unknown) => void = () => undefined;
    let rejectPage: (reason: unknown) => void = () => undefined;
    const pagePromise = new TrustedPromise<unknown>((resolve, reject) => {
      resolvePage = resolve;
      rejectPage = reject;
    });
    const observed = observeSettlement(
      value,
      (fulfilled) => {
        resolvePage(fulfilled);
        try {
          onFulfilled(fulfilled);
        } catch {
          markObserverCoverageLost();
        }
      },
      (reason) => {
        rejectPage(reason);
      }
    );
    if (observed) return pagePromise;
    markObserverCoverageLost();
    return value;
  };

  const snapshotEventCounts = () => {
    const snapshot = objectCreate(null) as Record<string, number>;
    const keys = objectKeys(eventCounts);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      objectDefineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: eventCounts[key],
        writable: false
      });
    }
    return objectFreeze(snapshot);
  };

  objectDefineProperty(window, "__siteBehaviorLabFingerprintEvents", {
    configurable: false,
    get: snapshotEventCounts
  });

  const getCanvasState = (canvas: TrackedCanvas): CanvasState | null => {
    let state = safeMapGet(canvasStates, canvas);
    if (!state) {
      if (safeMapSize(canvasStates) >= maxTrackedCanvases) {
        observerCoverageLost = true;
        return null;
      }
      state = {
        maxReadHeight: 0,
        maxReadWidth: 0,
        readApis: new TrustedSet(),
        textCharacters: new TrustedSet(),
        textWriteCalls: 0
      };
      safeMapSet(canvasStates, canvas, state);
    }
    return state;
  };

  const hasPrototype = (value: unknown, prototype: object | undefined): boolean =>
    Boolean(
      prototype &&
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        (reflectApply(objectIsPrototypeOf, prototype, [value]) as boolean)
    );

  type NativeGetter = ((this: unknown) => unknown) | undefined;
  // A canvas interface with its 2D context. Page canvases and OffscreenCanvas
  // are separate interfaces whose getters reject each other's instances, so
  // every canvas wrapper is installed with the family whose methods it wraps.
  type CanvasFamily = {
    canvasPrototype: object | undefined;
    contextCanvasGetter: NativeGetter;
    contextFontGetter: NativeGetter;
    heightGetter: NativeGetter;
    widthGetter: NativeGetter;
  };
  const pageCanvasFamily: CanvasFamily = {
    canvasPrototype: canvasElementPrototype,
    contextCanvasGetter: canvasGetter,
    contextFontGetter: canvasFontGetter,
    heightGetter: canvasHeightGetter,
    widthGetter: canvasWidthGetter
  };
  const offscreenCanvasFamily: CanvasFamily = {
    canvasPrototype: offscreenCanvasPrototype,
    contextCanvasGetter: offscreenCanvasGetter,
    contextFontGetter: offscreenFontGetter,
    heightGetter: offscreenHeightGetter,
    widthGetter: offscreenWidthGetter
  };

  // The captured native getters and methods are the brand check. Each reads
  // its receiver's internal slots, runs no page code and throws for a receiver
  // of any other interface, so branding walks no prototype chain: a page can
  // put a Proxy whose getPrototypeOf trap throws anywhere in one, and
  // re-prototyping a canvas or context does not change what it is. A
  // context's canvas getter returns a canvas of its family, and a native
  // canvas method that returned has checked its receiver (convertToBlob
  // reports a wrong receiver by rejecting, and its read is recorded only once
  // its promise fulfills). The prototype test stands in only where the
  // family's getters were not captured, which no browser that has the
  // interface does.
  const receiverCanvas = (family: CanvasFamily, receiver: unknown): TrackedCanvas | null => {
    if (!receiver || typeof receiver !== "object") return null;
    if (family.widthGetter) return receiver as TrackedCanvas;
    return hasPrototype(receiver, family.canvasPrototype) ? (receiver as TrackedCanvas) : null;
  };

  const contextCanvas = (family: CanvasFamily, context: unknown): TrackedCanvas | null => {
    if (!context || typeof context !== "object") return null;
    try {
      if (family.contextCanvasGetter) return reflectApply(family.contextCanvasGetter, context, []) as TrackedCanvas;
      const canvas = (context as { canvas?: unknown }).canvas;
      return hasPrototype(canvas, family.canvasPrototype) ? (canvas as TrackedCanvas) : null;
    } catch {
      return null;
    }
  };

  const readCanvasDimension = (family: CanvasFamily, canvas: TrackedCanvas, key: "height" | "width") => {
    const getter = key === "width" ? family.widthGetter : family.heightGetter;
    try {
      const value = getter ? reflectApply(getter, canvas, []) : (canvas as unknown as Record<string, unknown>)[key];
      return typeof value === "number" && numberIsFinite(value) && value >= 0 ? value : 0;
    } catch {
      return 0;
    }
  };

  const isAtLeast16By16 = (width: unknown, height: unknown) =>
    typeof width === "number" &&
    typeof height === "number" &&
    numberIsFinite(width) &&
    numberIsFinite(height) &&
    mathAbs(width) >= 16 &&
    mathAbs(height) >= 16;

  const placeholderOffscreenCanvas = (canvas: unknown): TrackedCanvas | undefined =>
    reflectApply(weakMapGet, placeholderOffscreenCanvases, [canvas]) as TrackedCanvas | undefined;

  // Found by identity, so any value can be asked: only a canvas the observer
  // admitted has a state. A placeholder carries its OffscreenCanvas's text,
  // since it can have no context of its own to draw with.
  const copyCanvasTextProvenance = (canvas: unknown): CanvasTextProvenance | undefined => {
    const state = safeMapGet(canvasStates, (placeholderOffscreenCanvas(canvas) ?? canvas) as TrackedCanvas);
    if (!state) return undefined;
    return {
      textCharacters: copyStringSet(state.textCharacters),
      textWriteCalls: state.textWriteCalls
    };
  };

  const inheritTextProvenance = (state: CanvasState, provenance: CanvasTextProvenance): void => {
    reflectApply(setForEach, provenance.textCharacters, [
      (character: string) => {
        addBoundedUniqueString(state.textCharacters, character, maxUniqueCanvasTextCharacters);
      }
    ]);
    state.textWriteCalls = mathMax(state.textWriteCalls, provenance.textWriteCalls);
  };

  const imageDataDimension = (
    value: unknown,
    getter: ((this: unknown) => unknown) | undefined,
    key: "height" | "width"
  ): unknown => {
    if (!value || typeof value !== "object") return undefined;
    try {
      return getter ? reflectApply(getter, value, []) : (value as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  };

  const summarizeCanvasDetections = (): FingerprintDetectionSummary[] => {
    const matches: CanvasState[] = [];
    reflectApply(mapForEach, canvasStates, [
      (state: CanvasState) => {
        if (
          state.maxReadWidth >= 16 &&
          state.maxReadHeight >= 16 &&
          safeSetSize(state.textCharacters) >= 10 &&
          safeSetSize(state.readApis) > 0
        ) {
          safeArrayAppend(matches, state);
        }
      }
    ]);

    if (matches.length === 0) return [];

    const readApis = new TrustedSet<string>();
    let maxCanvasWidth = 0;
    let maxCanvasHeight = 0;
    let maxDistinctTextCharacters = 0;
    let maxTextWriteCalls = 0;

    for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
      const state = matches[matchIndex];
      const stateReadApis = sortedSetValues(state.readApis);
      for (let apiIndex = 0; apiIndex < stateReadApis.length; apiIndex += 1) {
        safeSetAdd(readApis, stateReadApis[apiIndex]);
      }
      maxCanvasWidth = mathMax(maxCanvasWidth, state.maxReadWidth);
      maxCanvasHeight = mathMax(maxCanvasHeight, state.maxReadHeight);
      maxDistinctTextCharacters = mathMax(maxDistinctTextCharacters, safeSetSize(state.textCharacters));
      maxTextWriteCalls = mathMax(maxTextWriteCalls, state.textWriteCalls);
    }

    const readApiValues: string[] = [];
    reflectApply(setForEach, readApis, [
      (api: string) => {
        safeArrayAppend(readApiValues, api);
      }
    ]);

    return [
      {
        kind: "canvas-fingerprinting",
        heuristic: "openwpm-canvas-v1",
        count: matches.length,
        evidence: {
          readApis: safeSortStrings(readApiValues),
          maxCanvasWidth,
          maxCanvasHeight,
          maxDistinctTextCharacters,
          maxTextWriteCalls
        }
      }
    ];
  };

  const summarizeCanvasFontDetections = (): FingerprintDetectionSummary[] => {
    const distinctFonts = safeSetSize(canvasFontState.fontValues);
    const distinctTextSamples = safeSetSize(canvasFontState.measuredTextSamples);
    if (canvasFontState.measureTextCalls < 8 || distinctFonts < 4 || distinctTextSamples < 1) return [];

    return [
      {
        kind: "canvas-font-fingerprinting",
        heuristic: "canvas-font-probing-v1",
        count: 1,
        evidence: {
          measureTextCalls: canvasFontState.measureTextCalls,
          maxDistinctFonts: distinctFonts,
          maxDistinctTextSamples: distinctTextSamples,
          maxTextLength: canvasFontState.maxMeasuredTextLength
        }
      }
    ];
  };

  const summarizeHighEntropyDetections = (): FingerprintDetectionSummary[] => {
    const detections: FingerprintDetectionSummary[] = [];
    const webglParameters = sortedSetValues(webglState.parameters);
    const webglReadApis = sortedSetValues(webglState.readApis);
    const audioApis = sortedSetValues(audioState.apis);

    if (webglParameters.length > 0 && webglState.readPixelsCalls > 0) {
      safeArrayAppend(detections, {
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
      safeArrayAppend(detections, {
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
      safeArrayAppend(detections, {
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
    // Every frame's detections merge into one page-level summary that carries no
    // frame provenance, and listeners registered inside a subframe can only
    // observe that subframe's own document. Publishing them would restate a
    // frame-scope fact as a page-scope claim about the scanned page, so a
    // subframe contributes no interaction coverage. The scanned document's own
    // coverage is unaffected: cross-realm registrations against the top document
    // run through the top frame's own wrapper.
    if (observerInSubframe) return detections;
    const sessionEventTypes = sortedSetValues(sessionRecordingState.thirdPartyEventTypes);
    const sessionTargets = sortedSetValues(sessionRecordingState.thirdPartyListenerTargets);
    const sessionOrigins = sortedSetValues(sessionRecordingState.thirdPartyOrigins);
    const inputEventTypes = sortedSetValues(inputMonitoringState.thirdPartyEventTypes);
    const inputTargets = sortedSetValues(inputMonitoringState.thirdPartyListenerTargets);
    const inputOrigins = sortedSetValues(inputMonitoringState.thirdPartyOrigins);
    let broadSessionTargets = false;
    for (let index = 0; index < sessionTargets.length; index += 1) {
      if (safeSetHas(broadListenerTargets, sessionTargets[index])) broadSessionTargets = true;
    }
    let inputTargetMatched = false;
    for (let index = 0; index < inputTargets.length; index += 1) {
      const target = inputTargets[index];
      if (safeSetHas(inputListenerTargets, target) || safeSetHas(broadListenerTargets, target)) inputTargetMatched = true;
    }
    let inputEventsIncludeTextSignals = false;
    for (let index = 0; index < inputEventTypes.length; index += 1) {
      if (safeSetHas(inputMonitoringEvents, inputEventTypes[index]) && inputEventTypes[index] !== "change") {
        inputEventsIncludeTextSignals = true;
      }
    }

    if (
      sessionRecordingState.thirdPartyListenerCalls >= 8 &&
      sessionEventTypes.length >= 5 &&
      broadSessionTargets &&
      sessionOrigins.length > 0
    ) {
      safeArrayAppend(detections, {
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
      safeArrayAppend(detections, {
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

  const trustedJsonSnapshot = (value: unknown): string => {
    if (value === null) return "null";
    if (typeof value === "string") {
      const encoded = jsonStringify(value);
      return typeof encoded === "string" ? encoded : '""';
    }
    if (typeof value === "number") return numberIsFinite(value) ? stringConstructor(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (arrayIsArray(value)) {
      let encoded = "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) encoded += ",";
        encoded += trustedJsonSnapshot(value[index]);
      }
      return `${encoded}]`;
    }
    if (typeof value === "object") {
      const recordValue = value as Record<string, unknown>;
      const keys = objectKeys(recordValue);
      let encoded = "{";
      for (let index = 0; index < keys.length; index += 1) {
        if (index > 0) encoded += ",";
        const key = keys[index];
        encoded += `${trustedJsonSnapshot(key)}:${trustedJsonSnapshot(recordValue[key])}`;
      }
      return `${encoded}}`;
    }
    return "null";
  };

  objectDefineProperty(window, "__siteBehaviorLabFingerprintSnapshot", {
    configurable: false,
    value: () => {
      // The scanner treats a non-snapshot as an unreadable frame and records
      // detector coverage loss. Never turn a compromised stack reader or an
      // overflowed evidence bound into a publishable zero.
      if (observerCoverageLost) return null;
      const detections: FingerprintDetectionSummary[] = [];
      const appendDetections = (items: FingerprintDetectionSummary[]) => {
        for (let index = 0; index < items.length; index += 1) safeArrayAppend(detections, items[index]);
      };
      appendDetections(summarizeCanvasDetections());
      appendDetections(summarizeCanvasFontDetections());
      appendDetections(summarizeHighEntropyDetections());
      // Bounded listener attribution withholds exactly the summaries built
      // from attributed registrations and flags the frame, so the scanner
      // records the loss instead of reading a clean frame.
      if (listenerAttributionLost) {
        return trustedJsonSnapshot({
          detections,
          events: snapshotEventCounts(),
          listenerAttributionLost: true
        });
      }
      appendDetections(summarizeInteractionDetections());
      return trustedJsonSnapshot({
        detections,
        events: snapshotEventCounts()
      });
    }
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
    objectDefineProperty(target, key, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      value,
      writable: true
    });
  };

  const wrapCanvasReadMethod = (
    target: object | undefined,
    key: string,
    api: "canvas.convertToBlob" | "canvas.getImageData" | "canvas.toBlob" | "canvas.toDataURL",
    family: CanvasFamily,
    canvasForThis: (family: CanvasFamily, thisValue: unknown) => TrackedCanvas | null,
    qualifies: (args: unknown[], result: unknown) => boolean = () => true
  ) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedCanvasReadMethod(this: unknown, ...args: unknown[]) {
      const result = reflectApply(descriptor.value, this, args);
      const canvas = canvasForThis(family, this);
      // Sized at the call: convertToBlob encodes the bitmap as it was then,
      // and the page can resize the canvas before the promise settles.
      const readWidth = canvas ? readCanvasDimension(family, canvas, "width") : 0;
      const readHeight = canvas ? readCanvasDimension(family, canvas, "height") : 0;
      const recordSuccessfulRead = () => {
        record(api);
        if (canvas && qualifies(args, result)) {
          const state = getCanvasState(canvas);
          if (state) {
            // Reading a placeholder reads what its OffscreenCanvas drew.
            const shown = placeholderOffscreenCanvas(canvas) ? copyCanvasTextProvenance(canvas) : undefined;
            if (shown) inheritTextProvenance(state, shown);
            safeSetAdd(state.readApis, api);
            state.maxReadWidth = mathMax(state.maxReadWidth, readWidth);
            state.maxReadHeight = mathMax(state.maxReadHeight, readHeight);
          }
        }
      };
      // convertToBlob rejects for a canvas it cannot export (zero-size,
      // without a rendering context, detached or origin-tainted), so only a
      // fulfilled export is a read.
      if (api === "canvas.convertToBlob") return settleAfterNative(result, recordSuccessfulRead);
      recordSuccessfulRead();
      return result;
    });
  };

  const wrapCanvasTextMethod = (target: object | undefined, key: "fillText" | "strokeText", family: CanvasFamily) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedCanvasTextMethod(this: unknown, ...args: unknown[]) {
      // A receiver whose canvas the family getter rejects goes straight to
      // the native call, which throws before converting any argument.
      const canvas = args.length < 3 ? null : contextCanvas(family, this);
      if (!canvas) return reflectApply(descriptor.value, this, args);
      const text = webIdlDomString(args[0]);
      args[0] = text;
      const result = reflectApply(descriptor.value, this, args);
      const state = getCanvasState(canvas);
      if (state) {
        state.textWriteCalls += 1;
        const retainedLength = text.length > maxRetainedCanvasTextLength ? maxRetainedCanvasTextLength : text.length;
        if (retainedLength !== text.length) observerCoverageLost = true;
        for (let index = 0; index < retainedLength; index += 1) {
          addBoundedUniqueString(state.textCharacters, text[index], maxUniqueCanvasTextCharacters);
        }
      }
      return result;
    });
  };

  const wrapCanvasDrawImageMethod = (target: object | undefined, family: CanvasFamily) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, "drawImage");
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, "drawImage", descriptor, function wrappedCanvasDrawImage(this: unknown, ...args: unknown[]) {
      const result = reflectApply(descriptor.value, this, args);
      const targetCanvas = contextCanvas(family, this);
      const source = args[0];
      if (targetCanvas && source !== targetCanvas) {
        // A canvas source of either family and a bitmap are both found by
        // identity, so an image source costs two map lookups and no brand
        // check at all.
        let provenance = copyCanvasTextProvenance(source);
        if (!provenance && (typeof source === "object" || typeof source === "function") && source !== null) {
          provenance = reflectApply(weakMapGet, imageBitmapProvenance, [source]) as CanvasTextProvenance | undefined;
        }

        if (provenance) {
          const targetState = getCanvasState(targetCanvas);
          if (targetState) inheritTextProvenance(targetState, provenance);
        }
      }
      return result;
    });
  };

  const wrapCreateImageBitmap = () => {
    type ImageBitmapWindow = Window & {
      createImageBitmap?: (...args: unknown[]) => Promise<object>;
    };
    const bitmapWindow = window as ImageBitmapWindow;
    const originalCreateImageBitmap = bitmapWindow.createImageBitmap;
    if (typeof originalCreateImageBitmap !== "function") return;

    const ownDescriptor = objectGetOwnPropertyDescriptor(bitmapWindow, "createImageBitmap");
    if (ownDescriptor && !ownDescriptor.configurable) return;

    objectDefineProperty(bitmapWindow, "createImageBitmap", {
      configurable: ownDescriptor?.configurable ?? true,
      enumerable: ownDescriptor?.enumerable ?? true,
      value: function wrappedCreateImageBitmap(this: unknown, ...args: unknown[]) {
        const source = args[0];
        let provenance = copyCanvasTextProvenance(source);
        if (!provenance && (typeof source === "object" || typeof source === "function") && source !== null) {
          const inherited = reflectApply(weakMapGet, imageBitmapProvenance, [source]) as CanvasTextProvenance | undefined;
          if (inherited) {
            provenance = {
              textCharacters: copyStringSet(inherited.textCharacters),
              textWriteCalls: inherited.textWriteCalls
            };
          }
        }

        const result = reflectApply(originalCreateImageBitmap, this, args);
        return settleAfterNative(result, (bitmap) => {
          if (provenance && (typeof bitmap === "object" || typeof bitmap === "function") && bitmap !== null) {
            reflectApply(weakMapSet, imageBitmapProvenance, [bitmap, provenance]);
          }
        });
      },
      writable: true
    });
  };

  // transferToImageBitmap is not a read. It moves the offscreen bitmap into an
  // ImageBitmap the page can draw into another canvas, so, like
  // createImageBitmap, it only carries the canvas's text provenance along.
  const wrapCanvasTransferToImageBitmap = (target: object | undefined) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, "transferToImageBitmap");
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, "transferToImageBitmap", descriptor, function wrappedTransferToImageBitmap(this: unknown, ...args: unknown[]) {
      const result = reflectApply(descriptor.value, this, args);
      // The native call succeeded, so the receiver is an OffscreenCanvas; its
      // state is found by identity, whatever the page did to its prototype.
      if ((typeof result === "object" || typeof result === "function") && result !== null) {
        const provenance = copyCanvasTextProvenance(this as OffscreenCanvas);
        if (provenance) reflectApply(weakMapSet, imageBitmapProvenance, [result, provenance]);
      }
      return result;
    });
  };

  const wrapCanvasTransferControlToOffscreen = (target: object | undefined) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, "transferControlToOffscreen");
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(
      target,
      "transferControlToOffscreen",
      descriptor,
      function wrappedTransferControlToOffscreen(this: unknown, ...args: unknown[]) {
        const result = reflectApply(descriptor.value, this, args);
        // The native call succeeded, so the receiver is a page canvas and the
        // result the OffscreenCanvas that now draws it.
        reflectApply(weakMapSet, placeholderOffscreenCanvases, [this, result]);
        return result;
      }
    );
  };

  const wrapCanvasMeasureTextMethod = (target: object | undefined, family: CanvasFamily) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, "measureText");
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, "measureText", descriptor, function wrappedCanvasMeasureText(this: unknown, ...args: unknown[]) {
      const canvas = args.length < 1 ? null : contextCanvas(family, this);
      if (!canvas) return reflectApply(descriptor.value, this, args);
      const measuredText = webIdlDomString(args[0]);
      args[0] = measuredText;
      const result = reflectApply(descriptor.value, this, args);
      record("canvas.measureText");
      canvasFontState.measureTextCalls += 1;
      canvasFontState.maxMeasuredTextLength = mathMax(canvasFontState.maxMeasuredTextLength, measuredText.length);
      if (measuredText.length > maxRetainedCanvasTextLength) {
        observerCoverageLost = true;
      } else {
        addBoundedUniqueString(
          canvasFontState.measuredTextSamples,
          measuredText,
          maxUniqueCanvasTextSamples
        );
      }

      let contextFont: unknown;
      try {
        contextFont = family.contextFontGetter
          ? reflectApply(family.contextFontGetter, this, [])
          : (this as { font?: unknown })?.font;
      } catch {
        contextFont = undefined;
      }
      const normalizedFont = typeof contextFont === "string" ? (reflectApply(stringTrim, contextFont, []) as string) : "";
      if (normalizedFont) {
        if (normalizedFont.length > maxRetainedCanvasTextLength) {
          observerCoverageLost = true;
        } else {
          addBoundedUniqueString(canvasFontState.fontValues, normalizedFont, maxUniqueCanvasFontValues);
        }
      }
      return result;
    });
  };

  const classifyListenerTarget = (target: unknown): string => {
    if (target === window) return "window";
    if (documentValue && target === documentValue) return "document";
    try {
      const documentElement = documentValue
        ? documentElementGetter
          ? reflectApply(documentElementGetter, documentValue, [])
          : documentValue.documentElement
        : null;
      if (documentElement && target === documentElement) return "documentElement";
      const body = documentValue
        ? documentBodyGetter
          ? reflectApply(documentBodyGetter, documentValue, [])
          : documentValue.body
        : null;
      if (body && target === body) return "body";
    } catch {
      /* continue with trusted prototype brands */
    }
    if (hasPrototype(target, inputElementPrototype)) return "input";
    if (hasPrototype(target, textAreaElementPrototype)) return "textarea";
    if (hasPrototype(target, elementPrototype) && typeof elementGetAttribute === "function") {
      try {
        const contentEditable = reflectApply(elementGetAttribute, target, ["contenteditable"]);
        if (contentEditable === "true" || contentEditable === "") return "contenteditable";
      } catch {
        /* a failed classification is not allowed to break native registration */
      }
    }

    return "other";
  };

  const belongsToSiteKey = (host: string) =>
    siteKey !== "" && (host === siteKey || (reflectApply(stringEndsWith, host, [`.${siteKey}`]) as boolean));

  // Same-site when one host is a subdomain of the other, or when BOTH sit
  // under the scanned site's registrable domain (sibling subdomains like
  // verified.example.com vs www.example.com share no suffix relationship but
  // are the same site). Hosts outside the site key keep the suffix rule only.
  const sameSiteHost = (left: string, right: string) =>
    left === right ||
    (reflectApply(stringEndsWith, left, [`.${right}`]) as boolean) ||
    (reflectApply(stringEndsWith, right, [`.${left}`]) as boolean) ||
    (belongsToSiteKey(left) && belongsToSiteKey(right));

  const trustedLocationValue = (getter: ((this: unknown) => unknown) | undefined, key: "hostname" | "href") => {
    if (!locationValue) return "";
    try {
      const value = getter
        ? reflectApply(getter, locationValue, [])
        : (locationValue as unknown as Record<string, unknown>)[key];
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };

  const trustedUrlValue = (
    url: URL,
    getter: ((this: unknown) => unknown) | undefined,
    key: "hostname" | "origin" | "protocol"
  ): string => {
    try {
      const value = getter ? reflectApply(getter, url, []) : (url as unknown as Record<string, unknown>)[key];
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };

  const currentScriptOrigin = (): string | null => {
    if (!documentValue || !currentScriptGetter) return null;
    try {
      const script = reflectApply(currentScriptGetter, documentValue, []);
      if (!script) return null;
      if (hasPrototype(script, scriptElementPrototype) && scriptSrcGetter) {
        const src = reflectApply(scriptSrcGetter, script, []);
        if (typeof src === "string" && src !== "") {
          return trustedUrlValue(new UrlConstructor(src), urlOriginGetter, "origin") || null;
        }
      }
      const href = trustedLocationValue(locationHrefGetter, "href");
      return href === "" ? null : trustedUrlValue(new UrlConstructor(href), urlOriginGetter, "origin") || null;
    } catch {
      return null;
    }
  };

  // "unavailable": no trustworthy stack could be read at all (prepareStackTrace
  // not neutralized, stackTraceLimit unusable, an empty stack). That is an
  // integrity signal about the frame and still withholds its whole snapshot.
  // "saturated": a stack was read, but the capture filled the observer's bound
  // with first-party frames only, so this registration's registrant is
  // unknown. Nothing else the frame recorded depends on that answer.
  type StackAttribution =
    | { status: "resolved"; origins: string[] }
    | { status: "saturated" }
    | { status: "unavailable" };

  const scriptOriginFromStack = (skipUntil?: Function): StackAttribution => {
    const previousPrepareStackTraceDescriptor = objectGetOwnPropertyDescriptor(StackError, "prepareStackTrace");
    const previousStackTraceLimitDescriptor = objectGetOwnPropertyDescriptor(StackError, "stackTraceLimit");
    let prepareStackTraceNeutralized = false;
    let raisedStackTraceLimit = false;
    let stackTraceLimitUsable = false;
    let stack = "";

    try {
      if (
        previousPrepareStackTraceDescriptor &&
        "value" in previousPrepareStackTraceDescriptor &&
        previousPrepareStackTraceDescriptor.value === undefined
      ) {
        prepareStackTraceNeutralized = true;
      } else if (!previousPrepareStackTraceDescriptor || previousPrepareStackTraceDescriptor.configurable) {
        objectDefineProperty(StackError, "prepareStackTrace", {
          configurable: true,
          enumerable: previousPrepareStackTraceDescriptor?.enumerable ?? false,
          value: undefined,
          writable: true
        });
        prepareStackTraceNeutralized = true;
      } else if ("value" in previousPrepareStackTraceDescriptor && previousPrepareStackTraceDescriptor.writable) {
        objectDefineProperty(StackError, "prepareStackTrace", {
          value: undefined
        });
        prepareStackTraceNeutralized = true;
      }

      const currentStackTraceLimit =
        previousStackTraceLimitDescriptor && "value" in previousStackTraceLimitDescriptor
          ? previousStackTraceLimitDescriptor.value
          : (StackError.stackTraceLimit as unknown);
      // Pin stack capture to the observer's bounded depth. Accepting a larger
      // page-controlled value lets one listener registration allocate an
      // arbitrarily deep stack.
      if (typeof currentStackTraceLimit !== "number" || currentStackTraceLimit !== observerStackTraceLimit) {
        if (!previousStackTraceLimitDescriptor || previousStackTraceLimitDescriptor.configurable) {
          objectDefineProperty(StackError, "stackTraceLimit", {
            configurable: true,
            enumerable: previousStackTraceLimitDescriptor?.enumerable ?? false,
            value: observerStackTraceLimit,
            writable: true
          });
          raisedStackTraceLimit = true;
        } else if ("value" in previousStackTraceLimitDescriptor && previousStackTraceLimitDescriptor.writable) {
          objectDefineProperty(StackError, "stackTraceLimit", {
            value: observerStackTraceLimit
          });
          raisedStackTraceLimit = true;
        }
      } else {
        stackTraceLimitUsable = true;
      }
      if (raisedStackTraceLimit) stackTraceLimitUsable = true;
    } catch {
      /* restoration below; the caller marks this frame's coverage unavailable */
    }

    try {
      if (prepareStackTraceNeutralized && stackTraceLimitUsable) {
        const stackTarget = new StackError();
        if (typeof errorCaptureStackTrace === "function" && skipUntil) {
          reflectApply(errorCaptureStackTrace, StackError, [stackTarget, skipUntil]);
        }
        const candidateStack = stackTarget.stack;
        stack = typeof candidateStack === "string" ? candidateStack : "";
      }
    } catch {
      /* the caller records explicit coverage loss */
    } finally {
      if (raisedStackTraceLimit) {
        try {
          if (previousStackTraceLimitDescriptor) {
            objectDefineProperty(StackError, "stackTraceLimit", previousStackTraceLimitDescriptor);
          } else {
            reflectDeleteProperty(StackError, "stackTraceLimit");
          }
        } catch {
          /* best-effort restoration for hostile page globals */
        }
      }
      if (prepareStackTraceNeutralized) {
        try {
          if (previousPrepareStackTraceDescriptor) {
            objectDefineProperty(StackError, "prepareStackTrace", previousPrepareStackTraceDescriptor);
          } else {
            reflectDeleteProperty(StackError, "prepareStackTrace");
          }
        } catch {
          /* best-effort restoration for hostile page globals */
        }
      }
    }

    if (!prepareStackTraceNeutralized || !stackTraceLimitUsable || stack === "") {
      return { status: "unavailable" };
    }

    const stackLines = reflectApply(stringSplit, stack, ["\n"]) as string[];
    let nearestOrigin: string | null = null;
    const chainThirdPartyOrigins: string[] = [];
    let frameLineCount = 0;
    for (let index = 0; index < stackLines.length; index += 1) {
      const line = stackLines[index];
      if (reflectApply(stringIncludes, line, ["    at "]) as boolean) frameLineCount += 1;
      if (
        typeof errorCaptureStackTrace !== "function" &&
        ((reflectApply(stringIncludes, line, ["wrappedAddEventListener"]) as boolean) ||
          (reflectApply(stringIncludes, line, ["recordListenerCoverage"]) as boolean))
      ) {
        continue;
      }
      const match = reflectApply(regExpExec, stackUrlPattern, [line]) as RegExpExecArray | null;
      if (!match) continue;

      const lineColumn = reflectApply(regExpExec, lineColumnPattern, [match[0]]) as RegExpExecArray | null;
      const rawUrl = lineColumn
        ? (reflectApply(stringSlice, match[0], [0, match[0].length - lineColumn[0].length]) as string)
        : match[0];
      try {
        const parsed = new UrlConstructor(rawUrl);
        const origin = trustedUrlValue(parsed, urlOriginGetter, "origin");
        if (origin === "") continue;
        // Frameworks such as Zone.js wrap addEventListener synchronously. The
        // nearest stack frame is then the first-party framework wrapper, while
        // the script that registered the listener can appear farther up the
        // same bounded stack. Record EVERY distinct third-party origin in the
        // captured chain: the published claim is chain presence, not sole
        // registrant, so a vendor delegating through a helper on a second CDN
        // (two third parties in one benign chain) is a detection naming both
        // origins, never censored coverage. Retain the nearest origin as the
        // first-party answer when the whole captured chain is same-site.
        if (nearestOrigin === null) nearestOrigin = origin;
        if (isThirdPartyOrigin(origin)) {
          let alreadyRecorded = false;
          for (let seen = 0; seen < chainThirdPartyOrigins.length; seen += 1) {
            if (chainThirdPartyOrigins[seen] === origin) {
              alreadyRecorded = true;
              break;
            }
          }
          if (!alreadyRecorded) safeArrayAppend(chainThirdPartyOrigins, origin);
        }
      } catch {
        /* keep looking */
      }
    }

    if (chainThirdPartyOrigins.length > 0) {
      return { status: "resolved", origins: chainThirdPartyOrigins };
    }
    // No third-party frame inside a capture that saturated the observer's
    // bound: the walk exhausted the captured frames without resolving
    // attribution, and the registrant may sit beyond the truncation point. A
    // wrapper chain deeper than the bound must read as bounded listener
    // coverage, never as a clean first-party registration.
    if (frameLineCount >= observerStackTraceLimit) {
      return { status: "saturated" };
    }
    // A healthy stack may contain only non-HTTP frames in harnesses or browser
    // internals. That is unattributed, not evidence that stack capture itself
    // was disabled.
    return { status: "resolved", origins: nearestOrigin === null ? [] : [nearestOrigin] };
  };

  const isThirdPartyOrigin = (origin: string | null): origin is string => {
    if (!origin) return false;

    try {
      const script = new UrlConstructor(origin);
      const protocol = trustedUrlValue(script, urlProtocolGetter, "protocol");
      if (protocol !== "http:" && protocol !== "https:") return false;
      const locationHostname = trustedLocationValue(locationHostnameGetter, "hostname");
      if (!locationHostname) return false;
      const scriptHostname = trustedUrlValue(script, urlHostnameGetter, "hostname");
      return scriptHostname !== "" && !sameSiteHost(scriptHostname, locationHostname);
    } catch {
      return false;
    }
  };

  const recordCoverage = (state: ListenerCoverageState, eventType: string, targetType: string, thirdPartyOrigins: string[]) => {
    safeSetAdd(state.eventTypes, eventType);
    safeSetAdd(state.listenerTargets, targetType);
    state.totalListenerCalls += 1;

    if (thirdPartyOrigins.length === 0) return;
    // Both origin bounds below limit only what the listener-coverage summaries
    // can retain, so overflowing either one bounds listener attribution alone.
    for (let index = 0; index < thirdPartyOrigins.length; index += 1) {
      if (thirdPartyOrigins[index].length > maxRetainedScriptOriginLength) {
        listenerAttributionLost = true;
        return;
      }
    }
    safeSetAdd(state.thirdPartyEventTypes, eventType);
    safeSetAdd(state.thirdPartyListenerTargets, targetType);
    for (let index = 0; index < thirdPartyOrigins.length; index += 1) {
      addBoundedUniqueString(
        state.thirdPartyOrigins,
        thirdPartyOrigins[index],
        maxUniqueThirdPartyOrigins,
        markListenerAttributionLost
      );
    }
    // One registration call, however many chain origins it recorded: the
    // thresholds count listener registrations, not origins.
    state.thirdPartyListenerCalls += 1;
  };

  const recordListenerCoverage = (eventTypeValue: unknown, target: unknown, skipUntil?: Function) => {
    if (typeof eventTypeValue !== "string") return;
    if (eventTypeValue.length > 32) return;
    const eventType = reflectApply(stringToLowerCase, eventTypeValue, []) as string;
    const sessionRecordingEvent = safeSetHas(sessionRecordingEvents, eventType);
    const inputMonitoringEvent = safeSetHas(inputMonitoringEvents, eventType);
    if (!sessionRecordingEvent && !inputMonitoringEvent) return;
    const targetType = classifyListenerTarget(target);
    const activeScriptOrigin = currentScriptOrigin();
    // Without a current script the origins come from the bounded stack. The
    // stack reader looks past synchronous first-party wrappers and records
    // every distinct third-party origin present in the captured chain. A
    // wrapper replacing the prototype is therefore not itself evidence loss;
    // an unreadable stack still is, and a saturated one bounds this
    // registration's attribution.
    const stackAttribution: StackAttribution = activeScriptOrigin
      ? { status: "resolved", origins: [activeScriptOrigin] }
      : scriptOriginFromStack(skipUntil);
    if (stackAttribution.status === "unavailable") {
      observerCoverageLost = true;
      return;
    }
    if (stackAttribution.status === "saturated") {
      listenerAttributionLost = true;
      return;
    }
    const chainThirdPartyOrigins: string[] = [];
    for (let index = 0; index < stackAttribution.origins.length; index += 1) {
      const origin = stackAttribution.origins[index];
      if (isThirdPartyOrigin(origin)) safeArrayAppend(chainThirdPartyOrigins, origin);
    }

    if (sessionRecordingEvent) {
      recordCoverage(sessionRecordingState, eventType, targetType, chainThirdPartyOrigins);
    }

    if (inputMonitoringEvent) {
      recordCoverage(inputMonitoringState, eventType, targetType, chainThirdPartyOrigins);
    }
  };

  const wrapEventTargetAddEventListener = () => {
    if (!eventTargetPrototype) return;
    const descriptor = objectGetOwnPropertyDescriptor(eventTargetPrototype, "addEventListener");
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(eventTargetPrototype, "addEventListener", descriptor, function wrappedAddEventListener(this: unknown, ...args: unknown[]) {
      if (!hasPrototype(this, eventTargetPrototype) || args.length < 1) {
        return reflectApply(descriptor.value, this, args);
      }
      const eventType = webIdlDomString(args[0]);
      args[0] = eventType;
      const result = reflectApply(descriptor.value, this, args);
      recordListenerCoverage(eventType, this, wrappedAddEventListener);
      return result;
    });
  };

  const wrapWebglGetParameter = (target: object | undefined, key: string, api: string) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedWebglGetParameter(this: unknown, ...args: unknown[]) {
      const parameter = args[0];
      const result = reflectApply(descriptor.value, this, args);
      webglState.getParameterCalls += 1;
      if (parameter === 37445) {
        const parameterName = `${api}.UNMASKED_VENDOR_WEBGL`;
        record(parameterName);
        safeSetAdd(webglState.parameters, parameterName);
      }
      if (parameter === 37446) {
        const parameterName = `${api}.UNMASKED_RENDERER_WEBGL`;
        record(parameterName);
        safeSetAdd(webglState.parameters, parameterName);
      }
      return result;
    });
  };

  const wrapWebglReadPixels = (target: object | undefined, key: string, api: string) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedWebglReadPixels(this: unknown, ...args: unknown[]) {
      const result = reflectApply(descriptor.value, this, args);
      record(api);
      safeSetAdd(webglState.readApis, api);
      webglState.readPixelsCalls += 1;
      return result;
    });
  };

  const wrapAudioMethod = (
    target: object | undefined,
    key: "createAnalyser" | "createDynamicsCompressor" | "createOscillator" | "startRendering",
    apiForContext: string | ((context: unknown) => string | null)
  ) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedAudioMethod(this: unknown, ...args: unknown[]) {
      const result = reflectApply(descriptor.value, this, args);
      const api = typeof apiForContext === "function" ? apiForContext(this) : apiForContext;
      const recordSuccessfulCall = () => {
        if (!api) return;
        record(api);
        safeSetAdd(audioState.apis, api);
        if (key === "createAnalyser") audioState.analyserCalls += 1;
        if (key === "createDynamicsCompressor") audioState.compressorCalls += 1;
        if (key === "createOscillator") audioState.oscillatorCalls += 1;
        if (key === "startRendering") audioState.offlineRenderCalls += 1;
      };
      if (key === "startRendering") return settleAfterNative(result, recordSuccessfulCall);
      recordSuccessfulCall();
      return result;
    });
  };

  const wrapRtcMethod = (
    target: object | undefined,
    key: "createDataChannel" | "createOffer" | "setLocalDescription",
    api: string
  ) => {
    if (!target) return;
    const descriptor = objectGetOwnPropertyDescriptor(target, key);
    if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;

    defineWrappedMethod(target, key, descriptor, function wrappedRtcMethod(this: unknown, ...args: unknown[]) {
      const result = reflectApply(descriptor.value, this, args);
      const recordSuccessfulCall = () => {
        if (!hasPrototype(this, target)) return;
        record(api);
        if (key === "createDataChannel") rtcState.createDataChannelCalls += 1;
        if (key === "createOffer") rtcState.createOfferCalls += 1;
        if (key === "setLocalDescription") rtcState.setLocalDescriptionCalls += 1;
      };
      if (key === "createOffer" || key === "setLocalDescription") return settleAfterNative(result, recordSuccessfulCall);
      recordSuccessfulCall();
      return result;
    });
  };

  if (canvasElementPrototype) {
    wrapCanvasReadMethod(canvasElementPrototype, "toDataURL", "canvas.toDataURL", pageCanvasFamily, receiverCanvas);
    wrapCanvasReadMethod(canvasElementPrototype, "toBlob", "canvas.toBlob", pageCanvasFamily, receiverCanvas);
    wrapCanvasTransferControlToOffscreen(canvasElementPrototype);
  }

  const imageDataCoversAtLeast16By16 = (_args: unknown[], result: unknown) =>
    isAtLeast16By16(
      imageDataDimension(result, imageDataWidthGetter, "width"),
      imageDataDimension(result, imageDataHeightGetter, "height")
    );

  if (canvasContextPrototype) {
    wrapCanvasReadMethod(
      canvasContextPrototype,
      "getImageData",
      "canvas.getImageData",
      pageCanvasFamily,
      contextCanvas,
      imageDataCoversAtLeast16By16
    );
    wrapCanvasDrawImageMethod(canvasContextPrototype, pageCanvasFamily);
    wrapCanvasTextMethod(canvasContextPrototype, "fillText", pageCanvasFamily);
    wrapCanvasTextMethod(canvasContextPrototype, "strokeText", pageCanvasFamily);
    wrapCanvasMeasureTextMethod(canvasContextPrototype, pageCanvasFamily);
  }

  // An OffscreenCanvas exports through convertToBlob, a read recorded under
  // its own token (never as canvas.toBlob, which the page did not call), and
  // hands its bitmap on through transferToImageBitmap.
  if (offscreenCanvasPrototype) {
    wrapCanvasReadMethod(offscreenCanvasPrototype, "convertToBlob", "canvas.convertToBlob", offscreenCanvasFamily, receiverCanvas);
    wrapCanvasTransferToImageBitmap(offscreenCanvasPrototype);
  }

  // The offscreen 2D context runs the same wrappers into the same per-canvas
  // and document-wide state under the same tokens: each token names a
  // 2D-context method, and that method is identical on both contexts.
  if (offscreenContextPrototype) {
    wrapCanvasReadMethod(
      offscreenContextPrototype,
      "getImageData",
      "canvas.getImageData",
      offscreenCanvasFamily,
      contextCanvas,
      imageDataCoversAtLeast16By16
    );
    wrapCanvasDrawImageMethod(offscreenContextPrototype, offscreenCanvasFamily);
    wrapCanvasTextMethod(offscreenContextPrototype, "fillText", offscreenCanvasFamily);
    wrapCanvasTextMethod(offscreenContextPrototype, "strokeText", offscreenCanvasFamily);
    wrapCanvasMeasureTextMethod(offscreenContextPrototype, offscreenCanvasFamily);
  }
  wrapCreateImageBitmap();

  wrapEventTargetAddEventListener();

  if (webglPrototype) {
    wrapWebglGetParameter(webglPrototype, "getParameter", "webgl.getParameter");
    wrapWebglReadPixels(webglPrototype, "readPixels", "webgl.readPixels");
  }

  if (webgl2Prototype) {
    wrapWebglGetParameter(webgl2Prototype, "getParameter", "webgl2.getParameter");
    wrapWebglReadPixels(webgl2Prototype, "readPixels", "webgl2.readPixels");
  }

  type AudioContextConstructor = { prototype: object };
  type AudioObserverWindow = Window & {
    AudioContext?: AudioContextConstructor;
    BaseAudioContext?: AudioContextConstructor;
    OfflineAudioContext?: AudioContextConstructor;
  };
  const audioWindow = window as AudioObserverWindow;
  const audioContextConstructor = audioWindow.AudioContext;
  const baseAudioContextConstructor = audioWindow.BaseAudioContext;
  const offlineAudioContextConstructor = audioWindow.OfflineAudioContext;
  const audioContextPrototype = audioContextConstructor?.prototype;
  const offlineAudioContextPrototype = offlineAudioContextConstructor?.prototype;
  const chooseAudioApi = (offlineApi: string, onlineApi?: string) => (context: unknown) => {
    if (hasPrototype(context, offlineAudioContextPrototype)) return offlineApi;
    if (onlineApi && hasPrototype(context, audioContextPrototype)) return onlineApi;
    return null;
  };

  if (baseAudioContextConstructor) {
    wrapAudioMethod(
      baseAudioContextConstructor.prototype,
      "createAnalyser",
      chooseAudioApi("audio.OfflineAudioContext.createAnalyser", "audio.createAnalyser")
    );
    wrapAudioMethod(
      baseAudioContextConstructor.prototype,
      "createDynamicsCompressor",
      chooseAudioApi("audio.OfflineAudioContext.createDynamicsCompressor")
    );
    wrapAudioMethod(
      baseAudioContextConstructor.prototype,
      "createOscillator",
      chooseAudioApi("audio.OfflineAudioContext.createOscillator")
    );
  } else if (offlineAudioContextConstructor) {
    // Compatibility fallback for older engines without a public BaseAudioContext constructor.
    wrapAudioMethod(
      offlineAudioContextConstructor.prototype,
      "createAnalyser",
      "audio.OfflineAudioContext.createAnalyser"
    );
    wrapAudioMethod(
      offlineAudioContextConstructor.prototype,
      "createDynamicsCompressor",
      "audio.OfflineAudioContext.createDynamicsCompressor"
    );
    wrapAudioMethod(
      offlineAudioContextConstructor.prototype,
      "createOscillator",
      "audio.OfflineAudioContext.createOscillator"
    );
  }

  if (offlineAudioContextConstructor) {
    wrapAudioMethod(
      offlineAudioContextConstructor.prototype,
      "startRendering",
      "audio.OfflineAudioContext.startRendering"
    );
  }

  if (!baseAudioContextConstructor && audioContextConstructor) {
    wrapAudioMethod(audioContextConstructor.prototype, "createAnalyser", "audio.createAnalyser");
  }

  type RtcWindow = Window & {
    RTCPeerConnection?: typeof RTCPeerConnection;
    webkitRTCPeerConnection?: typeof RTCPeerConnection;
  };

  const patchPeerConnection = (name: "RTCPeerConnection" | "webkitRTCPeerConnection") => {
    const rtcWindow = window as RtcWindow;
    const OriginalPeerConnection = rtcWindow[name];
    if (!OriginalPeerConnection) return;
    const peerConnectionPrototype = OriginalPeerConnection.prototype;
    if (!safeSetHas(patchedRtcPrototypes, peerConnectionPrototype)) {
      safeSetAdd(patchedRtcPrototypes, peerConnectionPrototype);
      wrapRtcMethod(peerConnectionPrototype, "createDataChannel", "webrtc.RTCPeerConnection.createDataChannel");
      wrapRtcMethod(peerConnectionPrototype, "createOffer", "webrtc.RTCPeerConnection.createOffer");
      wrapRtcMethod(peerConnectionPrototype, "setLocalDescription", "webrtc.RTCPeerConnection.setLocalDescription");
    }

    const PatchedPeerConnection = function patched(this: RTCPeerConnection, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
      if (!new.target) {
        return reflectApply(OriginalPeerConnection, this, args) as RTCPeerConnection;
      }
      const constructionTarget =
        (new.target as unknown as Function) === (PatchedPeerConnection as unknown as Function)
          ? OriginalPeerConnection
          : new.target;
      const connection = reflectConstruct(OriginalPeerConnection, args, constructionTarget) as RTCPeerConnection;
      record("webrtc.RTCPeerConnection");
      rtcState.constructorCalls += 1;
      return connection;
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

export async function collectFingerprintObservationsWithCoverage(
  frames: FingerprintFrameLike[]
): Promise<FingerprintObservationCollection> {
  const merged = new Map<string, number>();
  const detections = new Map<FingerprintDetectionSummary["kind"], FingerprintDetectionSummary>();
  let readableFrames = 0;
  let listenerAttributionLostFrames = 0;

  for (const frame of frames) {
    let snapshot: unknown;
    try {
      snapshot = await frame.evaluate(() => {
        type FingerprintWindow = Window & {
          __siteBehaviorLabFingerprintEvents?: Record<string, number>;
          __siteBehaviorLabFingerprintSnapshot?: () => unknown;
        };
        const fingerprintWindow = window as FingerprintWindow;
        return typeof fingerprintWindow.__siteBehaviorLabFingerprintSnapshot === "function"
          ? fingerprintWindow.__siteBehaviorLabFingerprintSnapshot()
          : null;
      });
    } catch {
      continue;
    }

    const normalized = normalizeFingerprintSnapshot(snapshot);
    if (!normalized) continue;
    readableFrames += 1;
    if (normalized.listenerAttributionLost) listenerAttributionLostFrames += 1;
    const { events, detections: frameDetections } = normalized;
    for (const [api, count] of Object.entries(events)) {
      merged.set(api, (merged.get(api) ?? 0) + count);
    }
    for (const detection of frameDetections) {
      mergeFingerprintDetection(detections, detection);
    }
  }

  return {
    observations: {
      events: Array.from(merged.entries())
        .map(([api, count]) => ({ api, count }))
        .sort((a, b) => b.count - a.count || a.api.localeCompare(b.api)),
      detections: Array.from(detections.values()).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    },
    attemptedFrames: frames.length,
    readableFrames,
    listenerAttributionLostFrames
  };
}

function normalizeFingerprintSnapshot(snapshot: unknown): {
  detections: FingerprintDetectionSummary[];
  events: Record<string, number>;
  listenerAttributionLost: boolean;
} | null {
  let candidate = snapshot;
  const serialized = typeof candidate === "string";
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!isRecord(candidate)) return null;

  if (serialized || "events" in candidate || "detections" in candidate) {
    if (!isRecord(candidate.events) || !Array.isArray(candidate.detections)) return null;
    const events = numericRecord(candidate.events);
    if (!events) return null;
    // The observer writes this flag only as `true`. Any other value, or a
    // flagged frame that still carries a listener-coverage summary, is not a
    // snapshot the observer produces and reads as an unreadable frame.
    const listenerAttributionLost = "listenerAttributionLost" in candidate;
    if (listenerAttributionLost && candidate.listenerAttributionLost !== true) return null;
    const detections: FingerprintDetectionSummary[] = [];
    for (const detection of candidate.detections) {
      if (!isFingerprintDetectionSummary(detection)) return null;
      if (
        listenerAttributionLost &&
        (detection.kind === "session-recording" || detection.kind === "input-monitoring")
      ) {
        return null;
      }
      detections.push(detection);
    }
    return {
      detections,
      events,
      listenerAttributionLost
    };
  }

  const legacyEvents = numericRecord(candidate);
  if (!legacyEvents) return null;
  return {
    detections: [],
    events: legacyEvents,
    listenerAttributionLost: false
  };
}

function numericRecord(value: Record<string, unknown>): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) return null;
    result[key] = item;
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

  // The in-page observer never emits keystroke-exfiltration (it is network-side,
  // built in the scanner), but the union now includes it, so clone it verbatim
  // to keep the listener-coverage fallback narrowed.
  if (detection.kind === "keystroke-exfiltration") {
    return { ...detection, evidence: { ...detection.evidence } };
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
