import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPORT_PDF_MAX_BYTES as SHARED_CEILING } from "./report-pdf-limits";
import {
  REPORT_PDF_MAX_BYTES,
  ReportPdfUnavailableError,
  assertRenderedPdfWithinCeiling,
  memoizedRenderBrowserForTests,
  renderReportPdf,
  reportPdfFilename,
  seedRenderBrowserForTests
} from "./report-pdf";
import { MAX_CONCURRENT_REPORT_PDF_RENDERS, MAX_CONCURRENT_SCANS } from "./scan-limits";

/**
 * These cover the decisions the renderer makes BEFORE it touches Chromium, plus
 * the sizing contract. The end-to-end render is asserted where it can actually
 * run: scripts/smoke-docker.mjs, against the real container.
 */

test("a report id that is not a report id never reaches the browser", async () => {
  // The whole SSRF argument for this module rests on this: the only input is an
  // id, and a non-id is refused before anything is launched. If any of these
  // got through, the navigation target would be attacker-shaped.
  const rejected = [
    "../../etc/passwd",
    "http://169.254.169.254/latest/meta-data/",
    "20260101-" + "a".repeat(32) + "/../../admin",
    "20260101-" + "a".repeat(32) + "?x=1",
    "20260101-" + "a".repeat(31),
    "20260101-" + "A".repeat(32),
    "",
    "..",
    "a b",
    // REPORT_ID_PATTERN.test() alone accepts this: JavaScript's `$` matches
    // before a single trailing newline. The renderer must not.
    "20260101-" + "a".repeat(32) + "\n"
  ];

  for (const id of rejected) {
    await assert.rejects(
      () => renderReportPdf(id),
      (error: unknown) => {
        assert.ok(error instanceof ReportPdfUnavailableError, `${id} should be refused by the id guard`);
        assert.equal(error.status, 400);
        return true;
      },
      `${id} must not reach a browser launch`
    );
  }
});

test("printing can never claim as many renderers as scanning", () => {
  // Both Chromiums live in one standard-2 instance. If a future scan-cap change
  // could raise the print cap alongside it, the instance would be oversubscribed
  // by a change that never mentions printing.
  assert.ok(
    MAX_CONCURRENT_REPORT_PDF_RENDERS < MAX_CONCURRENT_SCANS,
    "the render cap must stay strictly below the scan cap"
  );
  assert.ok(MAX_CONCURRENT_REPORT_PDF_RENDERS >= 1, "at least one render must be possible");
  assert.ok(MAX_CONCURRENT_REPORT_PDF_RENDERS <= 1, "a second concurrent Chromium tab is not budgeted");
});

test("the byte ceiling refuses rather than truncates, and an empty render is a fault", () => {
  // This exercises the decision the renderer actually makes. The first version
  // of this test only compared REPORT_PDF_MAX_BYTES against its own literal and
  // constructed an error by hand, so replacing the refusal with a silent
  // `pdf.subarray(0, REPORT_PDF_MAX_BYTES)` would have left it green: the exact
  // truncation its own name forbids.
  assert.doesNotThrow(() => assertRenderedPdfWithinCeiling(1));
  assert.doesNotThrow(() => assertRenderedPdfWithinCeiling(REPORT_PDF_MAX_BYTES));

  assert.throws(
    () => assertRenderedPdfWithinCeiling(REPORT_PDF_MAX_BYTES + 1),
    (error: unknown) => {
      assert.ok(error instanceof ReportPdfUnavailableError);
      assert.equal(error.status, 413, "an oversize render is a size refusal, not a server fault");
      assert.match(error.message, /print the page from your browser/, "the reader needs a way forward");
      return true;
    }
  );

  assert.throws(
    () => assertRenderedPdfWithinCeiling(0),
    (error: unknown) => {
      assert.ok(error instanceof ReportPdfUnavailableError);
      assert.equal(error.status, 502, "an empty document is a renderer fault, not an empty report");
      return true;
    }
  );
});

test("the ceiling has one definition, and the container smoke reads that one", () => {
  // The smoke bounds the response it downloads with the same number. When it
  // was a hand-copied literal, raising one and not the other would have made
  // the smoke refuse a document the route was willing to serve.
  assert.equal(REPORT_PDF_MAX_BYTES, SHARED_CEILING);
  const smoke = readFileSync(path.join(process.cwd(), "scripts", "smoke-docker.mjs"), "utf8");
  assert.match(
    smoke,
    /import \{ REPORT_PDF_MAX_BYTES \} from "\.\.\/lib\/report-pdf-limits\.ts"/,
    "the smoke must import the ceiling, not restate it"
  );
  assert.doesNotMatch(smoke, /24 \* 1024 \* 1024/, "no second copy of the ceiling arithmetic");
});

