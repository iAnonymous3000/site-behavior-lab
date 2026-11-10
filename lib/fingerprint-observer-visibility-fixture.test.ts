import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import path from "node:path";
import { test } from "node:test";
import {
  collectFingerprintObservationsWithCoverage,
  type FingerprintObservationCollection
} from "./fingerprint-observer";
import { FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING } from "./scan-runtime";
import { closeSharedBrowserForTests, scanSiteWithMeasurement } from "./scanner";

/**
 * What a scanned page can see of the fingerprint observer, and what it can do
 * about it, measured through the real scanner pipeline and real Chromium on
 * local fixture pages.
 *
 * The scanner never disguises itself, so a page being able to tell the
 * observer is there is a chosen limit, not a defect. These tests exist so that
 * docs/limitations.md says exactly what was measured: each one pins what a
 * fixture page's own script observed, and fails when that changes, so the
 * document is looked at again.
 */

/** The published statement of these measurements, read as one line of text. */
function limitations(): string {
  return readFileSync(path.join(process.cwd(), "docs", "limitations.md"), "utf8").replace(/\s+/g, " ");
}

function scanOptions(port: number) {
  return {
    publicUrlAlreadyVerified: true,
    verifyPublicUrl: async () => undefined,
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 as const }],
    connectProxyUpstreamForTests: () => connect(port, "127.0.0.1"),
    resolveCnameChain: async () => []
  };
}

/**
 * One fixture page on loopback. Its script reports what it saw by fetching
 * /seen with a JSON query, which this server keeps for the test.
 */
async function fixturePage(
  t: { after(fn: () => unknown): void },
  script: string
): Promise<{ port: number; seen: () => unknown }> {
  let seen: unknown;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    if (url.pathname === "/seen") {
      seen = JSON.parse(url.searchParams.get("d") ?? "null");
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Observer fixture</title>
      <main><p>Ordinary public page whose script reports what it can see.</p></main>
      <script>
        const isNative = (fn) => /\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(fn));
        const report = (value) => fetch("/seen?d=" + encodeURIComponent(JSON.stringify(value)));
        ${script}
      </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  t.after(() => closeSharedBrowserForTests());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { port: address.port, seen: () => seen };
}

/** One visit, and the frame coverage the visit's own collector reads just before its final read. */
async function visit(host: string, port: number) {
  let coverage: Pick<FingerprintObservationCollection, "attemptedFrames" | "readableFrames"> | null = null;
  let frameUrls: string[] = [];
  const { result, measurement } = await scanSiteWithMeasurement(
    { url: `http://${host}/`, device: "desktop", gpcEnabled: false, consentMode: "observe" },
    {
      ...scanOptions(port),
      duringSubjectStateReadsForTests: async (page) => {
        frameUrls = page.frames().map((frame) => frame.url());
        const collection = await collectFingerprintObservationsWithCoverage(page.frames());
        coverage = { attemptedFrames: collection.attemptedFrames, readableFrames: collection.readableFrames };
      }
    }
  );
  return {
    events: result.fingerprintEvents,
    heuristics: (result.fingerprintDetections ?? []).map((detection) => detection.heuristic),
    frameLossWarning: result.warnings.includes(FINGERPRINT_OBSERVER_CAPTURE_LOSS_WARNING),
    detector: measurement.measurement.detectors["fingerprint-heuristics"].status,
    observerLosses: measurement.measurement.qualityFacts.captureLoss.filter((loss) => loss.detail === "fingerprint-observer")
      .length,
    coverage: coverage as Pick<FingerprintObservationCollection, "attemptedFrames" | "readableFrames"> | null,
    frameUrls
  };
}

