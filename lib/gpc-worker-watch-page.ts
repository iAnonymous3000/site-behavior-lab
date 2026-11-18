/**
 * The GPC worker watch page: one fixed static page on this site's own origin,
 * public/monitor/gpc-worker/, that starts one dedicated worker from a
 * same-origin script on a fixed timer after load. The worker fetches one fixed
 * same-origin file once, so a report of the page shows in its own request log
 * that a dedicated worker ran (the wire records no worker count).
 *
 * This module only names the page. Nothing here admits a scan: the monitor
 * credential's allowlist lives in lib/production-synthetic.ts. The page URL is
 * the one literal; everything else is derived from it, and the calibration
 * development exclusions read that literal from this file's text.
 *
 * No runtime imports, so a script can load this file directly.
 */
export const GPC_WORKER_WATCH_PAGE_URL = "https://sitebehavior.org/monitor/gpc-worker/";

/** The one request the watch worker makes, as fetched. */
export const GPC_WORKER_WATCH_PING_URL = new URL("ping/ok.txt", GPC_WORKER_WATCH_PAGE_URL).href;

/**
 * The same request as an r2 report records it: redaction-v2 generalizes every
 * path segment, so the ping sits one segment deeper than anything else the page
 * loads and is counted by that recorded form. A test derives it from the
 * redactor.
 */
export const GPC_WORKER_WATCH_PING_RECORDED_URL = `${new URL(GPC_WORKER_WATCH_PAGE_URL).origin}/{seg}/{seg}/{seg}/{seg}`;

/**
 * The page starts its worker this long after its load event. The scanner's
 * passive window runs from domcontentloaded until network idle (lib/scanner.ts
 * NETWORK_IDLE_TIMEOUT_MS, 8 s at most), and Playwright calls a page idle only
 * after 500 ms without network activity, so a start this soon after load falls
 * inside the window. public/monitor/gpc-worker/index.html carries the same
 * number; a test holds the two together.
 */
export const GPC_WORKER_WATCH_WORKER_DELAY_MS = 200;
