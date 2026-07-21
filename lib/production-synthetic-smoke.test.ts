import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.join(process.cwd(), "scripts/smoke-production-synthetic.mjs");
const MONITOR_TOKEN = "production-synthetic-test-token-123456";
const REPORT_ID = "20260720-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STALE_REPORT_ID = "20260719-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const RUN_ID = "20260720-cccccccccccccccccccccccccccccccc";

test("production synthetic pins its final HTML probe to the canonical stored-report reader", async () => {
  const [script, reportPage, reportSource, reportStore] = await Promise.all([
    readFile(SCRIPT, "utf8"),
    readFile(path.join(process.cwd(), "app", "reports", "[id]", "page.tsx"), "utf8"),
    readFile(path.join(process.cwd(), "lib", "report-source.ts"), "utf8"),
    readFile(path.join(process.cwd(), "lib", "report-store.ts"), "utf8")
  ]);

  assert.match(script, /canonical contract gate[\s\S]*readStoredReportForId[\s\S]*readStoredScanReportById[\s\S]*readManagedReport/);
  assert.match(reportPage, /const result = await readStoredReportForId\(id\)/);
  assert.match(reportSource, /readStoredScanReportById/);
  assert.match(reportStore, /readManagedReport\([\s\S]*reportContents: blob\.contents/);
});

test("production synthetic preserves the legitimate same-origin report flow", async () => {
  let submittedContract: unknown = null;
  const report = syntheticReport();
  const server = await listen((request, response) => {
    if (request.url === "/api/scan" && request.method === "POST") {
      assert.equal(request.headers["x-site-behavior-lab-synthetic-monitor-token"], MONITOR_TOKEN);
      return readBody(request).then((body) => {
        submittedContract = JSON.parse(body);
        sendJson(response, 200, report);
      });
    }
    if (request.url === `/api/reports/${REPORT_ID}`) return sendJson(response, 200, report);
    if (request.url === `/reports/${REPORT_ID}`) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(`<main>${REPORT_ID}</main>`);
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(submittedContract, {
      url: "https://www.iana.org/domains/reserved",
      device: "desktop",
      gpcEnabled: true,
      consentMode: "observe"
    });
    assert.match(result.stdout, /PASS production synthetic completed, persisted, read back, and rendered/);
  } finally {
    await server.close();
  }
});

test("production synthetic rejects an otherwise valid stale direct report, even under an error status", async () => {
  const staleReport = syntheticReport({ startedAt: "2020-01-01T00:00:00.000Z" });
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") return sendJson(response, 500, staleReport);
    if (request.url === `/api/reports/${REPORT_ID}`) return sendJson(response, 200, staleReport);
    if (request.url === `/reports/${REPORT_ID}`) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(`<main>${REPORT_ID}</main>`);
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpected HTTP status 500/);
  } finally {
    await server.close();
  }
});

test("production synthetic rejects reports outside both sides of the invocation clock-skew bound", async () => {
  for (const startedAt of [
    new Date(Date.now() - 120_000).toISOString(),
    new Date(Date.now() + 120_000).toISOString()
  ]) {
    const server = await listen((request, response) => {
      if (request.url === "/api/scan") return sendJson(response, 200, syntheticReport({ startedAt }));
      sendJson(response, 404, { error: "not found" });
    });
    try {
      const result = await runSynthetic(server.origin);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /was not started within this monitor invocation/);
    } finally {
      await server.close();
    }
  }
});

test("production synthetic requires submission status to match the direct or queued response shape", async () => {
  const cases = [
    {
      status: 202,
      payload: syntheticReport(),
      expected: /direct report with queued HTTP status 202/
    },
    {
      status: 200,
      payload: {
        ok: true,
        status: "queued",
        reportId: REPORT_ID,
        statusPath: `/api/scans/${REPORT_ID}`
      },
      expected: /200 without a supported direct report/
    }
  ];
  for (const current of cases) {
    const server = await listen((request, response) => {
      if (request.url === "/api/scan") return sendJson(response, current.status, current.payload);
      sendJson(response, 404, { error: "not found" });
    });
    try {
      const result = await runSynthetic(server.origin);
      assert.equal(result.status, 1);
      assert.match(result.stderr, current.expected);
    } finally {
      await server.close();
    }
  }
});