test("a page script can tell the observer is there: its global answers, and the methods it wraps do not report native code", { timeout: 60_000 }, async (t) => {
  const page = await fixturePage(
    t,
    `
    const name = "__siteBehaviorLabFingerprintSnapshot";
    const descriptor = Object.getOwnPropertyDescriptor(window, name);
    const answer = window[name]();
    const method = (fn, nativeName) => ({ reportsNativeCode: isNative(fn), keepsNativeName: fn.name === nativeName });
    report({
      global: {
        type: typeof window[name],
        inWindow: name in window,
        listedByObjectKeys: Object.keys(window).includes(name),
        descriptor: {
          writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable
        },
        reportsNativeCode: isNative(window[name]),
        answerType: typeof answer,
        answer
      },
      wrapped: {
        "HTMLCanvasElement.prototype.toDataURL": method(HTMLCanvasElement.prototype.toDataURL, "toDataURL"),
        "HTMLCanvasElement.prototype.toBlob": method(HTMLCanvasElement.prototype.toBlob, "toBlob"),
        "CanvasRenderingContext2D.prototype.getImageData": method(CanvasRenderingContext2D.prototype.getImageData, "getImageData"),
        "CanvasRenderingContext2D.prototype.fillText": method(CanvasRenderingContext2D.prototype.fillText, "fillText"),
        "CanvasRenderingContext2D.prototype.strokeText": method(CanvasRenderingContext2D.prototype.strokeText, "strokeText"),
        "CanvasRenderingContext2D.prototype.measureText": method(CanvasRenderingContext2D.prototype.measureText, "measureText"),
        "CanvasRenderingContext2D.prototype.drawImage": method(CanvasRenderingContext2D.prototype.drawImage, "drawImage"),
        "EventTarget.prototype.addEventListener": method(EventTarget.prototype.addEventListener, "addEventListener"),
        "RTCPeerConnection": method(RTCPeerConnection, "RTCPeerConnection")
      },
      untouched: {
        "HTMLCanvasElement.prototype.getContext": method(HTMLCanvasElement.prototype.getContext, "getContext"),
        "CanvasRenderingContext2D.prototype.fillRect": method(CanvasRenderingContext2D.prototype.fillRect, "fillRect")
      }
    });
    `
  );
  const observed = await visit("observer-visible.test", page.port);

  const wrapped = { reportsNativeCode: false, keepsNativeName: false };
  const native = { reportsNativeCode: true, keepsNativeName: true };
  assert.deepEqual(page.seen(), {
    global: {
      // The observer's read surface is an ordinary property of the window. A
      // page finds it by name, though not by listing the window's keys, and
      // cannot replace it once the observer has run.
      type: "function",
      inWindow: true,
      listedByObjectKeys: false,
      descriptor: { writable: false, enumerable: false, configurable: false },
      reportsNativeCode: false,
      // A page can call it, and reads the observer's own tally for its frame:
      // here an empty one, because this page makes no fingerprint-like call.
      answerType: "string",
      answer: '{"detections":[],"events":{}}'
    },
    wrapped: {
      "HTMLCanvasElement.prototype.toDataURL": wrapped,
      "HTMLCanvasElement.prototype.toBlob": wrapped,
      "CanvasRenderingContext2D.prototype.getImageData": wrapped,
      "CanvasRenderingContext2D.prototype.fillText": wrapped,
      "CanvasRenderingContext2D.prototype.strokeText": wrapped,
      "CanvasRenderingContext2D.prototype.measureText": wrapped,
      "CanvasRenderingContext2D.prototype.drawImage": wrapped,
      "EventTarget.prototype.addEventListener": wrapped,
      RTCPeerConnection: wrapped
    },
    // The control: a method the observer leaves alone reads as the browser's.
    untouched: {
      "HTMLCanvasElement.prototype.getContext": native,
      "CanvasRenderingContext2D.prototype.fillRect": native
    }
  });

  // Looking is not itself recorded: the visit of a page that only inspected
  // the observer reads as a page that made no fingerprint-like call, with
  // every frame read.
  assert.deepEqual(observed, {
    events: [],
    heuristics: [],
    frameLossWarning: false,
    detector: "complete",
    observerLosses: 0,
    coverage: { attemptedFrames: 1, readableFrames: 1 },
    frameUrls: ["http://observer-visible.test/"]
  });

  // The limitations page says this, in these words. A changed measurement
  // above means these sentences are read again, not only the assertions.
  const published = limitations();
  assert.ok(
    published.includes(
      "found the observer's function on its window under the name `__siteBehaviorLabFingerprintSnapshot`, called it, and read back the observer's count for that frame"
    )
  );
  assert.ok(published.includes("the methods the observer wraps no longer report native code, while methods the observer leaves alone still do"));
  assert.ok(published.includes("Looking is not recorded: that page's report read as a page that made no fingerprint-like call."));
});

// The canvas work every arm below does: thirty characters of text drawn on a
// 200 by 60 canvas, then read back through the two read calls the observer
// counts as "canvas.toDataURL" and "canvas.getImageData". From the top
// document this matches the canvas heuristic (openwpm-canvas-v1). The arms
// differ only in which window the canvas and the two read methods come from.
const canvasWork = (canvasDocument: string, readRealm: string) => `
  const canvas = ${canvasDocument}.createElement("canvas");
  canvas.width = 200;
  canvas.height = 60;
  const context = canvas.getContext("2d");
  context.fillText("abcdefghijklmnopqrstuvwxyz0123", 2, 20);
  const dataUrl = ${readRealm}.HTMLCanvasElement.prototype.toDataURL.call(canvas);
  const pixels = ${readRealm}.CanvasRenderingContext2D.prototype.getImageData.call(context, 0, 0, 200, 60);
  seen.read = { dataUrlPrefix: dataUrl.slice(0, 22), pixelBytes: pixels.data.length };
  report(seen);
`;

