#!/usr/bin/env node

// Hourly end-to-end production synthetic for the v3 scanner path.
//
// Exercises the exact cross-origin flow from the public UI origin
// (`https://sitebehavior.org`) through the Cloudflare Worker edge gate to
// `POST /api/v3/scan` using the fixed harmless synthetic contract
// (`lib/production-synthetic.ts`), then verifies:
//   1. Cross-origin CORS preflight (`OPTIONS /api/v3/scan` -> 204)
//   2. Fresh v3 scan submission & unlisted persistence (`POST /api/v3/scan` -> 200)
//   3. Honest probe-coverage reporting on the fresh scan
//   4. Persisted JSON readback (`GET /api/v3/reports/<id>` -> 200)
//   5. Dynamic SSR report render (`GET /v3/reports/<id>` -> 200 HTML)
//   6. PDF export readback (`GET /api/v3/reports/<id>/pdf` -> 200 %PDF-)

import { REPORT_PDF_MAX_BYTES } from "../lib/report-pdf-limits.ts";
import { PRODUCTION_SYNTHETIC_TARGETS } from "../lib/production-synthetic.ts";
import {
  readResponseBytesWithinLimit,
  readResponseJsonWithinLimit,
  readResponseTextWithinLimit,
  withHttpOperationDeadline
} from "./http-response.mjs";

const configuredBaseUrl = (process.env.SCAN_BASE_URL || "").trim();
const token = (process.env.PRODUCTION_SYNTHETIC_MONITOR_TOKEN || "").trim();
const publicUiOrigin = (process.env.PRODUCTION_SYNTHETIC_UI_ORIGIN || "https://sitebehavior.org").trim();
const monitorHeader = "x-site-behavior-lab-synthetic-monitor-token";
const clockSkewMs = 60_000;
const jsonResponseMaxBytes = 16 * 1024 * 1024;
const htmlResponseMaxBytes = 4 * 1024 * 1024;
const scanTimeoutMs = boundedDuration(
  process.env.PRODUCTION_V3_SYNTHETIC_SCAN_TIMEOUT_MS,
  120_000,
  5_000,
  240_000,
  "PRODUCTION_V3_SYNTHETIC_SCAN_TIMEOUT_MS"
);
const readTimeoutMs = boundedDuration(
  process.env.PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS,
  15_000,
  100,
  30_000,
  "PRODUCTION_SYNTHETIC_REQUEST_TIMEOUT_MS"
);
const pdfTimeoutMs = boundedDuration(
  process.env.PRODUCTION_V3_SYNTHETIC_PDF_TIMEOUT_MS,
  45_000,
  1_000,
  90_000,
  "PRODUCTION_V3_SYNTHETIC_PDF_TIMEOUT_MS"
);

class TargetScanFailure extends Error {}

