import { chromium, type Browser } from "playwright";
import { browserProcessEnvironment } from "./browser-process-env";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import { REPORT_PDF_MAX_BYTES } from "./report-pdf-limits";
import { REPORT_ID_PATTERN } from "./report-validation";
import { MAX_CONCURRENT_REPORT_PDF_RENDERS } from "./scan-limits";
import { withScannerOperationDeadline } from "./scanner-resource-lifecycle";

/**
 * Render one report's printable page to PDF, inside the container.
 *
 * The printable route already server-renders the complete evidence with the
 * evidence footer, the wire digest, the approved use boundary and the standing
 * caveat. This turns that exact page into a file, so the PDF and the printed
 * page carry the same content from the same stylesheet: there is no second
 * renderer and no second set of copy. Not the same BYTES as a browser's own
 * print output, though: Chromium's print dialog defaults to adding its own
 * header and footer and to fitting the page, neither of which a programmatic
 * render does.
 *
 * SSRF is the obvious hazard in "server fetches a URL and renders it", so no
 * URL is ever accepted. The only input is a report id, it must match
 * REPORT_ID_PATTERN before anything is launched, and the navigation target is
 * assembled here from a loopback host and the app's own port. A caller cannot
 * influence the scheme, host, port or path shape.
 *
 * Chromium is deliberately NOT the scanner's shared browser. Scanning is the
 * product; a burst of PDF requests must not contend for the instance that
 * serves it, and a crash in one must not take the other down. This keeps its
 * own lazily-created instance behind a cap derived from the scan cap, so the
 * blast radius of the feature is bounded to itself.
 *
 * The renderer still gets the scanner's child-environment allowlist. It loads
 * our own page, but that page paints strings the scanned site controlled
 * (request URLs, cookie names, storage keys), so it must not inherit R2
 * credentials, Turnstile secrets or scan tokens either.
 */

// The ceiling lives in its own import-free module because the container smoke
// bounds the response with the same number and cannot load this file without
// loading Playwright. Re-exported so this module stays the one import path for
// everything about rendering a report to PDF.
export { REPORT_PDF_MAX_BYTES };

/**
 * Whole-render deadline: navigation, settle and PDF write.
 *
 * Measured against a production build, the largest committed report (a 1.00 MB
 * wire) took 1,361ms to reach networkidle and 611ms to write, 1,972ms end to
 * end. This sits an order of magnitude above that, because the container is
 * slower and may be rendering while a scan holds its own Chromium, and because
 * the bound exists to catch a WEDGED renderer rather than a slow one.
 */
const RENDER_TIMEOUT_MS = 45_000;
const LAUNCH_TIMEOUT_MS = 30_000;
/**
 * How long a failed render's page gets to close before the browser is condemned.
 *
 * Short on purpose: this only distinguishes "the page is reclaimable" from "the
 * page is stuck", and it runs detached so it never delays the render slot.
 */
const PAGE_CLOSE_TIMEOUT_MS = 2_000;
const IDLE_SHUTDOWN_MS = 60_000;

/**
 * The only browser surface the render path uses.
 *
 * Playwright's own Browser and Page satisfy these structurally, so production
 * passes the real thing. Naming the surface is what lets a test drive the real
 * `renderReportPdf` against a stub whose `pdf()` never settles, which is the
 * only way to assert that a wedged renderer releases its slot.
 */
type RenderPage = {
  setDefaultTimeout(timeout: number): void;
  goto(
    url: string,
    options: { waitUntil: "networkidle"; timeout: number }
  ): Promise<{ ok(): boolean; status(): number } | null>;
  pdf(options: {
    format: string;
    printBackground: boolean;
    preferCSSPageSize: boolean;
  }): Promise<Uint8Array>;
  close(): Promise<void>;
};
type RenderBrowser = {
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
  /** Playwright's Browser satisfies this; a test stub supplies a no-op. */
  on?(event: "disconnected", handler: () => void): void;
};

let launchPromise: Promise<RenderBrowser> | null = null;
/** Identity of the browser the memoized promise settled to, for disconnect. */
let launchedBrowser: RenderBrowser | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let active = 0;

export class ReportPdfUnavailableError extends Error {
  readonly status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = "ReportPdfUnavailableError";
    this.status = status;
  }
}

/**
 * Seed and read the memoized renderer, for tests only.
 *
 * `browserForTests` deliberately bypasses `browserForRendering`, so it can
 * never observe what happens to the MEMO when a render fails. That is exactly
 * where the eviction bug lived, so these give a test the one thing that seam
 * cannot: a render that goes through the memoized browser.
 */
export function seedRenderBrowserForTests(browser: RenderBrowser | null): void {
  launchPromise = browser ? Promise.resolve(browser) : null;
  launchedBrowser = browser;
}

export function memoizedRenderBrowserForTests(): RenderBrowser | null {
  return launchedBrowser;
}