// A frame appended by script, and what its window holds before the task that
// appended it ends.
const NEW_FRAME = `
  const name = "__siteBehaviorLabFingerprintSnapshot";
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const realm = iframe.contentWindow;
  seen.newFrameInSameTask = {
    observerGlobal: typeof realm[name],
    toDataURLReportsNativeCode: isNative(realm.HTMLCanvasElement.prototype.toDataURL),
    getImageDataReportsNativeCode: isNative(realm.CanvasRenderingContext2D.prototype.getImageData)
  };
`;

const REAL_READ = { dataUrlPrefix: "data:image/png;base64,", pixelBytes: 200 * 60 * 4 };
const BOTH_READS_COUNTED = [
  { api: "canvas.getImageData", count: 1 },
  { api: "canvas.toDataURL", count: 1 }
];
const OBSERVED_IN_SAME_TASK = {
  observerGlobal: "function",
  toDataURLReportsNativeCode: false,
  getImageDataReportsNativeCode: false
};

test("known limit, split-frame canvas read: read methods taken from a newly created frame are counted, but the canvas heuristic they match from the top document does not match", { timeout: 120_000 }, async (t) => {
  // Control: the top document draws and reads with its own methods. Both
  // reads are counted and the heuristic matches.
  const control = await fixturePage(t, `const seen = {}; ${canvasWork("document", "window")}`);
  const controlVisit = await visit("observer-control.test", control.port);
  assert.deepEqual(control.seen(), { read: REAL_READ });
  assert.deepEqual(controlVisit, {
    events: BOTH_READS_COUNTED,
    heuristics: ["openwpm-canvas-v1"],
    frameLossWarning: false,
    detector: "complete",
    observerLosses: 0,
    coverage: { attemptedFrames: 1, readableFrames: 1 },
    frameUrls: ["http://observer-control.test/"]
  });

  // The limit. The page appends an iframe and, in the same task, takes the
  // two read methods from the new frame's window and applies them to a canvas
  // of the top document.
  //
  // What was measured: the observer is already in the new frame when the page
  // first touches its window, so the methods the page takes are the
  // observer's wrappers and both reads are counted, by the new frame's
  // observer. The new frame is read (two frames of two). But the heuristic
  // does not match in either frame. Each frame's observer keeps its own
  // record of a canvas, and the heuristic needs the text and the read in one
  // record: the top document's observer recorded the text and no read, the
  // new frame's observer the two reads and no text. The visit says nothing is
  // incomplete.
  //
  // If this assertion starts failing, a change (or a newer browser) altered
  // one of those facts, and docs/limitations.md, "Reading the fingerprinting
  // section", must be read again against the new result.
  const split = await fixturePage(t, `const seen = {}; ${NEW_FRAME} ${canvasWork("document", "realm")}`);
  const splitVisit = await visit("observer-new-frame.test", split.port);
  assert.deepEqual(split.seen(), { newFrameInSameTask: OBSERVED_IN_SAME_TASK, read: REAL_READ });
  assert.deepEqual(splitVisit, {
    events: BOTH_READS_COUNTED,
    heuristics: [],
    frameLossWarning: false,
    detector: "complete",
    observerLosses: 0,
    coverage: { attemptedFrames: 2, readableFrames: 2 },
    frameUrls: ["http://observer-new-frame.test/", "about:blank"]
  });

  // Second control: the whole of the same work done inside the new frame, on
  // a canvas of the new frame's document. It is counted and the heuristic
  // matches, so a new frame is not a place the observer does not reach; the
  // limit above is the split between two frames.
  const whole = await fixturePage(t, `const seen = {}; ${NEW_FRAME} ${canvasWork("realm.document", "realm")}`);
  const wholeVisit = await visit("observer-whole-frame.test", whole.port);
  assert.deepEqual(whole.seen(), { newFrameInSameTask: OBSERVED_IN_SAME_TASK, read: REAL_READ });
  assert.deepEqual(wholeVisit, {
    events: BOTH_READS_COUNTED,
    heuristics: ["openwpm-canvas-v1"],
    frameLossWarning: false,
    detector: "complete",
    observerLosses: 0,
    coverage: { attemptedFrames: 2, readableFrames: 2 },
    frameUrls: ["http://observer-whole-frame.test/", "about:blank"]
  });

  // The limitations page states the three results above in these words.
  const published = limitations();
  assert.ok(
    published.includes(
      "The observer was already in the new frame when the script first reached its window, so both reads were counted, and the new frame was read with the page's own (two frames of two). The canvas heuristic did not match."
    )
  );
  assert.ok(
    published.includes(
      "The same drawing and reads matched it when all of them were made in the top document, and when all of them were made inside the new frame."
    )
  );
  assert.ok(published.includes("That visit's report showed the two reads among its API counts, no canvas finding, and nothing marked incomplete."));
  assert.ok(published.includes("`lib/fingerprint-observer-visibility-fixture.test.ts` repeats both measurements"));
});
