import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/** Hard resource bounds for a policy document fetched outside the page. */
export const MAX_POLICY_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_POLICY_PDF_PAGES = 64;
/**
 * Bounds on READING the document. The byte cap bounds only the compressed
 * transfer, the page cap only the page count, and the text ceiling only the
 * output: a 700 KB file whose one FlateDecode stream expands to hundreds of MB
 * of text operators passes all three and then costs tens of seconds of CPU and
 * gigabytes of memory to decode. The wall-clock bound is the same class as the
 * policy page's own navigation timeout; the scanner clamps it to the remaining
 * scan budget. The memory bound is checked against the parse thread's V8 heap
 * plus its external (typed array) memory, which is where decoded streams live.
 */
export const MAX_POLICY_PDF_PARSE_MS = 8_000;
export const MAX_POLICY_PDF_PARSE_MEMORY_MB = 256;
const PARSE_MEMORY_POLL_MS = 100;
const PDFJS_SPECIFIER = "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * The parse thread. Kept as source text rather than a file on disk: the
 * runtime image ships the Next server bundle, node_modules and nothing under
 * lib/, so a worker script under lib/ would have no path that exists in
 * production. pdf.js is loaded from node_modules by the file URL the main
 * thread resolved, which every host that can run the scanner has.
 *
 * The loop is all-or-nothing on the text ceiling, exactly as before: a prefix
 * would be a fail-open, because later policy claims could live in the omitted
 * portion. Anything that throws reports as unreadable.
 */
const POLICY_PDF_PARSE_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { bytes, maxPages, maxTextChars, pdfjsHref } = workerData;

async function extract() {
  const { getDocument } = await import(pdfjsHref);
  const loadingTask = getDocument({ data: bytes, useSystemFonts: false, useWasm: false });
  const document = await loadingTask.promise;
  if (document.numPages <= 0 || document.numPages > maxPages) return null;

  let text = "";
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = "";
    for (const item of content.items) {
      if (!("str" in item) || typeof item.str !== "string" || item.str.length === 0) continue;
      const itemSeparator = pageText.length === 0 ? "" : " ";
      const pageSeparator = text.length === 0 ? "" : "\n";
      if (
        text.length + pageSeparator.length + pageText.length + itemSeparator.length + item.str.length >
        maxTextChars
      ) {
        return null;
      }
      pageText += itemSeparator + item.str;
    }
    pageText = pageText.trim();
    if (pageText.length === 0) continue;
    text += (text.length === 0 ? "" : "\n") + pageText;
  }
  return text.trim() || null;
}

extract().then(
  (text) => parentPort.postMessage({ text }),
  () => parentPort.postMessage({ text: null })
);
`;

/**
 * Extract policy text from an already SSRF-checked, size-bounded PDF.
 *
 * `null` means the document cannot support a complete policy cross-check: it
 * is malformed/encrypted, exceeds a declared bound, contains no usable text,
 * or could not be read inside the parse bounds. Returning a prefix would be a
 * fail-open because later policy claims could live in the omitted portion, so
 * every bound is all-or-nothing.
 *
 * The parse runs on its own thread. pdf.js in Node runs its "worker" on the
 * calling thread, so decoding a hostile content stream was synchronous work on
 * the scanner's only event loop: the deadline race around this call could not
 * fire until the decode finished, one scan overran the 45 s wall by tens of
 * seconds, and the other scan slot, the job queue and the health check all
 * stopped being served in the meantime. A thread can be terminated in the
 * middle of that work, and its memory can be observed from outside while it
 * runs, so the bounds below hold no matter what the document does.
 */
export async function extractPolicyTextFromPdf(
  bytes: Uint8Array,
  maxTextChars: number,
  deadlineMs = MAX_POLICY_PDF_PARSE_MS
): Promise<string | null> {
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength > MAX_POLICY_PDF_BYTES ||
    maxTextChars <= 0 ||
    deadlineMs <= 0 ||
    !hasPdfSignature(bytes)
  ) {
    return null;
  }

  // workerData is structured-cloned, so the parse thread gets its own copy of
  // the bytes and the caller's bounded byte accounting cannot be detached as a
  // side effect of pdf.js transferring its input.
  const worker = new Worker(POLICY_PDF_PARSE_SOURCE, {
    eval: true,
    workerData: { bytes, maxPages: MAX_POLICY_PDF_PAGES, maxTextChars, pdfjsHref: resolvePdfjsHref() },
    // V8 aborts the thread itself when its heap outgrows this, which covers
    // the poll's latency for heap-heavy documents (a 64 MB string operand
    // becomes an array of 64 million one-character strings while it is read).
    resourceLimits: { maxOldGenerationSizeMb: MAX_POLICY_PDF_PARSE_MEMORY_MB }
  });
  const memoryLimitBytes = MAX_POLICY_PDF_PARSE_MEMORY_MB * 1024 * 1024;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let memoryPoll: ReturnType<typeof setInterval> | null = null;
  try {
    return await new Promise<string | null>((resolve) => {
      deadline = setTimeout(() => resolve(null), deadlineMs);
      // Decoded streams are typed arrays, which the heap limit above does not
      // govern: a stream of no-op operators stays cheap on the heap while its
      // decode buffer doubles towards a gigabyte. Read the thread's memory from
      // here; the read is an interrupt the thread answers between operators,
      // even while it is busy.
      let readingMemory = false;
      memoryPoll = setInterval(() => {
        if (readingMemory) return;
        readingMemory = true;
        worker.getHeapStatistics().then(
          (stats) => {
            readingMemory = false;
            if (stats.used_heap_size + stats.external_memory > memoryLimitBytes) resolve(null);
          },
          () => undefined
        );
      }, PARSE_MEMORY_POLL_MS);
      worker.on("message", (message: unknown) => resolve(policyTextFromParseMessage(message, maxTextChars)));
      worker.on("error", () => resolve(null));
      worker.on("exit", () => resolve(null));
    });
  } finally {
    if (deadline) clearTimeout(deadline);
    if (memoryPoll) clearInterval(memoryPoll);
    // terminate() requests the isolate's termination synchronously and the
    // thread stops at its next interrupt check; the returned promise only
    // reports the exit, so nothing on the scan path waits on it.
    void worker.terminate().catch(() => undefined);
  }
}

function policyTextFromParseMessage(message: unknown, maxTextChars: number): string | null {
  if (typeof message !== "object" || message === null || !("text" in message)) return null;
  const { text } = message as { text: unknown };
  return typeof text === "string" && text.length > 0 && text.length <= maxTextChars ? text : null;
}

// Resolved against the working directory rather than this module: inside the
// Next server bundle there is no module path to resolve from, and the runtime
// image's working directory is the one that holds node_modules.
function resolvePdfjsHref(): string {
  const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
  return pathToFileURL(nodeRequire.resolve(PDFJS_SPECIFIER)).href;
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}