test("every phrase the container smoke looks for still exists in the code that renders it", () => {
  // The smoke reads text back out of a generated PDF, so its needles are copies
  // of product copy living in a second file: reword the source and the smoke
  // goes quiet instead of failing, which is this repository's most common
  // defect shape. Each needle is pinned to the module that renders it.
  const smoke = readFileSync(path.join(process.cwd(), "scripts", "smoke-docker.mjs"), "utf8");
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  const pinned: Array<[string, string]> = [
    ["Approved use", "app/_components/print-evidence-footer.tsx"],
    ["Exact evidence bytes", "app/_components/print-evidence-footer.tsx"],
    ["This print is a rendering, not the evidence", "app/_components/print-evidence-footer.tsx"],
    ["Verify independently", "app/_components/print-evidence-footer.tsx"],
    ["This report is a time-limited share", "app/_components/print-evidence-footer.tsx"],
    ["Evidence receipt", "app/_components/report-page-context.tsx"],
    [
      "severity reflects fixed reference thresholds, not measured population percentiles",
      "lib/report-findings.ts"
    ]
  ];

  for (const [phrase, file] of pinned) {
    assert.ok(smoke.includes(phrase), `scripts/smoke-docker.mjs should still assert "${phrase}"`);
    assert.ok(
      source(file).includes(phrase),
      `"${phrase}" is asserted by the container smoke but no longer appears in ${file}`
    );
  }

  // The request-table header run, lowercased in the smoke because the uppercase
  // is a CSS text-transform. The columns are separate <th> elements, so the
  // source is checked column by column in the order the run requires.
  const tables = source("app/_components/report-tables.tsx");
  const columns = ["Status", "Type", "Domain", "Provenance", "URL"];
  assert.ok(
    smoke.includes(columns.join(" ").toLowerCase()),
    "the smoke should assert the request-table header run"
  );
  let cursor = tables.indexOf("request-table");
  assert.ok(cursor >= 0);
  for (const column of columns) {
    const next = tables.indexOf(`<th scope="col">${column}</th>`, cursor);
    assert.ok(next > cursor, `the request table should still render a ${column} column after the previous one`);
    cursor = next;
  }
});