/** The app's own loopback origin. Never a caller-supplied value. */
function selfOrigin(): string {
  // `next start` in the container is pinned to 3000 (Dockerfile CMD and its
  // own HEALTHCHECK both hardcode it); PORT is honoured so a dev server on
  // another port still renders.
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ReportPdfUnavailableError("The server port is not configured for local rendering.", 500);
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * The render browser, launched at most once.
 *
 * The memoized value is the PROMISE, not the browser: two concurrent first
 * requests both observe a null browser, and awaiting a launch each would orphan
 * one Chromium that nothing ever closes. Same shape the scanner uses for its
 * own shared browser. A failed launch clears the slot so one transient failure
 * does not poison every later request, and a launch that lands after its
 * deadline is closed rather than leaked.
 */
async function browserForRendering(signal?: AbortSignal): Promise<RenderBrowser> {
  launchPromise ??= withScannerOperationDeadline<Browser>(
    () =>
      chromium.launch({
        headless: true,
        chromiumSandbox: chromiumSandboxEnabled(),
        // No scanner launch args: this renders our own trusted page, and the
        // scanner's WebRTC flag is about measurement fidelity, not printing.
        args: [],
        env: browserProcessEnvironment()
      }),
    {
      label: "Report PDF browser launch",
      timeoutMs: LAUNCH_TIMEOUT_MS,
      createTimeoutError: () =>
        new ReportPdfUnavailableError("The PDF renderer could not start in time.", 503),
      // Playwright's launch takes no AbortSignal. If it materializes after
      // losing the deadline race, close it immediately so a timed-out launch
      // cannot leak a browser process.
      onLateSuccess: (browser) => browser.close()
    }
  )
    .then((browser) => {
      browser.on("disconnected", () => {
        // Only the CURRENT browser may clear the slot. A late disconnect from a
        // browser we already replaced must not evict its successor.
        if (launchedBrowser === browser) {
          launchPromise = null;
          launchedBrowser = null;
        }
      });
      launchedBrowser = browser;
      return browser;
    })
    .catch((error: unknown) => {
      launchPromise = null;
      throw error;
    });

  // One caller abandoning its request must not cancel a launch other callers
  // are already awaiting, so the caller's signal is raced against the shared
  // promise instead of being passed into it.
  const pending = launchPromise;
  if (!signal) return pending;
  return Promise.race([
    pending,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })
  ]);
}

/** Close the idle renderer so a container that never prints holds no browser. */
function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (active > 0) return;
    const pending = launchPromise;
    launchPromise = null;
    launchedBrowser = null;
    void pending?.then((browser) => browser.close()).catch(() => undefined);
  }, IDLE_SHUTDOWN_MS);
  // A pending shutdown must never hold the process open.
  idleTimer.unref?.();
}

export function reportPdfFilename(id: string, domain: string): string {
  const safeDomain = domain.replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `site-behavior-lab-${safeDomain || "report"}-${id}.pdf`;
}

/**
 * The size decision, as its own function so it can be exercised directly.
 *
 * A render that exceeds the ceiling is REFUSED, never clipped: a silently
 * truncated evidence PDF is worse than no PDF. An empty one is a renderer
 * fault, not an empty report. The ceiling is roughly seventeen times the
 * largest document the committed corpus produces (1.38 MB).
 */
export function assertRenderedPdfWithinCeiling(byteLength: number): void {
  if (byteLength === 0) {
    throw new ReportPdfUnavailableError("The renderer produced an empty document.", 502);
  }
  if (byteLength > REPORT_PDF_MAX_BYTES) {
    throw new ReportPdfUnavailableError(
      "This report renders larger than the export ceiling; print the page from your browser instead.",
      413
    );
  }
}

/**
 * Render `/reports/<id>/print` to PDF bytes.
 *
 * Throws ReportPdfUnavailableError when the renderer is saturated, the page
 * does not answer, or the render misses its deadline; the caller maps that to a
 * status.
 */