function fail(message) {
  console.error(`FAIL ${message}`);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Production v3 synthetic failed::${message.replace(/\r?\n/g, " ").slice(0, 800)}`);
  }
  process.exit(1);
}

function boundedDuration(raw, fallback, minimum, maximum, label) {
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function exactScannerOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("SCAN_BASE_URL must be an absolute scanner origin.");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) {
    fail("SCAN_BASE_URL must use https (or http on loopback for local tests).");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail("SCAN_BASE_URL must be a bare origin with no path, query, or fragment.");
  }
  return { origin: parsed.origin, loopback };
}

if (!configuredBaseUrl) fail("Set SCAN_BASE_URL to the deployed scanner origin.");
if (!/^[\x21-\x7e]{32,256}$/.test(token)) {
  fail("PRODUCTION_SYNTHETIC_MONITOR_TOKEN must be 32-256 printable ASCII characters.");
}

const { origin: baseUrl, loopback } = exactScannerOrigin(configuredBaseUrl);

async function verifyCrossOriginPreflight() {
  await withHttpOperationDeadline({ timeoutMs: readTimeoutMs, label: "OPTIONS /api/v3/scan" }, async (signal) => {
    const response = await fetch(`${baseUrl}/api/v3/scan`, {
      method: "OPTIONS",
      headers: {
        origin: publicUiOrigin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      },
      redirect: "manual",
      signal
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 204) {
      fail(`OPTIONS /api/v3/scan answered ${response.status}; expected 204.`);
    }
    if (!loopback) {
      const acao = response.headers.get("access-control-allow-origin") || "";
      if (acao !== publicUiOrigin) {
        fail(`OPTIONS /api/v3/scan returned Access-Control-Allow-Origin=${JSON.stringify(acao)}; expected ${publicUiOrigin}.`);
      }
    }
  });
}

function assertFreshV3ReportContract(report, submissionStartedAt, expectedReportId = null) {
  if (!report || typeof report !== "object" || report.schemaVersion !== 3) {
    fail("v3 synthetic response did not return a ScanReportV3 object.");
  }
  if (typeof report.reportId !== "string" || !/^\d{8}-[a-f0-9]{16,64}$/.test(report.reportId)) {
    fail("v3 synthetic report did not carry a valid reportId.");
  }
  if (expectedReportId && report.reportId !== expectedReportId) {
    fail(`v3 synthetic readback returned reportId ${report.reportId}; expected ${expectedReportId}.`);
  }
  const scannedAtMs = Date.parse(String(report.scannedAt || ""));
  if (!Number.isFinite(scannedAtMs) || scannedAtMs < submissionStartedAt - clockSkewMs || scannedAtMs > Date.now() + clockSkewMs) {
    fail("v3 synthetic report scannedAt is outside this monitor invocation window.");
  }
  const lead = report.leadArm;
  if (!lead || typeof lead !== "object") {
    fail("v3 synthetic report is missing leadArm.");
  }
  if (lead.loadOutcome !== "ok") {
    throw new TargetScanFailure(`target loadOutcome=${lead.loadOutcome} (httpStatus=${lead.httpStatus ?? "n/a"})`);
  }
  if (!lead.summary || typeof lead.summary.totalRequests !== "number" || lead.summary.totalRequests < 1) {
    fail("v3 synthetic report recorded zero network requests.");
  }
  // Probe coverage honesty invariant: a visit that exercised 0 input fields
  // must not mark the keystroke probe complete.
  if (lead.keystrokes?.fieldsTyped === 0 && lead.probes?.keystrokes?.status === "complete") {
    fail("v3 synthetic report marked probes.keystrokes as complete despite 0 fields typed.");
  }
  return report.reportId;
}

async function runV3SyntheticAttempt(targetUrl) {
  const submissionStartedAt = Date.now();
  // Exact fixed harmless synthetic contract from lib/production-synthetic.ts.
  const payload = {
    url: targetUrl,
    device: "desktop",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    compareConsent: false,
    consentMode: "observe"
  };

  const { status, acao, body } = await withHttpOperationDeadline(
    { timeoutMs: scanTimeoutMs, label: "POST /api/v3/scan" },
    async (signal) => {
      const response = await fetch(`${baseUrl}/api/v3/scan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: publicUiOrigin,
          [monitorHeader]: token
        },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal
      });
      const parsed = await readResponseJsonWithinLimit(response, {
        maxBytes: jsonResponseMaxBytes,
        label: "POST /api/v3/scan"
      });
      return {
        status: response.status,
        acao: response.headers.get("access-control-allow-origin") || "",
        body: parsed
      };
    }
  );

  if (status !== 200 || !body?.ok || !body?.report) {
    const errMsg = typeof body?.error === "string" ? body.error : `HTTP ${status}`;
    if (status === 502 || status === 504) {
      throw new TargetScanFailure(`POST /api/v3/scan answered ${status}: ${errMsg}`);
    }
    fail(`POST /api/v3/scan failed (${status}): ${errMsg}`);
  }
  if (!loopback && acao !== publicUiOrigin) {
    fail(`POST /api/v3/scan returned Access-Control-Allow-Origin=${JSON.stringify(acao)}; expected ${publicUiOrigin}.`);
  }

  const reportId = assertFreshV3ReportContract(body.report, submissionStartedAt);
  if (body.apiPath !== `/api/v3/reports/${reportId}` || body.sharePath !== `/v3/reports/${reportId}`) {
    fail("POST /api/v3/scan returned unexpected report paths.");
  }

  // Persisted JSON readback
  const readback = await withHttpOperationDeadline(
    { timeoutMs: readTimeoutMs, label: `GET /api/v3/reports/${reportId}` },
    async (signal) => {
      const response = await fetch(`${baseUrl}/api/v3/reports/${reportId}`, {
        cache: "no-store",
        redirect: "manual",
        signal
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        fail(`GET /api/v3/reports/${reportId} answered ${response.status}; expected 200.`);
      }
      return readResponseJsonWithinLimit(response, {
        maxBytes: jsonResponseMaxBytes,
        label: `GET /api/v3/reports/${reportId}`
      });
    }
  );
  assertFreshV3ReportContract(readback, submissionStartedAt, reportId);

  // SSR HTML report page render
  const html = await withHttpOperationDeadline(
    { timeoutMs: readTimeoutMs, label: `GET /v3/reports/${reportId}` },
    async (signal) => {
      const response = await fetch(`${baseUrl}/v3/reports/${reportId}`, {
        cache: "no-store",
        redirect: "manual",
        signal
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        fail(`GET /v3/reports/${reportId} answered ${response.status}; expected 200.`);
      }
      const ct = (response.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("text/html")) {
        await response.body?.cancel().catch(() => undefined);
        fail(`GET /v3/reports/${reportId} returned unexpected content-type ${ct}.`);
      }
      return readResponseTextWithinLimit(response, {
        maxBytes: htmlResponseMaxBytes,
        label: `GET /v3/reports/${reportId}`
      });
    }
  );
  if (!html.includes(reportId)) {
    fail(`GET /v3/reports/${reportId} HTML did not include the saved reportId.`);
  }

  // PDF export readback
  const pdfBytes = await withHttpOperationDeadline(
    { timeoutMs: pdfTimeoutMs, label: `GET /api/v3/reports/${reportId}/pdf` },
    async (signal) => {
      const response = await fetch(`${baseUrl}/api/v3/reports/${reportId}/pdf`, {
        headers: { accept: "application/pdf" },
        cache: "no-store",
        redirect: "manual",
        signal
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        fail(`GET /api/v3/reports/${reportId}/pdf answered ${response.status}; expected 200.`);
      }
      const ct = (response.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/pdf")) {
        await response.body?.cancel().catch(() => undefined);
        fail(`GET /api/v3/reports/${reportId}/pdf returned unexpected content-type ${ct}.`);
      }
      return readResponseBytesWithinLimit(response, {
        maxBytes: REPORT_PDF_MAX_BYTES,
        label: `GET /api/v3/reports/${reportId}/pdf`
      });
    }
  );
  if (
    pdfBytes.byteLength < 5 ||
    pdfBytes[0] !== 0x25 ||
    pdfBytes[1] !== 0x50 ||
    pdfBytes[2] !== 0x44 ||
    pdfBytes[3] !== 0x46 ||
    pdfBytes[4] !== 0x2d
  ) {
    fail(`GET /api/v3/reports/${reportId}/pdf did not start with %PDF- magic bytes.`);
  }

  return {
    reportId,
    totalRequests: readback.leadArm.summary.totalRequests,
    keystrokeProbeStatus: readback.leadArm.probes.keystrokes.status,
    keystrokeFieldsTyped: readback.leadArm.keystrokes.fieldsTyped,
    pdfBytes: pdfBytes.byteLength
  };
}

await verifyCrossOriginPreflight();

const failures = [];
let completed = null;
for (const targetUrl of PRODUCTION_SYNTHETIC_TARGETS) {
  try {
    completed = await runV3SyntheticAttempt(targetUrl);
    break;
  } catch (error) {
    if (!(error instanceof TargetScanFailure)) throw error;
    failures.push(`${targetUrl}: ${error.message}`);
    console.warn(`WARN v3 synthetic target ${targetUrl} failed (${error.message}); trying next candidate.`);
  }
}

if (!completed) {
  fail(`v3 production synthetic failed on every candidate target: ${failures.join("; ")}`);
}

console.log(
  `PASS production v3 synthetic completed, persisted, read back, rendered HTML, and exported PDF (${completed.totalRequests} requests; keystroke-probe=${completed.keystrokeProbeStatus}[${completed.keystrokeFieldsTyped} fields]; pdf=${completed.pdfBytes} B).`
);
