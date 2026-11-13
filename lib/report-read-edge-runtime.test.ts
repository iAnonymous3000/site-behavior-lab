import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { test } from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import { publicClientHash } from "./edge-scan-gate";

/**
 * The production Worker, run in workerd, with the container replaced by a
 * stand-in that records what reaches it (test-fixtures/report-read-edge-runtime.test.ts).
 * lib/report-read-edge.test.ts covers the gate itself against the real limiter
 * store; this file covers what only the Worker can show: that its public path
 * runs the gate before it forwards, that the production Durable Object's
 * charge method hands the store the quota the gate named (the stand-in runs
 * that method, not a copy of it), and that the reads the Worker makes for
 * itself do not go through the gate.
 */

const REPORT_ID = `20260721-${"e".repeat(32)}`;
const JSON_PATH = `/api/reports/${REPORT_ID}`;
const PDF_PATH = `/api/reports/${REPORT_ID}/pdf`;
const READER = "203.0.113.20";

type HarnessState = {
  forwarded: Array<{ method: string; path: string; targetPort: string | null }>;
  limits: Array<{ bucket: string; used: number }>;
  jobs: Record<"durable" | "registered", { jobId: string; reportId: string }>;
};

/**
 * Bundle the stand-in and start it in workerd. The Worker logs why it closed
 * a route; that is held out of the test output for the caller to show only if
 * its test fails.
 */
