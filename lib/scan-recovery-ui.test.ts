import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ScanRequestError } from "./scan-client-orchestration";
import { buildV3ScanRequestPayload, submitV3RuntimeScan, type V3RuntimeScanForm } from "./v3/client-scan";
import type { ScanReportV3 } from "./v3/schema";

function loadCommittedV3Fixture(): ScanReportV3 {
  const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "public/v3/manifest.json"), "utf8")) as {
    reports: { reportId: string }[];
  };
  const firstId = manifest.reports[0]?.reportId;
  assert.ok(firstId, "expected at least one committed v3 seed report");
  return JSON.parse(readFileSync(path.join(process.cwd(), "public/v3/reports", `${firstId}.json`), "utf8")) as ScanReportV3;
}

function source(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

function baseForm(overrides: Partial<V3RuntimeScanForm> = {}): V3RuntimeScanForm {
  return {
    device: "desktop",
    region: "auto",
    gpcEnabled: true,
    compareGpc: false,
    compareShields: false,
    shieldsStrength: "standard",
    compareConsent: false,
    accessKey: "",
    ...overrides
  };
}

test("homepage v3 payload builder maps Single, GPC diff, Blocker, and Consent modes accurately", () => {
  const single = buildV3ScanRequestPayload({
    targetUrl: "https://example.com/",
    form: baseForm({ device: "mobile", region: "eu-central", gpcEnabled: true }),
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    turnstileRequired: false,
    turnstileToken: ""
  });
  assert.deepEqual(single, {
    url: "https://example.com/",
    device: "mobile",
    region: "eu-central",
    gpcEnabled: true,
    consentMode: "observe",
    comparisons: []
  });

  // GPC diff forces baseline gpcEnabled=false so the comparison arm isolates Sec-GPC: 1.
  const gpc = buildV3ScanRequestPayload({
    targetUrl: "https://example.com/",
    form: baseForm({ gpcEnabled: true, compareGpc: true }),
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    turnstileRequired: true,
    turnstileToken: "ts-tok"
  });
  assert.deepEqual(gpc, {
    url: "https://example.com/",
    device: "desktop",
    region: "auto",
    gpcEnabled: false,
    consentMode: "observe",
    comparisons: ["gpc"],
    turnstileToken: "ts-tok"
  });

  const shieldsAgg = buildV3ScanRequestPayload({
    targetUrl: "https://example.com/",
    form: baseForm({ compareShields: true, shieldsStrength: "aggressive" }),
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    turnstileRequired: false,
    turnstileToken: ""
  });
  assert.deepEqual(shieldsAgg.comparisons, ["shields-aggressive"]);

  const consent = buildV3ScanRequestPayload({
    targetUrl: "https://example.com/",
    form: baseForm({ compareConsent: true }),
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    turnstileRequired: false,
    turnstileToken: ""
  });
  assert.equal(consent.consentMode, "accept-all");
  assert.deepEqual(consent.comparisons, ["consent-reject"]);
});

test("submitV3RuntimeScan posts to /api/v3/scan, forwards headers, validates report, and surfaces declared causes", async () => {
  const report = loadCommittedV3Fixture();
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const result = await submitV3RuntimeScan({
    targetUrl: "https://example.com/",
    form: baseForm({ accessKey: "secret-key" }),
    gpcComparisonEnabled: true,
    shieldsComparisonEnabled: true,
    consentComparisonEnabled: true,
    scannerRequiresAccessKey: true,
    turnstileRequired: true,
    turnstileToken: "ts-token",
    resolveApiUrl: (p) => `https://scan.example.test${p}`,
    fetcher: async (url, init) => {
      capturedUrl = url;
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          ok: true,
          reportId: report.reportId,
          sharePath: `/v3/reports/${report.reportId}`,
          apiPath: `/api/v3/reports/${report.reportId}`,
          pdfPath: `/api/v3/reports/${report.reportId}/pdf`,
          report
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
  });
  assert.equal(capturedUrl, "https://scan.example.test/api/v3/scan");
  assert.equal(capturedHeaders["cf-turnstile-response"], "ts-token");
  assert.equal(capturedHeaders["x-site-behavior-lab-access-token"], "secret-key");
  assert.equal(result.reportId, report.reportId);
  assert.equal(result.sharePath, `/v3/reports/${report.reportId}`);

  // Server failure with declared cause + retryAfterSeconds surfaces as ScanRequestError.
  await assert.rejects(
    () =>
      submitV3RuntimeScan({
        targetUrl: "http://127.0.0.1/",
        form: baseForm(),
        gpcComparisonEnabled: true,
        shieldsComparisonEnabled: true,
        consentComparisonEnabled: true,
        scannerRequiresAccessKey: false,
        turnstileRequired: false,
        turnstileToken: "",
        resolveApiUrl: (p) => p,
        fetcher: async () =>
          new Response(
            JSON.stringify({
              ok: false,
              error: "Local and private network targets are blocked.",
              cause: "private-target"
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          )
      }),
    (err: unknown) => err instanceof ScanRequestError && err.failureCause === "private-target"
  );
});

test("homepage scan UI exposes polite cancellation and dismissible recovery banner", () => {
  const hook = source("app/_hooks/use-scan-runtime.ts");
  const banner = source("app/_components/scan-recovery-banner.tsx");
  const app = source("app/site-behavior-app.tsx");

  assert.match(hook, /function cancelActiveScan\(\): void[\s\S]*operationOwnerRef\.current\.cancelCurrent\(\)[\s\S]*setScanNotice\("Scan cancelled\."\)/);
  assert.match(hook, /function dismissBanner\(\): void/);
  assert.match(banner, /Dismiss/);
  assert.match(app, /onDismiss=\{dismissBanner\}/);
  assert.match(app, /onCancel=\{scanning \? cancelActiveScan : undefined\}/);
});