test("production synthetic requires an HTTP 200 queued-status receipt", async () => {
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") {
      return sendJson(response, 202, {
        ok: true,
        status: "queued",
        reportId: REPORT_ID,
        statusPath: `/api/scans/${REPORT_ID}`
      });
    }
    if (request.url === `/api/scans/${REPORT_ID}`) {
      return sendJson(response, 503, {
        ok: true,
        status: "succeeded",
        report: syntheticReport()
      });
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /status returned unexpected HTTP status 503/);
  } finally {
    await server.close();
  }
});

test("production synthetic never forwards its monitor credential across a redirect", async () => {
  let receiverRequests = 0;
  let leakedCredential: string | undefined;
  const receiver = await listen((request, response) => {
    receiverRequests += 1;
    leakedCredential = request.headers["x-site-behavior-lab-synthetic-monitor-token"] as string | undefined;
    sendJson(response, 200, syntheticReport());
  });
  const redirector = await listen((_request, response) => {
    response.writeHead(302, { location: `${receiver.origin}/stolen` });
    response.end();
  });

  try {
    const result = await runSynthetic(redirector.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /request failed or exceeded/);
    assert.equal(receiverRequests, 0);
    assert.equal(leakedCredential, undefined);
  } finally {
    await redirector.close();
    await receiver.close();
  }
});

test("production synthetic refuses cross-origin status capabilities before polling them", async () => {
  let receiverRequests = 0;
  const receiver = await listen((_request, response) => {
    receiverRequests += 1;
    sendJson(response, 200, { ok: true, status: "running" });
  });
  const submitter = await listen((_request, response) => {
    sendJson(response, 202, {
      ok: true,
      status: "queued",
      reportId: REPORT_ID,
      statusPath: `${receiver.origin}/api/scans/${REPORT_ID}`
    });
  });

  try {
    const result = await runSynthetic(submitter.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside its exact same-origin path contract/);
    assert.equal(receiverRequests, 0);
  } finally {
    await submitter.close();
    await receiver.close();
  }
});

test("production synthetic rejects a supported report for the wrong requested subject", async () => {
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") {
      return sendJson(response, 200, syntheticReport({ requestedOrigin: "https://example.com" }));
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not describe the fixed IANA requested subject/);
  } finally {
    await server.close();
  }
});

test("production synthetic rejects a report that navigated to the wrong observed subject", async () => {
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") {
      return sendJson(response, 200, syntheticReport({ observedOrigin: "https://example.com" }));
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not finish on the fixed IANA observed subject/);
  } finally {
    await server.close();
  }
});

test("production synthetic rejects a report that changes the fixed visit conditions", async () => {
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") return sendJson(response, 200, syntheticReport({ gpc: false }));
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not retain the fixed desktop, GPC-on, observe-mode conditions/);
  } finally {
    await server.close();
  }
});

test("production synthetic rejects a stale report returned for a newly queued scan", async () => {
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") {
      return sendJson(response, 202, {
        ok: true,
        status: "queued",
        reportId: REPORT_ID,
        statusPath: "/api/scans/synthetic-job"
      });
    }
    if (request.url === "/api/scans/synthetic-job") {
      return sendJson(response, 200, {
        ok: true,
        status: "succeeded",
        report: syntheticReport({ reportId: STALE_REPORT_ID })
      });
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /other than its reserved queued report ID/);
  } finally {
    await server.close();
  }
});

test("production synthetic binds persisted readback to the completed run identity", async () => {
  const startedAt = new Date().toISOString();
  const report = syntheticReport({ startedAt });
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") return sendJson(response, 200, report);
    if (request.url === `/api/reports/${REPORT_ID}`) {
      return sendJson(response, 200, syntheticReport({ runId: `${RUN_ID}-stale`, startedAt }));
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exact saved report/);
  } finally {
    await server.close();
  }
});