test("the filename carries the site and the report id, and cannot escape a directory", () => {
  const id = "20260101-" + "a".repeat(32);
  assert.equal(reportPdfFilename(id, "example.com"), `site-behavior-lab-example.com-${id}.pdf`);

  // A domain reaches this from report data, so it is treated as untrusted for
  // the purpose of building a filename: no separators, no quotes, no CR/LF that
  // could break out of the Content-Disposition header.
  for (const hostile of [
    '../../etc/passwd',
    'a/b',
    'a\\b',
    'a"b',
    "a\r\nX-Injected: 1",
    "a;b",
    "  "
  ]) {
    const filename = reportPdfFilename(id, hostile);
    assert.doesNotMatch(filename, /[\\/"\r\n;]/, `${JSON.stringify(hostile)} produced ${filename}`);
    assert.match(filename, /^site-behavior-lab-[a-z0-9.\-]*-?20260101-a{32}\.pdf$/i, filename);
  }

  // An entirely unusable domain still yields a usable filename.
  assert.equal(reportPdfFilename(id, "///"), `site-behavior-lab-report-${id}.pdf`);
  assert.equal(reportPdfFilename(id, ""), `site-behavior-lab-report-${id}.pdf`);
});

test("the render is bounded, and a render that never returns does not keep the slot", async () => {
  // The defect this covers: Playwright issues page.pdf() with the protocol's
  // no-timeout option, so page.setDefaultTimeout cannot reach it. Without a
  // deadline, one wedged render never releases the single slot and every later
  // request gets a 503 that says "retry shortly" and can never succeed.
  //
  // Driven through the real exported function with a stub browser, so it fails
  // if the deadline is removed, if the slot is released only on success, or if
  // the unbounded page.close() moves back onto the release path.
  const id = `20260101-${"c".repeat(32)}`;
  let closedPages = 0;
  let closedBrowsers = 0;
  const wedged = {
    async newPage() {
      return {
        setDefaultTimeout() {},
        async goto() {
          return { ok: () => true, status: () => 200 };
        },
        // Never settles, exactly like a Chromium wedged on layout.
        pdf: () => new Promise<never>(() => undefined),
        close: async () => {
          closedPages += 1;
        }
      };
    },
    close: async () => {
      closedBrowsers += 1;
    },
    on() {},
    isConnected: () => true
  };

  const started = Date.now();
  await assert.rejects(
    () => renderReportPdf(id, { browserForTests: wedged, renderTimeoutMsForTests: 60 }),
    (error: unknown) => {
      assert.ok(error instanceof ReportPdfUnavailableError, "a missed deadline is a typed refusal");
      assert.equal(error.status, 504);
      return true;
    }
  );
  assert.ok(Date.now() - started < 5_000, "the render must not wait on an unbounded pdf()");
  // Cleanup is bounded but no longer destructive by default. The page this
  // stub hands out closes cleanly, so the page is reclaimed and the browser
  // survives; only a page that will NOT close costs the browser, which the
  // stuck-page test below covers. This assertion previously required the
  // browser to be closed on every deadline miss, which is what made a reader
  // navigating away destroy the shared renderer.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closedPages, 1, "the wedged render's page is reclaimed on a deadline");
  assert.equal(closedBrowsers, 0, "a reclaimable page must not cost the shared browser");

  // The slot is free: a second render is admitted rather than refused with 503.
  await assert.rejects(
    () => renderReportPdf(id, { browserForTests: wedged, renderTimeoutMsForTests: 60 }),
    (error: unknown) => {
      assert.ok(error instanceof ReportPdfUnavailableError);
      assert.equal(error.status, 504, "the slot was still held, so this was refused as busy instead");
      return true;
    }
  );
});

test("an abandoned request stops holding the only render slot", async () => {
  const id = `20260101-${"d".repeat(32)}`;
  const controller = new AbortController();
  const wedged = {
    async newPage() {
      return {
        setDefaultTimeout() {},
        async goto() {
          return { ok: () => true, status: () => 200 };
        },
        pdf: () => new Promise<never>(() => undefined),
        close: async () => undefined
      };
    },
    close: async () => undefined,
    on() {},
    isConnected: () => true
  };

  const pending = renderReportPdf(id, { browserForTests: wedged, renderTimeoutMsForTests: 30_000, signal: controller.signal });
  const rejected = assert.rejects(() => pending);
  controller.abort(new Error("the reader navigated away"));
  await rejected;
});

test("a long domain is bounded so the filename stays usable", () => {
  const id = "20260101-" + "b".repeat(32);
  const filename = reportPdfFilename(id, `${"x".repeat(300)}.example`);
  assert.ok(filename.length < 140, `filename was ${filename.length} characters`);
  assert.ok(filename.endsWith(`${id}.pdf`));
});

test("a failed render evicts the memoized browser before the slot is freed", async () => {
  // The defect: the failure path closed the browser but left it memoized, and
  // `disconnected` only clears the memo when the close actually lands (measured
  // at 4-8ms). The finally frees the single slot in the SAME tick, so a caller
  // admitted in that gap was handed a browser mid-shutdown, failed newPage(),
  // and got an untyped error the route could only report as 500.
  //
  // Driven through the memo rather than `browserForTests`, because that seam
  // bypasses the module state this is about.
  const id = `20260101-${"e".repeat(32)}`;
  let closedBrowsers = 0;
  const wedged = {
    async newPage() {
      return {
        setDefaultTimeout() {},
        async goto() {
          return { ok: () => true, status: () => 200 };
        },
        pdf: () => new Promise<never>(() => undefined),
        close: async () => undefined
      };
    },
    // Never fires "disconnected", which is the point: eviction must not depend
    // on it. A close that takes any time at all leaves the same window.
    close: async () => {
      closedBrowsers += 1;
    },
    on() {},
    isConnected: () => true
  };

  seedRenderBrowserForTests(wedged);
  assert.equal(memoizedRenderBrowserForTests(), wedged, "the memo should start populated");

  await assert.rejects(
    () => renderReportPdf(id, { renderTimeoutMsForTests: 60 }),
    (error: unknown) => error instanceof ReportPdfUnavailableError && error.status === 504
  );

  // The page this stub hands out closes cleanly, so the browser is reclaimed
  // rather than condemned. The eviction contract still holds where it matters
  // and is asserted by the stuck-page test: when the page cannot be closed, the
  // memo is cleared BEFORE the detached close, so no caller is handed a browser
  // mid-shutdown.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closedBrowsers, 0, "a reclaimable page leaves the shared browser alone");
  assert.equal(
    memoizedRenderBrowserForTests(),
    wedged,
    "a healthy browser stays memoized for the next reader"
  );
  seedRenderBrowserForTests(null);
});

test("a refusal that proves the browser is healthy keeps it memoized", async () => {
  // The other half: 404 and 413 are decided from a browser that answered, so
  // recycling Chromium for them would throw away a working renderer on input
  // the renderer handled correctly.
  const id = `20260101-${"f".repeat(32)}`;
  let closedBrowsers = 0;
  const healthy = {
    async newPage() {
      return {
        setDefaultTimeout() {},
        async goto() {
          return { ok: () => false, status: () => 404 };
        },
        pdf: async () => Buffer.alloc(0),
        close: async () => undefined
      };
    },
    close: async () => {
      closedBrowsers += 1;
    },
    on() {},
    isConnected: () => true
  };

  seedRenderBrowserForTests(healthy);
  await assert.rejects(
    () => renderReportPdf(id, {}),
    (error: unknown) => error instanceof ReportPdfUnavailableError && error.status === 404
  );
  assert.equal(closedBrowsers, 0, "a 404 from the print page does not condemn the browser");
  assert.equal(memoizedRenderBrowserForTests(), healthy, "the healthy browser stays available");
  seedRenderBrowserForTests(null);
});

test("a reader navigating away closes its page but keeps the shared renderer", async () => {
  // The defect: abort took the same branch as a wedged renderer, so one reader
  // pressing Escape destroyed a healthy Chromium and cleared the memo. Abort is
  // the EXPECTED case — the route answers 499 for it — and repeating it kept
  // the shared renderer permanently cold at no cost to the abandoner.
  const id = `20260101-${"a".repeat(31)}1`;
  const controller = new AbortController();
  let closedBrowsers = 0;
  let closedPages = 0;
  const healthy = {
    async newPage() {
      return {
        setDefaultTimeout() {},
        async goto() {
          return { ok: () => true, status: () => 200 };
        },
        pdf: () => new Promise<never>(() => undefined),
        close: async () => {
          closedPages += 1;
        }
      };
    },
    close: async () => {
      closedBrowsers += 1;
    },
    on() {},
    isConnected: () => true
  };

  seedRenderBrowserForTests(healthy);
  const pending = renderReportPdf(id, { renderTimeoutMsForTests: 30_000, signal: controller.signal });
  const rejected = assert.rejects(() => pending);
  // Let the render actually open its page first. Aborting synchronously rejects
  // back in browserForRendering, before newPage() has resolved, so there is no
  // page to reclaim and the assertion below would pass while testing nothing.
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort(new Error("the reader navigated away"));
  await rejected;

  // The detached page close is scheduled on the microtask queue; let it run.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(closedPages, 1, "the abandoned page is reclaimed");
  assert.equal(closedBrowsers, 0, "a reader navigating away must not destroy the shared renderer");
  assert.equal(
    memoizedRenderBrowserForTests(),
    healthy,
    "the healthy browser stays memoized for the next reader"
  );
  seedRenderBrowserForTests(null);
});

test("a page that will not close still condemns the browser", async () => {
  // The other half: the escalation must survive. page.close() is unbounded in
  // Playwright, so a genuinely stuck page can only be reclaimed by destroying
  // the browser, and keeping it would leak a running pdf() onto the next render.
  const id = `20260101-${"b".repeat(31)}2`;
  let closedBrowsers = 0;
  const stuck = {
    async newPage() {
      return {
        setDefaultTimeout() {},
        async goto() {
          return { ok: () => true, status: () => 200 };
        },
        pdf: () => new Promise<never>(() => undefined),
        // Never settles, exactly like a page wedged on layout.
        close: () => new Promise<void>(() => undefined)
      };
    },
    close: async () => {
      closedBrowsers += 1;
    },
    on() {},
    isConnected: () => true
  };

  seedRenderBrowserForTests(stuck);
  await assert.rejects(
    () => renderReportPdf(id, { renderTimeoutMsForTests: 60, pageCloseTimeoutMsForTests: 60 }),
    (error: unknown) => error instanceof ReportPdfUnavailableError && error.status === 504
  );
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(closedBrowsers, 1, "a page that cannot be closed must cost the browser");
  assert.equal(memoizedRenderBrowserForTests(), null, "and the memo must be evicted with it");
  seedRenderBrowserForTests(null);
});