async function startHarnessWorker(): Promise<{ mf: Miniflare; runtimeOutput: () => string; stop: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "sbl-report-read-edge-"));
  let runtimeOutput = "";
  try {
    execFileSync(process.execPath, [
      "node_modules/wrangler/bin/wrangler.js", "deploy", "test-fixtures/report-read-edge-runtime.test.ts",
      "--dry-run", "--outdir", dir, "--name", "report-read-edge", "--compatibility-date", "2026-06-19",
      "--compatibility-flags", "nodejs_compat"
    ], { cwd: process.cwd(), env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, stdio: "pipe" });
    const mf = new Miniflare({
      modules: true, scriptPath: path.join(dir, "report-read-edge-runtime.test.js"), modulesRoot: dir,
      compatibilityDate: "2026-06-19", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SCANNER: { className: "ReportReadEdgeHarness", useSQLite: true } },
      durableObjectsPersist: false, log: new Log(LogLevel.ERROR),
      handleRuntimeStdio: (stdout: Readable, stderr: Readable) => {
        for (const stream of [stdout, stderr]) {
          stream.on("data", (chunk: unknown) => {
            runtimeOutput += String(chunk);
          });
        }
      }
    });
    return {
      mf,
      runtimeOutput: () => runtimeOutput,
      stop: async () => {
        await mf.dispose();
        await rm(dir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

test(
  "the production Worker meters the report JSON and the PDF on its public path, and never its own reads of a saved report",
  { timeout: 90_000 },
  async () => {
    const harness = await startHarnessWorker();
    const mf = harness.mf;
    try {
      const send = async (
        method: string,
        requestPath: string,
        headers: Record<string, string> = {}
      ): Promise<{ status: number; headers: Headers; text: string }> => {
        const response = await mf.dispatchFetch(`https://scanner.invalid${requestPath}`, {
          method,
          headers: { "cf-connecting-ip": READER, ...headers }
        });
        return { status: response.status, headers: response.headers as unknown as Headers, text: await response.text() };
      };
      const state = async () =>
        (await (await mf.dispatchFetch("https://scanner.invalid/__harness/state")).json()) as HarnessState;
      // The stand-in charges every read at one fixed instant, in minute window
      // 1, so the counts below do not depend on when or how fast this runs.
      // The window id is dropped from each bucket name for reading.
      const ledger = async (): Promise<Record<string, number>> =>
        Object.fromEntries((await state()).limits.map(({ bucket, used }) => [bucket.replace("/1", ""), used]));
      const forwarded = async () => (await state()).forwarded.map((entry) => `${entry.method} ${entry.path}`);
      const readerHash = await publicClientHash(new Headers({ "cf-connecting-ip": READER }));

      // A GET and a HEAD of the JSON are each charged once, in the JSON's own
      // client bucket and the API routes' world bucket, and forwarded.
      assert.equal((await send("GET", JSON_PATH)).status, 404, "the stand-in container answers 404 for every report");
      assert.equal((await send("HEAD", JSON_PATH)).status, 404);
      assert.deepEqual(await ledger(), {
        "report-api-read-global": 2,
        [`report-json-read/${readerHash}`]: 2
      });
      assert.deepEqual(await forwarded(), [`GET ${JSON_PATH}`, `HEAD ${JSON_PATH}`]);

      // Any other method is answered here. Nothing is charged or forwarded.
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        for (const requestPath of [JSON_PATH, PDF_PATH]) {
          const answer = await send(method, requestPath);
          assert.equal(answer.status, 405, `${method} ${requestPath}`);
          assert.equal(answer.headers.get("allow"), "GET, HEAD, OPTIONS");
        }
      }
      const preflight = await send("OPTIONS", JSON_PATH, {
        origin: "https://sitebehavior.org",
        "access-control-request-method": "GET"
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "https://sitebehavior.org");
      assert.equal((await forwarded()).length, 2, "no method that is not a read reaches the container");

      // A path that is not a report read goes on to the container uncharged.
      assert.equal((await send("GET", "/api/reports/not-a-report")).status, 404);
      assert.equal((await send("GET", `${PDF_PATH}/extra`)).status, 404);
      assert.deepEqual((await forwarded()).slice(2), ["GET /api/reports/not-a-report", `GET ${PDF_PATH}/extra`]);
      assert.equal((await ledger())["report-api-read-global"], 2);

      // The reader's 120 JSON reads, then a refusal the static site can read
      // across origins. The refused request never reaches the container.
      for (let sent = 2; sent < 120; sent += 1) {
        assert.equal((await send(sent % 2 === 0 ? "GET" : "HEAD", JSON_PATH)).status, 404, `JSON read ${sent + 1}`);
      }
      const containerRequests = (await forwarded()).length;
      for (const method of ["GET", "HEAD"]) {
        const refused = await send(method, JSON_PATH, { origin: "https://sitebehavior.org" });
        assert.equal(refused.status, 429, `${method} past the reader's JSON cap`);
        assert.equal(refused.headers.get("retry-after"), "60");
        assert.equal(refused.headers.get("cache-control"), "no-store");
        assert.equal(refused.headers.get("access-control-allow-origin"), "https://sitebehavior.org");
        assert.equal(refused.headers.get("access-control-expose-headers"), "Retry-After");
        if (method === "GET") {
          assert.deepEqual(JSON.parse(refused.text), { ok: false, error: "Too many report requests. Try again shortly." });
        }
      }
      assert.equal((await forwarded()).length, containerRequests, "a refused read must not reach the container");

      // The Worker's own reads. With this reader's JSON budget spent, a status
      // poll for each job still makes the Worker read that job's saved report
      // from the container: the read is forwarded, it is not refused, and it
      // spends nothing.
      const { jobs } = await state();
      const jsonLedgerBefore = await ledger();
      for (const job of [jobs.durable, jobs.registered]) {
        const poll = await send("GET", `/api/scans/${job.jobId}`);
        assert.notEqual(poll.status, 429, "the poll is not a report read and must not meet the report quota");
        assert.ok(
          (await forwarded()).includes(`GET /api/reports/${job.reportId}`),
          `the Worker did not read the saved report of job ${job.jobId} itself; this test no longer exercises that read`
        );
      }
      assert.deepEqual(await ledger(), jsonLedgerBefore, "the Worker's own report reads must not spend a reader's quota");

      // The page budget is untouched by all of the above, and a page read
      // spends only it.
      assert.equal((await send("GET", `/reports/${REPORT_ID}`)).status, 200, "the stand-in answers 200 off the API");
      assert.deepEqual(await ledger(), {
        ...jsonLedgerBefore,
        "report-read-global": 1,
        [`report-read/${readerHash}`]: 1
      });

      // The PDF: ten for one reader, the export query included, then Node's
      // own sentence. HEAD counts, because Node renders for a HEAD too.
      for (let sent = 0; sent < 10; sent += 1) {
        const requestPath = sent % 3 === 0 ? `${PDF_PATH}?download=bundle` : PDF_PATH;
        assert.equal((await send(sent % 2 === 0 ? "GET" : "HEAD", requestPath)).status, 404, `PDF request ${sent + 1}`);
      }
      const refusedPdf = await send("GET", PDF_PATH);
      assert.equal(refusedPdf.status, 429);
      assert.equal(refusedPdf.headers.get("retry-after"), "60");
      assert.deepEqual(JSON.parse(refusedPdf.text), {
        ok: false,
        error: "Too many PDF requests. Print the page from your browser, or try again shortly."
      });
      assert.equal((await send("HEAD", PDF_PATH)).status, 429);

      // Each PDF request spent one unit of its own client bucket and one of
      // the world bucket the JSON reads spend. There is no PDF world bucket,
      // and the page's buckets hold only the one page read above.
      assert.deepEqual(await ledger(), {
        "report-api-read-global": 130,
        [`report-json-read/${readerHash}`]: 120,
        [`report-pdf/${readerHash}`]: 10,
        "report-read-global": 1,
        [`report-read/${readerHash}`]: 1
      });

      // So the world is not held to a figure sized to the render slot: 31 more
      // PDF requests in the same minute, one each from 31 other clients, are
      // all admitted. The slot in the container bounds renders, not the edge.
      for (let client = 0; client < 31; client += 1) {
        assert.equal(
          (await send("GET", PDF_PATH, { "cf-connecting-ip": `198.51.100.${client + 1}` })).status,
          404,
          `PDF request from client ${client + 1}`
        );
      }
      assert.equal((await forwarded()).filter((entry) => entry.endsWith(PDF_PATH)).length, 41);
      const final = await ledger();
      assert.equal(final["report-api-read-global"], 161);
      assert.equal(final["report-pdf-global"], undefined);
      assert.equal(final[`report-pdf/${readerHash}`], 10);
      assert.equal(final[`report-json-read/${readerHash}`], 120);
      assert.equal(final["report-read-global"], 1);

      // A Worker one release older sends the Durable Object no quota. The
      // production method then charges a page read, the one kind that Worker
      // knew, and nothing in the API buckets.
      const older = await mf.dispatchFetch("https://scanner.invalid/__harness/charge-as-older-worker");
      assert.deepEqual(await older.json(), { allowed: true });
      const afterOlder = await ledger();
      assert.equal(afterOlder[`report-read/${"0".repeat(64)}`], 1);
      assert.equal(afterOlder["report-read-global"], 2);
      assert.equal(afterOlder["report-api-read-global"], 161);

      // A quota that cannot be charged closes the route. It does not open it.
      await mf.dispatchFetch("https://scanner.invalid/__harness/break-limiter");
      const beforeOutage = (await forwarded()).length;
      for (const requestPath of [JSON_PATH, PDF_PATH, `/reports/${REPORT_ID}`]) {
        const closed = await send("GET", requestPath, { "cf-connecting-ip": "198.51.100.201" });
        assert.equal(closed.status, 503, requestPath);
        assert.equal(closed.headers.get("retry-after"), "5");
        assert.deepEqual(JSON.parse(closed.text), { ok: false, error: "Report reads are temporarily unavailable." });
      }
      assert.equal((await forwarded()).length, beforeOutage, "an uncharged read must not reach the container");
    } catch (error) {
      if (harness.runtimeOutput()) console.error(harness.runtimeOutput());
      throw error;
    } finally {
      await harness.stop();
    }
  }
);

test(
  "the production Worker never forwards a client's container port header",
  { timeout: 90_000 },
  async () => {
    // @cloudflare/containers reads cf-container-target-port in Container.fetch
    // to choose the port inside the container. A client that could set it
    // would turn any forwarded route into an error, or aim it at another
    // listener. Whether Cloudflare's edge removes the header first is not
    // known, so the Worker does not rely on it.
    const harness = await startHarnessWorker();
    try {
      const paths = ["/api/health", `/reports/${REPORT_ID}`, JSON_PATH, "/api/reports/not-a-report", "/favicon.ico"];
      for (const requestPath of paths) {
        for (const value of ["65535", "nan"]) {
          await harness.mf.dispatchFetch(`https://scanner.invalid${requestPath}`, {
            headers: { "cf-connecting-ip": READER, "cf-container-target-port": value }
          });
        }
      }
      const { forwarded } = (await (await harness.mf.dispatchFetch("https://scanner.invalid/__harness/state")).json()) as HarnessState;
      for (const requestPath of paths) {
        assert.equal(
          forwarded.filter((entry) => entry.path === requestPath).length,
          2,
          `${requestPath} was not forwarded twice; this test no longer exercises that route`
        );
      }
      assert.deepEqual(forwarded.filter((entry) => entry.targetPort !== null), []);
    } catch (error) {
      if (harness.runtimeOutput()) console.error(harness.runtimeOutput());
      throw error;
    } finally {
      await harness.stop();
    }
  }
);
