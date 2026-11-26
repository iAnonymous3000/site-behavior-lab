/**
 * Expanded fingerprinting & behavioral replay probe for Site Behavior Lab v3.
 *
 * Covers:
 *  - Canvas & OffscreenCanvas readback (+ text writes)
 *  - Canvas font probing (measureText across distinct fonts)
 *  - WebGL entropy reads (UNMASKED_VENDOR/RENDERER, extensions, readPixels)
 *  - AudioContext fingerprinting (OfflineAudioContext, AnalyserNode)
 *  - WebGPU (`navigator.gpu.requestAdapter`)
 *  - High-Entropy Client Hints (`navigator.userAgentData.getHighEntropyValues`)
 *  - DOM / CSS font enumeration (`document.fonts.check` / rapid width probing)
 *  - DOM-wide `MutationObserver` session-replay instrumentation (rrweb/Clarity/FullStory/1p)
 *  - WebRTC (`RTCPeerConnection`)
 *  - Screen / hardware fingerprinting surface
 *  - JavaScript `document.cookie` writes (distinguishes JS vs HTTP cookies)
 *
 * Pure init-script string + pure analyzer so every heuristic is 100% unit-testable
 * without a browser and safe to inject into pages, iframes, and workers.
 */

import type { FingerprintDetectionV3, FingerprintRealmV3, FingerprintSignalKindV3 } from "../schema";

export const FINGERPRINT_V3_GLOBAL_KEY = "__sblV3FpTelemetry";

export type RawFingerprintEventV3 = {
  api: string;
  realm: FingerprintRealmV3;
  scriptDomain: string | null;
  detail?: Record<string, string | number | boolean>;
};

export type RawFingerprintSnapshotV3 = {
  events: RawFingerprintEventV3[];
  jsCookieNames: string[];
  droppedEvents: number;
};

/**
 * Self-contained browser init script installed via `context.addInitScript` (runs
 * in main document + all iframes before site scripts) and injected into worker
 * realms via CDP `Runtime.evaluate`.
 */