export async function renderReportPdf(
  id: string,
  {
    signal,
    browserForTests,
    renderTimeoutMsForTests,
    pageCloseTimeoutMsForTests
  }: {
    signal?: AbortSignal;
    /** Drives the render against a stub browser. Production never supplies this. */
    browserForTests?: RenderBrowser;
    /** Shortens only the render deadline, so a wedged render is testable. */
    renderTimeoutMsForTests?: number;
    /** Shortens only the page-reclaim deadline; production uses the constant. */
    pageCloseTimeoutMsForTests?: number;
  } = {}
): Promise<Uint8Array> {
  // `.test()` alone is not enough to make an id safe to paste into a path:
  // JavaScript's `$` also matches before a single trailing newline, so
  // "<id>\n" passes REPORT_ID_PATTERN. Requiring the match to consume the whole
  // string closes that, and closes it here rather than by widening a pattern
  // the wire validator also depends on.
  const match = REPORT_ID_PATTERN.exec(id);
  if (!match || match[0] !== id) {
    throw new ReportPdfUnavailableError("Not a report id.", 400);
  }
  if (active >= MAX_CONCURRENT_REPORT_PDF_RENDERS) {
    throw new ReportPdfUnavailableError(
      "The report renderer is busy. Print the page from your browser, or retry shortly.",
      503
    );
  }

  active += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const renderTimeoutMs = renderTimeoutMsForTests ?? RENDER_TIMEOUT_MS;
  let page: RenderPage | null = null;
  try {
    const browser = browserForTests ?? (await browserForRendering(signal));
    // ONE deadline over the whole render. Playwright issues page.pdf() with the
    // protocol's no-timeout option, so page.setDefaultTimeout cannot reach it:
    // without this bound a renderer wedged on layout never returns, the slot is
    // never released, and every later request gets a "retry shortly" that can
    // never succeed. page.close() has the same property, which is why it is
    // detached in the finally rather than awaited.
    return await withScannerOperationDeadline<Uint8Array>(
      async () => {
        const opened = await browser.newPage();
        page = opened;
        opened.setDefaultTimeout(renderTimeoutMs);

        const response = await opened.goto(`${selfOrigin()}/reports/${id}/print`, {
          // NOT "load". The findings board resolves its severity basis from a
          // client-side corpus fetch, and a document captured at `load` states
          // "fixed reference thresholds, not measured population percentiles"
          // where the settled page states the measured-percentile basis. A
          // printed exhibit that qualifies its own conclusions differently from
          // the page it claims to be is the failure this route exists to
          // prevent, so the render waits for the page to go quiet.
          waitUntil: "networkidle",
          timeout: renderTimeoutMs
        });
        if (!response || !response.ok()) {
          throw new ReportPdfUnavailableError(
            `The printable page answered ${response?.status() ?? "no response"}.`,
            response?.status() === 404 ? 404 : 502
          );
        }

        // The page's own print stylesheet owns pagination, margins and what is
        // hidden: app/globals.css declares `@page { size: letter; margin: 14mm 12mm }`
        // and preferCSSPageSize makes that rule win. `format` is only the
        // fallback if that rule is ever removed, and it names the same paper so
        // the two cannot disagree.
        const pdf = await opened.pdf({
          format: "Letter",
          printBackground: false,
          preferCSSPageSize: true
        });
        assertRenderedPdfWithinCeiling(pdf.byteLength);
        return pdf;
      },
      {
        label: "Report PDF render",
        timeoutMs: renderTimeoutMs,
        signal,
        createTimeoutError: () =>
          new ReportPdfUnavailableError(
            "This report took too long to render; print the page from your browser instead.",
            504
          )
      }
    ).catch((error: unknown) => {
      // The render lost its deadline, or the caller went away, or Playwright
      // itself failed. Only a refusal that PROVES the browser is still healthy
      // keeps it outright: a 404 (the print page answered) and a 413 (a
      // complete document, merely too large). An empty document is decided here
      // too but is deliberately NOT in that set, because zero bytes back from
      // page.pdf() is evidence the renderer itself is wrong.
      const decided =
        error instanceof ReportPdfUnavailableError && (error.status === 404 || error.status === 413);
      if (!decided) {
        // Everything else USED to destroy the shared browser. That was wrong for
        // the most common case by far: a reader navigating away aborts the
        // request, which is expected (the route answers 499 for it), and it was
        // being treated as a wedged renderer. One reader pressing Escape threw
        // away a healthy Chromium, and repeating it kept the shared renderer
        // permanently cold at no cost to the abandoner.
        //
        // The real constraint is narrower: page.close() is unbounded in
        // Playwright, so a WEDGED page cannot be reclaimed by closing it. So
        // try the page on a deadline, detached, and escalate to destroying the
        // browser only when that close actually misses. An abort or a plain
        // Playwright error closes its page and leaves the browser to the next
        // reader; only a genuinely stuck page costs a relaunch.
        const abandoned = page;
        page = null;
        void (async () => {
          const reclaimed = await withScannerOperationDeadline<void>(
            () => abandoned?.close() ?? Promise.resolve(),
            {
              label: "Report PDF page close",
              timeoutMs: pageCloseTimeoutMsForTests ?? PAGE_CLOSE_TIMEOUT_MS,
              createTimeoutError: () =>
                new ReportPdfUnavailableError("The render page did not close in time.", 503)
            }
          ).then(
            () => true,
            () => false
          );
          if (reclaimed) return;

          // The page is stuck. Evict the memo BEFORE closing, exactly as
          // scheduleIdleShutdown does: `disconnected` clears it too, but lands
          // an event-loop turn or more later (measured 4-8ms), and a caller
          // admitted in between gets a browser mid-shutdown and fails newPage()
          // with an untyped TargetClosedError. An isConnected() check on reuse
          // does not close that window; it stays true until `disconnected`.
          if (launchedBrowser === browser) {
            launchPromise = null;
            launchedBrowser = null;
          }
          void browser.close().catch(() => undefined);
        })();
      }
      throw error;
    });
  } finally {
    // Release the slot FIRST and unconditionally. page.close() is unbounded in
    // Playwright, so awaiting it here would put an unbounded operation on the
    // path that frees the only render slot.
    active -= 1;
    if (active === 0) scheduleIdleShutdown();
    void (page as RenderPage | null)?.close().catch(() => undefined);
  }
}
