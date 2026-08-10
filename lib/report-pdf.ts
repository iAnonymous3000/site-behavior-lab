import { chromium, type Browser } from "playwright";
import { browserProcessEnvironment } from "./browser-process-env";
import { chromiumSandboxEnabled } from "./chromium-sandbox";
import { REPORT_ID_PATTERN } from "./report-validation";
import { MAX_CONCURRENT_REPORT_PDF_RENDERS } from "./scan-limits";

/**
 * Render one report's printable page to PDF, inside the container.
 *
 * The printable route already server-renders the complete evidence with the
 * evidence footer, the wire digest, the approved use boundary and the standing
 * caveat. This turns that exact page into a file, so the PDF and the printed
 * page are the same artefact and cannot drift: there is no second renderer and
 * no second set of copy.
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

/** A complete evidence page is large, but not unbounded. */
export const REPORT_PDF_MAX_BYTES = 24 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 30_000;
const IDLE_SHUTDOWN_MS = 60_000;

let launchPromise: Promise<Browser> | null = null;
/** Identity of the browser the memoized promise settled to, for disconnect. */
let launchedBrowser: Browser | null = null;
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
 * does not poison every later request.
 */
async function browserForRendering(): Promise<Browser> {
  launchPromise ??= chromium
    .launch({
      headless: true,
      chromiumSandbox: chromiumSandboxEnabled(),
      // No scanner launch args: this renders our own trusted page, and the
      // scanner's WebRTC flag is about measurement fidelity, not printing.
      args: [],
      env: browserProcessEnvironment()
    })
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
  return launchPromise;
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
 * Render `/reports/<id>/print` to PDF bytes.
 *
 * Throws ReportPdfUnavailableError when the renderer is saturated or the page
 * does not answer; the caller maps that to a status. It never returns a partial
 * or truncated document: a render that exceeds the byte ceiling is refused
 * rather than clipped, because a silently truncated evidence PDF is worse than
 * no PDF.
 */
export async function renderReportPdf(id: string): Promise<Uint8Array> {
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
  let page: Awaited<ReturnType<Browser["newPage"]>> | null = null;
  try {
    const browser = await browserForRendering();
    page = await browser.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);

    const response = await page.goto(`${selfOrigin()}/reports/${id}/print`, {
      waitUntil: "load",
      timeout: RENDER_TIMEOUT_MS
    });
    if (!response || !response.ok()) {
      throw new ReportPdfUnavailableError(
        `The printable page answered ${response?.status() ?? "no response"}.`,
        response?.status() === 404 ? 404 : 502
      );
    }

    // The page's own print stylesheet owns pagination, margins and what is
    // hidden: app/globals.css declares `@page { size: letter; margin: 14mm 12mm }`
    // and preferCSSPageSize makes that rule win. `format` is only the fallback
    // if that rule is ever removed, and it names the same paper so the two can
    // never disagree. Asking Chromium for its own defaults instead would
    // silently diverge from what a reader gets from Ctrl+P.
    const pdf = await page.pdf({
      format: "Letter",
      printBackground: false,
      preferCSSPageSize: true
    });

    if (pdf.byteLength === 0) {
      throw new ReportPdfUnavailableError("The renderer produced an empty document.", 502);
    }
    if (pdf.byteLength > REPORT_PDF_MAX_BYTES) {
      throw new ReportPdfUnavailableError(
        "This report renders larger than the export ceiling; print the page from your browser instead.",
        413
      );
    }
    return pdf;
  } finally {
    await page?.close().catch(() => undefined);
    active -= 1;
    if (active === 0) scheduleIdleShutdown();
  }
}