export function buildFingerprintInitScriptV3(realm: FingerprintRealmV3 = "main"): string {
  return `(() => {
    if (globalThis[${JSON.stringify(FINGERPRINT_V3_GLOBAL_KEY)}]) return;
    const MAX_EVENTS = 600;
    const isTop = typeof window !== "undefined" && window === window.top;
    const effectiveRealm = ${JSON.stringify(realm)} === "main" && !isTop ? "iframe" : ${JSON.stringify(realm)};
    const state = { events: [], jsCookieNames: [], droppedEvents: 0 };
    const jsCookieSet = new Set();
    const MAX_JS_COOKIE_NAMES = 500;
    const ALLOWED_CLIENT_HINTS = new Set([
      "architecture", "bitness", "brands", "formFactors", "fullVersionList",
      "mobile", "model", "platform", "platformVersion", "uaFullVersion", "wow64"
    ]);

    function extractScriptDomain() {
      try {
        const stack = new Error().stack || "";
        const lines = stack.split("\\n").slice(2, 8);
        for (const line of lines) {
          const match = /https?:\\/\\/[^\\s)]+/i.exec(line);
          if (match && match[0]) {
            const parsed = new URL(match[0].replace(/:\\d+(?::\\d+)?$/, ""));
            if (parsed.hostname) return parsed.hostname.toLowerCase();
          }
        }
      } catch {}
      return null;
    }

    function record(api, detail) {
      if (state.events.length >= MAX_EVENTS) {
        state.droppedEvents += 1;
        return;
      }
      state.events.push({
        api,
        realm: effectiveRealm,
        scriptDomain: extractScriptDomain(),
        detail: detail || undefined
      });
    }

    function wrapMethod(proto, prop, api, extractDetail) {
      if (!proto || typeof proto[prop] !== "function") return;
      const orig = proto[prop];
      try {
        Object.defineProperty(proto, prop, {
          configurable: true,
          writable: true,
          value: function(...args) {
            try {
              const detail = extractDetail ? extractDetail(this, args) : undefined;
              record(api, detail);
            } catch {}
            return orig.apply(this, args);
          }
        });
      } catch {}
    }

    // 1. Canvas & OffscreenCanvas
    if (typeof HTMLCanvasElement !== "undefined") {
      wrapMethod(HTMLCanvasElement.prototype, "toDataURL", "canvas.toDataURL", (el) => ({ w: el.width || 0, h: el.height || 0 }));
      wrapMethod(HTMLCanvasElement.prototype, "toBlob", "canvas.toBlob", (el) => ({ w: el.width || 0, h: el.height || 0 }));
    }
    if (typeof OffscreenCanvas !== "undefined") {
      wrapMethod(OffscreenCanvas.prototype, "convertToBlob", "offscreenCanvas.convertToBlob", (el) => ({ w: el.width || 0, h: el.height || 0 }));
    }
    if (typeof CanvasRenderingContext2D !== "undefined") {
      wrapMethod(CanvasRenderingContext2D.prototype, "getImageData", "canvas2d.getImageData", (_ctx, args) => ({ w: Number(args[2]) || 0, h: Number(args[3]) || 0 }));
      wrapMethod(CanvasRenderingContext2D.prototype, "fillText", "canvas2d.fillText", (_ctx, args) => ({ len: String(args[0] || "").length }));
      wrapMethod(CanvasRenderingContext2D.prototype, "measureText", "canvas2d.measureText", (ctx, args) => ({ font: String(ctx.font || "").slice(0, 64), len: String(args[0] || "").length }));
    }
    if (typeof OffscreenCanvasRenderingContext2D !== "undefined") {
      wrapMethod(OffscreenCanvasRenderingContext2D.prototype, "getImageData", "offscreen2d.getImageData");
      wrapMethod(OffscreenCanvasRenderingContext2D.prototype, "fillText", "offscreen2d.fillText");
      wrapMethod(OffscreenCanvasRenderingContext2D.prototype, "measureText", "offscreen2d.measureText", (ctx) => ({ font: String(ctx.font || "").slice(0, 64) }));
    }

    // 2. WebGL
    const WEBGL_ENTROPY_PARAMS = new Set([37445, 37446, 7936, 7937, 7938, 35724, 3379, 34076, 36347, 36348]);
    for (const ctor of [typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext : null, typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext : null]) {
      if (!ctor) continue;
      wrapMethod(ctor.prototype, "getParameter", "webgl.getParameter", (_ctx, args) => {
        const param = Number(args[0]);
        return WEBGL_ENTROPY_PARAMS.has(param) ? { param } : { param: 0 };
      });
      wrapMethod(ctor.prototype, "getSupportedExtensions", "webgl.getSupportedExtensions");
      wrapMethod(ctor.prototype, "readPixels", "webgl.readPixels");
    }

    // 3. AudioContext
    if (typeof OfflineAudioContext !== "undefined") {
      wrapMethod(OfflineAudioContext.prototype, "startRendering", "audio.startRendering");
    }
    if (typeof AnalyserNode !== "undefined") {
      wrapMethod(AnalyserNode.prototype, "getFloatFrequencyData", "audio.getFloatFrequencyData");
      wrapMethod(AnalyserNode.prototype, "getByteFrequencyData", "audio.getByteFrequencyData");
    }

    // 4. WebGPU
    if (typeof navigator !== "undefined" && navigator.gpu) {
      wrapMethod(Object.getPrototypeOf(navigator.gpu), "requestAdapter", "webgpu.requestAdapter");
    }

    // 5. High-Entropy Client Hints (strictly allowlisted W3C hint names)
    if (typeof navigator !== "undefined" && navigator.userAgentData) {
      wrapMethod(Object.getPrototypeOf(navigator.userAgentData), "getHighEntropyValues", "clientHints.getHighEntropyValues", (_u, args) => ({
        hints: Array.isArray(args[0])
          ? args[0]
              .map((h) => String(h || "").trim())
              .filter((h) => ALLOWED_CLIENT_HINTS.has(h))
              .slice(0, 12)
              .join(",")
          : ""
      }));
    }

    // 6. DOM / CSS Font Enumeration
    if (typeof FontFaceSet !== "undefined") {
      wrapMethod(FontFaceSet.prototype, "check", "fonts.check", (_f, args) => ({ font: String(args[0] || "").slice(0, 64) }));
    }

    // 7. MutationObserver DOM-wide session replay
    if (typeof MutationObserver !== "undefined") {
      wrapMethod(MutationObserver.prototype, "observe", "mutationObserver.observe", (_obs, args) => {
        const target = args[0];
        const opts = args[1] || {};
        const isRoot = typeof document !== "undefined" && (target === document || target === document.documentElement || target === document.body);
        return {
          root: Boolean(isRoot),
          subtree: Boolean(opts.subtree),
          attributes: Boolean(opts.attributes),
          characterData: Boolean(opts.characterData),
          childList: Boolean(opts.childList)
        };
      });
    }

    // 8. WebRTC
    if (typeof RTCPeerConnection !== "undefined") {
      const OrigRTC = RTCPeerConnection;
      try {
        const WrappedRTC = function(...args) {
          record("webrtc.RTCPeerConnection");
          return new OrigRTC(...args);
        };
        WrappedRTC.prototype = OrigRTC.prototype;
        Object.setPrototypeOf(WrappedRTC, OrigRTC);
        globalThis.RTCPeerConnection = WrappedRTC;
      } catch {}
    }

    // 9. JavaScript document.cookie writes (names only; values never stored)
    if (typeof Document !== "undefined") {
      try {
        const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
        if (desc && desc.set && desc.get) {
          Object.defineProperty(Document.prototype, "cookie", {
            configurable: true,
            get() {
              return desc.get.call(this);
            },
            set(value) {
              try {
                const raw = String(value || "");
                const eq = raw.indexOf("=");
                if (eq > 0 && jsCookieSet.size < MAX_JS_COOKIE_NAMES) {
                  const name = raw.slice(0, eq).trim().slice(0, 128);
                  if (name) jsCookieSet.add(name);
                }
                record("document.cookie.write");
              } catch {}
              return desc.set.call(this, value);
            }
          });
        }
      } catch {}
    }

    // Expose only an immutable cloned snapshot via a non-configurable getter so
    // untrusted page scripts cannot mutate or forge telemetry arrays.
    try {
      Object.defineProperty(globalThis, ${JSON.stringify(FINGERPRINT_V3_GLOBAL_KEY)}, {
        get() {
          return {
            events: state.events.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : undefined })),
            jsCookieNames: Array.from(jsCookieSet),
            droppedEvents: state.droppedEvents
          };
        },
        configurable: false,
        enumerable: false
      });
    } catch {}
  })();`;
}