test("production synthetic binds persisted readback to the exact run start identity", async () => {
  const report = syntheticReport();
  const server = await listen((request, response) => {
    if (request.url === "/api/scan") return sendJson(response, 200, report);
    if (request.url === `/api/reports/${REPORT_ID}`) {
      return sendJson(
        response,
        200,
        syntheticReport({ startedAt: new Date(Date.now() + 30_000).toISOString() })
      );
    }
    sendJson(response, 404, { error: "not found" });
  });

  try {
    const result = await runSynthetic(server.origin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /readback changed its run start identity/);
  } finally {
    await server.close();
  }
});

test("production synthetic enforces both per-request and total deadlines", async () => {
  const hanging = await listen(() => undefined);
  try {
    const requestStart = Date.now();
    const requestResult = await runSynthetic(hanging.origin, {
      PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS: "100",
      PRODUCTION_SYNTHETIC_TOTAL_TIMEOUT_MS: "1000"
    });
    assert.equal(requestResult.status, 1);
    assert.match(requestResult.stderr, /exceeded its 100ms deadline/);
    assert.ok(Date.now() - requestStart < 1_500);
  } finally {
    await hanging.close();
  }

  const polling = await listen((request, response) => {
    if (request.url === "/api/scan") {
      return sendJson(response, 202, {
        ok: true,
        status: "queued",
        reportId: REPORT_ID,
        statusPath: `/api/scans/${REPORT_ID}`
      });
    }
    sendJson(response, 200, { ok: true, status: "running" });
  });
  try {
    const totalStart = Date.now();
    const totalResult = await runSynthetic(polling.origin, {
      // Keep the per-request budget above the total budget so this case
      // deterministically exercises the total deadline even on a loaded CI
      // host. The preceding hanging-server case owns per-request coverage.
      PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS: "1000",
      PRODUCTION_SYNTHETIC_TOTAL_TIMEOUT_MS: "500",
      PRODUCTION_SYNTHETIC_POLL_INTERVAL_MS: "10"
    });
    assert.equal(totalResult.status, 1);
    assert.match(totalResult.stderr, /exceeded its 500ms total deadline|did not finish within 0\.5s/);
    assert.ok(Date.now() - totalStart < 1_500);
  } finally {
    await polling.close();
  }
});

function syntheticReport(
  options: {
    reportId?: string;
    runId?: string;
    startedAt?: string;
    requestedOrigin?: string;
    observedOrigin?: string;
    gpc?: boolean;
  } = {}
): Record<string, unknown> {
  const reportId = options.reportId ?? REPORT_ID;
  return {
    schemaVersion: 2,
    schemaRevision: 2,
    reportType: "single",
    run: {
      runId: options.runId ?? RUN_ID,
      startedAt: options.startedAt ?? new Date().toISOString(),
      subject: {
        requested: {
          origin: options.requestedOrigin ?? "https://www.iana.org",
          registrableDomain: options.requestedOrigin ? "example.com" : "iana.org",
          routeShape: "/{seg}/{seg}"
        },
        observed: {
          origin: options.observedOrigin ?? "https://www.iana.org",
          registrableDomain: options.observedOrigin ? "example.com" : "iana.org",
          routeShape: "/{seg}/{seg}"
        }
      },
      conditions: {
        gpc: options.gpc ?? true,
        consent: "observe",
        device: { kind: "desktop", viewport: { isMobile: false } }
      },
      summary: { counts: { totalRequests: 1 } }
    },
    share: {
      id: reportId,
      jsonPath: `/api/reports/${reportId}`,
      path: `/reports/${reportId}`
    }
  };
}

function runSynthetic(
  baseUrl: string,
  overrides: Record<string, string> = {}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        SCAN_BASE_URL: baseUrl,
        PRODUCTION_SYNTHETIC_MONITOR_TOKEN: MONITOR_TOKEN,
        PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS: "1000",
        PRODUCTION_SYNTHETIC_TOTAL_TIMEOUT_MS: "3000",
        PRODUCTION_SYNTHETIC_POLL_INTERVAL_MS: "10",
        ...overrides
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => unknown | Promise<unknown>
): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind synthetic test server.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