/** Pure heuristic classifier converting raw telemetry events into FingerprintDetectionV3[]. */
export function analyzeFingerprintTelemetryV3(
  events: readonly RawFingerprintEventV3[]
): FingerprintDetectionV3[] {
  const detections: FingerprintDetectionV3[] = [];

  const collectMeta = (matched: readonly RawFingerprintEventV3[]) => ({
    realms: [...new Set(matched.map((e) => e.realm))].sort(),
    apis: [...new Set(matched.map((e) => e.api))].sort(),
    scriptDomains: [...new Set(matched.map((e) => e.scriptDomain).filter((d): d is string => Boolean(d)))].sort()
  });

  // 1. Canvas fingerprinting (readback + either text writes or non-trivial canvas)
  const canvasReads = events.filter(
    (e) =>
      e.api === "canvas.toDataURL" ||
      e.api === "canvas.toBlob" ||
      e.api === "canvas2d.getImageData" ||
      e.api === "offscreenCanvas.convertToBlob" ||
      e.api === "offscreen2d.getImageData"
  );
  const canvasText = events.filter((e) => e.api === "canvas2d.fillText" || e.api === "offscreen2d.fillText");
  if (canvasReads.length > 0 && (canvasText.length > 0 || canvasReads.some((e) => Number(e.detail?.w ?? 0) >= 16))) {
    const combined = [...canvasReads, ...canvasText];
    detections.push({
      kind: "canvas",
      count: canvasReads.length,
      ...collectMeta(combined),
      evidence: {
        readCalls: canvasReads.length,
        textWriteCalls: canvasText.length
      }
    });
  }

  // 2. Canvas font probing (>= 8 measureText calls across >= 4 distinct fonts)
  const measureCalls = events.filter((e) => e.api === "canvas2d.measureText" || e.api === "offscreen2d.measureText");
  const distinctCanvasFonts = new Set(measureCalls.map((e) => String(e.detail?.font ?? "")).filter(Boolean));
  if (measureCalls.length >= 8 && distinctCanvasFonts.size >= 4) {
    detections.push({
      kind: "canvas-font",
      count: measureCalls.length,
      ...collectMeta(measureCalls),
      evidence: {
        measureTextCalls: measureCalls.length,
        distinctFonts: distinctCanvasFonts.size
      }
    });
  }

  // 3. WebGL fingerprinting
  const webglEvents = events.filter((e) => e.api.startsWith("webgl."));
  const webglEntropyReads = webglEvents.filter(
    (e) => e.api === "webgl.readPixels" || e.api === "webgl.getSupportedExtensions" || Number(e.detail?.param ?? 0) > 0
  );
  if (webglEntropyReads.length >= 2 || webglEvents.some((e) => e.api === "webgl.readPixels")) {
    detections.push({
      kind: "webgl",
      count: webglEntropyReads.length,
      ...collectMeta(webglEntropyReads),
      evidence: {
        entropyCalls: webglEntropyReads.length,
        readPixelsCalls: webglEvents.filter((e) => e.api === "webgl.readPixels").length
      }
    });
  }

  // 4. AudioContext fingerprinting
  const audioEvents = events.filter((e) => e.api.startsWith("audio."));
  if (audioEvents.length > 0) {
    detections.push({
      kind: "audio",
      count: audioEvents.length,
      ...collectMeta(audioEvents),
      evidence: { calls: audioEvents.length }
    });
  }

  // 5. WebGPU adapter fingerprinting
  const webgpuEvents = events.filter((e) => e.api.startsWith("webgpu."));
  if (webgpuEvents.length > 0) {
    detections.push({
      kind: "webgpu",
      count: webgpuEvents.length,
      ...collectMeta(webgpuEvents),
      evidence: { adapterRequests: webgpuEvents.length }
    });
  }

  // 6. High-Entropy Client Hints (allowlist standard W3C hint tokens to prevent page string injection)
  const ALLOWED_HINTS = new Set([
    "architecture", "bitness", "brands", "formFactors", "fullVersionList",
    "mobile", "model", "platform", "platformVersion", "uaFullVersion", "wow64"
  ]);
  const chEvents = events.filter((e) => e.api === "clientHints.getHighEntropyValues");
  if (chEvents.length > 0) {
    const requestedHints = [
      ...new Set(
        chEvents
          .flatMap((e) => String(e.detail?.hints ?? "").split(","))
          .map((h) => h.trim())
          .filter((h) => ALLOWED_HINTS.has(h))
      )
    ].sort();
    detections.push({
      kind: "client-hints-high-entropy",
      count: chEvents.length,
      ...collectMeta(chEvents),
      evidence: {
        calls: chEvents.length,
        requestedHints
      }
    });
  }

  // 7. DOM / CSS font enumeration (`document.fonts.check` bursts >= 10 distinct fonts)
  const fontChecks = events.filter((e) => e.api === "fonts.check");
  const distinctDomFonts = new Set(fontChecks.map((e) => String(e.detail?.font ?? "")).filter(Boolean));
  if (distinctDomFonts.size >= 10) {
    detections.push({
      kind: "dom-font-enumeration",
      count: fontChecks.length,
      ...collectMeta(fontChecks),
      evidence: {
        checkCalls: fontChecks.length,
        distinctFonts: distinctDomFonts.size
      }
    });
  }

  // 8. MutationObserver DOM-wide replay (requires root + subtree + attributes + characterData to avoid OneTrust/GTM/React false positives)
  const replayObservers = events.filter(
    (e) =>
      e.api === "mutationObserver.observe" &&
      Boolean(e.detail?.root) &&
      Boolean(e.detail?.subtree) &&
      Boolean(e.detail?.attributes) &&
      Boolean(e.detail?.characterData)
  );
  if (replayObservers.length > 0) {
    detections.push({
      kind: "mutation-observer-replay",
      count: replayObservers.length,
      ...collectMeta(replayObservers),
      evidence: {
        rootSubtreeObservers: replayObservers.length
      }
    });
  }

  // 9. WebRTC
  const rtcEvents = events.filter((e) => e.api === "webrtc.RTCPeerConnection");
  if (rtcEvents.length > 0) {
    detections.push({
      kind: "webrtc",
      count: rtcEvents.length,
      ...collectMeta(rtcEvents),
      evidence: { connectionsCreated: rtcEvents.length }
    });
  }

  // 10. JS document.cookie writes
  const jsCookieWrites = events.filter((e) => e.api === "document.cookie.write");
  if (jsCookieWrites.length > 0) {
    detections.push({
      kind: "document-cookie-writes",
      count: jsCookieWrites.length,
      ...collectMeta(jsCookieWrites),
      evidence: { writeCalls: jsCookieWrites.length }
    });
  }

  const order: readonly FingerprintSignalKindV3[] = [
    "canvas",
    "canvas-font",
    "webgl",
    "audio",
    "webgpu",
    "client-hints-high-entropy",
    "dom-font-enumeration",
    "mutation-observer-replay",
    "webrtc",
    "screen-hardware",
    "document-cookie-writes"
  ];
  return detections.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
